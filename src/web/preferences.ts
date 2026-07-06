import { ALL_FORMATS, type InputFormat, type Locale, type OutputFormat, type OutputMode, type OutputModes, type OutputTextMode } from "../types.js";
import { normalizeLocale } from "../i18n.js";

export type ThemeMode = "system" | "light" | "dark";

export type WebPreferences = {
  selectedFormats: OutputFormat[];
  outputTextMode: OutputTextMode;
  outputModes: OutputModes;
  previewFormat: OutputFormat;
  allowSyntheticIdToken: boolean;
  locale: Locale;
  themeMode: ThemeMode;
  forcedInputFormat: InputFormat | "auto";
};

export type PreferenceStorage = Pick<Storage, "getItem" | "setItem">;

export const PREFERENCES_STORAGE_KEY = "authconv.preferences.v1";

const OUTPUT_FORMATS = new Set<OutputFormat>(ALL_FORMATS);
const MODE_FORMATS = new Set<OutputFormat>(["sub2api", "codex2api"]);
const INPUT_FORMATS = new Set<InputFormat | "auto">([
  "auto",
  "session",
  "sub2api",
  "cpa",
  "codexmanager",
  "codex2api",
  "codex",
]);

export function readStoredPreferences(storage = browserPreferenceStorage()): Partial<WebPreferences> {
  if (!storage) {
    return {};
  }
  try {
    return parseStoredPreferences(storage.getItem(PREFERENCES_STORAGE_KEY));
  } catch {
    return {};
  }
}

export function writeStoredPreferences(
  preferences: Partial<WebPreferences>,
  storage = browserPreferenceStorage(),
): void {
  if (!storage) {
    return;
  }
  try {
    storage.setItem(PREFERENCES_STORAGE_KEY, JSON.stringify(sanitizePreferences(preferences)));
  } catch {
    // Preference persistence should never block conversion.
  }
}

export function parseStoredPreferences(raw: string | null): Partial<WebPreferences> {
  if (!raw) {
    return {};
  }
  try {
    return sanitizePreferences(JSON.parse(raw));
  } catch {
    return {};
  }
}

export function sanitizePreferences(value: unknown): Partial<WebPreferences> {
  if (!isRecord(value)) {
    return {};
  }

  const selectedFormats = parseFormats(value.selectedFormats);
  const outputTextMode = parseOutputTextMode(value.outputTextMode);
  const outputModes = parseOutputModes(value.outputModes);
  const previewFormat = parseOutputFormat(value.previewFormat);
  const allowSyntheticIdToken = typeof value.allowSyntheticIdToken === "boolean"
    ? value.allowSyntheticIdToken
    : undefined;
  const locale = typeof value.locale === "string" ? normalizeLocale(value.locale) : undefined;
  const themeMode = parseThemeMode(value.themeMode);
  const forcedInputFormat = parseInputFormat(value.forcedInputFormat);

  return {
    ...(selectedFormats ? { selectedFormats } : {}),
    ...(outputTextMode ? { outputTextMode } : {}),
    ...(Object.keys(outputModes).length > 0 ? { outputModes } : {}),
    ...(previewFormat ? { previewFormat } : {}),
    ...(allowSyntheticIdToken !== undefined ? { allowSyntheticIdToken } : {}),
    ...(locale ? { locale } : {}),
    ...(themeMode ? { themeMode } : {}),
    ...(forcedInputFormat ? { forcedInputFormat } : {}),
  };
}

function browserPreferenceStorage(): PreferenceStorage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

function parseFormats(value: unknown): OutputFormat[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const selected = new Set(value.filter((item): item is OutputFormat => parseOutputFormat(item) !== undefined));
  const formats = ALL_FORMATS.filter((format) => selected.has(format));
  return formats.length > 0 || value.length === 0 ? formats : undefined;
}

function parseOutputFormat(value: unknown): OutputFormat | undefined {
  return typeof value === "string" && OUTPUT_FORMATS.has(value as OutputFormat)
    ? value as OutputFormat
    : undefined;
}

function parseOutputTextMode(value: unknown): OutputTextMode | undefined {
  return value === "json" || value === "jsonl" ? value : undefined;
}

function parseOutputModes(value: unknown): OutputModes {
  if (!isRecord(value)) {
    return {};
  }
  const outputModes: OutputModes = {};
  for (const format of ALL_FORMATS) {
    if (MODE_FORMATS.has(format) && isOutputMode(value[format])) {
      outputModes[format] = value[format];
    }
  }
  return outputModes;
}

function isOutputMode(value: unknown): value is OutputMode {
  return value === "merged" || value === "single";
}

function parseThemeMode(value: unknown): ThemeMode | undefined {
  return value === "system" || value === "light" || value === "dark" ? value : undefined;
}

function parseInputFormat(value: unknown): InputFormat | "auto" | undefined {
  return typeof value === "string" && INPUT_FORMATS.has(value as InputFormat | "auto")
    ? value as InputFormat | "auto"
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
