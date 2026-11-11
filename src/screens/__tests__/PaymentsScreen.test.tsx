import { fireEvent, screen } from '@testing-library/react-native';

import { getProviderClient } from '@/api';
import type { Page, Payment, Transaction } from '@/api/types';
import { uniqueById } from '@/hooks/queries';
import { ActivityScreen } from '@/screens/ActivityScreen';
import { PaymentsScreen } from '@/screens/PaymentsScreen';
import { installMockBackend, renderScreen, signIn } from '@/test/utils';

function payment(id: string, status: Payment['status']): Payment {
  return {
    id,
    shortReference: id,
    amount: '10.00',
    currency: 'GBP',
    beneficiaryId: 'b',
    beneficiaryName: `Payee ${id}`,
    reference: `REF-${id}`,
    status,
    route: 'local',
    fee: null,
    estimatedArrival: null,
    createdAt: new Date().toISOString(),
  };
}

describe('lists that span pages', () => {
  beforeEach(async () => {
    const mock = installMockBackend();
    await signIn(mock.client);
  });

  it('L3: uniqueById keeps the first of each id, in order', () => {
    expect(uniqueById([{ id: 'a' }, { id: 'b' }, { id: 'a' }, { id: 'c' }, { id: 'b' }]).map((item) => item.id)).toEqual(['a', 'b', 'c']);
  });

  it('L3: activity does not show a row twice when the list shifts between pages', async () => {
    const client = getProviderClient();
    const real = client.listTransactions.bind(client);
    jest.spyOn(client, 'listTransactions').mockImplementation(async (request) => {
      const page = await real(request);
      if (request.page !== 2) return page;
      // A new transaction arrived, so page 2 starts with the last row of page 1.
      const previous = await real({ ...request, page: 1 });
      const repeated = previous.items.at(-1) as Transaction;
      return { ...page, items: [repeated, ...page.items.slice(0, -1)] };
    });
    await renderScreen(<ActivityScreen />);
    await screen.findByText(/Showing 10 of/);
    await fireEvent.press(screen.getByRole('button', { name: 'Show more' }));
    // 19 distinct rows, not 20 with a duplicate (which would also be a duplicate React key).
    expect(await screen.findByText(/Showing 19 of/)).toBeOnTheScreen();
  });

  it('L4: does not say "No payments yet" when more pages exist, and loads them', async () => {
    const client = getProviderClient();
    const pages: Record<number, Page<Payment>> = {
      1: { items: [payment('p1', 'awaiting_approval')], page: 1, totalPages: 2, totalItems: 2, nextPage: 2 },
      2: { items: [payment('p2', 'sent')], page: 2, totalPages: 2, totalItems: 2, nextPage: null },
    };
    jest.spyOn(client, 'listPayments').mockImplementation(async (request) => pages[request.page] as Page<Payment>);
    await renderScreen(<PaymentsScreen />);
    await fireEvent.press(await screen.findByTestId('payments-more'));
    expect(await screen.findByText('Payee p2')).toBeOnTheScreen();
    expect(screen.queryByText('No payments yet')).not.toBeOnTheScreen();
    expect(screen.queryByTestId('payments-more')).not.toBeOnTheScreen();
  });

  it('L4: says "No payments yet" only when every page has been read and there are none', async () => {
    jest.spyOn(getProviderClient(), 'listPayments').mockResolvedValue({ items: [], page: 1, totalPages: 1, totalItems: 0, nextPage: null });
    await renderScreen(<PaymentsScreen />);
    expect(await screen.findByText('No payments yet')).toBeOnTheScreen();
  });

  it('shows an unrecognised status as unknown, not as processing', async () => {
    jest
      .spyOn(getProviderClient(), 'listPayments')
      .mockResolvedValue({ items: [payment('p9', 'unknown')], page: 1, totalPages: 1, totalItems: 1, nextPage: null });
    await renderScreen(<PaymentsScreen />);
    expect(await screen.findByText('Status unknown')).toBeOnTheScreen();
    expect(screen.queryByText('Processing')).not.toBeOnTheScreen();
  });
});
