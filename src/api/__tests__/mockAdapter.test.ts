import { createCurrencycloudMock } from '../adapters/currencycloudMock';
import { ProviderError, type ProviderErrorKind } from '../errors';
import { DEFAULT_MOCK_CONTROLS, mockControlsFromEnv, sanitizeMockControls, type MockControls } from '../mockControls';
import type { ProviderClient } from '../provider';

const START = Date.parse('2026-11-10T12:00:00.000Z');

function setup(overrides: Partial<MockControls> = {}, extra: { clientSkewMs?: number; requestTimeoutMs?: number } = {}) {
  const controls: MockControls = { ...DEFAULT_MOCK_CONTROLS, latencyMs: 0, ...overrides };
  const clock = { now: START };
  const randoms: number[] = [];
  const mock = createCurrencycloudMock({
    getControls: () => controls,
    planName: 'Business Standard',
    now: () => clock.now,
    clientNow: () => clock.now + (extra.clientSkewMs ?? 0),
    requestTimeoutMs: extra.requestTimeoutMs,
    random: () => randoms.shift() ?? 0.99,
  });
  return { ...mock, controls, clock, randoms };
}

async function signedIn(overrides: Partial<MockControls> = {}, extra: { clientSkewMs?: number; requestTimeoutMs?: number } = {}) {
  const context = setup(overrides, extra);
  const link = await context.client.requestMagicLink('Finance@Example.com');
  await context.client.verifyMagicLink(link.requestId, link.devCode ?? '');
  return context;
}

async function expectKind(promise: Promise<unknown>, kind: ProviderErrorKind): Promise<void> {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(ProviderError);
  expect((error as ProviderError).kind).toBe(kind);
}

async function balanceOf(client: ProviderClient, currency: string): Promise<string | undefined> {
  return (await client.listBalances()).find((balance) => balance.currency === currency)?.amount;
}

describe('sign-in', () => {
  it('requires a session', async () => {
    const { client } = setup();
    await expectKind(client.listBalances(), 'unauthorized');
  });

  it('signs in with a magic link, once', async () => {
    const { client } = setup();
    const link = await client.requestMagicLink('Finance@Example.com');
    expect(link.email).toBe('finance@example.com');
    await expectKind(client.verifyMagicLink(link.requestId, 'wrong'), 'unauthorized');
    const session = await client.verifyMagicLink(link.requestId, link.devCode ?? '');
    expect(session.user.email).toBe('finance@example.com');
    expect(await balanceOf(client, 'GBP')).toBe('101964.00');
    await expectKind(client.verifyMagicLink(link.requestId, link.devCode ?? ''), 'unauthorized');
  });

  it('rejects a bad email and an expired link', async () => {
    const { client, clock } = setup();
    await expectKind(client.requestMagicLink('not-an-email'), 'validation');
    const link = await client.requestMagicLink('a@b.co');
    clock.now += 16 * 60 * 1000;
    await expectKind(client.verifyMagicLink(link.requestId, link.devCode ?? ''), 'unauthorized');
  });

  it('signs out, and nothing but a new link signs back in', async () => {
    const { client } = setup();
    const link = await client.requestMagicLink('a@b.co');
    const session = await client.verifyMagicLink(link.requestId, link.devCode ?? '');
    // A session carries who the user is and nothing that could start another session.
    expect(Object.keys(session)).toEqual(['user']);
    await client.signOut();
    await expectKind(client.listBalances(), 'unauthorized');
  });
});

describe('reads', () => {
  it('serves the sample account', async () => {
    const { client } = await signedIn();
    expect(await client.getCompanyProfile()).toEqual({ id: expect.any(String), companyName: 'Northfield Trading Ltd', planName: 'Business Standard' });
    expect((await client.listBalances()).map((b) => [b.currency, b.amount])).toEqual([
      ['GBP', '101964.00'],
      ['USD', '57891.00'],
      ['EUR', '24310.50'],
    ]);
    expect((await client.getRate('GBP', 'USD')).rate).toBe('1.3');
    expect((await client.getRate('GBP', 'EUR')).rate).toBe('1.18');
    expect((await client.getRate('GBP', 'AED')).rate).toBe('4.7743');
    expect((await client.getRate('EUR', 'USD')).rate).toBe('1.1017');
    await expectKind(client.getRate('GBP', 'XXX'), 'not_found');
  });

  it('gives obviously fake account details', async () => {
    const { client } = await signedIn();
    expect(await client.getAccountDetails('GBP')).toEqual({
      currency: 'GBP',
      accountHolderName: 'Northfield Trading Ltd',
      sortCode: '000000',
      accountNumber: '00000000',
      iban: 'GB00SMPL00000000000000',
      bic: 'SMPLGB00',
    });
    await expectKind(client.getAccountDetails('JPY'), 'not_found');
  });

  it('paginates transactions newest first', async () => {
    const { client } = await signedIn();
    const first = await client.listTransactions({ page: 1, perPage: 10 });
    expect(first).toMatchObject({ page: 1, totalPages: 3, totalItems: 26, nextPage: 2 });
    expect(first.items[0]).toMatchObject({ description: 'Customer payment', direction: 'credit', amount: '42733', currency: 'GBP' });
    expect(first.items[1]).toMatchObject({ description: 'Supplier payment', direction: 'debit', amount: '24557', currency: 'USD' });
    const last = await client.listTransactions({ page: 3, perPage: 10 });
    expect(last.items).toHaveLength(6);
    expect(last.nextPage).toBeNull();
    const all = [...first.items, ...(await client.listTransactions({ page: 2, perPage: 10 })).items, ...last.items];
    expect(new Set(all.map((item) => item.id)).size).toBe(26);
    const times = all.map((item) => Date.parse(item.createdAt));
    expect([...times].sort((a, b) => b - a)).toEqual(times);
  });

  it('serves the sample forward and rate history', async () => {
    const { client } = await signedIn();
    expect(await client.listForwardContracts()).toEqual([
      expect.objectContaining({ buyCurrency: 'USD', buyAmount: '150000.00', rate: '1.2950', settlementDate: '2027-01-14', drawnAmount: '60000', remainingAmount: '90000' }),
    ]);
    const history = await client.getRateHistory('GBP', 'USD');
    expect(history.points).toHaveLength(24);
    expect(history.points.at(-1)?.rate).toBe('1.3000');
  });
});

describe('quotes and conversions', () => {
  it('quotes either side at the sample rate', async () => {
    const { client } = await signedIn();
    const sell = await client.createQuote({ kind: 'spot', sellCurrency: 'GBP', buyCurrency: 'USD', fixedSide: 'sell', amount: '25000.00' });
    expect(sell).toMatchObject({ sellAmount: '25000.00', buyAmount: '32500.00', rate: '1.3000', rateBase: 'GBP', rateQuote: 'USD' });
    expect(Date.parse(sell.expiresAt) - START).toBe(30_000);
    const buy = await client.createQuote({ kind: 'spot', sellCurrency: 'GBP', buyCurrency: 'USD', fixedSide: 'buy', amount: '1300.00' });
    expect(buy).toMatchObject({ sellAmount: '1000.00', buyAmount: '1300.00' });
    const inverse = await client.createQuote({ kind: 'spot', sellCurrency: 'USD', buyCurrency: 'GBP', fixedSide: 'sell', amount: '1300.00' });
    expect(inverse).toMatchObject({ buyAmount: '1000.00', rateBase: 'GBP', rateQuote: 'USD' });
    const yen = await client.createQuote({ kind: 'spot', sellCurrency: 'GBP', buyCurrency: 'JPY', fixedSide: 'sell', amount: '10.55' });
    expect(yen.buyAmount).toBe('2057');
  });

  it('rejects quotes it cannot make', async () => {
    const { client } = await signedIn();
    await expectKind(client.createQuote({ kind: 'spot', sellCurrency: 'GBP', buyCurrency: 'GBP', fixedSide: 'sell', amount: '1' }), 'validation');
    await expectKind(client.createQuote({ kind: 'spot', sellCurrency: 'GBP', buyCurrency: 'XXX', fixedSide: 'sell', amount: '1' }), 'validation');
    await expectKind(client.createQuote({ kind: 'spot', sellCurrency: 'JPY', buyCurrency: 'GBP', fixedSide: 'sell', amount: '0' }), 'validation');
    // Too small to be worth one minor unit on the other side.
    await expectKind(client.createQuote({ kind: 'spot', sellCurrency: 'GBP', buyCurrency: 'JPY', fixedSide: 'buy', amount: '0.4' }), 'validation');
    await expectKind(client.createQuote({ kind: 'forward', sellCurrency: 'GBP', buyCurrency: 'USD', fixedSide: 'sell', amount: '1' }), 'validation');
    await expectKind(client.createQuote({ kind: 'forward', sellCurrency: 'GBP', buyCurrency: 'USD', fixedSide: 'sell', amount: '1', settlementDate: '2020-01-01' }), 'validation');
  });

  it('a spot conversion moves both balances and appears in transactions', async () => {
    const { client } = await signedIn();
    const quote = await client.createQuote({ kind: 'spot', sellCurrency: 'GBP', buyCurrency: 'USD', fixedSide: 'sell', amount: '25000.00' });
    const conversion = await client.bookConversion({ quote, idempotencyKey: 'k1' });
    expect(conversion).toMatchObject({ kind: 'spot', status: 'settled', sellAmount: '25000.00', buyAmount: '32500.00' });
    expect(await balanceOf(client, 'GBP')).toBe('76964.00');
    expect(await balanceOf(client, 'USD')).toBe('90391.00');
    const recent = (await client.listTransactions({ page: 1, perPage: 2 })).items;
    expect(recent.map((item) => [item.kind, item.direction, item.currency, item.amount])).toEqual([
      ['conversion', 'credit', 'USD', '32500'],
      ['conversion', 'debit', 'GBP', '25000'],
    ]);
  });

  it('is idempotent: the same key books once, and a used quote cannot be reused', async () => {
    const { client } = await signedIn();
    const quote = await client.createQuote({ kind: 'spot', sellCurrency: 'GBP', buyCurrency: 'USD', fixedSide: 'sell', amount: '1000.00' });
    const first = await client.bookConversion({ quote, idempotencyKey: 'same' });
    const second = await client.bookConversion({ quote, idempotencyKey: 'same' });
    expect(second.id).toBe(first.id);
    expect(await balanceOf(client, 'GBP')).toBe('100964.00');
    await expectKind(client.bookConversion({ quote, idempotencyKey: 'different' }), 'validation');
    expect(await balanceOf(client, 'GBP')).toBe('100964.00');
  });

  it('refuses an expired quote and leaves balances alone', async () => {
    const { client, clock } = await signedIn({ quoteTtlSeconds: 10 });
    const quote = await client.createQuote({ kind: 'spot', sellCurrency: 'GBP', buyCurrency: 'USD', fixedSide: 'sell', amount: '1000.00' });
    clock.now += 9_999;
    const fresh = await client.createQuote({ kind: 'spot', sellCurrency: 'GBP', buyCurrency: 'USD', fixedSide: 'sell', amount: '5.00' });
    clock.now += 1;
    await expectKind(client.bookConversion({ quote, idempotencyKey: 'late' }), 'quote_expired');
    expect(await balanceOf(client, 'GBP')).toBe('101964.00');
    await expect(client.bookConversion({ quote: fresh, idempotencyKey: 'ok' })).resolves.toMatchObject({ sellAmount: '5.00' });
  });

  it('refuses a spot conversion larger than the balance', async () => {
    const { client } = await signedIn();
    const quote = await client.createQuote({ kind: 'spot', sellCurrency: 'EUR', buyCurrency: 'GBP', fixedSide: 'sell', amount: '24310.51' });
    await expectKind(client.bookConversion({ quote, idempotencyKey: 'big' }), 'insufficient_funds');
    expect(await balanceOf(client, 'EUR')).toBe('24310.50');
    const exact = await client.createQuote({ kind: 'spot', sellCurrency: 'EUR', buyCurrency: 'GBP', fixedSide: 'sell', amount: '24310.50' });
    await client.bookConversion({ quote: exact, idempotencyKey: 'all' });
    expect(await balanceOf(client, 'EUR')).toBe('0.00');
  });

  it('creates a balance for a currency bought for the first time', async () => {
    const { client } = await signedIn();
    const quote = await client.createQuote({ kind: 'spot', sellCurrency: 'GBP', buyCurrency: 'AED', fixedSide: 'sell', amount: '100.00' });
    await client.bookConversion({ quote, idempotencyKey: 'aed' });
    expect(await balanceOf(client, 'AED')).toBe('477.43');
  });

  it('a forward does not move balances and is listed as a contract', async () => {
    const { client } = await signedIn();
    const quote = await client.createQuote({ kind: 'forward', sellCurrency: 'GBP', buyCurrency: 'USD', fixedSide: 'buy', amount: '500000.00', settlementDate: '2027-02-10' });
    expect(quote.settlementDate).toBe('2027-02-10');
    const conversion = await client.bookConversion({ quote, idempotencyKey: 'fwd' });
    expect(conversion).toMatchObject({ kind: 'forward', status: 'pending', settlementDate: '2027-02-10' });
    expect(await balanceOf(client, 'GBP')).toBe('101964.00');
    const forwards = await client.listForwardContracts();
    expect(forwards).toHaveLength(2);
    expect(forwards[0]).toMatchObject({ buyAmount: '500000.00', drawnAmount: '0', settlementDate: '2027-02-10' });
  });
});

describe('payees and payments', () => {
  it('lists and creates payees', async () => {
    const { client } = await signedIn();
    expect((await client.listBeneficiaries()).map((payee) => payee.name)).toEqual(['Brightway Electronics Co.', 'Meridian Logistics GmbH', 'Harbour Print Ltd']);
    const created = await client.createBeneficiary({ name: 'New Supplier Ltd', entityType: 'company', currency: 'GBP', bankCountry: 'GB', sortCode: '12-34-56', accountNumber: '12345678' });
    expect(created).toMatchObject({ name: 'New Supplier Ltd', sortCode: '123456', accountNumber: '12345678' });
    expect((await client.listBeneficiaries())[0]?.id).toBe(created.id);
    await expectKind(client.createBeneficiary({ name: 'No Bank', entityType: 'company', currency: 'GBP', bankCountry: 'GB' }), 'validation');
  });

  it('has the sample payment waiting for approval', async () => {
    const { client } = await signedIn();
    const [approval, ...rest] = await client.listPendingApprovals();
    expect(rest).toEqual([]);
    expect(approval?.payment).toMatchObject({
      amount: '18400.00',
      currency: 'USD',
      beneficiaryName: 'Brightway Electronics Co.',
      reference: 'INV-2291',
      status: 'awaiting_approval',
      route: 'swift',
      fee: null,
      estimatedArrival: null,
    });
    expect(approval?.steps.map((step) => step.label)).toEqual(['Created by Accounts team', 'Waiting for you']);
    // The approver gets the payee's bank details, not just a name.
    expect(approval?.beneficiary).toMatchObject({ name: 'Brightway Electronics Co.', bankCountry: 'HK', accountNumber: '000000004471', bic: 'SMPLHKHH' });
  });

  it('approving removes it from pending, debits the balance and adds a transaction', async () => {
    const { client } = await signedIn();
    const [approval] = await client.listPendingApprovals();
    const id = approval?.payment.id ?? '';
    expect(await client.approvePayment(id)).toEqual({ status: 'processing', approvalsRemaining: 0 });
    expect(await client.listPendingApprovals()).toEqual([]);
    expect(await balanceOf(client, 'USD')).toBe('39491.00');
    expect((await client.listTransactions({ page: 1, perPage: 1 })).items[0]).toMatchObject({
      kind: 'payment',
      direction: 'debit',
      amount: '18400',
      currency: 'USD',
      description: 'Payment to Brightway Electronics Co.',
    });
    expect((await client.listPayments({ page: 1, perPage: 5 })).items.find((payment) => payment.id === id)?.status).toBe('processing');
    // A second approval must not pay twice.
    await expectKind(client.approvePayment(id), 'validation');
    expect(await balanceOf(client, 'USD')).toBe('39491.00');
  });

  it('rejecting removes it without moving money', async () => {
    const { client } = await signedIn();
    const [approval] = await client.listPendingApprovals();
    const id = approval?.payment.id ?? '';
    await client.rejectPayment(id);
    expect(await client.listPendingApprovals()).toEqual([]);
    expect(await balanceOf(client, 'USD')).toBe('57891.00');
    expect((await client.listPayments({ page: 1, perPage: 100 })).items.some((payment) => payment.id === id)).toBe(false);
    await expectKind(client.rejectPayment(id), 'not_found');
    await expectKind(client.approvePayment(id), 'validation');
    await expectKind(client.approvePayment('nope'), 'not_found');
  });

  it('will not approve a payment the balance cannot cover', async () => {
    const { client } = await signedIn();
    const quote = await client.createQuote({ kind: 'spot', sellCurrency: 'USD', buyCurrency: 'GBP', fixedSide: 'sell', amount: '50000.00' });
    await client.bookConversion({ quote, idempotencyKey: 'drain' });
    const [approval] = await client.listPendingApprovals();
    await expectKind(client.approvePayment(approval?.payment.id ?? ''), 'insufficient_funds');
    expect(await client.listPendingApprovals()).toHaveLength(1);
  });

  it('creates a payment once per idempotency key', async () => {
    const { client } = await signedIn();
    const input = { beneficiaryId: 'sample-beneficiary-harbour', amount: '250.00', currency: 'GBP', reference: 'HP-1', reason: 'HP-1', idempotencyKey: 'pay-1' };
    const first = await client.createPayment(input);
    const again = await client.createPayment(input);
    expect(again.id).toBe(first.id);
    expect(first).toMatchObject({ status: 'processing', beneficiaryName: 'Harbour Print Ltd', route: 'local', fee: null });
    expect(await balanceOf(client, 'GBP')).toBe('101714.00');
    expect((await client.listPayments({ page: 1, perPage: 1 })).items[0]?.id).toBe(first.id);
  });

  it('validates new payments', async () => {
    const { client } = await signedIn();
    const base = { beneficiaryId: 'sample-beneficiary-harbour', amount: '1.00', currency: 'GBP', reference: 'R', reason: 'R', idempotencyKey: 'v' };
    await expectKind(client.createPayment({ ...base, amount: '999999999.00' }), 'insufficient_funds');
    await expectKind(client.createPayment({ ...base, amount: '0' }), 'validation');
    await expectKind(client.createPayment({ ...base, amount: '-5' }), 'validation');
    await expectKind(client.createPayment({ ...base, currency: 'USD' }), 'validation');
    await expectKind(client.createPayment({ ...base, beneficiaryId: 'missing' }), 'validation');
    await expectKind(client.createPayment({ ...base, reference: '  ' }), 'validation');
    expect(await balanceOf(client, 'GBP')).toBe('101964.00');
  });
});

describe('failure injection', () => {
  const forced: [MockControls['forcedError'], ProviderErrorKind][] = [
    ['network', 'network'],
    ['unauthorized', 'unauthorized'],
    ['rate_limited', 'rate_limited'],
    ['server', 'server'],
    ['malformed', 'malformed_response'],
    ['wrong_shape', 'malformed_response'],
    ['lost_response', 'network'],
  ];

  it.each(forced)('forced %s becomes a typed %s error', async (forcedError, kind) => {
    const { client, controls } = await signedIn();
    controls.forcedError = forcedError;
    await expectKind(client.listBalances(), kind);
    await expectKind(client.createQuote({ kind: 'spot', sellCurrency: 'GBP', buyCurrency: 'USD', fixedSide: 'sell', amount: '1' }), kind);
    await expectKind(client.listPendingApprovals(), kind);
    controls.forcedError = 'none';
    await expect(client.listBalances()).resolves.toHaveLength(3);
  });

  it('offline is a network error', async () => {
    const { client, controls } = await signedIn();
    controls.offline = true;
    await expectKind(client.listBalances(), 'network');
  });

  it('fails at the configured rate', async () => {
    const { client, controls, randoms } = await signedIn();
    controls.failureRate = 0.5;
    randoms.push(0.4, 0.1);
    await expectKind(client.listBalances(), 'network');
    randoms.push(0.4, 0.9);
    await expectKind(client.listBalances(), 'server');
    randoms.push(0.6);
    await expect(client.listBalances()).resolves.toHaveLength(3);
  });

  it('applies latency', async () => {
    const { client, controls } = await signedIn();
    controls.latencyMs = 80;
    const started = Date.now();
    await client.listBalances();
    expect(Date.now() - started).toBeGreaterThanOrEqual(70);
  });

  it('reset restores the sample data and keeps the session', async () => {
    const { client, reset } = await signedIn();
    const quote = await client.createQuote({ kind: 'spot', sellCurrency: 'GBP', buyCurrency: 'USD', fixedSide: 'sell', amount: '1000.00' });
    await client.bookConversion({ quote, idempotencyKey: 'r' });
    reset();
    expect(await balanceOf(client, 'GBP')).toBe('101964.00');
    expect(await client.listPendingApprovals()).toHaveLength(1);
  });
});

describe('processed but response lost', () => {
  it('applies the request and then reports a network error', async () => {
    const { client, controls } = await signedIn();
    const quote = await client.createQuote({ kind: 'spot', sellCurrency: 'GBP', buyCurrency: 'USD', fixedSide: 'sell', amount: '1000.00' });
    controls.forcedError = 'lost_response';
    await expectKind(client.bookConversion({ quote, idempotencyKey: 'lost-1' }), 'network');
    controls.forcedError = 'none';
    // It happened, even though the caller was told it failed.
    expect(await balanceOf(client, 'GBP')).toBe('100964.00');
  });

  it('the server honours the conversion key: a retry with a NEW quote does not book again', async () => {
    const { client, controls } = await signedIn();
    const request = { kind: 'spot', sellCurrency: 'GBP', buyCurrency: 'USD', fixedSide: 'sell', amount: '1000.00' } as const;
    const first = await client.createQuote(request);
    controls.forcedError = 'lost_response';
    await expectKind(client.bookConversion({ quote: first, idempotencyKey: 'intent-1' }), 'network');
    controls.forcedError = 'none';

    const found = await client.findConversionByIdempotencyKey('intent-1');
    expect(found).toMatchObject({ sellAmount: '1000.00', buyAmount: '1300.00', status: 'settled' });

    const second = await client.createQuote(request);
    expect(second.id).not.toBe(first.id);
    const replay = await client.bookConversion({ quote: second, idempotencyKey: 'intent-1' });
    expect(replay.id).toBe(found?.id);
    expect(await balanceOf(client, 'GBP')).toBe('100964.00');
    expect(await balanceOf(client, 'USD')).toBe('59191.00');

    // Without the shared key the same sequence books twice. This is the bug the key prevents.
    const third = await client.createQuote(request);
    await client.bookConversion({ quote: third, idempotencyKey: 'intent-2' });
    expect(await balanceOf(client, 'GBP')).toBe('99964.00');
  });

  it('the server honours the payment key: a retry after a lost response pays once', async () => {
    const { client, controls } = await signedIn();
    const input = { beneficiaryId: 'sample-beneficiary-harbour', amount: '250.00', currency: 'GBP', reference: 'HP-1', reason: 'HP-1', idempotencyKey: 'pay-lost' };
    controls.forcedError = 'lost_response';
    await expectKind(client.createPayment(input), 'network');
    controls.forcedError = 'none';
    const found = await client.findPaymentByIdempotencyKey('pay-lost');
    expect(found).toMatchObject({ amount: '250.00', status: 'processing', beneficiaryName: 'Harbour Print Ltd' });
    const retry = await client.createPayment(input);
    expect(retry.id).toBe(found?.id);
    expect(await balanceOf(client, 'GBP')).toBe('101714.00');
  });

  it('reconciliation finds nothing for a key that was never applied', async () => {
    const { client } = await signedIn();
    expect(await client.findConversionByIdempotencyKey('never')).toBeNull();
    expect(await client.findPaymentByIdempotencyKey('never')).toBeNull();
  });

  it('a lost approval is not applied twice by a retry', async () => {
    const { client, controls } = await signedIn();
    const [approval] = await client.listPendingApprovals();
    const id = approval?.payment.id ?? '';
    controls.forcedError = 'lost_response';
    await expectKind(client.approvePayment(id), 'network');
    controls.forcedError = 'none';
    expect(await client.listPendingApprovals()).toEqual([]);
    await expectKind(client.approvePayment(id), 'validation');
    expect(await balanceOf(client, 'USD')).toBe('39491.00');
  });
});

describe('timeouts, paging and clocks', () => {
  it('gives up on a request that never answers, as an outcome-unknown timeout', async () => {
    const { client, controls } = await signedIn({}, { requestTimeoutMs: 40 });
    controls.hang = true;
    const started = Date.now();
    const error = await client.listBalances().then(
      () => null,
      (caught: unknown) => caught as ProviderError,
    );
    expect(error?.kind).toBe('timeout');
    expect(error?.outcomeUnknown).toBe(true);
    expect(Date.now() - started).toBeLessThan(2000);
    controls.hang = false;
    await expect(client.listBalances()).resolves.toHaveLength(3);
  });

  it('reads every page of payees, not just the first 100', async () => {
    const { client } = await signedIn();
    for (let index = 0; index < 120; index += 1) {
      await client.createBeneficiary({ name: `Supplier ${index}`, entityType: 'company', currency: 'GBP', bankCountry: 'GB', sortCode: '123456', accountNumber: '12345678' });
    }
    const all = await client.listBeneficiaries();
    expect(all).toHaveLength(123);
    expect(new Set(all.map((payee) => payee.id)).size).toBe(123);
    // A pending payment to a payee beyond the first page still resolves its details.
    expect((await client.listPendingApprovals())[0]?.beneficiary?.name).toBe('Brightway Electronics Co.');
  });

  it('runs the quote countdown on the device clock, keeping the hold length from the server', async () => {
    const skew = -5 * 60 * 1000; // this phone is five minutes slow
    const { client } = await signedIn({ quoteTtlSeconds: 30 }, { clientSkewMs: skew });
    const quote = await client.createQuote({ kind: 'spot', sellCurrency: 'GBP', buyCurrency: 'USD', fixedSide: 'sell', amount: '1.00' });
    expect(Date.parse(quote.expiresAt) - (START + skew)).toBe(30_000);
    expect(Date.parse(quote.expiresAt) - Date.parse(quote.createdAt)).toBe(30_000);
  });

  it('a payment needing two approvals stays pending after the first', async () => {
    const { client } = await signedIn();
    const [approval] = await client.listPendingApprovals();
    const id = approval?.payment.id ?? '';
    // Reach into the mock: make the sample payment need two approvals.
    const spy = jest.spyOn(client, 'approvePayment');
    spy.mockRestore();
    const server = (client as unknown as { transport: { state: { payments: { id: string; authorisation_steps_required: string }[] } } }).transport;
    const row = server.state.payments.find((payment) => payment.id === id);
    if (row) row.authorisation_steps_required = '2';
    expect(await client.approvePayment(id)).toEqual({ status: 'awaiting_approval', approvalsRemaining: 1 });
    expect(await balanceOf(client, 'USD')).toBe('57891.00');
    expect(await client.approvePayment(id)).toEqual({ status: 'processing', approvalsRemaining: 0 });
    expect(await balanceOf(client, 'USD')).toBe('39491.00');
  });
});

describe('mock controls', () => {
  it('reads and clamps environment values', () => {
    expect(mockControlsFromEnv({})).toEqual(DEFAULT_MOCK_CONTROLS);
    expect(
      mockControlsFromEnv({
        EXPO_PUBLIC_MOCK_LATENCY_MS: '1200',
        EXPO_PUBLIC_MOCK_FAILURE_RATE: '0.25',
        EXPO_PUBLIC_MOCK_FORCE_ERROR: 'RATE_LIMITED',
        EXPO_PUBLIC_MOCK_QUOTE_TTL_S: '10',
        EXPO_PUBLIC_MOCK_OFFLINE: '1',
      }),
    ).toEqual({ latencyMs: 1200, failureRate: 0.25, forcedError: 'rate_limited', quoteTtlSeconds: 10, offline: true });
    expect(mockControlsFromEnv({ EXPO_PUBLIC_MOCK_FORCE_ERROR: 'lost_response' }).forcedError).toBe('lost_response');
    expect(mockControlsFromEnv({ EXPO_PUBLIC_MOCK_LATENCY_MS: 'fast', EXPO_PUBLIC_MOCK_FAILURE_RATE: '7', EXPO_PUBLIC_MOCK_FORCE_ERROR: 'boom', EXPO_PUBLIC_MOCK_QUOTE_TTL_S: '0' })).toEqual({
      ...DEFAULT_MOCK_CONTROLS,
      failureRate: 1,
      quoteTtlSeconds: 1,
    });
  });

  it('sanitises anything the panel could send', () => {
    expect(sanitizeMockControls({ latencyMs: -5, failureRate: Number.NaN, quoteTtlSeconds: 1e9, forcedError: 'x' as never })).toEqual({
      latencyMs: 0,
      failureRate: 0,
      forcedError: 'none',
      quoteTtlSeconds: 3600,
      offline: false,
    });
  });
});
