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
 *
 * ONE SERVER PROCESS. The server holds a lock on its database while it runs
 * (store/sqlite/db.ts), so at start-up no other process can be in the middle
 * of sending: every `sending` payment found then is settled at once.
 *
 * Every change of a payment's state is written together with its audit entry,
 * in one database transaction.
 */
import Big from 'big.js';

import { canonicalJson } from '@/api/canonical';
import { isProviderError } from '@/api/errors';
import { payeeDigestFields } from '@/api/payeeDigest';
import type { ApprovalResult, ApprovalStep, Beneficiary, Payment, PaymentHoldState, PaymentStatus, PendingApproval, UserRole } from '@/api/types';

import type { Config } from '../config';
import { randomToken, sha256 } from '../crypto';
import { ApiError } from '../errors';
import type { ProviderAdapter } from '../providers/adapter';
import { approvalsRequiredOf, type AuditInput, type AuditParty, type CompanyMember, type CompanyRecord, type DirectPaymentRecord, type HeldPaymentPeople, type HeldPaymentRecord, type Stores, type UserRecord } from '../store/types';

export interface Actor {
  user: UserRecord;
  company: CompanyRecord;
  role: UserRole;
}

export interface HeldPaymentsDeps {
  stores: Stores;
  config: Pick<Config, 'paymentApprovalMs' | 'paymentReconcileMs'>;
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
/** What a provider says when it plainly will not make a payment. Anything else is "we do not know". */
const REFUSALS = ['validation', 'insufficient_funds', 'forbidden', 'not_found'];
const ATTEMPTS_KEPT = 20;
type Attempt = NonNullable<HeldPaymentRecord['attempts']>[number];
/** When the provider was last asked to make it (or, never asked yet, when it was approved). */
const lastAttemptAt = (record: HeldPaymentRecord): number => record.attempts?.at(-1)?.at ?? record.statusAt;
/** The attempt history with its latest attempt given its outcome. */
const closeAttempt = (attempts: Attempt[] | undefined, outcome: Attempt['outcome'], reason: string | null): Attempt[] => {
  const list = [...(attempts ?? [])];
  const last = list.at(-1);
  if (last && last.outcome === 'started') list[list.length - 1] = { ...last, outcome, ...(reason ? { reason } : {}) };
  return list;
};
/** True when some attempt to send it went unanswered: its outcome is being checked. */
export const outcomeUnknown = (record: HeldPaymentRecord): boolean => record.status === 'sending' && (Boolean(record.unconfirmedSince) || (record.attempts ?? []).some((item) => item.outcome === 'unknown' || item.outcome === 'refused'));
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
/** How many approvals a waiting payment needs NOW: the rule it was created under, or the company's rule today if that is stricter. A loosened rule never lowers it. */
const requiredNow = (record: HeldPaymentRecord, company: Pick<CompanyRecord, 'approvalsRequired'> | null): number => Math.max(record.approvalsRequired, company ? approvalsRequiredOf(company) : 0);
const mappingOf = (company: CompanyRecord) => ({ providerKey: company.providerKey, providerAccountId: company.providerAccountId, providerContactId: company.providerContactId });
const sameMapping = (a: ReturnType<typeof mappingOf>, b: ReturnType<typeof mappingOf>): boolean => a.providerKey === b.providerKey && a.providerAccountId === b.providerAccountId && a.providerContactId === b.providerContactId;
/** What identifies a request to create a payment: the same idempotency key with anything else is a different request. */
export const requestHashOf = (input: { beneficiaryId: string; amount: string; currency: string; reference: string; reason: string }): string =>
  sha256(canonicalJson([input.beneficiaryId, input.amount, input.currency, input.reference, input.reason]));

export class HeldPayments {
  constructor(private readonly deps: HeldPaymentsDeps) {}

  /** What every audit entry about a payment says: which one, how much, to which payee. Never bank details. */
  detailOf(record: HeldPaymentRecord): Record<string, string> {
    return { payment: record.id, amount: record.amount, currency: record.currency, payee: record.payee.id };
  }
  /** An audit entry about a payment, to be written in the same transaction as the change it records. */
  private entry(action: string, outcome: 'success' | 'failure', actor: AuditParty, source: string, record: HeldPaymentRecord, company: Pick<CompanyRecord, 'name'> | null, detail: Record<string, string> = {}): AuditInput {
    return { at: this.deps.now(), actor, target: { type: 'company', id: record.companyId, label: company?.name ?? record.companyId }, action, outcome, source, detail: { ...this.detailOf(record), ...detail } };
  }

  /** Whether this company's payments are held for approval. */
  holds(company: CompanyRecord): boolean {
    return approvalsRequiredOf(company) >= 1;
  }

  // --- Reading ---------------------------------------------------------------------------------

  /** The company's members by id. Names, roles and whether they can act: no credential is read for a list. */
  private async members(companyId: string): Promise<Map<string, CompanyMember>> {
    return new Map((await this.deps.stores.directory.listMembers(companyId)).map((member) => [member.userId, member]));
  }

  private view(record: HeldPaymentRecord, viewer: Actor, members: Map<string, CompanyMember>, names: Map<string, string>): Payment {
    const awaiting = record.status === 'awaiting_approval' && this.deps.now() < record.expiresAt;
    const approved = new Set(record.approvals.map((item) => item.userId));
    const approvers = [...members.values()].filter((member) => member.active && CAN_APPROVE.includes(member.role) && member.userId !== record.createdBy && !approved.has(member.userId));
    return {
      id: record.id,
      shortReference: `GC-${record.id.slice(3, 11).toUpperCase()}`,
      amount: record.amount,
      currency: record.currency as Payment['currency'],
      beneficiaryId: record.payee.id,
      beneficiaryName: record.payee.name,
      reference: record.reference,
      // Sent, but not as it was approved: nobody should take that for a normal payment.
      // ...and one whose sending went unanswered is neither sent nor failed: nobody should create it again.
      status: record.mismatch || outcomeUnknown(record) ? 'unknown' : STATUS[record.status],
      route: null,
      fee: null,
      estimatedArrival: null,
      createdAt: new Date(record.createdAt).toISOString(),
      held: {
        state: (record.mismatch ? 'mismatch' : outcomeUnknown(record) ? 'checking' : record.status === 'sent' ? 'sending' : record.status) as PaymentHoldState,
        createdBy: names.get(record.createdBy) ?? 'Someone no longer on this account',
        createdByYou: record.createdBy === viewer.user.id,
        approvalsRequired: requiredNow(record, viewer.company),
        approvals: record.approvals.map((item) => ({ by: names.get(item.userId) ?? 'Someone no longer on this account', at: new Date(item.at).toISOString() })),
        expiresAt: new Date(record.expiresAt).toISOString(),
        canApprove: awaiting && CAN_APPROVE.includes(viewer.role) && viewer.user.id !== record.createdBy && !approved.has(viewer.user.id),
        canCancel: awaiting && (viewer.user.id === record.createdBy || viewer.role === 'admin'),
        approvers: awaiting ? approvers.map((member) => member.name) : [],
      },
    };
  }

  private async viewer(viewer: Actor) {
    const members = await this.members(viewer.company.id);
    const names = new Map<string, string>();
    const nameOf = async (userId: string): Promise<void> => {
      if (!names.has(userId)) names.set(userId, members.get(userId)?.name ?? (await this.deps.stores.directory.getUser(userId))?.name ?? 'Someone no longer on this account');
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
    const records = (await this.deps.stores.payments.list({ companyId: viewer.company.id })).filter((record) => (record.status !== 'sent' || Boolean(record.mismatch)) && this.deps.now() - record.statusAt < SHOWN_MS);
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
        const required = hold.approvalsRequired;
        const remaining = Math.max(0, required - record.approvals.length);
        const steps: ApprovalStep[] = [
          { label: `Created by ${hold.createdBy}`, status: 'done', at: payment.createdAt },
          ...hold.approvals.map((item): ApprovalStep => ({ label: `Approved by ${item.by}`, status: 'done', at: item.at })),
          ...Array.from({ length: remaining }, (_, index): ApprovalStep => ({
            label: required === 1 ? 'Approval by someone else' : `Approval ${record.approvals.length + index + 1} of ${required}`,
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
    if (record.status === 'sent' && record.sendKey && !record.mismatch) {
      const sendKey = record.sendKey;
      const target = await this.sendTarget(record);
      const sent = target ? await this.deps.withProvider(target, (provider) => provider.findPaymentByIdempotencyKey(sendKey)) : null;
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

  /** The provider's digest of where a payee's money goes (see @/api/digest), or null when the payee is gone. */
  private async digest(company: CompanyRecord, payeeId: string): Promise<{ digest: string; fields: Record<string, string> } | null> {
    const source = await this.deps.withProvider(company, (provider) => provider.beneficiaryDigestSource(payeeId));
    if (source === null) return null;
    // Field by field as well, as short hashes, so that a later difference can be NAMED (the name only, never a value).
    const fields = Object.fromEntries(Object.entries(payeeDigestFields(source)).map(([name, value]) => [name, sha256(`${name}\n${value}`).slice(0, 16)]));
    return { digest: sha256(source), fields };
  }
  /** The names of the fields that differ between the payee as it was when the payment was created and as it is now. */
  private changedFields(record: HeldPaymentRecord, now: Record<string, string>): string {
    const before = record.payeeFields;
    if (!before) return 'not recorded for this payment';
    const names = [...new Set([...Object.keys(before), ...Object.keys(now)])].filter((name) => before[name] !== now[name]).sort();
    return names.length > 12 ? `${names.slice(0, 12).join(', ')} and ${names.length - 12} more` : names.join(', ');
  }

  /**
   * The payment this idempotency key already made here, if it did. The SAME
   * request (same person, same payee, amount, currency, reference and reason)
   * gets the original back. The same key with anything else, or from anyone
   * else, is refused, without a word about the payment it belongs to.
   * Whatever the company's rule is now: a key that was held is never sent again.
   */
  async replay(actor: Actor, input: Parameters<typeof requestHashOf>[0], idempotencyKey: string, source: string): Promise<Payment | null> {
    let record = await this.deps.stores.payments.findByKey(actor.company.id, idempotencyKey);
    if (!record) return null;
    if (record.createdBy !== actor.user.id || record.requestHash !== requestHashOf(input)) throw new ApiError('validation', { fields: ['idempotencyKey'] });
    // A payment that has waited too long is expired, whoever happens to look at it and however: asking again does not keep it alive.
    if (record.status === 'awaiting_approval' && record.expiresAt <= this.deps.now()) {
      await this.expireDue(actor.company.id);
      record = (await this.deps.stores.payments.get(record.id)) ?? record;
    }
    // Recorded with what the payment IS, not with what was sent this time (they are the same, by the check above).
    await this.deps.stores.audit.append(this.entry('client.payment.create', 'success', partyOf(actor.user), source, record, actor.company, { held: 'yes', replay: 'yes', status: record.status }));
    return (await this.viewer(actor)).one(record);
  }

  /** Holds a new payment. `replay` has already found that this key holds none. */
  async create(actor: Actor, input: Parameters<typeof requestHashOf>[0], idempotencyKey: string, source: string): Promise<Payment> {
    const { stores, now } = this.deps;
    const policy = approvalsRequiredOf(actor.company);
    if (policy === 0) throw new Error('This company does not hold payments for approval.');
    // A payment sent straight to the provider by a version of this server that kept no record of such sends
    // (`submit` has already looked for the record this version keeps). That payment is the answer, for the same request.
    const legacy = await this.deps.withProvider(actor.company, (provider) => provider.findPaymentByIdempotencyKey(idempotencyKey));
    if (legacy) {
      const same = new Big(legacy.amount).eq(input.amount) && legacy.currency === input.currency && legacy.beneficiaryId === input.beneficiaryId && legacy.reference === input.reference;
      if (!same) throw new ApiError('validation', { fields: ['idempotencyKey'] });
      return legacy;
    }
    const payees = await this.deps.withProvider(actor.company, (provider) => provider.listBeneficiaries());
    const payee = payees.items.find((item) => item.id === input.beneficiaryId);
    if (!payee) throw new ApiError('validation', { fields: ['beneficiaryId'] });
    if (payee.currency !== input.currency) throw new ApiError('validation', { fields: ['currency'] });
    const digest = await this.digest(actor.company, payee.id);
    if (digest === null) throw new ApiError('validation', { fields: ['beneficiaryId'] });
    const at = now();
    const result = await stores.payments.create(
      {
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
        payeeDigest: digest.digest,
        payeeFields: digest.fields,
        requestHash: requestHashOf(input),
        approvalsRequired: policy,
        approvals: [],
        status: 'awaiting_approval',
        statusAt: at,
        closedBy: null,
        note: null,
        sendKey: null,
        sendMapping: null,
        providerPaymentId: null,
        attempts: [],
      },
      (stored) => this.entry('client.payment.create', 'success', partyOf(actor.user), source, stored, actor.company, { key: sha256(idempotencyKey).slice(0, 16), held: 'yes', approvalsRequired: String(policy), status: 'awaiting_approval' }),
    );
    // The key went straight to the provider a moment ago (the rule has only just been switched on): that send is the answer.
    if ('direct' in result) return this.direct(actor, input, result.direct, false);
    // Two of the same request at the same moment: the second finds the first's payment, and is held to the same rule as any replay.
    if (!result.created) {
      const again = await this.replay(actor, input, idempotencyKey, source);
      if (again) return again;
    }
    return (await this.viewer(actor)).one(result.record);
  }

  /**
   * A new payment, whatever the company's rule: held for approval, or sent
   * straight to the provider. `replay` has already found that this key holds
   * no held payment.
   *
   * A payment that goes straight to the provider is RECORDED HERE FIRST, by
   * its key, with who made it and a hash of the request. So the key is known
   * to this server from before the provider is asked: while that send is
   * unanswered, or lands late, the same request arriving again (even after an
   * approval rule has been switched on) finds the record and can never become
   * a second, held, payment.
   */
  async submit(actor: Actor, input: Parameters<typeof requestHashOf>[0], idempotencyKey: string, source: string): Promise<Payment> {
    const { stores, now } = this.deps;
    const existing = await stores.payments.getDirect(actor.company.id, idempotencyKey);
    if (existing) return this.direct(actor, input, existing, false);
    if (this.holds(actor.company)) return this.create(actor, input, idempotencyKey, source);
    const claim = await stores.payments.claimDirect({
      companyId: actor.company.id,
      idempotencyKey,
      createdBy: actor.user.id,
      requestHash: requestHashOf(input),
      createdAt: now(),
      mapping: mappingOf(actor.company),
      state: 'started',
      unknown: false,
      providerPaymentId: null,
    });
    if ('held' in claim) {
      // Held a moment ago by the same request arriving twice: answered from that payment, by the rules of any replay.
      const again = await this.replay(actor, input, idempotencyKey, source);
      if (again) return again;
      throw new ApiError('validation', { fields: ['idempotencyKey'] });
    }
    return this.direct(actor, input, claim.direct, claim.created);
  }

  /** Sends, or answers for, a payment that goes straight to the provider under the creator's own key. */
  private async direct(actor: Actor, input: Parameters<typeof requestHashOf>[0], record: DirectPaymentRecord, fresh: boolean): Promise<Payment> {
    // The same key from anyone else, or with anything different in the request, is refused without a word about the payment it belongs to.
    if (record.createdBy !== actor.user.id || record.requestHash !== requestHashOf(input)) throw new ApiError('validation', { fields: ['idempotencyKey'] });
    const { stores } = this.deps;
    const target: CompanyRecord = { ...actor.company, ...record.mapping };
    const mark = (change: (current: DirectPaymentRecord) => Partial<DirectPaymentRecord>) => stores.payments.updateDirect(record.companyId, record.idempotencyKey, (current) => ({ ...current, ...change(current) }));
    if (!fresh) {
      const found = await this.deps.withProvider(target, (provider) => provider.findPaymentByIdempotencyKey(record.idempotencyKey));
      if (found) {
        await mark(() => ({ state: 'made', providerPaymentId: found.id }));
        return found;
      }
      if (this.holds(actor.company)) {
        // The provider does not have it (yet), and the company now has an approval rule. The earlier send may still
        // land, so this request is NOT held as a second payment; and nothing is sent past the rule. A send the
        // provider plainly refused, with no unanswered attempt before it, made nothing: that key is spent.
        if (record.state === 'refused' && !record.unknown) throw new ApiError('validation', { fields: ['idempotencyKey'] });
        throw new ApiError('timeout');
      }
      // Asked again under the same key: an attempt that never reported back is one whose outcome is not known.
      await mark((current) => ({ state: 'started', unknown: current.unknown || current.state === 'started' }));
    }
    try {
      const payment = await this.deps.withProvider(target, (provider) => provider.createPayment({ beneficiaryId: input.beneficiaryId, amount: input.amount, currency: input.currency as Payment['currency'], reference: input.reference, reason: input.reason, idempotencyKey: record.idempotencyKey }));
      await mark(() => ({ state: 'made', providerPaymentId: payment.id }));
      return payment;
    } catch (error) {
      const refused = isProviderError(error) && REFUSALS.includes(error.kind);
      await mark(() => (refused ? { state: 'refused' } : { unknown: true }));
      throw error;
    }
  }

  // --- Deciding --------------------------------------------------------------------------------

  /** Closes a payment that is still waiting, and records it, in one transaction. One that is being sent, or was, is past stopping. */
  private async close(id: string, status: 'rejected' | 'cancelled' | 'expired' | 'payee_changed', closedBy: string | null, note: string | null, audit: (stored: HeldPaymentRecord, company: CompanyRecord | null) => AuditInput): Promise<HeldPaymentRecord | null> {
    const at = this.deps.now();
    let company: CompanyRecord | null = null;
    return this.deps.stores.payments.update(
      id,
      [],
      (current, context) => {
        company = context.company;
        return current.status === 'awaiting_approval' ? { ...current, status, statusAt: at, closedBy, note } : null;
      },
      (stored) => audit(stored, company),
    );
  }

  /** Expires what has waited too long. Returns how many. */
  async expireDue(companyId?: string): Promise<number> {
    const at = this.deps.now();
    let expired = 0;
    for (const record of await this.deps.stores.payments.list({ companyId, status: 'awaiting_approval' })) {
      if (record.expiresAt > at) continue;
      const closed = await this.close(record.id, 'expired', null, null, (stored, company) => this.entry('system.payment.expire', 'success', SYSTEM, '', stored, company, { createdAt: new Date(stored.createdAt).toISOString() }));
      if (closed) expired += 1;
    }
    return expired;
  }

  /** Loads the payment for a decision, settling or expiring it first if that is due. */
  private async forDecision(actor: Actor, id: string): Promise<HeldPaymentRecord> {
    let record = await this.find(actor.company.id, id);
    if (!record) throw new ApiError('not_found');
    // An unfinished send is settled before anything else is considered. By looking it up under its key: the
    // provider is only ASKED AGAIN when the last attempt is old enough to have been given up, and none is under way.
    if (record.status === 'sending') record = await this.settle(record, '', { lookupOnly: this.inFlight.has(record.id) || this.deps.now() - lastAttemptAt(record) < SEND_GRACE_MS });
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
    if (mine && (record.status === 'sending' || record.status === 'sent' || record.status === 'failed')) return this.resultOf(record, actor.company);
    if (record.status === 'expired') throw new ApiError('validation', { reason: 'payment_expired' });
    if (record.status !== 'awaiting_approval') throw new ApiError('validation', { reason: 'not_awaiting_approval' });
    if (record.createdBy === actor.user.id) throw new ApiError('forbidden', { reason: 'creator_cannot_approve' });
    if (mine) throw new ApiError('forbidden', { reason: 'already_approved' });

    // EVERY approval checks the provider itself, before it is recorded: whether it turns out to be the last one is
    // only known inside the transaction below (another approval may land at the same moment), and a payment must
    // never be sent on the strength of a check that nobody ran.
    const checkedAgainst = mappingOf(actor.company);
    const payee = await this.digest(actor.company, record.payee.id);
    const digest = payee?.digest ?? null;
    if (digest !== record.payeeDigest) {
      const reason = payee === null ? 'payee_removed' : 'payee_changed';
      // WHICH fields of the provider's record differ is recorded for staff (names only, never a value), so that a
      // payment blocked by a field the provider moves on its own can be told from a changed destination.
      const fields: Record<string, string> = payee === null ? {} : { fields: this.changedFields(record, payee.fields) };
      await this.close(record.id, 'payee_changed', null, payee === null ? 'payee removed' : 'payee details changed', (stored, company) => this.entry('system.payment.blocked', 'success', SYSTEM, source, stored, company, { reason, ...fields }));
      throw new ApiError('validation', { reason: 'payee_changed' });
    }
    const balances = await this.deps.withProvider(actor.company, (provider) => provider.listBalances());
    const funded = !new Big(balances.find((item) => item.currency === record.currency)?.amount ?? '0').lt(record.amount);

    // ONE transaction: the payment, its company, the creator, the approver and every earlier approver are read,
    // checked, and the new state written together with its audit entries.
    let refusal: ApiError | null = null;
    const refuse = (error: ApiError): null => ((refusal = error), null);
    let at = now();
    let company: CompanyRecord | null = null;
    let dropped: NonNullable<HeldPaymentRecord['droppedApprovals']> = [];
    let required = record.approvalsRequired as number;
    const saved = await stores.payments.update(
      record.id,
      (current) => [current.createdBy, actor.user.id, ...current.approvals.map((item) => item.userId)],
      (current, context: HeldPaymentPeople) => {
        company = context.company;
        // The time of the decision is the time of the transaction that makes it, not of the checks that led up to it.
        at = now();
        if (current.status !== 'awaiting_approval') return refuse(new ApiError('validation', { reason: 'not_awaiting_approval' }));
        if (current.expiresAt <= at) return refuse(new ApiError('validation', { reason: 'payment_expired' }));
        if (current.createdBy === actor.user.id) return refuse(new ApiError('forbidden', { reason: 'creator_cannot_approve' }));
        if (current.approvals.some((item) => item.userId === actor.user.id)) return refuse(new ApiError('forbidden', { reason: 'already_approved' }));
        // The checks above were made against a payee digest and a provider account. Both must still be what is committed.
        if (!context.company || context.company.deactivatedAt || !sameMapping(mappingOf(context.company), checkedAgainst) || current.payeeDigest !== record.payeeDigest) return refuse(new ApiError('validation', { reason: 'not_awaiting_approval' }));
        const approver = context.get(actor.user.id);
        if (!approver || !usable(approver.user) || !approver.role || !CAN_APPROVE.includes(approver.role)) return refuse(new ApiError('forbidden'));
        const creator = context.get(current.createdBy);
        if (!creator || !usable(creator.user) || !creator.role || !CAN_CREATE.includes(creator.role)) return refuse(new ApiError('validation', { reason: 'creator_unavailable' }));
        // An earlier approval counts only while the person who gave it could still give it.
        dropped = [];
        const kept = current.approvals.filter((item) => {
          const person = context.get(item.userId);
          const reason = !person ? 'account removed' : !usable(person.user) ? 'account disabled' : !person.role ? 'removed from the company' : !CAN_APPROVE.includes(person.role) ? 'no longer an approver' : null;
          if (reason) dropped.push({ ...item, droppedAt: at, reason });
          return reason === null;
        });
        const approvals = [...kept, { userId: actor.user.id, at }];
        required = requiredNow(current, context.company);
        const next = { ...current, approvals, droppedApprovals: [...(current.droppedApprovals ?? []), ...dropped] };
        if (approvals.length < required) return next;
        // The last one. It moves to `sending` only because THIS request found the money there.
        if (!funded) return refuse(new ApiError('insufficient_funds'));
        // From here the payment can only be sent: under this key and no other, to this provider account and no other.
        return { ...next, status: 'sending', statusAt: at, sendKey: `gc-${sha256(`held-payment:${current.id}`).slice(0, 40)}`, sendMapping: mappingOf(context.company) };
      },
      (stored) => [
        ...dropped.map((item) => this.entry('system.payment.approval_dropped', 'success', SYSTEM, source, stored, company, { approver: item.userId, reason: item.reason })),
        this.entry('client.payment.approve', 'success', partyOf(actor.user), source, stored, company, { approvals: `${stored.approvals.length} of ${required}`, approvalsRemaining: String(Math.max(0, required - stored.approvals.length)), status: STATUS[stored.status] }),
        ...(stored.status === 'sending' ? [this.entry('client.payment.send', 'success', partyOf(actor.user), source, stored, company, { key: sha256(stored.sendKey as string).slice(0, 16) })] : []),
      ],
    );
    if (!saved) {
      if ((refusal as ApiError | null)?.options.reason === 'payment_expired') await this.expireDue(actor.company.id);
      throw refusal ?? new ApiError('not_found');
    }
    if (saved.status !== 'sending') return { status: 'awaiting_approval', approvalsRemaining: Math.max(1, required - saved.approvals.length) };
    return this.resultOf(await this.send(saved, source), company);
  }

  private resultOf(record: HeldPaymentRecord, company: CompanyRecord | null): ApprovalResult {
    const remaining = record.status === 'awaiting_approval' ? Math.max(1, requiredNow(record, company) - record.approvals.length) : 0;
    // `unknown`: approved, and the provider has been asked, but its answer has not been seen yet (or does not match).
    return { status: record.status === 'sending' || record.mismatch ? 'unknown' : STATUS[record.status], approvalsRemaining: remaining };
  }

  async reject(actor: Actor, id: string, note: string | null, source: string): Promise<void> {
    const record = await this.forDecision(actor, id);
    if (record.status === 'expired') throw new ApiError('validation', { reason: 'payment_expired' });
    const closed = record.status === 'awaiting_approval' && (await this.close(record.id, 'rejected', actor.user.id, note, (stored, company) => this.entry('client.payment.reject', 'success', partyOf(actor.user), source, stored, company, note ? { note } : {})));
    if (!closed) throw new ApiError('validation', { reason: 'not_awaiting_approval' });
  }

  async cancel(actor: Actor, id: string, source: string): Promise<void> {
    const record = await this.forDecision(actor, id);
    // Its creator, or an administrator of the company. Nobody else.
    if (record.createdBy !== actor.user.id && actor.role !== 'admin') throw new ApiError('forbidden');
    if (record.status === 'expired') throw new ApiError('validation', { reason: 'payment_expired' });
    const closed = record.status === 'awaiting_approval' && (await this.close(record.id, 'cancelled', actor.user.id, null, (stored, company) => this.entry('client.payment.cancel', 'success', partyOf(actor.user), source, stored, company)));
    if (!closed) throw new ApiError('validation', { reason: 'not_awaiting_approval' });
  }

  // --- Sending ---------------------------------------------------------------------------------

  /** The provider account a payment in `sending` belongs to: the one fixed when it was approved, wherever the company points now. */
  private async sendTarget(record: HeldPaymentRecord): Promise<CompanyRecord | null> {
    const company = await this.deps.stores.directory.getCompany(record.companyId);
    return company ? { ...company, ...(record.sendMapping ?? {}) } : null;
  }

  /** What differs between what the provider says it made and what was approved, or null. */
  private mismatchOf(record: HeldPaymentRecord, made: Payment): string | null {
    const wrong = [
      !new Big(made.amount).eq(record.amount) && `amount ${made.amount} instead of ${record.amount}`,
      made.currency !== record.currency && `currency ${made.currency} instead of ${record.currency}`,
      made.beneficiaryId !== record.payee.id && 'a different payee',
    ].filter(Boolean);
    return wrong.length > 0 ? wrong.join('; ') : null;
  }

  private async finish(record: HeldPaymentRecord, status: 'sent' | 'failed', source: string, made: Payment | null, note: string | null): Promise<HeldPaymentRecord> {
    const at = this.deps.now();
    const mismatch = made ? this.mismatchOf(record, made) : null;
    let company: CompanyRecord | null = null;
    const saved = await this.deps.stores.payments.update(
      record.id,
      [],
      (current, context) => {
        company = context.company;
        return current.status === 'sending' ? { ...current, status, statusAt: at, providerPaymentId: made?.id ?? null, note, mismatch, attempts: closeAttempt(current.attempts, status === 'sent' ? 'sent' : 'refused', note), unconfirmedSince: null } : null;
      },
      (stored) => [
        this.entry('system.payment.send_outcome', status === 'sent' ? 'success' : 'failure', SYSTEM, source, stored, company, { outcome: status, attempts: String(stored.attempts?.length ?? 0), ...(note ? { reason: note } : {}) }),
        // The provider made something other than what was approved. Nothing can undo that from here; it must be seen.
        ...(mismatch ? [this.entry('system.payment.send_mismatch', 'failure', SYSTEM, source, stored, company, { mismatch, providerPayment: made?.id ?? '' })] : []),
      ],
    );
    return saved ?? (await this.deps.stores.payments.get(record.id)) ?? record;
  }

  /**
   * Asks the provider to make a payment that is in `sending`, under its one
   * key, on the account fixed at approval.
   *
   * EVERY ATTEMPT IS WRITTEN DOWN BEFORE IT IS MADE, and its outcome after.
   * A refusal is final ONLY when it answers the first and only attempt. Once
   * any attempt has gone unanswered (lost, timed out, or cut off by a crash),
   * that attempt may still reach the provider: a later refusal says nothing
   * about it, so the payment is not called failed. It stays `sending`, is
   * shown as "outcome being checked", and from then on is only LOOKED UP by
   * its key (`settle`), never asked for again.
   */
  private async send(record: HeldPaymentRecord, source: string): Promise<HeldPaymentRecord> {
    const target = await this.sendTarget(record);
    const sendKey = record.sendKey;
    if (!target || !sendKey || record.status !== 'sending' || record.unconfirmedSince || this.inFlight.has(record.id)) return record;
    await this.deps.beforeSend?.(record);
    const at = this.deps.now();
    const started = await this.deps.stores.payments.update(record.id, [], (current) => (current.status === 'sending' && !current.unconfirmedSince ? { ...current, attempts: [...(current.attempts ?? []).slice(-(ATTEMPTS_KEPT - 1)), { at, outcome: 'started' }] } : null));
    if (!started) return (await this.deps.stores.payments.get(record.id)) ?? record;
    this.inFlight.add(record.id);
    try {
      const payment = await this.deps.withProvider(target, (provider) =>
        provider.createPayment({ beneficiaryId: record.payee.id, amount: record.amount, currency: record.currency as Payment['currency'], reference: record.reference, reason: record.reason, idempotencyKey: sendKey }),
      );
      return await this.finish(started, 'sent', source, payment, null);
    } catch (error) {
      const kind = isProviderError(error) ? error.kind : 'error';
      const earlier = (started.attempts ?? []).slice(0, -1);
      if (isProviderError(error) && REFUSALS.includes(error.kind)) {
        // A plain refusal (not enough money, details not accepted) of the first and only attempt: the provider did not make the payment.
        if (earlier.length === 0) return await this.finish(started, 'failed', source, null, kind);
        // Refused NOW, but an earlier attempt was never answered. Not failed: outcome being checked.
        let company: CompanyRecord | null = null;
        const held = await this.deps.stores.payments.update(
          record.id,
          [],
          (current, context) => {
            company = context.company;
            return current.status === 'sending' ? { ...current, attempts: closeAttempt(current.attempts, 'refused', kind), unconfirmedSince: current.unconfirmedSince ?? at, refusal: kind } : null;
          },
          (stored) => this.entry('system.payment.send_outcome', 'failure', SYSTEM, source, stored, company, { outcome: 'unconfirmed', reason: kind, attempts: String(stored.attempts?.length ?? 0), note: 'refused, but an earlier attempt was never answered and may still be made: being checked by key' }),
        );
        return held ?? started;
      }
      // Anything else (no answer, an unreadable one, a busy or signed-out provider): we do not know. It stays `sending`.
      let company: CompanyRecord | null = null;
      const unknown = await this.deps.stores.payments.update(
        record.id,
        [],
        (current, context) => {
          company = context.company;
          return current.status === 'sending' ? { ...current, attempts: closeAttempt(current.attempts, 'unknown', kind) } : null;
        },
        (stored) => this.entry('system.payment.send_outcome', 'failure', SYSTEM, source, stored, company, { outcome: 'unknown', reason: kind, attempts: String(stored.attempts?.length ?? 0) }),
      );
      return unknown ?? started;
    } finally {
      this.inFlight.delete(record.id);
    }
  }
  /** Payments this process is asking the provider to make at this moment. */
  private readonly inFlight = new Set<string>();

  /**
   * Settles a payment in `sending`. If the provider has it under its key, it
   * was sent. If not: a payment whose refusal is unconfirmed is only looked
   * for again, until the reconciliation window has passed without it, and is
   * only then called failed; any other is asked for again with the SAME key,
   * on the SAME account, unless the caller may only look (`lookupOnly`).
   */
  async settle(record: HeldPaymentRecord, source: string, options: { lookupOnly?: boolean } = {}): Promise<HeldPaymentRecord> {
    const target = await this.sendTarget(record);
    const sendKey = record.sendKey;
    if (!target || !sendKey || record.status !== 'sending') return record;
    let found: Payment | null;
    try {
      found = await this.deps.withProvider(target, (provider) => provider.findPaymentByIdempotencyKey(sendKey));
    } catch {
      return record; // Could not ask. It stays as it is and will be looked at again.
    }
    if (found) return this.finish(record, 'sent', source, found, null);
    if (record.unconfirmedSince) {
      const waited = this.deps.now() - record.unconfirmedSince;
      if (waited < this.deps.config.paymentReconcileMs) return record;
      return this.finish(record, 'failed', source, null, `${record.refusal ?? 'refused'}; not found at the provider under its key in ${Math.round(waited / 3_600_000)} hours of checking`);
    }
    if (options.lookupOnly || this.inFlight.has(record.id)) return record;
    return this.send(record, source);
  }

  /**
   * Run at start-up and periodically: expires what has waited too long, and
   * settles every unfinished send. At start-up nothing is in flight (this is
   * the only server process on the database: it holds the lock), so every
   * `sending` payment is settled at once (`all`).
   */
  async sweep(options: { all?: boolean } = {}): Promise<{ expired: number; settled: number }> {
    const expired = await this.expireDue();
    let settled = 0;
    for (const record of await this.deps.stores.payments.list({ status: 'sending' })) {
      if (this.inFlight.has(record.id)) continue;
      if (!options.all && this.deps.now() - lastAttemptAt(record) < SEND_GRACE_MS) continue;
      if ((await this.settle(record, '')).status !== 'sending') settled += 1;
    }
    return { expired, settled };
  }
}
