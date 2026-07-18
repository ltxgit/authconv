import { AccountStore, type AccountStoreCommit } from "./account-store.js";
import { parseInputSources, type TokenParser } from "./input.js";
import { extractCandidatesFromValue, normalizeCandidate } from "./normalize.js";
import { applyAccessTokenVerification, TokenVerifier } from "./token-verification.js";
import type {
  IngestionDiagnostic,
  InputFormat,
  InputSource,
  NormalizedAccount,
} from "./types.js";

export type IngestionProgress = {
  phase: "parse" | "normalize" | "verify" | "store";
  processedSources: number;
  processedCandidates: number;
  verifiedCandidates: number;
  storedAccounts: number;
};

export type IngestionOptions = {
  parseTokens: TokenParser;
  inputFormat?: InputFormat;
  signal?: AbortSignal;
  onProgress?: (progress: IngestionProgress) => void;
  yieldControl?: () => Promise<void>;
  verifyTokens?: boolean;
  tokenVerifier?: TokenVerifier;
  discardForged?: boolean;
  commit?: boolean;
  onCheckpoint?: (checkpoint: IngestionCheckpoint) => void;
};

export type IngestionCheckpoint = {
  diagnosticsAdded: IngestionDiagnostic[];
  inputFormat: InputFormat;
  storeChanges: AccountStoreCommit;
};

export type IngestionResult = {
  store: AccountStore;
  diagnostics: IngestionDiagnostic[];
  inputFormat: InputFormat;
  processedSources: number;
  processedCandidates: number;
  previewAccounts: NormalizedAccount[];
  storeChanges: AccountStoreCommit;
};

type SourceBatch = {
  accounts: NormalizedAccount[];
  formats: Set<InputFormat>;
};

export async function ingestSources(
  sources: Iterable<InputSource> | AsyncIterable<InputSource>,
  store: AccountStore,
  options: IngestionOptions,
): Promise<IngestionResult> {
  const diagnostics: IngestionDiagnostic[] = [];
  const batches = new Map<string, SourceBatch>();
  const committedFormats = new Set<InputFormat>();
  const previewAccounts: NormalizedAccount[] = [];
  const storeChanges: AccountStoreCommit = { processed: 0, added: 0, merged: 0, skippedForged: 0 };
  let processedSources = 0;
  let processedCandidates = 0;
  let verifiedCandidates = 0;
  let checkpointDiagnosticCount = 0;
  const verifier = options.tokenVerifier ?? new TokenVerifier();

  try {
    for await (const event of parseInputSources(sources, options.parseTokens, options.signal)) {
      throwIfAborted(options.signal);
      if (event.type === "discard") {
        batches.delete(event.batchId);
        diagnostics.push(event.diagnostic);
        publishCheckpoint();
        report("parse");
        continue;
      }

      if (event.type === "commit") {
        const batch = batches.get(event.batchId);
        batches.delete(event.batchId);
        processedSources += 1;
        if (batch) {
          const verificationBase = verifiedCandidates;
          const results = await verifier.verifyAccounts(batch.accounts, {
            verify: options.verifyTokens !== false,
            signal: options.signal,
            yieldControl: options.yieldControl,
            onProgress: (completed) => {
              verifiedCandidates = verificationBase + completed;
              report("verify");
            },
          });
          for (let index = 0; index < batch.accounts.length; index += 1) {
            applyAccessTokenVerification(batch.accounts[index], results[index]);
          }
          const acceptedAccounts = options.discardForged
            ? batch.accounts.filter((account) => account.tokenVerification?.status !== "forged")
            : batch.accounts;
          if (options.commit === false) {
            for (const account of acceptedAccounts) previewAccounts.push(account);
          }
          else {
            const changes = commitIngestedAccounts(store, batch.accounts, options.discardForged === true);
            mergeStoreChanges(storeChanges, changes);
          }
          for (const format of batch.formats) committedFormats.add(format);
        }
        publishCheckpoint();
        report("store");
        continue;
      }

      const batch = batches.get(event.batchId) ?? { accounts: [], formats: new Set<InputFormat>() };
      batches.set(event.batchId, batch);
      for (const item of event.items) {
        const selectedFormat = options.inputFormat && options.inputFormat !== "unknown"
          ? options.inputFormat
          : item.inputFormat;
        const candidates = extractCandidatesFromValue(
          item.value,
          { sourceName: event.sourceName, sourcePath: item.sourcePath },
          selectedFormat,
        );
        if (candidates.length === 0) {
          diagnostics.push({
            code: selectedFormat ? "input_format_mismatch" : "no_credential_tokens",
            sourceName: event.sourceName,
            sourcePath: item.sourcePath,
            detail: selectedFormat,
          });
          continue;
        }

        for (const candidate of candidates) {
          processedCandidates += 1;
          if (options.yieldControl && processedCandidates % 512 === 0) {
            await options.yieldControl();
            throwIfAborted(options.signal);
          }
          const account = normalizeCandidate(candidate, processedCandidates - 1);
          if (!account) {
            diagnostics.push({
              code: "no_credential_tokens",
              sourceName: candidate.sourceName,
              sourcePath: candidate.sourcePath,
            });
            continue;
          }
          batch.accounts.push(account);
          batch.formats.add(candidate.inputFormat);
        }
      }
      report("normalize");
    }

    if (processedSources === 0 && diagnostics.length === 0) {
      diagnostics.push({
        code: "unsupported_input",
        sourceName: "input",
        sourcePath: "input",
      });
    }

    return {
      store,
      diagnostics,
      inputFormat: commonInputFormat(committedFormats),
      processedSources,
      processedCandidates,
      previewAccounts,
      storeChanges,
    };
  } finally {
    verifier.clearResultCache();
  }

  function report(phase: IngestionProgress["phase"]): void {
    options.onProgress?.({
      phase,
      processedSources,
      processedCandidates,
      verifiedCandidates,
      storedAccounts: store.size,
    });
  }


  function publishCheckpoint(): void {
    if (options.commit === false || !options.onCheckpoint) return;
    const diagnosticsAdded = diagnostics.slice(checkpointDiagnosticCount);
    checkpointDiagnosticCount = diagnostics.length;
    options.onCheckpoint({
      diagnosticsAdded,
      inputFormat: commonInputFormat(committedFormats),
      storeChanges: { ...storeChanges },
    });
  }
}

export function commitIngestedAccounts(
  store: AccountStore,
  accounts: readonly NormalizedAccount[],
  discardForged: boolean,
): AccountStoreCommit {
  const accepted = discardForged
    ? accounts.filter((account) => account.tokenVerification?.status !== "forged")
    : accounts;
  const changes = store.commitSource(accepted);
  changes.processed = accounts.length;
  changes.skippedForged = accounts.length - accepted.length;
  return changes;
}

function mergeStoreChanges(target: AccountStoreCommit, source: AccountStoreCommit): void {
  target.processed += source.processed;
  target.added += source.added;
  target.merged += source.merged;
  target.skippedForged += source.skippedForged;
  target.firstAffectedId ??= source.firstAffectedId;
}

function commonInputFormat(formats: Set<InputFormat>): InputFormat {
  if (formats.size !== 1) return "unknown";
  return formats.values().next().value ?? "unknown";
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
}
