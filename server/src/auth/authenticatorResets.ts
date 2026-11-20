/**
 * AUTHENTICATOR RESETS WAIT. A reset removes a client's password,
 * authenticator and recovery codes and emails a new activation link: whoever
 * reads that mailbox then owns the account. It is the classic way to take an
 * account over, by talking staff into it. So, after two members of staff have
 * approved one:
 *
 *  1. the client is told at once, by email, that it will happen and when;
 *  2. NOTHING changes for a delay (AUTHENTICATOR_RESET_DELAY_HOURS, default
 *     24): the client's current credentials go on working;
 *  3. if the client signs in successfully during the delay (password and
 *     code), the reset is cancelled, automatically, and that is audited: the
 *     person who really has the credentials evidently did not lose them;
 *  4. any ops admin can cancel it during the delay;
 *  5. only when the delay has passed are the credentials cleared and the new
 *     activation link emailed.
 */
import { sha256 } from '../crypto';
import type { MailQueue } from '../mail/queue';
import { activationMail } from '../mail/templates';
import type { SecurityNotices } from '../notify/security';
import type { AuditParty, AuthenticatorResetRecord, Stores, UserRecord } from '../store/types';
import type { AuthService } from './service';

const SYSTEM: AuditParty = { type: 'system', id: null, label: 'authenticator reset' };
const clientParty = (user: UserRecord): AuditParty => ({ type: 'client', id: user.id, label: user.email });

export class AuthenticatorResets {
  private running: Promise<number> | null = null;
  constructor(
    private readonly stores: Stores,
    private readonly auth: AuthService,
    private readonly mail: MailQueue,
    private readonly notices: SecurityNotices,
    private readonly delayMs: number,
    private readonly now: () => number,
  ) {}

  /** One reset per approval request, however often the approval is carried out. The client is told at once. */
  async schedule(user: UserRecord, request: { id: string; requestedBy: string; approvedBy: string }, source: string): Promise<AuthenticatorResetRecord> {
    const id = `ar_${sha256(`authenticator-reset:${request.id}`).slice(0, 16)}`;
    const at = this.now();
    let created = false;
    const stored = await this.stores.auth.authenticatorResets.mutate(
      id,
      (current) => {
        if (current) return undefined;
        created = true;
        return { id, userId: user.id, requestId: request.id, requestedBy: request.requestedBy, approvedBy: request.approvedBy, approvedAt: at, dueAt: at + this.delayMs, status: 'waiting', closedAt: null, closedBy: null };
      },
      (saved) => (created && saved ? { at, actor: SYSTEM, target: clientParty(user), action: 'system.client.reset_authenticator.scheduled', outcome: 'success', source, detail: { reset: id, request: request.id, due: new Date(saved.dueAt).toISOString() } } : null),
    );
    const record = stored as AuthenticatorResetRecord;
    if (created) {
      // Any earlier one still waiting for the same person is superseded: one reset at a time.
      for (const other of await this.stores.auth.authenticatorResets.list({ userId: user.id, status: 'waiting' })) {
        if (other.id !== id) await this.close(other, 'cancelled', 'superseded by a later reset', source, user);
      }
      if (this.delayMs > 0) await this.notices.send({ id: user.id, email: user.email, name: user.name }, 'client', 'authenticator_reset_requested', { until: record.dueAt });
    }
    if (record.status === 'waiting' && record.dueAt <= this.now()) await this.runDue();
    return (await this.stores.auth.authenticatorResets.get(id)) ?? record;
  }

  private async close(item: AuthenticatorResetRecord, status: 'done' | 'cancelled', by: string, source: string, user: UserRecord | null): Promise<boolean> {
    const at = this.now();
    const stored = await this.stores.auth.authenticatorResets.mutate(
      item.id,
      (current) => (current && current.status === 'waiting' ? { ...current, status, closedAt: at, closedBy: by } : undefined),
      (saved) =>
        saved && saved.status === status && saved.closedAt === at
          ? { at, actor: SYSTEM, target: user ? clientParty(user) : null, action: status === 'done' ? 'system.client.reset_authenticator.completed' : 'system.client.reset_authenticator.cancelled', outcome: 'success', source, detail: { reset: item.id, request: item.requestId, by } }
          : null,
    );
    return stored?.status === status && stored.closedAt === at;
  }

  /** Cancelled by a member of staff (the console checks who may). */
  async cancel(id: string, by: string, source: string): Promise<boolean> {
    const item = await this.stores.auth.authenticatorResets.get(id);
    if (!item || item.status !== 'waiting') return false;
    const user = await this.stores.directory.getUser(item.userId);
    const cancelled = await this.close(item, 'cancelled', by, source, user);
    if (cancelled && user) await this.notices.send({ id: user.id, email: user.email, name: user.name }, 'client', 'authenticator_reset_cancelled');
    return cancelled;
  }

  /**
   * Carries out every reset whose delay has passed. Run at start-up and every
   * minute. Each step can be repeated without harm (clearing cleared
   * credentials, replacing an unused link), and the reset is marked done only
   * after them: a crash in the middle is finished at the next run, never lost.
   */
  runDue(): Promise<number> {
    this.running ??= this.pass().finally(() => (this.running = null));
    return this.running;
  }
  private async pass(): Promise<number> {
    let done = 0;
    for (const item of await this.stores.auth.authenticatorResets.list({ status: 'waiting' })) {
      if (item.dueAt > this.now()) continue;
      const user = await this.stores.directory.getUser(item.userId);
      if (!user || user.disabledAt) {
        await this.close(item, 'cancelled', user ? 'account disabled' : 'account removed', '', user);
        continue;
      }
      // Still waiting? (A sign-in or a cancellation may have landed since the list was read.)
      if ((await this.stores.auth.authenticatorResets.get(item.id))?.status !== 'waiting') continue;
      if (user.activatedAt !== null) {
        const sessions = await this.auth.clearCredentials(user.id);
        await this.auth.record('client.session_revoked', 'success', SYSTEM, '', { sessions: String(sessions), why: 'authenticator reset' }, clientParty(user));
      }
      const fresh = (await this.stores.directory.getUser(user.id)) ?? user;
      const invite = await this.auth.createInvite(fresh.email);
      await this.mail.enqueue(activationMail(invite, fresh.email, fresh.name, 'client'));
      if (await this.close(item, 'done', 'delay passed', '', fresh)) {
        done += 1;
        await this.notices.send({ id: fresh.id, email: fresh.email, name: fresh.name }, 'client', 'authenticator_reset_completed');
      }
    }
    return done;
  }

  waiting(): Promise<AuthenticatorResetRecord[]> {
    return this.stores.auth.authenticatorResets.list({ status: 'waiting' });
  }
}
