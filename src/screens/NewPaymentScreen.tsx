import { useRouter } from 'expo-router';
import { CircleCheck, Plus } from 'lucide-react-native';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { toProviderError } from '@/api/errors';
import type { Beneficiary, Payment } from '@/api/types';
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
import { useBalances, useBeneficiaries, useCreatePayment } from '@/hooks/queries';
import { useSingleFlight } from '@/hooks/useSingleFlight';
import { confirmWithBiometrics } from '@/lib/biometrics';
import { newIdempotencyKey } from '@/lib/ids';
import { compareAmounts, formatMoney, parseAmountInput } from '@/lib/money';
import { useIsOnline } from '@/lib/online';
import { colors, spacing } from '@/theme';

import { describeBeneficiaryAccount } from './shared';

type Step = 'payee' | 'amount' | 'review' | 'done';
export const MAX_REFERENCE_LENGTH = 35;

export function NewPaymentScreen() {
  const router = useRouter();
  const beneficiaries = useBeneficiaries();
  const balances = useBalances();
  const createPayment = useCreatePayment();
  const online = useIsOnline();

  const [step, setStep] = useState<Step>('payee');
  const [payee, setPayee] = useState<Beneficiary | null>(null);
  const [amountText, setAmountText] = useState('');
  const [reference, setReference] = useState('');
  const [showErrors, setShowErrors] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [result, setResult] = useState<Payment | null>(null);
  // One key per payment attempt. It survives retries so a retry can never pay twice.
  const [idempotencyKey, setIdempotencyKey] = useState(() => newIdempotencyKey('payment'));

  const currency = payee?.currency ?? 'GBP';
  const amount = parseAmountInput(amountText, currency);
  const balance = balances.data?.find((item) => item.currency === currency);
  const available = balances.data ? (balance?.amount ?? '0') : null;
  const trimmedReference = reference.trim();

  const amountError =
    amount === null
      ? 'Enter an amount greater than zero.'
      : available !== null && compareAmounts(amount, available) > 0
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
    setSubmitError(null);
    if (step === 'amount') setStep('payee');
    else if (step === 'review') setStep('amount');
    else close();
  };

  const choosePayee = (beneficiary: Beneficiary) => {
    if (beneficiary.id !== payee?.id) {
      setAmountText('');
      setShowErrors(false);
      setIdempotencyKey(newIdempotencyKey('payment'));
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
    if (!payee || amount === null || amountError || referenceError) return;
    setSubmitError(null);
    const confirmed = await confirmWithBiometrics({
      reason: `Send ${formatMoney(amount, currency)} to ${payee.name}`,
      fallbackTitle: 'Send this payment?',
      fallbackMessage: `${formatMoney(amount, currency)} to ${payee.name}, reference ${trimmedReference}.`,
      fallbackConfirmLabel: 'Send payment',
    });
    if (!confirmed) return;
    try {
      const payment = await createPayment.mutateAsync({
        beneficiaryId: payee.id,
        amount,
        currency,
        reference: trimmedReference,
        // The provider requires a reason. Until the product decides what to ask, the reference is reused.
        reason: trimmedReference,
        idempotencyKey,
      });
      setResult(payment);
      setStep('done');
    } catch (caught) {
      const providerError = toProviderError(caught);
      setSubmitError(
        providerError.kind === 'insufficient_funds'
          ? `There is not enough ${currency} to send this payment.`
          : providerError.kind === 'validation'
            ? 'The payment details were not accepted. Go back and check them.'
            : `${providerError.userMessage} If you try again, the payment will only be sent once.`,
      );
    }
  });

  if (step === 'done' && result) {
    return (
      <Screen header={<Header title="Payment sent" leading="close" onLeadingPress={close} />} footer={<Button label="Done" onPress={close} />}>
        <Card style={styles.outcome}>
          <CircleCheck color={colors.positive} size={48} />
          <AppText variant="heading" align="center" accessibilityRole="header" accessibilityLiveRegion="polite">
            Payment on its way
          </AppText>
          <AppText variant="amount" align="center" adjustsFontSizeToFit numberOfLines={1}>
            {formatMoney(result.amount, result.currency)}
          </AppText>
          <AppText tone="muted" align="center">{`To ${result.beneficiaryName ?? payee?.name ?? 'your payee'}, reference ${result.reference}`}</AppText>
        </Card>
        <Card padded={false}>
          <DetailRow label="Payment ID" value={result.shortReference} />
          <Divider />
          <DetailRow label="Arrives" value={disclosures.deliveryEstimate} />
        </Card>
      </Screen>
    );
  }

  if (step === 'payee') {
    return (
      <Screen header={<Header title="Send payment" leading="close" onLeadingPress={close} />}>
        <AppText variant="heading" accessibilityRole="header">
          Who are you paying?
        </AppText>
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
            error={showErrors || (amount !== null && amountError) ? amountError : null}
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
          label="Confirm and send"
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
      {submitError ? <InlineMessage tone="danger">{submitError}</InlineMessage> : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  center: { alignItems: 'center', gap: spacing.xs, paddingVertical: spacing.xl },
  outcome: { alignItems: 'center', gap: spacing.md, paddingVertical: spacing.xxl },
});
