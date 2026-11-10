/**
 * One helper for "prove it is you" before unlocking or moving money.
 *
 * On a phone with Face ID / fingerprint set up it shows the system prompt.
 * On web, or a device without biometrics, it falls back to an in-app confirm
 * step. The fallback is NOT strong authentication; a production build must
 * decide what replaces it (for example a passcode or re-sending a login link).
 */
import * as LocalAuthentication from 'expo-local-authentication';
import { Platform } from 'react-native';

import { requestConfirmation } from '@/state/confirm';

export type BiometricKind = 'face' | 'fingerprint' | 'iris' | 'none';

export async function getBiometricKind(): Promise<BiometricKind> {
  if (Platform.OS === 'web') return 'none';
  try {
    const [hasHardware, isEnrolled] = await Promise.all([
      LocalAuthentication.hasHardwareAsync(),
      LocalAuthentication.isEnrolledAsync(),
    ]);
    if (!hasHardware || !isEnrolled) return 'none';
    const types = await LocalAuthentication.supportedAuthenticationTypesAsync();
    if (types.includes(LocalAuthentication.AuthenticationType.FACIAL_RECOGNITION)) return 'face';
    if (types.includes(LocalAuthentication.AuthenticationType.FINGERPRINT)) return 'fingerprint';
    if (types.includes(LocalAuthentication.AuthenticationType.IRIS)) return 'iris';
    return 'none';
  } catch {
    return 'none';
  }
}

/** What to call the check on this device, for button labels. Null when there is none. */
export function biometricName(kind: BiometricKind): string | null {
  switch (kind) {
    case 'face':
      return Platform.OS === 'ios' ? 'Face ID' : 'face unlock';
    case 'fingerprint':
      return Platform.OS === 'ios' ? 'Touch ID' : 'fingerprint';
    case 'iris':
      return 'iris unlock';
    default:
      return null;
  }
}

export interface BiometricPrompt {
  /** Shown in the system prompt, for example "Approve payment of $18,400.00". */
  reason: string;
  /** Used by the fallback confirm step. */
  fallbackTitle: string;
  fallbackMessage: string;
  fallbackConfirmLabel: string;
}

const FALL_BACK_ON: ReadonlySet<string> = new Set(['not_enrolled', 'not_available', 'passcode_not_set']);

/** Resolves true only when the person passed the check (or confirmed in the fallback). Never rejects. */
export async function confirmWithBiometrics(prompt: BiometricPrompt): Promise<boolean> {
  const fallback = () =>
    requestConfirmation({
      title: prompt.fallbackTitle,
      message: prompt.fallbackMessage,
      confirmLabel: prompt.fallbackConfirmLabel,
    });

  if ((await getBiometricKind()) === 'none') return fallback();
  try {
    const result = await LocalAuthentication.authenticateAsync({
      promptMessage: prompt.reason,
      cancelLabel: 'Cancel',
    });
    if (result.success) return true;
    return FALL_BACK_ON.has(result.error) ? fallback() : false;
  } catch {
    return false;
  }
}
