/**
 * Global Connect accounts: invite-only activation, password + authenticator
 * code sign-in, sessions and step-up. Nothing in here knows about providers.
 *
 * Secrets (passwords, authenticator keys, codes, tokens) are never logged and
 * tokens are stored only as SHA-256 hashes.
 *
 * Every read-modify-write of security state goes through an atomic store
 * operation (Table.mutate / Table.take / Directory.updateUser), never
 * get-then-put: an invitation that was replaced cannot be written back, a
 * TOTP step or a step-up permission can be spent once however many requests
 * arrive together, and a revoked session cannot be revived by a request that
 * was already in flight.
 */
import { canonicalJson } from '@/api/canonical';
import type { CodeMethod, CompanyOption, SessionUser, StepUpAction, UserRole } from '@/api/types';

import type { Config } from '../config';
import {
  checkTotp,
  decoyVerify,
  hashPassword,
  hashRecoveryCodes,
  matchRecoveryCode,
  newTotpSecret,
  normaliseCode,
  otpauthUri,
  PASSWORD_MIN_LENGTH,
  passwordNeedsRehash,
  passwordProblem,
  randomCode,
  randomToken,
  RECOVERY_CODE_GROUPS,
  sha256,
  TOTP_STEP_SECONDS,
  verifyPassword,
} from '../crypto';
import { ApiError } from '../errors';
import type { AuditParty, CompanyRecord, SessionRecord, Stores, UserRecord } from '../store/types';
import { isKnownSource, Lockout, withKnownSource, type Attempt, type LockScope } from './lockout';
import type { MailQueue } from '../mail/queue';
import { mailOf, type SecurityNotice } from '../mail/templates';
import type { SecurityNotices } from '../notify/security';

const ISSUER = 'Global Connect';
const RECOVERY_CODE_COUNT = 10;
const MAX_CHALLENGE_ATTEMPTS = 5;
/** A password-reset link works once, for half an hour. */
export const PASSWORD_RESET_TTL_MS = 30 * 60_000;
/** Reset links emailed to one account per hour. Asking more often changes nothing and sends nothing. */
export const RESET_REQUESTS_PER_HOUR = 3;
const ROUGH_MS = 15 * 60_000;

/** "Chrome on Windows": the family of browser or app and of system, from what the client said about itself. Never the string itself. */
export function agentFamily(userAgent: string): string {
  const ua = userAgent.slice(0, 400);
  const system = /Windows/i.test(ua) ? 'Windows' : /iPhone|iPad|iOS|CFNetwork|Darwin/i.test(ua) ? (/Macintosh|Mac OS X/i.test(ua) && !/iPhone|iPad/i.test(ua) ? 'macOS' : 'iPhone or iPad') : /Android|okhttp/i.test(ua) ? 'Android' : /Macintosh|Mac OS X/i.test(ua) ? 'macOS' : /Linux|X11/i.test(ua) ? 'Linux' : null;
  const browser = /okhttp|CFNetwork|Expo|GlobalConnect/i.test(ua) ? 'Global Connect app' : /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : null;
  if (!system && !browser) return 'Unknown device';
  return `${browser ?? 'A browser'} on ${system ?? 'an unknown system'}`;
}

/** How often, at most, a session's "last seen" time is written. */
export const SEEN_WRITE_MS = 60_000;
export const partyOf = (user: UserRecord): AuditParty => ({ type: 'client', id: user.id, label: user.email });
/** The neutral reason of a refusal, for the audit log. Never the submitted value. */
export const reasonOf = (error: unknown): string => (error instanceof ApiError ? (error.options.reason ?? error.kind) : 'error');
/** Seconds until the authenticator app shows its next code. */
export const secondsToNextCode = (nowMs: number): number => TOTP_STEP_SECONDS - (Math.floor(nowMs / 1000) % TOTP_STEP_SECONDS);

export interface Invitation {
  activationCode: string;
  activationLink: string;
  expiresAt: number;
}

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
  private readonly lockout: Lockout;

  constructor(
    private readonly stores: Stores,
    private readonly config: Config,
    private readonly now: () => number = Date.now,
  ) {
    this.lockout = new Lockout(stores.auth.attempts, config, now);
  }

  /** The email outbox and the security notices, attached once the app has built them. Without them nothing is emailed (tests of this class alone). */
  private mail: MailQueue | null = null;
  private notices: SecurityNotices | null = null;
  attach(mail: MailQueue, notices: SecurityNotices): void {
    this.mail = mail;
    this.notices = notices;
  }
  private notice(user: UserRecord, kind: SecurityNotice, extra: { until?: number } = {}): Promise<void> {
    return this.notices?.send({ id: user.id, email: user.email, name: user.name }, 'client', kind, extra) ?? Promise.resolve();
  }
  /** Work started by a request and finished after its answer (so that the answer's timing says nothing). Tests wait for it with `settle`. */
  private readonly background = new Set<Promise<unknown>>();
  private later(work: Promise<unknown>): void {
    const tracked = work.catch(() => {}).finally(() => this.background.delete(tracked));
    this.background.add(tracked);
  }
  async settle(): Promise<void> {
    while (this.background.size > 0) await Promise.all([...this.background]);
  }

  /** Writes an audit event. `detail` holds neutral facts only: never a password, key, code or token. */
  record(action: string, outcome: 'success' | 'failure', actor: AuditParty, source: string, detail: Record<string, string> = {}, target: AuditParty | null = null): Promise<void> {
    return this.stores.audit.append({ at: this.now(), actor, target, action, outcome, source, detail });
  }

  private async begin(scope: LockScope, subject: string, source: string, trusted = false): Promise<Attempt> {
    return this.lockout.begin(scope, subject, source, trusted);
  }

  // --- Invitations and activation ---------------------------------------------

  /**
   * Replaces any earlier unused invitation for the same person. The result is
   * for the mailer (or, in development, the console): it is never returned
   * over HTTP or shown to staff. The code sits in the link's fragment, which
   * browsers do not send to servers, so it is in no request log.
   */
  async createInvite(email: string): Promise<Invitation> {
    const user = await this.stores.directory.findUserByEmail(email);
    if (!user) throw new ApiError('not_found');
    if (user.activatedAt !== null || user.disabledAt) throw new ApiError('validation');
    await this.stores.auth.activations.deleteWhere({ userId: user.id });
    const activationCode = randomCode(4);
    const expiresAt = this.now() + this.config.activationTtlMs;
    await this.stores.auth.activations.put(sha256(normaliseCode(activationCode)), {
      userId: user.id,
      expiresAt,
      pendingPasswordHash: null,
      pendingTotpSecret: null,
    });
    return { activationCode, activationLink: `${this.config.appUrl}/activate#code=${activationCode}`, expiresAt };
  }

  private async activation(activationCode: string) {
    const key = sha256(normaliseCode(activationCode));
    const record = await this.stores.auth.activations.get(key);
    const user = record && record.expiresAt > this.now() ? await this.stores.directory.getUser(record.userId) : null;
    // One answer for unknown, expired, used, replaced, already-activated and disabled.
    if (!record || !user || user.activatedAt !== null || user.disabledAt) throw new ApiError('validation', { reason: 'activation_invalid' });
    return { key, record, user };
  }

  async activationStart(activationCode: string) {
    const { user } = await this.activation(activationCode);
    return { email: user.email, displayName: user.name, passwordPolicy: { minLength: PASSWORD_MIN_LENGTH } };
  }

  async activationPassword(activationCode: string, password: string) {
    const { key, user } = await this.activation(activationCode);
    if (passwordProblem(password) !== null) throw new ApiError('validation', { reason: 'weak_password', fields: ['password'] });
    const pendingPasswordHash = await hashPassword(password);
    const pendingTotpSecret = newTotpSecret();
    // Hashing takes a while. The invitation may have been replaced or withdrawn meanwhile: write only onto the SAME live record, never back into existence.
    const stored = await this.stores.auth.activations.mutate(key, (current) =>
      current && current.userId === user.id && current.expiresAt > this.now() ? { ...current, pendingPasswordHash, pendingTotpSecret } : undefined,
    );
    if (!stored || stored.pendingTotpSecret !== pendingTotpSecret) throw new ApiError('validation', { reason: 'activation_invalid' });
    return { secret: pendingTotpSecret, otpauthUri: otpauthUri(ISSUER, user.email, pendingTotpSecret) };
  }

  /** Completes activation: needs a correct code from the newly added authenticator entry. The invitation is then spent. */
  async activationConfirm(activationCode: string, code: string, source = '') {
    const { key, record, user } = await this.activation(activationCode);
    if (!record.pendingPasswordHash || !record.pendingTotpSecret) throw new ApiError('validation', { reason: 'activation_invalid' });
    const attempt = await this.begin('activation', `invite:${key}`, source);
    const check = checkTotp(record.pendingTotpSecret, code, this.now(), 0);
    if (!check.ok) {
      if (attempt.locked) await this.record('client.lockout', 'failure', partyOf(user), source, { guarded: 'activation' });
      await this.record('client.activation', 'failure', partyOf(user), source, { reason: 'invalid_code' });
      throw new ApiError('validation', { reason: 'invalid_code', fields: ['code'] });
    }
    // Only one request can take the invitation, and only if it is still the one that was checked.
    const taken = await this.stores.auth.activations.take(key);
    if (!taken || taken.pendingTotpSecret !== record.pendingTotpSecret || taken.pendingPasswordHash !== record.pendingPasswordHash) {
      throw new ApiError('validation', { reason: 'activation_invalid' });
    }
    const recoveryCodes = Array.from({ length: RECOVERY_CODE_COUNT }, () => randomCode(RECOVERY_CODE_GROUPS));
    const recoveryCodeHashes = await hashRecoveryCodes(recoveryCodes);
    const saved = await this.stores.directory.updateUser(user.id, (current) =>
      current.activatedAt !== null || current.disabledAt
        ? null
        : { ...current, passwordHash: taken.pendingPasswordHash, totpSecret: taken.pendingTotpSecret, lastTotpStep: check.step, recoveryCodeHashes, activatedAt: this.now() },
    );
    if (!saved) throw new ApiError('validation', { reason: 'activation_invalid' });
    await this.lockout.succeed(attempt);
    await this.record('client.activation', 'success', partyOf(user), source);
    return { recoveryCodes };
  }

  // --- Sign-in ----------------------------------------------------------------

  /**
   * Step 1. Unknown email, wrong password, not-yet-activated and disabled
   * account all give the same answer after the same work (one scrypt
   * verification).
   */
  async login(email: string, password: string, source = ''): Promise<{ challengeId: string }> {
    const address = email.trim().toLowerCase();
    // Nobody is identified at this stage, so these failures go to the anonymous audit stream.
    const who: AuditParty = { type: 'client', id: null, label: address };
    try {
      return await this.checkPassword(address, password, who, source);
    } catch (error) {
      await this.record('client.sign_in', 'failure', who, source, { stage: 'password', reason: reasonOf(error) });
      throw error;
    }
  }

  private async checkPassword(address: string, password: string, who: AuditParty, source: string): Promise<{ challengeId: string }> {
    // Counted before the password is looked at, so simultaneous guesses cannot outrun the lock.
    const user = await this.stores.directory.findUserByEmail(address);
    // From a network this account has fully signed in from before, strangers' guesses elsewhere do not count against it.
    const attempt = await this.begin('password', `email:${address}`, source, isKnownSource(user, source));
    const usable = user !== null && user.passwordHash !== null && user.activatedAt !== null && !user.disabledAt;
    // No usable account: the same answer after comparable work, from a budget that cannot starve real sign-ins.
    const matches = usable ? await verifyPassword(password, user.passwordHash as string) : await decoyVerify(password);
    if (!usable || !matches) {
      if (attempt.locked) {
        await this.record('client.lockout', 'failure', who, source, { guarded: 'password' });
        // The owner is told (at most once an hour, however long the guessing goes on).
        if (usable) await this.notice(user, 'account_locked');
      }
      throw new ApiError('validation', { reason: 'invalid_credentials' });
    }
    await this.lockout.succeed(attempt);
    if (passwordNeedsRehash(user.passwordHash as string)) {
      // The password is in hand and correct: replace an older, cheaper hash. Only if it is still the hash that was checked.
      const stronger = await hashPassword(password);
      await this.stores.directory.updateUser(user.id, (current) => (current.passwordHash === user.passwordHash ? { ...current, passwordHash: stronger } : null));
    }
    const challengeId = randomToken();
    await this.stores.auth.challenges.put(sha256(challengeId), {
      userId: user.id,
      expiresAt: this.now() + this.config.loginChallengeTtlMs,
      attempts: 0,
    });
    return { challengeId };
  }

  /**
   * Checks an authenticator code for this user and burns its time step.
   * `scope` keeps sign-in and step-up counters apart: wrong step-up codes in a
   * stolen session cannot lock the owner out of signing in.
   */
  private async verifyUserTotp(user: UserRecord, code: string, scope: 'code' | 'stepup', source: string): Promise<UserRecord> {
    const attempt = await this.begin(scope, `user:${user.id}`, source, isKnownSource(user, source));
    const check = user.totpSecret ? checkTotp(user.totpSecret, code, this.now(), user.lastTotpStep) : ({ ok: false, reason: 'invalid' } as const);
    const reused = async (): Promise<never> => {
      // A correct code that was already used is not a guess: it does not count toward a lock.
      await this.lockout.forgive(attempt);
      throw new ApiError('validation', { reason: 'code_reused', fields: ['code'], retryAfterSeconds: secondsToNextCode(this.now()) });
    };
    if (!check.ok) {
      if (check.reason === 'reused') return reused();
      if (attempt.locked) {
        await this.record('client.lockout', 'failure', partyOf(user), source, { guarded: scope });
        await this.notice(user, 'account_locked');
      }
      throw new ApiError('validation', { reason: 'invalid_code', fields: ['code'] });
    }
    // Atomic: of two requests carrying the same code, one burns the step and the other finds it burnt.
    const updated = await this.stores.directory.updateUser(user.id, (current) =>
      current.totpSecret === user.totpSecret && current.lastTotpStep < check.step ? { ...current, lastTotpStep: check.step } : null,
    );
    if (!updated) return reused();
    await this.lockout.succeed(attempt);
    return updated;
  }

  private async verifyRecoveryCode(user: UserRecord, code: string, source: string): Promise<UserRecord> {
    const attempt = await this.begin('code', `user:${user.id}`, source, isKnownSource(user, source));
    const match = await matchRecoveryCode(code, user.recoveryCodeHashes);
    // Atomic: a recovery code is removed by exactly one request.
    const updated = match
      ? await this.stores.directory.updateUser(user.id, (current) =>
          current.recoveryCodeHashes.includes(match) ? { ...current, recoveryCodeHashes: current.recoveryCodeHashes.filter((item) => item !== match) } : null,
        )
      : null;
    if (!updated) {
      if (attempt.locked) {
        await this.record('client.lockout', 'failure', partyOf(user), source, { guarded: 'code' });
        await this.notice(user, 'account_locked');
      }
      throw new ApiError('validation', { reason: 'invalid_code', fields: ['code'] });
    }
    await this.lockout.succeed(attempt);
    return updated;
  }

  /** Step 2. An authenticator code, or a recovery code that is then spent. */
  async verifyLogin(challengeId: string, code: string, method: CodeMethod, source = '', agent = ''): Promise<SignedIn> {
    const challengeKey = sha256(challengeId);
    const challenge = await this.stores.auth.challenges.get(challengeKey);
    const found = challenge && challenge.expiresAt > this.now() ? await this.stores.directory.getUser(challenge.userId) : null;
    let user = found && !found.disabledAt && found.activatedAt !== null ? found : null;
    if (!challenge || !user) {
      await this.stores.auth.challenges.delete(challengeKey);
      throw new ApiError('validation', { reason: 'challenge_expired' });
    }
    try {
      user = method === 'totp' ? await this.verifyUserTotp(user, code, 'code', source) : await this.verifyRecoveryCode(user, code, source);
    } catch (error) {
      if (reasonOf(error) !== 'code_reused') {
        await this.stores.auth.challenges.mutate(challengeKey, (current) =>
          current === null ? undefined : current.attempts + 1 >= MAX_CHALLENGE_ATTEMPTS ? null : { ...current, attempts: current.attempts + 1 },
        );
      }
      await this.record('client.sign_in', 'failure', partyOf(user), source, { stage: 'code', method, reason: reasonOf(error) });
      throw error;
    }
    // One challenge makes one session.
    if (!(await this.stores.auth.challenges.take(challengeKey))) throw new ApiError('validation', { reason: 'challenge_expired' });
    // A full sign-in (password and code) from here: remember the network. If the account has been used before and
    // never from this network, its owner is told.
    const newNetwork = (user.knownSources ?? []).length > 0 && !isKnownSource(user, source);
    user = (await this.stores.directory.updateUser(user.id, (current) => ({ ...current, lastSignInAt: this.now(), knownSources: withKnownSource(current.knownSources, source) }))) ?? user;
    await this.record('client.sign_in', 'success', partyOf(user), source, { method, ...(newNetwork ? { network: 'new' } : {}) });
    if (newNetwork) await this.notice(user, 'new_network_sign_in');
    // The real owner is here, with the credentials a pending authenticator reset would have thrown away: it is cancelled.
    await this.cancelAuthenticatorResets(user, 'signed in', source);

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
      agent: agentFamily(agent),
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
    const found = await this.stores.auth.sessions.get(tokenHash);
    const now = this.now();
    if (!found || now - found.lastSeenAt > this.config.sessionIdleMs || now - found.createdAt > this.config.sessionAbsoluteMs) {
      if (found) await this.revoke(tokenHash, found.id);
      throw new ApiError('unauthorized');
    }
    const user = await this.stores.directory.getUser(found.userId);
    if (!user || user.activatedAt === null || user.disabledAt) {
      await this.revoke(tokenHash, found.id);
      throw new ApiError('unauthorized');
    }
    // "Last seen" is written at most once a minute per session, not on every request: each write is flushed to disk.
    // (So a session can end up to a minute EARLY after its last request, never late.)
    if (now - found.lastSeenAt < SEEN_WRITE_MS) return this.contextFor(tokenHash, found, user);
    // Only an existing session is touched: one revoked a moment ago is not written back.
    const session = await this.stores.auth.sessions.mutate(tokenHash, (current) => (current ? { ...current, lastSeenAt: now } : undefined));
    if (!session) throw new ApiError('unauthorized');
    return this.contextFor(tokenHash, session, user);
  }

  /** Only a company the person belongs to can be selected. Anything else looks like "no such company". */
  async selectCompany(context: SessionContext, companyId: string, source = ''): Promise<SessionContext> {
    const membership = (await this.companiesOf(context.user.id)).find((item) => item.company.id === companyId);
    if (!membership) {
      await this.record('client.company_select', 'failure', partyOf(context.user), source, { reason: 'not_found' });
      throw new ApiError('not_found');
    }
    // Choosing the company that is already chosen changes nothing, so it is neither written nor audited.
    if (context.session.companyId === companyId) return { ...context, company: membership.company, role: membership.role };
    const session = await this.stores.auth.sessions.mutate(context.tokenHash, (current) => (current ? { ...current, companyId } : undefined));
    if (!session) throw new ApiError('unauthorized');
    // A permission granted for one company must not carry over to another.
    await this.stores.auth.stepUps.deleteWhere({ sessionId: session.id });
    await this.record('client.company_select', 'success', partyOf(context.user), source, {}, { type: 'company', id: membership.company.id, label: membership.company.name });
    return { ...context, session, company: membership.company, role: membership.role };
  }

  private async revoke(tokenHash: string, sessionId: string): Promise<void> {
    await this.stores.auth.sessions.delete(tokenHash);
    await this.stores.auth.stepUps.deleteWhere({ sessionId });
  }

  async logout(token: string | undefined, source = ''): Promise<void> {
    if (!token) return;
    const tokenHash = sha256(token);
    const session = await this.stores.auth.sessions.take(tokenHash);
    if (!session) return;
    await this.stores.auth.stepUps.deleteWhere({ sessionId: session.id });
    const user = await this.stores.directory.getUser(session.userId);
    if (user) await this.record('client.sign_out', 'success', partyOf(user), source);
  }

  // --- For operations (the ops console). None of these reads or returns a credential. ---

  activeSessionCount(userId: string): Promise<number> {
    const now = this.now();
    return this.stores.auth.sessions.count({ userId }, (session) => now - session.lastSeenAt <= this.config.sessionIdleMs && now - session.createdAt <= this.config.sessionAbsoluteMs);
  }

  /** Ends every session of this person. Returns how many there were. */
  async revokeAllSessions(userId: string): Promise<number> {
    const total = await this.stores.auth.sessions.count({ userId });
    await this.stores.auth.sessions.deleteWhere({ userId });
    await this.stores.auth.stepUps.deleteWhere({ userId });
    await this.stores.auth.challenges.deleteWhere({ userId });
    return total;
  }

  private subjectsOf(user: UserRecord): string[] {
    return [`email:${user.email}`, `user:${user.id}`];
  }

  isLocked(user: UserRecord): Promise<boolean> {
    return this.lockout.isLocked(this.subjectsOf(user));
  }

  unlock(user: UserRecord): Promise<void> {
    return this.lockout.unlock(this.subjectsOf(user));
  }

  /**
   * Removes the password, the authenticator key and the recovery codes, ends
   * every session and withdraws any invitation. The person is back to "not
   * activated" and needs a new activation link.
   */
  async clearCredentials(userId: string): Promise<number> {
    const user = await this.stores.directory.updateUser(userId, (current) => ({ ...current, passwordHash: null, totpSecret: null, recoveryCodeHashes: [], activatedAt: null }));
    if (!user) throw new ApiError('not_found');
    await this.stores.auth.activations.deleteWhere({ userId });
    await this.unlock(user);
    return this.revokeAllSessions(userId);
  }

  // --- Forgotten password ---------------------------------------------------------
  //
  // EMAIL ALONE IS NEVER ENOUGH. The emailed link proves control of the mailbox; choosing a new password also needs
  // a current code from the authenticator app, or an unused recovery code. A reset never touches the authenticator.
  // Someone who has lost the authenticator AND the recovery codes has no self-service way back: staff reset it, with
  // two people and a delay (see the ops console).

  /**
   * Always the same answer, after the same work as a sign-in attempt, whether
   * or not the address belongs to an account: what follows happens after the
   * answer has gone. If the account exists, is activated and is enabled, a
   * single-use link is emailed to it; an earlier link stops working. At most
   * RESET_REQUESTS_PER_HOUR links an hour for one account.
   */
  async requestPasswordReset(email: string, source = ''): Promise<void> {
    const address = email.trim().toLowerCase();
    this.later(this.issuePasswordReset(address, source));
    await decoyVerify(address);
  }
  private async issuePasswordReset(address: string, source: string): Promise<void> {
    const user = await this.stores.directory.findUserByEmail(address);
    if (!user || user.activatedAt === null || user.disabledAt || user.passwordHash === null) {
      await this.record('client.password_reset.request', 'failure', { type: 'client', id: null, label: address }, source, { reason: 'no_usable_account' });
      return;
    }
    const since = this.now() - 60 * 60_000;
    const recent = await this.stores.mail.count({}, (row) => row.to === user.email && row.template === 'reset.client' && row.createdAt > since);
    if (recent >= RESET_REQUESTS_PER_HOUR) {
      await this.record('client.password_reset.request', 'failure', partyOf(user), source, { reason: 'rate_limited' });
      return;
    }
    // A new link kills the old one.
    await this.stores.auth.passwordResets.deleteWhere({ userId: user.id });
    const resetCode = randomCode(4);
    const expiresAt = this.now() + PASSWORD_RESET_TTL_MS;
    await this.stores.auth.passwordResets.put(sha256(normaliseCode(resetCode)), { userId: user.id, expiresAt, attempts: 0 });
    // The code is in the link's fragment, which browsers do not send to servers: it is in no request log.
    await this.mail?.enqueue(mailOf({ to: user.email, template: 'reset.client', data: { name: user.name, link: `${this.config.appUrl}/reset#code=${resetCode}`, expiresAt }, key: `reset:${sha256(resetCode)}`, category: 'security' }));
    await this.record('client.password_reset.request', 'success', partyOf(user), source, { expires: new Date(expiresAt).toISOString() });
  }

  private async passwordReset(resetCode: string) {
    const key = sha256(normaliseCode(resetCode));
    const record = await this.stores.auth.passwordResets.get(key);
    const user = record && record.expiresAt > this.now() ? await this.stores.directory.getUser(record.userId) : null;
    // One answer for unknown, expired, used, replaced, and an account that has since been disabled or reset.
    if (!record || !user || user.activatedAt === null || user.disabledAt) throw new ApiError('validation', { reason: 'reset_invalid' });
    return { key, record, user };
  }

  /** Whether the link is (still) good, and the password rules. Nothing about whose account it is. */
  async passwordResetStart(resetCode: string) {
    await this.passwordReset(resetCode);
    return { passwordPolicy: { minLength: PASSWORD_MIN_LENGTH } };
  }

  /**
   * The link AND a second factor, then the new password. Wrong codes count
   * toward the same lock as wrong sign-in codes, and five of them withdraw
   * the link. On success every session is ended and the owner is told.
   */
  async passwordResetComplete(resetCode: string, code: string, method: CodeMethod, password: string, source = ''): Promise<void> {
    const { key, user } = await this.passwordReset(resetCode);
    if (passwordProblem(password) !== null) throw new ApiError('validation', { reason: 'weak_password', fields: ['password'] });
    let verified: UserRecord;
    try {
      verified = method === 'totp' ? await this.verifyUserTotp(user, code, 'code', source) : await this.verifyRecoveryCode(user, code, source);
    } catch (error) {
      if (reasonOf(error) !== 'code_reused') {
        await this.stores.auth.passwordResets.mutate(key, (current) => (current === null ? undefined : current.attempts + 1 >= MAX_CHALLENGE_ATTEMPTS ? null : { ...current, attempts: current.attempts + 1 }));
      }
      await this.record('client.password_reset', 'failure', partyOf(user), source, { stage: 'code', method, reason: reasonOf(error) });
      throw error;
    }
    const passwordHash = await hashPassword(password);
    // One request takes the link, and only while it is still the one that was checked.
    const taken = await this.stores.auth.passwordResets.take(key);
    if (!taken || taken.userId !== user.id || taken.expiresAt <= this.now()) throw new ApiError('validation', { reason: 'reset_invalid' });
    // ONLY the password. The authenticator key and the recovery codes are not this function's to change.
    const saved = await this.stores.directory.updateUser(user.id, (current) => (current.activatedAt === null || current.disabledAt || current.totpSecret !== verified.totpSecret ? null : { ...current, passwordHash }));
    if (!saved) throw new ApiError('validation', { reason: 'reset_invalid' });
    const sessions = await this.revokeAllSessions(user.id);
    await this.lockout.unlock([`email:${user.email}`]);
    await this.record('client.password_reset', 'success', partyOf(user), source, { method, sessionsEnded: String(sessions) });
    await this.notice(saved, 'password_reset');
  }

  // --- Signed in: your own security settings -----------------------------------------

  /** The current password AND an authenticator code. Every OTHER session is ended. */
  async changePassword(context: SessionContext, currentPassword: string, code: string, newPassword: string, source = ''): Promise<void> {
    const { user } = context;
    const who = partyOf(user);
    const fail = async (reason: string, error: ApiError): Promise<never> => {
      await this.record('client.password_change', 'failure', who, source, { reason });
      throw error;
    };
    if (passwordProblem(newPassword) !== null) await fail('weak_password', new ApiError('validation', { reason: 'weak_password', fields: ['newPassword'] }));
    const attempt = await this.begin('password', `email:${user.email}`, source, isKnownSource(user, source));
    if (user.passwordHash === null || !(await verifyPassword(currentPassword, user.passwordHash))) {
      if (attempt.locked) {
        await this.record('client.lockout', 'failure', who, source, { guarded: 'password' });
        await this.notice(user, 'account_locked');
      }
      await fail('invalid_credentials', new ApiError('validation', { reason: 'invalid_credentials', fields: ['currentPassword'] }));
    }
    await this.lockout.succeed(attempt);
    let verified: UserRecord;
    try {
      verified = await this.verifyUserTotp(user, code, 'stepup', source);
    } catch (error) {
      return fail(reasonOf(error), error as ApiError);
    }
    const passwordHash = await hashPassword(newPassword);
    const saved = await this.stores.directory.updateUser(user.id, (current) => (current.passwordHash === verified.passwordHash && !current.disabledAt ? { ...current, passwordHash } : null));
    if (!saved) await fail('changed_meanwhile', new ApiError('validation', { reason: 'invalid_credentials' }));
    const others = await this.revokeSessionsExcept(user.id, context.session.id);
    await this.stores.auth.passwordResets.deleteWhere({ userId: user.id });
    await this.record('client.password_change', 'success', who, source, { otherSessionsEnded: String(others) });
    await this.notice(user, 'password_changed');
  }

  /** An authenticator code buys a fresh set of recovery codes, shown once. The old ones stop working. */
  async regenerateRecoveryCodes(context: SessionContext, code: string, source = ''): Promise<{ recoveryCodes: string[] }> {
    const { user } = context;
    let verified: UserRecord;
    try {
      verified = await this.verifyUserTotp(user, code, 'stepup', source);
    } catch (error) {
      await this.record('client.recovery_codes.regenerate', 'failure', partyOf(user), source, { reason: reasonOf(error) });
      throw error;
    }
    const recoveryCodes = Array.from({ length: RECOVERY_CODE_COUNT }, () => randomCode(RECOVERY_CODE_GROUPS));
    const recoveryCodeHashes = await hashRecoveryCodes(recoveryCodes);
    const saved = await this.stores.directory.updateUser(user.id, (current) => (current.totpSecret === verified.totpSecret && !current.disabledAt ? { ...current, recoveryCodeHashes } : null));
    if (!saved) throw new ApiError('validation', { reason: 'invalid_code' });
    await this.record('client.recovery_codes.regenerate', 'success', partyOf(user), source, { count: String(recoveryCodes.length) });
    await this.notice(user, 'recovery_codes_regenerated');
    return { recoveryCodes };
  }

  /** Your own live sessions: what kind of device, and roughly when. Never an address, never a token. */
  async listSessions(context: SessionContext): Promise<{ id: string; current: boolean; device: string; signedInAt: string; lastActiveAt: string }[]> {
    const now = this.now();
    const live = await this.stores.auth.sessions.list({ userId: context.user.id }, (session) => now - session.lastSeenAt <= this.config.sessionIdleMs && now - session.createdAt <= this.config.sessionAbsoluteMs);
    // Times to the quarter hour: enough to recognise a session, not a log of anyone's movements.
    const rough = (at: number) => new Date(Math.floor(at / ROUGH_MS) * ROUGH_MS).toISOString();
    return live
      .sort((a, b) => b.lastSeenAt - a.lastSeenAt)
      .map((session) => ({ id: sha256(`session-ref:${session.id}`).slice(0, 24), current: session.id === context.session.id, device: session.agent ?? 'Unknown device', signedInAt: rough(session.createdAt), lastActiveAt: rough(session.lastSeenAt) }));
  }

  /** Ends one of your own sessions, by the reference `listSessions` gave. Someone else's reference is simply not found. */
  async revokeOwnSession(context: SessionContext, reference: string, source = ''): Promise<void> {
    const mine = await this.stores.auth.sessions.list({ userId: context.user.id });
    const target = mine.find((session) => sha256(`session-ref:${session.id}`).slice(0, 24) === reference);
    if (!target) throw new ApiError('not_found');
    await this.stores.auth.sessions.deleteWhere({ userId: context.user.id }, (session) => session.id === target.id);
    await this.stores.auth.stepUps.deleteWhere({ userId: context.user.id }, (grant) => grant.sessionId === target.id);
    await this.record('client.session.revoke', 'success', partyOf(context.user), source, { which: target.id === context.session.id ? 'this one' : 'another', device: target.agent ?? 'Unknown device' });
    if (target.id !== context.session.id) await this.notice(context.user, 'session_revoked');
  }

  private async revokeSessionsExcept(userId: string, keepSessionId: string): Promise<number> {
    const others = await this.stores.auth.sessions.count({ userId }, (session) => session.id !== keepSessionId);
    await this.stores.auth.sessions.deleteWhere({ userId }, (session) => session.id !== keepSessionId);
    await this.stores.auth.stepUps.deleteWhere({ userId }, (grant) => grant.sessionId !== keepSessionId);
    await this.stores.auth.challenges.deleteWhere({ userId });
    return others;
  }

  // --- Authenticator resets waiting out their delay (started by staff; see the ops console) ---------------

  /** Cancels every authenticator reset that is waiting for this person. Returns how many there were. */
  async cancelAuthenticatorResets(user: UserRecord, by: string, source = ''): Promise<number> {
    const waiting = await this.stores.auth.authenticatorResets.list({ userId: user.id, status: 'waiting' });
    let cancelled = 0;
    for (const item of waiting) {
      const at = this.now();
      const stored = await this.stores.auth.authenticatorResets.mutate(
        item.id,
        (current) => (current && current.status === 'waiting' ? { ...current, status: 'cancelled', closedAt: at, closedBy: by } : undefined),
        (saved) => (saved && saved.status === 'cancelled' && saved.closedAt === at ? { at, actor: { type: 'system', id: null, label: 'authenticator reset' }, target: partyOf(user), action: 'system.client.reset_authenticator.cancelled', outcome: 'success', source, detail: { reset: item.id, request: item.requestId, by } } : null),
      );
      if (stored?.status === 'cancelled' && stored.closedAt === at) cancelled += 1;
    }
    if (cancelled > 0) await this.notice(user, 'authenticator_reset_cancelled');
    return cancelled;
  }

  // --- Step-up ----------------------------------------------------------------

  /**
   * A fresh authenticator code buys ONE permission, for this person, in this
   * session, to do this action with exactly this payload, for a short time.
   */
  async grantStepUp(context: SessionContext, action: StepUpAction, payload: unknown, code: string, source = ''): Promise<{ token: string; expiresInSeconds: number }> {
    try {
      await this.verifyUserTotp(context.user, code, 'stepup', source);
    } catch (error) {
      await this.record('client.step_up', 'failure', partyOf(context.user), source, { for: action, reason: reasonOf(error) });
      throw error;
    }
    await this.record('client.step_up', 'success', partyOf(context.user), source, { for: action });
    const token = randomToken();
    await this.stores.auth.stepUps.put(sha256(token), {
      userId: context.user.id,
      sessionId: context.session.id,
      // Bound to the company it was asked for: it is worth nothing in another, whatever happens to the session meanwhile.
      companyId: context.company?.id ?? null,
      action,
      payloadHash: sha256(canonicalJson(payload)),
      expiresAt: this.now() + this.config.stepUpTtlMs,
    });
    return { token, expiresInSeconds: Math.floor(this.config.stepUpTtlMs / 1000) };
  }

  /** Spends the permission. A token is destroyed the first time it is presented, whether or not it fits. */
  async consumeStepUp(context: SessionContext, token: string | undefined, action: StepUpAction, payload: unknown): Promise<void> {
    if (!token) throw new ApiError('forbidden', { reason: 'step_up_required' });
    // Atomic read-and-delete: two requests carrying the same token cannot both get it.
    const record = await this.stores.auth.stepUps.take(sha256(token));
    const valid =
      record !== null &&
      record.expiresAt > this.now() &&
      record.userId === context.user.id &&
      record.sessionId === context.session.id &&
      record.companyId === (context.company?.id ?? null) &&
      record.action === action &&
      record.payloadHash === sha256(canonicalJson(payload));
    if (!valid) throw new ApiError('forbidden', { reason: 'step_up_invalid' });
  }
}
