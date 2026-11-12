import { useLocalSearchParams, useRouter } from 'expo-router';
import { Check, CircleAlert, CircleCheck, Clock } from 'lucide-react-native';
import { useCallback, useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { toProviderError } from '@/api/errors';
import type { ApprovalResult, ApprovalStep, PendingApproval } from '@/api/types';
import { AppText } from '@/components/AppText';
import { Avatar, DetailRow } from '@/components/Bits';
import { Button } from '@/components/Button';
import { Card, Divider } from '@/components/Card';
import { Header } from '@/components/Header';
import { QueryState } from '@/components/QueryState';
import { Screen } from '@/components/Screen';
import { SkeletonCard, SkeletonList } from '@/components/Skeleton';
import { EmptyState, InlineMessage } from '@/components/StateViews';
import { outcomeCheckTiming } from '@/config/app';
import { disclosures } from '@/config/disclosures';
import { useApprovePayment, useBalances, usePendingApprovals, useRejectPayment } from '@/hooks/queries';
import { useSingleFlight } from '@/hooks/useSingleFlight';
import { confirmAction } from '@/lib/confirmAction';
import { formatDate, formatRelativeDay } from '@/lib/dates';
import { compareAmounts, formatMoney } from '@/lib/money';
import { useIsOnline } from '@/lib/online';
import { formatSortCode } from '@/lib/validation';
import { colors, spacing } from '@/theme';

import { describeBeneficiaryAccount, maskAccountIdentifier } from './shared';

export type ReviewOutcome =
  | { kind: 'approved'; amount: string; payee: string; result: ApprovalResult }
  | { kind: 'rejected'; amount: string; payee: string }
  /** We could not read the answer, and the payment has since left the pending list. We do not know why. */
  | { kind: 'no_longer_pending'; attempted: 'approve' | 'reject'; amount: string; payee: string };

/** Everything an approver is agreeing to. If any of it changes, the approval must be looked at again. */
export function approvalSignature(approval: PendingApproval): string {
  const { payment, beneficiary } = approval;
  return JSON.stringify([
    payment.amount,
    payment.currency,
    payment.reference,
    payment.status,
    payment.beneficiaryId,
    approval.approvalsRemaining,
    beneficiary
      ? [beneficiary.name, beneficiary.bankCountry, beneficiary.iban, beneficiary.accountNumber, beneficiary.sortCode, beneficiary.bic, beneficiary.routingNumber]
      : null,
  ]);
}

/** Truthful wording when the payment is simply gone from the pending list after an unread answer. */
export function noLongerPendingCopy(attempted: 'approve' | 'reject'): { title: string; body: string } {
  return {
    title: 'No longer waiting for approval',
    body:
      attempted === 'approve'
        ? 'We did not get a clear answer to your approval. This payment is no longer waiting, which may be because of your approval or because someone else approved or rejected it. Check Payments for its status.'
        : 'We did not get a clear answer to your rejection. This payment is no longer waiting, which may be because of your rejection or because someone else approved or rejected it. Do not assume it was cancelled: check Payments for its status.',
  };
}

/** What to say after an approval, from what the backend reported. "Approved" alone is not enough. */
export function approvalOutcomeCopy(result: ApprovalResult): { title: string; body: string; tone: 'positive' | 'warning' | 'danger' } {
  if (result.approvalsRemaining > 0 || result.status === 'awaiting_approval') {
    const count = Math.max(1, result.approvalsRemaining);
    return {
      title: 'Approval recorded',
      body: `Your approval is saved. ${count} more ${count === 1 ? 'approval is' : 'approvals are'} needed before this payment is sent.`,
      tone: 'warning',
    };
  }
  if (result.status === 'failed' || result.status === 'cancelled') {
    return { title: 'Payment not sent', body: 'Your approval was recorded but the payment was not sent. Check Payments for its status.', tone: 'danger' };
  }
  if (result.status === 'unknown') {
    return { title: 'Approval recorded', body: 'We could not confirm what happens next. Check Payments for the status of this payment.', tone: 'warning' };
  }
  return { title: 'Approved', body: 'The payment is released and is now being processed.', tone: 'positive' };
}

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

function Review({ approval, onOutcome }: { approval: PendingApproval; onOutcome: (outcome: ReviewOutcome) => void }) {
  const { payment, beneficiary } = approval;
  const balances = useBalances();
  const approvals = usePendingApprovals();
  const approve = useApprovePayment();
  const reject = useRejectPayment();
  const online = useIsOnline();
  const [error, setError] = useState<string | null>(null);
  /** Set after an action whose outcome we could not establish. Nothing more is allowed until it is resolved. */
  const [unresolved, setUnresolved] = useState<{ kind: 'approve' | 'reject'; startedAt: number } | null>(null);
  const windowSeconds = Math.round(outcomeCheckTiming.windowMs / 1000);
  const { refetch } = approvals;

  const amount = formatMoney(payment.amount, payment.currency);
  const payee = payment.beneficiaryName ?? 'Unknown payee';
  const balance = balances.data?.find((item) => item.currency === payment.currency);
  const available = balances.data ? (balance?.amount ?? '0') : null;
  const insufficient = available !== null && compareAmounts(payment.amount, available) > 0;
  const accountLine = beneficiary ? describeBeneficiaryAccount(beneficiary) : null;

  /**
   * After an answer we could not read, ask the backend what is true, and keep
   * asking for the whole processing window. One early look proves nothing: the
   * request may still be on its way. Approve and reject take no idempotency key
   * (the provider's endpoints do not accept one); they are safe to repeat because
   * a payment that is no longer waiting cannot be approved or rejected again.
   */
  const checkOutcome = useCallback(
    async (pending: { kind: 'approve' | 'reject'; startedAt: number }) => {
      const fresh = await refetch();
      if (fresh.isError || !fresh.data) return; // Could not ask. Stay blocked and ask again.
      const current = fresh.data.find((item) => item.payment.id === payment.id);
      if (!current) {
        // Gone from the pending list. That does not say WHO did WHAT, so the outcome does not claim it.
        setUnresolved(null);
        onOutcome({ kind: 'no_longer_pending', attempted: pending.kind, amount, payee });
      } else if (pending.kind === 'approve' && current.approvalsRemaining < approval.approvalsRemaining) {
        setUnresolved(null);
        onOutcome({ kind: 'approved', amount, payee, result: { status: 'awaiting_approval', approvalsRemaining: current.approvalsRemaining } });
      } else if (Date.now() - pending.startedAt >= outcomeCheckTiming.windowMs) {
        setUnresolved(null);
        setError(`We kept checking for ${windowSeconds} seconds and this payment is still waiting for approval. Look at it again before you retry.`);
      }
    },
    [refetch, payment.id, approval.approvalsRemaining, amount, payee, onOutcome, windowSeconds],
  );

  useEffect(() => {
    if (!unresolved) return;
    // Look at once (on the next tick), then at intervals for the rest of the window.
    const first = setTimeout(() => void checkOutcome(unresolved), 0);
    const timer = setInterval(() => void checkOutcome(unresolved), outcomeCheckTiming.intervalMs);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }, [unresolved, checkOutcome]);

  // One lock for both buttons: approving and rejecting can never overlap.
  const action = useSingleFlight(async (kind: 'approve' | 'reject') => {
    if (unresolved) return;
    setError(null);

    // Act on what is true NOW, not on the copy this screen loaded earlier.
    const fresh = await refetch();
    if (fresh.isError || !fresh.data) {
      setError('We could not check that this payment is still up to date. Try again.');
      return;
    }
    const current = fresh.data.find((item) => item.payment.id === payment.id);
    if (!current) {
      setError('This payment no longer needs approval.');
      return;
    }
    if (approvalSignature(current) !== approvalSignature(approval)) {
      setError('This payment changed after you opened it. Check the details shown now, then confirm again.');
      return;
    }

    const details = `${amount} to ${payee}${accountLine ? `, ${accountLine}` : ''}. Reference ${payment.reference}.`;
    const confirmed =
      kind === 'approve'
        ? await confirmAction({
            title: 'Approve this payment?',
            message: details,
            confirmLabel: 'Approve payment',
            stepUp: { action: 'payment.approve', payload: { paymentId: payment.id } },
          })
        : await confirmAction({
            title: 'Reject this payment?',
            message: `${details} It will be cancelled. This cannot be undone.`,
            confirmLabel: 'Reject payment',
            cancelLabel: 'Keep payment',
            tone: 'danger',
            stepUp: { action: 'payment.reject', payload: { paymentId: payment.id } },
          });
    if (!confirmed) return;
    const startedAt = Date.now();
    try {
      if (kind === 'approve') {
        onOutcome({ kind: 'approved', amount, payee, result: await approve.mutateAsync(payment.id) });
      } else {
        await reject.mutateAsync(payment.id);
        onOutcome({ kind: 'rejected', amount, payee });
      }
    } catch (caught) {
      const providerError = toProviderError(caught);
      if (providerError.outcomeUnknown) {
        setError(`We did not get an answer, so we are checking whether that went through. This can take up to ${windowSeconds} seconds. Do not try again.`);
        const pending = { kind, startedAt };
        setUnresolved(pending);
        // Look once straight away, from here rather than from an effect: the list refresh that
        // follows a mutation can take this part of the screen away before an effect would run.
        await checkOutcome(pending);
        return;
      }
      setError(
        providerError.kind === 'insufficient_funds'
          ? `There is not enough ${payment.currency} to send this payment.`
          : providerError.kind === 'not_found' || providerError.kind === 'validation'
            ? 'This payment has changed and can no longer be actioned here. Go back and refresh.'
            : providerError.userMessage,
      );
    }
  });

  const recheck = useSingleFlight(async () => {
    if (unresolved) await checkOutcome(unresolved);
  });

  const remaining = approval.approvalsRemaining;
  const canApprove = beneficiary !== null && !insufficient && online && !unresolved;

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
        {/* The approver must be able to see WHERE the money is going, not just a name. */}
        {beneficiary ? (
          <>
            <Divider />
            <DetailRow label="Bank country" value={beneficiary.bankCountry} />
            {beneficiary.iban ? (
              <>
                <Divider />
                <DetailRow label="IBAN" value={maskAccountIdentifier(beneficiary.iban) ?? ''} />
              </>
            ) : null}
            {beneficiary.accountNumber ? (
              <>
                <Divider />
                <DetailRow label="Account number" value={maskAccountIdentifier(beneficiary.accountNumber) ?? ''} />
              </>
            ) : null}
            {beneficiary.sortCode ? (
              <>
                <Divider />
                <DetailRow label="Sort code" value={formatSortCode(beneficiary.sortCode)} />
              </>
            ) : null}
            {beneficiary.routingNumber ? (
              <>
                <Divider />
                <DetailRow label="Routing number" value={beneficiary.routingNumber} />
              </>
            ) : null}
            {beneficiary.bic ? (
              <>
                <Divider />
                <DetailRow label="BIC" value={beneficiary.bic} />
              </>
            ) : null}
          </>
        ) : null}
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

      {beneficiary === null ? (
        <InlineMessage tone="danger">
          We could not load this payee&apos;s bank details, so this payment cannot be approved here. You can still reject it.
        </InlineMessage>
      ) : null}
      {insufficient ? (
        <InlineMessage tone="warning">{`There is not enough ${payment.currency} to send this payment. Add or convert funds first.`}</InlineMessage>
      ) : null}
      {error ? <InlineMessage tone="danger">{error}</InlineMessage> : null}

      {unresolved ? (
        <Button label="Check again" onPress={recheck.run} loading={recheck.busy} disabled={!online} testID="review-recheck" />
      ) : (
        <View style={{ gap: spacing.sm }}>
          <Button
            label="Approve payment"
            icon={<Check color={canApprove ? colors.textOnDark : colors.disabledText} size={22} />}
            onPress={() => action.run('approve')}
            loading={action.busy}
            disabled={!canApprove}
            testID="approve-button"
          />
          <Button label="Reject payment" variant="danger" onPress={() => action.run('reject')} disabled={action.busy || !online} testID="reject-button" />
        </View>
      )}
    </>
  );
}

export function PaymentReviewScreen() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const approvals = usePendingApprovals();
  const [outcome, setOutcome] = useState<ReviewOutcome | null>(null);

  const done = () => {
    if (router.canGoBack()) router.back();
    else router.replace('/payments');
  };

  if (outcome) {
    const copy =
      outcome.kind === 'approved'
        ? approvalOutcomeCopy(outcome.result)
        : outcome.kind === 'no_longer_pending'
          ? { ...noLongerPendingCopy(outcome.attempted), tone: 'warning' as const }
          : { title: 'Rejected', body: 'The payment was cancelled. No money has left your account.', tone: 'positive' as const };
    const Icon = copy.tone === 'positive' ? CircleCheck : copy.tone === 'warning' ? Clock : CircleAlert;
    const iconColor = outcome.kind === 'rejected' ? colors.textMuted : copy.tone === 'positive' ? colors.positive : copy.tone === 'warning' ? colors.warningAccent : colors.danger;
    return (
      <Screen header={<Header title={copy.title} leading="close" onLeadingPress={done} />} footer={<Button label="Done" onPress={done} />}>
        <Card style={styles.outcome}>
          <Icon color={iconColor} size={48} />
          <AppText variant="heading" align="center" accessibilityRole="header" accessibilityLiveRegion="polite" testID="review-outcome-title">
            {copy.title}
          </AppText>
          <AppText tone="muted" align="center">{`${outcome.amount} to ${outcome.payee}`}</AppText>
          <AppText align="center">{copy.body}</AppText>
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
