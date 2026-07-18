import type { InputFormat, OutputFormat } from "../types.js";
import { ALL_FORMATS } from "../formats.js";
import { detectWebLocale, messagesFor, normalizeLocale } from "../i18n.js";
import type { AccountStoreSummary } from "../account-store.js";
import { outputOptionsUrl, parseOutputOptionsSearch } from "./url-state.js";
import {
  readStoredPreferences,
  writeStoredPreferences,
  type WebPreferences,
} from "./preferences.js";
import { AuthconvWorkerClient, type WorkerClientResponse, type WorkerRequestError } from "./worker-client.js";
import type {
  AccountScope,
  WorkerFile,
  WorkerOutputPlan,
  WorkerProgress,
  WorkerSummary,
} from "./worker-protocol.js";
import {
  accountRowSelectable,
  accountRowsSelectable,
  effectiveFormats as selectEffectiveFormats,
  highlightJson,
  selectAccountForRange,
  shouldRequireVisibleSelection,
  shouldResetViewportForPreferredAccount,
  WebView,
  type WebViewState,
} from "./view.js";

const SESSION_URL = "https://chatgpt.com/api/auth/session";
const ROW_HEIGHT = 52;
const ROW_OVERSCAN = 6;
const RANGE_LIMIT = 20;

type FileSystemFileHandleLike = { kind: "file"; name: string; getFile: () => Promise<File> };
type FileSystemDirectoryHandleLike = {
  kind: "directory";
  name: string;
  values?: () => AsyncIterable<FileSystemHandleLike>;
  entries?: () => AsyncIterable<[string, FileSystemHandleLike]>;
};
type FileSystemHandleLike = FileSystemFileHandleLike | FileSystemDirectoryHandleLike;
type WindowWithDirectoryPicker = Window & { showDirectoryPicker?: () => Promise<FileSystemDirectoryHandleLike> };
type DataTransferItemWithHandle = DataTransferItem & { getAsFileSystemHandle?: () => Promise<FileSystemHandleLike | null> };
type FileSystemEntryLike = {
  name: string;
  fullPath?: string;
  isFile: boolean;
  isDirectory: boolean;
};
type FileEntryLike = FileSystemEntryLike & {
  isFile: true;
  file: (success: (file: File) => void, failure?: (error: DOMException) => void) => void;
};
type DirectoryEntryLike = FileSystemEntryLike & {
  isDirectory: true;
  createReader: () => {
    readEntries: (success: (entries: FileSystemEntryLike[]) => void, failure?: (error: DOMException) => void) => void;
  };
};
type DataTransferItemWithEntry = DataTransferItem & { webkitGetAsEntry?: () => FileSystemEntryLike | null };

const emptySummary: AccountStoreSummary = {
  total: 0,
  providerCounts: { openai: 0, xai: 0, unknown: 0 },
  planCount: 0,
  expiredCount: 0,
  verificationCounts: { verified: 0, forged: 0, unverifiable: 0, unchecked: 0 },
  providerVerificationCounts: {
    openai: { verified: 0, forged: 0, unverifiable: 0, unchecked: 0 },
    xai: { verified: 0, forged: 0, unverifiable: 0, unchecked: 0 },
    unknown: { verified: 0, forged: 0, unverifiable: 0, unchecked: 0 },
  },
};

const emptyOutputPlan: WorkerOutputPlan = {
  accountCount: 0,
  fileCount: 0,
  formats: [],
  rejectedAccountCount: 0,
  outputType: "json",
};

/*
 * UI state flow:
 * WorkerSummary owns loaded/draft account state; scope changes reset the list viewport.
 * WebView renders that snapshot; only per-account output modes may hold a row selection.
 * Files are enumerated and imported inside one cancellable heavy-task boundary.
 */
const state: WebViewState = {
  selectedFormats: [...ALL_FORMATS],
  outputModes: {},
  textMode: "json",
  previewFormat: "cpa",
  allowSyntheticIdToken: true,
  includeRefreshToken: true,
  verifyTokens: true,
  outputPlan: emptyOutputPlan,
  locale: detectWebLocale(window.location.search),
  themeMode: "system",
  forcedInputFormat: "auto",
  summary: {
    scope: "loaded",
    loaded: emptySummary,
    active: emptySummary,
    applicableFormats: [...ALL_FORMATS],
    diagnostics: [],
    inputFormat: "unknown",
  },
  selectedAccountId: undefined,
  query: "",
  previewText: "",
  previewPath: "",
  previewShown: 0,
  previewTotal: 0,
  previewBlocked: undefined,
  draftReady: false,
  busy: false,
  transientError: undefined,
};

const client = new AuthconvWorkerClient();
const systemDarkQuery = window.matchMedia("(prefers-color-scheme: dark)");
const view = new WebView(state, {
  setFormat(format, selected) {
    state.selectedFormats = selected
      ? ALL_FORMATS.filter((item) => state.selectedFormats.includes(item) || item === format)
      : state.selectedFormats.filter((item) => item !== format);
    invalidateOutputPlan();
    syncPreviewFormat();
    syncAccountSelection();
    persistOutputState();
    view.renderFormats();
    void updateRange();
    void updatePreview();
  },
  setPreviewFormat(format) {
    state.previewFormat = format;
    state.selectedAccountId = undefined;
    requireVisibleSelection = shouldRequireVisibleSelection(state.query, accountRowsSelectable(state));
    syncAccountSelection();
    persistOutputState();
    view.renderFormats();
    void updateRange();
    void updatePreview();
  },
  setOutputMode(format, mode) {
    state.outputModes[format] = mode;
    invalidateOutputPlan();
    syncAccountSelection();
    persistOutputState();
    view.renderFormats();
    void updateRange();
    void updatePreview();
  },
}, ROW_HEIGHT);
const els = view.elements;
let inputTimer: number | undefined;
let searchTimer: number | undefined;
let loadingTimer: number | undefined;
let toastTimer: number | undefined;
let previewRequest = 0;
let rangeRequest = 0;
let taskSequence = 0;
let tokenVerificationRevision = 0;
let draftRevision = 0;
let dragDepth = 0;
let heavyBusy = false;
let pendingTextPreview = false;
let jwtTimer: number | undefined;
let jwtPopoverHideTimer: number | undefined;
let jwtRequest = 0;
let jwtPopoverTrigger: HTMLElement | undefined;
let jwtPopoverPinned = false;
let copySuccessTimer: number | undefined;
let jwtCopySuccessTimer: number | undefined;
let acceptedDraftText = "";
let acceptedDraftInputFormat: InputFormat | "auto" = "auto";
let requireVisibleSelection = false;
let localTaskController: AbortController | undefined;

initialize();

function initialize(): void {
  applyPreferences(readStoredPreferences());
  applyPreferences(parseOutputOptionsSearch(window.location.search));
  acceptedDraftInputFormat = state.forcedInputFormat;
  bindEvents();
  view.applyTheme(systemDarkQuery.matches);
  view.applyLocale();
  view.syncControls();
  view.renderAll();
  if (els.jsonInput.value.trim()) scheduleTextPreview();
}

function bindEvents(): void {
  els.jsonInput.addEventListener("input", scheduleTextPreview);
  els.inputFormatSelect.addEventListener("change", () => {
    state.forcedInputFormat = els.inputFormatSelect.value as InputFormat | "auto";
    persistPreferences();
    scheduleTextPreview();
  });
  els.addDraftButton.addEventListener("click", () => void commitDraft());
  els.clearButton.addEventListener("click", () => void clearDraftInput().catch(handleWorkerError));
  els.clearAccountsButton.addEventListener("click", () => void clearAccounts().catch(handleWorkerError));
  els.sessionButton.addEventListener("click", () => window.open(SESSION_URL, "_blank", "noopener,noreferrer"));

  els.fileInput.addEventListener("change", () => void importWorkerFiles(filesFromList(els.fileInput.files)));
  els.fileButton.addEventListener("click", (event) => {
    event.stopPropagation();
    els.fileInput.click();
  });
  els.dropZone.addEventListener("click", (event) => {
    if (!(event.target instanceof HTMLElement) || !event.target.closest("button")) els.fileInput.click();
  });
  els.folderButton.addEventListener("click", (event) => {
    event.stopPropagation();
    void chooseDirectory();
  });
  window.addEventListener("dragenter", onWindowDragEnter);
  window.addEventListener("dragover", onWindowDragOver);
  window.addEventListener("dragleave", onWindowDragLeave);
  window.addEventListener("drop", (event) => {
    if (!hasFileDrag(event)) return;
    event.preventDefault();
    hideDragOverlay();
    void importCollectedFiles((signal) => filesFromDrop(event.dataTransfer, signal));
  });
  window.addEventListener("blur", hideDragOverlay);

  els.selectAllFormats.addEventListener("change", () => {
    const visible = state.summary.applicableFormats;
    state.selectedFormats = els.selectAllFormats.checked
      ? ALL_FORMATS.filter((format) => state.selectedFormats.includes(format) || visible.includes(format))
      : state.selectedFormats.filter((format) => !visible.includes(format));
    invalidateOutputPlan();
    syncPreviewFormat();
    syncAccountSelection();
    persistOutputState();
    view.renderFormats();
    void updateRange();
    void updatePreview();
  });
  els.jsonlToggle.addEventListener("change", () => {
    state.textMode = els.jsonlToggle.checked ? "jsonl" : "json";
    invalidateOutputPlan();
    syncAccountSelection();
    persistOutputState();
    view.renderFormats();
    void updateRange();
    void updatePreview();
  });
  els.fakeIdToggle.addEventListener("change", () => {
    state.allowSyntheticIdToken = els.fakeIdToggle.checked;
    persistOutputState();
    void updatePreview();
  });
  els.refreshTokenToggle.addEventListener("change", () => {
    state.includeRefreshToken = els.refreshTokenToggle.checked;
    persistOutputState();
    void updatePreview();
  });
  els.verifyTokenToggle.addEventListener("change", () => void setTokenVerification(els.verifyTokenToggle.checked));
  els.downloadButton.addEventListener("click", () => void download());
  els.copyButton.addEventListener("click", () => void copyPreview());

  els.accountRows.addEventListener("scroll", () => void updateRange());
  els.accountRows.addEventListener("click", (event) => {
    const target = event.target as HTMLElement;
    const row = target.closest<HTMLElement>(".account-row");
    if (!row) return;
    const id = row.dataset.accountId;
    if (target.closest(".remove-account-button") && id) {
      void removeAccount(id).catch(handleWorkerError);
      return;
    }
    if (id && row.classList.contains("is-selectable")) {
      state.selectedAccountId = id;
      view.renderSelectedRow();
      void updatePreview();
    }
  });
  els.accountSearch.addEventListener("input", () => {
    window.clearTimeout(searchTimer);
    searchTimer = window.setTimeout(() => {
      state.query = els.accountSearch.value;
      requireVisibleSelection = shouldRequireVisibleSelection(state.query, accountRowsSelectable(state));
      els.accountRows.scrollTop = 0;
      void updateRange();
    }, 100);
  });

  els.cancelTaskButton.addEventListener("click", () => void cancelTask());
  bindThemeAndLanguage();
  bindJwtPopover();
  bindOutputConfigCollapse();
  systemDarkQuery.addEventListener("change", () => {
    if (state.themeMode === "system") view.applyTheme(systemDarkQuery.matches);
  });
}

function bindThemeAndLanguage(): void {
  const themeControl = document.querySelector(".theme-control");
  const themeTrigger = document.getElementById("themeToggleTrigger");
  if (themeControl && themeTrigger) {
    themeTrigger.setAttribute("aria-expanded", "false");
    setThemeExpanded(false);
    themeTrigger.addEventListener("click", (event) => {
      event.stopPropagation();
      setThemeExpanded(!themeControl.classList.contains("expanded"));
    });
    document.addEventListener("click", (event) => {
      if (!themeControl.contains(event.target as Node)) setThemeExpanded(false);
    });
  }
  document.querySelectorAll<HTMLButtonElement>(".theme-tab").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      const mode = button.dataset.value;
      if (mode === "system" || mode === "light" || mode === "dark") {
        state.themeMode = mode;
        persistPreferences();
        view.applyTheme(systemDarkQuery.matches);
        setThemeExpanded(false);
      }
    });
  });

  const languageControl = document.querySelector(".language-control");
  const languageTrigger = document.getElementById("languageToggleTrigger");
  if (languageControl && languageTrigger) {
    languageTrigger.setAttribute("aria-expanded", "false");
    setLanguageExpanded(false);
    languageTrigger.addEventListener("click", (event) => {
      event.stopPropagation();
      setLanguageExpanded(!languageControl.classList.contains("expanded"));
    });
    document.addEventListener("click", (event) => {
      if (!languageControl.contains(event.target as Node)) setLanguageExpanded(false);
    });
  }
  document.querySelectorAll<HTMLButtonElement>(".language-tab").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      const locale = normalizeLocale(button.dataset.lang);
      if (!locale) return;
      state.locale = locale;
      persistOutputState();
      view.applyLocale();
      view.renderAll();
      void updateRange();
      void updatePreview();
      setLanguageExpanded(false);
    });
  });
}

function setThemeExpanded(expanded: boolean): void {
  const themeControl = document.querySelector(".theme-control");
  const themeTrigger = document.getElementById("themeToggleTrigger");
  themeControl?.classList.toggle("expanded", expanded);
  themeTrigger?.setAttribute("aria-expanded", String(expanded));
}

function setLanguageExpanded(expanded: boolean): void {
  const languageControl = document.querySelector(".language-control");
  const languageTrigger = document.getElementById("languageToggleTrigger");
  languageControl?.classList.toggle("expanded", expanded);
  languageTrigger?.setAttribute("aria-expanded", String(expanded));
}

function bindOutputConfigCollapse(): void {
  const configArea = document.getElementById("outputConfigArea");
  const resultHeader = document.querySelector(".result-header");
  const outputTitle = document.getElementById("outputTitle");
  const titleLine = outputTitle?.parentElement;
  if (!configArea || !resultHeader || !outputTitle || !titleLine) return;
  if (!outputTitle.parentElement?.querySelector(".chevron-icon")) {
    const chevron = document.createElement("span");
    chevron.className = "chevron-icon-wrap";
    chevron.innerHTML = `<svg class="chevron-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg>`;
    outputTitle.insertAdjacentElement("afterend", chevron);
  }
  const toggle = () => {
    configArea.classList.toggle("is-collapsed");
    resultHeader.classList.toggle("is-collapsed");
  };
  titleLine.classList.add("collapsible-header");
  titleLine.addEventListener("click", toggle);
}

function scheduleTextPreview(): void {
  draftRevision += 1;
  const revision = draftRevision;
  state.draftReady = false;
  state.transientError = undefined;
  if (state.summary.scope === "draft") {
    invalidateCurrentPreview();
    if (!heavyBusy) void discardAcceptedDraft(revision);
  }
  view.renderInputState();
  window.clearTimeout(inputTimer);
  inputTimer = window.setTimeout(() => {
    inputTimer = undefined;
    if (heavyBusy) {
      pendingTextPreview = true;
      return;
    }
    pendingTextPreview = false;
    void previewText();
  }, 250);
}

async function discardAcceptedDraft(revision: number): Promise<void> {
  try {
    const response = await client.discardDraft();
    if (revision !== draftRevision || response.type !== "discardDraftResult") return;
    acceptedDraftText = "";
    acceptedDraftInputFormat = state.forcedInputFormat;
    applySummary(response.summary);
  } catch (error) {
    if (revision === draftRevision && !isAbortError(error)) applyErrorSummary(error);
  }
}

async function previewText(): Promise<void> {
  const text = els.jsonInput.value;
  const inputFormat = state.forcedInputFormat;
  const revision = draftRevision;
  const sequence = ++taskSequence;
  try {
    const response = await withLoading(
      state.locale === "zh" ? "正在解析凭证" : "Parsing credentials",
      (progress) => client.previewText(
        text,
        inputFormat === "auto" ? undefined : inputFormat,
        state.verifyTokens,
        progress,
      ),
      sequence,
    );
    if (
      sequence !== taskSequence
      || revision !== draftRevision
      || text !== els.jsonInput.value
      || inputFormat !== state.forcedInputFormat
      || response.type !== "previewTextResult"
    ) return;
    acceptedDraftText = text;
    acceptedDraftInputFormat = inputFormat;
    state.draftReady = response.summary.scope === "draft" && text.trim().length > 0;
    applySummary(response.summary, undefined, response.summary.scope === "draft");
  } catch (error) {
    if (sequence !== taskSequence || revision !== draftRevision) return;
    state.draftReady = false;
    applyErrorSummary(error);
    if (!isAbortError(error)) showError(error);
  }
}

async function commitDraft(): Promise<void> {
  if (!state.draftReady) return;
  const response = await runHeavy(
    state.locale === "zh" ? "正在加入账号" : "Adding accounts",
    (progress) => client.commitDraft(state.verifyTokens, progress),
  );
  if (response?.type !== "commitDraftResult") return;
  pendingTextPreview = false;
  window.clearTimeout(inputTimer);
  inputTimer = undefined;
  els.jsonInput.value = "";
  acceptedDraftText = "";
  acceptedDraftInputFormat = state.forcedInputFormat;
  state.draftReady = false;
  applySummary(response.summary, response.stats.firstAffectedId);
  showToast(webMessages().sourceImported(
    response.stats.processed,
    response.stats.added,
    response.stats.merged,
    response.stats.skippedForged,
  ));
}

async function clearDraftInput(): Promise<void> {
  draftRevision += 1;
  const revision = draftRevision;
  pendingTextPreview = false;
  window.clearTimeout(inputTimer);
  inputTimer = undefined;
  els.jsonInput.value = "";
  state.draftReady = false;
  invalidateCurrentPreview();
  view.renderInputState();
  const response = await client.discardDraft();
  if (revision !== draftRevision || els.jsonInput.value !== "" || response.type !== "discardDraftResult") return;
  acceptedDraftText = "";
  acceptedDraftInputFormat = "auto";
  state.forcedInputFormat = "auto";
  persistPreferences();
  applySummary(response.summary);
}

async function clearAccounts(): Promise<void> {
  const response = await client.clear();
  if (response.type === "clearResult") {
    state.selectedAccountId = undefined;
    state.query = "";
    els.accountSearch.value = "";
    els.accountRows.scrollTop = 0;
    applySummary(response.summary);
  }
}

async function importWorkerFiles(files: WorkerFile[]): Promise<void> {
  await importCollectedFiles(async () => files);
}

async function importCollectedFiles(collect: (signal: AbortSignal) => Promise<WorkerFile[]>): Promise<void> {
  els.fileInput.value = "";
  const response = await runHeavy(
    state.locale === "zh" ? "正在导入文件" : "Importing files",
    async (progress, signal) => {
      const files = await collect(signal);
      throwIfAborted(signal);
      if (files.length === 0) throw new Error(webMessages().chooseCredentialFiles);
      return client.importFiles(files, state.verifyTokens, progress);
    },
  );
  if (response?.type !== "importFilesResult") return;
  const preferredAccountId = response.summary.scope === "loaded" ? response.stats.firstAffectedId : undefined;
  applySummary(response.summary, preferredAccountId);
  showToast(webMessages().fileImported(
    response.stats.processed,
    response.stats.added,
    response.stats.merged,
    response.stats.skippedForged,
  ));
}

async function setTokenVerification(enabled: boolean): Promise<void> {
  const revision = ++tokenVerificationRevision;
  if (!enabled) {
    commitTokenVerificationSetting(false);
    if (!state.busy) void updatePreview();
    return;
  }

  const response = await runHeavy(
    state.locale === "zh" ? "正在重新验证 token" : "Re-verifying tokens",
    (progress) => client.reverify(state.selectedAccountId, progress),
  );
  if (response?.type !== "reverifyResult") {
    if (revision === tokenVerificationRevision) view.syncControls();
    return;
  }

  if (response.selectedAccountRemoved) {
    state.selectedAccountId = undefined;
    requireVisibleSelection = true;
  }
  if (revision === tokenVerificationRevision) commitTokenVerificationSetting(true);
  applySummary(response.summary);
}

function commitTokenVerificationSetting(enabled: boolean): void {
  state.verifyTokens = enabled;
  invalidateOutputPlan();
  persistOutputState();
  view.syncControls();
  view.renderOutputHeader();
}

async function removeAccount(id: string): Promise<void> {
  const response = await client.remove(id);
  if (response.type !== "removeResult") return;
  if (state.selectedAccountId === id) {
    state.selectedAccountId = response.suggestedAccountId;
    if (state.query) requireVisibleSelection = true;
  }
  applySummary(response.summary);
}

async function cancelTask(): Promise<void> {
  const inputAtCancel = els.jsonInput.value;
  const hadScheduledPreview = inputTimer !== undefined || pendingTextPreview;
  localTaskController?.abort(new DOMException("Aborted", "AbortError"));
  window.clearTimeout(inputTimer);
  inputTimer = undefined;
  pendingTextPreview = false;
  try {
    const response = await client.cancel();
    if (response.type === "cancelResult") {
      if (response.cancelledTask === "previewText" && els.jsonInput.value === inputAtCancel) {
        els.jsonInput.value = acceptedDraftText;
        state.forcedInputFormat = acceptedDraftInputFormat;
        state.draftReady = response.summary.scope === "draft" && acceptedDraftText.trim().length > 0;
        persistPreferences();
      } else if (response.cancelledTask !== "previewText" && hadScheduledPreview) {
        if (heavyBusy) pendingTextPreview = true;
        else scheduleTextPreview();
      }
      applySummary(response.summary);
    }
  } catch (error) {
    if (hadScheduledPreview) {
      if (heavyBusy) pendingTextPreview = true;
      else scheduleTextPreview();
    }
    if (!isAbortError(error)) showError(error);
  }
}

async function runHeavy(
  stage: string,
  task: (progress: (value: WorkerProgress) => void, signal: AbortSignal) => Promise<WorkerClientResponse>,
): Promise<WorkerClientResponse | undefined> {
  if (heavyBusy) return undefined;
  const sequence = ++taskSequence;
  if (inputTimer !== undefined) {
    window.clearTimeout(inputTimer);
    inputTimer = undefined;
    pendingTextPreview = true;
  } else if (state.busy && !heavyBusy) {
    pendingTextPreview = true;
  }
  heavyBusy = true;
  const controller = new AbortController();
  localTaskController = controller;
  state.transientError = undefined;
  try {
    return await withLoading(stage, (progress) => task(progress, controller.signal), sequence, true);
  } catch (error) {
    applyErrorSummary(error);
    if (!isAbortError(error)) showError(error);
    return undefined;
  } finally {
    if (localTaskController === controller) localTaskController = undefined;
    heavyBusy = false;
    if (pendingTextPreview) {
      window.setTimeout(() => {
        if (heavyBusy || !pendingTextPreview) return;
        pendingTextPreview = false;
        void previewText();
      }, 0);
    }
  }
}

async function withLoading<T>(
  stage: string,
  task: (progress: (value: WorkerProgress) => void) => Promise<T>,
  sequence: number,
  immediate = false,
): Promise<T> {
  state.busy = true;
  view.syncControls();
  view.renderInputState();
  view.renderOutputHeader();
  window.clearTimeout(loadingTimer);
  if (immediate) {
    els.taskStage.textContent = stage;
    els.taskProgress.textContent = "";
    els.taskOverlay.hidden = false;
  } else {
    loadingTimer = window.setTimeout(() => {
      if (sequence === taskSequence) {
        els.taskStage.textContent = stage;
        els.taskProgress.textContent = "";
        els.taskOverlay.hidden = false;
      }
    }, 150);
  }
  try {
    return await task((progress) => {
      if (sequence !== taskSequence) return;
      els.taskStage.textContent = phaseLabel(progress.phase);
      els.taskProgress.textContent = progress.total
        ? `${progress.completed.toLocaleString()} / ${progress.total.toLocaleString()}`
        : progress.completed.toLocaleString();
    });
  } finally {
    if (sequence === taskSequence) {
      window.clearTimeout(loadingTimer);
      els.taskOverlay.hidden = true;
      state.busy = false;
      view.syncControls();
      view.renderInputState();
      view.renderOutputHeader();
    }
  }
}

function phaseLabel(phase: WorkerProgress["phase"]): string {
  const zh = { parse: "正在解析", normalize: "正在整理账号", verify: "正在验证 token", store: "正在去重", export: "正在生成文件" };
  const en = { parse: "Parsing", normalize: "Normalizing accounts", verify: "Verifying tokens", store: "Deduplicating", export: "Building files" };
  return (state.locale === "zh" ? zh : en)[phase];
}

function applySummary(summary: WorkerSummary, preferredAccountId?: string, resetSelection = false): void {
  const scopeChanged = state.summary.scope !== summary.scope;
  const resetForPreferredAccount = shouldResetViewportForPreferredAccount(preferredAccountId, state.query);
  state.summary = summary;
  state.transientError = undefined;
  invalidateOutputPlan();
  if (scopeChanged || resetForPreferredAccount) resetAccountViewport();
  if (summary.active.total === 0 || resetSelection) state.selectedAccountId = undefined;
  else if (preferredAccountId && !resetForPreferredAccount) state.selectedAccountId = preferredAccountId;
  syncPreviewFormat();
  syncAccountSelection();
  view.renderAll();
  void updateRange();
  void updatePreview();
}

async function updateRange(): Promise<void> {
  const request = ++rangeRequest;
  const total = state.summary.active.total;
  if (total === 0) {
    view.clearRange();
    return;
  }
  const offset = Math.max(0, Math.floor(els.accountRows.scrollTop / ROW_HEIGHT) - ROW_OVERSCAN);
  const response = await client.range(state.summary.scope, offset, RANGE_LIMIT, state.query);
  if (request !== rangeRequest || response.type !== "rangeResult") return;
  const selectedAccountId = selectAccountForRange(
    state.selectedAccountId,
    response.items.filter((account) => accountRowSelectable(state, account.provider)),
    requireVisibleSelection,
    accountRowsSelectable(state),
  );
  requireVisibleSelection = false;
  if (selectedAccountId !== state.selectedAccountId) {
    state.selectedAccountId = selectedAccountId;
    void updatePreview();
  }
  view.renderRange(response);
}

async function updatePreview(): Promise<void> {
  const request = ++previewRequest;
  hideJwt();
  const formats = effectiveFormats();
  if (state.summary.active.total === 0 || formats.length === 0) {
    invalidateOutputPlan();
    state.previewText = "";
    state.previewPath = "";
    state.previewShown = 0;
    state.previewTotal = 0;
    state.previewBlocked = undefined;
    view.renderFormats();
    view.renderPreview();
    view.renderOutputHeader();
    return;
  }
  syncPreviewFormat();
  syncAccountSelection();
  const selectable = accountRowsSelectable(state);
  const selectedAccountId = selectable
    ? requireVisibleSelection || (state.query.length > 0 && !state.selectedAccountId)
      ? null
      : state.selectedAccountId
    : undefined;
  let response: WorkerClientResponse;
  try {
    response = await client.preview({
      formats,
      previewFormat: state.previewFormat,
      outputModes: state.outputModes,
      textMode: state.textMode,
      selectedAccountId,
      includeRefreshToken: state.includeRefreshToken,
      allowSyntheticIdToken: state.allowSyntheticIdToken,
      verifyTokens: state.verifyTokens,
    });
  } catch (error) {
    if (request === previewRequest && !isAbortError(error)) handleWorkerError(error);
    return;
  }
  if (request !== previewRequest || response.type !== "previewResult") return;
  if (selectable && response.selectedAccountId !== state.selectedAccountId) {
    state.selectedAccountId = response.selectedAccountId;
    void updateRange();
  }
  state.outputPlan = response.outputPlan;
  if (response.format) state.previewFormat = response.format;
  state.previewText = response.text;
  state.previewPath = response.path;
  state.previewShown = response.shownAccounts;
  state.previewTotal = response.totalAccounts;
  state.previewBlocked = response.blockedVerification?.status;
  view.renderFormats();
  view.renderPreview();
  view.renderOutputHeader();
}

async function download(): Promise<void> {
  const formats = effectiveFormats();
  if (
    state.busy
    || formats.length === 0
    || state.outputPlan.fileCount === 0
  ) return;
  const response = await runHeavy(
    state.locale === "zh" ? "正在生成下载" : "Building download",
    (progress) => client.export({
      formats,
      outputModes: state.outputModes,
      textMode: state.textMode,
      includeRefreshToken: state.includeRefreshToken,
      allowSyntheticIdToken: state.allowSyntheticIdToken,
      verifyTokens: state.verifyTokens,
    }, progress),
  );
  if (response?.type !== "exportResult") return;
  downloadBlob(response.exportBlob, response.name);
  showToast(response.mime === "application/zip" ? webMessages().exportZipToast(response.name) : webMessages().exportFileToast);
}

function effectiveFormats(): OutputFormat[] {
  return selectEffectiveFormats(state);
}

function invalidateOutputPlan(): void {
  state.outputPlan = emptyOutputPlan;
}

function invalidateCurrentPreview(): void {
  previewRequest += 1;
  invalidateOutputPlan();
  state.previewText = "";
  state.previewPath = "";
  state.previewShown = 0;
  state.previewTotal = 0;
  state.previewBlocked = undefined;
  view.renderFormats();
  view.renderPreview();
  view.renderOutputHeader();
}

function syncPreviewFormat(): void {
  const formats = effectiveFormats();
  if (formats.includes(state.previewFormat)) return;
  state.previewFormat = formats[0] ?? "cpa";
  state.selectedAccountId = undefined;
  requireVisibleSelection = formats.length > 0
    && shouldRequireVisibleSelection(state.query, accountRowsSelectable(state));
}

function syncAccountSelection(): void {
  if (!accountRowsSelectable(state)) {
    state.selectedAccountId = undefined;
    requireVisibleSelection = false;
  }
  view.renderSelectedRow();
}

function resetAccountViewport(): void {
  rangeRequest += 1;
  state.query = "";
  state.selectedAccountId = undefined;
  requireVisibleSelection = false;
  els.accountSearch.value = "";
  els.accountRows.scrollTop = 0;
  view.clearRange();
}

function applyPreferences(options: Partial<WebPreferences>): void {
  if (options.selectedFormats) state.selectedFormats = options.selectedFormats;
  if (options.outputTextMode) state.textMode = options.outputTextMode;
  if (options.outputModes) state.outputModes = { ...state.outputModes, ...options.outputModes };
  if (options.previewFormat) state.previewFormat = options.previewFormat;
  if (options.allowSyntheticIdToken !== undefined) state.allowSyntheticIdToken = options.allowSyntheticIdToken;
  if (options.includeRefreshToken !== undefined) state.includeRefreshToken = options.includeRefreshToken;
  if (options.verifyTokens !== undefined) state.verifyTokens = options.verifyTokens;
  if (options.locale) state.locale = options.locale;
  if (options.themeMode) state.themeMode = options.themeMode;
  if (options.forcedInputFormat) state.forcedInputFormat = options.forcedInputFormat;
}

function persistPreferences(): void {
  writeStoredPreferences({
    selectedFormats: state.selectedFormats,
    outputTextMode: state.textMode,
    outputModes: state.outputModes,
    previewFormat: state.previewFormat,
    allowSyntheticIdToken: state.allowSyntheticIdToken,
    includeRefreshToken: state.includeRefreshToken,
    verifyTokens: state.verifyTokens,
    locale: state.locale,
    themeMode: state.themeMode,
    forcedInputFormat: state.forcedInputFormat,
  });
}

function persistOutputState(): void {
  persistPreferences();
  window.history.replaceState(null, "", outputOptionsUrl(window.location.href, {
    selectedFormats: state.selectedFormats,
    outputTextMode: state.textMode,
    outputModes: state.outputModes,
    previewFormat: state.previewFormat,
    allowSyntheticIdToken: state.allowSyntheticIdToken,
    includeRefreshToken: state.includeRefreshToken,
    verifyTokens: state.verifyTokens,
    locale: state.locale,
  }));
}

function bindJwtPopover(): void {
  els.previewOutput.addEventListener("mouseover", (event) => {
    const trigger = jwtHoverTrigger(event.target);
    if (trigger) scheduleJwtPopover(trigger);
  });
  els.previewOutput.addEventListener("mouseout", (event) => {
    if (jwtHoverTrigger(event.target)) scheduleJwtPopoverHide();
  });
  els.previewOutput.addEventListener("click", (event) => {
    const trigger = jwtHoverTrigger(event.target);
    if (!trigger) return;
    void showJwt(trigger).then((shown) => {
      if (shown) jwtPopoverPinned = true;
    });
  });
  els.jwtPopover.addEventListener("mouseenter", cancelJwtPopoverHide);
  els.jwtPopover.addEventListener("mouseleave", scheduleJwtPopoverHide);
  els.jwtPopoverCopy.addEventListener("click", async () => {
    const body = els.jwtPopoverBody.textContent;
    if (!body) return;
    try {
      await navigator.clipboard.writeText(body);
      showJwtCopySuccessFeedback();
    } catch {
      showToast(webMessages().copyFailed);
    }
  });
  document.addEventListener("click", (event) => {
    if (jwtPopoverPinned && !els.jwtPopover.contains(event.target as Node) && !jwtHoverTrigger(event.target)) {
      hideJwt();
    }
  });
  window.addEventListener("scroll", (event) => {
    if (event.target instanceof HTMLElement && els.jwtPopover.contains(event.target)) return;
    hideJwt();
  }, true);
}

function jwtHoverTrigger(target: EventTarget | null): HTMLElement | undefined {
  return target instanceof Element
    ? target.closest<HTMLElement>(".jwt-token-hoverable") ?? undefined
    : undefined;
}

function scheduleJwtPopover(trigger: HTMLElement): void {
  window.clearTimeout(jwtTimer);
  cancelJwtPopoverHide();
  jwtTimer = window.setTimeout(() => void showJwt(trigger), 250);
}

function cancelJwtPopoverHide(): void {
  window.clearTimeout(jwtPopoverHideTimer);
}

function scheduleJwtPopoverHide(): void {
  if (jwtPopoverPinned) return;
  window.clearTimeout(jwtTimer);
  window.clearTimeout(jwtPopoverHideTimer);
  jwtPopoverHideTimer = window.setTimeout(hideJwt, 800);
}

async function showJwt(trigger: HTMLElement): Promise<boolean> {
  const token = trigger.dataset.jwt;
  if (!token) return false;
  const request = ++jwtRequest;
  const response = await client.decodeJwt(token);
  if (
    request !== jwtRequest ||
    !trigger.isConnected ||
    trigger.dataset.jwt !== token ||
    response.type !== "decodeJwtResult" ||
    !response.text
  ) return false;
  jwtPopoverTrigger?.removeAttribute("aria-describedby");
  jwtPopoverTrigger = trigger;
  trigger.setAttribute("aria-describedby", "jwtPopover");
  els.jwtPopoverBody.innerHTML = highlightJson(response.text);
  els.jwtPopover.hidden = false;
  requestAnimationFrame(() => {
    els.jwtPopover.classList.add("visible");
    positionJwtPopover(trigger);
  });
  return true;
}

function positionJwtPopover(trigger: HTMLElement): void {
  const triggerRect = trigger.getBoundingClientRect();
  const popoverRect = els.jwtPopover.getBoundingClientRect();
  const viewportPadding = 12;
  const gap = 8;
  const maxLeft = Math.max(viewportPadding, window.innerWidth - popoverRect.width - viewportPadding);
  const left = Math.min(Math.max(triggerRect.left, viewportPadding), maxLeft);
  const below = triggerRect.bottom + gap;
  const above = triggerRect.top - popoverRect.height - gap;
  const top = below + popoverRect.height <= window.innerHeight - viewportPadding
    ? below
    : Math.max(viewportPadding, above);
  els.jwtPopover.style.left = `${Math.round(left)}px`;
  els.jwtPopover.style.top = `${Math.round(top)}px`;
}

function hideJwt(): void {
  jwtRequest += 1;
  window.clearTimeout(jwtTimer);
  window.clearTimeout(jwtPopoverHideTimer);
  jwtPopoverPinned = false;
  els.jwtPopover.classList.remove("visible");
  jwtPopoverTrigger?.removeAttribute("aria-describedby");
  jwtPopoverTrigger = undefined;
  resetJwtCopyFeedback();
  window.setTimeout(() => {
    if (!els.jwtPopover.classList.contains("visible")) els.jwtPopover.hidden = true;
  }, 160);
}

async function copyPreview(): Promise<void> {
  if (!state.previewText) return;
  try {
    await navigator.clipboard.writeText(state.previewText);
    showPreviewCopySuccessFeedback();
    showToast(webMessages().copyToast);
  } catch {
    showToast(webMessages().copyFailed);
  }
}

function showPreviewCopySuccessFeedback(): void {
  window.clearTimeout(copySuccessTimer);
  const label = document.getElementById("copyBtnText");
  const icon = document.getElementById("copyIcon");
  if (label) label.textContent = webMessages().copied;
  icon?.toggleAttribute("hidden", true);
  els.copyButton.classList.add("btn-copy-success");
  copySuccessTimer = window.setTimeout(() => {
    if (label) label.textContent = webMessages().copyPreview;
    icon?.toggleAttribute("hidden", false);
    els.copyButton.classList.remove("btn-copy-success");
  }, 1500);
}

function showJwtCopySuccessFeedback(): void {
  window.clearTimeout(jwtCopySuccessTimer);
  const copyIcon = els.jwtPopoverCopy.querySelector<HTMLElement>(".copy-icon");
  const checkIcon = els.jwtPopoverCopy.querySelector<HTMLElement>(".check-icon");
  els.jwtPopoverCopy.classList.add("copied");
  if (copyIcon) copyIcon.style.display = "none";
  if (checkIcon) checkIcon.style.display = "block";
  jwtCopySuccessTimer = window.setTimeout(resetJwtCopyFeedback, 1200);
}

function resetJwtCopyFeedback(): void {
  window.clearTimeout(jwtCopySuccessTimer);
  els.jwtPopoverCopy.classList.remove("copied");
  const copyIcon = els.jwtPopoverCopy.querySelector<HTMLElement>(".copy-icon");
  const checkIcon = els.jwtPopoverCopy.querySelector<HTMLElement>(".check-icon");
  if (copyIcon) copyIcon.style.display = "block";
  if (checkIcon) checkIcon.style.display = "none";
}

function filesFromList(list: FileList | null): WorkerFile[] {
  return Array.from(list ?? []).map((file) => ({ file, path: filePath(file) }));
}

async function chooseDirectory(): Promise<void> {
  try {
    const directory = await (window as WindowWithDirectoryPicker).showDirectoryPicker?.();
    if (directory) await importCollectedFiles((signal) => filesFromHandle(directory, directory.name, signal));
  } catch (error) {
    if (!isAbortError(error)) showError(error);
  }
}

async function filesFromDrop(data: DataTransfer | null, signal: AbortSignal): Promise<WorkerFile[]> {
  throwIfAborted(signal);
  const items = Array.from(data?.items ?? []);
  const handles = (await Promise.all(items.map(async (item) => {
    throwIfAborted(signal);
    try { return await (item as DataTransferItemWithHandle).getAsFileSystemHandle?.() ?? undefined; }
    catch { return undefined; }
  }))).filter((handle): handle is FileSystemHandleLike => Boolean(handle));
  if (handles.length > 0) {
    const files: WorkerFile[] = [];
    for (const handle of handles) {
      for (const file of await filesFromHandle(handle, handle.name, signal)) files.push(file);
    }
    return files;
  }
  const entries = items
    .map((item) => (item as unknown as DataTransferItemWithEntry).webkitGetAsEntry?.() as unknown as FileSystemEntryLike | undefined)
    .filter((entry): entry is FileSystemEntryLike => Boolean(entry));
  if (entries.length > 0) {
    const files: WorkerFile[] = [];
    for (const entry of entries) {
      for (const file of await filesFromEntry(entry, signal)) files.push(file);
    }
    return files;
  }
  throwIfAborted(signal);
  return filesFromList(data?.files ?? null);
}

async function filesFromHandle(handle: FileSystemHandleLike, base: string, signal: AbortSignal): Promise<WorkerFile[]> {
  throwIfAborted(signal);
  if (handle.kind === "file") {
    const file = await handle.getFile();
    throwIfAborted(signal);
    return [{ file, path: normalizePath(base) }];
  }
  const files: WorkerFile[] = [];
  if (handle.values) {
    for await (const child of handle.values()) {
      throwIfAborted(signal);
      for (const file of await filesFromHandle(child, `${base}/${child.name}`, signal)) files.push(file);
    }
  } else if (handle.entries) {
    for await (const [, child] of handle.entries()) {
      throwIfAborted(signal);
      for (const file of await filesFromHandle(child, `${base}/${child.name}`, signal)) files.push(file);
    }
  }
  return files;
}

async function filesFromEntry(entry: FileSystemEntryLike, signal: AbortSignal): Promise<WorkerFile[]> {
  throwIfAborted(signal);
  if (entry.isFile) {
    const path = normalizePath(entry.fullPath ?? entry.name);
    const file = await new Promise<File>((resolve, reject) => (entry as FileEntryLike).file(resolve, reject));
    throwIfAborted(signal);
    return [{ file, path }];
  }
  if (!entry.isDirectory) return [];
  const reader = (entry as DirectoryEntryLike).createReader();
  const children: FileSystemEntryLike[] = [];
  for (;;) {
    throwIfAborted(signal);
    const batch = await new Promise<FileSystemEntryLike[]>((resolve, reject) => reader.readEntries(resolve, reject));
    if (batch.length === 0) break;
    for (const child of batch) children.push(child);
  }
  const files: WorkerFile[] = [];
  for (const child of children) {
    for (const file of await filesFromEntry(child, signal)) files.push(file);
  }
  return files;
}

function onWindowDragEnter(event: DragEvent): void {
  if (!hasFileDrag(event)) return;
  event.preventDefault();
  dragDepth += 1;
  showDragOverlay();
}

function onWindowDragOver(event: DragEvent): void {
  if (!hasFileDrag(event)) return;
  event.preventDefault();
  showDragOverlay();
}

function onWindowDragLeave(event: DragEvent): void {
  if (!hasFileDrag(event) && !els.dragOverlay.classList.contains("active")) return;
  if (event.clientX <= 0 || event.clientY <= 0 || event.clientX >= window.innerWidth || event.clientY >= window.innerHeight) dragDepth = 0;
  else dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) hideDragOverlay();
}

function showDragOverlay(): void {
  els.dragOverlay.classList.add("active");
  els.dragOverlay.setAttribute("aria-hidden", "false");
}

function hideDragOverlay(): void {
  dragDepth = 0;
  els.dragOverlay.classList.remove("active");
  els.dragOverlay.setAttribute("aria-hidden", "true");
}

function hasFileDrag(event: DragEvent): boolean {
  return Array.from(event.dataTransfer?.types ?? []).includes("Files");
}

function filePath(file: File): string {
  return normalizePath((file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name);
}

function normalizePath(value: string): string {
  return value.replace(/^\/+/, "").replace(/\\/g, "/");
}

function downloadBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

function showToast(message: string): void {
  window.clearTimeout(toastTimer);
  els.toastMessage.textContent = message;
  els.toast.hidden = false;
  requestAnimationFrame(() => els.toast.classList.add("show"));
  toastTimer = window.setTimeout(() => {
    els.toast.classList.remove("show");
    window.setTimeout(() => { els.toast.hidden = true; }, 360);
  }, 2200);
}

function showError(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  state.transientError = message;
  view.renderInputState();
}

function applyErrorSummary(error: unknown): void {
  const summary = (error as WorkerRequestError | undefined)?.summary;
  if (summary) applySummary(summary);
}

function handleWorkerError(error: unknown): void {
  applyErrorSummary(error);
  if (!isAbortError(error)) showError(error);
}

function webMessages(): ReturnType<typeof messagesFor>["web"] {
  return messagesFor(state.locale).web;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : new DOMException("Aborted", "AbortError");
}
