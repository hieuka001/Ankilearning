import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BADGES,
  getTodayKey,
  getUnlockedBadges,
} from '../src/lib/gamification';

test('uses local timezone date keys', () => {
  const date = new Date('2026-05-18T18:00:00.000Z');

  assert.equal(getTodayKey('Asia/Bangkok', date), '2026-05-19');
  assert.equal(getTodayKey('UTC', date), '2026-05-18');
});

test('unlocks badges from learning stats', () => {
  const badges = getUnlockedBadges({
    streakDays: 7,
    totalCardsReviewed: 100,
    totalQuizzesCompleted: 10,
    totalStudyTimeMinutes: 0,
  });

  assert.deepEqual(
    badges.map((badge) => badge.id).sort(),
    ['cards_100', 'first_review', 'quiz_master', 'streak_3', 'streak_7'].sort(),
  );
});

test('does not duplicate existing badges', () => {
  const existing = [{
    id: BADGES[0].id,
    title: BADGES[0].title,
    unlockedAt: '2026-01-01T00:00:00.000Z',
  }] as const;

  const badges = getUnlockedBadges({
    streakDays: 0,
    totalCardsReviewed: 1,
    totalQuizzesCompleted: 0,
    totalStudyTimeMinutes: 0,
  }, [...existing]);

  assert.equal(badges.length, 1);
});
