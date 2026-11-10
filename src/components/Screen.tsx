import type { ReactNode } from 'react';
import { KeyboardAvoidingView, Platform, RefreshControl, ScrollView, StyleSheet, View } from 'react-native';
import { SafeAreaView, type Edge } from 'react-native-safe-area-context';

import { colors, sizes, spacing } from '@/theme';

import { OfflineBanner } from './StateViews';

export interface ScreenProps {
  children: ReactNode;
  /** Fixed above the scrolling content, for example a header. */
  header?: ReactNode;
  /** Fixed below the scrolling content, for the primary action. */
  footer?: ReactNode;
  tone?: 'light' | 'navy';
  onRefresh?: () => void;
  refreshing?: boolean;
  /** Tab screens leave the bottom inset to the tab bar. */
  edges?: readonly Edge[];
  showOfflineBanner?: boolean;
  testID?: string;
}

/** Page shell: safe areas, a centred column capped for wide screens, scrolling and keyboard handling. */
export function Screen({
  children,
  header,
  footer,
  tone = 'light',
  onRefresh,
  refreshing = false,
  edges = ['top', 'left', 'right', 'bottom'],
  showOfflineBanner = true,
  testID,
}: ScreenProps) {
  const backgroundColor = tone === 'navy' ? colors.navy : colors.background;
  return (
    <SafeAreaView style={[styles.root, { backgroundColor }]} edges={edges} testID={testID}>
      <KeyboardAvoidingView style={styles.root} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <View style={styles.column}>
          {header}
          {showOfflineBanner ? <OfflineBanner /> : null}
          <ScrollView
            style={styles.root}
            contentContainerStyle={styles.content}
            keyboardShouldPersistTaps="handled"
            refreshControl={
              onRefresh ? <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} /> : undefined
            }
          >
            {children}
          </ScrollView>
          {footer ? <View style={styles.footer}>{footer}</View> : null}
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  column: { flex: 1, width: '100%', maxWidth: sizes.maxContentWidth, alignSelf: 'center' },
  content: { padding: spacing.lg, gap: spacing.lg, flexGrow: 1 },
  footer: { paddingHorizontal: spacing.lg, paddingTop: spacing.sm, paddingBottom: spacing.md, gap: spacing.sm },
});
