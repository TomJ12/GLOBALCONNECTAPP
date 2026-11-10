import { ProviderError } from '../errors';
import {
  conversionKind,
  isOpenForward,
  mapAccountDetails,
  mapBalance,
  mapBeneficiary,
  mapConversion,
  mapForwardContract,
  mapHttpError,
  mapPage,
  mapPayment,
  mapPendingApproval,
  mapQuote,
  mapRate,
  mapTransaction,
  parseBody,
  toCreateBeneficiaryParams,
} from '../adapters/currencycloud/mapping';
import {
  rawBalance,
  rawConversion,
  rawFindBalances,
  rawFundingAccount,
  rawHeldRateQuote,
  rawPayment,
  rawTransaction,
  type RawBeneficiary,
  type RawConversion,
  type RawPayment,
} from '../adapters/currencycloud/raw';

/** Examples below are the ones published in the provider's public OpenAPI spec. */
const SPEC_BALANCE = {
  id: '18230F1D-648A-406A-AD1F-A09CBC02E9E9',
  account_id: 'TcC',
  currency: 'USD',
  amount: '1000.00',
  created_at: '2023-12-31T23:59:59.000Z',
  updated_at: '2023-12-31T23:59:59.000Z',
};
const SPEC_PAGINATION = {
  total_entries: 30,
  total_pages: 3,
  current_page: 1,
  per_page: 10,
  previous_page: -1,
  next_page: 2,
  order: 'created_at',
  order_asc_desc: 'asc',
};
const SPEC_FUNDING_ACCOUNT = {
  id: 'b7981972-8e29-485b-8a4a-9643fc9ae4ea',
  account_id: '8d98bdc8-e8e3-47dc-bd08-3dd0f4f7ea7b',
  account_number: 'GB61TCCL00997950423807',
  account_number_type: 'IBAN',
  account_holder_name: 'Jon Doe',
  bank_name: 'The Currency Cloud',
  bank_address: '12 Steward Street, The Steward Building, London, E1 6FQ, GB',
  bank_country: 'UK',
  currency: 'EUR',
  payment_type: 'regular',
  routing_code: 'TCCLGB31',
  routing_code_type: 'bic_swift',
  created_at: '2018-05-14T14:18:30+00:00',
  updated_at: '2018-05-14T14:18:30+00:00',
};
const SPEC_TRANSACTION = {
  id: 'c5a990eb-d4d7-482f-bfb1-695261fb1e4d',
  balance_id: 'c5f1f54e-d6d8-4140-8110-f5b99bbc80c3',
  account_id: '7b9757a8-eee9-4572-86e6-77f4d711eaa6',
  currency: 'USD',
  amount: '1000.00',
  balance_amount: '2000.00',
  type: 'credit',
  action: 'conversion',
  related_entity_type: 'conversion',
  related_entity_id: 'e93e322f-93aa-4d31-b050-449da723db0b',
  related_entity_short_reference: '140416-GGJBNQ001',
  status: 'completed',
  reason: 'Reason for Transaction',
  settles_at: '2023-12-31T23:59:59.000Z',
  created_at: '2023-12-31T23:59:59.000Z',
  updated_at: '2023-12-31T23:59:59.000Z',
  completed_at: '2023-12-31T23:59:59.000Z',
};
const SPEC_QUOTE = {
  buy_currency: 'USD',
  client_buy_amount: '118.56',
  client_rate: '1.1856',
  client_sell_amount: '100.0',
  core_rate: '1.1858',
  created_at: '2025-08-11T08:10:21Z',
  currency_pair: 'EURUSD',
  deposit_amount: '0.0',
  deposit_currency: 'EUR',
  deposit_required: false,
  expires_at: '2025-08-11T08:15:21Z',
  fixed_side: 'sell',
  mid_market_rate: '1.0146',
  partner_buy_amount: '118.56',
  partner_rate: '1.1856',
  partner_sell_amount: '100.0',
  quote_id: '3c25ce4a-3552-45bb-869e-406c795052aa',
  sell_currency: 'EUR',
  settlement_cut_off_time: '2025-08-13T15:30:00Z',
};
const SPEC_CONVERSION = {
  id: 'c9b6b851-10f9-4bbf-881e-1d8a49adf7d8',
  account_id: '0386e472-8d2b-45a8-9c14-a393dce5bf3a',
  creator_contact_id: 'ac743762-5860-4b78-9c6a-82c5bca68867',
  short_reference: '20140507-VRTNFC',
  settlement_date: '2023-12-31T23:59:59.000Z',
  conversion_date: '2023-12-31T23:59:59.000Z',
  status: 'awaiting_funds',
  currency_pair: 'GBPUSD',
  buy_currency: 'GBP',
  sell_currency: 'USD',
  fixed_side: 'buy',
  partner_buy_amount: '1000.00',
  partner_sell_amount: '1587.80',
  client_buy_amount: '1000.00',
  client_sell_amount: '1594.90',
  mid_market_rate: '1.5868',
  core_rate: '1.5871',
  partner_rate: '1.5878',
  client_rate: '1.5949',
  deposit_required: true,
  deposit_amount: '47.85',
  deposit_currency: 'GBP',
  deposit_status: 'awaiting_deposit',
  deposit_required_at: '2023-12-31T23:59:59.000Z',
  unallocated_funds: '1000.00',
  payment_ids: ['b934794f-d810-4b4a-b360-5a0f47b7126e'],
  unique_request_id: '1234567890abc',
  created_at: '2023-12-31T23:59:59.000Z',
  updated_at: '2023-12-31T23:59:59.000Z',
};
const SPEC_PAYMENT = {
  id: '543477161-91de-012f-e284-1e0030c7f3123',
  short_reference: '140416-GGJBNQ001',
  beneficiary_id: '543477161-91de-012f-e284-1e0030c7f352',
  conversion_id: '049bab6d-fe2a-42e1-be0f-531c59f838ea',
  amount: '1250000.00',
  currency: 'GBP',
  status: 'ready_to_send',
  payment_type: 'regular',
  reference: 'INVOICE 9876',
  reason: 'Salary for March',
  estimated_arrival: '2023-12-31T00:00:00.000Z',
  payment_date: '2023-12-31T23:59:59.000Z',
  transferred_at: '2023-12-31T23:59:59.000Z',
  authorisation_steps_required: '0',
  creator_contact_id: 'ab3477161-91de-012f-e284-1e0030c7f35c',
  last_updater_contact_id: 'ab3477161-91de-012f-e284-1e0030c7f35c',
  failure_reason: '',
  payer_id: '',
  created_at: '2023-12-31T23:59:59.000Z',
  updated_at: '2023-12-31T23:59:59.000Z',
  fee_amount: '10.00',
  fee_currency: 'EUR',
};

function expectProviderError(run: () => unknown, kind: ProviderError['kind']): void {
  let caught: unknown;
  try {
    run();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(ProviderError);
  expect((caught as ProviderError).kind).toBe(kind);
}

describe('parseBody', () => {
  it('parses the spec examples', () => {
    const body = JSON.stringify({ balances: [SPEC_BALANCE], pagination: SPEC_PAGINATION });
    expect(parseBody(rawFindBalances, body).balances).toHaveLength(1);
  });

  it('turns broken JSON and wrong shapes into malformed_response', () => {
    expectProviderError(() => parseBody(rawFindBalances, '{"balances": [{"id": "trunc'), 'malformed_response');
    expectProviderError(() => parseBody(rawFindBalances, '{"balances": "nope"}'), 'malformed_response');
    expectProviderError(() => parseBody(rawBalance, JSON.stringify({ ...SPEC_BALANCE, amount: 1000 })), 'malformed_response');
    expectProviderError(() => parseBody(rawBalance, JSON.stringify({ ...SPEC_BALANCE, amount: '1,000.00' })), 'malformed_response');
    expectProviderError(() => parseBody(rawBalance, 'null'), 'malformed_response');
  });
});

describe('mapHttpError', () => {
  const body = (code: string) => JSON.stringify({ error_code: 'x_failed', error_messages: { amount: [{ code, message: 'm', params: {} }] } });

  it('maps statuses to kinds', () => {
    expect(mapHttpError(401, '{}').kind).toBe('unauthorized');
    expect(mapHttpError(429, '{}').kind).toBe('rate_limited');
    expect(mapHttpError(404, '').kind).toBe('not_found');
    expect(mapHttpError(500, '<html>oops</html>').kind).toBe('server');
    expect(mapHttpError(503, '').kind).toBe('server');
    expect(mapHttpError(400, body('amount_type_is_wrong')).kind).toBe('validation');
    expect(mapHttpError(400, body('quote_expired')).kind).toBe('quote_expired');
    expect(mapHttpError(400, body('insufficient_funds')).kind).toBe('insufficient_funds');
    expect(mapHttpError(418, '').kind).toBe('server');
  });

  it('keeps rejected field names and never leaks provider text to the user message', () => {
    const error = mapHttpError(400, JSON.stringify({ error_code: 'e', error_messages: { amount: [{ code: 'c', message: 'Currencycloud says no' }] } }));
    expect(error.fields).toEqual(['amount']);
    expect(error.userMessage).not.toMatch(/currencycloud/i);
    expect(error.retryable).toBe(false);
    expect(mapHttpError(500, '').retryable).toBe(true);
  });
});

describe('accounts', () => {
  it('maps a balance', () => {
    expect(mapBalance(rawBalance.parse(SPEC_BALANCE))).toEqual({
      id: SPEC_BALANCE.id,
      currency: 'USD',
      amount: '1000.00',
      updatedAt: '2023-12-31T23:59:59.000Z',
    });
  });

  it('maps pagination, with -1 meaning no next page', () => {
    expect(mapPage(SPEC_PAGINATION, ['a'])).toEqual({ items: ['a'], page: 1, totalPages: 3, totalItems: 30, nextPage: 2 });
    expect(mapPage({ ...SPEC_PAGINATION, current_page: 3, next_page: -1 }, []).nextPage).toBeNull();
  });

  it('merges funding accounts and never exposes the bank name', () => {
    const iban = rawFundingAccount.parse(SPEC_FUNDING_ACCOUNT);
    const local = rawFundingAccount.parse({
      ...SPEC_FUNDING_ACCOUNT,
      account_number: '00000000',
      account_number_type: 'account_number',
      routing_code: '000000',
      routing_code_type: 'sort_code',
    });
    const details = mapAccountDetails('eur', [local, iban]);
    expect(details).toEqual({
      currency: 'EUR',
      accountHolderName: 'Jon Doe',
      sortCode: '000000',
      accountNumber: '00000000',
      iban: 'GB61TCCL00997950423807',
      bic: 'TCCLGB31',
    });
    expect(JSON.stringify(details)).not.toMatch(/currency cloud/i);
  });

  it('fails clearly when there is no account for the currency', () => {
    expectProviderError(() => mapAccountDetails('USD', [rawFundingAccount.parse(SPEC_FUNDING_ACCOUNT)]), 'not_found');
  });

  it('maps transactions', () => {
    const raw = rawTransaction.parse(SPEC_TRANSACTION);
    expect(mapTransaction(raw)).toEqual({
      id: SPEC_TRANSACTION.id,
      currency: 'USD',
      amount: '1000',
      direction: 'credit',
      kind: 'conversion',
      description: 'Reason for Transaction',
      reference: '140416-GGJBNQ001',
      status: 'completed',
      createdAt: '2023-12-31T23:59:59.000Z',
    });
    const debit = mapTransaction({ ...raw, type: 'debit', action: 'payment', reason: '', amount: '-12.50', status: 'deleted' });
    expect(debit).toMatchObject({ amount: '12.5', kind: 'payment', description: 'Payment sent', status: 'cancelled' });
    expect(mapTransaction({ ...raw, action: 'something_new', reason: null }).kind).toBe('other');
  });
});

describe('rates and conversions', () => {
  it('takes the midpoint of bid and offer', () => {
    const rate = mapRate('gbp', 'usd', { rates: { GBPUSD: ['1.2998', '1.3002'] }, unavailable: [] }, '2026-01-01T00:00:00.000Z');
    expect(rate).toEqual({ base: 'GBP', quote: 'USD', rate: '1.3', asOf: '2026-01-01T00:00:00.000Z' });
    expectProviderError(() => mapRate('GBP', 'XXX', { rates: {}, unavailable: ['GBPXXX'] }, ''), 'not_found');
    expectProviderError(() => mapRate('GBP', 'USD', { rates: { GBPUSD: ['0', '0'] }, unavailable: [] }, ''), 'malformed_response');
  });

  it('maps a held-rate quote', () => {
    const quote = mapQuote(rawHeldRateQuote.parse(SPEC_QUOTE), {
      kind: 'spot',
      sellCurrency: 'EUR',
      buyCurrency: 'USD',
      fixedSide: 'sell',
      amount: '100',
    });
    expect(quote).toEqual({
      id: SPEC_QUOTE.quote_id,
      kind: 'spot',
      sellCurrency: 'EUR',
      buyCurrency: 'USD',
      sellAmount: '100.0',
      buyAmount: '118.56',
      fixedSide: 'sell',
      rateBase: 'EUR',
      rateQuote: 'USD',
      rate: '1.1856',
      createdAt: '2025-08-11T08:10:21Z',
      expiresAt: '2025-08-11T08:15:21Z',
      settlementDate: null,
    });
  });

  it('rejects a quote that does not match what was asked for, or has no expiry', () => {
    const raw = rawHeldRateQuote.parse(SPEC_QUOTE);
    const request = { kind: 'spot', sellCurrency: 'GBP', buyCurrency: 'USD', fixedSide: 'sell', amount: '100' } as const;
    expectProviderError(() => mapQuote(raw, request), 'malformed_response');
    expectProviderError(() => mapQuote({ ...raw, expires_at: 'soon' }, { ...request, sellCurrency: 'EUR' }), 'malformed_response');
  });

  it('keeps the settlement date for a forward quote', () => {
    const quote = mapQuote(rawHeldRateQuote.parse(SPEC_QUOTE), {
      kind: 'forward',
      sellCurrency: 'EUR',
      buyCurrency: 'USD',
      fixedSide: 'sell',
      amount: '100',
      settlementDate: '2026-02-10',
    });
    expect(quote.kind).toBe('forward');
    expect(quote.settlementDate).toBe('2026-02-10');
  });

  it('maps a conversion and tells spot from forward by its dates', () => {
    const raw: RawConversion = rawConversion.parse(SPEC_CONVERSION);
    expect(mapConversion(raw)).toMatchObject({
      reference: '20140507-VRTNFC',
      kind: 'spot',
      status: 'pending',
      sellCurrency: 'USD',
      buyCurrency: 'GBP',
      sellAmount: '1594.90',
      buyAmount: '1000.00',
      rateBase: 'GBP',
      rateQuote: 'USD',
      rate: '1.5949',
      settlementDate: '2023-12-31',
    });
    const forward = { ...raw, created_at: '2023-10-01T10:00:00.000Z' };
    expect(conversionKind(forward)).toBe('forward');
    expect(isOpenForward(forward)).toBe(true);
    expect(isOpenForward({ ...forward, status: 'trade_settled' })).toBe(false);
    expect(isOpenForward({ ...forward, status: 'closed' })).toBe(false);
    expect(isOpenForward(raw)).toBe(false);
    expect(mapConversion({ ...raw, status: 'trade_settled' }).status).toBe('settled');
    expectProviderError(() => mapConversion({ ...raw, settlement_date: 'tbc' }), 'malformed_response');
  });

  it('derives forward drawdown from unallocated funds', () => {
    const raw = rawConversion.parse({
      ...SPEC_CONVERSION,
      buy_currency: 'USD',
      sell_currency: 'GBP',
      client_buy_amount: '150000.00',
      unallocated_funds: '90000.00',
      client_rate: '1.2950',
      settlement_date: '2027-01-14T15:30:00.000Z',
    });
    expect(mapForwardContract(raw)).toMatchObject({
      buyAmount: '150000.00',
      drawnAmount: '60000',
      remainingAmount: '90000',
      rate: '1.2950',
      settlementDate: '2027-01-14',
    });
    expect(mapForwardContract({ ...raw, unallocated_funds: null })).toMatchObject({ drawnAmount: '0', remainingAmount: '150000' });
    expect(mapForwardContract({ ...raw, unallocated_funds: '999999.00' })).toMatchObject({ drawnAmount: '0' });
    expect(mapForwardContract({ ...raw, unallocated_funds: '-5' })).toMatchObject({ drawnAmount: '150000', remainingAmount: '0' });
  });
});

describe('payees and payments', () => {
  const rawPayee: RawBeneficiary = {
    id: 'b1',
    bank_account_holder_name: 'Company PLC',
    name: 'Sample name',
    beneficiary_entity_type: 'company',
    bank_country: 'gb',
    currency: 'gbp',
    account_number: '12345678',
    routing_code_type_1: 'sort_code',
    routing_code_value_1: '123456',
    routing_code_type_2: '',
    routing_code_value_2: '',
    bic_swift: '',
    iban: '',
    payment_types: ['regular'],
    created_at: '2023-12-31T23:59:59.000Z',
    updated_at: '2023-12-31T23:59:59.000Z',
  };

  it('maps a beneficiary and blanks to null', () => {
    expect(mapBeneficiary(rawPayee)).toEqual({
      id: 'b1',
      name: 'Company PLC',
      entityType: 'company',
      currency: 'GBP',
      bankCountry: 'GB',
      accountNumber: '12345678',
      sortCode: '123456',
      iban: null,
      bic: null,
      routingNumber: null,
    });
    expect(mapBeneficiary({ ...rawPayee, routing_code_type_1: 'aba', routing_code_value_1: '021000021' })).toMatchObject({
      sortCode: null,
      routingNumber: '021000021',
    });
  });

  it('builds create parameters with the provider field names', () => {
    expect(
      toCreateBeneficiaryParams({ name: ' Harbour Print Ltd ', entityType: 'company', currency: 'gbp', bankCountry: 'gb', sortCode: '12-34-56', accountNumber: '1234 5678' }),
    ).toEqual({
      bank_account_holder_name: 'Harbour Print Ltd',
      beneficiary_company_name: 'Harbour Print Ltd',
      bank_country: 'GB',
      currency: 'GBP',
      beneficiary_entity_type: 'company',
      account_number: '12345678',
      routing_code_type_1: 'sort_code',
      routing_code_value_1: '123456',
    });
    expect(toCreateBeneficiaryParams({ name: 'A B', entityType: 'individual', currency: 'EUR', bankCountry: 'DE', iban: 'de89 3704 0044 0532 0130 00', bic: 'deutdeff' })).toEqual({
      bank_account_holder_name: 'A B',
      bank_country: 'DE',
      currency: 'EUR',
      beneficiary_entity_type: 'individual',
      iban: 'DE89370400440532013000',
      bic_swift: 'DEUTDEFF',
    });
  });

  const raw: RawPayment = rawPayment.parse(SPEC_PAYMENT);
  const names = new Map([[SPEC_PAYMENT.beneficiary_id, 'Company PLC']]);

  it('maps a payment', () => {
    expect(mapPayment(raw, names)).toEqual({
      id: SPEC_PAYMENT.id,
      shortReference: '140416-GGJBNQ001',
      amount: '1250000.00',
      currency: 'GBP',
      beneficiaryId: SPEC_PAYMENT.beneficiary_id,
      beneficiaryName: 'Company PLC',
      reference: 'INVOICE 9876',
      status: 'processing',
      route: 'local',
      fee: { amount: '10.00', currency: 'EUR' },
      estimatedArrival: '2023-12-31',
      createdAt: '2023-12-31T23:59:59.000Z',
    });
  });

  it('never invents a fee, arrival date, payee name or route', () => {
    const bare = mapPayment({ ...raw, fee_amount: '', fee_currency: '', estimated_arrival: '', payment_type: 'carrier_pigeon' }, new Map());
    expect(bare).toMatchObject({ fee: null, estimatedArrival: null, beneficiaryName: null, route: null });
    expect(mapPayment({ ...raw, fee_amount: 'free', fee_currency: 'EUR' }, names).fee).toBeNull();
  });

  it('maps every documented status', () => {
    const expected: Record<string, string> = {
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
      some_future_status: 'processing',
    };
    for (const [status, mapped] of Object.entries(expected)) {
      expect(mapPayment({ ...raw, status }, names).status).toBe(mapped);
    }
    expect(mapPayment({ ...raw, payment_type: 'priority' }, names).route).toBe('swift');
  });

  it('builds the approval chain', () => {
    const pending = { ...raw, status: 'awaiting_authorisation', authorisation_steps_required: '2' };
    const approval = mapPendingApproval(pending, names, { id: 'c1', first_name: 'Accounts', last_name: 'team' });
    expect(approval.approvalsRemaining).toBe(2);
    expect(approval.steps.map((step) => [step.label, step.status])).toEqual([
      ['Created by Accounts team', 'done'],
      ['Waiting for you', 'waiting_for_you'],
      ['Another approver', 'waiting'],
    ]);
    expect(mapPendingApproval({ ...pending, authorisation_steps_required: 1 }, names, null).steps.map((step) => step.label)).toEqual(['Created', 'Waiting for you']);
    expect(mapPendingApproval({ ...pending, authorisation_steps_required: 'lots' }, names, null).approvalsRemaining).toBe(1);
  });
});
