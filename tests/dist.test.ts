import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import rules from "../src/dist-check-rules.json" with { type: "json" };
import { checkDistHtml } from "../scripts/dist-check-core.mjs";

describe("dist checks", () => {
  it("detects unsafe dist HTML patterns", () => {
    const cases = [
      ['<script src="https://cdn.example/app.js"></script>', ["外部脚本", "CDN 引用"]],
      ["<script>__AUTHCONV_JS__</script>", ["未替换模板占位符"]],
      ["now:new Date(0)", ["固定导出时间戳"]],
      ["sessionStorage.setItem('token', value)", ["非偏好存储 API"]],
      ["localStorage.setItem('token', value)", ["非偏好 localStorage"]],
      [
        'var PREFERENCES_STORAGE_KEY = "authconv.preferences.v1"; const storage = globalThis.localStorage; storage.setItem(PREFERENCES_STORAGE_KEY, JSON.stringify({ token }));',
        ["非偏好 localStorage"],
      ],
      [
        'var PREFERENCES_STORAGE_KEY = "authconv.preferences.v1"; function browserPreferenceStorage(){ return globalThis.localStorage; } globalThis.localStorage.token = accessToken;',
        ["非偏好 localStorage"],
      ],
      [
        'var PREFERENCES_STORAGE_KEY = "authconv.preferences.v1"; function browserPreferenceStorage(){ return globalThis.localStorage; } localStorage["token"] = accessToken;',
        ["非偏好 localStorage"],
      ],
      [
        'var PREFERENCES_STORAGE_KEY = "authconv.preferences.v1"; function browserPreferenceStorage(){ return globalThis.localStorage; } storage["setItem"]("token", accessToken);',
        ["非偏好 localStorage"],
      ],
      [
        'var PREFERENCES_STORAGE_KEY = "authconv.preferences.v1"; function browserPreferenceStorage(){ return globalThis.localStorage; } storage.setItem(PREFERENCES_STORAGE_KEY, JSON.stringify(sanitizePreferences(preferences)) + accessToken);',
        ["非偏好 localStorage"],
      ],
      [
        'var PREFERENCES_STORAGE_KEY = "authconv.preferences.v1"; function browserPreferenceStorage(){ return globalThis.localStorage; } const ls = globalThis.localStorage; ls.token = accessToken;',
        ["非偏好 localStorage"],
      ],
      [
        'var PREFERENCES_STORAGE_KEY = "authconv.preferences.v1"; function browserPreferenceStorage(){ return globalThis.localStorage; } let s = globalThis.localStorage; s["token"] = accessToken;',
        ["非偏好 localStorage"],
      ],
    ] as const;

    for (const [html, labels] of cases) {
      expect(checkDistHtml(html, rules)).toEqual(labels);
    }
  });

  it("allows sanitized local preference storage only", () => {
    const html = `
      var PREFERENCES_STORAGE_KEY = "authconv.preferences.v1";
      function readStoredPreferences(storage) {
        return parseStoredPreferences(storage.getItem(PREFERENCES_STORAGE_KEY));
      }
      function writeStoredPreferences(preferences, storage) {
        storage.setItem(PREFERENCES_STORAGE_KEY, JSON.stringify(sanitizePreferences(preferences)));
      }
      function browserPreferenceStorage() {
        return globalThis.localStorage;
      }
      const pending = new Map();
      pending.clear();
    `;
    expect(checkDistHtml(html, rules)).toEqual([]);
  });

  it("keeps the committed dist HTML self-contained", async () => {
    const html = await readFile(new URL("../dist/index.html", import.meta.url), "utf8");
    expect(checkDistHtml(html, rules)).toEqual([]);
  });
});
