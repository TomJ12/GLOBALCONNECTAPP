import { compareAmounts } from './money';

export interface PaymentFacts {
  beneficiaryId: string;
  amount: string;
  currency: string;
  reference: string;
}

/**
 * True when the payment the backend created is the one that was asked for.
 * A difference must be shown to the customer, not hidden behind a success screen.
 */
export function paymentMatchesRequest(created: PaymentFacts, sent: PaymentFacts): boolean {
  try {
    return (
      created.beneficiaryId === sent.beneficiaryId &&
      created.currency === sent.currency &&
      created.reference.trim() === sent.reference.trim() &&
      compareAmounts(created.amount, sent.amount) === 0
    );
  } catch {
    return false;
  }
}
