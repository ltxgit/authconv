import type { AccountListItem, AccountStoreCommit, AccountStoreSummary } from "../account-store.js";
import type {
  IngestionDiagnostic,
  InputFormat,
  OutputFormat,
  OutputModes,
  OutputTextMode,
  TokenVerification,
} from "../types.js";

export type WorkerFile = { file: File; path: string };
export type AccountScope = "loaded" | "draft";
export type WorkerTaskKind = "previewText" | "preview" | "commitDraft" | "importFiles" | "reverify" | "export";
export type WorkerOutputPlan = {
  accountCount: number;
  fileCount: number;
  formats: OutputFormat[];
  rejectedAccountCount: number;
  outputType: "json" | "jsonl" | "zip";
};

export type WorkerRequest =
  | { type: "previewText"; requestId: number; text: string; inputFormat?: InputFormat; verifyTokens: boolean }
  | { type: "discardDraft"; requestId: number }
  | { type: "commitDraft"; requestId: number; verifyTokens: boolean }
  | { type: "importFiles"; requestId: number; files: WorkerFile[]; verifyTokens: boolean }
  | { type: "reverify"; requestId: number; selectedAccountId?: string }
  | { type: "range"; requestId: number; scope: AccountScope; offset: number; limit: number; query: string }
  | { type: "remove"; requestId: number; id: string }
  | { type: "clear"; requestId: number }
  | {
      type: "preview";
      requestId: number;
      formats: OutputFormat[];
      previewFormat: OutputFormat;
      outputModes: OutputModes;
      textMode: OutputTextMode;
      selectedAccountId?: string | null;
      includeRefreshToken: boolean;
      allowSyntheticIdToken: boolean;
      verifyTokens: boolean;
    }
  | { type: "decodeJwt"; requestId: number; token: string }
  | {
      type: "export";
      requestId: number;
      formats: OutputFormat[];
      outputModes: OutputModes;
      textMode: OutputTextMode;
      includeRefreshToken: boolean;
      allowSyntheticIdToken: boolean;
      verifyTokens: boolean;
    }
  | { type: "cancel"; requestId: number };

export type WorkerSummary = {
  scope: AccountScope;
  loaded: AccountStoreSummary;
  active: AccountStoreSummary;
  applicableFormats: OutputFormat[];
  diagnostics: IngestionDiagnostic[];
  inputFormat: InputFormat;
};

export type WorkerProgress = {
  type: "progress";
  requestId: number;
  phase: "parse" | "normalize" | "verify" | "store" | "export";
  completed: number;
  total?: number;
};

export type WorkerResponse =
  | WorkerProgress
  | { type: "previewTextResult"; requestId: number; summary: WorkerSummary }
  | { type: "discardDraftResult"; requestId: number; summary: WorkerSummary }
  | {
      type: "commitDraftResult";
      requestId: number;
      summary: WorkerSummary;
      stats: AccountStoreCommit;
    }
  | {
      type: "importFilesResult";
      requestId: number;
      summary: WorkerSummary;
      stats: AccountStoreCommit;
    }
  | { type: "reverifyResult"; requestId: number; summary: WorkerSummary; selectedAccountRemoved: boolean }
  | { type: "rangeResult"; requestId: number; total: number; offset: number; items: AccountListItem[] }
  | { type: "removeResult"; requestId: number; summary: WorkerSummary; suggestedAccountId?: string }
  | { type: "clearResult"; requestId: number; summary: WorkerSummary }
  | {
      type: "previewResult";
      requestId: number;
      text: string;
      path: string;
      shownAccounts: number;
      totalAccounts: number;
      format?: OutputFormat;
      selectedAccountId?: string;
      outputPlan: WorkerOutputPlan;
      blockedVerification?: TokenVerification;
    }
  | { type: "decodeJwtResult"; requestId: number; text?: string }
  | { type: "exportChunk"; requestId: number; chunk: ArrayBuffer }
  | { type: "exportResult"; requestId: number; name: string; mime: string; accountCount: number }
  | { type: "cancelResult"; requestId: number; summary: WorkerSummary; cancelledTask?: WorkerTaskKind }
  | { type: "error"; requestId: number; message: string; cancelled?: boolean; summary?: WorkerSummary };
