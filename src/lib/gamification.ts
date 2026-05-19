export type MissionType = 'study_cards' | 'complete_quiz' | 'online_time';
export type BadgeId =
  | 'first_review'
  | 'cards_100'
  | 'exp_1000'
  | 'streak_7'
  | 'streak_30'
  | 'quiz_master';

export interface DailyMission {
  id: string;
  type: MissionType;
  target: number;
  progress: number;
  completed: boolean;
  rewardExp: number;
  claimed: boolean;
  resetAt: string;
}

export interface LevelProgress {
  level: number;
  currentExp: number;
  expForNextLevel: number;
  progressPercent: number;
}

export interface BadgeDefinition {
  id: BadgeId;
  title: string;
  description: string;
  metric: 'cards' | 'exp' | 'streak' | 'quizzes';
  threshold: number;
}

export interface BadgeUnlock {
  id: BadgeId;
  title: string;
  unlockedAt: string;
}

export interface GamificationStats {
  totalExp: number;
  streakDays: number;
  totalCardsReviewed: number;
  totalQuizzesCompleted: number;
  totalStudyTimeMinutes: number;
}

export const REVIEW_CARD_EXP = 2;
export const QUIZ_COMPLETION_EXP = 50;
export const DAILY_MISSION_EXP = 100;
export const MAX_DAILY_MISSION_EXP = 300;
export const CORRECT_STREAK_BONUS_EXP = 5;

export const ONLINE_MISSION_TARGET_SECONDS = 5 * 60;
export const ONLINE_INACTIVE_TIMEOUT_MS = 30_000;
export const ACTIVE_TIME_FLUSH_SECONDS = 60;

export const MIN_REVIEW_DELAY_MS = 1_200;
export const REVIEW_SPAM_WINDOW_MS = 10_000;
export const MAX_REVIEWS_PER_SPAM_WINDOW = 14;
export const QUIZ_COOLDOWN_MS = 60_000;

export const DEFAULT_TIMEZONE = 'Asia/Bangkok';

export const LEVEL_TARGETS: Record<number, number> = {
  1: 200,
  2: 1000,
  3: 3000,
  4: 10000,
  5: 20000,
  6: 30000,
  7: 40000,
  8: 50000,
  9: 60000,
  10: 70000,
};

export const DAILY_MISSION_BLUEPRINTS: Array<Omit<DailyMission, 'id' | 'progress' | 'completed' | 'claimed' | 'resetAt'>> = [
  {
    type: 'study_cards',
    target: 20,
    rewardExp: DAILY_MISSION_EXP,
  },
  {
    type: 'complete_quiz',
    target: 1,
    rewardExp: DAILY_MISSION_EXP,
  },
  {
    type: 'online_time',
    target: ONLINE_MISSION_TARGET_SECONDS,
    rewardExp: DAILY_MISSION_EXP,
  },
];

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
    id: 'exp_1000',
    title: '1000 EXP',
    description: 'Đạt 1000 điểm kinh nghiệm',
    metric: 'exp',
    threshold: 1000,
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

export const MISSION_LABELS: Record<MissionType, string> = {
  study_cards: 'Ôn tập 20 flashcards',
  complete_quiz: 'Hoàn thành 1 bài kiểm tra',
  online_time: 'Tập trung học 5 phút',
};

export function calculateUserLevel(totalExp = 0): LevelProgress {
  const normalizedExp = Math.max(0, Math.floor(totalExp));
  let level = 1;

  for (let candidate = 1; candidate <= 10; candidate++) {
    const previousTarget = candidate === 1 ? 0 : LEVEL_TARGETS[candidate - 1];
    if (normalizedExp >= previousTarget) {
      level = candidate;
    }
  }

  const currentFloor = level === 1 ? 0 : LEVEL_TARGETS[level - 1];
  const nextTarget = LEVEL_TARGETS[level] ?? LEVEL_TARGETS[10];
  const span = Math.max(nextTarget - currentFloor, 1);
  const progressPercent = level >= 10
    ? 100
    : Math.min(100, Math.max(0, ((normalizedExp - currentFloor) / span) * 100));

  return {
    level,
    currentExp: normalizedExp,
    expForNextLevel: nextTarget,
    progressPercent,
  };
}

export function calculateLevel(totalExp = 0): number {
  return calculateUserLevel(totalExp).level;
}

export function calculateLevelProgress(totalExp = 0): number {
  return calculateUserLevel(totalExp).progressPercent;
}

export function xpForNextLevel(currentLevel: number): number {
  const safeLevel = Math.min(Math.max(Math.floor(currentLevel), 1), 10);
  return LEVEL_TARGETS[safeLevel] ?? LEVEL_TARGETS[10];
}

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

export function getNextLocalMidnightIso(timeZone = DEFAULT_TIMEZONE, date = new Date()): string {
  const todayKey = getTodayKey(timeZone, date);
  const [year, month, day] = todayKey.split('-').map(Number);
  return zonedDateTimeToUtcIso(year, month, day + 1, 0, 0, 0, timeZone);
}

export function getDateKeyOffset(offsetDays: number, timeZone = DEFAULT_TIMEZONE, date = new Date()): string {
  const todayKey = getTodayKey(timeZone, date);
  const [year, month, day] = todayKey.split('-').map(Number);
  const safeLocalNoon = zonedDateTimeToUtcDate(year, month, day + offsetDays, 12, 0, 0, timeZone);

  return getTodayKey(timeZone, safeLocalNoon);
}

function zonedDateTimeToUtcIso(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  timeZone: string
): string {
  return zonedDateTimeToUtcDate(year, month, day, hour, minute, second, timeZone).toISOString();
}

function zonedDateTimeToUtcDate(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  timeZone: string
): Date {
  const guess = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(guess);

  const value = (type: string) => Number(parts.find((part) => part.type === type)?.value || 0);
  const asIfUtc = Date.UTC(
    value('year'),
    value('month') - 1,
    value('day'),
    value('hour'),
    value('minute'),
    value('second')
  );
  const targetAsUtc = Date.UTC(year, month - 1, day, hour, minute, second);
  const offsetMs = asIfUtc - targetAsUtc;

  return new Date(guess.getTime() - offsetMs);
}

export function createDefaultDailyMissions(dateKey = getTodayKey(), timeZone = DEFAULT_TIMEZONE): DailyMission[] {
  const resetAt = getNextLocalMidnightIso(timeZone);

  return DAILY_MISSION_BLUEPRINTS.map((mission) => ({
    ...mission,
    id: `${dateKey}_${mission.type}`,
    progress: 0,
    completed: false,
    claimed: false,
    resetAt,
  }));
}

export function updateMissionProgress(
  missions: DailyMission[],
  type: MissionType,
  amount: number
): { missions: DailyMission[]; rewardExp: number; completedNow: DailyMission[] } {
  const completedNow: DailyMission[] = [];

  const nextMissions = missions.map((mission) => {
    if (mission.type !== type) return mission;

    const previousCompleted = mission.completed;
    const progress = Math.min(mission.target, Math.max(0, mission.progress + amount));
    const completed = progress >= mission.target;

    if (!previousCompleted && completed && !mission.claimed) {
      completedNow.push({ ...mission, progress, completed, claimed: mission.claimed });
    }

    return {
      ...mission,
      progress,
      completed,
    };
  });

  return {
    missions: nextMissions,
    rewardExp: 0,
    completedNow,
  };
}

export function allDailyMissionsCompleted(missions: DailyMission[]): boolean {
  return missions.length > 0 && missions.every((mission) => mission.completed);
}

export function allDailyMissionsClaimed(missions: DailyMission[]): boolean {
  return missions.length > 0 && missions.every((mission) => mission.completed && mission.claimed);
}

export function claimDailyMissionReward(
  missions: DailyMission[],
  missionId: string
): { missions: DailyMission[]; rewardExp: number; claimedMission?: DailyMission } {
  let rewardExp = 0;
  let claimedMission: DailyMission | undefined;

  const nextMissions = missions.map((mission) => {
    if (mission.id !== missionId || !mission.completed || mission.claimed) return mission;

    rewardExp = mission.rewardExp;
    claimedMission = {
      ...mission,
      claimed: true,
    };

    return claimedMission;
  });

  return {
    missions: nextMissions,
    rewardExp,
    claimedMission,
  };
}

export function calculateRankScore(stats: Pick<GamificationStats, 'totalExp' | 'streakDays' | 'totalCardsReviewed' | 'totalQuizzesCompleted'>): number {
  return Math.round(
    stats.totalExp +
    stats.streakDays * 50 +
    stats.totalCardsReviewed * 1 +
    stats.totalQuizzesCompleted * 50
  );
}

export function getUnlockedBadges(stats: GamificationStats, existingBadges: BadgeUnlock[] = [], now = new Date()): BadgeUnlock[] {
  const unlockedIds = new Set(existingBadges.map((badge) => badge.id));
  const nextBadges = [...existingBadges];
  const unlockedAt = now.toISOString();

  BADGES.forEach((badge) => {
    if (unlockedIds.has(badge.id)) return;

    const value = badge.metric === 'cards'
      ? stats.totalCardsReviewed
      : badge.metric === 'exp'
      ? stats.totalExp
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

export function formatMissionProgress(mission: DailyMission): string {
  if (mission.type === 'online_time') {
    const minutes = Math.floor(mission.progress / 60);
    const targetMinutes = Math.ceil(mission.target / 60);
    return `${minutes}/${targetMinutes} phút`;
  }

  return `${mission.progress}/${mission.target}`;
}
