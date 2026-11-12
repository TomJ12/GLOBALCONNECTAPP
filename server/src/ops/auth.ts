/**
 * Staff (ops) accounts. Same strength as client sign-in, but nothing is
 * shared with it: a separate account table, separate invitations, challenges,
 * sessions and lockout counters (stores.ops). A client session token means
 * nothing here and a staff session token means nothing on the client API.
 *
 * Step-up for staff is a fresh authenticator code sent WITH the action, so it
 * is bound to that action by construction and, like every code, works once.
 *
 * As in the client service, security state is only ever changed through the
 * store's atomic operations.
 */
import type { Config } from '../config';
import { reasonOf, secondsToNextCode, type Invitation } from '../auth/service';
import { isKnownSource, Lockout, withKnownSource } from '../auth/lockout';
import {
  checkTotp,
  decoyVerify,
  hashPassword,
  hashRecoveryCodes,
  matchRecoveryCode,
  newTotpSecret,
  normaliseCode,
  otpauthUri,
  passwordNeedsRehash,
  passwordProblem,
  randomCode,
  randomToken,
  RECOVERY_CODE_GROUPS,
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

export type { Invitation };

export const opsParty = (user: OpsUserRecord): AuditParty => ({ type: 'ops', id: user.id, label: user.email });
/** Activated and not disabled: someone who can act, and approve. */
export const isActiveStaff = (user: OpsUserRecord): boolean => user.activatedAt !== null && user.disabledAt === null;

export class OpsAuthService {
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

  /** Replaces any earlier unused invitation. For the mailer only: never returned over HTTP. The code is in the link's fragment. */
  async createInvite(userId: string): Promise<Invitation> {
    const user = await this.ops.users.get(userId);
    if (!user) throw new ApiError('not_found');
    if (user.activatedAt !== null || user.disabledAt !== null) throw new ApiError('validation');
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
    if (!record || !user || user.activatedAt !== null || user.disabledAt !== null) throw new ApiError('validation', { reason: 'activation_invalid' });
    return { key, record, user };
  }

  async activationStart(activationCode: string) {
    const { user } = await this.activation(activationCode);
    return { email: user.email, name: user.name };
  }

  async activationPassword(activationCode: string, password: string) {
    const { key, user } = await this.activation(activationCode);
    if (passwordProblem(password) !== null) throw new ApiError('validation', { reason: 'weak_password', fields: ['password'] });
    const pendingPasswordHash = await hashPassword(password, 'staff');
    const pendingTotpSecret = newTotpSecret();
    // Written only onto the same, still-live invitation: one replaced during the hash is not brought back.
    const stored = await this.ops.activations.mutate(key, (current) =>
      current && current.userId === user.id && current.expiresAt > this.now() ? { ...current, pendingPasswordHash, pendingTotpSecret } : undefined,
    );
    if (!stored || stored.pendingTotpSecret !== pendingTotpSecret) throw new ApiError('validation', { reason: 'activation_invalid' });
    return { email: user.email, secret: pendingTotpSecret, otpauthUri: otpauthUri(ISSUER, user.email, pendingTotpSecret) };
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
    const attempt = await this.lockout.begin('activation', `invite:${key}`, source);
    const check = checkTotp(record.pendingTotpSecret, code, this.now(), 0);
    if (!check.ok) {
      if (attempt.locked) await this.log('ops.lockout', 'failure', opsParty(user), source, { guarded: 'activation' });
      await this.log('ops.activation', 'failure', opsParty(user), source, { reason: 'invalid_code' });
      throw new ApiError('validation', { reason: 'invalid_code', fields: ['code'] });
    }
    const taken = await this.ops.activations.take(key);
    if (!taken || taken.pendingTotpSecret !== record.pendingTotpSecret || taken.pendingPasswordHash !== record.pendingPasswordHash) {
      throw new ApiError('validation', { reason: 'activation_invalid' });
    }
    const recoveryCodes = Array.from({ length: RECOVERY_CODE_COUNT }, () => randomCode(RECOVERY_CODE_GROUPS));
    const recoveryCodeHashes = await hashRecoveryCodes(recoveryCodes, 'staff');
    const saved = await this.ops.users.update(user.id, (current) =>
      current.activatedAt !== null || current.disabledAt !== null
        ? null
        : { ...current, passwordHash: taken.pendingPasswordHash, totpSecret: taken.pendingTotpSecret, lastTotpStep: check.step, recoveryCodeHashes, activatedAt: this.now() },
    );
    if (!saved) throw new ApiError('validation', { reason: 'activation_invalid' });
    await this.lockout.succeed(attempt);
    await this.log('ops.activation', 'success', opsParty(user), source);
    return { recoveryCodes };
  }

  // --- Sign-in -------------------------------------------------------------------

  /** Unknown email, wrong password, not-yet-activated and disabled all give the same answer after one scrypt verification. */
  async login(email: string, password: string, source: string): Promise<{ challengeId: string }> {
    const address = email.trim().toLowerCase();
    const who: AuditParty = { type: 'ops', id: null, label: address };
    try {
      const user = await this.ops.users.findByEmail(address);
      const attempt = await this.lockout.begin('password', `email:${address}`, source, isKnownSource(user, source));
      const usable = user !== null && user.passwordHash !== null && isActiveStaff(user);
      // Staff hashes have their own reserved capacity; attempts on addresses with no usable account do not use it.
      const matches = usable ? await verifyPassword(password, user.passwordHash as string, 'staff') : await decoyVerify(password);
      if (!usable || !matches) {
        if (attempt.locked) await this.log('ops.lockout', 'failure', who, source, { guarded: 'password' });
        throw new ApiError('validation', { reason: 'invalid_credentials' });
      }
      await this.lockout.succeed(attempt);
      if (passwordNeedsRehash(user.passwordHash as string)) {
        const stronger = await hashPassword(password, 'staff');
        await this.ops.users.update(user.id, (current) => (current.passwordHash === user.passwordHash ? { ...current, passwordHash: stronger } : null));
      }
      const challengeId = randomToken();
      await this.ops.challenges.put(sha256(challengeId), { userId: user.id, expiresAt: this.now() + this.config.loginChallengeTtlMs, attempts: 0 });
      return { challengeId };
    } catch (error) {
      await this.log('ops.sign_in', 'failure', who, source, { stage: 'password', reason: reasonOf(error) });
      throw error;
    }
  }

  private async verifyTotp(user: OpsUserRecord, code: string, scope: 'code' | 'stepup', source: string): Promise<OpsUserRecord> {
    const attempt = await this.lockout.begin(scope, `user:${user.id}`, source, isKnownSource(user, source));
    const check = user.totpSecret ? checkTotp(user.totpSecret, code, this.now(), user.lastTotpStep) : ({ ok: false, reason: 'invalid' } as const);
    const reused = async (): Promise<never> => {
      await this.lockout.forgive(attempt);
      throw new ApiError('validation', { reason: 'code_reused', fields: ['code'], retryAfterSeconds: secondsToNextCode(this.now()) });
    };
    if (!check.ok) {
      if (check.reason === 'reused') return reused();
      if (attempt.locked) await this.log('ops.lockout', 'failure', opsParty(user), source, { guarded: scope });
      throw new ApiError('validation', { reason: 'invalid_code', fields: ['code'] });
    }
    const updated = await this.ops.users.update(user.id, (current) =>
      current.totpSecret === user.totpSecret && current.lastTotpStep < check.step ? { ...current, lastTotpStep: check.step } : null,
    );
    if (!updated) return reused();
    await this.lockout.succeed(attempt);
    return updated;
  }

  private async verifyRecoveryCode(user: OpsUserRecord, code: string, source: string): Promise<OpsUserRecord> {
    const attempt = await this.lockout.begin('code', `user:${user.id}`, source, isKnownSource(user, source));
    const match = await matchRecoveryCode(code, user.recoveryCodeHashes, 'staff');
    const updated = match
      ? await this.ops.users.update(user.id, (current) =>
          current.recoveryCodeHashes.includes(match) ? { ...current, recoveryCodeHashes: current.recoveryCodeHashes.filter((item) => item !== match) } : null,
        )
      : null;
    if (!updated) {
      if (attempt.locked) await this.log('ops.lockout', 'failure', opsParty(user), source, { guarded: 'code' });
      throw new ApiError('validation', { reason: 'invalid_code', fields: ['code'] });
    }
    await this.lockout.succeed(attempt);
    return updated;
  }

  async verifyLogin(challengeId: string, code: string, method: 'totp' | 'recovery', source: string): Promise<{ token: string; user: OpsUserRecord }> {
    const challengeKey = sha256(challengeId);
    const challenge = await this.ops.challenges.get(challengeKey);
    const found = challenge && challenge.expiresAt > this.now() ? await this.ops.users.get(challenge.userId) : null;
    let user = found && isActiveStaff(found) ? found : null;
    if (!challenge || !user) {
      await this.ops.challenges.delete(challengeKey);
      throw new ApiError('validation', { reason: 'challenge_expired' });
    }
    try {
      user = method === 'totp' ? await this.verifyTotp(user, code, 'code', source) : await this.verifyRecoveryCode(user, code, source);
    } catch (error) {
      if (reasonOf(error) !== 'code_reused') {
        await this.ops.challenges.mutate(challengeKey, (current) =>
          current === null ? undefined : current.attempts + 1 >= MAX_CHALLENGE_ATTEMPTS ? null : { ...current, attempts: current.attempts + 1 },
        );
      }
      await this.log('ops.sign_in', 'failure', opsParty(user), source, { stage: 'code', method, reason: reasonOf(error) });
      throw error;
    }
    if (!(await this.ops.challenges.take(challengeKey))) throw new ApiError('validation', { reason: 'challenge_expired' });
    user = (await this.ops.users.update(user.id, (current) => ({ ...current, lastSignInAt: this.now(), knownSources: withKnownSource(current.knownSources, source) }))) ?? user;
    const token = randomToken();
    await this.ops.sessions.put(sha256(token), { id: randomToken(), userId: user.id, createdAt: this.now(), lastSeenAt: this.now() });
    await this.log('ops.sign_in', 'success', opsParty(user), source, { method });
    return { token, user };
  }

  // --- Sessions ------------------------------------------------------------------

  async authenticate(token: string | undefined): Promise<OpsContext> {
    if (!token) throw new ApiError('unauthorized');
    const tokenHash = sha256(token);
    const found = await this.ops.sessions.get(tokenHash);
    const now = this.now();
    const live = found !== null && now - found.lastSeenAt <= this.config.opsSessionIdleMs && now - found.createdAt <= this.config.opsSessionAbsoluteMs;
    const user = live ? await this.ops.users.get(found.userId) : null;
    if (!found || !user || !isActiveStaff(user)) {
      await this.ops.sessions.delete(tokenHash);
      throw new ApiError('unauthorized');
    }
    // Only an existing session is touched: one revoked a moment ago is not written back.
    const session = await this.ops.sessions.mutate(tokenHash, (current) => (current ? { ...current, lastSeenAt: now } : undefined));
    if (!session) throw new ApiError('unauthorized');
    return { session, token, user };
  }

  async logout(token: string | undefined, source: string): Promise<void> {
    if (!token) return;
    const session = await this.ops.sessions.take(sha256(token));
    if (!session) return;
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
    const user = await this.ops.users.update(userId, (current) => ({ ...current, passwordHash: null, totpSecret: null, recoveryCodeHashes: [], activatedAt: null }));
    if (!user) throw new ApiError('not_found');
    await this.ops.activations.deleteWhere((record) => record.userId === userId);
    await this.lockout.unlock([`email:${user.email}`, `user:${user.id}`]);
    return this.revokeAllSessions(userId);
  }

  private subjectsOf(user: OpsUserRecord): string[] {
    return [`email:${user.email}`, `user:${user.id}`];
  }

  isLocked(user: OpsUserRecord): Promise<boolean> {
    return this.lockout.isLocked(this.subjectsOf(user));
  }

  /** Clears every failed-attempt counter of this staff member, from every source. */
  unlock(user: OpsUserRecord): Promise<void> {
    return this.lockout.unlock(this.subjectsOf(user));
  }

  // --- Step-up -------------------------------------------------------------------

  /** A fresh, unused authenticator code from this staff member, for this one action. */
  async stepUp(context: OpsContext, code: string, action: string, source: string): Promise<void> {
    try {
      context.user = await this.verifyTotp(context.user, code, 'stepup', source);
    } catch (error) {
      await this.log('ops.step_up', 'failure', opsParty(context.user), source, { for: action, reason: reasonOf(error) });
      throw error;
    }
    await this.log('ops.step_up', 'success', opsParty(context.user), source, { for: action });
  }
}
