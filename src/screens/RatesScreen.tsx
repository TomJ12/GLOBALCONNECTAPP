import { Big } from 'big.js';
import { useRouter } from 'expo-router';
import { Trash2 } from 'lucide-react-native';
import { useState } from 'react';
import { Pressable, StyleSheet, Switch, View } from 'react-native';

import type { RateAlert } from '@/alerts';
import { isMockBackend } from '@/api';
import type { ForwardContract } from '@/api/types';
import { AppText } from '@/components/AppText';
import { ListRow, Pill, ProgressBar, SampleDataPill, SectionHeader } from '@/components/Bits';
import { Card, Divider } from '@/components/Card';
import { Header } from '@/components/Header';
import { QueryState } from '@/components/QueryState';
import { Screen } from '@/components/Screen';
import { SkeletonBlock, SkeletonList } from '@/components/Skeleton';
import { Sparkline } from '@/components/Sparkline';
import { EmptyState, InlineMessage } from '@/components/StateViews';
import { WATCHLIST_PAIRS } from '@/config/app';
import { disclosures } from '@/config/disclosures';
import {
  useAlerts,
  useForwardContracts,
  useRate,
  useRateHistory,
  useRemoveAlert,
  useSetAlertEnabled,
} from '@/hooks/queries';
import { formatDate } from '@/lib/dates';
import { formatMoney, formatRate } from '@/lib/money';
import { requestConfirmation } from '@/state/confirm';
import { colors, sizes, spacing } from '@/theme';
import { useCapabilities } from '@/state/session';

function RateRow({ base, quote }: { base: string; quote: string }) {
  const router = useRouter();
  const rate = useRate(base, quote);
  const history = useRateHistory(base, quote);
  const pair = `${base} / ${quote}`;

  let trailing;
  let spoken: string;
  if (rate.data) {
    trailing = (
      <AppText variant="title" testID={`rate-${base}${quote}`}>
        {formatRate(rate.data.rate)}
      </AppText>
    );
    spoken = `${base} to ${quote}, ${formatRate(rate.data.rate)}`;
  } else if (rate.isError) {
    trailing = <Pill label="Unavailable" tone="warning" />;
    spoken = `${base} to ${quote}, rate unavailable`;
  } else if (rate.fetchStatus === 'paused') {
    trailing = <Pill label="Offline" tone="neutral" />;
    spoken = `${base} to ${quote}, offline`;
  } else {
    trailing = <SkeletonBlock width={64} height={18} />;
    spoken = `${base} to ${quote}, loading`;
  }

  return (
    <ListRow
      title={pair}
      onPress={
        rate.isError
          ? () => void rate.refetch()
          : () => router.push({ pathname: '/convert', params: { sell: base, buy: quote } })
      }
      accessibilityLabel={spoken}
      accessibilityHint={rate.isError ? 'Tries to load this rate again' : `Opens Convert with ${base} to ${quote}`}
      trailing={
        <View style={styles.rateTrailing}>
          {history.data ? <Sparkline points={history.data.points} /> : <View style={styles.sparkSpace} />}
          {trailing}
        </View>
      }
      showChevron={!rate.isError}
    />
  );
}

function AlertRow({ alert }: { alert: RateAlert }) {
  const setEnabled = useSetAlertEnabled();
  const remove = useRemoveAlert();
  const [error, setError] = useState<string | null>(null);
  const pair = `${alert.base} / ${alert.quote}`;
  const condition = `${alert.direction === 'above' ? 'reaches' : 'drops to'} ${formatRate(alert.targetRate)}`;
  const busy = setEnabled.isPending || remove.isPending;

  const toggle = (enabled: boolean) => {
    setError(null);
    setEnabled.mutate({ id: alert.id, enabled }, { onError: (caught) => setError(caught instanceof Error ? caught.message : 'Could not update the alert.') });
  };
  const confirmRemove = async () => {
    const confirmed = await requestConfirmation({
      title: 'Delete this alert?',
      message: `${pair} ${condition}`,
      confirmLabel: 'Delete alert',
      cancelLabel: 'Keep alert',
      tone: 'danger',
    });
    if (!confirmed) return;
    setError(null);
    remove.mutate(alert.id, { onError: (caught) => setError(caught instanceof Error ? caught.message : 'Could not delete the alert.') });
  };

  return (
    <View style={styles.alertRow}>
      <View style={styles.alertMain}>
        <View style={styles.grow}>
          <AppText variant="bodyStrong">{`${pair} ${condition}`}</AppText>
          <AppText variant="caption" tone="muted">
            {alert.enabled ? 'On' : 'Paused'}
          </AppText>
        </View>
        <Switch
          accessibilityLabel={`Alert: ${pair} ${condition}`}
          accessibilityHint={alert.enabled ? 'Pauses this alert' : 'Turns this alert on'}
          value={alert.enabled}
          onValueChange={toggle}
          disabled={busy}
          trackColor={{ true: colors.primary, false: colors.disabledBg }}
          testID={`alert-switch-${alert.id}`}
        />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Delete alert: ${pair} ${condition}`}
          onPress={() => void confirmRemove()}
          disabled={busy}
          style={({ pressed }) => [styles.iconButton, pressed ? styles.pressed : null]}
          testID={`alert-delete-${alert.id}`}
        >
          <Trash2 color={colors.danger} size={20} />
        </Pressable>
      </View>
      {error ? <InlineMessage tone="danger">{error}</InlineMessage> : null}
    </View>
  );
}

/** Share of the contract drawn so far, as a number for the bar width only. */
function drawnFraction(forward: ForwardContract): number {
  const total = new Big(forward.buyAmount);
  if (total.lte(0)) return 0;
  return Number(new Big(forward.drawnAmount).div(total).toFixed(4));
}

function ForwardCard({ forward }: { forward: ForwardContract }) {
  const drawn = formatMoney(forward.drawnAmount, forward.buyCurrency);
  const remaining = formatMoney(forward.remainingAmount, forward.buyCurrency);
  const total = formatMoney(forward.buyAmount, forward.buyCurrency);
  return (
    <Card style={{ gap: spacing.sm }}>
      <AppText variant="title">{`Buy ${total} at ${formatRate(forward.rate)}`}</AppText>
      <AppText tone="muted">{`Settles ${formatDate(forward.settlementDate)}`}</AppText>
      <ProgressBar fraction={drawnFraction(forward)} accessibilityLabel={`${drawn} drawn down of ${total}`} />
      <View style={styles.forwardAmounts}>
        <AppText variant="label">{`${drawn} drawn down`}</AppText>
        <AppText variant="label" tone="muted">{`${remaining} remaining`}</AppText>
      </View>
    </Card>
  );
}

export function RatesScreen() {
  const router = useRouter();
  const alerts = useAlerts();
  const capabilities = useCapabilities();
  const forwards = useForwardContracts();

  return (
    <Screen
      edges={['top', 'left', 'right']}
      header={<Header title="Rates" leading="none" trailing={isMockBackend() ? <SampleDataPill /> : undefined} />}
      onRefresh={() => {
        void alerts.refetch();
        if (capabilities.forwardContracts) void forwards.refetch();
      }}
      refreshing={forwards.isRefetching}
    >
      <View style={{ gap: spacing.sm }}>
        <Card padded={false}>
          {WATCHLIST_PAIRS.map(([base, quote], index) => (
            <View key={`${base}${quote}`}>
              {index > 0 ? <Divider /> : null}
              <RateRow base={base} quote={quote} />
            </View>
          ))}
        </Card>
        <AppText variant="caption" tone="muted">
          {disclosures.rateSource}
        </AppText>
      </View>

      <View>
        <SectionHeader title="Rate alerts" action={{ label: 'New alert', onPress: () => router.push('/alerts/new') }} />
        <QueryState
          query={alerts}
          skeleton={<SkeletonList rows={2} label="Loading rate alerts" />}
          isEmpty={(data) => data.length === 0}
          empty={
            <EmptyState
              title="No rate alerts"
              body="Set a target rate for a currency pair."
              action={{ label: 'New alert', onPress: () => router.push('/alerts/new') }}
            />
          }
        >
          {(data) => (
            <View style={{ gap: spacing.sm }}>
              <Card padded={false}>
                {data.map((alert, index) => (
                  <View key={alert.id}>
                    {index > 0 ? <Divider /> : null}
                    <AlertRow alert={alert} />
                  </View>
                ))}
              </Card>
              <AppText variant="caption" tone="muted">
                {disclosures.alertDelivery}
              </AppText>
            </View>
          )}
        </QueryState>
      </View>

      {capabilities.forwardContracts ? (
        <View style={{ marginBottom: spacing.lg }}>
          <SectionHeader title="Forward contracts" />
          <QueryState
            query={forwards}
            skeleton={<SkeletonList rows={1} label="Loading forward contracts" />}
            isEmpty={(data) => data.length === 0}
            empty={<EmptyState title="No forward contracts" body="Forwards you book in Convert will appear here." />}
          >
            {(data) => (
              <View style={{ gap: spacing.md }}>
                {data.map((forward) => (
                  <ForwardCard key={forward.id} forward={forward} />
                ))}
              </View>
            )}
          </QueryState>
        </View>
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  rateTrailing: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  sparkSpace: { width: 72, height: 28 },
  alertRow: { paddingHorizontal: spacing.lg, paddingVertical: spacing.md, gap: spacing.sm },
  alertMain: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, minHeight: sizes.touchTarget },
  grow: { flex: 1, minWidth: 0 },
  iconButton: { width: sizes.touchTarget, height: sizes.touchTarget, alignItems: 'center', justifyContent: 'center', borderRadius: sizes.touchTarget / 2 },
  pressed: { opacity: 0.6 },
  forwardAmounts: { flexDirection: 'row', justifyContent: 'space-between', flexWrap: 'wrap', gap: spacing.sm },
});
