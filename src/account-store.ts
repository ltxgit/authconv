import type {
  InputFormat,
  NormalizedAccount,
  Provider,
  TokenVerification,
  TokenVerificationContext,
  TokenVerificationStatus,
} from "./types.js";

const CREDENTIAL_KEYS = ["accessToken", "refreshToken", "sessionToken", "idToken"] as const;
type CredentialKey = (typeof CREDENTIAL_KEYS)[number];

const MERGE_IGNORED_KEYS = new Set<keyof NormalizedAccount>([
  "accessToken",
  "sourceName",
  "sourcePath",
  "inputFormat",
  "tokenVerification",
  "tokenVerificationContext",
]);

type StoredAccount = {
  id: string;
  account: NormalizedAccount;
  searchText: string;
};

type CredentialIndex = {
  values: Map<string, Set<string>>;
  missing: Set<string>;
};

type ProviderIndex = Record<CredentialKey, CredentialIndex>;

export type AccountListItem = {
  id: string;
  index: number;
  provider: Provider;
  email?: string;
  name?: string;
  accountId?: string;
  chatgptAccountId?: string;
  userId?: string;
  planType?: string;
  expiresAt?: string;
  inputFormat: InputFormat;
  sourceName: string;
  tokenVerification?: TokenVerification;
};

export type AccountRange = {
  total: number;
  offset: number;
  items: AccountListItem[];
};

export type AccountStoreSummary = {
  total: number;
  providerCounts: Record<Provider, number>;
  planCount: number;
  expiredCount: number;
  verificationCounts: Record<TokenVerificationStatus, number>;
  providerVerificationCounts: Record<Provider, Record<TokenVerificationStatus, number>>;
};

export type AccountStoreCommit = {
  processed: number;
  added: number;
  merged: number;
  skippedForged: number;
  firstAffectedId?: string;
};

export class AccountStore {
  readonly #records = new Map<string, StoredAccount>();
  readonly #order: string[] = [];
  readonly #indexes: Record<Provider, ProviderIndex> = {
    openai: createProviderIndex(),
    xai: createProviderIndex(),
    unknown: createProviderIndex(),
  };
  #nextId = 1;

  get size(): number {
    return this.#order.length;
  }

  commitSource(accounts: Iterable<NormalizedAccount>): AccountStoreCommit {
    const result: AccountStoreCommit = { processed: 0, added: 0, merged: 0, skippedForged: 0 };
    for (const account of accounts) {
      const affected = this.#add(account);
      result.processed += 1;
      result[affected.added ? "added" : "merged"] += 1;
      result.firstAffectedId ??= affected.id;
    }
    return result;
  }

  #add(account: NormalizedAccount): { id: string; added: boolean } {
    const compatibleIds = this.#compatibleGroupIds(account);
    if (compatibleIds.length === 1) {
      const id = compatibleIds[0];
      const stored = this.#records.get(id);
      if (!stored) {
        throw new Error(`AccountStore index points to missing group: ${id}`);
      }
      const previousCredentials = credentialSnapshot(stored.account);
      mergeMissingFields(stored.account, account);
      stored.searchText = accountSearchText(stored.account);
      this.#indexNewCredentials(id, stored.account, previousCredentials);
      return { id, added: false };
    }

    const id = `account-${this.#nextId}`;
    this.#nextId += 1;
    this.#records.set(id, {
      id,
      account,
      searchText: accountSearchText(account),
    });
    this.#order.push(id);
    this.#indexAccount(id, account);
    return { id, added: true };
  }

  get(id: string): NormalizedAccount | undefined {
    return this.#records.get(id)?.account;
  }

  updateAccessTokenVerification(
    id: string,
    expected: Pick<NormalizedAccount, "accessToken">,
    verification: TokenVerification,
    context: TokenVerificationContext,
  ): boolean {
    const account = this.#records.get(id)?.account;
    if (
      !account
      || account.accessToken !== expected.accessToken
    ) return false;
    account.tokenVerification = verification;
    account.tokenVerificationContext = context;
    return true;
  }

  getAt(index: number): NormalizedAccount | undefined {
    const id = this.#order[index];
    return id ? this.#records.get(id)?.account : undefined;
  }

  idAt(index: number): string | undefined {
    return this.#order[index];
  }

  indexOf(id: string): number {
    return this.#order.indexOf(id);
  }

  *entries(): IterableIterator<[string, NormalizedAccount]> {
    for (const id of this.#order) {
      const account = this.#records.get(id)?.account;
      if (account) {
        yield [id, account];
      }
    }
  }

  *values(): IterableIterator<NormalizedAccount> {
    for (const [, account] of this.entries()) {
      yield account;
    }
  }

  remove(id: string): boolean {
    if (!this.#deleteRecord(id)) return false;
    const index = this.#order.indexOf(id);
    if (index >= 0) this.#order.splice(index, 1);
    return true;
  }

  removeMany(ids: Iterable<string>): number {
    const removed = new Set<string>();
    for (const id of ids) {
      if (removed.has(id) || !this.#deleteRecord(id)) continue;
      removed.add(id);
    }
    if (removed.size === 0) return 0;

    let writeIndex = 0;
    for (const id of this.#order) {
      if (removed.has(id)) continue;
      this.#order[writeIndex] = id;
      writeIndex += 1;
    }
    this.#order.length = writeIndex;
    return removed.size;
  }

  clear(): void {
    this.#records.clear();
    this.#order.length = 0;
    for (const providerIndex of Object.values(this.#indexes)) {
      for (const index of Object.values(providerIndex)) {
        index.values.clear();
        index.missing.clear();
      }
    }
  }

  range(offset: number, limit: number, query = ""): AccountRange {
    const safeOffset = Math.max(0, Math.trunc(offset));
    const safeLimit = Math.max(0, Math.trunc(limit));
    const needle = query.trim().toLocaleLowerCase();
    const items: AccountListItem[] = [];

    if (!needle) {
      const end = Math.min(this.#order.length, safeOffset + safeLimit);
      for (let index = safeOffset; index < end; index += 1) {
        const stored = this.#records.get(this.#order[index]);
        if (stored) items.push(accountListItem(stored, index));
      }
      return { total: this.#order.length, offset: safeOffset, items };
    }

    let matched = 0;

    for (let index = 0; index < this.#order.length; index += 1) {
      const id = this.#order[index];
      const stored = this.#records.get(id);
      if (!stored || (needle && !stored.searchText.includes(needle))) {
        continue;
      }
      if (matched >= safeOffset && items.length < safeLimit) {
        items.push(accountListItem(stored, index));
      }
      matched += 1;
    }

    return { total: matched, offset: safeOffset, items };
  }

  summary(now = Date.now()): AccountStoreSummary {
    const providerCounts: Record<Provider, number> = { openai: 0, xai: 0, unknown: 0 };
    let planCount = 0;
    let expiredCount = 0;
    const verificationCounts: Record<TokenVerificationStatus, number> = {
      verified: 0,
      forged: 0,
      unverifiable: 0,
      unchecked: 0,
    };
    const providerVerificationCounts = createProviderVerificationCounts();
    for (const account of this.values()) {
      providerCounts[account.provider] += 1;
      if (account.provider === "openai" && account.planType?.trim()) {
        planCount += 1;
      }
      if (isExpired(account.expiresAt, now)) {
        expiredCount += 1;
      }
      if (account.tokenVerification) {
        verificationCounts[account.tokenVerification.status] += 1;
        providerVerificationCounts[account.provider][account.tokenVerification.status] += 1;
      }
    }
    return {
      total: this.size,
      providerCounts,
      planCount,
      expiredCount,
      verificationCounts,
      providerVerificationCounts,
    };
  }

  #compatibleGroupIds(account: NormalizedAccount): string[] {
    const providerIndex = this.#indexes[account.provider];
    const credentials = CREDENTIAL_KEYS.flatMap((key) => {
      const value = credentialValue(account, key);
      return value ? [{ key, value }] : [];
    });
    if (credentials.length === 0) return [];

    const matchingSets: Set<string>[] = [];
    let matchingSize = 0;
    let seedSets: Set<string>[] | undefined;
    let seedSize = Number.POSITIVE_INFINITY;

    for (const { key, value } of credentials) {
      const index = providerIndex[key];
      const exact = index.values.get(value);
      if (exact?.size) {
        matchingSets.push(exact);
        matchingSize += exact.size;
      }
      const allowedSets = exact?.size ? [index.missing, exact] : [index.missing];
      const allowedSize = index.missing.size + (exact?.size ?? 0);
      if (allowedSize === 0) return [];
      if (allowedSize < seedSize) {
        seedSets = allowedSets;
        seedSize = allowedSize;
      }
    }
    if (matchingSize === 0) return [];
    if (matchingSize < seedSize) seedSets = matchingSets;

    const compatible: string[] = [];
    const visited = new Set<string>();
    // #add only distinguishes zero, one, or multiple groups, so two matches are sufficient.
    for (const ids of seedSets ?? matchingSets) {
      for (const id of ids) {
        if (visited.has(id)) continue;
        visited.add(id);
        const existing = this.#records.get(id)?.account;
        if (!existing || !hasCompatibleCredentials(existing, account)) continue;
        compatible.push(id);
        if (compatible.length === 2) return compatible;
      }
    }
    return compatible;
  }

  #indexAccount(id: string, account: NormalizedAccount): void {
    for (const key of CREDENTIAL_KEYS) {
      const value = credentialValue(account, key);
      const index = this.#indexes[account.provider][key];
      if (value) addIndexValue(index.values, value, id);
      else index.missing.add(id);
    }
  }

  #indexNewCredentials(
    id: string,
    account: NormalizedAccount,
    previous: Partial<Record<CredentialKey, string>>,
  ): void {
    for (const key of CREDENTIAL_KEYS) {
      const value = credentialValue(account, key);
      const previousValue = previous[key];
      if (value === previousValue) continue;
      const index = this.#indexes[account.provider][key];
      if (previousValue) removeIndexValue(index.values, previousValue, id);
      else index.missing.delete(id);
      if (value) addIndexValue(index.values, value, id);
      else index.missing.add(id);
    }
  }

  #removeFromIndexes(id: string, account: NormalizedAccount): void {
    for (const key of CREDENTIAL_KEYS) {
      const value = credentialValue(account, key);
      const index = this.#indexes[account.provider][key];
      if (value) removeIndexValue(index.values, value, id);
      else index.missing.delete(id);
    }
  }

  #deleteRecord(id: string): boolean {
    const stored = this.#records.get(id);
    if (!stored) return false;
    this.#removeFromIndexes(id, stored.account);
    this.#records.delete(id);
    return true;
  }
}

function createProviderIndex(): ProviderIndex {
  return {
    accessToken: createCredentialIndex(),
    refreshToken: createCredentialIndex(),
    sessionToken: createCredentialIndex(),
    idToken: createCredentialIndex(),
  };
}

function createCredentialIndex(): CredentialIndex {
  return { values: new Map(), missing: new Set() };
}

function createProviderVerificationCounts(): Record<Provider, Record<TokenVerificationStatus, number>> {
  return {
    openai: { verified: 0, forged: 0, unverifiable: 0, unchecked: 0 },
    xai: { verified: 0, forged: 0, unverifiable: 0, unchecked: 0 },
    unknown: { verified: 0, forged: 0, unverifiable: 0, unchecked: 0 },
  };
}

function addIndexValue(index: Map<string, Set<string>>, value: string, id: string): void {
  const ids = index.get(value);
  if (ids) {
    ids.add(id);
  } else {
    index.set(value, new Set([id]));
  }
}

function removeIndexValue(index: Map<string, Set<string>>, value: string, id: string): void {
  const ids = index.get(value);
  ids?.delete(id);
  if (ids?.size === 0) index.delete(value);
}

function credentialSnapshot(account: NormalizedAccount): Partial<Record<CredentialKey, string>> {
  return Object.fromEntries(
    CREDENTIAL_KEYS.flatMap((key) => {
      const value = credentialValue(account, key);
      return value ? [[key, value] as const] : [];
    }),
  );
}

function credentialValue(account: NormalizedAccount, key: CredentialKey): string | undefined {
  if (key === "idToken" && account.provider === "openai" && account.idTokenSynthetic) {
    return undefined;
  }
  const value = account[key];
  return typeof value === "string" && value !== "" ? value : undefined;
}

function hasCompatibleCredentials(left: NormalizedAccount, right: NormalizedAccount): boolean {
  if (left.provider !== right.provider) {
    return false;
  }
  let shared = false;
  for (const key of CREDENTIAL_KEYS) {
    const leftValue = credentialValue(left, key);
    const rightValue = credentialValue(right, key);
    if (!leftValue || !rightValue) {
      continue;
    }
    if (leftValue !== rightValue) {
      return false;
    }
    shared = true;
  }
  return shared;
}

function mergeMissingFields(target: NormalizedAccount, source: NormalizedAccount): void {
  const targetHadIdToken = Boolean(target.idToken);
  mergeAccessCredentialUnit(target, source);
  const targetRecord = target as unknown as Record<string, unknown>;
  const sourceRecord = source as unknown as Record<string, unknown>;
  for (const key of Object.keys(sourceRecord)) {
    if (MERGE_IGNORED_KEYS.has(key as keyof NormalizedAccount)) {
      continue;
    }
    const sourceValue = sourceRecord[key];
    if (isMissingValue(targetRecord[key]) && !isMissingValue(sourceValue)) {
      targetRecord[key] = sourceValue;
    }
  }
  if (target.provider !== "openai" || source.provider !== "openai") return;
  if (target.idTokenSynthetic && source.idToken && !source.idTokenSynthetic) {
    target.idToken = source.idToken;
    target.idTokenSynthetic = false;
  } else if (!targetHadIdToken && source.idToken && source.idTokenSynthetic) {
    target.idTokenSynthetic = true;
  }
}

function mergeAccessCredentialUnit(target: NormalizedAccount, source: NormalizedAccount): void {
  if (!target.accessToken && source.accessToken) {
    target.accessToken = source.accessToken;
    if (source.tokenVerification && source.tokenVerificationContext) {
      target.tokenVerification = source.tokenVerification;
      target.tokenVerificationContext = source.tokenVerificationContext;
    } else {
      delete target.tokenVerification;
      delete target.tokenVerificationContext;
    }
    return;
  }
  if (
    target.accessToken
    && target.accessToken === source.accessToken
    && !target.tokenVerification
  ) {
    if (source.tokenVerification && source.tokenVerificationContext) {
      target.tokenVerification = source.tokenVerification;
      target.tokenVerificationContext = source.tokenVerificationContext;
    } else {
      delete target.tokenVerification;
      delete target.tokenVerificationContext;
    }
    return;
  }
  if (
    !target.accessToken
    && !source.accessToken
    && !target.tokenVerification
    && source.tokenVerification
    && source.tokenVerificationContext
  ) {
    target.tokenVerification = source.tokenVerification;
    target.tokenVerificationContext = source.tokenVerificationContext;
  }
}

function isMissingValue(value: unknown): boolean {
  return value === undefined || value === "";
}

export function accountSearchText(account: NormalizedAccount): string {
  const openAi = account.provider === "openai" ? account : undefined;
  const xai = account.provider === "xai" ? account : undefined;
  return [
    account.email,
    account.name,
    openAi?.accountId,
    openAi?.chatgptAccountId,
    openAi?.chatgptUserId,
    openAi?.planType,
    account.userId,
    xai?.principalId,
    account.provider,
  ].filter((value): value is string => Boolean(value)).join("\n").toLocaleLowerCase();
}

function accountListItem(stored: StoredAccount, index: number): AccountListItem {
  const account = stored.account;
  const openAi = account.provider === "openai" ? account : undefined;
  return {
    id: stored.id,
    index,
    provider: account.provider,
    email: account.email,
    name: account.name,
    accountId: openAi?.accountId,
    chatgptAccountId: openAi?.chatgptAccountId,
    userId: account.userId,
    planType: openAi?.planType,
    expiresAt: account.expiresAt,
    inputFormat: account.inputFormat,
    sourceName: account.sourceName,
    tokenVerification: account.tokenVerification,
  };
}

function isExpired(expiresAt: string | undefined, now: number): boolean {
  if (!expiresAt) {
    return false;
  }
  const value = new Date(expiresAt).getTime();
  return Number.isFinite(value) && value <= now;
}
