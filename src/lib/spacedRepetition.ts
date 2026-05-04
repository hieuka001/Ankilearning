/**
 * SuperMemo-2 (SM-2) algorithm implementation
 * @param quality 0-5 (0: total blackout, 5: perfect response)
 * @param repetitions number of times this card has been successfully recalled
 * @param easeFactor ease factor (default 2.5)
 * @param interval interval in days
 */
export function calculateNextReview(
  quality: number,
  repetitions: number,
  easeFactor: number,
  interval: number
) {
  let nextRepetitions: number;
  let nextEaseFactor: number;
  let nextInterval: number;

  if (quality >= 3) {
    // Correct response
    if (repetitions === 0) {
      nextInterval = 1;
    } else if (repetitions === 1) {
      nextInterval = 6;
    } else {
      nextInterval = Math.round(interval * easeFactor);
    }
    nextRepetitions = repetitions + 1;
    nextEaseFactor = easeFactor + (0.1 - (5 - quality) * (0.08 + (5 - quality) * 0.02));
  } else {
    // Incorrect response
    nextRepetitions = 0;
    nextInterval = 1;
    nextEaseFactor = easeFactor;
  }

  if (nextEaseFactor < 1.3) {
    nextEaseFactor = 1.3;
  }

  const nextReviewDate = new Date();
  nextReviewDate.setDate(nextReviewDate.getDate() + nextInterval);

  return {
    repetitions: nextRepetitions,
    easeFactor: nextEaseFactor,
    interval: nextInterval,
    nextReview: nextReviewDate.toISOString(),
  };
}
