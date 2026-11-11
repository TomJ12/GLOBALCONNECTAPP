import { QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react-native';
import type { ReactNode } from 'react';

import { getProviderClient } from '@/api';
import type { Quote, QuoteRequest } from '@/api/types';
import { useHeldQuote } from '@/hooks/useHeldQuote';
import { createQueryClient } from '@/lib/queryClient';
import { installMockBackend, signIn } from '@/test/utils';

const request = (amount: string): QuoteRequest => ({ kind: 'spot', sellCurrency: 'GBP', buyCurrency: 'USD', fixedSide: 'sell', amount });

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((res) => (resolve = res));
  return { promise, resolve };
}

async function mount(initial: QuoteRequest | null) {
  const queryClient = createQueryClient({ forTests: true });
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  return renderHook(({ value }: { value: QuoteRequest | null }) => useHeldQuote(value), { initialProps: { value: initial }, wrapper });
}

describe('useHeldQuote', () => {
  beforeEach(async () => {
    const mock = installMockBackend();
    await signIn(mock.client);
  });

  it('ignores a slow answer to an older request', async () => {
    const client = getProviderClient();
    const real = client.createQuote.bind(client);
    const slow = deferred<Quote>();
    jest
      .spyOn(client, 'createQuote')
      .mockImplementationOnce(() => slow.promise)
      .mockImplementation(real);

    const hook = await mount(request('100.00'));
    await waitFor(() => expect(client.createQuote).toHaveBeenCalledTimes(1));
    await hook.rerender({ value: request('200.00') });
    await waitFor(() => expect(hook.result.current.quote?.sellAmount).toBe('200.00'));

    // The answer for 100 arrives late. It must not replace the quote for 200.
    await act(async () => slow.resolve(await real(request('100.00'))));
    expect(hook.result.current.quote?.sellAmount).toBe('200.00');
    expect(hook.result.current.quote?.buyAmount).toBe('260.00');
  });

  it('never offers the quote of an earlier request again, even if the same request comes back', async () => {
    const hook = await mount(request('100.00'));
    await waitFor(() => expect(hook.result.current.quote).not.toBeNull());
    const firstId = hook.result.current.quote?.id;

    await hook.rerender({ value: null });
    expect(hook.result.current.quote).toBeNull();
    await hook.rerender({ value: request('100.00') });
    // Nothing is shown until a fresh quote arrives.
    expect(hook.result.current.quote).toBeNull();
    expect(hook.result.current.isFetching).toBe(true);
    await waitFor(() => expect(hook.result.current.quote).not.toBeNull());
    expect(hook.result.current.quote?.id).not.toBe(firstId);
  });

  it('debounces typing into one request', async () => {
    const spy = jest.spyOn(getProviderClient(), 'createQuote');
    const hook = await mount(request('1.00'));
    await hook.rerender({ value: request('12.00') });
    await hook.rerender({ value: request('123.00') });
    await waitFor(() => expect(hook.result.current.quote?.sellAmount).toBe('123.00'));
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('reports an error and keeps no quote when quoting fails', async () => {
    const hook = await mount({ ...request('1.00'), buyCurrency: 'XXX' });
    await waitFor(() => expect(hook.result.current.error?.kind).toBe('validation'));
    expect(hook.result.current.quote).toBeNull();
    expect(hook.result.current.isFetching).toBe(false);
  });
});
