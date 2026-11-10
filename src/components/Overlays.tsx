import { useEffect } from 'react';
import { Modal, StyleSheet, View } from 'react-native';

import { useConfirmStore } from '@/state/confirm';
import { useToastStore } from '@/state/toast';
import { colors, radii, spacing } from '@/theme';

import { AppText } from './AppText';
import { Button } from './Button';

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
