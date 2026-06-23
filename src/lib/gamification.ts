export type BadgeId =
  | 'first_review'
  | 'cards_100'
  | 'streak_7'
  | 'streak_30'
  | 'quiz_master';

export interface BadgeDefinition {
  id: BadgeId;
  title: string;
  description: string;
  metric: 'cards' | 'streak' | 'quizzes';
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
}

export const MIN_REVIEW_DELAY_MS = 1_200;
export const REVIEW_SPAM_WINDOW_MS = 10_000;
export const MAX_REVIEWS_PER_SPAM_WINDOW = 14;
export const QUIZ_COOLDOWN_MS = 60_000;

export const DEFAULT_TIMEZONE = 'Asia/Bangkok';

export const BADGES: BadgeDefinition[] = [
  {
    id: 'first_review',
    title: 'First Review',
    description: 'Hoàn thành lần ôn tập đầu tiên',
    metric: 'cards',
    threshold: 1,
  },
  {
    id: 'cards_100',
    title: '100 Cards',
    description: 'Đã ôn tập 100 thẻ',
    metric: 'cards',
    threshold: 100,
  },
  {
    id: 'streak_7',
    title: '7-Day Streak',
    description: 'Hoàn thành chuỗi 7 ngày',
    metric: 'streak',
    threshold: 7,
  },
  {
    id: 'streak_30',
    title: '30-Day Streak',
    description: 'Huy hiệu kỷ luật 30 ngày',
    metric: 'streak',
    threshold: 30,
  },
  {
    id: 'quiz_master',
    title: 'Quiz Master',
    description: 'Hoàn thành 10 bài kiểm tra',
    metric: 'quizzes',
    threshold: 10,
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

export function getUnlockedBadges(stats: GamificationStats, existingBadges: BadgeUnlock[] = [], now = new Date()): BadgeUnlock[] {
  const unlockedIds = new Set(existingBadges.map((badge) => badge.id));
  const nextBadges = [...existingBadges];
  const unlockedAt = now.toISOString();

  BADGES.forEach((badge) => {
    if (unlockedIds.has(badge.id)) return;

    const value = badge.metric === 'cards'
      ? stats.totalCardsReviewed
      : badge.metric === 'streak'
        ? stats.streakDays
        : stats.totalQuizzesCompleted;

    if (value >= badge.threshold) {
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
