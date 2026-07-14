import { describe, expect, it } from "vitest";
import type { NormalizedAccount } from "../src/types.js";
import { activeAccountSource, displayCredentialExpiry, effectiveFormats, importSummary, isExpiredCredential, selectedIndexAfterRemoval, syncPreviewTabSelection } from "../src/web/state-helpers.js";

function account(email: string): NormalizedAccount {
  return {
    provider: "openai",
    email,
    sourceName: "test",
    sourcePath: "test.json",
    warnings: [],
  };
}

describe("web state helpers", () => {
  it("uses a valid draft as the active output source", () => {
    const loaded = [account("loaded@example.com")];
    const draft = [account("draft@example.com")];

    expect(activeAccountSource(loaded, draft)).toEqual({
      kind: "draft",
      accounts: draft,
    });
  });

  it("exports only selected formats applicable to the current accounts", () => {
    const selected = ["cpa", "codex2api", "codexmanager", "codex", "grok"] as const;
    const applicable = ["cpa", "sub2api", "grok"] as const;

    expect(effectiveFormats(selected, applicable)).toEqual(["cpa", "grok"]);
    expect(effectiveFormats(["codex2api", "codexmanager", "codex"], applicable)).toEqual([]);
    expect(selected).toEqual(["cpa", "codex2api", "codexmanager", "codex", "grok"]);
  });

  it("keeps the same logical selected account when removing an earlier row", () => {
    expect(selectedIndexAfterRemoval(2, 0, 2)).toBe(1);
    expect(selectedIndexAfterRemoval(1, 1, 2)).toBe(1);
    expect(selectedIndexAfterRemoval(2, 2, 2)).toBe(1);
    expect(selectedIndexAfterRemoval(0, 0, 0)).toBe(0);
  });

  it("syncs preview tab active state after the selected format changes", () => {
    const tabs = ["cpa", "sub2api"].map((format) => fakeTab(format));

    syncPreviewTabSelection(tabs, "sub2api");

    expect(tabs[0]?.active).toBe(false);
    expect(tabs[0]?.ariaSelected).toBe("false");
    expect(tabs[0]?.tabIndex).toBe(-1);
    expect(tabs[1]?.active).toBe(true);
    expect(tabs[1]?.ariaSelected).toBe("true");
    expect(tabs[1]?.tabIndex).toBe(0);
  });

  it("summarizes processed, added, and merged import counts", () => {
    expect(importSummary(3, 2, 4)).toEqual({ processed: 3, added: 2, merged: 1 });
    expect(importSummary(1, 2, 1)).toEqual({ processed: 1, added: 0, merged: 1 });
  });

  it("marks only valid timestamps at or before the current time as expired", () => {
    const now = new Date("2026-07-12T12:00:00.000Z").getTime();

    expect(isExpiredCredential("2026-07-12T11:59:59.000Z", now)).toBe(true);
    expect(isExpiredCredential("2026-07-12T12:00:00.000Z", now)).toBe(true);
    expect(isExpiredCredential("2026-07-12T12:00:01.000Z", now)).toBe(false);
    expect(isExpiredCredential("not-a-date", now)).toBe(false);
    expect(isExpiredCredential(undefined, now)).toBe(false);
  });

  it("displays equivalent expiry instants in the selected local timezone", () => {
    expect(displayCredentialExpiry("2026-07-12T12:00:00.000Z", "zh", "Asia/Shanghai")).toBe("2026-07-12 20:00");
    expect(displayCredentialExpiry("2026-07-12T20:00:00+08:00", "zh", "Asia/Shanghai")).toBe("2026-07-12 20:00");
    expect(displayCredentialExpiry("not-a-date", "zh", "Asia/Shanghai")).toBe("not-a-date");
  });
});

function fakeTab(format: string) {
  const tab = {
    active: false,
    ariaSelected: "",
    tabIndex: 0,
    getAttribute(name: string) {
      return name === "data-format" ? format : null;
    },
    setAttribute(name: string, value: string) {
      if (name === "aria-selected") {
        this.ariaSelected = value;
      }
    },
    classList: {
      toggle: (_className: string, active: boolean) => {
        tab.active = active;
        return active;
      },
    },
  };
  return tab;
}
