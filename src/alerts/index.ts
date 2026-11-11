import AsyncStorage from '@react-native-async-storage/async-storage';

import { storageLabel } from '@/lib/hash';

import type { AlertsStore } from './AlertsStore';
import { LocalAlertsStore } from './localAlertsStore';

const stores = new Map<string, AlertsStore>();
let override: AlertsStore | null = null;

/** Storage key for one person's alerts. The email is hashed so it is not left readable in device storage. */
export function alertsStorageKey(userKey: string): string {
  return `globalconnect.alerts.v1.${storageLabel(userKey)}`;
}

/**
 * The one place that chooses the alerts implementation. Alerts belong to a
 * person, so each signed-in user gets their own store and storage key: two
 * people sharing a phone never see each other's alerts.
 */
export function getAlertsStore(userKey: string): AlertsStore {
  if (override) return override;
  let store = stores.get(userKey);
  if (!store) {
    store = new LocalAlertsStore(AsyncStorage, alertsStorageKey(userKey));
    stores.set(userKey, store);
  }
  return store;
}

/** Drop every in-memory copy. Called whenever a session starts or ends. */
export function resetAlertsStores(): void {
  stores.clear();
}

/**
 * Delete one person's saved alerts from this device. Called on sign-out, so
 * signing out leaves nothing of theirs behind. (Product decision, default for
 * now: it means alerts do not survive a sign-out, including the automatic one
 * after time in the background.)
 */
export async function deleteAlertsFor(userKey: string): Promise<void> {
  stores.delete(userKey);
  try {
    await AsyncStorage.removeItem(alertsStorageKey(userKey));
  } catch {
    // Nothing useful to do.
  }
}

export function setAlertsStoreForTests(next: AlertsStore | null): void {
  override = next;
}

export type { AlertDirection, AlertsStore, NewRateAlert, RateAlert } from './AlertsStore';
export { AlertsStoreError } from './AlertsStore';
