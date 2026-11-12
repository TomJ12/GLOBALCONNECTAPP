/**
 * PAYMENT APPROVALS, enforced by this server and the same for every provider.
 *
 * A company with `approvalsRequired` of 1 or 2 does not have its payments sent
 * when they are created. The server HOLDS them (nothing goes to the provider,
 * and no money is set aside) until that many people other than the creator
 * have approved. On the last approval the server re-checks everything, moves
 * the payment to `sending` in one database transaction, and only then asks
 * the provider to make it, under an idempotency key derived from the held
 * payment's id. A crash, a retry or a lost answer therefore cannot send it
 * twice: a payment in `sending` is settled by that same key (look it up; if
 * the provider does not have it, ask again with the same key) before anything
 * else can happen to it, and it is never sent under another key.
 */
import Big from 'big.js';

import { canonicalJson } from '@/api/canonical';
import { isProviderError } from '@/api/errors';
import type { ApprovalResult, ApprovalStep, Beneficiary, Payment, PaymentHoldState, PaymentStatus, PendingApproval, UserRole } from '@/api/types';

import type { Config } from '../config';
import { randomToken, sha256 } from '../crypto';
import { ApiError } from '../errors';
import type { ProviderAdapter } from '../providers/adapter';
import { approvalsRequiredOf, type AuditParty, type CompanyRecord, type HeldPaymentPeople, type HeldPaymentRecord, type Stores, type UserRecord } from '../store/types';

export interface Actor {
  user: UserRecord;
  company: CompanyRecord;
  role: UserRole;
}

export interface HeldPaymentsDeps {
  stores: Stores;
  config: Pick<Config, 'paymentApprovalMs'>;
  now: () => number;
  /** Runs a call against the company's provider. The only way this file reaches one. */
  withProvider: <T>(company: CompanyRecord, run: (provider: ProviderAdapter) => Promise<T>) => Promise<T>;
  /** TESTS ONLY: called after a payment is marked `sending` and before the provider is asked. Throwing here is a crash at that moment. */
  beforeSend?: (record: HeldPaymentRecord) => void | Promise<void>;
}

const CAN_CREATE: UserRole[] = ['creator', 'admin'];
const CAN_APPROVE: UserRole[] = ['approver', 'admin'];
const SYSTEM: AuditParty = { type: 'system', id: null, label: 'payment approvals' };
/** A payment that only just went to `sending` is being sent by the request that put it there; the sweep leaves it alone this long. */
const SEND_GRACE_MS = 30_000;
/** Closed held payments stay in the payments list this long. */
const SHOWN_MS = 30 * 24 * 60 * 60_000;

const usable = (user: UserRecord | undefined | null): user is UserRecord => !!user && user.activatedAt !== null && !user.disabledAt;
const partyOf = (user: UserRecord): AuditParty => ({ type: 'client', id: user.id, label: user.email });
const STATUS: Record<HeldPaymentRecord['status'], PaymentStatus> = {
  awaiting_approval: 'awaiting_approval',
  // Approved, and the provider has been asked; we do not yet know that it has it.
  sending: 'processing',
  sent: 'processing',
  failed: 'failed',
  rejected: 'cancelled',
  cancelled: 'cancelled',
  expired: 'cancelled',
  payee_changed: 'cancelled',
};
/** The fields of a payee that decide where money goes. A change to any of them after creation blocks the payment. */
const payeeSignature = (payee: Beneficiary): string =>
  canonicalJson([payee.id, payee.name, payee.entityType, payee.currency, payee.bankCountry, payee.accountNumber, payee.sortCode, payee.iban, payee.bic, payee.routingNumber]);

export class HeldPayments {
  constructor(private readonly deps: HeldPaymentsDeps) {}

  /** What every audit entry about a payment says: which one, how much, to which payee. Never bank details. */
  detailOf(record: HeldPaymentRecord): Record<string, string> {
    return { payment: record.id, amount: record.amount, currency: record.currency, payee: record.payee.id };
  }
  private async audit(action: string, outcome: 'success' | 'failure', actor: AuditParty, source: string, record: HeldPaymentRecord, detail: Record<string, string> = {}): Promise<void> {
    const company = await this.deps.stores.directory.getCompany(record.companyId);
    await this.deps.stores.audit.append({ at: this.deps.now(), actor, target: { type: 'company', id: record.companyId, label: company?.name ?? record.companyId }, action, outcome, source, detail: { ...this.detailOf(record), ...detail } });
  }

  /** Whether this company's payments are held for approval. */
  holds(company: CompanyRecord): boolean {
    return approvalsRequiredOf(company) >= 1;
  }

  // --- Reading ---------------------------------------------------------------------------------

  /** The company's active members by id, with their role. */
  private async members(companyId: string): Promise<Map<string, { user: UserRecord; role: UserRole }>> {
    const { directory } = this.deps.stores;
    const found = new Map<string, { user: UserRecord; role: UserRole }>();
    for (const membership of await directory.listMemberships()) {
      if (membership.companyId !== companyId) continue;
      const user = await directory.getUser(membership.userId);
      if (user) found.set(user.id, { user, role: membership.role });
    }
    return found;
  }

  private view(record: HeldPaymentRecord, viewer: Actor, members: Map<string, { user: UserRecord; role: UserRole }>, names: Map<string, string>): Payment {
    const awaiting = record.status === 'awaiting_approval' && this.deps.now() < record.expiresAt;
    const approved = new Set(record.approvals.map((item) => item.userId));
    const approvers = [...members.values()].filter(({ user, role }) => usable(user) && CAN_APPROVE.includes(role) && user.id !== record.createdBy && !approved.has(user.id));
    return {
      id: record.id,
      shortReference: `GC-${record.id.slice(3, 11).toUpperCase()}`,
      amount: record.amount,
      currency: record.currency as Payment['currency'],
      beneficiaryId: record.payee.id,
      beneficiaryName: record.payee.name,
      reference: record.reference,
      status: STATUS[record.status],
      route: null,
      fee: null,
      estimatedArrival: null,
      createdAt: new Date(record.createdAt).toISOString(),
      held: {
        state: (record.status === 'sent' ? 'sending' : record.status) as PaymentHoldState,
        createdBy: names.get(record.createdBy) ?? 'Someone no longer on this account',
        createdByYou: record.createdBy === viewer.user.id,
        approvalsRequired: record.approvalsRequired,
        approvals: record.approvals.map((item) => ({ by: names.get(item.userId) ?? 'Someone no longer on this account', at: new Date(item.at).toISOString() })),
        expiresAt: new Date(record.expiresAt).toISOString(),
        canApprove: awaiting && CAN_APPROVE.includes(viewer.role) && viewer.user.id !== record.createdBy && !approved.has(viewer.user.id),
        canCancel: awaiting && (viewer.user.id === record.createdBy || viewer.role === 'admin'),
        approvers: awaiting ? approvers.map(({ user }) => user.name) : [],
      },
    };
  }

  private async viewer(viewer: Actor) {
    const members = await this.members(viewer.company.id);
    const names = new Map<string, string>();
    const nameOf = async (userId: string): Promise<void> => {
      if (!names.has(userId)) names.set(userId, members.get(userId)?.user.name ?? (await this.deps.stores.directory.getUser(userId))?.name ?? 'Someone no longer on this account');
    };
    return {
      one: async (record: HeldPaymentRecord): Promise<Payment> => {
        for (const userId of [record.createdBy, ...record.approvals.map((item) => item.userId)]) await nameOf(userId);
        return this.view(record, viewer, members, names);
      },
    };
  }

  /** Held payments for the payments list: everything not yet handed to the provider's own list, newest first. */
  async listPayments(viewer: Actor): Promise<Payment[]> {
    await this.expireDue(viewer.company.id);
    const view = await this.viewer(viewer);
    const records = (await this.deps.stores.payments.list({ companyId: viewer.company.id })).filter((record) => record.status !== 'sent' && this.deps.now() - record.statusAt < SHOWN_MS);
    return Promise.all(records.map((record) => view.one(record)));
  }

  /** Payments waiting for approval, for everyone in the company: the creator sees theirs waiting, an approver sees what to approve. */
  async listAwaiting(viewer: Actor): Promise<PendingApproval[]> {
    await this.expireDue(viewer.company.id);
    const view = await this.viewer(viewer);
    const records = await this.deps.stores.payments.list({ companyId: viewer.company.id, status: 'awaiting_approval' });
    return Promise.all(
      records.map(async (record) => {
        const payment = await view.one(record);
        const hold = payment.held as NonNullable<Payment['held']>;
        const remaining = record.approvalsRequired - record.approvals.length;
        const steps: ApprovalStep[] = [
          { label: `Created by ${hold.createdBy}`, status: 'done', at: payment.createdAt },
          ...hold.approvals.map((item): ApprovalStep => ({ label: `Approved by ${item.by}`, status: 'done', at: item.at })),
          ...Array.from({ length: remaining }, (_, index): ApprovalStep => ({
            label: record.approvalsRequired === 1 ? 'Approval by someone else' : `Approval ${record.approvals.length + index + 1} of ${record.approvalsRequired}`,
            status: index === 0 && hold.canApprove ? 'waiting_for_you' : 'waiting',
            at: null,
          })),
        ];
        return { payment, beneficiary: record.payee, approvalsRemaining: remaining, steps };
      }),
    );
  }

  /** The held payment made with this idempotency key, if there is one; `undefined` when this key was never held. */
  async findByKey(viewer: Actor, idempotencyKey: string): Promise<Payment | null | undefined> {
    const record = await this.deps.stores.payments.findByKey(viewer.company.id, idempotencyKey);
    if (!record) return undefined;
    if (record.status === 'sent' && record.sendKey) {
      const sendKey = record.sendKey;
      const sent = await this.deps.withProvider(viewer.company, (provider) => provider.findPaymentByIdempotencyKey(sendKey));
      if (sent) return sent;
    }
    return (await this.viewer(viewer)).one(record);
  }

  /** The company's own held payment, or null. Another company's is never found. */
  async find(companyId: string, id: string): Promise<HeldPaymentRecord | null> {
    const record = await this.deps.stores.payments.get(id);
    return record && record.companyId === companyId ? record : null;
  }

  // --- Creating --------------------------------------------------------------------------------

  async create(actor: Actor, input: { beneficiaryId: string; amount: string; currency: string; reference: string; reason: string }, idempotencyKey: string): Promise<Payment> {
    const { stores, now } = this.deps;
    const policy = approvalsRequiredOf(actor.company);
    if (policy === 0) throw new Error('This company does not hold payments for approval.');
    let record = await stores.payments.findByKey(actor.company.id, idempotencyKey);
    if (!record) {
      const payees = await this.deps.withProvider(actor.company, (provider) => provider.listBeneficiaries());
      const payee = payees.items.find((item) => item.id === input.beneficiaryId);
      if (!payee) throw new ApiError('validation', { fields: ['beneficiaryId'] });
      if (payee.currency !== input.currency) throw new ApiError('validation', { fields: ['currency'] });
      const at = now();
      ({ record } = await stores.payments.create({
        id: `hp_${randomToken().slice(0, 20)}`,
        companyId: actor.company.id,
        idempotencyKey,
        createdBy: actor.user.id,
        createdAt: at,
        expiresAt: at + this.deps.config.paymentApprovalMs,
        amount: input.amount,
        currency: input.currency,
        reference: input.reference,
        reason: input.reason,
        payee,
        approvalsRequired: policy,
        approvals: [],
        status: 'awaiting_approval',
        statusAt: at,
        closedBy: null,
        note: null,
        sendKey: null,
        providerPaymentId: null,
      }));
    }
    return (await this.viewer(actor)).one(record);
  }

  // --- Deciding --------------------------------------------------------------------------------

  private close(id: string, status: 'rejected' | 'cancelled' | 'expired' | 'payee_changed', closedBy: string | null, note: string | null): Promise<HeldPaymentRecord | null> {
    const at = this.deps.now();
    // Only a payment that is still waiting can be closed: one that is being sent, or was, is past stopping.
    return this.deps.stores.payments.update(id, [], (current) => (current.status === 'awaiting_approval' ? { ...current, status, statusAt: at, closedBy, note } : null));
  }

  /** Expires what has waited too long. Returns how many. */
  async expireDue(companyId?: string): Promise<number> {
    const at = this.deps.now();
    let expired = 0;
    for (const record of await this.deps.stores.payments.list({ companyId, status: 'awaiting_approval' })) {
      if (record.expiresAt > at) continue;
      const closed = await this.close(record.id, 'expired', null, null);
      if (!closed) continue;
      expired += 1;
      await this.audit('system.payment.expire', 'success', SYSTEM, '', closed, { createdAt: new Date(closed.createdAt).toISOString() });
    }
    return expired;
  }

  /** Loads the payment for a decision, settling or expiring it first if that is due. */
  private async forDecision(actor: Actor, id: string): Promise<HeldPaymentRecord> {
    let record = await this.find(actor.company.id, id);
    if (!record) throw new ApiError('not_found');
    // An unfinished send is settled before anything else is considered.
    if (record.status === 'sending') record = await this.settle(record, '');
    if (record.status === 'awaiting_approval' && record.expiresAt <= this.deps.now()) {
      await this.expireDue(actor.company.id);
      throw new ApiError('validation', { reason: 'payment_expired' });
    }
    return record;
  }

  async approve(actor: Actor, id: string, source: string): Promise<ApprovalResult> {
    const { stores, now } = this.deps;
    const record = await this.forDecision(actor, id);
    const mine = record.approvals.some((item) => item.userId === actor.user.id);
    // Asking again after one's own final approval reports where the payment has got to; it approves nothing.
    if (mine && (record.status === 'sending' || record.status === 'sent' || record.status === 'failed')) return this.resultOf(record);
    if (record.status === 'expired') throw new ApiError('validation', { reason: 'payment_expired' });
    if (record.status !== 'awaiting_approval') throw new ApiError('validation', { reason: 'not_awaiting_approval' });
    if (record.createdBy === actor.user.id) throw new ApiError('forbidden', { reason: 'creator_cannot_approve' });
    if (mine) throw new ApiError('forbidden', { reason: 'already_approved' });

    if (record.approvals.length + 1 >= record.approvalsRequired) {
      // This would be the last approval: what the provider knows is checked now, immediately before the state change.
      const payees = await this.deps.withProvider(actor.company, (provider) => provider.listBeneficiaries());
      const payee = payees.items.find((item) => item.id === record.payee.id);
      if (!payee || payeeSignature(payee) !== payeeSignature(record.payee)) {
        const closed = await this.close(record.id, 'payee_changed', null, payee ? 'payee details changed' : 'payee removed');
        if (closed) await this.audit('system.payment.blocked', 'success', SYSTEM, source, closed, { reason: payee ? 'payee_changed' : 'payee_removed' });
        throw new ApiError('validation', { reason: 'payee_changed' });
      }
      const balances = await this.deps.withProvider(actor.company, (provider) => provider.listBalances());
      const available = balances.find((item) => item.currency === record.currency)?.amount ?? '0';
      if (new Big(available).lt(record.amount)) throw new ApiError('insufficient_funds');
    }

    // ONE transaction: the payment, the creator and the approver are read, checked and the new state written.
    let refusal: ApiError | null = null;
    const refuse = (error: ApiError): null => ((refusal = error), null);
    const at = now();
    const saved = await stores.payments.update(record.id, [record.createdBy, actor.user.id], (current, people: HeldPaymentPeople) => {
      if (current.status !== 'awaiting_approval') return refuse(new ApiError('validation', { reason: 'not_awaiting_approval' }));
      if (current.expiresAt <= at) return refuse(new ApiError('validation', { reason: 'payment_expired' }));
      if (current.createdBy === actor.user.id) return refuse(new ApiError('forbidden', { reason: 'creator_cannot_approve' }));
      if (current.approvals.some((item) => item.userId === actor.user.id)) return refuse(new ApiError('forbidden', { reason: 'already_approved' }));
      const approver = people.get(actor.user.id);
      if (!approver || !usable(approver.user) || !approver.role || !CAN_APPROVE.includes(approver.role)) return refuse(new ApiError('forbidden'));
      const creator = people.get(current.createdBy);
      if (!creator || !usable(creator.user) || !creator.role || !CAN_CREATE.includes(creator.role)) return refuse(new ApiError('validation', { reason: 'creator_unavailable' }));
      const approvals = [...current.approvals, { userId: actor.user.id, at }];
      if (approvals.length < current.approvalsRequired) return { ...current, approvals };
      // The last one. From here the payment can only be sent, under this key and no other.
      return { ...current, approvals, status: 'sending', statusAt: at, sendKey: `gc-${sha256(`held-payment:${current.id}`).slice(0, 40)}` };
    });
    if (!saved) {
      if ((refusal as ApiError | null)?.options.reason === 'payment_expired') await this.expireDue(actor.company.id);
      throw refusal ?? new ApiError('not_found');
    }
    if (saved.status !== 'sending') return this.resultOf(saved);
    await this.audit('client.payment.send', 'success', partyOf(actor.user), source, saved, { key: sha256(saved.sendKey as string).slice(0, 16) });
    return this.resultOf(await this.send(saved, source));
  }

  private resultOf(record: HeldPaymentRecord): ApprovalResult {
    const remaining = Math.max(0, record.approvalsRequired - record.approvals.length);
    // `unknown`: approved, and the provider has been asked, but its answer has not been seen yet.
    return { status: record.status === 'sending' ? 'unknown' : STATUS[record.status], approvalsRemaining: remaining };
  }

  async reject(actor: Actor, id: string, note: string | null): Promise<void> {
    const record = await this.forDecision(actor, id);
    if (record.status === 'expired') throw new ApiError('validation', { reason: 'payment_expired' });
    if (record.status !== 'awaiting_approval' || !(await this.close(record.id, 'rejected', actor.user.id, note))) throw new ApiError('validation', { reason: 'not_awaiting_approval' });
  }

  async cancel(actor: Actor, id: string): Promise<void> {
    const record = await this.forDecision(actor, id);
    // Its creator, or an administrator of the company. Nobody else.
    if (record.createdBy !== actor.user.id && actor.role !== 'admin') throw new ApiError('forbidden');
    if (record.status === 'expired') throw new ApiError('validation', { reason: 'payment_expired' });
    if (record.status !== 'awaiting_approval' || !(await this.close(record.id, 'cancelled', actor.user.id, null))) throw new ApiError('validation', { reason: 'not_awaiting_approval' });
  }

  // --- Sending ---------------------------------------------------------------------------------

  private async finish(record: HeldPaymentRecord, status: 'sent' | 'failed', source: string, providerPaymentId: string | null, note: string | null): Promise<HeldPaymentRecord> {
    const at = this.deps.now();
    const saved = await this.deps.stores.payments.update(record.id, [], (current) => (current.status === 'sending' ? { ...current, status, statusAt: at, providerPaymentId, note } : null));
    if (!saved) return (await this.deps.stores.payments.get(record.id)) ?? record;
    await this.audit('system.payment.send_outcome', status === 'sent' ? 'success' : 'failure', SYSTEM, source, saved, { outcome: status, ...(note ? { reason: note } : {}) });
    return saved;
  }

  /** Asks the provider to make a payment that is in `sending`, under its one key. */
  private async send(record: HeldPaymentRecord, source: string): Promise<HeldPaymentRecord> {
    const company = await this.deps.stores.directory.getCompany(record.companyId);
    const sendKey = record.sendKey;
    if (!company || !sendKey || record.status !== 'sending') return record;
    await this.deps.beforeSend?.(record);
    try {
      const payment = await this.deps.withProvider(company, (provider) =>
        provider.createPayment({ beneficiaryId: record.payee.id, amount: record.amount, currency: record.currency as Payment['currency'], reference: record.reference, reason: record.reason, idempotencyKey: sendKey }),
      );
      return await this.finish(record, 'sent', source, payment.id, null);
    } catch (error) {
      // A plain refusal (not enough money, details not accepted) is final: the provider did not make the payment.
      if (isProviderError(error) && ['validation', 'insufficient_funds', 'forbidden', 'not_found'].includes(error.kind)) return this.finish(record, 'failed', source, null, error.kind);
      // Anything else (no answer, an unreadable one, a busy or signed-out provider): we do not know. It stays `sending`.
      await this.audit('system.payment.send_outcome', 'failure', SYSTEM, source, record, { outcome: 'unknown', reason: isProviderError(error) ? error.kind : 'error' });
      return record;
    }
  }

  /** Settles a payment in `sending`: if the provider has it under its key, it was sent; if not, it is asked again with the SAME key. */
  async settle(record: HeldPaymentRecord, source: string): Promise<HeldPaymentRecord> {
    const company = await this.deps.stores.directory.getCompany(record.companyId);
    const sendKey = record.sendKey;
    if (!company || !sendKey || record.status !== 'sending') return record;
    let found: Payment | null;
    try {
      found = await this.deps.withProvider(company, (provider) => provider.findPaymentByIdempotencyKey(sendKey));
    } catch {
      return record; // Could not ask. It stays as it is and will be looked at again.
    }
    return found ? this.finish(record, 'sent', source, found.id, null) : this.send(record, source);
  }

  /**
   * Run at start-up and periodically: expires what has waited too long, and
   * settles every unfinished send. At start-up nothing is in flight, so every
   * `sending` payment is settled at once (`all`).
   */
  async sweep(options: { all?: boolean } = {}): Promise<{ expired: number; settled: number }> {
    const expired = await this.expireDue();
    let settled = 0;
    for (const record of await this.deps.stores.payments.list({ status: 'sending' })) {
      if (!options.all && this.deps.now() - record.statusAt < SEND_GRACE_MS) continue;
      if ((await this.settle(record, '')).status !== 'sending') settled += 1;
    }
    return { expired, settled };
  }
}
