/**
 * GLOBAL CONNECT'S MARGIN ON FX, and the client's rate that results.
 *
 * A client only ever sees THEIR rate. The provider's rate, the mid-market
 * rate and the margin itself never leave the server: nothing in this file is
 * ever serialised to a client (a test scans every client response).
 *
 * THE MARGIN ALWAYS WORKS AGAINST THE CLIENT, in both directions. A rate is
 * "how many units of the quote currency one unit of the base currency is
 * worth". With a margin of m (in basis points, 1 bp = 0.01%):
 *
 *   the client SELLS the base currency:  client rate = provider rate x (1 - m)   (they get fewer quote units)
 *   the client BUYS  the base currency:  client rate = provider rate x (1 + m)   (they pay more quote units)
 *
 * ROUNDING NEVER FAVOURS THE CLIENT BY ACCIDENT, and is the same for the
 * indicative rate, the held quote and the booked conversion because all three
 * come from the functions below:
 *
 *   - a client rate is kept to RATE_DECIMALS places, rounded DOWN when the
 *     client sells the base and UP when they buy it;
 *   - an amount the client RECEIVES is rounded DOWN to the currency's minor
 *     unit, an amount the client PAYS is rounded UP;
 *   - and whatever the arithmetic says, the client never gets better terms
 *     than the provider's own quote (the result is clamped to it).
 *
 * All arithmetic is decimal (big.js). No floats.
 */
import Big from 'big.js';

import { currencyDecimals } from '@/lib/money';

export const RATE_DECIMALS = 6;
/** A margin above this needs an explicit "yes, this high" in the request. 300 bp = 3%. */
export const MARGIN_USUAL_MAX_BPS = 300;
/** Never accepted, whatever the request says. 2000 bp = 20%. */
export const MARGIN_HARD_MAX_BPS = 2000;

/** Which way the client trades the pair's BASE currency. */
export type Direction = 'sell' | 'buy';

export interface MarginOverride {
  /** Market-convention pair, base first: "GBPUSD". */
  pair: string;
  direction: Direction | 'both';
  bps: number;
}
export interface MarginTier {
  /** In units of the pair's base currency: this tier applies from this amount up. */
  fromAmount: string;
  bps: number;
}
export interface MarginConfig {
  /** Basis points. Applies to every spot conversion that no override or tier covers. */
  defaultBps: number;
  /** Forward contracts, if they are priced differently. Null: forwards are priced as spot. */
  forwardBps: number | null;
  overrides: MarginOverride[];
  /** Larger amounts, smaller margin. Ascending by amount; each no higher than the one before. */
  tiers: MarginTier[];
}

export class MarginError extends Error {}

/**
 * One pair has two spellings: selling the base of GBPUSD is buying the base of USDGBP. An override written
 * either way covers both, so a rate asked for "the other way round" can never slip past it.
 */
const flip = (direction: Direction): Direction => (direction === 'sell' ? 'buy' : 'sell');
const canonical = (pair: string, direction: Direction): string => (pair.slice(0, 3) < pair.slice(3) ? `${pair}:${direction}` : `${pair.slice(3)}${pair.slice(0, 3)}:${flip(direction)}`);

const isBps = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value);

/**
 * Checks a margin configuration. Negative margins are never accepted (the
 * client would be paid to trade). One above MARGIN_USUAL_MAX_BPS is accepted
 * only with `allowHigh`, and never above MARGIN_HARD_MAX_BPS.
 */
export function checkMarginConfig(config: MarginConfig, allowHigh: boolean): MarginConfig {
  const bps = (value: unknown, what: string): number => {
    if (!isBps(value)) throw new MarginError(`${what} must be a whole number of basis points.`);
    if (value < 0) throw new MarginError(`${what} cannot be negative: a negative margin would pay the client to trade.`);
    if (value > MARGIN_HARD_MAX_BPS) throw new MarginError(`${what} cannot be more than ${MARGIN_HARD_MAX_BPS} basis points (${MARGIN_HARD_MAX_BPS / 100}%).`);
    if (value > MARGIN_USUAL_MAX_BPS && !allowHigh) throw new MarginError(`${what} is ${value} basis points (${value / 100}%), which is more than ${MARGIN_USUAL_MAX_BPS}. If that is really meant, tick "allow a margin this high".`);
    return value;
  };
  const defaultBps = bps(config.defaultBps, 'The default margin');
  const forwardBps = config.forwardBps === null ? null : bps(config.forwardBps, 'The margin for forward contracts');
  const seen = new Set<string>();
  const overrides = config.overrides.map((item) => {
    if (!/^[A-Z]{6}$/.test(item.pair) || item.pair.slice(0, 3) === item.pair.slice(3)) throw new MarginError(`“${String(item.pair).slice(0, 12)}” is not a currency pair. Write it base first, like GBPUSD.`);
    if (item.direction !== 'sell' && item.direction !== 'buy' && item.direction !== 'both') throw new MarginError(`The direction for ${item.pair} must be sell, buy or both.`);
    for (const direction of item.direction === 'both' ? (['sell', 'buy'] as const) : [item.direction]) {
      if (seen.has(canonical(item.pair, direction))) throw new MarginError(`${item.pair} (${direction}) is listed twice. (Selling the base of GBPUSD is the same trade as buying the base of USDGBP.)`);
      seen.add(canonical(item.pair, direction));
    }
    return { pair: item.pair, direction: item.direction, bps: bps(item.bps, `The margin for ${item.pair}`) };
  });
  if (overrides.length > 50) throw new MarginError('At most 50 pair overrides.');
  let previous: { amount: Big; bps: number } = { amount: new Big(0), bps: defaultBps };
  const tiers = config.tiers.map((item) => {
    if (!/^[1-9]\d{0,14}(\.\d+)?$/.test(item.fromAmount)) throw new MarginError('A tier starts from an amount greater than zero, written as a plain number.');
    const amount = new Big(item.fromAmount);
    const value = bps(item.bps, `The margin from ${item.fromAmount}`);
    if (!amount.gt(previous.amount)) throw new MarginError('Tiers must be in ascending order of amount, each amount once.');
    if (value > previous.bps) throw new MarginError(`The tier from ${item.fromAmount} has a HIGHER margin (${value}) than the one before it (${previous.bps}). Larger amounts get a smaller margin, or the same.`);
    previous = { amount, bps: value };
    return { fromAmount: amount.toString(), bps: value };
  });
  if (tiers.length > 10) throw new MarginError('At most 10 tiers.');
  return { defaultBps, forwardBps, overrides, tiers };
}

/**
 * The margin, in basis points, for one trade. In order: forwards use the
 * forward margin if one is set; otherwise an override for this pair and
 * direction (in either spelling of the pair); otherwise the tier for the
 * amount; otherwise the default.
 * `baseAmount` is the trade's size in the pair's base currency; without one
 * (an indicative rate, which is for no particular amount) no tier applies.
 */
export function marginBps(config: MarginConfig, trade: { pair: string; direction: Direction; kind: 'spot' | 'forward'; baseAmount?: string | null }): number {
  if (trade.kind === 'forward' && config.forwardBps !== null) return config.forwardBps;
  const wanted = canonical(trade.pair, trade.direction);
  const override = config.overrides.find((item) => (item.direction === 'both' ? (['sell', 'buy'] as const) : [item.direction]).some((direction) => canonical(item.pair, direction) === wanted));
  if (override) return override.bps;
  if (trade.baseAmount) {
    const amount = new Big(trade.baseAmount);
    const tier = [...config.tiers].reverse().find((item) => amount.gte(item.fromAmount));
    if (tier) return tier.bps;
  }
  return config.defaultBps;
}

/** The client's rate from the provider's. Selling the base: rounded DOWN. Buying it: rounded UP. */
export function clientRate(providerRate: string, direction: Direction, bps: number): string {
  const rate = new Big(providerRate);
  if (!rate.gt(0)) throw new MarginError('The provider rate is not a positive number.');
  const factor = new Big(10_000)[direction === 'sell' ? 'minus' : 'plus'](bps).div(10_000);
  const result = rate.times(factor).round(RATE_DECIMALS, direction === 'sell' ? Big.roundDown : Big.roundUp);
  if (!result.gt(0)) throw new MarginError('The client rate would not be positive.');
  return result.toFixed(RATE_DECIMALS);
}

/** The parts of a provider's quote the margin is applied to. */
export interface ProviderTerms {
  sellCurrency: string;
  buyCurrency: string;
  sellAmount: string;
  buyAmount: string;
  fixedSide: 'sell' | 'buy';
  rateBase: string;
  rateQuote: string;
  rate: string;
}
export interface ClientTerms {
  /** Which way the client trades the pair's base currency. */
  direction: Direction;
  rate: string;
  sellAmount: string;
  buyAmount: string;
  /** What Global Connect keeps: the difference between the provider's terms and the client's, in the currency it arises in. */
  revenue: { amount: string; currency: string };
}

/** Which way a trade goes, in terms of the pair's base currency. */
export function directionOf(terms: Pick<ProviderTerms, 'sellCurrency' | 'buyCurrency' | 'rateBase' | 'rateQuote'>): Direction {
  if (terms.sellCurrency === terms.rateBase && terms.buyCurrency === terms.rateQuote) return 'sell';
  if (terms.buyCurrency === terms.rateBase && terms.sellCurrency === terms.rateQuote) return 'buy';
  throw new MarginError('The quote is not in the pair it says it is in.');
}

/** The size of a trade in the pair's base currency (what tiers are measured in). */
export function baseAmountOf(terms: ProviderTerms): string {
  return directionOf(terms) === 'sell' ? terms.sellAmount : terms.buyAmount;
}

/**
 * The client's side of a provider quote: the fixed side stays exactly what
 * the client asked for; the other side is worked out at the client rate and
 * rounded against the client; and it is never better than the provider's own
 * figure. With a margin of zero the provider's terms are the client's terms.
 */
export function clientTermsOf(provider: ProviderTerms, bps: number): ClientTerms {
  const direction = directionOf(provider);
  const sellDp = currencyDecimals(provider.sellCurrency);
  const buyDp = currencyDecimals(provider.buyCurrency);
  if (bps === 0) return { direction, rate: new Big(provider.rate).toFixed(RATE_DECIMALS), sellAmount: provider.sellAmount, buyAmount: provider.buyAmount, revenue: { amount: new Big(0).toFixed(provider.fixedSide === 'sell' ? buyDp : sellDp), currency: provider.fixedSide === 'sell' ? provider.buyCurrency : provider.sellCurrency } };
  const rate = new Big(clientRate(provider.rate, direction, bps));
  if (provider.fixedSide === 'sell') {
    // The client pays exactly what they said; what they RECEIVE is rounded down, and never more than the provider would give.
    const sell = new Big(provider.sellAmount);
    const worked = (direction === 'sell' ? sell.times(rate) : sell.div(rate)).round(buyDp, Big.roundDown);
    const limit = new Big(provider.buyAmount);
    const buy = worked.gt(limit) ? limit : worked;
    if (!buy.gt(0)) throw new MarginError('The amount is too small to convert.');
    return { direction, rate: rate.toFixed(RATE_DECIMALS), sellAmount: provider.sellAmount, buyAmount: buy.toFixed(buyDp), revenue: { amount: limit.minus(buy).toFixed(buyDp), currency: provider.buyCurrency } };
  }
  // The client receives exactly what they said; what they PAY is rounded up, and never less than the provider would take.
  const buy = new Big(provider.buyAmount);
  const worked = (direction === 'buy' ? buy.times(rate) : buy.div(rate)).round(sellDp, Big.roundUp);
  const limit = new Big(provider.sellAmount);
  const sell = worked.lt(limit) ? limit : worked;
  return { direction, rate: rate.toFixed(RATE_DECIMALS), sellAmount: sell.toFixed(sellDp), buyAmount: provider.buyAmount, revenue: { amount: sell.minus(limit).toFixed(sellDp), currency: provider.sellCurrency } };
}

/** For staff, on the confirmation of a margin change: what it does to one concrete trade. Never shown to a client. */
export function workedExample(before: MarginConfig, after: MarginConfig, providerRate: string, pair = 'GBPUSD', amount = '10000'): string {
  const [base, quote] = [pair.slice(0, 3), pair.slice(3)];
  const terms: ProviderTerms = { sellCurrency: base, buyCurrency: quote, sellAmount: amount, buyAmount: new Big(amount).times(providerRate).round(currencyDecimals(quote), Big.roundDown).toFixed(currencyDecimals(quote)), fixedSide: 'sell', rateBase: base, rateQuote: quote, rate: providerRate };
  const side = (config: MarginConfig) => clientTermsOf(terms, marginBps(config, { pair, direction: 'sell', kind: 'spot', baseAmount: amount }));
  const [old, next] = [side(before), side(after)];
  const figure = new Intl.NumberFormat('en-GB').format(Number(amount));
  return `selling ${base} ${figure} for ${quote}: the client rate changes from ${old.rate} to ${next.rate}, so they receive ${quote} ${next.buyAmount} instead of ${quote} ${old.buyAmount} (Global Connect keeps ${quote} ${next.revenue.amount} instead of ${quote} ${old.revenue.amount})`;
}
