import { describe, expect, it } from "vitest";
import { AccountStore } from "../src/account-store.js";
import type {
  NormalizedAccount,
  Provider,
  TokenVerification,
  TokenVerificationContext,
} from "../src/types.js";

function account(
  provider: Provider,
  fields: Partial<NormalizedAccount>,
): NormalizedAccount {
  return {
    provider,
    sourceName: fields.sourceName ?? "test.json",
    sourcePath: fields.sourcePath ?? "test.json",
    ...fields,
  } as unknown as NormalizedAccount;
}

describe("AccountStore", () => {
  it("merges one compatible token group and indexes credentials added by the merge", () => {
    const store = new AccountStore();
    store.commitSource([account("openai", { accessToken: "access-a", email: "first@example.com" })]);
    store.commitSource([account("openai", { accessToken: "access-a", refreshToken: "refresh-a", name: "Second" })]);
    store.commitSource([account("openai", { refreshToken: "refresh-a", sessionToken: "session-a" })]);

    expect(store.size).toBe(1);
    expect(store.getAt(0)).toMatchObject({
      accessToken: "access-a",
      refreshToken: "refresh-a",
      sessionToken: "session-a",
      email: "first@example.com",
      name: "Second",
    });
  });

  it("does not bridge multiple compatible groups", () => {
    const store = new AccountStore();
    store.commitSource([account("openai", { refreshToken: "refresh-a", email: "refresh@example.com" })]);
    store.commitSource([account("openai", { sessionToken: "session-a", email: "session@example.com" })]);
    store.commitSource([account("openai", { refreshToken: "refresh-a", sessionToken: "session-a" })]);

    expect(store.size).toBe(3);
  });

  it("keeps providers and non-token identities isolated", () => {
    const store = new AccountStore();
    store.commitSource([account("openai", { accessToken: "shared", accountId: "same", email: "same@example.com" })]);
    store.commitSource([account("xai", { accessToken: "shared", userId: "same", email: "same@example.com" })]);
    store.commitSource([account("openai", { accessToken: "different", accountId: "same", email: "same@example.com" })]);

    expect(store.size).toBe(3);
  });

  it("does not use synthetic ID tokens as dedupe keys", () => {
    const store = new AccountStore();
    store.commitSource([account("openai", { idToken: "synthetic", idTokenSynthetic: true, email: "a@example.com" })]);
    store.commitSource([account("openai", { idToken: "synthetic", idTokenSynthetic: true, email: "b@example.com" })]);

    expect(store.size).toBe(2);
  });

  it("does not downgrade a stored real ID token when a later record marks the same value synthetic", () => {
    const store = new AccountStore();
    store.commitSource([account("openai", {
      accessToken: "shared-access",
      idToken: "real-id-token",
      idTokenSynthetic: false,
    })]);
    store.commitSource([account("openai", {
      accessToken: "shared-access",
      idToken: "real-id-token",
      idTokenSynthetic: true,
    })]);

    expect(store.getAt(0)).toMatchObject({
      idToken: "real-id-token",
      idTokenSynthetic: false,
    });
  });

  it("keeps the synthetic marker when a merge fills a previously missing ID token", () => {
    const store = new AccountStore();
    store.commitSource([account("openai", {
      accessToken: "shared-access",
      idTokenSynthetic: false,
    })]);
    store.commitSource([account("openai", {
      accessToken: "shared-access",
      idToken: "synthetic-id-token",
      idTokenSynthetic: true,
    })]);

    expect(store.getAt(0)).toMatchObject({
      idToken: "synthetic-id-token",
      idTokenSynthetic: true,
    });
  });

  it("does not scan a shared refresh-token bucket when another credential rules every group out", () => {
    const store = new AccountStore();
    let existingAccessTokenReads = 0;
    const colliding = Array.from({ length: 128 }, (_, index) => {
      const value = account("openai", { refreshToken: "shared-refresh" });
      Object.defineProperty(value, "accessToken", {
        enumerable: true,
        get: () => {
          existingAccessTokenReads += 1;
          return `access-${index}`;
        },
      });
      return value;
    });
    store.commitSource(colliding);
    existingAccessTokenReads = 0;

    store.commitSource([account("openai", {
      accessToken: "new-access",
      refreshToken: "shared-refresh",
    })]);

    expect(store.size).toBe(129);
    expect(existingAccessTokenReads).toBeLessThan(8);
  });

  it("returns lightweight searched ranges and maintains indexes after deletion", () => {
    const store = new AccountStore();
    store.commitSource([account("openai", { accessToken: "access-a", email: "alice@example.com", planType: "plus" })]);
    store.commitSource([account("xai", { accessToken: "access-b", email: "bob@example.com" })]);
    const firstId = store.idAt(0)!;

    expect(store.range(0, 20, "ALICE")).toMatchObject({
      total: 1,
      items: [{ id: firstId, email: "alice@example.com" }],
    });
    expect(store.summary()).toMatchObject({
      total: 2,
      providerCounts: { openai: 1, xai: 1, unknown: 0 },
      planCount: 1,
    });

    expect(store.remove(firstId)).toBe(true);
    expect(store.size).toBe(1);
    store.commitSource([account("openai", { accessToken: "access-a" })]);
    expect(store.size).toBe(2);
  });

  it("removes many accounts in one order rebuild and clears every credential index", () => {
    const store = new AccountStore();
    store.commitSource(Array.from({ length: 6 }, (_, index) => account("openai", {
      accessToken: `access-${index}`,
      email: `user-${index}@example.com`,
    })));
    const removedIds = [store.idAt(1)!, store.idAt(3)!, store.idAt(4)!];

    expect(store.removeMany(removedIds)).toBe(3);
    expect([...store.values()].map((value) => value.accessToken)).toEqual(["access-0", "access-2", "access-5"]);

    store.commitSource([account("openai", { accessToken: "access-3" })]);
    expect(store.size).toBe(4);
    expect(store.getAt(3)?.accessToken).toBe("access-3");
  });

  it.each(["refresh-first", "access-first"] as const)(
    "moves access token and verification as one unit when merging %s",
    (order) => {
      const store = new AccountStore();
      const refreshOnly = account("openai", {
        refreshToken: "shared-refresh",
        tokenVerification: verification("unverifiable", "missing_access_token"),
        tokenVerificationContext: context("openai"),
      });
      const verifiedAccess = account("openai", {
        accessToken: "verified-access",
        refreshToken: "shared-refresh",
        tokenVerification: verification("verified", "signature_valid"),
        tokenVerificationContext: context("openai", "https://api.openai.com/v1"),
      });

      store.commitSource(order === "refresh-first" ? [refreshOnly, verifiedAccess] : [verifiedAccess, refreshOnly]);

      expect(store.getAt(0)).toMatchObject({
        accessToken: "verified-access",
        refreshToken: "shared-refresh",
        tokenVerification: { status: "verified", reason: "signature_valid" },
        tokenVerificationContext: {
          provider: "openai",
          expectedAudience: "https://api.openai.com/v1",
        },
      });
    },
  );

  it("does not detach a verification result from its access token and only re-verifies an exact token", () => {
    const store = new AccountStore();
    store.commitSource([account("xai", {
      accessToken: "access-a",
      refreshToken: "refresh-a",
      clientId: "client-a",
      tokenVerification: verification("forged", "signature_failed"),
      tokenVerificationContext: context("xai"),
    })]);
    store.commitSource([account("xai", {
      accessToken: "access-a",
      refreshToken: "refresh-a",
      clientId: "client-b",
      tokenVerification: verification("verified", "signature_valid"),
      tokenVerificationContext: context("xai"),
    })]);

    const id = store.idAt(0)!;
    expect(store.get(id)?.tokenVerification).toMatchObject({ status: "forged", reason: "signature_failed" });
    expect(store.updateAccessTokenVerification(
      id,
      { accessToken: "stale-token" },
      verification("verified", "signature_valid"),
      context("xai"),
    )).toBe(false);
    expect(store.updateAccessTokenVerification(
      id,
      { accessToken: "access-a" },
      verification("verified", "signature_valid"),
      context("xai"),
    )).toBe(true);
    expect(store.get(id)).toMatchObject({
      accessToken: "access-a",
      tokenVerification: { status: "verified", reason: "signature_valid" },
      tokenVerificationContext: { provider: "xai" },
    });
  });

  it("does not split one xAI token identity when client ID metadata conflicts", () => {
    const store = new AccountStore();
    store.commitSource([
      account("xai", {
        accessToken: "shared-access",
        clientId: "client-a",
        tokenVerification: verification("verified", "signature_valid"),
        tokenVerificationContext: context("xai"),
      }),
      account("xai", {
        accessToken: "shared-access",
        clientId: "client-b",
        tokenVerification: verification("verified", "signature_valid"),
        tokenVerificationContext: context("xai"),
      }),
    ]);

    expect(store.size).toBe(1);
    expect(store.getAt(0)).toMatchObject({ accessToken: "shared-access", clientId: "client-a" });
  });

  it.each(["without-client-first", "with-client-first"] as const)(
    "fills xAI client ID metadata without changing access-token verification when merging %s",
    (order) => {
      const store = new AccountStore();
      const withoutClient = account("xai", {
        accessToken: "shared-access",
        tokenVerification: verification("verified", "signature_valid"),
        tokenVerificationContext: context("xai"),
      });
      const withClient = account("xai", {
        accessToken: "shared-access",
        clientId: "wrong-client",
        tokenVerification: verification("verified", "signature_valid"),
        tokenVerificationContext: context("xai"),
      });

      store.commitSource(order === "without-client-first" ? [withoutClient, withClient] : [withClient, withoutClient]);

      expect(store.getAt(0)).toMatchObject({
        accessToken: "shared-access",
        clientId: "wrong-client",
        tokenVerification: { status: "verified", reason: "signature_valid" },
        tokenVerificationContext: { provider: "xai" },
      });
    },
  );

  it("keeps existing xAI client ID metadata when a later record supplies an access token", () => {
    const store = new AccountStore();
    store.commitSource([account("xai", {
      refreshToken: "shared-refresh",
      clientId: "refresh-only-client",
      tokenVerification: verification("unverifiable", "missing_access_token"),
      tokenVerificationContext: context("xai"),
    })]);
    store.commitSource([account("xai", {
      accessToken: "new-access",
      refreshToken: "shared-refresh",
      clientId: "access-client",
      tokenVerification: verification("verified", "signature_valid"),
      tokenVerificationContext: context("xai"),
    })]);

    expect(store.getAt(0)).toMatchObject({
      accessToken: "new-access",
      clientId: "refresh-only-client",
      tokenVerification: { status: "verified", reason: "signature_valid" },
      tokenVerificationContext: { provider: "xai" },
    });
  });

  it("still fills an xAI client ID when neither merged record has an access token", () => {
    const store = new AccountStore();
    store.commitSource([account("xai", { refreshToken: "shared-refresh" })]);
    store.commitSource([account("xai", { refreshToken: "shared-refresh", clientId: "refresh-client" })]);

    expect(store.getAt(0)).toMatchObject({
      refreshToken: "shared-refresh",
      clientId: "refresh-client",
    });
  });
});

function verification(
  status: TokenVerification["status"],
  reason: TokenVerification["reason"],
): TokenVerification {
  return { status, reason, tokenField: "accessToken" };
}

function context(provider: Provider, expectedAudience?: string): TokenVerificationContext {
  return { provider, expectedAudience };
}
