import { base32Decode, setPasswordCost, totpCode, totpStep } from '../src/crypto';
import { loadConfig, type Config } from '../src/config';
import { buildApp } from '../src/http/app';
import { ProviderRegistry } from '../src/providers/adapter';
import { currencycloudFactory } from '../src/providers/currencycloud';
import { MockCurrencycloudPlatform } from '../src/providers/currencycloudMock';
import { equalsFactory } from '../src/providers/equals/adapter';
import { MockEqualsServer } from '../src/providers/equals/mockServer';
import { ConsoleOutbox } from '../src/mailer';
import { createSqliteStores, type DirectoryData, type SqliteStores } from '../src/store/sqlite';
import type { AuditOptions } from '../src/store/sqlite/audit';
import { dataKeys } from '../src/store/sqlite/keys';
import { seedDirectory } from '../src/store/seed';

/** A fixed data encryption key for the suite (32 bytes, base64). */
export const TEST_DATA_KEY = 'q0v8Jm3ZxN5rT1yLw7KdP2sHf9BcVe4UaGiXoR6MtYE=';
export const PASSWORD = 'correct horse battery';
export const ADMIN_TOKEN = 'k3Vq9xWm2ZrT7pLd5NfY8hJc4BsG6aQe1UoXiPzM';
/** The suite hashes hundreds of passwords: a low cost keeps it quick. One test raises it to check the real setting. */
export const TEST_PASSWORD_COST = 2 ** 14;
setPasswordCost(TEST_PASSWORD_COST);

export interface Reply {
  status: number;
  json: any;
  headers: Record<string, unknown>;
}

export interface Harness {
  config: Config;
  stores: SqliteStores;
  clock: { now: number; advance: (ms: number) => void };
  /** Every response body seen, for the "no provider name" scan. */
  bodies: string[];
  call: (method: 'GET' | 'POST', url: string, options?: { token?: string; body?: unknown; headers?: Record<string, string> }) => Promise<Reply>;
  invite: (email: string) => Promise<string>;
  /** Activate an invited user. Returns what a person would be left holding. */
  activate: (email: string, password?: string) => Promise<{ secret: string; recoveryCodes: string[] }>;
  /** The code an authenticator app would show now. `offsetSteps` shifts it by 30-second steps. */
  code: (secret: string, offsetSteps?: number) => string;
  /** Move to the next 30-second step and return its code: a code that has not been used. */
  freshCode: (secret: string) => string;
  /** Password + code. Returns the verify response. */
  login: (email: string, secret: string, password?: string) => Promise<Reply>;
  /** Get a step-up token for an action. */
  stepUp: (token: string, secret: string, action: string, payload: unknown) => Promise<string>;
  /** Sets a company's payment approval rule directly (the console does it through a request). */
  policy: (companyId: string, approvalsRequired: 0 | 1 | 2) => Promise<void>;
  held: Awaited<ReturnType<typeof buildApp>>['held'];
  close: () => Promise<void>;
  app: Awaited<ReturnType<typeof buildApp>>['app'];
  /** The loopback-only operator listener. */
  admin: NonNullable<Awaited<ReturnType<typeof buildApp>>['admin']>;
  adminCall: (url: string, body: unknown, token?: string) => Promise<Reply>;
  auth: Awaited<ReturnType<typeof buildApp>>['auth'];
  registry: ProviderRegistry;
  /** Every "email" the server sent. */
  outbox: ConsoleOutbox;
  /** The activation code in the newest email to this address. */
  mailedCode: (email: string) => string;
  providerA: MockCurrencycloudPlatform;
  providerB: MockEqualsServer;
  logs: string[];
  /** What the server told the operator loudly (audit rotation). */
  warnings: string[];
  opsAuth: Awaited<ReturnType<typeof buildApp>>['opsAuth'];
  opsRoutes: { method: string; url: string }[];
}

export interface HarnessOptions {
  /** false = the mock providers act on any id whatever the scope says, so only the server's own checks stand between companies. */
  enforceOwnership?: boolean;
  audit?: AuditOptions;
  /** A database file instead of the in-memory database (for restart tests). */
  databasePath?: string;
  maxRateWindows?: number;
  maxHeldQuotes?: number;
  /** Called after a held payment is marked `sending` and before the provider is asked; throwing is a crash at that moment. */
  beforeSend?: Parameters<typeof buildApp>[0]['beforeSend'];
  /** Use these provider mocks instead of new ones (a restart keeps the provider, not the server). */
  providers?: { a: MockCurrencycloudPlatform; b: MockEqualsServer };
  /** Continue this clock instead of starting a new one. */
  clock?: Harness['clock'];
  /**
   * Every store operation takes a real turn of the event loop first, as a
   * database round trip would. In-memory operations otherwise finish within
   * one request's turn, and two "simultaneous" requests never interleave: the
   * race tests would then pass whatever the code did.
   */
  storeLatency?: boolean;
  /** Called before each store operation when storeLatency is on (for example to move the clock in the middle of a request). */
  storeHook?: (operation: string) => void;
}

function withLatency<T extends object>(target: T, hook?: (operation: string) => void): T {
  return new Proxy(target, {
    get(object, property, receiver) {
      const value = Reflect.get(object, property, receiver);
      if (typeof value !== 'function') return value;
      return async (...args: unknown[]) => {
        await new Promise((resolve) => setImmediate(resolve));
        hook?.(String(property));
        return (value as (...inner: unknown[]) => unknown).apply(object, args);
      };
    },
  });
}

export async function harness(overrides: Partial<Config> = {}, directory: DirectoryData = seedDirectory(), options: HarnessOptions = {}): Promise<Harness> {
  const config: Config = { ...loadConfig({ APP_ENV: 'development', LOG: '0', ADMIN_TOKEN }), authRequestsPerMinute: 100_000, authRequestsPerNetworkPerMinute: 100_000, writeRequestsPerMinute: 100_000, ...overrides };
  const clock = options.clock ?? {
    now: Date.UTC(2026, 10, 11, 10, 0, 0),
    advance(ms: number) {
      clock.now += ms;
    },
  };
  const now = () => clock.now;
  const warnings: string[] = [];
  const stores = createSqliteStores({ path: options.databasePath ?? ':memory:', keys: dataKeys(TEST_DATA_KEY), now, seed: directory, audit: { notice: (message) => void warnings.push(message), ...options.audit } });
  if (options.storeLatency) {
    stores.directory = withLatency(stores.directory, options.storeHook);
    stores.payments = withLatency(stores.payments, options.storeHook);
    stores.ops.users = withLatency(stores.ops.users, options.storeHook);
    for (const group of [stores.auth, stores.ops] as unknown as Record<string, object>[]) {
      for (const name of Object.keys(group)) if (name !== 'users') group[name] = withLatency(group[name] as object, options.storeHook);
    }
  }
  const providerA = options.providers?.a ?? new MockCurrencycloudPlatform({ now, enforceOwnership: options.enforceOwnership });
  const providerB = options.providers?.b ?? new MockEqualsServer({ now, enforceOwnership: options.enforceOwnership });
  const registry = new ProviderRegistry({
    currencycloud: currencycloudFactory({ credentials: config.providers.currencycloud, transport: providerA, now }),
    equals: equalsFactory({ credentials: config.providers.equals, transport: providerB, keys: stores.providerKeys, now }),
  });
  const outbox = new ConsoleOutbox(() => {});
  const logs: string[] = [];
  const built = await buildApp({ config, stores, registry, mailer: outbox, now, logStream: { write: (line) => void logs.push(line) }, maxRateWindows: options.maxRateWindows, maxHeldQuotes: options.maxHeldQuotes, beforeSend: options.beforeSend });
  const { app, auth, opsAuth, opsRoutes, held } = built;
  const policy: Harness['policy'] = async (companyId, approvalsRequired) => {
    const company = await stores.directory.getCompany(companyId);
    if (!company) throw new Error(`no company ${companyId}`);
    await stores.directory.saveCompany({ ...company, approvalsRequired });
  };
  const admin = built.admin as NonNullable<typeof built.admin>;
  const mailedCode = (email: string): string => {
    const message = [...outbox.sent].reverse().find((item) => item.to === email);
    const code = /#code=([A-Z2-7-]+)/.exec(message?.text ?? '')?.[1];
    if (!code) throw new Error(`no activation email for ${email}`);
    return code;
  };
  const adminCall: Harness['adminCall'] = async (url, body, token = ADMIN_TOKEN) => {
    const response = await admin.inject({ method: 'POST', url, headers: token ? { authorization: `Bearer ${token}` } : {}, payload: body as object });
    return { status: response.statusCode, json: JSON.parse(response.body || 'null'), headers: response.headers };
  };
  const bodies: string[] = [];

  const call: Harness['call'] = async (method, url, options = {}) => {
    const response = await app.inject({
      method,
      url,
      headers: { ...(options.token ? { authorization: `Bearer ${options.token}` } : {}), ...options.headers },
      ...(options.body !== undefined ? { payload: options.body as object } : {}),
    });
    bodies.push(response.body, JSON.stringify(response.headers));
    let json: unknown = null;
    try {
      json = JSON.parse(response.body);
    } catch {
      // Not JSON.
    }
    return { status: response.statusCode, json, headers: response.headers };
  };

  const code: Harness['code'] = (secret, offsetSteps = 0) => totpCode(base32Decode(secret), totpStep(clock.now) + offsetSteps);
  const freshCode: Harness['freshCode'] = (secret) => {
    clock.advance(30_000);
    return code(secret);
  };
  const invite: Harness['invite'] = async (email) => (await auth.createInvite(email)).activationCode;

  const activate: Harness['activate'] = async (email, password = PASSWORD) => {
    const activationCode = await invite(email);
    const enrol = await call('POST', '/v1/activation/password', { body: { activationCode, password } });
    if (enrol.status !== 200) throw new Error(`activation password failed: ${enrol.status}`);
    const confirm = await call('POST', '/v1/activation/confirm', { body: { activationCode, code: code(enrol.json.secret) } });
    if (confirm.status !== 200) throw new Error(`activation confirm failed: ${confirm.status}`);
    return { secret: enrol.json.secret, recoveryCodes: confirm.json.recoveryCodes };
  };

  const login: Harness['login'] = async (email, secret, password = PASSWORD) => {
    const first = await call('POST', '/v1/auth/login', { body: { email, password } });
    if (first.status !== 200) return first;
    return call('POST', '/v1/auth/login/verify', { body: { challengeId: first.json.challengeId, code: freshCode(secret), method: 'totp' } });
  };

  const stepUp: Harness['stepUp'] = async (token, secret, action, payload) => {
    const reply = await call('POST', '/v1/step-up', { token, body: { action, payload, code: freshCode(secret) } });
    if (reply.status !== 200) throw new Error(`step-up failed: ${reply.status} ${JSON.stringify(reply.json)}`);
    return reply.json.token;
  };

  return { policy, held, config, stores, clock, bodies, call, invite, activate, code, freshCode, login, stepUp, app, opsAuth, opsRoutes, admin, adminCall, auth, registry, outbox, mailedCode, providerA, providerB, logs, warnings,
    close: async () => {
      await app.close();
      await admin.close();
      stores.close();
    },
  };
}

export const AMIRA = 'amira@northfield.example';
export const BEN = 'ben@castlebrook.example';
export const DANA = 'dana@adviser.example';

/** Every row of every table, as text: what someone holding the database file could read. */
export function dumpDatabase(stores: SqliteStores): string {
  const tables = stores.db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'");
  return JSON.stringify(tables.map((table) => [table.name, stores.db.all(`SELECT * FROM ${table.name}`)]));
}
