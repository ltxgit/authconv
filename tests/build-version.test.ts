import { readFile } from "node:fs/promises";
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

  it("keeps the Node 22 runtime contract aligned", async () => {
    const [packageText, lockText, localVersion, workflow, buildScript] = await Promise.all([
      readFile(new URL("../package.json", import.meta.url), "utf8"),
      readFile(new URL("../package-lock.json", import.meta.url), "utf8"),
      readFile(new URL("../.node-version", import.meta.url), "utf8"),
      readFile(new URL("../.github/workflows/pages.yml", import.meta.url), "utf8"),
      readFile(new URL("../scripts/build.mjs", import.meta.url), "utf8"),
    ]);
    const packageJson = JSON.parse(packageText) as {
      version: string;
      dependencies?: Record<string, string>;
      engines?: { node?: string };
    };
    const packageLock = JSON.parse(lockText) as {
      version: string;
      packages?: Record<string, {
        version?: string;
        dependencies?: Record<string, string>;
        engines?: { node?: string };
      }>;
    };
    const lockRoot = packageLock.packages?.[""];

    expect(packageJson.engines?.node).toBe(">=22");
    expect(packageLock.version).toBe(packageJson.version);
    expect(lockRoot?.version).toBe(packageJson.version);
    expect(lockRoot?.dependencies).toEqual(packageJson.dependencies);
    expect(lockRoot?.engines).toEqual(packageJson.engines);
    expect(localVersion.trim()).toBe("22");
    expect(workflow).toMatch(/node-version:\s*22\b/);
    expect(buildScript).toContain('target: "node22"');
  });
});
