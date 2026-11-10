import { View } from 'react-native';

import { Button } from '@/components/Button';
import { Card, Divider } from '@/components/Card';
import { Header } from '@/components/Header';
import { QueryState } from '@/components/QueryState';
import { Screen } from '@/components/Screen';
import { SkeletonList } from '@/components/Skeleton';
import { EmptyState, InlineMessage } from '@/components/StateViews';
import { AppText } from '@/components/AppText';
import { userMessageFor } from '@/api/errors';
import { useAllTransactions } from '@/hooks/queries';
import { useIsOnline } from '@/lib/online';

import { TransactionRow } from './shared';

export function ActivityScreen() {
  const query = useAllTransactions();
  const online = useIsOnline();
  return (
    <Screen header={<Header title="Activity" />} onRefresh={() => void query.refetch()} refreshing={query.isRefetching && !query.isFetchingNextPage}>
      <QueryState
        query={query}
        skeleton={<SkeletonList rows={6} label="Loading activity" />}
        isEmpty={(data) => data.pages.every((page) => page.items.length === 0)}
        empty={<EmptyState title="No activity yet" body="Payments and conversions will appear here." />}
      >
        {(data) => {
          const items = data.pages.flatMap((page) => page.items);
          const total = data.pages[0]?.totalItems ?? items.length;
          return (
            <View style={{ gap: 16 }}>
              <Card padded={false}>
                {items.map((transaction, index) => (
                  <View key={transaction.id}>
                    {index > 0 ? <Divider /> : null}
                    <TransactionRow transaction={transaction} />
                  </View>
                ))}
              </Card>
              <AppText variant="caption" tone="muted" align="center">{`Showing ${items.length} of ${total}`}</AppText>
              {query.isFetchNextPageError ? <InlineMessage tone="danger">{userMessageFor(query.error)}</InlineMessage> : null}
              {query.hasNextPage ? (
                <Button
                  variant="secondary"
                  label={query.isFetchNextPageError ? 'Try again' : 'Show more'}
                  onPress={() => void query.fetchNextPage()}
                  loading={query.isFetchingNextPage}
                  disabled={!online}
                />
              ) : null}
            </View>
          );
        }}
      </QueryState>
    </Screen>
  );
}
