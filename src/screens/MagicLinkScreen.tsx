import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, View } from 'react-native';

import { AppText } from '@/components/AppText';
import { Button } from '@/components/Button';
import { Screen } from '@/components/Screen';
import { InlineMessage } from '@/components/StateViews';
import { useVerifyMagicLink } from '@/hooks/queries';
import { useSession } from '@/state/session';
import { colors, spacing } from '@/theme';

import { signInErrorMessage } from './SignInScreen';

/**
 * Opened by the emailed link: globalconnect://magic-link?request=<id>&code=<code>
 * (or /magic-link?request=...&code=... on web). Verifies once and signs in.
 */
export function MagicLinkScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ request?: string; code?: string }>();
  const verifyLink = useVerifyMagicLink();
  const startSession = useSession((state) => state.startSession);
  const [error, setError] = useState<string | null>(null);
  const started = useRef(false);

  const requestId = typeof params.request === 'string' ? params.request : '';
  const code = typeof params.code === 'string' ? params.code : '';
  const { mutateAsync } = verifyLink;

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    if (requestId === '' || code === '') return;
    mutateAsync({ requestId, code }).then(
      (session) => {
        startSession(session);
        router.replace('/');
      },
      (caught: unknown) => setError(signInErrorMessage(caught)),
    );
  }, [requestId, code, mutateAsync, startSession, router]);

  const incomplete = requestId === '' || code === '';
  return (
    <Screen tone="navy">
      <View style={{ gap: spacing.lg, marginTop: spacing.xxl }}>
        <AppText variant="heading" tone="onDark" accessibilityRole="header">
          Signing you in
        </AppText>
        {incomplete ? <InlineMessage tone="danger">This login link is incomplete. Request a new one.</InlineMessage> : null}
        {error ? <InlineMessage tone="danger">{error}</InlineMessage> : null}
        {!incomplete && !error ? <ActivityIndicator color={colors.textOnDark} accessibilityLabel="Signing you in" /> : null}
        {incomplete || error ? <Button label="Back to sign in" variant="onDark" onPress={() => router.replace('/sign-in')} /> : null}
      </View>
    </Screen>
  );
}
