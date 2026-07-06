import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  buildOutputPlan,
  detectInputFormat,
  effectiveOutputModes,
  normalizeInput,
  parseInputPayload,
  parseInputPayloadWithMeta,
  parseFormatList,
  renderFormat,
  serializeOutputFiles,
} from "../src/index.js";
import { decodeJwtPayload } from "../src/jwt.js";
import { fakeJwt } from "./helpers.js";

async function readFixtureJson(relativePath: string): Promise<unknown> {
  return JSON.parse(await readFile(new URL(`./fixtures/${relativePath}`, import.meta.url), "utf8")) as unknown;
}

async function normalizeChatGptSessionFixture() {
  const input = await readFixtureJson("chatgpt-session.json");
  return normalizeInput(input, {
    sourceName: "chatgpt-session.json",
    sourcePath: "tests/fixtures/chatgpt-session.json",
  });
}

describe("authconv core", () => {
  it("parses multiple JSON documents as an array without splitting by line", () => {
    const input = [
      JSON.stringify({ access_token: "a", email: "a@example.com" }, null, 2),
      JSON.stringify({ access_token: "b", email: "b@example.com" }, null, 2),
    ].join("\n");

    expect(parseInputPayload(input)).toEqual([
      { access_token: "a", email: "a@example.com" },
      { access_token: "b", email: "b@example.com" },
    ]);
    expect(parseInputPayloadWithMeta(input).documentCount).toBe(2);
  });

  it("keeps input format detection per JSON document in mixed input", () => {
    const input = parseInputPayload(
      [
        JSON.stringify({
          type: "codex",
          access_token: "cpa-access",
          refresh_token: "cpa-refresh",
          session_token: "cpa-session",
          email: "cpa@example.com",
        }),
        JSON.stringify({
          name: "Sub Account",
          credentials: {
            access_token: "sub-access",
            email: "sub@example.com",
          },
        }),
      ].join("\n"),
    );

    const result = normalizeInput(input, { sourceName: "mixed.jsonl", sourcePath: "mixed.jsonl" });

    expect(result.inputFormat).toBe("unknown");
    expect(result.accounts.map((account) => account.inputFormat)).toEqual(["cpa", "sub2api"]);
    expect(result.accounts.map((account) => account.email)).toEqual(["cpa@example.com", "sub@example.com"]);
  });

  it("normalizes token, identity, plan, and time fields from flat input and JWT claims", () => {
    const idToken = fakeJwt({
      email: "user@example.com",
      name: "Example User",
      sub: "chatgpt-user-1",
      exp: 4102444800,
      "https://api.openai.com/auth": {
        chatgpt_account_id: "acct_chatgpt_1",
        chatgpt_user_id: "chatgpt-user-1",
        plan_type: "plus",
      },
    });

    const result = normalizeInput(
      {
        access_token: "access-token",
        refresh_token: "refresh-token",
        session_token: "session-token",
        account_id: "account-1",
        id_token: idToken,
        last_refresh: "2026-07-03T00:00:00.000Z",
        expired: "2026-07-03T01:00:00.000Z",
      },
      { sourceName: "input.json", sourcePath: "input.json" },
    );

    expect(result.accounts).toHaveLength(1);
    expect(result.accounts[0]).toMatchObject({
      accessToken: "access-token",
      refreshToken: "refresh-token",
      sessionToken: "session-token",
      accountId: "account-1",
      chatgptAccountId: "acct_chatgpt_1",
      chatgptUserId: "chatgpt-user-1",
      email: "user@example.com",
      name: "Example User",
      planType: "plus",
      lastRefresh: "2026-07-03T00:00:00.000Z",
      expiresAt: "2026-07-03T01:00:00.000Z",
      idTokenSynthetic: false,
      sourceName: "input.json",
    });
  });

  it("converts a ChatGPT web session fixture without dropping nested account fields", async () => {
    const account = (await normalizeChatGptSessionFixture()).accounts[0];

    expect(account).toMatchObject({
      accessToken: expect.any(String),
      sessionToken: "fixture-session-token",
      accountId: "workspace_fixture_456",
      chatgptAccountId: "workspace_fixture_456",
      userId: "user_fixture_123",
      chatgptUserId: "user_fixture_123",
      email: "fixture@example.com",
      name: "Fixture User",
      planType: "team",
      workspaceId: "workspace_fixture_789",
      expiresAt: "2026-07-03T01:00:00.000Z",
    });

    expect(renderFormat([account], "cpa", { now: new Date("2026-07-04T00:00:00.000Z") })).toEqual(
      await readFixtureJson("expected/cpa.json"),
    );
    expect(renderFormat([account], "codex2api")).toEqual(await readFixtureJson("expected/codex2api.json"));
    expect(renderFormat([account], "codexmanager")).toEqual(await readFixtureJson("expected/codexmanager.json"));
    expect(renderFormat([account], "sub2api", { now: new Date("2026-07-04T00:00:00.000Z") })).toEqual(
      await readFixtureJson("expected/sub2api.json"),
    );
    expect(renderFormat([account], "codex", { now: new Date("2026-07-04T00:00:00.000Z") })).toEqual(
      await readFixtureJson("expected/codex.json"),
    );
  });

  it("prefers access_token auth claims over id_token claims for ChatGPT sessions", () => {
    const idToken = fakeJwt({
      email: "id@example.com",
      name: "ID User",
      sub: "user-from-id",
      exp: 4102444800,
      "https://api.openai.com/auth": {
        chatgpt_account_id: "acct_from_id",
        chatgpt_user_id: "user-from-id",
        chatgpt_plan_type: "team",
      },
    });
    const accessToken = fakeJwt({
      email: "access@example.com",
      name: "Access User",
      sub: "user-from-access",
      exp: 1783000800,
      "https://api.openai.com/auth": {
        chatgpt_account_id: "acct_from_access",
        chatgpt_user_id: "user-from-access",
        chatgpt_plan_type: "plus",
      },
    });

    const account = normalizeInput(
      {
        accessToken,
        id_token: idToken,
        sessionToken: "session-token",
        user: { id: "session-user", email: "session@example.com", name: "Session User" },
        account: { id: "session-account", planType: "free" },
      },
      { sourceName: "session.json", sourcePath: "session.json" },
    ).accounts[0];

    expect(account).toMatchObject({
      accountId: "acct_from_access",
      chatgptAccountId: "acct_from_access",
      chatgptUserId: "user-from-access",
      planType: "plus",
      email: "access@example.com",
      name: "Access User",
      expiresAt: "2026-07-02T14:00:00.000Z",
    });
  });

  it("derives all normalized metadata fields available from access token claims", () => {
    const accessToken = fakeJwt({
      iss: "https://auth.openai.com",
      aud: ["https://api.openai.com/v1"],
      client_id: "app_access",
      sub: "auth0|access-sub",
      scp: ["openid", "email", "profile", "offline_access", "model.request"],
      nbf: 1782993600,
      iat: 1782997200,
      exp: 1783000800,
      "https://api.openai.com/profile": {
        email: "claim@example.com",
        name: "Claim Name",
      },
      "https://api.openai.com/auth": {
        chatgpt_account_user_id: "user-from-pair__acct-from-pair",
        chatgpt_plan_type: "k12",
        workspace_id: "workspace-from-auth",
      },
    });

    const result = normalizeInput(
      {
        accessToken,
        sessionToken: "session-token",
        issuer: "https://stale.example",
        chatgpt_user_id: "json-chatgpt-user",
        chatgpt_account_user_id: "json-user__json-acct",
        expires: "2099-01-01T00:00:00.000Z",
        lastRefresh: "2099-01-01T00:00:00.000Z",
        user: { id: "auth0|json-sub", email: "json@example.com", name: "JSON Name" },
        account: {
          id: "acct-from-json",
          planType: "free",
          workspaceId: "workspace-from-json",
        },
      },
      { sourceName: "session.json", sourcePath: "session.json" },
      { locale: "zh" },
    );

    expect(result.accounts[0]).toMatchObject({
      accountId: "acct-from-pair",
      chatgptAccountId: "acct-from-pair",
      chatgptUserId: "user-from-pair",
      chatgptAccountUserId: "user-from-pair__acct-from-pair",
      userId: "auth0|access-sub",
      issuer: "https://auth.openai.com",
      audience: ["https://api.openai.com/v1"],
      clientId: "app_access",
      scopes: ["openid", "email", "profile", "offline_access", "model.request"],
      notBefore: "2026-07-02T12:00:00.000Z",
      planType: "k12",
      email: "claim@example.com",
      name: "Claim Name",
      workspaceId: "workspace-from-auth",
      lastRefresh: "2026-07-02T13:00:00.000Z",
      expiresAt: "2026-07-02T14:00:00.000Z",
    });
    expect(result.warnings).toEqual(expect.arrayContaining([
      "session.json: access_token claim 不一致，覆盖字段: account_id,user_id,chatgpt_user_id,chatgpt_account_user_id,issuer,plan_type,email,name,workspace_id,expires_at,last_refresh",
    ]));
  });

  it("warns when sanity-checkable JWT claims are invalid", () => {
    const accessToken = fakeJwt({
      iss: "https://example.invalid",
      aud: ["https://example.invalid/api"],
      sub: "auth0|access-sub",
      nbf: 1783000801,
      exp: 1783000800,
      "https://api.openai.com/auth": {
        chatgpt_account_id: "acct_from_access",
        chatgpt_user_id: "user-from-access",
      },
    });

    const result = normalizeInput(
      {
        accessToken,
        sessionToken: "session-token",
      },
      { sourceName: "session.json", sourcePath: "session.json" },
      { locale: "zh" },
    );

    expect(result.warnings).toEqual(expect.arrayContaining([
      "session.json: JWT claim 校验异常: iss,aud,nbf",
    ]));
  });

  it("preserves non-session JSON identity fields ahead of JWT claims", () => {
    const accessToken = fakeJwt({
      iss: "https://auth.openai.com",
      aud: ["https://api.openai.com/v1"],
      sub: "claim-user",
      exp: 1783000800,
      "https://api.openai.com/auth": {
        chatgpt_account_id: "acct_from_claim",
        chatgpt_user_id: "user-from-claim",
        chatgpt_plan_type: "plus",
      },
    });

    const result = normalizeInput(
      {
        type: "codex",
        access_token: accessToken,
        refresh_token: "refresh-token",
        account_id: "acct_from_json",
        chatgpt_user_id: "user-from-json",
        issuer: "https://stored.example",
        email: "json@example.com",
        plan_type: "free",
      },
      { sourceName: "cpa.json", sourcePath: "cpa.json" },
    );

    expect(result.accounts[0]).toMatchObject({
      inputFormat: "cpa",
      accountId: "acct_from_json",
      chatgptAccountId: "acct_from_claim",
      chatgptUserId: "user-from-json",
      chatgptAccountUserId: "user-from-json__acct_from_claim",
      issuer: "https://stored.example",
      email: "json@example.com",
      planType: "free",
      expiresAt: "2026-07-02T14:00:00.000Z",
    });
    expect(result.warnings).not.toEqual(expect.arrayContaining([
      "cpa.json: JWT claim 校验异常: iss",
    ]));
  });

  it("overrides stale ChatGPT session account fields with access token claims and warns", () => {
    const accessToken = fakeJwt({
      sub: "auth0|session-user",
      exp: 1783000800,
      workspace_id: "workspace_from_access_top",
      "https://api.openai.com/profile": {
        email: "access-profile@example.com",
      },
      "https://api.openai.com/auth": {
        chatgpt_account_id: "acct_from_access",
        chatgpt_user_id: "user-from-access",
        user_id: "user-from-access",
        chatgpt_plan_type: "k12",
        workspace_id: "workspace_from_access_auth",
      },
    });

    const result = normalizeInput(
      {
        accessToken,
        sessionToken: "session-token",
        expires: "2099-01-01T00:00:00.000Z",
        user: { id: "auth0|session-user", email: "session@example.com" },
        account: {
          id: "acct_from_json",
          planType: "free",
          workspaceId: "workspace_from_json",
        },
      },
      { sourceName: "session.json", sourcePath: "session.json" },
      { locale: "zh" },
    );

    expect(result.accounts[0]).toMatchObject({
      accountId: "acct_from_access",
      chatgptAccountId: "acct_from_access",
      chatgptUserId: "user-from-access",
      planType: "k12",
      email: "access-profile@example.com",
      workspaceId: "workspace_from_access_top",
      expiresAt: "2026-07-02T14:00:00.000Z",
    });
    expect(result.warnings).toEqual(expect.arrayContaining([
      "session.json: access_token claim 不一致，覆盖字段: account_id,chatgpt_user_id,plan_type,email,workspace_id,expires_at",
      "session.json: 已生成合成 id_token",
      "session.json: 缺少 refresh_token",
    ]));
  });

  it("generates a marked synthetic id_token when claims can be derived", () => {
    const accessToken = fakeJwt({
      email: "derived@example.com",
      sub: "derived-user",
      exp: 4102444800,
      "https://api.openai.com/auth": {
        chatgpt_account_id: "acct_derived",
        chatgpt_user_id: "derived-user",
      },
    });

    const account = normalizeInput(
      {
        access_token: accessToken,
        refresh_token: "refresh-token",
      },
      { sourceName: "stdin", sourcePath: "stdin" },
    ).accounts[0];

    expect(account.idTokenSynthetic).toBe(true);
    expect(account.idToken).toMatch(/^[^.]+\.[^.]+\.[^.]+$/);
    expect(decodeJwtPayload(account.idToken)).toMatchObject({
      iat: 0,
      sub: "derived-user",
      email: "derived@example.com",
      "https://api.openai.com/auth": {
        chatgpt_account_id: "acct_derived",
        chatgpt_user_id: "derived-user",
      },
    });

    expect(renderFormat([account], "cpa")).toMatchObject({
      disabled: false,
      refresh_token: "refresh-token",
      id_token_synthetic: true,
    });
    expect(renderFormat([account], "sub2api").accounts[0].extra).toMatchObject({
      id_token_synthetic: true,
    });
    expect(renderFormat([account], "codex2api")[0]).not.toHaveProperty("id_token_synthetic");
    expect(renderFormat([account], "codexmanager")).toMatchObject({
      tokens: {
        id_token: expect.any(String),
      },
      meta: expect.not.objectContaining({
        id_token_synthetic: true,
      }),
    });
    expect(renderFormat([account], "codex")).toMatchObject({
      tokens: {
        id_token: expect.any(String),
      },
    });
  });

  it("suppresses generated synthetic id_token at render time when disabled", () => {
    const accessToken = fakeJwt({
      email: "derived@example.com",
      sub: "derived-user",
      exp: 4102444800,
    });

    const account = normalizeInput(
      {
        access_token: accessToken,
        refresh_token: "refresh-token",
      },
      { sourceName: "stdin", sourcePath: "stdin" },
    ).accounts[0];

    expect(account.idTokenSynthetic).toBe(true);
    expect(account.idToken).toEqual(expect.any(String));

    expect(renderFormat([account], "cpa", { allowSyntheticIdToken: false })).toMatchObject({
      id_token: "",
      access_token: accessToken,
      refresh_token: "refresh-token",
    });
    expect(renderFormat([account], "cpa", { allowSyntheticIdToken: false })).not.toHaveProperty("id_token_synthetic");
    expect(renderFormat([account], "codex", { allowSyntheticIdToken: false })).toMatchObject({
      tokens: {
        id_token: "",
        access_token: accessToken,
        refresh_token: "refresh-token",
      },
    });
    expect(renderFormat([account], "codex2api", { allowSyntheticIdToken: false })).toEqual([
      {
        name: "derived@example.com",
        email: "derived@example.com",
        refresh_token: "refresh-token",
        access_token: accessToken,
        expires_at: "2100-01-01T00:00:00.000Z",
      },
    ]);
    expect(renderFormat([account], "sub2api", { allowSyntheticIdToken: false }).accounts[0]).toMatchObject({
      credentials: {
        access_token: accessToken,
        refresh_token: "refresh-token",
        expires_at: "2100-01-01T00:00:00.000Z",
        email: "derived@example.com",
      },
      extra: {
        import_source: "authconv",
      },
    });
    expect(renderFormat([account], "sub2api", { allowSyntheticIdToken: false }).accounts[0].extra).not.toHaveProperty("id_token_synthetic");
    expect(renderFormat([account], "codexmanager", { allowSyntheticIdToken: false })).toMatchObject({
      tokens: {
        access_token: accessToken,
        refresh_token: "refresh-token",
      },
    });
    const codexManagerWithoutSynthetic = renderFormat([account], "codexmanager", { allowSyntheticIdToken: false }) as {
      tokens: Record<string, unknown>;
    };
    expect(codexManagerWithoutSynthetic.tokens).not.toHaveProperty("id_token");
  });

  it("signs existing synthetic id_token and can suppress it at render time", () => {
    const syntheticIdToken = fakeJwt({ email: "signed@example.com" }).replace(/\.[^.]+$/, ".");
    const signedAccount = normalizeInput(
      {
        access_token: "access-token",
        id_token: syntheticIdToken,
        id_token_synthetic: true,
        email: "signed@example.com",
      },
      { sourceName: "cpa.json", sourcePath: "cpa.json" },
    ).accounts[0];

    expect(signedAccount.idToken?.split(".")[2]).not.toBe("");
    expect(signedAccount.idTokenSynthetic).toBe(true);
    expect(renderFormat([signedAccount], "cpa", { allowSyntheticIdToken: false })).toMatchObject({
      id_token: "",
      access_token: "access-token",
    });
  });

  it("normalizes Codex auth.json and keeps access token auth claims ahead of stored account_id", () => {
    const idToken = fakeJwt({
      email: "id@example.com",
      sub: "user-from-id",
      exp: 4102444800,
      "https://api.openai.com/auth": {
        chatgpt_account_id: "acct_from_id_token",
        chatgpt_user_id: "user-from-id",
        chatgpt_plan_type: "team",
      },
    });
    const accessToken = fakeJwt({
      email: "access@example.com",
      sub: "user-from-access",
      exp: 1783000800,
      "https://api.openai.com/auth": {
        chatgpt_account_id: "acct_from_access_token",
        chatgpt_user_id: "user-from-access",
        chatgpt_plan_type: "plus",
      },
    });

    const result = normalizeInput(
      {
        auth_mode: "chatgpt",
        OPENAI_API_KEY: null,
        tokens: {
          id_token: idToken,
          access_token: accessToken,
          refresh_token: "refresh-token",
          account_id: "acct_from_file",
        },
        last_refresh: "2026-07-04T11:03:02.000Z",
      },
      { sourceName: "auth.json", sourcePath: "auth.json" },
    );
    const account = result.accounts[0];

    expect(result.inputFormat).toBe("codex");
    expect(account).toMatchObject({
      inputFormat: "codex",
      accessToken,
      refreshToken: "refresh-token",
      idToken,
      accountId: "acct_from_access_token",
      chatgptAccountId: "acct_from_access_token",
      chatgptUserId: "user-from-access",
      email: "access@example.com",
      planType: "plus",
      lastRefresh: "2026-07-04T11:03:02.000Z",
      expiresAt: "2026-07-02T14:00:00.000Z",
    });
    expect(renderFormat([account], "codex", { now: new Date("2026-07-05T00:00:00.000Z") })).toEqual({
      auth_mode: "chatgpt",
      OPENAI_API_KEY: null,
      tokens: {
        id_token: idToken,
        access_token: accessToken,
        refresh_token: "refresh-token",
        account_id: "acct_from_access_token",
      },
      last_refresh: "2026-07-04T11:03:02.000Z",
    });
  });

  it("plans merged and split files with stable names", () => {
    const accounts = normalizeInput(
      [
        { access_token: "a", email: "first@example.com", account_id: "acctfirst123456" },
        { access_token: "b", email: "second@example.com", account_id: "acctsecond123456" },
      ],
      { sourceName: "accounts.json", sourcePath: "accounts.json" },
    ).accounts;

    const files = buildOutputPlan(accounts, ["sub2api", "codex2api", "cpa", "codexmanager", "codex"]);

    expect(files.map((file) => file.path)).toEqual([
      "sub2api/sub2api_2-accounts.json",
      "codex2api/codex2api_2-accounts.json",
      "cpa/cpa_first_example.com_acctfirst123.json",
      "cpa/cpa_second_example.com_acctsecond12.json",
      "codexmanager/codex-manager_first_example.com_acctfirst123.json",
      "codexmanager/codex-manager_second_example.com_acctsecond12.json",
      "codex/codex_first_example.com_acctfirst123.json",
      "codex/codex_second_example.com_acctsecond12.json",
    ]);
  });

  it("omits format folders when only one output format is selected", () => {
    const accounts = normalizeInput(
      [
        { access_token: "a", email: "first@example.com", account_id: "acctfirst123456" },
        { access_token: "b", email: "second@example.com", account_id: "acctsecond123456" },
      ],
      { sourceName: "accounts.json", sourcePath: "accounts.json" },
    ).accounts;

    expect(buildOutputPlan(accounts, ["cpa"]).map((file) => file.path)).toEqual([
      "cpa_first_example.com_acctfirst123.json",
      "cpa_second_example.com_acctsecond12.json",
    ]);
    expect(buildOutputPlan(accounts, ["sub2api"]).map((file) => file.path)).toEqual([
      "sub2api_2-accounts.json",
    ]);
  });

  it("serializes single-format multi-account output as one JSONL file", () => {
    const accounts = normalizeInput(
      [
        { access_token: "a", email: "first@example.com", account_id: "acctfirst123456" },
        { access_token: "b", email: "second@example.com", account_id: "acctsecond123456" },
      ],
      { sourceName: "accounts.json", sourcePath: "accounts.json" },
    ).accounts;

    const files = serializeOutputFiles(buildOutputPlan(accounts, ["cpa"]), "jsonl");

    expect(files.map((file) => file.path)).toEqual(["cpa_2-accounts.jsonl"]);
    const lines = files[0].text.trimEnd().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines.map((line) => JSON.parse(line) as { email: string })).toEqual([
      expect.objectContaining({ email: "first@example.com" }),
      expect.objectContaining({ email: "second@example.com" }),
    ]);
  });

  it("serializes multi-format output as one JSONL file per format folder", () => {
    const accounts = normalizeInput(
      [
        { access_token: "a", email: "first@example.com", account_id: "acctfirst123456" },
        { access_token: "b", email: "second@example.com", account_id: "acctsecond123456" },
      ],
      { sourceName: "accounts.json", sourcePath: "accounts.json" },
    ).accounts;

    const files = serializeOutputFiles(buildOutputPlan(accounts, ["cpa", "sub2api"], {
      outputModes: effectiveOutputModes({ sub2api: "merged" }, "jsonl"),
    }), "jsonl");

    expect(files.map((file) => file.path)).toEqual([
      "cpa/cpa_2-accounts.jsonl",
      "sub2api/sub2api_2-accounts.jsonl",
    ]);
    expect(files[0].text.trimEnd().split("\n")).toHaveLength(2);
    const sub2apiLines = files[1].text.trimEnd().split("\n");
    expect(sub2apiLines).toHaveLength(2);
    expect(JSON.parse(sub2apiLines[0]) as { accounts: unknown[] }).toMatchObject({
      accounts: [expect.any(Object)],
    });
    expect(JSON.parse(sub2apiLines[1]) as { accounts: unknown[] }).toMatchObject({
      accounts: [expect.any(Object)],
    });
  });

  it("plans single-account files for merged formats when requested", () => {
    const accounts = normalizeInput(
      [
        { access_token: "a", email: "first@example.com", account_id: "acctfirst123456" },
        { access_token: "b", email: "second@example.com", account_id: "acctsecond123456" },
      ],
      { sourceName: "accounts.json", sourcePath: "accounts.json" },
    ).accounts;

    const files = buildOutputPlan(accounts, ["sub2api", "codex2api"], {
      outputModes: {
        sub2api: "single",
        codex2api: "single",
      },
    });

    expect(files.map((file) => file.path)).toEqual([
      "sub2api/sub2api_first_example.com_acctfirst123.json",
      "sub2api/sub2api_second_example.com_acctsecond12.json",
      "codex2api/codex2api_first_example.com_acctfirst123.json",
      "codex2api/codex2api_second_example.com_acctsecond12.json",
    ]);
    expect(files.every((file) => file.accountCount === 1)).toBe(true);
  });

  it("parses duplicate format flags and expands all", () => {
    expect(parseFormatList(["cpa,sub2api", "cpa", "all"])).toEqual([
      "cpa",
      "sub2api",
      "codex2api",
      "codexmanager",
      "codex",
    ]);
  });

  it("detects supported input formats for default output decisions", () => {
    const cases = [
      [
        {
          accessToken: "some-access-token",
          user: { id: "123" },
          sessionToken: "some-session-token",
        },
        "session",
      ],
      [
        {
          accounts: [
            {
              name: "a",
              credentials: { access_token: "token" },
            },
          ],
        },
        "sub2api",
      ],
      [
        {
          type: "codex",
          access_token: "token",
        },
        "cpa",
      ],
      [
        {
          tokens: { access_token: "token" },
          meta: { label: "account" },
        },
        "codexmanager",
      ],
      [
        {
          auth_mode: "chatgpt",
          OPENAI_API_KEY: null,
          tokens: { access_token: "token", account_id: "account" },
          last_refresh: "2026-07-04T00:00:00.000Z",
        },
        "codex",
      ],
      [
        [
          {
            access_token: "access",
            session_token: "session",
            id_token: "id",
          },
        ],
        "codex2api",
      ],
      [
        {
          access_token: "access",
          session_token: "session",
          id_token: "id",
        },
        "codex2api",
      ],
      [
        {
          type: "not-codex",
          access_token: "token",
        },
        "unknown",
      ],
      [{ access_token: "token" }, "unknown"],
    ] as const;

    for (const [input, expected] of cases) {
      expect(detectInputFormat(input)).toBe(expected);
    }
  });

  it("does not auto-detect aggregate-like objects as codex2api singles", () => {
    expect(detectInputFormat({
      refresh_token: "token",
      session_token: "session",
      accounts: [],
    })).toBe("unknown");
  });

  it("uses a selected input format as the parsing strategy", () => {
    const source = { sourceName: "input.json", sourcePath: "input.json" };
    const sub2apiInput = {
      type: "sub2api-data",
      accounts: [
        {
          name: "Sub Account",
          credentials: {
            access_token: "sub-access-token",
            email: "sub@example.com",
          },
        },
      ],
    };

    expect(normalizeInput(sub2apiInput, source, { inputFormat: "sub2api" }).accounts).toHaveLength(1);

    const forcedCpa = normalizeInput(sub2apiInput, source, { inputFormat: "cpa" });
    expect(forcedCpa.accounts).toHaveLength(0);
    expect(forcedCpa.warnings.length).toBeGreaterThan(0);
  });

  it("preserves session_token-only input in sub2api credentials", () => {
    const account = normalizeInput(
      { session_token: "session-only" },
      { sourceName: "session.json", sourcePath: "session.json" },
    ).accounts[0];

    expect(renderFormat([account], "sub2api").accounts[0]).toMatchObject({
      name: "authconv-account",
      credentials: {
        session_token: "session-only",
      },
      extra: {
        import_source: "authconv",
      },
    });
  });

  it("keeps session_token-only output explicit across target formats", () => {
    const account = normalizeInput(
      { session_token: "session-only" },
      { sourceName: "session.json", sourcePath: "session.json" },
    ).accounts[0];

    expect(renderFormat([account], "cpa")).toMatchObject({
      type: "codex",
      session_token: "session-only",
    });
    expect(renderFormat([account], "codex2api")).toEqual([
      {
        session_token: "session-only",
      },
    ]);
    expect(renderFormat([account], "sub2api").accounts[0].credentials).toEqual({
      session_token: "session-only",
    });
    expect(renderFormat([account], "codexmanager")).toMatchObject({
      tokens: {},
      meta: {
        issuer: "https://auth.openai.com",
        tags: ["authconv"],
      },
    });
    expect(renderFormat([account], "codex")).toMatchObject({
      auth_mode: "chatgpt",
      OPENAI_API_KEY: null,
      tokens: {
        id_token: "",
        access_token: "",
        refresh_token: "",
        account_id: "",
      },
    });
  });

  it("preserves CPA timestamp strings and synthetic marker when rendering CPA back to CPA", () => {
    const input = {
      type: "codex",
      email: "cpa@example.com",
      account_id: "acct_cpa",
      plan_type: "team",
      id_token: "synthetic-id-token",
      access_token: "access-token",
      refresh_token: "",
      expired: "2026-07-14T11:02:59Z",
      last_refresh: "2026-07-04T11:03:02Z",
      disabled: false,
      id_token_synthetic: true,
    };
    const account = normalizeInput(input, { sourceName: "cpa.json", sourcePath: "cpa.json" }).accounts[0];

    expect(renderFormat([account], "cpa")).toEqual(input);
  });

  it("adds a warning when the expires_at date cannot be parsed", () => {
    const input = {
      access_token: "access",
      expires_at: "not-a-valid-date",
    };
    const result = normalizeInput(input, { sourceName: "test.json", sourcePath: "test.json" });
    expect(result.accounts[0].warnings.length).toBeGreaterThan(0);
  });

  it("dedupes accounts when credential fields are compatible", async () => {
    const { dedupeAccounts } = await import("../src/index.js");
    const idToken = fakeJwt({ email: "a@example.com" });
    const accounts = [
      normalizeInput(
        {
          access_token: "token-a",
          email: "a@example.com",
        },
        { sourceName: "file1.json", sourcePath: "file1.json" },
      ).accounts[0],
      normalizeInput(
        {
          access_token: "token-a",
          refresh_token: "refresh-a",
          session_token: "session-a",
          id_token: idToken,
          email: "a@example.com",
          name: "Account A",
        },
        { sourceName: "file2.json", sourcePath: "file2.json" },
      ).accounts[0],
      normalizeInput({ access_token: "token-b", email: "b@example.com" }, { sourceName: "file3.json", sourcePath: "file3.json" }).accounts[0],
    ];
    const deduped = dedupeAccounts(accounts);
    expect(deduped).toHaveLength(2);
    expect(deduped[0].email).toBe("a@example.com");
    expect(deduped[0].refreshToken).toBe("refresh-a");
    expect(deduped[0].sessionToken).toBe("session-a");
    expect(deduped[0].idToken).toBe(idToken);
    expect(deduped[0].name).toBe("Account A");
    expect(deduped[0].sourceName).toBe("file1.json");
    expect(deduped[1].email).toBe("b@example.com");
  });

  it("does not dedupe accounts when shared credential fields conflict", async () => {
    const { dedupeAccounts } = await import("../src/index.js");
    const accounts = [
      normalizeInput({ access_token: "same-access", session_token: "session-a", email: "a@example.com" }, { sourceName: "a.json", sourcePath: "a.json" }).accounts[0],
      normalizeInput({ access_token: "same-access", session_token: "session-b", email: "b@example.com" }, { sourceName: "b.json", sourcePath: "b.json" }).accounts[0],
    ];
    const deduped = dedupeAccounts(accounts);
    expect(deduped).toHaveLength(2);
  });

  it("does not dedupe accounts without any shared credential field", async () => {
    const { dedupeAccounts } = await import("../src/index.js");
    const accounts = [
      normalizeInput({ refresh_token: "refresh-token", email: "refresh-only@example.com" }, { sourceName: "refresh.json", sourcePath: "refresh.json" }).accounts[0],
      normalizeInput({ session_token: "session-token", email: "session-only@example.com" }, { sourceName: "session.json", sourcePath: "session.json" }).accounts[0],
    ];
    const deduped = dedupeAccounts(accounts);
    expect(deduped).toHaveLength(2);
  });

  it("dedupes accounts through a later bridge credential", async () => {
    const { dedupeAccounts } = await import("../src/index.js");
    const accounts = [
      normalizeInput({ refresh_token: "refresh-token", email: "refresh-only@example.com" }, { sourceName: "refresh.json", sourcePath: "refresh.json" }).accounts[0],
      normalizeInput({ session_token: "session-token", email: "session-only@example.com" }, { sourceName: "session.json", sourcePath: "session.json" }).accounts[0],
      normalizeInput({ refresh_token: "refresh-token", session_token: "session-token" }, { sourceName: "bridge.json", sourcePath: "bridge.json" }).accounts[0],
    ];
    const deduped = dedupeAccounts(accounts);
    expect(deduped).toHaveLength(1);
    expect(deduped[0].email).toBe("refresh-only@example.com");
    expect(deduped[0].sessionToken).toBe("session-token");
  });

  it("reports the existing row affected by a duplicate import", async () => {
    const { dedupeAccountsWithAffectedIndex } = await import("../src/index.js");
    const accounts = [
      normalizeInput({ access_token: "token-a", email: "a@example.com" }, { sourceName: "a.json", sourcePath: "a.json" }).accounts[0],
      normalizeInput({ access_token: "token-b", email: "b@example.com" }, { sourceName: "b.json", sourcePath: "b.json" }).accounts[0],
      normalizeInput({ access_token: "token-a", refresh_token: "refresh-a" }, { sourceName: "duplicate.json", sourcePath: "duplicate.json" }).accounts[0],
    ];

    const result = dedupeAccountsWithAffectedIndex(accounts, 2);

    expect(result.accounts).toHaveLength(2);
    expect(result.affectedIndex).toBe(0);
    expect(result.accounts[0].refreshToken).toBe("refresh-a");
  });

  it("reports the retained row affected by a bridge import", async () => {
    const { dedupeAccountsWithAffectedIndex } = await import("../src/index.js");
    const accounts = [
      normalizeInput({ refresh_token: "refresh-token", email: "refresh-only@example.com" }, { sourceName: "refresh.json", sourcePath: "refresh.json" }).accounts[0],
      normalizeInput({ session_token: "session-token", email: "session-only@example.com" }, { sourceName: "session.json", sourcePath: "session.json" }).accounts[0],
      normalizeInput({ refresh_token: "refresh-token", session_token: "session-token" }, { sourceName: "bridge.json", sourcePath: "bridge.json" }).accounts[0],
    ];

    const result = dedupeAccountsWithAffectedIndex(accounts, 2);

    expect(result.accounts).toHaveLength(1);
    expect(result.affectedIndex).toBe(0);
    expect(result.accounts[0].sessionToken).toBe("session-token");
  });

  it("replaces a compatible synthetic id_token with a real id_token", async () => {
    const { dedupeAccounts } = await import("../src/index.js");
    const synthetic = normalizeInput({
      access_token: "same-access",
      email: "same@example.com",
    }, { sourceName: "synthetic.json", sourcePath: "synthetic.json" }).accounts[0];
    const real = normalizeInput({
      access_token: "same-access",
      id_token: fakeJwt({ email: "same@example.com" }),
      email: "same@example.com",
    }, { sourceName: "real.json", sourcePath: "real.json" }).accounts[0];

    const [deduped] = dedupeAccounts([synthetic, real]);
    expect(deduped.idToken).toBe(real.idToken);
    expect(deduped.idTokenSynthetic).toBe(false);
  });

  it("treats accounts with different tokens as distinct even if email matches", async () => {
    const { dedupeAccounts } = await import("../src/index.js");
    const accounts = [
      normalizeInput({ access_token: "token-a", email: "same@example.com" }, { sourceName: "a.json", sourcePath: "a.json" }).accounts[0],
      normalizeInput({ access_token: "token-b", email: "same@example.com" }, { sourceName: "b.json", sourcePath: "b.json" }).accounts[0],
    ];
    const deduped = dedupeAccounts(accounts);
    expect(deduped).toHaveLength(2);
  });

  it("does not dedupe records without stable credentials", async () => {
    const { dedupeAccounts } = await import("../src/index.js");
    const accounts = [
      normalizeInput(
        { id_token: fakeJwt({ email: "same@example.com" }), id_token_synthetic: true },
        { sourceName: "a.json", sourcePath: "a.json" },
      ).accounts[0],
      normalizeInput(
        { id_token: fakeJwt({ email: "same@example.com" }), id_token_synthetic: true },
        { sourceName: "b.json", sourcePath: "b.json" },
      ).accounts[0],
    ];
    const deduped = dedupeAccounts(accounts);
    expect(deduped).toHaveLength(2);
  });
});
