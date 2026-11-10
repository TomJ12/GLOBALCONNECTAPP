import { create } from 'zustand';

export interface ConfirmRequest {
  title: string;
  message: string;
  confirmLabel: string;
  cancelLabel?: string;
  tone?: 'default' | 'danger';
}

interface ConfirmState {
  current: (ConfirmRequest & { resolve: (confirmed: boolean) => void }) | null;
  settle: (confirmed: boolean) => void;
}

/** Backs the in-app confirm dialog (see components/ConfirmDialogHost). */
export const useConfirmStore = create<ConfirmState>((set, get) => ({
  current: null,
  settle: (confirmed) => {
    const current = get().current;
    if (!current) return;
    set({ current: null });
    current.resolve(confirmed);
  },
}));

/** Ask the person to confirm. Resolves false if they cancel or another dialog replaces this one. */
export function requestConfirmation(request: ConfirmRequest): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const previous = useConfirmStore.getState().current;
    previous?.resolve(false);
    useConfirmStore.setState({ current: { ...request, resolve } });
  });
}
