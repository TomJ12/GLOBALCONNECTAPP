import { fireEvent, screen } from '@testing-library/react-native';

import type { RatePair } from '@/api/types';
import { HomeScreen } from '@/screens/HomeScreen';
import { RatesScreen } from '@/screens/RatesScreen';
import { installMockBackend, renderScreen, signIn, startTestSession } from '@/test/utils';

const { router } = jest.requireMock<{ router: { push: jest.Mock } }>('expo-router');

/** What the Global Connect server sends: the customer's own two rates (never a mid rate, never a margin). */
function serveClientRates(mock: ReturnType<typeof installMockBackend>): void {
  const original = mock.client.getRate.bind(mock.client);
  jest.spyOn(mock.client, 'getRate').mockImplementation(async (base: string, quote: string): Promise<RatePair> => {
    const raw = await original(base, quote);
    const scaled = (factor: number) => (Number(raw.rate) * factor).toFixed(6);
    return { ...raw, rate: scaled(0.995), buyRate: scaled(1.005), indicative: true };
  });
}

describe('RatesScreen: the customer’s own buy and sell rates', () => {
  beforeEach(() => {
    router.push.mockClear();
  });

  it('shows a sell rate and a buy rate for each pair, labelled as the customer’s and as indicative, and each opens Convert for that trade', async () => {
    const mock = installMockBackend();
    await startTestSession();
    serveClientRates(mock);
    await renderScreen(<RatesScreen />);

    // GBP/USD sample 1.3000: selling GBP 1.2935, buying GBP 1.3065.
    expect(await screen.findByTestId('rate-GBPUSD')).toHaveTextContent('Sell GBP1.2935');
    expect(screen.getByTestId('rate-buy-GBPUSD')).toHaveTextContent('Buy GBP1.3065');
    expect(screen.getAllByText('Your rate · Indicative').length).toBeGreaterThan(1);
    expect(screen.getByRole('button', { name: 'Sell GBP, your rate 1.2935 USD per GBP, indicative' })).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Buy GBP, your rate 1.3065 USD per GBP, indicative' })).toBeOnTheScreen();
    // Nothing on the screen speaks of a mid-market rate or a margin.
    expect(screen.queryByText(/mid|margin|spread|markup/i)).not.toBeOnTheScreen();

    await fireEvent.press(screen.getByTestId('rate-GBPUSD'));
    expect(router.push).toHaveBeenLastCalledWith({ pathname: '/convert', params: { sell: 'GBP', buy: 'USD' } });
    await fireEvent.press(screen.getByTestId('rate-buy-GBPUSD'));
    expect(router.push).toHaveBeenLastCalledWith({ pathname: '/convert', params: { sell: 'USD', buy: 'GBP' } });
  });

  it('in the in-app demo there is one sample rate, shown for both directions', async () => {
    installMockBackend();
    await startTestSession();
    await renderScreen(<RatesScreen />);
    expect(await screen.findByTestId('rate-GBPUSD')).toHaveTextContent('Sell GBP1.3000');
    expect(screen.getByTestId('rate-buy-GBPUSD')).toHaveTextContent('Buy GBP1.3000');
  });

  it('Home values other currencies at the rate the customer would SELL them at, and says so', async () => {
    const mock = installMockBackend();
    await signIn(mock.client);
    serveClientRates(mock);
    await renderScreen(<HomeScreen />);
    // 101,964.00 + 57,891.00 / 1.3065 + 24,310.50 / 1.1859: buying GBP costs more, so the total is LOWER than at 1.3 and 1.18.
    expect(await screen.findByTestId('total-balance')).toHaveTextContent('£166,773.61');
    expect(screen.getByText(/A valuation, estimated at your current sell rates as of \d{2}:\d{2}\.$/)).toBeOnTheScreen();
  });
});
