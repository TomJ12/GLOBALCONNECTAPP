/**
 * AUTHENTICATOR RESETS WAIT. A reset removes a client's password,
 * authenticator and recovery codes and emails a new activation link: whoever
 * reads that mailbox then owns the account. It is the classic way to take an
 * account over, by talking staff into it. So, after two members of staff have
 * approved one:
 *
 *  1. the client is WARNED, by email and in the app, that it will happen;
 *  2. NOTHING changes for a delay (AUTHENTICATOR_RESET_DELAY_HOURS, default
 *     24): the client's current credentials go on working. THE DELAY RUNS
 *     FROM THE MOMENT THE MAIL SERVER ACCEPTED THE WARNING, not from the
 *     approval: while the warning is still queued or deferred nothing is due,
 *     and if the mail server refuses it for good it is queued again and the
 *     reset goes on waiting (the ops console shows that);
 *  3. if the client signs in successfully during the delay (password and
 *     code), the reset is cancelled, automatically, and that is audited: the
 *     person who really has the credentials evidently did not lose them;
 *  4. any ops admin can cancel it during the delay;
 *  5. only when the delay has passed are the credentials cleared and the new
 *     activation link emailed. The reset is first CLAIMED (waiting ->
 *     running) in one transaction; a sign-in can cancel it up to that
 *     moment and not after, so "cancelled, nothing changed" is never said
 *     about credentials that were then cleared.
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

  /** One reset per approval request, however often the approval is carried out. The warning is queued at once; the delay starts when it has been sent. */
  async schedule(user: UserRecord, request: { id: string; requestedBy: string; approvedBy: string }, source: string): Promise<AuthenticatorResetRecord> {
    const id = `ar_${sha256(`authenticator-reset:${request.id}`).slice(0, 16)}`;
    const at = this.now();
    let created = false;
    const stored = await this.stores.auth.authenticatorResets.mutate(
      id,
      (current) => {
        if (current) return undefined;
        created = true;
        return { id, userId: user.id, requestId: request.id, requestedBy: request.requestedBy, approvedBy: request.approvedBy, approvedAt: at, dueAt: at + this.delayMs, status: 'waiting', warnedAt: null, warningTries: 0, closedAt: null, closedBy: null };
      },
      (saved) => (created && saved ? { at, actor: SYSTEM, target: clientParty(user), action: 'system.client.reset_authenticator.scheduled', outcome: 'success', source, detail: { reset: id, request: request.id, due: new Date(saved.dueAt).toISOString() } } : null),
    );
    const record = stored as AuthenticatorResetRecord;
    if (created) {
      // Any earlier one still waiting for the same person is superseded: one reset at a time.
      for (const other of await this.stores.auth.authenticatorResets.list({ userId: user.id, status: 'waiting' })) {
        if (other.id !== id) await this.close(other, 'cancelled', 'superseded by a later reset', source, user);
      }
    }
    await this.runDue();
    return (await this.stores.auth.authenticatorResets.get(id)) ?? record;
  }

  private warningKey(item: Pick<AuthenticatorResetRecord, 'id' | 'warningTries'>): string {
    return `authenticator-reset:${item.id}:warning:${item.warningTries ?? 0}`;
  }

  /**
   * THE WARNING. Queues it if it is not queued, and looks at what became of it. Only when the mail server has
   * ACCEPTED it does the delay start (from that moment). Refused for good: it is queued afresh. Returns the record
   * as it now stands.
   */
  private async warn(item: AuthenticatorResetRecord, user: UserRecord): Promise<AuthenticatorResetRecord> {
    if (item.warnedAt !== null && item.warnedAt !== undefined) return item;
    const at = this.now();
    const table = this.stores.auth.authenticatorResets;
    if (this.delayMs === 0) {
      // Development only (the configuration refuses 0 elsewhere): no delay, so no warning to wait for.
      return (await table.mutate(item.id, (current) => (current && current.status === 'waiting' && (current.warnedAt ?? null) === null ? { ...current, warnedAt: at } : undefined))) ?? item;
    }
    const delivery = (await this.mail.delivery(this.warningKey(item))) ?? (await this.notices.send({ id: user.id, email: user.email, name: user.name }, 'client', 'authenticator_reset_requested', { until: at + this.delayMs }, { key: this.warningKey(item) }));
    if (delivery?.state === 'sent' && delivery.sentAt !== null) {
      const sentAt = delivery.sentAt;
      return (
        (await table.mutate(
          item.id,
          (current) => (current && current.status === 'waiting' && (current.warnedAt ?? null) === null ? { ...current, warnedAt: sentAt, dueAt: Math.max(current.dueAt, sentAt + this.delayMs) } : undefined),
          (saved) => (saved && saved.warnedAt === sentAt ? { at, actor: SYSTEM, target: clientParty(user), action: 'system.client.reset_authenticator.warned', outcome: 'success', source: '', detail: { reset: item.id, due: new Date(saved.dueAt).toISOString() } } : null),
        )) ?? item
      );
    }
    if (delivery === null || delivery.state === 'failed') {
      // Not delivered and it will not be retried under this key: on record, and a fresh warning is queued next time.
      return (
        (await table.mutate(
          item.id,
          (current) => (current && current.status === 'waiting' && (current.warnedAt ?? null) === null && (current.warningTries ?? 0) === (item.warningTries ?? 0) ? { ...current, warningTries: (current.warningTries ?? 0) + 1 } : undefined),
          (saved) => (saved ? { at, actor: SYSTEM, target: clientParty(user), action: 'system.client.reset_authenticator.warning_failed', outcome: 'failure', source: '', detail: { reset: item.id, tries: String(saved.warningTries ?? 0) } } : null),
        )) ?? item
      );
    }
    return item;
  }

  private async close(item: AuthenticatorResetRecord, status: 'done' | 'cancelled', by: string, source: string, user: UserRecord | null): Promise<boolean> {
    const at = this.now();
    // Cancelled: only while it is still waiting. Done: only from `running`, which the pass below claimed.
    const from = status === 'done' ? 'running' : 'waiting';
    const stored = await this.stores.auth.authenticatorResets.mutate(
      item.id,
      (current) => (current && current.status === from ? { ...current, status, closedAt: at, closedBy: by } : undefined),
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
    const table = this.stores.auth.authenticatorResets;
    // What a crash left half done (already claimed) is finished first; then what is waiting is looked at.
    for (const listed of [...(await table.list({ status: 'running' })), ...(await table.list({ status: 'waiting' }))]) {
      const user = await this.stores.directory.getUser(listed.userId);
      let item = listed;
      if (item.status === 'waiting') {
        if (!user || user.disabledAt) {
          await this.close(item, 'cancelled', user ? 'account disabled' : 'account removed', '', user);
          continue;
        }
        // Nothing is due until the warning has been accepted by the mail server, and for the whole delay after that.
        item = await this.warn(item, user);
        if ((item.warnedAt ?? null) === null || item.dueAt > this.now()) continue;
        // CLAIMED, in one transaction: from here a sign-in or a member of staff can no longer cancel it, and until
        // here nothing has been touched. (A cancellation that landed first leaves it cancelled, and this stops.)
        const claimed = await table.mutate(item.id, (current) => (current && current.status === 'waiting' && (current.warnedAt ?? null) !== null && current.dueAt <= this.now() ? { ...current, status: 'running' } : undefined));
        if (claimed?.status !== 'running') continue;
        item = claimed;
      }
      if (!user) {
        await table.mutate(item.id, (current) => (current && current.status === 'running' ? { ...current, status: 'cancelled', closedAt: this.now(), closedBy: 'account removed' } : undefined));
        continue;
      }
      if (user.activatedAt !== null) {
        const sessions = await this.auth.clearCredentials(user.id);
        await this.auth.record('client.session_revoked', 'success', SYSTEM, '', { sessions: String(sessions), why: 'authenticator reset' }, clientParty(user));
      }
      const fresh = (await this.stores.directory.getUser(user.id)) ?? user;
      const invite = await this.auth.createInvite(fresh.email);
      const delivery = await this.mail.enqueue(activationMail(invite, fresh.email, fresh.name, 'client'));
      await this.auth.record('system.client.reset_authenticator.link', delivery.state === 'failed' ? 'failure' : 'success', SYSTEM, '', { reset: item.id, email: delivery.state }, clientParty(fresh));
      if (await this.close(item, 'done', 'delay passed', '', fresh)) {
        done += 1;
        await this.notices.send({ id: fresh.id, email: fresh.email, name: fresh.name }, 'client', 'authenticator_reset_completed');
      }
    }
    return done;
  }

  /** For the console: the resets not yet carried out, and for each whether its warning has reached the mail server. */
  async waitingWithWarning(): Promise<(AuthenticatorResetRecord & { warning: string })[]> {
    const items = await this.waiting();
    return Promise.all(items.map(async (item) => ({ ...item, warning: (item.warnedAt ?? null) !== null ? 'sent' : ((await this.mail.delivery(this.warningKey(item)))?.state ?? 'queued') })));
  }

  async waiting(): Promise<AuthenticatorResetRecord[]> {
    return [...(await this.stores.auth.authenticatorResets.list({ status: 'waiting' })), ...(await this.stores.auth.authenticatorResets.list({ status: 'running' }))];
  }
}
