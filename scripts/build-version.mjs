import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

export function resolveBuildVersion({ packageVersion, buildSha }) {
  const version = packageVersion.trim();
  if (!version) {
    throw new Error("package version is required");
  }

  const sha = buildSha?.trim();
  if (!sha) {
    return `${version}.dev`;
  }

  return `${version}.${sha.slice(0, 7)}`;
}

export async function buildDisplayVersion(root, env = process.env) {
  const packageVersion = await readPackageVersion(root);
  return resolveBuildVersion({
    packageVersion,
    buildSha: env.AUTHCONV_BUILD_SHA,
  });
}

async function readPackageVersion(root) {
  const packageJson = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
  if (typeof packageJson.version !== "string" || !packageJson.version.trim()) {
    throw new Error("package.json version is required");
  }
  return packageJson.version;
}
