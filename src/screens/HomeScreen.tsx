import { useRouter } from 'expo-router';
import { ArrowDownToLine, ArrowLeftRight, ChevronRight, Send, TrendingUp, TriangleAlert } from 'lucide-react-native';
import type { ReactNode } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import type { Balance, PendingApproval } from '@/api/types';
import { AppText } from '@/components/AppText';
import { Avatar, IconCircle, ListRow, SampleDataPill, SectionHeader } from '@/components/Bits';
import { Card, Divider } from '@/components/Card';
import { QueryState } from '@/components/QueryState';
import { Screen } from '@/components/Screen';
import { SkeletonBlock, SkeletonCard, SkeletonList } from '@/components/Skeleton';
import { EmptyState, InlineMessage } from '@/components/StateViews';
import { BASE_CURRENCY } from '@/config/app';
import { isMockBackend } from '@/api';
import {
  useBalances,
  useCompanyProfile,
  usePendingApprovals,
  useRatesFromBase,
  useRecentTransactions,
} from '@/hooks/queries';
import { formatTimeOfDay } from '@/lib/dates';
import { currencyName, currencyPrefix, formatMoney, totalInBaseCurrency } from '@/lib/money';
import { useCapabilities } from '@/state/session';
import { colors, radii, sizes, spacing } from '@/theme';

import { needsYourApproval, TransactionRow } from './shared';

function QuickAction({ label, icon, onPress }: { label: string; icon: ReactNode; onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={({ pressed }) => [styles.quickAction, pressed ? styles.pressed : null]}
    >
      <IconCircle size={52}>{icon}</IconCircle>
      <AppText variant="label" align="center" maxFontSizeMultiplier={1.3}>
        {label}
      </AppText>
    </Pressable>
  );
}

function TotalBalance({ balances }: { balances: Balance[] }) {
  const currencies = balances.map((balance) => balance.currency);
  const rates = useRatesFromBase(BASE_CURRENCY, currencies);
  const needsRates = currencies.some((currency) => currency !== BASE_CURRENCY);
  const waiting = needsRates && rates.isPending && !rates.isError;

  if (waiting && !rates.isPaused) {
    return <SkeletonCard label="Loading total balance" />;
  }
  const { total, missing } = totalInBaseCurrency(balances, BASE_CURRENCY, rates.rates);
  const count = balances.length;
  return (
    <Card style={styles.totalCard}>
      <AppText tone="muted">{`Total balance, ${BASE_CURRENCY} equivalent`}</AppText>
      <AppText variant="amountLarge" adjustsFontSizeToFit numberOfLines={1} testID="total-balance">
        {formatMoney(total, BASE_CURRENCY)}
      </AppText>
      {missing.length === 0 ? (
        <AppText variant="caption" tone="muted">
          {needsRates
            ? `Across ${count} currencies. Estimated at indicative rates${rates.asOf ? ` as of ${formatTimeOfDay(rates.asOf)}` : ''}.`
            : `Across ${count} ${count === 1 ? 'currency' : 'currencies'}.`}
        </AppText>
      ) : (
        <View style={styles.gapSm}>
          <InlineMessage tone="warning">
            {`Not included: ${missing.join(', ')}. ${rates.isPaused ? 'Rates will load when you are back online.' : 'We could not get a rate.'}`}
          </InlineMessage>
          {rates.isPaused ? null : (
            <Pressable accessibilityRole="button" accessibilityLabel="Try loading rates again" onPress={rates.refetch} style={styles.linkButton}>
              <AppText variant="bodyStrong" tone="primary" style={styles.underline}>
                Try again
              </AppText>
            </Pressable>
          )}
        </View>
      )}
    </Card>
  );
}

function ApprovalBanner({ approvals, onPress }: { approvals: PendingApproval[]; onPress: () => void }) {
  const first = approvals[0];
  if (!first) return null;
  const count = approvals.length;
  const title = count === 1 ? '1 payment needs your approval' : `${count} payments need your approval`;
  const detail =
    count === 1
      ? `${formatMoney(first.payment.amount, first.payment.currency)} to ${first.payment.beneficiaryName ?? 'a payee'}`
      : 'Review them in Payments';
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${title}. ${detail}`}
      accessibilityHint="Opens the payment for review"
      onPress={onPress}
      style={({ pressed }) => [styles.banner, pressed ? styles.pressed : null]}
      testID="approval-banner"
    >
      <TriangleAlert color={colors.warningAccent} size={24} />
      <View style={styles.grow}>
        <AppText variant="bodyStrong" tone="warning">
          {title}
        </AppText>
        <AppText variant="caption">{detail}</AppText>
      </View>
      <ChevronRight color={colors.warningAccent} size={20} />
    </Pressable>
  );
}

export function HomeScreen() {
  const router = useRouter();
  const company = useCompanyProfile();
  const balances = useBalances();
  const capabilities = useCapabilities();
  const approvals = usePendingApprovals();
  const activity = useRecentTransactions(5);

  const refreshing = balances.isRefetching || approvals.isRefetching || activity.isRefetching;
  const refresh = () => {
    void company.refetch();
    void balances.refetch();
    if (capabilities.paymentApprovals) void approvals.refetch();
    void activity.refetch();
  };

  // Only what this person is asked to approve: a payment they created themselves is waiting for somebody else.
  const toApprove = (approvals.data ?? []).filter(needsYourApproval);
  const openApprovals = () => {
    const list = toApprove;
    const only = list.length === 1 ? list[0] : undefined;
    if (only) router.push({ pathname: '/payments/[id]', params: { id: only.payment.id } });
    else router.push('/payments');
  };

  return (
    <Screen edges={['top', 'left', 'right']} onRefresh={refresh} refreshing={refreshing}>
      <View style={styles.header}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Profile and settings"
          onPress={() => router.push('/settings')}
          style={({ pressed }) => [styles.avatarButton, pressed ? styles.pressed : null]}
        >
          <Avatar name={company.data?.companyName ?? ''} size={44} />
        </Pressable>
        <View style={styles.grow}>
          {company.data ? (
            <>
              {company.data.planName ? (
                <AppText variant="caption" tone="muted">
                  {company.data.planName}
                </AppText>
              ) : null}
              <AppText variant="title" accessibilityRole="header" numberOfLines={2}>
                {company.data.companyName}
              </AppText>
            </>
          ) : company.isError ? (
            <AppText variant="title" accessibilityRole="header">
              Your account
            </AppText>
          ) : (
            <View style={styles.gapSm} accessible accessibilityLabel="Loading company name">
              <SkeletonBlock width={110} height={12} />
              <SkeletonBlock width={180} height={18} />
            </View>
          )}
        </View>
        {isMockBackend() ? <SampleDataPill /> : null}
      </View>

      <QueryState query={balances} skeleton={<SkeletonCard label="Loading total balance" />}>
        {(data) => <TotalBalance balances={data} />}
      </QueryState>

      <View style={styles.quickActions}>
        <QuickAction label="Send" icon={<Send color={colors.tintText} size={22} />} onPress={() => router.push('/payments/new')} />
        <QuickAction label="Convert" icon={<ArrowLeftRight color={colors.tintText} size={22} />} onPress={() => router.push('/convert')} />
        <QuickAction label="Receive" icon={<ArrowDownToLine color={colors.tintText} size={22} />} onPress={() => router.push('/receive')} />
        <QuickAction label="Rates" icon={<TrendingUp color={colors.tintText} size={22} />} onPress={() => router.push('/rates')} />
      </View>

      {toApprove.length > 0 ? <ApprovalBanner approvals={toApprove} onPress={openApprovals} /> : null}
      {approvals.isError && !approvals.data ? (
        <InlineMessage tone="warning">We could not check for payments waiting for approval. Pull down to try again.</InlineMessage>
      ) : null}

      <View>
        <SectionHeader title="Accounts" />
        <QueryState
          query={balances}
          skeleton={<SkeletonList rows={3} label="Loading accounts" />}
          isEmpty={(data) => data.length === 0}
          empty={<EmptyState title="No currency accounts yet" body="Your accounts will appear here once they are open." />}
        >
          {(data) => (
            <Card padded={false}>
              {data.map((balance, index) => (
                <View key={balance.id}>
                  {index > 0 ? <Divider /> : null}
                  <ListRow
                    leading={
                      <IconCircle>
                        <AppText variant="bodyStrong" tone="tint" maxFontSizeMultiplier={1}>
                          {currencyPrefix(balance.currency).trim().slice(0, 3)}
                        </AppText>
                      </IconCircle>
                    }
                    title={balance.currency}
                    subtitle={currencyName(balance.currency)}
                    showChevron
                    onPress={() => router.push({ pathname: '/receive', params: { currency: balance.currency } })}
                    accessibilityLabel={`${currencyName(balance.currency)} account, balance ${formatMoney(balance.amount, balance.currency)}`}
                    accessibilityHint="Shows account details"
                    testID={`balance-${balance.currency}`}
                    trailing={<AppText variant="title">{formatMoney(balance.amount, balance.currency, { withSymbol: false })}</AppText>}
                  />
                </View>
              ))}
            </Card>
          )}
        </QueryState>
      </View>

      <View>
        <SectionHeader
          title="Recent activity"
          action={{ label: 'See all', accessibilityLabel: 'See all activity', onPress: () => router.push('/activity') }}
        />
        <QueryState
          query={activity}
          skeleton={<SkeletonList rows={3} label="Loading recent activity" />}
          isEmpty={(data) => data.length === 0}
          empty={<EmptyState title="No activity yet" body="Payments and conversions will appear here." />}
        >
          {(data) => (
            <Card padded={false}>
              {data.map((transaction, index) => (
                <View key={transaction.id}>
                  {index > 0 ? <Divider /> : null}
                  <TransactionRow transaction={transaction} />
                </View>
              ))}
            </Card>
          )}
        </QueryState>
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  avatarButton: { minWidth: sizes.touchTarget, minHeight: sizes.touchTarget, justifyContent: 'center' },
  grow: { flex: 1, minWidth: 0 },
  gapSm: { gap: spacing.sm },
  totalCard: { gap: spacing.xs, paddingVertical: spacing.xl },
  quickActions: { flexDirection: 'row', justifyContent: 'space-between', gap: spacing.sm },
  quickAction: { flex: 1, alignItems: 'center', gap: spacing.sm, minHeight: sizes.touchTarget, paddingVertical: spacing.xs },
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    padding: spacing.lg,
    borderRadius: radii.card,
    backgroundColor: colors.warningBg,
    borderWidth: 1,
    borderColor: colors.warningBorder,
  },
  pressed: { opacity: 0.7 },
  linkButton: { minHeight: sizes.touchTarget, justifyContent: 'center', alignSelf: 'flex-start' },
  underline: { textDecorationLine: 'underline' },
});
