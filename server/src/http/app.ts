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
import type { Conversion, NewBeneficiary, Session, StepUpAction, UserRole } from '@/api/types';

import { AuthService, partyOf, reasonOf, type SessionContext } from '../auth/service';
import type { Config } from '../config';
import { safeEqual, sha256 } from '../crypto';
import { ApiError } from '../errors';
import { ConsoleOutbox, maskEmail, type Mailer } from '../mailer';
import { MailQueue, mailedDetail } from '../mail/queue';
import { activationMail } from '../mail/templates';
import { SecurityNotices } from '../notify/security';
import { AuthenticatorResets } from '../auth/authenticatorResets';
import { assertAmount } from '../money';
import { networkOf, sourceOf } from '../net';
import { emailDomain, hasControlCharacters, isEmail } from '../validate';
import { isActiveStaff, OpsAuthService } from '../ops/auth';
import { registerOps } from '../ops/console';
import { registerDemoGate } from './demoGate';
import { RateAlerts } from '../alerts/service';
import { noteOf, Notifier } from '../notify/notifier';
import { PaymentNotifications } from '../notify/payments';
import { MarginError } from '../rates/margin';
import { ClientRates } from '../rates/service';
import { HeldPayments, type HeldPaymentsDeps } from '../payments/held';
import type { ProviderAdapter, ProviderRegistry } from '../providers/adapter';
import type { CompanyRecord, RevenueRecord, Stores } from '../store/types';

export interface AppDeps {
  /** How the outbox is emptied (see MailQueue). Defaults by the kind of mailer. */
  mailDelivery?: 'inline' | 'background';
  /** TESTS ONLY: stands in for the demo gate's waiting. */
  gateDelay?: (ms: number) => Promise<void>;
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
  /** TESTS ONLY: see HeldPaymentsDeps.beforeSend. */
  beforeSend?: HeldPaymentsDeps['beforeSend'];
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

const BASE_STEP_UP: StepUpAction[] = ['payment.create', 'payment.approve', 'payment.reject', 'payment.cancel', 'beneficiary.create'];
const MAY: Record<StepUpAction, UserRole[]> = {
  'payment.create': ['creator', 'admin'],
  'beneficiary.create': ['creator', 'admin'],
  'conversion.book': ['creator', 'admin'],
  'payment.approve': ['approver', 'admin'],
  'payment.reject': ['approver', 'admin'],
  // Its creator, or an administrator of the company (checked against the payment itself).
  'payment.cancel': ['creator', 'admin'],
};

/**
 * A provider's own parameter names never reach a client. Field names in an error are the NEUTRAL API's names: a
 * provider's name is translated where it has an equivalent and dropped where it has none.
 */
const PROVIDER_FIELDS: Record<string, string> = {
  client_sell_amount: 'amount',
  client_buy_amount: 'amount',
  quote_id: 'quoteId',
  buy_currency: 'buyCurrency',
  sell_currency: 'sellCurrency',
  fixed_side: 'fixedSide',
  conversion_date: 'settlementDate',
  unique_request_id: 'idempotencyKey',
  beneficiary_id: 'beneficiaryId',
  bank_account_holder_name: 'name',
  account_number: 'accountNumber',
  routing_code_value_1: 'sortCode',
  bank_country: 'bankCountry',
  clientAmounts: 'amount',
  quoteRequestId: 'quoteId',
  orderId: 'quoteId',
  sourceCurrency: 'sellCurrency',
  targetCurrency: 'buyCurrency',
  accountIdentifier: 'accountNumber',
  currencyCode: 'currency',
};
const NEUTRAL_FIELDS = new Set(['amount', 'quoteId', 'buyCurrency', 'sellCurrency', 'fixedSide', 'settlementDate', 'idempotencyKey', 'beneficiaryId', 'name', 'accountNumber', 'sortCode', 'bankCountry', 'currency', 'iban', 'bic', 'reference', 'reason', 'kind', 'entityType', 'routingNumber', 'email', 'password', 'code', 'targetRate', 'side', 'page']);
export const neutralFields = (fields: readonly string[]): string[] => [...new Set(fields.map((field) => PROVIDER_FIELDS[field] ?? field).filter((field) => NEUTRAL_FIELDS.has(field)))];

/** Parse with a schema from the shared file; a failure becomes a neutral `validation` error naming the fields. */
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  throw new ApiError('validation', { fields: [...new Set(result.error.issues.map((issue) => String(issue.path[0] ?? '')).filter(Boolean))] });
}

/** What a provider failure looks like to the app. A provider refusing OUR credentials is our fault, not the customer's session. */
function fromProviderError(error: ProviderError): ApiError {
  const kind = error.kind === 'unauthorized' || error.kind === 'forbidden' || error.kind === 'rate_limited' ? 'server' : error.kind;
  return new ApiError(kind, { reason: error.reason, fields: neutralFields(error.fields) });
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
export async function bootstrapOpsAdmin(stores: Stores, opsAuth: OpsAuthService, mail: MailQueue, config: Pick<Config, 'staffEmailDomains'>, email: string, name: string, at: number, source: string) {
  if (!config.staffEmailDomains.includes(emailDomain(email))) return null;
  const staff = await stores.ops.users.list();
  if (staff.filter((user) => user.role === 'ops_admin' && isActiveStaff(user)).length >= 2) return null;
  const existing = await stores.ops.users.findByEmail(email);
  if (existing && (existing.role !== 'ops_admin' || existing.disabledAt !== null || existing.activatedAt !== null)) return null;
  const user = existing ?? (await opsAuth.createUser(email, name, 'ops_admin'));
  const invite = await opsAuth.createInvite(user.id);
  const delivery = await mail.enqueue(activationMail(invite, user.email, user.name, 'staff'));
  await stores.audit.append({ at, actor: SYSTEM, target: { type: 'ops', id: user.id, label: user.email }, action: existing ? 'ops.bootstrap_admin' : 'ops.staff.new', outcome: 'success', source, detail: { role: 'ops_admin', how: 'operator command (bootstrap)', email: delivery.state } });
  return { ...mailedDetail(maskEmail(user.email), delivery), expiresAt: invite.expiresAt };
}

/**
 * The operator commands (`npm run invite`, `npm run create-ops-admin`). This
 * is a SEPARATE server that index.ts binds to the loopback address only; the
 * public listener has no /admin route at all. Still guarded by ADMIN_TOKEN.
 */
export async function buildAdminApp(deps: { config: Config; stores: Stores; auth: AuthService; opsAuth: OpsAuthService; mail: MailQueue; now: () => number }) {
  const { config, stores, auth, opsAuth, mail, now } = deps;
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
      const delivery = await mail.enqueue(activationMail(invite, email, user?.name ?? '', 'client'));
      // The answer and the audit entry say what became of the email, not that it was "sent" when it was not.
      await record(delivery.state === 'failed' ? 'failure' : 'success', { expires: new Date(invite.expiresAt).toISOString(), email: delivery.state });
      return { ...mailedDetail(maskEmail(email), delivery), expiresAt: new Date(invite.expiresAt).toISOString() };
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
    const sent = await bootstrapOpsAdmin(stores, opsAuth, mail, config, email, name, now(), request.ip);
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
      await stores.ops.activations.deleteWhere({ userId: user.id });
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
    const delivery = await mail.enqueue(activationMail(invite, user.email, user.name, 'staff'));
    await record(delivery.state === 'failed' ? 'failure' : 'success', { sessionsEnded: String(sessions), ...mailedDetail(maskEmail(user.email), delivery) });
    return { done: 'reset', staff: maskEmail(user.email), email: delivery.state, expiresAt: new Date(invite.expiresAt).toISOString() };
  });
  return admin;
}

export async function buildApp(deps: AppDeps) {
  const { config, registry } = deps;
  const now = deps.now ?? Date.now;
  const auth = new AuthService(deps.stores, config, now);
  const opsAuth = new OpsAuthService(deps.stores, config, now);
  // Every email goes through the outbox (mail/queue.ts). The development console outbox is instant and in this
  // process, so it is emptied inline; a real mail server is never waited for by a request.
  const mailFrom = config.smtp?.from ?? '';
  const mail = new MailQueue({
    table: deps.stores.mail,
    audit: deps.stores.audit,
    transport: deps.mailer,
    now,
    links: [config.appUrl, config.opsUrl],
    domain: mailFrom.includes('@') ? (mailFrom.split('@').pop() as string).replace(/[^A-Za-z0-9.-]/g, '') : 'globalconnect.invalid',
    perRecipientPerHour: config.mailPerRecipientPerHour,
    globalPerHour: config.mailGlobalPerHour,
    delivery: deps.mailDelivery ?? (deps.mailer instanceof ConsoleOutbox ? 'inline' : 'background'),
    onError: (message) => app.log.error({ message }, 'mail queue failed'),
  });
  const notices = new SecurityNotices(mail, now, (message) => app.log.error({ message }, 'security notice failed'));
  auth.attach(mail, notices);
  const rates = new ClientRates(deps.stores, config, now, deps.maxHeldQuotes ?? MAX_HELD_QUOTES);
  opsAuth.attach(mail, notices);
  const authenticatorResets = new AuthenticatorResets(deps.stores, auth, mail, notices, config.authenticatorResetDelayMs, now);
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
    // Served over https (a deployed demo, or the real thing): browsers are told never to try plain http here again.
    if (config.appUrl.startsWith('https://')) reply.header('Strict-Transport-Security', 'max-age=31536000');
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
  // The demo gate (when DEMO_ACCESS_PASSWORD is set) stands in front of every route registered after this line.
  const byGate = limiter(MAX_RATE_WINDOWS);
  await registerDemoGate(app, { config, now, limitAttempts, limit: (address, allowed) => byGate(sourceOf(address), allowed), delay: deps.gateDelay });

  const sessionOf = async (request: FastifyRequest): Promise<SessionContext> => {
    const context = await auth.authenticate(bearer(request));
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      byAccount(`user:${context.user.id}`, config.writeRequestsPerMinute);
      byAccount(`session:${context.session.id}`, config.writeRequestsPerMinute);
    } else {
      byAccount(`read:${context.session.id}`, config.readRequestsPerMinute);
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

  /** Payments held for approval. It reaches a provider only through the company's own adapter. */
  const held = new HeldPayments({
    stores: deps.stores,
    config,
    now,
    beforeSend: deps.beforeSend,
    withProvider: async (company, run) => {
      try {
        return await run(await registry.forCompany(company));
      } catch (error) {
        if (isProviderError(error) && error.kind === 'unauthorized') registry.invalidate(company.id);
        throw error;
      }
    },
  });

  /** Notifications (in-app list and email), who is told what about held payments, and rate alerts. */
  const notifier = new Notifier(deps.stores, mail, { now, perUserPerHour: config.notificationsPerUserPerHour, push: null, onError: (message) => app.log.error({ message }, 'notification failed') });
  // A client's security notice is shown in the app as well as emailed.
  notices.attachInApp((person, kind, data, key) => notifier.security(person, kind, data, key));
  const paymentNotes = new PaymentNotifications(deps.stores, notifier, { now, expiryWarningMs: config.paymentExpiryWarningMs, onError: (message) => app.log.error({ message }, 'payment notifications failed') });
  const alerts = new RateAlerts({
    stores: deps.stores,
    rates,
    notifier,
    now,
    perUser: config.alertsPerUser,
    onError: (message) => app.log.error({ message }, 'rate alert check failed'),
    withProvider: async (company, run) => {
      try {
        return await run(await registry.forCompany(company));
      } catch (error) {
        if (isProviderError(error) && error.kind === 'unauthorized') registry.invalidate(company.id);
        throw error;
      }
    },
  });

  const sessionView = async (context: CompanyContext): Promise<Session> => ({
    user: { id: context.user.id, email: context.user.email, displayName: context.user.name },
    company: { id: context.company.id, name: context.company.name },
    role: context.role,
    // Approvals are available wherever this server holds the company's payments, whatever its provider can do.
    capabilities: { ...(await providerOf(context)).capabilities, paymentApprovals: (await providerOf(context)).capabilities.paymentApprovals || held.holds(context.company) },
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

  /** A margin problem is the server's, not the client's: they are told the conversion is unavailable, never why. */
  const priced = async <T>(run: () => Promise<T>): Promise<T> => {
    try {
      return await run();
    } catch (error) {
      if (!(error instanceof MarginError)) throw error;
      if (/too small/.test(error.message)) throw new ApiError('validation', { fields: ['amount'] });
      app.log.error({ err: error.message }, 'client rate could not be worked out');
      throw new ApiError('server');
    }
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
        const signedIn = await auth.verifyLogin(field(request.body, 'challengeId', text(128)), field(request.body, 'code', text(32)), method, request.ip, String(request.headers['user-agent'] ?? ''));
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
      // --- Forgotten password: the emailed link AND a second factor (see AuthService) ---
      api.post('/auth/password-reset/request', { preHandler: limitAttempts }, async (request) => {
        // The same answer whoever the address belongs to, or nobody.
        await auth.requestPasswordReset(field(request.body, 'email', text(254)), request.ip);
        return { ok: true };
      });
      api.post('/auth/password-reset/start', { preHandler: limitAttempts }, async (request) => auth.passwordResetStart(field(request.body, 'resetCode', text(64))));
      api.post('/auth/password-reset/complete', { preHandler: limitAttempts }, async (request) => {
        const method = (request.body as { method?: unknown } | null)?.method === 'recovery' ? 'recovery' : 'totp';
        await auth.passwordResetComplete(field(request.body, 'resetCode', text(64)), field(request.body, 'code', text(32)), method, field(request.body, 'password', text(1000)), request.ip);
        return { ok: true };
      });

      // --- Your own security settings (signed in; no company needed) -----------
      api.post('/account/password', { preHandler: limitAttempts }, async (request) => {
        await auth.changePassword(await sessionOf(request), field(request.body, 'currentPassword', text(1000)), field(request.body, 'code', text(16)), field(request.body, 'newPassword', text(1000)), request.ip);
        return { ok: true };
      });
      api.post('/account/recovery-codes', { preHandler: limitAttempts }, async (request) => auth.regenerateRecoveryCodes(await sessionOf(request), field(request.body, 'code', text(16)), request.ip));
      api.get('/account/sessions', async (request) => ({ items: await auth.listSessions(await sessionOf(request)) }));
      api.post('/account/sessions/:id/revoke', async (request) => {
        const { id } = request.params as { id: string };
        if (!/^[0-9a-f]{24}$/.test(id)) throw new ApiError('not_found');
        await auth.revokeOwnSession(await sessionOf(request), id, request.ip);
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
        // THE CLIENT'S RATE (rates/service.ts). The provider's rate never leaves the server.
        return priced(() => withProvider(context, (provider) => rates.indicative(context.company, provider, base, quote)));
      });
      api.get('/rates/:base/:quote/history', async (request) => {
        const context = await companyOf(request);
        const [base, quote] = pairOf(request);
        return priced(async () => rates.history(context.company, await withProvider(context, (provider) => provider.getRateHistory(base, quote))));
      });

      /**
       * Runs a money action and writes it to the audit log, success or failure:
       * who, for which company, what (amount, currency, payee id) and a hash of
       * the idempotency key. Never a token or a code.
       */
      const audited = async <T>(request: FastifyRequest, context: CompanyContext, action: StepUpAction, detail: Record<string, string>, run: () => Promise<T>, after: (result: T) => Record<string, string> | null = () => ({})): Promise<T> => {
        const target = { type: 'company' as const, id: context.company.id, label: context.company.name };
        try {
          const result = await run();
          // null: the success was already recorded, in the same transaction as the change itself (held payments).
          const more = after(result);
          if (more !== null) await auth.record(`client.${action}`, 'success', partyOf(context.user), request.ip, { ...detail, ...more }, target);
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
        // Kept in the database for THIS person until it runs out. Only the client's side is returned; the provider's stays here.
        const held = await priced(async () => rates.quote(context.company, context.user.id, provider, await withProvider(context, () => provider.createQuote(input))));
        return held.client;
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
            const hash = keyHash(idempotencyKey);
            const notify = async (record: RevenueRecord | null, conversion: Conversion, changed: boolean): Promise<void> => {
              if (!changed || !record?.mismatch) return;
              // Booked, but NOT on the terms the client was quoted: logged, audited (by the record), and the person is told.
              app.log.error({ conversion: conversion.id }, 'the provider booked a conversion without the client terms it was sent');
              await notifier.notify(noteOf({ userId: record.userId, companyId: record.companyId, category: 'payments', kind: 'conversion_differs', note: { sellCurrency: record.sellCurrency, buyCurrency: record.buyCurrency, quotedSell: record.clientSellAmount, quotedBuy: record.clientBuyAmount, bookedSell: conversion.sellAmount, bookedBuy: conversion.buyAmount }, dedupe: `conversion:${conversion.id}:differs` }));
            };
            // ONE KEY IS ONE BOOKING OF ONE QUOTE. A key that was used before answers from what it did then:
            const earlier = await rates.recordFor(context.company.id, hash);
            if (earlier && earlier.quoteId !== quoteId) throw new ApiError('validation', { fields: ['idempotencyKey'] });
            if (earlier && earlier.status !== 'failed') {
              // ...the conversion it made, looked up by its key (never booked a second time)...
              const made = await withProvider(context, (provider) => provider.findConversionByIdempotencyKey(idempotencyKey));
              if (made) {
                const closed = await rates.completeBooking(earlier.key, made);
                await notify(closed.record, made, closed.changed);
                return rates.present(made, closed.record ?? earlier);
              }
              // ...or, if the provider has no conversion under it yet, the same request again below (the provider books a key once).
            }
            // THE QUOTE, checked HERE and not left to the provider: issued by this server to this person in this
            // company, not run out, not used by another booking, and priced by the margin that is still in force.
            const held = await rates.claimQuote(context.company, context.user.id, quoteId, hash);
            if (!held) throw new ApiError('quote_expired');
            // On record BEFORE the provider is asked, so a booking whose answer is lost is not lost to the books.
            const record = await rates.beginBooking(held, context.user.id, hash);
            if (!record) throw new ApiError('validation', { fields: ['idempotencyKey'] });
            const clientTerms = record.appliedBy === 'server' ? { sellAmount: record.clientSellAmount, buyAmount: record.clientBuyAmount } : undefined;
            try {
              const conversion = await withProvider(context, (provider) => provider.bookConversion({ quote: held.provider, idempotencyKey, clientTerms }));
              const booked = await rates.completeBooking(record.key, conversion);
              await notify(booked.record, conversion, booked.changed);
              return rates.present(conversion, booked.record ?? record);
            } catch (error) {
              // Only a definite refusal means nothing was booked. Anything else (no answer, a server error) leaves the record open.
              if (isProviderError(error) && ['validation', 'quote_expired', 'insufficient_funds', 'forbidden', 'not_found'].includes(error.kind)) await rates.failBooking(record.key);
              throw error;
            }
          },
          (conversion) => ({ conversion: conversion.id, sell: `${conversion.sellAmount} ${conversion.sellCurrency}`, buy: `${conversion.buyAmount} ${conversion.buyCurrency}` }),
        );
      });
      api.get('/conversions/by-key/:key', async (request) => {
        const context = await companyOf(request);
        const key = parse(schemas.idempotencyKey, (request.params as { key: string }).key);
        const conversion = await withProvider(context, (provider) => provider.findConversionByIdempotencyKey(key));
        if (!conversion) return conversion;
        // Found at the provider: if this server's record of it was left open (the answer was lost), it is closed now.
        const closed = await rates.completeBooking(`${context.company.id}:${keyHash(key)}`, conversion);
        if (closed.changed && closed.record?.mismatch) {
          app.log.error({ conversion: conversion.id }, 'the provider booked a conversion without the client terms it was sent');
          await notifier.notify(noteOf({ userId: closed.record.userId, companyId: closed.record.companyId, category: 'payments', kind: 'conversion_differs', note: { sellCurrency: closed.record.sellCurrency, buyCurrency: closed.record.buyCurrency, quotedSell: closed.record.clientSellAmount, quotedBuy: closed.record.clientBuyAmount, bookedSell: conversion.sellAmount, bookedBuy: conversion.buyAmount }, dedupe: `conversion:${conversion.id}:differs` }));
        }
        return rates.present(conversion, closed.record ?? (await rates.recordFor(context.company.id, keyHash(key))));
      });
      api.get('/forwards', async (request) => {
        const context = await companyOf(request);
        const provider = await providerOf(context);
        const items = provider.capabilities.forwardContracts ? await withProvider(context, () => provider.listForwardContracts()) : [];
        return { items: await Promise.all(items.map((item) => rates.presentById(context.company.id, item))), truncated: false };
      });

      // --- Rate alerts --------------------------------------------------------------
      // A person's own alerts in the company they are working in. Checked by the server against the company's
      // CLIENT rate (alerts/service.ts).
      const alertId = (request: FastifyRequest): string => parse(z.string().regex(/^alr_[\w-]{1,40}$/), (request.params as { id: string }).id);
      api.get('/alerts', async (request) => {
        const context = await companyOf(request);
        return { items: await alerts.list(context.user, context.company) };
      });
      api.post('/alerts', async (request) => {
        const context = await companyOf(request);
        const input = parse(z.object({ base: z.string().length(3), quote: z.string().length(3), side: z.enum(['sell', 'buy']), targetRate: z.string().max(20) }).strict(), request.body);
        return priced(() => alerts.create(context.user, context.company, input, request.ip));
      });
      api.post('/alerts/:id', async (request) => {
        const context = await companyOf(request);
        const { enabled } = parse(z.object({ enabled: z.boolean() }).strict(), request.body);
        return alerts.setEnabled(context.user, context.company, alertId(request), enabled, request.ip);
      });
      api.post('/alerts/:id/delete', async (request) => {
        const context = await companyOf(request);
        await alerts.remove(context.user, context.company, alertId(request), request.ip);
        return { ok: true };
      });

      // --- Notifications --------------------------------------------------------------
      // A person's OWN list, whichever company they are working in. Security notices are not here and cannot be turned off.
      const prefsView = async (userId: string) => ({ email: await notifier.prefsOf(userId), alwaysOn: ['security'] });
      api.get('/notifications', async (request) => notifier.list((await sessionOf(request)).user.id));
      api.post('/notifications/read', async (request) => {
        const context = await sessionOf(request);
        const { id } = parse(z.object({ id: z.string().regex(/^ntf_[\w-]{1,40}$/).optional() }).strict(), request.body ?? {});
        await notifier.markRead(context.user.id, id ?? null);
        return { ok: true, unread: (await notifier.list(context.user.id, 1)).unread };
      });
      api.get('/notifications/preferences', async (request) => prefsView((await sessionOf(request)).user.id));
      api.post('/notifications/preferences', async (request) => {
        const context = await sessionOf(request);
        const { email } = parse(z.object({ email: z.object({ rates: z.boolean(), approvals: z.boolean(), payments: z.boolean() }).strict() }).strict(), request.body);
        const at = now();
        await deps.stores.notificationPrefs.mutate(
          context.user.id,
          () => ({ userId: context.user.id, email, updatedAt: at }),
          () => ({ at, actor: partyOf(context.user), target: partyOf(context.user), action: 'client.notification_preferences', outcome: 'success', source: request.ip, detail: { rates: email.rates ? 'on' : 'off', approvals: email.approvals ? 'on' : 'off', payments: email.payments ? 'on' : 'off' } }),
        );
        return prefsView(context.user.id);
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
        const page = pageOf(request);
        const sent = await withProvider(context, (provider) => provider.listPayments(page));
        // Payments this server is holding (or closed without sending) are not in the provider's list: they lead the first page.
        return page.page === 1 ? { ...sent, items: [...(await held.listPayments(context)), ...sent.items] } : sent;
      });
      /** After a payment action: whoever is now due a notification about this company's held payments gets it. Never fails the action. */
      const thenNotify = async <T>(context: CompanyContext, action: Promise<T>): Promise<T> => {
        try {
          return await action;
        } finally {
          // Also when the action was refused: a refusal can itself close a payment (its payee changed, it expired).
          await paymentNotes.scan(context.company.id);
        }
      };
      api.post('/payments', async (request) => {
        const context = await companyOf(request);
        const idempotencyKey = idempotencyKeyOf(request);
        const input = parse(schemas.newPaymentBody, request.body);
        return thenNotify(context, audited(
          request,
          context,
          'payment.create',
          { amount: String(input.amount).slice(0, 40), currency: input.currency, payee: input.beneficiaryId, key: keyHash(idempotencyKey) },
          async () => {
            assertAmount(input.amount, input.currency);
            await authorize(request, context, 'payment.create', { ...(request.body as object), idempotencyKey });
            // A key that already made a held payment here is answered from that payment, whatever the company's rule is
            // now: it is never sent a second time by another route. (The same key with a different body is refused.)
            const again = await held.replay(context, input, idempotencyKey, request.ip);
            if (again) return again;
            await assertOwnPayee(context, input.beneficiaryId);
            // With an approval policy the payment is HELD here: nothing is sent to the provider until it is approved.
            // Without one it goes straight to the provider, and is recorded here by its key BEFORE the provider is asked.
            return held.submit(context, input, idempotencyKey, request.ip);
          },
          // A held payment's creation is recorded with the payment itself; here, what the provider made is recorded as it is.
          (payment) => (payment.held ? null : { payment: payment.id, status: payment.status, amount: payment.amount, currency: payment.currency, payee: payment.beneficiaryId }),
        ));
      });
      api.get('/payments/by-key/:key', async (request) => {
        const context = await companyOf(request);
        const key = parse(schemas.idempotencyKey, (request.params as { key: string }).key);
        const mine = await held.findByKey(context, key);
        return mine !== undefined ? mine : withProvider(context, (provider) => provider.findPaymentByIdempotencyKey(key));
      });
      api.get('/approvals', async (request) => {
        const context = await companyOf(request);
        const provider = await providerOf(context);
        // Held by this server (every provider), then any that were already pending at the provider before approvals moved here.
        const elsewhere = provider.capabilities.paymentApprovals ? await withProvider(context, () => provider.listPendingApprovals()) : [];
        // Where this server holds payments, anything still pending at the provider is marked as not held here.
        const items = [...(await held.listAwaiting(context)), ...elsewhere.map((item) => (held.holds(context.company) ? { ...item, external: true } : item))];
        return { items, truncated: false };
      });
      const decide = (action: 'payment.approve' | 'payment.reject' | 'payment.cancel') => async (request: FastifyRequest) => {
        const context = await companyOf(request);
        const paymentId = parse(z.string().min(1).max(120), (request.params as { id: string }).id);
        const mine = await held.find(context.company.id, paymentId);
        if (mine) {
          // Held by this server. The entry says how much and to which payee, whatever the outcome.
          const given = action === 'payment.reject' ? ((request.body as { reason?: unknown } | null)?.reason ?? null) : null;
          if (given !== null && (typeof given !== 'string' || given.length > 200 || hasControlCharacters(given))) throw new ApiError('validation', { fields: ['reason'] });
          const note = typeof given === 'string' && given.trim() ? given.trim() : null;
          return thenNotify(context, audited(
            request,
            context,
            action,
            { ...held.detailOf(mine), ...(note ? { note } : {}) },
            async () => {
              await authorize(request, context, action, { paymentId });
              if (action === 'payment.approve') return held.approve(context, paymentId, request.ip);
              if (action === 'payment.reject') await held.reject(context, paymentId, note, request.ip);
              else await held.cancel(context, paymentId, request.ip);
              return { ok: true };
            },
            // Recorded by the service, in the same transaction as the decision. (A repeated "approve" that only reports
            // where the payment has got to changes nothing and is not an approval.)
            () => null,
          ));
        }
        // Not held here: a payment that was already pending at the provider. It can be approved or rejected there, not cancelled.
        const provider = await providerOf(context);
        if (action === 'payment.cancel') throw new ApiError('not_found');
        if (!provider.capabilities.paymentApprovals) throw new ApiError('validation', { reason: 'not_supported' });
        // The provider's own approval: who created it there is not known to this server (see README), but who acts here is.
        return audited(request, context, action, { payment: paymentId, external: 'yes' }, async () => {
          await authorize(request, context, action, { paymentId });
          await assertOwnPendingPayment(context, paymentId);
          if (action === 'payment.approve') return withProvider(context, () => provider.approvePayment(paymentId));
          await withProvider(context, () => provider.rejectPayment(paymentId));
          return { ok: true };
        });
      };
      api.post('/payments/:id/approve', decide('payment.approve'));
      api.post('/payments/:id/reject', decide('payment.reject'));
      api.post('/payments/:id/cancel', decide('payment.cancel'));
    },
    { prefix: '/v1' },
  );

  const opsRoutes = await registerOps(app, { config, stores: deps.stores, auth, opsAuth, registry, mail, notices, authenticatorResets, rates, notifier, alerts, now, limitAttempts });
  // Null when no ADMIN_TOKEN is set: the operator commands are then off.
  const admin = config.adminToken ? await buildAdminApp({ config, stores: deps.stores, auth, opsAuth, mail, now }) : null;

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
  return { app, admin, auth, opsAuth, opsRoutes, held, mail, notices, authenticatorResets, rates, notifier, paymentNotes, alerts };
}
