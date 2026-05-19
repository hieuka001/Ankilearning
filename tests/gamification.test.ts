import test from 'node:test';
import assert from 'node:assert/strict';
import {
  calculateUserLevel,
  createDefaultDailyMissions,
  getTodayKey,
  updateMissionProgress,
  allDailyMissionsCompleted,
  allDailyMissionsClaimed,
  claimDailyMissionReward,
} from '../src/lib/gamification';

test('calculates fixed 10-level progression', () => {
  assert.equal(calculateUserLevel(0).level, 1);
  assert.equal(calculateUserLevel(199).level, 1);
  assert.equal(calculateUserLevel(200).level, 2);
  assert.equal(calculateUserLevel(1000).level, 3);
  assert.equal(calculateUserLevel(70000).level, 10);
  assert.equal(calculateUserLevel(90000).progressPercent, 100);
});

test('creates the three required daily missions', () => {
  const missions = createDefaultDailyMissions('2026-05-19');

  assert.equal(missions.length, 3);
  assert.deepEqual(missions.map((mission) => mission.type), [
    'study_cards',
    'complete_quiz',
    'online_time',
  ]);
  assert.equal(missions.reduce((sum, mission) => sum + mission.rewardExp, 0), 300);
});

test('completes mission progress without auto-claiming EXP', () => {
  const missions = createDefaultDailyMissions('2026-05-19');
  const partial = updateMissionProgress(missions, 'study_cards', 19);
  const completed = updateMissionProgress(partial.missions, 'study_cards', 1);
  const repeated = updateMissionProgress(completed.missions, 'study_cards', 5);

  assert.equal(partial.rewardExp, 0);
  assert.equal(completed.rewardExp, 0);
  assert.equal(repeated.rewardExp, 0);
  assert.equal(completed.missions[0].completed, true);
  assert.equal(completed.missions[0].claimed, false);
});

test('claims mission EXP once after completion', () => {
  const missions = updateMissionProgress(
    createDefaultDailyMissions('2026-05-19'),
    'study_cards',
    20
  ).missions;
  const claimed = claimDailyMissionReward(missions, missions[0].id);
  const repeated = claimDailyMissionReward(claimed.missions, missions[0].id);

  assert.equal(claimed.rewardExp, 100);
  assert.equal(claimed.missions[0].claimed, true);
  assert.equal(repeated.rewardExp, 0);
});

test('detects all missions completed', () => {
  let missions = createDefaultDailyMissions('2026-05-19');
  missions = updateMissionProgress(missions, 'study_cards', 20).missions;
  missions = updateMissionProgress(missions, 'complete_quiz', 1).missions;
  missions = updateMissionProgress(missions, 'online_time', 300).missions;

  assert.equal(allDailyMissionsCompleted(missions), true);
  assert.equal(allDailyMissionsClaimed(missions), false);
});

test('uses local timezone date keys', () => {
  const date = new Date('2026-05-18T18:00:00.000Z');

  assert.equal(getTodayKey('Asia/Bangkok', date), '2026-05-19');
  assert.equal(getTodayKey('UTC', date), '2026-05-18');
});
