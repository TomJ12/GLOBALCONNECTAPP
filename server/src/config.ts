/** Server settings, read once from the environment. Nothing here is logged. */
export interface ProviderCredentials {
  currencycloud: { loginId: string; apiKey: string } | null;
  equals: { apiKey: string } | null;
}

export interface Config {
  port: number;
  host: string;
  production: boolean;
  corsOrigins: string[];
  appUrl: string;
  trustProxy: boolean;
  adminToken: string | null;
  /** Folder of the exported web app to serve from the same origin, or null. */
  webDir: string | null;
  log: boolean;

  sessionIdleMs: number;
  sessionAbsoluteMs: number;
  loginChallengeTtlMs: number;
  activationTtlMs: number;
  stepUpTtlMs: number;
  /** Conversions between the client's own balances need a fresh code too. Off by default. */
  stepUpConversions: boolean;

  /** Failures before a lock starts, the first lock's length, and the longest lock. Each further failure doubles the lock. */
  lockoutThreshold: number;
  lockoutBaseMs: number;
  lockoutMaxMs: number;
  /** Requests per minute per address on sign-in, activation and step-up endpoints. */
  authRequestsPerMinute: number;

  providers: ProviderCredentials;
}

type Env = Partial<Record<string, string | undefined>>;

const MINUTE = 60_000;

export function loadConfig(env: Env = process.env): Config {
  const production = env.NODE_ENV === 'production';
  const pair = (loginId: string | undefined, apiKey: string | undefined) => (loginId && apiKey ? { loginId, apiKey } : null);
  const providers: ProviderCredentials = {
    currencycloud: pair(env.CURRENCYCLOUD_LOGIN_ID, env.CURRENCYCLOUD_API_KEY),
    equals: env.EQUALS_API_KEY ? { apiKey: env.EQUALS_API_KEY } : null,
  };
  if (!production) {
    // The mock providers accept any non-empty credentials, so a development run works without a .env file.
    providers.currencycloud ??= { loginId: 'dev-mock-login', apiKey: 'dev-mock-key' };
    providers.equals ??= { apiKey: 'dev-mock-key' };
  } else if (!providers.currencycloud || !providers.equals) {
    throw new Error('Provider credentials are missing. Set CURRENCYCLOUD_LOGIN_ID, CURRENCYCLOUD_API_KEY and EQUALS_API_KEY.');
  }
  return {
    port: Number(env.PORT ?? 3001) || 3001,
    host: env.HOST ?? '0.0.0.0',
    production,
    corsOrigins: (env.CORS_ORIGINS ?? '')
      .split(',')
      .map((origin) => origin.trim().replace(/\/+$/, ''))
      .filter(Boolean),
    appUrl: (env.APP_URL ?? 'http://localhost:8081').replace(/\/+$/, ''),
    trustProxy: env.TRUST_PROXY === '1',
    adminToken: env.ADMIN_TOKEN && env.ADMIN_TOKEN.length >= 16 ? env.ADMIN_TOKEN : null,
    webDir: env.WEB_DIR || null,
    log: env.LOG !== '0',
    sessionIdleMs: 15 * MINUTE,
    sessionAbsoluteMs: 12 * 60 * MINUTE,
    loginChallengeTtlMs: 5 * MINUTE,
    activationTtlMs: 72 * 60 * MINUTE,
    stepUpTtlMs: 2 * MINUTE,
    stepUpConversions: env.STEP_UP_CONVERSIONS === '1',
    lockoutThreshold: 5,
    lockoutBaseMs: MINUTE,
    lockoutMaxMs: 60 * MINUTE,
    authRequestsPerMinute: 30,
    providers,
  };
}
