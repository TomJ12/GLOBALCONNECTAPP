/**
 * Knobs for the mock backend. They are read on every request, so changing them
 * in the developer panel (or from a test) takes effect immediately.
 *
 * Defaults can be set with environment variables at build/start time:
 *   EXPO_PUBLIC_MOCK_LATENCY_MS      e.g. 1200
 *   EXPO_PUBLIC_MOCK_FAILURE_RATE    0 to 1, e.g. 0.25
 *   EXPO_PUBLIC_MOCK_FORCE_ERROR     none | network | unauthorized | rate_limited | server | malformed | wrong_shape | lost_response
 *
 * `lost_response` is different from the others: the server APPLIES the request and
 * then the connection drops, so the caller sees a network error for something that
 * happened. It is the mode that exercises idempotency keys and reconciliation.
 *   EXPO_PUBLIC_MOCK_QUOTE_TTL_S     e.g. 10
 *   EXPO_PUBLIC_MOCK_OFFLINE         1 to start "offline"
 */
export const FORCED_ERRORS = [
  'none',
  'network',
  'unauthorized',
  'rate_limited',
  'server',
  'malformed',
  'wrong_shape',
  'lost_response',
] as const;
export type ForcedError = (typeof FORCED_ERRORS)[number];

export const FORCED_ERROR_LABELS: Record<ForcedError, string> = {
  none: 'None',
  network: 'Network error',
  unauthorized: '401',
  rate_limited: '429',
  server: '500',
  malformed: 'Broken JSON',
  wrong_shape: 'Wrong shape',
  lost_response: 'Applied, reply lost',
};

export interface MockControls {
  /** Delay added to every request. */
  latencyMs: number;
  /** Chance (0 to 1) that a request fails with a network error or a 500. */
  failureRate: number;
  /** Make every request fail in one specific way. */
  forcedError: ForcedError;
  /** How long a quote's rate is held. */
  quoteTtlSeconds: number;
  /** Simulate having no connection. */
  offline: boolean;
  /** Never answer at all, to exercise the client's request timeout. Tests only; not in the panel. */
  hang?: boolean;
}

export const DEFAULT_MOCK_CONTROLS: MockControls = {
  latencyMs: 350,
  failureRate: 0,
  forcedError: 'none',
  quoteTtlSeconds: 30,
  offline: false,
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function numberFrom(text: string | undefined, fallback: number, min: number, max: number): number {
  if (text === undefined || text.trim() === '') return fallback;
  const value = Number(text);
  return Number.isFinite(value) ? clamp(value, min, max) : fallback;
}

/** Clamp anything (panel input, env, test) into a safe range. */
export function sanitizeMockControls(input: Partial<MockControls>): MockControls {
  const merged = { ...DEFAULT_MOCK_CONTROLS, ...input };
  return {
    latencyMs: clamp(Number.isFinite(merged.latencyMs) ? Math.round(merged.latencyMs) : 0, 0, 60_000),
    failureRate: clamp(Number.isFinite(merged.failureRate) ? merged.failureRate : 0, 0, 1),
    forcedError: FORCED_ERRORS.includes(merged.forcedError) ? merged.forcedError : 'none',
    quoteTtlSeconds: clamp(
      Number.isFinite(merged.quoteTtlSeconds) ? Math.round(merged.quoteTtlSeconds) : 30,
      1,
      3600,
    ),
    offline: Boolean(merged.offline),
    ...(merged.hang ? { hang: true } : {}),
  };
}

export type MockEnv = Partial<Record<string, string | undefined>>;

export function mockControlsFromEnv(env: MockEnv): MockControls {
  const forced = env.EXPO_PUBLIC_MOCK_FORCE_ERROR?.trim().toLowerCase();
  return sanitizeMockControls({
    latencyMs: numberFrom(env.EXPO_PUBLIC_MOCK_LATENCY_MS, DEFAULT_MOCK_CONTROLS.latencyMs, 0, 60_000),
    failureRate: numberFrom(env.EXPO_PUBLIC_MOCK_FAILURE_RATE, DEFAULT_MOCK_CONTROLS.failureRate, 0, 1),
    forcedError: FORCED_ERRORS.includes(forced as ForcedError) ? (forced as ForcedError) : 'none',
    quoteTtlSeconds: numberFrom(env.EXPO_PUBLIC_MOCK_QUOTE_TTL_S, DEFAULT_MOCK_CONTROLS.quoteTtlSeconds, 1, 3600),
    offline: env.EXPO_PUBLIC_MOCK_OFFLINE === '1' || env.EXPO_PUBLIC_MOCK_OFFLINE === 'true',
  });
}
