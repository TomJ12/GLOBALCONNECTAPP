/**
 * Provider A: the Currencycloud-shaped adapter. The client, the wire schemas
 * and the mapping are the app's own files under src/api/adapters/currencycloud,
 * imported, not copied.
 *
 * One set of API credentials serves every client, so the scope is everything:
 * each adapter is built with its company's contact id and the client sends it
 * as `on_behalf_of` with every call. A company without a contact id gets no
 * adapter (it fails closed).
 *
 * MOCK unless `transport` is given: one in-memory platform holding several
 * accounts (currencycloudMock.ts). The server refuses to start on it outside
 * development mode.
 */
import { CurrencycloudClient } from '@/api/adapters/currencycloud/client';
import type { Transport } from '@/api/adapters/currencycloud/transport';

import type { ProviderAdapter, ProviderFactory, ProviderMapping } from './adapter';
import { MockCurrencycloudPlatform } from './currencycloudMock';

export interface CurrencycloudFactoryOptions {
  credentials: { loginId: string; apiKey: string } | null;
  /** The wire to the provider. Defaults to the in-memory mock platform. */
  transport?: Transport;
  now?: () => number;
}

export function currencycloudFactory(options: CurrencycloudFactoryOptions): ProviderFactory {
  const transport = options.transport ?? new MockCurrencycloudPlatform({ now: options.now });
  const mock = options.transport === undefined || options.transport instanceof MockCurrencycloudPlatform;

  const clientFor = async (mapping: ProviderMapping): Promise<CurrencycloudClient> => {
    if (!options.credentials) throw new Error('Provider credentials are not configured');
    if (!mapping.providerContactId || !mapping.providerAccountId) throw new Error('This company has no provider account scope; refusing to call the provider without one');
    const client = new CurrencycloudClient(transport, { planName: null, now: options.now, onBehalfOf: mapping.providerContactId });
    await client.authenticate(options.credentials.loginId, options.credentials.apiKey);
    return client;
  };

  return {
    mock,
    async forCompany(company) {
      const client = await clientFor(company);
      const adapter: ProviderAdapter = Object.assign(client, { capabilities: { forwardContracts: true, paymentApprovals: true } });
      return adapter;
    },
    async accountExists(mapping) {
      if (!mapping.providerContactId || !mapping.providerAccountId) return false;
      return (await clientFor(mapping)).accountExists(mapping.providerAccountId);
    },
  };
}
