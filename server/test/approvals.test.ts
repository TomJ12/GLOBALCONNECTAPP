/**
 * Payment approvals enforced by the Global Connect server. Every rule is
 * tested on BOTH providers: the server holds the payment, so the provider
 * makes no difference until the moment it is sent.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'node:test';

import Big from 'big.js';

import { ProviderError } from '../../src/api/errors';
import * as schemas from '../../src/api/schemas';
import { loadConfig } from '../src/config';
import type { UserRole } from '../../src/api/types';
import { AMIRA, BEN, DANA, harness, type Harness, type HarnessOptions } from './helpers';

let h: Harness;
const folders: string[] = [];
afterEach(async () => {
  await h?.close();
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

const HOUR = 60 * 60_000;
interface Person {
  id: string;
  email: string;
  name: string;
  token: string;
  secret: string;
}
interface Company {
  id: string;
  /** The person who is an admin of this company only. */
  admin: string;
  currency: string;
  amount: string;
  label: string;
}
const COMPANIES: Company[] = [
  { id: 'co_northfield', admin: AMIRA, currency: 'GBP', amount: '125.00', label: 'provider A' },
  { id: 'co_castlebrook', admin: BEN, currency: 'EUR', amount: '90.00', label: 'provider B' },
];

/** Signs an existing sample person in and puts their session on the company. */
async function signIn(email: string, companyId: string, known?: { secret: string }): Promise<Person> {
  const secret = known?.secret ?? (await h.activate(email)).secret;
  const reply = await h.login(email, secret);
  assert.equal(reply.status, 200);
  const token = reply.json.token as string;
  if (!reply.json.session) assert.equal((await h.call('POST', '/v1/session/company', { token, body: { companyId } })).status, 200);
  const user = await h.stores.directory.findUserByEmail(email);
  return { id: user?.id as string, email, name: user?.name as string, token, secret };
}
/** A new person in the company with the given role, signed in. */
async function person(name: string, companyId: string, role: UserRole): Promise<Person> {
  const id = `usr_${name.toLowerCase()}`;
  const email = `${name.toLowerCase()}@client.example`;
  await h.stores.directory.saveUser({ id, email, name, passwordHash: null, totpSecret: null, lastTotpStep: 0, recoveryCodeHashes: [], activatedAt: null });
  await h.stores.directory.setMembership({ userId: id, companyId, role });
  return signIn(email, companyId);
}
const stepUp = (who: Person, action: string, payload: unknown) => h.stepUp(who.token, who.secret, action, payload);

/** A payee of the company: the seeded one on provider A, a new one on provider B (which starts with none). */
async function payeeOf(company: Company, creator: Person): Promise<string> {
  if (company.id === 'co_northfield') return 'sample-beneficiary-harbour';
  const payee = { name: 'Atelier Dubois SARL', entityType: 'company', currency: 'EUR', bankCountry: 'FR', iban: 'FR1420041010050500013M02606', bic: 'SMPLFRPP' };
  const created = await h.call('POST', '/v1/beneficiaries', { token: creator.token, body: payee, headers: { 'x-step-up-token': await stepUp(creator, 'beneficiary.create', payee) } });
  assert.equal(created.status, 200);
  return created.json.id as string;
}
let keys = 0;
async function create(company: Company, creator: Person, payee: string, key = `key-held-${String((keys += 1)).padStart(6, '0')}`) {
  const body = { beneficiaryId: payee, amount: company.amount, currency: company.currency, reference: 'INV-1', reason: 'Invoice' };
  const grant = await h.call('POST', '/v1/step-up', { token: creator.token, body: { action: 'payment.create', payload: { ...body, idempotencyKey: key }, code: h.freshCode(creator.secret) } });
  const reply = grant.status === 200 ? await h.call('POST', '/v1/payments', { token: creator.token, body, headers: { 'idempotency-key': key, 'x-step-up-token': grant.json.token as string } }) : grant;
  return { reply, key, id: reply.json?.id as string };
}
/** As `create`, with any part of the request changed. */
async function createWith(company: Company, creator: Person, payee: string, change: { key?: string; amount?: string; reference?: string; reason?: string }) {
  const key = change.key ?? `key-held-${String((keys += 1)).padStart(6, '0')}`;
  const body = { beneficiaryId: payee, amount: change.amount ?? company.amount, currency: company.currency, reference: change.reference ?? 'INV-1', reason: change.reason ?? 'Invoice' };
  const grant = await h.call('POST', '/v1/step-up', { token: creator.token, body: { action: 'payment.create', payload: { ...body, idempotencyKey: key }, code: h.freshCode(creator.secret) } });
  const reply = grant.status === 200 ? await h.call('POST', '/v1/payments', { token: creator.token, body, headers: { 'idempotency-key': key, 'x-step-up-token': grant.json.token as string } }) : grant;
  return { reply, key, id: reply.json?.id as string };
}
/** Approve, reject or cancel, with a fresh code. A person whose role may not even ask for the code gets that refusal back. */
const act = async (who: Person, id: string, action: 'approve' | 'reject' | 'cancel', body?: object) => {
  const grant = await h.call('POST', '/v1/step-up', { token: who.token, body: { action: `payment.${action}`, payload: { paymentId: id }, code: h.freshCode(who.secret) } });
  if (grant.status !== 200) return grant;
  return h.call('POST', `/v1/payments/${id}/${action}`, { token: who.token, body, headers: { 'x-step-up-token': grant.json.token as string } });
};
const reasonOf = (reply: { json: any }) => reply.json?.error?.reason ?? reply.json?.error?.kind;

/** The provider's own records, read straight from the mock: how many payments it has been asked to make for this company. */
function providerPayments(company: Company): any[] {
  if (company.id === 'co_northfield') return (h.providerA as any).accounts.get('sample-contact-0001').mock.state.payments.filter((row: any) => row.unique_request_id);
  return (h.providerB as any).states.get('S00001').paymentOrders.filter((row: any) => row.clientReference);
}
/** Payments made under a key of ours on ANY account of the company's provider. */
function allProviderPayments(company: Company): number {
  if (company.id === 'co_northfield') return [...(h.providerA as any).accounts.values()].flatMap((account: any) => account.mock.state.payments).filter((row: any) => String(row.unique_request_id ?? '').startsWith('gc-')).length;
  return [...(h.providerB as any).states.values()].flatMap((state: any) => state.paymentOrders).filter((row: any) => String(row.clientReference ?? '').startsWith('gc-')).length;
}
/** How many times the provider has been ASKED to make a payment (whatever came of it). */
function createCalls(company: Company): number {
  return mockOf(company).paymentRequests;
}
function providerPayee(company: Company, id: string): any {
  if (company.id === 'co_northfield') return (h.providerA as any).accounts.get('sample-contact-0001').mock.state.beneficiaries.find((row: any) => row.id === id);
  return (h.providerB as any).states.get('S00001').recipients.find((row: any) => row.id === id);
}
const mockOf = (company: Company) => (company.id === 'co_northfield' ? h.providerA : h.providerB);
const record = async (id: string) => (await h.stores.payments.get(id))!;
const heldOf = async (who: Person, id: string) => ((await h.call('GET', '/v1/payments?page=1&perPage=50', { token: who.token })).json.items as any[]).find((item) => item.id === id);
const awaiting = async (who: Person) => (await h.call('GET', '/v1/approvals', { token: who.token })).json.items as any[];
const audit = (action: string) => h.stores.audit.query({ action, limit: 10_000 });

/** A company with a creator, an approver and its sample admin, all signed in, and a payee. */
async function team(company: Company, options: HarnessOptions = {}, overrides: Parameters<typeof harness>[0] = {}) {
  h = await harness(overrides, undefined, options);
  const admin = await signIn(company.admin, company.id);
  const creator = await person('Cara', company.id, 'creator');
  const approver = await person('Abel', company.id, 'approver');
  return { admin, creator, approver, payee: await payeeOf(company, admin) };
}

for (const company of COMPANIES) {
  const on = (name: string) => `${company.label}: ${name}`;

  test(on('a payment is held, not sent; its creator cannot approve it; an approver can, and it reaches the provider exactly once'), async () => {
    const { admin, creator, approver, payee } = await team(company);
    const balances = async () => JSON.stringify(((await h.call('GET', '/v1/balances', { token: admin.token })).json.items as any[]).map((row) => [row.currency, row.amount]));
    const before = await balances();

    const { reply, id, key } = await create(company, creator, payee);
    assert.equal(reply.status, 200);
    const payment = schemas.payment.parse(reply.json);
    // The creator is told: not sent, who can approve, and until when.
    assert.equal(payment.status, 'awaiting_approval');
    assert.match(id, /^hp_/);
    assert.deepEqual(
      [payment.held?.state, payment.held?.createdBy, payment.held?.createdByYou, payment.held?.approvalsRequired, payment.held?.canApprove, payment.held?.canCancel],
      ['awaiting_approval', 'Cara', true, 1, false, true],
    );
    // (Dana Reid is an admin here too, but has not activated her account, so she is not offered as someone who can approve.)
    assert.deepEqual([...(payment.held?.approvers ?? [])].sort(), ['Abel', admin.name].sort());
    assert.equal(Date.parse(payment.held?.expiresAt ?? ''), Date.parse(payment.createdAt) + 48 * HOUR);
    // Nothing went to the provider and no money moved or was set aside.
    assert.equal(providerPayments(company).length, 0);
    assert.equal(await balances(), before);
    // The same key again is the same held payment, not a second one.
    assert.equal((await create(company, creator, payee, key)).id, id);
    assert.equal((await h.stores.payments.list({ companyId: company.id })).length, 1);

    // What each person is shown.
    const forCreator = (await awaiting(creator)).find((item) => item.payment.id === id);
    const forApprover = schemas.pendingApproval.parse((await awaiting(approver)).find((item) => item.payment.id === id));
    assert.equal(forCreator.payment.held.canApprove, false);
    assert.equal(forApprover.payment.held?.canApprove, true);
    assert.equal(forApprover.payment.held?.createdBy, 'Cara');
    assert.equal(forApprover.beneficiary?.id, payee);
    assert.deepEqual(forApprover.steps.map((step) => [step.label, step.status]), [['Created by Cara', 'done'], ['Approval by someone else', 'waiting_for_you']]);
    assert.deepEqual(forCreator.steps.map((step: any) => step.status), ['done', 'waiting']);

    // The creator is refused, whatever their role. (An admin who creates is refused too.)
    const own = await act(creator, id, 'approve');
    assert.equal(own.status, 403);
    const mine = await create(company, admin, payee);
    const refused = await act(admin, mine.id, 'approve');
    assert.deepEqual([refused.status, refused.json], [403, { error: { kind: 'forbidden', reason: 'creator_cannot_approve' } }]);
    assert.equal(providerPayments(company).length, 0);

    // Roles: a creator cannot approve or reject anyone's payment; an approver cannot create or cancel.
    assert.equal((await act(creator, mine.id, 'approve')).status, 403);
    assert.equal((await act(creator, mine.id, 'reject')).status, 403);
    assert.equal((await create(company, approver, payee)).reply.status, 403);
    assert.equal((await act(approver, id, 'cancel')).status, 403);
    assert.equal((await record(mine.id)).status, 'awaiting_approval');
    // No code, no approval.
    assert.equal(reasonOf(await h.call('POST', `/v1/payments/${id}/approve`, { token: approver.token })), 'step_up_required');

    // An approver approves: it is sent, once.
    const approved = await act(approver, id, 'approve');
    assert.deepEqual([approved.status, approved.json], [200, { status: 'processing', approvalsRemaining: 0 }]);
    assert.equal(providerPayments(company).length, 1);
    const stored = await record(id);
    assert.deepEqual([stored.status, stored.approvals.map((item) => item.userId), stored.approvals[0]?.at], ['sent', [approver.id], h.clock.now]);
    assert.notEqual(await balances(), before);
    // Approving again, or anyone else approving, sends nothing more.
    assert.deepEqual((await act(approver, id, 'approve')).json, { status: 'processing', approvalsRemaining: 0 });
    assert.equal(reasonOf(await act(admin, id, 'approve')), 'not_awaiting_approval');
    assert.equal(providerPayments(company).length, 1);
    // It has left the waiting list, and the creator's own key now finds the payment the provider made.
    assert.ok(!(await awaiting(approver)).some((item) => item.payment.id === id));
    const found = (await h.call('GET', `/v1/payments/by-key/${key}`, { token: creator.token })).json;
    assert.equal(found.id, stored.providerPaymentId);
    assert.equal(found.held, undefined);

    // Everything is in the audit log with the amount, currency and payee, and nothing secret.
    const of = async (action: string) => (await audit(action)).filter((entry) => entry.detail.payment === id);
    const [made] = await of('client.payment.create');
    assert.deepEqual([made?.actor.label, made?.outcome, made?.detail.amount, made?.detail.currency, made?.detail.payee, made?.detail.held], [creator.email, 'success', company.amount, company.currency, payee, 'yes']);
    const approvals = await of('client.payment.approve');
    // (The approval is written once, with the change it made; asking again changed nothing and adds no second "approved".)
    assert.deepEqual(approvals.map((entry) => [entry.actor.label, entry.outcome, entry.detail.reason ?? entry.detail.status]).reverse(), [[approver.email, 'failure', 'step_up_required'], [approver.email, 'success', 'processing'], [admin.email, 'failure', 'not_awaiting_approval']]);
    // The creator's own attempt is on record too, as a refusal.
    assert.deepEqual((await audit('client.payment.approve')).filter((entry) => entry.detail.payment === mine.id && entry.actor.label === admin.email).map((entry) => [entry.outcome, entry.detail.reason, entry.detail.amount]), [['failure', 'creator_cannot_approve', company.amount]]);
    for (const action of ['client.payment.send', 'system.payment.send_outcome']) {
      const entries = await of(action);
      assert.equal(entries.length, 1, action);
      assert.deepEqual([entries[0]?.outcome, entries[0]?.detail.amount, entries[0]?.detail.currency, entries[0]?.detail.payee, entries[0]?.target?.id], ['success', company.amount, company.currency, payee, company.id], action);
    }
    const text = JSON.stringify(await h.stores.audit.query({ limit: 10_000 }));
    for (const secret of [creator.secret, approver.secret, creator.token, approver.token, key, 'FR1420041010050500013M02606']) assert.ok(!text.includes(secret));
    // No provider name ever reached the app.
    assert.doesNotMatch(h.bodies.join('\n'), /currencycloud|equals/i);
  });

  test(on('with two approvals required, two different people must approve, neither of them the creator'), async () => {
    const { admin, creator, approver, payee } = await team(company);
    await h.policy(company.id, 2);
    const { reply, id } = await create(company, creator, payee);
    assert.equal(reply.json.held.approvalsRequired, 2);

    const first = await act(approver, id, 'approve');
    assert.deepEqual(first.json, { status: 'awaiting_approval', approvalsRemaining: 1 });
    assert.equal(providerPayments(company).length, 0);
    // The same person cannot give the second approval, and the creator still cannot give any.
    const again = await act(approver, id, 'approve');
    assert.deepEqual([again.status, again.json.error.reason], [403, 'already_approved']);
    assert.equal(reasonOf(await act(creator, id, 'approve')), 'forbidden');
    assert.equal(providerPayments(company).length, 0);
    const waiting = (await awaiting(admin)).find((item) => item.payment.id === id);
    assert.deepEqual(waiting.steps.map((step: any) => [step.label, step.status]), [['Created by Cara', 'done'], ['Approved by Abel', 'done'], ['Approval 2 of 2', 'waiting_for_you']]);
    assert.equal((await awaiting(approver)).find((item) => item.payment.id === id).payment.held.canApprove, false);

    const second = await act(admin, id, 'approve');
    assert.deepEqual(second.json, { status: 'processing', approvalsRemaining: 0 });
    assert.equal(providerPayments(company).length, 1);
    assert.deepEqual((await record(id)).approvals.map((item) => item.userId), [approver.id, admin.id]);
    assert.equal((await audit('client.payment.approve')).filter((entry) => entry.detail.payment === id && entry.outcome === 'success').length, 2);
  });

  test(on('a payee whose bank details changed, or who was removed, after creation blocks the approval for good'), async () => {
    const { creator, approver, payee } = await team(company);
    const changed = await create(company, creator, payee);
    const removed = await create(company, creator, payee);
    const untouched = await create(company, creator, payee);
    assert.equal((await act(approver, untouched.id, 'approve')).status, 200);

    // Somebody edits the payee at the provider: the account the money would go to is no longer the one that was reviewed.
    const row = providerPayee(company, payee);
    if (company.id === 'co_northfield') row.account_number = '99999999';
    else row.name = 'Atelier Dubois Holdings';
    const refused = await act(approver, changed.id, 'approve');
    assert.deepEqual([refused.status, refused.json], [400, { error: { kind: 'validation', reason: 'payee_changed' } }]);
    assert.deepEqual([(await record(changed.id)).status, (await record(changed.id)).approvals], ['payee_changed', []]);
    // Final: it cannot be approved later even if the details are put back.
    if (company.id === 'co_northfield') row.account_number = '00000000';
    else row.name = 'Atelier Dubois SARL';
    assert.equal(reasonOf(await act(approver, changed.id, 'approve')), 'not_awaiting_approval');
    const shown = await heldOf(creator, changed.id);
    assert.deepEqual([shown.status, shown.held.state], ['cancelled', 'payee_changed']);
    assert.equal((await audit('system.payment.blocked')).filter((entry) => entry.detail.payment === changed.id)[0]?.detail.reason, 'payee_changed');

    // The payee disappears altogether.
    row.id = 'someone-else';
    assert.equal(reasonOf(await act(approver, removed.id, 'approve')), 'payee_changed');
    assert.equal((await record(removed.id)).status, 'payee_changed');
    assert.equal(providerPayments(company).length, 1, 'only the untouched one was sent');
  });

  test(on('a creator who was disabled or lost the role blocks approval; an approver disabled mid-request approves nothing'), async () => {
    let disable: string | null = null;
    const { admin, creator, approver, payee } = await team(company, {
      storeLatency: true,
      // The approver's account is disabled after the request has passed every earlier check, just before the decision is stored.
      storeHook: (operation) => {
        if (operation === 'update' && disable) h.stores.db.run('UPDATE users SET disabled_at = 1 WHERE id = ?', disable);
      },
    });
    const first = await create(company, creator, payee);
    const second = await create(company, creator, payee);
    const third = await create(company, admin, payee);

    disable = approver.id;
    const late = await act(approver, third.id, 'approve');
    disable = null;
    assert.equal(late.status, 403);
    assert.deepEqual([(await record(third.id)).status, (await record(third.id)).approvals], ['awaiting_approval', []]);

    // The creator is disabled by operations after creating the payment.
    await h.stores.directory.updateUser(creator.id, (user) => ({ ...user, disabledAt: h.clock.now }));
    const refused = await act(admin, first.id, 'approve');
    assert.deepEqual([refused.status, refused.json.error.reason], [400, 'creator_unavailable']);
    // Enabled again but no longer allowed to create payments: still blocked.
    await h.stores.directory.updateUser(creator.id, (user) => ({ ...user, disabledAt: null }));
    await h.stores.directory.setMembership({ userId: creator.id, companyId: company.id, role: 'approver' });
    assert.equal(reasonOf(await act(admin, second.id, 'approve')), 'creator_unavailable');
    // Removed from the company altogether.
    await h.stores.directory.removeMembership(creator.id, company.id);
    assert.equal(reasonOf(await act(admin, second.id, 'approve')), 'creator_unavailable');
    assert.equal(providerPayments(company).length, 0);
    // Such a payment can still be rejected.
    assert.equal((await act(admin, first.id, 'reject')).status, 200);
  });

  test(on('a payment expires 48 hours after it was created, at decision time and by the sweep'), async () => {
    const { admin, creator, approver, payee } = await team(company, {}, { stepUpTtlMs: 10 * 60_000 });
    const inTime = await create(company, creator, payee);
    const tooLate = await create(company, creator, payee);
    const swept = await create(company, creator, payee);
    const expiry = async (id: string) => (await record(id)).expiresAt;
    assert.equal(await expiry(tooLate.id), (await record(tooLate.id)).createdAt + 48 * HOUR);

    // Shortly before: fresh sessions (the first ones are long over) and a code check for each decision.
    h.clock.now = (await expiry(inTime.id)) - 5 * 60_000;
    const later = await signIn(approver.email, company.id, approver);
    const laterAdmin = await signIn(admin.email, company.id, admin);
    const approve = async (id: string) => {
      const token = await stepUp(later, 'payment.approve', { paymentId: id });
      return (at: number) => {
        h.clock.now = at;
        return h.call('POST', `/v1/payments/${id}/approve`, { token: later.token, headers: { 'x-step-up-token': token } });
      };
    };
    const [first, second] = [await approve(inTime.id), await approve(tooLate.id)];
    // One second before its 48 hours are up: approved and sent.
    assert.deepEqual((await first((await expiry(inTime.id)) - 1000)).json, { status: 'processing', approvalsRemaining: 0 });
    // At 48 hours exactly: refused, and the payment is expired for good.
    const refused = await second(await expiry(tooLate.id));
    assert.deepEqual([refused.status, refused.json], [400, { error: { kind: 'validation', reason: 'payment_expired' } }]);
    assert.equal((await record(tooLate.id)).status, 'expired');
    assert.deepEqual((await audit('system.payment.expire')).filter((entry) => entry.detail.payment === tooLate.id).map((entry) => [entry.actor.type, entry.detail.amount, entry.detail.currency, entry.detail.payee]), [['system', company.amount, company.currency, payee]]);

    // Nobody touches the third one: the periodic sweep expires it, at its time and not before.
    h.clock.now = (await expiry(swept.id)) - 1;
    assert.deepEqual(await h.held.sweep(), { expired: 0, settled: 0 });
    assert.equal((await record(swept.id)).status, 'awaiting_approval');
    h.clock.now = await expiry(swept.id);
    assert.deepEqual(await h.held.sweep(), { expired: 1, settled: 0 });
    assert.equal((await record(swept.id)).status, 'expired');
    assert.equal(reasonOf(await act(laterAdmin, swept.id, 'approve')), 'payment_expired');
    assert.equal(reasonOf(await act(laterAdmin, swept.id, 'reject')), 'payment_expired');
    assert.equal(reasonOf(await act(laterAdmin, swept.id, 'cancel')), 'payment_expired');
    const shown = await heldOf(laterAdmin, swept.id);
    assert.deepEqual([shown.status, shown.held.state, shown.held.canApprove, shown.held.canCancel], ['cancelled', 'expired', false, false]);
    assert.equal(providerPayments(company).length, 1, 'only the one approved in time');
  });

  test(on('cancel and reject are final; only the creator or a company admin can cancel; a held payment cannot be edited'), async () => {
    const { admin, creator, approver, payee } = await team(company);
    const other = await person('Cleo', company.id, 'creator');
    const cancelled = await create(company, creator, payee);
    const byAdmin = await create(company, creator, payee);
    const rejected = await create(company, creator, payee);

    // Another creator cannot cancel it; its creator can, with a code.
    assert.equal((await act(other, cancelled.id, 'cancel')).status, 403);
    assert.equal(reasonOf(await h.call('POST', `/v1/payments/${cancelled.id}/cancel`, { token: creator.token })), 'step_up_required');
    assert.equal((await record(cancelled.id)).status, 'awaiting_approval');
    assert.deepEqual((await act(creator, cancelled.id, 'cancel')).json, { ok: true });
    assert.deepEqual([(await record(cancelled.id)).status, (await record(cancelled.id)).closedBy], ['cancelled', creator.id]);
    assert.equal((await act(admin, byAdmin.id, 'cancel')).status, 200);
    // An approver rejects, with a reason.
    assert.equal((await act(approver, rejected.id, 'reject', { reason: 'Wrong invoice' })).status, 200);
    assert.deepEqual([(await record(rejected.id)).status, (await record(rejected.id)).note, (await record(rejected.id)).closedBy], ['rejected', 'Wrong invoice', approver.id]);
    assert.equal((await audit('client.payment.reject')).find((entry) => entry.detail.payment === rejected.id)?.detail.note, 'Wrong invoice');
    assert.equal((await act(approver, byAdmin.id, 'reject', { reason: 'x'.repeat(201) })).status, 400);

    // Final: nothing can be done to any of them afterwards, and nothing was sent.
    for (const id of [cancelled.id, byAdmin.id, rejected.id]) {
      for (const [who, action] of [[approver, 'approve'], [admin, 'approve'], [approver, 'reject'], [creator, 'cancel'], [admin, 'cancel']] as const) {
        assert.equal(reasonOf(await act(who, id, action)), 'not_awaiting_approval', `${action} after it was closed`);
      }
    }
    assert.equal(providerPayments(company).length, 0);
    assert.deepEqual((await awaiting(approver)).filter((item) => item.payment.held), []);
    // There is no way to change a held payment: no such route exists.
    for (const method of ['PUT', 'PATCH', 'DELETE', 'POST'] as const) {
      const reply = await h.app.inject({ method, url: `/v1/payments/${rejected.id}`, headers: { authorization: `Bearer ${creator.token}` }, payload: { amount: '1.00' } });
      assert.equal(reply.statusCode, 404, method);
    }
  });

  test(on('a stricter rule bites on payments already waiting; a looser one does not; 0 sends at once as before'), async () => {
    const { admin, creator, approver, payee } = await team(company);
    const underOne = await create(company, creator, payee);
    await h.policy(company.id, 2);
    const underTwo = await create(company, creator, payee);
    // The earlier payment was created when one approval was enough. The rule is now two, and it needs two.
    assert.equal((await heldOf(approver, underOne.id)).held.approvalsRequired, 2);
    assert.deepEqual((await act(approver, underOne.id, 'approve')).json, { status: 'awaiting_approval', approvalsRemaining: 1 });
    assert.equal(providerPayments(company).length, 0);
    assert.deepEqual((await act(admin, underOne.id, 'approve')).json, { status: 'processing', approvalsRemaining: 0 });
    assert.equal(providerPayments(company).length, 1);

    await h.policy(company.id, 0);
    // Created with no rule: straight to the provider, exactly as before approvals existed. Not held.
    const direct = await create(company, creator, payee);
    assert.equal(direct.reply.status, 200);
    assert.notEqual(direct.reply.json.status, 'awaiting_approval');
    assert.equal(direct.reply.json.held, undefined);
    assert.doesNotMatch(direct.id, /^hp_/);
    assert.equal(providerPayments(company).length, 2);
    assert.equal((await h.stores.payments.list({ companyId: company.id })).length, 2);
    // The one created under two approvals still needs both, though the rule is now 0: loosening never releases a waiting payment.
    assert.equal((await heldOf(approver, underTwo.id)).held.approvalsRequired, 2);
    assert.deepEqual((await act(approver, underTwo.id, 'approve')).json, { status: 'awaiting_approval', approvalsRemaining: 1 });
    assert.equal(providerPayments(company).length, 2);
    // A rule raised between the first approval and the last counts at the last, and a rule lowered again does not undo it.
    await h.policy(company.id, 1);
    assert.equal((await heldOf(admin, underTwo.id)).held.approvalsRequired, 2);
    assert.deepEqual((await act(admin, underTwo.id, 'approve')).json, { status: 'processing', approvalsRemaining: 0 });
    assert.equal(providerPayments(company).length, 3);
  });

  test(on('two final approvals at the same moment send the payment once'), async () => {
    const { admin, creator, approver, payee } = await team(company, { storeLatency: true });
    const { id } = await create(company, creator, payee);
    const dana = await signIn(DANA, company.id);
    const grants = async (paymentId: string) => {
      const granted: { who: Person; token: string }[] = [];
      for (const who of [approver, admin, dana]) granted.push({ who, token: await stepUp(who, 'payment.approve', { paymentId }) });
      return granted;
    };
    const tokens = await grants(id);
    const replies = await Promise.all(tokens.map(({ who, token }) => h.call('POST', `/v1/payments/${id}/approve`, { token: who.token, headers: { 'x-step-up-token': token } })));
    assert.deepEqual(replies.map((reply) => reply.status).sort(), [200, 400, 400]);
    assert.deepEqual(replies.filter((reply) => reply.status === 400).map(reasonOf), ['not_awaiting_approval', 'not_awaiting_approval']);
    assert.equal(providerPayments(company).length, 1);
    assert.equal((await record(id)).approvals.length, 1);

    // With two required: three people at once. Exactly two approvals are recorded and one payment is made.
    await h.policy(company.id, 2);
    const two = await create(company, creator, payee);
    const again = await grants(two.id);
    const results = await Promise.all(again.map(({ who, token }) => h.call('POST', `/v1/payments/${two.id}/approve`, { token: who.token, headers: { 'x-step-up-token': token } })));
    assert.deepEqual(results.map((reply) => reply.status).sort(), [200, 200, 400]);
    assert.equal((await record(two.id)).approvals.length, 2);
    assert.equal(providerPayments(company).length, 2);
  });

  test(on('a crash between "approved" and "sent": after the restart the payment is settled by its key and exists once'), async () => {
    const folder = mkdtempSync(path.join(tmpdir(), 'gc-held-'));
    folders.push(folder);
    const databasePath = path.join(folder, 'data.sqlite');
    let crash = true;
    const { creator, approver, payee } = await team(company, {
      databasePath,
      beforeSend: () => {
        if (crash) throw new Error('the process died here');
      },
    });
    const { id } = await create(company, creator, payee);
    const waiting = await create(company, creator, payee);
    const died = await act(approver, id, 'approve');
    assert.equal(died.status, 500);
    // The approval and the decision to send are on disk; the provider was never asked.
    const left = await record(id);
    assert.deepEqual([left.status, left.approvals.length, typeof left.sendKey], ['sending', 1, 'string']);
    assert.equal(providerPayments(company).length, 0);
    const entries = h.stores.verifyAudit().entries;

    // RESTART: a new server process on the same database, talking to the same provider.
    const providers = { a: h.providerA, b: h.providerB };
    const clock = h.clock;
    await h.close();
    crash = false;
    h = await harness({}, undefined, { databasePath, providers, clock });
    // The session, the held payments and the audit chain are all still there.
    assert.equal((await h.call('GET', '/v1/company', { token: approver.token })).status, 200);
    assert.equal((await record(waiting.id)).status, 'awaiting_approval');
    assert.deepEqual([h.stores.verifyAudit().ok, h.stores.verifyAudit().entries >= entries], [true, true]);
    // Until it is settled nothing else can be done to it...
    const settledFirst = await act(approver, waiting.id, 'approve');
    assert.equal(settledFirst.status, 200);
    // ...and what the server does at start-up settles it: exactly one payment at the provider, under the held payment's key.
    assert.deepEqual(await h.held.sweep({ all: true }), { expired: 0, settled: 1 });
    assert.deepEqual([(await record(id)).status, (await record(id)).sendKey], ['sent', left.sendKey]);
    assert.equal(providerPayments(company).length, 2);
    assert.deepEqual(await h.held.sweep({ all: true }), { expired: 0, settled: 0 });
    assert.equal(providerPayments(company).length, 2);
    assert.equal((await audit('system.payment.send_outcome')).filter((entry) => entry.detail.payment === id && entry.detail.outcome === 'sent').length, 1);
    assert.equal(h.stores.verifyAudit().ok, true);
  });

  test(on('a lost answer, a request that lands late, and no answer at all: one payment, never a second key'), async () => {
    const { admin, creator, approver, payee } = await team(company);
    const mock = mockOf(company);
    const keysSeen = () => new Set(providerPayments(company).map((row: any) => row.unique_request_id ?? row.clientReference));

    // 1. The provider makes the payment but its answer is lost.
    const lost = await create(company, creator, payee);
    mock.paymentFault = 'lost_response';
    const unknown = await act(approver, lost.id, 'approve');
    assert.deepEqual([unknown.status, unknown.json], [200, { status: 'unknown', approvalsRemaining: 0 }]);
    assert.equal((await record(lost.id)).status, 'sending');
    // Neither sent nor failed as far as anyone can tell: the people looking at it are told not to create it again.
    const shown = await heldOf(creator, lost.id);
    assert.deepEqual([shown.status, shown.held.state], ['unknown', 'checking']);
    assert.equal(schemas.payment.safeParse(shown).success, true);
    assert.equal((await audit('system.payment.send_outcome')).find((entry) => entry.detail.payment === lost.id)?.detail.outcome, 'unknown');
    // Whatever anyone tries next, the unfinished send is settled first: found under its key, so it is "sent" and nothing is re-sent.
    for (const [who, action] of [[admin, 'reject'], [creator, 'cancel'], [admin, 'approve']] as const) assert.equal(reasonOf(await act(who, lost.id, action)), 'not_awaiting_approval');
    assert.equal((await record(lost.id)).status, 'sent');
    assert.equal(providerPayments(company).length, 1);

    // 2. No answer, and the request has not reached the provider yet.
    const late = await create(company, creator, payee);
    mock.paymentFault = 'applied_late';
    assert.deepEqual((await act(approver, late.id, 'approve')).json, { status: 'unknown', approvalsRemaining: 0 });
    assert.equal(providerPayments(company).length, 1);
    // The sweep leaves a send that only just started alone, then settles it: not found under its key, so asked again with the SAME key.
    assert.deepEqual(await h.held.sweep(), { expired: 0, settled: 0 });
    h.clock.advance(31_000);
    assert.deepEqual(await h.held.sweep(), { expired: 0, settled: 1 });
    assert.equal((await record(late.id)).status, 'sent');
    assert.equal(providerPayments(company).length, 2);
    // Now the first request finally lands. The provider already has that key: still two payments.
    await mock.releaseLate();
    assert.equal(providerPayments(company).length, 2);

    // 3. The request never arrives at all, and the approver simply asks again.
    const never = await create(company, creator, payee);
    // (Every permission is obtained first: in these tests getting a code moves the clock on.)
    const permits: [Person, string, string][] = [];
    for (const [who, action] of [[approver, 'approve'], [approver, 'approve'], [admin, 'reject']] as const) permits.push([who, action, await stepUp(who, `payment.${action}`, { paymentId: never.id })]);
    const decide = ([who, action, token]: [Person, string, string]) => h.call('POST', `/v1/payments/${never.id}/${action}`, { token: who.token, headers: { 'x-step-up-token': token } });
    mock.paymentFault = 'no_answer';
    assert.equal((await decide(permits[0] as [Person, string, string])).json.status, 'unknown');
    assert.equal(providerPayments(company).length, 2);
    // N2: asking again straight away only LOOKS for it under its key; the provider is not asked a second time while
    // the first request may still be on its way.
    const calls = createCalls(company);
    assert.deepEqual((await decide(permits[1] as [Person, string, string])).json, { status: 'unknown', approvalsRemaining: 0 });
    for (const permit of permits.slice(2)) assert.equal(reasonOf(await decide(permit)), 'not_awaiting_approval');
    assert.deepEqual(await h.held.sweep(), { expired: 0, settled: 0 });
    assert.equal(createCalls(company), calls, 'no second create call within the grace period');
    assert.equal(providerPayments(company).length, 2);
    // Once the first attempt is old enough to have been given up, asking again does ask the provider, with the same key.
    h.clock.advance(31_000);
    assert.deepEqual((await act(approver, never.id, 'approve')).json, { status: 'processing', approvalsRemaining: 0 });
    assert.equal(createCalls(company), calls + 1);
    assert.equal(providerPayments(company).length, 3);
    assert.deepEqual((await record(never.id)).attempts?.map((item) => item.outcome), ['unknown', 'sent']);

    // Three payments, three keys, each the one derived from its held payment.
    assert.deepEqual([...keysSeen()].sort(), (await Promise.all([lost, late, never].map(async (item) => (await record(item.id)).sendKey))).sort());
    assert.equal((await audit('system.payment.send_outcome')).filter((entry) => entry.detail.outcome === 'sent').length, 3);
  });

  test(on('a send the provider plainly refuses is final and is not retried'), async () => {
    const { creator, approver, payee } = await team(company, {
      // The payee vanishes at the provider after the last check and before the send.
      beforeSend: () => {
        providerPayee(company, payee).id = 'gone';
      },
    });
    const { id } = await create(company, creator, payee);
    const reply = await act(approver, id, 'approve');
    assert.deepEqual([reply.status, reply.json], [200, { status: 'failed', approvalsRemaining: 0 }]);
    assert.equal((await record(id)).status, 'failed');
    assert.deepEqual(await h.held.sweep({ all: true }), { expired: 0, settled: 0 });
    assert.equal(providerPayments(company).length, 0);
    assert.equal((await audit('system.payment.send_outcome')).find((entry) => entry.detail.payment === id)?.outcome, 'failure');
  });

  test(on('not enough money at the last approval: refused, nothing recorded, nothing sent'), async () => {
    const { creator, approver, payee } = await team(company);
    const big = { ...company, amount: '99999999.00' };
    const { id } = await create(big, creator, payee);
    const refused = await act(approver, id, 'approve');
    assert.deepEqual([refused.status, refused.json.error.kind], [422, 'insufficient_funds']);
    assert.deepEqual([(await record(id)).status, (await record(id)).approvals], ['awaiting_approval', []]);
    assert.equal(providerPayments(company).length, 0);
  });

  // --- Review of fe9d053 ---------------------------------------------------------------------------------

  test(on('H1: two approvals at the same moment on a two-approval payment each check the payee: a changed payee is never sent'), async () => {
    for (const storeLatency of [true, false]) {
      const { admin, creator, approver, payee } = await team(company, { storeLatency });
      await h.policy(company.id, 2);
      const { id } = await create(company, creator, payee);
      // The payee's bank details change at the provider after the payment was created.
      const row = providerPayee(company, payee);
      if (company.id === 'co_northfield') row.account_number = '99999999';
      else row.accountIdentifier = { ...row.accountIdentifier, iban: 'FR7630006000011234567890189' };
      // Neither request is "the last one" when it starts, so neither used to look at the payee.
      const granted = [];
      for (const who of [approver, admin]) granted.push({ who, token: await stepUp(who, 'payment.approve', { paymentId: id }) });
      const replies = await Promise.all(granted.map(({ who, token }) => h.call('POST', `/v1/payments/${id}/approve`, { token: who.token, headers: { 'x-step-up-token': token } })));
      assert.deepEqual(replies.map((reply) => reply.status), [400, 400], `latency ${String(storeLatency)}`);
      assert.ok(replies.map(reasonOf).includes('payee_changed'));
      assert.deepEqual([(await record(id)).status, (await record(id)).approvals], ['payee_changed', []]);
      assert.equal(providerPayments(company).length, 0);
      await h.close();
    }
  });

  test(on('H1: the first of two approvals is refused, and nothing recorded, when the payee has changed or the money is not there at the last'), async () => {
    const { admin, creator, approver, payee } = await team(company);
    await h.policy(company.id, 2);
    const first = await create(company, creator, payee);
    const row = providerPayee(company, payee);
    const before = JSON.stringify(row);
    row.name = `${row.name as string} Holdings`;
    assert.equal(reasonOf(await act(approver, first.id, 'approve')), 'payee_changed');
    assert.deepEqual((await record(first.id)).approvals, []);
    Object.assign(row, JSON.parse(before));
    // A payment may only leave for the provider through a request that itself found the money there.
    const big = await createWith(company, creator, payee, { amount: '99999999.00' });
    assert.equal(big.reply.status, 200, JSON.stringify(big.reply.json));
    assert.deepEqual((await act(approver, big.id, 'approve')).json, { status: 'awaiting_approval', approvalsRemaining: 1 });
    assert.equal((await act(admin, big.id, 'approve')).json.error.kind, 'insufficient_funds');
    assert.deepEqual([(await record(big.id)).status, (await record(big.id)).approvals.length], ['awaiting_approval', 1]);
    assert.equal(providerPayments(company).length, 0);
  });

  test(on('H2: any change to what the provider holds about the payee blocks the approval: every routing code, and fields this code has never heard of'), async () => {
    const { creator, approver, payee } = await team(company);
    const row = providerPayee(company, payee);
    const original = JSON.stringify(row);
    const changes: [string, (target: any) => void][] =
      company.id === 'co_northfield'
        ? [
            ['a routing code that is not a sort code', (target) => Object.assign(target, { routing_code_type_1: 'bsb_code', routing_code_value_1: '999999' })],
            ['a second routing code', (target) => Object.assign(target, { routing_code_type_2: 'aba', routing_code_value_2: '021000021' })],
            ['the bank name', (target) => Object.assign(target, { bank_name: 'Another Bank' })],
            ['the bank country', (target) => Object.assign(target, { bank_country: 'AU' })],
            ['the account holder', (target) => Object.assign(target, { bank_account_holder_name: 'Somebody Else' })],
            ['the payment types', (target) => Object.assign(target, { payment_types: ['priority'] })],
            ['a field added by the provider later', (target) => Object.assign(target, { intermediary_routing_code: 'X1' })],
            ['letter case of the IBAN', (target) => Object.assign(target, { iban: 'gb00ATTACKER' })],
          ]
        : [
            ['the bank identifier', (target) => Object.assign(target, { bankIdentifier: 'AGRIFRPP' })],
            ['the bank country', (target) => Object.assign(target, { bankAddress: { countryCode: 'DE' } })],
            ['a nested field added by the provider later', (target) => Object.assign(target, { bankAddress: { ...target.bankAddress, branchCode: '0042' } })],
            ['a field added by the provider later', (target) => Object.assign(target, { intermediaryBank: { bic: 'CHASUS33' } })],
            ['the recipient type', (target) => Object.assign(target, { type: 'individual' })],
          ];
    for (const [what, change] of changes) {
      for (const key of Object.keys(row)) delete row[key];
      Object.assign(row, JSON.parse(original));
      const { id } = await create(company, creator, payee);
      change(row);
      assert.equal(reasonOf(await act(approver, id, 'approve')), 'payee_changed', what);
      assert.equal((await record(id)).status, 'payee_changed', what);
    }
    // What is NOT a change: the provider's own timestamps, spacing, and empty values coming or going.
    for (const key of Object.keys(row)) delete row[key];
    Object.assign(row, JSON.parse(original));
    const { id } = await create(company, creator, payee);
    Object.assign(row, company.id === 'co_northfield' ? { updated_at: '2031-01-01T00:00:00+00:00', bank_name: ` ${row.bank_name ?? ''} `, routing_code_type_2: '', routing_code_value_2: null } : { updatedAt: '2031-01-01T00:00:00Z', name: ` ${row.name as string} `, notes: '', tags: [] });
    assert.deepEqual((await act(approver, id, 'approve')).json, { status: 'processing', approvalsRemaining: 0 });
    assert.equal(providerPayments(company).length, 1);
    // The stored digest is a hash: nothing of the payee's bank details is kept in it.
    assert.match((await record(id)).payeeDigest ?? '', /^[0-9a-f]{64}$/);
  });

  test(on('M1: an earlier approval stops counting when the person who gave it is disabled, removed or no longer an approver'), async () => {
    const { admin, creator, approver, payee } = await team(company);
    const dana = await signIn(DANA, company.id);
    await h.policy(company.id, 2);
    const undo: [string, () => Promise<unknown>, () => Promise<unknown>][] = [
      ['account disabled', () => h.stores.directory.updateUser(approver.id, (user) => ({ ...user, disabledAt: h.clock.now })), () => h.stores.directory.updateUser(approver.id, (user) => ({ ...user, disabledAt: null }))],
      ['removed from the company', () => h.stores.directory.removeMembership(approver.id, company.id), () => h.stores.directory.setMembership({ userId: approver.id, companyId: company.id, role: 'approver' })],
      ['no longer an approver', () => h.stores.directory.setMembership({ userId: approver.id, companyId: company.id, role: 'creator' }), () => h.stores.directory.setMembership({ userId: approver.id, companyId: company.id, role: 'approver' })],
    ];
    let sent = 0;
    for (const [reason, change, restore] of undo) {
      const { id } = await create(company, creator, payee);
      assert.deepEqual((await act(approver, id, 'approve')).json, { status: 'awaiting_approval', approvalsRemaining: 1 }, reason);
      await change();
      // What would have been the second and last approval is now the only one that counts.
      assert.deepEqual((await act(admin, id, 'approve')).json, { status: 'awaiting_approval', approvalsRemaining: 1 }, reason);
      assert.equal(providerPayments(company).length, sent, reason);
      const stored = await record(id);
      assert.deepEqual(stored.approvals.map((item) => item.userId), [admin.id], reason);
      assert.deepEqual(stored.droppedApprovals?.map((item) => [item.userId, item.reason]), [[approver.id, reason]]);
      // Why it was dropped is on record, and the people looking at the payment see one approval, not two.
      const dropped = (await audit('system.payment.approval_dropped')).filter((entry) => entry.detail.payment === id);
      assert.deepEqual(dropped.map((entry) => [entry.detail.approver, entry.detail.reason, entry.actor.type]), [[approver.id, reason, 'system']]);
      assert.deepEqual((await heldOf(dana, id)).held.approvals.length, 1);
      // Someone who can still approve completes it.
      assert.deepEqual((await act(dana, id, 'approve')).json, { status: 'processing', approvalsRemaining: 0 }, reason);
      sent += 1;
      assert.equal(providerPayments(company).length, sent);
      await restore();
    }
  });

  test(on('M6, M2: a reused key returns the original only to its creator with the same request; across a policy change it never makes a second payment'), async () => {
    const { admin, creator, approver, payee } = await team(company);
    const original = await create(company, creator, payee);
    assert.equal(original.reply.status, 200);
    const refusal = { error: { kind: 'validation', fields: ['idempotencyKey'] } };
    // The same request again: the same held payment, and the audit entry carries the amount that is STORED.
    const same = await createWith(company, creator, payee, { key: original.key });
    assert.deepEqual([same.reply.status, same.id], [200, original.id]);
    // The same key with anything different in the request is refused, and says nothing about the payment it belongs to.
    for (const change of [{ amount: '9999.00' }, { reference: 'INV-2' }, { reason: 'Other' }]) {
      const reused = await createWith(company, creator, payee, { key: original.key, ...change });
      assert.deepEqual([reused.reply.status, reused.reply.json], [400, refusal], JSON.stringify(change));
    }
    // Another member of the company with the same key, even with the very same request: refused in the same words.
    const other = await createWith(company, admin, payee, { key: original.key });
    assert.deepEqual([other.reply.status, other.reply.json], [400, refusal]);
    assert.deepEqual([(await record(original.id)).amount, (await record(original.id)).createdBy], [company.amount, creator.id]);
    assert.equal((await h.stores.payments.list({ companyId: company.id })).length, 1);
    const entries = (await audit('client.payment.create')).reverse();
    assert.deepEqual(
      entries.map((entry) => [entry.actor.label, entry.outcome, entry.detail.amount, entry.detail.payment ?? '', entry.detail.replay ?? '']),
      [
        [creator.email, 'success', company.amount, original.id, ''],
        [creator.email, 'success', company.amount, original.id, 'yes'],
        ...['9999.00', company.amount, company.amount].map((amount) => [creator.email, 'failure', amount, '', '']),
        [admin.email, 'failure', company.amount, '', ''],
      ],
    );

    // The rule changes from "held" to "sent at once" and the app retries its request: it gets the held payment back. Nothing is sent.
    await h.policy(company.id, 0);
    const retried = await createWith(company, creator, payee, { key: original.key });
    assert.deepEqual([retried.reply.status, retried.id, retried.reply.json.status], [200, original.id, 'awaiting_approval']);
    assert.equal(providerPayments(company).length, 0);
    assert.equal((await createWith(company, creator, payee, { key: original.key, amount: '1.00' })).reply.status, 400);
    assert.equal(providerPayments(company).length, 0);
    // The other way round: sent at once under no rule, then the rule is switched on and the same request arrives again.
    const direct = await create(company, creator, payee);
    assert.equal(direct.reply.status, 200);
    assert.doesNotMatch(direct.id, /^hp_/);
    assert.equal(providerPayments(company).length, 1);
    await h.policy(company.id, 1);
    const afterwards = await createWith(company, creator, payee, { key: direct.key });
    assert.deepEqual([afterwards.reply.status, afterwards.id], [200, direct.id]);
    assert.equal(afterwards.reply.json.held, undefined);
    assert.equal(providerPayments(company).length, 1);
    assert.equal((await h.stores.payments.list({ companyId: company.id })).length, 1, 'no held copy of a payment that was already sent');
    // That key with a different request, or from someone else, makes nothing either.
    for (const change of [{ amount: '2.00' }, { reference: 'INV-2' }]) assert.deepEqual((await createWith(company, creator, payee, { key: direct.key, ...change })).reply.json, refusal);
    assert.deepEqual((await createWith(company, creator, payee, { key: direct.key, reason: 'Other' })).reply.json, refusal);
    // A payment that was never held is recorded by its key too, with who made it: a colleague repeating the very
    // same request under that key is refused in the same words, under either rule.
    assert.deepEqual((await createWith(company, admin, payee, { key: direct.key })).reply.json, refusal);
    await h.policy(company.id, 0);
    assert.deepEqual((await createWith(company, admin, payee, { key: direct.key })).reply.json, refusal);
    assert.deepEqual((await createWith(company, creator, payee, { key: direct.key, amount: '2.00' })).reply.json, refusal);
    assert.equal((await createWith(company, creator, payee, { key: direct.key })).id, direct.id);
    await h.policy(company.id, 1);
    assert.equal(providerPayments(company).length, 1);
    assert.equal((await h.stores.payments.list({ companyId: company.id })).length, 1);
    // And the held one is still approvable, once.
    assert.deepEqual((await act(approver, original.id, 'approve')).json, { status: 'processing', approvalsRemaining: 0 });
    assert.equal(providerPayments(company).length, 2);
  });

  test(on('M3: a send that is not settled yet is settled at the provider account it was sent to, even if the company has been re-pointed since'), async () => {
    const { creator, approver, payee } = await team(company);
    const { id } = await create(company, creator, payee);
    mockOf(company).paymentFault = 'lost_response';
    assert.equal((await act(approver, id, 'approve')).json.status, 'unknown');
    const sending = await record(id);
    const before = await h.stores.directory.getCompany(company.id);
    assert.deepEqual([sending.status, sending.sendMapping], ['sending', { providerKey: before?.providerKey, providerAccountId: before?.providerAccountId, providerContactId: before?.providerContactId }]);
    // The mapping moves underneath it (the console refuses this; see the ops tests. Here it is forced).
    const elsewhere = company.id === 'co_northfield' ? { providerAccountId: 'sample-account-0003', providerContactId: 'sample-contact-0003' } : { providerAccountId: 'S00002', providerContactId: before?.providerContactId ?? '' };
    await h.stores.directory.updateCompany(company.id, (current) => ({ ...current, ...elsewhere }));
    h.clock.advance(31_000);
    assert.deepEqual(await h.held.sweep(), { expired: 0, settled: 1 });
    // Found under its key where it was sent: marked sent, and NOT sent a second time from the other account.
    assert.equal((await record(id)).status, 'sent');
    assert.equal(providerPayments(company).length, 1);
    assert.equal(allProviderPayments(company), 1);
  });

  test(on('L7: a payment the provider made differently from what was approved is flagged, in the audit log and to the people looking at it'), async () => {
    const { creator, approver, payee } = await team(company);
    const { id } = await create(company, creator, payee);
    const mock = mockOf(company);
    mock.paymentFault = 'lost_response';
    assert.equal((await act(approver, id, 'approve')).json.status, 'unknown');
    // What the provider holds under this payment's key is not what was approved.
    const made = providerPayments(company)[0];
    if (company.id === 'co_northfield') made.amount = '1250.00';
    else made.payments = { ...made.payments, amount: 900 };
    h.clock.advance(31_000);
    await h.held.sweep();
    const stored = await record(id);
    assert.equal(stored.status, 'sent');
    assert.match(stored.mismatch ?? '', /^amount \d+(\.\d+)? instead of /);
    const shown = await heldOf(creator, id);
    assert.deepEqual([shown.status, shown.held.state], ['unknown', 'mismatch']);
    assert.equal(schemas.payment.safeParse(shown).success, true, 'the app accepts it');
    const flagged = (await audit('system.payment.send_mismatch')).filter((entry) => entry.detail.payment === id);
    assert.deepEqual(flagged.map((entry) => [entry.outcome, entry.detail.amount, entry.detail.mismatch]), [['failure', company.amount, stored.mismatch]]);
    // A payment made exactly as approved carries no flag.
    const fine = await create(company, creator, payee);
    assert.deepEqual((await act(approver, fine.id, 'approve')).json, { status: 'processing', approvalsRemaining: 0 });
    assert.equal((await record(fine.id)).mismatch ?? null, null);
    assert.equal((await audit('system.payment.send_mismatch')).length, 1);
  });

  test(on('L4: a decision and its audit entry are written together: if the entry cannot be written, the decision is not made'), async () => {
    const { admin, creator, approver, payee } = await team(company);
    const waiting = await create(company, creator, payee);
    const real = h.stores.audit.appendNow.bind(h.stores.audit);
    let refuse: string | null = null;
    h.stores.audit.appendNow = (entry) => {
      if (entry.action === refuse) throw new Error('the audit log cannot be written');
      return real(entry);
    };
    for (const [who, action, entry] of [[approver, 'approve', 'client.payment.approve'], [approver, 'approve', 'client.payment.send'], [admin, 'reject', 'client.payment.reject'], [creator, 'cancel', 'client.payment.cancel']] as const) {
      refuse = entry;
      assert.equal((await act(who, waiting.id, action)).status, 500, entry);
      assert.deepEqual([(await record(waiting.id)).status, (await record(waiting.id)).approvals], ['awaiting_approval', []], entry);
    }
    refuse = 'client.payment.create';
    const count = (await h.stores.payments.list({ companyId: company.id })).length;
    assert.equal((await create(company, creator, payee)).reply.status, 500);
    assert.equal((await h.stores.payments.list({ companyId: company.id })).length, count, 'no held payment without its entry');
    assert.equal(providerPayments(company).length, 0);
    refuse = null;
    assert.equal((await act(approver, waiting.id, 'approve')).status, 200);
  });

  // --- Audit of 2ac6785 ---------------------------------------------------------------------------------

  test(on('N1: a send that went unanswered and is then refused is NOT failed: it is checked by key, found when it lands, and only called failed after the window'), async () => {
    const { admin, creator, approver, payee } = await team(company);
    const mock = mockOf(company);
    const balance = (amount: string | null, saved?: unknown) => {
      if (company.id === 'co_northfield') {
        const row = (h.providerA as any).accounts.get('sample-contact-0001').mock.balanceRow(company.currency);
        const before = row.amount;
        row.amount = amount === null ? saved : new Big(amount);
        return before;
      }
      const balances = (h.providerB as any).states.get('S00001').balances as Map<string, Big>;
      const before = balances.get(company.currency);
      balances.set(company.currency, amount === null ? (saved as Big) : new Big(amount));
      return before;
    };

    // The final approval's request to the provider gets no answer, and has not arrived there yet.
    const { id, key } = await create(company, creator, payee);
    mock.paymentFault = 'applied_late';
    assert.deepEqual((await act(approver, id, 'approve')).json, { status: 'unknown', approvalsRemaining: 0 });
    assert.equal(providerPayments(company).length, 0);
    // The sweep finds nothing under the key and asks again; at that moment the provider refuses (no money).
    const funds = balance('0.00');
    h.clock.advance(31_000);
    assert.deepEqual(await h.held.sweep(), { expired: 0, settled: 0 });
    balance(null, funds);
    // It used to be "failed" here, for good. It is not: the first request may still be made.
    let stored = await record(id);
    assert.deepEqual([stored.status, stored.refusal, stored.attempts?.map((item) => [item.outcome, item.reason ?? ''])], ['sending', 'insufficient_funds', [['unknown', 'network'], ['refused', 'insufficient_funds']]]);
    assert.equal(stored.unconfirmedSince, h.clock.now);
    for (const who of [creator, approver]) {
      const shown = await heldOf(who, id);
      assert.deepEqual([shown.status, shown.held.state], ['unknown', 'checking']);
    }
    assert.deepEqual((await audit('system.payment.send_outcome')).filter((entry) => entry.detail.payment === id).map((entry) => [entry.detail.outcome, entry.detail.reason]).reverse(), [['unknown', 'network'], ['unconfirmed', 'insufficient_funds']]);
    // While it is being checked: looked up only, never asked for again, and nobody can close or re-decide it.
    const calls = createCalls(company);
    for (let n = 0; n < 3; n += 1) {
      h.clock.advance(61_000);
      assert.deepEqual(await h.held.sweep(), { expired: 0, settled: 0 });
    }
    for (const [who, action] of [[admin, 'reject'], [creator, 'cancel'], [admin, 'approve']] as const) assert.equal(reasonOf(await act(who, id, action)), 'not_awaiting_approval');
    assert.deepEqual((await act(approver, id, 'approve')).json, { status: 'unknown', approvalsRemaining: 0 });
    assert.equal(createCalls(company), calls);
    // The creator's app, asking by its key, is not told "failed" either.
    assert.equal((await h.call('GET', `/v1/payments/by-key/${key}`, { token: creator.token })).json.status, 'unknown');
    // Now the first request lands, and the provider makes the payment. The next look finds it: sent, once.
    await mock.releaseLate();
    assert.equal(providerPayments(company).length, 1);
    h.clock.advance(61_000);
    assert.deepEqual(await h.held.sweep(), { expired: 0, settled: 1 });
    stored = await record(id);
    assert.deepEqual([stored.status, stored.unconfirmedSince ?? null, stored.providerPaymentId !== null], ['sent', null, true]);
    assert.equal(providerPayments(company).length, 1);

    // One that never lands: still being checked just before the window ends, failed (and said why) once it has.
    const never = await create(company, creator, payee);
    mock.paymentFault = 'no_answer';
    assert.equal((await act(approver, never.id, 'approve')).json.status, 'unknown');
    const again = balance('0.00');
    h.clock.advance(31_000);
    await h.held.sweep();
    balance(null, again);
    assert.equal((await record(never.id)).status, 'sending');
    h.clock.advance(h.config.paymentReconcileMs - 60_000);
    await h.held.sweep();
    assert.equal((await record(never.id)).status, 'sending');
    h.clock.advance(61_000);
    assert.deepEqual(await h.held.sweep(), { expired: 0, settled: 1 });
    stored = await record(never.id);
    assert.equal(stored.status, 'failed');
    assert.match(stored.note ?? '', /^insufficient_funds; not found at the provider under its key in 72 hours of checking$/);
    assert.equal(providerPayments(company).length, 1);

    // A refusal of the first and ONLY attempt is still final at once: nothing else is in flight.
    // (The approval's own balance check is satisfied; the provider then refuses.)
    const creatorAgain = await signIn(creator.email, company.id, { secret: creator.secret });
    const approverAgain = await signIn(approver.email, company.id, { secret: approver.secret });
    const plain = await create(company, creatorAgain, payee);
    const real = h.held['deps'].withProvider;
    let drained: unknown = null;
    h.held['deps'].withProvider = (async (target: any, run: any) =>
      real(target, async (provider: any) => {
        const original = provider.listBalances;
        provider.listBalances = async (...args: unknown[]) => {
          const balances = await original.apply(provider, args);
          drained = balance('0.00');
          return balances;
        };
        try {
          return await run(provider);
        } finally {
          provider.listBalances = original;
        }
      })) as typeof real;
    assert.deepEqual((await act(approverAgain, plain.id, 'approve')).json, { status: 'failed', approvalsRemaining: 0 });
    h.held['deps'].withProvider = real;
    assert.ok(drained !== null);
    balance(null, drained);
    assert.deepEqual([(await record(plain.id)).status, (await record(plain.id)).attempts?.map((item) => item.outcome)], ['failed', ['refused']]);
  });

  test(on('N1: an attempt cut off by a crash counts as unanswered: after the restart a refusal is not final'), async () => {
    const folder = mkdtempSync(path.join(tmpdir(), 'gc-n1-'));
    folders.push(folder);
    const databasePath = path.join(folder, 'data.sqlite');
    const { creator, approver, payee } = await team(company, { databasePath });
    const { id } = await create(company, creator, payee);
    // The process dies after writing down that it is asking, and before any answer.
    const stored = { ...(await record(id)) };
    await h.stores.payments.update(id, [], (current) => ({ ...current, status: 'sending', statusAt: h.clock.now, sendKey: `gc-crash-${current.id}`, sendMapping: null, approvals: [{ userId: approver.id, at: h.clock.now }], attempts: [{ at: h.clock.now, outcome: 'started' }] }));
    void stored;
    // After the restart nothing is found under the key, it is asked again, and the provider refuses.
    const real = h.held['deps'].withProvider;
    h.held['deps'].withProvider = (async (target: any, run: any) => real(target, async (provider: any) => run(new Proxy(provider, { get: (object, name) => (name === 'createPayment' ? async () => { throw new ProviderError('insufficient_funds'); } : Reflect.get(object, name).bind?.(object) ?? Reflect.get(object, name)) })))) as typeof real;
    assert.deepEqual(await h.held.sweep({ all: true }), { expired: 0, settled: 0 });
    h.held['deps'].withProvider = real;
    const after = await record(id);
    assert.deepEqual([after.status, after.attempts?.map((item) => item.outcome), Boolean(after.unconfirmedSince)], ['sending', ['started', 'refused'], true]);
    assert.equal((await heldOf(creator, id)).held.state, 'checking');
  });

  test(on('N3: a payment past its expiry is expired when its key is replayed, not handed back as still waiting'), async () => {
    const { creator, approver, payee } = await team(company);
    const { id, key } = await create(company, creator, payee);
    h.clock.advance(49 * HOUR);
    const later = await signIn(creator.email, company.id, { secret: creator.secret });
    const replayed = await createWith(company, later, payee, { key });
    assert.deepEqual([replayed.reply.status, replayed.id, replayed.reply.json.status, replayed.reply.json.held.state, replayed.reply.json.held.canCancel], [200, id, 'cancelled', 'expired', false]);
    assert.equal((await record(id)).status, 'expired');
    assert.equal(reasonOf(await act(await signIn(approver.email, company.id, { secret: approver.secret }), id, 'approve')), 'payment_expired');
    assert.equal((await audit('system.payment.expire')).filter((entry) => entry.detail.payment === id).length, 1);
  });

  test(on('N13: a payment sent directly is recorded by its key BEFORE the provider is asked: the same request after a rule change never becomes a second, held, payment'), async () => {
    const { admin, creator, approver, payee } = await team(company);
    const mock = mockOf(company);
    await h.policy(company.id, 0);
    const refusal = { error: { kind: 'validation', fields: ['idempotencyKey'] } };
    // Sent directly; the request has not reached the provider and there is no answer.
    mock.paymentFault = 'applied_late';
    const first = await create(company, creator, payee);
    assert.notEqual(first.reply.status, 200);
    assert.equal(providerPayments(company).length, 0);
    const direct = await h.stores.payments.getDirect(company.id, first.key);
    assert.deepEqual([direct?.createdBy, direct?.state, direct?.unknown, direct?.providerPaymentId], [creator.id, 'started', true, null]);
    // The company's rule is switched on, and the app retries the same request with the same key.
    await h.policy(company.id, 1);
    const retried = await createWith(company, creator, payee, { key: first.key });
    assert.deepEqual([retried.reply.status, retried.reply.json], [504, { error: { kind: 'timeout' } }], 'outcome not known: neither held nor sent');
    assert.equal((await h.stores.payments.list({ companyId: company.id })).length, 0, 'no held twin');
    assert.equal(providerPayments(company).length, 0);
    // Anything else with that key, or anyone else, is refused as for any key that is taken.
    assert.deepEqual((await createWith(company, creator, payee, { key: first.key, amount: '1.00' })).reply.json, refusal);
    assert.deepEqual((await createWith(company, creator, payee, { key: first.key, reason: 'Other' })).reply.json, refusal);
    assert.deepEqual((await createWith(company, admin, payee, { key: first.key })).reply.json, refusal);
    // The first request lands. The retry now gets that payment: one payment for one request.
    await mock.releaseLate();
    assert.equal(providerPayments(company).length, 1);
    const found = await createWith(company, creator, payee, { key: first.key });
    assert.equal(found.reply.status, 200);
    assert.equal(found.reply.json.held, undefined);
    assert.equal((await h.stores.payments.getDirect(company.id, first.key))?.providerPaymentId, found.id);
    assert.equal((await h.stores.payments.list({ companyId: company.id })).length, 0);
    assert.equal(providerPayments(company).length, 1);
    void approver;

    // With no rule, a retry of an unanswered direct send asks the provider again under the SAME key, as before.
    await h.policy(company.id, 0);
    mock.paymentFault = 'lost_response';
    const lost = await create(company, creator, payee);
    assert.notEqual(lost.reply.status, 200);
    assert.equal(providerPayments(company).length, 2);
    const again = await createWith(company, creator, payee, { key: lost.key });
    assert.equal(again.reply.status, 200);
    assert.equal(providerPayments(company).length, 2);
    // A direct send the provider plainly refused made nothing; under a rule that key is spent, not quietly held.
    const real = h.held['deps'].withProvider;
    h.held['deps'].withProvider = (async (target: any, run: any) => real(target, async (provider: any) => run(new Proxy(provider, { get: (object, name) => (name === 'createPayment' ? async () => { throw new ProviderError('insufficient_funds'); } : Reflect.get(object, name).bind?.(object) ?? Reflect.get(object, name)) })))) as typeof real;
    const refused = await create(company, creator, payee);
    h.held['deps'].withProvider = real;
    assert.equal(refused.reply.json.error.kind, 'insufficient_funds');
    assert.deepEqual([(await h.stores.payments.getDirect(company.id, refused.key))?.state, (await h.stores.payments.getDirect(company.id, refused.key))?.unknown], ['refused', false]);
    await h.policy(company.id, 1);
    assert.deepEqual((await createWith(company, creator, payee, { key: refused.key })).reply.json, refusal);
    assert.equal((await h.stores.payments.list({ companyId: company.id })).length, 0);
    // The store itself: one key cannot be both, whichever arrives first.
    const key = 'key-both-000001';
    const base = { companyId: company.id, idempotencyKey: key, createdBy: creator.id, requestHash: 'x', createdAt: 1, mapping: { providerKey: 'equals' as const, providerAccountId: 'a', providerContactId: '' }, state: 'started' as const, unknown: false, providerPaymentId: null };
    assert.equal(((await h.stores.payments.claimDirect(base)) as { created: boolean }).created, true);
    assert.equal(((await h.stores.payments.claimDirect(base)) as { created: boolean }).created, false);
    const template = await create(company, creator, payee);
    const heldTwin = await h.stores.payments.create({ ...(await record(template.id)), id: 'hp_twin', idempotencyKey: key });
    assert.ok('direct' in heldTwin);
    assert.ok('held' in (await h.stores.payments.claimDirect({ ...base, idempotencyKey: template.key })));
  });

  test(on('an amount has one spelling: leading zeros are refused, so what is stored and approved is what was typed'), async () => {
    const { creator, payee } = await team(company);
    for (const amount of ['01.50', '00.50', '0125.00', '00']) {
      const reply = (await createWith(company, creator, payee, { amount })).reply;
      assert.deepEqual([reply.status, reply.json.error?.fields], [400, ['amount']], amount);
    }
    assert.equal((await createWith(company, creator, payee, { amount: '0.50' })).reply.status, 200);
    assert.equal((await h.stores.payments.list({ companyId: company.id })).length, 1);
  });

  test(on('payee digest: a refusal names the fields that changed (never their values), and a field the provider moves on its own can be left out by name'), async () => {
    const ignored = company.id === 'co_northfield' ? { PAYEE_DIGEST_IGNORE_CURRENCYCLOUD: 'payments_count,bank.last_checked_at' } : { PAYEE_DIGEST_IGNORE_EQUALS: 'paymentsCount,bank.lastCheckedAt' };
    const names = company.id === 'co_northfield' ? ['payments_count', 'last_checked_at', 'bank_name', 'routing_code_value_1'] : ['paymentsCount', 'lastCheckedAt', 'bankName', 'bankIdentifier'];
    const [counter, stamp, bank, routing] = names as [string, string, string, string];
    const config = loadConfig({ APP_ENV: 'development', ...ignored });
    const { creator, approver, payee } = await team(company, {}, { payeeDigestIgnore: config.payeeDigestIgnore });
    const row = providerPayee(company, payee);
    Object.assign(row, { [counter]: 0, bank: { [stamp]: '2026-01-01', branch: 'A' } });
    const fine = await create(company, creator, payee);
    const blocked = await create(company, creator, payee);
    // The provider counts a payment and stamps a check: both are on the adapter's ignore list, by name. Nothing is blocked.
    Object.assign(row, { [counter]: 7, bank: { [stamp]: '2031-01-01', branch: 'A' } });
    assert.deepEqual((await act(approver, fine.id, 'approve')).json, { status: 'processing', approvalsRemaining: 0 });
    // A field NOT on the list, nested or not, still blocks, and the audit entry says which, by name only.
    const secretValue = 'ZZ-ATTACKER-9999';
    Object.assign(row, { [bank]: secretValue, [routing]: '999999', bank: { [stamp]: '2031-01-01', branch: 'B' } });
    assert.equal(reasonOf(await act(approver, blocked.id, 'approve')), 'payee_changed');
    const entry = (await audit('system.payment.blocked')).find((item) => item.detail.payment === blocked.id);
    assert.equal(entry?.detail.fields, [bank, 'bank.branch', routing].sort().join(', '));
    assert.ok(!JSON.stringify(entry).includes(secretValue) && !JSON.stringify(entry).includes('999999'));
    // What the client app is told is unchanged: no field names, no provider's vocabulary.
    assert.doesNotMatch(h.bodies.join('\n'), new RegExp(`${routing}|${counter}`));
    // The lists are explicit and short, and a malformed one is refused at start-up.
    assert.deepEqual(loadConfig({ APP_ENV: 'development' }).payeeDigestIgnore, { currencycloud: [], equals: [] });
    assert.throws(() => loadConfig({ APP_ENV: 'development', PAYEE_DIGEST_IGNORE_EQUALS: 'a b; DROP' }), /PAYEE_DIGEST_IGNORE_\* must be a comma-separated list of field names/);
  });

  test(on('H1: what an approval checked at the provider is checked again INSIDE its transaction: a company re-pointed, a payee digest replaced, or an expiry reached in between refuses it'), async () => {
    const elsewhere = company.id === 'co_northfield' ? 'sample-account-0003' : 'S00002';
    const cases: [string, () => void, string][] = [
      ['the company was re-pointed', () => void h.stores.db.run('UPDATE companies SET provider_account_id = ? WHERE id = ?', elsewhere, company.id), 'not_awaiting_approval'],
      ['the stored payee digest is no longer the one that was checked', () => void h.stores.db.run("UPDATE held_payments SET data = json_set(data, '$.payeeDigest', 'something else')"), 'not_awaiting_approval'],
      ['the payment expired', () => h.clock.advance(49 * HOUR), 'payment_expired'],
      ['the company was deactivated', () => void h.stores.db.run('UPDATE companies SET deactivated_at = 1 WHERE id = ?', company.id), 'not_awaiting_approval'],
    ];
    for (const [what, change, reason] of cases) {
      let armed = false;
      const { creator, approver, payee } = await team(company, {
        storeLatency: true,
        // After the request has asked the provider about the payee and the balance, and before it writes its decision.
        storeHook: (operation) => {
          if (operation === 'update' && armed) {
            armed = false;
            change();
          }
        },
      });
      const { id } = await create(company, creator, payee);
      const token = await stepUp(approver, 'payment.approve', { paymentId: id });
      armed = true;
      const reply = await h.call('POST', `/v1/payments/${id}/approve`, { token: approver.token, headers: { 'x-step-up-token': token } });
      assert.equal(armed, false, what);
      assert.equal(reasonOf(reply), reason, what);
      const stored = await record(id);
      assert.ok(stored.status !== 'sending' && stored.status !== 'sent' && stored.approvals.length === 0, what);
      assert.equal(allProviderPayments(company), 0, what);
      await h.close();
    }
  });
}

test('isolation: a held payment cannot be seen, approved, rejected, cancelled or found by key from another company, on either provider', async () => {
  // The mocks act on any id whatever the scope says: only the server's own checks stand between the companies.
  h = await harness({}, undefined, { enforceOwnership: false });
  const amira = await signIn(AMIRA, 'co_northfield');
  const ben = await signIn(BEN, 'co_castlebrook');
  const danaSecret = (await h.activate(DANA)).secret;
  const dana = async (companyId: string) => signIn(DANA, companyId, { secret: danaSecret });
  const [north, castle] = COMPANIES as [Company, Company];
  const northPayment = await create(north, amira, await payeeOf(north, amira), 'key-shared-000001');
  const castlePayment = await create(castle, ben, await payeeOf(castle, ben), 'key-shared-000001');
  assert.notEqual(northPayment.id, castlePayment.id, 'the same key in two companies is two payments');

  const cases: [Person, string, string][] = [
    [ben, northPayment.id, 'co_northfield'],
    [await dana('co_castlebrook'), northPayment.id, 'co_northfield'],
    [amira, castlePayment.id, 'co_castlebrook'],
    [await dana('co_northfield'), castlePayment.id, 'co_castlebrook'],
  ];
  for (const [outsider, id] of cases) {
    assert.ok(!(await awaiting(outsider)).some((item) => item.payment.id === id));
    assert.equal(await heldOf(outsider, id), undefined);
    for (const action of ['approve', 'reject', 'cancel'] as const) {
      const reply = await act(outsider, id, action);
      assert.ok([400, 404].includes(reply.status), `${action}: ${reply.status}`);
      assert.notEqual(reply.json?.error?.reason, 'creator_cannot_approve');
    }
    assert.equal((await record(id)).status, 'awaiting_approval');
    assert.deepEqual((await record(id)).approvals, []);
  }
  // By key, each company finds only its own.
  assert.equal((await h.call('GET', '/v1/payments/by-key/key-shared-000001', { token: ben.token })).json.id, castlePayment.id);
  assert.equal((await h.call('GET', '/v1/payments/by-key/key-shared-000001', { token: amira.token })).json.id, northPayment.id);
  assert.equal(providerPayments(north).length + providerPayments(castle).length, 0);

  // The same person, once their session is on the right company, can approve.
  assert.equal((await act(await dana('co_northfield'), northPayment.id, 'approve')).status, 200);
  assert.equal((await act(await dana('co_castlebrook'), castlePayment.id, 'approve')).status, 200);
  assert.deepEqual([providerPayments(north).length, providerPayments(castle).length], [1, 1]);
});

test('payments that were already pending at the provider stay visible and can be actioned, and are told apart from held ones', async () => {
  h = await harness();
  const amira = await signIn(AMIRA, 'co_northfield');
  const dana = await signIn(DANA, 'co_northfield');
  const mine = await create(COMPANIES[0] as Company, amira, 'sample-beneficiary-harbour');
  const items = await awaiting(dana);
  const heldItem = items.find((item) => item.payment.id === mine.id);
  const atProvider = items.filter((item) => !item.payment.held);
  assert.ok(heldItem.payment.held);
  assert.equal(heldItem.external, undefined);
  assert.equal(atProvider[0]?.external, true, 'marked as not held by this server');
  assert.equal(atProvider.length, 1, 'the sample payment that was pending at the provider');
  // It is approved at the provider, as before. It cannot be cancelled here: it was never held here.
  assert.equal((await act(dana, atProvider[0].payment.id, 'cancel')).status, 404);
  const approved = await act(dana, atProvider[0].payment.id, 'approve');
  assert.equal(approved.status, 200);
  // L9: who acted on it is on record, marked as a payment this server never held.
  const entry = (await audit('client.payment.approve')).find((item) => item.detail.payment === atProvider[0].payment.id);
  assert.deepEqual([entry?.actor.label, entry?.outcome, entry?.detail.external], [dana.email, 'success', 'yes']);
  // The same role rule as for a held payment: someone who may only create payments cannot approve it.
  assert.deepEqual((await awaiting(dana)).map((item) => item.payment.id), [mine.id]);
});

test('a company whose only approver is the creator: the creator is told nobody else can approve; the expiry time is configurable', async () => {
  h = await harness({ paymentApprovalMs: 2 * HOUR });
  // Dana is removed, so Amira is alone in the company.
  await h.stores.directory.removeMembership('usr_dana', 'co_northfield');
  const amira = await signIn(AMIRA, 'co_northfield');
  const { reply, id } = await create(COMPANIES[0] as Company, amira, 'sample-beneficiary-harbour');
  assert.equal(reply.status, 200);
  assert.deepEqual([reply.json.status, reply.json.held.approvers, reply.json.held.canApprove], ['awaiting_approval', [], false]);
  assert.equal(Date.parse(reply.json.held.expiresAt) - Date.parse(reply.json.createdAt), 2 * HOUR);
  assert.equal(reasonOf(await act(amira, id, 'approve')), 'creator_cannot_approve');

  assert.equal(loadConfig({ APP_ENV: 'development' }).paymentApprovalMs, 48 * HOUR);
  assert.equal(loadConfig({ APP_ENV: 'development', PAYMENT_APPROVAL_HOURS: '12' }).paymentApprovalMs, 12 * HOUR);
  for (const bad of ['0', '-1', 'soon', '100000']) assert.throws(() => loadConfig({ APP_ENV: 'development', PAYMENT_APPROVAL_HOURS: bad }), /PAYMENT_APPROVAL_HOURS/);
});

// --- Notifications about held payments ---------------------------------------------------------------------------
const notesOf = async (who: Person) => (await h.call('GET', '/v1/notifications', { token: who.token })).json as { unread: number; items: { id: string; title: string; body: string; category: string; read: boolean }[] };
const titlesOf = async (who: Person) => (await notesOf(who)).items.map((item) => item.title);
const mailsTo = (who: Person, subject: RegExp) => h.outbox.sent.filter((message) => message.to === who.email && subject.test(message.subject));
const BANK_DETAILS = /FR14|2004|SMPL|IBAN|iban|sort code|account number|\d{8,}/;

for (const company of COMPANIES) {
  const on = (name: string) => `${company.label}: ${name}`;
  const sum = `${company.currency} ${company.amount}`;

  test(on('notifications: every eligible approver is told of a waiting payment (never its creator); the creator is told of approval, and of rejection with the reason; each once, with no bank details'), async () => {
    const { admin, creator, approver, payee } = await team(company);
    const payeeName = (await record((await create(company, creator, payee)).id)).payee.name;
    // A viewer cannot approve, so is not told.
    const viewer = await person('Vera', company.id, 'creator'); // can create, cannot approve: not told

    // WAITING: the approver and the administrator, in the app and by email. Not the creator, not the viewer.
    for (const who of [approver, admin]) {
      const notes = await notesOf(who);
      assert.deepEqual([notes.unread, notes.items.length, notes.items[0]?.category, notes.items[0]?.title], [1, 1, 'approvals', 'A payment is waiting for your approval'], who.name);
      assert.match(notes.items[0]?.body ?? '', new RegExp(`^Cara created a payment of ${sum.replace('.', '\\.')} to ${payeeName}\\. It has not been sent\\.\\nIt needs approval before 2026-11-13 \\d\\d:\\d\\d UTC; after that it expires and is not sent\\.`));
      assert.doesNotMatch(notes.items[0]?.body ?? '', BANK_DETAILS);
      const mails = mailsTo(who, /^A payment is waiting for your approval in Global Connect$/);
      assert.equal(mails.length, 1, who.name);
      assert.match(mails[0]?.text ?? '', new RegExp(`Cara created a payment of ${sum.replace('.', '\\.')} to ${payeeName}`));
      assert.doesNotMatch(`${mails[0]?.text}${mails[0]?.html}`, BANK_DETAILS);
      assert.doesNotMatch(`${mails[0]?.text}`, /https?:/);
    }
    assert.deepEqual([(await notesOf(creator)).items.length, (await notesOf(viewer)).items.length], [0, 0]);
    assert.equal(h.outbox.sent.filter((message) => message.to === creator.email && /payment/i.test(message.subject)).length, 0);

    // ONCE: looked at again and again, by the schedule or after a "restart" (a new look at the same database), nothing more is sent.
    const sent = h.outbox.sent.length;
    for (let index = 0; index < 3; index += 1) assert.equal(await h.paymentNotes.scan(), 0);
    const { PaymentNotifications } = await import('../src/notify/payments');
    const { Notifier } = await import('../src/notify/notifier');
    const restarted = new PaymentNotifications(h.stores, new Notifier(h.stores, h.mail, { now: () => h.clock.now, perUserPerHour: 60 }), { now: () => h.clock.now, expiryWarningMs: 6 * HOUR });
    assert.equal(await restarted.scan(), 0);
    assert.equal(await restarted.scan(company.id), 0);
    assert.equal(h.outbox.sent.length, sent);
    assert.equal((await notesOf(approver)).items.length, 1);

    // REJECTED with a reason: the creator is told who and why. What the rejecter typed stays text: no link, no markup, one line.
    const first = (await awaiting(approver))[0]?.payment.id as string;
    assert.equal((await act(approver, first, 'reject', { reason: 'bad\u0007reason' })).status, 400, 'control characters are refused');
    assert.equal((await act(approver, first, 'reject', { reason: 'x'.repeat(201) })).status, 400, 'bounded length');
    assert.equal((await notesOf(creator)).items.length, 0);
    const reason = 'Wrong <b>invoice</b> see https://evil.example/pay & "ask" Abel';
    assert.equal((await act(approver, first, 'reject', { reason })).status, 200);
    const told = await notesOf(creator);
    assert.deepEqual([told.unread, told.items[0]?.category, told.items[0]?.title], [1, 'payments', 'Your payment was rejected']);
    assert.equal(told.items[0]?.body, `Your payment of ${sum} to ${payeeName} was rejected by Abel. It was not sent.\nReason given: “Wrong <b>invoice</b> see https[:]//evil[.]example/pay & "ask" Abel”`);
    const rejection = mailsTo(creator, /^An update on a payment you created in Global Connect$/);
    assert.equal(rejection.length, 1);
    assert.doesNotMatch(rejection[0]?.text ?? '', /https?:/);
    assert.ok((rejection[0]?.html ?? '').includes('Wrong &lt;b&gt;invoice&lt;/b&gt; see https[:]//evil[.]example/pay &amp; &quot;ask&quot; Abel'));
    assert.doesNotMatch(rejection[0]?.html ?? '', /<b>/);
    // The creator also sees it on the payment itself, as data (the app shows it as text).
    assert.deepEqual((await heldOf(creator, first)).held.rejection, { by: 'Abel', reason: 'Wrong <b>invoice</b> see https[:]//evil[.]example/pay & "ask" Abel' });
    assert.equal((await heldOf(creator, first)).held.state, 'rejected');
    // A link NESTED so that stripping it once would leave a working one, and a bare address: the creator still gets
    // the notification AND the email (an email that could not be written out used to be lost for good), with neither a link.
    const nested = (await create(company, creator, payee)).id;
    const emailsBefore = mailsTo(creator, /^An update on a payment you created/).length;
    assert.equal((await act(approver, nested, 'reject', { reason: 'https:/a:///gc-payments.example/login or www.gc-payments.example/verify' })).status, 200);
    const nestedNote = (await notesOf(creator)).items[0];
    assert.equal(nestedNote?.body.split('\n')[1], 'Reason given: “https[:]/a[:]///gc-payments[.]example/login or www[.]gc-payments[.]example/verify”');
    const nestedMail = mailsTo(creator, /^An update on a payment you created/);
    assert.equal(nestedMail.length, emailsBefore + 1, 'the email was sent');
    assert.doesNotMatch(`${nestedMail.at(-1)?.text}${nestedMail.at(-1)?.html}`, /https?:\/\/|www\.gc|gc-payments\.example/);
    assert.equal((await h.stores.mail.list({ status: 'failed' })).length, 0);
    // No reason is fine too.
    const second = (await create(company, creator, payee)).id;
    assert.equal((await act(admin, second, 'reject')).status, 200);
    assert.match((await notesOf(creator)).items[0]?.body ?? '', /was rejected by .+\. It was not sent\.\nNo reason was given\.$/);
    assert.deepEqual((await heldOf(creator, second)).held.rejection.reason, null);

    // APPROVED and sent: the creator is told, once. The approver who acted is told nothing more.
    const third = (await create(company, creator, payee)).id;
    assert.equal((await act(approver, third, 'approve')).status, 200);
    assert.deepEqual((await titlesOf(creator)).slice(0, 1), ['Your payment was sent for processing']);
    assert.equal((await notesOf(creator)).items[0]?.body, `Your payment of ${sum} to ${payeeName} was approved and has been sent for processing.`);
    assert.equal(await h.paymentNotes.scan(), 0);
    assert.equal((await titlesOf(creator)).filter((title) => title === 'Your payment was sent for processing').length, 1);
    assert.equal(mailsTo(creator, /^An update on a payment you created/).length, 4);

    // CANCELLED by an administrator: the creator is told. Cancelled by the creator themselves: nobody needs telling.
    const fourth = (await create(company, creator, payee)).id;
    assert.equal((await act(admin, fourth, 'cancel')).status, 200);
    assert.equal((await titlesOf(creator))[0], 'Your payment was cancelled');
    const fifth = (await create(company, creator, payee)).id;
    const count = (await notesOf(creator)).items.length;
    assert.equal((await act(creator, fifth, 'cancel')).status, 200);
    assert.equal((await notesOf(creator)).items.length, count);

    // An administrator who creates a payment is not asked to approve their own: only the others are told.
    const waitingFor = async (who: Person) => (await titlesOf(who)).filter((title) => title === 'A payment is waiting for your approval').length;
    const [adminBefore, approverBefore] = [await waitingFor(admin), await waitingFor(approver)];
    assert.equal((await create(company, admin, payee)).reply.status, 200);
    assert.deepEqual([await waitingFor(admin), await waitingFor(approver)], [adminBefore, approverBefore + 1]);

    // The audit log has who was told and which kind; nothing a notification said.
    const entries = await audit('notification');
    assert.ok(entries.length >= 9);
    assert.ok(entries.every((entry) => entry.action !== 'notification' || (Object.keys(entry.detail).sort().join() === 'category,email,kind' && !JSON.stringify(entry).includes(payeeName) && !JSON.stringify(entry).includes('evil'))));
  });

  test(on('notifications: about to expire and expired; email can be turned off per category but not for security; rate-limited'), async () => {
    const { admin, creator, approver, payee } = await team(company, {}, { notificationsPerUserPerHour: 4 });
    // PREFERENCES: everything on to begin with; security is always on and cannot be switched.
    assert.deepEqual((await h.call('GET', '/v1/notifications/preferences', { token: creator.token })).json, { email: { rates: true, approvals: true, payments: true }, alwaysOn: ['security'] });
    for (const body of [{ email: { rates: true, approvals: true, payments: true, security: false } }, { email: { rates: true } }, { email: { rates: 'no', approvals: true, payments: true } }, {}]) {
      assert.equal((await h.call('POST', '/v1/notifications/preferences', { token: creator.token, body })).status, 400, JSON.stringify(body));
    }
    assert.deepEqual((await h.call('POST', '/v1/notifications/preferences', { token: creator.token, body: { email: { rates: true, approvals: true, payments: false } } })).json.email, { rates: true, approvals: true, payments: false });
    const changed = (await audit('client.notification_preferences'))[0];
    assert.deepEqual([changed?.actor.label, changed?.detail], [creator.email, { rates: 'on', approvals: 'on', payments: 'off' }]);

    const id = (await create(company, creator, payee)).id;
    assert.deepEqual(await titlesOf(approver), ['A payment is waiting for your approval']);
    // Six hours before it runs out (it lasts 48): the creator and those who could still approve are told, once.
    h.clock.advance(41 * HOUR);
    assert.equal(await h.paymentNotes.scan(), 0, 'not yet');
    h.clock.advance(HOUR + 60_000);
    assert.equal(await h.paymentNotes.scan(), 3);
    assert.equal(await h.paymentNotes.scan(), 0);
    const note = async (userId: string) => (await h.notifier.list(userId)).items;
    for (const who of [approver, admin]) assert.deepEqual((await note(who.id)).map((item) => item.title), ['A payment waiting for approval is about to expire', 'A payment is waiting for your approval'], who.name);
    assert.deepEqual((await note(creator.id)).map((item) => [item.title, item.category]), [['A payment waiting for approval is about to expire', 'payments']]);
    assert.match((await note(creator.id))[0]?.body ?? '', /is still waiting for approval\. It has not been sent\.\nIt expires 2026-11-13 \d\d:\d\d UTC\. If it is not approved by then it will not be sent/);
    // The creator turned payment emails off: in the app, yes; by email, no. The approver's emails still go.
    assert.equal(mailsTo(creator, /payment/i).length, 0);
    assert.equal(mailsTo(approver, /^A payment is waiting for your approval in Global Connect$/).length, 2);
    assert.equal((await audit('notification')).find((entry) => entry.target?.id === creator.id)?.detail.email, 'off');
    // A SECURITY notice still reaches the creator by email whatever they chose.
    await h.notices.send({ id: creator.id, email: creator.email, name: creator.name }, 'client', 'password_changed');
    assert.equal(h.outbox.sent.filter((message) => message.to === creator.email && /^Security notice/.test(message.subject)).length >= 1, true);

    // EXPIRED: the creator is told, once.
    h.clock.advance(6 * HOUR);
    assert.deepEqual(await h.held.sweep(), { expired: 1, settled: 0 });
    assert.equal(await h.paymentNotes.scan(), 1);
    assert.equal(await h.paymentNotes.scan(), 0);
    assert.equal((await note(creator.id))[0]?.title, 'Your payment expired');
    assert.equal((await record(id)).status, 'expired');

    // RATE LIMIT (4 an hour here): the fifth and later are held back, on record once, and nothing is emailed for them.
    const before = (await note(approver.id)).length;
    const emails = mailsTo(approver, /payment/i).length;
    for (let index = 0; index < 6; index += 1) await h.notifier.notify({ userId: approver.id, companyId: company.id, category: 'approvals', kind: 'payment_awaiting', note: { amount: '1.00', currency: 'GBP', payee: 'P', createdBy: 'C', expiresAt: 0 }, dedupe: `flood:${index}` });
    for (let index = 0; index < 6; index += 1) await h.notifier.notify({ userId: approver.id, companyId: company.id, category: 'approvals', kind: 'payment_awaiting', note: { amount: '1.00', currency: 'GBP', payee: 'P', createdBy: 'C', expiresAt: 0 }, dedupe: `flood:${index}` });
    assert.equal((await note(approver.id)).length, before + 4);
    assert.equal(mailsTo(approver, /payment/i).length, emails + 4);
    const suppressed = (await audit('notification')).filter((entry) => entry.outcome === 'failure');
    assert.deepEqual([suppressed.length, suppressed[0]?.detail.reason], [2, 'rate_limited']);
    // A disabled person is told nothing.
    await h.stores.directory.saveUser({ ...((await h.stores.directory.getUser(admin.id)) as NonNullable<Awaited<ReturnType<typeof h.stores.directory.getUser>>>), disabledAt: h.clock.now });
    assert.equal(await h.notifier.notify({ userId: admin.id, companyId: company.id, category: 'payments', kind: 'payment_sent', note: { amount: '1.00', currency: 'GBP', payee: 'P' }, dedupe: 'disabled:1' }), 'skipped');
  });
}

test('provider A: notifications when a send goes unanswered (outcome being checked), is not as approved, or fails; nothing twice', async () => {
  const company = COMPANIES[0] as Company;
  const { creator, approver, payee } = await team(company);
  // No answer from the provider when the payment is sent: its outcome is being checked.
  const first = (await create(company, creator, payee)).id;
  h.providerA.paymentFault = 'no_answer';
  await act(approver, first, 'approve');
  assert.deepEqual((await titlesOf(creator)).sort(), ['Your payment needs attention: its outcome is being checked', 'Your payment was approved']);
  const checking = (await notesOf(creator)).items.find((item) => /being checked/.test(item.title));
  assert.match(checking?.body ?? '', /we do not yet know whether it was made\. We are checking\.\nDo NOT create it again\./);
  assert.equal(await h.paymentNotes.scan(), 0);
  assert.equal((await notesOf(creator)).items.length, 2);

  // A refusal that itself closes the payment (the payee was changed since it was created): its creator is told at once.
  const second = (await create(company, creator, payee)).id;
  providerPayee(company, payee).id = 'gone';
  assert.equal(reasonOf(await act(approver, second, 'approve')), 'payee_changed');
  assert.equal((await titlesOf(creator))[0], 'Your payment was stopped');
  assert.match((await notesOf(creator)).items[0]?.body ?? '', /was stopped because the payee’s details changed after you created it\. It was not sent\./);
});
