import { ALL_FORMATS, type OutputFormat } from "./types.js";

export type ParseFormatListOptions = {
  invalidFormatMessage?: (format: string) => string;
};

export function parseFormatList(values: string[] | undefined, options: ParseFormatListOptions = {}): OutputFormat[] {
  const out: OutputFormat[] = [];
  for (const value of values ?? []) {
    for (const part of value.split(",")) {
      const normalized = part.trim().toLowerCase();
      if (!normalized) {
        continue;
      }
      if (normalized === "all") {
        for (const format of ALL_FORMATS) {
          if (!out.includes(format)) {
            out.push(format);
          }
        }
        continue;
      }
      if (!isOutputFormat(normalized)) {
        throw new Error(options.invalidFormatMessage?.(part) ?? `未知输出格式: ${part}`);
      }
      if (!out.includes(normalized)) {
        out.push(normalized);
      }
    }
  }
  return out;
}

export function isOutputFormat(value: string): value is OutputFormat {
  return (ALL_FORMATS as readonly string[]).includes(value);
}
