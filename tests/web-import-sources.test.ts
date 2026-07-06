import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { extractZipJsonSources, isCredentialImportPath } from "../src/import-sources.js";

describe("web ZIP import sources", () => {
  it("extracts JSON and JSONL files from a ZIP archive", () => {
    const archive = zipSync({
      "cpa/account.json": strToU8(JSON.stringify({ access_token: "access-token" })),
      "sub2api/accounts.jsonl": strToU8(`${JSON.stringify({ access_token: "line-token" })}\n`),
      "notes.txt": strToU8("ignore"),
      "__MACOSX/cpa/account.json": strToU8("{}"),
      ".hidden/account.json": strToU8("{}"),
    });

    expect(extractZipJsonSources("bundle.zip", archive)).toEqual([
      {
        name: "bundle.zip/cpa/account.json",
        path: "bundle.zip/cpa/account.json",
        text: JSON.stringify({ access_token: "access-token" }),
      },
      {
        name: "bundle.zip/sub2api/accounts.jsonl",
        path: "bundle.zip/sub2api/accounts.jsonl",
        text: `${JSON.stringify({ access_token: "line-token" })}\n`,
      },
    ]);
  });

  it("accepts JSON, JSONL, and ZIP import paths", () => {
    expect(isCredentialImportPath("account.json")).toBe(true);
    expect(isCredentialImportPath("accounts.jsonl")).toBe(true);
    expect(isCredentialImportPath("authconv.zip")).toBe(true);
    expect(isCredentialImportPath("notes.txt")).toBe(false);
  });
});
