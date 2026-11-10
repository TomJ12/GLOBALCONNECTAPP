import { useLocalSearchParams } from 'expo-router';
import { Share2 } from 'lucide-react-native';
import { useState } from 'react';
import { Platform, Share, View } from 'react-native';
import * as Clipboard from 'expo-clipboard';

import { isMockBackend } from '@/api';
import type { AccountDetails } from '@/api/types';
import { AppText } from '@/components/AppText';
import { CopyRow, SampleDataPill } from '@/components/Bits';
import { Button } from '@/components/Button';
import { Card, Divider } from '@/components/Card';
import { ChipGroup } from '@/components/Controls';
import { Header } from '@/components/Header';
import { QueryState } from '@/components/QueryState';
import { Screen } from '@/components/Screen';
import { SkeletonCard, SkeletonList } from '@/components/Skeleton';
import { EmptyState } from '@/components/StateViews';
import { disclosures } from '@/config/disclosures';
import { useAccountDetails, useBalances } from '@/hooks/queries';
import { useSingleFlight } from '@/hooks/useSingleFlight';
import { currencyName, currencyPrefix, formatMoney } from '@/lib/money';
import { formatIban, formatSortCode } from '@/lib/validation';
import { showToast } from '@/state/toast';
import { colors, spacing } from '@/theme';

/** Plain-text version of the details, for the share sheet. */
export function accountDetailsText(details: AccountDetails): string {
  const lines = [`${details.currency} account details`, `Account name: ${details.accountHolderName}`];
  if (details.sortCode) lines.push(`Sort code: ${formatSortCode(details.sortCode)}`);
  if (details.accountNumber) lines.push(`Account number: ${details.accountNumber}`);
  if (details.iban) lines.push(`IBAN: ${formatIban(details.iban)}`);
  if (details.bic) lines.push(`BIC: ${details.bic}`);
  return lines.join('\n');
}

function DetailsCard({ details }: { details: AccountDetails }) {
  const rows: { label: string; value: string; copy: string }[] = [
    { label: 'Account name', value: details.accountHolderName, copy: details.accountHolderName },
  ];
  if (details.sortCode) rows.push({ label: 'Sort code', value: formatSortCode(details.sortCode), copy: details.sortCode });
  if (details.accountNumber) rows.push({ label: 'Account number', value: details.accountNumber, copy: details.accountNumber });
  if (details.iban) rows.push({ label: 'IBAN, for payments from abroad', value: formatIban(details.iban), copy: details.iban });
  if (details.bic) rows.push({ label: 'BIC', value: details.bic, copy: details.bic });

  const share = useSingleFlight(async () => {
    const message = accountDetailsText(details);
    try {
      if (Platform.OS === 'web' && (typeof navigator === 'undefined' || typeof navigator.share !== 'function')) {
        await Clipboard.setStringAsync(message);
        showToast('Sharing is not available here, so the details were copied instead');
        return;
      }
      await Share.share({ message });
    } catch (error) {
      // Closing the share sheet is not an error worth reporting.
      if (error instanceof Error && error.name === 'AbortError') return;
      showToast('Could not open sharing. Copy the details instead.');
    }
  });

  return (
    <View style={{ gap: spacing.lg }}>
      <Card padded={false}>
        {rows.map((row, index) => (
          <View key={row.label}>
            {index > 0 ? <Divider /> : null}
            <CopyRow label={row.label} value={row.value} copyValue={row.copy} />
          </View>
        ))}
      </Card>
      <Button
        label="Share details with a payer"
        icon={<Share2 color={colors.textOnDark} size={20} />}
        onPress={share.run}
        loading={share.busy}
      />
      <AppText variant="caption" tone="muted">
        {disclosures.accountProvider}
      </AppText>
    </View>
  );
}

export function ReceiveScreen() {
  const params = useLocalSearchParams<{ currency?: string }>();
  const balances = useBalances();
  const [picked, setPicked] = useState<string | null>(null);

  const currencies = balances.data?.map((balance) => balance.currency) ?? [];
  const requested = typeof params.currency === 'string' ? params.currency.toUpperCase() : null;
  const currency =
    picked && currencies.includes(picked) ? picked : requested && currencies.includes(requested) ? requested : (currencies[0] ?? null);
  const details = useAccountDetails(currency);
  const balance = balances.data?.find((item) => item.currency === currency);

  return (
    <Screen
      header={<Header title="Receive money" trailing={isMockBackend() ? <SampleDataPill /> : undefined} />}
      onRefresh={() => {
        void balances.refetch();
        if (currency) void details.refetch();
      }}
      refreshing={balances.isRefetching || details.isRefetching}
    >
      <QueryState
        query={balances}
        skeleton={
          <View style={{ gap: spacing.lg }}>
            <SkeletonCard label="Loading accounts" />
            <SkeletonList rows={4} label="Loading account details" />
          </View>
        }
        isEmpty={(data) => data.length === 0}
        empty={<EmptyState title="No currency accounts yet" body="Account details will appear here once an account is open." />}
      >
        {() => (
          <View style={{ gap: spacing.lg }}>
            <ChipGroup
              accessibilityLabel="Currency account"
              value={currency ?? ''}
              onChange={setPicked}
              options={currencies.map((code) => ({
                value: code,
                label: `${currencyPrefix(code).trim()} ${code}`.trim(),
                accessibilityLabel: currencyName(code),
              }))}
            />
            {balance ? (
              <Card style={{ gap: spacing.xs }}>
                <AppText tone="muted">{`${balance.currency} balance`}</AppText>
                <AppText variant="amount" adjustsFontSizeToFit numberOfLines={1}>
                  {formatMoney(balance.amount, balance.currency)}
                </AppText>
              </Card>
            ) : null}
            <QueryState query={details} skeleton={<SkeletonList rows={4} label="Loading account details" />}>
              {(data) => <DetailsCard details={data} />}
            </QueryState>
          </View>
        )}
      </QueryState>
    </Screen>
  );
}
