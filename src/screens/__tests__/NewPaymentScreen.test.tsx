import { act, fireEvent, screen } from '@testing-library/react-native';

import { getProviderClient } from '@/api';
import { NewPaymentScreen } from '@/screens/NewPaymentScreen';
import { installMockBackend, renderScreen, setControls, signIn } from '@/test/utils';

async function gbpBalance(): Promise<string | undefined> {
  return (await getProviderClient().listBalances()).find((balance) => balance.currency === 'GBP')?.amount;
}

async function toReview(amount: string, reference: string): Promise<void> {
  await fireEvent.press(await screen.findByRole('button', { name: /Harbour Print Ltd/ }));
  await fireEvent.changeText(screen.getByTestId('payment-amount'), amount);
  await fireEvent.changeText(screen.getByTestId('payment-reference'), reference);
  await fireEvent.press(screen.getByRole('button', { name: 'Continue' }));
}

describe('NewPaymentScreen', () => {
  beforeEach(async () => {
    const mock = installMockBackend();
    await signIn(mock.client);
  });

  it('walks payee -> amount -> review -> confirm -> success', async () => {
    await renderScreen(<NewPaymentScreen />);
    await toReview('250', 'HP-9001');
    expect(await screen.findByText('£250.00')).toBeOnTheScreen();
    expect(screen.getByText('HP-9001')).toBeOnTheScreen();
    expect(screen.getByText('[YOUR FEE]')).toBeOnTheScreen();
    expect(screen.getByText('[DELIVERY ESTIMATE]')).toBeOnTheScreen();

    await fireEvent.press(screen.getByTestId('send-payment'));
    await fireEvent.press(await screen.findByTestId('confirm-dialog-confirm'));
    expect(await screen.findByText('Payment on its way')).toBeOnTheScreen();
    expect(await gbpBalance()).toBe('101714.00');
  });

  it('validates the amount and reference before review', async () => {
    await renderScreen(<NewPaymentScreen />);
    await toReview('', '');
    expect(screen.getByText('Error: Enter an amount greater than zero.')).toBeOnTheScreen();
    expect(screen.getByText('Error: Enter a reference the payee will recognise.')).toBeOnTheScreen();
    await fireEvent.changeText(screen.getByTestId('payment-amount'), '999999999');
    expect(screen.getByText('Error: You have £101,964.00 available in GBP.')).toBeOnTheScreen();
    await fireEvent.press(screen.getByRole('button', { name: 'Continue' }));
    expect(screen.queryByTestId('send-payment')).not.toBeOnTheScreen();
  });

  it('pays once on a double press, and once across a failed attempt and a retry', async () => {
    const createSpy = jest.spyOn(getProviderClient(), 'createPayment');
    await renderScreen(<NewPaymentScreen />);
    await toReview('100', 'HP-1');
    const send = screen.getByTestId('send-payment');
    await act(async () => {
      fireEvent.press(send);
      fireEvent.press(send);
    });
    setControls({ forcedError: 'network' });
    await fireEvent.press(await screen.findByTestId('confirm-dialog-confirm'));
    expect(await screen.findByText(/We could not reach the service/)).toBeOnTheScreen();
    expect(createSpy).toHaveBeenCalledTimes(1);

    setControls({ forcedError: 'none' });
    await fireEvent.press(screen.getByTestId('send-payment'));
    await fireEvent.press(await screen.findByTestId('confirm-dialog-confirm'));
    expect(await screen.findByText('Payment on its way')).toBeOnTheScreen();
    expect(createSpy).toHaveBeenCalledTimes(2);
    // Both attempts carried the same idempotency key.
    expect(createSpy.mock.calls[0]?.[0].idempotencyKey).toBe(createSpy.mock.calls[1]?.[0].idempotencyKey);
    expect(await gbpBalance()).toBe('101864.00');
  });
});
