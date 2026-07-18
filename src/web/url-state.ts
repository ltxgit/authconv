import type { Locale, OutputFormat, OutputMode, OutputModes, OutputTextMode } from "../types.js";
import {
  ALL_FORMATS,
  isConfigurableOutputFormat,
  isOutputFormat,
  resolveOutputMode,
} from "../formats.js";
import { normalizeLocale } from "../i18n.js";

export type WebOutputOptions = {
  selectedFormats: OutputFormat[];
  outputTextMode: OutputTextMode;
  outputModes: OutputModes;
  previewFormat: OutputFormat;
  allowSyntheticIdToken?: boolean;
  includeRefreshToken?: boolean;
  verifyTokens?: boolean;
  locale?: Locale;
};

const URL_KEYS = {
  format: "format",
  text: "text",
  mode: "mode",
  preview: "preview",
  fakeid: "fakeid",
  refresh: "refresh",
  verify: "verify",
  lang: "lang",
} as const;
const NO_FORMATS = "none";

export function parseOutputOptionsSearch(search: string): Partial<WebOutputOptions> {
  const params = new URLSearchParams(search);
  const selectedFormats = parseFormats(params.get(URL_KEYS.format));
  const outputTextMode = parseTextMode(params.get(URL_KEYS.text));
  const outputModes = parseOutputModes(params.get(URL_KEYS.mode));
  const previewFormat = parseFormat(params.get(URL_KEYS.preview));
  const fakeidVal = params.get(URL_KEYS.fakeid);
  const allowSyntheticIdToken = fakeidVal === null ? undefined : fakeidVal !== "false";
  const includeRefreshToken = parseBooleanParam(params.get(URL_KEYS.refresh));
  const verifyTokens = parseBooleanParam(params.get(URL_KEYS.verify));
  const locale = normalizeLocale(params.get(URL_KEYS.lang));
  return {
    ...(selectedFormats ? { selectedFormats } : {}),
    ...(outputTextMode ? { outputTextMode } : {}),
    ...(Object.keys(outputModes).length > 0 ? { outputModes } : {}),
    ...(previewFormat ? { previewFormat } : {}),
    ...(allowSyntheticIdToken !== undefined ? { allowSyntheticIdToken } : {}),
    ...(includeRefreshToken !== undefined ? { includeRefreshToken } : {}),
    ...(verifyTokens !== undefined ? { verifyTokens } : {}),
    ...(locale ? { locale } : {}),
  };
}

export function outputOptionsUrl(href: string, options: WebOutputOptions): string {
  const url = new URL(href);
  const outputModes = options.outputTextMode === "jsonl"
    ? Object.fromEntries(
      ALL_FORMATS.filter(isConfigurableOutputFormat).map((format) => [format, "single"] as const),
    ) as OutputModes
    : options.outputModes;
  url.searchParams.set(URL_KEYS.format, formatsParam(options.selectedFormats));
  url.searchParams.set(URL_KEYS.text, options.outputTextMode);
  url.searchParams.set(URL_KEYS.mode, outputModesParam(outputModes));
  url.searchParams.set(URL_KEYS.preview, options.previewFormat);
  if (options.allowSyntheticIdToken === false) {
    url.searchParams.set(URL_KEYS.fakeid, "false");
  } else {
    url.searchParams.delete(URL_KEYS.fakeid);
  }
  if (options.includeRefreshToken === false) {
    url.searchParams.set(URL_KEYS.refresh, "false");
  } else {
    url.searchParams.delete(URL_KEYS.refresh);
  }
  if (options.verifyTokens === false) {
    url.searchParams.set(URL_KEYS.verify, "false");
  } else {
    url.searchParams.delete(URL_KEYS.verify);
  }
  if (options.locale) {
    url.searchParams.set(URL_KEYS.lang, options.locale);
  } else {
    url.searchParams.delete(URL_KEYS.lang);
  }
  return url.toString();
}

function parseBooleanParam(value: string | null): boolean | undefined {
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  return undefined;
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
  return value && isOutputFormat(value) ? value : undefined;
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
    .map((format) => `${format}:${resolveOutputMode(format, outputModes[format])}`)
    .join(",");
}

function isModeFormat(value: string): value is OutputFormat {
  return isOutputFormat(value) && isConfigurableOutputFormat(value);
}

function isOutputMode(value: string | undefined): value is OutputMode {
  return value === "merged" || value === "single";
}
