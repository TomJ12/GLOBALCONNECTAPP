import AsyncStorage from '@react-native-async-storage/async-storage';

import { alertsStorageKey, getAlertsStore } from '@/alerts';
import { getAuthClient, getProviderClient } from '@/api';
import { ProviderError } from '@/api/errors';
import { createInactivityHandler } from '@/lib/inactivity';
import { queryClient } from '@/lib/queryClient';
import { useSession } from '@/state/session';
import { installMockBackend, startTestSession } from '@/test/utils';

async function signInThroughStore(email = 'finance@example.com'): Promise<void> {
  await startTestSession(email);
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
    await getAlertsStore('finance@example.com').create({ base: 'EUR', quote: 'USD', direction: 'above', targetRate: '1.2' });
    const session = useSession.getState().session;
    // The session holds who the user is and what they may do, and no credential of any kind.
    expect(Object.keys(session ?? {}).sort()).toEqual(['capabilities', 'company', 'role', 'stepUpActions', 'user']);
    expect(JSON.stringify(session)).not.toMatch(/token|password|secret/i);
    await useSession.getState().signOut();

    const keys = await AsyncStorage.getAllKeys();
    const stored = await Promise.all(keys.map((key) => AsyncStorage.getItem(key)));
    const everything = JSON.stringify([keys, stored]).toLowerCase();
    expect(everything).not.toMatch(/token|credential|device|secret|finance@example\.com/);
    // With no money movement in doubt, sign-out leaves the device storage empty.
    expect(keys).toEqual([]);
    // The only way back in is the password and a new code: nothing resumes or unlocks a session.
    const methods = Object.keys(getAuthClient()).concat(Object.getOwnPropertyNames(Object.getPrototypeOf(getProviderClient())));
    expect(methods).toContain('completeSignIn');
    expect(methods.filter((name) => /resume|unlock|device|magic/i.test(name))).toEqual([]);
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

  it("keeps each person's rate alerts separate, and deletes them from the device on sign-out", async () => {
    expect(alertsStorageKey('a@example.com')).not.toBe(alertsStorageKey('b@example.com'));
    expect(alertsStorageKey(' A@Example.com ')).toBe(alertsStorageKey('a@example.com'));
    expect(alertsStorageKey('a@example.com')).not.toContain('example');

    await signInThroughStore('a@example.com');
    const created = await getAlertsStore('a@example.com').create({ base: 'EUR', quote: 'USD', direction: 'above', targetRate: '1.2' });
    expect(await AsyncStorage.getItem(alertsStorageKey('a@example.com'))).toContain(created.id);

    // B signs in on the same device while A's alerts are still stored: B sees none of them.
    useSession.setState({ session: null });
    await signInThroughStore('b@example.com');
    expect((await getAlertsStore('b@example.com').list()).map((alert) => alert.id)).not.toContain(created.id);
    await getAlertsStore('b@example.com').create({ base: 'GBP', quote: 'USD', direction: 'below', targetRate: '1.1' });

    // B signs out: B's alerts are deleted from the device, A's are untouched.
    await useSession.getState().signOut();
    expect(await AsyncStorage.getItem(alertsStorageKey('b@example.com'))).toBeNull();
    expect(await AsyncStorage.getItem(alertsStorageKey('a@example.com'))).toContain(created.id);

    // A signs in and out: now nothing of anyone's is left.
    await signInThroughStore('a@example.com');
    await useSession.getState().signOut();
    expect(await AsyncStorage.getAllKeys()).toEqual([]);
  });
});
