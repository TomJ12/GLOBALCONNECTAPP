import { useRouter } from 'expo-router';
import { Bell } from 'lucide-react-native';
import { useState } from 'react';
import { Pressable, StyleSheet, Switch, View } from 'react-native';

import { getAuthClient } from '@/api';
import type { AppNotification, NotificationEmailChoices } from '@/api/types';
import { AppText } from '@/components/AppText';
import { Button } from '@/components/Button';
import { Card, Divider } from '@/components/Card';
import { Header } from '@/components/Header';
import { QueryState } from '@/components/QueryState';
import { Screen } from '@/components/Screen';
import { SkeletonList } from '@/components/Skeleton';
import { EmptyState, InlineMessage } from '@/components/StateViews';
import { disclosures } from '@/config/disclosures';
import { useMarkNotificationsRead, useNotificationEmailChoices, useNotifications, useSetNotificationEmailChoices } from '@/hooks/queries';
import { formatDateTime } from '@/lib/dates';
import { colors, sizes, spacing } from '@/theme';

/**
 * The bell in the header: opens the notification list and shows how many are
 * unread. It is not shown where there is no server to keep notifications (the
 * in-app demo).
 */
export function NotificationBell() {
  const router = useRouter();
  const notifications = useNotifications();
  if (getAuthClient().notifications === null) return null;
  const unread = notifications.data?.unread ?? 0;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={unread > 0 ? `Notifications, ${unread} unread` : 'Notifications'}
      onPress={() => router.push('/notifications')}
      hitSlop={8}
      style={({ pressed }) => [styles.bell, pressed ? styles.pressed : null]}
      testID="notification-bell"
    >
      <Bell color={colors.text} size={24} />
      {unread > 0 ? (
        <View style={styles.badge} testID="notification-badge">
          <AppText variant="caption" tone="onDark">
            {unread > 99 ? '99+' : String(unread)}
          </AppText>
        </View>
      ) : null}
    </Pressable>
  );
}

const CATEGORY_LABELS: Record<AppNotification['category'], string> = { rates: 'Rate alert', approvals: 'To approve', payments: 'Your payment', security: 'Security' };
const CHOICES: { key: keyof NotificationEmailChoices; label: string }[] = [
  { key: 'rates', label: 'Rate alerts' },
  { key: 'approvals', label: 'Payments waiting for your approval' },
  { key: 'payments', label: 'What happens to payments you create' },
];

function NotificationRow({ item, onRead }: { item: AppNotification; onRead: () => void }) {
  // The title and the body are plain text from the server. A body may quote what a colleague typed (a reason, a
  // payee's name): the server has already broken anything in it that could be a link, and here it is shown as
  // text with link detection off, never interpreted.
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${item.read ? '' : 'Unread. '}${item.title}. ${item.body}. ${formatDateTime(item.createdAt)}`}
      accessibilityHint={item.read ? undefined : 'Marks this notification as read'}
      onPress={item.read ? undefined : onRead}
      style={styles.row}
      testID={`notification-${item.id}`}
    >
      <View style={styles.rowHead}>
        {item.read ? null : <View style={styles.dot} testID={`unread-${item.id}`} />}
        <AppText variant="bodyStrong" style={styles.grow}>
          {item.title}
        </AppText>
      </View>
      {/* PLAIN TEXT, and nothing in it is made into a link: no link detection on a device, and on the web it is a text node. */}
      <AppText dataDetectorType="none" selectable={false} testID={`notification-body-${item.id}`}>
        {item.body}
      </AppText>
      <AppText variant="caption" tone="muted">{`${CATEGORY_LABELS[item.category]} · ${formatDateTime(item.createdAt)}`}</AppText>
    </Pressable>
  );
}

export function NotificationsScreen() {
  const router = useRouter();
  const notifications = useNotifications();
  const markRead = useMarkNotificationsRead();
  const choices = useNotificationEmailChoices();
  const setChoices = useSetNotificationEmailChoices();
  const [error, setError] = useState<string | null>(null);
  const close = () => (router.canGoBack() ? router.back() : router.replace('/'));
  const fail = (caught: unknown, fallback: string) => setError(caught instanceof Error ? caught.message : fallback);

  if (getAuthClient().notifications === null) {
    return (
      <Screen header={<Header title="Notifications" leading="close" onLeadingPress={close} />}>
        <EmptyState title="No notifications in this demo" body="Notifications are kept by the Global Connect server. This demo runs without one." />
      </Screen>
    );
  }

  const toggle = (key: keyof NotificationEmailChoices, value: boolean) => {
    if (!choices.data) return;
    setError(null);
    setChoices.mutate({ ...choices.data, [key]: value }, { onError: (caught) => fail(caught, 'Could not save that choice.') });
  };

  return (
    <Screen header={<Header title="Notifications" leading="close" onLeadingPress={close} />} onRefresh={() => void notifications.refetch()} refreshing={notifications.isRefetching}>
      {error ? <InlineMessage tone="danger">{error}</InlineMessage> : null}
      <QueryState
        query={notifications}
        skeleton={<SkeletonList rows={3} label="Loading notifications" />}
        isEmpty={(data) => data.items.length === 0}
        empty={<EmptyState title="No notifications" body="Rate alerts, payments waiting for your approval and news of payments you created appear here." />}
      >
        {(data) => (
          <View style={{ gap: spacing.sm }}>
            {data.unread > 0 ? (
              <Button
                variant="secondary"
                label={`Mark all as read (${data.unread})`}
                onPress={() => {
                  setError(null);
                  markRead.mutate(undefined, { onError: (caught) => fail(caught, 'Could not mark them as read.') });
                }}
                loading={markRead.isPending}
                testID="mark-all-read"
              />
            ) : null}
            <Card padded={false}>
              {data.items.map((item, index) => (
                <View key={item.id}>
                  {index > 0 ? <Divider /> : null}
                  <NotificationRow
                    item={item}
                    onRead={() => {
                      setError(null);
                      markRead.mutate(item.id, { onError: (caught) => fail(caught, 'Could not mark it as read.') });
                    }}
                  />
                </View>
              ))}
            </Card>
          </View>
        )}
      </QueryState>

      <Card style={{ gap: spacing.sm }}>
        <AppText variant="title" accessibilityRole="header">
          Also send me an email
        </AppText>
        {CHOICES.map(({ key, label }) => (
          <View key={key} style={styles.choice}>
            <AppText style={styles.grow}>{label}</AppText>
            <Switch
              accessibilityLabel={`Email me: ${label}`}
              value={choices.data?.[key] ?? true}
              onValueChange={(value) => toggle(key, value)}
              disabled={!choices.data || setChoices.isPending}
              trackColor={{ true: colors.primary, false: colors.disabledBg }}
              testID={`email-choice-${key}`}
            />
          </View>
        ))}
        <View style={styles.choice}>
          <AppText style={styles.grow}>Security notices about your account</AppText>
          <AppText tone="muted" testID="email-choice-security">
            Always on
          </AppText>
        </View>
        <AppText variant="caption" tone="muted">
          Everything in this list is always shown here in the app. Security notices are always emailed and cannot be turned off.
        </AppText>
        <AppText variant="caption" tone="muted">
          {disclosures.alertDelivery}
        </AppText>
      </Card>
    </Screen>
  );
}

const styles = StyleSheet.create({
  bell: { width: sizes.touchTarget, height: sizes.touchTarget, alignItems: 'center', justifyContent: 'center', borderRadius: sizes.touchTarget / 2 },
  badge: { position: 'absolute', top: 2, right: 0, minWidth: 18, height: 18, paddingHorizontal: 4, borderRadius: 9, backgroundColor: colors.danger, alignItems: 'center', justifyContent: 'center' },
  pressed: { opacity: 0.6 },
  row: { paddingHorizontal: spacing.lg, paddingVertical: spacing.md, gap: spacing.xs },
  rowHead: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  dot: { width: 8, height: 8, borderRadius: 4, backgroundColor: colors.primary },
  grow: { flex: 1, minWidth: 0 },
  choice: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, minHeight: sizes.touchTarget },
});
