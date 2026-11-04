import {
  collection,
  doc,
  runTransaction,
} from 'firebase/firestore';
import { db } from '../firebase';
import type { UserProfile } from '../types';
import {
  getPendingGamificationEvents,
  markGamificationEventFailed,
  markGamificationEventsSynced,
  saveGamificationEvent,
  type GamificationQueueRecord,
} from '../review/localDB';
import {
  DEFAULT_TIMEZONE,
  MAX_REVIEWS_PER_SPAM_WINDOW,
  MIN_REVIEW_DELAY_MS,
  QUIZ_COOLDOWN_MS,
  REVIEW_SPAM_WINDOW_MS,
  XP_PER_CORRECT_BONUS,
  XP_PERFECT_QUIZ_BONUS,
  XP_PER_QUIZ,
  XP_PER_REVIEW,
  computeStreakOnActivity,
  getNewlyUnlockedBadges,
  getTodayKey,
  getUnlockedBadges,
  levelForXp,
  type BadgeUnlock,
} from '../lib/gamification';

interface ActivityInput {
  logCollection: 'review_logs' | 'quiz_logs';
  logData: Record<string, unknown>;
  /** TOTAL cards reviewed in this activity (right + wrong). */
  cardsReviewed?: number;
  /** Subset of cardsReviewed answered correctly (drives bonus XP). */
  correctCount?: number;
  quizzesCompleted?: number;
  /** True when the quiz finished with a 100% score. */
  perfectQuiz?: boolean;
  /** Study time to add to totalStudyTimeMinutes, when the caller knows it. */
  studyMinutes?: number;
  forceCooldownKey?: 'quiz';
}

interface ActivityResult {
  antiCheatFlags: string[];
  /** Badges unlocked by THIS activity (empty when none / when queued offline). */
  newBadges: BadgeUnlock[];
  /** XP granted by this activity (0 when blocked by cooldown / queued). */
  xpEarned: number;
}

export interface ReviewActivityInput {
  /** TOTAL cards reviewed (right + wrong). */
  cardsReviewed: number;
  correctCount?: number;
  /** Optional study time (minutes) to add to the lifetime total. */
  studyMinutes?: number;
  source?: string;
}

export interface QuizActivityInput {
  score: number;
  totalQuestions: number;
  durationSeconds: number;
  mode: string;
  deckIds?: string[];
}

/** Event name App.tsx listens to in order to celebrate a freshly unlocked badge. */
export const BADGE_UNLOCKED_EVENT = 'ankilearning:badge';

const userRef = (userId: string) => doc(db, 'users', userId);
let isFlushingGamification = false;

function numberValue(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function emitBadgeEvents(newBadges: BadgeUnlock[]) {
  if (typeof window === 'undefined' || newBadges.length === 0) return;
  newBadges.forEach((badge) => {
    try {
      window.dispatchEvent(new CustomEvent<BadgeUnlock>(BADGE_UNLOCKED_EVENT, { detail: badge }));
    } catch (error) {
      console.warn('Badge event dispatch failed.', error);
    }
  });
}

function profileStats(userData: Partial<UserProfile>) {
  const streakDays = numberValue(userData.streakDays, numberValue(userData.streak));
  const totalCardsReviewed = numberValue(userData.totalCardsReviewed, numberValue(userData.totalCardsLearned));
  const totalQuizzesCompleted = numberValue(userData.totalQuizzesCompleted);
  const totalStudyTimeMinutes = numberValue(userData.totalStudyTimeMinutes);
  const xp = numberValue((userData as { xp?: number }).xp);

  return {
    streakDays,
    totalCardsReviewed,
    totalQuizzesCompleted,
    totalStudyTimeMinutes,
    xp,
  };
}

async function trackActivity(userId: string, input: ActivityInput, timezone = DEFAULT_TIMEZONE): Promise<ActivityResult> {
  const now = new Date();
  const nowIso = now.toISOString();
  const dateKey = getTodayKey(timezone, now);
  const antiCheatFlags: string[] = [];

  const cardsReviewed = Math.max(0, Math.floor(input.cardsReviewed || 0));
  const correctCount = Math.min(cardsReviewed, Math.max(0, Math.floor(input.correctCount ?? 0)));
  let quizzesCompleted = Math.max(0, Math.floor(input.quizzesCompleted || 0));
  const studyMinutes = Math.max(0, numberValue(input.studyMinutes));

  if (cardsReviewed > MAX_REVIEWS_PER_SPAM_WINDOW * 10) {
    antiCheatFlags.push('large_review_batch');
  }

  return runTransaction(db, async (transaction) => {
    const profileSnap = await transaction.get(userRef(userId));
    const userData = profileSnap.exists() ? profileSnap.data() as Partial<UserProfile> : {};

    if (input.forceCooldownKey === 'quiz' && userData.lastQuizCompletedAt) {
      const elapsed = now.getTime() - new Date(userData.lastQuizCompletedAt).getTime();
      if (elapsed >= 0 && elapsed < QUIZ_COOLDOWN_MS) {
        antiCheatFlags.push('quiz_cooldown');
        quizzesCompleted = 0;
      }
    }

    const profileUpdatedAt = (userData as { updatedAt?: string | number | Date }).updatedAt;

    // Anti-spam (MIN_REVIEW_DELAY_MS / REVIEW_SPAM_WINDOW_MS): queue records
    // carry no trustworthy per-review timestamps, so sub-1.2s gaps between
    // individual reviews cannot be reconstructed after the fact. What CAN be
    // enforced at this layer: a batch larger than the per-window cap arriving
    // within one spam window of the previous recorded activity is flagged in
    // the log. Counting is intentionally NOT capped here — legitimate offline
    // sync batches can be large, and dropping them would corrupt totals.
    if (cardsReviewed > MAX_REVIEWS_PER_SPAM_WINDOW && profileUpdatedAt) {
      const elapsedSinceLast = now.getTime() - new Date(profileUpdatedAt).getTime();
      if (elapsedSinceLast >= 0 && elapsedSinceLast < REVIEW_SPAM_WINDOW_MS) {
        antiCheatFlags.push('spam_window_batch');
      }
    }
    // A follow-up batch arriving less than MIN_REVIEW_DELAY_MS after the
    // previous recorded activity means its reviews were tapped faster than
    // the minimum plausible per-review delay.
    if (cardsReviewed >= 2 && profileUpdatedAt) {
      const elapsedSinceLast = now.getTime() - new Date(profileUpdatedAt).getTime();
      if (elapsedSinceLast >= 0 && elapsedSinceLast < MIN_REVIEW_DELAY_MS) {
        antiCheatFlags.push('review_too_fast');
      }
    }

    const previousStats = profileStats(userData);
    const existingBadges = (userData.badges || userData.achievements || []) as BadgeUnlock[];

    // Streak: ONE rule for every write path (computeStreakOnActivity), and
    // both profile fields are always written with the same value.
    const hasActivity = cardsReviewed > 0 || quizzesCompleted > 0;
    const streak = hasActivity
      ? computeStreakOnActivity(
          { streakDays: previousStats.streakDays, lastStudyDate: userData.lastStudyDate },
          now,
          timezone,
        )
      : null;

    // The rules whitelist has no dedicated perfect-quiz counter field, so the
    // count is derived from badge ownership (threshold for the badge is 1,
    // which is all the stats need).
    const previousPerfectQuizzes = existingBadges.some((badge) => badge.id === 'perfect_quiz') ? 1 : 0;
    const perfectQuizzesCompleted = previousPerfectQuizzes + (input.perfectQuiz && quizzesCompleted > 0 ? 1 : 0);

    const nextStats = {
      streakDays: streak ? streak.streakDays : previousStats.streakDays,
      totalCardsReviewed: previousStats.totalCardsReviewed + cardsReviewed,
      totalQuizzesCompleted: previousStats.totalQuizzesCompleted + quizzesCompleted,
      totalStudyTimeMinutes: previousStats.totalStudyTimeMinutes + studyMinutes,
      perfectQuizzesCompleted,
      xp: previousStats.xp,
    };

    const xpEarned =
      cardsReviewed * XP_PER_REVIEW +
      correctCount * XP_PER_CORRECT_BONUS +
      (quizzesCompleted > 0 ? XP_PER_QUIZ : 0) +
      (input.perfectQuiz && quizzesCompleted > 0 ? XP_PERFECT_QUIZ_BONUS : 0);
    nextStats.xp = previousStats.xp + xpEarned;

    const badges = getUnlockedBadges(nextStats, existingBadges, now);
    const newBadges = getNewlyUnlockedBadges(nextStats, existingBadges, now);

    transaction.set(userRef(userId), {
      ...(streak
        ? {
            streak: streak.streakDays,
            streakDays: streak.streakDays,
            lastStudyDate: nowIso,
          }
        : {}),
      totalCardsReviewed: nextStats.totalCardsReviewed,
      totalCardsLearned: nextStats.totalCardsReviewed,
      totalQuizzesCompleted: nextStats.totalQuizzesCompleted,
      totalStudyTimeMinutes: nextStats.totalStudyTimeMinutes,
      xp: nextStats.xp,
      level: levelForXp(nextStats.xp),
      lastQuizCompletedAt: input.forceCooldownKey === 'quiz' && quizzesCompleted > 0 ? nowIso : userData.lastQuizCompletedAt || '',
      badges,
      achievements: badges,
      updatedAt: nowIso,
    }, { merge: true });

    const logRef = doc(collection(db, input.logCollection));
    transaction.set(logRef, {
      id: logRef.id,
      userId,
      dateKey,
      createdAt: nowIso,
      antiCheatFlags,
      ...input.logData,
    });

    return { antiCheatFlags, newBadges, xpEarned };
  });
}

async function trackActivityWithOfflineQueue(
  userId: string,
  kind: GamificationQueueRecord['kind'],
  payload: Record<string, unknown>,
  input: ActivityInput,
  timezone = DEFAULT_TIMEZONE
): Promise<ActivityResult> {
  try {
    const result = await trackActivity(userId, input, timezone);
    emitBadgeEvents(result.newBadges);
    return result;
  } catch (error) {
    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      await saveGamificationEvent({
        id: `${userId}-${kind}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        userId,
        kind,
        payload,
        timezone,
        status: 'pending',
        createdAt: new Date().toISOString(),
        error: error instanceof Error ? error.message : String(error),
      });

      return { antiCheatFlags: ['queued_offline'], newBadges: [], xpEarned: 0 };
    }

    throw error;
  }
}

export function trackReviewActivity(userId: string, input: ReviewActivityInput, timezone = DEFAULT_TIMEZONE) {
  const cardsReviewed = Math.max(0, Math.floor(input.cardsReviewed));
  const correctCount = Math.min(cardsReviewed, Math.max(0, Math.floor(input.correctCount ?? cardsReviewed)));

  const activityInput: ActivityInput = {
    logCollection: 'review_logs',
    // TOTAL reviewed cards drive totalCardsReviewed; correctCount is kept
    // separate and only drives bonus XP + the log payload.
    cardsReviewed,
    correctCount,
    studyMinutes: input.studyMinutes,
    logData: {
      type: 'review_batch',
      source: input.source || 'study',
      cardsReviewed,
      correctCount,
    },
  };

  return trackActivityWithOfflineQueue(userId, 'review', {
    cardsReviewed,
    correctCount,
    studyMinutes: input.studyMinutes,
    source: input.source || 'study',
  }, activityInput, timezone);
}

export function trackQuizCompletion(userId: string, input: QuizActivityInput, timezone = DEFAULT_TIMEZONE) {
  const perfectQuiz = input.totalQuestions > 0 && input.score >= input.totalQuestions;

  const activityInput: ActivityInput = {
    logCollection: 'quiz_logs',
    quizzesCompleted: 1,
    perfectQuiz,
    studyMinutes: Math.max(0, input.durationSeconds || 0) / 60,
    forceCooldownKey: 'quiz',
    logData: {
      type: 'quiz_completion',
      score: input.score,
      totalQuestions: input.totalQuestions,
      perfect: perfectQuiz,
      durationSeconds: input.durationSeconds,
      mode: input.mode,
      deckIds: input.deckIds || [],
    },
  };

  return trackActivityWithOfflineQueue(userId, 'quiz', { ...input }, activityInput, timezone);
}

export async function flushGamificationQueue() {
  if (isFlushingGamification || (typeof navigator !== 'undefined' && !navigator.onLine)) return;
  isFlushingGamification = true;

  try {
    // localDB (đợt 1d) keeps failed events at status 'pending' with an
    // attempts counter (dead-lettered at MAX_GAMIFICATION_ATTEMPTS = 3), so
    // this pending list already includes retryable 'failed' events — they
    // are retried here automatically and drop out once they turn 'dead'.
    const pendingEvents = await getPendingGamificationEvents();

    for (const event of pendingEvents) {
      try {
        let result: ActivityResult;
        if (event.kind === 'review') {
          const cardsReviewed = numberValue(event.payload.cardsReviewed);
          const correctCount = Math.min(cardsReviewed, numberValue(event.payload.correctCount, cardsReviewed));
          result = await trackActivity(event.userId, {
            logCollection: 'review_logs',
            cardsReviewed,
            correctCount,
            studyMinutes: numberValue(event.payload.studyMinutes),
            logData: {
              type: 'review_batch',
              source: String(event.payload.source || 'offline_queue'),
              cardsReviewed,
              correctCount,
            },
          }, event.timezone);
        } else {
          const score = numberValue(event.payload.score);
          const totalQuestions = numberValue(event.payload.totalQuestions);
          const durationSeconds = numberValue(event.payload.durationSeconds);
          result = await trackActivity(event.userId, {
            logCollection: 'quiz_logs',
            quizzesCompleted: 1,
            perfectQuiz: totalQuestions > 0 && score >= totalQuestions,
            studyMinutes: durationSeconds / 60,
            forceCooldownKey: 'quiz',
            logData: {
              type: 'quiz_completion',
              score,
              totalQuestions,
              perfect: totalQuestions > 0 && score >= totalQuestions,
              durationSeconds,
              mode: String(event.payload.mode || 'unknown'),
              deckIds: Array.isArray(event.payload.deckIds) ? event.payload.deckIds : [],
            },
          }, event.timezone);
        }

        await markGamificationEventsSynced([event.id]);
        emitBadgeEvents(result.newBadges);
      } catch (error) {
        // Isolate the failure: mark this event (attempts + 1; dead at 3) and
        // keep flushing the remaining events instead of blocking the queue.
        await markGamificationEventFailed(event.id, error);
        console.warn('Gamification queue: one event failed and will be retried.', error);
      }
    }
  } finally {
    isFlushingGamification = false;
  }
}

if (typeof window !== 'undefined') {
  window.addEventListener('online', () => {
    flushGamificationQueue().catch((error) => console.warn('Gamification queue sync failed.', error));
  });
}
