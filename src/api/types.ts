/**
 * Provider-neutral domain types. Nothing in here may mention or depend on a
 * specific payments provider. Screens and hooks only ever see these shapes.
 *
 * Amounts and rates are decimal strings (see src/lib/money.ts). Timestamps are
 * ISO 8601 strings; dates without a time are "YYYY-MM-DD".
 */
import type { CurrencyCode, DecimalString } from '@/lib/money';

export type { CurrencyCode, DecimalString };
export type IsoDateTime = string;
export type IsoDate = string;

export interface Money {
  amount: DecimalString;
  currency: CurrencyCode;
}

// --- Auth -------------------------------------------------------------------

export interface MagicLinkRequest {
  requestId: string;
  email: string;
  expiresAt: IsoDateTime;
  /**
   * Only ever set by a mock backend, so the sign-in screen can offer a
   * "complete the link" shortcut. A real backend emails the code instead.
   */
  devCode: string | null;
}

export interface SessionUser {
  id: string;
  email: string;
  displayName: string;
}

export interface Session {
  user: SessionUser;
  /** Opaque credential that lets this device start a new session after a biometric check. */
  deviceCredential: string;
}

export interface CompanyProfile {
  id: string;
  companyName: string;
  /** Commercial plan label. Null when the backend does not supply one. */
  planName: string | null;
}

// --- Accounts ---------------------------------------------------------------

export interface Balance {
  id: string;
  currency: CurrencyCode;
  amount: DecimalString;
  updatedAt: IsoDateTime;
}

/** Details a payer needs to send money into one currency account. */
export interface AccountDetails {
  currency: CurrencyCode;
  accountHolderName: string;
  sortCode: string | null;
  accountNumber: string | null;
  iban: string | null;
  bic: string | null;
}

export type TransactionKind = 'payment' | 'conversion' | 'funding' | 'fee' | 'other';
export type TransactionStatus = 'completed' | 'pending' | 'cancelled';

export interface Transaction {
  id: string;
  currency: CurrencyCode;
  /** Always positive. `direction` says whether money came in or went out. */
  amount: DecimalString;
  direction: 'credit' | 'debit';
  kind: TransactionKind;
  description: string;
  reference: string | null;
  status: TransactionStatus;
  createdAt: IsoDateTime;
}

export interface Page<T> {
  items: T[];
  page: number;
  totalPages: number;
  totalItems: number;
  /** Null on the last page. */
  nextPage: number | null;
}

export interface PageRequest {
  page: number;
  perPage: number;
}

// --- Rates and conversions --------------------------------------------------

/** `rate` is how many units of `quote` one unit of `base` buys. */
export interface RatePair {
  base: CurrencyCode;
  quote: CurrencyCode;
  rate: DecimalString;
  asOf: IsoDateTime;
}

export interface RatePoint {
  at: IsoDateTime;
  rate: DecimalString;
}

export interface RateHistory {
  base: CurrencyCode;
  quote: CurrencyCode;
  points: RatePoint[];
}

export type ConversionKind = 'spot' | 'forward';
export type FixedSide = 'sell' | 'buy';

export interface QuoteRequest {
  kind: ConversionKind;
  sellCurrency: CurrencyCode;
  buyCurrency: CurrencyCode;
  /** Which of the two amounts the customer typed. */
  fixedSide: FixedSide;
  /** The amount on the fixed side. */
  amount: DecimalString;
  /** Required for forwards, ignored for spot. */
  settlementDate?: IsoDate;
}

/** A rate held for the customer until `expiresAt`. */
export interface Quote {
  id: string;
  kind: ConversionKind;
  sellCurrency: CurrencyCode;
  buyCurrency: CurrencyCode;
  sellAmount: DecimalString;
  buyAmount: DecimalString;
  fixedSide: FixedSide;
  /** Market-convention pair the rate is quoted in. */
  rateBase: CurrencyCode;
  rateQuote: CurrencyCode;
  rate: DecimalString;
  createdAt: IsoDateTime;
  expiresAt: IsoDateTime;
  settlementDate: IsoDate | null;
}

export type ConversionStatus = 'pending' | 'settled' | 'cancelled';

export interface Conversion {
  id: string;
  reference: string;
  kind: ConversionKind;
  status: ConversionStatus;
  sellCurrency: CurrencyCode;
  buyCurrency: CurrencyCode;
  sellAmount: DecimalString;
  buyAmount: DecimalString;
  rateBase: CurrencyCode;
  rateQuote: CurrencyCode;
  rate: DecimalString;
  settlementDate: IsoDate;
  createdAt: IsoDateTime;
}

export interface BookConversionRequest {
  quote: Quote;
  /** Same key on a retry means the provider must not book twice. */
  idempotencyKey: string;
}

export interface ForwardContract {
  id: string;
  reference: string;
  sellCurrency: CurrencyCode;
  buyCurrency: CurrencyCode;
  sellAmount: DecimalString;
  buyAmount: DecimalString;
  rateBase: CurrencyCode;
  rateQuote: CurrencyCode;
  rate: DecimalString;
  settlementDate: IsoDate;
  /** Both in the buy currency. drawn + remaining = buyAmount. */
  drawnAmount: DecimalString;
  remainingAmount: DecimalString;
}

// --- Payees and payments ----------------------------------------------------

export type EntityType = 'company' | 'individual';

export interface Beneficiary {
  id: string;
  name: string;
  entityType: EntityType;
  currency: CurrencyCode;
  bankCountry: string;
  accountNumber: string | null;
  sortCode: string | null;
  iban: string | null;
  bic: string | null;
  /** US ABA routing number. */
  routingNumber: string | null;
}

export interface NewBeneficiary {
  name: string;
  entityType: EntityType;
  currency: CurrencyCode;
  bankCountry: string;
  accountNumber?: string;
  sortCode?: string;
  iban?: string;
  bic?: string;
  routingNumber?: string;
}

export type PaymentStatus = 'awaiting_approval' | 'processing' | 'sent' | 'failed' | 'cancelled';
export type PaymentRoute = 'local' | 'swift';

export interface Payment {
  id: string;
  shortReference: string;
  amount: DecimalString;
  currency: CurrencyCode;
  beneficiaryId: string;
  /** Null if the payee can no longer be found. */
  beneficiaryName: string | null;
  reference: string;
  status: PaymentStatus;
  route: PaymentRoute | null;
  /** Null when the provider has not told us the fee. Never guess one. */
  fee: Money | null;
  /** Null when the provider has not told us. Never guess one. */
  estimatedArrival: IsoDate | null;
  createdAt: IsoDateTime;
}

export interface NewPayment {
  beneficiaryId: string;
  amount: DecimalString;
  currency: CurrencyCode;
  reference: string;
  reason: string;
  /** Same key on a retry means the provider must not pay twice. */
  idempotencyKey: string;
}

export type ApprovalStepStatus = 'done' | 'waiting_for_you' | 'waiting';

export interface ApprovalStep {
  label: string;
  status: ApprovalStepStatus;
  at: IsoDateTime | null;
}

export interface PendingApproval {
  payment: Payment;
  /** Approvals still needed before the payment is released, including yours. */
  approvalsRemaining: number;
  steps: ApprovalStep[];
}
