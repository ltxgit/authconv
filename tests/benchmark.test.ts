import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

describe("benchmark CLI", () => {
  it("runs fixed-output, merged, and worker benchmarks with non-empty workload metrics", async () => {
    const { stdout } = await execFileAsync(process.execPath, [
      "scripts/benchmark.mjs",
      "--accounts",
      "2",
      "--iterations",
      "1",
      "--modes",
      "single,merged,worker",
    ], {
      cwd: new URL("..", import.meta.url),
      timeout: 30_000,
    });

    expect(stdout).toContain("accounts");
    expect(stdout).toContain("entries");
    expect(stdout).toContain("bytes");
    expect(stdout).toMatch(/^single\s+2\s+2\s+[1-9]\d*/m);
    expect(stdout).toMatch(/^merged\s+2\s+1\s+[1-9]\d*/m);
    expect(stdout).toMatch(/^worker\s+2\s+-\s+-/m);
  }, 30_000);

  it("runs the explicit cli mode instead of sending it to benchmark-runner", async () => {
    const { stdout } = await execFileAsync(process.execPath, [
      "scripts/benchmark.mjs",
      "--accounts",
      "2",
      "--iterations",
      "1",
      "--modes",
      "cli",
    ], {
      cwd: new URL("..", import.meta.url),
      timeout: 30_000,
    });

    expect(stdout).toContain("cli");
  }, 30_000);
});
