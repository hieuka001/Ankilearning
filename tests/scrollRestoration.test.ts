import test from 'node:test';
import assert from 'node:assert/strict';
import {
  decideScrollAction,
  loadScrollPositions,
  persistScrollPositions,
  rememberScrollPosition,
  routeScrollKey,
  MAX_SAVED_SCROLL_POSITIONS,
  type ScrollPositionStorage,
} from '../src/lib/scrollRestoration';

// The decisions pinned here are the user-visible contract of the fix:
// switching to another section must land at the top, browser Back must
// restore where the page was left, and query-string variants of /study
// (group study via ?decks=) count as different screens.

const savedOf = (entries: [string, number][]): Map<string, number> =>
  new Map(entries);

test('routeScrollKey: pathname + search tạo khóa, đổi search là khóa khác', () => {
  assert.equal(routeScrollKey('/decks', ''), '/decks');
  assert.equal(routeScrollKey('/study/a', '?decks=a,b'), '/study/a?decks=a,b');
  assert.notEqual(
    routeScrollKey('/study/a', ''),
    routeScrollKey('/study/a', '?decks=a,b'),
  );
});

test('decideScrollAction: PUSH sang route mới → reset về đầu', () => {
  const action = decideScrollAction({
    navigationType: 'PUSH',
    previousKey: '/decks',
    nextKey: '/settings',
    saved: savedOf([['/settings', 500]]),
  });
  assert.deepEqual(action, { type: 'reset' });
});

test('decideScrollAction: REPLACE sang route mới → reset kể cả khi có vị trí đã lưu', () => {
  const action = decideScrollAction({
    navigationType: 'REPLACE',
    previousKey: '/decks',
    nextKey: '/settings',
    saved: savedOf([['/settings', 500]]),
  });
  assert.deepEqual(action, { type: 'reset' });
});

test('decideScrollAction: cùng pathname nhưng search khác (học nhóm) → route mới, reset', () => {
  const action = decideScrollAction({
    navigationType: 'PUSH',
    previousKey: '/study/a',
    nextKey: '/study/a?decks=a,b',
    saved: savedOf([]),
  });
  assert.deepEqual(action, { type: 'reset' });
});

test('decideScrollAction: POP có vị trí đã lưu → khôi phục đúng offset', () => {
  const action = decideScrollAction({
    navigationType: 'POP',
    previousKey: '/settings',
    nextKey: '/decks',
    saved: savedOf([['/decks', 640]]),
  });
  assert.deepEqual(action, { type: 'restore', top: 640 });
});

test('decideScrollAction: POP không có vị trí đã lưu → reset', () => {
  const action = decideScrollAction({
    navigationType: 'POP',
    previousKey: '/settings',
    nextKey: '/decks',
    saved: savedOf([]),
  });
  assert.deepEqual(action, { type: 'reset' });
});

test('decideScrollAction: POP có vị trí đã lưu bằng 0 → reset (không khác gì ở đầu trang)', () => {
  const action = decideScrollAction({
    navigationType: 'POP',
    previousKey: '/settings',
    nextKey: '/decks',
    saved: savedOf([['/decks', 0]]),
  });
  assert.deepEqual(action, { type: 'reset' });
});

test('decideScrollAction: cùng key (hash đổi hoặc bấm lại tab) → none, không đụng vị trí cuộn', () => {
  for (const navigationType of ['PUSH', 'POP', 'REPLACE'] as const) {
    const action = decideScrollAction({
      navigationType,
      previousKey: '/decks',
      nextKey: '/decks',
      saved: savedOf([['/decks', 300]]),
    });
    assert.deepEqual(action, { type: 'none' });
  }
});

test('decideScrollAction: lần mount đầu (chưa có key trước): POP + có lưu → khôi phục, PUSH → reset', () => {
  assert.deepEqual(
    decideScrollAction({
      navigationType: 'POP',
      previousKey: null,
      nextKey: '/',
      saved: savedOf([['/', 220]]),
    }),
    { type: 'restore', top: 220 },
  );
  assert.deepEqual(
    decideScrollAction({
      navigationType: 'PUSH',
      previousKey: null,
      nextKey: '/',
      saved: savedOf([['/', 220]]),
    }),
    { type: 'reset' },
  );
});

test('rememberScrollPosition: làm tròn xuống, chặn số âm, bỏ qua NaN/Infinity', () => {
  const store = new Map<string, number>();
  rememberScrollPosition(store, '/a', 123.9);
  assert.equal(store.get('/a'), 123);
  rememberScrollPosition(store, '/b', -50);
  assert.equal(store.get('/b'), 0);
  rememberScrollPosition(store, '/c', Number.NaN);
  rememberScrollPosition(store, '/d', Number.POSITIVE_INFINITY);
  assert.equal(store.has('/c'), false);
  assert.equal(store.has('/d'), false);
});

test('rememberScrollPosition: vượt giới hạn thì loại route cũ nhất, ghi lại làm mới độ mới', () => {
  const store = new Map<string, number>();
  for (let i = 0; i < MAX_SAVED_SCROLL_POSITIONS; i += 1) {
    rememberScrollPosition(store, `/r${i}`, i + 1);
  }
  assert.equal(store.size, MAX_SAVED_SCROLL_POSITIONS);
  // Refresh the oldest entry — it must survive the next eviction round.
  rememberScrollPosition(store, '/r0', 999);
  rememberScrollPosition(store, '/new', 1);
  assert.equal(store.size, MAX_SAVED_SCROLL_POSITIONS);
  assert.equal(store.get('/r0'), 999);
  assert.equal(store.has('/r1'), false);
  assert.equal(store.get('/new'), 1);
});

const fakeStorage = (initial: Record<string, string> = {}) => {
  const data = new Map(Object.entries(initial));
  const storage: ScrollPositionStorage = {
    getItem: (k) => (data.has(k) ? (data.get(k) as string) : null),
    setItem: (k, v) => {
      data.set(k, v);
    },
  };
  return { storage, data };
};

test('persist + load: vòng tròn giữ nguyên vị trí đã lưu', () => {
  const { storage } = fakeStorage();
  const store = savedOf([
    ['/decks', 480],
    ['/study/a?decks=a,b', 96],
  ]);
  persistScrollPositions(storage, store);
  const loaded = loadScrollPositions(storage);
  assert.deepEqual([...loaded.entries()], [...store.entries()]);
});

test('loadScrollPositions: storage null hoặc payload hỏng → map rỗng, không ném lỗi', () => {
  assert.equal(loadScrollPositions(null).size, 0);
  const { storage } = fakeStorage({
    'ankilearning:scroll-positions': '{không phải json',
  });
  assert.equal(loadScrollPositions(storage).size, 0);
});

test('loadScrollPositions: chỉ giữ entry hợp lệ (số hữu hạn ≥ 0), làm tròn xuống', () => {
  const { storage } = fakeStorage({
    'ankilearning:scroll-positions': JSON.stringify({
      '/ok': 250.7,
      '/âm': -10,
      '/chữ': 'cao',
      '/null': null,
    }),
  });
  const loaded = loadScrollPositions(storage);
  assert.deepEqual([...loaded.entries()], [['/ok', 250]]);
});

test('persistScrollPositions: storage null hoặc setItem ném lỗi → im lặng bỏ qua', () => {
  const store = savedOf([['/decks', 10]]);
  assert.doesNotThrow(() => persistScrollPositions(null, store));
  const throwing: ScrollPositionStorage = {
    getItem: () => null,
    setItem: () => {
      throw new Error('QuotaExceeded');
    },
  };
  assert.doesNotThrow(() => persistScrollPositions(throwing, store));
});
