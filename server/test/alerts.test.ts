/**
 * Rate alerts kept and checked by the server: against the CLIENT's rate, once, and never twice across a crash or
 * a restart. (Notifications about payments are in approvals.test.ts.)
 */
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import { RateAlerts } from '../src/alerts/service';
import { loadConfig } from '../src/config';
import { isProviderError } from '@/api/errors';
import { AMIRA, BEN, DANA, harness, type Harness } from './helpers';

let h: Harness;
afterEach(async () => {
  await h?.close();
});

async function signedIn(email: string, companyId?: string): Promise<{ token: string; id: string; email: string }> {
  const { secret } = await h.activate(email);
  secrets.set(email, secret);
  const reply = await h.login(email, secret);
  assert.equal(reply.status, 200);
  const token = reply.json.token as string;
  if (companyId) assert.equal((await h.call('POST', '/v1/session/company', { token, body: { companyId } })).status, 200);
  return { token, id: (await h.stores.directory.findUserByEmail(email))?.id as string, email };
}
/** Signs an already activated person in again (after the clock has moved past the session's idle time). */
const secrets = new Map<string, string>();
async function signedIn2(email: string): Promise<string> {
  const reply = await h.login(email, secrets.get(email) as string);
  assert.equal(reply.status, 200);
  return reply.json.token as string;
}
const setMargin = (companyId: string, defaultBps: number) => h.stores.margins.put(companyId, { defaultBps, forwardBps: null, overrides: [], tiers: [], tierCurrency: 'GBP', companyId, updatedAt: h.clock.now, updatedBy: 'test@globalconnect.example', approvedBy: null });
const newAlert = (token: string, body: Record<string, unknown>) => h.call('POST', '/v1/alerts', { token, body: { base: 'GBP', quote: 'USD', side: 'sell', targetRate: '1.2950', ...body } });
const alertsOf = async (token: string) => (await h.call('GET', '/v1/alerts', { token })).json.items as { id: string; status: string; triggeredRate: string | null; triggeredAt: string | null; side: string; targetRate: string }[];
const notesOf = async (token: string) => (await h.call('GET', '/v1/notifications', { token })).json as { unread: number; items: { id: string; title: string; body: string; category: string; read: boolean }[] };
const alertMails = (email: string) => h.outbox.sent.filter((message) => message.to === email && /rate alert/i.test(message.subject));
const audit = (action: string) => h.stores.audit.query({ action, limit: 10_000 });

test('an alert is checked against the client’s own rate, fires once, says the rate is indicative, and is armed again only by its owner', async () => {
  h = await harness();
  const amira = await signedIn(AMIRA);
  const ben = await signedIn(BEN);

  // Amira's rate to sell GBP for USD is 1.2935 (1.3000 at the provider, less the 50 bp sample margin). 1.2950 is not reached.
  const created = await newAlert(amira.token, {});
  assert.equal(created.status, 200, JSON.stringify(created.json));
  assert.deepEqual(Object.keys(created.json).sort(), ['base', 'createdAt', 'id', 'quote', 'side', 'status', 'targetRate', 'triggeredAt', 'triggeredRate']);
  assert.deepEqual([created.json.status, created.json.side, created.json.targetRate], ['active', 'sell', '1.295']);
  // Ben, in another company, wants the same.
  assert.equal((await newAlert(ben.token, {})).status, 200);
  assert.equal(await h.alerts.check(), 0);
  assert.equal((await notesOf(amira.token)).items.length, 0);
  // The PROVIDER's rate (1.3000) is above the target; an alert checked against that would have fired. It did not.
  assert.equal((await alertsOf(amira.token))[0]?.status, 'active');

  // Amira's company gets a smaller margin: her rate becomes 1.2974. Her alert fires; Ben's (still 1.2935) does not.
  await setMargin('co_northfield', 20);
  assert.equal(await h.alerts.check(), 1);
  const [fired] = await alertsOf(amira.token);
  assert.deepEqual([fired?.status, fired?.triggeredRate, fired?.triggeredAt], ['triggered', '1.2973', new Date(h.clock.now).toISOString()]);
  assert.equal((await alertsOf(ben.token))[0]?.status, 'active');
  const notes = await notesOf(amira.token);
  assert.equal(notes.unread, 1);
  assert.deepEqual([notes.items[0]?.category, notes.items[0]?.title, notes.items[0]?.read], ['rates', 'Rate alert: GBP/USD', false]);
  assert.match(notes.items[0]?.body ?? '', /^Your rate to sell GBP for USD reached 1\.2973 when we checked at 2026-11-11 10:\d\d UTC\. Your alert was set at 1\.295 or better\.\nThis rate is indicative: it is not held for you and it may have moved since\. To convert, open the app and get a rate there\.\nThis alert has now stopped\./);
  assert.equal(alertMails(amira.email).length, 1);
  assert.match(alertMails(amira.email)[0]?.text ?? '', /Your rate to sell GBP for USD reached 1\.2973/);
  assert.doesNotMatch(`${alertMails(amira.email)[0]?.subject} ${alertMails(amira.email)[0]?.text}`, /1\.3000|guarantee|will be|held for you until/);
  assert.equal((await notesOf(ben.token)).items.length, 0);
  assert.equal(alertMails(ben.email).length, 0);

  // ONCE. Checked again and again, nothing more happens.
  for (let index = 0; index < 5; index += 1) {
    h.clock.advance(60_000);
    assert.equal(await h.alerts.check(), 0);
  }
  assert.equal((await notesOf(amira.token)).items.length, 1);
  assert.equal(alertMails(amira.email).length, 1);
  const trail = await audit('client.alert.triggered');
  assert.deepEqual([trail.length, trail[0]?.target?.label, trail[0]?.detail.rate, trail[0]?.detail.pair], [1, AMIRA, '1.2973', 'GBPUSD']);

  // Armed again by its owner (explicitly): it fires again, once.
  const again = await h.call('POST', `/v1/alerts/${fired?.id}`, { token: amira.token, body: { enabled: true } });
  assert.deepEqual([again.status, again.json.status, again.json.triggeredRate], [200, 'active', null]);
  assert.equal(await h.alerts.check(), 1);
  assert.equal(await h.alerts.check(), 0);
  assert.equal((await notesOf(amira.token)).items.length, 2);
  assert.equal(alertMails(amira.email).length, 2);
  // Paused, it is not looked at.
  await h.call('POST', `/v1/alerts/${fired?.id}`, { token: amira.token, body: { enabled: true } });
  assert.equal((await h.call('POST', `/v1/alerts/${fired?.id}`, { token: amira.token, body: { enabled: false } })).json.status, 'paused');
  assert.equal(await h.alerts.check(), 0);

  // BUY: fires when the rate to buy GBP is at or BELOW the target (1.3026 here, 20 bp over the provider's 1.3000).
  const low = await newAlert(amira.token, { side: 'buy', targetRate: '1.3020' });
  const reached = await newAlert(amira.token, { side: 'buy', targetRate: '1.3026' });
  assert.equal(await h.alerts.check(), 1);
  const mine = await alertsOf(amira.token);
  assert.equal(mine.find((item) => item.id === low.json.id)?.status, 'active');
  assert.deepEqual([mine.find((item) => item.id === reached.json.id)?.status, mine.find((item) => item.id === reached.json.id)?.triggeredRate], ['triggered', '1.3026']);
  assert.match((await notesOf(amira.token)).items[0]?.body ?? '', /^Your rate to buy GBP with USD reached 1\.3026/);

  // Marking as read: one's own, by id or all at once; the badge follows.
  const list = await notesOf(amira.token);
  assert.equal(list.unread, 3);
  assert.deepEqual((await h.call('POST', '/v1/notifications/read', { token: amira.token, body: { id: list.items[0]?.id } })).json, { ok: true, unread: 2 });
  // Somebody else's id changes nothing for either person.
  assert.deepEqual((await h.call('POST', '/v1/notifications/read', { token: ben.token, body: { id: list.items[1]?.id } })).json, { ok: true, unread: 0 });
  assert.equal((await notesOf(amira.token)).unread, 2);
  assert.deepEqual((await h.call('POST', '/v1/notifications/read', { token: amira.token, body: {} })).json, { ok: true, unread: 0 });
  assert.ok((await notesOf(amira.token)).items.every((item) => item.read));
  // The audit log says who was told and which kind; never what it said.
  const told = await audit('notification');
  assert.equal(told.length, 3);
  assert.deepEqual([told[0]?.target?.label, told[0]?.detail], [AMIRA, { kind: 'rate_alert', category: 'rates', email: 'sent' }]);
  assert.doesNotMatch(JSON.stringify(told), /1\.29|1\.30|reached|indicative/);
});

test('alerts do not fire twice across a crash or a restart; one rate fetch per pair per check however many alerts want it', async () => {
  h = await harness({ rateCacheMs: 0 });
  const amira = await signedIn(AMIRA);
  const dana = await signedIn(DANA, 'co_northfield');
  await setMargin('co_northfield', 20);
  for (const who of [amira, dana]) {
    assert.equal((await newAlert(who.token, {})).status, 200);
    assert.equal((await newAlert(who.token, { targetRate: '1.2960' })).status, 200);
    assert.equal((await newAlert(who.token, { base: 'GBP', quote: 'EUR', targetRate: '9' })).status, 200);
  }
  // A CRASH after the notification was made and before the alert was marked: the first write to the alerts table fails.
  const original = h.stores.alerts.mutate.bind(h.stores.alerts);
  let failures = 1;
  h.stores.alerts.mutate = (async (...args: Parameters<typeof original>) => {
    if (failures > 0) {
      failures -= 1;
      throw new Error('crash');
    }
    return original(...args);
  }) as typeof original;
  const fetches = () => h.providerA.seen.filter((item) => item.path === '/v2/rates/find').length;
  const before = fetches();
  assert.equal(await h.alerts.check(), 0, 'the check stopped at the crash');
  assert.equal((await notesOf(amira.token)).items.length + (await notesOf(dana.token)).items.length, 1, 'one notification had been made');
  assert.ok(h.logs.some((line) => /rate alert check failed/.test(line)));
  // After the "restart": a new evaluator over the same database. Every due alert fires; the one already notified is not notified again.
  h.stores.alerts.mutate = original;
  const restarted = new RateAlerts({ stores: h.stores, rates: h.rates, notifier: h.notifier, now: () => h.clock.now, perUser: 20, withProvider: async (company, run) => run(await h.registry.forCompany(company)) });
  const middle = fetches();
  const listMembers = h.stores.directory.listMembers.bind(h.stores.directory);
  let memberReads = 0;
  h.stores.directory.listMembers = async (companyId) => {
    memberReads += 1;
    return listMembers(companyId);
  };
  assert.equal(await restarted.check(), 4);
  // ...and the company's members are read ONCE for the check, not once per alert.
  assert.equal(memberReads, 1);
  h.stores.directory.listMembers = listMembers;
  // Six alerts on two pairs, two people: TWO rate fetches for the whole check.
  assert.equal(fetches() - middle, 2);
  assert.ok(middle - before <= 2);
  assert.equal(await restarted.check(), 0);
  assert.equal(await h.alerts.check(), 0);
  for (const who of [amira, dana]) {
    assert.equal((await notesOf(who.token)).items.length, 2, who.email);
    assert.equal(alertMails(who.email).length, 2, who.email);
    assert.deepEqual((await alertsOf(who.token)).map((item) => item.status), ['triggered', 'triggered', 'active']);
  }
  // Two checks at once do not both run.
  await h.call('POST', `/v1/alerts/${(await alertsOf(amira.token))[0]?.id}`, { token: amira.token, body: { enabled: true } });
  assert.deepEqual((await Promise.all([h.alerts.check(), h.alerts.check(), h.alerts.check()])).sort(), [0, 0, 1]);
  assert.equal((await notesOf(amira.token)).items.length, 3);

  // A person who is disabled, or no longer in the company, is not told; the provider being down skips the check, quietly.
  await h.call('POST', `/v1/alerts/${(await alertsOf(dana.token))[0]?.id}`, { token: dana.token, body: { enabled: true } });
  await h.stores.directory.removeMembership(dana.id, 'co_northfield');
  assert.equal(await h.alerts.check(), 0);
  assert.equal(alertMails(dana.email).length, 2);
  await h.stores.directory.setMembership({ userId: dana.id, companyId: 'co_northfield', role: 'approver' });
  const request = h.providerA.request.bind(h.providerA);
  h.providerA.request = async (input) => {
    if (input.path === '/v2/rates/find') throw new TypeError('Network request failed');
    return request(input);
  };
  assert.equal(await h.alerts.check(), 0);
  h.providerA.request = request;
  assert.equal(await h.alerts.check(), 1);
});

test('alerts belong to one person in one company: a cap per person, validation, and nobody else can see, change or delete them', async () => {
  h = await harness({ alertsPerUser: 3 });
  const amira = await signedIn(AMIRA);
  const ben = await signedIn(BEN);
  for (const [body, field] of [[{ base: 'GBP', quote: 'GBP' }, 'currency'], [{ targetRate: '0' }, 'targetRate'], [{ targetRate: '-1.2' }, 'targetRate'], [{ targetRate: '1.2345678' }, 'targetRate'], [{ targetRate: 'high' }, 'targetRate'], [{ targetRate: '1e3' }, 'targetRate']] as const) {
    const reply = await newAlert(amira.token, body);
    assert.equal(reply.status, 400, JSON.stringify(body));
    assert.deepEqual(reply.json.error.fields, [field], JSON.stringify(body));
  }
  for (const body of [{ side: 'above' }, { base: 'GB' }, { extra: 'x' }]) assert.equal((await newAlert(amira.token, body)).status, 400, JSON.stringify(body));
  // A pair the provider has no rate for is refused, not stored to be checked for ever.
  assert.notEqual((await newAlert(amira.token, { quote: 'ZZZ' })).status, 200);
  assert.equal((await alertsOf(amira.token)).length, 0);

  // The cap, even when requests arrive together.
  const many = await Promise.all(Array.from({ length: 6 }, (_, index) => newAlert(amira.token, { targetRate: `1.4${index}` })));
  assert.deepEqual(many.map((reply) => reply.status).sort(), [200, 200, 200, 400, 400, 400]);
  assert.deepEqual(many.find((reply) => reply.status === 400)?.json, { error: { kind: 'validation', reason: 'too_many_alerts' } });
  const mine = await alertsOf(amira.token);
  assert.equal(mine.length, 3);
  assert.equal((await audit('client.alert.create')).length, 3);

  // ...and when they reach the service at the very same moment (the rate they all wait for is one shared answer).
  const benUser = (await h.stores.directory.getUser(ben.id)) as NonNullable<Awaited<ReturnType<typeof h.stores.directory.getUser>>>;
  const castlebrook = (await h.stores.directory.getCompany('co_castlebrook')) as NonNullable<Awaited<ReturnType<typeof h.stores.directory.getCompany>>>;
  await h.call('GET', '/v1/rates/GBP/USD', { token: ben.token });
  const together = await Promise.allSettled(Array.from({ length: 6 }, (_, index) => h.alerts.create(benUser, castlebrook, { base: 'GBP', quote: 'USD', side: 'sell', targetRate: `1.5${index}` }, 'test')));
  assert.equal(together.filter((result) => result.status === 'fulfilled').length, 3);
  assert.equal((await h.stores.alerts.count({ userId: ben.id })), 3);
  for (const item of await h.stores.alerts.list({ userId: ben.id })) await h.stores.alerts.delete(item.id);

  // Ben sees none of them and can do nothing to them.
  assert.deepEqual(await alertsOf(ben.token), []);
  assert.equal((await h.call('POST', `/v1/alerts/${mine[0]?.id}`, { token: ben.token, body: { enabled: false } })).status, 404);
  assert.equal((await h.call('POST', `/v1/alerts/${mine[0]?.id}/delete`, { token: ben.token })).status, 404);
  assert.deepEqual((await alertsOf(amira.token)).map((item) => item.status), ['active', 'active', 'active']);
  // In another of her own companies Dana's alerts are separate too (an alert is for the company it was made in).
  const dana = await signedIn(DANA, 'co_northfield');
  assert.equal((await newAlert(dana.token, {})).status, 200);
  assert.equal((await h.call('POST', '/v1/session/company', { token: dana.token, body: { companyId: 'co_castlebrook' } })).status, 200);
  assert.deepEqual(await alertsOf(dana.token), []);

  // Her own: deleted, and then there is room for another.
  assert.deepEqual((await h.call('POST', `/v1/alerts/${mine[0]?.id}/delete`, { token: amira.token })).json, { ok: true });
  assert.equal((await h.call('POST', `/v1/alerts/${mine[0]?.id}/delete`, { token: amira.token })).status, 404);
  assert.equal((await newAlert(amira.token, {})).status, 200);
  assert.equal((await audit('client.alert.delete')).length, 1);
  assert.equal((await h.call('GET', '/v1/alerts', {})).status, 401);
  assert.equal((await h.call('GET', '/v1/notifications', {})).status, 401);

  const dev = (env: Record<string, string>) => loadConfig({ APP_ENV: 'development', ...env });
  assert.deepEqual([dev({}).alertCheckMs, dev({}).alertsPerUser, dev({}).paymentExpiryWarningMs, dev({}).notificationsPerUserPerHour], [60_000, 20, 6 * 60 * 60_000, 60]);
  assert.equal(dev({ ALERT_CHECK_SECONDS: '15', PAYMENT_EXPIRY_WARNING_HOURS: '1.5' }).alertCheckMs, 15_000);
  for (const [name, value] of [['ALERT_CHECK_SECONDS', '1'], ['ALERTS_PER_USER', '0'], ['PAYMENT_EXPIRY_WARNING_HOURS', '-1'], ['NOTIFICATIONS_PER_USER_PER_HOUR', 'lots']] as const) assert.throws(() => dev({ [name]: value }), new RegExp(name));
  assert.ok(isProviderError);
});

test('an alert whose notification was held back is NOT marked as fired: it is tried again at the next check', async () => {
  h = await harness({ notificationsPerUserPerHour: 1 });
  const amira = await signedIn(AMIRA);
  await setMargin('co_northfield', 20);
  // Two alerts, both reached at once; one notification an hour is all this person may be sent.
  assert.equal((await newAlert(amira.token, {})).status, 200);
  assert.equal((await newAlert(amira.token, { targetRate: '1.2960' })).status, 200);
  assert.equal(await h.alerts.check(), 1);
  assert.deepEqual((await alertsOf(amira.token)).map((item) => item.status), ['triggered', 'active']);
  assert.equal((await notesOf(amira.token)).items.length, 1);
  // Still held back: still on, however often it is checked.
  assert.equal(await h.alerts.check(), 0);
  assert.equal((await alertsOf(amira.token))[1]?.status, 'active');
  // When the hour has passed, it fires: nothing was lost.
  h.clock.advance(60 * 60_000 + 1);
  const again = await signedIn2(AMIRA);
  assert.equal(await h.alerts.check(), 1);
  assert.deepEqual((await alertsOf(again)).map((item) => item.status), ['triggered', 'triggered']);
  assert.equal((await notesOf(again)).items.length, 2);
  assert.equal(alertMails(AMIRA).length, 2);
});
