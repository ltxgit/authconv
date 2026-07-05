import { DEFAULT_LOCALE } from "./i18n.js";
import type { Locale } from "./types.js";

export type ParsedInputPayload = {
  value: unknown;
  documentCount: number;
};

export type ParseInputPayloadOptions = {
  locale?: Locale;
};

export function parseInputPayload(text: string, options: ParseInputPayloadOptions = {}): unknown {
  return parseInputPayloadWithMeta(text, options).value;
}

export function parseInputPayloadWithMeta(text: string, options: ParseInputPayloadOptions = {}): ParsedInputPayload {
  const locale = options.locale ?? DEFAULT_LOCALE;
  const normalizedText = text.replace(/^\uFEFF/, "");
  try {
    return {
      value: JSON.parse(normalizedText) as unknown,
      documentCount: 1,
    };
  } catch (jsonError) {
    return parseJsonDocumentStream(normalizedText, jsonError, locale);
  }
}

function parseJsonDocumentStream(text: string, jsonError: unknown, locale: Locale): ParsedInputPayload {
  const values: unknown[] = [];
  let position = skipWhitespace(text, 0);

  while (position < text.length) {
    const start = position;
    let end: number;
    try {
      end = scanJsonValueEnd(text, start, locale);
    } catch (scanError) {
      throw new Error(jsonParseFailed(locale, start, scanError, jsonError));
    }

    try {
      values.push(JSON.parse(text.slice(start, end)) as unknown);
    } catch (documentError) {
      throw new Error(jsonParseFailed(locale, start, documentError, jsonError));
    }

    position = skipWhitespace(text, end);
  }

  if (values.length === 0) {
    throw new Error(jsonParseFailedEmpty(locale, jsonError));
  }

  return {
    value: values.length === 1 ? values[0] : values,
    documentCount: values.length,
  };
}

function scanJsonValueEnd(text: string, start: number, locale: Locale): number {
  const first = text[start];
  if (first === "{" || first === "[") {
    return scanContainerEnd(text, start, locale);
  }
  if (first === "\"") {
    return scanStringEnd(text, start, locale);
  }
  return scanPrimitiveEnd(text, start, locale);
}

function scanContainerEnd(text: string, start: number, locale: Locale): number {
  const stack: string[] = [];
  let inString = false;
  let escaped = false;

  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") {
      inString = true;
      continue;
    }
    if (char === "{") {
      stack.push("}");
      continue;
    }
    if (char === "[") {
      stack.push("]");
      continue;
    }
    if (char === "}" || char === "]") {
      const expected = stack.pop();
      if (expected !== char) {
        throw new Error(mismatchedClose(locale, expected, char));
      }
      if (stack.length === 0) {
        return index + 1;
      }
    }
  }

  throw new Error(unclosedDocument(locale));
}

function scanStringEnd(text: string, start: number, locale: Locale): number {
  let escaped = false;
  for (let index = start + 1; index < text.length; index += 1) {
    const char = text[index];
    if (escaped) {
      escaped = false;
    } else if (char === "\\") {
      escaped = true;
    } else if (char === "\"") {
      return index + 1;
    }
  }
  throw new Error(unclosedString(locale));
}

function scanPrimitiveEnd(text: string, start: number, locale: Locale): number {
  const rest = text.slice(start);
  const numberMatch = rest.match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/);
  if (numberMatch?.[0]) {
    return start + numberMatch[0].length;
  }
  for (const literal of ["true", "false", "null"]) {
    if (rest.startsWith(literal)) {
      return start + literal.length;
    }
  }
  throw new Error(missingStart(locale));
}

function skipWhitespace(text: string, start: number): number {
  let index = start;
  while (index < text.length && /\s/.test(text[index])) {
    index += 1;
  }
  return index;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function jsonParseFailed(locale: Locale, start: number, detail: unknown, jsonError: unknown): string {
  if (locale === "zh") {
    return `JSON/JSONL 解析失败，位置 ${start + 1}: ${errorMessage(detail)}；整体 JSON 错误: ${errorMessage(jsonError)}`;
  }
  return `JSON/JSONL parse failed at position ${start + 1}: ${errorMessage(detail)}; full JSON error: ${errorMessage(jsonError)}`;
}

function jsonParseFailedEmpty(locale: Locale, jsonError: unknown): string {
  if (locale === "zh") {
    return `JSON/JSONL 解析失败: ${errorMessage(jsonError)}`;
  }
  return `JSON/JSONL parse failed: ${errorMessage(jsonError)}`;
}

function mismatchedClose(locale: Locale, expected: string | undefined, actual: string): string {
  if (locale === "zh") {
    return `JSON 结构闭合符不匹配，预期 ${expected ?? "无"}，实际 ${actual}`;
  }
  return `JSON structure closer mismatch, expected ${expected ?? "none"}, got ${actual}`;
}

function unclosedDocument(locale: Locale): string {
  return locale === "zh" ? "JSON 文档未闭合" : "JSON document is not closed";
}

function unclosedString(locale: Locale): string {
  return locale === "zh" ? "JSON 字符串未闭合" : "JSON string is not closed";
}

function missingStart(locale: Locale): string {
  return locale === "zh" ? "未找到 JSON 文档起点" : "JSON document start not found";
}
