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
import { MARGIN_USUAL_MAX_BPS } from './rates/margin';
import type { SmtpSettings } from './mail/smtp';
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
  /** DEVELOPMENT ONLY: listening beyond this machine without the demo gate, by explicit choice (DEV_OPEN_ON_NETWORK=1). Said loudly at start-up. */
  openOnNetwork: boolean;
  /** The key holder's one-off acceptance of an audit log whose end is not signed (AUDIT_ACCEPT_LOG_END): the label of that exact log end. */
  auditAcceptLogEnd: string | null;
  /** How long an approved authenticator reset waits before anything changes (AUTHENTICATOR_RESET_DELAY_HOURS, default 24; 0 = at once). */
  authenticatorResetDelayMs: number;
  /** The SMTP server emails are sent through, or null (development: the console outbox). */
  smtp: SmtpSettings | null;
  /** Emails queued for one address, and for everyone together, per hour. Beyond these a message is recorded as suppressed, not sent. */
  mailPerRecipientPerHour: number;
  mailGlobalPerHour: number;
  /**
   * How long a payment whose sending had an unknown outcome and was then refused is still looked for at the
   * provider (by its key) before it is called failed (PAYMENT_RECONCILE_HOURS, default 72).
   */
  paymentReconcileMs: number;
  /** Payee fields left out of the payee digest for each provider, beyond the adapter's own short list (PAYEE_DIGEST_IGNORE_CURRENCYCLOUD / _EQUALS). */
  payeeDigestIgnore: { currencycloud: string[]; equals: string[] };
  /**
   * Where Global Connect's FX margin is applied, per provider (MARGIN_APPLIED_BY_CURRENCYCLOUD / _EQUALS).
   * `server`: this server works out the client's rate from the provider's (rates/margin.ts).
   * `provider`: the provider already returns the client's rate, with the markup configured on its side, so the
   * server adds NOTHING.
   */
  marginAppliedBy: { currencycloud: 'server' | 'provider'; equals: 'server' | 'provider' };
  /** The margin, in basis points, for a company that has no margin configuration of its own (DEFAULT_MARGIN_BPS). */
  defaultMarginBps: number;
  /** How long a provider's rate for a pair is reused for indicative rates and alerts (RATE_CACHE_SECONDS, default 5). */
  rateCacheMs: number;
  /** MOCK providers only: the sample rates move over time (MOCK_MOVING_RATES, default on). */
  mockMovingRates: boolean;
  /** How often rate alerts are checked against each company's client rate (ALERT_CHECK_SECONDS, default 60). */
  alertCheckMs: number;
  /** Most rate alerts one person can have (ALERTS_PER_USER, default 20). */
  alertsPerUser: number;
  /** How long before a held payment expires its creator and approvers are told (PAYMENT_EXPIRY_WARNING_HOURS, default 6; 0 = never). */
  paymentExpiryWarningMs: number;
  /** Most notifications one person is sent in an hour (NOTIFICATIONS_PER_USER_PER_HOUR, default 60). */
  notificationsPerUserPerHour: number;
  /** Only with APP_ENV=development. */
  development: boolean;
  /** Everything else. */
  strict: boolean;
  corsOrigins: string[];
  appUrl: string;
  /** Public address of this server, where the ops console lives under /ops. */
  opsUrl: string;
  /** How long a payment waits for approval before it expires, in milliseconds (PAYMENT_APPROVAL_HOURS, default 48). */
  paymentApprovalMs: number;
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
  /**
   * DEMO ON A PUBLIC ADDRESS. When set, nothing but /healthz is served until
   * the visitor has typed this password on the gate page. Required whenever
   * development mode runs anywhere other than this machine or a Codespace.
   */
  demoAccessPassword: string | null;
  /** Development mode on a public address (Fly.io, or any APP_URL that is not localhost or a Codespace). */
  publicDemo: boolean;
  /** First-time setup of a public demo: print the sample accounts' activation codes to the log (DEMO_SETUP_CODES=1). Off, nothing is printed. */
  demoSetupCodes: boolean;
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
  /** Reads (GET) a signed-in session may make per minute. Generous: it is a ceiling on scraping and on load, not a throttle on use. */
  readRequestsPerMinute: number;

  providers: ProviderCredentials;
}

type Env = Partial<Record<string, string | undefined>>;

/**
 * SMTP_HOST, SMTP_PORT, SMTP_TLS, SMTP_USERNAME, SMTP_PASSWORD, MAIL_FROM, MAIL_REPLY_TO. Without SMTP_HOST there
 * is no mail server (development: the console outbox; outside development the server will not start). TLS is
 * required: `starttls` (the default; port 587) or `tls` (the default on port 465). `off` is accepted only in
 * development and only for a mail server on this machine.
 */
function smtpSettings(env: Env, development: boolean): SmtpSettings | null {
  const host = env.SMTP_HOST?.trim();
  if (!host) return null;
  const port = Number(env.SMTP_PORT ?? 587);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('SMTP_PORT must be a port number.');
  const tls = (env.SMTP_TLS ?? (port === 465 ? 'tls' : 'starttls')).toLowerCase();
  if (tls !== 'tls' && tls !== 'starttls' && tls !== 'off') throw new Error('SMTP_TLS must be "starttls" (the default), "tls" (implicit TLS, usually port 465) or, for a mail server on this machine in development only, "off".');
  if (tls === 'off' && !(development && (host === 'localhost' || host === '::1' || /^127\./.test(host)))) throw new Error('SMTP_TLS=off is refused: email is only ever sent over TLS, except to a mail server on this machine in development mode.');
  const address = /^[^\s@<>,;"\r\n]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/;
  const from = env.MAIL_FROM?.trim() ?? '';
  if (!address.test(from)) throw new Error('MAIL_FROM must be set to the address emails are sent from (a plain address such as no-reply@globalconnect.co.uk) when SMTP_HOST is set.');
  const replyTo = env.MAIL_REPLY_TO?.trim() || null;
  if (replyTo !== null && !address.test(replyTo)) throw new Error('MAIL_REPLY_TO must be a plain email address.');
  const username = env.SMTP_USERNAME || null;
  if (username && !env.SMTP_PASSWORD) throw new Error('SMTP_PASSWORD must be set when SMTP_USERNAME is.');
  return { host, port, tls, username, password: env.SMTP_PASSWORD ?? null, from, replyTo };
}

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

/** A demo password has to be something nobody guesses: long enough, not a placeholder, not one character repeated. */
export function demoPasswordProblem(password: string): string | null {
  if (password.length < 12) return 'it is shorter than 12 characters';
  if (/replace|change-?me|example|placeholder|your-|^password|^demo|letmein|12345|qwerty/i.test(password)) return 'it looks like a placeholder or a common password';
  if (new Set(password).size < 6) return 'it has too few different characters';
  return null;
}

/** This machine, or a GitHub Codespace's forwarded port: the two places a development server may run without the demo gate. */
function isPrivateAddress(url: string, env: Env): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host.endsWith('.localhost')) return true;
  const forwarding = (env.GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN ?? 'app.github.dev').toLowerCase();
  return Boolean(env.CODESPACE_NAME) && host.startsWith(`${env.CODESPACE_NAME?.toLowerCase()}-`) && host.endsWith(`.${forwarding}`);
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
  // On Fly.io the app's own address is known, so it need not be typed into the configuration.
  const flyUrl = env.FLY_APP_NAME ? `https://${env.FLY_APP_NAME}.fly.dev` : null;
  const appUrl = (env.APP_URL ?? flyUrl ?? 'http://localhost:8081').replace(/\/+$/, '');
  // When the server also serves the web app (npm run demo), both share one address.
  const opsUrl = (env.OPS_URL ?? (development ? (env.WEB_DIR || env.FLY_APP_NAME ? appUrl : `http://localhost:${port}`) : '')).replace(/\/+$/, '');
  if (strict && !opsUrl.startsWith('https://')) throw new Error('OPS_URL must be set to the https:// address of this server (the ops console is served only over https outside development).');

  // --- A demo that can be reached from the internet -------------------------------------------
  const demoAccessPassword = env.DEMO_ACCESS_PASSWORD || null;
  if (demoAccessPassword) {
    const problem = demoPasswordProblem(demoAccessPassword);
    if (problem) throw new Error(`DEMO_ACCESS_PASSWORD is refused because ${problem}. Use a phrase of 12 characters or more that you have not used anywhere else.`);
  }
  const publicDemo = development && (Boolean(env.FLY_APP_NAME) || !isPrivateAddress(appUrl, env) || !isPrivateAddress(opsUrl, env));
  if (publicDemo) {
    // Mock providers, sample data and "emails" printed to the log, on an address anyone can reach: only behind the
    // gate, only over https, and with real secrets. No generated key files, no built-in defaults.
    const missing = [
      !demoAccessPassword && 'DEMO_ACCESS_PASSWORD (the password visitors must type before anything is shown)',
      !env.SERVER_SECRET && 'SERVER_SECRET',
      !env.ADMIN_TOKEN && 'ADMIN_TOKEN',
      !env.DATA_ENCRYPTION_KEY && 'DATA_ENCRYPTION_KEY',
      !env.DATABASE_PATH && 'DATABASE_PATH',
    ].filter(Boolean);
    if (missing.length > 0) {
      throw new Error(`Refusing to start in development mode on a public address (${env.FLY_APP_NAME ? `Fly.io app ${env.FLY_APP_NAME}` : appUrl}) without: ${missing.join('; ')}. A demo that the internet can reach must be behind the demo password and must have its own secrets. See docs/DEPLOY-DEMO.md.`);
    }
    if (!appUrl.startsWith('https://') || !opsUrl.startsWith('https://')) throw new Error('A demo on a public address must be served over https: APP_URL (and OPS_URL, if set) must start with https://.');
  }

  // In development the server shows sample accounts and prints activation codes, so by default it listens on this
  // machine only (a GitHub Codespace forwards its port from here). Beyond this machine it must be behind the demo
  // gate, unless that is waived in so many words.
  const host = env.HOST ?? (development && !demoAccessPassword ? '127.0.0.1' : '0.0.0.0');
  const openOnNetwork = development && !demoAccessPassword && !(host === 'localhost' || host === '::1' || /^127\./.test(host));
  if (openOnNetwork && env.DEV_OPEN_ON_NETWORK !== '1') {
    throw new Error(
      `Refusing to start in development mode on ${host} without the demo gate: anyone who can reach this machine would see the sample accounts and their activation codes. ` +
        'Leave HOST unset (the server then listens on this machine only, which is also what a GitHub Codespace needs), or set DEMO_ACCESS_PASSWORD, or, on a network you trust, set DEV_OPEN_ON_NETWORK=1.',
    );
  }

  const approvalHours = Number(env.PAYMENT_APPROVAL_HOURS ?? 48);
  if (!(approvalHours > 0 && approvalHours <= 24 * 30)) throw new Error('PAYMENT_APPROVAL_HOURS must be a number of hours between 0 and 720 (default 48).');

  const resetDelayHours = Number(env.AUTHENTICATOR_RESET_DELAY_HOURS ?? 24);
  if (!(resetDelayHours >= 0 && resetDelayHours <= 24 * 14)) throw new Error('AUTHENTICATOR_RESET_DELAY_HOURS must be a number of hours between 0 and 336 (default 24).');
  if (strict && resetDelayHours < 1) throw new Error('AUTHENTICATOR_RESET_DELAY_HOURS must be at least 1 outside development: an authenticator reset that happens at once is the classic account takeover.');
  const reconcileHours = Number(env.PAYMENT_RECONCILE_HOURS ?? 72);
  if (!(reconcileHours > 0 && reconcileHours <= 24 * 30)) throw new Error('PAYMENT_RECONCILE_HOURS must be a number of hours between 0 and 720 (default 72).');
  const fieldList = (value: string | undefined): string[] => {
    const names = (value ?? '').split(',').map((item) => item.trim()).filter(Boolean);
    if (names.some((name) => !/^[A-Za-z0-9_]+(\.[A-Za-z0-9_]+)*$/.test(name))) throw new Error('PAYEE_DIGEST_IGNORE_* must be a comma-separated list of field names (a.b for a field inside another).');
    return names;
  };

  const appliedBy = (name: string): 'server' | 'provider' => {
    const value = env[name] ?? 'server';
    if (value !== 'server' && value !== 'provider') throw new Error(`${name} must be "server" (this server applies the margin) or "provider" (the provider's rate already includes it).`);
    return value;
  };
  // PLACEHOLDER figure in development (a sample, not Global Connect's pricing). Outside development there is no
  // default: a company without its own configuration would otherwise trade at a margin nobody chose.
  if (strict && env.DEFAULT_MARGIN_BPS === undefined) throw new Error('DEFAULT_MARGIN_BPS must be set: the margin, in basis points, for a company with no margin configuration of its own (0 is allowed, but it has to be said).');
  const defaultMarginBps = Number(env.DEFAULT_MARGIN_BPS ?? 50);
  if (!Number.isInteger(defaultMarginBps) || defaultMarginBps < 0 || defaultMarginBps > MARGIN_USUAL_MAX_BPS) throw new Error(`DEFAULT_MARGIN_BPS must be a whole number of basis points between 0 and ${MARGIN_USUAL_MAX_BPS}.`);
  const rateCacheSeconds = Number(env.RATE_CACHE_SECONDS ?? 5);
  if (!(rateCacheSeconds >= 0 && rateCacheSeconds <= 300)) throw new Error('RATE_CACHE_SECONDS must be a number of seconds between 0 and 300 (default 5).');

  const numberOf = (name: string, fallback: number, min: number, max: number, whole = true): number => {
    const value = Number(env[name] ?? fallback);
    if (!(value >= min && value <= max) || (whole && !Number.isInteger(value))) throw new Error(`${name} must be a ${whole ? 'whole ' : ''}number between ${min} and ${max} (default ${fallback}).`);
    return value;
  };

  return {
    alertCheckMs: numberOf('ALERT_CHECK_SECONDS', 60, 5, 3600) * 1000,
    alertsPerUser: numberOf('ALERTS_PER_USER', 20, 1, 200),
    paymentExpiryWarningMs: Math.round(numberOf('PAYMENT_EXPIRY_WARNING_HOURS', 6, 0, 24 * 30, false) * 60 * 60_000),
    notificationsPerUserPerHour: numberOf('NOTIFICATIONS_PER_USER_PER_HOUR', 60, 1, 1000),
    marginAppliedBy: { currencycloud: appliedBy('MARGIN_APPLIED_BY_CURRENCYCLOUD'), equals: appliedBy('MARGIN_APPLIED_BY_EQUALS') },
    defaultMarginBps,
    rateCacheMs: Math.round(rateCacheSeconds * 1000),
    mockMovingRates: env.MOCK_MOVING_RATES !== '0',
    authenticatorResetDelayMs: Math.round(resetDelayHours * 60 * 60_000),
    paymentReconcileMs: Math.round(reconcileHours * 60 * 60_000),
    payeeDigestIgnore: { currencycloud: fieldList(env.PAYEE_DIGEST_IGNORE_CURRENCYCLOUD), equals: fieldList(env.PAYEE_DIGEST_IGNORE_EQUALS) },
    paymentApprovalMs: Math.round(approvalHours * 60 * 60_000),
    demoAccessPassword,
    publicDemo,
    demoSetupCodes: env.DEMO_SETUP_CODES === '1',
    port,
    host,
    openOnNetwork,
    smtp: smtpSettings(env, development),
    mailPerRecipientPerHour: 20,
    mailGlobalPerHour: 1000,
    auditAcceptLogEnd: env.AUDIT_ACCEPT_LOG_END?.trim() || null,
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
    readRequestsPerMinute: 600,
    providers,
  };
}
