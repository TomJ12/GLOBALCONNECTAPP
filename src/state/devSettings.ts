import { create } from 'zustand';

import { sanitizeMockControls, type MockControls } from '@/api/mockControls';
import { initialMockControls } from '@/config/env';

interface DevSettingsState {
  controls: MockControls;
  setControls: (patch: Partial<MockControls>) => void;
  resetControls: () => void;
}

/** Developer settings that drive the mock backend. Read on every mock request. */
export const useDevSettings = create<DevSettingsState>((set) => ({
  controls: initialMockControls(),
  setControls: (patch) => set((state) => ({ controls: sanitizeMockControls({ ...state.controls, ...patch }) })),
  resetControls: () => set({ controls: initialMockControls() }),
}));
