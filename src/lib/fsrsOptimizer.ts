import {
  createEmptyCard,
  fsrs,
  Rating,
  type Card,
  type Grade,
} from 'ts-fsrs';
import {
  clampFsrsWeights,
  DEFAULT_FSRS_WEIGHTS,
  FSRS_WEIGHT_BOUNDS,
  normalizeSchedulerConfig,
} from '../scheduler/fsrsScheduler';
import type {
  SchedulerConfig,
  SchedulerConfigInput,
  SchedulerRating,
} from '../models/fsrs';

/**
 * Personalized FSRS-6 parameter optimization (đợt 4) — the in-app
 * equivalent of Anki's "Optimize FSRS parameters" button.
 *
 * Method (same principle as the reference FSRS optimizers, deliberately
 * simpler machinery so it can run in the browser):
 *
 * 1. `buildReviewSequences` turns each card's stored `reviewHistory`
 *    (ReviewLog entries written atomically with every review) into a
 *    clean chronological (rating, reviewTime) sequence.
 * 2. `evaluateWeights` REPLAYS every sequence through a ts-fsrs engine
 *    built with a candidate weight vector — the same engine, learning
 *    steps and short-term settings the live scheduler uses. Before each
 *    review (except a card's first, which has no prior prediction) the
 *    engine's retrievability for the simulated card is the model's
 *    predicted recall probability; the binary outcome is "forgot"
 *    (Again) vs "remembered" (any other rating). The score is the mean
 *    log-loss over all such samples — lower is a better fit.
 * 3. `optimizeWeights` runs greedy coordinate descent over all 21
 *    weights: per round, each weight is tried ×step and (if that did
 *    not help) ÷step, keeping only changes that lower the log-loss;
 *    the step shrinks every round and the search stops early when a
 *    full round barely improves. Every candidate stays inside the
 *    settings-level safe window (`FSRS_WEIGHT_BOUNDS`), so what the
 *    optimizer returns is exactly what `normalizeSchedulerConfig`
 *    will keep when the user saves.
 *
 * Compute budget: input is capped at the 20.000 most recent reviews;
 * with ~5.000 reviews a full run is a few seconds of pure CPU, and the
 * caller can yield between rounds (see `OptimizeWeightsOptions`).
 * Everything in this module is pure/deterministic: fuzz is disabled
 * for replay and no wall-clock or randomness is consulted.
 */

/** Minimum prediction samples before fitting is meaningful (Anki's threshold). */
export const MIN_OPTIMIZATION_SAMPLES = 400;

/** Hard cap on reviews replayed per optimization run (most recent win). */
export const MAX_OPTIMIZER_REVIEWS = 20_000;

/** Clamp for predicted probabilities so a single confident miss stays finite. */
const PROBABILITY_EPSILON = 0.001;

const GRADE_BY_RATING: Record<SchedulerRating, Grade> = {
  again: Rating.Again,
  hard: Rating.Hard,
  good: Rating.Good,
  easy: Rating.Easy,
};

const VALID_RATINGS: ReadonlySet<string> = new Set(['again', 'hard', 'good', 'easy']);

export interface ReviewSequenceEntry {
  rating: SchedulerRating;
  /** ISO timestamp of the review. */
  reviewTime: string;
}

export interface ReviewSequence {
  cardId?: string;
  /** Chronological, validated reviews of one card (always ≥ 2 entries). */
  reviews: ReviewSequenceEntry[];
}

/** Structural shape of a card(-like) document carrying a review history. */
export interface ReviewHistorySource {
  id?: string;
  reviewHistory?: unknown;
}

/**
 * Build per-card review sequences from card documents' `reviewHistory`
 * arrays. Entries with an unknown rating or unparseable timestamp are
 * dropped; sequences with fewer than 2 valid reviews are dropped (they
 * would contribute zero prediction samples).
 */
export function buildReviewSequences(
  sources: readonly (ReviewHistorySource | null | undefined)[],
): ReviewSequence[] {
  const sequences: ReviewSequence[] = [];
  sources.forEach((source) => {
    const history = source?.reviewHistory;
    if (!Array.isArray(history)) return;
    const reviews: ReviewSequenceEntry[] = [];
    history.forEach((entry) => {
      if (!entry || typeof entry !== 'object') return;
      const candidate = entry as { rating?: unknown; reviewTime?: unknown };
      if (typeof candidate.rating !== 'string' || !VALID_RATINGS.has(candidate.rating)) return;
      if (typeof candidate.reviewTime !== 'string') return;
      if (!Number.isFinite(Date.parse(candidate.reviewTime))) return;
      reviews.push({
        rating: candidate.rating as SchedulerRating,
        reviewTime: candidate.reviewTime,
      });
    });
    reviews.sort((a, b) => Date.parse(a.reviewTime) - Date.parse(b.reviewTime));
    if (reviews.length >= 2) {
      sequences.push({ cardId: source?.id, reviews });
    }
  });
  return sequences;
}

/** Number of prediction samples a sequence set yields (all reviews but each card's first). */
export function countPredictionSamples(sequences: readonly ReviewSequence[]): number {
  return sequences.reduce(
    (total, sequence) => total + Math.max(0, sequence.reviews.length - 1),
    0,
  );
}

/** Total reviews across sequences. */
export function countReviews(sequences: readonly ReviewSequence[]): number {
  return sequences.reduce((total, sequence) => total + sequence.reviews.length, 0);
}

/**
 * Keep only the `maxReviews` most recent reviews (by review time, across
 * all cards), preserving each card's chronological order. Sequences
 * that fall below 2 reviews are dropped.
 */
export function limitReviewSequences(
  sequences: readonly ReviewSequence[],
  maxReviews: number = MAX_OPTIMIZER_REVIEWS,
): ReviewSequence[] {
  if (countReviews(sequences) <= maxReviews) return [...sequences];

  const flat: Array<{ sequenceIndex: number; entryIndex: number; time: number }> = [];
  sequences.forEach((sequence, sequenceIndex) => {
    sequence.reviews.forEach((review, entryIndex) => {
      flat.push({ sequenceIndex, entryIndex, time: Date.parse(review.reviewTime) });
    });
  });
  flat.sort((a, b) => b.time - a.time);
  const kept = new Set(flat.slice(0, maxReviews).map((item) => `${item.sequenceIndex}:${item.entryIndex}`));

  const limited: ReviewSequence[] = [];
  sequences.forEach((sequence, sequenceIndex) => {
    const reviews = sequence.reviews.filter((_, entryIndex) =>
      kept.has(`${sequenceIndex}:${entryIndex}`));
    if (reviews.length >= 2) limited.push({ cardId: sequence.cardId, reviews });
  });
  return limited;
}

/** Sequences pre-parsed into parallel arrays for repeated replay. */
interface CompiledSequence {
  grades: Grade[];
  /** Epoch milliseconds of each review, chronological. */
  times: number[];
  /** Binary outcomes per review: 0 = forgot (Again), 1 = remembered. */
  outcomes: number[];
}

function compileSequences(sequences: readonly ReviewSequence[]): CompiledSequence[] {
  return sequences.map((sequence) => ({
    grades: sequence.reviews.map((review) => GRADE_BY_RATING[review.rating]),
    times: sequence.reviews.map((review) => Date.parse(review.reviewTime)),
    outcomes: sequence.reviews.map((review) => (review.rating === 'again' ? 0 : 1)),
  }));
}

function buildReplayEngine(config: SchedulerConfig, weights: number[]) {
  // Mirrors the live scheduler's parameter construction
  // (scheduler/fsrsScheduler `toFsrsParameters`) with two deliberate
  // differences: fuzz is OFF so replay is deterministic, and the weight
  // vector is the candidate under evaluation.
  return fsrs({
    request_retention: config.desiredRetention,
    maximum_interval: Math.max(1, Math.trunc(config.maximumInterval)),
    enable_fuzz: false,
    enable_short_term: true,
    learning_steps: config.learningSteps.map(
      (step) => `${step.amount}${step.unit === 'minute' ? 'm' : 'd'}`,
    ) as never,
    relearning_steps: config.relearningSteps.map(
      (step) => `${step.amount}${step.unit === 'minute' ? 'm' : 'd'}`,
    ) as never,
    w: [...weights],
  });
}

function evaluateCompiled(
  compiled: readonly CompiledSequence[],
  weights: number[],
  config: SchedulerConfig,
): WeightEvaluation {
  const engine = buildReplayEngine(config, weights);
  let totalLoss = 0;
  let samples = 0;

  for (const sequence of compiled) {
    if (sequence.times.length < 2) continue;
    let card: Card = createEmptyCard(new Date(sequence.times[0]));
    for (let index = 0; index < sequence.times.length; index += 1) {
      const at = new Date(sequence.times[index]);
      if (index > 0) {
        const predicted = engine.retrievability(card, at);
        const probability = Number.isFinite(predicted)
          ? Math.min(1 - PROBABILITY_EPSILON, Math.max(PROBABILITY_EPSILON, predicted))
          : 0.5;
        const outcome = sequence.outcomes[index];
        totalLoss += -(
          outcome * Math.log(probability)
          + (1 - outcome) * Math.log(1 - probability)
        );
        samples += 1;
      }
      card = engine.next(card, at, sequence.grades[index]).card;
    }
  }

  return { logLoss: samples > 0 ? totalLoss / samples : Number.NaN, samples };
}

export interface WeightEvaluation {
  /** Mean log-loss per prediction sample (NaN when there are no samples). */
  logLoss: number;
  samples: number;
}

/**
 * Score a weight vector against review sequences by full replay.
 * `weights` is validated/clamped exactly like stored settings; an
 * invalid vector falls back to the FSRS-6 defaults.
 */
export function evaluateWeights(
  sequences: readonly ReviewSequence[],
  weights: readonly number[],
  rawConfig?: SchedulerConfigInput,
): WeightEvaluation {
  const config = normalizeSchedulerConfig(rawConfig);
  const validWeights = clampFsrsWeights(weights) ?? [...DEFAULT_FSRS_WEIGHTS];
  return evaluateCompiled(compileSequences(sequences), validWeights, config);
}

export type OptimizeWeightsResult =
  | {
      status: 'ok';
      weights: number[];
      logLossBefore: number;
      logLossAfter: number;
      samples: number;
      reviewsUsed: number;
    }
  | { status: 'insufficient-data'; samples: number; reviewsUsed: number }
  | { status: 'cancelled'; samples: number; reviewsUsed: number };

export interface OptimizeWeightsOptions {
  /** Scheduler config whose retention/steps the replay should mirror. */
  config?: SchedulerConfigInput;
  /** Review cap for this run (default `MAX_OPTIMIZER_REVIEWS`). */
  maxReviews?: number;
  /** Awaited between descent rounds so the UI thread can breathe. */
  yieldBetweenRounds?: () => Promise<void>;
  /** Polled between rounds; returning true aborts with status 'cancelled'. */
  isCancelled?: () => boolean;
}

/** Multiplicative step sizes per descent round (coarse → fine). */
const DESCENT_STEPS = [1.3, 1.12, 1.05];
/** A round improving the mean log-loss by less than this ends the search. */
const MIN_ROUND_IMPROVEMENT = 0.0002;

/**
 * Fit personalized weights by greedy coordinate descent on replay
 * log-loss, starting from `baseWeights` (defaults or the user's current
 * personalized set). Returns `insufficient-data` when the sequences
 * yield fewer than `MIN_OPTIMIZATION_SAMPLES` prediction samples.
 */
export async function optimizeWeights(
  sequences: readonly ReviewSequence[],
  baseWeights: readonly number[],
  options: OptimizeWeightsOptions = {},
): Promise<OptimizeWeightsResult> {
  const config = normalizeSchedulerConfig(options.config);
  const limited = limitReviewSequences(sequences, options.maxReviews ?? MAX_OPTIMIZER_REVIEWS);
  const reviewsUsed = countReviews(limited);
  const samples = countPredictionSamples(limited);
  if (samples < MIN_OPTIMIZATION_SAMPLES) {
    return { status: 'insufficient-data', samples, reviewsUsed };
  }

  const compiled = compileSequences(limited);
  let current = clampFsrsWeights(baseWeights) ?? [...DEFAULT_FSRS_WEIGHTS];
  let currentLoss = evaluateCompiled(compiled, current, config).logLoss;
  const logLossBefore = currentLoss;

  for (const step of DESCENT_STEPS) {
    if (options.isCancelled?.()) {
      return { status: 'cancelled', samples, reviewsUsed };
    }
    let roundImprovement = 0;

    for (let index = 0; index < current.length; index += 1) {
      const [low, high] = FSRS_WEIGHT_BOUNDS[index];
      // First-improvement greedy: try ×step, then ÷step only if needed.
      for (const factor of [step, 1 / step]) {
        const candidateValue = Math.min(high, Math.max(low, current[index] * factor));
        if (candidateValue === current[index]) continue;
        const candidate = current.slice();
        candidate[index] = candidateValue;
        const candidateLoss = evaluateCompiled(compiled, candidate, config).logLoss;
        if (candidateLoss < currentLoss - 1e-9) {
          roundImprovement += currentLoss - candidateLoss;
          current = candidate;
          currentLoss = candidateLoss;
          break;
        }
      }
    }

    if (options.yieldBetweenRounds) {
      await options.yieldBetweenRounds();
    }
    if (roundImprovement < MIN_ROUND_IMPROVEMENT) break;
  }

  if (options.isCancelled?.()) {
    return { status: 'cancelled', samples, reviewsUsed };
  }

  return {
    status: 'ok',
    weights: current,
    logLossBefore,
    logLossAfter: currentLoss,
    samples,
    reviewsUsed,
  };
}
