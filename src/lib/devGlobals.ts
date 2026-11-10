import { resetSampleData } from '@/api';
import type { MockControls } from '@/api/mockControls';
import { useDevSettings } from '@/state/devSettings';

/**
 * Lets a test harness drive the mock without tapping through the developer
 * panel, for example from a browser console or Puppeteer:
 *
 *   __GC_DEV__.setControls({ forcedError: 'rate_limited', latencyMs: 3000 })
 *   __GC_DEV__.resetSampleData()
 *
 * Only installed in development builds, or when the build sets
 * EXPO_PUBLIC_EXPOSE_DEV_GLOBALS=1. Never set that for a release build.
 */
export function installDevGlobals(): void {
  const enabled = __DEV__ || process.env.EXPO_PUBLIC_EXPOSE_DEV_GLOBALS === '1';
  if (!enabled) return;
  (globalThis as { __GC_DEV__?: unknown }).__GC_DEV__ = {
    getControls: (): MockControls => useDevSettings.getState().controls,
    setControls: (patch: Partial<MockControls>) => useDevSettings.getState().setControls(patch),
    resetControls: () => useDevSettings.getState().resetControls(),
    resetSampleData,
  };
}
