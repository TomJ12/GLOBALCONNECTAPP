import { useSyncExternalStore } from 'react';
import { AppState } from 'react-native';

function subscribe(onChange: () => void): () => void {
  const subscription = AppState.addEventListener('change', onChange);
  return () => subscription.remove();
}

/** True while the app is in the foreground. */
export function useAppIsActive(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => AppState.currentState !== 'background' && AppState.currentState !== 'inactive',
    () => true,
  );
}
