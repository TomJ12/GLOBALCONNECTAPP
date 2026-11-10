/**
 * The seam between the adapter and "the wire". The mock server implements this
 * in memory. A real adapter implements it with fetch() against the provider's
 * base URL, sending `params` as a query string (GET) or form data (POST) and
 * `token` in the X-Auth-Token header.
 */
export type TransportParams = Record<string, string | string[] | undefined>;

export interface TransportRequest {
  method: 'GET' | 'POST';
  /** Path including the version prefix, for example "/v2/balances/find". */
  path: string;
  params?: TransportParams;
  token?: string | null;
}

export interface TransportResponse {
  status: number;
  /** Raw body text. The adapter parses and validates it. */
  body: string;
}

export interface Transport {
  /** Resolves for any HTTP status. Rejects only when no response arrived (network failure). */
  request(request: TransportRequest): Promise<TransportResponse>;
}
