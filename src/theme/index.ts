/**
 * Brand tokens. The single source of truth for colour, type, spacing and radii.
 * Values come from the Global Connect website and the approved app design.
 */
export const colors = {
  primary: '#2563EB',
  primaryPressed: '#1D4ED8',
  navy: '#0F172A',
  text: '#0F172A',
  /** Minimum-contrast text colour on light surfaces. Do not go lighter for text. */
  textMuted: '#475569',
  textOnDark: '#FFFFFF',
  textOnDarkMuted: '#CBD5E1',
  background: '#F1F5F9',
  card: '#FFFFFF',
  hairline: '#E2E8F0',
  tint: '#DBEAFE',
  tintText: '#1E40AF',
  positive: '#166534',
  positiveBg: '#DCFCE7',
  warningBg: '#FFF7ED',
  warningBorder: '#FDBA74',
  warningAccent: '#9A3412',
  danger: '#B91C1C',
  dangerBg: '#FEE2E2',
  skeleton: '#E2E8F0',
  overlay: 'rgba(15, 23, 42, 0.5)',
  navyRaised: '#1E293B',
  navyBorder: '#334155',
  disabledBg: '#CBD5E1',
  disabledText: '#334155',
} as const;

export const fonts = {
  regular: 'Inter_400Regular',
  medium: 'Inter_500Medium',
  semibold: 'Inter_600SemiBold',
  bold: 'Inter_700Bold',
} as const;

export const fontSizes = {
  caption: 13,
  body: 15,
  bodyLarge: 17,
  title: 20,
  heading: 24,
  amount: 34,
  amountLarge: 40,
} as const;

export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  xxl: 28,
} as const;

export const radii = {
  sm: 10,
  md: 14,
  card: 20,
  pill: 999,
} as const;

export const sizes = {
  /** Primary buttons are full-width pills of this height. */
  buttonHeight: 54,
  /** Minimum touch target. */
  touchTarget: 44,
  /** Content column is capped at this width on wide (web/tablet) screens. */
  maxContentWidth: 520,
} as const;

export const theme = { colors, fonts, fontSizes, spacing, radii, sizes } as const;
export type Theme = typeof theme;
