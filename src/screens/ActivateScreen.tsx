import { useLocalSearchParams, useRouter } from 'expo-router';
import * as Clipboard from 'expo-clipboard';
import { useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { getAuthClient } from '@/api';
import { toProviderError } from '@/api/errors';
import type { ActivationStart, TotpEnrolment } from '@/api/types';
import { AppText } from '@/components/AppText';
import { BrandLockup } from '@/components/BrandLockup';
import { Button } from '@/components/Button';
import { QrCode } from '@/components/QrCode';
import { Screen } from '@/components/Screen';
import { InlineMessage } from '@/components/StateViews';
import { TextField } from '@/components/TextField';
import { APP_NAME } from '@/config/app';
import { useBeginActivation, useConfirmActivation, useSetActivationPassword } from '@/hooks/queries';
import { useSingleFlight } from '@/hooks/useSingleFlight';
import { activationCodeFromLink, clearFragment, currentFragment } from '@/lib/activationLink';
import { showToast } from '@/state/toast';
import { colors, radii, spacing } from '@/theme';

type Stage =
  | { name: 'code' }
  | { name: 'password'; account: ActivationStart }
  | { name: 'authenticator'; enrolment: TotpEnrolment }
  | { name: 'recovery'; codes: string[] };

/** The key in groups of four, which is how authenticator apps show it. */
export function groupKey(secret: string): string {
  return (secret.match(/.{1,4}/g) ?? []).join(' ');
}

/** Why a password is not acceptable yet, or null. The backend makes the final decision. */
export function passwordProblem(password: string, repeat: string, minLength: number): string | null {
  if (password.length < minLength) return `Use at least ${minLength} characters.`;
  if (password !== repeat) return 'The two passwords do not match.';
  return null;
}

/**
 * Activating an invited account: activation code (typed, or from the link) ->
 * choose a password -> add the account to an authenticator app -> confirm a
 * code -> save the recovery codes. There is no self-signup.
 */
export function ActivateScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ code?: string }>();
  const begin = useBeginActivation();
  const setPasswordMutation = useSetActivationPassword();
  const confirm = useConfirmActivation();
  const sampleCode = getAuthClient().sampleCode;

  const [stage, setStage] = useState<Stage>({ name: 'code' });
  // From the link: after "#" (never sent to a server), or handed over as a parameter by a deep link.
  const [linkCode] = useState(() => activationCodeFromLink(params.code, currentFragment()));
  const [activationCode, setActivationCode] = useState(linkCode);
  const [password, setPassword] = useState('');
  const [repeat, setRepeat] = useState('');
  const [code, setCode] = useState('');
  const [saved, setSaved] = useState(false);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const fail = (caught: unknown) => setError(toProviderError(caught).userMessage);

  const start = useSingleFlight(async (value: string) => {
    setError(null);
    if (value.trim().length < 8) {
      setFieldError('Enter the activation code you were sent.');
      return;
    }
    setFieldError(null);
    try {
      setStage({ name: 'password', account: await begin.mutateAsync(value.trim()) });
    } catch (caught) {
      fail(caught);
    }
  });

  // Opened from an activation link: the code is in the address, so start at once.
  const startedFromLink = useRef(false);
  const startRun = start.run;
  useEffect(() => {
    if (startedFromLink.current || linkCode === '') return;
    startedFromLink.current = true;
    clearFragment();
    startRun(linkCode);
  }, [linkCode, startRun]);

  const choosePassword = useSingleFlight(async () => {
    if (stage.name !== 'password') return;
    setError(null);
    const problem = passwordProblem(password, repeat, stage.account.passwordPolicy.minLength);
    setFieldError(problem);
    if (problem) return;
    try {
      const enrolment = await setPasswordMutation.mutateAsync(password);
      setPassword('');
      setRepeat('');
      setStage({ name: 'authenticator', enrolment });
    } catch (caught) {
      const providerError = toProviderError(caught);
      if (providerError.reason === 'weak_password') setFieldError(providerError.userMessage);
      else fail(caught);
    }
  });

  const confirmCode = useSingleFlight(async () => {
    setError(null);
    const digits = code.replace(/\s/g, '');
    if (!/^\d{6}$/.test(digits)) {
      setFieldError('Enter the 6-digit code your authenticator app shows.');
      return;
    }
    setFieldError(null);
    try {
      const result = await confirm.mutateAsync(digits);
      setCode('');
      setStage({ name: 'recovery', codes: result.recoveryCodes });
    } catch (caught) {
      setCode('');
      fail(caught);
    }
  });

  const copy = async (text: string, message: string) => {
    await Clipboard.setStringAsync(text);
    showToast(message);
  };

  const toSignIn = () => router.replace('/sign-in');

  return (
    <Screen tone="navy">
      <View style={styles.brand}>
        <BrandLockup />
        <AppText variant="heading" tone="onDark" accessibilityRole="header">
          Activate your account
        </AppText>
      </View>

      {error ? <InlineMessage tone="danger">{error}</InlineMessage> : null}

      {stage.name === 'code' ? (
        <View style={styles.block}>
          <AppText tone="onDarkMuted">
            {`${APP_NAME} sets up each account and sends an activation code. Type it here, or open the activation link you were sent.`}
          </AppText>
          <TextField
            tone="navy"
            label="Activation code"
            value={activationCode}
            onChangeText={(text) => {
              setActivationCode(text);
              if (fieldError) setFieldError(null);
            }}
            error={fieldError}
            hint={sampleCode ? 'Sample data: the activation code is SAMPLE-ACTIVATION.' : undefined}
            autoCapitalize="characters"
            autoCorrect={false}
            autoComplete="off"
            returnKeyType="go"
            onSubmitEditing={() => start.run(activationCode)}
            maxLength={64}
            testID="activation-code"
          />
          <Button label="Continue" onPress={() => start.run(activationCode)} loading={start.busy} testID="activation-start" />
          <Button label="Back to sign in" variant="onDark" onPress={toSignIn} disabled={start.busy} />
        </View>
      ) : null}

      {stage.name === 'password' ? (
        <View style={styles.block}>
          <AppText variant="title" tone="onDark" accessibilityRole="header">
            Step 1 of 3: choose a password
          </AppText>
          <AppText tone="onDarkMuted">{`For ${stage.account.displayName}, ${stage.account.email}.`}</AppText>
          <View style={styles.rules}>
            <AppText variant="label" tone="onDark">
              Password rules
            </AppText>
            <AppText variant="caption" tone="onDarkMuted">{`• At least ${stage.account.passwordPolicy.minLength} characters. A few unrelated words work well.`}</AppText>
            <AppText variant="caption" tone="onDarkMuted">
              • Not a common password such as a keyboard pattern or a repeated word.
            </AppText>
            <AppText variant="caption" tone="onDarkMuted">
              • Any letters, numbers, spaces and symbols are allowed. None are required.
            </AppText>
          </View>
          <TextField
            tone="navy"
            label="New password"
            value={password}
            onChangeText={(text) => {
              setPassword(text);
              if (fieldError) setFieldError(null);
            }}
            secureTextEntry
            autoCapitalize="none"
            autoCorrect={false}
            autoComplete="new-password"
            textContentType="newPassword"
            maxLength={200}
            testID="activation-password"
          />
          <TextField
            tone="navy"
            label="Repeat the password"
            value={repeat}
            onChangeText={(text) => {
              setRepeat(text);
              if (fieldError) setFieldError(null);
            }}
            error={fieldError}
            secureTextEntry
            autoCapitalize="none"
            autoCorrect={false}
            autoComplete="new-password"
            textContentType="newPassword"
            returnKeyType="go"
            onSubmitEditing={choosePassword.run}
            maxLength={200}
            testID="activation-password-repeat"
          />
          <Button label="Continue" onPress={choosePassword.run} loading={choosePassword.busy} testID="activation-set-password" />
        </View>
      ) : null}

      {stage.name === 'authenticator' ? (
        <View style={styles.block}>
          <AppText variant="title" tone="onDark" accessibilityRole="header">
            Step 2 of 3: add your authenticator app
          </AppText>
          <AppText tone="onDarkMuted">
            In an authenticator app on your phone, choose to add an account, then scan this QR code. If you cannot scan it, choose to enter a setup
            key and type the key below (time-based, 6 digits).
          </AppText>
          <View style={styles.qr}>
            <QrCode value={stage.enrolment.otpauthUri} accessibilityLabel="QR code to scan with your authenticator app" />
          </View>
          <View style={styles.rules}>
            <AppText variant="label" tone="onDark">
              Setup key
            </AppText>
            <AppText tone="onDark" selectable testID="totp-key">
              {groupKey(stage.enrolment.secret)}
            </AppText>
            <Button label="Copy key" variant="onDark" onPress={() => void copy(stage.enrolment.secret, 'Key copied')} testID="copy-totp-key" />
          </View>
          <TextField
            tone="navy"
            label="6-digit code from the app"
            value={code}
            onChangeText={(text) => {
              setCode(text.replace(/[^\d\s]/g, ''));
              if (fieldError) setFieldError(null);
            }}
            error={fieldError}
            hint={sampleCode ? `Sample data: the code is ${sampleCode}.` : 'This checks that the app was set up correctly.'}
            keyboardType="number-pad"
            inputMode="numeric"
            autoComplete="one-time-code"
            textContentType="oneTimeCode"
            returnKeyType="go"
            onSubmitEditing={confirmCode.run}
            maxLength={7}
            testID="activation-totp"
          />
          <Button label="Confirm code" onPress={confirmCode.run} loading={confirmCode.busy} testID="activation-confirm" />
        </View>
      ) : null}

      {stage.name === 'recovery' ? (
        <View style={styles.block}>
          <AppText variant="title" tone="onDark" accessibilityRole="header">
            Step 3 of 3: save your recovery codes
          </AppText>
          <AppText tone="onDarkMuted">
            If you cannot use your authenticator app, one of these codes will sign you in instead. Each works once. They are shown only now: keep
            them somewhere other than this phone.
          </AppText>
          <View style={styles.rules} testID="recovery-codes">
            {stage.codes.map((item) => (
              <AppText key={item} tone="onDark" selectable>
                {item}
              </AppText>
            ))}
          </View>
          <Button label="Copy codes" variant="onDark" onPress={() => void copy(stage.codes.join('\n'), 'Recovery codes copied')} testID="copy-recovery" />
          <Pressable
            onPress={() => setSaved((current) => !current)}
            accessibilityRole="checkbox"
            accessibilityState={{ checked: saved }}
            accessibilityLabel="I have saved these codes"
            style={styles.check}
            testID="recovery-saved"
          >
            <View style={[styles.box, saved ? styles.boxChecked : null]}>
              {saved ? (
                <AppText variant="bodyStrong" tone="onDark">
                  ✓
                </AppText>
              ) : null}
            </View>
            <AppText tone="onDark">I have saved these codes</AppText>
          </Pressable>
          <Button label="Finish and sign in" onPress={toSignIn} disabled={!saved} testID="activation-finish" />
          <AppText variant="caption" tone="onDarkMuted">
            Next, sign in with your email, your password and a new code from your authenticator app.
          </AppText>
        </View>
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  brand: { gap: spacing.md, marginTop: spacing.xxl },
  block: { gap: spacing.md },
  rules: { gap: spacing.xs, padding: spacing.lg, borderRadius: radii.card, borderWidth: 1, borderColor: colors.navyBorder },
  check: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, minHeight: 48 },
  box: { width: 28, height: 28, borderRadius: 6, borderWidth: 2, borderColor: colors.textOnDark, alignItems: 'center', justifyContent: 'center' },
  boxChecked: { backgroundColor: colors.primary, borderColor: colors.primary },
  qr: { alignSelf: 'center', padding: spacing.sm, backgroundColor: '#FFFFFF', borderRadius: radii.md },
});
