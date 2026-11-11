import {
  addAmounts,
  compareAmounts,
  currencyDecimals,
  divideByRate,
  formatMoney,
  formatRate,
  isDecimalString,
  multiplyByRate,
  amountInputMessage,
  parseAmountInput,
  readAmountInput,
  roundToCurrency,
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
  const ok = (amount: string) => ({ ok: true, amount });
  const bad = (problem: string) => ({ ok: false, problem });

  it('reads plain amounts and pads to the currency', () => {
    expect(readAmountInput('25000', 'GBP')).toEqual(ok('25000.00'));
    expect(readAmountInput(' 12.5 ', 'GBP')).toEqual(ok('12.50'));
    expect(readAmountInput('12.', 'GBP')).toEqual(ok('12.00'));
    expect(readAmountInput('.5', 'GBP')).toEqual(ok('0.50'));
    expect(readAmountInput('007', 'GBP')).toEqual(ok('7.00'));
    expect(readAmountInput('1500', 'JPY')).toEqual(ok('1500'));
    expect(readAmountInput('1.234', 'KWD')).toEqual(ok('1.234'));
  });

  it('treats a lone comma as the decimal separator', () => {
    expect(readAmountInput('1234,56', 'EUR')).toEqual(ok('1234.56'));
    expect(readAmountInput('1,5', 'EUR')).toEqual(ok('1.50'));
    expect(readAmountInput('0,234', 'KWD')).toEqual(ok('0.234'));
    expect(readAmountInput('12,', 'EUR')).toEqual(ok('12.00'));
  });

  it('reads clearly grouped forms', () => {
    expect(readAmountInput('1,234.56', 'GBP')).toEqual(ok('1234.56'));
    expect(readAmountInput('1.234,56', 'EUR')).toEqual(ok('1234.56'));
    expect(readAmountInput('1,234,567', 'GBP')).toEqual(ok('1234567.00'));
    expect(readAmountInput('1.234.567', 'EUR')).toEqual(ok('1234567.00'));
    expect(readAmountInput('12,345,678.9', 'USD')).toEqual(ok('12345678.90'));
  });

  it('rejects ambiguous input instead of guessing', () => {
    // One thousand two hundred and thirty-four, or 1.234?
    expect(readAmountInput('1,234', 'GBP')).toEqual(bad('ambiguous'));
    expect(readAmountInput('1,234', 'KWD')).toEqual(bad('ambiguous'));
    expect(readAmountInput('999,000', 'EUR')).toEqual(bad('ambiguous'));
  });

  it('rejects malformed input instead of reshaping it', () => {
    for (const text of ['1e3', '-50', '+5', 'abc', '12abc', '1 000', '£10', '1..2', '1,,2', '1,23,456', '12,34.5', '1.2,3.4', '.', ',', '1.234.56', '١٢٣']) {
      expect(readAmountInput(text, 'GBP')).toEqual(bad('invalid'));
    }
  });

  it('rejects extra decimals rather than truncating them', () => {
    expect(readAmountInput('25000.509', 'GBP')).toEqual(bad('too_many_decimals'));
    expect(readAmountInput('1.234', 'GBP')).toEqual(bad('too_many_decimals'));
    expect(readAmountInput('100.55', 'JPY')).toEqual(bad('too_many_decimals'));
    expect(readAmountInput('1500,5', 'JPY')).toEqual(bad('too_many_decimals'));
    expect(readAmountInput('1.2345', 'KWD')).toEqual(bad('too_many_decimals'));
  });

  it('rejects empty, zero and absurdly large input', () => {
    expect(readAmountInput('', 'GBP')).toEqual(bad('empty'));
    expect(readAmountInput('   ', 'GBP')).toEqual(bad('empty'));
    expect(readAmountInput('0', 'GBP')).toEqual(bad('zero'));
    expect(readAmountInput('0.00', 'GBP')).toEqual(bad('zero'));
    expect(readAmountInput('1'.repeat(13), 'GBP')).toEqual(bad('too_large'));
    expect(readAmountInput('1'.repeat(12), 'GBP').ok).toBe(true);
  });

  it('parseAmountInput is null for anything rejected', () => {
    expect(parseAmountInput('25000', 'GBP')).toBe('25000.00');
    expect(parseAmountInput('1e3', 'GBP')).toBeNull();
    expect(parseAmountInput('1,234', 'GBP')).toBeNull();
    expect(parseAmountInput('', 'GBP')).toBeNull();
  });

  it('explains each problem, and says nothing for an empty field', () => {
    expect(amountInputMessage('empty', 'GBP')).toBeNull();
    expect(amountInputMessage('too_many_decimals', 'JPY')).toMatch(/no decimal places/);
    expect(amountInputMessage('too_many_decimals', 'GBP')).toMatch(/at most 2/);
    expect(amountInputMessage('ambiguous', 'GBP')).toMatch(/comma/);
    expect(amountInputMessage('invalid', 'GBP')).toMatch(/digits/);
  });

  it('recognises decimal strings', () => {
    expect(isDecimalString('12.50')).toBe(true);
    expect(isDecimalString('-3')).toBe(true);
    expect(isDecimalString(12.5)).toBe(false);
    expect(isDecimalString('1e3')).toBe(false);
  });
});
