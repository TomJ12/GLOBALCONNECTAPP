import { useId, useState } from 'react';
import { StyleSheet, TextInput, View, type TextInputProps } from 'react-native';

import { colors, fonts, fontSizes, radii, sizes, spacing } from '@/theme';

import { AppText } from './AppText';

export interface TextFieldProps extends Omit<TextInputProps, 'style' | 'accessibilityLabel'> {
  label: string;
  error?: string | null;
  hint?: string;
  tone?: 'light' | 'navy';
}

/** A labelled text input. The label is always visible and is the accessible name. */
export function TextField({ label, error, hint, tone = 'light', editable = true, ...rest }: TextFieldProps) {
  const [focused, setFocused] = useState(false);
  const id = useId();
  const onDark = tone === 'navy';
  return (
    <View style={styles.field}>
      <AppText variant="label" tone={onDark ? 'onDarkMuted' : 'muted'} nativeID={`${id}-label`}>
        {label}
      </AppText>
      <TextInput
        {...rest}
        editable={editable}
        accessibilityLabel={label}
        accessibilityHint={error ?? hint}
        aria-invalid={error ? true : undefined}
        maxFontSizeMultiplier={1.4}
        placeholderTextColor={onDark ? colors.textOnDarkMuted : colors.textMuted}
        onFocus={(event) => {
          setFocused(true);
          rest.onFocus?.(event);
        }}
        onBlur={(event) => {
          setFocused(false);
          rest.onBlur?.(event);
        }}
        style={[
          styles.input,
          onDark ? styles.inputDark : null,
          focused ? styles.focused : null,
          error ? styles.invalid : null,
          editable ? null : styles.readOnly,
        ]}
      />
      {error ? (
        <AppText variant="label" tone={onDark ? 'onDark' : 'danger'} accessibilityRole="alert" accessibilityLiveRegion="polite">
          {`Error: ${error}`}
        </AppText>
      ) : hint ? (
        <AppText variant="caption" tone={onDark ? 'onDarkMuted' : 'muted'}>
          {hint}
        </AppText>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  field: { gap: spacing.xs },
  input: {
    minHeight: sizes.buttonHeight,
    borderRadius: radii.md,
    borderWidth: 1.5,
    borderColor: colors.hairline,
    backgroundColor: colors.card,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    fontFamily: fonts.regular,
    fontSize: fontSizes.bodyLarge,
    color: colors.text,
  },
  inputDark: { backgroundColor: colors.navyRaised, borderColor: colors.navyBorder, color: colors.textOnDark },
  focused: { borderColor: colors.primary },
  invalid: { borderColor: colors.danger, borderWidth: 2 },
  readOnly: { opacity: 0.7 },
});
