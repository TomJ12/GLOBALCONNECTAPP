/** The margin arithmetic by itself: direction, rounding, tiers, bounds. (How it reaches clients is in rates.test.ts.) */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import Big from 'big.js';

import { baseAmountOf, checkMarginConfig, clientRate, clientTermsOf, directionOf, MarginError, marginBps, workedExample, type MarginConfig, type ProviderTerms } from '../src/rates/margin';

const config = (extra: Partial<MarginConfig> = {}): MarginConfig => ({ defaultBps: 50, forwardBps: null, overrides: [], tiers: [], ...extra });
const sellGbp = (amount: string, rate = '1.2500'): ProviderTerms => ({ sellCurrency: 'GBP', buyCurrency: 'USD', sellAmount: amount, buyAmount: new Big(amount).times(rate).round(2, Big.roundDown).toFixed(2), fixedSide: 'sell', rateBase: 'GBP', rateQuote: 'USD', rate });

test('the margin works against the client in both directions, and the rate is rounded against them', () => {
  // Selling the base: fewer quote units. Buying it: more.
  assert.equal(clientRate('1.2500', 'sell', 50), '1.243750');
  assert.equal(clientRate('1.2500', 'buy', 50), '1.256250');
  assert.equal(clientRate('1.2500', 'sell', 0), '1.250000');
  // Rounding: down when selling, up when buying, at the sixth place.
  assert.equal(clientRate('1.234567', 'sell', 33), '1.230492'); // 1.2304929... down
  assert.equal(clientRate('1.234567', 'buy', 33), '1.238642'); // 1.2386410... up
  for (const [rate, bps] of [['1.2500', 1], ['0.8537', 77], ['151.2345', 250], ['1.000001', 3], ['0.006612', 199]] as const) {
    const exactSell = new Big(rate).times(new Big(10_000).minus(bps)).div(10_000);
    const exactBuy = new Big(rate).times(new Big(10_000).plus(bps)).div(10_000);
    assert.ok(new Big(clientRate(rate, 'sell', bps)).lte(exactSell), `${rate} sell ${bps}`);
    assert.ok(new Big(clientRate(rate, 'buy', bps)).gte(exactBuy), `${rate} buy ${bps}`);
    assert.ok(new Big(clientRate(rate, 'sell', bps)).lt(rate) && new Big(clientRate(rate, 'buy', bps)).gt(rate));
  }
  assert.throws(() => clientRate('0', 'sell', 50), MarginError);
  assert.throws(() => clientRate('-1.2', 'buy', 50), MarginError);
});

test('amounts: the fixed side is exactly what was asked; the other side is rounded against the client and never better than the provider gives', () => {
  // Sells GBP 10,000 for USD at 1.2500 with 50 bp: 1.243750 -> 12,437.50 (the provider gives 12,500.00).
  assert.deepEqual(clientTermsOf(sellGbp('10000.00'), 50), { direction: 'sell', rate: '1.243750', sellAmount: '10000.00', buyAmount: '12437.50', revenue: { amount: '62.50', currency: 'USD' } });
  // Wants exactly USD 12,500 from GBP: pays 12,500 / 1.243750 = 10,050.2512..., rounded UP.
  const wantsUsd: ProviderTerms = { ...sellGbp('10000.00'), fixedSide: 'buy', buyAmount: '12500.00' };
  assert.deepEqual(clientTermsOf(wantsUsd, 50), { direction: 'sell', rate: '1.243750', sellAmount: '10050.26', buyAmount: '12500.00', revenue: { amount: '50.26', currency: 'GBP' } });
  // Buys GBP 10,000 with USD: pays 10,000 x 1.256250 = 12,562.50 (the provider takes 12,500.00).
  const buysGbp: ProviderTerms = { sellCurrency: 'USD', buyCurrency: 'GBP', sellAmount: '12500.00', buyAmount: '10000.00', fixedSide: 'buy', rateBase: 'GBP', rateQuote: 'USD', rate: '1.2500' };
  assert.deepEqual(clientTermsOf(buysGbp, 50), { direction: 'buy', rate: '1.256250', sellAmount: '12562.50', buyAmount: '10000.00', revenue: { amount: '62.50', currency: 'USD' } });
  // Spends exactly USD 12,500 on GBP: gets 12,500 / 1.256250 = 9,950.2487..., rounded DOWN.
  assert.deepEqual(clientTermsOf({ ...buysGbp, fixedSide: 'sell' }, 50), { direction: 'buy', rate: '1.256250', sellAmount: '12500.00', buyAmount: '9950.24', revenue: { amount: '49.76', currency: 'GBP' } });
  // A currency with no minor unit rounds to whole units, against the client.
  const toYen: ProviderTerms = { sellCurrency: 'GBP', buyCurrency: 'JPY', sellAmount: '33.33', buyAmount: '6333', fixedSide: 'sell', rateBase: 'GBP', rateQuote: 'JPY', rate: '190.0111' };
  assert.deepEqual(clientTermsOf(toYen, 37), { direction: 'sell', rate: '189.308058', sellAmount: '33.33', buyAmount: '6309', revenue: { amount: '24', currency: 'JPY' } });

  // Over many amounts and margins: the client never does better than the provider's terms, the fixed side never moves, revenue is never negative.
  for (const amount of ['0.01', '0.07', '1.00', '3.33', '99.99', '1234.56', '10000.00', '999999.99']) {
    for (const bps of [0, 1, 7, 50, 199, 300]) {
      for (const rate of ['1.2500', '0.8537', '1.0001']) {
        const provider = sellGbp(amount, rate);
        if (!new Big(provider.buyAmount).gt(0)) continue;
        let terms;
        try {
          terms = clientTermsOf(provider, bps);
        } catch (error) {
          assert.ok(error instanceof MarginError);
          continue;
        }
        assert.equal(terms.sellAmount, amount);
        assert.ok(new Big(terms.buyAmount).lte(provider.buyAmount), `${amount} ${bps} ${rate}`);
        assert.ok(new Big(terms.revenue.amount).gte(0));
        assert.ok(new Big(terms.buyAmount).plus(terms.revenue.amount).eq(provider.buyAmount), 'what the client gets and what is kept add up to what the provider gave');
        // And never more than the exact figure at the client rate.
        assert.ok(new Big(terms.buyAmount).lte(new Big(amount).times(terms.rate)));
      }
    }
  }
  // Zero margin: the provider's terms, to the penny, and nothing kept.
  assert.deepEqual(clientTermsOf(sellGbp('1234.56'), 0), { direction: 'sell', rate: '1.250000', sellAmount: '1234.56', buyAmount: '1543.20', revenue: { amount: '0.00', currency: 'USD' } });
  // An amount so small that nothing would be received is refused rather than taken for nothing.
  assert.throws(() => clientTermsOf(sellGbp('0.01', '0.9000'), 300), /too small to convert/);
  // A quote that is not in the pair it claims is refused.
  assert.throws(() => directionOf({ sellCurrency: 'GBP', buyCurrency: 'EUR', rateBase: 'GBP', rateQuote: 'USD' }), MarginError);
  assert.equal(baseAmountOf(buysGbp), '10000.00');
});

test('which margin applies: forwards, then a pair override, then the tier for the amount, then the default', () => {
  const full = config({ defaultBps: 60, forwardBps: 90, overrides: [{ pair: 'GBPUSD', direction: 'sell', bps: 40 }, { pair: 'EURUSD', direction: 'both', bps: 35 }], tiers: [{ fromAmount: '50000', bps: 45 }, { fromAmount: '250000', bps: 30 }] });
  const at = (pair: string, direction: 'sell' | 'buy', baseAmount: string | null = null, kind: 'spot' | 'forward' = 'spot') => marginBps(full, { pair, direction, kind, baseAmount });
  assert.equal(at('GBPEUR', 'sell'), 60);
  assert.equal(at('GBPUSD', 'sell'), 40, 'override for that direction');
  assert.equal(at('GBPUSD', 'buy'), 60, 'not for the other direction');
  assert.deepEqual([at('EURUSD', 'sell'), at('EURUSD', 'buy')], [35, 35]);
  assert.deepEqual([at('GBPEUR', 'sell', '49999.99'), at('GBPEUR', 'sell', '50000'), at('GBPEUR', 'buy', '249999.99'), at('GBPEUR', 'sell', '250000.00'), at('GBPEUR', 'sell', '9000000')], [60, 45, 45, 30, 30]);
  assert.equal(at('GBPUSD', 'sell', '9000000'), 40, 'an override is not undercut by a tier');
  assert.equal(at('GBPUSD', 'sell', '10', 'forward'), 90);
  assert.equal(marginBps(config({ defaultBps: 60 }), { pair: 'GBPUSD', direction: 'sell', kind: 'forward' }), 60, 'no forward margin set: priced as spot');
});

test('bounds: never negative, never absurd, high only when the request says so; tiers get smaller as amounts get larger', () => {
  assert.deepEqual(checkMarginConfig(config({ overrides: [{ pair: 'GBPUSD', direction: 'both', bps: 20 }], tiers: [{ fromAmount: '50000.00', bps: 40 }] }), false), { defaultBps: 50, forwardBps: null, overrides: [{ pair: 'GBPUSD', direction: 'both', bps: 20 }], tiers: [{ fromAmount: '50000', bps: 40 }] });
  for (const bad of [config({ defaultBps: -1 }), config({ forwardBps: -5 }), config({ overrides: [{ pair: 'GBPUSD', direction: 'sell', bps: -1 }] }), config({ tiers: [{ fromAmount: '100', bps: -1 }] })]) {
    for (const allowHigh of [false, true]) assert.throws(() => checkMarginConfig(bad, allowHigh), /cannot be negative/);
  }
  assert.throws(() => checkMarginConfig(config({ defaultBps: 301 }), false), /is 301 basis points \(3\.01%\), which is more than 300[^]*allow a margin this high/);
  assert.equal(checkMarginConfig(config({ defaultBps: 301 }), true).defaultBps, 301);
  assert.throws(() => checkMarginConfig(config({ defaultBps: 2001 }), true), /cannot be more than 2000/);
  for (const value of [1.5, Number.NaN, '50' as unknown as number, Infinity]) assert.throws(() => checkMarginConfig(config({ defaultBps: value }), true), /whole number of basis points/);
  for (const pair of ['GBP', 'GBPGBP', 'gbpusd', 'GBP/USD', '<b>USD']) assert.throws(() => checkMarginConfig(config({ overrides: [{ pair, direction: 'sell', bps: 10 }] }), false), /is not a currency pair/);
  assert.throws(() => checkMarginConfig(config({ overrides: [{ pair: 'GBPUSD', direction: 'both', bps: 10 }, { pair: 'GBPUSD', direction: 'sell', bps: 20 }] }), false), /listed twice/);
  assert.throws(() => checkMarginConfig(config({ tiers: [{ fromAmount: '50000', bps: 60 }] }), false), /HIGHER margin/);
  assert.throws(() => checkMarginConfig(config({ tiers: [{ fromAmount: '50000', bps: 40 }, { fromAmount: '50000', bps: 30 }] }), false), /ascending order/);
  assert.throws(() => checkMarginConfig(config({ tiers: [{ fromAmount: '50000', bps: 30 }, { fromAmount: '100000', bps: 40 }] }), false), /HIGHER margin/);
  for (const fromAmount of ['0', '-5', '1e5', 'lots', '']) assert.throws(() => checkMarginConfig(config({ tiers: [{ fromAmount, bps: 10 }] }), false), /amount greater than zero/);
});

test('the worked example for staff says what a change does to a concrete trade', () => {
  assert.equal(
    workedExample(config({ defaultBps: 50 }), config({ defaultBps: 80 }), '1.2500'),
    'selling GBP 10,000 for USD: the client rate changes from 1.243750 to 1.240000, so they receive USD 12400.00 instead of USD 12437.50 (Global Connect keeps USD 100.00 instead of USD 62.50)',
  );
});
