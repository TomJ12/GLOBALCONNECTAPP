import { create } from 'zustand';

interface ToastState {
  message: string | null;
  id: number;
  show: (message: string) => void;
  hide: (id: number) => void;
}

/** One short confirmation message at a time, for example "Copied". */
export const useToastStore = create<ToastState>((set, get) => ({
  message: null,
  id: 0,
  show: (message) => set({ message, id: get().id + 1 }),
  hide: (id) => {
    if (get().id === id) set({ message: null });
  },
}));

export function showToast(message: string): void {
  useToastStore.getState().show(message);
}
