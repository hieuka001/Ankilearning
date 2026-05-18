import {
  addDays,
  addStep,
  calculateRetrievability,
  clamp,
  daysBetween,
  intervalForRetention,
  round,
  stepToDays,
} from './intervalCalculator';
import type {
  CardState,
  InitialStability,
  NormalizedSchedulerCard,
  ReviewLog,
  ScheduleReviewOutput,
  SchedulerCardInput,
  SchedulerConfig,
  SchedulerConfigInput,
  SchedulerRating,
  SchedulerResult,
  SchedulerStep,
} from '../models/fsrs';

const FSRS_VERSION = 'fsrs-dsr-v1';
const VALID_STATES: CardState[] = ['new', 'learning', 'review', 'relearning'];

export const DEFAULT_SCHEDULER_CONFIG: SchedulerConfig = {
  desiredRetention: 0.9,
  initialStability: {
    again: 0.4,
    hard: 1.2,
    good: 3,
    easy: 7,
  },
  initialDifficulty: 5,
  minimumDifficulty: 1,
  maximumDifficulty: 10,
  maximumInterval: 36500,
  learningSteps: [
    { amount: 1, unit: 'minute' },
    { amount: 10, unit: 'minute' },
    { amount: 1, unit: 'day' },
  ],
  relearningSteps: [
    { amount: 10, unit: 'minute' },
    { amount: 1, unit: 'day' },
  ],
  newCardsPerDay: 20,
  reviewsPerDay: 200,
  burySiblings: true,
  intervalModifier: 1,
  graduatingInterval: 3,
  easyInterval: 4,
  hardMultiplier: 1.2,
  easyBonus: 1.3,
  minimumEaseFactor: 1.3,
};

const toFiniteNumber = (value: unknown, fallback: number) => {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : fallback;
};

const toPositiveInteger = (value: unknown, fallback: number) =>
  Math.max(0, Math.trunc(toFiniteNumber(value, fallback)));

const parseDate = (value: unknown): Date | null => {
  if (value instanceof Date && Number.isFinite(value.getTime())) return value;
  if (typeof value !== 'string' || !value.trim()) return null;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
};

const readLastReview = (card: SchedulerCardInput) => {
  if (typeof card.lastReview === 'string') return card.lastReview;
  if (card.lastReview && typeof card.lastReview.reviewTime === 'string') return card.lastReview.reviewTime;
  return undefined;
};

const parseStep = (value: unknown): SchedulerStep | null => {
  if (typeof value === 'object' && value !== null) {
    const candidate = value as Partial<SchedulerStep>;
    const amount = toFiniteNumber(candidate.amount, 0);
    if (amount > 0 && (candidate.unit === 'minute' || candidate.unit === 'day')) {
      return { amount, unit: candidate.unit };
    }
  }

  if (typeof value === 'string') {
    const match = value.trim().toLowerCase().match(/^(\d+(?:\.\d+)?)\s*(m|min|minute|minutes|d|day|days)$/);
    if (!match) return null;
    const amount = Number(match[1]);
    const unit = match[2].startsWith('d') ? 'day' : 'minute';
    return amount > 0 ? { amount, unit } : null;
  }

  return null;
};

const normalizeStepList = (steps: unknown, fallback: SchedulerStep[]) => {
  if (!Array.isArray(steps)) return fallback;
  const normalized = steps.map(parseStep).filter((step): step is SchedulerStep => Boolean(step));
  return normalized.length > 0 ? normalized : fallback;
};

const normalizeInitialStability = (value: unknown): InitialStability => {
  const candidate = (typeof value === 'object' && value !== null ? value : {}) as Partial<InitialStability>;
  return {
    again: Math.max(0.1, toFiniteNumber(candidate.again, DEFAULT_SCHEDULER_CONFIG.initialStability.again)),
    hard: Math.max(0.1, toFiniteNumber(candidate.hard, DEFAULT_SCHEDULER_CONFIG.initialStability.hard)),
    good: Math.max(0.1, toFiniteNumber(candidate.good, DEFAULT_SCHEDULER_CONFIG.initialStability.good)),
    easy: Math.max(0.1, toFiniteNumber(candidate.easy, DEFAULT_SCHEDULER_CONFIG.initialStability.easy)),
  };
};

export const parseSchedulerSteps = (value: string, fallback: SchedulerStep[]) => {
  const steps = value
    .split(',')
    .map((item) => parseStep(item))
    .filter((step): step is SchedulerStep => Boolean(step));

  return steps.length > 0 ? steps : fallback;
};

export const serializeSchedulerSteps = (steps: SchedulerStep[]) =>
  steps.map((step) => `${step.amount}${step.unit === 'minute' ? 'm' : 'd'}`).join(', ');

export const normalizeSchedulerConfig = (config?: SchedulerConfigInput): SchedulerConfig => {
  const minimumDifficulty = clamp(
    toFiniteNumber(config?.minimumDifficulty, DEFAULT_SCHEDULER_CONFIG.minimumDifficulty),
    1,
    9.9,
  );
  const maximumDifficulty = clamp(
    toFiniteNumber(config?.maximumDifficulty, DEFAULT_SCHEDULER_CONFIG.maximumDifficulty),
    minimumDifficulty + 0.1,
    10,
  );

  return {
    desiredRetention: clamp(toFiniteNumber(config?.desiredRetention, DEFAULT_SCHEDULER_CONFIG.desiredRetention), 0.7, 0.98),
    initialStability: normalizeInitialStability(config?.initialStability),
    initialDifficulty: clamp(toFiniteNumber(config?.initialDifficulty, DEFAULT_SCHEDULER_CONFIG.initialDifficulty), minimumDifficulty, maximumDifficulty),
    minimumDifficulty,
    maximumDifficulty,
    maximumInterval: Math.max(1, toFiniteNumber(config?.maximumInterval, DEFAULT_SCHEDULER_CONFIG.maximumInterval)),
    learningSteps: normalizeStepList(config?.learningSteps, DEFAULT_SCHEDULER_CONFIG.learningSteps),
    relearningSteps: normalizeStepList(config?.relearningSteps, DEFAULT_SCHEDULER_CONFIG.relearningSteps),
    newCardsPerDay: Math.max(0, toPositiveInteger(config?.newCardsPerDay, DEFAULT_SCHEDULER_CONFIG.newCardsPerDay)),
    reviewsPerDay: Math.max(0, toPositiveInteger(config?.reviewsPerDay, DEFAULT_SCHEDULER_CONFIG.reviewsPerDay)),
    burySiblings: config?.burySiblings ?? DEFAULT_SCHEDULER_CONFIG.burySiblings,
    intervalModifier: Math.max(0.1, toFiniteNumber(config?.intervalModifier, DEFAULT_SCHEDULER_CONFIG.intervalModifier)),
    graduatingInterval: Math.max(1, toFiniteNumber(config?.graduatingInterval, DEFAULT_SCHEDULER_CONFIG.graduatingInterval)),
    easyInterval: Math.max(1, toFiniteNumber(config?.easyInterval, DEFAULT_SCHEDULER_CONFIG.easyInterval)),
    hardMultiplier: Math.max(1, toFiniteNumber(config?.hardMultiplier, DEFAULT_SCHEDULER_CONFIG.hardMultiplier)),
    easyBonus: Math.max(1, toFiniteNumber(config?.easyBonus, DEFAULT_SCHEDULER_CONFIG.easyBonus)),
    minimumEaseFactor: Math.max(1.3, toFiniteNumber(config?.minimumEaseFactor, DEFAULT_SCHEDULER_CONFIG.minimumEaseFactor)),
  };
};

const difficultyToEaseFactor = (difficulty: number, config: SchedulerConfig) => {
  const normalized = (difficulty - config.minimumDifficulty) / (config.maximumDifficulty - config.minimumDifficulty);
  return round(clamp(3 - normalized, config.minimumEaseFactor, 3), 2);
};

const easeFactorToDifficulty = (easeFactor: number, config: SchedulerConfig) => {
  const normalized = clamp(3 - easeFactor, 0, 2) / 2;
  return round(
    clamp(config.minimumDifficulty + normalized * (config.maximumDifficulty - config.minimumDifficulty), config.minimumDifficulty, config.maximumDifficulty),
    2,
  );
};

export const createInitialCardSchedule = (now = new Date()) => ({
  state: 'new' as CardState,
  due: now.toISOString(),
  dueDate: now.toISOString(),
  nextReview: now.toISOString(),
  stability: 0,
  difficulty: DEFAULT_SCHEDULER_CONFIG.initialDifficulty,
  retrievability: 1,
  elapsedDays: 0,
  scheduledDays: 0,
  interval: 0,
  easeFactor: difficultyToEaseFactor(DEFAULT_SCHEDULER_CONFIG.initialDifficulty, DEFAULT_SCHEDULER_CONFIG),
  stepIndex: 0,
  lapses: 0,
  reps: 0,
  repetitions: 0,
  suspended: false,
  buriedUntil: '',
  updatedAt: now.toISOString(),
});

export const normalizeCardSchedule = (
  rawCard: SchedulerCardInput,
  now = new Date(),
  rawConfig?: SchedulerConfigInput,
): NormalizedSchedulerCard => {
  const config = normalizeSchedulerConfig(rawConfig);
  const legacyInterval = Math.max(0, toFiniteNumber(rawCard.interval, 0));
  const scheduledDays = Math.max(0, toFiniteNumber(rawCard.scheduledDays, legacyInterval));
  const reps = Math.max(0, toPositiveInteger(rawCard.reps ?? rawCard.repetitions, 0));
  const state = rawCard.state && VALID_STATES.includes(rawCard.state)
    ? rawCard.state
    : scheduledDays > 0 || reps > 0
      ? 'review'
      : 'new';
  const createdAt = rawCard.createdAt || now.toISOString();
  const lastReview = readLastReview(rawCard);
  const dueDate = parseDate(rawCard.due)?.toISOString()
    || parseDate(rawCard.dueDate)?.toISOString()
    || parseDate(rawCard.nextReview)?.toISOString()
    || createdAt;
  const lastReviewDate = parseDate(lastReview) || parseDate(rawCard.updatedAt) || parseDate(createdAt) || now;
  const elapsedDays = state === 'new'
    ? 0
    : round(toFiniteNumber(rawCard.elapsedDays, daysBetween(lastReviewDate, now)), 4);
  const inferredStability = scheduledDays > 0
    ? scheduledDays / (9 * (1 / config.desiredRetention - 1) * config.intervalModifier)
    : config.initialStability.good;
  const stability = state === 'new'
    ? Math.max(0, toFiniteNumber(rawCard.stability, 0))
    : round(Math.max(0.1, toFiniteNumber(rawCard.stability, inferredStability)), 4);
  const difficulty = round(
    clamp(
      toFiniteNumber(rawCard.difficulty, rawCard.easeFactor ? easeFactorToDifficulty(rawCard.easeFactor, config) : config.initialDifficulty),
      config.minimumDifficulty,
      config.maximumDifficulty,
    ),
    4,
  );
  const retrievability = round(stability > 0 ? calculateRetrievability(stability, elapsedDays) : toFiniteNumber(rawCard.retrievability, 1), 4);

  return {
    id: rawCard.id || '',
    deckId: rawCard.deckId,
    state,
    due: dueDate,
    dueDate,
    nextReview: rawCard.nextReview || dueDate,
    stability,
    difficulty,
    retrievability,
    elapsedDays,
    scheduledDays,
    interval: scheduledDays,
    easeFactor: round(toFiniteNumber(rawCard.easeFactor, difficultyToEaseFactor(difficulty, config)), 2),
    stepIndex: Math.max(0, Math.trunc(toFiniteNumber(rawCard.stepIndex, 0))),
    lapses: Math.max(0, Math.trunc(toFiniteNumber(rawCard.lapses, 0))),
    reps,
    repetitions: reps,
    lastReview,
    createdAt,
    updatedAt: rawCard.updatedAt || now.toISOString(),
    suspended: rawCard.suspended === true,
    buriedUntil: rawCard.buriedUntil || '',
    siblingKey: rawCard.siblingKey,
    noteId: rawCard.noteId,
    clozeGroupId: rawCard.clozeGroupId,
  };
};

const nextDifficulty = (previousDifficulty: number, rating: SchedulerRating, config: SchedulerConfig) => {
  const ratingDelta: Record<SchedulerRating, number> = {
    again: 0.9,
    hard: 0.35,
    good: -0.05,
    easy: -0.45,
  };
  const meanReversion = (config.initialDifficulty - previousDifficulty) * 0.05;
  return round(clamp(previousDifficulty + ratingDelta[rating] + meanReversion, config.minimumDifficulty, config.maximumDifficulty), 4);
};

const initialStabilityFor = (rating: SchedulerRating, config: SchedulerConfig) =>
  config.initialStability[rating];

const nextRecallStability = (
  card: NormalizedSchedulerCard,
  rating: Exclude<SchedulerRating, 'again'>,
  newDifficulty: number,
  config: SchedulerConfig,
) => {
  const stability = Math.max(0.1, card.stability || initialStabilityFor(rating, config));
  if (rating === 'hard') {
    return round(clamp(stability * config.hardMultiplier, 0.1, config.maximumInterval), 4);
  }

  const ratingBoost = rating === 'easy' ? 3 : 2.1;
  const difficultyFactor = clamp((11 - newDifficulty) / 6, 0.15, 1.7);
  const stabilityFactor = stability ** -0.18;
  const retrievabilityGap = 1 + Math.max(0.03, 1 - card.retrievability) * 2;
  const growth = 1 + ratingBoost * difficultyFactor * stabilityFactor * retrievabilityGap;
  return round(clamp(stability * growth, 0.1, config.maximumInterval), 4);
};

const nextForgetStability = (card: NormalizedSchedulerCard, config: SchedulerConfig) => {
  const stability = Math.max(0.1, card.stability || config.initialStability.again);
  const retrievabilityPenalty = clamp(card.retrievability, 0.25, 1);
  return round(clamp(stability * 0.45 * retrievabilityPenalty, config.initialStability.again, config.maximumInterval), 4);
};

const buildReviewLog = (
  card: NormalizedSchedulerCard,
  result: Omit<SchedulerResult, 'reviewLog' | 'updatedCard'>,
  now: Date,
): ReviewLog => ({
  id: `${card.id || 'local'}-${now.getTime()}-${result.rating}`,
  cardId: card.id || '',
  rating: result.rating,
  reviewTime: now.toISOString(),
  previousStability: card.stability,
  newStability: result.stability,
  previousDifficulty: card.difficulty,
  newDifficulty: result.difficulty,
  previousInterval: card.scheduledDays,
  newInterval: result.scheduledDays,
  elapsedDays: card.elapsedDays,
  previousRetrievability: card.retrievability,
  newRetrievability: result.retrievability,
  previousState: card.state,
  newState: result.state,
  schedulerVersion: FSRS_VERSION,
});

const buildResult = (
  card: NormalizedSchedulerCard,
  rating: SchedulerRating,
  state: CardState,
  stability: number,
  difficulty: number,
  scheduledDays: number,
  stepIndex: number,
  dueDate: string,
  scheduledDelay: SchedulerResult['scheduledDelay'],
  config: SchedulerConfig,
  now: Date,
  lapses = card.lapses,
): SchedulerResult => {
  const resultBase = {
    rating,
    state,
    due: dueDate,
    dueDate,
    nextReview: dueDate,
    stability: round(stability, 4),
    difficulty: round(difficulty, 4),
    retrievability: 1,
    elapsedDays: 0,
    scheduledDays: round(scheduledDays, 4),
    interval: round(scheduledDays, 4),
    easeFactor: difficultyToEaseFactor(difficulty, config),
    stepIndex,
    lapses,
    reps: card.reps + 1,
    repetitions: card.reps + 1,
    previousInterval: card.scheduledDays,
    newInterval: round(scheduledDays, 4),
    previousStability: card.stability,
    newStability: round(stability, 4),
    previousDifficulty: card.difficulty,
    newDifficulty: round(difficulty, 4),
    previousRetrievability: card.retrievability,
    scheduledDelay,
  };

  const updatedCard: NormalizedSchedulerCard = {
    ...card,
    state,
    due: dueDate,
    dueDate,
    nextReview: dueDate,
    stability: resultBase.stability,
    difficulty: resultBase.difficulty,
    retrievability: resultBase.retrievability,
    elapsedDays: resultBase.elapsedDays,
    scheduledDays: resultBase.scheduledDays,
    interval: resultBase.interval,
    easeFactor: resultBase.easeFactor,
    stepIndex,
    lapses,
    reps: resultBase.reps,
    repetitions: resultBase.repetitions,
    lastReview: now.toISOString(),
    updatedAt: now.toISOString(),
  };
  const reviewLog = buildReviewLog(card, resultBase, now);

  return {
    ...resultBase,
    updatedCard,
    reviewLog,
  };
};

const buildStepResult = (
  card: NormalizedSchedulerCard,
  rating: SchedulerRating,
  state: CardState,
  stepIndex: number,
  step: SchedulerStep,
  stability: number,
  difficulty: number,
  config: SchedulerConfig,
  now: Date,
  lapses = card.lapses,
) => {
  const dueDate = addStep(now, step).toISOString();
  return buildResult(card, rating, state, stability, difficulty, stepToDays(step), stepIndex, dueDate, step, config, now, lapses);
};

const buildReviewResult = (
  card: NormalizedSchedulerCard,
  rating: SchedulerRating,
  stability: number,
  difficulty: number,
  config: SchedulerConfig,
  now: Date,
  lapses = card.lapses,
) => {
  const scheduledDays = intervalForRetention(stability, config.desiredRetention, config.intervalModifier, config.maximumInterval);
  const dueDate = addDays(now, scheduledDays).toISOString();
  return buildResult(card, rating, 'review', stability, difficulty, scheduledDays, 0, dueDate, { amount: scheduledDays, unit: 'day' }, config, now, lapses);
};

const relearningStep = (
  card: NormalizedSchedulerCard,
  rating: SchedulerRating,
  stability: number,
  difficulty: number,
  config: SchedulerConfig,
  now: Date,
  lapses = card.lapses,
) => buildStepResult(card, rating, 'relearning', 0, config.relearningSteps[0], stability, difficulty, config, now, lapses);

export const getRatingOptions = (): SchedulerRating[] => ['again', 'hard', 'good', 'easy'];

export function calculateSchedulerReview(
  rawCard: SchedulerCardInput,
  rating: SchedulerRating,
  rawConfig?: SchedulerConfigInput,
  now = new Date(),
): SchedulerResult {
  const config = normalizeSchedulerConfig(rawConfig);
  const card = normalizeCardSchedule(rawCard, now, config);
  const difficulty = nextDifficulty(card.difficulty, rating, config);

  if (card.state === 'new') {
    const stability = initialStabilityFor(rating, config);
    if (rating === 'again') {
      return buildStepResult(card, rating, 'learning', 0, config.learningSteps[0], stability, difficulty, config, now);
    }
    if (rating === 'hard') {
      const nextStep = Math.min(1, config.learningSteps.length - 1);
      return buildStepResult(card, rating, 'learning', nextStep, config.learningSteps[nextStep], stability, difficulty, config, now);
    }
    return buildReviewResult(card, rating, stability, difficulty, config, now);
  }

  if (card.state === 'learning') {
    if (rating === 'again') {
      return buildStepResult(card, rating, 'learning', 0, config.learningSteps[0], nextForgetStability(card, config), difficulty, config, now);
    }
    if (rating === 'hard') {
      const stepIndex = Math.min(card.stepIndex, config.learningSteps.length - 1);
      const stability = Math.max(card.stability, config.initialStability.hard);
      return buildStepResult(card, rating, 'learning', stepIndex, config.learningSteps[stepIndex], stability, difficulty, config, now);
    }
    if (rating === 'easy') {
      const stability = Math.max(nextRecallStability(card, rating, difficulty, config), config.initialStability.easy);
      return buildReviewResult(card, rating, stability, difficulty, config, now);
    }

    const nextStep = card.stepIndex + 1;
    const stability = Math.max(card.stability, config.initialStability.good);
    return config.learningSteps[nextStep]
      ? buildStepResult(card, rating, 'learning', nextStep, config.learningSteps[nextStep], stability, difficulty, config, now)
      : buildReviewResult(card, rating, stability, difficulty, config, now);
  }

  if (card.state === 'relearning') {
    if (rating === 'again') {
      return relearningStep(card, rating, nextForgetStability(card, config), difficulty, config, now);
    }
    if (rating === 'hard') {
      const stability = Math.max(card.stability, config.initialStability.hard);
      return relearningStep(card, rating, stability, difficulty, config, now);
    }
    if (rating === 'easy') {
      const stability = nextRecallStability(card, rating, difficulty, config);
      return buildReviewResult(card, rating, stability, difficulty, config, now);
    }

    const nextStep = card.stepIndex + 1;
    const stability = Math.max(card.stability, config.initialStability.good);
    return config.relearningSteps[nextStep]
      ? buildStepResult(card, rating, 'relearning', nextStep, config.relearningSteps[nextStep], stability, difficulty, config, now)
      : buildReviewResult(card, rating, stability, difficulty, config, now);
  }

  if (rating === 'again') {
    const stability = nextForgetStability(card, config);
    const futureInterval = intervalForRetention(stability, config.desiredRetention, config.intervalModifier, config.maximumInterval);
    const dueDate = addStep(now, config.relearningSteps[0]).toISOString();
    return buildResult(card, rating, 'relearning', stability, difficulty, futureInterval, 0, dueDate, config.relearningSteps[0], config, now, card.lapses + 1);
  }

  const stability = nextRecallStability(card, rating, difficulty, config);
  return buildReviewResult(card, rating, stability, difficulty, config, now);
}

export function scheduleReview(
  card: SchedulerCardInput,
  rating: SchedulerRating,
  config?: SchedulerConfigInput,
  now = new Date(),
): ScheduleReviewOutput {
  const result = calculateSchedulerReview(card, rating, config, now);
  return {
    nextDueDate: result.dueDate,
    nextInterval: result.interval,
    updatedCard: result.updatedCard,
    reviewLog: result.reviewLog,
    result,
  };
}

export const getRatingPreviews = (
  card: SchedulerCardInput,
  config?: SchedulerConfigInput,
  now = new Date(),
) =>
  getRatingOptions().map((rating) => ({
    rating,
    result: calculateSchedulerReview(card, rating, config, now),
  }));

export const getCardDueDate = (card: SchedulerCardInput) =>
  normalizeCardSchedule(card).dueDate;

export const isCardBuried = (card: SchedulerCardInput, now = new Date()) => {
  if (!card.buriedUntil) return false;
  const buriedUntil = new Date(card.buriedUntil);
  return Number.isFinite(buriedUntil.getTime()) && buriedUntil > now;
};

export const isCardDue = (card: SchedulerCardInput, now = new Date()) => {
  const schedule = normalizeCardSchedule(card, now);
  if (schedule.suspended || isCardBuried(schedule, now)) return false;

  const dueDate = new Date(schedule.dueDate);
  return Number.isFinite(dueDate.getTime()) && dueDate <= now;
};

export const getNextAvailableTime = (card: SchedulerCardInput, now = new Date()) => {
  const schedule = normalizeCardSchedule(card, now);
  const dueCandidates = [schedule.dueDate, schedule.buriedUntil]
    .filter(Boolean)
    .map((date) => new Date(date))
    .filter((date) => Number.isFinite(date.getTime()) && date > now);

  return dueCandidates.length ? new Date(Math.min(...dueCandidates.map((date) => date.getTime()))) : null;
};

export const getLocalTomorrowIso = (now = new Date()) => {
  const tomorrow = new Date(now);
  tomorrow.setHours(24, 0, 0, 0);
  return tomorrow.toISOString();
};

export function calculateNextReview(
  quality: number,
  repetitions: number,
  easeFactor: number,
  interval: number,
) {
  const rating: SchedulerRating = quality <= 1 ? 'again' : quality === 3 ? 'hard' : quality >= 5 ? 'easy' : 'good';
  const result = calculateSchedulerReview(
    {
      state: interval > 0 || repetitions > 0 ? 'review' : 'new',
      repetitions,
      reps: repetitions,
      easeFactor,
      interval,
      scheduledDays: interval,
      dueDate: new Date().toISOString(),
    },
    rating,
  );

  return {
    repetitions: result.repetitions,
    reps: result.reps,
    easeFactor: result.easeFactor,
    interval: result.interval,
    scheduledDays: result.scheduledDays,
    stability: result.stability,
    difficulty: result.difficulty,
    retrievability: result.retrievability,
    nextReview: result.nextReview,
    dueDate: result.dueDate,
    due: result.due,
    state: result.state,
    stepIndex: result.stepIndex,
    lapses: result.lapses,
  };
}
