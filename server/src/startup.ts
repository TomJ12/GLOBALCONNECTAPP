/**
 * Builds what the server runs on (stores, provider registry, mailer) and
 * refuses to start in an unsafe combination.
 *
 * Outside explicit development mode the server will not run on in-memory mock
 * providers, will not run without a real mailer, and will not use the JSON
 * file store. Since this repository contains no live provider transport and no
 * real mailer yet, it cannot start outside development mode at all. That is
 * deliberate: a "production" process serving sample data from a mock is worse
 * than no process.
 */
import type { Transport } from '@/api/adapters/currencycloud/transport';

import type { Config } from './config';
import { ConsoleOutbox, type Mailer } from './mailer';
import { ProviderRegistry } from './providers/adapter';
import { currencycloudFactory } from './providers/currencycloud';
import { equalsFactory } from './providers/equals/adapter';
import type { EqualsTransport } from './providers/equals/raw';
import type { AuthService, Invitation } from './auth/service';
import { normaliseCode, sha256 } from './crypto';
import type { OpsAuthService } from './ops/auth';
import { createFileStores, type SeedCode } from './store/file';
import { createMemoryStores, MemoryTable } from './store/memory';
import { seedDirectory } from './store/seed';
import type { ActivationRecord, OpsRole, Stores, Table } from './store/types';

export interface RuntimeOptions {
  /** Live wires to the providers. Without them the in-memory mocks are used (development only). */
  transports?: { currencycloud?: Transport; equals?: EqualsTransport };
  /** A real mailer. Without one the console outbox is used (development only). */
  mailer?: Mailer;
  now?: () => number;
}

export interface Runtime {
  stores: Stores;
  registry: ProviderRegistry;
  mailer: Mailer;
  /** Development only: the codes the server itself printed for the sample accounts (kept in the demo file). */
  seedCodes: Table<SeedCode>;
}

export function createRuntime(config: Config, options: RuntimeOptions = {}): Runtime {
  if (config.strict && !options.mailer) {
    throw new Error('No mailer is configured. Activation links are delivered by email only; supply a Mailer (see src/mailer.ts) or, for a local demonstration, set APP_ENV=development.');
  }
  const mailer = options.mailer ?? new ConsoleOutbox();
  const filed = config.dataFile ? createFileStores(config.dataFile, seedDirectory(), { development: config.development, now: options.now }) : null;
  const stores: Stores = filed ?? createMemoryStores(config.development ? seedDirectory() : { users: [], companies: [], memberships: [] }, options.now);
  const seedCodes: Table<SeedCode> = filed?.seedCodes ?? new MemoryTable<SeedCode>();
  const registry = new ProviderRegistry({
    currencycloud: currencycloudFactory({ credentials: config.providers.currencycloud, transport: options.transports?.currencycloud, now: options.now }),
    equals: equalsFactory({ credentials: config.providers.equals, transport: options.transports?.equals, keys: stores.providerKeys, now: options.now }),
  });
  const mocked = registry.mocked();
  if (config.strict && mocked.length > 0) {
    throw new Error(`Refusing to start: ${mocked.join(' and ')} would be served by an in-memory MOCK with sample data. Supply live provider transports or, for a local demonstration, set APP_ENV=development.`);
  }
  return { stores, registry, mailer, seedCodes };
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
    if ((await activations.count((record) => record.userId === userId && record.expiresAt > now())) > 0) {
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
