import { describe, expect, it } from "vitest";
import { decodeJwtParts } from "../src/jwt.js";
import { jwtPopoverText } from "../src/web/jwt-preview.js";

function fakeJwt(header: Record<string, unknown>, payload: Record<string, unknown>): string {
  const encode = (value: Record<string, unknown>) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode(header)}.${encode(payload)}.signature`;
}

describe("web JWT preview", () => {
  it("decodes both JWT header and payload without treating an opaque token as JWT", () => {
    const token = fakeJwt({ alg: "RS256", typ: "JWT" }, { iss: "https://auth.x.ai", sub: "xai-user" });

    expect(decodeJwtParts(token)).toEqual({
      header: { alg: "RS256", typ: "JWT" },
      payload: { iss: "https://auth.x.ai", sub: "xai-user" },
    });
    expect(decodeJwtParts("opaque-access-token")).toBeUndefined();
  });

  it("builds a hover preview for one JWT string", () => {
    const token = fakeJwt({ alg: "RS256" }, { sub: "access-user" });

    expect(jwtPopoverText(token)).toBe([
      "Header",
      JSON.stringify({ alg: "RS256" }, null, 2),
      "Payload",
      JSON.stringify({ sub: "access-user" }, null, 2),
    ].join("\n"));
  });

  it("returns no hover preview for an opaque token", () => {
    expect(jwtPopoverText("opaque-token")).toBeUndefined();
  });
});
