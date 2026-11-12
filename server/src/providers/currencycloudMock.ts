/**
 * MOCK of provider A as the server sees it: ONE platform, one set of API
 * credentials, several client accounts. Every call after login must say which
 * client it is for (`on_behalf_of` = that client's contact id); a call without
 * it, or for an unknown contact, is refused. Each account's data is the app's
 * own sample mock (src/api/adapters/currencycloud/mockServer.ts), with ids
 * that are unique across accounts.
 *
 * `enforceOwnership: false` models a provider that, given the master
 * credential, will act on ANY id it is handed whatever the scope says. The
 * isolation tests run in that mode, so what they prove is the server's own
 * ownership checks and not this mock's separation.
 */
import { MockCurrencycloudServer } from '@/api/adapters/currencycloud/mockServer';
import type { Transport, TransportRequest, TransportResponse } from '@/api/adapters/currencycloud/transport';
import { DEFAULT_MOCK_CONTROLS } from '@/api/mockControls';

export interface MockAccountA {
  accountId: string;
  contactId: string;
}

/** Accounts the mock platform knows. A company can only be mapped to one of these. */
export const MOCK_ACCOUNTS_A: MockAccountA[] = [
  { accountId: 'sample-account-0001', contactId: 'sample-contact-0001' },
  { accountId: 'sample-account-0002', contactId: 'sample-contact-0002' },
  { accountId: 'sample-account-0003', contactId: 'sample-contact-0003' },
];

const BY_ID = [/^\/v2\/payments\/authorise$/, /^\/v2\/payments\/create$/, /^\/v2\/payments\/[^/]+\/delete$/, /^\/v2\/beneficiaries\/[^/]+$/, /^\/v2\/conversions\/create$/];
const error = (status: number, code: string): TransportResponse => ({
  status,
  body: JSON.stringify({ error_code: code, error_messages: { base: [{ code, message: code.replace(/_/g, ' '), params: {} }] } }),
});

interface Held {
  account: MockAccountA;
  mock: MockCurrencycloudServer;
  token: string | null;
}

export class MockCurrencycloudPlatform implements Transport {
  private readonly accounts = new Map<string, Held>();
  private readonly tokens = new Set<string>();
  private readonly enforceOwnership: boolean;
  /** Every request received, for tests: path and the scope it carried. */
  readonly seen: { path: string; onBehalfOf: string | undefined }[] = [];

  constructor(options: { accounts?: MockAccountA[]; now?: () => number; enforceOwnership?: boolean } = {}) {
    this.enforceOwnership = options.enforceOwnership ?? true;
    for (const [index, account] of (options.accounts ?? MOCK_ACCOUNTS_A).entries()) {
      const mock = new MockCurrencycloudServer({ getControls: () => ({ ...DEFAULT_MOCK_CONTROLS, latencyMs: 0 }), now: options.now, idNamespace: `a${index + 1}-` });
      this.accounts.set(account.contactId, { account, mock, token: null });
    }
  }

  private async forward(held: Held, request: TransportRequest): Promise<TransportResponse> {
    if (!held.token) {
      const login = await held.mock.request({ method: 'POST', path: '/v2/authenticate/api', params: { login_id: held.account.contactId, api_key: 'platform' } });
      held.token = (JSON.parse(login.body) as { auth_token: string }).auth_token;
    }
    const { on_behalf_of: _scope, ...params } = request.params ?? {};
    return held.mock.request({ ...request, params, token: held.token });
  }

  async request(request: TransportRequest): Promise<TransportResponse> {
    const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);
    if (request.method === 'POST' && request.path === '/v2/authenticate/api') {
      if (!first(request.params?.login_id) || !first(request.params?.api_key)) return error(401, 'auth_failed');
      const token = `platform-token-${this.tokens.size + 1}`;
      this.tokens.add(token);
      return { status: 200, body: JSON.stringify({ auth_token: token }) };
    }
    if (!request.token || !this.tokens.has(request.token)) return error(401, 'auth_failed');
    if (request.path === '/v2/authenticate/close_session') {
      this.tokens.delete(request.token);
      return { status: 200, body: '{}' };
    }

    const scope = first(request.params?.on_behalf_of);
    this.seen.push({ path: request.path, onBehalfOf: scope });
    if (!scope) return error(400, 'on_behalf_of_is_required');
    const held = this.accounts.get(scope);
    if (!held) return error(403, 'permission_denied');

    const account = /^\/v2\/accounts\/([^/]+)$/.exec(request.path);
    if (request.method === 'GET' && account && account[1] !== 'current') {
      if (account[1] !== held.account.accountId) return error(404, 'account_not_found');
      const current = await this.forward(held, { ...request, path: '/v2/accounts/current' });
      return { status: current.status, body: JSON.stringify({ ...(JSON.parse(current.body) as object), id: held.account.accountId }) };
    }

    const response = await this.forward(held, request);
    if (this.enforceOwnership || response.status < 400 || response.status >= 500 || !BY_ID.some((pattern) => pattern.test(request.path))) return response;
    // Lax mode: the id was not in the scoped account, so act on it wherever it lives.
    for (const other of this.accounts.values()) {
      if (other === held) continue;
      const elsewhere = await this.forward(other, request);
      if (elsewhere.status < 300) return elsewhere;
    }
    return response;
  }
}
