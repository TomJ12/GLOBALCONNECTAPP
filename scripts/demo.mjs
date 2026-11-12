#!/usr/bin/env node
/**
 * npm run demo
 *
 * Builds the web app pointed at the Global Connect server and starts the
 * server so that it serves the web app and the API from ONE port. Same origin
 * means no cross-origin requests, so it works unchanged on a laptop and behind
 * a GitHub Codespaces forwarded port (including a private one).
 *
 * Sample data, mock providers, accounts kept in a local JSON file (DATA_FILE).
 * Not a deployment. `npm run demo:reset` (this script with --reset) wipes the file.
 *
 * The server is strict by default and would refuse all of that. This script
 * starts it with APP_ENV=development, which is the explicit opt-in.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
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

// LOCAL DEMO ONLY: accounts are kept in this git-ignored file so they survive a restart.
// It holds password hashes and authenticator keys in plain form.
const dataFile = process.env.DATA_FILE ?? path.join(root, '.demo-data', 'accounts.json');
// Must be the same number as DATA_FILE_VERSION in server/src/store/file.ts (a test checks it).
const DATA_FILE_VERSION = 3;
if (process.argv.includes('--reset')) {
  rmSync(dataFile, { force: true });
  // Archived audit segments sit beside the data file.
  const folder = path.dirname(dataFile);
  if (existsSync(folder)) for (const name of readdirSync(folder)) if (name.startsWith(`${path.basename(dataFile)}.audit-`)) rmSync(path.join(folder, name), { force: true });
  console.log(`Removed ${dataFile}. The next npm run demo starts with fresh sample accounts.`);
  process.exit(0);
}

// Checked BEFORE the web build, which takes a minute: a data file written by an earlier
// version would only be refused by the server after it, where the message is easy to miss.
if (existsSync(dataFile)) {
  let version;
  try {
    version = JSON.parse(readFileSync(dataFile, 'utf8')).version;
  } catch {
    version = 'unreadable';
  }
  if (version !== DATA_FILE_VERSION) {
    console.error(
      [
        '',
        '==================================================================================',
        '  The saved demo accounts were written by an earlier version of this project',
        `  (${dataFile}, version ${version}; this version needs ${DATA_FILE_VERSION}).`,
        '  They cannot be used. To start again with fresh sample accounts, run:',
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
    `Demo accounts are being kept in ${dataFile} (local demo only; wipe with: npm run demo:reset).\n`,
);
const server = spawn(npm, ['--prefix', 'server', 'run', 'start'], {
  cwd: root,
  stdio: 'inherit',
  env: {
    ...process.env,
    // The explicit opt-in to mock providers, sample data, printed codes and the file store.
    APP_ENV: 'development',
    PORT: port,
    WEB_DIR: path.join(root, 'dist-demo'),
    APP_URL: publicUrl,
    DATA_FILE: dataFile,
    // In a Codespace requests arrive through one forwarding proxy: believe exactly one hop of X-Forwarded-For.
    TRUST_PROXY: process.env.TRUST_PROXY ?? (codespace ? '1' : '0'),
  },
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.kill(signal));
server.on('exit', (code) => process.exit(code ?? 0));
