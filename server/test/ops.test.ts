import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'node:test';

import { assertStaffRemovalAllowed, OpsError } from '../src/ops/console';
import { createFileStores } from '../src/store/file';
import { seedDirectory } from '../src/store/seed';
import type { OpsRole } from '../src/store/types';
import { ADMIN_TOKEN, AMIRA, BEN, DANA, harness, PASSWORD, type Harness } from './helpers';

let h: Harness;
afterEach(async () => h?.close());

const OPS_PASSWORD = 'staff horse battery staple';

/** A browser, as far as the console can tell: a cookie jar and the CSRF field of the last page. */
class Browser {
  cookies = new Map<string, string>();
  csrf = '';
  /** Every page body this browser received. */
  pages: string[] = [];
  setCookies: string[] = [];

  async request(method: 'GET' | 'POST', url: string, form?: Record<string, string>, headers: Record<string, string> = {}) {
    const cookie = [...this.cookies].map(([name, value]) => `${name}=${value}`).join('; ');
    const response = await h.app.inject({
      method,
      url,
      headers: { ...(cookie ? { cookie } : {}), ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}), ...headers },
      ...(form ? { payload: new URLSearchParams(form).toString() } : {}),
    });
    for (const line of [response.headers['set-cookie'] ?? []].flat()) {
      this.setCookies.push(line);
      const [pair = ''] = line.split(';');
      const at = pair.indexOf('=');
      if (/Max-Age=0/.test(line)) this.cookies.delete(pair.slice(0, at));
      else this.cookies.set(pair.slice(0, at), pair.slice(at + 1));
    }
    this.pages.push(response.body);
    const csrf = /name="_csrf" value="([^"]+)"/.exec(response.body);
    if (csrf?.[1]) this.csrf = csrf[1];
    return { status: response.statusCode, body: response.body, headers: response.headers, location: String(response.headers.location ?? '') };
  }
  get(url: string) {
    return this.request('GET', url);
  }
  /** A form post carrying the CSRF field, as the page's own form would. */
  post(url: string, form: Record<string, string> = {}, headers: Record<string, string> = {}) {
    return this.request('POST', url, { _csrf: this.csrf, ...form }, headers);
  }
}

interface Staff {
  browser: Browser;
  id: string;
  email: string;
  secret: string;
  recoveryCodes: string[];
  /** POST an action with a fresh authenticator code. */
  act: (url: string, form?: Record<string, string>) => ReturnType<Browser['post']>;
}

async function activateStaff(email: string, role: OpsRole, password = OPS_PASSWORD): Promise<Omit<Staff, 'act'>> {
  const user = (await h.stores.ops.users.findByEmail(email)) ?? (await h.opsAuth.createUser(email, 'Staff Person', role));
  const { activationCode } = await h.opsAuth.createInvite(user.id);
  const browser = new Browser();
  assert.equal((await browser.get('/ops/activate')).status, 200);
  assert.match((await browser.post('/ops/activate', { activationCode })).body, /Choose a password/);
  const enrol = await browser.post('/ops/activate/password', { activationCode, password });
  assert.match(enrol.body, /<svg class="qr"/);
  const secret = /<p class="secret">([A-Z2-7]+)<\/p>/.exec(enrol.body)?.[1] ?? '';
  assert.ok(secret.length >= 32);
  const done = await browser.post('/ops/activate/confirm', { activationCode, code: h.code(secret) });
  assert.equal(done.status, 200);
  const recoveryCodes = [...done.body.matchAll(/<li>([A-Z2-7-]+)<\/li>/g)].map((match) => match[1] as string);
  assert.equal(recoveryCodes.length, 10);
  assert.match(recoveryCodes[0] as string, /^[A-Z2-7]{5}(-[A-Z2-7]{5}){3}$/);
  return { browser, id: user.id, email, secret, recoveryCodes };
}

async function signIn(browser: Browser, email: string, secret: string, password = OPS_PASSWORD) {
  await browser.get('/ops/login');
  const first = await browser.post('/ops/login', { email, password });
  const challengeId = /name="challengeId" value="([^"]+)"/.exec(first.body)?.[1];
  if (!challengeId) return first;
  return browser.post('/ops/login/verify', { challengeId, code: h.freshCode(secret), method: 'totp' });
}

async function staff(email = 'admin@globalconnect.example', role: OpsRole = 'ops_admin'): Promise<Staff> {
  const account = await activateStaff(email, role);
  const reply = await signIn(account.browser, email, account.secret);
  assert.equal(reply.status, 303, reply.body);
  assert.equal(reply.location, '/ops');
  await account.browser.get('/ops/users');
  return { ...account, act: (url, form = {}) => account.browser.post(url, { ...form, code: h.freshCode(account.secret) }) };
}

const audit = (action?: string) => h.stores.audit.query({ action, limit: 10_000 });
const idOf = (location: string) => /\/(?:users|companies|staff|approvals)\/([\w-]+)/.exec(location)?.[1] ?? '';
/** Anything that looks like an activation code or link. No console page may ever contain one. */
const LINK_OR_CODE = /[A-Z2-7]{5}-[A-Z2-7]{5}-[A-Z2-7]{5}-[A-Z2-7]{5}|code=|\/activate[#?]/;

/** Activate a client through the client API with the code that was EMAILED to them. */
async function activateClient(email: string, password = PASSWORD) {
  const activationCode = h.mailedCode(email);
  const enrol = await h.call('POST', '/v1/activation/password', { body: { activationCode, password } });
  assert.equal(enrol.status, 200);
  const confirm = await h.call('POST', '/v1/activation/confirm', { body: { activationCode, code: h.code(enrol.json.secret) } });
  assert.equal(confirm.status, 200);
  return { secret: enrol.json.secret as string, recoveryCodes: confirm.json.recoveryCodes as string[], activationCode };
}

/** One staff member asks, a different one approves. Returns the approver's reply and the request id. */
async function fourEyes(requester: Staff, approver: Staff, url: string, form: Record<string, string> = {}) {
  const asked = await requester.act(url, form);
  assert.equal(asked.status, 303, `${url}: ${asked.body.slice(-300)}`);
  assert.match(asked.location, /^\/ops\/approvals\/req_[\w-]+\?done=requested$/, url);
  const id = idOf(asked.location);
  const approved = await approver.act(`/ops/approvals/${id}/approve`);
  assert.equal(approved.status, 303, `approve ${url}: ${approved.body.slice(-300)}`);
  return { id, approved, record: await h.stores.ops.approvals.get(id) };
}

/** Two ops admins, both signed in: between them they can ask for and approve anything. */
async function pair(): Promise<{ admin: Staff; second: Staff }> {
  return { admin: await staff(), second: await staff('second@globalconnect.example', 'ops_admin') };
}
/** An ops admin and an ops USER. */
async function adminAndOps(): Promise<{ admin: Staff; second: Staff }> {
  return { admin: await staff(), second: await staff('olu@globalconnect.example', 'ops') };
}

test('ops: activation, sign-in, cookie and security headers, uniform errors, lockout, idle timeout', async () => {
  h = await harness();
  const admin = await staff();
  const session = admin.browser.setCookies.find((line) => line.startsWith('gc_ops_session=') && !/Max-Age=0/.test(line)) ?? '';
  assert.match(session, /; Path=\/ops; HttpOnly; SameSite=Strict$/);

  const page = await admin.browser.get('/ops/users');
  assert.equal(page.status, 200);
  const csp = String(page.headers['content-security-policy']);
  assert.match(csp, /script-src 'self'/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.doesNotMatch(csp, /unsafe-inline/);
  assert.equal(page.headers['cache-control'], 'no-store');
  assert.doesNotMatch(page.body, /<script>|style="|onclick=|https?:\/\/(?!localhost)/);

  // Unknown email, wrong password and an account that is not activated answer identically.
  await h.opsAuth.createUser('pending@globalconnect.example', 'Pending', 'ops');
  const answers = [];
  for (const [email, password] of [['nobody@globalconnect.example', OPS_PASSWORD], [admin.email, 'wrong password here'], ['pending@globalconnect.example', OPS_PASSWORD]] as const) {
    const visitor = new Browser();
    await visitor.get('/ops/login');
    const reply = await visitor.post('/ops/login', { email, password });
    answers.push([reply.status, reply.body.replace(/value="[^"]+"/g, '')]);
  }
  assert.equal(answers[0]?.[0], 400);
  assert.deepEqual(answers[1], answers[0]);
  assert.deepEqual(answers[2], answers[0]);

  // A used code cannot be replayed at sign-in, and the message says how long until the next one.
  const again = new Browser();
  await again.get('/ops/login');
  const first = await again.post('/ops/login', { email: admin.email, password: OPS_PASSWORD });
  const challengeId = /name="challengeId" value="([^"]+)"/.exec(first.body)?.[1] ?? '';
  const replay = await again.post('/ops/login/verify', { challengeId, code: h.code(admin.secret), method: 'totp' });
  assert.match(replay.body, /already been used/);
  assert.match(replay.body, /new code in about \d+ seconds/);

  // Lockout: after 5 wrong passwords even the right one is refused.
  const visitor = new Browser();
  await visitor.get('/ops/login');
  for (let attempt = 0; attempt < 5; attempt += 1) await visitor.post('/ops/login', { email: admin.email, password: 'wrong password here' });
  const locked = await visitor.post('/ops/login', { email: admin.email, password: OPS_PASSWORD });
  assert.equal(locked.status, 429);
  assert.ok((await audit('ops.lockout')).length >= 1);

  // 10 minutes idle ends the session.
  h.clock.advance(10 * 60_000 + 1);
  const expired = await admin.browser.get('/ops/users');
  assert.equal(expired.status, 303);
  assert.equal(expired.location, '/ops/login');
});

test('ops cookie: over https it is __Host-, Secure, with HSTS; a recovery code signs in once', async () => {
  h = await harness({ opsUrl: 'https://ops.globalconnect.example' });
  const account = await activateStaff('admin@globalconnect.example', 'ops_admin');
  for (const expected of [303, 400]) {
    const browser = new Browser();
    const page = await browser.get('/ops/login');
    assert.equal(page.headers['strict-transport-security'], 'max-age=31536000');
    assert.match(browser.setCookies[0] ?? '', /^__Host-gc_ops_pre=[\w.-]+; Path=\/; HttpOnly; SameSite=Strict; Secure$/);
    const first = await browser.post('/ops/login', { email: account.email, password: OPS_PASSWORD });
    const challengeId = /name="challengeId" value="([^"]+)"/.exec(first.body)?.[1] ?? '';
    const reply = await browser.post('/ops/login/verify', { challengeId, code: account.recoveryCodes[0] as string, method: 'recovery' });
    assert.equal(reply.status, expected);
    if (expected === 303) {
      assert.match(browser.setCookies.find((line) => line.startsWith('__Host-gc_ops_session=')) ?? '', /^__Host-gc_ops_session=[\w-]+; Path=\/; HttpOnly; SameSite=Strict; Secure$/);
      assert.equal((await browser.get('/ops/users')).status, 200);
    }
  }
  // On plain http (development on localhost) there is no HSTS and no prefix.
  await h.close();
  h = await harness();
  assert.equal((await new Browser().get('/ops/login')).headers['strict-transport-security'], undefined);
});

test('ops: roles. ops manages clients but not staff or company mappings, and cannot approve them; ops_admin does', async () => {
  h = await harness();
  const { admin, second: olu } = await adminAndOps();
  assert.equal((await olu.browser.get('/ops/staff')).status, 403);
  assert.equal((await olu.browser.get(`/ops/staff/${admin.id}`)).status, 403);
  assert.equal((await olu.browser.get('/ops/companies/new')).status, 403);
  assert.doesNotMatch((await olu.browser.get('/ops/users')).body, /href="\/ops\/staff"/);
  const newCompany = { name: 'Harbour Ltd', provider: 'provider-b', providerAccountId: 'S00002' };
  for (const [url, form] of [
    ['/ops/staff', { name: 'X Y', email: 'x@globalconnect.example', role: 'ops_admin' }],
    [`/ops/staff/${olu.id}/role`, { role: 'ops_admin' }],
    [`/ops/staff/${admin.id}/disable`, {}],
    [`/ops/staff/${admin.id}/reset-authenticator`, { verification: 'verified in person at the office' }],
    ['/ops/companies', newCompany],
    // Re-pointing an existing company at another account.
    ['/ops/companies/co_castlebrook', { name: 'Castlebrook Imports Ltd', provider: 'provider-b', providerAccountId: 'S00002' }],
  ] as const) {
    assert.equal((await olu.act(url, form)).status, 403, url);
  }
  assert.equal((await h.stores.ops.users.list()).length, 2);
  assert.equal((await h.stores.ops.users.get(olu.id))?.role, 'ops');
  assert.equal((await h.stores.directory.listCompanies()).length, 2);
  assert.equal((await h.stores.directory.getCompany('co_castlebrook'))?.providerAccountId, 'S00001');
  assert.equal((await h.stores.ops.approvals.list()).length, 0);
  const refused = (await audit()).filter((entry) => entry.outcome === 'failure' && entry.detail.reason === 'forbidden' && entry.actor.id === olu.id);
  assert.equal(refused.length, 6);
  // A refused action is logged against what it was aimed at.
  assert.ok(refused.some((entry) => entry.action === 'ops.company.edit' && entry.target?.id === 'co_castlebrook'));

  // N3: an ops USER cannot be the second pair of eyes for staff management or for a company's mapping.
  const boss = await staff('boss@globalconnect.example', 'ops_admin');
  const requests: string[] = [];
  for (const [url, form] of [
    ['/ops/staff', { name: 'New Person', email: 'new.person@globalconnect.example', role: 'ops_admin' }],
    [`/ops/staff/${boss.id}/role`, { role: 'ops' }],
    [`/ops/staff/${boss.id}/disable`, {}],
    [`/ops/staff/${boss.id}/reset-authenticator`, { verification: 'verified in person at the office' }],
    [`/ops/staff/${boss.id}/unlock`, {}],
    ['/ops/companies', newCompany],
    ['/ops/companies/co_castlebrook', { name: 'Castlebrook Imports Ltd', provider: 'provider-b', providerAccountId: 'S00003' }],
  ] as const) {
    const asked = await admin.act(url, form);
    assert.match(asked.location, /^\/ops\/approvals\//, url);
    const id = idOf(asked.location);
    requests.push(id);
    const page = (await olu.browser.get(`/ops/approvals/${id}`)).body;
    assert.match(page, /Only an ops admin can approve this kind of request/);
    assert.doesNotMatch(page, new RegExp(`action="/ops/approvals/${id}/approve"`));
    const tried = await olu.act(`/ops/approvals/${id}/approve`);
    assert.equal(tried.status, 403, url);
  }
  assert.equal((await h.stores.ops.users.list()).length, 3);
  assert.equal((await h.stores.ops.users.get(olu.id))?.role, 'ops');
  assert.equal((await h.stores.ops.users.get(boss.id))?.disabledAt, null);
  assert.equal((await h.stores.directory.listCompanies()).length, 2);
  assert.equal((await h.stores.directory.getCompany('co_castlebrook'))?.providerAccountId, 'S00001');
  assert.equal(h.outbox.sent.length, 0);
  assert.equal((await audit('ops.approval.approve')).filter((entry) => entry.outcome === 'failure' && entry.detail.reason === 'admin_approval').length, 7);
  // The other ops admin can. (boss cannot approve the two requests that are about boss.)
  assert.equal((await boss.act(`/ops/approvals/${requests[5]}/approve`)).status, 303);
  assert.equal((await h.stores.directory.listCompanies()).length, 3);
  assert.equal((await boss.act(`/ops/approvals/${requests[2]}/approve`)).status, 403);

  // What an ops user CAN do: act on clients, and ask for a rename, which any other staff member may approve.
  assert.equal((await olu.act('/ops/users/usr_ben/disable')).status, 303);
  const rename = await olu.act('/ops/companies/co_northfield', { name: 'Northfield Trading Limited', provider: 'provider-a', providerAccountId: 'sample-account-0001', providerContactId: 'sample-contact-0001' });
  assert.match(rename.location, /^\/ops\/approvals\//);
  assert.equal((await h.stores.directory.getCompany('co_northfield'))?.name, 'Northfield Trading Ltd');
  assert.equal((await admin.act(`/ops/approvals/${idOf(rename.location)}/approve`)).status, 303);
  assert.equal((await h.stores.directory.getCompany('co_northfield'))?.name, 'Northfield Trading Limited');
});

test('ops: every action needs a fresh code and is written to the audit log', async () => {
  h = await harness();
  await h.activate(AMIRA);
  const { admin, second } = await pair();
  const third = await activateStaff('third@globalconnect.example', 'ops');
  const pending = await h.opsAuth.createUser('pending@globalconnect.example', 'Pending', 'ops');
  const ben = (await h.stores.directory.findUserByEmail(BEN))?.id as string;
  const location = (reply: { location: string }) => idOf(reply.location);
  // Three requests waiting: two made by the second staff member (to approve and to reject), one by the admin (to cancel).
  const toApprove = location(await second.act('/ops/users/usr_dana/activation-link'));
  const toReject = location(await second.act('/ops/users/usr_dana/memberships', { companyId: 'co_northfield', role: 'creator' }));
  const toCancel = location(await admin.act('/ops/users/usr_dana/memberships', { companyId: 'co_castlebrook', role: 'creator' }));
  assert.ok(toApprove && toReject && toCancel);

  const actions = h.opsRoutes.filter((route) => route.method === 'POST' && !/^\/ops\/(login|logout|activate)/.test(route.url));
  assert.ok(actions.length >= 23, `only ${actions.length} action routes`);
  const urlOf = (route: string) =>
    route.startsWith('/ops/approvals')
      ? route.replace(':id', route.endsWith('approve') ? toApprove : route.endsWith('reject') ? toReject : toCancel)
      : route.replace(':id', route.startsWith('/ops/companies') ? 'co_castlebrook' : route.startsWith('/ops/staff') ? (route.includes('reset') ? third.id : pending.id) : route.includes('reset') ? 'usr_amira' : ben);
  const formOf = (route: string, n: number): Record<string, string> => ({
    name: route === '/ops/companies/:id' ? 'Castlebrook Imports Ltd' : 'Tideway Ltd',
    // Staff must be at an allowed staff domain; clients are wherever they are.
    email: route === '/ops/staff' ? `person${n}@globalconnect.example` : `person${n}@tideway.example`,
    // Creating takes a free provider A account; editing re-points Castlebrook to a free provider B account.
    ...(route === '/ops/companies/:id' ? { provider: 'provider-b', providerAccountId: 'S00003' } : { provider: 'provider-a', providerAccountId: 'sample-account-0002', providerContactId: 'sample-contact-0002' }),
    company1: 'co_northfield',
    role1: 'creator',
    companyId: 'co_northfield',
    role: route.startsWith('/ops/staff') ? 'ops' : 'approver',
    verification: 'Called back on the number on file',
  });
  const state = async () =>
    JSON.stringify([
      await h.stores.directory.listUsers(),
      await h.stores.directory.listCompanies(),
      await h.stores.directory.listMemberships(),
      (await h.stores.ops.users.list()).filter((user) => user.id !== admin.id),
      await h.stores.ops.approvals.list(),
      h.outbox.sent.length,
    ]);
  const stepUpFailures = async () => (await audit('ops.step_up')).filter((entry) => entry.outcome === 'failure').length;

  // Without a code, with a wrong code and with a reused code: refused, nothing changes, the refusal is logged.
  for (const route of actions) {
    for (const code of ['', '000000', h.code(admin.secret)]) {
      const before = await state();
      const failures = await stepUpFailures();
      // Wrong codes would lock the account; this test is about each refusal, not the lockout.
      await h.stores.ops.attempts.deleteWhere(() => true);
      const reply = await admin.browser.post(urlOf(route.url), { ...formOf(route.url, 0), code });
      assert.equal(reply.status, 400, `${route.url} with code "${code}": ${reply.body.slice(-200)}`);
      assert.equal(await state(), before, route.url);
      assert.equal(await stepUpFailures(), failures + 1, route.url);
    }
  }

  // With a fresh code each one is done, or becomes a request that the second staff member approves; both leave entries.
  const done = async () => (await audit()).filter((entry) => entry.outcome === 'success' && /^ops\.(company|client|staff|approval)\./.test(entry.action));
  let n = 0;
  const viaApproval: string[] = [];
  for (const route of actions) {
    n += 1;
    const before = (await done()).length;
    await second.browser.get('/ops/approvals');
    const reply = await admin.act(urlOf(route.url), formOf(route.url, n));
    assert.equal(reply.status, 303, `${route.url} -> ${reply.status} ${reply.body.slice(-400)}`);
    const entries = await done();
    assert.equal(entries.length, before + (route.url.endsWith('/approve') ? 2 : 1), route.url);
    assert.equal(entries[0]?.source, '127.0.0.1');
    if (!route.url.startsWith('/ops/approvals') && reply.location.startsWith('/ops/approvals/')) {
      // Nothing happened yet: only a request exists.
      assert.equal(entries[0]?.action, 'ops.approval.request');
      assert.equal(entries[0]?.actor.id, admin.id);
      const approved = await second.act(`/ops/approvals/${location(reply)}/approve`);
      assert.equal(approved.status, 303, `approve ${route.url}: ${approved.body.slice(-300)}`);
      const [approval, carriedOut] = await done();
      // Both people are on both entries.
      assert.equal(approval?.action, 'ops.approval.approve');
      assert.equal(approval?.actor.id, second.id);
      assert.equal(approval?.detail.requestedBy, admin.email);
      assert.equal(carriedOut?.actor.id, admin.id);
      assert.equal(carriedOut?.detail.approvedBy, second.email);
      viaApproval.push(carriedOut?.action ?? '');
    }
  }
  assert.deepEqual(viaApproval.sort(), [
    'ops.client.activation_link', 'ops.client.create', 'ops.client.enable', 'ops.client.membership.set', 'ops.client.reset_authenticator', 'ops.company.create', 'ops.company.edit', 'ops.company.reactivate',
    'ops.staff.activation_link', 'ops.staff.disable', 'ops.staff.enable', 'ops.staff.invite', 'ops.staff.reset_authenticator', 'ops.staff.role', 'ops.staff.unlock',
  ]);
  const names = new Set((await audit()).map((entry) => entry.action));
  for (const name of ['ops.company.deactivate', 'ops.client.membership.remove', 'ops.client.unlock', 'ops.client.revoke_sessions', 'ops.client.disable', 'ops.staff.new', 'ops.approval.reject', 'ops.approval.cancel', 'ops.step_up', 'client.session_revoked', 'ops.session_revoked']) {
    assert.ok(names.has(name), `no audit entry for ${name}`);
  }
  const reset = (await audit('ops.client.reset_authenticator')).find((entry) => entry.outcome === 'success');
  assert.equal(reset?.detail.identityVerification, 'Called back on the number on file');
  assert.equal(reset?.target?.label, AMIRA);
  // A refusal after the target was known is logged against that target.
  const refusal = (await audit('ops.client.unlock')).find((entry) => entry.outcome === 'failure');
  assert.equal(refusal?.target?.label, BEN);
});

test('ops: CSRF. A post without the field, with a wrong field or from another site is refused; the pre-login anchor is the server\'s own', async () => {
  h = await harness();
  const { admin, second: other } = await pair();
  const form = { name: 'Tideway Ltd', provider: 'provider-b', providerAccountId: 'S00002' };
  const code = () => h.freshCode(admin.secret);
  const nothingChanged = async () => assert.equal((await h.stores.directory.listCompanies()).length + (await h.stores.ops.approvals.list()).length, 2);

  assert.equal((await admin.browser.request('POST', '/ops/companies', { ...form, code: code() })).status, 403);
  assert.equal((await admin.browser.request('POST', '/ops/companies', { ...form, code: code(), _csrf: 'f'.repeat(64) })).status, 403);
  // Another session's field does not fit this session.
  assert.equal((await admin.browser.request('POST', '/ops/companies', { ...form, code: code(), _csrf: other.browser.csrf })).status, 403);
  assert.equal((await admin.browser.post('/ops/companies', { ...form, code: code() }, { 'sec-fetch-site': 'cross-site' })).status, 403);
  assert.equal((await admin.browser.request('POST', '/ops/logout', {})).status, 403);
  await nothingChanged();

  // Before sign-in too.
  const visitor = new Browser();
  await visitor.get('/ops/login');
  assert.equal((await visitor.request('POST', '/ops/login', { email: admin.email, password: OPS_PASSWORD })).status, 403);
  assert.equal((await new Browser().request('POST', '/ops/login', { email: admin.email, password: OPS_PASSWORD, _csrf: visitor.csrf })).status, 403);
  // An anchor cookie the server never issued anchors nothing, even with the field that matches it (a planted cookie).
  const planted = new Browser();
  planted.cookies.set('gc_ops_pre', 'A'.repeat(43));
  const { createHash } = await import('node:crypto');
  const matching = createHash('sha256').update(`ops-csrf:${'A'.repeat(43)}`).digest('hex');
  assert.equal((await planted.request('POST', '/ops/login', { email: admin.email, password: OPS_PASSWORD, _csrf: matching })).status, 403);
  // And the server's own anchor stops working after half an hour.
  h.clock.advance(31 * 60_000);
  assert.equal((await visitor.post('/ops/login', { email: admin.email, password: OPS_PASSWORD })).status, 403);

  // The real form still works.
  const fresh = await staff('fresh@globalconnect.example', 'ops_admin');
  assert.equal((await fresh.browser.post('/ops/companies', { ...form, code: h.freshCode(fresh.secret) }, { 'sec-fetch-site': 'same-origin' })).status, 303);
  assert.equal((await fresh.browser.post('/ops/logout')).status, 303);
  assert.equal((await fresh.browser.get('/ops/users')).status, 303);
  assert.equal((await audit('ops.sign_out')).length, 1);
});

test('separation: a client session never works on /ops and an ops session never works on the client API', async () => {
  h = await harness();
  const { secret } = await h.activate(AMIRA);
  const clientToken = (await h.login(AMIRA, secret)).json.token as string;
  const admin = await staff();
  const opsToken = admin.browser.cookies.get('gc_ops_session') as string;
  assert.equal((await h.call('GET', '/v1/balances', { token: clientToken })).status, 200);

  // Client token as the ops cookie, and as a bearer token, on ops pages and actions.
  for (const headers of [{ cookie: `gc_ops_session=${clientToken}` }, { authorization: `Bearer ${clientToken}` }, { cookie: `gc_ops_session=${clientToken}`, authorization: `Bearer ${clientToken}` }]) {
    for (const url of ['/ops/users', '/ops/companies', '/ops/audit', '/ops/staff', '/ops/approvals', '/ops/users/usr_amira']) {
      const reply = await h.app.inject({ method: 'GET', url, headers });
      assert.equal(reply.statusCode, 303, url);
      assert.equal(reply.headers.location, '/ops/login');
    }
    const post = await h.app.inject({ method: 'POST', url: '/ops/users/usr_amira/disable', headers: { ...headers, 'content-type': 'application/x-www-form-urlencoded' }, payload: 'code=123456' });
    assert.equal(post.statusCode, 401);
  }
  assert.equal((await h.stores.directory.getUser('usr_amira'))?.disabledAt ?? null, null);

  // Ops token as a bearer token, and as a cookie, on the client API.
  for (const url of ['/v1/balances', '/v1/company', '/v1/payments?page=1&perPage=5', '/v1/transactions?page=1&perPage=5']) {
    assert.equal((await h.call('GET', url, { token: opsToken })).status, 401, url);
    assert.equal((await h.call('GET', url, { headers: { cookie: `gc_ops_session=${opsToken}` } })).status, 401, url);
  }
  assert.equal((await h.call('POST', '/v1/session/company', { token: opsToken, body: { companyId: 'co_northfield' } })).status, 401);
  // Staff credentials are not client credentials, and the reverse.
  assert.equal((await h.call('POST', '/v1/auth/login', { body: { email: admin.email, password: OPS_PASSWORD } })).status, 400);
  const visitor = new Browser();
  await visitor.get('/ops/login');
  assert.equal((await visitor.post('/ops/login', { email: AMIRA, password: PASSWORD })).status, 400);
  // Both sessions are still fine where they belong.
  assert.equal((await h.call('GET', '/v1/balances', { token: clientToken })).status, 200);
  assert.equal((await admin.browser.get('/ops/users')).status, 200);
});

test('ops: an admin cannot demote, disable or reset themselves, and the last active admin cannot be removed', async () => {
  h = await harness();
  const { admin, second } = await adminAndOps();
  assert.equal((await admin.act(`/ops/staff/${admin.id}/role`, { role: 'ops' })).status, 403);
  assert.equal((await admin.act(`/ops/staff/${admin.id}/disable`)).status, 403);
  assert.equal((await admin.act(`/ops/staff/${admin.id}/reset-authenticator`, { verification: 'it is me, honestly' })).status, 403);
  assert.equal((await h.stores.ops.approvals.list()).length, 0);
  const me = await h.stores.ops.users.get(admin.id);
  assert.equal(me?.role, 'ops_admin');
  assert.equal(me?.disabledAt, null);
  assert.ok(me?.activatedAt);

  // The last-admin rule on its own (through the console it is always also "yourself").
  const target = me as NonNullable<typeof me>;
  await assert.rejects(assertStaffRemovalAllowed(h.stores, 'ops_someone_else', target), (error: unknown) => error instanceof OpsError && error.reason === 'last_admin');
  // An admin who has not activated does not count as a second admin.
  await h.opsAuth.createUser('invited@globalconnect.example', 'Invited', 'ops_admin');
  await assert.rejects(assertStaffRemovalAllowed(h.stores, 'ops_someone_else', target), (error: unknown) => error instanceof OpsError && error.reason === 'last_admin');

  // With a second active admin, one can ask for the other to be disabled; a third person approves.
  const boss = await staff('boss@globalconnect.example', 'ops_admin');
  await assert.doesNotReject(assertStaffRemovalAllowed(h.stores, boss.id, target));
  const asked = await boss.act(`/ops/staff/${admin.id}/disable`);
  const request = idOf(asked.location);
  // The person the request is about cannot approve it, and nor can the person who made it.
  assert.equal((await admin.act(`/ops/approvals/${request}/approve`)).status, 403);
  assert.equal((await boss.act(`/ops/approvals/${request}/approve`)).status, 403);
  assert.equal((await h.stores.ops.users.get(admin.id))?.disabledAt, null);
  // ...and nor can an ops user: disabling staff needs a second ops ADMIN.
  assert.equal((await second.act(`/ops/approvals/${request}/approve`)).status, 403);
  const fourth = await staff('fourth@globalconnect.example', 'ops_admin');
  assert.equal((await fourth.act(`/ops/approvals/${request}/approve`)).status, 303);
  assert.equal((await admin.browser.get('/ops/staff')).status, 303, 'disabling ends the staff session');
  assert.equal((await signIn(new Browser(), admin.email, admin.secret)).status, 400, 'a disabled staff member cannot sign in');
  // Now boss is the last active admin: a request to demote boss cannot even be made by boss.
  assert.equal((await boss.act(`/ops/staff/${boss.id}/role`, { role: 'ops' })).status, 403);
});

test('ops: company and client set up with approval; the link goes by email only; the client sees only that company; reset kills old credentials', async () => {
  h = await harness();
  const { admin, second } = await pair();
  const company = await fourEyes(admin, second, '/ops/companies', { name: 'Tideway Ltd', provider: 'provider-b', providerAccountId: 'S00002' });
  const companyId = (await h.stores.directory.listCompanies()).find((item) => item.name === 'Tideway Ltd')?.id as string;
  assert.equal(company.record?.status, 'approved');
  await fourEyes(second, admin, '/ops/users', { name: 'Chidi Eze', email: 'Chidi@Tideway.example', company1: companyId, role1: 'admin' });
  const userId = (await h.stores.directory.findUserByEmail('chidi@tideway.example'))?.id as string;
  assert.match((await admin.browser.get(`/ops/users/${userId}`)).body, /<dt>Activated<\/dt><dd>No<\/dd>/);
  assert.match((await admin.browser.get('/ops/users?q=chidi')).body, /Chidi Eze/);
  assert.doesNotMatch((await admin.browser.get('/ops/users?q=chidi')).body, /Amira/);
  assert.match((await admin.browser.get(`/ops/companies/${companyId}`)).body, /Provider B \(Equals Money\)/);

  // Issue, then re-issue: each goes to the client's address, and the first link stops working.
  assert.equal(h.outbox.sent.length, 0);
  const first = await fourEyes(admin, second, `/ops/users/${userId}/activation-link`);
  assert.deepEqual(h.outbox.sent.map((message) => message.to), ['chidi@tideway.example']);
  const firstCode = h.mailedCode('chidi@tideway.example');
  const shown = (await second.browser.get(`/ops/approvals/${first.id}`)).body;
  assert.match(shown, /An activation email was sent to c…@tideway\.example/);
  assert.match(shown, /not shown to staff/);
  await fourEyes(second, admin, `/ops/users/${userId}/activation-link`);
  assert.notEqual(h.mailedCode('chidi@tideway.example'), firstCode);
  assert.equal((await h.call('POST', '/v1/activation/start', { body: { activationCode: firstCode } })).status, 400);
  const before = await activateClient('chidi@tideway.example');

  const login = await h.login('chidi@tideway.example', before.secret);
  assert.equal(login.status, 200);
  assert.deepEqual(login.json.companies, [{ id: companyId, name: 'Tideway Ltd' }]);
  assert.deepEqual(login.json.session.company, { id: companyId, name: 'Tideway Ltd' });
  assert.equal((await h.call('POST', '/v1/session/company', { token: login.json.token, body: { companyId: 'co_northfield' } })).status, 404);
  assert.equal((await h.call('GET', '/v1/balances', { token: login.json.token })).status, 200);
  // Nothing the client app received names a provider or the provider account.
  assert.doesNotMatch(h.bodies.join('\n'), /currencycloud|equals|provider-b|S0000\d/i);

  const status = (await admin.browser.get(`/ops/users/${userId}`)).body;
  assert.match(status, /<dt>Activated<\/dt><dd>Yes/);
  assert.match(status, /<dt>Active sessions<\/dt><dd>1<\/dd>/);
  assert.match(status, /<dt>Last sign-in<\/dt><dd>2026-/);
  assert.match(status, /Verify this person’s identity BEFORE resetting/);

  // Reset needs the identity-verification text, and then a second person who is shown it.
  assert.equal((await admin.act(`/ops/users/${userId}/reset-authenticator`, { verification: '' })).status, 400);
  const asked = await admin.act(`/ops/users/${userId}/reset-authenticator`, { verification: 'Video call, passport checked against KYC file' });
  assert.equal((await h.call('GET', '/v1/balances', { token: login.json.token })).status, 200, 'a request alone changes nothing');
  const detail = (await second.browser.get(`/ops/approvals/${idOf(asked.location)}`)).body;
  assert.match(detail, /Video call, passport checked against KYC file/);
  assert.match(detail, /ends every session/);
  assert.equal((await second.act(`/ops/approvals/${idOf(asked.location)}/approve`)).status, 303);

  // Old session, old password, old authenticator and old recovery codes are all dead.
  assert.equal((await h.call('GET', '/v1/balances', { token: login.json.token })).status, 401);
  assert.equal((await h.call('POST', '/v1/auth/login', { body: { email: 'chidi@tideway.example', password: PASSWORD } })).status, 400);
  const record = await h.stores.directory.getUser(userId);
  assert.deepEqual([record?.passwordHash, record?.totpSecret, record?.recoveryCodeHashes, record?.activatedAt], [null, null, [], null]);

  const after = await activateClient('chidi@tideway.example', 'a brand new pass phrase');
  assert.notEqual(after.secret, before.secret);
  assert.equal((await h.call('POST', '/v1/auth/login', { body: { email: 'chidi@tideway.example', password: PASSWORD } })).status, 400, 'the old password is gone');
  for (const [code, method] of [[h.freshCode(before.secret), 'totp'], [before.recoveryCodes[0] as string, 'recovery']] as const) {
    const challenge = await h.call('POST', '/v1/auth/login', { body: { email: 'chidi@tideway.example', password: 'a brand new pass phrase' } });
    assert.equal((await h.call('POST', '/v1/auth/login/verify', { body: { challengeId: challenge.json.challengeId, code, method } })).status, 400, `old ${method} code`);
  }
  assert.equal((await h.login('chidi@tideway.example', after.secret, 'a brand new pass phrase')).status, 200);

  // Deactivating the company takes it away from the client at once.
  const live = await h.login('chidi@tideway.example', after.secret, 'a brand new pass phrase');
  assert.equal((await admin.act(`/ops/companies/${companyId}/deactivate`)).status, 303);
  assert.equal((await h.call('GET', '/v1/balances', { token: live.json.token })).status, 403);
  assert.deepEqual((await h.login('chidi@tideway.example', after.secret, 'a brand new pass phrase')).json.companies, []);
  // No staff page in the whole flow carried a link or a code.
  for (const page of [...admin.browser.pages.slice(8), ...second.browser.pages.slice(8)]) assert.doesNotMatch(page.replace(/name="(code|activationCode)"/g, ''), LINK_OR_CODE);
});

test('ops: disable ends sessions and blocks sign-in and activation; unlock and revoke-all work; removing a membership takes effect', async () => {
  h = await harness();
  const { secret } = await h.activate(AMIRA);
  const { admin, second } = await pair();
  const token = (await h.login(AMIRA, secret)).json.token as string;

  assert.equal((await admin.act('/ops/users/usr_amira/revoke-sessions')).status, 303);
  assert.equal((await h.call('GET', '/v1/balances', { token })).status, 401);

  const again = (await h.login(AMIRA, secret)).json.token as string;
  assert.equal((await admin.act('/ops/users/usr_amira/disable')).status, 303);
  assert.equal((await h.call('GET', '/v1/balances', { token: again })).status, 401);
  // Same answer as a wrong password.
  const refused = await h.call('POST', '/v1/auth/login', { body: { email: AMIRA, password: PASSWORD } });
  const wrong = await h.call('POST', '/v1/auth/login', { body: { email: 'nobody@nowhere.example', password: PASSWORD } });
  assert.deepEqual([refused.status, refused.json], [wrong.status, wrong.json]);
  // N7: re-enabling gives the old credentials back, so one staff member cannot do it alone.
  const asked = await admin.act('/ops/users/usr_amira/enable');
  assert.match(asked.location, /^\/ops\/approvals\//);
  assert.equal((await h.call('POST', '/v1/auth/login', { body: { email: AMIRA, password: PASSWORD } })).status, 400, 'still disabled until a second person approves');
  assert.equal((await admin.act(`/ops/approvals/${idOf(asked.location)}/approve`)).status, 403);
  assert.equal((await second.act(`/ops/approvals/${idOf(asked.location)}/approve`)).status, 303);
  assert.equal((await h.login(AMIRA, secret)).status, 200);

  // A disabled person cannot use an activation link either: not one issued before, not a new one.
  const benCode = await h.invite(BEN);
  assert.equal((await h.call('POST', '/v1/activation/start', { body: { activationCode: benCode } })).status, 200);
  await h.stores.directory.updateUser('usr_ben', (user) => ({ ...user, disabledAt: 1 }));
  assert.equal((await h.call('POST', '/v1/activation/start', { body: { activationCode: benCode } })).status, 400);
  assert.equal((await h.call('POST', '/v1/activation/password', { body: { activationCode: benCode, password: PASSWORD } })).status, 400);
  assert.equal((await admin.act('/ops/users/usr_ben/activation-link')).status, 400);
  await assert.rejects(h.invite(BEN));

  // Lock the account out, then unlock it from the console.
  for (let attempt = 0; attempt < 5; attempt += 1) await h.call('POST', '/v1/auth/login', { body: { email: AMIRA, password: 'wrong password here' } });
  assert.equal((await h.call('POST', '/v1/auth/login', { body: { email: AMIRA, password: PASSWORD } })).status, 429);
  assert.match((await admin.browser.get('/ops/users/usr_amira')).body, /<dt>Locked out<\/dt><dd>Yes<\/dd>/);
  assert.ok((await audit('client.lockout')).length >= 1);
  assert.equal((await admin.act('/ops/users/usr_amira/unlock')).status, 303);
  const back = await h.login(AMIRA, secret);
  assert.equal(back.status, 200);

  await fourEyes(admin, second, '/ops/users/usr_amira/memberships', { companyId: 'co_northfield', role: 'approver' });
  assert.equal((await h.call('POST', '/v1/session/company', { token: back.json.token, body: { companyId: 'co_northfield' } })).json.role, 'approver');
  assert.equal((await admin.act('/ops/users/usr_amira/memberships/remove', { companyId: 'co_northfield' })).status, 303);
  assert.equal((await h.call('GET', '/v1/balances', { token: back.json.token })).status, 403);
});

test('H1: a lone staff member cannot obtain a working client credential by any console path', async () => {
  h = await harness();
  const amira = await h.activate(AMIRA);
  const session = (await h.login(AMIRA, amira.secret)).json.token as string;
  const { admin: lone, second } = await pair();
  const invitations = () => h.stores.auth.activations.count(() => true);
  const before = { invitations: await invitations(), user: JSON.stringify(await h.stores.directory.getUser('usr_amira')), users: (await h.stores.directory.listUsers()).length, memberships: (await h.stores.directory.listMemberships()).length };

  // Everything that used to end with a link on the screen, and every way of pointing a client account at oneself.
  const attempts: [string, Record<string, string>][] = [
    ['/ops/users/usr_amira/reset-authenticator', { verification: 'I checked, honestly, trust me' }],
    ['/ops/users/usr_ben/activation-link', {}],
    ['/ops/users', { name: 'Lone Wolf', email: lone.email, company1: 'co_northfield', role1: 'admin' }],
    ['/ops/users/usr_ben/memberships', { companyId: 'co_northfield', role: 'admin' }],
  ];
  const requests: string[] = [];
  for (const [url, form] of attempts) {
    const reply = await lone.act(url, form);
    assert.equal(reply.status, 303, url);
    assert.match(reply.location, /^\/ops\/approvals\/req_/, `${url} took effect without a second person`);
    requests.push(idOf(reply.location));
    // The lone member cannot be their own second pair of eyes.
    assert.equal((await lone.act(`/ops/approvals/${idOf(reply.location)}/approve`)).status, 403, url);
  }
  // Nothing happened: no email, no invitation, no new user or membership, the client untouched and still signed in.
  assert.equal(h.outbox.sent.length, 0);
  assert.equal(await invitations(), before.invitations);
  assert.equal(JSON.stringify(await h.stores.directory.getUser('usr_amira')), before.user);
  assert.equal((await h.stores.directory.listUsers()).length, before.users);
  assert.equal((await h.stores.directory.listMemberships()).length, before.memberships);
  assert.equal((await h.call('GET', '/v1/balances', { token: session })).status, 200);

  // Even when a second person approves, the link goes to the CLIENT's mailbox and to no screen.
  for (const id of requests.slice(0, 2)) assert.equal((await second.act(`/ops/approvals/${id}/approve`)).status, 303);
  assert.deepEqual(h.outbox.sent.map((message) => message.to).sort(), [AMIRA, BEN]);
  for (const url of ['/ops/users/usr_amira', '/ops/users/usr_ben', '/ops/approvals', ...requests.map((id) => `/ops/approvals/${id}`), '/ops/audit', '/ops/audit?target=amira', '/ops/users']) {
    for (const browser of [lone.browser, second.browser]) assert.equal((await browser.get(url)).status, 200, url);
  }
  const seen = [...lone.browser.pages, ...second.browser.pages].join('\n');
  for (const email of [AMIRA, BEN]) assert.ok(!seen.includes(h.mailedCode(email)), 'an emailed activation code appeared on a staff page');
  // Nothing on any page after sign-in looks like a link or a code, and nothing code-shaped that staff saw activates anything.
  for (const page of [...lone.browser.pages.slice(8), ...second.browser.pages.slice(8)]) assert.doesNotMatch(page.replace(/name="(code|activationCode)"/g, ''), LINK_OR_CODE);
  for (const candidate of new Set(seen.match(/[A-Z2-7]{5}(?:-[A-Z2-7]{5}){1,3}/g) ?? [])) {
    assert.equal((await h.call('POST', '/v1/activation/start', { body: { activationCode: candidate } })).status, 400);
  }
  // The staff member's own password and authenticator do not sign in as the client, and no route starts a client session.
  assert.equal((await h.call('POST', '/v1/auth/login', { body: { email: AMIRA, password: OPS_PASSWORD } })).status, 400);
  assert.deepEqual(h.opsRoutes.map((route) => route.url).filter((url) => /impersonat|login-as|act-as|session|token|password/i.test(url) && !/^\/ops\/(activate\/password|users\/:id\/revoke-sessions)$/.test(url)), []);
});

test('four-eyes: requests wait for a different staff member, can be rejected or cancelled, expire after 24 hours and are carried out once', async () => {
  h = await harness();
  const { admin, second } = await pair();
  const ask = async (who: Staff) => idOf((await who.act('/ops/users/usr_ben/activation-link')).location);

  // Rejected by the other person; the requester cannot reject their own (they cancel).
  const rejected = await ask(admin);
  assert.equal((await admin.act(`/ops/approvals/${rejected}/reject`)).status, 403);
  assert.equal((await second.act(`/ops/approvals/${rejected}/cancel`)).status, 403);
  assert.equal((await second.act(`/ops/approvals/${rejected}/reject`)).status, 303);
  assert.equal((await second.act(`/ops/approvals/${rejected}/approve`)).status, 409, 'a decided request cannot be approved');
  // Cancelled by the requester.
  const cancelled = await ask(admin);
  assert.equal((await admin.act(`/ops/approvals/${cancelled}/cancel`)).status, 303);
  assert.equal((await second.act(`/ops/approvals/${cancelled}/approve`)).status, 409);
  // Expired after 24 hours.
  const expired = await ask(second);
  assert.match((await admin.browser.get('/ops/approvals')).body, /Email an activation link to client ben@castlebrook\.example/);
  h.clock.advance(24 * 60 * 60_000 + 1);
  const late = await staff('late@globalconnect.example', 'ops');
  assert.equal((await late.act(`/ops/approvals/${expired}/approve`)).status, 409);
  assert.deepEqual((await h.stores.ops.approvals.list()).map((item) => item.status).sort(), ['cancelled', 'expired', 'rejected']);
  assert.equal(h.outbox.sent.length, 0, 'none of the three took effect');

  // Approved: carried out exactly once, even if two approvals arrive together.
  const other = await staff('other@globalconnect.example', 'ops');
  const fresh = idOf((await late.act('/ops/users/usr_ben/activation-link')).location);
  const codes = [h.freshCode(other.secret)];
  const third = await staff('third@globalconnect.example', 'ops');
  codes.push(h.code(third.secret));
  const [a, b] = await Promise.all([other.browser.post(`/ops/approvals/${fresh}/approve`, { code: codes[0] as string }), third.browser.post(`/ops/approvals/${fresh}/approve`, { code: codes[1] as string })]);
  assert.deepEqual([a.status, b.status].sort(), [303, 409]);
  assert.equal(h.outbox.sent.length, 1);

  // Each step is in the audit log with both people.
  const entries = await audit('ops.approval');
  const of = (action: string) => entries.filter((entry) => entry.action === action && entry.outcome === 'success');
  assert.equal(of('ops.approval.request').length, 4);
  assert.deepEqual(of('ops.approval.reject').map((entry) => [entry.actor.label, entry.detail.requestedBy]), [[second.email, admin.email]]);
  assert.deepEqual(of('ops.approval.cancel').map((entry) => entry.actor.label), [admin.email]);
  assert.deepEqual(of('ops.approval.expire').map((entry) => [entry.actor.type, entry.detail.requestedBy, entry.target?.label]), [['system', second.email, BEN]]);
  assert.equal(of('ops.approval.approve')[0]?.detail.requestedBy, late.email);

  // A request made by someone who has since been disabled cannot be approved.
  const stale = idOf((await late.act('/ops/users/usr_dana/activation-link')).location);
  await h.stores.ops.users.update(late.id, (user) => ({ ...user, disabledAt: 1 }));
  assert.equal((await other.act(`/ops/approvals/${stale}/approve`)).status, 409);
  assert.equal(h.outbox.sent.length, 1);
});

test('four-eyes can be switched off only in explicit development mode, and then actions take effect at once', async () => {
  h = await harness({ fourEyes: false });
  const admin = await staff();
  const reply = await admin.act('/ops/users/usr_ben/activation-link');
  assert.equal(reply.location, '/ops/users/usr_ben?done=mailed');
  assert.deepEqual(h.outbox.sent.map((message) => message.to), [BEN]);
  // Still no link on the screen.
  assert.doesNotMatch((await admin.browser.get(reply.location)).body, LINK_OR_CODE);
});

test('H2: a company can be mapped only by an ops admin, with approval, to a real provider account that no other company uses', async () => {
  h = await harness();
  const { admin, second } = await adminAndOps();
  const boss = await staff('boss@globalconnect.example', 'ops_admin');
  const amira = await h.activate(AMIRA);
  const session = (await h.login(AMIRA, amira.secret)).json.token as string;
  const create = (who: Staff, form: Record<string, string>) => who.act('/ops/companies', { name: 'Shell Ltd', ...form });
  const edit = (who: Staff, id: string, form: Record<string, string>) => who.act(`/ops/companies/${id}`, form);
  const northfield = { name: 'Northfield Trading Ltd', provider: 'provider-a', providerAccountId: 'sample-account-0001', providerContactId: 'sample-contact-0001' };

  // A shell company on another tenant's account id: refused, whoever asks.
  for (const who of [second, admin]) {
    const shell = await create(who, { provider: 'provider-b', providerAccountId: 'S00001' });
    assert.equal(shell.status, who === second ? 403 : 409, who.email);
    const shellA = await create(who, { provider: 'provider-a', providerAccountId: 'sample-account-0001', providerContactId: 'sample-contact-0001' });
    assert.equal(shellA.status, who === second ? 403 : 409);
  }
  // Also when the company holding the account is deactivated.
  assert.equal((await admin.act('/ops/companies/co_castlebrook/deactivate')).status, 303);
  assert.equal((await create(admin, { provider: 'provider-b', providerAccountId: 'S00001' })).status, 409);
  // An account the provider does not know, a contact that is not that account's, and provider A without a contact.
  assert.equal((await create(admin, { provider: 'provider-b', providerAccountId: 'S99999' })).status, 400);
  assert.equal((await create(admin, { provider: 'provider-a', providerAccountId: 'sample-account-0002', providerContactId: 'sample-contact-0003' })).status, 400);
  assert.equal((await create(admin, { provider: 'provider-a', providerAccountId: 'sample-account-0002' })).status, 400);
  // Re-pointing an existing company at an account in use, by either role.
  assert.equal((await edit(second, 'co_northfield', { ...northfield, provider: 'provider-b', providerAccountId: 'S00001', providerContactId: '' })).status, 403);
  assert.equal((await edit(admin, 'co_northfield', { ...northfield, provider: 'provider-b', providerAccountId: 'S00001', providerContactId: '' })).status, 409);
  assert.equal((await h.stores.ops.approvals.list()).length, 0);
  assert.equal((await h.stores.directory.listCompanies()).length, 2);
  assert.deepEqual(await h.stores.directory.getCompany('co_northfield').then((company) => [company?.providerKey, company?.providerAccountId]), ['currencycloud', 'sample-account-0001']);

  // A legitimate re-point: ops admin asks, the request says whose sessions will end, a second person approves, the sessions end.
  const asked = await edit(admin, 'co_northfield', { ...northfield, providerAccountId: 'sample-account-0003', providerContactId: 'sample-contact-0003' });
  assert.match(asked.location, /^\/ops\/approvals\//);
  const detail = (await boss.browser.get(asked.location)).body;
  assert.match(detail, /re-points the company at a different provider account/);
  assert.match(detail, /2 people are attached to it; ALL of their sessions will be ended/);
  assert.equal((await h.call('GET', '/v1/balances', { token: session })).status, 200);
  assert.equal((await boss.act(`/ops/approvals/${idOf(asked.location)}/approve`)).status, 303);
  assert.equal((await h.stores.directory.getCompany('co_northfield'))?.providerAccountId, 'sample-account-0003');
  assert.equal((await h.call('GET', '/v1/balances', { token: session })).status, 401, 'sessions of the attached people are ended');
  const entry = (await audit('ops.company.edit')).find((item) => item.outcome === 'success');
  assert.deepEqual([entry?.detail.mapping, entry?.detail.sessionsEnded, entry?.detail.approvedBy], ['changed', '1', boss.email]);
  // The freed account can now be used by a new company.
  await fourEyes(admin, boss, '/ops/companies', { ...northfield, name: 'New Ltd' });
});

test('audit log: records client and staff authentication, holds no secret, and cannot be changed over HTTP', async () => {
  h = await harness();
  const secrets: string[] = [PASSWORD, OPS_PASSWORD, ADMIN_TOKEN];
  const { admin, second } = await pair();
  secrets.push(admin.secret, ...admin.recoveryCodes, admin.browser.cookies.get('gc_ops_session') as string, admin.browser.csrf);

  await fourEyes(admin, second, '/ops/users/usr_amira/activation-link');
  const activationCode = h.mailedCode(AMIRA);
  assert.equal((await h.call('POST', '/v1/activation/password', { body: { activationCode, password: PASSWORD } })).status, 200);
  assert.equal((await h.call('POST', '/v1/activation/confirm', { body: { activationCode, code: '000000' } })).status, 400);
  const amira = await activateClient(AMIRA);
  secrets.push(activationCode, amira.secret, ...amira.recoveryCodes);
  await h.call('POST', '/v1/auth/login', { body: { email: AMIRA, password: 'wrong password here' } });
  secrets.push('wrong password here');
  const challenge = await h.call('POST', '/v1/auth/login', { body: { email: AMIRA, password: PASSWORD } });
  await h.call('POST', '/v1/auth/login/verify', { body: { challengeId: challenge.json.challengeId, code: '111111', method: 'totp' } });
  const good = h.freshCode(amira.secret);
  const session = await h.call('POST', '/v1/auth/login/verify', { body: { challengeId: challenge.json.challengeId, code: good, method: 'totp' } });
  assert.equal(session.status, 200);
  secrets.push(challenge.json.challengeId, good, session.json.token);
  const payload = { beneficiaryId: 'x', amount: '1.00', currency: 'GBP', reference: 'r', reason: 'r', idempotencyKey: 'k-1' };
  assert.equal((await h.call('POST', '/v1/step-up', { token: session.json.token, body: { action: 'payment.create', payload, code: '222222' } })).status, 400);
  secrets.push(await h.stepUp(session.json.token, amira.secret, 'payment.create', payload));
  await h.call('POST', '/v1/auth/logout', { token: session.json.token });
  await fourEyes(admin, second, '/ops/users/usr_amira/reset-authenticator', { verification: 'Called back on the number on file' });
  secrets.push(h.mailedCode(AMIRA));
  const user = await h.stores.directory.getUser('usr_amira');
  const staffRecord = await h.stores.ops.users.get(admin.id);
  secrets.push(staffRecord?.passwordHash as string, ...(staffRecord?.recoveryCodeHashes ?? []));
  assert.equal(user?.activatedAt, null);

  const entries = await audit();
  const has = (action: string, outcome: string) => entries.some((entry) => entry.action === action && entry.outcome === outcome);
  for (const [action, outcome] of [
    ['ops.activation', 'success'], ['ops.sign_in', 'success'], ['ops.step_up', 'success'],
    ['client.activation', 'failure'], ['client.activation', 'success'], ['client.sign_in', 'failure'], ['client.sign_in', 'success'],
    ['client.step_up', 'failure'], ['client.step_up', 'success'], ['client.sign_out', 'success'], ['client.session_revoked', 'success'],
  ] as const) {
    assert.ok(has(action, outcome), `${action} ${outcome}`);
  }
  for (const entry of entries) {
    assert.ok(entry.at > 0 && entry.actor.label && entry.action && entry.outcome, JSON.stringify(entry));
    assert.equal(typeof entry.source, 'string');
  }
  const dump = JSON.stringify(entries);
  for (const secret of secrets) assert.ok(secret.length >= 6 && !dump.includes(secret), `the audit log contains a secret: ${secret.slice(0, 4)}…`);
  assert.doesNotMatch(dump, /scrypt\$|otpauth:|rc1\$|code=/);

  // The page shows it, filtered, and shows no secret either.
  const page = await admin.browser.get(`/ops/audit?actor=${encodeURIComponent(AMIRA)}&action=client.sign_in&from=2026-11-11&to=2026-11-11`);
  assert.equal(page.status, 200);
  assert.match(page.body, /client\.sign_in/);
  assert.doesNotMatch(page.body, /ops\.sign_in|client\.activation/);
  assert.doesNotMatch((await admin.browser.get('/ops/audit?from=2030-01-01')).body, /client\.sign_in/);
  assert.match((await admin.browser.get('/ops/audit?target=amira&action=reset')).body, /identityVerification: Called back on the number on file/);
  for (const secret of secrets) assert.ok(secret === admin.browser.csrf || !admin.browser.pages.slice(-3).join('').includes(secret));
  // Repeated query parameters are handled, not a crash.
  for (const url of ['/ops/audit?actor=a&actor=b&from=x&from=y', '/ops/users?q=amira&q=ben', '/ops/companies?q=a&q=b&q=c', '/ops/users?done=saved&done=created']) {
    assert.equal((await admin.browser.get(url)).status, 200, url);
  }
  assert.match((await admin.browser.get('/ops/users?q=amira&q=ben')).body, /Amira Shah/);

  // Read only: no route changes or removes an entry.
  assert.deepEqual(h.opsRoutes.filter((route) => route.url.startsWith('/ops/audit')).map((route) => route.method).sort(), ['GET', 'HEAD']);
  const id = entries[0]?.id as string;
  const count = entries.length;
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE'] as const) {
    for (const url of ['/ops/audit', `/ops/audit/${id}`, `/ops/audit/${id}/delete`, '/v1/audit', `/v1/audit/${id}`]) {
      const cookie = `gc_ops_session=${admin.browser.cookies.get('gc_ops_session')}`;
      const reply = await h.app.inject({ method, url, headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' }, payload: `_csrf=${admin.browser.csrf}&code=${h.code(admin.secret)}` });
      assert.equal(reply.statusCode, 404, `${method} ${url}`);
    }
  }
  assert.equal((await audit()).length, count);
  assert.deepEqual(Object.keys(h.stores.audit).concat(Object.getOwnPropertyNames(Object.getPrototypeOf(h.stores.audit))).filter((name) => /delete|remove|update|edit|clear|set|shift|splice/i.test(name)), []);
});

test('ops cannot: see credentials, balances or transactions, or move money', async () => {
  h = await harness();
  const amira = await h.activate(AMIRA);
  await h.login(AMIRA, amira.secret);
  const { admin, second } = await pair();
  const user = await h.stores.directory.getUser('usr_amira');
  const providerCalls = h.providerA.seen.length + h.providerB.seen.length;

  for (const method of ['GET', 'POST'] as const) {
    for (const path of ['password', 'set-password', 'totp', 'secret', 'recovery-codes', 'impersonate', 'login-as', 'sessions/new', 'balances', 'transactions', 'payments', 'conversions']) {
      for (const url of [`/ops/users/usr_amira/${path}`, `/ops/companies/co_northfield/${path}`, `/ops/${path}`]) {
        const reply = method === 'GET' ? await admin.browser.get(url) : await admin.browser.post(url, { password: 'a new password 123', amount: '1.00', code: h.code(admin.secret) });
        assert.equal(reply.status, 404, `${method} ${url}`);
      }
    }
  }
  assert.equal((await h.stores.directory.getUser('usr_amira'))?.passwordHash, user?.passwordHash);

  // Every page the console can show about this client and their company, searched for anything it must not show.
  const pages: string[] = [];
  for (const url of ['/ops/users', '/ops/users?q=amira', '/ops/users/usr_amira', '/ops/companies', '/ops/companies/co_northfield', '/ops/audit', '/ops/staff', `/ops/staff/${admin.id}`, '/ops/users/new', '/ops/companies/new', '/ops/approvals']) {
    const reply = await admin.browser.get(url);
    assert.equal(reply.status, 200, url);
    pages.push(reply.body);
  }
  const reset = await fourEyes(admin, second, '/ops/users/usr_amira/reset-authenticator', { verification: 'Called back on the number on file' });
  pages.push(reset.approved.body, (await second.browser.get(`/ops/approvals/${reset.id}`)).body, (await admin.browser.get('/ops/users/usr_amira')).body, (await admin.browser.get('/ops/audit')).body);
  const shown = pages.join('\n');
  const staffRecord = await h.stores.ops.users.get(admin.id);
  for (const value of [user?.passwordHash, user?.totpSecret, amira.secret, ...amira.recoveryCodes, ...(user?.recoveryCodeHashes ?? []), PASSWORD, staffRecord?.passwordHash, staffRecord?.totpSecret, admin.secret, ...admin.recoveryCodes, h.mailedCode(AMIRA)]) {
    assert.ok(value && !shown.includes(value), 'a credential appears on an ops page');
  }
  assert.doesNotMatch(shown, /scrypt\$|otpauth:|rc1\$|101964\.00|57891\.00|type="password"|name="password"|Log in as|Sign in as/i);
  // No form on those pages posts anywhere but the console's own actions.
  for (const target of shown.matchAll(/action="([^"]+)"/g)) assert.match(target[1] as string, /^\/ops\//);
  // The only provider calls the console ever makes ask "does this account exist"; none was made here.
  assert.equal(h.providerA.seen.length + h.providerB.seen.length, providerCalls);
});

test('bootstrap: the operator command creates ops admins only while fewer than two ops admins are active, and emails the link', async () => {
  h = await harness();
  const body = { email: 'First.Admin@globalconnect.example', name: 'First Admin' };
  assert.equal((await h.call('POST', '/admin/ops-admins', { token: ADMIN_TOKEN, body })).status, 404, 'not on the public listener');
  assert.equal((await h.adminCall('/admin/ops-admins', body, '')).status, 404);
  assert.equal((await h.adminCall('/admin/ops-admins', body, 'wrong-token-0123456789')).status, 404);
  const created = await h.adminCall('/admin/ops-admins', body);
  assert.equal(created.status, 200);
  assert.deepEqual(Object.keys(created.json).sort(), ['expiresAt', 'sentTo']);
  assert.doesNotMatch(JSON.stringify(created.json), LINK_OR_CODE);
  assert.match(h.outbox.sent[0]?.text ?? '', /^[^]*http:\/\/localhost:3001\/ops\/activate#code=/);
  const firstCode = h.mailedCode('first.admin@globalconnect.example');
  // Run again before activation: a new link, the old one dead, still one account.
  assert.equal((await h.adminCall('/admin/ops-admins', body)).status, 200);
  assert.notEqual(h.mailedCode('first.admin@globalconnect.example'), firstCode);
  assert.equal((await h.stores.ops.users.list()).length, 1);
  const visitor = new Browser();
  await visitor.get('/ops/activate');
  assert.equal((await visitor.post('/ops/activate', { activationCode: firstCode })).status, 400);

  // N4: it stays open until there are TWO active ops admins (staff management needs one to ask and another to approve).
  await staff('first.admin@globalconnect.example');
  assert.equal((await h.adminCall('/admin/ops-admins', body)).status, 403, 'an activated account is not re-invited');
  await staff('helper@globalconnect.example', 'ops');
  assert.equal((await h.adminCall('/admin/ops-admins', { email: 'second@globalconnect.example', name: 'Second' })).status, 200, 'two active staff, but only one ops admin');
  // N3: only at an allowed staff domain, and only a clean name.
  assert.equal((await h.adminCall('/admin/ops-admins', { email: 'me@evil.example', name: 'Me' })).status, 403);
  assert.equal((await h.adminCall('/admin/ops-admins', { email: 'x\'"<b>@globalconnect.example', name: 'X' })).status, 400);
  assert.equal((await h.adminCall('/admin/ops-admins', { email: 'third@globalconnect.example', name: 'Third\nBcc: everyone@evil.example' })).status, 400);
  await staff('second@globalconnect.example');
  const refused = await h.adminCall('/admin/ops-admins', { email: 'third@globalconnect.example', name: 'Third' });
  assert.equal(refused.status, 403);
  assert.equal((await h.stores.ops.users.list()).length, 3);
  // A new member of staff is written where it is looked for.
  assert.deepEqual((await audit('ops.staff.new')).map((entry) => [entry.target?.label, entry.detail.role]).sort(), [['first.admin@globalconnect.example', 'ops_admin'], ['second@globalconnect.example', 'ops_admin']]);
  assert.match((await (await staff('viewer@globalconnect.example', 'ops')).browser.get('/ops/audit?action=ops.staff.new')).body, /<tr class="alert">/);
});

test('file store: accounts, requests and the audit log survive a restart; a damaged file is refused; development mode only', async () => {
  const folder = mkdtempSync(path.join(tmpdir(), 'gc-store-'));
  const file = path.join(folder, 'nested', 'accounts.json');
  try {
    const first = createFileStores(file, seedDirectory(), { development: true });
    await first.directory.updateUser('usr_amira', (user) => ({ ...user, passwordHash: 'scrypt$demo', totpSecret: 'JBSWY3DPEHPK3PXP', activatedAt: 5, lastSignInAt: 6 }));
    await first.directory.saveCompany({ id: 'co_new', name: 'New Ltd', providerKey: 'equals', providerAccountId: 'S9', providerContactId: '', deactivatedAt: null });
    await first.directory.setMembership({ userId: 'usr_amira', companyId: 'co_new', role: 'approver' });
    await first.directory.removeMembership('usr_dana', 'co_castlebrook');
    await first.ops.users.save({ id: 'ops_1', email: 'a@globalconnect.example', name: 'A', role: 'ops_admin', passwordHash: 'scrypt$x', totpSecret: 'K', lastTotpStep: 3, recoveryCodeHashes: ['h'], activatedAt: 1, disabledAt: null, lastSignInAt: null });
    await first.auth.activations.put('hash-1', { userId: 'usr_ben', expiresAt: 99, pendingPasswordHash: null, pendingTotpSecret: null });
    await first.ops.approvals.put('req_1', { id: 'req_1', action: 'client.unlock', params: { id: 'usr_ben' }, summary: 's', warnings: ['w'], target: null, requestedBy: { id: 'ops_1', email: 'a@globalconnect.example' }, requestedAt: 1, expiresAt: 2, status: 'pending', decidedBy: null, decidedAt: null });
    await first.providerKeys.put('co_new:key:k1', { orderId: 'o1', createdAt: 1 });
    await first.auth.sessions.put('token-hash', { id: 's', userId: 'usr_amira', companyId: null, createdAt: 1, lastSeenAt: 1 });
    await first.audit.append({ at: 7, actor: { type: 'system', id: null, label: 'test' }, target: null, action: 'test.event', outcome: 'success', source: '', detail: { a: 'b' } });

    // An anonymous failed sign-in (attempt counter + anonymous audit entry) does not rewrite the file.
    const written = readFileSync(file, 'utf8');
    const modified = statSync(file).mtimeMs;
    await first.auth.attempts.put('password:email:x|1.2.3.4', { failures: 2, lockedUntil: 0, locks: 0, subject: 'email:x', updatedAt: 1 });
    await first.audit.append({ at: 8, actor: { type: 'client', id: null, label: 'x' }, target: null, action: 'client.sign_in', outcome: 'failure', source: '1.2.3.4', detail: {} });
    assert.equal(readFileSync(file, 'utf8'), written);
    assert.equal(statSync(file).mtimeMs, modified);

    const second = createFileStores(file, seedDirectory(), { development: true });
    const loaded = await second.directory.getUser('usr_amira');
    assert.deepEqual([loaded?.passwordHash, loaded?.totpSecret, loaded?.activatedAt, loaded?.lastSignInAt], ['scrypt$demo', 'JBSWY3DPEHPK3PXP', 5, 6]);
    assert.equal((await second.directory.getCompany('co_new'))?.name, 'New Ltd');
    assert.deepEqual((await second.directory.membershipsOf('usr_amira')).map((item) => `${item.companyId}:${item.role}`).sort(), ['co_new:approver', 'co_northfield:admin']);
    assert.deepEqual((await second.directory.membershipsOf('usr_dana')).map((item) => item.companyId), ['co_northfield']);
    assert.equal((await second.ops.users.findByEmail('a@globalconnect.example'))?.lastTotpStep, 3);
    assert.equal((await second.auth.activations.get('hash-1'))?.userId, 'usr_ben');
    assert.equal((await second.ops.approvals.get('req_1'))?.warnings[0], 'w');
    assert.equal((await second.providerKeys.get('co_new:key:k1'))?.orderId, 'o1');
    assert.equal(await second.auth.sessions.get('token-hash'), null, 'sessions are not kept: a restart signs everyone out');
    assert.deepEqual((await second.audit.query()).map((entry) => [entry.action, entry.detail]), [['test.event', { a: 'b' }]]);
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).version, 3);

    // Anything that is not exactly the expected shape is refused, with the place named, rather than half-loaded.
    const good = JSON.parse(readFileSync(file, 'utf8'));
    for (const [damage, pattern] of [
      [{ ...good, version: 2 }, /not a Global Connect demo data file of this version[^]*npm run demo:reset/],
      [{ ...good, opsUsers: [{ id: 'ops_x', role: 'superuser' }] }, /problem at "opsUsers/],
      [{ ...good, directory: { ...good.directory, users: [{ ...good.directory.users[0], passwordHash: 5 }] } }, /problem at "directory\.users\.0\.passwordHash"/],
      [{ ...good, extra: true }, /not a Global Connect demo data file/],
      ['{"version":2,', /not valid JSON/],
    ] as const) {
      writeFileSync(file, typeof damage === 'string' ? damage : JSON.stringify(damage));
      assert.throws(() => createFileStores(file, seedDirectory(), { development: true }), pattern);
    }
    assert.throws(() => createFileStores(file, seedDirectory(), { development: false }), /local demonstrations only/);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

void DANA;
