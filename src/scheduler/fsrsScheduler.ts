import {
  createEmptyCard,
  fsrs,
  Rating,
  State,
  type CardInput,
  type FSRSParameters,
  type Grade,
  type Steps,
} from 'ts-fsrs';
import {
  calculateRetrievability,
  clamp,
  DAY_MS,
  daysBetween,
  getStudyDayKey,
  MINUTE_MS,
  round,
  stabilityForScheduledDays,
} from './intervalCalculator';
import type {
  CardState,
  InitialStability,
  LeechAction,
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

// The scheduling engine is ts-fsrs running the FSRS-6 model with its default
// weights. Everything in this module is a two-way adapter between the app's
// card/config shapes and the ts-fsrs Card/FSRSParameters shapes.
export const FSRS_VERSION = 'fsrs-6';
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
  leechThreshold: 8,
  leechAction: 'suspend',
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
    leechThreshold: Math.max(0, toPositiveInteger(config?.leechThreshold, DEFAULT_SCHEDULER_CONFIG.leechThreshold)),
    leechAction: (config?.leechAction === 'none' ? 'none' : 'suspend') as LeechAction,
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
  // Display placeholder only: ts-fsrs derives the real initial difficulty
  // from the first rating when the card leaves the 'new' state.
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
  // L1 fix (the audit's most serious bug): elapsed days are ALWAYS recomputed
  // from the last review timestamp. The stored `elapsedDays` field is never
  // trusted — the previous engine wrote 0 there after every review, which
  // pinned retrievability to 1 forever.
  const lastReviewDate = state === 'new'
    ? null
    : parseDate(lastReview) || parseDate(rawCard.updatedAt) || parseDate(createdAt);
  const elapsedDays = lastReviewDate ? round(daysBetween(lastReviewDate, now), 4) : 0;
  const inferredStability = scheduledDays > 0
    ? stabilityForScheduledDays(scheduledDays, config.desiredRetention, config.intervalModifier)
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
    firstReviewAt: typeof rawCard.firstReviewAt === 'string' ? rawCard.firstReviewAt : undefined,
    createdAt,
    updatedAt: rawCard.updatedAt || now.toISOString(),
    suspended: rawCard.suspended === true,
    buriedUntil: rawCard.buriedUntil || '',
    siblingKey: rawCard.siblingKey,
    noteId: rawCard.noteId,
    clozeGroupId: rawCard.clozeGroupId,
  };
};

// --- ts-fsrs adapter --------------------------------------------------------

const RATING_TO_GRADE: Record<SchedulerRating, Grade> = {
  again: Rating.Again,
  hard: Rating.Hard,
  good: Rating.Good,
  easy: Rating.Easy,
};

const STATE_TO_FSRS: Record<CardState, State> = {
  new: State.New,
  learning: State.Learning,
  review: State.Review,
  relearning: State.Relearning,
};

const STATE_FROM_FSRS: Record<number, CardState> = {
  [State.New]: 'new',
  [State.Learning]: 'learning',
  [State.Review]: 'review',
  [State.Relearning]: 'relearning',
};

const toFsrsSteps = (steps: SchedulerStep[]): Steps =>
  steps.map((step) => `${step.amount}${step.unit === 'minute' ? 'm' : 'd'}`) as unknown as Steps;

const toFsrsParameters = (config: SchedulerConfig): Partial<FSRSParameters> => ({
  request_retention: config.desiredRetention,
  maximum_interval: Math.max(1, Math.trunc(config.maximumInterval)),
  enable_fuzz: true,
  enable_short_term: true,
  learning_steps: toFsrsSteps(config.learningSteps),
  relearning_steps: toFsrsSteps(config.relearningSteps),
});

const toFsrsCard = (card: NormalizedSchedulerCard, config: SchedulerConfig): CardInput => {
  if (card.state === 'new') {
    // ts-fsrs validates the memory state of non-empty cards and rejects a
    // prefilled difficulty/stability of an app-side placeholder, so new
    // cards must enter the engine as a clean empty card.
    const empty = createEmptyCard(new Date(card.dueDate));
    return {
      ...empty,
      reps: card.reps,
      lapses: card.lapses,
    };
  }

  const steps = card.state === 'relearning' ? config.relearningSteps : config.learningSteps;
  return {
    due: new Date(card.dueDate),
    stability: card.stability,
    difficulty: card.difficulty,
    scheduled_days: Math.max(0, Math.round(card.scheduledDays)),
    learning_steps: Math.min(card.stepIndex, Math.max(0, steps.length - 1)),
    reps: card.reps,
    lapses: card.lapses,
    state: STATE_TO_FSRS[card.state],
    last_review: card.lastReview ? new Date(card.lastReview) : undefined,
  };
};

// --- result building --------------------------------------------------------

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

interface EngineOutcome {
  state: CardState;
  stability: number;
  difficulty: number;
  scheduledDays: number;
  stepIndex: number;
  dueDate: string;
  lapses: number;
  reps: number;
  leech: boolean;
}

const buildResult = (
  card: NormalizedSchedulerCard,
  rating: SchedulerRating,
  outcome: EngineOutcome,
  config: SchedulerConfig,
  now: Date,
): SchedulerResult => {
  const dueMs = new Date(outcome.dueDate).getTime() - now.getTime();
  const scheduledDelay: SchedulerResult['scheduledDelay'] = outcome.state === 'review'
    ? { amount: outcome.scheduledDays, unit: 'day' }
    : dueMs < DAY_MS
      ? { amount: Math.max(1, Math.round(dueMs / MINUTE_MS)), unit: 'minute' }
      : { amount: round(dueMs / DAY_MS, 2), unit: 'day' };
  const firstReviewAt = card.firstReviewAt || (card.state === 'new' ? now.toISOString() : undefined);
  const suspended = card.suspended || (outcome.leech && config.leechAction === 'suspend');

  const resultBase: Omit<SchedulerResult, 'reviewLog' | 'updatedCard'> = {
    rating,
    state: outcome.state,
    due: outcome.dueDate,
    dueDate: outcome.dueDate,
    nextReview: outcome.dueDate,
    stability: round(outcome.stability, 4),
    difficulty: round(outcome.difficulty, 4),
    retrievability: 1,
    // The elapsed time that actually fed this review (same value the
    // ReviewLog records). The previous engine always reported 0 here.
    elapsedDays: card.elapsedDays,
    scheduledDays: round(outcome.scheduledDays, 4),
    interval: round(outcome.scheduledDays, 4),
    easeFactor: difficultyToEaseFactor(outcome.difficulty, config),
    stepIndex: outcome.stepIndex,
    lapses: outcome.lapses,
    reps: outcome.reps,
    repetitions: outcome.reps,
    previousInterval: card.scheduledDays,
    newInterval: round(outcome.scheduledDays, 4),
    previousStability: card.stability,
    newStability: round(outcome.stability, 4),
    previousDifficulty: card.difficulty,
    newDifficulty: round(outcome.difficulty, 4),
    previousRetrievability: card.retrievability,
    scheduledDelay,
    leech: outcome.leech,
    firstReviewAt,
  };

  const updatedCard: NormalizedSchedulerCard = {
    ...card,
    state: outcome.state,
    due: outcome.dueDate,
    dueDate: outcome.dueDate,
    nextReview: outcome.dueDate,
    stability: resultBase.stability,
    difficulty: resultBase.difficulty,
    retrievability: resultBase.retrievability,
    // Freshly reviewed: 0 days have elapsed since this review. Future
    // normalize calls ignore this stored value and recompute from
    // lastReview anyway (see the L1 fix in normalizeCardSchedule).
    elapsedDays: 0,
    scheduledDays: resultBase.scheduledDays,
    interval: resultBase.interval,
    easeFactor: resultBase.easeFactor,
    stepIndex: outcome.stepIndex,
    lapses: outcome.lapses,
    reps: resultBase.reps,
    repetitions: resultBase.repetitions,
    lastReview: now.toISOString(),
    firstReviewAt,
    suspended,
    updatedAt: now.toISOString(),
  };
  const reviewLog = buildReviewLog(card, resultBase, now);

  return {
    ...resultBase,
    updatedCard,
    reviewLog,
  };
};

export const getRatingOptions = (): SchedulerRating[] => ['again', 'hard', 'good', 'easy'];

export function calculateSchedulerReview(
  rawCard: SchedulerCardInput,
  rating: SchedulerRating,
  rawConfig?: SchedulerConfigInput,
  now = new Date(),
): SchedulerResult {
  const config = normalizeSchedulerConfig(rawConfig);
  const card = normalizeCardSchedule(rawCard, now, config);
  const engine = fsrs(toFsrsParameters(config));
  const { card: nextCard } = engine.next(toFsrsCard(card, config), now, RATING_TO_GRADE[rating]);

  const state = STATE_FROM_FSRS[nextCard.state] || 'review';
  const dueDate = nextCard.due.toISOString();
  // For (re)learning steps the interval is the sub-day delay until the step
  // is due; for review cards it is the library's scheduled_days. `interval`
  // therefore always means "time until the next due" — the previous engine
  // violated this for Again-from-review (it stored the post-lapse interval).
  const scheduledDays = state === 'review'
    ? nextCard.scheduled_days
    : round(daysBetween(now, nextCard.due), 4);
  const stepIndex = state === 'learning' || state === 'relearning' ? nextCard.learning_steps : 0;

  // Leech: a lapse (Again from the review state) that pushes the lifetime
  // lapse count to the configured threshold flags the card; with the default
  // 'suspend' action it is also suspended so it leaves every queue.
  const leech = config.leechThreshold > 0
    && card.state === 'review'
    && rating === 'again'
    && nextCard.lapses >= config.leechThreshold;

  return buildResult(card, rating, {
    state,
    stability: nextCard.stability,
    difficulty: clamp(nextCard.difficulty, config.minimumDifficulty, config.maximumDifficulty),
    scheduledDays,
    stepIndex,
    dueDate,
    lapses: nextCard.lapses,
    reps: nextCard.reps,
    leech,
  }, config, now);
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

export const getLocalTomorrowIso = (now = new Date()) => {
  const tomorrow = new Date(now);
  tomorrow.setHours(24, 0, 0, 0);
  return tomorrow.toISOString();
};

export { getStudyDayKey };
