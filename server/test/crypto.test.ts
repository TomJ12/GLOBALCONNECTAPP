import assert from 'node:assert/strict';
import { test } from 'node:test';

import { canonicalJson } from '@/api/canonical';

import { base32Decode, base32Encode, checkTotp, hashPassword, otpauthUri, passwordProblem, totpCode, verifyPassword } from '../src/crypto';

test('TOTP matches the RFC 6238 SHA-1 test vectors', () => {
  const secret = Buffer.from('12345678901234567890');
  // RFC 6238 appendix B gives 8 digits; the last 6 are what a 6-digit app shows.
  assert.equal(totpCode(secret, Math.floor(59 / 30), 8), '94287082');
  assert.equal(totpCode(secret, Math.floor(1111111109 / 30), 8), '07081804');
  assert.equal(totpCode(secret, Math.floor(1234567890 / 30), 8), '89005924');
  assert.equal(totpCode(secret, Math.floor(59 / 30)), '287082');
});

test('base32 round-trips and matches the RFC 4648 example', () => {
  assert.equal(base32Encode(Buffer.from('foobar')), 'MZXW6YTBOI');
  assert.equal(base32Decode('MZXW6YTBOI').toString(), 'foobar');
  assert.equal(base32Decode('mzxw 6ytb-oi').toString(), 'foobar');
});

test('the otpauth URI is the standard form authenticator apps read', () => {
  assert.equal(
    otpauthUri('Global Connect', 'a@b.example', 'JBSWY3DPEHPK3PXP'),
    'otpauth://totp/Global%20Connect:a%40b.example?secret=JBSWY3DPEHPK3PXP&issuer=Global%20Connect&algorithm=SHA1&digits=6&period=30',
  );
});

test('a code is accepted one step either side, and never twice', () => {
  const secret = base32Encode(Buffer.from('12345678901234567890'));
  const at = 1_700_000_000_000;
  const step = Math.floor(at / 30_000);
  const codeAt = (offset: number) => totpCode(base32Decode(secret), step + offset);
  assert.deepEqual(checkTotp(secret, codeAt(0), at, 0), { ok: true, step });
  assert.deepEqual(checkTotp(secret, codeAt(-1), at, 0), { ok: true, step: step - 1 });
  assert.deepEqual(checkTotp(secret, codeAt(1), at, 0), { ok: true, step: step + 1 });
  assert.deepEqual(checkTotp(secret, codeAt(-2), at, 0), { ok: false, reason: 'invalid' });
  assert.deepEqual(checkTotp(secret, codeAt(2), at, 0), { ok: false, reason: 'invalid' });
  assert.deepEqual(checkTotp(secret, codeAt(0), at, step), { ok: false, reason: 'reused' });
  // An older step is refused once a newer one has been used.
  assert.deepEqual(checkTotp(secret, codeAt(-1), at, step), { ok: false, reason: 'reused' });
  assert.deepEqual(checkTotp(secret, '12345', at, 0), { ok: false, reason: 'invalid' });
});

test('passwords are hashed with scrypt and checked against the policy', async () => {
  const hash = await hashPassword('correct horse battery');
  assert.match(hash, /^scrypt\$16384\$8\$1\$/);
  assert.ok(!hash.includes('correct'));
  assert.equal(await verifyPassword('correct horse battery', hash), true);
  assert.equal(await verifyPassword('correct horse batterz', hash), false);
  assert.equal(passwordProblem('short'), 'too_short');
  assert.equal(passwordProblem('Password1234'), 'common');
  assert.equal(passwordProblem('correct horse battery'), null);
});

test('canonical JSON ignores key order and undefined', () => {
  assert.equal(canonicalJson({ b: 1, a: { d: undefined, c: [2, { z: 1, y: 2 }] } }), '{"a":{"c":[2,{"y":2,"z":1}]},"b":1}');
});
