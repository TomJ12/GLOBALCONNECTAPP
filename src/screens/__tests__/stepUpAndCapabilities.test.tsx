import AsyncStorage from '@react-native-async-storage/async-storage';
import { fireEvent, screen, waitFor } from '@testing-library/react-native';

import { getAuthClient, getProviderClient } from '@/api';
import { DEMO_CODE } from '@/api/adapters/demoBackend';
import { ProviderError } from '@/api/errors';
import { confirmAction } from '@/lib/confirmAction';
import { ConvertScreen } from '@/screens/ConvertScreen';
import { NewPaymentScreen } from '@/screens/NewPaymentScreen';
import { PaymentsScreen } from '@/screens/PaymentsScreen';
import { RatesScreen } from '@/screens/RatesScreen';
import { useConfirmStore } from '@/state/confirm';
import { useSession } from '@/state/session';
import { useStepUpStore } from '@/state/stepUp';
import { installMockBackend, renderScreen, startTestSession } from '@/test/utils';

beforeEach(async () => {
  installMockBackend();
  useSession.setState({ session: null, signedOutReason: null });
  useStepUpStore.setState({ current: null });
  useConfirmStore.setState({ current: null });
  await AsyncStorage.clear();
});

async function toReviewAndSend(): Promise<void> {
  await fireEvent.press(await screen.findByText('Harbour Print Ltd'));
  await fireEvent.changeText(screen.getByTestId('payment-amount'), '250');
  await fireEvent.changeText(screen.getByTestId('payment-reference'), 'INV-77');
  await fireEvent.press(screen.getByRole('button', { name: 'Continue' }));
  await fireEvent.press(await screen.findByTestId('send-payment'));
  await fireEvent.press(await screen.findByTestId('confirm-dialog-confirm'));
}

describe('step-up on money actions', () => {
  it('asks for a code after the review, binds it to the exact payment, then sends once', async () => {
    await startTestSession('finance@example.com', { stepUp: true });
    const authorize = jest.spyOn(getAuthClient(), 'authorizeAction');
    const create = jest.spyOn(getProviderClient(), 'createPayment');
    await renderScreen(<NewPaymentScreen />);
    await toReviewAndSend();

    // The code dialog is up and nothing has been sent.
    expect(await screen.findByText('Enter your authenticator code')).toBeOnTheScreen();
    expect(create).not.toHaveBeenCalled();

    await fireEvent.changeText(screen.getByTestId('step-up-code'), '123');
    await fireEvent.press(screen.getByTestId('step-up-confirm'));
    expect(await screen.findByText(/Enter the 6-digit code/)).toBeOnTheScreen();
    expect(authorize).not.toHaveBeenCalled();

    // Wrong code: clear message, dialog stays, still nothing sent.
    await fireEvent.changeText(screen.getByTestId('step-up-code'), '111111');
    await fireEvent.press(screen.getByTestId('step-up-confirm'));
    expect(await screen.findByText(/That code is not right/)).toBeOnTheScreen();
    expect(create).not.toHaveBeenCalled();

    await fireEvent.changeText(screen.getByTestId('step-up-code'), DEMO_CODE);
    await fireEvent.press(screen.getByTestId('step-up-confirm'));
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    // The permission was asked for with exactly what was then sent, idempotency key included.
    const sent = create.mock.calls[0]?.[0];
    expect(authorize).toHaveBeenLastCalledWith('payment.create', sent, DEMO_CODE);
    expect(sent).toMatchObject({ beneficiaryId: 'sample-beneficiary-harbour', amount: '250.00', currency: 'GBP', reference: 'INV-77' });
    expect(sent?.idempotencyKey).toMatch(/^payment-/);
  });

  it('cancelling the code sends nothing', async () => {
    await startTestSession('finance@example.com', { stepUp: true });
    const create = jest.spyOn(getProviderClient(), 'createPayment');
    await renderScreen(<NewPaymentScreen />);
    await toReviewAndSend();
    await fireEvent.press(await screen.findByTestId('step-up-cancel'));
    await waitFor(() => expect(screen.queryByText('Enter your authenticator code')).not.toBeOnTheScreen());
    expect(create).not.toHaveBeenCalled();
    expect(screen.getByTestId('send-payment')).toBeOnTheScreen();
  });

  it('explains a reused code and a lockout, and an ended session signs out without sending', async () => {
    await startTestSession('finance@example.com', { stepUp: true });
    const authorize = jest.spyOn(getAuthClient(), 'authorizeAction');
    await renderScreen(<></>);
    const pending = confirmAction({ title: 'Approve?', message: 'USD 1 to X.', confirmLabel: 'Approve', stepUp: { action: 'payment.approve', payload: { paymentId: 'p1' } } });
    await fireEvent.press(await screen.findByTestId('confirm-dialog-confirm'));
    const tryCode = async () => {
      await fireEvent.changeText(await screen.findByTestId('step-up-code'), '222222');
      await fireEvent.press(screen.getByTestId('step-up-confirm'));
    };
    authorize.mockRejectedValueOnce(new ProviderError('validation', { reason: 'code_reused' }));
    await tryCode();
    expect(await screen.findByText(/already been used. Wait for your authenticator app/)).toBeOnTheScreen();
    authorize.mockRejectedValueOnce(new ProviderError('rate_limited', { reason: 'locked', retryAfterSeconds: 60 }));
    await tryCode();
    expect(await screen.findByText(/Too many attempts\. Try again in about 1 minute\./)).toBeOnTheScreen();
    authorize.mockRejectedValueOnce(new ProviderError('unauthorized'));
    await tryCode();
    await expect(pending).resolves.toBe(false);
    await waitFor(() => expect(useSession.getState().signedOutReason).toBe('expired'));
  });

  it('does not ask for a code for actions the backend does not list, or when the review is cancelled', async () => {
    await startTestSession('finance@example.com', { stepUp: true });
    const authorize = jest.spyOn(getAuthClient(), 'authorizeAction');
    await renderScreen(<></>);
    // Conversions between own balances are not in the default list.
    const conversion = confirmAction({ title: 'Convert?', message: 'm', confirmLabel: 'Convert', stepUp: { action: 'conversion.book', payload: {} } });
    await fireEvent.press(await screen.findByTestId('confirm-dialog-confirm'));
    await expect(conversion).resolves.toBe(true);
    const cancelled = confirmAction({ title: 'Send?', message: 'm', confirmLabel: 'Send', stepUp: { action: 'payment.create', payload: {} } });
    await fireEvent.press(await screen.findByTestId('confirm-dialog-cancel'));
    await expect(cancelled).resolves.toBe(false);
    expect(screen.queryByText('Enter your authenticator code')).not.toBeOnTheScreen();
    expect(authorize).not.toHaveBeenCalled();
  });

  it('the step-up error reasons have their own wording', () => {
    expect(new ProviderError('forbidden', { reason: 'step_up_invalid' }).userMessage).toMatch(/expired or does not match/);
    expect(new ProviderError('forbidden', { reason: 'step_up_invalid' }).outcomeUnknown).toBe(false);
  });
});

describe('capabilities', () => {
  const without = async () => {
    const session = await startTestSession();
    useSession.setState({ session: { ...session, capabilities: { forwardContracts: false, paymentApprovals: false } } });
  };

  it('offers Forward and lists forward contracts when supported', async () => {
    await startTestSession();
    await renderScreen(<ConvertScreen />);
    expect(screen.getByLabelText('Forward, lock a rate for later')).toBeOnTheScreen();
  });

  it('hides Forward in Convert and the forward list in Rates when not supported, and never asks for them', async () => {
    await without();
    const forwards = jest.spyOn(getProviderClient(), 'listForwardContracts');
    await renderScreen(<ConvertScreen />);
    expect(screen.queryByLabelText('Forward, lock a rate for later')).not.toBeOnTheScreen();
    expect(screen.getByTestId('convert-submit')).toBeOnTheScreen();
    await renderScreen(<RatesScreen />);
    expect(await screen.findByText('Rate alerts')).toBeOnTheScreen();
    expect(screen.queryByText('Forward contracts')).not.toBeOnTheScreen();
    expect(forwards).not.toHaveBeenCalled();
  });

  it('hides the approvals list when not supported', async () => {
    await without();
    const approvals = jest.spyOn(getProviderClient(), 'listPendingApprovals');
    await renderScreen(<PaymentsScreen />);
    expect(await screen.findByText('Recent payments')).toBeOnTheScreen();
    expect(screen.queryByText('Needs your approval')).not.toBeOnTheScreen();
    expect(approvals).not.toHaveBeenCalled();
  });
});
