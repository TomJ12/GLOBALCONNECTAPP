/** Amounts are decimal strings from the request to the provider. This is the check at the API boundary. */
import { currencyDecimals } from '@/lib/money';

import { ApiError } from './errors';

/**
 * A positive amount written with no more decimal places than the currency
 * has. Anything else is refused here, so nothing downstream ever has to round
 * what the customer typed.
 */
export function assertAmount(amount: unknown, currency: string, field = 'amount'): string {
  if (typeof amount !== 'string' || !/^\d{1,15}(\.\d+)?$/.test(amount)) throw new ApiError('validation', { fields: [field] });
  const decimals = amount.includes('.') ? amount.length - amount.indexOf('.') - 1 : 0;
  if (decimals > currencyDecimals(currency) || !/[1-9]/.test(amount)) throw new ApiError('validation', { fields: [field] });
  return amount;
}
