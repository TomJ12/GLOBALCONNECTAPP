/** Starts the server. See startup.ts for what it refuses to start on. */
import { loadConfig } from './config';
import { buildApp } from './http/app';
import { createRuntime, seedInvitations } from './startup';

const config = loadConfig();
const runtime = createRuntime(config);
const { stores, registry, mailer } = runtime;
if (stores.acceptedLogEnd) console.error('AUDIT_ACCEPT_LOG_END was used: the audit log was accepted as it stood and that is recorded in it. REMOVE THE SETTING NOW; the server will not start again while it is set.');
const { app, admin, auth, opsAuth, held, mail, authenticatorResets } = await buildApp({ config, stores, registry, mailer });
// The email outbox: attempts cut off by the last stop are due again, and what is due is sent now and every 15 seconds.
await mail.recover();
void mail.pump();
setInterval(() => void mail.pump(), 15_000).unref();
setInterval(() => void mail.sweep(), 60 * 60_000).unref();
// Authenticator resets whose delay has passed are carried out now and every minute.
const resets = () => authenticatorResets.runDue().catch((error: unknown) => app.log.error({ message: error instanceof Error ? error.message : 'unknown error' }, 'authenticator resets failed'));
await resets();
setInterval(() => void resets(), 60_000).unref();
// Held payments: at start-up every send that a crash or restart left unfinished is settled (by its idempotency key)
// before the server takes requests; after that, once a minute, payments that waited too long expire and any send
// still unanswered is looked at again.
const settle = (all: boolean) => held.sweep({ all }).catch((error: unknown) => app.log.error({ message: error instanceof Error ? error.message : 'unknown error' }, 'payment sweep failed'));
await settle(true);
// Requests that were approved in the ops console and then interrupted while being carried out are not guessed at:
// they are shown on the Approvals page to be finished or closed. Said here too, so it is not missed.
const interrupted = await stores.ops.approvals.count({ status: 'applying' });
if (interrupted > 0) console.error(`${interrupted} approved ${interrupted === 1 ? 'request was' : 'requests were'} interrupted while being carried out. Open the ops console, Approvals, to finish or close ${interrupted === 1 ? 'it' : 'them'}.`);
setInterval(() => void settle(false), 60_000).unref();

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
  if (config.openOnNetwork) lines.push(`WARNING: DEV_OPEN_ON_NETWORK=1. This development server listens on ${config.host} WITHOUT the demo gate: anyone who can reach this machine sees the sample accounts and the codes printed below.`);
  if (!config.fourEyes) lines.push('FOUR-EYES APPROVAL IS OFF (FOUR_EYES=off): one staff member alone can make sensitive changes.');
  if (config.demoAccessPassword) lines.push('THE DEMO GATE IS ON: nothing but /healthz is served until a visitor has typed the demo password.');
  if (config.publicDemo && !config.demoSetupCodes) {
    // On a public address the log is not the place for activation codes, except during first-time set-up, when it is asked for.
    lines.push('', 'Activation codes for the sample accounts are NOT printed (set DEMO_SETUP_CODES=1 for the first start to print them once; see docs/DEPLOY-DEMO.md).', `Ops console: ${config.opsUrl}/ops`);
    console.log(['', ...lines, ''].join('\n'));
  } else {
    lines.push('', 'Activation codes for the sample accounts not yet activated (codes from an earlier start stay valid for 72 hours):');
    lines.push(...(await seedInvitations(runtime, auth, opsAuth, config)));
    lines.push('', `Ops console: ${config.opsUrl}/ops`, 'If the code field is empty after opening a link, type the code printed next to it.');
    console.log(['', ...lines, ''].join('\n'));
  }
}
