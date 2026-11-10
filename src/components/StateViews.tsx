import { CircleAlert, Inbox, WifiOff } from 'lucide-react-native';
import type { ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';

import { userMessageFor } from '@/api/errors';
import { useIsOnline } from '@/lib/online';
import { colors, radii, spacing } from '@/theme';

import { AppText } from './AppText';
import { Button } from './Button';
import { Card } from './Card';

interface StateCardProps {
  icon: ReactNode;
  title: string;
  body?: string;
  action?: { label: string; onPress: () => void; loading?: boolean };
}

function StateCard({ icon, title, body, action }: StateCardProps) {
  return (
    <Card style={styles.state}>
      {icon}
      <AppText variant="title" align="center">
        {title}
      </AppText>
      {body ? (
        <AppText tone="muted" align="center">
          {body}
        </AppText>
      ) : null}
      {action ? <Button variant="secondary" label={action.label} onPress={action.onPress} loading={action.loading} /> : null}
    </Card>
  );
}

/** Something failed. Always offers a retry. */
export function ErrorState({ error, onRetry, retrying = false, title = 'Something went wrong' }: { error: unknown; onRetry: () => void; retrying?: boolean; title?: string }) {
  return (
    <View accessibilityRole="alert">
      <StateCard
        icon={<CircleAlert color={colors.danger} size={28} />}
        title={title}
        body={userMessageFor(error)}
        action={{ label: 'Try again', onPress: onRetry, loading: retrying }}
      />
    </View>
  );
}

export function EmptyState({ title, body, action }: { title: string; body?: string; action?: { label: string; onPress: () => void } }) {
  return <StateCard icon={<Inbox color={colors.textMuted} size={28} />} title={title} body={body} action={action} />;
}

/** Nothing cached and no connection. */
export function OfflineState() {
  return (
    <StateCard
      icon={<WifiOff color={colors.warningAccent} size={28} />}
      title="You are offline"
      body="This will load when your connection is back."
    />
  );
}

/** Slim banner shown on every screen while offline. */
export function OfflineBanner() {
  const online = useIsOnline();
  if (online) return null;
  return (
    <View style={styles.banner} accessibilityRole="alert" accessibilityLiveRegion="polite">
      <WifiOff color={colors.warningAccent} size={18} />
      <AppText variant="label" tone="warning" style={styles.bannerText}>
        You are offline. Showing the last information we have.
      </AppText>
    </View>
  );
}

/** Inline message under a form or above a button. */
export function InlineMessage({ tone, children }: { tone: 'danger' | 'warning' | 'info'; children: string }) {
  const palette =
    tone === 'danger'
      ? { bg: colors.dangerBg, fg: 'danger' as const, icon: colors.danger }
      : tone === 'warning'
        ? { bg: colors.warningBg, fg: 'warning' as const, icon: colors.warningAccent }
        : { bg: colors.tint, fg: 'tint' as const, icon: colors.tintText };
  return (
    <View
      style={[styles.inline, { backgroundColor: palette.bg }, tone === 'warning' ? styles.inlineWarning : null]}
      accessibilityRole={tone === 'info' ? 'text' : 'alert'}
      accessibilityLiveRegion="polite"
    >
      <CircleAlert color={palette.icon} size={18} />
      <AppText variant="label" tone={palette.fg} style={styles.bannerText}>
        {children}
      </AppText>
    </View>
  );
}

const styles = StyleSheet.create({
  state: { alignItems: 'center', gap: spacing.md, paddingVertical: spacing.xxl },
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginHorizontal: spacing.lg,
    marginTop: spacing.xs,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    backgroundColor: colors.warningBg,
    borderColor: colors.warningBorder,
    borderWidth: 1,
    borderRadius: radii.md,
  },
  bannerText: { flex: 1 },
  inline: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm, padding: spacing.md, borderRadius: radii.md },
  inlineWarning: { borderWidth: 1, borderColor: colors.warningBorder },
});
