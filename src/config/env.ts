import { mockControlsFromEnv, type MockControls } from '@/api/mockControls';

/**
 * Expo inlines EXPO_PUBLIC_* variables at build time, and only when they are
 * referenced as literal `process.env.NAME` expressions, so each is listed here.
 */
export function initialMockControls(): MockControls {
  return mockControlsFromEnv({
    EXPO_PUBLIC_MOCK_LATENCY_MS: process.env.EXPO_PUBLIC_MOCK_LATENCY_MS,
    EXPO_PUBLIC_MOCK_FAILURE_RATE: process.env.EXPO_PUBLIC_MOCK_FAILURE_RATE,
    EXPO_PUBLIC_MOCK_FORCE_ERROR: process.env.EXPO_PUBLIC_MOCK_FORCE_ERROR,
    EXPO_PUBLIC_MOCK_QUOTE_TTL_S: process.env.EXPO_PUBLIC_MOCK_QUOTE_TTL_S,
    EXPO_PUBLIC_MOCK_OFFLINE: process.env.EXPO_PUBLIC_MOCK_OFFLINE,
  });
}
