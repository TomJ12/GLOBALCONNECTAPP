/**
 * zod schemas of the provider-neutral shapes in types.ts, as they travel
 * between the app and the Global Connect server. The app validates every
 * response with them; the server validates every request body with them.
 */
import { z } from 'zod';

import type {
  AccountDetails,
  ActivationResult,
  ActivationStart,
  ApprovalResult,
  Balance,
  Beneficiary,
  CompanyProfile,
  Conversion,
  ForwardContract,
  ListResult,
  LoginChallenge,
  NewBeneficiary,
  Page,
  Payment,
  PendingApproval,
  Quote,
  QuoteRequest,
  RateHistory,
  RatePair,
  Session,
  SignInResult,
  TotpEnrolment,
  Transaction,
} from './types';

const decimal = z.string().regex(/^\d+(\.\d+)?$/);
const currency = z.string().regex(/^[A-Z]{3}$/);
const text = z.string().max(500);
const nullableText = text.nullable();
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const kind = z.enum(['spot', 'forward']);
const fixedSide = z.enum(['sell', 'buy']);

// --- Session ------------------------------------------------------------------

const user = z.object({ id: text, email: text, displayName: text });
const company = z.object({ id: text, name: text });
export const stepUpAction = z.enum(['payment.create', 'payment.approve', 'payment.reject', 'beneficiary.create', 'conversion.book']);
export const capabilities = z.object({ forwardContracts: z.boolean(), paymentApprovals: z.boolean() });
export const session: z.ZodType<Session> = z.object({
  user,
  company,
  role: z.enum(['creator', 'approver', 'admin']),
  capabilities,
  stepUpActions: z.array(stepUpAction),
});
export const loginChallenge: z.ZodType<LoginChallenge> = z.object({ challengeId: z.string().min(1) });
export const signInResponse: z.ZodType<SignInResult & { token: string }> = z.object({
  token: z.string().min(20),
  user,
  companies: z.array(company),
  session: session.nullable(),
});
export const activationStart: z.ZodType<ActivationStart> = z.object({
  email: text,
  displayName: text,
  passwordPolicy: z.object({ minLength: z.number().int().positive() }),
});
export const totpEnrolment: z.ZodType<TotpEnrolment> = z.object({ otpauthUri: z.string().startsWith('otpauth://'), secret: z.string().min(16) });
export const activationResult: z.ZodType<ActivationResult> = z.object({ recoveryCodes: z.array(z.string().min(8)).min(1) });
export const stepUpGrant = z.object({ token: z.string().min(20), expiresInSeconds: z.number().positive() });

// --- Account data -------------------------------------------------------------

export const companyProfile: z.ZodType<CompanyProfile> = z.object({ id: text, companyName: text, planName: nullableText });
export const balance: z.ZodType<Balance> = z.object({ id: text, currency, amount: z.string().regex(/^-?\d+(\.\d+)?$/), updatedAt: text });
export const accountDetails: z.ZodType<AccountDetails> = z.object({
  currency,
  accountHolderName: text,
  sortCode: nullableText,
  accountNumber: nullableText,
  iban: nullableText,
  bic: nullableText,
});
export const transaction: z.ZodType<Transaction> = z.object({
  id: text,
  currency,
  amount: decimal,
  direction: z.enum(['credit', 'debit']),
  kind: z.enum(['payment', 'conversion', 'funding', 'fee', 'other']),
  description: text,
  reference: nullableText,
  status: z.enum(['completed', 'pending', 'cancelled']),
  createdAt: text,
});
export function page<T>(item: z.ZodType<T>): z.ZodType<Page<T>> {
  return z.object({
    items: z.array(item),
    page: z.number().int(),
    totalPages: z.number().int(),
    totalItems: z.number().int(),
    nextPage: z.number().int().nullable(),
  });
}
export function listResult<T>(item: z.ZodType<T>): z.ZodType<ListResult<T>> {
  return z.object({ items: z.array(item), truncated: z.boolean() });
}

export const ratePair: z.ZodType<RatePair> = z.object({ base: currency, quote: currency, rate: decimal, asOf: text });
export const rateHistory: z.ZodType<RateHistory> = z.object({
  base: currency,
  quote: currency,
  points: z.array(z.object({ at: text, rate: decimal })),
});
export const quoteRequest: z.ZodType<QuoteRequest> = z.object({
  kind,
  sellCurrency: currency,
  buyCurrency: currency,
  fixedSide,
  amount: decimal,
  settlementDate: isoDate.optional(),
});
export const quote: z.ZodType<Quote> = z.object({
  id: text,
  kind,
  sellCurrency: currency,
  buyCurrency: currency,
  sellAmount: decimal,
  buyAmount: decimal,
  fixedSide,
  rateBase: currency,
  rateQuote: currency,
  rate: decimal,
  createdAt: text,
  expiresAt: text,
  settlementDate: isoDate.nullable(),
});
export const conversion: z.ZodType<Conversion> = z.object({
  id: text,
  reference: text,
  kind,
  status: z.enum(['pending', 'settled', 'cancelled']),
  sellCurrency: currency,
  buyCurrency: currency,
  sellAmount: decimal,
  buyAmount: decimal,
  rateBase: currency,
  rateQuote: currency,
  rate: decimal,
  settlementDate: isoDate,
  createdAt: text,
});
export const forwardContract: z.ZodType<ForwardContract> = z.object({
  id: text,
  reference: text,
  sellCurrency: currency,
  buyCurrency: currency,
  sellAmount: decimal,
  buyAmount: decimal,
  rateBase: currency,
  rateQuote: currency,
  rate: decimal,
  settlementDate: isoDate,
  drawnAmount: decimal,
  remainingAmount: decimal,
});

const entityType = z.enum(['company', 'individual']);
export const beneficiary: z.ZodType<Beneficiary> = z.object({
  id: text,
  name: text,
  entityType,
  currency,
  bankCountry: text,
  accountNumber: nullableText,
  sortCode: nullableText,
  iban: nullableText,
  bic: nullableText,
  routingNumber: nullableText,
});
export const newBeneficiary: z.ZodType<NewBeneficiary> = z.object({
  name: z.string().min(1).max(200),
  entityType,
  currency,
  bankCountry: z.string().regex(/^[A-Z]{2}$/),
  accountNumber: z.string().max(64).optional(),
  sortCode: z.string().max(16).optional(),
  iban: z.string().max(64).optional(),
  bic: z.string().max(16).optional(),
  routingNumber: z.string().max(16).optional(),
});
const paymentStatus = z.enum(['awaiting_approval', 'processing', 'sent', 'failed', 'cancelled', 'unknown']);
export const payment: z.ZodType<Payment> = z.object({
  id: text,
  shortReference: text,
  amount: decimal,
  currency,
  beneficiaryId: text,
  beneficiaryName: nullableText,
  reference: text,
  status: paymentStatus,
  route: z.enum(['local', 'swift']).nullable(),
  fee: z.object({ amount: decimal, currency }).nullable(),
  estimatedArrival: isoDate.nullable(),
  createdAt: text,
});
/** A payment request body. The idempotency key travels in the Idempotency-Key header. */
export const newPaymentBody = z.object({
  beneficiaryId: z.string().min(1).max(120),
  amount: decimal,
  currency,
  reference: z.string().min(1).max(140),
  reason: z.string().min(1).max(140),
});
export const idempotencyKey = z.string().regex(/^[\w-]{8,120}$/);
export const approvalResult: z.ZodType<ApprovalResult> = z.object({ status: paymentStatus, approvalsRemaining: z.number().int().min(0) });
export const pendingApproval: z.ZodType<PendingApproval> = z.object({
  payment,
  beneficiary: beneficiary.nullable(),
  approvalsRemaining: z.number().int().min(0),
  steps: z.array(z.object({ label: text, status: z.enum(['done', 'waiting_for_you', 'waiting']), at: text.nullable() })),
});

export const errorBody = z.object({
  error: z.object({
    kind: z.string(),
    reason: z.string().optional(),
    fields: z.array(z.string()).optional(),
    retryAfterSeconds: z.number().optional(),
  }),
});
export const ok = z.object({ ok: z.literal(true) });
