import { Check } from 'lucide-react-native';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';

import { colors, radii, sizes, spacing } from '@/theme';

import { AppText } from './AppText';

export interface Option<T extends string | number> {
  value: T;
  label: string;
  accessibilityLabel?: string;
}

interface ChoiceProps<T extends string | number> {
  options: readonly Option<T>[];
  value: T;
  onChange: (value: T) => void;
  /** Read out as the name of the group, for example "Currency". */
  accessibilityLabel: string;
  disabled?: boolean;
}

/**
 * Horizontally scrolling single-choice chips. The selected chip is filled,
 * bold and carries a tick, so selection never relies on colour alone.
 */
export function ChipGroup<T extends string | number>({ options, value, onChange, accessibilityLabel, disabled }: ChoiceProps<T>) {
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      accessibilityRole="radiogroup"
      accessibilityLabel={accessibilityLabel}
      contentContainerStyle={styles.chips}
      keyboardShouldPersistTaps="handled"
    >
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <Pressable
            key={String(option.value)}
            accessibilityRole="radio"
            accessibilityLabel={option.accessibilityLabel ?? option.label}
            accessibilityState={{ selected, checked: selected, disabled }}
            disabled={disabled}
            onPress={() => onChange(option.value)}
            style={[styles.chip, selected ? styles.chipSelected : null]}
          >
            {selected ? <Check color={colors.tintText} size={16} strokeWidth={3} /> : null}
            <AppText variant={selected ? 'bodyStrong' : 'body'} tone={selected ? 'tint' : 'default'} maxFontSizeMultiplier={1.4}>
              {option.label}
            </AppText>
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

/** Two or three equal segments, for example Spot / Forward. */
export function SegmentedControl<T extends string | number>({ options, value, onChange, accessibilityLabel, disabled }: ChoiceProps<T>) {
  return (
    <View style={styles.segments} accessibilityRole="radiogroup" accessibilityLabel={accessibilityLabel}>
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <Pressable
            key={String(option.value)}
            accessibilityRole="radio"
            accessibilityLabel={option.accessibilityLabel ?? option.label}
            accessibilityState={{ selected, checked: selected, disabled }}
            disabled={disabled}
            onPress={() => onChange(option.value)}
            style={[styles.segment, selected ? styles.segmentSelected : null]}
          >
            {selected ? <Check color={colors.text} size={16} strokeWidth={3} /> : null}
            <AppText variant={selected ? 'bodyStrong' : 'body'} tone={selected ? 'default' : 'muted'} maxFontSizeMultiplier={1.3} numberOfLines={1}>
              {option.label}
            </AppText>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  chips: { gap: spacing.sm, paddingVertical: 2 },
  chip: {
    minHeight: sizes.touchTarget,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    paddingHorizontal: spacing.lg,
    borderRadius: radii.pill,
    backgroundColor: colors.card,
    borderWidth: 1.5,
    borderColor: colors.hairline,
  },
  chipSelected: { backgroundColor: colors.tint, borderColor: colors.tintText },
  segments: { flexDirection: 'row', backgroundColor: colors.hairline, borderRadius: radii.pill, padding: 4, gap: 4 },
  segment: {
    flex: 1,
    minHeight: sizes.touchTarget,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.xs,
    borderRadius: radii.pill,
    paddingHorizontal: spacing.sm,
  },
  segmentSelected: { backgroundColor: colors.card },
});
