import { compactObject } from "./object.js";
import type {
  Codex2ApiRenderedAccount,
  CodexManagerRenderedAccount,
  CodexRenderedAuth,
  CpaRenderedAccount,
  CpaXaiRenderedAccount,
  GrokRenderedAuth,
  NormalizedAccount,
  OutputFormat,
  RenderOptions,
  RenderOutputByFormat,
  Sub2ApiRenderedAccount,
  Sub2ApiRenderedCredentials,
  Sub2ApiRenderedData,
  Sub2ApiRenderedExtra,
} from "./types.js";
import {
  GROK_CLI_CLIENT_ID,
  XAI_ISSUER,
} from "./xai.js";

export function renderFormat<T extends OutputFormat>(
  accounts: NormalizedAccount[],
  format: T,
  options: RenderOptions = {},
): RenderOutputByFormat[T] {
  switch (format) {
    case "cpa":
      return (accounts.length === 1
        ? renderCpaAccount(accounts[0], options)
        : accounts.map((account) => renderCpaAccount(account, options))) as RenderOutputByFormat[T];
    case "codex2api":
      return accounts.map((account) => renderCodex2ApiAccount(account, options)) as RenderOutputByFormat[T];
    case "sub2api":
      return renderSub2Api(accounts, options) as RenderOutputByFormat[T];
    case "codexmanager":
      return (accounts.length === 1
        ? renderCodexManagerAccount(accounts[0], options)
        : accounts.map((account) => renderCodexManagerAccount(account, options))) as RenderOutputByFormat[T];
    case "codex":
      return (accounts.length === 1
        ? renderCodexAuth(accounts[0], options)
        : accounts.map((account) => renderCodexAuth(account, options))) as RenderOutputByFormat[T];
    case "grok":
      return renderGrokAuth(accounts, options) as RenderOutputByFormat[T];
  }
}

function renderCpaAccount(account: NormalizedAccount, options: RenderOptions): CpaRenderedAccount | CpaXaiRenderedAccount {
  if (account.provider === "xai") {
    return renderCpaXaiAccount(account, options);
  }
  const allowSynthetic = options.allowSyntheticIdToken !== false;
  const rendered: CpaRenderedAccount = {
    type: "codex",
    email: account.email ?? "",
    account_id: account.accountId ?? "",
    plan_type: account.planType ?? "",
    id_token: allowSynthetic ? (account.idToken ?? "") : (account.idTokenSynthetic ? "" : (account.idToken ?? "")),
    access_token: account.accessToken ?? "",
    ...(shouldIncludeRefreshToken(options) ? { refresh_token: account.refreshToken ?? "" } : {}),
    expired: account.expiresAt ?? "",
    last_refresh: account.lastRefresh ?? (options.now ?? new Date()).toISOString(),
    disabled: false,
  };
  if (account.sessionToken) {
    rendered.session_token = account.sessionToken;
  }
  if (account.idTokenSynthetic && allowSynthetic) {
    rendered.id_token_synthetic = true;
  }
  return rendered;
}

function renderCpaXaiAccount(account: NormalizedAccount, options: RenderOptions): CpaXaiRenderedAccount {
  const rendered = compactObject({
    type: "xai",
    access_token: account.accessToken,
    refresh_token: shouldIncludeRefreshToken(options) ? account.refreshToken : undefined,
    id_token: account.idToken,
    token_type: account.tokenType,
    expires_in: account.expiresIn,
    expired: account.expiresAt,
    last_refresh: account.lastRefresh ?? account.issuedAt,
    email: account.email,
    sub: account.userId ?? account.principalId,
    base_url: account.baseUrl,
    token_endpoint: account.tokenEndpoint,
    redirect_uri: account.redirectUri,
    disabled: account.disabled,
    headers: account.headers,
  });
  return rendered as CpaXaiRenderedAccount;
}

function renderCodex2ApiAccount(account: NormalizedAccount, options: RenderOptions): Codex2ApiRenderedAccount {
  const allowSynthetic = options.allowSyntheticIdToken !== false;
  return compactObject({
    name: account.name ?? account.email ?? account.chatgptAccountId ?? account.accountId,
    email: account.email,
    refresh_token: shouldIncludeRefreshToken(options) ? account.refreshToken : undefined,
    session_token: account.sessionToken,
    access_token: account.accessToken,
    id_token: allowSynthetic ? account.idToken : (account.idTokenSynthetic ? undefined : account.idToken),
    account_id: account.accountId,
    chatgpt_account_id: account.chatgptAccountId,
    plan_type: account.planType,
    expires_at: account.expiresAt,
  }) as Codex2ApiRenderedAccount;
}

function renderSub2Api(accounts: NormalizedAccount[], options: RenderOptions): Sub2ApiRenderedData {
  return {
    type: "sub2api-data",
    version: 1,
    exported_at: (options.now ?? new Date()).toISOString(),
    proxies: [],
    accounts: accounts.map((account) => renderSub2ApiAccount(account, options)),
  };
}

function renderSub2ApiAccount(account: NormalizedAccount, options: RenderOptions): Sub2ApiRenderedAccount {
  const allowSynthetic = options.allowSyntheticIdToken !== false;
  const isOpenAI = account.provider === "openai";
  const credentials = compactObject({
    access_token: account.accessToken,
    refresh_token: shouldIncludeRefreshToken(options) ? account.refreshToken : undefined,
    session_token: isOpenAI ? account.sessionToken : undefined,
    id_token: allowSynthetic ? account.idToken : (account.idTokenSynthetic ? undefined : account.idToken),
    expires_at: account.expiresAt,
    email: account.email,
    chatgpt_account_id: isOpenAI ? account.chatgptAccountId : undefined,
    chatgpt_user_id: isOpenAI ? account.chatgptUserId : undefined,
    plan_type: isOpenAI ? account.planType : undefined,
    user_id: account.provider === "xai" ? account.userId : undefined,
    client_id: account.provider === "xai" ? account.clientId : undefined,
    base_url: account.provider === "xai" ? account.baseUrl : undefined,
  }) as Sub2ApiRenderedCredentials;
  const extra = compactObject({
    import_source: "authconv",
    id_token_synthetic: account.idTokenSynthetic && allowSynthetic ? true : undefined,
  }) as Sub2ApiRenderedExtra;
  return compactObject({
    name: account.name ?? account.email ?? account.chatgptAccountId ?? account.accountId ?? "authconv-account",
    platform: account.provider === "xai" ? "grok" : "openai",
    type: "oauth",
    credentials,
    extra,
    priority: 50,
    concurrency: 3,
    auto_pause_on_expired: true,
  }) as Sub2ApiRenderedAccount;
}

function renderGrokAuth(accounts: NormalizedAccount[], options: RenderOptions): GrokRenderedAuth {
  return Object.fromEntries(accounts.map((account) => {
    const clientId = account.clientId ?? GROK_CLI_CLIENT_ID;
    const userId = account.userId ?? account.principalId ?? "";
    const key = accounts.length === 1
      ? `${XAI_ISSUER}::${clientId}`
      : `${XAI_ISSUER}::${clientId}::${userId}`;
    return [key, compactObject({
      key: account.accessToken ?? "",
      auth_mode: "oidc",
      create_time: account.createTime ?? account.issuedAt,
      user_id: userId,
      email: account.email ?? "",
      principal_type: account.principalType ?? "User",
      principal_id: account.principalId ?? userId,
      refresh_token: shouldIncludeRefreshToken(options) ? (account.refreshToken ?? "") : undefined,
      expires_at: account.expiresAt,
      oidc_issuer: XAI_ISSUER,
      oidc_client_id: clientId,
    })];
  })) as GrokRenderedAuth;
}

function renderCodexManagerAccount(account: NormalizedAccount, options: RenderOptions): CodexManagerRenderedAccount {
  const allowSynthetic = options.allowSyntheticIdToken !== false;
  return {
    tokens: compactObject({
      access_token: account.accessToken,
      refresh_token: shouldIncludeRefreshToken(options) ? account.refreshToken : undefined,
      id_token: allowSynthetic ? account.idToken : (account.idTokenSynthetic ? undefined : account.idToken),
      account_id: account.accountId,
      chatgpt_account_id: account.chatgptAccountId,
    }),
    meta: compactObject({
      label: account.name ?? account.email ?? account.chatgptAccountId ?? account.accountId,
      issuer: account.issuer ?? "https://auth.openai.com",
      workspace_id: account.workspaceId,
      chatgpt_account_id: account.chatgptAccountId,
      tags: ["authconv"],
    }) as CodexManagerRenderedAccount["meta"],
  };
}

function renderCodexAuth(account: NormalizedAccount, options: RenderOptions): CodexRenderedAuth {
  const allowSynthetic = options.allowSyntheticIdToken !== false;
  return {
    auth_mode: "chatgpt",
    OPENAI_API_KEY: null,
    tokens: {
      id_token: allowSynthetic ? (account.idToken ?? "") : (account.idTokenSynthetic ? "" : (account.idToken ?? "")),
      access_token: account.accessToken ?? "",
      ...(shouldIncludeRefreshToken(options) ? { refresh_token: account.refreshToken ?? "" } : {}),
      account_id: account.accountId ?? account.chatgptAccountId ?? "",
    },
    last_refresh: account.lastRefresh ?? (options.now ?? new Date()).toISOString(),
  };
}

function shouldIncludeRefreshToken(options: RenderOptions): boolean {
  return options.includeRefreshToken !== false;
}
