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
 */
import { spawn, spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = process.env.PORT ?? '3001';
const codespace = process.env.CODESPACE_NAME;
const domain = process.env.GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN ?? 'app.github.dev';
const publicUrl = process.env.APP_URL ?? (codespace ? `https://${codespace}-${port}.${domain}` : `http://localhost:${port}`);
const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

if (process.env.NODE_ENV === 'production') {
  console.error('npm run demo is for demonstrations only and will not run with NODE_ENV=production.');
  process.exit(1);
}

// LOCAL DEMO ONLY: accounts are kept in this git-ignored file so they survive a restart.
// It holds password hashes and authenticator keys in plain form.
const dataFile = process.env.DATA_FILE ?? path.join(root, '.demo-data', 'accounts.json');
if (process.argv.includes('--reset')) {
  rmSync(dataFile, { force: true });
  console.log(`Removed ${dataFile}. The next npm run demo starts with fresh sample accounts.`);
  process.exit(0);
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
  `\nOpen ${publicUrl} (client app) or ${publicUrl}/ops (ops console)\nActivation codes are printed below.\n` +
    `Demo accounts are being kept in ${dataFile} (local demo only; wipe with: npm run demo:reset).\n`,
);
const server = spawn(npm, ['--prefix', 'server', 'run', 'start'], {
  cwd: root,
  stdio: 'inherit',
  env: { ...process.env, PORT: port, WEB_DIR: path.join(root, 'dist-demo'), APP_URL: publicUrl, DATA_FILE: dataFile, TRUST_PROXY: codespace ? '1' : (process.env.TRUST_PROXY ?? '0') },
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.kill(signal));
server.on('exit', (code) => process.exit(code ?? 0));
