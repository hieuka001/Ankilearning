import { calculateSchedulerReview, normalizeCardSchedule } from '../scheduler/fsrsScheduler';
import type {
  NormalizedSchedulerCard,
  ReviewLog,
  SchedulerCardInput,
  SchedulerConfigInput,
  SchedulerRating,
} from '../models/fsrs';

export interface OfflineReviewEvent {
  id: string;
  cardId: string;
  rating: SchedulerRating;
  reviewTime: string;
  clientId: string;
}

export const createOfflineReviewEvent = (
  cardId: string,
  rating: SchedulerRating,
  clientId = 'local',
  now = new Date(),
): OfflineReviewEvent => ({
  id: `${clientId}-${cardId}-${now.getTime()}-${rating}`,
  cardId,
  rating,
  reviewTime: now.toISOString(),
  clientId,
});

export const mergeReviewLogs = (logs: ReviewLog[]) => {
  const byId = new Map<string, ReviewLog>();
  logs.forEach((log) => byId.set(log.id, log));
  return [...byId.values()].sort((a, b) => a.reviewTime.localeCompare(b.reviewTime));
};

export const rebuildCardFromLogs = (
  baseCard: SchedulerCardInput,
  logs: ReviewLog[],
  config?: SchedulerConfigInput,
): NormalizedSchedulerCard => {
  const orderedLogs = mergeReviewLogs(logs);
  return orderedLogs.reduce<NormalizedSchedulerCard>((card, log) => {
    const result = calculateSchedulerReview(card, log.rating, config, new Date(log.reviewTime));
    return result.updatedCard;
  }, normalizeCardSchedule(baseCard, new Date(baseCard.createdAt || Date.now()), config));
};
