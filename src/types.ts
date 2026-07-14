export const ALL_FORMATS = ["cpa", "sub2api", "codex2api", "codexmanager", "codex", "grok"] as const;

export type OutputFormat = (typeof ALL_FORMATS)[number];

export type OutputMode = "merged" | "single";

export type OutputModes = Partial<Record<OutputFormat, OutputMode>>;

export type OutputTextMode = "json" | "jsonl";

export type InputFormat = "session" | "sub2api" | "cpa" | "grok" | "codexmanager" | "codex2api" | "codex" | "unknown";

export type Provider = "openai" | "xai" | "unknown";

export type Locale = "zh" | "en";

export type NormalizedAccount = {
  provider: Provider;
  accessToken?: string;
  refreshToken?: string;
  idToken?: string;
  idTokenSynthetic?: boolean;
  sessionToken?: string;
  accountId?: string;
  chatgptAccountId?: string;
  chatgptUserId?: string;
  chatgptAccountUserId?: string;
  workspaceId?: string;
  userId?: string;
  issuer?: string;
  audience?: string[];
  clientId?: string;
  scopes?: string[];
  notBefore?: string;
  email?: string;
  name?: string;
  planType?: string;
  lastRefresh?: string;
  expiresAt?: string;
  issuedAt?: string;
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
  sourceName: string;
  sourcePath: string;
  warnings: string[];
  inputFormat?: InputFormat;
};

export type NormalizeSource = {
  sourceName: string;
  sourcePath: string;
};

export type NormalizeOptions = {
  inputFormat?: InputFormat;
  locale?: Locale;
};

export type NormalizeResult = {
  accounts: NormalizedAccount[];
  warnings: string[];
  rejections: string[];
  inputFormat: InputFormat;
};

export type OutputFile = {
  path: string;
  format: OutputFormat;
  content: unknown;
  accountCount: number;
};

export type SerializedOutputFile = {
  path: string;
  format: OutputFormat;
  text: string;
  accountCount: number;
};

export type RenderOptions = {
  now?: Date;
  allowSyntheticIdToken?: boolean;
  includeRefreshToken?: boolean;
};

export type BuildOutputPlanOptions = RenderOptions & {
  outputModes?: OutputModes;
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

export type RenderOutputByFormat = {
  cpa: CpaRenderedAccount | CpaXaiRenderedAccount | Array<CpaRenderedAccount | CpaXaiRenderedAccount>;
  codex2api: Codex2ApiRenderedAccount[];
  sub2api: Sub2ApiRenderedData;
  codexmanager: CodexManagerRenderedAccount | CodexManagerRenderedAccount[];
  codex: CodexRenderedAuth | CodexRenderedAuth[];
  grok: GrokRenderedAuth;
};

export type RenderedOutput = RenderOutputByFormat[OutputFormat];
