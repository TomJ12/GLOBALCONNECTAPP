import { GlobalConnectApi } from '../adapters/globalConnectApi';
import type { NewPayment } from '../types';

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

const SESSION = {
  user: { id: 'u1', email: 'a@b.example', displayName: 'A' },
  company: { id: 'co1', name: 'Co Ltd' },
  role: 'admin',
  capabilities: { forwardContracts: false, paymentApprovals: true },
  stepUpActions: ['payment.create'],
};
const PAYMENT = {
  id: 'p1',
  shortReference: 'R1',
  amount: '10.00',
  currency: 'GBP',
  beneficiaryId: 'b1',
  beneficiaryName: 'B',
  reference: 'ref',
  status: 'processing',
  route: null,
  fee: null,
  estimatedArrival: null,
  createdAt: '2026-11-11T10:00:00.000Z',
};

function setup(routes: Record<string, { status?: number; body: unknown } | (() => never)>) {
  const calls: Call[] = [];
  const fakeFetch = (async (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => {
    calls.push({ url, method: init.method, headers: init.headers, body: init.body ? JSON.parse(init.body) : undefined });
    const route = routes[`${init.method} ${url.replace('https://api.test/v1', '')}`];
    if (!route) return { status: 404, text: async () => JSON.stringify({ error: { kind: 'not_found' } }) };
    if (typeof route === 'function') return route();
    return { status: route.status ?? 200, text: async () => (typeof route.body === 'string' ? route.body : JSON.stringify(route.body)) };
  }) as unknown as typeof fetch;
  return { api: new GlobalConnectApi({ baseUrl: 'https://api.test/', fetch: fakeFetch }), calls };
}

const signedIn = { 'POST /auth/login/verify': { body: { token: 't'.repeat(40), user: SESSION.user, companies: [SESSION.company], session: SESSION } } };
const input: NewPayment = { beneficiaryId: 'b1', amount: '10.00', currency: 'GBP', reference: 'ref', reason: 'ref', idempotencyKey: 'payment-key-1' };

describe('GlobalConnectApi', () => {
  it('keeps the session token to itself and sends it as a bearer token', async () => {
    const { api, calls } = setup({ ...signedIn, 'GET /balances': { body: { items: [], truncated: false } } });
    const result = await api.completeSignIn('c1', ' 123456 ', 'totp');
    expect(JSON.stringify(result)).not.toContain('tttt');
    expect(calls[0]?.body).toEqual({ challengeId: 'c1', code: '123456', method: 'totp' });
    expect(calls[0]?.headers.Authorization).toBeUndefined();
    await api.listBalances();
    expect(calls[1]?.headers.Authorization).toBe(`Bearer ${'t'.repeat(40)}`);
    await api.signOut();
    expect(calls[2]).toMatchObject({ url: 'https://api.test/v1/auth/logout', method: 'POST' });
    await api.listBalances();
    expect(calls[3]?.headers.Authorization).toBeUndefined();
  });

  it('attaches a step-up permission only to the exact payload it was granted for, once', async () => {
    const { api, calls } = setup({
      ...signedIn,
      'POST /step-up': { body: { token: 's'.repeat(40), expiresInSeconds: 120 } },
      'POST /payments': { body: PAYMENT },
    });
    await api.completeSignIn('c1', '123456', 'totp');
    await api.authorizeAction('payment.create', input, '654321');
    expect(calls[1]?.body).toEqual({ action: 'payment.create', payload: input, code: '654321' });

    // A different amount does not get the token.
    await api.createPayment({ ...input, amount: '99.00' });
    expect(calls[2]?.headers['X-Step-Up-Token']).toBeUndefined();
    await api.createPayment(input);
    expect(calls[3]?.headers).toMatchObject({ 'X-Step-Up-Token': 's'.repeat(40), 'Idempotency-Key': 'payment-key-1' });
    expect(calls[3]?.body).toEqual({ beneficiaryId: 'b1', amount: '10.00', currency: 'GBP', reference: 'ref', reason: 'ref' });
    await api.createPayment(input);
    expect(calls[4]?.headers['X-Step-Up-Token']).toBeUndefined();
  });

  it('maps server errors to the neutral kinds and reasons, and bad responses to malformed_response', async () => {
    const { api } = setup({
      'POST /auth/login': { status: 429, body: { error: { kind: 'rate_limited', reason: 'locked', retryAfterSeconds: 120 } } },
      'GET /balances': { status: 401, body: { error: { kind: 'unauthorized' } } },
      'GET /company': { body: { unexpected: true } },
      'GET /forwards': { body: '{"items": [' },
      'GET /beneficiaries': { status: 502, body: '<html>bad gateway</html>' },
      'GET /approvals': () => {
        throw new TypeError('Network request failed');
      },
    });
    await expect(api.signIn('A@B.example', 'pw')).rejects.toMatchObject({ kind: 'rate_limited', reason: 'locked', retryAfterSeconds: 120 });
    await expect(api.listBalances()).rejects.toMatchObject({ kind: 'unauthorized' });
    await expect(api.getCompanyProfile()).rejects.toMatchObject({ kind: 'malformed_response' });
    await expect(api.listForwardContracts()).rejects.toMatchObject({ kind: 'malformed_response' });
    await expect(api.listBeneficiaries()).rejects.toMatchObject({ kind: 'server', outcomeUnknown: true });
    await expect(api.listPendingApprovals()).rejects.toMatchObject({ kind: 'network' });
    await expect(api.getRate('GBP', 'USD')).rejects.toMatchObject({ kind: 'not_found' });
  });

  it('times out a request that never answers', async () => {
    const hang = ((_url: string, init: { signal: AbortSignal }) =>
      new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted'))))) as unknown as typeof fetch;
    const api = new GlobalConnectApi({ baseUrl: 'https://api.test', fetch: hang, requestTimeoutMs: 30 });
    await expect(api.listBalances()).rejects.toMatchObject({ kind: 'timeout', outcomeUnknown: true });
  });
});
