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

/**
 * Clean up what a person types into an amount field: digits and one decimal
 * point only, no more decimals than the currency allows.
 */
export function sanitizeAmountInput(text: string, currency: CurrencyCode): string {
  const decimals = currencyDecimals(currency);
  const cleaned = text.replace(/,/g, '').replace(/[^\d.]/g, '');
  const firstDot = cleaned.indexOf('.');
  let integerPart = firstDot === -1 ? cleaned : cleaned.slice(0, firstDot);
  const fractionPart = firstDot === -1 ? '' : cleaned.slice(firstDot + 1).replace(/\./g, '');
  integerPart = integerPart.replace(/^0+(?=\d)/, '').slice(0, MAX_INTEGER_DIGITS);
  if (firstDot === -1 || decimals === 0) return integerPart;
  return `${integerPart === '' ? '0' : integerPart}.${fractionPart.slice(0, decimals)}`;
}

/** Turn field text into a positive decimal string, or null if it is empty, zero or invalid. */
export function parseAmountInput(text: string, currency: CurrencyCode): DecimalString | null {
  const cleaned = sanitizeAmountInput(text, currency).replace(/\.$/, '');
  if (!isDecimalString(cleaned)) return null;
  const value = new Big(cleaned);
  if (value.lte(0)) return null;
  return value.toFixed(currencyDecimals(currency));
}
