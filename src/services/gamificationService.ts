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
  QUIZ_COOLDOWN_MS,
  getTodayKey,
  getUnlockedBadges,
  type BadgeUnlock,
} from '../lib/gamification';

interface ActivityInput {
  logCollection: 'review_logs' | 'quiz_logs';
  logData: Record<string, unknown>;
  cardsReviewed?: number;
  quizzesCompleted?: number;
  forceCooldownKey?: 'quiz';
}

interface ActivityResult {
  antiCheatFlags: string[];
}

export interface ReviewActivityInput {
  cardsReviewed: number;
  correctCount?: number;
  source?: string;
}

export interface QuizActivityInput {
  score: number;
  totalQuestions: number;
  durationSeconds: number;
  mode: string;
  deckIds?: string[];
}

const userRef = (userId: string) => doc(db, 'users', userId);
let isFlushingGamification = false;

function numberValue(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function profileStats(userData: Partial<UserProfile>) {
  const streakDays = numberValue(userData.streakDays, numberValue(userData.streak));
  const totalCardsReviewed = numberValue(userData.totalCardsReviewed, numberValue(userData.totalCardsLearned));
  const totalQuizzesCompleted = numberValue(userData.totalQuizzesCompleted);
  const totalStudyTimeMinutes = numberValue(userData.totalStudyTimeMinutes);

  return {
    streakDays,
    totalCardsReviewed,
    totalQuizzesCompleted,
    totalStudyTimeMinutes,
  };
}

async function trackActivity(userId: string, input: ActivityInput, timezone = DEFAULT_TIMEZONE): Promise<ActivityResult> {
  const now = new Date();
  const nowIso = now.toISOString();
  const dateKey = getTodayKey(timezone, now);
  const antiCheatFlags: string[] = [];

  let cardsReviewed = Math.max(0, Math.floor(input.cardsReviewed || 0));
  let quizzesCompleted = Math.max(0, Math.floor(input.quizzesCompleted || 0));

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

    const previousStats = profileStats(userData);
    const nextStats = {
      streakDays: previousStats.streakDays,
      totalCardsReviewed: previousStats.totalCardsReviewed + cardsReviewed,
      totalQuizzesCompleted: previousStats.totalQuizzesCompleted + quizzesCompleted,
      totalStudyTimeMinutes: previousStats.totalStudyTimeMinutes,
    };
    const badges = getUnlockedBadges(nextStats, (userData.badges || userData.achievements || []) as BadgeUnlock[], now);

    transaction.set(userRef(userId), {
      totalCardsReviewed: nextStats.totalCardsReviewed,
      totalCardsLearned: nextStats.totalCardsReviewed,
      totalQuizzesCompleted: nextStats.totalQuizzesCompleted,
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

    return { antiCheatFlags };
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
    return await trackActivity(userId, input, timezone);
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

      return { antiCheatFlags: ['queued_offline'] };
    }

    throw error;
  }
}

export function trackReviewActivity(userId: string, input: ReviewActivityInput, timezone = DEFAULT_TIMEZONE) {
  const cardsReviewed = Math.max(0, Math.floor(input.cardsReviewed));
  const correctCount = Math.max(0, Math.floor(input.correctCount ?? cardsReviewed));

  const activityInput: ActivityInput = {
    logCollection: 'review_logs',
    cardsReviewed: correctCount,
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
    source: input.source || 'study',
  }, activityInput, timezone);
}

export function trackQuizCompletion(userId: string, input: QuizActivityInput, timezone = DEFAULT_TIMEZONE) {
  const activityInput: ActivityInput = {
    logCollection: 'quiz_logs',
    quizzesCompleted: 1,
    forceCooldownKey: 'quiz',
    logData: {
      type: 'quiz_completion',
      score: input.score,
      totalQuestions: input.totalQuestions,
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
    const pendingEvents = await getPendingGamificationEvents();

    for (const event of pendingEvents) {
      try {
        if (event.kind === 'review') {
          const cardsReviewed = numberValue(event.payload.cardsReviewed);
          const correctCount = numberValue(event.payload.correctCount, cardsReviewed);
          await trackActivity(event.userId, {
            logCollection: 'review_logs',
            cardsReviewed: correctCount,
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
          await trackActivity(event.userId, {
            logCollection: 'quiz_logs',
            quizzesCompleted: 1,
            forceCooldownKey: 'quiz',
            logData: {
              type: 'quiz_completion',
              score,
              totalQuestions,
              durationSeconds,
              mode: String(event.payload.mode || 'unknown'),
              deckIds: Array.isArray(event.payload.deckIds) ? event.payload.deckIds : [],
            },
          }, event.timezone);
        }

        await markGamificationEventsSynced([event.id]);
      } catch (error) {
        await markGamificationEventFailed(event.id, error);
        break;
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
