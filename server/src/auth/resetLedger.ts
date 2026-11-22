/**
 * HOW MANY reset links a person may ask for, and WHICH ONE is live, decided in ONE database transaction.
 *
 * Each person has one ledger row (beside the links themselves, in the same table). Asking for a link reads the
 * requests of the last hour, refuses if there have been too many, and otherwise records this request and names
 * its link as THE live one, all in a single read-modify-write. Two requests arriving together therefore cannot
 * both slip under the limit, and cannot leave two usable links: a link is usable only while the ledger names it.
 */
import type { PasswordResetRecord, Table } from '../store/types';

const HOUR = 60 * 60_000;
const ledgerKey = (userId: string): string => `ledger:${userId}`;

/** Records a request and makes `codeKey` the person's one live link. False: too many requests in the last hour; nothing changed. */
export async function claimResetLink(table: Table<PasswordResetRecord>, userId: string, codeKey: string, at: number, perHour: number, ttlMs: number): Promise<boolean> {
  let allowed = false;
  await table.mutate(ledgerKey(userId), (current) => {
    const recent = (current?.requests ?? []).filter((time) => time > at - HOUR);
    allowed = recent.length < perHour;
    if (!allowed) return undefined;
    // (The row's userId is not the person's, so that "delete this person's links" leaves the count of requests alone.)
    return { userId: ledgerKey(userId), expiresAt: at + Math.max(HOUR, ttlMs), attempts: 0, requests: [...recent, at], current: codeKey };
  });
  return allowed;
}

/** Whether this link is the person's live one. An older link, or one already used, is not. */
export async function isLiveResetLink(table: Table<PasswordResetRecord>, userId: string, codeKey: string): Promise<boolean> {
  return (await table.get(ledgerKey(userId)))?.current === codeKey;
}

/** No link is live any more (it was used, or the password was changed another way). The count of requests stays. */
export async function endResetLinks(table: Table<PasswordResetRecord>, userId: string): Promise<void> {
  await table.mutate(ledgerKey(userId), (current) => (current && current.current ? { ...current, current: null } : undefined));
  await table.deleteWhere({ userId });
}
