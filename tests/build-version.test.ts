import { describe, expect, it } from "vitest";
import { resolveBuildVersion } from "../scripts/build-version.mjs";

describe("build version", () => {
  it("uses package version plus action commit when injected", () => {
    expect(resolveBuildVersion({
      packageVersion: "1.2.3",
      buildSha: "8dd8aa5555555555555555555555555555555555",
    })).toBe("1.2.3.8dd8aa5");
  });

  it("uses a dev suffix when no injected commit exists", () => {
    expect(resolveBuildVersion({
      packageVersion: "1.2.3",
      buildSha: undefined,
    })).toBe("1.2.3.dev");
  });
});
