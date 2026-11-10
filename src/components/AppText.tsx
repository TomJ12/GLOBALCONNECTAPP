import { Text, type TextProps, type TextStyle } from 'react-native';

import { colors, fonts, fontSizes } from '@/theme';

export type TextVariant =
  | 'caption'
  | 'body'
  | 'bodyStrong'
  | 'label'
  | 'title'
  | 'heading'
  | 'amount'
  | 'amountLarge';

const VARIANTS: Record<TextVariant, TextStyle> = {
  caption: { fontFamily: fonts.regular, fontSize: fontSizes.caption, lineHeight: 18 },
  body: { fontFamily: fonts.regular, fontSize: fontSizes.body, lineHeight: 22 },
  bodyStrong: { fontFamily: fonts.semibold, fontSize: fontSizes.body, lineHeight: 22 },
  label: { fontFamily: fonts.medium, fontSize: fontSizes.caption, lineHeight: 18 },
  title: { fontFamily: fonts.semibold, fontSize: fontSizes.bodyLarge, lineHeight: 24 },
  heading: { fontFamily: fonts.bold, fontSize: fontSizes.heading, lineHeight: 30 },
  amount: { fontFamily: fonts.bold, fontSize: fontSizes.amount, lineHeight: 40 },
  amountLarge: { fontFamily: fonts.bold, fontSize: fontSizes.amountLarge, lineHeight: 46 },
};

/** Large type is already big; let it grow less so it does not push layouts apart. */
const MAX_SCALE: Record<TextVariant, number> = {
  caption: 1.8,
  body: 1.8,
  bodyStrong: 1.8,
  label: 1.8,
  title: 1.6,
  heading: 1.4,
  amount: 1.25,
  amountLarge: 1.2,
};

export type TextTone = 'default' | 'muted' | 'onDark' | 'onDarkMuted' | 'primary' | 'positive' | 'danger' | 'warning' | 'tint';

const TONES: Record<TextTone, string> = {
  default: colors.text,
  muted: colors.textMuted,
  onDark: colors.textOnDark,
  onDarkMuted: colors.textOnDarkMuted,
  primary: colors.primary,
  positive: colors.positive,
  danger: colors.danger,
  warning: colors.warningAccent,
  tint: colors.tintText,
};

export interface AppTextProps extends TextProps {
  variant?: TextVariant;
  tone?: TextTone;
  align?: TextStyle['textAlign'];
}

/** The only text component. Applies Inter, the type scale and a cap on font scaling. */
export function AppText({ variant = 'body', tone = 'default', align, style, ...rest }: AppTextProps) {
  return (
    <Text
      maxFontSizeMultiplier={MAX_SCALE[variant]}
      {...rest}
      style={[VARIANTS[variant], { color: TONES[tone] }, align ? { textAlign: align } : null, style]}
    />
  );
}
