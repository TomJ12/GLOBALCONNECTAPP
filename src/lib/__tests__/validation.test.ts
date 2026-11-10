import { formatDate, formatRelativeDay, settlementDateAfterMonths } from '../dates';
import {
  formatIban,
  formatSortCode,
  isValidAbaRoutingNumber,
  isValidBic,
  isValidEmail,
  isValidIban,
  isValidSortCode,
  isValidUkAccountNumber,
  payeeFieldRules,
  validatePayeeDraft,
  type PayeeDraft,
} from '../validation';

describe('IBAN', () => {
  it('accepts valid IBANs in any spacing or case', () => {
    expect(isValidIban('DE89370400440532013000')).toBe(true);
    expect(isValidIban('de89 3704 0044 0532 0130 00')).toBe(true);
    expect(isValidIban('GB82 WEST 1234 5698 7654 32')).toBe(true);
    expect(isValidIban('FR1420041010050500013M02606')).toBe(true);
  });

  it('rejects a wrong checksum, length or shape', () => {
    expect(isValidIban('DE89370400440532013001')).toBe(false);
    expect(isValidIban('GB82WEST1234569876543')).toBe(false);
    expect(isValidIban('GB00SMPL00000000000000')).toBe(false);
    expect(isValidIban('')).toBe(false);
    expect(isValidIban('1234')).toBe(false);
    expect(isValidIban('DE89-3704-0044')).toBe(false);
  });

  it('formats in groups of four', () => {
    expect(formatIban('de89370400440532013000')).toBe('DE89 3704 0044 0532 0130 00');
  });
});

describe('UK details', () => {
  it('validates sort codes', () => {
    expect(isValidSortCode('123456')).toBe(true);
    expect(isValidSortCode('12-34-56')).toBe(true);
    expect(isValidSortCode('12 34 56')).toBe(true);
    expect(isValidSortCode('12345')).toBe(false);
    expect(isValidSortCode('12-3456')).toBe(false);
    expect(isValidSortCode('12345a')).toBe(false);
    expect(formatSortCode('123456')).toBe('12-34-56');
  });

  it('validates account numbers', () => {
    expect(isValidUkAccountNumber('12345678')).toBe(true);
    expect(isValidUkAccountNumber('1234567')).toBe(false);
    expect(isValidUkAccountNumber('123456789')).toBe(false);
    expect(isValidUkAccountNumber('1234567a')).toBe(false);
  });
});

describe('other fields', () => {
  it('validates BIC, ABA and email', () => {
    expect(isValidBic('DEUTDEFF')).toBe(true);
    expect(isValidBic('deutdeff500')).toBe(true);
    expect(isValidBic('DEUTDEF')).toBe(false);
    expect(isValidAbaRoutingNumber('021000021')).toBe(true);
    expect(isValidAbaRoutingNumber('021000022')).toBe(false);
    expect(isValidAbaRoutingNumber('000000000')).toBe(false);
    expect(isValidEmail('name@company.com')).toBe(true);
    expect(isValidEmail('name@company')).toBe(false);
    expect(isValidEmail('name company@x.com')).toBe(false);
    expect(isValidEmail('')).toBe(false);
  });
});

describe('payee form', () => {
  const base: PayeeDraft = {
    name: 'Harbour Print Ltd',
    entityType: 'company',
    countryCode: 'GB',
    currency: 'GBP',
    sortCode: '12-34-56',
    accountNumber: '12345678',
    iban: '',
    bic: '',
    routingNumber: '',
  };

  it('asks for the right fields per country and currency', () => {
    expect(payeeFieldRules('GB', 'GBP').map((rule) => rule.field)).toEqual(['sortCode', 'accountNumber']);
    expect(payeeFieldRules('US', 'USD').map((rule) => rule.field)).toEqual(['routingNumber', 'accountNumber']);
    expect(payeeFieldRules('DE', 'EUR')).toEqual([
      { field: 'iban', required: true },
      { field: 'bic', required: false },
    ]);
    expect(payeeFieldRules('GB', 'USD')).toEqual([
      { field: 'iban', required: true },
      { field: 'bic', required: true },
    ]);
    expect(payeeFieldRules('HK', 'USD').map((rule) => rule.field)).toEqual(['accountNumber', 'bic']);
  });

  it('passes a valid UK payee and ignores fields that do not apply', () => {
    expect(validatePayeeDraft(base)).toEqual({});
    expect(validatePayeeDraft({ ...base, iban: 'garbage' })).toEqual({});
  });

  it('reports required and malformed fields', () => {
    expect(validatePayeeDraft({ ...base, name: ' ', sortCode: '', accountNumber: '123' })).toEqual({
      name: expect.any(String),
      sortCode: expect.any(String),
      accountNumber: expect.any(String),
    });
    const german = { ...base, countryCode: 'DE', currency: 'EUR', iban: 'DE89370400440532013001' };
    expect(validatePayeeDraft(german)).toEqual({ iban: expect.stringContaining('not valid') });
    expect(validatePayeeDraft({ ...german, iban: 'GB82WEST12345698765432' })).toEqual({
      iban: expect.stringContaining('different country'),
    });
    expect(validatePayeeDraft({ ...german, iban: 'DE89370400440532013000' })).toEqual({});
    expect(validatePayeeDraft({ ...base, countryCode: 'XX' }).countryCode).toBeDefined();
  });
});

describe('dates', () => {
  it('formats dates the same way everywhere', () => {
    expect(formatDate('2027-01-14')).toBe('14 Jan 2027');
    expect(formatDate('rubbish')).toBe('rubbish');
  });

  it('describes recent days', () => {
    const now = new Date(2026, 10, 10, 15, 0, 0).getTime();
    expect(formatRelativeDay(new Date(2026, 10, 10, 1, 0, 0).toISOString(), now)).toBe('Today');
    expect(formatRelativeDay(new Date(2026, 10, 9, 23, 0, 0).toISOString(), now)).toBe('Yesterday');
    expect(formatRelativeDay(new Date(2026, 10, 3, 12, 0, 0).toISOString(), now)).toBe('3 Nov 2026');
  });

  it('picks forward settlement dates off weekends and clamps month ends', () => {
    const tuesday = Date.parse('2026-11-10T12:00:00Z');
    expect(settlementDateAfterMonths(1, tuesday)).toBe('2026-12-10');
    expect(settlementDateAfterMonths(3, tuesday)).toBe('2027-02-10');
    // 10 Oct 2026 + 1 month = Tue 10 Nov; 15 Aug 2026 is a Saturday -> Monday 17th.
    expect(settlementDateAfterMonths(1, Date.parse('2026-07-15T12:00:00Z'))).toBe('2026-08-17');
    // 31 Jan + 1 month clamps to 28 Feb 2027 (a Sunday) -> Monday 1 Mar.
    expect(settlementDateAfterMonths(1, Date.parse('2027-01-31T12:00:00Z'))).toBe('2027-03-01');
  });
});
