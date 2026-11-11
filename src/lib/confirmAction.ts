import { requestConfirmation } from '@/state/confirm';

export interface ActionConfirmation {
  /** A question, for example "Send this payment?". */
  title: string;
  /** What is about to happen: amount, payee, masked account. */
  message: string;
  /** The deliberate action, for example "Send payment". */
  confirmLabel: string;
  cancelLabel?: string;
  tone?: 'default' | 'danger';
}

/**
 * THE one gate in front of every action that moves money (send, approve,
 * reject, convert). Resolves true only if the person confirmed. Never rejects.
 *
 * Today it shows an explicit in-app confirmation step and nothing more.
 *
 * SECOND-FACTOR SEAM: payments will need strong customer authentication
 * (a real second factor, as the provider and regulation require). When that
 * exists it plugs in HERE, after or instead of the dialog, and every money
 * action picks it up without changing. Do not add per-screen checks elsewhere.
 */
export async function confirmAction(confirmation: ActionConfirmation): Promise<boolean> {
  return requestConfirmation(confirmation);
}
