/** Starts the server. See startup.ts for what it refuses to start on. */
import { loadConfig } from './config';
import { buildApp } from './http/app';
import { createRuntime, seedInvitations } from './startup';

const config = loadConfig();
const runtime = createRuntime(config);
const { stores, registry, mailer } = runtime;
const { app, admin, auth, opsAuth } = await buildApp({ config, stores, registry, mailer });
await app.listen({ port: config.port, host: config.host });
// The operator commands are served on the loopback address ONLY, on their own port.
if (admin) await admin.listen({ port: config.adminPort, host: '127.0.0.1' });

// Expired invitations, challenges, permissions and idle counters are removed now and then, so tables do not only grow.
const sweep = () => stores.sweep(config.sessionAbsoluteMs, config.opsSessionAbsoluteMs).catch((error: unknown) => app.log.error({ message: error instanceof Error ? error.message : 'unknown error' }, 'sweep failed'));
await sweep();
setInterval(sweep, 5 * 60_000).unref();

let closing = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    if (closing) return;
    closing = true;
    // Stop taking requests, then close the database cleanly (its write-ahead log is folded back into the file).
    void Promise.allSettled([app.close(), admin?.close()]).then(() => {
      stores.close();
      process.exit(0);
    });
  });
}

if (config.development) {
  // EXPLICIT DEVELOPMENT MODE ONLY (APP_ENV=development). There is no email
  // delivery, so activation codes for the SAMPLE accounts that are not
  // activated are printed here. Nothing below runs in any other mode, and an
  // invitation that is still valid is never replaced by a restart.
  const lines: string[] = ['DEVELOPMENT MODE (APP_ENV=development): mock providers, sample data, emails printed to this console.'];
  lines.push(
    config.databasePath
      ? `Data is KEPT in the SQLite database ${config.databasePath}${config.dataEncryptionKey ? '' : ` (its development encryption key is in ${config.databasePath}.dev-key, beside it)`}.`
      : 'No DATABASE_PATH: the database is in memory and everything is forgotten when the server stops.',
  );
  if (!config.fourEyes) lines.push('FOUR-EYES APPROVAL IS OFF (FOUR_EYES=off): one staff member alone can make sensitive changes.');
  lines.push('', 'Activation codes for the sample accounts not yet activated (codes from an earlier start stay valid for 72 hours):');
  lines.push(...(await seedInvitations(runtime, auth, opsAuth, config)));
  lines.push('', `Ops console: ${config.opsUrl}/ops`, 'If the code field is empty after opening a link, type the code printed next to it.');
  console.log(['', ...lines, ''].join('\n'));
}
