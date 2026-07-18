import { describe, expect, it } from "vitest";
import {
  TOKEN_VERIFICATION_SOURCES,
  TokenVerifier,
  verifyAccountAccessToken,
  verifyAccessTokenWithContract,
  type TokenVerificationContract,
} from "../src/token-verification.js";
import openAiJwks from "../src/jwks/openai.json" with { type: "json" };
import xaiJwks from "../src/jwks/xai.json" with { type: "json" };
import type { NormalizedAccount, Provider } from "../src/types.js";

describe("token verification", () => {
  it.each([
    ["openai", "RS256", "https://auth.openai.com", "https://api.openai.com/v1"],
    ["xai", "ES256", "https://auth.x.ai", "xai-client"],
  ] as const)("verifies a valid %s %s access token", async (provider, algorithm, issuer, audience) => {
    const fixture = await signingFixture(provider, algorithm, issuer, audience);
    const token = await fixture.sign({ iss: issuer, aud: audience, sub: "user-1" });

    await expect(verifyAccessTokenWithContract(token, fixture.contract)).resolves.toMatchObject({
      verification: {
        status: "verified",
        reason: "signature_valid",
        algorithm,
        kid: fixture.kid,
      },
      context: { provider, issuer, expectedAudience: audience },
    });
  });

  it("rejects payload and signature tampering", async () => {
    const fixture = await signingFixture(
      "openai",
      "RS256",
      "https://auth.openai.com",
      "https://api.openai.com/v1",
    );
    const token = await fixture.sign({
      iss: fixture.contract.issuer,
      aud: fixture.contract.expectedAudience,
      sub: "original",
    });
    const [header, , signature] = token.split(".");
    const alteredPayload = base64url(JSON.stringify({
      iss: fixture.contract.issuer,
      aud: fixture.contract.expectedAudience,
      sub: "altered",
    }));
    const signatureBytes = Buffer.from(signature, "base64url");
    signatureBytes[0] ^= 1;
    const alteredSignature = signatureBytes.toString("base64url");

    await expect(verifyAccessTokenWithContract(`${header}.${alteredPayload}.${signature}`, fixture.contract))
      .resolves.toMatchObject({ verification: { status: "forged", reason: "signature_failed" } });
    await expect(verifyAccessTokenWithContract(`${header}.${token.split(".")[1]}.${alteredSignature}`, fixture.contract))
      .resolves.toMatchObject({ verification: { status: "forged", reason: "signature_failed" } });
  });

  it("rejects malformed JWTs, alg:none, and algorithm confusion", async () => {
    const fixture = await signingFixture(
      "openai",
      "RS256",
      "https://auth.openai.com",
      "https://api.openai.com/v1",
    );
    const claims = { iss: fixture.contract.issuer, aud: fixture.contract.expectedAudience };
    const none = `${base64url(JSON.stringify({ alg: "none", kid: fixture.kid }))}.${base64url(JSON.stringify(claims))}.`;
    const confused = await fixture.sign(claims, { alg: "ES256" });
    const invalidBase64url = `${confused.slice(0, confused.lastIndexOf(".") + 1)}A`;

    await expect(verifyAccessTokenWithContract("a.b.c", fixture.contract)).resolves.toMatchObject({
      verification: { status: "forged", reason: "malformed_jwt" },
    });
    await expect(verifyAccessTokenWithContract(none, fixture.contract)).resolves.toMatchObject({
      verification: { status: "forged", reason: "algorithm_rejected" },
    });
    await expect(verifyAccessTokenWithContract(confused, fixture.contract)).resolves.toMatchObject({
      verification: { status: "forged", reason: "algorithm_rejected" },
    });
    await expect(verifyAccessTokenWithContract(invalidBase64url, fixture.contract)).resolves.toMatchObject({
      verification: { status: "forged", reason: "malformed_jwt" },
    });
  });

  it("rejects issuer and audience mismatches after a valid signature", async () => {
    const fixture = await signingFixture(
      "openai",
      "RS256",
      "https://auth.openai.com",
      "https://api.openai.com/v1",
    );
    const wrongIssuer = await fixture.sign({ iss: "https://attacker.invalid", aud: fixture.contract.expectedAudience });
    const wrongAudience = await fixture.sign({ iss: fixture.contract.issuer, aud: ["another-audience"] });

    await expect(verifyAccessTokenWithContract(wrongIssuer, fixture.contract)).resolves.toMatchObject({
      verification: { status: "forged", reason: "issuer_mismatch" },
    });
    await expect(verifyAccessTokenWithContract(wrongAudience, fixture.contract)).resolves.toMatchObject({
      verification: { status: "forged", reason: "audience_mismatch" },
    });
  });

  it.each([
    ["an ID token", "JWT", undefined],
    ["a token without typ", undefined, undefined],
    ["an ID token with an unknown kid", "JWT", "unknown-kid"],
  ] as const)("rejects %s in the xAI access_token field", async (_label, typ, kid) => {
    const fixture = await signingFixture(
      "xai",
      "ES256",
      "https://auth.x.ai",
      "xai-client",
    );
    const token = await fixture.sign({
      iss: fixture.contract.issuer,
      aud: fixture.contract.expectedAudience,
    }, { typ, ...(kid ? { kid } : {}) });

    await expect(verifyAccessTokenWithContract(token, fixture.contract)).resolves.toMatchObject({
      verification: { status: "forged", reason: "token_type_mismatch" },
    });
  });

  it("uses only the supplied JWKS and reports unknown kid separately", async () => {
    const trusted = await signingFixture(
      "openai",
      "RS256",
      "https://auth.openai.com",
      "https://api.openai.com/v1",
    );
    const attacker = await signingFixture(
      "openai",
      "RS256",
      "https://auth.openai.com",
      "https://api.openai.com/v1",
    );
    const unknownKid = await attacker.sign({
      iss: trusted.contract.issuer,
      aud: trusted.contract.expectedAudience,
    });
    const maliciousHeader = await attacker.sign({
      iss: trusted.contract.issuer,
      aud: trusted.contract.expectedAudience,
    }, {
      kid: trusted.kid,
      jku: "https://attacker.invalid/jwks.json",
      x5u: "https://attacker.invalid/cert.pem",
    });

    await expect(verifyAccessTokenWithContract(unknownKid, trusted.contract)).resolves.toMatchObject({
      verification: { status: "unverifiable", reason: "unknown_kid" },
    });
    await expect(verifyAccessTokenWithContract(maliciousHeader, trusted.contract)).resolves.toMatchObject({
      verification: { status: "forged", reason: "signature_failed" },
    });
  });

  it("keeps expired and not-yet-active signed tokens cryptographically verified", async () => {
    const fixture = await signingFixture(
      "xai",
      "ES256",
      "https://auth.x.ai",
      "xai-client",
    );
    const token = await fixture.sign({
      iss: fixture.contract.issuer,
      aud: fixture.contract.expectedAudience,
      exp: 1,
      nbf: 4_000_000_000,
    });

    await expect(verifyAccessTokenWithContract(token, fixture.contract, 2_000_000_000_000)).resolves.toMatchObject({
      verification: { status: "verified", reason: "signature_valid", notBeforeActive: true },
    });
  });

  it("recomputes nbf display state after an operation cache is cleared", async () => {
    const fixture = await signingFixture(
      "xai",
      "ES256",
      "https://auth.x.ai",
      "xai-client",
    );
    const token = await fixture.sign({
      iss: fixture.contract.issuer,
      aud: fixture.contract.expectedAudience,
      nbf: 2_000,
    });
    const verifier = new TokenVerifier();

    await expect(verifier.verifyToken(token, fixture.contract, { now: 1_000_000 })).resolves.toMatchObject({
      verification: { status: "verified", notBeforeActive: true },
    });
    verifier.clearResultCache();
    await expect(verifier.verifyToken(token, fixture.contract, { now: 3_000_000 })).resolves.toMatchObject({
      verification: { status: "verified", notBeforeActive: undefined },
    });
  });

  it("does not reuse a result across different issuer contracts", async () => {
    const fixture = await signingFixture(
      "openai",
      "RS256",
      "https://auth.openai.com",
      "https://api.openai.com/v1",
    );
    const token = await fixture.sign({
      iss: fixture.contract.issuer,
      aud: fixture.contract.expectedAudience,
    });
    const verifier = new TokenVerifier();

    await expect(verifier.verifyToken(token, fixture.contract)).resolves.toMatchObject({
      verification: { status: "verified" },
    });
    await expect(verifier.verifyToken(token, {
      ...fixture.contract,
      issuer: "https://attacker.invalid",
    })).resolves.toMatchObject({
      verification: { status: "forged", reason: "issuer_mismatch" },
    });
  });

  it("does not reuse an imported key across different JWKS contracts", async () => {
    const trusted = await signingFixture(
      "openai",
      "RS256",
      "https://auth.openai.com",
      "https://api.openai.com/v1",
    );
    const alternate = await signingFixture(
      "openai",
      "RS256",
      "https://auth.openai.com",
      "https://api.openai.com/v1",
    );
    const claims = { iss: trusted.contract.issuer, aud: trusted.contract.expectedAudience };
    const trustedToken = await trusted.sign(claims);
    const alternateToken = await alternate.sign(claims, { kid: trusted.kid });
    const alternateContract = {
      ...alternate.contract,
      jwks: {
        keys: alternate.contract.jwks.keys.map((key) => ({ ...key, kid: trusted.kid })),
      },
    };
    const verifier = new TokenVerifier();

    await expect(verifier.verifyToken(trustedToken, trusted.contract)).resolves.toMatchObject({
      verification: { status: "verified" },
    });
    await expect(verifier.verifyToken(alternateToken, alternateContract)).resolves.toMatchObject({
      verification: { status: "verified" },
    });
  });

  it("classifies missing, opaque, unknown-provider, and explicitly unchecked accounts", async () => {
    await expect(verifyAccountAccessToken(account("openai", {}))).resolves.toMatchObject({
      verification: { status: "unverifiable", reason: "missing_access_token" },
    });
    await expect(verifyAccountAccessToken(account("openai", { accessToken: "opaque-token" }))).resolves.toMatchObject({
      verification: { status: "unverifiable", reason: "opaque_access_token" },
    });
    await expect(verifyAccountAccessToken(account("unknown", { accessToken: "opaque-token" }))).resolves.toMatchObject({
      verification: { status: "unverifiable", reason: "unknown_provider" },
    });
    await expect(verifyAccountAccessToken(account("openai", { accessToken: "opaque-token" }), { verify: false }))
      .resolves.toMatchObject({ verification: { status: "unchecked", reason: "user_disabled" } });
  });

  it("reuses a stored result when the access-token verification context is unchanged", async () => {
    const token = [
      base64url(JSON.stringify({ alg: "RS256", kid: "stored-kid" })),
      base64url(JSON.stringify({
        iss: "https://auth.openai.com",
        aud: "https://api.openai.com/v1",
      })),
      "not-a-real-signature",
    ].join(".");
    const stored = account("openai", {
      accessToken: token,
      tokenVerification: {
        status: "verified",
        reason: "signature_valid",
        tokenField: "accessToken",
        algorithm: "RS256",
        kid: "stored-kid",
      },
      tokenVerificationContext: {
        provider: "openai",
        issuer: "https://auth.openai.com",
        algorithm: "RS256",
        expectedAudience: "https://api.openai.com/v1",
      },
    });

    await expect(new TokenVerifier().verifyAccount(stored, { reuseExisting: true })).resolves.toMatchObject({
      verification: { status: "verified", reason: "signature_valid", kid: "stored-kid" },
    });
    await expect(new TokenVerifier().verifyAccount(stored)).resolves.toMatchObject({
      verification: { status: "unverifiable", reason: "unknown_kid" },
    });
  });

  it("keeps one valid, uniquely keyed runtime JWKS snapshot per provider", async () => {
    expect(TOKEN_VERIFICATION_SOURCES.openai.snapshotDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(TOKEN_VERIFICATION_SOURCES.xai.snapshotDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(new Set(openAiJwks.keys.map((key) => key.kid)).size).toBe(openAiJwks.keys.length);
    expect(new Set(xaiJwks.keys.map((key) => key.kid)).size).toBe(xaiJwks.keys.length);
    expect(openAiJwks.keys.every((key) => key.kty === "RSA" && key.alg === "RS256")).toBe(true);
    expect(xaiJwks.keys.every((key) => key.kty === "EC" && key.crv === "P-256" && key.alg === "ES256")).toBe(true);

    await Promise.all([
      ...openAiJwks.keys.map((key) => crypto.subtle.importKey(
        "jwk",
        key,
        { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
        false,
        ["verify"],
      )),
      ...xaiJwks.keys.map((key) => crypto.subtle.importKey(
        "jwk",
        key,
        { name: "ECDSA", namedCurve: "P-256" },
        false,
        ["verify"],
      )),
    ]);
  });
});

type SupportedAlgorithm = "RS256" | "ES256";
let fixtureSequence = 0;

async function signingFixture(
  provider: "openai" | "xai",
  algorithm: SupportedAlgorithm,
  issuer: string,
  expectedAudience: string,
) {
  fixtureSequence += 1;
  const kid = `${provider}-${algorithm.toLowerCase()}-test-${fixtureSequence}`;
  const keyAlgorithm = algorithm === "RS256"
    ? { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }
    : { name: "ECDSA", namedCurve: "P-256" };
  const keys = await crypto.subtle.generateKey(keyAlgorithm, true, ["sign", "verify"]);
  const publicJwk = await crypto.subtle.exportKey("jwk", keys.publicKey);
  const verificationJwk = { ...publicJwk, kid, alg: algorithm, use: "sig" };
  const contract: TokenVerificationContract = {
    provider,
    issuer,
    algorithm,
    expectedAudience,
    jwks: { keys: [verificationJwk] },
  };
  return {
    kid,
    contract,
    async sign(claims: Record<string, unknown>, headerOverrides: Record<string, unknown> = {}) {
      const header = { alg: algorithm, typ: provider === "xai" ? "at+jwt" : "JWT", kid, ...headerOverrides };
      const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claims))}`;
      const signature = await crypto.subtle.sign(
        algorithm === "RS256"
          ? { name: "RSASSA-PKCS1-v1_5" }
          : { name: "ECDSA", hash: "SHA-256" },
        keys.privateKey,
        new TextEncoder().encode(signingInput),
      );
      return `${signingInput}.${Buffer.from(signature).toString("base64url")}`;
    },
  };
}

function account(provider: Provider, fields: Partial<NormalizedAccount>): NormalizedAccount {
  return {
    provider,
    sourceName: "test.json",
    sourcePath: "/test.json",
    inputFormat: "unknown",
    ...fields,
  } as NormalizedAccount;
}

function base64url(value: string): string {
  return Buffer.from(value).toString("base64url");
}
