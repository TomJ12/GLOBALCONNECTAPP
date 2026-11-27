/**
 * MOCK ONLY: makes a sample rate move, so that rates, alerts and held quotes
 * behave in a demo the way they do when a market is open.
 *
 * A deterministic random walk, seeded per pair: the same pair at the same
 * time always gives the same rate, on any machine and after a restart. Every
 * STEP_MS the rate moves by one basis point up or down, or stays; it wanders
 * around the sample rate (about 8 bp typically, never more than 1.28%) and
 * does not drift away from it. It is not market data.
 */
import { Big } from 'big.js';

export const WALK_STEP_MS = 20_000;
const WINDOW = 256;

function seedOf(text: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) hash = Math.imul(hash ^ text.charCodeAt(index), 0x01000193);
  return hash >>> 0;
}

/** +1 or -1 for step `index` of the walk with this seed. */
function stepOf(seed: number, index: number): number {
  let value = (seed + Math.imul(index, 0x9e3779b1)) | 0;
  value = Math.imul(value ^ (value >>> 15), value | 1);
  value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
  return ((value ^ (value >>> 14)) >>> 0) % 2 === 0 ? 1 : -1;
}

/** How far the pair is from its sample rate at this moment, in HALF basis points (between -256 and 256). */
export function walkOffset(pairKey: string, nowMs: number): number {
  const seed = seedOf(pairKey);
  const last = Math.floor(nowMs / WALK_STEP_MS);
  let sum = 0;
  for (let index = last - WINDOW + 1; index <= last; index += 1) sum += stepOf(seed, index);
  return sum;
}

/** The sample rate for base/quote, moved. The inverse pair moves the opposite way, so the two always agree. */
export function walkedRate(base: string, quote: string, sampleRate: Big, nowMs: number): Big {
  const [first, second] = [base, quote].sort();
  const factor = new Big(20_000 + walkOffset(`${first}${second}`, nowMs)).div(20_000);
  return base === first ? sampleRate.times(factor) : sampleRate.div(factor);
}
