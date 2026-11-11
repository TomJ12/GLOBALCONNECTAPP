// Shared Jest setup: native modules that have no implementation under Node are replaced here.

jest.mock('@react-native-async-storage/async-storage', () =>
  jest.requireActual('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

jest.mock('expo-clipboard', () => ({ setStringAsync: jest.fn(async () => true) }));

jest.mock('expo-network', () => ({
  addNetworkStateListener: jest.fn(() => ({ remove: jest.fn() })),
  getNetworkStateAsync: jest.fn(async () => ({ isConnected: true, isInternetReachable: true })),
}));

jest.mock('expo-router', () => {
  const router = {
    push: jest.fn(),
    replace: jest.fn(),
    back: jest.fn(),
    canGoBack: jest.fn(() => true),
  };
  let params: Record<string, string> = {};
  let focused = true;
  return {
    __esModule: true,
    router,
    useRouter: () => router,
    useLocalSearchParams: () => params,
    __setParams: (next: Record<string, string>) => {
      params = next;
    },
    useIsFocused: () => focused,
    __setFocused: (next: boolean) => {
      focused = next;
    },
    Redirect: () => null,
  };
});
