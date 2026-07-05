import { strToU8, zipSync } from "fflate";
import type { SerializedOutputFile } from "./types.js";

const ZIP_MTIME = new Date(1980, 0, 1);

export function zipOutputFiles(files: SerializedOutputFile[]): Uint8Array {
  const entries = Object.fromEntries(files.map((file) => [file.path, strToU8(file.text)]));
  return zipSync(entries, { level: 6, mtime: ZIP_MTIME });
}
