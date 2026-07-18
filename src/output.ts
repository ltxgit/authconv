import { ZipWriter } from "@zip.js/zip.js/lib/zip-core-writer.js";
import { ALL_FORMATS, FORMAT_DEFINITIONS, resolveOutputMode } from "./formats.js";
import {
  grok2ApiStorageKey,
  renderCodex2ApiAccount,
  renderCodexAuth,
  renderCodexManagerAccount,
  renderCpaAccount,
  renderGrok2ApiEntry,
  renderGrokEntry,
  renderSub2ApiAccount,
} from "./renderers.js";
import type {
  NormalizedAccount,
  OpenAINormalizedAccount,
  OutputFormat,
  OutputMode,
  OutputModes,
  OutputTextMode,
  RenderOptions,
  TokenVerificationReason,
  XaiNormalizedAccount,
} from "./types.js";

const ZIP_MTIME = new Date(1980, 0, 1);
const encoder = new TextEncoder();

export type ExportRequest = {
  formats: readonly OutputFormat[];
  outputModes?: OutputModes;
  textMode?: OutputTextMode;
  forceZip?: boolean;
  accountIds?: readonly string[];
  verifyTokens?: boolean;
};

export type ExportManifestEntry = {
  path: string;
  format: OutputFormat;
  mode: OutputMode | "jsonl";
  accountIds: string[];
  accountCount: number;
};

export type ExportManifest = {
  entries: ExportManifestEntry[];
  formats: OutputFormat[];
  unavailableFormats: OutputFormat[];
  accountCount: number;
  rejectedAccountCount: number;
  rejectionReasons: Partial<Record<TokenVerificationReason, number>>;
  archive: boolean;
};

export type ExportWriter = {
  write: (chunk: Uint8Array) => void | Promise<void>;
  close: () => void | Promise<void>;
  abort: (error: unknown) => void | Promise<void>;
};

export type ExportSink = {
  openFile: (path: string) => Promise<ExportWriter>;
  openArchive: () => Promise<ExportWriter>;
};

export type ExportProgress = {
  completedEntries: number;
  totalEntries: number;
  completedAccounts: number;
  totalAccounts: number;
  currentPath?: string;
};

export type StreamExportOptions = RenderOptions & {
  signal?: AbortSignal;
  onProgress?: (progress: ExportProgress) => void;
};

export type ExportResult = {
  completedEntries: number;
  completedAccounts: number;
};

export type AccountCollection = {
  entries: () => IterableIterator<[string, NormalizedAccount]>;
  get: (id: string) => NormalizedAccount | undefined;
};

export function buildExportManifest(store: AccountCollection, request: ExportRequest): ExportManifest {
  const textMode = request.textMode ?? "json";
  for (const format of ALL_FORMATS) {
    const requestedMode = request.outputModes?.[format];
    if (requestedMode !== undefined) resolveOutputMode(format, requestedMode);
  }
  const usedPaths = new Set<string>();
  const nextPathSuffix = new Map<string, number>();
  const formatAccounts = new Map<OutputFormat, string[]>();
  const requestedIds = request.accountIds ? [...new Set(request.accountIds)] : undefined;
  const candidateEntries: Array<[string, NormalizedAccount]> = [];
  if (requestedIds) {
    for (const id of requestedIds) {
      const account = store.get(id);
      if (account) candidateEntries.push([id, account]);
    }
  } else {
    for (const entry of store.entries()) candidateEntries.push(entry);
  }
  const acceptedEntries: Array<[string, NormalizedAccount]> = [];
  const rejectionReasons: Partial<Record<TokenVerificationReason, number>> = {};
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
  const entries: ExportManifestEntry[] = [];

  for (const format of formats) {
    const accountIds = formatAccounts.get(format)!;
    const directory = useFormatFolders ? `${format}/` : "";
    if (textMode === "jsonl") {
      const basePath = accountIds.length === 1
        ? singleAccountName(format, requireAccount(store, accountIds[0]))
        : mergedName(format, accountIds.length, "jsonl");
      entries.push({
        path: uniquePath(`${directory}${replaceExtension(basePath, ".jsonl")}`, usedPaths, nextPathSuffix),
        format,
        mode: "jsonl",
        accountIds,
        accountCount: accountIds.length,
      });
      continue;
    }

    const mode = resolveOutputMode(format, request.outputModes?.[format]);
    if (mode === "merged") {
      const name = accountIds.length === 1
        ? singleAccountName(format, requireAccount(store, accountIds[0]))
        : mergedName(format, accountIds.length, "json");
      entries.push({
        path: uniquePath(`${directory}${name}`, usedPaths, nextPathSuffix),
        format,
        mode,
        accountIds,
        accountCount: accountIds.length,
      });
      continue;
    }

    for (const id of accountIds) {
      entries.push({
        path: uniquePath(
          `${directory}${singleAccountName(format, requireAccount(store, id))}`,
          usedPaths,
          nextPathSuffix,
        ),
        format,
        mode: "single",
        accountIds: [id],
        accountCount: 1,
      });
    }
  }

  const exportedIds = new Set<string>();
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
    archive: request.forceZip === true,
  };
}

function accountIdsForFormat(
  format: OutputFormat,
  entries: Array<[string, NormalizedAccount]>,
  textMode: OutputTextMode,
): string[] {
  const applicable = entries.filter(([, account]) =>
    FORMAT_DEFINITIONS[format].providers.includes(account.provider as never));
  if (format !== "grok2api" || textMode === "jsonl") return applicable.map(([id]) => id);

  const byStorageKey = new Map<string, string>();
  for (const [id, account] of applicable) {
    if (account.provider === "xai") byStorageKey.set(grok2ApiStorageKey(account), id);
  }
  return [...byStorageKey.values()];
}

export async function streamExport(
  store: AccountCollection,
  manifest: ExportManifest,
  sink: ExportSink,
  options: StreamExportOptions = {},
): Promise<ExportResult> {
  if (manifest.entries.length === 0) return { completedEntries: 0, completedAccounts: 0 };
  const now = options.now ?? new Date();
  const renderOptions: RenderOptions = {
    now,
    includeRefreshToken: options.includeRefreshToken,
    allowSyntheticIdToken: options.allowSyntheticIdToken,
  };
  let completedEntries = 0;
  let completedAccounts = 0;
  const totalAccounts = manifest.entries.reduce((sum, entry) => sum + entry.accountCount, 0);

  if (manifest.archive) {
    const writer = await sink.openArchive();
    let writerFinished = false;
    const output = new WritableStream<Uint8Array>({
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
      },
    });
    /*
     * Archive data flow:
     * renderEntry() -> one ReadableStream per manifest entry -> ZipWriter
     * -> the caller-owned ExportWriter. ZIP64 is always enabled so the same
     * path remains valid when single-file formats exceed 65,535 entries.
     */
    const zip = new ZipWriter(output, {
      zip64: true,
      level: 6,
      extendedTimestamp: false,
      useWebWorkers: false,
    });
    try {
      for (const entry of manifest.entries) {
        throwIfAborted(options.signal);
        await zip.add(
          entry.path,
          readableFrom(renderEntry(store, entry, renderOptions, options.signal)),
          {
            zip64: false,
            lastModDate: ZIP_MTIME,
            extendedTimestamp: false,
            signal: options.signal,
          },
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
    throwIfAborted(options.signal);
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

  function report(currentPath: string): void {
    options.onProgress?.({
      completedEntries,
      totalEntries: manifest.entries.length,
      completedAccounts,
      totalAccounts,
      currentPath,
    });
  }
}

export async function collectExportEntry(
  store: AccountCollection,
  entry: ExportManifestEntry,
  options: StreamExportOptions = {},
): Promise<string> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of renderEntry(store, entry, { ...options, now: options.now ?? new Date() }, options.signal)) {
    chunks.push(chunk);
  }
  return new TextDecoder().decode(concatBytes(chunks));
}

async function* renderEntry(
  store: AccountCollection,
  entry: ExportManifestEntry,
  options: RenderOptions,
  signal?: AbortSignal,
): AsyncGenerator<Uint8Array> {
  if (entry.mode === "jsonl") {
    for (const id of entry.accountIds) {
      throwIfAborted(signal);
      const account = requireAccount(store, id);
      yield encoder.encode(`${JSON.stringify(renderSingleFile(account, entry.format, options))}\n`);
    }
    return;
  }
  if (entry.mode === "single") {
    const account = requireAccount(store, entry.accountIds[0]);
    yield encoder.encode(`${JSON.stringify(renderSingleFile(account, entry.format, options), null, 2)}\n`);
    return;
  }
  yield* renderMerged(store, entry.accountIds, entry.format, options, signal);
}

function renderSingleFile(account: NormalizedAccount, format: OutputFormat, options: RenderOptions): unknown {
  switch (format) {
    case "cpa": return renderCpaAccount(requireKnownProvider(account, format), options);
    case "sub2api": return sub2ApiDocument([requireKnownProvider(account, format)], options);
    case "codex2api": return [renderCodex2ApiAccount(requireOpenAI(account, format), options)];
    case "codexmanager": return renderCodexManagerAccount(requireOpenAI(account, format), options);
    case "codex": return renderCodexAuth(requireOpenAI(account, format), options);
    case "grok": return Object.fromEntries([renderGrokEntry(requireXai(account, format), options)]);
    case "grok2api": return Object.fromEntries([renderGrok2ApiEntry(requireXai(account, format), options)]);
  }
}

async function* renderMerged(
  store: AccountCollection,
  accountIds: readonly string[],
  format: OutputFormat,
  options: RenderOptions,
  signal?: AbortSignal,
): AsyncGenerator<Uint8Array> {
  if (format === "sub2api") {
    const header = {
      type: "sub2api-data",
      version: 1,
      exported_at: (options.now ?? new Date()).toISOString(),
      proxies: [],
    };
    const prefix = JSON.stringify(header, null, 2).replace(/\n}/, ',\n  "accounts": [');
    yield encoder.encode(`${prefix}\n`);
    for (let index = 0; index < accountIds.length; index += 1) {
      throwIfAborted(signal);
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
      throwIfAborted(signal);
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
      throwIfAborted(signal);
      const account = requireAccount(store, accountIds[index]);
      const [key, value] = renderGrok2ApiEntry(requireXai(account, format), options);
      const property = `${JSON.stringify(key)}: ${JSON.stringify(value, null, 2)}`.replace(/\n/g, "\n  ");
      yield encoder.encode(`  ${property}${index + 1 < accountIds.length ? "," : ""}\n`);
    }
    yield encoder.encode("}\n");
    return;
  }
  throw new Error(`Format ${format} does not support merged output`);
}

function sub2ApiDocument(
  accounts: Array<OpenAINormalizedAccount | XaiNormalizedAccount>,
  options: RenderOptions,
): unknown {
  return {
    type: "sub2api-data",
    version: 1,
    exported_at: (options.now ?? new Date()).toISOString(),
    proxies: [],
    accounts: accounts.map((account) => renderSub2ApiAccount(account, options)),
  };
}

function indentJson(value: unknown, spaces: number): string {
  const prefix = " ".repeat(spaces);
  return JSON.stringify(value, null, 2).split("\n").map((line) => `${prefix}${line}`).join("\n");
}

function singleAccountName(format: OutputFormat, account: NormalizedAccount): string {
  const identity = safeFileSegment(account.email ?? account.name ?? "unknown");
  const stableId = account.provider === "xai"
    ? account.userId ?? account.principalId
    : account.provider === "openai"
      ? account.chatgptAccountId ?? account.accountId
      : undefined;
  const id = stableId ? safeFileSegment(stableId.slice(0, 12)) : "";
  const prefix = FORMAT_DEFINITIONS[format].filePrefix;
  return id ? `${prefix}_${identity}_${id}.json` : `${prefix}_${identity}.json`;
}

function mergedName(format: OutputFormat, count: number, extension: "json" | "jsonl"): string {
  return `${FORMAT_DEFINITIONS[format].filePrefix}_${count}-${count === 1 ? "account" : "accounts"}.${extension}`;
}

function safeFileSegment(value: string): string {
  return value.trim().replace(/[^\w\-.]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 96) || "unknown";
}

function replaceExtension(path: string, extension: string): string {
  return path.replace(/\.[^/.]+$/, extension);
}

function uniquePath(path: string, used: Set<string>, nextSuffix: Map<string, number>): string {
  if (!used.has(path)) {
    used.add(path);
    return path;
  }
  const extension = path.match(/\.[^/.]+$/)?.[0] ?? "";
  const stem = extension ? path.slice(0, -extension.length) : path;
  let suffix = nextSuffix.get(path) ?? 2;
  while (true) {
    const candidate = `${stem}-${suffix}${extension}`;
    suffix += 1;
    if (used.has(candidate)) continue;
    nextSuffix.set(path, suffix);
    used.add(candidate);
    return candidate;
  }
}

function requireAccount(store: AccountCollection, id: string): NormalizedAccount {
  const account = store.get(id);
  if (!account) throw new Error(`Export manifest references missing account: ${id}`);
  return account;
}

function requireKnownProvider(
  account: NormalizedAccount,
  format: OutputFormat,
): OpenAINormalizedAccount | XaiNormalizedAccount {
  if (account.provider === "unknown") throw new Error(`Format ${format} cannot render an unknown provider`);
  return account;
}

function requireOpenAI(account: NormalizedAccount, format: OutputFormat): OpenAINormalizedAccount {
  if (account.provider !== "openai") throw new Error(`Format ${format} requires an OpenAI account`);
  return account;
}

function requireXai(account: NormalizedAccount, format: OutputFormat): XaiNormalizedAccount {
  if (account.provider !== "xai") throw new Error(`Format ${format} requires an xAI account`);
  return account;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
}

function concatBytes(chunks: Uint8Array[]): Uint8Array {
  const output = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function readableFrom(source: AsyncIterable<Uint8Array>): ReadableStream<Uint8Array> {
  const iterator = source[Symbol.asyncIterator]();
  return new ReadableStream<Uint8Array>({
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
    },
  });
}
