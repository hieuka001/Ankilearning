export type CardState = 'new' | 'learning' | 'review' | 'relearning';
export type SchedulerRating = 'again' | 'hard' | 'good' | 'easy';
export type StepUnit = 'minute' | 'day';
export type LeechAction = 'suspend' | 'none';

export interface SchedulerStep {
  amount: number;
  unit: StepUnit;
}

export interface InitialStability {
  again: number;
  hard: number;
  good: number;
  easy: number;
}

export interface SchedulerConfig {
  desiredRetention: number;
  initialStability: InitialStability;
  initialDifficulty: number;
  minimumDifficulty: number;
  maximumDifficulty: number;
  maximumInterval: number;
  learningSteps: SchedulerStep[];
  relearningSteps: SchedulerStep[];
  newCardsPerDay: number;
  reviewsPerDay: number;
  burySiblings: boolean;
  intervalModifier: number;
  graduatingInterval: number;
  easyInterval: number;
  hardMultiplier: number;
  easyBonus: number;
  minimumEaseFactor: number;
  leechThreshold: number;
  leechAction: LeechAction;
}

export interface SchedulerConfigInput extends Partial<Omit<SchedulerConfig, 'initialStability'>> {
  initialStability?: Partial<InitialStability>;
}

export interface SchedulerCardInput {
  id?: string;
  deckId?: string;
  front?: string;
  back?: string;
  state?: CardState;
  due?: Date | string;
  dueDate?: string;
  nextReview?: string;
  stability?: number;
  difficulty?: number;
  retrievability?: number;
  elapsedDays?: number;
  scheduledDays?: number;
  interval?: number;
  easeFactor?: number;
  stepIndex?: number;
  lapses?: number;
  reps?: number;
  repetitions?: number;
  lastReview?: string | { reviewTime?: string };
  firstReviewAt?: string;
  createdAt?: string;
  updatedAt?: string;
  suspended?: boolean;
  buriedUntil?: string;
  siblingKey?: string;
  noteId?: string;
  clozeGroupId?: string;
}

export interface NormalizedSchedulerCard {
  id: string;
  deckId?: string;
  state: CardState;
  due: string;
  dueDate: string;
  nextReview: string;
  stability: number;
  difficulty: number;
  retrievability: number;
  elapsedDays: number;
  scheduledDays: number;
  interval: number;
  easeFactor: number;
  stepIndex: number;
  lapses: number;
  reps: number;
  repetitions: number;
  lastReview?: string;
  firstReviewAt?: string;
  createdAt: string;
  updatedAt: string;
  suspended: boolean;
  buriedUntil: string;
  siblingKey?: string;
  noteId?: string;
  clozeGroupId?: string;
}

export interface ReviewLog {
  id: string;
  cardId: string;
  rating: SchedulerRating;
  reviewTime: string;
  previousStability: number;
  newStability: number;
  previousDifficulty: number;
  newDifficulty: number;
  previousInterval: number;
  newInterval: number;
  elapsedDays: number;
  previousRetrievability: number;
  newRetrievability: number;
  previousState: CardState;
  newState: CardState;
  schedulerVersion: string;
}

export interface SchedulerResult {
  rating: SchedulerRating;
  state: CardState;
  due: string;
  dueDate: string;
  nextReview: string;
  stability: number;
  difficulty: number;
  retrievability: number;
  elapsedDays: number;
  scheduledDays: number;
  interval: number;
  easeFactor: number;
  stepIndex: number;
  lapses: number;
  reps: number;
  repetitions: number;
  previousInterval: number;
  newInterval: number;
  previousStability: number;
  newStability: number;
  previousDifficulty: number;
  newDifficulty: number;
  previousRetrievability: number;
  scheduledDelay: SchedulerStep | { amount: number; unit: 'day' };
  leech?: boolean;
  firstReviewAt?: string;
  updatedCard: NormalizedSchedulerCard;
  reviewLog: ReviewLog;
}

export interface ScheduleReviewOutput {
  nextDueDate: string;
  nextInterval: number;
  updatedCard: NormalizedSchedulerCard;
  reviewLog: ReviewLog;
  result: SchedulerResult;
}
