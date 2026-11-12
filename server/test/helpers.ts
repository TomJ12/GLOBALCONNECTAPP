import { base32Decode, totpCode, totpStep } from '../src/crypto';
import { loadConfig, type Config } from '../src/config';
import { buildApp } from '../src/http/app';
import { ProviderRegistry } from '../src/providers/adapter';
import { currencycloudFactory } from '../src/providers/currencycloud';
import { equalsFactory } from '../src/providers/equals/adapter';
import { createMemoryStores, type DirectoryData } from '../src/store/memory';
import { seedDirectory } from '../src/store/seed';
import type { Stores } from '../src/store/types';

export const PASSWORD = 'correct horse battery';

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
  opsAuth: Awaited<ReturnType<typeof buildApp>>['opsAuth'];
  opsRoutes: { method: string; url: string }[];
}

export async function harness(overrides: Partial<Config> = {}, directory: DirectoryData = seedDirectory()): Promise<Harness> {
  const config: Config = { ...loadConfig({ NODE_ENV: 'test', LOG: '0', ADMIN_TOKEN: 'test-admin-token-0123456789' }), authRequestsPerMinute: 100_000, ...overrides };
  const clock = {
    now: Date.UTC(2026, 10, 11, 10, 0, 0),
    advance(ms: number) {
      clock.now += ms;
    },
  };
  const now = () => clock.now;
  const stores = createMemoryStores(directory);
  const registry = new ProviderRegistry({
    currencycloud: currencycloudFactory({ credentials: config.providers.currencycloud, now }),
    equals: equalsFactory({ credentials: config.providers.equals, now }),
  });
  const { app, auth, opsAuth, opsRoutes } = await buildApp({ config, stores, registry, now });
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

  return { config, stores, clock, bodies, call, invite, activate, code, freshCode, login, stepUp, close: () => app.close(), app, opsAuth, opsRoutes };
}

export const AMIRA = 'amira@northfield.example';
export const BEN = 'ben@castlebrook.example';
export const DANA = 'dana@adviser.example';
