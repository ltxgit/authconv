import { compactObject } from "./object.js";
import { OPENAI_ISSUER } from "./openai.js";
import type {
  Codex2ApiRenderedAccount,
  CodexManagerRenderedAccount,
  CodexRenderedAuth,
  CpaRenderedAccount,
  CpaXaiRenderedAccount,
  GrokRenderedAuth,
  OpenAINormalizedAccount,
  RenderOptions,
  Sub2ApiRenderedAccount,
  Sub2ApiRenderedCredentials,
  Sub2ApiRenderedExtra,
  XaiNormalizedAccount,
} from "./types.js";
import {
  GROK_CLI_CLIENT_ID,
  XAI_ISSUER,
} from "./xai.js";

export function renderCpaAccount(
  account: OpenAINormalizedAccount | XaiNormalizedAccount,
  options: RenderOptions = {},
): CpaRenderedAccount | CpaXaiRenderedAccount {
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

function renderCpaXaiAccount(account: XaiNormalizedAccount, options: RenderOptions): CpaXaiRenderedAccount {
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

export function renderCodex2ApiAccount(account: OpenAINormalizedAccount, options: RenderOptions = {}): Codex2ApiRenderedAccount {
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

export function renderSub2ApiAccount(
  account: OpenAINormalizedAccount | XaiNormalizedAccount,
  options: RenderOptions = {},
): Sub2ApiRenderedAccount {
  const allowSynthetic = options.allowSyntheticIdToken !== false;
  const isOpenAI = account.provider === "openai";
  const credentials = compactObject({
    access_token: account.accessToken,
    refresh_token: shouldIncludeRefreshToken(options) ? account.refreshToken : undefined,
    session_token: isOpenAI ? account.sessionToken : undefined,
    id_token: allowSynthetic ? account.idToken : (isOpenAI && account.idTokenSynthetic ? undefined : account.idToken),
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
    id_token_synthetic: isOpenAI && account.idTokenSynthetic && allowSynthetic ? true : undefined,
  }) as Sub2ApiRenderedExtra;
  return compactObject({
    name: account.name ?? account.email ?? (isOpenAI ? account.chatgptAccountId ?? account.accountId : account.userId) ?? "authconv-account",
    platform: account.provider === "xai" ? "grok" : "openai",
    type: "oauth",
    credentials,
    extra,
    priority: 50,
    concurrency: 3,
    auto_pause_on_expired: true,
  }) as Sub2ApiRenderedAccount;
}

export function renderGrokEntry(
  account: XaiNormalizedAccount,
  options: RenderOptions = {},
): [string, GrokRenderedAuth[string]] {
  const clientId = account.clientId ?? GROK_CLI_CLIENT_ID;
  return [`${XAI_ISSUER}::${clientId}`, renderXaiAuthEntry(account, clientId, options)];
}

export function renderGrok2ApiEntry(
  account: XaiNormalizedAccount,
  options: RenderOptions = {},
): [string, GrokRenderedAuth[string]] {
  const clientId = account.clientId ?? GROK_CLI_CLIENT_ID;
  const accountId = grok2ApiAccountId(account);
  return [
    `${XAI_ISSUER}::${accountId}`,
    renderXaiAuthEntry(account, clientId, options, accountId),
  ];
}

export function grok2ApiStorageKey(account: XaiNormalizedAccount): string {
  return `${XAI_ISSUER}::${grok2ApiAccountId(account)}`;
}

function renderXaiAuthEntry(
  account: XaiNormalizedAccount,
  clientId: string,
  options: RenderOptions,
  anonymousAccountId?: string,
): GrokRenderedAuth[string] {
  const userId = account.userId ?? account.principalId ?? anonymousAccountId ?? "";
  return compactObject({
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
  }) as GrokRenderedAuth[string];
}

function grok2ApiAccountId(account: XaiNormalizedAccount): string {
  return account.userId ?? account.principalId ?? `authconv-${credentialFingerprint(account)}`;
}

function credentialFingerprint(account: XaiNormalizedAccount): string {
  const source = [
    ["access_token", account.accessToken],
    ["refresh_token", account.refreshToken],
    ["session_token", account.sessionToken],
    ["id_token", account.idToken],
  ].map(([field, value]) => `${field}\0${value ?? ""}`).join("\0");
  let hash = 0xcbf29ce484222325n;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= BigInt(source.charCodeAt(index));
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash.toString(16).padStart(16, "0");
}

export function renderCodexManagerAccount(account: OpenAINormalizedAccount, options: RenderOptions = {}): CodexManagerRenderedAccount {
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
      issuer: account.issuer ?? OPENAI_ISSUER,
      workspace_id: account.workspaceId,
      chatgpt_account_id: account.chatgptAccountId,
      tags: ["authconv"],
    }) as CodexManagerRenderedAccount["meta"],
  };
}

export function renderCodexAuth(account: OpenAINormalizedAccount, options: RenderOptions = {}): CodexRenderedAuth {
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
