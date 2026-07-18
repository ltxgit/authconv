const ALLOWED_LOCAL_STORAGE_KEY = "authconv.preferences.v1";
const LOCAL_STORAGE_PATTERN = /\blocalStorage\b/;
const GLOBAL_LOCAL_STORAGE_PATTERN = /\bglobalThis\.localStorage\b/g;
const GLOBAL_LOCAL_STORAGE_MEMBER_PATTERN = /\bglobalThis\.localStorage\s*(?:[.[=])/;
const ALLOWED_LOCAL_STORAGE_RETURN_PATTERN = /\breturn\s+globalThis\.localStorage\s*;/;
const ALLOWED_LOCAL_STORAGE_RETURN_REPLACE_PATTERN = /\breturn\s+globalThis\.localStorage\s*;/g;
const STORAGE_GET_ITEM_PATTERN = /\.\s*getItem\s*\(/g;
const STORAGE_SET_ITEM_PATTERN = /\.\s*setItem\s*\(/g;
const STORAGE_BRACKET_CALL_PATTERN = /\[\s*["'](?:getItem|setItem|removeItem|clear)["']\s*]\s*\(/;
const STORAGE_MUTATION_PATTERN = /\bstorage\s*\.\s*(?:removeItem|clear)\s*\(/;
const STORAGE_PROPERTY_ASSIGN_PATTERN = /\bstorage\s*(?:\.\s*(?!getItem\b|setItem\b)[A-Za-z_$][\w$]*|\[[^\]]+\])\s*=/;
const ALLOWED_GET_ITEM_ARGS = "PREFERENCES_STORAGE_KEY";
const ALLOWED_SET_ITEM_ARGS = "PREFERENCES_STORAGE_KEY,JSON.stringify(sanitizePreferences(preferences))";

export function checkDistHtml(html, rules) {
  const failures = rules.filter((rule) => new RegExp(rule.pattern, rule.flags).test(html)).map((rule) => rule.label);
  if (hasUnsafeLocalStorageUse(html)) {
    failures.push("非偏好 localStorage");
  }
  return failures;
}

function hasUnsafeLocalStorageUse(html) {
  if (!LOCAL_STORAGE_PATTERN.test(html)) {
    return false;
  }

  if (!html.includes(`"${ALLOWED_LOCAL_STORAGE_KEY}"`)) {
    return true;
  }
  if (!html.includes("globalThis.localStorage")) {
    return true;
  }
  if (!ALLOWED_LOCAL_STORAGE_RETURN_PATTERN.test(html)) {
    return true;
  }
  if (hasUnexpectedGlobalLocalStorageReference(html)) {
    return true;
  }
  if (hasNonGlobalLocalStorageReference(html)) {
    return true;
  }
  if (GLOBAL_LOCAL_STORAGE_MEMBER_PATTERN.test(html)) {
    return true;
  }
  if (STORAGE_BRACKET_CALL_PATTERN.test(html)) {
    return true;
  }
  if (STORAGE_MUTATION_PATTERN.test(html)) {
    return true;
  }
  if (STORAGE_PROPERTY_ASSIGN_PATTERN.test(html)) {
    return true;
  }
  if (hasUnsafeStorageCalls(html, STORAGE_GET_ITEM_PATTERN, ALLOWED_GET_ITEM_ARGS)) {
    return true;
  }
  if (hasUnsafeStorageCalls(html, STORAGE_SET_ITEM_PATTERN, ALLOWED_SET_ITEM_ARGS)) {
    return true;
  }
  return false;
}

function hasNonGlobalLocalStorageReference(html) {
  return LOCAL_STORAGE_PATTERN.test(html.replace(GLOBAL_LOCAL_STORAGE_PATTERN, ""));
}

function hasUnexpectedGlobalLocalStorageReference(html) {
  return html.replace(ALLOWED_LOCAL_STORAGE_RETURN_REPLACE_PATTERN, "").includes("globalThis.localStorage");
}

function hasUnsafeStorageCalls(html, pattern, allowedArgs) {
  pattern.lastIndex = 0;
  for (const match of html.matchAll(pattern)) {
    const callStart = (match.index ?? 0) + match[0].lastIndexOf("(");
    const args = readCallArgs(html, callStart);
    if (normalizeCallArgs(args) !== allowedArgs) {
      return true;
    }
  }
  return false;
}

function readCallArgs(text, openParenIndex) {
  let depth = 0;
  let quote;
  let escaped = false;
  const start = openParenIndex + 1;
  for (let index = openParenIndex; index < text.length; index += 1) {
    const char = text[index];
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === quote) {
        quote = undefined;
      }
      continue;
    }
    if (char === "\"" || char === "'" || char === "`") {
      quote = char;
      continue;
    }
    if (char === "(") {
      depth += 1;
      continue;
    }
    if (char === ")") {
      depth -= 1;
      if (depth === 0) {
        return text.slice(start, index);
      }
    }
  }
  return undefined;
}

function normalizeCallArgs(args) {
  return (args ?? "").replace(/\s+/g, "");
}
