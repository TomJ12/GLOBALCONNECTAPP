/**
 * THE DEMO GATE. A demo with mock providers and sample data that runs on a
 * public address must not be open to the internet. When DEMO_ACCESS_PASSWORD
 * is set, every route except /healthz (the client web app, the API, the ops
 * console, static files) answers only to a browser that has passed this gate:
 * one plain page asking for the demo password.
 *
 * It is a door, not an account system: one shared password, and a cookie that
 * says "this browser typed it". It sits IN FRONT of everything else and
 * replaces nothing: client sign-in (bearer tokens), staff sign-in (the ops
 * cookie), CSRF and confirmations all work exactly as they do without it.
 *
 * The cookie is a value the server signed (HMAC with the server's key over an
 * expiry, a random part and a digest of the current password), so nothing is
 * stored per visitor, a made-up or altered cookie opens nothing, and changing
 * the password shuts everybody out at once.
 */
import { createHash, createHmac } from 'node:crypto';

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import type { Config } from '../config';
import { randomToken, safeEqual } from '../crypto';
import { ApiError } from '../errors';

/** How long a browser stays through the gate. */
export const GATE_TTL_MS = 12 * 60 * 60_000;
/** Password attempts per source per minute, on top of the limit every sign-in route has. */
export const GATE_ATTEMPTS_PER_MINUTE = 5;
const GATE_PATH = '/demo-access';
const OPEN_PATHS = new Set(['/healthz', GATE_PATH, `${GATE_PATH}/style.css`]);

const STYLE = `body{margin:0;font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;background:#F1F5F9;color:#0F172A}
main{max-width:420px;margin:12vh auto;padding:28px;background:#fff;border:1px solid #E2E8F0;border-radius:10px}
h1{font-size:22px;margin:0 0 4px}p{margin:8px 0}.note{color:#475569}.error{background:#FEE2E2;border:1px solid #FCA5A5;border-radius:6px;padding:10px 14px}
label{display:block;font-weight:600;margin:18px 0 6px}input{width:100%;box-sizing:border-box;font:inherit;padding:9px 10px;border:1px solid #CBD5E1;border-radius:6px}
button{margin-top:16px;font:inherit;font-weight:600;color:#fff;background:#0F172A;border:0;border-radius:6px;padding:10px 16px;cursor:pointer}`;

const escape = (text: string): string => text.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char] as string);
/** Where to go after the gate: a path on this server and nothing else. */
const safeNext = (value: unknown): string => (typeof value === 'string' && /^\/(?!\/|\\)[\x21-\x7e]*$/.test(value) && !value.startsWith(GATE_PATH) ? value : '/');

function page(next: string, message: string | null): string {
  return `<!doctype html>
<html lang="en-GB"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex, nofollow">
<title>Global Connect demo</title><link rel="stylesheet" href="${GATE_PATH}/style.css"></head>
<body><main><h1>Global Connect demo: sample data only</h1>
<p class="note">This is a demonstration. Every company, person, balance and payment in it is made up, and no real money moves. Do not enter real client information.</p>
${message ? `<p class="error" role="alert">${escape(message)}</p>` : ''}
<form method="post" action="${GATE_PATH}"><input type="hidden" name="next" value="${escape(next)}">
<label for="password">Demo password</label><input id="password" type="password" name="password" autocomplete="current-password" required autofocus>
<button>Continue</button></form></main></body></html>`;
}

export interface DemoGateOptions {
  config: Pick<Config, 'demoAccessPassword' | 'serverSecret' | 'appUrl'>;
  now: () => number;
  /** The limit every unauthenticated sign-in route has (per source and per network). */
  limitAttempts: (request: FastifyRequest) => Promise<void>;
  /** A counter per source address: throws when it has been seen more than `allowed` times this minute. */
  limit: (address: string, allowed: number) => void;
}

export async function registerDemoGate(app: FastifyInstance, options: DemoGateOptions): Promise<void> {
  const { config, now } = options;
  const password = config.demoAccessPassword;
  if (!password) return;
  const secure = config.appUrl.startsWith('https://');
  // "__Host-": only this exact host can set it, only over https, for the whole site.
  const cookieName = secure ? '__Host-gc_demo' : 'gc_demo';
  const passwordDigest = createHash('sha256').update(`demo-gate-password:${password}`).digest('base64url');
  const sign = (expires: string, nonce: string): string => createHmac('sha256', config.serverSecret).update(`demo-gate:${expires}.${nonce}.${passwordDigest}`).digest('base64url');
  const passed = (request: FastifyRequest): boolean => {
    const raw = (request.headers.cookie ?? '')
      .split(';')
      .map((part) => part.trim())
      .find((part) => part.startsWith(`${cookieName}=`))
      ?.slice(cookieName.length + 1);
    const [expires = '', nonce = '', signature = ''] = (raw ?? '').split('.');
    if (!raw || raw.split('.').length !== 3 || !/^\d{1,16}$/.test(expires) || !nonce) return false;
    return Number(expires) > now() && safeEqual(sign(expires, nonce), signature);
  };
  const send = (reply: FastifyReply, status: number, next: string, message: string | null) =>
    reply.status(status).header('Cache-Control', 'no-store').type('text/html; charset=utf-8').send(page(next, message));

  app.addHook('onRequest', async (request, reply) => {
    const path = request.url.split('?')[0] as string;
    if (OPEN_PATHS.has(path) || passed(request)) return;
    // A person opening a page is taken to the gate. Anything else (the API, a script, an image) is simply refused.
    const wantsPage = request.method === 'GET' && !path.startsWith('/v1/') && (request.headers.accept ?? '').includes('text/html');
    if (wantsPage) return reply.redirect(`${GATE_PATH}?next=${encodeURIComponent(safeNext(request.url))}`, 303);
    return reply.status(401).header('Cache-Control', 'no-store').send({ error: { kind: 'unauthorized', reason: 'demo_access_required' } });
  });

  // Its own small corner: the one place outside the ops console that reads a posted form.
  await app.register(async (gate) => {
    gate.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string', bodyLimit: 4 * 1024 }, (_request, text, done) => {
      done(null, Object.fromEntries(new URLSearchParams(text as string)));
    });
    gate.get(`${GATE_PATH}/style.css`, async (_request, reply) => reply.type('text/css; charset=utf-8').send(STYLE));
    gate.get(GATE_PATH, async (request, reply) => {
      const next = safeNext((request.query as Record<string, unknown>).next);
      if (passed(request)) return reply.redirect(next, 303);
      return send(reply, 200, next, null);
    });
    gate.post(GATE_PATH, { preHandler: options.limitAttempts }, async (request, reply) => {
      const body = (request.body ?? {}) as Record<string, unknown>;
      const next = safeNext(body.next);
      // Another site must not be able to submit this form for the visitor.
      const site = request.headers['sec-fetch-site'];
      if (site !== undefined && site !== 'same-origin' && site !== 'none') return send(reply, 403, next, 'That did not come from this page. Try again here.');
      try {
        options.limit(request.ip, GATE_ATTEMPTS_PER_MINUTE);
      } catch (error) {
        if (error instanceof ApiError && error.options.retryAfterSeconds !== undefined) reply.header('Retry-After', String(error.options.retryAfterSeconds));
        return send(reply, 429, next, 'Too many attempts. Wait a minute and try again.');
      }
      const typed = typeof body.password === 'string' ? body.password : '';
      // Digests of equal length are compared, in constant time: neither the length of the password nor how much of it was right can be timed.
      const digest = (value: string) => createHash('sha256').update(`demo-gate-attempt:${value}`).digest('base64url');
      if (!safeEqual(digest(typed), digest(password))) return send(reply, 401, next, 'That is not the demo password.');
      const expires = String(now() + GATE_TTL_MS);
      const nonce = randomToken();
      reply.header('Set-Cookie', `${cookieName}=${expires}.${nonce}.${sign(expires, nonce)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${GATE_TTL_MS / 1000}${secure ? '; Secure' : ''}`);
      return reply.redirect(next, 303);
    });
  });
}
