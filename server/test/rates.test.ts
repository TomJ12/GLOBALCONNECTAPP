/**
 * Client rates through the API: a client sees THEIR rate and nothing else; the margin works against them both
 * ways; the indicative rate, the held quote and the booked conversion agree; the provider switch; revenue is
 * recorded server-side. (The arithmetic alone is in margin.test.ts; the ops console side in ops.test.ts.)
 */
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import Big from 'big.js';

import { walkedRate, walkOffset, WALK_STEP_MS } from '@/api/adapters/mockRateWalk';
import * as schemas from '@/api/schemas';

import type { MarginConfig } from '../src/rates/margin';
import { AMIRA, BEN, forbiddenInClientResponse, harness, type Harness } from './helpers';

let h: Harness;
afterEach(async () => {
  await h?.close();
});

async function signedIn(email: string): Promise<{ token: string }> {
  const { secret } = await h.activate(email);
  const reply = await h.login(email, secret);
  assert.equal(reply.status, 200);
  return { token: reply.json.token };
}
const setMargin = (companyId: string, config: Partial<MarginConfig>) =>
  h.stores.margins.put(companyId, { defaultBps: 50, forwardBps: null, overrides: [], tiers: [], ...config, companyId, updatedAt: h.clock.now, updatedBy: 'test@globalconnect.example', approvedBy: null });
const get = async (token: string, url: string) => {
  const reply = await h.call('GET', url, { token });
  assert.equal(reply.status, 200, `${url}: ${JSON.stringify(reply.json)}`);
  return reply.json;
};
const quoteFor = async (token: string, body: Record<string, string>) => {
  const reply = await h.call('POST', '/v1/quotes', { token, body: { kind: 'spot', ...body } });
  assert.equal(reply.status, 200, JSON.stringify(reply.json));
  return schemas.quote.parse(reply.json);
};
const book = (token: string, quoteId: string, key: string) => h.call('POST', '/v1/conversions', { token, body: { quoteId }, headers: { 'idempotency-key': key } });
const balance = async (token: string, currency: string): Promise<string> => (await get(token, '/v1/balances')).items.find((row: { currency: string }) => row.currency === currency).amount;
const revenue = () => h.stores.revenue.list();

test('a client sees only their own rate: sell and buy, indicative, margin against them both ways; history is their rate too', async () => {
  h = await harness();
  const amira = await signedIn(AMIRA);
  const ben = await signedIn(BEN);

  // Provider A's sample GBP/USD is 1.3000. With the default 50 bp: selling GBP gets less, buying GBP costs more.
  const rate = await get(amira.token, '/v1/rates/GBP/USD');
  assert.deepEqual(Object.keys(rate).sort(), ['asOf', 'base', 'buyRate', 'indicative', 'quote', 'rate']);
  assert.deepEqual([rate.base, rate.quote, rate.rate, rate.buyRate, rate.indicative], ['GBP', 'USD', '1.293500', '1.306500', true]);
  schemas.ratePair.parse(rate);
  // Asked for the other way round, the margin is still against the client (0.7692 at the provider).
  const inverse = await get(amira.token, '/v1/rates/USD/GBP');
  assert.deepEqual([inverse.rate, inverse.buyRate], ['0.765354', '0.773046']);
  assert.ok(new Big(inverse.rate).lt('0.7692') && new Big(inverse.buyRate).gt('0.7692'));
  // Provider B (Ben's company) the same way: 1.3000 there too.
  const bens = await get(ben.token, '/v1/rates/GBP/USD');
  assert.deepEqual([bens.rate, bens.buyRate, bens.indicative], ['1.293500', '1.306500', true]);

  // The trend line is the client's sell rate at each point, never the provider's series.
  const company = (await h.stores.directory.getCompany('co_northfield')) as NonNullable<Awaited<ReturnType<typeof h.stores.directory.getCompany>>>;
  const raw = await (await h.registry.forCompany(company)).getRateHistory('GBP', 'USD');
  const history = await get(amira.token, '/v1/rates/GBP/USD/history');
  assert.equal(history.points.length, raw.points.length);
  assert.ok(raw.points.length > 5);
  for (const [index, point] of raw.points.entries()) {
    const expected = new Big(point.rate).times('0.995').round(6, Big.roundDown).toFixed(6);
    assert.equal(history.points[index].rate, expected);
    assert.notEqual(history.points[index].rate, point.rate);
  }
  assert.equal(history.points.at(-1).rate, rate.rate, 'the line ends on the rate shown');

  // The company's own configuration: an override for one direction of one pair; the other direction keeps the default.
  await setMargin('co_northfield', { defaultBps: 50, overrides: [{ pair: 'GBPUSD', direction: 'sell', bps: 20 }] });
  const mine = await get(amira.token, '/v1/rates/GBP/USD');
  assert.deepEqual([mine.rate, mine.buyRate], ['1.297400', '1.306500']);
  assert.deepEqual([(await get(amira.token, '/v1/rates/USD/GBP')).buyRate], ['0.770739'], 'the same trade spelled the other way gets the same override');
  // Another company is not affected.
  assert.equal((await get(ben.token, '/v1/rates/GBP/USD')).rate, '1.293500');

  // Nothing any of these said mentions the provider's own figure.
  for (const body of h.bodies) assert.ok(!/1\.3000|1\.300000|"1\.3"|0\.769231|0\.7692"/.test(body), body);
});

test('the indicative rate, the held quote and the booked conversion agree, on both providers and both ways; balances move by the client’s amounts; revenue is on record, server-side only', async () => {
  h = await harness();
  const amira = await signedIn(AMIRA);
  const ben = await signedIn(BEN);
  await setMargin('co_northfield', { defaultBps: 50, forwardBps: 90, overrides: [{ pair: 'GBPUSD', direction: 'sell', bps: 20 }], tiers: [{ fromAmount: '20000', bps: 30 }] });

  // --- Provider A: sells GBP 1,000 for USD. Override: 20 bp. 1.3000 -> 1.297400.
  const indicative = await get(amira.token, '/v1/rates/GBP/USD');
  const sell = await quoteFor(amira.token, { sellCurrency: 'GBP', buyCurrency: 'USD', fixedSide: 'sell', amount: '1000.00' });
  assert.deepEqual([sell.rate, sell.sellAmount, sell.buyAmount], ['1.297400', '1000.00', '1297.40']);
  assert.equal(sell.rate, indicative.rate, 'the held quote is at the indicative sell rate');
  assert.deepEqual(Object.keys(sell).sort(), ['buyAmount', 'buyCurrency', 'createdAt', 'expiresAt', 'fixedSide', 'id', 'kind', 'rate', 'rateBase', 'rateQuote', 'sellAmount', 'sellCurrency', 'settlementDate']);
  const [gbp, usd] = [await balance(amira.token, 'GBP'), await balance(amira.token, 'USD')];
  const booked = await book(amira.token, sell.id, 'rates-key-0001');
  assert.equal(booked.status, 200, JSON.stringify(booked.json));
  schemas.conversion.parse(booked.json);
  assert.deepEqual([booked.json.rate, booked.json.sellAmount, booked.json.buyAmount], [sell.rate, sell.sellAmount, sell.buyAmount], 'booked on exactly the held terms');
  assert.equal(await balance(amira.token, 'GBP'), new Big(gbp).minus('1000.00').toFixed(2));
  assert.equal(await balance(amira.token, 'USD'), new Big(usd).plus('1297.40').toFixed(2), 'the client received their amount, not the provider’s 1,300.00');
  // The same key again: the same conversion, the same terms, nothing booked twice.
  const again = await book(amira.token, sell.id, 'rates-key-0001');
  assert.deepEqual(again.json, booked.json);
  assert.deepEqual((await get(amira.token, '/v1/conversions/by-key/rates-key-0001')), booked.json);
  assert.equal(await balance(amira.token, 'USD'), new Big(usd).plus('1297.40').toFixed(2));

  // What the server keeps on record (never sent to a client): both sides, the margin, the revenue.
  const [record] = await revenue();
  assert.equal((await revenue()).length, 1);
  assert.deepEqual(
    { ...record, key: undefined, createdAt: undefined, bookedAt: undefined },
    { key: undefined, createdAt: undefined, bookedAt: undefined, companyId: 'co_northfield', userId: 'usr_amira', quoteId: sell.id, conversionId: booked.json.id, status: 'booked', kind: 'spot', appliedBy: 'server', pair: 'GBPUSD', direction: 'sell', sellCurrency: 'GBP', buyCurrency: 'USD', providerRate: '1.3000', providerSellAmount: '1000.00', providerBuyAmount: '1300.00', clientRate: '1.297400', clientSellAmount: '1000.00', clientBuyAmount: '1297.40', marginBps: 20, revenueAmount: '2.60', revenueCurrency: 'USD', mismatch: false },
  );
  assert.equal(record?.bookedAt, h.clock.now);

  // --- Buys GBP with USD (the other direction of the pair): the default 50 bp, at the indicative BUY rate.
  const buy = await quoteFor(amira.token, { sellCurrency: 'USD', buyCurrency: 'GBP', fixedSide: 'buy', amount: '1000.00' });
  assert.deepEqual([buy.rate, buy.sellAmount, buy.buyAmount], ['1.306500', '1306.50', '1000.00']);
  assert.equal(buy.rate, indicative.buyRate);
  // Fixed the other way: spends exactly USD 1,000; receives 1000 / 1.3065 = 765.4037..., rounded DOWN.
  const spend = await quoteFor(amira.token, { sellCurrency: 'USD', buyCurrency: 'GBP', fixedSide: 'sell', amount: '1000.00' });
  assert.deepEqual([spend.rate, spend.sellAmount, spend.buyAmount], ['1.306500', '1000.00', '765.40']);
  // A large amount in a pair with no override gets the tier (30 bp): never worse than the indicative rate.
  const large = await quoteFor(amira.token, { sellCurrency: 'GBP', buyCurrency: 'EUR', fixedSide: 'sell', amount: '20000.00' });
  assert.deepEqual([large.rate, large.buyAmount], ['1.176460', '23529.20']);
  assert.ok(new Big(large.rate).gt((await get(amira.token, '/v1/rates/GBP/EUR')).rate));
  // ...but an override is not undercut by a tier.
  assert.equal((await quoteFor(amira.token, { sellCurrency: 'GBP', buyCurrency: 'USD', fixedSide: 'sell', amount: '20000.00' })).rate, '1.297400');
  // A forward is priced with the forward margin (90 bp), whatever the pair override says.
  const forward = await quoteFor(amira.token, { kind: 'forward', sellCurrency: 'GBP', buyCurrency: 'USD', fixedSide: 'sell', amount: '1000.00', settlementDate: '2027-03-01' });
  assert.deepEqual([forward.rate, forward.buyAmount], ['1.288300', '1288.30']);
  const forwardBooked = await book(amira.token, forward.id, 'rates-key-0002');
  assert.equal(forwardBooked.status, 200);
  assert.deepEqual([forwardBooked.json.rate, forwardBooked.json.buyAmount], ['1.288300', '1288.30']);
  const forwards = (await get(amira.token, '/v1/forwards')).items;
  assert.deepEqual(forwards.filter((item: { id: string }) => item.id === forwardBooked.json.id).map((item: { rate: string; buyAmount: string; sellAmount: string }) => [item.rate, item.sellAmount, item.buyAmount]), [['1.288300', '1000.00', '1288.30']]);
  assert.deepEqual((await revenue()).filter((item) => item.kind === 'forward').map((item) => [item.marginBps, item.revenueAmount, item.revenueCurrency]), [[90, '11.70', 'USD']]);

  // --- Provider B, default 50 bp: sells GBP for EUR (1.1800 -> 1.174100), and buys GBP with EUR.
  const bIndicative = await get(ben.token, '/v1/rates/GBP/EUR');
  const bSell = await quoteFor(ben.token, { sellCurrency: 'GBP', buyCurrency: 'EUR', fixedSide: 'sell', amount: '500.00' });
  assert.deepEqual([bSell.rate, bSell.sellAmount, bSell.buyAmount], ['1.174100', '500.00', '587.05']);
  assert.equal(bSell.rate, bIndicative.rate);
  const [bGbp, bEur] = [await balance(ben.token, 'GBP'), await balance(ben.token, 'EUR')];
  const bBooked = await book(ben.token, bSell.id, 'rates-key-b-0001');
  assert.equal(bBooked.status, 200, JSON.stringify(bBooked.json));
  assert.deepEqual([bBooked.json.rate, bBooked.json.sellAmount, bBooked.json.buyAmount], ['1.174100', '500.00', '587.05']);
  assert.deepEqual([await balance(ben.token, 'GBP'), await balance(ben.token, 'EUR')], [new Big(bGbp).minus('500.00').toFixed(2), new Big(bEur).plus('587.05').toFixed(2)]);
  assert.deepEqual(await get(ben.token, '/v1/conversions/by-key/rates-key-b-0001'), bBooked.json);
  const bRecord = (await revenue()).find((item) => item.companyId === 'co_castlebrook');
  assert.deepEqual([bRecord?.providerRate, bRecord?.providerBuyAmount, bRecord?.clientBuyAmount, bRecord?.marginBps, bRecord?.revenueAmount, bRecord?.revenueCurrency, bRecord?.mismatch], ['1.1800', '590.00', '587.05', 50, '2.95', 'EUR', false]);
  // Sells EUR to buy GBP: the same trade as buying GBP in GBP/EUR, so the rate matches that side of the indicative pair.
  const bBuy = await quoteFor(ben.token, { sellCurrency: 'EUR', buyCurrency: 'GBP', fixedSide: 'sell', amount: '590.00' });
  const eurGbp = await get(ben.token, '/v1/rates/EUR/GBP');
  assert.equal(bBuy.rate, eurGbp.rate);
  assert.ok(new Big(bBuy.buyAmount).lt('500.00'), 'less than the provider’s 500.00');

  // Never better than the provider, whatever the amount and side, on both providers.
  for (const [who, pair] of [[amira, ['GBP', 'EUR']], [ben, ['GBP', 'USD']], [ben, ['USD', 'EUR']], [amira, ['EUR', 'USD']]] as const) {
    const company = (await h.stores.directory.getCompany(who === amira ? 'co_northfield' : 'co_castlebrook')) as NonNullable<Awaited<ReturnType<typeof h.stores.directory.getCompany>>>;
    const adapter = await h.registry.forCompany(company);
    for (const amount of ['0.07', '1.00', '33.33', '1234.56']) {
      for (const [sellCurrency, buyCurrency] of [pair, [pair[1], pair[0]]] as const) {
        for (const fixedSide of ['sell', 'buy'] as const) {
          const request = { kind: 'spot' as const, sellCurrency, buyCurrency, fixedSide, amount };
          const reply = await h.call('POST', '/v1/quotes', { token: who.token, body: request });
          if (reply.status !== 200) {
            assert.deepEqual(reply.json, { error: { kind: 'validation', fields: ['amount'] } }, `${JSON.stringify(request)} -> ${JSON.stringify(reply.json)}`);
            continue;
          }
          const theirs = await adapter.createQuote(request);
          assert.equal(fixedSide === 'sell' ? reply.json.sellAmount : reply.json.buyAmount, fixedSide === 'sell' ? theirs.sellAmount : theirs.buyAmount);
          assert.ok(new Big(reply.json.buyAmount).lte(theirs.buyAmount) && new Big(reply.json.sellAmount).gte(theirs.sellAmount), JSON.stringify([request, reply.json, theirs]));
          assert.ok(!new Big(reply.json.rate).eq(theirs.rate), 'not the provider’s rate');
        }
      }
    }
  }
  // No client route serves the revenue records or the margin.
  for (const url of ['/v1/revenue', '/v1/margin', '/v1/margins', '/v1/companies/co_northfield/margin', '/v1/rates/GBP/USD/provider']) assert.equal((await h.call('GET', url, { token: amira.token })).status, 404, url);
});

test('where the margin is applied is a setting per provider: with "provider" the server adds nothing on top', async () => {
  h = await harness({ marginAppliedBy: { currencycloud: 'provider', equals: 'server' } });
  const amira = await signedIn(AMIRA);
  const ben = await signedIn(BEN);
  await setMargin('co_northfield', { defaultBps: 80 }); // stored, but not used: the provider prices this company's trades
  const rate = await get(amira.token, '/v1/rates/GBP/USD');
  assert.deepEqual([rate.rate, rate.buyRate, rate.indicative], ['1.3', '1.3', true]); // exactly what the provider gave
  const quote = await quoteFor(amira.token, { sellCurrency: 'GBP', buyCurrency: 'USD', fixedSide: 'sell', amount: '1000.00' });
  assert.deepEqual([quote.rate, quote.buyAmount], ['1.3000', '1300.00']);
  const usd = await balance(amira.token, 'USD');
  const booked = await book(amira.token, quote.id, 'rates-key-p-0001');
  assert.equal(booked.status, 200);
  assert.deepEqual([booked.json.rate, booked.json.buyAmount], ['1.3000', '1300.00']);
  assert.equal(await balance(amira.token, 'USD'), new Big(usd).plus('1300.00').toFixed(2), 'no second margin was taken');
  const [record] = await revenue();
  assert.deepEqual([record?.appliedBy, record?.marginBps, record?.revenueAmount, record?.revenueCurrency, record?.clientBuyAmount, record?.status], ['provider', null, null, null, '1300.00', 'booked']);
  assert.ok(new Big((await get(amira.token, '/v1/rates/GBP/USD/history')).points.at(-1).rate).eq('1.3'));
  // The other provider is still priced by the server.
  assert.equal((await get(ben.token, '/v1/rates/GBP/USD')).rate, '1.293500');
});

test('a provider that books without the client’s terms: the client still sees only their terms, and the record is flagged; a booking whose answer was lost is closed when it is found', async () => {
  h = await harness();
  const amira = await signedIn(AMIRA);
  // A provider that ignores the two parameters carrying the client's side.
  const original = h.providerA.request.bind(h.providerA);
  const sent: Record<string, unknown>[] = [];
  h.providerA.request = async (request) => {
    if (request.path !== '/v2/conversions/create') return original(request);
    sent.push({ ...request.params });
    const { client_buy_amount: _buy, client_sell_amount: _sell, ...params } = request.params ?? {};
    return original({ ...request, params });
  };
  const quote = await quoteFor(amira.token, { sellCurrency: 'GBP', buyCurrency: 'USD', fixedSide: 'sell', amount: '1000.00' });
  const booked = await book(amira.token, quote.id, 'rates-key-m-0001');
  assert.equal(booked.status, 200);
  assert.deepEqual([sent[0]?.client_buy_amount, sent[0]?.client_sell_amount], ['1293.50', '1000.00'], 'the client’s terms were sent');
  assert.deepEqual([booked.json.rate, booked.json.buyAmount], ['1.293500', '1293.50'], 'not the provider’s 1.3000 / 1,300.00');
  assert.deepEqual((await get(amira.token, '/v1/conversions/by-key/rates-key-m-0001')), booked.json);
  assert.equal((await revenue())[0]?.mismatch, true);
  assert.ok(h.logs.some((line) => /without the client terms/.test(line)));

  // The answer to a booking never arrives; the record stays open, and is closed when the conversion is found by its key.
  h.providerA.request = async (request) => {
    const reply = await original(request);
    if (request.path === '/v2/conversions/create') throw new TypeError('Network request failed');
    return reply;
  };
  const second = await quoteFor(amira.token, { sellCurrency: 'GBP', buyCurrency: 'USD', fixedSide: 'sell', amount: '200.00' });
  const lost = await book(amira.token, second.id, 'rates-key-m-0002');
  assert.equal(lost.status >= 500, true);
  const open = (await revenue()).find((item) => item.quoteId === second.id);
  assert.deepEqual([open?.status, open?.conversionId, open?.clientBuyAmount], ['booking', null, '258.70']);
  h.providerA.request = original;
  const found = await get(amira.token, '/v1/conversions/by-key/rates-key-m-0002');
  assert.deepEqual([found.rate, found.buyAmount], ['1.293500', '258.70']);
  const closed = (await revenue()).find((item) => item.quoteId === second.id);
  assert.deepEqual([closed?.status, closed?.conversionId, closed?.mismatch], ['booked', found.id, false]);

  // A definite refusal: nothing was booked, and the record says so.
  const third = await quoteFor(amira.token, { sellCurrency: 'GBP', buyCurrency: 'USD', fixedSide: 'sell', amount: '99999999.00' });
  assert.equal((await book(amira.token, third.id, 'rates-key-m-0003')).json.error.kind, 'insufficient_funds');
  assert.equal((await revenue()).find((item) => item.quoteId === third.id)?.status, 'failed');

  // An amount too small to be worth anything after the margin is refused as an amount problem, in neutral words.
  const tiny = await h.call('POST', '/v1/quotes', { token: amira.token, body: { kind: 'spot', sellCurrency: 'JPY', buyCurrency: 'GBP', fixedSide: 'sell', amount: '1' } });
  assert.equal(tiny.status, 400);
  assert.equal(forbiddenInClientResponse(JSON.stringify(tiny.json)), null);
});

test('the scan that guards every client response does catch the forbidden fields', () => {
  for (const leak of ['{"midRate":"1.3"}', '{"mid":"1.3"}', '{"mid_market_rate":"1.3"}', '{"quote":{"marginBps":50}}', '{"margin":{"defaultBps":50}}', '{"providerRate":"1.3"}', '{"provider_rate":"1.3"}', '{"partner_rate":"1.3"}', '{"core_rate":"1.3"}', '{"revenueAmount":"2.60"}', '{"markup":"0.5"}', '{"spread":"0.5"}', '{"bps":50}', '{"wholesaleRate":"1"}', '{"appliedBy":"server"}', '{"error":{"message":"margin could not be worked out"}}', '{"note":"mid-market rate"}', '{"note":"50 basis points"}']) {
    assert.notEqual(forbiddenInClientResponse(leak), null, leak);
  }
  for (const fine of ['{"rate":"1.2935","buyRate":"1.3065","indicative":true}', '{"paymentId":"p1","itemId":"x"}', '{"kind":"server"}']) assert.equal(forbiddenInClientResponse(fine), null, fine);
});

test('MOCK: the sample rates move as a deterministic walk in small steps, the same for everyone; a held quote does not move', async () => {
  // The walk itself: the same pair at the same time always gives the same figure; one step moves it by at most one basis point; it stays near the sample rate.
  const start = Date.UTC(2026, 10, 11, 10, 0, 0);
  assert.equal(walkOffset('GBPUSD', start), walkOffset('GBPUSD', start));
  assert.equal(walkOffset('GBPUSD', start), walkOffset('GBPUSD', start + WALK_STEP_MS - 1 - (start % WALK_STEP_MS)));
  const series = Array.from({ length: 2000 }, (_, index) => walkOffset('GBPUSD', start + index * WALK_STEP_MS));
  assert.ok(new Set(series).size > 10, 'it moves');
  for (let index = 1; index < series.length; index += 1) assert.ok(Math.abs((series[index] ?? 0) - (series[index - 1] ?? 0)) <= 2, 'at most one basis point (two half points) a step');
  assert.ok(Math.max(...series.map(Math.abs)) <= 256);
  assert.notDeepEqual(series.slice(0, 50), Array.from({ length: 50 }, (_, index) => walkOffset('EURUSD', start + index * WALK_STEP_MS)), 'each pair has its own walk');
  // The pair and its inverse always agree.
  const forwards = walkedRate('GBP', 'USD', new Big('1.3'), start + 77 * WALK_STEP_MS);
  assert.ok(forwards.times(walkedRate('USD', 'GBP', new Big(1).div('1.3'), start + 77 * WALK_STEP_MS)).minus(1).abs().lt('0.0000001'));

  h = await harness({ mockMovingRates: true, defaultMarginBps: 0, rateCacheMs: 0 });
  const amira = await signedIn(AMIRA);
  const ben = await signedIn(BEN);
  const seen = new Set<string>();
  let previous = '';
  let quote = await quoteFor(amira.token, { sellCurrency: 'GBP', buyCurrency: 'USD', fixedSide: 'sell', amount: '1000.00' });
  const held = quote.rate;
  for (let index = 0; index < 40; index += 1) {
    const [a, b] = [await get(amira.token, '/v1/rates/GBP/USD'), await get(ben.token, '/v1/rates/GBP/USD')];
    assert.equal(a.rate, b.rate, 'both mock providers show the same market');
    assert.ok(new Big(a.rate).minus('1.3').abs().lte('0.0167'), a.rate);
    if (previous) assert.ok(new Big(a.rate).minus(previous).abs().lte('0.00021'), `${previous} -> ${a.rate}: a step is at most one basis point (and the rounding to four places)`);
    previous = a.rate;
    seen.add(a.rate);
    if (index === 0) {
      // The quote just taken is at the rate just shown (within one step), and booking it later uses the HELD rate.
      assert.ok(new Big(quote.rate).minus(a.rate).abs().lte('0.0003'));
    }
    h.clock.advance(WALK_STEP_MS);
  }
  assert.ok(seen.size >= 5, `the rate moved: ${[...seen].join(' ')}`);
  quote = await quoteFor(amira.token, { sellCurrency: 'GBP', buyCurrency: 'USD', fixedSide: 'sell', amount: '1000.00' });
  h.clock.advance(WALK_STEP_MS * 0.4);
  const booked = await book(amira.token, quote.id, 'rates-key-w-0001');
  assert.equal(booked.status, 200, JSON.stringify(booked.json));
  assert.equal(new Big(booked.json.rate).eq(quote.rate), true);
  assert.ok(held);
});

test('the provider’s rate is fetched once per provider and pair within the cache time, however many ask', async () => {
  h = await harness({ rateCacheMs: 5000 });
  const amira = await signedIn(AMIRA);
  const count = () => h.providerA.seen.filter((item) => item.path === '/v2/rates/find').length;
  const before = count();
  for (let index = 0; index < 5; index += 1) await get(amira.token, '/v1/rates/GBP/USD');
  assert.equal(count(), before + 1);
  await get(amira.token, '/v1/rates/GBP/EUR');
  assert.equal(count(), before + 2, 'another pair is another rate');
  h.clock.advance(5001);
  await get(amira.token, '/v1/rates/GBP/USD');
  assert.equal(count(), before + 3);
});
