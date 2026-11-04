import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildReviewsByDay,
  classifyCardMaturity,
  collectReviewLogs,
  computeCardMaturity,
  computeRatingDistribution,
  computeTrueRetention,
  summarizeReviewLogs,
  type ReviewLogLike,
} from '../src/lib/deepStats';

// Fixed "now": 2026-11-04 12:00 local time. The 30-day window therefore
// starts at local midnight of 2026-10-06.
const NOW = new Date(2026, 10, 4, 12, 0, 0);

const log = (
  rating: ReviewLogLike['rating'],
  reviewTime: string,
  previousState?: string,
): ReviewLogLike => ({ rating, reviewTime, previousState });

test('classifyCardMaturity: tạm dừng thắng mọi trạng thái khác', () => {
  assert.equal(classifyCardMaturity({ suspended: true, state: 'review', stability: 90 }), 'suspended');
  assert.equal(classifyCardMaturity({ suspended: true, state: 'new' }), 'suspended');
});

test('classifyCardMaturity: learning và relearning đều là Đang học', () => {
  assert.equal(classifyCardMaturity({ state: 'learning' }), 'learning');
  assert.equal(classifyCardMaturity({ state: 'relearning', stability: 40 }), 'learning');
});

test('classifyCardMaturity: review phân Non/Chín theo ngưỡng stability 21 ngày', () => {
  assert.equal(classifyCardMaturity({ state: 'review', stability: 20.9 }), 'young');
  assert.equal(classifyCardMaturity({ state: 'review', stability: 21 }), 'mature');
  assert.equal(classifyCardMaturity({ state: 'review', stability: 120 }), 'mature');
  // Thẻ review thiếu stability coi như 0 -> Non, không suy diễn.
  assert.equal(classifyCardMaturity({ state: 'review' }), 'young');
});

test('classifyCardMaturity: thẻ mới và thẻ legacy không có state', () => {
  assert.equal(classifyCardMaturity({ state: 'new' }), 'new');
  assert.equal(classifyCardMaturity({}), 'new');
  assert.equal(classifyCardMaturity({ reps: 0, repetitions: 0 }), 'new');
  // Legacy: đã ôn ít nhất 1 lần -> xử lý như thẻ review theo stability.
  assert.equal(classifyCardMaturity({ reps: 3, stability: 30 }), 'mature');
  assert.equal(classifyCardMaturity({ repetitions: 1, stability: 2 }), 'young');
});

test('computeCardMaturity: đếm đúng từng nhóm và tổng', () => {
  const counts = computeCardMaturity([
    { state: 'new' },
    { state: 'new' },
    { state: 'learning' },
    { state: 'relearning' },
    { state: 'review', stability: 5 },
    { state: 'review', stability: 21 },
    { state: 'review', stability: 60 },
    { state: 'review', stability: 60, suspended: true },
  ]);
  assert.deepEqual(counts, { new: 2, learning: 2, young: 1, mature: 2, suspended: 1, total: 8 });
  assert.deepEqual(computeCardMaturity([]), { new: 0, learning: 0, young: 0, mature: 0, suspended: 0, total: 0 });
});

test('collectReviewLogs: gộp reviewHistory nhiều nguồn, loại bản ghi hỏng', () => {
  const logs = collectReviewLogs([
    {
      reviewHistory: [
        log('good', '2026-11-01T08:00:00.000Z', 'review'),
        { rating: 'superb', reviewTime: '2026-11-01T08:00:00.000Z' },
        { rating: 'good', reviewTime: 'không-phải-ngày' },
        { rating: 'good' },
        'chuỗi lạ',
        null,
      ],
    },
    { reviewHistory: [log('again', '2026-11-02T08:00:00.000Z', 'learning')] },
    {},
    null,
    undefined,
    { reviewHistory: 'không phải mảng' },
  ]);
  assert.equal(logs.length, 2);
  assert.equal(logs[0].rating, 'good');
  assert.equal(logs[0].previousState, 'review');
  assert.equal(logs[1].rating, 'again');
});

test('computeTrueRetention: chỉ tính lượt ôn trên thẻ đã ở trạng thái review, Again là mất nhớ', () => {
  const logs = [
    log('good', '2026-11-03T09:00:00', 'review'),
    log('hard', '2026-11-02T09:00:00', 'review'),
    log('easy', '2026-11-01T09:00:00', 'review'),
    log('again', '2026-11-03T10:00:00', 'review'),
    // Không phải ôn trên thẻ review -> loại khỏi cả tử và mẫu.
    log('again', '2026-11-03T11:00:00', 'learning'),
    log('good', '2026-11-03T12:00:00', 'relearning'),
    log('good', '2026-11-03T13:00:00', 'new'),
    log('good', '2026-11-03T14:00:00', undefined),
  ];
  const result = computeTrueRetention(logs, NOW);
  assert.equal(result.totalReviewStateReviews, 4);
  assert.equal(result.retained, 3);
  assert.equal(result.rate, 0.75);
  assert.equal(result.windowDays, 30);
});

test('computeTrueRetention: biên cửa sổ 30 ngày — ngày đầu cửa sổ tính, trước đó loại', () => {
  const logs = [
    log('good', '2026-10-06T00:00:00', 'review'), // đúng ngày mở cửa sổ
    log('again', '2026-10-05T23:59:59', 'review'), // ngay trước cửa sổ
    log('good', '2026-09-01T09:00:00', 'review'),
  ];
  const result = computeTrueRetention(logs, NOW);
  assert.equal(result.totalReviewStateReviews, 1);
  assert.equal(result.retained, 1);
  assert.equal(result.rate, 1);
});

test('computeTrueRetention: không có lượt ôn trên thẻ review -> rate null (chưa đủ dữ liệu)', () => {
  const result = computeTrueRetention([log('good', '2026-11-03T09:00:00', 'learning')], NOW);
  assert.equal(result.totalReviewStateReviews, 0);
  assert.equal(result.retained, 0);
  assert.equal(result.rate, null);
  assert.equal(computeTrueRetention([], NOW).rate, null);
});

test('buildReviewsByDay: đủ 30 điểm ngày, đếm đúng ngày, ngày trống = 0', () => {
  const logs = [
    log('good', '2026-11-04T08:00:00'),
    log('again', '2026-11-04T09:30:00'),
    log('easy', '2026-11-03T09:00:00'),
    log('good', '2026-10-06T00:30:00'), // ngày đầu cửa sổ
    log('good', '2026-10-05T23:00:00'), // ngoài cửa sổ 30 ngày
    log('good', '2026-08-01T09:00:00'),
  ];
  const points = buildReviewsByDay(logs, NOW);
  assert.equal(points.length, 30);
  assert.equal(points[0].date, '2026-10-06');
  assert.equal(points[0].count, 1);
  assert.equal(points[29].date, '2026-11-04');
  assert.equal(points[29].label, '04/11');
  assert.equal(points[29].count, 2);
  assert.equal(points[28].count, 1); // 2026-11-03
  assert.equal(points.reduce((sum, point) => sum + point.count, 0), 4);
});

test('computeRatingDistribution: đếm 4 nút trong cửa sổ, bỏ ngoài cửa sổ', () => {
  const logs = [
    log('again', '2026-11-04T08:00:00'),
    log('again', '2026-11-01T08:00:00'),
    log('hard', '2026-11-02T08:00:00'),
    log('good', '2026-11-02T09:00:00'),
    log('good', '2026-10-06T00:00:00'),
    log('easy', '2026-11-03T08:00:00'),
    log('easy', '2026-10-05T08:00:00'), // ngoài cửa sổ
  ];
  const distribution = computeRatingDistribution(logs, NOW);
  assert.deepEqual(distribution, { again: 2, hard: 1, good: 2, easy: 1, total: 6, windowDays: 30 });
  assert.deepEqual(computeRatingDistribution([], NOW), { again: 0, hard: 0, good: 0, easy: 0, total: 0, windowDays: 30 });
});

test('summarizeReviewLogs: gộp ba thống kê cùng một cửa sổ', () => {
  const logs = [
    log('good', '2026-11-04T08:00:00', 'review'),
    log('again', '2026-11-04T09:00:00', 'review'),
    log('good', '2026-11-02T08:00:00', 'learning'),
  ];
  const summary = summarizeReviewLogs(logs, NOW);
  assert.equal(summary.retention.totalReviewStateReviews, 2);
  assert.equal(summary.retention.rate, 0.5);
  assert.equal(summary.distribution.total, 3);
  assert.equal(summary.reviewsByDay.length, 30);
  assert.equal(summary.reviewsByDay[29].count, 2);
  assert.equal(summary.reviewsByDay[27].count, 1);
});
