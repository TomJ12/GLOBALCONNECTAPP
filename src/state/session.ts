import { create } from 'zustand';

import { getProviderClient } from '@/api';
import type { Session } from '@/api/types';
import {
  forgetRememberedDevice,
  loadDeviceCredential,
  loadRememberedDevice,
  saveRememberedDevice,
  type RememberedDevice,
} from '@/lib/deviceStore';
import { queryClient, setUnauthorizedHandler } from '@/lib/queryClient';

type SignedOutReason = 'expired' | null;

interface SessionState {
  /** False until the remembered device has been read from storage. */
  hydrated: boolean;
  session: Session | null;
  remembered: RememberedDevice | null;
  signedOutReason: SignedOutReason;

  hydrate: () => Promise<void>;
  /** Enter the app with a session from the magic link or a biometric unlock. */
  startSession: (session: Session) => void;
  /** Remember this device so a biometric check can unlock it next time. */
  enableBiometricUnlock: (session: Session) => Promise<void>;
  /** Start a session from the stored device credential. Call only after a biometric check. */
  unlockWithDevice: () => Promise<void>;
  signOut: (reason?: SignedOutReason) => Promise<void>;
  forgetDevice: () => Promise<void>;
}

export const useSession = create<SessionState>((set, get) => ({
  hydrated: false,
  session: null,
  remembered: null,
  signedOutReason: null,

  hydrate: async () => {
    const remembered = await loadRememberedDevice();
    set({ hydrated: true, remembered });
  },

  startSession: (session) => {
    // Nothing cached for a previous person may be shown to this one.
    queryClient.clear();
    set({ session, signedOutReason: null });
  },

  enableBiometricUnlock: async (session) => {
    const remembered: RememberedDevice = {
      email: session.user.email,
      displayName: session.user.displayName,
      biometricEnabled: true,
    };
    await saveRememberedDevice(remembered, session.deviceCredential);
    set({ remembered });
  },

  unlockWithDevice: async () => {
    const credential = await loadDeviceCredential();
    if (!credential) {
      await get().forgetDevice();
      throw new Error('No device credential stored');
    }
    const session = await getProviderClient().resumeSession(credential);
    get().startSession(session);
  },

  signOut: async (reason = null) => {
    if (!get().session) return;
    // Clear local state first so the UI leaves the app at once.
    set({ session: null, signedOutReason: reason });
    await queryClient.cancelQueries();
    queryClient.clear();
    await getProviderClient().signOut();
  },

  forgetDevice: async () => {
    await forgetRememberedDevice();
    set({ remembered: null });
  },
}));

setUnauthorizedHandler(() => {
  void useSession.getState().signOut('expired');
});
