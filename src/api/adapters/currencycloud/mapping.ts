/**
 * Maps Currencycloud-shaped raw payloads to the app's provider-neutral types.
 * Pure functions only: no I/O, no clock, no state. Tested in mapping.test.ts.
 */
import { Big } from 'big.js';
import type { z } from 'zod';

import { ProviderError } from '../../errors';
import type {
  AccountDetails,
  ApprovalResult,
  ApprovalStep,
  Balance,
  Beneficiary,
  CompanyProfile,
  Conversion,
  ConversionKind,
  ConversionStatus,
  ForwardContract,
  IsoDate,
  MagicLinkRequest,
  Money,
  NewBeneficiary,
  Page,
  Payment,
  PaymentRoute,
  PaymentStatus,
  PendingApproval,
  Quote,
  QuoteRequest,
  RateHistory,
  RatePair,
  Session,
  Transaction,
  TransactionKind,
} from '../../types';
import {
  rawErrorBody,
  type RawAccount,
  type RawAppSession,
  type RawBalance,
  type RawBasicRates,
  type RawBeneficiary,
  type RawContact,
  type RawConversion,
  type RawFundingAccount,
  type RawHeldRateQuote,
  type RawMagicLinkRequest,
  type RawPagination,
  type RawPayment,
  type RawPaymentAuthorisation,
  type RawRateHistory,
  type RawTransaction,
} from './raw';

const DECIMAL_RE = /^-?\d+(\.\d+)?$/;
const DAY_MS = 24 * 60 * 60 * 1000;
/**
 * The API has no "forward" flag. We treat a conversion as a forward when it
 * converts more than this many days after it was created. APPROXIMATE: confirm
 * the rule with the provider before using a real adapter.
 */
export const FORWARD_MIN_DAYS = 5;

// --- Boundary helpers -------------------------------------------------------

/** Parse and validate a response body. Bad JSON or a bad shape becomes a typed error. */
export function parseBody<S extends z.ZodType>(schema: S, body: string): z.infer<S> {
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch (cause) {
    throw new ProviderError('malformed_response', { detail: 'Response was not valid JSON', cause });
  }
  const result = schema.safeParse(json);
  if (!result.success) {
    const where = result.error.issues
      .slice(0, 5)
      .map((issue) => issue.path.join('.') || '(root)')
      .join(', ');
    throw new ProviderError('malformed_response', { detail: `Unexpected response shape at: ${where}` });
  }
  return result.data;
}

/**
 * Convert a non-2xx response into a ProviderError.
 * The codes "quote_expired" and "insufficient_funds" are APPROXIMATE: they are
 * what the mock sends. The public spec does not list the real codes.
 */
export function mapHttpError(status: number, body: string): ProviderError {
  let errorCode: string | undefined;
  let fields: string[] = [];
  let codes: string[] = [];
  try {
    const parsed = rawErrorBody.safeParse(JSON.parse(body));
    if (parsed.success) {
      errorCode = parsed.data.error_code;
      const messages = parsed.data.error_messages ?? {};
      fields = Object.keys(messages);
      codes = Object.values(messages).flatMap((list) => list.map((item) => item.code));
    }
  } catch {
    // A non-JSON error body is fine; the status code is enough.
  }
  const detail = [errorCode, ...codes].filter(Boolean).join(' / ') || `HTTP ${status}`;
  const options = { status, detail, fields };

  if (status === 401) return new ProviderError('unauthorized', options);
  if (status === 429) return new ProviderError('rate_limited', options);
  if (status === 404) return new ProviderError('not_found', options);
  if (status >= 500) return new ProviderError('server', options);
  if (status === 400 || status === 422) {
    if (codes.includes('quote_expired')) return new ProviderError('quote_expired', options);
    if (codes.includes('insufficient_funds')) return new ProviderError('insufficient_funds', options);
    return new ProviderError('validation', options);
  }
  // 403 means "signed in but not allowed". It must not end the session.
  if (status === 403) return new ProviderError('forbidden', options);
  return new ProviderError('server', options);
}

function toDateOnly(value: string | null | undefined): IsoDate | null {
  if (!value) return null;
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(value);
  if (!match || Number.isNaN(Date.parse(value))) return null;
  return match[1] ?? null;
}

function requireDateOnly(value: string, field: string): IsoDate {
  const date = toDateOnly(value);
  if (!date) throw new ProviderError('malformed_response', { detail: `Bad date in ${field}` });
  return date;
}

function splitPair(pair: string): { base: string; quote: string } {
  return { base: pair.slice(0, 3).toUpperCase(), quote: pair.slice(3, 6).toUpperCase() };
}

function emptyToNull(value: string | null | undefined): string | null {
  return value === undefined || value === null || value.trim() === '' ? null : value;
}

// --- Pagination -------------------------------------------------------------

export function mapPage<T>(pagination: RawPagination, items: T[]): Page<T> {
  return {
    items,
    page: pagination.current_page,
    totalPages: pagination.total_pages,
    totalItems: pagination.total_entries,
    nextPage: pagination.next_page > pagination.current_page ? pagination.next_page : null,
  };
}

// --- Auth and profile -------------------------------------------------------

export function mapMagicLinkRequest(raw: RawMagicLinkRequest, devCode: string | null): MagicLinkRequest {
  return { requestId: raw.request_id, email: raw.email, expiresAt: raw.expires_at, devCode };
}

export function contactDisplayName(contact: RawContact): string {
  return `${contact.first_name} ${contact.last_name}`.trim();
}

export function mapSession(raw: RawAppSession): { session: Session; token: string } {
  return {
    token: raw.auth_token,
    session: {
      user: {
        id: raw.contact.id,
        email: raw.contact.email_address ?? '',
        displayName: contactDisplayName(raw.contact),
      },
    },
  };
}

export function mapCompanyProfile(raw: RawAccount, planName: string | null): CompanyProfile {
  return { id: raw.id, companyName: raw.account_name, planName };
}

// --- Accounts ---------------------------------------------------------------

export function mapBalance(raw: RawBalance): Balance {
  return { id: raw.id, currency: raw.currency.toUpperCase(), amount: raw.amount, updatedAt: raw.updated_at };
}

/**
 * A currency can have several funding accounts (for example a local one with a
 * sort code and an international one with an IBAN). Merge them into one view.
 *
 * `bank_name` and `bank_address` are deliberately NOT mapped: with a real
 * provider they name the provider, which must not appear in the UI until
 * compliance has agreed the wording.
 */
export function mapAccountDetails(currency: string, accounts: readonly RawFundingAccount[]): AccountDetails {
  const wanted = currency.toUpperCase();
  const matching = accounts.filter((account) => account.currency.toUpperCase() === wanted);
  const first = matching[0];
  if (!first) {
    throw new ProviderError('not_found', { detail: `No funding account for ${wanted}` });
  }
  const details: AccountDetails = {
    currency: wanted,
    accountHolderName: first.account_holder_name,
    sortCode: null,
    accountNumber: null,
    iban: null,
    bic: null,
  };
  for (const account of matching) {
    const numberType = account.account_number_type.toLowerCase();
    const routingType = account.routing_code_type.toLowerCase();
    if (numberType === 'iban') {
      details.iban ??= account.account_number;
    } else if (numberType === 'account_number') {
      details.accountNumber ??= account.account_number;
    }
    if (routingType === 'sort_code') details.sortCode ??= account.routing_code;
    if (routingType === 'bic_swift') details.bic ??= account.routing_code;
  }
  return details;
}

const TRANSACTION_KINDS: Record<string, TransactionKind> = {
  payment: 'payment',
  payment_failure: 'payment',
  payment_unrelease: 'payment',
  conversion: 'conversion',
  conversion_deposit: 'conversion',
  deposit_refund: 'conversion',
  funding: 'funding',
  payment_fee: 'fee',
};

function defaultDescription(kind: TransactionKind, direction: 'credit' | 'debit'): string {
  switch (kind) {
    case 'payment':
      return direction === 'debit' ? 'Payment sent' : 'Payment returned';
    case 'conversion':
      return 'Currency conversion';
    case 'funding':
      return 'Money received';
    case 'fee':
      return 'Fee';
    default:
      return direction === 'credit' ? 'Money in' : 'Money out';
  }
}

export function mapTransaction(raw: RawTransaction): Transaction {
  const kind = TRANSACTION_KINDS[raw.action] ?? 'other';
  return {
    id: raw.id,
    currency: raw.currency.toUpperCase(),
    amount: new Big(raw.amount).abs().toFixed(),
    direction: raw.type,
    kind,
    description: emptyToNull(raw.reason) ?? defaultDescription(kind, raw.type),
    reference: emptyToNull(raw.related_entity_short_reference),
    status: raw.status === 'deleted' ? 'cancelled' : raw.status,
    createdAt: raw.created_at,
  };
}

// --- Rates ------------------------------------------------------------------

/** Basic rates come back as [bid, offer]. The app shows the midpoint as the indicative rate. */
export function mapRate(base: string, quote: string, raw: RawBasicRates, asOf: string): RatePair {
  const key = `${base}${quote}`.toUpperCase();
  const entry = raw.rates[key];
  if (!entry) {
    throw new ProviderError('not_found', { detail: `No rate for ${key}` });
  }
  const [bid, offer] = entry;
  const mid = new Big(bid).plus(new Big(offer)).div(2);
  if (mid.lte(0)) {
    throw new ProviderError('malformed_response', { detail: `Non-positive rate for ${key}` });
  }
  return { base: base.toUpperCase(), quote: quote.toUpperCase(), rate: mid.toFixed(), asOf };
}

export function mapRateHistory(raw: RawRateHistory): RateHistory {
  const { base, quote } = splitPair(raw.currency_pair);
  return { base, quote, points: raw.points.map((point) => ({ at: point.at, rate: point.rate })) };
}

export function mapQuote(raw: RawHeldRateQuote, request: QuoteRequest): Quote {
  const sellCurrency = raw.sell_currency.toUpperCase();
  const buyCurrency = raw.buy_currency.toUpperCase();
  if (sellCurrency !== request.sellCurrency.toUpperCase() || buyCurrency !== request.buyCurrency.toUpperCase()) {
    throw new ProviderError('malformed_response', { detail: 'Quote currencies do not match the request' });
  }
  // The quote must be for what was asked: same fixed side and the same amount on it.
  const fixedAmount = raw.fixed_side === 'sell' ? raw.client_sell_amount : raw.client_buy_amount;
  if (raw.fixed_side !== request.fixedSide || !DECIMAL_RE.test(request.amount) || !new Big(fixedAmount).eq(new Big(request.amount))) {
    throw new ProviderError('malformed_response', { detail: 'Quote amount or fixed side does not match the request' });
  }
  if (new Big(raw.client_sell_amount).lte(0) || new Big(raw.client_buy_amount).lte(0) || new Big(raw.client_rate).lte(0)) {
    throw new ProviderError('malformed_response', { detail: 'Quote has a non-positive amount or rate' });
  }
  if (Number.isNaN(Date.parse(raw.expires_at))) {
    throw new ProviderError('malformed_response', { detail: 'Quote has no usable expiry time' });
  }
  const { base, quote } = splitPair(raw.currency_pair);
  return {
    id: raw.quote_id,
    kind: request.kind,
    sellCurrency,
    buyCurrency,
    sellAmount: raw.client_sell_amount,
    buyAmount: raw.client_buy_amount,
    fixedSide: raw.fixed_side,
    rateBase: base,
    rateQuote: quote,
    rate: raw.client_rate,
    createdAt: raw.created_at,
    expiresAt: raw.expires_at,
    settlementDate: request.kind === 'forward' ? (request.settlementDate ?? null) : null,
  };
}

export function conversionKind(raw: Pick<RawConversion, 'conversion_date' | 'created_at'>): ConversionKind {
  const converts = Date.parse(raw.conversion_date);
  const created = Date.parse(raw.created_at);
  if (Number.isNaN(converts) || Number.isNaN(created)) return 'spot';
  return converts - created > FORWARD_MIN_DAYS * DAY_MS ? 'forward' : 'spot';
}

function conversionStatus(status: string): ConversionStatus {
  if (status === 'trade_settled') return 'settled';
  if (status === 'closed') return 'cancelled';
  return 'pending';
}

export function mapConversion(raw: RawConversion): Conversion {
  const { base, quote } = splitPair(raw.currency_pair);
  return {
    id: raw.id,
    reference: raw.short_reference,
    kind: conversionKind(raw),
    status: conversionStatus(raw.status),
    sellCurrency: raw.sell_currency.toUpperCase(),
    buyCurrency: raw.buy_currency.toUpperCase(),
    sellAmount: raw.client_sell_amount,
    buyAmount: raw.client_buy_amount,
    rateBase: base,
    rateQuote: quote,
    rate: raw.client_rate,
    settlementDate: requireDateOnly(raw.settlement_date, 'settlement_date'),
    createdAt: raw.created_at,
  };
}

/**
 * Drawdown is derived: drawn = buy amount - unallocated_funds, clamped to
 * [0, buy amount]. APPROXIMATE: confirm against real forward data.
 */
export function mapForwardContract(raw: RawConversion): ForwardContract {
  const { base, quote } = splitPair(raw.currency_pair);
  const buy = new Big(raw.client_buy_amount);
  const unallocated = raw.unallocated_funds ? new Big(raw.unallocated_funds) : buy;
  const remaining = unallocated.lt(0) ? new Big(0) : unallocated.gt(buy) ? buy : unallocated;
  return {
    id: raw.id,
    reference: raw.short_reference,
    sellCurrency: raw.sell_currency.toUpperCase(),
    buyCurrency: raw.buy_currency.toUpperCase(),
    sellAmount: raw.client_sell_amount,
    buyAmount: raw.client_buy_amount,
    rateBase: base,
    rateQuote: quote,
    rate: raw.client_rate,
    settlementDate: requireDateOnly(raw.settlement_date, 'settlement_date'),
    drawnAmount: buy.minus(remaining).toFixed(),
    remainingAmount: remaining.toFixed(),
  };
}

/** Open forwards only: forward-dated and neither settled nor closed. */
export function isOpenForward(raw: RawConversion): boolean {
  return conversionKind(raw) === 'forward' && conversionStatus(raw.status) === 'pending';
}

// --- Payees -----------------------------------------------------------------

function routingValue(raw: RawBeneficiary, type: string): string | null {
  if (raw.routing_code_type_1 === type) return emptyToNull(raw.routing_code_value_1);
  if (raw.routing_code_type_2 === type) return emptyToNull(raw.routing_code_value_2);
  return null;
}

export function mapBeneficiary(raw: RawBeneficiary): Beneficiary {
  return {
    id: raw.id,
    name: raw.bank_account_holder_name,
    entityType: raw.beneficiary_entity_type === 'individual' ? 'individual' : 'company',
    currency: raw.currency.toUpperCase(),
    bankCountry: raw.bank_country.toUpperCase(),
    accountNumber: emptyToNull(raw.account_number),
    sortCode: routingValue(raw, 'sort_code'),
    iban: emptyToNull(raw.iban),
    bic: emptyToNull(raw.bic_swift),
    routingNumber: routingValue(raw, 'aba'),
  };
}

/** Form parameters for POST /v2/beneficiaries/create. */
export function toCreateBeneficiaryParams(input: NewBeneficiary): Record<string, string> {
  const params: Record<string, string> = {
    bank_account_holder_name: input.name.trim(),
    bank_country: input.bankCountry.toUpperCase(),
    currency: input.currency.toUpperCase(),
    beneficiary_entity_type: input.entityType,
  };
  if (input.entityType === 'company') params.beneficiary_company_name = input.name.trim();
  if (input.accountNumber) params.account_number = input.accountNumber.replace(/\s+/g, '');
  if (input.iban) params.iban = input.iban.replace(/\s+/g, '').toUpperCase();
  if (input.bic) params.bic_swift = input.bic.trim().toUpperCase();
  if (input.sortCode) {
    params.routing_code_type_1 = 'sort_code';
    params.routing_code_value_1 = input.sortCode.replace(/[\s-]/g, '');
  } else if (input.routingNumber) {
    params.routing_code_type_1 = 'aba';
    params.routing_code_value_1 = input.routingNumber.trim();
  }
  return params;
}

// --- Payments ---------------------------------------------------------------

const PAYMENT_STATUSES: Record<string, PaymentStatus> = {
  awaiting_authorisation: 'awaiting_approval',
  new: 'processing',
  authorised: 'processing',
  ready_to_send: 'processing',
  submitted: 'processing',
  released: 'processing',
  suspended: 'processing',
  completed: 'sent',
  failed: 'failed',
  deleted: 'cancelled',
};

const PAYMENT_ROUTES: Record<string, PaymentRoute> = { regular: 'local', priority: 'swift' };

function mapFee(raw: RawPayment): Money | null {
  const amount = emptyToNull(raw.fee_amount);
  const currency = emptyToNull(raw.fee_currency);
  if (!amount || !currency || !DECIMAL_RE.test(amount) || currency.length !== 3) return null;
  return { amount, currency: currency.toUpperCase() };
}

export function mapPayment(raw: RawPayment, beneficiaryNames: ReadonlyMap<string, string>): Payment {
  return {
    id: raw.id,
    shortReference: raw.short_reference,
    amount: raw.amount,
    currency: raw.currency.toUpperCase(),
    beneficiaryId: raw.beneficiary_id,
    beneficiaryName: beneficiaryNames.get(raw.beneficiary_id) ?? null,
    reference: raw.reference,
    // A status this app does not know is surfaced as 'unknown', never guessed.
    status: PAYMENT_STATUSES[raw.status] ?? 'unknown',
    route: raw.payment_type ? (PAYMENT_ROUTES[raw.payment_type] ?? null) : null,
    fee: mapFee(raw),
    estimatedArrival: toDateOnly(raw.estimated_arrival),
    createdAt: raw.created_at,
  };
}

function stepsRemaining(raw: RawPayment): number {
  const value = Number(raw.authorisation_steps_required ?? 1);
  return Number.isInteger(value) && value > 0 ? value : 1;
}

/**
 * The approval chain is DERIVED: the API only gives the creator and the number
 * of authorisation steps still required, so the chain is "created by X", then
 * "you", then any further approvers. APPROXIMATE.
 */
export function mapPendingApproval(
  raw: RawPayment,
  beneficiaryNames: ReadonlyMap<string, string>,
  creator: RawContact | null,
  beneficiary: Beneficiary | null = null,
): PendingApproval {
  const remaining = stepsRemaining(raw);
  const steps: ApprovalStep[] = [
    {
      label: creator ? `Created by ${contactDisplayName(creator)}` : 'Created',
      status: 'done',
      at: raw.created_at,
    },
    { label: 'Waiting for you', status: 'waiting_for_you', at: null },
  ];
  for (let i = 1; i < remaining; i += 1) {
    steps.push({ label: 'Another approver', status: 'waiting', at: null });
  }
  return { payment: mapPayment(raw, beneficiaryNames), beneficiary, approvalsRemaining: remaining, steps };
}

/** Result of POST /v2/payments/authorise for one payment that was updated. */
export function mapApprovalResult(raw: RawPaymentAuthorisation): ApprovalResult {
  const remaining = Number(raw.auth_steps_required ?? 0);
  return {
    status: PAYMENT_STATUSES[raw.payment_status] ?? 'unknown',
    approvalsRemaining: Number.isInteger(remaining) && remaining > 0 ? remaining : 0,
  };
}
