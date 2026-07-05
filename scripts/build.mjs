import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const distDir = resolve(root, "dist");
const templatePath = resolve(root, "src/web/template.html");
const stylePath = resolve(root, "src/web/styles.css");
const webEntry = resolve(root, "src/web/app.ts");
const cliEntry = resolve(root, "src/cli.ts");
const htmlOut = resolve(distDir, "index.html");
const cliOut = resolve(distDir, "cli.mjs");

await mkdir(distDir, { recursive: true });

const [template, css, webBundle] = await Promise.all([
  readFile(templatePath, "utf8"),
  readFile(stylePath, "utf8"),
  esbuild.build({
    entryPoints: [webEntry],
    bundle: true,
    format: "iife",
    platform: "browser",
    target: "es2020",
    sourcemap: false,
    minify: false,
    write: false,
    logLevel: "silent",
  }),
]);

const js = webBundle.outputFiles[0]?.text;
if (!js) {
  throw new Error("浏览器入口构建未产生输出");
}

const html = template.replace("__AUTHCONV_CSS__", () => css).replace("__AUTHCONV_JS__", () => js);
await writeFile(htmlOut, html, "utf8");

await esbuild.build({
  entryPoints: [cliEntry],
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node20",
  outfile: cliOut,
  sourcemap: false,
  minify: false,
  banner: {
    js: "#!/usr/bin/env node",
  },
  logLevel: "info",
});
