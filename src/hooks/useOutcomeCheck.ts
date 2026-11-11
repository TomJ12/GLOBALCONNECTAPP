import { useCallback, useEffect, useRef, useState } from 'react';

import { clearPendingOutcome, loadPendingOutcome, savePendingOutcome, type PendingKind } from '@/lib/pendingOutcome';
import { useSession } from '@/state/session';

export type OutcomeCheckResult<T> =
  /** It went through. */
  | { status: 'found'; value: T }
  /** The backend has no record of it. */
  | { status: 'not_found' }
  /** We still cannot tell. Another attempt stays blocked. */
  | { status: 'unknown' };

export interface OutcomeCheck<T> {
  /** The key whose outcome is unknown, or null. While set, the screen must not allow another attempt. */
  pendingKey: string | null;
  isChecking: boolean;
  /** Call when a money movement failed in a way that may still have applied it. Checks at once. */
  markUnknown: (idempotencyKey: string) => Promise<OutcomeCheckResult<T>>;
  /** Check again, after an earlier check could not get an answer. */
  recheck: () => Promise<OutcomeCheckResult<T>>;
}

/**
 * Guards against paying or converting twice after an ambiguous failure (no
 * response, timeout, unreadable response). The unknown key is held, and saved
 * on the device, until the backend says whether it happened.
 *
 * `find` looks the key up; `onRestored` is called if an unknown outcome left
 * over from an earlier run of the app is resolved when the screen opens.
 */
export function useOutcomeCheck<T>(
  kind: PendingKind,
  find: (idempotencyKey: string) => Promise<T | null>,
  onRestored: (result: OutcomeCheckResult<T>) => void,
): OutcomeCheck<T> {
  const userId = useSession((state) => state.session?.user.id ?? 'signed-out');
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  const [isChecking, setIsChecking] = useState(false);
  const mounted = useRef(true);
  const latest = useRef({ find, onRestored });
  useEffect(() => {
    latest.current = { find, onRestored };
  });

  const check = useCallback(
    async (key: string): Promise<OutcomeCheckResult<T>> => {
      if (mounted.current) setIsChecking(true);
      let result: OutcomeCheckResult<T>;
      try {
        const value = await latest.current.find(key);
        result = value === null ? { status: 'not_found' } : { status: 'found', value };
      } catch {
        result = { status: 'unknown' };
      }
      if (result.status !== 'unknown') {
        await clearPendingOutcome(kind, userId);
        if (mounted.current) setPendingKey(null);
      }
      if (mounted.current) setIsChecking(false);
      return result;
    },
    [kind, userId],
  );

  // An unknown outcome from an earlier run of the app: block and check straight away.
  useEffect(() => {
    mounted.current = true;
    void loadPendingOutcome(kind, userId).then((stored) => {
      if (!stored || !mounted.current) return;
      setPendingKey(stored);
      void check(stored).then((result) => {
        if (mounted.current) latest.current.onRestored(result);
      });
    });
    return () => {
      mounted.current = false;
    };
  }, [kind, userId, check]);

  const markUnknown = useCallback(
    async (key: string) => {
      setPendingKey(key);
      await savePendingOutcome(kind, userId, key);
      return check(key);
    },
    [kind, userId, check],
  );

  const recheck = useCallback(async (): Promise<OutcomeCheckResult<T>> => {
    if (!pendingKey) return { status: 'not_found' };
    return check(pendingKey);
  }, [pendingKey, check]);

  return { pendingKey, isChecking, markUnknown, recheck };
}
