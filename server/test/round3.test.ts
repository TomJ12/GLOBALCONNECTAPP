/** Regression tests for the final audit (N1-N9 and the mutants that had survived). Each was confirmed to fail with its fix reverted. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { loadConfig, secretProblem } from '../src/config';
import { hashPassword, passwordWork } from '../src/crypto';
import { activationMessage } from '../src/mailer';
import { networkOf, sourceOf } from '../src/net';
import { createRuntime, DEMO_STAFF, seedInvitations } from '../src/startup';
import { createSqliteStores, type SqliteStores } from '../src/store/sqlite';
import { dataKeys } from '../src/store/sqlite/keys';
import { seedDirectory } from '../src/store/seed';
import type { OpsRole } from '../src/store/types';
import { isEmail } from '../src/validate';
import { AuthService } from '../src/auth/service';
import { OpsAuthService } from '../src/ops/auth';
import { ADMIN_TOKEN, AMIRA, BEN, DANA, dumpDatabase, harness, PASSWORD, TEST_DATA_KEY, type Harness } from './helpers';

let h: Harness;
afterEach(async () => h?.close());

const serverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OPS_PASSWORD = 'staff horse battery staple';
const from = (address: string) => ({ 'x-forwarded-for': address });
const login = (email: string, password: string, address?: string) => h.call('POST', '/v1/auth/login', { body: { email, password }, headers: address ? from(address) : {} });
const audit = (action?: string) => h.stores.audit.query({ action, limit: 100_000 });
const idOf = (location: string) => /\/(?:users|companies|staff|approvals)\/([\w-]+)/.exec(location)?.[1] ?? '';

async function signedIn(email: string, address?: string) {
  const account = await h.activate(email);
  const first = await login(email, PASSWORD, address);
  const reply = await h.call('POST', '/v1/auth/login/verify', { body: { challengeId: first.json.challengeId, code: h.freshCode(account.secret), method: 'totp' }, headers: address ? from(address) : {} });
  assert.equal(reply.status, 200);
  return { ...account, token: reply.json.token as string };
}

/** A staff member's browser: cookies and the CSRF field of the last page. */
class Browser {
  cookies = new Map<string, string>();
  csrf = '';
  async request(method: 'GET' | 'POST', url: string, form?: Record<string, string>, headers: Record<string, string> = {}) {
    const cookie = [...this.cookies].map(([name, value]) => `${name}=${value}`).join('; ');
    const response = await h.app.inject({ method, url, headers: { ...(cookie ? { cookie } : {}), ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}), ...headers }, ...(form ? { payload: new URLSearchParams(form).toString() } : {}) });
    for (const line of [response.headers['set-cookie'] ?? []].flat()) {
      const [pair = ''] = line.split(';');
      const at = pair.indexOf('=');
      if (/Max-Age=0/.test(line)) this.cookies.delete(pair.slice(0, at));
      else this.cookies.set(pair.slice(0, at), pair.slice(at + 1));
    }
    const csrf = /name="_csrf" value="([^"]+)"/.exec(response.body);
    if (csrf?.[1]) this.csrf = csrf[1];
    return { status: response.statusCode, body: response.body, headers: response.headers, location: String(response.headers.location ?? '') };
  }
  get(url: string, headers: Record<string, string> = {}) {
    return this.request('GET', url, undefined, headers);
  }
  post(url: string, form: Record<string, string> = {}, headers: Record<string, string> = {}) {
    return this.request('POST', url, { _csrf: this.csrf, ...form }, headers);
  }
}
interface Staff {
  browser: Browser;
  id: string;
  email: string;
  secret: string;
  act: (url: string, form?: Record<string, string>) => ReturnType<Browser['post']>;
}
/** Creates, activates (directly in the store) and signs in a staff member through the console's own sign-in pages. */
async function staff(email: string, role: OpsRole): Promise<Staff> {
  const user = await h.opsAuth.createUser(email, 'Staff Person', role);
  const { activationCode } = await h.opsAuth.createInvite(user.id);
  const enrol = await h.opsAuth.activationPassword(activationCode, OPS_PASSWORD);
  await h.opsAuth.activationConfirm(activationCode, h.code(enrol.secret), '127.0.0.1');
  const browser = new Browser();
  await browser.get('/ops/login');
  const first = await browser.post('/ops/login', { email, password: OPS_PASSWORD });
  const challengeId = /name="challengeId" value="([^"]+)"/.exec(first.body)?.[1] ?? '';
  const done = await browser.post('/ops/login/verify', { challengeId, code: h.freshCode(enrol.secret), method: 'totp' });
  assert.equal(done.status, 303, done.body.slice(-300));
  await browser.get('/ops/users');
  return { browser, id: user.id, email, secret: enrol.secret, act: (url, form = {}) => browser.post(url, { ...form, code: h.freshCode(enrol.secret) }) };
}
async function approved(requester: Staff, approver: Staff, url: string, form: Record<string, string> = {}) {
  const asked = await requester.act(url, form);
  assert.match(asked.location, /^\/ops\/approvals\//, `${url}: ${asked.body.slice(-300)}`);
  const reply = await approver.act(`/ops/approvals/${idOf(asked.location)}/approve`);
  assert.equal(reply.status, 303, `${url}: ${reply.body.slice(-300)}`);
  return idOf(asked.location);
}

// --- demo:reset --------------------------------------------------------------------------------------

test('demo:reset removes the database, its write-ahead files, its development key and any old JSON file', () => {
  const folder = mkdtempSync(path.join(tmpdir(), 'gc-reset-'));
  const database = path.join(folder, 'globalconnect.sqlite');
  try {
    for (const name of ['globalconnect.sqlite', 'globalconnect.sqlite-wal', 'globalconnect.sqlite-shm', 'globalconnect.sqlite.dev-key', 'accounts.json', 'accounts.json.audit-0001']) writeFileSync(path.join(folder, name), 'x');
    const reset = spawnSync(process.execPath, [path.join(serverDir, '..', 'scripts', 'demo.mjs'), '--reset'], { env: { PATH: process.env.PATH ?? '', DATABASE_PATH: database, DATA_FILE: path.join(folder, 'accounts.json') }, encoding: 'utf8' });
    assert.equal(reset.status, 0);
    assert.deepEqual(readdirSync(folder), []);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

// --- N2 ---------------------------------------------------------------------------------------------

test('N2: the limiter counts an IPv6 /64 as one source and an IPv4 /24 as a neighbourhood (real limits)', async () => {
  assert.equal(sourceOf('2001:db8:1:2:aaaa:bbbb:cccc:dddd'), '2001:db8:1:2::/64');
  assert.equal(sourceOf('2001:db8:1:2::1'), sourceOf('2001:db8:1:2:ffff:ffff:ffff:ffff'));
  assert.notEqual(sourceOf('2001:db8:1:2::1'), sourceOf('2001:db8:1:3::1'));
  assert.equal(sourceOf('203.0.113.9'), '203.0.113.9');
  assert.equal(sourceOf('::ffff:203.0.113.9'), '203.0.113.9');
  assert.equal(networkOf('203.0.113.9'), '203.0.113.0/24');

  const { authRequestsPerMinute, authRequestsPerNetworkPerMinute } = loadConfig({ APP_ENV: 'development' });
  assert.deepEqual([authRequestsPerMinute, authRequestsPerNetworkPerMinute], [30, 90]);
  h = await harness({ trustProxy: 1, authRequestsPerMinute, authRequestsPerNetworkPerMinute });
  // A new address inside the same /64 for every request buys nothing.
  const six: number[] = [];
  for (let index = 0; index < 32; index += 1) six.push((await login(`n${index}@nowhere.example`, PASSWORD, `2001:db8:1:2::${(index + 1).toString(16)}`)).status);
  assert.deepEqual([six.filter((status) => status === 400).length, six.slice(30)], [30, [429, 429]]);
  assert.equal((await login('other@nowhere.example', PASSWORD, '2001:db8:1:3::1')).status, 400, 'another /64 is another source');
  // Ten neighbours in one /24, each well inside its own allowance, share the neighbourhood's.
  const four: number[] = [];
  for (let index = 0; index < 100; index += 1) four.push((await login(`m${index}@nowhere.example`, PASSWORD, `198.51.100.${10 + (index % 10)}`)).status);
  assert.equal(four.filter((status) => status === 400).length, 90);
  assert.deepEqual(four.slice(90), Array(10).fill(429));
  assert.equal((await login('other@nowhere.example', PASSWORD, '198.51.101.10')).status, 400);
  // The lockout treats a /64 as one source too: five wrong passwords from five addresses in it lock it.
  await h.activate(AMIRA);
  h.clock.advance(61_000);
  for (let index = 0; index < 5; index += 1) await login(AMIRA, 'wrong password here', `2001:db8:9:9::${index + 1}`);
  assert.equal((await login(AMIRA, PASSWORD, '2001:db8:9:9::ffff')).status, 429);
});

test('N2: a flood of sign-ins for unknown emails cannot starve a real sign-in, gets the same answer, and is never refused', async () => {
  h = await harness();
  const { secret } = await h.activate(AMIRA);
  void secret;
  const before = { ...passwordWork };
  const flood = Array.from({ length: 150 }, (_, index) => login(`nobody${index}@nowhere.example`, PASSWORD));
  const real = login(AMIRA, PASSWORD);
  const wrong = login(AMIRA, 'wrong password here');
  const replies = await Promise.all(flood);
  // The real person signs in; nobody was told "too busy".
  assert.equal((await real).status, 200);
  assert.deepEqual([...new Set(replies.map((reply) => reply.status))], [400]);
  // Unknown email and wrong password are still indistinguishable by content.
  assert.deepEqual(replies[0]?.json, (await wrong).json);
  assert.equal(new Set(replies.map((reply) => JSON.stringify(reply.json))).size, 1);
  // Only the two real attempts used the pool real accounts use; the flood was hashed three at most at a time, the rest waited instead.
  assert.equal(passwordWork.hashes - before.hashes, 2);
  assert.equal(passwordWork.decoyHashes - before.decoyHashes + (passwordWork.decoyWaits - before.decoyWaits), 150);
  assert.ok(passwordWork.decoyHashes - before.decoyHashes <= 3, `${passwordWork.decoyHashes - before.decoyHashes} decoy hashes`);
});

test('N2: staff sign-in has capacity of its own: a saturated client pool does not refuse it', async () => {
  h = await harness();
  const user = await h.opsAuth.createUser('s@globalconnect.example', 'S', 'ops');
  const { activationCode } = await h.opsAuth.createInvite(user.id);
  await h.opsAuth.activationPassword(activationCode, OPS_PASSWORD);
  const enrol = await h.opsAuth.activationPending(activationCode);
  await h.opsAuth.activationConfirm(activationCode, h.code(enrol.secret), '127.0.0.1');
  // The client pool is full: two running, thirty-two waiting, the rest refused.
  const burst = Array.from({ length: 60 }, () => hashPassword('correct horse battery', 'client').then(() => 'done', () => 'refused'));
  const challenge = await h.opsAuth.login('s@globalconnect.example', OPS_PASSWORD, '127.0.0.1');
  assert.ok(challenge.challengeId);
  const outcomes = await Promise.all(burst);
  assert.equal(outcomes.filter((outcome) => outcome === 'refused').length, 26);
});

// --- N3 ---------------------------------------------------------------------------------------------

test('N3: staff can only be at an allowed domain (checked when asked and when approved); approver sees the pair\'s history; a client\'s email domain is compared with the company\'s', async () => {
  h = await harness();
  const admin = await staff('admin@globalconnect.example', 'ops_admin');
  const boss = await staff('boss@globalconnect.example', 'ops_admin');
  assert.deepEqual(h.config.staffEmailDomains, ['globalconnect.example']);

  // An address the requester controls somewhere else is refused outright.
  for (const email of ['me@evil.example', 'me@globalconnect.example.evil.example', 'me@notglobalconnect.example']) {
    const reply = await admin.act('/ops/staff', { name: 'Me Myself', email, role: 'ops_admin' });
    assert.equal(reply.status, 403, email);
    assert.match(reply.body, /Staff accounts can only be created for addresses at: globalconnect\.example/);
  }
  assert.equal((await h.stores.ops.approvals.list()).length, 0);
  // Allowed when asked, no longer allowed when approved: not created.
  const asked = await admin.act('/ops/staff', { name: 'New Person', email: 'new.person@globalconnect.example', role: 'ops' });
  h.config.staffEmailDomains = ['elsewhere.example'];
  assert.equal((await boss.act(`/ops/approvals/${idOf(asked.location)}/approve`)).status, 403);
  assert.equal((await h.stores.ops.users.list()).length, 2);
  assert.equal(h.outbox.sent.length, 0);
  h.config.staffEmailDomains = ['globalconnect.example'];
  assert.equal((await boss.act(`/ops/approvals/${idOf(asked.location)}/approve`)).status, 303);
  // Written prominently: who is new, who asked, who approved.
  const added = (await audit('ops.staff.new'))[0];
  assert.deepEqual([added?.target?.label, added?.detail.role, added?.detail.requestedBy, added?.detail.approvedBy], ['new.person@globalconnect.example', 'ops', admin.email, boss.email]);
  assert.match((await boss.browser.get('/ops/audit')).body, /<tr class="alert"><td>[^<]+<\/td><td>admin@globalconnect\.example[^]*?ops\.staff\.new/);

  // A client's address at a domain nobody in the company uses is flagged to the approver; a matching one is not.
  const stranger = await admin.act('/ops/users', { name: 'Sam Stranger', email: 'sam@evil.example', company1: 'co_northfield', role1: 'admin' });
  const strange = (await boss.browser.get(stranger.location)).body;
  assert.match(strange, /EMAIL DOMAIN MISMATCH: evil\.example is not the domain of anyone already in “Northfield Trading Ltd” \(co_northfield\) \(adviser\.example, northfield\.example\)/);
  const colleague = await admin.act('/ops/users', { name: 'Nora North', email: 'nora@northfield.example', company1: 'co_northfield', role1: 'creator' });
  const fine = (await boss.browser.get(colleague.location)).body;
  assert.match(fine, /Email domain northfield\.example matches people already in “Northfield Trading Ltd” \(co_northfield\)/);
  assert.doesNotMatch(fine, /MISMATCH/);
  // Attaching an existing client to another company is compared the same way.
  const attach = await admin.act('/ops/users/usr_ben/memberships', { companyId: 'co_northfield', role: 'admin' });
  assert.match((await boss.browser.get(attach.location)).body, /EMAIL DOMAIN MISMATCH: castlebrook\.example/);

  // The approver is shown how often they have approved this requester, and told when it is nearly always them.
  assert.match(fine, /In the last 30 days admin@globalconnect\.example has had 1 request approved, 1 of them by you\./);
  for (let index = 0; index < 4; index += 1) await approved(admin, boss, '/ops/users/usr_dana/activation-link');
  const fifth = await admin.act('/ops/users/usr_dana/activation-link');
  const page = (await boss.browser.get(fifth.location)).body;
  assert.match(page, /has had 5 requests approved, 5 of them by you\. You approve most of this person’s requests/);
  assert.equal((await boss.act(`/ops/approvals/${idOf(fifth.location)}/approve`)).status, 303);
  assert.equal((await audit('ops.approval.approve'))[0]?.detail.pairApprovals30d, '6');
});

// --- N4 ---------------------------------------------------------------------------------------------

test('N4: break-glass. With exactly two staff neither can act on the other; the operator command can, with a reason, and it is audited', async () => {
  h = await harness();
  const admin = await staff('admin@globalconnect.example', 'ops_admin');
  const other = await staff('other@globalconnect.example', 'ops_admin');
  // The deadlock: admin asks for other to be disabled; the only other staff member is the target.
  const asked = await admin.act(`/ops/staff/${other.id}/disable`);
  assert.equal((await other.act(`/ops/approvals/${idOf(asked.location)}/approve`)).status, 403);
  assert.equal((await admin.act(`/ops/approvals/${idOf(asked.location)}/approve`)).status, 403);

  const call = (body: unknown, token?: string) => h.adminCall('/admin/break-glass', body, token);
  const good = { action: 'disable-staff', email: other.email, reason: 'Laptop stolen, reported by phone' };
  // Not on the public listener; needs the token, a known action, a real reason and an existing staff member.
  assert.equal((await h.call('POST', '/admin/break-glass', { token: ADMIN_TOKEN, body: good })).status, 404);
  assert.equal((await call(good, 'wrong-token-0123456789')).status, 404);
  assert.equal((await call({ ...good, reason: 'because' })).status, 400);
  assert.equal((await call({ ...good, reason: 'x\ny'.repeat(10) })).status, 400);
  assert.equal((await call({ ...good, action: 'delete-staff' })).status, 400);
  assert.equal((await call({ ...good, email: 'nobody@globalconnect.example' })).status, 404);
  assert.equal((await call({ ...good, email: AMIRA })).status, 404, 'staff only: a client cannot be touched this way');
  assert.equal((await h.stores.ops.users.get(other.id))?.disabledAt, null);

  // Disable: at once, sessions ended.
  assert.deepEqual((await call(good)).json, { done: 'disabled', staff: 'o…@globalconnect.example' });
  assert.equal((await other.browser.get('/ops/users')).status, 303);
  // Bootstrap is open again, because there is now only one active ops admin.
  assert.equal((await h.adminCall('/admin/ops-admins', { email: 'third@globalconnect.example', name: 'Third' })).status, 200);

  // Unlock: a locked-out staff member can sign in again.
  const visitor = new Browser();
  await visitor.get('/ops/login');
  for (let index = 0; index < 5; index += 1) await visitor.post('/ops/login', { email: admin.email, password: 'wrong password here' });
  assert.equal((await visitor.post('/ops/login', { email: admin.email, password: OPS_PASSWORD })).status, 429);
  assert.equal((await call({ action: 'unlock-staff', email: admin.email, reason: 'Locked out by guessing, verified by phone' })).status, 200);
  assert.equal((await visitor.post('/ops/login', { email: admin.email, password: OPS_PASSWORD })).status, 200);

  // Reset: credentials gone, sessions ended, a new link emailed to the staff member and not returned.
  const before = h.outbox.sent.length;
  const reset = await call({ action: 'reset-staff', email: admin.email, reason: 'Lost phone and recovery codes, identity checked in person' });
  assert.equal(reset.status, 200);
  assert.doesNotMatch(JSON.stringify(reset.json), /code=|[A-Z2-7]{5}-[A-Z2-7]{5}/);
  assert.equal((await admin.browser.get('/ops/users')).status, 303);
  assert.deepEqual([(await h.stores.ops.users.get(admin.id))?.passwordHash, (await h.stores.ops.users.get(admin.id))?.totpSecret], [null, null]);
  assert.equal(h.outbox.sent.length, before + 1);
  assert.equal(h.outbox.sent.at(-1)?.to, admin.email);
  assert.equal((await call({ action: 'reset-staff', email: other.email, reason: 'This one is disabled, should refuse' })).status, 400);

  // Every use is in the audit log, with the reason, and stands out.
  const entries = await audit('ops.break_glass');
  assert.deepEqual(entries.filter((entry) => entry.outcome === 'success').map((entry) => [entry.action, entry.target?.label, entry.detail.reason]), [
    ['ops.break_glass.reset', admin.email, 'Lost phone and recovery codes, identity checked in person'],
    ['ops.break_glass.unlock', admin.email, 'Locked out by guessing, verified by phone'],
    ['ops.break_glass.disable', other.email, 'Laptop stolen, reported by phone'],
  ]);
  assert.ok(entries.some((entry) => entry.outcome === 'failure'));
});

// --- N5 ---------------------------------------------------------------------------------------------

test('N5: guesses from many addresses do not lock the owner out where they have signed in before; a lock is not renewed by one guess', async () => {
  h = await harness({ trustProxy: 1 });
  const amira = await signedIn(AMIRA, '198.51.100.7');
  assert.deepEqual((await h.stores.directory.getUser('usr_amira'))?.knownSources, ['198.51.100.0/24']);

  // 52 wrong passwords, four from each of 13 addresses: no address reaches its own limit, the account-wide one is reached.
  for (let index = 0; index < 52; index += 1) await login(AMIRA, 'wrong password here', `203.0.113.${1 + (index % 13)}`);
  assert.equal((await login(AMIRA, PASSWORD, '192.0.2.50')).status, 429, 'locked for a source it has never been used from');
  // The owner, where they have signed in before (same network, another address), is not locked out.
  const challenge = await login(AMIRA, PASSWORD, '198.51.100.99');
  assert.equal(challenge.status, 200);
  assert.equal((await h.call('POST', '/v1/auth/login/verify', { body: { challengeId: challenge.json.challengeId, code: h.freshCode(amira.secret), method: 'totp' }, headers: from('198.51.100.99') })).status, 200);
  // An attacker ON that network still meets the per-source limit.
  for (let index = 0; index < 5; index += 1) await login(AMIRA, 'wrong password here', '198.51.100.200');
  assert.equal((await login(AMIRA, PASSWORD, '198.51.100.200')).status, 429);
  assert.equal((await login(AMIRA, PASSWORD, '198.51.100.99')).status, 200);

  // After the account-wide lock runs out, one guess per expiry neither renews it nor lengthens it.
  const lockedFor = (await login(AMIRA, PASSWORD, '192.0.2.50')).json.error.retryAfterSeconds as number;
  assert.ok(lockedFor > 0 && lockedFor <= 60);
  for (let round = 0; round < 6; round += 1) {
    h.clock.advance(61_000);
    assert.equal((await login(AMIRA, 'wrong password here', `192.0.2.${60 + round}`)).status, 400, `round ${round}`);
    assert.equal((await login(AMIRA, PASSWORD, `192.0.2.${80 + round}`)).status, 200, `not locked again after one guess (round ${round})`);
  }
});

test('N5: a locked-out staff member can be unlocked from the console, with a second ops admin', async () => {
  // A long lock, so that it cannot simply run out while the clock moves on for the staff members' fresh codes.
  h = await harness({ lockoutBaseMs: 30 * 60_000 });
  const admin = await staff('admin@globalconnect.example', 'ops_admin');
  const boss = await staff('boss@globalconnect.example', 'ops_admin');
  const victim = await staff('victim@globalconnect.example', 'ops');
  const visitor = new Browser();
  await visitor.get('/ops/login');
  for (let index = 0; index < 5; index += 1) await visitor.post('/ops/login', { email: victim.email, password: 'wrong password here' });
  assert.equal((await visitor.post('/ops/login', { email: victim.email, password: OPS_PASSWORD })).status, 429);
  assert.match((await admin.browser.get(`/ops/staff/${victim.id}`)).body, /<dt>Locked out<\/dt><dd>Yes<\/dd>[^]*action="\/ops\/staff\/[\w-]+\/unlock"/);
  const asked = await admin.act(`/ops/staff/${victim.id}/unlock`);
  assert.equal((await visitor.post('/ops/login', { email: victim.email, password: OPS_PASSWORD })).status, 429, 'not until approved');
  assert.equal((await boss.act(`/ops/approvals/${idOf(asked.location)}/approve`)).status, 303);
  assert.equal((await visitor.post('/ops/login', { email: victim.email, password: OPS_PASSWORD })).status, 200);
  assert.equal((await audit('ops.staff.unlock'))[0]?.detail.approvedBy, boss.email);
});

// --- N6 ---------------------------------------------------------------------------------------------

test('N6: the pre-login anchor is signed, not stored: any number of sign-in pages cost nothing and evict nobody; the page is rate limited', async () => {
  h = await harness();
  const admin = await staff('admin@globalconnect.example', 'ops_admin');
  // A real member of staff opens the sign-in page...
  const real = new Browser();
  await real.get('/ops/login');
  const anchor = real.cookies.get('gc_ops_pre') ?? '';
  assert.match(anchor, /^\d+\.[\w-]+\.[\w-]+$/);
  // ...then thousands of other requests for it arrive.
  const rowsBefore = dumpDatabase(h.stores);
  for (let index = 0; index < 3000; index += 1) await h.app.inject({ method: 'GET', url: '/ops/login' });
  assert.equal(dumpDatabase(h.stores), rowsBefore, 'nothing is stored per visitor');
  // The real one can still sign in with the page they already have.
  const first = await real.post('/ops/login', { email: admin.email, password: OPS_PASSWORD });
  assert.equal(first.status, 200);
  assert.match(first.body, /name="challengeId"/);

  // A value the server did not sign anchors nothing: a changed expiry, a changed nonce, another server's signature.
  const [expires = '', nonce = '', signature = ''] = anchor.split('.');
  const field = (value: string) => createHash('sha256').update(`ops-csrf:${value}`).digest('hex');
  for (const forged of [`${Number(expires) + 86_400_000}.${nonce}.${signature}`, `${expires}.${nonce}x.${signature}`, `${expires}.${nonce}.${'A'.repeat(43)}`, `${expires}.${nonce}`, 'A'.repeat(43)]) {
    const visitor = new Browser();
    visitor.cookies.set('gc_ops_pre', forged);
    assert.equal((await visitor.request('POST', '/ops/login', { email: admin.email, password: OPS_PASSWORD, _csrf: field(forged) })).status, 403, forged.slice(0, 30));
  }
  // The server's own value stops working after half an hour.
  h.clock.advance(31 * 60_000);
  assert.equal((await real.post('/ops/login', { email: admin.email, password: OPS_PASSWORD })).status, 403);

  // At the real limit the page itself is rationed per source.
  await h.close();
  h = await harness({ authRequestsPerMinute: 30 });
  const statuses: number[] = [];
  for (let index = 0; index < 32; index += 1) statuses.push((await h.app.inject({ method: 'GET', url: index % 2 ? '/ops/login' : '/ops/activate' })).statusCode);
  assert.deepEqual([statuses.filter((status) => status === 200).length, statuses.slice(30)], [30, [429, 429]]);
});

// --- N7 ---------------------------------------------------------------------------------------------

test('N7: company names are unique whatever the case or spacing; a rename needs a second person; requests show the company id and a recent old name', async () => {
  h = await harness();
  const admin = await staff('admin@globalconnect.example', 'ops_admin');
  const boss = await staff('boss@globalconnect.example', 'ops_admin');
  const olu = await staff('olu@globalconnect.example', 'ops');
  const castlebrook = { provider: 'provider-b', providerAccountId: 'S00001', providerContactId: 'sample-person-0001' };

  // A second "Northfield Trading Ltd", however it is written, is refused: as a new company and as a rename.
  for (const name of ['Northfield Trading Ltd', 'northfield trading ltd', '  NORTHFIELD   Trading  LTD ']) {
    assert.equal((await admin.act('/ops/companies', { name, provider: 'provider-b', providerAccountId: 'S00002' })).status, 409, name);
    assert.equal((await olu.act('/ops/companies/co_castlebrook', { name, ...castlebrook })).status, 409, name);
  }
  assert.equal((await h.stores.ops.approvals.list()).length, 0);
  // Also when the other request was approved in between.
  const first = await admin.act('/ops/companies', { name: 'Harbour Ltd', provider: 'provider-b', providerAccountId: 'S00002' });
  const second = await admin.act('/ops/companies', { name: 'HARBOUR LTD', provider: 'provider-b', providerAccountId: 'S00003' });
  assert.equal((await boss.act(`/ops/approvals/${idOf(first.location)}/approve`)).status, 303);
  assert.equal((await boss.act(`/ops/approvals/${idOf(second.location)}/approve`)).status, 409);
  assert.equal((await h.stores.directory.listCompanies()).length, 3);

  // A lone ops user cannot rename a company: it is only a request, which says which company by id.
  const asked = await olu.act('/ops/companies/co_castlebrook', { name: 'Northfield Trading (Holdings) Ltd', ...castlebrook });
  assert.match(asked.location, /^\/ops\/approvals\//);
  assert.equal((await h.stores.directory.getCompany('co_castlebrook'))?.name, 'Castlebrook Imports Ltd');
  assert.match((await admin.browser.get(asked.location)).body, /Rename company “Castlebrook Imports Ltd” \(co_castlebrook\) to “Northfield Trading \(Holdings\) Ltd”/);
  assert.equal((await olu.act(`/ops/approvals/${idOf(asked.location)}/approve`)).status, 403);
  assert.equal((await admin.act(`/ops/approvals/${idOf(asked.location)}/approve`)).status, 303);
  const renamed = await h.stores.directory.getCompany('co_castlebrook');
  assert.deepEqual([renamed?.name, renamed?.previousName], ['Northfield Trading (Holdings) Ltd', 'Castlebrook Imports Ltd']);

  // A later request about that company shows its id and what it was called until just now.
  const later = await olu.act('/ops/users', { name: 'Vic Tim', email: 'vic@northfield.example', company1: 'co_castlebrook', role1: 'admin' });
  const page = (await admin.browser.get(later.location)).body;
  assert.match(page, /in “Northfield Trading \(Holdings\) Ltd” \(co_castlebrook; named “Castlebrook Imports Ltd” until 2026-/);
  assert.match(page, /EMAIL DOMAIN MISMATCH/);
  assert.match((await admin.browser.get('/ops/companies/co_castlebrook')).body, /Named “Castlebrook Imports Ltd” until 2026-/);
  // Thirty days on, the old name is no longer shown, but the id always is.
  h.clock.advance(31 * 24 * 60 * 60_000);
  const fresh = await staff('fresh@globalconnect.example', 'ops');
  const much = await fresh.act('/ops/users/usr_ben/memberships', { companyId: 'co_castlebrook', role: 'creator' });
  const old = (await fresh.browser.get(much.location)).body;
  assert.match(old, /in “Northfield Trading \(Holdings\) Ltd” \(co_castlebrook\)/);
  assert.doesNotMatch(old, /named “Castlebrook/);

  // Reactivating a company gives access back, so it too needs a second person; deactivating does not.
  assert.equal((await fresh.act('/ops/companies/co_northfield/deactivate')).location, '/ops/companies/co_northfield?done=saved');
  const back = await fresh.act('/ops/companies/co_northfield/reactivate');
  assert.match(back.location, /^\/ops\/approvals\//);
  assert.ok((await h.stores.directory.getCompany('co_northfield'))?.deactivatedAt);
});

// --- N8 ---------------------------------------------------------------------------------------------

test('N8: a restart never replaces a live invitation; it prints the same still-valid codes, and never touches accounts made in the console', async () => {
  const folder = mkdtempSync(path.join(tmpdir(), 'gc-seed-'));
  const file = path.join(folder, 'demo.sqlite');
  const config = { ...loadConfig({ APP_ENV: 'development' }), appUrl: 'http://localhost:3001' };
  let now = Date.UTC(2026, 10, 11, 10, 0, 0);
  const clock = () => now;
  const held: { stores: SqliteStores | null } = { stores: null };
  const start = async () => {
    held.stores?.close();
    const stores = (held.stores = createSqliteStores({ path: file, keys: dataKeys(TEST_DATA_KEY), seed: seedDirectory(), now: clock }));
    const auth = new AuthService(stores, config, clock);
    const opsAuth = new OpsAuthService(stores, config, clock);
    return { stores, auth, opsAuth, lines: await seedInvitations({ stores, seedCodes: stores.seedCodes }, auth, opsAuth, config, clock) };
  };
  const codesIn = (lines: string[]) => Object.fromEntries(lines.map((line) => [line.trim().split(/\s+/)[0], /#code=([A-Z2-7-]+)/.exec(line)?.[1]]));
  try {
    const first = await start();
    assert.equal(first.lines.length, 3 + DEMO_STAFF.length);
    assert.deepEqual(DEMO_STAFF.map((item) => item.role), ['ops_admin', 'ops_admin', 'ops']);
    const printed = codesIn(first.lines);
    assert.equal((await first.auth.activationStart(printed[AMIRA] as string)).email, AMIRA);
    // The console creates a client and mails them a link; a seed client gets a new link from the console too.
    await first.stores.directory.saveUser({ id: 'usr_console', email: 'new@client.example', name: 'New Client', passwordHash: null, totpSecret: null, lastTotpStep: 0, recoveryCodeHashes: [], activatedAt: null });
    const mailed = await first.auth.createInvite('new@client.example');
    const benMailed = await first.auth.createInvite(BEN);
    const activations = await first.stores.auth.activations.count({});

    // RESTART, an hour later.
    now += 60 * 60_000;
    const second = await start();
    const again = codesIn(second.lines);
    // Same codes as before for the untouched sample accounts and staff, and they still work.
    for (const email of [AMIRA, DANA, ...DEMO_STAFF.map((item) => item.email)]) assert.equal(again[email], printed[email], email);
    assert.match(second.lines.find((line) => line.includes(AMIRA)) ?? '', /still valid, until 2026-11-14 10:00 UTC/);
    assert.equal((await second.auth.activationStart(printed[AMIRA] as string)).email, AMIRA);
    assert.equal((await second.opsAuth.activationStart(printed[DEMO_STAFF[0]?.email ?? ''] as string)).email, DEMO_STAFF[0]?.email);
    // The links mailed from the console were not replaced, and no new one was printed in their place.
    assert.equal((await second.auth.activationStart(mailed.activationCode)).email, 'new@client.example');
    assert.equal((await second.auth.activationStart(benMailed.activationCode)).email, BEN);
    assert.match(second.lines.find((line) => line.includes(BEN)) ?? '', /has NOT been replaced/);
    assert.ok(!second.lines.some((line) => line.includes('new@client.example')), 'console-made accounts are never printed');
    assert.equal(await second.stores.auth.activations.count({}), activations);

    // Only when nothing live is left (72 hours on) is a new code issued, for sample accounts only.
    now += 73 * 60 * 60_000;
    const third = await start();
    const renewed = codesIn(third.lines);
    assert.ok(renewed[AMIRA] && renewed[AMIRA] !== printed[AMIRA]);
    assert.ok(renewed[BEN]);
    assert.ok(!third.lines.some((line) => line.includes('new@client.example')));
    await assert.rejects(third.auth.activationStart(mailed.activationCode));

    // Outside development no readable code is ever written: the table of printed codes refuses.
    held.stores?.close();
    held.stores = null;
    const strict = createRuntime({ ...loadConfig({ APP_ENV: 'development' }), development: false, strict: true, databasePath: path.join(folder, 'strict.sqlite'), dataEncryptionKey: TEST_DATA_KEY }, { mailer: { send: async () => {} }, transports: { currencycloud: { request: async () => ({ status: 500, body: null }) } as never, equals: { request: async () => ({ status: 500, body: null }) } as never } });
    await assert.rejects(strict.seedCodes.put('k', { code: 'c', codeHash: 'h' }), /only in development mode/);
    assert.equal(strict.stores.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM dev_seed_codes')?.n, 0);
    assert.equal(strict.stores.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM users')?.n, 0, 'no sample accounts outside development');
    strict.stores.close();
  } finally {
    held.stores?.close();
    rmSync(folder, { recursive: true, force: true });
  }
});

test('npm run demo refuses to start beside an old JSON data file BEFORE building anything, and says exactly what to run', () => {
  const folder = mkdtempSync(path.join(tmpdir(), 'gc-demo-'));
  const file = path.join(folder, 'accounts.json');
  const script = path.join(serverDir, '..', 'scripts', 'demo.mjs');
  try {
    writeFileSync(file, JSON.stringify({ version: 3, directory: {} }));
    const started = Date.now();
    const run = spawnSync(process.execPath, [script], { env: { PATH: process.env.PATH ?? '', DATA_FILE: file, DATABASE_PATH: path.join(folder, 'demo.sqlite') }, encoding: 'utf8', timeout: 20_000 });
    assert.equal(run.status, 1, 'it must stop, not start the one-minute build');
    assert.ok(Date.now() - started < 10_000);
    assert.match(run.stderr, /npm run demo:reset/);
    assert.match(run.stderr, /earlier version/);
    assert.doesNotMatch(run.stdout + run.stderr, /Building the web app/);
    assert.ok(!existsSync(path.join(folder, 'demo.sqlite')));
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

// --- N9 ---------------------------------------------------------------------------------------------

test('N9: the client web app and the API are served with frame protection and a content security policy', async () => {
  const web = mkdtempSync(path.join(tmpdir(), 'gc-web-'));
  mkdirSync(path.join(web, '_expo'));
  writeFileSync(path.join(web, 'index.html'), '<!doctype html><title>app</title>');
  writeFileSync(path.join(web, '_expo', 'app.js'), 'console.log(1)');
  try {
    h = await harness({ webDir: web });
    for (const url of ['/', '/activate', '/some/app/route', '/_expo/app.js', '/v1/balances', '/healthz', '/nothing.png']) {
      const reply = await h.app.inject({ method: 'GET', url });
      assert.equal(reply.headers['x-frame-options'], 'DENY', url);
      const csp = String(reply.headers['content-security-policy']);
      assert.match(csp, /frame-ancestors 'none'/, url);
      assert.match(csp, /script-src 'self'(;|$)/, url);
      assert.match(csp, /default-src 'self'/, url);
      assert.match(csp, /object-src 'none'/, url);
      assert.doesNotMatch(csp, /script-src[^;]*unsafe|\*|https?:/, url);
      assert.equal(reply.headers['x-content-type-options'], 'nosniff', url);
    }
    assert.match((await h.app.inject({ method: 'GET', url: '/activate' })).body, /<title>app<\/title>/);
    // The ops console keeps its own, stricter policy.
    assert.match(String((await h.app.inject({ method: 'GET', url: '/ops/login' })).headers['content-security-policy']), /default-src 'none'/);
  } finally {
    rmSync(web, { recursive: true, force: true });
  }
});

test('N9: names cannot carry control characters into a mail, and email addresses must be plain', async () => {
  for (const good of ['a@b.co', 'first.last+tag@sub.example.com', 'x_y%z@example.org']) assert.equal(isEmail(good), true, good);
  for (const bad of ['x\'"<b>@evil.example', 'a b@example.com', 'a@b', 'a@@b.com', '<a@b.com>', 'a@b..com', 'a..b@c.com', '.a@b.com', 'a@-b.com', 'a@b.com\n', 'a@b.c', `${'a'.repeat(250)}@b.com`, '"quoted"@b.com', 'a@[127.0.0.1]']) assert.equal(isEmail(bad), false, bad);
  // Whatever reaches the mailer, a name is one line.
  const message = activationMessage({ activationLink: 'https://app.example/activate#code=X', expiresAt: 0 }, 'a@b.co', 'Eve\r\nBcc: all@evil.example\n\nPay to: 00-00-00 now', 'client');
  assert.equal(message.text.split('\n')[0], 'Hello Eve Bcc: all@evil.example Pay to: 00-00-00 now,');
  assert.equal(message.text.split('\n').length, 7);

  h = await harness();
  const admin = await staff('admin@globalconnect.example', 'ops_admin');
  const before = (await h.stores.ops.approvals.list()).length;
  for (const form of [
    { name: 'Eve\nBcc: all@evil.example', email: 'eve@northfield.example' },
    { name: 'Tab\tbed', email: 'tab@northfield.example' },
    { name: 'Fine Name', email: 'x\'"<b>@evil.example' },
    { name: 'Fine Name', email: 'eve@northfield.example\r\nBcc: x@evil.example' },
  ]) {
    assert.equal((await admin.act('/ops/users', { ...form, company1: 'co_northfield', role1: 'creator' })).status, 400, JSON.stringify(form));
  }
  assert.equal((await admin.act('/ops/companies', { name: 'Line\nBreak Ltd', provider: 'provider-b', providerAccountId: 'S00002' })).status, 400);
  assert.equal((await admin.act('/ops/staff', { name: 'New\nLine', email: 'n@globalconnect.example', role: 'ops' })).status, 400);
  assert.equal((await h.stores.ops.approvals.list()).length, before);
});

test('N9: the adapter cache is keyed by the mapping, and a step-up permission is bound to its company', async () => {
  h = await harness();
  // Same company id, different mapping: a different adapter, without anybody calling invalidate.
  const company = (await h.stores.directory.getCompany('co_castlebrook')) as NonNullable<Awaited<ReturnType<typeof h.stores.directory.getCompany>>>;
  const one = await h.registry.forCompany(company);
  assert.equal(await h.registry.forCompany({ ...company }), one);
  const moved = await h.registry.forCompany({ ...company, providerAccountId: 'S00002' });
  assert.notEqual(moved, one);
  assert.notEqual((await moved.listBalances())[0]?.id, (await one.listBalances())[0]?.id);
  h.registry.invalidate('co_castlebrook');
  assert.notEqual(await h.registry.forCompany(company), one);

  // A permission granted for one company is worth nothing in another, even if it is written after the switch
  // (as a request that was in flight would write it): the record itself says which company it is for.
  const dana = await signedIn(DANA);
  await h.call('POST', '/v1/session/company', { token: dana.token, body: { companyId: 'co_northfield' } });
  const stale = await h.auth.authenticate(dana.token);
  await h.call('POST', '/v1/session/company', { token: dana.token, body: { companyId: 'co_castlebrook' } });
  const granted = await h.auth.grantStepUp(stale, 'payment.approve', { paymentId: 'p' }, h.freshCode(dana.secret));
  const current = await h.auth.authenticate(dana.token);
  assert.equal(current.company?.id, 'co_castlebrook');
  await assert.rejects(h.auth.consumeStepUp(current, granted.token, 'payment.approve', { paymentId: 'p' }), /step_up_invalid/);
});

test('N9: if the activation email cannot be sent after a reset cleared the credentials, the approval can simply be tried again', async () => {
  h = await harness();
  const amira = await h.activate(AMIRA);
  void amira;
  const admin = await staff('admin@globalconnect.example', 'ops_admin');
  const boss = await staff('boss@globalconnect.example', 'ops_admin');
  const victim = await staff('victim@globalconnect.example', 'ops');
  const send = h.outbox.send.bind(h.outbox);
  let failing = true;
  h.outbox.send = async (message) => {
    if (failing) throw new Error('smtp unavailable');
    return send(message);
  };
  for (const [url, read] of [
    ['/ops/users/usr_amira/reset-authenticator', async () => (await h.stores.directory.getUser('usr_amira'))?.activatedAt],
    [`/ops/staff/${victim.id}/reset-authenticator`, async () => (await h.stores.ops.users.get(victim.id))?.activatedAt],
  ] as const) {
    failing = true;
    const asked = await admin.act(url, { verification: 'Called back on the number on file' });
    const id = idOf(asked.location);
    const failed = await boss.act(`/ops/approvals/${id}/approve`);
    assert.equal(failed.status, 500, url);
    // Credentials are gone, nothing was sent, and the request is waiting again rather than stuck or marked done.
    assert.equal(await read(), null);
    assert.equal(h.outbox.sent.length, url.includes('staff') ? 1 : 0);
    assert.equal((await h.stores.ops.approvals.get(id))?.status, 'pending');
    failing = false;
    assert.equal((await boss.act(`/ops/approvals/${id}/approve`)).status, 303, `${url} retried`);
    assert.equal((await h.stores.ops.approvals.get(id))?.status, 'approved');
    assert.equal(h.outbox.sent.length, url.includes('staff') ? 2 : 1);
  }
  assert.deepEqual(h.outbox.sent.map((message) => message.to), [AMIRA, victim.email]);
});

test('config: sequences and keyboard runs are not secrets, and only a few proxy hops can be trusted', () => {
  for (const token of ['abcdefghijklmnopqrstuvwxyz0123456789', 'zyxwvutsrqponmlkjihgfedcba9876543210', 'qwertyuiopasdfghjklzxcvbnm1234567890', 'Xk3!Xk3!Xk3!Xk3!Xk3!Xk3!Xk3!Xk3!Xk3!', 'aB3aB3aB3aB3aB3aB3aB3aB3aB3aB3aB3aB3', 'mzqkxjvwhbpfgtrnsdlcyaeioumzqkxjvw', 'mzqkxjvwhbpf7391gtrnsdlc8264yaeiou5', 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6abcde']) {
    assert.ok(secretProblem(token), token);
    assert.throws(() => loadConfig({ APP_ENV: 'development', ADMIN_TOKEN: token }), /ADMIN_TOKEN is refused/, token);
  }
  // What the documented generators produce is accepted.
  for (const token of [ADMIN_TOKEN, 'q0J8mZ2xP7c1Yt5LwR9sK3vB6nH4dF8gA2eU0iO5yT1=', '9f2c4e6a8b0d1f3a5c7e9b2d4f6a8c0e1b3d5f7a9c2e4b6d8f0a1c3e5b7d9f2a', 'kP3_x9-Lm2Qw7Zr5Tn8Vb4Yc6Hd1Jf0GsAeUiOaXt']) {
    assert.equal(secretProblem(token), null, token);
  }
  assert.throws(() => loadConfig({ APP_ENV: 'development', SERVER_SECRET: 'abcdefghijklmnopqrstuvwxyz0123456789' }), /SERVER_SECRET is refused/);
  for (const hops of ['99', '4', '10']) assert.throws(() => loadConfig({ APP_ENV: 'development', TRUST_PROXY: hops }), /at most 3 proxy hops/, hops);
  assert.equal(loadConfig({ APP_ENV: 'development', TRUST_PROXY: '3' }).trustProxy, 3);
  assert.throws(() => loadConfig({ APP_ENV: 'development', STAFF_EMAIL_DOMAINS: 'not a domain' }), /STAFF_EMAIL_DOMAINS/);
  assert.deepEqual(loadConfig({ APP_ENV: 'development', STAFF_EMAIL_DOMAINS: '@GlobalConnect.co.uk, globalconnect.example' }).staffEmailDomains, ['globalconnect.co.uk', 'globalconnect.example']);
});

// --- Mutants that had survived --------------------------------------------------------------------------

test('survivor: a password is counted BEFORE it is checked: forty simultaneous guesses cost five hashes, not forty', async () => {
  h = await harness();
  await h.activate(AMIRA);
  const before = passwordWork.hashes;
  const replies = await Promise.all(Array.from({ length: 40 }, () => login(AMIRA, 'wrong password here')));
  assert.equal(replies.filter((reply) => reply.status === 400).length, 5);
  assert.equal(passwordWork.hashes - before, 5, 'only the attempts that were allowed may reach the hash');
  // Staff too.
  const user = await h.opsAuth.createUser('s@globalconnect.example', 'S', 'ops');
  const { activationCode } = await h.opsAuth.createInvite(user.id);
  const enrol = await h.opsAuth.activationPassword(activationCode, OPS_PASSWORD);
  await h.opsAuth.activationConfirm(activationCode, h.code(enrol.secret), '127.0.0.1');
  const staffBefore = passwordWork.hashes;
  await Promise.allSettled(Array.from({ length: 40 }, () => h.opsAuth.login('s@globalconnect.example', 'wrong password here', '127.0.0.1')));
  assert.equal(passwordWork.hashes - staffBefore, 5);
});

test('survivor: a request is decided once and only while it is pending and unexpired, even when decisions race or time passes mid-request', async () => {
  let expireDuring: string | null = null;
  h = await harness({}, undefined, {
    storeLatency: true,
    // "Time passes mid-request": the clock jumps a day at the moment the approver's code is being burnt.
    storeHook: (operation) => {
      if (expireDuring && operation === expireDuring) {
        expireDuring = null;
        h.clock.advance(24 * 60 * 60_000);
      }
    },
  });
  const admin = await staff('admin@globalconnect.example', 'ops_admin');
  const one = await staff('one@globalconnect.example', 'ops');
  const two = await staff('two@globalconnect.example', 'ops');
  const ask = async () => idOf((await admin.act('/ops/users/usr_ben/activation-link')).location);

  // Two approvals of one request at the same moment: carried out once.
  const raced = await ask();
  const codes = [h.freshCode(one.secret), h.code(two.secret)];
  const [a, b] = await Promise.all([one.browser.post(`/ops/approvals/${raced}/approve`, { code: codes[0] as string }), two.browser.post(`/ops/approvals/${raced}/approve`, { code: codes[1] as string })]);
  assert.deepEqual([a.status, b.status].sort(), [303, 409]);
  assert.equal(h.outbox.sent.length, 1);
  assert.equal((await audit('ops.client.activation_link')).filter((entry) => entry.outcome === 'success').length, 1);
  // An approval and a rejection at the same moment: one of them, never both.
  const mixed = await ask();
  const [c, d] = await Promise.all([one.browser.post(`/ops/approvals/${mixed}/approve`, { code: h.freshCode(one.secret) }), two.browser.post(`/ops/approvals/${mixed}/reject`, { code: h.freshCode(two.secret) })]);
  assert.deepEqual([c.status, d.status].sort(), [303, 409]);
  const status = (await h.stores.ops.approvals.get(mixed))?.status;
  assert.equal(h.outbox.sent.length, status === 'approved' ? 2 : 1);

  // The request runs out while the approval is in progress (after the page checked it, before the decision is written).
  const sent = h.outbox.sent.length;
  const late = await ask();
  const fresh = h.freshCode(one.secret);
  expireDuring = 'update';
  const reply = await one.browser.post(`/ops/approvals/${late}/approve`, { code: fresh });
  assert.equal(reply.status, 409);
  assert.equal(h.outbox.sent.length, sent);
  assert.notEqual((await h.stores.ops.approvals.get(late))?.status, 'approved');
});

test('survivor: a company change is checked again when it is approved, not only when it was asked for', async () => {
  h = await harness();
  const admin = await staff('admin@globalconnect.example', 'ops_admin');
  const boss = await staff('boss@globalconnect.example', 'ops_admin');
  // Two requests for the same free account, both fine when made.
  const repoint = await admin.act('/ops/companies/co_castlebrook', { name: 'Castlebrook Imports Ltd', provider: 'provider-b', providerAccountId: 'S00003' });
  const create = await admin.act('/ops/companies', { name: 'Harbour Ltd', provider: 'provider-b', providerAccountId: 'S00003' });
  assert.equal((await boss.act(`/ops/approvals/${idOf(create.location)}/approve`)).status, 303);
  // The first can no longer be carried out: the account now belongs to another company.
  assert.equal((await boss.act(`/ops/approvals/${idOf(repoint.location)}/approve`)).status, 409);
  assert.equal((await h.stores.directory.getCompany('co_castlebrook'))?.providerAccountId, 'S00001');
  assert.equal((await h.stores.ops.approvals.get(idOf(repoint.location)))?.status, 'pending');
  // And a request approved for a requester who is no longer an ops admin does not re-point anything.
  const again = await admin.act('/ops/companies/co_castlebrook', { name: 'Castlebrook Imports Ltd', provider: 'provider-b', providerAccountId: 'S00002' });
  await h.stores.ops.users.update(admin.id, (user) => ({ ...user, role: 'ops' }));
  assert.equal((await boss.act(`/ops/approvals/${idOf(again.location)}/approve`)).status, 409);
  assert.equal((await h.stores.directory.getCompany('co_castlebrook'))?.providerAccountId, 'S00001');
});

test('survivor: a step-up permission does not survive a change of company, even after switching back', async () => {
  h = await harness();
  const dana = await signedIn(DANA);
  const select = (companyId: string) => h.call('POST', '/v1/session/company', { token: dana.token, body: { companyId } });
  await select('co_northfield');
  const pending = (await h.call('GET', '/v1/approvals', { token: dana.token })).json.items[0].payment.id as string;
  const stepUp = await h.stepUp(dana.token, dana.secret, 'payment.approve', { paymentId: pending });
  await select('co_castlebrook');
  await select('co_northfield');
  const reply = await h.call('POST', `/v1/payments/${pending}/approve`, { token: dana.token, headers: { 'x-step-up-token': stepUp } });
  assert.equal(reply.status, 403);
  assert.equal(reply.json.error.reason, 'step_up_invalid');
  assert.ok((await h.call('GET', '/v1/approvals', { token: dana.token })).json.items.some((row: any) => row.payment.id === pending));
});

test('survivor: a disabled or de-activated staff member is refused on every request, whatever happened to their session', async () => {
  h = await harness();
  const one = await staff('one@globalconnect.example', 'ops_admin');
  assert.equal((await one.browser.get('/ops/users')).status, 200);
  // Disabled directly in the store: the session row is still there.
  await h.stores.ops.users.update(one.id, (user) => ({ ...user, disabledAt: 1 }));
  assert.equal(await h.stores.ops.sessions.count(() => true), 1);
  assert.equal((await one.browser.get('/ops/users')).status, 303);
  assert.equal((await one.act('/ops/users/usr_amira/disable')).status, 401);
  assert.equal((await h.stores.directory.getUser('usr_amira'))?.disabledAt ?? null, null);
  assert.equal(await h.stores.ops.sessions.count(() => true), 0, 'and the session is removed');
  const two = await staff('two@globalconnect.example', 'ops_admin');
  await h.stores.ops.users.update(two.id, (user) => ({ ...user, activatedAt: null }));
  assert.equal((await two.browser.get('/ops/users')).status, 303);
});

test('survivor: the console takes its session from its cookie only, and the client API from the Authorization header only', async () => {
  h = await harness();
  const one = await staff('one@globalconnect.example', 'ops_admin');
  const opsToken = one.browser.cookies.get('gc_ops_session') as string;
  const amira = await signedIn(AMIRA);
  // A VALID staff session token is nothing when it arrives as a bearer token, a query parameter or another cookie.
  for (const headers of [{ authorization: `Bearer ${opsToken}` }, { authorization: opsToken }, { cookie: `session=${opsToken}; token=${opsToken}; gc_ops_pre=${opsToken}` }, { 'x-session-token': opsToken }]) {
    for (const url of ['/ops/users', '/ops/audit', `/ops/users?gc_ops_session=${opsToken}`]) {
      const reply = await h.app.inject({ method: 'GET', url, headers });
      assert.equal(reply.statusCode, 303, `${url} ${JSON.stringify(Object.keys(headers))}`);
    }
    const post = await h.app.inject({ method: 'POST', url: '/ops/users/usr_amira/disable', headers: { ...headers, 'content-type': 'application/x-www-form-urlencoded' }, payload: `_csrf=${one.browser.csrf}&code=${h.code(one.secret)}` });
    assert.equal(post.statusCode, 401);
  }
  assert.equal((await h.app.inject({ method: 'GET', url: '/ops/users', headers: { cookie: `gc_ops_session=${opsToken}` } })).statusCode, 200);
  // A VALID client session token is nothing when it arrives as a cookie (a browser would send that by itself) or in the query.
  const disguises: Record<string, string>[] = [{ cookie: `gc_ops_session=${amira.token}` }, { cookie: `session=${amira.token}; token=${amira.token}; authorization=${amira.token}; Authorization=Bearer ${amira.token}` }, { 'x-auth-token': amira.token }];
  for (const headers of disguises) {
    for (const url of ['/v1/balances', '/v1/company', `/v1/balances?token=${amira.token}&access_token=${amira.token}`]) {
      assert.equal((await h.call('GET', url, { headers })).status, 401, `${url} ${JSON.stringify(Object.keys(headers))}`);
    }
    assert.equal((await h.call('POST', '/v1/auth/logout', { headers })).status, 200);
  }
  assert.equal((await h.call('GET', '/v1/balances', { token: amira.token })).status, 200, 'still signed in: none of those ended the session');
});
