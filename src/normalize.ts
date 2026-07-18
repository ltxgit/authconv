import {
  applySyntheticIdTokenSignature,
  claimNumber,
  claimString,
  claimStringArray,
  createSyntheticIdToken,
  decodeJwtPayload,
  openAIAuthClaims,
  openAIProfileClaims,
} from "./jwt.js";
import { firstRecord, firstString, isRecord } from "./object.js";
import { OPENAI_ISSUER } from "./openai.js";
import type {
  InputFormat,
  NormalizedAccount,
  NormalizeSource,
  OpenAINormalizedAccount,
  UnknownNormalizedAccount,
  XaiNormalizedAccount,
} from "./types.js";
import { XAI_ISSUER, XAI_TOKEN_ENDPOINT } from "./xai.js";

export type Candidate = {
  records: Record<string, unknown>[];
  sourceName: string;
  sourcePath: string;
  inputFormat: InputFormat;
};

function detectArrayItemFormat(input: Record<string, unknown>): InputFormat {
  const format = detectRecordInputFormat(input);
  if (format !== "unknown") {
    return format;
  }
  if (isCodex2ApiAutoRecord(input)) {
    return "codex2api";
  }
  return "unknown";
}

function detectRecordInputFormat(input: Record<string, unknown>): InputFormat {
  // CPA owns its explicit type contract even when it carries xAI endpoint metadata.
  if (isCpaRecord(input)) {
    return "cpa";
  }

  if (isXaiFlatRecord(input)) {
    return "grok";
  }

  // ChatGPT Session JSON
  if (typeof input.accessToken === "string" && (isRecord(input.user) || isRecord(input.account) || typeof input.sessionToken === "string")) {
    return "session";
  }

  // sub2api
  if (Array.isArray(input.accounts)) {
    const hasSub2ApiAccount = input.accounts.some((item) => {
      return isRecord(item) && (isRecord(item.credentials) || typeof item.platform === "string");
    });
    if (hasSub2ApiAccount) {
      return "sub2api";
    }
  }
  if (isRecord(input.credentials)) {
    return "sub2api";
  }

  if (isGrokAuthRecord(input)) {
    return "grok";
  }

  if (hasXaiJwt(input)) {
    return "grok";
  }

  // Codex auth.json
  if (isCodexAuthRecord(input)) {
    return "codex";
  }

  // Codex-Manager
  if (isRecord(input.tokens) && isRecord(input.meta)) {
    return "codexmanager";
  }

  // Codex2Api single object
  if (isCodex2ApiAutoRecord(input)) {
    return "codex2api";
  }

  return "unknown";
}

function isCodex2ApiAutoRecord(input: Record<string, unknown>): boolean {
  return (
    isCodex2ApiRecord(input) &&
    input.type === undefined &&
    (
      typeof input.refresh_token === "string" ||
      typeof input.session_token === "string" ||
      typeof input.id_token === "string"
    )
  );
}

export function extractCandidatesFromValue(
  input: unknown,
  source: NormalizeSource,
  selectedFormat: InputFormat | undefined,
): Candidate[] {
  if (selectedFormat) {
    return extractCandidatesForFormat(input, source, selectedFormat);
  }

  return extractAutoCandidates(input, source);
}

function extractAutoCandidates(input: unknown, source: NormalizeSource): Candidate[] {
  if (Array.isArray(input)) {
    return input.flatMap((item, index) => {
      return isRecord(item) ? extractAutoCandidatesFromRecord(item, source, index) : [];
    });
  }

  if (!isRecord(input)) {
    return [];
  }

  return extractAutoCandidatesFromRecord(input, source, 0);
}

function extractAutoCandidatesFromRecord(record: Record<string, unknown>, source: NormalizeSource, index: number): Candidate[] {
  const inputFormat = detectArrayItemFormat(record);
  if (inputFormat === "sub2api" && Array.isArray(record.accounts)) {
    return record.accounts
      .filter(isRecord)
      .map((item, accountIndex) => candidateFromRecord(item, source, accountIndex, "sub2api"));
  }

  if (inputFormat === "grok") {
    return grokRecords(record).map((item, accountIndex) => candidateFromRecord(item, source, accountIndex, "grok"));
  }

  return [candidateFromRecord(record, source, index, inputFormat)];
}

function extractCandidatesForFormat(input: unknown, source: NormalizeSource, inputFormat: InputFormat): Candidate[] {
  const records = candidateRecordsForFormat(input, inputFormat);
  return records.map((record, index) => candidateFromRecord(record, source, index, inputFormat));
}

function candidateRecordsForFormat(input: unknown, inputFormat: InputFormat): Record<string, unknown>[] {
  switch (inputFormat) {
    case "session":
      return isRecord(input) && isSessionRecord(input) ? [input] : [];
    case "sub2api":
      return sub2ApiRecords(input);
    case "cpa":
      return recordList(input).filter(isCpaRecord);
    case "grok":
      return grokRecords(input);
    case "codexmanager":
      return recordList(input).filter(isCodexManagerRecord);
    case "codex2api":
      return recordList(input).filter(isCodex2ApiRecord);
    case "codex":
      return recordList(input).filter(isCodexAuthRecord);
    case "unknown":
      return [];
  }
}

function sub2ApiRecords(input: unknown): Record<string, unknown>[] {
  if (Array.isArray(input)) {
    return input.filter(isRecord).filter(isSub2ApiAccountRecord);
  }
  if (!isRecord(input)) {
    return [];
  }
  if (Array.isArray(input.accounts)) {
    return input.accounts.filter(isRecord).filter(isSub2ApiAccountRecord);
  }
  return isSub2ApiAccountRecord(input) ? [input] : [];
}

function recordList(input: unknown): Record<string, unknown>[] {
  if (Array.isArray(input)) {
    return input.filter(isRecord);
  }
  return isRecord(input) ? [input] : [];
}

function isSessionRecord(record: Record<string, unknown>): boolean {
  return (
    typeof record.accessToken === "string" &&
    (isRecord(record.user) || isRecord(record.account) || typeof record.sessionToken === "string")
  );
}

function isSub2ApiAccountRecord(record: Record<string, unknown>): boolean {
  return isRecord(record.credentials) || typeof record.platform === "string";
}

function isCpaRecord(record: Record<string, unknown>): boolean {
  return (
    (record.type === "codex" || record.type === "xai") &&
    Boolean(firstString([record], ["access_token", "refresh_token", "session_token", "id_token"]))
  );
}

function isGrokAuthRecord(record: Record<string, unknown>): boolean {
  const entries = Object.entries(record);
  return entries.length > 0 && entries.every(([key, value]) => (
    key.startsWith(`${XAI_ISSUER}::`) && isRecord(value) &&
    (typeof value.key === "string" || typeof value.refresh_token === "string")
  ));
}

function grokRecords(input: unknown): Record<string, unknown>[] {
  if (!isRecord(input)) {
    return [];
  }
  if (!isGrokAuthRecord(input)) {
    return isXaiFlatRecord(input) || hasXaiJwt(input) ? [input] : [];
  }
  return Object.entries(input).map(([authKey, value]) => ({
    ...(value as Record<string, unknown>),
    auth_key: authKey,
  }));
}

function isXaiFlatRecord(record: Record<string, unknown>): boolean {
  return isExplicitXaiFlatRecord(record)
    || (hasFlatCredential(record) && firstString([record], ["type"]) === "xai");
}

function isExplicitXaiFlatRecord(record: Record<string, unknown>): boolean {
  if (!hasFlatCredential(record)) return false;
  const platform = firstString([record], ["platform"]);
  const issuer = firstString([record], ["oidc_issuer", "issuer", "iss"]);
  const tokenEndpoint = firstString([record], ["token_endpoint", "tokenEndpoint"]);
  return platform === "grok" || issuer === XAI_ISSUER || tokenEndpoint === XAI_TOKEN_ENDPOINT;
}

function hasFlatCredential(record: Record<string, unknown>): boolean {
  return Boolean(firstString([record], [
    "access_token",
    "accessToken",
    "refresh_token",
    "refreshToken",
    "session_token",
    "sessionToken",
    "id_token",
    "idToken",
    "key",
  ]));
}

function hasXaiJwt(record: Record<string, unknown>): boolean {
  const accessClaims = decodeJwtPayload(firstString([record], ["access_token", "accessToken", "key"]));
  const idClaims = decodeJwtPayload(firstString([record], ["id_token", "idToken"]));
  return claimString(accessClaims, "iss") === XAI_ISSUER || claimString(idClaims, "iss") === XAI_ISSUER;
}

function isCodexManagerRecord(record: Record<string, unknown>): boolean {
  return isRecord(record.tokens) && isRecord(record.meta);
}

function isCodexAuthRecord(record: Record<string, unknown>): boolean {
  return (
    record.auth_mode === "chatgpt" &&
    isRecord(record.tokens) &&
    Boolean(firstString([record.tokens], ["access_token", "refresh_token", "id_token"]))
  );
}

function isCodex2ApiRecord(record: Record<string, unknown>): boolean {
  if (isRecord(record.credentials) || isRecord(record.tokens) || Array.isArray(record.accounts) || record.type === "codex") {
    return false;
  }
  return Boolean(firstString([record], ["access_token", "refresh_token", "session_token", "id_token"]));
}

function candidateFromRecord(
  record: Record<string, unknown>,
  source: NormalizeSource,
  index: number,
  inputFormat: InputFormat,
): Candidate {
  const records = [record];
  const credentials = firstRecord(records, "credentials");
  if (credentials) {
    records.unshift(credentials);
  }
  const tokens = firstRecord(records, "tokens");
  if (tokens) {
    records.unshift(tokens);
  }
  const account = firstRecord([record], "account");
  if (account) {
    records.push(accountAliases(account));
  }
  const providerSpecificData = firstRecord([record], "providerSpecificData");
  if (providerSpecificData) {
    records.push(providerSpecificData);
  }
  const meta = firstRecord([record], "meta");
  if (meta) {
    records.push(meta);
  }
  const user = firstRecord([record], "user");
  if (user) {
    records.push(userAliases(user));
    records.push(user);
  }
  return {
    records,
    sourceName: source.sourceName,
    sourcePath: index === 0 ? source.sourcePath : `${source.sourcePath}#${index + 1}`,
    inputFormat,
  };
}

function accountAliases(account: Record<string, unknown>): Record<string, unknown> {
  return {
    account_id: account.account_id ?? account.accountId ?? account.id,
    chatgpt_account_id: account.chatgpt_account_id ?? account.chatgptAccountId ?? account.id,
    plan_type: account.plan_type ?? account.planType ?? account.chatgpt_plan_type ?? account.chatgptPlanType,
    workspace_id: account.workspace_id ?? account.workspaceId,
  };
}

function userAliases(user: Record<string, unknown>): Record<string, unknown> {
  return {
    user_id: user.user_id ?? user.userId ?? user.id,
    chatgpt_user_id: user.chatgpt_user_id ?? user.chatgptUserId ?? user.id,
    email: user.email,
    name: user.name,
  };
}

export function normalizeCandidate(
  candidate: Candidate,
  index: number,
): NormalizedAccount | undefined {
  const { records } = candidate;
  const accessToken = firstString(records, ["access_token", "accessToken", "key"]);
  const refreshToken = firstString(records, ["refresh_token", "refreshToken"]);
  const sessionToken = firstString(records, ["session_token", "sessionToken"]);
  const idToken = firstString(records, ["id_token", "idToken"]);

  if (!accessToken && !refreshToken && !sessionToken && !idToken) {
    return undefined;
  }

  const idClaims = decodeJwtPayload(idToken);
  const accessClaims = decodeJwtPayload(accessToken);
  const accessFirstClaimRecords = [accessClaims, idClaims].filter((claims): claims is Record<string, unknown> => claims !== undefined);
  const expiryClaimRecords = [accessClaims, idClaims].filter((claims): claims is Record<string, unknown> => claims !== undefined);
  const structureProvider = providerFromStructure(candidate, records);
  const jwtProvider = providerFromIssuer(claimString(accessClaims, "iss"))
    ?? providerFromIssuer(claimString(idClaims, "iss"));
  const provider = structureProvider ?? jwtProvider ?? "unknown";
  const grokKey = parseGrokAuthKey(firstString(records, ["auth_key"]));
  const claimedIssuer = firstClaimString(accessFirstClaimRecords, ["iss"]);
  const recordIssuer = firstString(records, ["oidc_issuer", "issuer", "iss"]) ?? grokKey?.issuer;
  const audience = firstClaimStringArray(accessFirstClaimRecords, "aud");
  const clientId = firstString(records, ["client_id", "clientId", "oidc_client_id"])
    ?? grokKey?.clientId
    ?? claimString(accessClaims, "client_id");
  const scopes = firstClaimStringArray(accessFirstClaimRecords, "scp")
    ?? firstClaimStringArray(accessFirstClaimRecords, "scope");
  const claimedNotBefore = firstClaimNumber(accessFirstClaimRecords, "nbf");
  const recordUserId = firstString(records, ["user_id", "userId", "sub"]) ?? grokKey?.userId;
  const claimedUserId = firstClaimString(accessFirstClaimRecords, ["sub"]);
  const recordEmail = firstString(records, ["email", "email_address", "emailAddress"]);
  const standardEmail = claimString(accessClaims, "email") ?? claimString(idClaims, "email");
  const recordName = firstString(records, ["name", "label"]);
  const standardName = claimString(accessClaims, "name") ?? claimString(idClaims, "name");
  const preserveRawTimeFields = candidate.inputFormat === "cpa" || candidate.inputFormat === "codex";
  const recordExpiresAt = normalizeInputTimeValue(
    firstString(records, ["expires_at", "expiresAt", "expired", "expires"]),
    preserveRawTimeFields,
  );
  const claimedExpiresAt = normalizeTimeValue(firstClaimNumber(expiryClaimRecords, "exp"));
  const recordLastRefresh = normalizeInputTimeValue(
    firstString(records, ["last_refresh", "lastRefresh"]),
    preserveRawTimeFields,
  );
  const claimedLastRefresh = normalizeTimeValue(firstClaimNumber(accessFirstClaimRecords, "iat"));
  const sourcePath = candidate.sourcePath || `${candidate.sourceName}#${index + 1}`;
  const common = {
    accessToken,
    refreshToken,
    idToken,
    sessionToken,
    userId: recordUserId ?? claimedUserId,
    issuer: recordIssuer ?? claimedIssuer,
    audience,
    clientId,
    scopes,
    notBefore: normalizeTimeValue(claimedNotBefore),
    email: recordEmail ?? standardEmail,
    name: recordName ?? standardName,
    lastRefresh: recordLastRefresh ?? claimedLastRefresh,
    expiresAt: recordExpiresAt ?? claimedExpiresAt,
    issuedAt: claimedLastRefresh,
    sourceName: candidate.sourceName,
    sourcePath,
    inputFormat: candidate.inputFormat,
  };

  if (provider === "xai") {
    return {
      ...common,
      provider,
      tokenType: firstString(records, ["token_type", "tokenType"]),
      expiresIn: firstNumber(records, ["expires_in", "expiresIn"]),
      principalId: firstString(records, ["principal_id", "principalId"]),
      principalType: firstString(records, ["principal_type", "principalType"]),
      createTime: firstString(records, ["create_time", "createTime"]),
      baseUrl: firstString(records, ["base_url", "baseUrl"]),
      tokenEndpoint: firstString(records, ["token_endpoint", "tokenEndpoint"]),
      redirectUri: firstString(records, ["redirect_uri", "redirectUri"]),
      headers: firstStringRecord(records, "headers"),
      disabled: firstBoolean(records, ["disabled"]),
    } satisfies XaiNormalizedAccount;
  }

  if (provider === "unknown") {
    return { ...common, provider } satisfies UnknownNormalizedAccount;
  }

  const accessAuthClaims = openAIAuthClaims(accessClaims);
  const idAuthClaims = openAIAuthClaims(idClaims);
  const identityClaimRecords = [idClaims, accessClaims].filter((claims): claims is Record<string, unknown> => claims !== undefined);
  const authClaimRecords = accessFirstClaimRecords
    .map(openAIAuthClaims)
    .filter((claims): claims is Record<string, unknown> => claims !== undefined);
  const claimedChatgptAccountUserId =
    claimString(accessAuthClaims, "chatgpt_account_user_id") ??
    claimString(accessClaims, "chatgpt_account_user_id") ??
    claimString(idAuthClaims, "chatgpt_account_user_id") ??
    claimString(idClaims, "chatgpt_account_user_id");
  const accessAccountUserId = splitChatGptAccountUserId(claimedChatgptAccountUserId);
  const idAccountUserId = splitChatGptAccountUserId(claimString(idAuthClaims, "chatgpt_account_user_id"));
  const claimedAccountId =
    claimString(accessAuthClaims, "chatgpt_account_id") ??
    accessAccountUserId?.accountId ??
    claimString(accessClaims, "chatgpt_account_id") ??
    claimString(idAuthClaims, "chatgpt_account_id") ??
    idAccountUserId?.accountId ??
    claimString(idClaims, "chatgpt_account_id");
  const recordAccountId = firstString(records, ["account_id", "accountId"]);
  const preferClaimIdentity = candidate.inputFormat === "session" || candidate.inputFormat === "codex";
  const accountId = preferClaimIdentity ? claimedAccountId ?? recordAccountId : recordAccountId ?? claimedAccountId;
  const chatgptAccountId =
    (preferClaimIdentity
      ? claimedAccountId ?? firstString(records, ["chatgpt_account_id", "chatgptAccountId"])
      : firstString(records, ["chatgpt_account_id", "chatgptAccountId"]) ?? claimedAccountId) ??
    accountId;
  const recordChatgptAccountUserId = firstString(records, ["chatgpt_account_user_id", "chatgptAccountUserId"]);
  const claimedChatgptUserId =
    claimString(accessAuthClaims, "chatgpt_user_id") ??
    claimString(accessAuthClaims, "user_id") ??
    accessAccountUserId?.userId ??
    claimString(accessClaims, "chatgpt_user_id") ??
    claimString(idAuthClaims, "chatgpt_user_id") ??
    claimString(idAuthClaims, "user_id") ??
    idAccountUserId?.userId ??
    claimString(idClaims, "chatgpt_user_id") ??
    claimString(accessClaims, "sub") ??
    claimString(idClaims, "sub");
  const recordChatgptUserId = firstString(records, ["chatgpt_user_id", "chatgptUserId"]);
  const chatgptUserId = preferClaimIdentity ? claimedChatgptUserId ?? recordChatgptUserId : recordChatgptUserId ?? claimedChatgptUserId;
  const chatgptAccountUserId =
    (preferClaimIdentity ? claimedChatgptAccountUserId ?? recordChatgptAccountUserId : recordChatgptAccountUserId ?? claimedChatgptAccountUserId) ??
    buildChatGptAccountUserId(chatgptUserId, chatgptAccountId);
  const userId = preferClaimIdentity ? claimedUserId ?? recordUserId : recordUserId ?? claimedUserId;
  const issuer = preferClaimIdentity ? claimedIssuer ?? recordIssuer : recordIssuer ?? claimedIssuer;
  const claimedEmail =
    standardEmail ??
    claimString(openAIProfileClaims(accessClaims), "email") ??
    claimString(openAIProfileClaims(idClaims), "email");
  const email = preferClaimIdentity ? claimedEmail ?? recordEmail : recordEmail ?? claimedEmail;
  const claimedName =
    standardName ??
    claimString(openAIProfileClaims(accessClaims), "name") ??
    claimString(openAIProfileClaims(idClaims), "name");
  const name = preferClaimIdentity ? claimedName ?? recordName : recordName ?? claimedName;
  const claimedPlanType =
    claimString(accessAuthClaims, "chatgpt_plan_type") ??
    claimString(accessAuthClaims, "plan_type") ??
    claimString(accessClaims, "chatgpt_plan_type") ??
    claimString(accessClaims, "plan_type") ??
    claimString(idAuthClaims, "chatgpt_plan_type") ??
    claimString(idAuthClaims, "plan_type") ??
    claimString(idClaims, "chatgpt_plan_type") ??
    claimString(idClaims, "plan_type");
  const recordPlanType = firstString(records, ["plan_type", "planType", "chatgpt_plan_type", "chatgptPlanType"]);
  const planType = preferClaimIdentity ? claimedPlanType ?? recordPlanType : recordPlanType ?? claimedPlanType;
  const claimedWorkspaceId =
    claimString(accessClaims, "workspace_id") ??
    claimString(accessAuthClaims, "workspace_id") ??
    claimString(idClaims, "workspace_id") ??
    claimString(idAuthClaims, "workspace_id");
  const recordWorkspaceId = firstString(records, ["workspace_id", "workspaceId"]);
  const workspaceId = preferClaimIdentity
    ? claimedWorkspaceId ?? recordWorkspaceId
    : recordWorkspaceId ??
    firstClaimString(identityClaimRecords, ["workspace_id"]) ??
    firstClaimString(authClaimRecords, ["workspace_id"]);
  const expiresAt = preferClaimIdentity ? claimedExpiresAt ?? recordExpiresAt : recordExpiresAt ?? claimedExpiresAt;
  const lastRefresh = preferClaimIdentity ? claimedLastRefresh ?? recordLastRefresh : recordLastRefresh ?? claimedLastRefresh;

  let idTokenSynthetic = firstBoolean(records, ["id_token_synthetic", "idTokenSynthetic"]) ?? false;
  let openAiIdToken = idToken;
  if (openAiIdToken && idTokenSynthetic) {
    openAiIdToken = applySyntheticIdTokenSignature(openAiIdToken);
  }
  if (!openAiIdToken) {
    const syntheticClaims = buildSyntheticClaims({
      claims: accessClaims ?? idClaims,
      email,
      name,
      chatgptAccountId,
      chatgptUserId,
      chatgptAccountUserId,
      userId,
      planType,
      workspaceId,
      expiresAt,
    });
    if (syntheticClaims) {
      openAiIdToken = createSyntheticIdToken(syntheticClaims);
      idTokenSynthetic = true;
    }
  }

  return {
    provider,
    accessToken,
    refreshToken,
    idToken: openAiIdToken,
    idTokenSynthetic,
    sessionToken,
    accountId,
    chatgptAccountId,
    chatgptUserId,
    chatgptAccountUserId,
    workspaceId,
    userId,
    issuer,
    audience,
    clientId,
    scopes,
    notBefore: normalizeTimeValue(claimedNotBefore),
    email,
    name,
    planType,
    lastRefresh,
    expiresAt,
    issuedAt: claimedLastRefresh,
    sourceName: candidate.sourceName,
    sourcePath,
    inputFormat: candidate.inputFormat,
  } satisfies OpenAINormalizedAccount;
}

function normalizeTimeValue(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return new Date(value > 1_000_000_000_000 ? value : value * 1000).toISOString();
  }
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  if (/^\d+$/.test(trimmed)) {
    return normalizeTimeValue(Number(trimmed));
  }
  const date = new Date(trimmed);
  if (!Number.isNaN(date.valueOf())) {
    return date.toISOString();
  }
  return trimmed;
}

function normalizeInputTimeValue(value: string | undefined, preserveRaw: boolean): string | undefined {
  return preserveRaw ? emptyToUndefined(value) : normalizeTimeValue(value);
}

function emptyToUndefined(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

function firstBoolean(records: Record<string, unknown>[], keys: string[]): boolean | undefined {
  for (const record of records) {
    for (const key of keys) {
      const value = record[key];
      if (typeof value === "boolean") {
        return value;
      }
    }
  }
  return undefined;
}

function firstNumber(records: Record<string, unknown>[], keys: string[]): number | undefined {
  for (const record of records) {
    for (const key of keys) {
      const value = record[key];
      if (typeof value === "number" && Number.isFinite(value)) {
        return value;
      }
      if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) {
        return Number(value);
      }
    }
  }
  return undefined;
}

function firstStringRecord(records: Record<string, unknown>[], key: string): Record<string, string> | undefined {
  for (const record of records) {
    const value = record[key];
    if (!isRecord(value)) {
      continue;
    }
    const entries = Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string");
    return Object.fromEntries(entries);
  }
  return undefined;
}

function providerFromIssuer(issuer: string | undefined): "openai" | "xai" | undefined {
  if (issuer === XAI_ISSUER) {
    return "xai";
  }
  if (issuer === OPENAI_ISSUER) {
    return "openai";
  }
  return undefined;
}

function parseGrokAuthKey(value: string | undefined): { issuer: string; clientId?: string; userId?: string } | undefined {
  if (!value) return undefined;
  const [issuer, clientId, userId, ...extra] = value.split("::");
  if (!issuer || extra.length > 0) return undefined;
  return {
    issuer,
    clientId: clientId || undefined,
    userId: userId || undefined,
  };
}

function providerFromStructure(candidate: Candidate, records: Record<string, unknown>[]): "openai" | "xai" | undefined {
  if (candidate.inputFormat === "grok") {
    return "xai";
  }
  if (
    candidate.inputFormat === "session" ||
    candidate.inputFormat === "codex" ||
    candidate.inputFormat === "codexmanager" ||
    candidate.inputFormat === "codex2api"
  ) {
    return "openai";
  }
  const platform = firstString(records, ["platform"]);
  const type = firstString(records, ["type"]);
  if (platform === "grok" || type === "xai") {
    return "xai";
  }
  if (platform === "openai" || type === "codex") {
    return "openai";
  }
  const issuer = firstString(records, ["oidc_issuer", "issuer", "iss"]);
  const tokenEndpoint = firstString(records, ["token_endpoint", "tokenEndpoint"]);
  const openAiAccountId = firstString(records, [
    "account_id",
    "accountId",
    "chatgpt_account_id",
    "chatgptAccountId",
    "chatgpt_user_id",
    "chatgptUserId",
  ]);
  if (
    issuer === XAI_ISSUER ||
    tokenEndpoint === XAI_TOKEN_ENDPOINT
  ) {
    return "xai";
  }
  if (
    issuer === OPENAI_ISSUER ||
    Boolean(openAiAccountId)
  ) {
    return "openai";
  }
  return undefined;
}

function firstClaimString(records: Record<string, unknown>[], keys: string[]): string | undefined {
  for (const record of records) {
    const value = firstString([record], keys);
    if (value) {
      return value;
    }
  }
  return undefined;
}

function firstClaimNumber(records: Record<string, unknown>[], key: string): number | undefined {
  for (const record of records) {
    const value = claimNumber(record, key);
    if (value !== undefined) {
      return value;
    }
  }
  return undefined;
}

function firstClaimStringArray(records: Record<string, unknown>[], key: string): string[] | undefined {
  for (const record of records) {
    const value = claimStringArray(record, key);
    if (value) {
      return value;
    }
  }
  return undefined;
}

function buildChatGptAccountUserId(userId: string | undefined, accountId: string | undefined): string | undefined {
  if (!userId || !accountId) {
    return undefined;
  }
  return `${userId}__${accountId}`;
}

function splitChatGptAccountUserId(value: string | undefined): { accountId: string; userId: string } | undefined {
  if (!value) {
    return undefined;
  }
  const separator = "__";
  const index = value.lastIndexOf(separator);
  if (index <= 0 || index + separator.length >= value.length) {
    return undefined;
  }
  return {
    userId: value.slice(0, index),
    accountId: value.slice(index + separator.length),
  };
}

function buildSyntheticClaims(input: {
  claims?: Record<string, unknown>;
  email?: string;
  name?: string;
  chatgptAccountId?: string;
  chatgptUserId?: string;
  chatgptAccountUserId?: string;
  userId?: string;
  planType?: string;
  workspaceId?: string;
  expiresAt?: string;
}): Record<string, unknown> | undefined {
  const sub = input.chatgptUserId ?? input.userId ?? claimString(input.claims, "sub");
  const exp = input.expiresAt ? Math.floor(new Date(input.expiresAt).getTime() / 1000) : claimNumber(input.claims, "exp");
  if (!input.email && !input.chatgptAccountId && !input.chatgptUserId && !sub && !input.planType) {
    return undefined;
  }
  const auth: Record<string, unknown> = {};
  if (input.chatgptAccountId) {
    auth.chatgpt_account_id = input.chatgptAccountId;
  }
  if (input.planType) {
    auth.chatgpt_plan_type = input.planType;
  }
  if (input.chatgptUserId) {
    auth.chatgpt_user_id = input.chatgptUserId;
    auth.user_id = input.chatgptUserId;
  }
  const chatgptAccountUserId = input.chatgptAccountUserId ?? buildChatGptAccountUserId(input.chatgptUserId, input.chatgptAccountId);
  if (chatgptAccountUserId) {
    auth.chatgpt_account_user_id = chatgptAccountUserId;
  }
  if (input.workspaceId) {
    auth.workspace_id = input.workspaceId;
  }
  const claims: Record<string, unknown> = {};
  if (Number.isFinite(exp)) {
    claims.exp = exp;
  }
  if (sub) {
    claims.sub = sub;
  }
  if (input.email) {
    claims.email = input.email;
  }
  if (input.name) {
    claims.name = input.name;
  }
  if (input.workspaceId) {
    claims.workspace_id = input.workspaceId;
  }
  if (Object.keys(auth).length > 0) {
    claims["https://api.openai.com/auth"] = auth;
  }
  return claims;
}
