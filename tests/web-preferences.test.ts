import { describe, expect, it } from "vitest";
import {
  PREFERENCES_STORAGE_KEY,
  parseStoredPreferences,
  readStoredPreferences,
  writeStoredPreferences,
  type PreferenceStorage,
} from "../src/web/preferences.js";

describe("web preferences", () => {
  it("keeps only whitelisted preference fields", () => {
    const preferences = parseStoredPreferences(JSON.stringify({
      selectedFormats: ["sub2api", "cpa", "bad"],
      outputTextMode: "jsonl",
      outputModes: { sub2api: "single", cpa: "single" },
      previewFormat: "sub2api",
      allowSyntheticIdToken: false,
      locale: "zh-CN",
      themeMode: "dark",
      forcedInputFormat: "session",
      accessToken: "must-not-survive",
      input: { access_token: "must-not-survive" },
      previewOutput: { id_token: "must-not-survive" },
      sourcePath: "/secret/input.json",
    }));

    expect(preferences).toEqual({
      selectedFormats: ["cpa", "sub2api"],
      outputTextMode: "jsonl",
      outputModes: { sub2api: "single" },
      previewFormat: "sub2api",
      allowSyntheticIdToken: false,
      locale: "zh",
      themeMode: "dark",
      forcedInputFormat: "session",
    });
  });

  it("writes sanitized preferences to storage", () => {
    const storage = memoryStorage();
    writeStoredPreferences({
      selectedFormats: ["codex2api"],
      outputTextMode: "json",
      outputModes: { codex2api: "single" },
      previewFormat: "codex2api",
      allowSyntheticIdToken: true,
      locale: "en",
      themeMode: "system",
      forcedInputFormat: "auto",
    }, storage);

    expect(storage.lastKey).toBe(PREFERENCES_STORAGE_KEY);
    expect(readStoredPreferences(storage)).toEqual({
      selectedFormats: ["codex2api"],
      outputTextMode: "json",
      outputModes: { codex2api: "single" },
      previewFormat: "codex2api",
      allowSyntheticIdToken: true,
      locale: "en",
      themeMode: "system",
      forcedInputFormat: "auto",
    });
  });

  it("handles invalid stored preference JSON safely", () => {
    const storage = memoryStorage("{bad json");
    expect(readStoredPreferences(storage)).toEqual({});
  });

  it("keeps an empty selected format list as an explicit preference", () => {
    const storage = memoryStorage();
    writeStoredPreferences({ selectedFormats: [] }, storage);
    expect(readStoredPreferences(storage)).toEqual({ selectedFormats: [] });
  });
});

function memoryStorage(initialValue: string | null = null): PreferenceStorage & { value: string | null; lastKey: string | null } {
  return {
    value: initialValue,
    lastKey: null,
    getItem(key: string) {
      this.lastKey = key;
      return this.value;
    },
    setItem(_key: string, value: string) {
      this.lastKey = _key;
      this.value = value;
    },
  };
}
