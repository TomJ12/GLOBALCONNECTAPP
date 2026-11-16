/**
 * A digest of everything a provider holds about a payee, for noticing that
 * the destination of a payment changed between its creation and its approval.
 *
 * It is taken over the provider's RAW record, not over the neutral fields the
 * app shows: every routing code of every kind, the account number, IBAN, BIC,
 * holder, country, currency, payment types, addresses, and ANY field this
 * code has never heard of. A new provider field is therefore part of the
 * digest by default; only the fields named in `ignore` (timestamps that move
 * without the destination changing) are left out.
 *
 * Values are normalised so that formatting alone does not look like a change:
 * strings are trimmed, empty values (null, "", [], {}) count as absent, keys
 * are sorted. Letter case and digits are NOT altered: a change in either is
 * a change.
 */
import { canonicalJson } from './canonical';

function normalise(value: unknown): unknown {
  if (value === null || value === undefined) return undefined;
  if (typeof value === 'string') {
    const text = value.trim();
    return text === '' ? undefined : text;
  }
  if (Array.isArray(value)) {
    const items = value.map(normalise).filter((item) => item !== undefined);
    return items.length === 0 ? undefined : items;
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .map(([key, item]) => [key, normalise(item)] as const)
      .filter(([, item]) => item !== undefined);
    return entries.length === 0 ? undefined : Object.fromEntries(entries);
  }
  return value;
}

/** The canonical text that is hashed. Exposed so that the two ends (app adapter, server) hash the same thing. */
export function payeeDigestSource(raw: Record<string, unknown>, ignore: readonly string[]): string {
  const kept = Object.fromEntries(Object.entries(raw).filter(([key]) => !ignore.includes(key)));
  return canonicalJson(normalise(kept) ?? {});
}
