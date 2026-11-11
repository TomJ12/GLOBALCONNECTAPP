import { AppState, type AppStateStatus } from 'react-native';

/** Lock the app after it has been out of the foreground for this long. */
export const INACTIVITY_LOCK_MS = 2 * 60 * 1000;

/**
 * Returns a handler for app-state changes that calls `onLock` when the app
 * comes back after being in the background for `limitMs` or longer.
 */
export function createInactivityHandler(options: {
  onLock: () => void;
  limitMs?: number;
  now?: () => number;
}): (state: AppStateStatus) => void {
  const now = options.now ?? (() => Date.now());
  const limitMs = options.limitMs ?? INACTIVITY_LOCK_MS;
  let leftAt: number | null = null;
  return (state) => {
    if (state === 'active') {
      const away = leftAt === null ? 0 : now() - leftAt;
      leftAt = null;
      if (away >= limitMs) options.onLock();
    } else if (leftAt === null) {
      leftAt = now();
    }
  };
}

/** Start watching. Returns a cleanup function. */
export function startInactivityLock(onLock: () => void): () => void {
  const subscription = AppState.addEventListener('change', createInactivityHandler({ onLock }));
  return () => subscription.remove();
}
