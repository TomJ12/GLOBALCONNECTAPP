import type { ReactNode } from 'react';

import { ErrorState, OfflineState } from './StateViews';

/** The parts of a TanStack query result this component needs. */
export interface QueryLike<T> {
  data: T | undefined;
  error: unknown;
  isPending: boolean;
  isError: boolean;
  isFetching: boolean;
  fetchStatus: 'fetching' | 'paused' | 'idle';
  refetch: () => unknown;
}

export interface QueryStateProps<T> {
  query: QueryLike<T>;
  /** Shown while the first load is in flight. */
  skeleton: ReactNode;
  /** Return true when the loaded data has nothing to show. */
  isEmpty?: (data: T) => boolean;
  empty?: ReactNode;
  children: (data: T) => ReactNode;
}

/**
 * One place that decides between the four states every data view needs:
 * loading (skeleton), offline with nothing cached, error with retry, and empty.
 * Cached data keeps showing during a background refresh or after a failed one.
 */
export function QueryState<T>({ query, skeleton, isEmpty, empty, children }: QueryStateProps<T>) {
  if (query.data !== undefined) {
    if (isEmpty?.(query.data) && empty) return <>{empty}</>;
    return <>{children(query.data)}</>;
  }
  if (query.isError) {
    return <ErrorState error={query.error} onRetry={() => void query.refetch()} retrying={query.isFetching} />;
  }
  if (query.fetchStatus === 'paused') return <OfflineState />;
  return <>{skeleton}</>;
}
