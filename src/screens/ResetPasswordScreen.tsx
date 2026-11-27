import { useRouter } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { getAuthClient } from '@/api';
import { toProviderError } from '@/api/errors';
import type { CodeMethod } from '@/api/types';
import { AppText } from '@/components/AppText';
import { BrandLockup } from '@/components/BrandLockup';
import { Button } from '@/components/Button';
import { Screen } from '@/components/Screen';
import { InlineMessage } from '@/components/StateViews';
import { TextField } from '@/components/TextField';
import { APP_NAME } from '@/config/app';
import { disclosures } from '@/config/disclosures';
import { useSingleFlight } from '@/hooks/useSingleFlight';
import { takeCodeFromAddressBar } from '@/lib/activationLink';
import { isValidEmail } from '@/lib/validation';
import { spacing } from '@/theme';

import { passwordProblem } from './ActivateScreen';

/** Said after asking for a link, whatever the address: it must not reveal whether the address has an account. */
export const RESET_REQUESTED = `If that address belongs to a ${APP_NAME} account, an email with a link is on its way. The link works for 30 minutes.`;
/** Email alone is never enough: there is no way back online without the authenticator or a recovery code. */
/** Shown when finishing a reset is refused because the link is no longer good: which is also what a retry sees after a reset that DID go through. */
export const RESET_MAYBE_DONE = 'That reset link is not valid any more. If you just pressed the button and did not see an answer, your password may already have been changed: try signing in with the new password before asking for another link.';
export const NO_SECOND_FACTOR = `Lost your authenticator app and your recovery codes? That cannot be put right here: an email alone must never be enough to take over an account. Contact ${APP_NAME}, who will check who you are before anything is changed. ${disclosures.contactSupport}`;

type Stage = { name: 'request' } | { name: 'requested' } | { name: 'link' } | { name: 'reset'; minLength: number; method: CodeMethod } | { name: 'done' };

/**
 * A forgotten password. Ask for a link by email; open the link; then the new
 * password needs BOTH the link AND a code from the authenticator app (or an
 * unused recovery code). The authenticator itself is never changed here.
 */
export function ResetPasswordScreen() {
  const router = useRouter();
  const selfService = getAuthClient().selfService;
  // From the link: after "#" (never sent to a server), and only from there. It is taken out of the address bar the
  // moment it is read, before anything is sent, whether or not it turns out to be good.
  const [linkCode] = useState(() => takeCodeFromAddressBar());
  const [stage, setStage] = useState<Stage>(linkCode ? { name: 'link' } : { name: 'request' });
  const [email, setEmail] = useState('');
  const [resetCode, setResetCode] = useState(linkCode);
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [repeat, setRepeat] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [fieldError, setFieldError] = useState<{ email?: string; resetCode?: string; code?: string; password?: string }>({});

  const ask = useSingleFlight(async () => {
    setError(null);
    const trimmed = email.trim();
    if (!isValidEmail(trimmed)) {
      setFieldError({ email: 'Enter a valid email address, like name@company.com.' });
      return;
    }
    setFieldError({});
    try {
      await selfService?.requestPasswordReset(trimmed);
      setStage({ name: 'requested' });
    } catch (caught) {
      setError(toProviderError(caught).userMessage);
    }
  });

  const open = useSingleFlight(async () => {
    setError(null);
    if (resetCode.trim().length < 8) {
      setFieldError({ resetCode: 'Enter the code from the link in the email.' });
      return;
    }
    setFieldError({});
    try {
      const policy = await selfService?.beginPasswordReset(resetCode);
      setStage({ name: 'reset', minLength: policy?.minLength ?? 12, method: 'totp' });
    } catch (caught) {
      setError(toProviderError(caught).userMessage);
    }
  });

  const finish = useSingleFlight(async () => {
    if (stage.name !== 'reset') return;
    setError(null);
    const value = code.trim();
    const codeOk = stage.method === 'totp' ? /^\d{6}$/.test(value.replace(/\s/g, '')) : value.length >= 8;
    const problems = {
      code: codeOk ? undefined : stage.method === 'totp' ? 'Enter the 6-digit code from your authenticator app.' : 'Enter one of your recovery codes.',
      password: passwordProblem(password, repeat, stage.minLength) ?? undefined,
    };
    setFieldError(problems);
    if (problems.code || problems.password) return;
    try {
      await selfService?.completePasswordReset(stage.method === 'totp' ? value.replace(/\s/g, '') : value, stage.method, password);
      setPassword('');
      setRepeat('');
      setCode('');
      setStage({ name: 'done' });
    } catch (caught) {
      const providerError = toProviderError(caught);
      setCode('');
      // The link itself is no longer good: back to asking for a new one. It may also be that the password WAS
      // changed and only the answer was lost on the way (the link works once): say so, so that nobody is left
      // asking for links to an account whose new password already works.
      if (providerError.reason === 'reset_invalid') {
        setPassword('');
        setRepeat('');
        setStage({ name: 'request' });
        setError(RESET_MAYBE_DONE);
        return;
      }
      setError(providerError.userMessage);
    }
  });

  return (
    <Screen tone="navy">
      <View style={styles.brand}>
        <BrandLockup />
        <AppText variant="heading" tone="onDark" accessibilityRole="header">
          Reset your password
        </AppText>
      </View>
      {error ? <InlineMessage tone="danger">{error}</InlineMessage> : null}

      {!selfService ? (
        <View style={styles.block}>
          <AppText tone="onDarkMuted">This build is not connected to a server, so there is no account to reset.</AppText>
        </View>
      ) : null}

      {selfService && stage.name === 'request' ? (
        <View style={styles.block}>
          <AppText tone="onDarkMuted">
            Enter the email address you sign in with. If it has an account, a link is emailed to it. The link alone changes nothing: you will also need a code from your authenticator app, or one of your recovery codes.
          </AppText>
          <TextField
            tone="navy"
            label="Email address"
            value={email}
            onChangeText={(text) => {
              setEmail(text);
              setFieldError({});
            }}
            error={fieldError.email}
            keyboardType="email-address"
            inputMode="email"
            autoCapitalize="none"
            autoCorrect={false}
            autoComplete="username"
            returnKeyType="go"
            onSubmitEditing={ask.run}
            placeholder="name@company.com"
            maxLength={254}
            testID="reset-email"
          />
          <Button label="Email me a link" onPress={ask.run} loading={ask.busy} testID="reset-request" />
          <Button label="I have a code from the email" variant="onDark" onPress={() => setStage({ name: 'link' })} testID="reset-have-code" />
        </View>
      ) : null}

      {selfService && stage.name === 'requested' ? (
        <View style={styles.block}>
          <InlineMessage tone="info">{RESET_REQUESTED}</InlineMessage>
          <AppText tone="onDarkMuted">Open the link on this device, or type the code from it here.</AppText>
          <Button label="I have the code" onPress={() => setStage({ name: 'link' })} testID="reset-have-code" />
        </View>
      ) : null}

      {selfService && stage.name === 'link' ? (
        <View style={styles.block}>
          <TextField
            tone="navy"
            label="Code from the email"
            value={resetCode}
            onChangeText={(text) => {
              setResetCode(text);
              setFieldError({});
            }}
            error={fieldError.resetCode}
            autoCapitalize="characters"
            autoCorrect={false}
            autoComplete="off"
            returnKeyType="go"
            onSubmitEditing={open.run}
            maxLength={64}
            testID="reset-code"
          />
          <Button label="Continue" onPress={open.run} loading={open.busy} testID="reset-open" />
          <Button label="Ask for a new link" variant="onDark" onPress={() => setStage({ name: 'request' })} />
        </View>
      ) : null}

      {selfService && stage.name === 'reset' ? (
        <View style={styles.block}>
          <AppText tone="onDarkMuted">
            {stage.method === 'totp'
              ? `Open your authenticator app and type the 6-digit code for ${APP_NAME}, then choose a new password.`
              : 'Type one of the recovery codes you saved when you set up your account (each works once), then choose a new password.'}
          </AppText>
          <TextField
            tone="navy"
            label={stage.method === 'totp' ? '6-digit code' : 'Recovery code'}
            value={code}
            onChangeText={(text) => {
              setCode(stage.method === 'totp' ? text.replace(/[^\d\s]/g, '') : text);
              setFieldError((current) => ({ ...current, code: undefined }));
            }}
            error={fieldError.code}
            keyboardType={stage.method === 'totp' ? 'number-pad' : 'default'}
            inputMode={stage.method === 'totp' ? 'numeric' : 'text'}
            autoCapitalize="characters"
            autoCorrect={false}
            autoComplete={stage.method === 'totp' ? 'one-time-code' : 'off'}
            maxLength={stage.method === 'totp' ? 7 : 32}
            testID="reset-second-factor"
          />
          <TextField
            tone="navy"
            label="New password"
            value={password}
            onChangeText={(text) => {
              setPassword(text);
              setFieldError((current) => ({ ...current, password: undefined }));
            }}
            hint={`At least ${stage.minLength} characters.`}
            secureTextEntry
            autoCapitalize="none"
            autoCorrect={false}
            autoComplete="new-password"
            maxLength={200}
            testID="reset-password"
          />
          <TextField
            tone="navy"
            label="New password again"
            value={repeat}
            onChangeText={(text) => {
              setRepeat(text);
              setFieldError((current) => ({ ...current, password: undefined }));
            }}
            error={fieldError.password}
            secureTextEntry
            autoCapitalize="none"
            autoCorrect={false}
            autoComplete="new-password"
            returnKeyType="go"
            onSubmitEditing={finish.run}
            maxLength={200}
            testID="reset-password-repeat"
          />
          <Button label="Set new password" onPress={finish.run} loading={finish.busy} testID="reset-finish" />
          <Button
            label={stage.method === 'totp' ? 'Use a recovery code' : 'Use my authenticator app'}
            variant="onDark"
            disabled={finish.busy}
            onPress={() => {
              setStage({ ...stage, method: stage.method === 'totp' ? 'recovery' : 'totp' });
              setCode('');
              setFieldError({});
            }}
            testID="reset-toggle-method"
          />
        </View>
      ) : null}

      {selfService && stage.name === 'done' ? (
        <View style={styles.block}>
          <InlineMessage tone="info">Your password has been changed. You have been signed out everywhere; your authenticator app and recovery codes are unchanged.</InlineMessage>
          <Button label="Sign in" onPress={() => router.replace('/sign-in')} testID="reset-sign-in" />
        </View>
      ) : null}

      {selfService && stage.name !== 'done' ? (
        <View style={styles.block}>
          <AppText variant="caption" tone="onDarkMuted" testID="reset-no-second-factor">
            {NO_SECOND_FACTOR}
          </AppText>
          <Button label="Back to sign-in" variant="onDark" onPress={() => router.replace('/sign-in')} testID="reset-back" />
        </View>
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  brand: { gap: spacing.md, marginTop: spacing.xxl },
  block: { gap: spacing.md },
});
