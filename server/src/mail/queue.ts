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
 *    the next start (the same Message-ID, the same content). Twice is possible
 *    in that one case; never is not.
 *  - Per-recipient and global limits per hour, counted from the outbox itself
 *    (so a restart does not reset them): beyond them a message is recorded as
 *    suppressed, not sent. Nobody can use this server to flood an address.
 *  - The body (which may hold a single-use link) is stored ENCRYPTED and is
 *    erased as soon as the message is sent, has failed for good, or was
 *    suppressed. Nothing here logs a body, a subject, a link or an address.
 */
import { randomToken, sha256 } from '../crypto';
import type { MailMessage, Mailer } from '../mailer';
import type { AuditLog, MailRecord, Table } from '../store/types';
import { failureCode } from './smtp';
import { render, type MailRequest } from './templates';

export interface MailQueueOptions {
  table: Table<MailRecord>;
  audit: AuditLog;
  transport: Mailer;
  now: () => number;
  /** This server's own addresses: the only places a link in an email may point. */
  links: string[];
  /** The domain used in Message-IDs (that of the from-address). */
  domain: string;
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
const SYSTEM = { type: 'system' as const, id: null, label: 'mail' };

export type EnqueueResult = 'queued' | 'duplicate' | 'suppressed';

export class MailQueue {
  private running: Promise<void> | null = null;
  private again = false;
  constructor(private readonly options: MailQueueOptions) {}

  private keyOf(key: string): string {
    return sha256(`mail:${key}`);
  }

  /** Queues one logical message. The same key again changes nothing. */
  async enqueue(request: MailRequest): Promise<EnqueueResult> {
    const { table, now, audit } = this.options;
    const rendered = render(request.template, request.data, this.options.links);
    const at = now();
    const rowKey = this.keyOf(request.key);
    const to = request.to.trim().toLowerCase();
    // The limits. Counted over what was queued in the last hour, sent or not.
    const recent = await table.list({}, (row) => row.createdAt > at - HOUR && row.status !== 'suppressed');
    const over = recent.filter((row) => row.to === to).length >= this.options.perRecipientPerHour ? 'recipient' : recent.length >= this.options.globalPerHour ? 'global' : null;
    let created = false;
    const stored = await table.mutate(rowKey, (current) => {
      if (current) return undefined;
      created = true;
      return {
        id: `mail_${randomToken().slice(0, 16)}`,
        key: rowKey,
        to,
        category: request.category,
        template: request.template,
        body: over ? null : JSON.stringify(rendered),
        status: over ? 'suppressed' : 'queued',
        attempts: 0,
        nextAttemptAt: at,
        attemptAt: null,
        createdAt: at,
        sentAt: null,
        lastError: over ? `${over} limit` : null,
      };
    });
    if (!created || !stored) return 'duplicate';
    if (over) {
      await audit.append({ at, actor: SYSTEM, target: null, action: 'system.mail.suppressed', outcome: 'failure', source: '', detail: { mail: stored.id, template: request.template, category: request.category, limit: over } });
      return 'suppressed';
    }
    if (this.options.delivery === 'inline') await this.pump();
    else void this.pump();
    return 'queued';
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

  private async pass(): Promise<void> {
    const { table, now, transport, audit } = this.options;
    const at = now();
    const due = await table.list({}, (row) => (row.status === 'queued' && row.nextAttemptAt <= at) || (row.status === 'sending' && (row.attemptAt ?? 0) <= at - STUCK_MS));
    for (const candidate of due) {
      const rowKey = candidate.key;
      // Claimed before it is sent: of two passes, one sends.
      let mine = false;
      const claimed = await table.mutate(rowKey, (current) => {
        mine = false;
        if (!current || current.id !== candidate.id) return undefined;
        const ready = (current.status === 'queued' && current.nextAttemptAt <= at) || (current.status === 'sending' && (current.attemptAt ?? 0) <= at - STUCK_MS);
        if (!ready) return undefined;
        mine = true;
        return { ...current, status: 'sending', attempts: current.attempts + 1, attemptAt: at };
      });
      if (!mine || !claimed) continue;
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
        await table.mutate(rowKey, (current) => (current && current.id === claimed.id ? { ...current, status: 'sent', sentAt: done, body: null, lastError: null } : undefined));
        continue;
      }
      const final = claimed.attempts >= MAIL_MAX_ATTEMPTS;
      await table.mutate(rowKey, (current) =>
        current && current.id === claimed.id
          ? { ...current, status: final ? 'failed' : 'queued', nextAttemptAt: done + (MAIL_BACKOFF_MS[claimed.attempts - 1] ?? 0), lastError: failure, body: final ? null : current.body }
          : undefined,
      );
      if (final) await audit.append({ at: done, actor: SYSTEM, target: null, action: 'system.mail.failed', outcome: 'failure', source: '', detail: { mail: claimed.id, template: claimed.template, category: claimed.category, attempts: String(claimed.attempts), error: failure } });
    }
  }

  /** At start-up: attempts cut off by the last stop are due again at once (no other process could be making them). */
  async recover(): Promise<void> {
    const { table } = this.options;
    for (const row of await table.list({ status: 'sending' })) await table.mutate(row.key, (current) => (current && current.status === 'sending' ? { ...current, status: 'queued', nextAttemptAt: 0 } : undefined));
  }

  /** For the ops console: how many of each, and the ones that failed or were suppressed. Never a body, a subject or a link. */
  async summary(): Promise<{ counts: Record<MailRecord['status'], number>; oldestQueuedAt: number | null; problems: Pick<MailRecord, 'id' | 'to' | 'category' | 'template' | 'status' | 'attempts' | 'createdAt' | 'lastError'>[] }> {
    const rows = await this.options.table.list();
    const counts: Record<MailRecord['status'], number> = { queued: 0, sending: 0, sent: 0, failed: 0, suppressed: 0 };
    for (const row of rows) counts[row.status] += 1;
    const waiting = rows.filter((row) => row.status === 'queued' || row.status === 'sending');
    return {
      counts,
      oldestQueuedAt: waiting.length ? Math.min(...waiting.map((row) => row.createdAt)) : null,
      problems: rows
        .filter((row) => row.status === 'failed' || row.status === 'suppressed' || (row.status === 'queued' && row.attempts > 0))
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, 200)
        .map(({ id, to, category, template, status, attempts, createdAt, lastError }) => ({ id, to, category, template, status, attempts, createdAt, lastError })),
    };
  }

  /** Removes what is over and long past: sent, failed and suppressed messages older than 30 days. */
  async sweep(): Promise<void> {
    const at = this.options.now();
    await this.options.table.deleteWhere({}, (row) => (row.status === 'sent' || row.status === 'failed' || row.status === 'suppressed') && row.createdAt < at - 30 * 24 * HOUR);
  }
}
