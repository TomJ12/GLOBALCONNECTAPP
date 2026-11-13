import { CurrencycloudClient } from '../adapters/currencycloud/client';
import { MockCurrencycloudServer } from '../adapters/currencycloud/mockServer';
import { createDemoBackend } from '../adapters/demoBackend';
import { ProviderError, type ProviderErrorKind } from '../errors';
import { DEFAULT_MOCK_CONTROLS, mockControlsFromEnv, sanitizeMockControls, type MockControls } from '../mockControls';
import type { ProviderClient } from '../provider';

const START = Date.parse('2026-11-10T12:00:00.000Z');

function setup(overrides: Partial<MockControls> = {}, extra: { clientSkewMs?: number; requestTimeoutMs?: number } = {}) {
  const controls: MockControls = { ...DEFAULT_MOCK_CONTROLS, latencyMs: 0, ...overrides };
  const clock = { now: START };
  const randoms: number[] = [];
  const mock = createDemoBackend({
    getControls: () => controls,
    planName: 'Business Standard',
    now: () => clock.now,
    clientNow: () => clock.now + (extra.clientSkewMs ?? 0),
    requestTimeoutMs: extra.requestTimeoutMs,
    random: () => randoms.shift() ?? 0.99,
  });
  return { ...mock, client: mock.client as CurrencycloudClient, controls, clock, randoms };
}

async function signedIn(overrides: Partial<MockControls> = {}, extra: { clientSkewMs?: number; requestTimeoutMs?: number } = {}) {
  const context = setup(overrides, extra);
  await context.client.authenticate('Finance@Example.com', 'test-api-key');
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

type Spied = { transport: { request: (request: { path: string }) => Promise<unknown> } };
const spyOnTransport = (client: ProviderClient) => jest.spyOn((client as unknown as Spied).transport, 'request');

describe('provider session', () => {
  it('requires a session', async () => {
    const { client } = setup();
    await expectKind(client.listBalances(), 'unauthorized');
  });

  it('opens a provider session with API credentials, and refuses empty ones', async () => {
    const { client } = setup();
    await expectKind(client.authenticate('', 'key'), 'unauthorized');
    await expectKind(client.authenticate('finance@example.com', ''), 'unauthorized');
    await expectKind(client.listBalances(), 'unauthorized');
    await client.authenticate('Finance@Example.com', 'test-api-key');
    expect(await balanceOf(client, 'GBP')).toBe('101964.00');
  });

  it('closing the session ends it', async () => {
    const { client } = await signedIn();
    await client.closeSession();
    await expectKind(client.listBalances(), 'unauthorized');
  });

  it('labels a page of payments by looking up only the payees on it, then uses the cache', async () => {
    const { client } = await signedIn();
    for (let index = 0; index < 150; index += 1) {
      await client.createBeneficiary({ name: `Supplier ${index}`, entityType: 'company', currency: 'GBP', bankCountry: 'GB', sortCode: '123456', accountNumber: '12345678' });
    }
    await client.closeSession(); // empties the payee cache
    await client.authenticate('finance@example.com', 'test-api-key');

    const requests = spyOnTransport(client);
    const page = await client.listPayments({ page: 1, perPage: 25 });
    expect(page.items.every((payment) => payment.beneficiaryName !== null)).toBe(true);
    const paths = requests.mock.calls.map(([request]) => request.path);
    // One request for the page, plus one per DISTINCT payee on it (three in the sample data). Never the whole list.
    expect(paths.filter((path) => path === '/v2/beneficiaries/find')).toEqual([]);
    expect(paths.filter((path) => /^\/v2\/beneficiaries\/[^/]+$/.test(path))).toHaveLength(3);
    expect(paths).toHaveLength(4);

    requests.mockClear();
    await client.listPayments({ page: 1, perPage: 25 });
    expect(requests).toHaveBeenCalledTimes(1);
  });

  it('reaching the page cap truncates the payee list instead of failing, and payments still load', async () => {
    const controls: MockControls = { ...DEFAULT_MOCK_CONTROLS, latencyMs: 0 };
    const server = new MockCurrencycloudServer({ getControls: () => controls });
    const client = new CurrencycloudClient(server, { planName: null, maxPages: 2 });
    await client.authenticate('finance@example.com', 'test-api-key');
    for (let index = 0; index < 250; index += 1) {
      await client.createBeneficiary({ name: `Supplier ${index}`, entityType: 'company', currency: 'GBP', bankCountry: 'GB', sortCode: '123456', accountNumber: '12345678' });
    }
    const payees = await client.listBeneficiaries();
    expect(payees.truncated).toBe(true);
    expect(payees.items).toHaveLength(200);
    // The sample payees are beyond the cap (oldest, so last). Payments and approvals still resolve them.
    expect((await client.listPayments({ page: 1, perPage: 25 })).items[0]?.beneficiaryName).toBe('Brightway Electronics Co.');
    expect((await client.listPendingApprovals())[0]?.beneficiary?.name).toBe('Brightway Electronics Co.');
  });

  it('approvals always read the payee fresh, never from the cache', async () => {
    const { client } = await signedIn();
    await client.listPendingApprovals();
    const requests = spyOnTransport(client);
    await client.listPendingApprovals();
    expect(requests.mock.calls.map(([request]) => request.path)).toContain('/v2/beneficiaries/sample-beneficiary-brightway');
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
    expect(all.truncated).toBe(false);
    expect(all.items).toHaveLength(123);
    expect(new Set(all.items.map((payee) => payee.id)).size).toBe(123);
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
    ).toEqual({ ...DEFAULT_MOCK_CONTROLS, latencyMs: 1200, failureRate: 0.25, forcedError: 'rate_limited', quoteTtlSeconds: 10, offline: true });
    expect(mockControlsFromEnv({ EXPO_PUBLIC_MOCK_FORCE_ERROR: 'forbidden', EXPO_PUBLIC_MOCK_FAIL_WRITES_ONLY: '1' })).toMatchObject({ forcedError: 'forbidden', failWritesOnly: true });
    expect(mockControlsFromEnv({ EXPO_PUBLIC_MOCK_FORCE_ERROR: 'lost_response' }).forcedError).toBe('lost_response');
    expect(mockControlsFromEnv({ EXPO_PUBLIC_MOCK_LATENCY_MS: 'fast', EXPO_PUBLIC_MOCK_FAILURE_RATE: '7', EXPO_PUBLIC_MOCK_FORCE_ERROR: 'boom', EXPO_PUBLIC_MOCK_QUOTE_TTL_S: '0' })).toEqual({
      ...DEFAULT_MOCK_CONTROLS,
      failureRate: 1,
      quoteTtlSeconds: 1,
    });
  });

  it('sanitises anything the panel could send', () => {
    expect(sanitizeMockControls({ latencyMs: -5, failureRate: Number.NaN, quoteTtlSeconds: 1e9, forcedError: 'x' as never, lateApplyMs: -1 })).toEqual({
      latencyMs: 0,
      failureRate: 0,
      forcedError: 'none',
      quoteTtlSeconds: 3600,
      offline: false,
      failWritesOnly: false,
      lateApplyMs: 0,
    });
  });
});
