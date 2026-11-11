/**
 * The single place that decides which backend the app talks to.
 *
 * TO USE A REAL PROVIDER: change `createProviderBackend` below (and only that)
 * to build a real adapter that implements ProviderClient. Nothing else in the
 * app imports an adapter. See README, "Replacing the mock adapter".
 */
import { SAMPLE_PLAN_NAME } from '@/config/app';
import { useDevSettings } from '@/state/devSettings';

import { createCurrencycloudMock } from './adapters/currencycloudMock';
import type { ProviderClient } from './provider';

interface ProviderBackend {
  client: ProviderClient;
  /** Present only for mock backends. */
  resetSampleData?: () => void;
  isMock: boolean;
}

function createProviderBackend(): ProviderBackend {
  const mock = createCurrencycloudMock({
    getControls: () => useDevSettings.getState().controls,
    planName: SAMPLE_PLAN_NAME,
  });
  return { client: mock.client, resetSampleData: mock.reset, isMock: true };
}

let backend: ProviderBackend | null = null;

function getBackend(): ProviderBackend {
  backend ??= createProviderBackend();
  return backend;
}

export function getProviderClient(): ProviderClient {
  return getBackend().client;
}

/** True while the app is running against sample data. */
export function isMockBackend(): boolean {
  return getBackend().isMock;
}

/** Developer panel: restore the mock's sample data. No-op for a real backend. */
export function resetSampleData(): void {
  getBackend().resetSampleData?.();
}

/** Tests only: install a specific client, or pass null to rebuild the default. */
export function setProviderBackendForTests(
  client: ProviderClient | null,
  options: { resetSampleData?: () => void; isMock?: boolean } = {},
): void {
  backend = client ? { client, resetSampleData: options.resetSampleData, isMock: options.isMock ?? true } : null;
}

export * from './errors';
export type { ProviderClient } from './provider';
export type * from './types';
