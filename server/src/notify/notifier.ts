/**
 * NOTIFICATIONS a person can turn off: a rate alert, a payment waiting for
 * their approval, what became of a payment they created. (Security notices
 * are separate, notify/security.ts, and cannot be turned off.)
 *
 * TWO CHANNELS:
 *   in-app   a list kept on the server (table `notifications`), with an unread count. Always on.
 *   email    through the mail queue (mail/queue.ts), unless the person turned that category off.
 * PUSH IS NOT BUILT. `PushChannel` below is the interface a push sender would implement and `Notifier` would
 * call; nothing implements it, no device token is stored, and the app does not ask for notification permission.
 *
 * ONE EVENT, ONE NOTIFICATION, however often it is reported: each has a key (what happened, to what, for whom)
 * and the notification's row is created under a hash of that key, in one database transaction, only if it is not
 * there. The email is queued under the same key (the queue ignores a key it has seen). So a job that reports the
 * same event after a restart, or twice at once, adds nothing.
 *
 * RATE-LIMITED: one person gets at most `perUserPerHour` notifications an hour; beyond that an event is dropped
 * and written to the audit log as suppressed. The mail queue has its own limits per address and overall.
 *
 * The audit log gets who was told, which kind and by which channels: never what it said.
 */
import { randomToken, sha256 } from '../crypto';
import type { MailQueue } from '../mail/queue';
import { mailOf, notificationText, type NotificationData, type NotificationKind } from '../mail/templates';
import type { AuditInput, NotificationCategory, NotificationPrefsRecord, NotificationRecord, Stores, UserRecord } from '../store/types';

/** NOT BUILT. What a push sender would implement: it is given the person and the words, and delivers them to that person's devices. */
export interface PushChannel {
  send(user: { id: string }, notification: { title: string; body: string; category: NotificationCategory }): Promise<void>;
}

export const NOTIFICATION_CATEGORIES: NotificationCategory[] = ['rates', 'approvals', 'payments'];
const HOUR = 60 * 60_000;
/** Read notifications are kept this long, unread ones twice as long. */
const KEEP_MS = 30 * 24 * HOUR;
const MAIL_CATEGORY = { rates: 'rates', approvals: 'payments', payments: 'payments' } as const;
const SYSTEM = { type: 'system' as const, id: null, label: 'notifications' };

export interface NotifyRequest<K extends NotificationKind = NotificationKind> {
  userId: string;
  companyId: string | null;
  category: NotificationCategory;
  kind: K;
  note: NotificationData<K>;
  /** What happened, to what: the same value for the same person is the same notification. */
  dedupe: string;
}
export const noteOf = <K extends NotificationKind>(request: NotifyRequest<K>): NotifyRequest => request as unknown as NotifyRequest;

/** What the app is given for one notification. */
export interface NotificationView {
  id: string;
  category: NotificationCategory;
  title: string;
  body: string;
  createdAt: string;
  read: boolean;
}

export class Notifier {
  private readonly suppressed = new Set<string>();

  constructor(
    private readonly stores: Pick<Stores, 'notifications' | 'notificationPrefs' | 'directory'>,
    private readonly mail: MailQueue,
    private readonly options: { now: () => number; perUserPerHour: number; push?: PushChannel | null; onError?: (message: string) => void },
  ) {}

  async prefsOf(userId: string): Promise<NotificationPrefsRecord['email']> {
    const stored = await this.stores.notificationPrefs.get(userId);
    return { rates: true, approvals: true, payments: true, ...(stored?.email ?? {}) };
  }

  /** Never throws: a notification that cannot be made must not undo or fail what it is about. */
  async notify(request: NotifyRequest): Promise<'created' | 'duplicate' | 'suppressed' | 'skipped'> {
    try {
      return await this.deliver(request);
    } catch (error) {
      this.options.onError?.(error instanceof Error ? error.message : 'notification failed');
      return 'skipped';
    }
  }

  private async deliver(request: NotifyRequest): Promise<'created' | 'duplicate' | 'suppressed' | 'skipped'> {
    const at = this.options.now();
    const user: UserRecord | null = await this.stores.directory.getUser(request.userId);
    // Nobody is told anything on an account that is not in use.
    if (!user || user.activatedAt === null || user.disabledAt) return 'skipped';
    const key = sha256(`${request.dedupe}\n${user.id}`).slice(0, 40);
    if (await this.stores.notifications.get(key)) return 'duplicate';
    const recent = await this.stores.notifications.count({ userId: user.id }, (row) => row.createdAt > at - HOUR);
    const target = { type: 'client' as const, id: user.id, label: user.email };
    const entry = (outcome: 'success' | 'failure', detail: Record<string, string>): AuditInput => ({ at, actor: SYSTEM, target, action: 'notification', outcome, source: 'server', detail: { kind: request.kind, category: request.category, ...detail } });
    if (recent >= this.options.perUserPerHour) {
      // Dropped for now, and on record (once per event while this server runs). An event that is reported again
      // later, such as a payment still waiting, is made then.
      if (!this.suppressed.has(key)) {
        if (this.suppressed.size >= 10_000) this.suppressed.clear();
        this.suppressed.add(key);
        await this.stores.notifications.mutate(`suppressed:${key}`, () => null, () => entry('failure', { reason: 'rate_limited' }));
      }
      return 'suppressed';
    }
    const email = (await this.prefsOf(user.id))[request.category];
    let created = false;
    await this.stores.notifications.mutate(
      key,
      (current) => {
        if (current) return undefined;
        created = true;
        return { id: `ntf_${randomToken().slice(0, 16)}`, key, userId: user.id, companyId: request.companyId, category: request.category, kind: request.kind, body: JSON.stringify(request.note), createdAt: at, readAt: null };
      },
      (stored) => (created && stored ? entry('success', { email: email ? 'queued' : 'off' }) : null),
    );
    if (!created) return 'duplicate';
    if (email) await this.mail.enqueue(mailOf({ to: user.email, template: 'notification', data: { name: user.name, kind: request.kind, note: request.note }, key: `notification:${key}`, category: MAIL_CATEGORY[request.category] }));
    if (this.options.push) {
      const text = notificationText(request.kind, request.note);
      await this.options.push.send({ id: user.id }, { title: text.title, body: text.lines.join(' '), category: request.category });
    }
    return 'created';
  }

  private view(record: NotificationRecord): NotificationView {
    const text = notificationText(record.kind as NotificationKind, JSON.parse(record.body));
    return { id: record.id, category: record.category, title: text.title, body: text.lines.join('\n'), createdAt: new Date(record.createdAt).toISOString(), read: record.readAt !== null };
  }

  /** A person's own notifications, newest first, and how many are unread. */
  async list(userId: string, limit = 50): Promise<{ items: NotificationView[]; unread: number }> {
    const rows = (await this.stores.notifications.list({ userId })).sort((a, b) => b.createdAt - a.createdAt);
    return { items: rows.slice(0, limit).map((row) => this.view(row)), unread: rows.filter((row) => row.readAt === null).length };
  }

  /** Marks one of a person's OWN notifications as read (or all of them). Somebody else's id changes nothing. */
  async markRead(userId: string, id: string | null): Promise<number> {
    const at = this.options.now();
    const rows = await this.stores.notifications.list({ userId }, (row) => row.readAt === null && (id === null || row.id === id));
    let changed = 0;
    for (const row of rows) {
      const stored = await this.stores.notifications.mutate(row.key, (current) => (current && current.userId === userId && current.readAt === null ? { ...current, readAt: at } : undefined));
      if (stored?.readAt === at) changed += 1;
    }
    return changed;
  }

  /** For staff: how many, how many unread, and the email choices. Never what any notification says. */
  async stateOf(userId: string): Promise<{ total: number; unread: number; latestAt: number | null; email: NotificationPrefsRecord['email'] }> {
    const rows = await this.stores.notifications.list({ userId });
    return { total: rows.length, unread: rows.filter((row) => row.readAt === null).length, latestAt: rows.reduce<number | null>((latest, row) => (latest === null || row.createdAt > latest ? row.createdAt : latest), null), email: await this.prefsOf(userId) };
  }

  async sweep(): Promise<void> {
    const at = this.options.now();
    await this.stores.notifications.deleteWhere((row) => at - row.createdAt > (row.readAt === null ? 2 * KEEP_MS : KEEP_MS));
  }
}
