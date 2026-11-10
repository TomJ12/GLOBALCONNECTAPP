/**
 * ProviderClient implemented over a Transport that speaks Currencycloud-shaped
 * requests. The same class serves the mock (in-memory transport) and, later, a
 * real HTTP transport. Every response is validated with zod before mapping.
 */
import type { z } from 'zod';

import { ProviderError } from '../../errors';
import type { ProviderClient } from '../../provider';
import type {
  AccountDetails,
  Balance,
  Beneficiary,
  BookConversionRequest,
  CompanyProfile,
  Conversion,
  ForwardContract,
  MagicLinkRequest,
  NewBeneficiary,
  NewPayment,
  Page,
  PageRequest,
  Payment,
  PendingApproval,
  Quote,
  QuoteRequest,
  RateHistory,
  RatePair,
  Session,
  Transaction,
} from '../../types';
import {
  isOpenForward,
  mapAccountDetails,
  mapBalance,
  mapBeneficiary,
  mapCompanyProfile,
  mapConversion,
  mapForwardContract,
  mapHttpError,
  mapMagicLinkRequest,
  mapPage,
  mapPayment,
  mapPendingApproval,
  mapQuote,
  mapRate,
  mapRateHistory,
  mapSession,
  mapTransaction,
  parseBody,
  toCreateBeneficiaryParams,
} from './mapping';
import {
  rawAccount,
  rawAppSession,
  rawBasicRates,
  rawBeneficiary,
  rawContact,
  rawConversion,
  rawFindBalances,
  rawFindBeneficiaries,
  rawFindConversions,
  rawFindFundingAccounts,
  rawFindPayments,
  rawFindTransactions,
  rawHeldRateQuote,
  rawMagicLinkRequest,
  rawPayment,
  rawPaymentAuthorisations,
  rawRateHistory,
  type RawContact,
} from './raw';
import type { Transport, TransportParams } from './transport';

export interface CurrencycloudClientOptions {
  /** The provider has no "plan" concept, so the label is supplied by the app. */
  planName: string | null;
  /** How long to ask the provider to hold a quote, in seconds. */
  quoteHoldSeconds?: number;
  /** Set only by the mock so the sign-in screen can offer a shortcut. */
  devMagicLinkCode?: string | null;
  now?: () => number;
}

const MAX_PAGE_SIZE = 100;

export class CurrencycloudClient implements ProviderClient {
  private token: string | null = null;
  private readonly now: () => number;

  constructor(
    private readonly transport: Transport,
    private readonly options: CurrencycloudClientOptions,
  ) {
    this.now = options.now ?? Date.now;
  }

  private async call<S extends z.ZodType>(
    schema: S,
    method: 'GET' | 'POST',
    path: string,
    params?: TransportParams,
  ): Promise<z.infer<S>> {
    let response;
    try {
      response = await this.transport.request({ method, path, params, token: this.token });
    } catch (cause) {
      throw new ProviderError('network', {
        detail: cause instanceof Error ? cause.message : 'No response',
        cause,
      });
    }
    if (response.status < 200 || response.status >= 300) {
      throw mapHttpError(response.status, response.body);
    }
    return parseBody(schema, response.body);
  }

  // --- Sign-in ----------------------------------------------------------------

  async requestMagicLink(email: string): Promise<MagicLinkRequest> {
    const raw = await this.call(rawMagicLinkRequest, 'POST', '/v2/authenticate/magic_link/request', {
      email: email.trim().toLowerCase(),
    });
    return mapMagicLinkRequest(raw, this.options.devMagicLinkCode ?? null);
  }

  async verifyMagicLink(requestId: string, code: string): Promise<Session> {
    const raw = await this.call(rawAppSession, 'POST', '/v2/authenticate/magic_link/verify', {
      request_id: requestId,
      code,
    });
    const { session, token } = mapSession(raw);
    this.token = token;
    return session;
  }

  async resumeSession(deviceCredential: string): Promise<Session> {
    const raw = await this.call(rawAppSession, 'POST', '/v2/authenticate/device', {
      device_credential: deviceCredential,
    });
    const { session, token } = mapSession(raw);
    this.token = token;
    return session;
  }

  async signOut(): Promise<void> {
    const token = this.token;
    // Drop the token first so the app is signed out even if the request fails.
    this.token = null;
    if (!token) return;
    try {
      await this.transport.request({ method: 'POST', path: '/v2/authenticate/close_session', token });
    } catch {
      // Best effort. The local session is already gone.
    }
  }

  // --- Accounts ---------------------------------------------------------------

  async getCompanyProfile(): Promise<CompanyProfile> {
    const raw = await this.call(rawAccount, 'GET', '/v2/accounts/current');
    return mapCompanyProfile(raw, this.options.planName);
  }

  async listBalances(): Promise<Balance[]> {
    const raw = await this.call(rawFindBalances, 'GET', '/v2/balances/find', {
      per_page: String(MAX_PAGE_SIZE),
      order: 'created_at',
      order_asc_desc: 'asc',
    });
    return raw.balances.map(mapBalance);
  }

  async getAccountDetails(currency: string): Promise<AccountDetails> {
    const raw = await this.call(rawFindFundingAccounts, 'GET', '/v2/funding_accounts/find', {
      currency: currency.toUpperCase(),
      per_page: String(MAX_PAGE_SIZE),
    });
    return mapAccountDetails(currency, raw.funding_accounts);
  }

  async listTransactions(request: PageRequest): Promise<Page<Transaction>> {
    const raw = await this.call(rawFindTransactions, 'GET', '/v2/transactions/find', {
      page: String(request.page),
      per_page: String(request.perPage),
      order: 'created_at',
      order_asc_desc: 'desc',
    });
    return mapPage(raw.pagination, raw.transactions.map(mapTransaction));
  }

  // --- Rates and conversions --------------------------------------------------

  async getRate(base: string, quote: string): Promise<RatePair> {
    const raw = await this.call(rawBasicRates, 'GET', '/v2/rates/find', {
      currency_pair: `${base}${quote}`.toUpperCase(),
    });
    return mapRate(base, quote, raw, new Date(this.now()).toISOString());
  }

  async getRateHistory(base: string, quote: string): Promise<RateHistory> {
    // NOT PART OF THE PROVIDER API. See raw.ts.
    const raw = await this.call(rawRateHistory, 'GET', '/v2/rates/history', {
      currency_pair: `${base}${quote}`.toUpperCase(),
    });
    return mapRateHistory(raw);
  }

  async createQuote(request: QuoteRequest): Promise<Quote> {
    if (request.kind === 'forward' && !request.settlementDate) {
      throw new ProviderError('validation', { detail: 'A forward needs a settlement date', fields: ['settlementDate'] });
    }
    const raw = await this.call(rawHeldRateQuote, 'POST', '/v2/quotes/create', {
      buy_currency: request.buyCurrency,
      sell_currency: request.sellCurrency,
      fixed_side: request.fixedSide,
      amount: request.amount,
      hold_period: String(this.options.quoteHoldSeconds ?? 30),
      conversion_date: request.kind === 'forward' ? request.settlementDate : undefined,
    });
    return mapQuote(raw, request);
  }

  async bookConversion(request: BookConversionRequest): Promise<Conversion> {
    const { quote } = request;
    const raw = await this.call(rawConversion, 'POST', '/v2/conversions/create', {
      buy_currency: quote.buyCurrency,
      sell_currency: quote.sellCurrency,
      fixed_side: quote.fixedSide,
      amount: quote.fixedSide === 'sell' ? quote.sellAmount : quote.buyAmount,
      term_agreement: 'true',
      quote_id: quote.id,
      conversion_date: quote.kind === 'forward' ? (quote.settlementDate ?? undefined) : undefined,
      unique_request_id: request.idempotencyKey,
    });
    return mapConversion(raw);
  }

  async listForwardContracts(): Promise<ForwardContract[]> {
    const raw = await this.call(rawFindConversions, 'GET', '/v2/conversions/find', {
      per_page: String(MAX_PAGE_SIZE),
      order: 'created_at',
      order_asc_desc: 'desc',
    });
    return raw.conversions.filter(isOpenForward).map(mapForwardContract);
  }

  // --- Payees -----------------------------------------------------------------

  async listBeneficiaries(): Promise<Beneficiary[]> {
    const raw = await this.call(rawFindBeneficiaries, 'POST', '/v2/beneficiaries/find', {
      per_page: String(MAX_PAGE_SIZE),
    });
    return raw.beneficiaries.map(mapBeneficiary);
  }

  async createBeneficiary(input: NewBeneficiary): Promise<Beneficiary> {
    const raw = await this.call(rawBeneficiary, 'POST', '/v2/beneficiaries/create', toCreateBeneficiaryParams(input));
    return mapBeneficiary(raw);
  }

  private async beneficiaryNames(): Promise<Map<string, string>> {
    const beneficiaries = await this.listBeneficiaries();
    return new Map(beneficiaries.map((beneficiary) => [beneficiary.id, beneficiary.name]));
  }

  // --- Payments ---------------------------------------------------------------

  async listPayments(request: PageRequest): Promise<Page<Payment>> {
    const [raw, names] = await Promise.all([
      this.call(rawFindPayments, 'GET', '/v2/payments/find', {
        page: String(request.page),
        per_page: String(request.perPage),
        order: 'created_at',
        order_asc_desc: 'desc',
      }),
      this.beneficiaryNames(),
    ]);
    return mapPage(
      raw.pagination,
      raw.payments.map((payment) => mapPayment(payment, names)),
    );
  }

  async createPayment(input: NewPayment): Promise<Payment> {
    const raw = await this.call(rawPayment, 'POST', '/v2/payments/create', {
      currency: input.currency,
      beneficiary_id: input.beneficiaryId,
      amount: input.amount,
      reason: input.reason,
      reference: input.reference,
      unique_request_id: input.idempotencyKey,
    });
    // The payment is made at this point. Do not fail it because the name lookup failed.
    const names = await this.beneficiaryNames().catch(() => new Map<string, string>());
    return mapPayment(raw, names);
  }

  async listPendingApprovals(): Promise<PendingApproval[]> {
    const [raw, names] = await Promise.all([
      this.call(rawFindPayments, 'GET', '/v2/payments/find', {
        status: 'awaiting_authorisation',
        per_page: String(MAX_PAGE_SIZE),
        order: 'created_at',
        order_asc_desc: 'desc',
      }),
      this.beneficiaryNames(),
    ]);
    const creatorIds = [...new Set(raw.payments.map((payment) => payment.creator_contact_id).filter(Boolean))] as string[];
    const creators = new Map<string, RawContact>();
    await Promise.all(
      creatorIds.map(async (id) => {
        try {
          creators.set(id, await this.call(rawContact, 'GET', `/v2/contacts/${encodeURIComponent(id)}`));
        } catch (error) {
          // The creator's name is a nicety. Only an expired session should stop the list.
          if (error instanceof ProviderError && error.kind === 'unauthorized') throw error;
        }
      }),
    );
    return raw.payments.map((payment) =>
      mapPendingApproval(payment, names, creators.get(payment.creator_contact_id ?? '') ?? null),
    );
  }

  async approvePayment(paymentId: string): Promise<void> {
    const raw = await this.call(rawPaymentAuthorisations, 'POST', '/v2/payments/authorise', {
      'payment_ids[]': [paymentId],
    });
    const result = raw.authorisations.find((item) => item.payment_id === paymentId);
    if (!result) {
      throw new ProviderError('malformed_response', { detail: 'Authorisation result missing for payment' });
    }
    const updated = result.updated === true || result.updated === 'true';
    if (!updated) {
      const kind =
        result.error === 'insufficient_funds'
          ? 'insufficient_funds'
          : result.error === 'payment_not_found'
            ? 'not_found'
            : 'validation';
      throw new ProviderError(kind, { detail: result.error ?? 'Payment was not authorised' });
    }
  }

  async rejectPayment(paymentId: string): Promise<void> {
    // The provider has no "reject" endpoint; deleting the unreleased payment is the closest match.
    await this.call(rawPayment, 'POST', `/v2/payments/${encodeURIComponent(paymentId)}/delete`);
  }
}
