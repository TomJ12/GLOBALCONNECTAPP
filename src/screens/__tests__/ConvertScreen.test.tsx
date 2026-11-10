import { act, fireEvent, screen, waitFor } from '@testing-library/react-native';

import { getProviderClient } from '@/api';
import { ProviderError } from '@/api/errors';
import { ConvertScreen } from '@/screens/ConvertScreen';
import { installMockBackend, renderScreen, setControls, signIn } from '@/test/utils';

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
    const bookSpy = jest.spyOn(getProviderClient(), 'bookConversion');
    await renderScreen(<ConvertScreen />);
    await typeSellAmount('1000');
    const submit = await screen.findByRole('button', { name: 'Convert £1,000.00' });
    await act(async () => {
      fireEvent.press(submit);
      fireEvent.press(submit);
    });
    await confirmDialog();
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
    setControls({ forcedError: 'server' });
    await confirmDialog();
    expect(await screen.findByText(/Something went wrong on our side/)).toBeOnTheScreen();
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
});
