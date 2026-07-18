import type { NormalizedAccount } from "./types.js";

export function zipDownloadName(accounts: Iterable<NormalizedAccount>, now = new Date()): string {
  return `authconv_${zipNameBasis(accounts)}_${localTimestamp(now)}.zip`;
}

function zipNameBasis(accounts: Iterable<NormalizedAccount>): string {
  let count = 0;
  let first: NormalizedAccount | undefined;
  for (const account of accounts) {
    count += 1;
    if (count === 1) first = account;
  }
  return count === 1 && first ? singleAccountBasis(first) : `${count}-accounts`;
}

function singleAccountBasis(account: NormalizedAccount): string {
  const openAiId = account.provider === "openai" ? account.chatgptAccountId ?? account.accountId : undefined;
  const xaiId = account.provider === "xai" ? account.userId ?? account.principalId : undefined;
  const stableId = openAiId ?? xaiId;
  const identity = safeFileSegment(account.email ?? account.name ?? stableId ?? account.userId ?? "account");
  const idSegment = stableId ? safeFileSegment(stableId.slice(0, 12)) : "";
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
