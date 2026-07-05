import { strFromU8, unzipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { serializeOutputFiles, zipOutputFiles } from "../src/index.js";
import type { OutputFile } from "../src/index.js";

describe("zip output", () => {
  it("creates a readable archive for multi-file downloads", () => {
    const files: OutputFile[] = [
      {
        path: "cpa/user-example-com.json",
        format: "cpa",
        content: { access_token: "access-token" },
        accountCount: 1,
      },
      {
        path: "sub2api/user-example-com-1-account.json",
        format: "sub2api",
        content: { type: "sub2api-data", accounts: [] },
        accountCount: 1,
      },
    ];

    const archive = unzipSync(zipOutputFiles(serializeOutputFiles(files, "json")));

    expect(JSON.parse(strFromU8(archive["cpa/user-example-com.json"]))).toEqual({
      access_token: "access-token",
    });
    expect(JSON.parse(strFromU8(archive["sub2api/user-example-com-1-account.json"]))).toEqual({
      type: "sub2api-data",
      accounts: [],
    });
  });

  it("stores JSONL text files in archives", () => {
    const files: OutputFile[] = [
      {
        path: "cpa/user-a.json",
        format: "cpa",
        content: { access_token: "access-token-a" },
        accountCount: 1,
      },
      {
        path: "cpa/user-b.json",
        format: "cpa",
        content: { access_token: "access-token-b" },
        accountCount: 1,
      },
    ];

    const archive = unzipSync(zipOutputFiles(serializeOutputFiles(files, "jsonl")));
    const lines = strFromU8(archive["cpa/cpa_2-accounts.jsonl"]).trimEnd().split("\n");

    expect(lines.map((line) => JSON.parse(line) as { access_token: string })).toEqual([
      { access_token: "access-token-a" },
      { access_token: "access-token-b" },
    ]);
  });
});
