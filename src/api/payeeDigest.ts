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

/** Removes the ignored fields. A name without a dot is a top-level field; "a.b" is field b inside a (inside each item, if a is a list). */
function without(value: unknown, ignore: readonly string[], prefix: string): unknown {
  if (Array.isArray(value)) return value.map((item) => without(item, ignore, prefix));
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !ignore.includes(`${prefix}${key}`))
      .map(([key, item]) => [key, without(item, ignore, `${prefix}${key}.`)]),
  );
}

/**
 * The canonical text that is hashed. Exposed so that the two ends (app adapter, server) hash the same thing.
 * `ignore` is the adapter's explicit list of fields that move without the destination changing; nothing else is left out.
 */
export function payeeDigestSource(raw: Record<string, unknown>, ignore: readonly string[]): string {
  return canonicalJson(normalise(without(raw, ignore, '')) ?? {});
}

/**
 * The same record field by field: the dotted name of every value in it, with
 * that value's canonical text. For saying WHICH field differs between two
 * digests (names only are ever reported; values are compared, not shown).
 */
export function payeeDigestFields(source: string): Record<string, string> {
  const fields: Record<string, string> = {};
  const walk = (value: unknown, name: string): void => {
    if (Array.isArray(value)) value.forEach((item, index) => walk(item, `${name}[${index}]`));
    else if (value !== null && typeof value === 'object') for (const [key, item] of Object.entries(value as Record<string, unknown>)) walk(item, name ? `${name}.${key}` : key);
    else fields[name] = JSON.stringify(value);
  };
  walk(JSON.parse(source) as unknown, '');
  return fields;
}
