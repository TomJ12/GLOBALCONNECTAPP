import { useEffect, useState } from 'react';

import { getBiometricKind, type BiometricKind } from '@/lib/biometrics';

/** Which biometric check this device offers. 'none' until known, and on web. */
export function useBiometricKind(): BiometricKind {
  const [kind, setKind] = useState<BiometricKind>('none');
  useEffect(() => {
    let active = true;
    void getBiometricKind().then((value) => {
      if (active) setKind(value);
    });
    return () => {
      active = false;
    };
  }, []);
  return kind;
}
