/**
 * The app's backend when EXPO_PUBLIC_API_URL is set: the Global Connect server,
 * over HTTPS. The server signs the person in, works out which provider holds
 * the company's account and talks to it. Nothing provider-specific is here.
 *
 * The session token and step-up tokens live in this object's memory only.
 */
import type { z } from 'zod';

import type { AuthClient } from '../auth';
import { canonicalJson } from '../canonical';
import { isProviderErrorReason, ProviderError, type ProviderErrorKind } from '../errors';
import type { ProviderClient } from '../provider';
import * as schemas from '../schemas';
import type {
  BookConversionRequest,
  CodeMethod,
  NewBeneficiary,
  NewPayment,
  PageRequest,
  QuoteRequest,
  Session,
  SignInResult,
  StepUpAction,
} from '../types';

export const DEFAULT_REQUEST_TIMEOUT_MS = 20_000;

const KINDS: readonly ProviderErrorKind[] = [
  'network',
  'timeout',
  'unauthorized',
  'forbidden',
  'rate_limited',
  'server',
  'malformed_response',
  'validation',
  'not_found',
  'quote_expired',
  'insufficient_funds',
];

function kindForStatus(status: number): ProviderErrorKind {
  if (status === 401) return 'unauthorized';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not_found';
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'server';
  return 'validation';
}

function errorFrom(status: number, body: string): ProviderError {
  try {
    const parsed = schemas.errorBody.safeParse(JSON.parse(body));
    if (parsed.success) {
      const { kind, reason, fields, retryAfterSeconds } = parsed.data.error;
      return new ProviderError(KINDS.includes(kind as ProviderErrorKind) ? (kind as ProviderErrorKind) : kindForStatus(status), {
        status,
        fields,
        retryAfterSeconds,
        reason: isProviderErrorReason(reason) ? reason : undefined,
      });
    }
  } catch {
    // The status code is enough.
  }
  return new ProviderError(kindForStatus(status), { status });
}

export interface GlobalConnectApiOptions {
  /** Server address, for example "https://api.example.com". "/" means the same origin as the web app. */
  baseUrl: string;
  fetch?: typeof fetch;
  requestTimeoutMs?: number;
}

interface CallOptions {
  body?: unknown;
  headers?: Record<string, string>;
  /** Sign-in and activation calls are made without a session. */
  anonymous?: boolean;
}

export class GlobalConnectApi implements ProviderClient, AuthClient {
  readonly sampleCode = null;
  private token: string | null = null;
  private activationCode: string | null = null;
  /** One-time step-up tokens waiting for their request, keyed by action and exact payload. */
  private readonly grants = new Map<string, string>();
  private readonly baseUrl: string;

  constructor(private readonly options: GlobalConnectApiOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
  }

  private async call<S extends z.ZodType>(schema: S, method: 'GET' | 'POST', path: string, options: CallOptions = {}): Promise<z.infer<S>> {
    const doFetch = this.options.fetch ?? fetch;
    const timeoutMs = this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    let status: number;
    let text: string;
    try {
      const response = await doFetch(`${this.baseUrl}/v1${path}`, {
        method,
        signal: controller.signal,
        headers: {
          Accept: 'application/json',
          ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          ...(this.token && !options.anonymous ? { Authorization: `Bearer ${this.token}` } : {}),
          ...options.headers,
        },
        body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
      });
      status = response.status;
      text = await response.text();
    } catch (cause) {
      // The request may still have been applied, so both count as outcome-unknown.
      throw new ProviderError(timedOut ? 'timeout' : 'network', { cause });
    } finally {
      clearTimeout(timer);
    }
    if (status < 200 || status >= 300) throw errorFrom(status, text);
    let json: unknown;
    try {
      json = text === '' ? null : JSON.parse(text);
    } catch (cause) {
      throw new ProviderError('malformed_response', { detail: 'Response was not valid JSON', cause });
    }
    const result = schema.safeParse(json);
    if (!result.success) {
      const where = result.error.issues.slice(0, 5).map((issue) => issue.path.join('.') || '(root)');
      throw new ProviderError('malformed_response', { detail: `Unexpected response shape at: ${where.join(', ')}` });
    }
    return result.data;
  }

  private grantKey(action: StepUpAction, payload: unknown): string {
    return `${action}:${canonicalJson(payload)}`;
  }

  /** The header for a stepped-up request, if a matching permission is waiting. It is used once. */
  private stepUpHeader(action: StepUpAction, payload: unknown): Record<string, string> {
    const key = this.grantKey(action, payload);
    const token = this.grants.get(key);
    if (!token) return {};
    this.grants.delete(key);
    return { 'X-Step-Up-Token': token };
  }

  // --- Sign-in ----------------------------------------------------------------

  signIn(email: string, password: string) {
    return this.call(schemas.loginChallenge, 'POST', '/auth/login', { body: { email: email.trim().toLowerCase(), password }, anonymous: true });
  }

  async completeSignIn(challengeId: string, code: string, method: CodeMethod): Promise<SignInResult> {
    const { token, ...result } = await this.call(schemas.signInResponse, 'POST', '/auth/login/verify', {
      body: { challengeId, code: code.trim(), method },
      anonymous: true,
    });
    this.token = token;
    this.grants.clear();
    return result;
  }

  selectCompany(companyId: string): Promise<Session> {
    return this.call(schemas.session, 'POST', '/session/company', { body: { companyId } });
  }

  async signOut(): Promise<void> {
    const token = this.token;
    // Drop everything first so the app is signed out even if the request fails.
    this.token = null;
    this.activationCode = null;
    this.grants.clear();
    if (!token) return;
    try {
      const doFetch = this.options.fetch ?? fetch;
      await doFetch(`${this.baseUrl}/v1/auth/logout`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
    } catch {
      // Best effort. The session also ends on the server when it has been idle.
    }
  }

  // --- Activation -------------------------------------------------------------

  async beginActivation(activationCode: string) {
    const code = activationCode.trim();
    const start = await this.call(schemas.activationStart, 'POST', '/activation/start', { body: { activationCode: code }, anonymous: true });
    this.activationCode = code;
    return start;
  }

  setActivationPassword(password: string) {
    return this.call(schemas.totpEnrolment, 'POST', '/activation/password', {
      body: { activationCode: this.activationCode ?? '', password },
      anonymous: true,
    });
  }

  async confirmActivation(code: string) {
    const result = await this.call(schemas.activationResult, 'POST', '/activation/confirm', {
      body: { activationCode: this.activationCode ?? '', code: code.trim() },
      anonymous: true,
    });
    this.activationCode = null;
    return result;
  }

  // --- Step-up ----------------------------------------------------------------

  async authorizeAction(action: StepUpAction, payload: unknown, code: string): Promise<void> {
    const grant = await this.call(schemas.stepUpGrant, 'POST', '/step-up', { body: { action, payload, code: code.trim() } });
    this.grants.set(this.grantKey(action, payload), grant.token);
  }

  // --- Account data -----------------------------------------------------------

  getCompanyProfile() {
    return this.call(schemas.companyProfile, 'GET', '/company');
  }
  async listBalances() {
    return (await this.call(schemas.listResult(schemas.balance), 'GET', '/balances')).items;
  }
  getAccountDetails(currency: string) {
    return this.call(schemas.accountDetails, 'GET', `/account-details/${encodeURIComponent(currency.toUpperCase())}`);
  }
  listTransactions(request: PageRequest) {
    return this.call(schemas.page(schemas.transaction), 'GET', `/transactions?page=${request.page}&perPage=${request.perPage}`);
  }
  getRate(base: string, quote: string) {
    return this.call(schemas.ratePair, 'GET', `/rates/${encodeURIComponent(base)}/${encodeURIComponent(quote)}`);
  }
  getRateHistory(base: string, quote: string) {
    return this.call(schemas.rateHistory, 'GET', `/rates/${encodeURIComponent(base)}/${encodeURIComponent(quote)}/history`);
  }
  async createQuote(request: QuoteRequest) {
    const quote = await this.call(schemas.quote, 'POST', '/quotes', { body: request });
    // The countdown runs on this device's clock. Keep the server's hold LENGTH, started when the answer arrived here.
    const holdMs = Date.parse(quote.expiresAt) - Date.parse(quote.createdAt);
    if (Number.isNaN(holdMs) || holdMs <= 0) throw new ProviderError('malformed_response', { detail: 'Quote hold period is not positive' });
    const receivedAt = Date.now();
    return { ...quote, createdAt: new Date(receivedAt).toISOString(), expiresAt: new Date(receivedAt + holdMs).toISOString() };
  }
  bookConversion(request: BookConversionRequest) {
    return this.call(schemas.conversion, 'POST', '/conversions', {
      body: { quoteId: request.quote.id },
      headers: { 'Idempotency-Key': request.idempotencyKey, ...this.stepUpHeader('conversion.book', conversionStepUpPayload(request)) },
    });
  }
  findConversionByIdempotencyKey(idempotencyKey: string) {
    return this.call(schemas.conversion.nullable(), 'GET', `/conversions/by-key/${encodeURIComponent(idempotencyKey)}`);
  }
  async listForwardContracts() {
    return (await this.call(schemas.listResult(schemas.forwardContract), 'GET', '/forwards')).items;
  }
  listBeneficiaries() {
    return this.call(schemas.listResult(schemas.beneficiary), 'GET', '/beneficiaries');
  }
  createBeneficiary(input: NewBeneficiary) {
    return this.call(schemas.beneficiary, 'POST', '/beneficiaries', { body: input, headers: this.stepUpHeader('beneficiary.create', input) });
  }
  listPayments(request: PageRequest) {
    return this.call(schemas.page(schemas.payment), 'GET', `/payments?page=${request.page}&perPage=${request.perPage}`);
  }
  createPayment(input: NewPayment) {
    const { idempotencyKey, ...body } = input;
    return this.call(schemas.payment, 'POST', '/payments', {
      body,
      headers: { 'Idempotency-Key': idempotencyKey, ...this.stepUpHeader('payment.create', input) },
    });
  }
  findPaymentByIdempotencyKey(idempotencyKey: string) {
    return this.call(schemas.payment.nullable(), 'GET', `/payments/by-key/${encodeURIComponent(idempotencyKey)}`);
  }
  async listPendingApprovals() {
    return (await this.call(schemas.listResult(schemas.pendingApproval), 'GET', '/approvals')).items;
  }
  approvePayment(paymentId: string) {
    return this.call(schemas.approvalResult, 'POST', `/payments/${encodeURIComponent(paymentId)}/approve`, {
      headers: this.stepUpHeader('payment.approve', { paymentId }),
    });
  }
  async cancelPayment(paymentId: string): Promise<void> {
    await this.call(schemas.ok, 'POST', `/payments/${encodeURIComponent(paymentId)}/cancel`, {
      headers: this.stepUpHeader('payment.cancel', { paymentId }),
    });
  }
  async rejectPayment(paymentId: string): Promise<void> {
    await this.call(schemas.ok, 'POST', `/payments/${encodeURIComponent(paymentId)}/reject`, {
      headers: this.stepUpHeader('payment.reject', { paymentId }),
    });
  }
}

/** What a step-up for a conversion is bound to: the held quote and the key. */
export function conversionStepUpPayload(request: BookConversionRequest): { quoteId: string; idempotencyKey: string } {
  return { quoteId: request.quote.id, idempotencyKey: request.idempotencyKey };
}
