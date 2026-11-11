import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, View } from 'react-native';

import { AppText } from '@/components/AppText';
import { Button } from '@/components/Button';
import { Screen } from '@/components/Screen';
import { InlineMessage } from '@/components/StateViews';
import { useVerifyMagicLink } from '@/hooks/queries';
import { useSingleFlight } from '@/hooks/useSingleFlight';
import { loadSignInAttempt, saveSignInAttempt } from '@/lib/signInAttempt';
import { useSession } from '@/state/session';
import { colors, spacing } from '@/theme';

import { signInErrorMessage } from './SignInScreen';

/**
 * Opened by the emailed link: globalconnect://magic-link?request=<id>&code=<code>
 * (or /magic-link?request=...&code=... on web).
 *
 * Two safeguards:
 *  - the link only completes on the device that requested it (the secret saved
 *    at request time must be here; see lib/signInAttempt.ts);
 *  - if someone is already signed in, nothing happens until they choose to
 *    switch. A link can never silently replace a session.
 */
export function MagicLinkScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ request?: string; code?: string }>();
  const verifyLink = useVerifyMagicLink();
  const session = useSession((state) => state.session);
  const startSession = useSession((state) => state.startSession);
  const signOut = useSession((state) => state.signOut);
  const [error, setError] = useState<string | null>(null);
  /** Who was signed in when the link was opened. Decided once, so signing in does not re-trigger the question. */
  const [existingUser] = useState(() => session?.user.email ?? null);
  const [confirmedSwitch, setConfirmedSwitch] = useState(false);
  const started = useRef(false);

  const requestId = typeof params.request === 'string' ? params.request : '';
  const code = typeof params.code === 'string' ? params.code : '';
  const incomplete = requestId === '' || code === '';
  const mustAsk = existingUser !== null && !confirmedSwitch;
  const { mutateAsync } = verifyLink;

  useEffect(() => {
    if (started.current || incomplete || mustAsk) return;
    started.current = true;
    mutateAsync({ requestId, code }).then(
      (next) => {
        startSession(next);
        router.replace('/');
      },
      (caught: unknown) => setError(signInErrorMessage(caught)),
    );
  }, [requestId, code, incomplete, mustAsk, mutateAsync, startSession, router]);

  const switchAccount = useSingleFlight(async () => {
    // Signing out wipes everything, including the secret for the link being opened. Carry that one across.
    const attempt = await loadSignInAttempt();
    await signOut();
    if (attempt) await saveSignInAttempt(attempt);
    setConfirmedSwitch(true);
  });

  return (
    <Screen tone="navy">
      <View style={{ gap: spacing.lg, marginTop: spacing.xxl }}>
        <AppText variant="heading" tone="onDark" accessibilityRole="header">
          {mustAsk ? 'Switch account?' : 'Signing you in'}
        </AppText>
        {incomplete ? <InlineMessage tone="danger">This login link is incomplete. Request a new one.</InlineMessage> : null}
        {!incomplete && mustAsk ? (
          <>
            <AppText tone="onDarkMuted">
              {`You are signed in as ${existingUser}. Opening this login link will sign that account out first.`}
            </AppText>
            <Button label="Stay signed in" onPress={() => router.replace('/')} disabled={switchAccount.busy} testID="magic-stay" />
            <Button label="Sign out and use this link" variant="onDark" onPress={switchAccount.run} loading={switchAccount.busy} testID="magic-switch" />
          </>
        ) : null}
        {error ? <InlineMessage tone="danger">{error}</InlineMessage> : null}
        {!incomplete && !mustAsk && !error ? <ActivityIndicator color={colors.textOnDark} accessibilityLabel="Signing you in" /> : null}
        {incomplete || error ? <Button label="Back to sign in" variant="onDark" onPress={() => router.replace('/sign-in')} /> : null}
      </View>
    </Screen>
  );
}
