import { MutationCache, QueryCache, QueryClient } from '@tanstack/react-query';

import { isProviderError } from '@/api/errors';

type UnauthorizedHandler = () => void;
let onUnauthorized: UnauthorizedHandler | null = null;

/** The session store registers itself here so an expired session signs the person out everywhere. */
export function setUnauthorizedHandler(handler: UnauthorizedHandler | null): void {
  onUnauthorized = handler;
}

function handleError(error: unknown): void {
  if (isProviderError(error) && error.kind === 'unauthorized') onUnauthorized?.();
}

export function createQueryClient(options: { retry?: boolean } = {}): QueryClient {
  const retry = options.retry ?? true;
  return new QueryClient({
    queryCache: new QueryCache({ onError: handleError }),
    mutationCache: new MutationCache({ onError: handleError }),
    defaultOptions: {
      queries: {
        staleTime: 15_000,
        // One automatic retry, and only for failures that might pass on a second try.
        retry: (failureCount, error) => retry && failureCount < 1 && isProviderError(error) && error.retryable,
        retryDelay: 600,
        refetchOnWindowFocus: false,
      },
      mutations: {
        // Never retry or queue anything that moves money. The person decides.
        retry: false,
        networkMode: 'always',
      },
    },
  });
}

export const queryClient = createQueryClient();
