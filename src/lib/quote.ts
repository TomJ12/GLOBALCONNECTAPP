/** Quote expiry logic, kept pure so it can be unit tested without timers. */
import { compareAmounts } from './money';

export interface Expiring {
  expiresAt: string;
}

/** Milliseconds until expiry, never negative. An unparseable timestamp counts as expired. */
export function msUntilExpiry(expiresAt: string, nowMs: number): number {
  const expiry = Date.parse(expiresAt);
  if (Number.isNaN(expiry)) return 0;
  return Math.max(0, expiry - nowMs);
}

/** Whole seconds left, rounded up so the countdown reaches 0 only at expiry. */
export function secondsUntilExpiry(expiresAt: string, nowMs: number): number {
  return Math.ceil(msUntilExpiry(expiresAt, nowMs) / 1000);
}

/**
 * True when the quote can no longer be booked. `safetyMarginMs` treats a quote
 * as expired slightly early so a request cannot arrive after the hold ends.
 */
export function isQuoteExpired(quote: Expiring, nowMs: number, safetyMarginMs = 0): boolean {
  return msUntilExpiry(quote.expiresAt, nowMs) <= safetyMarginMs;
}

/** 24 -> "0:24", 75 -> "1:15". */
export function formatCountdown(totalSeconds: number): string {
  const safe = Math.max(0, Math.floor(totalSeconds));
  const minutes = Math.floor(safe / 60);
  const seconds = safe % 60;
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

export interface QuotedAmounts {
  sellCurrency: string;
  buyCurrency: string;
  sellAmount: string;
  buyAmount: string;
  rate: string;
}

/**
 * True when a booked conversion is exactly what the confirmed quote promised.
 * A mismatch must be shown to the customer, never hidden behind a success screen.
 */
export function conversionMatchesQuote(conversion: QuotedAmounts, quote: QuotedAmounts): boolean {
  const same = (a: string, b: string) => compareAmounts(a, b) === 0;
  try {
    return (
      conversion.sellCurrency === quote.sellCurrency &&
      conversion.buyCurrency === quote.buyCurrency &&
      same(conversion.sellAmount, quote.sellAmount) &&
      same(conversion.buyAmount, quote.buyAmount) &&
      same(conversion.rate, quote.rate)
    );
  } catch {
    return false;
  }
}
