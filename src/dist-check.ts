import rules from "./dist-check-rules.json" with { type: "json" };

export function checkDistHtml(html: string): string[] {
  return rules.filter((rule) => new RegExp(rule.pattern, rule.flags).test(html)).map((rule) => rule.label);
}
