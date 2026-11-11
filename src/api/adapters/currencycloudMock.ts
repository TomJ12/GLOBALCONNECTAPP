/**
 * The mock adapter: the Currencycloud-shaped client wired to an in-memory
 * server. Nothing here touches the network.
 *
 *   screens -> ProviderClient -> CurrencycloudClient -> Transport
 *                                 (validate + map)      (MockCurrencycloudServer)
 *
 * A real adapter keeps CurrencycloudClient, raw.ts and mapping.ts and replaces
 * only the Transport with one that calls the provider over HTTPS.
 */
import type { MockControls } from '../mockControls';
import type { ProviderClient } from '../provider';
import { CurrencycloudClient } from './currencycloud/client';
import { MOCK_MAGIC_LINK_CODE, MockCurrencycloudServer } from './currencycloud/mockServer';

export interface CurrencycloudMockOptions {
  getControls: () => MockControls;
  planName: string | null;
  /** Server clock. */
  now?: () => number;
  /** Device clock, when a test wants it to differ from the server's. Defaults to `now`. */
  clientNow?: () => number;
  requestTimeoutMs?: number;
  random?: () => number;
}

export interface CurrencycloudMock {
  client: ProviderClient;
  /** Restore the sample data. */
  reset: () => void;
}

export function createCurrencycloudMock(options: CurrencycloudMockOptions): CurrencycloudMock {
  const server = new MockCurrencycloudServer({
    getControls: options.getControls,
    now: options.now,
    random: options.random,
  });
  const client = new CurrencycloudClient(server, {
    planName: options.planName,
    devMagicLinkCode: MOCK_MAGIC_LINK_CODE,
    now: options.clientNow ?? options.now,
    requestTimeoutMs: options.requestTimeoutMs,
  });
  return { client, reset: () => server.reset() };
}
