import { useEffect, useState } from 'react';
import { Modal, StyleSheet, View } from 'react-native';

import { getAuthClient } from '@/api';
import { toProviderError } from '@/api/errors';
import { useSingleFlight } from '@/hooks/useSingleFlight';
import { useConfirmStore } from '@/state/confirm';
import { useSession } from '@/state/session';
import { useStepUpStore } from '@/state/stepUp';
import { useToastStore } from '@/state/toast';
import { colors, radii, spacing } from '@/theme';

import { AppText } from './AppText';
import { Button } from './Button';
import { TextField } from './TextField';

/** Renders the in-app confirm dialog. Mount once, at the root. */
export function ConfirmDialogHost() {
  const current = useConfirmStore((state) => state.current);
  const settle = useConfirmStore((state) => state.settle);
  return (
    <Modal visible={current !== null} transparent animationType="fade" onRequestClose={() => settle(false)}>
      <View style={styles.backdrop}>
        {current ? (
          <View style={styles.dialog} accessibilityViewIsModal accessibilityRole="alert">
            <AppText variant="title" accessibilityRole="header">
              {current.title}
            </AppText>
            <AppText tone="muted">{current.message}</AppText>
            <View style={styles.actions}>
              <Button
                label={current.confirmLabel}
                variant={current.tone === 'danger' ? 'danger' : 'primary'}
                onPress={() => settle(true)}
                testID="confirm-dialog-confirm"
              />
              <Button label={current.cancelLabel ?? 'Cancel'} variant="ghost" onPress={() => settle(false)} testID="confirm-dialog-cancel" />
            </View>
          </View>
        ) : null}
      </View>
    </Modal>
  );
}

/**
 * Asks for a 6-digit authenticator code before a money action is sent. Stays
 * open on a wrong, reused or locked-out code so the person can try again.
 * Mount once, at the root.
 */
export function StepUpDialogHost() {
  const current = useStepUpStore((state) => state.current);
  const settle = useStepUpStore((state) => state.settle);
  return (
    <Modal visible={current !== null} transparent animationType="fade" onRequestClose={() => settle(false)}>
      <View style={styles.backdrop}>{current ? <StepUpDialog key={current.id} /> : null}</View>
    </Modal>
  );
}

/** One request for a code. Keyed by request, so each starts with an empty field and no error. */
function StepUpDialog() {
  const current = useStepUpStore((state) => state.current);
  const settle = useStepUpStore((state) => state.settle);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);

  const submit = useSingleFlight(async () => {
    if (!current) return;
    const digits = code.replace(/\s/g, '');
    if (!/^\d{6}$/.test(digits)) {
      setError('Enter the 6-digit code from your authenticator app.');
      return;
    }
    setError(null);
    try {
      await current.authorize(digits);
      settle(true);
    } catch (caught) {
      const providerError = toProviderError(caught);
      if (providerError.kind === 'unauthorized') {
        // The session ended while the dialog was open. Nothing was sent.
        settle(false);
        void useSession.getState().signOut('expired');
        return;
      }
      setCode('');
      setError(providerError.userMessage);
    }
  });

  const sampleCode = current ? getAuthClient().sampleCode : null;
  if (!current) return null;
  return (
    <View style={styles.dialog} accessibilityViewIsModal>
      <AppText variant="title" accessibilityRole="header">
        Enter your authenticator code
      </AppText>
      <AppText tone="muted">{current.summary}</AppText>
      <TextField
        label="6-digit code"
        value={code}
        onChangeText={(text) => {
          setCode(text.replace(/[^\d\s]/g, ''));
          if (error) setError(null);
        }}
        error={error}
        hint={sampleCode ? `Sample data: the code is ${sampleCode}.` : 'Open your authenticator app and type the current code.'}
        keyboardType="number-pad"
        inputMode="numeric"
        autoComplete="one-time-code"
        textContentType="oneTimeCode"
        maxLength={7}
        autoFocus
        returnKeyType="done"
        onSubmitEditing={submit.run}
        testID="step-up-code"
      />
      <View style={styles.actions}>
        <Button label="Confirm with code" onPress={submit.run} loading={submit.busy} testID="step-up-confirm" />
        <Button label="Cancel" variant="ghost" onPress={() => settle(false)} disabled={submit.busy} testID="step-up-cancel" />
      </View>
    </View>
  );
}

const TOAST_MS = 2500;

/** Renders short confirmations such as "Copied". Mount once, at the root. */
export function ToastHost() {
  const message = useToastStore((state) => state.message);
  const id = useToastStore((state) => state.id);
  const hide = useToastStore((state) => state.hide);
  useEffect(() => {
    if (message === null) return;
    const timer = setTimeout(() => hide(id), TOAST_MS);
    return () => clearTimeout(timer);
  }, [message, id, hide]);
  if (message === null) return null;
  return (
    <View style={styles.toastWrap} pointerEvents="none">
      <View style={styles.toast} accessibilityRole="alert" accessibilityLiveRegion="polite">
        <AppText variant="bodyStrong" tone="onDark" align="center">
          {message}
        </AppText>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: colors.overlay, alignItems: 'center', justifyContent: 'center', padding: spacing.xl },
  dialog: { backgroundColor: colors.card, borderRadius: radii.card, padding: spacing.xl, gap: spacing.md, width: '100%', maxWidth: 420 },
  actions: { gap: spacing.sm, marginTop: spacing.sm },
  toastWrap: { position: 'absolute', left: 0, right: 0, bottom: 96, alignItems: 'center', paddingHorizontal: spacing.xl },
  toast: { backgroundColor: colors.navy, borderRadius: radii.pill, paddingHorizontal: spacing.xl, paddingVertical: spacing.md, maxWidth: 420 },
});
