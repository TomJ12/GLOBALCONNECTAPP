import { StyleSheet, View, type DimensionValue, type StyleProp, type ViewStyle } from 'react-native';

import { colors, radii, spacing } from '@/theme';

import { Card } from './Card';

export function SkeletonBlock({ width = '100%', height = 16, style }: { width?: DimensionValue; height?: number; style?: StyleProp<ViewStyle> }) {
  return <View style={[styles.block, { width, height }, style]} />;
}

/** Placeholder rows shown while a list loads. Announced once as "Loading". */
export function SkeletonList({ rows = 3, label = 'Loading' }: { rows?: number; label?: string }) {
  return (
    <View accessible accessibilityRole="progressbar" accessibilityLabel={label} accessibilityState={{ busy: true }}>
      <Card style={styles.list}>
        {Array.from({ length: rows }, (_, index) => (
          <View key={index} style={styles.row}>
            <SkeletonBlock width={40} height={40} style={styles.circle} />
            <View style={styles.lines}>
              <SkeletonBlock width="60%" />
              <SkeletonBlock width="35%" height={12} />
            </View>
            <SkeletonBlock width={72} />
          </View>
        ))}
      </Card>
    </View>
  );
}

/** Placeholder for a headline card (balance, total). */
export function SkeletonCard({ label = 'Loading', height = 96 }: { label?: string; height?: number }) {
  return (
    <View accessible accessibilityRole="progressbar" accessibilityLabel={label} accessibilityState={{ busy: true }}>
      <Card style={[styles.card, { minHeight: height }]}>
        <SkeletonBlock width="45%" height={12} />
        <SkeletonBlock width="70%" height={32} />
        <SkeletonBlock width="55%" height={12} />
      </Card>
    </View>
  );
}

const styles = StyleSheet.create({
  block: { backgroundColor: colors.skeleton, borderRadius: radii.sm },
  list: { gap: spacing.lg },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  circle: { borderRadius: 20 },
  lines: { flex: 1, gap: spacing.sm },
  card: { gap: spacing.md, justifyContent: 'center' },
});
