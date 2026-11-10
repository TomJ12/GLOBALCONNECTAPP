/** Small pieces shared by more than one screen. */
import { ArrowDownLeft, ArrowLeftRight, ArrowUpRight, Receipt } from 'lucide-react-native';
import { View } from 'react-native';

import type { Beneficiary, Payment, PaymentStatus, Transaction } from '@/api/types';
import { AppText } from '@/components/AppText';
import { IconCircle, ListRow, Pill, type PillTone } from '@/components/Bits';
import { formatRelativeDay } from '@/lib/dates';
import { formatMoney } from '@/lib/money';
import { colors } from '@/theme';

/** "USD account ending 4471". Only the last four characters are ever shown. */
export function describeBeneficiaryAccount(beneficiary: Beneficiary): string {
  const identifier = beneficiary.iban ?? beneficiary.accountNumber;
  const ending = identifier && identifier.length >= 4 ? ` ending ${identifier.slice(-4)}` : '';
  return `${beneficiary.currency} account${ending}`;
}

const STATUS_LABELS: Record<PaymentStatus, { label: string; tone: PillTone }> = {
  awaiting_approval: { label: 'Needs approval', tone: 'warning' },
  processing: { label: 'Processing', tone: 'tint' },
  sent: { label: 'Sent', tone: 'positive' },
  failed: { label: 'Failed', tone: 'danger' },
  cancelled: { label: 'Cancelled', tone: 'neutral' },
};

export function PaymentStatusPill({ status }: { status: PaymentStatus }) {
  const { label, tone } = STATUS_LABELS[status];
  return <Pill label={label} tone={tone} />;
}

export function paymentStatusLabel(status: PaymentStatus): string {
  return STATUS_LABELS[status].label;
}

export function TransactionRow({ transaction }: { transaction: Transaction }) {
  const isCredit = transaction.direction === 'credit';
  const amount = formatMoney(isCredit ? transaction.amount : `-${transaction.amount}`, transaction.currency, { showPlus: true });
  const when = formatRelativeDay(transaction.createdAt);
  const what = isCredit ? 'received' : 'sent';
  const pending = transaction.status === 'pending' ? ', pending' : transaction.status === 'cancelled' ? ', cancelled' : '';
  const Icon = transaction.kind === 'conversion' ? ArrowLeftRight : transaction.kind === 'fee' ? Receipt : isCredit ? ArrowDownLeft : ArrowUpRight;
  return (
    <ListRow
      leading={
        <IconCircle tone={isCredit ? 'positive' : 'neutral'}>
          <Icon color={isCredit ? colors.positive : colors.text} size={20} />
        </IconCircle>
      }
      title={transaction.description}
      subtitle={`${when}, ${what}${pending}`}
      accessibilityLabel={`${transaction.description}. ${when}, ${what}${pending}. ${amount}`}
      trailing={
        <AppText variant="bodyStrong" tone={isCredit ? 'positive' : 'default'}>
          {amount}
        </AppText>
      }
    />
  );
}

export function PaymentRow({ payment, onPress }: { payment: Payment; onPress?: () => void }) {
  const amount = formatMoney(payment.amount, payment.currency);
  const payee = payment.beneficiaryName ?? 'Unknown payee';
  const when = formatRelativeDay(payment.createdAt);
  return (
    <ListRow
      leading={
        <IconCircle tone={payment.status === 'awaiting_approval' ? 'warning' : 'neutral'}>
          <ArrowUpRight color={payment.status === 'awaiting_approval' ? colors.warningAccent : colors.text} size={20} />
        </IconCircle>
      }
      title={payee}
      subtitle={`${when} · ${payment.reference}`}
      onPress={onPress}
      showChevron={onPress !== undefined}
      accessibilityLabel={`${amount} to ${payee}. ${paymentStatusLabel(payment.status)}. ${when}. Reference ${payment.reference}`}
      accessibilityHint={onPress ? 'Opens the payment for review' : undefined}
      trailing={
        <View style={{ alignItems: 'flex-end', gap: 4 }}>
          <AppText variant="bodyStrong">{amount}</AppText>
          <PaymentStatusPill status={payment.status} />
        </View>
      }
    />
  );
}
