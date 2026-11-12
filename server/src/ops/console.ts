/**
 * The ops console: server-rendered pages under /ops for Global Connect staff.
 *
 * Separate from the client API in every respect: its own account table, its
 * own session cookie and session table, its own routes. It reads no bearer
 * token, and the client API reads no cookie.
 *
 * What staff CANNOT do is enforced by absence: there is no route here that
 * reads or sets a password, authenticator key or recovery code of someone
 * else, none that reaches a provider (balances, transactions, payments,
 * conversions), and none that starts a client session.
 *
 * Every state-changing request needs: the session cookie, the CSRF field, and
 * a fresh authenticator code from the staff member (step-up). Each one is
 * written to the audit log, whether it succeeded or not.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import type { UserRole } from '@/api/types';

import { reasonOf, type AuthService } from '../auth/service';
import type { Config } from '../config';
import { randomToken, safeEqual, sha256 } from '../crypto';
import { ApiError } from '../errors';
import type { ProviderRegistry } from '../providers/adapter';
import type { AuditParty, CompanyRecord, OpsRole, OpsUserRecord, ProviderKey, Stores, UserRecord } from '../store/types';
import { opsParty, type Invitation, type OpsAuthService, type OpsContext } from './auth';
import { codeField, h, Html, layout, qrSvg, when } from './html';

export interface OpsDeps {
  config: Config;
  stores: Stores;
  auth: AuthService;
  opsAuth: OpsAuthService;
  registry: ProviderRegistry;
  now: () => number;
  limitAttempts: (request: FastifyRequest) => Promise<void>;
}

const SESSION_COOKIE = 'gc_ops_session';
const PRE_COOKIE = 'gc_ops_pre';
const CLIENT_ROLES: UserRole[] = ['creator', 'approver', 'admin'];
const OPS_ROLES: OpsRole[] = ['ops', 'ops_admin'];

/** Staff choose a provider by a neutral label; the name is shown beside it because staff need it. Never sent to the client app. */
const PROVIDERS: Record<ProviderKey, { slug: string; label: string }> = {
  currencycloud: { slug: 'provider-a', label: 'Provider A (Currencycloud)' },
  equals: { slug: 'provider-b', label: 'Provider B (Equals Money)' },
};

/** A refusal with wording for staff. */
export class OpsError extends Error {
  constructor(
    message: string,
    readonly status = 400,
    readonly reason = 'validation',
  ) {
    super(message);
  }
}

const MESSAGES: Record<string, string> = {
  invalid_code: 'That authenticator code was not accepted. Nothing was changed.',
  code_reused: 'That code has already been used. Wait for the next code and try again. Nothing was changed.',
  locked: 'Too many wrong attempts. Try again later.',
  invalid_credentials: 'The email or password is not right.',
  challenge_expired: 'That sign-in attempt has expired. Start again.',
  activation_invalid: 'That activation code is not valid. It may have expired, been used or been replaced.',
  weak_password: 'Choose a password of at least 12 characters that is not a common one.',
};
const messageOf = (error: unknown): string =>
  error instanceof OpsError ? error.message : error instanceof ApiError ? (MESSAGES[error.options.reason ?? ''] ?? (error.kind === 'not_found' ? 'Not found.' : 'The request was not accepted.')) : 'Something went wrong.';
const statusOf = (error: unknown): number => (error instanceof OpsError ? error.status : error instanceof ApiError ? error.status : 500);

/** A staff member may not remove their own access, and the last active ops admin may not be removed. */
export async function assertStaffRemovalAllowed(stores: Stores, actorId: string, target: OpsUserRecord): Promise<void> {
  if (actorId === target.id) throw new OpsError('You cannot do this to your own account.', 403, 'self');
  if (target.role !== 'ops_admin') return;
  const others = (await stores.ops.users.list()).filter((user) => user.id !== target.id && user.role === 'ops_admin' && user.disabledAt === null && user.activatedAt !== null);
  if (others.length === 0) throw new OpsError('This is the last active ops admin and cannot be removed.', 403, 'last_admin');
}

type Form = Record<string, string>;
const text = (form: Form, name: string): string => (form[name] ?? '').trim();
function need(form: Form, name: string, label: string, max = 120): string {
  const value = text(form, name);
  if (!value || value.length > max) throw new OpsError(`${label} is required (at most ${max} characters).`);
  return value;
}
function needEmail(form: Form): string {
  const email = need(form, 'email', 'Email', 254).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new OpsError('That email address does not look right.');
  return email;
}
function oneOf<T extends string>(value: string, allowed: readonly T[], label: string): T {
  if (!(allowed as readonly string[]).includes(value)) throw new OpsError(`Choose a ${label}.`);
  return value as T;
}

function cookiesOf(request: FastifyRequest): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (request.headers.cookie ?? '').split(';')) {
    const at = part.indexOf('=');
    if (at > 0) out[part.slice(0, at).trim()] = part.slice(at + 1).trim();
  }
  return out;
}

const asset = (relative: string): Buffer | null => {
  try {
    return readFileSync(fileURLToPath(new URL(relative, import.meta.url)));
  } catch {
    return null;
  }
};

export async function registerOps(app: FastifyInstance, deps: OpsDeps): Promise<{ method: string; url: string }[]> {
  const { config, stores, auth, opsAuth, registry, now, limitAttempts } = deps;
  const routes: { method: string; url: string }[] = [];
  const secure = !/^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(config.opsUrl);
  const cookie = (name: string, value: string, clear = false) =>
    `${name}=${value}; Path=/ops; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}${clear ? '; Max-Age=0' : ''}`;
  const csrfFor = (anchor: string): string => sha256(`ops-csrf:${anchor}`);
  const providerKeys = (Object.keys(PROVIDERS) as ProviderKey[]).filter((key) => config.providers[key] !== null);

  const files: Record<string, { type: string; body: Buffer | null }> = {
    'ops.css': { type: 'text/css; charset=utf-8', body: asset('./static/ops.css') },
    'ops.js': { type: 'text/javascript; charset=utf-8', body: asset('./static/ops.js') },
    'logo.png': { type: 'image/png', body: asset('../../../assets/images/logo-mark-white.png') },
    // Inter is already bundled with the app; when it is absent the stylesheet falls back to the system font.
    'inter-400.ttf': { type: 'font/ttf', body: asset('../../../node_modules/@expo-google-fonts/inter/400Regular/Inter_400Regular.ttf') },
    'inter-600.ttf': { type: 'font/ttf', body: asset('../../../node_modules/@expo-google-fonts/inter/600SemiBold/Inter_600SemiBold.ttf') },
  };

  await app.register(
    async (ops) => {
      ops.addHook('onRoute', (route) => {
        for (const method of [route.method].flat()) routes.push({ method: String(method), url: route.url });
      });
      ops.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string', bodyLimit: 16 * 1024 }, (_request, body, done) => {
        done(null, Object.fromEntries(new URLSearchParams(body as string)));
      });
      ops.addHook('onSend', async (_request, reply) => {
        reply.header('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");
        reply.header('X-Frame-Options', 'DENY');
        reply.header('Referrer-Policy', 'no-referrer');
        reply.header('Cache-Control', 'no-store');
        reply.header('X-Content-Type-Options', 'nosniff');
      });

      const send = (reply: FastifyReply, status: number, page: string) => reply.status(status).type('text/html; charset=utf-8').send(page);
      const chromeOf = (ctx: OpsContext, title: string, flash?: string) => ({ title, user: ctx.user, csrf: csrfFor(ctx.token), flash });
      const problem = (reply: FastifyReply, ctx: OpsContext | null, error: unknown, csrf = '') => {
        const status = statusOf(error);
        if (error instanceof ApiError && error.options.retryAfterSeconds !== undefined) reply.header('Retry-After', String(error.options.retryAfterSeconds));
        if (status >= 500) app.log.error({ message: error instanceof Error ? error.message : 'unknown error' }, 'ops request failed');
        return send(
          reply,
          status,
          layout(
            { title: status === 404 ? 'Not found' : 'Not done', user: ctx?.user ?? null, csrf: ctx ? csrfFor(ctx.token) : csrf },
            h`<div class="card"><p class="error" role="alert">${messageOf(error)}</p><p>Use your browser’s back button to try again, or <a href="/ops">return to the console</a>.</p></div>`,
          ),
        );
      };
      ops.setErrorHandler((error, _request, reply) => problem(reply, null, error));
      ops.setNotFoundHandler((_request, reply) => problem(reply, null, new OpsError('Not found.', 404)));

      /** Browsers say where a request came from; anything not from this console's own pages is refused. */
      const sameSite = (request: FastifyRequest): boolean => {
        const site = request.headers['sec-fetch-site'];
        return site === undefined || site === 'same-origin' || site === 'none';
      };
      const csrfOk = (request: FastifyRequest, anchor: string | undefined): boolean => {
        const sent = (request.body as Form | null)?._csrf;
        return sameSite(request) && !!anchor && typeof sent === 'string' && safeEqual(sent, csrfFor(anchor));
      };
      const sessionOf = async (request: FastifyRequest): Promise<OpsContext | null> => {
        try {
          return await opsAuth.authenticate(cookiesOf(request)[SESSION_COOKIE]);
        } catch {
          return null;
        }
      };

      type PageHandler = (ctx: OpsContext, request: FastifyRequest, reply: FastifyReply) => Promise<unknown>;
      const page = (url: string, options: { admin?: boolean }, handler: PageHandler) =>
        ops.get(url, async (request, reply) => {
          const ctx = await sessionOf(request);
          if (!ctx) return reply.header('Set-Cookie', cookie(SESSION_COOKIE, '', true)).redirect('/ops/login', 303);
          try {
            if (options.admin && ctx.user.role !== 'ops_admin') throw new OpsError('Only an ops admin can do that.', 403, 'forbidden');
            return await handler(ctx, request, reply);
          } catch (error) {
            return problem(reply, ctx, error);
          }
        });

      interface ActionInput {
        ctx: OpsContext;
        form: Form;
        params: Record<string, string>;
        source: string;
        /** Must be called once the input is valid and before anything is changed. */
        stepUp: () => Promise<void>;
      }
      interface ActionResult {
        target: AuditParty | null;
        detail?: Record<string, string>;
        redirect?: string;
        /** A page shown once instead of a redirect (an activation link). */
        show?: Html;
        title?: string;
      }
      const action = (url: string, options: { name: string; admin?: boolean }, handler: (input: ActionInput) => Promise<ActionResult>) =>
        ops.post(url, { preHandler: limitAttempts }, async (request, reply) => {
          const ctx = await sessionOf(request);
          if (!ctx) return problem(reply, null, new OpsError('Your session has ended. Sign in again.', 401));
          if (!csrfOk(request, ctx.token)) return problem(reply, ctx, new OpsError('This form could not be verified. Reload the page and try again.', 403));
          const form = (request.body ?? {}) as Form;
          const record = (outcome: 'success' | 'failure', target: AuditParty | null, detail: Record<string, string>) =>
            stores.audit.append({ at: now(), actor: opsParty(ctx.user), target, action: `ops.${options.name}`, outcome, source: request.ip, detail });
          let steppedUp = false;
          try {
            if (options.admin && ctx.user.role !== 'ops_admin') throw new OpsError('Only an ops admin can do that.', 403, 'forbidden');
            const result = await handler({
              ctx,
              form,
              params: request.params as Record<string, string>,
              source: request.ip,
              stepUp: async () => {
                await opsAuth.stepUp(ctx, text(form, 'code'), options.name, request.ip);
                steppedUp = true;
              },
            });
            if (!steppedUp) throw new Error(`ops action ${options.name} ran without step-up`);
            await record('success', result.target, result.detail ?? {});
            if (result.show) return send(reply, 200, layout(chromeOf(ctx, result.title ?? 'Done'), result.show));
            return reply.redirect(result.redirect ?? '/ops', 303);
          } catch (error) {
            await record('failure', null, { reason: error instanceof OpsError ? error.reason : reasonOf(error) });
            return problem(reply, ctx, error);
          }
        });

      // --- Static files (no session needed: they hold nothing private) ---------
      ops.get('/static/:file', async (request, reply) => {
        const file = files[(request.params as { file: string }).file];
        if (!file?.body) return reply.status(404).type('text/plain').send('Not found');
        return reply.type(file.type).send(file.body);
      });

      // --- Activation and sign-in (no session yet) -------------------------------
      /** The cookie that anchors the CSRF field before there is a session. */
      const preAnchor = (request: FastifyRequest, reply: FastifyReply): string => {
        const existing = cookiesOf(request)[PRE_COOKIE];
        if (existing && /^[\w-]{20,}$/.test(existing)) return existing;
        const fresh = randomToken();
        reply.header('Set-Cookie', cookie(PRE_COOKIE, fresh));
        return fresh;
      };
      const publicPage = (reply: FastifyReply, anchor: string, title: string, body: Html, status = 200) =>
        send(reply, status, layout({ title, user: null, csrf: csrfFor(anchor) }, h`<div class="card narrow">${body}</div>`));
      const hidden = (anchor: string, more: Record<string, string> = {}) =>
        h`<input type="hidden" name="_csrf" value="${csrfFor(anchor)}">${Object.entries(more).map(([name, value]) => h`<input type="hidden" name="${name}" value="${value}">`)}`;
      const alert = (message: string | null) => message && h`<p class="error" role="alert">${message}</p>`;

      /** A form step before sign-in: CSRF check, then the handler; a refusal re-renders with the message. */
      const publicPost = (url: string, handler: (form: Form, anchor: string, request: FastifyRequest, reply: FastifyReply) => Promise<unknown>, again: (form: Form, anchor: string, message: string, reply: FastifyReply) => Promise<unknown> | unknown) =>
        ops.post(url, { preHandler: limitAttempts }, async (request, reply) => {
          const anchor = cookiesOf(request)[PRE_COOKIE];
          if (!csrfOk(request, anchor)) return problem(reply, null, new OpsError('This form could not be verified. Reload the page and try again.', 403));
          const form = (request.body ?? {}) as Form;
          try {
            return await handler(form, anchor as string, request, reply);
          } catch (error) {
            if (statusOf(error) >= 500) return problem(reply, null, error);
            if (error instanceof ApiError && error.options.retryAfterSeconds !== undefined) reply.header('Retry-After', String(error.options.retryAfterSeconds));
            reply.status(statusOf(error));
            return again(form, anchor as string, messageOf(error), reply);
          }
        });

      const activateForm = (reply: FastifyReply, anchor: string, message: string | null = null) =>
        publicPage(
          reply,
          anchor,
          'Activate your ops account',
          h`${alert(message)}<form method="post" action="/ops/activate">${hidden(anchor)}<label>Activation code <input name="activationCode" required autocomplete="off" data-from-fragment></label><button>Continue</button></form>`,
          reply.statusCode,
        );
      const passwordForm = (reply: FastifyReply, anchor: string, activationCode: string, who: { email: string; name: string }, message: string | null = null) =>
        publicPage(
          reply,
          anchor,
          'Choose a password',
          h`${alert(message)}<p>${who.name} · ${who.email}</p><form method="post" action="/ops/activate/password">${hidden(anchor, { activationCode })}<label>Password (at least 12 characters, not a common one) <input type="password" name="password" required minlength="12" autocomplete="new-password"></label><button>Continue</button></form>`,
          reply.statusCode,
        );
      const enrolForm = (reply: FastifyReply, anchor: string, activationCode: string, enrol: { email: string; secret: string; otpauthUri: string }, message: string | null = null) =>
        publicPage(
          reply,
          anchor,
          'Add your authenticator app',
          h`${alert(message)}<p>Scan this with an authenticator app, or enter the key by hand (account ${enrol.email}, time-based).</p>${qrSvg(enrol.otpauthUri)}<p class="secret">${enrol.secret}</p><form method="post" action="/ops/activate/confirm">${hidden(anchor, { activationCode })}${codeField}<button>Confirm</button></form>`,
          reply.statusCode,
        );

      ops.get('/activate', async (request, reply) => activateForm(reply, preAnchor(request, reply)));
      publicPost(
        '/activate',
        async (form, anchor, _request, reply) => passwordForm(reply, anchor, text(form, 'activationCode'), await opsAuth.activationStart(text(form, 'activationCode'))),
        (_form, anchor, message, reply) => activateForm(reply, anchor, message),
      );
      publicPost(
        '/activate/password',
        async (form, anchor, _request, reply) => enrolForm(reply, anchor, text(form, 'activationCode'), await opsAuth.activationPassword(text(form, 'activationCode'), form.password ?? '')),
        async (form, anchor, message, reply) => {
          try {
            return passwordForm(reply, anchor, text(form, 'activationCode'), await opsAuth.activationStart(text(form, 'activationCode')), message);
          } catch {
            return activateForm(reply, anchor, message);
          }
        },
      );
      publicPost(
        '/activate/confirm',
        async (form, anchor, request, reply) => {
          const { recoveryCodes } = await opsAuth.activationConfirm(text(form, 'activationCode'), text(form, 'code'), request.ip);
          return publicPage(
            reply,
            anchor,
            'Save your recovery codes',
            h`<p>Each code works once if you lose your authenticator. They are shown only now.</p><ul class="codes secret" id="codes">${recoveryCodes.map((item) => h`<li>${item}</li>`)}</ul><p><button type="button" class="quiet" data-copy="codes">Copy</button></p><p><a class="button" href="/ops/login">I have saved these codes: sign in</a></p>`,
          );
        },
        async (form, anchor, message, reply) => {
          try {
            return enrolForm(reply, anchor, text(form, 'activationCode'), await opsAuth.activationPending(text(form, 'activationCode')), message);
          } catch {
            return activateForm(reply, anchor, message);
          }
        },
      );

      const loginForm = (reply: FastifyReply, anchor: string, message: string | null = null) =>
        publicPage(
          reply,
          anchor,
          'Staff sign-in',
          h`${alert(message)}<form method="post" action="/ops/login">${hidden(anchor)}<label>Email <input type="email" name="email" required autocomplete="username"></label><label>Password <input type="password" name="password" required autocomplete="current-password"></label><button>Continue</button></form><p class="muted">Global Connect staff only. Clients sign in through the app.</p>`,
          reply.statusCode,
        );
      const codeForm = (reply: FastifyReply, anchor: string, challengeId: string, message: string | null = null) =>
        publicPage(
          reply,
          anchor,
          'Enter your code',
          h`${alert(message)}<form method="post" action="/ops/login/verify">${hidden(anchor, { challengeId })}<label>Code from your authenticator app, or a recovery code <input name="code" required autocomplete="one-time-code"></label><label>Type <select name="method"><option value="totp">Authenticator code</option><option value="recovery">Recovery code</option></select></label><button>Sign in</button></form>`,
          reply.statusCode,
        );
      ops.get('/login', async (request, reply) => loginForm(reply, preAnchor(request, reply)));
      publicPost(
        '/login',
        async (form, anchor, request, reply) => codeForm(reply, anchor, (await opsAuth.login(text(form, 'email'), form.password ?? '', request.ip)).challengeId),
        (_form, anchor, message, reply) => loginForm(reply, anchor, message),
      );
      publicPost(
        '/login/verify',
        async (form, _anchor, request, reply) => {
          const { token } = await opsAuth.verifyLogin(text(form, 'challengeId'), text(form, 'code'), form.method === 'recovery' ? 'recovery' : 'totp', request.ip);
          return reply.header('Set-Cookie', [cookie(SESSION_COOKIE, token), cookie(PRE_COOKIE, '', true)]).redirect('/ops', 303);
        },
        (form, anchor, message, reply) => (message === MESSAGES.challenge_expired ? loginForm(reply, anchor, message) : codeForm(reply, anchor, text(form, 'challengeId'), message)),
      );
      ops.post('/logout', async (request, reply) => {
        const token = cookiesOf(request)[SESSION_COOKIE];
        if (!csrfOk(request, token)) return problem(reply, null, new OpsError('This form could not be verified.', 403));
        await opsAuth.logout(token, request.ip);
        return reply.header('Set-Cookie', cookie(SESSION_COOKIE, '', true)).redirect('/ops/login', 303);
      });

      // --- Shared page pieces ------------------------------------------------------
      const FLASH: Record<string, string> = { saved: 'Saved.', created: 'Created.', unlocked: 'Account unlocked.', revoked: 'Sessions revoked.', disabled: 'Disabled.', enabled: 'Re-enabled.' };
      const flashOf = (request: FastifyRequest): string | undefined => FLASH[(request.query as Record<string, string>).done ?? ''];
      const queryOf = (request: FastifyRequest, name: string): string => ((request.query as Record<string, string | undefined>)[name] ?? '').trim();
      const post = (ctx: OpsContext, url: string, fields: Html, button: string, options: { danger?: boolean; confirm?: string } = {}) =>
        h`<form method="post" action="${url}"${options.confirm ? h` data-confirm="${options.confirm}"` : ''}><input type="hidden" name="_csrf" value="${csrfFor(ctx.token)}"><div class="row tight">${fields}${codeField}<button${options.danger ? h` class="danger"` : ''}>${button}</button></div></form>`;
      const search = (url: string, q: string, label: string) =>
        h`<form method="get" action="${url}"><label>${label} <input type="search" name="q" value="${q}"></label><button class="quiet">Search</button></form>`;
      const tag = (ok: boolean, yes: string, no: string) => h`<span class="tag ${ok ? 'ok' : 'bad'}">${ok ? yes : no}</span>`;
      const roleSelect = (name: string, roles: readonly string[], current = '', blank = false) =>
        h`<select name="${name}">${blank && h`<option value="">—</option>`}${roles.map((role) => h`<option value="${role}"${role === current ? h` selected` : ''}>${role}</option>`)}</select>`;
      const VERIFY_WARNING =
        'Verify this person’s identity BEFORE resetting. Anyone who receives the new activation link can take over the account. Use a contact detail already on file, not one given in the request.';
      const verifyField = h`<label>How was identity verified? (kept in the audit log) <textarea name="verification" required minlength="10" maxlength="500" rows="2"></textarea></label>`;
      const needVerification = (form: Form): string => {
        const value = text(form, 'verification');
        if (value.length < 10 || value.length > 500) throw new OpsError('Say how the person’s identity was verified (10 to 500 characters).');
        return value;
      };
      const linkPage = (invite: Invitation, who: string, back: string, forceNew: boolean) =>
        h`<div class="card"><p class="warn"><strong>This link is shown once.</strong> Global Connect does not email it. Pass it to ${who} only through an approved channel, after confirming who you are talking to.</p>
<p>Activation link:</p><p class="secret" id="link">${invite.activationLink}</p><p><button type="button" class="quiet" data-copy="link">Copy link</button></p>
<p>Activation code: <span class="secret">${invite.activationCode}</span></p><p>Expires ${when(invite.expiresAt)}. Any earlier link for this person no longer works.${forceNew && ' They will choose a new password and add their authenticator again.'}</p><p><a href="${back}">Back</a></p></div>`;

      const clientParty = (user: UserRecord): AuditParty => ({ type: 'client', id: user.id, label: user.email });
      const companyParty = (company: CompanyRecord): AuditParty => ({ type: 'company', id: company.id, label: company.name });
      const clientOf = async (id: string | undefined): Promise<UserRecord> => {
        const user = id ? await stores.directory.getUser(id) : null;
        if (!user) throw new OpsError('No such client user.', 404, 'not_found');
        return user;
      };
      const companyOf = async (id: string | undefined): Promise<CompanyRecord> => {
        const company = id ? await stores.directory.getCompany(id) : null;
        if (!company) throw new OpsError('No such company.', 404, 'not_found');
        return company;
      };
      const staffOf = async (id: string | undefined): Promise<OpsUserRecord> => {
        const user = id ? await stores.ops.users.get(id) : null;
        if (!user) throw new OpsError('No such staff account.', 404, 'not_found');
        return user;
      };
      /** Ends a client's sessions and records that it happened. */
      const revokeClientSessions = async (ctx: OpsContext, user: UserRecord, source: string, why: string): Promise<number> => {
        const total = await auth.revokeAllSessions(user.id);
        await stores.audit.append({ at: now(), actor: opsParty(ctx.user), target: clientParty(user), action: 'client.session_revoked', outcome: 'success', source, detail: { sessions: String(total), why } });
        return total;
      };

      ops.get('/', async (_request, reply) => reply.redirect('/ops/users', 303));

      // --- Companies ---------------------------------------------------------------
      const companyFields = (company: Partial<CompanyRecord> = {}) =>
        h`<label>Name <input name="name" required maxlength="120" value="${company.name ?? ''}"></label>
<label>Provider <select name="provider" required>${providerKeys.map((key) => h`<option value="${PROVIDERS[key].slug}"${company.providerKey === key ? h` selected` : ''}>${PROVIDERS[key].label}</option>`)}</select></label>
<label>Provider account id <input name="providerAccountId" required maxlength="120" value="${company.providerAccountId ?? ''}"></label>
<label>Provider contact id (optional) <input name="providerContactId" maxlength="120" value="${company.providerContactId ?? ''}"></label>`;
      const companyInput = (form: Form) => {
        const slug = text(form, 'provider');
        const providerKey = providerKeys.find((key) => PROVIDERS[key].slug === slug);
        if (!providerKey) throw new OpsError('Choose a provider.');
        return { name: need(form, 'name', 'Name'), providerKey, providerAccountId: need(form, 'providerAccountId', 'Provider account id'), providerContactId: text(form, 'providerContactId').slice(0, 120) };
      };

      page('/companies', {}, async (ctx, request, reply) => {
        const q = queryOf(request, 'q').toLowerCase();
        const companies = (await stores.directory.listCompanies()).filter((company) => !q || `${company.name} ${company.id} ${company.providerAccountId}`.toLowerCase().includes(q));
        return send(
          reply,
          200,
          layout(
            chromeOf(ctx, 'Companies', flashOf(request)),
            h`<div class="toolbar">${search('/ops/companies', q, 'Search name or id')}<a class="button" href="/ops/companies/new">New company</a></div>
<div class="card"><table><tr><th>Name</th><th>Provider</th><th>Provider account id</th><th>Status</th></tr>${companies.map(
              (company) => h`<tr><td><a href="/ops/companies/${company.id}">${company.name}</a></td><td>${PROVIDERS[company.providerKey].label}</td><td>${company.providerAccountId}</td><td>${tag(!company.deactivatedAt, 'Active', 'Deactivated')}</td></tr>`,
            )}</table>${companies.length === 0 && h`<p class="muted">No companies found.</p>`}</div>`,
          ),
        );
      });
      page('/companies/new', {}, async (ctx, _request, reply) =>
        send(reply, 200, layout(chromeOf(ctx, 'New company'), h`<div class="card narrow"><form method="post" action="/ops/companies"><input type="hidden" name="_csrf" value="${csrfFor(ctx.token)}">${companyFields()}${codeField}<button>Create company</button></form></div>`)),
      );
      action('/companies', { name: 'company.create' }, async ({ form, stepUp }) => {
        const input = companyInput(form);
        await stepUp();
        const company: CompanyRecord = { id: `co_${randomToken().slice(0, 12)}`, ...input, deactivatedAt: null };
        await stores.directory.saveCompany(company);
        return { target: companyParty(company), detail: { provider: PROVIDERS[company.providerKey].slug }, redirect: `/ops/companies/${company.id}?done=created` };
      });
      page('/companies/:id', {}, async (ctx, request, reply) => {
        const company = await companyOf((request.params as { id: string }).id);
        const members = (await stores.directory.listMemberships()).filter((item) => item.companyId === company.id);
        const users = await Promise.all(members.map(async (item) => ({ role: item.role, user: await stores.directory.getUser(item.userId) })));
        return send(
          reply,
          200,
          layout(
            chromeOf(ctx, company.name, flashOf(request)),
            h`<div class="grid"><div class="card"><h2>Details ${tag(!company.deactivatedAt, 'Active', 'Deactivated')}</h2><form method="post" action="/ops/companies/${company.id}"><input type="hidden" name="_csrf" value="${csrfFor(ctx.token)}">${companyFields(company)}${codeField}<button>Save changes</button></form></div>
<div><div class="card"><h2>People</h2><table><tr><th>Name</th><th>Email</th><th>Role</th></tr>${users.map(({ role, user }) => user && h`<tr><td><a href="/ops/users/${user.id}">${user.name}</a></td><td>${user.email}</td><td>${role}</td></tr>`)}</table>${users.length === 0 && h`<p class="muted">Nobody yet. Attach people from their client user page.</p>`}</div>
<div class="card"><h2>${company.deactivatedAt ? 'Reactivate' : 'Deactivate'}</h2><p class="muted">A deactivated company cannot be selected or used by any client.</p>${
              company.deactivatedAt
                ? post(ctx, `/ops/companies/${company.id}/reactivate`, h``, 'Reactivate company')
                : post(ctx, `/ops/companies/${company.id}/deactivate`, h``, 'Deactivate company', { danger: true, confirm: 'Deactivate this company?' })
            }</div></div></div>`,
          ),
        );
      });
      action('/companies/:id', { name: 'company.edit' }, async ({ form, params, stepUp }) => {
        const company = await companyOf(params.id);
        const input = companyInput(form);
        await stepUp();
        await stores.directory.saveCompany({ ...company, ...input });
        registry.invalidate(company.id);
        return { target: companyParty({ ...company, ...input }), detail: { provider: PROVIDERS[input.providerKey].slug }, redirect: `/ops/companies/${company.id}?done=saved` };
      });
      for (const [verb, deactivate] of [['deactivate', true], ['reactivate', false]] as const) {
        action(`/companies/:id/${verb}`, { name: `company.${verb}` }, async ({ params, stepUp }) => {
          const company = await companyOf(params.id);
          await stepUp();
          await stores.directory.saveCompany({ ...company, deactivatedAt: deactivate ? now() : null });
          return { target: companyParty(company), redirect: `/ops/companies/${company.id}?done=saved` };
        });
      }

      // --- Client users ------------------------------------------------------------
      page('/users', {}, async (ctx, request, reply) => {
        const q = queryOf(request, 'q').toLowerCase();
        const users = (await stores.directory.listUsers()).filter((user) => !q || `${user.name} ${user.email} ${user.id}`.toLowerCase().includes(q));
        return send(
          reply,
          200,
          layout(
            chromeOf(ctx, 'Client users', flashOf(request)),
            h`<div class="toolbar">${search('/ops/users', q, 'Search name or email')}<a class="button" href="/ops/users/new">New client user</a></div>
<div class="card"><table><tr><th>Name</th><th>Email</th><th>Status</th><th>Last sign-in</th></tr>${users.map(
              (user) => h`<tr><td><a href="/ops/users/${user.id}">${user.name}</a></td><td>${user.email}</td><td>${user.disabledAt ? tag(false, '', 'Disabled') : tag(user.activatedAt !== null, 'Activated', 'Not activated')}</td><td>${when(user.lastSignInAt)}</td></tr>`,
            )}</table>${users.length === 0 && h`<p class="muted">No client users found.</p>`}</div>`,
          ),
        );
      });
      page('/users/new', {}, async (ctx, _request, reply) => {
        const companies = (await stores.directory.listCompanies()).filter((company) => !company.deactivatedAt);
        const pick = (index: number) =>
          h`<div class="row"><label>Company ${index}${index === 1 ? '' : ' (optional)'} <select name="company${index}"${index === 1 ? h` required` : ''}><option value="">—</option>${companies.map((company) => h`<option value="${company.id}">${company.name}</option>`)}</select></label><label>Role ${roleSelect(`role${index}`, CLIENT_ROLES)}</label></div>`;
        return send(
          reply,
          200,
          layout(
            chromeOf(ctx, 'New client user'),
            h`<div class="card narrow"><form method="post" action="/ops/users"><input type="hidden" name="_csrf" value="${csrfFor(ctx.token)}"><label>Name <input name="name" required maxlength="120"></label><label>Email <input type="email" name="email" required maxlength="254"></label>${[1, 2, 3].map(pick)}<p class="muted">More companies can be attached afterwards. The person cannot sign in until you issue an activation link.</p>${codeField}<button>Create client user</button></form></div>`,
          ),
        );
      });
      action('/users', { name: 'client.create' }, async ({ form, stepUp }) => {
        const name = need(form, 'name', 'Name');
        const email = needEmail(form);
        if (await stores.directory.findUserByEmail(email)) throw new OpsError('A client user with that email already exists.');
        const memberships = new Map<string, UserRole>();
        for (const index of [1, 2, 3]) {
          const companyId = text(form, `company${index}`);
          if (!companyId) continue;
          await companyOf(companyId);
          memberships.set(companyId, oneOf(text(form, `role${index}`), CLIENT_ROLES, 'role'));
        }
        if (memberships.size === 0) throw new OpsError('Attach the person to at least one company.');
        await stepUp();
        const user: UserRecord = { id: `usr_${randomToken().slice(0, 12)}`, email, name, passwordHash: null, totpSecret: null, lastTotpStep: 0, recoveryCodeHashes: [], activatedAt: null, disabledAt: null, lastSignInAt: null };
        await stores.directory.saveUser(user);
        for (const [companyId, role] of memberships) await stores.directory.setMembership({ userId: user.id, companyId, role });
        return { target: clientParty(user), detail: { companies: [...memberships].map(([companyId, role]) => `${companyId}:${role}`).join(' ') }, redirect: `/ops/users/${user.id}?done=created` };
      });
      page('/users/:id', {}, async (ctx, request, reply) => {
        const user = await clientOf((request.params as { id: string }).id);
        const base = `/ops/users/${user.id}`;
        const companies = await stores.directory.listCompanies();
        const memberships = await stores.directory.membershipsOf(user.id);
        const locked = await auth.isLocked(user);
        const sessions = await auth.activeSessionCount(user.id);
        const nameOf = (companyId: string) => companies.find((company) => company.id === companyId)?.name ?? companyId;
        const free = companies.filter((company) => !company.deactivatedAt && !memberships.some((item) => item.companyId === company.id));
        // Status only. No credential of the person is read into this page.
        return send(
          reply,
          200,
          layout(
            chromeOf(ctx, user.name, flashOf(request)),
            h`<div class="grid"><div><div class="card"><h2>Status</h2><dl><dt>Email</dt><dd>${user.email}</dd><dt>Activated</dt><dd>${user.activatedAt ? `Yes, ${when(user.activatedAt)}` : 'No'}</dd><dt>Last sign-in</dt><dd>${when(user.lastSignInAt)}</dd><dt>Locked out</dt><dd>${locked ? 'Yes' : 'No'}</dd><dt>Active sessions</dt><dd>${sessions}</dd><dt>Account</dt><dd>${tag(!user.disabledAt, 'Enabled', 'Disabled')}</dd></dl></div>
<div class="card"><h2>Companies</h2><table><tr><th>Company</th><th>Role</th><th></th></tr>${memberships.map(
              (item) => h`<tr><td><a href="/ops/companies/${item.companyId}">${nameOf(item.companyId)}</a></td><td>${post(ctx, `${base}/memberships`, h`<input type="hidden" name="companyId" value="${item.companyId}"><label>Role ${roleSelect('role', CLIENT_ROLES, item.role)}</label>`, 'Change role')}</td><td>${post(ctx, `${base}/memberships/remove`, h`<input type="hidden" name="companyId" value="${item.companyId}">`, 'Remove', { danger: true, confirm: 'Remove this person from the company?' })}</td></tr>`,
            )}</table>${free.length > 0 && h`<h2>Attach to a company</h2>${post(ctx, `${base}/memberships`, h`<label>Company <select name="companyId" required>${free.map((company) => h`<option value="${company.id}">${company.name}</option>`)}</select></label><label>Role ${roleSelect('role', CLIENT_ROLES)}</label>`, 'Attach')}`}</div></div>
<div>${
              user.activatedAt === null
                ? h`<div class="card"><h2>Activation link</h2><p class="muted">Issues a new link and cancels any earlier one. Valid for 72 hours. Email delivery is not built: you pass the link on through an approved channel.</p>${post(ctx, `${base}/activation-link`, h``, 'Issue activation link')}</div>`
                : h`<div class="card"><h2>Reset authenticator</h2><p class="warn">${VERIFY_WARNING}</p><p class="muted">Removes the authenticator, the recovery codes and the password, ends every session and issues a new activation link.</p><form method="post" action="${base}/reset-authenticator" data-confirm="Reset this person’s authenticator?"><input type="hidden" name="_csrf" value="${csrfFor(ctx.token)}">${verifyField}<div class="row tight">${codeField}<button class="danger">Reset authenticator</button></div></form></div>`
            }
${locked && h`<div class="card"><h2>Unlock</h2><p class="muted">Clears the failed-attempt count so the person can try again now.</p>${post(ctx, `${base}/unlock`, h``, 'Unlock account')}</div>`}
<div class="card"><h2>Sessions</h2>${post(ctx, `${base}/revoke-sessions`, h``, 'Revoke all sessions')}</div>
<div class="card"><h2>${user.disabledAt ? 'Re-enable' : 'Disable'}</h2><p class="muted">A disabled person cannot sign in. Disabling ends every session at once.</p>${
              user.disabledAt ? post(ctx, `${base}/enable`, h``, 'Re-enable user') : post(ctx, `${base}/disable`, h``, 'Disable user', { danger: true, confirm: 'Disable this person?' })
            }</div></div></div>`,
          ),
        );
      });
      action('/users/:id/memberships', { name: 'client.membership.set' }, async ({ form, params, stepUp }) => {
        const user = await clientOf(params.id);
        const company = await companyOf(text(form, 'companyId'));
        const role = oneOf(text(form, 'role'), CLIENT_ROLES, 'role');
        await stepUp();
        await stores.directory.setMembership({ userId: user.id, companyId: company.id, role });
        return { target: clientParty(user), detail: { company: company.id, role }, redirect: `/ops/users/${user.id}?done=saved` };
      });
      action('/users/:id/memberships/remove', { name: 'client.membership.remove' }, async ({ form, params, stepUp }) => {
        const user = await clientOf(params.id);
        const company = await companyOf(text(form, 'companyId'));
        await stepUp();
        await stores.directory.removeMembership(user.id, company.id);
        return { target: clientParty(user), detail: { company: company.id }, redirect: `/ops/users/${user.id}?done=saved` };
      });
      action('/users/:id/activation-link', { name: 'client.activation_link' }, async ({ params, stepUp }) => {
        const user = await clientOf(params.id);
        if (user.activatedAt !== null) throw new OpsError('This account is already activated. Use "Reset authenticator" if the person has lost access.');
        if (user.disabledAt) throw new OpsError('Re-enable this person first.');
        await stepUp();
        const invite = await auth.createInvite(user.email);
        return { target: clientParty(user), detail: { expires: when(invite.expiresAt) }, title: `Activation link for ${user.name}`, show: linkPage(invite, user.name, `/ops/users/${user.id}`, false) };
      });
      action('/users/:id/unlock', { name: 'client.unlock' }, async ({ params, stepUp }) => {
        const user = await clientOf(params.id);
        await stepUp();
        await auth.unlock(user);
        return { target: clientParty(user), redirect: `/ops/users/${user.id}?done=unlocked` };
      });
      action('/users/:id/reset-authenticator', { name: 'client.reset_authenticator' }, async ({ ctx, form, params, source, stepUp }) => {
        const user = await clientOf(params.id);
        if (user.activatedAt === null) throw new OpsError('This account is not activated. Issue an activation link instead.');
        if (user.disabledAt) throw new OpsError('Re-enable this person first.');
        const verification = needVerification(form);
        await stepUp();
        const total = await auth.clearCredentials(user.id);
        await stores.audit.append({ at: now(), actor: opsParty(ctx.user), target: clientParty(user), action: 'client.session_revoked', outcome: 'success', source, detail: { sessions: String(total), why: 'authenticator reset' } });
        const invite = await auth.createInvite(user.email);
        return { target: clientParty(user), detail: { identityVerification: verification, expires: when(invite.expiresAt) }, title: `New activation link for ${user.name}`, show: linkPage(invite, user.name, `/ops/users/${user.id}`, true) };
      });
      action('/users/:id/revoke-sessions', { name: 'client.revoke_sessions' }, async ({ ctx, params, source, stepUp }) => {
        const user = await clientOf(params.id);
        await stepUp();
        const total = await revokeClientSessions(ctx, user, source, 'revoked by ops');
        return { target: clientParty(user), detail: { sessions: String(total) }, redirect: `/ops/users/${user.id}?done=revoked` };
      });
      action('/users/:id/disable', { name: 'client.disable' }, async ({ ctx, params, source, stepUp }) => {
        const user = await clientOf(params.id);
        await stepUp();
        await stores.directory.saveUser({ ...user, disabledAt: now() });
        await stores.auth.activations.deleteWhere((record) => record.userId === user.id);
        await revokeClientSessions(ctx, user, source, 'user disabled');
        return { target: clientParty(user), redirect: `/ops/users/${user.id}?done=disabled` };
      });
      action('/users/:id/enable', { name: 'client.enable' }, async ({ params, stepUp }) => {
        const user = await clientOf(params.id);
        await stepUp();
        await stores.directory.saveUser({ ...user, disabledAt: null });
        return { target: clientParty(user), redirect: `/ops/users/${user.id}?done=enabled` };
      });

      // --- Audit log: read only. There is no route that changes or removes an entry. ---
      page('/audit', {}, async (ctx, request, reply) => {
        const [actor, target, act, from, to] = ['actor', 'target', 'action', 'from', 'to'].map((name) => queryOf(request, name)) as [string, string, string, string, string];
        const day = (value: string, end: boolean): number | undefined => {
          if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
          const at = Date.parse(`${value}T00:00:00Z`);
          return Number.isNaN(at) ? undefined : at + (end ? 86_400_000 - 1 : 0);
        };
        const entries = await stores.audit.query({ actor, target, action: act, from: day(from, false), to: day(to, true), limit: 500 });
        return send(
          reply,
          200,
          layout(
            chromeOf(ctx, 'Audit log'),
            h`<div class="card"><form method="get" action="/ops/audit"><div class="row"><label>Actor <input name="actor" value="${actor}"></label><label>Target <input name="target" value="${target}"></label><label>Action <input name="action" value="${act}"></label><label>From (UTC) <input type="date" name="from" value="${from}"></label><label>To (UTC) <input type="date" name="to" value="${to}"></label><button class="quiet">Filter</button></div></form></div>
<div class="card"><table><tr><th>Time</th><th>Actor</th><th>Action</th><th>Target</th><th>Outcome</th><th>Source</th><th>Detail</th></tr>${entries.map(
              (entry) => h`<tr><td>${when(entry.at)}</td><td>${entry.actor.label} <span class="muted">(${entry.actor.type})</span></td><td>${entry.action}</td><td>${entry.target ? entry.target.label : ''}</td><td>${tag(entry.outcome === 'success', 'success', 'failure')}</td><td>${entry.source}</td><td>${Object.entries(entry.detail).map(([key, value]) => h`<div>${key}: ${value}</div>`)}</td></tr>`,
            )}</table>${entries.length === 0 && h`<p class="muted">No entries match.</p>`}<p class="muted">Newest first, at most 500 entries. Entries cannot be changed or removed.</p></div>`,
          ),
        );
      });

      // --- Ops staff (ops_admin only) ------------------------------------------------
      page('/staff', { admin: true }, async (ctx, request, reply) => {
        const staff = await stores.ops.users.list();
        return send(
          reply,
          200,
          layout(
            chromeOf(ctx, 'Ops staff', flashOf(request)),
            h`<div class="card"><table><tr><th>Name</th><th>Email</th><th>Role</th><th>Status</th><th>Last sign-in</th></tr>${staff.map(
              (user) => h`<tr><td><a href="/ops/staff/${user.id}">${user.name}</a></td><td>${user.email}</td><td>${user.role}</td><td>${user.disabledAt ? tag(false, '', 'Disabled') : tag(user.activatedAt !== null, 'Activated', 'Not activated')}</td><td>${when(user.lastSignInAt)}</td></tr>`,
            )}</table></div>
<div class="card"><h2>Invite a staff member</h2>${post(ctx, '/ops/staff', h`<label>Name <input name="name" required maxlength="120"></label><label>Email <input type="email" name="email" required maxlength="254"></label><label>Role ${roleSelect('role', OPS_ROLES)}</label>`, 'Invite')}</div>`,
          ),
        );
      });
      const staffParty = opsParty;
      action('/staff', { name: 'staff.invite', admin: true }, async ({ form, stepUp }) => {
        const name = need(form, 'name', 'Name');
        const email = needEmail(form);
        const role = oneOf(text(form, 'role'), OPS_ROLES, 'role');
        if (await stores.ops.users.findByEmail(email)) throw new OpsError('A staff account with that email already exists.');
        await stepUp();
        const user = await opsAuth.createUser(email, name, role);
        const invite = await opsAuth.createInvite(user.id);
        return { target: staffParty(user), detail: { role, expires: when(invite.expiresAt) }, title: `Activation link for ${user.name}`, show: linkPage(invite, user.name, `/ops/staff/${user.id}`, false) };
      });
      page('/staff/:id', { admin: true }, async (ctx, request, reply) => {
        const user = await staffOf((request.params as { id: string }).id);
        const base = `/ops/staff/${user.id}`;
        const self = user.id === ctx.user.id;
        return send(
          reply,
          200,
          layout(
            chromeOf(ctx, user.name, flashOf(request)),
            h`<div class="grid"><div class="card"><h2>Status</h2><dl><dt>Email</dt><dd>${user.email}</dd><dt>Role</dt><dd>${user.role}</dd><dt>Activated</dt><dd>${user.activatedAt ? `Yes, ${when(user.activatedAt)}` : 'No'}</dd><dt>Last sign-in</dt><dd>${when(user.lastSignInAt)}</dd><dt>Account</dt><dd>${tag(!user.disabledAt, 'Enabled', 'Disabled')}</dd></dl></div>
<div>${
              self
                ? h`<div class="card"><p class="muted">This is your own account. You cannot change your own role, disable yourself or reset your own authenticator.</p></div>`
                : h`<div class="card"><h2>Role</h2>${post(ctx, `${base}/role`, h`<label>Role ${roleSelect('role', OPS_ROLES, user.role)}</label>`, 'Change role')}</div>
${
  user.activatedAt === null
    ? h`<div class="card"><h2>Activation link</h2>${post(ctx, `${base}/activation-link`, h``, 'Issue activation link')}</div>`
    : h`<div class="card"><h2>Reset authenticator</h2><p class="warn">${VERIFY_WARNING}</p><form method="post" action="${base}/reset-authenticator" data-confirm="Reset this staff member’s authenticator?"><input type="hidden" name="_csrf" value="${csrfFor(ctx.token)}">${verifyField}<div class="row tight">${codeField}<button class="danger">Reset authenticator</button></div></form></div>`
}
<div class="card"><h2>${user.disabledAt ? 'Re-enable' : 'Disable'}</h2>${user.disabledAt ? post(ctx, `${base}/enable`, h``, 'Re-enable') : post(ctx, `${base}/disable`, h``, 'Disable', { danger: true, confirm: 'Disable this staff member?' })}</div>`
            }</div></div>`,
          ),
        );
      });
      action('/staff/:id/role', { name: 'staff.role', admin: true }, async ({ ctx, form, params, stepUp }) => {
        const user = await staffOf(params.id);
        const role = oneOf(text(form, 'role'), OPS_ROLES, 'role');
        if (role !== 'ops_admin') await assertStaffRemovalAllowed(stores, ctx.user.id, user);
        await stepUp();
        await stores.ops.users.save({ ...user, role });
        return { target: staffParty(user), detail: { role }, redirect: `/ops/staff/${user.id}?done=saved` };
      });
      action('/staff/:id/disable', { name: 'staff.disable', admin: true }, async ({ ctx, params, source, stepUp }) => {
        const user = await staffOf(params.id);
        await assertStaffRemovalAllowed(stores, ctx.user.id, user);
        await stepUp();
        await stores.ops.users.save({ ...user, disabledAt: now() });
        await stores.ops.activations.deleteWhere((record) => record.userId === user.id);
        const total = await opsAuth.revokeAllSessions(user.id);
        await stores.audit.append({ at: now(), actor: opsParty(ctx.user), target: staffParty(user), action: 'ops.session_revoked', outcome: 'success', source, detail: { sessions: String(total), why: 'staff disabled' } });
        return { target: staffParty(user), redirect: `/ops/staff/${user.id}?done=disabled` };
      });
      action('/staff/:id/enable', { name: 'staff.enable', admin: true }, async ({ params, stepUp }) => {
        const user = await staffOf(params.id);
        await stepUp();
        await stores.ops.users.save({ ...user, disabledAt: null });
        return { target: staffParty(user), redirect: `/ops/staff/${user.id}?done=enabled` };
      });
      action('/staff/:id/activation-link', { name: 'staff.activation_link', admin: true }, async ({ params, stepUp }) => {
        const user = await staffOf(params.id);
        if (user.activatedAt !== null) throw new OpsError('This account is already activated.');
        if (user.disabledAt) throw new OpsError('Re-enable this staff member first.');
        await stepUp();
        const invite = await opsAuth.createInvite(user.id);
        return { target: staffParty(user), detail: { expires: when(invite.expiresAt) }, title: `Activation link for ${user.name}`, show: linkPage(invite, user.name, `/ops/staff/${user.id}`, false) };
      });
      action('/staff/:id/reset-authenticator', { name: 'staff.reset_authenticator', admin: true }, async ({ ctx, form, params, source, stepUp }) => {
        const user = await staffOf(params.id);
        if (user.activatedAt === null) throw new OpsError('This account is not activated. Issue an activation link instead.');
        if (user.disabledAt) throw new OpsError('Re-enable this staff member first.');
        await assertStaffRemovalAllowed(stores, ctx.user.id, user);
        const verification = needVerification(form);
        await stepUp();
        const total = await opsAuth.clearCredentials(user.id);
        await stores.audit.append({ at: now(), actor: opsParty(ctx.user), target: staffParty(user), action: 'ops.session_revoked', outcome: 'success', source, detail: { sessions: String(total), why: 'authenticator reset' } });
        const invite = await opsAuth.createInvite(user.id);
        return { target: staffParty(user), detail: { identityVerification: verification, expires: when(invite.expiresAt) }, title: `New activation link for ${user.name}`, show: linkPage(invite, user.name, `/ops/staff/${user.id}`, true) };
      });
    },
    { prefix: '/ops' },
  );
  return routes;
}
