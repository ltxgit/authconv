import type { AccountListItem, AccountRange } from "../account-store.js";
import {
  ALL_FORMATS,
  effectiveFormats as selectEffectiveFormats,
  FORMAT_DEFINITIONS,
  isConfigurableOutputFormat,
  resolveOutputMode,
} from "../formats.js";
import { FORMAT_LABELS, INPUT_FORMAT_BADGE_LABELS, inputFormatLabel, messagesFor } from "../i18n.js";
import type {
  InputFormat,
  Locale,
  OutputFormat,
  OutputModes,
  OutputTextMode,
  Provider,
  TokenVerificationReason,
  TokenVerificationStatus,
} from "../types.js";
import type { ThemeMode } from "./preferences.js";
import type { WorkerOutputPlan, WorkerSummary } from "./worker-protocol.js";
import { jwtPopoverText } from "./jwt-preview.js";

const INPUT_FORMATS: InputFormat[] = ["session", "sub2api", "cpa", "grok", "codexmanager", "codex2api", "codex"];

export type WebViewState = {
  selectedFormats: OutputFormat[];
  outputModes: OutputModes;
  textMode: OutputTextMode;
  previewFormat: OutputFormat;
  allowSyntheticIdToken: boolean;
  includeRefreshToken: boolean;
  verifyTokens: boolean;
  outputPlan: WorkerOutputPlan;
  locale: Locale;
  themeMode: ThemeMode;
  forcedInputFormat: InputFormat | "auto";
  summary: WorkerSummary;
  selectedAccountId?: string;
  query: string;
  previewText: string;
  previewPath: string;
  previewShown: number;
  previewTotal: number;
  previewBlocked?: TokenVerificationStatus;
  draftReady: boolean;
  busy: boolean;
  transientError?: string;
};

type ViewActions = {
  setFormat: (format: OutputFormat, selected: boolean) => void;
  setPreviewFormat: (format: OutputFormat) => void;
  setOutputMode: (format: OutputFormat, mode: "merged" | "single") => void;
};

export class WebView {
  readonly elements = {
    jsonInput: byId<HTMLTextAreaElement>("jsonInput"),
    fileInput: byId<HTMLInputElement>("fileInput"),
    inputFormatContainer: byId("inputFormatContainer"),
    inputFormatSelect: byId<HTMLSelectElement>("inputFormatSelect"),
    inputError: byId("inputError"),
    dropZone: byId("dropZone"),
    dragOverlay: byId("dragOverlay"),
    fileButton: byId<HTMLButtonElement>("fileButton"),
    folderButton: byId<HTMLButtonElement>("folderButton"),
    formatChecks: byId("formatChecks"),
    selectAllFormats: byId<HTMLInputElement>("selectAllFormats"),
    jsonlToggle: byId<HTMLInputElement>("jsonlToggle"),
    jsonlToggleContainer: byId("jsonlToggleContainer"),
    fakeIdToggle: byId<HTMLInputElement>("fakeIdToggle"),
    fakeIdToggleContainer: byId("fakeIdToggleContainer"),
    refreshTokenToggle: byId<HTMLInputElement>("refreshTokenToggle"),
    refreshTokenToggleContainer: byId("refreshTokenToggleContainer"),
    verifyTokenToggle: byId<HTMLInputElement>("verifyTokenToggle"),
    verifyTokenToggleContainer: byId("verifyTokenToggleContainer"),
    previewTabs: byId("previewTabsContainer"),
    previewOutput: byId("previewOutput"),
    previewFilePath: byId("previewFilePath"),
    previewFileType: byId("previewFileType"),
    outputMeta: byId("outputMeta"),
    accountSection: byId("accountSection"),
    accountCount: byId("accountCount"),
    accountRows: byId("accountRows"),
    accountSearch: byId<HTMLInputElement>("accountSearch"),
    clearAccountsButton: byId<HTMLButtonElement>("clearAccountsButton"),
    addDraftButton: byId<HTMLButtonElement>("addDraftButton"),
    clearButton: byId<HTMLButtonElement>("clearButton"),
    sessionButton: byId<HTMLButtonElement>("sessionButton"),
    downloadButton: byId<HTMLButtonElement>("downloadButton"),
    downloadBtnText: byId("downloadBtnText"),
    copyButton: byId<HTMLButtonElement>("copyButton"),
    toast: byId("toast"),
    toastMessage: byId("toastMessage"),
    taskOverlay: byId("taskOverlay"),
    taskStage: byId("taskStage"),
    taskProgress: byId("taskProgress"),
    cancelTaskButton: byId<HTMLButtonElement>("cancelTaskButton"),
    jwtPopover: byId("jwtPopover"),
    jwtPopoverBody: byId("jwtPopoverBody"),
    jwtPopoverCopy: byId<HTMLButtonElement>("jwtPopoverCopy"),
  };
  readonly #tooltip = createTooltip();
  readonly #tooltipTargets = new WeakSet<HTMLElement>();

  constructor(
    readonly state: WebViewState,
    readonly actions: ViewActions,
    readonly rowHeight: number,
  ) {}

  renderAll(): void {
    this.renderInputState();
    this.renderFormats();
    this.renderOutputHeader();
    this.renderAccountSection();
    this.renderPreview();
  }

  renderInputState(): void {
    const text = this.elements.jsonInput.value.trim();
    this.elements.inputFormatContainer.hidden = !text;
    if (text) this.#renderInputFormatOptions();
    const errors = this.state.summary.diagnostics.map((diagnostic) => this.#diagnosticText(diagnostic));
    if (this.state.transientError) errors.push(this.state.transientError);
    this.elements.inputError.hidden = errors.length === 0;
    this.elements.inputError.replaceChildren(...errors.map((message) => {
      const row = document.createElement("div");
      row.textContent = message;
      return row;
    }));
    this.elements.addDraftButton.disabled = !this.state.draftReady || this.state.busy;
  }

  renderFormats(): void {
    const formats = this.state.summary.applicableFormats;
    this.elements.formatChecks.replaceChildren(...formats.map((format) => this.#formatCard(format)));
    const selectedVisible = formats.filter((format) => this.state.selectedFormats.includes(format)).length;
    this.elements.selectAllFormats.checked = formats.length > 0 && selectedVisible === formats.length;
    this.elements.selectAllFormats.indeterminate = selectedVisible > 0 && selectedVisible < formats.length;

    const hasAccounts = this.state.summary.loaded.total > 0 || this.state.summary.active.total > 0;
    const previewFormats = this.state.outputPlan.formats.length > 0
      ? this.state.outputPlan.formats
      : hasAccounts ? effectiveFormats(this.state) : [];
    this.elements.previewTabs.replaceChildren(...previewFormats.map((format) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "editor-tab";
      button.classList.toggle("active", format === this.state.previewFormat);
      button.setAttribute("aria-selected", String(format === this.state.previewFormat));
      button.textContent = FORMAT_LABELS[format];
      button.addEventListener("click", () => this.actions.setPreviewFormat(format));
      return button;
    }));
  }

  renderOutputHeader(): void {
    const plan = this.state.outputPlan;
    const formats = plan?.formats ?? [];
    const count = plan?.accountCount ?? 0;
    const details = count > 0 ? [this.#messages().accountCount(count)] : [];
    if (formats.length > 0 && count > 0) {
      details.push(formats.length === 1 ? FORMAT_LABELS[formats[0]] : this.#messages().formatCount(formats.length));
      details.push(plan!.outputType.toUpperCase());
      if (this.state.previewTotal > 100) details.push(`${this.state.previewShown} / ${this.state.previewTotal}`);
    }
    const rejected = this.state.verifyTokens ? plan?.rejectedAccountCount ?? 0 : 0;
    if (rejected > 0) {
      details.push(this.state.locale === "zh" ? `已拦截 ${rejected}` : `${rejected} blocked`);
    }
    this.elements.outputMeta.textContent = details.join(" · ");
    this.elements.downloadButton.disabled = this.state.busy || !plan || plan.fileCount === 0;
    this.elements.downloadButton.setAttribute(
      "aria-label",
      this.#messages().exportAria(count, plan?.outputType === "jsonl", plan?.outputType === "zip"),
    );
    this.elements.downloadBtnText.textContent = this.state.busy
      ? this.#messages().exportPreparing
      : count > 0
        ? this.#messages().exportAccounts(count)
        : this.#messages().downloadDefault;
    this.elements.copyButton.disabled = !this.state.previewText;
  }

  renderAccountSection(): void {
    const hasAccounts = this.state.summary.loaded.total > 0 || this.state.summary.active.total > 0;
    this.elements.accountSection.hidden = !hasAccounts;
    this.elements.accountCount.textContent = hasAccounts
      ? this.#messages().accountCount(this.state.summary.active.total)
      : "";
    setText(
      "account-title",
      this.state.summary.scope === "draft"
        ? this.#messages().draftAccountTitle
        : this.#messages().accountTitle,
    );
    this.elements.clearAccountsButton.hidden = this.state.summary.scope === "draft" || this.state.summary.loaded.total === 0;
    this.elements.accountRows.style.height = `${accountListHeight(this.state.summary.active.total, this.rowHeight)}px`;
    if (!hasAccounts) this.clearRange();
  }

  renderRange(range: AccountRange): void {
    this.elements.accountRows.style.height = `${accountListHeight(range.total, this.rowHeight)}px`;
    const spacer = document.createElement("div");
    spacer.className = "account-virtual-spacer";
    spacer.style.height = `${range.total * this.rowHeight}px`;
    const rows = range.items.map((account, index) => this.#accountRow(account, range.offset + index));
    this.elements.accountRows.replaceChildren(spacer, ...rows);
  }

  clearRange(): void {
    this.elements.accountRows.replaceChildren();
    this.elements.accountRows.style.height = "0px";
  }

  renderSelectedRow(): void {
    this.elements.accountRows.querySelectorAll<HTMLElement>(".account-row").forEach((row) => {
      row.setAttribute(
        "aria-selected",
        String(row.classList.contains("is-selectable") && row.dataset.accountId === this.state.selectedAccountId),
      );
    });
  }

  renderPreview(): void {
    this.elements.previewFilePath.textContent = this.state.previewPath;
    this.elements.previewFileType.textContent = `${this.state.textMode.toUpperCase()} | UTF-8`;
    this.elements.previewOutput.classList.toggle("is-empty", Boolean(this.state.previewBlocked) || !this.state.previewText);
    if (this.state.previewBlocked) {
      const label = verificationShortLabel(this.state.previewBlocked, this.state.locale);
      this.elements.previewOutput.textContent = this.state.locale === "zh"
        ? `该账号标记为${label}，不参与当前输出。`
        : `This account is ${label.toLowerCase()} and is excluded from the current output.`;
      this.elements.copyButton.disabled = true;
      return;
    }
    if (!this.state.previewText) {
      this.elements.previewOutput.textContent = this.state.summary.active.total === 0
        ? this.#messages().previewNoInput
        : this.#messages().previewNoFormat;
      this.elements.copyButton.disabled = true;
      return;
    }
    this.elements.previewOutput.innerHTML = highlightJson(this.state.previewText);
    this.elements.copyButton.disabled = false;
  }

  syncControls(): void {
    this.elements.jsonlToggle.checked = this.state.textMode === "jsonl";
    this.elements.fakeIdToggle.checked = this.state.allowSyntheticIdToken;
    this.elements.refreshTokenToggle.checked = this.state.includeRefreshToken;
    this.elements.verifyTokenToggle.disabled = this.state.busy;
    if (!this.state.busy) this.elements.verifyTokenToggle.checked = this.state.verifyTokens;
  }

  applyLocale(): void {
    const text = this.#messages();
    document.documentElement.lang = this.state.locale === "zh" ? "zh-CN" : "en";
    document.title = text.pageTitle;
    const labels: Record<string, string> = {
      "page-title": text.appTitle,
      pageNotice: text.notice,
      dragTitle: text.dragTitle,
      dragSub: text.dragSub,
      themeLabelText: text.themeLabel,
      languageLabelText: text.languageLabel,
      inputTitle: text.inputTitle,
      sessionButtonText: text.sessionButton,
      addDraftButtonText: text.addDraftButton,
      clearButtonText: text.clearButton,
      dropTitle: text.dropTitle,
      dropSub: text.dropSub,
      fileButton: text.chooseFile,
      folderButton: text.chooseFolder,
      outputTitle: text.outputTitle,
      outputOptionsLabel: text.outputOptions,
      exportFormatLabel: text.exportFormat,
      jsonlToggleText: text.jsonlFormat,
      fakeIdToggleText: text.fakeId,
      refreshTokenToggleText: text.refreshToken,
      verifyTokenToggleText: text.verifyToken,
      "account-title": text.accountTitle,
      clearAccountsButtonText: text.clearAccounts,
      accountColumnIdentity: text.accountColumns[0],
      accountColumnPlan: text.accountColumns[1],
      accountColumnExpires: text.accountColumns[2],
      accountColumnAction: text.accountColumns[3],
      copyBtnText: text.copyPreview,
    };
    for (const [id, value] of Object.entries(labels)) setText(id, value);
    this.elements.jsonInput.placeholder = text.inputPlaceholder;
    this.elements.accountSearch.placeholder = this.state.locale === "zh" ? "搜索账号" : "Search accounts";
    this.elements.cancelTaskButton.textContent = this.state.locale === "zh" ? "取消" : "Cancel";
    this.elements.folderButton.hidden = !(window as Window & { showDirectoryPicker?: unknown }).showDirectoryPicker;
    this.elements.jsonInput.setAttribute("aria-label", text.inputAria);
    this.elements.inputFormatSelect.setAttribute("aria-label", text.inputFormatAria);
    this.elements.dropZone.setAttribute("aria-label", text.dropZoneAria);
    this.elements.selectAllFormats.setAttribute("aria-label", text.selectAllFormatsAria);
    this.elements.accountRows.setAttribute("aria-label", text.accountListAria);
    this.elements.previewTabs.setAttribute("aria-label", text.previewTabsAria);
    document.querySelector(".output-toolbar")?.setAttribute("aria-label", text.outputSettingsAria);
    document.querySelector(".preview-section")?.setAttribute("aria-label", text.previewAria);
    document.getElementById("themeToggleTrigger")?.setAttribute("aria-label", text.themeAria);
    document.getElementById("languageToggleTrigger")?.setAttribute("aria-label", text.languageAria);
    const themeLabels: Record<ThemeMode, string> = {
      system: text.themeSystem,
      light: text.themeLight,
      dark: text.themeDark,
    };
    document.querySelectorAll<HTMLButtonElement>(".theme-tab").forEach((button) => {
      const mode = button.dataset.value as ThemeMode | undefined;
      if (mode && mode in themeLabels) button.textContent = themeLabels[mode];
    });
    document.querySelectorAll<HTMLButtonElement>(".language-tab").forEach((button) => {
      const active = button.dataset.lang === this.state.locale;
      button.classList.toggle("active", active);
      button.setAttribute("aria-pressed", String(active));
    });
    this.#bindTooltip(this.elements.jsonlToggleContainer, text.jsonlTooltip);
    this.#bindTooltip(this.elements.fakeIdToggleContainer, text.fakeIdTooltip);
    this.#bindTooltip(this.elements.refreshTokenToggleContainer, text.refreshTokenTooltip);
    this.#bindTooltip(this.elements.verifyTokenToggleContainer, text.verifyTokenTooltip);
  }

  applyTheme(systemDark: boolean): void {
    const resolved = this.state.themeMode === "system" ? (systemDark ? "dark" : "light") : this.state.themeMode;
    document.documentElement.dataset.theme = resolved;
    const icon = document.getElementById("themeIconContainer");
    if (icon) icon.innerHTML = themeIconSvg(resolved);
    document.querySelectorAll<HTMLButtonElement>(".theme-tab").forEach((button) => {
      const active = button.dataset.value === this.state.themeMode;
      button.classList.toggle("active", active);
      button.setAttribute("aria-pressed", String(active));
    });
  }

  #renderInputFormatOptions(): void {
    const auto = document.createElement("option");
    auto.value = "auto";
    auto.textContent = this.state.summary.inputFormat === "unknown"
      ? this.#messages().inputFormatAutoMixed
      : this.#messages().inputFormatAuto(inputFormatLabel(this.state.summary.inputFormat, this.state.locale));
    const options = [auto, ...INPUT_FORMATS.map((format) => {
      const option = document.createElement("option");
      option.value = format;
      option.textContent = inputFormatLabel(format, this.state.locale);
      return option;
    })];
    this.elements.inputFormatSelect.replaceChildren(...options);
    this.elements.inputFormatSelect.value = this.state.forcedInputFormat;
  }

  #formatCard(format: OutputFormat): HTMLElement {
    const option = document.createElement("div");
    option.className = "format-option";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = this.state.selectedFormats.includes(format);
    input.setAttribute("aria-label", FORMAT_LABELS[format]);
    input.addEventListener("change", () => this.actions.setFormat(format, input.checked));
    const label = document.createElement("label");
    label.className = "format-option-label";
    const name = document.createElement("span");
    name.className = "format-option-name";
    name.textContent = FORMAT_LABELS[format];
    const marks = document.createElement("span");
    marks.className = "format-platforms";
    for (const provider of FORMAT_DEFINITIONS[format].providers) marks.append(platformMark(provider));
    label.append(name, marks);
    option.append(input, label);
    if (format === "codex") this.#bindTooltip(option, this.#messages().codexTooltip);

    if (input.checked && isConfigurableOutputFormat(format) && this.state.textMode === "json") {
      const control = document.createElement("span");
      control.className = "format-mode-control";
      const button = document.createElement("button");
      button.type = "button";
      button.className = "format-mode-button";
      const mode = resolveOutputMode(format, this.state.outputModes[format]);
      button.textContent = mode === "single" ? this.#messages().modeSingle : this.#messages().modeMerged;
      const tip = mode === "single" ? this.#messages().modeSingleTip : this.#messages().modeMergedTip;
      button.setAttribute(
        "aria-label",
        this.#messages().modeAria(FORMAT_LABELS[format], button.textContent, tip, this.#messages().nextModeLabel(mode)),
      );
      this.#bindTooltip(button, tip);
      button.addEventListener("click", (event) => {
        event.stopPropagation();
        this.actions.setOutputMode(format, mode === "single" ? "merged" : "single");
      });
      control.append(button);
      option.append(control);
    }
    return option;
  }

  #accountRow(account: AccountListItem, virtualIndex: number): HTMLElement {
    const selectable = accountRowSelectable(this.state, account.provider);
    const row = document.createElement("div");
    row.className = "account-row is-virtual";
    row.classList.toggle("is-selectable", selectable);
    row.classList.toggle("is-draft", this.state.summary.scope === "draft");
    row.dataset.accountId = account.id;
    row.dataset.accountIndex = String(account.index);
    row.setAttribute("aria-selected", String(selectable && account.id === this.state.selectedAccountId));
    row.style.transform = `translateY(${virtualIndex * this.rowHeight}px)`;

    const identity = document.createElement("span");
    identity.className = "account-cell account-identity-cell";
    const index = document.createElement("span");
    index.className = "account-cell-index";
    index.textContent = `${account.index + 1}. `;
    const value = document.createElement("span");
    value.className = "account-cell-value";
    const identityLabel = account.email ?? account.name ?? account.chatgptAccountId ?? account.accountId ?? account.userId ?? this.#messages().accountLabelFallback;
    const main = document.createElement("span");
    main.className = "account-identity-main";
    main.textContent = identityLabel;
    value.append(main);
    const stableId = account.accountId ?? account.chatgptAccountId;
    if (stableId && stableId !== identityLabel) {
      const sub = document.createElement("span");
      sub.className = "account-identity-sub";
      sub.textContent = stableId;
      value.append(sub);
    }
    this.#bindTooltip(identity, stableId && stableId !== identityLabel ? `${identityLabel} (${stableId})` : identityLabel);
    identity.append(index, value);
    if (account.inputFormat && account.inputFormat !== "unknown") {
      const badge = document.createElement("span");
      badge.className = `badge-format badge-${account.inputFormat}`;
      badge.textContent = INPUT_FORMAT_BADGE_LABELS[account.inputFormat];
      badge.title = account.sourceName || account.inputFormat;
      identity.append(badge);
    }
    if (account.tokenVerification && shouldShowVerificationBadge(account.tokenVerification.status)) {
      const verification = document.createElement("span");
      verification.className = `verification-badge verification-${account.tokenVerification.status}`;
      verification.textContent = verificationShortLabel(account.tokenVerification.status, this.state.locale);
      this.#bindTooltip(verification, verificationDetail(
        account.tokenVerification.status,
        account.tokenVerification.reason,
        account.tokenVerification.notBeforeActive,
        this.state.locale,
      ));
      identity.append(verification);
    }

    const plan = document.createElement("span");
    plan.className = "account-cell account-plan-cell";
    if (account.provider !== "unknown") plan.append(platformMark(account.provider));
    if (account.planType?.trim()) {
      const text = document.createElement("span");
      text.textContent = account.planType;
      plan.append(text);
    }
    const expiry = document.createElement("span");
    expiry.className = "account-cell account-expiry-cell";
    expiry.textContent = this.#displayExpiry(account.expiresAt);
    expiry.title = account.expiresAt ?? "";
    expiry.classList.toggle("is-expired", isExpired(account.expiresAt));
    const action = document.createElement("span");
    action.className = "account-actions";
    if (this.state.summary.scope === "loaded") {
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "remove-account-button";
      remove.textContent = this.#messages().remove;
      remove.title = this.#messages().remove;
      action.append(remove);
    }
    row.append(identity, plan, expiry, action);
    return row;
  }

  #diagnosticText(diagnostic: WorkerSummary["diagnostics"][number]): string {
    const labels = this.state.locale === "zh"
      ? { json_parse_failed: "JSON 解析失败", zip_read_failed: "ZIP 解压失败", input_format_mismatch: "输入格式不匹配", no_credential_tokens: "没有可用凭证字段", unsupported_input: "不支持的输入" }
      : { json_parse_failed: "JSON parse failed", zip_read_failed: "ZIP extraction failed", input_format_mismatch: "Input format mismatch", no_credential_tokens: "No credential tokens", unsupported_input: "Unsupported input" };
    return [diagnostic.sourceName, diagnostic.line ? `#${diagnostic.line}` : "", labels[diagnostic.code], diagnostic.detail].filter(Boolean).join(": ");
  }

  #displayExpiry(value: string | undefined): string {
    if (!value) return "";
    const time = new Date(value);
    return Number.isNaN(time.getTime())
      ? value
      : new Intl.DateTimeFormat(this.state.locale === "zh" ? "zh-CN" : "en", { dateStyle: "medium", timeStyle: "short" }).format(time);
  }

  #bindTooltip(target: HTMLElement, text: string): void {
    target.dataset.tooltip = text;
    if (this.#tooltipTargets.has(target)) return;
    this.#tooltipTargets.add(target);
    target.setAttribute("aria-describedby", this.#tooltip.id);
    target.addEventListener("mouseenter", () => showTooltip(this.#tooltip, target, target.dataset.tooltip ?? ""));
    target.addEventListener("mouseleave", () => { this.#tooltip.hidden = true; });
    target.addEventListener("focusin", () => showTooltip(this.#tooltip, target, target.dataset.tooltip ?? ""));
    target.addEventListener("focusout", () => { this.#tooltip.hidden = true; });
  }

  #messages(): ReturnType<typeof messagesFor>["web"] {
    return messagesFor(this.state.locale).web;
  }
}

export function effectiveFormats(state: Pick<WebViewState, "selectedFormats" | "summary">): OutputFormat[] {
  return selectEffectiveFormats(state.selectedFormats, state.summary.applicableFormats);
}

export function selectAccountForRange(
  currentId: string | undefined,
  items: ReadonlyArray<Pick<AccountListItem, "id">>,
  requireVisible: boolean,
  selectable = true,
): string | undefined {
  if (!selectable) return undefined;
  if (requireVisible) {
    return items.some((item) => item.id === currentId) ? currentId : items[0]?.id;
  }
  return currentId ?? items[0]?.id;
}

export function shouldRequireVisibleSelection(query: string, selectable: boolean): boolean {
  return selectable && query.trim().length > 0;
}

export function shouldResetViewportForPreferredAccount(
  preferredAccountId: string | undefined,
  query: string,
): boolean {
  return Boolean(preferredAccountId && query.trim());
}

export function accountRowsSelectable(state: Pick<WebViewState, "previewFormat" | "textMode" | "outputModes"> & {
  summary: { active: Pick<WorkerSummary["active"], "total" | "providerCounts"> };
}): boolean {
  const definition = FORMAT_DEFINITIONS[state.previewFormat];
  const eligibleCount = definition.providers.reduce(
    (total, provider) => total + state.summary.active.providerCounts[provider],
    0,
  );
  if (eligibleCount <= 1) return false;
  if (state.textMode === "jsonl") return true;
  const mode = definition.modes.length === 1
    ? definition.modes[0]
    : resolveOutputMode(state.previewFormat, state.outputModes[state.previewFormat]);
  return mode === "single";
}

export function accountRowSelectable(
  state: Parameters<typeof accountRowsSelectable>[0],
  provider: Provider,
): boolean {
  return accountRowsSelectable(state)
    && (FORMAT_DEFINITIONS[state.previewFormat].providers as readonly Provider[]).includes(provider);
}

export function accountListHeight(total: number, rowHeight: number): number {
  return Math.min(Math.max(0, total), 4) * rowHeight;
}

export function shouldShowVerificationBadge(status: TokenVerificationStatus): boolean {
  return status === "forged" || status === "unverifiable";
}

export function themeIconSvg(theme: "light" | "dark"): string {
  return theme === "dark"
    ? '<svg class="theme-icon" viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79Z"></path></svg>'
    : '<svg class="theme-icon" viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="4"></circle><path d="M12 2v2M12 20v2M4.93 4.93l1.42 1.42M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.42-1.42M17.66 6.34l1.41-1.41"></path></svg>';
}

export function highlightJson(text: string): string {
  return escapeHtml(text).replace(
    /("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+-]?\d+)?)/g,
    (match) => {
      let className = "json-number";
      if (match.startsWith('"')) className = match.endsWith(":") ? "json-key" : "json-string";
      else if (match === "true" || match === "false") className = "json-boolean";
      else if (match === "null") className = "json-null";
      if (className === "json-string") {
        const token = match.slice(1, -1);
        if (/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$/.test(token) && jwtPopoverText(token)) {
          return `"<span class="json-string jwt-token-hoverable" data-jwt="${token}">${token}</span>"`;
        }
      }
      return className === "json-key"
        ? `<span class="${className}">${match.slice(0, -1)}</span>:`
        : `<span class="${className}">${match}</span>`;
    },
  );
}

function verificationShortLabel(status: TokenVerificationStatus, locale: Locale): string {
  const labels: Record<TokenVerificationStatus, [string, string]> = {
    verified: ["真实", "Verified"],
    forged: ["伪造", "Forged"],
    unverifiable: ["不可验证", "Unverifiable"],
    unchecked: ["未检查", "Unchecked"],
  };
  return labels[status][locale === "zh" ? 0 : 1];
}

function verificationDetail(
  status: TokenVerificationStatus,
  reason: TokenVerificationReason,
  notBeforeActive: true | undefined,
  locale: Locale,
): string {
  const reasons: Record<TokenVerificationReason, [string, string]> = {
    signature_valid: ["签名有效", "Valid signature"],
    malformed_jwt: ["JWT 格式损坏", "Malformed JWT"],
    algorithm_rejected: ["算法不允许", "Rejected algorithm"],
    signature_failed: ["签名失败", "Signature failed"],
    issuer_mismatch: ["issuer 不匹配", "Issuer mismatch"],
    audience_mismatch: ["audience 不匹配", "Audience mismatch"],
    token_type_mismatch: ["不是 xAI access token", "Not an xAI access token"],
    missing_access_token: ["缺少 access token", "Missing access token"],
    opaque_access_token: ["access token 不是 JWT", "Access token is opaque"],
    unknown_kid: ["内置 JWKS 中没有该 kid", "Unknown kid in bundled JWKS"],
    unknown_provider: ["未知平台", "Unknown provider"],
    user_disabled: ["用户关闭验证", "Verification disabled"],
    verification_missing: ["缺少验真结果", "Missing verification result"],
  };
  const suffix = notBeforeActive ? (locale === "zh" ? "；尚未到生效时间" : "; not active yet") : "";
  return `${verificationShortLabel(status, locale)}: ${reasons[reason][locale === "zh" ? 0 : 1]}${suffix}`;
}

export function platformMarkSvg(provider: "openai" | "xai" | "unknown"): string {
  if (provider === "xai") {
    return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14.234 10.162 22.977 0h-2.072l-7.591 8.824L7.251 0H.258l9.168 13.343L.258 24H2.33l8.016-9.318L16.749 24h6.993zm-2.837 3.299-.929-1.329L3.076 1.56h3.182l5.965 8.532.929 1.329 7.754 11.09h-3.182z"/></svg>';
  }
  return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z"/></svg>';
}

function platformMark(provider: "openai" | "xai" | "unknown"): HTMLElement {
  const mark = document.createElement("span");
  mark.className = `platform-mark platform-mark-${provider}`;
  mark.title = provider === "xai" ? "Grok" : provider === "openai" ? "OpenAI" : "Unknown";
  mark.innerHTML = platformMarkSvg(provider);
  return mark;
}

function isExpired(value: string | undefined): boolean {
  if (!value) return false;
  const time = new Date(value).getTime();
  return Number.isFinite(time) && time <= Date.now();
}

function escapeHtml(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function createTooltip(): HTMLDivElement {
  const tooltip = document.createElement("div");
  tooltip.id = "appTooltip";
  tooltip.className = "app-tooltip";
  tooltip.setAttribute("role", "tooltip");
  tooltip.hidden = true;
  document.body.append(tooltip);
  window.addEventListener("scroll", () => { tooltip.hidden = true; }, true);
  window.addEventListener("resize", () => { tooltip.hidden = true; });
  return tooltip;
}

function showTooltip(tooltip: HTMLElement, target: HTMLElement, text: string): void {
  if (!text) return;
  tooltip.textContent = text;
  tooltip.hidden = false;
  const targetRect = target.getBoundingClientRect();
  const tooltipRect = tooltip.getBoundingClientRect();
  const padding = 8;
  const top = targetRect.bottom + tooltipRect.height + 14 <= window.innerHeight
    ? targetRect.bottom + 8
    : Math.max(padding, targetRect.top - tooltipRect.height - 8);
  const left = Math.min(
    Math.max(padding, targetRect.left + targetRect.width / 2 - tooltipRect.width / 2),
    window.innerWidth - tooltipRect.width - padding,
  );
  tooltip.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
}

function setText(id: string, text: string): void {
  const element = document.getElementById(id);
  if (element) element.textContent = text;
}

function byId<T extends HTMLElement = HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing element #${id}`);
  return element as T;
}
