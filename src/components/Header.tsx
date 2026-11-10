import { useRouter } from 'expo-router';
import { ChevronLeft, X } from 'lucide-react-native';
import type { ReactNode } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { colors, sizes, spacing } from '@/theme';

import { AppText } from './AppText';

export interface HeaderProps {
  title: string;
  /** 'back' shows a chevron, 'close' shows a cross, 'none' hides the button (tab roots). */
  leading?: 'back' | 'close' | 'none';
  /** Overrides the default "go back" behaviour. */
  onLeadingPress?: () => void;
  trailing?: ReactNode;
  tone?: 'light' | 'navy';
}

export function Header({ title, leading = 'back', onLeadingPress, trailing, tone = 'light' }: HeaderProps) {
  const router = useRouter();
  const color = tone === 'navy' ? colors.textOnDark : colors.text;
  const goBack = () => {
    if (onLeadingPress) onLeadingPress();
    else if (router.canGoBack()) router.back();
    else router.replace('/');
  };
  const Icon = leading === 'close' ? X : ChevronLeft;
  return (
    <View style={styles.row}>
      {leading === 'none' ? null : (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={leading === 'close' ? 'Close' : 'Back'}
          onPress={goBack}
          hitSlop={8}
          style={({ pressed }) => [styles.iconButton, pressed ? styles.pressed : null]}
        >
          <Icon color={color} size={24} />
        </Pressable>
      )}
      <AppText
        variant={leading === 'none' ? 'heading' : 'title'}
        accessibilityRole="header"
        tone={tone === 'navy' ? 'onDark' : 'default'}
        style={styles.title}
        numberOfLines={2}
      >
        {title}
      </AppText>
      {trailing ?? (leading === 'none' ? null : <View style={styles.iconButton} />)}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm,
    paddingBottom: spacing.xs,
    minHeight: sizes.touchTarget + spacing.md,
  },
  title: { flex: 1 },
  iconButton: { width: sizes.touchTarget, height: sizes.touchTarget, alignItems: 'center', justifyContent: 'center', borderRadius: sizes.touchTarget / 2 },
  pressed: { opacity: 0.6 },
});
