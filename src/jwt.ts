import { isRecord } from "./object.js";

const SYNTHETIC_ID_TOKEN_PLACEHOLDER_SIGNATURE = base64urlEncode("lanv_authconv");

export function decodeJwtPayload(token: string | undefined): Record<string, unknown> | undefined {
  if (!token) {
    return undefined;
  }
  const parts = token.split(".");
  if (parts.length < 2 || !parts[1]) {
    return undefined;
  }
  try {
    const text = base64urlDecode(parts[1]);
    const parsed: unknown = JSON.parse(text);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export function createSyntheticIdToken(
  claims: Record<string, unknown>,
): string {
  const header = {
    alg: "none",
    typ: "JWT",
    cpa_synthetic: true,
  };
  const payload = {
    iat: 0,
    ...claims,
  };
  const body = `${base64urlEncode(JSON.stringify(header))}.${base64urlEncode(JSON.stringify(payload))}`;
  return applySyntheticIdTokenSignature(`${body}.`);
}

export function applySyntheticIdTokenSignature(
  token: string,
): string {
  const parts = token.split(".");
  if (parts.length !== 3 || !parts[0] || !parts[1]) {
    return token;
  }
  return `${parts[0]}.${parts[1]}.${SYNTHETIC_ID_TOKEN_PLACEHOLDER_SIGNATURE}`;
}

export function claimString(claims: Record<string, unknown> | undefined, key: string): string | undefined {
  if (!claims) {
    return undefined;
  }
  const value = claims[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function claimStringArray(claims: Record<string, unknown> | undefined, key: string): string[] | undefined {
  if (!claims) {
    return undefined;
  }
  const value = claims[key];
  if (typeof value === "string" && value.trim()) {
    return [value.trim()];
  }
  if (!Array.isArray(value)) {
    return undefined;
  }
  const strings = value
    .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    .map((item) => item.trim());
  return strings.length > 0 ? strings : undefined;
}

export function openAIAuthClaims(claims: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!claims) {
    return undefined;
  }
  const value = claims["https://api.openai.com/auth"];
  return isRecord(value) ? value : undefined;
}

export function openAIProfileClaims(claims: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!claims) {
    return undefined;
  }
  const value = claims["https://api.openai.com/profile"];
  return isRecord(value) ? value : undefined;
}

export function claimNumber(claims: Record<string, unknown> | undefined, key: string): number | undefined {
  if (!claims) {
    return undefined;
  }
  const value = claims[key];
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return undefined;
}

function base64urlDecode(value: string): string {
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), "=");
  if (typeof Buffer !== "undefined") {
    return Buffer.from(padded, "base64").toString("utf8");
  }
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function base64urlEncode(value: string): string {
  if (typeof Buffer !== "undefined") {
    return Buffer.from(value)
      .toString("base64")
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replaceAll("=", "");
  }
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}
