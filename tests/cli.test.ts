import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { strFromU8, unzipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { runCli, startWebUiServer } from "../src/cli.js";

async function readJsonFile<T>(filePath: string): Promise<T> {
  return JSON.parse(await readFile(filePath, "utf8")) as T;
}

async function readJsonLines(filePath: string): Promise<unknown[]> {
  return (await readFile(filePath, "utf8"))
    .trimEnd()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as unknown);
}

async function modeBits(filePath: string): Promise<number> {
  return (await stat(filePath)).mode & 0o777;
}

describe("authconv CLI", () => {
  it("prints help to stderr so stdout stays reserved for JSON", async () => {
    const result = await runCli(["--help"], {
      stdout: "",
      stderr: "",
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr.length).toBeGreaterThan(0);
  });

  it("prints English help when requested", async () => {
    const result = await runCli(["--help", "--lang", "en"], {
      stdout: "",
      stderr: "",
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Usage:");
    expect(result.stderr).not.toContain("用法");
  });

  it("prints Chinese help when requested", async () => {
    const result = await runCli(["--help", "--lang", "zh"], {
      stdout: "",
      stderr: "",
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("用法:");
    expect(result.stderr).not.toContain("Usage:");
  });

  it("prints a readable error when the shell current directory no longer exists", async () => {
    const originalCwd = process.cwd;
    const error = Object.assign(new Error("uv_cwd"), {
      code: "ENOENT",
      syscall: "uv_cwd",
    });
    Object.defineProperty(process, "cwd", {
      configurable: true,
      value: () => {
        throw error;
      },
    });
    try {
      const result = await runCli(["input.json"], {
        stdout: "",
        stderr: "",
      });

      expect(result.exitCode).toBe(3);
      expect(result.stdout).toBe("");
    } finally {
      Object.defineProperty(process, "cwd", {
        configurable: true,
        value: originalCwd,
      });
    }
  });

  it("rejects conversion options without an input path or --stdin", async () => {
    const result = await runCli(["--format", "cpa"], {
      stdin: JSON.stringify({ access_token: "access-token" }),
      stdout: "",
      stderr: "",
    });

    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe("");
  });

  it("starts a local Web UI server", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "authconv-webui-"));
    const indexPath = path.join(dir, "index.html");
    let server: Awaited<ReturnType<typeof startWebUiServer>> | undefined;
    try {
      await writeFile(indexPath, "<!doctype html><title>authconv test</title>");
      server = await startWebUiServer({ host: "127.0.0.1", port: 0, indexPath });

      const response = await fetch(server.url);
      expect(response.status).toBe(200);
      expect(await response.text()).toContain("authconv test");
    } finally {
      await server?.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("accepts --serve with a host:port listen address", async () => {
    let server: Awaited<ReturnType<typeof startWebUiServer>> | undefined;
    try {
      const result = await runCli(["--serve", "--listen", "127.0.0.1:0"], {
        stdout: "",
        stderr: "",
        onServerStarted: (startedServer) => {
          server = startedServer;
        },
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain(server?.url);
    } finally {
      await server?.close();
    }
  });

  it("rejects --listen without --serve", async () => {
    const result = await runCli(["--listen", "127.0.0.1:8787"], {
      stdout: "",
      stderr: "",
    });

    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe("");
  });

  it("writes default output files and keeps stdout reserved for --stdout", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "authconv-cli-"));
    try {
      const input = path.join(dir, "input.json");
      const outDir = path.join(dir, "output");
      await writeFile(input, JSON.stringify({ access_token: "access-token", email: "user@example.com" }));

      const result = await runCli(["-i", input, "--out-dir", outDir], {
        stdout: "",
        stderr: "",
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("");
      const output = await readJsonFile<{
        type: string;
        version: number;
        exported_at: string;
        proxies: unknown[];
        accounts: Array<{ credentials: Record<string, unknown> }>;
      }>(path.join(outDir, "sub2api", "sub2api_user_example.com.json"));
      expect(output).toEqual({
        type: "sub2api-data",
        version: 1,
        exported_at: expect.any(String),
        proxies: [],
        accounts: [
          {
            name: "user@example.com",
            platform: "openai",
            type: "oauth",
            credentials: {
              access_token: "access-token",
              email: "user@example.com",
              id_token: expect.any(String),
            },
            extra: {
              import_source: "authconv",
              id_token_synthetic: true,
            },
            priority: 50,
            concurrency: 3,
            auto_pause_on_expired: true,
          },
        ],
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("accepts an input path as the first positional argument", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "authconv-cli-positional-"));
    try {
      const input = path.join(dir, "input.json");
      const outDir = path.join(dir, "output");
      await writeFile(input, JSON.stringify({ access_token: "access-token", email: "user@example.com" }));

      const result = await runCli([input, "--format", "cpa", "--out-dir", outDir], {
        stdout: "",
        stderr: "",
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("");
      const targetPath = path.join(outDir, "cpa_user_example.com.json");
      expect(result.stderr).toContain(targetPath);
      await expect(readJsonFile(targetPath)).resolves.toEqual({
        type: "codex",
        email: "user@example.com",
        account_id: "",
        plan_type: "",
        id_token: expect.any(String),
        access_token: "access-token",
        refresh_token: "",
        expired: "",
        last_refresh: expect.any(String),
        disabled: false,
        id_token_synthetic: true,
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("writes private output directories and credential files", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "authconv-cli-private-output-"));
    try {
      const input = path.join(dir, "input.json");
      const outDir = path.join(dir, "output");
      await writeFile(input, JSON.stringify({ access_token: "access-token", email: "user@example.com" }));

      const jsonResult = await runCli([input, "-f", "cpa", "-o", outDir], {
        stdout: "",
        stderr: "",
      });

      const jsonPath = path.join(outDir, "cpa_user_example.com.json");
      expect(jsonResult.exitCode).toBe(0);
      await expect(modeBits(outDir)).resolves.toBe(0o700);
      await expect(modeBits(jsonPath)).resolves.toBe(0o600);

      const zipDir = path.join(dir, "zip-output");
      const zipResult = await runCli([input, "-f", "cpa,sub2api", "--zip", "-o", zipDir], {
        stdout: "",
        stderr: "",
      });
      const zipFiles = (await readdir(zipDir)).filter((fileName) => fileName.endsWith(".zip"));
      expect(zipResult.exitCode).toBe(0);
      expect(zipFiles).toHaveLength(1);
      await expect(modeBits(zipDir)).resolves.toBe(0o700);
      await expect(modeBits(path.join(zipDir, zipFiles[0]))).resolves.toBe(0o600);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("accepts multiple positional input paths, including directories", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "authconv-cli-multi-positional-"));
    try {
      const firstInput = path.join(dir, "first.json");
      const inputDir = path.join(dir, "accounts");
      const outDir = path.join(dir, "output");
      await mkdir(inputDir);
      await writeFile(firstInput, JSON.stringify({ access_token: "access-token-a", email: "first@example.com" }));
      await writeFile(path.join(inputDir, "second.json"), JSON.stringify({ access_token: "access-token-b", email: "second@example.com" }));

      const result = await runCli([firstInput, inputDir, "-f", "cpa", "--jsonl", "--out-dir", outDir], {
        stdout: "",
        stderr: "",
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("");
      const lines = await readJsonLines(path.join(outDir, "cpa_2-accounts.jsonl"));
      expect(lines.map((line) => (line as { email: string }).email)).toEqual(["first@example.com", "second@example.com"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("accepts repeated explicit input paths", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "authconv-cli-multi-input-"));
    try {
      const firstInput = path.join(dir, "first.json");
      const secondInput = path.join(dir, "second.json");
      const outDir = path.join(dir, "output");
      await writeFile(firstInput, JSON.stringify({ access_token: "access-token-a", email: "first@example.com" }));
      await writeFile(secondInput, JSON.stringify({ access_token: "access-token-b", email: "second@example.com" }));

      const result = await runCli(["-i", firstInput, "--input", secondInput, "-f", "cpa", "--jsonl", "--out-dir", outDir], {
        stdout: "",
        stderr: "",
      });

      expect(result.exitCode).toBe(0);
      const lines = await readJsonLines(path.join(outDir, "cpa_2-accounts.jsonl"));
      expect(lines.map((line) => (line as { email: string }).email)).toEqual(["first@example.com", "second@example.com"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("splits sub2api to CPA files and restores them from an input directory", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "authconv-cli-roundtrip-"));
    try {
      const input = path.join(dir, "sub2api.json");
      const splitDir = path.join(dir, "split");
      const restoredDir = path.join(dir, "restored");
      await writeFile(
        input,
        JSON.stringify({
          type: "sub2api-data",
          version: 1,
          accounts: [
            {
              name: "First Account",
              credentials: {
                access_token: "access-token-a",
                email: "first@example.com",
              },
            },
            {
              name: "Second Account",
              credentials: {
                access_token: "access-token-b",
                email: "second@example.com",
              },
            },
          ],
        }),
      );

      const split = await runCli([input, "-f", "cpa", "--out-dir", splitDir], {
        stdout: "",
        stderr: "",
      });
      expect(split.exitCode).toBe(0);

      const restored = await runCli([splitDir, "-f", "sub2api", "--out-dir", restoredDir], {
        stdout: "",
        stderr: "",
      });

      expect(restored.exitCode).toBe(0);
      const output = await readJsonFile<{
        type: string;
        version: number;
        exported_at: string;
        proxies: unknown[];
        accounts: unknown[];
      }>(path.join(restoredDir, "sub2api_2-accounts.json"));
      expect(output).toEqual({
        type: "sub2api-data",
        version: 1,
        exported_at: expect.any(String),
        proxies: [],
        accounts: [
          {
            name: "First Account",
            platform: "openai",
            type: "oauth",
            credentials: {
              access_token: "access-token-a",
              email: "first@example.com",
              id_token: expect.any(String),
            },
            extra: {
              import_source: "authconv",
              id_token_synthetic: true,
            },
            priority: 50,
            concurrency: 3,
            auto_pause_on_expired: true,
          },
          {
            name: "Second Account",
            platform: "openai",
            type: "oauth",
            credentials: {
              access_token: "access-token-b",
              email: "second@example.com",
              id_token: expect.any(String),
            },
            extra: {
              import_source: "authconv",
              id_token_synthetic: true,
            },
            priority: 50,
            concurrency: 3,
            auto_pause_on_expired: true,
          },
        ],
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects --stdout with multiple formats", async () => {
    const result = await runCli(["--stdin", "-f", "cpa,sub2api", "--stdout"], {
      stdin: JSON.stringify({ access_token: "access-token" }),
      stdout: "",
      stderr: "",
    });

    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe("");
  });

  it("groups repeated warnings by warning count instead of listing files", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "authconv-cli-warning-group-"));
    try {
      const input = path.join(dir, "input.json");
      const outDir = path.join(dir, "output");
      await writeFile(input, JSON.stringify([
        { access_token: "access-a", email: "first@example.com" },
        { access_token: "access-b", email: "second@example.com" },
      ]));

      const result = await runCli([input, "-f", "cpa", "--jsonl", "-o", outDir, "--lang", "en"], {
        stdout: "",
        stderr: "",
      });

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toContain("missing refresh_token (2 warnings)");
      expect(result.stderr).not.toContain("(2 files)");
      expect(result.stderr).not.toContain("input.json,");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("writes a zip archive when --zip is set", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "authconv-cli-zip-"));
    try {
      const input = path.join(dir, "input.json");
      const outDir = path.join(dir, "output");
      await writeFile(input, JSON.stringify({ access_token: "access-token", email: "user@example.com" }));

      const result = await runCli([input, "-f", "cpa,sub2api", "--zip", "--out-dir", outDir], {
        stdout: "",
        stderr: "",
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("");
      const zipFiles = (await readdir(outDir)).filter((fileName) => fileName.endsWith(".zip"));
      expect(zipFiles).toHaveLength(1);
      const zipPath = path.join(outDir, zipFiles[0]);
      expect(result.stderr).toContain(zipPath);
      const archive = unzipSync(await readFile(zipPath));

      expect(JSON.parse(strFromU8(archive["cpa/cpa_user_example.com.json"]))).toMatchObject({
        type: "codex",
        email: "user@example.com",
      });
      expect(JSON.parse(strFromU8(archive["sub2api/sub2api_user_example.com.json"]))).toMatchObject({
        type: "sub2api-data",
        accounts: [expect.any(Object)],
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects --zip with --stdout", async () => {
    const result = await runCli(["--stdin", "-f", "cpa", "--zip", "--stdout"], {
      stdin: JSON.stringify({ access_token: "access-token" }),
      stdout: "",
      stderr: "",
    });

    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe("");
  });

  it("accepts repeated --format flags and writes one folder per selected format", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "authconv-cli-formats-"));
    try {
      const input = path.join(dir, "input.json");
      const outDir = path.join(dir, "output");
      await writeFile(input, JSON.stringify({ access_token: "access-token", email: "user@example.com" }));

      const result = await runCli(["-i", input, "-f", "cpa,sub2api", "--format", "codexmanager", "--out-dir", outDir], {
        stdout: "",
        stderr: "",
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("");
      await expect(readJsonFile(path.join(outDir, "cpa", "cpa_user_example.com.json"))).resolves.toEqual({
        type: "codex",
        email: "user@example.com",
        account_id: "",
        plan_type: "",
        id_token: expect.any(String),
        access_token: "access-token",
        refresh_token: "",
        expired: "",
        last_refresh: expect.any(String),
        disabled: false,
        id_token_synthetic: true,
      });
      await expect(readJsonFile(path.join(outDir, "sub2api", "sub2api_user_example.com.json"))).resolves.toEqual({
        type: "sub2api-data",
        version: 1,
        exported_at: expect.any(String),
        proxies: [],
        accounts: [
          {
            name: "user@example.com",
            platform: "openai",
            type: "oauth",
            credentials: {
              access_token: "access-token",
              email: "user@example.com",
              id_token: expect.any(String),
            },
            extra: {
              import_source: "authconv",
              id_token_synthetic: true,
            },
            priority: 50,
            concurrency: 3,
            auto_pause_on_expired: true,
          },
        ],
      });
      await expect(readJsonFile(path.join(outDir, "codexmanager", "codex-manager_user_example.com.json"))).resolves.toEqual({
        tokens: {
          access_token: "access-token",
          id_token: expect.any(String),
        },
        meta: {
          label: "user@example.com",
          issuer: "https://auth.openai.com",
          tags: ["authconv"],
        },
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("prints one JSON document for single-format stdout", async () => {
    const result = await runCli(["--stdin", "--format", "cpa", "--stdout"], {
      stdin: JSON.stringify({ access_token: "access-token", email: "user@example.com" }),
      stdout: "",
      stderr: "",
    });

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      type: "codex",
      email: "user@example.com",
      account_id: "",
      plan_type: "",
      id_token: expect.any(String),
      access_token: "access-token",
      refresh_token: "",
      expired: "",
      last_refresh: expect.any(String),
      disabled: false,
      id_token_synthetic: true,
    });
  });

  it("writes synthetic id_token with a placeholder signature by default", async () => {
    const result = await runCli(["--stdin", "--format", "codex", "--stdout"], {
      stdin: JSON.stringify({ access_token: "access-token", email: "user@example.com" }),
      stdout: "",
      stderr: "",
    });

    expect(result.exitCode).toBe(0);
    const output = JSON.parse(result.stdout) as { tokens: { id_token: string } };
    expect(output.tokens.id_token.split(".")).toHaveLength(3);
    expect(output.tokens.id_token.split(".")[2]).not.toBe("");
  });

  it("does not write synthetic id_token when --no-fake-id is set", async () => {
    const result = await runCli(["--stdin", "--format", "codex", "--stdout", "--no-fake-id"], {
      stdin: JSON.stringify({ access_token: "access-token", email: "user@example.com" }),
      stdout: "",
      stderr: "",
    });

    expect(result.exitCode).toBe(0);
    const output = JSON.parse(result.stdout) as { tokens: { id_token: string } };
    expect(output.tokens.id_token).toBe("");
  });

  it("prints Codex auth.json for the codex output format", async () => {
    const result = await runCli(["--stdin", "--format", "codex", "--stdout"], {
      stdin: JSON.stringify({
        access_token: "access-token",
        refresh_token: "refresh-token",
        id_token: "id-token",
        account_id: "acct_cli",
        last_refresh: "2026-07-04T11:03:02.000Z",
      }),
      stdout: "",
      stderr: "",
    });

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      auth_mode: "chatgpt",
      OPENAI_API_KEY: null,
      tokens: {
        id_token: "id-token",
        access_token: "access-token",
        refresh_token: "refresh-token",
        account_id: "acct_cli",
      },
      last_refresh: "2026-07-04T11:03:02.000Z",
    });
  });

  it("accepts --stdin as an explicit input source", async () => {
    const result = await runCli(["--stdin", "--format", "cpa", "--stdout"], {
      stdin: JSON.stringify({ access_token: "access-token", email: "stdin@example.com" }),
      stdout: "",
      stderr: "",
    });

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      type: "codex",
      email: "stdin@example.com",
      access_token: "access-token",
    });
  });

  it("rejects --stdin when an input path is also provided", async () => {
    const result = await runCli(["--stdin", "input.json"], {
      stdin: JSON.stringify({ access_token: "access-token" }),
      stdout: "",
      stderr: "",
    });

    expect(result.exitCode).toBe(2);
  });

  it("writes JSONL output when requested", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "authconv-cli-jsonl-"));
    try {
      const input = path.join(dir, "input.json");
      const outDir = path.join(dir, "output");
      await writeFile(
        input,
        JSON.stringify([
          { access_token: "access-token-a", email: "first@example.com" },
          { access_token: "access-token-b", email: "second@example.com" },
        ]),
      );

      const result = await runCli([input, "-f", "cpa", "--jsonl", "--out-dir", outDir], {
        stdout: "",
        stderr: "",
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("");
      const lines = await readJsonLines(path.join(outDir, "cpa_2-accounts.jsonl"));
      expect(lines).toEqual([
        expect.objectContaining({ type: "codex", email: "first@example.com" }),
        expect.objectContaining({ type: "codex", email: "second@example.com" }),
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("writes one JSONL file per format directory when multiple formats are requested", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "authconv-cli-jsonl-multiformat-"));
    try {
      const input = path.join(dir, "input.json");
      const outDir = path.join(dir, "output");
      await writeFile(
        input,
        JSON.stringify([
          { access_token: "access-token-a", email: "first@example.com" },
          { access_token: "access-token-b", email: "second@example.com" },
        ]),
      );

      const result = await runCli([input, "-f", "cpa,sub2api", "--jsonl", "--out-dir", outDir], {
        stdout: "",
        stderr: "",
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("");
      expect(await readJsonLines(path.join(outDir, "cpa", "cpa_2-accounts.jsonl"))).toHaveLength(2);
      const sub2apiLines = await readJsonLines(path.join(outDir, "sub2api", "sub2api_2-accounts.jsonl"));
      expect(sub2apiLines).toHaveLength(2);
      expect(sub2apiLines[0]).toMatchObject({
        type: "sub2api-data",
        accounts: [expect.any(Object)],
      });
      expect(sub2apiLines[1]).toMatchObject({
        type: "sub2api-data",
        accounts: [expect.any(Object)],
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("prints JSONL to stdout when serialization leaves one output file", async () => {
    const result = await runCli(["--stdin", "--format", "cpa", "--stdout", "--jsonl"], {
      stdin: JSON.stringify([
        { access_token: "access-token-a", email: "first@example.com" },
        { access_token: "access-token-b", email: "second@example.com" },
      ]),
      stdout: "",
      stderr: "",
    });

    expect(result.exitCode).toBe(0);
    const lines = result.stdout.trimEnd().split("\n").map((line) => JSON.parse(line) as { email: string });
    expect(lines).toEqual([
      expect.objectContaining({ email: "first@example.com" }),
      expect.objectContaining({ email: "second@example.com" }),
    ]);
  });

  it("accepts JSONL as input text", async () => {
    const result = await runCli(["--stdin", "--format", "cpa", "--stdout", "--jsonl"], {
      stdin: [
        JSON.stringify({ access_token: "access-token-a", email: "first@example.com" }),
        JSON.stringify({ access_token: "access-token-b", email: "second@example.com" }),
      ].join("\n"),
      stdout: "",
      stderr: "",
    });

    expect(result.exitCode).toBe(0);
    const lines = result.stdout.trimEnd().split("\n").map((line) => JSON.parse(line) as { email: string });
    expect(lines).toEqual([
      expect.objectContaining({ email: "first@example.com" }),
      expect.objectContaining({ email: "second@example.com" }),
    ]);
  });

  it("reads JSONL files from an input directory", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "authconv-cli-jsonl-dir-"));
    try {
      const inputDir = path.join(dir, "accounts");
      const outDir = path.join(dir, "output");
      await mkdir(inputDir);
      await writeFile(
        path.join(inputDir, "accounts.jsonl"),
        [
          JSON.stringify({ access_token: "access-token-a", email: "first@example.com" }),
          JSON.stringify({ access_token: "access-token-b", email: "second@example.com" }),
        ].join("\n"),
      );

      const result = await runCli([inputDir, "-f", "cpa", "--jsonl", "--out-dir", outDir], {
        stdout: "",
        stderr: "",
      });

      expect(result.exitCode).toBe(0);
      const lines = await readJsonLines(path.join(outDir, "cpa_2-accounts.jsonl"));
      expect(lines.map((line) => (line as { email: string }).email)).toEqual(["first@example.com", "second@example.com"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("supports -o and --mode for per-account output on merged formats", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "authconv-cli-mode-"));
    try {
      const input = path.join(dir, "input.json");
      const outDir = path.join(dir, "custom-out");
      await writeFile(
        input,
        JSON.stringify([
          { access_token: "access-token-a", email: "first@example.com" },
          { access_token: "access-token-b", email: "second@example.com" },
        ]),
      );

      const result = await runCli([input, "-f", "sub2api", "--mode", "sub2api=single", "-o", outDir], {
        stdout: "",
        stderr: "",
      });

      expect(result.exitCode).toBe(0);
      await expect(readJsonFile(path.join(outDir, "sub2api_first_example.com.json"))).resolves.toMatchObject({
        type: "sub2api-data",
        accounts: [expect.any(Object)],
      });
      await expect(readJsonFile(path.join(outDir, "sub2api_second_example.com.json"))).resolves.toMatchObject({
        type: "sub2api-data",
        accounts: [expect.any(Object)],
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("prints an inspect summary without writing files", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "authconv-cli-inspect-"));
    try {
      const input = path.join(dir, "input.json");
      await writeFile(input, JSON.stringify({ access_token: "access-token", email: "user@example.com", plan_type: "plus" }));

      const result = await runCli([input, "--inspect"], {
        cwd: dir,
        stdout: "",
        stderr: "",
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("user@example.com");
      expect(result.stderr).toContain("plus");
      await expect(readFile(path.join(dir, "output", "sub2api_user_example.com.json"), "utf8")).rejects.toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects inspect when an output target is explicitly requested", async () => {
    const result = await runCli(["--inspect", "--stdout"], {
      stdin: JSON.stringify({ access_token: "access-token" }),
      stdout: "",
      stderr: "",
    });

    expect(result.exitCode).toBe(2);
  });

  it("rejects inspect when zip output is requested", async () => {
    const result = await runCli(["--stdin", "--inspect", "--zip"], {
      stdin: JSON.stringify({ access_token: "access-token" }),
      stdout: "",
      stderr: "",
    });

    expect(result.exitCode).toBe(2);
  });

  it("rejects inspect and dry-run together as conflicting preview modes", async () => {
    const result = await runCli(["--inspect", "--dry-run"], {
      stdin: JSON.stringify({ access_token: "access-token" }),
      stdout: "",
      stderr: "",
    });

    expect(result.exitCode).toBe(2);
  });

  it("includes account_id column in inspect output", async () => {
    const result = await runCli(["--stdin", "--inspect"], {
      stdin: JSON.stringify({ access_token: "token", email: "test@example.com", account_id: "acct_test123" }),
      stdout: "",
      stderr: "",
    });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("account_id");
    expect(result.stderr).toContain("acct_test123");
  });

  it("prints a dry-run file plan without writing files", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "authconv-cli-dry-run-"));
    try {
      const input = path.join(dir, "input.json");
      const outDir = path.join(dir, "output");
      await writeFile(input, JSON.stringify({ access_token: "access-token", email: "user@example.com" }));

      const result = await runCli([input, "-f", "cpa", "-o", outDir, "--dry-run"], {
        stdout: "",
        stderr: "",
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("cpa_user_example.com.json");
      await expect(readFile(path.join(outDir, "cpa_user_example.com.json"), "utf8")).rejects.toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("refuses to overwrite output files unless --force is set", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "authconv-cli-force-"));
    try {
      const input = path.join(dir, "input.json");
      const outDir = path.join(dir, "output");
      const output = path.join(outDir, "cpa_user_example.com.json");
      await writeFile(input, JSON.stringify({ access_token: "access-token", email: "user@example.com" }));
      await mkdir(outDir, { recursive: true });
      await writeFile(output, "existing", "utf8");

      const blocked = await runCli([input, "-f", "cpa", "-o", outDir], {
        stdout: "",
        stderr: "",
      });

      expect(blocked.exitCode).toBe(3);
      expect(await readFile(output, "utf8")).toBe("existing");

      const forced = await runCli([input, "-f", "cpa", "-o", outDir, "--force"], {
        stdout: "",
        stderr: "",
      });

      expect(forced.exitCode).toBe(0);
      expect(JSON.parse(await readFile(output, "utf8"))).toMatchObject({
        type: "codex",
        email: "user@example.com",
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("uses exit code 3 for missing input paths", async () => {
    const result = await runCli(["/definitely/missing/authconv-input.json"], {
      stdout: "",
      stderr: "",
    });

    expect(result.exitCode).toBe(3);
  });

  it("rejects invalid mode values as argument errors", async () => {
    const result = await runCli(["--mode", "cpa=single"], {
      stdin: JSON.stringify({ access_token: "access-token" }),
      stdout: "",
      stderr: "",
    });

    expect(result.exitCode).toBe(2);
  });
});
