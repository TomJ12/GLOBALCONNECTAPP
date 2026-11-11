import { Redirect, Stack } from 'expo-router';

import { useSession } from '@/state/session';
import { colors } from '@/theme';

/** Everything under (app) needs a session. Without one, go to sign-in. */
export default function AppLayout() {
  const signedIn = useSession((state) => state.session !== null);
  if (!signedIn) return <Redirect href="/sign-in" />;
  return (
    <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.background } }}>
      <Stack.Screen name="(tabs)" />
      <Stack.Screen name="receive" />
      <Stack.Screen name="activity" />
      <Stack.Screen name="payments/[id]" />
      <Stack.Screen name="payments/new" />
      <Stack.Screen name="payees/new" options={{ presentation: 'modal' }} />
      <Stack.Screen name="alerts/new" options={{ presentation: 'modal' }} />
      {/* Settings and the developer panel sit behind the session, like every other screen here. */}
      <Stack.Screen name="settings" options={{ presentation: 'modal' }} />
    </Stack>
  );
}
