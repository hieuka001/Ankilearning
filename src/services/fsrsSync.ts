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

// Already dedupes by log id (later copies win) and orders by review time;
// rebuildCardFromLogs relies on this so merged online/offline logs replay
// each review exactly once.
export const mergeReviewLogs = (logs: ReviewLog[]) => {
  const byId = new Map<string, ReviewLog>();
  logs.forEach((log) => byId.set(log.id, log));
  return [...byId.values()].sort((a, b) => a.reviewTime.localeCompare(b.reviewTime));
};

// Replays the merged logs through the current engine (ts-fsrs / FSRS-6).
// Replay is deterministic — the engine's fuzz is seeded from the card — so
// rebuilding from the same logs always yields the same card.
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
