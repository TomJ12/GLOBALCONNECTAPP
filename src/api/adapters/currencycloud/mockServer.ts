/**
 * In-memory stand-in for the provider's REST API. It speaks the raw wire shapes
 * in raw.ts and keeps state for the life of the JS session: booking a
 * conversion moves balances, approving a payment removes it from the pending
 * list and adds a transaction, and so on.
 *
 * ALL DATA HERE IS SAMPLE DATA. Account numbers are obvious fakes.
 * The mock quotes the sample mid rate with no spread or fee, because Global
 * Connect's pricing is not ours to invent.
 */
import { Big } from 'big.js';

import { currencyDecimals } from '../../../lib/money';
import type { MockControls } from '../../mockControls';
import type { Transport, TransportParams, TransportRequest, TransportResponse } from './transport';

const DAY_MS = 24 * 60 * 60 * 1000;
/** Requests that change something. Used by "writes only" failure injection and "applied late". */
const WRITE_PATHS = [/\/conversions\/create$/, /\/payments\/create$/, /\/payments\/authorise$/, /\/payments\/[^/]+\/delete$/, /\/beneficiaries\/create$/];

/** Sample rates: units of each currency per 1 GBP. */
const UNITS_PER_GBP: Record<string, string> = {
  GBP: '1',
  EUR: '1.1800',
  USD: '1.3000',
  AED: '4.7743',
  JPY: '195.00',
};
/** Earlier currency is the base of the pair, so GBP/USD, GBP/EUR, EUR/USD. */
const PAIR_ORDER = ['GBP', 'EUR', 'USD', 'AED', 'JPY'];

/** Basis-point offsets used to draw a sample rate history. Ends on 0 = the current sample rate. */
const HISTORY_OFFSETS_BPS = [-38, -30, -34, -22, -27, -15, -19, -8, -12, 3, -4, 9, 14, 6, 18, 11, 22, 15, 9, 13, 5, 8, 2, 0];

interface Contact {
  id: string;
  first_name: string;
  last_name: string;
  email_address: string;
}

interface BalanceRow {
  id: string;
  currency: string;
  amount: Big;
  created_at: string;
  updated_at: string;
}

type Json = Record<string, unknown>;

interface StoredQuote {
  body: Json;
  expiresAtMs: number;
  conversionDate: string | null;
  used: boolean;
}

interface State {
  account: { id: string; account_name: string };
  me: Contact;
  contacts: Map<string, Contact>;
  balances: Map<string, BalanceRow>;
  fundingAccounts: Json[];
  beneficiaries: Json[];
  payments: Json[];
  conversions: Json[];
  transactions: Json[];
  quotes: Map<string, StoredQuote>;
  tokens: Set<string>;
  idempotentPayments: Map<string, Json>;
  idempotentConversions: Map<string, Json>;
  counter: number;
}

export interface MockServerOptions {
  getControls: () => MockControls;
  now?: () => number;
  random?: () => number;
  /** Put into every id this instance generates, so several instances never produce the same id. */
  idNamespace?: string;
}

function one(params: TransportParams | undefined, key: string): string | undefined {
  const value = params?.[key];
  return Array.isArray(value) ? value[0] : value;
}

function many(params: TransportParams | undefined, key: string): string[] {
  const value = params?.[key];
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function isDecimal(value: string | undefined): value is string {
  return value !== undefined && /^\d+(\.\d+)?$/.test(value);
}

function ok(body: unknown): TransportResponse {
  return { status: 200, body: JSON.stringify(body) };
}

function fail(status: number, errorCode: string, field: string, code: string, message: string): TransportResponse {
  return {
    status,
    body: JSON.stringify({
      error_code: errorCode,
      error_messages: { [field]: [{ code, message, params: {} }] },
    }),
  };
}

function contactSlug(email: string): string {
  return email.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
}

function pairFor(a: string, b: string): { base: string; quote: string } {
  return PAIR_ORDER.indexOf(a) <= PAIR_ORDER.indexOf(b) ? { base: a, quote: b } : { base: b, quote: a };
}

function rateFor(base: string, quote: string): Big {
  const perGbpQuote = UNITS_PER_GBP[quote];
  const perGbpBase = UNITS_PER_GBP[base];
  if (!perGbpQuote || !perGbpBase) throw new Error('unsupported currency');
  return new Big(perGbpQuote).div(new Big(perGbpBase)).round(4, Big.roundHalfUp);
}

function supported(currency: string | undefined): currency is string {
  return currency !== undefined && UNITS_PER_GBP[currency] !== undefined;
}

function money(value: Big, currency: string): string {
  return value.round(currencyDecimals(currency), Big.roundHalfUp).toFixed(currencyDecimals(currency));
}

export class MockCurrencycloudServer implements Transport {
  private readonly getControls: () => MockControls;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly idNamespace: string;
  private state: State;

  constructor(options: MockServerOptions) {
    this.idNamespace = options.idNamespace ?? '';
    this.getControls = options.getControls;
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
    this.state = this.seed();
  }

  /** Throw away all changes and go back to the sample data. Existing sessions stay valid. */
  reset(): void {
    const tokens = this.state.tokens;
    this.state = this.seed();
    this.state.tokens = tokens;
  }

  async request(request: TransportRequest): Promise<TransportResponse> {
    const controls = this.getControls();
    if (controls.latencyMs > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, controls.latencyMs));
    } else {
      await Promise.resolve();
    }

    if (controls.hang) {
      // Never answers. The client's own timeout has to end the wait.
      return new Promise<TransportResponse>(() => undefined);
    }
    if (controls.offline) throw new TypeError('Network request failed');
    const isWrite = WRITE_PATHS.some((pattern) => pattern.test(request.path));
    // "Writes only" leaves reads working, so a reconciliation check is not failed by the same switch.
    const forced = controls.failWritesOnly && !isWrite ? 'none' : controls.forcedError;
    if (forced === 'network') throw new TypeError('Network request failed');
    if (forced === 'applied_late' && isWrite) {
      // The caller gives up now; the request still lands later.
      setTimeout(() => this.route(request), controls.lateApplyMs);
      throw new TypeError('Network request failed');
    }
    switch (forced) {
      case 'forbidden':
        return fail(403, 'permission_denied', 'base', 'permission_denied', 'You do not have permission to perform this action');
      case 'unauthorized':
        return fail(401, 'auth_failed', 'username', 'invalid_supplied_credentials', 'Authentication failed with the supplied credentials');
      case 'rate_limited':
        return fail(429, 'too_many_requests', 'base', 'too_many_requests', 'Too many requests have been made to the api. Please refer to the Developer Center for more information');
      case 'server':
        return { status: 500, body: JSON.stringify({ error_code: 'internal_server_error', error_messages: {} }) };
      case 'malformed':
        return { status: 200, body: '{"balances": [{"id": "trunc' };
      case 'wrong_shape':
        return ok({ unexpected: true, amount: 12.5, balances: 'not-a-list' });
      case 'lost_response':
        // The request is applied, then the connection drops before the reply arrives.
        this.route(request);
        throw new TypeError('Network request failed');
      default:
        break;
    }
    if (controls.failureRate > 0 && this.random() < controls.failureRate) {
      if (this.random() < 0.5) throw new TypeError('Network request failed');
      return { status: 500, body: JSON.stringify({ error_code: 'internal_server_error', error_messages: {} }) };
    }

    return this.route(request);
  }

  // --- Routing --------------------------------------------------------------

  private route(request: TransportRequest): TransportResponse {
    const { method, path, params } = request;
    const key = `${method} ${path}`;

    if (key === 'POST /v2/authenticate/api') return this.authenticate(params);

    if (!request.token || !this.state.tokens.has(request.token)) {
      return fail(401, 'auth_failed', 'username', 'invalid_supplied_credentials', 'Authentication failed with the supplied credentials');
    }

    if (key === 'POST /v2/authenticate/close_session') {
      this.state.tokens.delete(request.token);
      return ok({});
    }
    if (key === 'GET /v2/accounts/current') return ok(this.accountBody());
    if (key === 'GET /v2/balances/find') return this.findBalances();
    if (key === 'GET /v2/funding_accounts/find') return this.findFundingAccounts(params);
    if (key === 'GET /v2/transactions/find') return this.paginate('transactions', this.state.transactions, params);
    if (key === 'GET /v2/rates/find') return this.findRates(params);
    if (key === 'GET /v2/rates/history') return this.rateHistory(params);
    if (key === 'POST /v2/quotes/create') return this.createQuote(params);
    if (key === 'POST /v2/conversions/create') return this.createConversion(params);
    if (key === 'GET /v2/conversions/find') {
      const wanted = one(params, 'unique_request_id');
      const rows = wanted ? this.state.conversions.filter((row) => row.unique_request_id === wanted) : this.state.conversions;
      return this.paginate('conversions', rows, params);
    }
    if (key === 'POST /v2/beneficiaries/find') return this.paginate('beneficiaries', this.state.beneficiaries, params);
    if (key === 'POST /v2/beneficiaries/create') return this.createBeneficiary(params);
    if (key === 'GET /v2/payments/find') return this.findPayments(params);
    if (key === 'POST /v2/payments/create') return this.createPayment(params);
    if (key === 'POST /v2/payments/authorise') return this.authorisePayments(params);

    const beneficiaryMatch = /^\/v2\/beneficiaries\/([^/]+)$/.exec(path);
    if (method === 'GET' && beneficiaryMatch) {
      const beneficiary = this.state.beneficiaries.find((row) => row.id === beneficiaryMatch[1]);
      return beneficiary ? ok(beneficiary) : this.notFound();
    }
    const contactMatch = /^\/v2\/contacts\/([^/]+)$/.exec(path);
    if (method === 'GET' && contactMatch) {
      const contact = this.state.contacts.get(contactMatch[1] ?? '');
      return contact ? ok(this.contactBody(contact)) : this.notFound();
    }
    const deleteMatch = /^\/v2\/payments\/([^/]+)\/delete$/.exec(path);
    if (method === 'POST' && deleteMatch) return this.deletePayment(deleteMatch[1] ?? '');

    return this.notFound();
  }

  private notFound(): TransportResponse {
    return fail(404, 'not_found', 'id', 'not_found', 'Resource not found');
  }

  // --- Helpers --------------------------------------------------------------

  private iso(offsetMs = 0): string {
    return new Date(this.now() + offsetMs).toISOString();
  }

  private nextId(prefix: string): string {
    this.state.counter += 1;
    return `sample-${this.idNamespace}${prefix}-${this.state.counter.toString().padStart(4, '0')}`;
  }

  private shortReference(): string {
    const date = new Date(this.now()).toISOString().slice(2, 10).replace(/-/g, '');
    this.state.counter += 1;
    return `${date}-SMPL${this.state.counter.toString().padStart(3, '0')}`;
  }

  private accountBody(): Json {
    return { ...this.state.account, brand: 'sample', status: 'enabled', country: 'GB' };
  }

  private contactBody(contact: Contact): Json {
    return { ...contact, account_id: this.state.account.id, status: 'enabled' };
  }

  private balanceBody(row: BalanceRow): Json {
    return {
      id: row.id,
      account_id: this.state.account.id,
      currency: row.currency,
      amount: money(row.amount, row.currency),
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }

  private balanceRow(currency: string): BalanceRow {
    let row = this.state.balances.get(currency);
    if (!row) {
      row = { id: this.nextId('balance'), currency, amount: new Big(0), created_at: this.iso(), updated_at: this.iso() };
      this.state.balances.set(currency, row);
    }
    return row;
  }

  private postTransaction(input: {
    currency: string;
    amount: Big;
    type: 'credit' | 'debit';
    action: string;
    relatedType: string;
    relatedId: string;
    relatedReference: string;
    reason: string;
    status: 'completed' | 'pending';
  }): void {
    const row = this.balanceRow(input.currency);
    row.amount = input.type === 'credit' ? row.amount.plus(input.amount) : row.amount.minus(input.amount);
    row.updated_at = this.iso();
    this.state.transactions.unshift({
      id: this.nextId('txn'),
      balance_id: row.id,
      account_id: this.state.account.id,
      currency: input.currency,
      amount: money(input.amount, input.currency),
      balance_amount: money(row.amount, input.currency),
      type: input.type,
      action: input.action,
      related_entity_type: input.relatedType,
      related_entity_id: input.relatedId,
      related_entity_short_reference: input.relatedReference,
      status: input.status,
      reason: input.reason,
      settles_at: this.iso(),
      created_at: this.iso(),
      updated_at: this.iso(),
      completed_at: input.status === 'completed' ? this.iso() : null,
    });
  }

  private paginate(key: string, rows: Json[], params: TransportParams | undefined): TransportResponse {
    const perPage = Math.min(100, Math.max(1, Number(one(params, 'per_page') ?? 25) || 25));
    const totalPages = Math.max(1, Math.ceil(rows.length / perPage));
    const page = Math.min(totalPages, Math.max(1, Number(one(params, 'page') ?? 1) || 1));
    const start = (page - 1) * perPage;
    return ok({
      [key]: rows.slice(start, start + perPage),
      pagination: {
        total_entries: rows.length,
        total_pages: totalPages,
        current_page: page,
        per_page: perPage,
        previous_page: page > 1 ? page - 1 : -1,
        next_page: page < totalPages ? page + 1 : -1,
        order: one(params, 'order') ?? 'created_at',
        order_asc_desc: one(params, 'order_asc_desc') ?? 'desc',
      },
    });
  }

  // --- API login ------------------------------------------------------------

  /** The mock accepts any non-empty login_id and api_key. `login_id` is treated as the contact's email. */
  private authenticate(params: TransportParams | undefined): TransportResponse {
    const loginId = (one(params, 'login_id') ?? '').trim().toLowerCase();
    if (loginId === '' || (one(params, 'api_key') ?? '') === '') {
      return fail(401, 'auth_failed', 'username', 'invalid_supplied_credentials', 'Authentication failed with the supplied credentials');
    }
    const token = this.nextId('token');
    this.state.tokens.add(token);
    // Each login is its own contact, so two people on one device never share an identity.
    this.state.me = { ...this.state.me, id: `sample-contact-${contactSlug(loginId)}`, email_address: loginId };
    this.state.contacts.set(this.state.me.id, this.state.me);
    return ok({ auth_token: token });
  }

  // --- Balances, accounts, rates ---------------------------------------------

  private findBalances(): TransportResponse {
    const rows = [...this.state.balances.values()].map((row) => this.balanceBody(row));
    return this.paginate('balances', rows, { per_page: '100', order_asc_desc: 'asc' });
  }

  private findFundingAccounts(params: TransportParams | undefined): TransportResponse {
    const currency = one(params, 'currency')?.toUpperCase();
    if (!currency) {
      return fail(400, 'funding_accounts_find_failed', 'currency', 'currency_is_required', 'currency is required');
    }
    const rows = this.state.fundingAccounts.filter((account) => account.currency === currency);
    return this.paginate('funding_accounts', rows, params);
  }

  private findRates(params: TransportParams | undefined): TransportResponse {
    const pairs = (one(params, 'currency_pair') ?? '').toUpperCase().split(',').filter(Boolean);
    if (pairs.length === 0) {
      return fail(400, 'rates_find_failed', 'currency_pair', 'currency_pair_is_required', 'currency_pair is required');
    }
    const rates: Record<string, [string, string]> = {};
    const unavailable: string[] = [];
    for (const pair of pairs) {
      const base = pair.slice(0, 3);
      const quote = pair.slice(3, 6);
      if (pair.length !== 6 || !supported(base) || !supported(quote) || base === quote) {
        unavailable.push(pair);
        continue;
      }
      // Sample data: bid and offer are both the sample mid rate (no spread invented).
      const rate = this.rateBetween(base, quote).toFixed(4);
      rates[pair] = [rate, rate];
    }
    return ok({ rates, unavailable });
  }

  /** Rate for any orientation; the inverse of a convention pair is derived, not stored. */
  private rateBetween(base: string, quote: string): Big {
    const convention = pairFor(base, quote);
    if (convention.base === base) return rateFor(base, quote);
    return new Big(UNITS_PER_GBP[quote] ?? '1').div(new Big(UNITS_PER_GBP[base] ?? '1')).round(6, Big.roundHalfUp);
  }

  private rateHistory(params: TransportParams | undefined): TransportResponse {
    const pair = (one(params, 'currency_pair') ?? '').toUpperCase();
    const base = pair.slice(0, 3);
    const quote = pair.slice(3, 6);
    if (pair.length !== 6 || !supported(base) || !supported(quote) || base === quote) return this.notFound();
    const current = this.rateBetween(base, quote);
    const shift = (pair.charCodeAt(1) + pair.charCodeAt(4)) % 7;
    const count = HISTORY_OFFSETS_BPS.length;
    const points = HISTORY_OFFSETS_BPS.map((_, index) => {
      const isLast = index === count - 1;
      const offset = isLast ? 0 : (HISTORY_OFFSETS_BPS[(index + shift) % (count - 1)] ?? 0);
      const rate = current.times(new Big(10000 + offset)).div(10000).round(4, Big.roundHalfUp);
      return { at: this.iso(-(count - 1 - index) * 60 * 60 * 1000), rate: rate.toFixed(4) };
    });
    return ok({ currency_pair: pair, points });
  }

  // --- Quotes and conversions -------------------------------------------------

  private createQuote(params: TransportParams | undefined): TransportResponse {
    const buy = one(params, 'buy_currency')?.toUpperCase();
    const sell = one(params, 'sell_currency')?.toUpperCase();
    const fixedSide = one(params, 'fixed_side');
    const amount = one(params, 'amount');
    const conversionDate = one(params, 'conversion_date') ?? null;
    const bad = (field: string, code: string) => fail(400, 'quote_create_failed', field, code, `${field} is invalid`);

    if (!supported(buy)) return bad('buy_currency', 'buy_currency_is_in_invalid_format');
    if (!supported(sell)) return bad('sell_currency', 'sell_currency_is_in_invalid_format');
    if (buy === sell) return bad('sell_currency', 'sell_currency_must_differ_from_buy_currency');
    if (fixedSide !== 'buy' && fixedSide !== 'sell') return bad('fixed_side', 'fixed_side_not_in_range');
    if (!isDecimal(amount) || new Big(amount).lte(0)) return bad('amount', 'amount_type_is_wrong');
    if (conversionDate !== null) {
      const when = Date.parse(conversionDate);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(conversionDate) || Number.isNaN(when) || when <= this.now()) {
        return bad('conversion_date', 'conversion_date_is_in_invalid_format');
      }
    }

    const { base, quote } = pairFor(buy, sell);
    const rate = rateFor(base, quote);
    const fixed = new Big(amount);
    let sellAmount: Big;
    let buyAmount: Big;
    if (fixedSide === 'sell') {
      sellAmount = fixed;
      buyAmount = sell === base ? fixed.times(rate) : fixed.div(rate);
    } else {
      buyAmount = fixed;
      sellAmount = buy === base ? fixed.times(rate) : fixed.div(rate);
    }
    if (new Big(money(sellAmount, sell)).lte(0) || new Big(money(buyAmount, buy)).lte(0)) {
      return bad('amount', 'amount_is_too_small');
    }

    // Forget quotes that expired a while ago so the map cannot grow without bound.
    for (const [id, old] of this.state.quotes) {
      if (old.expiresAtMs < this.now() - 5 * 60 * 1000) this.state.quotes.delete(id);
    }
    const quoteId = this.nextId('quote');
    const expiresAtMs = this.now() + this.getControls().quoteTtlSeconds * 1000;
    const body: Json = {
      quote_id: quoteId,
      buy_currency: buy,
      sell_currency: sell,
      client_buy_amount: money(buyAmount, buy),
      client_sell_amount: money(sellAmount, sell),
      partner_buy_amount: money(buyAmount, buy),
      partner_sell_amount: money(sellAmount, sell),
      client_rate: rate.toFixed(4),
      partner_rate: rate.toFixed(4),
      core_rate: rate.toFixed(4),
      mid_market_rate: rate.toFixed(4),
      currency_pair: `${base}${quote}`,
      fixed_side: fixedSide,
      deposit_required: false,
      deposit_amount: '0.0',
      deposit_currency: sell,
      created_at: this.iso(),
      expires_at: new Date(expiresAtMs).toISOString(),
      settlement_cut_off_time: conversionDate ? `${conversionDate}T15:30:00.000Z` : this.iso(),
    };
    this.state.quotes.set(quoteId, { body, expiresAtMs, conversionDate, used: false });
    return ok(body);
  }

  private createConversion(params: TransportParams | undefined): TransportResponse {
    const bad = (field: string, code: string) => fail(400, 'conversion_create_failed', field, code, `${field} is invalid`);
    const uniqueRequestId = one(params, 'unique_request_id');
    if (uniqueRequestId) {
      const existing = this.state.idempotentConversions.get(uniqueRequestId);
      if (existing) return ok(existing);
    }
    if (one(params, 'term_agreement') !== 'true') return bad('term_agreement', 'term_agreement_is_required');

    const quoteId = one(params, 'quote_id');
    const stored = quoteId ? this.state.quotes.get(quoteId) : undefined;
    // The mock only books against a held quote.
    if (!stored || stored.used) return bad('quote_id', 'quote_id_is_invalid');
    // "quote_expired" and "insufficient_funds" are the mock's own codes (see mapping.ts).
    if (stored.expiresAtMs <= this.now()) return bad('quote_id', 'quote_expired');

    const quote = stored.body as Record<string, string>;
    if (
      one(params, 'buy_currency')?.toUpperCase() !== quote.buy_currency ||
      one(params, 'sell_currency')?.toUpperCase() !== quote.sell_currency
    ) {
      return bad('quote_id', 'quote_does_not_match_request');
    }
    const buy = quote.buy_currency ?? '';
    const sell = quote.sell_currency ?? '';
    const buyAmount = new Big(quote.client_buy_amount ?? '0');
    const sellAmount = new Big(quote.client_sell_amount ?? '0');
    const isForward = stored.conversionDate !== null;

    if (!isForward && this.balanceRow(sell).amount.lt(sellAmount)) {
      return bad('amount', 'insufficient_funds');
    }

    stored.used = true;
    const id = this.nextId('conversion');
    const reference = this.shortReference();
    const settles = isForward ? `${stored.conversionDate}T15:30:00.000Z` : this.iso();
    const conversion: Json = {
      id,
      account_id: this.state.account.id,
      creator_contact_id: this.state.me.id,
      short_reference: reference,
      settlement_date: settles,
      conversion_date: settles,
      status: isForward ? 'awaiting_funds' : 'trade_settled',
      currency_pair: quote.currency_pair,
      buy_currency: buy,
      sell_currency: sell,
      fixed_side: quote.fixed_side,
      partner_buy_amount: quote.client_buy_amount,
      partner_sell_amount: quote.client_sell_amount,
      client_buy_amount: quote.client_buy_amount,
      client_sell_amount: quote.client_sell_amount,
      mid_market_rate: quote.client_rate,
      core_rate: quote.client_rate,
      partner_rate: quote.client_rate,
      client_rate: quote.client_rate,
      deposit_required: false,
      deposit_amount: '0.00',
      deposit_currency: sell,
      deposit_status: 'not_required',
      deposit_required_at: '',
      unallocated_funds: quote.client_buy_amount,
      payment_ids: [],
      unique_request_id: uniqueRequestId ?? '',
      created_at: this.iso(),
      updated_at: this.iso(),
    };
    this.state.conversions.unshift(conversion);
    if (uniqueRequestId) this.state.idempotentConversions.set(uniqueRequestId, conversion);

    if (!isForward) {
      const common = { action: 'conversion', relatedType: 'conversion', relatedId: id, relatedReference: reference, status: 'completed' as const };
      this.postTransaction({ ...common, currency: sell, amount: sellAmount, type: 'debit', reason: `Converted ${sell} to ${buy}` });
      this.postTransaction({ ...common, currency: buy, amount: buyAmount, type: 'credit', reason: `Converted ${sell} to ${buy}` });
    }
    return ok(conversion);
  }

  // --- Beneficiaries ----------------------------------------------------------

  private createBeneficiary(params: TransportParams | undefined): TransportResponse {
    const bad = (field: string) => fail(400, 'beneficiary_create_failed', field, `${field}_is_required`, `${field} is required`);
    const name = (one(params, 'bank_account_holder_name') ?? '').trim();
    const bankCountry = (one(params, 'bank_country') ?? '').toUpperCase();
    const currency = (one(params, 'currency') ?? '').toUpperCase();
    if (name === '') return bad('bank_account_holder_name');
    if (!/^[A-Z]{2}$/.test(bankCountry)) return bad('bank_country');
    if (!/^[A-Z]{3}$/.test(currency)) return bad('currency');
    const iban = one(params, 'iban') ?? '';
    const accountNumber = one(params, 'account_number') ?? '';
    if (iban === '' && accountNumber === '') return bad('account_number');

    const isLocal =
      (bankCountry === 'GB' && currency === 'GBP') ||
      (bankCountry === 'US' && currency === 'USD') ||
      (currency === 'EUR' && iban !== '');
    const beneficiary: Json = {
      id: this.nextId('beneficiary'),
      bank_account_holder_name: name,
      name,
      email: '',
      payment_types: [isLocal ? 'regular' : 'priority'],
      beneficiary_address: [],
      beneficiary_country: bankCountry,
      beneficiary_entity_type: one(params, 'beneficiary_entity_type') === 'individual' ? 'individual' : 'company',
      beneficiary_company_name: one(params, 'beneficiary_company_name') ?? '',
      beneficiary_first_name: '',
      beneficiary_last_name: '',
      bank_country: bankCountry,
      bank_name: '',
      currency,
      account_number: accountNumber,
      routing_code_type_1: one(params, 'routing_code_type_1') ?? '',
      routing_code_value_1: one(params, 'routing_code_value_1') ?? '',
      routing_code_type_2: '',
      routing_code_value_2: '',
      bic_swift: one(params, 'bic_swift') ?? '',
      iban,
      default_beneficiary: 'false',
      creator_contact_id: this.state.me.id,
      bank_address: [],
      created_at: this.iso(),
      updated_at: this.iso(),
    };
    this.state.beneficiaries.unshift(beneficiary);
    return ok(beneficiary);
  }

  // --- Payments ---------------------------------------------------------------

  private findPayments(params: TransportParams | undefined): TransportResponse {
    const status = one(params, 'status');
    const wanted = one(params, 'unique_request_id');
    const rows = this.state.payments.filter(
      (payment) =>
        (status ? payment.status === status : payment.status !== 'deleted') &&
        (wanted ? payment.unique_request_id === wanted : true),
    );
    return this.paginate('payments', rows, params);
  }

  private createPayment(params: TransportParams | undefined): TransportResponse {
    const bad = (field: string, code: string) => fail(400, 'payment_create_failed', field, code, `${field} is invalid`);
    const uniqueRequestId = one(params, 'unique_request_id');
    if (!uniqueRequestId) return bad('unique_request_id', 'unique_request_id_is_required');
    const existing = this.state.idempotentPayments.get(uniqueRequestId);
    if (existing) return ok(existing);

    const currency = (one(params, 'currency') ?? '').toUpperCase();
    const amount = one(params, 'amount');
    const reference = (one(params, 'reference') ?? '').trim();
    const reason = (one(params, 'reason') ?? '').trim();
    const beneficiary = this.state.beneficiaries.find((row) => row.id === one(params, 'beneficiary_id'));
    if (!beneficiary) return bad('beneficiary_id', 'beneficiary_id_is_not_valid_uuid');
    if (beneficiary.currency !== currency) return bad('currency', 'currency_does_not_match_beneficiary');
    if (!isDecimal(amount) || new Big(amount).lte(0)) return bad('amount', 'amount_type_is_wrong');
    if (reference === '') return bad('reference', 'reference_is_required');
    if (reason === '') return bad('reason', 'reason_is_required');
    const value = new Big(amount);
    if (this.balanceRow(currency).amount.lt(value)) return bad('amount', 'insufficient_funds');

    const paymentTypes = beneficiary.payment_types as string[];
    const payment = this.paymentBody({
      beneficiaryId: beneficiary.id as string,
      currency,
      amount: value,
      reference,
      reason,
      status: 'ready_to_send',
      paymentType: paymentTypes[0] ?? 'priority',
      creatorId: this.state.me.id,
      stepsRequired: '0',
      createdAt: this.iso(),
      uniqueRequestId,
    });
    this.state.payments.unshift(payment);
    this.state.idempotentPayments.set(uniqueRequestId, payment);
    this.postTransaction({
      currency,
      amount: value,
      type: 'debit',
      action: 'payment',
      relatedType: 'payment',
      relatedId: payment.id as string,
      relatedReference: payment.short_reference as string,
      reason: `Payment to ${beneficiary.bank_account_holder_name as string}`,
      status: 'pending',
    });
    return ok(payment);
  }

  private authorisePayments(params: TransportParams | undefined): TransportResponse {
    const ids = many(params, 'payment_ids[]');
    if (ids.length === 0) {
      return fail(400, 'payment_authorisation_failed', 'payment_ids', 'payment_ids_is_required', 'payment_ids is required');
    }
    const authorisations = ids.map((id) => {
      const payment = this.state.payments.find((row) => row.id === id);
      const result = (updated: boolean, error: string | null) => ({
        payment_id: id,
        payment_status: (payment?.status as string | undefined) ?? 'unknown',
        updated,
        error,
        auth_steps_taken: updated ? 1 : 0,
        auth_steps_required: Number(payment?.authorisation_steps_required ?? 0),
        short_reference: (payment?.short_reference as string | undefined) ?? '',
      });
      if (!payment) return result(false, 'payment_not_found');
      if (payment.status !== 'awaiting_authorisation') return result(false, 'payment_not_awaiting_authorisation');
      const currency = payment.currency as string;
      const amount = new Big(payment.amount as string);
      if (this.balanceRow(currency).amount.lt(amount)) return result(false, 'insufficient_funds');

      const stepsLeft = Math.max(0, Number(payment.authorisation_steps_required ?? 1) - 1);
      payment.authorisation_steps_required = String(stepsLeft);
      payment.last_updater_contact_id = this.state.me.id;
      payment.updated_at = this.iso();
      // More approvers to go: nothing is sent yet.
      if (stepsLeft > 0) return result(true, null);
      payment.status = 'ready_to_send';
      const beneficiary = this.state.beneficiaries.find((row) => row.id === payment.beneficiary_id);
      this.postTransaction({
        currency,
        amount,
        type: 'debit',
        action: 'payment',
        relatedType: 'payment',
        relatedId: id,
        relatedReference: payment.short_reference as string,
        reason: `Payment to ${(beneficiary?.bank_account_holder_name as string | undefined) ?? 'payee'}`,
        status: 'pending',
      });
      return result(true, null);
    });
    return ok({ authorisations });
  }

  private deletePayment(id: string): TransportResponse {
    const payment = this.state.payments.find((row) => row.id === id);
    if (!payment || payment.status === 'deleted') return this.notFound();
    if (payment.status !== 'awaiting_authorisation') {
      return fail(400, 'payment_delete_failed', 'id', 'payment_cannot_be_deleted', 'payment cannot be deleted');
    }
    payment.status = 'deleted';
    payment.updated_at = this.iso();
    return ok(payment);
  }

  private paymentBody(input: {
    beneficiaryId: string;
    currency: string;
    amount: Big;
    reference: string;
    reason: string;
    status: string;
    paymentType: string;
    creatorId: string;
    stepsRequired: string;
    createdAt: string;
    uniqueRequestId?: string;
  }): Json {
    return {
      id: this.nextId('payment'),
      short_reference: this.shortReference(),
      beneficiary_id: input.beneficiaryId,
      conversion_id: '',
      amount: money(input.amount, input.currency),
      currency: input.currency,
      status: input.status,
      payment_type: input.paymentType,
      reference: input.reference,
      reason: input.reason,
      // Left empty on purpose: fees and arrival times are not ours to invent.
      estimated_arrival: '',
      fee_amount: '',
      fee_currency: '',
      payment_date: input.createdAt,
      transferred_at: '',
      authorisation_steps_required: input.stepsRequired,
      creator_contact_id: input.creatorId,
      last_updater_contact_id: input.creatorId,
      failure_reason: '',
      payer_id: '',
      unique_request_id: input.uniqueRequestId ?? '',
      created_at: input.createdAt,
      updated_at: input.createdAt,
    };
  }

  // --- Seed data (all sample) -------------------------------------------------

  private seed(): State {
    const createdAt = this.iso(-400 * DAY_MS);
    const me: Contact = { id: 'sample-contact-you', first_name: 'Sample', last_name: 'User', email_address: 'sample.user@example.com' };
    const accountsTeam: Contact = { id: 'sample-contact-accounts', first_name: 'Accounts', last_name: 'team', email_address: 'accounts@example.com' };

    this.state = {
      account: { id: 'sample-account-0001', account_name: 'Northfield Trading Ltd' },
      me,
      contacts: new Map([
        [me.id, me],
        [accountsTeam.id, accountsTeam],
      ]),
      balances: new Map(),
      fundingAccounts: [],
      beneficiaries: [],
      payments: [],
      conversions: [],
      transactions: [],
      quotes: new Map(),
      tokens: new Set(),
      idempotentPayments: new Map(),
      idempotentConversions: new Map(),
      counter: 0,
    };
    const state = this.state;

    for (const [currency, amount] of [['GBP', '101964.00'], ['USD', '57891.00'], ['EUR', '24310.50']] as const) {
      state.balances.set(currency, {
        id: `sample-balance-${currency.toLowerCase()}`,
        currency,
        amount: new Big(amount),
        created_at: createdAt,
        updated_at: this.iso(),
      });
    }

    // Funding accounts. Every number below is an obvious fake.
    const funding = (currency: string, numberType: string, number: string, routingType: string, routing: string, paymentType: string): Json => ({
      id: this.nextId('funding'),
      account_id: state.account.id,
      account_number: number,
      account_number_type: numberType,
      account_holder_name: state.account.account_name,
      bank_name: '[ACCOUNT PROVIDER NAME]',
      bank_address: '[ACCOUNT PROVIDER ADDRESS]',
      bank_country: 'GB',
      currency,
      payment_type: paymentType,
      routing_code: routing,
      routing_code_type: routingType,
      created_at: createdAt,
      updated_at: createdAt,
    });
    state.fundingAccounts = [
      funding('GBP', 'account_number', '00000000', 'sort_code', '000000', 'regular'),
      funding('GBP', 'iban', 'GB00SMPL00000000000000', 'bic_swift', 'SMPLGB00', 'priority'),
      funding('USD', 'iban', 'GB00SMPL00000000000001', 'bic_swift', 'SMPLGB00', 'priority'),
      funding('EUR', 'iban', 'GB00SMPL00000000000002', 'bic_swift', 'SMPLGB00', 'regular'),
    ];

    const beneficiary = (id: string, name: string, currency: string, country: string, extra: Json, paymentType: string): Json => ({
      id,
      bank_account_holder_name: name,
      name,
      email: '',
      payment_types: [paymentType],
      beneficiary_address: [],
      beneficiary_country: country,
      beneficiary_entity_type: 'company',
      beneficiary_company_name: name,
      beneficiary_first_name: '',
      beneficiary_last_name: '',
      bank_country: country,
      bank_name: '',
      currency,
      account_number: '',
      routing_code_type_1: '',
      routing_code_value_1: '',
      routing_code_type_2: '',
      routing_code_value_2: '',
      bic_swift: '',
      iban: '',
      default_beneficiary: 'false',
      creator_contact_id: accountsTeam.id,
      bank_address: [],
      created_at: createdAt,
      updated_at: createdAt,
      ...extra,
    });
    state.beneficiaries = [
      beneficiary('sample-beneficiary-brightway', 'Brightway Electronics Co.', 'USD', 'HK', { account_number: '000000004471', bic_swift: 'SMPLHKHH' }, 'priority'),
      // DE89 3704 0044 0532 0130 00 is the standard documentation example IBAN, not a real account.
      beneficiary('sample-beneficiary-meridian', 'Meridian Logistics GmbH', 'EUR', 'DE', { iban: 'DE89370400440532013000', bic_swift: 'SMPLDEFF' }, 'regular'),
      beneficiary('sample-beneficiary-harbour', 'Harbour Print Ltd', 'GBP', 'GB', { account_number: '00000000', routing_code_type_1: 'sort_code', routing_code_value_1: '000000' }, 'regular'),
    ];

    // The payment waiting for approval.
    state.payments.push(
      this.paymentBody({
        beneficiaryId: 'sample-beneficiary-brightway',
        currency: 'USD',
        amount: new Big('18400.00'),
        reference: 'INV-2291',
        reason: 'Supplier invoice',
        status: 'awaiting_authorisation',
        paymentType: 'priority',
        creatorId: accountsTeam.id,
        stepsRequired: '1',
        createdAt: this.iso(-3 * 60 * 60 * 1000),
      }),
    );

    // Earlier payments and other activity, newest first.
    const history: [daysAgo: number, currency: string, type: 'credit' | 'debit', action: string, amount: string, reason: string, beneficiaryId?: string, reference?: string][] = [
      [0, 'GBP', 'credit', 'funding', '42733.00', 'Customer payment'],
      [1, 'USD', 'debit', 'payment', '24557.00', 'Supplier payment', 'sample-beneficiary-brightway', 'INV-2284'],
      [2, 'EUR', 'debit', 'payment', '3120.00', 'Payment to Meridian Logistics GmbH', 'sample-beneficiary-meridian', 'ML-10442'],
      [3, 'GBP', 'credit', 'funding', '8650.00', 'Customer payment'],
      [4, 'GBP', 'debit', 'payment', '1284.60', 'Payment to Harbour Print Ltd', 'sample-beneficiary-harbour', 'HP-7781'],
      [5, 'USD', 'credit', 'funding', '31200.00', 'Customer payment'],
      [6, 'EUR', 'credit', 'funding', '12400.00', 'Customer payment'],
      [8, 'GBP', 'credit', 'funding', '15980.00', 'Customer payment'],
      [9, 'USD', 'debit', 'payment', '9870.00', 'Supplier payment', 'sample-beneficiary-brightway', 'INV-2270'],
      [10, 'EUR', 'debit', 'payment', '2240.50', 'Payment to Meridian Logistics GmbH', 'sample-beneficiary-meridian', 'ML-10391'],
      [12, 'GBP', 'credit', 'funding', '22310.00', 'Customer payment'],
      [13, 'GBP', 'debit', 'payment', '640.00', 'Payment to Harbour Print Ltd', 'sample-beneficiary-harbour', 'HP-7702'],
      [15, 'USD', 'credit', 'funding', '18450.00', 'Customer payment'],
      [16, 'EUR', 'credit', 'funding', '7300.00', 'Customer payment'],
      [18, 'USD', 'debit', 'payment', '12300.00', 'Supplier payment', 'sample-beneficiary-brightway', 'INV-2251'],
      [19, 'GBP', 'credit', 'funding', '9120.00', 'Customer payment'],
      [21, 'EUR', 'debit', 'payment', '4875.00', 'Payment to Meridian Logistics GmbH', 'sample-beneficiary-meridian', 'ML-10317'],
      [22, 'GBP', 'credit', 'funding', '30500.00', 'Customer payment'],
      [24, 'USD', 'credit', 'funding', '26000.00', 'Customer payment'],
      [25, 'GBP', 'debit', 'payment', '2150.00', 'Payment to Harbour Print Ltd', 'sample-beneficiary-harbour', 'HP-7655'],
      [27, 'EUR', 'credit', 'funding', '9950.00', 'Customer payment'],
      [28, 'USD', 'debit', 'payment', '15640.00', 'Supplier payment', 'sample-beneficiary-brightway', 'INV-2233'],
      [30, 'GBP', 'credit', 'funding', '12875.00', 'Customer payment'],
      [33, 'GBP', 'credit', 'funding', '18200.00', 'Customer payment'],
      [36, 'EUR', 'debit', 'payment', '1980.00', 'Payment to Meridian Logistics GmbH', 'sample-beneficiary-meridian', 'ML-10266'],
      [40, 'USD', 'credit', 'funding', '14700.00', 'Customer payment'],
    ];
    const running = new Map<string, Big>([...state.balances.values()].map((row) => [row.currency, row.amount]));
    for (const [daysAgo, currency, type, action, amount, reason, beneficiaryId, reference] of history) {
      const at = this.iso(-daysAgo * DAY_MS - 2 * 60 * 60 * 1000);
      const value = new Big(amount);
      let relatedId = this.nextId('inbound');
      let relatedReference = '';
      if (action === 'payment' && beneficiaryId) {
        const payment = this.paymentBody({
          beneficiaryId,
          currency,
          amount: value,
          reference: reference ?? '',
          reason,
          status: 'completed',
          paymentType: beneficiaryId === 'sample-beneficiary-brightway' ? 'priority' : 'regular',
          creatorId: accountsTeam.id,
          stepsRequired: '0',
          createdAt: at,
        });
        state.payments.push(payment);
        relatedId = payment.id as string;
        relatedReference = payment.short_reference as string;
      }
      const balanceAfter = running.get(currency) ?? new Big(0);
      state.transactions.push({
        id: this.nextId('txn'),
        balance_id: `sample-balance-${currency.toLowerCase()}`,
        account_id: state.account.id,
        currency,
        amount: money(value, currency),
        balance_amount: money(balanceAfter, currency),
        type,
        action,
        related_entity_type: action === 'payment' ? 'payment' : 'inbound_funds',
        related_entity_id: relatedId,
        related_entity_short_reference: relatedReference,
        status: 'completed',
        reason,
        settles_at: at,
        created_at: at,
        updated_at: at,
        completed_at: at,
      });
      running.set(currency, type === 'credit' ? balanceAfter.minus(value) : balanceAfter.plus(value));
    }

    // Forward: buy USD 150,000 at 1.2950 settling 14 Jan 2027, USD 60,000 drawn.
    const forwardCreated = this.iso(-45 * DAY_MS);
    state.conversions.push({
      id: 'sample-conversion-forward-1',
      account_id: state.account.id,
      creator_contact_id: accountsTeam.id,
      short_reference: 'SAMPLE-FWD001',
      settlement_date: '2027-01-14T15:30:00.000Z',
      conversion_date: '2027-01-14T15:30:00.000Z',
      status: 'awaiting_funds',
      currency_pair: 'GBPUSD',
      buy_currency: 'USD',
      sell_currency: 'GBP',
      fixed_side: 'buy',
      partner_buy_amount: '150000.00',
      partner_sell_amount: money(new Big('150000').div('1.2950'), 'GBP'),
      client_buy_amount: '150000.00',
      client_sell_amount: money(new Big('150000').div('1.2950'), 'GBP'),
      mid_market_rate: '1.2950',
      core_rate: '1.2950',
      partner_rate: '1.2950',
      client_rate: '1.2950',
      deposit_required: false,
      deposit_amount: '0.00',
      deposit_currency: 'GBP',
      deposit_status: 'not_required',
      deposit_required_at: '',
      unallocated_funds: '90000.00',
      payment_ids: [],
      unique_request_id: '',
      created_at: forwardCreated,
      updated_at: forwardCreated,
    });

    return state;
  }
}
