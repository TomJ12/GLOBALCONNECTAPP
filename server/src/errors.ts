import type { ProviderErrorKind, ProviderErrorReason } from '@/api/errors';

const STATUS: Record<ProviderErrorKind, number> = {
  validation: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  quote_expired: 409,
  insufficient_funds: 422,
  rate_limited: 429,
  server: 502,
  malformed_response: 502,
  network: 502,
  timeout: 504,
};

/**
 * An error the app is allowed to see: one of its neutral kinds, optionally a
 * reason and field names. Never free text, so nothing internal (a provider's
 * name, an upstream message) can travel in it.
 */
export class ApiError extends Error {
  readonly status: number;
  constructor(
    readonly kind: ProviderErrorKind,
    readonly options: { reason?: ProviderErrorReason; fields?: string[]; retryAfterSeconds?: number; status?: number } = {},
  ) {
    super(options.reason ?? kind);
    this.status = options.status ?? STATUS[kind];
  }

  body(): { error: { kind: string; reason?: string; fields?: string[]; retryAfterSeconds?: number } } {
    const { reason, fields, retryAfterSeconds } = this.options;
    return {
      error: {
        kind: this.kind,
        ...(reason ? { reason } : {}),
        ...(fields && fields.length > 0 ? { fields } : {}),
        ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
      },
    };
  }
}
