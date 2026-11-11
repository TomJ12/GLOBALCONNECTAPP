import { create } from 'zustand';

import { resetAlertsStores } from '@/alerts';
import { getProviderClient } from '@/api';
import type { Session } from '@/api/types';
import { queryClient, setUnauthorizedHandler } from '@/lib/queryClient';

/** Why the app went back to the sign-in screen, when the person did not choose to. */
export type SignedOutReason = 'expired' | 'inactive' | null;

interface SessionState {
  session: Session | null;
  signedOutReason: SignedOutReason;
  /** Enter the app with a session from the emailed link or code. */
  startSession: (session: Session) => void;
  /**
   * End the session and clear everything cached for it. Nothing that can start
   * a session is ever stored on the device, so the next sign-in always needs a
   * new emailed link or code.
   */
  signOut: (reason?: SignedOutReason) => Promise<void>;
}

export const useSession = create<SessionState>((set, get) => ({
  session: null,
  signedOutReason: null,

  startSession: (session) => {
    // Nothing cached for a previous person may be shown to this one.
    queryClient.clear();
    resetAlertsStores();
    set({ session, signedOutReason: null });
  },

  signOut: async (reason = null) => {
    if (!get().session) return;
    // Clear local state first so the UI leaves the app at once.
    set({ session: null, signedOutReason: reason });
    await queryClient.cancelQueries();
    queryClient.clear();
    resetAlertsStores();
    await getProviderClient().signOut();
  },
}));

setUnauthorizedHandler(() => {
  void useSession.getState().signOut('expired');
});
