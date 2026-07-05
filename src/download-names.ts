import type { NormalizedAccount } from "./types.js";

export function zipDownloadName(accounts: NormalizedAccount[], now = new Date()): string {
  return `authconv_${zipNameBasis(accounts)}_${localTimestamp(now)}.zip`;
}

function zipNameBasis(accounts: NormalizedAccount[]): string {
  if (accounts.length === 1) {
    return singleAccountBasis(accounts[0]);
  }
  return `${accounts.length}-accounts`;
}

function singleAccountBasis(account: NormalizedAccount): string {
  const identity = safeFileSegment(account.email ?? account.name ?? account.chatgptAccountId ?? account.accountId ?? account.userId ?? "account");
  const accountId = account.chatgptAccountId ?? account.accountId;
  const idSegment = accountId ? safeFileSegment(accountId.slice(0, 12)) : "";
  return idSegment ? `${identity}_${idSegment}` : identity;
}

function localTimestamp(value: Date): string {
  return [
    value.getFullYear(),
    value.getMonth() + 1,
    value.getDate(),
    value.getHours(),
    value.getMinutes(),
    value.getSeconds(),
  ].map((part) => String(part).padStart(2, "0")).join("");
}

function safeFileSegment(value: string): string {
  return value.trim().replace(/[^\w\-.]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 96) || "account";
}
