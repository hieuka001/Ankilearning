import { format, startOfDay, subDays } from 'date-fns';
import type { ReviewLog } from '../types';

/**
 * Deep, Anki-style statistics computed from REAL stored data only:
 *
 * - Card maturity comes from the live card documents
 *   (`decks/{deckId}/cards`): `state`, `stability`, `suspended`.
 * - Review aggregates come from `ReviewLog` entries. Every flushed review
 *   is written by `review/firebaseSync.ts` atomically in ONE batch to both
 *   the dedicated log doc `decks/{deckId}/cards/{cardId}/reviews/{logId}`
 *   AND the card document's `reviewHistory` array (owner reviews), or to
 *   `users/{uid}/cardProgress/{deckId}__{cardId}.reviewHistory` (reviews of
 *   other people's decks). These helpers consume the `reviewHistory`
 *   arrays — the same ReviewLog payload — so callers need no extra reads.
 *
 * Nothing here estimates or back-fills: a window with no logs yields
 * explicit empty results (rate `null`, zero counts) for the UI to label
 * as "not enough data".
 */

/** A review-stability (in days) at or above this counts as a mature card (Anki convention). */
export const MATURE_STABILITY_DAYS = 21;

/** Default look-back window for the review aggregates, in local calendar days. */
export const DEEP_STATS_WINDOW_DAYS = 30;

export type CardMaturityCategory = 'new' | 'learning' | 'young' | 'mature' | 'suspended';

/** Structural subset of `Flashcard` the maturity classification reads. */
export interface MaturityCardInput {
  state?: string;
  stability?: number;
  suspended?: boolean;
  reps?: number;
  repetitions?: number;
}

export interface CardMaturityCounts {
  new: number;
  learning: number;
  young: number;
  mature: number;
  suspended: number;
  total: number;
}

export function classifyCardMaturity(card: MaturityCardInput): CardMaturityCategory {
  if (card.suspended) return 'suspended';
  if (card.state === 'learning' || card.state === 'relearning') return 'learning';
  if (card.state === 'review') {
    return (card.stability ?? 0) >= MATURE_STABILITY_DAYS ? 'mature' : 'young';
  }
  if (card.state === 'new') return 'new';
  // Legacy cards written before the FSRS `state` field existed: a card that
  // has been reviewed at least once behaves like a review card; anything
  // else has never left the "new" pool.
  const reviewed = (card.reps ?? 0) > 0 || (card.repetitions ?? 0) > 0;
  if (reviewed) {
    return (card.stability ?? 0) >= MATURE_STABILITY_DAYS ? 'mature' : 'young';
  }
  return 'new';
}

export function computeCardMaturity(cards: readonly MaturityCardInput[]): CardMaturityCounts {
  const counts: CardMaturityCounts = {
    new: 0,
    learning: 0,
    young: 0,
    mature: 0,
    suspended: 0,
    total: 0,
  };
  cards.forEach((card) => {
    counts[classifyCardMaturity(card)] += 1;
    counts.total += 1;
  });
  return counts;
}

/** Structural subset of `ReviewLog` the review aggregates read. */
export type ReviewRating = ReviewLog['rating'];

export interface ReviewLogLike {
  rating: ReviewRating;
  reviewTime: string;
  previousState?: string;
}

const VALID_RATINGS: ReadonlySet<string> = new Set(['again', 'hard', 'good', 'easy']);

/**
 * Flatten the `reviewHistory` arrays of card / cardProgress documents into
 * validated review logs. Entries with an unknown rating or an unparseable
 * timestamp are dropped — they cannot be placed in any honest aggregate.
 */
export function collectReviewLogs(
  sources: readonly ({ reviewHistory?: unknown } | null | undefined)[],
): ReviewLogLike[] {
  const logs: ReviewLogLike[] = [];
  sources.forEach((source) => {
    const history = source?.reviewHistory;
    if (!Array.isArray(history)) return;
    history.forEach((entry) => {
      if (!entry || typeof entry !== 'object') return;
      const candidate = entry as { rating?: unknown; reviewTime?: unknown; previousState?: unknown };
      if (typeof candidate.rating !== 'string' || !VALID_RATINGS.has(candidate.rating)) return;
      if (typeof candidate.reviewTime !== 'string') return;
      if (Number.isNaN(new Date(candidate.reviewTime).getTime())) return;
      logs.push({
        rating: candidate.rating as ReviewRating,
        reviewTime: candidate.reviewTime,
        previousState: typeof candidate.previousState === 'string' ? candidate.previousState : undefined,
      });
    });
  });
  return logs;
}

/** Start (local midnight) of the trailing `windowDays`-day window that includes `now`. */
export function reviewWindowStart(now: Date, windowDays: number): Date {
  return subDays(startOfDay(now), Math.max(1, windowDays) - 1);
}

function isInWindow(reviewTime: string, windowStartMs: number): boolean {
  const time = new Date(reviewTime).getTime();
  return !Number.isNaN(time) && time >= windowStartMs;
}

export interface TrueRetentionResult {
  /** Reviews inside the window whose card was in 'review' state before the rating. */
  totalReviewStateReviews: number;
  /** Of those, the ones NOT rated 'again' (the card was retained). */
  retained: number;
  /** retained / total, or null when there is no review-state review in the window. */
  rate: number | null;
  windowDays: number;
}

/**
 * True retention (Anki): among reviews of cards that were already in the
 * review state (graduated cards — learning/relearning steps are excluded,
 * as are first reviews of new cards), the share that did NOT lapse
 * (rating other than 'again').
 */
export function computeTrueRetention(
  logs: readonly ReviewLogLike[],
  now: Date = new Date(),
  windowDays: number = DEEP_STATS_WINDOW_DAYS,
): TrueRetentionResult {
  const windowStartMs = reviewWindowStart(now, windowDays).getTime();
  let total = 0;
  let retained = 0;
  logs.forEach((log) => {
    if (log.previousState !== 'review') return;
    if (!isInWindow(log.reviewTime, windowStartMs)) return;
    total += 1;
    if (log.rating !== 'again') retained += 1;
  });
  return {
    totalReviewStateReviews: total,
    retained,
    rate: total > 0 ? retained / total : null,
    windowDays,
  };
}

export interface ReviewsByDayPoint {
  /** Local day key, yyyy-MM-dd. */
  date: string;
  /** Short label for chart axes, dd/MM. */
  label: string;
  count: number;
}

/** Review counts for each of the last `days` local calendar days, oldest first. */
export function buildReviewsByDay(
  logs: readonly ReviewLogLike[],
  now: Date = new Date(),
  days: number = DEEP_STATS_WINDOW_DAYS,
): ReviewsByDayPoint[] {
  const points: ReviewsByDayPoint[] = [];
  const indexByDate = new Map<string, number>();
  for (let i = days - 1; i >= 0; i -= 1) {
    const day = subDays(startOfDay(now), i);
    const key = format(day, 'yyyy-MM-dd');
    indexByDate.set(key, points.length);
    points.push({ date: key, label: format(day, 'dd/MM'), count: 0 });
  }
  logs.forEach((log) => {
    const time = new Date(log.reviewTime);
    if (Number.isNaN(time.getTime())) return;
    const index = indexByDate.get(format(time, 'yyyy-MM-dd'));
    if (index !== undefined) points[index].count += 1;
  });
  return points;
}

export interface RatingDistribution {
  again: number;
  hard: number;
  good: number;
  easy: number;
  /** All reviews inside the window, regardless of prior card state. */
  total: number;
  windowDays: number;
}

/** How often each of the four answer buttons was pressed inside the window. */
export function computeRatingDistribution(
  logs: readonly ReviewLogLike[],
  now: Date = new Date(),
  windowDays: number = DEEP_STATS_WINDOW_DAYS,
): RatingDistribution {
  const windowStartMs = reviewWindowStart(now, windowDays).getTime();
  const distribution: RatingDistribution = {
    again: 0,
    hard: 0,
    good: 0,
    easy: 0,
    total: 0,
    windowDays,
  };
  logs.forEach((log) => {
    if (!isInWindow(log.reviewTime, windowStartMs)) return;
    distribution[log.rating] += 1;
    distribution.total += 1;
  });
  return distribution;
}

export interface DeepReviewSummary {
  retention: TrueRetentionResult;
  reviewsByDay: ReviewsByDayPoint[];
  distribution: RatingDistribution;
}

/** All review-side aggregates for one log set, sharing the same window. */
export function summarizeReviewLogs(
  logs: readonly ReviewLogLike[],
  now: Date = new Date(),
  windowDays: number = DEEP_STATS_WINDOW_DAYS,
): DeepReviewSummary {
  return {
    retention: computeTrueRetention(logs, now, windowDays),
    reviewsByDay: buildReviewsByDay(logs, now, windowDays),
    distribution: computeRatingDistribution(logs, now, windowDays),
  };
}
