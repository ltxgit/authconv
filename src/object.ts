export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function compactObject<T extends Record<string, unknown>>(value: T): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (item === undefined || item === null || item === "") {
      continue;
    }
    if (Array.isArray(item) && item.length === 0) {
      out[key] = item;
      continue;
    }
    out[key] = item;
  }
  return out;
}

export function firstString(records: Record<string, unknown>[], keys: string[]): string | undefined {
  for (const record of records) {
    for (const key of keys) {
      const value = record[key];
      if (typeof value === "string") {
        const trimmed = value.trim();
        if (trimmed) {
          return trimmed;
        }
      }
      if (typeof value === "number" || typeof value === "boolean") {
        return String(value);
      }
    }
  }
  return undefined;
}

export function firstRecord(records: Record<string, unknown>[], key: string): Record<string, unknown> | undefined {
  for (const record of records) {
    const value = record[key];
    if (isRecord(value)) {
      return value;
    }
  }
  return undefined;
}
