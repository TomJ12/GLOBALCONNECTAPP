/**
 * Remembers the idempotency key of a money movement whose outcome is not yet
 * known, so that closing and reopening the app cannot lose track of it. Only
 * the key is stored: no amounts, payees or credentials.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';

export type PendingKind = 'payment' | 'conversion';

function storageKey(kind: PendingKind, userId: string): string {
  return `globalconnect.pendingOutcome.v1.${kind}.${userId}`;
}

export async function loadPendingOutcome(kind: PendingKind, userId: string): Promise<string | null> {
  try {
    const value = await AsyncStorage.getItem(storageKey(kind, userId));
    return value && /^[\w-]{1,120}$/.test(value) ? value : null;
  } catch {
    return null;
  }
}

export async function savePendingOutcome(kind: PendingKind, userId: string, idempotencyKey: string): Promise<void> {
  try {
    await AsyncStorage.setItem(storageKey(kind, userId), idempotencyKey);
  } catch {
    // The in-memory guard still applies for this run of the app.
  }
}

export async function clearPendingOutcome(kind: PendingKind, userId: string): Promise<void> {
  try {
    await AsyncStorage.removeItem(storageKey(kind, userId));
  } catch {
    // Nothing useful to do.
  }
}
