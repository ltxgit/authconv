import { describe, expect, it } from "vitest";
import type { NormalizedAccount } from "../src/types.js";
import { zipDownloadName } from "../src/download-names.js";

function account(input: Partial<NormalizedAccount>): NormalizedAccount {
  return {
    sourceName: "test",
    sourcePath: "test.json",
    warnings: [],
    ...input,
  };
}

describe("web download names", () => {
  const now = new Date(2026, 6, 4, 1, 16, 0);

  it("uses account count for multi-account zip names", () => {
    expect(zipDownloadName([
      account({ email: "first@example.com" }),
      account({ email: "second@example.com" }),
      account({ email: "third@example.com" }),
    ], now)).toBe("authconv_3-accounts_20260704011600.zip");
  });

  it("uses identity and short account id for single-account multi-format zip names", () => {
    expect(zipDownloadName([
      account({
        email: "tranloan06481+3@gmail.com",
        chatgptAccountId: "codex-auth-account-123456",
      }),
    ], now)).toBe("authconv_tranloan06481_3_gmail.com_codex-auth-a_20260704011600.zip");
  });
});
