import type { NormalizedAccount, OutputFormat } from "../types.js";

export type AccountSourceKind = "loaded" | "draft" | "empty";

export type ActiveAccountSource = {
  kind: AccountSourceKind;
  accounts: NormalizedAccount[];
};

export type ImportSummary = {
  processed: number;
  added: number;
  merged: number;
};

export type PreviewTabElement = {
  tabIndex: number;
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
  classList: {
    toggle(className: string, force?: boolean): boolean;
  };
};

export function effectiveFormats(
  selectedFormats: readonly OutputFormat[],
  applicableFormats: readonly OutputFormat[],
): OutputFormat[] {
  const selected = new Set(selectedFormats);
  return applicableFormats.filter((format) => selected.has(format));
}

export function activeAccountSource(
  accounts: NormalizedAccount[],
  draftAccounts: NormalizedAccount[],
): ActiveAccountSource {
  if (draftAccounts.length > 0) {
    return { kind: "draft", accounts: draftAccounts };
  }
  if (accounts.length > 0) {
    return { kind: "loaded", accounts };
  }
  return { kind: "empty", accounts: [] };
}

export function selectedIndexAfterRemoval(
  selectedIndex: number,
  removedIndex: number,
  remainingLength: number,
): number {
  if (remainingLength <= 0) {
    return 0;
  }
  if (removedIndex < selectedIndex) {
    return selectedIndex - 1;
  }
  if (selectedIndex >= remainingLength) {
    return remainingLength - 1;
  }
  return selectedIndex;
}

export function syncPreviewTabSelection(tabs: Iterable<PreviewTabElement>, activeFormat: OutputFormat): void {
  for (const tab of tabs) {
    const active = tab.getAttribute("data-format") === activeFormat;
    tab.classList.toggle("active", active);
    tab.setAttribute("aria-selected", String(active));
    tab.tabIndex = active ? 0 : -1;
  }
}

export function importSummary(processed: number, beforeCount: number, afterCount: number): ImportSummary {
  const added = Math.max(afterCount - beforeCount, 0);
  return {
    processed,
    added,
    merged: Math.max(processed - added, 0),
  };
}

export function isExpiredCredential(expiresAt: string | undefined, now = Date.now()): boolean {
  if (!expiresAt) {
    return false;
  }
  const expiresAtTime = new Date(expiresAt).getTime();
  return Number.isFinite(expiresAtTime) && expiresAtTime <= now;
}

export function displayCredentialExpiry(
  expiresAt: string,
  locale: "zh" | "en",
  timeZone?: string,
): string {
  const date = new Date(expiresAt);
  if (!Number.isFinite(date.getTime())) {
    return expiresAt;
  }

  const parts = new Intl.DateTimeFormat(locale === "zh" ? "zh-CN" : "en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone,
  }).formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? "";

  return `${value("year")}-${value("month")}-${value("day")} ${value("hour")}:${value("minute")}`;
}
