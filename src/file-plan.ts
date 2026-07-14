import { renderFormat } from "./renderers.js";
import type {
  BuildOutputPlanOptions,
  NormalizedAccount,
  OutputFile,
  OutputFormat,
  OutputModes,
  OutputTextMode,
  SerializedOutputFile,
} from "./types.js";

const MERGED_FORMATS = new Set<OutputFormat>(["sub2api", "codex2api", "grok"]);
const FORMAT_FILE_PREFIX: Record<OutputFormat, string> = {
  cpa: "cpa",
  sub2api: "sub2api",
  codex2api: "codex2api",
  codexmanager: "codex-manager",
  codex: "codex",
  grok: "grok",
};

export function buildOutputPlan(
  accounts: NormalizedAccount[],
  formats: OutputFormat[],
  options: BuildOutputPlanOptions = {},
): OutputFile[] {
  const used = new Map<string, number>();
  const files: OutputFile[] = [];
  const useFormatFolders = formats.length > 1;

  for (const format of formats) {
    const formatAccounts = accounts.filter((account) => supportsFormat(account, format));
    if (formatAccounts.length === 0) {
      continue;
    }
    const prefix = useFormatFolders ? `${format}/` : "";
    if (MERGED_FORMATS.has(format) && options.outputModes?.[format] !== "single") {
      const name = formatAccounts.length === 1
        ? singleAccountName(format, formatAccounts[0])
        : mergedName(format, formatAccounts.length, "json");
      files.push({
        path: uniquePath(`${prefix}${name}`, used),
        format,
        content: renderFormat(formatAccounts, format, options),
        accountCount: formatAccounts.length,
      });
      continue;
    }

    formatAccounts.forEach((account) => {
      files.push({
        path: uniquePath(`${prefix}${singleAccountName(format, account)}`, used),
        format,
        content: renderFormat([account], format, options),
        accountCount: 1,
      });
    });
  }

  return files;
}

export function filterAccountsForFormats(
  accounts: NormalizedAccount[],
  formats: OutputFormat[],
): NormalizedAccount[] {
  return accounts.filter((account) => formats.some((format) => supportsFormat(account, format)));
}

function supportsFormat(account: NormalizedAccount, format: OutputFormat): boolean {
  if (format === "cpa" || format === "sub2api") {
    return account.provider === "openai" || account.provider === "xai";
  }
  if (format === "grok") {
    return account.provider === "xai";
  }
  return account.provider === "openai";
}

export function outputFileText(file: OutputFile): string {
  return `${JSON.stringify(file.content, null, 2)}\n`;
}

export function serializeOutputFiles(
  files: OutputFile[],
  mode: OutputTextMode = "json",
): SerializedOutputFile[] {
  if (mode === "json") {
    return files.map((file) => ({
      path: file.path,
      format: file.format,
      text: outputFileText(file),
      accountCount: file.accountCount,
    }));
  }

  const grouped = new Map<OutputFormat, OutputFile[]>();
  for (const file of files) {
    grouped.set(file.format, [...(grouped.get(file.format) ?? []), file]);
  }

  const used = new Map<string, number>();
  return [...grouped.entries()].map(([format, formatFiles]) => ({
    path: uniquePath(jsonlPath(formatFiles), used),
    format,
    text: `${formatFiles.map((file) => JSON.stringify(file.content)).join("\n")}\n`,
    accountCount: formatFiles.reduce((sum, file) => sum + file.accountCount, 0),
  }));
}

export function shouldZip(files: Array<{ path: string }>, selectedFormatCount: number): boolean {
  return selectedFormatCount > 1 || files.length > 1;
}

export function effectiveOutputModes(outputModes: OutputModes, outputTextMode: OutputTextMode): OutputModes {
  if (outputTextMode !== "jsonl") {
    return outputModes;
  }
  return {
    ...outputModes,
    sub2api: "single",
    codex2api: "single",
    grok: "single",
  };
}

function jsonlPath(files: OutputFile[]): string {
  const firstPath = files[0]?.path ?? "authconv.json";
  if (files.length === 1) {
    return replaceExtension(firstPath, ".jsonl");
  }

  const firstFile = files[0];
  const directory = firstPath.includes("/") ? `${firstPath.slice(0, firstPath.lastIndexOf("/") + 1)}` : "";
  const totalAccounts = files.reduce((sum, file) => sum + file.accountCount, 0);
  return `${directory}${mergedName(firstFile.format, totalAccounts, "jsonl")}`;
}

function replaceExtension(path: string, nextExtension: string): string {
  return path.replace(/\.[^/.]+$/, nextExtension);
}

function singleAccountName(format: OutputFormat, account: NormalizedAccount): string {
  const identity = safeFileSegment(account.email ?? account.name ?? "unknown");
  const accountId = account.provider === "xai"
    ? account.userId ?? account.principalId
    : account.chatgptAccountId ?? account.accountId;
  const idSegment = accountId ? safeFileSegment(accountId.slice(0, 12)) : "";
  return idSegment
    ? `${FORMAT_FILE_PREFIX[format]}_${identity}_${idSegment}.json`
    : `${FORMAT_FILE_PREFIX[format]}_${identity}.json`;
}

function mergedName(format: OutputFormat, accountCount: number, extension: "json" | "jsonl"): string {
  const suffix = accountCount === 1 ? "account" : "accounts";
  return `${FORMAT_FILE_PREFIX[format]}_${accountCount}-${suffix}.${extension}`;
}

function safeFileSegment(value: string): string {
  const safe = value.trim().replace(/[^\w\-.]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 96);
  return safe || "unknown";
}

function uniquePath(path: string, used: Map<string, number>): string {
  const count = used.get(path) ?? 0;
  used.set(path, count + 1);
  if (count === 0) {
    return path;
  }
  const extension = path.match(/\.[^/.]+$/)?.[0] ?? "";
  if (!extension) {
    return `${path}-${count + 1}`;
  }
  return `${path.slice(0, -extension.length)}-${count + 1}${extension}`;
}
