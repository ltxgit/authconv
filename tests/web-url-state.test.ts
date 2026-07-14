import { describe, expect, it } from "vitest";
import { outputOptionsUrl, parseOutputOptionsSearch } from "../src/web/url-state.js";

describe("web URL output options", () => {
  it("round-trips Grok selection and output mode", () => {
    const url = outputOptionsUrl("https://example.test/tool", {
      selectedFormats: ["grok", "cpa"],
      outputTextMode: "json",
      outputModes: { grok: "single" },
      previewFormat: "grok",
    });
    expect(parseOutputOptionsSearch(new URL(url).search)).toMatchObject({
      selectedFormats: ["cpa", "grok"],
      outputModes: { sub2api: "merged", codex2api: "merged", grok: "single" },
      previewFormat: "grok",
    });
  });
  it("parses output options from query parameters", () => {
    expect(
      parseOutputOptionsSearch(
        "?format=sub2api,cpa,sub2api&text=jsonl&mode=sub2api:single,codex2api:merged&preview=sub2api&lang=en",
      ),
    ).toEqual({
      selectedFormats: ["cpa", "sub2api"],
      outputTextMode: "jsonl",
      outputModes: {
        sub2api: "single",
        codex2api: "merged",
      },
      previewFormat: "sub2api",
      locale: "en",
    });
  });

  it("writes output options without removing unrelated URL state", () => {
    expect(
      outputOptionsUrl("https://example.test/tool?keep=1#local", {
        selectedFormats: ["sub2api", "cpa"],
        outputTextMode: "jsonl",
        outputModes: {
          sub2api: "merged",
          codex2api: "merged",
        },
        previewFormat: "cpa",
        locale: "en",
      }),
    ).toBe(
      "https://example.test/tool?keep=1&format=cpa%2Csub2api&text=jsonl&mode=sub2api%3Asingle%2Ccodex2api%3Asingle%2Cgrok%3Asingle&preview=cpa&lang=en#local",
    );
  });

  it("writes Chinese locale so refresh keeps the selected language", () => {
    expect(
      outputOptionsUrl("https://example.test/tool", {
        selectedFormats: ["cpa"],
        outputTextMode: "json",
        outputModes: {},
        previewFormat: "cpa",
        locale: "zh",
      }),
    ).toBe("https://example.test/tool?format=cpa&text=json&mode=sub2api%3Amerged%2Ccodex2api%3Amerged%2Cgrok%3Amerged&preview=cpa&lang=zh");
  });

  it("keeps an explicitly empty format selection", () => {
    expect(
      outputOptionsUrl("https://example.test/tool", {
        selectedFormats: [],
        outputTextMode: "json",
        outputModes: {},
        previewFormat: "cpa",
      }),
    ).toBe("https://example.test/tool?format=none&text=json&mode=sub2api%3Amerged%2Ccodex2api%3Amerged%2Cgrok%3Amerged&preview=cpa");
    expect(parseOutputOptionsSearch("?format=none")).toEqual({
      selectedFormats: [],
    });
  });

  it("parses and writes fakeid option correctly", () => {
    expect(parseOutputOptionsSearch("?fakeid=false")).toEqual({
      allowSyntheticIdToken: false,
    });
    expect(parseOutputOptionsSearch("?fakeid=true")).toEqual({
      allowSyntheticIdToken: true,
    });
    expect(
      outputOptionsUrl("https://example.test/tool", {
        selectedFormats: [],
        outputTextMode: "json",
        outputModes: {},
        previewFormat: "cpa",
        allowSyntheticIdToken: false,
      }),
    ).toBe("https://example.test/tool?format=none&text=json&mode=sub2api%3Amerged%2Ccodex2api%3Amerged%2Cgrok%3Amerged&preview=cpa&fakeid=false");
  });

  it("round-trips the refresh_token output option", () => {
    expect(parseOutputOptionsSearch("?refresh=false")).toEqual({
      includeRefreshToken: false,
    });
    expect(
      outputOptionsUrl("https://example.test/tool", {
        selectedFormats: ["cpa"],
        outputTextMode: "json",
        outputModes: {},
        previewFormat: "cpa",
        includeRefreshToken: false,
      }),
    ).toBe("https://example.test/tool?format=cpa&text=json&mode=sub2api%3Amerged%2Ccodex2api%3Amerged%2Cgrok%3Amerged&preview=cpa&refresh=false");
  });
});
