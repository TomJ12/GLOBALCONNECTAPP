/**
 * Server settings, read once from the environment. Nothing here is logged.
 *
 * STRICT BY DEFAULT. Development conveniences (mock provider credentials,
 * activation codes printed to the console, the console outbox instead of a
 * mailer, an in-memory database, a generated encryption key, plain-http ops
 * console) exist only when
 * APP_ENV=development is set explicitly. `npm run demo` sets it. Leaving
 * NODE_ENV unset does NOT make the server lenient.
 */
import { randomBytes } from 'node:crypto';
import { isIP } from 'node:net';

import { dataKeyProblem } from './store/sqlite/keys';

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
  /** The SQLite database file. Required outside development; in development, without one, the database is in memory and lost at exit. */
  databasePath: string | null;
  /** Base64 of 32 random bytes: encrypts authenticator keys at rest and chains the audit log. Required outside development. Never stored in the database. */
  dataEncryptionKey: string | null;
  /** Older keys, still able to decrypt and to verify, while a rotation is in progress. */
  previousDataEncryptionKeys: string[];
  /** false, a number of proxy hops to trust, or the proxies' addresses / CIDR ranges. Never "trust everything". */
  trustProxy: false | number | string[];
  adminToken: string | null;
  /** The loopback-only listener for the operator commands (/admin/*). */
  adminPort: number;
  /** Key for values the server signs (the pre-login CSRF anchor). Required outside development; random per start in development. */
  serverSecret: string;
  /** Staff accounts may only be created for addresses at these domains. */
  staffEmailDomains: string[];
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
  /** Requests per minute per source (an IPv4 address or an IPv6 /64) on sign-in, activation, step-up and ops pages before sign-in. */
  authRequestsPerMinute: number;
  /** The same, for a whole IPv4 /24: neighbours share this larger allowance. */
  authRequestsPerNetworkPerMinute: number;
  /** State-changing requests per minute for one signed-in client (per user and per session). Sign-out is exempt. */
  writeRequestsPerMinute: number;

  providers: ProviderCredentials;
}

type Env = Partial<Record<string, string | undefined>>;

const MINUTE = 60_000;

const KEYBOARD_ROWS = ['qwertyuiop', 'asdfghjkl', 'zxcvbnm', '1234567890', 'poiuytrewq', 'lkjhgfdsa', 'mnbvcxz', '0987654321'];

/** True when the text contains `length` characters in a row that simply count up or down (abcdef, 654321) or run along a keyboard row. */
function hasRun(text: string, length: number): boolean {
  const lower = text.toLowerCase();
  for (let start = 0; start + length <= lower.length; start += 1) {
    const window = lower.slice(start, start + length);
    const steps = Array.from({ length: length - 1 }, (_, index) => window.charCodeAt(index + 1) - window.charCodeAt(index));
    if (steps.every((step) => step === 1) || steps.every((step) => step === -1) || steps.every((step) => step === 0)) return true;
    if (KEYBOARD_ROWS.some((row) => row.includes(window))) return true;
  }
  return false;
}

/**
 * A secret must look like the output of a random generator: long, without
 * placeholders, without alphabet or keyboard runs, and either three kinds of
 * character (as base64 gives) or long hexadecimal (as `openssl rand -hex 32`
 * gives). The sample value from .env.example is refused.
 */
export function secretProblem(token: string): string | null {
  if (/replace|change-?me|example|placeholder|your-|secret|password|token/i.test(token)) return 'it looks like a placeholder';
  if (token.length < 32) return 'it is shorter than 32 characters';
  if (new Set(token).size < 16) return 'it has too few different characters to be random';
  if (hasRun(token, 5)) return 'it contains a sequence (such as abcde or 12345) or a keyboard run';
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((kind) => kind.test(token)).length;
  const hex = /^[0-9a-f]{48,}$/i.test(token);
  if (classes < 3 && !hex) return 'it does not look randomly generated (use: openssl rand -base64 32)';
  return null;
}
export const adminTokenProblem = secretProblem;

/** More hops than this is a configuration mistake: it would let a client choose its own address through header padding. */
const MAX_PROXY_HOPS = 3;

function parseTrustProxy(value: string | undefined): false | number | string[] {
  const text = (value ?? '').trim();
  if (text === '' || text === '0' || text === 'false') return false;
  if (/^\d+$/.test(text)) {
    if (Number(text) > MAX_PROXY_HOPS) throw new Error(`TRUST_PROXY: at most ${MAX_PROXY_HOPS} proxy hops can be trusted. For anything else list the proxies' addresses or CIDR ranges.`);
    return Number(text);
  }
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
  if (env.DATA_FILE) throw new Error('DATA_FILE (the JSON demo file) is no longer used. Data is kept in a SQLite database: set DATABASE_PATH instead.');
  if (strict && !env.DATABASE_PATH) throw new Error('DATABASE_PATH must be set to the SQLite database file. (Only in development may the database be in memory.)');
  if (strict && !env.DATA_ENCRYPTION_KEY) throw new Error('DATA_ENCRYPTION_KEY must be set (openssl rand -base64 32): authenticator keys are encrypted at rest with it. Keep it outside the database and its backups.');
  for (const [name, value] of [['DATA_ENCRYPTION_KEY', env.DATA_ENCRYPTION_KEY], ...(env.DATA_ENCRYPTION_KEY_PREVIOUS ?? '').split(',').filter(Boolean).map((item) => ['DATA_ENCRYPTION_KEY_PREVIOUS', item.trim()])] as [string, string | undefined][]) {
    const problem = value ? dataKeyProblem(value) : null;
    if (problem) throw new Error(`${name} is refused because ${problem}.`);
  }
  const fourEyes = env.FOUR_EYES !== 'off';
  if (strict && !fourEyes) throw new Error('FOUR_EYES=off is refused unless APP_ENV=development: sensitive ops actions must need a second staff member.');
  if (env.ADMIN_TOKEN) {
    const problem = adminTokenProblem(env.ADMIN_TOKEN);
    if (problem) throw new Error(`ADMIN_TOKEN is refused because ${problem}. Generate one with: openssl rand -base64 32 (or leave it unset to disable the operator commands).`);
  }

  if (env.SERVER_SECRET) {
    const problem = secretProblem(env.SERVER_SECRET);
    if (problem) throw new Error(`SERVER_SECRET is refused because ${problem}.`);
  } else if (strict) {
    throw new Error('SERVER_SECRET must be set (openssl rand -base64 32): the server signs values with it.');
  }
  const staffEmailDomains = (env.STAFF_EMAIL_DOMAINS ?? (development ? 'globalconnect.example' : ''))
    .split(',')
    .map((domain) => domain.trim().toLowerCase().replace(/^@/, ''))
    .filter(Boolean);
  if (staffEmailDomains.length === 0) throw new Error('STAFF_EMAIL_DOMAINS must list the email domains staff accounts may use (for example globalconnect.co.uk).');
  if (staffEmailDomains.some((domain) => !/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(domain))) throw new Error('STAFF_EMAIL_DOMAINS must be a comma-separated list of domain names.');

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
    databasePath: env.DATABASE_PATH || null,
    dataEncryptionKey: env.DATA_ENCRYPTION_KEY?.trim() || null,
    previousDataEncryptionKeys: (env.DATA_ENCRYPTION_KEY_PREVIOUS ?? '').split(',').map((item) => item.trim()).filter(Boolean),
    trustProxy: parseTrustProxy(env.TRUST_PROXY),
    adminToken: env.ADMIN_TOKEN || null,
    adminPort: Number(env.ADMIN_PORT ?? 3002) || 3002,
    serverSecret: env.SERVER_SECRET ?? randomBytes(32).toString('base64url'),
    staffEmailDomains,
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
    authRequestsPerNetworkPerMinute: 90,
    writeRequestsPerMinute: 60,
    providers,
  };
}
