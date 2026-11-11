import AsyncStorage from '@react-native-async-storage/async-storage';
import { act, fireEvent, screen, waitFor } from '@testing-library/react-native';

import { getProviderClient } from '@/api';
import { ProviderError } from '@/api/errors';
import { ConvertScreen } from '@/screens/ConvertScreen';
import { useSession } from '@/state/session';
import * as confirmModule from '@/lib/confirmAction';
import { pendingStorageKey } from '@/lib/pendingOutcome';
import { installMockBackend, renderScreen, setControls, setOutcomeTiming, signIn, sleep, TEST_DEVICE_SECRET } from '@/test/utils';

const expoRouter = jest.requireMock<{ __setFocused: (focused: boolean) => void }>('expo-router');


async function gbpBalance(): Promise<string | undefined> {
  return (await getProviderClient().listBalances()).find((balance) => balance.currency === 'GBP')?.amount;
}

async function typeSellAmount(text: string): Promise<void> {
  await fireEvent.changeText(screen.getByTestId('sell-amount'), text);
}

async function confirmDialog(): Promise<void> {
  await fireEvent.press(await screen.findByTestId('confirm-dialog-confirm'));
}

describe('ConvertScreen', () => {
  beforeEach(async () => {
    const mock = installMockBackend();
    await signIn(mock.client);
    await AsyncStorage.clear();
    expoRouter.__setFocused(true);
    setOutcomeTiming(700, 100);
  });

  it('cannot submit before there is a quote', async () => {
    await renderScreen(<ConvertScreen />);
    expect(screen.getByTestId('convert-submit')).toBeDisabled();
    expect(screen.getByText('Enter an amount')).toBeOnTheScreen();
  });

  it('quotes, confirms, converts and updates the balances', async () => {
    await renderScreen(<ConvertScreen />);
    await typeSellAmount('25000');

    expect(await screen.findByText('1 GBP = 1.3000 USD')).toBeOnTheScreen();
    expect(screen.getByTestId('buy-amount')).toHaveDisplayValue('32500.00');
    expect(screen.getByTestId('quote-status')).toHaveTextContent(/Rate held for 0:(30|29)/);
    // Placeholders, not invented terms.
    expect(screen.getByText('[YOUR FEE]')).toBeOnTheScreen();
    expect(screen.getByText('[SETTLEMENT TIME]')).toBeOnTheScreen();

    const submit = screen.getByRole('button', { name: 'Convert £25,000.00' });
    expect(submit).toBeEnabled();
    await fireEvent.press(submit);
    await confirmDialog();

    expect(await screen.findByText('Conversion complete')).toBeOnTheScreen();
    expect(screen.getByTestId('convert-result-buy')).toHaveTextContent('$32,500.00');
    expect(await screen.findByText('$90,391.00')).toBeOnTheScreen();
    expect(await gbpBalance()).toBe('76964.00');

    await fireEvent.press(screen.getByTestId('convert-done'));
    expect(screen.getByTestId('sell-amount')).toHaveDisplayValue('');
    expect(screen.getByTestId('convert-submit')).toBeDisabled();
  });

  it('does nothing if the confirmation is cancelled', async () => {
    await renderScreen(<ConvertScreen />);
    await typeSellAmount('100');
    await fireEvent.press(await screen.findByRole('button', { name: 'Convert £100.00' }));
    await fireEvent.press(await screen.findByTestId('confirm-dialog-cancel'));
    await waitFor(() => expect(screen.getByTestId('convert-submit')).toBeEnabled());
    expect(screen.queryByText('Conversion complete')).not.toBeOnTheScreen();
    expect(await gbpBalance()).toBe('101964.00');
  });

  it('books once when the button is pressed twice', async () => {
    // The confirm step is answered at once, so the ONLY thing between two taps and two bookings is the lock.
    jest.spyOn(confirmModule, 'confirmAction').mockResolvedValue(true);
    const bookSpy = jest.spyOn(getProviderClient(), 'bookConversion');
    await renderScreen(<ConvertScreen />);
    await typeSellAmount('1000');
    const submit = await screen.findByRole('button', { name: 'Convert £1,000.00' });
    await act(async () => {
      fireEvent.press(submit);
      fireEvent.press(submit);
    });
    expect(await screen.findByText('Conversion complete')).toBeOnTheScreen();
    expect(bookSpy).toHaveBeenCalledTimes(1);
    expect(await gbpBalance()).toBe('100964.00');
  });

  it('blocks a spot conversion larger than the balance', async () => {
    await renderScreen(<ConvertScreen />);
    await typeSellAmount('101964.01');
    expect(await screen.findByText('1 GBP = 1.3000 USD')).toBeOnTheScreen();
    expect(screen.getByText('Error: You have £101,964.00 available in GBP.')).toBeOnTheScreen();
    expect(screen.getByTestId('convert-submit')).toBeDisabled();
  });

  it('lets the buy side drive the quote and swaps currencies', async () => {
    await renderScreen(<ConvertScreen />);
    await fireEvent.changeText(screen.getByTestId('buy-amount'), '1300');
    await waitFor(() => expect(screen.getByTestId('sell-amount')).toHaveDisplayValue('1000.00'));
    expect(screen.getByRole('button', { name: 'Convert £1,000.00' })).toBeEnabled();

    await fireEvent.press(screen.getByTestId('swap-currencies'));
    // Now buying 1,300 GBP with USD: 1,300 x 1.3 = 1,690.
    await waitFor(() => expect(screen.getByTestId('sell-amount')).toHaveDisplayValue('1690.00'));
    expect(screen.getByRole('button', { name: 'Convert $1,690.00' })).toBeEnabled();
  });

  it('re-quotes automatically when the held rate expires', async () => {
    setControls({ quoteTtlSeconds: 1 });
    const quoteSpy = jest.spyOn(getProviderClient(), 'createQuote');
    await renderScreen(<ConvertScreen />);
    await typeSellAmount('500');
    await screen.findByText('1 GBP = 1.3000 USD');
    expect(quoteSpy).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(quoteSpy.mock.calls.length).toBeGreaterThanOrEqual(2), { timeout: 4000 });
    await waitFor(() => expect(screen.getByTestId('convert-submit')).toBeEnabled(), { timeout: 4000 });
  });

  it('cannot submit an expired quote when a new rate cannot be fetched', async () => {
    setControls({ quoteTtlSeconds: 1 });
    const bookSpy = jest.spyOn(getProviderClient(), 'bookConversion');
    await renderScreen(<ConvertScreen />);
    await typeSellAmount('500');
    await screen.findByText('1 GBP = 1.3000 USD');
    setControls({ forcedError: 'server' });

    expect(await screen.findByText(/We could not get a rate/, undefined, { timeout: 4000 })).toBeOnTheScreen();
    expect(screen.getByTestId('quote-status')).toHaveTextContent('Rate expired');
    const submit = screen.getByTestId('convert-submit');
    expect(submit).toBeDisabled();
    await fireEvent.press(submit);
    expect(bookSpy).not.toHaveBeenCalled();

    // Recovery: once the backend is healthy, "Get a new rate" works.
    setControls({ forcedError: 'none', quoteTtlSeconds: 30 });
    await fireEvent.press(screen.getByTestId('quote-retry'));
    await waitFor(() => expect(screen.getByTestId('convert-submit')).toBeEnabled());
  });

  it('recovers when the provider says the quote expired at booking time', async () => {
    const client = getProviderClient();
    await renderScreen(<ConvertScreen />);
    await typeSellAmount('500');
    await fireEvent.press(await screen.findByRole('button', { name: 'Convert £500.00' }));
    // The provider decides the hold has run out, whatever the app's clock says.
    jest.spyOn(client, 'bookConversion').mockRejectedValueOnce(new ProviderError('quote_expired'));
    await confirmDialog();
    expect(await screen.findByText(/That rate expired/)).toBeOnTheScreen();
    expect(await gbpBalance()).toBe('101964.00');
    // A fresh quote arrives and the button works again.
    await waitFor(() => expect(screen.getByTestId('convert-submit')).toBeEnabled());
  });

  it('shows an error and keeps the money when booking fails', async () => {
    await renderScreen(<ConvertScreen />);
    await typeSellAmount('500');
    await fireEvent.press(await screen.findByRole('button', { name: 'Convert £500.00' }));
    // A definite refusal (not an unknown outcome): say so and allow another try.
    setControls({ forcedError: 'rate_limited' });
    await confirmDialog();
    expect(await screen.findByText(/Too many requests/)).toBeOnTheScreen();
    setControls({ forcedError: 'none' });
    expect(await gbpBalance()).toBe('101964.00');
    expect(screen.queryByText('Conversion complete')).not.toBeOnTheScreen();
  });

  it('books a forward with a settlement date and leaves balances alone', async () => {
    await renderScreen(<ConvertScreen />);
    await fireEvent.press(screen.getByRole('radio', { name: 'Forward, lock a rate for later' }));
    expect(screen.getByTestId('settlement-date')).toHaveTextContent(/^Settles \d{1,2} \w{3} \d{4}$/);
    await typeSellAmount('200000');
    // More than the balance is fine for a forward.
    const submit = await screen.findByRole('button', { name: 'Book forward for $260,000.00' });
    expect(submit).toBeEnabled();
    await fireEvent.press(submit);
    await confirmDialog();
    expect(await screen.findByText('Rate locked')).toBeOnTheScreen();
    expect(await gbpBalance()).toBe('101964.00');
    expect(await getProviderClient().listForwardContracts()).toHaveLength(2);
  });

  // --- H1: one key per conversion intent, and reconciliation after a lost response ---

  it('books once when the response is lost: it blocks and checks instead of quoting and booking again', async () => {
    const client = getProviderClient();
    const bookSpy = jest.spyOn(client, 'bookConversion');
    await renderScreen(<ConvertScreen />);
    await typeSellAmount('1000');
    await fireEvent.press(await screen.findByRole('button', { name: 'Convert £1,000.00' }));
    // The server applies the booking, then the reply is lost. The checks that follow are lost too.
    setControls({ forcedError: 'lost_response', quoteTtlSeconds: 1 });
    await confirmDialog();

    expect(await screen.findByText(/we are checking whether your conversion went through/)).toBeOnTheScreen();
    // Blocked: no convert button, inputs and pickers locked, and no new quote however long we wait.
    expect(screen.queryByTestId('convert-submit')).not.toBeOnTheScreen();
    expect(screen.getByTestId('sell-amount')).toHaveProp('editable', false);
    expect(screen.getByRole('button', { name: /You sell currency/ })).toBeDisabled();
    const quoteSpy = jest.spyOn(client, 'createQuote');
    await sleep(1500);
    expect(quoteSpy).not.toHaveBeenCalled();
    // Well past the window, and still blocked: a check that cannot get an answer never releases it.
    expect(screen.queryByTestId('convert-submit')).not.toBeOnTheScreen();

    setControls({ forcedError: 'none' });
    expect(await screen.findByText('Conversion complete')).toBeOnTheScreen();
    expect(screen.getByTestId('convert-result-buy')).toHaveTextContent('$1,300.00');
    expect(bookSpy).toHaveBeenCalledTimes(1);
    expect(await gbpBalance()).toBe('100964.00');
  });

  it('reuses the same key across a re-quote of the same conversion, and a new key for a different amount', async () => {
    const client = getProviderClient();
    const bookSpy = jest.spyOn(client, 'bookConversion');
    await renderScreen(<ConvertScreen />);
    await typeSellAmount('1000');
    await fireEvent.press(await screen.findByRole('button', { name: 'Convert £1,000.00' }));
    bookSpy.mockRejectedValueOnce(new ProviderError('quote_expired'));
    await confirmDialog();
    await screen.findByText(/That rate expired/);
    // A new quote arrives for the same intent.
    await waitFor(() => expect(screen.getByTestId('convert-submit')).toBeEnabled());
    await fireEvent.press(screen.getByTestId('convert-submit'));
    await confirmDialog();
    expect(await screen.findByText('Conversion complete')).toBeOnTheScreen();

    const [first, second] = bookSpy.mock.calls.map(([request]) => request);
    expect(first?.quote.id).not.toBe(second?.quote.id);
    expect(first?.idempotencyKey).toBe(second?.idempotencyKey);
    expect(await gbpBalance()).toBe('100964.00');

    // A different conversion gets a different key.
    await fireEvent.press(screen.getByTestId('convert-done'));
    await typeSellAmount('1000');
    await fireEvent.press(await screen.findByRole('button', { name: 'Convert £1,000.00' }));
    await confirmDialog();
    await screen.findByText('Conversion complete');
    expect(bookSpy.mock.calls[2]?.[0].idempotencyKey).not.toBe(second?.idempotencyKey);
    expect(await gbpBalance()).toBe('99964.00');
  });

  it('a booking that lands AFTER the app gave up is found: one early "not found" does not release the form', async () => {
    setOutcomeTiming(1500, 100);
    const client = getProviderClient();
    const bookSpy = jest.spyOn(client, 'bookConversion');
    const findSpy = jest.spyOn(client, 'findConversionByIdempotencyKey');
    await renderScreen(<ConvertScreen />);
    await typeSellAmount('1000');
    await fireEvent.press(await screen.findByRole('button', { name: 'Convert £1,000.00' }));
    // The request fails now (as a timeout would) and is applied 400 ms later.
    setControls({ forcedError: 'applied_late', lateApplyMs: 400 });
    await confirmDialog();
    await screen.findByText(/we are checking whether your conversion went through/);

    // Early checks honestly find nothing. The form must stay blocked and must not claim nothing happened.
    await waitFor(() => expect(findSpy.mock.calls.length).toBeGreaterThanOrEqual(2));
    expect(await gbpBalance()).toBe('101964.00');
    expect(screen.queryByTestId('convert-submit')).not.toBeOnTheScreen();
    expect(screen.queryByText(/Nothing was converted|found no record/)).not.toBeOnTheScreen();

    // Then it lands, and the next check finds it.
    expect(await screen.findByText('Conversion complete', undefined, { timeout: 3000 })).toBeOnTheScreen();
    expect(bookSpy).toHaveBeenCalledTimes(1);
    expect(await gbpBalance()).toBe('100964.00');
  });

  it('releases the form only after the whole window, with wording that does not claim nothing happened', async () => {
    await renderScreen(<ConvertScreen />);
    await typeSellAmount('1000');
    await fireEvent.press(await screen.findByRole('button', { name: 'Convert £1,000.00' }));
    setControls({ forcedError: 'network', failWritesOnly: true });
    const started = Date.now();
    await confirmDialog();
    await screen.findByText(/we are checking whether your conversion went through/);
    // "Check again" inside the window finds nothing and still does not release.
    await fireEvent.press(screen.getByTestId('convert-recheck'));
    expect(screen.queryByTestId('convert-submit')).not.toBeOnTheScreen();

    expect(await screen.findByText(/found no record of that conversion. Check your balances and Activity/, undefined, { timeout: 3000 })).toBeOnTheScreen();
    expect(Date.now() - started).toBeGreaterThanOrEqual(700);
    expect(screen.queryByText(/Nothing was converted|did not go through/)).not.toBeOnTheScreen();
    expect(screen.getByTestId('convert-submit')).toBeOnTheScreen();
    expect(await gbpBalance()).toBe('101964.00');
  });

  it('records the attempt on the device BEFORE sending, so closing the app mid-request cannot lose it', async () => {
    const client = getProviderClient();
    const real = client.bookConversion.bind(client);
    const link = await client.requestMagicLink('finance@example.com', TEST_DEVICE_SECRET);
    const session = await client.verifyMagicLink(link.requestId, link.devCode ?? '', TEST_DEVICE_SECRET);
    useSession.getState().startSession(session);
    const storageKey = pendingStorageKey('conversion', session.user.id);

    // The server books it, but this app never hears back (as if it were closed mid-request).
    let storedWhenSent: string | null = null;
    const firstSpy = jest.spyOn(client, 'bookConversion').mockImplementationOnce(async (request) => {
      storedWhenSent = await AsyncStorage.getItem(storageKey);
      await real(request);
      return new Promise<never>(() => undefined);
    });
    const first = await renderScreen(<ConvertScreen />);
    await typeSellAmount('1000');
    await fireEvent.press(await screen.findByRole('button', { name: 'Convert £1,000.00' }));
    await confirmDialog();
    await waitFor(() => expect(firstSpy).toHaveBeenCalledTimes(1));
    await waitFor(async () => expect(await gbpBalance()).toBe('100964.00'));
    const sentKey = firstSpy.mock.calls[0]?.[0].idempotencyKey;
    expect(JSON.parse(storedWhenSent ?? '{}')).toMatchObject({ key: sentKey });
    first.queryClient.clear();
    await screen.unmount();

    // Reopen: the pending attempt is found and reconciled before anything else is possible.
    firstSpy.mockClear();
    await renderScreen(<ConvertScreen />);
    expect(await screen.findByText('Conversion complete')).toBeOnTheScreen();
    expect(firstSpy).not.toHaveBeenCalled();
    expect(await gbpBalance()).toBe('100964.00');
    expect(await AsyncStorage.getItem(storageKey)).toBeNull();
    await useSession.getState().signOut();
  });

  // --- M6: what was booked is compared with what was confirmed ---

  it('warns when the booked conversion differs from the confirmed quote', async () => {
    const client = getProviderClient();
    const real = client.bookConversion.bind(client);
    jest.spyOn(client, 'bookConversion').mockImplementationOnce(async (request) => ({ ...(await real(request)), buyAmount: '1250.00', rate: '1.2500' }));
    await renderScreen(<ConvertScreen />);
    await typeSellAmount('1000');
    await fireEvent.press(await screen.findByRole('button', { name: 'Convert £1,000.00' }));
    await confirmDialog();
    expect(await screen.findByText(/different from the rate you confirmed/)).toBeOnTheScreen();
    expect(screen.getByTestId('convert-result-buy')).toHaveTextContent('$1,250.00');
  });

  // --- H2 / M2: input is rejected, never reshaped ---

  it('accepts a decimal comma and rejects malformed or ambiguous amounts with a message', async () => {
    await renderScreen(<ConvertScreen />);
    await typeSellAmount('1234,56');
    await waitFor(() => expect(screen.getByTestId('buy-amount')).toHaveDisplayValue('1604.93'));
    expect(screen.getByRole('button', { name: 'Convert £1,234.56' })).toBeEnabled();

    const quoteSpy = jest.spyOn(getProviderClient(), 'createQuote');
    for (const [text, message] of [
      ['1e3', /digits/],
      ['-50', /digits/],
      ['1,234', /comma/],
      ['10.999', /at most 2 decimal places/],
    ] as const) {
      await typeSellAmount(text);
      expect(screen.getByText(message)).toBeOnTheScreen();
      expect(screen.getByTestId('sell-amount')).toHaveDisplayValue(text);
      expect(screen.getByTestId('convert-submit')).toBeDisabled();
    }
    await sleep(600);
    expect(quoteSpy).not.toHaveBeenCalled();
  });

  it('after a currency change, an amount the new currency cannot hold is rejected rather than quoted', async () => {
    const quoteSpy = jest.spyOn(getProviderClient(), 'createQuote');
    await renderScreen(<ConvertScreen />);
    await fireEvent.changeText(screen.getByTestId('buy-amount'), '100.55');
    await waitFor(() => expect(screen.getByTestId('convert-submit')).toBeEnabled());
    quoteSpy.mockClear();

    // Buy JPY instead of USD: 100.55 is not a yen amount.
    await fireEvent.press(screen.getByRole('button', { name: /You buy currency/ }));
    await fireEvent.press(await screen.findByRole('radio', { name: /JPY/ }));
    expect(await screen.findByText(/JPY has no decimal places/)).toBeOnTheScreen();
    expect(screen.getByTestId('buy-amount')).toHaveDisplayValue('100.55');
    expect(screen.getByTestId('convert-submit')).toBeDisabled();
    await sleep(600);
    expect(quoteSpy).not.toHaveBeenCalled();
  });

  // --- M3: an idle screen stops quoting ---

  it('re-quotes automatically once, then waits for a tap', async () => {
    setControls({ quoteTtlSeconds: 1 });
    const quoteSpy = jest.spyOn(getProviderClient(), 'createQuote');
    await renderScreen(<ConvertScreen />);
    await typeSellAmount('500');
    await screen.findByText('1 GBP = 1.3000 USD');
    await sleep(4200);
    expect(quoteSpy).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId('quote-status')).toHaveTextContent('Rate expired');
    expect(screen.getByTestId('convert-submit')).toBeDisabled();

    await fireEvent.press(screen.getByTestId('quote-retry'));
    await waitFor(() => expect(screen.getByTestId('convert-submit')).toBeEnabled());
    expect(quoteSpy).toHaveBeenCalledTimes(3);
  });

  it('does not re-quote while the tab is not focused', async () => {
    setControls({ quoteTtlSeconds: 1 });
    expoRouter.__setFocused(false);
    const quoteSpy = jest.spyOn(getProviderClient(), 'createQuote');
    await renderScreen(<ConvertScreen />);
    await typeSellAmount('500');
    await screen.findByText('1 GBP = 1.3000 USD');
    await sleep(2500);
    expect(quoteSpy).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('convert-submit')).toBeDisabled();
  });

  // --- M4: a 401 while quoting ends the session ---

  it('signs the user out when quoting returns 401', async () => {
    const client = getProviderClient();
    const link = await client.requestMagicLink('finance@example.com', TEST_DEVICE_SECRET);
    useSession.getState().startSession(await client.verifyMagicLink(link.requestId, link.devCode ?? '', TEST_DEVICE_SECRET));
    await renderScreen(<ConvertScreen />);
    setControls({ forcedError: 'unauthorized' });
    await typeSellAmount('500');
    await waitFor(() => expect(useSession.getState().session).toBeNull());
    expect(useSession.getState().signedOutReason).toBe('expired');
    setControls({ forcedError: 'none' });
  });

  // --- Expiry while the confirmation is open ---

  it('does not book if the rate expired while the confirmation was showing', async () => {
    setControls({ quoteTtlSeconds: 2 });
    const bookSpy = jest.spyOn(getProviderClient(), 'bookConversion');
    await renderScreen(<ConvertScreen />);
    await typeSellAmount('500');
    await fireEvent.press(await screen.findByRole('button', { name: 'Convert £500.00' }));
    await screen.findByTestId('confirm-dialog-confirm');
    const quoteSpy = jest.spyOn(getProviderClient(), 'createQuote');
    await sleep(2200);
    // While the booking is in flight (confirmation open), the quote is not swapped underneath it.
    expect(quoteSpy).not.toHaveBeenCalled();
    await confirmDialog();
    expect(await screen.findByText(/expired while you were confirming/)).toBeOnTheScreen();
    expect(bookSpy).not.toHaveBeenCalled();
    expect(await gbpBalance()).toBe('101964.00');
  });
});
