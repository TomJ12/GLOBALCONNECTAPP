/**
 * Provider A: the Currencycloud-shaped adapter. The client, the wire schemas,
 * the mapping and the in-memory mock are the app's own files under
 * src/api/adapters/currencycloud, imported, not copied.
 *
 * MOCK: each company gets its own in-memory provider account with the sample
 * data. For the real API, replace `transportFor` with an HTTPS Transport; the
 * client must then also send `on_behalf_of` with the company's contact id on
 * every call, which it does not do yet.
 */
import { CurrencycloudClient } from '@/api/adapters/currencycloud/client';
import { MockCurrencycloudServer } from '@/api/adapters/currencycloud/mockServer';
import type { Transport } from '@/api/adapters/currencycloud/transport';
import { DEFAULT_MOCK_CONTROLS } from '@/api/mockControls';

import type { CompanyRecord } from '../store/types';
import type { ProviderAdapter, ProviderFactory } from './adapter';

export interface CurrencycloudFactoryOptions {
  credentials: { loginId: string; apiKey: string } | null;
  /** The wire for one company's account. Defaults to an in-memory mock per company. */
  transportFor?: (company: CompanyRecord) => Transport;
  now?: () => number;
}

export function currencycloudFactory(options: CurrencycloudFactoryOptions): ProviderFactory {
  const mocks = new Map<string, Transport>();
  const mockFor = (company: CompanyRecord): Transport => {
    let mock = mocks.get(company.providerAccountId);
    if (!mock) {
      mock = new MockCurrencycloudServer({ getControls: () => ({ ...DEFAULT_MOCK_CONTROLS, latencyMs: 0 }), now: options.now });
      mocks.set(company.providerAccountId, mock);
    }
    return mock;
  };

  return async (company) => {
    if (!options.credentials) throw new Error('Provider credentials are not configured');
    const client = new CurrencycloudClient((options.transportFor ?? mockFor)(company), { planName: null, now: options.now });
    await client.authenticate(options.credentials.loginId, options.credentials.apiKey);
    const adapter: ProviderAdapter = Object.assign(client, { capabilities: { forwardContracts: true, paymentApprovals: true } });
    return adapter;
  };
}
