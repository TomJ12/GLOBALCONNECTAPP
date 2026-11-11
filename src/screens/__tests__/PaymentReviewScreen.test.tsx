import { act, fireEvent, screen, waitFor } from '@testing-library/react-native';

import { getProviderClient } from '@/api';
import * as confirmModule from '@/lib/confirmAction';
import { approvalOutcomeCopy, noLongerPendingCopy, PaymentReviewScreen } from '@/screens/PaymentReviewScreen';
import { installMockBackend, renderScreen, setControls, setOutcomeTiming, signIn, sleep } from '@/test/utils';

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
    setOutcomeTiming(700, 100);
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
    // The confirm step is answered at once, so the ONLY thing between two taps and two approvals is the lock.
    jest.spyOn(confirmModule, 'confirmAction').mockResolvedValue(true);
    const approveSpy = jest.spyOn(getProviderClient(), 'approvePayment');
    await renderScreen(<PaymentReviewScreen />);
    const approve = await screen.findByTestId('approve-button');
    await act(async () => {
      fireEvent.press(approve);
      fireEvent.press(approve);
    });
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

  it('a lost reply to an approval: approved once, and the outcome does not claim to know why it left the list', async () => {
    const approveSpy = jest.spyOn(getProviderClient(), 'approvePayment');
    await renderScreen(<PaymentReviewScreen />);
    await fireEvent.press(await screen.findByTestId('approve-button'));
    setControls({ forcedError: 'lost_response' });
    await fireEvent.press(await screen.findByTestId('confirm-dialog-confirm'));
    // Checks cannot get through either: blocked, past the window, for as long as that lasts.
    expect(await screen.findByText(/we are checking whether that went through/)).toBeOnTheScreen();
    await sleep(1000);
    expect(screen.queryByTestId('approve-button')).not.toBeOnTheScreen();

    setControls({ forcedError: 'none' });
    expect(await screen.findByTestId('review-outcome-title')).toHaveTextContent('No longer waiting for approval');
    expect(screen.getByText(/may be because of your approval or because someone else approved or rejected it/)).toBeOnTheScreen();
    expect(approveSpy).toHaveBeenCalledTimes(1);
    expect(await usdBalance()).toBe('39491.00');
  });

  it('an approval that lands AFTER the app gave up is found: one early look does not say it failed', async () => {
    setOutcomeTiming(1500, 100);
    const client = getProviderClient();
    const listSpy = jest.spyOn(client, 'listPendingApprovals');
    await renderScreen(<PaymentReviewScreen />);
    await fireEvent.press(await screen.findByTestId('approve-button'));
    setControls({ forcedError: 'applied_late', lateApplyMs: 400 });
    await fireEvent.press(await screen.findByTestId('confirm-dialog-confirm'));
    await screen.findByText(/we are checking whether that went through/);
    listSpy.mockClear();
    await waitFor(() => expect(listSpy.mock.calls.length).toBeGreaterThanOrEqual(2));
    // The server has not acted yet. The screen must stay blocked and must not say it did not go through.
    expect(await usdBalance()).toBe('57891.00');
    expect(screen.queryByTestId('approve-button')).not.toBeOnTheScreen();
    expect(screen.queryByText(/did not go through|still waiting for approval/)).not.toBeOnTheScreen();

    expect(await screen.findByTestId('review-outcome-title', undefined, { timeout: 3000 })).toBeOnTheScreen();
    expect(await usdBalance()).toBe('39491.00');
  });

  it('releases the buttons only after the whole window, without claiming the approval failed', async () => {
    await renderScreen(<PaymentReviewScreen />);
    await fireEvent.press(await screen.findByTestId('approve-button'));
    setControls({ forcedError: 'network', failWritesOnly: true });
    const started = Date.now();
    await fireEvent.press(await screen.findByTestId('confirm-dialog-confirm'));
    await screen.findByText(/we are checking whether that went through/);
    await fireEvent.press(screen.getByTestId('review-recheck'));
    expect(screen.queryByTestId('approve-button')).not.toBeOnTheScreen();

    expect(await screen.findByText(/this payment is still waiting for approval. Look at it again/, undefined, { timeout: 3000 })).toBeOnTheScreen();
    expect(Date.now() - started).toBeGreaterThanOrEqual(700);
    expect(screen.getByTestId('approve-button')).toBeEnabled();
    expect(await usdBalance()).toBe('57891.00');
  });

  it('an unread answer to a rejection never says the payment was cancelled or that no money left', async () => {
    expect(noLongerPendingCopy('reject').body).toMatch(/Do not assume it was cancelled/);
    expect(JSON.stringify([noLongerPendingCopy('reject'), noLongerPendingCopy('approve')])).not.toMatch(/No money has left|was cancelled\./);

    await renderScreen(<PaymentReviewScreen />);
    await fireEvent.press(await screen.findByTestId('reject-button'));
    setControls({ forcedError: 'lost_response', failWritesOnly: true });
    await fireEvent.press(await screen.findByTestId('confirm-dialog-confirm'));
    expect(await screen.findByTestId('review-outcome-title')).toHaveTextContent('No longer waiting for approval');
    expect(screen.queryByText(/No money has left your account/)).not.toBeOnTheScreen();
    expect(screen.getByText(/Do not assume it was cancelled/)).toBeOnTheScreen();
  });

  it('re-reads the payment before confirming and stops if it changed since the screen loaded', async () => {
    const client = getProviderClient();
    const approveSpy = jest.spyOn(client, 'approvePayment');
    await renderScreen(<PaymentReviewScreen />);
    await screen.findByTestId('review-amount');

    // Between loading the screen and pressing Approve, the payee's account is changed elsewhere.
    const real = await client.listPendingApprovals();
    jest.spyOn(client, 'listPendingApprovals').mockResolvedValue(
      real.map((approval) => ({ ...approval, beneficiary: approval.beneficiary && { ...approval.beneficiary, accountNumber: '999999999999' } })),
    );
    await fireEvent.press(screen.getByTestId('approve-button'));
    expect(await screen.findByText(/This payment changed after you opened it/)).toBeOnTheScreen();
    expect(screen.queryByText('Approve this payment?')).not.toBeOnTheScreen();
    expect(approveSpy).not.toHaveBeenCalled();
    // The screen now shows the new details, and a second, informed press goes ahead.
    expect(await screen.findByText('•••• 9999')).toBeOnTheScreen();
    await fireEvent.press(screen.getByTestId('approve-button'));
    expect(await screen.findByText(/USD account ending 9999/)).toBeOnTheScreen();
  });

  it('also stops when the amount changed, and when the latest state cannot be read', async () => {
    const client = getProviderClient();
    const approveSpy = jest.spyOn(client, 'approvePayment');
    await renderScreen(<PaymentReviewScreen />);
    await screen.findByTestId('review-amount');
    const real = await client.listPendingApprovals();
    const listSpy = jest.spyOn(client, 'listPendingApprovals');
    listSpy.mockResolvedValueOnce(real.map((approval) => ({ ...approval, payment: { ...approval.payment, amount: '81400.00' } })));
    await fireEvent.press(screen.getByTestId('approve-button'));
    expect(await screen.findByText(/This payment changed after you opened it/)).toBeOnTheScreen();

    setControls({ forcedError: 'server' });
    await fireEvent.press(screen.getByTestId('reject-button'));
    expect(await screen.findByText(/could not check that this payment is still up to date/)).toBeOnTheScreen();
    setControls({ forcedError: 'none' });
    expect(approveSpy).not.toHaveBeenCalled();
    expect(await getProviderClient().listPendingApprovals()).toHaveLength(1);
  });

  it('shows a masked IBAN when the payee is paid by IBAN', async () => {
    const client = getProviderClient();
    const real = await client.listPendingApprovals();
    jest.spyOn(client, 'listPendingApprovals').mockResolvedValue(
      real.map((approval) => ({
        ...approval,
        beneficiary: approval.beneficiary && { ...approval.beneficiary, accountNumber: null, iban: 'DE89370400440532013000', bankCountry: 'DE' },
      })),
    );
    await renderScreen(<PaymentReviewScreen />);
    expect(await screen.findByLabelText('IBAN: •••• 3000')).toBeOnTheScreen();
    expect(screen.queryByText(/DE8937/)).not.toBeOnTheScreen();
  });
});
