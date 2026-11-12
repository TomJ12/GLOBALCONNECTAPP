/**
 * Progressive lockout, shared by client and staff sign-in (each with its own
 * table). The key is what is being guessed against (an email's password, a
 * user's codes), whether or not that account exists, so a locked response
 * says nothing about existence.
 */
import type { Config } from '../config';
import { ApiError } from '../errors';
import type { AttemptRecord, Table } from '../store/types';

export class Lockout {
  constructor(
    private readonly attempts: Table<AttemptRecord>,
    private readonly config: Pick<Config, 'lockoutThreshold' | 'lockoutBaseMs' | 'lockoutMaxMs'>,
    private readonly now: () => number,
  ) {}

  async isLocked(key: string): Promise<boolean> {
    const record = await this.attempts.get(key);
    return record !== null && record.lockedUntil > this.now();
  }

  async assertNotLocked(key: string): Promise<void> {
    const record = await this.attempts.get(key);
    if (record && record.lockedUntil > this.now()) {
      throw new ApiError('rate_limited', { reason: 'locked', retryAfterSeconds: Math.ceil((record.lockedUntil - this.now()) / 1000) });
    }
  }

  /** Returns true when this failure started (or extended) a lock. */
  async recordFailure(key: string): Promise<boolean> {
    const record = (await this.attempts.get(key)) ?? { failures: 0, lockedUntil: 0 };
    record.failures += 1;
    const over = record.failures - this.config.lockoutThreshold;
    if (over >= 0) {
      record.lockedUntil = this.now() + Math.min(this.config.lockoutBaseMs * 2 ** Math.min(over, 30), this.config.lockoutMaxMs);
    }
    await this.attempts.put(key, record);
    return over >= 0;
  }

  clear(key: string): Promise<void> {
    return this.attempts.delete(key);
  }
}
