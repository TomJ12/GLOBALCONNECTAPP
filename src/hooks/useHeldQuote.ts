import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';

import { getProviderClient } from '@/api';
import { toProviderError, type ProviderError } from '@/api/errors';
import type { Quote, QuoteRequest } from '@/api/types';
import { isQuoteExpired, secondsUntilExpiry } from '@/lib/quote';

export const QUOTE_DEBOUNCE_MS = 400;
/** After this many automatic re-quotes for one request, the person has to ask for a new rate. */
export const MAX_AUTO_REQUOTES = 1;
const TICK_MS = 250;

export interface HeldQuote {
  /** The quote for the current request, or null while there is none. Never a quote for an older request. */
  quote: Quote | null;
  /** Whole seconds until the held rate expires. 0 when expired or when there is no quote. */
  secondsLeft: number;
  isExpired: boolean;
  isFetching: boolean;
  error: ProviderError | null;
  /** Ask for a fresh quote now. Also allows automatic re-quoting again. */
  refresh: () => void;
}

export interface HeldQuoteOptions {
  /** True while a booking is in flight, so the quote is not swapped underneath it. */
  paused?: boolean;
  /** False while the screen is not focused or the app is in the background. */
  active?: boolean;
}

export function quoteRequestKey(request: QuoteRequest | null): string {
  if (!request) return '';
  return [request.kind, request.sellCurrency, request.buyCurrency, request.fixedSide, request.amount, request.settlementDate ?? ''].join('|');
}

/**
 * Keeps a held-rate quote for `request`:
 *  - waits for typing to pause, then asks for a quote;
 *  - counts down to its expiry;
 *  - when it expires, asks for a new one automatically at most MAX_AUTO_REQUOTES
 *    times, and never while paused, unfocused or in the background. After that it
 *    stays expired until `refresh()` is called, so an idle screen stops quoting;
 *  - ignores answers to requests that are no longer current.
 * Quotes are fetched through the query client so a 401 ends the session like any other call.
 */
export function useHeldQuote(request: QuoteRequest | null, options: HeldQuoteOptions = {}): HeldQuote {
  const paused = options.paused ?? false;
  const active = options.active ?? true;
  const key = quoteRequestKey(request);
  const queryClient = useQueryClient();
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
  const autoRequotes = useRef({ key: '', count: 0 });

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
    queryClient
      .fetchQuery({
        // Unique per attempt: a held quote must never be served from cache.
        queryKey: ['heldQuote', currentKey, mine],
        queryFn: () => getProviderClient().createQuote(current),
        staleTime: 0,
        gcTime: 0,
        retry: false,
      })
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
  }, [queryClient]);

  const refresh = useCallback(() => {
    autoRequotes.current = { key: latestKey.current, count: 0 };
    fetchQuote();
  }, [fetchQuote]);

  // New request: fetch after a short pause in typing. State for an older
  // request is never shown, because everything below is matched against `key`.
  useEffect(() => {
    sequence.current += 1;
    if (key === '') return;
    const timer = setTimeout(fetchQuote, QUOTE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [key, fetchQuote]);

  // A quote belongs to the request it was made for. As soon as the request changes
  // (even to nothing, and even if it later changes back) the old quote is dropped,
  // so a used or stale quote can never be offered again.
  if (state.key !== key && (state.quote !== null || state.error !== null)) {
    setState({ key: '', quote: null, error: null, isFetching: false });
  }

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

  // Expired: get a new rate, within the automatic budget for this request.
  const requotedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!quote || !isExpired || paused || !active || isFetching) return;
    if (requotedFor.current === quote.id) return;
    if (autoRequotes.current.key !== key) autoRequotes.current = { key, count: 0 };
    if (autoRequotes.current.count >= MAX_AUTO_REQUOTES) return;
    autoRequotes.current.count += 1;
    requotedFor.current = quote.id;
    fetchQuote();
  }, [quote, isExpired, paused, active, isFetching, key, fetchQuote]);

  return {
    quote,
    secondsLeft: quote ? secondsUntilExpiry(quote.expiresAt, nowMs) : 0,
    isExpired,
    isFetching,
    error,
    refresh,
  };
}
