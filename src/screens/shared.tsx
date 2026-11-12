/** Small pieces shared by more than one screen. */
import { ArrowDownLeft, ArrowLeftRight, ArrowUpRight, Receipt } from 'lucide-react-native';
import { View } from 'react-native';

import type { Beneficiary, Payment, PaymentHoldState, PaymentStatus, PendingApproval, Transaction } from '@/api/types';
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

/** "•••• 4471": never more than the last four characters of an account identifier. */
export function maskAccountIdentifier(value: string | null): string | null {
  if (!value) return null;
  const compact = value.replace(/\s+/g, '');
  return compact.length >= 4 ? `•••• ${compact.slice(-4)}` : '••••';
}

const STATUS_LABELS: Record<PaymentStatus, { label: string; tone: PillTone }> = {
  awaiting_approval: { label: 'Needs approval', tone: 'warning' },
  processing: { label: 'Processing', tone: 'tint' },
  sent: { label: 'Sent', tone: 'positive' },
  failed: { label: 'Failed', tone: 'danger' },
  cancelled: { label: 'Cancelled', tone: 'neutral' },
  unknown: { label: 'Status unknown', tone: 'warning' },
};

/** Whether this person is being asked to approve it. A payment they created, or have already approved, is waiting for someone else. */
export const needsYourApproval = (approval: PendingApproval): boolean => (approval.payment.held ? approval.payment.held.canApprove : true);

/** "A", "A or B", "A, B or C". */
export function listNames(names: string[]): string {
  return names.length <= 1 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} or ${names[names.length - 1]}`;
}

/** A payment Global Connect held for approval says more exactly what became of it. */
const HOLD_LABELS: Record<PaymentHoldState, { label: string; tone: PillTone }> = {
  awaiting_approval: { label: 'Waiting for approval', tone: 'warning' },
  sending: { label: 'Approved, sending', tone: 'tint' },
  rejected: { label: 'Rejected', tone: 'neutral' },
  cancelled: { label: 'Cancelled', tone: 'neutral' },
  expired: { label: 'Expired, not sent', tone: 'neutral' },
  payee_changed: { label: 'Payee changed, not sent', tone: 'danger' },
  failed: { label: 'Failed', tone: 'danger' },
};
const statusOf = (payment: Pick<Payment, 'status' | 'held'>) =>
  payment.held ? (payment.held.state === 'awaiting_approval' && payment.held.canApprove ? STATUS_LABELS.awaiting_approval : HOLD_LABELS[payment.held.state]) : STATUS_LABELS[payment.status];

export function PaymentStatusPill({ payment }: { payment: Pick<Payment, 'status' | 'held'> }) {
  const { label, tone } = statusOf(payment);
  return <Pill label={label} tone={tone} />;
}

export function paymentStatusLabel(payment: Pick<Payment, 'status' | 'held'>): string {
  return statusOf(payment).label;
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
      accessibilityLabel={`${amount} to ${payee}. ${paymentStatusLabel(payment)}. ${when}. Reference ${payment.reference}`}
      accessibilityHint={onPress ? 'Opens the payment for review' : undefined}
      trailing={
        <View style={{ alignItems: 'flex-end', gap: 4 }}>
          <AppText variant="bodyStrong">{amount}</AppText>
          <PaymentStatusPill payment={payment} />
        </View>
      }
    />
  );
}
