export type BadgeId =
  | 'first_review'
  | 'cards_100'
  | 'cards_500'
  | 'cards_1000'
  | 'cards_5000'
  | 'streak_3'
  | 'streak_7'
  | 'streak_14'
  | 'streak_30'
  | 'streak_100'
  | 'quiz_master'
  | 'perfect_quiz';

export interface BadgeDefinition {
  id: BadgeId;
  title: string;
  description: string;
  metric: 'cards' | 'streak' | 'quizzes' | 'perfectQuizzes';
  threshold: number;
}

export interface BadgeUnlock {
  id: BadgeId;
  title: string;
  unlockedAt: string;
}

export interface GamificationStats {
  streakDays: number;
  totalCardsReviewed: number;
  totalQuizzesCompleted: number;
  totalStudyTimeMinutes: number;
  /** Number of quizzes finished with a perfect (100%) score. */
  perfectQuizzesCompleted?: number;
  /** Lifetime XP (see XP rules below). */
  xp?: number;
}

export const MIN_REVIEW_DELAY_MS = 1_200;
export const REVIEW_SPAM_WINDOW_MS = 10_000;
export const MAX_REVIEWS_PER_SPAM_WINDOW = 14;
export const QUIZ_COOLDOWN_MS = 60_000;

export const DEFAULT_TIMEZONE = 'Asia/Bangkok';

/* ------------------------------------------------------------------ */
/* XP & levels                                                         */
/*                                                                     */
/* XP rules (applied in gamificationService.trackActivity):            */
/*   - every reviewed card:            +4 XP                           */
/*   - every correctly answered card:  +6 XP extra (10 XP total)       */
/*   - every completed quiz:           +20 XP                          */
/*   - a perfect quiz (100% score):    +30 XP extra                    */
/*                                                                     */
/* Level formula (monotonic): level = 1 + floor(sqrt(xp / 150)).       */
/* Level L therefore starts at 150 * (L - 1)^2 XP:                     */
/*   L1 = 0, L2 = 150, L3 = 600, L4 = 1350, L5 = 2400, ...             */
/* ------------------------------------------------------------------ */
export const XP_PER_REVIEW = 4;
export const XP_PER_CORRECT_BONUS = 6;
export const XP_PER_QUIZ = 20;
export const XP_PERFECT_QUIZ_BONUS = 30;
export const XP_LEVEL_BASE = 150;

export function levelForXp(xp: number): number {
  const safeXp = Math.max(0, Math.floor(Number.isFinite(xp) ? xp : 0));
  return 1 + Math.floor(Math.sqrt(safeXp / XP_LEVEL_BASE));
}

/** XP at which a given level starts (level 1 starts at 0). */
export function xpForLevel(level: number): number {
  const safeLevel = Math.max(1, Math.floor(level));
  return XP_LEVEL_BASE * (safeLevel - 1) * (safeLevel - 1);
}

export interface XpProgress {
  xp: number;
  level: number;
  /** XP earned inside the current level. */
  xpIntoLevel: number;
  /** XP needed to go from the current level to the next one. */
  xpForNextLevel: number;
  /** 0..1 progress towards the next level. */
  progress: number;
}

export function getXpProgress(xp: number): XpProgress {
  const safeXp = Math.max(0, Math.floor(Number.isFinite(xp) ? xp : 0));
  const level = levelForXp(safeXp);
  const levelStart = xpForLevel(level);
  const nextLevelStart = xpForLevel(level + 1);
  const span = Math.max(1, nextLevelStart - levelStart);
  const xpIntoLevel = safeXp - levelStart;
  return {
    xp: safeXp,
    level,
    xpIntoLevel,
    xpForNextLevel: span,
    progress: Math.min(1, Math.max(0, xpIntoLevel / span)),
  };
}

export const BADGES: BadgeDefinition[] = [
  {
    id: 'first_review',
    title: 'Bước khởi đầu',
    description: 'Hoàn thành lần ôn tập đầu tiên',
    metric: 'cards',
    threshold: 1,
  },
  {
    id: 'cards_100',
    title: '100 thẻ đầu tiên',
    description: 'Đã ôn tập 100 thẻ',
    metric: 'cards',
    threshold: 100,
  },
  {
    id: 'cards_500',
    title: '500 thẻ',
    description: 'Đã ôn tập 500 thẻ',
    metric: 'cards',
    threshold: 500,
  },
  {
    id: 'cards_1000',
    title: '1.000 thẻ',
    description: 'Đã ôn tập 1.000 thẻ',
    metric: 'cards',
    threshold: 1000,
  },
  {
    id: 'cards_5000',
    title: '5.000 thẻ',
    description: 'Đã ôn tập 5.000 thẻ',
    metric: 'cards',
    threshold: 5000,
  },
  {
    id: 'streak_3',
    title: 'Chuỗi 3 ngày',
    description: 'Học liên tục 3 ngày',
    metric: 'streak',
    threshold: 3,
  },
  {
    id: 'streak_7',
    title: 'Chuỗi 7 ngày',
    description: 'Học liên tục 7 ngày',
    metric: 'streak',
    threshold: 7,
  },
  {
    id: 'streak_14',
    title: 'Chuỗi 14 ngày',
    description: 'Học liên tục 14 ngày',
    metric: 'streak',
    threshold: 14,
  },
  {
    id: 'streak_30',
    title: 'Chuỗi 30 ngày',
    description: 'Kỷ luật thép: học liên tục 30 ngày',
    metric: 'streak',
    threshold: 30,
  },
  {
    id: 'streak_100',
    title: 'Chuỗi 100 ngày',
    description: 'Học liên tục 100 ngày',
    metric: 'streak',
    threshold: 100,
  },
  {
    id: 'quiz_master',
    title: 'Chuyên gia kiểm tra',
    description: 'Hoàn thành 10 bài kiểm tra',
    metric: 'quizzes',
    threshold: 10,
  },
  {
    id: 'perfect_quiz',
    title: 'Điểm tuyệt đối',
    description: 'Đạt 100% trong một bài kiểm tra',
    metric: 'perfectQuizzes',
    threshold: 1,
  },
];

export function getTodayKey(timeZone = DEFAULT_TIMEZONE, date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const value = (type: string) => parts.find((part) => part.type === type)?.value || '';

  return `${value('year')}-${value('month')}-${value('day')}`;
}

/**
 * The single study-day key convention for gamification: a yyyy-MM-dd key in
 * the given timezone (same values getTodayKey produces). All streak writes
 * must go through helpers built on this key so `streak` and `streakDays`
 * can never drift apart.
 *
 * Named distinctly from the scheduler's `getStudyDayKey`
 * (src/scheduler/intervalCalculator.ts), which uses the DEVICE-LOCAL day
 * with no timezone parameter — the two conventions differ for users outside
 * the configured timezone, and the near-identical names invited mix-ups.
 */
export function getStudyDayKeyInTimezone(date = new Date(), timeZone = DEFAULT_TIMEZONE): string {
  return getTodayKey(timeZone, date);
}

/** Shift a yyyy-MM-dd day key by whole days (calendar math, timezone-free). */
export function shiftStudyDayKey(dayKey: string, deltaDays: number): string {
  const [year, month, day] = dayKey.split('-').map((part) => Number(part));
  if (!year || !month || !day) return dayKey;
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCDate(date.getUTCDate() + deltaDays);
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export interface StreakComputation {
  /** The streak value to store in BOTH `streak` and `streakDays`. */
  streakDays: number;
  /** Day key of this activity (store as the last-study day marker). */
  lastStudyDayKey: string;
  /** True when this activity is the first one of a new study day. */
  isNewStudyDay: boolean;
}

/**
 * The one and only streak rule, used by every write path:
 * - activity on the same study day as the previous one: streak unchanged
 *   (but at least 1);
 * - activity on the immediately following study day: streak + 1;
 * - anything else (first activity ever, or a gap of 2+ days): streak = 1.
 *
 * `lastStudyDate` is the ISO timestamp of the previous activity; it is
 * converted to a study-day key with the same timezone so comparisons are
 * apples-to-apples.
 */
export function computeStreakOnActivity(
  previous: { streakDays?: number; lastStudyDate?: string | null; lastStudyDayKey?: string | null },
  now = new Date(),
  timeZone = DEFAULT_TIMEZONE,
): StreakComputation {
  const todayKey = getStudyDayKeyInTimezone(now, timeZone);
  const previousStreak = Math.max(0, Math.floor(previous.streakDays || 0));

  let lastDayKey = previous.lastStudyDayKey || '';
  if (!lastDayKey && previous.lastStudyDate) {
    const parsed = new Date(previous.lastStudyDate);
    if (Number.isFinite(parsed.getTime())) {
      lastDayKey = getStudyDayKeyInTimezone(parsed, timeZone);
    }
  }

  if (!lastDayKey) {
    return { streakDays: 1, lastStudyDayKey: todayKey, isNewStudyDay: true };
  }

  if (lastDayKey === todayKey) {
    return { streakDays: Math.max(1, previousStreak), lastStudyDayKey: todayKey, isNewStudyDay: false };
  }

  if (lastDayKey === shiftStudyDayKey(todayKey, -1)) {
    // Consecutive day: extend the streak (a stored 0 with a yesterday
    // activity is inconsistent legacy data; restart at 1 in that case).
    return {
      streakDays: previousStreak > 0 ? previousStreak + 1 : 1,
      lastStudyDayKey: todayKey,
      isNewStudyDay: true,
    };
  }

  return { streakDays: 1, lastStudyDayKey: todayKey, isNewStudyDay: true };
}

function badgeMetricValue(badge: BadgeDefinition, stats: GamificationStats): number {
  switch (badge.metric) {
    case 'cards':
      return stats.totalCardsReviewed;
    case 'streak':
      return stats.streakDays;
    case 'quizzes':
      return stats.totalQuizzesCompleted;
    case 'perfectQuizzes':
      return stats.perfectQuizzesCompleted || 0;
    default:
      return 0;
  }
}

export function getUnlockedBadges(stats: GamificationStats, existingBadges: BadgeUnlock[] = [], now = new Date()): BadgeUnlock[] {
  const unlockedIds = new Set(existingBadges.map((badge) => badge.id));
  const nextBadges = [...existingBadges];
  const unlockedAt = now.toISOString();

  BADGES.forEach((badge) => {
    if (unlockedIds.has(badge.id)) return;

    if (badgeMetricValue(badge, stats) >= badge.threshold) {
      nextBadges.push({
        id: badge.id,
        title: badge.title,
        unlockedAt,
      });
      unlockedIds.add(badge.id);
    }
  });

  return nextBadges;
}

/** Only the badges unlocked by reaching `stats` that were not already owned. */
export function getNewlyUnlockedBadges(
  stats: GamificationStats,
  existingBadges: BadgeUnlock[] = [],
  now = new Date(),
): BadgeUnlock[] {
  const existingIds = new Set(existingBadges.map((badge) => badge.id));
  return getUnlockedBadges(stats, existingBadges, now).filter((badge) => !existingIds.has(badge.id));
}
