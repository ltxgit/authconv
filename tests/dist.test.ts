import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { checkDistHtml } from "../src/dist-check.js";

describe("dist checks", () => {
  it("detects unsafe dist HTML patterns", () => {
    const cases = [
      ['<script src="https://cdn.example/app.js"></script>', ["外部脚本", "CDN 引用"]],
      ["<script>__AUTHCONV_JS__</script>", ["未替换模板占位符"]],
      ["now:new Date(0)", ["固定导出时间戳"]],
    ] as const;

    for (const [html, labels] of cases) {
      expect(checkDistHtml(html)).toEqual(labels);
    }
  });

  it("keeps the committed dist HTML self-contained", async () => {
    const html = await readFile(new URL("../dist/index.html", import.meta.url), "utf8");
    expect(checkDistHtml(html)).toEqual([]);
  });
});
