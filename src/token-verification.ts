import openAiJwks from "./jwks/openai.json" with { type: "json" };
import xaiJwks from "./jwks/xai.json" with { type: "json" };
import { isRecord } from "./object.js";
import type {
  NormalizedAccount,
  Provider,
  TokenVerification,
  TokenVerificationContext,
} from "./types.js";
import { XAI_ACCESS_TOKEN_TYPE } from "./xai.js";

export type SupportedTokenAlgorithm = "RS256" | "ES256";

export type JsonWebKeySet = {
  keys: VerificationJwk[];
};

export type VerificationJwk = JsonWebKey & {
  kid?: string;
  alg?: string;
  use?: string;
};

export type TokenVerificationContract = {
  provider: "openai" | "xai";
  issuer: string;
  algorithm: SupportedTokenAlgorithm;
  expectedAudience?: string;
  jwks: JsonWebKeySet;
};

export type AccessTokenVerification = {
  verification: TokenVerification;
  context: TokenVerificationContext;
};

export type VerifyAccountOptions = {
  verify?: boolean;
  now?: number;
  reuseExisting?: boolean;
};

export type VerifyAccountsOptions = VerifyAccountOptions & {
  concurrency?: number;
  signal?: AbortSignal;
  onProgress?: (completed: number, total: number) => void;
  yieldControl?: () => Promise<void>;
};

const OPENAI_CONTRACT = {
  provider: "openai",
  issuer: "https://auth.openai.com",
  algorithm: "RS256",
  expectedAudience: "https://api.openai.com/v1",
  jwks: openAiJwks,
} satisfies TokenVerificationContract;

const XAI_CONTRACT = {
  provider: "xai",
  issuer: "https://auth.x.ai",
  algorithm: "ES256",
  jwks: xaiJwks,
} satisfies TokenVerificationContract;

const DEFAULT_CONCURRENCY = 32;
const PROGRESS_INTERVAL = 250;

export const TOKEN_VERIFICATION_SOURCES = {
  openai: {
    discoveryUrl: "https://auth.openai.com/.well-known/openid-configuration",
    jwksUrl: "https://auth.openai.com/.well-known/jwks.json",
    snapshotDate: "2026-07-17",
  },
  xai: {
    discoveryUrl: "https://auth.x.ai/.well-known/openid-configuration",
    jwksUrl: "https://auth.x.ai/.well-known/jwks.json",
    snapshotDate: "2026-07-17",
  },
} as const;

export class TokenVerifier {
  readonly #keyCache = new Map<string, Promise<CryptoKey>>();
  readonly #resultCache = new Map<string, Map<string, Promise<AccessTokenVerification>>>();
  readonly #contractIds = new WeakMap<object, number>();
  #nextContractId = 1;

  verifyAccount(
    account: NormalizedAccount,
    options: VerifyAccountOptions = {},
  ): Promise<AccessTokenVerification> {
    if (options.verify === false) {
      return Promise.resolve(unchecked(account));
    }
    if (options.reuseExisting) {
      const existing = reusableAccessTokenVerification(account, options.now);
      if (existing) return Promise.resolve(existing);
    }
    if (account.provider === "unknown") {
      return Promise.resolve(classified(account.provider, "unverifiable", "unknown_provider"));
    }
    if (!account.accessToken) {
      return Promise.resolve(classified(account.provider, "unverifiable", "missing_access_token"));
    }
    if (!looksLikeJwt(account.accessToken)) {
      return Promise.resolve(classified(account.provider, "unverifiable", "opaque_access_token"));
    }

    const contract = contractFor(account);
    return this.verifyToken(account.accessToken, contract, options);
  }

  verifyToken(
    token: string,
    contract: TokenVerificationContract,
    options: VerifyAccountOptions = {},
  ): Promise<AccessTokenVerification> {
    const contractId = this.#contractId(contract);
    const contextKey = [
      contract.provider,
      contract.issuer,
      contract.algorithm,
      contract.expectedAudience ?? "",
      contractId,
    ].join("\n");
    let byContext = this.#resultCache.get(token);
    if (!byContext) {
      byContext = new Map();
      this.#resultCache.set(token, byContext);
    }
    let result = byContext.get(contextKey);
    if (!result) {
      result = verifyWithCaches(token, contract, options.now ?? Date.now(), contractId, this.#keyCache);
      byContext.set(contextKey, result);
    }
    return result;
  }

  clearResultCache(): void {
    this.#resultCache.clear();
  }

  #contractId(contract: TokenVerificationContract): number {
    let id = this.#contractIds.get(contract);
    if (id === undefined) {
      id = this.#nextContractId;
      this.#nextContractId += 1;
      this.#contractIds.set(contract, id);
    }
    return id;
  }

  async verifyAccounts(
    accounts: readonly NormalizedAccount[],
    options: VerifyAccountsOptions = {},
  ): Promise<AccessTokenVerification[]> {
    const results = new Array<AccessTokenVerification>(accounts.length);
    const concurrency = Math.max(1, Math.min(
      accounts.length || 1,
      Math.trunc(options.concurrency ?? DEFAULT_CONCURRENCY),
    ));
    let nextIndex = 0;
    let completed = 0;

    await Promise.all(Array.from({ length: concurrency }, async () => {
      while (true) {
        throwIfAborted(options.signal);
        const index = nextIndex;
        nextIndex += 1;
        if (index >= accounts.length) return;
        results[index] = await this.verifyAccount(accounts[index], options);
        throwIfAborted(options.signal);
        completed += 1;
        if (completed % PROGRESS_INTERVAL === 0) {
          options.onProgress?.(completed, accounts.length);
          if (options.yieldControl) await options.yieldControl();
        } else if (completed === accounts.length) {
          options.onProgress?.(completed, accounts.length);
        }
      }
    }));

    return results;
  }
}

export function verifyAccountAccessToken(
  account: NormalizedAccount,
  options: VerifyAccountOptions = {},
): Promise<AccessTokenVerification> {
  return new TokenVerifier().verifyAccount(account, options);
}

export function verifyAccessTokenWithContract(
  token: string,
  contract: TokenVerificationContract,
  now = Date.now(),
): Promise<AccessTokenVerification> {
  return new TokenVerifier().verifyToken(token, contract, { now });
}

export function applyAccessTokenVerification(
  account: NormalizedAccount,
  result: AccessTokenVerification,
): void {
  account.tokenVerification = result.verification;
  account.tokenVerificationContext = result.context;
}

export function reusableAccessTokenVerification(
  account: NormalizedAccount,
  now = Date.now(),
): AccessTokenVerification | undefined {
  const verification = account.tokenVerification;
  const context = account.tokenVerificationContext;
  if (!verification || !context || verification.status === "unchecked") return undefined;
  if (!sameVerificationContext(context, expectedVerificationContext(account))) return undefined;

  if (
    verification.notBeforeActive
    && account.notBefore
    && Date.parse(account.notBefore) <= now
  ) {
    const { notBeforeActive: _notBeforeActive, ...activeVerification } = verification;
    return { verification: activeVerification, context };
  }
  return { verification, context };
}

async function verifyWithCaches(
  token: string,
  contract: TokenVerificationContract,
  now: number,
  contractId: number,
  keyCache: Map<string, Promise<CryptoKey>>,
): Promise<AccessTokenVerification> {
  const context = verificationContext(contract);
  const parsed = parseSignedJwt(token);
  if (!parsed) {
    return withContext("forged", "malformed_jwt", context);
  }
  const algorithm = stringValue(parsed.header.alg);
  if (algorithm !== contract.algorithm) {
    return withContext("forged", "algorithm_rejected", context, {
      algorithm: supportedAlgorithm(algorithm),
      kid: stringValue(parsed.header.kid),
    });
  }
  if (contract.provider === "xai" && parsed.header.typ !== XAI_ACCESS_TOKEN_TYPE) {
    return withContext("forged", "token_type_mismatch", context, {
      algorithm,
      kid: stringValue(parsed.header.kid),
    });
  }
  const kid = stringValue(parsed.header.kid);
  const jwk = kid ? matchingJwk(contract, kid) : undefined;
  if (!kid || !jwk) {
    return withContext("unverifiable", "unknown_kid", context, { algorithm, kid });
  }

  const keyId = `${contractId}\n${kid}`;
  let key = keyCache.get(keyId);
  if (!key) {
    key = crypto.subtle.importKey(
      "jwk",
      jwk,
      importAlgorithm(contract.algorithm),
      false,
      ["verify"],
    );
    keyCache.set(keyId, key);
  }
  const validSignature = await crypto.subtle.verify(
    verifyAlgorithm(contract.algorithm),
    await key,
    parsed.signature,
    new TextEncoder().encode(parsed.signingInput),
  );
  if (!validSignature) {
    return withContext("forged", "signature_failed", context, { algorithm, kid });
  }
  if (parsed.payload.iss !== contract.issuer) {
    return withContext("forged", "issuer_mismatch", context, { algorithm, kid });
  }
  if (contract.expectedAudience && !audienceIncludes(parsed.payload.aud, contract.expectedAudience)) {
    return withContext("forged", "audience_mismatch", context, { algorithm, kid });
  }

  const notBefore = typeof parsed.payload.nbf === "number" && Number.isFinite(parsed.payload.nbf)
    ? parsed.payload.nbf * 1000
    : undefined;
  return withContext("verified", "signature_valid", context, {
    algorithm,
    kid,
    notBeforeActive: notBefore !== undefined && notBefore > now ? true : undefined,
  });
}

function contractFor(account: NormalizedAccount): TokenVerificationContract {
  if (account.provider === "openai") return OPENAI_CONTRACT;
  return XAI_CONTRACT;
}

function unchecked(account: NormalizedAccount): AccessTokenVerification {
  const contract = account.provider === "unknown" ? undefined : contractFor(account);
  return withContext(
    "unchecked",
    "user_disabled",
    contract ? verificationContext(contract) : { provider: account.provider },
  );
}

function classified(
  provider: Provider,
  status: "unverifiable",
  reason: "missing_access_token" | "opaque_access_token" | "unknown_provider",
): AccessTokenVerification {
  return withContext(status, reason, { provider });
}

function withContext(
  status: TokenVerification["status"],
  reason: TokenVerification["reason"],
  context: TokenVerificationContext,
  details: Pick<TokenVerification, "algorithm" | "kid" | "notBeforeActive"> = {},
): AccessTokenVerification {
  return {
    verification: {
      status,
      reason,
      tokenField: "accessToken",
      ...details,
    },
    context,
  };
}

function verificationContext(contract: TokenVerificationContract): TokenVerificationContext {
  return {
    provider: contract.provider,
    issuer: contract.issuer,
    algorithm: contract.algorithm,
    expectedAudience: contract.expectedAudience,
  };
}

function expectedVerificationContext(account: NormalizedAccount): TokenVerificationContext {
  if (account.provider === "unknown" || !account.accessToken || !looksLikeJwt(account.accessToken)) {
    return { provider: account.provider };
  }
  return verificationContext(contractFor(account));
}

function sameVerificationContext(
  left: TokenVerificationContext,
  right: TokenVerificationContext,
): boolean {
  return left.provider === right.provider
    && left.issuer === right.issuer
    && left.algorithm === right.algorithm
    && left.expectedAudience === right.expectedAudience;
}

function matchingJwk(contract: TokenVerificationContract, kid: string): VerificationJwk | undefined {
  return contract.jwks.keys.find((key) =>
    key.kid === kid
    && key.alg === contract.algorithm
    && (!key.use || key.use === "sig")
    && (contract.algorithm === "RS256"
      ? key.kty === "RSA"
      : key.kty === "EC" && key.crv === "P-256"),
  );
}

function importAlgorithm(algorithm: SupportedTokenAlgorithm): RsaHashedImportParams | EcKeyImportParams {
  return algorithm === "RS256"
    ? { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }
    : { name: "ECDSA", namedCurve: "P-256" };
}

function verifyAlgorithm(algorithm: SupportedTokenAlgorithm): AlgorithmIdentifier | EcdsaParams {
  return algorithm === "RS256"
    ? { name: "RSASSA-PKCS1-v1_5" }
    : { name: "ECDSA", hash: "SHA-256" };
}

function parseSignedJwt(token: string): {
  header: Record<string, unknown>;
  payload: Record<string, unknown>;
  signingInput: string;
  signature: ArrayBuffer;
} | undefined {
  const parts = token.split(".");
  if (parts.length !== 3 || !parts[0] || !parts[1]) return undefined;
  try {
    const decoder = new TextDecoder("utf-8", { fatal: true });
    const header = JSON.parse(decoder.decode(base64urlBytes(parts[0]))) as unknown;
    const payload = JSON.parse(decoder.decode(base64urlBytes(parts[1]))) as unknown;
    if (!isRecord(header) || !isRecord(payload)) return undefined;
    return {
      header,
      payload,
      signingInput: `${parts[0]}.${parts[1]}`,
      signature: toArrayBuffer(base64urlBytes(parts[2])),
    };
  } catch {
    return undefined;
  }
}

function base64urlBytes(value: string): Uint8Array {
  if (value.length % 4 === 1 || !/^[A-Za-z0-9_-]*$/.test(value)) {
    throw new Error("Invalid base64url");
  }
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = normalized.padEnd(normalized.length + ((4 - normalized.length % 4) % 4), "=");
  if (typeof Buffer !== "undefined") return new Uint8Array(Buffer.from(padded, "base64"));
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function toArrayBuffer(value: Uint8Array): ArrayBuffer {
  return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer;
}

function audienceIncludes(value: unknown, expected: string): boolean {
  return value === expected || (Array.isArray(value) && value.includes(expected));
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function supportedAlgorithm(value: string | undefined): SupportedTokenAlgorithm | undefined {
  return value === "RS256" || value === "ES256" ? value : undefined;
}

function looksLikeJwt(token: string): boolean {
  return token.split(".").length === 3;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
}
