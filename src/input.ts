import { Unzip, UnzipInflate, type UnzipFile } from "fflate";
import { FlexAssembler, arrayRule, objectRule } from "stream-json/core/utils/flex-assembler.js";
import type { Token } from "stream-json/core/parser.js";
import { isRecord } from "./object.js";
import type { IngestionDiagnostic, InputFormat, InputSource } from "./types.js";
import { XAI_ISSUER } from "./xai.js";

const STREAM_BUFFER_LIMIT = 2 * 1024 * 1024;
const ZIP_END_RECORD_LIMIT = 22 + 0xffff;
const TEXT_SNIFF_LIMIT = 64 * 1024;
const ZIP_SIGNATURES = [
  [0x50, 0x4b, 0x03, 0x04],
  [0x50, 0x4b, 0x05, 0x06],
  [0x50, 0x4b, 0x07, 0x08],
] as const;

type DetectedInputSource = InputSource & { kind: "json" | "jsonl" | "ambiguous" | "zip" };

export type TokenParser = (
  chunks: AsyncIterable<Uint8Array | string>,
  options: { jsonStreaming: boolean; signal?: AbortSignal },
) => AsyncIterable<readonly Token[]>;

export type ParsedInputEvent =
  | {
      type: "values";
      batchId: string;
      sourceName: string;
      items: Array<{
        value: unknown;
        sourcePath: string;
        inputFormat?: InputFormat;
      }>;
    }
  | {
      type: "commit";
      batchId: string;
      sourceName: string;
      sourcePath: string;
    }
  | {
      type: "discard";
      batchId: string;
      diagnostic: IngestionDiagnostic;
    };

export async function* parseInputSources(
  sources: Iterable<InputSource> | AsyncIterable<InputSource>,
  parseTokens: TokenParser,
  signal?: AbortSignal,
): AsyncGenerator<ParsedInputEvent> {
  for await (const source of sources) {
    throwIfAborted(signal);
    const detected = await detectInputSource(source, signal);
    if (!detected) continue;
    yield* parseDetectedInputSource(detected, parseTokens, signal);
  }
}

async function* parseDetectedInputSource(
  source: DetectedInputSource,
  parseTokens: TokenParser,
  signal?: AbortSignal,
): AsyncGenerator<ParsedInputEvent> {
  if (source.kind !== "zip") {
    yield* parseInputSource(source, parseTokens, signal);
    return;
  }

  try {
    for await (const entry of zipEntrySources(source, signal)) {
      const detectedEntry = await detectInputSource(entry, signal);
      if (detectedEntry) yield* parseDetectedInputSource(detectedEntry, parseTokens, signal);
    }
  } catch (error) {
    if (isAbortError(error) || isSystemIoError(error)) throw error;
    yield zipFailure(source, error);
  }
}

async function detectInputSource(
  source: InputSource,
  signal?: AbortSignal,
): Promise<DetectedInputSource | undefined> {
  const iterator = source.chunks[Symbol.asyncIterator]();
  const buffered: Uint8Array[] = [];
  let bufferedBytes = 0;

  while (bufferedBytes < 4) {
    throwIfAborted(signal);
    const result = await iterator.next();
    if (result.done) break;
    buffered.push(result.value);
    bufferedBytes += result.value.byteLength;
  }

  const prefix = firstBytes(buffered, 4);
  if (prefix.byteLength === 4 && ZIP_SIGNATURES.some((signature) => (
    signature.every((value, index) => prefix[index] === value)
  ))) {
    return detected("zip");
  }

  const decoder = new TextDecoder();
  const textKind = new TextKindDetector();
  let sniffedBytes = 0;
  for (const chunk of buffered) {
    const decision = inspect(chunk);
    if (decision?.kind) return detected(decision.kind);
    if (decision?.unsupported) return closeUnsupported();
  }

  for (;;) {
    throwIfAborted(signal);
    const result = await iterator.next();
    if (result.done) {
      const finalDecision = textKind.finish(decoder.decode());
      if (finalDecision.kind) return detected(finalDecision.kind);
      return closeUnsupported();
    }
    buffered.push(result.value);
    const decision = inspect(result.value);
    if (decision?.kind) return detected(decision.kind);
    if (decision?.unsupported) return closeUnsupported();
  }

  function inspect(chunk: Uint8Array): TextKindDecision | undefined {
    const remaining = TEXT_SNIFF_LIMIT - sniffedBytes;
    if (remaining <= 0) return textKind.boundedFallback();
    const inspected = chunk.subarray(0, Math.min(chunk.byteLength, remaining));
    sniffedBytes += inspected.byteLength;
    const decision = textKind.push(decoder.decode(inspected, { stream: true }));
    return decision ?? (sniffedBytes >= TEXT_SNIFF_LIMIT ? textKind.boundedFallback() : undefined);
  }

  function detected(kind: DetectedInputSource["kind"]): DetectedInputSource {
    return {
      ...source,
      kind,
      chunks: replayChunks(buffered, iterator),
    };
  }

  async function closeUnsupported(): Promise<undefined> {
    await iterator.return?.();
    await source.cancel?.();
    return undefined;
  }
}

type TextKindDecision = { kind?: "json" | "jsonl" | "ambiguous"; unsupported?: true };
type TextLineShape = "complete" | "continuous" | "invalid" | "incomplete" | "nonjson";

class TextKindDetector {
  readonly #lineParts: string[] = [];
  #first: string | undefined;
  #firstLine: Exclude<TextLineShape, "continuous" | "incomplete"> | undefined;

  push(text: string): TextKindDecision | undefined {
    let cursor = 0;
    for (;;) {
      const newline = text.indexOf("\n", cursor);
      if (newline < 0) {
        this.#append(text.slice(cursor));
        return undefined;
      }

      this.#append(text.slice(cursor, newline));
      const decision = this.#classifyLine();
      if (decision) return decision;
      this.#lineParts.length = 0;
      cursor = newline + 1;
    }
  }

  finish(text: string): TextKindDecision {
    const decision = this.push(text);
    if (decision) return decision;
    if (this.#lineParts.length > 0) {
      const finalLine = this.#classifyLine();
      if (finalLine) return finalLine;
    }
    if (this.#firstLine === "complete") return { kind: "jsonl" };
    if (this.#firstLine === "invalid") return { kind: "json" };
    if (this.#firstLine === "nonjson") return { unsupported: true };
    return this.fallback();
  }

  fallback(): TextKindDecision {
    return this.#first === "{" || this.#first === "["
      ? { kind: "json" }
      : { unsupported: true };
  }

  boundedFallback(): TextKindDecision {
    return this.#first === "{" || this.#first === "["
      ? { kind: "ambiguous" }
      : { unsupported: true };
  }

  #append(text: string): void {
    if (text) this.#lineParts.push(text);
    if (!this.#first) this.#first = /\S/.exec(text)?.[0];
  }

  #classifyLine(): TextKindDecision | undefined {
    const line = this.#lineParts.join("").replace(/\r$/, "");
    if (!line.trim()) return undefined;
    const shape = textLineShape(line);
    if (shape === "continuous") return { kind: "json" };
    if (shape === "incomplete") {
      return this.#firstLine === "invalid" || this.#firstLine === "nonjson"
        ? { kind: "jsonl" }
        : { kind: "json" };
    }
    if (!this.#firstLine) {
      this.#firstLine = shape;
      return undefined;
    }
    if (this.#firstLine === "complete") return { kind: "jsonl" };
    return shape === "nonjson" ? undefined : { kind: "jsonl" };
  }
}

function isCompleteJson(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

function textLineShape(text: string): TextLineShape {
  const first = text.trimStart()[0];
  if (first !== "{" && first !== "[") return "nonjson";
  if (isCompleteJson(text)) return "complete";

  let depth = 0;
  let inString = false;
  let escaped = false;
  let roots = 0;
  for (const character of text) {
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === "{" || character === "[") {
      if (depth === 0) roots += 1;
      depth += 1;
    }
    else if (character === "}" || character === "]") depth -= 1;
  }
  if (roots > 1) return "continuous";
  return !inString && depth <= 0 ? "invalid" : "incomplete";
}

function firstBytes(chunks: readonly Uint8Array[], count: number): Uint8Array {
  const result = new Uint8Array(Math.min(count, chunks.reduce((total, chunk) => total + chunk.byteLength, 0)));
  let offset = 0;
  for (const chunk of chunks) {
    const size = Math.min(chunk.byteLength, result.byteLength - offset);
    result.set(chunk.subarray(0, size), offset);
    offset += size;
    if (offset === result.byteLength) break;
  }
  return result;
}

async function* replayChunks(
  buffered: readonly Uint8Array[],
  iterator: AsyncIterator<Uint8Array>,
): AsyncGenerator<Uint8Array> {
  try {
    yield* buffered;
    for (;;) {
      const result = await iterator.next();
      if (result.done) return;
      yield result.value;
    }
  } finally {
    await iterator.return?.();
  }
}

async function* parseInputSource(
  source: DetectedInputSource,
  parseTokens: TokenParser,
  signal?: AbortSignal,
): AsyncGenerator<ParsedInputEvent> {
  if (source.kind === "jsonl" || source.kind === "ambiguous") {
    if (source.kind === "ambiguous") {
      for await (const record of ambiguousRecordSources(source, signal)) {
        yield* parseJsonDocuments(record, parseTokens, signal, record.line, true);
      }
      return;
    }

    let line = 0;
    for await (const lineBytes of splitLines(source.chunks, signal)) {
      line += 1;
      if (isBlank(lineBytes)) {
        continue;
      }
      const lineSource: InputSource = {
        name: source.name,
        path: source.path,
        chunks: oneChunk(lineBytes),
      };
      yield* parseJsonDocuments(lineSource, parseTokens, signal, line);
    }
    return;
  }

  yield* parseJsonDocuments(source, parseTokens, signal);
}

async function* parseJsonDocuments(
  source: InputSource,
  parseTokens: TokenParser,
  signal?: AbortSignal,
  line?: number,
  streamRoots = line === undefined,
): AsyncGenerator<ParsedInputEvent> {
  const pending: Array<{ value: unknown; sourcePath: string; inputFormat?: InputFormat }> = [];
  let documentIndex = 1;
  let itemIndex = 0;
  let emittedFromContainer = 0;

  const emitValue = (value: unknown, inputFormat?: InputFormat) => {
    itemIndex += 1;
    const sourcePath = itemIndex === 1 ? source.path : `${source.path}#${itemIndex}`;
    pending.push({
      value,
      sourcePath,
      inputFormat,
    });
    emittedFromContainer += 1;
  };

  type RootObject = { record: Record<string, unknown> };
  const assembler = new FlexAssembler<unknown>({
    arrayRules: [
      arrayRule<undefined>({
        filter: (path) => path.length === 0,
        create: () => undefined,
        add: (_container, value) => emitValue(value),
      }),
      arrayRule<unknown[]>({
        filter: (path) => path.length === 1 && path[0] === "accounts",
        create: () => [],
        add: (container, value) => {
          if (isSub2ApiAccount(value)) {
            emitValue(value, "sub2api");
          } else {
            container.push(value);
          }
        },
      }),
    ],
    objectRules: [
      objectRule<RootObject>({
        filter: (path) => path.length === 0,
        create: () => ({ record: {} }),
        add: (container, key, value) => {
          if (key.startsWith(`${XAI_ISSUER}::`) && isRecord(value)) {
            emitValue({ [key]: value }, "grok");
            return;
          }
          container.record[key] = value;
        },
        finalize: (container) => container.record,
      }),
    ],
  });

  let rootStarted = false;
  try {
    const tokenChunks = line === undefined ? frameJsonRoots(source.chunks, signal) : source.chunks;
    for await (const tokens of parseTokens(tokenChunks, { jsonStreaming: streamRoots, signal })) {
      throwIfAborted(signal);
      for (const token of tokens) {
        if (assembler.done && isValueStart(token)) {
          rootStarted = true;
          itemIndex = 0;
          emittedFromContainer = 0;
        }
        assembler.consume(token);
        if (rootStarted && assembler.done) {
          if (emittedFromContainer === 0 && isRecord(assembler.current)) {
            emitValue(assembler.current);
          }
          if (pending.length > 0) yield takePendingValues();
          yield {
            type: "commit",
            batchId: sourceBatchId(source.path, line, documentIndex),
            sourceName: source.name,
            sourcePath: source.path,
          };
          documentIndex += 1;
          rootStarted = false;
        }
      }
      if (pending.length > 0) yield takePendingValues();
    }
  } catch (error) {
    if (isAbortError(error)) throw error;
    if (isSystemIoError(error)) throw error;
    if (error instanceof ZipReadError) throw error;
    yield {
      type: "discard",
      batchId: sourceBatchId(source.path, line, documentIndex),
      diagnostic: {
        code: "json_parse_failed",
        sourceName: source.name,
        sourcePath: source.path,
        line,
        detail: errorMessage(error),
      },
    };
  }

  function takePendingValues(): ParsedInputEvent {
    return {
      type: "values",
      batchId: sourceBatchId(source.path, line, documentIndex),
      sourceName: source.name,
      items: pending.splice(0),
    };
  }
}

function isValueStart(token: Token): boolean {
  return token.name === "startObject" || token.name === "startArray" || token.name === "stringValue" ||
    token.name === "numberValue" || token.name === "nullValue" || token.name === "trueValue" || token.name === "falseValue";
}

function isSub2ApiAccount(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && (isRecord(value.credentials) || typeof value.platform === "string");
}

async function* zipEntrySources(
  source: DetectedInputSource,
  signal?: AbortSignal,
): AsyncGenerator<InputSource> {
  /*
   * One source reader feeds fflate, each selected entry owns one bounded byte
   * queue, and an early entry failure cancels both the reader and every queue.
   */
  const entries = new AsyncQueue<InputSource>();
  const active = new Set<ByteQueue>();
  const budget = new ByteBudget();
  const endRecord = new ZipEndRecordTracker();
  const sourceIterator = source.chunks[Symbol.asyncIterator]();
  let currentFile: UnzipFile | undefined;
  let stopping = false;
  let pumpFinished = false;
  const unzip = new Unzip((file) => {
    currentFile = file;
    const entryPath = normalizeArchiveEntryPath(file.name);
    if (!entryPath || entryPath.endsWith("/") || isIgnoredArchivePath(entryPath)) {
      file.ondata = () => undefined;
      file.start();
      return;
    }

    const queue = new ByteQueue(budget, () => active.delete(queue));
    active.add(queue);
    file.ondata = (error, chunk, final) => {
      if (error) {
        queue.fail(new ZipReadError(error));
        return;
      }
      if (chunk?.length) {
        queue.push(chunk);
      }
      if (final) {
        queue.close();
      }
    };
    entries.push({
      name: `${source.name}/${entryPath}`,
      path: `${source.path.replace(/\/+$/g, "")}/${entryPath}`,
      chunks: queue,
      cancel: (reason) => queue.fail(reason),
    });
    file.start();
  });
  unzip.register(UnzipInflate);

  const pump = (async () => {
    try {
      for (;;) {
        const result = await sourceIterator.next();
        if (result.done || stopping) break;
        const chunk = result.value;
        throwIfAborted(signal);
        endRecord.push(chunk);
        unzip.push(chunk, false);
        await budget.waitBelow(STREAM_BUFFER_LIMIT);
      }
      if (stopping) return;
      unzip.push(new Uint8Array(), true);
      if (!endRecord.hasValidEndRecord()) {
        throw new ZipReadError("Invalid ZIP end record");
      }
      entries.close();
    } catch (error) {
      currentFile?.terminate();
      budget.clear();
      for (const queue of active) {
        queue.fail(error);
      }
      entries.fail(error);
    } finally {
      if (stopping) await sourceIterator.return?.();
      pumpFinished = true;
    }
  })();

  try {
    yield* entries;
    await pump;
  } finally {
    if (!pumpFinished) {
      stopping = true;
      currentFile?.terminate();
      budget.clear();
      const reason = signal?.reason ?? new DOMException("ZIP consumption stopped", "AbortError");
      for (const queue of active) queue.fail(reason);
      entries.fail(reason);
      await source.cancel?.(reason);
      await pump;
    }
  }
}

async function* splitLines(chunks: AsyncIterable<Uint8Array>, signal?: AbortSignal): AsyncGenerator<Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let pending = "";
  for await (const chunk of chunks) {
    throwIfAborted(signal);
    pending += decoder.decode(chunk, { stream: true });
    let newline = pending.indexOf("\n");
    while (newline >= 0) {
      const line = pending.slice(0, newline).replace(/\r$/, "");
      pending = pending.slice(newline + 1);
      yield encoder.encode(line);
      newline = pending.indexOf("\n");
    }
  }
  pending += decoder.decode();
  if (pending.length > 0) {
    yield encoder.encode(pending.replace(/\r$/, ""));
  }
}

async function* ambiguousRecordSources(
  source: InputSource,
  signal?: AbortSignal,
): AsyncGenerator<InputSource & { line: number }> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const records = new AsyncQueue<InputSource & { line: number }>();
  const active = new Set<ByteQueue>();
  const budget = new ByteBudget();
  const sourceIterator = source.chunks[Symbol.asyncIterator]();
  let current: ByteQueue | undefined;
  let currentLine = 1;
  let depth = 0;
  let inString = false;
  let escaped = false;
  let stopping = false;
  let pumpFinished = false;

  const pump = (async () => {
    try {
      for (;;) {
        const result = await sourceIterator.next();
        if (result.done || stopping) break;
        throwIfAborted(signal);
        await scan(decoder.decode(result.value, { stream: true }));
      }
      if (stopping) return;
      await scan(decoder.decode());
      current?.close();
      records.close();
    } catch (error) {
      budget.clear();
      for (const queue of active) queue.fail(error);
      records.fail(error);
    } finally {
      if (stopping) await sourceIterator.return?.();
      pumpFinished = true;
    }
  })();

  try {
    yield* records;
    await pump;
  } finally {
    if (!pumpFinished) {
      stopping = true;
      budget.clear();
      const reason = signal?.reason ?? new DOMException("JSON consumption stopped", "AbortError");
      for (const queue of active) queue.fail(reason);
      records.fail(reason);
      await source.cancel?.(reason);
      await pump;
    }
  }

  async function scan(text: string): Promise<void> {
    let segmentStart = 0;
    for (let index = 0; index < text.length; index += 1) {
      const character = text[index];
      if (!current) {
        if (isJsonWhitespace(character.charCodeAt(0))) {
          if (character === "\n") currentLine += 1;
          segmentStart = index + 1;
          continue;
        }
        current = createRecord(currentLine);
        segmentStart = index;
      }
      if (character === "\n") {
        currentLine += 1;
        if (!inString && depth === 0) {
          const end = index > segmentStart && text[index - 1] === "\r" ? index - 1 : index;
          pushText(text.slice(segmentStart, end));
          current.close();
          current = undefined;
          segmentStart = index + 1;
        }
        continue;
      }
      if (inString) {
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === '"') inString = false;
        continue;
      }
      if (character === '"') inString = true;
      else if (character === "{" || character === "[") depth += 1;
      else if (character === "}" || character === "]") depth = Math.max(0, depth - 1);
    }
    if (current && segmentStart < text.length) pushText(text.slice(segmentStart));
    await budget.waitBelow(STREAM_BUFFER_LIMIT);
  }

  function createRecord(line: number): ByteQueue {
    const queue = new ByteQueue(budget, () => active.delete(queue));
    active.add(queue);
    records.push({
      name: source.name,
      path: source.path,
      line,
      chunks: queue,
      cancel: (reason) => queue.fail(reason),
    });
    return queue;
  }

  function pushText(text: string): void {
    if (text) current?.push(encoder.encode(text));
  }
}

async function* frameJsonRoots(
  chunks: AsyncIterable<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  const structural = /["\\{}\[\]]/g;
  let started = false;
  let container = false;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for await (const chunk of chunks) {
    throwIfAborted(signal);
    yield* scan(decoder.decode(chunk, { stream: true }));
  }
  yield* scan(decoder.decode());

  function* scan(text: string): Generator<string> {
    if (!text) return;
    let cursor = 0;
    let partStart = 0;
    if (inString && escaped) {
      escaped = false;
      cursor = 1;
    }

    while (cursor < text.length) {
      if (!started) {
        while (cursor < text.length && isJsonWhitespace(text.charCodeAt(cursor))) cursor += 1;
        if (cursor >= text.length) break;
        const code = text.charCodeAt(cursor);
        started = true;
        container = code === 0x7b || code === 0x5b;
        depth = container ? 1 : 0;
        inString = code === 0x22;
        escaped = false;
        cursor += 1;
        continue;
      }

      if (!container && !inString) {
        while (cursor < text.length && !isJsonWhitespace(text.charCodeAt(cursor))) cursor += 1;
        if (cursor >= text.length) break;
        if (cursor > partStart) yield text.slice(partStart, cursor);
        partStart = cursor;
        started = false;
        continue;
      }

      structural.lastIndex = cursor;
      const match = structural.exec(text);
      if (!match) break;
      const index = match.index;
      const code = text.charCodeAt(index);
      cursor = index + 1;

      if (inString) {
        if (code === 0x5c) {
          if (cursor >= text.length) escaped = true;
          else cursor += 1;
        } else if (code === 0x22) {
          inString = false;
        }
        continue;
      }
      if (code === 0x22) {
        inString = true;
        continue;
      }
      if (code === 0x7b || code === 0x5b) depth += 1;
      else if (code === 0x7d || code === 0x5d) depth -= 1;
      if (depth !== 0) continue;

      if (cursor > partStart) yield text.slice(partStart, cursor);
      partStart = cursor;
      started = false;
      container = false;
      inString = false;
    }

    if (partStart < text.length) yield text.slice(partStart);
  }
}

function isJsonWhitespace(code: number): boolean {
  return code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d;
}

class AsyncQueue<T> implements AsyncIterable<T> {
  readonly #values: T[] = [];
  readonly #waiters: Array<{ resolve: (result: IteratorResult<T>) => void; reject: (error: unknown) => void }> = [];
  #closed = false;
  #error: unknown;

  push(value: T): void {
    if (this.#closed || this.#error) return;
    const waiter = this.#waiters.shift();
    if (waiter) waiter.resolve({ done: false, value });
    else this.#values.push(value);
  }

  close(): void {
    if (this.#closed || this.#error) return;
    this.#closed = true;
    for (const waiter of this.#waiters.splice(0)) waiter.resolve({ done: true, value: undefined });
  }

  fail(error: unknown): void {
    if (this.#closed || this.#error) return;
    this.#error = error;
    for (const waiter of this.#waiters.splice(0)) waiter.reject(error);
  }

  protected drain(): T[] {
    return this.#values.splice(0);
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        const value = this.#values.shift();
        if (value !== undefined) return Promise.resolve({ done: false, value });
        if (this.#error) return Promise.reject(this.#error);
        if (this.#closed) return Promise.resolve({ done: true, value: undefined });
        return new Promise<IteratorResult<T>>((resolve, reject) => this.#waiters.push({ resolve, reject }));
      },
    };
  }
}

class ByteQueue extends AsyncQueue<Uint8Array> {
  readonly #budget: ByteBudget;
  readonly #onClose: () => void;
  #discarded = false;
  #released = false;

  constructor(budget: ByteBudget, onClose: () => void) {
    super();
    this.#budget = budget;
    this.#onClose = onClose;
  }

  override push(value: Uint8Array): void {
    if (this.#discarded) return;
    this.#budget.add(value.byteLength);
    super.push(value);
  }

  override close(): void {
    this.#release();
    super.close();
  }

  override fail(error: unknown): void {
    this.#release();
    super.fail(error);
  }

  override [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
    const iterator = super[Symbol.asyncIterator]();
    return {
      next: async () => {
        const result = await iterator.next();
        if (!result.done) {
          this.#budget.consume(result.value.byteLength);
        }
        return result;
      },
      return: async () => {
        this.#discarded = true;
        const buffered = this.drain();
        const bufferedBytes = buffered.reduce((total, chunk) => total + chunk.byteLength, 0);
        if (bufferedBytes > 0) this.#budget.consume(bufferedBytes);
        this.#release();
        super.close();
        return { done: true, value: undefined };
      },
    };
  }

  #release(): void {
    if (this.#released) return;
    this.#released = true;
    this.#onClose();
  }
}

class ByteBudget {
  #bytes = 0;
  readonly #waiters: Array<() => void> = [];

  add(size: number): void {
    this.#bytes += size;
  }

  consume(size: number): void {
    this.#bytes -= size;
    this.#notify();
  }

  waitBelow(limit: number): Promise<void> {
    if (this.#bytes <= limit) return Promise.resolve();
    return new Promise((resolve) => this.#waiters.push(resolve));
  }

  clear(): void {
    this.#bytes = 0;
    this.#notify();
  }

  #notify(): void {
    if (this.#bytes > STREAM_BUFFER_LIMIT) return;
    for (const resolve of this.#waiters.splice(0)) resolve();
  }
}

class ZipEndRecordTracker {
  readonly #buffer = new Uint8Array(ZIP_END_RECORD_LIMIT);
  #length = 0;
  #writeOffset = 0;

  push(chunk: Uint8Array): void {
    if (chunk.byteLength >= ZIP_END_RECORD_LIMIT) {
      this.#buffer.set(chunk.subarray(chunk.byteLength - ZIP_END_RECORD_LIMIT));
      this.#length = ZIP_END_RECORD_LIMIT;
      this.#writeOffset = 0;
      return;
    }
    const first = Math.min(chunk.byteLength, ZIP_END_RECORD_LIMIT - this.#writeOffset);
    this.#buffer.set(chunk.subarray(0, first), this.#writeOffset);
    if (first < chunk.byteLength) this.#buffer.set(chunk.subarray(first), 0);
    this.#writeOffset = (this.#writeOffset + chunk.byteLength) % ZIP_END_RECORD_LIMIT;
    this.#length = Math.min(ZIP_END_RECORD_LIMIT, this.#length + chunk.byteLength);
  }

  hasValidEndRecord(): boolean {
    const tail = this.#snapshot();
    const view = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
    for (let offset = tail.byteLength - 22; offset >= 0; offset -= 1) {
      if (view.getUint32(offset, true) !== 0x06054b50) continue;
      const commentLength = view.getUint16(offset + 20, true);
      if (offset + 22 + commentLength === tail.byteLength) return true;
    }
    return false;
  }

  #snapshot(): Uint8Array {
    if (this.#length < ZIP_END_RECORD_LIMIT) return this.#buffer.slice(0, this.#length);
    const tail = new Uint8Array(this.#length);
    const first = this.#buffer.subarray(this.#writeOffset);
    tail.set(first);
    tail.set(this.#buffer.subarray(0, this.#writeOffset), first.byteLength);
    return tail;
  }
}

function zipFailure(source: InputSource, error: unknown): ParsedInputEvent {
  return {
    type: "discard",
    batchId: `${source.path}::zip`,
    diagnostic: {
      code: "zip_read_failed",
      sourceName: source.name,
      sourcePath: source.path,
      detail: errorMessage(error),
    },
  };
}

function sourceBatchId(path: string, line: number | undefined, document: number): string {
  return `${path}::${line === undefined ? "document" : `line:${line}`}::${document}`;
}

function isIgnoredArchivePath(value: string): boolean {
  return value.split("/").some((segment) => segment === "__MACOSX" || segment.startsWith("."));
}

function normalizeArchiveEntryPath(value: string): string {
  return value.replace(/\\/g, "/").split("/").filter((segment) => segment && segment !== "." && segment !== "..").join("/");
}

function isBlank(bytes: Uint8Array): boolean {
  return new TextDecoder().decode(bytes).trim().length === 0;
}

async function* oneChunk(chunk: Uint8Array): AsyncGenerator<Uint8Array> {
  yield chunk;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
}
function isSystemIoError(error: unknown): error is Error & { code: string } {
  return error instanceof Error && "code" in error && typeof (error as { code?: unknown }).code === "string";
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

class ZipReadError extends Error {
  constructor(error: unknown) {
    super(errorMessage(error));
    this.name = "ZipReadError";
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
