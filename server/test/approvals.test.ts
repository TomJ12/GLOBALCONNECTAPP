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
    assert.deepEqual(approvals.map((entry) => [entry.actor.label, entry.outcome, entry.detail.reason ?? entry.detail.status]).reverse().slice(0, 3), [[approver.email, 'failure', 'step_up_required'], [approver.email, 'success', 'processing'], [approver.email, 'success', 'processing']]);
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

  test(on('a change of policy does not alter payments already waiting; 0 sends at once as before'), async () => {
    const { admin, creator, approver, payee } = await team(company);
    const underOne = await create(company, creator, payee);
    await h.policy(company.id, 2);
    const underTwo = await create(company, creator, payee);
    // The earlier payment still needs one approval, not two.
    assert.deepEqual((await act(approver, underOne.id, 'approve')).json, { status: 'processing', approvalsRemaining: 0 });
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
    // The one created under two approvals still needs both, though the rule is now 0.
    assert.deepEqual((await act(approver, underTwo.id, 'approve')).json, { status: 'awaiting_approval', approvalsRemaining: 1 });
    assert.equal(providerPayments(company).length, 2);
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
    assert.equal((await heldOf(creator, lost.id)).held.state, 'sending');
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
    mock.paymentFault = 'no_answer';
    assert.equal((await act(approver, never.id, 'approve')).json.status, 'unknown');
    assert.equal(providerPayments(company).length, 2);
    assert.deepEqual((await act(approver, never.id, 'approve')).json, { status: 'processing', approvalsRemaining: 0 });
    assert.equal(providerPayments(company).length, 3);

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
