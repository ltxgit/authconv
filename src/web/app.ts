import {
  buildOutputPlan,
  dedupeAccountsWithAffectedIndex,
  detectWebLocale,
  detectInputFormat,
  FORMAT_LABELS,
  inputFormatLabel,
  messagesFor,
  normalizeInput,
  normalizeLocale,
  parseInputPayloadWithMeta,
  serializeOutputFiles,
  type Locale,
  type NormalizedAccount,
  type OutputFormat,
  type OutputMode,
  type OutputModes,
  type OutputTextMode,
  type InputFormat,
  type SerializedOutputFile,
  zipOutputFiles,
} from "../index.js";
import {
  extractZipJsonSources,
  isCredentialImportPath,
  isJsonCredentialPath,
  isZipCredentialPath,
  type JsonSource,
} from "../import-sources.js";
import { zipDownloadName } from "../download-names.js";
import { effectiveWebOutputModes } from "./output-modes.js";
import {
  activeAccountSource,
  importSummary,
  selectedIndexAfterRemoval,
  syncPreviewTabSelection,
  type AccountSourceKind,
} from "./state-helpers.js";
import { outputOptionsUrl, parseOutputOptionsSearch } from "./url-state.js";
import {
  readStoredPreferences,
  writeStoredPreferences,
  type ThemeMode,
  type WebPreferences,
} from "./preferences.js";

const FORMATS: OutputFormat[] = ["cpa", "sub2api", "codex2api", "codexmanager", "codex"];
const INPUT_FORMAT_BADGE_LABELS: Record<InputFormat, string> = {
  session: "Session",
  sub2api: "sub2api",
  cpa: "CPA",
  codexmanager: "Codex Manager",
  codex2api: "Codex2Api",
  codex: "Codex Auth",
  unknown: "Unknown",
};
const SELECTABLE_INPUT_FORMATS: InputFormat[] = ["session", "sub2api", "cpa", "codexmanager", "codex2api", "codex"];
const MODE_FORMATS = new Set<OutputFormat>(["sub2api", "codex2api"]);

const SESSION_URL = "https://chatgpt.com/api/auth/session";

type FileSystemFileHandleLike = {
  kind: "file";
  name: string;
  getFile: () => Promise<File>;
};

type FileSystemDirectoryHandleLike = {
  kind: "directory";
  name: string;
  values?: () => AsyncIterable<FileSystemHandleLike>;
  entries?: () => AsyncIterable<[string, FileSystemHandleLike]>;
};

type FileSystemHandleLike = FileSystemFileHandleLike | FileSystemDirectoryHandleLike;

type WindowWithDirectoryPicker = Window & {
  showDirectoryPicker?: () => Promise<FileSystemDirectoryHandleLike>;
};

type DataTransferItemWithFileSystemHandle = DataTransferItem & {
  getAsFileSystemHandle?: () => Promise<FileSystemHandleLike | null>;
};

type FileSystemEntryLike = {
  name: string;
  fullPath?: string;
  isFile: boolean;
  isDirectory: boolean;
};

type FileSystemFileEntryLike = FileSystemEntryLike & {
  isFile: true;
  file: (success: (file: File) => void, error?: (error: DOMException) => void) => void;
};

type FileSystemDirectoryEntryLike = FileSystemEntryLike & {
  isDirectory: true;
  createReader: () => {
    readEntries: (success: (entries: FileSystemEntryLike[]) => void, error?: (error: DOMException) => void) => void;
  };
};

type DataTransferItemWithEntry = DataTransferItem & {
  webkitGetAsEntry?: () => FileSystemEntryLike | null;
};

type ParsedSource = {
  source: JsonSource;
  accounts: NormalizedAccount[];
  documentCount: number;
  inputFormat?: InputFormat;
  detectedInputFormat?: InputFormat;
  error?: string;
  errorKind?: "json" | "input";
};

type ViewState = {
  draftSource?: JsonSource;
  draftParsed?: ParsedSource;
  sourceErrors: string[];
  accounts: NormalizedAccount[];
  selectedFormats: OutputFormat[];
  outputModes: OutputModes;
  outputTextMode: OutputTextMode;
  previewFormat: OutputFormat;
  selectedAccountIndex: number;
  themeMode: ThemeMode;
  serializedFiles: SerializedOutputFile[];
  nextInputIndex: number;
  forcedInputFormat: InputFormat | "auto";
  allowSyntheticIdToken: boolean;
  downloadBusy: boolean;
  locale: Locale;
};

const state: ViewState = {
  sourceErrors: [],
  accounts: [],
  selectedFormats: ["cpa"],
  outputModes: {
    sub2api: "merged",
    codex2api: "merged",
  },
  outputTextMode: "json",
  previewFormat: "cpa",
  selectedAccountIndex: 0,
  themeMode: "system",
  serializedFiles: [],
  nextInputIndex: 1,
  forcedInputFormat: "auto",
  allowSyntheticIdToken: true,
  downloadBusy: false,
  locale: detectWebLocale(window.location.search),
};

const systemDarkQuery = window.matchMedia("(prefers-color-scheme: dark)");
let toastTimer: number | undefined;
let copyResetTimer: number | undefined;
let dragDepth = 0;

const els = {
  jsonInput: byId<HTMLTextAreaElement>("jsonInput"),
  fileInput: byId<HTMLInputElement>("fileInput"),
  dropZone: byId("dropZone"),
  dragOverlay: byId("dragOverlay"),
  toast: byId("toast"),
  toastMessage: byId("toastMessage"),
  logoIcon: byId("logoIcon"),
  inputError: byId("inputError"),
  inputFormatContainer: byId("inputFormatContainer"),
  inputFormatSelect: byId<HTMLSelectElement>("inputFormatSelect"),
  formatChecks: byId("formatChecks"),
  previewTabsContainer: byId("previewTabsContainer"),
  selectAllFormats: byId<HTMLInputElement>("selectAllFormats"),
  outputMeta: byId("outputMeta"),
  jsonlToggle: byId<HTMLInputElement>("jsonlToggle"),
  jsonlToggleContainer: byId("jsonlToggleContainer"),
  fakeIdToggle: byId<HTMLInputElement>("fakeIdToggle"),
  fakeIdToggleContainer: byId("fakeIdToggleContainer"),
  accountSection: byId("accountSection"),
  clearAccountsButton: byId<HTMLButtonElement>("clearAccountsButton"),
  accountRows: byId("accountRows"),
  previewOutput: byId("previewOutput"),
  copyButton: byId<HTMLButtonElement>("copyButton"),
  downloadButton: byId<HTMLButtonElement>("downloadButton"),
  downloadBtnText: byId<HTMLSpanElement>("downloadBtnText"),
  sessionButton: byId<HTMLButtonElement>("sessionButton"),
  fileButton: byId<HTMLButtonElement>("fileButton"),
  folderButton: byId<HTMLButtonElement>("folderButton"),
  addDraftButton: byId<HTMLButtonElement>("addDraftButton"),
  clearButton: byId<HTMLButtonElement>("clearButton"),
};

const tooltip = createTooltip();
const tooltipTargets = new WeakSet<HTMLElement>();

init();

function init(): void {
  applyStoredPreferences();
  applyOutputOptionsFromUrl();
  syncPreferenceControls();
  applyLocale();
  applyTheme();
  renderFormatControls();
  bindEvents();

  // Initialize draft source from current textarea value (e.g. if retained on browser refresh)
  const initialText = els.jsonInput.value.trim();
  if (initialText) {
    state.draftSource = { name: draftSourceName(), path: "draft", text: initialText };
  }

  recompute();
}

function bindEvents(): void {
  // Bind Segmented Control Theme Tabs
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
      if (!themeControl.contains(event.target as Node)) {
        setThemeExpanded(false);
      }
    });
  }

  document.querySelectorAll(".theme-tab").forEach((tab) => {
    tab.addEventListener("click", (event) => {
      event.stopPropagation();
      const val = tab.getAttribute("data-value");
      if (val && isThemeMode(val)) {
        state.themeMode = val;
        persistPreferences();
        applyTheme();
        setThemeExpanded(false);
      }
    });
  });

  // Bind Segmented Control Language Tabs
  const langControl = document.querySelector(".language-control");
  const langTrigger = document.getElementById("languageToggleTrigger");

  if (langControl && langTrigger) {
    langTrigger.setAttribute("aria-expanded", "false");
    setLanguageExpanded(false);

    langTrigger.addEventListener("click", (event) => {
      event.stopPropagation();
      setLanguageExpanded(!langControl.classList.contains("expanded"));
    });

    document.addEventListener("click", (event) => {
      if (!langControl.contains(event.target as Node)) {
        setLanguageExpanded(false);
      }
    });
  }

  document.querySelectorAll<HTMLButtonElement>(".language-tab").forEach((tab) => {
    tab.addEventListener("click", (event) => {
      event.stopPropagation();
      const locale = normalizeLocale(tab.dataset.lang);
      if (!locale || locale === state.locale) {
        return;
      }
      state.locale = locale;
      persistPreferenceState();
      applyLocale();
      renderFormatControls();
      recompute();
      setLanguageExpanded(false);
    });
  });

  // Watch system dark-mode preference change
  systemDarkQuery.addEventListener("change", () => {
    if (state.themeMode === "system") {
      applyTheme();
    }
  });

  els.jsonInput.addEventListener("input", () => {
    const hadDraftAccounts = draftAccounts().length > 0;
    const text = els.jsonInput.value.trim();
    state.draftSource = text ? { name: draftSourceName(), path: "draft", text } : undefined;
    state.sourceErrors = [];
    recompute();
    if (!hadDraftAccounts && draftAccounts().length > 0) {
      scrollDraftIntoAccountView();
    }
  });

  els.fileInput.addEventListener("change", () => {
    void readFiles(els.fileInput.files);
  });
  els.fileInput.addEventListener("click", (event) => {
    event.stopPropagation();
  });
  els.fileButton.addEventListener("click", (event) => {
    event.stopPropagation();
    els.fileInput.click();
  });
  els.folderButton.addEventListener("click", (event) => {
    event.stopPropagation();
    void chooseDirectory();
  });
  els.dropZone.addEventListener("click", (event) => {
    if (event.target instanceof HTMLElement && event.target.closest("button, .drop-folder-button, input[type='file']")) {
      return;
    }
    els.fileInput.click();
  });

  els.dropZone.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") {
      return;
    }
    event.preventDefault();
    els.fileInput.click();
  });

  els.dropZone.addEventListener("dragover", (event) => {
    event.preventDefault();
    event.stopPropagation();
    els.dropZone.classList.add("dragging");
  });
  els.dropZone.addEventListener("dragleave", () => {
    els.dropZone.classList.remove("dragging");
  });
  els.dropZone.addEventListener("drop", (event) => {
    event.preventDefault();
    event.stopPropagation();
    hideDragOverlay();
    els.dropZone.classList.remove("dragging");
    void readDroppedData(event.dataTransfer);
  });

  window.addEventListener("dragenter", (event) => {
    if (!hasFileDrag(event)) {
      return;
    }
    event.preventDefault();
    if (isInsideDropZone(event)) {
      hideDragOverlay();
      return;
    }
    dragDepth += 1;
    showDragOverlay();
  });

  window.addEventListener("dragover", (event) => {
    if (!hasFileDrag(event)) {
      return;
    }
    event.preventDefault();
    if (isInsideDropZone(event)) {
      hideDragOverlay();
      return;
    }
    showDragOverlay();
  });

  window.addEventListener("dragleave", (event) => {
    if (!hasFileDrag(event) && !els.dragOverlay.classList.contains("active")) {
      return;
    }
    if (isLeavingWindow(event)) {
      hideDragOverlay();
      return;
    }
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) {
      hideDragOverlay();
    }
  });

  window.addEventListener("drop", (event) => {
    if (!hasFileDrag(event)) {
      return;
    }
    event.preventDefault();
    hideDragOverlay();
    void readDroppedData(event.dataTransfer);
  });

  window.addEventListener("blur", hideDragOverlay);

  els.selectAllFormats.addEventListener("change", () => {
    state.selectedFormats = els.selectAllFormats.checked ? [...FORMATS] : [];
    if (!state.selectedFormats.includes(state.previewFormat)) {
      state.previewFormat = state.selectedFormats[0] ?? "cpa";
    }
    persistPreferenceState();
    renderFormatControls();
    recomputeOutput();
  });

  els.jsonlToggle.addEventListener("change", () => {
    state.outputTextMode = els.jsonlToggle.checked ? "jsonl" : "json";
    persistPreferenceState();
    renderFormatControls();
    recomputeOutput();
  });

  els.fakeIdToggle.addEventListener("change", () => {
    state.allowSyntheticIdToken = els.fakeIdToggle.checked;
    persistPreferenceState();
    recomputeOutput();
  });

  els.copyButton.addEventListener("click", () => {
    void copyPreview();
  });

  els.downloadButton.addEventListener("click", () => {
    void downloadCurrentPlan();
  });

  els.inputFormatSelect.addEventListener("change", () => {
    state.forcedInputFormat = els.inputFormatSelect.value as InputFormat | "auto";
    persistPreferences();
    recompute();
  });

  els.clearAccountsButton.addEventListener("click", () => {
    state.accounts = [];
    state.selectedAccountIndex = 0;
    recompute();
  });

  els.sessionButton.addEventListener("click", () => {
    window.open(SESSION_URL, "_blank", "noopener,noreferrer");
  });

  els.addDraftButton.addEventListener("click", () => {
    addDraftAccounts();
  });

  els.clearButton.addEventListener("click", () => {
    els.jsonInput.value = "";
    clearFileInputs();
    state.draftSource = undefined;
    state.sourceErrors = [];
    state.forcedInputFormat = "auto";
    persistPreferences();
    recompute();
  });

  els.accountRows.addEventListener("click", (event) => {
    const removeButton = accountRemoveButton(event.target);
    if (removeButton) {
      const index = accountRemoveIndex(removeButton);
      if (index !== undefined) {
        removeAccount(index);
      }
      return;
    }
    const row = accountEventRow(event.target);
    if (!row) {
      return;
    }
    const index = accountRowIndex(row);
    if (index !== undefined) {
      selectPreviewAccount(index);
    }
  });

  els.accountRows.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") {
      return;
    }
    const row = accountEventRow(event.target);
    if (!row || event.target !== row) {
      return;
    }
    const index = accountRowIndex(row);
    if (index !== undefined) {
      event.preventDefault();
      selectPreviewAccount(index);
    }
  });
}

function applyOutputOptionsFromUrl(): void {
  applyPreferences(parseOutputOptionsSearch(window.location.search));
}

function applyStoredPreferences(): void {
  applyPreferences(readStoredPreferences());
}

function applyPreferences(options: Partial<WebPreferences>): void {
  if (options.selectedFormats) {
    state.selectedFormats = options.selectedFormats;
  }
  if (options.outputTextMode) {
    state.outputTextMode = options.outputTextMode;
  }
  if (options.outputModes) {
    state.outputModes = {
      ...state.outputModes,
      ...options.outputModes,
    };
  }
  if (options.previewFormat) {
    state.previewFormat = options.previewFormat;
  }
  if (!state.selectedFormats.includes(state.previewFormat)) {
    state.previewFormat = state.selectedFormats[0] ?? "cpa";
  }
  if (options.allowSyntheticIdToken !== undefined) {
    state.allowSyntheticIdToken = options.allowSyntheticIdToken;
  }
  if (options.locale) {
    state.locale = options.locale;
  }
  if (options.themeMode) {
    state.themeMode = options.themeMode;
  }
  if (options.forcedInputFormat) {
    state.forcedInputFormat = options.forcedInputFormat;
  }
}

function syncPreferenceControls(): void {
  els.fakeIdToggle.checked = state.allowSyntheticIdToken;
  els.jsonlToggle.checked = state.outputTextMode === "jsonl";
}

function persistPreferenceState(): void {
  writeOutputOptionsToUrl();
  persistPreferences();
}

function persistPreferences(): void {
  writeStoredPreferences({
    selectedFormats: state.selectedFormats,
    outputTextMode: state.outputTextMode,
    outputModes: state.outputModes,
    previewFormat: state.previewFormat,
    allowSyntheticIdToken: state.allowSyntheticIdToken,
    locale: state.locale,
    themeMode: state.themeMode,
    forcedInputFormat: state.forcedInputFormat,
  });
}

function writeOutputOptionsToUrl(): void {
  window.history.replaceState(
    null,
    "",
    outputOptionsUrl(window.location.href, {
      selectedFormats: state.selectedFormats,
      outputTextMode: state.outputTextMode,
      outputModes: state.outputModes,
      previewFormat: state.previewFormat,
      allowSyntheticIdToken: state.allowSyntheticIdToken,
      locale: state.locale,
    }),
  );
}

function webMessages(): ReturnType<typeof messagesFor>["web"] {
  return messagesFor(state.locale).web;
}

function draftSourceName(): string {
  return webMessages().accountLabelPrefixDraft("").trim();
}

function applyLocale(): void {
  const text = webMessages();
  document.documentElement.lang = state.locale === "zh" ? "zh-CN" : "en";
  document.title = text.pageTitle;
  if (state.draftSource?.path === "draft") {
    state.draftSource = { ...state.draftSource, name: draftSourceName() };
  }

  setText("page-title", text.appTitle);
  setText("pageNotice", text.notice);
  setText("dragTitle", text.dragTitle);
  setText("dragSub", text.dragSub);
  setText("themeLabelText", text.themeLabel);
  setText("languageLabelText", text.languageLabel);
  setText("inputTitle", text.inputTitle);
  setText("sessionButtonText", text.sessionButton);
  setText("addDraftButtonText", text.addDraftButton);
  setText("clearButtonText", text.clearButton);
  setText("dropTitle", text.dropTitle);
  setText("dropSub", text.dropSub);
  setText("fileButton", text.chooseFile);
  setText("folderButton", text.chooseFolder);
  els.folderButton.hidden = !canChooseDirectory();
  setText("outputTitle", text.outputTitle);
  setText("downloadBtnText", text.downloadDefault);
  setText("outputOptionsLabel", text.outputOptions);
  setText("exportFormatLabel", text.exportFormat);
  setText("jsonlToggleText", text.jsonlFormat);
  setText("fakeIdToggleText", text.fakeId);
  setText("account-title", text.accountTitle);
  setText("clearAccountsButtonText", text.clearAccounts);
  setText("accountColumnIdentity", text.accountColumns[0]);
  setText("accountColumnPlan", text.accountColumns[1]);
  setText("accountColumnExpires", text.accountColumns[2]);
  setText("accountColumnAction", text.accountColumns[3]);
  setText("copyBtnText", text.copyPreview);

  els.jsonInput.placeholder = text.inputPlaceholder;
  els.jsonInput.setAttribute("aria-label", text.inputAria);
  els.inputFormatSelect.setAttribute("aria-label", text.inputFormatAria);
  els.dropZone.setAttribute("aria-label", text.dropZoneAria);
  els.selectAllFormats.setAttribute("aria-label", text.selectAllFormatsAria);
  els.accountRows.setAttribute("aria-label", text.accountListAria);
  document.querySelector(".workspace")?.setAttribute("aria-label", text.appTitle);
  document.querySelector(".output-toolbar")?.setAttribute("aria-label", text.outputSettingsAria);
  document.querySelector(".preview-section")?.setAttribute("aria-label", text.previewAria);
  els.previewTabsContainer.setAttribute("aria-label", text.previewTabsAria);
  byId("themeToggleTrigger").setAttribute("aria-label", text.themeAria);
  document.querySelector(".language-control")?.setAttribute("aria-label", text.languageAria);

  const themeLabels: Record<ThemeMode, string> = {
    system: text.themeSystem,
    light: text.themeLight,
    dark: text.themeDark,
  };
  document.querySelectorAll<HTMLButtonElement>(".theme-tab").forEach((tab) => {
    const value = tab.dataset.value;
    if (value && isThemeMode(value)) {
      tab.textContent = themeLabels[value];
    }
  });

  document.querySelectorAll<HTMLButtonElement>(".language-tab").forEach((tab) => {
    const active = tab.dataset.lang === state.locale;
    tab.classList.toggle("active", active);
    tab.setAttribute("aria-pressed", String(active));
  });

  bindTooltip(els.jsonlToggleContainer, text.jsonlTooltip);
  bindTooltip(els.fakeIdToggleContainer, text.fakeIdTooltip);
}

function renderFormatControls(): void {
  const text = webMessages();
  els.formatChecks.replaceChildren(
    ...FORMATS.map((format) => {
      const input = document.createElement("input");
      input.type = "checkbox";
      input.id = `opt_${format}`;
      input.checked = state.selectedFormats.includes(format);
      input.addEventListener("change", () => {
        state.selectedFormats = input.checked
          ? [...state.selectedFormats, format]
          : state.selectedFormats.filter((item) => item !== format);
        state.selectedFormats = FORMATS.filter((item) => state.selectedFormats.includes(item));
        if (!state.selectedFormats.includes(state.previewFormat)) {
          state.previewFormat = state.selectedFormats[0] ?? "cpa";
        }
        persistPreferenceState();
        renderFormatControls();
        recomputeOutput();
      });

      const label = document.createElement("label");
      label.className = "format-option-label";
      label.htmlFor = `opt_${format}`;
      label.textContent = FORMAT_LABELS[format];

      const option = document.createElement("div");
      option.className = "format-option";
      option.append(input, label);
      if (format === "codexmanager") {
        bindTooltip(option, text.codexManagerTooltip);
      }
      if (format === "codex") {
        bindTooltip(option, text.codexTooltip);
      }

      if (input.checked && isMergedFormat(format) && state.outputTextMode === "json") {
        option.append(renderFormatModeControl(format));
      }
      return option;
    }),
  );

  const previewFormats = FORMATS.filter((format) => state.selectedFormats.includes(format));
  if (previewFormats.length === 0) {
    els.previewTabsContainer.replaceChildren();
    els.previewOutput.removeAttribute("aria-labelledby");
  } else {
    els.previewTabsContainer.replaceChildren(
      ...previewFormats.map((format, index) => {
        const tab = document.createElement("button");
        tab.type = "button";
        tab.className = "editor-tab";
        tab.id = previewTabId(format);
        tab.dataset.format = format;
        tab.setAttribute("role", "tab");
        tab.setAttribute("aria-selected", "false");
        tab.setAttribute("aria-controls", "previewOutput");
        tab.textContent = FORMAT_LABELS[format];
        tab.addEventListener("click", () => {
          state.previewFormat = format;
          persistPreferenceState();
          syncPreviewTabs();
          recomputeOutput();
        });
        tab.addEventListener("keydown", (event) => {
          if (event.key !== "ArrowLeft" && event.key !== "ArrowRight" && event.key !== "Home" && event.key !== "End") {
            return;
          }
          event.preventDefault();
          const nextIndex = previewTabIndex(index, previewFormats.length, event.key);
          state.previewFormat = previewFormats[nextIndex] ?? state.previewFormat;
          persistPreferenceState();
          syncPreviewTabs();
          recomputeOutput();
          const tabs = Array.from(els.previewTabsContainer.querySelectorAll<HTMLButtonElement>(".editor-tab"));
          tabs[nextIndex]?.focus();
        });
        return tab;
      }),
    );
    syncPreviewTabs();
  }

  els.selectAllFormats.checked = state.selectedFormats.length === FORMATS.length;
  els.selectAllFormats.indeterminate = state.selectedFormats.length > 0 && state.selectedFormats.length < FORMATS.length;
}

function recompute(): void {
  state.draftParsed = state.draftSource ? parseSource(state.draftSource) : undefined;

  const draft = draftAccounts();
  const activeSource = currentAccountSource();
  refreshSerializedPreview(activeSource.accounts);

  renderInputError();
  renderInputFormatIndicator();
  renderOutputHeader(activeSource);
  renderPreview();
  renderAccountTable(state.accounts, draft, activeSource.kind);
}

function recomputeOutput(): void {
  const activeSource = currentAccountSource();
  refreshSerializedPreview(activeSource.accounts);
  renderOutputHeader(activeSource);
  renderPreview();
  syncAccountRowsPreviewability(activeSource);
}

function parseSource(source: JsonSource, options: { forceAutoInputFormat?: boolean } = {}): ParsedSource {
  try {
    const text = webMessages();
    const parsedInput = parseInputPayloadWithMeta(source.text, { locale: state.locale });
    const input = parsedInput.value;
    const inputFormat = options.forceAutoInputFormat ? undefined : selectedInputFormat();
    const detectedInputFormat = parsedInput.documentCount > 1 ? "unknown" : detectInputFormat(input);
    const result = normalizeInput(input, {
      sourceName: source.name,
      sourcePath: source.path,
    }, {
      ...(inputFormat ? { inputFormat } : {}),
      locale: state.locale,
    });

    if (inputFormat && result.accounts.length === 0) {
      return {
        source,
        accounts: [],
        documentCount: parsedInput.documentCount,
        inputFormat: result.inputFormat,
        detectedInputFormat,
        error: text.inputInvalidFormat(inputFormatLabel(inputFormat, state.locale)),
        errorKind: "input",
      };
    }

    return {
      source,
      accounts: result.accounts,
      documentCount: parsedInput.documentCount,
      inputFormat: result.inputFormat,
      detectedInputFormat,
    };
  } catch (error) {
    return {
      source,
      accounts: [],
      documentCount: 0,
      error: error instanceof Error ? error.message : String(error),
      errorKind: "json",
    };
  }
}

function renderInputError(): void {
  const text = webMessages();
  const errors = [...state.sourceErrors];
  if (state.draftParsed?.error) {
    errors.push(
      state.draftParsed.errorKind === "input"
        ? state.draftParsed.error
        : text.jsonParseFailed(state.draftParsed.error),
    );
  }
  if (errors.length === 0 && state.draftSource && draftAccounts().length === 0) {
    errors.push(text.noAccounts);
  }

  if (errors.length === 0) {
    els.inputError.hidden = true;
    els.inputError.replaceChildren();
    return;
  }

  els.inputError.hidden = false;
  els.inputError.replaceChildren(
    ...errors.map((error) => {
      const item = document.createElement("div");
      item.textContent = error;
      return item;
    }),
  );
}

function renderInputFormatIndicator(): void {
  const text = webMessages();
  const parsed = state.draftParsed;
  const keepVisibleForForcedFormat = state.forcedInputFormat !== "auto" && Boolean(state.draftSource);
  if (!parsed || (parsed.errorKind === "json" && !keepVisibleForForcedFormat)) {
    els.inputFormatContainer.hidden = true;
    return;
  }

  const hasAccounts = parsed.accounts.length > 0;
  if (!hasAccounts && !keepVisibleForForcedFormat) {
    els.inputFormatContainer.hidden = true;
    return;
  }

  const multiDocument = parsed.documentCount > 1;
  const naturalFormat = parsed.detectedInputFormat ?? "unknown";

  if (!multiDocument && naturalFormat === "unknown" && state.forcedInputFormat === "auto" && hasAccounts) {
    els.inputFormatContainer.hidden = true;
    return;
  }

  els.inputFormatContainer.hidden = false;

  const autoLabel = multiDocument
    ? text.inputFormatAutoMixed
    : text.inputFormatAuto(inputFormatLabel(naturalFormat, state.locale));

  // Re-render select options dynamically to keep current best estimates in focus
  const currentValue = state.forcedInputFormat;
  els.inputFormatSelect.replaceChildren();

  const autoOption = document.createElement("option");
  autoOption.value = "auto";
  autoOption.textContent = autoLabel;
  autoOption.selected = currentValue === "auto";
  els.inputFormatSelect.append(autoOption);

  SELECTABLE_INPUT_FORMATS.forEach((fmt) => {
    const opt = document.createElement("option");
    opt.value = fmt;
    opt.textContent = inputFormatLabel(fmt, state.locale);
    opt.selected = currentValue === fmt;
    els.inputFormatSelect.append(opt);
  });
}

function renderSourceBadge(format: InputFormat | undefined): HTMLSpanElement | null {
  if (!format || format === "unknown") {
    return null;
  }
  const badge = document.createElement("span");
  badge.className = `badge-format badge-${format}`;
  badge.textContent = INPUT_FORMAT_BADGE_LABELS[format];
  return badge;
}

function renderOutputHeader(activeSource: ReturnType<typeof activeAccountSource>): void {
  const text = webMessages();
  const activeCount = activeSource.accounts.length;
  const canExport = canExportCurrentPlan(activeSource);
  const zip = canExport && willDownloadZip(activeCount);
  const fileTypeLabel = state.outputTextMode === "jsonl" ? "JSONL" : "JSON";
  const parts = [];
  if (activeCount > 0) {
    parts.push(text.accountCount(activeCount));
  }
  if (canExport) {
    parts.push(state.selectedFormats.length === 1 ? FORMAT_LABELS[state.selectedFormats[0]] : text.formatCount(state.selectedFormats.length));
    parts.push(zip ? "ZIP" : fileTypeLabel);
  }
  els.outputMeta.textContent = parts.join(" · ");
  const draft = draftAccounts();
  els.addDraftButton.disabled = draft.length === 0 || Boolean(state.draftParsed?.error);
  els.copyButton.disabled = !currentPreviewFile();
  els.downloadButton.disabled = !canExport || state.downloadBusy;
  els.downloadBtnText.textContent = state.downloadBusy
    ? text.exportPreparing
    : canExport
      ? text.exportAccounts(activeCount)
      : text.downloadDefault;
  els.downloadButton.removeAttribute("title");
  els.downloadButton.setAttribute("aria-label", downloadButtonLabel(canExport, activeCount, zip));
  renderTextModeControl();

  // Show/Hide Clear Accounts Button
  if (state.accounts.length === 0) {
    els.clearAccountsButton.hidden = true;
  } else {
    els.clearAccountsButton.hidden = false;
  }
}

function renderPreview(): void {
  const text = webMessages();
  const file = currentPreviewFile();
  els.previewOutput.classList.toggle("is-empty", !file);
  const filePathFooter = document.getElementById("previewFilePath");
  const fileTypeFooter = document.getElementById("previewFileType");
  if (!file) {
    if (filePathFooter) {
      filePathFooter.textContent = "";
    }
    if (fileTypeFooter) {
      fileTypeFooter.textContent = `${state.outputTextMode.toUpperCase()} | UTF-8`;
    }
    els.previewOutput.textContent =
      state.selectedFormats.length === 0 ? text.previewNoFormat : text.previewNoInput;
    return;
  }
  if (filePathFooter) {
    filePathFooter.textContent = file.path;
  }
  if (fileTypeFooter) {
    fileTypeFooter.textContent = `${state.outputTextMode.toUpperCase()} | UTF-8`;
  }
  els.previewOutput.innerHTML = highlightJson(file.text);
}

function syncPreviewTabs(): void {
  syncPreviewTabSelection(els.previewTabsContainer.querySelectorAll<HTMLElement>(".editor-tab"), state.previewFormat);
  const activeTab = els.previewTabsContainer.querySelector<HTMLElement>(".editor-tab.active");
  if (activeTab?.id) {
    els.previewOutput.setAttribute("aria-labelledby", activeTab.id);
  } else {
    els.previewOutput.removeAttribute("aria-labelledby");
  }
}

function renderAccountTable(accounts: NormalizedAccount[], draft: NormalizedAccount[], activeKind: AccountSourceKind): void {
  const text = webMessages();
  if (accounts.length === 0 && draft.length === 0) {
    els.accountSection.hidden = true;
    els.accountRows.replaceChildren();
    return;
  }

  els.accountSection.hidden = false;
  const activeCount = activeKind === "draft" ? draft.length : accounts.length;
  const previewable = canSelectPreviewAccount(activeCount);
  els.accountSection.classList.toggle("is-previewable", previewable);
  els.accountRows.replaceChildren(
    ...accounts.map((account, index) => {
      const rowPreviewable = activeKind === "loaded" && previewable;
      const row = document.createElement("div");
      row.className = "account-row";
      row.classList.toggle("is-selectable", rowPreviewable);
      row.tabIndex = rowPreviewable ? 0 : -1;
      row.setAttribute("data-account-index", String(index));
      row.setAttribute("role", "option");
      row.setAttribute("aria-selected", String(rowPreviewable && index === state.selectedAccountIndex));

      // Special rendering for first cell (Account Name + Badge)
      const labelCell = document.createElement("span");
      labelCell.className = "account-cell account-identity-cell";
      labelCell.dataset.label = text.accountCellAccount;

      const idxSpan = document.createElement("span");
      idxSpan.className = "account-cell-index";
      idxSpan.textContent = `${index + 1}. `;

      const valSpan = document.createElement("span");
      valSpan.className = "account-cell-value";
      setAccountIdentityText(valSpan, account);
      bindTooltip(labelCell, accountLabel(account));

      labelCell.append(idxSpan, valSpan);

      const sourceBadge = renderSourceBadge(account.inputFormat);
      if (sourceBadge) {
        labelCell.append(sourceBadge);
      }

      row.append(
        labelCell,
        accountCell(text.planType, account.planType ?? text.unknown),
        accountCell(text.expiresAt, displayExpiresAt(account.expiresAt), account.expiresAt),
        accountActionCell(account, index),
      );
      return row;
    }),
    ...draft.map((account, index) => {
      const rowPreviewable = activeKind === "draft" && previewable;
      const row = document.createElement("div");
      row.className = "account-row is-draft";
      row.classList.toggle("is-selectable", rowPreviewable);
      row.tabIndex = rowPreviewable ? 0 : -1;
      row.setAttribute("data-draft-index", String(index));
      row.setAttribute("role", "option");
      row.setAttribute("aria-selected", String(rowPreviewable && index === state.selectedAccountIndex));
      row.setAttribute("aria-label", text.accountLabelPrefixDraft(accountLabel(account)));

      // Special rendering for Draft row first cell
      const labelCell = document.createElement("span");
      labelCell.className = "account-cell account-identity-cell";
      labelCell.dataset.label = text.accountCellAccount;

      const valSpan = document.createElement("span");
      valSpan.className = "account-cell-value";
      setAccountIdentityText(valSpan, account);
      bindTooltip(labelCell, accountLabel(account));

      labelCell.append(valSpan);

      const sourceBadge = renderSourceBadge(account.inputFormat);
      if (sourceBadge) {
        labelCell.append(sourceBadge);
      }

      row.append(
        labelCell,
        accountCell(text.planType, account.planType ?? text.unknown),
        accountCell(text.expiresAt, displayExpiresAt(account.expiresAt), account.expiresAt),
        emptyActionCell(),
      );
      return row;
    }),
  );
}

function selectPreviewAccount(index: number): void {
  const activeSource = currentAccountSource();
  if (!canSelectPreviewAccount(activeSource.accounts.length)) {
    return;
  }
  const boundedIndex = Math.min(Math.max(index, 0), activeSource.accounts.length - 1);
  if (boundedIndex === state.selectedAccountIndex) {
    return;
  }
  const previousIndex = state.selectedAccountIndex;
  state.selectedAccountIndex = boundedIndex;
  state.serializedFiles = buildSerializedPreviewFiles(activeSource.accounts);
  renderPreview();
  setAccountRowSelected(activeSource.kind, previousIndex, false);
  setAccountRowSelected(activeSource.kind, boundedIndex, true);
}

function addDraftAccounts(): void {
  const textMessages = webMessages();
  const text = els.jsonInput.value.trim();
  if (!text) {
    return;
  }
  const sourceIndex = state.nextInputIndex;
  const parsed = parseSource({
    name: textMessages.sourceName(sourceIndex),
    path: `input-${sourceIndex}`,
    text,
  });
  if (parsed.error || parsed.accounts.length === 0) {
    state.draftParsed = parsed;
    recompute();
    return;
  }
  const beforeCount = state.accounts.length;
  state.accounts.push(...parsed.accounts);
  const dedupeResult = dedupeAccountsWithAffectedIndex(state.accounts, beforeCount);
  state.accounts = dedupeResult.accounts;
  const summary = importSummary(parsed.accounts.length, beforeCount, state.accounts.length);
  state.nextInputIndex += 1;
  state.selectedAccountIndex = dedupeResult.affectedIndex ?? 0;
  els.jsonInput.value = "";
  clearFileInputs();
  state.draftSource = undefined;
  state.draftParsed = undefined;
  state.sourceErrors = [];
  triggerLogoSparkle();
  showToast(textMessages.sourceImported(summary.processed, summary.added, summary.merged));
  recompute();
}

function removeAccount(index: number): void {
  state.accounts.splice(index, 1);
  state.selectedAccountIndex = selectedIndexAfterRemoval(state.selectedAccountIndex, index, state.accounts.length);
  recompute();
}

function draftAccounts(): NormalizedAccount[] {
  return state.draftParsed?.accounts ?? [];
}

function currentAccountSource(): ReturnType<typeof activeAccountSource> {
  return activeAccountSource(state.accounts, draftAccounts());
}

function currentOutputModes(): OutputModes {
  return effectiveWebOutputModes(state.outputModes, state.outputTextMode);
}

function refreshSerializedPreview(accounts: NormalizedAccount[]): void {
  if (state.selectedAccountIndex >= accounts.length) {
    state.selectedAccountIndex = Math.max(accounts.length - 1, 0);
  }
  state.serializedFiles = buildSerializedPreviewFiles(accounts);
}

function buildSerializedOutputFiles(accounts: NormalizedAccount[], formats: OutputFormat[]): SerializedOutputFile[] {
  if (accounts.length === 0 || formats.length === 0) {
    return [];
  }
  return serializeOutputFiles(
    buildOutputPlan(accounts, formats, {
      outputModes: currentOutputModes(),
      allowSyntheticIdToken: state.allowSyntheticIdToken,
    }),
    state.outputTextMode,
  );
}

function buildSerializedPreviewFiles(accounts: NormalizedAccount[]): SerializedOutputFile[] {
  if (!state.selectedFormats.includes(state.previewFormat) || accounts.length === 0) {
    return [];
  }
  const boundedIndex = Math.min(state.selectedAccountIndex, accounts.length - 1);
  const previewAccounts = canSelectPreviewAccount(accounts.length)
    ? accounts.slice(boundedIndex, boundedIndex + 1)
    : accounts;
  return buildSerializedOutputFiles(previewAccounts, [state.previewFormat]);
}

function selectedInputFormat(): InputFormat | undefined {
  return state.forcedInputFormat === "auto" || state.forcedInputFormat === "unknown"
    ? undefined
    : state.forcedInputFormat;
}

function currentPreviewFile(): SerializedOutputFile | undefined {
  return state.serializedFiles[0];
}

function canSelectPreviewAccount(accountCount: number): boolean {
  return accountCount > 1 && isPreviewFormatPerAccount(state.previewFormat);
}

function isPreviewFormatPerAccount(format: OutputFormat): boolean {
  if (!state.selectedFormats.includes(format)) {
    return false;
  }
  if (state.outputTextMode === "jsonl") {
    return true;
  }
  return !isMergedFormat(format) || currentOutputModes()[format] === "single";
}

function accountEventRow(target: EventTarget | null): HTMLElement | undefined {
  if (!(target instanceof HTMLElement)) {
    return undefined;
  }
  const row = target.closest<HTMLElement>(".account-row.is-selectable");
  return row && els.accountRows.contains(row) ? row : undefined;
}

function accountRemoveButton(target: EventTarget | null): HTMLButtonElement | undefined {
  if (!(target instanceof HTMLElement)) {
    return undefined;
  }
  const button = target.closest<HTMLButtonElement>(".remove-account-button");
  return button && els.accountRows.contains(button) ? button : undefined;
}

function accountRemoveIndex(button: HTMLButtonElement): number | undefined {
  const rawIndex = button.dataset.removeAccountIndex;
  if (rawIndex === undefined) {
    return undefined;
  }
  const index = Number(rawIndex);
  return Number.isInteger(index) && index >= 0 ? index : undefined;
}

function accountRowIndex(row: HTMLElement): number | undefined {
  const rawIndex = row.dataset.accountIndex ?? row.dataset.draftIndex;
  if (rawIndex === undefined) {
    return undefined;
  }
  const index = Number(rawIndex);
  return Number.isInteger(index) && index >= 0 ? index : undefined;
}

function setAccountRowSelected(kind: AccountSourceKind, index: number, selected: boolean): void {
  if (kind !== "loaded" && kind !== "draft") {
    return;
  }
  const attribute = kind === "loaded" ? "data-account-index" : "data-draft-index";
  const row = els.accountRows.querySelector<HTMLElement>(`[${attribute}="${index}"]`);
  row?.setAttribute("aria-selected", String(selected));
}

function scrollDraftIntoAccountView(): void {
  requestAnimationFrame(() => {
    const row = els.accountRows.querySelector<HTMLElement>("[data-draft-index=\"0\"]");
    if (!row) {
      return;
    }
    scrollElementIntoContainer(row, els.accountRows);
  });
}

function scrollElementIntoContainer(element: HTMLElement, container: HTMLElement): void {
  const elementRect = element.getBoundingClientRect();
  const containerRect = container.getBoundingClientRect();
  if (elementRect.top < containerRect.top) {
    container.scrollTop -= containerRect.top - elementRect.top;
  } else if (elementRect.bottom > containerRect.bottom) {
    container.scrollTop += elementRect.bottom - containerRect.bottom;
  }
}

function syncAccountRowsPreviewability(activeSource: ReturnType<typeof activeAccountSource>): void {
  if (activeSource.kind === "empty") {
    return;
  }
  const previewable = canSelectPreviewAccount(activeSource.accounts.length);
  const previousPreviewable = els.accountSection.classList.contains("is-previewable");
  if (previewable === previousPreviewable) {
    return;
  }

  els.accountSection.classList.toggle("is-previewable", previewable);
  syncAccountRowsByKind("loaded", activeSource.kind === "loaded" && previewable);
  syncAccountRowsByKind("draft", activeSource.kind === "draft" && previewable);
}

function syncAccountRowsByKind(kind: Exclude<AccountSourceKind, "empty">, selectable: boolean): void {
  const selector = kind === "loaded" ? "[data-account-index]" : "[data-draft-index]";
  const rows = els.accountRows.querySelectorAll<HTMLElement>(selector);
  rows.forEach((row) => {
    const index = accountRowIndex(row);
    row.classList.toggle("is-selectable", selectable);
    row.tabIndex = selectable ? 0 : -1;
    row.setAttribute("aria-selected", String(selectable && index === state.selectedAccountIndex));
  });
}

async function readFiles(fileList: FileList | null): Promise<void> {
  try {
    const allFiles = Array.from(fileList ?? []);
    await readSources(await fileSourcesFromFiles(allFiles), allFiles.length);
  } catch (error) {
    reportFileReadError(error);
  }
}

async function readDroppedData(dataTransfer: DataTransfer | null): Promise<void> {
  try {
    const droppedSources = await fileSourcesFromDataTransfer(dataTransfer);
    if (droppedSources) {
      await readSources(droppedSources.sources, droppedSources.itemCount);
      return;
    }
    await readFiles(dataTransfer?.files ?? null);
  } catch (error) {
    reportFileReadError(error);
  }
}

async function chooseDirectory(): Promise<void> {
  const picker = (window as WindowWithDirectoryPicker).showDirectoryPicker;
  if (!picker) {
    return;
  }
  try {
    const directory = await picker.call(window);
    await readSources(await fileSourcesFromFileSystemHandle(directory), 1);
  } catch (error) {
    if (isAbortError(error)) {
      return;
    }
    reportFileReadError(error);
  }
}

async function readSources(sources: JsonSource[], itemCount: number): Promise<void> {
  const text = webMessages();
  if (itemCount > 0 && sources.length === 0) {
    state.sourceErrors = [text.chooseJsonFile];
    clearFileInputs();
    recompute();
    return;
  }
  const parsed = sources.map((source) => parseSource(source, { forceAutoInputFormat: true }));
  const nextAccounts = parsed.flatMap((item) => item.accounts);
  if (nextAccounts.length > 0) {
    const beforeCount = state.accounts.length;
    state.accounts.push(...nextAccounts);
    const dedupeResult = dedupeAccountsWithAffectedIndex(state.accounts, beforeCount);
    state.accounts = dedupeResult.accounts;
    state.selectedAccountIndex = dedupeResult.affectedIndex ?? 0;
    const summary = importSummary(nextAccounts.length, beforeCount, state.accounts.length);
    triggerLogoSparkle();
    showToast(text.fileImported(summary.processed, summary.added, summary.merged));
  }
  state.sourceErrors = parsed
    .filter((item) => item.error || item.accounts.length === 0)
    .map((item) => {
      if (!item.error) {
        return text.fileNoAccounts(item.source.name);
      }
      return item.errorKind === "input"
        ? text.fileInvalidInput(item.source.name, item.error)
        : text.fileJsonFailed(item.source.name, item.error);
    });
  clearFileInputs();
  recompute();
}

async function fileSourcesFromFiles(files: File[]): Promise<JsonSource[]> {
  const importFiles = files
    .map((file) => ({ file, path: filePath(file) }))
    .filter((item) => isCredentialImportPath(item.path))
    .sort((left, right) => left.path.localeCompare(right.path));

  const sourceGroups = await Promise.all(
    importFiles.map(({ file, path }) => fileSourcesFromFile(file, path)),
  );
  return sourceGroups.flat();
}

async function fileSourcesFromDataTransfer(dataTransfer: DataTransfer | null): Promise<{ sources: JsonSource[]; itemCount: number } | undefined> {
  const items = Array.from(dataTransfer?.items ?? []);
  const handlePromises = items.map(droppedFileSystemHandle);
  const handles = (await Promise.all(handlePromises)).filter((handle): handle is FileSystemHandleLike => Boolean(handle));
  if (handles.length > 0) {
    const sourceGroups = await Promise.all(handles.map((handle) => fileSourcesFromFileSystemHandle(handle)));
    const sources = sourceGroups.flat().sort((left, right) => left.path.localeCompare(right.path));
    return {
      sources,
      itemCount: items.length,
    };
  }

  const entries = items
    .map(droppedEntry)
    .filter((entry): entry is FileSystemEntryLike => Boolean(entry));

  if (entries.length === 0) {
    return undefined;
  }

  try {
    const sourceGroups = await Promise.all(entries.map((entry) => fileSourcesFromEntry(entry)));
    const sources = sourceGroups.flat().sort((left, right) => left.path.localeCompare(right.path));
    return {
      sources,
      itemCount: items.length,
    };
  } catch {
    return undefined;
  }
}

function droppedFileSystemHandle(item: DataTransferItem): Promise<FileSystemHandleLike | undefined> {
  return (item as DataTransferItemWithFileSystemHandle).getAsFileSystemHandle?.()
    .then((handle) => handle ?? undefined)
    .catch(() => undefined) ?? Promise.resolve(undefined);
}

async function fileSourcesFromFileSystemHandle(handle: FileSystemHandleLike, basePath = handle.name): Promise<JsonSource[]> {
  if (handle.kind === "file") {
    const path = normalizeDroppedPath(basePath || handle.name);
    if (!isCredentialImportPath(path)) {
      return [];
    }
    const file = await handle.getFile();
    return fileSourcesFromFile(file, path);
  }

  const sourceGroups: JsonSource[][] = [];
  for await (const child of fileSystemDirectoryChildren(handle)) {
    sourceGroups.push(await fileSourcesFromFileSystemHandle(child, `${basePath}/${child.name}`));
  }
  return sourceGroups.flat();
}

async function* fileSystemDirectoryChildren(handle: FileSystemDirectoryHandleLike): AsyncIterable<FileSystemHandleLike> {
  if (handle.values) {
    for await (const child of handle.values()) {
      yield child;
    }
    return;
  }
  if (handle.entries) {
    for await (const [, child] of handle.entries()) {
      yield child;
    }
  }
}

function droppedEntry(item: DataTransferItem): FileSystemEntryLike | undefined {
  const entry = (item as DataTransferItemWithEntry).webkitGetAsEntry?.();
  return entry ? entry as FileSystemEntryLike : undefined;
}

async function fileSourcesFromEntry(entry: FileSystemEntryLike): Promise<JsonSource[]> {
  if (entry.isFile) {
    const fileEntry = entry as FileSystemFileEntryLike;
    const entryPath = normalizeDroppedPath(entry.fullPath || entry.name);
    if (!isCredentialImportPath(entryPath)) {
      return [];
    }
    const file = await fileFromEntry(fileEntry);
    const path = entryPath || filePath(file);
    if (!isCredentialImportPath(path)) {
      return [];
    }
    return fileSourcesFromFile(file, path);
  }

  if (!entry.isDirectory) {
    return [];
  }

  const directoryEntry = entry as FileSystemDirectoryEntryLike;
  const entries = await readDirectoryEntries(directoryEntry);
  const sourceGroups = await Promise.all(entries.map((child) => fileSourcesFromEntry(child)));
  return sourceGroups.flat();
}

function fileFromEntry(entry: FileSystemFileEntryLike): Promise<File> {
  return new Promise((resolve, reject) => {
    entry.file(resolve, reject);
  });
}

function readDirectoryEntries(entry: FileSystemDirectoryEntryLike): Promise<FileSystemEntryLike[]> {
  const reader = entry.createReader();
  const entries: FileSystemEntryLike[] = [];

  return new Promise((resolve, reject) => {
    const readNextBatch = () => {
      reader.readEntries((batch) => {
        if (batch.length === 0) {
          resolve(entries);
          return;
        }
        entries.push(...batch);
        readNextBatch();
      }, reject);
    };
    readNextBatch();
  });
}

function filePath(file: File): string {
  const relativePath = (file as File & { webkitRelativePath?: string }).webkitRelativePath;
  return normalizeDroppedPath(relativePath || file.name);
}

function clearFileInputs(): void {
  els.fileInput.value = "";
}

function reportFileReadError(error: unknown): void {
  state.sourceErrors = [webMessages().fileReadFailed(errorMessage(error))];
  clearFileInputs();
  recompute();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function normalizeDroppedPath(value: string): string {
  return value.replace(/^\/+/, "") || "input.json";
}

async function fileSourcesFromFile(file: File, path: string): Promise<JsonSource[]> {
  if (isZipCredentialPath(path)) {
    return extractZipJsonSources(path, new Uint8Array(await file.arrayBuffer()));
  }
  if (isJsonCredentialPath(path)) {
    return [{
      name: path,
      path,
      text: await file.text(),
    }];
  }
  return [];
}

function canChooseDirectory(): boolean {
  return typeof (window as WindowWithDirectoryPicker).showDirectoryPicker === "function";
}

async function copyPreview(): Promise<void> {
  const text = webMessages();
  const file = currentPreviewFile();
  if (!file) {
    return;
  }
  try {
    await navigator.clipboard.writeText(file.text);
    const copyTextSpan = document.getElementById("copyBtnText");
    const copyIconSvg = document.getElementById("copyIcon");
    if (copyTextSpan) {
      copyTextSpan.textContent = text.copied;
    }
    copyIconSvg?.toggleAttribute("hidden", true);
    els.copyButton.classList.add("btn-copy-success");
    showToast(text.copyToast);
    window.clearTimeout(copyResetTimer);
    copyResetTimer = window.setTimeout(() => {
      if (copyTextSpan) {
        copyTextSpan.textContent = webMessages().copyPreview;
      }
      copyIconSvg?.toggleAttribute("hidden", false);
      els.copyButton.classList.remove("btn-copy-success");
    }, 1500);
  } catch {
    showToast(text.copyFailed);
  }
}

async function downloadCurrentPlan(): Promise<void> {
  const text = webMessages();
  const activeSource = currentAccountSource();
  if (state.downloadBusy || !canExportCurrentPlan(activeSource)) {
    return;
  }

  const zip = willDownloadZip(activeSource.accounts.length);
  if (zip) {
    state.downloadBusy = true;
    renderOutputHeader(activeSource);
    try {
      await nextAnimationFrame();
      const serializedFiles = buildSerializedOutputFiles(activeSource.accounts, state.selectedFormats);
      const bytes = zipOutputFiles(serializedFiles);
      const payload = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
      const name = zipDownloadName(activeSource.accounts);
      downloadBlob(new Blob([payload], { type: "application/zip" }), name);
      showToast(text.exportZipToast(name));
    } finally {
      state.downloadBusy = false;
      renderOutputHeader(activeSource);
    }
    return;
  }

  const file = buildSerializedOutputFiles(activeSource.accounts, state.selectedFormats)[0];
  if (!file) {
    return;
  }
  downloadBlob(new Blob([file.text], { type: outputMimeType() }), file.path.split("/").pop() ?? outputFallbackName());
  showToast(text.exportFileToast);
}

function nextAnimationFrame(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => resolve());
  });
}

function downloadBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function renderFormatModeControl(format: OutputFormat): HTMLSpanElement {
  const text = webMessages();
  const mode = state.outputModes[format] ?? "merged";
  const control = document.createElement("span");
  control.className = "format-mode-control";

  const button = document.createElement("button");
  button.type = "button";
  button.className = "format-mode-button";
  button.textContent = mode === "single" ? text.modeSingle : text.modeMerged;
  const tip = mode === "single" ? text.modeSingleTip : text.modeMergedTip;
  button.setAttribute(
    "aria-label",
    text.modeAria(FORMAT_LABELS[format], button.textContent, tip, text.nextModeLabel(mode)),
  );
  bindTooltip(button, tip);
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    const nextMode = nextOutputMode(mode);
    state.outputModes = {
      ...state.outputModes,
      [format]: nextMode,
    };
    persistPreferenceState();
    renderFormatControls();
    recomputeOutput();
  });

  control.append(button);
  return control;
}

function createTooltip(): HTMLDivElement {
  const element = document.createElement("div");
  element.id = "appTooltip";
  element.className = "app-tooltip";
  element.setAttribute("role", "tooltip");
  element.hidden = true;
  document.body.append(element);
  window.addEventListener("scroll", hideTooltip, true);
  window.addEventListener("resize", hideTooltip);
  return element;
}

function bindTooltip(target: HTMLElement, text: string): void {
  target.dataset.tooltip = text;
  if (tooltipTargets.has(target)) {
    return;
  }
  tooltipTargets.add(target);
  target.setAttribute("aria-describedby", "appTooltip");
  target.addEventListener("mouseenter", () => showTooltip(target, target.dataset.tooltip ?? ""));
  target.addEventListener("mouseleave", hideTooltip);
  target.addEventListener("focusin", () => showTooltip(target, target.dataset.tooltip ?? ""));
  target.addEventListener("focusout", hideTooltip);
}

function showTooltip(target: HTMLElement, text: string): void {
  if (!text) {
    return;
  }
  tooltip.textContent = text;
  tooltip.hidden = false;
  const rect = target.getBoundingClientRect();
  const tooltipRect = tooltip.getBoundingClientRect();
  const viewportPadding = 8;
  const top = rect.bottom + tooltipRect.height + 14 <= window.innerHeight
    ? rect.bottom + 8
    : Math.max(viewportPadding, rect.top - tooltipRect.height - 8);
  const left = Math.min(
    Math.max(viewportPadding, rect.left + rect.width / 2 - tooltipRect.width / 2),
    window.innerWidth - tooltipRect.width - viewportPadding,
  );
  tooltip.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
}

function hideTooltip(): void {
  tooltip.hidden = true;
}

function nextOutputMode(mode: OutputMode): OutputMode {
  return mode === "single" ? "merged" : "single";
}

function previewTabIndex(currentIndex: number, count: number, key: string): number {
  if (key === "Home") {
    return 0;
  }
  if (key === "End") {
    return count - 1;
  }
  if (key === "ArrowLeft") {
    return (currentIndex - 1 + count) % count;
  }
  return (currentIndex + 1) % count;
}

function accountLabel(account: NormalizedAccount): string {
  return account.email ?? account.name ?? account.chatgptAccountId ?? account.accountId ?? account.userId ?? webMessages().accountLabelFallback;
}

function setAccountIdentityText(element: HTMLElement, account: NormalizedAccount): void {
  const label = accountLabel(account);
  const accountId = account.accountId ?? account.chatgptAccountId;

  element.textContent = "";
  const mainSpan = document.createElement("span");
  mainSpan.className = "account-identity-main";
  mainSpan.textContent = label;
  element.append(mainSpan);

  if (accountId) {
    const subSpan = document.createElement("span");
    subSpan.className = "account-identity-sub";
    subSpan.textContent = accountId;
    element.append(subSpan);
    element.setAttribute("aria-label", `${label} (${accountId})`);
  } else {
    element.setAttribute("aria-label", label);
  }
}

function displayExpiresAt(value: string | undefined): string {
  if (!value) {
    return webMessages().unknown;
  }
  const isoMinute = value.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/);
  return isoMinute ? `${isoMinute[1]} ${isoMinute[2]}` : value;
}

function accountCell(label: string, value: string, title?: string): HTMLSpanElement {
  const cell = document.createElement("span");
  cell.className = "account-cell";
  cell.dataset.label = label;
  cell.textContent = value;
  cell.setAttribute("title", title ?? value);
  if (title && title !== value) {
    cell.setAttribute("aria-label", `${label}: ${title}`);
  }
  return cell;
}

function accountActionCell(account: NormalizedAccount, index: number): HTMLSpanElement {
  const text = webMessages();
  const cell = document.createElement("span");
  cell.className = "account-actions";
  cell.dataset.label = text.action;
  const button = document.createElement("button");
  button.type = "button";
  button.className = "remove-account-button";
  button.textContent = text.remove;
  button.dataset.removeAccountIndex = String(index);
  button.setAttribute("aria-label", text.removeAccount(accountLabel(account)));
  cell.append(button);
  return cell;
}

function emptyActionCell(): HTMLSpanElement {
  const cell = document.createElement("span");
  cell.className = "account-actions is-empty";
  cell.dataset.label = webMessages().action;
  cell.setAttribute("aria-hidden", "true");
  return cell;
}


function downloadButtonLabel(canExport: boolean, accountCount: number, zip: boolean): string {
  if (!canExport) {
    return webMessages().downloadDefault;
  }
  return webMessages().exportAria(accountCount, state.outputTextMode === "jsonl", zip);
}

function outputMimeType(): string {
  return state.outputTextMode === "jsonl" ? "application/x-ndjson" : "application/json";
}

function outputFallbackName(): string {
  return state.outputTextMode === "jsonl" ? "authconv.jsonl" : "authconv.json";
}

function canExportCurrentPlan(activeSource: ReturnType<typeof activeAccountSource>): boolean {
  return state.selectedFormats.length > 0 && activeSource.accounts.length > 0;
}

function willDownloadZip(accountCount: number): boolean {
  if (accountCount <= 0 || state.selectedFormats.length === 0) {
    return false;
  }
  if (state.selectedFormats.length > 1) {
    return true;
  }
  if (state.outputTextMode === "jsonl") {
    return false;
  }
  const format = state.selectedFormats[0];
  if (isMergedFormat(format) && currentOutputModes()[format] !== "single") {
    return false;
  }
  return accountCount > 1;
}

function renderTextModeControl(): void {
  els.jsonlToggle.checked = state.outputTextMode === "jsonl";
  els.jsonlToggle.setAttribute("aria-checked", String(els.jsonlToggle.checked));
}

function highlightJson(text: string): string {
  return escapeHtml(text).replace(
    /("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+-]?\d+)?)/g,
    (match) => {
      let className = "json-number";
      if (match.startsWith('"')) {
        className = match.endsWith(":") ? "json-key" : "json-string";
      } else if (match === "true" || match === "false") {
        className = "json-boolean";
      } else if (match === "null") {
        className = "json-null";
      }
      if (className === "json-key") {
        return `<span class="${className}">${match.slice(0, -1)}</span>:`;
      }
      return `<span class="${className}">${match}</span>`;
    },
  );
}

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function showToast(message: string): void {
  window.clearTimeout(toastTimer);
  els.toastMessage.textContent = message;
  els.toast.hidden = false;
  requestAnimationFrame(() => {
    els.toast.classList.add("show");
  });
  toastTimer = window.setTimeout(() => {
    els.toast.classList.remove("show");
    toastTimer = window.setTimeout(() => {
      els.toast.hidden = true;
    }, 360);
  }, 2200);
}

function triggerLogoSparkle(): void {
  els.logoIcon.classList.remove("sparkle");
  void els.logoIcon.offsetWidth;
  els.logoIcon.classList.add("sparkle");
}

function setThemeExpanded(expanded: boolean): void {
  const themeControl = document.querySelector(".theme-control");
  const themeTrigger = document.getElementById("themeToggleTrigger");
  themeControl?.classList.toggle("expanded", expanded);
  themeTrigger?.setAttribute("aria-expanded", String(expanded));
  document.querySelectorAll<HTMLButtonElement>(".theme-tab").forEach((tab) => {
    tab.tabIndex = expanded ? 0 : -1;
  });
}

function setLanguageExpanded(expanded: boolean): void {
  const langControl = document.querySelector(".language-control");
  const langTrigger = document.getElementById("languageToggleTrigger");
  langControl?.classList.toggle("expanded", expanded);
  langTrigger?.setAttribute("aria-expanded", String(expanded));
  document.querySelectorAll<HTMLButtonElement>(".language-tab").forEach((tab) => {
    tab.tabIndex = expanded ? 0 : -1;
  });
}

function showDragOverlay(): void {
  els.dragOverlay.classList.add("active");
  els.dragOverlay.setAttribute("aria-hidden", "true");
}

function hideDragOverlay(): void {
  dragDepth = 0;
  els.dragOverlay.classList.remove("active");
  els.dragOverlay.setAttribute("aria-hidden", "true");
}

function hasFileDrag(event: DragEvent): boolean {
  const types = event.dataTransfer?.types;
  if (!types) {
    return false;
  }
  for (let index = 0; index < types.length; index += 1) {
    if (types[index] === "Files") {
      return true;
    }
  }
  return false;
}

function isInsideDropZone(event: DragEvent): boolean {
  return event.target instanceof Node && els.dropZone.contains(event.target);
}

function isLeavingWindow(event: DragEvent): boolean {
  const nextTarget = event.relatedTarget;
  if (nextTarget instanceof Node) {
    return false;
  }
  return event.clientX <= 0
    || event.clientY <= 0
    || event.clientX >= window.innerWidth
    || event.clientY >= window.innerHeight;
}

function applyTheme(): void {
  const theme = state.themeMode === "system" ? (systemDarkQuery.matches ? "dark" : "light") : state.themeMode;
  document.documentElement.dataset.theme = theme;

  // Active state highlighting for segmented controls
  document.querySelectorAll(".theme-tab").forEach((tab) => {
    const active = tab.getAttribute("data-value") === state.themeMode;
    tab.classList.toggle("active", active);
    tab.setAttribute("aria-pressed", String(active));
  });

  // Dynamically swap the SVG sun or moon icon based on the active actual theme
  const iconContainer = document.getElementById("themeIconContainer");
  if (iconContainer) {
    if (theme === "dark") {
      iconContainer.innerHTML = `<svg class="theme-icon" viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path></svg>`;
    } else {
      iconContainer.innerHTML = `<svg class="theme-icon" viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="5"></circle><line x1="12" y1="1" x2="12" y2="3"></line><line x1="12" y1="21" x2="12" y2="23"></line><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"></line><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"></line><line x1="1" y1="12" x2="3" y2="12"></line><line x1="21" y1="12" x2="23" y2="12"></line><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"></line><line x1="18.36" y1="4.22" x2="19.78" y2="5.64"></line></svg>`;
    }
  }
}

function previewTabId(format: OutputFormat): string {
  return `preview-tab-${format}`;
}

function isThemeMode(value: string): value is ThemeMode {
  return value === "system" || value === "light" || value === "dark";
}

function isOutputTextMode(value: string | undefined): value is OutputTextMode {
  return value === "json" || value === "jsonl";
}

function isMergedFormat(format: OutputFormat): boolean {
  return MODE_FORMATS.has(format);
}

function setText(id: string, text: string): void {
  const element = document.getElementById(id);
  if (element) {
    element.textContent = text;
  }
}

function byId<T extends HTMLElement = HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) {
    throw new Error(`缺少页面节点: ${id}`);
  }
  return element as T;
}
