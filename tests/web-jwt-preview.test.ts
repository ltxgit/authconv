import { describe, expect, it } from "vitest";
import { messagesFor } from "../src/i18n.js";
import { decodeJwtParts } from "../src/jwt.js";
import { jwtPopoverText } from "../src/web/jwt-preview.js";
import {
  accountListHeight,
  accountRowsSelectable,
  highlightJson,
  platformMarkSvg,
  selectAccountForRange,
  shouldShowVerificationBadge,
  shouldRequireVisibleSelection,
  shouldResetViewportForPreferredAccount,
  themeIconSvg,
  WebView,
} from "../src/web/view.js";

function fakeJwt(header: Record<string, unknown>, payload: Record<string, unknown>): string {
  const encode = (value: Record<string, unknown>) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode(header)}.${encode(payload)}.signature`;
}

describe("web JWT preview", () => {
  it("decodes both JWT header and payload without treating an opaque token as JWT", () => {
    const token = fakeJwt({ alg: "RS256", typ: "JWT" }, { iss: "https://auth.x.ai", sub: "xai-user" });

    expect(decodeJwtParts(token)).toEqual({
      header: { alg: "RS256", typ: "JWT" },
      payload: { iss: "https://auth.x.ai", sub: "xai-user" },
    });
    expect(decodeJwtParts("opaque-access-token")).toBeUndefined();
  });

  it("builds a hover preview for one JWT string", () => {
    const token = fakeJwt({ alg: "RS256" }, { sub: "access-user" });

    expect(jwtPopoverText(token)).toBe([
      "Header",
      JSON.stringify({ alg: "RS256" }, null, 2),
      "Payload",
      JSON.stringify({ sub: "access-user" }, null, 2),
    ].join("\n"));
  });

  it("returns no hover preview for an opaque token", () => {
    expect(jwtPopoverText("opaque-token")).toBeUndefined();
  });

  it("only marks decodable JWT strings as hoverable", () => {
    const token = fakeJwt({ alg: "RS256" }, { sub: "preview-user" });

    expect(highlightJson(JSON.stringify({ token }))).toContain("jwt-token-hoverable");
    expect(highlightJson(JSON.stringify({ token: "a.b.c" }))).not.toContain("jwt-token-hoverable");
    expect(highlightJson(JSON.stringify({ token: `${token}\" onmouseover=\"alert(1)` }))).not.toContain("jwt-token-hoverable");
  });

  it("keeps the complete OpenAI platform mark", () => {
    expect(platformMarkSvg("openai")).toContain("zm-9.022 12.6081");
  });

  it("selects the first visible account only for per-account previews", () => {
    const items = [
      { id: "bob" },
      { id: "brenda" },
    ];

    expect(selectAccountForRange("alice", items, true, true)).toBe("bob");
    expect(selectAccountForRange("bob", items, true, true)).toBe("bob");
    expect(selectAccountForRange("alice", [], true, true)).toBeUndefined();
    expect(selectAccountForRange("alice", items, false, true)).toBe("alice");
    expect(selectAccountForRange(undefined, [], false, true)).toBeUndefined();
    expect(selectAccountForRange("bob", items, false, false)).toBeUndefined();
  });

  it("only constrains selection to the visible range while search is active", () => {
    expect(shouldRequireVisibleSelection("alice", true)).toBe(true);
    expect(shouldRequireVisibleSelection("", true)).toBe(false);
    expect(shouldRequireVisibleSelection("alice", false)).toBe(false);
    expect(shouldResetViewportForPreferredAccount("bob", "alice")).toBe(true);
    expect(shouldResetViewportForPreferredAccount("bob", "")).toBe(false);
    expect(shouldResetViewportForPreferredAccount(undefined, "alice")).toBe(false);
  });

  it("only enables account rows when the current preview can target one of multiple accounts", () => {
    const providers = { openai: 2, xai: 0, unknown: 0 };
    const state = {
      summary: { active: { total: 2, providerCounts: providers } },
      previewFormat: "sub2api" as const,
      textMode: "json" as const,
      outputModes: { sub2api: "merged" as const },
    };

    expect(accountRowsSelectable(state)).toBe(false);
    expect(accountRowsSelectable({ ...state, outputModes: { sub2api: "single" } })).toBe(true);
    expect(accountRowsSelectable({ ...state, textMode: "jsonl" })).toBe(true);
    expect(accountRowsSelectable({ ...state, previewFormat: "codex", outputModes: {}, summary: { active: { total: 2, providerCounts: providers } } })).toBe(true);
    expect(accountRowsSelectable({ ...state, previewFormat: "codex", outputModes: {}, summary: { active: { total: 2, providerCounts: { openai: 1, xai: 1, unknown: 0 } } } })).toBe(false);
    expect(accountRowsSelectable({ ...state, summary: { active: { total: 1, providerCounts: { openai: 1, xai: 0, unknown: 0 } } }, textMode: "jsonl" })).toBe(false);
  });

  it("sizes the virtual account viewport to at most four visible rows", () => {
    expect(accountListHeight(0, 52)).toBe(0);
    expect(accountListHeight(1, 52)).toBe(52);
    expect(accountListHeight(4, 52)).toBe(208);
    expect(accountListHeight(20, 52)).toBe(208);
  });

  it("hides normal verification noise while preserving actionable states", () => {
    expect(shouldShowVerificationBadge("unchecked")).toBe(false);
    expect(shouldShowVerificationBadge("verified")).toBe(false);
    expect(shouldShowVerificationBadge("forged")).toBe(true);
    expect(shouldShowVerificationBadge("unverifiable")).toBe(true);
  });

  it("omits zero-value merge and forged-skip clauses from import feedback", () => {
    expect(messagesFor("zh").web.fileImported(3, 3, 0, 0)).toBe("读取 3 · 新增 3");
    expect(messagesFor("en").web.fileImported(4, 2, 1, 1))
      .toBe("Read 4 · Added 2 · Merged 1 · Skipped forged 1");
  });

  it("uses a sun for light mode and a moon for dark mode", () => {
    expect(themeIconSvg("light")).toContain("<circle");
    expect(themeIconSvg("dark")).toContain("<path");
    expect(themeIconSvg("dark")).not.toContain("<circle");
  });

  it("locks the verification toggle during a task without reverting the pending user choice", () => {
    const verifyTokenToggle = { checked: true, disabled: false };
    const state = {
      textMode: "json" as const,
      allowSyntheticIdToken: true,
      includeRefreshToken: true,
      verifyTokens: false,
      busy: true,
    };
    const view = {
      state,
      elements: {
        jsonlToggle: { checked: false },
        fakeIdToggle: { checked: false },
        refreshTokenToggle: { checked: false },
        verifyTokenToggle,
      },
    };

    WebView.prototype.syncControls.call(view as unknown as WebView);
    expect(verifyTokenToggle).toEqual({ checked: true, disabled: true });

    state.busy = false;
    WebView.prototype.syncControls.call(view as unknown as WebView);
    expect(verifyTokenToggle).toEqual({ checked: false, disabled: false });
  });
});
