import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildStudyQueues,
  calculateRetrievability,
  calculateSchedulerReview,
  countIntroducedToday,
  createInitialCardSchedule,
  DEFAULT_SCHEDULER_CONFIG,
  getRatingPreviews,
  intervalForRetention,
  normalizeCardSchedule,
} from '../src/lib/spacedRepetition';

const now = new Date('2026-05-18T08:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (days: number) => new Date(now.getTime() - days * DAY).toISOString();
const CONFIG = DEFAULT_SCHEDULER_CONFIG;

const newCard = (id = 'new-1') => ({
  id,
  ...createInitialCardSchedule(now),
  createdAt: now.toISOString(),
});

const reviewCard = (overrides: Record<string, unknown> = {}) => ({
  id: 'review-1',
  state: 'review' as const,
  stability: 30,
  difficulty: 5,
  scheduledDays: 30,
  interval: 30,
  dueDate: now.toISOString(),
  nextReview: now.toISOString(),
  lastReview: daysAgo(30),
  reps: 8,
  repetitions: 8,
  lapses: 0,
  createdAt: daysAgo(90),
  ...overrides,
});

// (a) Basic behavior matches ts-fsrs / FSRS-6 with default weights.
test('new good card enters the second learning step with FSRS-6 initial stability', () => {
  const result = calculateSchedulerReview(newCard(), 'good', CONFIG, now);

  assert.equal(result.state, 'learning');
  assert.equal(result.stability, 2.3065); // FSRS-6 default w[2]
  assert.equal(result.stepIndex, 1);
  assert.deepEqual(result.scheduledDelay, { amount: 10, unit: 'minute' });
  assert.equal(new Date(result.dueDate).getTime() - now.getTime(), 10 * 60 * 1000);
  assert.equal(result.reviewLog.previousState, 'new');
  assert.equal(result.reviewLog.newState, 'learning');
  assert.equal(result.reviewLog.schedulerVersion, 'fsrs-6');
  assert.equal(result.firstReviewAt, now.toISOString());
  assert.equal(result.updatedCard.firstReviewAt, now.toISOString());
});

test('new easy card graduates to review with FSRS-6 initial stability', () => {
  const result = calculateSchedulerReview(newCard(), 'easy', CONFIG, now);

  assert.equal(result.state, 'review');
  assert.equal(result.stability, 8.2956); // FSRS-6 default w[3]
  // Base interval for S = 8.2956 at retention 0.9 is 8 days; seeded fuzz may
  // shift it slightly, so assert the neighborhood instead of an exact day.
  assert.ok(result.scheduledDays >= 7 && result.scheduledDays <= 10, `scheduledDays=${result.scheduledDays}`);
});

test('review buttons produce ordered FSRS intervals', () => {
  const card = reviewCard();
  const hard = calculateSchedulerReview(card, 'hard', CONFIG, now);
  const good = calculateSchedulerReview(card, 'good', CONFIG, now);
  const easy = calculateSchedulerReview(card, 'easy', CONFIG, now);
  const again = calculateSchedulerReview(card, 'again', CONFIG, now);

  assert.equal(again.state, 'relearning');
  assert.ok(hard.interval > 30);
  assert.ok(good.interval > hard.interval);
  assert.ok(easy.interval > good.interval);

  const previews = getRatingPreviews(card, CONFIG, now);
  assert.deepEqual(previews.map((preview) => preview.rating), ['again', 'hard', 'good', 'easy']);
});

test('interval calculator targets desired retention on the FSRS-6 curve', () => {
  const interval = intervalForRetention(20, 0.9);
  const predicted = calculateRetrievability(20, interval);

  assert.ok(Math.abs(predicted - 0.9) < 0.02);
  // FSRS-6 curve anchor: retrievability at t = S is exactly the 0.9 the
  // factor is calibrated for, and decays below it afterwards.
  assert.ok(Math.abs(calculateRetrievability(30, 30) - 0.9) < 0.001);
  assert.ok(calculateRetrievability(30, 60) < 0.9);
});

// (b) L1 regression: a stored elapsedDays of 0 must never pin R to 1.
test('L1 regression: elapsed days are recomputed from lastReview, never trusted from storage', () => {
  const card = reviewCard({ elapsedDays: 0, lastReview: daysAgo(60) });
  const normalized = normalizeCardSchedule(card, now, CONFIG);

  assert.equal(normalized.elapsedDays, 60);
  assert.ok(normalized.retrievability < 1);
  assert.ok(Math.abs(normalized.retrievability - 0.8459) < 0.001);

  const result = calculateSchedulerReview(card, 'good', CONFIG, now);
  assert.equal(result.reviewLog.elapsedDays, 60);
  assert.equal(result.elapsedDays, 60);
  assert.equal(result.updatedCard.elapsedDays, 0); // freshly reviewed
});

// (c) L2 regression: post-lapse stability collapses instead of scaling with S.
test('L2 regression: forgetting a stability-100 card drops stability below 10 into relearning', () => {
  const card = reviewCard({ stability: 100, scheduledDays: 100, interval: 100, lastReview: daysAgo(100) });
  const result = calculateSchedulerReview(card, 'again', CONFIG, now);

  assert.equal(result.state, 'relearning');
  assert.ok(result.stability < 10, `stability=${result.stability}`);
  assert.equal(result.lapses, 1);
  // Due at the first relearning step (10 minutes), and `interval` means the
  // time until that due — not the post-lapse interval.
  assert.equal(new Date(result.dueDate).getTime() - now.getTime(), 10 * 60 * 1000);
  assert.ok(result.interval < 1);
});

// (d) L3 regression: same-day review must not double the interval.
test('L3 regression: reviewing again the same day barely grows the interval', () => {
  const sameDay = calculateSchedulerReview(reviewCard({ lastReview: now.toISOString() }), 'good', CONFIG, now);
  const onTime = calculateSchedulerReview(reviewCard({ lastReview: daysAgo(30) }), 'good', CONFIG, now);

  assert.ok(onTime.scheduledDays > 70, `onTime=${onTime.scheduledDays}`);
  assert.ok(
    sameDay.scheduledDays < onTime.scheduledDays / 2,
    `sameDay=${sameDay.scheduledDays} onTime=${onTime.scheduledDays}`,
  );
});

// (e) L4 regression: Hard must depend on elapsed time / retrievability.
test('L4 regression: hard rating gives different stability for early vs late review', () => {
  const early = calculateSchedulerReview(reviewCard({ lastReview: daysAgo(5) }), 'hard', CONFIG, now);
  const late = calculateSchedulerReview(reviewCard({ lastReview: daysAgo(60) }), 'hard', CONFIG, now);

  assert.notEqual(early.stability, late.stability);
  assert.ok(early.scheduledDays !== late.scheduledDays);
});

// (f) Queue: real daily limits + bury keeps the earliest-due sibling.
test('queue daily limit subtracts cards already introduced today', () => {
  const cards = Array.from({ length: 25 }, (_, index) => ({
    id: `new-${index}`,
    state: 'new' as const,
    dueDate: now.toISOString(),
    createdAt: now.toISOString(),
  }));

  const withoutInfo = buildStudyQueues(cards, CONFIG, now);
  assert.equal(withoutInfo.new.length, CONFIG.newCardsPerDay);

  const withInfo = buildStudyQueues(cards, CONFIG, now, { introducedToday: 18 });
  assert.equal(withInfo.new.length, CONFIG.newCardsPerDay - 18);

  const exhausted = buildStudyQueues(cards, CONFIG, now, { introducedToday: 25 });
  assert.equal(exhausted.new.length, 0);
});

test('queue buries siblings after sorting, keeping the earliest due card', () => {
  const laterSibling = {
    id: 'sibling-later',
    state: 'review' as const,
    noteId: 'note-1',
    stability: 10,
    scheduledDays: 5,
    interval: 5,
    dueDate: new Date(now.getTime() - 1 * 60 * 60 * 1000).toISOString(),
    lastReview: daysAgo(5),
    createdAt: daysAgo(30),
  };
  const earlierSibling = {
    ...laterSibling,
    id: 'sibling-earlier',
    dueDate: new Date(now.getTime() - 2 * 60 * 60 * 1000).toISOString(),
  };

  // Input order puts the later sibling first on purpose: bury must run on
  // the due-sorted queue, not on raw input order.
  const queues = buildStudyQueues([laterSibling, earlierSibling], CONFIG, now);
  assert.deepEqual(queues.all.map((card) => card.id), ['sibling-earlier']);
});

test('queue priority is learning, relearning, review, then new', () => {
  const cards = [
    { id: 'new', state: 'new' as const, dueDate: now.toISOString(), createdAt: now.toISOString() },
    { id: 'review', state: 'review' as const, dueDate: now.toISOString(), interval: 5, scheduledDays: 5, createdAt: now.toISOString() },
    { id: 'learning', state: 'learning' as const, dueDate: now.toISOString(), createdAt: now.toISOString() },
    { id: 'relearning', state: 'relearning' as const, dueDate: now.toISOString(), createdAt: now.toISOString() },
  ];

  const queues = buildStudyQueues(cards, CONFIG, now);
  assert.deepEqual(queues.all.map((card) => card.id), ['learning', 'relearning', 'review', 'new']);
});

test('countIntroducedToday prefers firstReviewAt and falls back to lastReview', () => {
  const cards = [
    { id: 'a', firstReviewAt: now.toISOString(), reps: 1 },
    { id: 'b', firstReviewAt: now.toISOString(), reps: 3 },
    { id: 'c', firstReviewAt: daysAgo(1), reps: 5 },
    { id: 'd', lastReview: now.toISOString(), reps: 2 }, // fallback approximation
    { id: 'e', lastReview: daysAgo(2), reps: 9 },
    { id: 'f', state: 'new' as const, reps: 0 },
  ];

  assert.equal(countIntroducedToday(cards, now), 3);
});

// (g) Leech handling.
test('leech: reaching the lapse threshold flags and suspends the card', () => {
  const config = { ...CONFIG, leechThreshold: 3 };
  const result = calculateSchedulerReview(reviewCard({ lapses: 2 }), 'again', config, now);

  assert.equal(result.lapses, 3);
  assert.equal(result.leech, true);
  assert.equal(result.updatedCard.suspended, true);
});

test('leech: below the threshold the card stays active and unflagged', () => {
  const config = { ...CONFIG, leechThreshold: 3 };
  const result = calculateSchedulerReview(reviewCard({ lapses: 0 }), 'again', config, now);

  assert.equal(result.lapses, 1);
  assert.equal(result.leech, false);
  assert.equal(result.updatedCard.suspended, false);
});

test('firstReviewAt is stamped once and preserved on later reviews', () => {
  const first = calculateSchedulerReview(newCard(), 'good', CONFIG, now);
  assert.equal(first.updatedCard.firstReviewAt, now.toISOString());

  const later = new Date(now.getTime() + 10 * 60 * 1000);
  const second = calculateSchedulerReview(first.updatedCard, 'good', CONFIG, later);
  assert.equal(second.updatedCard.firstReviewAt, now.toISOString());
});
