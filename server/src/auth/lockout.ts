/**
 * Progressive lockout, shared by client and staff sign-in (each with its own
 * table).
 *
 * An attempt is COUNTED BEFORE the credential is checked, in one atomic store
 * operation, so any number of simultaneous requests get exactly the allowed
 * number of checks. A success clears the count.
 *
 * Two counters guard each credential:
 *  - per account AND source address, with the low threshold. Somebody else's
 *    wrong guesses, from somewhere else, do not lock the owner out.
 *  - per account across all sources, with a much higher ceiling, so that a
 *    guesser who changes address is still stopped.
 *
 * The scope (`password`, `code`, `stepup`, `activation`) is part of the key:
 * failed step-up codes in a stolen session cannot lock sign-in.
 *
 * Whether the account exists plays no part, so a locked answer says nothing
 * about existence.
 */
import type { Config } from '../config';
import { ApiError } from '../errors';
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

  /** Counts one attempt against both counters. Throws `locked` (and counts nothing more) while a lock is running. */
  async begin(scope: LockScope, subject: string, source: string): Promise<Attempt> {
    const guards: [key: string, threshold: number][] = [
      [`${scope}:${subject}|${source}`, this.config.lockoutThreshold],
      [`${scope}:${subject}`, this.config.lockoutAccountThreshold],
    ];
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
        // An old count that never reached a lock is forgotten after the longest lock length.
        const failures = (current && now - current.updatedAt <= this.config.lockoutMaxMs ? current.failures : 0) + 1;
        const over = failures - threshold;
        if (over >= 0) attempt.locked = true;
        return {
          failures,
          lockedUntil: over >= 0 ? now + Math.min(this.config.lockoutBaseMs * 2 ** Math.min(over, 30), this.config.lockoutMaxMs) : 0,
          subject,
          updatedAt: now,
        };
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
    return (await this.attempts.count((record) => subjects.includes(record.subject) && record.lockedUntil > now)) > 0;
  }

  /** Clears every counter for these subjects, from every source. */
  unlock(subjects: string[]): Promise<void> {
    return this.attempts.deleteWhere((record) => subjects.includes(record.subject));
  }
}
