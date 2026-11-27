/** The margin arithmetic by itself: direction, rounding, tiers, bounds. (How it reaches clients is in rates.test.ts.) */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import Big from 'big.js';

import { canonicalTrade, checkMarginConfig, describeMargin, clientRate, clientTermsOf, directionOf, effectiveBps, indicativePair, indicativeRate, MarginError, marginBps, marginPercent, parseMarginPercent, rateDecimals, tierAmountOf, workedExample, type MarginConfig, type ProviderTerms } from '../src/rates/margin';

const config = (extra: Partial<MarginConfig> = {}): MarginConfig => ({ defaultBps: 50, forwardBps: null, overrides: [], tiers: [], tierCurrency: 'GBP', ...extra });
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
  assert.deepEqual(clientTermsOf(toYen, 37), { direction: 'sell', rate: '189.3080', sellAmount: '33.33', buyAmount: '6309', revenue: { amount: '24', currency: 'JPY' } });

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
  // Whatever the arithmetic says, never better than the provider's own figures (here the provider gave less than its rate implies).
  assert.deepEqual(clientTermsOf({ ...sellGbp('100.00'), buyAmount: '124.00' }, 1), { direction: 'sell', rate: '1.249875', sellAmount: '100.00', buyAmount: '124.00', revenue: { amount: '0.00', currency: 'USD' } });
  assert.deepEqual(clientTermsOf({ ...sellGbp('101.00'), fixedSide: 'buy', buyAmount: '125.00' }, 1), { direction: 'sell', rate: '1.249875', sellAmount: '101.00', buyAmount: '125.00', revenue: { amount: '0.00', currency: 'GBP' } });
  // Zero margin: the provider's terms, to the penny, and nothing kept.
  assert.deepEqual(clientTermsOf(sellGbp('1234.56'), 0), { direction: 'sell', rate: '1.250000', sellAmount: '1234.56', buyAmount: '1543.20', revenue: { amount: '0.00', currency: 'USD' } });
  // An amount so small that nothing would be received is refused rather than taken for nothing.
  assert.throws(() => clientTermsOf(sellGbp('0.01', '0.9000'), 300), /too small to convert/);
  // A quote that is not in the pair it claims is refused.
  assert.throws(() => directionOf({ sellCurrency: 'GBP', buyCurrency: 'EUR', rateBase: 'GBP', rateQuote: 'USD' }), MarginError);
});

test('which margin applies: forwards, then a pair override, then the tier for the amount, then the default', () => {
  const full = config({ defaultBps: 60, forwardBps: 90, overrides: [{ pair: 'GBPUSD', direction: 'sell', bps: 40 }, { pair: 'EURUSD', direction: 'both', bps: 35 }], tiers: [{ fromAmount: '50000', bps: 45 }, { fromAmount: '250000', bps: 30 }] });
  const at = (pair: string, direction: 'sell' | 'buy', baseAmount: string | null = null, kind: 'spot' | 'forward' = 'spot') => marginBps(full, { pair, direction, kind, tierAmount: baseAmount });
  assert.equal(at('GBPEUR', 'sell'), 60);
  assert.equal(at('GBPUSD', 'sell'), 40, 'override for that direction');
  assert.equal(at('GBPUSD', 'buy'), 60, 'not for the other direction');
  assert.deepEqual([at('EURUSD', 'sell'), at('EURUSD', 'buy')], [35, 35]);
  assert.deepEqual([at('GBPEUR', 'sell', '49999.99'), at('GBPEUR', 'sell', '50000'), at('GBPEUR', 'buy', '249999.99'), at('GBPEUR', 'sell', '250000.00'), at('GBPEUR', 'sell', '9000000')], [60, 45, 45, 30, 30]);
  assert.equal(at('GBPUSD', 'sell', '9000000'), 40, 'an override is not undercut by a tier');
  // The same trade spelled the other way round is the same trade.
  assert.deepEqual([at('USDGBP', 'buy'), at('USDGBP', 'sell'), at('USDEUR', 'sell'), at('USDEUR', 'buy')], [40, 60, 35, 35]);
  assert.equal(at('GBPUSD', 'sell', '10', 'forward'), 90);
  assert.equal(marginBps(config({ defaultBps: 60 }), { pair: 'GBPUSD', direction: 'sell', kind: 'forward' }), 60, 'no forward margin set: priced as spot');
});

test('bounds: never negative, never absurd, high only when the request says so; tiers get smaller as amounts get larger', () => {
  assert.deepEqual(checkMarginConfig(config({ overrides: [{ pair: 'GBPUSD', direction: 'both', bps: 20 }], tiers: [{ fromAmount: '50000.00', bps: 40 }] }), false), { defaultBps: 50, forwardBps: null, overrides: [{ pair: 'GBPUSD', direction: 'both', bps: 20 }], tiers: [{ fromAmount: '50000', bps: 40 }], tierCurrency: 'GBP' });
  assert.equal(checkMarginConfig(config({ tierCurrency: 'EUR' }), false).tierCurrency, 'EUR');
  for (const tierCurrency of ['gbp', 'POUNDS', '', '<b>']) assert.throws(() => checkMarginConfig(config({ tierCurrency }), false), /three-letter currency code/);
  for (const bad of [config({ defaultBps: -1 }), config({ forwardBps: -5 }), config({ overrides: [{ pair: 'GBPUSD', direction: 'sell', bps: -1 }] }), config({ tiers: [{ fromAmount: '100', bps: -1 }] })]) {
    for (const allowHigh of [false, true]) assert.throws(() => checkMarginConfig(bad, allowHigh), /cannot be negative/);
  }
  assert.throws(() => checkMarginConfig(config({ defaultBps: 301 }), false), /The default margin: 3\.01% is above the usual limit of 3\.00%[^]*allow a margin this high/);
  assert.equal(checkMarginConfig(config({ defaultBps: 301 }), true).defaultBps, 301);
  assert.throws(() => checkMarginConfig(config({ defaultBps: 2001 }), true), /20\.01% is above the maximum of 20\.00%/);
  for (const value of [1.5, Number.NaN, '50' as unknown as number, Infinity]) assert.throws(() => checkMarginConfig(config({ defaultBps: value }), true), /must be a percentage in steps of 0\.01%/);
  for (const pair of ['GBP', 'GBPGBP', 'gbpusd', 'GBP/USD', '<b>USD']) assert.throws(() => checkMarginConfig(config({ overrides: [{ pair, direction: 'sell', bps: 10 }] }), false), /is not a currency pair/);
  assert.throws(() => checkMarginConfig(config({ overrides: [{ pair: 'GBPUSD', direction: 'both', bps: 10 }, { pair: 'GBPUSD', direction: 'sell', bps: 20 }] }), false), /listed twice/);
  assert.throws(() => checkMarginConfig(config({ overrides: [{ pair: 'GBPUSD', direction: 'sell', bps: 10 }, { pair: 'USDGBP', direction: 'buy', bps: 20 }] }), false), /listed twice/);
  assert.equal(checkMarginConfig(config({ overrides: [{ pair: 'GBPUSD', direction: 'sell', bps: 10 }, { pair: 'USDGBP', direction: 'sell', bps: 20 }] }), false).overrides.length, 2);
  assert.throws(() => checkMarginConfig(config({ tiers: [{ fromAmount: '50000', bps: 60 }] }), false), /HIGHER margin/);
  assert.throws(() => checkMarginConfig(config({ tiers: [{ fromAmount: '50000', bps: 40 }, { fromAmount: '50000', bps: 30 }] }), false), /ascending order/);
  assert.throws(() => checkMarginConfig(config({ tiers: [{ fromAmount: '50000', bps: 30 }, { fromAmount: '100000', bps: 40 }] }), false), /HIGHER margin/);
  for (const fromAmount of ['0', '-5', '1e5', 'lots', '']) assert.throws(() => checkMarginConfig(config({ tiers: [{ fromAmount, bps: 10 }] }), false), /amount greater than zero/);
});

test('the worked example for staff says what a change does to a concrete trade', () => {
  assert.equal(
    workedExample(config({ defaultBps: 50 }), config({ defaultBps: 80 }), '1.2500'),
    'selling GBP 10,000 for USD: the client rate changes from 1.243750 to 1.240000, so they receive USD 12400.00 instead of USD 12437.50',
  );
  assert.equal(workedExample(config({ defaultBps: 50 }), config({ defaultBps: 20 }), '1.2500', 'GBPUSD', '10000', 'buy'), 'buying GBP 10,000 with USD: the client rate changes from 1.256250 to 1.252500, so they pay USD 12525.00 instead of USD 12562.50');
  assert.equal(workedExample(config({ defaultBps: 50 }), config({ defaultBps: 50, forwardBps: 100 }), '1.2500', 'GBPUSD', '10000', 'sell', 'forward'), 'a forward selling GBP 10,000 for USD: the client rate changes from 1.243750 to 1.237500, so they receive USD 12375.00 instead of USD 12437.50');
  assert.equal(describeMargin(config({ forwardBps: 90, overrides: [{ pair: 'GBPUSD', direction: 'sell', bps: 40 }], tiers: [{ fromAmount: '50000', bps: 45 }] })), 'default 0.50%; forwards 0.90%; GBPUSD sell 0.40%; from GBP 50000: 0.45%');
});

test('a client rate keeps seven significant figures whatever its size, so rounding never adds a margin of its own; the margin really applied is worked out', () => {
  // Around 1: six places, as before. A yen rate: four. A tiny rate: nine. Always against the client.
  assert.deepEqual([clientRate('1.2500', 'sell', 50), clientRate('195.0325', 'sell', 50), clientRate('0.005128205', 'sell', 50), clientRate('0.005128205', 'buy', 50)], ['1.243750', '194.0573', '0.005102563', '0.005153847']);
  for (const [rate, bps] of [['0.005128205', 50], ['0.000071', 30], ['195.0325', 120], ['1.2500', 1], ['15234.5', 80]] as const) {
    for (const direction of ['sell', 'buy'] as const) {
      const exact = new Big(rate).times(new Big(10_000)[direction === 'sell' ? 'minus' : 'plus'](bps)).div(10_000);
      const got = new Big(clientRate(rate, direction, bps));
      assert.ok(direction === 'sell' ? got.lte(exact) : got.gte(exact), `${rate} ${direction}: against the client`);
      // ...by less than one part in a million: under a hundredth of a basis point. (At six fixed places a rate of 0.005 lost up to 2 bp.)
      assert.ok(got.minus(exact).abs().div(exact).lt('0.000001'), `${rate} ${direction} ${bps}: ${got.toString()} vs ${exact.toString()}`);
    }
  }
  assert.deepEqual([rateDecimals('1.2935'), rateDecimals('195.03'), rateDecimals('0.0051'), rateDecimals('15234.5'), rateDecimals('1.2935', 5), rateDecimals('195.03', 5), rateDecimals('0.0051', 5)], [6, 4, 9, 2, 4, 2, 7]);
  // What was really applied, after rounding of the rate and of the amount: on a small amount it is not the configured figure, and it is on record.
  const provider: ProviderTerms = { sellCurrency: 'GBP', buyCurrency: 'USD', sellAmount: '3.33', buyAmount: '4.16', fixedSide: 'sell', rateBase: 'GBP', rateQuote: 'USD', rate: '1.2500' };
  const client = clientTermsOf(provider, 50);
  assert.deepEqual([client.buyAmount, effectiveBps(provider, client)], ['4.14', '48.08']);
  assert.equal(effectiveBps(sellGbp('10000.00'), clientTermsOf(sellGbp('10000.00'), 50)), '50.00');
});

test('tiers are measured in ONE currency: the size of a trade is converted to it, whichever way round the pair is quoted', () => {
  const tiered = config({ defaultBps: 200, tiers: [{ fromAmount: '50000', bps: 10 }], tierCurrency: 'GBP' });
  const margin = (tierAmount: string | null) => marginBps(tiered, { pair: 'GBPJPY', direction: 'buy', kind: 'spot', tierAmount });
  // Selling 60,000 YEN (about GBP 306) is not a 50,000 trade...
  const yen = { sellCurrency: 'JPY', buyCurrency: 'GBP', sellAmount: '60000', buyAmount: '306.12' };
  assert.equal(tierAmountOf(yen, 'GBP'), '306.12');
  assert.equal(margin(tierAmountOf(yen, 'GBP')), 200);
  // ...selling GBP 60,000 is, in either direction and whichever currency the adapter calls the base.
  assert.equal(margin(tierAmountOf({ sellCurrency: 'GBP', buyCurrency: 'JPY', sellAmount: '60000.00', buyAmount: '11700000' }, 'GBP')), 10);
  assert.equal(margin(tierAmountOf({ sellCurrency: 'JPY', buyCurrency: 'GBP', sellAmount: '11700000', buyAmount: '60000.00' }, 'GBP')), 10);
  // The boundary, to the penny.
  assert.deepEqual([margin('49999.99'), margin('50000.00'), margin('50000')], [200, 10, 10]);
  // Neither currency is the tier currency: converted with the provider's rate for the sell currency; without one, NO tier (never to the client's advantage).
  const eurUsd = { sellCurrency: 'EUR', buyCurrency: 'USD', sellAmount: '60000.00', buyAmount: '66000.00' };
  assert.equal(tierAmountOf(eurUsd, 'GBP', '0.8475'), '50850.00');
  assert.equal(margin(tierAmountOf(eurUsd, 'GBP', '0.8475')), 10);
  assert.equal(margin(tierAmountOf({ ...eurUsd, sellAmount: '58000.00' }, 'GBP', '0.8475')), 200);
  assert.equal(tierAmountOf(eurUsd, 'GBP', null), null);
  assert.equal(margin(null), 200);
  // ONE orientation for every pair, whatever an adapter calls its base.
  assert.deepEqual([canonicalTrade('USDGBP', 'sell'), canonicalTrade('GBPUSD', 'buy'), canonicalTrade('JPYGBP', 'sell'), canonicalTrade('USDEUR', 'buy'), canonicalTrade('AEDJPY', 'sell'), canonicalTrade('JPYAED', 'sell')], [{ pair: 'GBPUSD', direction: 'buy' }, { pair: 'GBPUSD', direction: 'buy' }, { pair: 'GBPJPY', direction: 'buy' }, { pair: 'EURUSD', direction: 'sell' }, { pair: 'AEDJPY', direction: 'sell' }, { pair: 'AEDJPY', direction: 'buy' }]);
});

test('indicative rates are given to display precision, against the client in each direction, and are never an exact image of the provider rate and the margin', () => {
  // Five significant figures: what the app shows. Selling: down. Buying: up.
  assert.deepEqual([indicativeRate('1.30247', 'sell', 50), indicativeRate('1.30247', 'buy', 50)], ['1.2959', '1.3090']);
  assert.deepEqual([indicativeRate('195.0325', 'sell', 50), indicativeRate('195.0325', 'buy', 50), indicativeRate('0.005128205', 'sell', 50), indicativeRate('0.005128205', 'buy', 50)], ['194.05', '196.01', '0.0051025', '0.0051539']);
  assert.deepEqual(indicativePair('1.30247', 50, 50), { sell: '1.2959', buy: '1.3090' });
  // When the client's rates sit exactly on displayable figures (1.3000 with 50 bp: 1.2935 and 1.3065), or so nearly that the
  // rounding moved them by less than a quarter of a step, the SELL figure is shown one step lower.
  assert.deepEqual(indicativePair('1.3000', 50, 50), { sell: '1.2934', buy: '1.3065' });
  assert.deepEqual(indicativePair('1.2997', 20, 20), { sell: '1.2970', buy: '1.3023' });
  for (const rate of ['1.3000', '1.30247', '1.1800', '0.7692', '195.00', '0.005128', '1.2997', '1.3001', '4.7743', '1.2999', '1.3004', '0.8475']) {
    for (const [sellBps, buyBps] of [[0, 0], [20, 20], [50, 50], [100, 100], [120, 120], [250, 250], [20, 50], [1, 1], [33, 33]] as const) {
      const shown = indicativePair(rate, sellBps, buyBps);
      const [sell, buy] = [new Big(shown.sell), new Big(shown.buy)];
      const exactSell = new Big(rate).times(new Big(10_000).minus(sellBps)).div(10_000);
      const exactBuy = new Big(rate).times(new Big(10_000).plus(buyBps)).div(10_000);
      // Never better than a held quote would be, and within two display steps of it.
      const step = new Big(10).pow(-rateDecimals(exactSell, 5));
      assert.ok(sell.lte(exactSell) && buy.gte(exactBuy), `${rate} ${sellBps}`);
      assert.ok(exactSell.minus(sell).lte(step.times(2)) && buy.minus(exactBuy).lte(step), `${rate} ${sellBps}`);
      // Together at least a quarter of a step beyond the exact figures...
      assert.ok(exactSell.minus(sell).plus(buy.minus(exactBuy)).gte(step.div(4)), `${rate} ${sellBps}`);
      // ...so the margin cannot be read off them: (buy - sell) / (buy + sell) is not the configured margin at six places.
      if (sellBps === buyBps) assert.notEqual(buy.minus(sell).div(buy.plus(sell)).round(6, Big.roundHalfUp).toFixed(6), new Big(sellBps).div(10_000).toFixed(6), `${rate} at ${sellBps} bp gives the margin away: ${shown.sell} / ${shown.buy}`);
    }
  }
});

test('PERCENTAGES at the edges, basis points inside: what a person types becomes whole basis points, exactly, and anything ambiguous is refused with the unit in the message', () => {
  // What is typed -> what is stored.
  for (const [typed, bps] of [['0.5', 50], ['1', 100], ['1.25', 125], ['0,75', 75], ['0.50%', 50], ['0,75 %', 75], [' 2 ', 200], ['0', 0], ['0.01', 1], ['20', 2000], ['3.00', 300], ['12.3', 1230]] as const) {
    assert.equal(parseMarginPercent(typed, 'The default margin'), bps, typed);
  }
  // "50" MEANS FIFTY PERCENT. It is not quietly read as basis points: the ceiling refuses it, and says so in percent.
  assert.equal(parseMarginPercent('50', 'The default margin'), 5000);
  const fifty = { defaultBps: parseMarginPercent('50', 'The default margin'), forwardBps: null, overrides: [], tiers: [], tierCurrency: 'GBP' };
  for (const allowHigh of [false, true]) assert.throws(() => checkMarginConfig(fifty, allowHigh), /The default margin: 50\.00% is above the maximum of 20\.00%\. \(Margins are percentages: for half a percent write 0\.50\.\)/);
  // Refused: more than two decimal places (0.005 would be half a basis point), thousands separators, signs, units, words, nothing.
  for (const typed of ['0.005', '1.234', '0,005']) assert.throws(() => parseMarginPercent(typed, 'The default margin'), /The default margin is a percentage with at most two decimal places \(steps of 0\.01%\)/, typed);
  for (const typed of ['1,000', '1.000,5', '1,000.5']) assert.throws(() => parseMarginPercent(typed, 'The default margin'), /percentage/, typed);
  for (const typed of ['', ' ', '.5', '5.', '1..2', '1,2,3', '+1', '50bp', '50 bp', '0.5 percent', 'half', '1e2', '0x10', '%', '1%%', '１.５']) assert.throws(() => parseMarginPercent(typed, 'The default margin'), /is written as a percentage, like 0\.50 or 0\.50%/, JSON.stringify(typed));
  assert.throws(() => parseMarginPercent('-0.5', 'The default margin'), /cannot be negative/);
  // What is stored -> what is shown: always two places and a % sign, exactly (no floating point).
  assert.deepEqual([0, 1, 50, 75, 100, 125, 300, 2000, 1999].map((bps) => marginPercent(bps)), ['0.00%', '0.01%', '0.50%', '0.75%', '1.00%', '1.25%', '3.00%', '20.00%', '19.99%']);
  assert.deepEqual(['49.97', '80.00', '0.4'].map((bps) => marginPercent(bps)), ['0.50%', '0.80%', '0.00%'], 'the effective margin after rounding, to two places');
  // There and back for every whole basis point a margin can be.
  for (let bps = 0; bps <= 2000; bps += 1) assert.equal(parseMarginPercent(marginPercent(bps), 'x'), bps);
});
