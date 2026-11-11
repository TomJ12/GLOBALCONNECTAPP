import { useCallback, useEffect, useRef, useState } from 'react';

import { outcomeCheckTiming } from '@/config/app';
import { clearPendingOutcome, loadPendingOutcome, savePendingOutcome, type PendingKind, type PendingOutcome } from '@/lib/pendingOutcome';
import { useSession } from '@/state/session';

export type OutcomeResolution<T> =
  /** The backend has it: it went through. */
  | { status: 'found'; value: T }
  /**
   * The whole processing window passed and the backend still has no record.
   * This is NOT proof that nothing happened; the wording must not say so.
   */
  | { status: 'released' };

export interface OutcomeCheck {
  /** False until device storage has been read. No attempt may start before that. */
  ready: boolean;
  /** True while an earlier attempt's outcome is unknown. The screen must not allow another attempt. */
  blocked: boolean;
  isChecking: boolean;
  /** Record the attempt on the device BEFORE sending it. Rejects if it cannot be recorded. */
  begin: (idempotencyKey: string, signature: string) => Promise<void>;
  /** The backend gave a definite answer (success or refusal): forget the attempt. */
  settle: () => Promise<void>;
  /** No definite answer (no response, timeout, unreadable response): block and keep checking. */
  markUnknown: () => void;
  /** Check now instead of waiting for the next automatic check. */
  checkNow: () => Promise<void>;
}

/**
 * Guards against paying or converting twice.
 *
 * The attempt is saved before it is sent. If its outcome becomes unknown, or
 * the app was closed while it was in flight, the form stays blocked and the
 * backend is asked about the key repeatedly for the whole processing window
 * (`outcomeCheckTiming`). One early "not found" proves nothing, because the
 * request may still be on its way, so the block is released only by a "not
 * found" that comes after the window has passed.
 */
export function useOutcomeCheck<T>(
  kind: PendingKind,
  find: (idempotencyKey: string) => Promise<T | null>,
  onResolved: (result: OutcomeResolution<T>) => void,
): OutcomeCheck {
  const userId = useSession((state) => state.session?.user.id ?? 'signed-out');
  const [ready, setReady] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const [isChecking, setIsChecking] = useState(false);
  const entry = useRef<PendingOutcome | null>(null);
  const mounted = useRef(true);
  const running = useRef(false);
  const latest = useRef({ find, onResolved });
  useEffect(() => {
    latest.current = { find, onResolved };
  });

  const check = useCallback(async () => {
    const current = entry.current;
    if (!current || running.current) return;
    running.current = true;
    if (mounted.current) setIsChecking(true);
    try {
      let value: T | null;
      try {
        value = await latest.current.find(current.key);
      } catch {
        return; // Could not ask. Stay blocked and ask again later.
      }
      const windowOver = Date.now() - current.startedAt >= outcomeCheckTiming.windowMs;
      if (value === null && !windowOver) return; // Too early to conclude anything.
      if (entry.current !== current) return;
      entry.current = null;
      await clearPendingOutcome(kind, userId);
      if (!mounted.current) return;
      setBlocked(false);
      latest.current.onResolved(value === null ? { status: 'released' } : { status: 'found', value });
    } finally {
      running.current = false;
      if (mounted.current) setIsChecking(false);
    }
  }, [kind, userId]);

  // On mount: anything left from an earlier visit (a lost reply, or the app closed
  // mid-request) blocks the screen and is checked before a new attempt is possible.
  useEffect(() => {
    mounted.current = true;
    void loadPendingOutcome(kind, userId).then((stored) => {
      if (!mounted.current) return;
      if (stored) {
        entry.current = stored;
        setBlocked(true);
      }
      setReady(true);
    });
    return () => {
      mounted.current = false;
    };
  }, [kind, userId]);

  // While blocked: check at once, then at intervals, until resolved.
  useEffect(() => {
    if (!blocked) return;
    void check();
    const timer = setInterval(() => void check(), outcomeCheckTiming.intervalMs);
    return () => clearInterval(timer);
  }, [blocked, check]);

  const begin = useCallback(
    async (idempotencyKey: string, signature: string) => {
      const next: PendingOutcome = { key: idempotencyKey, signature, startedAt: Date.now() };
      await savePendingOutcome(kind, userId, next);
      entry.current = next;
    },
    [kind, userId],
  );

  const settle = useCallback(async () => {
    entry.current = null;
    await clearPendingOutcome(kind, userId);
    if (mounted.current) setBlocked(false);
  }, [kind, userId]);

  const markUnknown = useCallback(() => {
    if (entry.current && mounted.current) setBlocked(true);
  }, []);

  return { ready, blocked, isChecking, begin, settle, markUnknown, checkNow: check };
}
