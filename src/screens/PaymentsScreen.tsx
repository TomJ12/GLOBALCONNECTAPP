import { useRouter } from 'expo-router';
import { Plus } from 'lucide-react-native';
import { View } from 'react-native';

import { userMessageFor } from '@/api/errors';
import type { PendingApproval } from '@/api/types';
import { SectionHeader } from '@/components/Bits';
import { Button } from '@/components/Button';
import { Card, Divider } from '@/components/Card';
import { Header } from '@/components/Header';
import { QueryState } from '@/components/QueryState';
import { Screen } from '@/components/Screen';
import { SkeletonList } from '@/components/Skeleton';
import { EmptyState, InlineMessage } from '@/components/StateViews';
import { uniqueById, usePayments, usePendingApprovals } from '@/hooks/queries';
import { useIsOnline } from '@/lib/online';
import { useCapabilities } from '@/state/session';
import { colors, spacing } from '@/theme';

import { needsYourApproval, PaymentRow } from './shared';

function ApprovalList({ approvals }: { approvals: PendingApproval[] }) {
  const router = useRouter();
  return (
    <Card padded={false}>
      {approvals.map((approval, index) => (
        <View key={approval.payment.id}>
          {index > 0 ? <Divider /> : null}
          <PaymentRow payment={approval.payment} onPress={() => router.push({ pathname: '/payments/[id]', params: { id: approval.payment.id } })} />
        </View>
      ))}
    </Card>
  );
}

export function PaymentsScreen() {
  const router = useRouter();
  const capabilities = useCapabilities();
  const approvals = usePendingApprovals();
  const payments = usePayments();
  const online = useIsOnline();

  return (
    <Screen
      edges={['top', 'left', 'right']}
      header={<Header title="Payments" leading="none" />}
      onRefresh={() => {
        if (capabilities.paymentApprovals) void approvals.refetch();
        void payments.refetch();
      }}
      refreshing={approvals.isRefetching || (payments.isRefetching && !payments.isFetchingNextPage)}
    >
      <Button
        label="New payment"
        icon={<Plus color={colors.textOnDark} size={20} />}
        onPress={() => router.push('/payments/new')}
      />

      {capabilities.paymentApprovals ? (
        <View>
          <SectionHeader title="Needs your approval" />
          <QueryState
            query={approvals}
            skeleton={<SkeletonList rows={1} label="Loading payments waiting for approval" />}
            isEmpty={(data) => data.filter(needsYourApproval).length === 0}
            empty={<EmptyState title="Nothing to approve" body="Payments that need your approval will appear here." />}
          >
            {(data) => <ApprovalList approvals={data.filter(needsYourApproval)} />}
          </QueryState>
          {/* Payments this person created (or has already approved) that are still waiting for somebody else. */}
          {approvals.data && approvals.data.some((approval) => !needsYourApproval(approval)) ? (
            <View style={{ marginTop: spacing.lg }}>
              <SectionHeader title="Waiting for someone else" />
              <ApprovalList approvals={approvals.data.filter((approval) => !needsYourApproval(approval))} />
            </View>
          ) : null}
        </View>
      ) : null}

      <View style={{ marginBottom: spacing.lg, gap: spacing.md }}>
        <SectionHeader title="Recent payments" />
        <QueryState query={payments} skeleton={<SkeletonList rows={4} label="Loading payments" />}>
          {(data) => {
            const rows = uniqueById(data.pages.flatMap((page) => page.items)).filter((payment) => payment.status !== 'awaiting_approval');
            // "No payments yet" is only true when every page has been read.
            if (rows.length === 0 && !payments.hasNextPage) {
              return <EmptyState title="No payments yet" body="Payments you send will appear here." />;
            }
            return (
              <View style={{ gap: spacing.md }}>
                {rows.length > 0 ? (
                  <Card padded={false}>
                    {rows.map((payment, index) => (
                      <View key={payment.id}>
                        {index > 0 ? <Divider /> : null}
                        <PaymentRow payment={payment} />
                      </View>
                    ))}
                  </Card>
                ) : null}
                {payments.isFetchNextPageError ? <InlineMessage tone="danger">{userMessageFor(payments.error)}</InlineMessage> : null}
                {payments.hasNextPage ? (
                  <Button
                    variant="secondary"
                    label={payments.isFetchNextPageError ? 'Try again' : 'Show more payments'}
                    onPress={() => void payments.fetchNextPage()}
                    loading={payments.isFetchingNextPage}
                    disabled={!online}
                    testID="payments-more"
                  />
                ) : null}
              </View>
            );
          }}
        </QueryState>
      </View>
    </Screen>
  );
}
