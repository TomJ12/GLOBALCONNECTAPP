import { Image, StyleSheet, View } from 'react-native';

import { AppText } from '@/components/AppText';
import { APP_NAME } from '@/config/app';
import { spacing } from '@/theme';

const MARK_ON_DARK = require('../../assets/images/logo-mark-white.png');

/** Logo mark and company name, for navy screens (sign-in, activation). */
export function BrandLockup() {
  return (
    <View style={styles.row} accessible accessibilityRole="image" accessibilityLabel={APP_NAME}>
      <Image source={MARK_ON_DARK} style={styles.mark} resizeMode="contain" />
      <AppText variant="label" tone="onDark" style={styles.wordmark}>
        {APP_NAME.toUpperCase()}
      </AppText>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  // The mark is 419 x 460; keep that ratio so it is never stretched.
  mark: { width: 40, height: 44 },
  wordmark: { letterSpacing: 2 },
});
