export type DistCheckRule = {
  label: string;
  pattern: string;
  flags?: string;
};

export function checkDistHtml(html: string, rules: DistCheckRule[]): string[];
