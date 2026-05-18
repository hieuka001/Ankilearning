import {
  isCardBuried,
  isCardDue,
  normalizeCardSchedule,
  normalizeSchedulerConfig,
} from './fsrsScheduler';
import type { SchedulerCardInput, SchedulerConfigInput } from '../models/fsrs';

export interface StudyQueues<T extends SchedulerCardInput> {
  learning: T[];
  relearning: T[];
  review: T[];
  new: T[];
  all: T[];
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
): StudyQueues<T> {
  const normalizedConfig = normalizeSchedulerConfig(config);
  const dueCards = applySiblingBury(
    cards.filter((card) => {
      const schedule = normalizeCardSchedule(card, now, normalizedConfig);
      return !schedule.suspended && !isCardBuried(card, now) && isCardDue(card, now);
    }),
    normalizedConfig.burySiblings,
  );

  const learning = sortByDueDate(dueCards.filter((card) => normalizeCardSchedule(card, now, normalizedConfig).state === 'learning'), now);
  const relearning = sortByDueDate(dueCards.filter((card) => normalizeCardSchedule(card, now, normalizedConfig).state === 'relearning'), now);
  const review = sortByDueDate(dueCards.filter((card) => normalizeCardSchedule(card, now, normalizedConfig).state === 'review'), now)
    .slice(0, normalizedConfig.reviewsPerDay);
  const newQueue = sortByDueDate(dueCards.filter((card) => normalizeCardSchedule(card, now, normalizedConfig).state === 'new'), now)
    .slice(0, normalizedConfig.newCardsPerDay);

  return {
    learning,
    relearning,
    review,
    new: newQueue,
    all: [...learning, ...relearning, ...review, ...newQueue],
  };
}

export const selectNextCard = <T extends SchedulerCardInput>(
  cards: T[],
  config?: SchedulerConfigInput,
  now = new Date(),
) => buildStudyQueues(cards, config, now).all[0] || null;
