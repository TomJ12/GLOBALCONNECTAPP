import { useLocalSearchParams, useRouter } from 'expo-router';
import { Check, CircleCheck, Clock, Fingerprint, ScanFace } from 'lucide-react-native';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { toProviderError } from '@/api/errors';
import type { ApprovalStep, PendingApproval } from '@/api/types';
import { AppText } from '@/components/AppText';
import { Avatar, DetailRow } from '@/components/Bits';
import { Button } from '@/components/Button';
import { Card, Divider } from '@/components/Card';
import { Header } from '@/components/Header';
import { QueryState } from '@/components/QueryState';
import { Screen } from '@/components/Screen';
import { SkeletonCard, SkeletonList } from '@/components/Skeleton';
import { EmptyState, InlineMessage } from '@/components/StateViews';
import { disclosures } from '@/config/disclosures';
import { useApprovePayment, useBalances, usePendingApprovals, useRejectPayment } from '@/hooks/queries';
import { useBiometricKind } from '@/hooks/useBiometricKind';
import { useSingleFlight } from '@/hooks/useSingleFlight';
import { biometricName, confirmWithBiometrics } from '@/lib/biometrics';
import { formatDate, formatRelativeDay } from '@/lib/dates';
import { compareAmounts, formatMoney } from '@/lib/money';
import { useIsOnline } from '@/lib/online';
import { requestConfirmation } from '@/state/confirm';
import { colors, spacing } from '@/theme';

type Outcome = { kind: 'approved' | 'rejected'; amount: string; payee: string } | null;

function routeLabel(route: PendingApproval['payment']['route']): string {
  if (route === 'local') return 'Local transfer';
  if (route === 'swift') return 'SWIFT';
  return disclosures.paymentRoute;
}

function StepRow({ step }: { step: ApprovalStep }) {
  const done = step.status === 'done';
  const status = done ? 'Done' : step.status === 'waiting_for_you' ? 'Your turn' : 'Waiting';
  const when = step.at ? `, ${formatRelativeDay(step.at).toLowerCase()}` : '';
  return (
    <View style={styles.step} accessible accessibilityLabel={`${step.label}${when}. ${status}`}>
      {done ? <CircleCheck color={colors.positive} size={22} /> : <Clock color={colors.warningAccent} size={22} />}
      <View style={styles.grow}>
        <AppText variant="bodyStrong">{`${step.label}${when}`}</AppText>
        <AppText variant="caption" tone={done ? 'positive' : 'warning'}>
          {status}
        </AppText>
      </View>
    </View>
  );
}

function Review({ approval, onOutcome }: { approval: PendingApproval; onOutcome: (outcome: Outcome) => void }) {
  const { payment } = approval;
  const balances = useBalances();
  const approve = useApprovePayment();
  const reject = useRejectPayment();
  const online = useIsOnline();
  const biometric = biometricName(useBiometricKind());
  const [error, setError] = useState<string | null>(null);

  const amount = formatMoney(payment.amount, payment.currency);
  const payee = payment.beneficiaryName ?? 'Unknown payee';
  const balance = balances.data?.find((item) => item.currency === payment.currency);
  const available = balances.data ? (balance?.amount ?? '0') : null;
  const insufficient = available !== null && compareAmounts(payment.amount, available) > 0;

  // One lock for both buttons: approving and rejecting can never overlap.
  const action = useSingleFlight(async (kind: 'approve' | 'reject') => {
    setError(null);
    if (kind === 'approve') {
      const confirmed = await confirmWithBiometrics({
        reason: `Approve ${amount} to ${payee}`,
        fallbackTitle: 'Approve this payment?',
        fallbackMessage: `${amount} to ${payee}, reference ${payment.reference}.`,
        fallbackConfirmLabel: 'Approve payment',
      });
      if (!confirmed) return;
    } else {
      const confirmed = await requestConfirmation({
        title: 'Reject this payment?',
        message: `${amount} to ${payee} will be cancelled. This cannot be undone.`,
        confirmLabel: 'Reject payment',
        cancelLabel: 'Keep payment',
        tone: 'danger',
      });
      if (!confirmed) return;
    }
    try {
      if (kind === 'approve') await approve.mutateAsync(payment.id);
      else await reject.mutateAsync(payment.id);
      onOutcome({ kind: kind === 'approve' ? 'approved' : 'rejected', amount, payee });
    } catch (caught) {
      const providerError = toProviderError(caught);
      setError(
        providerError.kind === 'insufficient_funds'
          ? `There is not enough ${payment.currency} to send this payment.`
          : providerError.kind === 'not_found' || providerError.kind === 'validation'
            ? 'This payment has changed and can no longer be actioned here. Go back and refresh.'
            : providerError.userMessage,
      );
    }
  });

  const BiometricIcon = biometric === 'Face ID' || biometric === 'face unlock' ? ScanFace : biometric ? Fingerprint : Check;
  const remaining = approval.approvalsRemaining;

  return (
    <>
      <Card style={styles.center}>
        <AppText tone="muted">You send</AppText>
        <AppText variant="amountLarge" adjustsFontSizeToFit numberOfLines={1} testID="review-amount">
          {amount}
        </AppText>
        {available !== null ? (
          <AppText variant="caption" tone="muted">
            {`From ${payment.currency} balance, ${formatMoney(available, payment.currency)} available`}
          </AppText>
        ) : null}
      </Card>

      <Card padded={false}>
        <View style={styles.payee}>
          <Avatar name={payee} />
          <View style={styles.grow}>
            <AppText variant="caption" tone="muted">
              To
            </AppText>
            <AppText variant="bodyStrong">{payee}</AppText>
          </View>
        </View>
        <Divider />
        <DetailRow label="Reference" value={payment.reference} />
        <Divider />
        <DetailRow label="Route" value={routeLabel(payment.route)} />
        <Divider />
        <DetailRow label="Fee" value={payment.fee ? formatMoney(payment.fee.amount, payment.fee.currency) : disclosures.fee} />
        <Divider />
        <DetailRow label="Arrives" value={payment.estimatedArrival ? formatDate(payment.estimatedArrival) : disclosures.deliveryEstimate} />
      </Card>

      <Card style={{ gap: spacing.md }}>
        <AppText variant="title" accessibilityRole="header">
          {`Approval, ${remaining} more needed`}
        </AppText>
        {approval.steps.map((step, index) => (
          <StepRow key={`${step.label}-${index}`} step={step} />
        ))}
      </Card>

      {insufficient ? (
        <InlineMessage tone="warning">{`There is not enough ${payment.currency} to send this payment. Add or convert funds first.`}</InlineMessage>
      ) : null}
      {error ? <InlineMessage tone="danger">{error}</InlineMessage> : null}

      <View style={{ gap: spacing.sm }}>
        <Button
          label={biometric ? `Approve with ${biometric}` : 'Approve payment'}
          icon={<BiometricIcon color={insufficient || !online ? colors.disabledText : colors.textOnDark} size={22} />}
          onPress={() => action.run('approve')}
          loading={action.busy}
          disabled={insufficient || !online}
          testID="approve-button"
        />
        <Button label="Reject payment" variant="danger" onPress={() => action.run('reject')} disabled={action.busy || !online} testID="reject-button" />
      </View>
    </>
  );
}

export function PaymentReviewScreen() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const approvals = usePendingApprovals();
  const [outcome, setOutcome] = useState<Outcome>(null);

  const done = () => {
    if (router.canGoBack()) router.back();
    else router.replace('/payments');
  };

  if (outcome) {
    return (
      <Screen header={<Header title={outcome.kind === 'approved' ? 'Payment approved' : 'Payment rejected'} leading="close" onLeadingPress={done} />} footer={<Button label="Done" onPress={done} />}>
        <Card style={styles.outcome}>
          <CircleCheck color={outcome.kind === 'approved' ? colors.positive : colors.textMuted} size={48} />
          <AppText variant="heading" align="center" accessibilityRole="header" accessibilityLiveRegion="polite">
            {outcome.kind === 'approved' ? 'Approved' : 'Rejected'}
          </AppText>
          <AppText tone="muted" align="center">
            {outcome.kind === 'approved'
              ? `${outcome.amount} to ${outcome.payee} is on its way to being sent.`
              : `${outcome.amount} to ${outcome.payee} was cancelled. No money has left your account.`}
          </AppText>
        </Card>
      </Screen>
    );
  }

  return (
    <Screen header={<Header title="Review payment" />}>
      <QueryState
        query={approvals}
        skeleton={
          <View style={{ gap: spacing.lg }}>
            <SkeletonCard label="Loading payment" />
            <SkeletonList rows={4} label="Loading payment details" />
          </View>
        }
      >
        {(data) => {
          const approval = data.find((item) => item.payment.id === id);
          if (!approval) {
            return (
              <EmptyState
                title="Nothing to approve here"
                body="This payment has already been approved or rejected."
                action={{ label: 'Back to payments', onPress: done }}
              />
            );
          }
          return <Review approval={approval} onOutcome={setOutcome} />;
        }}
      </QueryState>
    </Screen>
  );
}

const styles = StyleSheet.create({
  center: { alignItems: 'center', gap: spacing.xs, paddingVertical: spacing.xl },
  payee: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, padding: spacing.lg },
  grow: { flex: 1, minWidth: 0 },
  step: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  outcome: { alignItems: 'center', gap: spacing.md, paddingVertical: spacing.xxl },
});
