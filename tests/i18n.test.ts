import { describe, expect, it } from "vitest";
import { detectCliLocale, detectWebLocale, messagesFor } from "../src/index.js";

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

  it("reports import processed, added, and merged counts", () => {
    expect(messagesFor("zh").web.fileImported(3, 2, 1)).toBe("已读取 3 个账号，新增 2 个，合并重复 1 个");
    expect(messagesFor("en").web.fileImported(3, 2, 1)).toBe("Read 3 account(s), added 2, merged 1 duplicate(s)");
  });
});
