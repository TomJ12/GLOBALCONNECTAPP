import AsyncStorage from '@react-native-async-storage/async-storage';

import { alertsStorageKey, getAlertsStore } from '@/alerts';
import { getProviderClient } from '@/api';
import { ProviderError } from '@/api/errors';
import { createInactivityHandler } from '@/lib/inactivity';
import { queryClient } from '@/lib/queryClient';
import { useSession } from '@/state/session';
import { installMockBackend } from '@/test/utils';

async function signInThroughStore(email = 'finance@example.com'): Promise<void> {
  const client = getProviderClient();
  const link = await client.requestMagicLink(email);
  useSession.getState().startSession(await client.verifyMagicLink(link.requestId, link.devCode ?? ''));
}

describe('session', () => {
  beforeEach(async () => {
    installMockBackend();
    useSession.setState({ session: null, signedOutReason: null });
    await AsyncStorage.clear();
    queryClient.clear();
  });
  afterEach(() => queryClient.clear());

  it('sign-out clears cached data and ends the provider session', async () => {
    await signInThroughStore();
    queryClient.setQueryData(['balances'], [{ currency: 'GBP', amount: '101964.00' }]);
    await useSession.getState().signOut();
    expect(useSession.getState().session).toBeNull();
    expect(queryClient.getQueryCache().getAll()).toHaveLength(0);
    await expect(getProviderClient().listBalances()).rejects.toMatchObject({ kind: 'unauthorized' });
  });

  it('leaves nothing on the device that could sign back in', async () => {
    await signInThroughStore();
    await getProviderClient().listBalances();
    const session = useSession.getState().session;
    // The session holds who the user is and no credential of any kind.
    expect(Object.keys(session ?? {})).toEqual(['user']);
    await useSession.getState().signOut();

    const keys = await AsyncStorage.getAllKeys();
    const stored = await Promise.all(keys.map((key) => AsyncStorage.getItem(key)));
    const everything = JSON.stringify([keys, stored]).toLowerCase();
    expect(everything).not.toMatch(/token|credential|device|finance@example\.com/);
    // The only way back in is a new emailed link.
    const client = getProviderClient() as unknown as Record<string, unknown>;
    const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(client));
    expect(methods).toContain('verifyMagicLink');
    expect(methods.filter((name) => /resume|unlock|device/i.test(name))).toEqual([]);
    await expect(getProviderClient().listBalances()).rejects.toMatchObject({ kind: 'unauthorized' });
  });

  it('starting a session drops anything cached for a previous one', async () => {
    queryClient.setQueryData(['balances'], ['stale']);
    await signInThroughStore();
    expect(queryClient.getQueryData(['balances'])).toBeUndefined();
  });

  it('an unauthorized response anywhere signs the person out', async () => {
    await signInThroughStore();
    await queryClient
      .fetchQuery({ queryKey: ['x'], queryFn: () => Promise.reject(new ProviderError('unauthorized')), retry: false })
      .catch(() => undefined);
    expect(useSession.getState().session).toBeNull();
    expect(useSession.getState().signedOutReason).toBe('expired');
  });

  it('a forbidden response does not sign the person out', async () => {
    await signInThroughStore();
    await queryClient
      .fetchQuery({ queryKey: ['y'], queryFn: () => Promise.reject(new ProviderError('forbidden')), retry: false })
      .catch(() => undefined);
    expect(useSession.getState().session).not.toBeNull();
  });

  it('signs out after time in the background, and not after a short absence', async () => {
    await signInThroughStore();
    let now = 1_000_000;
    const handler = createInactivityHandler({ now: () => now, limitMs: 120_000, onLock: () => void useSession.getState().signOut('inactive') });

    handler('background');
    now += 30_000;
    handler('active');
    expect(useSession.getState().session).not.toBeNull();

    handler('inactive');
    handler('background'); // the clock starts at the first step away, not the last
    now += 120_000;
    handler('active');
    expect(useSession.getState().session).toBeNull();
    expect(useSession.getState().signedOutReason).toBe('inactive');
  });

  it('keeps each person\'s rate alerts separate on a shared device', async () => {
    expect(alertsStorageKey('a@example.com')).not.toBe(alertsStorageKey('b@example.com'));
    expect(alertsStorageKey(' A@Example.com ')).toBe(alertsStorageKey('a@example.com'));
    expect(alertsStorageKey('a@example.com')).not.toContain('example');

    await signInThroughStore('a@example.com');
    const mine = getAlertsStore('a@example.com');
    const created = await mine.create({ base: 'EUR', quote: 'USD', direction: 'above', targetRate: '1.2' });
    await useSession.getState().signOut();

    // Sign-out drops the in-memory copy: the next user gets a different store object and none of A's alerts.
    expect(getAlertsStore('a@example.com')).not.toBe(mine);
    await signInThroughStore('b@example.com');
    const theirs = await getAlertsStore('b@example.com').list();
    expect(theirs.map((alert) => alert.id)).not.toContain(created.id);
    expect((await getAlertsStore('a@example.com').list()).map((alert) => alert.id)).toContain(created.id);
  });
});
