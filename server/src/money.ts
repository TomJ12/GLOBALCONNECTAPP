/** Amounts are decimal strings from the request to the provider. This is the check at the API boundary. */
import { currencyDecimals } from '@/lib/money';

import { ApiError } from './errors';

/**
 * A positive amount written with no more decimal places than the currency
 * has. Anything else is refused here, so nothing downstream ever has to round
 * what the customer typed.
 */
export function assertAmount(amount: unknown, currency: string, field = 'amount'): string {
  // No leading zeros ("01.50"): an amount has one spelling, and it is stored and shown exactly as it was approved.
  if (typeof amount !== 'string' || !/^(0|[1-9]\d{0,14})(\.\d+)?$/.test(amount)) throw new ApiError('validation', { fields: [field] });
  const decimals = amount.includes('.') ? amount.length - amount.indexOf('.') - 1 : 0;
  if (decimals > currencyDecimals(currency) || !/[1-9]/.test(amount)) throw new ApiError('validation', { fields: [field] });
  return amount;
}
