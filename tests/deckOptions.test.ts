import test from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveDeckDailyLimits,
  resolveDeckSchedulerConfig,
} from '../src/lib/deckOptions';
import { DEFAULT_SCHEDULER_CONFIG } from '../src/lib/spacedRepetition';
import type { Deck } from '../src/types';

const deckWith = (options?: Deck['options']): Pick<Deck, 'options'> => ({ options });

test('resolveDeckSchedulerConfig: không có deck thì dùng cấu hình chung đã normalize', () => {
  const resolved = resolveDeckSchedulerConfig({ newCardsPerDay: 15, desiredRetention: 0.85 });
  assert.equal(resolved.newCardsPerDay, 15);
  assert.equal(resolved.desiredRetention, 0.85);
  // Fields the global config never set fall back to the built-in defaults,
  // exactly like normalizeSchedulerConfig behaves today.
  assert.equal(resolved.reviewsPerDay, DEFAULT_SCHEDULER_CONFIG.reviewsPerDay);
  assert.equal(resolved.leechThreshold, DEFAULT_SCHEDULER_CONFIG.leechThreshold);
});

test('resolveDeckSchedulerConfig: deck không có options thì kế thừa toàn bộ cấu hình chung', () => {
  const global = { newCardsPerDay: 12, reviewsPerDay: 90, desiredRetention: 0.88, leechThreshold: 5 };
  assert.deepEqual(resolveDeckSchedulerConfig(global, deckWith(undefined)), resolveDeckSchedulerConfig(global));
  assert.deepEqual(resolveDeckSchedulerConfig(global, null), resolveDeckSchedulerConfig(global));
  assert.deepEqual(resolveDeckSchedulerConfig(global, undefined), resolveDeckSchedulerConfig(global));
});

test('resolveDeckSchedulerConfig: ghi đè từng phần — field có mặt thắng, field vắng kế thừa', () => {
  const global = { newCardsPerDay: 12, reviewsPerDay: 90, desiredRetention: 0.88, leechThreshold: 5 };
  const resolved = resolveDeckSchedulerConfig(global, deckWith({ desiredRetention: 0.95 }));
  assert.equal(resolved.desiredRetention, 0.95);
  assert.equal(resolved.newCardsPerDay, 12);
  assert.equal(resolved.reviewsPerDay, 90);
  assert.equal(resolved.leechThreshold, 5);
});

test('resolveDeckSchedulerConfig: ghi đè cả 4 field cùng lúc', () => {
  const global = { newCardsPerDay: 12, reviewsPerDay: 90, desiredRetention: 0.88, leechThreshold: 5 };
  const resolved = resolveDeckSchedulerConfig(global, deckWith({
    newCardsPerDay: 30,
    reviewsPerDay: 300,
    desiredRetention: 0.92,
    leechThreshold: 3,
  }));
  assert.equal(resolved.newCardsPerDay, 30);
  assert.equal(resolved.reviewsPerDay, 300);
  assert.equal(resolved.desiredRetention, 0.92);
  assert.equal(resolved.leechThreshold, 3);
});

test('resolveDeckSchedulerConfig: giá trị 0 là ghi đè hợp lệ, không bị coi là vắng mặt', () => {
  const global = { newCardsPerDay: 12, reviewsPerDay: 90, leechThreshold: 5 };
  const resolved = resolveDeckSchedulerConfig(global, deckWith({
    newCardsPerDay: 0,
    reviewsPerDay: 0,
    leechThreshold: 0,
  }));
  assert.equal(resolved.newCardsPerDay, 0);
  assert.equal(resolved.reviewsPerDay, 0);
  assert.equal(resolved.leechThreshold, 0);
});

test('resolveDeckSchedulerConfig: field options để undefined tường minh KHÔNG được xoá giá trị chung', () => {
  const global = { newCardsPerDay: 12, reviewsPerDay: 90 };
  const resolved = resolveDeckSchedulerConfig(global, deckWith({
    newCardsPerDay: undefined,
    reviewsPerDay: undefined,
  }));
  assert.equal(resolved.newCardsPerDay, 12);
  assert.equal(resolved.reviewsPerDay, 90);
});

test('resolveDeckSchedulerConfig: kết quả vẫn qua normalize — desiredRetention ngoài khoảng bị clamp', () => {
  const resolved = resolveDeckSchedulerConfig({}, deckWith({ desiredRetention: 0.5 }));
  assert.equal(resolved.desiredRetention, 0.7);
  const resolvedHigh = resolveDeckSchedulerConfig({}, deckWith({ desiredRetention: 0.999 }));
  assert.equal(resolvedHigh.desiredRetention, 0.98);
});

test('resolveDeckSchedulerConfig: không có cả cấu hình chung lẫn options thì ra mặc định', () => {
  assert.deepEqual(resolveDeckSchedulerConfig(undefined, undefined), DEFAULT_SCHEDULER_CONFIG);
  assert.deepEqual(resolveDeckSchedulerConfig(undefined, deckWith(undefined)), DEFAULT_SCHEDULER_CONFIG);
});

test('resolveDeckDailyLimits: kế thừa khi deck không ghi đè, thắng khi có ghi đè (kể cả 0)', () => {
  const global = { newCardsPerDay: 12, reviewsPerDay: 90 };
  assert.deepEqual(resolveDeckDailyLimits(global, deckWith(undefined)), {
    newCardsPerDay: 12,
    reviewsPerDay: 90,
  });
  assert.deepEqual(resolveDeckDailyLimits(global, deckWith({ newCardsPerDay: 7 })), {
    newCardsPerDay: 7,
    reviewsPerDay: 90,
  });
  assert.deepEqual(resolveDeckDailyLimits(global, deckWith({ newCardsPerDay: 0, reviewsPerDay: 0 })), {
    newCardsPerDay: 0,
    reviewsPerDay: 0,
  });
  assert.deepEqual(resolveDeckDailyLimits(undefined, undefined), {
    newCardsPerDay: DEFAULT_SCHEDULER_CONFIG.newCardsPerDay,
    reviewsPerDay: DEFAULT_SCHEDULER_CONFIG.reviewsPerDay,
  });
});
