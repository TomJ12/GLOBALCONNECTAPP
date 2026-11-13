#!/usr/bin/env node
/**
 * npm run demo
 *
 * Builds the web app pointed at the Global Connect server and starts the
 * server so that it serves the web app and the API from ONE port. Same origin
 * means no cross-origin requests, so it works unchanged on a laptop and behind
 * a GitHub Codespaces forwarded port (including a private one).
 *
 * Sample data, mock providers, everything kept in a local SQLite database
 * (.demo-data/globalconnect.sqlite). Not a deployment. `npm run demo:reset`
 * (this script with --reset) wipes it.
 *
 * The server is strict by default and would refuse all of that. This script
 * starts it with APP_ENV=development, which is the explicit opt-in.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = process.env.PORT ?? '3001';
const codespace = process.env.CODESPACE_NAME;
const domain = process.env.GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN ?? 'app.github.dev';
const publicUrl = process.env.APP_URL ?? (codespace ? `https://${codespace}-${port}.${domain}` : `http://localhost:${port}`);
const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

if (process.env.NODE_ENV === 'production' || (process.env.APP_ENV && process.env.APP_ENV !== 'development')) {
  console.error('npm run demo is for demonstrations only and will not run with NODE_ENV=production or APP_ENV=production.');
  process.exit(1);
}

// The server keeps its data with Node's built-in SQLite module. Said here, before the one-minute web build.
const [major = 0, minor = 0] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 13)) {
  console.error(`Node.js 22.13.0 or newer is required (this is ${process.versions.node}). For example:  nvm install 22 && nvm use 22`);
  process.exit(1);
}

// LOCAL DEMO ONLY: everything is kept in this git-ignored SQLite database so it survives a restart.
// Its development encryption key is generated once and kept in a file beside it (<database>.dev-key).
const database = process.env.DATABASE_PATH ?? path.join(root, '.demo-data', 'globalconnect.sqlite');
// Earlier versions of this project kept the demo accounts in a JSON file. It is no longer read.
const oldFile = process.env.DATA_FILE ?? path.join(root, '.demo-data', 'accounts.json');
if (process.argv.includes('--reset')) {
  for (const file of [database, `${database}-wal`, `${database}-shm`, `${database}.dev-key`, oldFile]) rmSync(file, { force: true });
  // Audit segments the old JSON store archived beside its file.
  const folder = path.dirname(oldFile);
  if (existsSync(folder)) for (const name of readdirSync(folder)) if (name.startsWith(`${path.basename(oldFile)}.audit-`)) rmSync(path.join(folder, name), { force: true });
  console.log(`Removed ${database}. The next npm run demo starts with fresh sample accounts.`);
  process.exit(0);
}

// Checked BEFORE the web build, which takes a minute: silently starting with fresh accounts
// while the old file sits there would leave someone wondering where their accounts went.
if (existsSync(oldFile)) {
  console.error(
    [
      '',
      '==================================================================================',
      '  The saved demo accounts were written by an earlier version of this project',
      `  (${oldFile}).`,
      '  This version keeps its data in a SQLite database and cannot use them.',
      '  To start again with fresh sample accounts, run:',
      '',
      '      npm run demo:reset',
      '',
      '  and then  npm run demo  again. (Activation links from earlier runs will not work.)',
      '==================================================================================',
      '',
    ].join('\n'),
  );
  process.exit(1);
}

console.log('Building the web app (this takes a minute)...');
const build = spawnSync(npx, ['expo', 'export', '-p', 'web', '--output-dir', 'dist-demo'], {
  cwd: root,
  stdio: 'inherit',
  // "/" = the API is on the same origin as the page.
  env: { ...process.env, EXPO_PUBLIC_API_URL: '/' },
});
if (build.status !== 0) process.exit(build.status ?? 1);

console.log(
  `\nOpen ${publicUrl} (client app) or ${publicUrl}/ops (ops console)\n` +
    'Activation codes for the sample clients and the three demo staff (two ops admins, one ops user) are printed below.\n' +
    'Codes from an earlier start stay valid: restarting does not replace them. Use the links from the LATEST start.\n' +
    'Nothing is emailed: when the ops console "sends an activation email", the email is printed in THIS terminal.\n' +
    `Demo data is being kept in ${database} (local demo only; wipe with: npm run demo:reset).\n`,
);
const server = spawn(npm, ['--prefix', 'server', 'run', 'start'], {
  cwd: root,
  stdio: 'inherit',
  env: {
    ...process.env,
    // The explicit opt-in to mock providers, sample data, printed codes and the development encryption key.
    APP_ENV: 'development',
    PORT: port,
    WEB_DIR: path.join(root, 'dist-demo'),
    APP_URL: publicUrl,
    DATABASE_PATH: database,
    DATA_FILE: '',
    // In a Codespace requests arrive through one forwarding proxy: believe exactly one hop of X-Forwarded-For.
    TRUST_PROXY: process.env.TRUST_PROXY ?? (codespace ? '1' : '0'),
  },
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.kill(signal));
server.on('exit', (code) => process.exit(code ?? 0));
