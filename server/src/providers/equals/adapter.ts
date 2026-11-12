/**
 * Provider B: maps the wire shapes in raw.ts to the neutral interface.
 * See raw.ts for which shapes come from the public documentation and which
 * are this mock's own.
 *
 * This provider has no forward contracts and no payment approvals here, so its
 * capabilities say so and the matching methods refuse.
 */
import { Big } from 'big.js';
import type { z } from 'zod';

import { ProviderError } from '@/api/errors';
import type {
  AccountDetails,
  ApprovalResult,
  Balance,
  Beneficiary,
  BookConversionRequest,
  CompanyProfile,
  Conversion,
  ForwardContract,
  ListResult,
  NewBeneficiary,
  NewPayment,
  Page,
  PageRequest,
  Payment,
  PaymentStatus,
  PendingApproval,
  Quote,
  QuoteRequest,
  RateHistory,
  RatePair,
  Transaction,
} from '@/api/types';
import { currencyDecimals } from '@/lib/money';

import type { CompanyRecord } from '../../store/types';
import type { ProviderAdapter, ProviderFactory } from '../adapter';
import { MockEqualsServer, QUOTE_TTL_MS } from './mockServer';
import {
  rawActivity,
  rawBudgets,
  rawError,
  rawOrderQuote,
  rawPaymentOrder,
  rawPaymentOrders,
  rawRate,
  rawRecipient,
  rawRecipients,
  rawTradeOrder,
  type EqualsTransport,
  type RawBudget,
  type RawOrderQuote,
  type RawPaymentOrder,
  type RawRecipient,
} from './raw';

const REQUEST_TIMEOUT_MS = 20_000;
const PAGE_LIMIT = 100;
const MAX_PAGES = 50;

const money = (amount: number, currency: string): string => new Big(amount).toFixed(currencyDecimals(currency));
const compactDate = (iso: string): string => iso.replace(/-/g, '');
const isoDate = (compact: string): string => `${compact.slice(0, 4)}-${compact.slice(4, 6)}-${compact.slice(6, 8)}`;

function errorFor(status: number, body: string): ProviderError {
  let code = '';
  let field: string | undefined;
  try {
    const parsed = rawError.safeParse(JSON.parse(body));
    if (parsed.success) ({ code, field } = parsed.data);
  } catch {
    // The status code is enough.
  }
  const options = { status, detail: code || `HTTP ${status}`, fields: field ? [field] : [] };
  if (code === 'quote_expired' || code === 'quote_not_found') return new ProviderError('quote_expired', options);
  if (code === 'insufficient_funds') return new ProviderError('insufficient_funds', options);
  if (status === 401) return new ProviderError('unauthorized', options);
  if (status === 403) return new ProviderError('forbidden', options);
  if (status === 404) return new ProviderError('not_found', options);
  if (status === 429) return new ProviderError('rate_limited', options);
  if (status >= 500) return new ProviderError('server', options);
  return new ProviderError('validation', options);
}

const PAYMENT_STATUS: Record<string, PaymentStatus> = { processing: 'processing', complete: 'sent', failed: 'failed', cancelled: 'cancelled' };

export function mapRecipient(raw: RawRecipient): Beneficiary {
  const country = raw.bankAddress?.countryCode ?? '';
  const isIban = /^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/.test(raw.accountIdentifier);
  const bank = raw.bankIdentifier ?? null;
  const sortCode = !isIban && country === 'GB' && bank && /^\d{6}$/.test(bank) ? bank : null;
  const routingNumber = !isIban && country === 'US' && bank && /^\d{9}$/.test(bank) ? bank : null;
  return {
    id: raw.id,
    name: raw.name,
    entityType: raw.type === 'individual' ? 'individual' : 'company',
    currency: raw.currencyCode,
    bankCountry: country,
    accountNumber: isIban ? null : raw.accountIdentifier,
    sortCode,
    iban: isIban ? raw.accountIdentifier : null,
    bic: sortCode || routingNumber ? null : bank,
    routingNumber,
  };
}

export function mapPaymentOrder(raw: RawPaymentOrder, names: ReadonlyMap<string, string>): Payment {
  const currency = raw.payments.currency.currencyCode;
  return {
    id: raw.orderId,
    shortReference: raw.orderId,
    amount: money(raw.payments.amount, currency),
    currency,
    beneficiaryId: raw.payments.recipientId,
    beneficiaryName: names.get(raw.payments.recipientId) ?? null,
    reference: raw.payments.externalReference,
    status: PAYMENT_STATUS[raw.status] ?? 'unknown',
    route: null,
    fee: null,
    estimatedArrival: null,
    createdAt: raw.createdAt,
  };
}

export function mapBalances(budget: RawBudget): Balance[] {
  return (budget.balance ?? []).map((row) => ({
    id: `${budget.id}-${row.currencyCode.toLowerCase()}`,
    currency: row.currencyCode,
    amount: money(row.availableBalance, row.currencyCode),
    updatedAt: budget.updatedAt,
  }));
}

export class EqualsAdapter implements ProviderAdapter {
  readonly capabilities = { forwardContracts: false, paymentApprovals: false };
  private readonly now: () => number;
  /** Order ids of quotes we issued, and which idempotency key booked which order. PLACEHOLDER: belongs in the database. */
  private readonly orderForQuote = new Map<string, string>();
  private readonly orderForKey = new Map<string, string>();

  constructor(
    private readonly transport: EqualsTransport,
    private readonly company: CompanyRecord,
    private readonly apiKey: string,
    options: { now?: () => number } = {},
  ) {
    this.now = options.now ?? Date.now;
  }

  private async call<S extends z.ZodType>(schema: S, method: 'GET' | 'POST', path: string, query: Record<string, string> = {}, body?: unknown): Promise<z.infer<S>> {
    let response;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      response = await Promise.race([
        // The account id always comes from the company's directory entry, never from the caller.
        this.transport.request({ method, path, query: { ...query, accountId: this.company.providerAccountId }, body, apiKey: this.apiKey }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new ProviderError('timeout')), REQUEST_TIMEOUT_MS);
        }),
      ]);
    } catch (cause) {
      if (cause instanceof ProviderError) throw cause;
      throw new ProviderError('network', { cause });
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
    if (response.status < 200 || response.status >= 300) throw errorFor(response.status, response.body);
    let json: unknown;
    try {
      json = JSON.parse(response.body);
    } catch (cause) {
      throw new ProviderError('malformed_response', { cause });
    }
    const parsed = schema.safeParse(json);
    if (!parsed.success) throw new ProviderError('malformed_response', { detail: 'Unexpected response shape' });
    return parsed.data;
  }

  private async all<T>(schema: z.ZodType<{ count: number; rows: T[] }>, path: string, query: Record<string, string> = {}): Promise<ListResult<T>> {
    const items: T[] = [];
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const raw = await this.call(schema, 'GET', path, { ...query, limit: String(PAGE_LIMIT), offset: String(page * PAGE_LIMIT) });
      items.push(...raw.rows);
      if (items.length >= raw.count || raw.rows.length === 0) return { items, truncated: false };
    }
    return { items, truncated: true };
  }

  private async budget(include: string): Promise<RawBudget> {
    const raw = await this.call(rawBudgets, 'GET', '/v2/budgets', { include, type: 'accountBalance' });
    const budget = raw.rows[0];
    if (!budget) throw new ProviderError('not_found', { detail: 'No balance budget' });
    return budget;
  }

  private async recipientNames(): Promise<Map<string, string>> {
    const recipients = await this.all(rawRecipients, '/v2/recipients').catch(() => ({ items: [] as RawRecipient[] }));
    return new Map(recipients.items.map((row) => [row.id, row.name]));
  }

  private page<T>(raw: { count: number }, request: PageRequest, items: T[]): Page<T> {
    const totalPages = Math.max(1, Math.ceil(raw.count / request.perPage));
    return { items, page: request.page, totalPages, totalItems: raw.count, nextPage: request.page < totalPages ? request.page + 1 : null };
  }

  async getCompanyProfile(): Promise<CompanyProfile> {
    return { id: this.company.id, companyName: this.company.name, planName: null };
  }

  async listBalances(): Promise<Balance[]> {
    return mapBalances(await this.budget('balance'));
  }

  async getAccountDetails(currency: string): Promise<AccountDetails> {
    const budget = await this.budget('settlementDetails');
    const details = budget.settlementDetails?.currencyDetails.find((row) => row.currencyCode === currency.toUpperCase());
    if (!details) throw new ProviderError('not_found', { detail: 'No account details for currency' });
    return {
      currency: details.currencyCode,
      accountHolderName: details.local?.accountName ?? details.international?.accountName ?? this.company.name,
      sortCode: details.local?.sortCode ?? null,
      accountNumber: details.local?.accountNumber ?? null,
      iban: details.international?.iban ?? null,
      bic: details.international?.bic ?? null,
    };
  }

  async listTransactions(request: PageRequest): Promise<Page<Transaction>> {
    const raw = await this.call(rawActivity, 'GET', '/v2/activity', { limit: String(request.perPage), offset: String((request.page - 1) * request.perPage) });
    const kinds: Record<string, Transaction['kind']> = { payment: 'payment', exchange: 'conversion', deposit: 'funding', fee: 'fee' };
    return this.page(
      raw,
      request,
      raw.rows.map((row) => ({
        id: row.id,
        currency: row.currencyCode,
        amount: money(row.amount, row.currencyCode),
        direction: row.direction === 'in' ? ('credit' as const) : ('debit' as const),
        kind: kinds[row.type] ?? 'other',
        description: row.description,
        reference: row.reference ? row.reference : null,
        status: row.status === 'complete' ? ('completed' as const) : row.status === 'cancelled' ? ('cancelled' as const) : ('pending' as const),
        createdAt: row.createdAt,
      })),
    );
  }

  async getRate(base: string, quote: string): Promise<RatePair> {
    const raw = await this.call(rawRate, 'GET', '/v2/rates', { from: base.toUpperCase(), to: quote.toUpperCase() });
    return { base: raw.from, quote: raw.to, rate: new Big(raw.rate).toFixed(4), asOf: raw.timestamp };
  }

  /** This provider offers no rate history; an empty series draws no trend line. */
  async getRateHistory(base: string, quote: string): Promise<RateHistory> {
    return { base: base.toUpperCase(), quote: quote.toUpperCase(), points: [] };
  }

  async createQuote(request: QuoteRequest): Promise<Quote> {
    if (request.kind !== 'spot') throw new ProviderError('validation', { reason: 'not_supported', fields: ['kind'] });
    const budget = await this.budget('balance');
    const leg = (currencyCode: string, fixed: boolean) => ({
      ...(fixed ? { amount: Number(request.amount) } : {}),
      currency: { budgetId: budget.id, currencyCode },
    });
    const createdAt = this.now();
    const raw: RawOrderQuote = await this.call(rawOrderQuote, 'POST', '/v2/orders/quote', {}, {
      sourceCurrency: leg(request.sellCurrency, request.fixedSide === 'sell'),
      targetCurrency: leg(request.buyCurrency, request.fixedSide === 'buy'),
      settlementDate: compactDate(new Date(createdAt).toISOString().slice(0, 10)),
      type: { from: 'balance', to: 'balance' },
    });
    this.orderForQuote.set(raw.quoteRequestId, raw.orderId);
    return {
      id: raw.quoteRequestId,
      kind: 'spot',
      sellCurrency: raw.quote.from.currency,
      buyCurrency: raw.quote.to.currency,
      sellAmount: money(raw.quote.from.amount, raw.quote.from.currency),
      buyAmount: money(raw.quote.to.amount, raw.quote.to.currency),
      fixedSide: request.fixedSide,
      rateBase: raw.quote.from.currency,
      rateQuote: raw.quote.to.currency,
      rate: new Big(raw.quote.rate).toFixed(4),
      createdAt: new Date(createdAt).toISOString(),
      // The response carries no expiry; the documented validity is used.
      expiresAt: new Date(createdAt + QUOTE_TTL_MS).toISOString(),
      settlementDate: null,
    };
  }

  private mapTrade(raw: z.infer<typeof rawTradeOrder>): Conversion {
    return {
      id: raw.orderId,
      reference: raw.orderId,
      kind: 'spot',
      status: raw.status === 'complete' ? 'settled' : raw.status === 'cancelled' ? 'cancelled' : 'pending',
      sellCurrency: raw.quote.from.currency,
      buyCurrency: raw.quote.to.currency,
      sellAmount: money(raw.quote.from.amount, raw.quote.from.currency),
      buyAmount: money(raw.quote.to.amount, raw.quote.to.currency),
      rateBase: raw.quote.from.currency,
      rateQuote: raw.quote.to.currency,
      rate: new Big(raw.quote.rate).toFixed(4),
      settlementDate: isoDate(raw.settlement.date),
      createdAt: raw.createdAt,
    };
  }

  async bookConversion(request: BookConversionRequest): Promise<Conversion> {
    const orderId = this.orderForKey.get(request.idempotencyKey) ?? this.orderForQuote.get(request.quote.id);
    if (!orderId) throw new ProviderError('quote_expired');
    // Remembered BEFORE sending, so a lost reply can still be reconciled by key.
    this.orderForKey.set(request.idempotencyKey, orderId);
    return this.mapTrade(await this.call(rawTradeOrder, 'POST', '/v2/orders/trade', {}, { orderId, quoteRequestId: request.quote.id }));
  }

  async findConversionByIdempotencyKey(idempotencyKey: string): Promise<Conversion | null> {
    const orderId = this.orderForKey.get(idempotencyKey);
    if (!orderId) return null;
    try {
      return this.mapTrade(await this.call(rawTradeOrder, 'GET', `/v2/orders/${encodeURIComponent(orderId)}`));
    } catch (error) {
      if (error instanceof ProviderError && error.kind === 'not_found') return null;
      throw error;
    }
  }

  async listForwardContracts(): Promise<ForwardContract[]> {
    return [];
  }

  async listBeneficiaries(): Promise<ListResult<Beneficiary>> {
    const rows = await this.all(rawRecipients, '/v2/recipients');
    return { items: rows.items.filter((row) => row.status === 'AUTHORISED').map(mapRecipient), truncated: rows.truncated };
  }

  /** Two calls, as documented: validate the details, then confirm the recipient so it can be paid. */
  async createBeneficiary(input: NewBeneficiary): Promise<Beneficiary> {
    const bankIdentifier = input.iban ? input.bic : (input.sortCode ?? input.routingNumber ?? input.bic);
    const created = await this.call(rawRecipient, 'POST', '/v2/recipients/validate', {}, {
      accountIdentifier: input.iban ?? input.accountNumber ?? '',
      ...(bankIdentifier ? { bankIdentifier } : {}),
      name: input.name,
      type: input.entityType === 'company' ? 'business' : 'individual',
      currencyCode: input.currency,
      address: { countryCode: input.bankCountry },
      bankAddress: { countryCode: input.bankCountry },
    });
    const confirmed = await this.call(rawRecipient, 'POST', `/v2/recipients/${encodeURIComponent(created.id)}/confirm`, {}, { verificationMethod: 'other' });
    return mapRecipient(confirmed);
  }

  async listPayments(request: PageRequest): Promise<Page<Payment>> {
    const raw = await this.call(rawPaymentOrders, 'GET', '/v2/orders', {
      type: 'payment',
      limit: String(request.perPage),
      offset: String((request.page - 1) * request.perPage),
    });
    const names = await this.recipientNames();
    return this.page(raw, request, raw.rows.map((row) => mapPaymentOrder(row, names)));
  }

  async createPayment(input: NewPayment): Promise<Payment> {
    const budget = await this.budget('balance');
    const raw = await this.call(rawPaymentOrder, 'POST', '/v2/orders/payment', {}, {
      clientReference: input.idempotencyKey,
      payments: {
        amount: Number(input.amount),
        currency: { budgetId: budget.id, currencyCode: input.currency },
        recipientId: input.beneficiaryId,
        internalReference: input.reason,
        externalReference: input.reference,
      },
    });
    return mapPaymentOrder(raw, await this.recipientNames());
  }

  async findPaymentByIdempotencyKey(idempotencyKey: string): Promise<Payment | null> {
    const raw = await this.call(rawPaymentOrders, 'GET', '/v2/orders', { type: 'payment', clientReference: idempotencyKey });
    const match = raw.rows.find((row) => row.clientReference === idempotencyKey);
    return match ? mapPaymentOrder(match, await this.recipientNames()) : null;
  }

  async listPendingApprovals(): Promise<PendingApproval[]> {
    return [];
  }

  async approvePayment(): Promise<ApprovalResult> {
    throw new ProviderError('validation', { reason: 'not_supported' });
  }

  async rejectPayment(): Promise<void> {
    throw new ProviderError('validation', { reason: 'not_supported' });
  }
}

export interface EqualsFactoryOptions {
  credentials: { apiKey: string } | null;
  /** The wire for one company's account. Defaults to an in-memory mock per company. */
  transportFor?: (company: CompanyRecord) => EqualsTransport;
  now?: () => number;
}

export function equalsFactory(options: EqualsFactoryOptions): ProviderFactory {
  const mocks = new Map<string, EqualsTransport>();
  const mockFor = (company: CompanyRecord): EqualsTransport => {
    let mock = mocks.get(company.providerAccountId);
    if (!mock) {
      mock = new MockEqualsServer(company.providerAccountId, { now: options.now });
      mocks.set(company.providerAccountId, mock);
    }
    return mock;
  };
  return async (company) => {
    if (!options.credentials) throw new Error('Provider credentials are not configured');
    return new EqualsAdapter((options.transportFor ?? mockFor)(company), company, options.credentials.apiKey, { now: options.now });
  };
}
