/**
 * Global Connect accounts: invite-only activation, password + authenticator
 * code sign-in, sessions and step-up. Nothing in here knows about providers.
 *
 * Secrets (passwords, authenticator keys, codes, tokens) are never logged and
 * tokens are stored only as SHA-256 hashes.
 */
import { canonicalJson } from '@/api/canonical';
import type { CodeMethod, CompanyOption, SessionUser, StepUpAction, UserRole } from '@/api/types';

import type { Config } from '../config';
import {
  checkTotp,
  hashPassword,
  newTotpSecret,
  normaliseCode,
  otpauthUri,
  PASSWORD_MIN_LENGTH,
  passwordProblem,
  randomCode,
  randomToken,
  sha256,
  verifyPassword,
} from '../crypto';
import { ApiError } from '../errors';
import type { AuditParty, CompanyRecord, SessionRecord, Stores, UserRecord } from '../store/types';
import { Lockout } from './lockout';

const ISSUER = 'Global Connect';
const RECOVERY_CODE_COUNT = 10;
const MAX_CHALLENGE_ATTEMPTS = 5;

const partyOf = (user: UserRecord): AuditParty => ({ type: 'client', id: user.id, label: user.email });
/** The neutral reason of a refusal, for the audit log. Never the submitted value. */
export const reasonOf = (error: unknown): string => (error instanceof ApiError ? (error.options.reason ?? error.kind) : 'error');

export interface SessionContext {
  session: SessionRecord;
  tokenHash: string;
  user: UserRecord;
  /** Null until a company is selected. */
  company: CompanyRecord | null;
  role: UserRole | null;
}

export interface SignedIn {
  token: string;
  user: SessionUser;
  companies: CompanyOption[];
  context: SessionContext;
}

export class AuthService {
  /** Verified against when the email is unknown, so both paths cost one scrypt. */
  private dummyHash: Promise<string> | null = null;
  private readonly lockout: Lockout;

  constructor(
    private readonly stores: Stores,
    private readonly config: Config,
    private readonly now: () => number = Date.now,
  ) {
    this.lockout = new Lockout(stores.auth.attempts, config, now);
  }

  /** Writes an authentication event. `detail` holds neutral reasons only: never a password, key, code or token. */
  private log(action: string, outcome: 'success' | 'failure', actor: AuditParty, source: string, detail: Record<string, string> = {}): Promise<void> {
    return this.stores.audit.append({ at: this.now(), actor, target: null, action, outcome, source, detail });
  }

  private assertNotLocked(key: string): Promise<void> {
    return this.lockout.assertNotLocked(key);
  }

  private async recordFailure(key: string, who?: AuditParty, source = ''): Promise<void> {
    const locked = await this.lockout.recordFailure(key);
    if (locked && who) await this.log('client.lockout', 'failure', who, source, { guarded: key.split(':')[0] ?? '' });
  }

  private clearFailures(key: string): Promise<void> {
    return this.lockout.clear(key);
  }

  // --- Invitations and activation ---------------------------------------------

  /** Operations only. Replaces any earlier unused invitation for the same person. */
  async createInvite(email: string): Promise<{ activationCode: string; activationLink: string; expiresAt: number }> {
    const user = await this.stores.directory.findUserByEmail(email);
    if (!user) throw new ApiError('not_found');
    if (user.activatedAt !== null) throw new ApiError('validation');
    await this.stores.auth.activations.deleteWhere((record) => record.userId === user.id);
    const activationCode = randomCode(4);
    const expiresAt = this.now() + this.config.activationTtlMs;
    await this.stores.auth.activations.put(sha256(normaliseCode(activationCode)), {
      userId: user.id,
      expiresAt,
      pendingPasswordHash: null,
      pendingTotpSecret: null,
    });
    return { activationCode, activationLink: `${this.config.appUrl}/activate?code=${activationCode}`, expiresAt };
  }

  private async activation(activationCode: string) {
    const key = sha256(normaliseCode(activationCode));
    const record = await this.stores.auth.activations.get(key);
    const user = record && record.expiresAt > this.now() ? await this.stores.directory.getUser(record.userId) : null;
    // One answer for unknown, expired, used and already-activated.
    if (!record || !user || user.activatedAt !== null) throw new ApiError('validation', { reason: 'activation_invalid' });
    return { key, record, user };
  }

  async activationStart(activationCode: string) {
    const { user } = await this.activation(activationCode);
    return { email: user.email, displayName: user.name, passwordPolicy: { minLength: PASSWORD_MIN_LENGTH } };
  }

  async activationPassword(activationCode: string, password: string) {
    const { key, record, user } = await this.activation(activationCode);
    if (passwordProblem(password) !== null) throw new ApiError('validation', { reason: 'weak_password', fields: ['password'] });
    record.pendingPasswordHash = await hashPassword(password);
    record.pendingTotpSecret = newTotpSecret();
    await this.stores.auth.activations.put(key, record);
    return { secret: record.pendingTotpSecret, otpauthUri: otpauthUri(ISSUER, user.email, record.pendingTotpSecret) };
  }

  /** Completes activation: needs a correct code from the newly added authenticator entry. The invitation is then spent. */
  async activationConfirm(activationCode: string, code: string, source = '') {
    const { key, record, user } = await this.activation(activationCode);
    if (!record.pendingPasswordHash || !record.pendingTotpSecret) throw new ApiError('validation', { reason: 'activation_invalid' });
    const lockKey = `activation:${key}`;
    await this.assertNotLocked(lockKey);
    const check = checkTotp(record.pendingTotpSecret, code, this.now(), 0);
    if (!check.ok) {
      await this.recordFailure(lockKey, partyOf(user), source);
      await this.log('client.activation', 'failure', partyOf(user), source, { reason: 'invalid_code' });
      throw new ApiError('validation', { reason: 'invalid_code', fields: ['code'] });
    }
    const recoveryCodes = Array.from({ length: RECOVERY_CODE_COUNT }, () => randomCode(2));
    await this.stores.directory.saveUser({
      ...user,
      passwordHash: record.pendingPasswordHash,
      totpSecret: record.pendingTotpSecret,
      lastTotpStep: check.step,
      recoveryCodeHashes: recoveryCodes.map((item) => sha256(normaliseCode(item))),
      activatedAt: this.now(),
    });
    await this.stores.auth.activations.delete(key);
    await this.clearFailures(lockKey);
    await this.log('client.activation', 'success', partyOf(user), source);
    return { recoveryCodes };
  }

  // --- Sign-in ----------------------------------------------------------------

  /**
   * Step 1. Unknown email, wrong password and not-yet-activated account all
   * give the same answer after the same work (one scrypt verification).
   */
  async login(email: string, password: string, source = ''): Promise<{ challengeId: string }> {
    const address = email.trim().toLowerCase();
    // The address as typed is kept for the audit log; it is not a secret, but cap what an anonymous caller can store.
    const who: AuditParty = { type: 'client', id: null, label: address.slice(0, 254) };
    try {
      return await this.checkPassword(address, password, who, source);
    } catch (error) {
      await this.log('client.sign_in', 'failure', who, source, { stage: 'password', reason: reasonOf(error) });
      throw error;
    }
  }

  private async checkPassword(address: string, password: string, who: AuditParty, source: string): Promise<{ challengeId: string }> {
    const lockKey = `password:${address}`;
    await this.assertNotLocked(lockKey);
    const user = await this.stores.directory.findUserByEmail(address);
    this.dummyHash ??= hashPassword(randomToken());
    // A disabled account answers exactly like an unknown one.
    const usable = user !== null && user.passwordHash !== null && user.activatedAt !== null && !user.disabledAt;
    const matches = await verifyPassword(password, usable ? (user.passwordHash as string) : await this.dummyHash);
    if (!usable || !matches) {
      await this.recordFailure(lockKey, who, source);
      throw new ApiError('validation', { reason: 'invalid_credentials' });
    }
    await this.clearFailures(lockKey);
    const challengeId = randomToken();
    await this.stores.auth.challenges.put(sha256(challengeId), {
      userId: user.id,
      expiresAt: this.now() + this.config.loginChallengeTtlMs,
      attempts: 0,
    });
    return { challengeId };
  }

  /** Checks an authenticator code for this user and burns its time step. */
  private async verifyUserTotp(user: UserRecord, code: string, source: string): Promise<UserRecord> {
    const lockKey = `code:${user.id}`;
    await this.assertNotLocked(lockKey);
    const check = user.totpSecret ? checkTotp(user.totpSecret, code, this.now(), user.lastTotpStep) : ({ ok: false, reason: 'invalid' } as const);
    if (!check.ok) {
      await this.recordFailure(lockKey, partyOf(user), source);
      throw new ApiError('validation', { reason: check.reason === 'reused' ? 'code_reused' : 'invalid_code', fields: ['code'] });
    }
    await this.clearFailures(lockKey);
    const updated = { ...user, lastTotpStep: check.step };
    await this.stores.directory.saveUser(updated);
    return updated;
  }

  /** Step 2. An authenticator code, or a recovery code that is then spent. */
  async verifyLogin(challengeId: string, code: string, method: CodeMethod, source = ''): Promise<SignedIn> {
    const challengeKey = sha256(challengeId);
    const challenge = await this.stores.auth.challenges.get(challengeKey);
    const found = challenge && challenge.expiresAt > this.now() ? await this.stores.directory.getUser(challenge.userId) : null;
    let user = found && !found.disabledAt ? found : null;
    if (!challenge || !user) {
      await this.stores.auth.challenges.delete(challengeKey);
      throw new ApiError('validation', { reason: 'challenge_expired' });
    }
    try {
      if (method === 'totp') {
        user = await this.verifyUserTotp(user, code, source);
      } else {
        const lockKey = `code:${user.id}`;
        await this.assertNotLocked(lockKey);
        const hash = sha256(normaliseCode(code));
        if (!user.recoveryCodeHashes.includes(hash)) {
          await this.recordFailure(lockKey, partyOf(user), source);
          throw new ApiError('validation', { reason: 'invalid_code', fields: ['code'] });
        }
        await this.clearFailures(lockKey);
        const kept = user.recoveryCodeHashes;
        user = { ...user, recoveryCodeHashes: kept.filter((item) => item !== hash) };
        await this.stores.directory.saveUser(user);
      }
    } catch (error) {
      await this.log('client.sign_in', 'failure', partyOf(user), source, { stage: 'code', method, reason: reasonOf(error) });
      challenge.attempts += 1;
      if (challenge.attempts >= MAX_CHALLENGE_ATTEMPTS) await this.stores.auth.challenges.delete(challengeKey);
      else await this.stores.auth.challenges.put(challengeKey, challenge);
      throw error;
    }
    await this.stores.auth.challenges.delete(challengeKey);
    user = { ...user, lastSignInAt: this.now() };
    await this.stores.directory.saveUser(user);
    await this.log('client.sign_in', 'success', partyOf(user), source, { method });

    const companies = await this.companiesOf(user.id);
    const token = randomToken();
    const tokenHash = sha256(token);
    const session: SessionRecord = {
      id: randomToken(),
      userId: user.id,
      // With exactly one company there is nothing to choose.
      companyId: companies.length === 1 ? (companies[0]?.company.id ?? null) : null,
      createdAt: this.now(),
      lastSeenAt: this.now(),
    };
    await this.stores.auth.sessions.put(tokenHash, session);
    return {
      token,
      user: { id: user.id, email: user.email, displayName: user.name },
      companies: companies.map(({ company }) => ({ id: company.id, name: company.name })),
      context: await this.contextFor(tokenHash, session, user),
    };
  }

  private async companiesOf(userId: string): Promise<{ company: CompanyRecord; role: UserRole }[]> {
    const memberships = await this.stores.directory.membershipsOf(userId);
    const found = await Promise.all(
      memberships.map(async (membership) => ({ company: await this.stores.directory.getCompany(membership.companyId), role: membership.role })),
    );
    // A deactivated company is as good as absent: it cannot be selected or used.
    return found.filter((item): item is { company: CompanyRecord; role: UserRole } => item.company !== null && !item.company.deactivatedAt);
  }

  private async contextFor(tokenHash: string, session: SessionRecord, user: UserRecord): Promise<SessionContext> {
    // Membership is re-read on every request, so removing someone from a company takes effect at once.
    const membership = session.companyId ? (await this.companiesOf(user.id)).find((item) => item.company.id === session.companyId) : undefined;
    return { session, tokenHash, user, company: membership?.company ?? null, role: membership?.role ?? null };
  }

  // --- Sessions ---------------------------------------------------------------

  /** Resolves the bearer token to a live session, or rejects with `unauthorized`. Refreshes the idle timer. */
  async authenticate(token: string | undefined): Promise<SessionContext> {
    if (!token) throw new ApiError('unauthorized');
    const tokenHash = sha256(token);
    const session = await this.stores.auth.sessions.get(tokenHash);
    const now = this.now();
    if (!session || now - session.lastSeenAt > this.config.sessionIdleMs || now - session.createdAt > this.config.sessionAbsoluteMs) {
      if (session) await this.revoke(tokenHash, session.id);
      throw new ApiError('unauthorized');
    }
    const user = await this.stores.directory.getUser(session.userId);
    if (!user || user.activatedAt === null || user.disabledAt) {
      await this.revoke(tokenHash, session.id);
      throw new ApiError('unauthorized');
    }
    session.lastSeenAt = now;
    await this.stores.auth.sessions.put(tokenHash, session);
    return this.contextFor(tokenHash, session, user);
  }

  /** Only a company the person belongs to can be selected. Anything else looks like "no such company". */
  async selectCompany(context: SessionContext, companyId: string): Promise<SessionContext> {
    const membership = (await this.companiesOf(context.user.id)).find((item) => item.company.id === companyId);
    if (!membership) throw new ApiError('not_found');
    const session = { ...context.session, companyId };
    await this.stores.auth.sessions.put(context.tokenHash, session);
    // A permission granted for one company must not carry over to another.
    await this.stores.auth.stepUps.deleteWhere((record) => record.sessionId === session.id);
    return { ...context, session, company: membership.company, role: membership.role };
  }

  private async revoke(tokenHash: string, sessionId: string): Promise<void> {
    await this.stores.auth.sessions.delete(tokenHash);
    await this.stores.auth.stepUps.deleteWhere((record) => record.sessionId === sessionId);
  }

  async logout(token: string | undefined, source = ''): Promise<void> {
    if (!token) return;
    const tokenHash = sha256(token);
    const session = await this.stores.auth.sessions.get(tokenHash);
    if (!session) return;
    await this.revoke(tokenHash, session.id);
    const user = await this.stores.directory.getUser(session.userId);
    if (user) await this.log('client.sign_out', 'success', partyOf(user), source);
  }

  // --- For operations (the ops console). None of these reads or returns a credential. ---

  activeSessionCount(userId: string): Promise<number> {
    const now = this.now();
    return this.stores.auth.sessions.count(
      (session) => session.userId === userId && now - session.lastSeenAt <= this.config.sessionIdleMs && now - session.createdAt <= this.config.sessionAbsoluteMs,
    );
  }

  /** Ends every session of this person. Returns how many there were. */
  async revokeAllSessions(userId: string): Promise<number> {
    const total = await this.stores.auth.sessions.count((session) => session.userId === userId);
    await this.stores.auth.sessions.deleteWhere((session) => session.userId === userId);
    await this.stores.auth.stepUps.deleteWhere((record) => record.userId === userId);
    await this.stores.auth.challenges.deleteWhere((record) => record.userId === userId);
    return total;
  }

  async isLocked(user: UserRecord): Promise<boolean> {
    return (await this.lockout.isLocked(`password:${user.email}`)) || (await this.lockout.isLocked(`code:${user.id}`));
  }

  async unlock(user: UserRecord): Promise<void> {
    await this.lockout.clear(`password:${user.email}`);
    await this.lockout.clear(`code:${user.id}`);
  }

  /**
   * Removes the password, the authenticator key and the recovery codes, ends
   * every session and withdraws any invitation. The person is back to "not
   * activated" and needs a new activation link.
   */
  async clearCredentials(userId: string): Promise<number> {
    const user = await this.stores.directory.getUser(userId);
    if (!user) throw new ApiError('not_found');
    await this.stores.directory.saveUser({ ...user, passwordHash: null, totpSecret: null, recoveryCodeHashes: [], activatedAt: null });
    await this.stores.auth.activations.deleteWhere((record) => record.userId === userId);
    await this.unlock(user);
    return this.revokeAllSessions(userId);
  }

  // --- Step-up ----------------------------------------------------------------

  /**
   * A fresh authenticator code buys ONE permission, for this person, in this
   * session, to do this action with exactly this payload, for a short time.
   */
  async grantStepUp(context: SessionContext, action: StepUpAction, payload: unknown, code: string, source = ''): Promise<{ token: string; expiresInSeconds: number }> {
    try {
      await this.verifyUserTotp(context.user, code, source);
    } catch (error) {
      await this.log('client.step_up', 'failure', partyOf(context.user), source, { for: action, reason: reasonOf(error) });
      throw error;
    }
    await this.log('client.step_up', 'success', partyOf(context.user), source, { for: action });
    const token = randomToken();
    await this.stores.auth.stepUps.put(sha256(token), {
      userId: context.user.id,
      sessionId: context.session.id,
      action,
      payloadHash: sha256(canonicalJson(payload)),
      expiresAt: this.now() + this.config.stepUpTtlMs,
    });
    return { token, expiresInSeconds: Math.floor(this.config.stepUpTtlMs / 1000) };
  }

  /** Spends the permission. A token is destroyed the first time it is presented, whether or not it fits. */
  async consumeStepUp(context: SessionContext, token: string | undefined, action: StepUpAction, payload: unknown): Promise<void> {
    if (!token) throw new ApiError('forbidden', { reason: 'step_up_required' });
    const key = sha256(token);
    const record = await this.stores.auth.stepUps.get(key);
    await this.stores.auth.stepUps.delete(key);
    const valid =
      record !== null &&
      record.expiresAt > this.now() &&
      record.userId === context.user.id &&
      record.sessionId === context.session.id &&
      record.action === action &&
      record.payloadHash === sha256(canonicalJson(payload));
    if (!valid) throw new ApiError('forbidden', { reason: 'step_up_invalid' });
  }
}
