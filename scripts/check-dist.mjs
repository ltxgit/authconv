import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const htmlPath = resolve(root, "dist/index.html");
const rulesPath = resolve(root, "src/dist-check-rules.json");
const [html, rawRules] = await Promise.all([readFile(htmlPath, "utf8"), readFile(rulesPath, "utf8")]);
const rules = JSON.parse(rawRules);
const failures = rules.filter(({ pattern, flags }) => new RegExp(pattern, flags).test(html));
if (failures.length > 0) {
  for (const failure of failures) {
    console.error(`dist/index.html 检查失败: ${failure.label}`);
  }
  process.exit(1);
}

console.log("dist/index.html 检查通过");
