import AsyncStorage from '@react-native-async-storage/async-storage';

import type { AlertsStore } from './AlertsStore';
import { LocalAlertsStore } from './localAlertsStore';

let store: AlertsStore | null = null;

/** The one place that chooses the alerts implementation. */
export function getAlertsStore(): AlertsStore {
  store ??= new LocalAlertsStore(AsyncStorage);
  return store;
}

export function setAlertsStoreForTests(next: AlertsStore | null): void {
  store = next;
}

export type { AlertDirection, AlertsStore, NewRateAlert, RateAlert } from './AlertsStore';
export { AlertsStoreError } from './AlertsStore';
