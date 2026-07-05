import { ALL_FORMATS, type Locale, type OutputFormat, type OutputMode, type OutputModes, type OutputTextMode } from "../types.js";
import { normalizeLocale } from "../i18n.js";
import { effectiveWebOutputModes } from "./output-modes.js";

export type WebOutputOptions = {
  selectedFormats: OutputFormat[];
  outputTextMode: OutputTextMode;
  outputModes: OutputModes;
  previewFormat: OutputFormat;
  allowSyntheticIdToken?: boolean;
  locale?: Locale;
};

const URL_KEYS = {
  format: "format",
  text: "text",
  mode: "mode",
  preview: "preview",
  fakeid: "fakeid",
  lang: "lang",
} as const;
const NO_FORMATS = "none";

const OUTPUT_FORMATS = new Set<OutputFormat>(ALL_FORMATS);
const MODE_FORMATS = new Set<OutputFormat>(["sub2api", "codex2api"]);

export function parseOutputOptionsSearch(search: string): Partial<WebOutputOptions> {
  const params = new URLSearchParams(search);
  const selectedFormats = parseFormats(params.get(URL_KEYS.format));
  const outputTextMode = parseTextMode(params.get(URL_KEYS.text));
  const outputModes = parseOutputModes(params.get(URL_KEYS.mode));
  const previewFormat = parseFormat(params.get(URL_KEYS.preview));
  const fakeidVal = params.get(URL_KEYS.fakeid);
  const allowSyntheticIdToken = fakeidVal === null ? undefined : fakeidVal !== "false";
  const locale = normalizeLocale(params.get(URL_KEYS.lang));
  return {
    ...(selectedFormats ? { selectedFormats } : {}),
    ...(outputTextMode ? { outputTextMode } : {}),
    ...(Object.keys(outputModes).length > 0 ? { outputModes } : {}),
    ...(previewFormat ? { previewFormat } : {}),
    ...(allowSyntheticIdToken !== undefined ? { allowSyntheticIdToken } : {}),
    ...(locale ? { locale } : {}),
  };
}

export function outputOptionsUrl(href: string, options: WebOutputOptions): string {
  const url = new URL(href);
  const outputModes = effectiveWebOutputModes(options.outputModes, options.outputTextMode);
  url.searchParams.set(URL_KEYS.format, formatsParam(options.selectedFormats));
  url.searchParams.set(URL_KEYS.text, options.outputTextMode);
  url.searchParams.set(URL_KEYS.mode, outputModesParam(outputModes));
  url.searchParams.set(URL_KEYS.preview, options.previewFormat);
  if (options.allowSyntheticIdToken === false) {
    url.searchParams.set(URL_KEYS.fakeid, "false");
  } else {
    url.searchParams.delete(URL_KEYS.fakeid);
  }
  if (options.locale) {
    url.searchParams.set(URL_KEYS.lang, options.locale);
  } else {
    url.searchParams.delete(URL_KEYS.lang);
  }
  return url.toString();
}

function parseFormats(value: string | null): OutputFormat[] | undefined {
  if (!value) {
    return undefined;
  }
  if (value === NO_FORMATS) {
    return [];
  }
  const formats = canonicalFormats(value.split(",").map(parseFormat).filter((format): format is OutputFormat => format !== undefined));
  return formats.length > 0 ? formats : undefined;
}

function canonicalFormats(formats: OutputFormat[]): OutputFormat[] {
  const selected = new Set(formats);
  return ALL_FORMATS.filter((format) => selected.has(format));
}

function formatsParam(formats: OutputFormat[]): string {
  return formats.length > 0 ? canonicalFormats(formats).join(",") : NO_FORMATS;
}

function parseFormat(value: string | null): OutputFormat | undefined {
  return value && OUTPUT_FORMATS.has(value as OutputFormat) ? value as OutputFormat : undefined;
}

function parseTextMode(value: string | null): OutputTextMode | undefined {
  return value === "json" || value === "jsonl" ? value : undefined;
}

function parseOutputModes(value: string | null): OutputModes {
  const outputModes: OutputModes = {};
  for (const pair of value?.split(",") ?? []) {
    const [format, mode] = pair.split(":");
    if (isModeFormat(format) && isOutputMode(mode)) {
      outputModes[format] = mode;
    }
  }
  return outputModes;
}

function outputModesParam(outputModes: OutputModes): string {
  return ALL_FORMATS
    .filter(isModeFormat)
    .map((format) => `${format}:${outputModes[format] ?? "merged"}`)
    .join(",");
}

function isModeFormat(value: string): value is "sub2api" | "codex2api" {
  return MODE_FORMATS.has(value as OutputFormat);
}

function isOutputMode(value: string | undefined): value is OutputMode {
  return value === "merged" || value === "single";
}
