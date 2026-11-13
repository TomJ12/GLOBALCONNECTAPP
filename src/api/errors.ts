/**
 * The one error type that crosses the provider boundary. Adapters convert every
 * failure (network, HTTP status, bad payload) into a ProviderError, so screens
 * never see raw provider text. That matters for compliance as well as UX:
 * provider error messages can contain the provider's name.
 */
export type ProviderErrorKind =
  | 'network'
  | 'timeout'
  | 'unauthorized'
  | 'forbidden'
  | 'rate_limited'
  | 'server'
  | 'malformed_response'
  | 'validation'
  | 'not_found'
  | 'quote_expired'
  | 'insufficient_funds';

const USER_MESSAGES: Record<ProviderErrorKind, string> = {
  network: 'We could not reach the service. Check your connection and try again.',
  timeout: 'This is taking too long. Check your connection and try again.',
  unauthorized: 'Your session has ended. Sign in again to continue.',
  forbidden: 'You do not have permission to do this. Ask an administrator on your account.',
  rate_limited: 'Too many requests. Wait a moment and try again.',
  server: 'Something went wrong on our side. Try again in a moment.',
  malformed_response: 'We received a response we could not read. Try again.',
  validation: 'Some details were not accepted. Check them and try again.',
  not_found: 'We could not find that item. It may have changed.',
  quote_expired: 'That rate has expired. We will get you a new one.',
  insufficient_funds: 'There is not enough money in this balance.',
};

/**
 * Finer-grained causes for sign-in, activation and step-up. The `kind` stays one
 * of the neutral kinds above; a reason only chooses clearer wording.
 */
export type ProviderErrorReason =
  | 'invalid_credentials'
  | 'invalid_code'
  | 'code_reused'
  | 'locked'
  | 'challenge_expired'
  | 'activation_invalid'
  | 'weak_password'
  | 'step_up_required'
  | 'step_up_invalid'
  | 'company_not_selected'
  | 'not_supported'
  | 'creator_cannot_approve'
  | 'already_approved'
  | 'payment_expired'
  | 'payee_changed'
  | 'not_awaiting_approval'
  | 'creator_unavailable';

const REASON_MESSAGES: Record<ProviderErrorReason, string> = {
  invalid_credentials: 'That email and password do not match an account. Check them and try again.',
  invalid_code: 'That code is not right. Check your authenticator app and try again.',
  code_reused: 'That code has already been used. Wait for your authenticator app to show the next one.',
  locked: 'Too many attempts. Wait a while before trying again.',
  challenge_expired: 'That took too long. Start again.',
  activation_invalid: 'That activation code is not valid or has expired. Ask Global Connect for a new one.',
  weak_password: 'That password is not allowed. Use at least 12 characters and avoid common passwords.',
  step_up_required: 'This needs a code from your authenticator app. Try again.',
  step_up_invalid: 'The code check for this action has expired or does not match. Try again.',
  company_not_selected: 'Choose a company to continue.',
  not_supported: 'This is not available on your account.',
  creator_cannot_approve: 'You created this payment, so someone else has to approve it.',
  already_approved: 'You have already approved this payment. Someone else has to give the next approval.',
  payment_expired: 'This payment waited too long for approval and has expired. It was not sent. Create it again if it is still needed.',
  payee_changed: 'The payee’s bank details changed after this payment was created, so it was not sent. Create the payment again.',
  not_awaiting_approval: 'This payment is no longer waiting for approval.',
  creator_unavailable: 'The person who created this payment can no longer make payments for this company, so it cannot be approved. Reject it instead.',
};

const REASONS = new Set<string>(Object.keys(REASON_MESSAGES));
export function isProviderErrorReason(value: unknown): value is ProviderErrorReason {
  return typeof value === 'string' && REASONS.has(value);
}

const RETRYABLE: ReadonlySet<ProviderErrorKind> = new Set(['network', 'timeout', 'rate_limited', 'server', 'malformed_response']);
/**
 * Failures where a request that changes something may still have been applied:
 * no answer arrived, or the answer could not be read.
 */
const OUTCOME_UNKNOWN: ReadonlySet<ProviderErrorKind> = new Set(['network', 'timeout', 'server', 'malformed_response']);

export interface ProviderErrorOptions {
  /** Internal detail for logs and tests. Never shown to the customer. */
  detail?: string;
  /** Names of request fields the provider rejected, if known. */
  fields?: string[];
  status?: number;
  cause?: unknown;
  reason?: ProviderErrorReason;
  /** For `locked` and `rate_limited`: how long to wait, when the backend says. */
  retryAfterSeconds?: number;
}

export class ProviderError extends Error {
  readonly kind: ProviderErrorKind;
  readonly detail: string | undefined;
  readonly fields: readonly string[];
  readonly status: number | undefined;
  readonly reason: ProviderErrorReason | undefined;
  readonly retryAfterSeconds: number | undefined;

  constructor(kind: ProviderErrorKind, options: ProviderErrorOptions = {}) {
    super(options.reason ? REASON_MESSAGES[options.reason] : USER_MESSAGES[kind]);
    this.name = 'ProviderError';
    this.kind = kind;
    this.detail = options.detail;
    this.fields = options.fields ?? [];
    this.status = options.status;
    this.reason = options.reason;
    this.retryAfterSeconds = options.retryAfterSeconds;
    if (options.cause !== undefined) {
      (this as { cause?: unknown }).cause = options.cause;
    }
  }

  /** Safe to show to the customer. */
  get userMessage(): string {
    if (this.reason === 'locked' && this.retryAfterSeconds !== undefined) {
      const minutes = Math.max(1, Math.ceil(this.retryAfterSeconds / 60));
      return `Too many attempts. Try again in about ${minutes} minute${minutes === 1 ? '' : 's'}.`;
    }
    return this.reason ? REASON_MESSAGES[this.reason] : USER_MESSAGES[this.kind];
  }

  /**
   * For a request that changes something: true when we cannot tell whether it
   * was applied. The caller must check before letting the person try again.
   */
  get outcomeUnknown(): boolean {
    return OUTCOME_UNKNOWN.has(this.kind);
  }

  /** Whether trying the same request again could succeed. */
  get retryable(): boolean {
    return RETRYABLE.has(this.kind);
  }
}

export function isProviderError(error: unknown): error is ProviderError {
  return error instanceof ProviderError;
}

/** Normalise anything thrown into a ProviderError. Unknown errors become `server`. */
export function toProviderError(error: unknown): ProviderError {
  if (isProviderError(error)) return error;
  return new ProviderError('server', {
    detail: error instanceof Error ? error.message : String(error),
    cause: error,
  });
}

/** Customer-safe message for anything thrown. */
export function userMessageFor(error: unknown): string {
  return toProviderError(error).userMessage;
}
