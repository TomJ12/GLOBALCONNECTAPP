import { render } from '@testing-library/react-native';
import { AppState, type AppStateStatus } from 'react-native';

import { getProviderClient } from '@/api';
import RootLayout from '@/app/_layout';
import { INACTIVITY_LOCK_MS } from '@/lib/inactivity';
import { useSession } from '@/state/session';
import { installMockBackend, TEST_DEVICE_SECRET } from '@/test/utils';

jest.mock('@expo-google-fonts/inter', () => ({ useFonts: () => [true, null] }));
jest.mock('expo-splash-screen', () => ({ preventAutoHideAsync: async () => undefined, hideAsync: async () => undefined }));
jest.mock('expo-status-bar', () => ({ StatusBar: () => null }));
jest.mock('react-native-safe-area-context', () => ({ SafeAreaProvider: ({ children }: { children: unknown }) => children }));
jest.mock('expo-router', () => {
  function Stack() {
    return null;
  }
  Stack.Screen = function StackScreen() {
    return null;
  };
  return { Stack };
});

/** The real root layout must wire the inactivity sign-out to app-state changes. */
describe('RootLayout', () => {
  it('signs the user out when the app returns after too long in the background', async () => {
    let listener: ((state: AppStateStatus) => void) | undefined;
    jest.spyOn(AppState, 'addEventListener').mockImplementation((_type, handler) => {
      listener = handler as (state: AppStateStatus) => void;
      return { remove: () => undefined } as ReturnType<typeof AppState.addEventListener>;
    });
    installMockBackend();
    const client = getProviderClient();
    const link = await client.requestMagicLink('finance@example.com', TEST_DEVICE_SECRET);
    useSession.getState().startSession(await client.verifyMagicLink(link.requestId, link.devCode ?? '', TEST_DEVICE_SECRET));

    await render(<RootLayout />);
    expect(listener).toBeDefined();

    const now = jest.spyOn(Date, 'now');
    const start = 1_800_000_000_000;
    now.mockReturnValue(start);
    listener?.('background');
    now.mockReturnValue(start + INACTIVITY_LOCK_MS - 1);
    listener?.('active');
    expect(useSession.getState().session).not.toBeNull();

    listener?.('background');
    now.mockReturnValue(start + 2 * INACTIVITY_LOCK_MS);
    listener?.('active');
    now.mockRestore();
    expect(useSession.getState().signedOutReason).toBe('inactive');
    expect(useSession.getState().session).toBeNull();
  });
});
