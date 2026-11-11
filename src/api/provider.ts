/**
 * The provider-neutral contract the app talks to. One implementation exists
 * today (an in-memory mock); a real adapter implements the same interface and
 * is selected in src/api/index.ts.
 *
 * Every method rejects with a ProviderError (src/api/errors.ts) and nothing else.
 */
import type {
  AccountDetails,
  ApprovalResult,
  Balance,
  Beneficiary,
  BookConversionRequest,
  CompanyProfile,
  Conversion,
  CurrencyCode,
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
} from './types';

export interface ProviderClient {
  // Sign-in. The client keeps the session token internally.
  requestMagicLink(email: string): Promise<MagicLinkRequest>;
  verifyMagicLink(requestId: string, code: string): Promise<Session>;
  signOut(): Promise<void>;

  getCompanyProfile(): Promise<CompanyProfile>;
  listBalances(): Promise<Balance[]>;
  getAccountDetails(currency: CurrencyCode): Promise<AccountDetails>;
  listTransactions(request: PageRequest): Promise<Page<Transaction>>;

  /** Live indicative rate: units of `quote` per one `base`. */
  getRate(base: CurrencyCode, quote: CurrencyCode): Promise<RatePair>;
  /** Recent rate points for a sparkline. */
  getRateHistory(base: CurrencyCode, quote: CurrencyCode): Promise<RateHistory>;
  /** A rate held until `expiresAt`. */
  createQuote(request: QuoteRequest): Promise<Quote>;
  /** Book a spot or forward conversion at a held quote. */
  bookConversion(request: BookConversionRequest): Promise<Conversion>;
  /**
   * Reconciliation: the conversion booked with this key, or null if there is none.
   * Used after a booking whose outcome is unknown, before allowing another attempt.
   */
  findConversionByIdempotencyKey(idempotencyKey: string): Promise<Conversion | null>;
  listForwardContracts(): Promise<ForwardContract[]>;

  listBeneficiaries(): Promise<Beneficiary[]>;
  createBeneficiary(input: NewBeneficiary): Promise<Beneficiary>;

  listPayments(request: PageRequest): Promise<Page<Payment>>;
  createPayment(input: NewPayment): Promise<Payment>;
  /** Reconciliation: the payment created with this key, or null if there is none. */
  findPaymentByIdempotencyKey(idempotencyKey: string): Promise<Payment | null>;
  listPendingApprovals(): Promise<PendingApproval[]>;
  /**
   * Record this person's approval. Safe to repeat: a payment that is no longer
   * waiting for approval is rejected with a `validation` error, never paid twice.
   */
  approvePayment(paymentId: string): Promise<ApprovalResult>;
  rejectPayment(paymentId: string): Promise<void>;
}
