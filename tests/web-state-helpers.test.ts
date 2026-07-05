import { describe, expect, it } from "vitest";
import type { NormalizedAccount } from "../src/types.js";
import { activeAccountSource, selectedIndexAfterRemoval, syncPreviewTabSelection } from "../src/web/state-helpers.js";

function account(email: string): NormalizedAccount {
  return {
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
