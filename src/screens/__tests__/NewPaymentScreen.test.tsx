import AsyncStorage from '@react-native-async-storage/async-storage';
import { act, fireEvent, screen } from '@testing-library/react-native';

import { getProviderClient } from '@/api';
import { NewPaymentScreen, paymentOutcomeCopy } from '@/screens/NewPaymentScreen';
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

async function sendAndConfirm(): Promise<void> {
  await fireEvent.press(screen.getByTestId('send-payment'));
  await fireEvent.press(await screen.findByTestId('confirm-dialog-confirm'));
}

describe('NewPaymentScreen', () => {
  beforeEach(async () => {
    const mock = installMockBackend();
    await signIn(mock.client);
    await AsyncStorage.clear();
  });

  it('walks payee -> amount -> review -> confirm -> outcome', async () => {
    const createSpy = jest.spyOn(getProviderClient(), 'createPayment');
    await renderScreen(<NewPaymentScreen />);
    await toReview('250', 'HP-9001');
    expect(await screen.findByText('£250.00')).toBeOnTheScreen();
    expect(screen.getByText('[YOUR FEE]')).toBeOnTheScreen();
    expect(screen.getByText('[DELIVERY ESTIMATE]')).toBeOnTheScreen();

    await fireEvent.press(screen.getByRole('button', { name: 'Send payment' }));
    // The confirm step states amount, payee, masked account and reference; nothing is sent before it.
    expect(await screen.findByText('£250.00 to Harbour Print Ltd, GBP account ending 0000. Reference HP-9001.')).toBeOnTheScreen();
    expect(createSpy).not.toHaveBeenCalled();
    await fireEvent.press(screen.getByTestId('confirm-dialog-confirm'));
    expect(await screen.findByTestId('payment-outcome-title')).toHaveTextContent('Payment on its way');
    expect(await gbpBalance()).toBe('101714.00');
  });

  it('does nothing if the confirmation is cancelled', async () => {
    const createSpy = jest.spyOn(getProviderClient(), 'createPayment');
    await renderScreen(<NewPaymentScreen />);
    await toReview('250', 'HP-9001');
    await fireEvent.press(screen.getByTestId('send-payment'));
    await fireEvent.press(await screen.findByTestId('confirm-dialog-cancel'));
    expect(createSpy).not.toHaveBeenCalled();
    expect(await gbpBalance()).toBe('101964.00');
  });

  it('validates the amount and reference before review, rejecting malformed amounts', async () => {
    await renderScreen(<NewPaymentScreen />);
    await toReview('', '');
    expect(screen.getByText('Error: Enter an amount greater than zero.')).toBeOnTheScreen();
    expect(screen.getByText('Error: Enter a reference the payee will recognise.')).toBeOnTheScreen();
    await fireEvent.changeText(screen.getByTestId('payment-amount'), '999999999');
    expect(screen.getByText('Error: You have £101,964.00 available in GBP.')).toBeOnTheScreen();
    for (const [text, message] of [
      ['1e3', /digits/],
      ['-50', /digits/],
      ['1,234', /comma/],
      ['12.345', /at most 2 decimal places/],
    ] as const) {
      await fireEvent.changeText(screen.getByTestId('payment-amount'), text);
      expect(screen.getByText(message)).toBeOnTheScreen();
      await fireEvent.press(screen.getByRole('button', { name: 'Continue' }));
      expect(screen.queryByTestId('send-payment')).not.toBeOnTheScreen();
    }
    // A decimal comma is understood, not turned into a larger number.
    await fireEvent.changeText(screen.getByTestId('payment-amount'), '12,5');
    await fireEvent.changeText(screen.getByTestId('payment-reference'), 'HP-1');
    await fireEvent.press(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByText('£12.50')).toBeOnTheScreen();
  });

  it('pays once on a double press', async () => {
    const createSpy = jest.spyOn(getProviderClient(), 'createPayment');
    await renderScreen(<NewPaymentScreen />);
    await toReview('100', 'HP-1');
    const send = screen.getByTestId('send-payment');
    await act(async () => {
      fireEvent.press(send);
      fireEvent.press(send);
    });
    await fireEvent.press(await screen.findByTestId('confirm-dialog-confirm'));
    await screen.findByTestId('payment-outcome-title');
    expect(createSpy).toHaveBeenCalledTimes(1);
    expect(await gbpBalance()).toBe('101864.00');
  });

  it('M1: a lost response blocks editing and resending until the outcome is known, then shows the real payment', async () => {
    const createSpy = jest.spyOn(getProviderClient(), 'createPayment');
    await renderScreen(<NewPaymentScreen />);
    await toReview('100', 'HP-1');
    setControls({ forcedError: 'lost_response' });
    await sendAndConfirm();

    // The payment was made, but nobody knows yet. No way to change the amount or send again.
    expect(await screen.findByText(/We still cannot confirm whether your payment went through/)).toBeOnTheScreen();
    expect(screen.queryByTestId('send-payment')).not.toBeOnTheScreen();
    expect(screen.queryByTestId('payment-amount')).not.toBeOnTheScreen();

    setControls({ forcedError: 'none' });
    await fireEvent.press(screen.getByTestId('payment-recheck'));
    expect(await screen.findByTestId('payment-outcome-title')).toHaveTextContent('Payment on its way');
    expect(screen.getByTestId('payment-outcome-amount')).toHaveTextContent('£100.00');
    expect(createSpy).toHaveBeenCalledTimes(1);
    expect(await gbpBalance()).toBe('101864.00');
  });

  it('M1: an unknown outcome survives leaving the screen', async () => {
    const first = await renderScreen(<NewPaymentScreen />);
    await toReview('100', 'HP-1');
    setControls({ forcedError: 'lost_response' });
    await sendAndConfirm();
    await screen.findByText(/We still cannot confirm/);
    first.queryClient.clear();
    await screen.unmount();

    setControls({ forcedError: 'none' });
    const createSpy = jest.spyOn(getProviderClient(), 'createPayment');
    await renderScreen(<NewPaymentScreen />);
    expect(await screen.findByTestId('payment-outcome-amount')).toHaveTextContent('£100.00');
    expect(createSpy).not.toHaveBeenCalled();
    expect(await gbpBalance()).toBe('101864.00');
  });

  it('M1: the key is bound to the payment. Same details reuse it; a changed amount gets a new one', async () => {
    const client = getProviderClient();
    const createSpy = jest.spyOn(client, 'createPayment');
    await renderScreen(<NewPaymentScreen />);
    await toReview('100', 'HP-1');

    // Attempt 1 never reaches the server.
    setControls({ forcedError: 'network' });
    await sendAndConfirm();
    await screen.findByText(/We still cannot confirm/);
    setControls({ forcedError: 'none' });
    await fireEvent.press(screen.getByTestId('payment-recheck'));
    expect(await screen.findByText(/did not go through. No money has left your account/)).toBeOnTheScreen();

    // Attempt 2, same details, is refused outright (not ambiguous).
    setControls({ forcedError: 'rate_limited' });
    await sendAndConfirm();
    await screen.findByText(/Too many requests/);
    setControls({ forcedError: 'none' });
    expect(createSpy.mock.calls[1]?.[0].idempotencyKey).toBe(createSpy.mock.calls[0]?.[0].idempotencyKey);

    // Change the amount: a different payment, a different key, and the result shows the new amount.
    await fireEvent.press(screen.getByRole('button', { name: 'Back' }));
    await fireEvent.changeText(screen.getByTestId('payment-amount'), '200');
    await fireEvent.press(screen.getByRole('button', { name: 'Continue' }));
    await sendAndConfirm();
    expect(await screen.findByTestId('payment-outcome-amount')).toHaveTextContent('£200.00');
    expect(createSpy.mock.calls[2]?.[0].idempotencyKey).not.toBe(createSpy.mock.calls[0]?.[0].idempotencyKey);
    expect(createSpy.mock.calls[2]?.[0].amount).toBe('200.00');
    expect(await gbpBalance()).toBe('101764.00');
  });

  it('M7: the outcome copy follows the status the backend reported', async () => {
    expect(paymentOutcomeCopy('processing')).toMatchObject({ title: 'Payment on its way', tone: 'positive' });
    expect(paymentOutcomeCopy('sent')).toMatchObject({ title: 'Payment sent', tone: 'positive' });
    expect(paymentOutcomeCopy('awaiting_approval')).toMatchObject({ title: 'Not sent yet', tone: 'warning' });
    expect(paymentOutcomeCopy('failed')).toMatchObject({ title: 'Payment failed', tone: 'danger' });
    expect(paymentOutcomeCopy('cancelled').tone).toBe('danger');
    expect(paymentOutcomeCopy('unknown')).toMatchObject({ title: 'Status not confirmed', tone: 'warning' });

    const client = getProviderClient();
    const real = client.createPayment.bind(client);
    jest.spyOn(client, 'createPayment').mockImplementationOnce(async (input) => ({ ...(await real(input)), status: 'awaiting_approval' }));
    await renderScreen(<NewPaymentScreen />);
    await toReview('100', 'HP-1');
    await sendAndConfirm();
    expect(await screen.findByTestId('payment-outcome-title')).toHaveTextContent('Not sent yet');
    expect(screen.queryByText(/on its way/i)).not.toBeOnTheScreen();
    expect(screen.queryByText('[DELIVERY ESTIMATE]')).not.toBeOnTheScreen();
  });
});
