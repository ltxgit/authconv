export function fakeJwt(claims: Record<string, unknown>): string {
  return [
    base64url(JSON.stringify({ alg: "RS256", typ: "JWT" })),
    base64url(JSON.stringify(claims)),
    base64url("synthetic-test-signature"),
  ].join(".");
}

function base64url(value: string): string {
  return Buffer.from(value)
    .toString("base64")
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}
