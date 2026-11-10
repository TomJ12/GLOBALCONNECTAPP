import { formatCountdown, isQuoteExpired, msUntilExpiry, secondsUntilExpiry } from '../quote';

const T0 = Date.parse('2026-11-10T12:00:00.000Z');
const quote = { expiresAt: '2026-11-10T12:00:30.000Z' };

describe('quote expiry', () => {
  it('counts down to the expiry time', () => {
    expect(msUntilExpiry(quote.expiresAt, T0)).toBe(30_000);
    expect(secondsUntilExpiry(quote.expiresAt, T0)).toBe(30);
    expect(secondsUntilExpiry(quote.expiresAt, T0 + 5_400)).toBe(25);
    expect(secondsUntilExpiry(quote.expiresAt, T0 + 29_999)).toBe(1);
    expect(secondsUntilExpiry(quote.expiresAt, T0 + 30_000)).toBe(0);
    expect(secondsUntilExpiry(quote.expiresAt, T0 + 99_000)).toBe(0);
  });

  it('is expired exactly at the expiry time, not before', () => {
    expect(isQuoteExpired(quote, T0)).toBe(false);
    expect(isQuoteExpired(quote, T0 + 29_999)).toBe(false);
    expect(isQuoteExpired(quote, T0 + 30_000)).toBe(true);
    expect(isQuoteExpired(quote, T0 + 30_001)).toBe(true);
  });

  it('honours a safety margin', () => {
    expect(isQuoteExpired(quote, T0 + 28_999, 1000)).toBe(false);
    expect(isQuoteExpired(quote, T0 + 29_000, 1000)).toBe(true);
  });

  it('treats an unreadable expiry as expired', () => {
    expect(isQuoteExpired({ expiresAt: 'not a date' }, T0)).toBe(true);
    expect(secondsUntilExpiry('', T0)).toBe(0);
  });

  it('formats the countdown', () => {
    expect(formatCountdown(24)).toBe('0:24');
    expect(formatCountdown(75)).toBe('1:15');
    expect(formatCountdown(0)).toBe('0:00');
    expect(formatCountdown(-3)).toBe('0:00');
    expect(formatCountdown(9.9)).toBe('0:09');
  });
});
