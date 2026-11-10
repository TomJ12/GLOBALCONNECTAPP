import { getProviderClient } from '@/api';
import { ProviderError } from '@/api/errors';
import { queryClient } from '@/lib/queryClient';
import { useSession } from '@/state/session';
import { installMockBackend } from '@/test/utils';

async function signInThroughStore(): Promise<void> {
  const client = getProviderClient();
  const link = await client.requestMagicLink('finance@example.com');
  useSession.getState().startSession(await client.verifyMagicLink(link.requestId, link.devCode ?? ''));
}

describe('session', () => {
  beforeEach(async () => {
    installMockBackend();
    useSession.setState({ session: null, remembered: null, signedOutReason: null, hydrated: true });
    await useSession.getState().forgetDevice();
    queryClient.clear();
  });
  afterEach(() => queryClient.clear());

  it('sign-out clears cached data and ends the provider session', async () => {
    await signInThroughStore();
    queryClient.setQueryData(['balances'], [{ currency: 'GBP', amount: '101964.00' }]);
    expect(queryClient.getQueryCache().getAll()).toHaveLength(1);

    await useSession.getState().signOut();
    expect(useSession.getState().session).toBeNull();
    expect(queryClient.getQueryCache().getAll()).toHaveLength(0);
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

  it('remembers the device only when quick unlock is turned on, and can unlock and forget', async () => {
    await signInThroughStore();
    const session = useSession.getState().session;
    expect(useSession.getState().remembered).toBeNull();
    await useSession.getState().enableBiometricUnlock(session!);
    await useSession.getState().signOut();

    useSession.setState({ remembered: null });
    await useSession.getState().hydrate();
    expect(useSession.getState().remembered).toEqual({ email: 'finance@example.com', displayName: 'Sample User', biometricEnabled: true });

    await useSession.getState().unlockWithDevice();
    expect(useSession.getState().session?.user.email).toBe('finance@example.com');
    await expect(getProviderClient().listBalances()).resolves.toHaveLength(3);

    await useSession.getState().signOut();
    await useSession.getState().forgetDevice();
    await expect(useSession.getState().unlockWithDevice()).rejects.toThrow();
  });
});
