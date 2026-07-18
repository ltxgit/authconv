import { createReadStream } from "node:fs";
import { open } from "node:fs/promises";
import { basename } from "node:path";
import { Readable } from "node:stream";
import { performance } from "node:perf_hooks";
import { AccountStore } from "../src/account-store.js";
import { isConfigurableOutputFormat } from "../src/formats.js";
import { ingestSources } from "../src/ingestion.js";
import { parseNodeJsonTokens } from "../src/input-node.js";
import { parseWebJsonTokens } from "../src/input-web.js";
import { parseInputSources } from "../src/input.js";
import {
  buildExportManifest,
  streamExport,
  type ExportSink,
  type ExportWriter,
} from "../src/output.js";
import type { InputSource, OutputMode } from "../src/types.js";
import type { WorkerRequest, WorkerResponse } from "../src/web/worker-protocol.js";

const mode = process.argv[2];
const accountCount = Number(process.env.AUTHCONV_BENCH_ACCOUNTS ?? "100000");
const realZip = process.env.AUTHCONV_REAL_ZIP;

if (!mode || !Number.isSafeInteger(accountCount) || accountCount <= 0) {
  throw new Error("Usage: benchmark-runner <mode>; AUTHCONV_BENCH_ACCOUNTS must be a positive integer");
}

const result = await run(mode);
process.stdout.write(`${JSON.stringify(result)}\n`);

async function run(selectedMode: string) {
  switch (selectedMode) {
    case "generate":
      return generateFile(requiredEnv("AUTHCONV_BENCH_OUTPUT"));
    case "parse":
      return measure(selectedMode, async () => {
        let parsed = 0;
        for await (const event of parseInputSources([syntheticSource(accountCount)], parseNodeJsonTokens)) {
          if (event.type === "values") parsed += event.items.length;
        }
        return { accounts: parsed };
      });
    case "ingestion":
      return measure(selectedMode, async () => {
        const store = await ingestSynthetic(parseNodeJsonTokens);
        return { accounts: store.size };
      });
    case "search": {
      const store = await ingestSynthetic(parseNodeJsonTokens);
      return measure(selectedMode, () => {
        const range = store.range(0, 20, `user-${accountCount - 1}@example.com`);
        return { accounts: store.size, matches: range.total };
      });
    }
    case "single":
      return outputBenchmark(selectedMode, "cpa", "single", "json", false);
    case "merged":
      return outputBenchmark(selectedMode, "sub2api", "merged", "json", false);
    case "jsonl":
      return outputBenchmark(selectedMode, "sub2api", "merged", "jsonl", false);
    case "zip":
      return outputBenchmark(selectedMode, "sub2api", "merged", "json", true);
    case "worker":
      return workerBenchmark(syntheticFile());
    case "worker-real":
      return workerBenchmark(realFile(requiredValue(realZip, "AUTHCONV_REAL_ZIP")));
    default:
      throw new Error(`Unknown benchmark mode: ${selectedMode}`);
  }
}

async function outputBenchmark(
  selectedMode: string,
  format: "cpa" | "sub2api",
  outputMode: OutputMode,
  textMode: "json" | "jsonl",
  forceZip: boolean,
) {
  const store = await ingestSynthetic(parseNodeJsonTokens);
  let bytes = 0;
  const writer: ExportWriter = {
    write(chunk) {
      bytes += chunk.byteLength;
    },
    close: () => undefined,
    abort: () => undefined,
  };
  const sink: ExportSink = {
    openFile: async () => writer,
    openArchive: async () => writer,
  };
  return measure(selectedMode, async () => {
    const manifest = buildExportManifest(store, {
      formats: [format],
      outputModes: isConfigurableOutputFormat(format) ? { [format]: outputMode } : undefined,
      textMode,
      forceZip,
      verifyTokens: false,
    });
    await streamExport(store, manifest, sink);
    return { accounts: manifest.accountCount, entries: manifest.entries.length, bytes };
  });
}

async function ingestSynthetic(parseTokens: typeof parseNodeJsonTokens | typeof parseWebJsonTokens): Promise<AccountStore> {
  const store = new AccountStore();
  await ingestSources([syntheticSource(accountCount)], store, { parseTokens, verifyTokens: false });
  return store;
}

async function workerBenchmark(file: File): Promise<Awaited<ReturnType<typeof measure>>> {
  let listener: ((event: MessageEvent<WorkerRequest>) => void) | undefined;
  let resolveFinal: ((message: WorkerResponse) => void) | undefined;
  const final = new Promise<WorkerResponse>((resolve) => {
    resolveFinal = resolve;
  });
  const workerGlobal = {
    addEventListener(type: string, callback: (event: MessageEvent<WorkerRequest>) => void) {
      if (type === "message") listener = callback;
    },
    postMessage(message: WorkerResponse) {
      if (message.type !== "progress" && message.type !== "exportChunk") resolveFinal?.(message);
    },
  };
  Object.defineProperty(globalThis, "self", { value: workerGlobal, configurable: true });
  await import("../src/web/worker.js");
  if (!listener) throw new Error("Worker message listener was not registered");

  let dispatchMs = 0;
  return measure(mode, async () => {
    const dispatchStart = performance.now();
    listener!({
      data: {
        type: "importFiles",
        requestId: 1,
        files: [{ file, path: file.name }],
        verifyTokens: false,
      },
    } as MessageEvent<WorkerRequest>);
    dispatchMs = performance.now() - dispatchStart;
    const response = await final;
    if (response.type === "error") throw new Error(response.message);
    if (response.type !== "importFilesResult") throw new Error(`Unexpected worker response: ${response.type}`);
    return {
      accounts: response.summary.loaded.total,
      mainThreadDispatchMs: dispatchMs,
    };
  });
}

function syntheticFile(): File {
  return {
    name: "synthetic.json",
    stream: () => readableStream(syntheticChunks(accountCount)),
  } as File;
}

function realFile(path: string): File {
  return {
    name: basename(path),
    stream: () => Readable.toWeb(createReadStream(path)) as ReadableStream<Uint8Array>,
  } as File;
}

function readableStream(chunks: AsyncIterable<Uint8Array>): ReadableStream<Uint8Array> {
  const iterator = chunks[Symbol.asyncIterator]();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const result = await iterator.next();
      if (result.done) controller.close();
      else controller.enqueue(result.value);
    },
    async cancel() {
      await iterator.return?.();
    },
  });
}

async function generateFile(path: string) {
  const handle = await open(path, "w", 0o600);
  let bytes = 0;
  try {
    for await (const chunk of syntheticChunks(accountCount)) {
      let offset = 0;
      while (offset < chunk.byteLength) {
        const result = await handle.write(chunk, offset, chunk.byteLength - offset);
        offset += result.bytesWritten;
        bytes += result.bytesWritten;
      }
    }
  } finally {
    await handle.close();
  }
  return { mode: "generate", accounts: accountCount, bytes };
}

function syntheticSource(count: number): InputSource {
  return {
    name: "synthetic.json",
    path: "synthetic.json",
    chunks: syntheticChunks(count),
  };
}

async function* syntheticChunks(count: number): AsyncGenerator<Uint8Array> {
  const encoder = new TextEncoder();
  const chunkSize = 256;
  yield encoder.encode('{"accounts":[');
  for (let start = 0; start < count; start += chunkSize) {
    const end = Math.min(count, start + chunkSize);
    const records: string[] = [];
    for (let index = start; index < end; index += 1) {
      records.push(JSON.stringify(syntheticRecord(index)));
    }
    yield encoder.encode(`${start === 0 ? "" : ","}${records.join(",")}`);
  }
  yield encoder.encode("]}");
}

function syntheticRecord(index: number) {
  const accountId = `account-${index}`;
  const payload = Buffer.from(JSON.stringify({
    iss: "https://auth.openai.com",
    sub: `user-${index}`,
    exp: 1_893_456_000,
    "https://api.openai.com/auth": {
      chatgpt_account_id: accountId,
      chatgpt_plan_type: "plus",
    },
  })).toString("base64url");
  return {
    platform: "openai",
    credentials: {
      access_token: `eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0.${payload}.signature-${index}`,
      refresh_token: `refresh-token-${index}`,
      account_id: accountId,
      email: `user-${index}@example.com`,
      expires_at: 1_893_456_000,
      plan_type: "plus",
    },
  };
}

async function measure<T>(selectedMode: string, task: () => T | Promise<T>) {
  globalThis.gc?.();
  const started = performance.now();
  const details = await task();
  const timeMs = performance.now() - started;
  const maxRssBytes = process.resourceUsage().maxRSS * 1024;
  return { mode: selectedMode, timeMs, maxRssBytes, ...details };
}

function requiredEnv(name: string): string {
  return requiredValue(process.env[name], name);
}

function requiredValue(value: string | undefined, name: string): string {
  if (!value) throw new Error(`${name} is required`);
  return value;
}
