/**
 * HOW MANY reset links a person may be sent, and WHICH are live, decided in ONE database transaction.
 *
 * Anybody can ask for a reset link for anybody's address: the request is anonymous by nature. So a request must
 * never be able to take something away from the account's owner:
 *
 *  - A NEW LINK DOES NOT KILL AN OLDER ONE. A person may have a few live links at once; each works once, each
 *    expires by itself, and ALL of them die when one is used (or the password is changed another way).
 *  - THE COUNT IS PER SOURCE NETWORK as well as per account. One network gets `perSource` links an hour for an
 *    account. All networks the account has never signed in from share `unknown` an hour (and `unknownPerDay`).
 *    A network the account HAS signed in from is not counted against that share, so strangers cannot use up what
 *    the owner, asking from where they usually are, is entitled to.
 *  - THE ACCOUNT HAS A CEILING (`account` an hour, `accountPerDay`), which is also the most reset emails it can be
 *    made to receive: nobody can use this to flood a mailbox.
 *
 * Each person has one ledger row (beside the links themselves, in the same table). Asking for a link reads the
 * requests on record, refuses if this one is over a limit, and otherwise records it and adds its link to the live
 * ones, all in a single read-modify-write: requests arriving together cannot slip under a limit between them.
 */
import { networkOf } from '../net';
import type { PasswordResetRecord, Table } from '../store/types';

const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;
const ledgerKey = (userId: string): string => `ledger:${userId}`;

export const RESET_LIMITS = {
  /** From one network, for one account, per hour. */
  perSource: 2,
  /** From all networks the account has never signed in from, together: per hour, and per day. */
  unknown: 3,
  unknownPerDay: 8,
  /** For one account from anywhere: per hour, and per day. Above `unknown`, so a known network always has some left. */
  account: 5,
  accountPerDay: 20,
} as const;

export type ResetRefusal = 'source' | 'unknown_sources' | 'account';
type Asked = NonNullable<PasswordResetRecord['asked']>[number];

/**
 * Records a request and adds `codeKey` to the person's live links. Returns null when it was allowed, or which
 * limit refused it (nothing changed). `known`: the account has completed a sign-in from this network before.
 */
export async function claimResetLink(table: Table<PasswordResetRecord>, userId: string, codeKey: string, at: number, from: { source: string; known: boolean }, liveForMs: number): Promise<ResetRefusal | null> {
  const network = networkOf(from.source);
  let refused: ResetRefusal | null = null;
  await table.mutate(ledgerKey(userId), (current) => {
    // (Rows written before requests were counted by network hold bare times: they count as from an unknown network.)
    const asked: Asked[] = [...(current?.requests ?? []).map((time) => ({ at: time, network: '', known: false })), ...(current?.asked ?? [])].filter((item) => item.at > at - DAY);
    const lastHour = asked.filter((item) => item.at > at - HOUR);
    refused =
      lastHour.filter((item) => item.network === network).length >= RESET_LIMITS.perSource
        ? 'source'
        : !from.known && (lastHour.filter((item) => !item.known).length >= RESET_LIMITS.unknown || asked.filter((item) => !item.known).length >= RESET_LIMITS.unknownPerDay)
          ? 'unknown_sources'
          : lastHour.length >= RESET_LIMITS.account || asked.length >= RESET_LIMITS.accountPerDay
            ? 'account'
            : null;
    if (refused) return undefined;
    const live = [...(current?.live ?? (current?.current ? [{ key: current.current, until: at + liveForMs }] : [])).filter((item) => item.until > at), { key: codeKey, until: at + liveForMs }];
    // (The row's userId is not the person's, so that "delete this person's links" leaves the count of requests alone.)
    return { userId: ledgerKey(userId), expiresAt: at + DAY, attempts: 0, asked: [...asked, { at, network, known: from.known }], live };
  });
  return refused;
}

/** Whether this link is one of the person's live ones. One that was used, or issued before a reset that has since happened, is not. */
export async function isLiveResetLink(table: Table<PasswordResetRecord>, userId: string, codeKey: string): Promise<boolean> {
  const ledger = await table.get(ledgerKey(userId));
  return ledger?.live?.some((item) => item.key === codeKey) ?? ledger?.current === codeKey;
}

/** The link's email was accepted by the mail server at `sentAt`: the link is good for `ttlMs` from THAT moment. */
export async function resetLinkSent(table: Table<PasswordResetRecord>, codeKey: string, sentAt: number, ttlMs: number): Promise<void> {
  const link = await table.mutate(codeKey, (current) => (current ? { ...current, expiresAt: Math.max(current.expiresAt, sentAt + ttlMs) } : undefined));
  if (!link) return;
  await table.mutate(ledgerKey(link.userId), (current) => (current?.live ? { ...current, live: current.live.map((item) => (item.key === codeKey ? { ...item, until: Math.max(item.until, sentAt + ttlMs) } : item)) } : undefined));
}

/** No link is live any more (one was used, or the password was changed another way). The count of requests stays. */
export async function endResetLinks(table: Table<PasswordResetRecord>, userId: string): Promise<void> {
  await table.mutate(ledgerKey(userId), (current) => (current && ((current.live?.length ?? 0) > 0 || current.current) ? { ...current, current: null, live: [] } : undefined));
  await table.deleteWhere({ userId });
}
