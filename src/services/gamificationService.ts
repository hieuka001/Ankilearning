import {
  collection,
  doc,
  getDoc,
  limit,
  onSnapshot,
  orderBy,
  query,
  runTransaction,
  setDoc,
  type Unsubscribe,
} from 'firebase/firestore';
import { db } from '../firebase';
import type { DailyMissionDocument, LeaderboardEntry, UserProfile } from '../types';
import {
  getPendingGamificationEvents,
  markGamificationEventFailed,
  markGamificationEventsSynced,
  saveGamificationEvent,
  type GamificationQueueRecord,
} from '../review/localDB';
import {
  ACTIVE_TIME_FLUSH_SECONDS,
  CORRECT_STREAK_BONUS_EXP,
  DEFAULT_TIMEZONE,
  DAILY_MISSION_EXP,
  MAX_REVIEWS_PER_SPAM_WINDOW,
  QUIZ_COMPLETION_EXP,
  QUIZ_COOLDOWN_MS,
  REVIEW_CARD_EXP,
  calculateRankScore,
  calculateUserLevel,
  createDefaultDailyMissions,
  getDateKeyOffset,
  getTodayKey,
  getUnlockedBadges,
  updateMissionProgress,
  allDailyMissionsCompleted,
  allDailyMissionsClaimed,
  claimDailyMissionReward,
  type DailyMission,
  type MissionType,
} from '../lib/gamification';

interface ActivityInput {
  missionType: MissionType;
  amount: number;
  baseExp: number;
  logCollection: 'review_logs' | 'quiz_logs' | 'activity_logs';
  logData: Record<string, unknown>;
  cardsReviewed?: number;
  quizzesCompleted?: number;
  studyTimeSeconds?: number;
  forceCooldownKey?: 'quiz';
}

interface ActivityResult {
  awardedExp: number;
  missionExp: number;
  level: number;
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

const missionDocId = (userId: string, dateKey: string) => `${userId}_${dateKey}`;
const missionRef = (userId: string, dateKey: string) => doc(db, 'daily_missions', missionDocId(userId, dateKey));
const userRef = (userId: string) => doc(db, 'users', userId);
const leaderboardRef = (userId: string) => doc(db, 'leaderboards', 'global', 'users', userId);
let isFlushingGamification = false;

function normalizeMissions(data: Partial<DailyMissionDocument> | undefined, dateKey: string, timezone: string): DailyMission[] {
  if (Array.isArray(data?.missions) && data.missions.length > 0) {
    return data.missions as DailyMission[];
  }

  return createDefaultDailyMissions(dateKey, timezone);
}

function numberValue(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function profileStats(userData: Partial<UserProfile>) {
  const totalExp = numberValue(userData.totalExp, numberValue(userData.xp));
  const streakDays = numberValue(userData.streakDays, numberValue(userData.streak));
  const totalCardsReviewed = numberValue(userData.totalCardsReviewed, numberValue(userData.totalCardsLearned));
  const totalQuizzesCompleted = numberValue(userData.totalQuizzesCompleted);
  const totalStudyTimeMinutes = numberValue(userData.totalStudyTimeMinutes);

  return {
    totalExp,
    streakDays,
    totalCardsReviewed,
    totalQuizzesCompleted,
    totalStudyTimeMinutes,
  };
}

function buildLeaderboardEntry(userId: string, userData: Partial<UserProfile>, stats: ReturnType<typeof profileStats>, nowIso: string): Omit<LeaderboardEntry, 'id'> {
  return {
    userId,
    username: userData.displayName || userData.email || 'Learner',
    avatar: userData.photoURL || '',
    level: calculateUserLevel(stats.totalExp).level,
    totalExp: stats.totalExp,
    streakDays: stats.streakDays,
    totalCardsReviewed: stats.totalCardsReviewed,
    rankScore: calculateRankScore(stats),
    updatedAt: nowIso,
  };
}

export async function ensureDailyMissions(userId: string, timezone = DEFAULT_TIMEZONE): Promise<DailyMissionDocument> {
  const now = new Date();
  const nowIso = now.toISOString();
  const dateKey = getTodayKey(timezone, now);
  const ref = missionRef(userId, dateKey);
  const snap = await getDoc(ref);

  if (snap.exists()) {
    const existingData = snap.data() as Omit<DailyMissionDocument, 'id'>;
    const missions = normalizeMissions(existingData, dateKey, timezone);
    const shouldRepair = !Array.isArray(existingData.missions) || existingData.missions.length < 3;

    if (shouldRepair) {
      const repairedPayload: Omit<DailyMissionDocument, 'id'> = {
        ...existingData,
        userId,
        dateKey,
        missions,
        completedAll: allDailyMissionsCompleted(missions),
        claimedAll: allDailyMissionsClaimed(missions),
        claimedExp: existingData.claimedExp || 0,
        createdAt: existingData.createdAt || nowIso,
        updatedAt: nowIso,
        resetAt: missions[0]?.resetAt || existingData.resetAt || nowIso,
      };

      await setDoc(ref, repairedPayload, { merge: true });
      return { id: snap.id, ...repairedPayload };
    }

    return { id: snap.id, ...existingData };
  }

  const missions = createDefaultDailyMissions(dateKey, timezone);
  const payload: Omit<DailyMissionDocument, 'id'> = {
    userId,
    dateKey,
    missions,
    completedAll: false,
    claimedAll: false,
    claimedExp: 0,
    createdAt: nowIso,
    updatedAt: nowIso,
    resetAt: missions[0]?.resetAt || nowIso,
  };

  await setDoc(ref, payload, { merge: true });

  return { id: ref.id, ...payload };
}

export async function ensureLeaderboardEntry(userId: string) {
  const nowIso = new Date().toISOString();
  const snap = await getDoc(userRef(userId));
  if (!snap.exists()) return;

  const userData = snap.data() as Partial<UserProfile>;
  const stats = profileStats(userData);
  await setDoc(leaderboardRef(userId), buildLeaderboardEntry(userId, userData, stats, nowIso), { merge: true });
}

async function trackActivity(userId: string, input: ActivityInput, timezone = DEFAULT_TIMEZONE): Promise<ActivityResult> {
  const now = new Date();
  const nowIso = now.toISOString();
  const dateKey = getTodayKey(timezone, now);
  const yesterdayKey = getDateKeyOffset(-1, timezone, now);
  const antiCheatFlags: string[] = [];

  let amount = Math.max(0, Math.floor(input.amount));
  let baseExp = Math.max(0, Math.floor(input.baseExp));
  let cardsReviewed = Math.max(0, Math.floor(input.cardsReviewed || 0));
  let quizzesCompleted = Math.max(0, Math.floor(input.quizzesCompleted || 0));
  let studyTimeSeconds = Math.max(0, Math.floor(input.studyTimeSeconds || 0));

  if (input.missionType === 'study_cards' && amount > MAX_REVIEWS_PER_SPAM_WINDOW * 10) {
    antiCheatFlags.push('large_review_batch');
  }

  if (input.missionType === 'online_time' && amount > ACTIVE_TIME_FLUSH_SECONDS * 5) {
    antiCheatFlags.push('online_time_capped');
    amount = ACTIVE_TIME_FLUSH_SECONDS * 5;
    studyTimeSeconds = Math.min(studyTimeSeconds, amount);
  }

  return runTransaction(db, async (transaction) => {
    const [profileSnap, dailyMissionSnap] = await Promise.all([
      transaction.get(userRef(userId)),
      transaction.get(missionRef(userId, dateKey)),
    ]);

    const userData = profileSnap.exists() ? profileSnap.data() as Partial<UserProfile> : {};

    if (input.forceCooldownKey === 'quiz' && userData.lastQuizCompletedAt) {
      const elapsed = now.getTime() - new Date(userData.lastQuizCompletedAt).getTime();
      if (elapsed >= 0 && elapsed < QUIZ_COOLDOWN_MS) {
        antiCheatFlags.push('quiz_cooldown');
        amount = 0;
        baseExp = 0;
        quizzesCompleted = 0;
      }
    }

    const existingMissionData = dailyMissionSnap.exists()
      ? dailyMissionSnap.data() as DailyMissionDocument
      : undefined;
    const previousMissions = normalizeMissions(existingMissionData, dateKey, timezone);
    const progressResult = updateMissionProgress(previousMissions, input.missionType, amount);
    const missions = progressResult.missions;
    const completedAll = allDailyMissionsCompleted(missions);
    const missionExp = 0;

    const previousStats = profileStats(userData);
    let streakDays = previousStats.streakDays;

    if (userData.lastMissionDate && userData.lastMissionDate !== dateKey && userData.lastMissionDate !== yesterdayKey) {
      streakDays = 0;
    }

    const correctStreakBonus = input.missionType === 'study_cards'
      ? Math.floor(cardsReviewed / 10) * CORRECT_STREAK_BONUS_EXP
      : 0;

    const awardedExp = baseExp + correctStreakBonus;
    const nextStats = {
      totalExp: previousStats.totalExp + awardedExp,
      streakDays,
      totalCardsReviewed: previousStats.totalCardsReviewed + cardsReviewed,
      totalQuizzesCompleted: previousStats.totalQuizzesCompleted + quizzesCompleted,
      totalStudyTimeMinutes: previousStats.totalStudyTimeMinutes + Math.floor(studyTimeSeconds / 60),
    };
    const levelInfo = calculateUserLevel(nextStats.totalExp);
    const badges = getUnlockedBadges(nextStats, (userData.badges || userData.achievements || []) as any[], now);

    transaction.set(missionRef(userId, dateKey), {
      userId,
      dateKey,
      missions,
      completedAll,
      claimedAll: allDailyMissionsClaimed(missions),
      claimedExp: existingMissionData?.claimedExp || 0,
      createdAt: existingMissionData?.createdAt || nowIso,
      updatedAt: nowIso,
      resetAt: missions[0]?.resetAt || nowIso,
    }, { merge: true });

    transaction.set(userRef(userId), {
      totalExp: nextStats.totalExp,
      xp: nextStats.totalExp,
      level: levelInfo.level,
      streakDays: nextStats.streakDays,
      streak: nextStats.streakDays,
      totalCardsReviewed: nextStats.totalCardsReviewed,
      totalCardsLearned: nextStats.totalCardsReviewed,
      totalQuizzesCompleted: nextStats.totalQuizzesCompleted,
      totalStudyTimeMinutes: nextStats.totalStudyTimeMinutes,
      rankScore: calculateRankScore(nextStats),
      lastQuizCompletedAt: input.forceCooldownKey === 'quiz' && quizzesCompleted > 0 ? nowIso : userData.lastQuizCompletedAt || '',
      badges,
      achievements: badges,
      updatedAt: nowIso,
    }, { merge: true });

    transaction.set(leaderboardRef(userId), buildLeaderboardEntry(userId, userData, nextStats, nowIso), { merge: true });

    const logRef = doc(collection(db, input.logCollection));
    transaction.set(logRef, {
      id: logRef.id,
      userId,
      dateKey,
      createdAt: nowIso,
      awardedExp,
      missionExp,
      antiCheatFlags,
      ...input.logData,
    });

    return {
      awardedExp,
      missionExp,
      level: levelInfo.level,
      antiCheatFlags,
    };
  });
}

export async function claimMissionReward(userId: string, missionId: string, timezone = DEFAULT_TIMEZONE): Promise<ActivityResult> {
  const now = new Date();
  const nowIso = now.toISOString();
  const dateKey = getTodayKey(timezone, now);
  const yesterdayKey = getDateKeyOffset(-1, timezone, now);
  const antiCheatFlags: string[] = [];

  return runTransaction(db, async (transaction) => {
    const [profileSnap, dailyMissionSnap] = await Promise.all([
      transaction.get(userRef(userId)),
      transaction.get(missionRef(userId, dateKey)),
    ]);

    if (!dailyMissionSnap.exists()) {
      throw new Error('Daily missions are not ready.');
    }

    const userData = profileSnap.exists() ? profileSnap.data() as Partial<UserProfile> : {};
    const existingMissionData = dailyMissionSnap.data() as DailyMissionDocument;
    const previousMissions = normalizeMissions(existingMissionData, dateKey, timezone);
    const wasClaimedAll = allDailyMissionsClaimed(previousMissions);
    const claimResult = claimDailyMissionReward(previousMissions, missionId);

    if (!claimResult.claimedMission || claimResult.rewardExp <= 0) {
      return {
        awardedExp: 0,
        missionExp: 0,
        level: calculateUserLevel(profileStats(userData).totalExp).level,
        antiCheatFlags: ['nothing_to_claim'],
      };
    }

    const missions = claimResult.missions;
    const completedAll = allDailyMissionsCompleted(missions);
    const claimedAll = allDailyMissionsClaimed(missions);
    const previousStats = profileStats(userData);
    let streakDays = previousStats.streakDays;

    if (userData.lastMissionDate && userData.lastMissionDate !== dateKey && userData.lastMissionDate !== yesterdayKey) {
      streakDays = 0;
    }

    let streakBonusExp = 0;
    if (!wasClaimedAll && claimedAll) {
      streakDays = userData.lastMissionDate === yesterdayKey ? streakDays + 1 : 1;
      streakBonusExp = streakDays > 0 && streakDays % 7 === 0 ? DAILY_MISSION_EXP : 0;
    }

    const awardedExp = claimResult.rewardExp + streakBonusExp;
    const nextStats = {
      ...previousStats,
      totalExp: previousStats.totalExp + awardedExp,
      streakDays,
    };
    const levelInfo = calculateUserLevel(nextStats.totalExp);
    const badges = getUnlockedBadges(nextStats, (userData.badges || userData.achievements || []) as any[], now);
    const claimedExp = numberValue(existingMissionData.claimedExp) + claimResult.rewardExp;

    transaction.set(missionRef(userId, dateKey), {
      userId,
      dateKey,
      missions,
      completedAll,
      claimedAll,
      claimedExp,
      createdAt: existingMissionData.createdAt || nowIso,
      updatedAt: nowIso,
      resetAt: missions[0]?.resetAt || existingMissionData.resetAt || nowIso,
    }, { merge: true });

    transaction.set(userRef(userId), {
      totalExp: nextStats.totalExp,
      xp: nextStats.totalExp,
      level: levelInfo.level,
      streakDays: nextStats.streakDays,
      streak: nextStats.streakDays,
      rankScore: calculateRankScore(nextStats),
      lastMissionDate: claimedAll ? dateKey : userData.lastMissionDate || '',
      badges,
      achievements: badges,
      updatedAt: nowIso,
    }, { merge: true });

    transaction.set(leaderboardRef(userId), buildLeaderboardEntry(userId, userData, nextStats, nowIso), { merge: true });

    const logRef = doc(collection(db, 'activity_logs'));
    transaction.set(logRef, {
      id: logRef.id,
      userId,
      dateKey,
      createdAt: nowIso,
      type: 'mission_claim',
      missionId,
      missionType: claimResult.claimedMission.type,
      awardedExp,
      missionExp: claimResult.rewardExp,
      streakBonusExp,
      antiCheatFlags,
    });

    return {
      awardedExp,
      missionExp: claimResult.rewardExp,
      level: levelInfo.level,
      antiCheatFlags,
    };
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

      return {
        awardedExp: 0,
        missionExp: 0,
        level: 1,
        antiCheatFlags: ['queued_offline'],
      };
    }

    throw error;
  }
}

export function trackReviewActivity(userId: string, input: ReviewActivityInput, timezone = DEFAULT_TIMEZONE) {
  const cardsReviewed = Math.max(0, Math.floor(input.cardsReviewed));
  const correctCount = Math.max(0, Math.floor(input.correctCount ?? cardsReviewed));

  const activityInput: ActivityInput = {
    missionType: 'study_cards',
    amount: correctCount,
    baseExp: correctCount * REVIEW_CARD_EXP,
    logCollection: 'review_logs',
    cardsReviewed: correctCount,
    logData: {
      type: 'review_batch',
      source: input.source || 'study',
      cardsReviewed,
      correctCount,
      expPerCard: REVIEW_CARD_EXP,
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
    missionType: 'complete_quiz',
    amount: 1,
    baseExp: QUIZ_COMPLETION_EXP,
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
      exp: QUIZ_COMPLETION_EXP,
    },
  };

  return trackActivityWithOfflineQueue(userId, 'quiz', { ...input }, activityInput, timezone);
}

export function trackActiveStudyTime(userId: string, seconds: number, timezone = DEFAULT_TIMEZONE) {
  const safeSeconds = Math.max(0, Math.floor(seconds));

  const activityInput: ActivityInput = {
    missionType: 'online_time',
    amount: safeSeconds,
    baseExp: 0,
    logCollection: 'activity_logs',
    studyTimeSeconds: safeSeconds,
    logData: {
      type: 'active_time',
      activeSeconds: safeSeconds,
    },
  };

  return trackActivityWithOfflineQueue(userId, 'active_time', { seconds: safeSeconds }, activityInput, timezone);
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
            missionType: 'study_cards',
            amount: correctCount,
            baseExp: correctCount * REVIEW_CARD_EXP,
            logCollection: 'review_logs',
            cardsReviewed: correctCount,
            logData: {
              type: 'review_batch',
              source: String(event.payload.source || 'offline_queue'),
              cardsReviewed,
              correctCount,
              expPerCard: REVIEW_CARD_EXP,
            },
          }, event.timezone);
        } else if (event.kind === 'quiz') {
          const score = numberValue(event.payload.score);
          const totalQuestions = numberValue(event.payload.totalQuestions);
          const durationSeconds = numberValue(event.payload.durationSeconds);
          await trackActivity(event.userId, {
            missionType: 'complete_quiz',
            amount: 1,
            baseExp: QUIZ_COMPLETION_EXP,
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
              exp: QUIZ_COMPLETION_EXP,
            },
          }, event.timezone);
        } else {
          const seconds = numberValue(event.payload.seconds);
          await trackActivity(event.userId, {
            missionType: 'online_time',
            amount: seconds,
            baseExp: 0,
            logCollection: 'activity_logs',
            studyTimeSeconds: seconds,
            logData: {
              type: 'active_time',
              activeSeconds: seconds,
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

export function subscribeDailyMissions(
  userId: string,
  onChange: (missionDoc: DailyMissionDocument | null) => void,
  timezone = DEFAULT_TIMEZONE
): Unsubscribe {
  const dateKey = getTodayKey(timezone);
  const ref = missionRef(userId, dateKey);

  ensureDailyMissions(userId, timezone)
    .then(onChange)
    .catch((error) => {
      console.warn('Could not ensure daily missions.', error);
      onChange(null);
    });

  return onSnapshot(
    ref,
    (snap) => {
      if (!snap.exists()) {
        onChange(null);
        return;
      }

      const missionData = snap.data() as Omit<DailyMissionDocument, 'id'>;
      onChange({
        id: snap.id,
        ...missionData,
        missions: normalizeMissions(missionData, dateKey, timezone),
      });
    },
    (error) => {
      console.warn('Daily missions listener failed.', error);
      onChange(null);
    }
  );
}

export function subscribeLeaderboard(
  onChange: (entries: LeaderboardEntry[]) => void,
  take = 20
): Unsubscribe {
  const leaderboardQuery = query(
    collection(db, 'leaderboards', 'global', 'users'),
    orderBy('rankScore', 'desc'),
    limit(take)
  );

  return onSnapshot(leaderboardQuery, (snap) => {
    onChange(snap.docs.map((entryDoc, index) => ({
      id: entryDoc.id,
      rank: index + 1,
      ...(entryDoc.data() as Omit<LeaderboardEntry, 'id'>),
    } as LeaderboardEntry & { rank: number })));
  });
}

if (typeof window !== 'undefined') {
  window.addEventListener('online', () => {
    flushGamificationQueue().catch((error) => console.warn('Gamification queue sync failed.', error));
  });
}
