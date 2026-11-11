import { Check, ChevronDown } from 'lucide-react-native';
import { useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, View } from 'react-native';

import { currencyName } from '@/lib/money';
import { colors, radii, sizes, spacing } from '@/theme';

import { AppText } from './AppText';
import { Divider } from './Card';

export interface PickerOption {
  value: string;
  label: string;
  detail?: string;
}

export interface OptionPickerProps {
  /** Accessible name, for example "You sell currency". */
  label: string;
  value: string;
  options: readonly PickerOption[];
  onChange: (value: string) => void;
  /** Text on the closed button. Defaults to the selected option's label. */
  buttonText?: string;
  wide?: boolean;
  disabled?: boolean;
}

/** A button that opens a short list to choose from. */
export function OptionPicker({ label, value, options, onChange, buttonText, wide = false, disabled = false }: OptionPickerProps) {
  const [open, setOpen] = useState(false);
  const selected = options.find((option) => option.value === value);
  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${label}: ${selected?.label ?? value}. Change`}
        accessibilityState={{ disabled }}
        disabled={disabled}
        onPress={() => setOpen(true)}
        style={({ pressed }) => [styles.button, wide ? styles.buttonWide : null, pressed || disabled ? styles.pressed : null]}
      >
        <AppText variant="bodyStrong" maxFontSizeMultiplier={1.3} style={wide ? styles.grow : null} numberOfLines={1}>
          {buttonText ?? selected?.label ?? value}
        </AppText>
        <ChevronDown color={colors.text} size={18} />
      </Pressable>
      <Modal visible={open && !disabled} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
        <Pressable style={styles.backdrop} onPress={() => setOpen(false)} accessibilityLabel="Close list" accessibilityRole="button">
          <Pressable style={styles.sheet} onPress={() => undefined} accessible={false}>
            <AppText variant="title" accessibilityRole="header" style={styles.sheetTitle}>
              {label}
            </AppText>
            <ScrollView accessibilityRole="radiogroup" accessibilityLabel={label}>
              {options.map((option, index) => {
                const isSelected = option.value === value;
                return (
                  <View key={option.value}>
                    {index > 0 ? <Divider /> : null}
                    <Pressable
                      accessibilityRole="radio"
                      accessibilityLabel={option.detail ? `${option.label}, ${option.detail}` : option.label}
                      accessibilityState={{ selected: isSelected, checked: isSelected }}
                      onPress={() => {
                        setOpen(false);
                        if (option.value !== value) onChange(option.value);
                      }}
                      style={({ pressed }) => [styles.option, pressed ? styles.pressed : null]}
                    >
                      <View style={styles.grow}>
                        <AppText variant={isSelected ? 'bodyStrong' : 'body'}>{option.label}</AppText>
                        {option.detail ? (
                          <AppText variant="caption" tone="muted">
                            {option.detail}
                          </AppText>
                        ) : null}
                      </View>
                      {isSelected ? <Check color={colors.primary} size={20} strokeWidth={3} /> : null}
                    </Pressable>
                  </View>
                );
              })}
            </ScrollView>
          </Pressable>
        </Pressable>
      </Modal>
    </>
  );
}

export function CurrencyPicker({
  label,
  value,
  options,
  onChange,
  disabled,
}: {
  label: string;
  value: string;
  options: readonly string[];
  onChange: (currency: string) => void;
  disabled?: boolean;
}) {
  return (
    <OptionPicker
      label={label}
      value={value}
      onChange={onChange}
      disabled={disabled}
      options={options.map((currency) => ({ value: currency, label: currency, detail: currencyName(currency) }))}
    />
  );
}

const styles = StyleSheet.create({
  button: {
    minHeight: sizes.touchTarget,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    paddingHorizontal: spacing.md,
    borderRadius: radii.pill,
    backgroundColor: colors.background,
    borderWidth: 1,
    borderColor: colors.hairline,
  },
  buttonWide: { alignSelf: 'stretch', minHeight: sizes.buttonHeight, borderRadius: radii.md, backgroundColor: colors.card, borderWidth: 1.5, paddingHorizontal: spacing.lg },
  pressed: { opacity: 0.6 },
  backdrop: { flex: 1, backgroundColor: colors.overlay, justifyContent: 'center', padding: spacing.xl },
  sheet: {
    backgroundColor: colors.card,
    borderRadius: radii.card,
    paddingVertical: spacing.md,
    maxHeight: '80%',
    width: '100%',
    maxWidth: 420,
    alignSelf: 'center',
  },
  sheetTitle: { paddingHorizontal: spacing.lg, paddingBottom: spacing.sm },
  option: { minHeight: sizes.buttonHeight, flexDirection: 'row', alignItems: 'center', paddingHorizontal: spacing.lg, paddingVertical: spacing.sm, gap: spacing.md },
  grow: { flex: 1 },
});
