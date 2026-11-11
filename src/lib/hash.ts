/**
 * Short, stable, non-reversible-by-eye label for a user identifier, used in
 * device storage keys so no email address or user id is left readable there.
 * FNV-1a: this is NOT a security measure, only a way to avoid storing the value.
 */
export function storageLabel(value: string): string {
  let hash = 0x811c9dc5;
  for (const char of value.trim().toLowerCase()) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}
