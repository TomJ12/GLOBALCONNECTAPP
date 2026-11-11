/**
 * The record of a money movement that has been sent but not yet definitely
 * answered. It is written BEFORE the request goes out and removed only when the
 * backend gives a definite answer, so closing the app mid-request, navigating
 * away or a lost reply can never lose track of it.
 *
 * Stored: the idempotency key, a signature of what was sent, and when. No
 * amounts, payees or credentials. The storage key carries a hash of the user
 * id, so one person's pending movement never blocks or shows for another.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { z } from 'zod';

import { storageLabel } from './hash';

export type PendingKind = 'payment' | 'conversion';

const schema = z.object({
  key: z.string().regex(/^[\w-]{1,120}$/),
  signature: z.string().max(400),
  startedAt: z.number(),
});
export type PendingOutcome = z.infer<typeof schema>;

export function pendingStorageKey(kind: PendingKind, userId: string): string {
  return `globalconnect.pendingOutcome.v2.${kind}.${storageLabel(userId)}`;
}

export async function loadPendingOutcome(kind: PendingKind, userId: string): Promise<PendingOutcome | null> {
  try {
    const text = await AsyncStorage.getItem(pendingStorageKey(kind, userId));
    const parsed = text ? schema.safeParse(JSON.parse(text)) : null;
    return parsed?.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Rejects if it cannot be written: the caller must then NOT send the request. */
export async function savePendingOutcome(kind: PendingKind, userId: string, entry: PendingOutcome): Promise<void> {
  await AsyncStorage.setItem(pendingStorageKey(kind, userId), JSON.stringify(entry));
}

export async function clearPendingOutcome(kind: PendingKind, userId: string): Promise<void> {
  try {
    await AsyncStorage.removeItem(pendingStorageKey(kind, userId));
  } catch {
    // The next visit will find it and reconcile again, which is safe.
  }
}
