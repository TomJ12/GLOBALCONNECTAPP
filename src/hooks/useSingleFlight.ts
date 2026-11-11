import { useCallback, useEffect, useRef, useState } from 'react';

import { showToast } from '@/state/toast';

/**
 * Actions are expected to handle their own failures. If one rejects anyway it is
 * a bug or something unforeseen: say so rather than failing silently.
 */
function reportUnexpected(error: unknown): void {
  console.error('Unexpected error in a guarded action', error);
  showToast('Something unexpected went wrong. Check the result before trying again.');
}

/**
 * Wraps an async action so it cannot run twice at once. The lock is a ref, so
 * a second tap in the same frame (before React re-renders the disabled button)
 * is ignored too. Use it on every button that moves money.
 */
export function useSingleFlight<Args extends unknown[]>(
  action: (...args: Args) => Promise<void>,
): { run: (...args: Args) => void; busy: boolean } {
  const locked = useRef(false);
  const mounted = useRef(true);
  const latest = useRef(action);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    latest.current = action;
  });
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const run = useCallback((...args: Args) => {
    if (locked.current) return;
    locked.current = true;
    setBusy(true);
    void latest
      .current(...args)
      .catch(reportUnexpected)
      .finally(() => {
        locked.current = false;
        if (mounted.current) setBusy(false);
      });
  }, []);

  return { run, busy };
}
