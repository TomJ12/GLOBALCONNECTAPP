import { Inter_400Regular, Inter_500Medium, Inter_600SemiBold, Inter_700Bold, useFonts } from '@expo-google-fonts/inter';
import { QueryClientProvider } from '@tanstack/react-query';
import { Stack } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { StyleSheet, View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { ConfirmDialogHost, ToastHost } from '@/components/Overlays';
import { startOnlineTracking } from '@/lib/online';
import { queryClient } from '@/lib/queryClient';
import { useSession } from '@/state/session';
import { colors } from '@/theme';

void SplashScreen.preventAutoHideAsync().catch(() => undefined);

export default function RootLayout() {
  // If the fonts fail to load the app still opens, in the system font.
  const [fontsLoaded, fontError] = useFonts({ Inter_400Regular, Inter_500Medium, Inter_600SemiBold, Inter_700Bold });
  const hydrated = useSession((state) => state.hydrated);
  const hydrate = useSession((state) => state.hydrate);
  const signedIn = useSession((state) => state.session !== null);

  useEffect(() => {
    void hydrate();
    return startOnlineTracking();
  }, [hydrate]);

  const ready = (fontsLoaded || fontError !== null) && hydrated;
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
