import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import * as schemas from '@/api/schemas';

import { seedDirectory } from '../src/store/seed';
import { AMIRA, BEN, DANA, harness, type Harness } from './helpers';

let h: Harness;
afterEach(async () => h?.close());

const PAYEE_A = 'sample-beneficiary-harbour';
const paymentBody = (overrides: Record<string, unknown> = {}) => ({
  beneficiaryId: PAYEE_A,
  amount: '125.00',
  currency: 'GBP',
  reference: 'INV-1',
  reason: 'Invoice',
  ...overrides,
});

async function signedIn(email: string): Promise<{ token: string; secret: string; session: any; companies: any[] }> {
  const { secret } = await h.activate(email);
  const reply = await h.login(email, secret);
  assert.equal(reply.status, 200);
  return { token: reply.json.token, secret, session: reply.json.session, companies: reply.json.companies };
}

/** Send a payment with a step-up bound to exactly what is sent. */
async function pay(token: string, secret: string, key: string, body = paymentBody()) {
  const stepUp = await h.stepUp(token, secret, 'payment.create', { ...body, idempotencyKey: key });
  return h.call('POST', '/v1/payments', { token, body, headers: { 'idempotency-key': key, 'x-step-up-token': stepUp } });
}

test('routing: each person gets the data of the provider that holds their company, and never learns which', async () => {
  h = await harness();
  const amira = await signedIn(AMIRA);
  const ben = await signedIn(BEN);

  assert.deepEqual(amira.session.company, { id: 'co_northfield', name: 'Northfield Trading Ltd' });
  assert.deepEqual(ben.session.company, { id: 'co_castlebrook', name: 'Castlebrook Imports Ltd' });

  const a = (await h.call('GET', '/v1/balances', { token: amira.token })).json.items;
  const b = (await h.call('GET', '/v1/balances', { token: ben.token })).json.items;
  assert.deepEqual(a.map((row: any) => [row.currency, row.amount]), [['GBP', '101964.00'], ['USD', '57891.00'], ['EUR', '24310.50']]);
  assert.deepEqual(b.map((row: any) => [row.currency, row.amount]), [['GBP', '48250.75'], ['EUR', '131900.00'], ['USD', '9410.20']]);

  // Every neutral read works on both, and parses with the app's own schemas.
  for (const { token } of [amira, ben]) {
    const get = async (url: string) => {
      const reply = await h.call('GET', url, { token });
      assert.equal(reply.status, 200, url);
      return reply.json;
    };
    schemas.companyProfile.parse(await get('/v1/company'));
    schemas.listResult(schemas.balance).parse(await get('/v1/balances'));
    schemas.accountDetails.parse(await get('/v1/account-details/GBP'));
    schemas.page(schemas.transaction).parse(await get('/v1/transactions?page=1&perPage=5'));
    schemas.ratePair.parse(await get('/v1/rates/GBP/USD'));
    schemas.rateHistory.parse(await get('/v1/rates/GBP/USD/history'));
    schemas.listResult(schemas.beneficiary).parse(await get('/v1/beneficiaries'));
    schemas.page(schemas.payment).parse(await get('/v1/payments?page=1&perPage=5'));
    schemas.listResult(schemas.pendingApproval).parse(await get('/v1/approvals'));
    schemas.listResult(schemas.forwardContract).parse(await get('/v1/forwards'));
  }
  assert.equal((await h.call('GET', '/v1/company', { token: amira.token })).json.id, 'co_northfield');
  assert.equal((await h.call('GET', '/v1/transactions?page=1&perPage=500', { token: amira.token })).status, 400);
});

test('capabilities: the second provider has no forwards or approvals, and the server refuses them', async () => {
  h = await harness();
  const amira = await signedIn(AMIRA);
  const ben = await signedIn(BEN);
  assert.deepEqual(amira.session.capabilities, { forwardContracts: true, paymentApprovals: true });
  // Approvals are the server's own: every company with a rule of 1 or more has them, whatever its provider can do.
  assert.deepEqual(ben.session.capabilities, { forwardContracts: false, paymentApprovals: true });
  await h.policy('co_castlebrook', 0);
  assert.deepEqual((await h.login(BEN, ben.secret)).json.session.capabilities, { forwardContracts: false, paymentApprovals: false });
  assert.deepEqual(amira.session.stepUpActions, ['payment.create', 'payment.approve', 'payment.reject', 'payment.cancel', 'beneficiary.create']);

  const forward = { kind: 'forward', sellCurrency: 'GBP', buyCurrency: 'USD', fixedSide: 'sell', amount: '1000.00', settlementDate: '2027-03-01' };
  assert.equal((await h.call('POST', '/v1/quotes', { token: amira.token, body: forward })).status, 200);
  const refused = await h.call('POST', '/v1/quotes', { token: ben.token, body: forward });
  assert.equal(refused.status, 400);
  assert.deepEqual(refused.json, { error: { kind: 'validation', reason: 'not_supported', fields: ['kind'] } });

  assert.equal((await h.call('GET', '/v1/forwards', { token: amira.token })).json.items.length, 1);
  assert.deepEqual((await h.call('GET', '/v1/forwards', { token: ben.token })).json.items, []);
  assert.equal((await h.call('GET', '/v1/approvals', { token: amira.token })).json.items.length, 1);
  assert.deepEqual((await h.call('GET', '/v1/approvals', { token: ben.token })).json.items, []);
  const approve = await h.call('POST', '/v1/payments/anything/approve', { token: ben.token });
  assert.equal(approve.json.error.reason, 'not_supported');
});

test('a person in two companies chooses one; the session is scoped to it and only to companies they belong to', async () => {
  h = await harness();
  const dana = await signedIn(DANA);
  assert.equal(dana.session, null);
  assert.deepEqual(dana.companies, [
    { id: 'co_northfield', name: 'Northfield Trading Ltd' },
    { id: 'co_castlebrook', name: 'Castlebrook Imports Ltd' },
  ]);
  const before = await h.call('GET', '/v1/balances', { token: dana.token });
  assert.equal(before.status, 403);
  assert.equal(before.json.error.reason, 'company_not_selected');

  const pick = (token: string, companyId: string) => h.call('POST', '/v1/session/company', { token, body: { companyId } });
  assert.equal((await pick(dana.token, 'co_castlebrook')).json.company.name, 'Castlebrook Imports Ltd');
  assert.equal((await h.call('GET', '/v1/balances', { token: dana.token })).json.items[0].amount, '48250.75');
  assert.equal((await pick(dana.token, 'co_northfield')).json.capabilities.forwardContracts, true);
  assert.equal((await h.call('GET', '/v1/balances', { token: dana.token })).json.items[0].amount, '101964.00');

  // Someone who is not a member cannot select it, and cannot tell it exists.
  const amira = await signedIn(AMIRA);
  const denied = await pick(amira.token, 'co_castlebrook');
  const missing = await pick(amira.token, 'co_does_not_exist');
  assert.equal(denied.status, 404);
  assert.deepEqual(denied.json, missing.json);
  assert.equal((await h.call('GET', '/v1/balances', { token: amira.token })).json.items[0].amount, '101964.00');
});

/**
 * Both mock providers run with `enforceOwnership: false` here: handed an id,
 * they act on it whichever account it belongs to, as a provider might under a
 * master credential. So nothing in this test is proved by the mocks keeping
 * accounts apart. What stands between two companies is the server: the scope
 * it puts on every call, and its own check that an id belongs to the
 * session's company before it acts on it.
 */
for (const provider of ['currencycloud', 'equals'] as const) {
  test(`isolation (${provider}): one company cannot read, pay to, approve, reject or book with another company's ids`, async () => {
    const directory = seedDirectory();
    const mine = provider === 'currencycloud' ? { providerAccountId: 'sample-account-0001', providerContactId: 'sample-contact-0001' } : { providerAccountId: 'S00001', providerContactId: '' };
    const theirs = provider === 'currencycloud' ? { providerAccountId: 'sample-account-0002', providerContactId: 'sample-contact-0002' } : { providerAccountId: 'S00002', providerContactId: '' };
    directory.companies = [
      { id: 'co_mine', name: 'Mine Ltd', providerKey: provider, ...mine },
      { id: 'co_theirs', name: 'Theirs Ltd', providerKey: provider, ...theirs },
    ];
    directory.memberships = [
      { userId: 'usr_amira', companyId: 'co_mine', role: 'admin' },
      { userId: 'usr_ben', companyId: 'co_theirs', role: 'admin' },
    ];
    h = await harness({}, directory, { enforceOwnership: false });
    const amira = await signedIn(AMIRA);
    const ben = await signedIn(BEN);

    // Ben's company gets a payee, a payment and (provider A) a payment waiting for approval. All with ids only it has.
    const payee = { name: 'Private Supplier Ltd', entityType: 'company', currency: 'GBP', bankCountry: 'GB', accountNumber: '00000000', sortCode: '000000' };
    const created = await h.call('POST', '/v1/beneficiaries', { token: ben.token, body: payee, headers: { 'x-step-up-token': await h.stepUp(ben.token, ben.secret, 'beneficiary.create', payee) } });
    assert.equal(created.status, 200);
    const payment = await pay(ben.token, ben.secret, 'key-ben-000001', paymentBody({ beneficiaryId: created.json.id }));
    assert.equal(payment.status, 200);
    const bensPending: string[] = (await h.call('GET', '/v1/approvals', { token: ben.token })).json.items.map((row: any) => row.payment.id);
    const bensBalances = (await h.call('GET', '/v1/balances', { token: ben.token })).json;

    // READ: none of it shows up for Amira.
    const payees = (await h.call('GET', '/v1/beneficiaries', { token: amira.token })).json.items;
    assert.ok(!payees.some((row: any) => row.id === created.json.id || row.name === payee.name));
    const payments = (await h.call('GET', '/v1/payments?page=1&perPage=100', { token: amira.token })).json.items;
    assert.ok(!payments.some((row: any) => row.id === payment.json.id));
    assert.equal((await h.call('GET', '/v1/payments/by-key/key-ben-000001', { token: amira.token })).json, null);
    const pending: string[] = (await h.call('GET', '/v1/approvals', { token: amira.token })).json.items.map((row: any) => row.payment.id);
    assert.ok(!pending.some((id) => bensPending.includes(id)));

    // PAY TO their payee: refused by the server before the provider is asked to pay.
    const stolen = await pay(amira.token, amira.secret, 'key-amira-00001', paymentBody({ beneficiaryId: created.json.id }));
    assert.equal(stolen.status, 400);
    assert.deepEqual(stolen.json, { error: { kind: 'validation', fields: ['beneficiaryId'] } });
    assert.equal((await h.call('GET', '/v1/payments/by-key/key-amira-00001', { token: amira.token })).json, null);
    assert.equal((await h.call('GET', '/v1/payments/by-key/key-amira-00001', { token: ben.token })).json, null);

    // APPROVE / REJECT their payment by id.
    for (const id of provider === 'currencycloud' ? bensPending : []) {
      for (const action of ['approve', 'reject'] as const) {
        const stepUp = await h.stepUp(amira.token, amira.secret, `payment.${action}`, { paymentId: id });
        const reply = await h.call('POST', `/v1/payments/${id}/${action}`, { token: amira.token, headers: { 'x-step-up-token': stepUp } });
        assert.equal(reply.status, 404, `${action} ${id}`);
      }
    }
    if (provider === 'currencycloud') assert.ok(bensPending.length > 0);
    assert.deepEqual((await h.call('GET', '/v1/approvals', { token: ben.token })).json.items.map((row: any) => row.payment.id), bensPending);

    // BOOK with a quote held for the other company.
    const quote = (await h.call('POST', '/v1/quotes', { token: ben.token, body: { kind: 'spot', sellCurrency: 'GBP', buyCurrency: 'USD', fixedSide: 'sell', amount: '100.00' } })).json;
    const hijack = await h.call('POST', '/v1/conversions', { token: amira.token, body: { quoteId: quote.id }, headers: { 'idempotency-key': 'key-amira-00002' } });
    assert.equal(hijack.status, 409);
    assert.equal(hijack.json.error.kind, 'quote_expired');

    // Naming another company in the query, a header or the body changes nothing.
    const before = (await h.call('GET', '/v1/balances', { token: amira.token })).json;
    for (const [url, headers] of [
      [`/v1/balances?companyId=co_theirs&accountId=${theirs.providerAccountId}&on_behalf_of=${theirs.providerContactId}`, {}],
      ['/v1/balances', { 'x-company-id': 'co_theirs', 'x-account-id': theirs.providerAccountId }],
    ] as const) {
      assert.deepEqual((await h.call('GET', url, { token: amira.token, headers })).json.items.map((row: any) => row.amount), before.items.map((row: any) => row.amount));
    }
    // Ben's money is exactly where it was.
    assert.deepEqual((await h.call('GET', '/v1/balances', { token: ben.token })).json.items.map((row: any) => row.amount), bensBalances.items.map((row: any) => row.amount));

    // EVERY call the server made to the provider carried a scope, and only ever the scope of the session's company.
    if (provider === 'currencycloud') {
      assert.ok(h.providerA.seen.length > 20);
      assert.deepEqual([...new Set(h.providerA.seen.map((call) => call.onBehalfOf))].sort(), ['sample-contact-0001', 'sample-contact-0002']);
    } else {
      assert.ok(h.providerB.seen.length > 10);
      assert.deepEqual([...new Set(h.providerB.seen.map((call) => call.accountId))].sort(), ['S00001', 'S00002']);
    }
  });
}

test('isolation: a company with no provider scope gets no provider call at all (fails closed)', async () => {
  const directory = seedDirectory();
  directory.companies = [
    { id: 'co_northfield', name: 'Northfield Trading Ltd', providerKey: 'currencycloud', providerAccountId: 'sample-account-0001', providerContactId: '' },
    { id: 'co_castlebrook', name: 'Castlebrook Imports Ltd', providerKey: 'equals', providerAccountId: '', providerContactId: '' },
  ];
  h = await harness({}, directory);
  for (const email of [AMIRA, BEN]) {
    const { secret } = await h.activate(email);
    const login = await h.login(email, secret);
    // Signing in already needs the adapter (capabilities), and there is none.
    assert.equal(login.status, 502, email);
  }
  assert.deepEqual(h.providerA.seen, []);
  assert.deepEqual(h.providerB.seen, []);
  // An unknown scope is refused by the provider, and a known one is accepted.
  assert.equal(await h.registry.accountExists('currencycloud', { providerAccountId: 'sample-account-0002', providerContactId: 'sample-contact-0001' }), false);
  assert.equal(await h.registry.accountExists('currencycloud', { providerAccountId: 'sample-account-0002', providerContactId: 'sample-contact-0002' }), true);
  assert.equal(await h.registry.accountExists('equals', { providerAccountId: 'S00009', providerContactId: '' }), false);
  assert.equal(await h.registry.accountExists('equals', { providerAccountId: 'S00002', providerContactId: '' }), true);
});

test('step-up: a payment needs a token bound to this person, session, action and exact payload, once', async () => {
  h = await harness();
  await h.policy('co_northfield', 0);
  const amira = await signedIn(AMIRA);
  const body = paymentBody();
  const send = (stepUp: string | undefined, key: string, sent: object = body, token = amira.token) =>
    h.call('POST', '/v1/payments', { token, body: sent, headers: { 'idempotency-key': key, ...(stepUp ? { 'x-step-up-token': stepUp } : {}) } });
  const grant = (key: string, bound: object = body) => h.stepUp(amira.token, amira.secret, 'payment.create', { ...bound, idempotencyKey: key });
  const count = async () => (await h.call('GET', '/v1/payments?page=1&perPage=1', { token: amira.token })).json.totalItems as number;
  const before = await count();

  // Missing.
  const missing = await send(undefined, 'key-0000001');
  assert.equal(missing.status, 403);
  assert.deepEqual(missing.json, { error: { kind: 'forbidden', reason: 'step_up_required' } });
  // Made up.
  assert.equal((await send('made-up-token', 'key-0000001')).json.error.reason, 'step_up_invalid');
  // Wrong payload: a different amount, a different payee, a different idempotency key.
  assert.equal((await send(await grant('key-0000001'), 'key-0000001', paymentBody({ amount: '9125.00' }))).json.error.reason, 'step_up_invalid');
  assert.equal((await send(await grant('key-0000001'), 'key-0000001', paymentBody({ beneficiaryId: 'sample-beneficiary-brightway', currency: 'USD' }))).json.error.reason, 'step_up_invalid');
  assert.equal((await send(await grant('key-0000001'), 'key-0000002')).json.error.reason, 'step_up_invalid');
  // Wrong action: a token for approving does not send a payment.
  const approveToken = await h.stepUp(amira.token, amira.secret, 'payment.approve', { ...body, idempotencyKey: 'key-0000001' });
  assert.equal((await send(approveToken, 'key-0000001')).json.error.reason, 'step_up_invalid');
  // Expired.
  const stale = await grant('key-0000001');
  h.clock.advance(h.config.stepUpTtlMs + 1);
  assert.equal((await send(stale, 'key-0000001')).json.error.reason, 'step_up_invalid');
  // Another session of the same person.
  const elsewhere = (await h.login(AMIRA, amira.secret)).json.token as string;
  assert.equal((await send(await grant('key-0000001'), 'key-0000001', body, elsewhere)).json.error.reason, 'step_up_invalid');
  // A mismatched attempt burns the token: it does not work afterwards with the right payload.
  const burned = await grant('key-0000001');
  await send(burned, 'key-0000001', paymentBody({ amount: '9125.00' }));
  assert.equal((await send(burned, 'key-0000001')).json.error.reason, 'step_up_invalid');

  assert.equal(await count(), before, 'nothing may have been paid so far');

  // Right token: paid. Key order in the body does not matter.
  const good = await grant('key-0000001');
  const reordered = Object.fromEntries(Object.entries(body).reverse());
  const paid = await send(good, 'key-0000001', reordered);
  assert.equal(paid.status, 200);
  assert.equal(paid.json.amount, '125.00');
  assert.equal(await count(), before + 1);
  // Reuse.
  assert.equal((await send(good, 'key-0000001')).json.error.reason, 'step_up_invalid');

  // Idempotency keys pass through: the same key with a new step-up returns the same payment, not a second one.
  const repeat = await send(await grant('key-0000001'), 'key-0000001');
  assert.equal(repeat.status, 200);
  assert.equal(repeat.json.id, paid.json.id);
  assert.equal(await count(), before + 1);
  assert.equal((await h.call('GET', '/v1/payments/by-key/key-0000001', { token: amira.token })).json.id, paid.json.id);
  assert.equal((await h.call('GET', '/v1/payments/by-key/key-9999999', { token: amira.token })).json, null);
  // A payment needs a key at all.
  assert.equal((await h.call('POST', '/v1/payments', { token: amira.token, body })).json.error.fields[0], 'idempotencyKey');
});

test('step-up: wrong and reused codes are refused, and repeated wrong codes lock', async () => {
  h = await harness();
  const amira = await signedIn(AMIRA);
  const ask = (code: string) => h.call('POST', '/v1/step-up', { token: amira.token, body: { action: 'payment.approve', payload: { paymentId: 'p' }, code } });
  // The code that signed in cannot be used again.
  assert.equal((await ask(h.code(amira.secret))).json.error.reason, 'code_reused');
  assert.equal((await h.call('POST', '/v1/step-up', { body: { action: 'payment.approve', payload: {}, code: '000000' } })).status, 401);
  for (let i = 0; i < 5; i += 1) assert.equal((await ask('000000')).json.error.reason, 'invalid_code');
  const locked = await ask(h.freshCode(amira.secret));
  assert.equal(locked.status, 429);
  assert.equal(locked.json.error.reason, 'locked');
});

test('step-up: approve, reject and add payee need it; conversions do not unless the flag is on', async () => {
  h = await harness();
  const amira = await signedIn(AMIRA);
  const pending = (await h.call('GET', '/v1/approvals', { token: amira.token })).json.items[0].payment.id as string;

  assert.equal((await h.call('POST', `/v1/payments/${pending}/approve`, { token: amira.token })).json.error.reason, 'step_up_required');
  assert.equal((await h.call('POST', `/v1/payments/${pending}/reject`, { token: amira.token })).json.error.reason, 'step_up_required');
  // A token for another payment does not approve this one.
  const other = await h.stepUp(amira.token, amira.secret, 'payment.approve', { paymentId: 'some-other-payment' });
  assert.equal((await h.call('POST', `/v1/payments/${pending}/approve`, { token: amira.token, headers: { 'x-step-up-token': other } })).json.error.reason, 'step_up_invalid');
  const stepUp = await h.stepUp(amira.token, amira.secret, 'payment.approve', { paymentId: pending });
  const approved = await h.call('POST', `/v1/payments/${pending}/approve`, { token: amira.token, headers: { 'x-step-up-token': stepUp } });
  assert.equal(approved.status, 200);
  schemas.approvalResult.parse(approved.json);

  const payee = { name: 'New Payee Ltd', entityType: 'company', currency: 'GBP', bankCountry: 'GB', accountNumber: '00000000', sortCode: '000000' };
  assert.equal((await h.call('POST', '/v1/beneficiaries', { token: amira.token, body: payee })).json.error.reason, 'step_up_required');

  // Conversion: no step-up by default.
  const quoteBody = { kind: 'spot', sellCurrency: 'GBP', buyCurrency: 'USD', fixedSide: 'sell', amount: '1000.00' };
  const quote = (await h.call('POST', '/v1/quotes', { token: amira.token, body: quoteBody })).json;
  schemas.quote.parse(quote);
  const booked = await h.call('POST', '/v1/conversions', { token: amira.token, body: { quoteId: quote.id }, headers: { 'idempotency-key': 'conv-key-0001' } });
  assert.equal(booked.status, 200);
  schemas.conversion.parse(booked.json);
  assert.equal(booked.json.buyAmount, '1300.00');
  assert.equal((await h.call('GET', '/v1/conversions/by-key/conv-key-0001', { token: amira.token })).json.id, booked.json.id);
  await h.close();

  // With the flag on, the same booking needs a code.
  h = await harness({ stepUpConversions: true });
  const again = await signedIn(AMIRA);
  assert.ok(again.session.stepUpActions.includes('conversion.book'));
  // Move to an unused code first: the quote is only held for a short time, so the code is typed while it is live.
  h.clock.advance(30_000);
  const q = (await h.call('POST', '/v1/quotes', { token: again.token, body: quoteBody })).json;
  const book = (stepUpToken?: string) =>
    h.call('POST', '/v1/conversions', { token: again.token, body: { quoteId: q.id }, headers: { 'idempotency-key': 'conv-key-0002', ...(stepUpToken ? { 'x-step-up-token': stepUpToken } : {}) } });
  assert.equal((await book()).json.error.reason, 'step_up_required');
  const grant = await h.call('POST', '/v1/step-up', {
    token: again.token,
    body: { action: 'conversion.book', payload: { quoteId: q.id, idempotencyKey: 'conv-key-0002' }, code: h.code(again.secret) },
  });
  assert.equal((await book(grant.json.token)).status, 200);
});

test('the second provider: payee, stepped-up payment, idempotent retry and a conversion', async () => {
  h = await harness();
  // No approval rule: the payment goes straight to the provider, as it did before approvals existed.
  await h.policy('co_castlebrook', 0);
  const ben = await signedIn(BEN);
  const payee = { name: 'Atelier Dubois SARL', entityType: 'company', currency: 'EUR', bankCountry: 'FR', iban: 'FR1420041010050500013M02606', bic: 'SMPLFRPP' };
  const created = await h.call('POST', '/v1/beneficiaries', {
    token: ben.token,
    body: payee,
    headers: { 'x-step-up-token': await h.stepUp(ben.token, ben.secret, 'beneficiary.create', payee) },
  });
  assert.equal(created.status, 200);
  assert.equal(schemas.beneficiary.parse(created.json).iban, payee.iban);

  const body = paymentBody({ beneficiaryId: created.json.id, currency: 'EUR', amount: '900.00' });
  const paid = await pay(ben.token, ben.secret, 'key-ben-00001', body);
  assert.equal(paid.status, 200);
  assert.equal(schemas.payment.parse(paid.json).status, 'processing');
  assert.equal(paid.json.beneficiaryName, payee.name);
  const repeat = await pay(ben.token, ben.secret, 'key-ben-00001', body);
  assert.equal(repeat.json.id, paid.json.id);
  assert.equal((await h.call('GET', '/v1/payments/by-key/key-ben-00001', { token: ben.token })).json.id, paid.json.id);
  const eur = (await h.call('GET', '/v1/balances', { token: ben.token })).json.items.find((row: any) => row.currency === 'EUR');
  assert.equal(eur.amount, '131000.00');

  const tooMuch = await pay(ben.token, ben.secret, 'key-ben-00002', paymentBody({ beneficiaryId: created.json.id, currency: 'EUR', amount: '99999999.00' }));
  assert.equal(tooMuch.status, 422);
  assert.deepEqual(tooMuch.json, { error: { kind: 'insufficient_funds' } });

  const quote = (await h.call('POST', '/v1/quotes', { token: ben.token, body: { kind: 'spot', sellCurrency: 'GBP', buyCurrency: 'EUR', fixedSide: 'buy', amount: '1180.00' } })).json;
  assert.equal(schemas.quote.parse(quote).sellAmount, '1000.00');
  const book = () => h.call('POST', '/v1/conversions', { token: ben.token, body: { quoteId: quote.id }, headers: { 'idempotency-key': 'conv-ben-0001' } });
  const booked = await book();
  assert.equal(booked.status, 200);
  assert.equal((await book()).json.id, booked.json.id);
  assert.equal((await h.call('GET', '/v1/conversions/by-key/conv-ben-0001', { token: ben.token })).json.id, booked.json.id);
  assert.equal((await h.call('GET', '/v1/conversions/by-key/conv-ben-9999', { token: ben.token })).json, null);
  const gbp = (await h.call('GET', '/v1/balances', { token: ben.token })).json.items.find((row: any) => row.currency === 'GBP');
  assert.equal(gbp.amount, '47250.75');

  // A quote that has run out is refused with the neutral kind.
  const late = (await h.call('POST', '/v1/quotes', { token: ben.token, body: { kind: 'spot', sellCurrency: 'GBP', buyCurrency: 'EUR', fixedSide: 'sell', amount: '10.00' } })).json;
  h.clock.advance(13_000);
  const expired = await h.call('POST', '/v1/conversions', { token: ben.token, body: { quoteId: late.id }, headers: { 'idempotency-key': 'conv-ben-0002' } });
  assert.equal(expired.status, 409);
  assert.deepEqual(expired.json, { error: { kind: 'quote_expired' } });
});

test('roles: a creator cannot approve and an approver cannot send', async () => {
  const directory = seedDirectory();
  directory.memberships = [
    { userId: 'usr_amira', companyId: 'co_northfield', role: 'creator' },
    { userId: 'usr_dana', companyId: 'co_northfield', role: 'approver' },
  ];
  h = await harness({}, directory);
  const creator = await signedIn(AMIRA);
  const approver = await signedIn(DANA);
  const pending = (await h.call('GET', '/v1/approvals', { token: creator.token })).json.items[0].payment.id as string;
  for (const [who, url, body] of [
    [creator, `/v1/payments/${pending}/approve`, undefined],
    [creator, '/v1/step-up', { action: 'payment.approve', payload: { paymentId: pending }, code: '000000' }],
    [approver, '/v1/payments', paymentBody()],
    [approver, '/v1/quotes', { kind: 'spot', sellCurrency: 'GBP', buyCurrency: 'USD', fixedSide: 'sell', amount: '1.00' }],
  ] as const) {
    const reply = await h.call('POST', url, { token: who.token, body, headers: { 'idempotency-key': 'key-role-0001' } });
    assert.equal(reply.status, 403, url);
    assert.deepEqual(reply.json, { error: { kind: 'forbidden' } });
  }
});

test('no response ever names a provider, and CORS answers only configured origins', async () => {
  h = await harness({ corsOrigins: ['https://app.example'] });
  const amira = await signedIn(AMIRA);
  const ben = await signedIn(BEN);
  const dana = await signedIn(DANA);
  await h.call('POST', '/v1/session/company', { token: dana.token, body: { companyId: 'co_castlebrook' } });
  for (const who of [amira, ben, dana]) {
    for (const url of [
      '/v1/company',
      '/v1/balances',
      '/v1/account-details/GBP',
      '/v1/account-details/EUR',
      '/v1/account-details/XXX',
      '/v1/transactions?page=1&perPage=100',
      '/v1/rates/GBP/USD',
      '/v1/rates/GBP/ZZZ',
      '/v1/rates/EUR/USD/history',
      '/v1/beneficiaries',
      '/v1/payments?page=1&perPage=100',
      '/v1/payments/by-key/key-nothing-1',
      '/v1/conversions/by-key/key-nothing-1',
      '/v1/approvals',
      '/v1/forwards',
      '/v1/nothing-here',
    ]) {
      await h.call('GET', url, { token: who.token });
    }
    // Errors too: a bad payee, a bad quote, an unknown payment.
    await pay(who.token, who.secret, 'key-scan-0001', paymentBody({ beneficiaryId: 'nope' }));
    await h.call('POST', '/v1/quotes', { token: who.token, body: { kind: 'spot', sellCurrency: 'GBP', buyCurrency: 'ZZZ', fixedSide: 'sell', amount: '1.00' } });
    await h.call('POST', '/v1/quotes', { token: who.token, body: { kind: 'nonsense' } });
    const stepUp = await h.stepUp(who.token, who.secret, 'payment.approve', { paymentId: 'nope' });
    await h.call('POST', '/v1/payments/nope/approve', { token: who.token, headers: { 'x-step-up-token': stepUp } });
  }
  await h.call('POST', '/v1/auth/login', { body: 'not json', headers: { 'content-type': 'application/json' } });
  await h.call('GET', '/healthz');

  assert.ok(h.bodies.length > 100);
  const named = h.bodies.filter((body) => /currency\s?cloud|equals|ibanfirst|sciopay|gc partners|barclays|universe money|sample-account|S00001|dev-mock|api[_-]?key/i.test(body));
  assert.deepEqual(named, []);

  const allowed = await h.call('GET', '/healthz', { headers: { origin: 'https://app.example' } });
  assert.equal(allowed.headers['access-control-allow-origin'], 'https://app.example');
  const other = await h.call('GET', '/healthz', { headers: { origin: 'https://evil.example' } });
  assert.equal(other.headers['access-control-allow-origin'], undefined);
  const preflight = await h.call('GET', '/v1/balances', { headers: { origin: 'https://evil.example' } });
  assert.equal(preflight.headers['access-control-allow-origin'], undefined);
});
