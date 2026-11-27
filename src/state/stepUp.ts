import { create } from 'zustand';

export interface StepUpRequest {
  /** What the code is for, repeated from the review step. */
  summary: string;
  /** Exchange the code for permission. Rejects with a ProviderError if the code is not accepted. */
  authorize: (code: string) => Promise<void>;
}

interface StepUpState {
  current: (StepUpRequest & { id: number; resolve: (authorized: boolean) => void }) | null;
  settle: (authorized: boolean) => void;
}

/** Backs the authenticator-code dialog (see components/Overlays). */
export const useStepUpStore = create<StepUpState>((set, get) => ({
  current: null,
  settle: (authorized) => {
    const current = get().current;
    if (!current) return;
    set({ current: null });
    current.resolve(authorized);
  },
}));

let nextId = 0;

/** Ask for an authenticator code. Resolves true once a code was accepted, false if the person cancels. */
export function requestStepUpCode(request: StepUpRequest): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    useStepUpStore.getState().current?.resolve(false);
    nextId += 1;
    useStepUpStore.setState({ current: { ...request, id: nextId, resolve } });
  });
}
