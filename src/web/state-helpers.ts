import type { NormalizedAccount, OutputFormat } from "../types.js";

export type AccountSourceKind = "loaded" | "draft" | "empty";

export type ActiveAccountSource = {
  kind: AccountSourceKind;
  accounts: NormalizedAccount[];
};

export type PreviewTabElement = {
  tabIndex: number;
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
  classList: {
    toggle(className: string, force?: boolean): boolean;
  };
};

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
