/**
 * The provider-neutral contract the app talks to for account data and money
 * actions. Implementations: the Global Connect server over HTTP, and an
 * in-app mock for the offline demo. Selected in src/api/index.ts.
 * Sign-in, activation and step-up are a separate contract: see auth.ts.
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
  ListResult,
  ForwardContract,
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
  Transaction,
} from './types';

export interface ProviderClient {
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

  /** Every saved payee, up to a large cap. `truncated` is true if the cap was reached. */
  listBeneficiaries(): Promise<ListResult<Beneficiary>>;
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
  /** Withdraw a payment that is still waiting for approval. Only a backend that holds payments itself has this. */
  cancelPayment?(paymentId: string): Promise<void>;
}
