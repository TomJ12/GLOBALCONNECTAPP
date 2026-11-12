/** Starts the server with the in-memory stores and the sample directory. */
import { loadConfig } from './config';
import { buildApp } from './http/app';
import { ProviderRegistry } from './providers/adapter';
import { currencycloudFactory } from './providers/currencycloud';
import { equalsFactory } from './providers/equals/adapter';
import { createMemoryStores } from './store/memory';
import { seedDirectory } from './store/seed';

const config = loadConfig();
const stores = createMemoryStores(seedDirectory());
const registry = new ProviderRegistry({
  currencycloud: currencycloudFactory({ credentials: config.providers.currencycloud }),
  equals: equalsFactory({ credentials: config.providers.equals }),
});
const { app, auth } = await buildApp({ config, stores, registry });
await app.listen({ port: config.port, host: config.host });

if (!config.production) {
  // DEVELOPMENT ONLY. There is no email delivery yet, so the sample users'
  // activation codes are printed here. This block never runs in production.
  const lines: string[] = [];
  for (const user of await stores.directory.listUsers()) {
    if (user.activatedAt !== null) continue;
    const invite = await auth.createInvite(user.email);
    lines.push(`  ${user.email.padEnd(28)} ${invite.activationCode}   ${invite.activationLink}`);
  }
  console.log(['', 'DEVELOPMENT ONLY: activation codes for the sample users (sample data, in-memory storage)', ...lines, ''].join('\n'));
}
