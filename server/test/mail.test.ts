/** Email: the templates, the SMTP transport against a fake mail server in this process, the outbox (retry, limits, idempotency) and the ops Mail page. */
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import { loadConfig } from '../src/config';
import { ConsoleOutbox } from '../src/mailer';
import { MAIL_BACKOFF_MS, MAIL_MAX_ATTEMPTS, MailQueue } from '../src/mail/queue';
import { SmtpMailer, failureCode } from '../src/mail/smtp';
import { activationMail, MAIL_FOOTER, render, SECURITY_NOTICES, TEMPLATES, type TemplateName } from '../src/mail/templates';
import { createRuntime } from '../src/startup';
import { harness, type Harness } from './helpers';
import { FakeSmtp } from './support/smtp';

let h: Harness | undefined;
let smtp: FakeSmtp | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
  await smtp?.stop();
  smtp = undefined;
});

const APP = 'https://app.globalconnect.example';
const OPS = 'https://ops.globalconnect.example';
const LINK = `${APP}/activate#code=ABCDE-FGHIJ-KLMNO-PQRST`;
const settings = (port: number, extra: Record<string, string> = {}) => loadConfig({ APP_ENV: 'development', SMTP_HOST: '127.0.0.1', SMTP_PORT: String(port), SMTP_TLS: 'off', MAIL_FROM: 'no-reply@globalconnect.example', MAIL_REPLY_TO: 'help@globalconnect.example', ...extra }).smtp as NonNullable<ReturnType<typeof loadConfig>['smtp']>;

/** One of each template, with values that would be embarrassing in a subject line. Adding a template without adding it here does not compile. */
const SAMPLES: { [N in TemplateName]: Parameters<(typeof TEMPLATES)[N]>[0] } = {
  'activation.client': { name: 'Amira Shah', link: LINK, expiresAt: 0 },
  'activation.staff': { name: 'Amira Shah', link: `${OPS}/ops/activate#code=ABCDE-FGHIJ-KLMNO-PQRST`, expiresAt: 0 },
  'reset.client': { name: 'Amira Shah', link: `${APP}/reset#code=ABCDE-FGHIJ-KLMNO-PQRST`, expiresAt: 0 },
  'reset.staff': { name: 'Amira Shah', link: `${OPS}/ops/reset#code=ABCDE-FGHIJ-KLMNO-PQRST`, expiresAt: 0 },
  'security.notice': { name: 'Amira Shah', audience: 'client', kind: 'password_changed', at: 0 },
};
/** Every variant of every template: each security notice is its own wording. */
const VARIANTS: [TemplateName, unknown][] = (Object.keys(TEMPLATES) as TemplateName[]).flatMap((name): [TemplateName, unknown][] =>
  name === 'security.notice' ? (Object.keys(SECURITY_NOTICES) as (keyof typeof SECURITY_NOTICES)[]).flatMap((kind) => (['client', 'staff'] as const).map((audience): [TemplateName, unknown] => [name, { name: 'Amira Shah', audience, kind, at: 0, until: 86_400_000 }])) : [[name, SAMPLES[name]]],
);

/** A queue over a harness's database, sending through `transport`, on the harness's clock. */
function queueOf(transport: ConstructorParameters<typeof MailQueue>[0]['transport'], extra: Partial<ConstructorParameters<typeof MailQueue>[0]> = {}): MailQueue {
  const harnessed = h as Harness;
  return new MailQueue({ table: harnessed.stores.mail, audit: harnessed.stores.audit, transport, now: () => harnessed.clock.now, links: [APP, OPS], domain: 'globalconnect.example', perRecipientPerHour: 5, globalPerHour: 12, delivery: 'background', ...extra });
}
const request = (n: number, to = 'amira@northfield.example') => activationMail({ activationLink: `${LINK}${n}`, expiresAt: 0 }, to, 'Amira Shah', 'client');
const rows = async () => (h as Harness).stores.mail.list();

test('templates: every message has a harmless subject, the same lines as text and as simple HTML, the placeholder footer, and links only to this server', () => {
  for (const [name, sample] of VARIANTS) {
    const mail = render(name, sample as never, [APP, OPS]);
    // Only an activation or a reset email carries a link; a notice never does.
    assert.equal(/https?:/.test(mail.text), name.startsWith('activation.') || name.startsWith('reset.'), name);
    // Subject: the brand, and nothing about the person, the money or the secret.
    assert.match(mail.subject, /Global Connect/, name);
    assert.doesNotMatch(mail.subject, /Amira|Harbour|125|GBP|ABCDE|code|https?:|[\r\n]/, name);
    assert.ok(mail.subject.length <= 78, name);
    // Text: ends with the placeholder footer, which is still a bracketed placeholder.
    assert.ok(mail.text.endsWith(`\n--\n${MAIL_FOOTER}`), name);
    assert.match(MAIL_FOOTER, /^\[.*\]$/);
    // HTML: nothing loaded from anywhere, nothing that runs, no styling tricks; the same words as the text.
    assert.doesNotMatch(mail.html, /<img|<script|<link|<iframe|<style|<form|src=|url\(|onload|@import|<meta http-equiv/i, name);
    const words = (text: string) => text.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, ' ').trim();
    assert.equal(words(mail.html.replace(/<title>[^<]*<\/title>/, '')), words(mail.text), name);
    // Every web address in it is this server's.
    for (const url of `${mail.text}\n${mail.html}`.match(/https?:\/\/[^\s"<]+/g) ?? []) assert.ok(url.startsWith(APP) || url.startsWith(OPS), `${name}: ${url}`);
    // The brand, exactly.
    assert.doesNotMatch(`${mail.subject}\n${mail.text}`.replace(/https?:\/\/\S+/g, ''), /GlobalConnect|Global Connect FX|Currencycloud|Equals/i, name);
  }
  // A link to anywhere else is refused, however it is dressed up; so is a web address smuggled into a line of text.
  for (const link of ['https://evil.example/activate#code=X', `${APP}.evil.example/x`, `${APP}@evil.example/`, 'javascript:alert(1)', `${APP}/a b`, `${APP}/"><img src=x>`]) {
    assert.throws(() => render('activation.client', { name: 'A', link, expiresAt: 0 }, [APP, OPS]), /does not point at this server/, link);
  }
  assert.throws(() => render('activation.client', { name: 'see https://evil.example now', link: LINK, expiresAt: 0 }, [APP, OPS]), /web address in its text/);
  // What a person typed is one line, and is text, never markup.
  const hostile = render('activation.client', { name: 'Eve\r\nBcc: x@evil.example <b onmouseover=x>"&', link: LINK, expiresAt: 0 }, [APP, OPS]);
  assert.equal(hostile.text.split('\n')[0], 'Hello Eve Bcc: x@evil.example <b onmouseover=x>"&,');
  assert.match(hostile.html, /Hello Eve Bcc: x@evil\.example &lt;b onmouseover=x&gt;&quot;&amp;,/);
  assert.doesNotMatch(hostile.html, /<b /);
});

test('configuration: SMTP needs a from-address and TLS; without TLS only a mail server on this machine in development; strict accepts SMTP as its mailer and still refuses mock providers', () => {
  const dev = (env: Record<string, string>) => loadConfig({ APP_ENV: 'development', ...env });
  assert.equal(dev({}).smtp, null);
  assert.deepEqual(dev({ SMTP_HOST: 'smtp.mail.example', MAIL_FROM: 'no-reply@globalconnect.example', SMTP_USERNAME: 'u', SMTP_PASSWORD: 'p' }).smtp, { host: 'smtp.mail.example', port: 587, tls: 'starttls', username: 'u', password: 'p', from: 'no-reply@globalconnect.example', replyTo: null });
  assert.equal(dev({ SMTP_HOST: 'smtp.mail.example', SMTP_PORT: '465', MAIL_FROM: 'a@b.example' }).smtp?.tls, 'tls');
  assert.throws(() => dev({ SMTP_HOST: 'smtp.mail.example' }), /MAIL_FROM must be set/);
  for (const MAIL_FROM of ['Global Connect <a@b.example>', 'a@b.example\r\nBcc: x@y.example', 'a@b', 'a b@c.example']) assert.throws(() => dev({ SMTP_HOST: 'smtp.mail.example', MAIL_FROM }), /MAIL_FROM/, MAIL_FROM);
  assert.throws(() => dev({ SMTP_HOST: 'smtp.mail.example', MAIL_FROM: 'a@b.example', MAIL_REPLY_TO: 'x\ny@z.example' }), /MAIL_REPLY_TO/);
  assert.throws(() => dev({ SMTP_HOST: 'smtp.mail.example', MAIL_FROM: 'a@b.example', SMTP_USERNAME: 'u' }), /SMTP_PASSWORD/);
  assert.throws(() => dev({ SMTP_HOST: 'smtp.mail.example', MAIL_FROM: 'a@b.example', SMTP_TLS: 'none' }), /SMTP_TLS must be/);
  // No TLS: never to another machine, and never outside development.
  assert.throws(() => dev({ SMTP_HOST: 'smtp.mail.example', MAIL_FROM: 'a@b.example', SMTP_TLS: 'off' }), /SMTP_TLS=off is refused/);
  assert.equal(dev({ SMTP_HOST: '127.0.0.1', MAIL_FROM: 'a@b.example', SMTP_TLS: 'off' }).smtp?.tls, 'off');
  const LIVE = { CURRENCYCLOUD_LOGIN_ID: 'a', CURRENCYCLOUD_API_KEY: 'b', EQUALS_API_KEY: 'c', OPS_URL: OPS, SERVER_SECRET: 'Zq7Lm2Xv9Rt4Wp8Kd3Nf6Hs1Bg5Yc0JaUeOiTxMn', STAFF_EMAIL_DOMAINS: 'globalconnect.example', DATABASE_PATH: '/nonexistent/gc/data.sqlite', DATA_ENCRYPTION_KEY: 'q0v8Jm3ZxN5rT1yLw7KdP2sHf9BcVe4UaGiXoR6MtYE=' };
  assert.throws(() => loadConfig({ ...LIVE, SMTP_HOST: '127.0.0.1', MAIL_FROM: 'a@b.example', SMTP_TLS: 'off' }), /SMTP_TLS=off is refused/);
  // Outside development: no mailer, no start; with SMTP the mailer is real, and the server then stops at the mock providers, as before.
  assert.throws(() => createRuntime(loadConfig(LIVE)), /No mailer is configured[^]*SMTP_HOST/);
  assert.throws(() => createRuntime(loadConfig({ ...LIVE, SMTP_HOST: 'smtp.mail.example', MAIL_FROM: 'no-reply@globalconnect.example' })), /Refusing to start: currencycloud and equals would be served by an in-memory MOCK/);
});

test('SMTP: a message is delivered to a mail server with the configured sender, reply-to and credentials, as text and HTML, with nothing that reports back', async () => {
  smtp = new FakeSmtp();
  smtp.credentials = { user: 'gc-user', pass: 'gc-pass word' };
  const port = await smtp.start();
  const mailer = new SmtpMailer(settings(port, { SMTP_USERNAME: 'gc-user', SMTP_PASSWORD: 'gc-pass word' }));
  const mail = render('activation.client', { name: 'Amira Shah', link: LINK, expiresAt: 0 }, [APP, OPS]);
  await mailer.send({ to: 'amira@northfield.example', ...mail, messageId: '<mail_abc@globalconnect.example>' });
  assert.equal(smtp.received.length, 1);
  const got = smtp.received[0] as NonNullable<(typeof smtp.received)[number]>;
  assert.deepEqual([got.from, got.to, got.auth], ['no-reply@globalconnect.example', ['amira@northfield.example'], 'gc-user']);
  assert.match(got.data, /^From: no-reply@globalconnect\.example\r$/m);
  assert.match(got.data, /^Reply-To: help@globalconnect\.example\r$/m);
  assert.match(got.data, /^Subject: Activate your Global Connect account\r$/m);
  assert.match(got.data, /^Message-ID: <mail_abc@globalconnect\.example>\r$/m);
  assert.match(got.data, /Content-Type: multipart\/alternative/);
  assert.match(got.data, /Content-Type: text\/plain/);
  assert.match(got.data, /Content-Type: text\/html/);
  assert.ok(got.data.replace(/=\r\n/g, '').replace(/=3D/g, '=').includes('activate#code=ABCDE-FGHIJ-KLMNO-PQRST'));
  // Nothing that asks for a receipt or a read notification, and no trace of a tracking image or attachment.
  assert.doesNotMatch(got.data, /Disposition-Notification-To|Return-Receipt-To|X-Confirm-Reading-To|Content-Disposition: attachment|<img/i);
  // TLS is required: a server that cannot upgrade the connection gets no message, not a message in clear.
  const count = smtp.received.length;
  for (const tls of ['starttls', 'tls'] as const) {
    const strict = new SmtpMailer({ ...settings(port, { SMTP_USERNAME: 'gc-user', SMTP_PASSWORD: 'gc-pass word' }), tls });
    await assert.rejects(strict.send({ to: 'amira@northfield.example', ...mail }), tls);
  }
  assert.equal(smtp.received.length, count);
  // Wrong credentials, and a server that is not there: a short code, never the message.
  const wrong = new SmtpMailer(settings(port, { SMTP_USERNAME: 'gc-user', SMTP_PASSWORD: 'nope' }));
  const failure = await wrong.send({ to: 'amira@northfield.example', ...mail }).then(() => null, (error: unknown) => error);
  assert.equal(failureCode(failure), 'EAUTH 535');
  await smtp.stop();
  const gone = await mailer.send({ to: 'amira@northfield.example', ...mail }).then(() => null, (error: unknown) => error);
  assert.match(failureCode(gone), /^(ECONNREFUSED|ESOCKET|ECONNECTION)$/);
  assert.doesNotMatch(failureCode(Object.assign(new Error(`secret ${LINK}`), { code: `x ${LINK}` })), /ABCDE|http/);
});

test('outbox: the request only writes; a mail-server hiccup loses nothing and sends nothing twice; attempts are bounded and a final failure is on record', async () => {
  smtp = new FakeSmtp();
  const port = await smtp.start();
  h = await harness();
  const errors: string[] = [];
  const queue = queueOf(new SmtpMailer(settings(port)), { onError: (message) => void errors.push(message) });

  // The mail server answers "try later": the request is not failed, the message waits.
  smtp.fault = 'reject';
  assert.equal(await queue.enqueue(request(1)), 'queued');
  await queue.pump();
  assert.deepEqual((await rows()).map((row) => [row.status, row.attempts, row.lastError]), [['queued', 1, 'EMESSAGE 451']]);
  // The body is in the database only encrypted, and never in the audit log.
  const raw = JSON.stringify(h.stores.db.all('SELECT data FROM mail_outbox'));
  assert.ok(!raw.includes('ABCDE-FGHIJ') && !raw.includes('Amira Shah') && raw.includes('gcm1:'));
  // Asked for again (a retried request, a resumed approval): still one message.
  assert.equal(await queue.enqueue(request(1)), 'duplicate');
  assert.equal((await rows()).length, 1);
  // Not before its time...
  await queue.pump();
  h.clock.advance(MAIL_BACKOFF_MS[0] as number - 1000);
  await queue.pump();
  assert.equal(smtp.deliveries, 1);
  // ...and then once, however many passes run at that moment.
  smtp.fault = null;
  h.clock.advance(1000);
  await Promise.all([queue.pump(), queue.pump(), queueOf(new SmtpMailer(settings(port))).pump()]);
  await queue.pump();
  assert.equal(smtp.received.length, 1);
  assert.deepEqual((await rows()).map((row) => [row.status, row.attempts, row.body, row.lastError]), [['sent', 2, null, null]]);
  assert.match(smtp.received[0]?.data ?? '', /^Message-ID: <mail_[\w-]+@globalconnect\.example>\r$/m);

  // The connection is cut after the message was handed over: the server cannot know it arrived. It is sent again
  // (the same Message-ID), not lost. This is the one case in which a message can arrive twice.
  smtp.fault = 'drop';
  await queue.enqueue(request(2));
  await queue.pump();
  smtp.fault = null;
  h.clock.advance(MAIL_BACKOFF_MS[0] as number);
  await queue.pump();
  const twice = smtp.received.slice(1).map((item) => /^Message-ID: (.*)\r$/m.exec(item.data)?.[1]);
  assert.equal(twice.length, 2);
  assert.equal(twice[0], twice[1]);

  // A process that died while sending: at the next start that message is due again, once.
  smtp.fault = 'reject';
  await queue.enqueue(request(3));
  await queue.pump();
  smtp.fault = null;
  await h.stores.mail.mutate((await rows()).find((row) => row.status === 'queued')?.key as string, (current) => (current ? { ...current, status: 'sending', attempts: 1, attemptAt: h?.clock.now ?? 0 } : undefined));
  const restarted = queueOf(new SmtpMailer(settings(port)));
  await restarted.pump();
  assert.equal(smtp.received.length, 3, 'a message being sent is not taken by another pass');
  await restarted.recover();
  await restarted.pump();
  await restarted.pump();
  assert.equal(smtp.received.length, 4);

  // A mail server that never recovers: tried a bounded number of times, with growing waits, then failed and recorded.
  smtp.fault = 'reject';
  await queue.enqueue(request(4));
  const before = smtp.deliveries;
  for (let n = 0; n < MAIL_MAX_ATTEMPTS + 3; n += 1) {
    await queue.pump();
    h.clock.advance(3 * 60 * 60_000);
  }
  assert.equal(smtp.deliveries - before, MAIL_MAX_ATTEMPTS);
  const failed = (await rows()).find((row) => row.status === 'failed');
  assert.deepEqual([failed?.attempts, failed?.lastError, failed?.body], [MAIL_MAX_ATTEMPTS, 'EMESSAGE 451', null]);
  const entries = await h.stores.audit.query({ action: 'system.mail.failed' });
  assert.deepEqual(entries.map((entry) => [entry.detail.mail, entry.detail.template, entry.detail.attempts, entry.detail.error]), [[failed?.id, 'activation.client', String(MAIL_MAX_ATTEMPTS), 'EMESSAGE 451']]);
  assert.ok(!JSON.stringify(await h.stores.audit.query({ limit: 10_000 })).includes('ABCDE-FGHIJ'));
  assert.deepEqual(errors, []);
});

test('outbox: no more than a few messages an hour for one address, and a ceiling for everyone together; what is held back is recorded, not sent', async () => {
  h = await harness();
  const outbox = new ConsoleOutbox(() => {});
  const queue = queueOf(outbox, { delivery: 'inline' });
  const results: string[] = [];
  for (let n = 0; n < 7; n += 1) results.push(await queue.enqueue(request(n, 'victim@northfield.example')));
  assert.deepEqual(results, ['queued', 'queued', 'queued', 'queued', 'queued', 'suppressed', 'suppressed']);
  assert.equal(outbox.sent.length, 5);
  // Someone else still gets theirs, until the ceiling for everyone is reached.
  const others: string[] = [];
  for (let n = 0; n < 9; n += 1) others.push(await queue.enqueue(request(100 + n, `person${n}@northfield.example`)));
  assert.deepEqual(others, ['queued', 'queued', 'queued', 'queued', 'queued', 'queued', 'queued', 'suppressed', 'suppressed']);
  assert.equal(outbox.sent.length, 12);
  // What was held back is on record: which limit, never the content.
  const suppressed = await h.stores.audit.query({ action: 'system.mail.suppressed' });
  assert.deepEqual(suppressed.map((entry) => entry.detail.limit).sort(), ['global', 'global', 'recipient', 'recipient']);
  assert.ok((await rows()).filter((row) => row.status === 'suppressed').every((row) => row.body === null));
  // The limits are counted from the outbox itself: a restart does not reset them, an hour does.
  const restarted = queueOf(outbox, { delivery: 'inline' });
  assert.equal(await restarted.enqueue(request(200, 'victim@northfield.example')), 'suppressed');
  h.clock.advance(60 * 60_000 + 1);
  assert.equal(await restarted.enqueue(request(201, 'victim@northfield.example')), 'queued');
  // Old finished messages are cleared away; nothing waiting ever is.
  await restarted.sweep();
  assert.ok((await rows()).length > 0);
  h.clock.advance(31 * 24 * 60 * 60_000);
  await restarted.sweep();
  assert.equal((await rows()).length, 0);
});
