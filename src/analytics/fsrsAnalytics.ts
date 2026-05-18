import { addDays, calculateRetrievability, round } from '../scheduler/intervalCalculator';
import { normalizeCardSchedule } from '../scheduler/fsrsScheduler';
import type { ReviewLog, SchedulerCardInput } from '../models/fsrs';

export const calculateRetentionRate = (logs: ReviewLog[]) => {
  if (logs.length === 0) return 0;
  const remembered = logs.filter((log) => log.rating !== 'again').length;
  return round(remembered / logs.length, 4);
};

export const buildForgettingCurve = (
  card: SchedulerCardInput,
  days = 30,
  now = new Date(),
) => {
  const schedule = normalizeCardSchedule(card, now);
  return Array.from({ length: days + 1 }, (_, day) => ({
    day,
    retrievability: round(calculateRetrievability(schedule.stability, day), 4),
  }));
};

export const buildReviewHeatmap = (logs: ReviewLog[]) =>
  logs.reduce<Record<string, number>>((heatmap, log) => {
    const key = log.reviewTime.slice(0, 10);
    heatmap[key] = (heatmap[key] || 0) + 1;
    return heatmap;
  }, {});

export const buildCardsPerDay = (logs: ReviewLog[]) =>
  Object.entries(buildReviewHeatmap(logs))
    .map(([date, count]) => ({ date, count }))
    .sort((a, b) => a.date.localeCompare(b.date));

export const buildWorkloadForecast = (
  cards: SchedulerCardInput[],
  days = 30,
  now = new Date(),
) => {
  const buckets = new Map<string, number>();
  for (let offset = 0; offset <= days; offset += 1) {
    buckets.set(addDays(now, offset).toISOString().slice(0, 10), 0);
  }

  cards.forEach((card) => {
    const schedule = normalizeCardSchedule(card, now);
    if (schedule.suspended) return;
    const dueKey = schedule.dueDate.slice(0, 10);
    if (buckets.has(dueKey)) {
      buckets.set(dueKey, (buckets.get(dueKey) || 0) + 1);
    }
  });

  return [...buckets.entries()].map(([date, count]) => ({ date, count }));
};
