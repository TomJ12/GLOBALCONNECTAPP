/** Starts the server with the in-memory stores (or, for a local demo, the file store) and the sample directory. */
import { loadConfig } from './config';
import { bootstrapOpsAdmin, buildApp } from './http/app';
import { ProviderRegistry } from './providers/adapter';
import { currencycloudFactory } from './providers/currencycloud';
import { equalsFactory } from './providers/equals/adapter';
import { createFileStores } from './store/file';
import { createMemoryStores } from './store/memory';
import { seedDirectory } from './store/seed';

const DEMO_OPS_ADMIN = { email: 'ops.admin@globalconnect.example', name: 'Demo Ops Admin' };

const config = loadConfig();
// loadConfig has already refused DATA_FILE in production.
const stores = config.dataFile ? createFileStores(config.dataFile, seedDirectory(), { production: config.production }) : createMemoryStores(seedDirectory());
const registry = new ProviderRegistry({
  currencycloud: currencycloudFactory({ credentials: config.providers.currencycloud }),
  equals: equalsFactory({ credentials: config.providers.equals }),
});
const { app, auth, opsAuth } = await buildApp({ config, stores, registry });
await app.listen({ port: config.port, host: config.host });

if (!config.production) {
  // DEVELOPMENT ONLY. There is no email delivery yet, so activation codes for
  // accounts that are not activated are printed here. This block never runs in production.
  const lines: string[] = [];
  if (config.dataFile) {
    lines.push(`Accounts are being KEPT in ${config.dataFile} (password hashes and authenticator keys in plain form: local demo only).`, '');
  }
  lines.push('DEVELOPMENT ONLY: activation codes for accounts not yet activated (sample data)');
  for (const user of await stores.directory.listUsers()) {
    if (user.activatedAt !== null || user.disabledAt) continue;
    const invite = await auth.createInvite(user.email);
    lines.push(`  ${user.email.padEnd(34)} ${invite.activationCode}   ${invite.activationLink}`);
  }
  // One demo ops admin, only while no ops admin has been activated.
  const admin = await bootstrapOpsAdmin(stores, opsAuth, DEMO_OPS_ADMIN.email, DEMO_OPS_ADMIN.name, Date.now(), '');
  if (admin) lines.push(`  ${DEMO_OPS_ADMIN.email.padEnd(34)} ${admin.activationCode}   ${admin.activationLink}   (ops admin)`);
  lines.push('', `Ops console: ${config.opsUrl}/ops`);
  console.log(['', ...lines, ''].join('\n'));
}
