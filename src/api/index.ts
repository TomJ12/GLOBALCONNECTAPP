/**
 * The single place that decides which backend the app talks to.
 *
 *   EXPO_PUBLIC_API_URL set    -> the Global Connect server (adapters/globalConnectApi.ts)
 *   EXPO_PUBLIC_API_URL unset  -> the in-app demo (adapters/demoBackend.ts), sample data only
 *
 * Nothing else in the app imports an adapter. The adapters are loaded with
 * require() inside the branch that needs them, so the provider-shaped demo code
 * is never evaluated when the app talks to the server.
 */
import { SAMPLE_PLAN_NAME } from '@/config/app';
import { useDevSettings } from '@/state/devSettings';

import type { AuthClient } from './auth';
import type { ProviderClient } from './provider';

interface Backend {
  client: ProviderClient;
  auth: AuthClient;
  /** Present only for mock backends. */
  resetSampleData?: () => void;
  isMock: boolean;
}

function createBackend(): Backend {
  // Expo inlines this at build time; it must be read as a literal expression.
  const apiUrl = process.env.EXPO_PUBLIC_API_URL;
  if (apiUrl) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- deliberate: only the chosen adapter is loaded
    const { GlobalConnectApi } = require('./adapters/globalConnectApi') as typeof import('./adapters/globalConnectApi');
    const api = new GlobalConnectApi({ baseUrl: apiUrl });
    return { client: api, auth: api, isMock: false };
  }
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- deliberate: only the chosen adapter is loaded
  const { createDemoBackend } = require('./adapters/demoBackend') as typeof import('./adapters/demoBackend');
  const demo = createDemoBackend({
    getControls: () => useDevSettings.getState().controls,
    planName: SAMPLE_PLAN_NAME,
  });
  return { client: demo.client, auth: demo.auth, resetSampleData: demo.reset, isMock: true };
}

let backend: Backend | null = null;

function getBackend(): Backend {
  backend ??= createBackend();
  return backend;
}

export function getProviderClient(): ProviderClient {
  return getBackend().client;
}

export function getAuthClient(): AuthClient {
  return getBackend().auth;
}

/** True while the app is running against sample data in the app itself. */
export function isMockBackend(): boolean {
  return getBackend().isMock;
}

/** Developer panel: restore the mock's sample data. No-op for a real backend. */
export function resetSampleData(): void {
  getBackend().resetSampleData?.();
}

/** Tests only: install a specific backend, or pass null to rebuild the default. */
export function setProviderBackendForTests(
  next: { client: ProviderClient; auth: AuthClient; resetSampleData?: () => void; isMock?: boolean } | null,
): void {
  backend = next ? { ...next, isMock: next.isMock ?? true } : null;
}

export * from './errors';
export type { AuthClient } from './auth';
export type { ProviderClient } from './provider';
export type * from './types';
