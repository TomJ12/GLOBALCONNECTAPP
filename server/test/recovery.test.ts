/** Self-service: forgotten password (link AND second factor), your own security settings, security notices. */
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import { agentFamily, PASSWORD_RESET_TTL_MS, RESET_SEND_WITHIN_MS } from '../src/auth/service';
import { RESET_LIMITS } from '../src/auth/resetLedger';
import { networkOf } from '../src/net';
import { loadConfig } from '../src/config';
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
  h.clock.advance(61 * 60_000);
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

test('forgotten password: ANYONE can ask, so asking takes nothing from the owner: a new link does not kill an older one, the limits are per network and per account, strangers cannot use up the owner’s share or flood the mailbox', async () => {
  h = await harness({ trustProxy: 1 });
  const amira = await h.activate(AMIRA);
  const HOME = '198.51.100.7';
  await h.stores.directory.updateUser('usr_amira', (user) => ({ ...user, knownSources: [networkOf(HOME)] }));
  const from = (address: string) => ({ 'x-forwarded-for': address });
  const sent = () => mailsTo(AMIRA, RESET).length;
  const codes = () => mailsTo(AMIRA, RESET).map((message) => /\/reset#code=([A-Z2-7-]+)/.exec(message.text)?.[1] as string);
  const starts = async (code: string) => (await h.call('POST', '/v1/auth/password-reset/start', { body: { resetCode: code } })).status;
  const refusals = async () => (await audit('client.password_reset.request')).filter((entry) => entry.detail.reason === 'rate_limited').map((entry) => entry.detail.limit).reverse();
  assert.deepEqual(RESET_LIMITS, { perSource: 2, unknown: 3, unknownPerDay: 8, account: 5, accountPerDay: 20 });

  // She asks, from where she usually is. Then SOMEBODY ELSE asks for her address, twice, from a network she has never used.
  assert.deepEqual((await request(AMIRA, from(HOME))).json, { ok: true });
  const hers = codes()[0] as string;
  for (let n = 0; n < 2; n += 1) assert.deepEqual((await request(AMIRA, from('203.0.113.9'))).json, { ok: true });
  assert.equal(sent(), 3);
  // HER LINK STILL WORKS (it used to be killed by the next request), and so do the others: they all went to her mailbox.
  assert.deepEqual([await starts(hers), await starts(codes()[1] as string), await starts(codes()[2] as string)], [200, 200, 200]);
  // That network gets no more for her this hour; the answer is the same and nothing is sent.
  assert.deepEqual((await request(AMIRA, from('203.0.113.10'))).json, { ok: true });
  assert.equal(sent(), 3);
  assert.deepEqual(await refusals(), ['source']);
  // Other networks she has never used share what is left for strangers (three an hour in all)...
  await request(AMIRA, from('203.0.114.1'));
  assert.equal(sent(), 4);
  for (const address of ['203.0.115.1', '203.0.116.1', '203.0.117.1']) await request(AMIRA, from(address));
  assert.equal(sent(), 4);
  assert.deepEqual(await refusals(), ['source', 'unknown_sources', 'unknown_sources', 'unknown_sources']);
  // ...and CANNOT use up hers: from where she usually is, she is still sent a link (it used to be refused silently).
  await request(AMIRA, from(HOME));
  assert.equal(sent(), 5);
  // Five is the most this account's mailbox gets in an hour, from anywhere.
  await request(AMIRA, from(HOME));
  assert.equal(sent(), 5);
  assert.deepEqual((await refusals()).slice(-1), ['source']);
  // Hour after hour of it: strangers get eight in a day, and then nothing until the day has passed. She still gets hers.
  for (let hour = 1; hour <= 4; hour += 1) {
    h.clock.advance(61 * 60_000);
    for (let n = 0; n < 4; n += 1) await request(AMIRA, from(`203.0.${120 + hour}.${n + 1}`));
  }
  assert.equal(sent(), 5 + 5, 'three strangers’ requests were sent earlier, so five more in the day');
  await request(AMIRA, from(HOME));
  assert.equal(sent(), 11);

  // A link works ONCE, and a reset ends EVERY link that was live.
  await request(AMIRA, from(HOME));
  assert.equal(sent(), 12);
  const live = codes().slice(-2);
  assert.deepEqual([await starts(live[0] as string), await starts(live[1] as string)], [200, 200]);
  assert.equal((await complete(live[1] as string, h.freshCode(amira.secret))).status, 200);
  assert.deepEqual([await starts(live[0] as string), await starts(live[1] as string)], [400, 400]);
  assert.equal(reasonOf(await complete(live[0] as string, h.freshCode(amira.secret), 'another new password 22')), 'reset_invalid');

  // Half an hour, to the second (here the email is accepted at once; a delayed one is in the next test).
  h.clock.advance(61 * 60_000);
  await request(AMIRA, from(HOME));
  const last = codes().at(-1) as string;
  assert.equal(PASSWORD_RESET_TTL_MS, 30 * 60_000);
  assert.match(mailsTo(AMIRA, RESET).at(-1)?.text ?? '', new RegExp(`The link works once, until ${new Date(h.clock.now + PASSWORD_RESET_TTL_MS).toISOString().slice(0, 16).replace('T', ' ')} UTC\\.`));
  h.clock.advance(PASSWORD_RESET_TTL_MS - 1000);
  assert.equal(await starts(last), 200);
  h.clock.advance(1000);
  assert.equal(reasonOf(await complete(last, h.code(amira.secret))), 'reset_invalid');
  // Disabled after the link was sent: the link is dead.
  h.clock.advance(61 * 60_000);
  await request(AMIRA, from(HOME));
  await h.stores.directory.updateUser('usr_amira', (user) => ({ ...user, disabledAt: h.clock.now }));
  assert.equal(reasonOf(await complete(codes().at(-1) as string, h.freshCode(amira.secret))), 'reset_invalid');
  // Each source is limited like any sign-in route.
  await h.close();
  h = await harness({ authRequestsPerMinute: 3 });
  const statuses = [];
  for (let n = 0; n < 5; n += 1) statuses.push((await request(`x${n}@nowhere.example`)).status);
  assert.deepEqual(statuses, [200, 200, 200, 429, 429]);
});

test('a reset link is good for half an hour FROM WHEN ITS EMAIL IS ACCEPTED, and the email says that time; one that cannot be sent in time is not sent at all and is on record; a permanent refusal fails at once', async () => {
  h = await harness();
  const amira = await h.activate(AMIRA);
  const send = h.outbox.send.bind(h.outbox);
  let fault: { code: string; responseCode?: number } | null = { code: 'ETIMEDOUT' };
  h.outbox.send = async (message) => {
    if (fault) throw Object.assign(new Error('mail server'), fault);
    return send(message);
  };
  const row = async () => (await h.stores.mail.list()).filter((item) => item.template === 'reset.client').at(-1);
  const utc = (at: number) => `${new Date(at).toISOString().slice(0, 16).replace('T', ' ')} UTC`;

  // The mail server is down for twelve minutes. Links are tried again soon and often (not after 1, 5, 15, 60 minutes).
  const asked = h.clock.now;
  await request(AMIRA);
  assert.deepEqual([(await row())?.status, (await row())?.deadline], ['queued', asked + RESET_SEND_WITHIN_MS]);
  for (let minute = 0; minute < 12; minute += 1) {
    h.clock.advance(60_000);
    await h.mail.pump();
  }
  assert.deepEqual([(await row())?.status, (await row())?.attempts], ['queued', 5]);
  fault = null;
  h.clock.advance(60_000);
  await h.mail.pump();
  const sentAt = h.clock.now;
  assert.equal((await row())?.status, 'sent');
  // The email names the time counted from NOW, and the link really works until then: it did not arrive half dead.
  const mail = mailsTo(AMIRA, RESET).at(-1);
  assert.match(mail?.text ?? '', new RegExp(`The link works once, until ${utc(sentAt + PASSWORD_RESET_TTL_MS)}\\.`));
  assert.doesNotMatch(`${mail?.text}${mail?.html}`, /\u0001|sent\+/);
  const code = resetCodeOf(AMIRA);
  h.clock.advance(PASSWORD_RESET_TTL_MS - 60_000);
  assert.ok(h.clock.now > asked + PASSWORD_RESET_TTL_MS, 'past what it would have been counted from the request');
  assert.equal((await h.call('POST', '/v1/auth/password-reset/start', { body: { resetCode: code } })).status, 200);
  assert.equal((await complete(code, h.freshCode(amira.secret))).status, 200);

  // Down for longer than a reset link may wait: it is NOT sent late. It is failed, audited, and on the Mail page.
  fault = { code: 'ETIMEDOUT' };
  h.clock.advance(61 * 60_000);
  const before = h.outbox.sent.length;
  await request(AMIRA);
  h.clock.advance(RESET_SEND_WITHIN_MS + 1000);
  fault = null;
  await h.mail.pump();
  assert.deepEqual([(await row())?.status, (await row())?.lastError, (await row())?.body, h.outbox.sent.length], ['failed', 'not sent in time', null, before]);
  assert.equal((await audit('system.mail.failed')).filter((entry) => entry.detail.error === 'not sent in time').length, 1);
  assert.ok((await h.mail.summary()).problems.some((item) => item.state === 'failed' && item.lastError === 'not sent in time'));

  // A PERMANENT refusal (550: no such mailbox) is not tried again for hours: it has failed, at once, and is on record.
  fault = { code: 'EENVELOPE', responseCode: 550 };
  h.clock.advance(61 * 60_000);
  await request(AMIRA);
  assert.deepEqual([(await row())?.status, (await row())?.attempts, (await row())?.lastError], ['failed', 1, 'EENVELOPE 550']);
  // ...while a temporary one (451) and a refusal that is about the server's own set-up (535 at sign-in) are tried again.
  for (const temporary of [{ code: 'EENVELOPE', responseCode: 451 }, { code: 'EAUTH', responseCode: 535 }]) {
    fault = temporary;
    h.clock.advance(61 * 60_000);
    await request(AMIRA);
    assert.deepEqual([(await row())?.status, (await row())?.attempts], ['queued', 1], temporary.code);
  }
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

// --- The review of ae7f104: mail allowances, the warning before an authenticator reset, races -----------------------
const HOUR = 60 * 60_000;
const REAL = loadConfig({ APP_ENV: 'development' });
const userOf = async (id: string) => (await h.stores.directory.getUser(id)) as NonNullable<Awaited<ReturnType<typeof h.stores.directory.getUser>>>;
const schedule = async (userId: string, requestId: string) => h.authenticatorResets.schedule(await userOf(userId), { id: requestId, requestedBy: 'ops.admin@globalconnect.example', approvedBy: 'ops.admin2@globalconnect.example' }, '127.0.0.1');
const resetOf = async (id: string) => (await h.stores.auth.authenticatorResets.get(id)) as NonNullable<Awaited<ReturnType<typeof h.stores.auth.authenticatorResets.get>>>;

test('AT THE PRODUCTION MAIL LIMITS: a flood of payment notifications cannot silence a reset link, a security notice or the warning before an authenticator reset', async () => {
  h = await harness({ mailPerRecipientPerHour: REAL.mailPerRecipientPerHour, mailGlobalPerHour: REAL.mailGlobalPerHour, authenticatorResetDelayMs: 24 * HOUR, notificationsPerUserPerHour: 100 });
  assert.deepEqual([REAL.mailPerRecipientPerHour, REAL.mailGlobalPerHour], [20, 1000]);
  const dana = await h.activate(DANA);
  // A colleague makes 30 payments in a few minutes: Dana, who can approve them, is notified of each.
  for (let n = 0; n < 30; n += 1) assert.equal(await h.notifier.notify({ userId: 'usr_dana', companyId: 'co_northfield', category: 'approvals', kind: 'payment_awaiting', note: { amount: '125.00', currency: 'GBP', payee: 'Harbour Print Ltd', createdBy: 'Amira Shah', expiresAt: 0 }, dedupe: `flood:${n}` }), 'created');
  // In the app: all thirty. By email: twenty, and ONE digest saying the rest are in the app.
  assert.equal((await h.notifier.list('usr_dana')).unread, 30);
  assert.equal(mailsTo(DANA, /^A payment is waiting for your approval/).length, 20);
  assert.equal(mailsTo(DANA, /^More notifications are waiting for you in Global Connect$/).length, 1);

  // Her password-reset link still arrives...
  await request(DANA);
  assert.equal(mailsTo(DANA, RESET).length, 1);
  assert.equal((await audit('client.password_reset.request')).find((entry) => entry.outcome === 'success')?.detail.email, 'sent');
  // ...so does a security notice...
  assert.deepEqual(await h.notices.send({ id: 'usr_dana', email: DANA, name: 'Dana Reid' }, 'client', 'password_changed'), { duplicate: false, state: 'sent', sentAt: h.clock.now });
  assert.equal(mailsTo(DANA, NOTICE).length, 1);
  // ...and so does the WARNING that staff have approved a reset of her authenticator. The delay runs from its delivery.
  const reset = await schedule('usr_dana', 'req_flood');
  assert.deepEqual([reset.status, reset.warnedAt, reset.dueAt], ['waiting', h.clock.now, h.clock.now + 24 * HOUR]);
  assert.match(mailsTo(DANA, NOTICE).at(-1)?.text ?? '', /Global Connect staff have approved a reset of the authenticator on your account/);
  // Nothing of hers is waiting on an allowance or was dropped.
  assert.deepEqual((await h.stores.mail.list({ to: DANA })).filter((row) => row.status !== 'sent').map((row) => [row.class, row.status]), Array.from({ length: 10 }, () => ['payments', 'suppressed']));
  assert.equal((await h.stores.mail.list({ to: DANA })).filter((row) => row.deferred).length, 0);
  // She signs in with what she has: the reset is cancelled, as before.
  assert.equal((await h.login(DANA, dana.secret)).status, 200);
  assert.equal((await resetOf(reset.id)).status, 'cancelled');

  // The operator command says what REALLY became of an invitation: the seventh link to one address in an hour is not "sent".
  const invites = [];
  for (let n = 0; n < 7; n += 1) invites.push((await h.adminCall('/admin/invites', { email: BEN })).json);
  assert.deepEqual(invites.slice(0, 6).map((reply) => [reply.sentTo, reply.email]), Array.from({ length: 6 }, () => ['b…@castlebrook.example', 'sent']));
  assert.deepEqual([invites[6].sentTo, invites[6].queuedFor, invites[6].email], [undefined, 'b…@castlebrook.example', 'deferred']);
  assert.equal((await audit('system.client.activation_link'))[0]?.detail.email, 'deferred');
  // ...and it is delivered, by itself, when the hour has passed.
  const before = h.outbox.sent.filter((message) => message.to === BEN).length;
  h.clock.advance(HOUR + 1);
  await h.mail.pump();
  assert.equal(h.outbox.sent.filter((message) => message.to === BEN).length, before + 1);
});

test('the delay before an authenticator reset starts only when the mail server has ACCEPTED the warning; an undelivered warning holds the reset back; the warning is also shown in the app', async () => {
  h = await harness({ authenticatorResetDelayMs: 24 * HOUR });
  const dana = await h.activate(DANA);
  const send = h.outbox.send.bind(h.outbox);
  let failing = true;
  h.outbox.send = async (message) => {
    if (failing) throw Object.assign(new Error('mail server down'), { code: 'ETIMEDOUT' });
    return send(message);
  };
  // Approved while the mail server is down: the warning is in the outbox, not delivered. Nothing is due.
  const reset = await schedule('usr_dana', 'req_1');
  assert.deepEqual([reset.status, reset.warnedAt], ['waiting', null]);
  assert.deepEqual((await h.authenticatorResets.waitingWithWarning()).map((item) => item.warning), ['queued']);
  // In the app she is told at once, whatever the mail server does.
  const inApp = (await h.notifier.list('usr_dana')).items;
  assert.deepEqual(inApp.map((item) => [item.category, item.title]), [['security', 'Security notice about your account']]);
  assert.match(inApp[0]?.body ?? '', /Global Connect staff have approved a reset of the authenticator on your account\.\nIt has NOT happened yet\. It will not happen before /);
  // The whole delay passes, and more: STILL nothing happens, because she has not been warned by email.
  h.clock.advance(30 * HOUR);
  assert.equal(await h.authenticatorResets.runDue(), 0);
  assert.equal((await userOf('usr_dana')).totpSecret, dana.secret);
  assert.equal((await audit('system.client.reset_authenticator.warned')).length, 0);
  // The mail server comes back; the outbox delivers the warning. The delay starts NOW.
  failing = false;
  await h.mail.pump();
  const sentAt = h.clock.now;
  assert.equal(await h.authenticatorResets.runDue(), 0);
  assert.deepEqual([(await resetOf(reset.id)).warnedAt, (await resetOf(reset.id)).dueAt], [sentAt, sentAt + 24 * HOUR]);
  // The email was written thirty hours ago but names the time counted from when it was SENT (it used to name the earlier one).
  const warning = mailsTo(DANA, NOTICE).find((message) => /It has NOT happened yet/.test(message.text));
  assert.match(warning?.text ?? '', new RegExp(`It will not happen before ${new Date(sentAt + 24 * HOUR).toISOString().slice(0, 16).replace('T', ' ')} UTC\\.`));
  assert.doesNotMatch(`${warning?.text}${warning?.html}`, /\u0001/);
  assert.equal((await audit('system.client.reset_authenticator.warned')).length, 1);
  assert.deepEqual((await h.authenticatorResets.waitingWithWarning()).map((item) => item.warning), ['sent']);
  h.clock.advance(24 * HOUR - 1000);
  assert.equal(await h.authenticatorResets.runDue(), 0);
  assert.equal((await userOf('usr_dana')).totpSecret, dana.secret);
  h.clock.advance(1000);
  assert.equal(await h.authenticatorResets.runDue(), 1);
  assert.equal((await userOf('usr_dana')).totpSecret, null);

  // A warning the mail server refuses for good is not the end of it: it is on record, a fresh one is queued, and the reset goes on waiting.
  const amira = await h.activate(AMIRA);
  failing = true;
  const second = await schedule('usr_amira', 'req_2');
  for (let n = 0; n < 8; n += 1) {
    h.clock.advance(4 * HOUR);
    await h.mail.pump();
  }
  assert.deepEqual((await h.authenticatorResets.waitingWithWarning()).map((item) => item.warning), ['failed']);
  assert.equal(await h.authenticatorResets.runDue(), 0);
  assert.deepEqual([(await resetOf(second.id)).warningTries, (await resetOf(second.id)).warnedAt, (await userOf('usr_amira')).totpSecret], [1, null, amira.secret]);
  assert.equal((await audit('system.client.reset_authenticator.warning_failed')).length, 1);
  failing = false;
  // (A fresh warning is not queued every minute after a refusal: a few minutes later, then longer.)
  assert.equal(await h.authenticatorResets.runDue(), 0);
  assert.equal((await resetOf(second.id)).warnedAt, null);
  h.clock.advance(5 * 60_000);
  assert.equal(await h.authenticatorResets.runDue(), 0);
  assert.equal((await resetOf(second.id)).warnedAt, h.clock.now);
  assert.equal((await userOf('usr_amira')).totpSecret, amira.secret);
});

test('an authenticator reset is claimed before anything is cleared (a sign-in cannot "cancel" one that then clears the credentials); proving you hold the authenticator cancels a pending one', async () => {
  h = await harness({ authenticatorResetDelayMs: 24 * HOUR });
  const amira = await h.activate(AMIRA);
  const first = await schedule('usr_amira', 'req_1');
  h.clock.advance(25 * HOUR);
  // A sign-in's cancellation lands at the worst moment: just as the credentials are about to be cleared.
  const clear = h.auth.clearCredentials.bind(h.auth);
  let cancelledByRace = -1;
  h.auth.clearCredentials = async (userId: string) => {
    cancelledByRace = await h.auth.cancelAuthenticatorResets(await userOf(userId), 'signed in');
    return clear(userId);
  };
  assert.equal(await h.authenticatorResets.runDue(), 1);
  h.auth.clearCredentials = clear;
  // It was too late to cancel, and nothing says it was cancelled: the reset is done and the account says so.
  assert.equal(cancelledByRace, 0);
  assert.equal((await resetOf(first.id)).status, 'done');
  assert.equal((await audit('system.client.reset_authenticator.cancelled')).length, 0);
  assert.equal(mailsTo(AMIRA, NOTICE).filter((message) => /was cancelled\. Nothing was changed/.test(message.text)).length, 0);
  assert.equal((await userOf('usr_amira')).totpSecret, null);
  assert.ok(amira.secret);

  // Dana has a reset pending. She resets her PASSWORD with the emailed link and a code from her authenticator:
  // she plainly still has it, so the authenticator reset is cancelled.
  const dana = await h.activate(DANA);
  const second = await schedule('usr_dana', 'req_2');
  await request(DANA);
  assert.equal((await complete(resetCodeOf(DANA), h.freshCode(dana.secret))).status, 200);
  assert.equal((await resetOf(second.id)).status, 'cancelled');
  assert.equal((await audit('system.client.reset_authenticator.cancelled'))[0]?.detail.by, 'an authenticator code was accepted');
  // The same when she changes her password, signed in, with a code.
  const signedIn = await h.login(DANA, dana.secret, NEW_PASSWORD);
  assert.equal(signedIn.status, 200);
  const third = await schedule('usr_dana', 'req_3');
  const changed = await h.call('POST', '/v1/account/password', { token: signedIn.json.token, body: { currentPassword: NEW_PASSWORD, code: h.freshCode(dana.secret), newPassword: 'emerald kettle window frost' } });
  assert.equal(changed.status, 200, JSON.stringify(changed.json));
  assert.deepEqual([(await resetOf(third.id)).status, (await resetOf(third.id)).closedBy], ['cancelled', 'an authenticator code was accepted']);
  // ANY code from her authenticator that the server accepts does it, in a session she already has: a step-up...
  assert.equal((await h.call('POST', '/v1/session/company', { token: signedIn.json.token, body: { companyId: 'co_northfield' } })).status, 200);
  const viaStepUp = await schedule('usr_dana', 'req_3a');
  const wrong = await h.call('POST', '/v1/step-up', { token: signedIn.json.token, body: { action: 'payment.create', payload: { amount: '1.00' }, code: '000000' } });
  assert.deepEqual([wrong.status, (await resetOf(viaStepUp.id)).status], [400, 'waiting'], 'a wrong code cancels nothing');
  const stepUp = await h.call('POST', '/v1/step-up', { token: signedIn.json.token, body: { action: 'payment.create', payload: { amount: '1.00' }, code: h.freshCode(dana.secret) } });
  assert.equal(stepUp.status, 200, JSON.stringify(stepUp.json));
  assert.equal((await resetOf(viaStepUp.id)).status, 'cancelled');
  // ...and making new recovery codes.
  const viaCodes = await schedule('usr_dana', 'req_3b');
  const newCodes = await h.call('POST', '/v1/account/recovery-codes', { token: signedIn.json.token, body: { code: h.freshCode(dana.secret) } });
  assert.equal(newCodes.status, 200, JSON.stringify(newCodes.json));
  assert.equal((await resetOf(viaCodes.id)).status, 'cancelled');
  dana.recoveryCodes = newCodes.json.recoveryCodes;
  // A RECOVERY code does not show that she holds the authenticator: that reset stays.
  const fourth = await schedule('usr_dana', 'req_4');
  h.clock.advance(HOUR + 1);
  await request(DANA);
  assert.equal((await complete(resetCodeOf(DANA), dana.recoveryCodes[0] as string, 'copper lantern meadow stone', 'recovery')).status, 200);
  assert.equal((await resetOf(fourth.id)).status, 'waiting');
});

test('reset links asked for at the same moment: never more than the limit for one source, and every link that was sent works', async () => {
  h = await harness({}, undefined, { storeLatency: true });
  await h.activate(AMIRA);
  const replies = await Promise.all(Array.from({ length: 15 }, () => h.call('POST', '/v1/auth/password-reset/request', { body: { email: AMIRA } })));
  await h.auth.settle();
  assert.ok(replies.every((reply) => reply.status === 200));
  const codes = h.outbox.sent.filter((message) => message.to === AMIRA && RESET.test(message.subject)).map((message) => /\/reset#code=([A-Z2-7-]+)/.exec(message.text)?.[1] as string);
  assert.equal(codes.length, RESET_LIMITS.perSource);
  const usable = [];
  for (const code of codes) usable.push((await h.call('POST', '/v1/auth/password-reset/start', { body: { resetCode: code } })).status);
  assert.deepEqual(usable, [200, 200]);
  assert.equal((await audit('client.password_reset.request')).filter((entry) => entry.detail.reason === 'rate_limited').length, 13);
});

test('“this was not me”: the warning before an authenticator reset carries a link that CANCELS that reset and does nothing else; it works when the person cannot sign in; it tells nobody anything', async () => {
  h = await harness({ authenticatorResetDelayMs: 24 * HOUR });
  const dana = await h.activate(DANA);
  const cancel = (token: string) => h.call('POST', '/v1/auth/authenticator-reset/cancel', { body: { token } });
  const tokenIn = (email: string) => /\/cancel-reset#token=([A-Za-z0-9_.-]+)/.exec(mailsTo(email, NOTICE).filter((message) => /It has NOT happened yet/.test(message.text)).at(-1)?.text ?? '')?.[1] as string;
  const reset = await schedule('usr_dana', 'req_1');
  const token = tokenIn(DANA);
  assert.match(token, /^ar_[a-f0-9]{16}\.[A-Za-z0-9_-]{43}$/);
  assert.match(mailsTo(DANA, NOTICE).at(-1)?.text ?? '', /open this link and confirm\. It cancels the reset and does nothing else; it cannot be used to sign in\./);

  // (Nothing here needs her to sign in: the route asks for no password, code or session, so a locked sign-in cannot stop it.)
  // Tokens that are not genuine (a guess, another reset's id with this signature, a cut one): the SAME answer, and nothing happens.
  const [id, signature] = token.split('.') as [string, string];
  for (const bad of ['x', `${id}.${'A'.repeat(43)}`, `ar_0123456789abcdef.${signature}`, `${id}.${signature.slice(0, 20)}`, `${token}.more`]) {
    assert.deepEqual([(await cancel(bad)).status, (await cancel(bad)).json], [200, { ok: true }], bad);
  }
  assert.equal((await resetOf(reset.id)).status, 'waiting');
  // The real one: cancelled, audited, and she is told. The answer is the same as for a guess, and it is not a session.
  const done = await cancel(token);
  assert.deepEqual([done.status, done.json], [200, { ok: true }]);
  assert.deepEqual([(await resetOf(reset.id)).status, (await resetOf(reset.id)).closedBy], ['cancelled', 'the link in the warning email']);
  assert.equal((await audit('system.client.reset_authenticator.cancelled')).length, 1);
  assert.equal(mailsTo(DANA, NOTICE).filter((message) => /was cancelled\. Nothing was changed/.test(message.text)).length, 1);
  assert.equal((await h.stores.auth.sessions.count({ userId: 'usr_dana' })), 0);
  assert.equal((await userOf('usr_dana')).totpSecret, dana.secret);
  // Used again, or kept for later: it cancels nothing more. A LATER reset (one she may have asked for herself) has its own link.
  const later = await schedule('usr_dana', 'req_2');
  assert.deepEqual((await cancel(token)).json, { ok: true });
  assert.equal((await resetOf(later.id)).status, 'waiting');
  assert.equal((await audit('system.client.reset_authenticator.cancelled')).length, 1);
  assert.notEqual(tokenIn(DANA), token);
  // A reset that has been carried out cannot be "cancelled" afterwards.
  h.clock.advance(24 * HOUR + 1000);
  assert.equal(await h.authenticatorResets.runDue(), 1);
  assert.deepEqual((await cancel(tokenIn(DANA))).json, { ok: true });
  assert.equal((await resetOf(later.id)).status, 'done');
  // The token and the link are in no audit entry and no log line.
  assert.doesNotMatch(JSON.stringify(await h.stores.audit.query({ limit: 10_000 })) + h.logs.join('\n'), new RegExp(signature));
});
