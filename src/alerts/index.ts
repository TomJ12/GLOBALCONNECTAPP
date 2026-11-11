import AsyncStorage from '@react-native-async-storage/async-storage';

import type { AlertsStore } from './AlertsStore';
import { LocalAlertsStore } from './localAlertsStore';

const stores = new Map<string, AlertsStore>();
let override: AlertsStore | null = null;

/**
 * Storage key for one person's alerts. The email is hashed (FNV-1a, not for
 * security) so no email address is left readable in device storage.
 */
export function alertsStorageKey(userKey: string): string {
  let hash = 0x811c9dc5;
  for (const char of userKey.trim().toLowerCase()) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `globalconnect.alerts.v1.${hash.toString(16).padStart(8, '0')}`;
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

/**
 * Drop every in-memory copy. Called on sign-out. The saved alerts stay on the
 * device under that person's own key: they are preferences, not credentials.
 */
export function resetAlertsStores(): void {
  stores.clear();
}

export function setAlertsStoreForTests(next: AlertsStore | null): void {
  override = next;
}

export type { AlertDirection, AlertsStore, NewRateAlert, RateAlert } from './AlertsStore';
export { AlertsStoreError } from './AlertsStore';
