/** Field validation for sign-in and payee forms. Pure functions, no I/O. */

const IBAN_LENGTHS: Record<string, number> = {
  AE: 23, AT: 20, BE: 16, BG: 22, CH: 21, CY: 28, CZ: 24, DE: 22, DK: 18, EE: 20,
  ES: 24, FI: 18, FR: 27, GB: 22, GR: 27, HR: 21, HU: 28, IE: 22, IT: 27, LT: 20,
  LU: 20, LV: 21, MT: 31, NL: 18, NO: 15, PL: 28, PT: 25, RO: 24, SE: 24, SI: 19,
  SK: 24,
};

export function normalizeIban(input: string): string {
  return input.replace(/\s+/g, '').toUpperCase();
}

/** Print an IBAN in groups of four. */
export function formatIban(input: string): string {
  return normalizeIban(input).replace(/(.{4})(?=.)/g, '$1 ');
}

/** ISO 13616 structure plus the ISO 7064 mod 97-10 checksum. */
export function isValidIban(input: string): boolean {
  const iban = normalizeIban(input);
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(iban)) return false;
  const expectedLength = IBAN_LENGTHS[iban.slice(0, 2)];
  if (expectedLength !== undefined && iban.length !== expectedLength) return false;
  const rearranged = iban.slice(4) + iban.slice(0, 4);
  let remainder = 0;
  for (const char of rearranged) {
    const code = char.charCodeAt(0);
    const value = code >= 65 ? (code - 55).toString() : char;
    for (const digit of value) {
      remainder = (remainder * 10 + (digit.charCodeAt(0) - 48)) % 97;
    }
  }
  return remainder === 1;
}

export function normalizeSortCode(input: string): string {
  return input.replace(/[\s-]/g, '');
}

/** Six digits, optionally written 12-34-56 or 12 34 56. */
export function isValidSortCode(input: string): boolean {
  return /^(\d{6}|\d{2}-\d{2}-\d{2}|\d{2} \d{2} \d{2})$/.test(input.trim());
}

export function formatSortCode(input: string): string {
  const digits = normalizeSortCode(input);
  return /^\d{6}$/.test(digits) ? `${digits.slice(0, 2)}-${digits.slice(2, 4)}-${digits.slice(4)}` : input;
}

/** UK account numbers are eight digits. */
export function isValidUkAccountNumber(input: string): boolean {
  return /^\d{8}$/.test(input.trim());
}

export function isValidBic(input: string): boolean {
  return /^[A-Z]{4}[A-Z]{2}[A-Z0-9]{2}([A-Z0-9]{3})?$/.test(input.trim().toUpperCase());
}

/** US ABA routing number: nine digits with the 3-7-1 checksum. */
export function isValidAbaRoutingNumber(input: string): boolean {
  const value = input.trim();
  if (!/^\d{9}$/.test(value)) return false;
  const d = [...value].map((c) => c.charCodeAt(0) - 48) as [
    number, number, number, number, number, number, number, number, number,
  ];
  const sum = 3 * (d[0] + d[3] + d[6]) + 7 * (d[1] + d[4] + d[7]) + (d[2] + d[5] + d[8]);
  return sum !== 0 && sum % 10 === 0;
}

export function isValidGenericAccountNumber(input: string): boolean {
  return /^[A-Z0-9]{4,34}$/i.test(input.trim());
}

export function isValidEmail(input: string): boolean {
  const value = input.trim();
  return value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value);
}

// ---------------------------------------------------------------------------
// Payee form
// ---------------------------------------------------------------------------

export type PayeeBankField = 'sortCode' | 'accountNumber' | 'iban' | 'bic' | 'routingNumber';

export interface PayeeCountry {
  code: string;
  name: string;
  usesIban: boolean;
}

/** Deliberately short list. The real list should come from the provider's reference data. */
export const PAYEE_COUNTRIES: readonly PayeeCountry[] = [
  { code: 'GB', name: 'United Kingdom', usesIban: true },
  { code: 'US', name: 'United States', usesIban: false },
  { code: 'DE', name: 'Germany', usesIban: true },
  { code: 'FR', name: 'France', usesIban: true },
  { code: 'IE', name: 'Ireland', usesIban: true },
  { code: 'NL', name: 'Netherlands', usesIban: true },
  { code: 'ES', name: 'Spain', usesIban: true },
  { code: 'AE', name: 'United Arab Emirates', usesIban: true },
  { code: 'HK', name: 'Hong Kong', usesIban: false },
  { code: 'CN', name: 'China', usesIban: false },
];

export const PAYEE_CURRENCIES: readonly string[] = ['GBP', 'USD', 'EUR', 'AED', 'JPY'];

export interface PayeeFieldRule {
  field: PayeeBankField;
  required: boolean;
}

/**
 * Which bank fields a payee needs. Kept simple on purpose:
 *  - GBP to a UK bank: sort code + account number
 *  - USD to a US bank: ABA routing number + account number
 *  - IBAN countries: IBAN (+ BIC, optional for EUR, required otherwise)
 *  - everything else: account number + BIC
 */
export function payeeFieldRules(countryCode: string, currency: string): PayeeFieldRule[] {
  const country = PAYEE_COUNTRIES.find((c) => c.code === countryCode);
  if (countryCode === 'GB' && currency === 'GBP') {
    return [
      { field: 'sortCode', required: true },
      { field: 'accountNumber', required: true },
    ];
  }
  if (countryCode === 'US' && currency === 'USD') {
    return [
      { field: 'routingNumber', required: true },
      { field: 'accountNumber', required: true },
    ];
  }
  if (country?.usesIban) {
    return [
      { field: 'iban', required: true },
      { field: 'bic', required: currency !== 'EUR' },
    ];
  }
  return [
    { field: 'accountNumber', required: true },
    { field: 'bic', required: true },
  ];
}

export interface PayeeDraft {
  name: string;
  entityType: 'company' | 'individual';
  countryCode: string;
  currency: string;
  sortCode: string;
  accountNumber: string;
  iban: string;
  bic: string;
  routingNumber: string;
}

export type PayeeErrors = Partial<Record<'name' | 'countryCode' | 'currency' | PayeeBankField, string>>;

export function validatePayeeDraft(draft: PayeeDraft): PayeeErrors {
  const errors: PayeeErrors = {};
  const name = draft.name.trim();
  if (name.length < 2) errors.name = 'Enter the account holder name.';
  else if (name.length > 100) errors.name = 'Name must be 100 characters or fewer.';
  if (!PAYEE_COUNTRIES.some((c) => c.code === draft.countryCode)) errors.countryCode = 'Choose a country.';
  if (!PAYEE_CURRENCIES.includes(draft.currency)) errors.currency = 'Choose a currency.';

  for (const rule of payeeFieldRules(draft.countryCode, draft.currency)) {
    const value = draft[rule.field].trim();
    if (value === '') {
      if (rule.required) errors[rule.field] = REQUIRED_MESSAGES[rule.field];
      continue;
    }
    switch (rule.field) {
      case 'sortCode':
        if (!isValidSortCode(value)) errors.sortCode = 'Sort code must be 6 digits.';
        break;
      case 'accountNumber':
        if (draft.countryCode === 'GB' && draft.currency === 'GBP') {
          if (!isValidUkAccountNumber(value)) errors.accountNumber = 'Account number must be 8 digits.';
        } else if (!isValidGenericAccountNumber(value)) {
          errors.accountNumber = 'Account number must be 4 to 34 letters or digits.';
        }
        break;
      case 'iban':
        if (!isValidIban(value)) errors.iban = 'This IBAN is not valid. Check it and try again.';
        else if (normalizeIban(value).slice(0, 2) !== draft.countryCode) {
          errors.iban = 'This IBAN belongs to a different country.';
        }
        break;
      case 'bic':
        if (!isValidBic(value)) errors.bic = 'BIC must be 8 or 11 characters.';
        break;
      case 'routingNumber':
        if (!isValidAbaRoutingNumber(value)) errors.routingNumber = 'Routing number is not valid.';
        break;
    }
  }
  return errors;
}

const REQUIRED_MESSAGES: Record<PayeeBankField, string> = {
  sortCode: 'Enter the sort code.',
  accountNumber: 'Enter the account number.',
  iban: 'Enter the IBAN.',
  bic: 'Enter the BIC (SWIFT code).',
  routingNumber: 'Enter the routing number.',
};
