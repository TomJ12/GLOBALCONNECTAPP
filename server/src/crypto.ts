/** Hashing, random tokens, passwords and TOTP. node:crypto only: no native add-ons. */
import { createHash, createHmac, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

import { ApiError } from './errors';

export function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** 256 random bits, URL-safe. Used for session, challenge and step-up tokens. Only its hash is stored. */
export function randomToken(): string {
  return randomBytes(32).toString('base64url');
}

export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

// --- Base32 (RFC 4648), the alphabet authenticator apps expect ----------------

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text: string): Buffer {
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of text.replace(/[\s=-]/g, '').toUpperCase()) {
    const index = BASE32.indexOf(char);
    if (index < 0) throw new Error('Invalid base32');
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** A typeable one-time code: `groups` blocks of five base32 characters (25 bits each). */
export function randomCode(groups: number): string {
  const text = base32Encode(randomBytes(Math.ceil((groups * 25) / 8))).slice(0, groups * 5);
  return (text.match(/.{5}/g) ?? []).join('-');
}

/** Codes are compared without regard to case, spaces or hyphens. */
export function normaliseCode(code: string): string {
  return code.replace(/[\s-]/g, '').toUpperCase();
}

// --- Passwords: scrypt --------------------------------------------------------

/** N=2^17, r=8, p=1: about 128 MiB and a few hundred milliseconds per hash. */
export const PASSWORD_COST = 2 ** 17;
const SCRYPT = { N: PASSWORD_COST, r: 8, p: 1, keyLength: 32 };
/** A stored hash with a cost above this is refused rather than computed. */
const MAX_COST = 2 ** 20;
/**
 * Hashing is rationed, in three separate pools, so that the cheapest work to
 * abuse can never crowd out real people:
 *
 *  - `client`: verifying or setting the password of a real, usable client
 *    account. What can reach it is bounded by the lockout (a few attempts per
 *    account and address).
 *  - `staff`: the same for staff. Reserved: client traffic cannot touch it.
 *  - `decoy`: the hash done for a sign-in attempt on an email that has no
 *    usable account. Anyone can cause these for free, so they get one slot and
 *    a very short queue of their own, and when that is busy the attempt is
 *    answered after a wait of about one hash instead of a hash (see
 *    `decoyVerify`). A flood of them costs neither memory nor a place in the
 *    queue real accounts use.
 *
 * Each pool runs a few hashes at a time (128 MiB each) and lets a few more
 * wait. A full `client` or `staff` queue refuses the request (429).
 */
export type HashPool = 'client' | 'staff';
interface Pool {
  max: number;
  queue: number;
  running: number;
  waiting: (() => void)[];
}
const POOLS: Record<HashPool | 'decoy', Pool> = {
  client: { max: 2, queue: 32, running: 0, waiting: [] },
  staff: { max: 1, queue: 16, running: 0, waiting: [] },
  decoy: { max: 1, queue: 2, running: 0, waiting: [] },
};
/** Counts of work done, for tests and for an operator to look at. */
export const passwordWork = { hashes: 0, decoyHashes: 0, decoyWaits: 0 };
/** Rolling average of how long one hash takes, so a decoy wait looks like one. */
let averageHashMs = 250;

/** The cost new hashes are made with. Tests lower it; nothing else should. */
export function setPasswordCost(N: number): void {
  SCRYPT.N = N;
}

const hasRoom = (pool: Pool): boolean => pool.running < pool.max || pool.waiting.length < pool.queue;

async function withSlot<T>(name: HashPool | 'decoy', run: () => Promise<T>): Promise<T> {
  const pool = POOLS[name];
  if (pool.running >= pool.max) {
    if (pool.waiting.length >= pool.queue) throw new ApiError('rate_limited', { retryAfterSeconds: 5 });
    await new Promise<void>((resolve) => pool.waiting.push(resolve));
  } else {
    pool.running += 1;
  }
  try {
    return await run();
  } finally {
    const next = pool.waiting.shift();
    // The slot passes straight to the next waiter, so `running` stays the same.
    if (next) next();
    else pool.running -= 1;
  }
}

function scryptAsync(secret: string, salt: Buffer, N: number, r: number, p: number, keyLength: number, pool: HashPool | 'decoy' = 'client'): Promise<Buffer> {
  return withSlot(pool, async () => {
    const started = performance.now();
    const key = await new Promise<Buffer>((resolve, reject) => {
      scrypt(secret.normalize('NFKC'), salt, keyLength, { N, r, p, maxmem: 128 * N * r + 32 * 1024 * 1024 }, (error, derived) => (error ? reject(error) : resolve(derived)));
    });
    if (N === SCRYPT.N) averageHashMs = averageHashMs * 0.8 + (performance.now() - started) * 0.2;
    return key;
  });
}

export async function hashPassword(password: string, pool: HashPool = 'client'): Promise<string> {
  const salt = randomBytes(16);
  const { N, r, p, keyLength } = SCRYPT;
  const key = await scryptAsync(password, salt, N, r, p, keyLength, pool);
  return ['scrypt', N, r, p, salt.toString('base64'), key.toString('base64')].join('$');
}

export async function verifyPassword(password: string, stored: string, pool: HashPool = 'client'): Promise<boolean> {
  const [scheme, N, r, p, salt, key] = stored.split('$');
  if (scheme !== 'scrypt' || !N || !r || !p || !salt || !key) return false;
  const cost = Number(N);
  if (!Number.isInteger(cost) || cost < 2 || cost > MAX_COST || Number(r) !== 8 || Number(p) !== 1) return false;
  const expected = Buffer.from(key, 'base64');
  passwordWork.hashes += 1;
  const actual = await scryptAsync(password, Buffer.from(salt, 'base64'), cost, 8, 1, expected.length, pool);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

const DECOY_SALT = randomBytes(16);

/**
 * The work done for a sign-in attempt that cannot succeed because there is no
 * usable account. Always answers false, and never refuses.
 *
 * When the decoy pool has room it does a real hash, so an attempt on an
 * unknown email costs and takes what one on a real email does. When it has
 * not (someone is flooding), it waits about as long as a hash currently takes
 * instead. The answer is the same either way. What can differ is timing, and
 * only during a flood: the wait follows the recent average, not the load a
 * real account's hash is under at that moment, so someone timing responses
 * while flooding could tell known emails from unknown ones. That is the price
 * of not letting unknown emails starve real sign-ins.
 */
export async function decoyVerify(password: string): Promise<false> {
  if (hasRoom(POOLS.decoy)) {
    passwordWork.decoyHashes += 1;
    await scryptAsync(password, DECOY_SALT, SCRYPT.N, SCRYPT.r, SCRYPT.p, SCRYPT.keyLength, 'decoy');
    return false;
  }
  passwordWork.decoyWaits += 1;
  await new Promise((resolve) => setTimeout(resolve, averageHashMs * (0.85 + Math.random() * 0.3)));
  return false;
}

/** True when a hash was made with a lower cost than today's, so it should be replaced at the next successful sign-in. */
export function passwordNeedsRehash(stored: string): boolean {
  return Number(stored.split('$')[1]) < SCRYPT.N;
}

// --- Recovery codes -------------------------------------------------------------

/** 100 random bits each, shown as four groups of five characters. */
export const RECOVERY_CODE_GROUPS = 4;
const RECOVERY_COST = 2 ** 14;

/** Stored as `rc1$<salt>$<scrypt>`: one random salt per set, so a set costs one scrypt to check. */
export async function hashRecoveryCodes(codes: string[], pool: HashPool = 'client'): Promise<string[]> {
  const salt = randomBytes(16);
  const out: string[] = [];
  for (const code of codes) {
    const key = await scryptAsync(normaliseCode(code), salt, RECOVERY_COST, 8, 1, 32, pool);
    out.push(['rc1', salt.toString('base64'), key.toString('base64')].join('$'));
  }
  return out;
}

/** The stored entry this code matches, or null. */
export async function matchRecoveryCode(code: string, stored: string[], pool: HashPool = 'client'): Promise<string | null> {
  const candidate = normaliseCode(code);
  const computed = new Map<string, string>();
  let match: string | null = null;
  for (const entry of stored) {
    const [scheme, salt, key] = entry.split('$');
    if (scheme !== 'rc1' || !salt || !key) continue;
    if (!computed.has(salt)) computed.set(salt, (await scryptAsync(candidate, Buffer.from(salt, 'base64'), RECOVERY_COST, 8, 1, 32, pool)).toString('base64'));
    if (safeEqual(computed.get(salt) as string, key) && match === null) match = entry;
  }
  return match;
}

export const PASSWORD_MIN_LENGTH = 12;
const PASSWORD_MAX_LENGTH = 200;
/** A SHORT sample list. A real deployment should check against a breached-password corpus. */
const COMMON_PASSWORDS = new Set([
  'password1234',
  'password12345',
  'passwordpassword',
  '123456789012',
  '1234567890123',
  '111111111111',
  '000000000000',
  'qwertyuiop12',
  'qwertyuiopas',
  'qwerty123456',
  'iloveyou1234',
  'letmein12345',
  'welcome12345',
  'admin1234567',
  'administrator',
  'changeme1234',
  'abcdefghijkl',
  'abc123abc123',
  'globalconnect',
  'globalconnect1',
  'globalconnect123',
]);

export function passwordProblem(password: string): 'too_short' | 'too_long' | 'common' | null {
  if (password.length < PASSWORD_MIN_LENGTH) return 'too_short';
  if (password.length > PASSWORD_MAX_LENGTH) return 'too_long';
  if (COMMON_PASSWORDS.has(password.toLowerCase())) return 'common';
  return null;
}

// --- TOTP (RFC 6238: HMAC-SHA1, 30 second step, 6 digits) ----------------------

export const TOTP_STEP_SECONDS = 30;
const TOTP_DIGITS = 6;

export function totpStep(nowMs: number): number {
  return Math.floor(nowMs / 1000 / TOTP_STEP_SECONDS);
}

export function totpCode(secret: Buffer, step: number, digits = TOTP_DIGITS): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const mac = createHmac('sha1', secret).update(counter).digest();
  const offset = (mac[mac.length - 1] ?? 0) & 0x0f;
  const binary = mac.readUInt32BE(offset) & 0x7fffffff;
  return (binary % 10 ** digits).toString().padStart(digits, '0');
}

export function newTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

export type TotpCheck = { ok: true; step: number } | { ok: false; reason: 'invalid' | 'reused' };

/**
 * Accepts the code for the current 30-second step or one step either side
 * (clock drift). A step at or before `lastUsedStep` is refused, so a code that
 * has been used once cannot be replayed, even inside its own window.
 */
export function checkTotp(secretBase32: string, code: string, nowMs: number, lastUsedStep: number): TotpCheck {
  const candidate = code.replace(/\s/g, '');
  if (!/^\d{6}$/.test(candidate)) return { ok: false, reason: 'invalid' };
  const secret = base32Decode(secretBase32);
  const current = totpStep(nowMs);
  let matched: number | null = null;
  for (const step of [current - 1, current, current + 1]) {
    if (safeEqual(totpCode(secret, step), candidate) && matched === null) matched = step;
  }
  if (matched === null) return { ok: false, reason: 'invalid' };
  if (matched <= lastUsedStep) return { ok: false, reason: 'reused' };
  return { ok: true, step: matched };
}

export function otpauthUri(issuer: string, account: string, secretBase32: string): string {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`;
  return `otpauth://totp/${label}?secret=${secretBase32}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}
