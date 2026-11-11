import { Inter_400Regular, Inter_500Medium, Inter_600SemiBold, Inter_700Bold, useFonts } from '@expo-google-fonts/inter';
import { QueryClientProvider } from '@tanstack/react-query';
import { Stack } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { StyleSheet, View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { ConfirmDialogHost, ToastHost } from '@/components/Overlays';
import { installDevGlobals } from '@/lib/devGlobals';
import { startInactivityLock } from '@/lib/inactivity';
import { startOnlineTracking } from '@/lib/online';
import { queryClient } from '@/lib/queryClient';
import { useSession } from '@/state/session';
import { colors } from '@/theme';

void SplashScreen.preventAutoHideAsync().catch(() => undefined);
installDevGlobals();

export default function RootLayout() {
  // If the fonts fail to load the app still opens, in the system font.
  const [fontsLoaded, fontError] = useFonts({ Inter_400Regular, Inter_500Medium, Inter_600SemiBold, Inter_700Bold });
  const signedIn = useSession((state) => state.session !== null);

  useEffect(() => {
    const stopOnline = startOnlineTracking();
    // After time in the background the session ends. There is no unlock: sign in again by email.
    const stopInactivity = startInactivityLock(() => void useSession.getState().signOut('inactive'));
    return () => {
      stopOnline();
      stopInactivity();
    };
  }, []);

  const ready = fontsLoaded || fontError !== null;
  useEffect(() => {
    if (ready) void SplashScreen.hideAsync().catch(() => undefined);
  }, [ready]);

  if (!ready) return <View style={styles.splash} />;

  return (
    <SafeAreaProvider>
      <QueryClientProvider client={queryClient}>
        <StatusBar style={signedIn ? 'dark' : 'light'} />
        <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.background } }}>
          <Stack.Screen name="(app)" />
          <Stack.Screen name="sign-in" options={{ contentStyle: { backgroundColor: colors.navy }, animation: 'fade' }} />
          <Stack.Screen name="magic-link" options={{ contentStyle: { backgroundColor: colors.navy } }} />
          <Stack.Screen name="settings" options={{ presentation: 'modal' }} />
        </Stack>
        <ConfirmDialogHost />
        <ToastHost />
      </QueryClientProvider>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  splash: { flex: 1, backgroundColor: colors.navy },
});
