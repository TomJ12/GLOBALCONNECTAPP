import { useRouter } from 'expo-router';
import { Fingerprint, Mail, ScanFace } from 'lucide-react-native';
import { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { getProviderClient, isMockBackend } from '@/api';
import { toProviderError } from '@/api/errors';
import type { MagicLinkRequest, Session } from '@/api/types';
import { AppText } from '@/components/AppText';
import { Button } from '@/components/Button';
import { Screen } from '@/components/Screen';
import { InlineMessage } from '@/components/StateViews';
import { TextField } from '@/components/TextField';
import { APP_NAME } from '@/config/app';
import { disclosures } from '@/config/disclosures';
import { useBiometricKind } from '@/hooks/useBiometricKind';
import { useSingleFlight } from '@/hooks/useSingleFlight';
import { biometricName, confirmWithBiometrics } from '@/lib/biometrics';
import { isValidEmail } from '@/lib/validation';
import { useSession } from '@/state/session';
import { colors, radii, sizes, spacing } from '@/theme';

type Step = 'email' | 'sent' | 'offer';

function signInMessage(error: unknown): string {
  const providerError = toProviderError(error);
  if (providerError.kind === 'unauthorized') return 'That link is not valid or has expired. Request a new one.';
  if (providerError.kind === 'validation') return 'Enter the email address registered on your account.';
  return providerError.userMessage;
}

export function SignInScreen() {
  const router = useRouter();
  const remembered = useSession((state) => state.remembered);
  const signedOutReason = useSession((state) => state.signedOutReason);
  const startSession = useSession((state) => state.startSession);
  const enableBiometricUnlock = useSession((state) => state.enableBiometricUnlock);
  const unlockWithDevice = useSession((state) => state.unlockWithDevice);
  const forgetDevice = useSession((state) => state.forgetDevice);
  const biometric = biometricName(useBiometricKind());

  const canUnlock = remembered?.biometricEnabled === true;
  const [useEmailInstead, setUseEmailInstead] = useState(false);
  const [step, setStep] = useState<Step>('email');
  const [email, setEmail] = useState('');
  const [emailError, setEmailError] = useState<string | null>(null);
  const [link, setLink] = useState<MagicLinkRequest | null>(null);
  const [pendingSession, setPendingSession] = useState<Session | null>(null);
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
      setLink(await getProviderClient().requestMagicLink(trimmed));
      setStep('sent');
    } catch (caught) {
      setError(signInMessage(caught));
    }
  });

  const completeLink = useSingleFlight(async () => {
    if (!link?.devCode) return;
    setError(null);
    try {
      setPendingSession(await getProviderClient().verifyMagicLink(link.requestId, link.devCode));
      setStep('offer');
    } catch (caught) {
      setError(signInMessage(caught));
    }
  });

  const unlock = useSingleFlight(async () => {
    setError(null);
    const confirmed = await confirmWithBiometrics({
      reason: `Unlock ${APP_NAME}`,
      fallbackTitle: `Unlock ${APP_NAME}?`,
      fallbackMessage: 'This device has no biometric check set up, so this step is a simple confirmation.',
      fallbackConfirmLabel: 'Unlock',
    });
    if (!confirmed) return;
    try {
      await unlockWithDevice();
    } catch (caught) {
      setError(signInMessage(caught));
    }
  });

  const finish = useSingleFlight(async (enable: boolean) => {
    if (!pendingSession) return;
    if (enable) {
      const confirmed = await confirmWithBiometrics({
        reason: `Turn on quick unlock for ${APP_NAME}`,
        fallbackTitle: 'Turn on quick unlock?',
        fallbackMessage: 'Next time you can unlock on this device without a login link.',
        fallbackConfirmLabel: 'Turn on',
      });
      if (confirmed) {
        try {
          await enableBiometricUnlock(pendingSession);
        } catch {
          // Quick unlock is optional. Carry on signed in without it.
        }
      }
    }
    startSession(pendingSession);
  });

  const BiometricIcon = biometric === 'Face ID' || biometric === 'face unlock' ? ScanFace : Fingerprint;
  const showUnlock = canUnlock && !useEmailInstead && step === 'email';

  return (
    <Screen tone="navy" showOfflineBanner>
      <View style={styles.brand}>
        <AppText variant="label" tone="onDarkMuted" style={styles.wordmark} accessibilityRole="header">
          {APP_NAME.toUpperCase()}
        </AppText>
        <AppText variant="heading" tone="onDark">
          Your currency accounts, in your pocket
        </AppText>
      </View>

      {signedOutReason === 'expired' ? <InlineMessage tone="warning">Your session ended. Sign in again to continue.</InlineMessage> : null}
      {error ? <InlineMessage tone="danger">{error}</InlineMessage> : null}

      {showUnlock ? (
        <View style={styles.block}>
          <AppText tone="onDarkMuted">Already set up on this phone</AppText>
          <AppText variant="title" tone="onDark">
            {remembered?.email}
          </AppText>
          <Button
            label={biometric ? `Unlock with ${biometric}` : 'Unlock'}
            icon={<BiometricIcon color={colors.textOnDark} size={22} />}
            onPress={unlock.run}
            loading={unlock.busy}
          />
          <Button label="Use a different email" variant="onDark" onPress={() => setUseEmailInstead(true)} disabled={unlock.busy} />
          <Button
            label="Forget this device"
            variant="onDark"
            onPress={() => void forgetDevice()}
            disabled={unlock.busy}
            accessibilityHint="Removes quick unlock from this device"
          />
        </View>
      ) : null}

      {!showUnlock && step === 'email' ? (
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
          {canUnlock ? <Button label="Back to quick unlock" variant="onDark" onPress={() => setUseEmailInstead(false)} /> : null}
        </View>
      ) : null}

      {step === 'sent' && link ? (
        <View style={styles.block}>
          <AppText variant="title" tone="onDark" accessibilityRole="header">
            Check your email
          </AppText>
          <AppText tone="onDarkMuted">{`We sent a secure login link to ${link.email}. Open it on this phone to sign in.`}</AppText>
          {link.devCode ? (
            <View style={styles.devCard}>
              <AppText variant="label" tone="onDark">
                Developer shortcut
              </AppText>
              <AppText variant="caption" tone="onDarkMuted">
                This build uses sample data and sends no email. Use the button to act as if you opened the link.
              </AppText>
              <Button label="Complete the link" onPress={completeLink.run} loading={completeLink.busy} testID="dev-complete-link" />
            </View>
          ) : null}
          <Button
            label="Use a different email"
            variant="onDark"
            disabled={completeLink.busy}
            onPress={() => {
              setStep('email');
              setLink(null);
              setError(null);
            }}
          />
        </View>
      ) : null}

      {step === 'offer' ? (
        <View style={styles.block}>
          <AppText variant="title" tone="onDark" accessibilityRole="header">
            Unlock faster next time?
          </AppText>
          <AppText tone="onDarkMuted">
            {biometric
              ? `Use ${biometric} on this phone instead of a login link.`
              : 'Skip the login link on this device next time.'}
          </AppText>
          <Button
            label={biometric ? `Turn on ${biometric}` : 'Turn on quick unlock'}
            icon={<BiometricIcon color={colors.textOnDark} size={22} />}
            onPress={() => finish.run(true)}
            loading={finish.busy}
          />
          <Button label="Not now" variant="onDark" onPress={() => finish.run(false)} disabled={finish.busy} />
        </View>
      ) : null}

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
