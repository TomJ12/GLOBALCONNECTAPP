/**
 * Encryption of authenticator (TOTP) keys at rest, and the key that chains
 * the audit log. AES-256-GCM, with the key taken from the environment
 * (DATA_ENCRYPTION_KEY) and NEVER written to the database.
 *
 * Each ciphertext names the key that made it (`keyId`), so the key can be
 * rotated: the new key encrypts, older keys (DATA_ENCRYPTION_KEY_PREVIOUS)
 * can still decrypt, and `npm run db:rotate-key` re-encrypts everything with
 * the new one.
 */
import { createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes } from 'node:crypto';

export interface DataKey {
  id: string;
  key: Buffer;
}

export interface DataKeys {
  current: DataKey;
  /** Current first, then older ones. */
  all: DataKey[];
}

/** A key must be 32 random bytes, written in base64 (as `openssl rand -base64 32` prints). */
export function dataKeyProblem(text: string): string | null {
  if (!/^[A-Za-z0-9+/_-]{43}=?$/.test(text.trim())) return 'it is not 32 bytes in base64 (generate one with: openssl rand -base64 32)';
  const key = Buffer.from(text.trim(), 'base64');
  if (key.length !== 32) return 'it does not decode to exactly 32 bytes';
  if (new Set(key).size < 20) return 'it does not look random (too few different bytes)';
  return null;
}

export function parseDataKey(text: string): DataKey {
  const problem = dataKeyProblem(text);
  if (problem) throw new Error(`The data encryption key is refused because ${problem}.`);
  const key = Buffer.from(text.trim(), 'base64');
  // The id identifies the key without revealing anything useful about it.
  return { id: createHash('sha256').update('gc-data-key-id').update(key).digest('hex').slice(0, 12), key };
}

export function dataKeys(current: string, previous: string[] = []): DataKeys {
  const first = parseDataKey(current);
  const all = [first, ...previous.map(parseDataKey).filter((item) => item.id !== first.id)];
  return { current: first, all };
}

export const newDataKey = (): string => randomBytes(32).toString('base64');

export interface Sealed {
  text: string;
  keyId: string;
}

/**
 * `context` (for example "users:usr_1:totp") is authenticated with the
 * ciphertext, so a value copied from one row to another does not decrypt.
 */
export function seal(keys: DataKeys, plain: string, context: string): Sealed {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', keys.current.key, iv);
  cipher.setAAD(Buffer.from(context));
  const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return { keyId: keys.current.id, text: ['gcm1', keys.current.id, iv.toString('base64'), body.toString('base64'), cipher.getAuthTag().toString('base64')].join(':') };
}

export function open(keys: DataKeys, sealed: string, context: string): string {
  const [scheme, keyId, iv, body, tag] = sealed.split(':');
  const key = keys.all.find((item) => item.id === keyId);
  if (scheme !== 'gcm1' || !iv || !body || !tag) throw new Error('A stored secret is not in the expected encrypted form.');
  if (!key) throw new Error(`A stored secret was encrypted with a key this server was not given (key id ${keyId}). Set DATA_ENCRYPTION_KEY, or DATA_ENCRYPTION_KEY_PREVIOUS, to the key it was encrypted with.`);
  const decipher = createDecipheriv('aes-256-gcm', key.key, Buffer.from(iv, 'base64'));
  decipher.setAAD(Buffer.from(context));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(body, 'base64')), decipher.final()]).toString('utf8');
}

export const sealedKeyId = (sealed: string): string => sealed.split(':')[1] ?? '';

/** The audit chain's key, derived from a data key, so a copy of the database alone cannot forge a chain. */
export function chainHash(key: DataKey, previous: string, entry: string): string {
  const derived = Buffer.from(hkdfSync('sha256', key.key, Buffer.alloc(0), 'gc-audit-chain', 32));
  return createHmac('sha256', derived).update(previous).update('\n').update(entry).digest('hex');
}
