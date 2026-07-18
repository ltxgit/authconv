import {
  type NormalizedAccount,
  type OutputFormat,
  type OutputMode,
  type Provider,
} from "./types.js";

export type FormatDefinition = {
  format: OutputFormat;
  providers: readonly Provider[];
  modes: readonly [OutputMode, ...OutputMode[]];
  filePrefix: string;
};

export const FORMAT_DEFINITIONS = {
  cpa: {
    format: "cpa",
    providers: ["openai", "xai"],
    modes: ["single"],
    filePrefix: "cpa",
  },
  sub2api: {
    format: "sub2api",
    providers: ["openai", "xai"],
    modes: ["merged", "single"],
    filePrefix: "sub2api",
  },
  codex2api: {
    format: "codex2api",
    providers: ["openai"],
    modes: ["merged", "single"],
    filePrefix: "codex2api",
  },
  codexmanager: {
    format: "codexmanager",
    providers: ["openai"],
    modes: ["single"],
    filePrefix: "codex-manager",
  },
  codex: {
    format: "codex",
    providers: ["openai"],
    modes: ["single"],
    filePrefix: "codex",
  },
  grok: {
    format: "grok",
    providers: ["xai"],
    modes: ["single"],
    filePrefix: "grok",
  },
  grok2api: {
    format: "grok2api",
    providers: ["xai"],
    modes: ["merged"],
    filePrefix: "grok2api",
  },
} as const satisfies Record<OutputFormat, FormatDefinition>;

export const ALL_FORMATS = Object.keys(FORMAT_DEFINITIONS) as OutputFormat[];

export function isConfigurableOutputFormat(format: OutputFormat): boolean {
  return FORMAT_DEFINITIONS[format].modes.length > 1;
}

export function resolveOutputMode(format: OutputFormat, requested?: OutputMode): OutputMode {
  const modes = FORMAT_DEFINITIONS[format].modes;
  if (modes.length === 1) {
    if (requested !== undefined) {
      throw new Error(`Format ${format} uses fixed ${modes[0]} output`);
    }
    return modes[0];
  }
  return requested ?? modes[0];
}

export function applicableFormats(accounts: Iterable<Pick<NormalizedAccount, "provider">>): OutputFormat[] {
  const providers = new Set(Array.from(accounts, (account) => account.provider));
  if (providers.size === 0) {
    return [...ALL_FORMATS];
  }
  return ALL_FORMATS.filter((format) => FORMAT_DEFINITIONS[format].providers.some((provider) => providers.has(provider)));
}

export function effectiveFormats(
  selectedFormats: readonly OutputFormat[],
  availableFormats: readonly OutputFormat[],
): OutputFormat[] {
  const selected = new Set(selectedFormats);
  return availableFormats.filter((format) => selected.has(format));
}

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
