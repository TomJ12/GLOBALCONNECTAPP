/**
 * The sign-in attempt this device started: the request id and a random secret
 * made up here. The secret goes to the backend with the request and again at
 * verification, so an emailed link or code only works on the device that asked
 * for it. It is short-lived, useless without the emailed code, and removed as
 * soon as sign-in succeeds or a new attempt starts.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Crypto from 'expo-crypto';
import { z } from 'zod';

const KEY = 'globalconnect.signInAttempt.v1';
const schema = z.object({ requestId: z.string().min(1), secret: z.string().min(32) });
export type SignInAttempt = z.infer<typeof schema>;

/** 32 random bytes from the platform's secure random source, as hex. */
export function newDeviceSecret(): string {
  return [...Crypto.getRandomBytes(32)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function saveSignInAttempt(attempt: SignInAttempt): Promise<void> {
  await AsyncStorage.setItem(KEY, JSON.stringify(attempt));
}

export async function loadSignInAttempt(): Promise<SignInAttempt | null> {
  try {
    const text = await AsyncStorage.getItem(KEY);
    const parsed = text ? schema.safeParse(JSON.parse(text)) : null;
    return parsed?.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export async function clearSignInAttempt(): Promise<void> {
  try {
    await AsyncStorage.removeItem(KEY);
  } catch {
    // Nothing useful to do.
  }
}
