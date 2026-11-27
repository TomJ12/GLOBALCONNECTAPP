import { useQuery, useQueryClient } from '@tanstack/react-query';
import * as Clipboard from 'expo-clipboard';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { getAuthClient } from '@/api';
import { toProviderError } from '@/api/errors';
import type { OwnSession } from '@/api/types';
import { AppText } from '@/components/AppText';
import { Button } from '@/components/Button';
import { Card } from '@/components/Card';
import { Header } from '@/components/Header';
import { Screen } from '@/components/Screen';
import { InlineMessage } from '@/components/StateViews';
import { TextField } from '@/components/TextField';
import { useSingleFlight } from '@/hooks/useSingleFlight';
import { formatDateTime } from '@/lib/dates';
import { useSession } from '@/state/session';
import { showToast } from '@/state/toast';
import { spacing } from '@/theme';

import { passwordProblem } from './ActivateScreen';

const codeProblem = (code: string): string | undefined => (/^\d{6}$/.test(code.replace(/\s/g, '')) ? undefined : 'Enter the 6-digit code from your authenticator app.');

/**
 * Your own security settings: change the password (current password AND a
 * code), make new recovery codes (a code), and see and end your signed-in
 * sessions. Nothing here can change or remove the authenticator.
 */
export function SecurityScreen() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const selfService = getAuthClient().selfService;
  const signOut = useSession((state) => state.signOut);
  const close = () => (router.canGoBack() ? router.back() : router.replace('/settings'));

  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [repeat, setRepeat] = useState('');
  const [code, setCode] = useState('');
  const [passwordErrors, setPasswordErrors] = useState<{ current?: string; next?: string; code?: string; general?: string }>({});
  const [passwordDone, setPasswordDone] = useState(false);

  const [recoveryCode, setRecoveryCode] = useState('');
  const [recoveryError, setRecoveryError] = useState<string | null>(null);
  const [newCodes, setNewCodes] = useState<string[] | null>(null);

  const sessions = useQuery({ queryKey: ['own-sessions'], queryFn: () => (selfService ? selfService.listSessions() : Promise.resolve([] as OwnSession[])), enabled: selfService !== null });
  const [sessionError, setSessionError] = useState<string | null>(null);

  const changePassword = useSingleFlight(async () => {
    setPasswordDone(false);
    const problems = {
      current: current === '' ? 'Enter your current password.' : undefined,
      next: passwordProblem(next, repeat, 12) ?? undefined,
      code: codeProblem(code),
    };
    setPasswordErrors(problems);
    if (problems.current || problems.next || problems.code) return;
    try {
      await selfService?.changePassword(current, code.replace(/\s/g, ''), next);
      setCurrent('');
      setNext('');
      setRepeat('');
      setCode('');
      setPasswordDone(true);
      void queryClient.invalidateQueries({ queryKey: ['own-sessions'] });
    } catch (caught) {
      const providerError = toProviderError(caught);
      setCode('');
      setPasswordErrors({ general: providerError.userMessage });
    }
  });

  const regenerate = useSingleFlight(async () => {
    setRecoveryError(null);
    const problem = codeProblem(recoveryCode);
    if (problem) {
      setRecoveryError(problem);
      return;
    }
    try {
      const codes = await selfService?.regenerateRecoveryCodes(recoveryCode.replace(/\s/g, ''));
      setRecoveryCode('');
      setNewCodes(codes ?? null);
    } catch (caught) {
      setRecoveryCode('');
      setRecoveryError(toProviderError(caught).userMessage);
    }
  });

  const end = useSingleFlight(async (session: OwnSession) => {
    setSessionError(null);
    try {
      await selfService?.endSession(session.id);
      if (session.current) {
        await signOut();
        router.replace('/sign-in');
        return;
      }
      await queryClient.invalidateQueries({ queryKey: ['own-sessions'] });
    } catch (caught) {
      setSessionError(toProviderError(caught).userMessage);
    }
  });

  if (!selfService) {
    return (
      <Screen header={<Header title="Security" leading="close" onLeadingPress={close} />}>
        <AppText tone="muted">This build is not connected to a server, so there is no account to manage.</AppText>
      </Screen>
    );
  }

  return (
    <Screen header={<Header title="Security" leading="close" onLeadingPress={close} />}>
      <Card>
        <View style={styles.block}>
          <AppText variant="title" accessibilityRole="header">
            Change password
          </AppText>
          <AppText tone="muted">Needs your current password and a code from your authenticator app. Your other signed-in sessions are signed out.</AppText>
          {passwordErrors.general ? <InlineMessage tone="danger">{passwordErrors.general}</InlineMessage> : null}
          {passwordDone ? <InlineMessage tone="info">Your password has been changed.</InlineMessage> : null}
          <TextField label="Current password" value={current} onChangeText={setCurrent} error={passwordErrors.current} secureTextEntry autoCapitalize="none" autoCorrect={false} autoComplete="current-password" maxLength={200} testID="security-current-password" />
          <TextField label="New password" value={next} onChangeText={setNext} hint="At least 12 characters." secureTextEntry autoCapitalize="none" autoCorrect={false} autoComplete="new-password" maxLength={200} testID="security-new-password" />
          <TextField label="New password again" value={repeat} onChangeText={setRepeat} error={passwordErrors.next} secureTextEntry autoCapitalize="none" autoCorrect={false} autoComplete="new-password" maxLength={200} testID="security-new-password-repeat" />
          <TextField label="6-digit code" value={code} onChangeText={(text) => setCode(text.replace(/[^\d\s]/g, ''))} error={passwordErrors.code} keyboardType="number-pad" inputMode="numeric" autoComplete="one-time-code" maxLength={7} testID="security-password-code" />
          <Button label="Change password" onPress={changePassword.run} loading={changePassword.busy} testID="security-change-password" />
        </View>
      </Card>

      <Card>
        <View style={styles.block}>
          <AppText variant="title" accessibilityRole="header">
            Recovery codes
          </AppText>
          <AppText tone="muted">Make a new set with a code from your authenticator app. The codes you have now stop working at once.</AppText>
          {recoveryError ? <InlineMessage tone="danger">{recoveryError}</InlineMessage> : null}
          {newCodes ? (
            <View style={styles.block} testID="security-new-codes">
              <InlineMessage tone="warning">These are shown only now. Each works once. Keep them somewhere other than this phone.</InlineMessage>
              {newCodes.map((item) => (
                <AppText key={item} selectable>
                  {item}
                </AppText>
              ))}
              <Button
                label="Copy codes"
                variant="secondary"
                onPress={() => {
                  void Clipboard.setStringAsync(newCodes.join('\n')).then(() => showToast('Recovery codes copied'));
                }}
                testID="security-copy-codes"
              />
              <Button label="I have saved them" variant="ghost" onPress={() => setNewCodes(null)} testID="security-codes-saved" />
            </View>
          ) : (
            <>
              <TextField label="6-digit code" value={recoveryCode} onChangeText={(text) => setRecoveryCode(text.replace(/[^\d\s]/g, ''))} keyboardType="number-pad" inputMode="numeric" autoComplete="one-time-code" maxLength={7} testID="security-recovery-code" />
              <Button label="Make new recovery codes" variant="secondary" onPress={regenerate.run} loading={regenerate.busy} testID="security-regenerate" />
            </>
          )}
        </View>
      </Card>

      <Card>
        <View style={styles.block}>
          <AppText variant="title" accessibilityRole="header">
            Where you are signed in
          </AppText>
          <AppText tone="muted">The kind of device and roughly when. End any you do not recognise, then change your password.</AppText>
          {sessionError ? <InlineMessage tone="danger">{sessionError}</InlineMessage> : null}
          {sessions.isError ? <InlineMessage tone="danger">{toProviderError(sessions.error).userMessage}</InlineMessage> : null}
          {(sessions.data ?? []).map((session) => (
            <View key={session.id} style={styles.session} testID={`session-${session.current ? 'current' : 'other'}`}>
              <View style={styles.sessionText}>
                <AppText variant="label">{session.current ? `${session.device} (this one)` : session.device}</AppText>
                <AppText variant="caption" tone="muted">{`Signed in about ${formatDateTime(session.signedInAt)}. Last active about ${formatDateTime(session.lastActiveAt)}.`}</AppText>
              </View>
              <Button label={session.current ? 'Sign out' : 'End'} variant="ghost" onPress={() => end.run(session)} disabled={end.busy} testID={`end-session-${session.current ? 'current' : 'other'}`} />
            </View>
          ))}
        </View>
      </Card>
      <AppText variant="caption" tone="muted">
        Your authenticator app cannot be changed here. If you have lost it and your recovery codes, contact Global Connect.
      </AppText>
    </Screen>
  );
}

const styles = StyleSheet.create({
  block: { gap: spacing.md },
  session: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  sessionText: { flex: 1, gap: spacing.xs },
});
