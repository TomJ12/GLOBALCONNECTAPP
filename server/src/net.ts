/**
 * Where a request came from, at the granularity abuse controls use.
 *
 * One person seldom keeps one address: a phone moves within its carrier's
 * range, and an IPv6 customer is handed a whole /64 to pick addresses from.
 * So counters keyed by the exact address are free to walk around. `network`
 * is the IPv4 /24 or the IPv6 /64 the address sits in.
 */
import { isIP } from 'node:net';

/** Expands an IPv6 address to its first four 16-bit groups (the /64). */
function ipv6Prefix(address: string): string {
  const [head = '', tail = ''] = address.split('%')[0]?.split('::') ?? [];
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const groups = address.includes('::') ? [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill('0'), ...right] : left;
  return groups
    .slice(0, 4)
    .map((group) => (parseInt(group, 16) || 0).toString(16))
    .join(':');
}

export function networkOf(address: string): string {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address)?.[1];
  const plain = mapped ?? address;
  if (isIP(plain) === 4) return `${plain.split('.').slice(0, 3).join('.')}.0/24`;
  if (isIP(plain) === 6) return `${ipv6Prefix(plain)}::/64`;
  return plain;
}

/**
 * The key for "this source": the exact IPv4 address, but the whole /64 for
 * IPv6, where a single customer controls every address in it.
 */
export function sourceOf(address: string): string {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address)?.[1];
  const plain = mapped ?? address;
  return isIP(plain) === 6 ? networkOf(plain) : plain;
}
