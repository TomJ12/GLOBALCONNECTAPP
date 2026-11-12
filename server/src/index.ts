/** Starts the server. See startup.ts for what it refuses to start on. */
import { loadConfig } from './config';
import { buildApp } from './http/app';
import { createRuntime } from './startup';

const DEMO_STAFF = [
  { email: 'ops.admin@globalconnect.example', name: 'Demo Ops Admin', role: 'ops_admin' as const },
  { email: 'ops.second@globalconnect.example', name: 'Demo Ops Second', role: 'ops' as const },
];

const config = loadConfig();
const { stores, registry, mailer } = createRuntime(config);
const { app, admin, auth, opsAuth } = await buildApp({ config, stores, registry, mailer });
await app.listen({ port: config.port, host: config.host });
// The operator commands are served on the loopback address ONLY, on their own port.
if (admin) await admin.listen({ port: config.adminPort, host: '127.0.0.1' });

if (config.development) {
  // EXPLICIT DEVELOPMENT MODE ONLY (APP_ENV=development). There is no email
  // delivery, so activation codes for accounts that are not activated are
  // printed here. Nothing below runs in any other mode.
  const lines: string[] = ['DEVELOPMENT MODE (APP_ENV=development): mock providers, sample data, emails printed to this console.'];
  if (config.dataFile) lines.push(`Accounts are being KEPT in ${config.dataFile} (password hashes and authenticator keys in plain form: local demo only).`);
  if (!config.fourEyes) lines.push('FOUR-EYES APPROVAL IS OFF (FOUR_EYES=off): one staff member alone can make sensitive changes.');
  lines.push('', 'Activation codes for accounts not yet activated (sample data):');
  for (const user of await stores.directory.listUsers()) {
    if (user.activatedAt !== null || user.disabledAt) continue;
    const invite = await auth.createInvite(user.email);
    lines.push(`  ${user.email.padEnd(34)} ${invite.activationCode}   ${invite.activationLink}`);
  }
  // Two demo staff, so that four-eyes approval can be shown: an ops admin and an ops user.
  const staff = await stores.ops.users.list();
  for (const demo of DEMO_STAFF) {
    const existing = staff.find((user) => user.email === demo.email);
    if (!existing && staff.length >= DEMO_STAFF.length) continue;
    const user = existing ?? (await opsAuth.createUser(demo.email, demo.name, demo.role));
    if (user.activatedAt !== null || user.disabledAt !== null) continue;
    const invite = await opsAuth.createInvite(user.id);
    lines.push(`  ${demo.email.padEnd(34)} ${invite.activationCode}   ${invite.activationLink}   (staff: ${demo.role})`);
  }
  lines.push('', `Ops console: ${config.opsUrl}/ops`);
  console.log(['', ...lines, ''].join('\n'));
}
