/**
 * GLOBAL CONNECT'S MARGIN ON FX, and the client's rate that results.
 *
 * A client only ever sees THEIR rate. No response names the provider's rate,
 * a mid-market rate or the margin (a test scans every client response for
 * such fields and wording). A client who is shown both a sell and a buy rate
 * can still ESTIMATE a midpoint and a spread, as from any two-way price; the
 * indicative figures are rounded so that the estimate is not exact
 * (`indicativePair`).
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
 *   - a client rate is kept to RATE_SIGNIFICANT significant figures (so that
 *     rounding costs the same tiny fraction whether the rate is 195 or 0.005),
 *     rounded DOWN when the client sells the base and UP when they buy it;
 *   - an amount the client RECEIVES is rounded DOWN to the currency's minor
 *     unit, an amount the client PAYS is rounded UP;
 *   - and whatever the arithmetic says, the client never gets better terms
 *     than the provider's own quote (the result is clamped to it).
 *
 * All arithmetic is decimal (big.js). No floats.
 */
import Big from 'big.js';

import { currencyDecimals } from '@/lib/money';

/** A client rate has this many significant figures: 1.293500, 195.0325, 0.005128205. Rounding moves it by less than one part in a million. */
export const RATE_SIGNIFICANT = 7;
/** An INDICATIVE rate is shown to this many significant figures (1.2935, 195.03, 0.0051282): what the app displays. */
export const INDICATIVE_SIGNIFICANT = 5;
/** How many decimal places give `significant` significant figures of this rate. */
export function rateDecimals(rate: Big.BigSource, significant = RATE_SIGNIFICANT): number {
  const value = new Big(rate);
  if (!value.gt(0)) throw new MarginError('The rate is not a positive number.');
  return Math.min(14, Math.max(0, significant - 1 - value.e));
}
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
  /** In units of the configuration's `tierCurrency`: this tier applies from this amount up. */
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
  /**
   * THE ONE CURRENCY tier amounts are in, for every pair and whichever way a provider quotes it (default GBP). A
   * trade's size is converted to it at the provider's rate before a tier is chosen: 60,000 yen is not 60,000 pounds.
   */
  tierCurrency: string;
}
export const DEFAULT_TIER_CURRENCY = 'GBP';

export class MarginError extends Error {}

/**
 * One pair has two spellings: selling the base of GBPUSD is buying the base of USDGBP. An override written
 * either way covers both, so a rate asked for "the other way round" can never slip past it.
 */
const flip = (direction: Direction): Direction => (direction === 'sell' ? 'buy' : 'sell');
/** ONE orientation per pair, whatever a provider's adapter calls its base: the market's usual order, then alphabetical. */
const CONVENTION = ['EUR', 'GBP', 'AUD', 'NZD', 'USD', 'CAD', 'CHF'];
const rank = (currency: string): string => `${String(CONVENTION.indexOf(currency) === -1 ? CONVENTION.length : CONVENTION.indexOf(currency)).padStart(2, '0')}${currency}`;
export const isCanonical = (base: string, quote: string): boolean => rank(base) < rank(quote);
/** The pair and direction in that one orientation: selling USD in "USDGBP" is buying GBP in GBPUSD. */
export function canonicalTrade(pair: string, direction: Direction): { pair: string; direction: Direction } {
  const [base, quote] = [pair.slice(0, 3), pair.slice(3)];
  return isCanonical(base, quote) ? { pair, direction } : { pair: `${quote}${base}`, direction: flip(direction) };
}
const canonical = (pair: string, direction: Direction): string => {
  const trade = canonicalTrade(pair, direction);
  return `${trade.pair}:${trade.direction}`;
};

const isBps = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value);

/**
 * PEOPLE READ AND TYPE PERCENTAGES; THE SERVER KEEPS WHOLE BASIS POINTS. These two functions are the only place
 * the two meet: nothing else converts, and all arithmetic stays in basis points.
 *
 * "0.50%": a margin of so many basis points, as a percentage to two places (exact: decimal arithmetic).
 */
export const marginPercent = (bps: number | string): string => `${new Big(bps).div(100).toFixed(2)}%`;

/**
 * What a person typed as a percentage, in basis points. Accepted: digits, optionally one decimal separator (a dot
 * or a comma) and up to two decimal places (steps of 0.01%, which is one basis point), optionally a % sign.
 * "0.5", "0,75", "1.25%", "1 %". Everything else is refused, with the unit in the message: a third decimal place
 * ("0.005"), a thousands separator ("1,000"), a sign, "bp", an empty value. NOTE "50" MEANS 50%: it is returned
 * as 5000 and the ceiling refuses it in words that show the unit.
 */
export function parseMarginPercent(typed: string, what: string): number {
  const value = typed.trim();
  if (/^-/.test(value)) throw new MarginError(`${what} cannot be negative: a negative margin would pay the client to trade.`);
  const match = /^(\d{1,4})(?:[.,](\d{1,2}))?\s*%?$/.exec(value);
  if (!match) {
    if (/^\d{1,4}[.,]\d{3,}\s*%?$/.test(value)) throw new MarginError(`${what} is a percentage with at most two decimal places (steps of 0.01%): “${value.slice(0, 12)}” has more. For half a percent write 0.50.`);
    throw new MarginError(`${what} is written as a percentage, like 0.50 or 0.50% (that is half of one percent). “${value.slice(0, 12)}” is not one.`);
  }
  return Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0'));
}

/**
 * Checks a margin configuration. Negative margins are never accepted (the
 * client would be paid to trade). One above MARGIN_USUAL_MAX_BPS is accepted
 * only with `allowHigh`, and never above MARGIN_HARD_MAX_BPS.
 */
export function checkMarginConfig(config: MarginConfig, allowHigh: boolean): MarginConfig {
  const bps = (value: unknown, what: string): number => {
    if (!isBps(value)) throw new MarginError(`${what} must be a percentage in steps of 0.01%.`);
    if (value < 0) throw new MarginError(`${what} cannot be negative: a negative margin would pay the client to trade.`);
    if (value > MARGIN_HARD_MAX_BPS) throw new MarginError(`${what}: ${marginPercent(value)} is above the maximum of ${marginPercent(MARGIN_HARD_MAX_BPS)}. (Margins are percentages: for half a percent write 0.50.)`);
    if (value > MARGIN_USUAL_MAX_BPS && !allowHigh) throw new MarginError(`${what}: ${marginPercent(value)} is above the usual limit of ${marginPercent(MARGIN_USUAL_MAX_BPS)}. If that is really meant, tick "allow a margin this high". (Margins are percentages: for half a percent write 0.50.)`);
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
    if (value > previous.bps) throw new MarginError(`The tier from ${item.fromAmount} has a HIGHER margin (${marginPercent(value)}) than the one before it (${marginPercent(previous.bps)}). Larger amounts get a smaller margin, or the same.`);
    previous = { amount, bps: value };
    return { fromAmount: amount.toString(), bps: value };
  });
  if (tiers.length > 10) throw new MarginError('At most 10 tiers.');
  const tierCurrency = config.tierCurrency ?? DEFAULT_TIER_CURRENCY;
  if (typeof tierCurrency !== 'string' || !/^[A-Z]{3}$/.test(tierCurrency)) throw new MarginError('The currency tiers are measured in must be a three-letter currency code, like GBP.');
  return { defaultBps, forwardBps, overrides, tiers, tierCurrency };
}

/**
 * The margin, in basis points, for one trade. In order: forwards use the
 * forward margin if one is set; otherwise an override for this pair and
 * direction (in either spelling of the pair); otherwise the tier for the
 * amount; otherwise the default.
 * `tierAmount` is the trade's size IN THE CONFIGURATION'S TIER CURRENCY (see
 * `tierAmountOf`); without one (an indicative rate, which is for no particular
 * amount, or a size that could not be converted) no tier applies, which is
 * never to the client's advantage.
 */
export function marginBps(config: MarginConfig, trade: { pair: string; direction: Direction; kind: 'spot' | 'forward'; tierAmount?: string | null }): number {
  if (trade.kind === 'forward' && config.forwardBps !== null) return config.forwardBps;
  const wanted = canonical(trade.pair, trade.direction);
  const override = config.overrides.find((item) => (item.direction === 'both' ? (['sell', 'buy'] as const) : [item.direction]).some((direction) => canonical(item.pair, direction) === wanted));
  if (override) return override.bps;
  if (trade.tierAmount) {
    const amount = new Big(trade.tierAmount);
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
  const exact = rate.times(factor);
  if (!exact.gt(0)) throw new MarginError('The client rate would not be positive.');
  const places = rateDecimals(exact);
  const result = exact.round(places, direction === 'sell' ? Big.roundDown : Big.roundUp);
  if (!result.gt(0)) throw new MarginError('The client rate would not be positive.');
  return result.toFixed(places);
}

/**
 * AN INDICATIVE RATE for one direction: the client's rate, to the precision the app displays
 * (INDICATIVE_SIGNIFICANT figures), rounded AGAINST them. A held quote, for a particular amount and direction, has
 * the client's rate in full; an indicative rate is never better than that.
 */
export function indicativeRate(providerRate: string, direction: Direction, bps: number): string {
  const rate = new Big(providerRate);
  if (!rate.gt(0)) throw new MarginError('The provider rate is not a positive number.');
  const exact = rate.times(new Big(10_000)[direction === 'sell' ? 'minus' : 'plus'](bps).div(10_000));
  const places = rateDecimals(exact, INDICATIVE_SIGNIFICANT);
  const shown = exact.round(places, direction === 'sell' ? Big.roundDown : Big.roundUp);
  if (!shown.gt(0)) throw new MarginError('The indicative rate would not be positive.');
  return shown.toFixed(places);
}

/**
 * THE TWO INDICATIVE RATES a client is shown for a pair. Each is rounded against the client by itself, as above.
 * A two-way price always lets anyone estimate a midpoint and a spread; what this adds is that the estimate is never
 * EXACT: if the two roundings together moved the figures by less than a quarter of a display step (for instance when
 * the client's rates happen to sit exactly on displayable figures), the SELL figure is shown one step lower. The
 * two figures are therefore always at least a quarter of a step further apart than the provider's rate and the
 * margin alone would put them: the spread read off them is never the margin to six places.
 */
export function indicativePair(providerRate: string, sellBps: number, buyBps: number): { sell: string; buy: string } {
  const rate = new Big(providerRate);
  const exactSell = rate.times(new Big(10_000).minus(sellBps).div(10_000));
  const exactBuy = rate.times(new Big(10_000).plus(buyBps).div(10_000));
  const sell = new Big(indicativeRate(providerRate, 'sell', sellBps));
  const buy = new Big(indicativeRate(providerRate, 'buy', buyBps));
  const places = rateDecimals(exactSell, INDICATIVE_SIGNIFICANT);
  const step = new Big(10).pow(-places);
  const moved = exactSell.minus(sell).plus(buy.minus(exactBuy));
  const shown = moved.lt(step.div(4)) ? sell.minus(step) : sell;
  if (!shown.gt(0)) throw new MarginError('The indicative rate would not be positive.');
  return { sell: shown.toFixed(places), buy: buy.toFixed(rateDecimals(exactBuy, INDICATIVE_SIGNIFICANT)) };
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

/**
 * The size of a trade in the currency tiers are measured in, or null if it cannot be worked out here. When that
 * currency is one of the two being traded the amount is simply that side's; otherwise `toTierCurrency` is the
 * provider's rate for 1 unit of the SELL currency in the tier currency.
 */
export function tierAmountOf(terms: Pick<ProviderTerms, 'sellCurrency' | 'buyCurrency' | 'sellAmount' | 'buyAmount'>, tierCurrency: string, toTierCurrency: string | null = null): string | null {
  if (terms.sellCurrency === tierCurrency) return terms.sellAmount;
  if (terms.buyCurrency === tierCurrency) return terms.buyAmount;
  if (toTierCurrency === null || !new Big(toTierCurrency).gt(0)) return null;
  return new Big(terms.sellAmount).times(toTierCurrency).round(2, Big.roundDown).toFixed(2);
}

/** The margin that was REALLY applied to a trade, after all rounding, in basis points to two places: what is kept, over what the provider gave or took on that side. */
export function effectiveBps(provider: Pick<ProviderTerms, 'sellAmount' | 'buyAmount' | 'fixedSide'>, client: Pick<ClientTerms, 'sellAmount' | 'buyAmount'>): string {
  const [theirs, ours] = provider.fixedSide === 'sell' ? [new Big(provider.buyAmount), new Big(client.buyAmount)] : [new Big(provider.sellAmount), new Big(client.sellAmount)];
  if (!theirs.gt(0)) return '0.00';
  return theirs.minus(ours).abs().div(theirs).times(10_000).round(2, Big.roundHalfUp).toFixed(2);
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
  if (bps === 0) return { direction, rate: new Big(provider.rate).toFixed(rateDecimals(provider.rate)), sellAmount: provider.sellAmount, buyAmount: provider.buyAmount, revenue: { amount: new Big(0).toFixed(provider.fixedSide === 'sell' ? buyDp : sellDp), currency: provider.fixedSide === 'sell' ? provider.buyCurrency : provider.sellCurrency } };
  const rate = new Big(clientRate(provider.rate, direction, bps));
  if (provider.fixedSide === 'sell') {
    // The client pays exactly what they said; what they RECEIVE is rounded down, and never more than the provider would give.
    const sell = new Big(provider.sellAmount);
    const worked = (direction === 'sell' ? sell.times(rate) : sell.div(rate)).round(buyDp, Big.roundDown);
    const limit = new Big(provider.buyAmount);
    const buy = worked.gt(limit) ? limit : worked;
    if (!buy.gt(0)) throw new MarginError('The amount is too small to convert.');
    return { direction, rate: rate.toFixed(rateDecimals(rate)), sellAmount: provider.sellAmount, buyAmount: buy.toFixed(buyDp), revenue: { amount: limit.minus(buy).toFixed(buyDp), currency: provider.buyCurrency } };
  }
  // The client receives exactly what they said; what they PAY is rounded up, and never less than the provider would take.
  const buy = new Big(provider.buyAmount);
  const worked = (direction === 'buy' ? buy.times(rate) : buy.div(rate)).round(sellDp, Big.roundUp);
  const limit = new Big(provider.sellAmount);
  const sell = worked.lt(limit) ? limit : worked;
  return { direction, rate: rate.toFixed(rateDecimals(rate)), sellAmount: sell.toFixed(sellDp), buyAmount: provider.buyAmount, revenue: { amount: sell.minus(limit).toFixed(sellDp), currency: provider.sellCurrency } };
}

/** One line of a margin configuration in words, for staff and the audit log. */
export function describeMargin(config: MarginConfig): string {
  return [
    `default ${marginPercent(config.defaultBps)}`,
    config.forwardBps === null ? 'forwards as spot' : `forwards ${marginPercent(config.forwardBps)}`,
    ...config.overrides.map((item) => `${item.pair} ${item.direction} ${marginPercent(item.bps)}`),
    ...config.tiers.map((item) => `from ${config.tierCurrency ?? DEFAULT_TIER_CURRENCY} ${item.fromAmount}: ${marginPercent(item.bps)}`),
  ].join('; ');
}

/**
 * For staff, on the confirmation of a margin change: what it does to one concrete trade of `amount` of the
 * pair's base currency. Never shown to a client.
 */
export function workedExample(before: MarginConfig, after: MarginConfig, providerRate: string, pair = 'GBPUSD', amount = '10000', direction: Direction = 'sell', kind: 'spot' | 'forward' = 'spot'): string {
  const [base, quote] = [pair.slice(0, 3), pair.slice(3)];
  const other = new Big(amount).times(providerRate).round(currencyDecimals(quote), direction === 'sell' ? Big.roundDown : Big.roundUp).toFixed(currencyDecimals(quote));
  const terms: ProviderTerms = direction === 'sell' ? { sellCurrency: base, buyCurrency: quote, sellAmount: amount, buyAmount: other, fixedSide: 'sell', rateBase: base, rateQuote: quote, rate: providerRate } : { sellCurrency: quote, buyCurrency: base, sellAmount: other, buyAmount: amount, fixedSide: 'buy', rateBase: base, rateQuote: quote, rate: providerRate };
  // The trade's size in each configuration's own tier currency (the example pair has it on one side, or no tier applies).
  const side = (config: MarginConfig) => clientTermsOf(terms, marginBps(config, { pair, direction, kind, tierAmount: tierAmountOf(terms, config.tierCurrency ?? DEFAULT_TIER_CURRENCY) }));
  const [old, next] = [side(before), side(after)];
  const figure = new Intl.NumberFormat('en-GB').format(Number(amount));
  const what = kind === 'forward' ? 'a forward ' : '';
  return direction === 'sell'
    ? `${what}selling ${base} ${figure} for ${quote}: the client rate changes from ${old.rate} to ${next.rate}, so they receive ${quote} ${next.buyAmount} instead of ${quote} ${old.buyAmount}`
    : `${what}buying ${base} ${figure} with ${quote}: the client rate changes from ${old.rate} to ${next.rate}, so they pay ${quote} ${next.sellAmount} instead of ${quote} ${old.sellAmount}`;
}
