/**
 * Raw wire shapes, modelled on Currencycloud's public REST API v2.
 *
 * Field names were checked against the public OpenAPI spec
 * (github.com/currencycloud/currencycloud-swagger, src/reference.yaml) on
 * 2026-11-10. Only the fields this app reads are declared; zod strips the rest,
 * so extra fields from a real API do not break parsing.
 *
 * Shapes marked "NOT PART OF THE PROVIDER API" are stand-ins for services
 * Global Connect would have to supply itself. See README, "What is placeholder".
 */
import { z } from 'zod';

/** The API sends amounts and rates as strings. We keep them that way. */
const decimal = z.string().regex(/^-?\d+(\.\d+)?$/, 'expected a decimal string');
const optionalText = z.string().nullish();

export const rawPagination = z.object({
  total_entries: z.number().int(),
  total_pages: z.number().int(),
  current_page: z.number().int(),
  per_page: z.number().int(),
  previous_page: z.number().int(),
  /** -1 when there is no next page. */
  next_page: z.number().int(),
  order: z.string(),
  order_asc_desc: z.string(),
});

// POST /v2/authenticate/api -> { auth_token }
export const rawAuthToken = z.object({ auth_token: z.string().min(1) });

// GET /v2/accounts/current
export const rawAccount = z.object({
  id: z.string(),
  account_name: z.string(),
});

// GET /v2/contacts/{id}
export const rawContact = z.object({
  id: z.string(),
  first_name: z.string(),
  last_name: z.string(),
  email_address: optionalText,
});

// GET /v2/balances/find
export const rawBalance = z.object({
  id: z.string(),
  account_id: z.string(),
  currency: z.string().length(3),
  amount: decimal,
  created_at: z.string(),
  updated_at: z.string(),
});
export const rawFindBalances = z.object({ balances: z.array(rawBalance), pagination: rawPagination });

// GET /v2/funding_accounts/find
export const rawFundingAccount = z.object({
  id: z.string(),
  account_id: z.string(),
  account_number: z.string(),
  /** Spec enum is lower case, the spec's own example is upper case. Compare case-insensitively. */
  account_number_type: z.string(),
  account_holder_name: z.string(),
  bank_name: optionalText,
  bank_address: optionalText,
  bank_country: optionalText,
  currency: z.string().length(3),
  payment_type: z.string(),
  routing_code: z.string(),
  routing_code_type: z.string(),
});
export const rawFindFundingAccounts = z.object({
  funding_accounts: z.array(rawFundingAccount),
  pagination: rawPagination,
});

// GET /v2/transactions/find
export const rawTransaction = z.object({
  id: z.string(),
  balance_id: z.string(),
  account_id: z.string(),
  currency: z.string().length(3),
  amount: decimal,
  balance_amount: decimal.nullish(),
  type: z.enum(['credit', 'debit']),
  action: z.string(),
  related_entity_type: z.string(),
  related_entity_id: z.string(),
  related_entity_short_reference: optionalText,
  status: z.enum(['completed', 'deleted', 'pending']),
  reason: optionalText,
  settles_at: optionalText,
  created_at: z.string(),
  updated_at: z.string(),
  completed_at: optionalText,
});
export const rawFindTransactions = z.object({
  transactions: z.array(rawTransaction),
  pagination: rawPagination,
});

// GET /v2/rates/find -> { rates: { GBPUSD: [bid, offer] }, unavailable: [] }
export const rawBasicRates = z.object({
  rates: z.record(z.string(), z.tuple([decimal, decimal])),
  unavailable: z.array(z.string()),
});

// POST /v2/quotes/create (held rate quote)
export const rawHeldRateQuote = z.object({
  quote_id: z.string(),
  buy_currency: z.string().length(3),
  sell_currency: z.string().length(3),
  client_buy_amount: decimal,
  client_sell_amount: decimal,
  client_rate: decimal,
  currency_pair: z.string().length(6),
  fixed_side: z.enum(['buy', 'sell']),
  created_at: z.string(),
  expires_at: z.string(),
  settlement_cut_off_time: z.string(),
  deposit_required: z.boolean().nullish(),
});

// POST /v2/conversions/create, GET /v2/conversions/find
export const rawConversion = z.object({
  id: z.string(),
  short_reference: z.string(),
  settlement_date: z.string(),
  conversion_date: z.string(),
  status: z.string(),
  currency_pair: z.string().length(6),
  buy_currency: z.string().length(3),
  sell_currency: z.string().length(3),
  fixed_side: z.enum(['buy', 'sell']),
  client_buy_amount: decimal,
  client_sell_amount: decimal,
  client_rate: decimal,
  /** Buy-currency funds not yet paid out. Used to derive forward drawdown. */
  unallocated_funds: decimal.nullish(),
  payment_ids: z.array(z.string()).nullish(),
  unique_request_id: optionalText,
  created_at: z.string(),
  updated_at: z.string(),
});
export const rawFindConversions = z.object({
  conversions: z.array(rawConversion),
  pagination: rawPagination,
});

// POST /v2/beneficiaries/create, POST /v2/beneficiaries/find
export const rawBeneficiary = z.object({
  id: z.string(),
  bank_account_holder_name: z.string(),
  name: optionalText,
  beneficiary_entity_type: optionalText,
  beneficiary_company_name: optionalText,
  bank_country: z.string(),
  currency: z.string().length(3),
  account_number: optionalText,
  routing_code_type_1: optionalText,
  routing_code_value_1: optionalText,
  routing_code_type_2: optionalText,
  routing_code_value_2: optionalText,
  bic_swift: optionalText,
  iban: optionalText,
  payment_types: z.array(z.string()).nullish(),
  created_at: z.string(),
  updated_at: z.string(),
});
export const rawFindBeneficiaries = z.object({
  beneficiaries: z.array(rawBeneficiary),
  pagination: rawPagination,
});

// POST /v2/payments/create, GET /v2/payments/find, POST /v2/payments/{id}/delete
export const rawPayment = z.object({
  id: z.string(),
  short_reference: z.string(),
  amount: decimal,
  currency: z.string().length(3),
  beneficiary_id: z.string(),
  reference: z.string(),
  reason: optionalText,
  status: z.string(),
  payment_type: optionalText,
  payment_date: optionalText,
  estimated_arrival: optionalText,
  /** The spec types this as a string; its example for the authorise response uses numbers. Accept both. */
  authorisation_steps_required: z.union([z.string(), z.number()]).nullish(),
  creator_contact_id: optionalText,
  fee_amount: optionalText,
  fee_currency: optionalText,
  unique_request_id: optionalText,
  created_at: z.string(),
  updated_at: z.string(),
});
export const rawFindPayments = z.object({ payments: z.array(rawPayment), pagination: rawPagination });

// POST /v2/payments/authorise
export const rawPaymentAuthorisation = z.object({
  payment_id: z.string(),
  payment_status: z.string(),
  updated: z.union([z.boolean(), z.string()]),
  error: optionalText,
  auth_steps_taken: z.union([z.string(), z.number()]).nullish(),
  auth_steps_required: z.union([z.string(), z.number()]).nullish(),
  short_reference: optionalText,
});
export const rawPaymentAuthorisations = z.object({ authorisations: z.array(rawPaymentAuthorisation) });

// Error body used on 4xx responses.
export const rawErrorBody = z.object({
  error_code: z.string(),
  error_messages: z
    .record(
      z.string(),
      z.array(z.object({ code: z.string(), message: z.string().nullish(), params: z.unknown().optional() })),
    )
    .nullish(),
});

// --- NOT PART OF THE PROVIDER API -------------------------------------------
// Magic-link sign-in and rate history are not offered by
// the provider. A real build needs a Global Connect service for these.

export const rawMagicLinkRequest = z.object({
  request_id: z.string(),
  email: z.string(),
  expires_at: z.string(),
});

export const rawAppSession = z.object({
  auth_token: z.string().min(1),
  contact: rawContact,
});

export const rawRateHistory = z.object({
  currency_pair: z.string().length(6),
  points: z.array(z.object({ at: z.string(), rate: decimal })),
});

export type RawPagination = z.infer<typeof rawPagination>;
export type RawAccount = z.infer<typeof rawAccount>;
export type RawContact = z.infer<typeof rawContact>;
export type RawBalance = z.infer<typeof rawBalance>;
export type RawFundingAccount = z.infer<typeof rawFundingAccount>;
export type RawTransaction = z.infer<typeof rawTransaction>;
export type RawBasicRates = z.infer<typeof rawBasicRates>;
export type RawHeldRateQuote = z.infer<typeof rawHeldRateQuote>;
export type RawConversion = z.infer<typeof rawConversion>;
export type RawBeneficiary = z.infer<typeof rawBeneficiary>;
export type RawPayment = z.infer<typeof rawPayment>;
export type RawPaymentAuthorisation = z.infer<typeof rawPaymentAuthorisation>;
export type RawErrorBody = z.infer<typeof rawErrorBody>;
export type RawMagicLinkRequest = z.infer<typeof rawMagicLinkRequest>;
export type RawAppSession = z.infer<typeof rawAppSession>;
export type RawRateHistory = z.infer<typeof rawRateHistory>;
