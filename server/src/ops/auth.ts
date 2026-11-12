/**
 * Staff (ops) accounts. Same strength as client sign-in, but nothing is
 * shared with it: a separate account table, separate invitations, challenges,
 * sessions and lockout counters (stores.ops). A client session token means
 * nothing here and a staff session token means nothing on the client API.
 *
 * Step-up for staff is a fresh authenticator code sent WITH the action, so it
 * is bound to that action by construction and, like every code, works once.
 */
import type { Config } from '../config';
import { reasonOf } from '../auth/service';
import { Lockout } from '../auth/lockout';
import {
  checkTotp,
  hashPassword,
  newTotpSecret,
  normaliseCode,
  otpauthUri,
  passwordProblem,
  randomCode,
  randomToken,
  sha256,
  verifyPassword,
} from '../crypto';
import { ApiError } from '../errors';
import type { AuditParty, OpsRole, OpsSessionRecord, OpsUserRecord, Stores } from '../store/types';

const ISSUER = 'Global Connect Ops';
const RECOVERY_CODE_COUNT = 10;
const MAX_CHALLENGE_ATTEMPTS = 5;

export interface OpsContext {
  session: OpsSessionRecord;
  /** The raw session token, kept only for the lifetime of the request (CSRF binding). */
  token: string;
  user: OpsUserRecord;
}

export interface Invitation {
  activationCode: string;
  activationLink: string;
  expiresAt: number;
}

export const opsParty = (user: OpsUserRecord): AuditParty => ({ type: 'ops', id: user.id, label: user.email });

export class OpsAuthService {
  private dummyHash: Promise<string> | null = null;
  private readonly lockout: Lockout;

  constructor(
    private readonly stores: Stores,
    private readonly config: Config,
    private readonly now: () => number = Date.now,
  ) {
    this.lockout = new Lockout(stores.ops.attempts, config, now);
  }

  private get ops() {
    return this.stores.ops;
  }

  private log(action: string, outcome: 'success' | 'failure', actor: AuditParty, source: string, detail: Record<string, string> = {}): Promise<void> {
    return this.stores.audit.append({ at: this.now(), actor, target: null, action, outcome, source, detail });
  }

  private async fail(key: string, who: AuditParty, source: string): Promise<void> {
    if (await this.lockout.recordFailure(key)) await this.log('ops.lockout', 'failure', who, source, { guarded: key.split(':')[0] ?? '' });
  }

  // --- Accounts and invitations ------------------------------------------------

  /** Adds a staff account that still has to be activated. The caller decides who may do this. */
  async createUser(email: string, name: string, role: OpsRole): Promise<OpsUserRecord> {
    const address = email.trim().toLowerCase();
    if (await this.ops.users.findByEmail(address)) throw new ApiError('validation', { fields: ['email'] });
    const user: OpsUserRecord = {
      id: `ops_${randomToken().slice(0, 12)}`,
      email: address,
      name: name.trim(),
      role,
      passwordHash: null,
      totpSecret: null,
      lastTotpStep: 0,
      recoveryCodeHashes: [],
      activatedAt: null,
      disabledAt: null,
      lastSignInAt: null,
    };
    await this.ops.users.save(user);
    return user;
  }

  /** Replaces any earlier unused invitation. The code is put in the link's fragment, which browsers do not send to servers. */
  async createInvite(userId: string): Promise<Invitation> {
    const user = await this.ops.users.get(userId);
    if (!user) throw new ApiError('not_found');
    if (user.activatedAt !== null) throw new ApiError('validation');
    await this.ops.activations.deleteWhere((record) => record.userId === user.id);
    const activationCode = randomCode(4);
    const expiresAt = this.now() + this.config.activationTtlMs;
    await this.ops.activations.put(sha256(normaliseCode(activationCode)), { userId: user.id, expiresAt, pendingPasswordHash: null, pendingTotpSecret: null });
    return { activationCode, activationLink: `${this.config.opsUrl}/ops/activate#code=${activationCode}`, expiresAt };
  }

  private async activation(activationCode: string) {
    const key = sha256(normaliseCode(activationCode));
    const record = await this.ops.activations.get(key);
    const user = record && record.expiresAt > this.now() ? await this.ops.users.get(record.userId) : null;
    if (!record || !user || user.activatedAt !== null || user.disabledAt) throw new ApiError('validation', { reason: 'activation_invalid' });
    return { key, record, user };
  }

  async activationStart(activationCode: string) {
    const { user } = await this.activation(activationCode);
    return { email: user.email, name: user.name };
  }

  async activationPassword(activationCode: string, password: string) {
    const { key, record, user } = await this.activation(activationCode);
    if (passwordProblem(password) !== null) throw new ApiError('validation', { reason: 'weak_password', fields: ['password'] });
    record.pendingPasswordHash = await hashPassword(password);
    record.pendingTotpSecret = newTotpSecret();
    await this.ops.activations.put(key, record);
    return { email: user.email, secret: record.pendingTotpSecret, otpauthUri: otpauthUri(ISSUER, user.email, record.pendingTotpSecret) };
  }

  /** The enrolment in progress, so the page can be shown again after a wrong code. */
  async activationPending(activationCode: string) {
    const { record, user } = await this.activation(activationCode);
    if (!record.pendingTotpSecret) throw new ApiError('validation', { reason: 'activation_invalid' });
    return { email: user.email, secret: record.pendingTotpSecret, otpauthUri: otpauthUri(ISSUER, user.email, record.pendingTotpSecret) };
  }

  async activationConfirm(activationCode: string, code: string, source: string) {
    const { key, record, user } = await this.activation(activationCode);
    if (!record.pendingPasswordHash || !record.pendingTotpSecret) throw new ApiError('validation', { reason: 'activation_invalid' });
    const lockKey = `activation:${key}`;
    await this.lockout.assertNotLocked(lockKey);
    const check = checkTotp(record.pendingTotpSecret, code, this.now(), 0);
    if (!check.ok) {
      await this.fail(lockKey, opsParty(user), source);
      await this.log('ops.activation', 'failure', opsParty(user), source, { reason: 'invalid_code' });
      throw new ApiError('validation', { reason: 'invalid_code', fields: ['code'] });
    }
    const recoveryCodes = Array.from({ length: RECOVERY_CODE_COUNT }, () => randomCode(2));
    await this.ops.users.save({
      ...user,
      passwordHash: record.pendingPasswordHash,
      totpSecret: record.pendingTotpSecret,
      lastTotpStep: check.step,
      recoveryCodeHashes: recoveryCodes.map((item) => sha256(normaliseCode(item))),
      activatedAt: this.now(),
    });
    await this.ops.activations.delete(key);
    await this.lockout.clear(lockKey);
    await this.log('ops.activation', 'success', opsParty(user), source);
    return { recoveryCodes };
  }

  // --- Sign-in -------------------------------------------------------------------

  /** Unknown email, wrong password, not-yet-activated and disabled all give the same answer after one scrypt verification. */
  async login(email: string, password: string, source: string): Promise<{ challengeId: string }> {
    const address = email.trim().toLowerCase();
    const who: AuditParty = { type: 'ops', id: null, label: address.slice(0, 254) };
    try {
      const lockKey = `password:${address}`;
      await this.lockout.assertNotLocked(lockKey);
      const user = await this.ops.users.findByEmail(address);
      this.dummyHash ??= hashPassword(randomToken());
      const usable = user !== null && user.passwordHash !== null && user.activatedAt !== null && user.disabledAt === null;
      const matches = await verifyPassword(password, usable ? (user.passwordHash as string) : await this.dummyHash);
      if (!usable || !matches) {
        await this.fail(lockKey, who, source);
        throw new ApiError('validation', { reason: 'invalid_credentials' });
      }
      await this.lockout.clear(lockKey);
      const challengeId = randomToken();
      await this.ops.challenges.put(sha256(challengeId), { userId: user.id, expiresAt: this.now() + this.config.loginChallengeTtlMs, attempts: 0 });
      return { challengeId };
    } catch (error) {
      await this.log('ops.sign_in', 'failure', who, source, { stage: 'password', reason: reasonOf(error) });
      throw error;
    }
  }

  private async verifyTotp(user: OpsUserRecord, code: string, source: string): Promise<OpsUserRecord> {
    const lockKey = `code:${user.id}`;
    await this.lockout.assertNotLocked(lockKey);
    const check = user.totpSecret ? checkTotp(user.totpSecret, code, this.now(), user.lastTotpStep) : ({ ok: false, reason: 'invalid' } as const);
    if (!check.ok) {
      await this.fail(lockKey, opsParty(user), source);
      throw new ApiError('validation', { reason: check.reason === 'reused' ? 'code_reused' : 'invalid_code', fields: ['code'] });
    }
    await this.lockout.clear(lockKey);
    const updated = { ...user, lastTotpStep: check.step };
    await this.ops.users.save(updated);
    return updated;
  }

  async verifyLogin(challengeId: string, code: string, method: 'totp' | 'recovery', source: string): Promise<{ token: string; user: OpsUserRecord }> {
    const challengeKey = sha256(challengeId);
    const challenge = await this.ops.challenges.get(challengeKey);
    const found = challenge && challenge.expiresAt > this.now() ? await this.ops.users.get(challenge.userId) : null;
    let user = found && found.disabledAt === null ? found : null;
    if (!challenge || !user) {
      await this.ops.challenges.delete(challengeKey);
      throw new ApiError('validation', { reason: 'challenge_expired' });
    }
    try {
      if (method === 'totp') user = await this.verifyTotp(user, code, source);
      else {
        const lockKey = `code:${user.id}`;
        await this.lockout.assertNotLocked(lockKey);
        const hash = sha256(normaliseCode(code));
        if (!user.recoveryCodeHashes.includes(hash)) {
          await this.fail(lockKey, opsParty(user), source);
          throw new ApiError('validation', { reason: 'invalid_code', fields: ['code'] });
        }
        await this.lockout.clear(lockKey);
        user = { ...user, recoveryCodeHashes: user.recoveryCodeHashes.filter((item) => item !== hash) };
      }
    } catch (error) {
      challenge.attempts += 1;
      if (challenge.attempts >= MAX_CHALLENGE_ATTEMPTS) await this.ops.challenges.delete(challengeKey);
      else await this.ops.challenges.put(challengeKey, challenge);
      await this.log('ops.sign_in', 'failure', opsParty(user), source, { stage: 'code', method, reason: reasonOf(error) });
      throw error;
    }
    await this.ops.challenges.delete(challengeKey);
    user = { ...user, lastSignInAt: this.now() };
    await this.ops.users.save(user);
    const token = randomToken();
    await this.ops.sessions.put(sha256(token), { id: randomToken(), userId: user.id, createdAt: this.now(), lastSeenAt: this.now() });
    await this.log('ops.sign_in', 'success', opsParty(user), source, { method });
    return { token, user };
  }

  // --- Sessions ------------------------------------------------------------------

  async authenticate(token: string | undefined): Promise<OpsContext> {
    if (!token) throw new ApiError('unauthorized');
    const tokenHash = sha256(token);
    const session = await this.ops.sessions.get(tokenHash);
    const now = this.now();
    const live = session !== null && now - session.lastSeenAt <= this.config.opsSessionIdleMs && now - session.createdAt <= this.config.opsSessionAbsoluteMs;
    const user = live ? await this.ops.users.get(session.userId) : null;
    if (!session || !user || user.activatedAt === null || user.disabledAt !== null) {
      await this.ops.sessions.delete(tokenHash);
      throw new ApiError('unauthorized');
    }
    session.lastSeenAt = now;
    await this.ops.sessions.put(tokenHash, session);
    return { session, token, user };
  }

  async logout(token: string | undefined, source: string): Promise<void> {
    if (!token) return;
    const tokenHash = sha256(token);
    const session = await this.ops.sessions.get(tokenHash);
    if (!session) return;
    await this.ops.sessions.delete(tokenHash);
    const user = await this.ops.users.get(session.userId);
    if (user) await this.log('ops.sign_out', 'success', opsParty(user), source);
  }

  async revokeAllSessions(userId: string): Promise<number> {
    const total = await this.ops.sessions.count((session) => session.userId === userId);
    await this.ops.sessions.deleteWhere((session) => session.userId === userId);
    await this.ops.challenges.deleteWhere((record) => record.userId === userId);
    return total;
  }

  /** Removes password, authenticator key and recovery codes and ends every session. */
  async clearCredentials(userId: string): Promise<number> {
    const user = await this.ops.users.get(userId);
    if (!user) throw new ApiError('not_found');
    await this.ops.users.save({ ...user, passwordHash: null, totpSecret: null, recoveryCodeHashes: [], activatedAt: null });
    await this.ops.activations.deleteWhere((record) => record.userId === userId);
    await this.lockout.clear(`password:${user.email}`);
    await this.lockout.clear(`code:${user.id}`);
    return this.revokeAllSessions(userId);
  }

  // --- Step-up -------------------------------------------------------------------

  /** A fresh, unused authenticator code from this staff member, for this one action. */
  async stepUp(context: OpsContext, code: string, action: string, source: string): Promise<void> {
    try {
      context.user = await this.verifyTotp(context.user, code, source);
    } catch (error) {
      await this.log('ops.step_up', 'failure', opsParty(context.user), source, { for: action, reason: reasonOf(error) });
      throw error;
    }
    await this.log('ops.step_up', 'success', opsParty(context.user), source, { for: action });
  }
}
