import type { ReactNode } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { colors, fonts, fontSizes, radii, sizes, spacing } from '@/theme';

import { AppText } from './AppText';

export type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'ghost' | 'onDark';

export interface ButtonProps {
  label: string;
  onPress: () => void;
  variant?: ButtonVariant;
  disabled?: boolean;
  /** Shows a spinner and blocks presses. */
  loading?: boolean;
  icon?: ReactNode;
  accessibilityLabel?: string;
  accessibilityHint?: string;
  testID?: string;
  style?: StyleProp<ViewStyle>;
}

const BACKGROUND: Record<ButtonVariant, { rest: string; pressed: string }> = {
  primary: { rest: colors.primary, pressed: colors.primaryPressed },
  secondary: { rest: colors.tint, pressed: '#BFDBFE' },
  danger: { rest: colors.card, pressed: colors.dangerBg },
  ghost: { rest: 'transparent', pressed: colors.hairline },
  onDark: { rest: colors.navyRaised, pressed: colors.navyBorder },
};

const FOREGROUND: Record<ButtonVariant, string> = {
  primary: colors.textOnDark,
  secondary: colors.tintText,
  danger: colors.danger,
  ghost: colors.primaryPressed,
  onDark: colors.textOnDark,
};

/** Full-width pill button, 54 high. One primary button per screen. */
export function Button({
  label,
  onPress,
  variant = 'primary',
  disabled = false,
  loading = false,
  icon,
  accessibilityLabel,
  accessibilityHint,
  testID,
  style,
}: ButtonProps) {
  const blocked = disabled || loading;
  const foreground = disabled ? colors.disabledText : FOREGROUND[variant];
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled: blocked, busy: loading }}
      disabled={blocked}
      onPress={onPress}
      testID={testID}
      style={({ pressed }) => [
        styles.base,
        { backgroundColor: disabled ? colors.disabledBg : pressed ? BACKGROUND[variant].pressed : BACKGROUND[variant].rest },
        variant === 'danger' && !disabled ? styles.dangerBorder : null,
        variant === 'onDark' && !disabled ? styles.onDarkBorder : null,
        style,
      ]}
    >
      {loading ? (
        <ActivityIndicator color={foreground} />
      ) : (
        <View style={styles.content}>
          {icon}
          <AppText style={[styles.label, { color: foreground }]} maxFontSizeMultiplier={1.4} numberOfLines={2}>
            {label}
          </AppText>
        </View>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: {
    minHeight: sizes.buttonHeight,
    borderRadius: radii.pill,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.sm,
    alignSelf: 'stretch',
  },
  content: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: spacing.sm },
  label: { fontFamily: fonts.semibold, fontSize: fontSizes.bodyLarge, lineHeight: 22, textAlign: 'center', flexShrink: 1 },
  dangerBorder: { borderWidth: 1.5, borderColor: colors.danger },
  onDarkBorder: { borderWidth: 1, borderColor: colors.navyBorder },
});
