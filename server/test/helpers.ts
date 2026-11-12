import { base32Decode, setPasswordCost, totpCode, totpStep } from '../src/crypto';
import { loadConfig, type Config } from '../src/config';
import { buildApp } from '../src/http/app';
import { ProviderRegistry } from '../src/providers/adapter';
import { currencycloudFactory } from '../src/providers/currencycloud';
import { MockCurrencycloudPlatform } from '../src/providers/currencycloudMock';
import { equalsFactory } from '../src/providers/equals/adapter';
import { MockEqualsServer } from '../src/providers/equals/mockServer';
import { ConsoleOutbox } from '../src/mailer';
import { createMemoryStores, type AuditOptions, type DirectoryData } from '../src/store/memory';
import { seedDirectory } from '../src/store/seed';
import type { Stores } from '../src/store/types';

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
  stores: Stores;
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
  opsAuth: Awaited<ReturnType<typeof buildApp>>['opsAuth'];
  opsRoutes: { method: string; url: string }[];
}

export interface HarnessOptions {
  /** false = the mock providers act on any id whatever the scope says, so only the server's own checks stand between companies. */
  enforceOwnership?: boolean;
  audit?: AuditOptions;
  maxRateWindows?: number;
  maxHeldQuotes?: number;
  /**
   * Every store operation takes a real turn of the event loop first, as a
   * database round trip would. In-memory operations otherwise finish within
   * one request's turn, and two "simultaneous" requests never interleave: the
   * race tests would then pass whatever the code did.
   */
  storeLatency?: boolean;
}

function withLatency<T extends object>(target: T): T {
  return new Proxy(target, {
    get(object, property, receiver) {
      const value = Reflect.get(object, property, receiver);
      if (typeof value !== 'function') return value;
      return async (...args: unknown[]) => {
        await new Promise((resolve) => setImmediate(resolve));
        return (value as (...inner: unknown[]) => unknown).apply(object, args);
      };
    },
  });
}

export async function harness(overrides: Partial<Config> = {}, directory: DirectoryData = seedDirectory(), options: HarnessOptions = {}): Promise<Harness> {
  const config: Config = { ...loadConfig({ APP_ENV: 'development', LOG: '0', ADMIN_TOKEN }), authRequestsPerMinute: 100_000, ...overrides };
  const clock = {
    now: Date.UTC(2026, 10, 11, 10, 0, 0),
    advance(ms: number) {
      clock.now += ms;
    },
  };
  const now = () => clock.now;
  const stores = createMemoryStores(directory, now, options.audit);
  if (options.storeLatency) {
    stores.directory = withLatency(stores.directory);
    stores.ops.users = withLatency(stores.ops.users);
    for (const group of [stores.auth, stores.ops] as unknown as Record<string, object>[]) {
      for (const name of Object.keys(group)) if (name !== 'users') group[name] = withLatency(group[name] as object);
    }
  }
  const providerA = new MockCurrencycloudPlatform({ now, enforceOwnership: options.enforceOwnership });
  const providerB = new MockEqualsServer({ now, enforceOwnership: options.enforceOwnership });
  const registry = new ProviderRegistry({
    currencycloud: currencycloudFactory({ credentials: config.providers.currencycloud, transport: providerA, now }),
    equals: equalsFactory({ credentials: config.providers.equals, transport: providerB, keys: stores.providerKeys, now }),
  });
  const outbox = new ConsoleOutbox(() => {});
  const logs: string[] = [];
  const built = await buildApp({ config, stores, registry, mailer: outbox, now, logStream: { write: (line) => void logs.push(line) }, maxRateWindows: options.maxRateWindows, maxHeldQuotes: options.maxHeldQuotes });
  const { app, auth, opsAuth, opsRoutes } = built;
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

  return { config, stores, clock, bodies, call, invite, activate, code, freshCode, login, stepUp, app, opsAuth, opsRoutes, admin, adminCall, auth, registry, outbox, mailedCode, providerA, providerB, logs,
    close: async () => {
      await app.close();
      await admin.close();
    },
  };
}

export const AMIRA = 'amira@northfield.example';
export const BEN = 'ben@castlebrook.example';
export const DANA = 'dana@adviser.example';
