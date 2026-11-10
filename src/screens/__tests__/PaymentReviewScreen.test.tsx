import { act, fireEvent, screen, waitFor } from '@testing-library/react-native';

import { getProviderClient } from '@/api';
import { PaymentReviewScreen } from '@/screens/PaymentReviewScreen';
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
    expect(await screen.findByText('From USD balance, $57,891.00 available')).toBeOnTheScreen();
  });

  it('approves after confirmation: pending list empties, balance drops, transaction appears', async () => {
    await renderScreen(<PaymentReviewScreen />);
    await fireEvent.press(await screen.findByTestId('approve-button'));
    await fireEvent.press(await screen.findByTestId('confirm-dialog-confirm'));

    expect(await screen.findByText('Approved')).toBeOnTheScreen();
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
    expect(await screen.findByText('Approved')).toBeOnTheScreen();
    expect(approveSpy).toHaveBeenCalledTimes(1);
    expect(await usdBalance()).toBe('39491.00');
  });

  it('rejects after a second confirmation, without moving money', async () => {
    await renderScreen(<PaymentReviewScreen />);
    await fireEvent.press(await screen.findByTestId('reject-button'));
    expect(await screen.findByText('Reject this payment?')).toBeOnTheScreen();
    await fireEvent.press(screen.getByTestId('confirm-dialog-confirm'));

    expect(await screen.findByText('Rejected')).toBeOnTheScreen();
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
    expect(screen.queryByText('Approved')).not.toBeOnTheScreen();
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
});
