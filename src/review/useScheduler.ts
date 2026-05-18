import { useCallback } from 'react';
import {
  calculateSchedulerReview,
  getRatingPreviews,
  normalizeCardSchedule,
  type SchedulerConfigInput,
  type SchedulerRating,
} from '../lib/spacedRepetition';
import type { Flashcard, ReviewLog } from '../types';

export function useScheduler(schedulerConfig?: SchedulerConfigInput) {
  const previewRatings = useCallback((card: Flashcard, now = new Date()) =>
    getRatingPreviews(card, schedulerConfig, now), [schedulerConfig]);

  const reviewCard = useCallback((card: Flashcard, rating: SchedulerRating, reviewTime = new Date()) => {
    const previousSchedule = normalizeCardSchedule(card, reviewTime);
    const result = calculateSchedulerReview(card, rating, schedulerConfig, reviewTime);
    const historyEntry: ReviewLog = {
      ...result.reviewLog,
      cardId: card.id,
      reviewTime: reviewTime.toISOString(),
      previousState: previousSchedule.state,
      newState: result.state,
    };
    const schedulerUpdate: Partial<Flashcard> = {
      state: result.state,
      due: result.due,
      interval: result.interval,
      easeFactor: result.easeFactor,
      stability: result.stability,
      difficulty: result.difficulty,
      retrievability: result.retrievability,
      elapsedDays: result.elapsedDays,
      scheduledDays: result.scheduledDays,
      stepIndex: result.stepIndex,
      dueDate: result.dueDate,
      nextReview: result.nextReview,
      lapses: result.lapses,
      reps: result.reps,
      repetitions: result.repetitions,
      lastReview: historyEntry,
      updatedAt: reviewTime.toISOString(),
    };

    return {
      result,
      historyEntry,
      schedulerUpdate,
      previousSchedule,
    };
  }, [schedulerConfig]);

  return {
    previewRatings,
    reviewCard,
  };
}
