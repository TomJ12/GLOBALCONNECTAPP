import { useRouter } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { getAuthClient } from '@/api';
import { toProviderError } from '@/api/errors';
import { AppText } from '@/components/AppText';
import { BrandLockup } from '@/components/BrandLockup';
import { Button } from '@/components/Button';
import { Screen } from '@/components/Screen';
import { InlineMessage } from '@/components/StateViews';
import { APP_NAME } from '@/config/app';
import { disclosures } from '@/config/disclosures';
import { useSingleFlight } from '@/hooks/useSingleFlight';
import { takeTokenFromAddressBar } from '@/lib/activationLink';
import { spacing } from '@/theme';

/** Said after pressing the button, whatever the link was: it must not reveal whether a reset existed. */
export const CANCEL_RESET_DONE = `If a reset of the authenticator was waiting for your account, it has been cancelled, and an email will confirm that. Nothing else was changed. If you did not ask for the reset, tell ${APP_NAME}: ${disclosures.contactSupport}`;

/**
 * "This was not me." Opened from the link in the email that warns of a reset of the authenticator. The link can do
 * one thing: cancel that reset. It does not sign anyone in. Nothing happens until the button is pressed, so a
 * mail scanner that merely opens the link cancels nothing.
 */
export function CancelResetScreen() {
  const router = useRouter();
  const selfService = getAuthClient().selfService;
  // From the link: after "#" (never sent to a server). Taken out of the address bar the moment it is read.
  const [token] = useState(() => takeTokenFromAddressBar());
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const cancel = useSingleFlight(async () => {
    setError(null);
    try {
      await selfService?.cancelAuthenticatorReset(token);
      setDone(true);
    } catch (caught) {
      setError(toProviderError(caught).userMessage);
    }
  });

  return (
    <Screen tone="navy">
      <View style={styles.brand}>
        <BrandLockup />
        <AppText variant="heading" tone="onDark" accessibilityRole="header">
          Cancel the reset of your authenticator
        </AppText>
      </View>
      {error ? <InlineMessage tone="danger">{error}</InlineMessage> : null}
      {!selfService || !token ? (
        <View style={styles.block}>
          <AppText tone="onDarkMuted">Open the link from the email again on this device. This page works only from that link.</AppText>
        </View>
      ) : done ? (
        <View style={styles.block}>
          <InlineMessage tone="info">{CANCEL_RESET_DONE}</InlineMessage>
        </View>
      ) : (
        <View style={styles.block}>
          <AppText tone="onDarkMuted">
            The email you came from says that a reset of the authenticator on your account has been approved. If you did not ask for it, cancel it here. This only cancels the reset: it does not sign you in and changes nothing else.
          </AppText>
          <Button label="Cancel the reset" onPress={cancel.run} loading={cancel.busy} testID="cancel-reset-confirm" />
        </View>
      )}
      <Button label="Go to sign in" variant="onDark" onPress={() => router.replace('/sign-in')} testID="cancel-reset-sign-in" />
    </Screen>
  );
}

const styles = StyleSheet.create({
  brand: { gap: spacing.md, marginTop: spacing.xxl },
  block: { gap: spacing.md },
});
