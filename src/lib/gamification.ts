/**
 * Gamification utility for calculating levels and XP
 */

export const XP_PER_CARD = 10;
export const XP_PER_STREAK_DAY = 100;
export const XP_PER_EXAM = 500;

/**
 * Calculate level based on total XP
 * Level = floor(sqrt(XP / 500)) + 1
 */
export function calculateLevel(xp: number = 0): number {
  return Math.floor(Math.sqrt(xp / 500)) + 1;
}

/**
 * Calculate XP required for the next level
 */
export function xpForNextLevel(currentLevel: number): number {
  return Math.pow(currentLevel, 2) * 500;
}

/**
 * Calculate progress percentage within current level
 */
export function calculateLevelProgress(xp: number = 0): number {
  const currentLevel = calculateLevel(xp);
  const xpBasis = xpForNextLevel(currentLevel - 1);
  const xpNext = xpForNextLevel(currentLevel);
  
  if (xpNext === xpBasis) return 0;
  
  const progress = ((xp - xpBasis) / (xpNext - xpBasis)) * 100;
  return Math.min(Math.max(progress, 0), 100);
}

export const ACHIEVEMENTS = [
  { id: 'first_steps', title: 'Khởi đầu nan', description: 'Học bộ thẻ đầu tiên', icon: '🌱', threshold: 1 },
  { id: 'scholar', title: 'Học giả', description: 'Học tổng cộng 100 thẻ', icon: '📚', threshold: 100 },
  { id: 'master', title: 'Bậc thầy tri thức', description: 'Học tổng cộng 1000 thẻ', icon: '🧙‍♂️', threshold: 1000 },
  { id: 'streak_7', title: 'Kiên trì', description: 'Đạt Streak 7 ngày', icon: '🔥', threshold: 7 },
  { id: 'streak_30', title: 'Kỷ luật thép', description: 'Đạt Streak 30 ngày', icon: '💎', threshold: 30 },
];
