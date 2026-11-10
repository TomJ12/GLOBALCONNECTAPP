import * as Clipboard from 'expo-clipboard';
import { ChevronRight, Copy } from 'lucide-react-native';
import type { ReactNode } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { showToast } from '@/state/toast';
import { colors, radii, sizes, spacing } from '@/theme';

import { AppText, type TextTone } from './AppText';

/** Initials in a circle. */
export function Avatar({ name, size = 40 }: { name: string; size?: number }) {
  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word.charAt(0).toUpperCase())
    .join('');
  return (
    <View style={[styles.avatar, { width: size, height: size, borderRadius: size / 2 }]} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      <AppText variant="bodyStrong" tone="tint" maxFontSizeMultiplier={1}>
        {initials || '?'}
      </AppText>
    </View>
  );
}

/** Round icon holder used in activity rows and quick actions. */
export function IconCircle({ children, tone = 'tint', size = 40 }: { children: ReactNode; tone?: 'tint' | 'positive' | 'neutral' | 'warning'; size?: number }) {
  const backgroundColor =
    tone === 'positive' ? colors.positiveBg : tone === 'neutral' ? colors.background : tone === 'warning' ? colors.warningBg : colors.tint;
  return <View style={[styles.avatar, { width: size, height: size, borderRadius: size / 2, backgroundColor }]}>{children}</View>;
}

export type PillTone = 'tint' | 'positive' | 'warning' | 'neutral' | 'danger';

const PILL: Record<PillTone, { bg: string; fg: TextTone; border?: string }> = {
  tint: { bg: colors.tint, fg: 'tint' },
  positive: { bg: colors.positiveBg, fg: 'positive' },
  warning: { bg: colors.warningBg, fg: 'warning', border: colors.warningBorder },
  neutral: { bg: colors.background, fg: 'muted', border: colors.hairline },
  danger: { bg: colors.dangerBg, fg: 'danger' },
};

/** Small status label. Always text, so meaning never depends on its colour. */
export function Pill({ label, tone = 'tint' }: { label: string; tone?: PillTone }) {
  const palette = PILL[tone];
  return (
    <View style={[styles.pill, { backgroundColor: palette.bg }, palette.border ? { borderWidth: 1, borderColor: palette.border } : null]}>
      <AppText variant="label" tone={palette.fg} maxFontSizeMultiplier={1.3}>
        {label}
      </AppText>
    </View>
  );
}

/** Marks screens that are showing sample data. */
export function SampleDataPill() {
  return <Pill label="Sample data" tone="neutral" />;
}

export function SectionHeader({ title, action }: { title: string; action?: { label: string; onPress: () => void; accessibilityLabel?: string } }) {
  return (
    <View style={styles.sectionHeader}>
      <AppText variant="title" accessibilityRole="header" style={styles.grow}>
        {title}
      </AppText>
      {action ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={action.accessibilityLabel ?? action.label}
          onPress={action.onPress}
          hitSlop={8}
          style={({ pressed }) => [styles.sectionAction, pressed ? styles.pressed : null]}
        >
          <AppText variant="bodyStrong" tone="primary" style={styles.link}>
            {action.label}
          </AppText>
        </Pressable>
      ) : null}
    </View>
  );
}

export interface ListRowProps {
  leading?: ReactNode;
  title: string;
  subtitle?: string;
  trailing?: ReactNode;
  onPress?: () => void;
  accessibilityLabel?: string;
  accessibilityHint?: string;
  showChevron?: boolean;
  testID?: string;
}

/** A row in a list card. Pressable when `onPress` is given. */
export function ListRow({ leading, title, subtitle, trailing, onPress, accessibilityLabel, accessibilityHint, showChevron, testID }: ListRowProps) {
  const content = (
    <>
      {leading}
      <View style={styles.grow}>
        <AppText variant="bodyStrong">{title}</AppText>
        {subtitle ? (
          <AppText variant="caption" tone="muted">
            {subtitle}
          </AppText>
        ) : null}
      </View>
      {trailing}
      {showChevron ? <ChevronRight color={colors.textMuted} size={20} /> : null}
    </>
  );
  if (!onPress) {
    return (
      <View style={styles.row} accessible accessibilityLabel={accessibilityLabel} testID={testID}>
        {content}
      </View>
    );
  }
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityHint={accessibilityHint}
      onPress={onPress}
      testID={testID}
      style={({ pressed }) => [styles.row, pressed ? styles.rowPressed : null]}
    >
      {content}
    </Pressable>
  );
}

/** Label on the left (or above), value on the right. Used on review screens. */
export function DetailRow({ label, value, valueTone = 'default' }: { label: string; value: string; valueTone?: TextTone }) {
  return (
    <View style={styles.detailRow} accessible accessibilityLabel={`${label}: ${value}`}>
      <AppText tone="muted" style={styles.detailLabel}>
        {label}
      </AppText>
      <AppText variant="bodyStrong" tone={valueTone} style={styles.detailValue}>
        {value}
      </AppText>
    </View>
  );
}

/** A value with a copy button, for account details. */
export function CopyRow({ label, value, copyValue }: { label: string; value: string; copyValue?: string }) {
  const copy = async () => {
    try {
      await Clipboard.setStringAsync(copyValue ?? value);
      showToast(`${label} copied`);
    } catch {
      showToast('Could not copy. Select the text and copy it manually.');
    }
  };
  return (
    <View style={styles.row}>
      <View style={styles.grow} accessible accessibilityLabel={`${label}: ${value}`}>
        <AppText variant="caption" tone="muted">
          {label}
        </AppText>
        <AppText variant="bodyStrong" selectable>
          {value}
        </AppText>
      </View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Copy ${label}`}
        onPress={() => void copy()}
        hitSlop={6}
        style={({ pressed }) => [styles.copyButton, pressed ? styles.pressed : null]}
      >
        <Copy color={colors.tintText} size={20} />
      </Pressable>
    </View>
  );
}

/** Horizontal progress bar. `fraction` is 0 to 1; the caller supplies the spoken description. */
export function ProgressBar({ fraction, accessibilityLabel }: { fraction: number; accessibilityLabel: string }) {
  const clamped = Math.min(1, Math.max(0, Number.isFinite(fraction) ? fraction : 0));
  return (
    <View
      style={styles.progressTrack}
      accessible
      accessibilityRole="progressbar"
      accessibilityLabel={accessibilityLabel}
      accessibilityValue={{ min: 0, max: 100, now: Math.round(clamped * 100) }}
    >
      <View style={[styles.progressFill, { width: `${clamped * 100}%` }]} />
    </View>
  );
}

const styles = StyleSheet.create({
  avatar: { backgroundColor: colors.tint, alignItems: 'center', justifyContent: 'center' },
  pill: { alignSelf: 'flex-start', paddingHorizontal: spacing.md, paddingVertical: 3, borderRadius: radii.pill },
  sectionHeader: { flexDirection: 'row', alignItems: 'center', minHeight: sizes.touchTarget, gap: spacing.md },
  sectionAction: { minHeight: sizes.touchTarget, justifyContent: 'center' },
  link: { textDecorationLine: 'underline' },
  grow: { flex: 1, minWidth: 0 },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingHorizontal: spacing.lg, paddingVertical: spacing.md, minHeight: 64 },
  rowPressed: { backgroundColor: colors.background },
  pressed: { opacity: 0.6 },
  detailRow: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', gap: spacing.sm, paddingHorizontal: spacing.lg, paddingVertical: spacing.md },
  detailLabel: { flexShrink: 0 },
  detailValue: { flexShrink: 1, textAlign: 'right' },
  copyButton: { width: sizes.touchTarget, height: sizes.touchTarget, borderRadius: sizes.touchTarget / 2, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.tint },
  progressTrack: { height: 10, borderRadius: 5, backgroundColor: colors.hairline, overflow: 'hidden' },
  progressFill: { height: 10, borderRadius: 5, backgroundColor: colors.primary },
});
