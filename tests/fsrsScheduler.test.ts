import test from 'node:test';
import assert from 'node:assert/strict';
import {
  calculateRetrievability,
  buildStudyQueues,
  calculateSchedulerReview,
  createInitialCardSchedule,
  DEFAULT_SCHEDULER_CONFIG,
  intervalForRetention,
} from '../src/lib/spacedRepetition';

const now = new Date('2026-05-18T08:00:00.000Z');

test('new good card graduates with FSRS initial stability', () => {
  const card = {
    id: 'card-1',
    ...createInitialCardSchedule(now),
    createdAt: now.toISOString(),
  };

  const result = calculateSchedulerReview(card, 'good', DEFAULT_SCHEDULER_CONFIG, now);

  assert.equal(result.state, 'review');
  assert.equal(result.stability, DEFAULT_SCHEDULER_CONFIG.initialStability.good);
  assert.equal(result.interval, 3);
  assert.equal(result.reviewLog.previousState, 'new');
  assert.equal(result.reviewLog.newState, 'review');
});

test('review buttons produce ordered FSRS intervals', () => {
  const card = {
    id: 'card-2',
    state: 'review' as const,
    stability: 30,
    difficulty: 5,
    scheduledDays: 30,
    interval: 30,
    dueDate: now.toISOString(),
    nextReview: now.toISOString(),
    lastReview: new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString(),
    reps: 8,
    repetitions: 8,
    lapses: 0,
    createdAt: new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000).toISOString(),
  };

  const hard = calculateSchedulerReview(card, 'hard', DEFAULT_SCHEDULER_CONFIG, now);
  const good = calculateSchedulerReview(card, 'good', DEFAULT_SCHEDULER_CONFIG, now);
  const easy = calculateSchedulerReview(card, 'easy', DEFAULT_SCHEDULER_CONFIG, now);
  const again = calculateSchedulerReview(card, 'again', DEFAULT_SCHEDULER_CONFIG, now);

  assert.equal(again.state, 'relearning');
  assert.ok(hard.interval > 30);
  assert.ok(good.interval > hard.interval);
  assert.ok(easy.interval > good.interval);
});

test('interval calculator targets desired retention', () => {
  const interval = intervalForRetention(20, 0.9);
  const predicted = calculateRetrievability(20, interval);

  assert.ok(Math.abs(predicted - 0.9) < 0.02);
});

test('queue priority is learning, relearning, review, then new', () => {
  const cards = [
    { id: 'new', state: 'new' as const, dueDate: now.toISOString(), createdAt: now.toISOString() },
    { id: 'review', state: 'review' as const, dueDate: now.toISOString(), interval: 5, scheduledDays: 5, createdAt: now.toISOString() },
    { id: 'learning', state: 'learning' as const, dueDate: now.toISOString(), createdAt: now.toISOString() },
    { id: 'relearning', state: 'relearning' as const, dueDate: now.toISOString(), createdAt: now.toISOString() },
  ];

  const queues = buildStudyQueues(cards, DEFAULT_SCHEDULER_CONFIG, now);

  assert.deepEqual(queues.all.map((card) => card.id), ['learning', 'relearning', 'review', 'new']);
});
