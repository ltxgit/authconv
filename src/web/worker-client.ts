import type {
  AccountScope,
  WorkerFile,
  WorkerProgress,
  WorkerRequest,
  WorkerResponse,
  WorkerSummary,
} from "./worker-protocol.js";
import type { InputFormat, OutputFormat, OutputModes, OutputTextMode } from "../types.js";

declare const __AUTHCONV_WORKER_SOURCE_BASE64__: string;

type WorkerRequestWithoutId = WorkerRequest extends infer Request
  ? Request extends { requestId: number }
    ? Omit<Request, "requestId">
    : never
  : never;

export type WorkerClientResponse = Exclude<WorkerResponse, { type: "exportResult" }> |
  (Extract<WorkerResponse, { type: "exportResult" }> & { exportBlob: Blob });

export type WorkerRequestError = Error & { summary?: WorkerSummary };

type Pending = {
  resolve: (value: WorkerClientResponse) => void;
  reject: (error: Error) => void;
  chunks: BlobPart[];
  onProgress?: (progress: WorkerProgress) => void;
};

export class AuthconvWorkerClient {
  readonly #worker: Worker;
  readonly #workerUrl: string;
  readonly #pending = new Map<number, Pending>();
  #nextRequestId = 1;

  constructor() {
    const workerBytes = Uint8Array.from(atob(__AUTHCONV_WORKER_SOURCE_BASE64__), (character) => character.charCodeAt(0));
    this.#workerUrl = URL.createObjectURL(new Blob([workerBytes], { type: "text/javascript" }));
    this.#worker = new Worker(this.#workerUrl, { name: "authconv-worker" });
    this.#worker.addEventListener("message", (event: MessageEvent<WorkerResponse>) => this.#receive(event.data));
    this.#worker.addEventListener("error", (event) => {
      const error = new Error(event.message || "Auth Converter Worker failed");
      for (const pending of this.#pending.values()) pending.reject(error);
      this.#pending.clear();
    });
  }

  previewText(text: string, inputFormat: InputFormat | undefined, verifyTokens: boolean, onProgress?: Pending["onProgress"]) {
    return this.#send({ type: "previewText", text, inputFormat, verifyTokens }, onProgress);
  }

  discardDraft() {
    return this.#send({ type: "discardDraft" });
  }

  commitDraft(verifyTokens: boolean, onProgress?: Pending["onProgress"]) {
    return this.#send({ type: "commitDraft", verifyTokens }, onProgress);
  }

  importFiles(files: WorkerFile[], verifyTokens: boolean, onProgress?: Pending["onProgress"]) {
    return this.#send({ type: "importFiles", files, verifyTokens }, onProgress);
  }

  reverify(selectedAccountId?: string, onProgress?: Pending["onProgress"]) {
    return this.#send({ type: "reverify", selectedAccountId }, onProgress);
  }

  range(scope: AccountScope, offset: number, limit: number, query: string) {
    return this.#send({ type: "range", scope, offset, limit, query });
  }

  remove(id: string) {
    return this.#send({ type: "remove", id });
  }

  clear() {
    return this.#send({ type: "clear" });
  }

  preview(options: {
    formats: OutputFormat[];
    previewFormat: OutputFormat;
    outputModes: OutputModes;
    textMode: OutputTextMode;
    selectedAccountId?: string | null;
    includeRefreshToken: boolean;
    allowSyntheticIdToken: boolean;
    verifyTokens: boolean;
  }) {
    return this.#send({ type: "preview", ...options });
  }

  decodeJwt(token: string) {
    return this.#send({ type: "decodeJwt", token });
  }

  export(options: {
    formats: OutputFormat[];
    outputModes: OutputModes;
    textMode: OutputTextMode;
    includeRefreshToken: boolean;
    allowSyntheticIdToken: boolean;
    verifyTokens: boolean;
  }, onProgress?: Pending["onProgress"]) {
    return this.#send({ type: "export", ...options }, onProgress);
  }

  cancel() {
    return this.#send({ type: "cancel" });
  }

  destroy(): void {
    this.#worker.terminate();
    URL.revokeObjectURL(this.#workerUrl);
    this.#pending.clear();
  }

  #send(
    request: WorkerRequestWithoutId,
    onProgress?: Pending["onProgress"],
  ): Promise<WorkerClientResponse> {
    const requestId = this.#nextRequestId;
    this.#nextRequestId += 1;
    return new Promise((resolve, reject) => {
      this.#pending.set(requestId, { resolve, reject, chunks: [], onProgress });
      this.#worker.postMessage({ ...request, requestId } as WorkerRequest);
    });
  }

  #receive(message: WorkerResponse): void {
    const pending = this.#pending.get(message.requestId);
    if (!pending) return;
    if (message.type === "progress") {
      pending.onProgress?.(message);
      return;
    }
    if (message.type === "exportChunk") {
      pending.chunks.push(message.chunk);
      return;
    }
    this.#pending.delete(message.requestId);
    if (message.type === "error") {
      const error: WorkerRequestError = new Error(message.message);
      error.name = message.cancelled ? "AbortError" : "Error";
      error.summary = message.summary;
      pending.reject(error);
      return;
    }
    if (message.type === "exportResult") {
      pending.resolve({ ...message, exportBlob: new Blob(pending.chunks, { type: message.mime }) });
      return;
    }
    pending.resolve(message);
  }
}
