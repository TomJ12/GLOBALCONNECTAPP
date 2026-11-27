import { getAuthClient } from '@/api';
import type { StepUpAction } from '@/api/types';
import { requestConfirmation } from '@/state/confirm';
import { useSession } from '@/state/session';
import { requestStepUpCode } from '@/state/stepUp';

export interface ActionConfirmation {
  /** A question, for example "Send this payment?". */
  title: string;
  /** What is about to happen: amount, payee, masked account. */
  message: string;
  /** The deliberate action, for example "Send payment". */
  confirmLabel: string;
  cancelLabel?: string;
  tone?: 'default' | 'danger';
  /**
   * The action and the exact payload that will be sent. When the backend
   * requires a fresh authenticator code for this action, the code is asked for
   * after the confirmation and exchanged for a one-time permission bound to
   * this payload. The payload must be exactly what the request will carry.
   */
  stepUp?: { action: StepUpAction; payload: unknown };
}

/**
 * THE one gate in front of every action that moves money (send, approve,
 * reject, convert) or changes who can be paid (add a payee). Resolves true only
 * if the person confirmed and, where the backend requires it, entered a valid
 * code from their authenticator app. Never rejects.
 *
 * 1. The review step: what is about to happen, with an explicit confirm button.
 * 2. The second factor: for actions listed in the session's `stepUpActions`,
 *    a 6-digit authenticator code. The backend swaps it for a one-time
 *    permission tied to this person, this session and this exact payload, and
 *    the API client attaches that permission to the matching request.
 *
 * Do not add per-screen checks elsewhere.
 */
export async function confirmAction(confirmation: ActionConfirmation): Promise<boolean> {
  const { stepUp, ...dialog } = confirmation;
  if (!(await requestConfirmation(dialog))) return false;
  const session = useSession.getState().session;
  if (!stepUp || !session || !session.stepUpActions.includes(stepUp.action)) return true;
  return requestStepUpCode({
    summary: confirmation.message,
    authorize: (code) => getAuthClient().authorizeAction(stepUp.action, stepUp.payload, code),
  });
}
