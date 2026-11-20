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
 *     request. A DIFFERENT active staff member must approve it before anything
 *     changes.
 *  3. A company's provider mapping can be set only by an ops admin, to an
 *     account the provider confirms exists and that no other company uses.
 *
 * The authenticator code is asked for at sign-in (and activation) only. Every
 * state-changing request needs the session cookie, the CSRF field and a
 * CONFIRMATION: a page that restates what will happen, whose Confirm button
 * carries a signed, single-use token bound to this session, this action and
 * exactly this payload (see `post`). The few highest-impact changes also ask
 * for the staff member's password again when they are carried out. Everything
 * is written to the audit log whether it succeeded or not. There is no route that reads or
 * sets someone else's password, authenticator key or recovery codes, none
 * that reaches a provider's balances, transactions or payments, and none that
 * starts a client session.
 */
import Big from 'big.js';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { canonicalJson } from '@/api/canonical';
import type { UserRole } from '@/api/types';

import { reasonOf, type AuthService } from '../auth/service';
import type { Config } from '../config';
import { randomToken, safeEqual, sha256 } from '../crypto';
import { ApiError } from '../errors';
import { maskEmail } from '../mailer';
import { MAIL_MAX_ATTEMPTS, type MailQueue } from '../mail/queue';
import { activationMail } from '../mail/templates';
import type { SecurityNotices } from '../notify/security';
import type { AuthenticatorResets } from '../auth/authenticatorResets';
import type { ProviderRegistry } from '../providers/adapter';
import { emailDomain, hasControlCharacters, isEmail, nameKey } from '../validate';
import { approvalsRequiredOf, StoreConflict, type ApprovalRecord, type ApprovalsRequired, type AuditInput, type AuditParty, type CompanyRecord, type OpsRole, type OpsUserRecord, type ProviderKey, type Stores, type UserRecord } from '../store/types';
import { isActiveStaff, opsParty, type OpsAuthService, type OpsContext } from './auth';
import { h, Html, layout, qrSvg, when } from './html';
import { currencyDecimals } from '@/lib/money';
import { checkMarginConfig, describeMargin, MARGIN_USUAL_MAX_BPS, MarginError, workedExample, type MarginConfig, type MarginOverride } from '../rates/margin';
import { marginConfigOf, type ClientRates } from '../rates/service';
import type { Notifier } from '../notify/notifier';
import type { RateAlerts } from '../alerts/service';

export interface OpsDeps {
  config: Config;
  stores: Stores;
  auth: AuthService;
  opsAuth: OpsAuthService;
  registry: ProviderRegistry;
  mail: MailQueue;
  notices: SecurityNotices;
  authenticatorResets: AuthenticatorResets;
  rates: ClientRates;
  notifier: Notifier;
  alerts: RateAlerts;
  now: () => number;
  limitAttempts: (request: FastifyRequest) => Promise<void>;
}

const CLIENT_ROLES: UserRole[] = ['creator', 'approver', 'admin'];
const OPS_ROLES: OpsRole[] = ['ops', 'ops_admin'];
const PRE_SESSION_MS = 30 * 60_000;
/** How long a confirmation page's Confirm button stays good. */
export const CONFIRM_TTL_MS = 5 * 60_000;

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
  reset_invalid: 'That reset link is not valid any more: it was used, replaced or has expired. Ask for a new one.',
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
  const { config, stores, auth, opsAuth, registry, mail, notices, authenticatorResets, rates, notifier, alerts, now, limitAttempts } = deps;
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
        /** The approval request being carried out, if there is one. What an action creates is named after it, so carrying the same request out again creates nothing twice. */
        requestId?: string;
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
        /** Destructive or high-impact: its confirmation page is marked as such. */
        danger?: boolean | ((params: Record<string, string>) => boolean);
        /**
         * The few highest-impact changes: whoever CARRIES IT OUT (the approver, or the one person when four-eyes is
         * off in development) must type their own password again on the confirmation page.
         */
        password?: boolean | ((params: Record<string, string>) => boolean);
        prepare(input: PrepareInput): Promise<Prepared>;
        /** Does it. Re-checks everything: by the time a request is approved, things may have changed. */
        apply(params: Record<string, string>, actors: Actors): Promise<Applied>;
      }
      const actions = new Map<string, ActionDef>();
      const needsApproval = (def: ActionDef, params: Record<string, string>): boolean =>
        config.fourEyes && (typeof def.fourEyes === 'function' ? def.fourEyes(params) : def.fourEyes === true);
      const needsAdminApproval = (def: ActionDef, params: Record<string, string>): boolean =>
        typeof def.adminApproval === 'function' ? def.adminApproval(params) : def.adminApproval === true;
      const conflictError = (error: StoreConflict): OpsError =>
        error.what === 'company_name'
          ? new OpsError('Another company already has that name. Company names must be different.', 409, 'name_taken')
          : new OpsError('Another company is already mapped to that provider account. Two companies can never share one.', 409, 'mapping_taken');
      const flagOf = (flag: ActionDef['danger'], params: Record<string, string>): boolean => (typeof flag === 'function' ? flag(params) : flag === true);
      const person = (user: OpsUserRecord) => ({ id: user.id, email: user.email });
      const append = (actor: AuditParty, action: string, outcome: 'success' | 'failure', target: AuditParty | null, source: string, detail: Record<string, string>) =>
        stores.audit.append({ at: now(), actor, target, action, outcome, source, detail });

      /**
       * CONFIRMATION. No ops action is carried out by the first POST. That POST
       * is answered with a page that says, in words, exactly what will happen
       * and to whom, with Confirm and Cancel. Confirm posts the same fields
       * again together with a token that the server SIGNED for
       *   this staff session + this action + this URL + exactly these fields
       *   + exactly the words that were shown,
       * valid for five minutes and usable once. So the confirming POST cannot
       * be replayed, pointed at something else, altered, made up by another
       * site or taken from another session, and if what would happen has
       * changed since the page was shown, the page is shown again instead.
       * This is on top of the CSRF field, and needs no script.
       */
      interface Confirmation {
        /** What will happen, to whom: "Disable client jo@example.com". */
        title: string;
        /** Consequences and warnings, each a sentence. */
        notes?: string[];
        /** When it takes effect. */
        effect: string;
        danger?: boolean;
        /** The staff member's password is asked for again. */
        password?: boolean;
      }
      class ConfirmNeeded extends Error {
        constructor(
          readonly confirmation: Confirmation,
          readonly notice: string | null,
        ) {
          super('confirmation needed');
        }
      }
      const NOT_REPEATED = ['_csrf', '_confirm', 'password'];
      const fieldsOf = (form: Form): [string, string][] => Object.entries(form).filter(([key, value]) => !NOT_REPEATED.includes(key) && typeof value === 'string').sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)) as [string, string][];
      const signConfirmation = (ctx: OpsContext, name: string, url: string, form: Form, confirmation: Confirmation, expires: string, nonce: string): string =>
        createHmac('sha256', config.serverSecret)
          .update(`ops-confirm:${canonicalJson([ctx.session.id, ctx.user.id, name, url, fieldsOf(form), confirmation.title, confirmation.notes ?? [], confirmation.effect, confirmation.password === true, expires, nonce])}`)
          .digest('base64url');
      const confirmationPage = (ctx: OpsContext, name: string, url: string, form: Form, confirmation: Confirmation, notice: string | null): string => {
        const expires = String(now() + CONFIRM_TTL_MS);
        const nonce = randomToken();
        const token = `${expires}.${nonce}.${signConfirmation(ctx, name, url, form, confirmation, expires, nonce)}`;
        const [, kind = '', id = ''] = url.split('/').filter(Boolean);
        const back = `/ops/${kind}${/^(usr|co|ops|req)_/.test(id) ? `/${id}` : ''}`;
        return layout(
          chromeOf(ctx, 'Confirm'),
          h`<div class="card narrow confirm${confirmation.danger ? ' danger' : ''}">${notice ? h`<p class="error" role="alert">${notice}</p>` : ''}<p class="muted">${confirmation.danger ? 'High-impact change. Read this before you confirm.' : 'Check this before you confirm.'}</p><h2>${confirmation.title}</h2>${(confirmation.notes ?? []).map((note) => h`<p class="${confirmation.danger ? 'warn' : 'note'}">${note}</p>`)}<p><strong>${confirmation.effect}</strong></p><form method="post" action="${url}">${csrfInput(ctx)}${fieldsOf(form).map(([key, value]) => h`<input type="hidden" name="${key}" value="${value}">`)}<input type="hidden" name="_confirm" value="${token}">${
            confirmation.password ? h`<label>Your password, to confirm it is you <input type="password" name="password" autocomplete="current-password" required></label>` : ''
          }<div class="row tight"><button${confirmation.danger ? h` class="danger"` : ''}>Confirm</button><a class="button quiet" href="${back}">Cancel</a></div></form></div>`,
        );
      };

      /**
       * The frame every state-changing POST runs in: session, CSRF field, role,
       * `run` (which must call `confirm` before changing anything) and an audit
       * entry for the outcome, with the target when it is known.
       */
      interface PostInput {
        ctx: OpsContext;
        form: Form;
        params: Record<string, string>;
        source: string;
        aim: (target: AuditParty) => void;
        /** Returns only when this exact action has been confirmed on its confirmation page (and, if asked, with the password). */
        confirm: (confirmation: Confirmation) => Promise<void>;
      }
      const post = (url: string, options: { name: string; admin?: boolean }, run: (input: PostInput) => Promise<{ detail?: Record<string, string>; redirect: string; audited?: boolean }>) =>
        ops.post(url, { preHandler: limitAttempts }, async (request, reply) => {
          const ctx = await sessionOf(request);
          if (!ctx) return problem(reply, null, new OpsError('Your session has ended. Sign in again.', 401));
          if (!fieldOk(request, ctx.token)) return problem(reply, ctx, new OpsError('This form could not be verified. Reload the page and try again.', 403));
          const form = (request.body ?? {}) as Form;
          const path = request.url.split('?')[0] as string;
          let target: AuditParty | null = null;
          let confirmed = false;
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
              confirm: async (confirmation) => {
                const token = text(form, '_confirm');
                if (!token) throw new ConfirmNeeded(confirmation, null);
                const [expires = '', nonce = '', signature = ''] = token.split('.');
                const genuine = token.split('.').length === 3 && /^\d{1,16}$/.test(expires) && nonce !== '' && safeEqual(signConfirmation(ctx, options.name, path, form, confirmation, expires, nonce), signature);
                if (!genuine || Number(expires) <= now()) {
                  throw new ConfirmNeeded(confirmation, 'That confirmation has expired, or what it would do has changed since it was shown. Nothing was done. Check what is shown now and confirm again.');
                }
                if (confirmation.password) {
                  try {
                    await opsAuth.confirmPassword(ctx, text(form, 'password'), options.name, request.ip);
                  } catch (error) {
                    // A lockout keeps its own wording and status; a wrong password is said plainly.
                    if (error instanceof ApiError && error.options.reason === 'invalid_credentials') throw new OpsError('That is not your password. Nothing was done. Go back and try again.', 400, 'wrong_password');
                    throw error;
                  }
                }
                // Once only: the first use records the token's random part, and a second finds it there.
                let first = false;
                await stores.ops.confirmations.mutate(nonce, (current) => {
                  first = current === null;
                  return first ? { expiresAt: Number(expires) } : undefined;
                });
                if (!first) throw new ConfirmNeeded(confirmation, 'That confirmation has already been used. Nothing more was done. If you mean to do this again, confirm again.');
                confirmed = true;
              },
            });
            if (!confirmed) throw new Error(`ops action ${options.name} ran without confirmation`);
            if (!result.audited) await append(opsParty(ctx.user), `ops.${options.name}`, 'success', target, request.ip, { ...result.detail, confirmed: 'yes' });
            return reply.redirect(result.redirect, 303);
          } catch (error) {
            // Not a failure: the action has not been attempted yet. Nothing was changed and nothing is logged.
            if (error instanceof ConfirmNeeded) return send(reply, error.notice ? 409 : 200, confirmationPage(ctx, options.name, path, form, error.confirmation, error.notice));
            // The database's own refusal of a second company with the same name or provider account.
            if (error instanceof StoreConflict) error = conflictError(error);
            await append(opsParty(ctx.user), `ops.${options.name}`, 'failure', target, request.ip, { reason: error instanceof OpsError ? error.reason : reasonOf(error) });
            return problem(reply, ctx, error);
          }
        });

      /** Registers a console action: done at once, or turned into a request for a second staff member. */
      const action = (url: string, def: ActionDef) => {
        actions.set(def.name, def);
        post(url, { name: def.name, admin: def.admin }, async ({ ctx, form, params, source, aim, confirm }) => {
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
          const direct = !needsApproval(def, prepared.params);
          await confirm({
            title: prepared.summary,
            notes: prepared.warnings,
            effect: direct
              ? 'This takes effect as soon as you confirm.'
              : `This only makes a request. Nothing changes until a second staff member${needsAdminApproval(def, prepared.params) ? ', who must be an ops admin,' : ''} approves it.`,
            danger: flagOf(def.danger, prepared.params),
            password: direct && flagOf(def.password, prepared.params),
          });
          if (direct) {
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
          await append(opsParty(ctx.user), 'ops.approval.request', 'success', target, source, { request: request.id, action: def.name, summary: prepared.summary, confirmed: 'yes' });
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
          h`${alert(message)}<p>Scan this with an authenticator app, or enter the key by hand (account ${enrol.email}, time-based).</p>${qrSvg(enrol.otpauthUri)}<p class="secret">${enrol.secret}</p><form method="post" action="/ops/activate/confirm">${hidden(anchor, { activationCode })}<button>Confirm</button></form>`,
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
          h`${alert(message)}<form method="post" action="/ops/login">${hidden(anchor)}<label>Email <input type="email" name="email" required autocomplete="username"></label><label>Password <input type="password" name="password" required autocomplete="current-password"></label><button>Continue</button></form><p><a href="/ops/forgot">Forgot your password?</a></p><p class="muted">Global Connect staff only. Clients sign in through the app.</p>`,
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
      ops.get('/login', { preHandler: limitAttempts }, async (request, reply) =>
        loginForm(reply, preAnchor(request, reply), queryOf(request, 'done') === 'password_reset' ? 'Your password has been changed and every session signed out. Sign in with the new password.' : null),
      );
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
      // --- Forgotten password: the emailed link AND a code from the authenticator or a recovery code ---
      const SAME_ANSWER = 'If that address belongs to an active staff account, an email with a link has been sent to it. The link works for 30 minutes and you will also need a code from your authenticator app, or a recovery code.';
      const forgotForm = (reply: FastifyReply, anchor: string, message: string | null = null, sent = false) =>
        publicPage(
          reply,
          anchor,
          'Reset your password',
          sent
            ? h`<p class="flash">${SAME_ANSWER}</p><p class="muted">Lost your authenticator and your recovery codes as well? That cannot be done here: ask an ops admin, who needs a second ops admin’s approval.</p><p><a href="/ops/login">Back to sign-in</a></p>`
            : h`${alert(message)}<form method="post" action="/ops/forgot">${hidden(anchor)}<label>Email <input type="email" name="email" required autocomplete="username"></label><button>Email me a reset link</button></form><p class="muted">The link alone changes nothing: you will also need a code from your authenticator app, or a recovery code.</p><p><a href="/ops/login">Back to sign-in</a></p>`,
          reply.statusCode,
        );
      const resetForm = (reply: FastifyReply, anchor: string, resetCode: string, message: string | null = null) =>
        publicPage(
          reply,
          anchor,
          'Choose a new password',
          resetCode
            ? h`${alert(message)}<form method="post" action="/ops/reset/complete">${hidden(anchor, { resetCode })}<label>Code from your authenticator app, or a recovery code <input name="code" required autocomplete="one-time-code"></label><label><input type="checkbox" name="method" value="recovery"> This is a recovery code</label><label>New password (at least 12 characters, not a common one) <input type="password" name="password" required minlength="12" autocomplete="new-password"></label><button>Set password</button></form><p class="muted">Your authenticator and recovery codes are not changed. Every signed-in session of yours is signed out.</p>`
            : h`${alert(message)}<form method="post" action="/ops/reset">${hidden(anchor)}<label>Reset code <input name="resetCode" required autocomplete="off" data-from-fragment></label><button>Continue</button></form>`,
          reply.statusCode,
        );
      ops.get('/forgot', { preHandler: limitAttempts }, async (request, reply) => forgotForm(reply, preAnchor(request, reply)));
      publicPost(
        '/forgot',
        async (form, anchor, request, reply) => {
          // The same page whoever the address belongs to, or nobody.
          await opsAuth.requestPasswordReset(text(form, 'email'), request.ip);
          return forgotForm(reply, anchor, null, true);
        },
        (_form, anchor, message, reply) => forgotForm(reply, anchor, message),
      );
      ops.get('/reset', { preHandler: limitAttempts }, async (request, reply) => resetForm(reply, preAnchor(request, reply), ''));
      publicPost(
        '/reset',
        async (form, anchor, _request, reply) => {
          await opsAuth.passwordResetStart(text(form, 'resetCode'));
          return resetForm(reply, anchor, text(form, 'resetCode'));
        },
        (_form, anchor, message, reply) => resetForm(reply, anchor, '', message),
      );
      publicPost(
        '/reset/complete',
        async (form, _anchor, request, reply) => {
          await opsAuth.passwordResetComplete(text(form, 'resetCode'), text(form, 'code'), form.method === 'recovery' ? 'recovery' : 'totp', typeof form.password === 'string' ? form.password : '', request.ip);
          return reply.redirect('/ops/login?done=password_reset', 303);
        },
        (form, anchor, message, reply) => resetForm(reply, anchor, message === MESSAGES.reset_invalid ? '' : text(form, 'resetCode'), message),
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
        reset_scheduled: 'The authenticator reset is approved and waiting out its delay. Nothing has changed yet; the client has been told by email, and can cancel it by signing in.',
        reset_cancelled: 'The authenticator reset was cancelled. Nothing was changed.',
        requested: 'Request created. Nothing has changed yet: a different staff member must approve it.',
        approved: 'Approved and carried out.',
        rejected: 'Request rejected. Nothing was changed.',
        cancelled: 'Request cancelled. Nothing was changed.',
      };
      const flashOf = (request: FastifyRequest): string | undefined => FLASH[queryOf(request, 'done')];
      const csrfInput = (ctx: OpsContext) => h`<input type="hidden" name="_csrf" value="${csrfFor(ctx.token)}">`;
      /** A one-line form. Its button leads to the confirmation page; nothing is done before that. `request` marks an action that only creates a request for approval. */
      const form = (ctx: OpsContext, url: string, fields: Html, button: string, options: { danger?: boolean; request?: boolean } = {}) =>
        h`<form method="post" action="${url}">${csrfInput(ctx)}<div class="row tight">${fields}<button${options.danger ? h` class="danger"` : ''}>${options.request && config.fourEyes ? `Request: ${button}` : button}</button></div></form>`;
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
        await mail.enqueue(activationMail(invite, user.email, user.name, 'client'));
        return { sentTo: maskEmail(user.email), expires: when(invite.expiresAt) };
      };
      const mailStaffLink = async (user: OpsUserRecord): Promise<Record<string, string>> => {
        const invite = await opsAuth.createInvite(user.id);
        await mail.enqueue(activationMail(invite, user.email, user.name, 'staff'));
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
      /**
       * Moves a pending request on: to rejected or cancelled (final), or to `applying` (approved, about to be carried
       * out). Atomic: of two decisions arriving together, one wins. `audit` is written in the same transaction.
       */
      const decide = async (request: ApprovalRecord, status: 'applying' | 'rejected' | 'cancelled', by: OpsUserRecord, audit?: (stored: ApprovalRecord) => AuditInput | AuditInput[] | null): Promise<void> => {
        const decidedAt = now();
        const changed = await stores.ops.approvals.mutate(
          request.id,
          (current) => (current && current.status === 'pending' && current.expiresAt > decidedAt ? { ...current, status, decidedBy: person(by), decidedAt } : undefined),
          (stored) => (stored && audit && stored.status === status && stored.decidedAt === decidedAt && stored.decidedBy?.id === by.id ? audit(stored) : null),
        );
        if (!changed || changed.status !== status || changed.decidedBy?.id !== by.id || changed.decidedAt !== decidedAt) throw new OpsError('This request is no longer waiting for a decision.', 409, 'not_pending');
      };
      const entryOf = (actor: AuditParty, action: string, target: AuditParty | null, source: string, detail: Record<string, string>): AuditInput => ({ at: now(), actor, target, action, outcome: 'success', source, detail });
      /**
       * Carries out a request that is in `applying`, then marks it approved together with both audit entries, in one
       * transaction. A REFUSAL (the checks no longer pass: things changed since it was asked for) puts it back to
       * waiting, nothing having been done. Any other failure (the provider, the mail, a crash) leaves it `applying`:
       * it may be half done, and it has to be finished or closed from the Approvals page, never guessed at.
       */
      /** Requests this process is carrying out at this moment (there is one server process per database). */
      const carrying = new Set<string>();
      /** An approved request left unfinished for longer than a request may wait is too old to finish blind: it can only be closed. */
      const staleApplying = (item: ApprovalRecord): boolean => item.status === 'applying' && now() - (item.decidedAt ?? item.requestedAt) > config.approvalTtlMs;
      /**
       * Who may approve a request, finish one that was interrupted, or close one: the SAME checks for all three.
       * Never the person who asked, never the person it is about, an ops admin where the action needs one, and
       * (to carry it out) only while the requester could still make the request.
       */
      const assertMayDecide = async (item: ApprovalRecord, def: ActionDef | undefined, user: OpsUserRecord, carryingOut: boolean): Promise<OpsUserRecord | null> => {
        if (item.requestedBy.id === user.id) throw new OpsError('You cannot approve, finish or close your own request. A different staff member must do it.', 403, 'own_request');
        if (item.target?.type === 'ops' && item.target.id === user.id) throw new OpsError('This request is about your own account, so you cannot decide it.', 403, 'self');
        // Who is staff, and where a company's money is, are decided by two ops ADMINS.
        if (def && needsAdminApproval(def, item.params) && user.role !== 'ops_admin') throw new OpsError('Only an ops admin can approve this kind of request.', 403, 'admin_approval');
        if (!carryingOut) return null;
        const requester = await stores.ops.users.get(item.requestedBy.id);
        if (!def || !requester || !isActiveStaff(requester) || (def.admin && requester.role !== 'ops_admin')) throw new OpsError('The staff member who made this request can no longer make it. Reject or close it instead.', 409, 'requester_inactive');
        return requester;
      };
      const carryOut = async (item: ApprovalRecord, def: ActionDef, requester: OpsUserRecord, approver: OpsUserRecord, source: string, extra: Record<string, string>, resuming: boolean): Promise<void> => {
        if (carrying.has(item.id)) throw new OpsError('This request is being carried out right now. Wait for it to finish.', 409, 'in_progress');
        carrying.add(item.id);
        try {
          await carryOutNow(item, def, requester, approver, source, extra, resuming);
        } finally {
          carrying.delete(item.id);
        }
      };
      const carryOutNow = async (item: ApprovalRecord, def: ActionDef, requester: OpsUserRecord, approver: OpsUserRecord, source: string, extra: Record<string, string>, resuming: boolean): Promise<void> => {
        let applied: Applied;
        try {
          applied = await def.apply(item.params, { requester, approver, source, requestId: item.id });
        } catch (caught) {
          const error = caught instanceof StoreConflict ? conflictError(caught) : caught;
          if (error instanceof OpsError && !resuming) {
            await stores.ops.approvals.mutate(item.id, (current) => (current && current.status === 'applying' ? { ...current, status: 'pending', decidedBy: null, decidedAt: null } : undefined));
          }
          throw error;
        }
        const both = { request: item.id, requestedBy: requester.email, approvedBy: approver.email, confirmed: 'yes', ...extra };
        const target = applied.target ?? item.target;
        const done = await stores.ops.approvals.mutate(
          item.id,
          (current) => (current && current.status === 'applying' ? { ...current, status: 'approved' } : undefined),
          (stored) =>
            stored?.status === 'approved'
              ? [entryOf(opsParty(requester), `ops.${def.name}`, target, source, { ...applied.detail, ...both }), entryOf(opsParty(approver), 'ops.approval.approve', target, source, { ...both, action: def.name, ...(resuming ? { resumed: 'yes' } : {}) })]
              : null,
        );
        if (done?.status !== 'approved') throw new OpsError('This request is no longer being carried out.', 409, 'not_pending');
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
        const interrupted = all.filter((item) => item.status === 'applying' && !carrying.has(item.id));
        const resets = (await authenticatorResets.waiting()).sort((a, b) => a.dueAt - b.dueAt);
        const people = new Map(await Promise.all(resets.map(async (item) => [item.userId, await stores.directory.getUser(item.userId)] as const)));
        const resetsCard =
          resets.length > 0
            ? h`<div class="card"><h2>Authenticator resets waiting out their delay</h2><p class="muted">Approved, and nothing has changed yet. Each takes effect at the time shown unless the client signs in with their current credentials first, or an ops admin cancels it.</p><table><tr><th>Client</th><th>Requested by</th><th>Approved by</th><th>Takes effect</th><th></th></tr>${resets.map(
                (item) => h`<tr><td><a href="/ops/users/${item.userId}">${people.get(item.userId)?.name ?? item.userId}</a></td><td>${item.requestedBy}</td><td>${item.approvedBy}</td><td>${when(item.dueAt)}</td><td>${ctx.user.role === 'ops_admin' ? form(ctx, `/ops/authenticator-resets/${item.id}/cancel`, h``, 'Cancel reset') : h`<span class="muted">an ops admin can cancel</span>`}</td></tr>`,
              )}</table></div>`
            : '';
        return send(
          reply,
          200,
          layout(
            chromeOf(ctx, 'Approvals', flashOf(request)),
            h`${resetsCard}${interrupted.length > 0 ? h`<div class="card"><h2>Approved, but not finished</h2><p class="warn">These were approved and then interrupted while being carried out. Each may be partly done. Open it to finish it or close it.</p><table><tr><th>Request</th><th>Requested by</th><th>When</th><th>Status</th><th></th></tr>${interrupted.map(row)}</table></div>` : ''}<div class="card"><h2>Waiting for a second staff member</h2><table><tr><th>Request</th><th>Requested by</th><th>When</th><th>Status</th><th></th></tr>${pending.map(row)}</table>${pending.length === 0 && h`<p class="muted">Nothing is waiting.</p>`}<p class="muted">A request is approved by a different staff member than the one who made it, and expires after 24 hours.</p></div>
<div class="card"><h2>Decided (latest 50)</h2><table><tr><th>Request</th><th>Requested by</th><th>When</th><th>Status</th><th>Decided</th></tr>${all.filter((item) => item.status !== 'pending' && item.status !== 'applying').slice(0, 50).map(row)}</table></div>`,
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
              item.status === 'applying'
                ? h`<div class="card"><h2>Approved, but not finished</h2><p class="warn">This was approved by ${item.decidedBy?.email ?? 'someone'} and then interrupted while being carried out. It may be partly done.</p>${carrying.has(item.id) ? h`<p class="warn">It is being carried out right now. Wait for it to finish.</p>` : ''}${staleApplying(item) ? h`<p class="warn">It was approved more than ${String(Math.round(config.approvalTtlMs / 3_600_000))} hours ago: too long ago to finish without looking again. It can only be closed.</p>` : ''}${
                    mine || aboutMe ? h`<p class="muted">It is your own request: a different staff member must finish or close it.</p>` : h`${form(ctx, `${base}/resume`, h``, 'Finish carrying it out')}${form(ctx, `${base}/abandon`, h``, 'Close without finishing', { danger: true })}`
                  }</div>`
                : item.status !== 'pending'
                ? h`<div class="card"><p class="muted">This request is ${item.status}.</p></div>`
                : mine
                  ? h`<div class="card"><h2>Your request</h2><p class="muted">You cannot approve your own request. A different staff member must do it.</p>${form(ctx, `${base}/cancel`, h``, 'Cancel request')}</div>`
                  : h`<div class="card"><h2>Decide</h2>${
                      aboutMe
                        ? h`<p class="muted">This request is about your own account, so you cannot approve it.</p>`
                        : adminOnly && ctx.user.role !== 'ops_admin'
                          ? h`<p class="muted">Only an ops admin can approve this kind of request (it changes who is staff, or which provider account a company uses).</p>`
                          : h`<p class="${history.flag ? 'warn' : 'muted'}">In the last 30 days ${item.requestedBy.email} has had ${history.byRequester} ${history.byRequester === 1 ? 'request' : 'requests'} approved, ${history.byPair} of them by you.${history.flag ? ' You approve most of this person’s requests: a second pair of eyes only works if it is not always the same pair.' : ''}</p><p class="muted">Approving carries the change out now, in your name and the requester’s. Check it against what you know.</p>${form(ctx, `${base}/approve`, h``, 'Approve')}`
                    }${form(ctx, `${base}/reject`, h``, 'Reject', { danger: true })}</div>`
            }</div></div>`,
          ),
        );
      });
      post('/approvals/:id/approve', { name: 'approval.approve' }, async ({ ctx, params, source, aim, confirm }) => {
        const item = await approvalOf(params.id);
        if (item.target) aim(item.target);
        const def = actions.get(item.action);
        if (!def || item.status !== 'pending') throw new OpsError('This request is no longer waiting for a decision.', 409, 'not_pending');
        // Four eyes: never the person who asked, and never the person the request is about (see assertMayDecide).
        const requester = (await assertMayDecide(item, def, ctx.user, true)) as OpsUserRecord;
        const history = await pairHistory(item.requestedBy.id, ctx.user.id);
        const password = flagOf(def.password, item.params);
        await confirm({
          title: `Approve and carry out: ${item.summary}`,
          notes: [
            ...item.warnings,
            `Requested by ${requester.email} on ${when(item.requestedAt)}.`,
            ...(history.flag ? [`You approve most of ${requester.email}’s requests (${history.byPair} of ${history.byRequester} in the last 30 days). A second pair of eyes only works if it is not always the same pair.`] : []),
          ],
          effect: 'Approving carries the change out now, in your name and the requester’s.',
          danger: flagOf(def.danger, item.params),
          password,
        });
        // The decision is on record from the moment it is made, whatever becomes of carrying it out.
        await decide(item, 'applying', ctx.user, () => entryOf(opsParty(ctx.user), 'ops.approval.begin', item.target, source, { request: item.id, action: item.action, requestedBy: requester.email, approvedBy: ctx.user.email, confirmed: 'yes', ...(password ? { passwordChecked: 'yes' } : {}) }));
        await carryOut(item, def, requester, ctx.user, source, { pairApprovals30d: String(history.byPair + 1), ...(password ? { passwordChecked: 'yes' } : {}) }, false);
        return { redirect: `/ops/approvals/${item.id}?done=approved`, audited: true };
      });
      // A request that was approved but not (or not completely) carried out: finish it, or close it.
      post('/approvals/:id/resume', { name: 'approval.resume' }, async ({ ctx, params, source, aim, confirm }) => {
        const item = await approvalOf(params.id);
        if (item.target) aim(item.target);
        const def = actions.get(item.action);
        if (!def || item.status !== 'applying' || !item.decidedBy) throw new OpsError('This request is not waiting to be finished.', 409, 'not_pending');
        // Exactly the checks of approving it, and then: whoever approved it, or an ops admin.
        const requester = (await assertMayDecide(item, def, ctx.user, true)) as OpsUserRecord;
        if (item.decidedBy.id !== ctx.user.id && ctx.user.role !== 'ops_admin') throw new OpsError('Only the staff member who approved this request, or an ops admin, can finish it.', 403, 'forbidden');
        // The approval that started it may still be running: that is not an interruption, and it is not done twice.
        if (carrying.has(item.id)) throw new OpsError('This request is being carried out right now. Wait for it to finish.', 409, 'in_progress');
        if (staleApplying(item)) throw new OpsError('This request was approved too long ago to be finished without looking again. Close it, check what was done, and make a new request for whatever is missing.', 409, 'stale');
        const password = flagOf(def.password, item.params);
        await confirm({
          title: `Finish carrying out: ${item.summary}`,
          notes: [...item.warnings, `Approved by ${item.decidedBy.email} on ${when(item.decidedAt)}, but it was interrupted before it was recorded as done. It may be partly done. Carrying it out again repeats only what is missing.`],
          effect: 'This carries the change out now.',
          danger: flagOf(def.danger, item.params),
          password,
        });
        await carryOut(item, def, requester, ctx.user, source, password ? { passwordChecked: 'yes' } : {}, true);
        return { redirect: `/ops/approvals/${item.id}?done=approved`, audited: true };
      });
      post('/approvals/:id/abandon', { name: 'approval.abandon' }, async ({ ctx, params, source, aim, confirm }) => {
        const item = await approvalOf(params.id);
        if (item.target) aim(item.target);
        if (item.status !== 'applying') throw new OpsError('This request is not waiting to be finished.', 409, 'not_pending');
        await assertMayDecide(item, actions.get(item.action), ctx.user, false);
        if (item.decidedBy?.id !== ctx.user.id && ctx.user.role !== 'ops_admin') throw new OpsError('Only the staff member who approved this request, or an ops admin, can close it.', 403, 'forbidden');
        if (carrying.has(item.id)) throw new OpsError('This request is being carried out right now. Wait for it to finish.', 409, 'in_progress');
        await confirm({
          title: `Close without finishing: ${item.summary}`,
          notes: ['It was approved and may have been PARTLY carried out before it was interrupted. Closing it does not undo anything: check the person or company it is about, and make a new request for whatever is still missing.'],
          effect: 'The request is closed. Nothing more is done.',
          danger: true,
        });
        const detail = { request: item.id, action: item.action, requestedBy: item.requestedBy.email, approvedBy: item.decidedBy?.email ?? '', closedBy: ctx.user.email, confirmed: 'yes', note: 'closed while being carried out; it may be partly done' };
        const closed = await stores.ops.approvals.mutate(
          item.id,
          (current) => (current && current.status === 'applying' ? { ...current, status: 'rejected' } : undefined),
          (stored) => (stored?.status === 'rejected' ? entryOf(opsParty(ctx.user), 'ops.approval.abandon', item.target, source, detail) : null),
        );
        if (closed?.status !== 'rejected') throw new OpsError('This request is not waiting to be finished.', 409, 'not_pending');
        return { redirect: `/ops/approvals/${item.id}?done=rejected`, audited: true };
      });
      post('/approvals/:id/reject', { name: 'approval.reject' }, async ({ ctx, params, source, aim, confirm }) => {
        const item = await approvalOf(params.id);
        if (item.target) aim(item.target);
        if (item.requestedBy.id === ctx.user.id) throw new OpsError('To withdraw your own request, cancel it.', 403, 'own_request');
        if (item.status !== 'pending') throw new OpsError('This request is no longer waiting for a decision.', 409, 'not_pending');
        await confirm({ title: `Reject the request: ${item.summary}`, notes: [`Requested by ${item.requestedBy.email} on ${when(item.requestedAt)}.`], effect: 'The request is closed and nothing is changed. It cannot be approved afterwards.' });
        await decide(item, 'rejected', ctx.user, () => entryOf(opsParty(ctx.user), 'ops.approval.reject', item.target, source, { request: item.id, action: item.action, requestedBy: item.requestedBy.email, rejectedBy: ctx.user.email, confirmed: 'yes' }));
        return { redirect: `/ops/approvals/${item.id}?done=rejected`, audited: true };
      });
      post('/approvals/:id/cancel', { name: 'approval.cancel' }, async ({ ctx, params, source, aim, confirm }) => {
        const item = await approvalOf(params.id);
        if (item.target) aim(item.target);
        if (item.requestedBy.id !== ctx.user.id) throw new OpsError('Only the staff member who made a request can cancel it. You can reject it.', 403, 'not_requester');
        if (item.status !== 'pending') throw new OpsError('This request is no longer waiting for a decision.', 409, 'not_pending');
        await confirm({ title: `Cancel your request: ${item.summary}`, effect: 'The request is withdrawn and nothing is changed.' });
        await decide(item, 'cancelled', ctx.user, () => entryOf(opsParty(ctx.user), 'ops.approval.cancel', item.target, source, { request: item.id, action: item.action, requestedBy: item.requestedBy.email, confirmed: 'yes' }));
        return { redirect: `/ops/approvals/${item.id}?done=cancelled`, audited: true };
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
      /**
       * A company cannot be re-pointed while one of its payments has been handed to the provider and the answer is
       * not yet known: that payment is settled on the account it was sent to. Returns how many payments are waiting
       * for approval (a number only: ops never sees a payment).
       */
      const assertNothingBeingSent = async (companyId: string): Promise<number> => {
        const sending = (await stores.payments.list({ companyId, status: 'sending' })).length;
        if (sending > 0) throw new OpsError(`${sending} ${sending === 1 ? 'payment of this company is' : 'payments of this company are'} being sent to the provider and the outcome is not known yet. The company cannot be re-pointed until that is settled (the server retries every minute). Try again shortly.`, 409, 'payments_sending');
        return (await stores.payments.list({ companyId, status: 'awaiting_approval' })).length;
      };
      const membersOf = async (companyId: string): Promise<UserRecord[]> => {
        const ids = (await stores.directory.listMemberships()).filter((item) => item.companyId === companyId).map((item) => item.userId);
        const users = await Promise.all(ids.map((id) => stores.directory.getUser(id)));
        return users.filter((user): user is UserRecord => user !== null);
      };

      /**
       * Payment approvals. With N approvals required, a payment needs N people OTHER than its creator who are
       * active and may approve. Returns what to warn about, or null: ops sees who could be stuck, never a payment.
       */
      const APPROVAL_LABELS: Record<number, string> = { 0: 'None: payments are sent as soon as they are created', 1: 'One other person must approve', 2: 'Two other people must approve' };
      const approverGap = async (company: CompanyRecord, required = approvalsRequiredOf(company)): Promise<string | null> => {
        if (required === 0) return null;
        const memberships = (await stores.directory.listMemberships()).filter((item) => item.companyId === company.id);
        const people = (await Promise.all(memberships.map(async (item) => ({ role: item.role, user: await stores.directory.getUser(item.userId) })))).filter(
          (item): item is { role: UserRole; user: UserRecord } => item.user !== null && item.user.activatedAt !== null && !item.user.disabledAt,
        );
        const stuck = people.filter((creator) => (creator.role === 'creator' || creator.role === 'admin') && people.filter((other) => other.user.id !== creator.user.id && (other.role === 'approver' || other.role === 'admin')).length < required);
        if (stuck.length === 0) return null;
        return `NOT ENOUGH APPROVERS: with ${required} ${required === 1 ? 'approval' : 'approvals'} required, a payment created by ${stuck.map((item) => item.user.name).join(' or ')} could not be approved by anyone (it needs ${required} other active ${required === 1 ? 'person' : 'people'} with the approver or admin role). It would wait and then expire.`;
      };

      page('/companies', {}, async (ctx, request, reply) => {
        const q = queryOf(request, 'q').toLowerCase();
        const companies = (await stores.directory.listCompanies()).filter((company) => !q || `${company.name} ${company.id} ${company.providerAccountId}`.toLowerCase().includes(q));
        const gaps = new Map(await Promise.all(companies.map(async (company) => [company.id, company.deactivatedAt ? null : await approverGap(company)] as const)));
        return send(
          reply,
          200,
          layout(
            chromeOf(ctx, 'Companies', flashOf(request)),
            h`<div class="toolbar">${search('/ops/companies', q, 'Search name or id')}${ctx.user.role === 'ops_admin' && h`<a class="button" href="/ops/companies/new">New company</a>`}</div>
<div class="card"><table><tr><th>Name</th><th>Provider</th><th>Provider account id</th><th>Payment approvals</th><th>Status</th></tr>${companies.map(
              (company) => h`<tr><td><a href="/ops/companies/${company.id}">${company.name}</a></td><td>${PROVIDERS[company.providerKey].label}</td><td>${company.providerAccountId}</td><td>${approvalsRequiredOf(company)} required${gaps.get(company.id) ? h` ${tag(false, '', 'Not enough approvers')}` : ''}</td><td>${tag(!company.deactivatedAt, 'Active', 'Deactivated')}</td></tr>`,
            )}</table>${companies.length === 0 && h`<p class="muted">No companies found.</p>`}</div>`,
          ),
        );
      });
      page('/companies/new', { admin: true }, async (ctx, _request, reply) =>
        send(
          reply,
          200,
          layout(chromeOf(ctx, 'New company'), h`<div class="card narrow"><form method="post" action="/ops/companies">${csrfInput(ctx)}${companyFields()}<p class="muted">The provider is asked whether the account exists, and no two companies can use the same account or the same name.</p>${config.fourEyes ? h`<p class="muted">Needs approval by a second ops admin before it takes effect.</p>` : h``}<button>${config.fourEyes ? 'Request: create company' : 'Create company'}</button></form></div>`),
        ),
      );
      action('/companies', {
        name: 'company.create',
        admin: true,
        fourEyes: true,
        adminApproval: true,
        danger: true,
        password: true,
        async prepare({ form: input }) {
          const mapping = mappingOf(input);
          await assertNameFree(mapping.name, null);
          await assertMappingAllowed(mapping, null);
          return { params: { name: mapping.name, provider: PROVIDERS[mapping.providerKey].slug, providerAccountId: mapping.providerAccountId, providerContactId: mapping.providerContactId }, summary: `Create company “${mapping.name}” on ${PROVIDERS[mapping.providerKey].label}, account ${mapping.providerAccountId}`, warnings: ['Everyone later attached to this company will see and move the money in that provider account. It starts with one approval required for payments.'] };
        },
        async apply(params, { requestId }) {
          const mapping = mappingOf(params);
          // Named after the request that creates it: carrying the same request out twice makes one company.
          const company: CompanyRecord = { id: requestId ? `co_${sha256(`company:${requestId}`).slice(0, 12)}` : `co_${randomToken().slice(0, 12)}`, ...mapping, deactivatedAt: null };
          const existing = await stores.directory.getCompany(company.id);
          if (existing) return { target: companyParty(existing), detail: { provider: PROVIDERS[existing.providerKey].slug, providerAccountId: existing.providerAccountId }, redirect: `/ops/companies/${existing.id}?done=created` };
          await assertNameFree(mapping.name, null);
          await assertMappingAllowed(mapping, null);
          // The database refuses a second company with this name or this provider account, even if two requests are approved at the same moment.
          await stores.directory.saveCompany(company);
          return { target: companyParty(company), detail: { provider: PROVIDERS[company.providerKey].slug, providerAccountId: company.providerAccountId }, redirect: `/ops/companies/${company.id}?done=created` };
        },
      });
      page('/companies/:id', {}, async (ctx, request, reply) => {
        const company = await companyOf((request.params as { id: string }).id);
        const memberships = (await stores.directory.listMemberships()).filter((item) => item.companyId === company.id);
        const users = await Promise.all(memberships.map(async (item) => ({ role: item.role, user: await stores.directory.getUser(item.userId) })));
        const gap = company.deactivatedAt ? null : await approverGap(company);
        const required = approvalsRequiredOf(company);
        const margin = await rates.marginOf(company.id);
        return send(
          reply,
          200,
          layout(
            chromeOf(ctx, company.name, flashOf(request)),
            h`<div class="grid"><div class="card"><h2>Details ${tag(!company.deactivatedAt, 'Active', 'Deactivated')}</h2><form method="post" action="/ops/companies/${company.id}">${csrfInput(ctx)}${companyFields(company)}<p class="muted">${config.fourEyes ? 'A rename needs approval by a second staff member. ' : ''}Changing the provider, account id or contact id needs an ops admin${config.fourEyes ? ' and approval by a second ops admin' : ''}, and ends the sessions of everyone attached to this company.${company.previousName && company.renamedAt ? ` Named “${company.previousName}” until ${when(company.renamedAt)}.` : ''}</p><button>${config.fourEyes ? 'Request: save changes' : 'Save changes'}</button></form></div>
<div><div class="card"><h2>People</h2><table><tr><th>Name</th><th>Email</th><th>Role</th></tr>${users.map(({ role, user }) => user && h`<tr><td><a href="/ops/users/${user.id}">${user.name}</a></td><td>${user.email}</td><td>${role}</td></tr>`)}</table>${users.length === 0 && h`<p class="muted">Nobody yet. Attach people from their client user page.</p>`}</div>
<div class="card"><h2>Payment approvals</h2><p>Now: <strong>${required} required</strong>. ${APPROVAL_LABELS[required] ?? ''}.</p>${gap ? h`<p class="warn">${gap}</p>` : ''}${form(
              ctx,
              `/ops/companies/${company.id}/approvals`,
              h`<label>Approvals required before a payment is sent <select name="approvalsRequired">${[0, 1, 2].map((value) => h`<option value="${String(value)}"${value === required ? h` selected` : ''}>${String(value)}: ${APPROVAL_LABELS[value] ?? ''}</option>`)}</select></label><p class="muted">The creator of a payment can never approve it. A stricter rule applies at once, to payments already waiting as well; a looser one applies only to payments created afterwards.${config.fourEyes ? ' Needs approval by an ops admin.' : ''}</p>`,
              'Change payment approvals',
              { request: true },
            )}</div>
<div class="card"><h2>FX margin</h2><p>Now: <strong>${describeMargin(margin.config)}</strong>${margin.record ? h` (set ${when(margin.record.updatedAt)} by ${margin.record.updatedBy}${margin.record.approvedBy ? h`, approved by ${margin.record.approvedBy}` : ''})` : ' (the server default: this company has no configuration of its own)'}.</p>${rates.appliedBy(company) === 'provider' ? h`<p class="warn">For this company’s provider the margin is applied by the provider, not by this server: the figures here are not used to price anything.</p>` : ''}${form(ctx, `/ops/companies/${company.id}/margin`, h`${marginFields(margin.config)}<p class="muted">A client only ever sees their own rate: never the provider’s rate and never this margin. Which margin applies to a trade: for a forward, the forward margin if one is set; otherwise an override for the pair and direction; otherwise the tier for the amount; otherwise the default. A change needs a second staff member, an ops admin, who types their password again.</p>`, 'Change FX margin', { request: true })}</div>
<div class="card"><h2>${company.deactivatedAt ? 'Reactivate' : 'Deactivate'}</h2><p class="muted">A deactivated company cannot be selected or used by any client.</p>${
              company.deactivatedAt
                ? form(ctx, `/ops/companies/${company.id}/reactivate`, h``, 'Reactivate company', { request: true })
                : form(ctx, `/ops/companies/${company.id}/deactivate`, h``, 'Deactivate company', { danger: true })
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
        danger: (params) => params.mapping === 'changed',
        password: (params) => params.mapping === 'changed',
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
            const waiting = await assertNothingBeingSent(company.id);
            const members = await membersOf(company.id);
            warnings.push(`This re-points the company at a different provider account. ${members.length} ${members.length === 1 ? 'person is' : 'people are'} attached to it; ALL of their sessions will be ended when this is carried out.`);
            if (waiting > 0) warnings.push(`${waiting} ${waiting === 1 ? 'payment of this company is' : 'payments of this company are'} waiting for approval. After the re-point ${waiting === 1 ? 'it' : 'they'} can no longer be approved (${waiting === 1 ? 'its payee belongs' : 'their payees belong'} to the old account) and will have to be created again.`);
          }
          return {
            params: { id: company.id, name: mapping.name, provider: PROVIDERS[mapping.providerKey].slug, providerAccountId: mapping.providerAccountId, providerContactId: mapping.providerContactId, mapping: changed ? 'changed' : 'same' },
            summary: `${changed ? `Re-point company ${describe(company)} from ${PROVIDERS[company.providerKey].label}, account ${company.providerAccountId}, to ${PROVIDERS[mapping.providerKey].label}, account ${mapping.providerAccountId}` : `Rename company ${describe(company)}`}${renamed ? `${changed ? ', and rename it' : ''} to “${mapping.name}”` : ''}`,
            warnings,
          };
        },
        async apply(params, { requester, source }) {
          const company = await companyOf(params.id);
          const mapping = mappingOf(params);
          // What was approved is what is done: a "same mapping" request can never change the mapping.
          const repoint = params.mapping === 'changed';
          if (!repoint && !sameMapping(company, mapping)) throw new OpsError('The company’s mapping changed since this was requested. Make the request again.', 409, 'stale');
          const detail: Record<string, string> = { provider: PROVIDERS[mapping.providerKey].slug, mapping: repoint ? 'changed' : 'same' };
          if (repoint) {
            if (requester.role !== 'ops_admin') throw new OpsError('The company’s mapping changed since this was requested. Make the request again.', 409, 'stale');
            // Every check that can refuse comes first, and the provider is asked BEFORE anything is changed.
            if (!sameMapping(company, mapping)) await assertMappingAllowed(mapping, company.id);
            await assertNothingBeingSent(company.id);
          }
          if (nameKey(mapping.name) !== nameKey(company.name)) await assertNameFree(mapping.name, company.id);
          if (repoint) {
            // Sessions end BEFORE the mapping moves, and ending them again is harmless: if this is interrupted and
            // carried out a second time, nobody is left signed in to the old account's data.
            let sessions = 0;
            for (const member of await membersOf(company.id)) sessions += await revokeClientSessions(requester, member, source, 'company provider mapping changed');
            detail.providerAccountId = mapping.providerAccountId;
            detail.sessionsEnded = String(sessions);
          }
          // ONE transaction on the row as it is NOW (the provider was asked a moment ago and time has passed): only the
          // name and the mapping are written, so a deactivation or a change of approval rule made meanwhile stays.
          let previousName: string | null = null;
          const saved = await stores.directory.updateCompany(company.id, (current) => {
            if (!repoint && !sameMapping(current, mapping)) throw new OpsError('The company’s mapping changed since this was requested. Make the request again.', 409, 'stale');
            const renamed = mapping.name !== current.name;
            previousName = renamed ? current.name : null;
            return { ...current, ...mapping, ...(renamed ? { previousName: current.name, renamedAt: now() } : {}) };
          });
          if (!saved) throw new OpsError('No such company.', 404, 'not_found');
          if (previousName) detail.previousName = previousName;
          if (repoint) registry.invalidate(company.id);
          return { target: companyParty({ id: company.id, name: mapping.name }), detail, redirect: `/ops/companies/${company.id}?done=saved` };
        },
      });
      action('/companies/:id/approvals', {
        name: 'company.approvals',
        fourEyes: true,
        // How many people stand between a payment and the bank is decided by two staff, the second an ops admin
        // who types their password again.
        adminApproval: true,
        danger: true,
        password: true,
        async prepare({ form: input, params, aim }) {
          const company = await companyOf(params.id);
          aim(companyParty(company));
          const wanted = Number(oneOf(text(input, 'approvalsRequired'), ['0', '1', '2'], 'number of approvals')) as ApprovalsRequired;
          const current = approvalsRequiredOf(company);
          if (wanted === current) throw new OpsError('That is already the rule for this company.');
          const warnings: string[] = [];
          warnings.push(
            wanted === 0
              ? 'Payments created from now on will be sent without a second person: one person at the client can create a payment and it goes to the provider at once.'
              : wanted < current
                ? `Payments created from now on will need ${wanted} other ${wanted === 1 ? 'person' : 'people'} to approve them instead of ${current}: one fewer check before money leaves.`
                : `Payments created from now on will be held until ${wanted} other ${wanted === 1 ? 'person has' : 'people have'} approved them (it was ${current}).`,
          );
          const gap = await approverGap(company, wanted);
          if (gap) warnings.push(gap);
          return {
            params: { id: company.id, approvalsRequired: String(wanted), from: String(current) },
            summary: `Change payment approvals for company ${describe(company)} from ${current} to ${wanted} required. ${wanted > current ? 'A stricter rule applies at once, to payments already waiting for approval as well as to new ones.' : 'A looser rule applies to payments created from now on: payments already waiting for approval are NOT affected and keep the rule they were created under.'}`,
            warnings,
          };
        },
        async apply(params) {
          const company = await companyOf(params.id);
          const wanted = Number(oneOf(params.approvalsRequired ?? '', ['0', '1', '2'], 'number of approvals')) as ApprovalsRequired;
          // Read and written in one transaction, and only this column: what was approved was a change FROM a particular
          // rule. If the rule has moved since, it is asked for again. (Already at the wanted rule: this request was
          // carried out before and interrupted; there is nothing left to do.)
          const saved = await stores.directory.updateCompany(company.id, (current) => {
            const from = approvalsRequiredOf(current);
            if (from !== wanted && String(from) !== params.from) throw new OpsError('The company’s approval rule changed since this was requested. Make the request again.', 409, 'stale');
            return { ...current, approvalsRequired: wanted };
          });
          if (!saved) throw new OpsError('No such company.', 404, 'not_found');
          return { target: companyParty(company), detail: { from: params.from ?? '', to: String(wanted) }, redirect: `/ops/companies/${company.id}?done=saved` };
        },
      });

      // --- FX margin ------------------------------------------------------------------
      // What Global Connect earns on a client's conversions. Staff can see it; no client API returns any of it.
      const marginFields = (current: MarginConfig) =>
        h`<label>Default margin, in basis points (100 = 1%) <input name="defaultBps" inputmode="numeric" required maxlength="5" value="${String(current.defaultBps)}"></label>
<label>Forward contracts, in basis points (leave empty to price forwards as spot) <input name="forwardBps" inputmode="numeric" maxlength="5" value="${current.forwardBps === null ? '' : String(current.forwardBps)}"></label>
<label>Overrides for a currency pair and direction, one per line: pair, then sell, buy or both (what the client does with the pair’s FIRST currency), then basis points. Example: GBPUSD sell 40 <textarea name="overrides" rows="3" maxlength="2000">${current.overrides.map((item) => `${item.pair} ${item.direction} ${item.bps}`).join('\n')}</textarea></label>
<label>Tiers by amount, one per line: from this amount (in the pair’s first currency), then basis points. Larger amounts, smaller margin. Example: 50000 35 <textarea name="tiers" rows="3" maxlength="1000">${current.tiers.map((item) => `${item.fromAmount} ${item.bps}`).join('\n')}</textarea></label>
<label><input type="checkbox" name="allowHigh" value="yes"> Allow a margin above ${String(MARGIN_USUAL_MAX_BPS)} basis points (${String(MARGIN_USUAL_MAX_BPS / 100)}%) in this request</label>`;
      const marginOfForm = (input: Form): { config: MarginConfig; allowHigh: boolean } => {
        const bps = (value: string, what: string): number => {
          if (!/^\d{1,5}$/.test(value)) throw new OpsError(`${what} must be a whole number of basis points, zero or more (100 = 1%). A negative margin is never accepted.`);
          return Number(value);
        };
        const lines = (name: string): string[] => text(input, name).split(/[\n;,]+/).map((line) => line.trim()).filter(Boolean);
        const forward = text(input, 'forwardBps');
        const allowHigh = text(input, 'allowHigh') === 'yes';
        const wanted: MarginConfig = {
          defaultBps: bps(text(input, 'defaultBps'), 'The default margin'),
          forwardBps: forward === '' ? null : bps(forward, 'The margin for forward contracts'),
          overrides: lines('overrides').map((line) => {
            const match = /^([A-Za-z]{6})\s+(sell|buy|both)\s+(-?\d+)$/i.exec(line);
            if (!match) throw new OpsError(`“${line.slice(0, 40)}” is not an override. Write the pair, then sell, buy or both, then basis points: GBPUSD sell 40`);
            return { pair: (match[1] ?? '').toUpperCase(), direction: (match[2] ?? '').toLowerCase() as MarginOverride['direction'], bps: bps(match[3] ?? '', `The margin for ${(match[1] ?? '').toUpperCase()}`) };
          }),
          tiers: lines('tiers').map((line) => {
            const match = /^(\d+(?:\.\d+)?)\s+(-?\d+)$/.exec(line);
            if (!match) throw new OpsError(`“${line.slice(0, 40)}” is not a tier. Write the amount it starts from, then basis points: 50000 35`);
            return { fromAmount: match[1] ?? '', bps: bps(match[2] ?? '', `The margin from ${match[1] ?? ''}`) };
          }),
        };
        try {
          return { config: checkMarginConfig(wanted, allowHigh), allowHigh };
        } catch (error) {
          if (error instanceof MarginError) throw new OpsError(error.message);
          throw error;
        }
      };
      /** The provider's rate now, for the worked example on the confirmation page. Staff only. */
      const providerRateFor = async (company: CompanyRecord, pair: string): Promise<string | null> => {
        try {
          return (await rates.providerRate(company, await registry.forCompany(company), pair.slice(0, 3), pair.slice(3))).rate;
        } catch {
          return null;
        }
      };
      action('/companies/:id/margin', {
        name: 'company.margin',
        fourEyes: true,
        // What every client of this company pays on every conversion: two staff, the second an ops admin who types
        // their password again.
        adminApproval: true,
        danger: true,
        password: true,
        async prepare({ form: input, params, aim }) {
          const company = await companyOf(params.id);
          aim(companyParty(company));
          const { config: wanted, allowHigh } = marginOfForm(input);
          const { config: current, record } = await rates.marginOf(company.id);
          if (record && JSON.stringify(current) === JSON.stringify(wanted)) throw new OpsError('That is already this company’s margin.');
          // A WORKED EXAMPLE, at the provider's rate now: the approver sees what the change does to a real trade.
          const rate = await providerRateFor(company, 'GBPUSD');
          if (!rate) throw new OpsError('The provider’s rate could not be fetched just now, so the worked example cannot be shown. Nothing was requested; try again in a moment.', 503, 'provider_unavailable');
          const examples = [workedExample(current, wanted, rate), workedExample(current, wanted, rate, 'GBPUSD', '10000', 'buy')];
          const topTier = [...wanted.tiers, ...current.tiers].map((item) => item.fromAmount).sort((a, b) => Number(b) - Number(a))[0];
          if (topTier) examples.push(workedExample(current, wanted, rate, 'GBPUSD', topTier));
          if (wanted.forwardBps !== current.forwardBps) examples.push(workedExample(current, wanted, rate, 'GBPUSD', '10000', 'sell', 'forward'));
          for (const item of wanted.overrides.filter((entry) => entry.pair !== 'GBPUSD' && entry.pair !== 'USDGBP').slice(0, 3)) {
            const other = await providerRateFor(company, item.pair);
            if (other) examples.push(workedExample(current, wanted, other, item.pair, '10000', item.direction === 'buy' ? 'buy' : 'sell'));
          }
          const warnings = [`Every conversion this company’s people book from the moment this is approved is priced with the new margin. Quotes they are already holding keep the rate they were given.`];
          const highest = Math.max(wanted.defaultBps, wanted.forwardBps ?? 0, ...wanted.overrides.map((item) => item.bps), ...wanted.tiers.map((item) => item.bps));
          if (highest > MARGIN_USUAL_MAX_BPS) warnings.push(`This sets a margin of ${highest} basis points (${highest / 100}%), above the usual limit of ${MARGIN_USUAL_MAX_BPS}. It was asked for explicitly.`);
          if (wanted.defaultBps === 0) warnings.push('The default margin becomes ZERO: Global Connect earns nothing on this company’s conversions unless an override or tier applies.');
          if (rates.appliedBy(company) === 'provider') warnings.push('For this company’s provider the margin is applied BY THE PROVIDER (MARGIN_APPLIED_BY_… = provider). This configuration is stored but is NOT used to price anything while that is so.');
          return {
            params: { id: company.id, config: JSON.stringify(wanted), from: JSON.stringify(current), allowHigh: allowHigh ? 'yes' : 'no' },
            summary: `Change the FX margin for company ${describe(company)} FROM ${describeMargin(current)}${record ? '' : ' (the server default)'} TO ${describeMargin(wanted)}. Worked example at the provider’s rate when this was requested: ${examples.join('; ')}.`,
            warnings,
          };
        },
        async apply(params, actors) {
          const company = await companyOf(params.id);
          let wanted: MarginConfig;
          try {
            // Checked again: what is stored is never taken on trust from a request written earlier.
            wanted = checkMarginConfig(JSON.parse(params.config ?? '') as MarginConfig, params.allowHigh === 'yes');
          } catch (error) {
            throw new OpsError(error instanceof MarginError ? error.message : 'That margin configuration cannot be read.');
          }
          const fallback = (await rates.marginOf('')).config;
          let from = params.from ?? '';
          await stores.margins.mutate(company.id, (current) => {
            const now_ = JSON.stringify(current ? marginConfigOf(current) : fallback);
            // What was approved was a change FROM a particular configuration. If it moved since, it is asked for again.
            if (now_ !== JSON.stringify(wanted) && now_ !== params.from) throw new OpsError('The company’s margin changed since this was requested. Make the request again.', 409, 'stale');
            from = now_ === JSON.stringify(wanted) ? from : now_;
            return { ...wanted, companyId: company.id, updatedAt: now(), updatedBy: actors.requester.email, approvedBy: actors.approver?.email ?? null };
          });
          return { target: companyParty(company), detail: { from: describeMargin(JSON.parse(from) as MarginConfig), to: describeMargin(wanted) }, redirect: `/ops/companies/${company.id}?done=saved` };
        },
      });

      // --- Revenue (ops admins only) -----------------------------------------------------
      const revenueRows = async (request: FastifyRequest) => {
        const companyId = queryOf(request, 'company');
        const day = (name: string, endOfDay: boolean): number | null => {
          const value = queryOf(request, name);
          if (value === '') return null;
          const at = /^\d{4}-\d{2}-\d{2}$/.test(value) ? Date.parse(`${value}T00:00:00.000Z`) : Number.NaN;
          if (Number.isNaN(at)) throw new OpsError('Dates are written YYYY-MM-DD.');
          return endOfDay ? at + 24 * 60 * 60_000 : at;
        };
        const [from, to] = [day('from', false), day('to', true)];
        const companies = new Map((await stores.directory.listCompanies()).map((company) => [company.id, company.name]));
        const rows = (await stores.revenue.list(companyId ? { companyId } : {}, (row) => row.status !== 'failed' && (from === null || (row.bookedAt ?? row.createdAt) >= from) && (to === null || (row.bookedAt ?? row.createdAt) < to)))
          .sort((a, b) => (b.bookedAt ?? b.createdAt) - (a.bookedAt ?? a.createdAt));
        return { rows, companies, filters: { company: companyId, from: queryOf(request, 'from'), to: queryOf(request, 'to') } };
      };
      page('/revenue', { admin: true }, async (ctx, request, reply) => {
        const { rows, companies, filters } = await revenueRows(request);
        // Totals by company, month and currency. Only conversions that are booked and whose margin this server applied have a figure.
        const totals = new Map<string, { company: string; month: string; currency: string; count: number; total: Big }>();
        for (const row of rows) {
          if (row.status !== 'booked' || row.revenueAmount === null || row.revenueCurrency === null) continue;
          const month = new Date(row.bookedAt ?? row.createdAt).toISOString().slice(0, 7);
          const key = `${row.companyId}:${month}:${row.revenueCurrency}`;
          const entry = totals.get(key) ?? { company: companies.get(row.companyId) ?? row.companyId, month, currency: row.revenueCurrency, count: 0, total: new Big(0) };
          totals.set(key, { ...entry, count: entry.count + 1, total: entry.total.plus(row.revenueAmount) });
        }
        const query = new URLSearchParams(Object.entries(filters).filter(([, value]) => value !== '')).toString();
        return send(
          reply,
          200,
          layout(
            chromeOf(ctx, 'Revenue'),
            h`<div class="card"><h2>Conversions and what Global Connect earned</h2><p class="muted">For ops admins only. None of this is ever sent to a client. Revenue is the difference between the provider’s side of a conversion and the client’s, in the currency it arises in (the side the client did not fix); it is not converted to one currency here.</p>
<form method="get" action="/ops/revenue"><label>Company <select name="company"><option value="">All</option>${[...companies].map(([id, name]) => h`<option value="${id}"${id === filters.company ? h` selected` : ''}>${name}</option>`)}</select></label><label>From (YYYY-MM-DD) <input name="from" value="${filters.from}" maxlength="10"></label><label>To (YYYY-MM-DD) <input name="to" value="${filters.to}" maxlength="10"></label><button type="submit">Show</button></form>
<p><a href="/ops/revenue.csv${query ? `?${query}` : ''}">Download these conversions as CSV</a></p></div>
<div class="card"><h2>Totals by company and month</h2><table><tr><th>Company</th><th>Month</th><th>Conversions</th><th>Revenue</th></tr>${[...totals.values()].map((item) => h`<tr><td>${item.company}</td><td>${item.month}</td><td>${String(item.count)}</td><td>${item.currency} ${item.total.toFixed(currencyDecimals(item.currency))}</td></tr>`)}</table>${totals.size === 0 && h`<p class="muted">Nothing booked in this period.</p>`}</div>
<div class="card"><h2>Conversions</h2><table><tr><th>When</th><th>Company</th><th>Trade</th><th>Provider rate</th><th>Client rate</th><th>Margin</th><th>Revenue</th><th>Status</th></tr>${rows.slice(0, 200).map(
              (row) =>
                h`<tr><td>${when(row.bookedAt ?? row.createdAt)}</td><td><a href="/ops/companies/${row.companyId}">${companies.get(row.companyId) ?? row.companyId}</a></td><td>${row.kind === 'forward' ? 'Forward: ' : ''}sold ${row.sellCurrency} ${row.clientSellAmount}, bought ${row.buyCurrency} ${row.clientBuyAmount}</td><td>${row.providerRate}</td><td>${row.clientRate}</td><td>${row.marginBps === null ? 'by the provider' : `${row.marginBps} bp`}</td><td>${row.revenueAmount === null ? 'not known here' : `${row.revenueCurrency ?? ''} ${row.revenueAmount}`}</td><td>${row.status === 'booked' ? (row.mismatch ? h`<span class="tag bad">Booked: CHECK, the provider did not confirm the client’s terms</span>` : 'Booked') : h`<span class="tag bad">Not confirmed by the provider</span>`}</td></tr>`,
            )}</table>${rows.length === 0 && h`<p class="muted">No conversions in this period.</p>`}${rows.length > 200 && h`<p class="muted">Showing the latest 200 of ${String(rows.length)}. The CSV has them all.</p>`}</div>`,
          ),
        );
      });
      page('/revenue.csv', { admin: true }, async (ctx, request, reply) => {
        const { rows, companies, filters } = await revenueRows(request);
        // A cell that a spreadsheet would run as a formula is written as text.
        const cell = (value: string | number | null): string => {
          const textValue = value === null ? '' : String(value);
          const safe = /^[=+\-@\t\r]/.test(textValue) && !/^-?\d+(\.\d+)?$/.test(textValue) ? `'${textValue}` : textValue;
          return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
        };
        const header = ['booked_at', 'company_id', 'company', 'conversion_id', 'status', 'kind', 'pair', 'direction', 'sell_currency', 'buy_currency', 'provider_rate', 'client_rate', 'provider_sell_amount', 'provider_buy_amount', 'client_sell_amount', 'client_buy_amount', 'margin_bps', 'margin_applied_by', 'revenue_amount', 'revenue_currency', 'needs_checking'];
        const lines = rows.map((row) =>
          [new Date(row.bookedAt ?? row.createdAt).toISOString(), row.companyId, companies.get(row.companyId) ?? '', row.conversionId, row.status, row.kind, row.pair, row.direction, row.sellCurrency, row.buyCurrency, row.providerRate, row.clientRate, row.providerSellAmount, row.providerBuyAmount, row.clientSellAmount, row.clientBuyAmount, row.marginBps, row.appliedBy, row.revenueAmount, row.revenueCurrency, row.mismatch || row.status !== 'booked' ? 'yes' : 'no'].map(cell).join(','),
        );
        await append(opsParty(ctx.user), 'ops.revenue.export', 'success', null, request.ip, { rows: String(rows.length), company: filters.company || 'all', from: filters.from || '-', to: filters.to || '-' });
        return reply.status(200).type('text/csv; charset=utf-8').header('Content-Disposition', 'attachment; filename="global-connect-revenue.csv"').send(`${[header.join(','), ...lines].join('\r\n')}\r\n`);
      });
      for (const [verb, deactivate] of [['deactivate', true], ['reactivate', false]] as const) {
        action(`/companies/:id/${verb}`, {
          name: `company.${verb}`,
          danger: deactivate,
          // Taking access away is immediate. Giving it back needs a second person.
          fourEyes: !deactivate,
          async prepare({ params, aim }) {
            const company = await companyOf(params.id);
            aim(companyParty(company));
            const members = await membersOf(company.id);
            const people = `${members.length} ${members.length === 1 ? 'person is' : 'people are'} attached to it`;
            return {
              params: { id: company.id },
              summary: `${deactivate ? 'Deactivate' : 'Reactivate'} company ${describe(company)}`,
              warnings: [deactivate ? `${people}. None of them will be able to select or use this company until it is reactivated, which needs a second staff member.` : `${people} and will be able to use it again.`],
            };
          },
          async apply(params) {
            const company = await companyOf(params.id);
            // Only this column, on the row as it is now.
            await stores.directory.updateCompany(company.id, (current) => ({ ...current, deactivatedAt: deactivate ? (current.deactivatedAt ?? now()) : null }));
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
            h`<div class="card narrow"><form method="post" action="/ops/users">${csrfInput(ctx)}<label>Name <input name="name" required maxlength="120"></label><label>Email <input type="email" name="email" required maxlength="254"></label>${[1, 2, 3].map(pick)}<p class="muted">The activation link will be emailed to this address, so it must be the client’s own. More companies can be attached afterwards.</p>${fourEyesNote}<button>${config.fourEyes ? 'Request: create client user' : 'Create client user'}</button></form></div>`,
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
          warnings.push(`No email is sent yet. The account cannot be used until an activation link is emailed to ${maskEmail(email)} from the person’s page (a separate request).`);
          return { params, summary: `Create client user ${name} <${email}> in ${[...memberships.values()].map(({ company, role }) => `${describe(company)} as ${role}`).join(', ')}`, warnings };
        },
        async apply(params, { requestId }) {
          // Named after the request that creates it: carrying the same request out twice makes one person.
          const id = requestId ? `usr_${sha256(`client:${requestId}`).slice(0, 12)}` : `usr_${randomToken().slice(0, 12)}`;
          const made = await stores.directory.getUser(id);
          if (made) {
            for (const index of [1, 2, 3]) {
              const companyId = text(params, `company${index}`);
              if (companyId) await stores.directory.setMembership({ userId: id, companyId, role: oneOf(text(params, `role${index}`), CLIENT_ROLES, 'role') });
            }
            return { target: clientParty(made), detail: { companies: 'already created by this request' }, redirect: `/ops/users/${id}?done=created` };
          }
          const { name, email, memberships } = await newClientOf(params);
          const user: UserRecord = { id, email, name, passwordHash: null, totpSecret: null, lastTotpStep: 0, recoveryCodeHashes: [], activatedAt: null, disabledAt: null, lastSignInAt: null };
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
        const notes = await notifier.stateOf(user.id);
        const alertCounts = await alerts.countsOf(user.id);
        const nameOf = (companyId: string) => companies.find((company) => company.id === companyId)?.name ?? companyId;
        const free = companies.filter((company) => !company.deactivatedAt && !memberships.some((item) => item.companyId === company.id));
        const pendingReset = (await stores.auth.authenticatorResets.list({ userId: user.id, status: 'waiting' }))[0];
        const pendingResetCard = pendingReset
          ? h`<div class="card"><h2>Authenticator reset waiting</h2><p class="warn">Approved by ${pendingReset.approvedBy} on ${when(pendingReset.approvedAt)}. Nothing has changed yet. It takes effect on ${when(pendingReset.dueAt)} unless this person signs in with their current credentials first, or an ops admin cancels it.</p>${ctx.user.role === 'ops_admin' ? form(ctx, `/ops/authenticator-resets/${pendingReset.id}/cancel`, h``, 'Cancel reset') : ''}</div>`
          : '';
        // Status only. No credential of the person is read into this page.
        return send(
          reply,
          200,
          layout(
            chromeOf(ctx, user.name, flashOf(request)),
            h`<div class="grid"><div><div class="card"><h2>Status</h2><dl><dt>Email</dt><dd>${user.email}</dd><dt>Activated</dt><dd>${user.activatedAt ? `Yes, ${when(user.activatedAt)}` : 'No'}</dd><dt>Last sign-in</dt><dd>${when(user.lastSignInAt)}</dd><dt>Locked out</dt><dd>${locked ? 'Yes' : 'No'}</dd><dt>Active sessions</dt><dd>${sessions}</dd><dt>Account</dt><dd>${tag(!user.disabledAt, 'Enabled', 'Disabled')}</dd></dl></div>
<div class="card"><h2>Companies</h2><table><tr><th>Company</th><th>Role</th><th></th></tr>${memberships.map(
              (item) => h`<tr><td><a href="/ops/companies/${item.companyId}">${nameOf(item.companyId)}</a></td><td>${form(ctx, `${base}/memberships`, h`<input type="hidden" name="companyId" value="${item.companyId}"><label>Role ${roleSelect('role', CLIENT_ROLES, item.role)}</label>`, 'Change role', { request: true })}</td><td>${form(ctx, `${base}/memberships/remove`, h`<input type="hidden" name="companyId" value="${item.companyId}">`, 'Remove', { danger: true })}</td></tr>`,
            )}</table>${free.length > 0 && h`<h2>Attach to a company</h2>${form(ctx, `${base}/memberships`, h`<label>Company <select name="companyId" required>${free.map((company) => h`<option value="${company.id}">${company.name}</option>`)}</select></label><label>Role ${roleSelect('role', CLIENT_ROLES)}</label>`, 'Attach', { request: true })}`}</div></div>
<div>${pendingResetCard}${
              user.activatedAt === null
                ? h`<div class="card"><h2>Activation link</h2><p class="muted">Emails a new link to ${maskEmail(user.email)} and cancels any earlier one. Valid for 72 hours. The link is never shown to staff.</p>${fourEyesNote}${form(ctx, `${base}/activation-link`, h``, 'Email activation link', { request: true })}</div>`
                : h`<div class="card"><h2>Reset authenticator</h2><p class="warn">${VERIFY_WARNING}</p><p class="muted">Removes the authenticator, the recovery codes and the password, ends every session and emails a new activation link to ${maskEmail(user.email)}.</p>${fourEyesNote}<form method="post" action="${base}/reset-authenticator">${csrfInput(ctx)}${verifyField}<div class="row tight"><button class="danger">${config.fourEyes ? 'Request: reset authenticator' : 'Reset authenticator'}</button></div></form></div>`
            }
${locked && h`<div class="card"><h2>Unlock</h2><p class="muted">Clears the failed-attempt count so the person can try again now.</p>${form(ctx, `${base}/unlock`, h``, 'Unlock account')}</div>`}
<div class="card"><h2>Sessions</h2>${form(ctx, `${base}/revoke-sessions`, h``, 'Revoke all sessions')}</div>
<div class="card"><h2>Notifications</h2><dl><dt>In the app</dt><dd>${String(notes.total)} kept, ${String(notes.unread)} unread${notes.latestAt !== null ? h` (the latest ${when(notes.latestAt)})` : ''}</dd><dt>Also by email</dt><dd>Rate alerts: ${notes.email.rates ? 'on' : 'off'}. Payments to approve: ${notes.email.approvals ? 'on' : 'off'}. Their own payments: ${notes.email.payments ? 'on' : 'off'}. Security notices: always on.</dd><dt>Rate alerts</dt><dd>${String(alertCounts.active)} on, ${String(alertCounts.triggered)} fired, ${String(alertCounts.paused)} paused</dd></dl><p class="muted">What a notification or an alert says is never shown to staff. Only the person can change these choices, in the app.</p></div>
<div class="card"><h2>${user.disabledAt ? 'Re-enable' : 'Disable'}</h2><p class="muted">A disabled person cannot sign in. Disabling ends every session at once. Re-enabling gives back the old password and authenticator, so it needs a second staff member.</p>${
              user.disabledAt ? form(ctx, `${base}/enable`, h``, 'Re-enable user', { request: true }) : form(ctx, `${base}/disable`, h``, 'Disable user', { danger: true })
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
          const current = (await stores.directory.membershipsOf(user.id)).find((item) => item.companyId === company.id)?.role;
          if (current === role) throw new OpsError('The person already has that role in that company.');
          return {
            params: { id: user.id, companyId: company.id, role },
            summary: current ? `Change the role of ${user.name} <${user.email}> in ${describe(company)} from ${current} to ${role}` : `Attach ${user.name} <${user.email}> to ${describe(company)} with the role ${role}`,
            warnings: [await domainCheck(user.email, company, user.id)],
          };
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
        danger: true,
        async prepare({ form: input, params, aim }) {
          const user = await clientOf(params.id);
          aim(clientParty(user));
          const company = await companyOf(text(input, 'companyId'));
          const role = (await stores.directory.membershipsOf(user.id)).find((item) => item.companyId === company.id)?.role;
          if (!role) throw new OpsError('The person is not in that company.');
          return { params: { id: user.id, companyId: company.id }, summary: `Remove ${user.name} <${user.email}> (${role}) from ${describe(company)}`, warnings: ['They lose access to this company at once. Putting them back needs a second staff member.'] };
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
          return { params: { id: user.id }, summary: `Email an activation link to client ${user.name} <${user.email}>`, warnings: [`An email with a new link, valid for 72 hours, will be sent to ${maskEmail(user.email)}. Any earlier link stops working. The link is never shown to staff.`] };
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
      const delayHours = config.authenticatorResetDelayMs / 3_600_000;
      const delayText = `${String(Math.round(delayHours * 10) / 10)} ${delayHours === 1 ? 'hour' : 'hours'}`;
      // Cancelling is the safe direction, so one ops admin is enough; it is confirmed and audited like any action.
      post('/authenticator-resets/:id/cancel', { name: 'authenticator_reset.cancel', admin: true }, async ({ ctx, params, source, aim, confirm }) => {
        const item = await stores.auth.authenticatorResets.get(params.id ?? '');
        if (!item || item.status !== 'waiting') throw new OpsError('This reset is no longer waiting.', 409, 'not_pending');
        const user = await clientOf(item.userId);
        aim(clientParty(user));
        await confirm({
          title: `Cancel the authenticator reset of client ${user.name} <${user.email}>`,
          notes: [`Approved by ${item.approvedBy} on ${when(item.approvedAt)} (requested by ${item.requestedBy}). It would take effect on ${when(item.dueAt)}.`],
          effect: 'The reset will not happen. Nothing about the account is changed: its password, authenticator and recovery codes go on working. The client is told by email.',
        });
        if (!(await authenticatorResets.cancel(item.id, ctx.user.email, source))) throw new OpsError('This reset is no longer waiting.', 409, 'not_pending');
        return { detail: { reset: item.id, request: item.requestId, approvedBy: item.approvedBy }, redirect: `/ops/users/${user.id}?done=reset_cancelled` };
      });
      action('/users/:id/reset-authenticator', {
        name: 'client.reset_authenticator',
        fourEyes: true,
        danger: true,
        password: true,
        async prepare({ form: input, params, aim }) {
          aim(clientParty(await clientOf(params.id)));
          const user = await resettable(params.id);
          const identityVerification = needVerification(input);
          const sessions = await auth.activeSessionCount(user.id);
          return {
            params: { id: user.id, identityVerification },
            summary: `Reset the authenticator of client ${user.name} <${user.email}>`,
            warnings: [
              `Removes their password, authenticator and recovery codes, ends ${sessions === 1 ? 'their 1 active session' : `their ${sessions} active sessions`}, and emails a new activation link to ${maskEmail(user.email)}. Whoever reads that mailbox gets the account.`,
              config.authenticatorResetDelayMs > 0
                ? `Once approved, NOTHING changes for ${delayText}: the client is emailed a notice at once, their current credentials go on working, and the reset is cancelled if they sign in with them or if an ops admin cancels it. Only after ${delayText} are the credentials cleared and the link sent.`
                : 'THE DELAY IS SWITCHED OFF (AUTHENTICATOR_RESET_DELAY_HOURS=0, development only): the reset happens as soon as it is approved.',
              `How their identity was verified: “${identityVerification}”. Check this before approving.`,
            ],
          };
        },
        async apply(params, { requester, approver, source, requestId }) {
          const user = await clientOf(params.id);
          if (user.disabledAt) throw new OpsError('Re-enable this person first.');
          // NOTHING is cleared here. The reset is put down to happen after the delay; the client is told now, can cancel
          // it by simply signing in, and so can any ops admin (see auth/authenticatorResets.ts). One reset per request,
          // however often this is carried out.
          const reset = await authenticatorResets.schedule(user, { id: requestId ?? `direct_${randomToken().slice(0, 12)}`, requestedBy: requester.email, approvedBy: (approver ?? requester).email }, source);
          return {
            target: clientParty(user),
            detail: { identityVerification: params.identityVerification ?? '', reset: reset.id, status: reset.status, takesEffect: when(reset.dueAt), noticeTo: maskEmail(user.email) },
            redirect: `/ops/users/${user.id}?done=${reset.status === 'done' ? 'mailed' : 'reset_scheduled'}`,
          };
        },
      });
      /** Client actions on one person. Those that take access away are immediate; giving it back (`fourEyes`) needs a second person. */
      const simple = (path: string, name: string, flash: string, say: { verb: string; danger?: boolean; consequence: (sessions: string) => string }, run: (user: UserRecord, actors: Actors) => Promise<Record<string, string> | void>, fourEyes = false) =>
        action(`/users/:id/${path}`, {
          name,
          fourEyes,
          danger: say.danger,
          async prepare({ params, aim }) {
            const user = await clientOf(params.id);
            aim(clientParty(user));
            const count = await auth.activeSessionCount(user.id);
            return { params: { id: user.id }, summary: `${say.verb} client ${user.name} <${user.email}>`, warnings: [say.consequence(count === 1 ? '1 active session' : `${count} active sessions`)] };
          },
          async apply(params, actors) {
            const user = await clientOf(params.id);
            const detail = await run(user, actors);
            return { target: clientParty(user), detail: detail ?? {}, redirect: `/ops/users/${user.id}?done=${flash}` };
          },
        });
      simple('unlock', 'client.unlock', 'unlocked', { verb: 'Unlock', consequence: () => 'Clears the count of failed sign-in attempts, so the person can try again now. Their password and authenticator are not changed.' }, async (user) => auth.unlock(user));
      simple('revoke-sessions', 'client.revoke_sessions', 'revoked', { verb: 'Revoke all sessions of', consequence: (sessions) => `Ends their ${sessions}. They are signed out everywhere and can sign in again.` }, async (user, { requester, source }) => ({ sessions: String(await revokeClientSessions(requester, user, source, 'revoked by ops')) }));
      simple('disable', 'client.disable', 'disabled', { verb: 'Disable', danger: true, consequence: (sessions) => `They cannot sign in until re-enabled, which needs a second staff member. Ends their ${sessions} and cancels any unused activation link.` }, async (user, { requester, source }) => {
        await stores.directory.updateUser(user.id, (current) => ({ ...current, disabledAt: now() }));
        await stores.auth.activations.deleteWhere({ userId: user.id });
        await revokeClientSessions(requester, user, source, 'user disabled');
        // A reset that was waiting has nobody left to reset.
        await auth.cancelAuthenticatorResets(user, 'account disabled', source);
        await notices.send({ id: user.id, email: user.email, name: user.name }, 'client', 'account_disabled');
      });
      // Re-enabling restores the person's old password and authenticator: a second person has to agree.
      simple(
        'enable',
        'client.enable',
        'enabled',
        { verb: 'Re-enable', consequence: () => 'They can sign in again with the password and authenticator they had before.' },
        async (user) => {
          await stores.directory.updateUser(user.id, (current) => ({ ...current, disabledAt: null }));
          await notices.send({ id: user.id, email: user.email, name: user.name }, 'client', 'account_enabled');
        },
        true,
      );

      // --- Audit log: read only. There is no route that changes or removes an entry. ---
      // --- Mail --------------------------------------------------------------------
      // The outbox, as numbers and as a list of what did not go: who it was for (masked), what kind of message, how
      // often it was tried and a short error code. Never a subject, a body or a link.
      page('/mail', {}, async (ctx, _request, reply) => {
        const { counts, oldestQueuedAt, problems } = await mail.summary();
        return send(
          reply,
          200,
          layout(
            chromeOf(ctx, 'Mail'),
            h`<div class="card"><h2>Outbox</h2><dl><dt>Waiting to be sent</dt><dd>${String(counts.queued + counts.sending)}${oldestQueuedAt !== null ? h` (the oldest since ${when(oldestQueuedAt)})` : ''}</dd><dt>Sent</dt><dd>${String(counts.sent)}</dd><dt>Failed</dt><dd>${String(counts.failed)}</dd><dt>Not sent: over a limit</dt><dd>${String(counts.suppressed)}</dd></dl>
<p class="muted">${config.smtp ? h`Email is sent through the mail server ${config.smtp.host}.` : 'No mail server is configured: in development mode every email is printed in the server console instead.'} A message that cannot be sent is tried again ${String(MAIL_MAX_ATTEMPTS - 1)} more times over about four and a half hours, then marked failed. At most ${String(config.mailPerRecipientPerHour)} messages an hour are queued for one address, and ${String(config.mailGlobalPerHour)} for everyone together. Sent messages are counted for 30 days.</p></div>
<div class="card"><h2>Not delivered</h2><table><tr><th>Queued</th><th>To</th><th>Kind</th><th>Status</th><th>Attempts</th><th>Error</th></tr>${problems.map(
              (item) => h`<tr><td>${when(item.createdAt)}</td><td>${maskEmail(item.to)}</td><td>${item.category}: ${item.template}</td><td>${item.status === 'queued' ? 'waiting to be tried again' : item.status}</td><td>${String(item.attempts)}</td><td>${item.lastError ?? ''}</td></tr>`,
            )}</table>${problems.length === 0 && h`<p class="muted">Nothing has failed or been held back.</p>`}<p class="muted">The content of a message is never shown here. An activation link that failed can be issued again from the person’s page.</p></div>`,
          ),
        );
      });

      page('/audit', {}, async (ctx, request, reply) => {
        const [actor, target, act, from, to] = ['actor', 'target', 'action', 'from', 'to'].map((name) => queryOf(request, name)) as [string, string, string, string, string];
        const day = (value: string, end: boolean): number | undefined => {
          if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
          const at = Date.parse(`${value}T00:00:00Z`);
          return Number.isNaN(at) ? undefined : at + (end ? 86_400_000 - 1 : 0);
        };
        const entries = await stores.audit.query({ actor, target, action: act, from: day(from, false), to: day(to, true), limit: 500 });
        const held = stores.audit.counts();
        return send(
          reply,
          200,
          layout(
            chromeOf(ctx, 'Audit log'),
            h`<div class="card"><form method="get" action="/ops/audit"><div class="row"><label>Actor <input name="actor" value="${actor}"></label><label>Target <input name="target" value="${target}"></label><label>Action <input name="action" value="${act}"></label><label>From (UTC) <input type="date" name="from" value="${from}"></label><label>To (UTC) <input type="date" name="to" value="${to}"></label><button class="quiet">Filter</button></div></form></div>
<div class="card"><table><tr><th>Time</th><th>Actor</th><th>Action</th><th>Target</th><th>Outcome</th><th>Source</th><th>Detail</th></tr>${entries.map(
              (entry) => h`<tr${/^(ops\.(staff\.new|break_glass)|system\.audit\.resealed)/.test(entry.action) ? h` class="alert"` : ''}><td>${when(entry.at)}</td><td>${entry.actor.label} <span class="muted">(${entry.anonymous ? 'not identified' : entry.actor.type})</span></td><td>${entry.action}</td><td>${entry.target ? entry.target.label : ''}</td><td>${tag(entry.outcome === 'success', 'success', 'failure')}</td><td>${entry.source}</td><td>${Object.entries(entry.detail).map(([key, value]) => h`<div>${key}: ${value}</div>`)}</td></tr>`,
            )}</table>${entries.length === 0 && h`<p class="muted">No entries match.</p>`}<p class="muted">The log holds ${String(held.live + held.archived)} ${held.live + held.archived === 1 ? 'entry' : 'entries'}; ${String(held.archived)} of the oldest are in the archive, and are searched and shown here like the rest.</p><p class="muted">Newest first, at most 500 entries. Entries cannot be changed or removed. Failures by people who were not identified (a wrong password, for example) are kept separately: only the most recent, and only a limited number per source address.</p></div>`,
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
        danger: true,
        password: true,
        async prepare({ form: input, aim }) {
          const { name, email, role } = await newStaffOf(input);
          aim({ type: 'ops', id: null, label: email });
          return { params: { name, email, role }, summary: `Invite ${name} <${email}> as staff with the role ${role}`, warnings: ['This creates a new member of staff, who will be able to act on client accounts. Approve only if you know this person and this address.', `An activation email will be sent to ${maskEmail(email)}.`] };
        },
        async apply(params, { requester, approver, source, requestId }) {
          // Carried out before and interrupted after the account was made: the account is this request's, the email is sent again.
          const begun = requestId ? await stores.ops.users.findByEmail(needEmail(params)) : null;
          if (begun && begun.activatedAt === null && !begun.disabledAt && begun.name === params.name && begun.role === params.role) return { target: opsParty(begun), detail: { role: begun.role, ...(await mailStaffLink(begun)) }, redirect: `/ops/staff/${begun.id}?done=mailed` };
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
    : h`<div class="card"><h2>Reset authenticator</h2><p class="warn">${VERIFY_WARNING}</p><form method="post" action="${base}/reset-authenticator">${csrfInput(ctx)}${verifyField}<div class="row tight"><button class="danger">${config.fourEyes ? 'Request: reset authenticator' : 'Reset authenticator'}</button></div></form></div>`
}
<div class="card"><h2>${user.disabledAt ? 'Re-enable' : 'Disable'}</h2>${user.disabledAt ? form(ctx, `${base}/enable`, h``, 'Re-enable', { request: true }) : form(ctx, `${base}/disable`, h``, 'Disable', { danger: true, request: true })}</div>`
            }</div></div>`,
          ),
        );
      });
      /** A staff-management action on one existing staff member. `check` runs when it is requested AND again when it is carried out. */
      const staffAction = (path: string, name: string, options: { mails?: boolean; flash: string; summary: (user: OpsUserRecord, params: Record<string, string>) => string; consequence?: (user: OpsUserRecord, params: Record<string, string>) => string }, check: (user: OpsUserRecord, input: Record<string, string>, requesterId: string, carryingOut: boolean) => Promise<Record<string, string>>, run: (user: OpsUserRecord, params: Record<string, string>, actors: Actors) => Promise<Record<string, string> | void>) =>
        action(`/staff/:id/${path}`, {
          name,
          admin: true,
          fourEyes: true,
          adminApproval: true,
          mails: options.mails,
          // Every change to who is staff, or to what a member of staff can do, is high-impact.
          danger: true,
          password: true,
          async prepare({ actor, form: input, params, aim }) {
            const user = await staffOf(params.id);
            aim(opsParty(user));
            const checked = { id: user.id, ...(await check(user, input, actor.id, false)) };
            return { params: checked, summary: options.summary(user, checked), warnings: options.consequence ? [options.consequence(user, checked)] : [] };
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
        { flash: 'saved', summary: (user, params) => `Change the staff role of ${user.name} <${user.email}> from ${user.role} to ${params.role}`, consequence: (_user, params) => (params.role === 'ops_admin' ? 'As an ops admin they can manage staff and companies and approve those changes.' : 'As an ops user they can no longer manage staff or companies, or approve those changes.') },
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
        { flash: 'disabled', summary: (user) => `Disable staff member ${user.name} <${user.email}>`, consequence: () => 'They are signed out at once, cannot sign in until re-enabled, and any unused activation link is cancelled.' },
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
        { flash: 'enabled', summary: (user) => `Re-enable staff member ${user.name} <${user.email}>`, consequence: (user) => `They can sign in again, as ${user.role}, with the password and authenticator they had before.` },
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
        { mails: true, flash: 'mailed', summary: (user) => `Email an activation link to staff member ${user.name} <${user.email}>`, consequence: (user) => `An email with a new link will be sent to ${maskEmail(user.email)}. Any earlier link stops working. The link is never shown to staff.` },
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
        { flash: 'unlocked', summary: (user) => `Unlock staff member ${user.name} <${user.email}> (clear failed sign-in attempts)`, consequence: () => 'They can try to sign in again now. Their password and authenticator are not changed.' },
        async () => ({}),
        async (user) => opsAuth.unlock(user),
      );
      staffAction(
        'reset-authenticator',
        'staff.reset_authenticator',
        { mails: true, flash: 'mailed', summary: (user) => `Reset the authenticator of staff member ${user.name} <${user.email}>`, consequence: (user, params) => `Removes their password, authenticator and recovery codes, signs them out, and emails a new activation link to ${maskEmail(user.email)}. How their identity was verified: “${params.identityVerification ?? ''}”.` },
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
