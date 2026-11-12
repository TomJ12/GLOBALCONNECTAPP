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

if (config.development) {
  // EXPLICIT DEVELOPMENT MODE ONLY (APP_ENV=development). There is no email
  // delivery, so activation codes for the SAMPLE accounts that are not
  // activated are printed here. Nothing below runs in any other mode, and an
  // invitation that is still valid is never replaced by a restart.
  const lines: string[] = ['DEVELOPMENT MODE (APP_ENV=development): mock providers, sample data, emails printed to this console.'];
  if (config.dataFile) lines.push(`Accounts are being KEPT in ${config.dataFile} (password hashes and authenticator keys in plain form: local demo only).`);
  if (!config.fourEyes) lines.push('FOUR-EYES APPROVAL IS OFF (FOUR_EYES=off): one staff member alone can make sensitive changes.');
  lines.push('', 'Activation codes for the sample accounts not yet activated (codes from an earlier start stay valid for 72 hours):');
  lines.push(...(await seedInvitations(runtime, auth, opsAuth, config)));
  lines.push('', `Ops console: ${config.opsUrl}/ops`, 'If the code field is empty after opening a link, type the code printed next to it.');
  console.log(['', ...lines, ''].join('\n'));
}
