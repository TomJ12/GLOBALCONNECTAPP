/**
 * Money utilities. Amounts and rates are ALWAYS decimal strings and all
 * arithmetic goes through big.js. Never use JS floats for money.
 */
import { Big } from 'big.js';

export type CurrencyCode = string;
export type DecimalString = string;

interface CurrencyMeta {
  decimals: number;
  /** Prefix shown before the number. Codes are used where a symbol is ambiguous. */
  prefix: string;
  name: string;
}

const NBSP = ' ';
const MINUS = '−';

const CURRENCIES: Record<string, CurrencyMeta> = {
  GBP: { decimals: 2, prefix: '£', name: 'British pound' },
  USD: { decimals: 2, prefix: '$', name: 'US dollar' },
  EUR: { decimals: 2, prefix: '€', name: 'Euro' },
  AED: { decimals: 2, prefix: `AED${NBSP}`, name: 'UAE dirham' },
  CHF: { decimals: 2, prefix: `CHF${NBSP}`, name: 'Swiss franc' },
  CAD: { decimals: 2, prefix: 'CA$', name: 'Canadian dollar' },
  AUD: { decimals: 2, prefix: 'A$', name: 'Australian dollar' },
  HKD: { decimals: 2, prefix: 'HK$', name: 'Hong Kong dollar' },
  CNY: { decimals: 2, prefix: `CNY${NBSP}`, name: 'Chinese yuan' },
  JPY: { decimals: 0, prefix: '¥', name: 'Japanese yen' },
  KRW: { decimals: 0, prefix: '₩', name: 'South Korean won' },
  VND: { decimals: 0, prefix: '₫', name: 'Vietnamese dong' },
  CLP: { decimals: 0, prefix: `CLP${NBSP}`, name: 'Chilean peso' },
  ISK: { decimals: 0, prefix: `ISK${NBSP}`, name: 'Icelandic króna' },
  KWD: { decimals: 3, prefix: `KWD${NBSP}`, name: 'Kuwaiti dinar' },
  BHD: { decimals: 3, prefix: `BHD${NBSP}`, name: 'Bahraini dinar' },
  OMR: { decimals: 3, prefix: `OMR${NBSP}`, name: 'Omani rial' },
  JOD: { decimals: 3, prefix: `JOD${NBSP}`, name: 'Jordanian dinar' },
  TND: { decimals: 3, prefix: `TND${NBSP}`, name: 'Tunisian dinar' },
};

const DECIMAL_RE = /^-?\d+(\.\d+)?$/;
/** What `formatMoney` returns when it is given something that is not a decimal string. */
export const INVALID_AMOUNT_PLACEHOLDER = '—';

export function isDecimalString(value: unknown): value is DecimalString {
  return typeof value === 'string' && DECIMAL_RE.test(value);
}

function toBig(value: DecimalString): Big {
  if (!isDecimalString(value)) {
    throw new RangeError(`Not a decimal string: ${String(value)}`);
  }
  return new Big(value);
}

export function currencyDecimals(currency: CurrencyCode): number {
  return CURRENCIES[currency.toUpperCase()]?.decimals ?? 2;
}

export function currencyName(currency: CurrencyCode): string {
  return CURRENCIES[currency.toUpperCase()]?.name ?? currency.toUpperCase();
}

/** Short prefix used in front of amounts, for example "£" or "AED ". */
export function currencyPrefix(currency: CurrencyCode): string {
  const code = currency.toUpperCase();
  return CURRENCIES[code]?.prefix ?? `${code}${NBSP}`;
}

function groupThousands(integerDigits: string): string {
  return integerDigits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** Round to the currency's minor units (half up) and return a plain decimal string. */
export function roundToCurrency(amount: DecimalString, currency: CurrencyCode): DecimalString {
  return toBig(amount).round(currencyDecimals(currency), Big.roundHalfUp).toFixed(currencyDecimals(currency));
}

export interface FormatMoneyOptions {
  /** Prefix positive amounts with "+". Negative amounts always show a minus. */
  showPlus?: boolean;
  /** Set false to drop the currency prefix, for example next to a currency chip. */
  withSymbol?: boolean;
}

/**
 * The single formatter for money in the app.
 * formatMoney('101964', 'GBP') -> "£101,964.00"; JPY has 0 decimals, KWD has 3.
 * Invalid input renders as "—" rather than throwing inside a render.
 */
export function formatMoney(
  amount: DecimalString,
  currency: CurrencyCode,
  options: FormatMoneyOptions = {},
): string {
  if (!isDecimalString(amount)) return INVALID_AMOUNT_PLACEHOLDER;
  const { showPlus = false, withSymbol = true } = options;
  const decimals = currencyDecimals(currency);
  const rounded = new Big(amount).round(decimals, Big.roundHalfUp);
  const isNegative = rounded.lt(0);
  const [integerPart, fractionPart] = rounded.abs().toFixed(decimals).split('.');
  const digits = groupThousands(integerPart ?? '0') + (fractionPart ? `.${fractionPart}` : '');
  const sign = isNegative ? MINUS : showPlus && rounded.gt(0) ? '+' : '';
  return `${sign}${withSymbol ? currencyPrefix(currency) : ''}${digits}`;
}

/** Format an exchange rate to a fixed number of decimal places (4 by default). */
export function formatRate(rate: DecimalString, decimalPlaces = 4): string {
  if (!isDecimalString(rate)) return INVALID_AMOUNT_PLACEHOLDER;
  return new Big(rate).round(decimalPlaces, Big.roundHalfUp).toFixed(decimalPlaces);
}

export function addAmounts(a: DecimalString, b: DecimalString): DecimalString {
  return toBig(a).plus(toBig(b)).toFixed();
}

export function subtractAmounts(a: DecimalString, b: DecimalString): DecimalString {
  return toBig(a).minus(toBig(b)).toFixed();
}

export function compareAmounts(a: DecimalString, b: DecimalString): -1 | 0 | 1 {
  return toBig(a).cmp(toBig(b));
}

export function isPositiveAmount(a: DecimalString): boolean {
  return isDecimalString(a) && new Big(a).gt(0);
}

/** amount * rate, rounded to the target currency's minor units. */
export function multiplyByRate(
  amount: DecimalString,
  rate: DecimalString,
  targetCurrency: CurrencyCode,
): DecimalString {
  const decimals = currencyDecimals(targetCurrency);
  return toBig(amount).times(toBig(rate)).round(decimals, Big.roundHalfUp).toFixed(decimals);
}

/** amount / rate, rounded to the target currency's minor units. Throws on a zero rate. */
export function divideByRate(
  amount: DecimalString,
  rate: DecimalString,
  targetCurrency: CurrencyCode,
): DecimalString {
  const divisor = toBig(rate);
  if (divisor.lte(0)) throw new RangeError('Rate must be greater than zero');
  const decimals = currencyDecimals(targetCurrency);
  return toBig(amount).div(divisor).round(decimals, Big.roundHalfUp).toFixed(decimals);
}

export interface BaseTotal {
  total: DecimalString;
  /** Currencies that could not be included because no rate was supplied. */
  missing: CurrencyCode[];
}

/**
 * Sum balances into one base currency.
 * `ratesFromBase[c]` is how many units of `c` one unit of the base buys
 * (for example base GBP, ratesFromBase.USD = "1.3000"), so base = amount / rate.
 * Each balance is rounded to minor units before summing, as a statement would.
 */
export function totalInBaseCurrency(
  balances: readonly { currency: CurrencyCode; amount: DecimalString }[],
  baseCurrency: CurrencyCode,
  ratesFromBase: Readonly<Record<CurrencyCode, DecimalString | undefined>>,
): BaseTotal {
  let total = new Big(0);
  const missing: CurrencyCode[] = [];
  for (const balance of balances) {
    if (balance.currency === baseCurrency) {
      total = total.plus(toBig(balance.amount));
      continue;
    }
    const rate = ratesFromBase[balance.currency];
    if (!rate || !isDecimalString(rate) || new Big(rate).lte(0)) {
      missing.push(balance.currency);
      continue;
    }
    total = total.plus(toBig(divideByRate(balance.amount, rate, baseCurrency)));
  }
  const decimals = currencyDecimals(baseCurrency);
  return { total: total.toFixed(decimals), missing };
}

const MAX_INTEGER_DIGITS = 12;

export type AmountInputProblem = 'empty' | 'invalid' | 'ambiguous' | 'too_many_decimals' | 'too_large' | 'zero';
export type AmountInputResult = { ok: true; amount: DecimalString } | { ok: false; problem: AmountInputProblem };

function countOf(text: string, char: string): number {
  return text.split(char).length - 1;
}

function isGrouped(text: string, separator: '.' | ','): boolean {
  return (separator === ',' ? /^\d{1,3}(,\d{3})+$/ : /^\d{1,3}(\.\d{3})+$/).test(text);
}

/**
 * Read what a person typed as a positive decimal number.
 *
 * Money input is never "cleaned up" into something the person did not type:
 * anything that is not clearly a number is REJECTED with a reason, so the
 * screen can say what is wrong. Accepted forms:
 *   1234      1234.56     1234,56 (comma as decimal point)
 *   1,234.56  1.234,56    1,234,567 / 1.234.567 (two or more groups)
 * Rejected: letters, signs, exponents ("1e3", "-50"), more decimals than
 * allowed, and "1,234", which could mean 1234 or 1.234.
 */
export function parseDecimalInput(text: string, maxDecimals: number): AmountInputResult {
  const input = text.trim();
  if (input === '') return { ok: false, problem: 'empty' };
  if (!/^[\d.,]+$/.test(input) || !/\d/.test(input)) return { ok: false, problem: 'invalid' };

  const dots = countOf(input, '.');
  const commas = countOf(input, ',');
  let integerPart = input;
  let fractionPart = '';

  if (dots > 0 && commas > 0) {
    // The last separator is the decimal point; the other must be proper thousands grouping.
    const decimal = input.lastIndexOf('.') > input.lastIndexOf(',') ? '.' : ',';
    const grouping = decimal === '.' ? ',' : '.';
    if (countOf(input, decimal) !== 1) return { ok: false, problem: 'invalid' };
    const [whole = '', fraction = ''] = input.split(decimal);
    if (!isGrouped(whole, grouping)) return { ok: false, problem: 'invalid' };
    integerPart = whole.split(grouping).join('');
    fractionPart = fraction;
  } else if (dots + commas === 1) {
    const separator = dots === 1 ? '.' : ',';
    const [whole = '', fraction = ''] = input.split(separator);
    // "1,234" could be one thousand two hundred and thirty-four, or 1.234.
    if (separator === ',' && /^[1-9]\d{0,2}$/.test(whole) && fraction.length === 3) {
      return { ok: false, problem: 'ambiguous' };
    }
    integerPart = whole === '' ? '0' : whole;
    fractionPart = fraction;
  } else if (dots + commas > 1) {
    const separator = dots > 0 ? '.' : ',';
    if (!isGrouped(input, separator)) return { ok: false, problem: 'invalid' };
    integerPart = input.split(separator).join('');
  }

  if (!/^\d+$/.test(integerPart) || !/^\d*$/.test(fractionPart)) return { ok: false, problem: 'invalid' };
  if (fractionPart.length > maxDecimals) return { ok: false, problem: 'too_many_decimals' };
  integerPart = integerPart.replace(/^0+(?=\d)/, '');
  if (integerPart.length > MAX_INTEGER_DIGITS) return { ok: false, problem: 'too_large' };
  const value = new Big(fractionPart === '' ? integerPart : `${integerPart}.${fractionPart}`);
  if (value.lte(0)) return { ok: false, problem: 'zero' };
  return { ok: true, amount: value.toFixed() };
}

/** Read an amount field for a currency. The amount comes back with the currency's decimals. */
export function readAmountInput(text: string, currency: CurrencyCode): AmountInputResult {
  const decimals = currencyDecimals(currency);
  const result = parseDecimalInput(text, decimals);
  return result.ok ? { ok: true, amount: new Big(result.amount).toFixed(decimals) } : result;
}

/** The amount as a decimal string, or null when the text is empty or not acceptable. */
export function parseAmountInput(text: string, currency: CurrencyCode): DecimalString | null {
  const result = readAmountInput(text, currency);
  return result.ok ? result.amount : null;
}

/** What to tell the person about a rejected amount. Null for an empty field. */
export function amountInputMessage(problem: AmountInputProblem, currency: CurrencyCode): string | null {
  const decimals = currencyDecimals(currency);
  switch (problem) {
    case 'empty':
      return null;
    case 'zero':
      return 'Enter an amount greater than zero.';
    case 'ambiguous':
      return 'We cannot tell what the comma means. Type the amount like 1234.00.';
    case 'too_many_decimals':
      return decimals === 0
        ? `${currency.toUpperCase()} has no decimal places. Enter a whole number.`
        : `${currency.toUpperCase()} amounts can have at most ${decimals} decimal places.`;
    case 'too_large':
      return 'That amount is too large.';
    default:
      return 'Enter the amount in digits, like 1250.50.';
  }
}
