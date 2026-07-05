import { describe, expect, it } from "vitest";
import { detectCliLocale, detectWebLocale } from "../src/index.js";

describe("authconv i18n", () => {
  it("defaults CLI language to English without explicit selection", () => {
    expect(detectCliLocale(undefined, {})).toBe("en");
  });

  it("uses system locale before falling back to English", () => {
    expect(
      detectCliLocale(undefined, {
        LC_ALL: "zh_CN.UTF-8",
        LC_MESSAGES: "zh_CN.UTF-8",
        LANG: "zh_CN.UTF-8",
      }),
    ).toBe("zh");
  });

  it("keeps explicit CLI language selection", () => {
    expect(detectCliLocale("zh", {})).toBe("zh");
    expect(detectCliLocale(undefined, { AUTHCONV_LANG: "zh" })).toBe("zh");
  });

  it("defaults Web language to English without a URL parameter", () => {
    expect(detectWebLocale("")).toBe("en");
    expect(detectWebLocale("?lang=zh")).toBe("zh");
  });
});
