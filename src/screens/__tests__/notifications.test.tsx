/** Notifications, the reject reason, and rate alerts kept by the server. */
import { fireEvent, screen, waitFor } from '@testing-library/react-native';

import type { AlertsStore, RateAlert } from '@/alerts';
import { getAlertsStore } from '@/alerts';
import { getAuthClient, getProviderClient } from '@/api';
import { GlobalConnectApi } from '@/api/adapters/globalConnectApi';
import type { NotificationsClient } from '@/api/auth';
import * as schemas from '@/api/schemas';
import type { AppNotification, Payment, PendingApproval } from '@/api/types';
import { HomeScreen } from '@/screens/HomeScreen';
import { NewAlertScreen } from '@/screens/NewAlertScreen';
import { NotificationsScreen } from '@/screens/NotificationsScreen';
import { PaymentReviewScreen } from '@/screens/PaymentReviewScreen';
import { RatesScreen } from '@/screens/RatesScreen';
import { rejectionLine } from '@/screens/shared';
import { installMockBackend, renderScreen, signIn, startTestSession } from '@/test/utils';

const expoRouter = jest.requireMock<{ __setParams: (params: Record<string, string>) => void; router: { push: jest.Mock; replace: jest.Mock } }>('expo-router');

const HOSTILE = 'Wrong <b>invoice</b> & "see" evil.example';
const ITEMS: AppNotification[] = [
  { id: 'ntf_3', category: 'payments', title: 'Your payment was rejected', body: `Your payment of GBP 125.00 to Harbour Freight Ltd was rejected by Abel. It was not sent.\nReason given: “${HOSTILE}”`, createdAt: '2026-11-11T10:20:00.000Z', read: false },
  { id: 'ntf_2', category: 'approvals', title: 'A payment is waiting for your approval', body: 'Cara created a payment of GBP 90.00 to Atelier Dubois SARL. It has not been sent.', createdAt: '2026-11-11T10:10:00.000Z', read: false },
  { id: 'ntf_1', category: 'rates', title: 'Rate alert: GBP/USD', body: 'Your rate to sell GBP for USD reached 1.297400 when we checked. This rate is indicative.', createdAt: '2026-11-11T10:00:00.000Z', read: true },
];

/** What the Global Connect server offers; the in-app demo has none. */
function notifications(): jest.Mocked<NotificationsClient> {
  let items = ITEMS.map((item) => ({ ...item }));
  let choices = { rates: true, approvals: true, payments: true };
  const service: jest.Mocked<NotificationsClient> = {
    list: jest.fn(async () => ({ items: items.map((item) => ({ ...item })), unread: items.filter((item) => !item.read).length })),
    markRead: jest.fn(async (id?: string) => {
      items = items.map((item) => (id === undefined || item.id === id ? { ...item, read: true } : item));
      return items.filter((item) => !item.read).length;
    }),
    emailChoices: jest.fn(async () => choices),
    setEmailChoices: jest.fn(async (next) => {
      choices = next;
      return choices;
    }),
  };
  (getAuthClient() as { notifications: NotificationsClient | null }).notifications = service;
  return service;
}

beforeEach(() => {
  expoRouter.router.push.mockClear();
  expoRouter.__setParams({});
});

describe('notifications', () => {
  it('the bell is on Home only when there is a server, shows the unread count and opens the list', async () => {
    const mock = installMockBackend();
    await signIn(mock.client);
    await renderScreen(<HomeScreen />);
    await screen.findByTestId('total-balance');
    expect(screen.queryByTestId('notification-bell')).not.toBeOnTheScreen();

    notifications();
    await renderScreen(<HomeScreen />);
    expect(await screen.findByTestId('notification-badge')).toHaveTextContent('2');
    expect(screen.getByRole('button', { name: 'Notifications, 2 unread' })).toBeOnTheScreen();
    await fireEvent.press(screen.getByTestId('notification-bell'));
    expect(expoRouter.router.push).toHaveBeenCalledWith('/notifications');
  });

  it('lists notifications as plain text, marks one or all as read, and lets email be turned off per kind but never for security', async () => {
    installMockBackend();
    await startTestSession();
    const service = notifications();
    await renderScreen(<NotificationsScreen />);

    expect(await screen.findByText('Your payment was rejected')).toBeOnTheScreen();
    // What a colleague typed is shown exactly as typed, as text.
    expect(screen.getByText(new RegExp(`Reason given: “${HOSTILE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}”`))).toBeOnTheScreen();
    // ...with link detection off: nothing in a notification is ever made into a link by the app.
    expect(screen.getByTestId('notification-body-ntf_3').props.dataDetectorType).toBe('none');
    expect(screen.queryByRole('link')).not.toBeOnTheScreen();
    expect(screen.getByTestId('unread-ntf_3')).toBeOnTheScreen();
    expect(screen.getByTestId('unread-ntf_2')).toBeOnTheScreen();
    expect(screen.queryByTestId('unread-ntf_1')).not.toBeOnTheScreen();

    await fireEvent.press(screen.getByTestId('notification-ntf_3'));
    await waitFor(() => expect(screen.queryByTestId('unread-ntf_3')).not.toBeOnTheScreen());
    expect(service.markRead).toHaveBeenLastCalledWith('ntf_3');
    expect(screen.getByTestId('mark-all-read')).toHaveTextContent('Mark all as read (1)');
    await fireEvent.press(screen.getByTestId('mark-all-read'));
    await waitFor(() => expect(screen.queryByTestId('mark-all-read')).not.toBeOnTheScreen());
    expect(service.markRead).toHaveBeenLastCalledWith(undefined);

    // Email, per kind. Security is not a switch.
    await fireEvent(await screen.findByTestId('email-choice-payments'), 'valueChange', false);
    await waitFor(() => expect(service.setEmailChoices).toHaveBeenCalledWith({ rates: true, approvals: true, payments: false }));
    expect(screen.getByTestId('email-choice-security')).toHaveTextContent('Always on');
    expect(screen.getByText(/Security notices are always emailed and cannot be turned off/)).toBeOnTheScreen();
    expect(screen.queryByTestId('email-choice-security-switch')).not.toBeOnTheScreen();
  });

  it('without a server the screen says so instead of an empty list', async () => {
    installMockBackend();
    await startTestSession();
    await renderScreen(<NotificationsScreen />);
    expect(screen.getByText('No notifications in this demo')).toBeOnTheScreen();
  });
});

describe('rejecting with a reason', () => {
  const held: Payment = {
    id: 'hp_1', shortReference: 'GC-1', amount: '125.00', currency: 'GBP', beneficiaryId: 'payee-1', beneficiaryName: 'Harbour Freight Ltd', reference: 'INV-7', status: 'awaiting_approval', route: null, fee: null, estimatedArrival: null, createdAt: '2027-01-14T09:30:00.000Z',
    held: { state: 'awaiting_approval', createdBy: 'Cara Jones', createdByYou: false, approvalsRequired: 1, approvals: [], expiresAt: '2027-01-16T09:30:00.000Z', canApprove: true, canCancel: false, approvers: ['Abel Musa'] },
  };
  const approval: PendingApproval = {
    payment: held,
    beneficiary: { id: 'payee-1', name: 'Harbour Freight Ltd', entityType: 'company', currency: 'GBP', bankCountry: 'GB', accountNumber: '12345678', sortCode: '000000', iban: null, bic: null, routingNumber: null, createdAt: '2026-01-01T00:00:00.000Z' } as PendingApproval['beneficiary'],
    approvalsRemaining: 1,
    steps: [],
  };

  it('the approver can give a reason, bounded and on one line; it is sent with the rejection', async () => {
    const mock = installMockBackend();
    await signIn(mock.client);
    const client = getProviderClient();
    jest.spyOn(client, 'listPendingApprovals').mockImplementation(async () => [approval]);
    const reject = jest.spyOn(client, 'rejectPayment').mockImplementation(async () => undefined);
    expoRouter.__setParams({ id: 'hp_1' });
    await renderScreen(<PaymentReviewScreen />);

    const field = await screen.findByTestId('reject-reason');
    expect(field.props.maxLength).toBe(200);
    expect(screen.getByText('Reason for rejecting (optional)')).toBeOnTheScreen();
    await fireEvent.changeText(field, '  Wrong invoice\nnumber\u0007  ');
    expect(screen.getByTestId('reject-reason').props.value).toBe('  Wrong invoice number   ');
    await fireEvent.press(screen.getByTestId('reject-button'));
    expect(await screen.findByText('Reject this payment?')).toBeOnTheScreen();
    await fireEvent.press(screen.getByTestId('confirm-dialog-confirm'));
    await waitFor(() => expect(reject).toHaveBeenCalledWith('hp_1', 'Wrong invoice number'));
  });

  it('the creator is shown who rejected a payment and why, as text', () => {
    expect(rejectionLine({ held: { ...(held.held as NonNullable<Payment['held']>), state: 'rejected', rejection: { by: 'Abel Musa', reason: HOSTILE } } })).toBe(`Rejected by Abel Musa: “${HOSTILE}”`);
    expect(rejectionLine({ held: { ...(held.held as NonNullable<Payment['held']>), state: 'rejected', rejection: { by: 'Abel Musa', reason: null } } })).toBe('Rejected by Abel Musa. No reason given.');
    expect(rejectionLine({ held: held.held })).toBeNull();
    expect(schemas.payment.parse({ ...held, held: { ...held.held, state: 'rejected', rejection: { by: 'Abel', reason: HOSTILE } } }).held?.rejection?.reason).toBe(HOSTILE);
    expect(() => schemas.payment.parse({ ...held, held: { ...held.held, rejection: { by: 'Abel', reason: 'x'.repeat(201) } } })).toThrow();
  });

  it('the server adapter sends the reason in the body, and nothing when there is none', async () => {
    const calls: { url: string; body: unknown }[] = [];
    const fakeFetch = (async (url: string, init: { method: string; body?: string }) => {
      calls.push({ url, body: init.body ? JSON.parse(init.body) : undefined });
      return { status: 200, text: async () => JSON.stringify({ ok: true }) };
    }) as unknown as typeof fetch;
    const api = new GlobalConnectApi({ baseUrl: 'https://api.test/', fetch: fakeFetch });
    await api.rejectPayment('hp_1', '  Wrong invoice  ');
    await api.rejectPayment('hp_2');
    await api.rejectPayment('hp_3', '   ');
    expect(calls.map((call) => [call.url.replace('https://api.test/v1', ''), call.body])).toEqual([
      ['/payments/hp_1/reject', { reason: 'Wrong invoice' }],
      ['/payments/hp_2/reject', undefined],
      ['/payments/hp_3/reject', undefined],
    ]);
  });
});

describe('rate alerts kept by the server', () => {
  const SERVER_ALERTS = [
    { id: 'alr_1', base: 'GBP', quote: 'USD', side: 'sell', targetRate: '1.32', status: 'active', createdAt: '2026-11-11T10:00:00.000Z', triggeredAt: null, triggeredRate: null },
    { id: 'alr_2', base: 'GBP', quote: 'EUR', side: 'buy', targetRate: '1.17', status: 'triggered', createdAt: '2026-11-11T10:00:00.000Z', triggeredAt: '2026-11-12T08:00:00.000Z', triggeredRate: '1.1699' },
  ];
  function apiWith(routes: Record<string, unknown>) {
    const calls: { route: string; body: unknown }[] = [];
    const fakeFetch = (async (url: string, init: { method: string; body?: string }) => {
      const route = `${init.method} ${url.replace('https://api.test/v1', '')}`;
      calls.push({ route, body: init.body ? JSON.parse(init.body) : undefined });
      return route in routes ? { status: 200, text: async () => JSON.stringify(routes[route]) } : { status: 404, text: async () => JSON.stringify({ error: { kind: 'not_found' } }) };
    }) as unknown as typeof fetch;
    return { api: new GlobalConnectApi({ baseUrl: 'https://api.test/', fetch: fakeFetch }), calls };
  }

  it('the server adapter maps sell/buy to the app’s alert, creates, re-arms and deletes through the API', async () => {
    const { api, calls } = apiWith({ 'GET /alerts': { items: SERVER_ALERTS }, 'POST /alerts': SERVER_ALERTS[0], 'POST /alerts/alr_2': { ...SERVER_ALERTS[1], status: 'active', triggeredAt: null, triggeredRate: null }, 'POST /alerts/alr_1/delete': { ok: true } });
    const store: AlertsStore = api.alerts;
    expect(await store.list()).toEqual([
      { id: 'alr_1', base: 'GBP', quote: 'USD', direction: 'above', targetRate: '1.32', enabled: true, createdAt: '2026-11-11T10:00:00.000Z', triggered: null },
      { id: 'alr_2', base: 'GBP', quote: 'EUR', direction: 'below', targetRate: '1.17', enabled: false, createdAt: '2026-11-11T10:00:00.000Z', triggered: { at: '2026-11-12T08:00:00.000Z', rate: '1.1699' } },
    ]);
    await store.create({ base: 'GBP', quote: 'USD', direction: 'above', targetRate: '1.32' });
    await store.create({ base: 'GBP', quote: 'USD', direction: 'below', targetRate: '1.29' }).catch(() => undefined);
    expect((await store.setEnabled('alr_2', true)).enabled).toBe(true);
    await store.remove('alr_1');
    expect(calls.slice(1)).toEqual([
      { route: 'POST /alerts', body: { base: 'GBP', quote: 'USD', side: 'sell', targetRate: '1.32' } },
      { route: 'POST /alerts', body: { base: 'GBP', quote: 'USD', side: 'buy', targetRate: '1.29' } },
      { route: 'POST /alerts/alr_2', body: { enabled: true } },
      { route: 'POST /alerts/alr_1/delete', body: {} },
    ]);
    // And the notification calls.
    const second = apiWith({ 'GET /notifications': { items: ITEMS, unread: 2 }, 'POST /notifications/read': { ok: true, unread: 1 }, 'GET /notifications/preferences': { email: { rates: true, approvals: false, payments: true }, alwaysOn: ['security'] }, 'POST /notifications/preferences': { email: { rates: false, approvals: false, payments: true }, alwaysOn: ['security'] } });
    expect((await second.api.notifications.list()).unread).toBe(2);
    expect(await second.api.notifications.markRead('ntf_3')).toBe(1);
    await second.api.notifications.markRead();
    expect(await second.api.notifications.emailChoices()).toEqual({ rates: true, approvals: false, payments: true });
    expect(await second.api.notifications.setEmailChoices({ rates: false, approvals: false, payments: true })).toEqual({ rates: false, approvals: false, payments: true });
    expect(second.calls.map((call) => [call.route, call.body])).toEqual([
      ['GET /notifications', undefined],
      ['POST /notifications/read', { id: 'ntf_3' }],
      ['POST /notifications/read', {}],
      ['GET /notifications/preferences', undefined],
      ['POST /notifications/preferences', { email: { rates: false, approvals: false, payments: true } }],
    ]);
  });

  it('the app uses the server’s alerts when there is a server, and the device’s own otherwise', async () => {
    installMockBackend();
    const local = getAlertsStore('someone@example.com');
    const remote: AlertsStore = { list: jest.fn(async () => []), create: jest.fn(), setEnabled: jest.fn(), remove: jest.fn() };
    (getAuthClient() as { alerts: AlertsStore | null }).alerts = remote;
    expect(getAlertsStore('someone@example.com')).toBe(remote);
    expect(local).not.toBe(remote);
  });

  it('an alert is on your own rate for one direction, "or better"; a fired alert says so', async () => {
    const mock = installMockBackend();
    await startTestSession();
    const original = mock.client.getRate.bind(mock.client);
    jest.spyOn(mock.client, 'getRate').mockImplementation(async (base: string, quote: string) => ({ ...(await original(base, quote)), rate: '1.2934', buyRate: '1.3065', indicative: true }));
    const created: unknown[] = [];
    const alerts: RateAlert[] = [
      { id: 'alr_1', base: 'GBP', quote: 'USD', direction: 'above', targetRate: '1.32', enabled: true, createdAt: '2026-11-11T10:00:00.000Z', triggered: null },
      { id: 'alr_2', base: 'GBP', quote: 'EUR', direction: 'below', targetRate: '1.17', enabled: false, createdAt: '2026-11-11T10:00:00.000Z', triggered: { at: '2026-11-12T08:00:00.000Z', rate: '1.1699' } },
    ];
    (getAuthClient() as { alerts: AlertsStore | null }).alerts = {
      list: async () => alerts,
      create: async (input) => {
        created.push(input);
        return { ...input, id: 'alr_3', enabled: true, createdAt: '2026-11-11T10:00:00.000Z' };
      },
      setEnabled: jest.fn(),
      remove: jest.fn(),
    };
    await renderScreen(<RatesScreen />);
    expect(await screen.findByText('GBP / USD sell GBP at 1.3200 or better')).toBeOnTheScreen();
    expect(screen.getByText('GBP / EUR buy GBP at 1.1700 or better')).toBeOnTheScreen();
    expect(screen.getByText(/^Reached 1\.1699 on .+\. Turn on to be told again\.$/)).toBeOnTheScreen();

    await renderScreen(<NewAlertScreen />);
    // Selling GBP: the sell rate. Buying GBP: the buy rate. Both labelled as the customer's own, indicative.
    expect(await screen.findByText('Your rate to sell 1 GBP, in USD. Indicative.')).toBeOnTheScreen();
    await waitFor(() => expect(screen.getByTestId('alert-current-rate')).toHaveTextContent('1.2934'));
    expect(screen.getByTestId('alert-meaning')).toHaveTextContent('You will be told when your rate to sell GBP for USD is at the target or higher.');
    await fireEvent.press(screen.getByRole('radio', { name: 'Buy GBP at the target rate or better' }));
    expect(screen.getByText('Your rate to buy 1 GBP, in USD. Indicative.')).toBeOnTheScreen();
    expect(screen.getByTestId('alert-current-rate')).toHaveTextContent('1.3065');
    expect(screen.getByTestId('alert-meaning')).toHaveTextContent('You will be told when your rate to buy GBP with USD is at the target or lower.');
    await fireEvent.changeText(screen.getByTestId('alert-target'), '1.3000');
    await fireEvent.press(screen.getByTestId('save-alert'));
    await waitFor(() => expect(created).toEqual([{ base: 'GBP', quote: 'USD', direction: 'below', targetRate: '1.3' }]));
  });
});
