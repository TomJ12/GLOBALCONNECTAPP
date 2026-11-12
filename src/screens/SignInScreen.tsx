import { useRouter } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { getAuthClient } from '@/api';
import { toProviderError } from '@/api/errors';
import type { CodeMethod, CompanyOption } from '@/api/types';
import { AppText } from '@/components/AppText';
import { Button } from '@/components/Button';
import { Screen } from '@/components/Screen';
import { InlineMessage } from '@/components/StateViews';
import { TextField } from '@/components/TextField';
import { APP_NAME } from '@/config/app';
import { disclosures } from '@/config/disclosures';
import { useCompleteSignIn, useSelectCompany, useSignIn } from '@/hooks/queries';
import { useSingleFlight } from '@/hooks/useSingleFlight';
import { isValidEmail } from '@/lib/validation';
import { useSession, type SignedOutReason } from '@/state/session';
import { colors, radii, spacing } from '@/theme';

/** Wording for a failed sign-in step. Never says whether an email address has an account. */
export function signInErrorMessage(error: unknown): string {
  const providerError = toProviderError(error);
  // A session that ended between the code and the company choice.
  if (providerError.kind === 'unauthorized') return 'That took too long. Start again.';
  return providerError.userMessage;
}

const SIGNED_OUT_MESSAGES: Record<Exclude<SignedOutReason, null>, string> = {
  expired: 'Your session ended. Sign in again to continue.',
  inactive: 'You were signed out because the app was in the background for a while.',
};

type Stage = { name: 'credentials' } | { name: 'code'; challengeId: string; method: CodeMethod } | { name: 'company'; companies: CompanyOption[] };

/**
 * Sign-in: email and password, then a code from the authenticator app (or a
 * one-time recovery code), then a company if the person has several. Nothing
 * is kept on the device between sessions.
 */
export function SignInScreen() {
  const router = useRouter();
  const signedOutReason = useSession((state) => state.signedOutReason);
  const startSession = useSession((state) => state.startSession);
  const signIn = useSignIn();
  const completeSignIn = useCompleteSignIn();
  const selectCompany = useSelectCompany();
  const sampleCode = getAuthClient().sampleCode;

  const [stage, setStage] = useState<Stage>({ name: 'credentials' });
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [fieldErrors, setFieldErrors] = useState<{ email?: string; password?: string; code?: string }>({});
  const [error, setError] = useState<string | null>(null);

  const startAgain = () => {
    setStage({ name: 'credentials' });
    setPassword('');
    setCode('');
    setError(null);
    setFieldErrors({});
  };

  const submitCredentials = useSingleFlight(async () => {
    setError(null);
    const trimmed = email.trim();
    const problems = {
      email: isValidEmail(trimmed) ? undefined : 'Enter a valid email address, like name@company.com.',
      password: password === '' ? 'Enter your password.' : undefined,
    };
    setFieldErrors(problems);
    if (problems.email || problems.password) return;
    try {
      const challenge = await signIn.mutateAsync({ email: trimmed, password });
      // The password is not needed again. Do not keep it in memory.
      setPassword('');
      setCode('');
      setStage({ name: 'code', challengeId: challenge.challengeId, method: 'totp' });
    } catch (caught) {
      setError(signInErrorMessage(caught));
    }
  });

  const submitCode = useSingleFlight(async () => {
    if (stage.name !== 'code') return;
    setError(null);
    const value = code.trim();
    const valid = stage.method === 'totp' ? /^\d{6}$/.test(value.replace(/\s/g, '')) : value.length >= 8;
    if (!valid) {
      setFieldErrors({ code: stage.method === 'totp' ? 'Enter the 6-digit code from your authenticator app.' : 'Enter one of your recovery codes.' });
      return;
    }
    setFieldErrors({});
    try {
      const result = await completeSignIn.mutateAsync({ challengeId: stage.challengeId, code: value.replace(/\s/g, ''), method: stage.method });
      if (result.session) startSession(result.session);
      else if (result.companies.length === 0) {
        setError('Your sign-in is not linked to a company yet. Contact Global Connect.');
        void getAuthClient().signOut();
        setStage({ name: 'credentials' });
      } else setStage({ name: 'company', companies: result.companies });
    } catch (caught) {
      const providerError = toProviderError(caught);
      setCode('');
      // The sign-in attempt itself has run out: the password is needed again.
      if (providerError.reason === 'challenge_expired') startAgain();
      setError(signInErrorMessage(caught));
    }
  });

  const choose = useSingleFlight(async (companyId: string) => {
    setError(null);
    try {
      startSession(await selectCompany.mutateAsync(companyId));
    } catch (caught) {
      if (toProviderError(caught).kind === 'unauthorized') startAgain();
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
          {disclosures.signInTagline}
        </AppText>
      </View>

      {signedOutReason && stage.name === 'credentials' ? <InlineMessage tone="warning">{SIGNED_OUT_MESSAGES[signedOutReason]}</InlineMessage> : null}
      {error ? <InlineMessage tone="danger">{error}</InlineMessage> : null}

      {stage.name === 'credentials' ? (
        <View style={styles.block}>
          <TextField
            tone="navy"
            label="Email address"
            value={email}
            onChangeText={(text) => {
              setEmail(text);
              if (fieldErrors.email) setFieldErrors((current) => ({ ...current, email: undefined }));
            }}
            error={fieldErrors.email}
            keyboardType="email-address"
            inputMode="email"
            autoCapitalize="none"
            autoCorrect={false}
            autoComplete="username"
            textContentType="username"
            returnKeyType="next"
            placeholder="name@company.com"
            maxLength={254}
            testID="sign-in-email"
          />
          <TextField
            tone="navy"
            label="Password"
            value={password}
            onChangeText={(text) => {
              setPassword(text);
              if (fieldErrors.password) setFieldErrors((current) => ({ ...current, password: undefined }));
            }}
            error={fieldErrors.password}
            secureTextEntry
            autoCapitalize="none"
            autoCorrect={false}
            autoComplete="current-password"
            textContentType="password"
            returnKeyType="go"
            onSubmitEditing={submitCredentials.run}
            maxLength={200}
            testID="sign-in-password"
          />
          <Button label="Continue" onPress={submitCredentials.run} loading={submitCredentials.busy} testID="sign-in-continue" />
          {sampleCode ? (
            <View style={styles.devCard}>
              <AppText variant="label" tone="onDark">
                Sample data
              </AppText>
              <AppText variant="caption" tone="onDarkMuted">
                {`This build is not connected to a server. Any email and password are accepted, and the code is ${sampleCode}.`}
              </AppText>
            </View>
          ) : null}
          <Button label="Activate a new account" variant="onDark" onPress={() => router.push('/activate')} testID="go-activate" />
        </View>
      ) : null}

      {stage.name === 'code' ? (
        <View style={styles.block}>
          <AppText variant="title" tone="onDark" accessibilityRole="header">
            {stage.method === 'totp' ? 'Enter your code' : 'Use a recovery code'}
          </AppText>
          <AppText tone="onDarkMuted">
            {stage.method === 'totp'
              ? `Open your authenticator app and type the 6-digit code for ${APP_NAME}.`
              : 'Type one of the recovery codes you saved when you set up your account. Each code works once.'}
          </AppText>
          <TextField
            tone="navy"
            label={stage.method === 'totp' ? '6-digit code' : 'Recovery code'}
            value={code}
            onChangeText={(text) => {
              setCode(stage.method === 'totp' ? text.replace(/[^\d\s]/g, '') : text);
              if (fieldErrors.code) setFieldErrors({});
            }}
            error={fieldErrors.code}
            hint={sampleCode && stage.method === 'totp' ? `Sample data: the code is ${sampleCode}.` : undefined}
            keyboardType={stage.method === 'totp' ? 'number-pad' : 'default'}
            inputMode={stage.method === 'totp' ? 'numeric' : 'text'}
            autoCapitalize="characters"
            autoCorrect={false}
            autoComplete={stage.method === 'totp' ? 'one-time-code' : 'off'}
            textContentType={stage.method === 'totp' ? 'oneTimeCode' : 'none'}
            returnKeyType="go"
            onSubmitEditing={submitCode.run}
            maxLength={stage.method === 'totp' ? 7 : 32}
            autoFocus
            testID="sign-in-code"
          />
          <Button label="Sign in" onPress={submitCode.run} loading={submitCode.busy} testID="sign-in-verify" />
          <Button
            label={stage.method === 'totp' ? 'Use a recovery code' : 'Use my authenticator app'}
            variant="onDark"
            disabled={submitCode.busy}
            onPress={() => {
              setStage({ ...stage, method: stage.method === 'totp' ? 'recovery' : 'totp' });
              setCode('');
              setError(null);
              setFieldErrors({});
            }}
            testID="sign-in-toggle-method"
          />
          <Button label="Start again" variant="onDark" disabled={submitCode.busy} onPress={startAgain} />
        </View>
      ) : null}

      {stage.name === 'company' ? (
        <View style={styles.block}>
          <AppText variant="title" tone="onDark" accessibilityRole="header">
            Choose a company
          </AppText>
          <AppText tone="onDarkMuted">You can act for more than one company. Choose which one to open.</AppText>
          {stage.companies.map((company) => (
            <Button
              key={company.id}
              label={company.name}
              variant="onDark"
              onPress={() => choose.run(company.id)}
              disabled={choose.busy}
              testID={`company-${company.id}`}
            />
          ))}
          <Button
            label="Sign out"
            variant="onDark"
            disabled={choose.busy}
            onPress={() => {
              void getAuthClient().signOut();
              startAgain();
            }}
          />
        </View>
      ) : null}

      <View style={styles.footer}>
        <AppText variant="caption" tone="onDarkMuted">{`New to ${APP_NAME}? ${disclosures.openAccount}`}</AppText>
        <AppText variant="caption" tone="onDarkMuted">
          {disclosures.signInAssurance}
        </AppText>
        <AppText variant="caption" tone="onDarkMuted">
          {disclosures.regulatoryFooter}
        </AppText>
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
});
