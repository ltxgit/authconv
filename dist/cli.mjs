#!/usr/bin/env node

// src/cli.ts
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { existsSync, realpathSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

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

// src/renderers.ts
function renderFormat(accounts, format, options = {}) {
  switch (format) {
    case "cpa":
      return accounts.length === 1 ? renderCpaAccount(accounts[0], options) : accounts.map((account) => renderCpaAccount(account, options));
    case "codex2api":
      return accounts.map((account) => renderCodex2ApiAccount(account, options));
    case "sub2api":
      return renderSub2Api(accounts, options);
    case "codexmanager":
      return accounts.length === 1 ? renderCodexManagerAccount(accounts[0], options) : accounts.map((account) => renderCodexManagerAccount(account, options));
    case "codex":
      return accounts.length === 1 ? renderCodexAuth(accounts[0], options) : accounts.map((account) => renderCodexAuth(account, options));
  }
}
function renderCpaAccount(account, options) {
  const allowSynthetic = options.allowSyntheticIdToken !== false;
  const rendered = {
    type: "codex",
    email: account.email ?? "",
    account_id: account.accountId ?? "",
    plan_type: account.planType ?? "",
    id_token: allowSynthetic ? account.idToken ?? "" : account.idTokenSynthetic ? "" : account.idToken ?? "",
    access_token: account.accessToken ?? "",
    refresh_token: account.refreshToken ?? "",
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
function renderCodex2ApiAccount(account, options) {
  const allowSynthetic = options.allowSyntheticIdToken !== false;
  return compactObject({
    name: account.name ?? account.email ?? account.chatgptAccountId ?? account.accountId,
    email: account.email,
    refresh_token: account.refreshToken,
    session_token: account.sessionToken,
    access_token: account.accessToken,
    id_token: allowSynthetic ? account.idToken : account.idTokenSynthetic ? void 0 : account.idToken,
    account_id: account.accountId,
    chatgpt_account_id: account.chatgptAccountId,
    plan_type: account.planType,
    expires_at: account.expiresAt
  });
}
function renderSub2Api(accounts, options) {
  return {
    type: "sub2api-data",
    version: 1,
    exported_at: (options.now ?? /* @__PURE__ */ new Date()).toISOString(),
    proxies: [],
    accounts: accounts.map((account) => renderSub2ApiAccount(account, options))
  };
}
function renderSub2ApiAccount(account, options) {
  const allowSynthetic = options.allowSyntheticIdToken !== false;
  const credentials = compactObject({
    access_token: account.accessToken,
    refresh_token: account.refreshToken,
    session_token: account.sessionToken,
    id_token: allowSynthetic ? account.idToken : account.idTokenSynthetic ? void 0 : account.idToken,
    expires_at: account.expiresAt,
    email: account.email,
    chatgpt_account_id: account.chatgptAccountId,
    chatgpt_user_id: account.chatgptUserId,
    plan_type: account.planType
  });
  const extra = compactObject({
    import_source: "authconv",
    id_token_synthetic: account.idTokenSynthetic && allowSynthetic ? true : void 0
  });
  return compactObject({
    name: account.name ?? account.email ?? account.chatgptAccountId ?? account.accountId ?? "authconv-account",
    platform: "openai",
    type: "oauth",
    credentials,
    extra,
    priority: 50,
    concurrency: 3,
    auto_pause_on_expired: true
  });
}
function renderCodexManagerAccount(account, options) {
  const allowSynthetic = options.allowSyntheticIdToken !== false;
  return {
    tokens: compactObject({
      access_token: account.accessToken,
      refresh_token: account.refreshToken,
      id_token: allowSynthetic ? account.idToken : account.idTokenSynthetic ? void 0 : account.idToken,
      account_id: account.accountId,
      chatgpt_account_id: account.chatgptAccountId
    }),
    meta: compactObject({
      label: account.name ?? account.email ?? account.chatgptAccountId ?? account.accountId,
      issuer: account.issuer ?? "https://auth.openai.com",
      workspace_id: account.workspaceId,
      chatgpt_account_id: account.chatgptAccountId,
      tags: ["authconv"]
    })
  };
}
function renderCodexAuth(account, options) {
  const allowSynthetic = options.allowSyntheticIdToken !== false;
  return {
    auth_mode: "chatgpt",
    OPENAI_API_KEY: null,
    tokens: {
      id_token: allowSynthetic ? account.idToken ?? "" : account.idTokenSynthetic ? "" : account.idToken ?? "",
      access_token: account.accessToken ?? "",
      refresh_token: account.refreshToken ?? "",
      account_id: account.accountId ?? account.chatgptAccountId ?? ""
    },
    last_refresh: account.lastRefresh ?? (options.now ?? /* @__PURE__ */ new Date()).toISOString()
  };
}

// src/file-plan.ts
var MERGED_FORMATS = /* @__PURE__ */ new Set(["sub2api", "codex2api"]);
var FORMAT_FILE_PREFIX = {
  cpa: "cpa",
  sub2api: "sub2api",
  codex2api: "codex2api",
  codexmanager: "codex-manager",
  codex: "codex"
};
function buildOutputPlan(accounts, formats, options = {}) {
  const used = /* @__PURE__ */ new Map();
  const files = [];
  const useFormatFolders = formats.length > 1;
  for (const format of formats) {
    const prefix = useFormatFolders ? `${format}/` : "";
    if (MERGED_FORMATS.has(format) && options.outputModes?.[format] !== "single") {
      const name = accounts.length === 1 ? singleAccountName(format, accounts[0]) : mergedName(format, accounts.length, "json");
      files.push({
        path: uniquePath(`${prefix}${name}`, used),
        format,
        content: renderFormat(accounts, format, options),
        accountCount: accounts.length
      });
      continue;
    }
    accounts.forEach((account) => {
      files.push({
        path: uniquePath(`${prefix}${singleAccountName(format, account)}`, used),
        format,
        content: renderFormat([account], format, options),
        accountCount: 1
      });
    });
  }
  return files;
}
function outputFileText(file) {
  return `${JSON.stringify(file.content, null, 2)}
`;
}
function serializeOutputFiles(files, mode = "json") {
  if (mode === "json") {
    return files.map((file) => ({
      path: file.path,
      format: file.format,
      text: outputFileText(file),
      accountCount: file.accountCount
    }));
  }
  const grouped = /* @__PURE__ */ new Map();
  for (const file of files) {
    grouped.set(file.format, [...grouped.get(file.format) ?? [], file]);
  }
  const used = /* @__PURE__ */ new Map();
  return [...grouped.entries()].map(([format, formatFiles]) => ({
    path: uniquePath(jsonlPath(formatFiles), used),
    format,
    text: `${formatFiles.map((file) => JSON.stringify(file.content)).join("\n")}
`,
    accountCount: formatFiles.reduce((sum, file) => sum + file.accountCount, 0)
  }));
}
function effectiveOutputModes(outputModes, outputTextMode) {
  if (outputTextMode !== "jsonl") {
    return outputModes;
  }
  return {
    ...outputModes,
    sub2api: "single",
    codex2api: "single"
  };
}
function jsonlPath(files) {
  const firstPath = files[0]?.path ?? "authconv.json";
  if (files.length === 1) {
    return replaceExtension(firstPath, ".jsonl");
  }
  const firstFile = files[0];
  const directory = firstPath.includes("/") ? `${firstPath.slice(0, firstPath.lastIndexOf("/") + 1)}` : "";
  const totalAccounts = files.reduce((sum, file) => sum + file.accountCount, 0);
  return `${directory}${mergedName(firstFile.format, totalAccounts, "jsonl")}`;
}
function replaceExtension(path2, nextExtension) {
  return path2.replace(/\.[^/.]+$/, nextExtension);
}
function singleAccountName(format, account) {
  const identity = safeFileSegment(account.email ?? account.name ?? "unknown");
  const accountId = account.chatgptAccountId ?? account.accountId;
  const idSegment = accountId ? safeFileSegment(accountId.slice(0, 12)) : "";
  return idSegment ? `${FORMAT_FILE_PREFIX[format]}_${identity}_${idSegment}.json` : `${FORMAT_FILE_PREFIX[format]}_${identity}.json`;
}
function mergedName(format, accountCount, extension) {
  const suffix = accountCount === 1 ? "account" : "accounts";
  return `${FORMAT_FILE_PREFIX[format]}_${accountCount}-${suffix}.${extension}`;
}
function safeFileSegment(value) {
  const safe = value.trim().replace(/[^\w\-.]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 96);
  return safe || "unknown";
}
function uniquePath(path2, used) {
  const count = used.get(path2) ?? 0;
  used.set(path2, count + 1);
  if (count === 0) {
    return path2;
  }
  const extension = path2.match(/\.[^/.]+$/)?.[0] ?? "";
  if (!extension) {
    return `${path2}-${count + 1}`;
  }
  return `${path2.slice(0, -extension.length)}-${count + 1}${extension}`;
}

// src/types.ts
var ALL_FORMATS = ["cpa", "sub2api", "codex2api", "codexmanager", "codex"];

// src/formats.ts
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

// src/i18n.ts
var DEFAULT_LOCALE = "en";
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
var INPUT_FORMAT_LABELS = {
  zh: {
    session: "ChatGPT Session",
    sub2api: "sub2api",
    cpa: "CPA",
    codexmanager: "Codex Manager",
    codex2api: "Codex2Api",
    codex: "Codex Auth",
    unknown: "\u672A\u77E5\u683C\u5F0F"
  },
  en: {
    session: "ChatGPT Session",
    sub2api: "sub2api",
    cpa: "CPA",
    codexmanager: "Codex Manager",
    codex2api: "Codex2Api",
    codex: "Codex Auth",
    unknown: "Unknown format"
  }
};
var FORMAT_LABELS = {
  cpa: "CPA",
  sub2api: "sub2api",
  codex2api: "codex2api",
  codexmanager: "Codex Manager",
  codex: "Codex Auth"
};
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
  <path...>              \u8F93\u5165 JSON \u6587\u4EF6\u6216\u76EE\u5F55\u8DEF\u5F84\uFF0C\u53EF\u4F20\u591A\u4E2A
  -i, --input <path>     \u6307\u5B9A\u8F93\u5165\u6587\u4EF6\u6216\u76EE\u5F55\uFF08\u53EF\u91CD\u590D\uFF09
  --stdin                \u4ECE\u6807\u51C6\u8F93\u5165\u8BFB\u53D6\uFF08\u4E0E -i \u4E92\u65A5\uFF09
  -f, --format <list>    \u8F93\u51FA\u683C\u5F0F\uFF0C\u652F\u6301\u9017\u53F7\u5206\u9694\u6216\u91CD\u590D\u4F20\u5165\uFF1B\u53EF\u7528 cpa/sub2api/codex2api/codexmanager/codex/all
  --mode <fmt>=<m>       sub2api/codex2api \u8F93\u51FA\u65B9\u5F0F\uFF1Amerged \u6216 single
  -o, --out-dir <path>   \u8F93\u51FA\u76EE\u5F55\uFF0C\u9ED8\u8BA4 output
  --jsonl                \u8F93\u51FA JSONL \u683C\u5F0F\uFF08\u6BCF\u8D26\u53F7\u4E00\u884C\uFF09
  --zip                  \u5199\u5165\u4E00\u4E2A ZIP \u6587\u4EF6\uFF0C\u538B\u7F29\u5305\u5185\u4FDD\u7559\u5F53\u524D\u8F93\u51FA\u76EE\u5F55\u7ED3\u6784
  --stdout               \u5355\u683C\u5F0F\u5355\u6587\u4EF6\u8F93\u51FA\u5230 stdout
  --no-fake-id           \u8F93\u51FA\u4E0D\u5305\u542B\u5408\u6210 id_token\uFF08\u9ED8\u8BA4\u4F1A\u8F93\u51FA\uFF09
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
        cwdMissing: "\u5F53\u524D\u76EE\u5F55\u4E0D\u5B58\u5728",
        unknownArg: (arg) => `\u672A\u77E5\u53C2\u6570: ${arg}`,
        missingInput: "\u672A\u6307\u5B9A\u8F93\u5165\uFF08\u9700\u8981 <path>\u3001-i \u6216 --stdin\uFF09",
        invalidModeSyntax: (value) => `--mode \u683C\u5F0F\u9519\u8BEF: ${value}\uFF08\u5E94\u4E3A format=merged|single\uFF09`,
        unknownOutputFormat: (format) => `\u672A\u77E5\u8F93\u51FA\u683C\u5F0F: ${format}`,
        unsupportedModeFormat: (format) => `--mode \u4EC5\u652F\u6301 sub2api \u6216 codex2api: ${format}`,
        unknownOutputMode: (mode) => `--mode \u5305\u542B\u672A\u77E5\u8F93\u51FA\u65B9\u5F0F: ${mode}`,
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
        human: (accountCount, fileCount, formats, outputRoot) => `\u8BC6\u522B ${accountCount} \u4E2A\u8D26\u53F7\uFF0C\u8F6C\u4E3A ${formats} \u683C\u5F0F\uFF0C\u5199\u5165 ${fileCount} \u4E2A\u6587\u4EF6${outputRoot ? `\u5230 ${outputRoot}` : ""}`,
        inspectColumns: ["#", "\u90AE\u7BB1", "account_id", "\u5957\u9910", "\u8FC7\u671F"],
        unknownAccount: "unknown",
        missingValue: "\u2014",
        dryRun: (accountCount, fileCount, outputRoot) => `\u8BC6\u522B ${accountCount} \u4E2A\u8D26\u53F7\uFF0C\u5C06\u5199\u5165 ${fileCount} \u4E2A\u6587\u4EF6\u5230 ${outputRoot}`,
        fileLine: (filePath, accountCount) => `- ${filePath} (${accountCount} \u4E2A\u8D26\u53F7)`,
        warning: "warning",
        groupedWarnings: (message, sources) => {
          const truncated = sources.slice(0, 3);
          const suffix = sources.length > 3 ? "..." : "";
          return `${message} (${sources.length}\u4E2A\u6587\u4EF6: ${truncated.join(", ")}${suffix})`;
        }
      }
    },
    normalize: {
      invalidInputFormat: (sourceName, inputFormat) => `${sourceName}: \u8F93\u5165\u4E0D\u7B26\u5408 ${inputFormat} \u8F93\u5165\u683C\u5F0F`,
      noTokens: (sourceName) => `${sourceName}: \u672A\u627E\u5230\u53EF\u8BC6\u522B token \u5B57\u6BB5`,
      invalidExpiry: (sourceName, value) => `${sourceName}: \u8FC7\u671F\u65F6\u95F4\u683C\u5F0F\u9519\u8BEF ("${value}")`,
      syntheticIdToken: (sourceName) => `${sourceName}: \u5DF2\u751F\u6210\u5408\u6210 id_token`,
      missingIdToken: (sourceName) => `${sourceName}: \u7F3A\u5C11 id_token`,
      missingRefreshToken: (sourceName) => `${sourceName}: \u7F3A\u5C11 refresh_token`,
      missingAccessToken: (sourceName) => `${sourceName}: \u7F3A\u5C11 access_token`,
      claimOverride: (sourceName, fields) => `${sourceName}: access_token claim \u4E0D\u4E00\u81F4\uFF0C\u8986\u76D6\u5B57\u6BB5: ${fields.join(",")}`,
      claimSanity: (sourceName, fields) => `${sourceName}: JWT claim \u6821\u9A8C\u5F02\u5E38: ${fields.join(",")}`
    },
    web: {
      pageTitle: "GPT Auth \u8F6C\u6362 | \u7EAF\u672C\u5730\u5B89\u5168\u51ED\u636E\u591A\u683C\u5F0F\u5904\u7406\u5DE5\u5177",
      appTitle: "GPT Auth \u8F6C\u6362",
      notice: "\u7EAF\u672C\u5730\u5B89\u5168\u8F6C\u6362\uFF0C\u6240\u6709\u8FD0\u7B97\u5728\u5F53\u524D\u6D4F\u89C8\u5668\u4E2D\u5B8C\u6210\u3002",
      dragTitle: "\u91CA\u653E\u4EE5\u5BFC\u5165 JSON / JSONL \u51ED\u636E",
      dragSub: "\u677E\u5F00\u6DFB\u52A0\u5230\u5217\u8868",
      themeLabel: "\u754C\u9762\u4E3B\u9898",
      themeAria: "\u5207\u6362\u548C\u9009\u62E9\u754C\u9762\u4E3B\u9898",
      themeSystem: "\u81EA\u52A8",
      themeLight: "\u6D45\u8272",
      themeDark: "\u6DF1\u8272",
      languageLabel: "\u754C\u9762\u8BED\u8A00",
      languageAria: "\u5207\u6362\u754C\u9762\u8BED\u8A00",
      inputTitle: "\u6570\u636E\u8F93\u5165",
      sessionButton: "\u83B7\u53D6 Session",
      addDraftButton: "\u52A0\u5165\u5217\u8868",
      clearButton: "\u6E05\u7A7A",
      inputAria: "JSON \u51ED\u636E\u8F93\u5165",
      inputPlaceholder: `\u8BF7\u5728\u6B64\u5904\u76F4\u63A5\u7C98\u8D34 ChatGPT /api/auth/session JSON \u54CD\u5E94\u3001Codex auth.json\u3001JSONL \u6587\u672C\uFF0C\u6216\u8005\u4ECE\u4E0B\u65B9\u62D6\u5165\u591A\u8D26\u53F7 JSON \u5BFC\u51FA\u914D\u7F6E...

\u4F8B\u5982\uFF1A
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
      inputFormatAria: "\u8F93\u5165\u683C\u5F0F",
      dropZoneAria: "\u9009\u62E9\u6216\u62D6\u653E JSON \u51ED\u636E\u6587\u4EF6\u6216\u6587\u4EF6\u5939",
      dropTitle: "\u9009\u62E9\u6216\u62D6\u653E .json / .jsonl \u51ED\u636E\u6587\u4EF6",
      dropSub: "\u62D6\u5165\u6587\u4EF6\u6216\u6587\u4EF6\u5939",
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
      accountTitle: "\u5DF2\u52A0\u8F7D\u8D26\u53F7",
      clearAccounts: "\u6E05\u7A7A\u5217\u8868",
      accountColumns: ["\u8D26\u53F7\u6807\u8BC6 (Email / ID)", "\u5957\u9910\u72B6\u6001", "\u8FC7\u671F\u65F6\u95F4", "\u64CD\u4F5C"],
      accountListAria: "\u8D26\u53F7\u5217\u8868",
      previewAria: "\u8F93\u51FA\u9884\u89C8",
      previewTabsAria: "\u9884\u89C8\u683C\u5F0F\u9009\u62E9",
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
      sourceImported: (count) => `\u6210\u529F\u52A0\u5165 ${count} \u4E2A\u8D26\u53F7`,
      fileImported: (count) => `\u6210\u529F\u5BFC\u5165 ${count} \u4E2A\u8D26\u53F7`,
      chooseJsonFile: "\u8BF7\u9009\u62E9 .json \u6216 .jsonl \u6587\u4EF6\u3002",
      fileNoAccounts: (name) => `${name}: \u672A\u8BC6\u522B\u5230\u53EF\u8F6C\u6362\u8D26\u53F7\u3002`,
      fileInvalidInput: (name, error) => `${name}: ${error}`,
      fileJsonFailed: (name, error) => `JSON \u89E3\u6790\u5931\u8D25\uFF08${name}\uFF09\uFF1A${error}`,
      fileReadFailed: (error) => `\u6587\u4EF6\u8BFB\u53D6\u5931\u8D25\uFF1A${error}`,
      accountCount: (count) => `${count} \u4E2A\u8D26\u53F7`,
      formatCount: (count) => `${count} \u79CD\u683C\u5F0F`,
      exportAccounts: (count) => `\u5BFC\u51FA ${count} \u4E2A\u8D26\u53F7`,
      exportAria: (count, jsonl, zip) => [
        `\u5BFC\u51FA ${count} \u4E2A\u8D26\u53F7`,
        jsonl ? "JSONL\uFF1A\u6BCF\u884C\u4E00\u4E2A\u8D26\u53F7\u3002" : "",
        zip ? "\u591A\u683C\u5F0F\u6216\u591A\u6587\u4EF6\u4F1A\u81EA\u52A8\u6253\u5305\u4E3A ZIP\u3002" : ""
      ].filter(Boolean).join(" "),
      previewNoFormat: "\u9009\u62E9\u5BFC\u51FA\u683C\u5F0F\u540E\u663E\u793A\u9884\u89C8\u3002",
      previewNoInput: "\u8F93\u5165 JSON \u540E\u663E\u793A\u5F53\u524D\u683C\u5F0F\u9884\u89C8\u3002",
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
      codexManagerTooltip: "Codex-Manager \u683C\u5F0F\u3002",
      codexTooltip: "Codex auth.json \u683C\u5F0F\u3002",
      modeSingle: "\u5355\u4E2A",
      modeMerged: "\u805A\u5408",
      modeSingleTip: "\u5355\u4E2A\uFF1A\u6BCF\u8D26\u53F7 1 \u4E2A\u6587\u4EF6\u3002",
      modeMergedTip: "\u805A\u5408\uFF1A1 \u4E2A\u6C47\u603B\u6587\u4EF6\u3002",
      nextModeLabel: (mode) => mode === "single" ? "\u805A\u5408" : "\u5355\u4E2A",
      modeAria: (format, current, tip, next) => `\u5207\u6362 ${format} \u5BFC\u51FA\u65B9\u5F0F\uFF0C\u5F53\u524D${current}\u3002${tip} \u70B9\u51FB\u5207\u6362\u4E3A${next}`,
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
  <path...>              Input JSON file or directory path; may repeat
  -i, --input <path>     Input file or directory path; may repeat
  --stdin                Read from standard input; conflicts with paths
  -f, --format <list>    Output formats, comma-separated or repeated; cpa/sub2api/codex2api/codexmanager/codex/all
  --mode <fmt>=<m>       sub2api/codex2api output mode: merged or single
  -o, --out-dir <path>   Output directory, default output
  --jsonl                Output JSONL text, one JSON document per line
  --zip                  Write one ZIP file and keep the current output tree inside it
  --stdout               Write a single output file to stdout
  --no-fake-id           Omit synthetic id_token from output (included by default)
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
        cwdMissing: "Current directory no longer exists",
        unknownArg: (arg) => `Unknown argument: ${arg}`,
        missingInput: "No input specified; pass <path>, -i, or --stdin",
        invalidModeSyntax: (value) => `Invalid --mode: ${value} (expected format=merged|single)`,
        unknownOutputFormat: (format) => `Unknown output format: ${format}`,
        unsupportedModeFormat: (format) => `--mode only supports sub2api or codex2api: ${format}`,
        unknownOutputMode: (mode) => `Unknown output mode in --mode: ${mode}`,
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
        human: (accountCount, fileCount, formats, outputRoot) => `Found ${accountCount} account(s), converted to ${formats} format, wrote ${fileCount} file(s)${outputRoot ? ` to ${outputRoot}` : ""}`,
        inspectColumns: ["#", "email", "account_id", "plan", "expires"],
        unknownAccount: "unknown",
        missingValue: "-",
        dryRun: (accountCount, fileCount, outputRoot) => `Found ${accountCount} account(s), would write ${fileCount} file(s) to ${outputRoot}`,
        fileLine: (filePath, accountCount) => `- ${filePath} (${accountCount} account(s))`,
        warning: "warning",
        groupedWarnings: (message, sources) => {
          const truncated = sources.slice(0, 3);
          const suffix = sources.length > 3 ? "..." : "";
          return `${message} (${sources.length} files: ${truncated.join(", ")}${suffix})`;
        }
      }
    },
    normalize: {
      invalidInputFormat: (sourceName, inputFormat) => `${sourceName}: input is not ${inputFormat}`,
      noTokens: (sourceName) => `${sourceName}: no recognizable token fields found`,
      invalidExpiry: (sourceName, value) => `${sourceName}: invalid expiry time ("${value}")`,
      syntheticIdToken: (sourceName) => `${sourceName}: generated synthetic id_token`,
      missingIdToken: (sourceName) => `${sourceName}: missing id_token`,
      missingRefreshToken: (sourceName) => `${sourceName}: missing refresh_token`,
      missingAccessToken: (sourceName) => `${sourceName}: missing access_token`,
      claimOverride: (sourceName, fields) => `${sourceName}: access_token claim mismatch, overwritten fields: ${fields.join(",")}`,
      claimSanity: (sourceName, fields) => `${sourceName}: invalid JWT claims: ${fields.join(",")}`
    },
    web: {
      pageTitle: "GPT Auth Converter | Local credential format converter",
      appTitle: "GPT Auth Converter",
      notice: "Local-only conversion. Everything runs in this browser.",
      dragTitle: "Drop to import JSON / JSONL credentials",
      dragSub: "Release to add to the list",
      themeLabel: "Theme",
      themeAria: "Switch and choose interface theme",
      themeSystem: "Auto",
      themeLight: "Light",
      themeDark: "Dark",
      languageLabel: "Language",
      languageAria: "Switch interface language",
      inputTitle: "Input",
      sessionButton: "Get Session",
      addDraftButton: "Add to List",
      clearButton: "Clear",
      inputAria: "JSON credential input",
      inputPlaceholder: `Paste a ChatGPT /api/auth/session JSON response, Codex auth.json, JSONL text, or drop multi-account JSON exports below...

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
      dropZoneAria: "Choose or drop JSON credential files or folders",
      dropTitle: "Choose or drop .json / .jsonl credential files",
      dropSub: "Drop files or folders",
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
      accountTitle: "Loaded Accounts",
      clearAccounts: "Clear List",
      accountColumns: ["Account (Email / ID)", "Plan", "Expires At", "Action"],
      accountListAria: "Account list",
      previewAria: "Output preview",
      previewTabsAria: "Preview format selection",
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
      sourceImported: (count) => `Added ${count} account(s)`,
      fileImported: (count) => `Imported ${count} account(s)`,
      chooseJsonFile: "Choose .json or .jsonl files.",
      fileNoAccounts: (name) => `${name}: no convertible accounts found.`,
      fileInvalidInput: (name, error) => `${name}: ${error}`,
      fileJsonFailed: (name, error) => `JSON parse failed (${name}): ${error}`,
      fileReadFailed: (error) => `File read failed: ${error}`,
      accountCount: (count) => `${count} account(s)`,
      formatCount: (count) => `${count} formats`,
      exportAccounts: (count) => `Export ${count} account(s)`,
      exportAria: (count, jsonl, zip) => [
        `Export ${count} account(s)`,
        jsonl ? "JSONL: one account per line." : "",
        zip ? "Multiple formats or files will be packed as ZIP." : ""
      ].filter(Boolean).join(" "),
      previewNoFormat: "Select an output format to preview.",
      previewNoInput: "Paste JSON to preview the selected format.",
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
      codexManagerTooltip: "Codex-Manager format.",
      codexTooltip: "Codex auth.json format.",
      modeSingle: "Single",
      modeMerged: "Merged",
      modeSingleTip: "Single: one file per account.",
      modeMergedTip: "Merged: one combined file.",
      nextModeLabel: (mode) => mode === "single" ? "Merged" : "Single",
      modeAria: (format, current, tip, next) => `Switch ${format} output mode. Current: ${current}. ${tip} Click to switch to ${next}.`,
      exportZipToast: (name) => `Started exporting ${name}`,
      exportFileToast: "Started exporting file"
    }
  }
};
function messagesFor(locale) {
  return MESSAGES[locale];
}
function inputFormatLabel(inputFormat, locale) {
  return INPUT_FORMAT_LABELS[locale][inputFormat];
}

// src/json-input.ts
function parseInputPayload(text, options = {}) {
  return parseInputPayloadWithMeta(text, options).value;
}
function parseInputPayloadWithMeta(text, options = {}) {
  const locale = options.locale ?? DEFAULT_LOCALE;
  const normalizedText = text.replace(/^\uFEFF/, "");
  try {
    return {
      value: JSON.parse(normalizedText),
      documentCount: 1
    };
  } catch (jsonError) {
    return parseJsonDocumentStream(normalizedText, jsonError, locale);
  }
}
function parseJsonDocumentStream(text, jsonError, locale) {
  const values = [];
  let position = skipWhitespace(text, 0);
  while (position < text.length) {
    const start = position;
    let end;
    try {
      end = scanJsonValueEnd(text, start, locale);
    } catch (scanError) {
      throw new Error(jsonParseFailed(locale, start, scanError, jsonError));
    }
    try {
      values.push(JSON.parse(text.slice(start, end)));
    } catch (documentError) {
      throw new Error(jsonParseFailed(locale, start, documentError, jsonError));
    }
    position = skipWhitespace(text, end);
  }
  if (values.length === 0) {
    throw new Error(jsonParseFailedEmpty(locale, jsonError));
  }
  return {
    value: values.length === 1 ? values[0] : values,
    documentCount: values.length
  };
}
function scanJsonValueEnd(text, start, locale) {
  const first = text[start];
  if (first === "{" || first === "[") {
    return scanContainerEnd(text, start, locale);
  }
  if (first === '"') {
    return scanStringEnd(text, start, locale);
  }
  return scanPrimitiveEnd(text, start, locale);
}
function scanContainerEnd(text, start, locale) {
  const stack = [];
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === "{") {
      stack.push("}");
      continue;
    }
    if (char === "[") {
      stack.push("]");
      continue;
    }
    if (char === "}" || char === "]") {
      const expected = stack.pop();
      if (expected !== char) {
        throw new Error(mismatchedClose(locale, expected, char));
      }
      if (stack.length === 0) {
        return index + 1;
      }
    }
  }
  throw new Error(unclosedDocument(locale));
}
function scanStringEnd(text, start, locale) {
  let escaped = false;
  for (let index = start + 1; index < text.length; index += 1) {
    const char = text[index];
    if (escaped) {
      escaped = false;
    } else if (char === "\\") {
      escaped = true;
    } else if (char === '"') {
      return index + 1;
    }
  }
  throw new Error(unclosedString(locale));
}
function scanPrimitiveEnd(text, start, locale) {
  const rest = text.slice(start);
  const numberMatch = rest.match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/);
  if (numberMatch?.[0]) {
    return start + numberMatch[0].length;
  }
  for (const literal of ["true", "false", "null"]) {
    if (rest.startsWith(literal)) {
      return start + literal.length;
    }
  }
  throw new Error(missingStart(locale));
}
function skipWhitespace(text, start) {
  let index = start;
  while (index < text.length && /\s/.test(text[index])) {
    index += 1;
  }
  return index;
}
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
function jsonParseFailed(locale, start, detail, jsonError) {
  if (locale === "zh") {
    return `JSON/JSONL \u89E3\u6790\u5931\u8D25\uFF0C\u4F4D\u7F6E ${start + 1}: ${errorMessage(detail)}\uFF1B\u6574\u4F53 JSON \u9519\u8BEF: ${errorMessage(jsonError)}`;
  }
  return `JSON/JSONL parse failed at position ${start + 1}: ${errorMessage(detail)}; full JSON error: ${errorMessage(jsonError)}`;
}
function jsonParseFailedEmpty(locale, jsonError) {
  if (locale === "zh") {
    return `JSON/JSONL \u89E3\u6790\u5931\u8D25: ${errorMessage(jsonError)}`;
  }
  return `JSON/JSONL parse failed: ${errorMessage(jsonError)}`;
}
function mismatchedClose(locale, expected, actual) {
  if (locale === "zh") {
    return `JSON \u7ED3\u6784\u95ED\u5408\u7B26\u4E0D\u5339\u914D\uFF0C\u9884\u671F ${expected ?? "\u65E0"}\uFF0C\u5B9E\u9645 ${actual}`;
  }
  return `JSON structure closer mismatch, expected ${expected ?? "none"}, got ${actual}`;
}
function unclosedDocument(locale) {
  return locale === "zh" ? "JSON \u6587\u6863\u672A\u95ED\u5408" : "JSON document is not closed";
}
function unclosedString(locale) {
  return locale === "zh" ? "JSON \u5B57\u7B26\u4E32\u672A\u95ED\u5408" : "JSON string is not closed";
}
function missingStart(locale) {
  return locale === "zh" ? "\u672A\u627E\u5230 JSON \u6587\u6863\u8D77\u70B9" : "JSON document start not found";
}

// src/jwt.ts
var SYNTHETIC_ID_TOKEN_PLACEHOLDER_SIGNATURE = base64urlEncode("lanv_authconv");
function decodeJwtPayload(token) {
  if (!token) {
    return void 0;
  }
  const parts = token.split(".");
  if (parts.length < 2 || !parts[1]) {
    return void 0;
  }
  try {
    const text = base64urlDecode(parts[1]);
    const parsed = JSON.parse(text);
    return isRecord(parsed) ? parsed : void 0;
  } catch {
    return void 0;
  }
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

// src/normalize.ts
function detectInputFormat(input) {
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
function detectArrayItemFormat(input) {
  const format = detectRecordInputFormat(input);
  if (format !== "unknown") {
    return format;
  }
  if (typeof input.refresh_token === "string" && typeof input.session_token === "string") {
    return "codex2api";
  }
  return "unknown";
}
function detectRecordInputFormat(input) {
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
  if (input.type === "codex" && (typeof input.access_token === "string" || typeof input.refresh_token === "string" || typeof input.session_token === "string")) {
    return "cpa";
  }
  if (isCodexAuthRecord(input)) {
    return "codex";
  }
  if (isRecord(input.tokens) && isRecord(input.meta)) {
    return "codexmanager";
  }
  if (typeof input.refresh_token === "string" && typeof input.session_token === "string" && !isRecord(input.tokens)) {
    return "codex2api";
  }
  return "unknown";
}
function normalizeInput(input, source, options = {}) {
  const locale = options.locale ?? DEFAULT_LOCALE;
  const messages = messagesFor(locale).normalize;
  const warnings = [];
  const selectedFormat = selectedInputFormat(options.inputFormat);
  const detectedFormat = detectInputFormat(input);
  const inputFormat = selectedFormat ?? detectedFormat;
  const candidates = extractCandidates(input, source, selectedFormat);
  const accounts = candidates.map((candidate, index) => {
    const account = normalizeCandidate(candidate, index, options);
    if (account) {
      account.inputFormat = candidate.inputFormat;
    }
    return account;
  }).filter((account) => account !== void 0);
  if (accounts.length === 0) {
    warnings.push(
      selectedFormat ? messages.invalidInputFormat(source.sourceName, inputFormatLabel(selectedFormat, locale)) : messages.noTokens(source.sourceName)
    );
  }
  return {
    accounts,
    warnings: warnings.concat(accounts.flatMap((account) => account.warnings)),
    inputFormat: selectedFormat ?? commonAccountInputFormat(accounts) ?? inputFormat
  };
}
function selectedInputFormat(inputFormat) {
  return inputFormat && inputFormat !== "unknown" ? inputFormat : void 0;
}
function uniqueFormats(formats) {
  return Array.from(new Set(formats));
}
function commonAccountInputFormat(accounts) {
  if (accounts.length === 0) {
    return void 0;
  }
  const formats = uniqueFormats(accounts.map((account) => account.inputFormat ?? "unknown"));
  return formats.length === 1 ? formats[0] : "unknown";
}
function extractCandidates(input, source, selectedFormat) {
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
  return record.type === "codex" && Boolean(firstString([record], ["access_token", "refresh_token", "session_token", "id_token"]));
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
function normalizeCandidate(candidate, index, options) {
  const messages = messagesFor(options.locale ?? DEFAULT_LOCALE).normalize;
  const { records } = candidate;
  const accessToken = firstString(records, ["access_token", "accessToken"]);
  const refreshToken = firstString(records, ["refresh_token", "refreshToken"]);
  const sessionToken = firstString(records, ["session_token", "sessionToken"]);
  let idToken = firstString(records, ["id_token", "idToken"]);
  if (!accessToken && !refreshToken && !sessionToken && !idToken) {
    return void 0;
  }
  const idClaims = decodeJwtPayload(idToken);
  const accessClaims = decodeJwtPayload(accessToken);
  const identityClaimRecords = [idClaims, accessClaims].filter((claims2) => claims2 !== void 0);
  const accessFirstClaimRecords = [accessClaims, idClaims].filter((claims2) => claims2 !== void 0);
  const expiryClaimRecords = [accessClaims, idClaims].filter((claims2) => claims2 !== void 0);
  const authClaimRecords = accessFirstClaimRecords.map(openAIAuthClaims).filter((claims2) => claims2 !== void 0);
  const claims = accessClaims ?? idClaims;
  const warnings = [];
  const accessAuthClaims = openAIAuthClaims(accessClaims);
  const idAuthClaims = openAIAuthClaims(idClaims);
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
  const claimedUserId = firstClaimString(accessFirstClaimRecords, ["sub"]);
  const recordUserId = firstString(records, ["user_id", "userId", "sub"]);
  const userId = preferClaimIdentity ? claimedUserId ?? recordUserId : recordUserId ?? claimedUserId;
  const claimedIssuer = firstClaimString(accessFirstClaimRecords, ["iss"]);
  const recordIssuer = firstString(records, ["issuer", "iss"]);
  const issuer = preferClaimIdentity ? claimedIssuer ?? recordIssuer : recordIssuer ?? claimedIssuer;
  const audience = firstClaimStringArray(accessFirstClaimRecords, "aud");
  const clientId = firstClaimString(accessFirstClaimRecords, ["client_id"]);
  const scopes = firstClaimStringArray(accessFirstClaimRecords, "scp");
  const claimedNotBeforeNumber = firstClaimNumber(accessFirstClaimRecords, "nbf");
  const notBefore = normalizeTimeValue(claimedNotBeforeNumber);
  const recordEmail = firstString(records, ["email", "email_address", "emailAddress"]);
  const claimedEmail = claimString(accessClaims, "email") ?? claimString(openAIProfileClaims(accessClaims), "email") ?? claimString(idClaims, "email") ?? claimString(openAIProfileClaims(idClaims), "email");
  const email = preferClaimIdentity ? claimedEmail ?? recordEmail : recordEmail ?? claimedEmail;
  const recordName = firstString(records, ["name", "label"]);
  const claimedName = claimString(accessClaims, "name") ?? claimString(openAIProfileClaims(accessClaims), "name") ?? claimString(idClaims, "name") ?? claimString(openAIProfileClaims(idClaims), "name");
  const name = preferClaimIdentity ? claimedName ?? recordName : recordName ?? claimedName;
  const claimedPlanType = claimString(accessAuthClaims, "chatgpt_plan_type") ?? claimString(accessAuthClaims, "plan_type") ?? claimString(accessClaims, "chatgpt_plan_type") ?? claimString(accessClaims, "plan_type") ?? claimString(idAuthClaims, "chatgpt_plan_type") ?? claimString(idAuthClaims, "plan_type") ?? claimString(idClaims, "chatgpt_plan_type") ?? claimString(idClaims, "plan_type");
  const recordPlanType = firstString(records, ["plan_type", "planType", "chatgpt_plan_type", "chatgptPlanType"]);
  const planType = preferClaimIdentity ? claimedPlanType ?? recordPlanType : recordPlanType ?? claimedPlanType;
  const claimedWorkspaceId = claimString(accessClaims, "workspace_id") ?? claimString(accessAuthClaims, "workspace_id") ?? claimString(idClaims, "workspace_id") ?? claimString(idAuthClaims, "workspace_id");
  const recordWorkspaceId = firstString(records, ["workspace_id", "workspaceId"]);
  const preserveRawTimeFields = candidate.inputFormat === "cpa" || candidate.inputFormat === "codex";
  const recordExpiresAt = normalizeInputTimeValue(firstString(records, ["expires_at", "expiresAt", "expired", "expires"]), preserveRawTimeFields);
  const claimedExpiresAt = normalizeTimeValue(firstClaimNumber(expiryClaimRecords, "exp"));
  const recordLastRefresh = normalizeInputTimeValue(firstString(records, ["last_refresh", "lastRefresh"]), preserveRawTimeFields);
  const claimedLastRefresh = normalizeTimeValue(firstClaimNumber(accessFirstClaimRecords, "iat"));
  const workspaceId = preferClaimIdentity ? claimedWorkspaceId ?? recordWorkspaceId : recordWorkspaceId ?? firstClaimString(identityClaimRecords, ["workspace_id"]) ?? firstClaimString(authClaimRecords, ["workspace_id"]);
  const expiresAt = preferClaimIdentity ? claimedExpiresAt ?? recordExpiresAt : recordExpiresAt ?? claimedExpiresAt;
  const lastRefresh = preferClaimIdentity ? claimedLastRefresh ?? recordLastRefresh : recordLastRefresh ?? claimedLastRefresh;
  if (preferClaimIdentity) {
    const overrideFields = [];
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
    issuer: claimedIssuer,
    audience,
    notBefore: claimedNotBeforeNumber,
    expiresAt: firstClaimNumber(expiryClaimRecords, "exp")
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
  if (!idToken) {
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
      expiresAt
    });
    if (syntheticClaims) {
      idToken = createSyntheticIdToken(syntheticClaims);
      idTokenSynthetic = true;
      warnings.push(messages.syntheticIdToken(candidate.sourceName));
    } else {
      warnings.push(messages.missingIdToken(candidate.sourceName));
    }
  }
  if (!refreshToken) {
    warnings.push(messages.missingRefreshToken(candidate.sourceName));
  }
  if (!accessToken) {
    warnings.push(messages.missingAccessToken(candidate.sourceName));
  }
  return {
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
    sourceName: candidate.sourceName,
    sourcePath: candidate.sourcePath || `${candidate.sourceName}#${index + 1}`,
    warnings
  };
}
var DEDUPE_IGNORED_KEYS = /* @__PURE__ */ new Set([
  "sourceName",
  "sourcePath",
  "warnings",
  "inputFormat"
]);
function accountDedupeKey(account) {
  const entries = Object.keys(account).filter((key) => !DEDUPE_IGNORED_KEYS.has(key) && account[key] !== void 0).sort().map((key) => [key, account[key]]);
  return JSON.stringify(entries);
}
function dedupeAccounts(accounts) {
  const seen = /* @__PURE__ */ new Set();
  const result = [];
  for (const account of accounts) {
    const key = accountDedupeKey(account);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(account);
  }
  return result;
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
function claimSanityFields(input) {
  const fields = [];
  if (input.issuer && input.issuer !== "https://auth.openai.com") {
    fields.push("iss");
  }
  if (input.audience && !input.audience.includes("https://api.openai.com/v1")) {
    fields.push("aud");
  }
  if (input.notBefore !== void 0 && input.expiresAt !== void 0 && input.notBefore > input.expiresAt) {
    fields.push("nbf");
  }
  return fields;
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

// node_modules/fflate/esm/index.mjs
import { createRequire } from "module";
var require2 = createRequire("/");
var Worker;
try {
  Worker = require2("worker_threads").Worker;
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
var flm = /* @__PURE__ */ hMap(flt, 9, 0);
var fdm = /* @__PURE__ */ hMap(fdt, 5, 0);
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
var wbits = function(d, p, v) {
  v <<= p & 7;
  var o = p / 8 | 0;
  d[o] |= v;
  d[o + 1] |= v >> 8;
};
var wbits16 = function(d, p, v) {
  v <<= p & 7;
  var o = p / 8 | 0;
  d[o] |= v;
  d[o + 1] |= v >> 8;
  d[o + 2] |= v >> 16;
};
var hTree = function(d, mb) {
  var t = [];
  for (var i = 0; i < d.length; ++i) {
    if (d[i])
      t.push({ s: i, f: d[i] });
  }
  var s = t.length;
  var t2 = t.slice();
  if (!s)
    return { t: et, l: 0 };
  if (s == 1) {
    var v = new u8(t[0].s + 1);
    v[t[0].s] = 1;
    return { t: v, l: 1 };
  }
  t.sort(function(a, b) {
    return a.f - b.f;
  });
  t.push({ s: -1, f: 25001 });
  var l = t[0], r = t[1], i0 = 0, i1 = 1, i2 = 2;
  t[0] = { s: -1, f: l.f + r.f, l, r };
  while (i1 != s - 1) {
    l = t[t[i0].f < t[i2].f ? i0++ : i2++];
    r = t[i0 != i1 && t[i0].f < t[i2].f ? i0++ : i2++];
    t[i1++] = { s: -1, f: l.f + r.f, l, r };
  }
  var maxSym = t2[0].s;
  for (var i = 1; i < s; ++i) {
    if (t2[i].s > maxSym)
      maxSym = t2[i].s;
  }
  var tr = new u16(maxSym + 1);
  var mbt = ln(t[i1 - 1], tr, 0);
  if (mbt > mb) {
    var i = 0, dt = 0;
    var lft = mbt - mb, cst = 1 << lft;
    t2.sort(function(a, b) {
      return tr[b.s] - tr[a.s] || a.f - b.f;
    });
    for (; i < s; ++i) {
      var i2_1 = t2[i].s;
      if (tr[i2_1] > mb) {
        dt += cst - (1 << mbt - tr[i2_1]);
        tr[i2_1] = mb;
      } else
        break;
    }
    dt >>= lft;
    while (dt > 0) {
      var i2_2 = t2[i].s;
      if (tr[i2_2] < mb)
        dt -= 1 << mb - tr[i2_2]++ - 1;
      else
        ++i;
    }
    for (; i >= 0 && dt; --i) {
      var i2_3 = t2[i].s;
      if (tr[i2_3] == mb) {
        --tr[i2_3];
        ++dt;
      }
    }
    mbt = mb;
  }
  return { t: new u8(tr), l: mbt };
};
var ln = function(n, l, d) {
  return n.s == -1 ? Math.max(ln(n.l, l, d + 1), ln(n.r, l, d + 1)) : l[n.s] = d;
};
var lc = function(c) {
  var s = c.length;
  while (s && !c[--s])
    ;
  var cl = new u16(++s);
  var cli = 0, cln = c[0], cls = 1;
  var w = function(v) {
    cl[cli++] = v;
  };
  for (var i = 1; i <= s; ++i) {
    if (c[i] == cln && i != s)
      ++cls;
    else {
      if (!cln && cls > 2) {
        for (; cls > 138; cls -= 138)
          w(32754);
        if (cls > 2) {
          w(cls > 10 ? cls - 11 << 5 | 28690 : cls - 3 << 5 | 12305);
          cls = 0;
        }
      } else if (cls > 3) {
        w(cln), --cls;
        for (; cls > 6; cls -= 6)
          w(8304);
        if (cls > 2)
          w(cls - 3 << 5 | 8208), cls = 0;
      }
      while (cls--)
        w(cln);
      cls = 1;
      cln = c[i];
    }
  }
  return { c: cl.subarray(0, cli), n: s };
};
var clen = function(cf, cl) {
  var l = 0;
  for (var i = 0; i < cl.length; ++i)
    l += cf[i] * cl[i];
  return l;
};
var wfblk = function(out, pos, dat) {
  var s = dat.length;
  var o = shft(pos + 2);
  out[o] = s & 255;
  out[o + 1] = s >> 8;
  out[o + 2] = out[o] ^ 255;
  out[o + 3] = out[o + 1] ^ 255;
  for (var i = 0; i < s; ++i)
    out[o + i + 4] = dat[i];
  return (o + 4 + s) * 8;
};
var wblk = function(dat, out, final, syms, lf, df, eb, li, bs, bl, p) {
  wbits(out, p++, final);
  ++lf[256];
  var _a2 = hTree(lf, 15), dlt = _a2.t, mlb = _a2.l;
  var _b2 = hTree(df, 15), ddt = _b2.t, mdb = _b2.l;
  var _c = lc(dlt), lclt = _c.c, nlc = _c.n;
  var _d = lc(ddt), lcdt = _d.c, ndc = _d.n;
  var lcfreq = new u16(19);
  for (var i = 0; i < lclt.length; ++i)
    ++lcfreq[lclt[i] & 31];
  for (var i = 0; i < lcdt.length; ++i)
    ++lcfreq[lcdt[i] & 31];
  var _e = hTree(lcfreq, 7), lct = _e.t, mlcb = _e.l;
  var nlcc = 19;
  for (; nlcc > 4 && !lct[clim[nlcc - 1]]; --nlcc)
    ;
  var flen = bl + 5 << 3;
  var ftlen = clen(lf, flt) + clen(df, fdt) + eb;
  var dtlen = clen(lf, dlt) + clen(df, ddt) + eb + 14 + 3 * nlcc + clen(lcfreq, lct) + 2 * lcfreq[16] + 3 * lcfreq[17] + 7 * lcfreq[18];
  if (bs >= 0 && flen <= ftlen && flen <= dtlen)
    return wfblk(out, p, dat.subarray(bs, bs + bl));
  var lm, ll, dm, dl;
  wbits(out, p, 1 + (dtlen < ftlen)), p += 2;
  if (dtlen < ftlen) {
    lm = hMap(dlt, mlb, 0), ll = dlt, dm = hMap(ddt, mdb, 0), dl = ddt;
    var llm = hMap(lct, mlcb, 0);
    wbits(out, p, nlc - 257);
    wbits(out, p + 5, ndc - 1);
    wbits(out, p + 10, nlcc - 4);
    p += 14;
    for (var i = 0; i < nlcc; ++i)
      wbits(out, p + 3 * i, lct[clim[i]]);
    p += 3 * nlcc;
    var lcts = [lclt, lcdt];
    for (var it = 0; it < 2; ++it) {
      var clct = lcts[it];
      for (var i = 0; i < clct.length; ++i) {
        var len = clct[i] & 31;
        wbits(out, p, llm[len]), p += lct[len];
        if (len > 15)
          wbits(out, p, clct[i] >> 5 & 127), p += clct[i] >> 12;
      }
    }
  } else {
    lm = flm, ll = flt, dm = fdm, dl = fdt;
  }
  for (var i = 0; i < li; ++i) {
    var sym = syms[i];
    if (sym > 255) {
      var len = sym >> 18 & 31;
      wbits16(out, p, lm[len + 257]), p += ll[len + 257];
      if (len > 7)
        wbits(out, p, sym >> 23 & 31), p += fleb[len];
      var dst = sym & 31;
      wbits16(out, p, dm[dst]), p += dl[dst];
      if (dst > 3)
        wbits16(out, p, sym >> 5 & 8191), p += fdeb[dst];
    } else {
      wbits16(out, p, lm[sym]), p += ll[sym];
    }
  }
  wbits16(out, p, lm[256]);
  return p + ll[256];
};
var deo = /* @__PURE__ */ new i32([65540, 131080, 131088, 131104, 262176, 1048704, 1048832, 2114560, 2117632]);
var et = /* @__PURE__ */ new u8(0);
var dflt = function(dat, lvl, plvl, pre, post, st) {
  var s = st.z || dat.length;
  var o = new u8(pre + s + 5 * (1 + Math.ceil(s / 7e3)) + post);
  var w = o.subarray(pre, o.length - post);
  var lst = st.l;
  var pos = (st.r || 0) & 7;
  if (lvl) {
    if (pos)
      w[0] = st.r >> 3;
    var opt = deo[lvl - 1];
    var n = opt >> 13, c = opt & 8191;
    var msk_1 = (1 << plvl) - 1;
    var prev = st.p || new u16(32768), head = st.h || new u16(msk_1 + 1);
    var bs1_1 = Math.ceil(plvl / 3), bs2_1 = 2 * bs1_1;
    var hsh = function(i2) {
      return (dat[i2] ^ dat[i2 + 1] << bs1_1 ^ dat[i2 + 2] << bs2_1) & msk_1;
    };
    var syms = new i32(25e3);
    var lf = new u16(288), df = new u16(32);
    var lc_1 = 0, eb = 0, i = st.i || 0, li = 0, wi = st.w || 0, bs = 0;
    for (; i + 2 < s; ++i) {
      var hv = hsh(i);
      var imod = i & 32767, pimod = head[hv];
      prev[imod] = pimod;
      head[hv] = imod;
      if (wi <= i) {
        var rem = s - i;
        if ((lc_1 > 7e3 || li > 24576) && (rem > 423 || !lst)) {
          pos = wblk(dat, w, 0, syms, lf, df, eb, li, bs, i - bs, pos);
          li = lc_1 = eb = 0, bs = i;
          for (var j = 0; j < 286; ++j)
            lf[j] = 0;
          for (var j = 0; j < 30; ++j)
            df[j] = 0;
        }
        var l = 2, d = 0, ch_1 = c, dif = imod - pimod & 32767;
        if (rem > 2 && hv == hsh(i - dif)) {
          var maxn = Math.min(n, rem) - 1;
          var maxd = Math.min(32767, i);
          var ml = Math.min(258, rem);
          while (dif <= maxd && --ch_1 && imod != pimod) {
            if (dat[i + l] == dat[i + l - dif]) {
              var nl = 0;
              for (; nl < ml && dat[i + nl] == dat[i + nl - dif]; ++nl)
                ;
              if (nl > l) {
                l = nl, d = dif;
                if (nl > maxn)
                  break;
                var mmd = Math.min(dif, nl - 2);
                var md = 0;
                for (var j = 0; j < mmd; ++j) {
                  var ti = i - dif + j & 32767;
                  var pti = prev[ti];
                  var cd = ti - pti & 32767;
                  if (cd > md)
                    md = cd, pimod = ti;
                }
              }
            }
            imod = pimod, pimod = prev[imod];
            dif += imod - pimod & 32767;
          }
        }
        if (d) {
          syms[li++] = 268435456 | revfl[l] << 18 | revfd[d];
          var lin = revfl[l] & 31, din = revfd[d] & 31;
          eb += fleb[lin] + fdeb[din];
          ++lf[257 + lin];
          ++df[din];
          wi = i + l;
          ++lc_1;
        } else {
          syms[li++] = dat[i];
          ++lf[dat[i]];
        }
      }
    }
    for (i = Math.max(i, wi); i < s; ++i) {
      syms[li++] = dat[i];
      ++lf[dat[i]];
    }
    pos = wblk(dat, w, lst, syms, lf, df, eb, li, bs, i - bs, pos);
    if (!lst) {
      st.r = pos & 7 | w[pos / 8 | 0] << 3;
      pos -= 7;
      st.h = head, st.p = prev, st.i = i, st.w = wi;
    }
  } else {
    for (var i = st.w || 0; i < s + lst; i += 65535) {
      var e = i + 65535;
      if (e >= s) {
        w[pos / 8 | 0] = lst;
        e = s;
      }
      pos = wfblk(w, pos + 1, dat.subarray(i, e));
    }
    st.i = s;
  }
  return slc(o, 0, pre + shft(pos) + post);
};
var crct = /* @__PURE__ */ (function() {
  var t = new Int32Array(256);
  for (var i = 0; i < 256; ++i) {
    var c = i, k = 9;
    while (--k)
      c = (c & 1 && -306674912) ^ c >>> 1;
    t[i] = c;
  }
  return t;
})();
var crc = function() {
  var c = -1;
  return {
    p: function(d) {
      var cr = c;
      for (var i = 0; i < d.length; ++i)
        cr = crct[cr & 255 ^ d[i]] ^ cr >>> 8;
      c = cr;
    },
    d: function() {
      return ~c;
    }
  };
};
var dopt = function(dat, opt, pre, post, st) {
  if (!st) {
    st = { l: 1 };
    if (opt.dictionary) {
      var dict = opt.dictionary.subarray(-32768);
      var newDat = new u8(dict.length + dat.length);
      newDat.set(dict);
      newDat.set(dat, dict.length);
      dat = newDat;
      st.w = dict.length;
    }
  }
  return dflt(dat, opt.level == null ? 6 : opt.level, opt.mem == null ? st.l ? Math.ceil(Math.max(8, Math.min(13, Math.log(dat.length))) * 1.5) : 20 : 12 + opt.mem, pre, post, st);
};
var mrg = function(a, b) {
  var o = {};
  for (var k in a)
    o[k] = a[k];
  for (var k in b)
    o[k] = b[k];
  return o;
};
var wbytes = function(d, b, v) {
  for (; v; ++b)
    d[b] = v, v >>>= 8;
};
function deflateSync(data, opts) {
  return dopt(data, opts || {}, 0, 0);
}
var fltn = function(d, p, t, o) {
  for (var k in d) {
    var val = d[k], n = p + k, op = o;
    if (Array.isArray(val))
      op = mrg(o, val[1]), val = val[0];
    if (val instanceof u8)
      t[n] = [val, op];
    else {
      t[n += "/"] = [new u8(0), op];
      fltn(val, n, t, o);
    }
  }
};
var te = typeof TextEncoder != "undefined" && /* @__PURE__ */ new TextEncoder();
var td = typeof TextDecoder != "undefined" && /* @__PURE__ */ new TextDecoder();
var tds = 0;
try {
  td.decode(et, { stream: true });
  tds = 1;
} catch (e) {
}
function strToU8(str, latin1) {
  if (latin1) {
    var ar_1 = new u8(str.length);
    for (var i = 0; i < str.length; ++i)
      ar_1[i] = str.charCodeAt(i);
    return ar_1;
  }
  if (te)
    return te.encode(str);
  var l = str.length;
  var ar = new u8(str.length + (str.length >> 1));
  var ai = 0;
  var w = function(v) {
    ar[ai++] = v;
  };
  for (var i = 0; i < l; ++i) {
    if (ai + 5 > ar.length) {
      var n = new u8(ai + 8 + (l - i << 1));
      n.set(ar);
      ar = n;
    }
    var c = str.charCodeAt(i);
    if (c < 128 || latin1)
      w(c);
    else if (c < 2048)
      w(192 | c >> 6), w(128 | c & 63);
    else if (c > 55295 && c < 57344)
      c = 65536 + (c & 1023 << 10) | str.charCodeAt(++i) & 1023, w(240 | c >> 18), w(128 | c >> 12 & 63), w(128 | c >> 6 & 63), w(128 | c & 63);
    else
      w(224 | c >> 12), w(128 | c >> 6 & 63), w(128 | c & 63);
  }
  return slc(ar, 0, ai);
}
var exfl = function(ex) {
  var le = 0;
  if (ex) {
    for (var k in ex) {
      var l = ex[k].length;
      if (l > 65535)
        err(9);
      le += l + 4;
    }
  }
  return le;
};
var wzh = function(d, b, f, fn, u, c, ce, co) {
  var fl2 = fn.length, ex = f.extra, col = co && co.length;
  var exl = exfl(ex);
  wbytes(d, b, ce != null ? 33639248 : 67324752), b += 4;
  if (ce != null)
    d[b++] = 20, d[b++] = f.os;
  d[b] = 20, b += 2;
  d[b++] = f.flag << 1 | (c < 0 && 8), d[b++] = u && 8;
  d[b++] = f.compression & 255, d[b++] = f.compression >> 8;
  var dt = new Date(f.mtime == null ? Date.now() : f.mtime), y = dt.getFullYear() - 1980;
  if (y < 0 || y > 119)
    err(10);
  wbytes(d, b, y << 25 | dt.getMonth() + 1 << 21 | dt.getDate() << 16 | dt.getHours() << 11 | dt.getMinutes() << 5 | dt.getSeconds() >> 1), b += 4;
  if (c != -1) {
    wbytes(d, b, f.crc);
    wbytes(d, b + 4, c < 0 ? -c - 2 : c);
    wbytes(d, b + 8, f.size);
  }
  wbytes(d, b + 12, fl2);
  wbytes(d, b + 14, exl), b += 16;
  if (ce != null) {
    wbytes(d, b, col);
    wbytes(d, b + 6, f.attrs);
    wbytes(d, b + 10, ce), b += 14;
  }
  d.set(fn, b);
  b += fl2;
  if (exl) {
    for (var k in ex) {
      var exf = ex[k], l = exf.length;
      wbytes(d, b, +k);
      wbytes(d, b + 2, l);
      d.set(exf, b + 4), b += 4 + l;
    }
  }
  if (col)
    d.set(co, b), b += col;
  return b;
};
var wzf = function(o, b, c, d, e) {
  wbytes(o, b, 101010256);
  wbytes(o, b + 8, c);
  wbytes(o, b + 10, c);
  wbytes(o, b + 12, d);
  wbytes(o, b + 16, e);
};
function zipSync(data, opts) {
  if (!opts)
    opts = {};
  var r = {};
  var files = [];
  fltn(data, "", r, opts);
  var o = 0;
  var tot = 0;
  for (var fn in r) {
    var _a2 = r[fn], file = _a2[0], p = _a2[1];
    var compression = p.level == 0 ? 0 : 8;
    var f = strToU8(fn), s = f.length;
    var com = p.comment, m = com && strToU8(com), ms = m && m.length;
    var exl = exfl(p.extra);
    if (s > 65535)
      err(11);
    var d = compression ? deflateSync(file, p) : file, l = d.length;
    var c = crc();
    c.p(file);
    files.push(mrg(p, {
      size: file.length,
      crc: c.d(),
      c: d,
      f,
      m,
      u: s != fn.length || m && com.length != ms,
      o,
      compression
    }));
    o += 30 + s + exl + l;
    tot += 76 + 2 * (s + exl) + (ms || 0) + l;
  }
  var out = new u8(tot + 22), oe = o, cdl = tot - o;
  for (var i = 0; i < files.length; ++i) {
    var f = files[i];
    wzh(out, f.o, f, f.f, f.u, f.c.length);
    var badd = 30 + f.f.length + exfl(f.extra);
    out.set(f.c, f.o + badd);
    wzh(out, o, f, f.f, f.u, f.c.length, f.o, f.m), o += 16 + badd + (f.m ? f.m.length : 0);
  }
  wzf(out, o, files.length, cdl, oe);
  return out;
}

// src/zip.ts
var ZIP_MTIME = new Date(1980, 0, 1);
function zipOutputFiles(files) {
  const entries = Object.fromEntries(files.map((file) => [file.path, strToU8(file.text)]));
  return zipSync(entries, { level: 6, mtime: ZIP_MTIME });
}

// src/download-names.ts
function zipDownloadName(accounts, now = /* @__PURE__ */ new Date()) {
  return `authconv_${zipNameBasis(accounts)}_${localTimestamp(now)}.zip`;
}
function zipNameBasis(accounts) {
  if (accounts.length === 1) {
    return singleAccountBasis(accounts[0]);
  }
  return `${accounts.length}-accounts`;
}
function singleAccountBasis(account) {
  const identity = safeFileSegment2(account.email ?? account.name ?? account.chatgptAccountId ?? account.accountId ?? account.userId ?? "account");
  const accountId = account.chatgptAccountId ?? account.accountId;
  const idSegment = accountId ? safeFileSegment2(accountId.slice(0, 12)) : "";
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
function safeFileSegment2(value) {
  return value.trim().replace(/[^\w\-.]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 96) || "account";
}

// src/cli.ts
var VERSION = "0.1.0";
var CliError = class extends Error {
  constructor(exitCode, message) {
    super(message);
    this.exitCode = exitCode;
  }
};
async function runCli(args, io = {}) {
  const locale = detectCliLocale(scanLocaleArg(args));
  const messages = messagesFor(locale).cli;
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
    const loadedInputs = await readInputs(
      inputPaths,
      parsed.stdin,
      parsed.locale,
      io
    );
    const normalized = normalizeLoadedInputs(loadedInputs, {
      locale: parsed.locale
    });
    if (normalized.accounts.length === 0) {
      return fail(1, [messages.errors.noAccounts, ...normalized.warnings]);
    }
    const visibleWarnings = outputWarnings(normalized, parsed.locale, parsed.allowSyntheticIdToken);
    const formats = resolveFormats(parsed.formatValues, resolveInputFormat(loadedInputs), parsed.locale);
    const files = buildOutputPlan(normalized.accounts, formats, {
      outputModes: effectiveOutputModes(parsed.outputModes, parsed.textMode),
      allowSyntheticIdToken: parsed.allowSyntheticIdToken
    });
    const serializedFiles = serializeOutputFiles(files, parsed.textMode);
    if (parsed.inspect) {
      return info(inspectSummary(normalized, parsed.locale, parsed.allowSyntheticIdToken));
    }
    const outputRoot = path.resolve(cwd, parsed.outDir);
    const zipName = parsed.zip ? zipDownloadName(normalized.accounts) : void 0;
    if (parsed.dryRun) {
      return info(dryRunSummary(
        normalized.accounts.length,
        zipName ? [{ path: zipName, accountCount: normalized.accounts.length }] : serializedFiles,
        visibleWarnings,
        outputRoot,
        parsed.locale
      ));
    }
    if (parsed.stdout) {
      if (formats.length !== 1 || serializedFiles.length !== 1) {
        return fail(2, [messages.errors.stdoutSingleFile]);
      }
      return {
        exitCode: 0,
        stdout: serializedFiles[0].text,
        stderr: humanSummary(normalized.accounts.length, serializedFiles.length, formats, visibleWarnings, void 0, parsed.locale)
      };
    }
    if (zipName) {
      const targetPath = path.join(outputRoot, zipName);
      if (!parsed.force) {
        await assertTargetAvailable(targetPath, parsed.locale);
      }
      await mkdir(outputRoot, { recursive: true });
      await writeFile(targetPath, zipOutputFiles(serializedFiles));
      return {
        exitCode: 0,
        stdout: "",
        stderr: humanSummary(normalized.accounts.length, 1, formats, visibleWarnings, outputRoot, parsed.locale)
      };
    }
    if (!parsed.force) {
      await assertTargetsAvailable(outputRoot, serializedFiles, parsed.locale);
    }
    for (const file of serializedFiles) {
      const targetPath = path.join(outputRoot, file.path);
      await mkdir(path.dirname(targetPath), { recursive: true });
      await writeFile(targetPath, file.text, "utf8");
    }
    return {
      exitCode: 0,
      stdout: "",
      stderr: humanSummary(normalized.accounts.length, serializedFiles.length, formats, visibleWarnings, outputRoot, parsed.locale)
    };
  } catch (error) {
    if (error instanceof CliError) {
      return fail(error.exitCode, [error.message]);
    }
    if (isNodeIoError(error)) {
      return fail(3, [nodeIoMessage(error, locale)]);
    }
    const msg = error instanceof Error ? process.env.DEBUG ? error.stack ?? error.message : error.message : String(error);
    return fail(2, [msg]);
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
    const hasConversionOption = parsed.inputPaths.length > 0 || parsed.stdin || parsed.formatValues.length > 0 || parsed.outDirSpecified || parsed.stdout || parsed.zip || parsed.inspect || parsed.dryRun || parsed.force || parsed.textMode !== "json" || !parsed.allowSyntheticIdToken || Object.keys(parsed.outputModes).length > 0;
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
  const [format, mode, extra] = value.split("=");
  if (!format || !mode || extra !== void 0) {
    throw new CliError(2, messages.errors.invalidModeSyntax(value));
  }
  if (!isOutputFormat(format)) {
    throw new CliError(2, messages.errors.unknownOutputFormat(format));
  }
  if (!isMergeableFormat(format)) {
    throw new CliError(2, messages.errors.unsupportedModeFormat(format));
  }
  if (!isOutputMode(mode)) {
    throw new CliError(2, messages.errors.unknownOutputMode(mode));
  }
  parsed.outputModes[format] = mode;
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
  const candidates = [
    path.join(scriptDir, "index.html"),
    path.join(scriptDir, "..", "dist", "index.html")
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0];
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
async function readInputs(inputPaths, useStdin, locale, io) {
  if (useStdin) {
    const text = io.stdin !== void 0 ? io.stdin : await readStdin();
    return [parseInputText(text, "stdin", "stdin", locale)];
  }
  const inputGroups = await Promise.all(inputPaths.map((inputPath) => readInputPath(inputPath, locale)));
  return inputGroups.flat();
}
async function readInputPath(inputPath, locale) {
  const messages = messagesFor(locale).cli;
  const inputStat = await stat(inputPath);
  if (inputStat.isDirectory()) {
    const entries = await readdir(inputPath, { withFileTypes: true });
    const files = entries.filter((entry) => entry.isFile() && isJsonInputFile(entry.name)).map((entry) => entry.name).sort((left, right) => left.localeCompare(right));
    if (files.length === 0) {
      throw new CliError(3, messages.errors.noInputFiles(inputPath));
    }
    return Promise.all(
      files.map(async (fileName) => {
        const sourcePath = path.join(inputPath, fileName);
        return parseInputText(await readFile(sourcePath, "utf8"), fileName, sourcePath, locale);
      })
    );
  }
  if (!inputStat.isFile()) {
    throw new CliError(3, messages.errors.notFileOrDirectory(inputPath));
  }
  return [parseInputText(await readFile(inputPath, "utf8"), path.basename(inputPath), inputPath, locale)];
}
function isJsonInputFile(fileName) {
  const lowerName = fileName.toLowerCase();
  return lowerName.endsWith(".json") || lowerName.endsWith(".jsonl");
}
function parseInputText(text, sourceName, sourcePath, locale) {
  let input;
  try {
    input = parseInputPayload(text, { locale });
  } catch (error) {
    throw new Error(
      `${sourceName}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  return {
    input,
    sourceName,
    sourcePath,
    inputFormat: detectInputFormat(input)
  };
}
function normalizeLoadedInputs(inputs, options) {
  const results = inputs.map(
    (item) => normalizeInput(item.input, {
      sourceName: item.sourceName,
      sourcePath: item.sourcePath
    }, options)
  );
  const allAccounts = results.flatMap((result) => result.accounts);
  const dedupedAccounts = dedupeAccounts(allAccounts);
  return {
    accounts: dedupedAccounts,
    warnings: results.flatMap((result) => result.warnings),
    inputFormat: resolveInputFormat(inputs)
  };
}
function resolveInputFormat(inputs) {
  return inputs.length > 0 && inputs.every((input) => input.inputFormat === "sub2api") ? "sub2api" : "unknown";
}
function resolveFormats(values, inputFormat, locale) {
  if (values.length > 0) {
    return parseFormatList(values, {
      invalidFormatMessage: messagesFor(locale).cli.errors.unknownOutputFormat
    });
  }
  return parseFormatList(["all"], {
    invalidFormatMessage: messagesFor(locale).cli.errors.unknownOutputFormat
  });
}
function groupWarnings(warnings, locale) {
  const messages = messagesFor(locale).cli.summary;
  const grouped = /* @__PURE__ */ new Map();
  for (const warning of warnings) {
    const match = warning.match(/^(.+?):\s*(.+)$/);
    if (!match) {
      const list2 = grouped.get(warning) || [];
      grouped.set(warning, list2);
      continue;
    }
    const [, source, msg] = match;
    const list = grouped.get(msg) || [];
    list.push(source);
    grouped.set(msg, list);
  }
  return Array.from(grouped.entries()).map(([msg, sources]) => {
    if (sources.length === 0) return msg;
    if (sources.length === 1) return `${sources[0]}: ${msg}`;
    return messages.groupedWarnings(msg, sources);
  });
}
function outputWarnings(result, locale, allowSyntheticIdToken) {
  if (allowSyntheticIdToken) {
    return result.warnings;
  }
  const normalizeMessages = messagesFor(locale).normalize;
  const syntheticWarnings = new Set(
    result.accounts.filter((account) => account.idTokenSynthetic).map((account) => normalizeMessages.syntheticIdToken(account.sourceName))
  );
  return result.warnings.filter((warning) => !syntheticWarnings.has(warning));
}
function humanSummary(accountCount, fileCount, formats, warnings, outputRoot, locale) {
  const messages = messagesFor(locale).cli.summary;
  const formatLabels = formats.map((f) => FORMAT_LABELS[f]).join("/");
  const lines = [messages.human(accountCount, fileCount, formatLabels, outputRoot)];
  for (const warning of groupWarnings(warnings, locale)) {
    lines.push(`${messages.warning}: ${warning}`);
  }
  return `${lines.join("\n")}
`;
}
function inspectSummary(result, locale, allowSyntheticIdToken) {
  const messages = messagesFor(locale).cli.summary;
  const header = messages.inspectColumns;
  const rows = result.accounts.map((account, index) => [
    String(index + 1),
    account.email ?? account.name ?? account.chatgptAccountId ?? account.accountId ?? messages.unknownAccount,
    account.accountId ?? account.chatgptAccountId ?? messages.missingValue,
    account.planType ?? messages.missingValue,
    displayDate(account.expiresAt)
  ]);
  const widths = header.map(
    (cell, col) => Math.max(cell.length, ...rows.map((row) => row[col].length))
  );
  const formatRow = (cells) => cells.map((cell, col) => cell.padEnd(widths[col], " ")).join("  ").trimEnd();
  const lines = [formatRow(header), ...rows.map(formatRow)];
  for (const warning of groupWarnings(outputWarnings(result, locale, allowSyntheticIdToken), locale)) {
    lines.push(`${messages.warning}: ${warning}`);
  }
  return `${lines.join("\n")}
`;
}
function dryRunSummary(accountCount, files, warnings, outputRoot, locale) {
  const messages = messagesFor(locale).cli.summary;
  const lines = [messages.dryRun(accountCount, files.length, outputRoot)];
  for (const file of files) {
    lines.push(messages.fileLine(file.path, file.accountCount));
  }
  for (const warning of groupWarnings(warnings, locale)) {
    lines.push(`${messages.warning}: ${warning}`);
  }
  return `${lines.join("\n")}
`;
}
async function assertTargetsAvailable(outputRoot, files, locale) {
  for (const file of files) {
    await assertTargetAvailable(path.join(outputRoot, file.path), locale);
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
function displayDate(value) {
  return value?.slice(0, 10) || "\u2014";
}
function isOutputMode(value) {
  return value === "merged" || value === "single";
}
function isMergeableFormat(format) {
  return format === "sub2api" || format === "codex2api";
}
function isNodeIoError(error) {
  return error instanceof Error && "code" in error;
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
function info(stderr) {
  return {
    exitCode: 0,
    stdout: "",
    stderr
  };
}
function readStdin() {
  return new Promise((resolve, reject) => {
    let text = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      text += chunk;
    });
    process.stdin.on("end", () => resolve(text));
    process.stdin.on("error", reject);
  });
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
  const result = await runCli(process.argv.slice(2));
  if (result.stdout) {
    process.stdout.write(result.stdout);
  }
  if (result.stderr) {
    process.stderr.write(result.stderr);
  }
  process.exitCode = result.exitCode;
}
export {
  runCli,
  startWebUiServer
};
