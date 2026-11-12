/**
 * The HTTP API the app talks to. Three rules hold for every route:
 *
 *  1. The company is ALWAYS the one selected in the session. No route reads a
 *     company, account or provider id from the request.
 *  2. Responses carry only provider-neutral shapes and neutral error kinds.
 *     Upstream error text is never forwarded.
 *  3. Request bodies, headers and tokens are never logged.
 */
import path from 'node:path';

import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyRequest } from 'fastify';
import { z } from 'zod';

import { isProviderError, type ProviderError } from '@/api/errors';
import * as schemas from '@/api/schemas';
import type { NewBeneficiary, Quote, Session, StepUpAction, UserRole } from '@/api/types';

import { AuthService, partyOf, reasonOf, type SessionContext } from '../auth/service';
import type { Config } from '../config';
import { safeEqual, sha256 } from '../crypto';
import { ApiError } from '../errors';
import { activationMessage, maskEmail, type Mailer } from '../mailer';
import { assertAmount } from '../money';
import { networkOf, sourceOf } from '../net';
import { emailDomain, hasControlCharacters, isEmail } from '../validate';
import { isActiveStaff, OpsAuthService } from '../ops/auth';
import { registerOps } from '../ops/console';
import type { ProviderAdapter, ProviderRegistry } from '../providers/adapter';
import type { CompanyRecord, Stores } from '../store/types';

export interface AppDeps {
  config: Config;
  stores: Stores;
  registry: ProviderRegistry;
  /** Delivers activation links to the address on file. Links are never returned over HTTP. */
  mailer: Mailer;
  now?: () => number;
  /** Where request logs go (tests). Defaults to stdout. */
  logStream?: { write(line: string): void };
  /** Most addresses the rate limiter tracks at once, and most quotes held (tests lower them). */
  maxRateWindows?: number;
  maxHeldQuotes?: number;
}

/**
 * What is logged about a request: method, PATH and where it came from. The
 * query string is dropped (it can carry search terms or, from an old link, a
 * code); headers and bodies are never logged.
 */
export function requestLogEntry(request: { method?: string; url?: string; ip?: string }) {
  return { method: request.method, url: (request.url ?? '').split('?')[0], remoteAddress: request.ip };
}

/**
 * The client web app (and, harmlessly, JSON) is served with this policy. Scripts and connections only from this origin;
 * styles may be inline because the web build injects its style sheet at run time; no framing by anyone.
 */
const WEB_APP_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'";

/**
 * Most addresses the rate limiter tracks. When full, windows that have run out
 * are dropped; if every tracked address is still inside its minute, a NEW
 * address is refused. Nobody's count is ever reset to make room.
 */
const MAX_RATE_WINDOWS = 50_000;
/** Most quotes held. When full, expired ones go first, then the oldest. */
const MAX_HELD_QUOTES = 20_000;

interface CompanyContext extends SessionContext {
  company: CompanyRecord;
  role: UserRole;
}

const BASE_STEP_UP: StepUpAction[] = ['payment.create', 'payment.approve', 'payment.reject', 'beneficiary.create'];
const MAY: Record<StepUpAction, UserRole[]> = {
  'payment.create': ['creator', 'admin'],
  'beneficiary.create': ['creator', 'admin'],
  'conversion.book': ['creator', 'admin'],
  'payment.approve': ['approver', 'admin'],
  'payment.reject': ['approver', 'admin'],
};

/** Parse with a schema from the shared file; a failure becomes a neutral `validation` error naming the fields. */
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  throw new ApiError('validation', { fields: [...new Set(result.error.issues.map((issue) => String(issue.path[0] ?? '')).filter(Boolean))] });
}

/** What a provider failure looks like to the app. A provider refusing OUR credentials is our fault, not the customer's session. */
function fromProviderError(error: ProviderError): ApiError {
  const kind = error.kind === 'unauthorized' || error.kind === 'forbidden' || error.kind === 'rate_limited' ? 'server' : error.kind;
  return new ApiError(kind, { reason: error.reason, fields: [...error.fields] });
}

function bearer(request: FastifyRequest): string | undefined {
  const header = request.headers.authorization;
  return header?.startsWith('Bearer ') ? header.slice(7) : undefined;
}

function header(request: FastifyRequest, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

const SYSTEM = { type: 'system' as const, id: null, label: 'operator command' };

/**
 * Bootstrap for `npm run create-ops-admin`. Staff management in the console
 * needs an ops admin to ask and a DIFFERENT ops admin to approve, so this
 * command may create ops admins while FEWER THAN TWO active ops admins exist
 * (or re-send the link of one that is not yet activated). After that it
 * refuses and staff are invited from the console. The address must be at an
 * allowed staff domain. The link goes to the mailer, never back to the caller.
 */
export async function bootstrapOpsAdmin(stores: Stores, opsAuth: OpsAuthService, mailer: Mailer, config: Pick<Config, 'staffEmailDomains'>, email: string, name: string, at: number, source: string) {
  if (!config.staffEmailDomains.includes(emailDomain(email))) return null;
  const staff = await stores.ops.users.list();
  if (staff.filter((user) => user.role === 'ops_admin' && isActiveStaff(user)).length >= 2) return null;
  const existing = await stores.ops.users.findByEmail(email);
  if (existing && (existing.role !== 'ops_admin' || existing.disabledAt !== null || existing.activatedAt !== null)) return null;
  const user = existing ?? (await opsAuth.createUser(email, name, 'ops_admin'));
  const invite = await opsAuth.createInvite(user.id);
  await mailer.send(activationMessage(invite, user.email, user.name, 'staff'));
  await stores.audit.append({ at, actor: SYSTEM, target: { type: 'ops', id: user.id, label: user.email }, action: existing ? 'ops.bootstrap_admin' : 'ops.staff.new', outcome: 'success', source, detail: { role: 'ops_admin', how: 'operator command (bootstrap)' } });
  return { sentTo: maskEmail(user.email), expiresAt: invite.expiresAt };
}

/**
 * The operator commands (`npm run invite`, `npm run create-ops-admin`). This
 * is a SEPARATE server that index.ts binds to the loopback address only; the
 * public listener has no /admin route at all. Still guarded by ADMIN_TOKEN.
 */
export async function buildAdminApp(deps: { config: Config; stores: Stores; auth: AuthService; opsAuth: OpsAuthService; mailer: Mailer; now: () => number }) {
  const { config, stores, auth, opsAuth, mailer, now } = deps;
  const admin = Fastify({ bodyLimit: 16 * 1024, logger: false });
  admin.setErrorHandler((error, _request, reply) => {
    const apiError = error instanceof ApiError ? error : new ApiError((error as { statusCode?: number }).statusCode === 400 ? 'validation' : 'server', { status: (error as { statusCode?: number }).statusCode === 400 ? 400 : 500 });
    return reply.status(apiError.status).send(apiError.body());
  });
  admin.setNotFoundHandler((_request, reply) => reply.status(404).send(new ApiError('not_found').body()));
  admin.addHook('preHandler', async (request) => {
    const token = bearer(request);
    if (!config.adminToken || !token || !safeEqual(token, config.adminToken)) throw new ApiError('not_found');
  });
  const stringField = (body: unknown, name: string): string => {
    const value = (body as Record<string, unknown> | null)?.[name];
    return typeof value === 'string' ? value.trim() : '';
  };

  admin.post('/admin/invites', async (request) => {
    const email = stringField(request.body, 'email').toLowerCase();
    if (!email) throw new ApiError('validation', { fields: ['email'] });
    const user = await stores.directory.findUserByEmail(email);
    const record = (outcome: 'success' | 'failure', detail: Record<string, string>) =>
      stores.audit.append({ at: now(), actor: SYSTEM, target: user ? partyOf(user) : { type: 'client', id: null, label: email.slice(0, 80) }, action: 'system.client.activation_link', outcome, source: request.ip, detail });
    try {
      const invite = await auth.createInvite(email);
      await mailer.send(activationMessage(invite, email, user?.name ?? '', 'client'));
      await record('success', { expires: new Date(invite.expiresAt).toISOString() });
      return { sentTo: maskEmail(email), expiresAt: new Date(invite.expiresAt).toISOString() };
    } catch (error) {
      await record('failure', { reason: reasonOf(error) });
      throw error;
    }
  });

  admin.post('/admin/ops-admins', async (request) => {
    const email = stringField(request.body, 'email').toLowerCase();
    const name = stringField(request.body, 'name');
    if (!isEmail(email)) throw new ApiError('validation', { fields: ['email'] });
    if (!name || name.length > 120 || hasControlCharacters(name)) throw new ApiError('validation', { fields: ['name'] });
    const sent = await bootstrapOpsAdmin(stores, opsAuth, mailer, config, email, name, now(), request.ip);
    if (!sent) {
      await stores.audit.append({ at: now(), actor: SYSTEM, target: { type: 'ops', id: null, label: email.slice(0, 80) }, action: 'ops.bootstrap_admin', outcome: 'failure', source: request.ip, detail: { reason: 'refused' } });
      throw new ApiError('forbidden');
    }
    return { ...sent, expiresAt: new Date(sent.expiresAt).toISOString() };
  });

  /**
   * BREAK-GLASS. For when the console cannot help: two staff who must approve
   * each other, a locked-out or compromised staff member, a lost
   * authenticator. Disables a staff member, resets their authenticator (the
   * new link is emailed to them) or clears their lockout, without a second
   * person. It needs the admin token, this machine, and a typed reason, and it
   * is written to the audit log where it stands out.
   */
  admin.post('/admin/break-glass', async (request) => {
    const action = stringField(request.body, 'action');
    const email = stringField(request.body, 'email').toLowerCase();
    const reason = stringField(request.body, 'reason');
    if (!['disable-staff', 'reset-staff', 'unlock-staff'].includes(action)) throw new ApiError('validation', { fields: ['action'] });
    if (reason.length < 10 || reason.length > 500 || hasControlCharacters(reason)) throw new ApiError('validation', { fields: ['reason'] });
    const user = await stores.ops.users.findByEmail(email);
    const record = (outcome: 'success' | 'failure', detail: Record<string, string>) =>
      stores.audit.append({ at: now(), actor: SYSTEM, target: { type: 'ops', id: user?.id ?? null, label: (user?.email ?? email).slice(0, 80) }, action: `ops.break_glass.${action.replace('-staff', '')}`, outcome, source: request.ip, detail: { reason, ...detail } });
    if (!user) {
      await record('failure', { why: 'not_found' });
      throw new ApiError('not_found');
    }
    if (action === 'unlock-staff') {
      await opsAuth.unlock(user);
      await record('success', {});
      return { done: 'unlocked', staff: maskEmail(user.email) };
    }
    if (action === 'disable-staff') {
      await stores.ops.users.update(user.id, (current) => ({ ...current, disabledAt: current.disabledAt ?? now() }));
      await stores.ops.activations.deleteWhere((item) => item.userId === user.id);
      const sessions = await opsAuth.revokeAllSessions(user.id);
      await record('success', { sessionsEnded: String(sessions) });
      return { done: 'disabled', staff: maskEmail(user.email) };
    }
    if (user.disabledAt !== null) {
      await record('failure', { why: 'disabled' });
      throw new ApiError('validation', { fields: ['email'] });
    }
    const sessions = await opsAuth.clearCredentials(user.id);
    const invite = await opsAuth.createInvite(user.id);
    await mailer.send(activationMessage(invite, user.email, user.name, 'staff'));
    await record('success', { sessionsEnded: String(sessions), sentTo: maskEmail(user.email) });
    return { done: 'reset', staff: maskEmail(user.email), expiresAt: new Date(invite.expiresAt).toISOString() };
  });
  return admin;
}

export async function buildApp(deps: AppDeps) {
  const { config, registry } = deps;
  const now = deps.now ?? Date.now;
  const auth = new AuthService(deps.stores, config, now);
  const opsAuth = new OpsAuthService(deps.stores, config, now);
  const stepUpActions: StepUpAction[] = config.stepUpConversions ? [...BASE_STEP_UP, 'conversion.book'] : BASE_STEP_UP;

  const app = Fastify({
    // The proxies' own addresses (preferred), or a number of hops counted back from the connection: never "trust whatever
    // the client sent". A hop count is only right when the server can be reached ONLY through that many proxies.
    trustProxy: typeof config.trustProxy === 'number' ? ((hops) => (_address: string, hop: number) => hop < hops)(config.trustProxy) : config.trustProxy,
    bodyLimit: 64 * 1024,
    // Method, path (no query string) and status only: no headers, no bodies.
    logger: config.log || deps.logStream ? { level: 'info', serializers: { req: requestLogEntry }, ...(deps.logStream ? { stream: deps.logStream } : {}) } : false,
  });

  if (config.corsOrigins.length > 0) {
    await app.register(cors, {
      origin: config.corsOrigins,
      methods: ['GET', 'POST'],
      allowedHeaders: ['Authorization', 'Content-Type', 'Idempotency-Key', 'X-Step-Up-Token'],
      maxAge: 600,
    });
  }

  app.addHook('onSend', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
    reply.header('X-Content-Type-Options', 'nosniff');
    // Nothing this server sends may be shown inside another site's frame: not the API, not the client web app.
    // (The ops console replaces this policy with its own, stricter one.)
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Content-Security-Policy', WEB_APP_CSP);
    reply.header('Referrer-Policy', 'no-referrer');
  });

  app.setErrorHandler((error, request, reply) => {
    let apiError: ApiError;
    if (error instanceof ApiError) apiError = error;
    else if (isProviderError(error)) {
      if (error.kind === 'unauthorized') request.log.error('provider rejected the server credentials');
      apiError = fromProviderError(error);
    } else {
      const status = (error as { statusCode?: number }).statusCode;
      if (status && status >= 400 && status < 500) apiError = new ApiError('validation', { status });
      else {
        // The message only: never the request.
        request.log.error({ message: error instanceof Error ? error.message : 'unknown error' }, 'request failed');
        apiError = new ApiError('server', { status: 500 });
      }
    }
    if (apiError.options.retryAfterSeconds !== undefined) reply.header('Retry-After', String(apiError.options.retryAfterSeconds));
    return reply.status(apiError.status).send(apiError.body());
  });

  // --- Rate limits ------------------------------------------------------------------
  /**
   * One counter per key per minute. When the table is tracking its maximum
   * number of keys, windows that have run out are dropped; if every key is
   * still inside its minute a NEW key is refused. Nobody's count is ever
   * reset to make room.
   */
  const limiter = (max: number) => {
    const windows = new Map<string, { startedAt: number; count: number }>();
    return (key: string, allowed: number): void => {
      const at = now();
      const entry = windows.get(key);
      if (!entry || at - entry.startedAt >= 60_000) {
        windows.delete(key);
        if (windows.size >= max) {
          for (const [other, window] of windows) if (at - window.startedAt >= 60_000) windows.delete(other);
          if (windows.size >= max) throw new ApiError('rate_limited', { retryAfterSeconds: 60 });
        }
        windows.set(key, { startedAt: at, count: 1 });
        return;
      }
      entry.count += 1;
      if (entry.count > allowed) throw new ApiError('rate_limited', { retryAfterSeconds: Math.ceil((entry.startedAt + 60_000 - at) / 1000) });
    };
  };
  const bySource = limiter(deps.maxRateWindows ?? MAX_RATE_WINDOWS);
  const byNetwork = limiter(deps.maxRateWindows ?? MAX_RATE_WINDOWS);
  const byAccount = limiter(MAX_RATE_WINDOWS);

  /**
   * Unauthenticated and code-checking routes. Counted per source (an IPv4
   * address, or a whole IPv6 /64: one customer owns every address in it) and,
   * with a larger allowance, per IPv4 /24, so hopping between neighbouring
   * addresses does not multiply the allowance for long.
   */
  const limitAttempts = async (request: FastifyRequest): Promise<void> => {
    const source = sourceOf(request.ip);
    const network = networkOf(request.ip);
    if (network !== source) byNetwork(network, config.authRequestsPerNetworkPerMinute);
    bySource(source, config.authRequestsPerMinute);
  };

  /**
   * Every state-changing request of a signed-in client is counted, per person
   * and per session. These are the requests that write audit entries, so one
   * session cannot write them without limit. Sign-out does not come through
   * here and always works.
   */
  const sessionOf = async (request: FastifyRequest): Promise<SessionContext> => {
    const context = await auth.authenticate(bearer(request));
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      byAccount(`user:${context.user.id}`, config.writeRequestsPerMinute);
      byAccount(`session:${context.session.id}`, config.writeRequestsPerMinute);
    }
    return context;
  };

  const companyOf = async (request: FastifyRequest): Promise<CompanyContext> => {
    const context = await sessionOf(request);
    if (!context.company || !context.role) throw new ApiError('forbidden', { reason: 'company_not_selected' });
    return context as CompanyContext;
  };

  /** The adapter for the session's company. This is the only way a route reaches a provider. */
  const providerOf = async (context: CompanyContext): Promise<ProviderAdapter> => {
    try {
      return await registry.forCompany(context.company);
    } catch (error) {
      if (isProviderError(error)) throw error;
      app.log.error({ message: error instanceof Error ? error.message : 'unknown error' }, 'provider adapter unavailable');
      throw new ApiError('server');
    }
  };

  /** Run a provider call; if the provider no longer accepts our session, sign in again next time. */
  const withProvider = async <T>(context: CompanyContext, run: (provider: ProviderAdapter) => Promise<T>): Promise<T> => {
    const provider = await providerOf(context);
    try {
      return await run(provider);
    } catch (error) {
      if (isProviderError(error) && error.kind === 'unauthorized') registry.invalidate(context.company.id);
      throw error;
    }
  };

  const sessionView = async (context: CompanyContext): Promise<Session> => ({
    user: { id: context.user.id, email: context.user.email, displayName: context.user.name },
    company: { id: context.company.id, name: context.company.name },
    role: context.role,
    capabilities: (await providerOf(context)).capabilities,
    stepUpActions,
  });

  /** Role check, then (when this action needs it) spend the step-up permission bound to this exact payload. */
  const authorize = async (request: FastifyRequest, context: CompanyContext, action: StepUpAction, payload: unknown): Promise<void> => {
    if (!MAY[action].includes(context.role)) throw new ApiError('forbidden');
    if (stepUpActions.includes(action)) await auth.consumeStepUp(context, header(request, 'x-step-up-token'), action, payload);
  };

  const pageOf = (request: FastifyRequest) => {
    const query = request.query as Record<string, string | undefined>;
    const page = Number(query.page ?? 1);
    const perPage = Number(query.perPage ?? 25);
    if (!Number.isInteger(page) || page < 1 || !Number.isInteger(perPage) || perPage < 1 || perPage > 100) {
      throw new ApiError('validation', { fields: ['page'] });
    }
    return { page, perPage };
  };

  const idempotencyKeyOf = (request: FastifyRequest): string => {
    const parsed = schemas.idempotencyKey.safeParse(header(request, 'idempotency-key'));
    if (!parsed.success) throw new ApiError('validation', { fields: ['idempotencyKey'] });
    return parsed.data;
  };

  /** Quotes this server handed out, per company, so a booking can only use a quote that company was really given. PLACEHOLDER: in memory. */
  const quotes = new Map<string, Quote>();
  const rememberQuote = (companyId: string, quote: Quote): void => {
    for (const [key, held] of quotes) if (Date.parse(held.expiresAt) < now() - 60_000) quotes.delete(key);
    while (quotes.size >= (deps.maxHeldQuotes ?? MAX_HELD_QUOTES)) quotes.delete(quotes.keys().next().value as string);
    quotes.set(`${companyId}:${quote.id}`, quote);
  };

  await app.register(
    async (api) => {
      const text = (max: number) => z.string().min(1).max(max);
      const field = <T>(body: unknown, name: string, schema: z.ZodType<T>): T => {
        try {
          return parse(schema, (body as Record<string, unknown> | null)?.[name]);
        } catch {
          throw new ApiError('validation', { fields: [name] });
        }
      };

      // --- Activation ---------------------------------------------------------
      api.post('/activation/start', { preHandler: limitAttempts }, async (request) => auth.activationStart(field(request.body, 'activationCode', text(64))));
      api.post('/activation/password', { preHandler: limitAttempts }, async (request) =>
        auth.activationPassword(field(request.body, 'activationCode', text(64)), field(request.body, 'password', text(1000))),
      );
      api.post('/activation/confirm', { preHandler: limitAttempts }, async (request) =>
        auth.activationConfirm(field(request.body, 'activationCode', text(64)), field(request.body, 'code', text(16)), request.ip),
      );

      // --- Sign-in ------------------------------------------------------------
      api.post('/auth/login', { preHandler: limitAttempts }, async (request) =>
        auth.login(field(request.body, 'email', text(254)), field(request.body, 'password', text(1000)), request.ip),
      );
      api.post('/auth/login/verify', { preHandler: limitAttempts }, async (request) => {
        const method = (request.body as { method?: unknown } | null)?.method === 'recovery' ? 'recovery' : 'totp';
        const signedIn = await auth.verifyLogin(field(request.body, 'challengeId', text(128)), field(request.body, 'code', text(32)), method, request.ip);
        const { context } = signedIn;
        return {
          token: signedIn.token,
          user: signedIn.user,
          companies: signedIn.companies,
          session: context.company && context.role ? await sessionView(context as CompanyContext) : null,
        };
      });
      api.post('/auth/logout', async (request) => {
        await auth.logout(bearer(request), request.ip);
        return { ok: true };
      });
      api.post('/session/company', async (request) => {
        const context = await auth.selectCompany(await sessionOf(request), field(request.body, 'companyId', text(64)), request.ip);
        return sessionView(context as CompanyContext);
      });

      // --- Step-up ------------------------------------------------------------
      api.post('/step-up', { preHandler: limitAttempts }, async (request) => {
        const context = await companyOf(request);
        const body = request.body as { payload?: unknown } | null;
        const action = field<StepUpAction>(body, 'action', schemas.stepUpAction);
        if (!MAY[action].includes(context.role)) throw new ApiError('forbidden');
        return auth.grantStepUp(context, action, body?.payload ?? null, field(body, 'code', text(16)), request.ip);
      });

      // --- Account data, always for the session's company ---------------------
      api.get('/company', async (request) => {
        const context = await companyOf(request);
        const profile = await withProvider(context, (provider) => provider.getCompanyProfile());
        // Our own id and name: the provider's account id stays on the server.
        return { ...profile, id: context.company.id, companyName: context.company.name };
      });
      api.get('/balances', async (request) => {
        const context = await companyOf(request);
        return { items: await withProvider(context, (provider) => provider.listBalances()), truncated: false };
      });
      api.get('/account-details/:currency', async (request) => {
        const context = await companyOf(request);
        const { currency } = request.params as { currency: string };
        if (!/^[A-Za-z]{3}$/.test(currency)) throw new ApiError('validation', { fields: ['currency'] });
        return withProvider(context, (provider) => provider.getAccountDetails(currency.toUpperCase()));
      });
      api.get('/transactions', async (request) => {
        const context = await companyOf(request);
        return withProvider(context, (provider) => provider.listTransactions(pageOf(request)));
      });

      const pairOf = (request: FastifyRequest) => {
        const { base, quote } = request.params as { base: string; quote: string };
        if (!/^[A-Za-z]{3}$/.test(base) || !/^[A-Za-z]{3}$/.test(quote)) throw new ApiError('validation', { fields: ['currency'] });
        return [base.toUpperCase(), quote.toUpperCase()] as const;
      };
      api.get('/rates/:base/:quote', async (request) => {
        const context = await companyOf(request);
        const [base, quote] = pairOf(request);
        return withProvider(context, (provider) => provider.getRate(base, quote));
      });
      api.get('/rates/:base/:quote/history', async (request) => {
        const context = await companyOf(request);
        const [base, quote] = pairOf(request);
        return withProvider(context, (provider) => provider.getRateHistory(base, quote));
      });

      /**
       * Runs a money action and writes it to the audit log, success or failure:
       * who, for which company, what (amount, currency, payee id) and a hash of
       * the idempotency key. Never a token or a code.
       */
      const audited = async <T>(request: FastifyRequest, context: CompanyContext, action: StepUpAction, detail: Record<string, string>, run: () => Promise<T>, after: (result: T) => Record<string, string> = () => ({})): Promise<T> => {
        const target = { type: 'company' as const, id: context.company.id, label: context.company.name };
        try {
          const result = await run();
          await auth.record(`client.${action}`, 'success', partyOf(context.user), request.ip, { ...detail, ...after(result) }, target);
          return result;
        } catch (error) {
          const reason = error instanceof ApiError ? reasonOf(error) : isProviderError(error) ? (error.reason ?? error.kind) : 'error';
          await auth.record(`client.${action}`, 'failure', partyOf(context.user), request.ip, { ...detail, reason }, target);
          throw error;
        }
      };
      const keyHash = (idempotencyKey: string): string => sha256(idempotencyKey).slice(0, 16);

      // --- Conversions --------------------------------------------------------
      api.post('/quotes', async (request) => {
        const context = await companyOf(request);
        if (!MAY['conversion.book'].includes(context.role)) throw new ApiError('forbidden');
        const input = parse(schemas.quoteRequest, request.body);
        assertAmount(input.amount, input.fixedSide === 'sell' ? input.sellCurrency : input.buyCurrency);
        const provider = await providerOf(context);
        if (input.kind === 'forward' && !provider.capabilities.forwardContracts) {
          throw new ApiError('validation', { reason: 'not_supported', fields: ['kind'] });
        }
        const quote = await withProvider(context, () => provider.createQuote(input));
        rememberQuote(context.company.id, quote);
        return quote;
      });
      api.post('/conversions', async (request) => {
        const context = await companyOf(request);
        const idempotencyKey = idempotencyKeyOf(request);
        const quoteId = field(request.body, 'quoteId', text(120));
        return audited(
          request,
          context,
          'conversion.book',
          { quote: quoteId, key: keyHash(idempotencyKey) },
          async () => {
            await authorize(request, context, 'conversion.book', { quoteId, idempotencyKey });
            // Only a quote this server issued to THIS company can be booked: the id alone is not trusted.
            const quote = quotes.get(`${context.company.id}:${quoteId}`);
            if (!quote) throw new ApiError('quote_expired');
            return withProvider(context, (provider) => provider.bookConversion({ quote, idempotencyKey }));
          },
          (conversion) => ({ conversion: conversion.id, sell: `${conversion.sellAmount} ${conversion.sellCurrency}`, buy: `${conversion.buyAmount} ${conversion.buyCurrency}` }),
        );
      });
      api.get('/conversions/by-key/:key', async (request) => {
        const context = await companyOf(request);
        const key = parse(schemas.idempotencyKey, (request.params as { key: string }).key);
        return withProvider(context, (provider) => provider.findConversionByIdempotencyKey(key));
      });
      api.get('/forwards', async (request) => {
        const context = await companyOf(request);
        const provider = await providerOf(context);
        const items = provider.capabilities.forwardContracts ? await withProvider(context, () => provider.listForwardContracts()) : [];
        return { items, truncated: false };
      });

      // --- Payees and payments ------------------------------------------------
      /**
       * An id from the request is acted on only after it has been found among
       * THIS company's own records, read through this company's scope. The
       * server does not rely on the provider refusing somebody else's id.
       */
      const assertOwnPayee = async (context: CompanyContext, beneficiaryId: string): Promise<void> => {
        const own = await withProvider(context, (provider) => provider.listBeneficiaries());
        if (!own.items.some((payee) => payee.id === beneficiaryId)) throw new ApiError('validation', { fields: ['beneficiaryId'] });
      };
      const assertOwnPendingPayment = async (context: CompanyContext, paymentId: string): Promise<void> => {
        const own = await withProvider(context, (provider) => provider.listPendingApprovals());
        if (!own.some((item) => item.payment.id === paymentId)) throw new ApiError('not_found');
      };
      api.get('/beneficiaries', async (request) => {
        const context = await companyOf(request);
        return withProvider(context, (provider) => provider.listBeneficiaries());
      });
      api.post('/beneficiaries', async (request) => {
        const context = await companyOf(request);
        const input: NewBeneficiary = parse(schemas.newBeneficiary, request.body);
        return audited(
          request,
          context,
          'beneficiary.create',
          { currency: input.currency, country: input.bankCountry },
          async () => {
            // Bound to the body exactly as it was sent.
            await authorize(request, context, 'beneficiary.create', request.body);
            return withProvider(context, (provider) => provider.createBeneficiary(input));
          },
          (payee) => ({ payee: payee.id }),
        );
      });
      api.get('/payments', async (request) => {
        const context = await companyOf(request);
        return withProvider(context, (provider) => provider.listPayments(pageOf(request)));
      });
      api.post('/payments', async (request) => {
        const context = await companyOf(request);
        const idempotencyKey = idempotencyKeyOf(request);
        const input = parse(schemas.newPaymentBody, request.body);
        return audited(
          request,
          context,
          'payment.create',
          { amount: String(input.amount).slice(0, 40), currency: input.currency, payee: input.beneficiaryId, key: keyHash(idempotencyKey) },
          async () => {
            assertAmount(input.amount, input.currency);
            await authorize(request, context, 'payment.create', { ...(request.body as object), idempotencyKey });
            await assertOwnPayee(context, input.beneficiaryId);
            return withProvider(context, (provider) => provider.createPayment({ ...input, idempotencyKey }));
          },
          (payment) => ({ payment: payment.id, status: payment.status }),
        );
      });
      api.get('/payments/by-key/:key', async (request) => {
        const context = await companyOf(request);
        const key = parse(schemas.idempotencyKey, (request.params as { key: string }).key);
        return withProvider(context, (provider) => provider.findPaymentByIdempotencyKey(key));
      });
      api.get('/approvals', async (request) => {
        const context = await companyOf(request);
        const provider = await providerOf(context);
        const items = provider.capabilities.paymentApprovals ? await withProvider(context, () => provider.listPendingApprovals()) : [];
        return { items, truncated: false };
      });
      const decide = (action: 'payment.approve' | 'payment.reject') => async (request: FastifyRequest) => {
        const context = await companyOf(request);
        const paymentId = parse(z.string().min(1).max(120), (request.params as { id: string }).id);
        const provider = await providerOf(context);
        if (!provider.capabilities.paymentApprovals) throw new ApiError('validation', { reason: 'not_supported' });
        return audited(request, context, action, { payment: paymentId }, async () => {
          await authorize(request, context, action, { paymentId });
          await assertOwnPendingPayment(context, paymentId);
          if (action === 'payment.approve') return withProvider(context, () => provider.approvePayment(paymentId));
          await withProvider(context, () => provider.rejectPayment(paymentId));
          return { ok: true };
        });
      };
      api.post('/payments/:id/approve', decide('payment.approve'));
      api.post('/payments/:id/reject', decide('payment.reject'));
    },
    { prefix: '/v1' },
  );

  const opsRoutes = await registerOps(app, { config, stores: deps.stores, auth, opsAuth, registry, mailer: deps.mailer, now, limitAttempts });
  // Null when no ADMIN_TOKEN is set: the operator commands are then off.
  const admin = config.adminToken ? await buildAdminApp({ config, stores: deps.stores, auth, opsAuth, mailer: deps.mailer, now }) : null;

  app.get('/healthz', async () => ({ ok: true }));

  // --- Demo: serve the exported web app from the same origin ----------------------
  if (config.webDir) {
    await app.register(fastifyStatic, { root: path.resolve(config.webDir), wildcard: false });
    app.setNotFoundHandler((request, reply) => {
      const isPage = request.method === 'GET' && !request.url.startsWith('/v1/') && !request.url.startsWith('/admin/') && !request.url.startsWith('/ops');
      // The web app is a single page: every other path is one of its routes.
      if (isPage) return reply.header('Cache-Control', 'no-store').sendFile('index.html');
      return reply.status(404).send(new ApiError('not_found').body());
    });
  } else {
    app.setNotFoundHandler((_request, reply) => reply.status(404).send(new ApiError('not_found').body()));
  }

  // Returned as a pair: a Fastify instance is itself awaitable, so it must not be the async result.
  return { app, admin, auth, opsAuth, opsRoutes };
}
