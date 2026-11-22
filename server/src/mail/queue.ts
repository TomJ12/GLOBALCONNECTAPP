/**
 * THE OUTBOX. Every email this server sends is first written to the database
 * (table `mail_outbox`) and sent from there.
 *
 *  - The request that causes an email only WRITES it: a slow or broken mail
 *    server does not block or fail the request.
 *  - A message that cannot be sent is tried again with a growing delay, a
 *    bounded number of times, then marked failed and shown in the ops console.
 *  - One logical message has one key and is queued once, however often the
 *    code that wants it sent runs (a retried request, a resumed approval).
 *  - Each attempt is claimed in a transaction before it is made, so two
 *    passes never send the same message at the same moment. SMTP cannot tell
 *    us "delivered exactly once": if the process dies between the mail server
 *    accepting a message and that being recorded, the message is sent again at
 *    the next start (the same Message-ID, the same content). AT LEAST ONCE:
 *    twice is possible in that one case; never is not.
 *
 * LIMITS, BY CLASS. Nobody can use this server to flood an address, and no
 * class of mail can use up another's allowance:
 *
 *    security   notices about the account             its own allowance
 *    links      activation and password-reset links   its own allowance
 *    payments   payments to approve, own payments     the configured allowance
 *    rates      rate alerts                           half the configured allowance
 *    digest     "more is waiting in the app"          one per address per hour
 *
 *   Each class is counted separately, per address and overall, over the last
 *   hour of what was actually SENT (from the outbox itself, so a restart does
 *   not reset it). Ordinary notifications can therefore never hold back a
 *   security notice or a link.
 *
 *   A message over its allowance is NEVER DROPPED: it is DEFERRED, stays in
 *   the outbox and is sent as soon as the allowance frees. The one exception:
 *   an ordinary notification (payments, rates) over the PER-ADDRESS allowance
 *   is folded into one digest email per hour that says more is waiting in the
 *   app, where every notification is listed anyway.
 *
 *  - The body (which may hold a single-use link) is stored ENCRYPTED and is
 *    erased as soon as the message is sent, has failed for good, or was folded
 *    into a digest. Nothing here logs a body, a subject, a link or an address.
 */
import { randomToken, sha256 } from '../crypto';
import type { MailMessage, Mailer } from '../mailer';
import type { AuditLog, MailRecord, Table } from '../store/types';
import { failureCode } from './smtp';
import { mailOf, render, type MailRequest, type TemplateName } from './templates';

export interface MailQueueOptions {
  table: Table<MailRecord>;
  audit: AuditLog;
  transport: Mailer;
  now: () => number;
  /** This server's own addresses: the only places a link in an email may point. */
  links: string[];
  /** The domain used in Message-IDs (that of the from-address). */
  domain: string;
  /** The allowance of ordinary notifications per address and overall, per hour. The other classes are derived (see `allowance`). */
  perRecipientPerHour: number;
  globalPerHour: number;
  /**
   * `inline`: the queue is emptied before `enqueue` returns (the development console outbox: instant, in this
   * process). `background`: `enqueue` only writes; sending happens on its own (SMTP).
   */
  delivery: 'inline' | 'background';
  onError?: (message: string) => void;
}

const HOUR = 60 * 60_000;
/** Wait before the 2nd, 3rd, ... attempt. After the last one the message has failed. */
export const MAIL_BACKOFF_MS = [60_000, 5 * 60_000, 15 * 60_000, HOUR, 3 * HOUR];
export const MAIL_MAX_ATTEMPTS = MAIL_BACKOFF_MS.length + 1;
/** An attempt that has been "sending" this long without a result was cut off. */
const STUCK_MS = 2 * 60_000;
/** A deferred message is looked at again this often. */
const DEFER_MS = 60_000;
const SYSTEM = { type: 'system' as const, id: null, label: 'mail' };

export type MailClass = NonNullable<MailRecord['class']>;
export const classOf = (template: string, category: string): MailClass =>
  template === 'notification.digest' ? 'digest' : template.startsWith('activation.') || template.startsWith('reset.') ? 'links' : template === 'security.notice' ? 'security' : category === 'rates' ? 'rates' : 'payments';
/** Security and link mail per address per hour: fixed, and not taken from anybody else's allowance. */
export const SECURITY_PER_RECIPIENT = 12;
export const LINKS_PER_RECIPIENT = 6;

/**
 * Where a message stands. `deferred`: over its hourly allowance for now; it will be sent, later.
 * `digest`: an ordinary notification that was folded into the hourly digest instead of being sent by itself.
 */
export type MailState = 'sent' | 'queued' | 'deferred' | 'failed' | 'digest';
export interface Delivery {
  /** True when this key had been queued before: nothing new was written. */
  duplicate: boolean;
  state: MailState;
  /** When the mail server accepted it, if it has. */
  sentAt: number | null;
}
export const stateOf = (row: Pick<MailRecord, 'status' | 'deferred'>): MailState => (row.status === 'sent' ? 'sent' : row.status === 'failed' ? 'failed' : row.status === 'suppressed' ? 'digest' : row.deferred ? 'deferred' : 'queued');
/**
 * For the audit log and for answers to staff: WHO the email is for and WHAT BECAME OF IT. "sentTo" is said only when
 * the mail server has accepted it; otherwise it is "queuedFor" (queued or deferred) or "notSentTo".
 */
export const mailedDetail = (masked: string, delivery: Pick<Delivery, 'state'>): Record<string, string> => ({ [delivery.state === 'sent' ? 'sentTo' : delivery.state === 'failed' ? 'notSentTo' : 'queuedFor']: masked, email: delivery.state });

/** For a person to read: what became of a message. */
export const DELIVERY_WORDS: Record<MailState, string> = {
  sent: 'sent',
  queued: 'queued: it is in the outbox and will be sent shortly',
  deferred: 'deferred: this address or the server has had its hourly allowance of this kind of email, so it will be sent when the allowance frees',
  failed: 'NOT sent: the mail server refused it too many times',
  digest: 'folded into a digest',
};

export class MailQueue {
  private running: Promise<void> | null = null;
  private again = false;
  constructor(private readonly options: MailQueueOptions) {}

  private keyOf(key: string): string {
    return sha256(`mail:${key}`);
  }

  /** How many of a class may be sent per hour: to one address, and overall. */
  allowance(kind: MailClass): { recipient: number; global: number } {
    const { perRecipientPerHour, globalPerHour } = this.options;
    if (kind === 'security') return { recipient: Math.max(SECURITY_PER_RECIPIENT, 1), global: globalPerHour };
    if (kind === 'links') return { recipient: LINKS_PER_RECIPIENT, global: globalPerHour };
    if (kind === 'rates') return { recipient: Math.max(1, Math.floor(perRecipientPerHour / 2)), global: Math.max(1, Math.floor(globalPerHour / 2)) };
    if (kind === 'digest') return { recipient: 1, global: globalPerHour };
    return { recipient: perRecipientPerHour, global: globalPerHour };
  }

  /**
   * Queues one logical message. The same key again changes nothing. NOTHING IS DROPPED HERE: whether it can go now
   * is decided when it is sent. The answer says where the message stands, which callers must not ignore.
   * A message that cannot be rendered (a template was given something it refuses) is recorded as FAILED, not thrown.
   */
  async enqueue(request: MailRequest): Promise<Delivery> {
    const { table, now, audit } = this.options;
    const at = now();
    const rowKey = this.keyOf(request.key);
    const to = request.to.trim().toLowerCase();
    let rendered: ReturnType<typeof render> | null = null;
    try {
      rendered = render(request.template, request.data, this.options.links);
    } catch (error) {
      // A message that cannot even be written out is NOT lost silently: it is on record as failed (the ops Mail
      // page shows it), in the audit log, and the caller is told.
      this.options.onError?.(error instanceof Error ? error.message : 'an email could not be rendered');
    }
    let created = false;
    await table.mutate(rowKey, (current) => {
      if (current) return undefined;
      created = true;
      return {
        id: `mail_${randomToken().slice(0, 16)}`,
        key: rowKey,
        to,
        category: request.category,
        class: classOf(request.template, request.category),
        template: request.template,
        body: rendered ? JSON.stringify(rendered) : null,
        status: rendered ? 'queued' : 'failed',
        attempts: 0,
        nextAttemptAt: at,
        attemptAt: null,
        createdAt: at,
        sentAt: null,
        sentHour: null,
        deferred: null,
        lastError: rendered ? null : 'could not be rendered',
      };
    });
    if (created && !rendered) await audit.append({ at, actor: SYSTEM, target: null, action: 'system.mail.failed', outcome: 'failure', source: '', detail: { template: request.template, category: request.category, attempts: '0', error: 'render' } });
    if (created && rendered) {
      if (this.options.delivery === 'inline') await this.pump();
      else void this.pump();
    }
    const stored = await table.get(rowKey);
    return { duplicate: !created, state: stored ? stateOf(stored) : 'queued', sentAt: stored?.sentAt ?? null };
  }

  /** Where the message with this key stands, or null if there is none. */
  async delivery(key: string): Promise<Delivery | null> {
    const stored = await this.options.table.get(this.keyOf(key));
    return stored ? { duplicate: true, state: stateOf(stored), sentAt: stored.sentAt } : null;
  }

  /** Sends what is due. Never throws; one pass at a time (a call during a pass makes that pass run once more). */
  pump(): Promise<void> {
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = (async () => {
      try {
        do {
          this.again = false;
          await this.pass();
        } while (this.again);
      } catch (error) {
        this.options.onError?.(error instanceof Error ? error.message : 'mail queue error');
      } finally {
        this.running = null;
      }
    })();
    return this.running;
  }

  /** What was sent in the last hour, by class: overall and to each address. Read through the indexes on the hour sent. */
  private async sentLastHour(at: number): Promise<{ global: Map<MailClass, number>; byRecipient: Map<string, number> }> {
    const { table } = this.options;
    const hour = Math.floor(at / HOUR);
    const rows = [...(await table.list({ sentHour: hour })), ...(await table.list({ sentHour: hour - 1 })), ...(await table.list({ status: 'sending' }))].filter((row) => row.status === 'sending' || (row.sentAt ?? 0) > at - HOUR);
    const global = new Map<MailClass, number>();
    const byRecipient = new Map<string, number>();
    for (const row of rows) {
      const kind = row.class ?? classOf(row.template, row.category);
      global.set(kind, (global.get(kind) ?? 0) + 1);
      byRecipient.set(`${kind}\n${row.to}`, (byRecipient.get(`${kind}\n${row.to}`) ?? 0) + 1);
    }
    return { global, byRecipient };
  }

  private async pass(): Promise<void> {
    const { table, now, transport, audit } = this.options;
    const at = now();
    const ready = (row: MailRecord): boolean => (row.status === 'queued' && row.nextAttemptAt <= at) || (row.status === 'sending' && (row.attemptAt ?? 0) <= at - STUCK_MS);
    // Only what is waiting is read (by the index on status), oldest first; security and links go before the rest.
    const order: MailClass[] = ['security', 'links', 'digest', 'payments', 'rates'];
    const due = [...(await table.list({ status: 'queued' })), ...(await table.list({ status: 'sending' }))]
      .filter(ready)
      .map((row) => ({ row, kind: row.class ?? classOf(row.template, row.category) }))
      .sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind) || a.row.createdAt - b.row.createdAt);
    if (due.length === 0) return;
    const sent = await this.sentLastHour(at);
    for (const { row: candidate, kind } of due) {
      const rowKey = candidate.key;
      // THE ALLOWANCE of this message's own class. Over it, the message waits; it is not dropped.
      const allowance = this.allowance(kind);
      const recipientKey = `${kind}\n${candidate.to}`;
      const over = (sent.byRecipient.get(recipientKey) ?? 0) >= allowance.recipient ? 'recipient' : (sent.global.get(kind) ?? 0) >= allowance.global ? 'global' : null;
      if (over && candidate.status === 'queued') {
        if (over === 'recipient' && (kind === 'payments' || kind === 'rates')) {
          // An ordinary notification beyond what one address gets in an hour: folded into ONE digest for that hour.
          await this.fold(candidate, at);
          continue;
        }
        const first = !candidate.deferred;
        await table.mutate(rowKey, (current) => (current && current.id === candidate.id && current.status === 'queued' ? { ...current, deferred: over, nextAttemptAt: at + DEFER_MS, lastError: `${over} allowance` } : undefined));
        if (first) await audit.append({ at, actor: SYSTEM, target: null, action: 'system.mail.deferred', outcome: 'failure', source: '', detail: { mail: candidate.id, template: candidate.template, class: kind, limit: over } });
        continue;
      }
      // Claimed before it is sent: of two passes, one sends.
      let mine = false;
      const claimed = await table.mutate(rowKey, (current) => {
        mine = false;
        if (!current || current.id !== candidate.id || !ready(current)) return undefined;
        mine = true;
        return { ...current, status: 'sending', attempts: current.attempts + 1, attemptAt: at, deferred: null };
      });
      if (!mine || !claimed) continue;
      sent.global.set(kind, (sent.global.get(kind) ?? 0) + 1);
      sent.byRecipient.set(recipientKey, (sent.byRecipient.get(recipientKey) ?? 0) + 1);
      let failure: string | null = null;
      try {
        const rendered = JSON.parse(claimed.body ?? '') as { subject: string; text: string; html: string };
        const message: MailMessage = { to: claimed.to, subject: rendered.subject, text: rendered.text, html: rendered.html, messageId: `<${claimed.id}@${this.options.domain}>` };
        await transport.send(message);
      } catch (error) {
        failure = failureCode(error);
      }
      const done = now();
      if (failure === null) {
        await table.mutate(rowKey, (current) => (current && current.id === claimed.id ? { ...current, status: 'sent', sentAt: done, sentHour: Math.floor(done / HOUR), body: null, lastError: null } : undefined));
        continue;
      }
      // Not sent: it does not count against the allowance.
      sent.global.set(kind, (sent.global.get(kind) ?? 1) - 1);
      sent.byRecipient.set(recipientKey, (sent.byRecipient.get(recipientKey) ?? 1) - 1);
      const final = claimed.attempts >= MAIL_MAX_ATTEMPTS;
      await table.mutate(rowKey, (current) =>
        current && current.id === claimed.id
          ? { ...current, status: final ? 'failed' : 'queued', nextAttemptAt: done + (MAIL_BACKOFF_MS[claimed.attempts - 1] ?? 0), lastError: failure, body: final ? null : current.body }
          : undefined,
      );
      if (final) await audit.append({ at: done, actor: SYSTEM, target: null, action: 'system.mail.failed', outcome: 'failure', source: '', detail: { mail: claimed.id, template: claimed.template, category: claimed.category, attempts: String(claimed.attempts), error: failure } });
    }
  }

  /** Folds an ordinary notification into the hour's digest for its address: the notification itself is not sent, one digest is. */
  private async fold(row: MailRecord, at: number): Promise<void> {
    const { table, audit } = this.options;
    const folded = await table.mutate(row.key, (current) => (current && current.id === row.id && current.status === 'queued' ? { ...current, status: 'suppressed', body: null, deferred: null, lastError: 'in digest' } : undefined));
    if (folded?.status !== 'suppressed') return;
    await audit.append({ at, actor: SYSTEM, target: null, action: 'system.mail.digest', outcome: 'success', source: '', detail: { mail: row.id, template: row.template, class: row.class ?? classOf(row.template, row.category) } });
    const request = mailOf({ to: row.to, template: 'notification.digest', data: {}, key: `digest:${row.to}:${Math.floor(at / HOUR)}`, category: 'payments' });
    const rendered = render(request.template as TemplateName, request.data, this.options.links);
    await table.mutate(this.keyOf(request.key), (current) =>
      current
        ? undefined
        : { id: `mail_${randomToken().slice(0, 16)}`, key: this.keyOf(request.key), to: row.to, category: 'payments', class: 'digest', template: 'notification.digest', body: JSON.stringify(rendered), status: 'queued', attempts: 0, nextAttemptAt: at, attemptAt: null, createdAt: at, sentAt: null, sentHour: null, deferred: null, lastError: null },
    );
    this.again = true;
  }

  /** At start-up: attempts cut off by the last stop are due again at once (no other process could be making them). */
  async recover(): Promise<void> {
    const { table } = this.options;
    for (const row of await table.list({ status: 'sending' })) await table.mutate(row.key, (current) => (current && current.status === 'sending' ? { ...current, status: 'queued', nextAttemptAt: 0 } : undefined));
  }

  /** For the ops console: how many of each, and the ones that failed, are waiting on an allowance or were folded into a digest. Never a body, a subject or a link. */
  async summary(): Promise<{ counts: Record<MailRecord['status'], number>; deferred: number; oldestQueuedAt: number | null; problems: (Pick<MailRecord, 'id' | 'to' | 'category' | 'template' | 'status' | 'attempts' | 'createdAt' | 'lastError'> & { state: MailState })[] }> {
    const { table } = this.options;
    const counts: Record<MailRecord['status'], number> = { queued: 0, sending: 0, sent: 0, failed: 0, suppressed: 0 };
    for (const status of Object.keys(counts) as MailRecord['status'][]) counts[status] = await table.count({ status });
    const waiting = [...(await table.list({ status: 'queued' })), ...(await table.list({ status: 'sending' }))];
    const troubled = [...waiting.filter((row) => row.attempts > 0 || row.deferred), ...(await table.list({ status: 'failed' })), ...(await table.list({ status: 'suppressed' }))];
    return {
      counts,
      deferred: waiting.filter((row) => row.deferred).length,
      oldestQueuedAt: waiting.length ? Math.min(...waiting.map((row) => row.createdAt)) : null,
      problems: troubled
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, 200)
        .map((row) => ({ id: row.id, to: row.to, category: row.category, template: row.template, status: row.status, attempts: row.attempts, createdAt: row.createdAt, lastError: row.lastError, state: stateOf(row) })),
    };
  }

  /** Removes what is over and long past: sent, failed and folded messages older than 30 days. */
  async sweep(): Promise<void> {
    const at = this.options.now();
    for (const status of ['sent', 'failed', 'suppressed'] as const) await this.options.table.deleteWhere({ status }, (row) => row.createdAt < at - 30 * 24 * HOUR);
  }
}
