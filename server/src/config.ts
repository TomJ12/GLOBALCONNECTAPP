/**
 * Server settings, read once from the environment. Nothing here is logged.
 *
 * STRICT BY DEFAULT. Development conveniences (mock provider credentials,
 * activation codes printed to the console, the console outbox instead of a
 * mailer, the JSON file store, plain-http ops console) exist only when
 * APP_ENV=development is set explicitly. `npm run demo` sets it. Leaving
 * NODE_ENV unset does NOT make the server lenient.
 */
import { isIP } from 'node:net';

export interface ProviderCredentials {
  currencycloud: { loginId: string; apiKey: string } | null;
  equals: { apiKey: string } | null;
}

export interface Config {
  port: number;
  host: string;
  /** Only with APP_ENV=development. */
  development: boolean;
  /** Everything else. */
  strict: boolean;
  corsOrigins: string[];
  appUrl: string;
  /** Public address of this server, where the ops console lives under /ops. */
  opsUrl: string;
  /** LOCAL DEMO ONLY: keep accounts in this JSON file. Development mode only. */
  dataFile: string | null;
  /** false, a number of proxy hops to trust, or the proxies' addresses / CIDR ranges. Never "trust everything". */
  trustProxy: false | number | string[];
  adminToken: string | null;
  /** The loopback-only listener for the operator commands (/admin/*). */
  adminPort: number;
  /** Sensitive ops actions need a second staff member. Can be turned off only in development. */
  fourEyes: boolean;
  approvalTtlMs: number;
  /** Folder of the exported web app to serve from the same origin, or null. */
  webDir: string | null;
  log: boolean;

  sessionIdleMs: number;
  sessionAbsoluteMs: number;
  loginChallengeTtlMs: number;
  activationTtlMs: number;
  stepUpTtlMs: number;
  /** Staff sessions are shorter than client sessions. */
  opsSessionIdleMs: number;
  opsSessionAbsoluteMs: number;
  /** Conversions between the client's own balances need a fresh code too. Off by default. */
  stepUpConversions: boolean;

  /** Failures from one address against one account before a lock starts, the first lock's length, and the longest lock. Each further failure doubles the lock. */
  lockoutThreshold: number;
  /** Failures against one account from ALL addresses together before it locks for everyone. */
  lockoutAccountThreshold: number;
  lockoutBaseMs: number;
  lockoutMaxMs: number;
  /** Requests per minute per address on sign-in, activation and step-up endpoints. */
  authRequestsPerMinute: number;

  providers: ProviderCredentials;
}

type Env = Partial<Record<string, string | undefined>>;

const MINUTE = 60_000;

/** A token that guards operator commands must be long and random; the sample value from .env.example is refused. */
export function adminTokenProblem(token: string): string | null {
  if (/replace|change-?me|example|placeholder|your-|secret|password|token/i.test(token)) return 'it looks like a placeholder';
  if (token.length < 32) return 'it is shorter than 32 characters';
  if (new Set(token).size < 16) return 'it has too few different characters to be random';
  return null;
}

function parseTrustProxy(value: string | undefined): false | number | string[] {
  const text = (value ?? '').trim();
  if (text === '' || text === '0' || text === 'false') return false;
  if (/^\d+$/.test(text)) return Number(text);
  const ranges = text.split(',').map((item) => item.trim()).filter(Boolean);
  const valid = ranges.every((range) => {
    const [address = '', bits] = range.split('/');
    return isIP(address) !== 0 && (bits === undefined || (/^\d{1,3}$/.test(bits) && Number(bits) <= (isIP(address) === 4 ? 32 : 128)));
  });
  if (!valid) throw new Error('TRUST_PROXY must be 0, a number of proxy hops (for example 1), or a comma-separated list of proxy addresses or CIDR ranges. "true" is not accepted.');
  return ranges;
}

export function loadConfig(env: Env = process.env): Config {
  if (env.APP_ENV !== undefined && env.APP_ENV !== 'development' && env.APP_ENV !== 'production') {
    throw new Error('APP_ENV must be "development" or "production" (the default).');
  }
  const development = env.APP_ENV === 'development';
  if (development && env.NODE_ENV === 'production') throw new Error('APP_ENV=development cannot be combined with NODE_ENV=production.');
  const strict = !development;

  const pair = (loginId: string | undefined, apiKey: string | undefined) => (loginId && apiKey ? { loginId, apiKey } : null);
  const providers: ProviderCredentials = {
    currencycloud: pair(env.CURRENCYCLOUD_LOGIN_ID, env.CURRENCYCLOUD_API_KEY),
    equals: env.EQUALS_API_KEY ? { apiKey: env.EQUALS_API_KEY } : null,
  };
  if (development) {
    // The mock providers accept any non-empty credentials, so a development run works without a .env file.
    providers.currencycloud ??= { loginId: 'dev-mock-login', apiKey: 'dev-mock-key' };
    providers.equals ??= { apiKey: 'dev-mock-key' };
  } else if (!providers.currencycloud || !providers.equals) {
    throw new Error('Provider credentials are missing. Set CURRENCYCLOUD_LOGIN_ID, CURRENCYCLOUD_API_KEY and EQUALS_API_KEY. (For a local demonstration with mock providers set APP_ENV=development.)');
  }
  if (strict && env.DATA_FILE) {
    throw new Error('DATA_FILE keeps password hashes and authenticator keys in a plain file. It is for local demonstrations only and is refused unless APP_ENV=development.');
  }
  const fourEyes = env.FOUR_EYES !== 'off';
  if (strict && !fourEyes) throw new Error('FOUR_EYES=off is refused unless APP_ENV=development: sensitive ops actions must need a second staff member.');
  if (env.ADMIN_TOKEN) {
    const problem = adminTokenProblem(env.ADMIN_TOKEN);
    if (problem) throw new Error(`ADMIN_TOKEN is refused because ${problem}. Generate one with: openssl rand -base64 32 (or leave it unset to disable the operator commands).`);
  }

  const port = Number(env.PORT ?? 3001) || 3001;
  const appUrl = (env.APP_URL ?? 'http://localhost:8081').replace(/\/+$/, '');
  // When the server also serves the web app (npm run demo), both share one address.
  const opsUrl = (env.OPS_URL ?? (development ? (env.WEB_DIR ? appUrl : `http://localhost:${port}`) : '')).replace(/\/+$/, '');
  if (strict && !opsUrl.startsWith('https://')) throw new Error('OPS_URL must be set to the https:// address of this server (the ops console is served only over https outside development).');

  return {
    port,
    host: env.HOST ?? '0.0.0.0',
    development,
    strict,
    corsOrigins: (env.CORS_ORIGINS ?? '')
      .split(',')
      .map((origin) => origin.trim().replace(/\/+$/, ''))
      .filter(Boolean),
    appUrl,
    opsUrl,
    dataFile: env.DATA_FILE || null,
    trustProxy: parseTrustProxy(env.TRUST_PROXY),
    adminToken: env.ADMIN_TOKEN || null,
    adminPort: Number(env.ADMIN_PORT ?? 3002) || 3002,
    fourEyes,
    approvalTtlMs: 24 * 60 * MINUTE,
    webDir: env.WEB_DIR || null,
    log: env.LOG !== '0',
    sessionIdleMs: 15 * MINUTE,
    sessionAbsoluteMs: 12 * 60 * MINUTE,
    loginChallengeTtlMs: 5 * MINUTE,
    activationTtlMs: 72 * 60 * MINUTE,
    stepUpTtlMs: 2 * MINUTE,
    opsSessionIdleMs: 10 * MINUTE,
    opsSessionAbsoluteMs: 8 * 60 * MINUTE,
    stepUpConversions: env.STEP_UP_CONVERSIONS === '1',
    lockoutThreshold: 5,
    lockoutAccountThreshold: 50,
    lockoutBaseMs: MINUTE,
    lockoutMaxMs: 60 * MINUTE,
    authRequestsPerMinute: 30,
    providers,
  };
}
