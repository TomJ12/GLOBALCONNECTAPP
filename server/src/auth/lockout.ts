/**
 * Progressive lockout, shared by client and staff sign-in (each with its own
 * table).
 *
 * An attempt is COUNTED BEFORE the credential is checked, in one atomic store
 * operation, so any number of simultaneous requests get exactly the allowed
 * number of checks. A success clears the count.
 *
 * Two counters guard each credential:
 *  - per account AND source (an IPv4 address, or an IPv6 /64), with the low
 *    threshold. Somebody else's wrong guesses, from somewhere else, do not
 *    lock the owner out.
 *  - per account across all sources, with a much higher ceiling, so that a
 *    guesser who keeps changing address is still stopped. This one is NOT
 *    applied to a network the account has completed a full sign-in from
 *    before (`trusted`): the owner, where they usually are, is not locked out
 *    by strangers elsewhere. An attacker on that same network still meets the
 *    per-source counter.
 *
 * A lock grows only when a full threshold of new failures follows it. After a
 * lock runs out the count starts again from nothing, so one guess per expiry
 * cannot keep an account locked or make the lock longer.
 *
 * The scope (`password`, `code`, `stepup`, `activation`) is part of the key:
 * failed step-up codes in a stolen session cannot lock sign-in.
 *
 * Whether the account exists plays no part, so a locked answer says nothing
 * about existence.
 */
import type { Config } from '../config';
import { ApiError } from '../errors';
import { networkOf, sourceOf } from '../net';
import type { AttemptRecord, Table } from '../store/types';

export type LockScope = 'password' | 'code' | 'stepup' | 'activation';

export interface Attempt {
  keys: string[];
  /** True when this attempt reached a threshold and started a lock. */
  locked: boolean;
  /** What each counter was before this attempt, for `forgive`. */
  before: (AttemptRecord | null)[];
}

export class Lockout {
  constructor(
    private readonly attempts: Table<AttemptRecord>,
    private readonly config: Pick<Config, 'lockoutThreshold' | 'lockoutAccountThreshold' | 'lockoutBaseMs' | 'lockoutMaxMs'>,
    private readonly now: () => number,
  ) {}

  /**
   * Counts one attempt. Throws `locked` (and counts nothing more) while a lock
   * is running. `trusted`: the request comes from a network this account has
   * fully signed in from before, so only the per-source counter applies.
   */
  async begin(scope: LockScope, subject: string, source: string, trusted = false): Promise<Attempt> {
    const guards: [key: string, threshold: number][] = [[`${scope}:${subject}|${sourceOf(source)}`, this.config.lockoutThreshold]];
    if (!trusted) guards.push([`${scope}:${subject}`, this.config.lockoutAccountThreshold]);
    const attempt: Attempt = { keys: [], locked: false, before: [] };
    for (const [key, threshold] of guards) {
      let retryAfterMs = 0;
      let previous: AttemptRecord | null = null;
      await this.attempts.mutate(key, (current) => {
        const now = this.now();
        previous = current;
        if (current && current.lockedUntil > now) {
          retryAfterMs = current.lockedUntil - now;
          return undefined;
        }
        // Everything is forgotten after a quiet period as long as the longest lock.
        const live = current && now - current.updatedAt <= this.config.lockoutMaxMs ? current : null;
        // A lock that has run out starts the count again: the next lock needs a full threshold of new failures.
        const failures = (live && live.lockedUntil === 0 ? live.failures : 0) + 1;
        const locks = live?.locks ?? 0;
        if (failures < threshold) return { failures, lockedUntil: 0, locks, subject, updatedAt: now };
        attempt.locked = true;
        return { failures, lockedUntil: now + Math.min(this.config.lockoutBaseMs * 2 ** Math.min(locks, 30), this.config.lockoutMaxMs), locks: locks + 1, subject, updatedAt: now };
      });
      if (retryAfterMs > 0) throw new ApiError('rate_limited', { reason: 'locked', retryAfterSeconds: Math.ceil(retryAfterMs / 1000) });
      attempt.keys.push(key);
      attempt.before.push(previous);
    }
    return attempt;
  }

  /** The credential was right: forget the counts. */
  async succeed(attempt: Attempt): Promise<void> {
    for (const key of attempt.keys) await this.attempts.delete(key);
  }

  /** The attempt was not a guess (a correct code used twice): put the counters back as they were. */
  async forgive(attempt: Attempt): Promise<void> {
    for (const [index, key] of attempt.keys.entries()) {
      const before = attempt.before[index] ?? null;
      await this.attempts.mutate(key, () => before);
    }
    attempt.locked = false;
  }

  async isLocked(subjects: string[]): Promise<boolean> {
    const now = this.now();
    for (const subject of subjects) if ((await this.attempts.count({ subject }, (record) => record.lockedUntil > now)) > 0) return true;
    return false;
  }

  /** Clears every counter for these subjects, from every source. */
  async unlock(subjects: string[]): Promise<void> {
    for (const subject of subjects) await this.attempts.deleteWhere({ subject });
  }
}

const KNOWN_SOURCES = 8;

/** Has this account completed a full sign-in from this network before? */
export function isKnownSource(account: { knownSources?: string[] } | null, source: string): boolean {
  return account?.knownSources?.includes(networkOf(source)) ?? false;
}

/** The account's known networks with this one added (newest last, a few at most). */
export function withKnownSource(known: string[] | undefined, source: string): string[] {
  const network = networkOf(source);
  return [...(known ?? []).filter((item) => item !== network), network].slice(-KNOWN_SOURCES);
}
