/** Payments that Global Connect holds until the company's approvers have approved them. */
import { fireEvent, screen } from '@testing-library/react-native';

import { getProviderClient } from '@/api';
import * as schemas from '@/api/schemas';
import type { Payment, PaymentHold, PendingApproval } from '@/api/types';
import { HomeScreen } from '@/screens/HomeScreen';
import { heldPaymentCopy } from '@/screens/NewPaymentScreen';
import { PaymentReviewScreen } from '@/screens/PaymentReviewScreen';
import { PaymentsScreen } from '@/screens/PaymentsScreen';
import { listNames, needsYourApproval, paymentStatusLabel } from '@/screens/shared';
import { installMockBackend, renderScreen, signIn } from '@/test/utils';

const expoRouter = jest.requireMock<{ __setParams: (params: Record<string, string>) => void }>('expo-router');

const hold = (overrides: Partial<PaymentHold> = {}): PaymentHold => ({
  state: 'awaiting_approval',
  createdBy: 'Cara Jones',
  createdByYou: false,
  approvalsRequired: 1,
  approvals: [],
  expiresAt: '2027-01-16T09:30:00.000Z',
  canApprove: true,
  canCancel: false,
  approvers: ['Abel Musa', 'Dana Reid'],
  ...overrides,
});
const heldPayment = (id: string, overrides: Partial<PaymentHold> = {}): Payment => ({
  id,
  shortReference: 'GC-ABCD1234',
  amount: '125.00',
  currency: 'GBP',
  beneficiaryId: 'payee-1',
  beneficiaryName: `Payee ${id}`,
  reference: 'INV-7',
  status: 'awaiting_approval',
  route: null,
  fee: null,
  estimatedArrival: null,
  createdAt: '2027-01-14T09:30:00.000Z',
  held: hold(overrides),
});
const approvalOf = (payment: Payment): PendingApproval => ({
  payment,
  beneficiary: { id: 'payee-1', name: payment.beneficiaryName ?? '', entityType: 'company', currency: 'GBP', bankCountry: 'GB', accountNumber: '12345678', sortCode: '000000', iban: null, bic: null, routingNumber: null },
  approvalsRemaining: 1,
  steps: [
    { label: `Created by ${payment.held?.createdBy}`, status: 'done', at: payment.createdAt },
    { label: 'Approval by someone else', status: payment.held?.canApprove ? 'waiting_for_you' : 'waiting', at: null },
  ],
});

const mine = heldPayment('hp_mine', { createdByYou: true, createdBy: 'You Yourself', canApprove: false, canCancel: true });
const theirs = heldPayment('hp_theirs');

describe('payments held for approval', () => {
  let cancelled: string[] = [];

  beforeEach(async () => {
    const mock = installMockBackend();
    await signIn(mock.client);
    cancelled = [];
    const client = getProviderClient();
    jest.spyOn(client, 'listPendingApprovals').mockImplementation(async () => [mine, theirs].filter((payment) => !cancelled.includes(payment.id)).map(approvalOf));
    // Only the Global Connect server holds payments, so only its client can cancel one.
    client.cancelPayment = jest.fn(async (id: string) => {
      cancelled.push(id);
    });
  });

  it('the schemas accept a held payment and the new action, and still accept a payment without a hold', () => {
    expect(schemas.payment.parse(mine).held?.canCancel).toBe(true);
    expect(schemas.payment.parse({ ...mine, held: undefined }).held).toBeUndefined();
    expect(schemas.pendingApproval.parse({ ...approvalOf(theirs), external: true }).external).toBe(true);
    expect(schemas.stepUpAction.parse('payment.cancel')).toBe('payment.cancel');
    expect(() => schemas.payment.parse({ ...mine, held: { ...mine.held, state: 'paid' } })).toThrow();
  });

  it('says who must approve, or that nobody can, and never calls a held payment sent', () => {
    expect(listNames(['A'])).toBe('A');
    expect(listNames(['A', 'B', 'C'])).toBe('A, B or C');
    const ok = heldPaymentCopy(mine);
    expect(ok?.tone).toBe('warning');
    expect(ok?.body).toMatch(/has not been sent\. It has to be approved by someone else first: Abel Musa or Dana Reid can approve it\./);
    expect(ok?.body).toMatch(/If it is not approved by 16 Jan 2027 at \d\d:\d\d it will expire/);
    const nobody = heldPaymentCopy(heldPayment('x', { approvers: [] }));
    expect(nobody?.tone).toBe('danger');
    expect(nobody?.body).toMatch(/nobody else on this account can approve payments yet\. Ask Global Connect to add an approver/);
    // Two approvals needed and only one person who could give one: said plainly too.
    expect(heldPaymentCopy(heldPayment('y', { approvalsRequired: 2, approvers: ['Abel Musa'] }))?.body).toMatch(/approved by 2 other people, and only Abel Musa can approve payments on this account/);
    expect(heldPaymentCopy({ ...mine, held: undefined })).toBeNull();
    expect(heldPaymentCopy(heldPayment('z', { state: 'expired' }))).toBeNull();
  });

  it('labels a held payment by what became of it', () => {
    expect(paymentStatusLabel(theirs)).toBe('Needs approval');
    expect(paymentStatusLabel(mine)).toBe('Waiting for approval');
    expect(paymentStatusLabel({ status: 'cancelled', held: hold({ state: 'expired' }) })).toBe('Expired, not sent');
    expect(paymentStatusLabel({ status: 'cancelled', held: hold({ state: 'payee_changed' }) })).toBe('Payee changed, not sent');
    expect(paymentStatusLabel({ status: 'cancelled', held: hold({ state: 'rejected' }) })).toBe('Rejected');
    expect(paymentStatusLabel({ status: 'processing', held: hold({ state: 'sending' }) })).toBe('Approved, sending');
    expect(paymentStatusLabel({ status: 'cancelled' })).toBe('Cancelled');
    expect(needsYourApproval(approvalOf(mine))).toBe(false);
    expect(needsYourApproval(approvalOf(theirs))).toBe(true);
    expect(needsYourApproval({ ...approvalOf(theirs), payment: { ...theirs, held: undefined } })).toBe(true);
  });

  it('Payments: what needs MY approval is apart from what I created and am waiting on', async () => {
    await renderScreen(<PaymentsScreen />);
    expect(await screen.findByText('Payee hp_theirs')).toBeOnTheScreen();
    expect(screen.getByText('Waiting for someone else')).toBeOnTheScreen();
    expect(screen.getByText('Payee hp_mine')).toBeOnTheScreen();
    expect(screen.getByText('Needs approval')).toBeOnTheScreen();
    expect(screen.getByText('Waiting for approval')).toBeOnTheScreen();
  });

  it('Home: the banner counts only what I am asked to approve', async () => {
    await renderScreen(<HomeScreen />);
    expect(await screen.findByText('1 payment needs your approval')).toBeOnTheScreen();
  });

  it('the creator sees who can approve and until when, is NOT offered Approve or Reject, and can cancel', async () => {
    expoRouter.__setParams({ id: mine.id });
    await renderScreen(<PaymentReviewScreen />);
    expect(await screen.findByText('Waiting for approval')).toBeOnTheScreen();
    expect(screen.getByText('You created it, so someone else has to approve it: Abel Musa or Dana Reid can.')).toBeOnTheScreen();
    expect(screen.getByText(/has not been sent, and no money has been set aside/)).toBeOnTheScreen();
    expect(screen.getByText(/If it is not approved by 16 Jan 2027 at \d\d:\d\d it expires and is not sent\./)).toBeOnTheScreen();
    expect(screen.queryByTestId('approve-button')).not.toBeOnTheScreen();
    expect(screen.queryByTestId('reject-button')).not.toBeOnTheScreen();

    await fireEvent.press(screen.getByTestId('cancel-button'));
    expect(await screen.findByText('Cancel this payment?')).toBeOnTheScreen();
    await fireEvent.press(screen.getByTestId('confirm-dialog-confirm'));
    expect(await screen.findByTestId('review-outcome-title')).toHaveTextContent('Cancelled');
    expect(getProviderClient().cancelPayment).toHaveBeenCalledWith(mine.id);
    expect(screen.getByText('The payment was cancelled before it was sent. No money has left your account.')).toBeOnTheScreen();
  });

  it('an approver sees who created it and the masked account, can approve or reject, and is not offered Cancel', async () => {
    expoRouter.__setParams({ id: theirs.id });
    await renderScreen(<PaymentReviewScreen />);
    expect(await screen.findByText('Created by Cara Jones')).toBeOnTheScreen();
    expect(screen.getByText('•••• 5678')).toBeOnTheScreen();
    expect(screen.queryByText('12345678')).not.toBeOnTheScreen();
    expect(screen.getByTestId('approve-button')).toBeEnabled();
    expect(screen.getByTestId('reject-button')).toBeEnabled();
    expect(screen.queryByTestId('cancel-button')).not.toBeOnTheScreen();
  });

  it('a creator with nobody to approve is told so on the payment itself', async () => {
    const stuck = heldPayment('hp_stuck', { createdByYou: true, canApprove: false, canCancel: true, approvers: [] });
    jest.spyOn(getProviderClient(), 'listPendingApprovals').mockResolvedValue([approvalOf(stuck)]);
    expoRouter.__setParams({ id: stuck.id });
    await renderScreen(<PaymentReviewScreen />);
    expect(await screen.findByText(/nobody else on this account can approve payments yet\. Ask Global Connect to add an approver\./)).toBeOnTheScreen();
  });

  it('a payment that was already pending elsewhere is marked as not held by Global Connect', async () => {
    const outside: PendingApproval = { ...approvalOf({ ...theirs, id: 'outside', held: undefined }), external: true };
    jest.spyOn(getProviderClient(), 'listPendingApprovals').mockResolvedValue([outside]);
    expoRouter.__setParams({ id: 'outside' });
    await renderScreen(<PaymentReviewScreen />);
    expect(await screen.findByText(/It is not held by Global Connect, and it cannot be cancelled here\./)).toBeOnTheScreen();
    expect(screen.getByTestId('approve-button')).toBeOnTheScreen();
    expect(screen.queryByTestId('cancel-button')).not.toBeOnTheScreen();
  });
});
