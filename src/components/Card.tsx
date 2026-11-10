import type { ReactNode } from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { colors, radii, spacing } from '@/theme';

export function Card({ children, style, padded = true }: { children: ReactNode; style?: StyleProp<ViewStyle>; padded?: boolean }) {
  return <View style={[styles.card, padded ? styles.padded : null, style]}>{children}</View>;
}

/** Hairline between rows inside a card. */
export function Divider() {
  return <View style={styles.divider} />;
}

const styles = StyleSheet.create({
  card: { backgroundColor: colors.card, borderRadius: radii.card, overflow: 'hidden' },
  padded: { padding: spacing.lg },
  divider: { height: StyleSheet.hairlineWidth, backgroundColor: colors.hairline, alignSelf: 'stretch' },
});
