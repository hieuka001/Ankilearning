import { useEffect, useMemo, useRef, useState } from 'react';
import type { User } from 'firebase/auth';
import {
  ACTIVE_TIME_FLUSH_SECONDS,
  DEFAULT_TIMEZONE,
  ONLINE_INACTIVE_TIMEOUT_MS,
  getTodayKey,
} from '../lib/gamification';
import {
  ensureDailyMissions,
  ensureLeaderboardEntry,
  flushGamificationQueue,
  subscribeDailyMissions,
  subscribeLeaderboard,
  trackActiveStudyTime,
} from '../services/gamificationService';
import { gamificationStore, useGamificationStore } from '../gamification/gamificationStore';

export function useGamification(user: User | null, timezone = DEFAULT_TIMEZONE) {
  const missionDoc = useGamificationStore((state) => state.missionDoc);
  const leaderboard = useGamificationStore((state) => state.leaderboard);
  const loading = useGamificationStore((state) => state.loading);
  const lastError = useGamificationStore((state) => state.lastError);
  const userId = user?.uid;
  const [todayKey, setTodayKey] = useState(() => getTodayKey(timezone));

  useEffect(() => {
    setTodayKey(getTodayKey(timezone));
    const timer = window.setInterval(() => {
      setTodayKey((currentKey) => {
        const nextKey = getTodayKey(timezone);
        return currentKey === nextKey ? currentKey : nextKey;
      });
    }, 60_000);

    return () => window.clearInterval(timer);
  }, [timezone]);

  useEffect(() => {
    if (!userId) {
      gamificationStore.reset();
      return;
    }

    gamificationStore.setState({ loading: true, lastError: null });

    ensureDailyMissions(userId, timezone).catch((error) => {
      console.warn('Daily missions initialization failed.', error);
      gamificationStore.setState({ loading: false, lastError: 'Không thể tải nhiệm vụ ngày.' });
    });
    ensureLeaderboardEntry(userId).catch((error) => console.warn('Leaderboard profile sync failed.', error));
    flushGamificationQueue().catch((error) => console.warn('Gamification queue sync failed.', error));

    const unsubscribeMissions = subscribeDailyMissions(userId, (nextMissionDoc) => {
      gamificationStore.setState({ missionDoc: nextMissionDoc, loading: false });
    }, timezone);

    const unsubscribeLeaderboard = subscribeLeaderboard((entries) => {
      gamificationStore.setState({ leaderboard: entries });
    });

    return () => {
      unsubscribeMissions();
      unsubscribeLeaderboard();
    };
  }, [timezone, todayKey, userId]);

  useActiveTimeTracker(userId || null, timezone);

  return useMemo(() => ({
    missionDoc,
    leaderboard,
    loading,
    lastError,
  }), [leaderboard, lastError, loading, missionDoc]);
}

function useActiveTimeTracker(userId: string | null, timezone: string) {
  const lastInteractionRef = useRef(Date.now());
  const activeSecondsRef = useRef(0);
  const flushInFlightRef = useRef(false);

  useEffect(() => {
    if (!userId || typeof window === 'undefined' || typeof document === 'undefined') return;

    const markInteraction = () => {
      lastInteractionRef.current = Date.now();
    };

    const flush = async () => {
      if (flushInFlightRef.current || activeSecondsRef.current < ACTIVE_TIME_FLUSH_SECONDS) return;

      const seconds = activeSecondsRef.current;
      activeSecondsRef.current = 0;
      flushInFlightRef.current = true;

      try {
        await trackActiveStudyTime(userId, seconds, timezone);
      } catch (error) {
        activeSecondsRef.current += seconds;
        console.warn('Active study time sync failed.', error);
      } finally {
        flushInFlightRef.current = false;
      }
    };

    const interactionEvents: Array<keyof WindowEventMap> = [
      'click',
      'keydown',
      'mousemove',
      'scroll',
      'touchstart',
    ];

    interactionEvents.forEach((eventName) => {
      window.addEventListener(eventName, markInteraction, { passive: true });
    });

    const timer = window.setInterval(() => {
      const isVisible = document.visibilityState === 'visible' && document.hasFocus();
      const isActive = Date.now() - lastInteractionRef.current <= ONLINE_INACTIVE_TIMEOUT_MS;

      if (isVisible && isActive) {
        activeSecondsRef.current += 5;
        void flush();
      }
    }, 5000);

    const handleBeforeUnload = () => {
      void flush();
    };

    window.addEventListener('beforeunload', handleBeforeUnload);

    return () => {
      window.clearInterval(timer);
      interactionEvents.forEach((eventName) => {
        window.removeEventListener(eventName, markInteraction);
      });
      window.removeEventListener('beforeunload', handleBeforeUnload);
      void flush();
    };
  }, [timezone, userId]);
}
