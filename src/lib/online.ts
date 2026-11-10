import { onlineManager } from '@tanstack/react-query';
import * as Network from 'expo-network';
import { useSyncExternalStore } from 'react';

import { useDevSettings } from '@/state/devSettings';

/**
 * Keeps TanStack Query's online flag in step with the device connection and the
 * developer "simulate offline" switch. Returns a cleanup function.
 */
export function startOnlineTracking(): () => void {
  let deviceOnline = true;
  const apply = () => {
    onlineManager.setOnline(deviceOnline && !useDevSettings.getState().controls.offline);
  };

  let subscription: { remove: () => void } | null = null;
  try {
    subscription = Network.addNetworkStateListener((state) => {
      deviceOnline = state.isConnected !== false;
      apply();
    });
    Network.getNetworkStateAsync()
      .then((state) => {
        deviceOnline = state.isConnected !== false;
        apply();
      })
      .catch(() => undefined);
  } catch {
    // Network state is unavailable on this platform; assume online.
  }
  const unsubscribeDev = useDevSettings.subscribe(apply);
  apply();

  return () => {
    subscription?.remove();
    unsubscribeDev();
  };
}

const subscribe = (onChange: () => void) => onlineManager.subscribe(onChange);
const getSnapshot = () => onlineManager.isOnline();

export function useIsOnline(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, () => true);
}
