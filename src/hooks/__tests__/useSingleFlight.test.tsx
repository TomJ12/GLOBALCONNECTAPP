import { act, renderHook } from '@testing-library/react-native';

import { useToastStore } from '@/state/toast';

import { useSingleFlight } from '../useSingleFlight';

describe('useSingleFlight', () => {
  it('ignores calls while one is running, then allows the next', async () => {
    let release: () => void = () => undefined;
    const action = jest.fn(() => new Promise<void>((resolve) => (release = resolve)));
    const { result } = await renderHook(() => useSingleFlight(action));

    await act(async () => {
      result.current.run();
      result.current.run();
      result.current.run();
    });
    expect(action).toHaveBeenCalledTimes(1);
    expect(result.current.busy).toBe(true);

    await act(async () => release());
    expect(result.current.busy).toBe(false);
    await act(async () => result.current.run());
    expect(action).toHaveBeenCalledTimes(2);
    await act(async () => release());
  });

  it('unlocks after a failure and reports it instead of swallowing it', async () => {
    const logged = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const failure = new Error('boom');
    const action = jest.fn().mockRejectedValueOnce(failure).mockResolvedValue(undefined);
    const { result } = await renderHook(() => useSingleFlight(action));
    await act(async () => result.current.run());
    expect(result.current.busy).toBe(false);
    expect(logged).toHaveBeenCalledWith(expect.any(String), failure);
    expect(useToastStore.getState().message).toMatch(/unexpected/i);

    await act(async () => result.current.run());
    expect(action).toHaveBeenCalledTimes(2);
  });
});
