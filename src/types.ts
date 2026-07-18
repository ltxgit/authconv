export type OutputFormat = "cpa" | "sub2api" | "codex2api" | "codexmanager" | "codex" | "grok" | "grok2api";

export type OutputMode = "merged" | "single";

export type OutputModes = Partial<Record<OutputFormat, OutputMode>>;

export type OutputTextMode = "json" | "jsonl";

export type InputFormat = "session" | "sub2api" | "cpa" | "grok" | "codexmanager" | "codex2api" | "codex" | "unknown";

export type Provider = "openai" | "xai" | "unknown";

export type Locale = "zh" | "en";

export type TokenVerificationStatus = "verified" | "forged" | "unverifiable" | "unchecked";

export type TokenVerificationReason =
  | "signature_valid"
  | "malformed_jwt"
  | "algorithm_rejected"
  | "signature_failed"
  | "issuer_mismatch"
  | "audience_mismatch"
  | "token_type_mismatch"
  | "missing_access_token"
  | "opaque_access_token"
  | "unknown_kid"
  | "unknown_provider"
  | "user_disabled"
  | "verification_missing";

export type TokenVerification = {
  status: TokenVerificationStatus;
  reason: TokenVerificationReason;
  tokenField: "accessToken";
  algorithm?: "RS256" | "ES256";
  kid?: string;
  notBeforeActive?: true;
};

export type TokenVerificationContext = {
  provider: Provider;
  issuer?: string;
  algorithm?: "RS256" | "ES256";
  expectedAudience?: string;
};

export type NormalizedAccountCommon = {
  accessToken?: string;
  refreshToken?: string;
  idToken?: string;
  sessionToken?: string;
  userId?: string;
  issuer?: string;
  audience?: string[];
  clientId?: string;
  scopes?: string[];
  notBefore?: string;
  email?: string;
  name?: string;
  lastRefresh?: string;
  expiresAt?: string;
  issuedAt?: string;
  sourceName: string;
  sourcePath: string;
  inputFormat: InputFormat;
  tokenVerification?: TokenVerification;
  tokenVerificationContext?: TokenVerificationContext;
};

export type OpenAINormalizedAccount = NormalizedAccountCommon & {
  provider: "openai";
  idTokenSynthetic?: boolean;
  accountId?: string;
  chatgptAccountId?: string;
  chatgptUserId?: string;
  chatgptAccountUserId?: string;
  workspaceId?: string;
  planType?: string;
};

export type XaiNormalizedAccount = NormalizedAccountCommon & {
  provider: "xai";
  tokenType?: string;
  expiresIn?: number;
  principalId?: string;
  principalType?: string;
  createTime?: string;
  baseUrl?: string;
  tokenEndpoint?: string;
  redirectUri?: string;
  headers?: Record<string, string>;
  disabled?: boolean;
};

export type UnknownNormalizedAccount = NormalizedAccountCommon & {
  provider: "unknown";
};

export type NormalizedAccount = OpenAINormalizedAccount | XaiNormalizedAccount | UnknownNormalizedAccount;

export type DiagnosticCode =
  | "json_parse_failed"
  | "zip_read_failed"
  | "input_format_mismatch"
  | "no_credential_tokens"
  | "unsupported_input";

export type IngestionDiagnostic = {
  code: DiagnosticCode;
  sourceName: string;
  sourcePath: string;
  line?: number;
  detail?: string;
};

export type InputSource = {
  name: string;
  path: string;
  chunks: AsyncIterable<Uint8Array>;
  cancel?: (reason?: unknown) => void | Promise<void>;
};

export type NormalizeSource = {
  sourceName: string;
  sourcePath: string;
};

export type RenderOptions = {
  now?: Date;
  allowSyntheticIdToken?: boolean;
  includeRefreshToken?: boolean;
};


export type CpaRenderedAccount = {
  type: "codex";
  email: string;
  account_id: string;
  plan_type: string;
  id_token: string;
  access_token: string;
  refresh_token?: string;
  expired: string;
  last_refresh: string;
  disabled: false;
  session_token?: string;
  id_token_synthetic?: true;
};

export type CpaXaiRenderedAccount = {
  type: "xai";
  access_token?: string;
  refresh_token?: string;
  id_token?: string;
  token_type?: string;
  expires_in?: number;
  expired?: string;
  last_refresh?: string;
  email?: string;
  sub?: string;
  base_url?: string;
  token_endpoint?: string;
  redirect_uri?: string;
  disabled?: boolean;
  headers?: Record<string, string>;
};

export type Codex2ApiRenderedAccount = {
  name?: string;
  email?: string;
  refresh_token?: string;
  session_token?: string;
  access_token?: string;
  id_token?: string;
  account_id?: string;
  chatgpt_account_id?: string;
  plan_type?: string;
  expires_at?: string;
};

export type Sub2ApiRenderedCredentials = {
  access_token?: string;
  refresh_token?: string;
  session_token?: string;
  id_token?: string;
  expires_at?: string;
  email?: string;
  chatgpt_account_id?: string;
  chatgpt_user_id?: string;
  plan_type?: string;
  user_id?: string;
  client_id?: string;
  base_url?: string;
};

export type Sub2ApiRenderedExtra = {
  import_source: "authconv";
  id_token_synthetic?: true;
};

export type Sub2ApiRenderedAccount = {
  name: string;
  platform: "openai" | "grok";
  type: "oauth";
  credentials: Sub2ApiRenderedCredentials;
  extra: Sub2ApiRenderedExtra;
  priority: 50;
  concurrency: 3;
  auto_pause_on_expired: true;
};

export type Sub2ApiRenderedData = {
  type: "sub2api-data";
  version: 1;
  exported_at: string;
  proxies: [];
  accounts: Sub2ApiRenderedAccount[];
};

export type CodexManagerRenderedAccount = {
  tokens: {
    access_token?: string;
    refresh_token?: string;
    id_token?: string;
    account_id?: string;
    chatgpt_account_id?: string;
  };
  meta: {
    label?: string;
    issuer: string;
    workspace_id?: string;
    chatgpt_account_id?: string;
    tags: ["authconv"];
  };
};

export type CodexRenderedAuth = {
  auth_mode: "chatgpt";
  OPENAI_API_KEY: null;
  tokens: {
    id_token: string;
    access_token: string;
    refresh_token?: string;
    account_id: string;
  };
  last_refresh: string;
};

export type GrokRenderedAuth = Record<string, {
  key: string;
  auth_mode: "oidc";
  create_time?: string;
  user_id: string;
  email: string;
  principal_type: string;
  principal_id: string;
  refresh_token?: string;
  expires_at?: string;
  oidc_issuer: "https://auth.x.ai";
  oidc_client_id: string;
}>;
