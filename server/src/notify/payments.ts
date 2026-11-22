/**
 * WHO IS TOLD WHAT ABOUT A HELD PAYMENT.
 *
 * This does not hook into the payment code. It LOOKS at the held payments as they are and works out which
 * notifications are due; the notifier makes each one once (notify/notifier.ts), so looking again after a
 * restart, or twice at once, adds nothing. It is run after every payment action and on a schedule.
 *
 *   waiting for approval      every person who could approve it: an active approver or administrator of the
 *                             company, never its creator, not someone who already approved
 *   about to expire           the same people, and its creator
 *   approved / sent / rejected (with the reason) / cancelled by someone else / expired / stopped (payee changed)
 *   / needs attention (not sent; outcome being checked; sent but not as approved)
 *                             its creator
 *
 * A notification says the amount, the currency, the payee's NAME and who created it. Never bank details.
 */
import type { UserRole } from '@/api/types';

import { outcomeUnknown } from '../payments/held';
import type { CompanyMember, HeldPaymentRecord, NotificationCategory, Stores } from '../store/types';
import type { NotificationKind, PaymentNote } from '../mail/templates';
import { noteOf, type Notifier } from './notifier';

const CAN_APPROVE: UserRole[] = ['approver', 'admin'];
/** A payment that closed longer ago than this is not news. */
const RECENT_MS = 24 * 60 * 60_000;

export class PaymentNotifications {
  private running: Promise<number> | null = null;

  constructor(
    private readonly stores: Pick<Stores, 'payments' | 'directory'>,
    private readonly notifier: Notifier,
    private readonly options: { now: () => number; expiryWarningMs: number; onError?: (message: string) => void },
  ) {}

  /** Looks at one company's held payments (or everyone's) and sends what is due. Never throws. Returns how many notifications were made. */
  async scan(companyId?: string): Promise<number> {
    // One at a time: a second caller waits for the first and then looks again.
    while (this.running) await this.running;
    this.running = this.look(companyId).catch((error: unknown) => {
      this.options.onError?.(error instanceof Error ? error.message : 'payment notifications failed');
      return 0;
    });
    try {
      return await this.running;
    } finally {
      this.running = null;
    }
  }

  private async look(companyId?: string): Promise<number> {
    const at = this.options.now();
    // ONLY WHAT CAN BE DUE is read, through indexes: payments still waiting or being sent, and those whose status
    // changed in the last day. Never the whole table.
    const scope = companyId ? { companyId } : {};
    const found = new Map<string, HeldPaymentRecord>();
    for (const record of [...(await this.stores.payments.list({ ...scope, status: 'awaiting_approval' })), ...(await this.stores.payments.list({ ...scope, status: 'sending' })), ...(await this.stores.payments.list({ ...scope, changedSince: at - RECENT_MS }))]) found.set(record.id, record);
    const records = [...found.values()];
    const members = new Map<string, CompanyMember[]>();
    let made = 0;
    for (const record of records) {
      if (!members.has(record.companyId)) members.set(record.companyId, await this.stores.directory.listMembers(record.companyId));
      made += await this.examine(record, members.get(record.companyId) ?? [], at);
    }
    return made;
  }

  private async examine(record: HeldPaymentRecord, members: CompanyMember[], at: number): Promise<number> {
    const nameOf = async (userId: string | null): Promise<string> => (userId ? (members.find((member) => member.userId === userId)?.name ?? (await this.stores.directory.getUser(userId))?.name ?? 'someone') : 'someone');
    const base: PaymentNote = { amount: record.amount, currency: record.currency, payee: record.payee.name, createdBy: await nameOf(record.createdBy), expiresAt: record.expiresAt };
    let made = 0;
    const tell = async (userId: string, category: NotificationCategory, kind: Exclude<NotificationKind, 'rate_alert'>, event: string, extra: Partial<PaymentNote> = {}): Promise<void> => {
      const result = await this.notifier.notify(noteOf({ userId, companyId: record.companyId, category, kind, note: { ...base, ...extra }, dedupe: `payment:${record.id}:${event}` }));
      if (result === 'created') made += 1;
    };
    const creator = (kind: Exclude<NotificationKind, 'rate_alert'>, event: string, extra: Partial<PaymentNote> = {}) => tell(record.createdBy, 'payments', kind, event, extra);

    if (record.status === 'awaiting_approval') {
      if (record.expiresAt <= at) return made; // about to be expired by the payment code; told then
      const approvers = members.filter((member) => member.active && CAN_APPROVE.includes(member.role) && member.userId !== record.createdBy && !record.approvals.some((approval) => approval.userId === member.userId));
      for (const member of approvers) await tell(member.userId, 'approvals', 'payment_awaiting', 'awaiting');
      if (record.expiresAt - at <= this.options.expiryWarningMs) {
        for (const member of approvers) await tell(member.userId, 'approvals', 'payment_expiring', 'expiring');
        await creator('payment_expiring', 'expiring');
      }
    } else if (record.status === 'sending') {
      // Fully approved. Either it is on its way, or an attempt went unanswered and its outcome is being checked.
      await creator('payment_approved', 'approved');
      if (outcomeUnknown(record)) await creator('payment_checking', 'checking');
    } else if (record.status === 'sent') {
      if (record.mismatch) await creator('payment_mismatch', 'mismatch');
      else await creator('payment_sent', 'sent');
    } else if (record.status === 'failed') await creator('payment_failed', 'failed');
    else if (record.status === 'rejected') await creator('payment_rejected', 'rejected', { by: await nameOf(record.closedBy), reason: record.note });
    else if (record.status === 'cancelled') {
      if (record.closedBy !== record.createdBy) await creator('payment_cancelled', 'cancelled', { by: await nameOf(record.closedBy) });
    } else if (record.status === 'expired') await creator('payment_expired', 'expired');
    else if (record.status === 'payee_changed') await creator('payment_stopped', 'stopped');
    return made;
  }
}
