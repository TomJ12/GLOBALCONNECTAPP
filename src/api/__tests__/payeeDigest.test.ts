import { payeeDigestSource } from '../payeeDigest';

const raw = {
  id: 'ben-1',
  name: 'Harbour Freight',
  bank_account_holder_name: 'Harbour Freight Ltd',
  account_number: '00000000',
  routing_code_type_1: 'sort_code',
  routing_code_value_1: '000000',
  payment_types: ['regular'],
  beneficiary_address: [],
  iban: null,
  created_at: '2026-01-01T00:00:00+00:00',
  updated_at: '2026-01-01T00:00:00+00:00',
};
const of = (change: Record<string, unknown> = {}) => payeeDigestSource({ ...raw, ...change }, ['created_at', 'updated_at']);

describe('payee digest', () => {
  it('changes with ANY field of the raw record, known to this code or not', () => {
    for (const change of [
      { routing_code_value_1: '999999' },
      { routing_code_type_1: 'bsb_code' },
      { routing_code_type_2: 'aba', routing_code_value_2: '021000021' },
      { account_number: '00000001' },
      { iban: 'GB00SMPL00000000000000' },
      { bank_account_holder_name: 'harbour freight ltd' },
      { payment_types: ['priority'] },
      { payment_types: ['regular', 'priority'] },
      { beneficiary_address: ['1 Quay'] },
      { something_the_provider_adds_next_year: { nested: 'x' } },
    ]) {
      expect(of(change)).not.toBe(of());
    }
  });

  it('does not change with the ignored timestamps, key order, surrounding spaces or empty values', () => {
    expect(of({ updated_at: '2031-01-01T00:00:00+00:00', created_at: 'x' })).toBe(of());
    expect(of({ name: '  Harbour Freight ', iban: '', swift: null, extra: [], more: {}, nested: { empty: '' } })).toBe(of());
    expect(payeeDigestSource(Object.fromEntries(Object.entries(raw).reverse()), ['created_at', 'updated_at'])).toBe(of());
    // An ignored name is ignored at the top level only: the same name deeper down is part of the record.
    expect(of({ bank: { updated_at: 'x' } })).not.toBe(of());
  });
});
