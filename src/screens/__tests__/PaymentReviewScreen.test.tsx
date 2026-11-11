import { act, fireEvent, screen, waitFor } from '@testing-library/react-native';

import { getProviderClient } from '@/api';
import { approvalOutcomeCopy, PaymentReviewScreen } from '@/screens/PaymentReviewScreen';
import { installMockBackend, renderScreen, setControls, signIn } from '@/test/utils';

const expoRouter = jest.requireMock<{ __setParams: (params: Record<string, string>) => void }>('expo-router');

async function usdBalance(): Promise<string | undefined> {
  return (await getProviderClient().listBalances()).find((balance) => balance.currency === 'USD')?.amount;
}

describe('PaymentReviewScreen', () => {
  let paymentId = '';

  beforeEach(async () => {
    const mock = installMockBackend();
    await signIn(mock.client);
    paymentId = (await mock.client.listPendingApprovals())[0]?.payment.id ?? '';
    expoRouter.__setParams({ id: paymentId });
  });

  it('shows the payment with placeholders for fee and arrival', async () => {
    await renderScreen(<PaymentReviewScreen />);
    expect(await screen.findByTestId('review-amount')).toHaveTextContent('$18,400.00');
    expect(screen.getByText('Brightway Electronics Co.')).toBeOnTheScreen();
    expect(screen.getByText('INV-2291')).toBeOnTheScreen();
    expect(screen.getByText('SWIFT')).toBeOnTheScreen();
    expect(screen.getByText('[YOUR FEE]')).toBeOnTheScreen();
    expect(screen.getByText('[DELIVERY ESTIMATE]')).toBeOnTheScreen();
    expect(screen.getByText(/Created by Accounts team/)).toBeOnTheScreen();
    expect(screen.getByText('Waiting for you')).toBeOnTheScreen();
    // M9: the approver sees where the money is going, masked.
    expect(screen.getByText('•••• 4471')).toBeOnTheScreen();
    expect(screen.getByText('SMPLHKHH')).toBeOnTheScreen();
    expect(screen.getByText('HK')).toBeOnTheScreen();
    expect(screen.queryByText('000000004471')).not.toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Approve payment' })).toBeEnabled();
    expect(await screen.findByText('From USD balance, $57,891.00 available')).toBeOnTheScreen();
  });

  it('approves after confirmation: pending list empties, balance drops, transaction appears', async () => {
    await renderScreen(<PaymentReviewScreen />);
    await fireEvent.press(await screen.findByTestId('approve-button'));
    await fireEvent.press(await screen.findByTestId('confirm-dialog-confirm'));

    expect(await screen.findByTestId('review-outcome-title')).toHaveTextContent('Approved');
    const client = getProviderClient();
    expect(await client.listPendingApprovals()).toEqual([]);
    expect(await usdBalance()).toBe('39491.00');
    expect((await client.listTransactions({ page: 1, perPage: 1 })).items[0]).toMatchObject({ kind: 'payment', amount: '18400', currency: 'USD' });
  });

  it('does nothing if the confirmation is cancelled', async () => {
    await renderScreen(<PaymentReviewScreen />);
    await fireEvent.press(await screen.findByTestId('approve-button'));
    await fireEvent.press(await screen.findByTestId('confirm-dialog-cancel'));
    await waitFor(() => expect(screen.getByTestId('approve-button')).toBeEnabled());
    expect(await getProviderClient().listPendingApprovals()).toHaveLength(1);
    expect(await usdBalance()).toBe('57891.00');
  });

  it('approves once when the button is pressed twice', async () => {
    const approveSpy = jest.spyOn(getProviderClient(), 'approvePayment');
    await renderScreen(<PaymentReviewScreen />);
    const approve = await screen.findByTestId('approve-button');
    await act(async () => {
      fireEvent.press(approve);
      fireEvent.press(approve);
    });
    await fireEvent.press(await screen.findByTestId('confirm-dialog-confirm'));
    expect(await screen.findByTestId('review-outcome-title')).toHaveTextContent('Approved');
    expect(approveSpy).toHaveBeenCalledTimes(1);
    expect(await usdBalance()).toBe('39491.00');
  });

  it('rejects after a second confirmation, without moving money', async () => {
    await renderScreen(<PaymentReviewScreen />);
    await fireEvent.press(await screen.findByTestId('reject-button'));
    expect(await screen.findByText('Reject this payment?')).toBeOnTheScreen();
    await fireEvent.press(screen.getByTestId('confirm-dialog-confirm'));

    expect(await screen.findByTestId('review-outcome-title')).toHaveTextContent('Rejected');
    expect(await getProviderClient().listPendingApprovals()).toEqual([]);
    expect(await usdBalance()).toBe('57891.00');
  });

  it('shows an error and stays pending when approval fails', async () => {
    await renderScreen(<PaymentReviewScreen />);
    await fireEvent.press(await screen.findByTestId('approve-button'));
    setControls({ forcedError: 'rate_limited' });
    await fireEvent.press(await screen.findByTestId('confirm-dialog-confirm'));
    expect(await screen.findByText(/Too many requests/)).toBeOnTheScreen();
    setControls({ forcedError: 'none' });
    expect(await getProviderClient().listPendingApprovals()).toHaveLength(1);
    expect(screen.queryByTestId('review-outcome-title')).not.toBeOnTheScreen();
  });

  it('blocks approval when the balance cannot cover the payment', async () => {
    const client = getProviderClient();
    const quote = await client.createQuote({ kind: 'spot', sellCurrency: 'USD', buyCurrency: 'GBP', fixedSide: 'sell', amount: '50000.00' });
    await client.bookConversion({ quote, idempotencyKey: 'drain' });
    await renderScreen(<PaymentReviewScreen />);
    expect(await screen.findByText(/There is not enough USD/)).toBeOnTheScreen();
    expect(screen.getByTestId('approve-button')).toBeDisabled();
  });

  it('explains when the payment no longer needs approval', async () => {
    expoRouter.__setParams({ id: 'gone' });
    await renderScreen(<PaymentReviewScreen />);
    expect(await screen.findByText('Nothing to approve here')).toBeOnTheScreen();
  });

  it('shows an error with retry when the payment cannot be loaded', async () => {
    setControls({ forcedError: 'server' });
    await renderScreen(<PaymentReviewScreen />);
    expect(await screen.findByText('Something went wrong')).toBeOnTheScreen();
    setControls({ forcedError: 'none' });
    await fireEvent.press(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByTestId('review-amount')).toHaveTextContent('$18,400.00');
  });

  it('the confirmation names the amount, payee and masked account before anything is sent', async () => {
    const approveSpy = jest.spyOn(getProviderClient(), 'approvePayment');
    await renderScreen(<PaymentReviewScreen />);
    await fireEvent.press(await screen.findByTestId('approve-button'));
    expect(await screen.findByText('Approve this payment?')).toBeOnTheScreen();
    expect(screen.getByText('$18,400.00 to Brightway Electronics Co., USD account ending 4471. Reference INV-2291.')).toBeOnTheScreen();
    // Nothing happens until the deliberate confirm.
    expect(approveSpy).not.toHaveBeenCalled();
  });

  it('rejecting is gated by the confirm step too', async () => {
    const rejectSpy = jest.spyOn(getProviderClient(), 'rejectPayment');
    await renderScreen(<PaymentReviewScreen />);
    await fireEvent.press(await screen.findByTestId('reject-button'));
    await fireEvent.press(await screen.findByTestId('confirm-dialog-cancel'));
    await waitFor(() => expect(screen.getByTestId('reject-button')).toBeEnabled());
    expect(rejectSpy).not.toHaveBeenCalled();
    expect(await getProviderClient().listPendingApprovals()).toHaveLength(1);
  });

  it('M9: a payment whose payee cannot be resolved cannot be approved, only rejected', async () => {
    const client = getProviderClient();
    const real = await client.listPendingApprovals();
    jest.spyOn(client, 'listPendingApprovals').mockResolvedValue(
      real.map((approval) => ({ ...approval, beneficiary: null, payment: { ...approval.payment, beneficiaryName: null } })),
    );
    await renderScreen(<PaymentReviewScreen />);
    expect(await screen.findByText(/could not load this payee/)).toBeOnTheScreen();
    expect(screen.getByTestId('approve-button')).toBeDisabled();
    expect(screen.getByTestId('reject-button')).toBeEnabled();
  });

  it('M7: says more approvals are needed when the payment is not yet released', async () => {
    jest.spyOn(getProviderClient(), 'approvePayment').mockResolvedValue({ status: 'awaiting_approval', approvalsRemaining: 1 });
    await renderScreen(<PaymentReviewScreen />);
    await fireEvent.press(await screen.findByTestId('approve-button'));
    await fireEvent.press(await screen.findByTestId('confirm-dialog-confirm'));
    expect(await screen.findByTestId('review-outcome-title')).toHaveTextContent('Approval recorded');
    expect(screen.getByText(/1 more approval is needed before this payment is sent/)).toBeOnTheScreen();
    expect(screen.queryByText(/released/)).not.toBeOnTheScreen();
  });

  it('M7: does not claim success for a failed or unrecognised status', async () => {
    expect(approvalOutcomeCopy({ status: 'failed', approvalsRemaining: 0 })).toMatchObject({ title: 'Payment not sent', tone: 'danger' });
    expect(approvalOutcomeCopy({ status: 'unknown', approvalsRemaining: 0 })).toMatchObject({ tone: 'warning' });
    expect(approvalOutcomeCopy({ status: 'processing', approvalsRemaining: 0 })).toMatchObject({ title: 'Approved', tone: 'positive' });
    expect(approvalOutcomeCopy({ status: 'processing', approvalsRemaining: 2 }).body).toMatch(/2 more approvals are needed/);
  });

  it('a lost reply to an approval is reconciled: approved once, and reported as approved', async () => {
    const approveSpy = jest.spyOn(getProviderClient(), 'approvePayment');
    await renderScreen(<PaymentReviewScreen />);
    await fireEvent.press(await screen.findByTestId('approve-button'));
    setControls({ forcedError: 'lost_response' });
    await fireEvent.press(await screen.findByTestId('confirm-dialog-confirm'));
    // The check cannot get through either: blocked, with a way to check again.
    expect(await screen.findByText(/could not confirm whether that went through/)).toBeOnTheScreen();
    expect(screen.queryByTestId('approve-button')).not.toBeOnTheScreen();

    setControls({ forcedError: 'none' });
    await fireEvent.press(screen.getByTestId('review-recheck'));
    expect(await screen.findByTestId('review-outcome-title')).toBeOnTheScreen();
    expect(approveSpy).toHaveBeenCalledTimes(1);
    expect(await usdBalance()).toBe('39491.00');
  });

  it('an approval that never reached the server is reported as not done and can be retried', async () => {
    await renderScreen(<PaymentReviewScreen />);
    await fireEvent.press(await screen.findByTestId('approve-button'));
    setControls({ forcedError: 'network' });
    await fireEvent.press(await screen.findByTestId('confirm-dialog-confirm'));
    await screen.findByText(/could not confirm whether that went through/);
    setControls({ forcedError: 'none' });
    await fireEvent.press(screen.getByTestId('review-recheck'));
    expect(await screen.findByText(/did not go through. You can try again/)).toBeOnTheScreen();
    expect(screen.getByTestId('approve-button')).toBeEnabled();
    expect(await usdBalance()).toBe('57891.00');
  });
});
