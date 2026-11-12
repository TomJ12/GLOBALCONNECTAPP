/**
 * All server-state hooks. Screens never call the provider client directly:
 * every call goes through TanStack Query here (or in useHeldQuote), so errors
 * reach the shared handler that ends the session on a 401.
 */
import {
  useInfiniteQuery,
  useMutation,
  useQueries,
  useQuery,
  useQueryClient,
  type QueryClient,
} from '@tanstack/react-query';

import { getAlertsStore, type NewRateAlert } from '@/alerts';
import { getAuthClient, getProviderClient } from '@/api';
import type { BookConversionRequest, CodeMethod, CurrencyCode, DecimalString, NewBeneficiary, NewPayment } from '@/api/types';
import { useCapabilities, useSession } from '@/state/session';

export const queryKeys = {
  company: ['company'] as const,
  balances: ['balances'] as const,
  accountDetails: (currency: CurrencyCode) => ['accountDetails', currency] as const,
  transactions: ['transactions'] as const,
  recentTransactions: ['transactions', 'recent'] as const,
  allTransactions: ['transactions', 'all'] as const,
  rate: (base: CurrencyCode, quote: CurrencyCode) => ['rate', base, quote] as const,
  rateHistory: (base: CurrencyCode, quote: CurrencyCode) => ['rateHistory', base, quote] as const,
  beneficiaries: ['beneficiaries'] as const,
  payments: ['payments'] as const,
  pendingApprovals: ['pendingApprovals'] as const,
  forwards: ['forwards'] as const,
  alerts: (userKey: string) => ['alerts', userKey] as const,
};

const RATE_REFRESH_MS = 30_000;
const PAGE_SIZE = 10;

export function useCompanyProfile() {
  return useQuery({ queryKey: queryKeys.company, queryFn: () => getProviderClient().getCompanyProfile() });
}

export function useBalances() {
  return useQuery({ queryKey: queryKeys.balances, queryFn: () => getProviderClient().listBalances() });
}

export function useAccountDetails(currency: CurrencyCode | null) {
  return useQuery({
    queryKey: queryKeys.accountDetails(currency ?? ''),
    queryFn: () => getProviderClient().getAccountDetails(currency ?? ''),
    enabled: currency !== null,
  });
}

export function useRecentTransactions(count = 5) {
  return useQuery({
    queryKey: [...queryKeys.recentTransactions, count],
    queryFn: async () => (await getProviderClient().listTransactions({ page: 1, perPage: count })).items,
  });
}

export function useAllTransactions() {
  return useInfiniteQuery({
    queryKey: queryKeys.allTransactions,
    queryFn: ({ pageParam }) => getProviderClient().listTransactions({ page: pageParam, perPage: PAGE_SIZE }),
    initialPageParam: 1,
    getNextPageParam: (lastPage) => lastPage.nextPage ?? undefined,
  });
}

function rateQueryOptions(base: CurrencyCode, quote: CurrencyCode) {
  return {
    queryKey: queryKeys.rate(base, quote),
    queryFn: () => getProviderClient().getRate(base, quote),
    refetchInterval: RATE_REFRESH_MS,
  };
}

export function useRate(base: CurrencyCode, quote: CurrencyCode) {
  return useQuery(rateQueryOptions(base, quote));
}

/**
 * Rates from one base currency to several others, for totals.
 * `rates[c]` is undefined until that rate has loaded.
 */
export function useRatesFromBase(base: CurrencyCode, currencies: readonly CurrencyCode[]) {
  const wanted = currencies.filter((currency) => currency !== base);
  return useQueries({
    queries: wanted.map((currency) => rateQueryOptions(base, currency)),
    combine: (results) => {
      const rates: Record<CurrencyCode, DecimalString | undefined> = {};
      results.forEach((result, index) => {
        const currency = wanted[index];
        if (currency) rates[currency] = result.data?.rate;
      });
      // The oldest of the rates used, so the screen can say how fresh the total is.
      const times = results.map((result) => result.data?.asOf).filter((value): value is string => Boolean(value));
      const asOf = times.length > 0 ? times.reduce((oldest, value) => (value < oldest ? value : oldest)) : null;
      return {
        rates,
        asOf,
        isPending: results.some((result) => result.isPending),
        isError: results.some((result) => result.isError),
        isPaused: results.some((result) => result.fetchStatus === 'paused' && result.isPending),
        refetch: () => {
          results.forEach((result) => {
            if (result.isError || result.isPending) void result.refetch();
          });
        },
      };
    },
  });
}

export function useRateHistory(base: CurrencyCode, quote: CurrencyCode) {
  return useQuery({
    queryKey: queryKeys.rateHistory(base, quote),
    queryFn: () => getProviderClient().getRateHistory(base, quote),
    staleTime: 5 * 60_000,
  });
}

export function useBeneficiaries() {
  return useQuery({ queryKey: queryKeys.beneficiaries, queryFn: () => getProviderClient().listBeneficiaries() });
}

export function usePayments() {
  return useInfiniteQuery({
    queryKey: queryKeys.payments,
    queryFn: ({ pageParam }) => getProviderClient().listPayments({ page: pageParam, perPage: 25 }),
    initialPageParam: 1,
    getNextPageParam: (lastPage) => lastPage.nextPage ?? undefined,
  });
}

/**
 * Pages are fetched by page number, so a new item arriving between two fetches
 * shifts the list and the same row can come back on the next page. Show each id once.
 */
export function uniqueById<T extends { id: string }>(items: readonly T[]): T[] {
  const seen = new Set<string>();
  return items.filter((item) => (seen.has(item.id) ? false : (seen.add(item.id), true)));
}

// --- Sign-in and activation ----------------------------------------------------

/** Step 1: email and password. */
export function useSignIn() {
  return useMutation({ mutationFn: (input: { email: string; password: string }) => getAuthClient().signIn(input.email, input.password) });
}

/** Step 2: a code from the authenticator app, or a recovery code. */
export function useCompleteSignIn() {
  return useMutation({
    mutationFn: (input: { challengeId: string; code: string; method: CodeMethod }) =>
      getAuthClient().completeSignIn(input.challengeId, input.code, input.method),
  });
}

export function useSelectCompany() {
  return useMutation({ mutationFn: (companyId: string) => getAuthClient().selectCompany(companyId) });
}

export function useBeginActivation() {
  return useMutation({ mutationFn: (activationCode: string) => getAuthClient().beginActivation(activationCode) });
}

export function useSetActivationPassword() {
  return useMutation({ mutationFn: (password: string) => getAuthClient().setActivationPassword(password) });
}

export function useConfirmActivation() {
  return useMutation({ mutationFn: (code: string) => getAuthClient().confirmActivation(code) });
}

// --- Reconciliation after an unknown outcome ------------------------------------

/** Did a conversion with this idempotency key get booked? Resolves null if not. */
export function useFindConversionByKey() {
  return useMutation({ mutationFn: (idempotencyKey: string) => getProviderClient().findConversionByIdempotencyKey(idempotencyKey) });
}

/** Did a payment with this idempotency key get created? Resolves null if not. */
export function useFindPaymentByKey() {
  return useMutation({ mutationFn: (idempotencyKey: string) => getProviderClient().findPaymentByIdempotencyKey(idempotencyKey) });
}

/** Not asked for at all when the account has no payment approvals. */
export function usePendingApprovals() {
  const { paymentApprovals } = useCapabilities();
  return useQuery({
    queryKey: queryKeys.pendingApprovals,
    queryFn: () => getProviderClient().listPendingApprovals(),
    enabled: paymentApprovals,
  });
}

/** Not asked for at all when the account has no forward contracts. */
export function useForwardContracts() {
  const { forwardContracts } = useCapabilities();
  return useQuery({ queryKey: queryKeys.forwards, queryFn: () => getProviderClient().listForwardContracts(), enabled: forwardContracts });
}

/** After money moves, everything derived from balances and payments is stale. */
function invalidateMoney(client: QueryClient): Promise<unknown> {
  return Promise.all(
    [queryKeys.balances, queryKeys.transactions, queryKeys.payments, queryKeys.pendingApprovals, queryKeys.forwards].map(
      (queryKey) => client.invalidateQueries({ queryKey }),
    ),
  );
}

export function useCreateBeneficiary() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: NewBeneficiary) => getProviderClient().createBeneficiary(input),
    onSuccess: () => client.invalidateQueries({ queryKey: queryKeys.beneficiaries }),
  });
}

export function useCreatePayment() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: NewPayment) => getProviderClient().createPayment(input),
    // Refresh on error too: the request may have gone through even if the response was lost.
    onSettled: () => {
      // Not awaited: the screen shows its result at once and the lists refresh behind it.
      void invalidateMoney(client);
    },
  });
}

export function useApprovePayment() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (paymentId: string) => getProviderClient().approvePayment(paymentId),
    onSettled: () => {
      // Not awaited: the screen shows its result at once and the lists refresh behind it.
      void invalidateMoney(client);
    },
  });
}

export function useRejectPayment() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (paymentId: string) => getProviderClient().rejectPayment(paymentId),
    onSettled: () => {
      // Not awaited: the screen shows its result at once and the lists refresh behind it.
      void invalidateMoney(client);
    },
  });
}

export function useBookConversion() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (request: BookConversionRequest) => getProviderClient().bookConversion(request),
    onSettled: () => {
      // Not awaited: the screen shows its result at once and the lists refresh behind it.
      void invalidateMoney(client);
    },
  });
}

// --- Rate alerts (local feature, not the provider) ----------------------------

/** Alerts belong to the signed-in person, so the store and the cache are keyed by them. */
function useAlertsUserKey(): string {
  return useSession((state) => state.session?.user.email || state.session?.user.id || 'signed-out');
}

export function useAlerts() {
  const userKey = useAlertsUserKey();
  return useQuery({ queryKey: queryKeys.alerts(userKey), queryFn: () => getAlertsStore(userKey).list(), networkMode: 'always' });
}

export function useCreateAlert() {
  const client = useQueryClient();
  const userKey = useAlertsUserKey();
  return useMutation({
    mutationFn: (input: NewRateAlert) => getAlertsStore(userKey).create(input),
    onSettled: () => client.invalidateQueries({ queryKey: queryKeys.alerts(userKey) }),
  });
}

export function useSetAlertEnabled() {
  const client = useQueryClient();
  const userKey = useAlertsUserKey();
  return useMutation({
    mutationFn: (input: { id: string; enabled: boolean }) => getAlertsStore(userKey).setEnabled(input.id, input.enabled),
    onSettled: () => client.invalidateQueries({ queryKey: queryKeys.alerts(userKey) }),
  });
}

export function useRemoveAlert() {
  const client = useQueryClient();
  const userKey = useAlertsUserKey();
  return useMutation({
    mutationFn: (id: string) => getAlertsStore(userKey).remove(id),
    onSettled: () => client.invalidateQueries({ queryKey: queryKeys.alerts(userKey) }),
  });
}
