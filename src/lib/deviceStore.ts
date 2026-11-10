/**
 * What this device remembers between launches: the last email used and, if the
 * person opted in, a credential that lets a biometric check start a session.
 *
 * Native: the credential lives in the Keychain / Keystore via expo-secure-store.
 * Web: there is no secure store, so it falls back to local storage. That is
 * acceptable only because the mock credential is not a secret. A real web
 * build should use a server-managed session instead.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';
import { z } from 'zod';

const DEVICE_KEY = 'globalconnect.device.v1';
const CREDENTIAL_KEY = 'globalconnect.deviceCredential.v1';

const deviceSchema = z.object({
  email: z.string(),
  displayName: z.string(),
  biometricEnabled: z.boolean(),
});
export type RememberedDevice = z.infer<typeof deviceSchema>;

export async function loadRememberedDevice(): Promise<RememberedDevice | null> {
  try {
    const text = await AsyncStorage.getItem(DEVICE_KEY);
    if (!text) return null;
    const parsed = deviceSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export async function saveRememberedDevice(device: RememberedDevice, credential: string): Promise<void> {
  if (Platform.OS === 'web') {
    await AsyncStorage.setItem(CREDENTIAL_KEY, credential);
  } else {
    await SecureStore.setItemAsync(CREDENTIAL_KEY, credential);
  }
  await AsyncStorage.setItem(DEVICE_KEY, JSON.stringify(device));
}

export async function loadDeviceCredential(): Promise<string | null> {
  try {
    return Platform.OS === 'web'
      ? await AsyncStorage.getItem(CREDENTIAL_KEY)
      : await SecureStore.getItemAsync(CREDENTIAL_KEY);
  } catch {
    return null;
  }
}

export async function forgetRememberedDevice(): Promise<void> {
  await Promise.allSettled([
    AsyncStorage.removeItem(DEVICE_KEY),
    Platform.OS === 'web' ? AsyncStorage.removeItem(CREDENTIAL_KEY) : SecureStore.deleteItemAsync(CREDENTIAL_KEY),
  ]);
}
