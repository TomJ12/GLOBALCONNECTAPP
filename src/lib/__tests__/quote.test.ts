import { conversionMatchesQuote, formatCountdown, isQuoteExpired, msUntilExpiry, secondsUntilExpiry } from '../quote';

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

describe('conversionMatchesQuote', () => {
  const quoted = { sellCurrency: 'GBP', buyCurrency: 'USD', sellAmount: '1000.00', buyAmount: '1300.00', rate: '1.3000' };

  it('accepts the same figures however they are written', () => {
    expect(conversionMatchesQuote({ ...quoted, sellAmount: '1000', rate: '1.3' }, quoted)).toBe(true);
  });

  it('flags any difference in amount, rate or currency', () => {
    expect(conversionMatchesQuote({ ...quoted, buyAmount: '1299.99' }, quoted)).toBe(false);
    expect(conversionMatchesQuote({ ...quoted, sellAmount: '1000.01' }, quoted)).toBe(false);
    expect(conversionMatchesQuote({ ...quoted, rate: '1.2999' }, quoted)).toBe(false);
    expect(conversionMatchesQuote({ ...quoted, buyCurrency: 'EUR' }, quoted)).toBe(false);
    expect(conversionMatchesQuote({ ...quoted, buyAmount: 'lots' }, quoted)).toBe(false);
  });
});
