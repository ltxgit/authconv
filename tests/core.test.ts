import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { AccountStore } from "../src/account-store.js";
import { parseFormatList } from "../src/formats.js";
import { ingestSources } from "../src/ingestion.js";
import { parseNodeJsonTokens } from "../src/input-node.js";
import { buildExportManifest, collectExportEntry } from "../src/output.js";
import type {
  InputFormat,
  InputSource,
  NormalizedAccount,
  OutputFormat,
  RenderOptions,
} from "../src/types.js";

describe("authconv core contracts", () => {
  it("keeps the OpenAI fixture wire shape across every applicable format", async () => {
    const store = await ingestValue(await fixture("chatgpt-session.json"));
    const now = new Date("2026-07-04T00:00:00.000Z");

    for (const format of ["cpa", "sub2api", "codex2api", "codexmanager", "codex"] as const) {
      expect(await renderJson(store, format, { now })).toEqual(await fixture(`expected/${format}.json`));
    }
  });

  it("keeps the xAI fixture wire shape and drops device-flow state", async () => {
    const store = await ingestValue(await fixture("grok-oidc.json"));
    const account = onlyAccount(store);

    expect(account).toMatchObject({
      provider: "xai",
      clientId: "b1a00492-073a-47ea-816f-4c329264a828",
      userId: "xai-fixture-user",
      email: "grok-fixture@example.com",
    });
    expect(account).not.toHaveProperty("device_response");
    expect(account).not.toHaveProperty("user_code");
    expect(account).not.toHaveProperty("accountId");
    expect(account).not.toHaveProperty("planType");

    const now = new Date("2026-07-12T00:00:00.000Z");
    expect(await renderJson(store, "cpa", { now })).toEqual(await fixture("expected/cpa-xai.json"));
    expect(await renderJson(store, "sub2api", { now })).toEqual(await fixture("expected/sub2api-grok.json"));
    expect(await renderJson(store, "grok", { now })).toEqual(await fixture("expected/grok.json"));
  });

  it("uses recognized structure before JWT issuer and JWT only for unknown structure", async () => {
    const openAiJwt = jwt({ iss: "https://auth.openai.com", sub: "openai-user" });
    const xaiJwt = jwt({ iss: "https://auth.x.ai", sub: "xai-user" });
    const store = await ingestValue([
      { type: "codex", access_token: xaiJwt },
      { platform: "grok", credentials: { access_token: openAiJwt } },
      { access_token: openAiJwt },
      { access_token: "opaque-token" },
    ]);

    expect([...store.values()].map((account) => account.provider)).toEqual([
      "openai",
      "xai",
      "openai",
      "unknown",
    ]);
  });

  it.each([
    ["openai", "https://auth.openai.com"],
    ["xai", "https://auth.x.ai"],
  ] as const)("uses a known id_token issuer when the access-token issuer is unknown: %s", async (provider, issuer) => {
    const account = onlyAccount(await ingestValue({
      accounts: [{
        platform: "custom",
        credentials: {
          access_token: jwt({ iss: "https://other.example", sub: "access-user" }),
          id_token: jwt({ iss: issuer, sub: `${provider}-user` }),
        },
      }],
    }));

    expect(account).toMatchObject({ provider, inputFormat: "sub2api" });
  });

  it.each([
    ["platform", { platform: "grok", access_token: "platform-access", refresh_token: "platform-refresh" }],
    ["issuer", { issuer: "https://auth.x.ai", access_token: "issuer-access", refresh_token: "issuer-refresh" }],
    ["token endpoint", {
      token_endpoint: "https://auth.x.ai/oauth2/token",
      access_token: "endpoint-access",
      refresh_token: "endpoint-refresh",
    }],
  ] as const)("recognizes flat xAI credentials from their %s before codex2api", async (_label, input) => {
    const account = onlyAccount(await ingestValue(input));

    expect(account).toMatchObject({
      provider: "xai",
      inputFormat: "grok",
      accessToken: input.access_token,
    });
  });

  it("keeps explicit CPA xAI records as CPA even when they carry xAI endpoint metadata", async () => {
    const account = onlyAccount(await ingestValue({
      type: "xai",
      access_token: "cpa-access",
      refresh_token: "cpa-refresh",
      issuer: "https://auth.x.ai",
      token_endpoint: "https://auth.x.ai/oauth2/token",
    }));

    expect(account).toMatchObject({
      provider: "xai",
      inputFormat: "cpa",
      accessToken: "cpa-access",
    });
  });

  it.each([
    ["platform", { platform: "grok" }],
    ["type", { type: "xai" }],
  ] as const)("recognizes explicit xAI %s credentials before the generic session shape", async (_label, evidence) => {
    const account = onlyAccount(await ingestValue({
      ...evidence,
      accessToken: "xai-session-shaped",
      user: { id: "xai-user" },
    }));

    expect(account).toMatchObject({
      provider: "xai",
      inputFormat: "grok",
      accessToken: "xai-session-shaped",
    });
  });

  it("never applies the OpenAI synthetic marker to an xAI id_token", async () => {
    const idToken = jwt({ iss: "https://auth.x.ai", sub: "xai-user" }, "real-signature");
    const store = await ingestValue({
      type: "xai",
      access_token: "opaque-access",
      id_token: idToken,
      id_token_synthetic: true,
    });

    expect(onlyAccount(store)).toMatchObject({ provider: "xai", idToken });
    expect(onlyAccount(store)).not.toHaveProperty("idTokenSynthetic");
  });

  it("does not derive the xAI access-token audience contract from an ID token", async () => {
    const store = await ingestValue({
      platform: "grok",
      credentials: {
        access_token: "opaque-access",
        id_token: jwt({
          iss: "https://auth.x.ai",
          client_id: "id-token-client",
        }),
      },
    });

    expect(onlyAccount(store).clientId).toBeUndefined();
    expect(onlyAccount(store).tokenVerificationContext).toEqual({ provider: "xai" });
  });

  it("parses Grok issuer keys so non-default client and user identity survive round-trip", async () => {
    const input = {
      "https://auth.x.ai::custom-client::key-user": {
        key: "opaque-access",
        auth_mode: "oidc",
        refresh_token: "opaque-refresh",
        email: "key@example.com",
      },
    };
    const store = await ingestValue(input);

    expect(onlyAccount(store)).toMatchObject({
      provider: "xai",
      clientId: "custom-client",
      userId: "key-user",
    });
    expect(await renderJson(store, "grok")).toMatchObject({
      "https://auth.x.ai::custom-client": {
        key: "opaque-access",
        user_id: "key-user",
        oidc_client_id: "custom-client",
      },
    });
  });

  it("imports every entry from a multi-account Grok auth.json", async () => {
    const store = await ingestValue({
      "https://auth.x.ai::client-a::user-a": {
        key: "access-a",
        refresh_token: "refresh-a",
        oidc_issuer: "https://auth.x.ai",
        oidc_client_id: "client-a",
      },
      "https://auth.x.ai::client-a::user-b": {
        key: "access-b",
        refresh_token: "refresh-b",
        oidc_issuer: "https://auth.x.ai",
        oidc_client_id: "client-a",
      },
    });

    expect([...store.values()]).toMatchObject([
      { provider: "xai", accessToken: "access-a", userId: "user-a" },
      { provider: "xai", accessToken: "access-b", userId: "user-b" },
    ]);
  });

  it("imports consecutive JSON documents and detects each provider independently", async () => {
    const openAi = JSON.stringify({
      platform: "openai",
      credentials: { access_token: "openai-access" },
    });
    const xai = JSON.stringify({
      platform: "grok",
      credentials: { access_token: "xai-access" },
    });
    const result = await ingestText(`${openAi}${xai}`);

    expect([...result.store.values()].map((account) => account.provider)).toEqual(["openai", "xai"]);
    expect(result.processedSources).toBe(2);
    expect(result.inputFormat).toBe("sub2api");
  });

  it("parses nested Codex auth and prefers access-token account claims", async () => {
    const accessToken = jwt({
      iss: "https://auth.openai.com",
      "https://api.openai.com/auth": { chatgpt_account_id: "claim-account" },
    });
    const store = await ingestValue({
      auth_mode: "chatgpt",
      tokens: {
        access_token: accessToken,
        refresh_token: "refresh",
        account_id: "stale-account",
      },
    });

    expect(onlyAccount(store)).toMatchObject({
      provider: "openai",
      accessToken,
      accountId: "claim-account",
      chatgptAccountId: "claim-account",
    });
  });

  it("keeps accounts separate when a shared access token conflicts with another credential", async () => {
    const store = await ingestValue([
      { platform: "openai", credentials: { access_token: "shared", refresh_token: "refresh-a" } },
      { platform: "openai", credentials: { access_token: "shared", refresh_token: "refresh-b" } },
    ]);

    expect(store.size).toBe(2);
  });

  it("replaces a synthetic id_token with a compatible real id_token", async () => {
    const accessToken = jwt({
      iss: "https://auth.openai.com",
      email: "same@example.com",
      "https://api.openai.com/auth": { chatgpt_account_id: "same-account" },
    });
    const realIdToken = jwt({ iss: "https://auth.openai.com", sub: "same-user" }, "real-signature");
    const store = await ingestValue([
      { platform: "openai", credentials: { access_token: accessToken, refresh_token: "refresh" } },
      { platform: "openai", credentials: { access_token: accessToken, id_token: realIdToken } },
    ]);

    expect(store.size).toBe(1);
    expect(onlyAccount(store)).toMatchObject({ idToken: realIdToken, idTokenSynthetic: false });
  });

  it("keeps token claims authoritative for Session but preserves explicit imported metadata", async () => {
    const accessToken = jwt({
      iss: "https://auth.openai.com",
      email: "claim@example.com",
      exp: 1_800_000_000,
      "https://api.openai.com/auth": {
        chatgpt_account_id: "claim-account",
        chatgpt_plan_type: "plus",
      },
    });
    const session = await ingestValue({
      accessToken,
      user: { email: "stale@example.com" },
      account: { id: "stale-account", planType: "free" },
    });
    const imported = await ingestValue({
      platform: "openai",
      credentials: {
        access_token: accessToken,
        email: "imported@example.com",
        chatgpt_account_id: "imported-account",
        plan_type: "team",
      },
    });

    expect(onlyAccount(session)).toMatchObject({
      email: "claim@example.com",
      accountId: "claim-account",
      planType: "plus",
    });
    expect(onlyAccount(imported)).toMatchObject({
      email: "imported@example.com",
      accountId: "claim-account",
      chatgptAccountId: "imported-account",
      planType: "team",
    });
  });

  it("creates synthetic OpenAI id_token but omits it and refresh_token at render boundaries", async () => {
    const store = await ingestValue({
      platform: "openai",
      credentials: {
        access_token: jwt({
          iss: "https://auth.openai.com",
          email: "synthetic@example.com",
          "https://api.openai.com/auth": { chatgpt_account_id: "synthetic-account" },
        }),
        refresh_token: "refresh-secret",
      },
    });
    const account = onlyAccount(store);
    expect(account).toMatchObject({ provider: "openai", idTokenSynthetic: true });
    expect(account.idToken?.split(".")[2]).toBe(Buffer.from("lanv_authconv").toString("base64url"));

    for (const format of ["cpa", "sub2api", "codex2api", "codexmanager", "codex"] as const) {
      const text = await renderText(store, format, {
        allowSyntheticIdToken: false,
        includeRefreshToken: false,
        now: new Date(0),
      });
      expect(text).not.toContain("refresh-secret");
      expect(text).not.toContain(account.idToken!);
    }
    expect(onlyAccount(store).refreshToken).toBe("refresh-secret");
  });

  it("keeps every account when a shared account id has distinct credentials", async () => {
    const store = await ingestValue(await fixture("sub2api-shared-account-id.json"));

    expect(store.size).toBe(11);
    expect(new Set([...store.values()].map((account) => account.accessToken)).size).toBe(11);
  });

  it("keeps session-token-only input explicit in Sub2API", async () => {
    const store = await ingestValue({ platform: "openai", credentials: { session_token: "session-only" } });
    const output = await renderJson(store, "sub2api") as { accounts: Array<{ credentials: Record<string, string> }> };

    expect(output.accounts[0].credentials).toEqual({ session_token: "session-only" });
  });

  it("forced input mismatch returns a structured diagnostic and commits nothing", async () => {
    const result = await ingestResult({ platform: "openai", credentials: { access_token: "token" } }, "grok");

    expect(result.store.size).toBe(0);
    expect(result.diagnostics).toMatchObject([{
      code: "input_format_mismatch",
      sourceName: "input.json",
      sourcePath: "/input.json",
      detail: "grok",
    }]);
  });

  it("preserves CPA timestamps and a marked synthetic token on CPA round-trip", async () => {
    const input = {
      type: "codex",
      email: "roundtrip@example.com",
      account_id: "roundtrip-account",
      access_token: "opaque-access",
      id_token: "header.payload.original",
      id_token_synthetic: true,
      expired: "2026-07-14T11:02:59Z",
      last_refresh: "2026-07-14T10:02:59Z",
      disabled: false,
    };
    const store = await ingestValue(input, "cpa");
    const output = await renderJson(store, "cpa") as Record<string, unknown>;

    expect(output).toMatchObject({
      expired: "2026-07-14T11:02:59Z",
      last_refresh: "2026-07-14T10:02:59Z",
      id_token_synthetic: true,
    });
    expect(String(output.id_token).split(".")[2]).toBe(Buffer.from("lanv_authconv").toString("base64url"));
  });

  it("parses repeated format flags once and expands all deterministically", () => {
    expect(parseFormatList(["cpa,sub2api", "cpa", "all"])).toEqual([
      "cpa",
      "sub2api",
      "codex2api",
      "codexmanager",
      "codex",
      "grok",
      "grok2api",
    ]);
  });
});

async function fixture(path: string): Promise<unknown> {
  return JSON.parse(await readFile(new URL(`./fixtures/${path}`, import.meta.url), "utf8"));
}

async function ingestValue(value: unknown, inputFormat?: InputFormat): Promise<AccountStore> {
  return (await ingestResult(value, inputFormat)).store;
}

async function ingestResult(value: unknown, inputFormat?: InputFormat) {
  const source: InputSource = {
    name: "input.json",
    path: "/input.json",
    chunks: oneChunk(new TextEncoder().encode(JSON.stringify(value))),
  };
  return ingestSources([source], new AccountStore(), { parseTokens: parseNodeJsonTokens, inputFormat });
}

async function ingestText(text: string) {
  const source: InputSource = {
    name: "input.json",
    path: "/input.json",
    chunks: oneChunk(new TextEncoder().encode(text)),
  };
  return ingestSources([source], new AccountStore(), { parseTokens: parseNodeJsonTokens });
}

async function renderJson(
  store: AccountStore,
  format: OutputFormat,
  options: RenderOptions = {},
): Promise<unknown> {
  return JSON.parse(await renderText(store, format, options));
}

async function renderText(
  store: AccountStore,
  format: OutputFormat,
  options: RenderOptions = {},
): Promise<string> {
  const manifest = buildExportManifest(store, { formats: [format], verifyTokens: false });
  expect(manifest.entries).toHaveLength(1);
  return collectExportEntry(store, manifest.entries[0], options);
}

function onlyAccount(store: AccountStore): NormalizedAccount {
  expect(store.size).toBe(1);
  return [...store.values()][0];
}

async function* oneChunk(value: Uint8Array): AsyncGenerator<Uint8Array> {
  yield value;
}

function jwt(payload: Record<string, unknown>, signature = "signature"): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none", typ: "JWT" })}.${encode(payload)}.${signature}`;
}
