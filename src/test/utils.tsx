import { QueryClientProvider, type QueryClient } from '@tanstack/react-query';
import { render } from '@testing-library/react-native';
import type { ReactElement } from 'react';

import { setProviderBackendForTests } from '@/api';
import { createCurrencycloudMock, type CurrencycloudMock } from '@/api/adapters/currencycloudMock';
import type { MockControls } from '@/api/mockControls';
import type { ProviderClient } from '@/api/provider';
import { ConfirmDialogHost, ToastHost } from '@/components/Overlays';
import { outcomeCheckTiming } from '@/config/app';
import { createQueryClient } from '@/lib/queryClient';
import { useDevSettings } from '@/state/devSettings';

export const FAST_CONTROLS: MockControls = {
  latencyMs: 0,
  failureRate: 0,
  forcedError: 'none',
  quoteTtlSeconds: 30,
  offline: false,
  failWritesOnly: false,
  lateApplyMs: 3000,
};

/** A device secret for tests that talk to the client directly. */
export const TEST_DEVICE_SECRET = 'a'.repeat(64);

const REAL_TIMING = { ...outcomeCheckTiming };

/** Shorten the processing window so tests of unknown outcomes run in milliseconds. Restored after each test. */
export function setOutcomeTiming(windowMs: number, intervalMs: number): void {
  outcomeCheckTiming.windowMs = windowMs;
  outcomeCheckTiming.intervalMs = intervalMs;
}

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function setControls(patch: Partial<MockControls>): void {
  useDevSettings.getState().setControls(patch);
}

/** A fresh mock backend, driven by the dev-settings store, installed as the app's backend. */
export function installMockBackend(controls: Partial<MockControls> = {}): CurrencycloudMock {
  useDevSettings.setState({ controls: { ...FAST_CONTROLS, ...controls } });
  const mock = createCurrencycloudMock({
    getControls: () => useDevSettings.getState().controls,
    planName: 'Business Standard',
  });
  setProviderBackendForTests(mock.client, { resetSampleData: mock.reset });
  return mock;
}

export async function signIn(client: ProviderClient, email = 'tester@example.com'): Promise<void> {
  const link = await client.requestMagicLink(email, TEST_DEVICE_SECRET);
  await client.verifyMagicLink(link.requestId, link.devCode ?? '', TEST_DEVICE_SECRET);
}

const createdClients: QueryClient[] = [];

// Cached queries hold timers; clear them so Jest can exit.
afterEach(() => {
  for (const client of createdClients.splice(0)) client.clear();
  Object.assign(outcomeCheckTiming, REAL_TIMING);
  jest.restoreAllMocks();
});

export async function renderScreen(ui: ReactElement): Promise<{ queryClient: QueryClient }> {
  const queryClient = createQueryClient({ forTests: true });
  createdClients.push(queryClient);
  await render(
    <QueryClientProvider client={queryClient}>
      {ui}
      <ConfirmDialogHost />
      <ToastHost />
    </QueryClientProvider>,
  );
  return { queryClient };
}
