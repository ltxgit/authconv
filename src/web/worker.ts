/// <reference lib="webworker" />

import {
  AccountStore,
  accountSearchText,
  type AccountListItem,
  type AccountStoreSummary,
} from "../account-store.js";
import { zipDownloadName } from "../download-names.js";
import { applicableFormats, FORMAT_DEFINITIONS, resolveOutputMode } from "../formats.js";
import { commitIngestedAccounts, ingestSources, type IngestionProgress } from "../ingestion.js";
import { parseWebJsonTokens } from "../input-web.js";
import {
  buildExportManifest,
  collectExportEntry,
  streamExport,
  type ExportManifest,
  type ExportManifestEntry,
  type ExportWriter,
} from "../output.js";
import type { IngestionDiagnostic, InputFormat, InputSource, NormalizedAccount } from "../types.js";
import {
  applyAccessTokenVerification,
  reusableAccessTokenVerification,
  TokenVerifier,
  type AccessTokenVerification,
} from "../token-verification.js";
import { jwtPopoverText } from "./jwt-preview.js";
import type {
  AccountScope,
  WorkerOutputPlan,
  WorkerTaskKind,
  WorkerRequest,
  WorkerResponse,
  WorkerSummary,
} from "./worker-protocol.js";

type ActiveTask = {
  requestId: number;
  kind: WorkerTaskKind;
  controller: AbortController;
  settled: Promise<void>;
  settle: () => void;
};

type PreviewTaskKind = Extract<WorkerTaskKind, "previewText" | "preview">;

const worker = self as unknown as DedicatedWorkerGlobalScope;
const store = new AccountStore();
const tokenVerifier = new TokenVerifier();
let draftText = "";
let draftAccounts: NormalizedAccount[] = [];
let draftSearchTexts: string[] = [];
let draftDiagnostics: IngestionDiagnostic[] = [];
let draftDetectedInputFormat: InputFormat = "unknown";
let loadedDiagnostics: IngestionDiagnostic[] = [];
let loadedInputFormat: InputFormat = "unknown";
let activeTask: ActiveTask | undefined;
let latestPreviewRequestId = 0;

/*
 * Worker task contract:
 * - heavy tasks have exclusive ownership of Store mutation/output;
 * - remove/clear cannot mutate Store while any task is active;
 * - preview requests are latest-wins and publish draft state only on success;
 * - cancellation leaves the last completed Store and draft snapshots intact.
 */

worker.addEventListener("message", (event: MessageEvent<WorkerRequest>) => {
  void handle(event.data).catch((error) => {
    if (activeTask?.requestId === event.data.requestId) finishTask(activeTask);
    respond({
      type: "error",
      requestId: event.data.requestId,
      message: errorMessage(error),
      cancelled: isAbortError(error),
      summary: summary(activeScope()),
    });
  });
});

async function handle(request: WorkerRequest): Promise<void> {
  if (request.type === "cancel") {
    latestPreviewRequestId = request.requestId;
    const task = activeTask;
    const cancelledTask = task?.kind;
    task?.controller.abort(new DOMException("Aborted", "AbortError"));
    if (task) await task.settled;
    respond({ type: "cancelResult", requestId: request.requestId, summary: summary(activeScope()), cancelledTask });
    return;
  }

  switch (request.type) {
    case "previewText":
      await previewText(request);
      return;
    case "discardDraft":
      await discardDraft(request);
      return;
    case "commitDraft":
      await commitDraft(request);
      return;
    case "importFiles":
      await importFiles(request);
      return;
    case "reverify":
      await reverifyAccounts(request);
      return;
    case "range": {
      const range = request.scope === "loaded"
        ? store.range(request.offset, request.limit, request.query)
        : draftRange(request.offset, request.limit, request.query);
      respond({ type: "rangeResult", requestId: request.requestId, ...range });
      return;
    }
    case "remove": {
      if (rejectMutationWhileBusy(request.requestId)) return;
      const previousIndex = store.indexOf(request.id);
      store.remove(request.id);
      const suggestedAccountId = previousIndex >= 0
        ? store.idAt(previousIndex) ?? store.idAt(previousIndex - 1)
        : undefined;
      respond({
        type: "removeResult",
        requestId: request.requestId,
        summary: summary(activeScope()),
        suggestedAccountId,
      });
      return;
    }
    case "clear":
      if (rejectMutationWhileBusy(request.requestId)) return;
      store.clear();
      loadedDiagnostics = [];
      loadedInputFormat = "unknown";
      respond({ type: "clearResult", requestId: request.requestId, summary: summary(activeScope()) });
      return;
    case "preview":
      await preview(request);
      return;
    case "decodeJwt":
      respond({ type: "decodeJwtResult", requestId: request.requestId, text: jwtPopoverText(request.token) });
      return;
    case "export":
      await exportAccounts(request);
      return;
  }
}

async function discardDraft(request: Extract<WorkerRequest, { type: "discardDraft" }>): Promise<void> {
  if (activeTask && !isPreviewTask(activeTask.kind)) {
    rejectMutationWhileBusy(request.requestId);
    return;
  }
  latestPreviewRequestId = request.requestId;
  const previewTask = activeTask;
  if (previewTask) {
    previewTask.controller.abort(new DOMException("Discarded", "AbortError"));
    await previewTask.settled;
  }
  if (activeTask && !isPreviewTask(activeTask.kind)) {
    rejectMutationWhileBusy(request.requestId);
    return;
  }
  if (request.requestId !== latestPreviewRequestId) {
    respondCancelled(request.requestId, "Superseded");
    return;
  }
  clearDraft();
  respond({ type: "discardDraftResult", requestId: request.requestId, summary: summary("loaded") });
}

async function previewText(request: Extract<WorkerRequest, { type: "previewText" }>): Promise<void> {
  const task = await startPreviewTask(request.requestId, "previewText");
  if (!task) return;
  try {
    if (!request.text.trim()) {
      clearDraft();
      respond({ type: "previewTextResult", requestId: request.requestId, summary: summary("loaded") });
      return;
    }

    const result = await ingestSources(
      [textSource("draft", "draft", request.text)],
      store,
      {
        parseTokens: parseWebJsonTokens,
        inputFormat: request.inputFormat,
        signal: task.controller.signal,
        verifyTokens: request.verifyTokens,
        discardForged: false,
        tokenVerifier,
        commit: false,
        onProgress: ingestionProgress(request.requestId),
        yieldControl: yieldToEventLoop,
      },
    );
    throwIfTaskSuperseded(task);
    draftText = request.text;
    draftAccounts = result.previewAccounts;
    draftSearchTexts = draftAccounts.map(accountSearchText);
    draftDiagnostics = result.diagnostics;
    draftDetectedInputFormat = result.inputFormat;
    const scope = draftAccounts.length > 0 ? "draft" : "loaded";
    respond({ type: "previewTextResult", requestId: request.requestId, summary: summary(scope) });
  } finally {
    finishTask(task);
  }
}

async function commitDraft(request: Extract<WorkerRequest, { type: "commitDraft" }>): Promise<void> {
  if (!draftText.trim()) {
    respond({
      type: "commitDraftResult",
      requestId: request.requestId,
      summary: summary("loaded"),
      stats: { processed: 0, added: 0, merged: 0, skippedForged: 0 },
    });
    return;
  }
  const task = await startHeavyTask(request.requestId, "commitDraft");
  try {
    throwIfAborted(task.controller.signal);
    const hadLoadedAccounts = store.size > 0;
    const stats = commitIngestedAccounts(store, draftAccounts, request.verifyTokens);
    loadedDiagnostics = hadLoadedAccounts
      ? mergeDiagnostics(loadedDiagnostics, draftDiagnostics)
      : draftDiagnostics;
    loadedInputFormat = hadLoadedAccounts
      ? combineInputFormats(loadedInputFormat, draftDetectedInputFormat)
      : draftDetectedInputFormat;
    clearDraft();
    respond({
      type: "commitDraftResult",
      requestId: request.requestId,
      summary: summary("loaded"),
      stats,
    });
  } finally {
    finishTask(task);
  }
}

async function importFiles(request: Extract<WorkerRequest, { type: "importFiles" }>): Promise<void> {
  const task = await startHeavyTask(request.requestId, "importFiles");
  const baseDiagnostics = loadedDiagnostics;
  const baseInputFormat = loadedInputFormat;
  const baseAccountCount = store.size;
  const importDiagnostics: IngestionDiagnostic[] = [];
  try {
    const sources = request.files
      .sort((left, right) => left.path.localeCompare(right.path))
      .map((item) => fileSource(item, task.controller.signal));
    const result = await ingestSources(sources, store, {
      parseTokens: parseWebJsonTokens,
      signal: task.controller.signal,
      verifyTokens: request.verifyTokens,
      discardForged: request.verifyTokens,
      tokenVerifier,
      onProgress: ingestionProgress(request.requestId),
      yieldControl: yieldToEventLoop,
      onCheckpoint: (checkpoint) => {
        for (const diagnostic of checkpoint.diagnosticsAdded) importDiagnostics.push(diagnostic);
        loadedDiagnostics = mergeDiagnostics(baseDiagnostics, importDiagnostics);
        loadedInputFormat = accumulatedInputFormat(
          baseInputFormat,
          baseAccountCount,
          checkpoint.inputFormat,
          checkpoint.storeChanges.processed,
        );
      },
    });
    loadedDiagnostics = mergeDiagnostics(baseDiagnostics, result.diagnostics);
    loadedInputFormat = accumulatedInputFormat(
      baseInputFormat,
      baseAccountCount,
      result.inputFormat,
      result.storeChanges.processed,
    );
    respond({
      type: "importFilesResult",
      requestId: request.requestId,
      summary: summary(activeScope()),
      stats: result.storeChanges,
    });
  } finally {
    finishTask(task);
  }
}

async function reverifyAccounts(request: Extract<WorkerRequest, { type: "reverify" }>): Promise<void> {
  const task = await startHeavyTask(request.requestId, "reverify");
  try {
    const entries = [...store.entries()];
    const selectedWasLoaded = request.selectedAccountId !== undefined
      && entries.some(([id]) => id === request.selectedAccountId);
    const accounts = [...entries.map(([, account]) => account), ...draftAccounts];
    const results = new Array<AccessTokenVerification>(accounts.length);
    const pendingAccounts: NormalizedAccount[] = [];
    const pendingIndexes: number[] = [];
    for (let index = 0; index < accounts.length; index += 1) {
      const existing = reusableAccessTokenVerification(accounts[index]);
      if (existing) results[index] = existing;
      else {
        pendingAccounts.push(accounts[index]);
        pendingIndexes.push(index);
      }
    }

    const pendingResults = await tokenVerifier.verifyAccounts(pendingAccounts, {
      signal: task.controller.signal,
      yieldControl: yieldToEventLoop,
      onProgress: (completed, total) => respond({
        type: "progress",
        requestId: request.requestId,
        phase: "verify",
        completed,
        total,
      }),
    });
    for (let index = 0; index < pendingResults.length; index += 1) {
      results[pendingIndexes[index]] = pendingResults[index];
    }

    const forgedIds: string[] = [];
    for (let index = 0; index < entries.length; index += 1) {
      const [id, account] = entries[index];
      const result = results[index];
      if (result.verification.status === "forged") {
        forgedIds.push(id);
        continue;
      }
      store.updateAccessTokenVerification(
        id,
        { accessToken: account.accessToken },
        result.verification,
        result.context,
      );
    }
    store.removeMany(forgedIds);
    for (let index = 0; index < draftAccounts.length; index += 1) {
      applyAccessTokenVerification(draftAccounts[index], results[entries.length + index]);
    }
    draftSearchTexts = draftAccounts.map(accountSearchText);
    const selectedAccountRemoved = request.selectedAccountId
      ? selectedWasLoaded && !store.get(request.selectedAccountId)
      : false;
    respond({
      type: "reverifyResult",
      requestId: request.requestId,
      summary: summary(activeScope()),
      selectedAccountRemoved,
    });
  } finally {
    tokenVerifier.clearResultCache();
    finishTask(task);
  }
}

async function preview(request: Extract<WorkerRequest, { type: "preview" }>): Promise<void> {
  const task = await startPreviewTask(request.requestId, "preview");
  if (!task) return;
  try {
    throwIfTaskSuperseded(task);
    const accounts = activeAccounts();
    const manifest = buildExportManifest(accounts, {
      formats: request.formats,
      outputModes: request.outputModes,
      textMode: request.textMode,
      verifyTokens: request.verifyTokens,
    });
    manifest.archive = manifest.formats.length > 1 || manifest.entries.length > 1;
    const outputPlan = planFromManifest(manifest, request.textMode);
    const format = manifest.formats.includes(request.previewFormat)
      ? request.previewFormat
      : manifest.formats[0] ?? (request.formats.includes(request.previewFormat) ? request.previewFormat : request.formats[0]);
    const formatEntries = format ? manifest.entries.filter((entry) => entry.format === format) : [];
    const perAccount = format !== undefined && (
      request.textMode === "jsonl" || resolveOutputMode(format, request.outputModes[format]) === "single"
    );
    const selectedId = request.selectedAccountId;
    const selectedAccount = selectedId && perAccount ? accounts.get(selectedId) : undefined;
    const selectedAccountApplies = selectedAccount && format
      ? (FORMAT_DEFINITIONS[format].providers as readonly string[]).includes(selectedAccount.provider)
      : false;
    if (
      request.verifyTokens
      && selectedAccountApplies
      && selectedAccount?.tokenVerification
      && selectedAccount.tokenVerification.status !== "verified"
    ) {
      respond({
        type: "previewResult",
        requestId: request.requestId,
        text: "",
        path: "",
        shownAccounts: 0,
        totalAccounts: 0,
        format,
        selectedAccountId: selectedId ?? undefined,
        outputPlan,
        blockedVerification: selectedAccount.tokenVerification,
      });
      return;
    }
    if (manifest.entries.length === 0) {
      respond({
        type: "previewResult",
        requestId: request.requestId,
        text: "",
        path: "",
        shownAccounts: 0,
        totalAccounts: 0,
        outputPlan,
      });
      return;
    }
    const selected = selectPreviewEntry(
      formatEntries,
      request.selectedAccountId,
      request.textMode,
    );
    if (!selected) {
      respond({
        type: "previewResult",
        requestId: request.requestId,
        text: "",
        path: "",
        shownAccounts: 0,
        totalAccounts: 0,
        format,
        outputPlan,
      });
      return;
    }

    const totalAccounts = selected.accountCount;
    const previewEntry = selected.accountCount > 100
      ? { ...selected, accountIds: selected.accountIds.slice(0, 100), accountCount: 100 }
      : selected;
    const text = await collectExportEntry(accounts, previewEntry, {
      includeRefreshToken: request.includeRefreshToken,
      allowSyntheticIdToken: request.allowSyntheticIdToken,
      signal: task.controller.signal,
    });
    throwIfTaskSuperseded(task);
    respond({
      type: "previewResult",
      requestId: request.requestId,
      text,
      path: selected.path,
      shownAccounts: previewEntry.accountCount,
      totalAccounts,
      format,
      selectedAccountId: perAccount && previewEntry.accountIds.length === 1
        ? previewEntry.accountIds[0]
        : undefined,
      outputPlan,
    });
  } finally {
    finishTask(task);
  }
}

async function exportAccounts(request: Extract<WorkerRequest, { type: "export" }>): Promise<void> {
  const task = await startHeavyTask(request.requestId, "export");
  try {
    const accounts = activeAccounts();
    const manifest = buildExportManifest(accounts, {
      formats: request.formats,
      outputModes: request.outputModes,
      textMode: request.textMode,
      verifyTokens: request.verifyTokens,
    });
    manifest.archive = manifest.formats.length > 1 || manifest.entries.length > 1;
    if (manifest.entries.length === 0) throw new Error("No exportable accounts");

    const writer = transferWriter(request.requestId);
    await streamExport(accounts, manifest, {
      openFile: async () => writer,
      openArchive: async () => writer,
    }, {
      signal: task.controller.signal,
      includeRefreshToken: request.includeRefreshToken,
      allowSyntheticIdToken: request.allowSyntheticIdToken,
      onProgress: (progress) => respond({
        type: "progress",
        requestId: request.requestId,
        phase: "export",
        completed: progress.completedAccounts,
        total: progress.totalAccounts,
      }),
    });

    const exportedAccounts = exportedAccountsFromManifest(accounts, manifest.entries);
    const name = manifest.archive
      ? zipDownloadName(exportedAccounts)
      : manifest.entries[0].path.split("/").pop() ?? "authconv.json";
    respond({
      type: "exportResult",
      requestId: request.requestId,
      name,
      mime: manifest.archive ? "application/zip" : request.textMode === "jsonl" ? "application/x-ndjson" : "application/json",
      accountCount: manifest.accountCount,
    });
  } finally {
    finishTask(task);
  }
}

function selectPreviewEntry(
  entries: ExportManifestEntry[],
  selectedAccountId: string | null | undefined,
  textMode: string,
): ExportManifestEntry | undefined {
  if (selectedAccountId === null) return undefined;
  const perAccount = perAccountPreview(entries, textMode);
  if (!perAccount) return entries[0];

  if (selectedAccountId) {
    const byId = entries.find((entry) => entry.accountIds.includes(selectedAccountId));
    if (byId) return singleAccountPreviewEntry(byId, selectedAccountId);
  }

  const fallback = entries[0];
  const fallbackId = fallback?.accountIds[0];
  return fallback && fallbackId ? singleAccountPreviewEntry(fallback, fallbackId) : undefined;
}

function perAccountPreview(entries: ExportManifestEntry[], textMode: string): boolean {
  return textMode === "jsonl" || entries.some((entry) => entry.mode === "single");
}

function singleAccountPreviewEntry(entry: ExportManifestEntry, accountId: string): ExportManifestEntry {
  if (entry.accountIds.length === 1) return entry;
  return { ...entry, accountIds: [accountId], accountCount: 1 };
}

function planFromManifest(
  manifest: ExportManifest,
  textMode: "json" | "jsonl",
): WorkerOutputPlan {
  return {
    accountCount: manifest.accountCount,
    fileCount: manifest.entries.length,
    formats: manifest.formats,
    rejectedAccountCount: manifest.rejectedAccountCount,
    outputType: manifest.archive ? "zip" : textMode,
  };
}

function exportedAccountsFromManifest(
  source: ReturnType<typeof activeAccounts>,
  entries: ExportManifestEntry[],
): NormalizedAccount[] {
  const accounts: NormalizedAccount[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    for (const id of entry.accountIds) {
      if (seen.has(id)) continue;
      seen.add(id);
      const account = source.get(id);
      if (account) accounts.push(account);
    }
  }
  return accounts;
}

function summary(scope: AccountScope): WorkerSummary {
  const loaded = store.summary();
  const active = scope === "draft" ? summarize(draftAccounts) : loaded;
  const activeAccounts = scope === "draft" ? draftAccounts : store.values();
  const hasDraftText = draftText.trim().length > 0;
  return {
    scope,
    loaded,
    active,
    applicableFormats: applicableFormats(activeAccounts),
    diagnostics: hasDraftText ? mergeDiagnostics(loadedDiagnostics, draftDiagnostics) : loadedDiagnostics,
    inputFormat: hasDraftText && store.size > 0
      ? combineInputFormats(loadedInputFormat, draftDetectedInputFormat)
      : hasDraftText ? draftDetectedInputFormat : loadedInputFormat,
  };
}

function mergeDiagnostics(
  loaded: IngestionDiagnostic[],
  draft: IngestionDiagnostic[],
): IngestionDiagnostic[] {
  if (loaded.length === 0) return draft;
  if (draft.length === 0) return loaded;
  return loaded.concat(draft);
}

function combineInputFormats(left: InputFormat, right: InputFormat): InputFormat {
  return left === right ? left : "unknown";
}

function accumulatedInputFormat(
  base: InputFormat,
  baseAccountCount: number,
  imported: InputFormat,
  importedAccountCount: number,
): InputFormat {
  if (importedAccountCount === 0) return base;
  if (baseAccountCount === 0) return imported;
  return combineInputFormats(base, imported);
}

function activeScope(): AccountScope {
  return draftAccounts.length > 0 ? "draft" : "loaded";
}

function summarize(accounts: NormalizedAccount[]): AccountStoreSummary {
  let planCount = 0;
  let expiredCount = 0;
  const providerCounts = { openai: 0, xai: 0, unknown: 0 };
  const verificationCounts = { verified: 0, forged: 0, unverifiable: 0, unchecked: 0 };
  const providerVerificationCounts = {
    openai: { verified: 0, forged: 0, unverifiable: 0, unchecked: 0 },
    xai: { verified: 0, forged: 0, unverifiable: 0, unchecked: 0 },
    unknown: { verified: 0, forged: 0, unverifiable: 0, unchecked: 0 },
  };
  for (const account of accounts) {
    providerCounts[account.provider] += 1;
    if (account.provider === "openai" && account.planType?.trim()) planCount += 1;
    if (account.expiresAt && Date.parse(account.expiresAt) <= Date.now()) expiredCount += 1;
    if (account.tokenVerification) {
      verificationCounts[account.tokenVerification.status] += 1;
      providerVerificationCounts[account.provider][account.tokenVerification.status] += 1;
    }
  }
  return {
    total: accounts.length,
    providerCounts,
    planCount,
    expiredCount,
    verificationCounts,
    providerVerificationCounts,
  };
}

function draftRange(offset: number, limit: number, query: string) {
  const needle = query.trim().toLowerCase();
  const items: AccountListItem[] = [];
  let matched = 0;
  let index = 0;
  for (let sourceIndex = 0; sourceIndex < draftAccounts.length; sourceIndex += 1) {
    if (needle && !draftSearchTexts[sourceIndex].includes(needle)) continue;
    if (matched >= offset && items.length < limit) {
      items.push(listItem(`draft-${sourceIndex}`, index, draftAccounts[sourceIndex]));
    }
    matched += 1;
    index += 1;
  }
  return { total: matched, offset, items };
}

function listItem(id: string, index: number, account: NormalizedAccount): AccountListItem {
  const openAi = account.provider === "openai" ? account : undefined;
  return {
    id,
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

function activeAccounts() {
  if (activeScope() === "loaded") return store;
  return {
    *entries(): IterableIterator<[string, NormalizedAccount]> {
      for (let index = 0; index < draftAccounts.length; index += 1) {
        yield [`draft-${index}`, draftAccounts[index]];
      }
    },
    get(id: string): NormalizedAccount | undefined {
      const match = /^draft-(\d+)$/.exec(id);
      return match ? draftAccounts[Number(match[1])] : undefined;
    },
  };
}

function textSource(name: string, path: string, text: string): InputSource {
  return {
    name,
    path,
    chunks: oneChunk(new TextEncoder().encode(text)),
  };
}

function fileSource(item: { file: File; path: string }, signal: AbortSignal): InputSource {
  const chunks = new FileChunks(item.file, signal);
  return {
    name: item.path.split("/").pop() ?? item.path,
    path: item.path,
    chunks,
    cancel: (reason) => chunks.cancel(reason),
  };
}

class FileChunks implements AsyncIterable<Uint8Array> {
  readonly #file: File;
  readonly #signal: AbortSignal;
  #reader?: ReadableStreamDefaultReader<Uint8Array>;
  #cancelled = false;
  #cancelReason: unknown;

  constructor(file: File, signal: AbortSignal) {
    this.#file = file;
    this.#signal = signal;
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<Uint8Array> {
    const reader = this.#file.stream().getReader();
    this.#reader = reader;
    const abort = () => { void reader.cancel(this.#signal.reason).catch(() => undefined); };
    this.#signal.addEventListener("abort", abort, { once: true });
    try {
      if (this.#cancelled) {
        await reader.cancel(this.#cancelReason).catch(() => undefined);
        return;
      }
      for (;;) {
        const result = await reader.read();
        if (this.#signal.aborted) {
          throw this.#signal.reason ?? new DOMException("Aborted", "AbortError");
        }
        if (this.#cancelled || result.done) return;
        yield result.value;
      }
    } finally {
      this.#signal.removeEventListener("abort", abort);
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
      if (this.#reader === reader) this.#reader = undefined;
    }
  }

  async cancel(reason?: unknown): Promise<void> {
    this.#cancelled = true;
    this.#cancelReason = reason;
    await this.#reader?.cancel(reason).catch(() => undefined);
  }
}

async function* oneChunk(chunk: Uint8Array): AsyncGenerator<Uint8Array> {
  yield chunk;
}

function transferWriter(requestId: number): ExportWriter {
  let chunks = 0;
  return {
    write(chunk) {
      const transferable = chunk.byteOffset === 0 && chunk.byteLength === chunk.buffer.byteLength
        ? chunk.buffer as ArrayBuffer
        : chunk.slice().buffer as ArrayBuffer;
      respond({ type: "exportChunk", requestId, chunk: transferable }, [transferable]);
      chunks += 1;
      if (chunks % 128 === 0) return yieldToEventLoop();
    },
    close: () => undefined,
    abort: () => undefined,
  };
}

function ingestionProgress(requestId: number) {
  let last = 0;
  return (progress: IngestionProgress) => {
    const now = performance.now();
    if (now - last < 100 && progress.phase !== "verify") return;
    last = now;
    respond({
      type: "progress",
      requestId,
      phase: progress.phase,
      completed: progress.phase === "verify" ? progress.verifiedCandidates : progress.processedCandidates,
      total: progress.phase === "verify" ? progress.processedCandidates : undefined,
    });
  };
}

function startTask(requestId: number, kind: WorkerTaskKind): ActiveTask {
  if (activeTask) throw new Error("Another import or export is running");
  const task = createTask(requestId, kind);
  activeTask = task;
  return task;
}

async function startPreviewTask(requestId: number, kind: PreviewTaskKind): Promise<ActiveTask | undefined> {
  if (activeTask && !isPreviewTask(activeTask.kind)) {
    respond({
      type: "error",
      requestId,
      message: "Another import or export is running",
      cancelled: false,
    });
    return undefined;
  }
  if (kind === "preview" && activeTask?.kind === "previewText") {
    respondCancelled(requestId, "Draft preview is running");
    return undefined;
  }

  latestPreviewRequestId = requestId;
  const previous = activeTask;
  if (previous) {
    previous.controller.abort(new DOMException("Superseded", "AbortError"));
    await previous.settled;
  }
  if (activeTask && !isPreviewTask(activeTask.kind)) {
    respondCancelled(requestId, "Superseded");
    return undefined;
  }
  if (requestId !== latestPreviewRequestId) {
    respondCancelled(requestId, "Superseded");
    return undefined;
  }
  return startTask(requestId, kind);
}

async function startHeavyTask(
  requestId: number,
  kind: Exclude<WorkerTaskKind, PreviewTaskKind>,
): Promise<ActiveTask> {
  if (activeTask && !isPreviewTask(activeTask.kind)) {
    throw new Error("Another import or export is running");
  }
  const previewTask = activeTask;
  const task = createTask(requestId, kind);
  activeTask = task;
  if (previewTask) {
    previewTask.controller.abort(new DOMException("Superseded", "AbortError"));
    await previewTask.settled;
  }
  return task;
}

function isPreviewTask(kind: WorkerTaskKind): kind is PreviewTaskKind {
  return kind === "previewText" || kind === "preview";
}

function createTask(requestId: number, kind: WorkerTaskKind): ActiveTask {
  let settle: () => void = () => undefined;
  const settled = new Promise<void>((resolve) => {
    settle = resolve;
  });
  return { requestId, kind, controller: new AbortController(), settled, settle };
}

function finishTask(task: ActiveTask): void {
  if (activeTask?.requestId === task.requestId) activeTask = undefined;
  task.settle();
}

function clearDraft(): void {
  draftText = "";
  draftAccounts = [];
  draftSearchTexts = [];
  draftDiagnostics = [];
  draftDetectedInputFormat = "unknown";
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function rejectMutationWhileBusy(requestId: number): boolean {
  if (!activeTask) return false;
  respond({
    type: "error",
    requestId,
    message: "Another import or export is running",
    cancelled: false,
    summary: summary(activeScope()),
  });
  return true;
}

function respondCancelled(requestId: number, message: string): void {
  respond({
    type: "error",
    requestId,
    message,
    cancelled: true,
    summary: summary(activeScope()),
  });
}

function throwIfTaskSuperseded(task: ActiveTask): void {
  if (task.controller.signal.aborted || task.requestId !== latestPreviewRequestId) {
    throw task.controller.signal.reason ?? new DOMException("Superseded", "AbortError");
  }
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
}

function respond(message: WorkerResponse, transfer?: Transferable[]): void {
  worker.postMessage(message, transfer ?? []);
}
