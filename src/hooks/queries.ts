/** All server-state hooks. Screens never call the provider client directly. */
import {
  useInfiniteQuery,
  useMutation,
  useQueries,
  useQuery,
  useQueryClient,
  type QueryClient,
} from '@tanstack/react-query';

import { getAlertsStore, type NewRateAlert } from '@/alerts';
import { getProviderClient } from '@/api';
import type { BookConversionRequest, CurrencyCode, DecimalString, NewBeneficiary, NewPayment } from '@/api/types';

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
  alerts: ['alerts'] as const,
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
      return {
        rates,
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
  return useQuery({
    queryKey: queryKeys.payments,
    queryFn: async () => (await getProviderClient().listPayments({ page: 1, perPage: 25 })).items,
  });
}

export function usePendingApprovals() {
  return useQuery({
    queryKey: queryKeys.pendingApprovals,
    queryFn: () => getProviderClient().listPendingApprovals(),
  });
}

export function useForwardContracts() {
  return useQuery({ queryKey: queryKeys.forwards, queryFn: () => getProviderClient().listForwardContracts() });
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

export function useAlerts() {
  return useQuery({ queryKey: queryKeys.alerts, queryFn: () => getAlertsStore().list(), networkMode: 'always' });
}

export function useCreateAlert() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: NewRateAlert) => getAlertsStore().create(input),
    onSettled: () => client.invalidateQueries({ queryKey: queryKeys.alerts }),
  });
}

export function useSetAlertEnabled() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { id: string; enabled: boolean }) => getAlertsStore().setEnabled(input.id, input.enabled),
    onSettled: () => client.invalidateQueries({ queryKey: queryKeys.alerts }),
  });
}

export function useRemoveAlert() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => getAlertsStore().remove(id),
    onSettled: () => client.invalidateQueries({ queryKey: queryKeys.alerts }),
  });
}
