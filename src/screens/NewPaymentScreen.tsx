import { useRouter } from 'expo-router';
import { CircleAlert, CircleCheck, Clock, Plus } from 'lucide-react-native';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { toProviderError } from '@/api/errors';
import type { Beneficiary, Payment, PaymentStatus } from '@/api/types';
import { AmountField } from '@/components/AmountField';
import { AppText } from '@/components/AppText';
import { Avatar, DetailRow, ListRow } from '@/components/Bits';
import { Button } from '@/components/Button';
import { Card, Divider } from '@/components/Card';
import { Header } from '@/components/Header';
import { QueryState } from '@/components/QueryState';
import { Screen } from '@/components/Screen';
import { SkeletonList } from '@/components/Skeleton';
import { EmptyState, InlineMessage } from '@/components/StateViews';
import { TextField } from '@/components/TextField';
import { disclosures } from '@/config/disclosures';
import { useBalances, useBeneficiaries, useCreatePayment, useFindPaymentByKey } from '@/hooks/queries';
import { useOutcomeCheck, type OutcomeCheckResult } from '@/hooks/useOutcomeCheck';
import { useSingleFlight } from '@/hooks/useSingleFlight';
import { confirmAction } from '@/lib/confirmAction';
import { newIdempotencyKey } from '@/lib/ids';
import { amountInputMessage, compareAmounts, formatMoney, readAmountInput } from '@/lib/money';
import { useIsOnline } from '@/lib/online';
import { colors, spacing } from '@/theme';

import { describeBeneficiaryAccount } from './shared';

type Step = 'payee' | 'amount' | 'review' | 'done';
export const MAX_REFERENCE_LENGTH = 35;

/** What to tell the person once a payment exists, by the status the backend reported. Never assume "sent". */
export function paymentOutcomeCopy(status: PaymentStatus): { header: string; title: string; body: string; tone: 'positive' | 'warning' | 'danger' } {
  switch (status) {
    case 'sent':
      return { header: 'Payment sent', title: 'Payment sent', body: 'The payment has been sent.', tone: 'positive' };
    case 'processing':
      return { header: 'Payment submitted', title: 'Payment on its way', body: 'The payment is being processed.', tone: 'positive' };
    case 'awaiting_approval':
      return {
        header: 'Waiting for approval',
        title: 'Not sent yet',
        body: 'This payment needs approval before it is sent. No money has left your account.',
        tone: 'warning',
      };
    case 'failed':
      return { header: 'Payment failed', title: 'Payment failed', body: 'This payment was not sent. Check Payments before trying again.', tone: 'danger' };
    case 'cancelled':
      return { header: 'Payment cancelled', title: 'Payment cancelled', body: 'This payment was cancelled and has not been sent.', tone: 'danger' };
    default:
      return {
        header: 'Check this payment',
        title: 'Status not confirmed',
        body: 'The payment was created but we could not confirm its status. Check Payments before sending it again.',
        tone: 'warning',
      };
  }
}

export function NewPaymentScreen() {
  const router = useRouter();
  const beneficiaries = useBeneficiaries();
  const balances = useBalances();
  const createPayment = useCreatePayment();
  const findByKey = useFindPaymentByKey();
  const online = useIsOnline();

  const [step, setStep] = useState<Step>('payee');
  const [payee, setPayee] = useState<Beneficiary | null>(null);
  const [amountText, setAmountText] = useState('');
  const [reference, setReference] = useState('');
  const [showErrors, setShowErrors] = useState(false);
  const [notice, setNotice] = useState<{ tone: 'danger' | 'warning' | 'info'; text: string } | null>(null);
  const [result, setResult] = useState<Payment | null>(null);
  /**
   * The idempotency key belongs to exactly one payment: this payee, amount,
   * currency and reference. Change any of them and it is a different payment
   * with a new key; retry the same one and the key is reused.
   */
  const [attempt, setAttempt] = useState<{ signature: string; key: string } | null>(null);

  const finish = (payment: Payment) => {
    setResult(payment);
    setAttempt(null);
    setNotice(null);
    setStep('done');
  };
  const applyCheck = (check: OutcomeCheckResult<Payment>) => {
    if (check.status === 'found') finish(check.value);
    else if (check.status === 'not_found') {
      setNotice({ tone: 'warning', text: 'That payment did not go through. No money has left your account. You can try again.' });
    } else {
      setNotice({ tone: 'danger', text: 'We still cannot confirm whether your payment went through. Do not send it again yet. Check again in a moment.' });
    }
  };
  const outcome = useOutcomeCheck<Payment>('payment', (key) => findByKey.mutateAsync(key), applyCheck);
  const outcomeUnknown = outcome.pendingKey !== null;

  const currency = payee?.currency ?? 'GBP';
  const read = readAmountInput(amountText, currency);
  const amount = read.ok ? read.amount : null;
  const balance = balances.data?.find((item) => item.currency === currency);
  const available = balances.data ? (balance?.amount ?? '0') : null;
  const trimmedReference = reference.trim();

  const amountError = !read.ok
    ? (amountInputMessage(read.problem, currency) ?? 'Enter an amount greater than zero.')
    : available !== null && compareAmounts(read.amount, available) > 0
      ? `You have ${formatMoney(available, currency)} available in ${currency}.`
      : null;
  const referenceError =
    trimmedReference === ''
      ? 'Enter a reference the payee will recognise.'
      : !/^[A-Za-z0-9 ./-]+$/.test(trimmedReference)
        ? 'Use letters, numbers, spaces and . / - only.'
        : null;

  const close = () => {
    if (router.canGoBack()) router.back();
    else router.replace('/payments');
  };

  const back = () => {
    if (outcomeUnknown) return;
    setNotice(null);
    if (step === 'amount') setStep('payee');
    else if (step === 'review') setStep('amount');
    else close();
  };

  const choosePayee = (beneficiary: Beneficiary) => {
    if (beneficiary.id !== payee?.id) {
      setAmountText('');
      setShowErrors(false);
    }
    setPayee(beneficiary);
    setStep('amount');
  };

  const toReview = () => {
    setShowErrors(true);
    if (amountError || referenceError) return;
    setStep('review');
  };

  const send = useSingleFlight(async () => {
    if (!payee || amount === null || amountError || referenceError || outcomeUnknown) return;
    setNotice(null);
    const confirmed = await confirmAction({
      title: 'Send this payment?',
      message: `${formatMoney(amount, currency)} to ${payee.name}, ${describeBeneficiaryAccount(payee)}. Reference ${trimmedReference}.`,
      confirmLabel: 'Send payment',
    });
    if (!confirmed) return;
    const signature = [payee.id, amount, currency, trimmedReference].join('|');
    const key = attempt?.signature === signature ? attempt.key : newIdempotencyKey('payment');
    setAttempt({ signature, key });
    try {
      finish(
        await createPayment.mutateAsync({
          beneficiaryId: payee.id,
          amount,
          currency,
          reference: trimmedReference,
          // The provider requires a reason. Until the product decides what to ask, the reference is reused.
          reason: trimmedReference,
          idempotencyKey: key,
        }),
      );
    } catch (caught) {
      const providerError = toProviderError(caught);
      if (providerError.outcomeUnknown) {
        // It may have been created. Find out before anything else is allowed.
        setNotice({ tone: 'info', text: 'We did not get an answer. Checking whether your payment went through…' });
        applyCheck(await outcome.markUnknown(key));
      } else {
        setNotice({
          tone: 'danger',
          text:
            providerError.kind === 'insufficient_funds'
              ? `There is not enough ${currency} to send this payment.`
              : providerError.kind === 'validation'
                ? 'The payment details were not accepted. Go back and check them.'
                : providerError.userMessage,
        });
      }
    }
  });

  const recheck = useSingleFlight(async () => {
    applyCheck(await outcome.recheck());
  });

  if (step === 'done' && result) {
    const copy = paymentOutcomeCopy(result.status);
    const Icon = copy.tone === 'positive' ? CircleCheck : copy.tone === 'warning' ? Clock : CircleAlert;
    const iconColor = copy.tone === 'positive' ? colors.positive : copy.tone === 'warning' ? colors.warningAccent : colors.danger;
    return (
      <Screen header={<Header title={copy.header} leading="close" onLeadingPress={close} />} footer={<Button label="Done" onPress={close} />}>
        <Card style={styles.outcome}>
          <Icon color={iconColor} size={48} />
          <AppText variant="heading" align="center" accessibilityRole="header" accessibilityLiveRegion="polite" testID="payment-outcome-title">
            {copy.title}
          </AppText>
          <AppText variant="amount" align="center" adjustsFontSizeToFit numberOfLines={1} testID="payment-outcome-amount">
            {formatMoney(result.amount, result.currency)}
          </AppText>
          <AppText tone="muted" align="center">{`To ${result.beneficiaryName ?? payee?.name ?? 'your payee'}, reference ${result.reference}`}</AppText>
          <AppText align="center">{copy.body}</AppText>
        </Card>
        <Card padded={false}>
          <DetailRow label="Payment ID" value={result.shortReference} />
          {copy.tone === 'positive' ? (
            <>
              <Divider />
              <DetailRow label="Arrives" value={disclosures.deliveryEstimate} />
            </>
          ) : null}
        </Card>
      </Screen>
    );
  }

  // An unknown outcome (from this visit or an earlier one) blocks everything until it is resolved.
  if (outcomeUnknown) {
    return (
      <Screen
        header={<Header title="Checking your payment" leading="close" onLeadingPress={close} />}
        footer={<Button label="Check again" onPress={recheck.run} loading={recheck.busy || outcome.isChecking} disabled={!online} testID="payment-recheck" />}
      >
        <InlineMessage tone={notice?.tone ?? 'info'}>
          {notice?.text ?? 'We are checking whether your last payment went through. Do not send it again yet.'}
        </InlineMessage>
      </Screen>
    );
  }

  if (step === 'payee') {
    return (
      <Screen header={<Header title="Send payment" leading="close" onLeadingPress={close} />}>
        <AppText variant="heading" accessibilityRole="header">
          Who are you paying?
        </AppText>
        {notice ? <InlineMessage tone={notice.tone}>{notice.text}</InlineMessage> : null}
        <QueryState
          query={beneficiaries}
          skeleton={<SkeletonList rows={3} label="Loading payees" />}
          isEmpty={(data) => data.length === 0}
          empty={<EmptyState title="No saved payees" body="Add a payee to send your first payment." />}
        >
          {(data) => (
            <Card padded={false}>
              {data.map((beneficiary, index) => (
                <View key={beneficiary.id}>
                  {index > 0 ? <Divider /> : null}
                  <ListRow
                    leading={<Avatar name={beneficiary.name} />}
                    title={beneficiary.name}
                    subtitle={describeBeneficiaryAccount(beneficiary)}
                    onPress={() => choosePayee(beneficiary)}
                    showChevron
                    accessibilityLabel={`${beneficiary.name}, ${describeBeneficiaryAccount(beneficiary)}`}
                    accessibilityHint="Chooses this payee"
                  />
                </View>
              ))}
            </Card>
          )}
        </QueryState>
        <Button
          variant="secondary"
          label="Add a new payee"
          icon={<Plus color={colors.tintText} size={20} />}
          onPress={() => router.push('/payees/new')}
        />
      </Screen>
    );
  }

  if (!payee) return null;

  if (step === 'amount') {
    return (
      <Screen header={<Header title="Send payment" onLeadingPress={back} />} footer={<Button label="Continue" onPress={toReview} />}>
        <Card padded={false}>
          <ListRow leading={<Avatar name={payee.name} />} title={payee.name} subtitle={describeBeneficiaryAccount(payee)} />
        </Card>
        <Card style={{ gap: spacing.lg }}>
          <AmountField
            label="You send"
            currency={currency}
            value={amountText}
            onChangeText={setAmountText}
            caption={available !== null ? `From ${currency} balance, ${formatMoney(available, currency)} available` : undefined}
            error={showErrors || amountText.trim() !== '' ? amountError : null}
            testID="payment-amount"
          />
        </Card>
        <TextField
          label="Reference"
          value={reference}
          onChangeText={setReference}
          maxLength={MAX_REFERENCE_LENGTH}
          autoCapitalize="characters"
          autoCorrect={false}
          hint="Shown to the payee, for example an invoice number."
          error={showErrors ? referenceError : null}
          testID="payment-reference"
        />
      </Screen>
    );
  }

  // Review
  return (
    <Screen
      header={<Header title="Review payment" onLeadingPress={send.busy ? () => undefined : back} />}
      footer={
        <Button
          label="Send payment"
          onPress={send.run}
          loading={send.busy}
          disabled={!online || amount === null || amountError !== null}
          testID="send-payment"
        />
      }
    >
      <Card style={styles.center}>
        <AppText tone="muted">You send</AppText>
        <AppText variant="amountLarge" adjustsFontSizeToFit numberOfLines={1}>
          {amount ? formatMoney(amount, currency) : ''}
        </AppText>
        {available !== null ? (
          <AppText variant="caption" tone="muted">{`From ${currency} balance, ${formatMoney(available, currency)} available`}</AppText>
        ) : null}
      </Card>
      <Card padded={false}>
        <ListRow
          leading={<Avatar name={payee.name} />}
          title={payee.name}
          subtitle={describeBeneficiaryAccount(payee)}
          accessibilityLabel={`To ${payee.name}, ${describeBeneficiaryAccount(payee)}`}
        />
        <Divider />
        <DetailRow label="Reference" value={trimmedReference} />
        <Divider />
        <DetailRow label="Route" value={disclosures.paymentRoute} />
        <Divider />
        <DetailRow label="Fee" value={disclosures.fee} />
        <Divider />
        <DetailRow label="Arrives" value={disclosures.deliveryEstimate} />
      </Card>
      {amountError ? <InlineMessage tone="warning">{amountError}</InlineMessage> : null}
      {notice ? <InlineMessage tone={notice.tone}>{notice.text}</InlineMessage> : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  center: { alignItems: 'center', gap: spacing.xs, paddingVertical: spacing.xl },
  outcome: { alignItems: 'center', gap: spacing.md, paddingVertical: spacing.xxl },
});
