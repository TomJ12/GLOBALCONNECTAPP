import { useRouter } from 'expo-router';
import { Mail } from 'lucide-react-native';
import { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { isMockBackend } from '@/api';
import { toProviderError } from '@/api/errors';
import type { MagicLinkRequest } from '@/api/types';
import { AppText } from '@/components/AppText';
import { Button } from '@/components/Button';
import { Screen } from '@/components/Screen';
import { InlineMessage } from '@/components/StateViews';
import { TextField } from '@/components/TextField';
import { APP_NAME } from '@/config/app';
import { disclosures } from '@/config/disclosures';
import { useRequestMagicLink, useVerifyMagicLink } from '@/hooks/queries';
import { useSingleFlight } from '@/hooks/useSingleFlight';
import { isValidEmail } from '@/lib/validation';
import { useSession, type SignedOutReason } from '@/state/session';
import { colors, radii, sizes, spacing } from '@/theme';

export function signInErrorMessage(error: unknown): string {
  const providerError = toProviderError(error);
  if (providerError.kind === 'unauthorized') return 'That link or code is not valid or has expired. Request a new one.';
  if (providerError.kind === 'validation') return 'Enter the email address registered on your account.';
  return providerError.userMessage;
}

const SIGNED_OUT_MESSAGES: Record<Exclude<SignedOutReason, null>, string> = {
  expired: 'Your session ended. Sign in again to continue.',
  inactive: 'You were signed out because the app was in the background for a while.',
};

/** Sign-in is by emailed link or code, every time. Nothing is kept on the device between sessions. */
export function SignInScreen() {
  const router = useRouter();
  const signedOutReason = useSession((state) => state.signedOutReason);
  const startSession = useSession((state) => state.startSession);
  const requestLink = useRequestMagicLink();
  const verifyLink = useVerifyMagicLink();

  const [email, setEmail] = useState('');
  const [emailError, setEmailError] = useState<string | null>(null);
  const [link, setLink] = useState<MagicLinkRequest | null>(null);
  const [code, setCode] = useState('');
  const [codeError, setCodeError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const sendLink = useSingleFlight(async () => {
    setError(null);
    const trimmed = email.trim();
    if (!isValidEmail(trimmed)) {
      setEmailError('Enter a valid email address, like name@company.com.');
      return;
    }
    setEmailError(null);
    try {
      setLink(await requestLink.mutateAsync(trimmed));
      setCode('');
    } catch (caught) {
      setError(signInErrorMessage(caught));
    }
  });

  const verify = useSingleFlight(async (value: string) => {
    if (!link) return;
    setError(null);
    const trimmed = value.trim();
    if (trimmed === '') {
      setCodeError('Enter the code from the email.');
      return;
    }
    setCodeError(null);
    try {
      startSession(await verifyLink.mutateAsync({ requestId: link.requestId, code: trimmed }));
    } catch (caught) {
      setError(signInErrorMessage(caught));
    }
  });

  return (
    <Screen tone="navy">
      <View style={styles.brand}>
        <AppText variant="label" tone="onDarkMuted" style={styles.wordmark} accessibilityRole="header">
          {APP_NAME.toUpperCase()}
        </AppText>
        <AppText variant="heading" tone="onDark">
          Your currency accounts, in your pocket
        </AppText>
      </View>

      {signedOutReason ? <InlineMessage tone="warning">{SIGNED_OUT_MESSAGES[signedOutReason]}</InlineMessage> : null}
      {error ? <InlineMessage tone="danger">{error}</InlineMessage> : null}

      {link === null ? (
        <View style={styles.block}>
          <AppText tone="onDarkMuted">Sign in with the email on your account. No password to remember.</AppText>
          <TextField
            tone="navy"
            label="Registered email address"
            value={email}
            onChangeText={(text) => {
              setEmail(text);
              if (emailError) setEmailError(null);
            }}
            error={emailError}
            keyboardType="email-address"
            inputMode="email"
            autoCapitalize="none"
            autoCorrect={false}
            autoComplete="email"
            textContentType="emailAddress"
            returnKeyType="send"
            onSubmitEditing={sendLink.run}
            placeholder="name@company.com"
            maxLength={254}
          />
          <Button
            label="Send secure login link"
            icon={<Mail color={colors.textOnDark} size={20} />}
            onPress={sendLink.run}
            loading={sendLink.busy}
          />
        </View>
      ) : (
        <View style={styles.block}>
          <AppText variant="title" tone="onDark" accessibilityRole="header">
            Check your email
          </AppText>
          <AppText tone="onDarkMuted">
            {`We sent a secure login link to ${link.email}. Open it on this phone, or type the code from the email here.`}
          </AppText>
          <TextField
            tone="navy"
            label="Code from the email"
            value={code}
            onChangeText={(text) => {
              setCode(text);
              if (codeError) setCodeError(null);
            }}
            error={codeError}
            autoCapitalize="characters"
            autoCorrect={false}
            autoComplete="one-time-code"
            textContentType="oneTimeCode"
            returnKeyType="go"
            onSubmitEditing={() => verify.run(code)}
            maxLength={64}
            testID="magic-code"
          />
          <Button label="Sign in" onPress={() => verify.run(code)} loading={verify.busy} testID="verify-code" />
          {link.devCode ? (
            <View style={styles.devCard}>
              <AppText variant="label" tone="onDark">
                Developer shortcut
              </AppText>
              <AppText variant="caption" tone="onDarkMuted">
                This build uses sample data and sends no email. Use the button to act as if you opened the link.
              </AppText>
              <Button
                variant="onDark"
                label="Complete the link"
                onPress={() => verify.run(link.devCode ?? '')}
                disabled={verify.busy}
                testID="dev-complete-link"
              />
            </View>
          ) : null}
          <Button
            label="Use a different email"
            variant="onDark"
            disabled={verify.busy}
            onPress={() => {
              setLink(null);
              setError(null);
              setCodeError(null);
            }}
          />
        </View>
      )}

      <View style={styles.footer}>
        <AppText variant="caption" tone="onDarkMuted">{`New to ${APP_NAME}? ${disclosures.openAccount}`}</AppText>
        <AppText variant="caption" tone="onDarkMuted">
          {disclosures.regulatoryFooter}
        </AppText>
        {isMockBackend() ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Developer settings"
            onPress={() => router.push('/settings')}
            style={styles.devLink}
          >
            <AppText variant="label" tone="onDarkMuted" style={styles.underline}>
              Developer settings
            </AppText>
          </Pressable>
        ) : null}
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  brand: { gap: spacing.md, marginTop: spacing.xxl },
  wordmark: { letterSpacing: 2 },
  block: { gap: spacing.md },
  devCard: { gap: spacing.sm, padding: spacing.lg, borderRadius: radii.card, borderWidth: 1, borderColor: colors.navyBorder, borderStyle: 'dashed' },
  footer: { marginTop: 'auto', gap: spacing.sm, paddingTop: spacing.xl },
  devLink: { minHeight: sizes.touchTarget, justifyContent: 'center', alignSelf: 'flex-start' },
  underline: { textDecorationLine: 'underline' },
});
