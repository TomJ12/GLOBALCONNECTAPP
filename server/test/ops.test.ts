import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'node:test';

import { loadConfig } from '../src/config';
import { assertStaffRemovalAllowed, OpsError } from '../src/ops/console';
import { createFileStores } from '../src/store/file';
import { seedDirectory } from '../src/store/seed';
import type { OpsRole } from '../src/store/types';
import { AMIRA, BEN, harness, PASSWORD, type Harness } from './helpers';

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
const idOf = (location: string) => /\/(?:users|companies|staff)\/([\w-]+)/.exec(location)?.[1] ?? '';
const linkOf = (body: string) => /<p class="secret" id="link">([^<]+)<\/p>/.exec(body)?.[1] ?? '';
const codeOf = (link: string) => /code=([A-Z2-7-]+)/.exec(link)?.[1] ?? '';

/** Activate a client through the client API with a code issued by ops. */
async function activateClient(activationCode: string, password = PASSWORD) {
  const enrol = await h.call('POST', '/v1/activation/password', { body: { activationCode, password } });
  assert.equal(enrol.status, 200);
  const confirm = await h.call('POST', '/v1/activation/confirm', { body: { activationCode, code: h.code(enrol.json.secret) } });
  assert.equal(confirm.status, 200);
  return { secret: enrol.json.secret as string, recoveryCodes: confirm.json.recoveryCodes as string[] };
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

  // A used code cannot be replayed at sign-in.
  const again = new Browser();
  await again.get('/ops/login');
  const first = await again.post('/ops/login', { email: admin.email, password: OPS_PASSWORD });
  const challengeId = /name="challengeId" value="([^"]+)"/.exec(first.body)?.[1] ?? '';
  assert.match((await again.post('/ops/login/verify', { challengeId, code: h.code(admin.secret), method: 'totp' })).body, /already been used/);

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

test('ops: the session cookie is Secure when the console is not on localhost; a recovery code signs in once', async () => {
  h = await harness({ opsUrl: 'https://ops.globalconnect.example' });
  const account = await activateStaff('admin@globalconnect.example', 'ops_admin');
  for (const expected of [303, 400]) {
    const browser = new Browser();
    await browser.get('/ops/login');
    const first = await browser.post('/ops/login', { email: account.email, password: OPS_PASSWORD });
    const challengeId = /name="challengeId" value="([^"]+)"/.exec(first.body)?.[1] ?? '';
    const reply = await browser.post('/ops/login/verify', { challengeId, code: account.recoveryCodes[0] as string, method: 'recovery' });
    assert.equal(reply.status, expected);
    if (expected === 303) assert.match(browser.setCookies.find((line) => line.startsWith('gc_ops_session=')) ?? '', /HttpOnly; SameSite=Strict; Secure$/);
  }
});

test('ops: roles. ops manages clients but not staff; ops_admin manages staff', async () => {
  h = await harness();
  const admin = await staff();
  const invited = await admin.act('/ops/staff', { name: 'Olu Ops', email: 'olu@globalconnect.example', role: 'ops' });
  assert.equal(invited.status, 200);
  assert.match(invited.body, /shown once/);
  assert.match(linkOf(invited.body), /\/ops\/activate#code=/);

  const olu = await staff('olu@globalconnect.example', 'ops');
  assert.equal((await olu.browser.get('/ops/staff')).status, 403);
  assert.equal((await olu.browser.get(`/ops/staff/${admin.id}`)).status, 403);
  assert.doesNotMatch((await olu.browser.get('/ops/users')).body, /href="\/ops\/staff"/);
  for (const [url, form] of [
    ['/ops/staff', { name: 'X Y', email: 'x@globalconnect.example', role: 'ops_admin' }],
    [`/ops/staff/${olu.id}/role`, { role: 'ops_admin' }],
    [`/ops/staff/${admin.id}/disable`, {}],
    [`/ops/staff/${admin.id}/reset-authenticator`, { verification: 'verified in person at the office' }],
  ] as const) {
    assert.equal((await olu.act(url, form)).status, 403, url);
  }
  assert.equal((await h.stores.ops.users.list()).length, 2);
  assert.equal((await h.stores.ops.users.get(olu.id))?.role, 'ops');
  assert.ok((await audit('ops.staff')).some((entry) => entry.outcome === 'failure' && entry.detail.reason === 'forbidden' && entry.actor.id === olu.id));

  // The same ops user can manage clients.
  const created = await olu.act('/ops/companies', { name: 'Harbour Ltd', provider: 'provider-b', providerAccountId: 'S00077' });
  assert.equal(created.status, 303);
  // And the admin can change a role.
  assert.equal((await admin.act(`/ops/staff/${olu.id}/role`, { role: 'ops_admin' })).status, 303);
  assert.equal((await h.stores.ops.users.get(olu.id))?.role, 'ops_admin');
});

test('ops: every action needs a fresh code and is written to the audit log', async () => {
  h = await harness();
  await h.activate(AMIRA);
  const admin = await staff();
  const second = await activateStaff('second@globalconnect.example', 'ops');
  const pending = await h.opsAuth.createUser('pending@globalconnect.example', 'Pending', 'ops');
  const ben = (await h.stores.directory.findUserByEmail(BEN))?.id as string;

  const actions = h.opsRoutes.filter((route) => route.method === 'POST' && !/^\/ops\/(login|logout|activate)/.test(route.url));
  assert.ok(actions.length >= 19, `only ${actions.length} action routes`);
  const urlOf = (route: string) =>
    route.replace(':id', route.startsWith('/ops/companies') ? 'co_castlebrook' : route.startsWith('/ops/staff') ? (route.includes('reset') ? second.id : pending.id) : route.includes('reset') ? 'usr_amira' : ben);
  const formOf = (route: string, n: number): Record<string, string> => ({
    name: 'Tideway Ltd',
    email: `person${n}@tideway.example`,
    provider: 'provider-a',
    providerAccountId: 'acct-7',
    company1: 'co_northfield',
    role1: 'creator',
    companyId: 'co_northfield',
    role: route.startsWith('/ops/staff') ? 'ops' : 'approver',
    verification: 'Called back on the number on file',
  });
  const state = async () =>
    JSON.stringify([await h.stores.directory.listUsers(), await h.stores.directory.listCompanies(), await h.stores.directory.listMemberships(), (await h.stores.ops.users.list()).filter((user) => user.id !== admin.id)]);

  // Without a code, with a wrong code and with a reused code: refused, nothing changes, the refusal is logged.
  for (const route of actions) {
    for (const code of ['', '000000', h.code(admin.secret)]) {
      const before = await state();
      const failures = (await audit('ops.step_up')).filter((entry) => entry.outcome === 'failure').length;
      // Wrong codes would lock the account; this test is about each refusal, not the lockout.
      await h.stores.ops.attempts.deleteWhere(() => true);
      const reply = await admin.browser.post(urlOf(route.url), { ...formOf(route.url, 0), code });
      assert.equal(reply.status, 400, `${route.url} with code "${code}"`);
      assert.equal(await state(), before, route.url);
      assert.equal((await audit('ops.step_up')).filter((entry) => entry.outcome === 'failure').length, failures + 1, route.url);
    }
  }

  // With a fresh code each one succeeds and leaves a success entry naming the staff member.
  let n = 0;
  for (const route of actions) {
    n += 1;
    const before = (await audit()).filter((entry) => entry.outcome === 'success' && entry.actor.id === admin.id && !entry.action.includes('step_up') && !entry.action.includes('session_revoked')).length;
    const reply = await admin.act(urlOf(route.url), formOf(route.url, n));
    assert.ok(reply.status === 303 || reply.status === 200, `${route.url} -> ${reply.status} ${reply.body.slice(-400)}`);
    const entries = (await audit()).filter((entry) => entry.outcome === 'success' && entry.actor.id === admin.id && !entry.action.includes('step_up') && !entry.action.includes('session_revoked'));
    assert.equal(entries.length, before + 1, route.url);
    assert.match(entries[0]?.action ?? '', /^ops\.(company|client|staff)\./);
    assert.equal(entries[0]?.source, '127.0.0.1');
  }
  const names = new Set((await audit()).map((entry) => entry.action));
  for (const name of ['ops.company.create', 'ops.company.edit', 'ops.company.deactivate', 'ops.company.reactivate', 'ops.client.create', 'ops.client.membership.set', 'ops.client.membership.remove', 'ops.client.activation_link', 'ops.client.unlock', 'ops.client.reset_authenticator', 'ops.client.revoke_sessions', 'ops.client.disable', 'ops.client.enable', 'ops.staff.invite', 'ops.staff.role', 'ops.staff.disable', 'ops.staff.enable', 'ops.staff.activation_link', 'ops.staff.reset_authenticator', 'ops.step_up', 'client.session_revoked', 'ops.session_revoked']) {
    assert.ok(names.has(name), `no audit entry for ${name}`);
  }
  const reset = (await audit('ops.client.reset_authenticator')).find((entry) => entry.outcome === 'success');
  assert.equal(reset?.detail.identityVerification, 'Called back on the number on file');
  assert.equal(reset?.target?.label, AMIRA);
});

test('ops: CSRF. A post without the field, with a wrong field or from another site is refused', async () => {
  h = await harness();
  const admin = await staff();
  const form = { name: 'Tideway Ltd', provider: 'provider-a', providerAccountId: 'acct-7' };
  const code = () => h.freshCode(admin.secret);
  const before = (await h.stores.directory.listCompanies()).length;

  assert.equal((await admin.browser.request('POST', '/ops/companies', { ...form, code: code() })).status, 403);
  assert.equal((await admin.browser.request('POST', '/ops/companies', { ...form, code: code(), _csrf: 'f'.repeat(64) })).status, 403);
  // Another session's field does not fit this session.
  const other = await staff('other@globalconnect.example', 'ops');
  assert.equal((await admin.browser.request('POST', '/ops/companies', { ...form, code: code(), _csrf: other.browser.csrf })).status, 403);
  assert.equal((await admin.browser.post('/ops/companies', { ...form, code: code() }, { 'sec-fetch-site': 'cross-site' })).status, 403);
  assert.equal((await admin.browser.request('POST', '/ops/logout', {})).status, 403);
  assert.equal((await h.stores.directory.listCompanies()).length, before);

  // Before sign-in too.
  const visitor = new Browser();
  await visitor.get('/ops/login');
  assert.equal((await visitor.request('POST', '/ops/login', { email: admin.email, password: OPS_PASSWORD })).status, 403);
  assert.equal((await new Browser().request('POST', '/ops/login', { email: admin.email, password: OPS_PASSWORD, _csrf: visitor.csrf })).status, 403);

  // The real form still works.
  assert.equal((await admin.browser.post('/ops/companies', { ...form, code: code() }, { 'sec-fetch-site': 'same-origin' })).status, 303);
  assert.equal((await admin.browser.post('/ops/logout')).status, 303);
  assert.equal((await admin.browser.get('/ops/users')).status, 303);
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
    for (const url of ['/ops/users', '/ops/companies', '/ops/audit', '/ops/staff', '/ops/users/usr_amira']) {
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
  const admin = await staff();
  assert.equal((await admin.act(`/ops/staff/${admin.id}/role`, { role: 'ops' })).status, 403);
  assert.equal((await admin.act(`/ops/staff/${admin.id}/disable`)).status, 403);
  assert.equal((await admin.act(`/ops/staff/${admin.id}/reset-authenticator`, { verification: 'it is me, honestly' })).status, 403);
  const me = await h.stores.ops.users.get(admin.id);
  assert.equal(me?.role, 'ops_admin');
  assert.equal(me?.disabledAt, null);
  assert.ok(me?.activatedAt);
  assert.equal((await admin.browser.get('/ops/staff')).status, 200);

  // The last-admin rule on its own (through the console it is always also "yourself").
  const target = me as NonNullable<typeof me>;
  await assert.rejects(assertStaffRemovalAllowed(h.stores, 'ops_someone_else', target), (error: unknown) => error instanceof OpsError && error.reason === 'last_admin');
  // An admin who has not activated does not count as a second admin.
  await h.opsAuth.createUser('invited@globalconnect.example', 'Invited', 'ops_admin');
  await assert.rejects(assertStaffRemovalAllowed(h.stores, 'ops_someone_else', target), (error: unknown) => error instanceof OpsError && error.reason === 'last_admin');

  // With a second active admin, one can demote or disable the other, never themselves.
  const second = await staff('second@globalconnect.example', 'ops_admin');
  await assert.doesNotReject(assertStaffRemovalAllowed(h.stores, second.id, target));
  assert.equal((await second.act(`/ops/staff/${admin.id}/disable`)).status, 303);
  assert.equal((await admin.browser.get('/ops/staff')).status, 303, 'disabling ends the staff session');
  assert.equal((await signIn(new Browser(), admin.email, admin.secret)).status, 400, 'a disabled staff member cannot sign in');
  assert.equal((await second.act(`/ops/staff/${second.id}/role`, { role: 'ops' })).status, 403);
});

test('ops: create a company and a client, issue a link, the client sees only that company; reset revokes sessions and old credentials', async () => {
  h = await harness();
  const admin = await staff();
  const company = await admin.act('/ops/companies', { name: 'Tideway Ltd', provider: 'provider-b', providerAccountId: 'S00042' });
  const companyId = idOf(company.location);
  const created = await admin.act('/ops/users', { name: 'Chidi Eze', email: 'Chidi@Tideway.example', company1: companyId, role1: 'admin' });
  assert.equal(created.status, 303);
  const userId = idOf(created.location);
  assert.match((await admin.browser.get(`/ops/users/${userId}`)).body, /<dt>Activated<\/dt><dd>No<\/dd>/);
  assert.match((await admin.browser.get('/ops/users?q=chidi')).body, /Chidi Eze/);
  assert.doesNotMatch((await admin.browser.get('/ops/users?q=chidi')).body, /Amira/);
  assert.match((await admin.browser.get(`/ops/companies/${companyId}`)).body, /Provider B \(Equals Money\)/);

  // Issue, then re-issue: the first link stops working.
  const first = await admin.act(`/ops/users/${userId}/activation-link`);
  assert.match(first.body, /shown once/);
  assert.match(first.body, /approved channel/);
  assert.match(first.body, /Expires 2026-11-14/);
  assert.match(first.body, /data-copy="link"/);
  const second = await admin.act(`/ops/users/${userId}/activation-link`);
  assert.equal((await h.call('POST', '/v1/activation/start', { body: { activationCode: codeOf(linkOf(first.body)) } })).status, 400);
  const before = await activateClient(codeOf(linkOf(second.body)));

  const login = await h.login('chidi@tideway.example', before.secret);
  assert.equal(login.status, 200);
  assert.deepEqual(login.json.companies, [{ id: companyId, name: 'Tideway Ltd' }]);
  assert.deepEqual(login.json.session.company, { id: companyId, name: 'Tideway Ltd' });
  assert.equal((await h.call('POST', '/v1/session/company', { token: login.json.token, body: { companyId: 'co_northfield' } })).status, 404);
  assert.equal((await h.call('GET', '/v1/balances', { token: login.json.token })).status, 200);
  // Nothing the client app received names a provider or the provider account.
  assert.doesNotMatch(h.bodies.join('\n'), /currencycloud|equals|provider-b|S00042/i);

  const status = (await admin.browser.get(`/ops/users/${userId}`)).body;
  assert.match(status, /<dt>Activated<\/dt><dd>Yes/);
  assert.match(status, /<dt>Active sessions<\/dt><dd>1<\/dd>/);
  assert.match(status, /<dt>Last sign-in<\/dt><dd>2026-/);
  assert.match(status, /Verify this person’s identity BEFORE resetting/);

  // Reset needs the identity-verification text.
  assert.equal((await admin.act(`/ops/users/${userId}/reset-authenticator`, { verification: '' })).status, 400);
  assert.equal((await h.call('GET', '/v1/balances', { token: login.json.token })).status, 200);
  const reset = await admin.act(`/ops/users/${userId}/reset-authenticator`, { verification: 'Video call, passport checked against KYC file' });
  assert.equal(reset.status, 200);
  assert.match(reset.body, /choose a new password/);

  // Old session, old password, old authenticator and old recovery codes are all dead.
  assert.equal((await h.call('GET', '/v1/balances', { token: login.json.token })).status, 401);
  assert.equal((await h.call('POST', '/v1/auth/login', { body: { email: 'chidi@tideway.example', password: PASSWORD } })).status, 400);
  const record = await h.stores.directory.getUser(userId);
  assert.deepEqual([record?.passwordHash, record?.totpSecret, record?.recoveryCodeHashes, record?.activatedAt], [null, null, [], null]);

  const after = await activateClient(codeOf(linkOf(reset.body)), 'a brand new pass phrase');
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
});

test('ops: disable ends sessions and blocks sign-in; unlock and revoke-all work; removing a membership takes effect', async () => {
  h = await harness();
  const { secret } = await h.activate(AMIRA);
  const admin = await staff();
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
  assert.equal((await admin.act('/ops/users/usr_amira/enable')).status, 303);
  assert.equal((await h.login(AMIRA, secret)).status, 200);

  // Lock the account out, then unlock it from the console.
  for (let attempt = 0; attempt < 5; attempt += 1) await h.call('POST', '/v1/auth/login', { body: { email: AMIRA, password: 'wrong password here' } });
  assert.equal((await h.call('POST', '/v1/auth/login', { body: { email: AMIRA, password: PASSWORD } })).status, 429);
  assert.match((await admin.browser.get('/ops/users/usr_amira')).body, /<dt>Locked out<\/dt><dd>Yes<\/dd>/);
  assert.ok((await audit('client.lockout')).length >= 1);
  assert.equal((await admin.act('/ops/users/usr_amira/unlock')).status, 303);
  const back = await h.login(AMIRA, secret);
  assert.equal(back.status, 200);

  assert.equal((await admin.act('/ops/users/usr_amira/memberships', { companyId: 'co_northfield', role: 'approver' })).status, 303);
  assert.equal((await h.call('POST', '/v1/session/company', { token: back.json.token, body: { companyId: 'co_northfield' } })).json.role, 'approver');
  assert.equal((await admin.act('/ops/users/usr_amira/memberships/remove', { companyId: 'co_northfield' })).status, 303);
  assert.equal((await h.call('GET', '/v1/balances', { token: back.json.token })).status, 403);
});

test('audit log: records client and staff authentication, holds no secret, and cannot be changed over HTTP', async () => {
  h = await harness();
  const secrets: string[] = [PASSWORD, OPS_PASSWORD];
  const admin = await staff();
  secrets.push(admin.secret, ...admin.recoveryCodes, admin.browser.cookies.get('gc_ops_session') as string, admin.browser.csrf);

  const invite = await admin.act('/ops/users/usr_amira/activation-link');
  const activationCode = codeOf(linkOf(invite.body));
  assert.equal((await h.call('POST', '/v1/activation/password', { body: { activationCode, password: PASSWORD } })).status, 200);
  assert.equal((await h.call('POST', '/v1/activation/confirm', { body: { activationCode, code: '000000' } })).status, 400);
  const amira = await activateClient(activationCode);
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
  await admin.act('/ops/users/usr_amira/reset-authenticator', { verification: 'Called back on the number on file' });
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
  assert.doesNotMatch(dump, /scrypt\$|otpauth:/);

  // The page shows it, filtered, and shows no secret either.
  const page = await admin.browser.get(`/ops/audit?actor=${encodeURIComponent(AMIRA)}&action=client.sign_in&from=2026-11-11&to=2026-11-11`);
  assert.equal(page.status, 200);
  assert.match(page.body, /client\.sign_in/);
  assert.doesNotMatch(page.body, /ops\.sign_in|client\.activation/);
  assert.doesNotMatch((await admin.browser.get('/ops/audit?from=2030-01-01')).body, /client\.sign_in/);
  assert.match((await admin.browser.get('/ops/audit?target=amira&action=reset')).body, /identityVerification: Called back on the number on file/);
  for (const secret of secrets) assert.ok(secret === admin.browser.csrf || !admin.browser.pages.slice(-3).join('').includes(secret));

  // Read only: no route changes or removes an entry.
  assert.deepEqual(h.opsRoutes.filter((route) => route.url.startsWith('/ops/audit')).map((route) => route.method).sort(), ['GET', 'HEAD']);
  const id = entries[0]?.id as string;
  const count = entries.length;
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE'] as const) {
    for (const url of ['/ops/audit', `/ops/audit/${id}`, `/ops/audit/${id}/delete`, '/v1/audit', `/v1/audit/${id}`]) {
      const cookie = `gc_ops_session=${admin.browser.cookies.get('gc_ops_session')}`;
      const reply = await h.app.inject({ method, url, headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' }, payload: `_csrf=${admin.browser.csrf}&code=${h.freshCode(admin.secret)}` });
      assert.equal(reply.statusCode, 404, `${method} ${url}`);
    }
  }
  assert.equal((await audit()).length, count);
  assert.deepEqual(Object.keys(h.stores.audit).concat(Object.getOwnPropertyNames(Object.getPrototypeOf(h.stores.audit))).filter((name) => /delete|remove|update|edit|clear|set/i.test(name)), []);
});

test('ops cannot: see credentials, balances or transactions, move money, or act as a client', async () => {
  h = await harness();
  const amira = await h.activate(AMIRA);
  await h.login(AMIRA, amira.secret);
  const admin = await staff();
  const user = await h.stores.directory.getUser('usr_amira');

  // No route of the console is about any of these.
  const forbidden = /password|passcode|totp|secret|recovery|credential|balance|transaction|payment|conversion|quote|beneficiar|payee|rate|impersonat|login-as|act-as|token/i;
  const urls = h.opsRoutes.map((route) => route.url).filter((url) => !/^\/ops\/(login|activate)(\/|$)/.test(url));
  assert.ok(urls.length > 30);
  assert.deepEqual(urls.filter((url) => forbidden.test(url)), []);
  // The staff member's own enrolment is the only place a password is ever submitted.
  assert.deepEqual(h.opsRoutes.filter((route) => /password/.test(route.url)).map((route) => route.url), ['/ops/activate/password']);
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
  for (const url of ['/ops/users', '/ops/users?q=amira', '/ops/users/usr_amira', '/ops/companies', '/ops/companies/co_northfield', '/ops/audit', '/ops/staff', `/ops/staff/${admin.id}`, '/ops/users/new', '/ops/companies/new']) {
    const reply = await admin.browser.get(url);
    assert.equal(reply.status, 200, url);
    pages.push(reply.body);
  }
  pages.push((await admin.act('/ops/users/usr_ben/activation-link')).body, (await admin.act('/ops/users/usr_amira/reset-authenticator', { verification: 'Called back on the number on file' })).body);
  const shown = pages.join('\n');
  const staffRecord = await h.stores.ops.users.get(admin.id);
  for (const value of [user?.passwordHash, user?.totpSecret, amira.secret, ...amira.recoveryCodes, ...(user?.recoveryCodeHashes ?? []), PASSWORD, staffRecord?.passwordHash, staffRecord?.totpSecret, admin.secret, ...admin.recoveryCodes]) {
    assert.ok(value && !shown.includes(value), 'a credential appears on an ops page');
  }
  assert.doesNotMatch(shown, /scrypt\$|otpauth:|101964\.00|57891\.00|type="password"|name="password"|Log in as|Sign in as/i);
  // No form on those pages posts anywhere but the console's own actions.
  for (const target of shown.matchAll(/action="([^"]+)"/g)) assert.match(target[1] as string, /^\/ops\//);
});

test('bootstrap: create-ops-admin makes the first admin only, and needs the admin token', async () => {
  h = await harness();
  const body = { email: 'First.Admin@globalconnect.example', name: 'First Admin' };
  assert.equal((await h.call('POST', '/admin/ops-admins', { body })).status, 404);
  assert.equal((await h.call('POST', '/admin/ops-admins', { token: 'wrong-token-0123456789', body })).status, 404);
  const created = await h.call('POST', '/admin/ops-admins', { token: h.config.adminToken as string, body });
  assert.equal(created.status, 200);
  assert.match(created.json.activationLink, /^http:\/\/localhost:3001\/ops\/activate#code=/);
  // Run again before activation: a new link, the old one dead, still one account.
  const again = await h.call('POST', '/admin/ops-admins', { token: h.config.adminToken as string, body });
  assert.equal(again.status, 200);
  assert.notEqual(again.json.activationCode, created.json.activationCode);
  assert.equal((await h.stores.ops.users.list()).length, 1);
  const visitor = new Browser();
  await visitor.get('/ops/activate');
  assert.equal((await visitor.post('/ops/activate', { activationCode: created.json.activationCode })).status, 400);

  await staff('first.admin@globalconnect.example');
  const refused = await h.call('POST', '/admin/ops-admins', { token: h.config.adminToken as string, body: { email: 'second@globalconnect.example', name: 'Second' } });
  assert.equal(refused.status, 403);
  assert.equal((await h.stores.ops.users.list()).length, 1);
});

test('file store: accounts and the audit log survive a restart; refused in production', async () => {
  const folder = mkdtempSync(path.join(tmpdir(), 'gc-store-'));
  const file = path.join(folder, 'nested', 'accounts.json');
  try {
    const first = createFileStores(file, seedDirectory(), { production: false });
    const user = await first.directory.getUser('usr_amira');
    await first.directory.saveUser({ ...(user as NonNullable<typeof user>), passwordHash: 'scrypt$demo', totpSecret: 'JBSWY3DPEHPK3PXP', activatedAt: 5, lastSignInAt: 6 });
    await first.directory.saveCompany({ id: 'co_new', name: 'New Ltd', providerKey: 'equals', providerAccountId: 'S9', providerContactId: '', deactivatedAt: null });
    await first.directory.setMembership({ userId: 'usr_amira', companyId: 'co_new', role: 'approver' });
    await first.directory.removeMembership('usr_dana', 'co_castlebrook');
    await first.ops.users.save({ id: 'ops_1', email: 'a@globalconnect.example', name: 'A', role: 'ops_admin', passwordHash: 'scrypt$x', totpSecret: 'K', lastTotpStep: 3, recoveryCodeHashes: ['h'], activatedAt: 1, disabledAt: null, lastSignInAt: null });
    await first.auth.activations.put('hash-1', { userId: 'usr_ben', expiresAt: 99, pendingPasswordHash: null, pendingTotpSecret: null });
    await first.auth.attempts.put('password:x', { failures: 2, lockedUntil: 0 });
    await first.auth.sessions.put('token-hash', { id: 's', userId: 'usr_amira', companyId: null, createdAt: 1, lastSeenAt: 1 });
    await first.audit.append({ at: 7, actor: { type: 'system', id: null, label: 'test' }, target: null, action: 'test.event', outcome: 'success', source: '', detail: { a: 'b' } });

    const second = createFileStores(file, seedDirectory(), { production: false });
    const loaded = await second.directory.getUser('usr_amira');
    assert.deepEqual([loaded?.passwordHash, loaded?.totpSecret, loaded?.activatedAt, loaded?.lastSignInAt], ['scrypt$demo', 'JBSWY3DPEHPK3PXP', 5, 6]);
    assert.equal((await second.directory.getCompany('co_new'))?.name, 'New Ltd');
    assert.deepEqual((await second.directory.membershipsOf('usr_amira')).map((item) => `${item.companyId}:${item.role}`).sort(), ['co_new:approver', 'co_northfield:admin']);
    assert.deepEqual((await second.directory.membershipsOf('usr_dana')).map((item) => item.companyId), ['co_northfield']);
    assert.equal((await second.ops.users.findByEmail('a@globalconnect.example'))?.lastTotpStep, 3);
    assert.equal((await second.auth.activations.get('hash-1'))?.userId, 'usr_ben');
    assert.equal((await second.auth.attempts.get('password:x'))?.failures, 2);
    assert.equal(await second.auth.sessions.get('token-hash'), null, 'sessions are not kept: a restart signs everyone out');
    assert.deepEqual((await second.audit.query()).map((entry) => [entry.action, entry.detail]), [['test.event', { a: 'b' }]]);
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).version, 1);

    assert.throws(() => createFileStores(file, seedDirectory(), { production: true }), /local demonstrations only/);
    const production = { NODE_ENV: 'production', CURRENCYCLOUD_LOGIN_ID: 'a', CURRENCYCLOUD_API_KEY: 'b', EQUALS_API_KEY: 'c' };
    assert.throws(() => loadConfig({ ...production, DATA_FILE: file }), /refused when NODE_ENV=production/);
    assert.equal(loadConfig(production).dataFile, null);
    assert.equal(loadConfig({ NODE_ENV: 'development', DATA_FILE: file }).dataFile, file);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});
