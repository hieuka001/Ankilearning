import { calculateSchedulerReview, createInitialCardSchedule, normalizeSchedulerConfig } from './fsrsScheduler';
import type { ReviewLog, SchedulerConfigInput, SchedulerRating } from '../models/fsrs';

export interface ReviewSimulationStep {
  rating: SchedulerRating;
  dueDate: string;
  interval: number;
  stability: number;
  difficulty: number;
  retrievability: number;
  state: string;
}

export function simulateReviews(
  ratings: SchedulerRating[],
  config?: SchedulerConfigInput,
  start = new Date(),
) {
  const normalizedConfig = normalizeSchedulerConfig(config);
  let card = {
    id: 'simulation-card',
    ...createInitialCardSchedule(start),
    createdAt: start.toISOString(),
  };
  const logs: ReviewLog[] = [];
  const timeline: ReviewSimulationStep[] = [];
  let reviewTime = start;

  ratings.forEach((rating) => {
    const result = calculateSchedulerReview(card, rating, normalizedConfig, reviewTime);
    logs.push(result.reviewLog);
    timeline.push({
      rating,
      dueDate: result.dueDate,
      interval: result.interval,
      stability: result.stability,
      difficulty: result.difficulty,
      retrievability: result.retrievability,
      state: result.state,
    });
    card = {
      ...card,
      ...result.updatedCard,
    };
    reviewTime = new Date(result.dueDate);
  });

  return {
    card,
    logs,
    timeline,
  };
}
