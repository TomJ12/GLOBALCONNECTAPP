/** The demo gate, and the rules for running development mode on an address the internet can reach. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { demoPasswordProblem, loadConfig } from '../src/config';
import { GATE_ATTEMPTS_PER_MINUTE, GATE_TTL_MS } from '../src/http/demoGate';
import { ADMIN_TOKEN, AMIRA, harness, TEST_DATA_KEY, type Harness } from './helpers';

const serverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEMO_PASSWORD = 'orchard-lantern-47-quay';
const SERVER_SECRET = 'Zq7Lm2Xv9Rt4Wp8Kd3Nf6Hs1Bg5Yc0JaUeOiTxMn';
let h: Harness;
afterEach(async () => h?.close());

type Reply = Awaited<ReturnType<Harness['app']['inject']>>;
const get = (url: string, headers: Record<string, string> = {}) => h.app.inject({ method: 'GET', url, headers });
const page = (url: string, headers: Record<string, string> = {}) => get(url, { accept: 'text/html,application/xhtml+xml', ...headers });
const submit = (password: string, extra: { next?: string; headers?: Record<string, string> } = {}) =>
  h.app.inject({ method: 'POST', url: '/demo-access', headers: { 'content-type': 'application/x-www-form-urlencoded', ...extra.headers }, payload: new URLSearchParams({ password, next: extra.next ?? '/' }).toString() });
const cookieOf = (reply: Reply): string => String([reply.headers['set-cookie']].flat()[0] ?? '');
const pairOf = (reply: Reply): string => cookieOf(reply).split(';')[0] as string;
/** From here on every request this test makes carries the gate cookie, as a browser that passed the gate would. */
function throughGate(cookie: string): void {
  const inject = h.app.inject.bind(h.app) as (options: any) => Promise<Reply>;
  (h.app as any).inject = (options: any) => inject({ ...options, headers: { ...options.headers, cookie: [options.headers?.cookie, cookie].filter(Boolean).join('; ') } });
}

test('demo gate: off unless DEMO_ACCESS_PASSWORD is set; /healthz is always open and says nothing', async () => {
  h = await harness();
  assert.equal((await page('/ops/login')).statusCode, 200);
  assert.equal((await get('/demo-access')).statusCode, 404);
  const health = await get('/healthz');
  assert.deepEqual([health.statusCode, health.body], [200, '{"ok":true}']);
  await h.close();

  h = await harness({ demoAccessPassword: DEMO_PASSWORD });
  const gated = await get('/healthz');
  assert.deepEqual([gated.statusCode, gated.body, gated.headers['set-cookie']], [200, '{"ok":true}', undefined]);
});

test('demo gate: nothing but /healthz is served without it; the page says what this is; only the right password opens it', async () => {
  h = await harness({ demoAccessPassword: DEMO_PASSWORD });
  // People opening a page are sent to the gate, and brought back to where they were going afterwards.
  for (const [url, next] of [['/', '%2F'], ['/payments', '%2Fpayments'], ['/ops', '%2Fops'], ['/ops/login', '%2Fops%2Flogin'], ['/ops/users?q=amira', '%2Fops%2Fusers%3Fq%3Damira'], ['/activate', '%2Factivate']] as const) {
    const reply = await page(url);
    assert.deepEqual([reply.statusCode, reply.headers.location], [303, `/demo-access?next=${next}`], url);
  }
  // Everything else is refused outright: the API, the ops console's files and forms, the operator paths.
  for (const [method, url] of [['GET', '/v1/balances'], ['POST', '/v1/auth/login'], ['POST', '/v1/activation/start'], ['GET', '/v1/company'], ['GET', '/ops/static/ops.css'], ['GET', '/ops/static/ops.js'], ['POST', '/ops/login'], ['POST', '/ops/users/usr_amira/disable'], ['GET', '/index.html'], ['GET', '/admin/invites'], ['GET', '/anything/else.js']] as const) {
    const reply = await h.app.inject({ method, url, headers: method === 'POST' ? { 'content-type': 'application/json' } : {}, payload: method === 'POST' ? '{}' : undefined });
    assert.equal(reply.statusCode, 401, `${method} ${url}`);
    assert.deepEqual(reply.json(), { error: { kind: 'unauthorized', reason: 'demo_access_required' } }, url);
  }
  // A bearer token or a staff cookie does not get past it: the gate comes first.
  assert.equal((await get('/v1/balances', { authorization: 'Bearer anything' })).json().error.reason, 'demo_access_required');
  assert.equal((await get('/ops/users', { cookie: 'gc_ops_session=anything', accept: 'text/html' })).statusCode, 303);

  // The gate page: plain, says what this is, and has no inline script or style.
  const shown = await page('/demo-access?next=%2Fops');
  assert.equal(shown.statusCode, 200);
  assert.match(shown.body, /<h1>Global Connect demo: sample data only<\/h1>/);
  assert.match(shown.body, /name="next" value="\/ops"/);
  assert.doesNotMatch(shown.body, /<script|<style|style="|onclick|onsubmit/);
  assert.match(String(shown.headers['content-security-policy']), /script-src 'self'/);
  assert.equal(shown.headers['x-frame-options'], 'DENY');
  assert.equal(shown.headers['cache-control'], 'no-store');
  assert.match((await get('/demo-access/style.css')).headers['content-type'] as string, /text\/css/);
  assert.doesNotMatch(shown.body + JSON.stringify(shown.headers), /currencycloud|equals/i);

  // Wrong passwords: refused, no cookie, the same page again.
  for (const wrong of ['', 'orchard', DEMO_PASSWORD.toUpperCase(), `${DEMO_PASSWORD} `, DEMO_PASSWORD.slice(0, -1)]) {
    const reply = await submit(wrong);
    assert.deepEqual([reply.statusCode, reply.headers['set-cookie']], [401, undefined], `"${wrong}"`);
    assert.match(reply.body, /That is not the demo password\./);
  }
  // Another site cannot submit the form for the visitor.
  assert.equal((await submit(DEMO_PASSWORD, { headers: { 'sec-fetch-site': 'cross-site' } })).statusCode, 403);

  // The right one: a cookie, and back to where the person was going. Nowhere else: not another site.
  h.clock.advance(60_000);
  const opened = await submit(DEMO_PASSWORD, { next: '/ops/users?q=amira' });
  assert.deepEqual([opened.statusCode, opened.headers.location], [303, '/ops/users?q=amira']);
  assert.match(cookieOf(opened), /^gc_demo=\d+\.[\w-]+\.[\w-]+; Path=\/; HttpOnly; SameSite=Lax; Max-Age=43200$/);
  for (const next of ['//evil.example', 'https://evil.example', '/\\evil.example', '/demo-access']) assert.equal((await submit(DEMO_PASSWORD, { next })).headers.location, '/', next);

  // With it: pages and the API answer as they always did.
  const cookie = pairOf(opened);
  assert.equal((await page('/ops/login', { cookie })).statusCode, 200);
  assert.equal((await get('/v1/balances', { cookie })).json().error.kind, 'unauthorized');
  assert.equal((await get('/v1/balances', { cookie })).json().error.reason, undefined, 'now it is the API asking for a session, not the gate');
  assert.equal((await page('/demo-access?next=%2Fops', { cookie })).headers.location, '/ops');
});

test('demo gate: the cookie is signed. Altered, made up, expired, or signed under another password or key, it opens nothing', async () => {
  h = await harness({ demoAccessPassword: DEMO_PASSWORD, serverSecret: SERVER_SECRET });
  const cookie = pairOf(await submit(DEMO_PASSWORD));
  const [name, value] = cookie.split('=') as [string, string];
  const [expires, nonce, signature] = value.split('.') as [string, string, string];
  const opens = async (candidate: string) => (await get('/v1/balances', { cookie: candidate })).json().error.reason !== 'demo_access_required';
  assert.equal(await opens(cookie), true);
  assert.equal(await opens(`other=1; ${cookie}; more=2`), true, 'among other cookies');
  for (const [what, forged] of [
    ['a later expiry written in', `${Number(expires) + 1}.${nonce}.${signature}`],
    ['another random part', `${expires}.${nonce}x.${signature}`],
    ['a changed signature', `${expires}.${nonce}.${signature.slice(0, -1)}${signature.endsWith('A') ? 'B' : 'A'}`],
    ['no signature', `${expires}.${nonce}.`],
    ['made up', '99999999999999.abc.def'],
    ['the password itself', DEMO_PASSWORD],
    ['empty', ''],
  ] as const) {
    assert.equal(await opens(`${name}=${forged}`), false, what);
  }
  assert.equal(await opens(`gc_demo_other=${value}`), false, 'under another name');

  // It lasts twelve hours and not a moment longer.
  h.clock.advance(GATE_TTL_MS - 1000);
  assert.equal(await opens(cookie), true);
  h.clock.advance(1000);
  assert.equal(await opens(cookie), false);
  await h.close();

  // A cookie from before the password was changed, or from a server with another key, is worthless.
  h = await harness({ demoAccessPassword: 'a-different-demo-phrase-9', serverSecret: SERVER_SECRET });
  assert.equal(await opens(cookie), false, 'the password changed');
  await h.close();
  h = await harness({ demoAccessPassword: DEMO_PASSWORD, serverSecret: `${SERVER_SECRET}x` });
  assert.equal(await opens(pairOf(await submit(DEMO_PASSWORD))), true);
  assert.equal(await opens(cookie), false, 'the server key changed');
  await h.close();

  // Over https it is Secure and bound to this exact host.
  h = await harness({ demoAccessPassword: DEMO_PASSWORD, appUrl: 'https://demo.globalconnect.example', opsUrl: 'https://demo.globalconnect.example' });
  const secure = await submit(DEMO_PASSWORD);
  assert.match(cookieOf(secure), /^__Host-gc_demo=[^;]+; Path=\/; HttpOnly; SameSite=Lax; Max-Age=43200; Secure$/);
  assert.equal(await opens(pairOf(secure)), true);
  assert.equal(await opens(pairOf(secure).replace('__Host-gc_demo', 'gc_demo')), false);
  // And every response tells the browser to use https from now on.
  assert.equal((await get('/healthz')).headers['strict-transport-security'], 'max-age=31536000');
});

test('demo gate: guesses are rate limited per source, and the limit does not care whether the guess was right', async () => {
  h = await harness({ demoAccessPassword: DEMO_PASSWORD, trustProxy: 1 });
  const from = (address: string) => ({ 'x-forwarded-for': address });
  for (let attempt = 0; attempt < GATE_ATTEMPTS_PER_MINUTE; attempt += 1) assert.equal((await submit(`guess number ${attempt}`, { headers: from('198.51.100.7') })).statusCode, 401);
  const limited = await submit(DEMO_PASSWORD, { headers: from('198.51.100.7') });
  assert.deepEqual([limited.statusCode, limited.headers['set-cookie']], [429, undefined]);
  assert.match(limited.body, /Too many attempts/);
  assert.ok(Number(limited.headers['retry-after']) > 0);
  // Someone else is not affected, and a whole IPv6 /64 counts as one source.
  assert.equal((await submit(DEMO_PASSWORD, { headers: from('198.51.100.8') })).statusCode, 303);
  for (let attempt = 0; attempt < GATE_ATTEMPTS_PER_MINUTE; attempt += 1) await submit('wrong', { headers: from(`2001:db8:1:2::${attempt + 1}`) });
  assert.equal((await submit(DEMO_PASSWORD, { headers: from('2001:db8:1:2::ffff') })).statusCode, 429);
  // A minute later the first source may try again.
  h.clock.advance(60_000);
  assert.equal((await submit(DEMO_PASSWORD, { headers: from('198.51.100.7') })).statusCode, 303);
});

test('demo gate: behind it the client API works unchanged: activation, sign-in with a bearer token, step-up and a payment', async () => {
  h = await harness({ demoAccessPassword: DEMO_PASSWORD });
  await assert.rejects(h.activate(AMIRA), /activation password failed: 401/, 'without the gate cookie not even activation is reachable');
  throughGate(pairOf(await submit(DEMO_PASSWORD)));
  const amira = await h.activate(AMIRA);
  const signedIn = await h.login(AMIRA, amira.secret);
  assert.equal(signedIn.status, 200);
  const token = signedIn.json.token as string;
  assert.equal((await h.call('GET', '/v1/balances', { token })).status, 200);
  // The gate cookie is not a session: without the bearer token the API still says no.
  assert.deepEqual((await h.call('GET', '/v1/balances')).json, { error: { kind: 'unauthorized' } });
  await h.policy('co_northfield', 0);
  const body = { beneficiaryId: 'sample-beneficiary-harbour', amount: '125.00', currency: 'GBP', reference: 'INV-1', reason: 'Invoice' };
  assert.equal((await h.call('POST', '/v1/payments', { token, body, headers: { 'idempotency-key': 'key-gate-000001' } })).json.error.reason, 'step_up_required');
  const stepUp = await h.stepUp(token, amira.secret, 'payment.create', { ...body, idempotencyKey: 'key-gate-000001' });
  assert.equal((await h.call('POST', '/v1/payments', { token, body, headers: { 'idempotency-key': 'key-gate-000001', 'x-step-up-token': stepUp } })).status, 200);
  assert.equal((await h.call('POST', '/v1/auth/logout', { token })).status, 200);
});

// --- Where development mode may run ----------------------------------------------------------------------

const SECRETS = { DEMO_ACCESS_PASSWORD: DEMO_PASSWORD, SERVER_SECRET, ADMIN_TOKEN, DATA_ENCRYPTION_KEY: TEST_DATA_KEY, DATABASE_PATH: '/data/globalconnect.sqlite' };

test('start-up: development mode on Fly.io or any public address needs the demo password, real secrets and https; locally and in a Codespace nothing changes', () => {
  const dev = { APP_ENV: 'development' };
  // This machine and a Codespace: as before, no gate needed.
  for (const env of [{}, { APP_URL: 'http://localhost:3001' }, { APP_URL: 'http://127.0.0.1:3001', WEB_DIR: '/web' }, { APP_URL: 'https://fuzzy-space-waffle-3001.app.github.dev', WEB_DIR: '/web', CODESPACE_NAME: 'fuzzy-space-waffle' }]) {
    const config = loadConfig({ ...dev, ...env });
    assert.deepEqual([config.publicDemo, config.demoAccessPassword], [false, null], JSON.stringify(env));
  }

  // On Fly.io (FLY_APP_NAME is set by the platform) and on any other public address: refused without each of them.
  for (const where of [{ FLY_APP_NAME: 'gc-demo' }, { APP_URL: 'https://demo.globalconnect.example', WEB_DIR: '/web' }, { OPS_URL: 'https://ops.globalconnect.example' }, { APP_URL: 'https://fuzzy-space-waffle-3001.app.github.dev', WEB_DIR: '/web' }, { APP_URL: 'https://evil-3001.app.github.dev.example.com', WEB_DIR: '/web', CODESPACE_NAME: 'evil' }]) {
    assert.throws(() => loadConfig({ ...dev, ...where }), /Refusing to start in development mode on a public address[^]*DEMO_ACCESS_PASSWORD[^]*SERVER_SECRET; ADMIN_TOKEN; DATA_ENCRYPTION_KEY; DATABASE_PATH/, JSON.stringify(where));
    for (const name of Object.keys(SECRETS) as (keyof typeof SECRETS)[]) {
      assert.throws(() => loadConfig({ ...dev, ...where, ...SECRETS, [name]: undefined }), new RegExp(`Refusing to start in development mode on a public address[^]*${name}`), `${JSON.stringify(where)} without ${name}`);
    }
  }
  const fly = loadConfig({ ...dev, FLY_APP_NAME: 'gc-demo', WEB_DIR: '/app/dist-demo', ...SECRETS });
  assert.deepEqual([fly.publicDemo, fly.appUrl, fly.opsUrl, fly.demoAccessPassword, fly.demoSetupCodes], [true, 'https://gc-demo.fly.dev', 'https://gc-demo.fly.dev', DEMO_PASSWORD, false]);
  assert.equal(loadConfig({ ...dev, FLY_APP_NAME: 'gc-demo', ...SECRETS, DEMO_SETUP_CODES: '1' }).demoSetupCodes, true);
  // A custom domain replaces the fly.dev address.
  assert.equal(loadConfig({ ...dev, FLY_APP_NAME: 'gc-demo', APP_URL: 'https://demo.globalconnect.example', WEB_DIR: '/web', ...SECRETS }).opsUrl, 'https://demo.globalconnect.example');
  // Never over plain http.
  assert.throws(() => loadConfig({ ...dev, APP_URL: 'http://demo.globalconnect.example', WEB_DIR: '/web', ...SECRETS }), /must be served over https/);

  // The password must be worth the name; the other secrets are held to the rules they always were.
  for (const weak of ['short', 'k7Qz-pl4Wx9', 'password12345', 'aaaaaaaaaaaaaaaa', 'changeme-please-now', 'demo-demo-demo-demo', 'replace-with-a-password', 'abababababababab']) {
    assert.ok(demoPasswordProblem(weak), weak);
    assert.throws(() => loadConfig({ ...dev, FLY_APP_NAME: 'gc-demo', ...SECRETS, DEMO_ACCESS_PASSWORD: weak }), /DEMO_ACCESS_PASSWORD is refused/, weak);
    assert.throws(() => loadConfig({ ...dev, DEMO_ACCESS_PASSWORD: weak }), /DEMO_ACCESS_PASSWORD is refused/, `${weak}, locally`);
  }
  assert.equal(demoPasswordProblem(DEMO_PASSWORD), null);
  assert.throws(() => loadConfig({ ...dev, FLY_APP_NAME: 'gc-demo', ...SECRETS, SERVER_SECRET: 'replace-with-a-long-random-value' }), /SERVER_SECRET is refused/);
  assert.throws(() => loadConfig({ ...dev, FLY_APP_NAME: 'gc-demo', ...SECRETS, DATA_ENCRYPTION_KEY: 'short' }), /DATA_ENCRYPTION_KEY is refused/);

  // None of this loosens strict mode: without APP_ENV=development it still refuses mock credentials, on Fly as anywhere.
  assert.throws(() => loadConfig({ FLY_APP_NAME: 'gc-demo', ...SECRETS }), /Provider credentials are missing/);
  // The gate can be switched on locally too (to try it); it is simply not required there.
  assert.equal(loadConfig({ ...dev, DEMO_ACCESS_PASSWORD: DEMO_PASSWORD }).demoAccessPassword, DEMO_PASSWORD);
});

/** Starts the real server process and returns what it printed in its first seconds (or until it exited). */
function start(env: Record<string, string>): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], { cwd: serverDir, env: { PATH: process.env.PATH ?? '', LOG: '0', ...env } });
    let output = '';
    const done = (code: number | null) => resolve({ code, output });
    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString();
      if (/Ops console: /.test(output)) setTimeout(() => child.kill('SIGTERM'), 200);
    });
    child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString()));
    child.on('exit', done);
    setTimeout(() => child.kill('SIGKILL'), 20_000).unref();
  });
}

test('start-up, for real: on Fly the server refuses to start without the gate, prints no activation codes unless asked, and keeps no key file beside the database', { timeout: 90_000 }, async () => {
  const folder = mkdtempSync(path.join(tmpdir(), 'gc-fly-'));
  const port = 20_000 + Math.floor(Math.random() * 20_000);
  const base = { APP_ENV: 'development', FLY_APP_NAME: 'gc-demo', PORT: String(port), ADMIN_PORT: String(port + 1), HOST: '127.0.0.1' };
  try {
    const refused = await start(base);
    assert.equal(refused.code, 1);
    assert.match(refused.output, /Refusing to start in development mode on a public address \(Fly\.io app gc-demo\)/);

    const secrets = { ...SECRETS, DATABASE_PATH: path.join(folder, 'globalconnect.sqlite') };
    const quiet = await start({ ...base, ...secrets });
    assert.match(quiet.output, /THE DEMO GATE IS ON/);
    assert.match(quiet.output, /Activation codes for the sample accounts are NOT printed/);
    assert.doesNotMatch(quiet.output, /[A-Z2-7]{5}-[A-Z2-7]{5}-[A-Z2-7]{5}-[A-Z2-7]{5}|#code=/, 'an activation code reached the log');
    assert.doesNotMatch(quiet.output, new RegExp([DEMO_PASSWORD, SERVER_SECRET, ADMIN_TOKEN, TEST_DATA_KEY].map((secret) => secret.replace(/[+/=]/g, '\\$&')).join('|')), 'a secret reached the log');

    // First-time set-up, asked for explicitly: the codes are printed, with links at the public https address.
    const setup = await start({ ...base, ...secrets, DEMO_SETUP_CODES: '1' });
    assert.match(setup.output, /ops\.admin@globalconnect\.example\s+[A-Z2-7-]{23}\s+https:\/\/gc-demo\.fly\.dev\/ops\/activate#code=/);
    assert.match(setup.output, /amira@northfield\.example\s+[A-Z2-7-]{23}\s+https:\/\/gc-demo\.fly\.dev\/activate#code=/);
    // The encryption key came from the environment: nothing was written beside the database.
    const { readdirSync } = await import('node:fs');
    assert.deepEqual(readdirSync(folder).filter((name) => /key/i.test(name)), []);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});
