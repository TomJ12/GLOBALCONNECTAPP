/**
 * Builds what the server runs on (the database, provider registry, mailer)
 * and refuses to start in an unsafe combination.
 *
 * Outside explicit development mode the server will not run on in-memory mock
 * providers, without a real mailer, without a database file, or without the
 * data encryption key. Since this repository contains no live provider
 * transport and no real mailer yet, it cannot start outside development mode
 * at all. That is deliberate: a "production" process serving sample data from
 * a mock is worse than no process.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import type { Transport } from '@/api/adapters/currencycloud/transport';

import type { AuthService, Invitation } from './auth/service';
import type { Config } from './config';
import { normaliseCode, sha256 } from './crypto';
import { ConsoleOutbox, type Mailer } from './mailer';
import type { OpsAuthService } from './ops/auth';
import { ProviderRegistry } from './providers/adapter';
import { currencycloudFactory } from './providers/currencycloud';
import { equalsFactory } from './providers/equals/adapter';
import type { EqualsTransport } from './providers/equals/raw';
import { seedDirectory } from './store/seed';
import { createSqliteStores, type SeedCode, type SqliteStores } from './store/sqlite';
import type { AuditOptions } from './store/sqlite/audit';
import { dataKeys, newDataKey, type DataKeys } from './store/sqlite/keys';
import type { ActivationRecord, OpsRole, Table } from './store/types';

export interface RuntimeOptions {
  /** Live wires to the providers. Without them the in-memory mocks are used (development only). */
  transports?: { currencycloud?: Transport; equals?: EqualsTransport };
  /** A real mailer. Without one the console outbox is used (development only). */
  mailer?: Mailer;
  now?: () => number;
  audit?: AuditOptions;
}

export interface Runtime {
  stores: SqliteStores;
  registry: ProviderRegistry;
  mailer: Mailer;
  /** Development only: the codes the server itself printed for the sample accounts. Never written outside development. */
  seedCodes: Table<SeedCode>;
}

/**
 * The key that encrypts authenticator keys at rest. Outside development it
 * MUST come from the environment (config.ts refuses to load without it). In
 * development, with a database file, one is generated once and kept in a file
 * BESIDE the database (never in it) so the demo's accounts can be read after
 * a restart; with an in-memory database it lives and dies with the process.
 */
export function keysFor(config: Config): DataKeys {
  if (config.dataEncryptionKey) return dataKeys(config.dataEncryptionKey, config.previousDataEncryptionKeys);
  if (config.strict) throw new Error('DATA_ENCRYPTION_KEY must be set.');
  if (!config.databasePath) return dataKeys(newDataKey());
  const file = `${path.resolve(config.databasePath)}.dev-key`;
  if (!existsSync(file)) {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, `${newDataKey()}\n`, { mode: 0o600 });
  }
  return dataKeys(readFileSync(file, 'utf8'), config.previousDataEncryptionKeys);
}

export function createRuntime(config: Config, options: RuntimeOptions = {}): Runtime {
  if (config.strict && !options.mailer) {
    throw new Error('No mailer is configured. Activation links are delivered by email only; supply a Mailer (see src/mailer.ts) or, for a local demonstration, set APP_ENV=development.');
  }
  if (config.strict && !config.databasePath) throw new Error('DATABASE_PATH must be set.');
  const mailer = options.mailer ?? new ConsoleOutbox();
  if (config.databasePath) mkdirSync(path.dirname(path.resolve(config.databasePath)), { recursive: true });
  const stores = createSqliteStores({
    path: config.databasePath ? path.resolve(config.databasePath) : ':memory:',
    keys: keysFor(config),
    now: options.now,
    audit: options.audit,
    // Sample people and companies exist only in development, and only in a database that has none.
    seed: config.development ? seedDirectory() : undefined,
  });
  const registry = new ProviderRegistry({
    currencycloud: currencycloudFactory({ credentials: config.providers.currencycloud, transport: options.transports?.currencycloud, now: options.now }),
    equals: equalsFactory({ credentials: config.providers.equals, transport: options.transports?.equals, keys: stores.providerKeys, now: options.now }),
  });
  const mocked = registry.mocked();
  if (config.strict && mocked.length > 0) {
    stores.close();
    throw new Error(`Refusing to start: ${mocked.join(' and ')} would be served by an in-memory MOCK with sample data. Supply live provider transports or, for a local demonstration, set APP_ENV=development.`);
  }
  // Activation codes in readable form are a development convenience only: outside development nothing may be written there.
  const seedCodes: Table<SeedCode> = config.development ? stores.seedCodes : refusing<SeedCode>();
  return { stores, registry, mailer, seedCodes };
}

function refusing<T>(): Table<T> {
  const refuse = async (): Promise<never> => {
    throw new Error('Readable activation codes are kept only in development mode.');
  };
  return { get: async () => null, put: refuse, delete: async () => {}, deleteWhere: async () => {}, count: async () => 0, list: async () => [], mutate: refuse, take: async () => null };
}

/** The demo staff: two ops admins (staff management needs one to ask and another to approve) and an ops user. */
export const DEMO_STAFF: { email: string; name: string; role: OpsRole }[] = [
  { email: 'ops.admin@globalconnect.example', name: 'Demo Ops Admin', role: 'ops_admin' },
  { email: 'ops.admin2@globalconnect.example', name: 'Demo Ops Admin Two', role: 'ops_admin' },
  { email: 'ops.second@globalconnect.example', name: 'Demo Ops User', role: 'ops' },
];

/**
 * DEVELOPMENT ONLY. Makes sure each SAMPLE account that is not activated has
 * a usable activation code, and returns the lines to print.
 *
 * It never replaces a live invitation. If the code it printed on an earlier
 * start is still valid it prints the same code again. If somebody issued a
 * link since (from the ops console, or with `npm run invite`) that link is
 * left alone. Only when there is no live invitation at all is a new one made.
 * Accounts created through the ops console are never touched here: their
 * links come from the console, by email.
 */
export async function seedInvitations(runtime: Pick<Runtime, 'stores' | 'seedCodes'>, auth: AuthService, opsAuth: OpsAuthService, config: Pick<Config, 'appUrl' | 'opsUrl'>, now: () => number = Date.now): Promise<string[]> {
  const { stores, seedCodes } = runtime;
  const lines: string[] = [];
  const line = async (key: string, userId: string, email: string, note: string, activations: Table<ActivationRecord>, create: () => Promise<Invitation>, linkFor: (code: string) => string) => {
    const saved = await seedCodes.get(key);
    const mine = saved ? await activations.get(saved.codeHash) : null;
    const until = (at: number) => new Date(at).toISOString().slice(0, 16).replace('T', ' ');
    if (saved && mine && mine.userId === userId && mine.expiresAt > now()) {
      lines.push(`  ${email.padEnd(34)} ${saved.code}   ${linkFor(saved.code)}   ${note}(still valid, until ${until(mine.expiresAt)} UTC)`);
      return;
    }
    if ((await activations.count({ userId }, (record) => record.expiresAt > now())) > 0) {
      lines.push(`  ${email.padEnd(34)} a link emailed since the last start is still valid and has NOT been replaced (see the DEVELOPMENT OUTBOX output of that run)   ${note}`);
      return;
    }
    const invite = await create();
    await seedCodes.put(key, { code: invite.activationCode, codeHash: sha256(normaliseCode(invite.activationCode)) });
    lines.push(`  ${email.padEnd(34)} ${invite.activationCode}   ${invite.activationLink}   ${note}`);
  };

  const sample = new Set(seedDirectory().users.map((user) => user.id));
  for (const user of await stores.directory.listUsers()) {
    if (!sample.has(user.id) || user.activatedAt !== null || user.disabledAt) continue;
    const link = (code: string) => `${config.appUrl}/activate#code=${code}`;
    await line(`client:${user.id}`, user.id, user.email, '', stores.auth.activations, () => auth.createInvite(user.email), link);
  }
  const staff = await stores.ops.users.list();
  for (const demo of DEMO_STAFF) {
    const existing = staff.find((user) => user.email === demo.email);
    if (!existing && staff.length >= DEMO_STAFF.length) continue;
    const user = existing ?? (await opsAuth.createUser(demo.email, demo.name, demo.role));
    if (user.activatedAt !== null || user.disabledAt !== null) continue;
    const link = (code: string) => `${config.opsUrl}/ops/activate#code=${code}`;
    await line(`staff:${user.id}`, user.id, user.email, `(staff: ${demo.role}) `, stores.ops.activations, () => opsAuth.createInvite(user.id), link);
  }
  return lines;
}
