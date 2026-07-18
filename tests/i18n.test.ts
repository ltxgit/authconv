import { describe, expect, it } from "vitest";
import { detectCliLocale, detectWebLocale, messagesFor } from "../src/index.js";

describe("authconv i18n", () => {
  it("defaults CLI language to Chinese without explicit selection", () => {
    expect(detectCliLocale(undefined, {})).toBe("zh");
  });

  it("uses system locale before falling back to Chinese", () => {
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

  it("defaults Web language to Chinese without a URL parameter", () => {
    expect(detectWebLocale("")).toBe("zh");
    expect(detectWebLocale("?lang=zh")).toBe("zh");
  });

  it("reports per-operation import and forged-skip counts", () => {
    expect(messagesFor("zh").web.fileImported(4, 2, 1, 1)).toBe("读取 4 · 新增 2 · 合并 1 · 跳过伪造 1");
    expect(messagesFor("en").web.fileImported(4, 2, 1, 1)).toBe("Read 4 · Added 2 · Merged 1 · Skipped forged 1");
  });
});
