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

// --- Sign-in, activation and step-up ------------------------------------------

export interface SessionUser {
  id: string;
  email: string;
  displayName: string;
}

/** A company the signed-in person can act for. */
export interface CompanyOption {
  id: string;
  name: string;
}

export type UserRole = 'creator' | 'approver' | 'admin';

/** What the selected company's account supports. The app hides what is not supported. */
export interface Capabilities {
  forwardContracts: boolean;
  paymentApprovals: boolean;
}

/** Actions that can need a fresh authenticator code. */
export type StepUpAction = 'payment.create' | 'payment.approve' | 'payment.reject' | 'payment.cancel' | 'beneficiary.create' | 'conversion.book';

/** A signed-in person acting for one company. */
export interface Session {
  user: SessionUser;
  company: CompanyOption;
  role: UserRole;
  capabilities: Capabilities;
  /** Actions the backend will refuse without a fresh authenticator code. */
  stepUpActions: StepUpAction[];
}

/** Password accepted; a code from the authenticator app is needed next. */
export interface LoginChallenge {
  challengeId: string;
}

export type CodeMethod = 'totp' | 'recovery';

/** Signed in. `session` is null until a company is chosen (only when there are several). */
export interface SignInResult {
  user: SessionUser;
  companies: CompanyOption[];
  session: Session | null;
}

export interface PasswordPolicy {
  minLength: number;
}

export interface ActivationStart {
  email: string;
  displayName: string;
  passwordPolicy: PasswordPolicy;
}

/** What the authenticator app needs: scan `otpauthUri` as a QR code or type `secret`. */
export interface TotpEnrolment {
  otpauthUri: string;
  secret: string;
}

export interface ActivationResult {
  /** Shown once. Each works one time in place of an authenticator code at sign-in. */
  recoveryCodes: string[];
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

/** A list that may have been cut short. `truncated` means more exist than were read. */
export interface ListResult<T> {
  items: T[];
  truncated: boolean;
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

/** 'unknown' means the backend reported a status this app does not recognise. Never treat it as success. */
export type PaymentStatus = 'awaiting_approval' | 'processing' | 'sent' | 'failed' | 'cancelled' | 'unknown';
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
  /**
   * Present only on a payment that Global Connect is holding (or held) until
   * the company's approvers have approved it. Such a payment has NOT been
   * sent to the bank and no money is set aside for it.
   */
  held?: PaymentHold;
}

export type PaymentHoldState = 'awaiting_approval' | 'sending' | 'rejected' | 'cancelled' | 'expired' | 'payee_changed' | 'failed';

export interface PaymentHold {
  state: PaymentHoldState;
  /** Display name of the person who created it. */
  createdBy: string;
  createdByYou: boolean;
  approvalsRequired: number;
  approvals: { by: string; at: IsoDateTime }[];
  /** After this moment it can no longer be approved. */
  expiresAt: IsoDateTime;
  /** Whether the person asking may approve or reject it now. Never true for its creator. */
  canApprove: boolean;
  /** Whether the person asking may cancel it now. */
  canCancel: boolean;
  /** Display names of the people who could still approve it. Empty means nobody can: the company needs another approver. */
  approvers: string[];
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

/** What the backend said after an approval was recorded. */
export interface ApprovalResult {
  status: PaymentStatus;
  /** Approvals still needed after yours. 0 means the payment is released. */
  approvalsRemaining: number;
}

export type ApprovalStepStatus = 'done' | 'waiting_for_you' | 'waiting';

export interface ApprovalStep {
  label: string;
  status: ApprovalStepStatus;
  at: IsoDateTime | null;
}

export interface PendingApproval {
  payment: Payment;
  /**
   * True for a payment that is waiting for approval somewhere other than
   * Global Connect (it was already pending there before approvals were held
   * here). Approving it does not go through Global Connect's own rules.
   */
  external?: boolean;
  /** The payee's saved details. Null if they could not be found: such a payment must not be approved. */
  beneficiary: Beneficiary | null;
  /** Approvals still needed before the payment is released, including yours. */
  approvalsRemaining: number;
  steps: ApprovalStep[];
}
