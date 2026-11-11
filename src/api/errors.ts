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
}

export class ProviderError extends Error {
  readonly kind: ProviderErrorKind;
  readonly detail: string | undefined;
  readonly fields: readonly string[];
  readonly status: number | undefined;

  constructor(kind: ProviderErrorKind, options: ProviderErrorOptions = {}) {
    super(USER_MESSAGES[kind]);
    this.name = 'ProviderError';
    this.kind = kind;
    this.detail = options.detail;
    this.fields = options.fields ?? [];
    this.status = options.status;
    if (options.cause !== undefined) {
      (this as { cause?: unknown }).cause = options.cause;
    }
  }

  /** Safe to show to the customer. */
  get userMessage(): string {
    return USER_MESSAGES[this.kind];
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
