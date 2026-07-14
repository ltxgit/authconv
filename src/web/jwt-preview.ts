import { decodeJwtParts } from "../jwt.js";

/*
 * Data flow:
 * rendered JSON string -> recognize one JWT -> decode header and payload locally
 * -> format the content displayed by the hover popover.
 */
export function jwtPopoverText(token: string): string | undefined {
  const decoded = decodeJwtParts(token);
  if (!decoded) {
    return undefined;
  }
  return [
    "Header",
    JSON.stringify(decoded.header, null, 2),
    "Payload",
    JSON.stringify(decoded.payload, null, 2),
  ].join("\n");
}
