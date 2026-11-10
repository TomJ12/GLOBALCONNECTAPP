import {
  addAmounts,
  compareAmounts,
  currencyDecimals,
  divideByRate,
  formatMoney,
  formatRate,
  isDecimalString,
  multiplyByRate,
  parseAmountInput,
  roundToCurrency,
  sanitizeAmountInput,
  subtractAmounts,
  totalInBaseCurrency,
} from '../money';

const NBSP = ' ';

describe('formatMoney', () => {
  it('formats 2-decimal currencies with grouping', () => {
    expect(formatMoney('101964', 'GBP')).toBe('£101,964.00');
    expect(formatMoney('57891.00', 'USD')).toBe('$57,891.00');
    expect(formatMoney('24310.5', 'EUR')).toBe('€24,310.50');
    expect(formatMoney('0', 'GBP')).toBe('£0.00');
    expect(formatMoney('1234567.891', 'AED')).toBe(`AED${NBSP}1,234,567.89`);
  });

  it('uses 0 decimals for JPY and 3 for KWD', () => {
    expect(formatMoney('1234567', 'JPY')).toBe('¥1,234,567');
    expect(formatMoney('1234.5', 'JPY')).toBe('¥1,235');
    expect(formatMoney('1234.5', 'KWD')).toBe(`KWD${NBSP}1,234.500`);
    expect(formatMoney('0.0005', 'KWD')).toBe(`KWD${NBSP}0.001`);
    expect(currencyDecimals('JPY')).toBe(0);
    expect(currencyDecimals('KWD')).toBe(3);
    expect(currencyDecimals('ZZZ')).toBe(2);
  });

  it('rounds half up without float error', () => {
    expect(formatMoney('1.005', 'GBP')).toBe('£1.01');
    expect(formatMoney('2.675', 'USD')).toBe('$2.68');
    expect(formatMoney('0.1', 'GBP')).toBe('£0.10');
  });

  it('handles signs, options and unknown currencies', () => {
    expect(formatMoney('-24557', 'USD')).toBe('−$24,557.00');
    expect(formatMoney('42733', 'GBP', { showPlus: true })).toBe('+£42,733.00');
    expect(formatMoney('0', 'GBP', { showPlus: true })).toBe('£0.00');
    expect(formatMoney('-0.001', 'GBP')).toBe('£0.00');
    expect(formatMoney('1000', 'GBP', { withSymbol: false })).toBe('1,000.00');
    expect(formatMoney('5', 'SEK')).toBe(`SEK${NBSP}5.00`);
  });

  it('keeps precision beyond what a float can hold', () => {
    expect(formatMoney('9007199254740993.27', 'GBP')).toBe('£9,007,199,254,740,993.27');
  });

  it('returns a dash for anything that is not a decimal string', () => {
    for (const bad of ['', 'abc', '1e5', '1,000', 'NaN', ' 1', '1.', '.5']) {
      expect(formatMoney(bad, 'GBP')).toBe('—');
    }
    expect(formatMoney(undefined as unknown as string, 'GBP')).toBe('—');
  });
});

describe('arithmetic', () => {
  it('adds and subtracts exactly', () => {
    expect(addAmounts('0.1', '0.2')).toBe('0.3');
    expect(subtractAmounts('101964.00', '25000')).toBe('76964');
    expect(compareAmounts('10.00', '10')).toBe(0);
    expect(compareAmounts('9.99', '10')).toBe(-1);
    expect(compareAmounts('10.01', '10')).toBe(1);
  });

  it('converts with a rate and rounds to the target currency', () => {
    expect(multiplyByRate('25000', '1.3000', 'USD')).toBe('32500.00');
    expect(divideByRate('57891.00', '1.3000', 'GBP')).toBe('44531.54');
    expect(multiplyByRate('100', '195.557', 'JPY')).toBe('19556');
    expect(multiplyByRate('1', '0.40005', 'KWD')).toBe('0.400');
    expect(() => divideByRate('1', '0', 'GBP')).toThrow(RangeError);
    expect(() => multiplyByRate('x', '1', 'GBP')).toThrow(RangeError);
  });

  it('rounds to minor units', () => {
    expect(roundToCurrency('1.005', 'GBP')).toBe('1.01');
    expect(roundToCurrency('1.5', 'JPY')).toBe('2');
  });

  it('formats rates', () => {
    expect(formatRate('1.3')).toBe('1.3000');
    expect(formatRate('1.101694')).toBe('1.1017');
    expect(formatRate('nope')).toBe('—');
  });
});

describe('totalInBaseCurrency', () => {
  const balances = [
    { currency: 'GBP', amount: '101964.00' },
    { currency: 'USD', amount: '57891.00' },
    { currency: 'EUR', amount: '24310.50' },
  ];

  it('reproduces the sample Home total', () => {
    const result = totalInBaseCurrency(balances, 'GBP', { USD: '1.3000', EUR: '1.1800' });
    expect(result).toEqual({ total: '167097.66', missing: [] });
  });

  it('reports currencies without a usable rate instead of guessing', () => {
    expect(totalInBaseCurrency(balances, 'GBP', { USD: '1.3000' })).toEqual({ total: '146495.54', missing: ['EUR'] });
    expect(totalInBaseCurrency(balances, 'GBP', { USD: '0', EUR: 'bad' }).missing).toEqual(['USD', 'EUR']);
    expect(totalInBaseCurrency([], 'GBP', {})).toEqual({ total: '0.00', missing: [] });
  });
});

describe('amount input', () => {
  it('sanitises typing', () => {
    expect(sanitizeAmountInput('25,000.509', 'GBP')).toBe('25000.50');
    expect(sanitizeAmountInput('abc12.3.4', 'GBP')).toBe('12.34');
    expect(sanitizeAmountInput('.5', 'GBP')).toBe('0.5');
    expect(sanitizeAmountInput('007', 'GBP')).toBe('7');
    expect(sanitizeAmountInput('12.', 'GBP')).toBe('12.');
    expect(sanitizeAmountInput('1500.75', 'JPY')).toBe('1500');
    expect(sanitizeAmountInput('1.23456', 'KWD')).toBe('1.234');
    expect(sanitizeAmountInput('-5', 'GBP')).toBe('5');
    expect(sanitizeAmountInput('1'.repeat(30), 'GBP')).toHaveLength(12);
  });

  it('parses to a positive decimal string or null', () => {
    expect(parseAmountInput('25000', 'GBP')).toBe('25000.00');
    expect(parseAmountInput('12.', 'GBP')).toBe('12.00');
    expect(parseAmountInput('1500', 'JPY')).toBe('1500');
    expect(parseAmountInput('', 'GBP')).toBeNull();
    expect(parseAmountInput('0', 'GBP')).toBeNull();
    expect(parseAmountInput('0.00', 'GBP')).toBeNull();
    expect(parseAmountInput('.', 'GBP')).toBeNull();
  });

  it('recognises decimal strings', () => {
    expect(isDecimalString('12.50')).toBe(true);
    expect(isDecimalString('-3')).toBe(true);
    expect(isDecimalString(12.5)).toBe(false);
    expect(isDecimalString('1e3')).toBe(false);
  });
});
