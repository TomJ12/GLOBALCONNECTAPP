import AsyncStorage from '@react-native-async-storage/async-storage';
import { act, fireEvent, screen, waitFor } from '@testing-library/react-native';

import { getProviderClient } from '@/api';
import * as confirmModule from '@/lib/confirmAction';
import { paymentMatchesRequest } from '@/lib/paymentMatch';
import { pendingStorageKey } from '@/lib/pendingOutcome';
import { NewPaymentScreen, paymentOutcomeCopy } from '@/screens/NewPaymentScreen';
import { useSession } from '@/state/session';
import { installMockBackend, renderScreen, setControls, setOutcomeTiming, signIn, sleep, TEST_DEVICE_SECRET } from '@/test/utils';

async function gbpBalance(): Promise<string | undefined> {
  return (await getProviderClient().listBalances()).find((balance) => balance.currency === 'GBP')?.amount;
}

async function toReview(amount: string, reference: string, payee: RegExp = /Harbour Print Ltd/): Promise<void> {
  await fireEvent.press(await screen.findByRole('button', { name: payee }));
  await fireEvent.changeText(screen.getByTestId('payment-amount'), amount);
  await fireEvent.changeText(screen.getByTestId('payment-reference'), reference);
  await fireEvent.press(screen.getByRole('button', { name: 'Continue' }));
}

async function sendAndConfirm(): Promise<void> {
  await fireEvent.press(screen.getByTestId('send-payment'));
  await fireEvent.press(await screen.findByTestId('confirm-dialog-confirm'));
}

async function signInAs(email: string): Promise<string> {
  const client = getProviderClient();
  const link = await client.requestMagicLink(email, TEST_DEVICE_SECRET);
  const session = await client.verifyMagicLink(link.requestId, link.devCode ?? '', TEST_DEVICE_SECRET);
  useSession.getState().startSession(session);
  return session.user.id;
}

describe('NewPaymentScreen', () => {
  beforeEach(async () => {
    const mock = installMockBackend();
    useSession.setState({ session: null, signedOutReason: null });
    await signIn(mock.client);
    await AsyncStorage.clear();
    setOutcomeTiming(700, 100);
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
    expect(screen.queryByText(/different from the payment you confirmed/)).not.toBeOnTheScreen();
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
    await fireEvent.changeText(screen.getByTestId('payment-amount'), '12,5');
    await fireEvent.changeText(screen.getByTestId('payment-reference'), 'HP-1');
    await fireEvent.press(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByText('£12.50')).toBeOnTheScreen();
  });

  it('pays once on a double press', async () => {
    // The confirm step is answered at once, so the ONLY thing between two taps and two payments is the lock.
    jest.spyOn(confirmModule, 'confirmAction').mockResolvedValue(true);
    const createSpy = jest.spyOn(getProviderClient(), 'createPayment');
    await renderScreen(<NewPaymentScreen />);
    await toReview('100', 'HP-1');
    const send = screen.getByTestId('send-payment');
    await act(async () => {
      fireEvent.press(send);
      fireEvent.press(send);
    });
    await screen.findByTestId('payment-outcome-title');
    expect(createSpy).toHaveBeenCalledTimes(1);
    expect(await gbpBalance()).toBe('101864.00');
  });

  it('a lost response blocks editing and resending, then shows the real payment', async () => {
    const createSpy = jest.spyOn(getProviderClient(), 'createPayment');
    await renderScreen(<NewPaymentScreen />);
    await toReview('100', 'HP-1');
    setControls({ forcedError: 'lost_response' });
    await sendAndConfirm();

    expect(await screen.findByText(/we are checking whether your payment went through/)).toBeOnTheScreen();
    expect(screen.queryByTestId('send-payment')).not.toBeOnTheScreen();
    expect(screen.queryByTestId('payment-amount')).not.toBeOnTheScreen();
    // Past the window and still blocked, because no check has been able to get an answer.
    await sleep(1000);
    expect(screen.queryByTestId('send-payment')).not.toBeOnTheScreen();

    setControls({ forcedError: 'none' });
    expect(await screen.findByTestId('payment-outcome-title')).toHaveTextContent('Payment on its way');
    expect(screen.getByTestId('payment-outcome-amount')).toHaveTextContent('£100.00');
    expect(createSpy).toHaveBeenCalledTimes(1);
    expect(await gbpBalance()).toBe('101864.00');
  });

  it('a payment that lands AFTER the app gave up is found: one early "not found" does not release the form', async () => {
    setOutcomeTiming(1500, 100);
    const client = getProviderClient();
    const createSpy = jest.spyOn(client, 'createPayment');
    const findSpy = jest.spyOn(client, 'findPaymentByIdempotencyKey');
    await renderScreen(<NewPaymentScreen />);
    await toReview('100', 'HP-1');
    setControls({ forcedError: 'applied_late', lateApplyMs: 400 });
    await sendAndConfirm();
    await screen.findByText(/we are checking whether your payment went through/);

    await waitFor(() => expect(findSpy.mock.calls.length).toBeGreaterThanOrEqual(2));
    expect(await gbpBalance()).toBe('101964.00');
    // Still blocked, and nothing on screen says the money did not move.
    expect(screen.queryByTestId('send-payment')).not.toBeOnTheScreen();
    expect(screen.queryByTestId('payment-amount')).not.toBeOnTheScreen();
    expect(screen.queryByText(/No money has left|did not go through|found no record/)).not.toBeOnTheScreen();

    expect(await screen.findByTestId('payment-outcome-amount', undefined, { timeout: 3000 })).toHaveTextContent('£100.00');
    expect(createSpy).toHaveBeenCalledTimes(1);
    expect(await gbpBalance()).toBe('101864.00');
  });

  it('releases the form only after the whole window, with wording that does not claim nothing happened', async () => {
    await renderScreen(<NewPaymentScreen />);
    await toReview('100', 'HP-1');
    setControls({ forcedError: 'network', failWritesOnly: true });
    const started = Date.now();
    await sendAndConfirm();
    await screen.findByText(/we are checking whether your payment went through/);
    await fireEvent.press(screen.getByTestId('payment-recheck'));
    expect(screen.queryByTestId('send-payment')).not.toBeOnTheScreen();

    expect(await screen.findByText(/found no record of that payment. Check Payments and your balance/, undefined, { timeout: 3000 })).toBeOnTheScreen();
    expect(Date.now() - started).toBeGreaterThanOrEqual(700);
    expect(screen.queryByText(/No money has left|did not go through/)).not.toBeOnTheScreen();
    expect(screen.getByTestId('send-payment')).toBeOnTheScreen();
    expect(await gbpBalance()).toBe('101964.00');
  });

  it('records the attempt on the device BEFORE sending, so closing the app mid-request cannot lose it', async () => {
    const userId = await signInAs('finance@example.com');
    const storageKey = pendingStorageKey('payment', userId);
    const client = getProviderClient();
    const real = client.createPayment.bind(client);
    let storedWhenSent: string | null = null;
    // The server makes the payment, but this app never hears back (as if it were closed mid-request).
    const spy = jest.spyOn(client, 'createPayment').mockImplementationOnce(async (input) => {
      storedWhenSent = await AsyncStorage.getItem(storageKey);
      await real(input);
      return new Promise<never>(() => undefined);
    });
    const first = await renderScreen(<NewPaymentScreen />);
    await toReview('100', 'HP-1');
    await sendAndConfirm();
    await waitFor(async () => expect(await gbpBalance()).toBe('101864.00'));
    expect(JSON.parse(storedWhenSent ?? '{}')).toMatchObject({ key: spy.mock.calls[0]?.[0].idempotencyKey });
    first.queryClient.clear();
    await screen.unmount();

    // Reopen: the pending payment is reconciled before a new one can be started.
    spy.mockClear();
    await renderScreen(<NewPaymentScreen />);
    expect(await screen.findByTestId('payment-outcome-amount')).toHaveTextContent('£100.00');
    expect(spy).not.toHaveBeenCalled();
    expect(await gbpBalance()).toBe('101864.00');
    expect(await AsyncStorage.getItem(storageKey)).toBeNull();
  });

  it('a pending payment belongs to the person who sent it: the next user of the device is not blocked and sees nothing of it', async () => {
    const userA = await signInAs('a@example.com');
    const first = await renderScreen(<NewPaymentScreen />);
    await toReview('100', 'HP-1');
    setControls({ forcedError: 'lost_response' });
    await sendAndConfirm();
    await screen.findByText(/we are checking whether your payment went through/);
    first.queryClient.clear();
    await screen.unmount();
    setControls({ forcedError: 'none' });
    await useSession.getState().signOut();

    const userB = await signInAs('b@example.com');
    expect(userB).not.toBe(userA);
    expect(pendingStorageKey('payment', userB)).not.toBe(pendingStorageKey('payment', userA));
    await renderScreen(<NewPaymentScreen />);
    // B gets the normal first step: not blocked, and not shown A's £100 payment.
    expect(await screen.findByText('Who are you paying?')).toBeOnTheScreen();
    await sleep(300);
    expect(screen.queryByTestId('payment-outcome-amount')).not.toBeOnTheScreen();
    expect(screen.queryByText(/we are checking/)).not.toBeOnTheScreen();
    // A's record is still there for A.
    expect(await AsyncStorage.getItem(pendingStorageKey('payment', userA))).not.toBeNull();
  });

  it('the key is bound to payee, amount and reference: the same payment reuses it, any change gets a new one', async () => {
    const client = getProviderClient();
    // A second payee in the SAME currency, so that only the payee differs in the last step.
    const other = await client.createBeneficiary({ name: 'Second Sterling Ltd', entityType: 'company', currency: 'GBP', bankCountry: 'GB', sortCode: '123456', accountNumber: '12345678' });
    const createSpy = jest.spyOn(client, 'createPayment');
    await renderScreen(<NewPaymentScreen />);
    await toReview('100', 'HP-1');
    const keys = () => createSpy.mock.calls.map(([input]) => input.idempotencyKey);
    const refuse = async () => {
      setControls({ forcedError: 'rate_limited' });
      await sendAndConfirm();
      await screen.findByText(/Too many requests/);
      setControls({ forcedError: 'none' });
    };

    await refuse();
    await refuse();
    expect(keys()[1]).toBe(keys()[0]); // same payment, same key

    // Different reference only.
    await fireEvent.press(screen.getByRole('button', { name: 'Back' }));
    await fireEvent.changeText(screen.getByTestId('payment-reference'), 'HP-2');
    await fireEvent.press(screen.getByRole('button', { name: 'Continue' }));
    await refuse();
    expect(keys()[2]).not.toBe(keys()[0]);

    // Different amount only.
    await fireEvent.press(screen.getByRole('button', { name: 'Back' }));
    await fireEvent.changeText(screen.getByTestId('payment-amount'), '200');
    await fireEvent.press(screen.getByRole('button', { name: 'Continue' }));
    await refuse();
    expect(keys()[3]).not.toBe(keys()[2]);

    // Different payee only (same amount and reference typed again).
    await fireEvent.press(screen.getByRole('button', { name: 'Back' }));
    await fireEvent.press(screen.getByRole('button', { name: 'Back' }));
    await toReview('200', 'HP-2', /Second Sterling Ltd/);
    await refuse();
    expect(createSpy.mock.calls[4]?.[0]).toMatchObject({ beneficiaryId: other.id, amount: '200.00', currency: 'GBP', reference: 'HP-2' });
    expect(keys()[4]).not.toBe(keys()[3]);
    expect(new Set(keys()).size).toBe(4);
  });

  it('the outcome copy follows the status the backend reported', async () => {
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

  it('warns when the payment the backend created differs from the one that was sent', async () => {
    const sent = { beneficiaryId: 'b1', amount: '100.00', currency: 'GBP', reference: 'HP-1' };
    expect(paymentMatchesRequest({ ...sent, amount: '100' }, sent)).toBe(true);
    expect(paymentMatchesRequest({ ...sent, amount: '1000.00' }, sent)).toBe(false);
    expect(paymentMatchesRequest({ ...sent, beneficiaryId: 'b2' }, sent)).toBe(false);
    expect(paymentMatchesRequest({ ...sent, currency: 'USD' }, sent)).toBe(false);
    expect(paymentMatchesRequest({ ...sent, reference: 'HP-2' }, sent)).toBe(false);

    const client = getProviderClient();
    const real = client.createPayment.bind(client);
    jest.spyOn(client, 'createPayment').mockImplementationOnce(async (input) => ({ ...(await real(input)), amount: '1000.00' }));
    await renderScreen(<NewPaymentScreen />);
    await toReview('100', 'HP-1');
    await sendAndConfirm();
    expect(await screen.findByText(/different from the payment you confirmed/)).toBeOnTheScreen();
    expect(screen.getByTestId('payment-outcome-amount')).toHaveTextContent('£1,000.00');
  });
});
