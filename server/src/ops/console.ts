/**
 * The ops console: server-rendered pages under /ops for Global Connect staff.
 *
 * Separate from the client API in every respect: its own account table, its
 * own session cookie and session table, its own routes. It reads no bearer
 * token, and the client API reads no cookie.
 *
 * Three things keep one staff member from becoming a client or re-pointing a
 * client's money:
 *  1. No activation link or code is ever rendered. Links go by email to the
 *     address on file (Mailer); the console shows only a masked address.
 *  2. FOUR-EYES: the sensitive actions (see `fourEyes` below) only create a
 *     request. A DIFFERENT active staff member must approve it, with their own
 *     fresh authenticator code, before anything changes.
 *  3. A company's provider mapping can be set only by an ops admin, to an
 *     account the provider confirms exists and that no other company uses.
 *
 * Every state-changing request needs the session cookie, the CSRF field and a
 * fresh authenticator code from the staff member (step-up), and is written to
 * the audit log whether it succeeded or not. There is no route that reads or
 * sets someone else's password, authenticator key or recovery codes, none
 * that reaches a provider's balances, transactions or payments, and none that
 * starts a client session.
 */
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import type { UserRole } from '@/api/types';

import { reasonOf, type AuthService } from '../auth/service';
import type { Config } from '../config';
import { randomToken, safeEqual, sha256 } from '../crypto';
import { ApiError } from '../errors';
import { activationMessage, maskEmail, type Mailer } from '../mailer';
import type { ProviderRegistry } from '../providers/adapter';
import { emailDomain, hasControlCharacters, isEmail, nameKey } from '../validate';
import type { ApprovalRecord, AuditParty, CompanyRecord, OpsRole, OpsUserRecord, ProviderKey, Stores, UserRecord } from '../store/types';
import { isActiveStaff, opsParty, type OpsAuthService, type OpsContext } from './auth';
import { codeField, h, Html, layout, qrSvg, when } from './html';

export interface OpsDeps {
  config: Config;
  stores: Stores;
  auth: AuthService;
  opsAuth: OpsAuthService;
  registry: ProviderRegistry;
  mailer: Mailer;
  now: () => number;
  limitAttempts: (request: FastifyRequest) => Promise<void>;
}

const CLIENT_ROLES: UserRole[] = ['creator', 'approver', 'admin'];
const OPS_ROLES: OpsRole[] = ['ops', 'ops_admin'];
const PRE_SESSION_MS = 30 * 60_000;

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
  code_reused: 'That code has already been used. Nothing was changed.',
  locked: 'Too many wrong attempts. Try again later.',
  invalid_credentials: 'The email or password is not right.',
  challenge_expired: 'That sign-in attempt has expired. Start again.',
  activation_invalid: 'That activation code is not valid. It may have expired, been used or been replaced.',
  weak_password: 'Choose a password of at least 12 characters that is not a common one.',
};
function messageOf(error: unknown): string {
  if (error instanceof OpsError) return error.message;
  if (!(error instanceof ApiError)) return 'Something went wrong.';
  const reason = error.options.reason ?? '';
  // Accurate about the wait: the next code appears when the authenticator's 30-second step changes.
  if (reason === 'code_reused') return `${MESSAGES.code_reused} Your authenticator shows a new code in about ${error.options.retryAfterSeconds ?? 30} seconds; use that one.`;
  return MESSAGES[reason] ?? (error.kind === 'not_found' ? 'Not found.' : error.kind === 'rate_limited' ? 'Too many requests. Try again shortly.' : 'The request was not accepted.');
}
const statusOf = (error: unknown): number => (error instanceof OpsError ? error.status : error instanceof ApiError ? error.status : 500);

/** A staff member may not remove their own access, and the last active ops admin may not be removed. */
export async function assertStaffRemovalAllowed(stores: Stores, actorId: string, target: OpsUserRecord): Promise<void> {
  if (actorId === target.id) throw new OpsError('You cannot do this to your own account.', 403, 'self');
  if (target.role !== 'ops_admin') return;
  const others = (await stores.ops.users.list()).filter((user) => user.id !== target.id && user.role === 'ops_admin' && isActiveStaff(user));
  if (others.length === 0) throw new OpsError('This is the last active ops admin and cannot be removed.', 403, 'last_admin');
}

type Form = Record<string, string>;
const text = (form: Form, name: string): string => (typeof form[name] === 'string' ? (form[name] as string) : '').trim();
function need(form: Form, name: string, label: string, max = 120): string {
  const value = text(form, name);
  if (!value || value.length > max) throw new OpsError(`${label} is required (at most ${max} characters).`);
  // Names and ids end up in emails, summaries and logs: nothing that could start a new line or hide text.
  if (hasControlCharacters(value)) throw new OpsError(`${label} contains characters that are not allowed.`);
  return value;
}
function needEmail(form: Form): string {
  const email = need(form, 'email', 'Email', 254).toLowerCase();
  if (!isEmail(email)) throw new OpsError('That email address does not look right. Use a plain address such as name@company.com.');
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
  const { config, stores, auth, opsAuth, registry, mailer, now, limitAttempts } = deps;
  const routes: { method: string; url: string }[] = [];
  // Outside development OPS_URL must be https (config.ts), so the cookie is always Secure there.
  const secure = config.opsUrl.startsWith('https://');
  // With Secure the cookies take the __Host- prefix (which requires Path=/): a sibling subdomain cannot plant or overwrite them.
  const SESSION_COOKIE = secure ? '__Host-gc_ops_session' : 'gc_ops_session';
  const PRE_COOKIE = secure ? '__Host-gc_ops_pre' : 'gc_ops_pre';
  const cookie = (name: string, value: string, clear = false) =>
    `${name}=${value}; Path=${secure ? '/' : '/ops'}; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}${clear ? '; Max-Age=0' : ''}`;
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
        // A repeated field keeps its last value; every value is a string.
        done(null, Object.fromEntries(new URLSearchParams(body as string)));
      });
      ops.addHook('onSend', async (_request, reply) => {
        reply.header('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");
        reply.header('X-Frame-Options', 'DENY');
        reply.header('Referrer-Policy', 'no-referrer');
        reply.header('Cache-Control', 'no-store');
        reply.header('X-Content-Type-Options', 'nosniff');
        if (secure) reply.header('Strict-Transport-Security', 'max-age=31536000');
      });

      const send = (reply: FastifyReply, status: number, page: string) => reply.status(status).type('text/html; charset=utf-8').send(page);
      const chromeOf = (ctx: OpsContext, title: string, flash?: string) => ({ title, user: ctx.user, csrf: csrfFor(ctx.token), flash });
      const problem = (reply: FastifyReply, ctx: OpsContext | null, error: unknown) => {
        const status = statusOf(error);
        if (error instanceof ApiError && error.options.retryAfterSeconds !== undefined) reply.header('Retry-After', String(error.options.retryAfterSeconds));
        if (status >= 500) app.log.error({ message: error instanceof Error ? error.message : 'unknown error' }, 'ops request failed');
        return send(
          reply,
          status,
          layout(
            { title: status === 404 ? 'Not found' : 'Not done', user: ctx?.user ?? null, csrf: ctx ? csrfFor(ctx.token) : '' },
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
      const fieldOk = (request: FastifyRequest, anchor: string | undefined): boolean => {
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
      /** One value of a query parameter, however many times it was given. */
      const queryOf = (request: FastifyRequest, name: string): string => {
        const value = (request.query as Record<string, unknown>)[name];
        const first = Array.isArray(value) ? value[0] : value;
        return typeof first === 'string' ? first.trim().slice(0, 200) : '';
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

      // --- Actions -------------------------------------------------------------------

      /** What an action will do, checked and ready, but not done. `params` is what is stored for a second staff member to approve: never a credential. */
      interface Prepared {
        params: Record<string, string>;
        /** One line for the approver. */
        summary: string;
        warnings?: string[];
      }
      interface Actors {
        requester: OpsUserRecord;
        /** Null when the action needs no second person (or four-eyes is off in development). */
        approver: OpsUserRecord | null;
        source: string;
      }
      interface Applied {
        target: AuditParty | null;
        detail?: Record<string, string>;
        redirect: string;
      }
      interface PrepareInput {
        actor: OpsUserRecord;
        form: Form;
        params: Record<string, string>;
        /** Names who or what the action is about, as early as possible, so that a refusal is logged against it. */
        aim: (target: AuditParty) => void;
      }
      interface ActionDef {
        name: string;
        admin?: boolean;
        /** Needs approval by a second staff member. A function when it depends on what is being changed. */
        fourEyes?: boolean | ((params: Record<string, string>) => boolean);
        /**
         * The second person must be an ops admin. For everything that decides who is staff or which
         * provider account a company's money is in: an ops user must not be able to wave those through.
         */
        adminApproval?: boolean | ((params: Record<string, string>) => boolean);
        /** The result is an activation email; the approval page then says where it went. */
        mails?: boolean;
        prepare(input: PrepareInput): Promise<Prepared>;
        /** Does it. Re-checks everything: by the time a request is approved, things may have changed. */
        apply(params: Record<string, string>, actors: Actors): Promise<Applied>;
      }
      const actions = new Map<string, ActionDef>();
      const needsApproval = (def: ActionDef, params: Record<string, string>): boolean =>
        config.fourEyes && (typeof def.fourEyes === 'function' ? def.fourEyes(params) : def.fourEyes === true);
      const needsAdminApproval = (def: ActionDef, params: Record<string, string>): boolean =>
        typeof def.adminApproval === 'function' ? def.adminApproval(params) : def.adminApproval === true;
      const person = (user: OpsUserRecord) => ({ id: user.id, email: user.email });
      const append = (actor: AuditParty, action: string, outcome: 'success' | 'failure', target: AuditParty | null, source: string, detail: Record<string, string>) =>
        stores.audit.append({ at: now(), actor, target, action, outcome, source, detail });

      /**
       * The frame every state-changing POST runs in: session, CSRF field, role,
       * `run` (which must call stepUp before changing anything) and an audit
       * entry for the outcome, with the target when it is known.
       */
      interface PostInput {
        ctx: OpsContext;
        form: Form;
        params: Record<string, string>;
        source: string;
        aim: (target: AuditParty) => void;
        stepUp: () => Promise<void>;
      }
      const post = (url: string, options: { name: string; admin?: boolean }, run: (input: PostInput) => Promise<{ detail?: Record<string, string>; redirect: string; audited?: boolean }>) =>
        ops.post(url, { preHandler: limitAttempts }, async (request, reply) => {
          const ctx = await sessionOf(request);
          if (!ctx) return problem(reply, null, new OpsError('Your session has ended. Sign in again.', 401));
          if (!fieldOk(request, ctx.token)) return problem(reply, ctx, new OpsError('This form could not be verified. Reload the page and try again.', 403));
          const form = (request.body ?? {}) as Form;
          let target: AuditParty | null = null;
          let steppedUp = false;
          try {
            if (options.admin && ctx.user.role !== 'ops_admin') throw new OpsError('Only an ops admin can do that.', 403, 'forbidden');
            const result = await run({
              ctx,
              form,
              params: request.params as Record<string, string>,
              source: request.ip,
              aim: (party) => {
                target = party;
              },
              stepUp: async () => {
                await opsAuth.stepUp(ctx, text(form, 'code'), options.name, request.ip);
                steppedUp = true;
              },
            });
            if (!steppedUp) throw new Error(`ops action ${options.name} ran without step-up`);
            if (!result.audited) await append(opsParty(ctx.user), `ops.${options.name}`, 'success', target, request.ip, result.detail ?? {});
            return reply.redirect(result.redirect, 303);
          } catch (error) {
            await append(opsParty(ctx.user), `ops.${options.name}`, 'failure', target, request.ip, { reason: error instanceof OpsError ? error.reason : reasonOf(error) });
            return problem(reply, ctx, error);
          }
        });

      /** Registers a console action: done at once, or turned into a request for a second staff member. */
      const action = (url: string, def: ActionDef) => {
        actions.set(def.name, def);
        post(url, { name: def.name, admin: def.admin }, async ({ ctx, form, params, source, aim, stepUp }) => {
          let target: AuditParty | null = null;
          const prepared = await def.prepare({
            actor: ctx.user,
            form,
            params,
            aim: (party) => {
              target = party;
              aim(party);
            },
          });
          await stepUp();
          if (!needsApproval(def, prepared.params)) {
            const applied = await def.apply(prepared.params, { requester: ctx.user, approver: null, source });
            const about = applied.target ?? target;
            if (about) aim(about);
            return { detail: applied.detail, redirect: applied.redirect };
          }
          const request: ApprovalRecord = {
            id: `req_${randomToken().slice(0, 16)}`,
            action: def.name,
            params: prepared.params,
            summary: prepared.summary,
            warnings: prepared.warnings ?? [],
            target,
            requestedBy: person(ctx.user),
            requestedAt: now(),
            expiresAt: now() + config.approvalTtlMs,
            status: 'pending',
            decidedBy: null,
            decidedAt: null,
          };
          await stores.ops.approvals.put(request.id, request);
          await append(opsParty(ctx.user), 'ops.approval.request', 'success', target, source, { request: request.id, action: def.name, summary: prepared.summary });
          return { redirect: `/ops/approvals/${request.id}?done=requested`, audited: true };
        });
      };

      // --- Static files (no session needed: they hold nothing private) ---------
      ops.get('/static/:file', async (request, reply) => {
        const file = files[(request.params as { file: string }).file];
        if (!file?.body) return reply.status(404).type('text/plain').send('Not found');
        return reply.type(file.type).send(file.body);
      });

      // --- Activation and sign-in (no session yet) -------------------------------
      /**
       * The cookie that anchors the CSRF field before there is a session. It
       * is a value the server SIGNED (expiry, a random part, HMAC with the
       * server's key), so nothing is stored per visitor: any number of
       * requests for the sign-in page cost no memory and cannot push out
       * somebody else's anchor. A value the server did not sign, or one past
       * its half hour, anchors nothing.
       */
      const signAnchor = (body: string): string => createHmac('sha256', config.serverSecret).update(`ops-pre-login:${body}`).digest('base64url');
      const preAnchorKnown = (anchor: string | undefined): boolean => {
        const [expires = '', nonce = '', signature = ''] = (anchor ?? '').split('.');
        if (!/^\d{1,16}$/.test(expires) || !nonce || !signature || (anchor ?? '').split('.').length !== 3) return false;
        return Number(expires) > now() && safeEqual(signAnchor(`${expires}.${nonce}`), signature);
      };
      const preAnchor = (request: FastifyRequest, reply: FastifyReply): string => {
        const existing = cookiesOf(request)[PRE_COOKIE];
        if (existing && preAnchorKnown(existing)) return existing;
        const body = `${now() + PRE_SESSION_MS}.${randomToken()}`;
        const fresh = `${body}.${signAnchor(body)}`;
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
          if (!fieldOk(request, anchor) || !preAnchorKnown(anchor)) return problem(reply, null, new OpsError('This form could not be verified. Reload the page and try again.', 403));
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

      // Rate limited like the posts: these pages are open to anyone.
      ops.get('/activate', { preHandler: limitAttempts }, async (request, reply) => activateForm(reply, preAnchor(request, reply)));
      publicPost(
        '/activate',
        async (form, anchor, _request, reply) => passwordForm(reply, anchor, text(form, 'activationCode'), await opsAuth.activationStart(text(form, 'activationCode'))),
        (_form, anchor, message, reply) => activateForm(reply, anchor, message),
      );
      publicPost(
        '/activate/password',
        async (form, anchor, _request, reply) => enrolForm(reply, anchor, text(form, 'activationCode'), await opsAuth.activationPassword(text(form, 'activationCode'), typeof form.password === 'string' ? form.password : '')),
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
      ops.get('/login', { preHandler: limitAttempts }, async (request, reply) => loginForm(reply, preAnchor(request, reply)));
      publicPost(
        '/login',
        async (form, anchor, request, reply) => codeForm(reply, anchor, (await opsAuth.login(text(form, 'email'), typeof form.password === 'string' ? form.password : '', request.ip)).challengeId),
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
        if (!fieldOk(request, token)) return problem(reply, null, new OpsError('This form could not be verified.', 403));
        await opsAuth.logout(token, request.ip);
        return reply.header('Set-Cookie', cookie(SESSION_COOKIE, '', true)).redirect('/ops/login', 303);
      });

      // --- Shared page pieces ------------------------------------------------------
      const FLASH: Record<string, string> = {
        saved: 'Saved.',
        created: 'Created.',
        unlocked: 'Account unlocked.',
        revoked: 'Sessions revoked.',
        disabled: 'Disabled.',
        enabled: 'Re-enabled.',
        mailed: 'An activation email was sent to the address on file. The link is not shown to staff.',
        requested: 'Request created. Nothing has changed yet: a different staff member must approve it.',
        approved: 'Approved and carried out.',
        rejected: 'Request rejected. Nothing was changed.',
        cancelled: 'Request cancelled. Nothing was changed.',
      };
      const flashOf = (request: FastifyRequest): string | undefined => FLASH[queryOf(request, 'done')];
      const csrfInput = (ctx: OpsContext) => h`<input type="hidden" name="_csrf" value="${csrfFor(ctx.token)}">`;
      /** A one-line form with the step-up field. `request` marks an action that only creates a request for approval. */
      const form = (ctx: OpsContext, url: string, fields: Html, button: string, options: { danger?: boolean; confirm?: string; request?: boolean } = {}) =>
        h`<form method="post" action="${url}"${options.confirm ? h` data-confirm="${options.confirm}"` : ''}>${csrfInput(ctx)}<div class="row tight">${fields}${codeField}<button${options.danger ? h` class="danger"` : ''}>${options.request && config.fourEyes ? `Request: ${button}` : button}</button></div></form>`;
      const fourEyesNote = config.fourEyes ? h`<p class="muted">Needs approval by a second staff member before it takes effect.</p>` : h``;
      const search = (url: string, q: string, label: string) =>
        h`<form method="get" action="${url}"><label>${label} <input type="search" name="q" value="${q}"></label><button class="quiet">Search</button></form>`;
      const tag = (ok: boolean, yes: string, no: string) => h`<span class="tag ${ok ? 'ok' : 'bad'}">${ok ? yes : no}</span>`;
      const roleSelect = (name: string, roles: readonly string[], current = '', blank = false) =>
        h`<select name="${name}">${blank && h`<option value="">—</option>`}${roles.map((role) => h`<option value="${role}"${role === current ? h` selected` : ''}>${role}</option>`)}</select>`;
      const VERIFY_WARNING =
        'Verify this person’s identity BEFORE resetting. The new activation link is emailed to the address on file; whoever controls that mailbox controls the account. Use a contact detail already on file, not one given in the request.';
      const verifyField = h`<label>How was identity verified? (kept in the audit log and shown to the approver) <textarea name="verification" required minlength="10" maxlength="500" rows="2"></textarea></label>`;
      const needVerification = (input: Form): string => {
        const value = text(input, 'verification');
        if (value.length < 10 || value.length > 500) throw new OpsError('Say how the person’s identity was verified (10 to 500 characters).');
        return value;
      };

      const clientParty = (user: UserRecord): AuditParty => ({ type: 'client', id: user.id, label: user.email });
      const companyParty = (company: Pick<CompanyRecord, 'id' | 'name'>): AuditParty => ({ type: 'company', id: company.id, label: company.name });
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
      const revokeClientSessions = async (actor: OpsUserRecord, user: UserRecord, source: string, why: string): Promise<number> => {
        const total = await auth.revokeAllSessions(user.id);
        await append(opsParty(actor), 'client.session_revoked', 'success', clientParty(user), source, { sessions: String(total), why });
        return total;
      };
      /** Emails a new activation link to the address on file. The link itself never reaches the console. */
      const mailClientLink = async (user: UserRecord): Promise<Record<string, string>> => {
        const invite = await auth.createInvite(user.email);
        await mailer.send(activationMessage(invite, user.email, user.name, 'client'));
        return { sentTo: maskEmail(user.email), expires: when(invite.expiresAt) };
      };
      const mailStaffLink = async (user: OpsUserRecord): Promise<Record<string, string>> => {
        const invite = await opsAuth.createInvite(user.id);
        await mailer.send(activationMessage(invite, user.email, user.name, 'staff'));
        return { sentTo: maskEmail(user.email), expires: when(invite.expiresAt) };
      };

      ops.get('/', async (_request, reply) => reply.redirect('/ops/users', 303));

      // --- Approvals (four-eyes) ---------------------------------------------------------
      /** Marks requests past their 24 hours as expired, and records each one. */
      const expireApprovals = async (): Promise<void> => {
        const at = now();
        for (const stale of await stores.ops.approvals.list({ status: 'pending' }, (item) => item.expiresAt <= at)) {
          let mine = false;
          await stores.ops.approvals.mutate(stale.id, (current) => {
            mine = current !== null && current.status === 'pending';
            return mine && current ? { ...current, status: 'expired', decidedAt: at } : undefined;
          });
          if (mine) {
            await append({ type: 'system', id: null, label: 'expiry' }, 'ops.approval.expire', 'success', stale.target, '', { request: stale.id, action: stale.action, requestedBy: stale.requestedBy.email });
          }
        }
      };
      const approvalOf = async (id: string | undefined): Promise<ApprovalRecord> => {
        await expireApprovals();
        const request = id ? await stores.ops.approvals.get(id) : null;
        if (!request) throw new OpsError('No such request.', 404, 'not_found');
        return request;
      };
      /** Moves a pending request to its final state. Atomic: of two decisions arriving together, one wins. */
      const decide = async (request: ApprovalRecord, status: 'approved' | 'rejected' | 'cancelled', by: OpsUserRecord): Promise<void> => {
        const decidedAt = now();
        const changed = await stores.ops.approvals.mutate(request.id, (current) =>
          current && current.status === 'pending' && current.expiresAt > decidedAt ? { ...current, status, decidedBy: person(by), decidedAt } : undefined,
        );
        if (!changed || changed.status !== status || changed.decidedBy?.id !== by.id || changed.decidedAt !== decidedAt) throw new OpsError('This request is no longer waiting for a decision.', 409, 'not_pending');
      };
      /** How often this approver has been the one to approve this requester lately. Shown to the approver, and kept with the approval. */
      const pairHistory = async (requesterId: string, approverId: string): Promise<{ byRequester: number; byPair: number; flag: boolean }> => {
        const since = now() - 30 * 24 * 60 * 60_000;
        const approved = await stores.ops.approvals.list({ status: 'approved' }, (item) => item.requestedBy.id === requesterId && (item.decidedAt ?? 0) >= since);
        const byPair = approved.filter((item) => item.decidedBy?.id === approverId).length;
        return { byRequester: approved.length, byPair, flag: byPair >= 5 && byPair * 5 >= approved.length * 4 };
      };
      const statusTag = (request: ApprovalRecord) => h`<span class="tag ${request.status === 'approved' ? 'ok' : request.status === 'pending' ? '' : 'bad'}">${request.status}</span>`;

      page('/approvals', {}, async (ctx, request, reply) => {
        await expireApprovals();
        const all = (await stores.ops.approvals.list()).sort((a, b) => b.requestedAt - a.requestedAt);
        const row = (item: ApprovalRecord) =>
          h`<tr><td><a href="/ops/approvals/${item.id}">${item.summary}</a></td><td>${item.requestedBy.email}</td><td>${when(item.requestedAt)}</td><td>${statusTag(item)}</td><td>${item.status === 'pending' ? `expires ${when(item.expiresAt)}` : item.decidedBy ? `${item.decidedBy.email}, ${when(item.decidedAt)}` : when(item.decidedAt)}</td></tr>`;
        const pending = all.filter((item) => item.status === 'pending');
        return send(
          reply,
          200,
          layout(
            chromeOf(ctx, 'Approvals', flashOf(request)),
            h`<div class="card"><h2>Waiting for a second staff member</h2><table><tr><th>Request</th><th>Requested by</th><th>When</th><th>Status</th><th></th></tr>${pending.map(row)}</table>${pending.length === 0 && h`<p class="muted">Nothing is waiting.</p>`}<p class="muted">A request is approved by a different staff member than the one who made it, and expires after 24 hours.</p></div>
<div class="card"><h2>Decided (latest 50)</h2><table><tr><th>Request</th><th>Requested by</th><th>When</th><th>Status</th><th>Decided</th></tr>${all.filter((item) => item.status !== 'pending').slice(0, 50).map(row)}</table></div>`,
          ),
        );
      });
      page('/approvals/:id', {}, async (ctx, request, reply) => {
        const item = await approvalOf((request.params as { id: string }).id);
        const def = actions.get(item.action);
        const base = `/ops/approvals/${item.id}`;
        const mine = item.requestedBy.id === ctx.user.id;
        const aboutMe = item.target?.type === 'ops' && item.target.id === ctx.user.id;
        const adminOnly = def ? needsAdminApproval(def, item.params) : true;
        const history = await pairHistory(item.requestedBy.id, ctx.user.id);
        return send(
          reply,
          200,
          layout(
            chromeOf(ctx, 'Approval request', flashOf(request)),
            h`<div class="grid"><div class="card"><h2>${item.summary} ${statusTag(item)}</h2>${item.warnings.map((warning) => h`<p class="warn">${warning}</p>`)}<dl><dt>Action</dt><dd>${item.action}</dd><dt>About</dt><dd>${item.target?.label ?? ''}</dd><dt>Requested by</dt><dd>${item.requestedBy.email}, ${when(item.requestedAt)}</dd><dt>Expires</dt><dd>${when(item.expiresAt)}</dd>${
              item.decidedBy && h`<dt>Decided by</dt><dd>${item.decidedBy.email}, ${when(item.decidedAt)}</dd>`
            }${Object.entries(item.params).map(([key, value]) => h`<dt>${key}</dt><dd>${value}</dd>`)}</dl>${
              item.status === 'approved' && def?.mails && item.target && h`<p class="flash">An activation email was sent to ${maskEmail(item.target.label)}. The link is not shown to staff.</p>`
            }</div>
<div>${
              item.status !== 'pending'
                ? h`<div class="card"><p class="muted">This request is ${item.status}.</p></div>`
                : mine
                  ? h`<div class="card"><h2>Your request</h2><p class="muted">You cannot approve your own request. A different staff member must do it.</p>${form(ctx, `${base}/cancel`, h``, 'Cancel request')}</div>`
                  : h`<div class="card"><h2>Decide</h2>${
                      aboutMe
                        ? h`<p class="muted">This request is about your own account, so you cannot approve it.</p>`
                        : adminOnly && ctx.user.role !== 'ops_admin'
                          ? h`<p class="muted">Only an ops admin can approve this kind of request (it changes who is staff, or which provider account a company uses).</p>`
                          : h`<p class="${history.flag ? 'warn' : 'muted'}">In the last 30 days ${item.requestedBy.email} has had ${history.byRequester} ${history.byRequester === 1 ? 'request' : 'requests'} approved, ${history.byPair} of them by you.${history.flag ? ' You approve most of this person’s requests: a second pair of eyes only works if it is not always the same pair.' : ''}</p><p class="muted">Approving carries the change out now, in your name and the requester’s. Check it against what you know.</p>${form(ctx, `${base}/approve`, h``, 'Approve', { confirm: 'Approve and carry out this change?' })}`
                    }${form(ctx, `${base}/reject`, h``, 'Reject', { danger: true })}</div>`
            }</div></div>`,
          ),
        );
      });
      post('/approvals/:id/approve', { name: 'approval.approve' }, async ({ ctx, params, source, aim, stepUp }) => {
        const item = await approvalOf(params.id);
        if (item.target) aim(item.target);
        const def = actions.get(item.action);
        if (!def || item.status !== 'pending') throw new OpsError('This request is no longer waiting for a decision.', 409, 'not_pending');
        // Four eyes: never the person who asked, and never the person the request is about.
        if (item.requestedBy.id === ctx.user.id) throw new OpsError('You cannot approve your own request. A different staff member must do it.', 403, 'own_request');
        if (item.target?.type === 'ops' && item.target.id === ctx.user.id) throw new OpsError('This request is about your own account, so you cannot approve it.', 403, 'self');
        // Who is staff, and where a company's money is, are decided by two ops ADMINS.
        if (needsAdminApproval(def, item.params) && ctx.user.role !== 'ops_admin') throw new OpsError('Only an ops admin can approve this kind of request.', 403, 'admin_approval');
        const history = await pairHistory(item.requestedBy.id, ctx.user.id);
        const requester = await stores.ops.users.get(item.requestedBy.id);
        if (!requester || !isActiveStaff(requester) || (def.admin && requester.role !== 'ops_admin')) throw new OpsError('The staff member who made this request can no longer make it. Reject it instead.', 409, 'requester_inactive');
        await stepUp();
        await decide(item, 'approved', ctx.user);
        let applied: Applied;
        try {
          applied = await def.apply(item.params, { requester, approver: ctx.user, source });
        } catch (error) {
          // It could not be carried out (things changed since it was asked for): it goes back to waiting.
          await stores.ops.approvals.mutate(item.id, (current) => (current && current.status === 'approved' ? { ...current, status: 'pending', decidedBy: null, decidedAt: null } : undefined));
          throw error;
        }
        const both = { request: item.id, requestedBy: requester.email, approvedBy: ctx.user.email, pairApprovals30d: String(history.byPair + 1) };
        await append(opsParty(requester), `ops.${def.name}`, 'success', applied.target ?? item.target, source, { ...applied.detail, ...both });
        await append(opsParty(ctx.user), 'ops.approval.approve', 'success', applied.target ?? item.target, source, { ...both, action: def.name });
        return { redirect: `/ops/approvals/${item.id}?done=approved`, audited: true };
      });
      post('/approvals/:id/reject', { name: 'approval.reject' }, async ({ ctx, params, aim, stepUp }) => {
        const item = await approvalOf(params.id);
        if (item.target) aim(item.target);
        if (item.requestedBy.id === ctx.user.id) throw new OpsError('To withdraw your own request, cancel it.', 403, 'own_request');
        await stepUp();
        await decide(item, 'rejected', ctx.user);
        return { detail: { request: item.id, action: item.action, requestedBy: item.requestedBy.email, rejectedBy: ctx.user.email }, redirect: `/ops/approvals/${item.id}?done=rejected` };
      });
      post('/approvals/:id/cancel', { name: 'approval.cancel' }, async ({ ctx, params, aim, stepUp }) => {
        const item = await approvalOf(params.id);
        if (item.target) aim(item.target);
        if (item.requestedBy.id !== ctx.user.id) throw new OpsError('Only the staff member who made a request can cancel it. You can reject it.', 403, 'not_requester');
        await stepUp();
        await decide(item, 'cancelled', ctx.user);
        return { detail: { request: item.id, action: item.action, requestedBy: item.requestedBy.email }, redirect: `/ops/approvals/${item.id}?done=cancelled` };
      });

      // --- Companies ---------------------------------------------------------------
      const companyFields = (company: Partial<CompanyRecord> = {}) =>
        h`<label>Name <input name="name" required maxlength="120" value="${company.name ?? ''}"></label>
<label>Provider <select name="provider" required>${providerKeys.map((key) => h`<option value="${PROVIDERS[key].slug}"${company.providerKey === key ? h` selected` : ''}>${PROVIDERS[key].label}</option>`)}</select></label>
<label>Provider account id <input name="providerAccountId" required maxlength="120" value="${company.providerAccountId ?? ''}"></label>
<label>Provider contact id (required for provider A) <input name="providerContactId" maxlength="120" value="${company.providerContactId ?? ''}"></label>`;
      type Mapping = Pick<CompanyRecord, 'providerKey' | 'providerAccountId' | 'providerContactId'>;
      const mappingOf = (input: Record<string, string>): Mapping & { name: string } => {
        const providerKey = providerKeys.find((key) => PROVIDERS[key].slug === text(input, 'provider'));
        if (!providerKey) throw new OpsError('Choose a provider.');
        const providerContactId = text(input, 'providerContactId').slice(0, 120);
        if (providerKey === 'currencycloud' && !providerContactId) throw new OpsError('Provider A needs the client’s contact id: every call is made on behalf of that contact.');
        return { name: need(input, 'name', 'Name'), providerKey, providerAccountId: need(input, 'providerAccountId', 'Provider account id'), providerContactId };
      };
      /** How a company is named to an approver: always with its id, and with its old name if it was renamed lately. */
      const RENAME_SHOWN_MS = 30 * 24 * 60 * 60_000;
      const describe = (company: CompanyRecord): string =>
        `“${company.name}” (${company.id}${company.previousName && company.renamedAt && now() - company.renamedAt < RENAME_SHOWN_MS ? `; named “${company.previousName}” until ${when(company.renamedAt)}` : ''})`;
      /** Two companies cannot have the same name, however it is capitalised or spaced: an approver must be able to tell them apart. */
      const assertNameFree = async (name: string, exceptCompanyId: string | null): Promise<void> => {
        const taken = (await stores.directory.listCompanies()).some((other) => other.id !== exceptCompanyId && nameKey(other.name) === nameKey(name));
        if (taken) throw new OpsError('Another company already has that name. Company names must be different.', 409, 'name_taken');
      };
      const sameMapping = (a: Mapping, b: Mapping): boolean => a.providerKey === b.providerKey && a.providerAccountId === b.providerAccountId && a.providerContactId === b.providerContactId;
      /**
       * A company may be pointed only at an account that no other company
       * (active or not) is pointed at, and that the provider confirms exists.
       * Otherwise one tenant's users would read and move another's money.
       */
      const assertMappingAllowed = async (mapping: Mapping, exceptCompanyId: string | null): Promise<void> => {
        const taken = (await stores.directory.listCompanies()).some((other) => other.id !== exceptCompanyId && other.providerKey === mapping.providerKey && other.providerAccountId === mapping.providerAccountId);
        if (taken) throw new OpsError('Another company is already mapped to that provider account. Two companies can never share one.', 409, 'mapping_taken');
        let exists = false;
        try {
          exists = await registry.accountExists(mapping.providerKey, mapping);
        } catch {
          throw new OpsError('The provider could not be asked whether that account exists. Nothing was changed; try again.', 502, 'provider_unavailable');
        }
        if (!exists) throw new OpsError('The provider does not know that account id (with that contact id). Check it and try again.', 400, 'mapping_unknown');
      };
      const membersOf = async (companyId: string): Promise<UserRecord[]> => {
        const ids = (await stores.directory.listMemberships()).filter((item) => item.companyId === companyId).map((item) => item.userId);
        const users = await Promise.all(ids.map((id) => stores.directory.getUser(id)));
        return users.filter((user): user is UserRecord => user !== null);
      };

      page('/companies', {}, async (ctx, request, reply) => {
        const q = queryOf(request, 'q').toLowerCase();
        const companies = (await stores.directory.listCompanies()).filter((company) => !q || `${company.name} ${company.id} ${company.providerAccountId}`.toLowerCase().includes(q));
        return send(
          reply,
          200,
          layout(
            chromeOf(ctx, 'Companies', flashOf(request)),
            h`<div class="toolbar">${search('/ops/companies', q, 'Search name or id')}${ctx.user.role === 'ops_admin' && h`<a class="button" href="/ops/companies/new">New company</a>`}</div>
<div class="card"><table><tr><th>Name</th><th>Provider</th><th>Provider account id</th><th>Status</th></tr>${companies.map(
              (company) => h`<tr><td><a href="/ops/companies/${company.id}">${company.name}</a></td><td>${PROVIDERS[company.providerKey].label}</td><td>${company.providerAccountId}</td><td>${tag(!company.deactivatedAt, 'Active', 'Deactivated')}</td></tr>`,
            )}</table>${companies.length === 0 && h`<p class="muted">No companies found.</p>`}</div>`,
          ),
        );
      });
      page('/companies/new', { admin: true }, async (ctx, _request, reply) =>
        send(
          reply,
          200,
          layout(chromeOf(ctx, 'New company'), h`<div class="card narrow"><form method="post" action="/ops/companies">${csrfInput(ctx)}${companyFields()}<p class="muted">The provider is asked whether the account exists, and no two companies can use the same account or the same name.</p>${config.fourEyes ? h`<p class="muted">Needs approval by a second ops admin before it takes effect.</p>` : h``}${codeField}<button>${config.fourEyes ? 'Request: create company' : 'Create company'}</button></form></div>`),
        ),
      );
      action('/companies', {
        name: 'company.create',
        admin: true,
        fourEyes: true,
        adminApproval: true,
        async prepare({ form: input }) {
          const mapping = mappingOf(input);
          await assertNameFree(mapping.name, null);
          await assertMappingAllowed(mapping, null);
          return { params: { name: mapping.name, provider: PROVIDERS[mapping.providerKey].slug, providerAccountId: mapping.providerAccountId, providerContactId: mapping.providerContactId }, summary: `Create company “${mapping.name}” on ${PROVIDERS[mapping.providerKey].label}, account ${mapping.providerAccountId}` };
        },
        async apply(params) {
          const mapping = mappingOf(params);
          await assertNameFree(mapping.name, null);
          await assertMappingAllowed(mapping, null);
          const company: CompanyRecord = { id: `co_${randomToken().slice(0, 12)}`, ...mapping, deactivatedAt: null };
          await stores.directory.saveCompany(company);
          return { target: companyParty(company), detail: { provider: PROVIDERS[company.providerKey].slug, providerAccountId: company.providerAccountId }, redirect: `/ops/companies/${company.id}?done=created` };
        },
      });
      page('/companies/:id', {}, async (ctx, request, reply) => {
        const company = await companyOf((request.params as { id: string }).id);
        const memberships = (await stores.directory.listMemberships()).filter((item) => item.companyId === company.id);
        const users = await Promise.all(memberships.map(async (item) => ({ role: item.role, user: await stores.directory.getUser(item.userId) })));
        return send(
          reply,
          200,
          layout(
            chromeOf(ctx, company.name, flashOf(request)),
            h`<div class="grid"><div class="card"><h2>Details ${tag(!company.deactivatedAt, 'Active', 'Deactivated')}</h2><form method="post" action="/ops/companies/${company.id}">${csrfInput(ctx)}${companyFields(company)}<p class="muted">${config.fourEyes ? 'A rename needs approval by a second staff member. ' : ''}Changing the provider, account id or contact id needs an ops admin${config.fourEyes ? ' and approval by a second ops admin' : ''}, and ends the sessions of everyone attached to this company.${company.previousName && company.renamedAt ? ` Named “${company.previousName}” until ${when(company.renamedAt)}.` : ''}</p>${codeField}<button>${config.fourEyes ? 'Request: save changes' : 'Save changes'}</button></form></div>
<div><div class="card"><h2>People</h2><table><tr><th>Name</th><th>Email</th><th>Role</th></tr>${users.map(({ role, user }) => user && h`<tr><td><a href="/ops/users/${user.id}">${user.name}</a></td><td>${user.email}</td><td>${role}</td></tr>`)}</table>${users.length === 0 && h`<p class="muted">Nobody yet. Attach people from their client user page.</p>`}</div>
<div class="card"><h2>${company.deactivatedAt ? 'Reactivate' : 'Deactivate'}</h2><p class="muted">A deactivated company cannot be selected or used by any client.</p>${
              company.deactivatedAt
                ? form(ctx, `/ops/companies/${company.id}/reactivate`, h``, 'Reactivate company', { request: true })
                : form(ctx, `/ops/companies/${company.id}/deactivate`, h``, 'Deactivate company', { danger: true, confirm: 'Deactivate this company?' })
            }</div></div></div>`,
          ),
        );
      });
      action('/companies/:id', {
        name: 'company.edit',
        // A rename needs a second person too: a misleading name misleads every later approver.
        fourEyes: true,
        // The mapping decides whose money a company's users see: that part needs two ops admins.
        adminApproval: (params) => params.mapping === 'changed',
        async prepare({ actor, form: input, params, aim }) {
          const company = await companyOf(params.id);
          aim(companyParty(company));
          const mapping = mappingOf(input);
          const changed = !sameMapping(company, mapping);
          const renamed = mapping.name !== company.name;
          if (!changed && !renamed) throw new OpsError('Nothing was changed.');
          if (renamed) await assertNameFree(mapping.name, company.id);
          const warnings: string[] = [];
          if (changed) {
            if (actor.role !== 'ops_admin') throw new OpsError('Only an ops admin can change a company’s provider, account id or contact id.', 403, 'forbidden');
            await assertMappingAllowed(mapping, company.id);
            const members = await membersOf(company.id);
            warnings.push(`This re-points the company at a different provider account. ${members.length} ${members.length === 1 ? 'person is' : 'people are'} attached to it; ALL of their sessions will be ended when this is carried out.`);
          }
          return {
            params: { id: company.id, name: mapping.name, provider: PROVIDERS[mapping.providerKey].slug, providerAccountId: mapping.providerAccountId, providerContactId: mapping.providerContactId, mapping: changed ? 'changed' : 'same' },
            summary: `${changed ? `Re-point company ${describe(company)} to ${PROVIDERS[mapping.providerKey].label}, account ${mapping.providerAccountId}` : `Rename company ${describe(company)}`}${renamed ? `${changed ? ', and rename it' : ''} to “${mapping.name}”` : ''}`,
            warnings,
          };
        },
        async apply(params, { requester, source }) {
          const company = await companyOf(params.id);
          const mapping = mappingOf(params);
          const changed = !sameMapping(company, mapping);
          const detail: Record<string, string> = { provider: PROVIDERS[mapping.providerKey].slug, mapping: changed ? 'changed' : 'same' };
          if (changed) {
            // What was approved is what is done: a "same mapping" request can never change the mapping.
            if (params.mapping !== 'changed' || requester.role !== 'ops_admin') throw new OpsError('The company’s mapping changed since this was requested. Make the request again.', 409, 'stale');
            await assertMappingAllowed(mapping, company.id);
          }
          const renamed = mapping.name !== company.name;
          if (renamed) await assertNameFree(mapping.name, company.id);
          await stores.directory.saveCompany({ ...company, ...mapping, ...(renamed ? { previousName: company.name, renamedAt: now() } : {}) });
          if (renamed) detail.previousName = company.name;
          if (changed) {
            registry.invalidate(company.id);
            let sessions = 0;
            for (const member of await membersOf(company.id)) sessions += await revokeClientSessions(requester, member, source, 'company provider mapping changed');
            detail.providerAccountId = mapping.providerAccountId;
            detail.sessionsEnded = String(sessions);
          }
          return { target: companyParty({ id: company.id, name: mapping.name }), detail, redirect: `/ops/companies/${company.id}?done=saved` };
        },
      });
      for (const [verb, deactivate] of [['deactivate', true], ['reactivate', false]] as const) {
        action(`/companies/:id/${verb}`, {
          name: `company.${verb}`,
          // Taking access away is immediate. Giving it back needs a second person.
          fourEyes: !deactivate,
          async prepare({ params, aim }) {
            const company = await companyOf(params.id);
            aim(companyParty(company));
            return { params: { id: company.id }, summary: `${verb} company ${describe(company)}` };
          },
          async apply(params) {
            const company = await companyOf(params.id);
            await stores.directory.saveCompany({ ...company, deactivatedAt: deactivate ? now() : null });
            return { target: companyParty(company), redirect: `/ops/companies/${company.id}?done=saved` };
          },
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
            h`<div class="card narrow"><form method="post" action="/ops/users">${csrfInput(ctx)}<label>Name <input name="name" required maxlength="120"></label><label>Email <input type="email" name="email" required maxlength="254"></label>${[1, 2, 3].map(pick)}<p class="muted">The activation link will be emailed to this address, so it must be the client’s own. More companies can be attached afterwards.</p>${fourEyesNote}${codeField}<button>${config.fourEyes ? 'Request: create client user' : 'Create client user'}</button></form></div>`,
          ),
        );
      });
      const newClientOf = async (input: Record<string, string>) => {
        const name = need(input, 'name', 'Name');
        const email = needEmail(input);
        if (await stores.directory.findUserByEmail(email)) throw new OpsError('A client user with that email already exists.');
        const memberships = new Map<string, { role: UserRole; company: CompanyRecord }>();
        for (const index of [1, 2, 3]) {
          const companyId = text(input, `company${index}`);
          if (!companyId) continue;
          const company = await companyOf(companyId);
          memberships.set(companyId, { role: oneOf(text(input, `role${index}`), CLIENT_ROLES, 'role'), company });
        }
        if (memberships.size === 0) throw new OpsError('Attach the person to at least one company.');
        return { name, email, memberships };
      };
      /**
       * For the approver: the new person's email domain beside the domains of the people already in the
       * company. A stranger's domain is how somebody would slip themselves into a client's company.
       */
      const domainCheck = async (email: string, company: CompanyRecord, exceptUserId: string | null = null): Promise<string> => {
        const domains = [...new Set((await membersOf(company.id)).filter((member) => member.id !== exceptUserId).map((member) => emailDomain(member.email)))].sort();
        const domain = emailDomain(email);
        if (domains.length === 0) return `Email domain ${domain}. Nobody is in ${describe(company)} yet, so there is nothing to compare it with: check it is the client’s own address.`;
        if (domains.includes(domain)) return `Email domain ${domain} matches people already in ${describe(company)}.`;
        return `EMAIL DOMAIN MISMATCH: ${domain} is not the domain of anyone already in ${describe(company)} (${domains.join(', ')}). The activation link will go to this address. Approve only if you know this is the client’s person.`;
      };
      action('/users', {
        name: 'client.create',
        fourEyes: true,
        async prepare({ form: input }) {
          const { name, email, memberships } = await newClientOf(input);
          const params: Record<string, string> = { name, email };
          [...memberships].forEach(([companyId, { role }], index) => {
            params[`company${index + 1}`] = companyId;
            params[`role${index + 1}`] = role;
          });
          const warnings: string[] = [];
          for (const { company } of memberships.values()) warnings.push(await domainCheck(email, company));
          return { params, summary: `Create client user ${name} <${email}> in ${[...memberships.values()].map(({ company, role }) => `${describe(company)} as ${role}`).join(', ')}`, warnings };
        },
        async apply(params) {
          const { name, email, memberships } = await newClientOf(params);
          const user: UserRecord = { id: `usr_${randomToken().slice(0, 12)}`, email, name, passwordHash: null, totpSecret: null, lastTotpStep: 0, recoveryCodeHashes: [], activatedAt: null, disabledAt: null, lastSignInAt: null };
          await stores.directory.saveUser(user);
          for (const [companyId, { role }] of memberships) await stores.directory.setMembership({ userId: user.id, companyId, role });
          return { target: clientParty(user), detail: { companies: [...memberships].map(([companyId, { role }]) => `${companyId}:${role}`).join(' ') }, redirect: `/ops/users/${user.id}?done=created` };
        },
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
              (item) => h`<tr><td><a href="/ops/companies/${item.companyId}">${nameOf(item.companyId)}</a></td><td>${form(ctx, `${base}/memberships`, h`<input type="hidden" name="companyId" value="${item.companyId}"><label>Role ${roleSelect('role', CLIENT_ROLES, item.role)}</label>`, 'Change role', { request: true })}</td><td>${form(ctx, `${base}/memberships/remove`, h`<input type="hidden" name="companyId" value="${item.companyId}">`, 'Remove', { danger: true, confirm: 'Remove this person from the company?' })}</td></tr>`,
            )}</table>${free.length > 0 && h`<h2>Attach to a company</h2>${form(ctx, `${base}/memberships`, h`<label>Company <select name="companyId" required>${free.map((company) => h`<option value="${company.id}">${company.name}</option>`)}</select></label><label>Role ${roleSelect('role', CLIENT_ROLES)}</label>`, 'Attach', { request: true })}`}</div></div>
<div>${
              user.activatedAt === null
                ? h`<div class="card"><h2>Activation link</h2><p class="muted">Emails a new link to ${maskEmail(user.email)} and cancels any earlier one. Valid for 72 hours. The link is never shown to staff.</p>${fourEyesNote}${form(ctx, `${base}/activation-link`, h``, 'Email activation link', { request: true })}</div>`
                : h`<div class="card"><h2>Reset authenticator</h2><p class="warn">${VERIFY_WARNING}</p><p class="muted">Removes the authenticator, the recovery codes and the password, ends every session and emails a new activation link to ${maskEmail(user.email)}.</p>${fourEyesNote}<form method="post" action="${base}/reset-authenticator" data-confirm="Reset this person’s authenticator?">${csrfInput(ctx)}${verifyField}<div class="row tight">${codeField}<button class="danger">${config.fourEyes ? 'Request: reset authenticator' : 'Reset authenticator'}</button></div></form></div>`
            }
${locked && h`<div class="card"><h2>Unlock</h2><p class="muted">Clears the failed-attempt count so the person can try again now.</p>${form(ctx, `${base}/unlock`, h``, 'Unlock account')}</div>`}
<div class="card"><h2>Sessions</h2>${form(ctx, `${base}/revoke-sessions`, h``, 'Revoke all sessions')}</div>
<div class="card"><h2>${user.disabledAt ? 'Re-enable' : 'Disable'}</h2><p class="muted">A disabled person cannot sign in. Disabling ends every session at once. Re-enabling gives back the old password and authenticator, so it needs a second staff member.</p>${
              user.disabledAt ? form(ctx, `${base}/enable`, h``, 'Re-enable user', { request: true }) : form(ctx, `${base}/disable`, h``, 'Disable user', { danger: true, confirm: 'Disable this person?' })
            }</div></div></div>`,
          ),
        );
      });
      action('/users/:id/memberships', {
        name: 'client.membership.set',
        fourEyes: true,
        async prepare({ form: input, params, aim }) {
          const user = await clientOf(params.id);
          aim(clientParty(user));
          const company = await companyOf(text(input, 'companyId'));
          const role = oneOf(text(input, 'role'), CLIENT_ROLES, 'role');
          return { params: { id: user.id, companyId: company.id, role }, summary: `Give ${user.email} the role ${role} in ${describe(company)}`, warnings: [await domainCheck(user.email, company, user.id)] };
        },
        async apply(params) {
          const user = await clientOf(params.id);
          const company = await companyOf(params.companyId);
          const role = oneOf(params.role ?? '', CLIENT_ROLES, 'role');
          await stores.directory.setMembership({ userId: user.id, companyId: company.id, role });
          return { target: clientParty(user), detail: { company: company.id, role }, redirect: `/ops/users/${user.id}?done=saved` };
        },
      });
      action('/users/:id/memberships/remove', {
        name: 'client.membership.remove',
        async prepare({ form: input, params, aim }) {
          const user = await clientOf(params.id);
          aim(clientParty(user));
          const company = await companyOf(text(input, 'companyId'));
          return { params: { id: user.id, companyId: company.id }, summary: `Remove ${user.email} from ${describe(company)}` };
        },
        async apply(params) {
          const user = await clientOf(params.id);
          await stores.directory.removeMembership(user.id, params.companyId ?? '');
          return { target: clientParty(user), detail: { company: params.companyId ?? '' }, redirect: `/ops/users/${user.id}?done=saved` };
        },
      });
      const linkable = async (id: string | undefined): Promise<UserRecord> => {
        const user = await clientOf(id);
        if (user.activatedAt !== null) throw new OpsError('This account is already activated. Use "Reset authenticator" if the person has lost access.');
        if (user.disabledAt) throw new OpsError('Re-enable this person first.');
        return user;
      };
      action('/users/:id/activation-link', {
        name: 'client.activation_link',
        fourEyes: true,
        mails: true,
        async prepare({ params, aim }) {
          aim(clientParty(await clientOf(params.id)));
          const user = await linkable(params.id);
          return { params: { id: user.id }, summary: `Email an activation link to client ${user.email}` };
        },
        async apply(params) {
          const user = await linkable(params.id);
          return { target: clientParty(user), detail: await mailClientLink(user), redirect: `/ops/users/${user.id}?done=mailed` };
        },
      });
      const resettable = async (id: string | undefined): Promise<UserRecord> => {
        const user = await clientOf(id);
        if (user.activatedAt === null) throw new OpsError('This account is not activated. Issue an activation link instead.');
        if (user.disabledAt) throw new OpsError('Re-enable this person first.');
        return user;
      };
      action('/users/:id/reset-authenticator', {
        name: 'client.reset_authenticator',
        fourEyes: true,
        mails: true,
        async prepare({ form: input, params, aim }) {
          aim(clientParty(await clientOf(params.id)));
          const user = await resettable(params.id);
          return {
            params: { id: user.id, identityVerification: needVerification(input) },
            summary: `Reset the authenticator of client ${user.email}`,
            warnings: ['Removes the password, authenticator and recovery codes, ends every session, and emails a new activation link to the address on file. Check the identity verification below before approving.'],
          };
        },
        async apply(params, { requester, source }) {
          const user = await clientOf(params.id);
          if (user.disabledAt) throw new OpsError('Re-enable this person first.');
          // If an earlier try cleared the credentials and then could not send the email, the person is already
          // "not activated". That must not block the retry: the clearing is skipped and the email is sent.
          if (user.activatedAt !== null) {
            const total = await auth.clearCredentials(user.id);
            await append(opsParty(requester), 'client.session_revoked', 'success', clientParty(user), source, { sessions: String(total), why: 'authenticator reset' });
          }
          const fresh = await clientOf(user.id);
          return { target: clientParty(user), detail: { identityVerification: params.identityVerification ?? '', ...(await mailClientLink(fresh)) }, redirect: `/ops/users/${user.id}?done=mailed` };
        },
      });
      /** Client actions on one person. Those that take access away are immediate; giving it back (`fourEyes`) needs a second person. */
      const simple = (path: string, name: string, flash: string, run: (user: UserRecord, actors: Actors) => Promise<Record<string, string> | void>, fourEyes = false) =>
        action(`/users/:id/${path}`, {
          name,
          fourEyes,
          async prepare({ params, aim }) {
            const user = await clientOf(params.id);
            aim(clientParty(user));
            return { params: { id: user.id }, summary: `${name.replace('client.', '').replace('_', ' ')} client ${user.email}` };
          },
          async apply(params, actors) {
            const user = await clientOf(params.id);
            const detail = await run(user, actors);
            return { target: clientParty(user), detail: detail ?? {}, redirect: `/ops/users/${user.id}?done=${flash}` };
          },
        });
      simple('unlock', 'client.unlock', 'unlocked', async (user) => auth.unlock(user));
      simple('revoke-sessions', 'client.revoke_sessions', 'revoked', async (user, { requester, source }) => ({ sessions: String(await revokeClientSessions(requester, user, source, 'revoked by ops')) }));
      simple('disable', 'client.disable', 'disabled', async (user, { requester, source }) => {
        await stores.directory.updateUser(user.id, (current) => ({ ...current, disabledAt: now() }));
        await stores.auth.activations.deleteWhere({ userId: user.id });
        await revokeClientSessions(requester, user, source, 'user disabled');
      });
      // Re-enabling restores the person's old password and authenticator: a second person has to agree.
      simple(
        'enable',
        'client.enable',
        'enabled',
        async (user) => {
          await stores.directory.updateUser(user.id, (current) => ({ ...current, disabledAt: null }));
        },
        true,
      );

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
              (entry) => h`<tr${/^ops\.(staff\.new|break_glass)/.test(entry.action) ? h` class="alert"` : ''}><td>${when(entry.at)}</td><td>${entry.actor.label} <span class="muted">(${entry.anonymous ? 'not identified' : entry.actor.type})</span></td><td>${entry.action}</td><td>${entry.target ? entry.target.label : ''}</td><td>${tag(entry.outcome === 'success', 'success', 'failure')}</td><td>${entry.source}</td><td>${Object.entries(entry.detail).map(([key, value]) => h`<div>${key}: ${value}</div>`)}</td></tr>`,
            )}</table>${entries.length === 0 && h`<p class="muted">No entries match.</p>`}<p class="muted">Newest first, at most 500 entries. Entries cannot be changed or removed. Failures by people who were not identified (a wrong password, for example) are kept separately: only the most recent, and only a limited number per source address.</p></div>`,
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
<div class="card"><h2>Invite a staff member</h2><p class="muted">The activation link is emailed to the address you give, which must be at ${config.staffEmailDomains.join(' or ')}.</p>${config.fourEyes ? h`<p class="muted">Needs approval by a second ops admin before it takes effect.</p>` : h``}${form(ctx, '/ops/staff', h`<label>Name <input name="name" required maxlength="120"></label><label>Email <input type="email" name="email" required maxlength="254"></label><label>Role ${roleSelect('role', OPS_ROLES)}</label>`, 'Invite', { request: true })}</div>`,
          ),
        );
      });
      const newStaffOf = async (input: Record<string, string>) => {
        const name = need(input, 'name', 'Name');
        const email = needEmail(input);
        const role = oneOf(text(input, 'role'), OPS_ROLES, 'role');
        // Checked when it is asked for AND when it is approved: staff are only ever at Global Connect's own domains.
        if (!config.staffEmailDomains.includes(emailDomain(email))) throw new OpsError(`Staff accounts can only be created for addresses at: ${config.staffEmailDomains.join(', ')}.`, 403, 'staff_domain');
        if (await stores.ops.users.findByEmail(email)) throw new OpsError('A staff account with that email already exists.');
        return { name, email, role };
      };
      action('/staff', {
        name: 'staff.invite',
        admin: true,
        fourEyes: true,
        adminApproval: true,
        mails: true,
        async prepare({ form: input, aim }) {
          const { name, email, role } = await newStaffOf(input);
          aim({ type: 'ops', id: null, label: email });
          return { params: { name, email, role }, summary: `Invite ${name} <${email}> as staff with the role ${role}`, warnings: ['This creates a new member of staff, who will be able to act on client accounts. Approve only if you know this person and this address.'] };
        },
        async apply(params, { requester, approver, source }) {
          const { name, email, role } = await newStaffOf(params);
          const user = await opsAuth.createUser(email, name, role);
          // On its own line in the audit log, where it is looked for: somebody new can now act as staff.
          await append(opsParty(requester), 'ops.staff.new', 'success', opsParty(user), source, { role, requestedBy: requester.email, approvedBy: approver?.email ?? '(four-eyes off)', how: 'console invite' });
          return { target: opsParty(user), detail: { role, ...(await mailStaffLink(user)) }, redirect: `/ops/staff/${user.id}?done=mailed` };
        },
      });
      page('/staff/:id', { admin: true }, async (ctx, request, reply) => {
        const user = await staffOf((request.params as { id: string }).id);
        const base = `/ops/staff/${user.id}`;
        const self = user.id === ctx.user.id;
        const locked = await opsAuth.isLocked(user);
        return send(
          reply,
          200,
          layout(
            chromeOf(ctx, user.name, flashOf(request)),
            h`<div class="grid"><div class="card"><h2>Status</h2><dl><dt>Email</dt><dd>${user.email}</dd><dt>Role</dt><dd>${user.role}</dd><dt>Activated</dt><dd>${user.activatedAt ? `Yes, ${when(user.activatedAt)}` : 'No'}</dd><dt>Last sign-in</dt><dd>${when(user.lastSignInAt)}</dd><dt>Locked out</dt><dd>${locked ? 'Yes' : 'No'}</dd><dt>Account</dt><dd>${tag(!user.disabledAt, 'Enabled', 'Disabled')}</dd></dl></div>
<div>${
              self
                ? h`<div class="card"><p class="muted">This is your own account. You cannot change your own role, disable yourself or reset your own authenticator.</p></div>`
                : h`${config.fourEyes ? h`<p class="muted">Each of these needs approval by a second ops admin before it takes effect.</p>` : h``}${locked && h`<div class="card"><h2>Unlock</h2><p class="muted">Clears the failed-attempt count so this person can sign in again now.</p>${form(ctx, `${base}/unlock`, h``, 'Unlock', { request: true })}</div>`}<div class="card"><h2>Role</h2>${form(ctx, `${base}/role`, h`<label>Role ${roleSelect('role', OPS_ROLES, user.role)}</label>`, 'Change role', { request: true })}</div>
${
  user.activatedAt === null
    ? h`<div class="card"><h2>Activation link</h2><p class="muted">Emails a new link to ${maskEmail(user.email)}.</p>${form(ctx, `${base}/activation-link`, h``, 'Email activation link', { request: true })}</div>`
    : h`<div class="card"><h2>Reset authenticator</h2><p class="warn">${VERIFY_WARNING}</p><form method="post" action="${base}/reset-authenticator" data-confirm="Reset this staff member’s authenticator?">${csrfInput(ctx)}${verifyField}<div class="row tight">${codeField}<button class="danger">${config.fourEyes ? 'Request: reset authenticator' : 'Reset authenticator'}</button></div></form></div>`
}
<div class="card"><h2>${user.disabledAt ? 'Re-enable' : 'Disable'}</h2>${user.disabledAt ? form(ctx, `${base}/enable`, h``, 'Re-enable', { request: true }) : form(ctx, `${base}/disable`, h``, 'Disable', { danger: true, confirm: 'Disable this staff member?', request: true })}</div>`
            }</div></div>`,
          ),
        );
      });
      /** A staff-management action on one existing staff member. `check` runs when it is requested AND again when it is carried out. */
      const staffAction = (path: string, name: string, options: { mails?: boolean; flash: string; summary: (user: OpsUserRecord, params: Record<string, string>) => string }, check: (user: OpsUserRecord, input: Record<string, string>, requesterId: string, carryingOut: boolean) => Promise<Record<string, string>>, run: (user: OpsUserRecord, params: Record<string, string>, actors: Actors) => Promise<Record<string, string> | void>) =>
        action(`/staff/:id/${path}`, {
          name,
          admin: true,
          fourEyes: true,
          adminApproval: true,
          mails: options.mails,
          async prepare({ actor, form: input, params, aim }) {
            const user = await staffOf(params.id);
            aim(opsParty(user));
            const checked = { id: user.id, ...(await check(user, input, actor.id, false)) };
            return { params: checked, summary: options.summary(user, checked) };
          },
          async apply(params, actors) {
            const user = await staffOf(params.id);
            await check(user, params, actors.requester.id, true);
            const detail = await run(user, params, actors);
            return { target: opsParty(user), detail: detail ?? {}, redirect: `/ops/staff/${user.id}?done=${options.flash}` };
          },
        });
      staffAction(
        'role',
        'staff.role',
        { flash: 'saved', summary: (user, params) => `Change the staff role of ${user.email} to ${params.role}` },
        async (user, input, requesterId) => {
          const role = oneOf(text(input, 'role'), OPS_ROLES, 'role');
          if (role !== 'ops_admin') await assertStaffRemovalAllowed(stores, requesterId, user);
          else if (user.id === requesterId) throw new OpsError('You cannot do this to your own account.', 403, 'self');
          return { role };
        },
        async (user, params) => {
          await stores.ops.users.update(user.id, (current) => ({ ...current, role: params.role as OpsRole }));
          return { role: params.role ?? '' };
        },
      );
      staffAction(
        'disable',
        'staff.disable',
        { flash: 'disabled', summary: (user) => `Disable staff member ${user.email}` },
        async (user, _input, requesterId) => {
          await assertStaffRemovalAllowed(stores, requesterId, user);
          return {};
        },
        async (user, _params, { requester, source }) => {
          await stores.ops.users.update(user.id, (current) => ({ ...current, disabledAt: now() }));
          await stores.ops.activations.deleteWhere({ userId: user.id });
          const total = await opsAuth.revokeAllSessions(user.id);
          await append(opsParty(requester), 'ops.session_revoked', 'success', opsParty(user), source, { sessions: String(total), why: 'staff disabled' });
        },
      );
      staffAction(
        'enable',
        'staff.enable',
        { flash: 'enabled', summary: (user) => `Re-enable staff member ${user.email}` },
        async (user, _input, requesterId) => {
          if (user.id === requesterId) throw new OpsError('You cannot do this to your own account.', 403, 'self');
          return {};
        },
        async (user) => {
          await stores.ops.users.update(user.id, (current) => ({ ...current, disabledAt: null }));
        },
      );
      staffAction(
        'activation-link',
        'staff.activation_link',
        { mails: true, flash: 'mailed', summary: (user) => `Email an activation link to staff member ${user.email}` },
        async (user) => {
          if (user.activatedAt !== null) throw new OpsError('This account is already activated.');
          if (user.disabledAt) throw new OpsError('Re-enable this staff member first.');
          return {};
        },
        async (user) => mailStaffLink(user),
      );
      staffAction(
        'unlock',
        'staff.unlock',
        { flash: 'unlocked', summary: (user) => `Unlock staff member ${user.email} (clear failed sign-in attempts)` },
        async () => ({}),
        async (user) => opsAuth.unlock(user),
      );
      staffAction(
        'reset-authenticator',
        'staff.reset_authenticator',
        { mails: true, flash: 'mailed', summary: (user) => `Reset the authenticator of staff member ${user.email}` },
        async (user, input, requesterId, carryingOut) => {
          // When an approved reset is carried out again after the email could not be sent, the account is already cleared: that is fine.
          if (user.activatedAt === null && !carryingOut) throw new OpsError('This account is not activated. Issue an activation link instead.');
          if (user.disabledAt) throw new OpsError('Re-enable this staff member first.');
          await assertStaffRemovalAllowed(stores, requesterId, user);
          // From the form it is `verification`; when the approved request is carried out it is the stored `identityVerification`.
          return { identityVerification: needVerification({ verification: text(input, 'identityVerification') || text(input, 'verification') }) };
        },
        async (user, params, { requester, source }) => {
          if (user.activatedAt !== null) {
            const total = await opsAuth.clearCredentials(user.id);
            await append(opsParty(requester), 'ops.session_revoked', 'success', opsParty(user), source, { sessions: String(total), why: 'authenticator reset' });
          }
          return { identityVerification: params.identityVerification ?? '', ...(await mailStaffLink(await staffOf(user.id))) };
        },
      );
    },
    { prefix: '/ops' },
  );
  return routes;
}
