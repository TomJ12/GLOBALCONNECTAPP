/** Hashing, random tokens, passwords and TOTP. node:crypto only: no native add-ons. */
import { createHash, createHmac, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

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

const SCRYPT = { N: 16384, r: 8, p: 1, keyLength: 32 };

function scryptAsync(password: string, salt: Buffer, N: number, r: number, p: number, keyLength: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password.normalize('NFKC'), salt, keyLength, { N, r, p }, (error, key) => (error ? reject(error) : resolve(key)));
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scryptAsync(password, salt, SCRYPT.N, SCRYPT.r, SCRYPT.p, SCRYPT.keyLength);
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64'), key.toString('base64')].join('$');
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, N, r, p, salt, key] = stored.split('$');
  if (scheme !== 'scrypt' || !N || !r || !p || !salt || !key) return false;
  const expected = Buffer.from(key, 'base64');
  const actual = await scryptAsync(password, Buffer.from(salt, 'base64'), Number(N), Number(r), Number(p), expected.length);
  return timingSafeEqual(actual, expected);
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
