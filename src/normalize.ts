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
import { DEFAULT_LOCALE, inputFormatLabel, messagesFor } from "./i18n.js";
import { firstRecord, firstString, isRecord } from "./object.js";
import type { InputFormat, Locale, NormalizedAccount, NormalizeOptions, NormalizeResult, NormalizeSource } from "./types.js";
import { XAI_ISSUER } from "./xai.js";

const OPENAI_ISSUER = "https://auth.openai.com";

type Candidate = {
  records: Record<string, unknown>[];
  sourceName: string;
  sourcePath: string;
  inputFormat: InputFormat;
};

export function detectInputFormat(input: unknown): InputFormat {
  if (Array.isArray(input)) {
    const formats = uniqueFormats(input.filter(isRecord).map(detectArrayItemFormat));
    if (formats.length === 1) {
      return formats[0];
    }
    return "unknown";
  }

  if (!isRecord(input)) {
    return "unknown";
  }

  return detectRecordInputFormat(input);
}

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

  // CPA
  if ((input.type === "codex" || input.type === "xai") && (typeof input.access_token === "string" || typeof input.refresh_token === "string" || typeof input.session_token === "string")) {
    return "cpa";
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

export function normalizeInput(input: unknown, source: NormalizeSource, options: NormalizeOptions = {}): NormalizeResult {
  const locale = options.locale ?? DEFAULT_LOCALE;
  const messages = messagesFor(locale).normalize;
  const warnings: string[] = [];
  const rejections: string[] = [];
  const selectedFormat = selectedInputFormat(options.inputFormat);
  const detectedFormat = detectInputFormat(input);
  const inputFormat = selectedFormat ?? detectedFormat;
  const candidates = extractCandidates(input, source, selectedFormat);
  const acceptedCandidates = candidates.filter((candidate) => {
    const rejection = candidateRejectionWarning(candidate, options.locale ?? DEFAULT_LOCALE);
    if (rejection) {
      rejections.push(rejection);
      return false;
    }
    return true;
  });
  const accounts = acceptedCandidates
    .map((candidate, index) => {
      const account = normalizeCandidate(candidate, index, options);
      if (account) {
        account.inputFormat = candidate.inputFormat;
      }
      return account;
    })
    .filter((account): account is NormalizedAccount => account !== undefined);

  if (accounts.length === 0 && rejections.length === 0) {
    warnings.push(
      selectedFormat
        ? messages.invalidInputFormat(source.sourceName, inputFormatLabel(selectedFormat, locale))
        : messages.noTokens(source.sourceName),
    );
  }

  return {
    accounts,
    warnings: warnings.concat(accounts.flatMap((account) => account.warnings)),
    rejections,
    inputFormat: selectedFormat ?? commonAccountInputFormat(accounts) ?? inputFormat,
  };
}

function candidateRejectionWarning(candidate: Candidate, locale: Locale): string | undefined {
  const records = candidate.records;
  const accessClaims = decodeJwtPayload(firstString(records, ["access_token", "accessToken", "key"]));
  const idClaims = decodeJwtPayload(firstString(records, ["id_token", "idToken"]));
  const structureProvider = providerFromStructure(candidate, records);
  const jwtProvider = providerFromIssuer(claimString(accessClaims, "iss") ?? claimString(idClaims, "iss"));
  if (structureProvider && jwtProvider && structureProvider !== jwtProvider) {
    return `${candidate.sourceName}: ${locale === "en" ? "provider conflict" : "平台冲突"}`;
  }
  return undefined;
}

function selectedInputFormat(inputFormat: InputFormat | undefined): InputFormat | undefined {
  return inputFormat && inputFormat !== "unknown" ? inputFormat : undefined;
}

function uniqueFormats(formats: InputFormat[]): InputFormat[] {
  return Array.from(new Set(formats));
}

function commonAccountInputFormat(accounts: NormalizedAccount[]): InputFormat | undefined {
  if (accounts.length === 0) {
    return undefined;
  }
  const formats = uniqueFormats(accounts.map((account) => account.inputFormat ?? "unknown"));
  return formats.length === 1 ? formats[0] : "unknown";
}

function extractCandidates(
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
    return hasXaiJwt(input) || input.type === "xai" ? [input] : [];
  }
  return Object.entries(input).map(([authKey, value]) => ({
    ...(value as Record<string, unknown>),
    auth_key: authKey,
  }));
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

function normalizeCandidate(
  candidate: Candidate,
  index: number,
  options: NormalizeOptions,
): NormalizedAccount | undefined {
  const messages = messagesFor(options.locale ?? DEFAULT_LOCALE).normalize;
  const { records } = candidate;
  const accessToken = firstString(records, ["access_token", "accessToken", "key"]);
  const refreshToken = firstString(records, ["refresh_token", "refreshToken"]);
  const sessionToken = firstString(records, ["session_token", "sessionToken"]);
  let idToken = firstString(records, ["id_token", "idToken"]);

  if (!accessToken && !refreshToken && !sessionToken && !idToken) {
    return undefined;
  }

  const idClaims = decodeJwtPayload(idToken);
  const accessClaims = decodeJwtPayload(accessToken);
  const identityClaimRecords = [idClaims, accessClaims].filter((claims): claims is Record<string, unknown> => claims !== undefined);
  const accessFirstClaimRecords = [accessClaims, idClaims].filter((claims): claims is Record<string, unknown> => claims !== undefined);
  const expiryClaimRecords = [accessClaims, idClaims].filter((claims): claims is Record<string, unknown> => claims !== undefined);
  const authClaimRecords = accessFirstClaimRecords
    .map(openAIAuthClaims)
    .filter((claims): claims is Record<string, unknown> => claims !== undefined);
  const claims = accessClaims ?? idClaims;
  const warnings: string[] = [];
  const structureProvider = providerFromStructure(candidate, records);
  const jwtProvider = providerFromIssuer(
    claimString(accessClaims, "iss") ?? claimString(idClaims, "iss"),
  );
  const provider = structureProvider ?? jwtProvider ?? "unknown";

  const accessAuthClaims = openAIAuthClaims(accessClaims);
  const idAuthClaims = openAIAuthClaims(idClaims);
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
  const claimedUserId = firstClaimString(accessFirstClaimRecords, ["sub"]);
  const recordUserId = firstString(records, ["user_id", "userId", "sub"]);
  const userId = preferClaimIdentity ? claimedUserId ?? recordUserId : recordUserId ?? claimedUserId;
  const claimedIssuer = firstClaimString(accessFirstClaimRecords, ["iss"]);
  const recordIssuer = firstString(records, ["issuer", "iss"]);
  const issuer = preferClaimIdentity ? claimedIssuer ?? recordIssuer : recordIssuer ?? claimedIssuer;
  const audience = firstClaimStringArray(accessFirstClaimRecords, "aud");
  const clientId = firstString(records, ["client_id", "clientId", "oidc_client_id"])
    ?? firstClaimString(accessFirstClaimRecords, ["client_id"]);
  const scopes = firstClaimStringArray(accessFirstClaimRecords, "scp")
    ?? firstClaimStringArray(accessFirstClaimRecords, "scope");
  const claimedNotBeforeNumber = firstClaimNumber(accessFirstClaimRecords, "nbf");
  const notBefore = normalizeTimeValue(claimedNotBeforeNumber);
  const recordEmail = firstString(records, ["email", "email_address", "emailAddress"]);
  const claimedEmail =
    claimString(accessClaims, "email") ??
    claimString(openAIProfileClaims(accessClaims), "email") ??
    claimString(idClaims, "email") ??
    claimString(openAIProfileClaims(idClaims), "email");
  const email = preferClaimIdentity ? claimedEmail ?? recordEmail : recordEmail ?? claimedEmail;
  const recordName = firstString(records, ["name", "label"]);
  const claimedName =
    claimString(accessClaims, "name") ??
    claimString(openAIProfileClaims(accessClaims), "name") ??
    claimString(idClaims, "name") ??
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
  const preserveRawTimeFields = candidate.inputFormat === "cpa" || candidate.inputFormat === "codex";
  const recordExpiresAt = normalizeInputTimeValue(firstString(records, ["expires_at", "expiresAt", "expired", "expires"]), preserveRawTimeFields);
  const claimedExpiresAt = normalizeTimeValue(firstClaimNumber(expiryClaimRecords, "exp"));
  const recordLastRefresh = normalizeInputTimeValue(firstString(records, ["last_refresh", "lastRefresh"]), preserveRawTimeFields);
  const claimedLastRefresh = normalizeTimeValue(firstClaimNumber(accessFirstClaimRecords, "iat"));
  const workspaceId = preferClaimIdentity
    ? claimedWorkspaceId ?? recordWorkspaceId
    : recordWorkspaceId ??
    firstClaimString(identityClaimRecords, ["workspace_id"]) ??
    firstClaimString(authClaimRecords, ["workspace_id"]);
  const expiresAt = preferClaimIdentity ? claimedExpiresAt ?? recordExpiresAt : recordExpiresAt ?? claimedExpiresAt;
  const lastRefresh = preferClaimIdentity ? claimedLastRefresh ?? recordLastRefresh : recordLastRefresh ?? claimedLastRefresh;

  if (preferClaimIdentity) {
    const overrideFields: string[] = [];
    if (recordAccountId && claimedAccountId && recordAccountId !== claimedAccountId) {
      overrideFields.push("account_id");
    }
    if (recordUserId && claimedUserId && recordUserId !== claimedUserId) {
      overrideFields.push("user_id");
    }
    if (recordChatgptUserId && claimedChatgptUserId && recordChatgptUserId !== claimedChatgptUserId) {
      overrideFields.push("chatgpt_user_id");
    }
    if (recordChatgptAccountUserId && claimedChatgptAccountUserId && recordChatgptAccountUserId !== claimedChatgptAccountUserId) {
      overrideFields.push("chatgpt_account_user_id");
    }
    if (recordIssuer && claimedIssuer && recordIssuer !== claimedIssuer) {
      overrideFields.push("issuer");
    }
    if (recordPlanType && claimedPlanType && recordPlanType !== claimedPlanType) {
      overrideFields.push("plan_type");
    }
    if (recordEmail && claimedEmail && recordEmail !== claimedEmail) {
      overrideFields.push("email");
    }
    if (recordName && claimedName && recordName !== claimedName) {
      overrideFields.push("name");
    }
    if (recordWorkspaceId && claimedWorkspaceId && recordWorkspaceId !== claimedWorkspaceId) {
      overrideFields.push("workspace_id");
    }
    if (recordExpiresAt && claimedExpiresAt && recordExpiresAt !== claimedExpiresAt) {
      overrideFields.push("expires_at");
    }
    if (recordLastRefresh && claimedLastRefresh && recordLastRefresh !== claimedLastRefresh) {
      overrideFields.push("last_refresh");
    }
    if (overrideFields.length > 0) {
      warnings.push(messages.claimOverride(candidate.sourceName, overrideFields));
    }
  }

  const sanityFields = claimSanityFields({
    provider,
    issuer: claimedIssuer,
    audience,
    notBefore: claimedNotBeforeNumber,
    expiresAt: firstClaimNumber(expiryClaimRecords, "exp"),
  });
  if (sanityFields.length > 0) {
    warnings.push(messages.claimSanity(candidate.sourceName, sanityFields));
  }

  if (expiresAt && Number.isNaN(new Date(expiresAt).getTime())) {
    warnings.push(messages.invalidExpiry(candidate.sourceName, expiresAt));
  }

  let idTokenSynthetic = firstBoolean(records, ["id_token_synthetic", "idTokenSynthetic"]) ?? false;
  if (idToken && idTokenSynthetic) {
    idToken = applySyntheticIdTokenSignature(idToken);
  }
  if (!idToken && provider === "openai") {
    const syntheticClaims = buildSyntheticClaims({
      claims,
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
      idToken = createSyntheticIdToken(syntheticClaims);
      idTokenSynthetic = true;
    }
  }

  return {
    provider,
    accessToken,
    refreshToken,
    idToken,
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
    notBefore,
    email,
    name,
    planType,
    lastRefresh,
    expiresAt,
    issuedAt: claimedLastRefresh,
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
    sourceName: candidate.sourceName,
    sourcePath: candidate.sourcePath || `${candidate.sourceName}#${index + 1}`,
    warnings,
  };
}

const DEDUPE_IGNORED_KEYS = new Set<keyof NormalizedAccount>([
  "sourceName",
  "sourcePath",
  "warnings",
  "inputFormat",
]);

const DEDUPE_CREDENTIAL_KEYS = [
  "accessToken",
  "refreshToken",
  "sessionToken",
  "idToken",
] as const satisfies readonly (keyof NormalizedAccount)[];

export type DedupeAccountsResult = {
  accounts: NormalizedAccount[];
  affectedIndex: number | undefined;
};

/** 真实凭据逐项兼容时去重；元数据和身份字段不参与。 */
export function dedupeAccounts(accounts: NormalizedAccount[]): NormalizedAccount[] {
  return dedupeAccountsWithAffectedIndex(accounts).accounts;
}

export function dedupeAccountsWithAffectedIndex(
  accounts: NormalizedAccount[],
  affectedStartIndex = 0,
): DedupeAccountsResult {
  const result: NormalizedAccount[] = [];
  let firstAffectedAccount: NormalizedAccount | undefined;
  for (const [inputIndex, account] of accounts.entries()) {
    const credentialMatches = result.filter((existing) => hasCompatibleCredentials(existing, account));
    if (credentialMatches.length === 1) {
      const existing = credentialMatches[0];
      mergeMissingAccountFields(existing, account);
      if (inputIndex >= affectedStartIndex && !firstAffectedAccount) {
        firstAffectedAccount = existing;
      }
      continue;
    }

    result.push(account);
    if (inputIndex >= affectedStartIndex && !firstAffectedAccount) {
      firstAffectedAccount = account;
    }
  }
  const affectedIndex = firstAffectedAccount ? result.indexOf(firstAffectedAccount) : -1;
  return {
    accounts: result,
    affectedIndex: affectedIndex >= 0 ? affectedIndex : undefined,
  };
}

function hasCompatibleCredentials(left: NormalizedAccount, right: NormalizedAccount): boolean {
  if (left.provider !== right.provider) {
    return false;
  }
  let hasSharedCredential = false;
  for (const key of DEDUPE_CREDENTIAL_KEYS) {
    const leftValue = dedupeCredentialValue(left, key);
    const rightValue = dedupeCredentialValue(right, key);
    if (!leftValue || !rightValue) {
      continue;
    }
    if (leftValue !== rightValue) {
      return false;
    }
    hasSharedCredential = true;
  }
  return hasSharedCredential;
}

function dedupeCredentialValue(account: NormalizedAccount, key: (typeof DEDUPE_CREDENTIAL_KEYS)[number]): string | undefined {
  if (key === "idToken" && account.idTokenSynthetic) {
    return undefined;
  }
  const value = account[key];
  return typeof value === "string" && value !== "" ? value : undefined;
}

function mergeMissingAccountFields(target: NormalizedAccount, source: NormalizedAccount): void {
  for (const key of Object.keys(source) as (keyof NormalizedAccount)[]) {
    if (DEDUPE_IGNORED_KEYS.has(key)) {
      continue;
    }
    const sourceValue = source[key];
    if (isMissingValue(target[key]) && !isMissingValue(sourceValue)) {
      (target as Record<keyof NormalizedAccount, unknown>)[key] = sourceValue;
    }
  }
  if (target.idTokenSynthetic && source.idToken && !source.idTokenSynthetic) {
    target.idToken = source.idToken;
    target.idTokenSynthetic = false;
  } else if (source.idTokenSynthetic && (!target.idToken || target.idToken === source.idToken)) {
    target.idTokenSynthetic = true;
  }
  target.warnings = [...new Set([...target.warnings, ...source.warnings])];
}

function isMissingValue(value: unknown): boolean {
  return value === undefined || value === "";
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

function providerFromStructure(candidate: Candidate, records: Record<string, unknown>[]): "openai" | "xai" | undefined {
  if (candidate.inputFormat === "grok") {
    return "xai";
  }
  const platform = firstString(records, ["platform"]);
  const type = firstString(records, ["type"]);
  const issuer = firstString(records, ["oidc_issuer", "issuer"]);
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
    type === "xai" ||
    platform === "grok" ||
    issuer === XAI_ISSUER ||
    tokenEndpoint === `${XAI_ISSUER}/oauth2/token`
  ) {
    return "xai";
  }
  if (
    type === "codex" ||
    platform === "openai" ||
    Boolean(openAiAccountId) ||
    candidate.inputFormat === "session" ||
    candidate.inputFormat === "codex" ||
    candidate.inputFormat === "codexmanager" ||
    candidate.inputFormat === "codex2api"
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

function claimSanityFields(input: {
  provider: "openai" | "xai" | "unknown";
  issuer?: string;
  audience?: string[];
  notBefore?: number;
  expiresAt?: number;
}): string[] {
  const fields: string[] = [];
  const expectedIssuer = input.provider === "xai"
    ? XAI_ISSUER
    : input.provider === "openai"
      ? OPENAI_ISSUER
      : undefined;
  if (expectedIssuer && input.issuer && input.issuer !== expectedIssuer) {
    fields.push("iss");
  }
  if (input.provider === "openai" && input.audience && !input.audience.includes("https://api.openai.com/v1")) {
    fields.push("aud");
  }
  if (input.notBefore !== undefined && input.expiresAt !== undefined && input.notBefore > input.expiresAt) {
    fields.push("nbf");
  }
  return fields;
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
