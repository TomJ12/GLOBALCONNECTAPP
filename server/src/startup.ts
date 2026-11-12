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
import { createFileStores } from './store/file';
import { createMemoryStores } from './store/memory';
import { seedDirectory } from './store/seed';
import type { Stores } from './store/types';

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
}

export function createRuntime(config: Config, options: RuntimeOptions = {}): Runtime {
  if (config.strict && !options.mailer) {
    throw new Error('No mailer is configured. Activation links are delivered by email only; supply a Mailer (see src/mailer.ts) or, for a local demonstration, set APP_ENV=development.');
  }
  const mailer = options.mailer ?? new ConsoleOutbox();
  const stores = config.dataFile
    ? createFileStores(config.dataFile, seedDirectory(), { development: config.development, now: options.now })
    : createMemoryStores(config.development ? seedDirectory() : { users: [], companies: [], memberships: [] }, options.now);
  const registry = new ProviderRegistry({
    currencycloud: currencycloudFactory({ credentials: config.providers.currencycloud, transport: options.transports?.currencycloud, now: options.now }),
    equals: equalsFactory({ credentials: config.providers.equals, transport: options.transports?.equals, keys: stores.providerKeys, now: options.now }),
  });
  const mocked = registry.mocked();
  if (config.strict && mocked.length > 0) {
    throw new Error(`Refusing to start: ${mocked.join(' and ')} would be served by an in-memory MOCK with sample data. Supply live provider transports or, for a local demonstration, set APP_ENV=development.`);
  }
  return { stores, registry, mailer };
}
