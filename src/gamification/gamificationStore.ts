import { useSyncExternalStore } from 'react';
import type { DailyMissionDocument, LeaderboardEntry } from '../types';

export interface GamificationState {
  missionDoc: DailyMissionDocument | null;
  leaderboard: Array<LeaderboardEntry & { rank?: number }>;
  loading: boolean;
  lastError: string | null;
}

const initialState: GamificationState = {
  missionDoc: null,
  leaderboard: [],
  loading: true,
  lastError: null,
};

let state = initialState;
const listeners = new Set<() => void>();

function emit() {
  listeners.forEach((listener) => listener());
}

export const gamificationStore = {
  getState: () => state,
  setState: (patch: Partial<GamificationState>) => {
    state = { ...state, ...patch };
    emit();
  },
  reset: () => {
    state = initialState;
    emit();
  },
  subscribe: (listener: () => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};

export function useGamificationStore<T>(selector: (value: GamificationState) => T): T {
  return useSyncExternalStore(
    gamificationStore.subscribe,
    () => selector(gamificationStore.getState()),
    () => selector(initialState)
  );
}
