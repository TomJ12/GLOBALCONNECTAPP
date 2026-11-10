import { onlineManager } from '@tanstack/react-query';
import { act, fireEvent, screen } from '@testing-library/react-native';

import { HomeScreen } from '@/screens/HomeScreen';
import { installMockBackend, renderScreen, setControls, signIn } from '@/test/utils';

const { router } = jest.requireMock<{ router: { push: jest.Mock } }>('expo-router');

describe('HomeScreen', () => {
  beforeEach(async () => {
    const mock = installMockBackend();
    await signIn(mock.client);
    router.push.mockClear();
  });

  it('shows the company, the GBP-equivalent total, accounts, the approval banner and activity', async () => {
    await renderScreen(<HomeScreen />);
    expect(await screen.findByText('Northfield Trading Ltd')).toBeOnTheScreen();
    expect(screen.getByText('Business Standard')).toBeOnTheScreen();
    // 101,964.00 + 57,891.00 / 1.3 + 24,310.50 / 1.18
    expect(await screen.findByTestId('total-balance')).toHaveTextContent('£167,097.66');
    expect(screen.getByText('Across 3 currencies at live rates')).toBeOnTheScreen();
    expect(screen.getByText('101,964.00')).toBeOnTheScreen();
    expect(screen.getByText('57,891.00')).toBeOnTheScreen();
    expect(screen.getByText('24,310.50')).toBeOnTheScreen();
    expect(await screen.findByText('1 payment needs your approval')).toBeOnTheScreen();
    expect(screen.getByText('$18,400.00 to Brightway Electronics Co.')).toBeOnTheScreen();
    expect(await screen.findByText('+£42,733.00')).toBeOnTheScreen();
    expect(screen.getByText('−$24,557.00')).toBeOnTheScreen();
    for (const action of ['Send', 'Convert', 'Receive', 'Rates']) {
      expect(screen.getByRole('button', { name: action })).toBeOnTheScreen();
    }
  });

  it('opens the pending payment from the banner', async () => {
    await renderScreen(<HomeScreen />);
    await fireEvent.press(await screen.findByTestId('approval-banner'));
    expect(router.push).toHaveBeenCalledWith({ pathname: '/payments/[id]', params: { id: expect.any(String) } });
  });

  it('shows errors with retry, then recovers', async () => {
    setControls({ forcedError: 'server' });
    await renderScreen(<HomeScreen />);
    expect((await screen.findAllByText('Something went wrong')).length).toBeGreaterThan(0);
    setControls({ forcedError: 'none' });
    for (const retry of screen.getAllByRole('button', { name: 'Try again' })) {
      await fireEvent.press(retry);
    }
    expect(await screen.findByTestId('total-balance')).toHaveTextContent('£167,097.66');
  });

  it('survives a malformed response without crashing', async () => {
    setControls({ forcedError: 'wrong_shape' });
    await renderScreen(<HomeScreen />);
    expect((await screen.findAllByText('We received a response we could not read. Try again.')).length).toBeGreaterThan(0);
  });

  it('shows offline states when there is no connection and nothing cached, then loads on reconnect', async () => {
    onlineManager.setOnline(false);
    try {
      await renderScreen(<HomeScreen />);
      expect((await screen.findAllByText('You are offline')).length).toBeGreaterThan(0);
      expect(screen.getByText('You are offline. Showing the last information we have.')).toBeOnTheScreen();
      expect(screen.queryByTestId('total-balance')).not.toBeOnTheScreen();
      await act(async () => onlineManager.setOnline(true));
      expect(await screen.findByTestId('total-balance')).toHaveTextContent('£167,097.66');
    } finally {
      onlineManager.setOnline(true);
    }
  });

  it('shows empty states when the account has nothing in it', async () => {
    const { getProviderClient } = jest.requireActual<typeof import('@/api')>('@/api');
    const client = getProviderClient();
    jest.spyOn(client, 'listBalances').mockResolvedValue([]);
    jest.spyOn(client, 'listTransactions').mockResolvedValue({ items: [], page: 1, totalPages: 1, totalItems: 0, nextPage: null });
    jest.spyOn(client, 'listPendingApprovals').mockResolvedValue([]);
    await renderScreen(<HomeScreen />);
    expect(await screen.findByText('No currency accounts yet')).toBeOnTheScreen();
    expect(await screen.findByText('No activity yet')).toBeOnTheScreen();
    expect(screen.getByTestId('total-balance')).toHaveTextContent('£0.00');
    expect(screen.queryByTestId('approval-banner')).not.toBeOnTheScreen();
  });
});
