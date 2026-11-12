import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import { AMIRA, harness, PASSWORD, type Harness } from './helpers';

let h: Harness;
afterEach(async () => h?.close());

test('activation: code -> password -> authenticator -> recovery codes, once', async () => {
  h = await harness();
  const activationCode = await h.invite(AMIRA);

  const start = await h.call('POST', '/v1/activation/start', { body: { activationCode } });
  assert.equal(start.status, 200);
  assert.deepEqual(start.json, { email: AMIRA, displayName: 'Amira Shah', passwordPolicy: { minLength: 12 } });

  for (const password of ['short', 'Password1234']) {
    const weak = await h.call('POST', '/v1/activation/password', { body: { activationCode, password } });
    assert.equal(weak.status, 400);
    assert.equal(weak.json.error.reason, 'weak_password');
  }

  // A code cannot be confirmed before a password is set.
  assert.equal((await h.call('POST', '/v1/activation/confirm', { body: { activationCode, code: '000000' } })).json.error.reason, 'activation_invalid');

  const enrol = await h.call('POST', '/v1/activation/password', { body: { activationCode, password: PASSWORD } });
  assert.equal(enrol.status, 200);
  assert.match(enrol.json.secret, /^[A-Z2-7]{32}$/);
  assert.ok(enrol.json.otpauthUri.startsWith('otpauth://totp/Global%20Connect:amira%40northfield.example?secret='));

  // The account is not usable until a correct code proves the authenticator works.
  assert.equal((await h.call('POST', '/v1/auth/login', { body: { email: AMIRA, password: PASSWORD } })).json.error.reason, 'invalid_credentials');
  const wrong = await h.call('POST', '/v1/activation/confirm', { body: { activationCode, code: '000000' } });
  assert.equal(wrong.json.error.reason, 'invalid_code');

  const done = await h.call('POST', '/v1/activation/confirm', { body: { activationCode, code: h.code(enrol.json.secret) } });
  assert.equal(done.status, 200);
  assert.equal(done.json.recoveryCodes.length, 10);
  assert.equal(new Set(done.json.recoveryCodes).size, 10);

  // The invitation is spent.
  const again = await h.call('POST', '/v1/activation/start', { body: { activationCode } });
  assert.equal(again.status, 400);
  assert.equal(again.json.error.reason, 'activation_invalid');

  assert.equal((await h.login(AMIRA, enrol.json.secret)).status, 200);
});

test('activation codes expire, and unknown codes get the same answer', async () => {
  h = await harness();
  const activationCode = await h.invite(AMIRA);
  const unknown = await h.call('POST', '/v1/activation/start', { body: { activationCode: 'AAAAA-BBBBB-CCCCC-DDDDD' } });
  h.clock.advance(h.config.activationTtlMs + 1);
  const expired = await h.call('POST', '/v1/activation/start', { body: { activationCode } });
  assert.equal(expired.status, 400);
  assert.deepEqual(expired.json, unknown.json);
  assert.equal(expired.json.error.reason, 'activation_invalid');
});

test('a new invitation replaces the old one; an activated account cannot be re-invited', async () => {
  h = await harness();
  const first = await h.invite(AMIRA);
  const second = await h.invite(AMIRA);
  assert.equal((await h.call('POST', '/v1/activation/start', { body: { activationCode: first } })).status, 400);
  assert.equal((await h.call('POST', '/v1/activation/start', { body: { activationCode: second } })).status, 200);
  await h.activate(AMIRA);
  await assert.rejects(h.invite(AMIRA));
});

test('there is no self-signup: the admin endpoint needs the admin token and a directory entry', async () => {
  h = await harness();
  const post = (token: string | undefined, email: string) => h.call('POST', '/admin/invites', { token, body: { email } });
  assert.equal((await post(undefined, AMIRA)).status, 404);
  assert.equal((await post('wrong-token-0123456789', AMIRA)).status, 404);
  assert.equal((await post('test-admin-token-0123456789', 'stranger@nowhere.example')).status, 404);
  const ok = await post('test-admin-token-0123456789', AMIRA);
  assert.equal(ok.status, 200);
  assert.match(ok.json.activationCode, /^[A-Z2-7]{5}(-[A-Z2-7]{5}){3}$/);
  assert.ok(ok.json.activationLink.endsWith(`/activate?code=${ok.json.activationCode}`));
});

test('sign-in: wrong password, unknown email and a not-yet-activated account are indistinguishable', async () => {
  h = await harness();
  await h.activate(AMIRA);
  const attempt = (email: string, password: string) => h.call('POST', '/v1/auth/login', { body: { email, password } });
  const wrongPassword = await attempt(AMIRA, 'not the password!!');
  const unknown = await attempt('nobody@nowhere.example', PASSWORD);
  const notActivated = await attempt('ben@castlebrook.example', PASSWORD);
  assert.equal(wrongPassword.status, 400);
  for (const reply of [unknown, notActivated]) {
    assert.equal(reply.status, wrongPassword.status);
    assert.deepEqual(reply.json, wrongPassword.json);
  }
  assert.deepEqual(wrongPassword.json, { error: { kind: 'validation', reason: 'invalid_credentials' } });
});

test('sign-in: password lockout is progressive and behaves the same for an unknown email', async () => {
  h = await harness();
  await h.activate(AMIRA);
  for (const email of [AMIRA, 'nobody@nowhere.example']) {
    const attempt = (password: string) => h.call('POST', '/v1/auth/login', { body: { email, password } });
    for (let i = 0; i < 5; i += 1) assert.equal((await attempt('wrong wrong wrong')).json.error.reason, 'invalid_credentials');
    // Locked: even the right password is refused, with the same answer either way.
    const locked = await attempt(PASSWORD);
    assert.equal(locked.status, 429);
    assert.equal(locked.json.error.reason, 'locked');
    assert.equal(locked.json.error.retryAfterSeconds, 60);
    assert.equal(locked.headers['retry-after'], '60');

    h.clock.advance(61_000);
    // One more failure after the first lock doubles it.
    assert.equal((await attempt('wrong wrong wrong')).json.error.reason, 'invalid_credentials');
    assert.equal((await attempt(PASSWORD)).json.error.retryAfterSeconds, 120);
    h.clock.advance(121_000);
  }
  // After the lock passes, the right password works and clears the count.
  assert.equal((await h.call('POST', '/v1/auth/login', { body: { email: AMIRA, password: PASSWORD } })).status, 200);
});

test('sign-in: wrong codes use up the challenge and lock the code check', async () => {
  h = await harness();
  const { secret } = await h.activate(AMIRA);
  const challenge = async () => (await h.call('POST', '/v1/auth/login', { body: { email: AMIRA, password: PASSWORD } })).json.challengeId;
  const verify = (challengeId: string, code: string) => h.call('POST', '/v1/auth/login/verify', { body: { challengeId, code, method: 'totp' } });

  const first = await challenge();
  for (let i = 0; i < 4; i += 1) assert.equal((await verify(first, '000000')).json.error.reason, 'invalid_code');
  // The fifth failure both spends the challenge and starts the lock.
  assert.equal((await verify(first, '000000')).json.error.reason, 'invalid_code');
  assert.equal((await verify(first, '000000')).json.error.reason, 'challenge_expired');

  const second = await challenge();
  // Locked: the check is refused before the code is even looked at.
  h.clock.advance(30_000);
  const locked = await verify(second, h.code(secret));
  assert.equal(locked.status, 429);
  assert.equal(locked.json.error.reason, 'locked');

  h.clock.advance(61_000);
  assert.equal((await verify(await challenge(), h.freshCode(secret))).status, 200);
});

test('sign-in: a challenge expires, and an unknown challenge gets the same answer', async () => {
  h = await harness();
  const { secret } = await h.activate(AMIRA);
  const { challengeId } = (await h.call('POST', '/v1/auth/login', { body: { email: AMIRA, password: PASSWORD } })).json;
  h.clock.advance(h.config.loginChallengeTtlMs + 1);
  const expired = await h.call('POST', '/v1/auth/login/verify', { body: { challengeId, code: h.code(secret), method: 'totp' } });
  const unknown = await h.call('POST', '/v1/auth/login/verify', { body: { challengeId: 'made-up', code: h.code(secret), method: 'totp' } });
  assert.equal(expired.json.error.reason, 'challenge_expired');
  assert.deepEqual(unknown.json, expired.json);
});

test('authenticator codes: one step of drift either way is accepted, two is not, and no code works twice', async () => {
  h = await harness();
  const { secret } = await h.activate(AMIRA);
  const tryCode = async (code: string) => {
    const { challengeId } = (await h.call('POST', '/v1/auth/login', { body: { email: AMIRA, password: PASSWORD } })).json;
    return h.call('POST', '/v1/auth/login/verify', { body: { challengeId, code, method: 'totp' } });
  };
  // Activation used the current step, so that same code is now a replay.
  assert.equal((await tryCode(h.code(secret))).json.error.reason, 'code_reused');

  h.clock.advance(90_000);
  assert.equal((await tryCode(h.code(secret, -2))).json.error.reason, 'invalid_code');
  assert.equal((await tryCode(h.code(secret, 2))).json.error.reason, 'invalid_code');
  // A phone running 30 seconds slow.
  const slow = h.code(secret, -1);
  assert.equal((await tryCode(slow)).status, 200);
  assert.equal((await tryCode(slow)).json.error.reason, 'code_reused');
  // A phone running 30 seconds fast.
  const fast = h.code(secret, 1);
  assert.equal((await tryCode(fast)).status, 200);
  assert.equal((await tryCode(fast)).json.error.reason, 'code_reused');
  // Once a later step has been used, earlier ones are dead too.
  assert.equal((await tryCode(h.code(secret))).json.error.reason, 'code_reused');
});

test('recovery codes: each signs in once, in place of an authenticator code', async () => {
  h = await harness();
  const { recoveryCodes } = await h.activate(AMIRA);
  const withRecovery = async (code: string) => {
    const { challengeId } = (await h.call('POST', '/v1/auth/login', { body: { email: AMIRA, password: PASSWORD } })).json;
    return h.call('POST', '/v1/auth/login/verify', { body: { challengeId, code, method: 'recovery' } });
  };
  const code = recoveryCodes[0] as string;
  // Typed in lower case without the hyphen still works.
  assert.equal((await withRecovery(code.toLowerCase().replace('-', ' '))).status, 200);
  assert.equal((await withRecovery(code)).json.error.reason, 'invalid_code');
  assert.equal((await withRecovery(recoveryCodes[1] as string)).status, 200);
  assert.equal((await withRecovery('AAAAA-AAAAA')).json.error.reason, 'invalid_code');
  // A recovery code is not accepted as an authenticator code.
  const { challengeId } = (await h.call('POST', '/v1/auth/login', { body: { email: AMIRA, password: PASSWORD } })).json;
  const asTotp = await h.call('POST', '/v1/auth/login/verify', { body: { challengeId, code: recoveryCodes[2], method: 'totp' } });
  assert.equal(asTotp.json.error.reason, 'invalid_code');
});

test('sessions: idle expiry, absolute expiry and revocation on sign-out', async () => {
  h = await harness();
  const { secret } = await h.activate(AMIRA);
  const balances = (token: string) => h.call('GET', '/v1/balances', { token });

  // Idle: activity keeps it alive, silence ends it.
  let token = (await h.login(AMIRA, secret)).json.token as string;
  h.clock.advance(h.config.sessionIdleMs - 1000);
  assert.equal((await balances(token)).status, 200);
  h.clock.advance(h.config.sessionIdleMs - 1000);
  assert.equal((await balances(token)).status, 200);
  h.clock.advance(h.config.sessionIdleMs + 1);
  const idle = await balances(token);
  assert.equal(idle.status, 401);
  assert.deepEqual(idle.json, { error: { kind: 'unauthorized' } });

  // Absolute: even a busy session ends.
  token = (await h.login(AMIRA, secret)).json.token as string;
  const started = h.clock.now;
  while (h.clock.now - started < h.config.sessionAbsoluteMs - 60_000) {
    h.clock.advance(10 * 60_000);
    assert.equal((await balances(token)).status, 200);
  }
  h.clock.advance(2 * 60_000);
  assert.equal((await balances(token)).status, 401);

  // Sign-out revokes on the server.
  token = (await h.login(AMIRA, secret)).json.token as string;
  assert.equal((await balances(token)).status, 200);
  assert.equal((await h.call('POST', '/v1/auth/logout', { token })).status, 200);
  assert.equal((await balances(token)).status, 401);

  // No token, or a made-up one.
  assert.equal((await h.call('GET', '/v1/balances')).status, 401);
  assert.equal((await balances('made-up-token')).status, 401);
});

test('the per-address rate limit answers 429 without touching the account', async () => {
  h = await harness({ authRequestsPerMinute: 3 });
  for (let i = 0; i < 3; i += 1) assert.equal((await h.call('POST', '/v1/auth/login', { body: { email: AMIRA, password: 'x' } })).status, 400);
  const limited = await h.call('POST', '/v1/auth/login', { body: { email: AMIRA, password: 'x' } });
  assert.equal(limited.status, 429);
  assert.equal(limited.json.error.kind, 'rate_limited');
  assert.equal(limited.json.error.reason, undefined);
  h.clock.advance(61_000);
  assert.equal((await h.call('POST', '/v1/auth/login', { body: { email: AMIRA, password: 'x' } })).status, 400);
});

test('tokens, passwords and recovery codes are stored only as hashes', async () => {
  h = await harness();
  const { secret, recoveryCodes } = await h.activate(AMIRA);
  const activationCode = await h.invite('ben@castlebrook.example');
  const { challengeId } = (await h.call('POST', '/v1/auth/login', { body: { email: AMIRA, password: PASSWORD } })).json;
  const token = (await h.login(AMIRA, secret)).json.token as string;
  const stepUpToken = await h.stepUp(token, secret, 'payment.approve', { paymentId: 'x' });

  // Everything the in-memory stores hold, as text. (The authenticator key itself has to be
  // readable by the server to check codes; a database must encrypt it at rest.)
  const tables = h.stores.auth as unknown as Record<string, { rows: Map<string, unknown> }>;
  const dump = JSON.stringify([await h.stores.directory.listUsers(), Object.values(tables).map((table) => [...table.rows.entries()])]);
  for (const value of [PASSWORD, token, stepUpToken, challengeId, activationCode, activationCode.replace(/-/g, ''), ...recoveryCodes]) {
    assert.ok(!dump.includes(value), 'a secret was stored in the clear');
  }
  assert.ok(dump.includes('scrypt$'));
});
