import { strFromU8, unzipSync } from "fflate";

export type JsonSource = {
  name: string;
  path: string;
  text: string;
};

export function isJsonCredentialPath(value: string): boolean {
  const lowerName = value.toLowerCase();
  return lowerName.endsWith(".json") || lowerName.endsWith(".jsonl");
}

export function isZipCredentialPath(value: string): boolean {
  return value.toLowerCase().endsWith(".zip");
}

export function isCredentialImportPath(value: string): boolean {
  return isJsonCredentialPath(value) || isZipCredentialPath(value);
}

export function extractZipJsonSources(zipPath: string, bytes: Uint8Array): JsonSource[] {
  const archive = unzipSync(bytes, {
    filter: (file) => isJsonCredentialPath(file.name) && !isIgnoredArchivePath(file.name),
  });
  return Object.entries(archive)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([entryPath, content]) => {
      const path = joinImportPath(zipPath, normalizeArchiveEntryPath(entryPath));
      return {
        name: path,
        path,
        text: strFromU8(content),
      };
    });
}

function joinImportPath(basePath: string, entryPath: string): string {
  const base = basePath.replace(/\/+$/g, "");
  const entry = normalizeArchiveEntryPath(entryPath);
  return base ? `${base}/${entry}` : entry;
}

export function normalizeArchiveEntryPath(entryPath: string): string {
  return entryPath
    .replace(/\\/g, "/")
    .split("/")
    .filter((segment) => segment && segment !== "." && segment !== "..")
    .join("/");
}

function isIgnoredArchivePath(entryPath: string): boolean {
  return normalizeArchiveEntryPath(entryPath)
    .split("/")
    .some((segment) => segment === "__MACOSX" || segment.startsWith("."));
}
