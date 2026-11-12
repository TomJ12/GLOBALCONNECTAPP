/**
 * In-memory stand-in for provider B's API, speaking the shapes in raw.ts.
 * ALL DATA IS SAMPLE DATA and every account number is an obvious fake.
 * Quotes use a sample mid rate with no spread or fee.
 */
import { Big } from 'big.js';

import type { EqualsRequest, EqualsTransport } from './raw';

type Json = Record<string, unknown>;

/** Sample rates: units of each currency per 1 GBP. */
const UNITS_PER_GBP: Record<string, string> = { GBP: '1', EUR: '1.1800', USD: '1.3000', AED: '4.7743', JPY: '195.00' };
/** The public docs say a quote is good for 12 seconds. */
export const QUOTE_TTL_MS = 12_000;
const DAY_MS = 24 * 60 * 60 * 1000;

const decimals = (currency: string) => (currency === 'JPY' ? 0 : 2);
const round = (value: Big, currency: string) => Number(value.round(decimals(currency), Big.roundHalfUp).toString());

/** Accounts the mock knows. A company can only be mapped to one of these. */
export const MOCK_ACCOUNTS_B = ['S00001', 'S00002', 'S00003'];

interface State {
  accountId: string;
  budgetId: string;
  balances: Map<string, Big>;
  recipients: Json[];
  paymentOrders: Json[];
  trades: Map<string, Json>;
  quotes: Map<string, { body: Json; expiresAtMs: number }>;
  activity: Json[];
}

const BY_ID = [/^\/v2\/orders\/payment$/, /^\/v2\/orders\/trade$/, /^\/v2\/orders\/[^/]+$/, /^\/v2\/recipients\/[^/]+\/confirm$/];

/**
 * ONE instance holds several accounts. Every call must carry `accountId`; a
 * call without it, or for an unknown account, is refused, and each call sees
 * only that account's data. Generated ids are unique across accounts.
 *
 * `enforceOwnership: false` models a provider that, given the master API key,
 * acts on any id whatever the scope says; the isolation tests use it so that
 * they prove the server's own checks.
 */
export class MockEqualsServer implements EqualsTransport {
  private readonly now: () => number;
  private readonly states = new Map<string, State>();
  private readonly enforceOwnership: boolean;
  private counter = 0;
  /** The account the current request is for. Set at the start of each (synchronous) request. */
  private state!: State;
  /** Every request received, for tests. */
  readonly seen: { path: string; accountId: string | undefined }[] = [];

  constructor(options: { accounts?: string[]; now?: () => number; enforceOwnership?: boolean } = {}) {
    this.now = options.now ?? Date.now;
    this.enforceOwnership = options.enforceOwnership ?? true;
    for (const accountId of options.accounts ?? MOCK_ACCOUNTS_B) this.states.set(accountId, this.seed(accountId));
  }

  private get accountId(): string {
    return this.state.accountId;
  }

  async request(request: EqualsRequest): Promise<{ status: number; body: string }> {
    await Promise.resolve();
    if (!request.apiKey) return this.fail(401, 'unauthorised');
    const scope = request.query?.accountId;
    this.seen.push({ path: request.path, accountId: scope });
    const own = scope ? this.states.get(scope) : undefined;
    if (!own) return this.fail(403, 'forbidden');
    this.state = own;
    const response = this.route(request);
    if (this.enforceOwnership || response.status < 400 || response.status >= 500 || !BY_ID.some((pattern) => pattern.test(request.path))) return response;
    // Lax mode: the id was not in the scoped account, so act on it wherever it lives.
    for (const other of this.states.values()) {
      if (other === own) continue;
      this.state = other;
      const elsewhere = this.route(request);
      if (elsewhere.status < 300) return elsewhere;
    }
    return response;
  }

  private route(request: EqualsRequest): { status: number; body: string } {
    const { method, path, query = {} } = request;
    const body = (request.body ?? {}) as Json;
    const key = `${method} ${path}`;

    if (key === 'GET /v2/budgets') return this.ok(this.page([this.budget()], query));
    if (key === 'GET /v2/activity') return this.ok(this.page(this.state.activity, query));
    if (key === 'GET /v2/rates') return this.rate(query);
    if (key === 'POST /v2/orders/quote') return this.quote(body);
    if (key === 'POST /v2/orders/trade') return this.trade(body);
    if (key === 'GET /v2/recipients') return this.ok(this.page(this.state.recipients, query));
    if (key === 'POST /v2/recipients/validate') return this.validateRecipient(body);
    if (key === 'POST /v2/orders/payment') return this.payment(body);
    if (key === 'GET /v2/orders') {
      const wanted = query.clientReference;
      return this.ok(this.page(wanted ? this.state.paymentOrders.filter((row) => row.clientReference === wanted) : this.state.paymentOrders, query));
    }
    const confirm = /^\/v2\/recipients\/([^/]+)\/confirm$/.exec(path);
    if (method === 'POST' && confirm) {
      const recipient = this.state.recipients.find((row) => row.id === confirm[1]);
      if (!recipient) return this.fail(404, 'not_found');
      recipient.status = 'AUTHORISED';
      return { status: 201, body: JSON.stringify(recipient) };
    }
    const order = /^\/v2\/orders\/([^/]+)$/.exec(path);
    if (method === 'GET' && order) {
      const trade = this.state.trades.get(order[1] ?? '');
      return trade ? this.ok(trade) : this.fail(404, 'not_found');
    }
    return this.fail(404, 'not_found');
  }

  private ok(body: unknown) {
    return { status: 200, body: JSON.stringify(body) };
  }
  private fail(status: number, code: string, field?: string) {
    return { status, body: JSON.stringify({ code, message: code.replace(/_/g, ' '), ...(field ? { field } : {}) }) };
  }
  private iso(offsetMs = 0): string {
    return new Date(this.now() + offsetMs).toISOString();
  }
  private id(prefix: string): string {
    this.counter += 1;
    return `SMPL${prefix}${this.counter.toString().padStart(6, '0')}`;
  }
  private page(rows: Json[], query: Record<string, string>): Json {
    const limit = Math.min(1000, Math.max(1, Number(query.limit ?? 100) || 100));
    const offset = Math.max(0, Number(query.offset ?? 0) || 0);
    return { limit, offset, count: rows.length, rows: rows.slice(offset, offset + limit) };
  }

  private budget(): Json {
    const account = (currency: string, local: Json | null, international: Json | null) => ({ currencyCode: currency, local, international });
    const name = 'Castlebrook Imports Ltd';
    return {
      id: this.state.budgetId,
      name: 'Main balance',
      accountId: this.accountId,
      type: 'accountBalance',
      status: 'active',
      balance: [...this.state.balances].map(([currencyCode, amount]) => {
        const value = round(amount, currencyCode);
        return {
          currencyCode,
          availableBalance: value,
          ledgerBalance: value,
          pendingBalance: 0,
          allocatedBalance: 0,
          ledgerAndAllocatedBalance: value,
          activeCurrencyOnBudget: true,
        };
      }),
      settlementDetails: {
        currencyDetails: [
          account('GBP', { accountName: name, accountNumber: '00000000', sortCode: '000000' }, { accountName: name, iban: 'GB00SMPL00000000000010', bic: 'SMPLGB00' }),
          account('EUR', null, { accountName: name, iban: 'GB00SMPL00000000000011', bic: 'SMPLGB00' }),
          account('USD', null, { accountName: name, iban: 'GB00SMPL00000000000012', bic: 'SMPLGB00' }),
        ],
        balanceReference: 'SMPLREF',
      },
      createdAt: this.iso(-300 * DAY_MS),
      updatedAt: this.iso(),
    };
  }

  private rateBetween(from: string, to: string): Big | null {
    const a = UNITS_PER_GBP[from];
    const b = UNITS_PER_GBP[to];
    return a && b ? new Big(b).div(a).round(6, Big.roundHalfUp) : null;
  }

  private rate(query: Record<string, string>) {
    const rate = this.rateBetween(query.from ?? '', query.to ?? '');
    if (!rate) return this.fail(400, 'unsupported_currency', 'from');
    return this.ok({ from: query.from, to: query.to, rate: Number(rate.toString()), timestamp: this.iso() });
  }

  private move(currency: string, delta: Big, row: { type: string; description: string; reference?: string }): void {
    this.state.balances.set(currency, (this.state.balances.get(currency) ?? new Big(0)).plus(delta));
    this.state.activity.unshift({
      id: this.id('ACT'),
      type: row.type,
      direction: delta.gte(0) ? 'in' : 'out',
      amount: round(delta.abs(), currency),
      currencyCode: currency,
      description: row.description,
      reference: row.reference ?? '',
      status: 'complete',
      createdAt: this.iso(),
    });
  }

  private quote(body: Json) {
    const source = body.sourceCurrency as { amount?: number; currency?: { currencyCode?: string } } | undefined;
    const target = body.targetCurrency as { amount?: number; currency?: { currencyCode?: string } } | undefined;
    const from = source?.currency?.currencyCode ?? '';
    const to = target?.currency?.currencyCode ?? '';
    const rate = this.rateBetween(from, to);
    if (!rate || from === to) return this.fail(400, 'unsupported_currency', 'sourceCurrency');
    if (typeof body.settlementDate !== 'string' || !/^\d{8}$/.test(body.settlementDate)) return this.fail(400, 'invalid_settlement_date', 'settlementDate');
    const fixedSource = typeof source?.amount === 'number';
    const amount = fixedSource ? source?.amount : target?.amount;
    if (typeof amount !== 'number' || !(amount > 0)) return this.fail(400, 'invalid_amount', 'amount');
    const fromAmount = fixedSource ? new Big(amount) : new Big(amount).div(rate);
    const toAmount = fixedSource ? new Big(amount).times(rate) : new Big(amount);
    const quoteRequestId = this.id('QR');
    const quote: Json = {
      quoteRequestId,
      orderId: this.id('ORD'),
      settlement: { date: body.settlementDate, price: { amount: round(fromAmount, from), currency: from }, charges: { fee: 0 } },
      quote: {
        rate: Number(rate.toString()),
        inverseRate: Number(new Big(1).div(rate).round(6).toString()),
        fromGbpAmount: round(fromAmount.div(UNITS_PER_GBP[from] ?? '1'), 'GBP'),
        from: { amount: round(fromAmount, from), currency: from },
        to: { amount: round(toAmount, to), currency: to },
        direction: fixedSource ? '1' : '2',
      },
    };
    this.state.quotes.set(quoteRequestId, { body: quote, expiresAtMs: this.now() + QUOTE_TTL_MS });
    return this.ok(quote);
  }

  private trade(body: Json) {
    const orderId = String(body.orderId ?? '');
    // Trading the same order twice returns the first trade: an order is booked once.
    const existing = this.state.trades.get(orderId);
    if (existing) return this.ok(existing);
    const held = this.state.quotes.get(String(body.quoteRequestId ?? ''));
    if (!held || held.body.orderId !== orderId) return this.fail(404, 'quote_not_found');
    if (held.expiresAtMs <= this.now()) return this.fail(410, 'quote_expired');
    const { from, to } = held.body.quote as { from: { amount: number; currency: string }; to: { amount: number; currency: string } };
    if ((this.state.balances.get(from.currency) ?? new Big(0)).lt(from.amount)) return this.fail(422, 'insufficient_funds');
    this.move(from.currency, new Big(from.amount).neg(), { type: 'exchange', description: `Exchange to ${to.currency}`, reference: orderId });
    this.move(to.currency, new Big(to.amount), { type: 'exchange', description: `Exchange from ${from.currency}`, reference: orderId });
    const trade = { ...held.body, status: 'complete', createdAt: this.iso() };
    this.state.trades.set(orderId, trade);
    return this.ok(trade);
  }

  private validateRecipient(body: Json) {
    for (const field of ['name', 'accountIdentifier', 'currencyCode', 'type']) {
      if (typeof body[field] !== 'string' || body[field] === '') return this.fail(400, 'validation_failed', field);
    }
    const recipient: Json = {
      id: this.id('RCP'),
      accountId: this.accountId,
      status: 'unverified',
      type: body.type,
      name: body.name,
      currencyCode: body.currencyCode,
      accountIdentifier: body.accountIdentifier,
      ...(typeof body.bankIdentifier === 'string' ? { bankIdentifier: body.bankIdentifier } : {}),
      bankAddress: { countryCode: (body.bankAddress as { countryCode?: string } | undefined)?.countryCode ?? 'GB' },
      createdAt: this.iso(),
    };
    this.state.recipients.push(recipient);
    return this.ok(recipient);
  }

  private payment(body: Json) {
    const clientReference = typeof body.clientReference === 'string' ? body.clientReference : '';
    const repeat = clientReference ? this.state.paymentOrders.find((row) => row.clientReference === clientReference) : undefined;
    if (repeat) return this.ok(repeat);
    const payments = body.payments as { amount?: number; currency?: { currencyCode?: string }; recipientId?: string; externalReference?: string } | undefined;
    const recipient = this.state.recipients.find((row) => row.id === payments?.recipientId);
    const currency = payments?.currency?.currencyCode ?? '';
    if (!recipient || recipient.status !== 'AUTHORISED') return this.fail(400, 'validation_failed', 'recipientId');
    if (recipient.currencyCode !== currency) return this.fail(400, 'validation_failed', 'currency');
    if (typeof payments?.amount !== 'number' || !(payments.amount > 0)) return this.fail(400, 'validation_failed', 'amount');
    if ((this.state.balances.get(currency) ?? new Big(0)).lt(payments.amount)) return this.fail(422, 'insufficient_funds');
    const order: Json = {
      orderId: this.id('ORD'),
      status: 'processing',
      clientReference,
      payments: { ...payments, currency: { budgetId: this.state.budgetId, currencyCode: currency } },
      createdAt: this.iso(),
    };
    this.state.paymentOrders.unshift(order);
    this.move(currency, new Big(payments.amount).neg(), { type: 'payment', description: `Payment to ${String(recipient.name)}`, reference: payments.externalReference });
    return this.ok(order);
  }

  private seed(accountId: string): State {
    const state: State = {
      accountId,
      // Not derived from the account id: budget ids end up in ids the client app sees.
      budgetId: `sample-budget-${(this.states.size + 1).toString().padStart(4, '0')}`,
      balances: new Map([
        ['GBP', new Big('48250.75')],
        ['EUR', new Big('131900.00')],
        ['USD', new Big('9410.20')],
      ]),
      recipients: [],
      paymentOrders: [],
      trades: new Map(),
      quotes: new Map(),
      activity: [],
    };
    this.state = state;
    const recipient = (id: string, name: string, currencyCode: string, accountIdentifier: string, bankIdentifier: string | undefined, countryCode: string): Json => ({
      id,
      accountId: this.accountId,
      status: 'AUTHORISED',
      type: 'business',
      name,
      currencyCode,
      accountIdentifier,
      ...(bankIdentifier ? { bankIdentifier } : {}),
      bankAddress: { countryCode },
      createdAt: this.iso(-200 * DAY_MS),
    });
    state.recipients = [
      // FR14 2004 1010 0505 0001 3M02 606 is a standard documentation example IBAN, not a real account.
      recipient('sample-recipient-vignoble', 'Vignoble Saint-Clair SARL', 'EUR', 'FR1420041010050500013M02606', 'SMPLFRPP', 'FR'),
      recipient('sample-recipient-quayside', 'Quayside Haulage Ltd', 'GBP', '00000000', '000000', 'GB'),
    ];
    const history: [daysAgo: number, type: string, direction: 'in' | 'out', currency: string, amount: number, description: string, reference: string, recipientId?: string][] = [
      [1, 'deposit', 'in', 'GBP', 18200, 'Customer payment', 'CB-5521'],
      [2, 'payment', 'out', 'EUR', 26450, 'Payment to Vignoble Saint-Clair SARL', 'VSC-0931', 'sample-recipient-vignoble'],
      [4, 'payment', 'out', 'GBP', 1930.4, 'Payment to Quayside Haulage Ltd', 'QH-2207', 'sample-recipient-quayside'],
      [6, 'deposit', 'in', 'EUR', 40000, 'Customer payment', 'CB-5498'],
      [9, 'deposit', 'in', 'GBP', 9600, 'Customer payment', 'CB-5467'],
      [12, 'payment', 'out', 'EUR', 18975.5, 'Payment to Vignoble Saint-Clair SARL', 'VSC-0917', 'sample-recipient-vignoble'],
      [15, 'deposit', 'in', 'USD', 9410.2, 'Customer payment', 'CB-5440'],
    ];
    for (const [daysAgo, type, direction, currencyCode, amount, description, reference, recipientId] of history) {
      const createdAt = this.iso(-daysAgo * DAY_MS);
      state.activity.push({ id: this.id('ACT'), type, direction, amount, currencyCode, description, reference, status: 'complete', createdAt });
      if (recipientId) {
        state.paymentOrders.push({
          orderId: this.id('ORD'),
          status: 'complete',
          clientReference: '',
          payments: { amount, currency: { budgetId: state.budgetId, currencyCode }, recipientId, externalReference: reference },
          createdAt,
        });
      }
    }
    return state;
  }
}
