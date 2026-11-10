import { useCallback, useEffect, useRef, useState } from 'react';

import { getProviderClient } from '@/api';
import { toProviderError, type ProviderError } from '@/api/errors';
import type { Quote, QuoteRequest } from '@/api/types';
import { isQuoteExpired, secondsUntilExpiry } from '@/lib/quote';

export const QUOTE_DEBOUNCE_MS = 400;
const TICK_MS = 250;

export interface HeldQuote {
  /** The quote for the current request, or null while there is none. Never a quote for an older request. */
  quote: Quote | null;
  /** Whole seconds until the held rate expires. 0 when expired or when there is no quote. */
  secondsLeft: number;
  isExpired: boolean;
  isFetching: boolean;
  error: ProviderError | null;
  /** Ask for a fresh quote now. */
  refresh: () => void;
}

function requestKey(request: QuoteRequest | null): string {
  if (!request) return '';
  return [request.kind, request.sellCurrency, request.buyCurrency, request.fixedSide, request.amount, request.settlementDate ?? ''].join('|');
}

/**
 * Keeps a held-rate quote for `request`:
 *  - waits for typing to pause, then asks for a quote;
 *  - counts down to its expiry;
 *  - asks for a new one when it expires (once; if that fails it stops and
 *    reports the error rather than retrying in a loop);
 *  - ignores answers to requests that are no longer current.
 * Pass `paused` while a booking is in flight so the quote is not swapped underneath it.
 */
export function useHeldQuote(request: QuoteRequest | null, options: { paused?: boolean } = {}): HeldQuote {
  const paused = options.paused ?? false;
  const key = requestKey(request);
  const [state, setState] = useState<{ key: string; quote: Quote | null; error: ProviderError | null; isFetching: boolean }>({
    key: '',
    quote: null,
    error: null,
    isFetching: false,
  });
  const [nowMs, setNowMs] = useState(() => Date.now());
  const latestRequest = useRef(request);
  const latestKey = useRef(key);
  const sequence = useRef(0);
  const mounted = useRef(true);

  useEffect(() => {
    latestRequest.current = request;
    latestKey.current = key;
  });
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const fetchQuote = useCallback(() => {
    const current = latestRequest.current;
    const currentKey = latestKey.current;
    if (!current) return;
    sequence.current += 1;
    const mine = sequence.current;
    setState((previous) => ({
      key: currentKey,
      quote: previous.key === currentKey ? previous.quote : null,
      error: null,
      isFetching: true,
    }));
    getProviderClient()
      .createQuote(current)
      .then(
        (quote) => {
          if (!mounted.current || mine !== sequence.current) return;
          setNowMs(Date.now());
          setState({ key: currentKey, quote, error: null, isFetching: false });
        },
        (error: unknown) => {
          if (!mounted.current || mine !== sequence.current) return;
          setState((previous) => ({
            key: currentKey,
            quote: previous.key === currentKey ? previous.quote : null,
            error: toProviderError(error),
            isFetching: false,
          }));
        },
      );
  }, []);

  // New request: fetch after a short pause in typing. State for an older
  // request is never shown, because everything below is matched against `key`.
  useEffect(() => {
    sequence.current += 1;
    if (key === '') return;
    const timer = setTimeout(fetchQuote, QUOTE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [key, fetchQuote]);

  const quote = state.key === key ? state.quote : null;
  const error = state.key === key ? state.error : null;
  const isFetching = state.key === key ? state.isFetching : key !== '';

  // Tick while a quote is on screen.
  useEffect(() => {
    if (!quote) return;
    const timer = setInterval(() => setNowMs(Date.now()), TICK_MS);
    return () => clearInterval(timer);
  }, [quote]);

  const isExpired = quote ? isQuoteExpired(quote, nowMs) : false;

  // Expired: get a new rate, once per quote.
  const requotedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!quote || !isExpired || paused || isFetching) return;
    if (requotedFor.current === quote.id) return;
    requotedFor.current = quote.id;
    fetchQuote();
  }, [quote, isExpired, paused, isFetching, fetchQuote]);

  return {
    quote,
    secondsLeft: quote ? secondsUntilExpiry(quote.expiresAt, nowMs) : 0,
    isExpired,
    isFetching,
    error,
    refresh: fetchQuote,
  };
}
