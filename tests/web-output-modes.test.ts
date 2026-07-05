import { describe, expect, it } from "vitest";
import { effectiveWebOutputModes } from "../src/web/output-modes.js";

describe("web output modes", () => {
  it("keeps configured merge modes for JSON output", () => {
    expect(effectiveWebOutputModes({ sub2api: "merged", codex2api: "merged" }, "json")).toEqual({
      sub2api: "merged",
      codex2api: "merged",
    });
  });

  it("forces merge-capable formats to one account per JSONL row", () => {
    expect(effectiveWebOutputModes({ sub2api: "merged", codex2api: "merged" }, "jsonl")).toEqual({
      sub2api: "single",
      codex2api: "single",
    });
  });
});
