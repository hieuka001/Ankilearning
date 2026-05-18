export type CardState = 'new' | 'learning' | 'review' | 'relearning';
export type SchedulerRating = 'again' | 'hard' | 'good' | 'easy';
export type StepUnit = 'minute' | 'day';

export interface SchedulerStep {
  amount: number;
  unit: StepUnit;
}

export interface SchedulerConfig {
  learningSteps: SchedulerStep[];
  relearningSteps: SchedulerStep[];
  graduatingInterval: number;
  easyInterval: number;
  hardMultiplier: number;
  easyBonus: number;
  intervalModifier: number;
  minimumEaseFactor: number;
}

export interface SchedulerCardInput {
  state?: CardState;
  interval?: number;
  easeFactor?: number;
  stepIndex?: number;
  dueDate?: string;
  nextReview?: string;
  lapses?: number;
  repetitions?: number;
  suspended?: boolean;
  buriedUntil?: string;
  createdAt?: string;
}

export interface SchedulerResult {
  rating: SchedulerRating;
  state: CardState;
  interval: number;
  easeFactor: number;
  stepIndex: number;
  dueDate: string;
  nextReview: string;
  lapses: number;
  repetitions: number;
  previousInterval: number;
  newInterval: number;
  scheduledDelay: SchedulerStep | { amount: number; unit: 'day' };
}

const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * 60 * MINUTE_MS;

export const DEFAULT_SCHEDULER_CONFIG: SchedulerConfig = {
  learningSteps: [
    { amount: 1, unit: 'minute' },
    { amount: 10, unit: 'minute' },
    { amount: 1, unit: 'day' },
  ],
  relearningSteps: [
    { amount: 10, unit: 'minute' },
    { amount: 1, unit: 'day' },
  ],
  graduatingInterval: 3,
  easyInterval: 4,
  hardMultiplier: 1.2,
  easyBonus: 1.3,
  intervalModifier: 1,
  minimumEaseFactor: 1.3,
};

const VALID_STATES: CardState[] = ['new', 'learning', 'review', 'relearning'];

const toFiniteNumber = (value: unknown, fallback: number) => {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : fallback;
};

const clampEaseFactor = (value: number, minimumEaseFactor: number) =>
  Math.max(minimumEaseFactor, Number(value.toFixed(2)));

const normalizeInterval = (value: number) => Math.max(0, Number(value.toFixed(2)));

const addStep = (date: Date, step: SchedulerStep) =>
  new Date(date.getTime() + step.amount * (step.unit === 'minute' ? MINUTE_MS : DAY_MS));

const addDays = (date: Date, days: number) => new Date(date.getTime() + days * DAY_MS);

export const createInitialCardSchedule = (now = new Date()) => ({
  state: 'new' as CardState,
  interval: 0,
  easeFactor: DEFAULT_SCHEDULER_CONFIG.minimumEaseFactor + 1.2,
  stepIndex: 0,
  dueDate: now.toISOString(),
  nextReview: now.toISOString(),
  lapses: 0,
  repetitions: 0,
  suspended: false,
  buriedUntil: '',
});

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

export const parseSchedulerSteps = (value: string, fallback: SchedulerStep[]) => {
  const steps = value
    .split(',')
    .map((item) => parseStep(item))
    .filter((step): step is SchedulerStep => Boolean(step));

  return steps.length > 0 ? steps : fallback;
};

export const serializeSchedulerSteps = (steps: SchedulerStep[]) =>
  steps.map((step) => `${step.amount}${step.unit === 'minute' ? 'm' : 'd'}`).join(', ');

const normalizeStepList = (steps: unknown, fallback: SchedulerStep[]) => {
  if (!Array.isArray(steps)) return fallback;
  const normalized = steps.map(parseStep).filter((step): step is SchedulerStep => Boolean(step));
  return normalized.length > 0 ? normalized : fallback;
};

export const normalizeSchedulerConfig = (config?: Partial<SchedulerConfig>): SchedulerConfig => ({
  learningSteps: normalizeStepList(config?.learningSteps, DEFAULT_SCHEDULER_CONFIG.learningSteps),
  relearningSteps: normalizeStepList(config?.relearningSteps, DEFAULT_SCHEDULER_CONFIG.relearningSteps),
  graduatingInterval: Math.max(1, toFiniteNumber(config?.graduatingInterval, DEFAULT_SCHEDULER_CONFIG.graduatingInterval)),
  easyInterval: Math.max(1, toFiniteNumber(config?.easyInterval, DEFAULT_SCHEDULER_CONFIG.easyInterval)),
  hardMultiplier: Math.max(1, toFiniteNumber(config?.hardMultiplier, DEFAULT_SCHEDULER_CONFIG.hardMultiplier)),
  easyBonus: Math.max(1, toFiniteNumber(config?.easyBonus, DEFAULT_SCHEDULER_CONFIG.easyBonus)),
  intervalModifier: Math.max(0.1, toFiniteNumber(config?.intervalModifier, DEFAULT_SCHEDULER_CONFIG.intervalModifier)),
  minimumEaseFactor: Math.max(1.3, toFiniteNumber(config?.minimumEaseFactor, DEFAULT_SCHEDULER_CONFIG.minimumEaseFactor)),
});

export const normalizeCardSchedule = (card: SchedulerCardInput, now = new Date()) => {
  const legacyInterval = toFiniteNumber(card.interval, 0);
  const state = card.state && VALID_STATES.includes(card.state)
    ? card.state
    : legacyInterval > 0 || toFiniteNumber(card.repetitions, 0) > 0
      ? 'review'
      : 'new';
  const dueDate = card.dueDate || card.nextReview || card.createdAt || now.toISOString();

  return {
    state,
    interval: Math.max(0, legacyInterval),
    easeFactor: Math.max(DEFAULT_SCHEDULER_CONFIG.minimumEaseFactor, toFiniteNumber(card.easeFactor, 2.5)),
    stepIndex: Math.max(0, Math.trunc(toFiniteNumber(card.stepIndex, 0))),
    dueDate,
    nextReview: card.nextReview || dueDate,
    lapses: Math.max(0, Math.trunc(toFiniteNumber(card.lapses, 0))),
    repetitions: Math.max(0, Math.trunc(toFiniteNumber(card.repetitions, 0))),
    suspended: card.suspended === true,
    buriedUntil: card.buriedUntil || '',
  };
};

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

const buildResult = (
  card: ReturnType<typeof normalizeCardSchedule>,
  rating: SchedulerRating,
  updates: Omit<SchedulerResult, 'rating' | 'previousInterval' | 'newInterval'>,
): SchedulerResult => ({
  rating,
  ...updates,
  previousInterval: card.interval,
  newInterval: updates.interval,
});

const stepResult = (
  card: ReturnType<typeof normalizeCardSchedule>,
  rating: SchedulerRating,
  state: CardState,
  stepIndex: number,
  step: SchedulerStep,
  now: Date,
) => {
  const dueDate = addStep(now, step).toISOString();
  return buildResult(card, rating, {
    state,
    interval: card.interval,
    easeFactor: card.easeFactor,
    stepIndex,
    dueDate,
    nextReview: dueDate,
    lapses: card.lapses,
    repetitions: card.repetitions,
    scheduledDelay: step,
  });
};

const reviewResult = (
  card: ReturnType<typeof normalizeCardSchedule>,
  rating: SchedulerRating,
  interval: number,
  easeFactor: number,
  now: Date,
  extra?: Partial<Pick<SchedulerResult, 'lapses' | 'repetitions' | 'state' | 'stepIndex'>>,
) => {
  const normalizedInterval = normalizeInterval(interval);
  const dueDate = addDays(now, normalizedInterval).toISOString();
  return buildResult(card, rating, {
    state: extra?.state || 'review',
    interval: normalizedInterval,
    easeFactor,
    stepIndex: extra?.stepIndex ?? 0,
    dueDate,
    nextReview: dueDate,
    lapses: extra?.lapses ?? card.lapses,
    repetitions: extra?.repetitions ?? card.repetitions + 1,
    scheduledDelay: { amount: normalizedInterval, unit: 'day' },
  });
};

const graduate = (
  card: ReturnType<typeof normalizeCardSchedule>,
  rating: SchedulerRating,
  interval: number,
  now: Date,
) => reviewResult(card, rating, interval, card.easeFactor, now);

export const getRatingOptions = (card: SchedulerCardInput): SchedulerRating[] => {
  const state = normalizeCardSchedule(card).state;
  if (state === 'review') return ['again', 'hard', 'good', 'easy'];
  if (state === 'relearning') return ['again', 'good'];
  return ['again', 'good', 'easy'];
};

export function calculateSchedulerReview(
  rawCard: SchedulerCardInput,
  rating: SchedulerRating,
  rawConfig?: Partial<SchedulerConfig>,
  now = new Date(),
): SchedulerResult {
  const config = normalizeSchedulerConfig(rawConfig);
  const card = normalizeCardSchedule(rawCard, now);
  const easeFactor = clampEaseFactor(card.easeFactor, config.minimumEaseFactor);

  if (card.state === 'new') {
    if (rating === 'again') {
      return stepResult(card, rating, 'learning', 0, config.learningSteps[0], now);
    }

    if (rating === 'easy') {
      return graduate(card, rating, config.easyInterval, now);
    }

    const nextStep = 1;
    return config.learningSteps[nextStep]
      ? stepResult(card, rating, 'learning', nextStep, config.learningSteps[nextStep], now)
      : graduate(card, rating, config.graduatingInterval, now);
  }

  if (card.state === 'learning') {
    if (rating === 'again') {
      return stepResult(card, rating, 'learning', 0, config.learningSteps[0], now);
    }

    if (rating === 'easy') {
      return graduate(card, rating, config.easyInterval, now);
    }

    const nextStep = card.stepIndex + 1;
    return config.learningSteps[nextStep]
      ? stepResult(card, rating, 'learning', nextStep, config.learningSteps[nextStep], now)
      : graduate(card, rating, config.graduatingInterval, now);
  }

  if (card.state === 'relearning') {
    if (rating === 'again') {
      return stepResult(card, rating, 'relearning', 0, config.relearningSteps[0], now);
    }

    const nextStep = card.stepIndex + 1;
    if (config.relearningSteps[nextStep]) {
      return stepResult(card, 'good', 'relearning', nextStep, config.relearningSteps[nextStep], now);
    }

    return reviewResult(card, 'good', Math.max(1, card.interval), easeFactor, now, {
      repetitions: card.repetitions + 1,
    });
  }

  const currentInterval = Math.max(1, card.interval || config.graduatingInterval);

  if (rating === 'again') {
    const relearningStep = config.relearningSteps[0];
    const newInterval = Math.max(1, currentInterval * 0.3);
    const dueDate = addStep(now, relearningStep).toISOString();
    return buildResult(card, rating, {
      state: 'relearning',
      interval: normalizeInterval(newInterval),
      easeFactor: clampEaseFactor(easeFactor - 0.2, config.minimumEaseFactor),
      stepIndex: 0,
      dueDate,
      nextReview: dueDate,
      lapses: card.lapses + 1,
      repetitions: 0,
      scheduledDelay: relearningStep,
    });
  }

  if (rating === 'hard') {
    return reviewResult(
      card,
      rating,
      currentInterval * config.hardMultiplier * config.intervalModifier,
      clampEaseFactor(easeFactor - 0.15, config.minimumEaseFactor),
      now,
    );
  }

  if (rating === 'easy') {
    return reviewResult(
      card,
      rating,
      currentInterval * easeFactor * config.easyBonus * config.intervalModifier,
      Number((easeFactor + 0.15).toFixed(2)),
      now,
    );
  }

  return reviewResult(
    card,
    rating,
    currentInterval * easeFactor * config.intervalModifier,
    easeFactor,
    now,
  );
}

export const getRatingPreviews = (
  card: SchedulerCardInput,
  config?: Partial<SchedulerConfig>,
  now = new Date(),
) =>
  getRatingOptions(card).map((rating) => ({
    rating,
    result: calculateSchedulerReview(card, rating, config, now),
  }));

export const formatScheduledDelay = (delay: SchedulerResult['scheduledDelay']) => {
  if (delay.unit === 'minute') {
    return delay.amount < 60 ? `${delay.amount} phút` : `${Number((delay.amount / 60).toFixed(1))} giờ`;
  }

  if (delay.amount < 1) {
    return `${Math.round(delay.amount * 24)} giờ`;
  }

  return `${Number(delay.amount.toFixed(1)).toString().replace(/\\.0$/, '')} ngày`;
};

/**
 * Backward-compatible wrapper for older callers. New code should use
 * calculateSchedulerReview with again/hard/good/easy ratings.
 */
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
      easeFactor,
      interval,
      dueDate: new Date().toISOString(),
    },
    rating,
  );

  return {
    repetitions: result.repetitions,
    easeFactor: result.easeFactor,
    interval: result.interval,
    nextReview: result.nextReview,
    dueDate: result.dueDate,
    state: result.state,
    stepIndex: result.stepIndex,
    lapses: result.lapses,
  };
}
