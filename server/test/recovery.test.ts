/** Self-service: forgotten password (link AND second factor), your own security settings, security notices. */
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import { agentFamily, PASSWORD_RESET_TTL_MS, RESET_REQUESTS_PER_HOUR } from '../src/auth/service';
import { AMIRA, BEN, DANA, harness, PASSWORD, type Harness } from './helpers';

let h: Harness;
afterEach(async () => h?.close());

const NEW_PASSWORD = 'violet anchor harbour lamp';
const request = async (email: string, headers: Record<string, string> = {}) => {
  const reply = await h.call('POST', '/v1/auth/password-reset/request', { body: { email }, headers });
  await h.auth.settle();
  return reply;
};
const mailsTo = (email: string, subject: RegExp) => h.outbox.sent.filter((message) => message.to === email && subject.test(message.subject));
const resetCodeOf = (email: string): string => {
  const message = [...h.outbox.sent].reverse().find((item) => item.to === email && /\/reset#code=/.test(item.text));
  const code = /\/reset#code=([A-Z2-7-]+)/.exec(message?.text ?? '')?.[1];
  if (!code) throw new Error(`no reset email for ${email}`);
  return code;
};
const complete = (resetCode: string, code: string, password = NEW_PASSWORD, method: 'totp' | 'recovery' = 'totp') => h.call('POST', '/v1/auth/password-reset/complete', { body: { resetCode, code, method, password } });
const reasonOf = (reply: { json: any }) => reply.json?.error?.reason ?? reply.json?.error?.kind;
const audit = (action: string) => h.stores.audit.query({ action, limit: 10_000 });
const RESET = /^Reset the password of your Global Connect account$/;
const NOTICE = /^Security notice for your Global Connect account$/;

test('forgotten password: the same answer for every address; a link only to an activated, enabled account; the answer does not wait for the email', async () => {
  h = await harness();
  const amira = await h.activate(AMIRA);
  await h.activate(DANA);
  await h.stores.directory.updateUser('usr_dana', (user) => ({ ...user, disabledAt: 1 }));
  const replies = [];
  for (const email of [AMIRA, 'nobody@nowhere.example', BEN /* invited, never activated */, DANA /* disabled */, ' AMIRA@Northfield.Example ', 'not an email']) replies.push(await request(email));
  // Byte for byte the same, whoever it was.
  assert.deepEqual([...new Set(replies.map((reply) => `${reply.status} ${JSON.stringify(reply.json)}`))], ['200 {"ok":true}']);
  // Only the one usable account was written to (twice asked: the second link replaced the first).
  assert.deepEqual([...new Set(h.outbox.sent.filter((message) => RESET.test(message.subject)).map((message) => message.to))], [AMIRA]);
  const mail = mailsTo(AMIRA, RESET).at(-1);
  assert.match(mail?.text ?? '', new RegExp(`^${h.config.appUrl.replace(/[.]/g, '\\.')}/reset#code=[A-Z2-7]{5}(-[A-Z2-7]{5}){3}$`, 'm'));
  assert.match(mail?.text ?? '', /You will also be asked for a code from your authenticator app, or one of your recovery codes: the link alone changes nothing/);
  // The code is stored only as a hash, and is in no log and no audit entry.
  const code = resetCodeOf(AMIRA);
  assert.ok(!JSON.stringify(h.stores.db.all('SELECT key, data FROM password_resets')).includes(code));
  assert.ok(!JSON.stringify(await h.stores.audit.query({ limit: 10_000 })).includes(code) && !h.logs.join('\n').includes(code));
  // Who asked is on record for the real account; the others go to the stream for people nobody identified.
  assert.deepEqual((await audit('client.password_reset.request')).filter((entry) => entry.outcome === 'success').map((entry) => entry.actor.label), [AMIRA, AMIRA]);

  // The answer is given without waiting for any of that: with the outbox stuck, the reply still comes, the same.
  const realMutate = h.stores.mail.mutate.bind(h.stores.mail);
  let release!: () => void;
  const stuck = new Promise<void>((resolve) => (release = resolve));
  h.stores.mail.mutate = (async (...args: Parameters<typeof realMutate>) => {
    await stuck;
    return realMutate(...args);
  }) as typeof realMutate;
  const before = h.outbox.sent.length;
  const answered = await h.call('POST', '/v1/auth/password-reset/request', { body: { email: AMIRA } });
  assert.deepEqual([answered.status, answered.json, h.outbox.sent.length], [200, { ok: true }, before]);
  release();
  await h.auth.settle();
  h.stores.mail.mutate = realMutate;
  assert.equal(h.outbox.sent.length, before + 1);
  void amira;
});

test('forgotten password: the link ALONE resets nothing; with a code from the authenticator it sets the password, and only the password', async () => {
  h = await harness();
  const amira = await h.activate(AMIRA);
  const session = (await h.login(AMIRA, amira.secret)).json.token as string;
  const before = await h.stores.directory.getUser('usr_amira');
  await request(AMIRA);
  const link = resetCodeOf(AMIRA);
  assert.deepEqual((await h.call('POST', '/v1/auth/password-reset/start', { body: { resetCode: link } })).json, { passwordPolicy: { minLength: 12 } });
  assert.equal(reasonOf(await h.call('POST', '/v1/auth/password-reset/start', { body: { resetCode: 'AAAAA-BBBBB-CCCCC-DDDDD' } })), 'reset_invalid');

  // Whoever has the mailbox has the link. Without the second factor: nothing, however they try.
  for (const body of [{ resetCode: link, password: NEW_PASSWORD }, { resetCode: link, password: NEW_PASSWORD, code: '' }, { resetCode: link, password: NEW_PASSWORD, code: '000000' }, { resetCode: link, password: NEW_PASSWORD, code: 'AAAAA-BBBBB-CCCCC-DDDDD', method: 'recovery' }, { resetCode: link, password: NEW_PASSWORD, code: PASSWORD }]) {
    const refused = await h.call('POST', '/v1/auth/password-reset/complete', { body });
    assert.equal(refused.status, 400, JSON.stringify(body));
  }
  assert.equal((await h.stores.directory.getUser('usr_amira'))?.passwordHash, before?.passwordHash);
  assert.equal((await h.call('GET', '/v1/balances', { token: session })).status, 200, 'and nobody was signed out');
  // A weak new password is refused before the code is spent.
  assert.equal(reasonOf(await complete(link, h.freshCode(amira.secret), 'password1234')), 'weak_password');

  // The link and a current code: the password changes.
  const done = await complete(link, h.code(amira.secret));
  assert.deepEqual([done.status, done.json], [200, { ok: true }]);
  const after = await h.stores.directory.getUser('usr_amira');
  assert.notEqual(after?.passwordHash, before?.passwordHash);
  // ONLY the password: the authenticator and the recovery codes are exactly as they were.
  assert.deepEqual([after?.totpSecret, after?.recoveryCodeHashes, after?.activatedAt], [before?.totpSecret, before?.recoveryCodeHashes, before?.activatedAt]);
  // Every session is ended; the old password is dead; the new one, with the same authenticator, signs in.
  assert.equal((await h.call('GET', '/v1/balances', { token: session })).status, 401);
  assert.equal(reasonOf(await h.login(AMIRA, amira.secret)), 'invalid_credentials');
  assert.equal((await h.login(AMIRA, amira.secret, NEW_PASSWORD)).status, 200);
  // The link worked once.
  assert.equal(reasonOf(await complete(link, h.freshCode(amira.secret), 'another fine long password')), 'reset_invalid');
  // The owner is told, by a notice with no link in it; and it is all on record, without the code or the password.
  const notice = mailsTo(AMIRA, NOTICE).at(-1);
  assert.match(notice?.text ?? '', /The password of your account was reset using an emailed link and a code from your authenticator/);
  assert.doesNotMatch(notice?.text ?? '', /https?:/);
  const entries = (await audit('client.password_reset')).filter((entry) => entry.action === 'client.password_reset');
  assert.deepEqual(entries.filter((entry) => entry.outcome === 'success').map((entry) => [entry.actor.label, entry.detail.method, entry.detail.sessionsEnded]), [[AMIRA, 'totp', '1']]);
  assert.ok(entries.filter((entry) => entry.outcome === 'failure').length >= 3);
  const everything = JSON.stringify(await h.stores.audit.query({ limit: 10_000 }));
  assert.ok(!everything.includes(NEW_PASSWORD) && !everything.includes(link));
});

test('forgotten password: a recovery code works in place of the authenticator and is spent; wrong codes withdraw the link and count toward the lock', async () => {
  h = await harness();
  const amira = await h.activate(AMIRA);
  await request(AMIRA);
  const link = resetCodeOf(AMIRA);
  const recovery = amira.recoveryCodes[0] as string;
  assert.equal((await complete(link, recovery, NEW_PASSWORD, 'recovery')).status, 200);
  assert.equal((await h.stores.directory.getUser('usr_amira'))?.recoveryCodeHashes.length, 9);
  // That recovery code is gone: it does not sign in afterwards.
  const first = await h.call('POST', '/v1/auth/login', { body: { email: AMIRA, password: NEW_PASSWORD } });
  assert.equal(reasonOf(await h.call('POST', '/v1/auth/login/verify', { body: { challengeId: first.json.challengeId, code: recovery, method: 'recovery' } })), 'invalid_code');

  // Wrong codes against a link: after five the link is withdrawn, and the guesses counted toward the account's code lock.
  const dana = await h.activate(DANA);
  await request(DANA);
  const danaLink = resetCodeOf(DANA);
  for (let n = 0; n < 5; n += 1) assert.equal(reasonOf(await complete(danaLink, '000000')), 'invalid_code', String(n));
  assert.equal(reasonOf(await complete(danaLink, h.freshCode(dana.secret))), 'reset_invalid');
  assert.equal((await h.stores.auth.passwordResets.list({ userId: 'usr_dana' })).length, 0);
  assert.ok((await audit('client.lockout')).some((entry) => entry.actor.label === DANA && entry.detail.guarded === 'code'));
  assert.equal(await h.auth.isLocked((await h.stores.directory.getUser('usr_dana'))!), true);
  // The password was never changed.
  h.clock.advance(2 * 60 * 60_000);
  assert.equal((await h.login(DANA, dana.secret)).status, 200);
});

test('forgotten password: a new link kills the old one; a link lasts 30 minutes; at most three an hour; a disabled or reset account has none', async () => {
  h = await harness();
  const amira = await h.activate(AMIRA);
  await request(AMIRA);
  const first = resetCodeOf(AMIRA);
  await request(AMIRA);
  const second = resetCodeOf(AMIRA);
  assert.notEqual(first, second);
  assert.equal(reasonOf(await complete(first, h.freshCode(amira.secret))), 'reset_invalid');
  assert.equal((await h.call('POST', '/v1/auth/password-reset/start', { body: { resetCode: second } })).status, 200);
  // Half an hour, to the second.
  assert.equal(PASSWORD_RESET_TTL_MS, 30 * 60_000);
  h.clock.advance(PASSWORD_RESET_TTL_MS - 31_000);
  assert.equal((await h.call('POST', '/v1/auth/password-reset/start', { body: { resetCode: second } })).status, 200);
  h.clock.advance(31_000);
  assert.equal(reasonOf(await complete(second, h.code(amira.secret))), 'reset_invalid');
  // Asking again and again sends three links in an hour and then nothing, with the same answer throughout.
  const sent = () => mailsTo(AMIRA, RESET).length;
  const start = sent();
  assert.equal(RESET_REQUESTS_PER_HOUR, 3);
  for (let n = 0; n < 5; n += 1) assert.deepEqual((await request(AMIRA)).json, { ok: true });
  assert.equal(sent() - start, 1, 'two were sent earlier in this hour');
  assert.ok((await audit('client.password_reset.request')).some((entry) => entry.outcome === 'failure' && entry.detail.reason === 'rate_limited'));
  h.clock.advance(61 * 60_000);
  await request(AMIRA);
  assert.equal(sent() - start, 2);
  // Disabled after the link was sent: the link is dead.
  const live = resetCodeOf(AMIRA);
  await h.stores.directory.updateUser('usr_amira', (user) => ({ ...user, disabledAt: h.clock.now }));
  assert.equal(reasonOf(await complete(live, h.freshCode(amira.secret))), 'reset_invalid');
  // Each source is limited like any sign-in route.
  await h.close();
  h = await harness({ authRequestsPerMinute: 3 });
  const statuses = [];
  for (let n = 0; n < 5; n += 1) statuses.push((await request(`x${n}@nowhere.example`)).status);
  assert.deepEqual(statuses, [200, 200, 200, 429, 429]);
});

test('security settings: change password needs the current password AND a code; recovery codes are regenerated with a code; sessions are listed by device family and can be ended', async () => {
  h = await harness();
  const amira = await h.activate(AMIRA);
  const signIn = async (agent: string, password = PASSWORD) => {
    const first = await h.call('POST', '/v1/auth/login', { body: { email: AMIRA, password } });
    return (await h.call('POST', '/v1/auth/login/verify', { body: { challengeId: first.json.challengeId, code: h.freshCode(amira.secret), method: 'totp' }, headers: { 'user-agent': agent } })).json.token as string;
  };
  const laptop = await signIn('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36');
  const phone = await signIn('GlobalConnect/1 CFNetwork/1568.200.51 Darwin/24.1.0');
  const change = (token: string, body: object) => h.call('POST', '/v1/account/password', { token, body });
  const before = await h.stores.directory.getUser('usr_amira');

  // Not without a session, not without the current password, not without a code, not with a weak one.
  assert.equal((await h.call('POST', '/v1/account/password', { body: { currentPassword: PASSWORD, code: h.freshCode(amira.secret), newPassword: NEW_PASSWORD } })).status, 401);
  assert.equal(reasonOf(await change(laptop, { currentPassword: 'not the password at all', code: h.freshCode(amira.secret), newPassword: NEW_PASSWORD })), 'invalid_credentials');
  assert.equal(reasonOf(await change(laptop, { currentPassword: PASSWORD, code: '000000', newPassword: NEW_PASSWORD })), 'invalid_code');
  assert.equal(reasonOf(await change(laptop, { currentPassword: PASSWORD, code: h.freshCode(amira.secret), newPassword: 'short' })), 'weak_password');
  assert.equal((await h.stores.directory.getUser('usr_amira'))?.passwordHash, before?.passwordHash);
  // Both: changed. This session stays; the other one is ended; the authenticator is untouched.
  assert.deepEqual((await change(laptop, { currentPassword: PASSWORD, code: h.freshCode(amira.secret), newPassword: NEW_PASSWORD })).json, { ok: true });
  assert.equal((await h.call('GET', '/v1/account/sessions', { token: laptop })).status, 200);
  assert.equal((await h.call('GET', '/v1/account/sessions', { token: phone })).status, 401);
  assert.equal((await h.stores.directory.getUser('usr_amira'))?.totpSecret, before?.totpSecret);
  assert.equal(reasonOf(await h.login(AMIRA, amira.secret)), 'invalid_credentials');
  assert.match(mailsTo(AMIRA, NOTICE).at(-1)?.text ?? '', /The password of your account was changed\. Every other signed-in session was signed out/);
  assert.deepEqual((await audit('client.password_change')).map((entry) => [entry.outcome, entry.detail.reason ?? entry.detail.otherSessionsEnded]).reverse(), [['failure', 'invalid_credentials'], ['failure', 'invalid_code'], ['failure', 'weak_password'], ['success', '1']]);

  // Recovery codes: a code buys ten new ones, shown once; the old ones are dead.
  assert.equal(reasonOf(await h.call('POST', '/v1/account/recovery-codes', { token: laptop, body: { code: '000000' } })), 'invalid_code');
  const fresh = await h.call('POST', '/v1/account/recovery-codes', { token: laptop, body: { code: h.freshCode(amira.secret) } });
  assert.equal(fresh.status, 200);
  const codes = fresh.json.recoveryCodes as string[];
  assert.equal(codes.length, 10);
  assert.ok(codes.every((code) => /^[A-Z2-7]{5}(-[A-Z2-7]{5}){3}$/.test(code)) && !codes.includes(amira.recoveryCodes[0] as string));
  const withRecovery = async (code: string) => {
    const first = await h.call('POST', '/v1/auth/login', { body: { email: AMIRA, password: NEW_PASSWORD } });
    return h.call('POST', '/v1/auth/login/verify', { body: { challengeId: first.json.challengeId, code, method: 'recovery' }, headers: { 'user-agent': 'Mozilla/5.0 (Linux; Android 15) okhttp/4.12.0' } });
  };
  assert.equal(reasonOf(await withRecovery(amira.recoveryCodes[0] as string)), 'invalid_code');
  const android = (await withRecovery(codes[0] as string)).json.token as string;
  assert.ok(android);
  assert.match(mailsTo(AMIRA, NOTICE).at(-1)?.text ?? '', /New recovery codes were made for your account/);
  assert.ok(!JSON.stringify(await h.stores.audit.query({ limit: 10_000 })).includes(codes[0] as string));

  // Sessions: what kind of device and roughly when. No address, no token, no exact time, and the reference is not the session's id.
  const list = (await h.call('GET', '/v1/account/sessions', { token: laptop })).json.items as { id: string; current: boolean; device: string; signedInAt: string; lastActiveAt: string }[];
  assert.deepEqual(list.map((item) => [item.device, item.current]).sort(), [['Chrome on Windows', true], ['Global Connect app on Android', false]]);
  for (const item of list) {
    assert.deepEqual(Object.keys(item).sort(), ['current', 'device', 'id', 'lastActiveAt', 'signedInAt']);
    assert.equal(Date.parse(item.signedInAt) % (15 * 60_000), 0);
    assert.equal(Date.parse(item.lastActiveAt) % (15 * 60_000), 0);
  }
  const stored = await h.stores.auth.sessions.list({ userId: 'usr_amira' });
  assert.ok(list.every((item) => !stored.some((session) => session.id === item.id)));
  assert.equal(agentFamily('curl/8.5.0'), 'Unknown device');
  assert.equal(agentFamily(`Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15 ${'x'.repeat(2000)}`), 'Safari on macOS');
  // End the other one: it is signed out at once, this one is not. Someone else's reference is not found.
  const other = list.find((item) => !item.current)?.id as string;
  const dana = await h.activate(DANA);
  const danaToken = (await h.login(DANA, dana.secret)).json.token as string;
  assert.equal((await h.call('POST', `/v1/account/sessions/${other}/revoke`, { token: danaToken })).status, 404);
  assert.equal((await h.call('GET', '/v1/account/sessions', { token: android })).status, 200);
  assert.deepEqual((await h.call('POST', `/v1/account/sessions/${other}/revoke`, { token: laptop })).json, { ok: true });
  assert.equal((await h.call('GET', '/v1/account/sessions', { token: android })).status, 401);
  assert.equal((await h.call('GET', '/v1/account/sessions', { token: laptop })).json.items.length, 1);
  assert.equal((await h.call('POST', '/v1/account/sessions/not-a-reference/revoke', { token: laptop })).status, 404);
  assert.deepEqual((await audit('client.session.revoke')).map((entry) => [entry.actor.label, entry.detail.which, entry.detail.device]), [[AMIRA, 'another', 'Global Connect app on Android']]);
});

test('security notices: a sign-in from a new network and a lock are told to the owner, at most once an hour each, however hard someone hammers sign-in; never with a link', async () => {
  h = await harness({ trustProxy: 1 });
  const amira = await h.activate(AMIRA);
  const from = (address: string) => ({ 'x-forwarded-for': address });
  const signIn = async (address: string) => {
    const first = await h.call('POST', '/v1/auth/login', { body: { email: AMIRA, password: PASSWORD }, headers: from(address) });
    return h.call('POST', '/v1/auth/login/verify', { body: { challengeId: first.json.challengeId, code: h.freshCode(amira.secret), method: 'totp' }, headers: from(address) });
  };
  const notices = () => mailsTo(AMIRA, NOTICE).map((message) => message.text);
  // The first sign-in ever is not "a new network"; nor is the same network again.
  assert.equal((await signIn('198.51.100.7')).status, 200);
  assert.equal((await signIn('198.51.100.99')).status, 200);
  assert.equal(notices().length, 0);
  // Another network: one notice. More new networks within the hour: still one.
  for (const address of ['203.0.113.5', '192.0.2.44', '203.0.114.9']) assert.equal((await signIn(address)).status, 200);
  assert.equal(notices().filter((text) => /from a network it had not been used from before/.test(text)).length, 1);
  assert.equal((await audit('client.sign_in')).filter((entry) => entry.detail.network === 'new').length, 3, 'each is in the audit log');
  // Someone guessing the password from many addresses: the account locks, the owner is told once, not once per guess.
  for (let n = 0; n < 80; n += 1) await h.call('POST', '/v1/auth/login', { body: { email: AMIRA, password: `wrong guess ${n}` }, headers: from(`198.18.${n}.1`) });
  const locked = notices().filter((text) => /sign-in is locked for a while/.test(text));
  assert.equal(locked.length, 1);
  assert.ok(h.outbox.sent.filter((message) => message.to === AMIRA).length <= 4, 'hammering sign-in produced a handful of emails, not a flood');
  // An hour on, a new lock is a new notice.
  h.clock.advance(61 * 60_000);
  for (let n = 0; n < 80; n += 1) await h.call('POST', '/v1/auth/login', { body: { email: AMIRA, password: `wrong guess ${n}` }, headers: from(`198.19.${n}.1`) });
  assert.equal(notices().filter((text) => /sign-in is locked for a while/.test(text)).length, 2);
  // No notice ever carries a link or a code, and each says how to raise the alarm.
  for (const text of notices()) {
    assert.doesNotMatch(text, /https?:|#code=|\d{6}/);
    assert.match(text, /If this was not you, tell Global Connect at once/);
  }
  // Addresses that belong to nobody produce no email at all.
  const count = h.outbox.sent.length;
  for (let n = 0; n < 20; n += 1) await h.call('POST', '/v1/auth/login', { body: { email: 'nobody@nowhere.example', password: 'x' }, headers: from(`198.20.${n}.1`) });
  assert.equal(h.outbox.sent.length, count);
});
