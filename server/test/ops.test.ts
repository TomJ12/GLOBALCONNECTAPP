import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import { assertStaffRemovalAllowed, CONFIRM_TTL_MS, OpsError } from '../src/ops/console';
import { StoreConflict, type OpsRole } from '../src/store/types';
import { loadConfig, opsModeLine } from '../src/config';
import { ADMIN_TOKEN, AMIRA, BEN, DANA, harness as baseHarness, PASSWORD, TEST_DATA_KEY, type Harness, confirmed, confirmTokenOf, OPS_PASSWORD } from './helpers';

/**
 * THIS WHOLE FILE RUNS IN BOTH OPS MODES. By itself it runs in two-person mode (sensitive actions are requested by
 * one member of staff and approved by another), so that mode does not rot now that it is not the default.
 * `ops.single.test.ts` runs the same file again in single-person mode: the `fourEyes` helper below then carries
 * each action out with the one person who starts it, and the tests that are ABOUT the second person say so
 * (`twoPerson`) and are skipped there, by name.
 */
const SINGLE = process.env.OPS_TEST_MODE === 'single';
const harness: typeof baseHarness = (overrides = {}, ...rest) => baseHarness({ fourEyes: !SINGLE, ...overrides }, ...rest);
/** A test about the second person: what two-person mode enforces. Skipped, visibly, when the file runs in single-person mode. */
const twoPerson: typeof test = ((name: string, run: () => Promise<void>) => test(name, { skip: SINGLE ? 'two-person mode only' : false }, run)) as typeof test;
/** A test of single-person mode itself. It sets the mode explicitly, and runs once (in the single-person run of this file). */
const singlePerson: typeof test = ((name: string, run: () => Promise<void>) => test(name, { skip: SINGLE ? false : 'runs in the single-person run of this file (ops.single.test.ts)' }, run)) as typeof test;

let h: Harness;
afterEach(async () => h?.close());


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
  /**
   * SUBMITS A FORM AS THE PAGE RENDERS IT: the form that posts to `action` on the page this browser received
   * last. Hidden fields go as the page gave them, other fields as the page pre-filled them unless `values` says
   * otherwise, a checkbox only when `values` names it. A value for a field THE FORM DOES NOT HOLD is refused: a
   * person can only send what the form offers, so a test that could send more would pass on a page nobody can use.
   */
  submit(action: string, values: Record<string, string> = {}, headers: Record<string, string> = {}) {
    const unescape = (text: string) => text.replace(/&(amp|lt|gt|quot|#39);/g, (_all, name: string) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" })[name] as string);
    const page = this.pages.at(-1) ?? '';
    const form = [...page.matchAll(/<form method="post" action="([^"]*)"[^>]*>([^]*?)<\/form>/g)].find((match) => unescape(match[1] ?? '') === action)?.[2];
    if (form === undefined) throw new Error(`the page has no form that posts to ${action}`);
    const body: Record<string, string> = {};
    const offered = new Set<string>();
    for (const [, tag = '', attributes = '', content = ''] of form.matchAll(/<(input|select|textarea)\b([^>]*)>(?:([^<]*)<\/textarea>)?/g)) {
      const name = /\bname="([^"]*)"/.exec(attributes)?.[1];
      if (!name) continue;
      offered.add(name);
      const type = tag === 'input' ? (/\btype="([^"]*)"/.exec(attributes)?.[1] ?? 'text') : tag;
      if (type === 'checkbox' || type === 'radio' || type === 'select') continue;
      body[name] = unescape(tag === 'textarea' ? content : (/\bvalue="([^"]*)"/.exec(attributes)?.[1] ?? ''));
    }
    for (const [name, value] of Object.entries(values)) {
      if (!offered.has(name)) throw new Error(`the form that posts to ${action} has no field "${name}": a person could not send it`);
      body[name] = value;
    }
    return this.request('POST', action, body, headers);
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
  // Every step is SUBMITTED FROM THE FORM THE PAGE SHOWS (Browser.submit): a field the page does not offer cannot be sent.
  assert.equal((await browser.get('/ops/activate')).status, 200);
  assert.match((await browser.submit('/ops/activate', { activationCode })).body, /Choose a password/);
  const enrol = await browser.submit('/ops/activate/password', { password });
  assert.match(enrol.body, /<svg class="qr"/);
  assert.match(enrol.body, /<form method="post" action="\/ops\/activate\/confirm">[^]*?<input name="code"[^]*?<\/form>/);
  const refused = await browser.submit('/ops/activate/confirm', { code: '000000' });
  assert.match(refused.body, /not accepted[^]*<input name="code"/);
  const secret = /<p class="secret">([A-Z2-7]+)<\/p>/.exec(enrol.body)?.[1] ?? '';
  assert.ok(secret.length >= 32);
  const done = await browser.submit('/ops/activate/confirm', { code: h.code(secret) });
  assert.equal(done.status, 200);
  const recoveryCodes = [...done.body.matchAll(/<li>([A-Z2-7-]+)<\/li>/g)].map((match) => match[1] as string);
  assert.equal(recoveryCodes.length, 10);
  assert.match(recoveryCodes[0] as string, /^[A-Z2-7]{5}(-[A-Z2-7]{5}){3}$/);
  return { browser, id: user.id, email, secret, recoveryCodes };
}

async function signIn(browser: Browser, email: string, secret: string, password = OPS_PASSWORD) {
  await browser.get('/ops/login');
  const first = await browser.submit('/ops/login', { email, password });
  if (!/name="challengeId" value="([^"]+)"/.test(first.body)) return first;
  return browser.submit('/ops/login/verify', { code: h.freshCode(secret) });
}

async function staff(email = 'admin@globalconnect.example', role: OpsRole = 'ops_admin'): Promise<Staff> {
  const account = await activateStaff(email, role);
  const reply = await signIn(account.browser, email, account.secret);
  assert.equal(reply.status, 303, reply.body);
  assert.equal(reply.location, '/ops');
  await account.browser.get('/ops/users');
  return { ...account, act: (url, form = {}) => confirmed((to, fields) => account.browser.post(to, fields), url, form) };
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
/** Approving these asks the approver for their password again: staff management, company create and re-point, a change of a company's payment-approval rule, client authenticator reset. */
const PASSWORD_APPROVALS = ['ops.staff.invite', 'ops.staff.role', 'ops.staff.disable', 'ops.staff.enable', 'ops.staff.activation_link', 'ops.staff.unlock', 'ops.staff.reset_authenticator', 'ops.company.create', 'ops.company.edit', 'ops.company.approvals', 'ops.company.margin', 'ops.client.reset_authenticator'];

async function fourEyes(requester: Staff, approver: Staff, url: string, form: Record<string, string> = {}) {
  const asked = await requester.act(url, form);
  assert.equal(asked.status, 303, `${url}: ${asked.body.slice(-300)}`);
  // SINGLE-PERSON MODE: the person who started it has carried it out (confirmation page and, where asked, password). Nobody else is involved.
  if (SINGLE) {
    assert.doesNotMatch(asked.location, /^\/ops\/approvals\//, url);
    return { id: idOf(asked.location), approved: asked, record: null as Awaited<ReturnType<typeof h.stores.ops.approvals.get>> };
  }
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

twoPerson('ops: roles. ops manages clients but not staff or company mappings, and cannot approve them; ops_admin does', async () => {
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

twoPerson('ops: every action needs its confirmation (bound to session, action and payload, once), never a code, and is written to the audit log', async () => {
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

  // (Finishing or closing an interrupted request needs one that was interrupted: those two have their own test.)
  const actions = h.opsRoutes.filter((route) => route.method === 'POST' && !/^\/ops\/(login|logout|activate|forgot|reset)/.test(route.url) && !/\/(resume|abandon)$/.test(route.url) && !/authenticator-resets/.test(route.url));
  assert.ok(actions.length >= 24, `only ${actions.length} action routes`);
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
    // Ben is attached to Northfield (he is not in it) and removed from Castlebrook (he is).
    companyId: route.endsWith('/remove') ? 'co_castlebrook' : 'co_northfield',
    role: route.startsWith('/ops/staff') ? 'ops' : 'approver',
    verification: 'Called back on the number on file',
    approvalsRequired: '2',
    defaultPercent: '0.65',
    forwardPercent: '',
    overrides: '',
    tiers: '',
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
  const confirmPage = async (who: Staff, url: string, form: Record<string, string>) => {
    const page = await who.browser.post(url, form);
    assert.equal(page.status, 200, `${url}: ${page.body.slice(-300)}`);
    assert.match(page.body, /<div class="card narrow confirm[^"]*">/, url);
    // After sign-in no page asks for an authenticator code.
    assert.doesNotMatch(page.body, /name="code"|[Aa]uthenticator code|one-time-code/, url);
    return { body: page.body, token: confirmTokenOf(page.body) as string };
  };

  // The first POST of every action does nothing but show the confirmation. Then every wrong way of confirming is refused.
  for (const route of actions) {
    const url = urlOf(route.url);
    const form = formOf(route.url, 0);
    const before = await state();
    const entries = (await audit()).length;
    const mine = await confirmPage(admin, url, form);
    assert.equal(await state(), before, `${route.url}: showing the confirmation changed something`);
    assert.equal((await audit()).length, entries, `${route.url}: showing the confirmation is not an action`);
    assert.match(mine.token, /^\d+\.[\w-]+\.[\w-]+$/);
    assert.ok(mine.body.includes(`action="${url}"`) && /<button[^>]*>Confirm<\/button><a class="button quiet" href="\/ops\/[^"]*">Cancel<\/a>/.test(mine.body), route.url);
    const password: Record<string, string> = /name="password"/.test(mine.body) ? { password: OPS_PASSWORD } : {};
    const [expires, nonce, signature] = mine.token.split('.') as [string, string, string];
    const refused: [string, Record<string, string>][] = [
      ['a made-up token', { ...form, _confirm: `${expires}.${nonce}.${'A'.repeat(signature.length)}` }],
      ['a token with a later expiry written in', { ...form, _confirm: `${Number(expires) + 60_000}.${nonce}.${signature}` }],
      ['a token for a different payload', { ...form, extra: 'x', _confirm: mine.token }],
      ['a token for a changed field', { ...Object.fromEntries(Object.entries(form).map(([key, value], index) => [key, index === 0 ? `${value}x` : value])), _confirm: mine.token }],
      ['a token from another session', { ...form, _confirm: (await confirmPage(second, url, form).catch(() => ({ token: mine.token.replace(/.$/, (last) => (last === 'A' ? 'B' : 'A')) }))).token }],
    ];
    for (const [what, sent] of refused) {
      const reply = await admin.browser.post(url, { ...sent, ...password });
      // Refused: the confirmation is shown again (with a new token), and nothing was done.
      assert.equal(reply.status, 409, `${route.url} with ${what}: ${reply.status}`);
      assert.match(reply.body, /Nothing was done/, what);
      assert.equal(await state(), before, `${route.url} with ${what}`);
    }
    // A token made for one action does not confirm another.
    const other = actions.find((item) => item.url !== route.url && urlOf(item.url) !== url) as { url: string };
    assert.equal((await admin.browser.post(urlOf(other.url), { ...form, _confirm: mine.token, ...password })).status === 303, false, `${route.url}: token accepted by ${other.url}`);
    // Past its five minutes it is refused too.
    h.clock.advance(CONFIRM_TTL_MS + 1);
    const late = await admin.browser.post(url, { ...form, _confirm: mine.token, ...password });
    h.clock.advance(-(CONFIRM_TTL_MS + 1));
    assert.equal(late.status, 409, `${route.url} expired`);
    assert.equal(await state(), before, `${route.url} expired`);
  }
  assert.equal((await audit('ops.step_up')).length, 0, 'staff step-up no longer exists');

  // Confirmed properly, each one is done, or becomes a request that the second staff member approves; both leave entries.
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
    assert.equal(entries.length, before + (route.url.endsWith('/approve') ? 3 : 1), route.url); // approving: the decision, the change itself, and its completion
    assert.equal(entries[0]?.source, '127.0.0.1');
    assert.equal(entries[0]?.detail.confirmed, 'yes', `${route.url}: the entry says it was confirmed`);
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
      assert.equal(approval?.detail.confirmed, 'yes');
      // The highest-impact approvals, and only those, were made with the approver's password.
      assert.equal(approval?.detail.passwordChecked, PASSWORD_APPROVALS.includes(carriedOut?.action ?? '') ? 'yes' : undefined, carriedOut?.action);
      viaApproval.push(carriedOut?.action ?? '');
    }
  }
  assert.deepEqual(viaApproval.sort(), [
    'ops.client.activation_link', 'ops.client.create', 'ops.client.enable', 'ops.client.membership.set', 'ops.client.reset_authenticator', 'ops.company.approvals', 'ops.company.create', 'ops.company.edit', 'ops.company.margin', 'ops.company.reactivate',
    'ops.staff.activation_link', 'ops.staff.disable', 'ops.staff.enable', 'ops.staff.invite', 'ops.staff.reset_authenticator', 'ops.staff.role', 'ops.staff.unlock',
  ]);
  const names = new Set((await audit()).map((entry) => entry.action));
  for (const name of ['ops.company.deactivate', 'ops.client.membership.remove', 'ops.client.unlock', 'ops.client.revoke_sessions', 'ops.client.disable', 'ops.staff.new', 'ops.approval.reject', 'ops.approval.cancel', 'client.session_revoked', 'ops.session_revoked']) {
    assert.ok(names.has(name), `no audit entry for ${name}`);
  }
  const reset = (await audit('ops.client.reset_authenticator')).find((entry) => entry.outcome === 'success');
  assert.equal(reset?.detail.identityVerification, 'Called back on the number on file');
  assert.equal(reset?.target?.label, AMIRA);
  // A refusal after the target was known is logged against that target.
  assert.equal((await admin.browser.post(`/ops/users/${ben}/reset-authenticator`, { verification: 'Called back on the number on file' })).status, 400, 'Ben has never activated: there is nothing to reset');
  const refusal = (await audit('ops.client.reset_authenticator')).find((entry) => entry.outcome === 'failure');
  assert.equal(refusal?.target?.label, BEN);
});

twoPerson('ops: CSRF. A post without the field, with a wrong field or from another site is refused; the pre-login anchor is the server\'s own', async () => {
  h = await harness();
  const { admin, second: other } = await pair();
  const form = { name: 'Tideway Ltd', provider: 'provider-b', providerAccountId: 'S00002' };
  const nothingChanged = async () => assert.equal((await h.stores.directory.listCompanies()).length + (await h.stores.ops.approvals.list()).length, 2);

  assert.equal((await admin.browser.request('POST', '/ops/companies', { ...form })).status, 403);
  assert.equal((await admin.browser.request('POST', '/ops/companies', { ...form, _csrf: 'f'.repeat(64) })).status, 403);
  // Another session's field does not fit this session.
  assert.equal((await admin.browser.request('POST', '/ops/companies', { ...form, _csrf: other.browser.csrf })).status, 403);
  assert.equal((await admin.browser.post('/ops/companies', { ...form }, { 'sec-fetch-site': 'cross-site' })).status, 403);
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
  // (Both steps: the form, then its confirmation. A valid confirmation token does not excuse the CSRF checks.)
  const shown = await fresh.browser.post('/ops/companies', form, { 'sec-fetch-site': 'same-origin' });
  const token = confirmTokenOf(shown.body) as string;
  assert.equal((await fresh.browser.request('POST', '/ops/companies', { ...form, _confirm: token })).status, 403, 'a confirmation token without the CSRF field');
  assert.equal((await fresh.browser.post('/ops/companies', { ...form, _confirm: token }, { 'sec-fetch-site': 'cross-site' })).status, 403, 'a confirmation token from another site');
  assert.equal((await fresh.browser.post('/ops/companies', { ...form, _confirm: token }, { 'sec-fetch-site': 'same-origin' })).status, 303);
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

twoPerson('ops: an admin cannot demote, disable or reset themselves, and the last active admin cannot be removed', async () => {
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

twoPerson('ops: company and client set up with approval; the link goes by email only; the client sees only that company; reset kills old credentials', async () => {
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
  assert.match(detail, /ends their \d+ active sessions?/);
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

twoPerson('ops: disable ends sessions and blocks sign-in and activation; unlock and revoke-all work; removing a membership takes effect', async () => {
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

twoPerson('H1: a lone staff member cannot obtain a working client credential by any console path', async () => {
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
  assert.deepEqual(h.outbox.sent.filter((message) => /#code=/.test(message.text)).map((message) => message.to).sort(), [AMIRA, BEN]);
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

twoPerson('four-eyes: requests wait for a different staff member, can be rejected or cancelled, expire after 24 hours and are carried out once', async () => {
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
  assert.match((await admin.browser.get('/ops/approvals')).body, /Email an activation link to client Ben Okoro &lt;ben@castlebrook\.example&gt;/);
  h.clock.advance(24 * 60 * 60_000 + 1);
  const late = await staff('late@globalconnect.example', 'ops');
  assert.equal((await late.act(`/ops/approvals/${expired}/approve`)).status, 409);
  assert.deepEqual((await h.stores.ops.approvals.list()).map((item) => item.status).sort(), ['cancelled', 'expired', 'rejected']);
  assert.equal(h.outbox.sent.length, 0, 'none of the three took effect');

  // Approved: carried out exactly once, even if two approvals arrive together.
  const other = await staff('other@globalconnect.example', 'ops');
  const fresh = idOf((await late.act('/ops/users/usr_ben/activation-link')).location);
  const third = await staff('third@globalconnect.example', 'ops');
  // Both have the confirmation page open and press Confirm together.
  const tokens = [confirmTokenOf((await other.browser.post(`/ops/approvals/${fresh}/approve`)).body) as string, confirmTokenOf((await third.browser.post(`/ops/approvals/${fresh}/approve`)).body) as string];
  const [a, b] = await Promise.all([other.browser.post(`/ops/approvals/${fresh}/approve`, { _confirm: tokens[0] as string }), third.browser.post(`/ops/approvals/${fresh}/approve`, { _confirm: tokens[1] as string })]);
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

test('single-person mode (set explicitly): an action takes effect at once, for the one member of staff who starts it', async () => {
  h = await harness({ fourEyes: false });
  const admin = await staff();
  const reply = await admin.act('/ops/users/usr_ben/activation-link');
  assert.equal(reply.location, '/ops/users/usr_ben?done=mailed_sent');
  assert.deepEqual(h.outbox.sent.map((message) => message.to), [BEN]);
  // Still no link on the screen.
  assert.doesNotMatch((await admin.browser.get(reply.location)).body, LINK_OR_CODE);
});

twoPerson('H2: a company can be mapped only by an ops admin, with approval, to a real provider account that no other company uses', async () => {
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
    ['ops.activation', 'success'], ['ops.sign_in', 'success'],
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
  assert.deepEqual(Object.keys(created.json).sort(), ['email', 'expiresAt', 'sentTo']);
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

twoPerson('ops: a company\'s payment approval rule is changed by request, approved only by an ops admin, audited, and the console warns when nobody could approve', async () => {
  h = await harness();
  const admin = await staff();
  const olu = await staff('olu@globalconnect.example', 'ops');
  const pat = await staff('pat@globalconnect.example', 'ops');
  await h.activate(AMIRA);
  const rule = async () => (await h.stores.directory.getCompany('co_northfield'))?.approvalsRequired;
  assert.deepEqual([await rule(), (await h.stores.directory.getCompany('co_castlebrook'))?.approvalsRequired], [1, 1], 'the two demo companies start with one approval');

  // The page says what the rule is and warns: Amira is the only active person, so her payments could not be approved by anyone.
  const page = await admin.browser.get('/ops/companies/co_northfield');
  assert.match(page.body, /<h2>Payment approvals<\/h2><p>Now: <strong>1 required<\/strong>/);
  assert.match(page.body, /<p class="warn">NOT ENOUGH APPROVERS: with 1 approval required, a payment created by Amira Shah could not be approved by anyone/);
  assert.match((await admin.browser.get('/ops/companies')).body, /1 required <span class="tag[^"]*">Not enough approvers<\/span>/);
  // With a second active approver the warning goes.
  await h.activate(DANA);
  assert.doesNotMatch((await admin.browser.get('/ops/companies/co_northfield')).body, /NOT ENOUGH APPROVERS/);
  // (Castlebrook now has the gap instead: Dana is active there and Ben, the only other person, is not.)
  assert.match((await admin.browser.get('/ops/companies')).body, /Northfield Trading Ltd<\/a><\/td><td>[^<]+<\/td><td>[^<]+<\/td><td>1 required<\/td>[^]*Castlebrook Imports Ltd[^]*1 required <span class="tag bad">Not enough approvers/);

  // An ops user asks for two approvals. Nothing changes yet; the request says what it does and does not affect, and warns.
  const asked = await olu.act('/ops/companies/co_northfield/approvals', { approvalsRequired: '2' });
  assert.equal(asked.status, 303, asked.body.slice(-300));
  const id = idOf(asked.location);
  assert.equal(await rule(), 1);
  const request = await h.stores.ops.approvals.get(id);
  assert.match(request?.summary ?? '', /Change payment approvals for company “Northfield Trading Ltd” \(co_northfield\) from 1 to 2 required\. A stricter rule applies at once, to payments already waiting for approval as well as to new ones\./);
  assert.match(request?.warnings.join(' ') ?? '', /NOT ENOUGH APPROVERS: with 2 approvals required/);
  assert.match((await admin.browser.get(`/ops/approvals/${id}`)).body, /A stricter rule applies at once/);
  // Another ops USER cannot approve it, nor can the requester; an ops admin can.
  assert.equal((await pat.act(`/ops/approvals/${id}/approve`)).status, 403);
  assert.equal((await olu.act(`/ops/approvals/${id}/approve`)).status, 403);
  assert.equal(await rule(), 1);
  assert.equal((await admin.act(`/ops/approvals/${id}/approve`)).status, 303);
  assert.equal(await rule(), 2);
  const entry = (await audit('ops.company.approvals')).find((item) => item.outcome === 'success');
  assert.deepEqual([entry?.target?.id, entry?.detail.from, entry?.detail.to, entry?.detail.approvedBy, entry?.actor.label], ['co_northfield', '1', '2', admin.email, olu.email]);

  // Asking for the rule it already has, or a number that is not 0, 1 or 2, is refused.
  assert.equal((await olu.act('/ops/companies/co_northfield/approvals', { approvalsRequired: '2' })).status, 400);
  assert.equal((await olu.act('/ops/companies/co_northfield/approvals', { approvalsRequired: '3' })).status, 400);
  // Two requests made under the same rule: once one is carried out, the other is stale and changes nothing.
  const toZero = idOf((await olu.act('/ops/companies/co_northfield/approvals', { approvalsRequired: '0' })).location);
  const toOne = idOf((await pat.act('/ops/companies/co_northfield/approvals', { approvalsRequired: '1' })).location);
  assert.match((await h.stores.ops.approvals.get(toZero))?.warnings.join(' ') ?? '', /Payments created from now on will be sent without a second person/);
  assert.equal((await admin.act(`/ops/approvals/${toOne}/approve`)).status, 303);
  assert.equal((await admin.act(`/ops/approvals/${toZero}/approve`)).status, 409);
  assert.equal(await rule(), 1);
  // A new company starts with one approval, and renaming or re-pointing a company leaves its rule alone.
  await h.policy('co_castlebrook', 2);
  const second = await staff('second@globalconnect.example', 'ops_admin');
  await fourEyes(admin, second, '/ops/companies', { name: 'Tideway Ltd', provider: 'provider-b', providerAccountId: 'S00002' });
  await fourEyes(admin, second, '/ops/companies/co_castlebrook', { name: 'Castlebrook Imports (UK) Ltd', provider: 'provider-b', providerAccountId: 'S00003' });
  const companies = await h.stores.directory.listCompanies();
  assert.equal(companies.find((company) => company.name === 'Tideway Ltd')?.approvalsRequired, 1);
  assert.deepEqual([companies.find((company) => company.id === 'co_castlebrook')?.providerAccountId, companies.find((company) => company.id === 'co_castlebrook')?.approvalsRequired], ['S00003', 2]);
});

twoPerson('ops confirmation: says exactly what will happen, works once, marks high-impact changes, and asks for the password only for the highest-impact approvals', async () => {
  h = await harness();
  const admin = await staff();
  const boss = await staff('boss@globalconnect.example', 'ops_admin');
  const olu = await staff('olu@globalconnect.example', 'ops');
  await h.activate(AMIRA);
  const post = (who: Staff, url: string, form: Record<string, string> = {}) => who.browser.post(url, form);
  const page = async (who: Staff, url: string, form: Record<string, string> = {}) => {
    const reply = await post(who, url, form);
    assert.equal(reply.status, 200, `${url}: ${reply.body.slice(-300)}`);
    return { body: reply.body, token: confirmTokenOf(reply.body) as string, danger: /class="card narrow confirm danger"/.test(reply.body), password: /type="password" name="password"/.test(reply.body) };
  };

  // --- A single-person action: who, what, the consequence; then once only. -------------------------------
  const revoke = await page(olu, '/ops/users/usr_amira/revoke-sessions');
  assert.match(revoke.body, /<h2>Revoke all sessions of client Amira Shah &lt;amira@northfield\.example&gt;<\/h2>/);
  assert.match(revoke.body, /Ends their \d+ active sessions?\. They are signed out everywhere/);
  assert.match(revoke.body, /This takes effect as soon as you confirm\./);
  assert.deepEqual([revoke.danger, revoke.password], [false, false]);
  assert.equal((await post(olu, '/ops/users/usr_amira/revoke-sessions', { _confirm: revoke.token })).status, 303);
  const count = (await audit('ops.client.revoke_sessions')).length;
  const replay = await post(olu, '/ops/users/usr_amira/revoke-sessions', { _confirm: revoke.token });
  assert.equal(replay.status, 409, 'the same confirmation a second time');
  assert.match(replay.body, /already been used\. Nothing more was done/);
  assert.equal((await audit('ops.client.revoke_sessions')).length, count);
  // The used token is remembered in the database, so a restart does not make it usable again.
  assert.equal(await h.stores.ops.confirmations.count({}), 1);

  // --- Destructive: marked, and the consequence is stated. --------------------------------------------------
  const disable = await page(olu, '/ops/users/usr_dana/disable');
  assert.equal(disable.danger, true);
  assert.match(disable.body, /High-impact change\. Read this before you confirm\./);
  assert.match(disable.body, /<h2>Disable client Dana Reid &lt;dana@adviser\.example&gt;<\/h2><p class="warn">They cannot sign in until re-enabled/);
  assert.match(disable.body, /<button class="danger">Confirm<\/button><a class="button quiet" href="\/ops\/users\/usr_dana">Cancel<\/a>/);
  // Cancel is a plain link: nothing was done.
  assert.equal((await h.stores.directory.getUser('usr_dana'))?.disabledAt ?? null, null);

  // --- A request: old -> new value, company with its id, and that it only asks. ----------------------------
  const role = await page(olu, '/ops/users/usr_amira/memberships', { companyId: 'co_northfield', role: 'approver' });
  assert.match(role.body, /<h2>Change the role of Amira Shah &lt;amira@northfield\.example&gt; in “Northfield Trading Ltd” \(co_northfield\) from admin to approver<\/h2>/);
  assert.match(role.body, /This only makes a request\. Nothing changes until a second staff member approves it\./);
  assert.deepEqual([role.danger, role.password], [false, false]);
  // What is shown is what is confirmed: if the role is changed underneath, the old confirmation is not accepted.
  await h.stores.directory.setMembership({ userId: 'usr_amira', companyId: 'co_northfield', role: 'creator' });
  const stale = await post(olu, '/ops/users/usr_amira/memberships', { companyId: 'co_northfield', role: 'approver', _confirm: role.token });
  assert.equal(stale.status, 409);
  assert.match(stale.body, /what it would do has changed since it was shown[^]*from creator to approver/);
  assert.equal((await h.stores.ops.approvals.list()).length, 0);
  // An email: the masked address, and that the old link stops working.
  const link = await page(olu, '/ops/users/usr_ben/activation-link');
  assert.match(link.body, /will be sent to b…@castlebrook\.example\. Any earlier link stops working\. The link is never shown to staff\./);
  const asked = await post(olu, '/ops/users/usr_ben/activation-link', { _confirm: link.token });
  assert.equal(asked.status, 303);

  // --- Approving an ordinary request: confirmation, no password. --------------------------------------------
  const approveLink = await page(admin, `/ops/approvals/${idOf(asked.location)}/approve`);
  assert.match(approveLink.body, /<h2>Approve and carry out: Email an activation link to client Ben Okoro/);
  assert.match(approveLink.body, /Requested by olu@globalconnect\.example on /);
  assert.deepEqual([approveLink.danger, approveLink.password], [false, false]);
  assert.equal((await post(admin, `/ops/approvals/${idOf(asked.location)}/approve`, { _confirm: approveLink.token })).status, 303);

  // --- The highest-impact approvals ask for the approver's PASSWORD (never a code). -------------------------
  const requests: [string, string, Record<string, string>, RegExp][] = [
    ['client authenticator reset', '/ops/users/usr_amira/reset-authenticator', { verification: 'Called back on the number on file' }, /How their identity was verified: “Called back on the number on file”/],
    ['staff role change', `/ops/staff/${olu.id}/role`, { role: 'ops_admin' }, /from ops to ops_admin/],
    ['company create', '/ops/companies', { name: 'Tideway Ltd', provider: 'provider-b', providerAccountId: 'S00002' }, /Create company “Tideway Ltd”/],
    ['payment-approval rule to 0', '/ops/companies/co_northfield/approvals', { approvalsRequired: '0' }, /from 1 to 0 required[^]*Payments created from now on will be sent without a second person/],
    ['payment-approval rule to 2', '/ops/companies/co_castlebrook/approvals', { approvalsRequired: '2' }, /from 1 to 2 required[^]*Payments created from now on will be held until 2 other people have approved them \(it was 1\)/],
    ['company re-point', '/ops/companies/co_castlebrook', { name: 'Castlebrook Imports Ltd', provider: 'provider-b', providerAccountId: 'S00003' }, /Re-point company “Castlebrook Imports Ltd” \(co_castlebrook\) from Provider B[^<]*account S00001, to Provider B[^<]*account S00003/],
  ];
  for (const [what, url, form, says] of requests) {
    const ask = await page(admin, url, form);
    assert.match(ask.body, says, what);
    // Making the request is marked high-impact, but it is the APPROVAL that carries it out and takes the password.
    assert.deepEqual([ask.danger, ask.password], [true, false], what);
    const made = await post(admin, url, { ...form, _confirm: ask.token });
    assert.equal(made.status, 303, `${what}: ${made.body.slice(-300)}`);
    const approveUrl = `/ops/approvals/${idOf(made.location)}/approve`;
    const approve = await page(boss, approveUrl);
    assert.deepEqual([approve.danger, approve.password], [true, true], what);
    assert.doesNotMatch(approve.body, /name="code"/);
    const pending = async () => (await h.stores.ops.approvals.get(idOf(made.location)))?.status;
    // No password, a wrong one, and somebody else's: refused, nothing done, and logged.
    for (const password of [undefined, 'not my password at all', PASSWORD]) {
      const refused = await post(boss, approveUrl, { _confirm: approve.token, ...(password ? { password } : {}) });
      assert.equal(refused.status, 400, `${what} with password ${password}`);
      assert.match(refused.body, /That is not your password\. Nothing was done/);
      assert.equal(await pending(), 'pending');
    }
    assert.ok((await audit('ops.password_check')).some((entry) => entry.outcome === 'failure' && entry.actor.id === boss.id));
    // The wrong guesses did not use the confirmation up: with the right password it goes through, once.
    await h.stores.ops.attempts.deleteWhere(() => true);
    assert.equal((await post(boss, approveUrl, { _confirm: approve.token, password: OPS_PASSWORD })).status, 303, what);
    assert.equal(await pending(), 'approved');
    assert.equal((await post(boss, approveUrl, { _confirm: approve.token, password: OPS_PASSWORD })).status, 409);
    await boss.browser.get('/ops/approvals');
  }
  // A plain rename of a company is not in that set: confirmation only.
  const rename = idOf((await admin.act('/ops/companies/co_northfield', { name: 'Northfield Trading (UK) Ltd', provider: 'provider-a', providerAccountId: 'sample-account-0001', providerContactId: 'sample-contact-0001' })).location);
  assert.equal((await page(boss, `/ops/approvals/${rename}/approve`)).password, false);

  // Guessing the password from an unattended browser is counted and locks, like sign-in.
  const invite = idOf((await admin.act('/ops/staff', { name: 'New Person', email: 'new.person@globalconnect.example', role: 'ops' })).location);
  const guess = await page(boss, `/ops/approvals/${invite}/approve`);
  let status = 0;
  for (let attempt = 0; attempt < 8 && status !== 429; attempt += 1) status = (await post(boss, `/ops/approvals/${invite}/approve`, { _confirm: guess.token, password: `guess number ${attempt}` })).status;
  assert.equal(status, 429);
  assert.equal((await post(boss, `/ops/approvals/${invite}/approve`, { _confirm: guess.token, password: OPS_PASSWORD })).status, 429, 'locked: even the right password waits');
  assert.equal((await h.stores.ops.approvals.get(invite))?.status, 'pending');

  // The reset still needs its identity-verification note: without it there is not even a confirmation page.
  assert.equal((await post(admin, `/ops/staff/${olu.id}/reset-authenticator`, {})).status, 400);
  // And the idle limit is the server's: ten minutes without a request and the next one, even a Confirm, is refused.
  const idle = await page(admin, '/ops/users/usr_dana/disable');
  h.clock.advance(4 * 60_000);
  await olu.browser.get('/ops/users');
  h.clock.advance(6 * 60_000 + 1);
  assert.equal((await post(admin, '/ops/users/usr_dana/disable', { _confirm: idle.token })).status, 401);
  assert.equal((await h.stores.directory.getUser('usr_dana'))?.disabledAt ?? null, null);
});

twoPerson('ops behind the demo gate: sign-in, CSRF and the confirmation flow work unchanged, and the gate cookie is not a staff session', async () => {
  h = await harness({ demoAccessPassword: 'orchard-lantern-47-quay' });
  // Without the gate cookie there is no console at all.
  assert.equal((await h.app.inject({ method: 'GET', url: '/ops/login', headers: { accept: 'text/html' } })).headers.location, '/demo-access?next=%2Fops%2Flogin');
  const opened = await h.app.inject({ method: 'POST', url: '/demo-access', headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: 'password=orchard-lantern-47-quay&next=%2Fops' });
  const gate = String([opened.headers['set-cookie']].flat()[0]).split(';')[0] as string;
  // From here every request carries the gate cookie beside whatever cookies the console itself sets.
  const inject = h.app.inject.bind(h.app) as (options: any) => Promise<any>;
  (h.app as any).inject = (options: any) => inject({ ...options, headers: { ...options.headers, cookie: [options.headers?.cookie, gate].filter(Boolean).join('; ') } });

  // The gate cookie alone is nobody: the console still asks for a staff sign-in.
  assert.equal((await h.app.inject({ method: 'GET', url: '/ops/users' })).headers.location, '/ops/login');
  const admin = await staff();
  const olu = await staff('olu@globalconnect.example', 'ops');
  await h.activate(AMIRA);
  assert.equal((await admin.browser.get('/ops/users')).status, 200);
  // CSRF is as strict as ever.
  assert.equal((await olu.browser.request('POST', '/ops/users/usr_amira/revoke-sessions', {})).status, 403);
  assert.equal((await olu.browser.post('/ops/users/usr_amira/revoke-sessions', {}, { 'sec-fetch-site': 'cross-site' })).status, 403);
  // Confirmation page, then Confirm; a request and its approval by a second person.
  const shown = await olu.browser.post('/ops/users/usr_amira/revoke-sessions');
  assert.match(shown.body, /<h2>Revoke all sessions of client Amira Shah/);
  assert.equal((await olu.act('/ops/users/usr_amira/revoke-sessions')).status, 303);
  const asked = await olu.act('/ops/users/usr_ben/activation-link');
  assert.equal(asked.status, 303);
  assert.equal((await admin.act(`/ops/approvals/${idOf(asked.location)}/approve`)).status, 303);
  assert.equal(h.outbox.sent.length, 1);
  assert.equal((await admin.browser.post('/ops/logout')).status, 303);
  assert.equal((await admin.browser.get('/ops/users')).location, '/ops/login', 'signed out of the console, still through the gate');
});

void DANA;

// --- Review of fe9d053 -----------------------------------------------------------------------------------

/** A client of Northfield, signed in to the client API. */
async function client(email: string) {
  const secret = (await h.activate(email)).secret;
  const reply = await h.login(email, secret);
  const token = reply.json.token as string;
  if (!reply.json.session) assert.equal((await h.call('POST', '/v1/session/company', { token, body: { companyId: 'co_northfield' } })).status, 200);
  const grant = async (action: string, payload: unknown) => (await h.call('POST', '/v1/step-up', { token, body: { action, payload, code: h.freshCode(secret) } })).json.token as string;
  return { token, secret, grant };
}
const NORTHFIELD = { name: 'Northfield Trading Ltd', provider: 'provider-a', providerAccountId: 'sample-account-0001', providerContactId: 'sample-contact-0001' };
const MOVED = { ...NORTHFIELD, providerAccountId: 'sample-account-0003', providerContactId: 'sample-contact-0003' };

test('H3: a company edit that is waiting for the provider does not undo a deactivation or a change of approval rule made meanwhile', async () => {
  h = await harness({ fourEyes: false });
  const { admin, second } = await pair();
  const real = h.registry.accountExists.bind(h.registry);
  // Confirming runs the checks twice: once to describe the action again, once to carry it out. The second is held.
  let hold = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let waiting!: () => void;
  const reached = new Promise<void>((resolve) => (waiting = resolve));
  h.registry.accountExists = async (...args: Parameters<typeof real>) => {
    if (hold > 0 && (hold -= 1) === 0) {
      waiting();
      await gate;
    }
    return real(...args);
  };
  const page = await admin.browser.post('/ops/companies/co_northfield', MOVED);
  const token = confirmTokenOf(page.body);
  assert.ok(token, page.body.slice(-300));
  // The edit is confirmed and is now asking the provider whether the new account exists...
  hold = 2;
  const editing = admin.browser.post('/ops/companies/co_northfield', { ...MOVED, _confirm: token as string, password: OPS_PASSWORD });
  await reached;
  // ...and while it waits, a colleague deactivates the company and its approval rule is raised.
  assert.equal((await second.act('/ops/companies/co_northfield/deactivate')).status, 303);
  assert.equal((await second.act('/ops/companies/co_northfield/approvals', { approvalsRequired: '2' })).status, 303);
  const between = await h.stores.directory.getCompany('co_northfield');
  assert.ok(between?.deactivatedAt);
  assert.equal(between?.approvalsRequired, 2);
  release();
  assert.equal((await editing).status, 303);
  // Only what the edit is about was written.
  const after = await h.stores.directory.getCompany('co_northfield');
  assert.deepEqual([after?.providerAccountId, after?.providerContactId, after?.deactivatedAt, after?.approvalsRequired], ['sample-account-0003', 'sample-contact-0003', between?.deactivatedAt, 2]);

  // The store itself: a change is applied to the row as it is at that moment, and only the columns that differ are written.
  const directory = h.stores.directory;
  await Promise.all([
    directory.updateCompany('co_castlebrook', (current) => ({ ...current, approvalsRequired: 2 })),
    directory.updateCompany('co_castlebrook', (current) => ({ ...current, deactivatedAt: 5 })),
    directory.updateCompany('co_castlebrook', (current) => ({ ...current, name: 'Castlebrook Imports (UK) Ltd' })),
  ]);
  const castlebrook = await directory.getCompany('co_castlebrook');
  assert.deepEqual([castlebrook?.approvalsRequired, castlebrook?.deactivatedAt, castlebrook?.name], [2, 5, 'Castlebrook Imports (UK) Ltd']);
  // Saving a company is for NEW companies only: it can no longer overwrite one that exists.
  await assert.rejects(async () => directory.saveCompany({ ...(castlebrook as NonNullable<typeof castlebrook>), deactivatedAt: null }));
  assert.equal((await directory.getCompany('co_castlebrook'))?.deactivatedAt, 5);
});

twoPerson('M3: a company cannot be re-pointed, by request or by approval, while one of its payments is being sent; the request says how many are waiting', async () => {
  h = await harness();
  const { admin, second } = await pair();
  const amira = await client(AMIRA);
  const dana = await client(DANA);
  const body = { beneficiaryId: 'sample-beneficiary-harbour', amount: '125.00', currency: 'GBP', reference: 'INV-1', reason: 'Invoice' };
  const key = 'key-repoint-000001';
  const created = await h.call('POST', '/v1/payments', { token: amira.token, body, headers: { 'idempotency-key': key, 'x-step-up-token': await amira.grant('payment.create', { ...body, idempotencyKey: key }) } });
  assert.equal(created.json.status, 'awaiting_approval');
  const id = created.json.id as string;

  // Asked for while the payment only waits for approval: allowed, and the request says what happens to that payment.
  const asked = await admin.act('/ops/companies/co_northfield', MOVED);
  assert.match(asked.location, /^\/ops\/approvals\//);
  const request = idOf(asked.location);
  assert.match((await h.stores.ops.approvals.get(request))?.warnings.join(' ') ?? '', /1 payment of this company is waiting for approval\. After the re-point it can no longer be approved/);
  assert.match((await second.browser.get(asked.location)).body, /1 payment of this company is waiting for approval/);

  // The payment is approved and sent, and the provider's answer is lost: it is "being sent".
  h.providerA.paymentFault = 'lost_response';
  const approved = await h.call('POST', `/v1/payments/${id}/approve`, { token: dana.token, headers: { 'x-step-up-token': await dana.grant('payment.approve', { paymentId: id }) } });
  assert.equal(approved.json.status, 'unknown');
  assert.equal((await h.stores.payments.get(id))?.status, 'sending');
  // Approving the re-point now is refused, nothing is changed, nobody is signed out, and the request waits.
  const refused = await second.act(`/ops/approvals/${request}/approve`);
  assert.equal(refused.status, 409);
  assert.match(refused.body, /1 payment of this company is being sent to the provider and the outcome is not known yet/);
  assert.equal((await h.stores.ops.approvals.get(request))?.status, 'pending');
  assert.equal((await h.stores.directory.getCompany('co_northfield'))?.providerAccountId, 'sample-account-0001');
  assert.equal((await h.call('GET', '/v1/balances', { token: amira.token })).status, 200);
  // A new request is refused outright.
  assert.equal((await second.act('/ops/companies/co_northfield', { ...MOVED, name: 'Northfield Trading Limited' })).status, 409);
  assert.equal((await h.stores.ops.approvals.list()).length, 1);

  // Once the send is settled (found at the provider under its key), the same request can be approved.
  h.clock.advance(31_000);
  assert.deepEqual(await h.held.sweep(), { expired: 0, settled: 1 });
  assert.equal((await h.stores.payments.get(id))?.status, 'sent');
  assert.equal((await second.act(`/ops/approvals/${request}/approve`)).status, 303);
  assert.equal((await h.stores.directory.getCompany('co_northfield'))?.providerAccountId, 'sample-account-0003');
});

twoPerson('M7: one provider account, one company, and one company per name, are rules of the database: two approvals at the same moment make one company', async () => {
  h = await harness({}, undefined, { storeLatency: true });
  const { admin, second } = await pair();
  const count = async () => (await h.stores.directory.listCompanies()).length;
  const race = async (first: Record<string, string>, other: Record<string, string>) => {
    const before = await count();
    const requests: string[] = [];
    for (const form of [first, other]) requests.push(idOf((await admin.act('/ops/companies', form)).location));
    assert.ok(requests.every((id) => id.startsWith('req_')), 'both requests pass the checks while neither company exists');
    const boss = [second, await staff(`boss${before}@globalconnect.example`, 'ops_admin')];
    const replies = await Promise.all(requests.map((id, index) => (boss[index] as Staff).act(`/ops/approvals/${id}/approve`)));
    assert.deepEqual(replies.map((reply) => reply.status).sort(), [303, 409]);
    assert.equal(await count(), before + 1);
    // The one that lost is told why in plain words, did nothing, and waits (it can be rejected).
    const lost = requests[replies.findIndex((reply) => reply.status === 409)] as string;
    assert.match(replies.find((reply) => reply.status === 409)?.body ?? '', /already (used by|the name of) another company|already/i);
    assert.equal((await h.stores.ops.approvals.get(lost))?.status, 'pending');
  };
  // The same provider account under two names; then the same name (but for case, spacing and width) on two accounts.
  await race({ name: 'Tideway Ltd', provider: 'provider-b', providerAccountId: 'S00002' }, { name: 'Tideway Holdings Ltd', provider: 'provider-b', providerAccountId: 'S00002' });
  await race({ name: 'Harbour Mills Ltd', provider: 'provider-b', providerAccountId: 'S00003' }, { name: '  harbour   MILLS ltd', provider: 'provider-a', providerAccountId: 'sample-account-0002', providerContactId: 'sample-contact-0002' });

  // When the check in code is passed by both (here: it is shown the companies as they were a moment earlier), the
  // database refuses the second, and staff are told so in plain words, not shown an error page.
  const late = idOf((await admin.act('/ops/companies', { name: 'Later Ltd', provider: 'provider-a', providerAccountId: 'sample-account-0003', providerContactId: 'sample-contact-0003' })).location);
  // (Whichever of the two accounts the second race left free.)
  const free: Record<string, string> = (await h.stores.directory.listCompanies()).some((item) => item.providerAccountId === 'S00003') ? { provider: 'provider-a', providerAccountId: 'sample-account-0002', providerContactId: 'sample-contact-0002' } : { provider: 'provider-b', providerAccountId: 'S00003' };
  const twin = idOf((await admin.act('/ops/companies', { name: 'late  LTD', ...free })).location);
  assert.ok(late.startsWith('req_') && twin.startsWith('req_'));
  const stale = await h.stores.directory.listCompanies();
  await h.stores.directory.saveCompany({ id: 'co_early', name: 'Early Ltd', providerKey: 'currencycloud', providerAccountId: 'sample-account-0003', providerContactId: 'sample-contact-0003' });
  await h.stores.directory.saveCompany({ id: 'co_late', name: 'Late Ltd', providerKey: 'equals', providerAccountId: 'S00009', providerContactId: '' });
  const listCompanies = h.stores.directory.listCompanies.bind(h.stores.directory);
  h.stores.directory.listCompanies = async () => stale;
  for (const [id, words] of [[late, /provider account/], [twin, /Another company already has that name/]] as const) {
    const refused = await second.act(`/ops/approvals/${id}/approve`);
    assert.equal(refused.status, 409, refused.body.slice(-300));
    assert.match(refused.body, words);
    assert.equal((await h.stores.ops.approvals.get(id))?.status, 'pending');
  }
  h.stores.directory.listCompanies = listCompanies;
  assert.equal(await count(), 6);

  // The same rules straight at the store, where no check in code stands in front of them.
  const directory = h.stores.directory;
  const fresh = { id: 'co_x', name: 'Xylo Ltd', providerKey: 'equals' as const, providerAccountId: 'S00010', providerContactId: '' };
  await directory.saveCompany(fresh);
  await assert.rejects(async () => directory.saveCompany({ ...fresh, id: 'co_y', name: 'Yarrow Ltd' }), (error) => error instanceof StoreConflict && error.what === 'company_account');
  await assert.rejects(async () => directory.saveCompany({ ...fresh, id: 'co_y', name: 'XYLO  ltd', providerAccountId: 'S00011' }), (error) => error instanceof StoreConflict && error.what === 'company_name');
  await assert.rejects(async () => directory.updateCompany('co_castlebrook', (current) => ({ ...current, providerAccountId: 'S00010' })), (error) => error instanceof StoreConflict && error.what === 'company_account');
  await assert.rejects(async () => directory.updateCompany('co_castlebrook', (current) => ({ ...current, name: 'xylo ltd' })), (error) => error instanceof StoreConflict && error.what === 'company_name');
  assert.equal((await directory.getCompany('co_castlebrook'))?.name, 'Castlebrook Imports Ltd');
});

twoPerson('L3: an approved request that was interrupted is neither "approved" nor forgotten: it is finished once, or closed, and both are on record', async () => {
  h = await harness();
  const { admin, second } = await pair();
  const olu = await staff('olu@globalconnect.example', 'ops');
  // The process dies after the change was made and before the request was recorded as done.
  const realMutate = h.stores.ops.approvals.mutate.bind(h.stores.ops.approvals);
  let crash = true;
  h.stores.ops.approvals.mutate = (async (key: string, change: any, audit: any) =>
    realMutate(
      key,
      (current: any) => {
        const next = change(current);
        if (crash && current?.status === 'applying' && next?.status === 'approved') throw new Error('the process stopped here');
        return next;
      },
      audit,
    )) as typeof realMutate;

  const cases: [string, Record<string, string>, string, () => Promise<number>][] = [
    ['/ops/companies', { name: 'Tideway Ltd', provider: 'provider-b', providerAccountId: 'S00002' }, 'ops.company.create', async () => (await h.stores.directory.listCompanies()).filter((item) => item.name === 'Tideway Ltd').length],
    ['/ops/users', { name: 'Chidi Eze', email: 'chidi@tideway.example', company1: 'co_northfield', role1: 'creator' }, 'ops.client.create', async () => ((await h.stores.directory.findUserByEmail('chidi@tideway.example')) ? 1 : 0)],
    ['/ops/staff', { name: 'New Colleague', email: 'new@globalconnect.example', role: 'ops' }, 'ops.staff.invite', async () => ((await h.stores.ops.users.findByEmail('new@globalconnect.example')) ? 1 : 0)],
  ];
  for (const [url, form, action, made] of cases) {
    crash = true;
    const id = idOf((await admin.act(url, form)).location);
    assert.match(id, /^req_/, url);
    const mailsBefore = h.outbox.sent.length;
    assert.equal((await second.act(`/ops/approvals/${id}/approve`)).status, 500, url);
    // The change was made; the request says so honestly: approved, not finished.
    assert.equal(await made(), 1, url);
    assert.equal((await h.stores.ops.approvals.get(id))?.status, 'applying');
    const mails = h.outbox.sent.length - mailsBefore;
    // The approver's decision is already on record; the change itself is not yet recorded as done.
    assert.deepEqual((await audit('ops.approval.begin')).filter((entry) => entry.detail.request === id).map((entry) => [entry.actor.label, entry.detail.action, entry.detail.passwordChecked ?? '']), [[second.email, action.slice(4), PASSWORD_APPROVALS.includes(action) ? 'yes' : '']]);
    assert.equal((await audit(action)).filter((entry) => entry.detail.request === id).length, 0);
    const list = (await second.browser.get('/ops/approvals')).body;
    assert.match(list, /Approved, but not finished/);
    // It cannot be approved, rejected or cancelled as if it were still waiting; the requester and a non-admin cannot finish it.
    assert.equal((await second.act(`/ops/approvals/${id}/approve`)).status, 409);
    assert.equal((await second.act(`/ops/approvals/${id}/reject`)).status, 409);
    assert.equal((await admin.act(`/ops/approvals/${id}/cancel`)).status, 409);
    assert.equal((await admin.act(`/ops/approvals/${id}/resume`)).status, 403);
    assert.equal((await olu.act(`/ops/approvals/${id}/resume`)).status, 403);
    assert.equal((await olu.act(`/ops/approvals/${id}/abandon`)).status, 403);
    // Finishing it does only what is missing: no second company, person or staff member.
    crash = false;
    const page = await second.browser.post(`/ops/approvals/${id}/resume`);
    assert.match(page.body, /It may be partly done\. Carrying it out again repeats only what is missing/);
    assert.equal(/name="password"/.test(page.body), PASSWORD_APPROVALS.includes(action), 'the same password re-check as approving it');
    assert.equal((await second.act(`/ops/approvals/${id}/resume`)).status, 303, url);
    assert.equal(await made(), 1, url);
    // (An invitation whose email may or may not have left is sent again, with a new link; the earlier link stops working.)
    assert.equal(h.outbox.sent.length - mailsBefore, mails + (action === 'ops.staff.invite' ? 1 : 0), url);
    assert.equal((await h.stores.ops.approvals.get(id))?.status, 'approved');
    assert.deepEqual((await audit(action)).filter((entry) => entry.detail.request === id).map((entry) => [entry.outcome, entry.detail.approvedBy]), [['success', second.email]]);
    assert.deepEqual((await audit('ops.approval.approve')).filter((entry) => entry.detail.request === id).map((entry) => entry.detail.resumed), ['yes']);
    assert.equal((await second.act(`/ops/approvals/${id}/resume`)).status, 409);
  }

  // Closing one instead: final, on record with who closed it, and it undoes nothing.
  crash = true;
  const id = idOf((await admin.act('/ops/companies/co_castlebrook/approvals', { approvalsRequired: '2' })).location);
  assert.equal((await second.act(`/ops/approvals/${id}/approve`)).status, 500);
  assert.equal((await h.stores.ops.approvals.get(id))?.status, 'applying');
  assert.equal((await second.act(`/ops/approvals/${id}/abandon`)).status, 303);
  assert.equal((await h.stores.ops.approvals.get(id))?.status, 'rejected');
  assert.equal((await h.stores.directory.getCompany('co_castlebrook'))?.approvalsRequired, 2, 'what was done stays done');
  assert.deepEqual((await audit('ops.approval.abandon')).filter((entry) => entry.outcome === 'success').map((entry) => [entry.actor.label, entry.detail.request, entry.detail.approvedBy, entry.detail.note]), [[second.email, id, second.email, 'closed while being carried out; it may be partly done']]);
  assert.equal((await second.act(`/ops/approvals/${id}/resume`)).status, 409);
  assert.equal((await second.act(`/ops/approvals/${id}/abandon`)).status, 409);

  // A refusal is different from an interruption: when the checks no longer pass, nothing was done and the request simply waits.
  const taken = idOf((await admin.act('/ops/companies', { name: 'Late Ltd', provider: 'provider-b', providerAccountId: 'S00003' })).location);
  await h.stores.directory.saveCompany({ id: 'co_first', name: 'First Ltd', providerKey: 'equals', providerAccountId: 'S00003', providerContactId: '' });
  assert.equal((await second.act(`/ops/approvals/${taken}/approve`)).status, 409);
  assert.equal((await h.stores.ops.approvals.get(taken))?.status, 'pending');
});

// --- Audit of 2ac6785 ---------------------------------------------------------------------------------

twoPerson('N10: finishing or closing an interrupted request takes exactly the checks of approving it, is refused while the approval is still running, and an old one can only be closed', async () => {
  h = await harness();
  const { admin, second } = await pair();
  const boss = await staff('boss@globalconnect.example', 'ops_admin');
  const subject = await staff('subject@globalconnect.example', 'ops_admin');
  const realMutate = h.stores.ops.approvals.mutate.bind(h.stores.ops.approvals);
  let crash = true;
  h.stores.ops.approvals.mutate = (async (key: string, change: any, audit: any) =>
    realMutate(
      key,
      (current: any) => {
        const next = change(current);
        if (crash && current?.status === 'applying' && next?.status === 'approved') throw new Error('the process stopped here');
        return next;
      },
      audit,
    )) as typeof realMutate;
  const interrupted = async (url: string, form: Record<string, string>, approver = boss) => {
    crash = true;
    const id = idOf((await admin.act(url, form)).location);
    assert.match(id, /^req_/, url);
    assert.equal((await approver.act(`/ops/approvals/${id}/approve`)).status, 500);
    assert.equal((await h.stores.ops.approvals.get(id))?.status, 'applying');
    crash = false;
    return id;
  };

  // A request ABOUT a member of staff: that person can no more finish or close it than approve it, though an ops admin.
  const about = await interrupted(`/ops/staff/${subject.id}/role`, { role: 'ops' });
  await h.stores.ops.users.update(subject.id, (current) => ({ ...current, role: 'ops_admin' }));
  for (const action of ['resume', 'abandon']) {
    const refused = await subject.act(`/ops/approvals/${about}/${action}`);
    assert.equal(refused.status, 403, action);
    assert.match(refused.body, /about your own account/);
  }
  assert.match((await subject.browser.get(`/ops/approvals/${about}`)).body, /a different staff member must finish or close it/);
  // The requester can no more close their own than finish it.
  assert.equal((await admin.act(`/ops/approvals/${about}/abandon`)).status, 403);
  assert.equal((await boss.act(`/ops/approvals/${about}/abandon`)).status, 303);

  // The approver has since stopped being an ops admin: what needs an ops admin to approve needs one to finish, or to close.
  const company = await interrupted('/ops/companies', { name: 'Tideway Ltd', provider: 'provider-b', providerAccountId: 'S00002' });
  await h.stores.ops.users.update(boss.id, (current) => ({ ...current, role: 'ops' }));
  for (const action of ['resume', 'abandon']) {
    const refused = await boss.act(`/ops/approvals/${company}/${action}`);
    assert.equal(refused.status, 403, action);
    assert.match(refused.body, /Only an ops admin can approve this kind of request/);
  }
  await h.stores.ops.users.update(boss.id, (current) => ({ ...current, role: 'ops_admin' }));
  // The REQUESTER has since stopped being one: a request only an ops admin may make is not carried out for them.
  await h.stores.ops.users.update(admin.id, (current) => ({ ...current, role: 'ops' }));
  const stale = await boss.act(`/ops/approvals/${company}/resume`);
  assert.equal(stale.status, 409);
  assert.match(stale.body, /can no longer make it/);
  await h.stores.ops.users.update(admin.id, (current) => ({ ...current, role: 'ops_admin' }));
  assert.equal((await boss.act(`/ops/approvals/${company}/resume`)).status, 303);

  // While the approval itself is still running it is not "interrupted": nobody can run it a second time beside it.
  const real = h.registry.accountExists.bind(h.registry);
  let hold = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let reached!: () => void;
  const waiting = new Promise<void>((resolve) => (reached = resolve));
  h.registry.accountExists = async (...args: Parameters<typeof real>) => {
    if (hold > 0 && (hold -= 1) === 0) {
      reached();
      await gate;
    }
    return real(...args);
  };
  const running = idOf((await admin.act('/ops/companies', { name: 'Harbour Mills Ltd', provider: 'provider-b', providerAccountId: 'S00003' })).location);
  const page = await boss.browser.post(`/ops/approvals/${running}/approve`);
  hold = 1;
  const approving = boss.browser.post(`/ops/approvals/${running}/approve`, { _confirm: confirmTokenOf(page.body) as string, password: OPS_PASSWORD });
  await waiting;
  assert.equal((await h.stores.ops.approvals.get(running))?.status, 'applying');
  assert.doesNotMatch((await second.browser.get('/ops/approvals')).body, /Approved, but not finished/);
  assert.match((await second.browser.get(`/ops/approvals/${running}`)).body, /being carried out right now/);
  for (const action of ['resume', 'abandon']) {
    const refused = await second.act(`/ops/approvals/${running}/${action}`);
    assert.equal(refused.status, 409, action);
    assert.match(refused.body, /being carried out right now/);
  }
  release();
  assert.equal((await approving).status, 303);
  assert.equal((await h.stores.directory.listCompanies()).filter((item) => item.name === 'Harbour Mills Ltd').length, 1);

  // Left unfinished for longer than a request may wait: it says so, cannot be finished blind, and can be closed.
  const old = await interrupted(`/ops/staff/${subject.id}/role`, { role: 'ops' });
  h.clock.advance(h.config.approvalTtlMs + 60_000);
  for (const who of [boss, second]) {
    await signIn(who.browser, who.email, who.secret);
    await who.browser.get('/ops/users');
  }
  assert.match((await boss.browser.get(`/ops/approvals/${old}`)).body, /too long ago to finish without looking again\. It can only be closed/);
  const refused = await boss.act(`/ops/approvals/${old}/resume`);
  assert.equal(refused.status, 409);
  assert.match(refused.body, /approved too long ago/);
  assert.equal((await boss.act(`/ops/approvals/${old}/abandon`)).status, 303);
  assert.equal((await h.stores.ops.users.get(subject.id))?.role, 'ops', 'what was done stays done; the request says it may be partly done');
});

twoPerson('a change of a company\'s approval rule is written to the company as it is at that moment, not to a copy read earlier', async () => {
  let deactivate = false;
  h = await harness({}, undefined, {
    storeLatency: true,
    // The company is deactivated by someone else after the request has read it and before the rule is written.
    storeHook: (operation) => {
      if (operation === 'updateCompany' && deactivate) {
        deactivate = false;
        h.stores.db.run("UPDATE companies SET deactivated_at = 5, previous_name = 'Old Name' WHERE id = 'co_northfield'");
      }
    },
  });
  const { admin, second } = await pair();
  const id = idOf((await admin.act('/ops/companies/co_northfield/approvals', { approvalsRequired: '2' })).location);
  deactivate = true;
  assert.equal((await second.act(`/ops/approvals/${id}/approve`)).status, 303);
  assert.equal(deactivate, false, 'the change landed in the gap');
  const company = await h.stores.directory.getCompany('co_northfield');
  assert.deepEqual([company?.approvalsRequired, company?.deactivatedAt, company?.previousName], [2, 5, 'Old Name']);
});

// --- Email ------------------------------------------------------------------------------------------

twoPerson('Mail page: staff see how many emails are waiting, sent, failed or held back, and which failed, without ever seeing a subject, a body, a link or a whole address', async () => {
  h = await harness();
  const { admin, second } = await pair();
  const olu = await staff('olu@globalconnect.example', 'ops');
  await h.activate(AMIRA);
  const send = h.outbox.send.bind(h.outbox);
  let failing = false;
  h.outbox.send = async (message) => {
    if (failing) throw Object.assign(new Error(`could not deliver ${message.text}`), { code: 'ETIMEDOUT' });
    return send(message);
  };
  // One that goes, one that fails for good, and more links to one address than its hourly allowance (6).
  await fourEyes(admin, second, '/ops/users/usr_ben/activation-link');
  failing = true;
  await fourEyes(admin, second, '/ops/users/usr_dana/activation-link');
  for (let n = 0; n < 8; n += 1) {
    h.clock.advance(4 * 60 * 60_000);
    await h.mail.pump();
  }
  failing = false;
  for (const who of [admin, second, olu]) {
    await signIn(who.browser, who.email, who.secret);
    await who.browser.get('/ops/users');
  }
  let last = await fourEyes(admin, second, '/ops/users/usr_ben/activation-link');
  // While it is within the allowance the console says "sent", and the audit entry says sentTo...
  assert.match((await second.browser.get(`/ops/approvals/${last.id}`)).body, /An activation email was sent to b…@castlebrook\.example\./);
  for (let n = 0; n < 6; n += 1) last = await fourEyes(admin, second, '/ops/users/usr_ben/activation-link');
  // ...and the one over it is NOT called sent: the console says it is deferred, and so does the audit log.
  const approvalPage = (await second.browser.get(`/ops/approvals/${last.id}`)).body;
  assert.match(approvalPage, /An activation email for b…@castlebrook\.example was written to the outbox and was <strong>not sent yet \(deferred\)<\/strong>/);
  assert.doesNotMatch(approvalPage, /An activation email was sent to/);
  const linkEntries = (await audit('ops.client.activation_link')).filter((entry) => entry.outcome === 'success' && entry.target?.id === 'usr_ben');
  assert.deepEqual([linkEntries[0]?.detail.email, linkEntries[0]?.detail.queuedFor, linkEntries[0]?.detail.sentTo], ['deferred', 'b…@castlebrook.example', undefined]);
  assert.deepEqual([linkEntries[1]?.detail.email, linkEntries[1]?.detail.sentTo, linkEntries[1]?.detail.queuedFor], ['sent', 'b…@castlebrook.example', undefined]);
  const page = await olu.browser.get('/ops/mail');
  assert.equal(page.status, 200);
  assert.match(page.body, /<dt>Waiting to be sent<\/dt><dd>1 \(the oldest since [^)]+\)<\/dd>/);
  assert.match(page.body, /<dt>Of those, deferred by an hourly allowance \(they WILL be sent\)<\/dt><dd>1<\/dd>/);
  assert.match(page.body, /<dt>Failed<\/dt><dd>1<\/dd>/);
  assert.match(page.body, /<td>d…@adviser\.example<\/td><td>activation: activation\.client<\/td><td>failed<\/td><td>6<\/td><td>ETIMEDOUT<\/td>/);
  assert.match(page.body, /<td>b…@castlebrook\.example<\/td><td>activation: activation\.client<\/td><td>deferred: will be sent when the allowance frees<\/td><td>0<\/td><td>recipient allowance<\/td>/);
  // An hour later it goes, by itself.
  h.clock.advance(60 * 60_000 + 1);
  await h.mail.pump();
  assert.equal(linksTo(BEN).length, 8);
  assert.match(page.body, /No mail server is configured: in development mode every email is printed in the server console/);
  // Nothing of any message: no link or code, no subject, no whole address, none of the transport's own error text.
  assert.doesNotMatch(page.body, LINK_OR_CODE);
  assert.doesNotMatch(page.body, /Activate your|Use this link|could not deliver|dana@adviser\.example|ben@castlebrook\.example/);
  // It is a page for looking: there is nothing to post to.
  assert.equal(h.opsRoutes.filter((route) => route.url.startsWith('/ops/mail')).map((route) => route.method).filter((method) => method !== 'HEAD').join(), 'GET');
  assert.match(page.body, /<a href="\/ops\/mail">Mail<\/a>/);
  // The failure is in the audit log by kind and code, without the address or the content.
  const failed = (await audit('system.mail.failed'))[0];
  assert.deepEqual([failed?.detail.template, failed?.detail.error, failed?.target], ['activation.client', 'ETIMEDOUT', null]);
  assert.ok(!JSON.stringify(await audit()).includes('could not deliver'));
});

// --- Account recovery --------------------------------------------------------------------------------

const HOUR_MS = 60 * 60_000;
const linksTo = (email: string) => h.outbox.sent.filter((message) => message.to === email && /\/activate#code=/.test(message.text));
const noticesTo = (email: string) => h.outbox.sent.filter((message) => message.to === email && /^Security notice/.test(message.subject)).map((message) => message.text);

twoPerson('authenticator reset: once approved NOTHING changes for 24 hours; the client is told at once; signing in cancels it; so can any ops admin; only then are the credentials cleared and the link sent', async () => {
  h = await harness({ authenticatorResetDelayMs: 24 * HOUR_MS });
  const { admin, second } = await pair();
  const olu = await staff('olu@globalconnect.example', 'ops');
  const again = async () => {
    for (const who of [admin, second, olu]) {
      await signIn(who.browser, who.email, who.secret);
      await who.browser.get('/ops/users');
    }
  };
  const amira = await h.activate(AMIRA);
  const dana = await h.activate(DANA);
  const ask = async (userId: string) => fourEyes(admin, second, `/ops/users/${userId}/reset-authenticator`, { verification: 'Called back on the number on file' });

  // The request and its confirmation say there is a delay, and how long.
  const page = await admin.browser.post('/ops/users/usr_amira/reset-authenticator', { verification: 'Called back on the number on file' });
  assert.match(page.body, /Once approved, a warning is emailed to the client and shown to them in the app\. NOTHING changes until 24 hours after the mail server has ACCEPTED that warning \(if the warning cannot be delivered, the reset waits\): their current credentials go on working, and the reset is cancelled if a code from their authenticator is accepted \(signing in, a step-up, a password change\), if they use the “this was not me” link in the warning email, or if an ops admin cancels it/);

  // --- 1. Approved: the client is told, nothing else happens.
  const first = await ask('usr_amira');
  assert.equal(first.record?.status, 'approved');
  const before = await h.stores.directory.getUser('usr_amira');
  assert.ok(before?.activatedAt && before.totpSecret === amira.secret, 'credentials untouched');
  assert.equal(linksTo(AMIRA).length, 0, 'no activation link yet');
  const due = new Date(h.clock.now + 24 * HOUR_MS).toISOString().slice(0, 16).replace('T', ' ');
  assert.equal(noticesTo(AMIRA).length, 1);
  assert.match(noticesTo(AMIRA)[0] ?? '', new RegExp(`It has NOT happened yet\\. It will not happen before ${due} UTC\\. After that your current password, authenticator and recovery codes will stop working`));
  assert.match(noticesTo(AMIRA)[0] ?? '', /sign in now with your current password and authenticator code \(that cancels the reset\)/);
  // Its one link is "this was not me", which can only cancel this reset (recovery.test.ts).
  assert.deepEqual((noticesTo(AMIRA)[0] ?? '').match(/https?:\S+/g)?.map((link) => link.replace(/#token=.*/, '#token=')), ['https://app.globalconnect.example/cancel-reset#token='.replace('https://app.globalconnect.example', h.config.appUrl)]);
  // Staff see it waiting, with when it takes effect; an ops admin is offered Cancel, an ops user is not.
  assert.match((await second.browser.get('/ops/approvals')).body, /Authenticator resets waiting out their delay[^]*Amira Shah[^]*Cancel reset/);
  assert.match((await olu.browser.get('/ops/users/usr_amira')).body, /Authenticator reset waiting[^]*Nothing has changed yet/);
  assert.doesNotMatch((await olu.browser.get('/ops/users/usr_amira')).body, /authenticator-resets\/ar_/);
  // Wrong guesses do not cancel it...
  await h.call('POST', '/v1/auth/login', { body: { email: AMIRA, password: 'not the password' } });
  assert.equal((await h.authenticatorResets.waiting()).length, 1);
  // ...the real owner signing in does: automatically, on record, and she is told.
  h.clock.advance(HOUR_MS);
  assert.equal((await h.login(AMIRA, amira.secret)).status, 200);
  assert.equal((await h.authenticatorResets.waiting()).length, 0);
  const cancelled = (await audit('system.client.reset_authenticator.cancelled'))[0];
  assert.deepEqual([cancelled?.target?.label, cancelled?.detail.by, cancelled?.detail.request], [AMIRA, 'an authenticator code was accepted', first.id]);
  assert.match(noticesTo(AMIRA).at(-1) ?? '', /reset of the authenticator on your account was cancelled\. Nothing was changed/);
  // The delay passes: nothing happens. She keeps her account.
  h.clock.advance(30 * HOUR_MS);
  assert.equal(await h.authenticatorResets.runDue(), 0);
  assert.equal(linksTo(AMIRA).length, 0);
  assert.equal((await h.stores.directory.getUser('usr_amira'))?.totpSecret, amira.secret);

  // --- 2. Cancelled by an ops admin: one is enough, an ops user cannot, and it is confirmed and audited.
  await again();
  const secondAsk = await ask('usr_dana');
  const reset = (await h.authenticatorResets.waiting())[0];
  assert.equal(reset?.requestId, secondAsk.id);
  assert.equal((await olu.act(`/ops/authenticator-resets/${reset?.id}/cancel`)).status, 403);
  const confirmPage = await admin.browser.post(`/ops/authenticator-resets/${reset?.id}/cancel`);
  assert.match(confirmPage.body, /Cancel the authenticator reset of client Dana Reid[^]*The reset will not happen\. Nothing about the account is changed/);
  assert.equal((await h.authenticatorResets.waiting()).length, 1, 'showing the confirmation cancels nothing');
  const done = await admin.act(`/ops/authenticator-resets/${reset?.id}/cancel`);
  assert.match(done.location, /done=reset_cancelled/);
  assert.equal((await h.authenticatorResets.waiting()).length, 0);
  assert.equal((await admin.act(`/ops/authenticator-resets/${reset?.id}/cancel`)).status, 409);
  assert.ok((await audit('ops.authenticator_reset.cancel')).some((entry) => entry.outcome === 'success' && entry.actor.label === admin.email && entry.target?.label === DANA));
  h.clock.advance(30 * HOUR_MS);
  await h.authenticatorResets.runDue();
  assert.equal((await h.stores.directory.getUser('usr_dana'))?.totpSecret, dana.secret);
  assert.equal(linksTo(DANA).length, 0);

  // --- 3. Nobody signs in, nobody cancels: after the delay, and not a minute before, it happens. Once.
  await again();
  await ask('usr_dana');
  h.clock.advance(24 * HOUR_MS - 60_000);
  assert.equal(await h.authenticatorResets.runDue(), 0);
  assert.equal((await h.stores.directory.getUser('usr_dana'))?.totpSecret, dana.secret);
  h.clock.advance(60_000);
  assert.deepEqual(await Promise.all([h.authenticatorResets.runDue(), h.authenticatorResets.runDue()]), [1, 1], 'two runs at once are one run');
  assert.equal(await h.authenticatorResets.runDue(), 0);
  const cleared = await h.stores.directory.getUser('usr_dana');
  assert.deepEqual([cleared?.activatedAt, cleared?.passwordHash, cleared?.totpSecret, cleared?.recoveryCodeHashes], [null, null, null, []]);
  assert.equal(linksTo(DANA).length, 1);
  assert.match(noticesTo(DANA).at(-1) ?? '', /The authenticator on your account has been reset/);
  assert.ok((await audit('system.client.reset_authenticator.completed')).some((entry) => entry.target?.label === DANA));
  // The old credentials are dead; the emailed link activates the account afresh.
  assert.equal((await h.call('POST', '/v1/auth/login', { body: { email: DANA, password: PASSWORD } })).status, 400);
  await activateClient(DANA, 'a brand new long password');

  // A restart in the middle (the credentials cleared, the reset not yet marked done) finishes it at the next run and loses nothing.
  await again();
  await ask('usr_amira');
  h.clock.advance(25 * HOUR_MS);
  const realMutate = h.stores.auth.authenticatorResets.mutate.bind(h.stores.auth.authenticatorResets);
  let crash = true;
  h.stores.auth.authenticatorResets.mutate = (async (key: string, change: any, auditOf: any) => {
    // The process stops at the last step: the reset has been claimed, the credentials cleared and the link queued, but it is not yet marked done.
    return realMutate(key, (current: any) => {
      const next = change(current);
      if (crash && next?.status === 'done') throw new Error('the process stopped here');
      return next;
    }, auditOf);
  }) as typeof realMutate;
  await assert.rejects(h.authenticatorResets.runDue());
  crash = false;
  assert.deepEqual((await h.authenticatorResets.waiting()).map((item) => item.status), ['running']);
  assert.equal((await h.stores.directory.getUser('usr_amira'))?.activatedAt, null);
  assert.equal(await h.authenticatorResets.runDue(), 1);
  assert.equal((await h.stores.directory.getUser('usr_amira'))?.activatedAt, null);
  // The first link (from before the crash) was replaced by the second: one link works.
  assert.equal(linksTo(AMIRA).length, 2);
  await activateClient(AMIRA, 'yet another long password');

  // Outside development the delay cannot be switched off.
  assert.equal(loadConfig({ APP_ENV: 'development' }).authenticatorResetDelayMs, 24 * HOUR_MS);
  assert.equal(loadConfig({ APP_ENV: 'development', AUTHENTICATOR_RESET_DELAY_HOURS: '0' }).authenticatorResetDelayMs, 0);
  const LIVE = { APP_URL: 'https://app.globalconnect.example', CURRENCYCLOUD_LOGIN_ID: 'a', CURRENCYCLOUD_API_KEY: 'b', EQUALS_API_KEY: 'c', OPS_URL: 'https://ops.globalconnect.example', SERVER_SECRET: 'Zq7Lm2Xv9Rt4Wp8Kd3Nf6Hs1Bg5Yc0JaUeOiTxMn', STAFF_EMAIL_DOMAINS: 'globalconnect.example', DATABASE_PATH: '/nonexistent/x.sqlite', DATA_ENCRYPTION_KEY: TEST_DATA_KEY };
  assert.throws(() => loadConfig({ ...LIVE, AUTHENTICATOR_RESET_DELAY_HOURS: '0' }), /AUTHENTICATOR_RESET_DELAY_HOURS must be at least 1 outside development/);
});

test('staff password reset: the same page whoever asks; the emailed link AND a code from the authenticator or a recovery code; only the password changes; a lost authenticator is not self-service', async () => {
  h = await harness();
  const { admin, second } = await pair();
  const fresh = () => new Browser();
  const resetLink = (email: string) => {
    const message = [...h.outbox.sent].reverse().find((item) => item.to === email && /\/ops\/reset#code=/.test(item.text));
    return /\/ops\/reset#code=([A-Z2-7-]+)/.exec(message?.text ?? '')?.[1] ?? '';
  };
  const ask = async (email: string) => {
    const browser = fresh();
    await browser.get('/ops/forgot');
    const reply = await browser.submit('/ops/forgot', { email });
    await h.opsAuth.settle();
    return reply;
  };
  // The sign-in page offers it; the answer is the same page for a real address, an unknown one, and a client's.
  assert.match((await fresh().get('/ops/login')).body, /<a href="\/ops\/forgot">Forgot your password\?<\/a>/);
  const pages = [await ask(admin.email), await ask('nobody@globalconnect.example'), await ask(AMIRA)];
  const strip = (body: string) => body.replace(/name="_csrf" value="[^"]+"/g, '');
  assert.equal(new Set(pages.map((reply) => `${reply.status} ${strip(reply.body)}`)).size, 1);
  assert.match(pages[0]?.body ?? '', /If that address belongs to an active staff account, an email with a link has been sent/);
  assert.match(pages[0]?.body ?? '', /Lost your authenticator and your recovery codes as well\? That cannot be done here/);
  assert.deepEqual([...new Set(h.outbox.sent.filter((message) => /ops\/reset#code=/.test(message.text)).map((message) => message.to))], [admin.email]);
  assert.match(h.outbox.sent.find((message) => /ops\/reset#code=/.test(message.text))?.subject ?? '', /^Reset the password of your Global Connect staff account$/);
  const opened = async (url: string, form: Record<string, string>) => {
    const browser = fresh();
    await browser.get(url);
    return browser.submit(url, form);
  };
  // A second request for the same person: the earlier link STILL works (anyone can ask, so asking kills nothing).
  // From one network, two links an hour for one account; a third request makes none.
  const firstLink = resetLink(admin.email);
  await ask(admin.email);
  const link = resetLink(admin.email);
  assert.ok(link && firstLink && link !== firstLink);
  assert.match((await opened('/ops/reset', { resetCode: firstLink })).body, /Code from your authenticator app, or a recovery code/);
  await ask(admin.email);
  assert.equal(h.outbox.sent.filter((message) => message.to === admin.email && /ops\/reset#code=/.test(message.text)).length, 2, 'the third request in the hour from this network made no link');
  const live = resetLink(admin.email);
  assert.equal(live, link);
  assert.deepEqual((await audit('ops.password_reset.request')).filter((entry) => entry.detail.reason === 'rate_limited').map((entry) => entry.detail.limit), ['source']);
  // No page ever shows the link or the code.
  for (const reply of pages) assert.doesNotMatch(reply.body, LINK_OR_CODE);

  const before = await h.stores.ops.users.get(admin.id);
  const browser = fresh();
  await browser.get('/ops/reset');
  assert.match((await browser.submit('/ops/reset', { resetCode: 'AAAAA-BBBBB-CCCCC-DDDDD' })).body, /That reset link is not valid any more/);
  assert.match((await browser.submit('/ops/reset', { resetCode: live })).body, /Choose a new password[^]*Code from your authenticator app, or a recovery code/);
  // The link without the second factor: refused, nothing changed, nobody signed out.
  for (const code of ['', '000000', OPS_PASSWORD]) {
    // (Submitted from the form each page shows: after a refusal the form, with the link's code in it, is there again.)
    const refused = await browser.submit('/ops/reset/complete', { code, password: 'a completely new staff password' });
    assert.ok(refused.status >= 400, code);
  }
  assert.equal((await h.stores.ops.users.get(admin.id))?.passwordHash, before?.passwordHash);
  assert.equal((await admin.browser.get('/ops/users')).status, 200);
  assert.match((await browser.submit('/ops/reset/complete', { code: h.freshCode(admin.secret), password: 'password1234' })).body, /password/i);
  // With a code: the password changes, only the password; every session of theirs ends; the new password signs in.
  // (A confirmation page open in the session they have now: its token must not outlive that session.)
  const heldToken = confirmTokenOf((await admin.browser.post('/ops/users/usr_ben/disable')).body) as string;
  assert.ok(heldToken);
  const done = await browser.submit('/ops/reset/complete', { code: h.freshCode(admin.secret), password: 'a completely new staff password' });
  assert.deepEqual([done.status, done.location], [303, '/ops/login?done=password_reset']);
  assert.match((await opened('/ops/reset', { resetCode: firstLink })).body, /That reset link is not valid any more/, 'a reset ends every link that was live');
  // The session is gone and so is what its confirmation token could do: in the old session, and carried into a new one.
  assert.equal((await h.stores.ops.sessions.count({ userId: admin.id })), 0);
  assert.equal((await admin.browser.post('/ops/users/usr_ben/disable', { _confirm: heldToken })).status, 401);
  const again = fresh();
  assert.equal((await signIn(again, admin.email, admin.secret, 'a completely new staff password')).status, 303);
  await again.get('/ops/users');
  const carried = await again.post('/ops/users/usr_ben/disable', { _confirm: heldToken });
  assert.equal(carried.status, 409);
  assert.match(carried.body, /That confirmation has expired, or what it would do has changed/);
  assert.equal((await h.stores.directory.getUser('usr_ben'))?.disabledAt ?? null, null);
  const after = await h.stores.ops.users.get(admin.id);
  assert.notEqual(after?.passwordHash, before?.passwordHash);
  assert.deepEqual([after?.totpSecret, after?.recoveryCodeHashes, after?.role], [before?.totpSecret, before?.recoveryCodeHashes, before?.role]);
  assert.equal((await admin.browser.get('/ops/users')).status, 303, 'signed out');
  assert.notEqual((await signIn(fresh(), admin.email, admin.secret)).status, 303);
  assert.equal((await signIn(fresh(), admin.email, admin.secret, 'a completely new staff password')).status, 303);
  assert.match(h.outbox.sent.at(-1)?.subject ?? '', /^Security notice for your Global Connect staff account$/);
  // Once only; and a recovery code does as well as the authenticator.
  // (A replay, not a person at a page: posted by hand.)
  assert.match((await browser.post('/ops/reset/complete', { resetCode: live, code: h.freshCode(admin.secret), password: 'one more long staff password' })).body, /not valid any more/);
  await ask(second.email);
  const other = fresh();
  await other.get('/ops/reset');
  await other.submit('/ops/reset', { resetCode: resetLink(second.email) });
  const recovered = await other.submit('/ops/reset/complete', { code: second.recoveryCodes[0] as string, method: 'recovery', password: 'a completely new staff password 2' });
  assert.equal(recovered.status, 303);
  assert.equal((await h.stores.ops.users.get(second.id))?.recoveryCodeHashes.length, 9);
  // On record, without the code, the link or the password.
  const entries = (await audit('ops.password_reset')).filter((entry) => entry.action === 'ops.password_reset' && entry.outcome === 'success');
  assert.deepEqual(entries.map((entry) => [entry.actor.label, entry.detail.method]).reverse(), [[admin.email, 'totp'], [second.email, 'recovery']]);
  const everything = JSON.stringify(await audit());
  assert.ok(!everything.includes(live) && !everything.includes('a completely new staff password'));
  // The mail server is down for ten minutes: the link is good for half an hour from when its email was ACCEPTED, as for clients.
  h.clock.advance(61 * 60_000);
  const send = h.outbox.send.bind(h.outbox);
  h.outbox.send = async () => {
    throw Object.assign(new Error('mail server down'), { code: 'ETIMEDOUT' });
  };
  const asked = h.clock.now;
  await ask(admin.email);
  h.clock.advance(10 * 60_000);
  h.outbox.send = send;
  await h.mail.pump();
  const late = resetLink(admin.email);
  assert.notEqual(late, live);
  h.clock.advance(25 * 60_000);
  assert.ok(h.clock.now > asked + 30 * 60_000);
  assert.match((await opened('/ops/reset', { resetCode: late })).body, /Code from your authenticator app, or a recovery code/);
  h.clock.advance(6 * 60_000);
  assert.match((await opened('/ops/reset', { resetCode: late })).body, /That reset link is not valid any more/);
  // A disabled member of staff gets no link.
  await h.stores.ops.users.update(second.id, (current) => ({ ...current, disabledAt: 1 }));
  const count = h.outbox.sent.length;
  await ask(second.email);
  assert.equal(h.outbox.sent.length, count);
});

singlePerson('ops: ONE member of staff changes a company’s FX margin, in percentages, after a confirmation page with a worked example; bounded; audited and shown to the other staff; a held quote from before cannot be booked; revenue is for ops admins only', async () => {
  h = await harness();
  const admin = await staff();
  const olu = await staff('olu@globalconnect.example', 'ops');
  const pat = await staff('pat@globalconnect.example', 'ops');
  const { secret } = await h.activate(AMIRA);
  const amira = (await h.login(AMIRA, secret)).json.token as string;
  const clientRate = async () => (await h.call('GET', '/v1/rates/GBP/USD', { token: amira })).json;
  const stored = () => h.stores.margins.get('co_northfield');
  const url = '/ops/companies/co_northfield/margin';
  // The form is filled in and submitted AS THE COMPANY PAGE RENDERS IT, and then the confirmation page's own form.
  const fill = async (who: Staff, fields: Record<string, string>) => {
    await who.browser.get('/ops/companies/co_northfield');
    return who.browser.submit(url, { forwardPercent: '', overrides: '', tiers: '', ...fields });
  };
  const change = async (who: Staff, fields: Record<string, string>) => {
    const shown = await fill(who, fields);
    return shown.status === 200 && confirmTokenOf(shown.body) ? who.browser.submit(url) : shown;
  };

  // Anyone on staff can see the configuration (here: the server default), IN PERCENT, and the form is pre-filled in percent.
  const page = await olu.browser.get('/ops/companies/co_northfield');
  assert.match(page.body, /<h2>FX margin<\/h2><p>Now: <strong>default 0\.50%; forwards as spot<\/strong> \(the server default: this company has no configuration of its own\)/);
  assert.match(page.body, /Default margin, as a percentage \(0\.50 is half of one percent; steps of 0\.01\) <input name="defaultPercent" inputmode="decimal" required maxlength="8" value="0\.50">/);
  assert.match(page.body, /A change takes effect as soon as you confirm it\. It is recorded in your name and listed with the week’s high-impact changes for the other staff\./);
  assert.doesNotMatch(page.body, /basis point|\d bp\b/);
  assert.deepEqual([(await clientRate()).rate, (await clientRate()).buyRate], ['1.2934', '1.3065']);

  // BOUNDS, said in percent. Negative: never. Above 3%: only with the tick-box. Above 20%: never. "50" MEANS 50%.
  const refused = async (fields: Record<string, string>, message: RegExp) => {
    const reply = await change(olu, { defaultPercent: '0.80', ...fields });
    assert.equal(reply.status, 400, `${JSON.stringify(fields)} -> ${reply.status}`);
    assert.match(reply.body, message, JSON.stringify(fields));
  };
  await refused({ defaultPercent: '-0.05' }, /cannot be negative/);
  await refused({ overrides: 'GBPUSD sell -0.10' }, /cannot be negative/);
  await refused({ tiers: '50000 -0.01' }, /cannot be negative/);
  await refused({ defaultPercent: '3.01' }, /The default margin: 3\.01% is above the usual limit of 3\.00%\. If that is really meant, tick/);
  await refused({ forwardPercent: '4.5' }, /4\.50% is above the usual limit of 3\.00%/);
  await refused({ defaultPercent: '20.01', allowHigh: 'yes' }, /20\.01% is above the maximum of 20\.00%/);
  await refused({ defaultPercent: '50' }, /The default margin: 50\.00% is above the maximum of 20\.00%\. \(Margins are percentages: for half a percent write 0\.50\.\)/);
  await refused({ defaultPercent: '50', allowHigh: 'yes' }, /50\.00% is above the maximum of 20\.00%/);
  await refused({ defaultPercent: '0.005' }, /at most two decimal places \(steps of 0\.01%\)/);
  await refused({ defaultPercent: '1,000' }, /at most two decimal places/);
  await refused({ defaultPercent: 'lots' }, /is written as a percentage, like 0\.50 or 0\.50%/);
  await refused({ defaultPercent: '50bp' }, /is written as a percentage/);
  await refused({ overrides: 'GBPUSD sideways 0.10' }, /is not an override/);
  await refused({ overrides: 'GBPGBP sell 0.10' }, /is not a currency pair/);
  await refused({ tiers: '50000 0.90' }, /HIGHER margin \(0\.90%\) than the one before it \(0\.80%\)/);
  assert.equal(await stored(), null);

  // A quote the client is holding from before the change.
  const heldBefore = (await h.call('POST', '/v1/quotes', { token: amira, body: { kind: 'spot', sellCurrency: 'GBP', buyCurrency: 'USD', fixedSide: 'sell', amount: '100.00' } })).json;

  // THE CONFIRMATION PAGE: high-impact, old and new values in percent, the worked example, and NO password and NO second person.
  // (Typed with a comma, a % sign and a space before it: all mean the same.)
  const wanted = { defaultPercent: '0,80', forwardPercent: '1.2%', overrides: 'GBPUSD sell 0.40\nEURUSD both 0,35 %', tiers: '50000 0.6' };
  const confirmation = await fill(olu, wanted);
  assert.equal(confirmation.status, 200);
  assert.match(confirmation.body, /Change the FX margin for company “Northfield Trading Ltd” \(co_northfield\) FROM default 0\.50%; forwards as spot \(the server default\) TO default 0\.80%; forwards 1\.20%; GBPUSD sell 0\.40%; EURUSD both 0\.35%; from GBP 50000: 0\.60%\./);
  assert.match(confirmation.body, /Worked example at the provider’s rate now: selling GBP 10,000 for USD: the client rate changes from 1\.293500 to 1\.294800, so they receive USD 12948\.00 instead of USD 12935\.00; buying GBP 10,000 with USD: the client rate changes from 1\.306500 to 1\.310400, so they pay USD 13104\.00 instead of USD 13065\.00; selling GBP 50,000 for USD: [^;]+; a forward selling GBP 10,000 for USD: /);
  assert.match(confirmation.body, /This takes effect as soon as you confirm\./);
  assert.match(confirmation.body, /Nobody else approves this: it is recorded in your name and shown to the other staff\./);
  assert.match(confirmation.body, /A quote one of them is holding from before the change cannot be booked/);
  assert.match(confirmation.body, /class="danger"/);
  assert.doesNotMatch(confirmation.body, /name="password"|keep the rate|basis point|\d bp\b/);
  // Looking is not doing: nothing has changed.
  assert.equal(await stored(), null);
  assert.equal((await clientRate()).rate, '1.2934');

  // CONFIRMED BY THAT ONE PERSON, an ops USER: done at once. No request is made and nobody else is asked.
  h.clock.advance(1000);
  const done = await olu.browser.submit(url);
  assert.deepEqual([done.status, done.location], [303, '/ops/companies/co_northfield?done=saved']);
  assert.equal((await h.stores.ops.approvals.list()).filter((item) => item.action === 'company.margin').length, 0);
  const now = await stored();
  assert.deepEqual([now?.defaultBps, now?.forwardBps, now?.overrides, now?.tiers, now?.updatedBy, now?.approvedBy], [80, 120, [{ pair: 'GBPUSD', direction: 'sell', bps: 40 }, { pair: 'EURUSD', direction: 'both', bps: 35 }], [{ fromAmount: '50000', bps: 60 }], olu.email, null]);
  assert.deepEqual([(await clientRate()).rate, (await clientRate()).buyRate], ['1.2947', '1.3104']);
  // The quote held under the old margin cannot be booked now.
  const late = await h.call('POST', '/v1/conversions', { token: amira, body: { quoteId: heldBefore.id }, headers: { 'idempotency-key': 'ops-margin-held-0001' } });
  assert.deepEqual([late.status, late.json], [409, { error: { kind: 'quote_expired' } }]);
  // ON RECORD, prominently: its own entry, written with the change, with who, which company, old and new values.
  const changes = await audit('ops.margin.changed');
  assert.deepEqual(changes.map((item) => [item.actor.label, item.target?.id, item.outcome, item.detail.company, item.detail.from, item.detail.to, item.detail.approvedBy]), [
    [olu.email, 'co_northfield', 'success', 'Northfield Trading Ltd', 'default 0.50%; forwards as spot', 'default 0.80%; forwards 1.20%; GBPUSD sell 0.40%; EURUSD both 0.35%; from GBP 50000: 0.60%', 'nobody: one person may change a margin'],
  ]);
  const entry = (await audit('ops.company.margin')).find((item) => item.outcome === 'success');
  assert.deepEqual([entry?.target?.id, entry?.detail.from, entry?.detail.to, entry?.actor.label], ['co_northfield', 'default 0.50%; forwards as spot', 'default 0.80%; forwards 1.20%; GBPUSD sell 0.40%; EURUSD both 0.35%; from GBP 50000: 0.60%', olu.email]);
  assert.match((await pat.browser.get('/ops/companies/co_northfield')).body, new RegExp(`Now: <strong>default 0\\.80%; forwards 1\\.20%; GBPUSD sell 0\\.40%; EURUSD both 0\\.35%; from GBP 50000: 0\\.60%</strong> \\(set [^)]* by ${olu.email}\\)`));
  // The form now shows what is stored, in percent, ready to be edited.
  assert.match((await pat.browser.get('/ops/companies/co_northfield')).body, /name="defaultPercent"[^>]*value="0\.80">[^]*name="forwardPercent"[^>]*value="1\.20">[^]*>GBPUSD sell 0\.40\nEURUSD both 0\.35<\/textarea>[^]*>50000 0\.60<\/textarea>/);
  // THE OTHER STAFF ARE SHOWN IT: the week's high-impact changes, with who and when, on the console's first page (and on Approvals).
  for (const path of ['/ops/users', '/ops/approvals']) {
    assert.match((await admin.browser.get(path)).body, new RegExp(`<h2>High-impact changes in the last 7 days</h2>[^]*<td>${olu.email}</td><td>Change the FX margin for company “Northfield Trading Ltd” \\(co_northfield\\) FROM default 0\\.50%; forwards as spot \\(the server default\\) TO default 0\\.80%; forwards 1\\.20%; GBPUSD sell 0\\.40%; EURUSD both 0\\.35%; from GBP 50000: 0\\.60%\\.`), path);
  }
  assert.match((await pat.browser.get('/ops/users')).body, /High-impact changes in the last 7 days/);
  // The other company is untouched.
  assert.equal(await h.stores.margins.get('co_castlebrook'), null);

  // What is already there is refused; a high margin needs the tick-box, and the confirmation page then warns.
  assert.match((await change(pat, wanted)).body, /That is already this company’s margin/);
  const high = await fill(pat, { defaultPercent: '4.5', allowHigh: 'yes' });
  assert.match(high.body, /This sets a margin of 4\.50%, above the usual limit of 3\.00%\. It was asked for explicitly\./);
  assert.match(high.body, /Allow|allowHigh/);
  // STALE: two people start from the same margin. The second to confirm is refused, because it changed under them.
  h.clock.advance(1000);
  assert.equal((await change(admin, { defaultPercent: '0.70' })).status, 303);
  const stale = await pat.browser.submit(url);
  assert.equal(stale.status, 409);
  assert.match(stale.body, /That confirmation has expired, or what it would do has changed since it was shown\. Nothing was done\. Check what is shown now and confirm again\./);
  assert.match(stale.body, /FROM default 0\.70%; forwards as spot TO default 4\.50%/, 'the page now shows the change from where things really stand');
  assert.equal((await stored())?.defaultBps, 70);
  assert.equal((await audit('ops.margin.changed')).length, 2);

  // REQUESTS LEFT OVER from two-person mode (a database that was started in it before): in single-person mode the
  // member of staff who made one carries it out or cancels it; for the kinds only ops admins decide, so may an ops
  // admin; another ops user may not. What it does is still checked when it is carried out.
  const from = JSON.stringify((await h.rates.marginOf('co_northfield')).config);
  const leftover = (id: string, bps: number, basedOn = from) =>
    h.stores.ops.approvals.put(id, { id, action: 'company.margin', params: { id: 'co_northfield', config: JSON.stringify({ defaultBps: bps, forwardBps: null, overrides: [], tiers: [], tierCurrency: 'GBP' }), from: basedOn, allowHigh: 'no' }, summary: `Change the FX margin to ${bps} (made in two-person mode)`, warnings: [], target: { type: 'company', id: 'co_northfield', label: 'Northfield Trading Ltd' }, requestedBy: { id: olu.id, email: olu.email }, requestedAt: h.clock.now, expiresAt: h.clock.now + 60 * 60_000, status: 'pending', decidedBy: null, decidedAt: null });
  await leftover('req_left1', 15);
  await leftover('req_left2', 25);
  await leftover('req_left3', 35);
  assert.match((await olu.browser.get('/ops/approvals/req_left1')).body, /The console is now in single-person mode: you can carry it out yourself, or cancel it\./);
  assert.match((await olu.browser.get('/ops/users')).body, /<a href="\/ops\/approvals">Approvals<\/a>/, 'something is waiting, so the page is in the navigation');
  assert.equal((await pat.act('/ops/approvals/req_left1/approve')).status, 403, 'another ops user does not carry out somebody else’s request');
  h.clock.advance(1000);
  assert.equal((await olu.act('/ops/approvals/req_left1/approve')).status, 303);
  assert.equal((await stored())?.defaultBps, 15);
  assert.equal((await h.stores.ops.approvals.get('req_left1'))?.status, 'approved');
  // The second was written against the margin as it was: it has moved, so it is refused and stays to be cancelled.
  const moved = await admin.act('/ops/approvals/req_left2/approve');
  assert.match(moved.body, /changed by somebody else since you opened this/);
  assert.equal((await stored())?.defaultBps, 15);
  assert.equal((await olu.act('/ops/approvals/req_left2/cancel')).status, 303);
  assert.equal((await h.stores.ops.approvals.get('req_left2'))?.status, 'cancelled');
  // An ops admin may carry out one of the kinds only ops admins decide (a margin change is one), made by somebody else.
  await leftover('req_left4', 45, JSON.stringify((await h.rates.marginOf('co_northfield')).config));
  h.clock.advance(1000);
  assert.equal((await admin.act('/ops/approvals/req_left4/approve')).status, 303);
  assert.equal((await stored())?.defaultBps, 45);
  assert.equal((await olu.act('/ops/approvals/req_left3/cancel')).status, 303);
  assert.equal((await audit('ops.margin.changed')).length, 4);
  // Nothing is waiting any more: the Approvals page leaves the navigation (it is still there by its address).
  assert.doesNotMatch((await olu.browser.get('/ops/users')).body, /<a href="\/ops\/approvals">Approvals<\/a>/);
  assert.equal((await olu.browser.get('/ops/approvals')).status, 200);
  // After a week the change is no longer on the list (it stays in the audit log).
  h.clock.advance(7 * 24 * 60 * 60_000 + 1000);
  await signIn(admin.browser, admin.email, admin.secret);
  assert.doesNotMatch((await admin.browser.get('/ops/users')).body, /High-impact changes in the last 7 days/);
  h.clock.advance(-(7 * 24 * 60 * 60_000 + 1000));
  for (const person of [admin, olu, pat]) {
    await signIn(person.browser, person.email, person.secret);
    await person.browser.get('/ops/users');
  }

  // REVENUE: a booked conversion appears, with both rates, the margin and the revenue; totals by company and month; CSV. Ops admins only.
  await h.stores.margins.mutate('co_northfield', (current) => (current ? { ...current, defaultBps: 80, overrides: [], tiers: [], forwardBps: null } : current));
  const quote = (await h.call('POST', '/v1/quotes', { token: amira, body: { kind: 'spot', sellCurrency: 'GBP', buyCurrency: 'USD', fixedSide: 'sell', amount: '1000.00' } })).json;
  const booked = await h.call('POST', '/v1/conversions', { token: amira, body: { quoteId: quote.id }, headers: { 'idempotency-key': 'ops-revenue-0001' } });
  assert.equal(booked.status, 200, JSON.stringify(booked.json));
  for (const path of ['/ops/revenue', '/ops/revenue.csv']) {
    for (const person of [olu, pat]) {
      const denied = await person.browser.get(path);
      assert.equal(denied.status, 403, path);
      assert.doesNotMatch(denied.body, /1\.3000|10\.40/);
    }
  }
  assert.doesNotMatch((await olu.browser.get('/ops')).body, /href="\/ops\/revenue"/);
  const revenue = await admin.browser.get('/ops/revenue');
  assert.equal(revenue.status, 200);
  assert.match(revenue.body, /<td>Northfield Trading Ltd<\/td><td>2026-11<\/td><td>1<\/td><td>USD 10\.40<\/td>/);
  assert.match(revenue.body, /sold GBP 1000\.00, bought USD 1289\.60<\/td><td>1\.3000<\/td><td>1\.289600<\/td><td>0\.80% \(0\.80% after rounding\)<\/td><td>USD 10\.40<\/td><td>Booked<\/td>/);
  assert.match((await admin.browser.get('/ops/revenue?company=co_castlebrook')).body, /No conversions in this period/);
  assert.match((await admin.browser.get('/ops/revenue?from=2026-11-11&to=2026-11-11')).body, /USD 10\.40/);
  assert.match((await admin.browser.get('/ops/revenue?from=2026-11-12')).body, /No conversions in this period/);
  assert.equal((await admin.browser.get('/ops/revenue?from=yesterday')).status, 400);
  const exports = (await audit('ops.revenue.export')).length;
  const csv = await admin.browser.get('/ops/revenue.csv?company=co_northfield');
  assert.equal(csv.status, 200);
  assert.match(String(csv.headers['content-type']), /^text\/csv/);
  const lines = csv.body.trim().split('\r\n');
  assert.equal(lines[0], 'booked_at,company_id,company,conversion_id,status,kind,pair,direction,sell_currency,buy_currency,provider_rate,client_rate,provider_sell_amount,provider_buy_amount,client_sell_amount,client_buy_amount,margin_percent,effective_margin_percent,margin_applied_by,revenue_amount,revenue_currency,counted_in_totals,booked_sell_amount,booked_buy_amount,needs_checking');
  assert.equal(lines.length, 2);
  assert.equal(lines[1], `2026-11-11T${new Date(h.clock.now).toISOString().slice(11)},co_northfield,Northfield Trading Ltd,${booked.json.id},booked,spot,GBPUSD,sell,GBP,USD,1.3000,1.289600,1000.00,1300.00,1000.00,1289.60,0.80,0.80,server,10.40,USD,yes,1000.00,1289.60,no`);
  const exported = (await audit('ops.revenue.export'))[0];
  assert.equal((await audit('ops.revenue.export')).length, exports + 1);
  assert.deepEqual([exported?.actor.label, exported?.detail.rows, exported?.detail.company], [admin.email, '1', 'co_northfield']);
  // A conversion the provider booked WITHOUT the client's terms is NOT counted: the total stays what it was, and it is listed by itself with both sets of figures.
  const originalRequest = h.providerA.request.bind(h.providerA);
  h.providerA.request = async (request) => {
    if (request.path !== '/v2/conversions/create') return originalRequest(request);
    const { client_buy_amount: _buy, client_sell_amount: _sell, ...params } = request.params ?? {};
    return originalRequest({ ...request, params });
  };
  const odd = (await h.call('POST', '/v1/quotes', { token: amira, body: { kind: 'spot', sellCurrency: 'GBP', buyCurrency: 'USD', fixedSide: 'sell', amount: '500.00' } })).json;
  assert.equal((await h.call('POST', '/v1/conversions', { token: amira, body: { quoteId: odd.id }, headers: { 'idempotency-key': 'ops-revenue-0002' } })).json.differsFromQuote, true);
  h.providerA.request = originalRequest;
  const withOdd = (await admin.browser.get('/ops/revenue')).body;
  assert.match(withOdd, /<td>Northfield Trading Ltd<\/td><td>2026-11<\/td><td>1<\/td><td>USD 10\.40<\/td>/, 'the total did not grow');
  assert.match(withOdd, /<h2>Booked WITHOUT the client’s terms: not in the totals<\/h2>[^]*<td>sell GBP 500\.00, buy USD 644\.80 at 1\.289600<\/td><td>sell GBP 500\.00, buy USD 650\.00 at 1\.3000<\/td><td>USD 5\.20<\/td>/);
  assert.match((await admin.browser.get('/ops/revenue.csv?company=co_northfield')).body, /,644\.80,0\.80,0\.80,server,5\.20,USD,no,500\.00,650\.00,yes\r\n/);
  // A company name that a spreadsheet would run as a formula is written as text.
  await h.stores.directory.updateCompany('co_northfield', (company) => ({ ...company, name: '=HYPERLINK("http://x.example","Northfield, Ltd")' }));
  assert.match((await admin.browser.get('/ops/revenue.csv')).body, /,co_northfield,"'=HYPERLINK\(""http:\/\/x\.example"",""Northfield, Ltd""\)",/);
  // Nothing the client was sent in all of this carries any of it (every reply was scanned as it came; and by value:)
  for (const body of h.bodies.filter((item) => !item.includes('differsFromQuote'))) assert.ok(!/1\.3000|"1\.3"|10\.40/.test(body), body.slice(0, 200));
});

test('ops: staff see a person’s notification state (counts and choices), never what any notification or alert says', async () => {
  h = await harness();
  const olu = await staff('olu@globalconnect.example', 'ops');
  const { secret } = await h.activate(AMIRA);
  const amira = (await h.login(AMIRA, secret)).json.token as string;
  await h.stores.margins.put('co_northfield', { defaultBps: 20, forwardBps: null, overrides: [], tiers: [], tierCurrency: 'GBP', companyId: 'co_northfield', updatedAt: h.clock.now, updatedBy: 'test@globalconnect.example', approvedBy: null });
  for (const targetRate of ['1.2950', '1.4444']) assert.equal((await h.call('POST', '/v1/alerts', { token: amira, body: { base: 'GBP', quote: 'USD', side: 'sell', targetRate } })).status, 200);
  assert.equal(await h.alerts.check(), 1);
  await h.call('POST', '/v1/notifications/preferences', { token: amira, body: { email: { rates: false, approvals: true, payments: true } } });
  const page = (await olu.browser.get('/ops/users/usr_amira')).body;
  assert.match(page, /<h2>Notifications<\/h2><dl><dt>In the app<\/dt><dd>1 kept, 1 unread \(the latest [^)]+\)<\/dd><dt>Also by email<\/dt><dd>Rate alerts: off\. Payments to approve: on\. Their own payments: on\. Security notices: always on\.<\/dd><dt>Rate alerts<\/dt><dd>1 on, 1 fired, 0 paused<\/dd>/);
  assert.doesNotMatch(page, /1\.2974|1\.4444|1\.295|reached|indicative|Rate alert: GBP/);
  // There is no console action that reads, sends or changes a person's notifications or alerts.
  assert.equal(h.opsRoutes.filter((route) => /notif|alert/i.test(route.url)).length, 0);
});

twoPerson('ops: the console says honestly whether the WARNING before an authenticator reset has been delivered, and that the delay has not started until it has', async () => {
  h = await harness({ authenticatorResetDelayMs: 24 * HOUR_MS });
  const { admin, second } = await pair();
  await h.activate(AMIRA);
  const send = h.outbox.send.bind(h.outbox);
  h.outbox.send = async (message) => {
    if (message.to === AMIRA) throw Object.assign(new Error('mail server down'), { code: 'ETIMEDOUT' });
    return send(message);
  };
  const asked = await admin.act('/ops/users/usr_amira/reset-authenticator', { verification: 'Called back on the number on file' });
  const approved = await second.act(`/ops/approvals/${idOf(asked.location)}/approve`);
  assert.equal(approved.status, 303);
  // Not "the client has been told": the warning is still in the outbox.
  const entry = (await audit('ops.client.reset_authenticator')).find((item) => item.outcome === 'success');
  assert.deepEqual([entry?.detail.warningQueuedFor, entry?.detail.warningSentTo, entry?.detail.noticeTo, entry?.detail.takesEffect], ['a…@northfield.example', undefined, undefined, 'not before the warning has been delivered']);
  const page = (await second.browser.get('/ops/users/usr_amira')).body;
  assert.match(page, /<strong>The warning to the client has NOT been delivered yet \(queued: it is in the outbox and will be sent shortly\)\.<\/strong> The delay does not start until it has been/);
  assert.match((await second.browser.get('/ops/approvals')).body, /<strong>not yet: the warning has not been delivered \(queued\)<\/strong>/);
  // Delivered: now it says when it takes effect, a day after the delivery.
  h.outbox.send = send;
  h.clock.advance(2 * 60_000);
  await h.mail.pump();
  await h.authenticatorResets.runDue();
  const due = new Date(h.clock.now + 24 * HOUR_MS).toISOString().slice(0, 19).replace('T', ' ');
  assert.match((await second.browser.get('/ops/users/usr_amira')).body, new RegExp(`The warning reached the mail server on [^;]+; it takes effect on ${due} UTC`));
});

singlePerson('SINGLE-PERSON MODE: one member of staff, alone, carries out every action through its confirmation page (with their password for the highest-impact ones); nothing that protects without a second person is lost; each high-impact action is reported to the oversight address', async () => {
  h = await harness({ fourEyes: false, opsOversightEmails: ['director@oversight.example'], authenticatorResetDelayMs: 24 * 60 * 60_000, mailPerRecipientPerHour: 2 });
  // THE ONLY member of staff there is. Nothing below needs a second one to exist.
  const admin = await staff();
  assert.equal((await h.stores.ops.users.list()).length, 1);
  const from = admin.browser.pages.length;
  const DIRECTOR = 'director@oversight.example';
  const notices = () => h.outbox.sent.filter((message) => message.to === DIRECTOR);
  const overseen = async () => (await audit('ops.oversight')).map((entry) => entry.detail.action).reverse();
  /** Starts an action and returns its confirmation page: what it says, and whether it asks for the password. */
  const shown = async (url: string, form: Record<string, string> = {}) => {
    const page = await admin.browser.post(url, form);
    assert.equal(page.status, 200, `${url}: ${page.body.slice(-300)}`);
    assert.match(page.body, /This takes effect as soon as you confirm\./, url);
    return { body: page.body, password: /type="password" name="password"/.test(page.body), danger: /class="card narrow confirm danger"/.test(page.body) };
  };
  /** The whole action by this one person; asserts whether the password was asked for, and that no request was made. */
  const alone = async (url: string, form: Record<string, string>, password: boolean) => {
    const page = await shown(url, form);
    assert.equal(page.password, password, `${url}: password ${password ? 'must' : 'must not'} be asked for`);
    if (password) {
      // The wrong password: nothing is done.
      const wrong = await confirmed((to, fields) => admin.browser.post(to, fields), url, form, 'not the password');
      assert.equal(wrong.status, 400, url);
      assert.match(wrong.body, /That is not your password\. Nothing was done/, url);
    }
    const done = await admin.act(url, form);
    assert.equal(done.status, 303, `${url}: ${done.body.slice(-300)}`);
    assert.doesNotMatch(done.location, /^\/ops\/approvals\//, url);
    return { ...page, location: done.location };
  };

  // A COMPANY, mapped to a provider account: password. The provider is still asked, and an account another company uses is still refused.
  const taken = await admin.act('/ops/companies', { name: 'Copy Ltd', provider: 'provider-b', providerAccountId: (await h.stores.directory.getCompany('co_castlebrook'))?.providerAccountId ?? '' });
  assert.equal(taken.status, 409, taken.body.slice(-300));
  await alone('/ops/companies', { name: 'Tideway Ltd', provider: 'provider-b', providerAccountId: 'S00002' }, true);
  const companyId = (await h.stores.directory.listCompanies()).find((item) => item.name === 'Tideway Ltd')?.id as string;
  assert.ok(companyId);
  // A CLIENT USER in it: confirmation only. The email-domain check is on the confirmation page (there is no approver to show it to).
  const created = await alone('/ops/users', { name: 'Chidi Eze', email: 'chidi@tideway.example', company1: companyId, role1: 'admin' }, false);
  assert.match(created.body, /Email domain tideway\.example\. Nobody is in “Tideway Ltd” \([\w-]+\) yet, so there is nothing to compare it with/);
  const userId = (await h.stores.directory.findUserByEmail('chidi@tideway.example'))?.id as string;
  // AN ACTIVATION LINK: it goes to the address on file and is never shown to the member of staff.
  const mailed = await alone(`/ops/users/${userId}/activation-link`, {}, false);
  assert.equal(mailed.location, `/ops/users/${userId}?done=mailed_sent`);
  assert.equal(h.outbox.sent.filter((message) => message.to === 'chidi@tideway.example' && /\/activate#code=/.test(message.text)).length, 1);
  const chidi = await activateClient('chidi@tideway.example');
  // ATTACHED to another company: the stranger's email domain is flagged on the confirmation page.
  const attached = await alone(`/ops/users/${userId}/memberships`, { companyId: 'co_northfield', role: 'creator' }, false);
  assert.match(attached.body, /tideway\.example/);
  assert.match(attached.body, /northfield\.example/);
  // DISABLED (taking access away: not reported) and RE-ENABLED (giving it back: reported).
  await alone(`/ops/users/${userId}/disable`, {}, false);
  await alone(`/ops/users/${userId}/enable`, {}, false);
  // THE PAYMENT-APPROVAL RULE of a company: password.
  await alone(`/ops/companies/${companyId}/approvals`, { approvalsRequired: '0' }, true);
  assert.equal((await h.stores.directory.getCompany(companyId))?.approvalsRequired, 0);
  // A MARGIN: confirmation only (it has to be changeable at any moment), high-impact all the same.
  await admin.browser.get(`/ops/companies/${companyId}`);
  const margin = await admin.browser.submit(`/ops/companies/${companyId}/margin`, { defaultPercent: '0.75' });
  assert.doesNotMatch(margin.body, /name="password"/);
  assert.equal((await admin.browser.submit(`/ops/companies/${companyId}/margin`)).status, 303);
  assert.equal((await h.stores.margins.get(companyId))?.defaultBps, 75);
  // RE-POINTED to another provider account: password; and still refused while one of its payments is being sent.
  await alone('/ops/companies/co_castlebrook', { name: 'Castlebrook Imports Ltd', provider: 'provider-b', providerAccountId: 'S00003' }, true);
  // A CLIENT'S AUTHENTICATOR RESET: password, the identity-verification text, AND THE COOLING-OFF: nothing changes yet, the client is warned, with the link that cancels.
  assert.equal((await admin.act(`/ops/users/${userId}/reset-authenticator`, { verification: '' })).status, 400);
  await alone(`/ops/users/${userId}/reset-authenticator`, { verification: 'Called back on the number on file' }, true);
  assert.equal((await h.stores.directory.getUser(userId))?.totpSecret, chidi.secret, 'nothing is cleared during the delay');
  assert.deepEqual((await h.stores.auth.authenticatorResets.list({ userId })).map((item) => item.status), ['waiting']);
  const warning = h.outbox.sent.find((message) => message.to === 'chidi@tideway.example' && /It has NOT happened yet/.test(message.text));
  assert.match(warning?.text ?? '', /\/cancel-reset#token=ar_/);
  // STAFF: invited (password), only at the allowed email domain.
  assert.equal((await admin.act('/ops/staff', { name: 'Outsider', email: 'someone@elsewhere.example', role: 'ops' })).status, 403);
  await alone('/ops/staff', { name: 'New Colleague', email: 'new@globalconnect.example', role: 'ops' }, true);
  const colleague = (await h.stores.ops.users.findByEmail('new@globalconnect.example'))?.id as string;
  assert.equal(h.outbox.sent.filter((message) => message.to === 'new@globalconnect.example' && /\/ops\/activate#code=/.test(message.text)).length, 1);
  await alone(`/ops/staff/${colleague}/role`, { role: 'ops_admin' }, true);
  await alone(`/ops/staff/${colleague}/disable`, {}, true);
  // ABOUT YOUR OWN ACCOUNT: still refused, alone or not. And the last active admin cannot be removed.
  for (const [path, form] of [['role', { role: 'ops' }], ['disable', {}], ['reset-authenticator', { verification: 'it is me, honestly' }]] as const) {
    const self = await admin.act(`/ops/staff/${admin.id}/${path}`, form);
    assert.equal(self.status, 403, path);
    assert.match(self.body, /your own account/, path);
  }
  assert.equal((await h.stores.ops.users.get(admin.id))?.role, 'ops_admin');

  // NO REQUEST WAS EVER MADE, and nothing waits for anybody.
  assert.equal((await h.stores.ops.approvals.list()).length, 0);
  // ON RECORD AND REPORTED: every high-impact action, in order, under one audit action...
  assert.deepEqual(await overseen(), ['company.create', 'client.create', 'client.activation_link', 'client.membership.set', 'client.enable', 'company.approvals', 'company.margin', 'company.edit', 'client.reset_authenticator', 'staff.invite', 'staff.role', 'staff.disable']);
  for (const entry of await audit('ops.oversight')) assert.deepEqual([entry.actor.label, entry.outcome, entry.detail.notice], [admin.email, 'success', 'queued for 1 oversight address']);
  // ...and a notice of each was sent to the oversight address: who, what, when; no link, no code.
  await h.mail.pump();
  const sent = notices();
  const queued = (await h.stores.mail.list()).filter((row) => row.template === 'ops.oversight');
  assert.equal(queued.length, 12);
  assert.ok(queued.every((row) => row.class === 'security'));
  assert.equal(sent.length, 12, 'twelve in the hour: the security class allows that, whatever else was sent');
  for (const message of sent) {
    assert.equal(message.subject, 'Global Connect ops: a high-impact change was made');
    assert.match(message.text, new RegExp(`\\nBy: admin\\[@\\]globalconnect\\[\\.\\]example \\(alone: the console is in single-person mode\\)\\nWhen: 2026-`));
    assert.doesNotMatch(`${message.text}${message.html}`, /https?:|<a |code=|[A-Z2-7]{5}-[A-Z2-7]{5}-/);
  }
  assert.match(sent[1]?.text ?? '', /What: Create client user Chidi Eze/);
  assert.match(sent[6]?.text ?? '', /What: Change the FX margin for company “Tideway Ltd” \([\w-]+\) FROM default 0\.50%; forwards as spot \(the server default\) TO default 0\.75%; forwards as spot\./);
  // ORDINARY MAIL VOLUME CANNOT HOLD ONE BACK: the same address has had far more ordinary notifications than it is sent in an hour.
  for (let n = 0; n < 6; n += 1) await h.mail.enqueue({ to: DIRECTOR, template: 'notification.digest', data: {}, key: `flood:${n}`, category: 'payments' } as never);
  h.clock.advance(61 * 60_000);
  await signIn(admin.browser, admin.email, admin.secret);
  await admin.browser.get('/ops/users');
  for (let n = 0; n < 6; n += 1) await h.mail.enqueue({ to: DIRECTOR, template: 'notification', data: { name: 'x', kind: 'payment_sent', note: { amount: '1.00', currency: 'GBP', payee: 'P' } }, key: `flood2:${n}`, category: 'payments' } as never);
  const before = notices().filter((message) => /high-impact/.test(message.subject)).length;
  await alone('/ops/users/usr_ben/activation-link', {}, false);
  assert.equal(notices().filter((message) => /high-impact/.test(message.subject)).length, before + 1);
  // The list of the week's high-impact changes is on the first page for everyone, and no standing warning: an oversight address is set.
  const home = (await admin.browser.get('/ops/users')).body;
  assert.match(home, /<h2>High-impact changes in the last 7 days<\/h2><p class="muted">In single-person mode each of these was carried out by one member of staff alone\. A notice of each was also sent to the oversight address\./);
  assert.doesNotMatch(home, /NO OVERSIGHT ADDRESS/);
  // The oversight address is in no page and cannot be changed from the console: there is no form for it.
  const pages = admin.browser.pages.slice(from).join('\n');
  assert.doesNotMatch(pages, /director@oversight|OPS_OVERSIGHT|name="oversight/i);
  // NO PAGE this member of staff was ever shown holds an activation link, a code or a reset token.
  assert.doesNotMatch(pages, LINK_OR_CODE);
  assert.doesNotMatch(pages, /cancel-reset|token=ar_/);
});

singlePerson('single-person mode with NO oversight address: every page says so and so does the start-up line; the setting is checked; two-person mode is still a setting', async () => {
  h = await harness({ fourEyes: false });
  const admin = await staff();
  const WARNING = /<p class="warn" role="note">Single-person mode is on and NO OVERSIGHT ADDRESS is configured: one member of staff carries out every action alone, and nobody is told afterwards\./;
  for (const path of ['/ops/users', '/ops/companies', '/ops/audit', '/ops/mail', '/ops/staff']) assert.match((await admin.browser.get(path)).body, WARNING, path);
  // An action is still on the week's list and in the audit log, which then are the only record; no notice is sent to anyone.
  assert.equal((await admin.act('/ops/users/usr_ben/activation-link')).status, 303);
  assert.deepEqual((await audit('ops.oversight')).map((entry) => [entry.detail.action, entry.detail.notice]), [['client.activation_link', 'no oversight address is configured']]);
  assert.equal((await h.stores.mail.list()).filter((row) => row.template === 'ops.oversight').length, 0);
  assert.match((await admin.browser.get('/ops/users')).body, /No oversight address is configured, so this list and the audit log are the only record\./);
  // Not signed in: nothing about the mode is said.
  assert.doesNotMatch((await new Browser().get('/ops/login')).body, /Single-person|OVERSIGHT/);

  // THE SETTING. Single is the default, in development and outside it; two-person is asked for; anything else is refused.
  const dev = (env: Record<string, string>) => loadConfig({ APP_ENV: 'development', ...env });
  assert.deepEqual([dev({}).fourEyes, dev({ OPS_APPROVALS: 'single' }).fourEyes, dev({ OPS_APPROVALS: 'two-person' }).fourEyes], [false, false, true]);
  assert.deepEqual([dev({ FOUR_EYES: 'off' }).fourEyes, dev({ FOUR_EYES: 'on' }).fourEyes, dev({ FOUR_EYES: 'on', OPS_APPROVALS: 'single' }).fourEyes], [false, true, false], 'the older name is still read, and the new one wins');
  assert.throws(() => dev({ OPS_APPROVALS: 'none' }), /OPS_APPROVALS must be "single"/);
  assert.deepEqual(dev({ OPS_OVERSIGHT_EMAILS: ' Director@Your-Domain.example , board@your-domain.example ' }).opsOversightEmails, ['director@your-domain.example', 'board@your-domain.example']);
  assert.deepEqual(dev({}).opsOversightEmails, []);
  for (const bad of ['director', 'a@b', 'a b@c.example', 'x@y.example;z@y.example', '<a@b.example>']) assert.throws(() => dev({ OPS_OVERSIGHT_EMAILS: bad }), /OPS_OVERSIGHT_EMAILS must be a comma-separated list of email addresses/, bad);
  assert.match(opsModeLine(dev({})), /^OPS APPROVALS: single \(OPS_APPROVALS=single\): ONE member of staff carries out every ops action alone\. NO OVERSIGHT ADDRESS IS SET \(OPS_OVERSIGHT_EMAILS\)/);
  assert.match(opsModeLine(dev({ OPS_OVERSIGHT_EMAILS: 'd@x.example' })), /alone\. High-impact ops actions are reported to 1 oversight address\.$/);
  assert.match(opsModeLine(dev({ OPS_APPROVALS: 'two-person' })), /^OPS APPROVALS: two-person/);
});

twoPerson('TWO-PERSON MODE still enforces what it did, margins included: a margin change is a request, approved only by an ops admin with their password; the oversight notice names both people', async () => {
  h = await harness({ fourEyes: true, opsOversightEmails: ['director@oversight.example'] });
  const admin = await staff();
  const olu = await staff('olu@globalconnect.example', 'ops');
  const pat = await staff('pat@globalconnect.example', 'ops');
  const url = '/ops/companies/co_northfield/margin';
  await olu.browser.get('/ops/companies/co_northfield');
  const confirmation = await olu.browser.submit(url, { defaultPercent: '0.80' });
  assert.match(confirmation.body, /This only makes a request\. Nothing changes until a second staff member, who must be an ops admin, approves it\./);
  const asked = await olu.browser.submit(url);
  assert.match(asked.location, /^\/ops\/approvals\/req_[\w-]+\?done=requested$/);
  const id = idOf(asked.location);
  assert.equal(await h.stores.margins.get('co_northfield'), null);
  assert.match((await h.stores.ops.approvals.get(id))?.summary ?? '', /FROM default 0\.50%; forwards as spot \(the server default\) TO default 0\.80%; forwards as spot\. Worked example at the provider’s rate when this was requested: /);
  // Not the requester, not another ops user; an ops admin, and only with their password.
  assert.equal((await olu.act(`/ops/approvals/${id}/approve`)).status, 403);
  assert.equal((await pat.act(`/ops/approvals/${id}/approve`)).status, 403);
  assert.match((await admin.browser.post(`/ops/approvals/${id}/approve`, {})).body, /name="password"/);
  assert.notEqual((await confirmed((to, fields) => admin.browser.post(to, fields), `/ops/approvals/${id}/approve`, {}, 'not the password')).status, 303);
  assert.equal(await h.stores.margins.get('co_northfield'), null);
  assert.equal((await admin.act(`/ops/approvals/${id}/approve`)).status, 303);
  const now = await h.stores.margins.get('co_northfield');
  assert.deepEqual([now?.defaultBps, now?.updatedBy, now?.approvedBy], [80, olu.email, admin.email]);
  assert.deepEqual((await audit('ops.margin.changed')).map((entry) => [entry.actor.label, entry.detail.approvedBy, entry.detail.to]), [[olu.email, admin.email, 'default 0.80%; forwards as spot']]);
  // Nobody approves their own request, ops admin or not.
  const own = await admin.act('/ops/users/usr_dana/activation-link');
  const mine = await admin.act(`/ops/approvals/${idOf(own.location)}/approve`);
  assert.equal(mine.status, 403);
  assert.match(mine.body, /You cannot approve, finish or close your own request\. A different staff member must do it\./);
  // Everything else is a request too (here: an activation link), and the Approvals page stays in the navigation.
  assert.match((await olu.act('/ops/users/usr_ben/activation-link')).location, /^\/ops\/approvals\/req_/);
  assert.match((await olu.browser.get('/ops/users')).body, /<a href="\/ops\/approvals">Approvals<\/a>/);
  assert.doesNotMatch((await olu.browser.get('/ops/users')).body, /Single-person mode/);
  // The oversight address is told of what was carried out, with both names.
  await h.mail.pump();
  const notice = h.outbox.sent.find((message) => message.to === 'director@oversight.example');
  assert.match(notice?.text ?? '', /\nBy: olu\[@\]globalconnect\[\.\]example, approved by admin\[@\]globalconnect\[\.\]example\n/);
});
