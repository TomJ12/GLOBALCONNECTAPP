let counter = 0;

/**
 * A key that is unique for one attempt to move money. The same key is re-sent
 * on a retry so the backend can refuse to do the same thing twice.
 * Not a secret, so it does not need a cryptographic source.
 */
export function newIdempotencyKey(prefix: string): string {
  counter += 1;
  const random = Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, '0');
  return `${prefix}-${Date.now().toString(36)}-${counter.toString(36)}-${random}`;
}
