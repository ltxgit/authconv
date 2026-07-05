import { compactObject } from "./object.js";
import type {
  Codex2ApiRenderedAccount,
  CodexManagerRenderedAccount,
  CodexRenderedAuth,
  CpaRenderedAccount,
  NormalizedAccount,
  OutputFormat,
  RenderOptions,
  RenderOutputByFormat,
  Sub2ApiRenderedAccount,
  Sub2ApiRenderedCredentials,
  Sub2ApiRenderedData,
  Sub2ApiRenderedExtra,
} from "./types.js";

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
  }
}

function renderCpaAccount(account: NormalizedAccount, options: RenderOptions): CpaRenderedAccount {
  const allowSynthetic = options.allowSyntheticIdToken !== false;
  const rendered: CpaRenderedAccount = {
    type: "codex",
    email: account.email ?? "",
    account_id: account.accountId ?? "",
    plan_type: account.planType ?? "",
    id_token: allowSynthetic ? (account.idToken ?? "") : (account.idTokenSynthetic ? "" : (account.idToken ?? "")),
    access_token: account.accessToken ?? "",
    refresh_token: account.refreshToken ?? "",
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

function renderCodex2ApiAccount(account: NormalizedAccount, options: RenderOptions): Codex2ApiRenderedAccount {
  const allowSynthetic = options.allowSyntheticIdToken !== false;
  return compactObject({
    name: account.name ?? account.email ?? account.chatgptAccountId ?? account.accountId,
    email: account.email,
    refresh_token: account.refreshToken,
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
  const credentials = compactObject({
    access_token: account.accessToken,
    refresh_token: account.refreshToken,
    session_token: account.sessionToken,
    id_token: allowSynthetic ? account.idToken : (account.idTokenSynthetic ? undefined : account.idToken),
    expires_at: account.expiresAt,
    email: account.email,
    chatgpt_account_id: account.chatgptAccountId,
    chatgpt_user_id: account.chatgptUserId,
    plan_type: account.planType,
  }) as Sub2ApiRenderedCredentials;
  const extra = compactObject({
    import_source: "authconv",
    id_token_synthetic: account.idTokenSynthetic && allowSynthetic ? true : undefined,
  }) as Sub2ApiRenderedExtra;
  return compactObject({
    name: account.name ?? account.email ?? account.chatgptAccountId ?? account.accountId ?? "authconv-account",
    platform: "openai",
    type: "oauth",
    credentials,
    extra,
    priority: 50,
    concurrency: 3,
    auto_pause_on_expired: true,
  }) as Sub2ApiRenderedAccount;
}

function renderCodexManagerAccount(account: NormalizedAccount, options: RenderOptions): CodexManagerRenderedAccount {
  const allowSynthetic = options.allowSyntheticIdToken !== false;
  return {
    tokens: compactObject({
      access_token: account.accessToken,
      refresh_token: account.refreshToken,
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
      refresh_token: account.refreshToken ?? "",
      account_id: account.accountId ?? account.chatgptAccountId ?? "",
    },
    last_refresh: account.lastRefresh ?? (options.now ?? new Date()).toISOString(),
  };
}
