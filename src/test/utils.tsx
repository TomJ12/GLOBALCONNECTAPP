import { QueryClientProvider, type QueryClient } from '@tanstack/react-query';
import { render } from '@testing-library/react-native';
import type { ReactElement } from 'react';

import { setProviderBackendForTests } from '@/api';
import type { CurrencycloudClient } from '@/api/adapters/currencycloud/client';
import { createDemoBackend, type DemoBackend } from '@/api/adapters/demoBackend';
import type { MockControls } from '@/api/mockControls';
import type { ProviderClient } from '@/api/provider';
import type { Session } from '@/api/types';
import { ConfirmDialogHost, StepUpDialogHost, ToastHost } from '@/components/Overlays';
import { outcomeCheckTiming } from '@/config/app';
import { createQueryClient } from '@/lib/queryClient';
import { useDevSettings } from '@/state/devSettings';
import { useSession } from '@/state/session';

export const FAST_CONTROLS: MockControls = {
  latencyMs: 0,
  failureRate: 0,
  forcedError: 'none',
  quoteTtlSeconds: 30,
  offline: false,
  failWritesOnly: false,
  lateApplyMs: 3000,
};

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

let installed: DemoBackend | null = null;

/** A fresh in-app demo backend, driven by the dev-settings store, installed as the app's backend. */
export function installMockBackend(controls: Partial<MockControls> = {}): DemoBackend {
  useDevSettings.setState({ controls: { ...FAST_CONTROLS, ...controls } });
  const mock = createDemoBackend({
    getControls: () => useDevSettings.getState().controls,
    planName: 'Business Standard',
  });
  setProviderBackendForTests({ client: mock.client, auth: mock.auth, resetSampleData: mock.reset });
  installed = mock;
  return mock;
}

/** Open the provider session only (no app session), for tests that talk to the client directly. */
export async function signIn(client: ProviderClient, email = 'tester@example.com'): Promise<void> {
  await (client as CurrencycloudClient).authenticate(email, 'test-api-key');
}

/**
 * Sign in on the installed backend and start the app session.
 * By default the session needs no authenticator code for any action, so tests of
 * other behaviour are not interrupted; pass `stepUp: true` for the real list.
 */
export async function startTestSession(email = 'finance@example.com', options: { stepUp?: boolean } = {}): Promise<Session> {
  if (!installed) throw new Error('Call installMockBackend() first');
  const full = await installed.signInDirectly(email);
  const session = options.stepUp ? full : { ...full, stepUpActions: [] };
  useSession.getState().startSession(session);
  return session;
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
      <StepUpDialogHost />
      <ToastHost />
    </QueryClientProvider>,
  );
  return { queryClient };
}
