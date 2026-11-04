import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildShellReminderItems,
  buildShellRemindersUrl,
  encodeShellRemindersPayload,
  type ShellReminderCardLike,
} from '../src/lib/shellReminders';

// Fixed "now": 2026-11-04 10:00 local time. Due dates are built as local
// dates and serialized to ISO instants, mirroring how Firestore stores
// them, so the expectations hold in any test-runner timezone.
const NOW = new Date(2026, 10, 4, 10, 0, 0);

function dueOn(dayOffset: number, hour = 8): ShellReminderCardLike {
  const day = new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate() + dayOffset, hour, 0, 0);
  return { dueDate: day.toISOString() };
}

const CONFIG = { time: '21:00' };

test('buildShellReminderItems: thẻ quá hạn dồn vào hôm nay, nhắc lúc cấu hình', () => {
  const items = buildShellReminderItems([dueOn(-3), dueOn(0), dueOn(0)], CONFIG, NOW);
  assert.equal(items.length, 1);
  assert.equal(items[0].at, '2026-11-04T21:00:00');
  assert.equal(items[0].title, 'AnkiLearning');
  assert.equal(items[0].body, 'Hôm nay có 3 thẻ đến hạn ôn tập');
});

test('buildShellReminderItems: hôm nay đã qua giờ nhắc thì bỏ qua, ngày mai vẫn có', () => {
  const lateNow = new Date(2026, 10, 4, 22, 30, 0);
  const items = buildShellReminderItems([dueOn(0), dueOn(1)], CONFIG, lateNow);
  assert.equal(items.length, 1);
  assert.equal(items[0].at, '2026-11-05T21:00:00');
  assert.equal(items[0].body, 'Ngày mai có 1 thẻ đến hạn ôn tập');
});

test('buildShellReminderItems: ngày xa dùng mẫu "vào ngày DD/MM"', () => {
  const items = buildShellReminderItems([dueOn(3)], CONFIG, NOW);
  assert.equal(items.length, 1);
  assert.equal(items[0].at, '2026-11-07T21:00:00');
  assert.equal(items[0].body, 'Có 1 thẻ đến hạn vào ngày 07/11');
});

test('buildShellReminderItems: ngoài cửa sổ 14 ngày thì không nhắc', () => {
  assert.deepEqual(buildShellReminderItems([dueOn(14), dueOn(30)], CONFIG, NOW), []);
  // Day +13 is the last day inside the window.
  assert.equal(buildShellReminderItems([dueOn(13)], CONFIG, NOW).length, 1);
});

test('buildShellReminderItems: bỏ thẻ suspended và thẻ chưa có lịch', () => {
  const suspended: ShellReminderCardLike = { ...dueOn(0), suspended: true };
  const unscheduled: ShellReminderCardLike = {};
  const items = buildShellReminderItems([suspended, unscheduled, dueOn(0)], CONFIG, NOW);
  assert.equal(items.length, 1);
  assert.equal(items[0].body, 'Hôm nay có 1 thẻ đến hạn ôn tập');
});

test('buildShellReminderItems: dùng nextReview khi không có dueDate', () => {
  const day = new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate() + 2, 9, 0, 0);
  const items = buildShellReminderItems([{ nextReview: day.toISOString() }], CONFIG, NOW);
  assert.equal(items.length, 1);
  assert.equal(items[0].at, '2026-11-06T21:00:00');
});

test('buildShellReminderItems: giờ nhắc tuỳ chỉnh và giờ sai định dạng', () => {
  // 07:30 has already passed at 10:00 → today's reminder is skipped.
  const custom = buildShellReminderItems([dueOn(0)], { time: '07:30' }, NOW);
  assert.equal(custom.length, 0);
  const fallback = buildShellReminderItems([dueOn(1)], { time: 'không-phải-giờ' }, NOW);
  assert.equal(fallback[0].at, '2026-11-05T21:00:00');
});

test('encodeShellRemindersPayload: base64url an toàn UTF-8, giải mã tròn trịa', () => {
  const payload = { v: 1, items: buildShellReminderItems([dueOn(0)], CONFIG, NOW) };
  const encoded = encodeShellRemindersPayload(payload);
  assert.ok(!/[+/=]/.test(encoded), 'payload không chứa ký tự base64 thường');
  const decoded = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  assert.deepEqual(decoded, payload);
  assert.equal(decoded.items[0].body, 'Hôm nay có 1 thẻ đến hạn ôn tập');
});

test('buildShellRemindersUrl: đúng hợp đồng scheme ankilearning://reminders#d=', () => {
  const url = buildShellRemindersUrl(buildShellReminderItems([dueOn(1)], CONFIG, NOW));
  assert.ok(url.startsWith('ankilearning://reminders#d='));
  const decoded = JSON.parse(Buffer.from(url.split('#d=')[1], 'base64url').toString('utf8'));
  assert.equal(decoded.v, 1);
  assert.equal(decoded.items.length, 1);
});
