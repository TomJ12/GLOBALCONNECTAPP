/**
 * THE CLIENT'S RATE, from the provider's rate and the company's margin.
 *
 * Everything a client is told about a rate, a quote or a conversion passes
 * through here. What comes out has the client's rate and amounts and no field
 * that names the provider's rate, a mid rate, the margin or what Global
 * Connect keeps: those stay in `HeldQuoteRecord` and `RevenueRecord` (the
 * database), which no client route returns.
 *
 * WHAT A CLIENT CAN STILL WORK OUT: they are shown a rate for selling and a
 * rate for buying, and any two-way price lets anyone estimate a midpoint and
 * a spread. That is not hidden and cannot be. What is done: the indicative
 * figures are given only to the precision the app shows, each rounded
 * against the client by itself, so they are not an exact image of the
 * provider's rate and the margin (rates/margin.ts `indicativeRate`).
 *
 * WHERE THE MARGIN IS APPLIED is a setting per provider (config.marginAppliedBy):
 *   server    this file works the client's rate out (rates/margin.ts);
 *   provider  the provider already returns the client's rate, with the
 *             partner's markup configured on its side. The server adds
 *             NOTHING on top, and does not know the revenue.
 * A WRONG SETTING FAILS SAFE. Where a provider's quote says whether it
 * carries a markup, that is checked against the setting on every quote:
 * `provider` with no markup there (the client would be given the wholesale
 * rate) and `server` with a markup there (the client would be charged twice)
 * both REFUSE to quote. A provider whose answers do not say cannot be set to
 * `provider` at all (config.ts).
 */
import Big from 'big.js';

import type { Conversion, ForwardContract, Quote, RateHistory, RatePair } from '@/api/types';

import type { Config } from '../config';
import type { ProviderAdapter } from '../providers/adapter';
import type { CompanyRecord, HeldQuoteRecord, MarginRecord, RevenueRecord, Stores } from '../store/types';
import { canonicalTrade, clientTermsOf, DEFAULT_TIER_CURRENCY, directionOf, effectiveBps, indicativePair, indicativeRate, marginBps, MarginError, tierAmountOf, type MarginConfig } from './margin';

export type HeldQuote = HeldQuoteRecord;

export const marginConfigOf = (record: Partial<MarginConfig> & Pick<MarginConfig, 'defaultBps' | 'forwardBps' | 'overrides' | 'tiers'>): MarginConfig => ({ defaultBps: record.defaultBps, forwardBps: record.forwardBps, overrides: record.overrides, tiers: record.tiers, tierCurrency: record.tierCurrency ?? DEFAULT_TIER_CURRENCY });

/** How long a successful check that a provider's quotes carry its markup is relied on. */
const MARKUP_CHECK_MS = 10 * 60_000;
type RateSource = Pick<ProviderAdapter, 'getRate' | 'createQuote'>;

export class ClientRates {
  private readonly cache = new Map<string, { until: number; rate: Promise<RatePair> }>();
  private readonly markupSeen = new Map<string, number>();

  constructor(
    private readonly stores: Pick<Stores, 'margins' | 'revenue' | 'quotes'>,
    private readonly config: Pick<Config, 'marginAppliedBy' | 'defaultMarginBps' | 'rateCacheMs'>,
    private readonly now: () => number,
    private readonly maxHeldQuotes = 10_000,
  ) {}

  appliedBy(company: Pick<CompanyRecord, 'providerKey'>): 'server' | 'provider' {
    return this.config.marginAppliedBy[company.providerKey];
  }

  /** The company's own margin configuration, or the server default when it has none; and its version (when it was last changed). */
  async marginOf(companyId: string): Promise<{ config: MarginConfig; record: MarginRecord | null; version: number }> {
    const record = await this.stores.margins.get(companyId);
    return { record, version: record?.updatedAt ?? 0, config: record ? marginConfigOf(record) : { defaultBps: this.config.defaultMarginBps, forwardBps: null, overrides: [], tiers: [], tierCurrency: DEFAULT_TIER_CURRENCY } };
  }

  /**
   * The PROVIDER's rate for a pair. Never returned to a client. Asked for at most once per provider and pair
   * within the cache time, however many companies and alerts want it.
   */
  providerRate(company: Pick<CompanyRecord, 'providerKey'>, provider: Pick<ProviderAdapter, 'getRate'>, base: string, quote: string): Promise<RatePair> {
    const key = `${company.providerKey}:${base}${quote}`;
    const held = this.cache.get(key);
    if (held && held.until > this.now()) return held.rate;
    for (const [other, entry] of this.cache) if (entry.until <= this.now()) this.cache.delete(other);
    const rate = provider.getRate(base, quote);
    this.cache.set(key, { until: this.now() + this.config.rateCacheMs, rate });
    rate.catch(() => this.cache.get(key)?.rate === rate && this.cache.delete(key));
    return rate;
  }

  /** THE SETTING AGAINST THE EVIDENCE. Throws (and so nothing is quoted) when a provider's quote contradicts where the margin is said to be applied. */
  private assertMarkup(company: Pick<CompanyRecord, 'providerKey' | 'id'>, quote: Pick<Quote, 'markup'>): void {
    const mode = this.appliedBy(company);
    if (mode === 'provider' && quote.markup !== 'present') {
      throw new MarginError(`MARGIN_APPLIED_BY for ${company.providerKey} is "provider", but the provider's quote carries no partner markup (${quote.markup ?? 'it does not say'}): the client would be given the wholesale rate. Refusing to quote.`);
    }
    if (mode === 'server' && quote.markup === 'present') {
      throw new MarginError(`MARGIN_APPLIED_BY for ${company.providerKey} is "server", but the provider's quote already carries a partner markup: the client would be charged twice. Refusing to quote.`);
    }
    if (mode === 'provider') this.markupSeen.set(`${company.providerKey}:${company.id}`, this.now());
  }

  /**
   * With `provider`, an indicative rate is passed through from the provider; before that is done for a company,
   * one real quote is asked for and checked (and again every ten minutes), so that a wrong setting is caught
   * before a wholesale rate is ever shown.
   */
  private async ensureMarkup(company: CompanyRecord, provider: RateSource, base: string, quote: string): Promise<void> {
    if (this.appliedBy(company) !== 'provider') return;
    const seen = this.markupSeen.get(`${company.providerKey}:${company.id}`);
    if (seen !== undefined && seen > this.now() - MARKUP_CHECK_MS) return;
    this.assertMarkup(company, await provider.createQuote({ kind: 'spot', sellCurrency: base, buyCurrency: quote, fixedSide: 'sell', amount: '1000.00' }));
  }

  /**
   * THE ONE WAY a rate that is not a held quote leaves this server: the rate page, the trend line, and what a
   * rate alert is compared with and quotes in its notification all come through `indicative` or `history`, and
   * both check FIRST that the margin is really where the setting says it is (`ensureMarkup`). `fromProvider`
   * below, which turns a provider's rate into the client's, is private for that reason.
   *
   * What the client is shown for a pair: their rate selling the base, their rate buying it. Indicative, at
   * display precision. (`given`: a provider rate or margin configuration the caller has already read.)
   */
  async indicative(company: CompanyRecord, provider: RateSource, base: string, quote: string, given: { raw?: RatePair; config?: MarginConfig } = {}): Promise<RatePair> {
    await this.ensureMarkup(company, provider, base, quote);
    const raw = given.raw ?? (await this.providerRate(company, provider, base, quote));
    return this.fromProvider(company, raw, given.config ?? (await this.marginOf(company.id)).config);
  }

  private fromProvider(company: Pick<CompanyRecord, 'providerKey'>, raw: RatePair, config: MarginConfig): RatePair {
    if (this.appliedBy(company) === 'provider') return { base: raw.base, quote: raw.quote, rate: raw.rate, buyRate: raw.buyRate ?? raw.rate, indicative: true, asOf: raw.asOf };
    const pair = `${raw.base}${raw.quote}`;
    const shown = indicativePair(raw.rate, marginBps(config, { pair, direction: 'sell', kind: 'spot' }), marginBps(config, { pair, direction: 'buy', kind: 'spot' }));
    return { base: raw.base, quote: raw.quote, rate: shown.sell, buyRate: shown.buy, indicative: true, asOf: raw.asOf };
  }

  /** The trend line is the client's indicative SELL rate over time: the same series the headline rate belongs to. */
  async history(company: CompanyRecord, provider: RateSource & Pick<ProviderAdapter, 'getRateHistory'>, base: string, quote: string): Promise<RateHistory> {
    await this.ensureMarkup(company, provider, base, quote);
    const raw = await provider.getRateHistory(base, quote);
    if (this.appliedBy(company) === 'provider') return { base: raw.base, quote: raw.quote, points: raw.points.map((point) => ({ at: point.at, rate: point.rate })) };
    const bps = marginBps((await this.marginOf(company.id)).config, { pair: `${raw.base}${raw.quote}`, direction: 'sell', kind: 'spot' });
    return { base: raw.base, quote: raw.quote, points: raw.points.map((point) => ({ at: point.at, rate: indicativeRate(point.rate, 'sell', bps) })) };
  }

  /**
   * The client's quote from the provider's, kept (in the database) for the person it was given to until it runs
   * out. The size of the trade is converted to the company's tier currency before a tier is chosen.
   */
  async quote(company: CompanyRecord, userId: string, source: Pick<ProviderAdapter, 'getRate'>, raw: Quote): Promise<HeldQuote> {
    this.assertMarkup(company, raw);
    const { markup: _markup, ...provider } = raw;
    const at = this.now();
    const base = { key: `${company.id}:${provider.id}`, companyId: company.id, userId, provider, createdAt: at, expiresAt: Date.parse(provider.expiresAt), usedBy: null };
    let held: HeldQuote;
    if (this.appliedBy(company) === 'provider') {
      held = { ...base, client: provider, appliedBy: 'provider', marginBps: null, revenue: null, marginVersion: 0 };
    } else {
      const { config, version } = await this.marginOf(company.id);
      let toTier: string | null = null;
      if (config.tiers.length > 0 && provider.sellCurrency !== config.tierCurrency && provider.buyCurrency !== config.tierCurrency) {
        // Neither side is the tier currency: the provider's rate for the sell currency in it. If there is none, no tier applies.
        toTier = await this.providerRate(company, source, provider.sellCurrency, config.tierCurrency).then((rate) => rate.rate, () => null);
      }
      const bps = marginBps(config, { pair: `${provider.rateBase}${provider.rateQuote}`, direction: directionOf(provider), kind: provider.kind, tierAmount: tierAmountOf(provider, config.tierCurrency, toTier) });
      const terms = clientTermsOf(provider, bps);
      held = { ...base, client: { ...provider, sellAmount: terms.sellAmount, buyAmount: terms.buyAmount, rate: terms.rate }, appliedBy: 'server', marginBps: bps, revenue: terms.revenue, marginVersion: version };
    }
    // What has run out goes first; then, if still full, the oldest.
    await this.stores.quotes.deleteWhere((row) => row.expiresAt < at - 60_000);
    const all = await this.stores.quotes.list();
    for (const old of all.sort((a, b) => a.createdAt - b.createdAt).slice(0, Math.max(0, all.length + 1 - this.maxHeldQuotes))) await this.stores.quotes.delete(old.key);
    await this.stores.quotes.put(held.key, held);
    return held;
  }

  /**
   * The quote a booking may use, CLAIMED for this booking in one transaction, or null. It must be this company's
   * and this person's, not run out, priced by the margin configuration that is still in force, and not used by any
   * other booking (the same booking asking again is fine).
   */
  async claimQuote(company: Pick<CompanyRecord, 'id'>, userId: string, quoteId: string, keyHash: string): Promise<HeldQuote | null> {
    const at = this.now();
    let claimed: HeldQuote | null = null;
    await this.stores.quotes.mutate(`${company.id}:${quoteId}`, (current) => {
      claimed = null;
      if (!current || current.companyId !== company.id || current.userId !== userId) return undefined;
      if (current.expiresAt <= at) return undefined;
      if (current.usedBy !== null && current.usedBy !== keyHash) return undefined;
      claimed = { ...current, usedBy: keyHash };
      return claimed;
    });
    // The margin is read AFTER the claim is committed, never before it: a change that was committed before this
    // booking claimed its quote is always seen here, and the quote is refused. (Read before the claim, a change
    // landing between the two went unnoticed.) A change committed after this point comes after the booking began.
    const taken = claimed as HeldQuote | null;
    if (taken && taken.appliedBy === 'server' && taken.marginVersion !== (await this.marginOf(company.id)).version) return null;
    return taken;
  }

  /**
   * Written BEFORE the provider is asked to book. A key that already has a record for ANOTHER quote is refused
   * (null): one key is one booking of one quote.
   */
  async beginBooking(held: HeldQuote, userId: string, keyHash: string): Promise<RevenueRecord | null> {
    const key = `${held.companyId}:${keyHash}`;
    const trade = canonicalTrade(`${held.provider.rateBase}${held.provider.rateQuote}`, directionOf(held.provider));
    const fresh: RevenueRecord = {
      key,
      companyId: held.companyId,
      userId,
      quoteId: held.client.id,
      conversionId: null,
      status: 'booking',
      kind: held.client.kind,
      appliedBy: held.appliedBy,
      pair: trade.pair,
      direction: trade.direction,
      quotedAs: `${held.provider.rateBase}${held.provider.rateQuote}`,
      sellCurrency: held.client.sellCurrency,
      buyCurrency: held.client.buyCurrency,
      providerRate: held.provider.rate,
      providerSellAmount: held.provider.sellAmount,
      providerBuyAmount: held.provider.buyAmount,
      clientRate: held.client.rate,
      clientSellAmount: held.client.sellAmount,
      clientBuyAmount: held.client.buyAmount,
      marginBps: held.marginBps,
      effectiveBps: held.appliedBy === 'server' ? effectiveBps(held.provider, held.client) : null,
      revenueAmount: held.revenue?.amount ?? null,
      revenueCurrency: held.revenue?.currency ?? null,
      mismatch: false,
      createdAt: this.now(),
      bookedAt: null,
    };
    const stored = (await this.stores.revenue.mutate(key, (current) => (current && current.status !== 'failed' ? undefined : fresh))) as RevenueRecord;
    return stored.quoteId === held.client.id ? stored : null;
  }

  /** The provider refused outright: nothing was booked under this key. */
  async failBooking(key: string): Promise<void> {
    await this.stores.revenue.mutate(key, (current) => (current && current.status === 'booking' ? { ...current, status: 'failed' } : undefined));
  }

  /**
   * The provider booked it. Records the conversion and what the provider says was booked. If that is not the
   * client's terms it was sent, the record is marked `mismatch` (audited here, in the same transaction).
   * `changed` is true when this call is the one that closed the record.
   */
  async completeBooking(key: string, conversion: Conversion): Promise<{ record: RevenueRecord | null; changed: boolean }> {
    let changed = false;
    const at = this.now();
    const record = await this.stores.revenue.mutate(
      key,
      (current) => {
        changed = false;
        if (!current || current.status === 'booked') return undefined;
        const mismatch = current.appliedBy === 'server' && (!new Big(conversion.sellAmount).eq(current.clientSellAmount) || !new Big(conversion.buyAmount).eq(current.clientBuyAmount));
        changed = true;
        return { ...current, status: 'booked', conversionId: conversion.id, mismatch, bookedAt: at, bookedRate: conversion.rate, bookedSellAmount: conversion.sellAmount, bookedBuyAmount: conversion.buyAmount };
      },
      (stored) =>
        changed && stored?.mismatch
          ? { at, actor: { type: 'system', id: null, label: 'conversions' }, target: { type: 'company', id: stored.companyId, label: stored.companyId }, action: 'system.conversion.mismatch', outcome: 'failure', source: 'server', detail: { conversion: conversion.id, quoted: `${stored.clientSellAmount} ${stored.sellCurrency} for ${stored.clientBuyAmount} ${stored.buyCurrency}`, booked: `${conversion.sellAmount} ${stored.sellCurrency} for ${conversion.buyAmount} ${stored.buyCurrency}` } }
          : null,
    );
    return { record, changed };
  }

  recordFor(companyId: string, keyHash: string): Promise<RevenueRecord | null> {
    return this.stores.revenue.get(`${companyId}:${keyHash}`);
  }

  /**
   * What the client is shown for a conversion this server priced.
   *  - Booked on their terms (the usual case): the server's own record of those terms.
   *  - Booked on OTHER terms (`mismatch`): what was really booked, because that is what moved on their account,
   *    flagged `differsFromQuote` so the app tells them to get in touch.
   */
  present<T extends Conversion | ForwardContract>(item: T, record: RevenueRecord | null): T {
    if (!record || record.appliedBy !== 'server') return item;
    if (record.mismatch) return { ...item, differsFromQuote: true };
    const quotedAs = record.quotedAs ?? record.pair;
    return { ...item, sellAmount: record.clientSellAmount, buyAmount: record.clientBuyAmount, rate: record.clientRate, rateBase: quotedAs.slice(0, 3), rateQuote: quotedAs.slice(3) };
  }

  async presentById<T extends Conversion | ForwardContract>(companyId: string, item: T): Promise<T> {
    const [record] = await this.stores.revenue.list({ conversionId: item.id }, (row) => row.companyId === companyId);
    return this.present(item, record ?? null);
  }
}
