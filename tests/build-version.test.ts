import { describe, expect, it } from "vitest";
import { resolveBuildVersion } from "../scripts/build-version.mjs";

describe("build version", () => {
  it("uses package version plus action commit when injected", () => {
    expect(resolveBuildVersion({
      packageVersion: "0.1.1",
      buildSha: "8dd8aa5555555555555555555555555555555555",
    })).toBe("0.1.1.8dd8aa5");
  });

  it("uses a dev suffix when no injected commit exists", () => {
    expect(resolveBuildVersion({
      packageVersion: "0.1.1",
      buildSha: undefined,
    })).toBe("0.1.1.dev");
  });
});
