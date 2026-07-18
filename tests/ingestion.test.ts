import { zipSync, strToU8 } from "fflate";
import { describe, expect, it } from "vitest";
import { AccountStore } from "../src/account-store.js";
import { ingestSources } from "../src/ingestion.js";
import { parseNodeJsonTokens } from "../src/input-node.js";
import type { InputSource } from "../src/types.js";

describe("ingestSources", () => {
  it("在任意 chunk 边界增量导入根数组和 accounts 数组", async () => {
    const text = JSON.stringify([
      { access_token: "array-a", email: "a@example.com" },
      { accounts: [{ platform: "openai", credentials: { access_token: "array-b" } }] },
    ]);
    const result = await ingest(oneByteSource("accounts.json", text));

    expect([...result.store.values()].map((account) => account.accessToken)).toEqual(["array-a", "array-b"]);
    expect(result.diagnostics).toEqual([]);
  });

  it("连续 JSON 损坏时保留已提交文档并丢弃当前文档", async () => {
    const result = await ingest(textSource("stream.json", '{"access_token":"kept"}\n{"access_token":'));

    expect([...result.store.values()].map((account) => account.accessToken)).toEqual(["kept"]);
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(["json_parse_failed"]);
  });

  it("JSONL 坏行隔离且保留前后合法账号", async () => {
    const result = await ingest(textSource(
      "accounts.txt",
      '{"access_token":"before"}\n{"access_token":}\n{"access_token":"after"}\n',
    ));

    expect([...result.store.values()].map((account) => account.accessToken)).toEqual(["before", "after"]);
    expect(result.diagnostics).toMatchObject([{ code: "json_parse_failed", line: 2 }]);
  });

  it("首条 JSONL 超过判型上限时仍隔离坏行并保留后续账号", async () => {
    const first = JSON.stringify({
      access_token: "before",
      padding: "x".repeat(70 * 1024),
    });
    const result = await ingest(textSource(
      "large-jsonl.data",
      `${first}\n{"access_token":}\n{"access_token":"after"}\n`,
    ));

    expect([...result.store.values()].map((account) => account.accessToken)).toEqual(["before", "after"]);
    expect(result.diagnostics).toMatchObject([{ code: "json_parse_failed", line: 2 }]);
  });

  it.each([
    [
      "pretty JSON",
      `{"access_token":"pretty","padding":"${"x".repeat(70 * 1024)}"\n}`,
      ["pretty"],
    ],
    [
      "same-line consecutive roots",
      `{"access_token":"first","padding":"${"x".repeat(70 * 1024)}"}{"access_token":"second"}`,
      ["first", "second"],
    ],
  ] as const)("超出判型上限后仍保留 %s 语义", async (_label, text, expected) => {
    const result = await ingest(textSource("large-ambiguous.data", text));

    expect([...result.store.values()].map((account) => account.accessToken)).toEqual(expected);
    expect(result.diagnostics).toEqual([]);
  });

  it.each(["not-json", '{"access_token":}'])(
    "JSONL 首行损坏时仍隔离该行并保留后续账号: %s",
    async (brokenLine) => {
      const result = await ingest(textSource(
        "accounts.data",
        `${brokenLine}\n{"access_token":"after"}`,
      ));

      expect([...result.store.values()].map((account) => account.accessToken)).toEqual(["after"]);
      expect(result.diagnostics).toMatchObject([{ code: "json_parse_failed", line: 1 }]);
    },
  );

  it("不把首行未闭合的合法多行 JSON 误判为 JSONL", async () => {
    const result = await ingest(textSource(
      "accounts.data",
      '{"access_token":"inside",\n"name":"Pretty JSON"}',
    ));

    expect([...result.store.values()].map((account) => account.accessToken)).toEqual(["inside"]);
    expect(result.diagnostics).toEqual([]);
  });

  it("连续 JSON 的后续 pretty root 保持完整文档解析", async () => {
    const result = await ingest(textSource(
      "accounts.data",
      '{"access_token":"first"}\n{\n"access_token":"second"\n}',
    ));

    expect([...result.store.values()].map((account) => account.accessToken)).toEqual(["first", "second"]);
    expect(result.diagnostics).toEqual([]);
  });

  it("checkpoint 只发布新增诊断而不重复复制历史诊断", async () => {
    const diagnosticsAdded: string[][] = [];
    const result = await ingestSources([
      textSource(
        "accounts.txt",
        '{"access_token":"before"}\n{"access_token":}\n{"access_token":"after"}\n',
      ),
    ], new AccountStore(), {
      parseTokens: parseNodeJsonTokens,
      onCheckpoint: (checkpoint) => {
        diagnosticsAdded.push(checkpoint.diagnosticsAdded.map((diagnostic) => diagnostic.code));
      },
    });

    expect(diagnosticsAdded.flat()).toEqual(result.diagnostics.map((diagnostic) => diagnostic.code));
    expect(Math.max(...diagnosticsAdded.map((diagnostics) => diagnostics.length))).toBe(1);
  });

  it("ZIP entry 按归档顺序提交并隔离损坏 entry", async () => {
    const bytes = zipSync({
      "01.txt": strToU8('{"access_token":"first"}'),
      "README.md": strToU8("not credentials"),
      "02.data": strToU8('{"access_token":}'),
      "03.wrong": strToU8('{"access_token":"third"}\n'),
    });
    const result = await ingest({
      name: "batch.txt",
      path: "/batch.txt",
      chunks: chunks(bytes, 7),
      cancel: () => undefined,
    });

    expect([...result.store.values()].map((account) => account.accessToken)).toEqual(["first", "third"]);
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]).toMatchObject({ code: "json_parse_failed", sourceName: "batch.txt/02.data" });
  });

  it("嵌套 ZIP entry 递归使用同一输入识别流程", async () => {
    const inner = zipSync({
      "accounts.data": strToU8('{"access_token":"nested"}'),
    });
    const outer = zipSync({
      "nested/archive.data": inner,
    });

    const result = await ingest(byteSource("outer.data", outer));

    expect([...result.store.values()].map((account) => account.accessToken)).toEqual(["nested"]);
    expect(result.diagnostics).toEqual([]);
  });

  it("大型单行 JSON 在读完整个输入前结束格式嗅探", async () => {
    const bytes = new TextEncoder().encode(JSON.stringify({
      access_token: "large-json",
      padding: "x".repeat(256 * 1024),
    }));
    let chunksRead = 0;
    let chunksReadWhenParsingStarted = Number.POSITIVE_INFINITY;
    const source: InputSource = {
      name: "large.data",
      path: "/large.data",
      chunks: (async function* () {
        for (let offset = 0; offset < bytes.length; offset += 1024) {
          chunksRead += 1;
          yield bytes.subarray(offset, Math.min(offset + 1024, bytes.length));
        }
      })(),
    };

    const result = await ingestSources([source], new AccountStore(), {
      parseTokens: async function* (input, options) {
        chunksReadWhenParsingStarted = chunksRead;
        yield* parseNodeJsonTokens(input, options);
      },
    });

    expect([...result.store.values()].map((account) => account.accessToken)).toEqual(["large-json"]);
    expect(chunksReadWhenParsingStarted).toBeLessThan(chunksRead);
  });

  it("reports damaged ZIP compression as a ZIP failure rather than invalid JSON", async () => {
    const bytes = zipSync({ "broken.json": strToU8('{"access_token":"inside"}') });
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const dataOffset = 30 + view.getUint16(26, true) + view.getUint16(28, true);
    bytes[dataOffset] = 0x07;

    const result = await ingest({
      name: "damaged.zip",
      path: "/damaged.zip",
      chunks: chunks(bytes, 7),
      cancel: () => undefined,
    });

    expect(result.diagnostics).toMatchObject([{ code: "zip_read_failed", sourceName: "damaged.zip" }]);
  });

  it("cancels the ZIP reader after an entry decompression failure", async () => {
    const bytes = zipSync({ "broken.json": strToU8('{"access_token":"inside"}') });
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const dataOffset = 30 + view.getUint16(26, true) + view.getUint16(28, true);
    bytes[dataOffset] = 0x07;
    const source = blockingSource("damaged.zip", bytes);

    try {
      const result = await ingest(source.input);
      expect(result.diagnostics).toMatchObject([{ code: "zip_read_failed" }]);
      expect(source.released()).toBe(true);
    } finally {
      source.release();
    }
  });

  it("drains a large ZIP entry after JSON parsing fails instead of deadlocking backpressure", async () => {
    const payload = new Uint8Array(3 * 1024 * 1024);
    payload.fill(0x20);
    payload.set(strToU8('{"access_token":}\n'));
    const bytes = zipSync({ "broken.json": payload }, { level: 0 });
    let released = false;
    const source: InputSource = {
      name: "large-broken.zip",
      path: "/large-broken.zip",
      chunks: (async function* () {
        try {
          yield* chunks(bytes, 64 * 1024);
        } finally {
          released = true;
        }
      })(),
      cancel: () => undefined,
    };

    const result = await ingest(source);

    expect(result.diagnostics).toMatchObject([{ code: "json_parse_failed" }]);
    expect(released).toBe(true);
  });

  it("reports bytes without a ZIP end record as a ZIP failure", async () => {
    const result = await ingest(byteSource("broken.zip", new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3])));

    expect(result.diagnostics).toMatchObject([{ code: "zip_read_failed", sourceName: "broken.zip" }]);
  });

  it("verifies normalized accounts before committing them to the Store", async () => {
    const result = await ingest(textSource(
      "accounts.json",
      '{"platform":"openai","credentials":{"access_token":"opaque-access"}}',
    ));

    expect(result.store.getAt(0)).toMatchObject({
      accessToken: "opaque-access",
      tokenVerification: { status: "unverifiable", reason: "opaque_access_token" },
      tokenVerificationContext: { provider: "openai" },
    });
  });

  it("marks every account unchecked when verification is explicitly disabled", async () => {
    const source = textSource(
      "accounts.json",
      '[{"access_token":"opaque-a"},{"access_token":"opaque-b"}]',
    );
    const result = await ingestSources([source], new AccountStore(), {
      parseTokens: parseNodeJsonTokens,
      verifyTokens: false,
    });

    expect([...result.store.values()].map((account) => account.tokenVerification)).toEqual([
      expect.objectContaining({ status: "unchecked", reason: "user_disabled" }),
      expect.objectContaining({ status: "unchecked", reason: "user_disabled" }),
    ]);
  });

  it.each([
    ["json", "EIO"],
    ["json", "EACCES"],
    ["zip", "EIO"],
    ["zip", "EACCES"],
  ] as const)("does not disguise %s source %s failures as parse diagnostics", async (kind, code) => {
    const error = Object.assign(new Error(`${kind} read failed`), { code });
    const source: InputSource = kind === "zip" ? {
      name: `broken.${kind}`,
      path: `/broken.${kind}`,
      chunks: throwingChunks(error),
      cancel: () => undefined,
    } : {
      name: `broken.${kind}`,
      path: `/broken.${kind}`,
      chunks: throwingChunks(error),
    };

    await expect(ingest(source)).rejects.toBe(error);
  });
});

async function ingest(source: InputSource) {
  return ingestSources([source], new AccountStore(), { parseTokens: parseNodeJsonTokens });
}

function textSource(name: string, text: string): InputSource {
  return byteSource(name, new TextEncoder().encode(text));
}

function byteSource(name: string, bytes: Uint8Array): InputSource {
  return { name, path: `/${name}`, chunks: chunks(bytes, 13) };
}

function oneByteSource(name: string, text: string): InputSource {
  return { name, path: `/${name}`, chunks: chunks(new TextEncoder().encode(text), 1) };
}

async function* chunks(bytes: Uint8Array, size: number): AsyncGenerator<Uint8Array> {
  for (let offset = 0; offset < bytes.length; offset += size) {
    yield bytes.subarray(offset, Math.min(offset + size, bytes.length));
  }
}

async function* throwingChunks(error: Error): AsyncGenerator<Uint8Array> {
  throw error;
}

function blockingSource(name: string, bytes: Uint8Array): {
  input: InputSource;
  release: () => void;
  released: () => boolean;
} {
  let release: () => void = () => undefined;
  let readerReleased = false;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  return {
    input: {
      name,
      path: `/${name}`,
      chunks: (async function* () {
        try {
          yield* chunks(bytes, 7);
          await blocked;
        } finally {
          readerReleased = true;
        }
      })(),
      cancel: () => release(),
    },
    release,
    released: () => readerReleased,
  };
}
