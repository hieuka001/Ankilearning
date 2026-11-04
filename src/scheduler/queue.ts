import {
  isCardBuried,
  isCardDue,
  normalizeCardSchedule,
  normalizeSchedulerConfig,
} from './fsrsScheduler';
import { getStudyDayKey } from './intervalCalculator';
import type { SchedulerCardInput, SchedulerConfigInput } from '../models/fsrs';

export interface StudyQueues<T extends SchedulerCardInput> {
  learning: T[];
  relearning: T[];
  review: T[];
  new: T[];
  all: T[];
}

export interface StudyQueueLimits {
  introducedToday?: number;
  reviewedToday?: number;
}

const dueTime = (card: SchedulerCardInput, now: Date) =>
  new Date(normalizeCardSchedule(card, now).dueDate).getTime();

const sortByDueDate = <T extends SchedulerCardInput>(cards: T[], now: Date) =>
  [...cards].sort((a, b) => dueTime(a, now) - dueTime(b, now));

const getSiblingKey = (card: SchedulerCardInput) =>
  card.siblingKey || card.noteId || card.clozeGroupId || '';

const applySiblingBury = <T extends SchedulerCardInput>(cards: T[], enabled: boolean) => {
  if (!enabled) return cards;
  const seen = new Set<string>();
  return cards.filter((card) => {
    const key = getSiblingKey(card);
    if (!key) return true;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

export function sortCardsForStudy<T extends SchedulerCardInput>(
  cards: T[],
  config?: SchedulerConfigInput,
  now = new Date(),
) {
  const normalizedConfig = normalizeSchedulerConfig(config);
  const stateOrder = {
    learning: 0,
    relearning: 1,
    review: 2,
    new: 3,
  };
  const sorted = [...cards].sort((a, b) => {
    const aSchedule = normalizeCardSchedule(a, now, normalizedConfig);
    const bSchedule = normalizeCardSchedule(b, now, normalizedConfig);
    return stateOrder[aSchedule.state] - stateOrder[bSchedule.state]
      || new Date(aSchedule.dueDate).getTime() - new Date(bSchedule.dueDate).getTime();
  });

  return applySiblingBury(sorted, normalizedConfig.burySiblings);
}

export function buildStudyQueues<T extends SchedulerCardInput>(
  cards: T[],
  config?: SchedulerConfigInput,
  now = new Date(),
  limits?: StudyQueueLimits,
): StudyQueues<T> {
  const normalizedConfig = normalizeSchedulerConfig(config);
  const dueCards = cards.filter((card) => {
    const schedule = normalizeCardSchedule(card, now, normalizedConfig);
    return !schedule.suspended && !isCardBuried(card, now) && isCardDue(card, now);
  });

  const byState = (state: string) =>
    sortByDueDate(dueCards.filter((card) => normalizeCardSchedule(card, now, normalizedConfig).state === state), now);

  // Bury runs AFTER due-date sorting (and on the queue in study order), so
  // the sibling that survives is the one due earliest / studied first. The
  // previous engine buried on the unsorted Firestore order, keeping an
  // arbitrary sibling.
  const ordered = applySiblingBury(
    [...byState('learning'), ...byState('relearning'), ...byState('review'), ...byState('new')],
    normalizedConfig.burySiblings,
  );
  const group = (state: string) =>
    ordered.filter((card) => normalizeCardSchedule(card, now, normalizedConfig).state === state);

  // Daily limits are real per-day limits: when the caller reports how many
  // cards were already introduced/reviewed today, only the remainder is
  // offered. Without that information the behavior matches the old engine
  // (full configured limit per queue build).
  const remainingReviews = Math.max(0, normalizedConfig.reviewsPerDay - Math.max(0, Math.trunc(limits?.reviewedToday ?? 0)));
  const remainingNew = Math.max(0, normalizedConfig.newCardsPerDay - Math.max(0, Math.trunc(limits?.introducedToday ?? 0)));

  const learning = group('learning');
  const relearning = group('relearning');
  const review = group('review').slice(0, remainingReviews);
  const newQueue = group('new').slice(0, remainingNew);

  return {
    learning,
    relearning,
    review,
    new: newQueue,
    all: [...learning, ...relearning, ...review, ...newQueue],
  };
}

const readLastReviewIso = (card: SchedulerCardInput) => {
  if (typeof card.lastReview === 'string') return card.lastReview;
  if (card.lastReview && typeof card.lastReview.reviewTime === 'string') return card.lastReview.reviewTime;
  return undefined;
};

// Counts how many cards were first introduced on the given local study day.
// Primary source is `firstReviewAt` (stamped by the engine when a card
// leaves the 'new' state for the first time). Cards created before that
// field existed fall back to an approximation: last review on the same day
// and at least one rep — this can over-count a card that was introduced
// earlier and merely reviewed again today, so prefer firstReviewAt.
export const countIntroducedToday = (cards: SchedulerCardInput[], now = new Date()) => {
  const todayKey = getStudyDayKey(now);
  return cards.reduce((count, card) => {
    const firstReviewAt = typeof card.firstReviewAt === 'string' ? new Date(card.firstReviewAt) : null;
    if (firstReviewAt && Number.isFinite(firstReviewAt.getTime())) {
      return count + (getStudyDayKey(firstReviewAt) === todayKey ? 1 : 0);
    }
    const lastReviewIso = readLastReviewIso(card);
    const lastReview = lastReviewIso ? new Date(lastReviewIso) : null;
    const reps = Math.max(0, Math.trunc(Number(card.reps ?? card.repetitions ?? 0)) || 0);
    if (lastReview && Number.isFinite(lastReview.getTime()) && reps >= 1 && getStudyDayKey(lastReview) === todayKey) {
      return count + 1;
    }
    return count;
  }, 0);
};
