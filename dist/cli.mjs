#!/usr/bin/env node
var __defProp = Object.defineProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};

// src/cli.ts
import { createReadStream } from "node:fs";
import { mkdir, open, readFile, readdir, stat } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

// package.json
var package_default = {
  name: "authconv",
  version: "0.2.0",
  license: "MIT",
  type: "module",
  engines: {
    node: ">=22"
  },
  bin: {
    authconv: "./dist/cli.mjs"
  },
  scripts: {
    test: "vitest run",
    build: "node scripts/build.mjs",
    benchmark: "node scripts/benchmark.mjs",
    "check:dist": "node scripts/check-dist.mjs",
    typecheck: "tsc --noEmit",
    verify: "npm test -- --maxWorkers=1 && npm run typecheck && npm run build && npm run check:dist"
  },
  dependencies: {
    "@zip.js/zip.js": "2.8.31",
    fflate: "0.8.2",
    "stream-chain": "4.2.5",
    "stream-json": "3.5.0"
  },
  devDependencies: {
    "@types/node": "26.1.0",
    esbuild: "0.25.11",
    typescript: "5.9.3",
    vitest: "4.0.7"
  }
};

// src/account-store.ts
var CREDENTIAL_KEYS = ["accessToken", "refreshToken", "sessionToken", "idToken"];
var MERGE_IGNORED_KEYS = /* @__PURE__ */ new Set([
  "accessToken",
  "sourceName",
  "sourcePath",
  "inputFormat",
  "tokenVerification",
  "tokenVerificationContext"
]);
var AccountStore = class {
  #records = /* @__PURE__ */ new Map();
  #order = [];
  #indexes = {
    openai: createProviderIndex(),
    xai: createProviderIndex(),
    unknown: createProviderIndex()
  };
  #nextId = 1;
  get size() {
    return this.#order.length;
  }
  commitSource(accounts) {
    const result = { processed: 0, added: 0, merged: 0, skippedForged: 0 };
    for (const account of accounts) {
      const affected = this.#add(account);
      result.processed += 1;
      result[affected.added ? "added" : "merged"] += 1;
      result.firstAffectedId ??= affected.id;
    }
    return result;
  }
  #add(account) {
    const compatibleIds = this.#compatibleGroupIds(account);
    if (compatibleIds.length === 1) {
      const id2 = compatibleIds[0];
      const stored = this.#records.get(id2);
      if (!stored) {
        throw new Error(`AccountStore index points to missing group: ${id2}`);
      }
      const previousCredentials = credentialSnapshot(stored.account);
      mergeMissingFields(stored.account, account);
      stored.searchText = accountSearchText(stored.account);
      this.#indexNewCredentials(id2, stored.account, previousCredentials);
      return { id: id2, added: false };
    }
    const id = `account-${this.#nextId}`;
    this.#nextId += 1;
    this.#records.set(id, {
      id,
      account,
      searchText: accountSearchText(account)
    });
    this.#order.push(id);
    this.#indexAccount(id, account);
    return { id, added: true };
  }
  get(id) {
    return this.#records.get(id)?.account;
  }
  updateAccessTokenVerification(id, expected2, verification, context) {
    const account = this.#records.get(id)?.account;
    if (!account || account.accessToken !== expected2.accessToken) return false;
    account.tokenVerification = verification;
    account.tokenVerificationContext = context;
    return true;
  }
  getAt(index) {
    const id = this.#order[index];
    return id ? this.#records.get(id)?.account : void 0;
  }
  idAt(index) {
    return this.#order[index];
  }
  indexOf(id) {
    return this.#order.indexOf(id);
  }
  *entries() {
    for (const id of this.#order) {
      const account = this.#records.get(id)?.account;
      if (account) {
        yield [id, account];
      }
    }
  }
  *values() {
    for (const [, account] of this.entries()) {
      yield account;
    }
  }
  remove(id) {
    if (!this.#deleteRecord(id)) return false;
    const index = this.#order.indexOf(id);
    if (index >= 0) this.#order.splice(index, 1);
    return true;
  }
  removeMany(ids) {
    const removed = /* @__PURE__ */ new Set();
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
  clear() {
    this.#records.clear();
    this.#order.length = 0;
    for (const providerIndex of Object.values(this.#indexes)) {
      for (const index of Object.values(providerIndex)) {
        index.values.clear();
        index.missing.clear();
      }
    }
  }
  range(offset, limit, query = "") {
    const safeOffset = Math.max(0, Math.trunc(offset));
    const safeLimit = Math.max(0, Math.trunc(limit));
    const needle = query.trim().toLocaleLowerCase();
    const items = [];
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
      if (!stored || needle && !stored.searchText.includes(needle)) {
        continue;
      }
      if (matched >= safeOffset && items.length < safeLimit) {
        items.push(accountListItem(stored, index));
      }
      matched += 1;
    }
    return { total: matched, offset: safeOffset, items };
  }
  summary(now = Date.now()) {
    const providerCounts = { openai: 0, xai: 0, unknown: 0 };
    let planCount = 0;
    let expiredCount = 0;
    const verificationCounts = {
      verified: 0,
      forged: 0,
      unverifiable: 0,
      unchecked: 0
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
      providerVerificationCounts
    };
  }
  #compatibleGroupIds(account) {
    const providerIndex = this.#indexes[account.provider];
    const credentials = CREDENTIAL_KEYS.flatMap((key) => {
      const value = credentialValue(account, key);
      return value ? [{ key, value }] : [];
    });
    if (credentials.length === 0) return [];
    const matchingSets = [];
    let matchingSize = 0;
    let seedSets;
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
    const compatible = [];
    const visited = /* @__PURE__ */ new Set();
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
  #indexAccount(id, account) {
    for (const key of CREDENTIAL_KEYS) {
      const value = credentialValue(account, key);
      const index = this.#indexes[account.provider][key];
      if (value) addIndexValue(index.values, value, id);
      else index.missing.add(id);
    }
  }
  #indexNewCredentials(id, account, previous) {
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
  #removeFromIndexes(id, account) {
    for (const key of CREDENTIAL_KEYS) {
      const value = credentialValue(account, key);
      const index = this.#indexes[account.provider][key];
      if (value) removeIndexValue(index.values, value, id);
      else index.missing.delete(id);
    }
  }
  #deleteRecord(id) {
    const stored = this.#records.get(id);
    if (!stored) return false;
    this.#removeFromIndexes(id, stored.account);
    this.#records.delete(id);
    return true;
  }
};
function createProviderIndex() {
  return {
    accessToken: createCredentialIndex(),
    refreshToken: createCredentialIndex(),
    sessionToken: createCredentialIndex(),
    idToken: createCredentialIndex()
  };
}
function createCredentialIndex() {
  return { values: /* @__PURE__ */ new Map(), missing: /* @__PURE__ */ new Set() };
}
function createProviderVerificationCounts() {
  return {
    openai: { verified: 0, forged: 0, unverifiable: 0, unchecked: 0 },
    xai: { verified: 0, forged: 0, unverifiable: 0, unchecked: 0 },
    unknown: { verified: 0, forged: 0, unverifiable: 0, unchecked: 0 }
  };
}
function addIndexValue(index, value, id) {
  const ids = index.get(value);
  if (ids) {
    ids.add(id);
  } else {
    index.set(value, /* @__PURE__ */ new Set([id]));
  }
}
function removeIndexValue(index, value, id) {
  const ids = index.get(value);
  ids?.delete(id);
  if (ids?.size === 0) index.delete(value);
}
function credentialSnapshot(account) {
  return Object.fromEntries(
    CREDENTIAL_KEYS.flatMap((key) => {
      const value = credentialValue(account, key);
      return value ? [[key, value]] : [];
    })
  );
}
function credentialValue(account, key) {
  if (key === "idToken" && account.provider === "openai" && account.idTokenSynthetic) {
    return void 0;
  }
  const value = account[key];
  return typeof value === "string" && value !== "" ? value : void 0;
}
function hasCompatibleCredentials(left, right) {
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
function mergeMissingFields(target, source) {
  const targetHadIdToken = Boolean(target.idToken);
  mergeAccessCredentialUnit(target, source);
  const targetRecord = target;
  const sourceRecord = source;
  for (const key of Object.keys(sourceRecord)) {
    if (MERGE_IGNORED_KEYS.has(key)) {
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
function mergeAccessCredentialUnit(target, source) {
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
  if (target.accessToken && target.accessToken === source.accessToken && !target.tokenVerification) {
    if (source.tokenVerification && source.tokenVerificationContext) {
      target.tokenVerification = source.tokenVerification;
      target.tokenVerificationContext = source.tokenVerificationContext;
    } else {
      delete target.tokenVerification;
      delete target.tokenVerificationContext;
    }
    return;
  }
  if (!target.accessToken && !source.accessToken && !target.tokenVerification && source.tokenVerification && source.tokenVerificationContext) {
    target.tokenVerification = source.tokenVerification;
    target.tokenVerificationContext = source.tokenVerificationContext;
  }
}
function isMissingValue(value) {
  return value === void 0 || value === "";
}
function accountSearchText(account) {
  const openAi = account.provider === "openai" ? account : void 0;
  const xai = account.provider === "xai" ? account : void 0;
  return [
    account.email,
    account.name,
    openAi?.accountId,
    openAi?.chatgptAccountId,
    openAi?.chatgptUserId,
    openAi?.planType,
    account.userId,
    xai?.principalId,
    account.provider
  ].filter((value) => Boolean(value)).join("\n").toLocaleLowerCase();
}
function accountListItem(stored, index) {
  const account = stored.account;
  const openAi = account.provider === "openai" ? account : void 0;
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
    tokenVerification: account.tokenVerification
  };
}
function isExpired(expiresAt, now) {
  if (!expiresAt) {
    return false;
  }
  const value = new Date(expiresAt).getTime();
  return Number.isFinite(value) && value <= now;
}

// src/i18n.ts
var DEFAULT_LOCALE = "zh";
function normalizeLocale(value) {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) {
    return void 0;
  }
  if (normalized === "zh" || normalized === "zh-cn" || normalized.startsWith("zh_")) {
    return "zh";
  }
  if (normalized === "en" || normalized === "en-us" || normalized.startsWith("en_")) {
    return "en";
  }
  return void 0;
}
function detectCliLocale(explicit, env = process.env) {
  return normalizeLocale(explicit) ?? normalizeLocale(env.AUTHCONV_LANG) ?? normalizeLocale(env.LC_ALL) ?? normalizeLocale(env.LC_MESSAGES) ?? normalizeLocale(env.LANG) ?? DEFAULT_LOCALE;
}
var FORMAT_LABELS = {
  cpa: "CPA",
  sub2api: "sub2api",
  codex2api: "codex2api",
  codexmanager: "Codex Manager",
  codex: "Codex Auth",
  grok: "Grok CLI",
  grok2api: "Grok2API"
};
function plural(count, singular, pluralForm = `${singular}s`) {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}
var MESSAGES = {
  zh: {
    cli: {
      help: (version) => `authconv ${version}

\u7528\u6CD5:
  authconv input.json
  authconv input-a.json input-b.json input-dir -f cpa
  authconv input-dir -f sub2api
  authconv -i input-a.json -i input-b.json
  authconv --stdin -f cpa --stdout
  authconv input.json -f cpa,sub2api
  authconv input.json --format cpa --format codexmanager
  authconv input.json -f codex --stdout
  authconv input.json -f sub2api --stdout
  authconv input.json -f cpa --jsonl
  authconv --serve

\u53C2\u6570:
  <path...>              \u8F93\u5165\u51ED\u636E\u6587\u4EF6\u6216\u76EE\u5F55\u8DEF\u5F84\uFF0C\u6309\u5185\u5BB9\u8BC6\u522B\uFF0C\u53EF\u4F20\u591A\u4E2A
  -i, --input <path>     \u6307\u5B9A\u51ED\u636E\u6587\u4EF6\u6216\u76EE\u5F55\uFF0C\u6309\u5185\u5BB9\u8BC6\u522B\uFF08\u53EF\u91CD\u590D\uFF09
  --stdin                \u4ECE\u6807\u51C6\u8F93\u5165\u8BFB\u53D6\uFF08\u4E0E -i \u4E92\u65A5\uFF09
  -f, --format <list>    \u8F93\u51FA\u683C\u5F0F\uFF0C\u652F\u6301\u9017\u53F7\u5206\u9694\u6216\u91CD\u590D\u4F20\u5165\uFF1B\u53EF\u7528 cpa/sub2api/codex2api/codexmanager/codex/grok/grok2api/all
  --mode <fmt>=<m>       sub2api/codex2api \u8F93\u51FA\u65B9\u5F0F\uFF1Amerged \u6216 single
  -o, --out-dir <path>   \u8F93\u51FA\u76EE\u5F55\uFF0C\u9ED8\u8BA4 output
  --jsonl                \u8F93\u51FA JSONL \u683C\u5F0F\uFF08\u6BCF\u8D26\u53F7\u4E00\u884C\uFF09
  --zip                  \u5199\u5165\u4E00\u4E2A ZIP \u6587\u4EF6\uFF0C\u538B\u7F29\u5305\u5185\u4FDD\u7559\u5F53\u524D\u8F93\u51FA\u76EE\u5F55\u7ED3\u6784
  --stdout               \u5355\u683C\u5F0F\u5355\u6587\u4EF6\u8F93\u51FA\u5230 stdout
  --no-fake-id           \u8F93\u51FA\u4E0D\u5305\u542B\u5408\u6210 id_token\uFF08\u9ED8\u8BA4\u4F1A\u8F93\u51FA\uFF09
  --no-refresh-token     \u8F93\u51FA\u4E0D\u5305\u542B refresh_token\uFF08\u9ED8\u8BA4\u4F1A\u8F93\u51FA\uFF09
  --no-verify-token      \u4E0D\u9A8C\u8BC1 access token \u771F\u4F2A\uFF0C\u6309\u5B57\u6BB5\u76F4\u63A5\u8F6C\u6362
  --lang <zh|en>         \u4EBA\u7C7B\u53EF\u8BFB\u8F93\u51FA\u8BED\u8A00\uFF0C\u672A\u68C0\u6D4B\u5230\u65F6\u9ED8\u8BA4\u82F1\u6587
  --inspect              \u53EA\u6253\u5370\u8D26\u53F7\u6458\u8981\uFF0C\u4E0D\u4EA7\u51FA\u6587\u4EF6
  --dry-run              \u53EA\u6253\u5370\u5199\u5165\u8BA1\u5212\uFF0C\u4E0D\u5B9E\u9645\u5199\u76D8
  --force                \u5141\u8BB8\u8986\u76D6\u5DF2\u5B58\u5728\u7684\u76EE\u6807\u6587\u4EF6
  --serve                \u542F\u52A8\u672C\u5730 Web UI\uFF0C\u9ED8\u8BA4\u76D1\u542C 127.0.0.1:8787
  --listen <host:port>   Web UI \u76D1\u542C\u5730\u5740\uFF0C\u4EC5\u4E0E --serve \u4E00\u8D77\u4F7F\u7528
  --help                 \u663E\u793A\u5E2E\u52A9
  --version              \u663E\u793A\u7248\u672C
`,
      inputPathSource: "\u8F93\u5165\u8DEF\u5F84",
      errors: {
        noAccounts: "\u672A\u627E\u5230\u53EF\u8F6C\u6362\u8D26\u53F7",
        noApplicableFormats: "\u6240\u9009\u683C\u5F0F\u4E0D\u9002\u7528\u4E8E\u5DF2\u8BC6\u522B\u8D26\u53F7\uFF0C\u672A\u751F\u6210\u4EFB\u4F55\u6587\u4EF6",
        cwdMissing: "\u5F53\u524D\u76EE\u5F55\u4E0D\u5B58\u5728",
        unknownArg: (arg) => `\u672A\u77E5\u53C2\u6570: ${arg}`,
        missingInput: "\u672A\u6307\u5B9A\u8F93\u5165\uFF08\u9700\u8981 <path>\u3001-i \u6216 --stdin\uFF09",
        invalidModeSyntax: (value) => `--mode \u683C\u5F0F\u9519\u8BEF: ${value}\uFF08\u5E94\u4E3A format=merged|single\uFF09`,
        unknownOutputFormat: (format) => `\u672A\u77E5\u8F93\u51FA\u683C\u5F0F: ${format}`,
        unsupportedModeFormat: (format) => `--mode \u4EC5\u652F\u6301 sub2api \u6216 codex2api: ${format}`,
        unknownOutputMode: (mode2) => `--mode \u5305\u542B\u672A\u77E5\u8F93\u51FA\u65B9\u5F0F: ${mode2}`,
        stdinConflict: (source) => `${source} \u4E0E --stdin \u51B2\u7A81\uFF0C\u53EA\u80FD\u6307\u5B9A\u4E00\u4E2A\u8F93\u5165\u6765\u6E90`,
        stdinPathConflict: "--stdin \u4E0E\u5DF2\u6709\u8F93\u5165\u8DEF\u5F84\u51B2\u7A81\uFF0C\u53EA\u80FD\u6307\u5B9A\u4E00\u4E2A\u8F93\u5165\u6765\u6E90",
        missingFlagValue: (flag) => `${flag} \u7F3A\u5C11\u53C2\u6570\u503C`,
        noInputFiles: (inputPath) => `${inputPath}: \u672A\u627E\u5230\u8F93\u5165\u6587\u4EF6`,
        notFileOrDirectory: (inputPath) => `${inputPath}: \u4E0D\u662F\u6587\u4EF6\u6216\u76EE\u5F55`,
        stdoutSingleFile: "--stdout \u53EA\u652F\u6301\u5355\u683C\u5F0F\u8F93\u51FA\uFF0C\u4E14\u8BE5\u683C\u5F0F\u53EA\u80FD\u751F\u6210\u4E00\u4E2A\u6587\u4EF6",
        zipStdoutConflict: "--zip \u4E0E --stdout \u4E92\u65A5",
        inspectTargetConflict: "--inspect \u4E0E -o/--out-dir/--stdout/--zip \u4E92\u65A5",
        inspectDryRunConflict: "--inspect \u4E0E --dry-run \u4E92\u65A5",
        dryRunStdoutConflict: "--dry-run \u4E0E --stdout \u4E92\u65A5",
        invalidLang: (value) => `\u672A\u77E5\u8BED\u8A00: ${value}\uFF08\u53EF\u7528 zh/en\uFF09`,
        invalidListen: (value) => `\u76D1\u542C\u5730\u5740\u65E0\u6548: ${value}\uFF08\u5E94\u4E3A host:port\uFF09`,
        invalidPort: (value) => `\u7AEF\u53E3\u65E0\u6548: ${value}`,
        serveConflict: "--serve \u4E0D\u80FD\u548C\u8F93\u5165\u3001\u8F6C\u6362\u6216\u8F93\u51FA\u53C2\u6570\u4E00\u8D77\u4F7F\u7528",
        serveOptionWithoutServe: "--listen \u53EA\u80FD\u548C --serve \u4E00\u8D77\u4F7F\u7528",
        notFound: (target) => `${target}: \u4E0D\u5B58\u5728`,
        alreadyExists: (target) => `${target}: \u5DF2\u5B58\u5728\uFF0C\u4F7F\u7528 --force \u8986\u76D6`
      },
      serve: {
        started: (url) => `Web UI \u5DF2\u542F\u52A8: ${url}
\u6309 Ctrl+C \u9000\u51FA\u3002
`
      },
      summary: {
        human: (accountCount, fileCount, _formatCount, formats, outputRoot) => `\u8BC6\u522B ${accountCount} \u4E2A\u8D26\u53F7\uFF0C\u8F6C\u4E3A ${formats} \u683C\u5F0F\uFF0C\u5199\u5165 ${fileCount} \u4E2A\u6587\u4EF6${outputRoot ? `\u5230 ${outputRoot}` : ""}`,
        humanFile: (accountCount, _formatCount, formats, targetPath) => `\u8BC6\u522B ${accountCount} \u4E2A\u8D26\u53F7\uFF0C\u8F6C\u4E3A ${formats} \u683C\u5F0F\uFF0C\u5199\u5165 ${targetPath}`,
        inspectColumns: ["#", "\u90AE\u7BB1", "account_id", "\u5957\u9910", "\u8FC7\u671F"],
        unknownAccount: "unknown",
        missingValue: "\u2014",
        dryRun: (accountCount, fileCount, outputRoot) => `\u8BC6\u522B ${accountCount} \u4E2A\u8D26\u53F7\uFF0C\u5C06\u5199\u5165 ${fileCount} \u4E2A\u6587\u4EF6\u5230 ${outputRoot}`,
        fileLine: (filePath, accountCount) => `- ${filePath} (${accountCount} \u4E2A\u8D26\u53F7)`
      }
    },
    web: {
      pageTitle: "Auth Converter | OpenAI / Grok OAuth \u51ED\u8BC1\u8F6C\u6362\u5DE5\u5177",
      appTitle: "Auth Converter",
      notice: "\u7EAF\u672C\u5730\u5B89\u5168\u8F6C\u6362\uFF0C\u6240\u6709\u8FD0\u7B97\u5728\u5F53\u524D\u6D4F\u89C8\u5668\u4E2D\u5B8C\u6210\u3002",
      dragTitle: "\u91CA\u653E\u4EE5\u5BFC\u5165\u51ED\u636E\u6587\u4EF6",
      dragSub: "\u677E\u5F00\u6DFB\u52A0\u5230\u5217\u8868",
      themeLabel: "\u4E3B\u9898",
      themeAria: "\u5207\u6362\u548C\u9009\u62E9\u4E3B\u9898",
      themeSystem: "\u81EA\u52A8",
      themeLight: "\u6D45\u8272",
      themeDark: "\u6DF1\u8272",
      languageLabel: "\u8BED\u8A00",
      languageAria: "\u5207\u6362\u8BED\u8A00",
      inputTitle: "\u6570\u636E\u8F93\u5165",
      sessionButton: "\u83B7\u53D6 Session",
      addDraftButton: "\u52A0\u5165\u5217\u8868",
      clearButton: "\u6E05\u7A7A",
      inputAria: "JSON \u51ED\u636E\u8F93\u5165",
      inputPlaceholder: `\u7C98\u8D34 OpenAI / Grok OAuth JSON\u3001JSONL\uFF0C\u6216\u62D6\u5165\u591A\u8D26\u53F7\u5BFC\u51FA\u6587\u4EF6\u3002

\u793A\u4F8B\uFF1A
{
  "access_token": "sample-access-token",
  "refresh_token": "sample-refresh-token",
  "session_token": "sample-session-token",
  "email": "user@example.com",
  "chatgpt_account_id": "acct_example",
  "plan_type": "plus",
  "expires_at": "2026-07-03T01:00:00.000Z"
}`,
      inputFormatAria: "\u8F93\u5165\u683C\u5F0F",
      dropZoneAria: "\u9009\u62E9\u6216\u62D6\u653E\u51ED\u636E\u6587\u4EF6\u6216\u6587\u4EF6\u5939\uFF0C\u683C\u5F0F\u6309\u5185\u5BB9\u8BC6\u522B",
      dropTitle: "\u5BFC\u5165\u51ED\u636E\u6587\u4EF6",
      dropSub: "\u652F\u6301\u4EFB\u610F\u6269\u5C55\u540D\u548C\u6587\u4EF6\u5939\uFF0C\u6309\u5185\u5BB9\u8BC6\u522B",
      chooseFile: "\u9009\u62E9\u6587\u4EF6",
      chooseFolder: "\u9009\u62E9\u6587\u4EF6\u5939",
      outputTitle: "\u6570\u636E\u8F93\u51FA",
      downloadDefault: "\u5BFC\u51FA\u914D\u7F6E",
      outputSettingsAria: "\u8F93\u51FA\u8BBE\u7F6E",
      exportFormat: "\u5BFC\u51FA\u683C\u5F0F",
      selectAllFormatsAria: "\u5168\u9009\u5BFC\u51FA\u683C\u5F0F",
      outputOptions: "\u8F93\u51FA\u9009\u9879",
      jsonlFormat: "JSONL \u683C\u5F0F",
      fakeId: "\u5408\u6210 id_token",
      refreshToken: "\u5305\u542B refresh_token",
      verifyToken: "\u9A8C\u8BC1 token \u771F\u4F2A",
      accountTitle: "\u5DF2\u52A0\u8F7D\u8D26\u53F7",
      draftAccountTitle: "\u5F85\u52A0\u5165\u8D26\u53F7",
      clearAccounts: "\u6E05\u7A7A\u5217\u8868",
      accountColumns: ["\u8D26\u53F7\u6807\u8BC6 (Email / ID)", "\u5E73\u53F0 / \u5957\u9910", "\u8FC7\u671F\u65F6\u95F4", "\u64CD\u4F5C"],
      accountListAria: "\u8D26\u53F7\u5217\u8868",
      previewAria: "\u8F93\u51FA\u9884\u89C8",
      previewTabsAria: "\u9884\u89C8\u683C\u5F0F\u9009\u62E9",
      jwtHoverAria: "\u60AC\u505C\u6216\u805A\u7126\u4EE5\u9884\u89C8 JWT \u5185\u5BB9",
      copyPreview: "\u590D\u5236\u5F53\u524D\u9884\u89C8",
      copied: "\u2713 \u5DF2\u590D\u5236\u5230\u526A\u8D34\u677F",
      copyToast: "\u5DF2\u590D\u5236\u5230\u526A\u8D34\u677F",
      copyFailed: "\u590D\u5236\u5931\u8D25\uFF0C\u8BF7\u624B\u52A8\u9009\u62E9\u9884\u89C8\u5185\u5BB9\u590D\u5236",
      inputFormatAutoMixed: "\u81EA\u52A8\u8BC6\u522B\uFF1A\u9010\u4E2A\u68C0\u67E5",
      inputFormatAuto: (label) => `\u81EA\u52A8\u8BC6\u522B\uFF1A${label}`,
      inputInvalidFormat: (label) => `\u8F93\u5165\u4E0D\u7B26\u5408 ${label} \u683C\u5F0F\u3002`,
      jsonParseFailed: (error) => `JSON \u89E3\u6790\u5931\u8D25\uFF1A${error}`,
      noAccounts: "\u672A\u8BC6\u522B\u5230\u53EF\u8F6C\u6362\u8D26\u53F7\u3002",
      sourceName: (index) => `\u8F93\u5165 ${index}`,
      sourceImported: (processed, added, merged, skippedForged) => [
        `\u8BFB\u53D6 ${processed}`,
        `\u65B0\u589E ${added}`,
        merged > 0 ? `\u5408\u5E76 ${merged}` : "",
        skippedForged > 0 ? `\u8DF3\u8FC7\u4F2A\u9020 ${skippedForged}` : ""
      ].filter(Boolean).join(" \xB7 "),
      fileImported: (processed, added, merged, skippedForged) => [
        `\u8BFB\u53D6 ${processed}`,
        `\u65B0\u589E ${added}`,
        merged > 0 ? `\u5408\u5E76 ${merged}` : "",
        skippedForged > 0 ? `\u8DF3\u8FC7\u4F2A\u9020 ${skippedForged}` : ""
      ].filter(Boolean).join(" \xB7 "),
      chooseCredentialFiles: "\u8BF7\u9009\u62E9\u51ED\u636E\u6587\u4EF6\u3002",
      fileNoAccounts: (name) => `${name}: \u672A\u8BC6\u522B\u5230\u53EF\u8F6C\u6362\u8D26\u53F7\u3002`,
      fileInvalidInput: (name, error) => `${name}: ${error}`,
      fileJsonFailed: (name, error) => `JSON \u89E3\u6790\u5931\u8D25\uFF08${name}\uFF09\uFF1A${error}`,
      fileReadFailed: (error) => `\u6587\u4EF6\u8BFB\u53D6\u5931\u8D25\uFF1A${error}`,
      accountCount: (count) => `${count} \u4E2A\u8D26\u53F7`,
      formatCount: (count) => `${count} \u79CD\u683C\u5F0F`,
      exportAccounts: (count) => `\u5BFC\u51FA ${count} \u4E2A\u8D26\u53F7`,
      exportPreparing: "\u6B63\u5728\u6253\u5305...",
      exportAria: (count, jsonl, zip) => [
        `\u5BFC\u51FA ${count} \u4E2A\u8D26\u53F7`,
        jsonl ? "JSONL\uFF1A\u6BCF\u884C\u4E00\u4E2A\u8D26\u53F7\u3002" : "",
        zip ? "\u591A\u683C\u5F0F\u6216\u591A\u6587\u4EF6\u4F1A\u81EA\u52A8\u6253\u5305\u4E3A ZIP\u3002" : ""
      ].filter(Boolean).join(" "),
      previewNoFormat: "\u9009\u62E9\u5BFC\u51FA\u683C\u5F0F\u540E\u663E\u793A\u9884\u89C8\u3002",
      previewNoInput: "\u5BFC\u5165\u6216\u7C98\u8D34\u51ED\u636E\u540E\u663E\u793A\u9884\u89C8\u3002",
      accountLabelFallback: "\u672A\u8BC6\u522B\u8D26\u53F7",
      accountLabelPrefixDraft: (label) => `\u8349\u7A3F ${label}`,
      accountCellAccount: "\u8D26\u53F7",
      planType: "\u5957\u9910\u7C7B\u578B",
      expiresAt: "\u8FC7\u671F\u65F6\u95F4",
      unknown: "\u672A\u8BC6\u522B",
      action: "\u64CD\u4F5C",
      remove: "\u5220\u9664",
      removeAccount: (label) => `\u5220\u9664 ${label}`,
      jsonlTooltip: "JSONL\uFF1A\u884C\u5F0F JSON \u683C\u5F0F\uFF0C\u6BCF\u884C\u4E00\u4E2A\u8D26\u53F7\uFF08\u9002\u5408\u5355\u884C\u51ED\u636E\u5BFC\u5165\u7B49\u573A\u666F\uFF09\u3002",
      fakeIdTooltip: "\u5408\u6210 id_token\uFF1A\u9488\u5BF9\u7F3A\u5C11 id_token \u7684\u8D26\u53F7\u81EA\u52A8\u5408\u6210\u6A21\u62DF\u51ED\u636E\uFF0C\u4EE5\u517C\u5BB9 Codex Auth \u7B49\u4E0B\u6E38\u5DE5\u5177\u3002",
      refreshTokenTooltip: "\u53D6\u6D88\u540E\uFF0C\u6240\u6709\u8F93\u51FA\u90FD\u4F1A\u7701\u7565 refresh_token\uFF1B\u51ED\u8BC1\u8FC7\u671F\u540E\u5C06\u65E0\u6CD5\u81EA\u52A8\u7EED\u671F\u3002",
      verifyTokenTooltip: "\u4F7F\u7528\u5185\u7F6E OpenAI / xAI \u516C\u94A5\u79BB\u7EBF\u9A8C\u8BC1 access token\uFF1B\u6587\u4EF6\u5BFC\u5165\u4F1A\u8DF3\u8FC7\u4F2A\u9020\u8D26\u53F7\uFF0C\u7C98\u8D34\u8349\u7A3F\u4FDD\u7559\u4F2A\u9020\u6807\u8BB0\u5E76\u963B\u6B62\u8F93\u51FA\uFF1B\u4E0D\u53EF\u9A8C\u8BC1\u8D26\u53F7\u4FDD\u7559\u6807\u8BB0\u3002\u5173\u95ED\u540E\u6309\u5B57\u6BB5\u76F4\u63A5\u8F6C\u6362\u3002",
      codexTooltip: "Codex auth.json \u683C\u5F0F\uFF0C\u53EF\u5BFC\u5165 Codex CLI\u3001Cockpit \u548C AxonHub \u7B49\u517C\u5BB9\u8BE5\u683C\u5F0F\u7684\u9879\u76EE\u3002",
      modeSingle: "\u5355\u4E2A",
      modeMerged: "\u805A\u5408",
      modeSingleTip: "\u5355\u4E2A\uFF1A\u6BCF\u8D26\u53F7 1 \u4E2A\u6587\u4EF6\u3002",
      modeMergedTip: "\u805A\u5408\uFF1A1 \u4E2A\u6C47\u603B\u6587\u4EF6\u3002",
      nextModeLabel: (mode2) => mode2 === "single" ? "\u805A\u5408" : "\u5355\u4E2A",
      modeAria: (format, current, tip, next2) => `\u5207\u6362 ${format} \u5BFC\u51FA\u65B9\u5F0F\uFF0C\u5F53\u524D${current}\u3002${tip} \u70B9\u51FB\u5207\u6362\u4E3A${next2}`,
      exportZipToast: (name) => `\u5DF2\u5F00\u59CB\u5BFC\u51FA ${name}`,
      exportFileToast: "\u5DF2\u5F00\u59CB\u5BFC\u51FA\u6587\u4EF6"
    }
  },
  en: {
    cli: {
      help: (version) => `authconv ${version}

Usage:
  authconv input.json
  authconv input-a.json input-b.json input-dir -f cpa
  authconv input-dir -f sub2api
  authconv -i input-a.json -i input-b.json
  authconv --stdin -f cpa --stdout
  authconv input.json -f cpa,sub2api
  authconv input.json --format cpa --format codexmanager
  authconv input.json -f codex --stdout
  authconv input.json -f sub2api --stdout
  authconv input.json -f cpa --jsonl
  authconv --serve

Options:
  <path...>              Credential file or directory; detected by content; may repeat
  -i, --input <path>     Credential file or directory; detected by content; may repeat
  --stdin                Read from standard input; conflicts with paths
  -f, --format <list>    Output formats, comma-separated or repeated; cpa/sub2api/codex2api/codexmanager/codex/grok/grok2api/all
  --mode <fmt>=<m>       sub2api/codex2api output mode: merged or single
  -o, --out-dir <path>   Output directory, default output
  --jsonl                Output JSONL text, one JSON document per line
  --zip                  Write one ZIP file and keep the current output tree inside it
  --stdout               Write a single output file to stdout
  --no-fake-id           Omit synthetic id_token from output (included by default)
  --no-refresh-token     Omit refresh_token from output (included by default)
  --no-verify-token      Skip access token verification and convert fields directly
  --lang <zh|en>         Human-readable output language, default en when undetected
  --inspect              Print account summary only
  --dry-run              Print write plan without writing files
  --force                Overwrite existing output files
  --serve                Start local Web UI, default listen address 127.0.0.1:8787
  --listen <host:port>   Web UI listen address; only valid with --serve
  --help                 Show help
  --version              Show version
`,
      inputPathSource: "input path",
      errors: {
        noAccounts: "No convertible accounts found",
        noApplicableFormats: "The selected formats do not apply to the recognized accounts; no files were generated",
        cwdMissing: "Current directory no longer exists",
        unknownArg: (arg) => `Unknown argument: ${arg}`,
        missingInput: "No input specified; pass <path>, -i, or --stdin",
        invalidModeSyntax: (value) => `Invalid --mode: ${value} (expected format=merged|single)`,
        unknownOutputFormat: (format) => `Unknown output format: ${format}`,
        unsupportedModeFormat: (format) => `--mode only supports sub2api or codex2api: ${format}`,
        unknownOutputMode: (mode2) => `Unknown output mode in --mode: ${mode2}`,
        stdinConflict: (source) => `${source} conflicts with --stdin; choose one input source`,
        stdinPathConflict: "--stdin conflicts with input paths; choose one input source",
        missingFlagValue: (flag) => `${flag} requires a value`,
        noInputFiles: (inputPath) => `${inputPath}: no input files found`,
        notFileOrDirectory: (inputPath) => `${inputPath}: not a file or directory`,
        stdoutSingleFile: "--stdout only supports one format that produces one file",
        zipStdoutConflict: "--zip conflicts with --stdout",
        inspectTargetConflict: "--inspect conflicts with -o/--out-dir/--stdout/--zip",
        inspectDryRunConflict: "--inspect conflicts with --dry-run",
        dryRunStdoutConflict: "--dry-run conflicts with --stdout",
        invalidLang: (value) => `Unknown language: ${value} (use zh or en)`,
        invalidListen: (value) => `Invalid listen address: ${value} (expected host:port)`,
        invalidPort: (value) => `Invalid port: ${value}`,
        serveConflict: "--serve cannot be combined with input, conversion, or output options",
        serveOptionWithoutServe: "--listen can only be used with --serve",
        notFound: (target) => `${target}: not found`,
        alreadyExists: (target) => `${target}: already exists; use --force to overwrite`
      },
      serve: {
        started: (url) => `Web UI started: ${url}
Press Ctrl+C to stop.
`
      },
      summary: {
        human: (accountCount, fileCount, formatCount, formats, outputRoot) => `Found ${plural(accountCount, "account")}, converted to ${formats} ${formatCount === 1 ? "format" : "formats"}, wrote ${plural(fileCount, "file")}${outputRoot ? ` to ${outputRoot}` : ""}`,
        humanFile: (accountCount, formatCount, formats, targetPath) => `Found ${plural(accountCount, "account")}, converted to ${formats} ${formatCount === 1 ? "format" : "formats"}, wrote ${targetPath}`,
        inspectColumns: ["#", "email", "account_id", "plan", "expires"],
        unknownAccount: "unknown",
        missingValue: "-",
        dryRun: (accountCount, fileCount, outputRoot) => `Found ${plural(accountCount, "account")}, would write ${plural(fileCount, "file")} to ${outputRoot}`,
        fileLine: (filePath, accountCount) => `- ${filePath} (${plural(accountCount, "account")})`
      }
    },
    web: {
      pageTitle: "Auth Converter | Local OpenAI / Grok OAuth credential converter",
      appTitle: "Auth Converter",
      notice: "Local-only conversion. Everything runs in this browser.",
      dragTitle: "Drop to import credential files",
      dragSub: "Release to add to the list",
      themeLabel: "Theme",
      themeAria: "Switch and choose theme",
      themeSystem: "Auto",
      themeLight: "Light",
      themeDark: "Dark",
      languageLabel: "Language",
      languageAria: "Switch language",
      inputTitle: "Input",
      sessionButton: "Get Session",
      addDraftButton: "Add to List",
      clearButton: "Clear",
      inputAria: "JSON credential input",
      inputPlaceholder: `Paste OpenAI / Grok OAuth JSON, JSONL text, or drop multi-account exports below...

Example:
{
  "access_token": "sample-access-token",
  "refresh_token": "sample-refresh-token",
  "session_token": "sample-session-token",
  "email": "user@example.com",
  "name": "Example User",
  "chatgpt_account_id": "acct_example",
  "chatgpt_user_id": "user_example",
  "plan_type": "plus",
  "last_refresh": "2026-07-03T00:00:00.000Z",
  "expires_at": "2026-07-03T01:00:00.000Z"
}`,
      inputFormatAria: "Input format",
      dropZoneAria: "Choose or drop credential files or folders; formats are detected by content",
      dropTitle: "Choose or drop credential files",
      dropSub: "Any extension or folder; detected by content",
      chooseFile: "Choose File",
      chooseFolder: "Choose Folder",
      outputTitle: "Output",
      downloadDefault: "Export",
      outputSettingsAria: "Output settings",
      exportFormat: "Export Formats",
      selectAllFormatsAria: "Select all output formats",
      outputOptions: "Options",
      jsonlFormat: "JSONL Format",
      fakeId: "Synthetic id_token",
      refreshToken: "Include refresh_token",
      verifyToken: "Verify token authenticity",
      accountTitle: "Loaded Accounts",
      draftAccountTitle: "Draft accounts",
      clearAccounts: "Clear List",
      accountColumns: ["Account (Email / ID)", "Platform / Plan", "Expires At", "Action"],
      accountListAria: "Account list",
      previewAria: "Output preview",
      previewTabsAria: "Preview format selection",
      jwtHoverAria: "Hover or focus to preview JWT contents",
      copyPreview: "Copy Preview",
      copied: "\u2713 Copied",
      copyToast: "Copied to clipboard",
      copyFailed: "Copy failed. Select and copy the preview manually.",
      inputFormatAutoMixed: "Auto detect: inspect each document",
      inputFormatAuto: (label) => `Auto detect: ${label}`,
      inputInvalidFormat: (label) => `Input is not ${label}.`,
      jsonParseFailed: (error) => `JSON parse failed: ${error}`,
      noAccounts: "No convertible accounts found.",
      sourceName: (index) => `Input ${index}`,
      sourceImported: (processed, added, merged, skippedForged) => [
        `Read ${processed}`,
        `Added ${added}`,
        merged > 0 ? `Merged ${merged}` : "",
        skippedForged > 0 ? `Skipped forged ${skippedForged}` : ""
      ].filter(Boolean).join(" \xB7 "),
      fileImported: (processed, added, merged, skippedForged) => [
        `Read ${processed}`,
        `Added ${added}`,
        merged > 0 ? `Merged ${merged}` : "",
        skippedForged > 0 ? `Skipped forged ${skippedForged}` : ""
      ].filter(Boolean).join(" \xB7 "),
      chooseCredentialFiles: "Choose credential files.",
      fileNoAccounts: (name) => `${name}: no convertible accounts found.`,
      fileInvalidInput: (name, error) => `${name}: ${error}`,
      fileJsonFailed: (name, error) => `JSON parse failed (${name}): ${error}`,
      fileReadFailed: (error) => `File read failed: ${error}`,
      accountCount: (count) => `${count} account(s)`,
      formatCount: (count) => `${count} formats`,
      exportAccounts: (count) => `Export ${count} account(s)`,
      exportPreparing: "Packaging...",
      exportAria: (count, jsonl, zip) => [
        `Export ${count} account(s)`,
        jsonl ? "JSONL: one account per line." : "",
        zip ? "Multiple formats or files will be packed as ZIP." : ""
      ].filter(Boolean).join(" "),
      previewNoFormat: "Select an output format to preview.",
      previewNoInput: "Import or paste credentials to preview.",
      accountLabelFallback: "Unknown account",
      accountLabelPrefixDraft: (label) => `Draft ${label}`,
      accountCellAccount: "Account",
      planType: "Plan",
      expiresAt: "Expires",
      unknown: "Unknown",
      action: "Action",
      remove: "Remove",
      removeAccount: (label) => `Remove ${label}`,
      jsonlTooltip: "JSONL: Line-by-line JSON format, one account per line (suitable for single-line credential imports).",
      fakeIdTooltip: "Synthetic id_token: Automatically generate a simulated token when missing, for compatibility with downstream tools like Codex Auth.",
      refreshTokenTooltip: "When disabled, every output omits refresh_token and credentials cannot refresh automatically after expiry.",
      verifyTokenTooltip: "Verify access tokens offline with the bundled OpenAI / xAI public keys. File imports skip forged accounts; pasted drafts remain marked as forged and are blocked from output. Unverifiable accounts remain marked. Disable for field-only conversion.",
      codexTooltip: "Codex auth.json format; importable by Codex CLI, Cockpit, AxonHub, and other compatible tools.",
      modeSingle: "Single",
      modeMerged: "Merged",
      modeSingleTip: "Single: one file per account.",
      modeMergedTip: "Merged: one combined file.",
      nextModeLabel: (mode2) => mode2 === "single" ? "Merged" : "Single",
      modeAria: (format, current, tip, next2) => `Switch ${format} output mode. Current: ${current}. ${tip} Click to switch to ${next2}.`,
      exportZipToast: (name) => `Started exporting ${name}`,
      exportFileToast: "Started exporting file"
    }
  }
};
function messagesFor(locale) {
  return MESSAGES[locale];
}

// node_modules/fflate/esm/index.mjs
import { createRequire } from "module";
var require2 = createRequire("/");
var Worker2;
try {
  Worker2 = require2("worker_threads").Worker;
} catch (e) {
}
var u8 = Uint8Array;
var u16 = Uint16Array;
var i32 = Int32Array;
var fleb = new u8([
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  1,
  1,
  1,
  1,
  2,
  2,
  2,
  2,
  3,
  3,
  3,
  3,
  4,
  4,
  4,
  4,
  5,
  5,
  5,
  5,
  0,
  /* unused */
  0,
  0,
  /* impossible */
  0
]);
var fdeb = new u8([
  0,
  0,
  0,
  0,
  1,
  1,
  2,
  2,
  3,
  3,
  4,
  4,
  5,
  5,
  6,
  6,
  7,
  7,
  8,
  8,
  9,
  9,
  10,
  10,
  11,
  11,
  12,
  12,
  13,
  13,
  /* unused */
  0,
  0
]);
var clim = new u8([16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15]);
var freb = function(eb, start) {
  var b = new u16(31);
  for (var i = 0; i < 31; ++i) {
    b[i] = start += 1 << eb[i - 1];
  }
  var r = new i32(b[30]);
  for (var i = 1; i < 30; ++i) {
    for (var j = b[i]; j < b[i + 1]; ++j) {
      r[j] = j - b[i] << 5 | i;
    }
  }
  return { b, r };
};
var _a = freb(fleb, 2);
var fl = _a.b;
var revfl = _a.r;
fl[28] = 258, revfl[258] = 28;
var _b = freb(fdeb, 0);
var fd = _b.b;
var revfd = _b.r;
var rev = new u16(32768);
for (i = 0; i < 32768; ++i) {
  x = (i & 43690) >> 1 | (i & 21845) << 1;
  x = (x & 52428) >> 2 | (x & 13107) << 2;
  x = (x & 61680) >> 4 | (x & 3855) << 4;
  rev[i] = ((x & 65280) >> 8 | (x & 255) << 8) >> 1;
}
var x;
var i;
var hMap = (function(cd, mb, r) {
  var s = cd.length;
  var i = 0;
  var l = new u16(mb);
  for (; i < s; ++i) {
    if (cd[i])
      ++l[cd[i] - 1];
  }
  var le = new u16(mb);
  for (i = 1; i < mb; ++i) {
    le[i] = le[i - 1] + l[i - 1] << 1;
  }
  var co;
  if (r) {
    co = new u16(1 << mb);
    var rvb = 15 - mb;
    for (i = 0; i < s; ++i) {
      if (cd[i]) {
        var sv = i << 4 | cd[i];
        var r_1 = mb - cd[i];
        var v = le[cd[i] - 1]++ << r_1;
        for (var m = v | (1 << r_1) - 1; v <= m; ++v) {
          co[rev[v] >> rvb] = sv;
        }
      }
    }
  } else {
    co = new u16(s);
    for (i = 0; i < s; ++i) {
      if (cd[i]) {
        co[i] = rev[le[cd[i] - 1]++] >> 15 - cd[i];
      }
    }
  }
  return co;
});
var flt = new u8(288);
for (i = 0; i < 144; ++i)
  flt[i] = 8;
var i;
for (i = 144; i < 256; ++i)
  flt[i] = 9;
var i;
for (i = 256; i < 280; ++i)
  flt[i] = 7;
var i;
for (i = 280; i < 288; ++i)
  flt[i] = 8;
var i;
var fdt = new u8(32);
for (i = 0; i < 32; ++i)
  fdt[i] = 5;
var i;
var flrm = /* @__PURE__ */ hMap(flt, 9, 1);
var fdrm = /* @__PURE__ */ hMap(fdt, 5, 1);
var max = function(a) {
  var m = a[0];
  for (var i = 1; i < a.length; ++i) {
    if (a[i] > m)
      m = a[i];
  }
  return m;
};
var bits = function(d, p, m) {
  var o = p / 8 | 0;
  return (d[o] | d[o + 1] << 8) >> (p & 7) & m;
};
var bits16 = function(d, p) {
  var o = p / 8 | 0;
  return (d[o] | d[o + 1] << 8 | d[o + 2] << 16) >> (p & 7);
};
var shft = function(p) {
  return (p + 7) / 8 | 0;
};
var slc = function(v, s, e) {
  if (s == null || s < 0)
    s = 0;
  if (e == null || e > v.length)
    e = v.length;
  return new u8(v.subarray(s, e));
};
var ec = [
  "unexpected EOF",
  "invalid block type",
  "invalid length/literal",
  "invalid distance",
  "stream finished",
  "no stream handler",
  ,
  "no callback",
  "invalid UTF-8 data",
  "extra field too long",
  "date not in range 1980-2099",
  "filename too long",
  "stream finishing",
  "invalid zip data"
  // determined by unknown compression method
];
var err = function(ind, msg, nt) {
  var e = new Error(msg || ec[ind]);
  e.code = ind;
  if (Error.captureStackTrace)
    Error.captureStackTrace(e, err);
  if (!nt)
    throw e;
  return e;
};
var inflt = function(dat, st, buf, dict) {
  var sl = dat.length, dl = dict ? dict.length : 0;
  if (!sl || st.f && !st.l)
    return buf || new u8(0);
  var noBuf = !buf;
  var resize = noBuf || st.i != 2;
  var noSt = st.i;
  if (noBuf)
    buf = new u8(sl * 3);
  var cbuf = function(l2) {
    var bl = buf.length;
    if (l2 > bl) {
      var nbuf = new u8(Math.max(bl * 2, l2));
      nbuf.set(buf);
      buf = nbuf;
    }
  };
  var final3 = st.f || 0, pos = st.p || 0, bt = st.b || 0, lm = st.l, dm = st.d, lbt = st.m, dbt = st.n;
  var tbts = sl * 8;
  do {
    if (!lm) {
      final3 = bits(dat, pos, 1);
      var type = bits(dat, pos + 1, 3);
      pos += 3;
      if (!type) {
        var s = shft(pos) + 4, l = dat[s - 4] | dat[s - 3] << 8, t = s + l;
        if (t > sl) {
          if (noSt)
            err(0);
          break;
        }
        if (resize)
          cbuf(bt + l);
        buf.set(dat.subarray(s, t), bt);
        st.b = bt += l, st.p = pos = t * 8, st.f = final3;
        continue;
      } else if (type == 1)
        lm = flrm, dm = fdrm, lbt = 9, dbt = 5;
      else if (type == 2) {
        var hLit = bits(dat, pos, 31) + 257, hcLen = bits(dat, pos + 10, 15) + 4;
        var tl = hLit + bits(dat, pos + 5, 31) + 1;
        pos += 14;
        var ldt = new u8(tl);
        var clt = new u8(19);
        for (var i = 0; i < hcLen; ++i) {
          clt[clim[i]] = bits(dat, pos + i * 3, 7);
        }
        pos += hcLen * 3;
        var clb = max(clt), clbmsk = (1 << clb) - 1;
        var clm = hMap(clt, clb, 1);
        for (var i = 0; i < tl; ) {
          var r = clm[bits(dat, pos, clbmsk)];
          pos += r & 15;
          var s = r >> 4;
          if (s < 16) {
            ldt[i++] = s;
          } else {
            var c = 0, n = 0;
            if (s == 16)
              n = 3 + bits(dat, pos, 3), pos += 2, c = ldt[i - 1];
            else if (s == 17)
              n = 3 + bits(dat, pos, 7), pos += 3;
            else if (s == 18)
              n = 11 + bits(dat, pos, 127), pos += 7;
            while (n--)
              ldt[i++] = c;
          }
        }
        var lt = ldt.subarray(0, hLit), dt = ldt.subarray(hLit);
        lbt = max(lt);
        dbt = max(dt);
        lm = hMap(lt, lbt, 1);
        dm = hMap(dt, dbt, 1);
      } else
        err(1);
      if (pos > tbts) {
        if (noSt)
          err(0);
        break;
      }
    }
    if (resize)
      cbuf(bt + 131072);
    var lms = (1 << lbt) - 1, dms = (1 << dbt) - 1;
    var lpos = pos;
    for (; ; lpos = pos) {
      var c = lm[bits16(dat, pos) & lms], sym = c >> 4;
      pos += c & 15;
      if (pos > tbts) {
        if (noSt)
          err(0);
        break;
      }
      if (!c)
        err(2);
      if (sym < 256)
        buf[bt++] = sym;
      else if (sym == 256) {
        lpos = pos, lm = null;
        break;
      } else {
        var add = sym - 254;
        if (sym > 264) {
          var i = sym - 257, b = fleb[i];
          add = bits(dat, pos, (1 << b) - 1) + fl[i];
          pos += b;
        }
        var d = dm[bits16(dat, pos) & dms], dsym = d >> 4;
        if (!d)
          err(3);
        pos += d & 15;
        var dt = fd[dsym];
        if (dsym > 3) {
          var b = fdeb[dsym];
          dt += bits16(dat, pos) & (1 << b) - 1, pos += b;
        }
        if (pos > tbts) {
          if (noSt)
            err(0);
          break;
        }
        if (resize)
          cbuf(bt + 131072);
        var end = bt + add;
        if (bt < dt) {
          var shift = dl - dt, dend = Math.min(dt, end);
          if (shift + bt < 0)
            err(3);
          for (; bt < dend; ++bt)
            buf[bt] = dict[shift + bt];
        }
        for (; bt < end; ++bt)
          buf[bt] = buf[bt - dt];
      }
    }
    st.l = lm, st.p = lpos, st.b = bt, st.f = final3;
    if (lm)
      final3 = 1, st.m = lbt, st.d = dm, st.n = dbt;
  } while (!final3);
  return bt != buf.length && noBuf ? slc(buf, 0, bt) : buf.subarray(0, bt);
};
var et = /* @__PURE__ */ new u8(0);
var b2 = function(d, b) {
  return d[b] | d[b + 1] << 8;
};
var b4 = function(d, b) {
  return (d[b] | d[b + 1] << 8 | d[b + 2] << 16 | d[b + 3] << 24) >>> 0;
};
var b8 = function(d, b) {
  return b4(d, b) + b4(d, b + 4) * 4294967296;
};
var Inflate = /* @__PURE__ */ (function() {
  function Inflate2(opts, cb) {
    if (typeof opts == "function")
      cb = opts, opts = {};
    this.ondata = cb;
    var dict = opts && opts.dictionary && opts.dictionary.subarray(-32768);
    this.s = { i: 0, b: dict ? dict.length : 0 };
    this.o = new u8(32768);
    this.p = new u8(0);
    if (dict)
      this.o.set(dict);
  }
  Inflate2.prototype.e = function(c) {
    if (!this.ondata)
      err(5);
    if (this.d)
      err(4);
    if (!this.p.length)
      this.p = c;
    else if (c.length) {
      var n = new u8(this.p.length + c.length);
      n.set(this.p), n.set(c, this.p.length), this.p = n;
    }
  };
  Inflate2.prototype.c = function(final3) {
    this.s.i = +(this.d = final3 || false);
    var bts = this.s.b;
    var dt = inflt(this.p, this.s, this.o);
    this.ondata(slc(dt, bts, this.s.b), this.d);
    this.o = slc(dt, this.s.b - 32768), this.s.b = this.o.length;
    this.p = slc(this.p, this.s.p / 8 | 0), this.s.p &= 7;
  };
  Inflate2.prototype.push = function(chunk, final3) {
    this.e(chunk), this.c(final3);
  };
  return Inflate2;
})();
var td = typeof TextDecoder != "undefined" && /* @__PURE__ */ new TextDecoder();
var tds = 0;
try {
  td.decode(et, { stream: true });
  tds = 1;
} catch (e) {
}
var dutf8 = function(d) {
  for (var r = "", i = 0; ; ) {
    var c = d[i++];
    var eb = (c > 127) + (c > 223) + (c > 239);
    if (i + eb > d.length)
      return { s: r, r: slc(d, i - 1) };
    if (!eb)
      r += String.fromCharCode(c);
    else if (eb == 3) {
      c = ((c & 15) << 18 | (d[i++] & 63) << 12 | (d[i++] & 63) << 6 | d[i++] & 63) - 65536, r += String.fromCharCode(55296 | c >> 10, 56320 | c & 1023);
    } else if (eb & 1)
      r += String.fromCharCode((c & 31) << 6 | d[i++] & 63);
    else
      r += String.fromCharCode((c & 15) << 12 | (d[i++] & 63) << 6 | d[i++] & 63);
  }
};
function strFromU8(dat, latin1) {
  if (latin1) {
    var r = "";
    for (var i = 0; i < dat.length; i += 16384)
      r += String.fromCharCode.apply(null, dat.subarray(i, i + 16384));
    return r;
  } else if (td) {
    return td.decode(dat);
  } else {
    var _a2 = dutf8(dat), s = _a2.s, r = _a2.r;
    if (r.length)
      err(8);
    return s;
  }
}
var z64e = function(d, b) {
  for (; b2(d, b) != 1; b += 4 + b2(d, b + 2))
    ;
  return [b8(d, b + 12), b8(d, b + 4), b8(d, b + 20)];
};
var UnzipPassThrough = /* @__PURE__ */ (function() {
  function UnzipPassThrough2() {
  }
  UnzipPassThrough2.prototype.push = function(data, final3) {
    this.ondata(null, data, final3);
  };
  UnzipPassThrough2.compression = 0;
  return UnzipPassThrough2;
})();
var UnzipInflate = /* @__PURE__ */ (function() {
  function UnzipInflate2() {
    var _this = this;
    this.i = new Inflate(function(dat, final3) {
      _this.ondata(null, dat, final3);
    });
  }
  UnzipInflate2.prototype.push = function(data, final3) {
    try {
      this.i.push(data, final3);
    } catch (e) {
      this.ondata(e, null, final3);
    }
  };
  UnzipInflate2.compression = 8;
  return UnzipInflate2;
})();
var Unzip = /* @__PURE__ */ (function() {
  function Unzip2(cb) {
    this.onfile = cb;
    this.k = [];
    this.o = {
      0: UnzipPassThrough
    };
    this.p = et;
  }
  Unzip2.prototype.push = function(chunk, final3) {
    var _this = this;
    if (!this.onfile)
      err(5);
    if (!this.p)
      err(4);
    if (this.c > 0) {
      var len = Math.min(this.c, chunk.length);
      var toAdd = chunk.subarray(0, len);
      this.c -= len;
      if (this.d)
        this.d.push(toAdd, !this.c);
      else
        this.k[0].push(toAdd);
      chunk = chunk.subarray(len);
      if (chunk.length)
        return this.push(chunk, final3);
    } else {
      var f = 0, i = 0, is = void 0, buf = void 0;
      if (!this.p.length)
        buf = chunk;
      else if (!chunk.length)
        buf = this.p;
      else {
        buf = new u8(this.p.length + chunk.length);
        buf.set(this.p), buf.set(chunk, this.p.length);
      }
      var l = buf.length, oc = this.c, add = oc && this.d;
      var _loop_2 = function() {
        var _a2;
        var sig = b4(buf, i);
        if (sig == 67324752) {
          f = 1, is = i;
          this_1.d = null;
          this_1.c = 0;
          var bf = b2(buf, i + 6), cmp_1 = b2(buf, i + 8), u = bf & 2048, dd = bf & 8, fnl = b2(buf, i + 26), es = b2(buf, i + 28);
          if (l > i + 30 + fnl + es) {
            var chks_3 = [];
            this_1.k.unshift(chks_3);
            f = 2;
            var sc_1 = b4(buf, i + 18), su_1 = b4(buf, i + 22);
            var fn_1 = strFromU8(buf.subarray(i + 30, i += 30 + fnl), !u);
            if (sc_1 == 4294967295) {
              _a2 = dd ? [-2] : z64e(buf, i), sc_1 = _a2[0], su_1 = _a2[1];
            } else if (dd)
              sc_1 = -1;
            i += es;
            this_1.c = sc_1;
            var d_1;
            var file_1 = {
              name: fn_1,
              compression: cmp_1,
              start: function() {
                if (!file_1.ondata)
                  err(5);
                if (!sc_1)
                  file_1.ondata(null, et, true);
                else {
                  var ctr = _this.o[cmp_1];
                  if (!ctr)
                    file_1.ondata(err(14, "unknown compression type " + cmp_1, 1), null, false);
                  d_1 = sc_1 < 0 ? new ctr(fn_1) : new ctr(fn_1, sc_1, su_1);
                  d_1.ondata = function(err2, dat3, final4) {
                    file_1.ondata(err2, dat3, final4);
                  };
                  for (var _i = 0, chks_4 = chks_3; _i < chks_4.length; _i++) {
                    var dat2 = chks_4[_i];
                    d_1.push(dat2, false);
                  }
                  if (_this.k[0] == chks_3 && _this.c)
                    _this.d = d_1;
                  else
                    d_1.push(et, true);
                }
              },
              terminate: function() {
                if (d_1 && d_1.terminate)
                  d_1.terminate();
              }
            };
            if (sc_1 >= 0)
              file_1.size = sc_1, file_1.originalSize = su_1;
            this_1.onfile(file_1);
          }
          return "break";
        } else if (oc) {
          if (sig == 134695760) {
            is = i += 12 + (oc == -2 && 8), f = 3, this_1.c = 0;
            return "break";
          } else if (sig == 33639248) {
            is = i -= 4, f = 3, this_1.c = 0;
            return "break";
          }
        }
      };
      var this_1 = this;
      for (; i < l - 4; ++i) {
        var state_1 = _loop_2();
        if (state_1 === "break")
          break;
      }
      this.p = et;
      if (oc < 0) {
        var dat = f ? buf.subarray(0, is - 12 - (oc == -2 && 8) - (b4(buf, is - 16) == 134695760 && 4)) : buf.subarray(0, i);
        if (add)
          add.push(dat, !!f);
        else
          this.k[+(f == 2)].push(dat);
      }
      if (f & 2)
        return this.push(buf.subarray(i), final3);
      this.p = buf.subarray(i);
    }
    if (final3) {
      if (this.c)
        err(13);
      this.p = null;
    }
  };
  Unzip2.prototype.register = function(decoder) {
    this.o[decoder.compression] = decoder;
  };
  return Unzip2;
})();

// node_modules/stream-chain/src/defs.js
var defs_exports = {};
__export(defs_exports, {
  Stop: () => Stop,
  clearFunctionList: () => clearFunctionList,
  combineMany: () => combineMany,
  combineManyMut: () => combineManyMut,
  fListSymbol: () => fListSymbol,
  final: () => final,
  finalSymbol: () => finalSymbol,
  finalValue: () => finalValue,
  flushSymbol: () => flushSymbol,
  flushable: () => flushable,
  getFinalValue: () => getFinalValue,
  getFunctionList: () => getFunctionList,
  getManyValues: () => getManyValues,
  isDuplexNodeStream: () => isDuplexNodeStream,
  isDuplexWebStream: () => isDuplexWebStream,
  isFinalValue: () => isFinalValue,
  isFlushable: () => isFlushable,
  isFunctionList: () => isFunctionList,
  isMany: () => isMany,
  isReadableNodeStream: () => isReadableNodeStream,
  isReadableWebStream: () => isReadableWebStream,
  isWritableNodeStream: () => isWritableNodeStream,
  isWritableWebStream: () => isWritableWebStream,
  many: () => many,
  manySymbol: () => manySymbol,
  none: () => none,
  normalizeMany: () => normalizeMany,
  setFunctionList: () => setFunctionList,
  stop: () => stop,
  toMany: () => toMany
});
var none = Symbol.for("object-stream.none");
var stop = Symbol.for("object-stream.stop");
var finalSymbol = Symbol.for("object-stream.final");
var manySymbol = Symbol.for("object-stream.many");
var flushSymbol = Symbol.for("object-stream.flush");
var fListSymbol = Symbol.for("object-stream.fList");
var finalValue = (value) => ({ [finalSymbol]: 1, value });
var many = (values) => ({ [manySymbol]: 1, values });
var isFinalValue = (o) => o && o[finalSymbol] === 1;
var isMany = (o) => o && o[manySymbol] === 1;
var isFlushable = (o) => o && o[flushSymbol] === 1;
var isFunctionList = (o) => o && o[fListSymbol] === 1;
var getFinalValue = (o) => o.value;
var getManyValues = (o) => o.values;
var getFunctionList = (o) => o.fList;
var flushable = (write2, final3 = null) => {
  const fn = final3 ? (value) => value === none ? final3() : write2(value) : write2;
  fn[flushSymbol] = 1;
  return fn;
};
var setFunctionList = (o, fns) => {
  o.fList = fns;
  o[fListSymbol] = 1;
  return o;
};
var clearFunctionList = (o) => {
  delete o.fList;
  delete o[fListSymbol];
  return o;
};
var Stop = class extends Error {
};
var toMany = (value) => value === none ? many([]) : value && value[manySymbol] === 1 ? value : many([value]);
var normalizeMany = (o) => {
  if (o?.[manySymbol] === 1) {
    switch (o.values.length) {
      case 0:
        return none;
      case 1:
        return o.values[0];
    }
  }
  return o;
};
var combineMany = (...args) => {
  const values = [];
  for (let i = 0; i < args.length; ++i) {
    const a = args[i];
    if (a === none) continue;
    if (a?.[manySymbol] === 1) {
      values.push(...a.values);
    } else {
      values.push(a);
    }
  }
  return many(values);
};
var combineManyMut = (a, ...args) => {
  const values = a === none ? [] : a?.[manySymbol] === 1 ? a.values : [a];
  for (let i = 0; i < args.length; ++i) {
    const b = args[i];
    if (b === none) continue;
    if (b?.[manySymbol] === 1) {
      values.push(...b.values);
    } else {
      values.push(b);
    }
  }
  return many(values);
};
var isReadableWebStream = (x) => !!(x && typeof x === "object" && typeof x.getReader === "function" && typeof x.pipeTo === "function");
var isWritableWebStream = (x) => !!(x && typeof x === "object" && typeof x.getWriter === "function" && typeof x.abort === "function");
var isDuplexWebStream = (x) => !!(x && typeof x === "object" && isReadableWebStream(x.readable) && isWritableWebStream(x.writable));
var isReadableNodeStream = (obj) => obj && typeof obj.pipe === "function" && typeof obj.on === "function" && (!obj._writableState || (typeof obj._readableState === "object" ? obj._readableState.readable : null) !== false) && (!obj._writableState || obj._readableState);
var isWritableNodeStream = (obj) => obj && typeof obj.write === "function" && typeof obj.on === "function" && (!obj._readableState || (typeof obj._writableState === "object" ? obj._writableState.writable : null) !== false);
var isDuplexNodeStream = (obj) => obj && typeof obj.pipe === "function" && obj._readableState && typeof obj.on === "function" && typeof obj.write === "function";
var final = finalValue;

// node_modules/stream-chain/src/exec.js
var next = (value, fns, index, push) => {
  for (let i = index; ; ) {
    if (value && typeof value.then == "function") {
      const ii = i;
      return value.then((v) => next(v, fns, ii, push));
    }
    if (value == null || value === none) return;
    if (value === stop) throw new Stop();
    if (isFinalValue(value)) {
      return push(getFinalValue(value));
    }
    if (isMany(value)) {
      return nextMany(getManyValues(value), fns, i, push);
    }
    if (value && typeof value.next == "function") {
      return nextGen(value, fns, i, push);
    }
    if (i >= fns.length) {
      return push(value);
    }
    value = fns[i++](value);
  }
};
var nextMany = (values, fns, i, push) => {
  const step = (j) => {
    for (; j < values.length; ++j) {
      const r = next(values[j], fns, i, push);
      if (r && typeof r.then == "function") {
        const jj = j;
        return r.then(() => step(jj + 1));
      }
    }
  };
  return step(0);
};
var nextGen = (it, fns, i, push) => {
  const step = () => {
    for (; ; ) {
      let data = it.next();
      if (data && typeof data.then == "function") {
        return data.then((d) => {
          if (d.done) return;
          const r3 = next(d.value, fns, i, push);
          return r3 && typeof r3.then == "function" ? r3.then(step) : step();
        });
      }
      if (data.done) return;
      const r2 = next(data.value, fns, i, push);
      if (r2 && typeof r2.then == "function") return r2.then(step);
    }
  };
  const abort2 = (err2) => {
    const onCleanupError = (cleanupErr) => err2 instanceof Error ? new AggregateError([err2, cleanupErr], "pipeline error; generator cleanup also failed") : err2;
    let ret;
    try {
      ret = it.return ? it.return() : void 0;
    } catch (cleanupErr) {
      throw onCleanupError(cleanupErr);
    }
    if (ret && typeof ret.then == "function") {
      return ret.then(
        () => {
          throw err2;
        },
        (cleanupErr) => {
          throw onCleanupError(cleanupErr);
        }
      );
    }
    throw err2;
  };
  let r;
  try {
    r = step();
  } catch (err2) {
    return abort2(err2);
  }
  return r && typeof r.then == "function" ? r.then(void 0, abort2) : r;
};
var flush = (fns, index, push) => {
  const step = (i) => {
    for (; i < fns.length; ++i) {
      const f = fns[i];
      if (!isFlushable(f)) continue;
      const r = next(f(none), fns, i + 1, push);
      if (r && typeof r.then == "function") {
        const ii = i;
        return r.then(() => step(ii + 1));
      }
    }
  };
  return step(index);
};

// node_modules/stream-chain/src/gen.js
var gen = (...fns) => {
  fns = fns.filter((fn) => fn).flat(Infinity).map((fn) => isFunctionList(fn) ? getFunctionList(fn) : fn).flat(Infinity);
  if (!fns.length) {
    fns = [(x) => x];
  }
  let flushed = false;
  let g = async function* (value) {
    if (flushed) throw Error("Call to a flushed pipe.");
    const isFlush = value === none;
    if (isFlush) flushed = true;
    const pending = [];
    let wakeConsumer = null;
    let resolveProducer = null;
    let rejectProducer = null;
    let done = false, error = null, cancelled = false;
    const CANCEL = Symbol("cancel");
    const push = (v) => {
      if (cancelled) throw CANCEL;
      pending.push(v);
      if (wakeConsumer) {
        const w = wakeConsumer;
        wakeConsumer = null;
        w();
      }
      return new Promise((res, rej) => {
        resolveProducer = res;
        rejectProducer = rej;
      });
    };
    Promise.resolve().then(() => isFlush ? flush(fns, 0, push) : next(value, fns, 0, push)).then(
      () => {
      },
      (e) => {
        if (e !== CANCEL) error = e;
      }
    ).finally(() => {
      done = true;
      if (wakeConsumer) {
        const w = wakeConsumer;
        wakeConsumer = null;
        w();
      }
    });
    try {
      for (; ; ) {
        while (pending.length) {
          const v = pending.shift();
          if (resolveProducer) {
            const r = resolveProducer;
            resolveProducer = rejectProducer = null;
            r();
          }
          yield v;
        }
        if (error) throw error;
        if (done) return;
        await new Promise((res) => wakeConsumer = res);
      }
    } finally {
      cancelled = true;
      if (rejectProducer) {
        const rj = rejectProducer;
        resolveProducer = rejectProducer = null;
        rj(CANCEL);
      }
    }
  };
  const needToFlush = fns.some((fn) => isFlushable(fn));
  if (needToFlush) g = flushable(g);
  return setFunctionList(g, fns);
};
var gen_default = gen;

// node_modules/stream-chain/src/fun.js
var collect = (collect2, fns) => {
  fns = fns.filter((fn) => fn).flat(Infinity).map((fn) => isFunctionList(fn) ? getFunctionList(fn) : fn).flat(Infinity);
  if (!fns.length) {
    fns = [(x) => x];
  }
  let flushed = false;
  let g = (value) => {
    if (flushed) throw Error("Call to a flushed pipe.");
    if (value !== none) {
      return next(value, fns, 0, collect2);
    } else {
      flushed = true;
      return flush(fns, 0, collect2);
    }
  };
  const needToFlush = fns.some((fn) => isFlushable(fn));
  if (needToFlush) g = flushable(g);
  return setFunctionList(g, fns);
};
var asArray = (...fns) => {
  let results = null;
  const f = collect((value) => results.push(value), fns);
  let g = (value) => {
    results = [];
    const pending = f(value);
    if (pending && typeof pending.then == "function") {
      return pending.then(() => {
        const r2 = results;
        results = null;
        return r2;
      });
    }
    const r = results;
    results = null;
    return r;
  };
  if (isFlushable(f)) g = flushable(g);
  return setFunctionList(g, getFunctionList(f));
};
var fun = (...fns) => {
  const f = asArray(...fns);
  let g = (value) => {
    const result = (
      /** @type {any} */
      f(value)
    );
    if (result && typeof result.then == "function") {
      return result.then((results) => many(results));
    }
    return many(result);
  };
  if (isFlushable(f)) g = flushable(g);
  return setFunctionList(g, getFunctionList(f));
};
var fun_default = fun;

// node_modules/stream-chain/src/dataSource.js
var dataSource = (fn) => {
  if (typeof fn == "function") return fn;
  if (fn) {
    if (typeof fn[Symbol.asyncIterator] == "function") return fn[Symbol.asyncIterator].bind(fn);
    if (typeof fn[Symbol.iterator] == "function") return fn[Symbol.iterator].bind(fn);
  }
  throw new TypeError("The argument should be a function or an iterable object.");
};
var dataSource_default = dataSource;

// node_modules/stream-chain/src/core/index.js
var chain = (fns, _options) => {
  const flat = (Array.isArray(fns) ? fns : []).flat(Infinity).filter(Boolean).map((fn) => isFunctionList(fn) ? getFunctionList(fn) : fn).flat(Infinity);
  const g = gen_default(...flat);
  const c = async function* (input) {
    if (input == null) return;
    if (typeof input === "string" || input[Symbol.asyncIterator] === void 0 && input[Symbol.iterator] === void 0) {
      yield* g(input);
      return;
    }
    for await (const value of input) yield* g(value);
  };
  c.streams = null;
  c.input = null;
  c.output = null;
  return c;
};
chain.none = none;
chain.stop = stop;
chain.Stop = Stop;
chain.finalSymbol = finalSymbol;
chain.finalValue = finalValue;
chain.final = final;
chain.isFinalValue = isFinalValue;
chain.getFinalValue = getFinalValue;
chain.manySymbol = manySymbol;
chain.many = many;
chain.isMany = isMany;
chain.getManyValues = getManyValues;
chain.flushSymbol = flushSymbol;
chain.flushable = flushable;
chain.isFlushable = isFlushable;
chain.fListSymbol = fListSymbol;
chain.isFunctionList = isFunctionList;
chain.getFunctionList = getFunctionList;
chain.setFunctionList = setFunctionList;
chain.clearFunctionList = clearFunctionList;
chain.toMany = toMany;
chain.normalizeMany = normalizeMany;
chain.combineMany = combineMany;
chain.combineManyMut = combineManyMut;
chain.chain = chain;
chain.chainUnchecked = chain;
chain.gen = gen_default;
chain.fun = fun_default;
chain.dataSource = dataSource_default;

// node_modules/stream-json/src/core/utils/flex-assembler.js
var compileFilter = (filter, separator) => {
  if (typeof filter == "function") return filter;
  if (typeof filter == "string") {
    const filterWithSep = filter + separator;
    return (path2) => {
      const joined = path2.join(separator);
      return joined === filter || joined.startsWith(filterWithSep);
    };
  }
  if (filter instanceof RegExp) {
    return (path2) => {
      filter.lastIndex = 0;
      return filter.test(path2.join(separator));
    };
  }
  return () => true;
};
var compileRules = (rules, separator) => {
  if (!rules || !rules.length) return null;
  return rules.map((rule) => ({ ...rule, filter: compileFilter(rule.filter, separator) }));
};
var FlexAssembler = class _FlexAssembler {
  static connectTo(stream, options) {
    return new _FlexAssembler(options).connectTo(stream);
  }
  constructor(options) {
    this.objectStack = [];
    this.keyStack = [];
    this.current = this.key = null;
    this.rule = null;
    this.isArray = false;
    this.arrayIndex = -1;
    this.done = true;
    this.reviver = false;
    this._onDone = null;
    const separator = options?.pathSeparator || ".";
    this.objectRules = compileRules(options?.objectRules, separator);
    this.arrayRules = compileRules(options?.arrayRules, separator);
    if (options) {
      this.reviver = typeof options.reviver == "function" && options.reviver;
      if (options.numberAsString) {
        this.numberValue = this.stringValue;
      }
      if (typeof options.onDone == "function") {
        this._onDone = options.onDone;
      }
    }
    this.tapChain = (chunk) => {
      if (this[chunk.name]) {
        this[chunk.name](chunk.value);
        if (this.done) return this.current;
      }
      return none;
    };
  }
  connectTo(stream) {
    const consume = (chunk) => {
      if (this[chunk.name]) {
        this[chunk.name](chunk.value);
        if (this.done) this._onDone?.(this);
      }
    };
    if (typeof stream?.getReader === "function") {
      const reader = stream.getReader();
      (async () => {
        try {
          for (; ; ) {
            const { done, value } = await reader.read();
            if (done) return;
            consume(value);
          }
        } finally {
          reader.releaseLock();
        }
      })();
    } else {
      stream.on("data", consume);
    }
    return this;
  }
  onDone(fn) {
    this._onDone = typeof fn == "function" ? fn : null;
    return this;
  }
  get depth() {
    return this.objectStack.length + (this.done ? 0 : 1);
  }
  get path() {
    return this.keyStack.slice();
  }
  dropToLevel(level) {
    if (level < this.depth) {
      if (level > 0) {
        const index = level - 1;
        const entry = this.objectStack[index];
        this.current = entry.container;
        this.rule = entry.rule;
        this.isArray = entry.isArray;
        this.arrayIndex = entry.arrayIndex;
        this.key = null;
        this.objectStack.length = index;
        this.keyStack.length = index;
      } else {
        this.objectStack.length = 0;
        this.keyStack.length = 0;
        this.current = this.key = null;
        this.rule = null;
        this.isArray = false;
        this.arrayIndex = -1;
        this.done = true;
      }
    }
    return this;
  }
  consume(chunk) {
    this[chunk.name]?.(chunk.value);
    return this;
  }
  keyValue(value) {
    this.key = value;
  }
  stringValue(value) {
    this._saveValue(value);
  }
  numberValue(value) {
    this._saveValue(parseFloat(value));
  }
  nullValue() {
    this._saveValue(null);
  }
  trueValue() {
    this._saveValue(true);
  }
  falseValue() {
    this._saveValue(false);
  }
  _matchRule(rules) {
    if (!rules) return null;
    for (const rule of rules) {
      if (rule.filter(this.keyStack)) return rule;
    }
    return null;
  }
  _pushState() {
    this.objectStack.push({ container: this.current, rule: this.rule, isArray: this.isArray, arrayIndex: this.arrayIndex });
    if (this.isArray) {
      ++this.arrayIndex;
      this.keyStack.push(this.arrayIndex);
    } else {
      this.keyStack.push(this.key);
    }
  }
  startObject() {
    if (this.done) {
      this.done = false;
    } else {
      this._pushState();
    }
    this.rule = this._matchRule(this.objectRules);
    this.isArray = false;
    this.arrayIndex = -1;
    this.current = this.rule ? this.rule.create(this.keyStack) : {};
    this.key = null;
  }
  startArray() {
    if (this.done) {
      this.done = false;
    } else {
      this._pushState();
    }
    this.rule = this._matchRule(this.arrayRules);
    this.isArray = true;
    this.arrayIndex = -1;
    this.current = this.rule ? this.rule.create(this.keyStack) : [];
    this.key = null;
  }
  endObject() {
    if (this.rule?.finalize) {
      this.current = this.rule.finalize(this.current);
    }
    if (this.objectStack.length) {
      const value = this.current;
      const entry = this.objectStack.pop();
      this.key = this.keyStack.pop();
      this.current = entry.container;
      this.rule = entry.rule;
      this.isArray = entry.isArray;
      this.arrayIndex = entry.arrayIndex;
      this._addToCurrent(value);
    } else {
      if (this.reviver) {
        this.current = this.reviver.call({ "": this.current }, "", this.current);
      }
      this.done = true;
    }
  }
  _saveValue(value) {
    if (this.done) {
      if (this.reviver) value = this.reviver.call({ "": value }, "", value);
      this.current = value;
      return;
    }
    if (this.isArray) ++this.arrayIndex;
    this._addToCurrent(value);
  }
  _addToCurrent(value) {
    if (this.isArray) {
      if (this.reviver) {
        value = this.reviver.call(this.current, String(this.arrayIndex), value);
        if (value === void 0) return;
      }
      if (this.rule) {
        this.rule.add(this.current, value);
      } else {
        this.current.push(value);
      }
    } else {
      if (this.reviver) {
        value = this.reviver.call(this.current, this.key, value);
        if (value === void 0) {
          this.key = null;
          return;
        }
      }
      if (this.rule) {
        this.rule.add(this.current, this.key, value);
      } else {
        this.current[this.key] = value;
      }
      this.key = null;
    }
  }
};
FlexAssembler.prototype.endArray = FlexAssembler.prototype.endObject;
var flexAssembler = (options) => new FlexAssembler(options);
FlexAssembler.flexAssembler = flexAssembler;
var objectRule = (rule) => rule;
var arrayRule = (rule) => rule;
FlexAssembler.objectRule = objectRule;
FlexAssembler.arrayRule = arrayRule;

// src/object.ts
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function compactObject(value) {
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (item === void 0 || item === null || item === "") {
      continue;
    }
    if (Array.isArray(item) && item.length === 0) {
      out[key] = item;
      continue;
    }
    out[key] = item;
  }
  return out;
}
function firstString(records, keys) {
  for (const record of records) {
    for (const key of keys) {
      const value = record[key];
      if (typeof value === "string") {
        const trimmed = value.trim();
        if (trimmed) {
          return trimmed;
        }
      }
      if (typeof value === "number" || typeof value === "boolean") {
        return String(value);
      }
    }
  }
  return void 0;
}
function firstRecord(records, key) {
  for (const record of records) {
    const value = record[key];
    if (isRecord(value)) {
      return value;
    }
  }
  return void 0;
}

// src/xai.ts
var XAI_ISSUER = "https://auth.x.ai";
var GROK_CLI_CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
var XAI_TOKEN_ENDPOINT = `${XAI_ISSUER}/oauth2/token`;
var XAI_ACCESS_TOKEN_TYPE = "at+jwt";

// src/input.ts
var STREAM_BUFFER_LIMIT = 2 * 1024 * 1024;
var ZIP_END_RECORD_LIMIT = 22 + 65535;
var TEXT_SNIFF_LIMIT = 64 * 1024;
var ZIP_SIGNATURES = [
  [80, 75, 3, 4],
  [80, 75, 5, 6],
  [80, 75, 7, 8]
];
async function* parseInputSources(sources, parseTokens, signal) {
  for await (const source of sources) {
    throwIfAborted(signal);
    const detected = await detectInputSource(source, signal);
    if (!detected) continue;
    yield* parseDetectedInputSource(detected, parseTokens, signal);
  }
}
async function* parseDetectedInputSource(source, parseTokens, signal) {
  if (source.kind !== "zip") {
    yield* parseInputSource(source, parseTokens, signal);
    return;
  }
  try {
    for await (const entry of zipEntrySources(source, signal)) {
      const detectedEntry = await detectInputSource(entry, signal);
      if (detectedEntry) yield* parseDetectedInputSource(detectedEntry, parseTokens, signal);
    }
  } catch (error) {
    if (isAbortError(error) || isSystemIoError(error)) throw error;
    yield zipFailure(source, error);
  }
}
async function detectInputSource(source, signal) {
  const iterator = source.chunks[Symbol.asyncIterator]();
  const buffered = [];
  let bufferedBytes = 0;
  while (bufferedBytes < 4) {
    throwIfAborted(signal);
    const result = await iterator.next();
    if (result.done) break;
    buffered.push(result.value);
    bufferedBytes += result.value.byteLength;
  }
  const prefix = firstBytes(buffered, 4);
  if (prefix.byteLength === 4 && ZIP_SIGNATURES.some((signature) => signature.every((value, index) => prefix[index] === value))) {
    return detected("zip");
  }
  const decoder = new TextDecoder();
  const textKind = new TextKindDetector();
  let sniffedBytes = 0;
  for (const chunk of buffered) {
    const decision = inspect(chunk);
    if (decision?.kind) return detected(decision.kind);
    if (decision?.unsupported) return closeUnsupported();
  }
  for (; ; ) {
    throwIfAborted(signal);
    const result = await iterator.next();
    if (result.done) {
      const finalDecision = textKind.finish(decoder.decode());
      if (finalDecision.kind) return detected(finalDecision.kind);
      return closeUnsupported();
    }
    buffered.push(result.value);
    const decision = inspect(result.value);
    if (decision?.kind) return detected(decision.kind);
    if (decision?.unsupported) return closeUnsupported();
  }
  function inspect(chunk) {
    const remaining = TEXT_SNIFF_LIMIT - sniffedBytes;
    if (remaining <= 0) return textKind.boundedFallback();
    const inspected = chunk.subarray(0, Math.min(chunk.byteLength, remaining));
    sniffedBytes += inspected.byteLength;
    const decision = textKind.push(decoder.decode(inspected, { stream: true }));
    return decision ?? (sniffedBytes >= TEXT_SNIFF_LIMIT ? textKind.boundedFallback() : void 0);
  }
  function detected(kind) {
    return {
      ...source,
      kind,
      chunks: replayChunks(buffered, iterator)
    };
  }
  async function closeUnsupported() {
    await iterator.return?.();
    await source.cancel?.();
    return void 0;
  }
}
var TextKindDetector = class {
  #lineParts = [];
  #first;
  #firstLine;
  push(text) {
    let cursor = 0;
    for (; ; ) {
      const newline = text.indexOf("\n", cursor);
      if (newline < 0) {
        this.#append(text.slice(cursor));
        return void 0;
      }
      this.#append(text.slice(cursor, newline));
      const decision = this.#classifyLine();
      if (decision) return decision;
      this.#lineParts.length = 0;
      cursor = newline + 1;
    }
  }
  finish(text) {
    const decision = this.push(text);
    if (decision) return decision;
    if (this.#lineParts.length > 0) {
      const finalLine = this.#classifyLine();
      if (finalLine) return finalLine;
    }
    if (this.#firstLine === "complete") return { kind: "jsonl" };
    if (this.#firstLine === "invalid") return { kind: "json" };
    if (this.#firstLine === "nonjson") return { unsupported: true };
    return this.fallback();
  }
  fallback() {
    return this.#first === "{" || this.#first === "[" ? { kind: "json" } : { unsupported: true };
  }
  boundedFallback() {
    return this.#first === "{" || this.#first === "[" ? { kind: "ambiguous" } : { unsupported: true };
  }
  #append(text) {
    if (text) this.#lineParts.push(text);
    if (!this.#first) this.#first = /\S/.exec(text)?.[0];
  }
  #classifyLine() {
    const line = this.#lineParts.join("").replace(/\r$/, "");
    if (!line.trim()) return void 0;
    const shape = textLineShape(line);
    if (shape === "continuous") return { kind: "json" };
    if (shape === "incomplete") {
      return this.#firstLine === "invalid" || this.#firstLine === "nonjson" ? { kind: "jsonl" } : { kind: "json" };
    }
    if (!this.#firstLine) {
      this.#firstLine = shape;
      return void 0;
    }
    if (this.#firstLine === "complete") return { kind: "jsonl" };
    return shape === "nonjson" ? void 0 : { kind: "jsonl" };
  }
};
function isCompleteJson(text) {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}
function textLineShape(text) {
  const first = text.trimStart()[0];
  if (first !== "{" && first !== "[") return "nonjson";
  if (isCompleteJson(text)) return "complete";
  let depth = 0;
  let inString = false;
  let escaped = false;
  let roots = 0;
  for (const character of text) {
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === "{" || character === "[") {
      if (depth === 0) roots += 1;
      depth += 1;
    } else if (character === "}" || character === "]") depth -= 1;
  }
  if (roots > 1) return "continuous";
  return !inString && depth <= 0 ? "invalid" : "incomplete";
}
function firstBytes(chunks, count) {
  const result = new Uint8Array(Math.min(count, chunks.reduce((total, chunk) => total + chunk.byteLength, 0)));
  let offset = 0;
  for (const chunk of chunks) {
    const size = Math.min(chunk.byteLength, result.byteLength - offset);
    result.set(chunk.subarray(0, size), offset);
    offset += size;
    if (offset === result.byteLength) break;
  }
  return result;
}
async function* replayChunks(buffered, iterator) {
  try {
    yield* buffered;
    for (; ; ) {
      const result = await iterator.next();
      if (result.done) return;
      yield result.value;
    }
  } finally {
    await iterator.return?.();
  }
}
async function* parseInputSource(source, parseTokens, signal) {
  if (source.kind === "jsonl" || source.kind === "ambiguous") {
    if (source.kind === "ambiguous") {
      for await (const record of ambiguousRecordSources(source, signal)) {
        yield* parseJsonDocuments(record, parseTokens, signal, record.line, true);
      }
      return;
    }
    let line = 0;
    for await (const lineBytes of splitLines(source.chunks, signal)) {
      line += 1;
      if (isBlank(lineBytes)) {
        continue;
      }
      const lineSource = {
        name: source.name,
        path: source.path,
        chunks: oneChunk(lineBytes)
      };
      yield* parseJsonDocuments(lineSource, parseTokens, signal, line);
    }
    return;
  }
  yield* parseJsonDocuments(source, parseTokens, signal);
}
async function* parseJsonDocuments(source, parseTokens, signal, line, streamRoots = line === void 0) {
  const pending = [];
  let documentIndex = 1;
  let itemIndex = 0;
  let emittedFromContainer = 0;
  const emitValue = (value, inputFormat) => {
    itemIndex += 1;
    const sourcePath = itemIndex === 1 ? source.path : `${source.path}#${itemIndex}`;
    pending.push({
      value,
      sourcePath,
      inputFormat
    });
    emittedFromContainer += 1;
  };
  const assembler = new FlexAssembler({
    arrayRules: [
      arrayRule({
        filter: (path2) => path2.length === 0,
        create: () => void 0,
        add: (_container, value) => emitValue(value)
      }),
      arrayRule({
        filter: (path2) => path2.length === 1 && path2[0] === "accounts",
        create: () => [],
        add: (container, value) => {
          if (isSub2ApiAccount(value)) {
            emitValue(value, "sub2api");
          } else {
            container.push(value);
          }
        }
      })
    ],
    objectRules: [
      objectRule({
        filter: (path2) => path2.length === 0,
        create: () => ({ record: {} }),
        add: (container, key, value) => {
          if (key.startsWith(`${XAI_ISSUER}::`) && isRecord(value)) {
            emitValue({ [key]: value }, "grok");
            return;
          }
          container.record[key] = value;
        },
        finalize: (container) => container.record
      })
    ]
  });
  let rootStarted = false;
  try {
    const tokenChunks = line === void 0 ? frameJsonRoots(source.chunks, signal) : source.chunks;
    for await (const tokens of parseTokens(tokenChunks, { jsonStreaming: streamRoots, signal })) {
      throwIfAborted(signal);
      for (const token of tokens) {
        if (assembler.done && isValueStart(token)) {
          rootStarted = true;
          itemIndex = 0;
          emittedFromContainer = 0;
        }
        assembler.consume(token);
        if (rootStarted && assembler.done) {
          if (emittedFromContainer === 0 && isRecord(assembler.current)) {
            emitValue(assembler.current);
          }
          if (pending.length > 0) yield takePendingValues();
          yield {
            type: "commit",
            batchId: sourceBatchId(source.path, line, documentIndex),
            sourceName: source.name,
            sourcePath: source.path
          };
          documentIndex += 1;
          rootStarted = false;
        }
      }
      if (pending.length > 0) yield takePendingValues();
    }
  } catch (error) {
    if (isAbortError(error)) throw error;
    if (isSystemIoError(error)) throw error;
    if (error instanceof ZipReadError) throw error;
    yield {
      type: "discard",
      batchId: sourceBatchId(source.path, line, documentIndex),
      diagnostic: {
        code: "json_parse_failed",
        sourceName: source.name,
        sourcePath: source.path,
        line,
        detail: errorMessage(error)
      }
    };
  }
  function takePendingValues() {
    return {
      type: "values",
      batchId: sourceBatchId(source.path, line, documentIndex),
      sourceName: source.name,
      items: pending.splice(0)
    };
  }
}
function isValueStart(token) {
  return token.name === "startObject" || token.name === "startArray" || token.name === "stringValue" || token.name === "numberValue" || token.name === "nullValue" || token.name === "trueValue" || token.name === "falseValue";
}
function isSub2ApiAccount(value) {
  return isRecord(value) && (isRecord(value.credentials) || typeof value.platform === "string");
}
async function* zipEntrySources(source, signal) {
  const entries = new AsyncQueue();
  const active = /* @__PURE__ */ new Set();
  const budget = new ByteBudget();
  const endRecord = new ZipEndRecordTracker();
  const sourceIterator = source.chunks[Symbol.asyncIterator]();
  let currentFile;
  let stopping = false;
  let pumpFinished = false;
  const unzip = new Unzip((file) => {
    currentFile = file;
    const entryPath = normalizeArchiveEntryPath(file.name);
    if (!entryPath || entryPath.endsWith("/") || isIgnoredArchivePath(entryPath)) {
      file.ondata = () => void 0;
      file.start();
      return;
    }
    const queue = new ByteQueue(budget, () => active.delete(queue));
    active.add(queue);
    file.ondata = (error, chunk, final3) => {
      if (error) {
        queue.fail(new ZipReadError(error));
        return;
      }
      if (chunk?.length) {
        queue.push(chunk);
      }
      if (final3) {
        queue.close();
      }
    };
    entries.push({
      name: `${source.name}/${entryPath}`,
      path: `${source.path.replace(/\/+$/g, "")}/${entryPath}`,
      chunks: queue,
      cancel: (reason) => queue.fail(reason)
    });
    file.start();
  });
  unzip.register(UnzipInflate);
  const pump = (async () => {
    try {
      for (; ; ) {
        const result = await sourceIterator.next();
        if (result.done || stopping) break;
        const chunk = result.value;
        throwIfAborted(signal);
        endRecord.push(chunk);
        unzip.push(chunk, false);
        await budget.waitBelow(STREAM_BUFFER_LIMIT);
      }
      if (stopping) return;
      unzip.push(new Uint8Array(), true);
      if (!endRecord.hasValidEndRecord()) {
        throw new ZipReadError("Invalid ZIP end record");
      }
      entries.close();
    } catch (error) {
      currentFile?.terminate();
      budget.clear();
      for (const queue of active) {
        queue.fail(error);
      }
      entries.fail(error);
    } finally {
      if (stopping) await sourceIterator.return?.();
      pumpFinished = true;
    }
  })();
  try {
    yield* entries;
    await pump;
  } finally {
    if (!pumpFinished) {
      stopping = true;
      currentFile?.terminate();
      budget.clear();
      const reason = signal?.reason ?? new DOMException("ZIP consumption stopped", "AbortError");
      for (const queue of active) queue.fail(reason);
      entries.fail(reason);
      await source.cancel?.(reason);
      await pump;
    }
  }
}
async function* splitLines(chunks, signal) {
  const decoder = new TextDecoder();
  const encoder2 = new TextEncoder();
  let pending = "";
  for await (const chunk of chunks) {
    throwIfAborted(signal);
    pending += decoder.decode(chunk, { stream: true });
    let newline = pending.indexOf("\n");
    while (newline >= 0) {
      const line = pending.slice(0, newline).replace(/\r$/, "");
      pending = pending.slice(newline + 1);
      yield encoder2.encode(line);
      newline = pending.indexOf("\n");
    }
  }
  pending += decoder.decode();
  if (pending.length > 0) {
    yield encoder2.encode(pending.replace(/\r$/, ""));
  }
}
async function* ambiguousRecordSources(source, signal) {
  const decoder = new TextDecoder();
  const encoder2 = new TextEncoder();
  const records = new AsyncQueue();
  const active = /* @__PURE__ */ new Set();
  const budget = new ByteBudget();
  const sourceIterator = source.chunks[Symbol.asyncIterator]();
  let current;
  let currentLine = 1;
  let depth = 0;
  let inString = false;
  let escaped = false;
  let stopping = false;
  let pumpFinished = false;
  const pump = (async () => {
    try {
      for (; ; ) {
        const result = await sourceIterator.next();
        if (result.done || stopping) break;
        throwIfAborted(signal);
        await scan(decoder.decode(result.value, { stream: true }));
      }
      if (stopping) return;
      await scan(decoder.decode());
      current?.close();
      records.close();
    } catch (error) {
      budget.clear();
      for (const queue of active) queue.fail(error);
      records.fail(error);
    } finally {
      if (stopping) await sourceIterator.return?.();
      pumpFinished = true;
    }
  })();
  try {
    yield* records;
    await pump;
  } finally {
    if (!pumpFinished) {
      stopping = true;
      budget.clear();
      const reason = signal?.reason ?? new DOMException("JSON consumption stopped", "AbortError");
      for (const queue of active) queue.fail(reason);
      records.fail(reason);
      await source.cancel?.(reason);
      await pump;
    }
  }
  async function scan(text) {
    let segmentStart = 0;
    for (let index = 0; index < text.length; index += 1) {
      const character = text[index];
      if (!current) {
        if (isJsonWhitespace(character.charCodeAt(0))) {
          if (character === "\n") currentLine += 1;
          segmentStart = index + 1;
          continue;
        }
        current = createRecord(currentLine);
        segmentStart = index;
      }
      if (character === "\n") {
        currentLine += 1;
        if (!inString && depth === 0) {
          const end = index > segmentStart && text[index - 1] === "\r" ? index - 1 : index;
          pushText(text.slice(segmentStart, end));
          current.close();
          current = void 0;
          segmentStart = index + 1;
        }
        continue;
      }
      if (inString) {
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === '"') inString = false;
        continue;
      }
      if (character === '"') inString = true;
      else if (character === "{" || character === "[") depth += 1;
      else if (character === "}" || character === "]") depth = Math.max(0, depth - 1);
    }
    if (current && segmentStart < text.length) pushText(text.slice(segmentStart));
    await budget.waitBelow(STREAM_BUFFER_LIMIT);
  }
  function createRecord(line) {
    const queue = new ByteQueue(budget, () => active.delete(queue));
    active.add(queue);
    records.push({
      name: source.name,
      path: source.path,
      line,
      chunks: queue,
      cancel: (reason) => queue.fail(reason)
    });
    return queue;
  }
  function pushText(text) {
    if (text) current?.push(encoder2.encode(text));
  }
}
async function* frameJsonRoots(chunks, signal) {
  const decoder = new TextDecoder();
  const structural = /["\\{}\[\]]/g;
  let started = false;
  let container = false;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for await (const chunk of chunks) {
    throwIfAborted(signal);
    yield* scan(decoder.decode(chunk, { stream: true }));
  }
  yield* scan(decoder.decode());
  function* scan(text) {
    if (!text) return;
    let cursor = 0;
    let partStart = 0;
    if (inString && escaped) {
      escaped = false;
      cursor = 1;
    }
    while (cursor < text.length) {
      if (!started) {
        while (cursor < text.length && isJsonWhitespace(text.charCodeAt(cursor))) cursor += 1;
        if (cursor >= text.length) break;
        const code2 = text.charCodeAt(cursor);
        started = true;
        container = code2 === 123 || code2 === 91;
        depth = container ? 1 : 0;
        inString = code2 === 34;
        escaped = false;
        cursor += 1;
        continue;
      }
      if (!container && !inString) {
        while (cursor < text.length && !isJsonWhitespace(text.charCodeAt(cursor))) cursor += 1;
        if (cursor >= text.length) break;
        if (cursor > partStart) yield text.slice(partStart, cursor);
        partStart = cursor;
        started = false;
        continue;
      }
      structural.lastIndex = cursor;
      const match = structural.exec(text);
      if (!match) break;
      const index = match.index;
      const code = text.charCodeAt(index);
      cursor = index + 1;
      if (inString) {
        if (code === 92) {
          if (cursor >= text.length) escaped = true;
          else cursor += 1;
        } else if (code === 34) {
          inString = false;
        }
        continue;
      }
      if (code === 34) {
        inString = true;
        continue;
      }
      if (code === 123 || code === 91) depth += 1;
      else if (code === 125 || code === 93) depth -= 1;
      if (depth !== 0) continue;
      if (cursor > partStart) yield text.slice(partStart, cursor);
      partStart = cursor;
      started = false;
      container = false;
      inString = false;
    }
    if (partStart < text.length) yield text.slice(partStart);
  }
}
function isJsonWhitespace(code) {
  return code === 32 || code === 9 || code === 10 || code === 13;
}
var AsyncQueue = class {
  #values = [];
  #waiters = [];
  #closed = false;
  #error;
  push(value) {
    if (this.#closed || this.#error) return;
    const waiter = this.#waiters.shift();
    if (waiter) waiter.resolve({ done: false, value });
    else this.#values.push(value);
  }
  close() {
    if (this.#closed || this.#error) return;
    this.#closed = true;
    for (const waiter of this.#waiters.splice(0)) waiter.resolve({ done: true, value: void 0 });
  }
  fail(error) {
    if (this.#closed || this.#error) return;
    this.#error = error;
    for (const waiter of this.#waiters.splice(0)) waiter.reject(error);
  }
  drain() {
    return this.#values.splice(0);
  }
  [Symbol.asyncIterator]() {
    return {
      next: () => {
        const value = this.#values.shift();
        if (value !== void 0) return Promise.resolve({ done: false, value });
        if (this.#error) return Promise.reject(this.#error);
        if (this.#closed) return Promise.resolve({ done: true, value: void 0 });
        return new Promise((resolve, reject) => this.#waiters.push({ resolve, reject }));
      }
    };
  }
};
var ByteQueue = class extends AsyncQueue {
  #budget;
  #onClose;
  #discarded = false;
  #released = false;
  constructor(budget, onClose) {
    super();
    this.#budget = budget;
    this.#onClose = onClose;
  }
  push(value) {
    if (this.#discarded) return;
    this.#budget.add(value.byteLength);
    super.push(value);
  }
  close() {
    this.#release();
    super.close();
  }
  fail(error) {
    this.#release();
    super.fail(error);
  }
  [Symbol.asyncIterator]() {
    const iterator = super[Symbol.asyncIterator]();
    return {
      next: async () => {
        const result = await iterator.next();
        if (!result.done) {
          this.#budget.consume(result.value.byteLength);
        }
        return result;
      },
      return: async () => {
        this.#discarded = true;
        const buffered = this.drain();
        const bufferedBytes = buffered.reduce((total, chunk) => total + chunk.byteLength, 0);
        if (bufferedBytes > 0) this.#budget.consume(bufferedBytes);
        this.#release();
        super.close();
        return { done: true, value: void 0 };
      }
    };
  }
  #release() {
    if (this.#released) return;
    this.#released = true;
    this.#onClose();
  }
};
var ByteBudget = class {
  #bytes = 0;
  #waiters = [];
  add(size) {
    this.#bytes += size;
  }
  consume(size) {
    this.#bytes -= size;
    this.#notify();
  }
  waitBelow(limit) {
    if (this.#bytes <= limit) return Promise.resolve();
    return new Promise((resolve) => this.#waiters.push(resolve));
  }
  clear() {
    this.#bytes = 0;
    this.#notify();
  }
  #notify() {
    if (this.#bytes > STREAM_BUFFER_LIMIT) return;
    for (const resolve of this.#waiters.splice(0)) resolve();
  }
};
var ZipEndRecordTracker = class {
  #buffer = new Uint8Array(ZIP_END_RECORD_LIMIT);
  #length = 0;
  #writeOffset = 0;
  push(chunk) {
    if (chunk.byteLength >= ZIP_END_RECORD_LIMIT) {
      this.#buffer.set(chunk.subarray(chunk.byteLength - ZIP_END_RECORD_LIMIT));
      this.#length = ZIP_END_RECORD_LIMIT;
      this.#writeOffset = 0;
      return;
    }
    const first = Math.min(chunk.byteLength, ZIP_END_RECORD_LIMIT - this.#writeOffset);
    this.#buffer.set(chunk.subarray(0, first), this.#writeOffset);
    if (first < chunk.byteLength) this.#buffer.set(chunk.subarray(first), 0);
    this.#writeOffset = (this.#writeOffset + chunk.byteLength) % ZIP_END_RECORD_LIMIT;
    this.#length = Math.min(ZIP_END_RECORD_LIMIT, this.#length + chunk.byteLength);
  }
  hasValidEndRecord() {
    const tail = this.#snapshot();
    const view = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
    for (let offset = tail.byteLength - 22; offset >= 0; offset -= 1) {
      if (view.getUint32(offset, true) !== 101010256) continue;
      const commentLength = view.getUint16(offset + 20, true);
      if (offset + 22 + commentLength === tail.byteLength) return true;
    }
    return false;
  }
  #snapshot() {
    if (this.#length < ZIP_END_RECORD_LIMIT) return this.#buffer.slice(0, this.#length);
    const tail = new Uint8Array(this.#length);
    const first = this.#buffer.subarray(this.#writeOffset);
    tail.set(first);
    tail.set(this.#buffer.subarray(0, this.#writeOffset), first.byteLength);
    return tail;
  }
};
function zipFailure(source, error) {
  return {
    type: "discard",
    batchId: `${source.path}::zip`,
    diagnostic: {
      code: "zip_read_failed",
      sourceName: source.name,
      sourcePath: source.path,
      detail: errorMessage(error)
    }
  };
}
function sourceBatchId(path2, line, document) {
  return `${path2}::${line === void 0 ? "document" : `line:${line}`}::${document}`;
}
function isIgnoredArchivePath(value) {
  return value.split("/").some((segment) => segment === "__MACOSX" || segment.startsWith("."));
}
function normalizeArchiveEntryPath(value) {
  return value.replace(/\\/g, "/").split("/").filter((segment) => segment && segment !== "." && segment !== "..").join("/");
}
function isBlank(bytes) {
  return new TextDecoder().decode(bytes).trim().length === 0;
}
async function* oneChunk(chunk) {
  yield chunk;
}
function throwIfAborted(signal) {
  if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
}
function isSystemIoError(error) {
  return error instanceof Error && "code" in error && typeof error.code === "string";
}
function isAbortError(error) {
  return error instanceof DOMException && error.name === "AbortError";
}
var ZipReadError = class extends Error {
  constructor(error) {
    super(errorMessage(error));
    this.name = "ZipReadError";
  }
};
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

// src/jwt.ts
var SYNTHETIC_ID_TOKEN_PLACEHOLDER_SIGNATURE = base64urlEncode("lanv_authconv");
function decodeJwtParts(token) {
  if (!token) {
    return void 0;
  }
  const parts = token.split(".");
  if (parts.length !== 3 || !parts[0] || !parts[1]) {
    return void 0;
  }
  try {
    const header = JSON.parse(base64urlDecode(parts[0]));
    const payload = JSON.parse(base64urlDecode(parts[1]));
    if (!isRecord(header) || !isRecord(payload)) {
      return void 0;
    }
    return { header, payload };
  } catch {
    return void 0;
  }
}
function decodeJwtPayload(token) {
  return decodeJwtParts(token)?.payload;
}
function createSyntheticIdToken(claims) {
  const header = {
    alg: "none",
    typ: "JWT",
    cpa_synthetic: true
  };
  const payload = {
    iat: 0,
    ...claims
  };
  const body = `${base64urlEncode(JSON.stringify(header))}.${base64urlEncode(JSON.stringify(payload))}`;
  return applySyntheticIdTokenSignature(`${body}.`);
}
function applySyntheticIdTokenSignature(token) {
  const parts = token.split(".");
  if (parts.length !== 3 || !parts[0] || !parts[1]) {
    return token;
  }
  return `${parts[0]}.${parts[1]}.${SYNTHETIC_ID_TOKEN_PLACEHOLDER_SIGNATURE}`;
}
function claimString(claims, key) {
  if (!claims) {
    return void 0;
  }
  const value = claims[key];
  return typeof value === "string" && value.trim() ? value.trim() : void 0;
}
function claimStringArray(claims, key) {
  if (!claims) {
    return void 0;
  }
  const value = claims[key];
  if (typeof value === "string" && value.trim()) {
    return [value.trim()];
  }
  if (!Array.isArray(value)) {
    return void 0;
  }
  const strings = value.filter((item) => typeof item === "string" && item.trim().length > 0).map((item) => item.trim());
  return strings.length > 0 ? strings : void 0;
}
function openAIAuthClaims(claims) {
  if (!claims) {
    return void 0;
  }
  const value = claims["https://api.openai.com/auth"];
  return isRecord(value) ? value : void 0;
}
function openAIProfileClaims(claims) {
  if (!claims) {
    return void 0;
  }
  const value = claims["https://api.openai.com/profile"];
  return isRecord(value) ? value : void 0;
}
function claimNumber(claims, key) {
  if (!claims) {
    return void 0;
  }
  const value = claims[key];
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return void 0;
}
function base64urlDecode(value) {
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = normalized.padEnd(normalized.length + (4 - normalized.length % 4) % 4, "=");
  if (typeof Buffer !== "undefined") {
    return Buffer.from(padded, "base64").toString("utf8");
  }
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}
function base64urlEncode(value) {
  if (typeof Buffer !== "undefined") {
    return Buffer.from(value).toString("base64").replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
  }
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

// src/openai.ts
var OPENAI_ISSUER = "https://auth.openai.com";

// src/normalize.ts
function detectArrayItemFormat(input) {
  const format = detectRecordInputFormat(input);
  if (format !== "unknown") {
    return format;
  }
  if (isCodex2ApiAutoRecord(input)) {
    return "codex2api";
  }
  return "unknown";
}
function detectRecordInputFormat(input) {
  if (isCpaRecord(input)) {
    return "cpa";
  }
  if (isXaiFlatRecord(input)) {
    return "grok";
  }
  if (typeof input.accessToken === "string" && (isRecord(input.user) || isRecord(input.account) || typeof input.sessionToken === "string")) {
    return "session";
  }
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
  if (isCodexAuthRecord(input)) {
    return "codex";
  }
  if (isRecord(input.tokens) && isRecord(input.meta)) {
    return "codexmanager";
  }
  if (isCodex2ApiAutoRecord(input)) {
    return "codex2api";
  }
  return "unknown";
}
function isCodex2ApiAutoRecord(input) {
  return isCodex2ApiRecord(input) && input.type === void 0 && (typeof input.refresh_token === "string" || typeof input.session_token === "string" || typeof input.id_token === "string");
}
function extractCandidatesFromValue(input, source, selectedFormat) {
  if (selectedFormat) {
    return extractCandidatesForFormat(input, source, selectedFormat);
  }
  return extractAutoCandidates(input, source);
}
function extractAutoCandidates(input, source) {
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
function extractAutoCandidatesFromRecord(record, source, index) {
  const inputFormat = detectArrayItemFormat(record);
  if (inputFormat === "sub2api" && Array.isArray(record.accounts)) {
    return record.accounts.filter(isRecord).map((item, accountIndex) => candidateFromRecord(item, source, accountIndex, "sub2api"));
  }
  if (inputFormat === "grok") {
    return grokRecords(record).map((item, accountIndex) => candidateFromRecord(item, source, accountIndex, "grok"));
  }
  return [candidateFromRecord(record, source, index, inputFormat)];
}
function extractCandidatesForFormat(input, source, inputFormat) {
  const records = candidateRecordsForFormat(input, inputFormat);
  return records.map((record, index) => candidateFromRecord(record, source, index, inputFormat));
}
function candidateRecordsForFormat(input, inputFormat) {
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
function sub2ApiRecords(input) {
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
function recordList(input) {
  if (Array.isArray(input)) {
    return input.filter(isRecord);
  }
  return isRecord(input) ? [input] : [];
}
function isSessionRecord(record) {
  return typeof record.accessToken === "string" && (isRecord(record.user) || isRecord(record.account) || typeof record.sessionToken === "string");
}
function isSub2ApiAccountRecord(record) {
  return isRecord(record.credentials) || typeof record.platform === "string";
}
function isCpaRecord(record) {
  return (record.type === "codex" || record.type === "xai") && Boolean(firstString([record], ["access_token", "refresh_token", "session_token", "id_token"]));
}
function isGrokAuthRecord(record) {
  const entries = Object.entries(record);
  return entries.length > 0 && entries.every(([key, value]) => key.startsWith(`${XAI_ISSUER}::`) && isRecord(value) && (typeof value.key === "string" || typeof value.refresh_token === "string"));
}
function grokRecords(input) {
  if (!isRecord(input)) {
    return [];
  }
  if (!isGrokAuthRecord(input)) {
    return isXaiFlatRecord(input) || hasXaiJwt(input) ? [input] : [];
  }
  return Object.entries(input).map(([authKey, value]) => ({
    ...value,
    auth_key: authKey
  }));
}
function isXaiFlatRecord(record) {
  return isExplicitXaiFlatRecord(record) || hasFlatCredential(record) && firstString([record], ["type"]) === "xai";
}
function isExplicitXaiFlatRecord(record) {
  if (!hasFlatCredential(record)) return false;
  const platform = firstString([record], ["platform"]);
  const issuer = firstString([record], ["oidc_issuer", "issuer", "iss"]);
  const tokenEndpoint = firstString([record], ["token_endpoint", "tokenEndpoint"]);
  return platform === "grok" || issuer === XAI_ISSUER || tokenEndpoint === XAI_TOKEN_ENDPOINT;
}
function hasFlatCredential(record) {
  return Boolean(firstString([record], [
    "access_token",
    "accessToken",
    "refresh_token",
    "refreshToken",
    "session_token",
    "sessionToken",
    "id_token",
    "idToken",
    "key"
  ]));
}
function hasXaiJwt(record) {
  const accessClaims = decodeJwtPayload(firstString([record], ["access_token", "accessToken", "key"]));
  const idClaims = decodeJwtPayload(firstString([record], ["id_token", "idToken"]));
  return claimString(accessClaims, "iss") === XAI_ISSUER || claimString(idClaims, "iss") === XAI_ISSUER;
}
function isCodexManagerRecord(record) {
  return isRecord(record.tokens) && isRecord(record.meta);
}
function isCodexAuthRecord(record) {
  return record.auth_mode === "chatgpt" && isRecord(record.tokens) && Boolean(firstString([record.tokens], ["access_token", "refresh_token", "id_token"]));
}
function isCodex2ApiRecord(record) {
  if (isRecord(record.credentials) || isRecord(record.tokens) || Array.isArray(record.accounts) || record.type === "codex") {
    return false;
  }
  return Boolean(firstString([record], ["access_token", "refresh_token", "session_token", "id_token"]));
}
function candidateFromRecord(record, source, index, inputFormat) {
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
    inputFormat
  };
}
function accountAliases(account) {
  return {
    account_id: account.account_id ?? account.accountId ?? account.id,
    chatgpt_account_id: account.chatgpt_account_id ?? account.chatgptAccountId ?? account.id,
    plan_type: account.plan_type ?? account.planType ?? account.chatgpt_plan_type ?? account.chatgptPlanType,
    workspace_id: account.workspace_id ?? account.workspaceId
  };
}
function userAliases(user) {
  return {
    user_id: user.user_id ?? user.userId ?? user.id,
    chatgpt_user_id: user.chatgpt_user_id ?? user.chatgptUserId ?? user.id,
    email: user.email,
    name: user.name
  };
}
function normalizeCandidate(candidate, index) {
  const { records } = candidate;
  const accessToken = firstString(records, ["access_token", "accessToken", "key"]);
  const refreshToken = firstString(records, ["refresh_token", "refreshToken"]);
  const sessionToken = firstString(records, ["session_token", "sessionToken"]);
  const idToken = firstString(records, ["id_token", "idToken"]);
  if (!accessToken && !refreshToken && !sessionToken && !idToken) {
    return void 0;
  }
  const idClaims = decodeJwtPayload(idToken);
  const accessClaims = decodeJwtPayload(accessToken);
  const accessFirstClaimRecords = [accessClaims, idClaims].filter((claims) => claims !== void 0);
  const expiryClaimRecords = [accessClaims, idClaims].filter((claims) => claims !== void 0);
  const structureProvider = providerFromStructure(candidate, records);
  const jwtProvider = providerFromIssuer(claimString(accessClaims, "iss")) ?? providerFromIssuer(claimString(idClaims, "iss"));
  const provider = structureProvider ?? jwtProvider ?? "unknown";
  const grokKey = parseGrokAuthKey(firstString(records, ["auth_key"]));
  const claimedIssuer = firstClaimString(accessFirstClaimRecords, ["iss"]);
  const recordIssuer = firstString(records, ["oidc_issuer", "issuer", "iss"]) ?? grokKey?.issuer;
  const audience = firstClaimStringArray(accessFirstClaimRecords, "aud");
  const clientId = firstString(records, ["client_id", "clientId", "oidc_client_id"]) ?? grokKey?.clientId ?? claimString(accessClaims, "client_id");
  const scopes = firstClaimStringArray(accessFirstClaimRecords, "scp") ?? firstClaimStringArray(accessFirstClaimRecords, "scope");
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
    preserveRawTimeFields
  );
  const claimedExpiresAt = normalizeTimeValue(firstClaimNumber(expiryClaimRecords, "exp"));
  const recordLastRefresh = normalizeInputTimeValue(
    firstString(records, ["last_refresh", "lastRefresh"]),
    preserveRawTimeFields
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
    inputFormat: candidate.inputFormat
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
      disabled: firstBoolean(records, ["disabled"])
    };
  }
  if (provider === "unknown") {
    return { ...common, provider };
  }
  const accessAuthClaims = openAIAuthClaims(accessClaims);
  const idAuthClaims = openAIAuthClaims(idClaims);
  const identityClaimRecords = [idClaims, accessClaims].filter((claims) => claims !== void 0);
  const authClaimRecords = accessFirstClaimRecords.map(openAIAuthClaims).filter((claims) => claims !== void 0);
  const claimedChatgptAccountUserId = claimString(accessAuthClaims, "chatgpt_account_user_id") ?? claimString(accessClaims, "chatgpt_account_user_id") ?? claimString(idAuthClaims, "chatgpt_account_user_id") ?? claimString(idClaims, "chatgpt_account_user_id");
  const accessAccountUserId = splitChatGptAccountUserId(claimedChatgptAccountUserId);
  const idAccountUserId = splitChatGptAccountUserId(claimString(idAuthClaims, "chatgpt_account_user_id"));
  const claimedAccountId = claimString(accessAuthClaims, "chatgpt_account_id") ?? accessAccountUserId?.accountId ?? claimString(accessClaims, "chatgpt_account_id") ?? claimString(idAuthClaims, "chatgpt_account_id") ?? idAccountUserId?.accountId ?? claimString(idClaims, "chatgpt_account_id");
  const recordAccountId = firstString(records, ["account_id", "accountId"]);
  const preferClaimIdentity = candidate.inputFormat === "session" || candidate.inputFormat === "codex";
  const accountId = preferClaimIdentity ? claimedAccountId ?? recordAccountId : recordAccountId ?? claimedAccountId;
  const chatgptAccountId = (preferClaimIdentity ? claimedAccountId ?? firstString(records, ["chatgpt_account_id", "chatgptAccountId"]) : firstString(records, ["chatgpt_account_id", "chatgptAccountId"]) ?? claimedAccountId) ?? accountId;
  const recordChatgptAccountUserId = firstString(records, ["chatgpt_account_user_id", "chatgptAccountUserId"]);
  const claimedChatgptUserId = claimString(accessAuthClaims, "chatgpt_user_id") ?? claimString(accessAuthClaims, "user_id") ?? accessAccountUserId?.userId ?? claimString(accessClaims, "chatgpt_user_id") ?? claimString(idAuthClaims, "chatgpt_user_id") ?? claimString(idAuthClaims, "user_id") ?? idAccountUserId?.userId ?? claimString(idClaims, "chatgpt_user_id") ?? claimString(accessClaims, "sub") ?? claimString(idClaims, "sub");
  const recordChatgptUserId = firstString(records, ["chatgpt_user_id", "chatgptUserId"]);
  const chatgptUserId = preferClaimIdentity ? claimedChatgptUserId ?? recordChatgptUserId : recordChatgptUserId ?? claimedChatgptUserId;
  const chatgptAccountUserId = (preferClaimIdentity ? claimedChatgptAccountUserId ?? recordChatgptAccountUserId : recordChatgptAccountUserId ?? claimedChatgptAccountUserId) ?? buildChatGptAccountUserId(chatgptUserId, chatgptAccountId);
  const userId = preferClaimIdentity ? claimedUserId ?? recordUserId : recordUserId ?? claimedUserId;
  const issuer = preferClaimIdentity ? claimedIssuer ?? recordIssuer : recordIssuer ?? claimedIssuer;
  const claimedEmail = standardEmail ?? claimString(openAIProfileClaims(accessClaims), "email") ?? claimString(openAIProfileClaims(idClaims), "email");
  const email = preferClaimIdentity ? claimedEmail ?? recordEmail : recordEmail ?? claimedEmail;
  const claimedName = standardName ?? claimString(openAIProfileClaims(accessClaims), "name") ?? claimString(openAIProfileClaims(idClaims), "name");
  const name = preferClaimIdentity ? claimedName ?? recordName : recordName ?? claimedName;
  const claimedPlanType = claimString(accessAuthClaims, "chatgpt_plan_type") ?? claimString(accessAuthClaims, "plan_type") ?? claimString(accessClaims, "chatgpt_plan_type") ?? claimString(accessClaims, "plan_type") ?? claimString(idAuthClaims, "chatgpt_plan_type") ?? claimString(idAuthClaims, "plan_type") ?? claimString(idClaims, "chatgpt_plan_type") ?? claimString(idClaims, "plan_type");
  const recordPlanType = firstString(records, ["plan_type", "planType", "chatgpt_plan_type", "chatgptPlanType"]);
  const planType = preferClaimIdentity ? claimedPlanType ?? recordPlanType : recordPlanType ?? claimedPlanType;
  const claimedWorkspaceId = claimString(accessClaims, "workspace_id") ?? claimString(accessAuthClaims, "workspace_id") ?? claimString(idClaims, "workspace_id") ?? claimString(idAuthClaims, "workspace_id");
  const recordWorkspaceId = firstString(records, ["workspace_id", "workspaceId"]);
  const workspaceId = preferClaimIdentity ? claimedWorkspaceId ?? recordWorkspaceId : recordWorkspaceId ?? firstClaimString(identityClaimRecords, ["workspace_id"]) ?? firstClaimString(authClaimRecords, ["workspace_id"]);
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
      expiresAt
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
    inputFormat: candidate.inputFormat
  };
}
function normalizeTimeValue(value) {
  if (value === void 0 || value === null || value === "") {
    return void 0;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return new Date(value > 1e12 ? value : value * 1e3).toISOString();
  }
  if (typeof value !== "string") {
    return void 0;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return void 0;
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
function normalizeInputTimeValue(value, preserveRaw) {
  return preserveRaw ? emptyToUndefined(value) : normalizeTimeValue(value);
}
function emptyToUndefined(value) {
  const trimmed = value?.trim();
  return trimmed || void 0;
}
function firstBoolean(records, keys) {
  for (const record of records) {
    for (const key of keys) {
      const value = record[key];
      if (typeof value === "boolean") {
        return value;
      }
    }
  }
  return void 0;
}
function firstNumber(records, keys) {
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
  return void 0;
}
function firstStringRecord(records, key) {
  for (const record of records) {
    const value = record[key];
    if (!isRecord(value)) {
      continue;
    }
    const entries = Object.entries(value).filter((entry) => typeof entry[1] === "string");
    return Object.fromEntries(entries);
  }
  return void 0;
}
function providerFromIssuer(issuer) {
  if (issuer === XAI_ISSUER) {
    return "xai";
  }
  if (issuer === OPENAI_ISSUER) {
    return "openai";
  }
  return void 0;
}
function parseGrokAuthKey(value) {
  if (!value) return void 0;
  const [issuer, clientId, userId, ...extra] = value.split("::");
  if (!issuer || extra.length > 0) return void 0;
  return {
    issuer,
    clientId: clientId || void 0,
    userId: userId || void 0
  };
}
function providerFromStructure(candidate, records) {
  if (candidate.inputFormat === "grok") {
    return "xai";
  }
  if (candidate.inputFormat === "session" || candidate.inputFormat === "codex" || candidate.inputFormat === "codexmanager" || candidate.inputFormat === "codex2api") {
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
    "chatgptUserId"
  ]);
  if (issuer === XAI_ISSUER || tokenEndpoint === XAI_TOKEN_ENDPOINT) {
    return "xai";
  }
  if (issuer === OPENAI_ISSUER || Boolean(openAiAccountId)) {
    return "openai";
  }
  return void 0;
}
function firstClaimString(records, keys) {
  for (const record of records) {
    const value = firstString([record], keys);
    if (value) {
      return value;
    }
  }
  return void 0;
}
function firstClaimNumber(records, key) {
  for (const record of records) {
    const value = claimNumber(record, key);
    if (value !== void 0) {
      return value;
    }
  }
  return void 0;
}
function firstClaimStringArray(records, key) {
  for (const record of records) {
    const value = claimStringArray(record, key);
    if (value) {
      return value;
    }
  }
  return void 0;
}
function buildChatGptAccountUserId(userId, accountId) {
  if (!userId || !accountId) {
    return void 0;
  }
  return `${userId}__${accountId}`;
}
function splitChatGptAccountUserId(value) {
  if (!value) {
    return void 0;
  }
  const separator = "__";
  const index = value.lastIndexOf(separator);
  if (index <= 0 || index + separator.length >= value.length) {
    return void 0;
  }
  return {
    userId: value.slice(0, index),
    accountId: value.slice(index + separator.length)
  };
}
function buildSyntheticClaims(input) {
  const sub = input.chatgptUserId ?? input.userId ?? claimString(input.claims, "sub");
  const exp = input.expiresAt ? Math.floor(new Date(input.expiresAt).getTime() / 1e3) : claimNumber(input.claims, "exp");
  if (!input.email && !input.chatgptAccountId && !input.chatgptUserId && !sub && !input.planType) {
    return void 0;
  }
  const auth = {};
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
  const claims = {};
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

// src/jwks/openai.json
var openai_default = {
  keys: [
    {
      use: "sig",
      kty: "RSA",
      kid: "b1dd3f8f-9aad-47fe-b0e7-edb009777d6b",
      alg: "RS256",
      n: "zz1xoCBFP1QyV2yjPVmLqfUbn3p8D5UpjClZ8FeQfVJdWtJUohw2yQoz_aX3MWLwbph31w7dQoMV7T_NG6zL-rRsBEnd-D0K5qtixHVaqZgtGKF_bhrgQSSq1O9WkfOX8PCQ64gBfnFIVJ7_9Oc6Tt6M_DqAky4tXyWyKaz6Ll4ABz36MoLSVd6wqUT64ZOlpdVoqeETZjIv0RmoIz4a7M7vBdaUq2kHBKoNtEOugfgX0dGmhxcJhm7dKtMTgGZN1UuA47lC-5KQ7_JdS2mHx8n3GrmpCPUE3aG2SFZQOnMrhMrV7JlkpJQt5MxEBnf78_Y6hyxL7gavdpfpalZOoOi0I9sb5uRmLfWv15sG9_OTwo3xso_7eeqNJdz_HG_zaTu0_281v_wo0dJK9_jeQbKHsOneB7tPFO-Gas_JIysq7p5LE-FChXRBWbRaexasu0kYkJVbQ-m1UK0crmQHfVaFfE-3SNCJyU7cQj5R34ExyXB7MkSpim4o3male_xaKzu6RJi5fjecpwmDwGKm3ZgXcs9RHlXrGbdeo0COl-Sw8CTL7P2uaypFEoR2-W4Hy6TfrRJiAywuKD4V5K3ew4JehU8fbpwrLbEtLjlrvglirZWiQHbeMLfedJyDnFPe2Pnap603-r09TBf57TKhUvhI5XHeh7UTeS1wNCKsp_M",
      e: "AQAB"
    },
    {
      use: "sig",
      kty: "RSA",
      kid: "a770fca0-e81e-4c08-a827-1d4d4d2b1cc4",
      alg: "RS256",
      n: "w07rYLg3d2saF_BeapxdAnNR2YjWHZKeTePWYqS4UorO9bcCjQMgTZS8IFyzmvBpPKLEQBBJv_RZQa7c46i2Jvo10PeYyJxbxPG013-PQyerN0_UcuRrXCQSq77k6g6stCNX6IrAH0hyCJOghYtIVAePF7fZoTcbXT7jxvgwRDRCBPcOnOdr5soMqMAas0Tf3LtCAGAYwg5hfXjNIGOkGVyTc6ndF0QPiBziFNbDxphgD4WY85D3QaLQ9qvC-3A1RWNSt45yMIvpMZSoycOQ95BW_JS_e5y_VLbvBrT1xWmpx3vi5UoQ-DMQKJwblCOCtQeNe7Atn0f0f2HV8Zf0aignciLP9k9A8vG-fRcZ1qLHNMv3X3yWQYiUrmrcZp1f3zWV6Gg9rGkVLrOCJyEEtP44-9Pqgh-M9dS_Z9KAd6c1TcLYL8WO8V-HOc-b7cz4LyIpSgJRffvi0IVnDviu8DdzIOYSQywNd__LNzTmgiTJmmrYctgCQYAkna7D_xAr9_K_h1QT4DzNCtf_-yEUzjR-KwI1xr9AJWRgMx0A1kQsqiOoiDAPkThe1m3NOI5xsx6xAdQANAngg4R5l1pRLksyXsfs_PG_ZvtZnZCNgqOzZw4X4Ju67ey_MGUUThg9gignMgHBZ4F4MuZPHFv_FIVpIIdcU2wVgu2LLbwS39s",
      e: "AQAB"
    },
    {
      use: "sig",
      kty: "RSA",
      kid: "19344e65-bbc9-44d1-a9d0-f957b079bd0e",
      alg: "RS256",
      n: "7qpAEcFo6hMg6ka4UOrF6Y19A1phOls8wYiAU2TuuPZVNiZEYA40PIDUaYweWXhN5Hm86Itxs5cnJVHGf9NeZIdcg6lG3U2i6wwTCBepPbafaaml275d2sUdkRZF6UcKk3hY1oFNuoBFs4AdA1n5qWKpxzld8rJTMbDGn1TLfI3bcspBlkvvASaQZFtFoacjB9pP2ibUx_mIznNr-V4-Ez0EqAmpKPFoBc9-5r4dVglpWh7Ug4CLMJ4zmwzcsbE7Gw9xZbW-jKCOgWbhgCCWAv-qvENrToSfSfT3FzqxVCAYwn91v23yyYMqcjp8xOJpPJLA-xWAGbYE233C1KX0haBt0oFZQAo_4768a_VsGLTMPXAlcNKPsYPuptlzgxJIZyIXfi2cSlzJopEsB9DKHnSOVFcAijBZHjlo2mZylpa5PW1npgV_yg29F_--r7Mr4PGNEPgDxFMH80Rf_OpljVEU941fiKOEuijQhssdRJvRPO0mIOo92cmW4drEJfN8uQq0u81RrMe0oxiyh_xNM6qQ4Mwn2AM2rS9gd99Foia_Fg7HLyYwj8rcgDzgFRygjTWXW8s-FN3zrAuIztzXVWxuK0O6KgEj8-h4OgiHpg30dQYK8M9Sy5xbb-1BXmaRDY-h0L4uf8QojC_yL0GSpoh_0uBwTZ8oCc13IUFdbfU",
      e: "AQAB"
    },
    {
      kty: "RSA",
      kid: "ae6795dc-4bae-418a-865d-08a6439eeda6",
      use: "sig",
      alg: "RS256",
      n: "tsLCylOJiNumHPB4HYTC514l-htGMZ2nOMykqzGkzaHjyVcs5YGabbdbz8ZFjYacbyqmEKszydCFofJKmyTaJ5-bLtAka3W8eEzm69xSuHRza8EM5xDcG9HPmkZRIoUI9uGuOAyikoi6JrEsmHROwRTTxnOeQgB1P6GOrlGOnF1qBUkMfxBaYOWQhBsB24YSE8f7HQFG4bSFG4t7_2cnJiCCbK0bLEltc0q8-B_96SHy47oAIh7ZUQBXOfxdJbdqHNk43deBP5yKp5RiteRubNdScfyYdHzN6LDoxtBdsoG9ZISrAWwSvnaOx_RrwtA4johy5YuimThVpUqON7Ka4w73xanUQ-oYyGysqQhaEtdL4Jsz1sxPt9nfoQ6Fvm7amopuR7e3MNpBzu4QifhbeC9q9h3mNBLkoKgr5fUuWDd0QDwucQPhfXI7gIPH5kEBqh1TB1t1CV5hSFfz0516cXR28KSvGCoqx9JsVcAVq11oeBhtRRTaLgniStfEMhL-XI3pslXCrhdbTL8rWHAERmaYuG56wrehOA5pSKnIMwGFWM7kjOwuU57O3dX_Z9Ic4w05krUptn4SmPGNgAAv2398n-KBfbCmjo-kNSDHqr00eFrg8AEqVLbALFpb9xoAYficOXLlcoz-A4XhoG4qOli7K2dxNAH56yXvlM5zozc",
      e: "AQAB"
    },
    {
      kty: "RSA",
      kid: "Wc77WDKVNCv7VXHljeHsf6YR1a3r72lX2xItosiQx4w",
      use: "sig",
      alg: "RS256",
      n: "w_xMOdMtju_dY_m1GyoIJbA3s1o2cWyE356nOUQRoz3PL90owcfGAD72OwpqkcJLdenm-Lp7BDJ-PUOeQg0g0IiVksYrO1MBKfOFq4LS1nIfdAOu7qARONi965sVYytBYfeNxJEie3N-yFq5exI1w28ACNRhvq5MwTBcWhVkbd1fNa5Eddn70ittWCnuFRIxK2gFxJDBwzFD2lkSo8fpz_RiAKXGWAhcqTnZgw5AC_2ODcHDAK3wrCfg3g2mYKVPVAcAM6UWqUp5gus3R4k64H0UcJUp7u0w67ZjreqXU83vWD_NJI_ehi1wmLsNqqObHsq4ywE34OYIbdVtmtrgJQ",
      e: "AQAB"
    },
    {
      kty: "RSA",
      use: "sig",
      n: "27rOErDOPvPc3mOADYtQBeenQm5NS5VHVaoO_Zmgsf1M0Wa_2WgLm9jX65Ru_K8Az2f4MOdpBxxLL686ZS-K7eJC_oOnrxCRzFYBqQbYo-JMeqNkrCn34yed4XkX4ttoHi7MwCEpVfb05Qf_ZAmNI1XjecFYTyZQFrd9LjkX6lr05zY6aM_-MCBNeBWp35pLLKhiq9AieB1wbDPcGnqxlXuU_bLgIyqUltqLkr9JHsf_2T4VrXXNyNeQyBq5wjYlRkpBQDDDNOcdGpx1buRrZ2hFyYuXDRrMcR6BQGC0ur9hI5obRYlchDFhlb0ElsJ2bshDDGRk5k3doHqbhj2IgQ",
      e: "AQAB",
      kid: "MThENUJGNEM1QTE4M0FBMjdCNTg5MDU1RTUwQUJDMEMwRkFEQkEzRg",
      x5t: "MThENUJGNEM1QTE4M0FBMjdCNTg5MDU1RTUwQUJDMEMwRkFEQkEzRg",
      x5c: [
        "MIIC+zCCAeOgAwIBAgIJLlfMWYK8snRdMA0GCSqGSIb3DQEBCwUAMBsxGTAXBgNVBAMTEG9wZW5haS5hdXRoMC5jb20wHhcNMjAwMjExMDUyMjI5WhcNMzMxMDIwMDUyMjI5WjAbMRkwFwYDVQQDExBvcGVuYWkuYXV0aDAuY29tMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA27rOErDOPvPc3mOADYtQBeenQm5NS5VHVaoO/Zmgsf1M0Wa/2WgLm9jX65Ru/K8Az2f4MOdpBxxLL686ZS+K7eJC/oOnrxCRzFYBqQbYo+JMeqNkrCn34yed4XkX4ttoHi7MwCEpVfb05Qf/ZAmNI1XjecFYTyZQFrd9LjkX6lr05zY6aM/+MCBNeBWp35pLLKhiq9AieB1wbDPcGnqxlXuU/bLgIyqUltqLkr9JHsf/2T4VrXXNyNeQyBq5wjYlRkpBQDDDNOcdGpx1buRrZ2hFyYuXDRrMcR6BQGC0ur9hI5obRYlchDFhlb0ElsJ2bshDDGRk5k3doHqbhj2IgQIDAQABo0IwQDAPBgNVHRMBAf8EBTADAQH/MB0GA1UdDgQWBBSzpMyU3UZWR9zdv+ckg/L6GZCcJDAOBgNVHQ8BAf8EBAMCAoQwDQYJKoZIhvcNAQELBQADggEBAEuUscoo1BZmCUZG8TEki0NHFjv08u2SHdcMU1xR0PfyKY6h+pLrSrGq8kYfjCHb/OPt0+Han0fiGRTnKurQ/u1leuJ7qHVHRILmP3e1MC8PUELjHpBo3f38Kk6UlbR5pbL5K7ZHeEO6CLNTOg54xLY/6e2ben4wv/LP39E6Gg56+iT/goJHkV64+nu3v3dTmj+uSHWfkq93oG5tsOk2nTN4UCpyT5fWGv4eh7q2cKElMQM5GT/uZnCjEdDmJU2M11k6Ttg+FMNPgvH6R4e+lqhtmslXwXv9Xm95eS6JokJaYUimNX+dzhD+eRq+88vGJO63safkEyGvifAMJFPwO78="
      ],
      alg: "RS256"
    },
    {
      kty: "RSA",
      use: "sig",
      n: "t19_7MrO5Anrdz2Gp0Is0YVIiMqf2KTrxMYtaFd1VeGfcK8oHreRQts_J0kvPiv6uCGYEbP42zBy6xIORZ4X3tXrFltlbJ8nqisIsmBJWLawc5ZJrL343UiER1s13EnX-E8Am8SOclVlm4iTUL8digkgpkYR_kaERbGfoNu_FcJDIp9QKiosQndeUJ7G3GFM6YE6JUAjI-Lts2JfU9f-gxCNsy_GLPxgztUa_27IIF8DeHpHKvwBpjpmkMa7-fyRfzDFevoNenjy1gFBJ9lDfxxsU0h-H_7wcFRue0WVhQjJINSlRJhZ_0bjnovX2NxsakbOSUgo68iigivAh9nHnQ",
      e: "AQAB",
      kid: "VBa17dYHhNL_qI_QSOr28",
      x5t: "HORclA3mxoLqhdRkjgsWxYoMZfY",
      x5c: [
        "MIIC+zCCAeOgAwIBAgIJN0bbVfFgOve6MA0GCSqGSIb3DQEBCwUAMBsxGTAXBgNVBAMTEG9wZW5haS5hdXRoMC5jb20wHhcNMjAwMzExMTU0NDMxWhcNMzMxMTE4MTU0NDMxWjAbMRkwFwYDVQQDExBvcGVuYWkuYXV0aDAuY29tMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAt19/7MrO5Anrdz2Gp0Is0YVIiMqf2KTrxMYtaFd1VeGfcK8oHreRQts/J0kvPiv6uCGYEbP42zBy6xIORZ4X3tXrFltlbJ8nqisIsmBJWLawc5ZJrL343UiER1s13EnX+E8Am8SOclVlm4iTUL8digkgpkYR/kaERbGfoNu/FcJDIp9QKiosQndeUJ7G3GFM6YE6JUAjI+Lts2JfU9f+gxCNsy/GLPxgztUa/27IIF8DeHpHKvwBpjpmkMa7+fyRfzDFevoNenjy1gFBJ9lDfxxsU0h+H/7wcFRue0WVhQjJINSlRJhZ/0bjnovX2NxsakbOSUgo68iigivAh9nHnQIDAQABo0IwQDAPBgNVHRMBAf8EBTADAQH/MB0GA1UdDgQWBBTKAjp+X0GRNlQvzQdwyQrfeot2WjAOBgNVHQ8BAf8EBAMCAoQwDQYJKoZIhvcNAQELBQADggEBAJ9lpSTfG5lrCsssTjduvcmLCVliC+zx99uD8oEESF4nsZvT/iPddAJ9OqL226GMP794CA/rC0autgvJrCnQmZ2K3YIQbHnoZuzI168o9OOjuYF0URhGAp00xhD95mA0BMC2Hx3e6/UsSEUw/x4aOXdywAGMMWgFHoJz+aklw5B73F79xMPRF44xLFgn9D/NpQodpOsA7RKF3Af09etuiMIY9hQr7HI8Nzke0bt8ELB6hSMoS1QdKzgkFL4P1B/6xzakySvgqNmbJ+6aQTvSJY0DjHdIL5P5lvcOOWFr4aBnzN2AHAKi/RBHd++snUNEpIgnhRuAGO+BMg+yub9BezA="
      ],
      alg: "RS256"
    },
    {
      kty: "RSA",
      kid: "670486cc-8c9e-4fb0-aff9-2b25b6ed73ee",
      use: "sig",
      alg: "RS256",
      n: "wxxs_4cB_I-eyN7HG82YwEPUNDib4W44_MstsC_iqnIoSZNGU0JDX0MN16JjBh6WrfEh1Cjz4EBReuwlDRSQpmt74N0G7ObNs41n4SNFyzkMZtqP-qkZdvhcsg9eh4C6LCAg1MZqIBIvpoezb_bwDAhUfR7qCGRAIawbf2wklmyLz5DERBeQohzuaeliqcGGTW4QmqCH9SrEIZxzhtZWSfc76fS_ot11lUAqAGrWtAPxAjFz1ULZIRQcsS0jDKxhoeAwYSqKC6qQsQuJBkgyQOGO7lxyitNjtG5Xlx0hwNOnLrhGENIyH2iOlrGfE_AVy1J0mg_lsm__qbFaEcvzcQ",
      e: "AQAB"
    }
  ]
};

// src/jwks/xai.json
var xai_default = {
  keys: [
    {
      kty: "EC",
      crv: "P-256",
      use: "sig",
      alg: "ES256",
      kid: "oauth2-production-2026-02-19",
      x: "-m5WdZbaehSO0yesg3a9FsZV1m-F5uQSIO87UBwA8Nk",
      y: "_-hhOxLm_1V83mLmXv83rYS7u_Hli3Okv56THqf9YCg"
    }
  ]
};

// src/token-verification.ts
var OPENAI_CONTRACT = {
  provider: "openai",
  issuer: "https://auth.openai.com",
  algorithm: "RS256",
  expectedAudience: "https://api.openai.com/v1",
  jwks: openai_default
};
var XAI_CONTRACT = {
  provider: "xai",
  issuer: "https://auth.x.ai",
  algorithm: "ES256",
  jwks: xai_default
};
var DEFAULT_CONCURRENCY = 32;
var PROGRESS_INTERVAL = 250;
var TokenVerifier = class {
  #keyCache = /* @__PURE__ */ new Map();
  #resultCache = /* @__PURE__ */ new Map();
  #contractIds = /* @__PURE__ */ new WeakMap();
  #nextContractId = 1;
  verifyAccount(account, options = {}) {
    if (options.verify === false) {
      return Promise.resolve(unchecked(account));
    }
    if (options.reuseExisting) {
      const existing = reusableAccessTokenVerification(account, options.now);
      if (existing) return Promise.resolve(existing);
    }
    if (account.provider === "unknown") {
      return Promise.resolve(classified(account.provider, "unverifiable", "unknown_provider"));
    }
    if (!account.accessToken) {
      return Promise.resolve(classified(account.provider, "unverifiable", "missing_access_token"));
    }
    if (!looksLikeJwt(account.accessToken)) {
      return Promise.resolve(classified(account.provider, "unverifiable", "opaque_access_token"));
    }
    const contract = contractFor(account);
    return this.verifyToken(account.accessToken, contract, options);
  }
  verifyToken(token, contract, options = {}) {
    const contractId = this.#contractId(contract);
    const contextKey = [
      contract.provider,
      contract.issuer,
      contract.algorithm,
      contract.expectedAudience ?? "",
      contractId
    ].join("\n");
    let byContext = this.#resultCache.get(token);
    if (!byContext) {
      byContext = /* @__PURE__ */ new Map();
      this.#resultCache.set(token, byContext);
    }
    let result = byContext.get(contextKey);
    if (!result) {
      result = verifyWithCaches(token, contract, options.now ?? Date.now(), contractId, this.#keyCache);
      byContext.set(contextKey, result);
    }
    return result;
  }
  clearResultCache() {
    this.#resultCache.clear();
  }
  #contractId(contract) {
    let id = this.#contractIds.get(contract);
    if (id === void 0) {
      id = this.#nextContractId;
      this.#nextContractId += 1;
      this.#contractIds.set(contract, id);
    }
    return id;
  }
  async verifyAccounts(accounts, options = {}) {
    const results = new Array(accounts.length);
    const concurrency = Math.max(1, Math.min(
      accounts.length || 1,
      Math.trunc(options.concurrency ?? DEFAULT_CONCURRENCY)
    ));
    let nextIndex = 0;
    let completed = 0;
    await Promise.all(Array.from({ length: concurrency }, async () => {
      while (true) {
        throwIfAborted2(options.signal);
        const index = nextIndex;
        nextIndex += 1;
        if (index >= accounts.length) return;
        results[index] = await this.verifyAccount(accounts[index], options);
        throwIfAborted2(options.signal);
        completed += 1;
        if (completed % PROGRESS_INTERVAL === 0) {
          options.onProgress?.(completed, accounts.length);
          if (options.yieldControl) await options.yieldControl();
        } else if (completed === accounts.length) {
          options.onProgress?.(completed, accounts.length);
        }
      }
    }));
    return results;
  }
};
function applyAccessTokenVerification(account, result) {
  account.tokenVerification = result.verification;
  account.tokenVerificationContext = result.context;
}
function reusableAccessTokenVerification(account, now = Date.now()) {
  const verification = account.tokenVerification;
  const context = account.tokenVerificationContext;
  if (!verification || !context || verification.status === "unchecked") return void 0;
  if (!sameVerificationContext(context, expectedVerificationContext(account))) return void 0;
  if (verification.notBeforeActive && account.notBefore && Date.parse(account.notBefore) <= now) {
    const { notBeforeActive: _notBeforeActive, ...activeVerification } = verification;
    return { verification: activeVerification, context };
  }
  return { verification, context };
}
async function verifyWithCaches(token, contract, now, contractId, keyCache) {
  const context = verificationContext(contract);
  const parsed = parseSignedJwt(token);
  if (!parsed) {
    return withContext("forged", "malformed_jwt", context);
  }
  const algorithm = stringValue(parsed.header.alg);
  if (algorithm !== contract.algorithm) {
    return withContext("forged", "algorithm_rejected", context, {
      algorithm: supportedAlgorithm(algorithm),
      kid: stringValue(parsed.header.kid)
    });
  }
  if (contract.provider === "xai" && parsed.header.typ !== XAI_ACCESS_TOKEN_TYPE) {
    return withContext("forged", "token_type_mismatch", context, {
      algorithm,
      kid: stringValue(parsed.header.kid)
    });
  }
  const kid = stringValue(parsed.header.kid);
  const jwk = kid ? matchingJwk(contract, kid) : void 0;
  if (!kid || !jwk) {
    return withContext("unverifiable", "unknown_kid", context, { algorithm, kid });
  }
  const keyId = `${contractId}
${kid}`;
  let key = keyCache.get(keyId);
  if (!key) {
    key = crypto.subtle.importKey(
      "jwk",
      jwk,
      importAlgorithm(contract.algorithm),
      false,
      ["verify"]
    );
    keyCache.set(keyId, key);
  }
  const validSignature = await crypto.subtle.verify(
    verifyAlgorithm(contract.algorithm),
    await key,
    parsed.signature,
    new TextEncoder().encode(parsed.signingInput)
  );
  if (!validSignature) {
    return withContext("forged", "signature_failed", context, { algorithm, kid });
  }
  if (parsed.payload.iss !== contract.issuer) {
    return withContext("forged", "issuer_mismatch", context, { algorithm, kid });
  }
  if (contract.expectedAudience && !audienceIncludes(parsed.payload.aud, contract.expectedAudience)) {
    return withContext("forged", "audience_mismatch", context, { algorithm, kid });
  }
  const notBefore = typeof parsed.payload.nbf === "number" && Number.isFinite(parsed.payload.nbf) ? parsed.payload.nbf * 1e3 : void 0;
  return withContext("verified", "signature_valid", context, {
    algorithm,
    kid,
    notBeforeActive: notBefore !== void 0 && notBefore > now ? true : void 0
  });
}
function contractFor(account) {
  if (account.provider === "openai") return OPENAI_CONTRACT;
  return XAI_CONTRACT;
}
function unchecked(account) {
  const contract = account.provider === "unknown" ? void 0 : contractFor(account);
  return withContext(
    "unchecked",
    "user_disabled",
    contract ? verificationContext(contract) : { provider: account.provider }
  );
}
function classified(provider, status, reason) {
  return withContext(status, reason, { provider });
}
function withContext(status, reason, context, details = {}) {
  return {
    verification: {
      status,
      reason,
      tokenField: "accessToken",
      ...details
    },
    context
  };
}
function verificationContext(contract) {
  return {
    provider: contract.provider,
    issuer: contract.issuer,
    algorithm: contract.algorithm,
    expectedAudience: contract.expectedAudience
  };
}
function expectedVerificationContext(account) {
  if (account.provider === "unknown" || !account.accessToken || !looksLikeJwt(account.accessToken)) {
    return { provider: account.provider };
  }
  return verificationContext(contractFor(account));
}
function sameVerificationContext(left, right) {
  return left.provider === right.provider && left.issuer === right.issuer && left.algorithm === right.algorithm && left.expectedAudience === right.expectedAudience;
}
function matchingJwk(contract, kid) {
  return contract.jwks.keys.find(
    (key) => key.kid === kid && key.alg === contract.algorithm && (!key.use || key.use === "sig") && (contract.algorithm === "RS256" ? key.kty === "RSA" : key.kty === "EC" && key.crv === "P-256")
  );
}
function importAlgorithm(algorithm) {
  return algorithm === "RS256" ? { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" } : { name: "ECDSA", namedCurve: "P-256" };
}
function verifyAlgorithm(algorithm) {
  return algorithm === "RS256" ? { name: "RSASSA-PKCS1-v1_5" } : { name: "ECDSA", hash: "SHA-256" };
}
function parseSignedJwt(token) {
  const parts = token.split(".");
  if (parts.length !== 3 || !parts[0] || !parts[1]) return void 0;
  try {
    const decoder = new TextDecoder("utf-8", { fatal: true });
    const header = JSON.parse(decoder.decode(base64urlBytes(parts[0])));
    const payload = JSON.parse(decoder.decode(base64urlBytes(parts[1])));
    if (!isRecord(header) || !isRecord(payload)) return void 0;
    return {
      header,
      payload,
      signingInput: `${parts[0]}.${parts[1]}`,
      signature: toArrayBuffer(base64urlBytes(parts[2]))
    };
  } catch {
    return void 0;
  }
}
function base64urlBytes(value) {
  if (value.length % 4 === 1 || !/^[A-Za-z0-9_-]*$/.test(value)) {
    throw new Error("Invalid base64url");
  }
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = normalized.padEnd(normalized.length + (4 - normalized.length % 4) % 4, "=");
  if (typeof Buffer !== "undefined") return new Uint8Array(Buffer.from(padded, "base64"));
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}
function toArrayBuffer(value) {
  return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
}
function audienceIncludes(value, expected2) {
  return value === expected2 || Array.isArray(value) && value.includes(expected2);
}
function stringValue(value) {
  return typeof value === "string" && value.length > 0 ? value : void 0;
}
function supportedAlgorithm(value) {
  return value === "RS256" || value === "ES256" ? value : void 0;
}
function looksLikeJwt(token) {
  return token.split(".").length === 3;
}
function throwIfAborted2(signal) {
  if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
}

// src/ingestion.ts
async function ingestSources(sources, store, options) {
  const diagnostics = [];
  const batches = /* @__PURE__ */ new Map();
  const committedFormats = /* @__PURE__ */ new Set();
  const previewAccounts = [];
  const storeChanges = { processed: 0, added: 0, merged: 0, skippedForged: 0 };
  let processedSources = 0;
  let processedCandidates = 0;
  let verifiedCandidates = 0;
  let checkpointDiagnosticCount = 0;
  const verifier = options.tokenVerifier ?? new TokenVerifier();
  try {
    for await (const event of parseInputSources(sources, options.parseTokens, options.signal)) {
      throwIfAborted3(options.signal);
      if (event.type === "discard") {
        batches.delete(event.batchId);
        diagnostics.push(event.diagnostic);
        publishCheckpoint();
        report("parse");
        continue;
      }
      if (event.type === "commit") {
        const batch2 = batches.get(event.batchId);
        batches.delete(event.batchId);
        processedSources += 1;
        if (batch2) {
          const verificationBase = verifiedCandidates;
          const results = await verifier.verifyAccounts(batch2.accounts, {
            verify: options.verifyTokens !== false,
            signal: options.signal,
            yieldControl: options.yieldControl,
            onProgress: (completed) => {
              verifiedCandidates = verificationBase + completed;
              report("verify");
            }
          });
          for (let index = 0; index < batch2.accounts.length; index += 1) {
            applyAccessTokenVerification(batch2.accounts[index], results[index]);
          }
          const acceptedAccounts = options.discardForged ? batch2.accounts.filter((account) => account.tokenVerification?.status !== "forged") : batch2.accounts;
          if (options.commit === false) {
            for (const account of acceptedAccounts) previewAccounts.push(account);
          } else {
            const changes = commitIngestedAccounts(store, batch2.accounts, options.discardForged === true);
            mergeStoreChanges(storeChanges, changes);
          }
          for (const format of batch2.formats) committedFormats.add(format);
        }
        publishCheckpoint();
        report("store");
        continue;
      }
      const batch = batches.get(event.batchId) ?? { accounts: [], formats: /* @__PURE__ */ new Set() };
      batches.set(event.batchId, batch);
      for (const item of event.items) {
        const selectedFormat = options.inputFormat && options.inputFormat !== "unknown" ? options.inputFormat : item.inputFormat;
        const candidates = extractCandidatesFromValue(
          item.value,
          { sourceName: event.sourceName, sourcePath: item.sourcePath },
          selectedFormat
        );
        if (candidates.length === 0) {
          diagnostics.push({
            code: selectedFormat ? "input_format_mismatch" : "no_credential_tokens",
            sourceName: event.sourceName,
            sourcePath: item.sourcePath,
            detail: selectedFormat
          });
          continue;
        }
        for (const candidate of candidates) {
          processedCandidates += 1;
          if (options.yieldControl && processedCandidates % 512 === 0) {
            await options.yieldControl();
            throwIfAborted3(options.signal);
          }
          const account = normalizeCandidate(candidate, processedCandidates - 1);
          if (!account) {
            diagnostics.push({
              code: "no_credential_tokens",
              sourceName: candidate.sourceName,
              sourcePath: candidate.sourcePath
            });
            continue;
          }
          batch.accounts.push(account);
          batch.formats.add(candidate.inputFormat);
        }
      }
      report("normalize");
    }
    if (processedSources === 0 && diagnostics.length === 0) {
      diagnostics.push({
        code: "unsupported_input",
        sourceName: "input",
        sourcePath: "input"
      });
    }
    return {
      store,
      diagnostics,
      inputFormat: commonInputFormat(committedFormats),
      processedSources,
      processedCandidates,
      previewAccounts,
      storeChanges
    };
  } finally {
    verifier.clearResultCache();
  }
  function report(phase) {
    options.onProgress?.({
      phase,
      processedSources,
      processedCandidates,
      verifiedCandidates,
      storedAccounts: store.size
    });
  }
  function publishCheckpoint() {
    if (options.commit === false || !options.onCheckpoint) return;
    const diagnosticsAdded = diagnostics.slice(checkpointDiagnosticCount);
    checkpointDiagnosticCount = diagnostics.length;
    options.onCheckpoint({
      diagnosticsAdded,
      inputFormat: commonInputFormat(committedFormats),
      storeChanges: { ...storeChanges }
    });
  }
}
function commitIngestedAccounts(store, accounts, discardForged) {
  const accepted = discardForged ? accounts.filter((account) => account.tokenVerification?.status !== "forged") : accounts;
  const changes = store.commitSource(accepted);
  changes.processed = accounts.length;
  changes.skippedForged = accounts.length - accepted.length;
  return changes;
}
function mergeStoreChanges(target, source) {
  target.processed += source.processed;
  target.added += source.added;
  target.merged += source.merged;
  target.skippedForged += source.skippedForged;
  target.firstAffectedId ??= source.firstAffectedId;
}
function commonInputFormat(formats) {
  if (formats.size !== 1) return "unknown";
  return formats.values().next().value ?? "unknown";
}
function throwIfAborted3(signal) {
  if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
}

// node_modules/stream-chain/src/index.js
import { Readable, Writable, Duplex as Duplex2 } from "node:stream";

// node_modules/stream-chain/src/asStream.js
import { Duplex } from "node:stream";
var asStream = (fn, options) => {
  if (typeof fn != "function") {
    throw TypeError("Only a function is accepted as the first argument");
  }
  const innerFns = isFunctionList(fn) ? fn.fList : null;
  let stopped = false;
  let nullPushed = false;
  let resolvePaused = null;
  let stream = null;
  const resume = () => {
    if (!resolvePaused) return;
    const resolve = resolvePaused;
    resolvePaused = null;
    resolve();
  };
  const signalEnd = () => {
    if (nullPushed) return;
    nullPushed = true;
    stream.push(null);
  };
  const enqueue = (value) => {
    if (stopped) return;
    if (!stream.push(value)) {
      return new Promise((resolve) => {
        resolvePaused = resolve;
      });
    }
  };
  const queue = [];
  const pump = async () => {
    while (queue.length) {
      const g = queue[queue.length - 1];
      let result = g.next();
      if (result && typeof result.then == "function") result = await result;
      if (result.done) {
        queue.pop();
        continue;
      }
      let value = result.value;
      if (value && typeof value.then == "function") value = await value;
      const r = processValue(value);
      if (r) await r;
    }
  };
  const processValue = (value) => {
    if (value && typeof value.then == "function") {
      return value.then(processValue);
    }
    if (value == null || value === none) return;
    if (value === stop) throw new Stop();
    if (isMany(value)) {
      const values = getManyValues(value);
      let promise;
      for (let i = 0; i < values.length; ++i) {
        if (promise) {
          const ii = i;
          promise = promise.then(() => processValue(values[ii]));
        } else {
          const r = processValue(values[i]);
          if (r) promise = r;
        }
      }
      return promise;
    }
    if (isFinalValue(value)) {
      return processValue(getFinalValue(value));
    }
    if (value && typeof value.next == "function") {
      queue.push(value);
      return pump();
    }
    return enqueue(value);
  };
  const absorbStop = (error) => {
    if (error instanceof Stop) {
      stopped = true;
      signalEnd();
      return true;
    }
    return false;
  };
  const finishWrite = (callback, error) => {
    if (!error) return callback(null);
    if (absorbStop(error)) return callback(null);
    callback(error);
  };
  stream = new Duplex({
    writableObjectMode: true,
    readableObjectMode: true,
    ...options,
    write(chunk, encoding, callback) {
      if (stopped) return callback(null);
      if (innerFns) {
        let r2;
        try {
          r2 = next(chunk, innerFns, 0, enqueue);
        } catch (error) {
          return finishWrite(callback, error);
        }
        if (r2 && typeof r2.then == "function") {
          r2.then(
            () => callback(null),
            (error) => finishWrite(callback, error)
          );
        } else {
          callback(null);
        }
        return;
      }
      let r;
      try {
        r = processValue(fn(chunk, encoding));
      } catch (error) {
        return finishWrite(callback, error);
      }
      if (r) {
        r.then(
          () => callback(null),
          (error) => finishWrite(callback, error)
        );
      } else {
        callback(null);
      }
    },
    final(callback) {
      const onComplete = () => {
        signalEnd();
        callback(null);
      };
      if (innerFns) {
        let r2;
        try {
          r2 = flush(innerFns, 0, enqueue);
        } catch (error) {
          return finishWrite(callback, error);
        }
        if (r2 && typeof r2.then == "function") {
          r2.then(onComplete, (error) => finishWrite(callback, error));
        } else {
          onComplete();
        }
        return;
      }
      if (!isFlushable(fn)) {
        onComplete();
        return;
      }
      let r;
      try {
        r = processValue(fn(none, null));
      } catch (error) {
        return finishWrite(callback, error);
      }
      if (r) {
        r.then(onComplete, (error) => finishWrite(callback, error));
      } else {
        onComplete();
      }
    },
    read() {
      resume();
    },
    // Unblock any pending paused-promise so an in-flight write can settle —
    // mirrors asWebStream's controller.signal listener for writer.abort().
    destroy(error, callback) {
      stopped = true;
      resume();
      callback(error);
    }
  });
  return stream;
};
var asStream_default = asStream;

// node_modules/stream-chain/src/asWebStream.js
var asWebStream = (fn, options) => {
  if (isDuplexWebStream(fn) || isReadableWebStream(fn) || isWritableWebStream(fn)) {
    return fn;
  }
  if (typeof fn !== "function") {
    throw new TypeError("Only a function or Web Streams object is accepted as the first argument");
  }
  const strategy = options?.strategy;
  const readableStrategy = options?.readableStrategy ?? strategy;
  const writableStrategy = options?.writableStrategy ?? strategy;
  const innerFns = isFunctionList(fn) ? fn.fList : null;
  let stopped = false;
  let readableClosed = false;
  let writableErrored = false;
  let readableController;
  let writableController;
  let pendingDrain = null;
  const unblockDrain = () => {
    if (!pendingDrain) return;
    const resolve = pendingDrain;
    pendingDrain = null;
    resolve();
  };
  const closeReadable = () => {
    if (readableClosed) return;
    readableClosed = true;
    readableController.close();
  };
  const errorReadable = (reason) => {
    if (readableClosed) return;
    readableClosed = true;
    readableController.error(reason);
  };
  const errorWritable = (reason) => {
    if (writableErrored || !writableController) return;
    writableErrored = true;
    writableController.error(reason);
  };
  const readable = new ReadableStream(
    {
      start(c) {
        readableController = c;
      },
      pull() {
        unblockDrain();
      },
      cancel(reason) {
        stopped = true;
        readableClosed = true;
        unblockDrain();
        errorWritable(reason);
      }
    },
    readableStrategy
  );
  const enqueue = (value) => {
    if (stopped) return;
    readableController.enqueue(value);
    if (readableController.desiredSize <= 0) {
      return new Promise((resolve) => {
        pendingDrain = resolve;
      });
    }
  };
  const queue = [];
  const pump = async () => {
    while (queue.length) {
      const g = queue[queue.length - 1];
      let result = g.next();
      if (result && typeof result.then == "function") result = await result;
      if (result.done) {
        queue.pop();
        continue;
      }
      let value = result.value;
      if (value && typeof value.then == "function") value = await value;
      const r = processValue(value);
      if (r) await r;
    }
  };
  const processValue = (value) => {
    if (value && typeof value.then == "function") {
      return value.then(processValue);
    }
    if (value == null || value === none) return;
    if (value === stop) throw new Stop();
    if (isMany(value)) {
      const values = getManyValues(value);
      let promise;
      for (let i = 0; i < values.length; ++i) {
        if (promise) {
          const ii = i;
          promise = promise.then(() => processValue(values[ii]));
        } else {
          const r = processValue(values[i]);
          if (r) promise = r;
        }
      }
      return promise;
    }
    if (isFinalValue(value)) {
      return processValue(getFinalValue(value));
    }
    if (value && typeof value.next == "function") {
      queue.push(value);
      return pump();
    }
    return enqueue(value);
  };
  const absorbStop = (error) => {
    if (error instanceof Stop) {
      stopped = true;
      return true;
    }
    return false;
  };
  const writable = new WritableStream(
    {
      // `controller.signal` aborts during writer.abort() BEFORE the sink's
      // abort() callback runs. The spec waits for in-flight write() to
      // settle first — so if write() is awaiting pendingDrain, we'd
      // deadlock unless the signal listener wakes it.
      // Optional-chained because Bun ≤1.3.14 returns `undefined` for the
      // controller's signal (spec-required per WHATWG Streams §4.5.2 but
      // missing in Bun's builtin — see oven-sh/bun#31156 / PR #31157).
      // Bun loses the abort-wakeup safety net until that lands, but the
      // normal write/close/cancel paths still work.
      start(controller) {
        writableController = controller;
        controller.signal?.addEventListener("abort", () => {
          stopped = true;
          unblockDrain();
        });
      },
      async write(chunk) {
        if (stopped) return;
        try {
          if (innerFns) {
            const r2 = next(chunk, innerFns, 0, enqueue);
            if (r2) await r2;
            return;
          }
          const r = processValue(fn(chunk));
          if (r) await r;
        } catch (error) {
          if (absorbStop(error)) return;
          errorReadable(error);
          throw error;
        }
      },
      async close() {
        try {
          if (!stopped) {
            if (innerFns) {
              const r = flush(innerFns, 0, enqueue);
              if (r) await r;
            } else if (isFlushable(fn)) {
              const r = processValue(fn(none));
              if (r) await r;
            }
          }
        } catch (error) {
          if (!absorbStop(error)) {
            errorReadable(error);
            throw error;
          }
        }
        closeReadable();
      },
      abort(reason) {
        stopped = true;
        unblockDrain();
        errorReadable(reason);
      }
    },
    writableStrategy
  );
  return { readable, writable };
};
var asWebStream_default = asWebStream;

// node_modules/stream-chain/src/index.js
var {
  isReadableWebStream: isReadableWebStream2,
  isWritableWebStream: isWritableWebStream2,
  isDuplexWebStream: isDuplexWebStream2,
  isReadableNodeStream: isReadableNodeStream2,
  isWritableNodeStream: isWritableNodeStream2,
  isDuplexNodeStream: isDuplexNodeStream2
} = defs_exports;
var groupFunctions = (output, fn, index, fns) => {
  if (isDuplexNodeStream2(fn) || !index && isReadableNodeStream2(fn) || index === fns.length - 1 && isWritableNodeStream2(fn)) {
    output.push(fn);
    return output;
  }
  if (isDuplexWebStream2(fn)) {
    output.push(Duplex2.fromWeb(fn, { objectMode: true }));
    return output;
  }
  if (!index && isReadableWebStream2(fn)) {
    output.push(Readable.fromWeb(fn, { objectMode: true }));
    return output;
  }
  if (index === fns.length - 1 && isWritableWebStream2(fn)) {
    output.push(Writable.fromWeb(fn, { objectMode: true }));
    return output;
  }
  if (typeof fn != "function")
    throw TypeError("Item #" + index + " is not a proper stream, nor a function.");
  if (!output.length) output.push([]);
  const last = output[output.length - 1];
  if (Array.isArray(last)) {
    last.push(fn);
  } else {
    output.push([fn]);
  }
  return output;
};
var produceStreams = (item) => {
  if (Array.isArray(item)) {
    if (!item.length) return null;
    if (item.length == 1) return item[0] && /** @type {any} */
    chain2.asStream(item[0]);
    return (
      /** @type {any} */
      chain2.asStream(
        /** @type {any} */
        chain2.gen(...item)
      )
    );
  }
  return item;
};
var wrapFunctions = (fn, index, fns) => {
  if (isDuplexNodeStream2(fn) || !index && isReadableNodeStream2(fn) || index === fns.length - 1 && isWritableNodeStream2(fn)) {
    return fn;
  }
  if (isDuplexWebStream2(fn)) {
    return Duplex2.fromWeb(fn, { objectMode: true });
  }
  if (!index && isReadableWebStream2(fn)) {
    return Readable.fromWeb(fn, { objectMode: true });
  }
  if (index === fns.length - 1 && isWritableWebStream2(fn)) {
    return Writable.fromWeb(fn, { objectMode: true });
  }
  if (typeof fn == "function") return (
    /** @type {any} */
    chain2.asStream(fn)
  );
  throw TypeError("Item #" + index + " is not a proper stream, nor a function.");
};
var write = (input, chunk, encoding, callback) => {
  let error = null;
  try {
    input.write(chunk, encoding, (e) => callback(e || error));
  } catch (e) {
    error = e;
  }
};
var final2 = (input, callback) => {
  let error = null;
  try {
    input.end(null, null, (e) => callback(e || error));
  } catch (e) {
    error = e;
  }
};
var read = (output) => {
  output.resume();
};
var chain2 = (fns, options) => {
  if (!Array.isArray(fns) || !fns.length) {
    throw TypeError("Chain's first argument should be a non-empty array.");
  }
  fns = fns.flat(Infinity).filter((fn) => fn);
  const streams = (options?.noGrouping ? fns.map(wrapFunctions) : fns.map((fn) => isFunctionList(fn) ? getFunctionList(fn) : fn).flat(Infinity).reduce(groupFunctions, []).map(produceStreams)).filter((s) => s), input = streams[0], output = streams.reduce((output2, item) => output2 && output2.pipe(item) || item);
  let stream = null;
  let writeMethod = (chunk, encoding, callback) => write(input, chunk, encoding, callback), finalMethod = (callback) => final2(input, callback), readMethod = () => read(output);
  if (!isWritableNodeStream2(input)) {
    writeMethod = (_1, _2, callback) => callback(null);
    finalMethod = (callback) => callback(null);
    input.on("end", () => stream.end());
  }
  if (isReadableNodeStream2(output)) {
    output.on("data", (chunk) => !stream.push(chunk) && output.pause());
    output.on("end", () => stream.push(null));
  } else {
    readMethod = () => {
    };
    output.on("finish", () => stream.push(null));
  }
  stream = /** @type {Duplex & {streams: any[], input: any, output: any}} */
  new Duplex2({
    writableObjectMode: true,
    readableObjectMode: true,
    ...options,
    readable: isReadableNodeStream2(output),
    writable: isWritableNodeStream2(input),
    write: writeMethod,
    final: finalMethod,
    read: readMethod
  });
  stream.streams = streams;
  stream.input = input;
  stream.output = output;
  if (!isReadableNodeStream2(output)) {
    stream.resume();
  }
  if (!options?.skipEvents) {
    streams.forEach((item) => item.on("error", (error) => stream.emit("error", error)));
  }
  return stream;
};
chain2.none = none;
chain2.stop = stop;
chain2.Stop = Stop;
chain2.finalSymbol = finalSymbol;
chain2.finalValue = finalValue;
chain2.final = final;
chain2.isFinalValue = isFinalValue;
chain2.getFinalValue = getFinalValue;
chain2.manySymbol = manySymbol;
chain2.many = many;
chain2.isMany = isMany;
chain2.getManyValues = getManyValues;
chain2.flushSymbol = flushSymbol;
chain2.flushable = flushable;
chain2.isFlushable = isFlushable;
chain2.fListSymbol = fListSymbol;
chain2.isFunctionList = isFunctionList;
chain2.getFunctionList = getFunctionList;
chain2.setFunctionList = setFunctionList;
chain2.clearFunctionList = clearFunctionList;
chain2.toMany = toMany;
chain2.normalizeMany = normalizeMany;
chain2.combineMany = combineMany;
chain2.combineManyMut = combineManyMut;
chain2.chain = chain2;
chain2.chainUnchecked = chain2;
chain2.gen = gen_default;
chain2.asStream = asStream_default;
chain2.asWebStream = asWebStream_default;
chain2.dataSource = dataSource_default;

// node_modules/stream-chain/src/web/index.js
var groupFunctions2 = (output, item, index, items) => {
  if (isDuplexWebStream(item)) {
    output.push(item);
    return output;
  }
  if (!index && isReadableWebStream(item)) {
    output.push({ readable: item, writable: null });
    return output;
  }
  if (index === items.length - 1 && isWritableWebStream(item)) {
    output.push({ readable: null, writable: item });
    return output;
  }
  if (typeof item !== "function") {
    throw new TypeError(`Item #${index} is not a Web Streams object or function.`);
  }
  if (!output.length) output.push([]);
  const last = output[output.length - 1];
  if (Array.isArray(last)) {
    last.push(item);
  } else {
    output.push([item]);
  }
  return output;
};
var makeProduceStages = (options) => (item) => {
  if (Array.isArray(item)) {
    if (!item.length) return null;
    if (item.length === 1) return (
      /** @type {any} */
      chain3.asWebStream(item[0], options)
    );
    return (
      /** @type {any} */
      chain3.asWebStream(
        /** @type {any} */
        chain3.gen(...item),
        options
      )
    );
  }
  return item;
};
var chain3 = (fns, options) => {
  if (!Array.isArray(fns) || !fns.length) {
    throw new TypeError("Chain's first argument should be a non-empty array.");
  }
  fns = fns.flat(Infinity).filter(Boolean).map((fn) => isFunctionList(fn) ? getFunctionList(fn) : fn).flat(Infinity);
  if (!fns.length) {
    throw new TypeError("Chain's first argument is empty after flattening.");
  }
  const stages = fns.reduce(groupFunctions2, []).map(makeProduceStages(options)).filter((s) => s);
  for (let i = 0; i < stages.length - 1; ++i) {
    const from = stages[i].readable;
    const to = stages[i + 1].writable;
    if (!from) {
      throw new TypeError(`Stage #${i} has no readable side; cannot pipe to next stage.`);
    }
    if (!to) {
      throw new TypeError(`Stage #${i + 1} has no writable side; cannot accept input.`);
    }
    from.pipeTo(to).catch(() => {
    });
  }
  const c = {
    readable: stages[stages.length - 1].readable,
    writable: stages[0].writable,
    streams: stages,
    input: stages[0],
    output: stages[stages.length - 1]
  };
  return c;
};
chain3.none = none;
chain3.stop = stop;
chain3.Stop = Stop;
chain3.finalSymbol = finalSymbol;
chain3.finalValue = finalValue;
chain3.final = final;
chain3.isFinalValue = isFinalValue;
chain3.getFinalValue = getFinalValue;
chain3.manySymbol = manySymbol;
chain3.many = many;
chain3.isMany = isMany;
chain3.getManyValues = getManyValues;
chain3.flushSymbol = flushSymbol;
chain3.flushable = flushable;
chain3.isFlushable = isFlushable;
chain3.fListSymbol = fListSymbol;
chain3.isFunctionList = isFunctionList;
chain3.getFunctionList = getFunctionList;
chain3.setFunctionList = setFunctionList;
chain3.clearFunctionList = clearFunctionList;
chain3.toMany = toMany;
chain3.normalizeMany = normalizeMany;
chain3.combineMany = combineMany;
chain3.combineManyMut = combineManyMut;
chain3.chain = chain3;
chain3.chainUnchecked = chain3;
chain3.gen = gen_default;
chain3.fun = fun_default;
chain3.asWebStream = asWebStream_default;
chain3.dataSource = dataSource_default;

// node_modules/stream-chain/src/utils/fixUtf8Stream.js
var makeTextDecoderImpl = () => {
  const textDecoder = new TextDecoder();
  let input = "";
  return flushable((chunk) => {
    if (chunk === none) {
      const result = input + textDecoder.decode();
      input = "";
      return result;
    }
    if (typeof chunk == "string") {
      if (!input) return chunk;
      const result = input + chunk;
      input = "";
      return result;
    }
    if (chunk instanceof Uint8Array) {
      const result = input + textDecoder.decode(chunk, { stream: true });
      input = "";
      return result;
    }
    throw new TypeError("Expected a string or a Uint8Array");
  });
};
var makeStringDecoderImpl = (StringDecoder) => () => {
  const stringDecoder = new StringDecoder();
  let input = "";
  return flushable((chunk) => {
    if (chunk === none) {
      const result = input + stringDecoder.end();
      input = "";
      return result;
    }
    if (typeof chunk == "string") {
      if (!input) return chunk;
      const result = input + chunk;
      input = "";
      return result;
    }
    if (chunk instanceof Uint8Array) {
      const result = input + stringDecoder.write(chunk);
      input = "";
      return result;
    }
    throw new TypeError("Expected a string or a Uint8Array");
  });
};
var impl = makeTextDecoderImpl;
var isDeno = typeof globalThis["Deno"] == "object" && globalThis["Deno"]?.version;
var isBun = typeof globalThis["Bun"] == "object" && globalThis["Bun"]?.version;
var isNode = !isDeno && !isBun && typeof process == "object" && process?.versions?.node;
var readyPromise = isNode ? import("node:string_decoder").then(
  ({ StringDecoder }) => {
    impl = makeStringDecoderImpl(StringDecoder);
  },
  () => {
  }
  // squelch — stick with TextDecoder
) : Promise.resolve();
var fixUtf8Stream = () => impl();
var fixUtf8Stream_default = fixUtf8Stream;

// node_modules/stream-json/src/core/parser.js
var patterns = {
  value1: /[\"\{\[\]\-\d]|true\b|false\b|null\b|\s{1,256}/y,
  string: /[^\x00-\x1f\"\\]{1,256}|\\[bfnrt\"\\\/]|\\u[\da-fA-F]{4}|\"/y,
  numberStart: /\d/y,
  numberDigit: /\d{0,256}/y,
  numberFraction: /[\.eE]/y,
  numberExponent: /[eE]/y,
  numberExpSign: /[-+]/y
};
var MAX_PATTERN_SIZE = 16;
patterns.numberFracStart = patterns.numberExpStart = patterns.numberStart;
patterns.numberFracDigit = patterns.numberExpDigit = patterns.numberDigit;
var expected = { object: "objectStop", array: "arrayStop", "": "done" };
var tokenStartObject = { name: "startObject" };
var tokenEndObject = { name: "endObject" };
var tokenStartArray = { name: "startArray" };
var tokenEndArray = { name: "endArray" };
var tokenStartString = { name: "startString" };
var tokenEndString = { name: "endString" };
var tokenStartNumber = { name: "startNumber" };
var tokenEndNumber = { name: "endNumber" };
var tokenStartKey = { name: "startKey" };
var tokenEndKey = { name: "endKey" };
var literalTokens = {
  true: { name: "trueValue", value: true },
  false: { name: "falseValue", value: false },
  null: { name: "nullValue", value: null }
};
var fromHex = (s) => String.fromCharCode(parseInt(s.slice(2), 16));
var codes = { b: "\b", f: "\f", n: "\n", r: "\r", t: "	", '"': '"', "\\": "\\", "/": "/" };
var ASCII_TAB = "	".charCodeAt(0);
var ASCII_LF = "\n".charCodeAt(0);
var ASCII_CR = "\r".charCodeAt(0);
var ASCII_SPACE = " ".charCodeAt(0);
var ASCII_QUOTE = '"'.charCodeAt(0);
var ASCII_BACKSLASH = "\\".charCodeAt(0);
var ASCII_OPEN_BRACE = "{".charCodeAt(0);
var ASCII_CLOSE_BRACE = "}".charCodeAt(0);
var ASCII_OPEN_BRACKET = "[".charCodeAt(0);
var ASCII_CLOSE_BRACKET = "]".charCodeAt(0);
var ASCII_MINUS = "-".charCodeAt(0);
var ASCII_COLON = ":".charCodeAt(0);
var ASCII_COMMA = ",".charCodeAt(0);
var ASCII_ZERO = "0".charCodeAt(0);
var ASCII_NINE = "9".charCodeAt(0);
var ASCII_UPPER_A = "A".charCodeAt(0);
var ASCII_UPPER_F = "F".charCodeAt(0);
var ASCII_LOWER_A = "a".charCodeAt(0);
var ASCII_LOWER_F = "f".charCodeAt(0);
var ASCII_LOWER_N = "n".charCodeAt(0);
var ASCII_LOWER_T = "t".charCodeAt(0);
var ASCII_LOWER_U = "u".charCodeAt(0);
var TERM = [];
for (const ch of ",}] 	\n\r") TERM[ch.charCodeAt(0)] = 1;
var numberFull = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][-+]?\d+)?/y;
var HEX = (c) => c >= ASCII_ZERO && c <= ASCII_NINE || c >= ASCII_UPPER_A && c <= ASCII_UPPER_F || c >= ASCII_LOWER_A && c <= ASCII_LOWER_F;
var jsonParser = (options) => {
  let packKeys = true, packStrings = true, packNumbers = true, streamKeys = true, streamStrings = true, streamNumbers = true, jsonStreaming = false;
  if (options) {
    "packValues" in options && (packKeys = packStrings = packNumbers = options.packValues);
    "packKeys" in options && (packKeys = options.packKeys);
    "packStrings" in options && (packStrings = options.packStrings);
    "packNumbers" in options && (packNumbers = options.packNumbers);
    "streamValues" in options && (streamKeys = streamStrings = streamNumbers = options.streamValues);
    "streamKeys" in options && (streamKeys = options.streamKeys);
    "streamStrings" in options && (streamStrings = options.streamStrings);
    "streamNumbers" in options && (streamNumbers = options.streamNumbers);
    jsonStreaming = options.jsonStreaming;
  }
  !packKeys && (streamKeys = true);
  !packStrings && (streamStrings = true);
  !packNumbers && (streamNumbers = true);
  let done = false, expect = jsonStreaming ? "done" : "value", parent = "", openNumber = false, accumulator = "", buffer = "";
  const stack = [];
  return flushable((buf) => {
    const tokens = [];
    if (buf === none) {
      done = true;
    } else {
      buffer += buf;
    }
    let match, fm, s, e, q, rs, cc, value, index = 0;
    main: for (; ; ) {
      switch (expect) {
        case "value1":
        case "value": {
          while (index < buffer.length) {
            cc = buffer.charCodeAt(index);
            if (cc === ASCII_SPACE || cc === ASCII_TAB || cc === ASCII_LF || cc === ASCII_CR) {
              ++index;
              continue;
            }
            break;
          }
          if (index >= buffer.length) {
            if (done) throw new Error("Parser has expected a value");
            break main;
          }
          cc = buffer.charCodeAt(index);
          if (cc === ASCII_QUOTE) {
            q = index + 1;
            rs = q;
            s = "";
            for (; ; ) {
              if (q >= buffer.length) {
                q = -1;
                break;
              }
              e = buffer.charCodeAt(q);
              if (e === ASCII_QUOTE) {
                s += buffer.slice(rs, q);
                break;
              }
              if (e < ASCII_SPACE) {
                q = -1;
                break;
              }
              if (e === ASCII_BACKSLASH) {
                if (q + 1 >= buffer.length) {
                  q = -1;
                  break;
                }
                cc = buffer.charCodeAt(q + 1);
                if (cc === ASCII_LOWER_U) {
                  if (q + 6 > buffer.length || !(HEX(buffer.charCodeAt(q + 2)) && HEX(buffer.charCodeAt(q + 3)) && HEX(buffer.charCodeAt(q + 4)) && HEX(buffer.charCodeAt(q + 5)))) {
                    q = -1;
                    break;
                  }
                  s += buffer.slice(rs, q) + String.fromCharCode(parseInt(buffer.slice(q + 2, q + 6), 16));
                  q += 6;
                } else {
                  value = codes[buffer.charAt(q + 1)];
                  if (value === void 0) {
                    q = -1;
                    break;
                  }
                  s += buffer.slice(rs, q) + value;
                  q += 2;
                }
                rs = q;
                continue;
              }
              ++q;
            }
            if (q >= 0) {
              if (streamStrings) {
                tokens.push(tokenStartString);
                if (s) tokens.push({ name: "stringChunk", value: s });
                tokens.push(tokenEndString);
              }
              if (packStrings) tokens.push({ name: "stringValue", value: s });
              index = q + 1;
              expect = expected[parent];
              continue main;
            }
            if (streamStrings) tokens.push(tokenStartString);
            expect = "string";
            ++index;
            continue main;
          }
          if (cc === ASCII_OPEN_BRACE) {
            tokens.push(tokenStartObject);
            stack.push(parent);
            parent = "object";
            expect = "key1";
            ++index;
            continue main;
          }
          if (cc === ASCII_OPEN_BRACKET) {
            tokens.push(tokenStartArray);
            stack.push(parent);
            parent = "array";
            expect = "value1";
            ++index;
            continue main;
          }
          if (cc === ASCII_CLOSE_BRACKET) {
            if (expect !== "value1") throw new Error("Parser cannot parse input: unexpected token ']'");
            tokens.push(tokenEndArray);
            parent = stack.pop();
            expect = expected[parent];
            ++index;
            continue main;
          }
          if (cc === ASCII_MINUS || cc >= ASCII_ZERO && cc <= ASCII_NINE) {
            numberFull.lastIndex = index;
            fm = numberFull.exec(buffer);
            if (fm) {
              e = index + fm[0].length;
              if (e < buffer.length && TERM[buffer.charCodeAt(e)]) {
                s = fm[0];
                if (streamNumbers) tokens.push(tokenStartNumber, { name: "numberChunk", value: s }, tokenEndNumber);
                if (packNumbers) tokens.push({ name: "numberValue", value: s });
                index = e;
                expect = expected[parent];
                continue main;
              }
            }
            openNumber = true;
            if (cc === ASCII_MINUS) {
              if (streamNumbers) tokens.push(tokenStartNumber, { name: "numberChunk", value: "-" });
              packNumbers && (accumulator = "-");
              expect = "numberStart";
            } else if (cc === ASCII_ZERO) {
              if (streamNumbers) tokens.push(tokenStartNumber, { name: "numberChunk", value: "0" });
              packNumbers && (accumulator = "0");
              expect = "numberFraction";
            } else {
              s = buffer.charAt(index);
              if (streamNumbers) tokens.push(tokenStartNumber, { name: "numberChunk", value: s });
              packNumbers && (accumulator = s);
              expect = "numberDigit";
            }
            ++index;
            continue main;
          }
          if (cc === ASCII_LOWER_T || cc === ASCII_LOWER_F || cc === ASCII_LOWER_N) {
            patterns.value1.lastIndex = index;
            match = patterns.value1.exec(buffer);
            if (!match) {
              if (done || index + MAX_PATTERN_SIZE < buffer.length) {
                throw new Error("Parser cannot parse input: expected a value");
              }
              break main;
            }
            value = match[0];
            if (buffer.length - index === value.length && !done) break main;
            tokens.push(literalTokens[value]);
            expect = expected[parent];
            index += value.length;
            continue main;
          }
          throw new Error("Parser cannot parse input: expected a value");
        }
        // incremental string body (escapes / long / cross-chunk)
        case "keyVal":
        case "string":
          patterns.string.lastIndex = index;
          match = patterns.string.exec(buffer);
          if (!match) {
            if (index < buffer.length && (done || buffer.length - index >= 6)) throw new Error("Parser cannot parse input: escaped characters");
            if (done) throw new Error("Parser has expected a string value");
            break main;
          }
          value = match[0];
          if (value === '"') {
            if (expect === "keyVal") {
              if (streamKeys) tokens.push(tokenEndKey);
              if (packKeys) {
                tokens.push({ name: "keyValue", value: accumulator });
                accumulator = "";
              }
              expect = "colon";
            } else {
              if (streamStrings) tokens.push(tokenEndString);
              if (packStrings) {
                tokens.push({ name: "stringValue", value: accumulator });
                accumulator = "";
              }
              expect = expected[parent];
            }
          } else if (value.length > 1 && value.charAt(0) === "\\") {
            const t = value.length == 2 ? codes[value.charAt(1)] : fromHex(value);
            if (expect === "keyVal" ? streamKeys : streamStrings) {
              tokens.push({ name: "stringChunk", value: t });
            }
            if (expect === "keyVal" ? packKeys : packStrings) {
              accumulator += t;
            }
          } else {
            if (expect === "keyVal" ? streamKeys : streamStrings) {
              tokens.push({ name: "stringChunk", value });
            }
            if (expect === "keyVal" ? packKeys : packStrings) {
              accumulator += value;
            }
          }
          index += value.length;
          break;
        case "key1":
        case "key": {
          while (index < buffer.length) {
            cc = buffer.charCodeAt(index);
            if (cc === ASCII_SPACE || cc === ASCII_TAB || cc === ASCII_LF || cc === ASCII_CR) {
              ++index;
              continue;
            }
            break;
          }
          if (index >= buffer.length) {
            if (done) throw new Error("Parser cannot parse input: expected an object key");
            break main;
          }
          cc = buffer.charCodeAt(index);
          if (cc === ASCII_QUOTE) {
            q = index + 1;
            rs = q;
            s = "";
            for (; ; ) {
              if (q >= buffer.length) {
                q = -1;
                break;
              }
              e = buffer.charCodeAt(q);
              if (e === ASCII_QUOTE) {
                s += buffer.slice(rs, q);
                break;
              }
              if (e < ASCII_SPACE) {
                q = -1;
                break;
              }
              if (e === ASCII_BACKSLASH) {
                if (q + 1 >= buffer.length) {
                  q = -1;
                  break;
                }
                cc = buffer.charCodeAt(q + 1);
                if (cc === ASCII_LOWER_U) {
                  if (q + 6 > buffer.length || !(HEX(buffer.charCodeAt(q + 2)) && HEX(buffer.charCodeAt(q + 3)) && HEX(buffer.charCodeAt(q + 4)) && HEX(buffer.charCodeAt(q + 5)))) {
                    q = -1;
                    break;
                  }
                  s += buffer.slice(rs, q) + String.fromCharCode(parseInt(buffer.slice(q + 2, q + 6), 16));
                  q += 6;
                } else {
                  value = codes[buffer.charAt(q + 1)];
                  if (value === void 0) {
                    q = -1;
                    break;
                  }
                  s += buffer.slice(rs, q) + value;
                  q += 2;
                }
                rs = q;
                continue;
              }
              ++q;
            }
            if (q >= 0) {
              if (streamKeys) {
                tokens.push(tokenStartKey);
                if (s) tokens.push({ name: "stringChunk", value: s });
                tokens.push(tokenEndKey);
              }
              if (packKeys) tokens.push({ name: "keyValue", value: s });
              index = q + 1;
              expect = "colon";
              continue main;
            }
            if (streamKeys) tokens.push(tokenStartKey);
            expect = "keyVal";
            ++index;
            continue main;
          }
          if (cc === ASCII_CLOSE_BRACE) {
            if (expect !== "key1") throw new Error("Parser cannot parse input: unexpected token '}'");
            tokens.push(tokenEndObject);
            parent = stack.pop();
            expect = expected[parent];
            ++index;
            continue main;
          }
          throw new Error("Parser cannot parse input: expected an object key");
        }
        case "colon": {
          while (index < buffer.length) {
            cc = buffer.charCodeAt(index);
            if (cc === ASCII_SPACE || cc === ASCII_TAB || cc === ASCII_LF || cc === ASCII_CR) {
              ++index;
              continue;
            }
            break;
          }
          if (index >= buffer.length) {
            if (done) throw new Error("Parser cannot parse input: expected ':'");
            break main;
          }
          cc = buffer.charCodeAt(index);
          if (cc === ASCII_COLON) {
            expect = "value";
            ++index;
            continue main;
          }
          throw new Error("Parser cannot parse input: expected ':'");
        }
        case "arrayStop":
        case "objectStop": {
          while (index < buffer.length) {
            cc = buffer.charCodeAt(index);
            if (cc === ASCII_SPACE || cc === ASCII_TAB || cc === ASCII_LF || cc === ASCII_CR) {
              ++index;
              continue;
            }
            break;
          }
          if (index >= buffer.length) {
            if (done) throw new Error("Parser cannot parse input: expected ','");
            break main;
          }
          if (openNumber) {
            if (streamNumbers) tokens.push(tokenEndNumber);
            openNumber = false;
            if (packNumbers) {
              tokens.push({ name: "numberValue", value: accumulator });
              accumulator = "";
            }
          }
          cc = buffer.charCodeAt(index);
          if (cc === ASCII_COMMA) {
            expect = expect === "arrayStop" ? "value" : "key";
            ++index;
            continue main;
          }
          if (cc === ASCII_CLOSE_BRACE || cc === ASCII_CLOSE_BRACKET) {
            if (cc === ASCII_CLOSE_BRACE ? expect === "arrayStop" : expect !== "arrayStop") {
              throw new Error("Parser cannot parse input: expected '" + (expect === "arrayStop" ? "]" : "}") + "'");
            }
            tokens.push(cc === ASCII_CLOSE_BRACE ? tokenEndObject : tokenEndArray);
            parent = stack.pop();
            expect = expected[parent];
            ++index;
            continue main;
          }
          throw new Error("Parser cannot parse input: expected ','");
        }
        // number chunks — cross-chunk / fallback
        case "numberStart":
          patterns.numberStart.lastIndex = index;
          match = patterns.numberStart.exec(buffer);
          if (!match) {
            if (index < buffer.length || done) throw new Error("Parser cannot parse input: expected a starting digit");
            break main;
          }
          value = match[0];
          if (streamNumbers) tokens.push({ name: "numberChunk", value });
          packNumbers && (accumulator += value);
          expect = value === "0" ? "numberFraction" : "numberDigit";
          index += value.length;
          break;
        case "numberDigit":
          patterns.numberDigit.lastIndex = index;
          match = patterns.numberDigit.exec(buffer);
          if (!match) {
            if (index < buffer.length || done) throw new Error("Parser cannot parse input: expected a digit");
            break main;
          }
          value = match[0];
          if (value) {
            if (streamNumbers) tokens.push({ name: "numberChunk", value });
            packNumbers && (accumulator += value);
            index += value.length;
          } else {
            if (index < buffer.length) {
              expect = "numberFraction";
              break;
            }
            if (done) {
              expect = expected[parent];
              break;
            }
            break main;
          }
          break;
        case "numberFraction":
          patterns.numberFraction.lastIndex = index;
          match = patterns.numberFraction.exec(buffer);
          if (!match) {
            if (index < buffer.length || done) {
              expect = expected[parent];
              break;
            }
            break main;
          }
          value = match[0];
          if (streamNumbers) tokens.push({ name: "numberChunk", value });
          packNumbers && (accumulator += value);
          expect = value === "." ? "numberFracStart" : "numberExpSign";
          index += value.length;
          break;
        case "numberFracStart":
          patterns.numberFracStart.lastIndex = index;
          match = patterns.numberFracStart.exec(buffer);
          if (!match) {
            if (index < buffer.length || done) throw new Error("Parser cannot parse input: expected a fractional part of a number");
            break main;
          }
          value = match[0];
          if (streamNumbers) tokens.push({ name: "numberChunk", value });
          packNumbers && (accumulator += value);
          expect = "numberFracDigit";
          index += value.length;
          break;
        case "numberFracDigit":
          patterns.numberFracDigit.lastIndex = index;
          match = patterns.numberFracDigit.exec(buffer);
          value = match[0];
          if (value) {
            if (streamNumbers) tokens.push({ name: "numberChunk", value });
            packNumbers && (accumulator += value);
            index += value.length;
          } else {
            if (index < buffer.length) {
              expect = "numberExponent";
              break;
            }
            if (done) {
              expect = expected[parent];
              break;
            }
            break main;
          }
          break;
        case "numberExponent":
          patterns.numberExponent.lastIndex = index;
          match = patterns.numberExponent.exec(buffer);
          if (!match) {
            if (index < buffer.length) {
              expect = expected[parent];
              break;
            }
            if (done) {
              expect = expected[parent];
              break;
            }
            break main;
          }
          value = match[0];
          if (streamNumbers) tokens.push({ name: "numberChunk", value });
          packNumbers && (accumulator += value);
          expect = "numberExpSign";
          index += value.length;
          break;
        case "numberExpSign":
          patterns.numberExpSign.lastIndex = index;
          match = patterns.numberExpSign.exec(buffer);
          if (!match) {
            if (index < buffer.length) {
              expect = "numberExpStart";
              break;
            }
            if (done) throw new Error("Parser has expected an exponent value of a number");
            break main;
          }
          value = match[0];
          if (streamNumbers) tokens.push({ name: "numberChunk", value });
          packNumbers && (accumulator += value);
          expect = "numberExpStart";
          index += value.length;
          break;
        case "numberExpStart":
          patterns.numberExpStart.lastIndex = index;
          match = patterns.numberExpStart.exec(buffer);
          if (!match) {
            if (index < buffer.length || done) throw new Error("Parser cannot parse input: expected an exponent part of a number");
            break main;
          }
          value = match[0];
          if (streamNumbers) tokens.push({ name: "numberChunk", value });
          packNumbers && (accumulator += value);
          expect = "numberExpDigit";
          index += value.length;
          break;
        case "numberExpDigit":
          patterns.numberExpDigit.lastIndex = index;
          match = patterns.numberExpDigit.exec(buffer);
          value = match[0];
          if (value) {
            if (streamNumbers) tokens.push({ name: "numberChunk", value });
            packNumbers && (accumulator += value);
            index += value.length;
          } else {
            if (index < buffer.length || done) {
              expect = expected[parent];
              break;
            }
            break main;
          }
          break;
        case "done": {
          while (index < buffer.length) {
            cc = buffer.charCodeAt(index);
            if (cc === ASCII_SPACE || cc === ASCII_TAB || cc === ASCII_LF || cc === ASCII_CR) {
              if (openNumber) {
                if (streamNumbers) tokens.push(tokenEndNumber);
                openNumber = false;
                if (packNumbers) {
                  tokens.push({ name: "numberValue", value: accumulator });
                  accumulator = "";
                }
              }
              ++index;
              continue;
            }
            break;
          }
          if (index >= buffer.length) break main;
          if (jsonStreaming) {
            if (openNumber) {
              if (streamNumbers) tokens.push(tokenEndNumber);
              openNumber = false;
              if (packNumbers) {
                tokens.push({ name: "numberValue", value: accumulator });
                accumulator = "";
              }
            }
            expect = "value";
            continue main;
          }
          throw new Error("Parser cannot parse input: unexpected characters");
        }
      }
    }
    if (done && openNumber) {
      if (streamNumbers) tokens.push(tokenEndNumber);
      openNumber = false;
      if (packNumbers) {
        tokens.push({ name: "numberValue", value: accumulator });
        accumulator = "";
      }
    }
    buffer = buffer.slice(index);
    return tokens.length ? many(tokens) : none;
  });
};
var parser = (options) => gen_default(fixUtf8Stream_default(), jsonParser(options));
parser.parser = parser;
var parser_default = parser;

// node_modules/stream-json/src/parser.js
parser_default.asStream = (options) => asStream_default(parser_default(options), { writableObjectMode: true, readableObjectMode: true, ...options });
parser_default.asWebStream = (options) => asWebStream_default(parser_default(options), { writableObjectMode: true, readableObjectMode: true, ...options });

// src/input-node.ts
var parseNodeJsonTokens = async function* (chunks, options) {
  const tokenize = fun_default(parser_default({
    jsonStreaming: options.jsonStreaming,
    packValues: true,
    streamValues: false
  }));
  for await (const chunk of chunks) {
    if (options.signal?.aborted) throw options.signal.reason;
    const tokens = getManyValues(await tokenize(chunk));
    if (tokens.length > 0) yield tokens;
  }
  const finalTokens = getManyValues(await tokenize(none));
  if (finalTokens.length > 0) yield finalTokens;
};

// src/download-names.ts
function zipDownloadName(accounts, now = /* @__PURE__ */ new Date()) {
  return `authconv_${zipNameBasis(accounts)}_${localTimestamp(now)}.zip`;
}
function zipNameBasis(accounts) {
  let count = 0;
  let first;
  for (const account of accounts) {
    count += 1;
    if (count === 1) first = account;
  }
  return count === 1 && first ? singleAccountBasis(first) : `${count}-accounts`;
}
function singleAccountBasis(account) {
  const openAiId = account.provider === "openai" ? account.chatgptAccountId ?? account.accountId : void 0;
  const xaiId = account.provider === "xai" ? account.userId ?? account.principalId : void 0;
  const stableId = openAiId ?? xaiId;
  const identity = safeFileSegment(account.email ?? account.name ?? stableId ?? account.userId ?? "account");
  const idSegment = stableId ? safeFileSegment(stableId.slice(0, 12)) : "";
  return idSegment ? `${identity}_${idSegment}` : identity;
}
function localTimestamp(value) {
  return [
    value.getFullYear(),
    value.getMonth() + 1,
    value.getDate(),
    value.getHours(),
    value.getMinutes(),
    value.getSeconds()
  ].map((part) => String(part).padStart(2, "0")).join("");
}
function safeFileSegment(value) {
  return value.trim().replace(/[^\w\-.]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 96) || "account";
}

// src/formats.ts
var FORMAT_DEFINITIONS = {
  cpa: {
    format: "cpa",
    providers: ["openai", "xai"],
    modes: ["single"],
    filePrefix: "cpa"
  },
  sub2api: {
    format: "sub2api",
    providers: ["openai", "xai"],
    modes: ["merged", "single"],
    filePrefix: "sub2api"
  },
  codex2api: {
    format: "codex2api",
    providers: ["openai"],
    modes: ["merged", "single"],
    filePrefix: "codex2api"
  },
  codexmanager: {
    format: "codexmanager",
    providers: ["openai"],
    modes: ["single"],
    filePrefix: "codex-manager"
  },
  codex: {
    format: "codex",
    providers: ["openai"],
    modes: ["single"],
    filePrefix: "codex"
  },
  grok: {
    format: "grok",
    providers: ["xai"],
    modes: ["single"],
    filePrefix: "grok"
  },
  grok2api: {
    format: "grok2api",
    providers: ["xai"],
    modes: ["merged"],
    filePrefix: "grok2api"
  }
};
var ALL_FORMATS = Object.keys(FORMAT_DEFINITIONS);
function isConfigurableOutputFormat(format) {
  return FORMAT_DEFINITIONS[format].modes.length > 1;
}
function resolveOutputMode(format, requested) {
  const modes = FORMAT_DEFINITIONS[format].modes;
  if (modes.length === 1) {
    if (requested !== void 0) {
      throw new Error(`Format ${format} uses fixed ${modes[0]} output`);
    }
    return modes[0];
  }
  return requested ?? modes[0];
}
function parseFormatList(values, options = {}) {
  const out = [];
  for (const value of values ?? []) {
    for (const part of value.split(",")) {
      const normalized = part.trim().toLowerCase();
      if (!normalized) {
        continue;
      }
      if (normalized === "all") {
        for (const format of ALL_FORMATS) {
          if (!out.includes(format)) {
            out.push(format);
          }
        }
        continue;
      }
      if (!isOutputFormat(normalized)) {
        throw new Error(options.invalidFormatMessage?.(part) ?? `\u672A\u77E5\u8F93\u51FA\u683C\u5F0F: ${part}`);
      }
      if (!out.includes(normalized)) {
        out.push(normalized);
      }
    }
  }
  return out;
}
function isOutputFormat(value) {
  return ALL_FORMATS.includes(value);
}

// node_modules/@zip.js/zip.js/lib/core/constants.js
var MAX_32_BITS = 4294967295;
var MAX_16_BITS = 65535;
var MAX_8_BITS = 255;
var COMPRESSION_METHOD_DEFLATE = 8;
var COMPRESSION_METHOD_DEFLATE_64 = 9;
var COMPRESSION_METHOD_STORE = 0;
var COMPRESSION_METHOD_AES = 99;
var LOCAL_FILE_HEADER_SIGNATURE = 67324752;
var SPLIT_ZIP_FILE_SIGNATURE = 134695760;
var DATA_DESCRIPTOR_RECORD_SIGNATURE = SPLIT_ZIP_FILE_SIGNATURE;
var CENTRAL_FILE_HEADER_SIGNATURE = 33639248;
var END_OF_CENTRAL_DIR_SIGNATURE = 101010256;
var ZIP64_END_OF_CENTRAL_DIR_SIGNATURE = 101075792;
var ZIP64_END_OF_CENTRAL_DIR_LOCATOR_SIGNATURE = 117853008;
var CENTRAL_FILE_HEADER_LENGTH = 46;
var END_OF_CENTRAL_DIR_LENGTH = 22;
var ZIP64_END_OF_CENTRAL_DIR_LOCATOR_LENGTH = 20;
var ZIP64_END_OF_CENTRAL_DIR_LENGTH = 56;
var ZIP64_END_OF_CENTRAL_DIR_TOTAL_LENGTH = END_OF_CENTRAL_DIR_LENGTH + ZIP64_END_OF_CENTRAL_DIR_LOCATOR_LENGTH + ZIP64_END_OF_CENTRAL_DIR_LENGTH;
var DATA_DESCRIPTOR_RECORD_LENGTH = 12;
var DATA_DESCRIPTOR_RECORD_ZIP_64_LENGTH = 20;
var DATA_DESCRIPTOR_RECORD_SIGNATURE_LENGTH = 4;
var EXTRAFIELD_TYPE_ZIP64 = 1;
var EXTRAFIELD_TYPE_AES = 39169;
var EXTRAFIELD_TYPE_NTFS = 10;
var EXTRAFIELD_TYPE_NTFS_TAG1 = 1;
var EXTRAFIELD_TYPE_EXTENDED_TIMESTAMP = 21589;
var EXTRAFIELD_TYPE_UNICODE_PATH = 28789;
var EXTRAFIELD_TYPE_UNICODE_COMMENT = 25461;
var EXTRAFIELD_TYPE_USDZ = 6534;
var EXTRAFIELD_TYPE_INFOZIP = 30837;
var EXTRAFIELD_TYPE_UNIX = 30805;
var BITFLAG_ENCRYPTED = 1;
var BITFLAG_LEVEL = 6;
var BITFLAG_LEVEL_MAX_MASK = 2;
var BITFLAG_LEVEL_FAST_MASK = 4;
var BITFLAG_LEVEL_SUPER_FAST_MASK = 6;
var BITFLAG_DATA_DESCRIPTOR = 8;
var BITFLAG_LANG_ENCODING_FLAG = 2048;
var FILE_ATTR_MSDOS_DIR_MASK = 16;
var FILE_ATTR_MSDOS_READONLY_MASK = 1;
var FILE_ATTR_MSDOS_HIDDEN_MASK = 2;
var FILE_ATTR_MSDOS_SYSTEM_MASK = 4;
var FILE_ATTR_MSDOS_ARCHIVE_MASK = 32;
var FILE_ATTR_UNIX_TYPE_MASK = 61440;
var FILE_ATTR_UNIX_TYPE_DIR = 16384;
var FILE_ATTR_UNIX_EXECUTABLE_MASK = 73;
var FILE_ATTR_UNIX_DEFAULT_MASK = 420;
var FILE_ATTR_UNIX_SETUID_MASK = 2048;
var FILE_ATTR_UNIX_SETGID_MASK = 1024;
var FILE_ATTR_UNIX_STICKY_MASK = 512;
var VERSION_DEFLATE = 20;
var VERSION_ZIP64 = 45;
var VERSION_AES = 51;
var DIRECTORY_SIGNATURE = "/";
var HEADER_SIZE = 30;
var HEADER_OFFSET_VERSION = 0;
var HEADER_OFFSET_SIGNATURE = 10;
var HEADER_OFFSET_COMPRESSED_SIZE = 14;
var HEADER_OFFSET_UNCOMPRESSED_SIZE = 18;
var LOCAL_HEADER_COMMON_OFFSET = 4;
var MAX_DATE = new Date(2107, 11, 31);
var MIN_DATE = new Date(1980, 0, 1);
var UNDEFINED_VALUE = void 0;
var INFINITY_VALUE = Infinity;
var UNDEFINED_TYPE = "undefined";
var FUNCTION_TYPE = "function";
var OBJECT_TYPE = "object";
var EMPTY_UINT8_ARRAY = new Uint8Array();

// node_modules/@zip.js/zip.js/lib/core/configuration.js
var MINIMUM_CHUNK_SIZE = 64;
var maxWorkers = 2;
try {
  if (typeof navigator != UNDEFINED_TYPE && navigator.hardwareConcurrency) {
    maxWorkers = navigator.hardwareConcurrency;
  }
} catch {
}
var DEFAULT_CONFIGURATION = {
  workerURI: "./core/web-worker-wasm.js",
  wasmURI: "./core/streams/zlib-wasm/zlib-streams.wasm",
  chunkSize: 64 * 1024,
  maxWorkers,
  terminateWorkerTimeout: 5e3,
  workerStarvationTimeout: 5e3,
  useWebWorkers: true,
  useCompressionStream: true,
  CompressionStream: typeof CompressionStream != UNDEFINED_TYPE && CompressionStream,
  DecompressionStream: typeof DecompressionStream != UNDEFINED_TYPE && DecompressionStream
};
var config = Object.assign({}, DEFAULT_CONFIGURATION);
function getConfiguration() {
  return config;
}
function getChunkSize(config2) {
  return Math.max(config2.chunkSize, MINIMUM_CHUNK_SIZE);
}

// node_modules/@zip.js/zip.js/lib/core/streams/codecs/crc32.js
var T = [[], [], [], [], [], [], [], []];
for (let n = 0; n < 256; n++) {
  let t = n;
  for (let j = 0; j < 8; j++) {
    t = t & 1 ? t >>> 1 ^ 3988292384 : t >>> 1;
  }
  T[0][n] = t;
}
for (let n = 0; n < 256; n++) {
  for (let k = 1; k < 8; k++) {
    const previous = T[k - 1][n];
    T[k][n] = previous >>> 8 ^ T[0][previous & 255];
  }
}
var [T0, T1, T2, T3, T4, T5, T6, T7] = T;
var Crc32 = class {
  constructor(crc) {
    this.crc = crc || -1;
  }
  append(data) {
    let crc = this.crc | 0;
    const length = data.length | 0;
    let offset = 0;
    if (length >= 8 && data.buffer) {
      const view = new DataView(data.buffer, data.byteOffset, length);
      const end = length - 8;
      for (; offset <= end; offset += 8) {
        const a = crc ^ view.getInt32(offset, true);
        const b = view.getInt32(offset + 4, true);
        crc = T7[a & 255] ^ T6[a >>> 8 & 255] ^ T5[a >>> 16 & 255] ^ T4[a >>> 24 & 255] ^ T3[b & 255] ^ T2[b >>> 8 & 255] ^ T1[b >>> 16 & 255] ^ T0[b >>> 24 & 255];
      }
    }
    for (; offset < length; offset++) {
      crc = crc >>> 8 ^ T0[(crc ^ data[offset]) & 255];
    }
    this.crc = crc;
  }
  get() {
    return ~this.crc;
  }
};

// node_modules/@zip.js/zip.js/lib/core/streams/crc32-stream.js
var Crc32Stream = class extends TransformStream {
  constructor() {
    let stream;
    const crc32 = new Crc32();
    super({
      transform(chunk, controller) {
        crc32.append(chunk);
        controller.enqueue(chunk);
      },
      flush() {
        const value = new Uint8Array(4);
        const dataView = new DataView(value.buffer);
        dataView.setUint32(0, crc32.get());
        stream.value = value;
      }
    });
    stream = this;
  }
};

// node_modules/@zip.js/zip.js/lib/core/util/encode-text.js
function encodeText(value) {
  if (typeof TextEncoder == UNDEFINED_TYPE) {
    value = unescape(encodeURIComponent(value));
    const result = new Uint8Array(value.length);
    for (let i = 0; i < result.length; i++) {
      result[i] = value.charCodeAt(i);
    }
    return result;
  } else {
    return new TextEncoder().encode(value);
  }
}

// node_modules/@zip.js/zip.js/lib/core/streams/codecs/sjcl.js
var bitArray = {
  /**
   * Concatenate two bit arrays.
   * @param {bitArray} a1 The first array.
   * @param {bitArray} a2 The second array.
   * @return {bitArray} The concatenation of a1 and a2.
   */
  concat(a1, a2) {
    if (a1.length === 0 || a2.length === 0) {
      return a1.concat(a2);
    }
    const last = a1[a1.length - 1], shift = bitArray.getPartial(last);
    if (shift === 32) {
      return a1.concat(a2);
    } else {
      return bitArray._shiftRight(a2, shift, last | 0, a1.slice(0, a1.length - 1));
    }
  },
  /**
   * Find the length of an array of bits.
   * @param {bitArray} a The array.
   * @return {Number} The length of a, in bits.
   */
  bitLength(a) {
    const l = a.length;
    if (l === 0) {
      return 0;
    }
    const x = a[l - 1];
    return (l - 1) * 32 + bitArray.getPartial(x);
  },
  /**
   * Truncate an array.
   * @param {bitArray} a The array.
   * @param {Number} len The length to truncate to, in bits.
   * @return {bitArray} A new array, truncated to len bits.
   */
  clamp(a, len) {
    if (a.length * 32 < len) {
      return a;
    }
    a = a.slice(0, Math.ceil(len / 32));
    const l = a.length;
    len = len & 31;
    if (l > 0 && len) {
      a[l - 1] = bitArray.partial(len, a[l - 1] & 2147483648 >> len - 1, 1);
    }
    return a;
  },
  /**
   * Make a partial word for a bit array.
   * @param {Number} len The number of bits in the word.
   * @param {Number} x The bits.
   * @param {Number} [_end=0] Pass 1 if x has already been shifted to the high side.
   * @return {Number} The partial word.
   */
  partial(len, x, _end) {
    if (len === 32) {
      return x;
    }
    return (_end ? x | 0 : x << 32 - len) + len * 1099511627776;
  },
  /**
   * Get the number of bits used by a partial word.
   * @param {Number} x The partial word.
   * @return {Number} The number of bits used by the partial word.
   */
  getPartial(x) {
    return Math.round(x / 1099511627776) || 32;
  },
  /** Shift an array right.
   * @param {bitArray} a The array to shift.
   * @param {Number} shift The number of bits to shift.
   * @param {Number} [carry=0] A byte to carry in
   * @param {bitArray} [out=[]] An array to prepend to the output.
   * @private
   */
  _shiftRight(a, shift, carry, out) {
    if (out === void 0) {
      out = [];
    }
    for (; shift >= 32; shift -= 32) {
      out.push(carry);
      carry = 0;
    }
    if (shift === 0) {
      return out.concat(a);
    }
    for (let i = 0; i < a.length; i++) {
      out.push(carry | a[i] >>> shift);
      carry = a[i] << 32 - shift;
    }
    const last2 = a.length ? a[a.length - 1] : 0;
    const shift2 = bitArray.getPartial(last2);
    out.push(bitArray.partial(shift + shift2 & 31, shift + shift2 > 32 ? carry : out.pop(), 1));
    return out;
  }
};
var codec = {
  bytes: {
    /** Convert from a bitArray to an array of bytes. */
    fromBits(arr) {
      const bl = bitArray.bitLength(arr);
      const byteLength = bl / 8;
      const out = new Uint8Array(byteLength);
      let tmp;
      for (let i = 0; i < byteLength; i++) {
        if ((i & 3) === 0) {
          tmp = arr[i / 4];
        }
        out[i] = tmp >>> 24;
        tmp <<= 8;
      }
      return out;
    },
    /** Convert from an array of bytes to a bitArray. */
    toBits(bytes) {
      const out = [];
      let i;
      let tmp = 0;
      for (i = 0; i < bytes.length; i++) {
        tmp = tmp << 8 | bytes[i];
        if ((i & 3) === 3) {
          out.push(tmp);
          tmp = 0;
        }
      }
      if (i & 3) {
        out.push(bitArray.partial(8 * (i & 3), tmp));
      }
      return out;
    }
  }
};
var hash = {};
hash.sha1 = class {
  constructor(hash2) {
    const sha1 = this;
    sha1.blockSize = 512;
    sha1._init = [1732584193, 4023233417, 2562383102, 271733878, 3285377520];
    sha1._key = [1518500249, 1859775393, 2400959708, 3395469782];
    if (hash2) {
      sha1._h = hash2._h.slice(0);
      sha1._buffer = hash2._buffer.slice(0);
      sha1._length = hash2._length;
    } else {
      sha1.reset();
    }
  }
  /**
   * Reset the hash state.
   * @return this
   */
  reset() {
    const sha1 = this;
    sha1._h = sha1._init.slice(0);
    sha1._buffer = [];
    sha1._length = 0;
    return sha1;
  }
  /**
   * Input several words to the hash.
   * @param {bitArray|String} data the data to hash.
   * @return this
   */
  update(data) {
    const sha1 = this;
    if (typeof data === "string") {
      data = codec.utf8String.toBits(data);
    }
    const b = sha1._buffer = bitArray.concat(sha1._buffer, data);
    const ol = sha1._length;
    const nl = sha1._length = ol + bitArray.bitLength(data);
    if (nl > 9007199254740991) {
      throw new Error("Cannot hash more than 2^53 - 1 bits");
    }
    const c = new Uint32Array(b);
    let j = 0;
    for (let i = sha1.blockSize + ol - (sha1.blockSize + ol & sha1.blockSize - 1); i <= nl; i += sha1.blockSize) {
      sha1._block(c.subarray(16 * j, 16 * (j + 1)));
      j += 1;
    }
    b.splice(0, 16 * j);
    return sha1;
  }
  /**
   * Complete hashing and output the hash value.
   * @return {bitArray} The hash value, an array of 5 big-endian words. TODO
   */
  finalize() {
    const sha1 = this;
    let b = sha1._buffer;
    const h = sha1._h;
    b = bitArray.concat(b, [bitArray.partial(1, 1)]);
    for (let i = b.length + 2; i & 15; i++) {
      b.push(0);
    }
    b.push(Math.floor(sha1._length / 4294967296));
    b.push(sha1._length | 0);
    while (b.length) {
      sha1._block(b.splice(0, 16));
    }
    sha1.reset();
    return h;
  }
  /**
   * The SHA-1 logical functions f(0), f(1), ..., f(79).
   * @private
   */
  _f(t, b, c, d) {
    if (t <= 19) {
      return b & c | ~b & d;
    } else if (t <= 39) {
      return b ^ c ^ d;
    } else if (t <= 59) {
      return b & c | b & d | c & d;
    } else if (t <= 79) {
      return b ^ c ^ d;
    }
  }
  /**
   * Circular left-shift operator.
   * @private
   */
  _S(n, x) {
    return x << n | x >>> 32 - n;
  }
  /**
   * Perform one cycle of SHA-1.
   * @param {Uint32Array|bitArray} words one block of words.
   * @private
   */
  _block(words) {
    const sha1 = this;
    const h = sha1._h;
    const w = Array(80);
    for (let j = 0; j < 16; j++) {
      w[j] = words[j];
    }
    let a = h[0];
    let b = h[1];
    let c = h[2];
    let d = h[3];
    let e = h[4];
    for (let t = 0; t <= 79; t++) {
      if (t >= 16) {
        w[t] = sha1._S(1, w[t - 3] ^ w[t - 8] ^ w[t - 14] ^ w[t - 16]);
      }
      const tmp = sha1._S(5, a) + sha1._f(t, b, c, d) + e + w[t] + sha1._key[Math.floor(t / 20)] | 0;
      e = d;
      d = c;
      c = sha1._S(30, b);
      b = a;
      a = tmp;
    }
    h[0] = h[0] + a | 0;
    h[1] = h[1] + b | 0;
    h[2] = h[2] + c | 0;
    h[3] = h[3] + d | 0;
    h[4] = h[4] + e | 0;
  }
};
var cipher = {};
cipher.aes = class {
  constructor(key) {
    const aes = this;
    aes._tables = [[[], [], [], [], []], [[], [], [], [], []]];
    if (!aes._tables[0][0][0]) {
      aes._precompute();
    }
    const sbox = aes._tables[0][4];
    const decTable = aes._tables[1];
    const keyLen = key.length;
    let i, encKey, decKey, rcon = 1;
    if (keyLen !== 4 && keyLen !== 6 && keyLen !== 8) {
      throw new Error("invalid aes key size");
    }
    aes._key = [encKey = key.slice(0), decKey = []];
    for (i = keyLen; i < 4 * keyLen + 28; i++) {
      let tmp = encKey[i - 1];
      if (i % keyLen === 0 || keyLen === 8 && i % keyLen === 4) {
        tmp = sbox[tmp >>> 24] << 24 ^ sbox[tmp >> 16 & 255] << 16 ^ sbox[tmp >> 8 & 255] << 8 ^ sbox[tmp & 255];
        if (i % keyLen === 0) {
          tmp = tmp << 8 ^ tmp >>> 24 ^ rcon << 24;
          rcon = rcon << 1 ^ (rcon >> 7) * 283;
        }
      }
      encKey[i] = encKey[i - keyLen] ^ tmp;
    }
    for (let j = 0; i; j++, i--) {
      const tmp = encKey[j & 3 ? i : i - 4];
      if (i <= 4 || j < 4) {
        decKey[j] = tmp;
      } else {
        decKey[j] = decTable[0][sbox[tmp >>> 24]] ^ decTable[1][sbox[tmp >> 16 & 255]] ^ decTable[2][sbox[tmp >> 8 & 255]] ^ decTable[3][sbox[tmp & 255]];
      }
    }
  }
  // public
  /* Something like this might appear here eventually
  name: "AES",
  blockSize: 4,
  keySizes: [4,6,8],
  */
  /**
   * Encrypt an array of 4 big-endian words.
   * @param {Array} data The plaintext.
   * @return {Array} The ciphertext.
   */
  encrypt(data) {
    return this._crypt(data, 0);
  }
  /**
   * Decrypt an array of 4 big-endian words.
   * @param {Array} data The ciphertext.
   * @return {Array} The plaintext.
   */
  decrypt(data) {
    return this._crypt(data, 1);
  }
  /**
   * Expand the S-box tables.
   *
   * @private
   */
  _precompute() {
    const encTable = this._tables[0];
    const decTable = this._tables[1];
    const sbox = encTable[4];
    const sboxInv = decTable[4];
    const d = [];
    const th = [];
    let xInv, x2, x4, x8;
    for (let i = 0; i < 256; i++) {
      th[(d[i] = i << 1 ^ (i >> 7) * 283) ^ i] = i;
    }
    for (let x = xInv = 0; !sbox[x]; x ^= x2 || 1, xInv = th[xInv] || 1) {
      let s = xInv ^ xInv << 1 ^ xInv << 2 ^ xInv << 3 ^ xInv << 4;
      s = s >> 8 ^ s & 255 ^ 99;
      sbox[x] = s;
      sboxInv[s] = x;
      x8 = d[x4 = d[x2 = d[x]]];
      let tDec = x8 * 16843009 ^ x4 * 65537 ^ x2 * 257 ^ x * 16843008;
      let tEnc = d[s] * 257 ^ s * 16843008;
      for (let i = 0; i < 4; i++) {
        encTable[i][x] = tEnc = tEnc << 24 ^ tEnc >>> 8;
        decTable[i][s] = tDec = tDec << 24 ^ tDec >>> 8;
      }
    }
    for (let i = 0; i < 5; i++) {
      encTable[i] = encTable[i].slice(0);
      decTable[i] = decTable[i].slice(0);
    }
  }
  /**
   * Encryption and decryption core.
   * @param {Array} input Four words to be encrypted or decrypted.
   * @param dir The direction, 0 for encrypt and 1 for decrypt.
   * @return {Array} The four encrypted or decrypted words.
   * @private
   */
  _crypt(input, dir) {
    if (input.length !== 4) {
      throw new Error("invalid aes block size");
    }
    const key = this._key[dir];
    const nInnerRounds = key.length / 4 - 2;
    const out = [0, 0, 0, 0];
    const table = this._tables[dir];
    const t0 = table[0];
    const t1 = table[1];
    const t2 = table[2];
    const t3 = table[3];
    const sbox = table[4];
    let a = input[0] ^ key[0];
    let b = input[dir ? 3 : 1] ^ key[1];
    let c = input[2] ^ key[2];
    let d = input[dir ? 1 : 3] ^ key[3];
    let kIndex = 4;
    let a2, b22, c2;
    for (let i = 0; i < nInnerRounds; i++) {
      a2 = t0[a >>> 24] ^ t1[b >> 16 & 255] ^ t2[c >> 8 & 255] ^ t3[d & 255] ^ key[kIndex];
      b22 = t0[b >>> 24] ^ t1[c >> 16 & 255] ^ t2[d >> 8 & 255] ^ t3[a & 255] ^ key[kIndex + 1];
      c2 = t0[c >>> 24] ^ t1[d >> 16 & 255] ^ t2[a >> 8 & 255] ^ t3[b & 255] ^ key[kIndex + 2];
      d = t0[d >>> 24] ^ t1[a >> 16 & 255] ^ t2[b >> 8 & 255] ^ t3[c & 255] ^ key[kIndex + 3];
      kIndex += 4;
      a = a2;
      b = b22;
      c = c2;
    }
    for (let i = 0; i < 4; i++) {
      out[dir ? 3 & -i : i] = sbox[a >>> 24] << 24 ^ sbox[b >> 16 & 255] << 16 ^ sbox[c >> 8 & 255] << 8 ^ sbox[d & 255] ^ key[kIndex++];
      a2 = a;
      a = b;
      b = c;
      c = d;
      d = a2;
    }
    return out;
  }
};
var mode = {};
mode.ctrGladman = class {
  constructor(prf, iv) {
    this._prf = prf;
    this._initIv = iv;
    this._iv = iv;
  }
  reset() {
    this._iv = this._initIv;
  }
  /** Input some data to calculate.
   * @param {bitArray} data the data to process, it must be intergral multiple of 128 bits unless it's the last.
   */
  update(data) {
    return this.calculate(this._prf, data, this._iv);
  }
  incWord(word) {
    if ((word >> 24 & 255) === 255) {
      let b1 = word >> 16 & 255;
      let b22 = word >> 8 & 255;
      let b3 = word & 255;
      if (b1 === 255) {
        b1 = 0;
        if (b22 === 255) {
          b22 = 0;
          if (b3 === 255) {
            b3 = 0;
          } else {
            ++b3;
          }
        } else {
          ++b22;
        }
      } else {
        ++b1;
      }
      word = 0;
      word += b1 << 16;
      word += b22 << 8;
      word += b3;
    } else {
      word += 1 << 24;
    }
    return word;
  }
  incCounter(counter) {
    if ((counter[0] = this.incWord(counter[0])) === 0) {
      counter[1] = this.incWord(counter[1]);
    }
  }
  calculate(prf, data, iv) {
    let l;
    if (!(l = data.length)) {
      return [];
    }
    const bl = bitArray.bitLength(data);
    for (let i = 0; i < l; i += 4) {
      this.incCounter(iv);
      const e = prf.encrypt(iv);
      data[i] ^= e[0];
      data[i + 1] ^= e[1];
      data[i + 2] ^= e[2];
      data[i + 3] ^= e[3];
    }
    return bitArray.clamp(data, bl);
  }
};
var misc = {
  importKey(password) {
    return new misc.hmacSha1(codec.bytes.toBits(password));
  },
  pbkdf2(prf, salt, count, length) {
    count = count || 1e4;
    if (length < 0 || count < 0) {
      throw new Error("invalid params to pbkdf2");
    }
    const byteLength = (length >> 5) + 1 << 2;
    let u, ui, i, j, k;
    const arrayBuffer = new ArrayBuffer(byteLength);
    const out = new DataView(arrayBuffer);
    let outLength = 0;
    const b = bitArray;
    salt = codec.bytes.toBits(salt);
    for (k = 1; outLength < (byteLength || 1); k++) {
      u = ui = prf.encrypt(b.concat(salt, [k]));
      for (i = 1; i < count; i++) {
        ui = prf.encrypt(ui);
        for (j = 0; j < ui.length; j++) {
          u[j] ^= ui[j];
        }
      }
      for (i = 0; outLength < (byteLength || 1) && i < u.length; i++) {
        out.setInt32(outLength, u[i]);
        outLength += 4;
      }
    }
    return arrayBuffer.slice(0, length / 8);
  }
};
misc.hmacSha1 = class {
  constructor(key) {
    const hmac = this;
    const Hash = hmac._hash = hash.sha1;
    const exKey = [[], []];
    hmac._baseHash = [new Hash(), new Hash()];
    const bs = hmac._baseHash[0].blockSize / 32;
    if (key.length > bs) {
      key = new Hash().update(key).finalize();
    }
    for (let i = 0; i < bs; i++) {
      exKey[0][i] = key[i] ^ 909522486;
      exKey[1][i] = key[i] ^ 1549556828;
    }
    hmac._baseHash[0].update(exKey[0]);
    hmac._baseHash[1].update(exKey[1]);
    hmac._resultHash = new Hash(hmac._baseHash[0]);
  }
  reset() {
    const hmac = this;
    hmac._resultHash = new hmac._hash(hmac._baseHash[0]);
    hmac._updated = false;
  }
  update(data) {
    const hmac = this;
    hmac._updated = true;
    hmac._resultHash.update(data);
  }
  digest() {
    const hmac = this;
    const w = hmac._resultHash.finalize();
    const result = new hmac._hash(hmac._baseHash[1]).update(w).finalize();
    hmac.reset();
    return result;
  }
  encrypt(data) {
    if (!this._updated) {
      this.update(data);
      return this.digest(data);
    } else {
      throw new Error("encrypt on already updated hmac called!");
    }
  }
};

// node_modules/@zip.js/zip.js/lib/core/streams/common-crypto.js
var GET_RANDOM_VALUES_SUPPORTED = typeof crypto != UNDEFINED_TYPE && typeof crypto.getRandomValues == FUNCTION_TYPE;
var ERR_INVALID_PASSWORD = "Invalid password";
var ERR_INVALID_SIGNATURE = "Invalid signature";
var ERR_ABORT_CHECK_PASSWORD = "zipjs-abort-check-password";
var ERR_UNSUPPORTED_CRYPTO_API = "Crypto API not supported";
function getRandomValues(array) {
  if (GET_RANDOM_VALUES_SUPPORTED) {
    return crypto.getRandomValues(array);
  } else {
    throw new Error(ERR_UNSUPPORTED_CRYPTO_API);
  }
}

// node_modules/@zip.js/zip.js/lib/core/streams/aes-crypto-stream.js
var BLOCK_LENGTH = 16;
var RAW_FORMAT = "raw";
var PBKDF2_ALGORITHM = { name: "PBKDF2" };
var HASH_ALGORITHM = { name: "HMAC" };
var HASH_FUNCTION = "SHA-1";
var BASE_KEY_ALGORITHM = Object.assign({ hash: HASH_ALGORITHM }, PBKDF2_ALGORITHM);
var DERIVED_BITS_ALGORITHM = Object.assign({ iterations: 1e3, hash: { name: HASH_FUNCTION } }, PBKDF2_ALGORITHM);
var DERIVED_BITS_USAGE = ["deriveBits"];
var SALT_LENGTH = [8, 12, 16];
var KEY_LENGTH = [16, 24, 32];
var SIGNATURE_LENGTH = 10;
var COUNTER_DEFAULT_VALUE = [0, 0, 0, 0];
var CRYPTO_API_SUPPORTED = typeof crypto != UNDEFINED_TYPE;
var subtle = CRYPTO_API_SUPPORTED && crypto.subtle;
var SUBTLE_API_SUPPORTED = CRYPTO_API_SUPPORTED && typeof subtle != UNDEFINED_TYPE;
var codecBytes = codec.bytes;
var Aes = cipher.aes;
var CtrGladman = mode.ctrGladman;
var HmacSha1 = misc.hmacSha1;
var IMPORT_KEY_SUPPORTED = CRYPTO_API_SUPPORTED && SUBTLE_API_SUPPORTED && typeof subtle.importKey == FUNCTION_TYPE;
var DERIVE_BITS_SUPPORTED = CRYPTO_API_SUPPORTED && SUBTLE_API_SUPPORTED && typeof subtle.deriveBits == FUNCTION_TYPE;
var AESDecryptionStream = class extends TransformStream {
  constructor({ password, rawPassword, encryptionStrength, checkPasswordOnly }) {
    super({
      start() {
        initAesCrypto(this, password, rawPassword, encryptionStrength);
      },
      async transform(chunk, controller) {
        const aesCrypto = this;
        const {
          password: password2,
          strength,
          resolveReady,
          ready
        } = aesCrypto;
        if (password2) {
          await createDecryptionKeys(aesCrypto, strength, password2, subarray(chunk, 0, SALT_LENGTH[strength] + 2));
          chunk = subarray(chunk, SALT_LENGTH[strength] + 2);
          if (checkPasswordOnly) {
            controller.error(new Error(ERR_ABORT_CHECK_PASSWORD));
          } else {
            resolveReady();
          }
        } else {
          await ready;
        }
        const output = new Uint8Array(chunk.length - SIGNATURE_LENGTH - (chunk.length - SIGNATURE_LENGTH) % BLOCK_LENGTH);
        controller.enqueue(append(aesCrypto, chunk, output, 0, SIGNATURE_LENGTH, true));
      },
      async flush(controller) {
        const {
          ctr,
          hmac,
          pending,
          ready
        } = this;
        if (hmac && ctr) {
          await ready;
          const chunkToDecrypt = subarray(pending, 0, pending.length - SIGNATURE_LENGTH);
          const originalSignature = subarray(pending, pending.length - SIGNATURE_LENGTH);
          let decryptedChunkArray = EMPTY_UINT8_ARRAY;
          if (chunkToDecrypt.length) {
            const encryptedChunk = toBits(codecBytes, chunkToDecrypt);
            hmac.update(encryptedChunk);
            const decryptedChunk = ctr.update(encryptedChunk);
            decryptedChunkArray = fromBits(codecBytes, decryptedChunk);
          }
          const signature = subarray(fromBits(codecBytes, hmac.digest()), 0, SIGNATURE_LENGTH);
          let invalidSignature = pending.length < SIGNATURE_LENGTH ? 1 : 0;
          for (let indexSignature = 0; indexSignature < SIGNATURE_LENGTH; indexSignature++) {
            invalidSignature |= signature[indexSignature] ^ originalSignature[indexSignature];
          }
          if (invalidSignature) {
            throw new Error(ERR_INVALID_SIGNATURE);
          }
          controller.enqueue(decryptedChunkArray);
        }
      }
    });
  }
};
var AESEncryptionStream = class extends TransformStream {
  constructor({ password, rawPassword, encryptionStrength }) {
    let stream;
    super({
      start() {
        initAesCrypto(this, password, rawPassword, encryptionStrength);
      },
      async transform(chunk, controller) {
        const aesCrypto = this;
        const {
          password: password2,
          strength,
          resolveReady,
          ready
        } = aesCrypto;
        let preamble = EMPTY_UINT8_ARRAY;
        if (password2) {
          preamble = await createEncryptionKeys(aesCrypto, strength, password2);
          resolveReady();
        } else {
          await ready;
        }
        const output = new Uint8Array(preamble.length + chunk.length - chunk.length % BLOCK_LENGTH);
        output.set(preamble, 0);
        controller.enqueue(append(aesCrypto, chunk, output, preamble.length, 0));
      },
      async flush(controller) {
        const {
          ctr,
          hmac,
          pending,
          ready
        } = this;
        if (hmac && ctr) {
          await ready;
          let encryptedChunkArray = EMPTY_UINT8_ARRAY;
          if (pending.length) {
            const encryptedChunk = ctr.update(toBits(codecBytes, pending));
            hmac.update(encryptedChunk);
            encryptedChunkArray = fromBits(codecBytes, encryptedChunk);
          }
          stream.signature = fromBits(codecBytes, hmac.digest()).slice(0, SIGNATURE_LENGTH);
          controller.enqueue(concat(encryptedChunkArray, stream.signature));
        }
      }
    });
    stream = this;
  }
};
function initAesCrypto(aesCrypto, password, rawPassword, encryptionStrength) {
  Object.assign(aesCrypto, {
    ready: new Promise((resolve) => aesCrypto.resolveReady = resolve),
    password: encodePassword(password, rawPassword),
    strength: encryptionStrength - 1,
    pending: EMPTY_UINT8_ARRAY
  });
}
function append(aesCrypto, input, output, paddingStart, paddingEnd, verifySignature) {
  const {
    ctr,
    hmac,
    pending
  } = aesCrypto;
  if (pending.length) {
    input = concat(pending, input);
  }
  const inputLength = input.length - paddingEnd;
  output = expand(output, paddingStart + (inputLength - inputLength % BLOCK_LENGTH));
  let offset;
  for (offset = 0; offset <= inputLength - BLOCK_LENGTH; offset += BLOCK_LENGTH) {
    const inputChunk = toBits(codecBytes, subarray(input, offset, offset + BLOCK_LENGTH));
    if (verifySignature) {
      hmac.update(inputChunk);
    }
    const outputChunk = ctr.update(inputChunk);
    if (!verifySignature) {
      hmac.update(outputChunk);
    }
    output.set(fromBits(codecBytes, outputChunk), offset + paddingStart);
  }
  aesCrypto.pending = subarray(input, offset);
  return output;
}
async function createDecryptionKeys(decrypt2, strength, password, preamble) {
  const passwordVerificationKey = await createKeys(decrypt2, strength, password, subarray(preamble, 0, SALT_LENGTH[strength]));
  const passwordVerification = subarray(preamble, SALT_LENGTH[strength]);
  if (passwordVerificationKey[0] != passwordVerification[0] || passwordVerificationKey[1] != passwordVerification[1]) {
    throw new Error(ERR_INVALID_PASSWORD);
  }
}
async function createEncryptionKeys(encrypt2, strength, password) {
  const salt = getRandomValues(new Uint8Array(SALT_LENGTH[strength]));
  const passwordVerification = await createKeys(encrypt2, strength, password, salt);
  return concat(salt, passwordVerification);
}
async function createKeys(aesCrypto, strength, password, salt) {
  aesCrypto.password = null;
  const baseKey = await importKey(RAW_FORMAT, password, BASE_KEY_ALGORITHM, false, DERIVED_BITS_USAGE);
  const derivedBits = await deriveBits(Object.assign({ salt }, DERIVED_BITS_ALGORITHM), baseKey, 8 * (KEY_LENGTH[strength] * 2 + 2));
  const compositeKey = new Uint8Array(derivedBits);
  const key = toBits(codecBytes, subarray(compositeKey, 0, KEY_LENGTH[strength]));
  const authentication = toBits(codecBytes, subarray(compositeKey, KEY_LENGTH[strength], KEY_LENGTH[strength] * 2));
  const passwordVerification = subarray(compositeKey, KEY_LENGTH[strength] * 2);
  Object.assign(aesCrypto, {
    keys: {
      key,
      authentication,
      passwordVerification
    },
    ctr: new CtrGladman(new Aes(key), Array.from(COUNTER_DEFAULT_VALUE)),
    hmac: new HmacSha1(authentication)
  });
  return passwordVerification;
}
async function importKey(format, password, algorithm, extractable, keyUsages) {
  if (IMPORT_KEY_SUPPORTED) {
    try {
      return await subtle.importKey(format, password, algorithm, extractable, keyUsages);
    } catch {
      IMPORT_KEY_SUPPORTED = false;
      return misc.importKey(password);
    }
  } else {
    return misc.importKey(password);
  }
}
async function deriveBits(algorithm, baseKey, length) {
  if (DERIVE_BITS_SUPPORTED) {
    try {
      return await subtle.deriveBits(algorithm, baseKey, length);
    } catch {
      DERIVE_BITS_SUPPORTED = false;
      return misc.pbkdf2(baseKey, algorithm.salt, DERIVED_BITS_ALGORITHM.iterations, length);
    }
  } else {
    return misc.pbkdf2(baseKey, algorithm.salt, DERIVED_BITS_ALGORITHM.iterations, length);
  }
}
function encodePassword(password, rawPassword) {
  if (rawPassword === UNDEFINED_VALUE) {
    return encodeText(password);
  } else {
    return rawPassword;
  }
}
function concat(leftArray, rightArray) {
  let array = leftArray;
  if (leftArray.length + rightArray.length) {
    array = new Uint8Array(leftArray.length + rightArray.length);
    array.set(leftArray, 0);
    array.set(rightArray, leftArray.length);
  }
  return array;
}
function expand(inputArray, length) {
  if (length && length > inputArray.length) {
    const array = inputArray;
    inputArray = new Uint8Array(length);
    inputArray.set(array, 0);
  }
  return inputArray;
}
function subarray(array, begin, end) {
  return array.subarray(begin, end);
}
function fromBits(codecBytes2, chunk) {
  return codecBytes2.fromBits(chunk);
}
function toBits(codecBytes2, chunk) {
  return codecBytes2.toBits(chunk);
}

// node_modules/@zip.js/zip.js/lib/core/streams/zip-crypto-stream.js
var HEADER_LENGTH = 12;
var ZipCryptoDecryptionStream = class extends TransformStream {
  constructor({ password, rawPassword, passwordVerification, checkPasswordOnly }) {
    super({
      start() {
        initZipCrypto(this, password, rawPassword, passwordVerification);
      },
      transform(chunk, controller) {
        const zipCrypto = this;
        if (zipCrypto.password || zipCrypto.rawPassword) {
          const decryptedHeader = decrypt(zipCrypto, chunk.subarray(0, HEADER_LENGTH));
          zipCrypto.password = zipCrypto.rawPassword = null;
          if ((decryptedHeader.at(-1) ^ zipCrypto.passwordVerification) != 0) {
            throw new Error(ERR_INVALID_PASSWORD);
          }
          chunk = chunk.subarray(HEADER_LENGTH);
        }
        if (checkPasswordOnly) {
          controller.error(new Error(ERR_ABORT_CHECK_PASSWORD));
        } else {
          controller.enqueue(decrypt(zipCrypto, chunk));
        }
      }
    });
  }
};
var ZipCryptoEncryptionStream = class extends TransformStream {
  constructor({ password, rawPassword, passwordVerification }) {
    super({
      start() {
        initZipCrypto(this, password, rawPassword, passwordVerification);
      },
      transform(chunk, controller) {
        const zipCrypto = this;
        let output;
        let offset;
        if (zipCrypto.password || zipCrypto.rawPassword) {
          zipCrypto.password = zipCrypto.rawPassword = null;
          const header = getRandomValues(new Uint8Array(HEADER_LENGTH));
          header[HEADER_LENGTH - 1] = zipCrypto.passwordVerification;
          output = new Uint8Array(chunk.length + header.length);
          output.set(encrypt(zipCrypto, header), 0);
          offset = HEADER_LENGTH;
        } else {
          output = new Uint8Array(chunk.length);
          offset = 0;
        }
        output.set(encrypt(zipCrypto, chunk), offset);
        controller.enqueue(output);
      }
    });
  }
};
function initZipCrypto(zipCrypto, password, rawPassword, passwordVerification) {
  Object.assign(zipCrypto, {
    password,
    rawPassword,
    passwordVerification
  });
  createKeys2(zipCrypto, password, rawPassword);
}
function decrypt(target, input) {
  const output = new Uint8Array(input.length);
  for (let index = 0; index < input.length; index++) {
    output[index] = getByte(target) ^ input[index];
    updateKeys(target, output[index]);
  }
  return output;
}
function encrypt(target, input) {
  const output = new Uint8Array(input.length);
  for (let index = 0; index < input.length; index++) {
    output[index] = getByte(target) ^ input[index];
    updateKeys(target, input[index]);
  }
  return output;
}
function createKeys2(target, password, rawPassword) {
  const keys = [305419896, 591751049, 878082192];
  Object.assign(target, {
    keys,
    crcKey0: new Crc32(keys[0]),
    crcKey2: new Crc32(keys[2])
  });
  if (rawPassword) {
    for (let index = 0; index < rawPassword.length; index++) {
      updateKeys(target, rawPassword[index]);
    }
  } else {
    for (let index = 0; index < password.length; index++) {
      updateKeys(target, password.charCodeAt(index));
    }
  }
}
function updateKeys(target, byte) {
  let [, key1] = target.keys;
  target.crcKey0.append([byte]);
  const key0 = ~target.crcKey0.get();
  key1 = getInt32(Math.imul(getInt32(key1 + getInt8(key0)), 134775813) + 1);
  target.crcKey2.append([key1 >>> 24]);
  const key2 = ~target.crcKey2.get();
  target.keys = [key0, key1, key2];
}
function getByte(target) {
  const temp = target.keys[2] | 2;
  return getInt8(Math.imul(temp, temp ^ 1) >>> 8);
}
function getInt8(number) {
  return number & 255;
}
function getInt32(number) {
  return number & 4294967295;
}

// node_modules/@zip.js/zip.js/lib/core/streams/zip-entry-stream.js
var ERR_INVALID_UNCOMPRESSED_SIZE = "Invalid uncompressed size";
var ERR_INVALID_COMPRESSED_DATA = "Invalid compressed data";
var FORMAT_DEFLATE_RAW = "deflate-raw";
var FORMAT_DEFLATE64_RAW = "deflate64-raw";
var FORMAT_GZIP = "gzip";
var GZIP_HEADER_LENGTH = 10;
var GZIP_TRAILER_LENGTH = 8;
var DeflateStream = class extends TransformStream {
  constructor(options, { chunkSize, CompressionStreamZlib, CompressionStream: CompressionStream2 }) {
    super({});
    const { compressed, encrypted, useCompressionStream, zipCrypto, signed, level, deflate64 } = options;
    const stream = this;
    let crc32Stream, encryptionStream, gzipCrc32Stream;
    let readable = super.readable;
    const useGzipCrc32 = signed && compressed && !deflate64 && (!encrypted || zipCrypto) && Boolean(useCompressionStream && CompressionStream2);
    if ((!encrypted || zipCrypto) && signed && !useGzipCrc32) {
      crc32Stream = new Crc32Stream();
      readable = pipeThrough(readable, crc32Stream);
    }
    if (compressed) {
      if (useGzipCrc32) {
        gzipCrc32Stream = new GzipToRawDeflateStream();
        readable = pipeThroughBackpressured(readable, new CompressionStream2(FORMAT_GZIP));
        readable = pipeThrough(readable, gzipCrc32Stream);
      } else {
        readable = pipeThroughCommpressionStream(readable, useCompressionStream, { level, chunkSize }, CompressionStream2, CompressionStreamZlib, CompressionStream2);
      }
    }
    if (encrypted) {
      if (zipCrypto) {
        readable = pipeThrough(readable, new ZipCryptoEncryptionStream(options));
      } else {
        encryptionStream = new AESEncryptionStream(options);
        readable = pipeThrough(readable, encryptionStream);
      }
    }
    setReadable(stream, readable, () => {
      let signature;
      if (encrypted && !zipCrypto) {
        signature = encryptionStream.signature;
      }
      if ((!encrypted || zipCrypto) && signed) {
        signature = useGzipCrc32 ? gzipCrc32Stream.signature : new DataView(crc32Stream.value.buffer).getUint32(0);
      }
      stream.signature = signature;
    });
  }
};
var GzipToRawDeflateStream = class extends TransformStream {
  constructor() {
    let stream;
    let headerLeft = GZIP_HEADER_LENGTH;
    let tail = new Uint8Array(0);
    super({
      transform(chunk, controller) {
        if (headerLeft) {
          const dropped = Math.min(headerLeft, chunk.length);
          headerLeft -= dropped;
          chunk = chunk.subarray(dropped);
          if (!chunk.length) {
            return;
          }
        }
        const available = tail.length + chunk.length;
        if (available <= GZIP_TRAILER_LENGTH) {
          const pending = new Uint8Array(available);
          pending.set(tail);
          pending.set(chunk, tail.length);
          tail = pending;
          return;
        }
        const emitLength = available - GZIP_TRAILER_LENGTH;
        const output = new Uint8Array(emitLength);
        const fromTail = Math.min(emitLength, tail.length);
        output.set(tail.subarray(0, fromTail), 0);
        if (emitLength > fromTail) {
          output.set(chunk.subarray(0, emitLength - fromTail), fromTail);
        }
        controller.enqueue(output);
        const nextTail = new Uint8Array(GZIP_TRAILER_LENGTH);
        const tailRemaining = tail.length - fromTail;
        if (tailRemaining) {
          nextTail.set(tail.subarray(fromTail), 0);
        }
        nextTail.set(chunk.subarray(emitLength - fromTail), tailRemaining);
        tail = nextTail;
      },
      flush() {
        const dataView = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
        stream.signature = dataView.getUint32(0, true);
        stream.uncompressedSize = dataView.getUint32(4, true);
      }
    });
    stream = this;
  }
};
var InflateStream = class extends TransformStream {
  constructor(options, { chunkSize, DecompressionStreamZlib, DecompressionStream: DecompressionStream2 }) {
    super({});
    const { zipCrypto, encrypted, signed, signature, compressed, useCompressionStream, deflate64 } = options;
    let crc32Stream, decryptionStream;
    let readable = super.readable;
    if (encrypted) {
      if (zipCrypto) {
        readable = pipeThrough(readable, new ZipCryptoDecryptionStream(options));
      } else {
        decryptionStream = new AESDecryptionStream(options);
        readable = pipeThrough(readable, decryptionStream);
      }
    }
    if (compressed) {
      readable = pipeThroughCommpressionStream(readable, useCompressionStream, { chunkSize, deflate64 }, DecompressionStream2, DecompressionStreamZlib, DecompressionStream2);
      readable = mapInflateStreamError(readable);
    }
    if ((!encrypted || zipCrypto) && signed) {
      crc32Stream = new Crc32Stream();
      readable = pipeThrough(readable, crc32Stream);
    }
    setReadable(this, readable, () => {
      if ((!encrypted || zipCrypto) && signed) {
        const dataViewSignature = new DataView(crc32Stream.value.buffer);
        if (signature != dataViewSignature.getUint32(0, false)) {
          throw new Error(ERR_INVALID_SIGNATURE);
        }
      }
    });
  }
};
function setReadable(stream, readable, flush2) {
  readable = pipeThrough(readable, new TransformStream({ flush: flush2 }));
  Object.defineProperty(stream, "readable", {
    get() {
      return readable;
    }
  });
}
function pipeThroughCommpressionStream(readable, useCompressionStream, options, CompressionStreamNative, CompressionStreamZlib, CompressionStream2) {
  const Stream2 = useCompressionStream && CompressionStreamNative ? CompressionStreamNative : CompressionStreamZlib || CompressionStream2;
  const format = options.deflate64 ? FORMAT_DEFLATE64_RAW : FORMAT_DEFLATE_RAW;
  let codecStream;
  try {
    codecStream = new Stream2(format, options);
  } catch (error) {
    if (useCompressionStream) {
      if (CompressionStreamZlib) {
        codecStream = new CompressionStreamZlib(format, options);
      } else if (CompressionStream2) {
        codecStream = new CompressionStream2(format, options);
      } else {
        throw error;
      }
    } else {
      throw error;
    }
  }
  return pipeThroughBackpressured(readable, codecStream);
}
function pipeThrough(readable, transformStream) {
  return readable.pipeThrough(transformStream);
}
function pipeThroughBackpressured(readable, transformStream) {
  const writer = transformStream.writable.getWriter();
  const reader = readable.getReader();
  pump();
  return transformStream.readable;
  async function pump() {
    try {
      for (; ; ) {
        await writer.ready;
        const result = await reader.read();
        if (result.done) {
          await writer.close();
          break;
        }
        await writer.write(result.value);
      }
    } catch (error) {
      await abort(writer, error);
      await cancel(reader, error);
    }
  }
}
async function abort(writer, error) {
  try {
    await writer.abort(error);
  } catch {
  }
}
async function cancel(reader, error) {
  try {
    await reader.cancel(error);
  } catch {
  }
}
function mapInflateStreamError(readable) {
  const reader = readable.getReader();
  return new ReadableStream({
    async pull(controller) {
      let result;
      try {
        result = await reader.read();
      } catch (error) {
        if (error && error.message) {
          throw error;
        }
        const mappedError = new Error(ERR_INVALID_COMPRESSED_DATA);
        mappedError.cause = error;
        throw mappedError;
      }
      const { value, done } = result;
      if (done) {
        controller.close();
      } else {
        controller.enqueue(value);
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    }
  });
}

// node_modules/@zip.js/zip.js/lib/core/streams/codec-stream.js
var DEFAULT_CHUNK_SIZE = 64 * 1024;
var MESSAGE_EVENT_TYPE = "message";
var MESSAGE_START = "start";
var MESSAGE_PULL = "pull";
var MESSAGE_DATA = "data";
var MESSAGE_ACK_DATA = "ack";
var MESSAGE_CLOSE = "close";
var CODEC_DEFLATE = "deflate";
var CODEC_INFLATE = "inflate";
var CodecStream = class extends TransformStream {
  constructor(options, config2) {
    super({});
    const codec2 = this;
    const { codecType } = options;
    let Stream2;
    if (codecType.startsWith(CODEC_DEFLATE)) {
      Stream2 = DeflateStream;
    } else if (codecType.startsWith(CODEC_INFLATE)) {
      Stream2 = InflateStream;
    }
    codec2.outputSize = 0;
    let inputSize = 0;
    const stream = new Stream2(options, config2);
    const readable = super.readable;
    const inputSizeStream = new TransformStream({
      transform(chunk, controller) {
        if (chunk && chunk.length) {
          inputSize += chunk.length;
          controller.enqueue(chunk);
        }
      },
      flush() {
        Object.assign(codec2, {
          inputSize
        });
      }
    });
    const outputSizeStream = new TransformStream({
      transform(chunk, controller) {
        if (chunk && chunk.length) {
          controller.enqueue(chunk);
          codec2.outputSize += chunk.length;
          if (options.outputSize !== UNDEFINED_VALUE && codec2.outputSize > options.outputSize) {
            throw new Error(ERR_INVALID_UNCOMPRESSED_SIZE);
          }
        }
      },
      flush() {
        const { signature } = stream;
        Object.assign(codec2, {
          signature,
          inputSize
        });
      }
    });
    Object.defineProperty(codec2, "readable", {
      get() {
        return readable.pipeThrough(inputSizeStream).pipeThrough(stream).pipeThrough(outputSizeStream);
      }
    });
  }
};
var ChunkStream = class extends TransformStream {
  constructor(chunkSize) {
    let pendingChunk;
    if (!(chunkSize >= 1)) {
      chunkSize = DEFAULT_CHUNK_SIZE;
    }
    super({
      transform,
      flush(controller) {
        if (pendingChunk && pendingChunk.length) {
          controller.enqueue(pendingChunk);
        }
      }
    });
    function transform(chunk, controller) {
      if (pendingChunk) {
        const newChunk = new Uint8Array(pendingChunk.length + chunk.length);
        newChunk.set(pendingChunk);
        newChunk.set(chunk, pendingChunk.length);
        chunk = newChunk;
        pendingChunk = null;
      }
      let offset = 0;
      while (chunk.length - offset > chunkSize) {
        controller.enqueue(chunk.slice(offset, offset + chunkSize));
        offset += chunkSize;
      }
      pendingChunk = offset ? chunk.slice(offset) : chunk;
    }
  }
};

// node_modules/@zip.js/zip.js/lib/core/codec-worker.js
var MODULE_WORKER_OPTIONS = { type: "module" };
var ERROR_EVENT_TYPE = "error";
var MESSAGE_ERROR_EVENT_TYPE = "messageerror";
var webWorkerSupported;
var webWorkerSource;
var webWorkerURI;
var webWorkerOptions;
var transferStreamsSupported = true;
try {
  transferStreamsSupported = typeof structuredClone == FUNCTION_TYPE && structuredClone(new DOMException("", "AbortError")).code !== UNDEFINED_VALUE;
} catch {
}
var initModule = () => {
};
var CodecWorker = class {
  constructor(workerData, { readable, writable }, { options, config: config2, streamOptions, useWebWorkers, transferStreams, workerURI }, onTaskFinished) {
    const { signal } = streamOptions;
    Object.assign(workerData, {
      busy: true,
      generation: (workerData.generation || 0) + 1,
      readable: readable.pipeThrough(new ChunkStream(getChunkSize(config2))).pipeThrough(new ProgressWatcherStream(streamOptions), { signal }),
      writable,
      options: Object.assign({}, options),
      workerURI,
      transferStreams,
      terminate() {
        return new Promise((resolve) => {
          const { worker, busy } = workerData;
          if (worker) {
            if (busy) {
              workerData.resolveTerminated = resolve;
            } else {
              worker.terminate();
              resolve();
            }
            workerData.interface = null;
          } else {
            resolve();
          }
        });
      },
      onTaskFinished() {
        if (workerData.busy) {
          const { resolveTerminated } = workerData;
          if (resolveTerminated) {
            workerData.resolveTerminated = null;
            workerData.terminated = true;
            workerData.worker.terminate();
            resolveTerminated();
          }
          workerData.busy = false;
          onTaskFinished(workerData);
        }
      }
    });
    if (webWorkerSupported === UNDEFINED_VALUE) {
      webWorkerSupported = typeof Worker != UNDEFINED_TYPE;
    }
    return (useWebWorkers && webWorkerSupported ? createWebWorkerInterface : createWorkerInterface)(workerData, config2);
  }
};
var ProgressWatcherStream = class extends TransformStream {
  constructor({ onstart, onprogress, size, onend }) {
    let chunkOffset = 0;
    super({
      async start() {
        if (onstart) {
          await callHandler(onstart, size);
        }
      },
      async transform(chunk, controller) {
        chunkOffset += chunk.length;
        if (onprogress) {
          await callHandler(onprogress, chunkOffset, size);
        }
        controller.enqueue(chunk);
      },
      async flush() {
        if (onend) {
          await callHandler(onend, chunkOffset);
        }
      }
    });
  }
};
async function callHandler(handler, ...parameters) {
  try {
    await handler(...parameters);
  } catch {
  }
}
function createWorkerInterface(workerData, config2) {
  return {
    run: () => runWorker(workerData, config2)
  };
}
function createWebWorkerInterface(workerData, config2) {
  const { baseURI, chunkSize } = config2;
  let { wasmURI } = config2;
  if (!workerData.interface) {
    if (typeof wasmURI == FUNCTION_TYPE) {
      wasmURI = wasmURI();
    }
    let worker;
    try {
      worker = getWebWorker(workerData.workerURI, baseURI, workerData);
    } catch {
      webWorkerSupported = false;
      return createWorkerInterface(workerData, config2);
    }
    Object.assign(workerData, {
      worker,
      terminated: false,
      interface: {
        run: () => runWebWorker(workerData, { chunkSize, wasmURI, baseURI })
      }
    });
  }
  return workerData.interface;
}
async function runWorker({ options, readable, writable, onTaskFinished }, config2) {
  let codecStream;
  try {
    if (!options.useCompressionStream) {
      try {
        await initModule(config2);
      } catch {
        const ZlibStream = options.codecType.startsWith(CODEC_DEFLATE) ? config2.CompressionStreamZlib : config2.DecompressionStreamZlib;
        if (!ZlibStream || ZlibStream.requiresModule) {
          options.useCompressionStream = true;
        }
      }
    }
    codecStream = new CodecStream(options, config2);
    await readable.pipeThrough(codecStream).pipeTo(writable, { preventClose: true, preventAbort: true });
    const {
      signature,
      inputSize,
      outputSize
    } = codecStream;
    return {
      signature,
      inputSize,
      outputSize
    };
  } catch (error) {
    if (codecStream) {
      error.outputSize = codecStream.outputSize;
    }
    throw error;
  } finally {
    onTaskFinished();
  }
}
async function runWebWorker(workerData, config2) {
  let resolveResult, rejectResult;
  const result = new Promise((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });
  Object.assign(workerData, {
    reader: null,
    writer: null,
    resolveResult,
    rejectResult,
    result
  });
  const { readable, options } = workerData;
  const { writable, closed, abortPipe } = watchClosedStream(workerData.writable);
  let streamsTransferred;
  try {
    streamsTransferred = sendMessage({
      type: MESSAGE_START,
      options,
      config: config2,
      readable,
      writable
    }, workerData);
  } catch (error) {
    abortPipe();
    try {
      await closed;
    } catch {
    }
    workerData.onTaskFinished();
    throw error;
  }
  if (!streamsTransferred) {
    Object.assign(workerData, {
      reader: readable.getReader(),
      writer: writable.getWriter()
    });
  }
  try {
    const resultValue = await result;
    await closeWritable();
    await closed;
    return resultValue;
  } catch (error) {
    await closeWritable();
    abortPipe();
    try {
      await closed;
    } catch {
    }
    throw error;
  }
  async function closeWritable() {
    if (!streamsTransferred && !writable.locked) {
      try {
        await writable.getWriter().close();
      } catch {
      }
    }
  }
}
function watchClosedStream(writableSource) {
  const abortController = new AbortController();
  const { writable, readable } = new TransformStream();
  const closed = readable.pipeTo(writableSource, { preventClose: true, preventAbort: true, signal: abortController.signal });
  closed.catch(() => {
  });
  return { writable, closed, abortPipe: () => abortController.abort() };
}
function terminateWorker(workerData) {
  const { worker } = workerData;
  if (worker) {
    try {
      worker.terminate();
    } catch {
    }
  }
  workerData.interface = null;
}
function getWebWorker(url, baseURI, workerData, isModuleType, useBlobURI = true) {
  let worker, resolvedURI, resolvedOptions;
  if (webWorkerURI === UNDEFINED_VALUE || webWorkerSource !== url) {
    const isFunctionURI = typeof url == FUNCTION_TYPE;
    if (isFunctionURI) {
      resolvedURI = url(useBlobURI);
    } else {
      resolvedURI = url;
    }
    const isDataURI = resolvedURI.startsWith("data:");
    const isBlobURI = resolvedURI.startsWith("blob:");
    if (isDataURI || isBlobURI) {
      if (isModuleType === UNDEFINED_VALUE) {
        isModuleType = false;
      }
      if (isModuleType) {
        resolvedOptions = MODULE_WORKER_OPTIONS;
      }
      try {
        worker = new Worker(resolvedURI, resolvedOptions);
      } catch (error) {
        if (isBlobURI) {
          try {
            URL.revokeObjectURL(resolvedURI);
          } catch {
          }
        }
        if (isFunctionURI && isBlobURI) {
          return getWebWorker(url, baseURI, workerData, isModuleType, false);
        } else if (!isModuleType) {
          return getWebWorker(url, baseURI, workerData, true, false);
        } else {
          throw error;
        }
      }
    } else {
      if (isModuleType === UNDEFINED_VALUE) {
        isModuleType = true;
      }
      if (isModuleType) {
        resolvedOptions = MODULE_WORKER_OPTIONS;
      }
      try {
        resolvedURI = new URL(resolvedURI, baseURI);
      } catch {
      }
      try {
        worker = new Worker(resolvedURI, resolvedOptions);
      } catch (error) {
        if (!isModuleType) {
          return getWebWorker(url, baseURI, workerData, false, useBlobURI);
        } else {
          throw error;
        }
      }
    }
    webWorkerSource = url;
    webWorkerURI = resolvedURI;
    webWorkerOptions = resolvedOptions;
  } else {
    worker = new Worker(webWorkerURI, webWorkerOptions);
  }
  worker.addEventListener(MESSAGE_EVENT_TYPE, (event) => onMessage(event, workerData));
  worker.addEventListener(ERROR_EVENT_TYPE, (event) => onWorkerError(event, workerData));
  worker.addEventListener(MESSAGE_ERROR_EVENT_TYPE, (event) => onWorkerError(event, workerData));
  return worker;
}
function onWorkerError(event, workerData) {
  if (event.preventDefault) {
    event.preventDefault();
  }
  const { rejectResult, writer, onTaskFinished } = workerData;
  terminateWorker(workerData);
  if (rejectResult) {
    rejectResult(event.error || new Error(event.message || ERROR_EVENT_TYPE));
    if (writer) {
      writer.releaseLock();
    }
    onTaskFinished();
  }
}
function sendMessage(message, { worker, writer, transferStreams }) {
  try {
    const { value, readable, writable } = message;
    const transferables = [];
    if (value) {
      message.value = value;
      transferables.push(message.value.buffer);
    }
    if (transferStreams && transferStreamsSupported) {
      if (readable) {
        transferables.push(readable);
      }
      if (writable) {
        transferables.push(writable);
      }
    } else {
      message.readable = message.writable = null;
    }
    if (transferables.length) {
      try {
        worker.postMessage(message, transferables);
        return true;
      } catch {
        transferStreamsSupported = false;
        message.readable = message.writable = null;
        worker.postMessage(message);
      }
    } else {
      worker.postMessage(message);
    }
  } catch (error) {
    if (writer) {
      writer.releaseLock();
    }
    throw error;
  }
}
async function onMessage({ data }, workerData) {
  const { type, value, messageId, result, error } = data;
  const { reader, writer, resolveResult, rejectResult, onTaskFinished, generation } = workerData;
  const stale = () => workerData.generation != generation;
  try {
    if (error) {
      const { message, stack, code, name, outputSize } = error;
      const responseError = new Error(message);
      Object.assign(responseError, { stack, code, name, outputSize });
      close(responseError);
    } else {
      if (type == MESSAGE_PULL) {
        const { value: value2, done } = await reader.read();
        if (!stale()) {
          sendMessage({ type: MESSAGE_DATA, value: value2, done, messageId }, workerData);
        }
      }
      if (type == MESSAGE_DATA) {
        await writer.ready;
        await writer.write(new Uint8Array(value));
        if (!stale()) {
          sendMessage({ type: MESSAGE_ACK_DATA, messageId }, workerData);
        }
      }
      if (type == MESSAGE_CLOSE) {
        close(null, result);
      }
    }
  } catch (error2) {
    if (!stale()) {
      terminateWorker(workerData);
      close(error2);
    }
  }
  function close(error2, result2) {
    if (stale()) {
      return;
    }
    if (error2) {
      rejectResult(error2);
    } else {
      resolveResult(result2);
    }
    if (writer) {
      writer.releaseLock();
    }
    onTaskFinished();
  }
}

// node_modules/@zip.js/zip.js/lib/core/codec-pool.js
var pool = [];
var pendingRequests = [];
var starvationTimeout;
var starvationDelay;
var indexWorker = 0;
async function runWorker2(stream, workerOptions) {
  const { options, config: config2 } = workerOptions;
  const { transferStreams, useWebWorkers, useCompressionStream, compressed, signed, encrypted } = options;
  const { workerURI, maxWorkers: maxWorkers2 } = config2;
  workerOptions.transferStreams = transferStreams || transferStreams === UNDEFINED_VALUE;
  const streamCopy = !compressed && !signed && !encrypted && !workerOptions.transferStreams;
  workerOptions.useWebWorkers = !streamCopy && (useWebWorkers || useWebWorkers === UNDEFINED_VALUE && config2.useWebWorkers);
  workerOptions.workerURI = workerOptions.useWebWorkers && workerURI ? workerURI : UNDEFINED_VALUE;
  options.useCompressionStream = useCompressionStream || useCompressionStream === UNDEFINED_VALUE && config2.useCompressionStream;
  return (await getWorker()).run();
  async function getWorker() {
    const workerData = pool.find((workerData2) => !workerData2.busy);
    if (workerData) {
      clearTerminateTimeout(workerData);
      return new CodecWorker(workerData, stream, workerOptions, onTaskFinished);
    } else if (pool.length < maxWorkers2) {
      const workerData2 = { indexWorker };
      indexWorker++;
      pool.push(workerData2);
      return new CodecWorker(workerData2, stream, workerOptions, onTaskFinished);
    } else {
      return new Promise((resolve) => {
        pendingRequests.push({ resolve, stream, workerOptions });
        starvationDelay = config2.workerStarvationTimeout;
        armStarvationTimeout();
      });
    }
  }
  function onTaskFinished(workerData) {
    clearStarvationTimeout();
    if (pendingRequests.length) {
      const [{ resolve, stream: stream2, workerOptions: workerOptions2 }] = pendingRequests.splice(0, 1);
      resolve(new CodecWorker(workerData, stream2, workerOptions2, onTaskFinished));
      armStarvationTimeout();
    } else if (workerData.worker) {
      clearTerminateTimeout(workerData);
      terminateWorker2(workerData, workerOptions);
    } else {
      pool = pool.filter((data) => data != workerData);
    }
  }
}
function armStarvationTimeout() {
  if (!starvationTimeout && pendingRequests.length && Number.isFinite(starvationDelay) && starvationDelay >= 0) {
    starvationTimeout = setTimeout(onWorkerStarvation, starvationDelay);
  }
}
function clearStarvationTimeout() {
  if (starvationTimeout) {
    clearTimeout(starvationTimeout);
    starvationTimeout = null;
  }
}
function onWorkerStarvation() {
  starvationTimeout = null;
  if (pendingRequests.length) {
    const [{ resolve, stream, workerOptions }] = pendingRequests.splice(0, 1);
    const inlineWorkerOptions = Object.assign({}, workerOptions, { useWebWorkers: false, workerURI: UNDEFINED_VALUE });
    resolve(new CodecWorker({}, stream, inlineWorkerOptions, onInlineTaskFinished));
    armStarvationTimeout();
  }
}
function onInlineTaskFinished() {
  clearStarvationTimeout();
  armStarvationTimeout();
}
function terminateWorker2(workerData, workerOptions) {
  const { config: config2 } = workerOptions;
  const { terminateWorkerTimeout } = config2;
  if (Number.isFinite(terminateWorkerTimeout) && terminateWorkerTimeout >= 0) {
    if (workerData.terminated) {
      workerData.terminated = false;
    } else {
      workerData.terminateTimeout = setTimeout(async () => {
        pool = pool.filter((data) => data != workerData);
        try {
          await workerData.terminate();
        } catch {
        }
      }, terminateWorkerTimeout);
    }
  }
}
function clearTerminateTimeout(workerData) {
  const { terminateTimeout } = workerData;
  if (terminateTimeout) {
    clearTimeout(terminateTimeout);
    workerData.terminateTimeout = null;
  }
}

// node_modules/@zip.js/zip.js/lib/core/io.js
var ERR_ITERATOR_COMPLETED_TOO_SOON = "Writer iterator completed too soon";
var DEFAULT_CHUNK_SIZE2 = 64 * 1024;
var DEFAULT_BUFFER_SIZE = 256 * 1024;
var PROPERTY_NAME_WRITABLE = "writable";
var Stream = class {
  constructor() {
    this.size = 0;
  }
  init() {
    this.initialized = true;
  }
};
var Reader = class extends Stream {
  get readable() {
    return this.createReadable();
  }
  createReadable({ offset = 0, size, diskNumberStart, chunkSize = DEFAULT_CHUNK_SIZE2 } = {}) {
    const reader = this;
    let chunkOffset = 0;
    return new ReadableStream({
      async pull(controller) {
        const dataSize = size === UNDEFINED_VALUE ? chunkSize : Math.min(chunkSize, size - chunkOffset);
        const data = await readUint8Array(reader, offset + chunkOffset, dataSize, diskNumberStart);
        controller.enqueue(data);
        if (chunkOffset + chunkSize > size || size === UNDEFINED_VALUE && !data.length && dataSize) {
          controller.close();
        } else {
          chunkOffset += chunkSize;
        }
      }
    });
  }
};
var BlobReader = class extends Reader {
  constructor(blob) {
    super();
    Object.assign(this, {
      blob,
      size: blob.size
    });
  }
  async readUint8Array(offset, length) {
    const reader = this;
    const offsetEnd = offset + length;
    const blob = offset || offsetEnd < reader.size ? reader.blob.slice(offset, offsetEnd) : reader.blob;
    let arrayBuffer = await blob.arrayBuffer();
    if (arrayBuffer.byteLength > length) {
      arrayBuffer = arrayBuffer.slice(offset, offsetEnd);
    }
    return new Uint8Array(arrayBuffer);
  }
};
var SplitDataReader = class extends Reader {
  constructor(readers) {
    super();
    this.readers = readers;
  }
  async init() {
    const reader = this;
    const { readers } = reader;
    reader.lastDiskNumber = 0;
    reader.lastDiskOffset = 0;
    await Promise.all(readers.map(async (diskReader, indexDiskReader) => {
      await initStream(diskReader);
      if (indexDiskReader != readers.length - 1) {
        reader.lastDiskOffset += diskReader.size;
      }
      reader.size += diskReader.size;
    }));
    super.init();
  }
  async readUint8Array(offset, length, diskNumber = 0) {
    const reader = this;
    const { readers } = this;
    let result;
    let currentDiskNumber = diskNumber;
    if (currentDiskNumber == -1) {
      currentDiskNumber = readers.length - 1;
    }
    let currentReaderOffset = offset;
    while (readers[currentDiskNumber] && currentReaderOffset >= readers[currentDiskNumber].size) {
      currentReaderOffset -= readers[currentDiskNumber].size;
      currentDiskNumber++;
    }
    const currentReader = readers[currentDiskNumber];
    if (currentReader) {
      const currentReaderSize = currentReader.size;
      if (currentReaderOffset + length <= currentReaderSize) {
        result = await readUint8Array(currentReader, currentReaderOffset, length);
      } else {
        const chunkLength = currentReaderSize - currentReaderOffset;
        result = new Uint8Array(length);
        const firstPart = await readUint8Array(currentReader, currentReaderOffset, chunkLength);
        result.set(firstPart, 0);
        const secondPart = await reader.readUint8Array(offset + chunkLength, length - chunkLength, diskNumber);
        result.set(secondPart, chunkLength);
        if (firstPart.length + secondPart.length < length) {
          result = result.subarray(0, firstPart.length + secondPart.length);
        }
      }
    } else {
      result = EMPTY_UINT8_ARRAY;
    }
    reader.lastDiskNumber = Math.max(currentDiskNumber, reader.lastDiskNumber);
    return result;
  }
};
var SplitDataWriter = class extends Stream {
  constructor(writerGenerator, maxSize = 4294967295) {
    super();
    const writer = this;
    Object.assign(writer, {
      diskNumber: 0,
      diskOffset: 0,
      size: 0,
      maxSize,
      availableSize: maxSize
    });
    let diskSourceWriter, diskWritable, diskWriter;
    const writable = new WritableStream({
      async write(chunk) {
        const { availableSize } = writer;
        if (!diskWriter) {
          const { value, done } = await writerGenerator.next();
          if (done && !value) {
            throw new Error(ERR_ITERATOR_COMPLETED_TOO_SOON);
          } else {
            diskSourceWriter = value;
            diskSourceWriter.size = 0;
            if (diskSourceWriter.maxSize) {
              writer.maxSize = diskSourceWriter.maxSize;
            }
            writer.availableSize = writer.maxSize;
            await initStream(diskSourceWriter);
            diskWritable = value.writable;
            diskWriter = diskWritable.getWriter();
          }
          await this.write(chunk);
        } else if (chunk.length >= availableSize) {
          await writeChunk(chunk.subarray(0, availableSize));
          await closeDisk();
          writer.diskOffset += diskSourceWriter.size;
          writer.diskNumber++;
          diskWriter = null;
          writer.availableSize = writer.maxSize;
          if (chunk.length > availableSize) {
            await this.write(chunk.subarray(availableSize));
          }
        } else {
          await writeChunk(chunk);
        }
      },
      async close() {
        if (diskWriter) {
          await diskWriter.ready;
          await closeDisk();
        }
      },
      async abort(reason) {
        if (diskWriter) {
          await diskWriter.abort(reason);
        }
      }
    });
    Object.defineProperty(writer, PROPERTY_NAME_WRITABLE, {
      get() {
        return writable;
      }
    });
    async function writeChunk(chunk) {
      const chunkLength = chunk.length;
      if (chunkLength) {
        await diskWriter.ready;
        await diskWriter.write(chunk);
        diskSourceWriter.size += chunkLength;
        writer.availableSize -= chunkLength;
      }
    }
    async function closeDisk() {
      await diskWriter.close();
    }
  }
};
var GenericReader = class {
  constructor(reader) {
    if (Array.isArray(reader)) {
      reader = new SplitDataReader(reader);
    }
    if (reader instanceof ReadableStream) {
      reader = {
        readable: reader
      };
    }
    return reader;
  }
};
var GenericWriter = class {
  constructor(writer) {
    if (writer.writable === UNDEFINED_VALUE && typeof writer.next == FUNCTION_TYPE) {
      writer = new SplitDataWriter(writer);
    }
    if (writer instanceof WritableStream) {
      writer = {
        writable: writer
      };
    }
    if (writer.size === UNDEFINED_VALUE) {
      writer.size = 0;
    }
    if (!(writer instanceof SplitDataWriter)) {
      Object.assign(writer, {
        diskNumber: 0,
        diskOffset: 0,
        availableSize: INFINITY_VALUE,
        maxSize: INFINITY_VALUE
      });
    }
    return writer;
  }
};
async function initStream(stream, initSize) {
  if (stream.init && !stream.initialized) {
    await stream.init(initSize);
  } else {
    return Promise.resolve();
  }
}
function readUint8Array(reader, offset, size, diskNumber) {
  return reader.readUint8Array(offset, size, diskNumber);
}

// node_modules/@zip.js/zip.js/lib/core/zip-entry.js
var PROPERTY_NAME_FILENAME = "filename";
var PROPERTY_NAME_RAW_FILENAME = "rawFilename";
var PROPERTY_NAME_COMMENT = "comment";
var PROPERTY_NAME_RAW_COMMENT = "rawComment";
var PROPERTY_NAME_UNCOMPRESSED_SIZE = "uncompressedSize";
var PROPERTY_NAME_COMPRESSED_SIZE = "compressedSize";
var PROPERTY_NAME_OFFSET = "offset";
var PROPERTY_NAME_DISK_NUMBER_START = "diskNumberStart";
var PROPERTY_NAME_LAST_MODIFICATION_DATE = "lastModDate";
var PROPERTY_NAME_RAW_LAST_MODIFICATION_DATE = "rawLastModDate";
var PROPERTY_NAME_LAST_ACCESS_DATE = "lastAccessDate";
var PROPERTY_NAME_RAW_LAST_ACCESS_DATE = "rawLastAccessDate";
var PROPERTY_NAME_CREATION_DATE = "creationDate";
var PROPERTY_NAME_RAW_CREATION_DATE = "rawCreationDate";
var PROPERTY_NAME_INTERNAL_FILE_ATTRIBUTES = "internalFileAttributes";
var PROPERTY_NAME_EXTERNAL_FILE_ATTRIBUTES = "externalFileAttributes";
var PROPERTY_NAME_MSDOS_ATTRIBUTES_RAW = "msdosAttributesRaw";
var PROPERTY_NAME_MSDOS_ATTRIBUTES = "msdosAttributes";
var PROPERTY_NAME_MS_DOS_COMPATIBLE = "msDosCompatible";
var PROPERTY_NAME_ZIP64 = "zip64";
var PROPERTY_NAME_ENCRYPTED = "encrypted";
var PROPERTY_NAME_VERSION = "version";
var PROPERTY_NAME_VERSION_MADE_BY = "versionMadeBy";
var PROPERTY_NAME_ZIPCRYPTO = "zipCrypto";
var PROPERTY_NAME_DIRECTORY = "directory";
var PROPERTY_NAME_EXECUTABLE = "executable";
var PROPERTY_NAME_COMPRESSION_METHOD = "compressionMethod";
var PROPERTY_NAME_SIGNATURE = "signature";
var PROPERTY_NAME_EXTRA_FIELD = "extraField";
var PROPERTY_NAME_EXTRA_FIELD_INFOZIP = "extraFieldInfoZip";
var PROPERTY_NAME_EXTRA_FIELD_UNIX = "extraFieldUnix";
var PROPERTY_NAME_UID = "uid";
var PROPERTY_NAME_GID = "gid";
var PROPERTY_NAME_UNIX_MODE = "unixMode";
var PROPERTY_NAME_SETUID = "setuid";
var PROPERTY_NAME_SETGID = "setgid";
var PROPERTY_NAME_STICKY = "sticky";
var PROPERTY_NAME_BITFLAG = "bitFlag";
var PROPERTY_NAME_FILENAME_UTF8 = "filenameUTF8";
var PROPERTY_NAME_COMMENT_UTF8 = "commentUTF8";
var PROPERTY_NAME_RAW_EXTRA_FIELD = "rawExtraField";
var PROPERTY_NAME_EXTRA_FIELD_ZIP64 = "extraFieldZip64";
var PROPERTY_NAME_EXTRA_FIELD_UNICODE_PATH = "extraFieldUnicodePath";
var PROPERTY_NAME_EXTRA_FIELD_UNICODE_COMMENT = "extraFieldUnicodeComment";
var PROPERTY_NAME_EXTRA_FIELD_AES = "extraFieldAES";
var PROPERTY_NAME_EXTRA_FIELD_NTFS = "extraFieldNTFS";
var PROPERTY_NAME_EXTRA_FIELD_EXTENDED_TIMESTAMP = "extraFieldExtendedTimestamp";
var PROPERTY_NAMES = [
  PROPERTY_NAME_FILENAME,
  PROPERTY_NAME_RAW_FILENAME,
  PROPERTY_NAME_UNCOMPRESSED_SIZE,
  PROPERTY_NAME_COMPRESSED_SIZE,
  PROPERTY_NAME_LAST_MODIFICATION_DATE,
  PROPERTY_NAME_RAW_LAST_MODIFICATION_DATE,
  PROPERTY_NAME_COMMENT,
  PROPERTY_NAME_RAW_COMMENT,
  PROPERTY_NAME_LAST_ACCESS_DATE,
  PROPERTY_NAME_CREATION_DATE,
  PROPERTY_NAME_RAW_CREATION_DATE,
  PROPERTY_NAME_OFFSET,
  PROPERTY_NAME_DISK_NUMBER_START,
  PROPERTY_NAME_INTERNAL_FILE_ATTRIBUTES,
  PROPERTY_NAME_EXTERNAL_FILE_ATTRIBUTES,
  PROPERTY_NAME_MSDOS_ATTRIBUTES_RAW,
  PROPERTY_NAME_MSDOS_ATTRIBUTES,
  PROPERTY_NAME_MS_DOS_COMPATIBLE,
  PROPERTY_NAME_ZIP64,
  PROPERTY_NAME_ENCRYPTED,
  PROPERTY_NAME_VERSION,
  PROPERTY_NAME_VERSION_MADE_BY,
  PROPERTY_NAME_ZIPCRYPTO,
  PROPERTY_NAME_DIRECTORY,
  PROPERTY_NAME_EXECUTABLE,
  PROPERTY_NAME_COMPRESSION_METHOD,
  PROPERTY_NAME_SIGNATURE,
  PROPERTY_NAME_EXTRA_FIELD,
  PROPERTY_NAME_EXTRA_FIELD_UNIX,
  PROPERTY_NAME_EXTRA_FIELD_INFOZIP,
  PROPERTY_NAME_UID,
  PROPERTY_NAME_GID,
  PROPERTY_NAME_UNIX_MODE,
  PROPERTY_NAME_SETUID,
  PROPERTY_NAME_SETGID,
  PROPERTY_NAME_STICKY,
  PROPERTY_NAME_BITFLAG,
  PROPERTY_NAME_FILENAME_UTF8,
  PROPERTY_NAME_COMMENT_UTF8,
  PROPERTY_NAME_RAW_EXTRA_FIELD,
  PROPERTY_NAME_EXTRA_FIELD_ZIP64,
  PROPERTY_NAME_EXTRA_FIELD_UNICODE_PATH,
  PROPERTY_NAME_EXTRA_FIELD_UNICODE_COMMENT,
  PROPERTY_NAME_EXTRA_FIELD_AES,
  PROPERTY_NAME_EXTRA_FIELD_NTFS,
  PROPERTY_NAME_EXTRA_FIELD_EXTENDED_TIMESTAMP
];
var Entry = class {
  constructor(data) {
    PROPERTY_NAMES.forEach((name) => this[name] = data[name]);
  }
};

// node_modules/@zip.js/zip.js/lib/core/options.js
var OPTION_FILENAME_ENCODING = "filenameEncoding";
var OPTION_COMMENT_ENCODING = "commentEncoding";
var OPTION_DECODE_TEXT = "decodeText";
var OPTION_EXTRACT_PREPENDED_DATA = "extractPrependedData";
var OPTION_EXTRACT_APPENDED_DATA = "extractAppendedData";
var OPTION_PASSWORD = "password";
var OPTION_RAW_PASSWORD = "rawPassword";
var OPTION_PASS_THROUGH = "passThrough";
var OPTION_SIGNAL = "signal";
var OPTION_CHECK_PASSWORD_ONLY = "checkPasswordOnly";
var OPTION_CHECK_OVERLAPPING_ENTRY_ONLY = "checkOverlappingEntryOnly";
var OPTION_CHECK_OVERLAPPING_ENTRY = "checkOverlappingEntry";
var OPTION_CHECK_AMBIGUITY = "checkAmbiguity";
var OPTION_CHECK_SIGNATURE = "checkSignature";
var OPTION_USE_WEB_WORKERS = "useWebWorkers";
var OPTION_USE_COMPRESSION_STREAM = "useCompressionStream";
var OPTION_TRANSFER_STREAMS = "transferStreams";
var OPTION_PREVENT_CLOSE = "preventClose";
var OPTION_ENCRYPTION_STRENGTH = "encryptionStrength";
var OPTION_EXTENDED_TIMESTAMP = "extendedTimestamp";
var OPTION_KEEP_ORDER = "keepOrder";
var OPTION_LEVEL = "level";
var OPTION_BUFFERED_WRITE = "bufferedWrite";
var OPTION_CREATE_TEMP_STREAM = "createTempStream";
var OPTION_DATA_DESCRIPTOR_SIGNATURE = "dataDescriptorSignature";
var OPTION_USE_UNICODE_FILE_NAMES = "useUnicodeFileNames";
var OPTION_DATA_DESCRIPTOR = "dataDescriptor";
var OPTION_SUPPORT_ZIP64_SPLIT_FILE = "supportZip64SplitFile";
var OPTION_ENCODE_TEXT = "encodeText";
var OPTION_OFFSET = "offset";
var OPTION_USDZ = "usdz";
var OPTION_UNIX_EXTRA_FIELD_TYPE = "unixExtraFieldType";
var OPTION_STRICTNESS = "strictness";
var OPTION_MAX_APPENDED_DATA_SIZE = "maxAppendedDataSize";
var STRICTNESS_STRICT = "strict";
var STRICTNESS_BALANCED = "balanced";
var STRICTNESS_TOLERANT = "tolerant";

// node_modules/@zip.js/zip.js/lib/core/util/decode-cp437.js
var CP437 = "\0\u263A\u263B\u2665\u2666\u2663\u2660\u2022\u25D8\u25CB\u25D9\u2642\u2640\u266A\u266B\u263C\u25BA\u25C4\u2195\u203C\xB6\xA7\u25AC\u21A8\u2191\u2193\u2192\u2190\u221F\u2194\u25B2\u25BC !\"#$%&'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~\u2302\xC7\xFC\xE9\xE2\xE4\xE0\xE5\xE7\xEA\xEB\xE8\xEF\xEE\xEC\xC4\xC5\xC9\xE6\xC6\xF4\xF6\xF2\xFB\xF9\xFF\xD6\xDC\xA2\xA3\xA5\u20A7\u0192\xE1\xED\xF3\xFA\xF1\xD1\xAA\xBA\xBF\u2310\xAC\xBD\xBC\xA1\xAB\xBB\u2591\u2592\u2593\u2502\u2524\u2561\u2562\u2556\u2555\u2563\u2551\u2557\u255D\u255C\u255B\u2510\u2514\u2534\u252C\u251C\u2500\u253C\u255E\u255F\u255A\u2554\u2569\u2566\u2560\u2550\u256C\u2567\u2568\u2564\u2565\u2559\u2558\u2552\u2553\u256B\u256A\u2518\u250C\u2588\u2584\u258C\u2590\u2580\u03B1\xDF\u0393\u03C0\u03A3\u03C3\xB5\u03C4\u03A6\u0398\u03A9\u03B4\u221E\u03C6\u03B5\u2229\u2261\xB1\u2265\u2264\u2320\u2321\xF7\u2248\xB0\u2219\xB7\u221A\u207F\xB2\u25A0\xA0".split("");
var VALID_CP437 = CP437.length == 256;
function decodeCP437(stringValue2) {
  if (VALID_CP437) {
    let result = "";
    for (let indexCharacter = 0; indexCharacter < stringValue2.length; indexCharacter++) {
      result += CP437[stringValue2[indexCharacter]];
    }
    return result;
  } else {
    return new TextDecoder().decode(stringValue2);
  }
}

// node_modules/@zip.js/zip.js/lib/core/util/decode-text.js
function decodeText(value, encoding) {
  if (encoding && encoding.trim().toLowerCase() == "cp437") {
    return decodeCP437(value);
  } else {
    return new TextDecoder(encoding, { ignoreBOM: true }).decode(value);
  }
}

// node_modules/@zip.js/zip.js/lib/core/zip-reader.js
var ERR_BAD_FORMAT = "File format is not recognized";
var ERR_EOCDR_NOT_FOUND = "End of central directory not found";
var ERR_EOCDR_LOCATOR_ZIP64_NOT_FOUND = "End of Zip64 central directory locator not found";
var ERR_CENTRAL_DIRECTORY_NOT_FOUND = "Central directory header not found";
var ERR_LOCAL_FILE_HEADER_NOT_FOUND = "Local file header not found";
var ERR_EXTRAFIELD_ZIP64_NOT_FOUND = "Zip64 extra field not found";
var ERR_ENCRYPTED = "File contains encrypted entry";
var ERR_UNSUPPORTED_ENCRYPTION = "Encryption method not supported";
var ERR_UNSUPPORTED_COMPRESSION = "Compression method not supported";
var ERR_SPLIT_ZIP_FILE = "Split zip file";
var ERR_OVERLAPPING_ENTRY = "Overlapping entry found";
var ERR_AMBIGUOUS_ARCHIVE = "Ambiguous archive";
var CHARSET_UTF8 = "utf-8";
var PROPERTY_NAME_UTF8_SUFFIX = "UTF8";
var CHARSET_CP437 = "cp437";
var BITFLAG_AMBIGUITY_MASK = BITFLAG_ENCRYPTED | BITFLAG_DATA_DESCRIPTOR | BITFLAG_LANG_ENCODING_FLAG;
var ZIP64_PROPERTIES = [
  [PROPERTY_NAME_UNCOMPRESSED_SIZE, MAX_32_BITS],
  [PROPERTY_NAME_COMPRESSED_SIZE, MAX_32_BITS],
  [PROPERTY_NAME_OFFSET, MAX_32_BITS],
  [PROPERTY_NAME_DISK_NUMBER_START, MAX_16_BITS]
];
var ZIP64_EXTRACTION = {
  [MAX_16_BITS]: {
    getValue: getUint32,
    bytes: 4
  },
  [MAX_32_BITS]: {
    getValue: getBigUint64,
    bytes: 8
  }
};
var ZipReader = class {
  constructor(reader, options = {}) {
    Object.assign(this, {
      reader: new GenericReader(reader),
      options,
      config: getConfiguration(),
      readRanges: /* @__PURE__ */ new Map()
    });
  }
  async *getEntriesGenerator(options = {}) {
    const zipReader = this;
    let { reader } = zipReader;
    const { config: config2 } = zipReader;
    await initStream(reader);
    if (reader.size === UNDEFINED_VALUE || !reader.readUint8Array) {
      reader = new BlobReader(await new Response(reader.readable).blob());
      await initStream(reader);
    }
    if (reader.size < END_OF_CENTRAL_DIR_LENGTH) {
      throw new Error(ERR_BAD_FORMAT);
    }
    const strictness = getStrictness(getOptionValue(zipReader, options, OPTION_STRICTNESS), getOptionValue(zipReader, options, OPTION_CHECK_AMBIGUITY));
    const checkAmbiguity = strictness == STRICTNESS_STRICT;
    const rejectAmbiguousEndOfDirectory = strictness != STRICTNESS_TOLERANT;
    const maxAppendedDataSize = getMaxAppendedDataSize(getOptionValue(zipReader, options, OPTION_MAX_APPENDED_DATA_SIZE), strictness);
    const { endOfDirectoryInfo, endOfDirectoryReachingEndCount } = await findEndOfCentralDirectory(reader, rejectAmbiguousEndOfDirectory, maxAppendedDataSize);
    if (!endOfDirectoryInfo) {
      const signatureArray = await readUint8Array(reader, 0, 4);
      const signatureView = getDataView(signatureArray);
      if (getUint32(signatureView) == SPLIT_ZIP_FILE_SIGNATURE) {
        throw new Error(ERR_SPLIT_ZIP_FILE);
      } else {
        throw new Error(ERR_EOCDR_NOT_FOUND);
      }
    }
    if (rejectAmbiguousEndOfDirectory && endOfDirectoryReachingEndCount > 1) {
      throwAmbiguousArchive("multiple end of central directory records");
    }
    const endOfDirectoryView = getDataView(endOfDirectoryInfo);
    let directoryDataLength = getUint32(endOfDirectoryView, 12);
    let directoryDataOffset = getUint32(endOfDirectoryView, 16);
    const commentOffset = endOfDirectoryInfo.offset;
    const commentLength = getUint16(endOfDirectoryView, 20);
    const appendedDataOffset = commentOffset + END_OF_CENTRAL_DIR_LENGTH + commentLength;
    if (reader.size - appendedDataOffset > maxAppendedDataSize) {
      throwAmbiguousArchive("appended data");
    }
    let lastDiskNumber = getUint16(endOfDirectoryView, 4);
    const expectedLastDiskNumber = reader.lastDiskNumber || 0;
    let diskNumber = getUint16(endOfDirectoryView, 6);
    let filesLength = getUint16(endOfDirectoryView, 10);
    let prependedDataLength = 0;
    let startOffset;
    let zip64EndOfDirectory;
    if (directoryDataOffset == MAX_32_BITS || directoryDataLength == MAX_32_BITS || filesLength == MAX_16_BITS || diskNumber == MAX_16_BITS) {
      const endOfDirectoryLocatorArray = endOfDirectoryInfo.offset >= ZIP64_END_OF_CENTRAL_DIR_LOCATOR_LENGTH ? await readUint8Array(reader, endOfDirectoryInfo.offset - ZIP64_END_OF_CENTRAL_DIR_LOCATOR_LENGTH, ZIP64_END_OF_CENTRAL_DIR_LOCATOR_LENGTH) : EMPTY_UINT8_ARRAY;
      const endOfDirectoryLocatorView = getDataView(endOfDirectoryLocatorArray);
      if (endOfDirectoryLocatorArray.length == ZIP64_END_OF_CENTRAL_DIR_LOCATOR_LENGTH && getUint32(endOfDirectoryLocatorView, 0) == ZIP64_END_OF_CENTRAL_DIR_LOCATOR_SIGNATURE) {
        directoryDataOffset = getBigUint64(endOfDirectoryLocatorView, 8);
        let endOfDirectoryArray = await readUint8Array(reader, directoryDataOffset, ZIP64_END_OF_CENTRAL_DIR_LENGTH, -1);
        let endOfDirectoryView2 = getDataView(endOfDirectoryArray);
        const expectedDirectoryDataOffset = endOfDirectoryInfo.offset - ZIP64_END_OF_CENTRAL_DIR_LOCATOR_LENGTH - ZIP64_END_OF_CENTRAL_DIR_LENGTH - (reader.lastDiskOffset || 0);
        if ((endOfDirectoryArray.length < ZIP64_END_OF_CENTRAL_DIR_LENGTH || getUint32(endOfDirectoryView2, 0) != ZIP64_END_OF_CENTRAL_DIR_SIGNATURE) && directoryDataOffset != expectedDirectoryDataOffset && expectedDirectoryDataOffset >= 0) {
          const originalDirectoryDataOffset = directoryDataOffset;
          directoryDataOffset = expectedDirectoryDataOffset;
          if (directoryDataOffset > originalDirectoryDataOffset) {
            prependedDataLength = directoryDataOffset - originalDirectoryDataOffset;
          }
          endOfDirectoryArray = await readUint8Array(reader, directoryDataOffset, ZIP64_END_OF_CENTRAL_DIR_LENGTH, -1);
          endOfDirectoryView2 = getDataView(endOfDirectoryArray);
        }
        if (endOfDirectoryArray.length < ZIP64_END_OF_CENTRAL_DIR_LENGTH || getUint32(endOfDirectoryView2, 0) != ZIP64_END_OF_CENTRAL_DIR_SIGNATURE) {
          throw new Error(ERR_EOCDR_LOCATOR_ZIP64_NOT_FOUND);
        }
        zip64EndOfDirectory = true;
        if (lastDiskNumber == MAX_16_BITS) {
          lastDiskNumber = getUint32(endOfDirectoryView2, 16);
        } else if (checkAmbiguity && lastDiskNumber != getUint32(endOfDirectoryView2, 16)) {
          throwAmbiguousArchive("mismatched zip64 end of central directory record");
        }
        if (diskNumber == MAX_16_BITS) {
          diskNumber = getUint32(endOfDirectoryView2, 20);
        } else if (checkAmbiguity && diskNumber != getUint32(endOfDirectoryView2, 20)) {
          throwAmbiguousArchive("mismatched zip64 end of central directory record");
        }
        if (filesLength == MAX_16_BITS) {
          filesLength = getBigUint64(endOfDirectoryView2, 32);
        } else if (checkAmbiguity && filesLength != getBigUint64(endOfDirectoryView2, 32)) {
          throwAmbiguousArchive("mismatched zip64 end of central directory record");
        }
        if (directoryDataLength == MAX_32_BITS) {
          directoryDataLength = getBigUint64(endOfDirectoryView2, 40);
        } else if (checkAmbiguity && directoryDataLength != getBigUint64(endOfDirectoryView2, 40)) {
          throwAmbiguousArchive("mismatched zip64 end of central directory record");
        }
        directoryDataOffset = getBigUint64(endOfDirectoryView2, 48) + prependedDataLength;
      }
    }
    const declaredDirectoryDataLength = directoryDataLength;
    const centralDirectoryEndOffset = endOfDirectoryInfo.offset - (zip64EndOfDirectory ? ZIP64_END_OF_CENTRAL_DIR_LENGTH + ZIP64_END_OF_CENTRAL_DIR_LOCATOR_LENGTH : 0);
    if (directoryDataOffset >= reader.size) {
      prependedDataLength = reader.size - directoryDataOffset - directoryDataLength - END_OF_CENTRAL_DIR_LENGTH;
      directoryDataOffset = reader.size - directoryDataLength - END_OF_CENTRAL_DIR_LENGTH;
    }
    if (expectedLastDiskNumber != lastDiskNumber) {
      throw new Error(ERR_SPLIT_ZIP_FILE);
    }
    if (directoryDataOffset < 0) {
      throw new Error(ERR_BAD_FORMAT);
    }
    let offset = 0;
    let directoryArray = await readUint8Array(reader, directoryDataOffset, directoryDataLength, diskNumber);
    let directoryView = getDataView(directoryArray);
    if (directoryDataLength) {
      if (directoryArray.length < 4) {
        throw new Error(ERR_BAD_FORMAT);
      }
      const expectedDirectoryDataOffset = centralDirectoryEndOffset - directoryDataLength - (reader.lastDiskOffset || 0);
      if (directoryDataOffset != expectedDirectoryDataOffset && diskNumber == lastDiskNumber) {
        const storedPointsAtDirectory = getUint32(directoryView, offset) == CENTRAL_FILE_HEADER_SIGNATURE;
        let reconcile = !storedPointsAtDirectory;
        if (!reconcile && expectedDirectoryDataOffset >= 0 && expectedDirectoryDataOffset + 4 <= reader.size) {
          const expectedSignatureArray = await readUint8Array(reader, expectedDirectoryDataOffset, 4, diskNumber);
          reconcile = getUint32(getDataView(expectedSignatureArray), 0) == CENTRAL_FILE_HEADER_SIGNATURE;
        }
        if (reconcile) {
          const originalDirectoryDataOffset = directoryDataOffset;
          directoryDataOffset = expectedDirectoryDataOffset;
          if (directoryDataOffset > originalDirectoryDataOffset) {
            prependedDataLength += directoryDataOffset - originalDirectoryDataOffset;
          }
          directoryArray = await readUint8Array(reader, directoryDataOffset, directoryDataLength, diskNumber);
          directoryView = getDataView(directoryArray);
        }
      }
    }
    const expectedDirectoryDataLength = centralDirectoryEndOffset - directoryDataOffset - (reader.lastDiskOffset || 0);
    if (directoryDataLength != expectedDirectoryDataLength && expectedDirectoryDataLength >= 0 && diskNumber == lastDiskNumber) {
      directoryDataLength = expectedDirectoryDataLength;
      directoryArray = await readUint8Array(reader, directoryDataOffset, directoryDataLength, diskNumber);
      directoryView = getDataView(directoryArray);
    }
    if (directoryDataOffset < 0 || directoryDataOffset >= reader.size) {
      throw new Error(ERR_BAD_FORMAT);
    }
    startOffset = directoryDataOffset;
    const filenameEncoding = getOptionValue(zipReader, options, OPTION_FILENAME_ENCODING);
    const commentEncoding = getOptionValue(zipReader, options, OPTION_COMMENT_ENCODING);
    const filenames = checkAmbiguity ? /* @__PURE__ */ new Set() : UNDEFINED_VALUE;
    let duplicateFilename;
    for (let indexFile = 0; indexFile < filesLength; indexFile++) {
      const fileEntry = new ZipEntry(reader, config2, zipReader.options);
      if (offset + CENTRAL_FILE_HEADER_LENGTH > directoryArray.length || getUint32(directoryView, offset) != CENTRAL_FILE_HEADER_SIGNATURE) {
        throw new Error(ERR_CENTRAL_DIRECTORY_NOT_FOUND);
      }
      readCommonHeader(fileEntry, directoryView, offset + 6);
      const languageEncodingFlag = Boolean(fileEntry.bitFlag.languageEncodingFlag);
      const filenameOffset = offset + CENTRAL_FILE_HEADER_LENGTH;
      const extraFieldOffset = filenameOffset + fileEntry.filenameLength;
      const commentOffset2 = extraFieldOffset + fileEntry.extraFieldLength;
      const versionMadeBy = getUint16(directoryView, offset + 4);
      const msDosCompatible = versionMadeBy >> 8 == 0;
      const unixCompatible = versionMadeBy >> 8 == 3;
      const rawFilename = directoryArray.subarray(filenameOffset, extraFieldOffset);
      const commentLength2 = getUint16(directoryView, offset + 32);
      const endOffset = commentOffset2 + commentLength2;
      const rawComment = directoryArray.subarray(commentOffset2, endOffset);
      const filenameUTF8 = languageEncodingFlag;
      const commentUTF8 = languageEncodingFlag;
      const externalFileAttributes = getUint32(directoryView, offset + 38);
      const msdosAttributesRaw = externalFileAttributes & MAX_8_BITS;
      const msdosAttributes = {
        readOnly: Boolean(msdosAttributesRaw & FILE_ATTR_MSDOS_READONLY_MASK),
        hidden: Boolean(msdosAttributesRaw & FILE_ATTR_MSDOS_HIDDEN_MASK),
        system: Boolean(msdosAttributesRaw & FILE_ATTR_MSDOS_SYSTEM_MASK),
        directory: Boolean(msdosAttributesRaw & FILE_ATTR_MSDOS_DIR_MASK),
        archive: Boolean(msdosAttributesRaw & FILE_ATTR_MSDOS_ARCHIVE_MASK)
      };
      const offsetFileEntry = getUint32(directoryView, offset + 42);
      const decode = getOptionValue(zipReader, options, OPTION_DECODE_TEXT) || decodeText;
      const rawFilenameEncoding = filenameUTF8 ? CHARSET_UTF8 : filenameEncoding || CHARSET_CP437;
      const rawCommentEncoding = commentUTF8 ? CHARSET_UTF8 : commentEncoding || CHARSET_CP437;
      let filename = decode(rawFilename, rawFilenameEncoding);
      if (filename === UNDEFINED_VALUE) {
        filename = decodeText(rawFilename, rawFilenameEncoding);
      }
      let comment = decode(rawComment, rawCommentEncoding);
      if (comment === UNDEFINED_VALUE) {
        comment = decodeText(rawComment, rawCommentEncoding);
      }
      Object.assign(fileEntry, {
        index: indexFile,
        versionMadeBy,
        msDosCompatible,
        compressedSize: 0,
        uncompressedSize: 0,
        commentLength: commentLength2,
        offset: offsetFileEntry,
        diskNumberStart: getUint16(directoryView, offset + 34),
        internalFileAttributes: getUint16(directoryView, offset + 36),
        externalFileAttributes,
        msdosAttributesRaw,
        msdosAttributes,
        rawFilename,
        filenameUTF8,
        commentUTF8,
        rawExtraField: directoryArray.subarray(extraFieldOffset, commentOffset2),
        rawComment,
        filename,
        comment
      });
      readCommonFooter(fileEntry, fileEntry, directoryView, offset + 6);
      fileEntry.offset += prependedDataLength;
      startOffset = Math.min(fileEntry.offset, startOffset);
      if (checkAmbiguity) {
        if (filenames.has(fileEntry.filename)) {
          duplicateFilename = true;
        }
        filenames.add(fileEntry.filename);
      }
      const unixExternalUpper = fileEntry.externalFileAttributes >> 16 & MAX_16_BITS;
      if (fileEntry.unixMode === UNDEFINED_VALUE && (unixExternalUpper & (FILE_ATTR_UNIX_DEFAULT_MASK | FILE_ATTR_UNIX_EXECUTABLE_MASK | FILE_ATTR_UNIX_TYPE_DIR)) != 0) {
        fileEntry.unixMode = unixExternalUpper;
      }
      const setuid = Boolean(fileEntry.unixMode & FILE_ATTR_UNIX_SETUID_MASK);
      const setgid = Boolean(fileEntry.unixMode & FILE_ATTR_UNIX_SETGID_MASK);
      const sticky = Boolean(fileEntry.unixMode & FILE_ATTR_UNIX_STICKY_MASK);
      const executable = fileEntry.unixMode !== UNDEFINED_VALUE ? (fileEntry.unixMode & FILE_ATTR_UNIX_EXECUTABLE_MASK) != 0 : unixCompatible && (unixExternalUpper & FILE_ATTR_UNIX_EXECUTABLE_MASK) != 0;
      const modeIsDir = fileEntry.unixMode !== UNDEFINED_VALUE && (fileEntry.unixMode & FILE_ATTR_UNIX_TYPE_MASK) == FILE_ATTR_UNIX_TYPE_DIR;
      const upperIsDir = (unixExternalUpper & FILE_ATTR_UNIX_TYPE_MASK) == FILE_ATTR_UNIX_TYPE_DIR;
      Object.assign(fileEntry, {
        setuid,
        setgid,
        sticky,
        unixExternalUpper,
        internalFileAttribute: fileEntry.internalFileAttributes,
        externalFileAttribute: fileEntry.externalFileAttributes,
        executable,
        directory: modeIsDir || upperIsDir || msDosCompatible && msdosAttributes.directory || fileEntry.filename.endsWith(DIRECTORY_SIGNATURE) && !fileEntry.uncompressedSize,
        zipCrypto: fileEntry.encrypted && !fileEntry.extraFieldAES
      });
      const entry = new Entry(fileEntry);
      entry.getData = (writer, options2) => fileEntry.getData(writer, entry, zipReader.readRanges, options2);
      entry.arrayBuffer = async (options2) => {
        const writer = new TransformStream();
        const [arrayBuffer] = await Promise.all([
          new Response(writer.readable).arrayBuffer(),
          fileEntry.getData(writer, entry, zipReader.readRanges, options2)
        ]);
        return arrayBuffer;
      };
      offset = endOffset;
      const { onprogress } = options;
      if (onprogress) {
        try {
          await onprogress(indexFile + 1, filesLength, new Entry(fileEntry));
        } catch {
        }
      }
      yield entry;
    }
    if (checkAmbiguity && offset != declaredDirectoryDataLength) {
      throwAmbiguousArchive("trailing central directory data");
    }
    if (duplicateFilename) {
      throwAmbiguousArchive("duplicate filename");
    }
    if (checkAmbiguity && (prependedDataLength || filesLength && startOffset > 0)) {
      throwAmbiguousArchive("prepended data");
    }
    const extractPrependedData = getOptionValue(zipReader, options, OPTION_EXTRACT_PREPENDED_DATA);
    const extractAppendedData = getOptionValue(zipReader, options, OPTION_EXTRACT_APPENDED_DATA);
    if (extractPrependedData) {
      zipReader.prependedData = startOffset > 0 ? await readUint8Array(reader, 0, startOffset) : EMPTY_UINT8_ARRAY;
    }
    zipReader.comment = commentLength ? await readUint8Array(reader, commentOffset + END_OF_CENTRAL_DIR_LENGTH, commentLength) : EMPTY_UINT8_ARRAY;
    if (extractAppendedData) {
      zipReader.appendedData = appendedDataOffset < reader.size ? await readUint8Array(reader, appendedDataOffset, reader.size - appendedDataOffset) : EMPTY_UINT8_ARRAY;
    }
    return true;
  }
  async getEntries(options = {}) {
    const entries = [];
    for await (const entry of this.getEntriesGenerator(options)) {
      entries.push(entry);
    }
    return entries;
  }
  async close() {
  }
};
var ZipEntry = class {
  constructor(reader, config2, options) {
    Object.assign(this, {
      reader,
      config: config2,
      options
    });
  }
  async getData(writer, fileEntry, readRanges, options = {}) {
    const zipEntry = this;
    const {
      reader,
      index,
      offset,
      diskNumberStart,
      extraFieldAES,
      extraFieldZip64,
      compressionMethod,
      config: config2,
      bitFlag,
      signature,
      rawLastModDate,
      uncompressedSize,
      compressedSize
    } = zipEntry;
    const {
      dataDescriptor
    } = bitFlag;
    const localDirectory = fileEntry.localDirectory = {};
    const dataArray = await readUint8Array(reader, offset, HEADER_SIZE, diskNumberStart);
    const dataView = getDataView(dataArray);
    let password = getOptionValue(zipEntry, options, OPTION_PASSWORD);
    let rawPassword = getOptionValue(zipEntry, options, OPTION_RAW_PASSWORD);
    const passThrough = getOptionValue(zipEntry, options, OPTION_PASS_THROUGH);
    password = password && password.length && password;
    rawPassword = rawPassword && rawPassword.length && rawPassword;
    if (extraFieldAES) {
      if (extraFieldAES.originalCompressionMethod != COMPRESSION_METHOD_AES) {
        throw new Error(ERR_UNSUPPORTED_COMPRESSION);
      }
    }
    if (compressionMethod != COMPRESSION_METHOD_STORE && compressionMethod != COMPRESSION_METHOD_DEFLATE && compressionMethod != COMPRESSION_METHOD_DEFLATE_64 && !passThrough) {
      throw new Error(ERR_UNSUPPORTED_COMPRESSION);
    }
    if (dataArray.length < HEADER_SIZE || getUint32(dataView, 0) != LOCAL_FILE_HEADER_SIGNATURE) {
      throw new Error(ERR_LOCAL_FILE_HEADER_NOT_FOUND);
    }
    readCommonHeader(localDirectory, dataView, 4);
    const {
      extraFieldLength,
      filenameLength
    } = localDirectory;
    const checkAmbiguity = getStrictness(getOptionValue(zipEntry, options, OPTION_STRICTNESS), getOptionValue(zipEntry, options, OPTION_CHECK_AMBIGUITY)) == STRICTNESS_STRICT;
    let rawLocalFilename = EMPTY_UINT8_ARRAY;
    if (checkAmbiguity && (filenameLength || extraFieldLength)) {
      const trailingDataArray = await readUint8Array(reader, offset + HEADER_SIZE, filenameLength + extraFieldLength, diskNumberStart);
      rawLocalFilename = trailingDataArray.subarray(0, filenameLength);
      localDirectory.rawExtraField = trailingDataArray.subarray(filenameLength);
    } else {
      localDirectory.rawExtraField = extraFieldLength ? await readUint8Array(reader, offset + HEADER_SIZE + filenameLength, extraFieldLength, diskNumberStart) : EMPTY_UINT8_ARRAY;
    }
    readCommonFooter(zipEntry, localDirectory, dataView, 4, true);
    if (checkAmbiguity) {
      checkLocalDirectory(zipEntry, localDirectory, rawLocalFilename);
    }
    const { lastAccessDate, creationDate } = localDirectory;
    if (lastAccessDate) {
      fileEntry.lastAccessDate = lastAccessDate;
    }
    if (creationDate) {
      fileEntry.creationDate = creationDate;
    }
    const encrypted = zipEntry.encrypted && localDirectory.encrypted && !passThrough;
    const zipCrypto = encrypted && !extraFieldAES;
    if (!passThrough) {
      fileEntry.zipCrypto = zipCrypto;
    }
    if (encrypted) {
      if (!zipCrypto && extraFieldAES.strength === UNDEFINED_VALUE) {
        throw new Error(ERR_UNSUPPORTED_ENCRYPTION);
      } else if (!password && !rawPassword) {
        throw new Error(ERR_ENCRYPTED);
      }
    }
    const dataOffset = offset + HEADER_SIZE + filenameLength + extraFieldLength;
    const size = compressedSize;
    const readable = reader.createReadable({ offset: dataOffset, size, diskNumberStart, chunkSize: getChunkSize(config2) });
    const signal = getOptionValue(zipEntry, options, OPTION_SIGNAL);
    const checkPasswordOnly = getOptionValue(zipEntry, options, OPTION_CHECK_PASSWORD_ONLY);
    let checkOverlappingEntry = getOptionValue(zipEntry, options, OPTION_CHECK_OVERLAPPING_ENTRY);
    const checkOverlappingEntryOnly = getOptionValue(zipEntry, options, OPTION_CHECK_OVERLAPPING_ENTRY_ONLY);
    if (checkOverlappingEntryOnly) {
      checkOverlappingEntry = true;
    }
    const { onstart, onprogress, onend } = options;
    const deflate64 = compressionMethod == COMPRESSION_METHOD_DEFLATE_64;
    let useCompressionStream = getOptionValue(zipEntry, options, OPTION_USE_COMPRESSION_STREAM);
    if (deflate64) {
      useCompressionStream = false;
    }
    const workerOptions = {
      options: {
        codecType: CODEC_INFLATE,
        password,
        rawPassword,
        zipCrypto,
        encryptionStrength: extraFieldAES && extraFieldAES.strength,
        signed: getOptionValue(zipEntry, options, OPTION_CHECK_SIGNATURE) && !passThrough,
        passwordVerification: zipCrypto && (dataDescriptor ? rawLastModDate >>> 8 & MAX_8_BITS : signature >>> 24 & MAX_8_BITS),
        outputSize: passThrough ? compressedSize : uncompressedSize,
        signature,
        compressed: compressionMethod != 0 && !passThrough,
        encrypted,
        useWebWorkers: getOptionValue(zipEntry, options, OPTION_USE_WEB_WORKERS),
        useCompressionStream,
        transferStreams: getOptionValue(zipEntry, options, OPTION_TRANSFER_STREAMS),
        deflate64,
        checkPasswordOnly
      },
      config: config2,
      streamOptions: { signal, size, onstart, onprogress, onend }
    };
    if (checkOverlappingEntry) {
      await detectOverlappingEntry({
        reader,
        fileEntry,
        index,
        offset,
        diskNumberStart,
        signature,
        compressedSize,
        uncompressedSize,
        dataOffset,
        dataDescriptor: dataDescriptor || localDirectory.bitFlag.dataDescriptor,
        extraFieldZip64: extraFieldZip64 || localDirectory.extraFieldZip64,
        readRanges
      });
    }
    let writable;
    try {
      if (!checkOverlappingEntryOnly) {
        if (checkPasswordOnly) {
          writer = new WritableStream();
        }
        writer = new GenericWriter(writer);
        await initStream(writer, passThrough ? compressedSize : uncompressedSize);
        ({ writable } = writer);
        const { outputSize } = await runWorker2({ readable, writable }, workerOptions);
        writer.size += outputSize;
        if (outputSize != (passThrough ? compressedSize : uncompressedSize)) {
          throw new Error(ERR_INVALID_UNCOMPRESSED_SIZE);
        }
      }
    } catch (error) {
      if (error.outputSize !== UNDEFINED_VALUE) {
        writer.size += error.outputSize;
      }
      if (!checkPasswordOnly || error.message != ERR_ABORT_CHECK_PASSWORD) {
        throw error;
      }
    } finally {
      const preventClose = getOptionValue(zipEntry, options, OPTION_PREVENT_CLOSE);
      if (!preventClose && writable && !writable.locked) {
        await writable.getWriter().close();
      }
    }
    return checkPasswordOnly || checkOverlappingEntryOnly ? UNDEFINED_VALUE : writer.getData ? writer.getData() : writable;
  }
};
function readCommonHeader(directory, dataView, offset) {
  const rawBitFlag = directory.rawBitFlag = getUint16(dataView, offset + 2);
  const encrypted = (rawBitFlag & BITFLAG_ENCRYPTED) == BITFLAG_ENCRYPTED;
  const rawLastModDate = getUint32(dataView, offset + 6);
  Object.assign(directory, {
    encrypted,
    version: getUint16(dataView, offset),
    bitFlag: {
      level: (rawBitFlag & BITFLAG_LEVEL) >> 1,
      dataDescriptor: (rawBitFlag & BITFLAG_DATA_DESCRIPTOR) == BITFLAG_DATA_DESCRIPTOR,
      languageEncodingFlag: (rawBitFlag & BITFLAG_LANG_ENCODING_FLAG) == BITFLAG_LANG_ENCODING_FLAG
    },
    rawLastModDate,
    lastModDate: getDate(rawLastModDate),
    filenameLength: getUint16(dataView, offset + 22),
    extraFieldLength: getUint16(dataView, offset + 24)
  });
}
function readCommonFooter(fileEntry, directory, dataView, offset, localDirectory) {
  const { rawExtraField } = directory;
  const extraField = directory.extraField = /* @__PURE__ */ new Map();
  const rawExtraFieldView = getDataView(new Uint8Array(rawExtraField));
  let offsetExtraField = 0;
  try {
    while (offsetExtraField < rawExtraField.length) {
      const type = getUint16(rawExtraFieldView, offsetExtraField);
      const size = getUint16(rawExtraFieldView, offsetExtraField + 2);
      extraField.set(type, {
        type,
        data: rawExtraField.slice(offsetExtraField + 4, offsetExtraField + 4 + size)
      });
      offsetExtraField += 4 + size;
    }
  } catch {
  }
  const compressionMethod = getUint16(dataView, offset + 4);
  Object.assign(directory, {
    signature: getUint32(dataView, offset + HEADER_OFFSET_SIGNATURE),
    compressedSize: getUint32(dataView, offset + HEADER_OFFSET_COMPRESSED_SIZE),
    uncompressedSize: getUint32(dataView, offset + HEADER_OFFSET_UNCOMPRESSED_SIZE)
  });
  const extraFieldZip64 = extraField.get(EXTRAFIELD_TYPE_ZIP64);
  if (extraFieldZip64) {
    readExtraFieldZip64(extraFieldZip64, directory);
    directory.extraFieldZip64 = extraFieldZip64;
  }
  const extraFieldUnicodePath = extraField.get(EXTRAFIELD_TYPE_UNICODE_PATH);
  if (extraFieldUnicodePath) {
    readExtraFieldUnicode(extraFieldUnicodePath, PROPERTY_NAME_FILENAME, PROPERTY_NAME_RAW_FILENAME, directory, fileEntry);
    directory.extraFieldUnicodePath = extraFieldUnicodePath;
  }
  const extraFieldUnicodeComment = extraField.get(EXTRAFIELD_TYPE_UNICODE_COMMENT);
  if (extraFieldUnicodeComment) {
    readExtraFieldUnicode(extraFieldUnicodeComment, PROPERTY_NAME_COMMENT, PROPERTY_NAME_RAW_COMMENT, directory, fileEntry);
    directory.extraFieldUnicodeComment = extraFieldUnicodeComment;
  }
  const extraFieldAES = extraField.get(EXTRAFIELD_TYPE_AES);
  if (extraFieldAES && extraFieldAES.data.length >= 7) {
    readExtraFieldAES(extraFieldAES, directory, compressionMethod);
    directory.extraFieldAES = extraFieldAES;
  } else {
    directory.compressionMethod = compressionMethod;
  }
  const extraFieldNTFS = extraField.get(EXTRAFIELD_TYPE_NTFS);
  if (extraFieldNTFS) {
    readExtraFieldNTFS(extraFieldNTFS, directory);
    directory.extraFieldNTFS = extraFieldNTFS;
  }
  const extraFieldUnix = extraField.get(EXTRAFIELD_TYPE_UNIX);
  if (extraFieldUnix) {
    readExtraFieldUnix(extraFieldUnix, directory, false);
    directory.extraFieldUnix = extraFieldUnix;
  } else {
    const extraFieldInfoZip = extraField.get(EXTRAFIELD_TYPE_INFOZIP);
    if (extraFieldInfoZip) {
      readExtraFieldUnix(extraFieldInfoZip, directory, true);
      directory.extraFieldInfoZip = extraFieldInfoZip;
    }
  }
  const extraFieldExtendedTimestamp = extraField.get(EXTRAFIELD_TYPE_EXTENDED_TIMESTAMP);
  if (extraFieldExtendedTimestamp) {
    readExtraFieldExtendedTimestamp(extraFieldExtendedTimestamp, directory, localDirectory);
    directory.extraFieldExtendedTimestamp = extraFieldExtendedTimestamp;
  }
  const extraFieldUSDZ = extraField.get(EXTRAFIELD_TYPE_USDZ);
  if (extraFieldUSDZ) {
    directory.extraFieldUSDZ = extraFieldUSDZ;
  }
}
function readExtraFieldZip64(extraFieldZip64, directory) {
  directory.zip64 = true;
  const extraFieldView = getDataView(extraFieldZip64.data);
  const missingProperties = ZIP64_PROPERTIES.filter(([propertyName, max2]) => directory[propertyName] == max2);
  const requiredLength = missingProperties.reduce((length, [, max2]) => length + ZIP64_EXTRACTION[max2].bytes, 0);
  if (extraFieldZip64.data.length < requiredLength) {
    throw new Error(ERR_EXTRAFIELD_ZIP64_NOT_FOUND);
  }
  for (let indexMissingProperty = 0, offset = 0; indexMissingProperty < missingProperties.length; indexMissingProperty++) {
    const [propertyName, max2] = missingProperties[indexMissingProperty];
    const extraction = ZIP64_EXTRACTION[max2];
    directory[propertyName] = extraFieldZip64[propertyName] = extraction.getValue(extraFieldView, offset);
    offset += extraction.bytes;
  }
}
function readExtraFieldUnicode(extraFieldUnicode, propertyName, rawPropertyName, directory, fileEntry) {
  if (extraFieldUnicode.data.length < 5) {
    extraFieldUnicode.valid = false;
    return;
  }
  const extraFieldView = getDataView(extraFieldUnicode.data);
  const crc32 = new Crc32();
  crc32.append(fileEntry[rawPropertyName]);
  const dataViewSignature = getDataView(new Uint8Array(4));
  dataViewSignature.setUint32(0, crc32.get(), true);
  const signature = getUint32(extraFieldView, 1);
  Object.assign(extraFieldUnicode, {
    version: getUint8(extraFieldView, 0),
    [propertyName]: decodeText(extraFieldUnicode.data.subarray(5)),
    valid: !fileEntry.bitFlag.languageEncodingFlag && signature == getUint32(dataViewSignature, 0)
  });
  if (extraFieldUnicode.valid) {
    directory[propertyName] = extraFieldUnicode[propertyName];
    directory[propertyName + PROPERTY_NAME_UTF8_SUFFIX] = true;
  }
}
function readExtraFieldAES(extraFieldAES, directory, compressionMethod) {
  const extraFieldView = getDataView(extraFieldAES.data);
  const strength = getUint8(extraFieldView, 4);
  Object.assign(extraFieldAES, {
    vendorVersion: getUint8(extraFieldView, 0),
    vendorId: getUint8(extraFieldView, 2),
    strength,
    originalCompressionMethod: compressionMethod,
    compressionMethod: getUint16(extraFieldView, 5)
  });
  directory.compressionMethod = extraFieldAES.compressionMethod;
}
function readExtraFieldNTFS(extraFieldNTFS, directory) {
  const extraFieldView = getDataView(extraFieldNTFS.data);
  let offsetExtraField = 4;
  let tag1Data;
  try {
    while (offsetExtraField < extraFieldNTFS.data.length && !tag1Data) {
      const tagValue = getUint16(extraFieldView, offsetExtraField);
      const attributeSize = getUint16(extraFieldView, offsetExtraField + 2);
      if (tagValue == EXTRAFIELD_TYPE_NTFS_TAG1) {
        tag1Data = extraFieldNTFS.data.slice(offsetExtraField + 4, offsetExtraField + 4 + attributeSize);
      }
      offsetExtraField += 4 + attributeSize;
    }
  } catch {
  }
  try {
    if (tag1Data && tag1Data.length == 24) {
      const tag1View = getDataView(tag1Data);
      const rawLastModDate = tag1View.getBigUint64(0, true);
      const rawLastAccessDate = tag1View.getBigUint64(8, true);
      const rawCreationDate = tag1View.getBigUint64(16, true);
      Object.assign(extraFieldNTFS, {
        rawLastModDate,
        rawLastAccessDate,
        rawCreationDate
      });
      const lastModDate = getDateNTFS(rawLastModDate);
      const lastAccessDate = getDateNTFS(rawLastAccessDate);
      const creationDate = getDateNTFS(rawCreationDate);
      const extraFieldData = { lastModDate, lastAccessDate, creationDate };
      Object.assign(extraFieldNTFS, extraFieldData);
      Object.assign(directory, extraFieldData);
    }
  } catch {
  }
}
function readExtraFieldUnix(extraField, directory, isInfoZip) {
  try {
    const view = getDataView(new Uint8Array(extraField.data));
    let uid, gid;
    if (isInfoZip) {
      let offset = 0;
      const version = getUint8(view, offset++);
      const uidSize = getUint8(view, offset++);
      uid = unpackUnixId(extraField.data.subarray(offset, offset + uidSize));
      offset += uidSize;
      const gidSize = getUint8(view, offset++);
      gid = unpackUnixId(extraField.data.subarray(offset, offset + gidSize));
      Object.assign(extraField, { version, uid, gid });
    } else if (extraField.data.length >= 4) {
      uid = getUint16(view, 0);
      gid = getUint16(view, 2);
      Object.assign(extraField, { uid, gid });
    }
    if (uid !== UNDEFINED_VALUE) {
      directory.uid = uid;
    }
    if (gid !== UNDEFINED_VALUE) {
      directory.gid = gid;
    }
  } catch {
  }
}
function unpackUnixId(bytes) {
  const buffer = new Uint8Array(4);
  buffer.set(bytes, 0);
  const view = new DataView(buffer.buffer, buffer.byteOffset, 4);
  return view.getUint32(0, true);
}
function readExtraFieldExtendedTimestamp(extraFieldExtendedTimestamp, directory, localDirectory) {
  if (!extraFieldExtendedTimestamp.data.length) {
    return;
  }
  const extraFieldView = getDataView(extraFieldExtendedTimestamp.data);
  const flags = getUint8(extraFieldView, 0);
  const timeProperties = [];
  const timeRawProperties = [];
  if (localDirectory) {
    if ((flags & 1) == 1) {
      timeProperties.push(PROPERTY_NAME_LAST_MODIFICATION_DATE);
      timeRawProperties.push(PROPERTY_NAME_RAW_LAST_MODIFICATION_DATE);
    }
    if ((flags & 2) == 2) {
      timeProperties.push(PROPERTY_NAME_LAST_ACCESS_DATE);
      timeRawProperties.push(PROPERTY_NAME_RAW_LAST_ACCESS_DATE);
    }
    if ((flags & 4) == 4) {
      timeProperties.push(PROPERTY_NAME_CREATION_DATE);
      timeRawProperties.push(PROPERTY_NAME_RAW_CREATION_DATE);
    }
  } else if (extraFieldExtendedTimestamp.data.length >= 5) {
    timeProperties.push(PROPERTY_NAME_LAST_MODIFICATION_DATE);
    timeRawProperties.push(PROPERTY_NAME_RAW_LAST_MODIFICATION_DATE);
  }
  let offset = 1;
  timeProperties.forEach((propertyName, indexProperty) => {
    if (extraFieldExtendedTimestamp.data.length >= offset + 4) {
      const time = getUint32(extraFieldView, offset);
      directory[propertyName] = extraFieldExtendedTimestamp[propertyName] = new Date((time | 0) * 1e3);
      const rawPropertyName = timeRawProperties[indexProperty];
      extraFieldExtendedTimestamp[rawPropertyName] = time;
    }
    offset += 4;
  });
}
async function detectOverlappingEntry({
  reader,
  fileEntry,
  index,
  offset,
  diskNumberStart,
  signature,
  compressedSize,
  uncompressedSize,
  dataOffset,
  dataDescriptor,
  extraFieldZip64,
  readRanges
}) {
  let diskOffset = 0;
  if (diskNumberStart && reader.readers) {
    for (let indexReader = 0; indexReader < Math.min(diskNumberStart, reader.readers.length); indexReader++) {
      diskOffset += reader.readers[indexReader].size;
    }
  }
  let dataDescriptorLength = 0;
  if (dataDescriptor) {
    if (extraFieldZip64) {
      dataDescriptorLength = DATA_DESCRIPTOR_RECORD_ZIP_64_LENGTH;
    } else {
      dataDescriptorLength = DATA_DESCRIPTOR_RECORD_LENGTH;
    }
  }
  if (dataDescriptorLength) {
    const dataDescriptorArray = await readUint8Array(reader, dataOffset + compressedSize, dataDescriptorLength + DATA_DESCRIPTOR_RECORD_SIGNATURE_LENGTH, diskNumberStart);
    const dataDescriptorSignature = dataDescriptorArray.length == dataDescriptorLength + DATA_DESCRIPTOR_RECORD_SIGNATURE_LENGTH && getUint32(getDataView(dataDescriptorArray), 0) == DATA_DESCRIPTOR_RECORD_SIGNATURE;
    if (dataDescriptorSignature) {
      const readSignature2 = getUint32(getDataView(dataDescriptorArray), 4);
      let readCompressedSize;
      let readUncompressedSize;
      if (extraFieldZip64) {
        readCompressedSize = getBigUint64(getDataView(dataDescriptorArray), 8);
        readUncompressedSize = getBigUint64(getDataView(dataDescriptorArray), 16);
      } else {
        readCompressedSize = getUint32(getDataView(dataDescriptorArray), 8);
        readUncompressedSize = getUint32(getDataView(dataDescriptorArray), 12);
      }
      const matchSignature = fileEntry.encrypted && !fileEntry.zipCrypto || readSignature2 == signature;
      if (matchSignature && readCompressedSize == compressedSize && readUncompressedSize == uncompressedSize) {
        dataDescriptorLength += DATA_DESCRIPTOR_RECORD_SIGNATURE_LENGTH;
      }
    }
  }
  const range = {
    start: diskOffset + offset,
    end: diskOffset + dataOffset + compressedSize + dataDescriptorLength,
    fileEntry
  };
  for (const [otherIndex, otherRange] of readRanges) {
    if (otherIndex != index && range.start < otherRange.end && otherRange.start < range.end) {
      const error = new Error(ERR_OVERLAPPING_ENTRY);
      error.overlappingEntry = otherRange.fileEntry;
      throw error;
    }
  }
  readRanges.set(index, range);
}
function getStrictness(strictness, checkAmbiguity) {
  if (strictness === UNDEFINED_VALUE) {
    return checkAmbiguity ? STRICTNESS_STRICT : STRICTNESS_BALANCED;
  }
  return strictness;
}
function getMaxAppendedDataSize(maxAppendedDataSize, strictness) {
  if (maxAppendedDataSize !== UNDEFINED_VALUE) {
    return maxAppendedDataSize;
  }
  if (strictness == STRICTNESS_STRICT) {
    return 0;
  }
  if (strictness == STRICTNESS_TOLERANT) {
    return Infinity;
  }
  return MAX_16_BITS;
}
var MAX_END_OF_CENTRAL_DIR_PROBES = 64;
var CENTRAL_DIRECTORY_UNREACHABLE = 0;
var CENTRAL_DIRECTORY_PLAUSIBLE = 1;
var CENTRAL_DIRECTORY_REACHABLE = 2;
async function findEndOfCentralDirectory(reader, rejectAmbiguous, maxAppendedDataSize) {
  const { size } = reader;
  const anchoredLength = Math.min(size, END_OF_CENTRAL_DIR_LENGTH + MAX_16_BITS);
  const remoteProbeBudget = { count: MAX_END_OF_CENTRAL_DIR_PROBES };
  let endOfDirectoryInfo;
  let plausibleEndOfDirectoryInfo;
  let endOfDirectoryReachingEndCount = 0;
  for await (const [anchoredView, anchoredOffset, anchoredArray, indexByte, offset] of scanEndOfCentralDirectory(reader, anchoredLength)) {
    const commentLength = getUint16(anchoredView, indexByte + 20);
    if (offset + END_OF_CENTRAL_DIR_LENGTH + commentLength == size) {
      const reachability = await getCentralDirectoryReachability(reader, anchoredView, anchoredOffset, indexByte, offset, size, remoteProbeBudget);
      if (reachability == CENTRAL_DIRECTORY_REACHABLE) {
        if (!endOfDirectoryInfo) {
          endOfDirectoryInfo = getEndOfCentralDirectoryInfo(anchoredArray, indexByte, offset);
        }
        endOfDirectoryReachingEndCount++;
        if (!rejectAmbiguous || endOfDirectoryReachingEndCount > 1) {
          break;
        }
      } else if (reachability == CENTRAL_DIRECTORY_PLAUSIBLE && !plausibleEndOfDirectoryInfo) {
        plausibleEndOfDirectoryInfo = getEndOfCentralDirectoryInfo(anchoredArray, indexByte, offset);
      }
    }
  }
  if (!endOfDirectoryInfo) {
    endOfDirectoryInfo = plausibleEndOfDirectoryInfo;
  }
  if (!endOfDirectoryInfo) {
    endOfDirectoryInfo = await seekEndOfCentralDirectory(reader, maxAppendedDataSize, remoteProbeBudget);
  }
  return { endOfDirectoryInfo, endOfDirectoryReachingEndCount };
}
async function seekEndOfCentralDirectory(reader, maxAppendedDataSize, remoteProbeBudget) {
  const { size } = reader;
  const searchLength = Math.min(size, maxAppendedDataSize == Infinity ? size : END_OF_CENTRAL_DIR_LENGTH + MAX_16_BITS + maxAppendedDataSize);
  let firstSignatureInfo, plausibleInfo;
  for await (const [searchView, searchOffset, searchArray, indexByte, offset] of scanEndOfCentralDirectory(reader, searchLength)) {
    const record = getEndOfCentralDirectoryInfo(searchArray, indexByte, offset);
    if (!firstSignatureInfo) {
      firstSignatureInfo = record;
    }
    const reachability = await getCentralDirectoryReachability(reader, searchView, searchOffset, indexByte, offset, size, remoteProbeBudget);
    if (reachability == CENTRAL_DIRECTORY_REACHABLE) {
      return record;
    }
    if (reachability == CENTRAL_DIRECTORY_PLAUSIBLE && !plausibleInfo) {
      plausibleInfo = record;
    }
  }
  return plausibleInfo || firstSignatureInfo;
}
async function* scanEndOfCentralDirectory(reader, scanLength) {
  const scanOffset = reader.size - scanLength;
  const scanArray = await readUint8Array(reader, scanOffset, scanLength);
  const scanView = getDataView(scanArray);
  for (let indexByte = scanArray.length - END_OF_CENTRAL_DIR_LENGTH; indexByte >= 0; indexByte--) {
    if (getUint32(scanView, indexByte) == END_OF_CENTRAL_DIR_SIGNATURE) {
      yield [scanView, scanOffset, scanArray, indexByte, scanOffset + indexByte];
    }
  }
}
function getEndOfCentralDirectoryInfo(scanArray, indexByte, offset) {
  return { offset, buffer: scanArray.slice(indexByte, indexByte + END_OF_CENTRAL_DIR_LENGTH).buffer };
}
async function getCentralDirectoryReachability(reader, view, anchoredOffset, indexByte, offset, size, remoteProbeBudget) {
  const filesLength = getUint16(view, indexByte + 10);
  const directoryDataLength = getUint32(view, indexByte + 12);
  const directoryDataOffset = getUint32(view, indexByte + 16);
  if (filesLength == MAX_16_BITS || directoryDataLength == MAX_32_BITS || directoryDataOffset == MAX_32_BITS) {
    const locatorSignature = await readSignature(reader, view, anchoredOffset, offset - ZIP64_END_OF_CENTRAL_DIR_LOCATOR_LENGTH, size, remoteProbeBudget);
    return locatorSignature == ZIP64_END_OF_CENTRAL_DIR_LOCATOR_SIGNATURE ? CENTRAL_DIRECTORY_REACHABLE : CENTRAL_DIRECTORY_UNREACHABLE;
  }
  if (!filesLength && !directoryDataLength) {
    return CENTRAL_DIRECTORY_PLAUSIBLE;
  }
  for (const centralDirectoryOffset of [offset - directoryDataLength, directoryDataOffset]) {
    if (await readSignature(reader, view, anchoredOffset, centralDirectoryOffset, size, remoteProbeBudget) == CENTRAL_FILE_HEADER_SIGNATURE) {
      return CENTRAL_DIRECTORY_REACHABLE;
    }
  }
  return CENTRAL_DIRECTORY_UNREACHABLE;
}
async function readSignature(reader, view, anchoredOffset, signatureOffset, size, remoteProbeBudget) {
  if (signatureOffset < 0 || signatureOffset + 4 > size) {
    return UNDEFINED_VALUE;
  }
  if (signatureOffset >= anchoredOffset) {
    return getUint32(view, signatureOffset - anchoredOffset);
  }
  if (remoteProbeBudget.count > 0) {
    remoteProbeBudget.count--;
    const signatureArray = await readUint8Array(reader, signatureOffset, 4);
    return getUint32(getDataView(signatureArray), 0);
  }
  return UNDEFINED_VALUE;
}
function checkLocalDirectory(zipEntry, localDirectory, rawLocalFilename) {
  const { rawFilename } = zipEntry;
  if (rawLocalFilename.length != rawFilename.length || rawLocalFilename.some((byteValue, indexByte) => byteValue != rawFilename[indexByte])) {
    throwAmbiguousArchive("mismatched local file header (filename)");
  }
  if ((localDirectory.rawBitFlag & BITFLAG_AMBIGUITY_MASK) != (zipEntry.rawBitFlag & BITFLAG_AMBIGUITY_MASK)) {
    throwAmbiguousArchive("mismatched local file header (general purpose bit flag)");
  }
  if (localDirectory.compressionMethod != zipEntry.compressionMethod) {
    throwAmbiguousArchive("mismatched local file header (compression method)");
  }
  if (!localDirectory.bitFlag.dataDescriptor && (localDirectory.signature || localDirectory.compressedSize || localDirectory.uncompressedSize) && (localDirectory.signature != zipEntry.signature || localDirectory.compressedSize != zipEntry.compressedSize || localDirectory.uncompressedSize != zipEntry.uncompressedSize)) {
    throwAmbiguousArchive("mismatched local file header (signature or sizes)");
  }
}
function throwAmbiguousArchive(reason) {
  const error = new Error(ERR_AMBIGUOUS_ARCHIVE);
  error.reason = reason;
  throw error;
}
function getOptionValue(zipReader, options, name) {
  return options[name] === UNDEFINED_VALUE ? zipReader.options[name] : options[name];
}
function getDate(timeRaw) {
  const date = (timeRaw & 4294901760) >> 16, time = timeRaw & MAX_16_BITS;
  try {
    return new Date(1980 + ((date & 65024) >> 9), ((date & 480) >> 5) - 1, date & 31, (time & 63488) >> 11, (time & 2016) >> 5, (time & 31) * 2, 0);
  } catch {
  }
}
function getDateNTFS(timeRaw) {
  return new Date(Number(timeRaw / BigInt(1e4) - BigInt(116444736e5)));
}
function getUint8(view, offset) {
  return view.getUint8(offset);
}
function getUint16(view, offset) {
  return view.getUint16(offset, true);
}
function getUint32(view, offset) {
  return view.getUint32(offset, true);
}
function getBigUint64(view, offset) {
  return Number(view.getBigUint64(offset, true));
}
function getDataView(array) {
  return new DataView(array.buffer, array.byteOffset, array.byteLength);
}

// node_modules/@zip.js/zip.js/lib/core/zip-writer.js
var ERR_DUPLICATED_NAME = "File already exists";
var ERR_INVALID_COMMENT = "Zip file comment exceeds 64KB";
var ERR_INVALID_ENTRY_COMMENT = "File entry comment exceeds 64KB";
var ERR_INVALID_ENTRY_NAME = "File entry name exceeds 64KB";
var ERR_INVALID_VERSION = "Version exceeds 65535";
var ERR_INVALID_ENCRYPTION_STRENGTH = "The strength must equal 1, 2, or 3";
var ERR_INVALID_EXTRAFIELD_TYPE = "Extra field type exceeds 65535";
var ERR_INVALID_EXTRAFIELD_DATA = "Extra field data exceeds 64KB";
var ERR_UNSUPPORTED_COMPRESSION2 = "Compression method not supported";
var MIN_UNIX_TIME = -2147483648;
var MAX_UNIX_TIME = 2147483647;
var ERR_UNSUPPORTED_FORMAT = "Zip64 is not supported (set the 'zip64' option to 'true')";
var ERR_UNDEFINED_UNCOMPRESSED_SIZE = "Undefined uncompressed size";
var ERR_UNDEFINED_READER = "Undefined reader";
var ERR_ZIP_NOT_EMPTY = "Zip file not empty";
var ERR_INVALID_UID = "Invalid uid (must be integer 0..2^32-1)";
var ERR_INVALID_GID = "Invalid gid (must be integer 0..2^32-1)";
var ERR_INVALID_UNIX_MODE = "Invalid UNIX mode (must be integer 0..65535)";
var ERR_INVALID_UNIX_EXTRA_FIELD_TYPE = "Invalid unixExtraFieldType (must be 'infozip' or 'unix')";
var ERR_INVALID_UNIX_ID_SIZE = "uid/gid must be 0..65535 for unixExtraFieldType 'unix' (use 'infozip' for larger ids)";
var ERR_INVALID_MSDOS_ATTRIBUTES = "Invalid msdosAttributesRaw (must be integer 0..255)";
var ERR_INVALID_MSDOS_DATA = "Invalid msdosAttributes (must be an object with boolean flags)";
var EXTRAFIELD_DATA_AES = new Uint8Array([7, 0, 2, 0, 65, 69, 3, 0, 0]);
var INFOZIP_EXTRA_FIELD_TYPE = "infozip";
var UNIX_EXTRA_FIELD_TYPE = "unix";
var workers = 0;
var pendingEntries = [];
var ZipWriter = class {
  constructor(writer, options = {}) {
    writer = new GenericWriter(writer);
    const addSplitZipSignature = writer.availableSize !== UNDEFINED_VALUE && writer.availableSize > 0 && writer.availableSize !== INFINITY_VALUE && writer.maxSize !== UNDEFINED_VALUE && writer.maxSize > 0 && writer.maxSize !== INFINITY_VALUE;
    Object.assign(this, {
      writer,
      addSplitZipSignature,
      options,
      config: getConfiguration(),
      files: /* @__PURE__ */ new Map(),
      filenames: /* @__PURE__ */ new Set(),
      offset: options[OPTION_OFFSET] === UNDEFINED_VALUE ? writer.size || writer.writable.size || 0 : options[OPTION_OFFSET],
      initialOffset: options[OPTION_OFFSET] === UNDEFINED_VALUE ? 0 : options[OPTION_OFFSET] - (writer.size || writer.writable.size || 0),
      pendingAddFileCalls: /* @__PURE__ */ new Set(),
      bufferedWrites: 0,
      lastFileEntry: UNDEFINED_VALUE
    });
  }
  async prependZip(reader) {
    if (this.filenames.size) {
      throw new Error(ERR_ZIP_NOT_EMPTY);
    }
    reader = new GenericReader(reader);
    await initStream(reader);
    const zipReader = new ZipReader(reader.readable);
    const entries = await zipReader.getEntries();
    await zipReader.close();
    await initStream(this.writer);
    await reader.readable.pipeTo(this.writer.writable, { preventClose: true, preventAbort: true });
    this.writer.size = this.offset = reader.size;
    this.filenames = new Set(entries.map((entry) => entry.filename));
    this.files = new Map(entries.map((entry) => {
      const {
        version,
        rawLastModDate,
        lastAccessDate,
        creationDate,
        rawFilename,
        bitFlag,
        encrypted,
        uncompressedSize,
        compressedSize,
        diskOffset,
        diskNumber,
        zip64
      } = entry;
      let {
        compressionMethod,
        rawExtraFieldZip64,
        rawExtraFieldAES,
        rawExtraFieldExtendedTimestamp,
        rawExtraFieldNTFS,
        rawExtraFieldUnix,
        rawExtraField
      } = entry;
      const { level, languageEncodingFlag, dataDescriptor } = bitFlag;
      rawExtraFieldZip64 = rawExtraFieldZip64 || EMPTY_UINT8_ARRAY;
      rawExtraFieldAES = rawExtraFieldAES || EMPTY_UINT8_ARRAY;
      rawExtraFieldExtendedTimestamp = rawExtraFieldExtendedTimestamp || EMPTY_UINT8_ARRAY;
      rawExtraFieldNTFS = rawExtraFieldNTFS || EMPTY_UINT8_ARRAY;
      rawExtraFieldUnix = rawExtraFieldUnix || EMPTY_UINT8_ARRAY;
      rawExtraField = rawExtraField || EMPTY_UINT8_ARRAY;
      if (entry.extraFieldAES) {
        compressionMethod = COMPRESSION_METHOD_AES;
      }
      const extraFieldLength = getLength(rawExtraFieldZip64, rawExtraFieldAES, rawExtraFieldExtendedTimestamp, rawExtraFieldNTFS, rawExtraFieldUnix, rawExtraField);
      const zip64UncompressedSize = zip64 && uncompressedSize >= MAX_32_BITS;
      const zip64CompressedSize = zip64 && compressedSize >= MAX_32_BITS;
      const bitFlagValue = getBitFlag(level, languageEncodingFlag, dataDescriptor, encrypted, compressionMethod) & ~BITFLAG_LEVEL | level << 1;
      const {
        headerArray,
        headerView
      } = getHeaderArrayData({
        version,
        bitFlag: bitFlagValue,
        compressionMethod,
        uncompressedSize,
        compressedSize,
        rawLastModDate,
        rawFilename,
        zip64CompressedSize,
        zip64UncompressedSize,
        extraFieldLength
      });
      const { signature } = entry;
      if (signature !== UNDEFINED_VALUE) {
        setUint32(headerView, HEADER_OFFSET_SIGNATURE, signature);
      }
      Object.assign(entry, {
        zip64UncompressedSize,
        zip64CompressedSize,
        zip64Offset: zip64 && this.offset - diskOffset >= MAX_32_BITS,
        zip64DiskNumberStart: zip64 && diskNumber >= MAX_16_BITS,
        rawExtraFieldZip64,
        rawExtraFieldAES,
        rawExtraFieldExtendedTimestamp,
        rawExtraFieldNTFS,
        rawExtraFieldUnix,
        rawExtraField,
        extendedTimestamp: rawExtraFieldExtendedTimestamp.length > 0 || rawExtraFieldNTFS.length > 0,
        extraFieldExtendedTimestampFlag: 1 + (lastAccessDate ? 2 : 0) + (creationDate ? 4 : 0),
        headerArray,
        headerView
      });
      return [entry.filename, entry];
    }));
  }
  async add(name = "", reader, options = {}) {
    const zipWriter = this;
    options = Object.assign({}, options);
    const {
      pendingAddFileCalls,
      config: config2
    } = zipWriter;
    if (workers < config2.maxWorkers) {
      workers++;
    } else {
      await new Promise((resolve) => pendingEntries.push(resolve));
    }
    let promiseAddFile;
    let nameAdded;
    try {
      name = name.trim();
      if (getOptionValue2(zipWriter, options, PROPERTY_NAME_DIRECTORY) && !name.endsWith(DIRECTORY_SIGNATURE)) {
        name += DIRECTORY_SIGNATURE;
      }
      if (zipWriter.filenames.has(name)) {
        throw new Error(ERR_DUPLICATED_NAME);
      }
      zipWriter.filenames.add(name);
      nameAdded = true;
      promiseAddFile = addFile(zipWriter, name, reader, options);
      pendingAddFileCalls.add(promiseAddFile);
      return await promiseAddFile;
    } catch (error) {
      if (nameAdded) {
        zipWriter.filenames.delete(name);
      }
      throw error;
    } finally {
      pendingAddFileCalls.delete(promiseAddFile);
      const pendingEntry = pendingEntries.shift();
      if (pendingEntry) {
        pendingEntry();
      } else {
        workers--;
      }
    }
  }
  remove(entry) {
    const { filenames, files } = this;
    if (typeof entry == "string") {
      entry = files.get(entry);
    }
    if (entry && entry.filename !== UNDEFINED_VALUE) {
      const { filename } = entry;
      if (filenames.has(filename) && files.has(filename)) {
        filenames.delete(filename);
        files.delete(filename);
        return true;
      }
    }
    return false;
  }
  async close(comment = EMPTY_UINT8_ARRAY, options = {}) {
    const zipWriter = this;
    const { pendingAddFileCalls, writer } = this;
    const { writable } = writer;
    if (getLength(comment) > MAX_16_BITS) {
      throw new Error(ERR_INVALID_COMMENT);
    }
    while (pendingAddFileCalls.size) {
      await Promise.allSettled(Array.from(pendingAddFileCalls));
    }
    await closeFile(zipWriter, comment, options);
    const preventClose = getOptionValue2(zipWriter, options, OPTION_PREVENT_CLOSE);
    if (!preventClose) {
      await writable.getWriter().close();
    }
    return writer.getData ? writer.getData() : writable;
  }
};
async function addFile(zipWriter, name, reader, options) {
  const attributesInfo = resolveAttributes(zipWriter, name, options);
  ({ name } = attributesInfo);
  const metadataInfo = resolveMetadata(zipWriter, name, options);
  const { comment } = metadataInfo;
  const extraField = options[PROPERTY_NAME_EXTRA_FIELD];
  zipWriter.files.set(name, UNDEFINED_VALUE);
  let fileEntry;
  try {
    const sizesInfo = await resolveSizes(zipWriter, reader, metadataInfo, options);
    ({ reader } = sizesInfo);
    const { diskOffset, diskNumber } = zipWriter.writer;
    options = Object.assign({}, options, attributesInfo.resolvedOptions, metadataInfo.resolvedOptions, sizesInfo.resolvedOptions, {
      internalFileAttribute: metadataInfo.resolvedOptions.internalFileAttributes,
      externalFileAttribute: attributesInfo.resolvedOptions.externalFileAttributes,
      signature: options[PROPERTY_NAME_SIGNATURE],
      offset: zipWriter.offset - diskOffset,
      diskNumberStart: diskNumber
    });
    const headerInfo = getHeaderInfo(options);
    const dataDescriptorInfo = getDataDescriptorInfo(options);
    const metadataSize = getLength(headerInfo.localHeaderArray, dataDescriptorInfo.dataDescriptorArray);
    fileEntry = await getFileEntry(zipWriter, name, reader, { headerInfo, dataDescriptorInfo, metadataSize }, options);
  } catch (error) {
    zipWriter.files.delete(name);
    throw error;
  }
  Object.assign(fileEntry, { name, comment, extraField });
  return new Entry(fileEntry);
}
function resolveAttributes(zipWriter, name, options) {
  name = name.trim();
  let msDosCompatible = getOptionValue2(zipWriter, options, PROPERTY_NAME_MS_DOS_COMPATIBLE);
  let versionMadeBy = getOptionValue2(zipWriter, options, PROPERTY_NAME_VERSION_MADE_BY, msDosCompatible ? 20 : 768);
  const executable = getOptionValue2(zipWriter, options, PROPERTY_NAME_EXECUTABLE);
  const uid = getOptionValue2(zipWriter, options, PROPERTY_NAME_UID);
  const gid = getOptionValue2(zipWriter, options, PROPERTY_NAME_GID);
  let unixMode = getOptionValue2(zipWriter, options, PROPERTY_NAME_UNIX_MODE);
  let unixExtraFieldType = getOptionValue2(zipWriter, options, OPTION_UNIX_EXTRA_FIELD_TYPE);
  let setuid = getOptionValue2(zipWriter, options, PROPERTY_NAME_SETUID);
  let setgid = getOptionValue2(zipWriter, options, PROPERTY_NAME_SETGID);
  let sticky = getOptionValue2(zipWriter, options, PROPERTY_NAME_STICKY);
  if (uid !== UNDEFINED_VALUE && (uid < 0 || uid > MAX_32_BITS)) {
    throw new Error(ERR_INVALID_UID);
  }
  if (gid !== UNDEFINED_VALUE && (gid < 0 || gid > MAX_32_BITS)) {
    throw new Error(ERR_INVALID_GID);
  }
  if (unixMode !== UNDEFINED_VALUE && (unixMode < 0 || unixMode > MAX_16_BITS)) {
    throw new Error(ERR_INVALID_UNIX_MODE);
  }
  if (unixExtraFieldType !== UNDEFINED_VALUE && unixExtraFieldType !== INFOZIP_EXTRA_FIELD_TYPE && unixExtraFieldType !== UNIX_EXTRA_FIELD_TYPE) {
    throw new Error(ERR_INVALID_UNIX_EXTRA_FIELD_TYPE);
  }
  if (unixExtraFieldType === UNIX_EXTRA_FIELD_TYPE && (uid !== UNDEFINED_VALUE && uid > MAX_16_BITS || gid !== UNDEFINED_VALUE && gid > MAX_16_BITS)) {
    throw new Error(ERR_INVALID_UNIX_ID_SIZE);
  }
  if (unixExtraFieldType === UNDEFINED_VALUE && (uid !== UNDEFINED_VALUE || gid !== UNDEFINED_VALUE)) {
    unixExtraFieldType = INFOZIP_EXTRA_FIELD_TYPE;
  }
  let msdosAttributesRaw = getOptionValue2(zipWriter, options, PROPERTY_NAME_MSDOS_ATTRIBUTES_RAW);
  let msdosAttributes = getOptionValue2(zipWriter, options, PROPERTY_NAME_MSDOS_ATTRIBUTES);
  const hasUnixMetadata = uid !== UNDEFINED_VALUE || gid !== UNDEFINED_VALUE || unixMode !== UNDEFINED_VALUE || unixExtraFieldType;
  const hasMsDosProvided = msdosAttributesRaw !== UNDEFINED_VALUE || msdosAttributes !== UNDEFINED_VALUE;
  if (hasUnixMetadata) {
    msDosCompatible = false;
    versionMadeBy = versionMadeBy & MAX_16_BITS | 3 << 8;
  } else if (hasMsDosProvided) {
    msDosCompatible = true;
    versionMadeBy = versionMadeBy & MAX_8_BITS;
  }
  if (msdosAttributesRaw !== UNDEFINED_VALUE && (msdosAttributesRaw < 0 || msdosAttributesRaw > MAX_8_BITS)) {
    throw new Error(ERR_INVALID_MSDOS_ATTRIBUTES);
  }
  if (msdosAttributes && typeof msdosAttributes !== OBJECT_TYPE) {
    throw new Error(ERR_INVALID_MSDOS_DATA);
  }
  if (versionMadeBy > MAX_16_BITS) {
    throw new Error(ERR_INVALID_VERSION);
  }
  let externalFileAttributes = getOptionValue2(zipWriter, options, PROPERTY_NAME_EXTERNAL_FILE_ATTRIBUTES, 0);
  if (!options[PROPERTY_NAME_DIRECTORY] && name.endsWith(DIRECTORY_SIGNATURE)) {
    options[PROPERTY_NAME_DIRECTORY] = true;
  }
  const directory = getOptionValue2(zipWriter, options, PROPERTY_NAME_DIRECTORY);
  if (directory) {
    if (!name.endsWith(DIRECTORY_SIGNATURE)) {
      name += DIRECTORY_SIGNATURE;
    }
    if (externalFileAttributes === 0) {
      externalFileAttributes = FILE_ATTR_MSDOS_DIR_MASK;
      if (!msDosCompatible) {
        externalFileAttributes |= (FILE_ATTR_UNIX_TYPE_DIR | FILE_ATTR_UNIX_EXECUTABLE_MASK | FILE_ATTR_UNIX_DEFAULT_MASK) << 16;
      }
    }
  } else if (!msDosCompatible && externalFileAttributes === 0) {
    if (executable) {
      externalFileAttributes = (FILE_ATTR_UNIX_EXECUTABLE_MASK | FILE_ATTR_UNIX_DEFAULT_MASK) << 16;
    } else {
      externalFileAttributes = FILE_ATTR_UNIX_DEFAULT_MASK << 16;
    }
  }
  let unixExternalUpper;
  if (!msDosCompatible) {
    unixExternalUpper = externalFileAttributes >> 16 & MAX_16_BITS;
    unixMode = unixMode === UNDEFINED_VALUE ? unixExternalUpper : unixMode & MAX_16_BITS;
    if (setuid) {
      unixMode |= FILE_ATTR_UNIX_SETUID_MASK;
    } else {
      setuid = Boolean(unixMode & FILE_ATTR_UNIX_SETUID_MASK);
    }
    if (setgid) {
      unixMode |= FILE_ATTR_UNIX_SETGID_MASK;
    } else {
      setgid = Boolean(unixMode & FILE_ATTR_UNIX_SETGID_MASK);
    }
    if (sticky) {
      unixMode |= FILE_ATTR_UNIX_STICKY_MASK;
    } else {
      sticky = Boolean(unixMode & FILE_ATTR_UNIX_STICKY_MASK);
    }
    if (directory) {
      unixMode |= FILE_ATTR_UNIX_TYPE_DIR;
    }
    externalFileAttributes = (unixMode & MAX_16_BITS) << 16 | externalFileAttributes & MAX_8_BITS;
  }
  ({ msdosAttributesRaw, msdosAttributes } = normalizeMsdosAttributes(msdosAttributesRaw, msdosAttributes));
  if (hasMsDosProvided) {
    externalFileAttributes = externalFileAttributes & MAX_32_BITS | msdosAttributesRaw & MAX_8_BITS;
  }
  return {
    name,
    resolvedOptions: {
      versionMadeBy,
      msDosCompatible,
      externalFileAttributes,
      unixExternalUpper,
      uid,
      gid,
      unixMode,
      unixExtraFieldType,
      setuid,
      setgid,
      sticky,
      msdosAttributesRaw,
      msdosAttributes
    }
  };
}
function resolveMetadata(zipWriter, name, options) {
  const encode = getOptionValue2(zipWriter, options, OPTION_ENCODE_TEXT, encodeText);
  let rawFilename = encode(name);
  if (rawFilename === UNDEFINED_VALUE) {
    rawFilename = encodeText(name);
  }
  if (getLength(rawFilename) > MAX_16_BITS) {
    throw new Error(ERR_INVALID_ENTRY_NAME);
  }
  const comment = options[PROPERTY_NAME_COMMENT] || "";
  let rawComment = encode(comment);
  if (rawComment === UNDEFINED_VALUE) {
    rawComment = encodeText(comment);
  }
  if (getLength(rawComment) > MAX_16_BITS) {
    throw new Error(ERR_INVALID_ENTRY_COMMENT);
  }
  const version = getOptionValue2(zipWriter, options, PROPERTY_NAME_VERSION, VERSION_DEFLATE);
  if (version > MAX_16_BITS) {
    throw new Error(ERR_INVALID_VERSION);
  }
  const lastModDate = getOptionValue2(zipWriter, options, PROPERTY_NAME_LAST_MODIFICATION_DATE, /* @__PURE__ */ new Date());
  const lastAccessDate = getOptionValue2(zipWriter, options, PROPERTY_NAME_LAST_ACCESS_DATE);
  const creationDate = getOptionValue2(zipWriter, options, PROPERTY_NAME_CREATION_DATE);
  const internalFileAttributes = getOptionValue2(zipWriter, options, PROPERTY_NAME_INTERNAL_FILE_ATTRIBUTES, 0);
  const passThrough = getOptionValue2(zipWriter, options, OPTION_PASS_THROUGH);
  let password, rawPassword;
  if (!passThrough) {
    password = getOptionValue2(zipWriter, options, OPTION_PASSWORD);
    rawPassword = getOptionValue2(zipWriter, options, OPTION_RAW_PASSWORD);
  }
  const encryptionStrength = getOptionValue2(zipWriter, options, OPTION_ENCRYPTION_STRENGTH, 3);
  const zipCrypto = getOptionValue2(zipWriter, options, PROPERTY_NAME_ZIPCRYPTO);
  const extendedTimestamp = getOptionValue2(zipWriter, options, OPTION_EXTENDED_TIMESTAMP, true);
  const keepOrder = getOptionValue2(zipWriter, options, OPTION_KEEP_ORDER, true);
  const useWebWorkers = getOptionValue2(zipWriter, options, OPTION_USE_WEB_WORKERS);
  const transferStreams = getOptionValue2(zipWriter, options, OPTION_TRANSFER_STREAMS, true);
  const bufferedWrite = getOptionValue2(zipWriter, options, OPTION_BUFFERED_WRITE);
  const createTempStream = getOptionValue2(zipWriter, options, OPTION_CREATE_TEMP_STREAM);
  const dataDescriptorSignature = getOptionValue2(zipWriter, options, OPTION_DATA_DESCRIPTOR_SIGNATURE, true);
  const signal = getOptionValue2(zipWriter, options, OPTION_SIGNAL);
  const useUnicodeFileNames = getOptionValue2(zipWriter, options, OPTION_USE_UNICODE_FILE_NAMES, true);
  const compressionMethod = getOptionValue2(zipWriter, options, PROPERTY_NAME_COMPRESSION_METHOD);
  if (!passThrough && compressionMethod !== UNDEFINED_VALUE && compressionMethod !== COMPRESSION_METHOD_STORE && compressionMethod !== COMPRESSION_METHOD_DEFLATE) {
    throw new Error(ERR_UNSUPPORTED_COMPRESSION2);
  }
  let level = getOptionValue2(zipWriter, options, OPTION_LEVEL);
  let useCompressionStream = getOptionValue2(zipWriter, options, OPTION_USE_COMPRESSION_STREAM);
  let dataDescriptor = getOptionValue2(zipWriter, options, OPTION_DATA_DESCRIPTOR);
  if (bufferedWrite && dataDescriptor === UNDEFINED_VALUE) {
    dataDescriptor = false;
  }
  if (dataDescriptor === UNDEFINED_VALUE || zipCrypto) {
    dataDescriptor = true;
  }
  if (level !== UNDEFINED_VALUE && level != 6) {
    useCompressionStream = false;
  }
  if (!useCompressionStream && (zipWriter.config.CompressionStream === UNDEFINED_VALUE && zipWriter.config.CompressionStreamZlib === UNDEFINED_VALUE)) {
    level = 0;
  }
  const zip64 = getOptionValue2(zipWriter, options, PROPERTY_NAME_ZIP64);
  if (!zipCrypto && (password !== UNDEFINED_VALUE || rawPassword !== UNDEFINED_VALUE) && !(encryptionStrength >= 1 && encryptionStrength <= 3)) {
    throw new Error(ERR_INVALID_ENCRYPTION_STRENGTH);
  }
  let rawExtraField = EMPTY_UINT8_ARRAY;
  const extraField = options[PROPERTY_NAME_EXTRA_FIELD];
  if (extraField) {
    let extraFieldSize = 0;
    let offset = 0;
    extraField.forEach((data) => extraFieldSize += 4 + getLength(data));
    rawExtraField = new Uint8Array(extraFieldSize);
    const rawExtraFieldView = getDataView2(rawExtraField);
    extraField.forEach((data, type) => {
      if (type > MAX_16_BITS) {
        throw new Error(ERR_INVALID_EXTRAFIELD_TYPE);
      }
      if (getLength(data) > MAX_16_BITS) {
        throw new Error(ERR_INVALID_EXTRAFIELD_DATA);
      }
      setUint16(rawExtraFieldView, offset, type);
      setUint16(rawExtraFieldView, offset + 2, getLength(data));
      arraySet(rawExtraField, data, offset + 4);
      offset += 4 + getLength(data);
    });
  }
  return {
    comment,
    resolvedOptions: {
      rawFilename,
      rawComment,
      version,
      lastModDate,
      lastAccessDate,
      creationDate,
      internalFileAttributes,
      passThrough,
      password,
      rawPassword,
      encryptionStrength,
      zipCrypto,
      extendedTimestamp,
      keepOrder,
      useWebWorkers,
      transferStreams,
      bufferedWrite,
      createTempStream,
      dataDescriptorSignature,
      signal,
      useUnicodeFileNames,
      compressionMethod,
      level,
      useCompressionStream,
      dataDescriptor,
      zip64,
      rawExtraField
    }
  };
}
async function resolveSizes(zipWriter, reader, { resolvedOptions: metadata }, options) {
  const { passThrough, zipCrypto, password, rawPassword, encryptionStrength } = metadata;
  let { dataDescriptor, zip64, level, compressionMethod } = metadata;
  let maximumCompressedSize = 0;
  let uncompressedSize = 0;
  if (passThrough) {
    if (!reader) {
      throw new Error(ERR_UNDEFINED_READER);
    }
    uncompressedSize = options[PROPERTY_NAME_UNCOMPRESSED_SIZE];
    if (uncompressedSize === UNDEFINED_VALUE) {
      throw new Error(ERR_UNDEFINED_UNCOMPRESSED_SIZE);
    }
  }
  const zip64Enabled = zip64 === true;
  const encrypted = getOptionValue2(zipWriter, options, PROPERTY_NAME_ENCRYPTED);
  const encryptedEntry = Boolean(reader) && (Boolean(password && getLength(password) || rawPassword && getLength(rawPassword)) || passThrough && encrypted);
  if (!reader) {
    level = 0;
    compressionMethod = COMPRESSION_METHOD_STORE;
  }
  const encryptionOverhead = encryptedEntry ? zipCrypto ? 12 : 16 + encryptionStrength * 4 : 0;
  if (reader) {
    reader = new GenericReader(reader);
    await initStream(reader);
    if (!passThrough) {
      if (reader.size === UNDEFINED_VALUE) {
        dataDescriptor = true;
        if (zip64 || zip64 === UNDEFINED_VALUE) {
          zip64 = true;
          uncompressedSize = maximumCompressedSize = MAX_32_BITS + 1;
        }
      } else {
        options.uncompressedSize = uncompressedSize = reader.size;
        maximumCompressedSize = getMaximumCompressedSize(uncompressedSize) + encryptionOverhead;
      }
    } else {
      options.uncompressedSize = uncompressedSize;
      maximumCompressedSize = getMaximumCompressedSize(uncompressedSize) + encryptionOverhead;
    }
  }
  const zip64UncompressedSize = zip64Enabled || uncompressedSize >= MAX_32_BITS;
  const zip64CompressedSize = zip64Enabled || maximumCompressedSize >= MAX_32_BITS;
  if (zip64UncompressedSize || zip64CompressedSize) {
    if (zip64 === false) {
      throw new Error(ERR_UNSUPPORTED_FORMAT);
    } else {
      zip64 = true;
    }
  }
  zip64 = zip64 || false;
  return {
    reader,
    resolvedOptions: {
      dataDescriptor,
      zip64,
      zip64UncompressedSize,
      zip64CompressedSize,
      uncompressedSize,
      level,
      compressionMethod,
      encrypted: encryptedEntry
    }
  };
}
async function getFileEntry(zipWriter, name, reader, entryInfo, options) {
  const {
    files,
    writer
  } = zipWriter;
  const {
    keepOrder,
    dataDescriptor,
    signal
  } = options;
  const {
    headerInfo
  } = entryInfo;
  const usdz = zipWriter.options[OPTION_USDZ];
  const previousFileEntry = zipWriter.lastFileEntry;
  let fileEntry = {};
  let bufferedWrite;
  let releaseLockWriter;
  let releaseLockCurrentFileEntry;
  let writingBufferedEntryData;
  let writingEntryData;
  let writerSizeBeforeEntry;
  let flushedBufferedSize = 0;
  let fileWriter;
  files.set(name, fileEntry);
  zipWriter.lastFileEntry = fileEntry;
  try {
    let lockPreviousFileEntry;
    if (keepOrder) {
      lockPreviousFileEntry = previousFileEntry && previousFileEntry.lock;
      requestLockCurrentFileEntry();
    }
    if (options.bufferedWrite || !keepOrder || zipWriter.writerLocked || zipWriter.bufferedWrites || !dataDescriptor) {
      bufferedWrite = true;
      zipWriter.bufferedWrites++;
      if (options.createTempStream) {
        fileWriter = await options.createTempStream();
      } else {
        fileWriter = new TransformStream(UNDEFINED_VALUE, UNDEFINED_VALUE, { highWaterMark: INFINITY_VALUE });
      }
      fileWriter.size = 0;
      await initStream(writer);
    } else {
      fileWriter = writer;
      await requestLockWriter();
    }
    await initStream(fileWriter);
    const { diskOffset } = writer;
    if (zipWriter.addSplitZipSignature) {
      delete zipWriter.addSplitZipSignature;
      const signatureArray = new Uint8Array(4);
      const signatureArrayView = getDataView2(signatureArray);
      setUint32(signatureArrayView, 0, SPLIT_ZIP_FILE_SIGNATURE);
      await writeData(writer, signatureArray);
      zipWriter.offset += 4;
    }
    if (usdz && !bufferedWrite) {
      appendExtraFieldUSDZ(entryInfo, zipWriter.offset - diskOffset);
    }
    const { localHeaderArray } = headerInfo;
    if (!bufferedWrite) {
      await lockPreviousFileEntry;
      await skipDiskIfNeeded();
    }
    const diskNumberStart = writer.diskNumber;
    const entryOffset = getSegmentOffset(zipWriter, writer);
    fileEntry.diskNumberStart = diskNumberStart;
    if (!bufferedWrite) {
      writingEntryData = true;
      writerSizeBeforeEntry = writer.size;
      await writeData(fileWriter, localHeaderArray);
    }
    fileEntry = await createFileEntry(reader, fileWriter, fileEntry, entryInfo, zipWriter.config, options);
    if (!bufferedWrite) {
      writingEntryData = false;
    }
    files.set(name, fileEntry);
    fileEntry.filename = name;
    if (bufferedWrite) {
      await Promise.all([fileWriter.writable.getWriter().close(), lockPreviousFileEntry]);
      await requestLockWriter();
      writingBufferedEntryData = true;
      writerSizeBeforeEntry = writer.size;
      await skipDiskIfNeeded();
      fileEntry.diskNumberStart = writer.diskNumber;
      fileEntry.offset = getSegmentOffset(zipWriter, writer);
      if (usdz) {
        const previousMetadataSize = entryInfo.metadataSize;
        appendExtraFieldUSDZ(entryInfo, zipWriter.offset - writer.diskOffset);
        fileEntry.size += entryInfo.metadataSize - previousMetadataSize;
      }
      updateLocalHeader(fileEntry, headerInfo.localHeaderView, options);
      await writeData(writer, headerInfo.localHeaderArray);
      await flushBufferedData(fileWriter.readable, writer, signal, (chunkLength) => flushedBufferedSize += chunkLength);
      writer.size += fileWriter.size;
      writingBufferedEntryData = false;
    } else {
      fileEntry.diskNumberStart = diskNumberStart;
      fileEntry.offset = entryOffset;
    }
    zipWriter.offset += fileEntry.size;
    return fileEntry;
  } catch (error) {
    if (writingBufferedEntryData || writingEntryData) {
      zipWriter.hasCorruptedEntries = true;
      if (error) {
        try {
          error.corruptedEntry = true;
        } catch {
        }
      }
      zipWriter.offset += writer.size - writerSizeBeforeEntry;
      if (bufferedWrite) {
        zipWriter.offset += flushedBufferedSize;
      }
    }
    files.delete(name);
    throw error;
  } finally {
    if (bufferedWrite) {
      zipWriter.bufferedWrites--;
    }
    if (releaseLockCurrentFileEntry) {
      releaseLockCurrentFileEntry();
    }
    if (releaseLockWriter) {
      releaseLockWriter();
    }
    if (bufferedWrite && fileWriter && fileWriter.dispose) {
      try {
        await fileWriter.dispose();
      } catch {
      }
    }
  }
  function requestLockCurrentFileEntry() {
    fileEntry.lock = new Promise((resolve) => releaseLockCurrentFileEntry = resolve);
  }
  async function requestLockWriter() {
    zipWriter.writerLocked = true;
    const { lockWriter } = zipWriter;
    zipWriter.lockWriter = new Promise((resolve) => releaseLockWriter = () => {
      zipWriter.writerLocked = false;
      resolve();
    });
    await lockWriter;
  }
  async function skipDiskIfNeeded() {
    if (getLength(headerInfo.localHeaderArray) > writer.availableSize) {
      writer.availableSize = 0;
      await writeData(writer, EMPTY_UINT8_ARRAY);
    }
  }
}
async function createFileEntry(reader, writer, { diskNumberStart, lock }, entryInfo, config2, options) {
  const {
    headerInfo,
    dataDescriptorInfo,
    metadataSize
  } = entryInfo;
  const {
    headerArray,
    headerView,
    lastModDate,
    rawLastModDate,
    encrypted,
    compressed,
    version,
    compressionMethod,
    rawExtraFieldZip64,
    localExtraFieldZip64Length,
    rawExtraFieldExtendedTimestamp,
    extraFieldExtendedTimestampFlag,
    rawExtraFieldNTFS,
    rawExtraFieldUnix,
    rawExtraFieldAES
  } = headerInfo;
  const { dataDescriptorArray } = dataDescriptorInfo;
  const {
    rawFilename,
    lastAccessDate,
    creationDate,
    password,
    rawPassword,
    level,
    zip64,
    zip64UncompressedSize,
    zip64CompressedSize,
    zipCrypto,
    dataDescriptor,
    directory,
    executable,
    versionMadeBy,
    rawComment,
    rawExtraField,
    useWebWorkers,
    transferStreams,
    onstart,
    onprogress,
    onend,
    signal,
    encryptionStrength,
    extendedTimestamp,
    msDosCompatible,
    internalFileAttributes,
    externalFileAttributes,
    uid,
    gid,
    unixMode,
    setuid,
    setgid,
    sticky,
    unixExternalUpper,
    msdosAttributesRaw,
    msdosAttributes,
    useCompressionStream,
    passThrough
  } = options;
  const fileEntry = {
    lock,
    versionMadeBy,
    zip64,
    directory: Boolean(directory),
    executable: Boolean(executable),
    filenameUTF8: true,
    rawFilename,
    commentUTF8: true,
    rawComment,
    rawExtraFieldZip64,
    localExtraFieldZip64Length,
    rawExtraFieldExtendedTimestamp,
    rawExtraFieldNTFS,
    rawExtraFieldUnix,
    rawExtraFieldAES,
    rawExtraField,
    extendedTimestamp,
    msDosCompatible,
    internalFileAttributes,
    externalFileAttributes,
    diskNumberStart,
    uid,
    gid,
    unixMode,
    setuid,
    setgid,
    sticky,
    unixExternalUpper,
    msdosAttributesRaw,
    msdosAttributes
  };
  let {
    signature,
    uncompressedSize
  } = options;
  let compressedSize = 0;
  if (!passThrough) {
    uncompressedSize = 0;
  }
  const { writable } = writer;
  if (reader) {
    const readable = reader.createReadable ? reader.createReadable({ chunkSize: getChunkSize(config2) }) : reader.readable;
    const size = reader.size;
    const workerOptions = {
      options: {
        codecType: CODEC_DEFLATE,
        level,
        rawPassword,
        password,
        encryptionStrength,
        zipCrypto: encrypted && zipCrypto,
        passwordVerification: encrypted && zipCrypto && rawLastModDate >> 8 & MAX_8_BITS,
        signed: !passThrough,
        compressed: compressed && !passThrough,
        encrypted: encrypted && !passThrough,
        useWebWorkers,
        useCompressionStream,
        transferStreams
      },
      config: config2,
      streamOptions: { signal, size, onstart, onprogress, onend }
    };
    try {
      const result = await runWorker2({ readable, writable }, workerOptions);
      compressedSize = result.outputSize;
      writer.size += compressedSize;
      if (!passThrough) {
        uncompressedSize = result.inputSize;
        signature = result.signature;
      }
      if (!zip64CompressedSize && compressedSize >= MAX_32_BITS || !zip64UncompressedSize && uncompressedSize >= MAX_32_BITS) {
        throw new Error(ERR_UNSUPPORTED_FORMAT);
      }
    } catch (error) {
      if (error.outputSize !== UNDEFINED_VALUE) {
        writer.size += error.outputSize;
      }
      throw error;
    }
  }
  setEntryInfo({
    signature,
    compressedSize,
    uncompressedSize,
    headerInfo,
    dataDescriptorInfo
  }, options);
  if (dataDescriptor) {
    await writeData(writer, dataDescriptorArray);
  }
  Object.assign(fileEntry, {
    uncompressedSize,
    compressedSize,
    lastModDate,
    rawLastModDate,
    creationDate,
    lastAccessDate,
    encrypted,
    zipCrypto,
    size: metadataSize + compressedSize,
    compressionMethod,
    version,
    headerArray,
    headerView,
    signature,
    extraFieldExtendedTimestampFlag,
    zip64UncompressedSize,
    zip64CompressedSize
  });
  return fileEntry;
}
function getHeaderInfo(options) {
  const {
    rawFilename,
    lastModDate,
    lastAccessDate,
    creationDate,
    level,
    zip64,
    zipCrypto,
    useUnicodeFileNames,
    dataDescriptor,
    directory,
    rawExtraField,
    encryptionStrength,
    extendedTimestamp,
    passThrough,
    encrypted,
    zip64UncompressedSize,
    zip64CompressedSize,
    uncompressedSize
  } = options;
  let { version, compressionMethod } = options;
  const compressed = !directory && (compressionMethod === UNDEFINED_VALUE ? level === UNDEFINED_VALUE || level > 0 : compressionMethod !== COMPRESSION_METHOD_STORE);
  let rawLocalExtraFieldZip64;
  const uncompressedFile = passThrough || !compressed;
  const zip64ExtraFieldComplete = zip64 && (options.bufferedWrite || !dataDescriptor || (!zip64UncompressedSize && !zip64CompressedSize || uncompressedFile));
  const writeLocalExtraFieldZip64 = zip64ExtraFieldComplete || zip64 && dataDescriptor && (zip64UncompressedSize || zip64CompressedSize);
  if (zip64 && (zip64UncompressedSize || zip64CompressedSize)) {
    const length = 4 + 16;
    const extraFieldZip64 = createRecordWriter(length);
    extraFieldZip64.uint16(EXTRAFIELD_TYPE_ZIP64);
    extraFieldZip64.uint16(length - 4);
    rawLocalExtraFieldZip64 = extraFieldZip64.array;
    if (zip64ExtraFieldComplete) {
      extraFieldZip64.uint64(uncompressedSize);
      if (uncompressedFile) {
        const encryptionOverhead = encrypted ? zipCrypto ? 12 : 16 + encryptionStrength * 4 : 0;
        extraFieldZip64.uint64(passThrough ? 0 : uncompressedSize + encryptionOverhead);
      }
    }
  } else {
    rawLocalExtraFieldZip64 = EMPTY_UINT8_ARRAY;
  }
  let rawExtraFieldAES;
  if (encrypted && !zipCrypto) {
    const extraFieldAES = createRecordWriter(getLength(EXTRAFIELD_DATA_AES) + 2);
    extraFieldAES.uint16(EXTRAFIELD_TYPE_AES);
    extraFieldAES.bytes(EXTRAFIELD_DATA_AES);
    rawExtraFieldAES = extraFieldAES.array;
    rawExtraFieldAES[8] = encryptionStrength;
  } else {
    rawExtraFieldAES = EMPTY_UINT8_ARRAY;
  }
  let rawExtraFieldNTFS;
  let rawExtraFieldExtendedTimestamp;
  let extraFieldExtendedTimestampFlag;
  if (extendedTimestamp) {
    const lastModTimeUnix = getTimeUnix(lastModDate);
    if (inUnixTimeRange(lastModTimeUnix)) {
      const extraFieldTimestampLength = 9 + (lastAccessDate ? 4 : 0) + (creationDate ? 4 : 0);
      const extraFieldTimestamp = createRecordWriter(extraFieldTimestampLength);
      extraFieldExtendedTimestampFlag = 1 + (lastAccessDate ? 2 : 0) + (creationDate ? 4 : 0);
      extraFieldTimestamp.uint16(EXTRAFIELD_TYPE_EXTENDED_TIMESTAMP);
      extraFieldTimestamp.uint16(extraFieldTimestampLength - 4);
      extraFieldTimestamp.uint8(extraFieldExtendedTimestampFlag);
      extraFieldTimestamp.uint32(lastModTimeUnix);
      if (lastAccessDate) {
        extraFieldTimestamp.uint32(clampUnixTime(getTimeUnix(lastAccessDate)));
      }
      if (creationDate) {
        extraFieldTimestamp.uint32(clampUnixTime(getTimeUnix(creationDate)));
      }
      rawExtraFieldExtendedTimestamp = extraFieldTimestamp.array;
    } else {
      rawExtraFieldExtendedTimestamp = EMPTY_UINT8_ARRAY;
    }
    try {
      const lastModTimeNTFS = getTimeNTFS(lastModDate);
      const extraFieldNTFS = createRecordWriter(36);
      extraFieldNTFS.uint16(EXTRAFIELD_TYPE_NTFS);
      extraFieldNTFS.uint16(32);
      extraFieldNTFS.skip(4);
      extraFieldNTFS.uint16(EXTRAFIELD_TYPE_NTFS_TAG1);
      extraFieldNTFS.uint16(24);
      extraFieldNTFS.uint64(lastModTimeNTFS);
      extraFieldNTFS.uint64(getTimeNTFS(lastAccessDate) || lastModTimeNTFS);
      extraFieldNTFS.uint64(getTimeNTFS(creationDate) || lastModTimeNTFS);
      rawExtraFieldNTFS = extraFieldNTFS.array;
    } catch {
      rawExtraFieldNTFS = EMPTY_UINT8_ARRAY;
    }
  } else {
    rawExtraFieldNTFS = rawExtraFieldExtendedTimestamp = EMPTY_UINT8_ARRAY;
  }
  let rawExtraFieldUnix;
  try {
    const { uid, gid, unixExtraFieldType } = options;
    if (unixExtraFieldType == INFOZIP_EXTRA_FIELD_TYPE && (uid !== UNDEFINED_VALUE || gid !== UNDEFINED_VALUE)) {
      const uidBytes = packUnixId(uid);
      const gidBytes = packUnixId(gid);
      const payloadLength = 3 + uidBytes.length + gidBytes.length;
      const extraFieldUnix = createRecordWriter(4 + payloadLength);
      extraFieldUnix.uint16(EXTRAFIELD_TYPE_INFOZIP);
      extraFieldUnix.uint16(payloadLength);
      extraFieldUnix.uint8(1);
      extraFieldUnix.uint8(uidBytes.length);
      extraFieldUnix.bytes(uidBytes);
      extraFieldUnix.uint8(gidBytes.length);
      extraFieldUnix.bytes(gidBytes);
      rawExtraFieldUnix = extraFieldUnix.array;
    } else if (unixExtraFieldType == UNIX_EXTRA_FIELD_TYPE && (uid !== UNDEFINED_VALUE || gid !== UNDEFINED_VALUE)) {
      const extraFieldUnix = createRecordWriter(8);
      extraFieldUnix.uint16(EXTRAFIELD_TYPE_UNIX);
      extraFieldUnix.uint16(4);
      extraFieldUnix.uint16((uid === UNDEFINED_VALUE ? 0 : uid) & MAX_16_BITS);
      extraFieldUnix.uint16((gid === UNDEFINED_VALUE ? 0 : gid) & MAX_16_BITS);
      rawExtraFieldUnix = extraFieldUnix.array;
    } else {
      rawExtraFieldUnix = EMPTY_UINT8_ARRAY;
    }
  } catch {
    rawExtraFieldUnix = EMPTY_UINT8_ARRAY;
  }
  if (compressionMethod === UNDEFINED_VALUE) {
    compressionMethod = compressed ? COMPRESSION_METHOD_DEFLATE : COMPRESSION_METHOD_STORE;
  }
  if (zip64) {
    version = version > VERSION_ZIP64 ? version : VERSION_ZIP64;
  }
  if (encrypted && !zipCrypto) {
    version = version > VERSION_AES ? version : VERSION_AES;
    rawExtraFieldAES[9] = compressionMethod;
    compressionMethod = COMPRESSION_METHOD_AES;
  }
  const localExtraFieldZip64Length = writeLocalExtraFieldZip64 ? getLength(rawLocalExtraFieldZip64) : 0;
  const extraFieldLength = localExtraFieldZip64Length + getLength(rawExtraFieldAES, rawExtraFieldExtendedTimestamp, rawExtraFieldNTFS, rawExtraFieldUnix, rawExtraField);
  if (extraFieldLength > MAX_16_BITS) {
    throw new Error(ERR_INVALID_EXTRAFIELD_DATA);
  }
  const {
    headerArray,
    headerView,
    rawLastModDate
  } = getHeaderArrayData({
    version,
    bitFlag: getBitFlag(level, useUnicodeFileNames, dataDescriptor, encrypted, compressionMethod),
    compressionMethod,
    uncompressedSize,
    lastModDate: lastModDate < MIN_DATE ? MIN_DATE : lastModDate > MAX_DATE ? MAX_DATE : lastModDate,
    rawFilename,
    zip64CompressedSize,
    zip64UncompressedSize,
    extraFieldLength
  });
  const localHeader = createRecordWriter(HEADER_SIZE + getLength(rawFilename) + extraFieldLength);
  const localHeaderArray = localHeader.array;
  const localHeaderView = getDataView2(localHeaderArray);
  localHeader.uint32(LOCAL_FILE_HEADER_SIGNATURE);
  localHeader.bytes(headerArray);
  localHeader.bytes(rawFilename);
  if (writeLocalExtraFieldZip64) {
    localHeader.bytes(rawLocalExtraFieldZip64);
  }
  localHeader.bytes(rawExtraFieldAES);
  localHeader.bytes(rawExtraFieldExtendedTimestamp);
  localHeader.bytes(rawExtraFieldNTFS);
  localHeader.bytes(rawExtraFieldUnix);
  localHeader.bytes(rawExtraField);
  if (dataDescriptor) {
    if (!zip64CompressedSize) {
      setUint32(localHeaderView, HEADER_OFFSET_COMPRESSED_SIZE + LOCAL_HEADER_COMMON_OFFSET, 0);
    }
    if (!zip64UncompressedSize) {
      setUint32(localHeaderView, HEADER_OFFSET_UNCOMPRESSED_SIZE + LOCAL_HEADER_COMMON_OFFSET, 0);
    }
  }
  return {
    localHeaderArray,
    localHeaderView,
    headerArray,
    headerView,
    lastModDate,
    rawLastModDate,
    encrypted,
    compressed,
    version,
    compressionMethod,
    extraFieldExtendedTimestampFlag,
    rawExtraFieldZip64: EMPTY_UINT8_ARRAY,
    localExtraFieldZip64Length,
    rawExtraFieldExtendedTimestamp,
    rawExtraFieldNTFS,
    rawExtraFieldUnix,
    rawExtraFieldAES,
    extraFieldLength
  };
}
function appendExtraFieldUSDZ(entryInfo, zipWriterOffset) {
  const { headerInfo } = entryInfo;
  let { localHeaderArray, extraFieldLength } = headerInfo;
  let extraBytesLength = 64 - (zipWriterOffset + getLength(localHeaderArray)) % 64;
  if (extraBytesLength < 4) {
    extraBytesLength += 64;
  }
  const rawExtraFieldUSDZ = new Uint8Array(extraBytesLength);
  const extraFieldUSDZView = getDataView2(rawExtraFieldUSDZ);
  setUint16(extraFieldUSDZView, 0, EXTRAFIELD_TYPE_USDZ);
  setUint16(extraFieldUSDZView, 2, extraBytesLength - 4);
  const previousLocalHeaderArray = localHeaderArray;
  headerInfo.localHeaderArray = localHeaderArray = new Uint8Array(getLength(previousLocalHeaderArray) + extraBytesLength);
  arraySet(localHeaderArray, previousLocalHeaderArray);
  arraySet(localHeaderArray, rawExtraFieldUSDZ, getLength(previousLocalHeaderArray));
  const localHeaderArrayView = getDataView2(localHeaderArray);
  setUint16(localHeaderArrayView, 28, extraFieldLength + extraBytesLength);
  headerInfo.localHeaderView = localHeaderArrayView;
  entryInfo.metadataSize += extraBytesLength;
}
function packUnixId(id) {
  if (id === UNDEFINED_VALUE) {
    return EMPTY_UINT8_ARRAY;
  } else {
    const dataArray = new Uint8Array(4);
    const dataView = getDataView2(dataArray);
    dataView.setUint32(0, id, true);
    let length = 4;
    while (length > 1 && dataArray[length - 1] === 0) {
      length--;
    }
    return dataArray.subarray(0, length);
  }
}
function normalizeMsdosAttributes(msdosAttributesRaw, msdosAttributes) {
  if (msdosAttributesRaw !== UNDEFINED_VALUE) {
    msdosAttributesRaw = msdosAttributesRaw & MAX_8_BITS;
  } else if (msdosAttributes !== UNDEFINED_VALUE) {
    const { readOnly, hidden, system, directory: msdDir, archive } = msdosAttributes;
    let raw = 0;
    if (readOnly) raw |= FILE_ATTR_MSDOS_READONLY_MASK;
    if (hidden) raw |= FILE_ATTR_MSDOS_HIDDEN_MASK;
    if (system) raw |= FILE_ATTR_MSDOS_SYSTEM_MASK;
    if (msdDir) raw |= FILE_ATTR_MSDOS_DIR_MASK;
    if (archive) raw |= FILE_ATTR_MSDOS_ARCHIVE_MASK;
    msdosAttributesRaw = raw & MAX_8_BITS;
  }
  if (msdosAttributes === UNDEFINED_VALUE) {
    msdosAttributes = {
      readOnly: Boolean(msdosAttributesRaw & FILE_ATTR_MSDOS_READONLY_MASK),
      hidden: Boolean(msdosAttributesRaw & FILE_ATTR_MSDOS_HIDDEN_MASK),
      system: Boolean(msdosAttributesRaw & FILE_ATTR_MSDOS_SYSTEM_MASK),
      directory: Boolean(msdosAttributesRaw & FILE_ATTR_MSDOS_DIR_MASK),
      archive: Boolean(msdosAttributesRaw & FILE_ATTR_MSDOS_ARCHIVE_MASK)
    };
  }
  return { msdosAttributesRaw, msdosAttributes };
}
function getDataDescriptorInfo({
  zip64,
  dataDescriptor,
  dataDescriptorSignature
}) {
  let dataDescriptorArray = EMPTY_UINT8_ARRAY;
  let dataDescriptorView, dataDescriptorOffset = 0;
  let dataDescriptorLength = zip64 ? DATA_DESCRIPTOR_RECORD_ZIP_64_LENGTH : DATA_DESCRIPTOR_RECORD_LENGTH;
  if (dataDescriptorSignature) {
    dataDescriptorLength += DATA_DESCRIPTOR_RECORD_SIGNATURE_LENGTH;
  }
  if (dataDescriptor) {
    dataDescriptorArray = new Uint8Array(dataDescriptorLength);
    dataDescriptorView = getDataView2(dataDescriptorArray);
    if (dataDescriptorSignature) {
      dataDescriptorOffset = DATA_DESCRIPTOR_RECORD_SIGNATURE_LENGTH;
      setUint32(dataDescriptorView, 0, DATA_DESCRIPTOR_RECORD_SIGNATURE);
    }
  }
  return {
    dataDescriptorArray,
    dataDescriptorView,
    dataDescriptorOffset
  };
}
function setEntryInfo({
  signature,
  compressedSize,
  uncompressedSize,
  headerInfo,
  dataDescriptorInfo
}, {
  zip64,
  zipCrypto,
  dataDescriptor
}) {
  const {
    headerView,
    encrypted
  } = headerInfo;
  const {
    dataDescriptorView,
    dataDescriptorOffset
  } = dataDescriptorInfo;
  if ((!encrypted || zipCrypto) && signature !== UNDEFINED_VALUE) {
    setUint32(headerView, HEADER_OFFSET_SIGNATURE, signature);
    if (dataDescriptor) {
      setUint32(dataDescriptorView, dataDescriptorOffset, signature);
    }
  }
  if (zip64) {
    if (dataDescriptor) {
      setBigUint64(dataDescriptorView, dataDescriptorOffset + 4, BigInt(compressedSize));
      setBigUint64(dataDescriptorView, dataDescriptorOffset + 12, BigInt(uncompressedSize));
    }
  } else {
    setUint32(headerView, HEADER_OFFSET_COMPRESSED_SIZE, compressedSize);
    setUint32(headerView, HEADER_OFFSET_UNCOMPRESSED_SIZE, uncompressedSize);
    if (dataDescriptor) {
      setUint32(dataDescriptorView, dataDescriptorOffset + 4, compressedSize);
      setUint32(dataDescriptorView, dataDescriptorOffset + 8, uncompressedSize);
    }
  }
}
function updateLocalHeader({
  rawFilename,
  encrypted,
  zip64,
  localExtraFieldZip64Length,
  signature,
  compressedSize,
  uncompressedSize,
  zip64UncompressedSize,
  zip64CompressedSize
}, localHeaderView, { dataDescriptor }) {
  if (!dataDescriptor) {
    if (!encrypted) {
      setUint32(localHeaderView, HEADER_OFFSET_SIGNATURE + LOCAL_HEADER_COMMON_OFFSET, signature);
    }
    if (!zip64CompressedSize) {
      setUint32(localHeaderView, HEADER_OFFSET_COMPRESSED_SIZE + LOCAL_HEADER_COMMON_OFFSET, compressedSize);
    }
    if (!zip64UncompressedSize) {
      setUint32(localHeaderView, HEADER_OFFSET_UNCOMPRESSED_SIZE + LOCAL_HEADER_COMMON_OFFSET, uncompressedSize);
    }
  }
  if (zip64 && localExtraFieldZip64Length) {
    const localHeaderOffset = HEADER_SIZE + getLength(rawFilename) + 4;
    setBigUint64(localHeaderView, localHeaderOffset, BigInt(uncompressedSize));
    setBigUint64(localHeaderView, localHeaderOffset + 8, BigInt(compressedSize));
  }
}
async function closeFile(zipWriter, comment, options) {
  const directoryDataLength = createDirectoryRecords(zipWriter.files);
  const { cdStartDiskNumber, cdStartDiskOffset } = await writeDirectoryRecords(zipWriter, directoryDataLength, options);
  await writeEndOfDirectoryRecord(zipWriter, comment, options, { cdStartDiskNumber, cdStartDiskOffset, directoryDataLength });
}
function createDirectoryRecords(files) {
  let directoryDataLength = 0;
  for (const [, fileEntry] of files) {
    const {
      rawFilename,
      rawExtraFieldAES,
      rawComment,
      rawExtraFieldNTFS,
      rawExtraFieldUnix,
      rawExtraField,
      extendedTimestamp,
      extraFieldExtendedTimestampFlag,
      lastModDate,
      zip64UncompressedSize,
      zip64CompressedSize,
      uncompressedSize,
      compressedSize
    } = fileEntry;
    const zip64Offset = fileEntry.offset >= MAX_32_BITS;
    const zip64DiskNumberStart = fileEntry.diskNumberStart >= MAX_16_BITS;
    let rawExtraFieldZip64;
    if (zip64Offset || zip64DiskNumberStart || zip64UncompressedSize || zip64CompressedSize) {
      const length = 4 + (zip64UncompressedSize ? 8 : 0) + (zip64CompressedSize ? 8 : 0) + (zip64Offset ? 8 : 0) + (zip64DiskNumberStart ? 4 : 0);
      const extraFieldZip64 = createRecordWriter(length);
      extraFieldZip64.uint16(EXTRAFIELD_TYPE_ZIP64);
      extraFieldZip64.uint16(length - 4);
      if (zip64UncompressedSize) {
        extraFieldZip64.uint64(uncompressedSize);
      }
      if (zip64CompressedSize) {
        extraFieldZip64.uint64(compressedSize);
      }
      if (zip64Offset) {
        extraFieldZip64.uint64(fileEntry.offset);
      }
      if (zip64DiskNumberStart) {
        extraFieldZip64.uint32(fileEntry.diskNumberStart);
      }
      rawExtraFieldZip64 = extraFieldZip64.array;
    } else {
      rawExtraFieldZip64 = EMPTY_UINT8_ARRAY;
    }
    fileEntry.rawExtraFieldZip64 = rawExtraFieldZip64;
    fileEntry.zip64Offset = zip64Offset;
    fileEntry.zip64DiskNumberStart = zip64DiskNumberStart;
    let rawExtraFieldTimestamp;
    const lastModTimeUnix = getTimeUnix(lastModDate);
    if (extendedTimestamp && inUnixTimeRange(lastModTimeUnix)) {
      const extraFieldTimestamp = createRecordWriter(9);
      extraFieldTimestamp.uint16(EXTRAFIELD_TYPE_EXTENDED_TIMESTAMP);
      extraFieldTimestamp.uint16(5);
      extraFieldTimestamp.uint8(extraFieldExtendedTimestampFlag);
      extraFieldTimestamp.uint32(lastModTimeUnix);
      rawExtraFieldTimestamp = extraFieldTimestamp.array;
    } else {
      rawExtraFieldTimestamp = EMPTY_UINT8_ARRAY;
    }
    fileEntry.rawExtraFieldExtendedTimestamp = rawExtraFieldTimestamp;
    const extraFieldLength = getLength(
      rawExtraFieldZip64,
      rawExtraFieldAES,
      rawExtraFieldNTFS,
      rawExtraFieldUnix,
      rawExtraFieldTimestamp,
      rawExtraField
    );
    if (extraFieldLength > MAX_16_BITS) {
      throw new Error(ERR_INVALID_EXTRAFIELD_DATA);
    }
    directoryDataLength += CENTRAL_FILE_HEADER_LENGTH + getLength(rawFilename, rawComment) + extraFieldLength;
  }
  return directoryDataLength;
}
async function writeDirectoryRecords(zipWriter, directoryDataLength, options) {
  const { files, writer } = zipWriter;
  const directoryArray = new Uint8Array(directoryDataLength);
  await initStream(writer);
  let offset = 0;
  let directoryDiskOffset = 0;
  let cdStartDiskNumber = writer.diskNumber;
  let cdStartDiskOffset = writer.diskOffset;
  for (const [indexFileEntry, fileEntry] of Array.from(files.values()).entries()) {
    const {
      offset: fileEntryOffset,
      rawFilename,
      rawExtraFieldZip64,
      rawExtraFieldAES,
      rawExtraFieldExtendedTimestamp,
      rawExtraFieldNTFS,
      rawExtraFieldUnix,
      rawExtraField,
      rawComment,
      versionMadeBy,
      headerArray,
      headerView,
      zip64UncompressedSize,
      zip64CompressedSize,
      zip64DiskNumberStart,
      zip64Offset,
      internalFileAttributes,
      externalFileAttributes,
      diskNumberStart,
      uncompressedSize,
      compressedSize
    } = fileEntry;
    const extraFieldLength = getLength(rawExtraFieldZip64, rawExtraFieldAES, rawExtraFieldExtendedTimestamp, rawExtraFieldNTFS, rawExtraFieldUnix, rawExtraField);
    const directoryRecordLength = CENTRAL_FILE_HEADER_LENGTH + getLength(rawFilename, rawComment) + extraFieldLength;
    if (offset + directoryRecordLength - directoryDiskOffset > writer.availableSize) {
      await writeData(writer, directoryArray.slice(directoryDiskOffset, offset));
      directoryDiskOffset = offset;
      writer.availableSize = 0;
      await writeData(writer, EMPTY_UINT8_ARRAY);
    }
    if (indexFileEntry == 0) {
      cdStartDiskNumber = writer.diskNumber;
      cdStartDiskOffset = writer.diskOffset;
    }
    if (!zip64UncompressedSize) {
      setUint32(headerView, HEADER_OFFSET_UNCOMPRESSED_SIZE, uncompressedSize);
    }
    if (!zip64CompressedSize) {
      setUint32(headerView, HEADER_OFFSET_COMPRESSED_SIZE, compressedSize);
    }
    if ((zip64Offset || zip64DiskNumberStart) && fileEntry.version < VERSION_ZIP64) {
      setUint16(headerView, HEADER_OFFSET_VERSION, VERSION_ZIP64);
    }
    const directoryRecord = createRecordWriter(directoryRecordLength);
    directoryRecord.uint32(CENTRAL_FILE_HEADER_SIGNATURE);
    directoryRecord.uint16(versionMadeBy);
    directoryRecord.bytes(headerArray.subarray(0, HEADER_SIZE - 4 - 2));
    directoryRecord.uint16(extraFieldLength);
    directoryRecord.uint16(getLength(rawComment));
    directoryRecord.uint16(zip64DiskNumberStart ? MAX_16_BITS : diskNumberStart);
    directoryRecord.uint16(internalFileAttributes);
    directoryRecord.uint32(externalFileAttributes);
    directoryRecord.uint32(zip64Offset ? MAX_32_BITS : fileEntryOffset);
    directoryRecord.bytes(rawFilename);
    directoryRecord.bytes(rawExtraFieldZip64);
    directoryRecord.bytes(rawExtraFieldAES);
    directoryRecord.bytes(rawExtraFieldExtendedTimestamp);
    directoryRecord.bytes(rawExtraFieldNTFS);
    directoryRecord.bytes(rawExtraFieldUnix);
    directoryRecord.bytes(rawExtraField);
    directoryRecord.bytes(rawComment);
    arraySet(directoryArray, directoryRecord.array, offset);
    offset += directoryRecordLength;
    if (options.onprogress) {
      try {
        await options.onprogress(indexFileEntry + 1, files.size, new Entry(fileEntry));
      } catch {
      }
    }
  }
  await writeData(writer, directoryDiskOffset ? directoryArray.slice(directoryDiskOffset) : directoryArray);
  return { cdStartDiskNumber, cdStartDiskOffset };
}
async function writeEndOfDirectoryRecord(zipWriter, comment, options, cdInfo) {
  const { writer } = zipWriter;
  const { cdStartDiskNumber, cdStartDiskOffset } = cdInfo;
  let { directoryDataLength } = cdInfo;
  let filesLength = zipWriter.files.size;
  let diskNumber = cdStartDiskNumber;
  let directoryOffset = zipWriter.offset - cdStartDiskOffset - (cdStartDiskNumber ? zipWriter.initialOffset : 0);
  let lastDiskNumber = writer.diskNumber;
  if (writer.availableSize < END_OF_CENTRAL_DIR_LENGTH) {
    lastDiskNumber++;
  }
  let zip64 = getOptionValue2(zipWriter, options, PROPERTY_NAME_ZIP64);
  if (directoryOffset >= MAX_32_BITS || directoryDataLength >= MAX_32_BITS || filesLength >= MAX_16_BITS || lastDiskNumber >= MAX_16_BITS) {
    if (zip64 === false) {
      throw new Error(ERR_UNSUPPORTED_FORMAT);
    } else {
      zip64 = true;
    }
  }
  const commentLength = getLength(comment);
  if (commentLength > MAX_16_BITS) {
    throw new Error(ERR_INVALID_COMMENT);
  }
  const endOfdirectoryRecord = createRecordWriter(zip64 ? ZIP64_END_OF_CENTRAL_DIR_TOTAL_LENGTH : END_OF_CENTRAL_DIR_LENGTH);
  if (getLength(endOfdirectoryRecord.array) + commentLength > writer.availableSize) {
    writer.availableSize = 0;
    await writeData(writer, EMPTY_UINT8_ARRAY);
  }
  lastDiskNumber = writer.diskNumber;
  if (zip64) {
    endOfdirectoryRecord.uint32(ZIP64_END_OF_CENTRAL_DIR_SIGNATURE);
    endOfdirectoryRecord.uint64(44);
    endOfdirectoryRecord.uint16(45);
    endOfdirectoryRecord.uint16(45);
    endOfdirectoryRecord.uint32(lastDiskNumber);
    endOfdirectoryRecord.uint32(diskNumber);
    endOfdirectoryRecord.uint64(filesLength);
    endOfdirectoryRecord.uint64(filesLength);
    endOfdirectoryRecord.uint64(directoryDataLength);
    endOfdirectoryRecord.uint64(directoryOffset);
    endOfdirectoryRecord.uint32(ZIP64_END_OF_CENTRAL_DIR_LOCATOR_SIGNATURE);
    endOfdirectoryRecord.uint32(lastDiskNumber);
    endOfdirectoryRecord.uint64(BigInt(zipWriter.offset) + BigInt(directoryDataLength) - BigInt(writer.diskOffset) - BigInt(writer.diskNumber ? zipWriter.initialOffset : 0));
    endOfdirectoryRecord.uint32(lastDiskNumber + 1);
    const supportZip64SplitFile = getOptionValue2(zipWriter, options, OPTION_SUPPORT_ZIP64_SPLIT_FILE, true);
    if (supportZip64SplitFile) {
      lastDiskNumber = MAX_16_BITS;
      diskNumber = MAX_16_BITS;
    }
    filesLength = MAX_16_BITS;
    directoryOffset = MAX_32_BITS;
    directoryDataLength = MAX_32_BITS;
  }
  endOfdirectoryRecord.uint32(END_OF_CENTRAL_DIR_SIGNATURE);
  endOfdirectoryRecord.uint16(lastDiskNumber);
  endOfdirectoryRecord.uint16(diskNumber);
  endOfdirectoryRecord.uint16(filesLength);
  endOfdirectoryRecord.uint16(filesLength);
  endOfdirectoryRecord.uint32(directoryDataLength);
  endOfdirectoryRecord.uint32(directoryOffset);
  endOfdirectoryRecord.uint16(commentLength);
  await writeData(writer, endOfdirectoryRecord.array);
  if (commentLength) {
    await writeData(writer, comment);
  }
}
function createRecordWriter(length) {
  const array = new Uint8Array(length);
  const view = getDataView2(array);
  let offset = 0;
  return {
    array,
    uint8: (value) => {
      setUint8(view, offset, value);
      offset += 1;
    },
    uint16: (value) => {
      setUint16(view, offset, value);
      offset += 2;
    },
    uint32: (value) => {
      setUint32(view, offset, value);
      offset += 4;
    },
    uint64: (value) => {
      setBigUint64(view, offset, BigInt(value));
      offset += 8;
    },
    bytes: (value) => {
      arraySet(array, value, offset);
      offset += getLength(value);
    },
    skip: (count) => offset += count
  };
}
function getSegmentOffset(zipWriter, writer) {
  return zipWriter.offset - writer.diskOffset - (writer.diskNumber ? zipWriter.initialOffset : 0);
}
async function writeData(writer, array) {
  const { writable } = writer;
  const streamWriter = writable.getWriter();
  try {
    await streamWriter.ready;
    writer.size += getLength(array);
    await streamWriter.write(array);
  } finally {
    streamWriter.releaseLock();
  }
}
async function flushBufferedData(readable, writer, signal, onChunkWritten) {
  const streamWriter = writer.writable.getWriter();
  try {
    await readable.pipeTo(new WritableStream({
      async write(chunk) {
        await streamWriter.ready;
        await streamWriter.write(chunk);
        onChunkWritten(getLength(chunk));
      }
    }), { preventClose: true, preventAbort: true, signal });
  } finally {
    streamWriter.releaseLock();
  }
}
function getTimeNTFS(date) {
  if (date) {
    return (BigInt(date.getTime()) + BigInt(116444736e5)) * BigInt(1e4);
  }
}
function getTimeUnix(date) {
  return Math.floor(date.getTime() / 1e3);
}
function inUnixTimeRange(timeUnix) {
  return timeUnix >= MIN_UNIX_TIME && timeUnix <= MAX_UNIX_TIME;
}
function clampUnixTime(timeUnix) {
  return Math.min(MAX_UNIX_TIME, Math.max(MIN_UNIX_TIME, timeUnix));
}
function getOptionValue2(zipWriter, options, name, defaultValue) {
  const result = options[name] === UNDEFINED_VALUE ? zipWriter.options[name] : options[name];
  return result === UNDEFINED_VALUE ? defaultValue : result;
}
function getMaximumCompressedSize(uncompressedSize) {
  return uncompressedSize + 5 * (Math.floor(uncompressedSize / 16383) + 1);
}
function setUint8(view, offset, value) {
  view.setUint8(offset, value);
}
function setUint16(view, offset, value) {
  view.setUint16(offset, value, true);
}
function setUint32(view, offset, value) {
  view.setUint32(offset, value, true);
}
function setBigUint64(view, offset, value) {
  view.setBigUint64(offset, value, true);
}
function arraySet(array, typedArray, offset) {
  array.set(typedArray, offset);
}
function getDataView2(array) {
  return new DataView(array.buffer, array.byteOffset, array.byteLength);
}
function getLength(...arrayLikes) {
  let result = 0;
  arrayLikes.forEach((arrayLike) => arrayLike && (result += arrayLike.length));
  return result;
}
function getHeaderArrayData({
  version,
  bitFlag,
  compressionMethod,
  uncompressedSize,
  compressedSize,
  lastModDate,
  rawLastModDate,
  rawFilename,
  zip64CompressedSize,
  zip64UncompressedSize,
  extraFieldLength
}) {
  const headerRecord = createRecordWriter(HEADER_SIZE - 4);
  const headerArray = headerRecord.array;
  const headerView = getDataView2(headerArray);
  headerRecord.uint16(version);
  headerRecord.uint16(bitFlag);
  headerRecord.uint16(compressionMethod);
  if (rawLastModDate === UNDEFINED_VALUE) {
    const dateArray = new Uint32Array(1);
    const dateView = getDataView2(dateArray);
    setUint16(dateView, 0, (lastModDate.getHours() << 6 | lastModDate.getMinutes()) << 5 | lastModDate.getSeconds() / 2);
    setUint16(dateView, 2, (lastModDate.getFullYear() - 1980 << 4 | lastModDate.getMonth() + 1) << 5 | lastModDate.getDate());
    rawLastModDate = dateArray[0];
  }
  headerRecord.uint32(rawLastModDate);
  headerRecord.skip(4);
  if (zip64CompressedSize || compressedSize !== UNDEFINED_VALUE) {
    headerRecord.uint32(zip64CompressedSize ? MAX_32_BITS : compressedSize);
  } else {
    headerRecord.skip(4);
  }
  if (zip64UncompressedSize || uncompressedSize !== UNDEFINED_VALUE) {
    headerRecord.uint32(zip64UncompressedSize ? MAX_32_BITS : uncompressedSize);
  } else {
    headerRecord.skip(4);
  }
  headerRecord.uint16(getLength(rawFilename));
  headerRecord.uint16(extraFieldLength);
  return {
    headerArray,
    headerView,
    rawLastModDate
  };
}
function getBitFlag(level, useUnicodeFileNames, dataDescriptor, encrypted, compressionMethod) {
  let bitFlag = 0;
  if (useUnicodeFileNames) {
    bitFlag = bitFlag | BITFLAG_LANG_ENCODING_FLAG;
  }
  if (dataDescriptor) {
    bitFlag = bitFlag | BITFLAG_DATA_DESCRIPTOR;
  }
  if (compressionMethod == COMPRESSION_METHOD_DEFLATE || compressionMethod == COMPRESSION_METHOD_DEFLATE_64) {
    if (level >= 0 && level <= 3) {
      bitFlag = bitFlag | BITFLAG_LEVEL_SUPER_FAST_MASK;
    }
    if (level > 3 && level <= 5) {
      bitFlag = bitFlag | BITFLAG_LEVEL_FAST_MASK;
    }
    if (level == 9) {
      bitFlag = bitFlag | BITFLAG_LEVEL_MAX_MASK;
    }
  }
  if (encrypted) {
    bitFlag = bitFlag | BITFLAG_ENCRYPTED;
  }
  return bitFlag;
}

// src/renderers.ts
function renderCpaAccount(account, options = {}) {
  if (account.provider === "xai") {
    return renderCpaXaiAccount(account, options);
  }
  const allowSynthetic = options.allowSyntheticIdToken !== false;
  const rendered = {
    type: "codex",
    email: account.email ?? "",
    account_id: account.accountId ?? "",
    plan_type: account.planType ?? "",
    id_token: allowSynthetic ? account.idToken ?? "" : account.idTokenSynthetic ? "" : account.idToken ?? "",
    access_token: account.accessToken ?? "",
    ...shouldIncludeRefreshToken(options) ? { refresh_token: account.refreshToken ?? "" } : {},
    expired: account.expiresAt ?? "",
    last_refresh: account.lastRefresh ?? (options.now ?? /* @__PURE__ */ new Date()).toISOString(),
    disabled: false
  };
  if (account.sessionToken) {
    rendered.session_token = account.sessionToken;
  }
  if (account.idTokenSynthetic && allowSynthetic) {
    rendered.id_token_synthetic = true;
  }
  return rendered;
}
function renderCpaXaiAccount(account, options) {
  const rendered = compactObject({
    type: "xai",
    access_token: account.accessToken,
    refresh_token: shouldIncludeRefreshToken(options) ? account.refreshToken : void 0,
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
    headers: account.headers
  });
  return rendered;
}
function renderCodex2ApiAccount(account, options = {}) {
  const allowSynthetic = options.allowSyntheticIdToken !== false;
  return compactObject({
    name: account.name ?? account.email ?? account.chatgptAccountId ?? account.accountId,
    email: account.email,
    refresh_token: shouldIncludeRefreshToken(options) ? account.refreshToken : void 0,
    session_token: account.sessionToken,
    access_token: account.accessToken,
    id_token: allowSynthetic ? account.idToken : account.idTokenSynthetic ? void 0 : account.idToken,
    account_id: account.accountId,
    chatgpt_account_id: account.chatgptAccountId,
    plan_type: account.planType,
    expires_at: account.expiresAt
  });
}
function renderSub2ApiAccount(account, options = {}) {
  const allowSynthetic = options.allowSyntheticIdToken !== false;
  const isOpenAI = account.provider === "openai";
  const credentials = compactObject({
    access_token: account.accessToken,
    refresh_token: shouldIncludeRefreshToken(options) ? account.refreshToken : void 0,
    session_token: isOpenAI ? account.sessionToken : void 0,
    id_token: allowSynthetic ? account.idToken : isOpenAI && account.idTokenSynthetic ? void 0 : account.idToken,
    expires_at: account.expiresAt,
    email: account.email,
    chatgpt_account_id: isOpenAI ? account.chatgptAccountId : void 0,
    chatgpt_user_id: isOpenAI ? account.chatgptUserId : void 0,
    plan_type: isOpenAI ? account.planType : void 0,
    user_id: account.provider === "xai" ? account.userId : void 0,
    client_id: account.provider === "xai" ? account.clientId : void 0,
    base_url: account.provider === "xai" ? account.baseUrl : void 0
  });
  const extra = compactObject({
    import_source: "authconv",
    id_token_synthetic: isOpenAI && account.idTokenSynthetic && allowSynthetic ? true : void 0
  });
  return compactObject({
    name: account.name ?? account.email ?? (isOpenAI ? account.chatgptAccountId ?? account.accountId : account.userId) ?? "authconv-account",
    platform: account.provider === "xai" ? "grok" : "openai",
    type: "oauth",
    credentials,
    extra,
    priority: 50,
    concurrency: 3,
    auto_pause_on_expired: true
  });
}
function renderGrokEntry(account, options = {}) {
  const clientId = account.clientId ?? GROK_CLI_CLIENT_ID;
  return [`${XAI_ISSUER}::${clientId}`, renderXaiAuthEntry(account, clientId, options)];
}
function renderGrok2ApiEntry(account, options = {}) {
  const clientId = account.clientId ?? GROK_CLI_CLIENT_ID;
  const accountId = grok2ApiAccountId(account);
  return [
    `${XAI_ISSUER}::${accountId}`,
    renderXaiAuthEntry(account, clientId, options, accountId)
  ];
}
function grok2ApiStorageKey(account) {
  return `${XAI_ISSUER}::${grok2ApiAccountId(account)}`;
}
function renderXaiAuthEntry(account, clientId, options, anonymousAccountId) {
  const userId = account.userId ?? account.principalId ?? anonymousAccountId ?? "";
  return compactObject({
    key: account.accessToken ?? "",
    auth_mode: "oidc",
    create_time: account.createTime ?? account.issuedAt,
    user_id: userId,
    email: account.email ?? "",
    principal_type: account.principalType ?? "User",
    principal_id: account.principalId ?? userId,
    refresh_token: shouldIncludeRefreshToken(options) ? account.refreshToken ?? "" : void 0,
    expires_at: account.expiresAt,
    oidc_issuer: XAI_ISSUER,
    oidc_client_id: clientId
  });
}
function grok2ApiAccountId(account) {
  return account.userId ?? account.principalId ?? `authconv-${credentialFingerprint(account)}`;
}
function credentialFingerprint(account) {
  const source = [
    ["access_token", account.accessToken],
    ["refresh_token", account.refreshToken],
    ["session_token", account.sessionToken],
    ["id_token", account.idToken]
  ].map(([field, value]) => `${field}\0${value ?? ""}`).join("\0");
  let hash2 = 0xcbf29ce484222325n;
  for (let index = 0; index < source.length; index += 1) {
    hash2 ^= BigInt(source.charCodeAt(index));
    hash2 = BigInt.asUintN(64, hash2 * 0x100000001b3n);
  }
  return hash2.toString(16).padStart(16, "0");
}
function renderCodexManagerAccount(account, options = {}) {
  const allowSynthetic = options.allowSyntheticIdToken !== false;
  return {
    tokens: compactObject({
      access_token: account.accessToken,
      refresh_token: shouldIncludeRefreshToken(options) ? account.refreshToken : void 0,
      id_token: allowSynthetic ? account.idToken : account.idTokenSynthetic ? void 0 : account.idToken,
      account_id: account.accountId,
      chatgpt_account_id: account.chatgptAccountId
    }),
    meta: compactObject({
      label: account.name ?? account.email ?? account.chatgptAccountId ?? account.accountId,
      issuer: account.issuer ?? OPENAI_ISSUER,
      workspace_id: account.workspaceId,
      chatgpt_account_id: account.chatgptAccountId,
      tags: ["authconv"]
    })
  };
}
function renderCodexAuth(account, options = {}) {
  const allowSynthetic = options.allowSyntheticIdToken !== false;
  return {
    auth_mode: "chatgpt",
    OPENAI_API_KEY: null,
    tokens: {
      id_token: allowSynthetic ? account.idToken ?? "" : account.idTokenSynthetic ? "" : account.idToken ?? "",
      access_token: account.accessToken ?? "",
      ...shouldIncludeRefreshToken(options) ? { refresh_token: account.refreshToken ?? "" } : {},
      account_id: account.accountId ?? account.chatgptAccountId ?? ""
    },
    last_refresh: account.lastRefresh ?? (options.now ?? /* @__PURE__ */ new Date()).toISOString()
  };
}
function shouldIncludeRefreshToken(options) {
  return options.includeRefreshToken !== false;
}

// src/output.ts
var ZIP_MTIME = new Date(1980, 0, 1);
var encoder = new TextEncoder();
function buildExportManifest(store, request) {
  const textMode = request.textMode ?? "json";
  for (const format of ALL_FORMATS) {
    const requestedMode = request.outputModes?.[format];
    if (requestedMode !== void 0) resolveOutputMode(format, requestedMode);
  }
  const usedPaths = /* @__PURE__ */ new Set();
  const nextPathSuffix = /* @__PURE__ */ new Map();
  const formatAccounts = /* @__PURE__ */ new Map();
  const requestedIds = request.accountIds ? [...new Set(request.accountIds)] : void 0;
  const candidateEntries = [];
  if (requestedIds) {
    for (const id of requestedIds) {
      const account = store.get(id);
      if (account) candidateEntries.push([id, account]);
    }
  } else {
    for (const entry of store.entries()) candidateEntries.push(entry);
  }
  const acceptedEntries = [];
  const rejectionReasons = {};
  for (const entry of candidateEntries) {
    const verification = entry[1].tokenVerification;
    if (request.verifyTokens !== false && verification?.status !== "verified") {
      const reason = verification?.reason ?? "verification_missing";
      rejectionReasons[reason] = (rejectionReasons[reason] ?? 0) + 1;
      continue;
    }
    acceptedEntries.push(entry);
  }
  for (const format of request.formats) {
    const ids = accountIdsForFormat(format, acceptedEntries, textMode);
    if (ids.length > 0) formatAccounts.set(format, ids);
  }
  const formats = request.formats.filter((format) => formatAccounts.has(format));
  const unavailableFormats = request.formats.filter((format) => !formatAccounts.has(format));
  const useFormatFolders = formats.length > 1;
  const entries = [];
  for (const format of formats) {
    const accountIds = formatAccounts.get(format);
    const directory = useFormatFolders ? `${format}/` : "";
    if (textMode === "jsonl") {
      const basePath = accountIds.length === 1 ? singleAccountName(format, requireAccount(store, accountIds[0])) : mergedName(format, accountIds.length, "jsonl");
      entries.push({
        path: uniquePath(`${directory}${replaceExtension(basePath, ".jsonl")}`, usedPaths, nextPathSuffix),
        format,
        mode: "jsonl",
        accountIds,
        accountCount: accountIds.length
      });
      continue;
    }
    const mode2 = resolveOutputMode(format, request.outputModes?.[format]);
    if (mode2 === "merged") {
      const name = accountIds.length === 1 ? singleAccountName(format, requireAccount(store, accountIds[0])) : mergedName(format, accountIds.length, "json");
      entries.push({
        path: uniquePath(`${directory}${name}`, usedPaths, nextPathSuffix),
        format,
        mode: mode2,
        accountIds,
        accountCount: accountIds.length
      });
      continue;
    }
    for (const id of accountIds) {
      entries.push({
        path: uniquePath(
          `${directory}${singleAccountName(format, requireAccount(store, id))}`,
          usedPaths,
          nextPathSuffix
        ),
        format,
        mode: "single",
        accountIds: [id],
        accountCount: 1
      });
    }
  }
  const exportedIds = /* @__PURE__ */ new Set();
  for (const entry of entries) {
    for (const id of entry.accountIds) exportedIds.add(id);
  }
  return {
    entries,
    formats,
    unavailableFormats,
    accountCount: exportedIds.size,
    rejectedAccountCount: candidateEntries.length - acceptedEntries.length,
    rejectionReasons,
    archive: request.forceZip === true
  };
}
function accountIdsForFormat(format, entries, textMode) {
  const applicable = entries.filter(([, account]) => FORMAT_DEFINITIONS[format].providers.includes(account.provider));
  if (format !== "grok2api" || textMode === "jsonl") return applicable.map(([id]) => id);
  const byStorageKey = /* @__PURE__ */ new Map();
  for (const [id, account] of applicable) {
    if (account.provider === "xai") byStorageKey.set(grok2ApiStorageKey(account), id);
  }
  return [...byStorageKey.values()];
}
async function streamExport(store, manifest, sink, options = {}) {
  if (manifest.entries.length === 0) return { completedEntries: 0, completedAccounts: 0 };
  const now = options.now ?? /* @__PURE__ */ new Date();
  const renderOptions = {
    now,
    includeRefreshToken: options.includeRefreshToken,
    allowSyntheticIdToken: options.allowSyntheticIdToken
  };
  let completedEntries = 0;
  let completedAccounts = 0;
  const totalAccounts = manifest.entries.reduce((sum, entry) => sum + entry.accountCount, 0);
  if (manifest.archive) {
    const writer = await sink.openArchive();
    let writerFinished = false;
    const output = new WritableStream({
      write: (chunk) => writer.write(chunk),
      close: async () => {
        await writer.close();
        writerFinished = true;
      },
      abort: async (error) => {
        try {
          await writer.abort(error);
        } finally {
          writerFinished = true;
        }
      }
    });
    const zip = new ZipWriter(output, {
      zip64: true,
      level: 6,
      extendedTimestamp: false,
      useWebWorkers: false
    });
    try {
      for (const entry of manifest.entries) {
        throwIfAborted4(options.signal);
        await zip.add(
          entry.path,
          readableFrom(renderEntry(store, entry, renderOptions, options.signal)),
          {
            zip64: false,
            lastModDate: ZIP_MTIME,
            extendedTimestamp: false,
            signal: options.signal
          }
        );
        completedEntries += 1;
        completedAccounts += entry.accountCount;
        report(entry.path);
      }
      await zip.close();
    } catch (error) {
      if (!writerFinished) await writer.abort(error);
      throw error;
    }
    return { completedEntries, completedAccounts };
  }
  for (const entry of manifest.entries) {
    throwIfAborted4(options.signal);
    const writer = await sink.openFile(entry.path);
    try {
      for await (const chunk of renderEntry(store, entry, renderOptions, options.signal)) {
        await writer.write(chunk);
      }
      await writer.close();
    } catch (error) {
      await writer.abort(error);
      throw error;
    }
    completedEntries += 1;
    completedAccounts += entry.accountCount;
    report(entry.path);
  }
  return { completedEntries, completedAccounts };
  function report(currentPath) {
    options.onProgress?.({
      completedEntries,
      totalEntries: manifest.entries.length,
      completedAccounts,
      totalAccounts,
      currentPath
    });
  }
}
async function* renderEntry(store, entry, options, signal) {
  if (entry.mode === "jsonl") {
    for (const id of entry.accountIds) {
      throwIfAborted4(signal);
      const account = requireAccount(store, id);
      yield encoder.encode(`${JSON.stringify(renderSingleFile(account, entry.format, options))}
`);
    }
    return;
  }
  if (entry.mode === "single") {
    const account = requireAccount(store, entry.accountIds[0]);
    yield encoder.encode(`${JSON.stringify(renderSingleFile(account, entry.format, options), null, 2)}
`);
    return;
  }
  yield* renderMerged(store, entry.accountIds, entry.format, options, signal);
}
function renderSingleFile(account, format, options) {
  switch (format) {
    case "cpa":
      return renderCpaAccount(requireKnownProvider(account, format), options);
    case "sub2api":
      return sub2ApiDocument([requireKnownProvider(account, format)], options);
    case "codex2api":
      return [renderCodex2ApiAccount(requireOpenAI(account, format), options)];
    case "codexmanager":
      return renderCodexManagerAccount(requireOpenAI(account, format), options);
    case "codex":
      return renderCodexAuth(requireOpenAI(account, format), options);
    case "grok":
      return Object.fromEntries([renderGrokEntry(requireXai(account, format), options)]);
    case "grok2api":
      return Object.fromEntries([renderGrok2ApiEntry(requireXai(account, format), options)]);
  }
}
async function* renderMerged(store, accountIds, format, options, signal) {
  if (format === "sub2api") {
    const header = {
      type: "sub2api-data",
      version: 1,
      exported_at: (options.now ?? /* @__PURE__ */ new Date()).toISOString(),
      proxies: []
    };
    const prefix = JSON.stringify(header, null, 2).replace(/\n}/, ',\n  "accounts": [');
    yield encoder.encode(`${prefix}
`);
    for (let index = 0; index < accountIds.length; index += 1) {
      throwIfAborted4(signal);
      const account = requireAccount(store, accountIds[index]);
      yield encoder.encode(indentJson(renderSub2ApiAccount(requireKnownProvider(account, format), options), 4));
      yield encoder.encode(index + 1 < accountIds.length ? ",\n" : "\n");
    }
    yield encoder.encode("  ]\n}\n");
    return;
  }
  if (format === "codex2api") {
    yield encoder.encode("[\n");
    for (let index = 0; index < accountIds.length; index += 1) {
      throwIfAborted4(signal);
      const account = requireAccount(store, accountIds[index]);
      yield encoder.encode(indentJson(renderCodex2ApiAccount(requireOpenAI(account, format), options), 2));
      yield encoder.encode(index + 1 < accountIds.length ? ",\n" : "\n");
    }
    yield encoder.encode("]\n");
    return;
  }
  if (format === "grok2api") {
    yield encoder.encode("{\n");
    for (let index = 0; index < accountIds.length; index += 1) {
      throwIfAborted4(signal);
      const account = requireAccount(store, accountIds[index]);
      const [key, value] = renderGrok2ApiEntry(requireXai(account, format), options);
      const property = `${JSON.stringify(key)}: ${JSON.stringify(value, null, 2)}`.replace(/\n/g, "\n  ");
      yield encoder.encode(`  ${property}${index + 1 < accountIds.length ? "," : ""}
`);
    }
    yield encoder.encode("}\n");
    return;
  }
  throw new Error(`Format ${format} does not support merged output`);
}
function sub2ApiDocument(accounts, options) {
  return {
    type: "sub2api-data",
    version: 1,
    exported_at: (options.now ?? /* @__PURE__ */ new Date()).toISOString(),
    proxies: [],
    accounts: accounts.map((account) => renderSub2ApiAccount(account, options))
  };
}
function indentJson(value, spaces) {
  const prefix = " ".repeat(spaces);
  return JSON.stringify(value, null, 2).split("\n").map((line) => `${prefix}${line}`).join("\n");
}
function singleAccountName(format, account) {
  const identity = safeFileSegment2(account.email ?? account.name ?? "unknown");
  const stableId = account.provider === "xai" ? account.userId ?? account.principalId : account.provider === "openai" ? account.chatgptAccountId ?? account.accountId : void 0;
  const id = stableId ? safeFileSegment2(stableId.slice(0, 12)) : "";
  const prefix = FORMAT_DEFINITIONS[format].filePrefix;
  return id ? `${prefix}_${identity}_${id}.json` : `${prefix}_${identity}.json`;
}
function mergedName(format, count, extension) {
  return `${FORMAT_DEFINITIONS[format].filePrefix}_${count}-${count === 1 ? "account" : "accounts"}.${extension}`;
}
function safeFileSegment2(value) {
  return value.trim().replace(/[^\w\-.]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 96) || "unknown";
}
function replaceExtension(path2, extension) {
  return path2.replace(/\.[^/.]+$/, extension);
}
function uniquePath(path2, used, nextSuffix) {
  if (!used.has(path2)) {
    used.add(path2);
    return path2;
  }
  const extension = path2.match(/\.[^/.]+$/)?.[0] ?? "";
  const stem = extension ? path2.slice(0, -extension.length) : path2;
  let suffix = nextSuffix.get(path2) ?? 2;
  while (true) {
    const candidate = `${stem}-${suffix}${extension}`;
    suffix += 1;
    if (used.has(candidate)) continue;
    nextSuffix.set(path2, suffix);
    used.add(candidate);
    return candidate;
  }
}
function requireAccount(store, id) {
  const account = store.get(id);
  if (!account) throw new Error(`Export manifest references missing account: ${id}`);
  return account;
}
function requireKnownProvider(account, format) {
  if (account.provider === "unknown") throw new Error(`Format ${format} cannot render an unknown provider`);
  return account;
}
function requireOpenAI(account, format) {
  if (account.provider !== "openai") throw new Error(`Format ${format} requires an OpenAI account`);
  return account;
}
function requireXai(account, format) {
  if (account.provider !== "xai") throw new Error(`Format ${format} requires an xAI account`);
  return account;
}
function throwIfAborted4(signal) {
  if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
}
function readableFrom(source) {
  const iterator = source[Symbol.asyncIterator]();
  return new ReadableStream({
    async pull(controller) {
      try {
        const result = await iterator.next();
        if (result.done) controller.close();
        else controller.enqueue(result.value);
      } catch (error) {
        controller.error(error);
      }
    },
    async cancel() {
      await iterator.return?.();
    }
  });
}

// src/cli.ts
var VERSION = "0.2.0.dev".trim() ? "0.2.0.dev".trim() : package_default.version;
var CliError = class extends Error {
  constructor(exitCode, message) {
    super(message);
    this.exitCode = exitCode;
  }
};
async function runCli(args, io = {}) {
  const locale = detectCliLocale(scanLocaleArg(args));
  const messages = messagesFor(locale).cli;
  let stopSignalHandling = () => void 0;
  try {
    const parsed = parseArgs(args, locale);
    if (parsed.help) {
      return info(helpText(locale));
    }
    if (parsed.version) {
      return info(`${VERSION}
`);
    }
    if (parsed.inputPaths.length === 0 && !parsed.stdin && args.length === 0) {
      return info(helpText(locale));
    }
    validateParsedArgs(parsed);
    if (parsed.serve) {
      const server = await startWebUiServer({
        host: parsed.serveHost,
        port: parsed.servePort
      });
      io.onServerStarted?.(server);
      return info(messages.serve.started(server.url));
    }
    const cwd = io.cwd ?? currentWorkingDirectory(parsed.locale);
    const inputPaths = parsed.inputPaths.map((inputPath) => path.resolve(cwd, inputPath));
    const abortController = new AbortController();
    const onSigint = () => abortController.abort(new DOMException("Interrupted", "AbortError"));
    if (io.handleSignals) {
      process.once("SIGINT", onSigint);
      stopSignalHandling = () => {
        process.off("SIGINT", onSigint);
      };
    }
    const sources = await discoverInputSources(
      inputPaths,
      parsed.stdin,
      parsed.locale,
      io,
      abortController.signal
    );
    const store = new AccountStore();
    const ingestion = await ingestSources(sources, store, {
      parseTokens: parseNodeJsonTokens,
      signal: abortController.signal,
      verifyTokens: parsed.verifyTokens,
      onProgress: progressReporter(io, parsed.locale)
    });
    finishProgress(io);
    const diagnosticLines = ingestion.diagnostics.map((diagnostic) => diagnosticMessage(diagnostic, parsed.locale));
    if (store.size === 0) {
      return fail(1, [messages.errors.noAccounts, ...diagnosticLines]);
    }
    const formats = resolveFormats(parsed.formatValues, parsed.locale);
    const manifest = buildExportManifest(store, {
      formats,
      outputModes: parsed.outputModes,
      textMode: parsed.textMode,
      forceZip: parsed.zip,
      verifyTokens: parsed.verifyTokens
    });
    const verificationLines = verificationRejectionLines(manifest, parsed.locale);
    const resultLines = [...diagnosticLines, ...verificationLines];
    const successExitCode = ingestion.diagnostics.length > 0 || manifest.rejectedAccountCount > 0 ? 1 : 0;
    if (parsed.inspect) {
      return info(appendDiagnostics(inspectSummary(store, parsed.locale), resultLines), successExitCode);
    }
    if (manifest.entries.length === 0) {
      const noOutput = manifest.rejectedAccountCount > 0 ? parsed.locale === "zh" ? "\u6CA1\u6709\u901A\u8FC7 token \u9A8C\u8BC1\u7684\u53EF\u8F93\u51FA\u8D26\u53F7" : "No accounts passed token verification" : messages.errors.noApplicableFormats;
      return fail(1, [noOutput, ...resultLines]);
    }
    const outputRoot = path.resolve(cwd, parsed.outDir);
    const exportAccounts = accountsFromManifest(store, manifest);
    const zipName = parsed.zip ? zipDownloadName(exportAccounts) : void 0;
    if (parsed.dryRun) {
      return info(appendDiagnostics(dryRunSummary(
        manifest.accountCount,
        zipName ? [{ path: zipName, accountCount: manifest.accountCount }] : manifest.entries,
        outputRoot,
        parsed.locale
      ), resultLines), successExitCode);
    }
    if (parsed.stdout) {
      if (manifest.formats.length !== 1 || manifest.entries.length !== 1 || manifest.archive) {
        return fail(2, [messages.errors.stdoutSingleFile]);
      }
      const chunks = [];
      await streamExport(store, manifest, stdoutSink(io, chunks), {
        signal: abortController.signal,
        allowSyntheticIdToken: parsed.allowSyntheticIdToken,
        includeRefreshToken: parsed.includeRefreshToken
      });
      return {
        exitCode: successExitCode,
        stdout: io.writeStdout ? "" : new TextDecoder().decode(concatBytes(chunks)),
        stderr: appendDiagnostics(
          humanSummary(manifest.accountCount, manifest.entries.length, manifest.formats, void 0, parsed.locale),
          resultLines
        )
      };
    }
    if (zipName) {
      const targetPath = path.join(outputRoot, zipName);
      if (!parsed.force) {
        await assertTargetAvailable(targetPath, parsed.locale);
      }
      await mkdir(outputRoot, { recursive: true, mode: 448 });
      await streamExport(store, manifest, fileSink(outputRoot, targetPath, parsed.force), {
        signal: abortController.signal,
        allowSyntheticIdToken: parsed.allowSyntheticIdToken,
        includeRefreshToken: parsed.includeRefreshToken,
        onProgress: exportProgressReporter(io, parsed.locale)
      });
      finishProgress(io);
      return {
        exitCode: successExitCode,
        stdout: "",
        stderr: appendDiagnostics(
          fileSummary(manifest.accountCount, manifest.formats, targetPath, parsed.locale),
          resultLines
        )
      };
    }
    if (!parsed.force) {
      await assertTargetsAvailable(outputRoot, manifest, parsed.locale);
    }
    await streamExport(store, manifest, fileSink(outputRoot, void 0, parsed.force), {
      signal: abortController.signal,
      allowSyntheticIdToken: parsed.allowSyntheticIdToken,
      includeRefreshToken: parsed.includeRefreshToken,
      onProgress: exportProgressReporter(io, parsed.locale)
    });
    finishProgress(io);
    const singleTargetPath = manifest.entries.length === 1 ? path.join(outputRoot, manifest.entries[0].path) : void 0;
    return {
      exitCode: successExitCode,
      stdout: "",
      stderr: appendDiagnostics(
        singleTargetPath ? fileSummary(manifest.accountCount, manifest.formats, singleTargetPath, parsed.locale) : humanSummary(manifest.accountCount, manifest.entries.length, manifest.formats, outputRoot, parsed.locale),
        resultLines
      )
    };
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      return fail(130, [locale === "zh" ? "\u64CD\u4F5C\u5DF2\u53D6\u6D88" : "Operation cancelled"]);
    }
    if (error instanceof CliError) {
      return fail(error.exitCode, [error.message]);
    }
    if (isNodeIoError(error)) {
      return fail(3, [nodeIoMessage(error, locale)]);
    }
    const msg = error instanceof Error ? process.env.DEBUG ? error.stack ?? error.message : error.message : String(error);
    return fail(2, [msg]);
  } finally {
    stopSignalHandling();
    finishProgress(io);
  }
}
function currentWorkingDirectory(locale) {
  try {
    return process.cwd();
  } catch (error) {
    if (isNodeIoError(error) && error.code === "ENOENT") {
      throw new CliError(3, messagesFor(locale).cli.errors.cwdMissing);
    }
    throw error;
  }
}
function parseArgs(args, locale) {
  const messages = messagesFor(locale).cli;
  const parsed = {
    inputPaths: [],
    stdin: false,
    formatValues: [],
    outDir: "output",
    outDirSpecified: false,
    outputModes: {},
    textMode: "json",
    stdout: false,
    zip: false,
    allowSyntheticIdToken: true,
    includeRefreshToken: true,
    verifyTokens: true,
    locale,
    inspect: false,
    dryRun: false,
    force: false,
    serve: false,
    serveHost: "127.0.0.1",
    servePort: 8787,
    serveListenSpecified: false,
    help: false,
    version: false
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    switch (arg) {
      case "-i":
      case "--input":
        index += 1;
        addInputPath(parsed, requireValue(args, index, arg, locale), arg);
        break;
      case "-f":
      case "--format":
        index += 1;
        parsed.formatValues.push(requireValue(args, index, arg, locale));
        break;
      case "-o":
      case "--out-dir":
        index += 1;
        parsed.outDir = requireValue(args, index, arg, locale);
        parsed.outDirSpecified = true;
        break;
      case "--mode":
        index += 1;
        setOutputMode(parsed, requireValue(args, index, arg, locale));
        break;
      case "--stdout":
        parsed.stdout = true;
        break;
      case "--zip":
        parsed.zip = true;
        break;
      case "--no-fake-id":
        parsed.allowSyntheticIdToken = false;
        break;
      case "--no-refresh-token":
        parsed.includeRefreshToken = false;
        break;
      case "--no-verify-token":
        parsed.verifyTokens = false;
        break;
      case "--stdin":
        setStdinInput(parsed);
        break;
      case "--lang":
        index += 1;
        parsed.locale = requireLocale(requireValue(args, index, arg, locale), locale);
        break;
      case "--inspect":
        parsed.inspect = true;
        break;
      case "--dry-run":
        parsed.dryRun = true;
        break;
      case "--force":
        parsed.force = true;
        break;
      case "--serve":
        parsed.serve = true;
        break;
      case "--listen": {
        index += 1;
        const listen = parseListen(requireValue(args, index, arg, locale), locale);
        parsed.serveHost = listen.host;
        parsed.servePort = listen.port;
        parsed.serveListenSpecified = true;
        break;
      }
      case "--jsonl":
        parsed.textMode = "jsonl";
        break;
      case "--help":
        parsed.help = true;
        break;
      case "--version":
        parsed.version = true;
        break;
      default:
        if (arg.startsWith("--lang=")) {
          parsed.locale = requireLocale(arg.slice("--lang=".length), locale);
          break;
        }
        if (arg.startsWith("--listen=")) {
          const listen = parseListen(arg.slice("--listen=".length), locale);
          parsed.serveHost = listen.host;
          parsed.servePort = listen.port;
          parsed.serveListenSpecified = true;
          break;
        }
        if (!arg.startsWith("-")) {
          addInputPath(parsed, arg, messages.inputPathSource);
          break;
        }
        throw new Error(messages.errors.unknownArg(arg));
    }
  }
  return parsed;
}
function validateParsedArgs(parsed) {
  const messages = messagesFor(parsed.locale).cli;
  if (parsed.serve) {
    const hasConversionOption = parsed.inputPaths.length > 0 || parsed.stdin || parsed.formatValues.length > 0 || parsed.outDirSpecified || parsed.stdout || parsed.zip || parsed.inspect || parsed.dryRun || parsed.force || parsed.textMode !== "json" || !parsed.allowSyntheticIdToken || !parsed.includeRefreshToken || !parsed.verifyTokens || Object.keys(parsed.outputModes).length > 0;
    if (hasConversionOption) {
      throw new CliError(2, messages.errors.serveConflict);
    }
    return;
  }
  if (parsed.serveListenSpecified && !parsed.serve) {
    throw new CliError(2, messages.errors.serveOptionWithoutServe);
  }
  if (parsed.inspect && (parsed.stdout || parsed.outDirSpecified || parsed.zip)) {
    throw new CliError(2, messages.errors.inspectTargetConflict);
  }
  if (parsed.inspect && parsed.dryRun) {
    throw new CliError(2, messages.errors.inspectDryRunConflict);
  }
  if (parsed.dryRun && parsed.stdout) {
    throw new CliError(2, messages.errors.dryRunStdoutConflict);
  }
  if (parsed.zip && parsed.stdout) {
    throw new CliError(2, messages.errors.zipStdoutConflict);
  }
  if (parsed.inputPaths.length === 0 && !parsed.stdin) {
    throw new CliError(2, messages.errors.missingInput);
  }
}
function setOutputMode(parsed, value) {
  const messages = messagesFor(parsed.locale).cli;
  const [format, mode2, extra] = value.split("=");
  if (!format || !mode2 || extra !== void 0) {
    throw new CliError(2, messages.errors.invalidModeSyntax(value));
  }
  if (!isOutputFormat(format)) {
    throw new CliError(2, messages.errors.unknownOutputFormat(format));
  }
  if (!isConfigurableOutputFormat(format)) {
    throw new CliError(2, messages.errors.unsupportedModeFormat(format));
  }
  if (!isOutputMode(mode2)) {
    throw new CliError(2, messages.errors.unknownOutputMode(mode2));
  }
  parsed.outputModes[format] = mode2;
}
function addInputPath(parsed, inputPath, source) {
  if (parsed.stdin) {
    throw new Error(messagesFor(parsed.locale).cli.errors.stdinConflict(source));
  }
  parsed.inputPaths.push(inputPath);
}
function setStdinInput(parsed) {
  if (parsed.inputPaths.length > 0) {
    throw new Error(messagesFor(parsed.locale).cli.errors.stdinPathConflict);
  }
  parsed.stdin = true;
}
function requireValue(args, index, flag, locale) {
  const value = args[index];
  if (!value || value.startsWith("-")) {
    throw new Error(messagesFor(locale).cli.errors.missingFlagValue(flag));
  }
  return value;
}
function scanLocaleArg(args) {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--lang") {
      return args[index + 1];
    }
    if (arg.startsWith("--lang=")) {
      return arg.slice("--lang=".length);
    }
  }
  return void 0;
}
function requireLocale(value, messageLocale) {
  const locale = normalizeLocale(value);
  if (!locale) {
    throw new Error(messagesFor(messageLocale).cli.errors.invalidLang(value));
  }
  return locale;
}
function parseListen(value, locale) {
  const trimmed = value.trim();
  const bracketMatch = trimmed.match(/^\[([^\]]+)\]:(\d+)$/);
  if (bracketMatch) {
    return {
      host: bracketMatch[1],
      port: requirePort(bracketMatch[2], locale)
    };
  }
  const separatorIndex = trimmed.lastIndexOf(":");
  if (separatorIndex <= 0 || separatorIndex === trimmed.length - 1) {
    throw new Error(messagesFor(locale).cli.errors.invalidListen(value));
  }
  return {
    host: trimmed.slice(0, separatorIndex),
    port: requirePort(trimmed.slice(separatorIndex + 1), locale)
  };
}
function requirePort(value, locale) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(messagesFor(locale).cli.errors.invalidPort(value));
  }
  return port;
}
async function startWebUiServer(options = {}) {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 8787;
  const indexPath = options.indexPath ?? defaultWebUiIndexPath();
  const server = createServer(async (request, response) => {
    const pathname = request.url ? new URL(request.url, "http://authconv.local").pathname : "/";
    if (request.method !== "GET" && request.method !== "HEAD") {
      writePlainResponse(response, 405, "Method Not Allowed");
      return;
    }
    if (pathname !== "/" && pathname !== "/index.html") {
      writePlainResponse(response, 404, "Not Found");
      return;
    }
    try {
      const html = await readFile(indexPath, "utf8");
      response.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store"
      });
      response.end(request.method === "HEAD" ? void 0 : html);
    } catch (error) {
      writePlainResponse(response, 500, error instanceof Error ? error.message : String(error));
    }
  });
  await new Promise((resolve, reject) => {
    const onError = (error) => {
      reject(error);
    };
    server.once("error", onError);
    server.listen(port, host, () => {
      server.off("error", onError);
      resolve();
    });
  });
  const actualPort = serverPort(server) ?? port;
  return {
    host,
    port: actualPort,
    url: `http://${urlHost(host)}:${actualPort}/`,
    close: () => closeServer(server)
  };
}
function defaultWebUiIndexPath() {
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  return path.join(scriptDir, "index.html");
}
function serverPort(server) {
  const address = server.address();
  return typeof address === "object" && address ? address.port : void 0;
}
function urlHost(host) {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}
function writePlainResponse(response, status, body) {
  response.writeHead(status, {
    "content-type": "text/plain; charset=utf-8",
    "cache-control": "no-store"
  });
  response.end(`${body}
`);
}
function closeServer(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}
async function discoverInputSources(inputPaths, useStdin, locale, io, signal) {
  if (useStdin) {
    return [{
      name: "stdin",
      path: "stdin",
      chunks: io.stdin !== void 0 ? textChunks(io.stdin) : processStdinChunks(signal)
    }];
  }
  const discovered = [];
  for (const inputPath of inputPaths) {
    throwIfAborted5(signal);
    const inputStat = await stat(inputPath);
    throwIfAborted5(signal);
    if (inputStat.isDirectory()) {
      const files = await discoverDirectoryFiles(inputPath, signal);
      if (files.length === 0) {
        throw new CliError(3, messagesFor(locale).cli.errors.noInputFiles(inputPath));
      }
      for (const file of files) discovered.push(file);
      continue;
    }
    if (!inputStat.isFile()) {
      throw new CliError(3, messagesFor(locale).cli.errors.notFileOrDirectory(inputPath));
    }
    discovered.push(inputPath);
  }
  return discovered.map((sourcePath) => {
    const content = fileChunkSource(sourcePath, signal);
    return {
      name: path.basename(sourcePath),
      path: sourcePath,
      ...content
    };
  });
}
async function discoverDirectoryFiles(directory, signal) {
  throwIfAborted5(signal);
  const files = [];
  const entries = await readdir(directory, { withFileTypes: true });
  throwIfAborted5(signal);
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    throwIfAborted5(signal);
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      const nestedFiles = await discoverDirectoryFiles(entryPath, signal);
      for (const file of nestedFiles) files.push(file);
    } else if (entry.isFile()) {
      files.push(entryPath);
    }
  }
  return files;
}
function fileChunkSource(sourcePath, signal) {
  let stream;
  let cancelled = false;
  let cancelReason;
  return {
    chunks: (async function* () {
      const current = createReadStream(sourcePath);
      stream = current;
      const abort2 = () => current.destroy(abortError(signal));
      signal.addEventListener("abort", abort2, { once: true });
      try {
        if (cancelled) current.destroy(asError(cancelReason));
        for await (const chunk of current) {
          if (signal.aborted) throw abortError(signal);
          if (cancelled) return;
          yield typeof chunk === "string" ? new TextEncoder().encode(chunk) : new Uint8Array(chunk);
        }
      } finally {
        signal.removeEventListener("abort", abort2);
        current.destroy();
        if (stream === current) stream = void 0;
      }
    })(),
    cancel(reason) {
      cancelled = true;
      cancelReason = reason;
      stream?.destroy(asError(reason));
    }
  };
}
async function* textChunks(text) {
  yield new TextEncoder().encode(text);
}
async function* processStdinChunks(signal) {
  const abort2 = () => process.stdin.destroy(abortError(signal));
  signal.addEventListener("abort", abort2, { once: true });
  try {
    for await (const chunk of process.stdin) {
      if (signal.aborted) throw abortError(signal);
      yield typeof chunk === "string" ? new TextEncoder().encode(chunk) : new Uint8Array(chunk);
    }
  } finally {
    signal.removeEventListener("abort", abort2);
  }
}
function abortError(signal) {
  return signal.reason instanceof Error ? signal.reason : new DOMException("Aborted", "AbortError");
}
function throwIfAborted5(signal) {
  if (signal.aborted) throw abortError(signal);
}
function asError(reason) {
  return reason instanceof Error ? reason : new Error(String(reason ?? "Cancelled"));
}
function resolveFormats(values, locale) {
  if (values.length > 0) {
    return parseFormatList(values, {
      invalidFormatMessage: messagesFor(locale).cli.errors.unknownOutputFormat
    });
  }
  return parseFormatList(["all"], {
    invalidFormatMessage: messagesFor(locale).cli.errors.unknownOutputFormat
  });
}
function humanSummary(accountCount, fileCount, formats, outputRoot, locale) {
  const messages = messagesFor(locale).cli.summary;
  const formatLabels = formats.map((f) => FORMAT_LABELS[f]).join("/");
  return `${messages.human(accountCount, fileCount, formats.length, formatLabels, outputRoot)}
`;
}
function fileSummary(accountCount, formats, targetPath, locale) {
  const messages = messagesFor(locale).cli.summary;
  const formatLabels = formats.map((f) => FORMAT_LABELS[f]).join("/");
  return `${messages.humanFile(accountCount, formats.length, formatLabels, targetPath)}
`;
}
function appendDiagnostics(summary, diagnostics) {
  if (diagnostics.length === 0) {
    return summary;
  }
  const prefix = summary.endsWith("\n") ? summary : `${summary}
`;
  return `${prefix}${diagnostics.join("\n")}
`;
}
function inspectSummary(store, locale) {
  const messages = messagesFor(locale).cli.summary;
  const header = [...messages.inspectColumns, locale === "zh" ? "\u9A8C\u771F" : "Verification"];
  const rows = [...store.values()].map((account, index) => {
    const openAi = account.provider === "openai" ? account : void 0;
    return [
      String(index + 1),
      account.email ?? account.name ?? openAi?.chatgptAccountId ?? openAi?.accountId ?? account.userId ?? messages.unknownAccount,
      openAi?.accountId ?? openAi?.chatgptAccountId ?? messages.missingValue,
      openAi?.planType ?? messages.missingValue,
      displayDate(account.expiresAt),
      verificationDisplay(
        account.tokenVerification?.status,
        account.tokenVerification?.reason,
        account.tokenVerification?.notBeforeActive,
        locale
      )
    ];
  });
  const widths = header.map((cell) => cell.length);
  for (const row of rows) {
    for (let col = 0; col < row.length; col += 1) {
      widths[col] = Math.max(widths[col], row[col].length);
    }
  }
  const formatRow = (cells) => cells.map((cell, col) => cell.padEnd(widths[col], " ")).join("  ").trimEnd();
  const counts = store.summary().verificationCounts;
  const verificationLine = locale === "zh" ? `\u9A8C\u771F\u7EDF\u8BA1\uFF1A\u771F\u5B9E ${counts.verified}\uFF0C\u4F2A\u9020 ${counts.forged}\uFF0C\u4E0D\u53EF\u9A8C\u8BC1 ${counts.unverifiable}\uFF0C\u672A\u68C0\u67E5 ${counts.unchecked}` : `Verification: ${counts.verified} verified, ${counts.forged} forged, ${counts.unverifiable} unverifiable, ${counts.unchecked} unchecked`;
  const lines = [formatRow(header), ...rows.map(formatRow), verificationLine];
  return `${lines.join("\n")}
`;
}
function verificationRejectionLines(manifest, locale) {
  if (manifest.rejectedAccountCount === 0) return [];
  const details = Object.entries(manifest.rejectionReasons).filter((entry) => typeof entry[1] === "number").map(([reason, count]) => `${verificationReasonLabel(reason, locale)}: ${count}`).join(locale === "zh" ? "\uFF0C" : ", ");
  const prefix = locale === "zh" ? `token \u9A8C\u8BC1\u62D2\u7EDD ${manifest.rejectedAccountCount} \u4E2A\u8D26\u53F7` : `Token verification rejected ${manifest.rejectedAccountCount} account${manifest.rejectedAccountCount === 1 ? "" : "s"}`;
  return [`${prefix}${details ? `: ${details}` : ""}`];
}
function verificationDisplay(status, reason, notBeforeActive, locale) {
  if (!status || !reason) return locale === "zh" ? "\u7F3A\u5931" : "missing";
  const statusLabels = {
    verified: ["\u771F\u5B9E", "verified"],
    forged: ["\u4F2A\u9020", "forged"],
    unverifiable: ["\u4E0D\u53EF\u9A8C\u8BC1", "unverifiable"],
    unchecked: ["\u672A\u68C0\u67E5", "unchecked"]
  };
  const notBefore = notBeforeActive ? locale === "zh" ? "\uFF0C\u5C1A\u672A\u751F\u6548" : ", not active yet" : "";
  return `${statusLabels[status][locale === "zh" ? 0 : 1]} (${verificationReasonLabel(reason, locale)}${notBefore})`;
}
function verificationReasonLabel(reason, locale) {
  const labels = {
    signature_valid: ["\u7B7E\u540D\u6709\u6548", "valid signature"],
    malformed_jwt: ["JWT \u683C\u5F0F\u635F\u574F", "malformed JWT"],
    algorithm_rejected: ["\u7B97\u6CD5\u4E0D\u5141\u8BB8", "rejected algorithm"],
    signature_failed: ["\u7B7E\u540D\u5931\u8D25", "signature failed"],
    issuer_mismatch: ["issuer \u4E0D\u5339\u914D", "issuer mismatch"],
    audience_mismatch: ["audience \u4E0D\u5339\u914D", "audience mismatch"],
    token_type_mismatch: ["token \u7C7B\u578B\u4E0D\u5339\u914D", "token type mismatch"],
    missing_access_token: ["\u7F3A\u5C11 access token", "missing access token"],
    opaque_access_token: ["opaque access token", "opaque access token"],
    unknown_kid: ["\u672A\u77E5 kid", "unknown kid"],
    unknown_provider: ["\u672A\u77E5\u5E73\u53F0", "unknown provider"],
    user_disabled: ["\u7528\u6237\u5173\u95ED\u9A8C\u8BC1", "verification disabled"],
    verification_missing: ["\u7F3A\u5C11\u9A8C\u771F\u7ED3\u679C", "missing verification result"]
  };
  return labels[reason][locale === "zh" ? 0 : 1];
}
function accountsFromManifest(store, manifest) {
  const accounts = [];
  const seen = /* @__PURE__ */ new Set();
  for (const entry of manifest.entries) {
    for (const id of entry.accountIds) {
      if (seen.has(id)) continue;
      seen.add(id);
      const account = store.get(id);
      if (account) accounts.push(account);
    }
  }
  return accounts;
}
function dryRunSummary(accountCount, files, outputRoot, locale) {
  const messages = messagesFor(locale).cli.summary;
  const lines = [messages.dryRun(accountCount, files.length, outputRoot)];
  if (files.length === 1) {
    const [file] = files;
    lines.push(messages.fileLine(file.path, file.accountCount));
  }
  return `${lines.join("\n")}
`;
}
async function assertTargetsAvailable(outputRoot, manifest, locale) {
  for (const entry of manifest.entries) {
    await assertTargetAvailable(path.join(outputRoot, entry.path), locale);
  }
}
async function assertTargetAvailable(targetPath, locale) {
  const messages = messagesFor(locale).cli;
  if (await pathExists(targetPath)) {
    throw new CliError(3, messages.errors.alreadyExists(targetPath));
  }
}
async function pathExists(targetPath) {
  try {
    await stat(targetPath);
    return true;
  } catch (error) {
    if (isNodeIoError(error) && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}
function fileSink(outputRoot, archivePath, force) {
  return {
    openFile: async (relativePath) => openFileWriter(path.join(outputRoot, relativePath), force),
    openArchive: async () => {
      if (!archivePath) throw new Error("Archive target is not configured");
      return openFileWriter(archivePath, force);
    }
  };
}
async function openFileWriter(targetPath, force) {
  await mkdir(path.dirname(targetPath), { recursive: true, mode: 448 });
  const handle = await open(targetPath, force ? "w" : "wx", 384);
  return createFileWriter(handle);
}
function createFileWriter(handle) {
  let position = 0;
  let closed = false;
  const close = async () => {
    if (closed) return;
    await handle.close();
    closed = true;
  };
  return {
    write: async (chunk) => {
      let offset = 0;
      while (offset < chunk.length) {
        const result = await handle.write(chunk, offset, chunk.length - offset, position);
        offset += result.bytesWritten;
        position += result.bytesWritten;
      }
    },
    close,
    abort: close
  };
}
function stdoutSink(io, collected) {
  const writer = {
    write: async (chunk) => {
      if (io.writeStdout) await io.writeStdout(chunk);
      else collected.push(chunk.slice());
    },
    close: () => void 0,
    abort: () => void 0
  };
  return {
    openFile: async () => writer,
    openArchive: async () => writer
  };
}
function concatBytes(chunks) {
  const bytes = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}
function progressReporter(io, locale) {
  let last = 0;
  let lastPhase;
  return (progress) => {
    if (!io.stderrIsTTY || !io.writeStderr) return;
    const now = Date.now();
    if (now - last < 100 && progress.phase === lastPhase) return;
    last = now;
    lastPhase = progress.phase;
    if (progress.phase === "verify") {
      const label2 = locale === "zh" ? "\u9A8C\u771F" : "Verify";
      io.writeStderr(`\r${label2}: ${progress.verifiedCandidates}/${progress.processedCandidates}`);
      return;
    }
    const label = locale === "zh" ? "\u5BFC\u5165" : "Import";
    io.writeStderr(`\r${label}: ${progress.processedCandidates} / ${progress.storedAccounts}`);
  };
}
function exportProgressReporter(io, locale) {
  let last = 0;
  return (progress) => {
    if (!io.stderrIsTTY || !io.writeStderr) return;
    const now = Date.now();
    if (now - last < 100 && progress.completedEntries < progress.totalEntries) return;
    last = now;
    const label = locale === "zh" ? "\u5BFC\u51FA" : "Export";
    io.writeStderr(`\r${label}: ${progress.completedEntries}/${progress.totalEntries} (${progress.completedAccounts})`);
  };
}
function finishProgress(io) {
  if (io.stderrIsTTY && io.writeStderr) io.writeStderr("\r\x1B[2K");
}
function diagnosticMessage(diagnostic, locale) {
  const position = diagnostic.line ? `${locale === "zh" ? "\u7B2C" : "line "}${diagnostic.line}${locale === "zh" ? " \u884C" : ""}` : "";
  const label = {
    json_parse_failed: ["JSON \u89E3\u6790\u5931\u8D25", "JSON parse failed"],
    zip_read_failed: ["ZIP \u89E3\u538B\u5931\u8D25", "ZIP extraction failed"],
    input_format_mismatch: ["\u8F93\u5165\u683C\u5F0F\u4E0D\u5339\u914D", "Input format mismatch"],
    no_credential_tokens: ["\u6CA1\u6709\u53EF\u7528\u51ED\u8BC1\u5B57\u6BB5", "No credential tokens"],
    unsupported_input: ["\u4E0D\u652F\u6301\u7684\u8F93\u5165", "Unsupported input"]
  };
  const text = label[diagnostic.code][locale === "zh" ? 0 : 1];
  return [diagnostic.sourceName, position, text, diagnostic.detail].filter(Boolean).join(": ");
}
function displayDate(value) {
  return value?.slice(0, 10) || "\u2014";
}
function isOutputMode(value) {
  return value === "merged" || value === "single";
}
function isNodeIoError(error) {
  return error instanceof Error && "code" in error && typeof error.code === "string";
}
function nodeIoMessage(error, locale) {
  const target = error.path ? String(error.path) : "IO";
  if (error.code === "ENOENT") {
    return messagesFor(locale).cli.errors.notFound(target);
  }
  return error.message;
}
function fail(exitCode, messages) {
  return {
    exitCode,
    stdout: "",
    stderr: `${messages.join("\n")}
`
  };
}
function info(stderr, exitCode = 0) {
  return {
    exitCode,
    stdout: "",
    stderr
  };
}
function helpText(locale) {
  return messagesFor(locale).cli.help(VERSION);
}
function isMain() {
  if (!process.argv[1]) {
    return false;
  }
  const scriptPath = fileURLToPath(import.meta.url);
  const calledPath = path.resolve(process.argv[1]);
  let realCalled;
  try {
    realCalled = realpathSync(calledPath);
  } catch {
    realCalled = calledPath;
  }
  return scriptPath === calledPath || scriptPath === realCalled;
}
if (isMain()) {
  const result = await runCli(process.argv.slice(2), {
    writeStdout: (chunk) => writeStreamChunk(process.stdout, chunk),
    writeStderr: (text) => process.stderr.write(text),
    stderrIsTTY: process.stderr.isTTY,
    handleSignals: true
  });
  if (result.stdout) {
    process.stdout.write(result.stdout);
  }
  if (result.stderr) {
    process.stderr.write(result.stderr);
  }
  process.exitCode = result.exitCode;
}
function writeStreamChunk(stream, chunk) {
  if (stream.write(chunk)) return;
  return new Promise((resolve, reject) => {
    const onDrain = () => {
      stream.off("error", onError);
      resolve();
    };
    const onError = (error) => {
      stream.off("drain", onDrain);
      reject(error);
    };
    stream.once("drain", onDrain);
    stream.once("error", onError);
  });
}
export {
  createFileWriter,
  discoverDirectoryFiles,
  runCli,
  startWebUiServer,
  writeStreamChunk
};
