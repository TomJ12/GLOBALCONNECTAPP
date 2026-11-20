/**
 * THE CLIENT'S RATE, from the provider's rate and the company's margin.
 *
 * Everything a client is told about a rate, a quote or a conversion passes
 * through here. What comes out has the client's rate and amounts and nothing
 * else: not the provider's rate, not the margin, not what Global Connect
 * keeps. Those stay in `HeldQuote` (server memory) and `RevenueRecord` (the
 * database), which no client route returns.
 *
 * WHERE THE MARGIN IS APPLIED is a setting per provider (config.marginAppliedBy):
 *   server    this file works the client's rate out (rates/margin.ts);
 *   provider  the provider already returns the client's rate, with the
 *             partner's markup configured on its side. The server adds
 *             NOTHING on top (that would charge the client twice), and does
 *             not know the revenue.
 */
import Big from 'big.js';

import type { Conversion, ForwardContract, Quote, RateHistory, RatePair } from '@/api/types';

import type { Config } from '../config';
import type { ProviderAdapter } from '../providers/adapter';
import type { CompanyRecord, MarginRecord, RevenueRecord, Stores } from '../store/types';
import { baseAmountOf, clientRate, clientTermsOf, directionOf, marginBps, type MarginConfig } from './margin';

/** A quote this server gave a client: their side, and (never sent anywhere) the provider's. */
export interface HeldQuote {
  companyId: string;
  client: Quote;
  provider: Quote;
  appliedBy: 'server' | 'provider';
  marginBps: number | null;
  revenue: { amount: string; currency: string } | null;
}

export const marginConfigOf = (record: MarginConfig): MarginConfig => ({ defaultBps: record.defaultBps, forwardBps: record.forwardBps, overrides: record.overrides, tiers: record.tiers });

export class ClientRates {
  private readonly cache = new Map<string, { until: number; rate: Promise<RatePair> }>();

  constructor(
    private readonly stores: Pick<Stores, 'margins' | 'revenue'>,
    private readonly config: Pick<Config, 'marginAppliedBy' | 'defaultMarginBps' | 'rateCacheMs'>,
    private readonly now: () => number,
  ) {}

  appliedBy(company: Pick<CompanyRecord, 'providerKey'>): 'server' | 'provider' {
    return this.config.marginAppliedBy[company.providerKey];
  }

  /** The company's own margin configuration, or the server default when it has none. */
  async marginOf(companyId: string): Promise<{ config: MarginConfig; record: MarginRecord | null }> {
    const record = await this.stores.margins.get(companyId);
    return { record, config: record ? marginConfigOf(record) : { defaultBps: this.config.defaultMarginBps, forwardBps: null, overrides: [], tiers: [] } };
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

  /** What the client is shown for a pair: their rate selling the base, their rate buying it. Indicative. */
  async indicative(company: CompanyRecord, provider: Pick<ProviderAdapter, 'getRate'>, base: string, quote: string): Promise<RatePair> {
    const raw = await this.providerRate(company, provider, base, quote);
    return this.indicativeFrom(company, raw, (await this.marginOf(company.id)).config);
  }

  indicativeFrom(company: Pick<CompanyRecord, 'providerKey'>, raw: RatePair, config: MarginConfig): RatePair {
    if (this.appliedBy(company) === 'provider') return { base: raw.base, quote: raw.quote, rate: raw.rate, buyRate: raw.buyRate ?? raw.rate, indicative: true, asOf: raw.asOf };
    const pair = `${raw.base}${raw.quote}`;
    return {
      base: raw.base,
      quote: raw.quote,
      rate: clientRate(raw.rate, 'sell', marginBps(config, { pair, direction: 'sell', kind: 'spot' })),
      buyRate: clientRate(raw.rate, 'buy', marginBps(config, { pair, direction: 'buy', kind: 'spot' })),
      indicative: true,
      asOf: raw.asOf,
    };
  }

  /** The trend line is the client's SELL rate over time: the same series the headline rate belongs to. */
  async history(company: CompanyRecord, raw: RateHistory): Promise<RateHistory> {
    if (this.appliedBy(company) === 'provider') return { base: raw.base, quote: raw.quote, points: raw.points.map((point) => ({ at: point.at, rate: point.rate })) };
    const bps = marginBps((await this.marginOf(company.id)).config, { pair: `${raw.base}${raw.quote}`, direction: 'sell', kind: 'spot' });
    return { base: raw.base, quote: raw.quote, points: raw.points.map((point) => ({ at: point.at, rate: clientRate(point.rate, 'sell', bps) })) };
  }

  /** The client's quote from the provider's. */
  async quote(company: CompanyRecord, provider: Quote): Promise<HeldQuote> {
    if (this.appliedBy(company) === 'provider') return { companyId: company.id, client: provider, provider, appliedBy: 'provider', marginBps: null, revenue: null };
    const { config } = await this.marginOf(company.id);
    const bps = marginBps(config, { pair: `${provider.rateBase}${provider.rateQuote}`, direction: directionOf(provider), kind: provider.kind, baseAmount: baseAmountOf(provider) });
    const terms = clientTermsOf(provider, bps);
    return { companyId: company.id, client: { ...provider, sellAmount: terms.sellAmount, buyAmount: terms.buyAmount, rate: terms.rate }, provider, appliedBy: 'server', marginBps: bps, revenue: terms.revenue };
  }

  /**
   * Written BEFORE the provider is asked to book. If this key was used before, the first record stands (the
   * provider will return the first conversion too), and ITS terms are the ones sent.
   */
  async beginBooking(held: HeldQuote, userId: string, keyHash: string): Promise<RevenueRecord> {
    const key = `${held.companyId}:${keyHash}`;
    const fresh: RevenueRecord = {
      key,
      companyId: held.companyId,
      userId,
      quoteId: held.client.id,
      conversionId: null,
      status: 'booking',
      kind: held.client.kind,
      appliedBy: held.appliedBy,
      pair: `${held.provider.rateBase}${held.provider.rateQuote}`,
      direction: directionOf(held.provider),
      sellCurrency: held.client.sellCurrency,
      buyCurrency: held.client.buyCurrency,
      providerRate: held.provider.rate,
      providerSellAmount: held.provider.sellAmount,
      providerBuyAmount: held.provider.buyAmount,
      clientRate: held.client.rate,
      clientSellAmount: held.client.sellAmount,
      clientBuyAmount: held.client.buyAmount,
      marginBps: held.marginBps,
      revenueAmount: held.revenue?.amount ?? null,
      revenueCurrency: held.revenue?.currency ?? null,
      mismatch: false,
      createdAt: this.now(),
      bookedAt: null,
    };
    return (await this.stores.revenue.mutate(key, (current) => (current && current.status !== 'failed' ? undefined : fresh))) as RevenueRecord;
  }

  /** The provider refused outright: nothing was booked under this key. */
  async failBooking(key: string): Promise<void> {
    await this.stores.revenue.mutate(key, (current) => (current && current.status === 'booking' ? { ...current, status: 'failed' } : undefined));
  }

  /** The provider booked it. Records the conversion, and whether the provider's answer carries the client's terms. */
  async completeBooking(key: string, conversion: Conversion): Promise<RevenueRecord | null> {
    return this.stores.revenue.mutate(key, (current) => {
      if (!current || current.status === 'booked') return undefined;
      const mismatch = current.appliedBy === 'server' && (!new Big(conversion.sellAmount).eq(current.clientSellAmount) || !new Big(conversion.buyAmount).eq(current.clientBuyAmount));
      return { ...current, status: 'booked', conversionId: conversion.id, mismatch, bookedAt: this.now() };
    });
  }

  recordFor(companyId: string, keyHash: string): Promise<RevenueRecord | null> {
    return this.stores.revenue.get(`${companyId}:${keyHash}`);
  }

  /**
   * What the client is shown for a conversion this server priced: ITS record of their terms, whatever the
   * provider's answer says. (If a provider ignored the client's terms it was sent, its answer would carry its
   * own rate; that must not reach the client. The record is marked `mismatch` for staff.)
   */
  present<T extends Conversion | ForwardContract>(item: T, record: RevenueRecord | null): T {
    if (!record || record.appliedBy !== 'server') return item;
    return { ...item, sellAmount: record.clientSellAmount, buyAmount: record.clientBuyAmount, rate: record.clientRate, rateBase: record.pair.slice(0, 3), rateQuote: record.pair.slice(3) };
  }

  async presentById<T extends Conversion | ForwardContract>(companyId: string, item: T): Promise<T> {
    const [record] = await this.stores.revenue.list({ conversionId: item.id }, (row) => row.companyId === companyId);
    return this.present(item, record ?? null);
  }
}
