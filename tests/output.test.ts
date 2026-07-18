import { strFromU8, unzipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { AccountStore } from "../src/account-store.js";
import { ingestSources } from "../src/ingestion.js";
import { parseNodeJsonTokens } from "../src/input-node.js";
import {
  buildExportManifest,
  collectExportEntry,
  streamExport,
  type ExportWriter,
} from "../src/output.js";
import type { InputSource } from "../src/types.js";

describe("ExportManifest and streamExport", () => {
  it("用同一 manifest 固定格式适用性、路径和 JSONL 账号行", async () => {
    const store = await accountStore([
      { access_token: "openai-a", email: "same@example.com", platform: "openai", account_id: "acct-first-123456" },
      { access_token: "openai-b", email: "same@example.com", platform: "openai", account_id: "acct-second-123456" },
      { access_token: xaiJwt("xai-user"), refresh_token: "xai-refresh", email: "xai@example.com" },
    ]);
    const manifest = buildExportManifest(store, {
      formats: ["cpa", "codex", "grok"],
      textMode: "jsonl",
      verifyTokens: false,
    });

    expect(manifest.formats).toEqual(["cpa", "codex", "grok"]);
    expect(manifest.entries.map((entry) => [entry.path, entry.accountCount])).toEqual([
      ["cpa/cpa_3-accounts.jsonl", 3],
      ["codex/codex_2-accounts.jsonl", 2],
      ["grok/grok_xai_example.com_xai-user.jsonl", 1],
    ]);
    const codexText = await collectExportEntry(store, manifest.entries[1], { now: new Date(0) });
    expect(codexText.trimEnd().split("\n").map((line) => JSON.parse(line))).toHaveLength(2);
  });

  it("merged JSON 增量输出保持 Sub2API wire shape", async () => {
    const store = await accountStore([
      { access_token: "a", email: "a@example.com", platform: "openai" },
      { access_token: "b", email: "b@example.com", platform: "openai" },
    ]);
    const manifest = buildExportManifest(store, { formats: ["sub2api"], verifyTokens: false });
    const text = await collectExportEntry(store, manifest.entries[0], { now: new Date("2026-07-14T00:00:00.000Z") });

    expect(JSON.parse(text)).toMatchObject({
      type: "sub2api-data",
      version: 1,
      exported_at: "2026-07-14T00:00:00.000Z",
      accounts: [
        { platform: "openai", credentials: { access_token: "a" } },
        { platform: "openai", credentials: { access_token: "b" } },
      ],
    });
  });

  it("官方 Grok 固定单账号文件，Grok2API 固定合并多账号", async () => {
    const store = await accountStore([
      { access_token: xaiJwt("xai-user-a"), email: "first@example.com" },
      { access_token: xaiJwt("xai-user-b"), email: "second@example.com" },
    ]);
    const manifest = buildExportManifest(store, {
      formats: ["grok", "grok2api"],
      verifyTokens: false,
    });

    expect(manifest.entries.map((entry) => [entry.path, entry.mode, entry.accountCount])).toEqual([
      ["grok/grok_first_example.com_xai-user-a.json", "single", 1],
      ["grok/grok_second_example.com_xai-user-b.json", "single", 1],
      ["grok2api/grok2api_2-accounts.json", "merged", 2],
    ]);

    const officialFiles = await Promise.all(manifest.entries.slice(0, 2).map(async (entry) => (
      JSON.parse(await collectExportEntry(store, entry)) as Record<string, { user_id: string }>
    )));
    expect(officialFiles.map((file) => Object.keys(file))).toEqual([
      ["https://auth.x.ai::b1a00492-073a-47ea-816f-4c329264a828"],
      ["https://auth.x.ai::b1a00492-073a-47ea-816f-4c329264a828"],
    ]);
    expect(officialFiles.map((file) => Object.values(file)[0].user_id)).toEqual(["xai-user-a", "xai-user-b"]);

    const pool = JSON.parse(await collectExportEntry(store, manifest.entries[2])) as Record<string, unknown>;
    expect(Object.keys(pool)).toEqual([
      "https://auth.x.ai::xai-user-a",
      "https://auth.x.ai::xai-user-b",
    ]);
    expect(() => buildExportManifest(store, {
      formats: ["grok"],
      outputModes: { grok: "merged" },
      verifyTokens: false,
    })).toThrow("Format grok uses fixed single output");
  });

  it("Grok2API 对相同 user_id 采用后项并按实际账号数生成 manifest", async () => {
    const store = await accountStore([
      {
        platform: "grok",
        credentials: { access_token: "older-token", user_id: "same-user", email: "older@example.com" },
      },
      {
        platform: "grok",
        credentials: { access_token: "newer-token", user_id: "same-user", email: "newer@example.com" },
      },
    ]);
    const manifest = buildExportManifest(store, { formats: ["grok2api"], verifyTokens: false });

    expect(store.size).toBe(2);
    expect(manifest.accountCount).toBe(1);
    expect(manifest.entries).toHaveLength(1);
    expect(manifest.entries[0]).toMatchObject({ mode: "merged", accountCount: 1 });
    expect(store.get(manifest.entries[0].accountIds[0])?.accessToken).toBe("newer-token");
    expect(JSON.parse(await collectExportEntry(store, manifest.entries[0]))).toEqual({
      "https://auth.x.ai::same-user": expect.objectContaining({ key: "newer-token", user_id: "same-user" }),
    });

    const jsonlManifest = buildExportManifest(store, {
      formats: ["grok2api"],
      textMode: "jsonl",
      verifyTokens: false,
    });
    expect(jsonlManifest.accountCount).toBe(2);
    expect(jsonlManifest.entries[0].accountCount).toBe(2);
    const jsonlTokens = (await collectExportEntry(store, jsonlManifest.entries[0]))
      .trimEnd()
      .split("\n")
      .map((line) => Object.values(JSON.parse(line) as Record<string, { key: string }>)[0].key);
    expect(jsonlTokens).toEqual(["older-token", "newer-token"]);
  });

  it("Grok2API 为缺少用户身份的不同凭证生成稳定且互异的 surrogate", async () => {
    const store = await accountStore([
      {
        platform: "grok",
        credentials: { access_token: "anonymous-a", client_id: "shared-client" },
      },
      {
        platform: "grok",
        credentials: { access_token: "anonymous-b", client_id: "shared-client" },
      },
    ]);
    const manifest = buildExportManifest(store, { formats: ["grok2api"], verifyTokens: false });

    expect(manifest.accountCount).toBe(2);
    const pool = JSON.parse(await collectExportEntry(store, manifest.entries[0])) as Record<string, {
      key: string;
      user_id: string;
      principal_id: string;
    }>;
    const keys = Object.keys(pool);
    expect(keys).toHaveLength(2);
    expect(new Set(keys).size).toBe(2);
    expect(keys.every((key) => /^https:\/\/auth\.x\.ai::authconv-[0-9a-f]{16}$/.test(key))).toBe(true);
    expect(Object.values(pool).map((entry) => entry.key).sort()).toEqual(["anonymous-a", "anonymous-b"]);
    for (const [key, entry] of Object.entries(pool)) {
      const surrogate = key.slice("https://auth.x.ai::".length);
      expect(entry).toMatchObject({ user_id: surrogate, principal_id: surrogate });
    }

    const jsonlManifest = buildExportManifest(store, {
      formats: ["grok2api"],
      textMode: "jsonl",
      verifyTokens: false,
    });
    const jsonlKeys = (await collectExportEntry(store, jsonlManifest.entries[0]))
      .trimEnd()
      .split("\n")
      .map((line) => Object.keys(JSON.parse(line) as Record<string, unknown>)[0]);
    expect(new Set(jsonlKeys).size).toBe(2);
    expect(jsonlKeys).toEqual(keys);
  });

  it("为已经带数字后缀的账号名分配全局唯一输出路径", () => {
    const store = new AccountStore();
    store.commitSource([
      namedAccount("token-a", "alice"),
      namedAccount("token-b", "alice-2"),
      namedAccount("token-c", "alice"),
    ]);

    const manifest = buildExportManifest(store, { formats: ["cpa"], verifyTokens: false });

    expect(manifest.entries.map((entry) => entry.path)).toEqual([
      "cpa_alice.json",
      "cpa_alice-2.json",
      "cpa_alice-3.json",
    ]);
  });

  it("构建大型 manifest 时不通过数组 spread 触发调用栈上限", () => {
    const count = 150_000;
    const account = namedAccount("shared-token", "shared");
    const store = {
      *entries() {
        for (let index = 0; index < count; index += 1) {
          yield [`account-${index}`, account] as [string, typeof account];
        }
      },
      get() {
        return account;
      },
    };

    const manifest = buildExportManifest(store, {
      formats: ["sub2api"],
      verifyTokens: false,
    });

    expect(manifest.accountCount).toBe(count);
    expect(manifest.entries).toMatchObject([{ mode: "merged", accountCount: count }]);
  });

  it("ZIP 边渲染边压缩", async () => {
    const store = await accountStore([
      { access_token: "a", email: "a@example.com", platform: "openai" },
      { access_token: "b", email: "b@example.com", platform: "openai" },
    ]);
    const manifest = buildExportManifest(store, { formats: ["cpa", "codex"], forceZip: true, verifyTokens: false });
    const chunks: Uint8Array[] = [];
    const writer: ExportWriter = {
      write: (chunk) => { chunks.push(chunk.slice()); },
      close: () => undefined,
      abort: () => undefined,
    };

    await streamExport(store, manifest, {
      openArchive: async () => writer,
      openFile: async () => { throw new Error("unexpected direct file"); },
    }, { now: new Date(0) });
    const archive = unzipSync(concat(chunks));

    expect(Object.keys(archive)).toEqual(manifest.entries.map((entry) => entry.path));
    expect(JSON.parse(strFromU8(archive[manifest.entries[0].path]))).toMatchObject({ access_token: "a" });
  });

  it("空 manifest 不打开文件或 ZIP writer", async () => {
    const store = new AccountStore();
    const manifest = buildExportManifest(store, { formats: ["cpa"], forceZip: true, verifyTokens: false });
    let opened = false;

    const result = await streamExport(store, manifest, {
      openArchive: async () => {
        opened = true;
        throw new Error("unexpected archive");
      },
      openFile: async () => {
        opened = true;
        throw new Error("unexpected file");
      },
    });

    expect(result).toEqual({ completedEntries: 0, completedAccounts: 0 });
    expect(opened).toBe(false);
  });

  it("ZIP 输出包含 ZIP64 目录记录", async () => {
    const store = await accountStore([
      { access_token: "a", email: "a@example.com", platform: "openai" },
    ]);
    const manifest = buildExportManifest(store, { formats: ["cpa"], forceZip: true, verifyTokens: false });
    const chunks: Uint8Array[] = [];
    const writer: ExportWriter = {
      write: (chunk) => { chunks.push(chunk.slice()); },
      close: () => undefined,
      abort: () => undefined,
    };

    await streamExport(store, manifest, {
      openArchive: async () => writer,
      openFile: async () => { throw new Error("unexpected direct file"); },
    });

    const bytes = concat(chunks);
    expect(findSignature(bytes, [0x50, 0x4b, 0x06, 0x06])).toBeGreaterThanOrEqual(0);
    expect(Object.keys(unzipSync(bytes))).toEqual(manifest.entries.map((entry) => entry.path));
  });

  it("ZIP 写入失败时终止 writer 并原样返回错误", async () => {
    const store = await accountStore([
      { access_token: "a", email: "a@example.com", platform: "openai" },
    ]);
    const manifest = buildExportManifest(store, { formats: ["cpa"], forceZip: true, verifyTokens: false });
    const failure = new Error("disk full");
    let abortedWith: unknown;
    const writer: ExportWriter = {
      write: () => { throw failure; },
      close: () => undefined,
      abort: (error) => { abortedWith = error; },
    };

    await expect(streamExport(store, manifest, {
      openArchive: async () => writer,
      openFile: async () => { throw new Error("unexpected direct file"); },
    })).rejects.toBe(failure);
    expect(abortedWith).toBe(failure);
  });

  it("ZIP close 失败时终止底层 writer 并原样返回错误", async () => {
    const store = await accountStore([
      { access_token: "a", email: "a@example.com", platform: "openai" },
    ]);
    const manifest = buildExportManifest(store, { formats: ["cpa"], forceZip: true, verifyTokens: false });
    const failure = new Error("close failed");
    let abortedWith: unknown;
    const writer: ExportWriter = {
      write: () => undefined,
      close: () => { throw failure; },
      abort: (error) => { abortedWith = error; },
    };

    await expect(streamExport(store, manifest, {
      openArchive: async () => writer,
      openFile: async () => { throw new Error("unexpected direct file"); },
    })).rejects.toBe(failure);
    expect(abortedWith).toBe(failure);
  });

  it("filters non-verified accounts once and returns stable rejection reasons", () => {
    const store = new AccountStore();
    store.commitSource([
      verifiedAccount("verified", "verified@example.com"),
      rejectedAccount("forged", "signature_failed", "forged", "forged@example.com"),
      rejectedAccount("unverifiable", "opaque_access_token", "opaque", "opaque@example.com"),
      rejectedAccount("unchecked", "user_disabled", "unchecked", "unchecked@example.com"),
    ]);

    const filtered = buildExportManifest(store, { formats: ["cpa", "sub2api"] });
    expect(filtered.accountCount).toBe(1);
    expect(filtered.entries.every((entry) => entry.accountIds.length === 1)).toBe(true);
    expect(filtered.rejectedAccountCount).toBe(3);
    expect(filtered.rejectionReasons).toEqual({
      signature_failed: 1,
      opaque_access_token: 1,
      user_disabled: 1,
    });

    const unfiltered = buildExportManifest(store, {
      formats: ["cpa", "sub2api"],
      verifyTokens: false,
    });
    expect(unfiltered.accountCount).toBe(4);
    expect(unfiltered.rejectedAccountCount).toBe(0);
    expect(unfiltered.rejectionReasons).toEqual({});
  });

});

function verifiedAccount(accessToken: string, email: string) {
  return rejectedAccount("verified", "signature_valid", accessToken, email);
}

function namedAccount(accessToken: string, name: string) {
  return {
    ...verifiedAccount(accessToken, `${accessToken}@example.com`),
    email: undefined,
    name,
  };
}

function rejectedAccount(
  status: "verified" | "forged" | "unverifiable" | "unchecked",
  reason: "signature_valid" | "signature_failed" | "opaque_access_token" | "user_disabled",
  accessToken: string,
  email: string,
) {
  return {
    provider: "openai" as const,
    accessToken,
    email,
    sourceName: "test.json",
    sourcePath: "/test.json",
    inputFormat: "unknown" as const,
    tokenVerification: { status, reason, tokenField: "accessToken" as const },
    tokenVerificationContext: { provider: "openai" as const },
  };
}

async function accountStore(values: unknown[]): Promise<AccountStore> {
  const store = new AccountStore();
  const text = JSON.stringify(values);
  const source: InputSource = {
    name: "accounts.json",
    path: "/accounts.json",
    chunks: oneChunk(new TextEncoder().encode(text)),
  };
  await ingestSources([source], store, { parseTokens: parseNodeJsonTokens });
  return store;
}

async function* oneChunk(value: Uint8Array): AsyncGenerator<Uint8Array> {
  yield value;
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

function findSignature(bytes: Uint8Array, signature: number[]): number {
  for (let offset = 0; offset <= bytes.length - signature.length; offset += 1) {
    if (signature.every((value, index) => bytes[offset + index] === value)) return offset;
  }
  return -1;
}

function xaiJwt(subject: string): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none" })}.${encode({ iss: "https://auth.x.ai", sub: subject })}.signature`;
}
