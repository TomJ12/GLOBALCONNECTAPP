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

import { loadConfig } from '../src/config';
import type { MarginConfig } from '../src/rates/margin';
import { sha256 } from '../src/crypto';
import { neutralFields } from '../src/http/app';
import { ClientRates } from '../src/rates/service';
import { MockCurrencycloudPlatform } from '../src/providers/currencycloudMock';
import { MockEqualsServer } from '../src/providers/equals/mockServer';
import { AMIRA, BEN, DANA, forbiddenInClientResponse, harness, marginReadableFrom, type Harness } from './helpers';

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
  h.stores.margins.put(companyId, { defaultBps: 50, forwardBps: null, overrides: [], tiers: [], tierCurrency: 'GBP', ...config, companyId, updatedAt: h.clock.now, updatedBy: 'test@globalconnect.example', approvedBy: null });
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

  // Provider A's sample GBP/USD is 1.3000. With the default 50 bp: selling GBP gets less (1.2935), buying GBP costs
  // more (1.3065). The INDICATIVE figures are at the app's display precision, each rounded against the client, and
  // (because both would otherwise sit exactly on a displayable figure) the sell side is shown one step lower.
  const rate = await get(amira.token, '/v1/rates/GBP/USD');
  assert.deepEqual(Object.keys(rate).sort(), ['asOf', 'base', 'buyRate', 'indicative', 'quote', 'rate']);
  assert.deepEqual([rate.base, rate.quote, rate.rate, rate.buyRate, rate.indicative], ['GBP', 'USD', '1.2934', '1.3065', true]);
  schemas.ratePair.parse(rate);
  // Asked for the other way round, the margin is still against the client (0.7692 at the provider).
  const inverse = await get(amira.token, '/v1/rates/USD/GBP');
  assert.deepEqual([inverse.rate, inverse.buyRate], ['0.76535', '0.77305']);
  assert.ok(new Big(inverse.rate).lt('0.7692') && new Big(inverse.buyRate).gt('0.7692'));
  // Provider B (Ben's company) the same way: 1.3000 there too.
  const bens = await get(ben.token, '/v1/rates/GBP/USD');
  assert.deepEqual([bens.rate, bens.buyRate, bens.indicative], ['1.2934', '1.3065', true]);

  // The trend line is the client's sell rate at each point, never the provider's series.
  const company = (await h.stores.directory.getCompany('co_northfield')) as NonNullable<Awaited<ReturnType<typeof h.stores.directory.getCompany>>>;
  const raw = await (await h.registry.forCompany(company)).getRateHistory('GBP', 'USD');
  const history = await get(amira.token, '/v1/rates/GBP/USD/history');
  assert.equal(history.points.length, raw.points.length);
  assert.ok(raw.points.length > 5);
  for (const [index, point] of raw.points.entries()) {
    const expected = new Big(point.rate).times('0.995').round(4, Big.roundDown).toFixed(4);
    assert.equal(history.points[index].rate, expected);
    assert.notEqual(history.points[index].rate, point.rate);
  }
  // The line ends at the rate shown (to within the one display step the two-way figure may be lowered by).
  assert.ok(new Big(history.points.at(-1).rate).minus(rate.rate).abs().lte('0.0001'));

  // The company's own configuration: an override for one direction of one pair; the other direction keeps the default.
  await setMargin('co_northfield', { defaultBps: 50, overrides: [{ pair: 'GBPUSD', direction: 'sell', bps: 20 }] });
  const mine = await get(amira.token, '/v1/rates/GBP/USD');
  assert.deepEqual([mine.rate, mine.buyRate], ['1.2973', '1.3065']);
  assert.deepEqual([(await get(amira.token, '/v1/rates/USD/GBP')).buyRate], ['0.77074'], 'the same trade spelled the other way gets the same override');
  // Another company is not affected.
  assert.equal((await get(ben.token, '/v1/rates/GBP/USD')).rate, '1.2934');

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
  // The held quote has the client's rate in full; the indicative figure is the same rate at display precision, never better.
  assert.ok(new Big(indicative.rate).lte(sell.rate) && new Big(sell.rate).minus(indicative.rate).lte('0.0002'), 'the held quote is at the indicative sell rate, to display precision');
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
  // The same key with a DIFFERENT quote is refused: one key is one booking of one quote. The record is not rewritten.
  const otherQuote = await quoteFor(amira.token, { sellCurrency: 'GBP', buyCurrency: 'USD', fixedSide: 'sell', amount: '500.00' });
  assert.deepEqual((await book(amira.token, otherQuote.id, 'rates-key-0001')).json, { error: { kind: 'validation', fields: ['idempotencyKey'] } });
  assert.deepEqual((await revenue()).map((item) => [item.clientSellAmount, item.quoteId, item.status]), [['1000.00', sell.id, 'booked']]);
  assert.equal(await balance(amira.token, 'USD'), new Big(usd).plus('1297.40').toFixed(2));

  // What the server keeps on record (never sent to a client): both sides, the margin, the revenue.
  const [record] = await revenue();
  assert.equal((await revenue()).length, 1);
  assert.deepEqual(
    { ...record, key: undefined, createdAt: undefined, bookedAt: undefined },
    { key: undefined, createdAt: undefined, bookedAt: undefined, companyId: 'co_northfield', userId: 'usr_amira', quoteId: sell.id, conversionId: booked.json.id, status: 'booked', kind: 'spot', appliedBy: 'server', pair: 'GBPUSD', direction: 'sell', quotedAs: 'GBPUSD', sellCurrency: 'GBP', buyCurrency: 'USD', providerRate: '1.3000', providerSellAmount: '1000.00', providerBuyAmount: '1300.00', clientRate: '1.297400', clientSellAmount: '1000.00', clientBuyAmount: '1297.40', marginBps: 20, effectiveBps: '20.00', revenueAmount: '2.60', revenueCurrency: 'USD', mismatch: false, bookedRate: '1.297400', bookedSellAmount: '1000.00', bookedBuyAmount: '1297.40' },
  );
  assert.equal(record?.bookedAt, h.clock.now);

  // --- Buys GBP with USD (the other direction of the pair): the default 50 bp, at the indicative BUY rate.
  const buy = await quoteFor(amira.token, { sellCurrency: 'USD', buyCurrency: 'GBP', fixedSide: 'buy', amount: '1000.00' });
  assert.deepEqual([buy.rate, buy.sellAmount, buy.buyAmount], ['1.306500', '1306.50', '1000.00']);
  assert.ok(new Big(buy.rate).eq(indicative.buyRate));
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
  assert.ok(new Big(bIndicative.rate).lte(bSell.rate) && new Big(bSell.rate).minus(bIndicative.rate).lte('0.0002'));
  const [bGbp, bEur] = [await balance(ben.token, 'GBP'), await balance(ben.token, 'EUR')];
  const bBooked = await book(ben.token, bSell.id, 'rates-key-b-0001');
  assert.equal(bBooked.status, 200, JSON.stringify(bBooked.json));
  assert.deepEqual([bBooked.json.rate, bBooked.json.sellAmount, bBooked.json.buyAmount], ['1.174100', '500.00', '587.05']);
  assert.deepEqual([await balance(ben.token, 'GBP'), await balance(ben.token, 'EUR')], [new Big(bGbp).minus('500.00').toFixed(2), new Big(bEur).plus('587.05').toFixed(2)]);
  assert.deepEqual(await get(ben.token, '/v1/conversions/by-key/rates-key-b-0001'), bBooked.json);
  const bRecord = (await revenue()).find((item) => item.companyId === 'co_castlebrook');
  assert.deepEqual([bRecord?.providerRate, bRecord?.providerBuyAmount, bRecord?.clientBuyAmount, bRecord?.marginBps, bRecord?.revenueAmount, bRecord?.revenueCurrency, bRecord?.mismatch], ['1.1800', '590.00', '587.05', 50, '2.95', 'EUR', false]);
  // On record in the ONE orientation used for every provider (EUR/GBP: selling GBP is buying EUR), with the orientation the rates are quoted in beside it.
  assert.deepEqual([bRecord?.pair, bRecord?.direction, bRecord?.quotedAs, bRecord?.effectiveBps], ['EURGBP', 'buy', 'GBPEUR', '50.00']);
  // Sells EUR to buy GBP: the same trade as buying GBP in GBP/EUR, so the rate matches that side of the indicative pair.
  const bBuy = await quoteFor(ben.token, { sellCurrency: 'EUR', buyCurrency: 'GBP', fixedSide: 'sell', amount: '590.00' });
  const eurGbp = await get(ben.token, '/v1/rates/EUR/GBP');
  assert.ok(new Big(eurGbp.rate).lte(bBuy.rate) && new Big(bBuy.rate).minus(eurGbp.rate).lte('0.00002'), `${bBuy.rate} / ${eurGbp.rate}`);
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

/** A harness whose provider A models a partner markup configured AT the provider (its client figures are worse than its own). */
async function withProviderMarkup(overrides: Parameters<typeof harness>[0], markupBps: number): Promise<Harness> {
  const clock = { now: Date.UTC(2026, 10, 11, 10, 0, 0), advance(ms: number) { clock.now += ms; } };
  return harness(overrides, undefined, { clock, providers: { a: new MockCurrencycloudPlatform({ now: () => clock.now, partnerMarkupBps: markupBps }), b: new MockEqualsServer({ now: () => clock.now }) } });
}

test('where the margin is applied is a setting per provider: with "provider" the server adds nothing on top; a WRONG setting refuses to quote rather than give the wholesale rate or charge twice', async () => {
  // RIGHT: the provider has a 100 bp partner markup configured, and the setting says so. The server adds nothing.
  h = await withProviderMarkup({ marginAppliedBy: { currencycloud: 'provider', equals: 'server' } }, 100);
  const amira = await signedIn(AMIRA);
  const ben = await signedIn(BEN);
  await setMargin('co_northfield', { defaultBps: 80 }); // stored, but not used: the provider prices this company's trades
  const quote = await quoteFor(amira.token, { sellCurrency: 'GBP', buyCurrency: 'USD', fixedSide: 'sell', amount: '1000.00' });
  assert.deepEqual([quote.rate, quote.buyAmount], ['1.287000', '1287.00'], 'the provider\'s own client figures, with nothing more taken');
  assert.equal('markup' in quote, false);
  const usd = await balance(amira.token, 'USD');
  const booked = await book(amira.token, quote.id, 'rates-key-p-0001');
  assert.equal(booked.status, 200, JSON.stringify(booked.json));
  assert.deepEqual([booked.json.rate, booked.json.buyAmount], ['1.287000', '1287.00']);
  assert.equal(await balance(amira.token, 'USD'), new Big(usd).plus('1287.00').toFixed(2), 'no second margin was taken');
  const [record] = await revenue();
  assert.deepEqual([record?.appliedBy, record?.marginBps, record?.revenueAmount, record?.revenueCurrency, record?.clientBuyAmount, record?.status, record?.effectiveBps], ['provider', null, null, null, '1287.00', 'booked', null]);
  // The indicative rate is passed through from the provider (only after a real quote has shown its markup is there).
  assert.deepEqual([(await get(amira.token, '/v1/rates/GBP/USD')).indicative, (await get(amira.token, '/v1/rates/GBP/USD')).rate], [true, '1.3']);
  // The other provider is still priced by the server.
  assert.equal((await get(ben.token, '/v1/rates/GBP/USD')).rate, '1.2934');
  await h.close();

  // WRONG, one way: the setting says "provider" but the provider's quotes carry NO markup. The client would be shown
  // and given the wholesale rate. Nothing is quoted: no rate, no history-free quote, no booking; the log says why.
  h = await harness({ marginAppliedBy: { currencycloud: 'provider', equals: 'server' } });
  const wholesale = await signedIn(AMIRA);
  for (const reply of [await h.call('GET', '/v1/rates/GBP/USD', { token: wholesale.token }), await h.call('POST', '/v1/quotes', { token: wholesale.token, body: { kind: 'spot', sellCurrency: 'GBP', buyCurrency: 'USD', fixedSide: 'sell', amount: '1000.00' } })]) {
    assert.deepEqual([reply.status, reply.json], [502, { error: { kind: 'server' } }]);
  }
  assert.equal((await h.stores.quotes.list()).length, 0);
  // EVERY way a rate reaches a client is closed, not only those two: the trend line, a new alert, and an alert
  // that already exists (it does not fire: its notification and email would have quoted the wholesale rate).
  for (const reply of [await h.call('GET', '/v1/rates/GBP/USD/history', { token: wholesale.token }), await h.call('POST', '/v1/alerts', { token: wholesale.token, body: { base: 'GBP', quote: 'USD', side: 'sell', targetRate: '1.2' } })]) {
    assert.deepEqual([reply.status, reply.json], [502, { error: { kind: 'server' } }]);
  }
  await h.stores.alerts.put('alr_already', { id: 'alr_already', userId: 'usr_amira', companyId: 'co_northfield', base: 'GBP', quote: 'USD', side: 'sell', targetRate: '1.2', status: 'active', createdAt: h.clock.now, armedAt: h.clock.now, arming: 'a1', triggeredAt: null, triggeredRate: null });
  assert.equal(await h.alerts.check(), 0);
  assert.deepEqual([(await h.stores.alerts.get('alr_already'))?.status, (await h.stores.notifications.list({ userId: 'usr_amira' })).length, h.outbox.sent.filter((message) => /rate/i.test(message.subject)).length], ['active', 0, 0]);
  assert.ok(h.logs.some((line) => /is \\"provider\\", but the provider's quote carries no partner markup/.test(line)));
  assert.ok(h.bodies.every((body) => !/1\.3000|"1\.3"/.test(body)), 'the wholesale rate was never sent');
  await h.close();

  // WRONG, the other way: the setting says "server" but the provider ALREADY marks up. The client would pay twice. Refused.
  h = await withProviderMarkup({}, 100);
  const twice = await signedIn(AMIRA);
  const refused = await h.call('POST', '/v1/quotes', { token: twice.token, body: { kind: 'spot', sellCurrency: 'GBP', buyCurrency: 'USD', fixedSide: 'sell', amount: '1000.00' } });
  assert.deepEqual([refused.status, refused.json], [502, { error: { kind: 'server' } }]);
  assert.ok(h.logs.some((line) => /already carries a partner markup: the client would be charged twice/.test(line)));
  // A provider whose quotes do not say whether they carry a markup cannot be set to "provider" at all.
  assert.throws(() => loadConfig({ APP_ENV: 'development', MARGIN_APPLIED_BY_EQUALS: 'provider' }), /MARGIN_APPLIED_BY_EQUALS=provider is refused/);
});

test('a provider that books WITHOUT the client’s terms: the client is shown what was really booked, flagged and told; the record is flagged and audited; a booking whose answer was lost is closed when it is found', async () => {
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
  // What moved on the account is 1,300.00, not the quoted 1,293.50: the client is shown THAT, with a flag that it differs.
  assert.deepEqual([booked.json.buyAmount, booked.json.sellAmount, booked.json.differsFromQuote], ['1300.00', '1000.00', true]);
  schemas.conversion.parse(booked.json);
  assert.deepEqual(await get(amira.token, '/v1/conversions/by-key/rates-key-m-0001'), booked.json);
  assert.deepEqual((await book(amira.token, quote.id, 'rates-key-m-0001')).json, booked.json, 'asked again: the same answer, nothing booked twice');
  assert.equal(sent.length, 1);
  const [flagged] = await revenue();
  assert.deepEqual([flagged?.mismatch, flagged?.clientBuyAmount, flagged?.bookedBuyAmount, flagged?.bookedSellAmount], [true, '1293.50', '1300.00', '1000.00']);
  assert.ok(h.logs.some((line) => /without the client terms/.test(line)));
  // Audited once, and the person who booked it is told once, in the app and by email.
  const audited = await h.stores.audit.query({ action: 'system.conversion.mismatch' });
  assert.deepEqual([audited.length, audited[0]?.detail.quoted, audited[0]?.detail.booked], [1, '1000.00 GBP for 1293.50 USD', '1000.00 GBP for 1300.00 USD']);
  const told = (await get(amira.token, '/v1/notifications')).items;
  assert.deepEqual(told.map((item: { title: string }) => item.title), ['A conversion was not booked as quoted']);
  assert.match(told[0].body, /^You were quoted GBP 1000\.00 for USD 1293\.50\. What was booked is GBP 1000\.00 for USD 1300\.00: that is what moved on the account\.\nPlease contact Global Connect before converting again: \[/);
  assert.equal(h.outbox.sent.filter((message) => /^A conversion in Global Connect needs your attention$/.test(message.subject)).length, 1);
  // The same for a forward, and for the list of forwards read back from the provider afterwards.
  const forward = await quoteFor(amira.token, { kind: 'forward', sellCurrency: 'GBP', buyCurrency: 'USD', fixedSide: 'sell', amount: '1000.00', settlementDate: '2027-03-01' });
  const forwardBooked = await book(amira.token, forward.id, 'rates-key-m-0009');
  assert.equal(forwardBooked.status, 200);
  const listed = (await get(amira.token, '/v1/forwards')).items.find((item: { id: string }) => item.id === forwardBooked.json.id);
  assert.deepEqual([listed.sellAmount, listed.buyAmount, listed.differsFromQuote], ['1000.00', '1300.00', true]);

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
  // Looked up by its key: the conversion WAS made, and this server's record of it is closed now.
  const found = await get(amira.token, '/v1/conversions/by-key/rates-key-m-0002');
  assert.deepEqual([found.rate, found.buyAmount, found.differsFromQuote], ['1.293500', '258.70', undefined]);
  const closed = (await revenue()).find((item) => item.quoteId === second.id);
  assert.deepEqual([closed?.status, closed?.conversionId, closed?.mismatch], ['booked', found.id, false]);
  // Asked for again with the same key and quote: answered from that conversion, not booked again.
  const retried = await book(amira.token, second.id, 'rates-key-m-0002');
  assert.deepEqual([retried.status, retried.json], [200, found]);
  // A second lost answer, this time simply retried: the retry finds the conversion by its key and closes the record itself.
  h.providerA.request = async (request) => {
    const reply = await original(request);
    if (request.path === '/v2/conversions/create') throw new TypeError('Network request failed');
    return reply;
  };
  const again = await quoteFor(amira.token, { sellCurrency: 'GBP', buyCurrency: 'USD', fixedSide: 'sell', amount: '300.00' });
  assert.equal((await book(amira.token, again.id, 'rates-key-m-0004')).status >= 500, true);
  h.providerA.request = original;
  // (Retried after the quote has run out: it is still the conversion that was made, not "quote expired".)
  h.clock.advance(Date.parse(again.expiresAt) - h.clock.now + 1000);
  const second2 = await book(amira.token, again.id, 'rates-key-m-0004');
  assert.deepEqual([second2.status, second2.json.buyAmount], [200, '388.05']);
  assert.deepEqual((await revenue()).filter((item) => item.quoteId === again.id).map((item) => item.status), ['booked']);

  // A definite refusal: nothing was booked, and the record says so.
  const third = await quoteFor(amira.token, { sellCurrency: 'GBP', buyCurrency: 'USD', fixedSide: 'sell', amount: '99999999.00' });
  assert.equal((await book(amira.token, third.id, 'rates-key-m-0003')).json.error.kind, 'insufficient_funds');
  assert.equal((await revenue()).find((item) => item.quoteId === third.id)?.status, 'failed');

  // An amount too small to be worth anything after the margin is refused as an amount problem, in neutral words.
  const tiny = await h.call('POST', '/v1/quotes', { token: amira.token, body: { kind: 'spot', sellCurrency: 'JPY', buyCurrency: 'GBP', fixedSide: 'sell', amount: '1' } });
  assert.equal(tiny.status, 400);
  assert.equal(forbiddenInClientResponse(JSON.stringify(tiny.json)), null);
});

test('“not booked as quoted” always reaches the person: it is not held back by the hourly allowance of ordinary notifications, and it is tried again until the notification exists', async () => {
  h = await harness({ notificationsPerUserPerHour: 1 });
  const amira = await signedIn(AMIRA);
  const original = h.providerA.request.bind(h.providerA);
  h.providerA.request = async (request) => {
    if (request.path !== '/v2/conversions/create') return original(request);
    const { client_buy_amount: _buy, client_sell_amount: _sell, ...params } = request.params ?? {};
    return original({ ...request, params });
  };
  const differs = async () => (await get(amira.token, '/v1/notifications')).items.filter((item: { title: string }) => item.title === 'A conversion was not booked as quoted').length;
  // Her allowance of ordinary notifications for the hour is used up (by a colleague's payments, say).
  await h.stores.notifications.put('filler', { id: 'ntf_filler', key: 'filler', userId: 'usr_amira', companyId: 'co_northfield', category: 'payments', kind: 'payment_sent', body: '{}', createdAt: h.clock.now, readAt: null });
  const first = await book(amira.token, (await quoteFor(amira.token, { sellCurrency: 'GBP', buyCurrency: 'USD', fixedSide: 'sell', amount: '1000.00' })).id, 'rates-key-n-0001');
  assert.deepEqual([first.status, first.json.differsFromQuote], [200, true]);
  assert.equal(await differs(), 1, 'told although the ordinary allowance was used up');
  assert.deepEqual((await revenue()).map((item) => item.untold), [null]);
  // Its email is in the class that ordinary notifications cannot use up either.
  assert.deepEqual((await h.stores.mail.list()).filter((row) => row.template === 'notification').map((row) => row.class), ['security']);

  // The notification cannot be made at that moment (the database is busy, the process dies...): the booking is
  // still answered, the record stays marked, and the next scan tells her. Once.
  const notify = h.notifier.notify.bind(h.notifier);
  h.notifier.notify = async () => {
    throw new Error('database is locked');
  };
  const second = await book(amira.token, (await quoteFor(amira.token, { sellCurrency: 'GBP', buyCurrency: 'USD', fixedSide: 'sell', amount: '500.00' })).id, 'rates-key-n-0002');
  assert.deepEqual([second.status, second.json.differsFromQuote], [200, true]);
  assert.equal(await differs(), 1);
  assert.deepEqual((await h.rates.untoldMismatches()).map((item) => item.clientSellAmount), ['500.00']);
  assert.equal(await h.conversionNotes.scan(), 0, 'still failing: still marked');
  h.notifier.notify = notify;
  assert.equal(await h.conversionNotes.scan(), 1);
  assert.equal(await differs(), 2);
  assert.deepEqual([(await h.rates.untoldMismatches()).length, await h.conversionNotes.scan(), await differs()], [0, 0, 2]);
});

test('a quote is checked BY THIS SERVER when it is booked: this person’s, in this company, not run out, used once, and priced by the margin still in force; it survives a restart; provider field names never reach the client', async () => {
  h = await harness();
  const amira = await signedIn(AMIRA);
  const dana = await signedIn(DANA);
  assert.equal((await h.call('POST', '/v1/session/company', { token: dana.token, body: { companyId: 'co_northfield' } })).status, 200);
  const ben = await signedIn(BEN);
  // Every refusal below is made HERE: the provider is never asked to book.
  const original = h.providerA.request.bind(h.providerA);
  let bookings = 0;
  h.providerA.request = async (request) => {
    if (request.path === '/v2/conversions/create') bookings += 1;
    return original(request);
  };
  const expired = (reply: { status: number; json: any }) => assert.deepEqual([reply.status, reply.json], [409, { error: { kind: 'quote_expired' } }]);
  const fresh = () => quoteFor(amira.token, { sellCurrency: 'GBP', buyCurrency: 'USD', fixedSide: 'sell', amount: '100.00' });

  // Somebody else's quote: a colleague in the same company, and a person in another company.
  let quote = await fresh();
  expired(await book(dana.token, quote.id, 'l5-key-000001'));
  expired(await book(ben.token, quote.id, 'l5-key-000002'));
  // Kept in the database (not in memory), with the provider's side that the client never sees.
  const kept = await h.stores.quotes.get(`co_northfield:${quote.id}`);
  assert.deepEqual([kept?.userId, kept?.client.rate, kept?.provider.rate, kept?.usedBy], ['usr_amira', '1.293500', '1.3000', null]);
  // A "restart": a NEW service over the same database still knows the quote (it used to be in memory and was lost).
  const restarted = new ClientRates(h.stores, h.config, () => h.clock.now);
  assert.equal((await restarted.claimQuote({ id: 'co_northfield' }, 'usr_amira', quote.id, sha256('l5-key-000003').slice(0, 16)))?.client.id, quote.id);
  assert.equal(await restarted.claimQuote({ id: 'co_northfield' }, 'usr_dana', quote.id, 'someone-else'), null);
  assert.equal(bookings, 0);
  const ok = await book(amira.token, quote.id, 'l5-key-000003');
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  assert.equal(bookings, 1);
  // USED ONCE: the same quote under another key is refused here.
  expired(await book(amira.token, quote.id, 'l5-key-000004'));
  assert.equal(bookings, 1);

  // RUN OUT: one second past its time.
  quote = await fresh();
  h.clock.advance(Date.parse(quote.expiresAt) - h.clock.now + 1000);
  expired(await book(amira.token, quote.id, 'l5-key-000005'));
  assert.equal(bookings, 1);

  // A MARGIN CHANGE while a quote is held: a quote priced before the change cannot be booked after it.
  quote = await fresh();
  h.clock.advance(1000);
  await setMargin('co_northfield', { defaultBps: 300 });
  expired(await book(amira.token, quote.id, 'l5-key-000006'));
  assert.equal(bookings, 1);
  const repriced = await fresh();
  assert.equal(repriced.rate, '1.261000');
  assert.equal((await book(amira.token, repriced.id, 'l5-key-000007')).status, 200);
  assert.equal(bookings, 2);
  // ...and the same when the change is committed at the very moment the booking begins (after it was received, before it claims its quote).
  quote = await fresh();
  const quotes = h.stores.quotes;
  const claim = quotes.mutate.bind(quotes);
  quotes.mutate = async (...args: Parameters<typeof claim>) => {
    quotes.mutate = claim;
    h?.clock.advance(5);
    await setMargin('co_northfield', { defaultBps: 310 });
    return claim(...args);
  };
  expired(await book(amira.token, quote.id, 'l5-key-000009'));
  quotes.mutate = claim;
  assert.equal(bookings, 2);

  // What has run out is cleared away; the table does not only grow.
  h.clock.advance(10 * 60_000);
  await fresh();
  assert.equal((await h.stores.quotes.list()).length, 1);

  // A provider's refusal that names ITS parameters: the client is told the neutral API's field names, never the provider's.
  quote = await fresh();
  h.providerA.request = async (request) => (request.path === '/v2/conversions/create' ? original({ ...request, params: { ...request.params, client_sell_amount: '1.00' } }) : original(request));
  const refused = await book(amira.token, quote.id, 'l5-key-000008');
  assert.deepEqual([refused.status, refused.json], [400, { error: { kind: 'validation', fields: ['amount'] } }]);
  assert.deepEqual(neutralFields(['client_sell_amount', 'quote_id', 'buy_currency', 'amount', 'some_provider_thing', 'clientAmounts', 'orderId']), ['amount', 'quoteId', 'buyCurrency']);
  for (const leak of ['{"error":{"kind":"validation","fields":["client_sell_amount"]}}', '{"error":{"fields":["quote_id"]}}', '{"error":{"fields":["amount","clientAmounts"]}}']) assert.notEqual(forbiddenInClientResponse(leak), null, leak);
});

test('tiers through the API, on both providers: a trade’s size is measured in the company’s ONE tier currency, so 60,000 yen is not priced as 60,000 pounds', async () => {
  h = await harness();
  const amira = await signedIn(AMIRA);
  const ben = await signedIn(BEN);
  for (const company of ['co_northfield', 'co_castlebrook']) await setMargin(company, { defaultBps: 200, tiers: [{ fromAmount: '50000', bps: 10 }], tierCurrency: 'GBP' });
  const marginOf = async (quoteId: string, company: string) => (await h.stores.quotes.get(`${company}:${quoteId}`))?.marginBps;
  for (const [who, company] of [[amira, 'co_northfield'], [ben, 'co_castlebrook']] as const) {
    // Selling 60,000 YEN (about GBP 306): the default, on BOTH providers, whichever currency the adapter calls the base.
    const yen = await quoteFor(who.token, { sellCurrency: 'JPY', buyCurrency: 'GBP', fixedSide: 'sell', amount: '60000' });
    assert.equal(await marginOf(yen.id, company), 200, `${company}: 60,000 yen`);
    assert.ok(new Big(yen.buyAmount).lt('302'), `${company}: ${yen.buyAmount}`);
    // Buying yen with GBP 306: the same.
    assert.equal(await marginOf((await quoteFor(who.token, { sellCurrency: 'GBP', buyCurrency: 'JPY', fixedSide: 'sell', amount: '306.00' })).id, company), 200);
    // GBP 60,000 into yen, and yen worth GBP 60,000 into pounds, both get the tier: the size is the same either way round.
    assert.equal(await marginOf((await quoteFor(who.token, { sellCurrency: 'GBP', buyCurrency: 'JPY', fixedSide: 'sell', amount: '60000.00' })).id, company), 10);
    assert.equal(await marginOf((await quoteFor(who.token, { sellCurrency: 'JPY', buyCurrency: 'GBP', fixedSide: 'buy', amount: '60000.00' })).id, company), 10);
    // The boundary, in pounds, to the penny.
    assert.equal(await marginOf((await quoteFor(who.token, { sellCurrency: 'GBP', buyCurrency: 'USD', fixedSide: 'sell', amount: '49999.99' })).id, company), 200);
    assert.equal(await marginOf((await quoteFor(who.token, { sellCurrency: 'GBP', buyCurrency: 'USD', fixedSide: 'sell', amount: '50000.00' })).id, company), 10);
    // Neither side is the tier currency (EUR to USD): the size is converted at the provider's rate. EUR 60,000 is about GBP 50,847; EUR 58,000 is not GBP 50,000.
    assert.equal(await marginOf((await quoteFor(who.token, { sellCurrency: 'EUR', buyCurrency: 'USD', fixedSide: 'sell', amount: '60000.00' })).id, company), 10, `${company}: EUR 60,000`);
    assert.equal(await marginOf((await quoteFor(who.token, { sellCurrency: 'EUR', buyCurrency: 'USD', fixedSide: 'sell', amount: '58000.00' })).id, company), 200, `${company}: EUR 58,000`);
  }
  // A company whose tiers are in another currency: the same trade is measured in THAT.
  await setMargin('co_northfield', { defaultBps: 200, tiers: [{ fromAmount: '50000', bps: 10 }], tierCurrency: 'USD' });
  assert.equal(await marginOf((await quoteFor(amira.token, { sellCurrency: 'GBP', buyCurrency: 'USD', fixedSide: 'sell', amount: '40000.00' })).id, 'co_northfield'), 10, 'GBP 40,000 is USD 52,000');
  assert.equal(await marginOf((await quoteFor(amira.token, { sellCurrency: 'GBP', buyCurrency: 'USD', fixedSide: 'sell', amount: '38000.00' })).id, 'co_northfield'), 200, 'GBP 38,000 is USD 49,400');
});

test('the mock providers take the client’s side of a trade only when it is no better than the quote; configuration is checked', async () => {
  h = await harness();
  for (const [companyId, pair] of [['co_northfield', ['GBP', 'USD']], ['co_castlebrook', ['GBP', 'EUR']]] as const) {
    const company = (await h.stores.directory.getCompany(companyId)) as NonNullable<Awaited<ReturnType<typeof h.stores.directory.getCompany>>>;
    const adapter = await h.registry.forCompany(company);
    const quote = await adapter.createQuote({ kind: 'spot', sellCurrency: pair[0], buyCurrency: pair[1], fixedSide: 'sell', amount: '100.00' });
    const more = new Big(quote.buyAmount).plus('0.01').toFixed(2);
    await assert.rejects(adapter.bookConversion({ quote, idempotencyKey: `better-${companyId}-1`, clientTerms: { sellAmount: quote.sellAmount, buyAmount: more } }), companyId);
    await assert.rejects(adapter.bookConversion({ quote, idempotencyKey: `better-${companyId}-2`, clientTerms: { sellAmount: '99.99', buyAmount: quote.buyAmount } }), companyId);
    const worse = new Big(quote.buyAmount).minus('1.00').toFixed(2);
    const booked = await adapter.bookConversion({ quote, idempotencyKey: `better-${companyId}-3`, clientTerms: { sellAmount: quote.sellAmount, buyAmount: worse } });
    assert.deepEqual([booked.sellAmount, booked.buyAmount], [quote.sellAmount, worse]);
  }
  const dev = (env: Record<string, string>) => loadConfig({ APP_ENV: 'development', ...env });
  assert.deepEqual([dev({}).marginAppliedBy, dev({}).defaultMarginBps, dev({}).rateCacheMs, dev({}).mockMovingRates], [{ currencycloud: 'server', equals: 'server' }, 50, 5000, true]);
  assert.deepEqual(dev({ MARGIN_APPLIED_BY_CURRENCYCLOUD: 'provider', DEFAULT_MARGIN_BPS: '0', MOCK_MOVING_RATES: '0' }).marginAppliedBy, { currencycloud: 'provider', equals: 'server' });
  assert.throws(() => dev({ MARGIN_APPLIED_BY_EQUALS: 'both' }), /MARGIN_APPLIED_BY_EQUALS must be "server"/);
  for (const DEFAULT_MARGIN_BPS of ['-1', '301', '12.5', 'some']) assert.throws(() => dev({ DEFAULT_MARGIN_BPS }), /DEFAULT_MARGIN_BPS must be a whole number/);
  assert.throws(() => dev({ RATE_CACHE_SECONDS: '-1' }), /RATE_CACHE_SECONDS/);
  // Outside development there is no default margin: it has to be said.
  const LIVE = { APP_URL: 'https://app.globalconnect.example', CURRENCYCLOUD_LOGIN_ID: 'a', CURRENCYCLOUD_API_KEY: 'b', EQUALS_API_KEY: 'c', OPS_URL: 'https://ops.globalconnect.example', SERVER_SECRET: 'Zq7Lm2Xv9Rt4Wp8Kd3Nf6Hs1Bg5Yc0JaUeOiTxMn', STAFF_EMAIL_DOMAINS: 'globalconnect.example', DATABASE_PATH: '/nonexistent/gc/data.sqlite', DATA_ENCRYPTION_KEY: 'q0v8Jm3ZxN5rT1yLw7KdP2sHf9BcVe4UaGiXoR6MtYE=' };
  assert.throws(() => loadConfig(LIVE), /DEFAULT_MARGIN_BPS must be set/);
  assert.equal(loadConfig({ ...LIVE, DEFAULT_MARGIN_BPS: '0' }).defaultMarginBps, 0);
});

test('NOT A SECRET, and stated: two held quotes for one pair, one each way, give the provider’s rate and the margin exactly', async () => {
  // Quoting both ways at full precision makes this unavoidable. It is not hidden; the README says so. Nothing in this
  // suite shows the margin cannot be worked out: the scans only show that no field names it and the rate page does not print it.
  h = await harness();
  await setMargin('co_northfield', { defaultBps: 37 });
  const amira = await signedIn(AMIRA);
  const sell = await quoteFor(amira.token, { sellCurrency: 'GBP', buyCurrency: 'USD', fixedSide: 'sell', amount: '100000.00' });
  const buy = await quoteFor(amira.token, { sellCurrency: 'USD', buyCurrency: 'GBP', fixedSide: 'buy', amount: '100000.00' });
  assert.deepEqual([sell.rate, buy.rate], ['1.295190', '1.304810']);
  const [low, high] = [new Big(sell.rate), new Big(buy.rate)];
  assert.equal(high.minus(low).div(high.plus(low)).times(10_000).toFixed(4), '37.0000');
  assert.equal(high.plus(low).div(2).toFixed(6), '1.300000');
});

test('the scan that guards every client response does catch the forbidden fields', async () => {
  // It is applied to what the API really sends: a reply that carries a forbidden word fails the call that got it.
  h = await harness();
  const amira = await signedIn(AMIRA);
  assert.equal((await h.call('GET', '/v1/company', { token: amira.token })).status, 200);
  await h.stores.directory.updateCompany('co_northfield', (company) => ({ ...company, name: 'Wholesale Margin Traders Ltd' }));
  await assert.rejects(h.call('GET', '/v1/company', { token: amira.token }), /sent a client something it must never see/);

  for (const leak of ['{"midRate":"1.3"}', '{"mid":"1.3"}', '{"mid_market_rate":"1.3"}', '{"quote":{"marginBps":50}}', '{"margin":{"defaultBps":50}}', '{"providerRate":"1.3"}', '{"provider_rate":"1.3"}', '{"partner_rate":"1.3"}', '{"core_rate":"1.3"}', '{"revenueAmount":"2.60"}', '{"markup":"0.5"}', '{"spread":"0.5"}', '{"bps":50}', '{"wholesaleRate":"1"}', '{"appliedBy":"server"}', '{"error":{"message":"margin could not be worked out"}}', '{"note":"mid-market rate"}', '{"note":"50 basis points"}']) {
    assert.notEqual(forbiddenInClientResponse(leak), null, leak);
  }
  // TWO NUMBERS THAT GIVE THE MARGIN AWAY: a sell and a buy rate whose spread is exactly a margin in force (here the 50 bp default) fail too...
  assert.match((await marginReadableFrom('{"base":"GBP","quote":"USD","rate":"1.2935","buyRate":"1.3065","indicative":true}', h.stores, h.config)) ?? '', /is exactly 50 bp/);
  // ...what the server really sends for that rate does not; nor does a figure that only happens to be near another margin.
  assert.equal(await marginReadableFrom('{"base":"GBP","quote":"USD","rate":"1.2934","buyRate":"1.3065","indicative":true}', h.stores, h.config), null);
  assert.equal(await marginReadableFrom('{"rate":"1.2896","buyRate":"1.3104"}', h.stores, h.config), null, '80 bp is not in force anywhere');
  await h.stores.margins.put('co_castlebrook', { defaultBps: 80, forwardBps: null, overrides: [], tiers: [], tierCurrency: 'GBP', companyId: 'co_castlebrook', updatedAt: 1, updatedBy: 't', approvedBy: null });
  assert.match((await marginReadableFrom('{"rate":"1.2896","buyRate":"1.3104"}', h.stores, h.config)) ?? '', /is exactly 80 bp/);
  // And it is applied to what the API really sends: every rate reply in every test went through it (this call would have thrown).
  assert.equal((await h.call('GET', '/v1/rates/GBP/USD', { token: (await signedIn(BEN)).token })).status, 200);
  for (const fine of ['{"rate":"1.2934","buyRate":"1.3065","indicative":true}', '{"paymentId":"p1","itemId":"x"}', '{"kind":"server"}']) assert.equal(forbiddenInClientResponse(fine), null, fine);
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
