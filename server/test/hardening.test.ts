/** Regression tests for the security review findings (H3, H4 config, M1-M9, L1-L3, L6). Each was confirmed to fail with its fix reverted. */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { adminTokenProblem, loadConfig } from '../src/config';
import { hashPassword, PASSWORD_COST, setPasswordCost, sha256, verifyPassword } from '../src/crypto';
import { requestLogEntry } from '../src/http/app';
import { wireAmount } from '../src/providers/equals/adapter';
import { createRuntime } from '../src/startup';
import type { AuditEntry } from '../src/store/types';
import { createSqliteStores } from '../src/store/sqlite';
import { dataKeys } from '../src/store/sqlite/keys';
import { ADMIN_TOKEN, AMIRA, BEN, DANA, harness, PASSWORD, TEST_DATA_KEY, TEST_PASSWORD_COST, type Harness } from './helpers';

let h: Harness;
afterEach(async () => h?.close());

const serverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LIVE = { CURRENCYCLOUD_LOGIN_ID: 'a', CURRENCYCLOUD_API_KEY: 'b', EQUALS_API_KEY: 'c', OPS_URL: 'https://ops.globalconnect.example', SERVER_SECRET: 'Zq7Lm2Xv9Rt4Wp8Kd3Nf6Hs1Bg5Yc0JaUeOiTxMn', STAFF_EMAIL_DOMAINS: 'globalconnect.example', DATABASE_PATH: '/var/lib/globalconnect/data.sqlite', DATA_ENCRYPTION_KEY: 'q0v8Jm3ZxN5rT1yLw7KdP2sHf9BcVe4UaGiXoR6MtYE=' };
const from = (address: string) => ({ 'x-forwarded-for': address });
const login = (email: string, password: string, address?: string) => h.call('POST', '/v1/auth/login', { body: { email, password }, headers: address ? from(address) : {} });
async function signedIn(email: string) {
  const account = await h.activate(email);
  const reply = await h.login(email, account.secret);
  assert.equal(reply.status, 200);
  return { ...account, token: reply.json.token as string };
}

// --- H3 ---------------------------------------------------------------------------------------

test('H3: strict by default. Only APP_ENV=development is lenient; NODE_ENV decides nothing', () => {
  assert.throws(() => loadConfig({}), /Provider credentials are missing/);
  for (const NODE_ENV of [undefined, 'development', 'test', 'staging', 'production']) {
    const config = loadConfig({ ...LIVE, NODE_ENV });
    assert.deepEqual([config.development, config.strict, config.fourEyes, config.databasePath], [false, true, true, LIVE.DATABASE_PATH], String(NODE_ENV));
    // Everything that is a development convenience is refused.
    assert.throws(() => loadConfig({ ...LIVE, NODE_ENV, DATA_FILE: '/tmp/accounts.json' }), /DATA_FILE \(the JSON demo file\) is no longer used/);
    // The database file and the key that encrypts authenticator keys are required, and the key must be a real one.
    assert.throws(() => loadConfig({ ...LIVE, NODE_ENV, DATABASE_PATH: undefined }), /DATABASE_PATH must be set/);
    assert.throws(() => loadConfig({ ...LIVE, NODE_ENV, DATA_ENCRYPTION_KEY: undefined }), /DATA_ENCRYPTION_KEY must be set/);
    for (const key of ['short', 'A'.repeat(43) + '=', Buffer.alloc(16, 7).toString('base64'), 'replace-with-openssl-rand-base64-32']) assert.throws(() => loadConfig({ ...LIVE, NODE_ENV, DATA_ENCRYPTION_KEY: key }), /DATA_ENCRYPTION_KEY is refused/, key);
    assert.throws(() => loadConfig({ ...LIVE, NODE_ENV, FOUR_EYES: 'off' }), /FOUR_EYES=off is refused/);
    assert.throws(() => loadConfig({ NODE_ENV, OPS_URL: LIVE.OPS_URL }), /Provider credentials are missing/);
  }
  assert.throws(() => loadConfig({ ...LIVE, OPS_URL: 'http://ops.globalconnect.example' }), /OPS_URL must be set to the https/);
  assert.throws(() => loadConfig({ ...LIVE, OPS_URL: undefined }), /OPS_URL must be set to the https/);
  assert.throws(() => loadConfig({ APP_ENV: 'development', NODE_ENV: 'production' }), /cannot be combined/);
  assert.throws(() => loadConfig({ ...LIVE, APP_ENV: 'dev' }), /APP_ENV must be/);

  const development = loadConfig({ APP_ENV: 'development', DATABASE_PATH: '/tmp/demo.sqlite', FOUR_EYES: 'off' });
  assert.deepEqual([development.development, development.fourEyes, development.databasePath, development.opsUrl], [true, false, '/tmp/demo.sqlite', 'http://localhost:3001']);
  assert.ok(development.providers.currencycloud && development.providers.equals);
});

test('H3: a placeholder, short or low-entropy ADMIN_TOKEN is refused in every mode', () => {
  const example = readFileSync(path.join(serverDir, '.env.example'), 'utf8');
  const sample = /ADMIN_TOKEN=(\S+)/.exec(example)?.[1] ?? 'replace-with-a-long-random-value';
  for (const token of [sample, 'replace-with-a-long-random-value', 'changeme', 'short-but-random-9fK2', 'a'.repeat(64), 'abcabcabcabcabcabcabcabcabcabcabcabcabcabc', 'my-admin-token-for-global-connect-2026']) {
    assert.ok(adminTokenProblem(token), token);
    assert.throws(() => loadConfig({ APP_ENV: 'development', ADMIN_TOKEN: token }), /ADMIN_TOKEN is refused/, token);
    assert.throws(() => loadConfig({ ...LIVE, ADMIN_TOKEN: token }), /ADMIN_TOKEN is refused/, token);
  }
  // The copy-and-use example file does not hand out a usable token.
  assert.doesNotMatch(example, /^ADMIN_TOKEN=/m);
  assert.equal(loadConfig({ APP_ENV: 'development', ADMIN_TOKEN }).adminToken, ADMIN_TOKEN);
  assert.equal(loadConfig({ APP_ENV: 'development' }).adminToken, null);
});

test('H3/H4/H1: outside development the server refuses to start without a mailer and on mock providers', () => {
  const strict = loadConfig(LIVE);
  assert.throws(() => createRuntime(strict), /No mailer is configured/);
  const mailer = { send: async () => {} };
  assert.throws(() => createRuntime(strict, { mailer }), /Refusing to start: currencycloud and equals would be served by an in-memory MOCK/);
  const wire = { request: async () => ({ status: 500, body: '' }) };
  assert.throws(() => createRuntime(strict, { mailer, transports: { currencycloud: wire } }), /Refusing to start: equals would be served/);
  // With live wires and a mailer it starts, and with no sample people or companies.
  const runtime = createRuntime(strict, { mailer, transports: { currencycloud: wire, equals: wire } });
  assert.deepEqual(runtime.registry.mocked(), []);
  return runtime.stores.directory.listUsers().then((users) => assert.deepEqual(users, []));
});

test('H3: the real process. Strict start exits without printing a code; in development /admin is on a loopback-only listener', async () => {
  const run = (env: Record<string, string>) => spawnSync(process.execPath, ['--import', 'tsx', 'src/index.ts'], { cwd: serverDir, env: { PATH: process.env.PATH ?? '', ...env }, encoding: 'utf8', timeout: 60_000 });
  for (const [env, message] of [[{}, /Provider credentials are missing/], [LIVE, /No mailer is configured/], [{ ...LIVE, NODE_ENV: 'development' }, /No mailer is configured/]] as const) {
    const result = run(env);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, message);
    assert.doesNotMatch(result.stdout + result.stderr, /[A-Z2-7]{5}-[A-Z2-7]{5}-[A-Z2-7]{5}|code=/);
  }

  const child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], { cwd: serverDir, env: { PATH: process.env.PATH ?? '', APP_ENV: 'development', PORT: '39411', ADMIN_PORT: '39412', ADMIN_TOKEN, LOG: '0' } });
  let output = '';
  child.stdout.on('data', (chunk) => (output += String(chunk)));
  child.stderr.on('data', (chunk) => (output += String(chunk)));
  try {
    for (let waited = 0; !output.includes('Ops console:') && waited < 300; waited += 1) await new Promise((resolve) => setTimeout(resolve, 100));
    assert.match(output, /DEVELOPMENT MODE \(APP_ENV=development\)/);
    // The demo seed: three clients and three staff (two ops admins and an ops user), so admin-approved staff management can be shown.
    assert.equal((output.match(/\/activate#code=/g) ?? []).length, 6);
    assert.match(output, /ops\.admin@globalconnect\.example .*\(staff: ops_admin\)/);
    assert.match(output, /ops\.admin2@globalconnect\.example .*\(staff: ops_admin\)/);
    assert.match(output, /ops\.second@globalconnect\.example .*\(staff: ops\)/);
    const post = (base: string) => fetch(`${base}/admin/invites`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${ADMIN_TOKEN}` }, body: JSON.stringify({ email: AMIRA }) });
    assert.equal((await post('http://127.0.0.1:39411')).status, 404, 'the public listener has no /admin');
    const sent = await post('http://127.0.0.1:39412');
    assert.equal(sent.status, 200);
    assert.deepEqual(Object.keys((await sent.json()) as object).sort(), ['expiresAt', 'sentTo']);
    assert.match(output, /DEVELOPMENT OUTBOX: this email was NOT sent anywhere/);
    // The operator port does not answer on any non-loopback address of this machine; the public port does.
    const outside = Object.values(networkInterfaces()).flat().find((item) => item && !item.internal && item.family === 'IPv4')?.address;
    if (outside) {
      await assert.rejects(post(`http://${outside}:39412`));
      assert.equal((await fetch(`http://${outside}:39411/healthz`)).status, 200);
    }
  } finally {
    child.kill();
  }
});

// --- M1 ---------------------------------------------------------------------------------------

test('M1: an invitation replaced or withdrawn while the password was being hashed is not brought back', async () => {
  h = await harness();
  const old = await h.invite(AMIRA);
  // The old code's password step starts (and is busy hashing) when ops re-issues the link.
  const racing = h.auth.activationPassword(old, PASSWORD);
  const fresh = await h.invite(AMIRA);
  await assert.rejects(racing, 'the old link must not complete its step');
  // The old code is dead and the new one is intact.
  assert.equal((await h.call('POST', '/v1/activation/start', { body: { activationCode: old } })).status, 400);
  assert.equal(await h.stores.auth.activations.count(() => true), 1);
  assert.equal((await h.call('POST', '/v1/activation/start', { body: { activationCode: fresh } })).status, 200);
  const enrol = await h.call('POST', '/v1/activation/password', { body: { activationCode: fresh, password: PASSWORD } });
  assert.equal((await h.call('POST', '/v1/activation/confirm', { body: { activationCode: fresh, code: h.code(enrol.json.secret) } })).status, 200);

  // Withdrawn (the person was disabled) during the hash: also not brought back.
  const bens = await h.invite(BEN);
  const second = h.auth.activationPassword(bens, PASSWORD);
  await h.stores.auth.activations.deleteWhere((record) => record.userId === 'usr_ben');
  await assert.rejects(second);
  assert.equal(await h.stores.auth.activations.count((record) => record.userId === 'usr_ben'), 0);

  // The same for staff invitations.
  const user = await h.opsAuth.createUser('s@globalconnect.example', 'S', 'ops');
  const first = await h.opsAuth.createInvite(user.id);
  const staffRace = h.opsAuth.activationPassword(first.activationCode, 'staff horse battery staple');
  const next = await h.opsAuth.createInvite(user.id);
  await assert.rejects(staffRace);
  await assert.rejects(h.opsAuth.activationStart(first.activationCode));
  assert.equal((await h.opsAuth.activationStart(next.activationCode)).email, 's@globalconnect.example');
});

// --- M2 and the other read-modify-write races -----------------------------------------------------

test('M2: forty simultaneous wrong passwords get five checks, not forty; the same for codes', async () => {
  h = await harness();
  const { secret } = await h.activate(AMIRA);
  const replies = await Promise.all(Array.from({ length: 40 }, () => login(AMIRA, 'wrong password here')));
  assert.equal(replies.filter((reply) => reply.status === 400).length, 5);
  assert.equal(replies.filter((reply) => reply.status === 429 && reply.json.error.reason === 'locked').length, 35);
  assert.equal((await login(AMIRA, PASSWORD)).status, 429);

  // Codes: forty simultaneous wrong codes on one challenge.
  await h.stores.auth.attempts.deleteWhere(() => true);
  const challenge = (await login(AMIRA, PASSWORD)).json.challengeId;
  const codes = await Promise.all(Array.from({ length: 40 }, (_, index) => h.call('POST', '/v1/auth/login/verify', { body: { challengeId: challenge, code: String(100000 + index), method: 'totp' } })));
  assert.equal(codes.filter((reply) => reply.json.error.reason === 'invalid_code').length, 5);
  assert.equal(codes.filter((reply) => reply.status === 200).length, 0);
  // Staff sign-in is counted the same way.
  const user = await h.opsAuth.createUser('s@globalconnect.example', 'S', 'ops');
  void user;
  const staff = await Promise.allSettled(Array.from({ length: 40 }, () => h.opsAuth.login('s@globalconnect.example', 'wrong password here', '127.0.0.1')));
  const reasons = staff.map((result) => (result.status === 'rejected' ? (result.reason as { options: { reason: string } }).options.reason : 'ok'));
  assert.equal(reasons.filter((reason) => reason === 'invalid_credentials').length, 5);
  assert.equal(reasons.filter((reason) => reason === 'locked').length, 35);
  void secret;
});

test('L5: a code, a step-up permission and a sign-in challenge are each spent exactly once however many requests arrive together', async () => {
  // With store latency, so that the two requests of each pair really do interleave.
  h = await harness({}, undefined, { storeLatency: true });
  const amira = await signedIn(AMIRA);
  const pending = (await h.call('GET', '/v1/approvals', { token: amira.token })).json.items[0].payment.id as string;

  // Two step-up requests with the same fresh code: one permission.
  const code = h.freshCode(amira.secret);
  const grants = await Promise.all([1, 2].map(() => h.call('POST', '/v1/step-up', { token: amira.token, body: { action: 'payment.approve', payload: { paymentId: pending }, code } })));
  assert.deepEqual(grants.map((reply) => reply.status).sort(), [200, 400]);
  assert.equal(grants.find((reply) => reply.status === 400)?.json.error.reason, 'code_reused');

  // Two approvals carrying the same permission: one is carried out.
  const stepUp = grants.find((reply) => reply.status === 200)?.json.token as string;
  const approvals = await Promise.all([1, 2].map(() => h.call('POST', `/v1/payments/${pending}/approve`, { token: amira.token, headers: { 'x-step-up-token': stepUp } })));
  assert.deepEqual(approvals.map((reply) => reply.status).sort(), [200, 403]);
  assert.equal(approvals.find((reply) => reply.status === 403)?.json.error.reason, 'step_up_invalid');

  // Two sign-in completions with the same challenge and code: one session.
  const challenge = (await login(AMIRA, PASSWORD)).json.challengeId;
  const fresh = h.freshCode(amira.secret);
  const sessions = await Promise.all([1, 2].map(() => h.call('POST', '/v1/auth/login/verify', { body: { challengeId: challenge, code: fresh, method: 'totp' } })));
  assert.deepEqual(sessions.map((reply) => reply.status).sort(), [200, 400]);
  // Two with the same recovery code: one session.
  const again = (await login(AMIRA, PASSWORD)).json.challengeId;
  const recovery = await Promise.all([1, 2].map(() => h.call('POST', '/v1/auth/login/verify', { body: { challengeId: again, code: amira.recoveryCodes[0], method: 'recovery' } })));
  assert.deepEqual(recovery.map((reply) => reply.status).sort(), [200, 400]);

  // A session revoked while a request is in flight is not written back by that request.
  const inFlight = h.auth.authenticate(amira.token).catch(() => null);
  await h.auth.logout(amira.token);
  await inFlight;
  assert.equal((await h.call('GET', '/v1/balances', { token: amira.token })).status, 401);
});

// --- M3 ---------------------------------------------------------------------------------------

test('M3: behind one trusted proxy the address is the one the proxy saw, not the one the client typed (real rate limit)', async () => {
  const { authRequestsPerMinute } = loadConfig({ APP_ENV: 'development' });
  assert.equal(authRequestsPerMinute, 30);
  h = await harness({ trustProxy: 1, authRequestsPerMinute });
  // The client forges a new leftmost address on every request; the proxy appends the real one.
  const statuses: number[] = [];
  for (let index = 0; index < 32; index += 1) statuses.push((await login(`nobody${index}@nowhere.example`, PASSWORD, `10.9.${index}.1, 203.0.113.9`)).status);
  assert.deepEqual(statuses.slice(0, 30), Array(30).fill(400));
  assert.deepEqual(statuses.slice(30), [429, 429]);
  // Someone else behind the same proxy is not affected, and the audit log holds the real address.
  assert.equal((await login('nobody@nowhere.example', PASSWORD, '10.9.0.1, 198.51.100.7')).status, 400);
  const sources = new Set((await h.stores.audit.query({ action: 'client.sign_in', limit: 1000 })).map((entry) => entry.source));
  assert.deepEqual([...sources].sort(), ['198.51.100.7', '203.0.113.9']);

  // Configuration: a hop count or the proxies' own addresses; never "trust everything".
  assert.equal(loadConfig({ APP_ENV: 'development' }).trustProxy, false);
  assert.equal(loadConfig({ APP_ENV: 'development', TRUST_PROXY: '0' }).trustProxy, false);
  assert.equal(loadConfig({ APP_ENV: 'development', TRUST_PROXY: '1' }).trustProxy, 1);
  assert.deepEqual(loadConfig({ APP_ENV: 'development', TRUST_PROXY: '10.0.0.0/8, 192.168.1.1' }).trustProxy, ['10.0.0.0/8', '192.168.1.1']);
  for (const value of ['true', 'yes', '*', '10.0.0.0/99', 'proxy.internal']) assert.throws(() => loadConfig({ APP_ENV: 'development', TRUST_PROXY: value }), /TRUST_PROXY must be/, value);
});

test('M3: without a trusted proxy a forwarded header is ignored, and a full limiter never resets anyone (real rate limit)', async () => {
  h = await harness({ authRequestsPerMinute: 30 }, undefined, { maxRateWindows: 1 });
  for (let index = 0; index < 30; index += 1) assert.equal((await login('nobody@nowhere.example', PASSWORD, `10.9.${index}.1`)).status, index < 5 ? 400 : 429);
  // The 31st from the same real address is rate limited whatever it claims.
  const limited = await login('other@nowhere.example', PASSWORD, '10.200.0.1');
  assert.equal(limited.status, 429);
  assert.equal(limited.json.error.reason, undefined);

  await h.close();
  h = await harness({ trustProxy: 1, authRequestsPerMinute: 30 }, undefined, { maxRateWindows: 2 });
  for (let index = 0; index < 30; index += 1) await login(`n${index}@nowhere.example`, PASSWORD, '203.0.113.9');
  // Two more addresses arrive while the first is at its limit. The limiter is full: the newcomer waits, nobody is reset.
  assert.equal((await login('a@nowhere.example', PASSWORD, '203.0.113.10')).status, 400);
  assert.equal((await login('b@nowhere.example', PASSWORD, '203.0.113.11')).status, 429);
  assert.equal((await login('c@nowhere.example', PASSWORD, '203.0.113.9')).status, 429, 'the address at its limit is still limited');
  // A minute later the windows have run out and everyone is served again.
  h.clock.advance(60_001);
  assert.equal((await login('b@nowhere.example', PASSWORD, '203.0.113.11')).status, 400);
});

// --- M4 ---------------------------------------------------------------------------------------

test('M4: activation codes travel after "#", and no query string or code reaches the request log', async () => {
  h = await harness();
  const invite = await h.auth.createInvite(AMIRA);
  assert.equal(invite.activationLink, `http://localhost:8081/activate#code=${invite.activationCode}`);
  assert.doesNotMatch(invite.activationLink, /\?/);

  const { secret } = await h.activate(BEN);
  const session = await h.login(BEN, secret);
  await h.call('GET', '/v1/transactions?page=1&perPage=5&note=FINDME-IN-QUERY', { token: session.json.token });
  await h.app.inject({ method: 'GET', url: `/activate?code=${invite.activationCode}` });
  await h.app.inject({ method: 'GET', url: '/ops/users?q=FINDME-IN-QUERY' });
  await h.app.inject({ method: 'GET', url: `/ops/activate?code=${invite.activationCode}` });
  const log = h.logs.join('');
  assert.ok(h.logs.length > 10);
  assert.match(log, /"url":"\/v1\/transactions"/);
  assert.match(log, /"url":"\/ops\/users"/);
  assert.doesNotMatch(log, /\?|FINDME|perPage/);
  assert.ok(!log.includes(invite.activationCode) && !log.includes(session.json.token) && !log.includes(secret));
  assert.doesNotMatch(log, /authorization|cookie|"headers"/i);
  assert.deepEqual(requestLogEntry({ method: 'GET', url: '/activate?code=ABCDE-FGHIJ', ip: '1.2.3.4' }), { method: 'GET', url: '/activate', remoteAddress: '1.2.3.4' });
});

// --- M5 ---------------------------------------------------------------------------------------

test('M5: anonymous failures cannot push anything out of the audit log, are rate limited per source and truncated', async () => {
  h = await harness({ trustProxy: 1 }, undefined, { audit: { anonymousLimit: 25, anonymousPerMinute: 20 } });
  await h.activate(AMIRA);
  const first = (await h.stores.audit.query({ limit: 10_000 })).map((entry) => entry.id);
  assert.ok(first.length >= 1);

  // 300 failed sign-ins for made-up addresses, with a label of some 250 characters, from 12 sources.
  const long = `${'x'.repeat(230)}@nowhere.example`;
  for (let index = 0; index < 300; index += 1) await login(`${index}${long}`, PASSWORD, `198.51.100.${index % 12}`);
  const entries = await h.stores.audit.query({ limit: 100_000 });
  const anonymous = entries.filter((entry) => entry.anonymous);
  // Every earlier entry is still there; the noise is bounded and marked.
  for (const id of first) assert.ok(entries.some((entry) => entry.id === id));
  assert.equal(anonymous.length, 25);
  assert.ok(anonymous.every((entry) => entry.actor.label.length <= 80 && entry.actor.id === null && entry.outcome === 'failure'));
  assert.equal(entries.length, first.length + 25);
  // One source alone is held to its rate: 300 more from a single address add at most 20 in that minute.
  const log = h.stores.audit;
  const before = log.suppressed;
  for (let index = 0; index < 100; index += 1) await login(`again${index}@nowhere.example`, PASSWORD, '198.51.100.200');
  assert.equal(log.suppressed - before, 80);
});

test('N1: a full live audit table is archived, never dropped: nothing is refused, nothing is lost, and the chain still verifies', async () => {
  const notices: string[] = [];
  const entry = (n: number) => ({ at: n, actor: { type: 'system' as const, id: null, label: 's' }, target: null, action: `e${n}`, outcome: 'success' as const, source: '', detail: {} });
  const stores = createSqliteStores({ path: ':memory:', keys: dataKeys(TEST_DATA_KEY), audit: { liveLimit: 4, notice: (message) => void notices.push(message) } });
  for (const n of [1, 2, 3, 4, 5]) await stores.audit.append(entry(n));
  // The older entries moved to the archive table, whole and in order; the newest are in the live table.
  assert.deepEqual(stores.db.all<{ action: string }>('SELECT action FROM audit_archive ORDER BY seq').map((row) => row.action), ['e1', 'e2', 'e3']);
  assert.deepEqual((await stores.audit.query()).map((item) => item.action), ['e5', 'e4']);
  assert.equal(notices.length, 1);
  assert.match(notices[0] ?? '', /3 older entries were moved to the archive table.*Nothing was removed/);
  for (const n of [6, 7, 8, 9]) await stores.audit.append(entry(n));
  // Every entry ever written is in one table or the other, exactly once, and the chain runs through both.
  assert.deepEqual(stores.db.all<{ action: string }>('SELECT action FROM audit_archive UNION ALL SELECT action FROM audit_log').map((row) => row.action).sort(), [1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => `e${n}`));
  assert.deepEqual(stores.verifyAudit(), { ok: true, entries: 9, archived: stores.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM audit_archive')?.n, problem: null });
  stores.close();

  // Through the server, at capacity: sign-in, sign-out, a payment, staff sign-in and containment all still work.
  h = await harness({}, undefined, { audit: { liveLimit: 5 } });
  const amira = await signedIn(AMIRA);
  for (let index = 0; index < 12; index += 1) assert.equal((await h.call('POST', '/v1/session/company', { token: amira.token, body: { companyId: 'co_castlebrook' } })).status, 404);
  assert.ok(h.warnings.length >= 2 && h.warnings.every((message) => /Audit log: \d+ older entries were moved/.test(message)));
  assert.equal((await h.call('POST', '/v1/session/company', { token: amira.token, body: { companyId: 'co_northfield' } })).status, 200);
  assert.equal((await h.call('POST', '/v1/auth/logout', { token: amira.token })).status, 200);
  assert.equal((await h.login(AMIRA, amira.secret)).status, 200);
  const staff = await h.opsAuth.createUser('s@globalconnect.example', 'S', 'ops_admin');
  void staff;
  assert.equal((await h.app.inject({ method: 'GET', url: '/ops/login' })).statusCode, 200);
  assert.equal((await h.adminCall('/admin/break-glass', { action: 'disable-staff', email: 's@globalconnect.example', reason: 'testing at capacity' })).status, 200);
  // The newest entry is there; nothing was refused with a 500.
  assert.equal((await h.stores.audit.query({ limit: 1 }))[0]?.action, 'ops.break_glass.disable');
});

test('N1: one session cannot write audit entries without limit; choosing the company already chosen writes nothing; sign-out always works', async () => {
  const { writeRequestsPerMinute } = loadConfig({ APP_ENV: 'development' });
  assert.equal(writeRequestsPerMinute, 60);
  h = await harness({ writeRequestsPerMinute });
  const dana = await signedIn(DANA);
  const count = async () => (await h.stores.audit.query({ actor: DANA, limit: 100_000 })).length;
  const select = (companyId: string) => h.call('POST', '/v1/session/company', { token: dana.token, body: { companyId } });
  assert.equal((await select('co_northfield')).status, 200);
  assert.equal((await h.stores.audit.query({ action: 'client.company_select' }))[0]?.target?.id, 'co_northfield');
  const before = await count();
  // The same choice again, as fast as it can be sent: no entries, and soon no service either.
  const statuses: number[] = [];
  for (let index = 0; index < 200; index += 1) statuses.push((await select('co_northfield')).status);
  assert.equal(await count(), before, 'a no-op selection is not audited');
  assert.equal(statuses.filter((status) => status === 200).length, 59);
  assert.equal(statuses.filter((status) => status === 429).length, 141);
  // Real changes (and refused money actions, which are audited) share that allowance: nothing more is written this minute.
  assert.equal((await select('co_castlebrook')).status, 429);
  assert.equal((await h.call('POST', '/v1/payments', { token: dana.token, body: {}, headers: { 'idempotency-key': 'key-flood-000001' } })).status, 429);
  assert.equal(await count(), before);
  // A second session of the same person does not get a fresh allowance.
  const again = await h.login(DANA, dana.secret);
  assert.equal((await h.call('POST', '/v1/session/company', { token: again.json.token, body: { companyId: 'co_castlebrook' } })).status, 429);
  // Reading and signing out are not limited.
  assert.equal((await h.call('GET', '/v1/balances', { token: dana.token })).status, 200);
  assert.equal((await h.call('POST', '/v1/auth/logout', { token: dana.token })).status, 200);
  // A minute later the person can act again. Without a session nothing is written to the main log at all.
  h.clock.advance(60_001);
  const later = await h.login(DANA, dana.secret);
  assert.equal((await h.call('POST', '/v1/session/company', { token: later.json.token, body: { companyId: 'co_castlebrook' } })).status, 200);
  const main = (await h.stores.audit.query({ limit: 100_000 })).filter((item) => !item.anonymous).length;
  for (let index = 0; index < 50; index += 1) await h.call('POST', '/v1/payments', { body: { amount: '1.00' }, headers: { 'idempotency-key': `key-anon-${index.toString().padStart(6, '0')}` } });
  assert.equal((await h.stores.audit.query({ limit: 100_000 })).filter((item) => !item.anonymous).length, main);
});

test('M5: company selection and every money action are in the audit log, with amount, currency, payee and a hash of the key', async () => {
  h = await harness();
  // No approval rule here: the payment goes straight to the provider and the pending one is the provider's own sample.
  await h.policy('co_northfield', 0);
  const amira = await signedIn(AMIRA);
  const key = 'key-audit-000001';
  const body = { beneficiaryId: 'sample-beneficiary-harbour', amount: '125.00', currency: 'GBP', reference: 'INV-1', reason: 'Invoice' };
  const pay = async (sent: typeof body, idempotencyKey: string) =>
    h.call('POST', '/v1/payments', { token: amira.token, body: sent, headers: { 'idempotency-key': idempotencyKey, 'x-step-up-token': await h.stepUp(amira.token, amira.secret, 'payment.create', { ...sent, idempotencyKey }) } });
  const paid = await pay(body, key);
  assert.equal(paid.status, 200);
  assert.equal((await pay({ ...body, beneficiaryId: 'not-mine' }, 'key-audit-000002')).status, 400);
  assert.equal((await h.call('POST', '/v1/payments', { token: amira.token, body, headers: { 'idempotency-key': 'key-audit-000003' } })).status, 403);
  const pending = (await h.call('GET', '/v1/approvals', { token: amira.token })).json.items[0].payment.id as string;
  for (const action of ['approve', 'reject'] as const) {
    await h.call('POST', `/v1/payments/${pending}/${action}`, { token: amira.token, headers: { 'x-step-up-token': await h.stepUp(amira.token, amira.secret, `payment.${action}`, { paymentId: pending }) } });
  }
  const payee = { name: 'New Payee Ltd', entityType: 'company', currency: 'GBP', bankCountry: 'GB', accountNumber: '00000000', sortCode: '000000' };
  const created = await h.call('POST', '/v1/beneficiaries', { token: amira.token, body: payee, headers: { 'x-step-up-token': await h.stepUp(amira.token, amira.secret, 'beneficiary.create', payee) } });
  const quote = (await h.call('POST', '/v1/quotes', { token: amira.token, body: { kind: 'spot', sellCurrency: 'GBP', buyCurrency: 'USD', fixedSide: 'sell', amount: '100.00' } })).json;
  const booked = await h.call('POST', '/v1/conversions', { token: amira.token, body: { quoteId: quote.id }, headers: { 'idempotency-key': 'key-audit-000004' } });
  assert.equal(booked.status, 200);
  await h.call('POST', '/v1/session/company', { token: amira.token, body: { companyId: 'co_northfield' } });
  await h.call('POST', '/v1/session/company', { token: amira.token, body: { companyId: 'co_castlebrook' } });

  const entries = await h.stores.audit.query({ actor: AMIRA, limit: 1000 });
  const of = (action: string, outcome: string) => entries.filter((entry) => entry.action === action && entry.outcome === outcome);
  const success = of('client.payment.create', 'success')[0];
  assert.deepEqual(
    [success?.target?.id, success?.detail.amount, success?.detail.currency, success?.detail.payee, success?.detail.key, success?.detail.payment, success?.source],
    ['co_northfield', '125.00', 'GBP', 'sample-beneficiary-harbour', sha256(key).slice(0, 16), paid.json.id, '127.0.0.1'],
  );
  assert.deepEqual(of('client.payment.create', 'failure').map((entry) => [entry.detail.payee, entry.detail.reason]).sort(), [['not-mine', 'validation'], ['sample-beneficiary-harbour', 'step_up_required']]);
  assert.equal(of('client.payment.approve', 'success')[0]?.detail.payment, pending);
  assert.equal(of('client.payment.reject', 'failure')[0]?.detail.payment, pending);
  assert.equal(of('client.beneficiary.create', 'success')[0]?.detail.payee, created.json.id);
  assert.deepEqual([of('client.conversion.book', 'success')[0]?.detail.sell, of('client.conversion.book', 'success')[0]?.detail.conversion], ['100.00 GBP', booked.json.id]);
  // Amira has one company, already selected: choosing it again is not an event. (A real choice is: see the N1 test.)
  assert.equal(of('client.company_select', 'success').length, 0);
  assert.equal(of('client.company_select', 'failure').length, 1);
  // Never the key itself, a token or a code.
  const dump = JSON.stringify(entries);
  for (const secret of [key, 'key-audit-000004', amira.token, amira.secret]) assert.ok(!dump.includes(secret));
});

// --- M6 ---------------------------------------------------------------------------------------

test('M6: the sweep removes counters that are neither locked nor recent, and never a live lock', async () => {
  let now = 1_000_000;
  const stores = createSqliteStores({ path: ':memory:', keys: dataKeys(TEST_DATA_KEY), now: () => now });
  const table = stores.auth.attempts;
  const record = (lockedUntil: number, updatedAt = now) => ({ failures: 5, lockedUntil, locks: 0, subject: 's', updatedAt });
  await table.put('locked', record(now + 4 * 60 * 60_000));
  await table.put('counting', record(0));
  await table.put('ran-out', record(now + 60_000));
  await stores.sweep(1, 1);
  assert.equal(await table.count({}), 3, 'recent counters stay');
  now += 3 * 60 * 60_000;
  await stores.sweep(1, 1);
  // The idle counter and the lock that ran out long ago are gone; the lock still running is not.
  assert.deepEqual([await table.get('locked'), await table.get('counting'), await table.get('ran-out')].map((row) => row !== null), [true, false, false]);
  stores.close();

  // Through the server: thousands of other attempts do not unlock a locked account.
  h = await harness();
  await h.activate(AMIRA);
  for (let index = 0; index < 5; index += 1) await login(AMIRA, 'wrong password here');
  for (let index = 0; index < 300; index += 1) await h.stores.auth.attempts.put(`password:email:flood${index}|x`, { failures: 1, lockedUntil: 0, locks: 0, subject: `email:flood${index}`, updatedAt: h.clock.now });
  assert.equal((await login(AMIRA, PASSWORD)).status, 429);
});

// --- M7 ---------------------------------------------------------------------------------------

test('M7: a conversion booked on the second provider is still found by its key after the adapter is rebuilt; the held-quote map is bounded', async () => {
  h = await harness();
  const ben = await signedIn(BEN);
  const quote = (await h.call('POST', '/v1/quotes', { token: ben.token, body: { kind: 'spot', sellCurrency: 'GBP', buyCurrency: 'EUR', fixedSide: 'sell', amount: '250.00' } })).json;
  // The adapter is thrown away between the quote and the booking, and again before the lookup.
  h.registry.invalidate('co_castlebrook');
  const booked = await h.call('POST', '/v1/conversions', { token: ben.token, body: { quoteId: quote.id }, headers: { 'idempotency-key': 'conv-ben-000001' } });
  assert.equal(booked.status, 200);
  h.registry.invalidate('co_castlebrook');
  const found = await h.call('GET', '/v1/conversions/by-key/conv-ben-000001', { token: ben.token });
  assert.equal(found.status, 200);
  assert.equal(found.json?.id, booked.json.id);
  // So a client that reconciles by key does not book again; and a repeat with the same key is the same conversion.
  const balance = (await h.call('GET', '/v1/balances', { token: ben.token })).json.items[0].amount;
  h.registry.invalidate('co_castlebrook');
  const repeat = await h.call('POST', '/v1/conversions', { token: ben.token, body: { quoteId: quote.id }, headers: { 'idempotency-key': 'conv-ben-000001' } });
  assert.equal(repeat.json.id, booked.json.id);
  assert.equal((await h.call('GET', '/v1/balances', { token: ben.token })).json.items[0].amount, balance);
  // The mapping is kept per company: another company asking with the same key finds nothing.
  const amira = await signedIn(AMIRA);
  assert.equal((await h.call('GET', '/v1/conversions/by-key/conv-ben-000001', { token: amira.token })).json, null);
  assert.ok((await h.stores.providerKeys.get('co_castlebrook:key:conv-ben-000001'))?.orderId);

  // The map of quotes this server is holding cannot grow without limit: beyond it the oldest is let go.
  await h.close();
  h = await harness({}, undefined, { maxHeldQuotes: 2 });
  const holder = await signedIn(AMIRA);
  const quotes = [];
  for (const amount of ['10.00', '20.00', '30.00']) quotes.push((await h.call('POST', '/v1/quotes', { token: holder.token, body: { kind: 'spot', sellCurrency: 'GBP', buyCurrency: 'USD', fixedSide: 'sell', amount } })).json);
  const book = (quoteId: string, key: string) => h.call('POST', '/v1/conversions', { token: holder.token, body: { quoteId }, headers: { 'idempotency-key': key } });
  assert.equal((await book(quotes[0].id, 'conv-held-000001')).json.error.kind, 'quote_expired');
  assert.equal((await book(quotes[2].id, 'conv-held-000003')).status, 200);
});

// --- M9 ---------------------------------------------------------------------------------------

test('M9: wrong guesses from one address lock that address, not the owner; a high ceiling still stops a guesser who moves; step-up failures never lock sign-in', async () => {
  // A long first lock, so that no lock in this test runs out while the clock moves on for fresh codes.
  h = await harness({ trustProxy: 1, lockoutBaseMs: 30 * 60_000 });
  const amira = await h.activate(AMIRA);
  // An attacker who knows the email, at one address.
  for (let index = 0; index < 8; index += 1) await login(AMIRA, 'wrong password here', '203.0.113.66');
  assert.equal((await login(AMIRA, PASSWORD, '203.0.113.66')).status, 429);
  // The owner, somewhere else, signs in.
  const challenge = await login(AMIRA, PASSWORD, '198.51.100.7');
  assert.equal(challenge.status, 200);
  const session = await h.call('POST', '/v1/auth/login/verify', { body: { challengeId: challenge.json.challengeId, code: h.freshCode(amira.secret), method: 'totp' }, headers: from('198.51.100.7') });
  assert.equal(session.status, 200);

  // A stolen session spraying wrong step-up codes locks step-up at that address...
  const stepUp = (code: string, address: string) => h.call('POST', '/v1/step-up', { token: session.json.token, body: { action: 'payment.approve', payload: { paymentId: 'p' }, code }, headers: from(address) });
  for (let index = 0; index < 8; index += 1) await stepUp('000000', '203.0.113.77');
  assert.equal((await stepUp(h.freshCode(amira.secret), '203.0.113.77')).status, 429);
  // ...and that does not lock SIGN-IN, even from the very same address (an office behind one address, say).
  const again = await login(AMIRA, PASSWORD, '203.0.113.77');
  assert.equal(again.status, 200);
  assert.equal((await h.call('POST', '/v1/auth/login/verify', { body: { challengeId: again.json.challengeId, code: h.freshCode(amira.secret), method: 'totp' }, headers: from('203.0.113.77') })).status, 200);
  // And the owner can still step up from their own address.
  assert.equal((await stepUp(h.freshCode(amira.secret), '198.51.100.7')).status, 200);

  // A guesser who changes address for every attempt is stopped by the account-wide ceiling (50), for everyone, for a while.
  await h.stores.auth.attempts.deleteWhere(() => true);
  const statuses: number[] = [];
  for (let index = 0; index < 60; index += 1) statuses.push((await login(BEN, 'wrong password here', `192.0.2.${index}`)).status);
  assert.deepEqual([statuses.filter((status) => status === 400).length, statuses.filter((status) => status === 429).length], [50, 10]);
  assert.equal(h.config.lockoutAccountThreshold, 50);
});

// --- L1 ---------------------------------------------------------------------------------------

test('L1: passwords are hashed at N=2^17, an older hash is replaced at the next sign-in, and hashing is bounded', async () => {
  h = await harness();
  const { secret } = await h.activate(AMIRA);
  const weak = (await h.stores.directory.getUser('usr_amira'))?.passwordHash as string;
  assert.match(weak, new RegExp(`^scrypt\\$${TEST_PASSWORD_COST}\\$`));
  assert.equal(PASSWORD_COST, 131072);
  setPasswordCost(PASSWORD_COST);
  try {
    // A wrong password does not rehash; the right one does, and still works afterwards.
    await login(AMIRA, 'wrong password here');
    assert.equal((await h.stores.directory.getUser('usr_amira'))?.passwordHash, weak);
    assert.equal((await h.login(AMIRA, secret)).status, 200);
    const strong = (await h.stores.directory.getUser('usr_amira'))?.passwordHash as string;
    assert.match(strong, /^scrypt\$131072\$8\$1\$/);
    assert.equal(await verifyPassword(PASSWORD, strong), true);
    assert.equal((await h.login(AMIRA, secret)).status, 200);
    assert.equal((await h.stores.directory.getUser('usr_amira'))?.passwordHash, strong, 'not rehashed again');
    // A stored hash asking for an absurd amount of memory is refused, not computed.
    assert.equal(await verifyPassword(PASSWORD, strong.replace('131072', String(2 ** 24))), false);
  } finally {
    setPasswordCost(TEST_PASSWORD_COST);
  }
  // A burst cannot run unbounded hashes side by side: beyond the short queue the request is refused.
  const burst = await Promise.allSettled(Array.from({ length: 100 }, () => hashPassword('correct horse battery')));
  // The client pool: two at a time and thirty-two waiting.
  assert.equal(burst.filter((result) => result.status === 'fulfilled').length, 34);
  assert.ok(burst.filter((result) => result.status === 'rejected').every((result) => (result as PromiseRejectedResult).reason.kind === 'rate_limited'));
});

test('L1: recovery codes carry 100 bits and are stored salted and slow-hashed, not as a plain SHA-256', async () => {
  h = await harness();
  const { recoveryCodes } = await h.activate(AMIRA);
  assert.equal(recoveryCodes.length, 10);
  for (const code of recoveryCodes) assert.match(code, /^[A-Z2-7]{5}(-[A-Z2-7]{5}){3}$/);
  const stored = (await h.stores.directory.getUser('usr_amira'))?.recoveryCodeHashes ?? [];
  assert.equal(stored.length, 10);
  for (const entry of stored) assert.match(entry, /^rc1\$[A-Za-z0-9+/=]{24}\$[A-Za-z0-9+/=]{44}$/);
  const plain = recoveryCodes.map((code) => sha256(code.replace(/-/g, '')));
  assert.ok(!stored.some((entry) => plain.some((hash) => entry.includes(hash))));
  assert.equal(new Set(stored).size, 10);
});

// --- L2 ---------------------------------------------------------------------------------------

test('L2: an amount must be positive and written in the currency\'s own decimal places; nothing is rounded', async () => {
  h = await harness();
  for (const email of [AMIRA, BEN]) {
    const who = await signedIn(email);
    const beneficiaryId = (await h.call('GET', '/v1/beneficiaries', { token: who.token })).json.items.find((row: any) => row.currency === 'GBP').id;
    const before = (await h.call('GET', '/v1/balances', { token: who.token })).json;
    let n = 0;
    for (const amount of ['10.129', '0', '0.00', '-5.00', '1e3', '12.', '.5', ' 10.00', '10,00', '99999999999999999999.00']) {
      n += 1;
      const body = { beneficiaryId, amount, currency: 'GBP', reference: 'INV-1', reason: 'Invoice' };
      const idempotencyKey = `key-amount-${email.slice(0, 3)}-${n.toString().padStart(4, '0')}`;
      const stepUp = await h.stepUp(who.token, who.secret, 'payment.create', { ...body, idempotencyKey });
      const reply = await h.call('POST', '/v1/payments', { token: who.token, body, headers: { 'idempotency-key': idempotencyKey, 'x-step-up-token': stepUp } });
      assert.equal(reply.status, 400, `${email} ${amount}`);
      assert.deepEqual(reply.json.error.fields, ['amount'], amount);
    }
    for (const [amount, currency] of [['100.5', 'JPY'], ['10.129', 'GBP'], ['0.00', 'GBP']] as const) {
      const quote = await h.call('POST', '/v1/quotes', { token: who.token, body: { kind: 'spot', sellCurrency: currency, buyCurrency: 'USD', fixedSide: 'sell', amount } });
      assert.equal(quote.status, 400, `${amount} ${currency}`);
    }
    assert.deepEqual((await h.call('GET', '/v1/balances', { token: who.token })).json.items.map((row: any) => row.amount), before.items.map((row: any) => row.amount));
    assert.deepEqual((await h.call('GET', '/v1/payments?page=1&perPage=100', { token: who.token })).json.items.filter((row: any) => row.reference === 'INV-1'), []);
  }
  // Provider B's wire format is a JSON number: the string becomes one only if it says exactly the same thing.
  assert.equal(wireAmount('10.13'), 10.13);
  assert.equal(wireAmount('48250.75'), 48250.75);
  for (const amount of ['0.1000000000000000055511151231257827', '9007199254740993', '0', '1e3', '']) assert.throws(() => wireAmount(amount), amount);
});

// --- L3 ---------------------------------------------------------------------------------------

test('L3: a code that was already used is refused without counting toward a lock, and says when the next one comes', async () => {
  h = await harness();
  const amira = await signedIn(AMIRA);
  const ask = (code: string) => h.call('POST', '/v1/step-up', { token: amira.token, body: { action: 'payment.approve', payload: { paymentId: 'p' }, code } });
  h.clock.advance(7_000);
  for (let index = 0; index < 12; index += 1) {
    const reply = await ask(h.code(amira.secret));
    assert.equal(reply.status, 400);
    assert.equal(reply.json.error.reason, 'code_reused');
    // The authenticator shows its next code when the 30-second step changes.
    assert.equal(reply.json.error.retryAfterSeconds, 30 - (Math.floor(h.clock.now / 1000) % 30));
  }
  assert.equal(await h.stores.auth.attempts.count(() => true), 0);
  // Four wrong codes and any number of reuses in between: still not locked, and the next real code works.
  for (let index = 0; index < 4; index += 1) {
    assert.equal((await ask('000000')).json.error.reason, 'invalid_code');
    assert.equal((await ask(h.code(amira.secret))).json.error.reason, 'code_reused');
  }
  assert.equal((await ask(h.freshCode(amira.secret))).status, 200);
  // Drift: the code for the next step is still accepted, once.
  const next = h.code(amira.secret, 1);
  assert.equal((await ask(next)).status, 200);
  assert.equal((await ask(next)).json.error.reason, 'code_reused');
});

// --- L7 ---------------------------------------------------------------------------------------

test('L7: every package the server imports is declared in server/package.json and locked', () => {
  const manifest = JSON.parse(readFileSync(path.join(serverDir, 'package.json'), 'utf8')) as { dependencies: Record<string, string>; devDependencies: Record<string, string> };
  const lock = JSON.parse(readFileSync(path.join(serverDir, 'package-lock.json'), 'utf8')) as { packages: Record<string, unknown> };
  const listed = spawnSync('git', ['ls-files', 'src'], { cwd: serverDir, encoding: 'utf8' }).stdout.split('\n').filter((file) => file.endsWith('.ts'));
  assert.ok(listed.length > 15);
  const imported = new Set<string>();
  for (const file of listed) {
    for (const match of readFileSync(path.join(serverDir, file), 'utf8').matchAll(/from '([^'.@][^']*|@[^/']+\/[^/']+)[^']*'/g)) {
      const name = match[1] as string;
      if (!name.startsWith('node:') && !name.startsWith('@/')) imported.add(name.startsWith('@') ? name : (name.split('/')[0] as string));
    }
  }
  assert.ok(imported.has('zod') && imported.has('big.js') && imported.has('qrcode-generator') && imported.has('fastify'));
  for (const name of imported) {
    assert.ok(manifest.dependencies[name], `${name} is imported by the server but not declared in its dependencies`);
    assert.ok(lock.packages[`node_modules/${name}`], `${name} is not in the server lockfile`);
  }
});
