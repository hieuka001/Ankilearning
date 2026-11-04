import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildDeckTree,
  aggregateDeckStats,
  type DeckStudyStats,
} from '../src/lib/deckAnalytics';

const deck = (id: string, name: string) => ({ id, name });

test('buildDeckTree: không có phân cấp thì rừng phẳng, giữ thứ tự đầu vào', () => {
  const roots = buildDeckTree([deck('b', 'Biology'), deck('a', 'Algebra')]);
  assert.equal(roots.length, 2);
  assert.equal(roots[0].deck?.id, 'b');
  assert.equal(roots[1].deck?.id, 'a');
  assert.deepEqual(roots[0].children, []);
  assert.deepEqual(roots[0].descendantIds, ['b']);
});

test('buildDeckTree: gom nhánh Chinese::Từ vựng::HSK1, deck cha có thật', () => {
  const roots = buildDeckTree([
    deck('cn', 'Chinese'),
    deck('vocab', 'Chinese::Từ vựng'),
    deck('hsk1', 'Chinese::Từ vựng::HSK1'),
    deck('hsk2', 'Chinese::Từ vựng::HSK2'),
    deck('en', 'English'),
  ]);
  assert.equal(roots.length, 2);
  const chinese = roots[0];
  assert.equal(chinese.name, 'Chinese');
  assert.equal(chinese.deck?.id, 'cn');
  assert.deepEqual(chinese.descendantIds, ['cn', 'vocab', 'hsk1', 'hsk2']);
  assert.equal(chinese.children.length, 1);
  const vocab = chinese.children[0];
  assert.equal(vocab.segment, 'Từ vựng');
  assert.deepEqual(vocab.children.map((child) => child.segment), ['HSK1', 'HSK2']);
  assert.equal(roots[1].deck?.id, 'en');
});

test('buildDeckTree: cha ảo khi không có deck mang đúng tên cha', () => {
  const roots = buildDeckTree([
    deck('b', 'A::B'),
    deck('c', 'A::C'),
  ]);
  assert.equal(roots.length, 1);
  assert.equal(roots[0].name, 'A');
  assert.equal(roots[0].deck, null);
  assert.deepEqual(roots[0].descendantIds, ['b', 'c']);
  assert.deepEqual(roots[0].children.map((child) => child.segment), ['B', 'C']);
});

test('buildDeckTree: con sắp theo tên, cấp cha giữ thứ tự xuất hiện đầu tiên', () => {
  const roots = buildDeckTree([
    deck('z', 'Zulu'),
    deck('b2', 'P::Beta'),
    deck('b1', 'P::Alpha'),
  ]);
  assert.deepEqual(roots.map((root) => root.name), ['Zulu', 'P']);
  assert.deepEqual(roots[1].children.map((child) => child.segment), ['Alpha', 'Beta']);
});

test('aggregateDeckStats: cộng dồn cả nhánh, lastStudied lấy mới nhất', () => {
  const stats: Record<string, DeckStudyStats> = {
    a: { learned: 10, mastered: 4, due: 3, lastStudied: '2026-11-01T08:00:00.000Z' },
    b: { learned: 5, mastered: 2, due: 7, lastStudied: '2026-11-03T08:00:00.000Z' },
    c: { learned: 1, mastered: 0, due: 0 },
  };
  const total = aggregateDeckStats(stats, ['a', 'b', 'c', 'missing']);
  assert.equal(total.learned, 16);
  assert.equal(total.mastered, 6);
  assert.equal(total.due, 10);
  assert.equal(total.lastStudied, '2026-11-03T08:00:00.000Z');
  assert.deepEqual(aggregateDeckStats(stats, []), { learned: 0, mastered: 0, due: 0 });
});
