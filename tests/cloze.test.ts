import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseClozeText,
  clozeToPlainText,
  renderClozeFront,
  renderClozeBack,
  validateClozeText,
  getNextClozeIndex,
  wrapSelectionAsCloze,
} from '../src/review/cloze';

test('parseClozeText: đếm đủ chỉ số phân biệt, sắp xếp tăng dần', () => {
  const parsed = parseClozeText('Thủ đô {{c2::Hà Nội}} ở miền {{c1::Bắc}}, {{c2::Hà Nội}} là thành phố lớn.');
  assert.equal(parsed.valid, true);
  assert.deepEqual(parsed.indexes, [1, 2]);
  assert.equal(parsed.deletions.length, 3, 'chỉ số trùng vẫn là hai đoạn riêng');
  assert.equal(parsed.deletions[0].index, 2);
  assert.equal(parsed.deletions[0].answer, 'Hà Nội');
});

test('parseClozeText: tách gợi ý sau "::" thứ hai', () => {
  const parsed = parseClozeText('Thuốc {{c1::ACE inhibitor::nhóm thuốc huyết áp}} trị tăng huyết áp.');
  assert.equal(parsed.deletions.length, 1);
  assert.equal(parsed.deletions[0].answer, 'ACE inhibitor');
  assert.equal(parsed.deletions[0].hint, 'nhóm thuốc huyết áp');
});

test('parseClozeText: văn bản không cloze / rỗng thì valid = false', () => {
  assert.equal(parseClozeText('Văn bản thường.').valid, false);
  assert.deepEqual(parseClozeText('').indexes, []);
  assert.deepEqual(parseClozeText('').deletions, []);
});

test('clozeToPlainText: bỏ cú pháp {{}}, giữ đáp án dạng văn bản thường', () => {
  assert.equal(
    clozeToPlainText('Thủ đô của Việt Nam là {{c1::Hà Nội}}. Dân số {{c2::khoảng 8 triệu::gợi ý số liệu}}.'),
    'Thủ đô của Việt Nam là Hà Nội. Dân số khoảng 8 triệu.',
  );
  assert.equal(clozeToPlainText('Không có cloze.'), 'Không có cloze.');
});

test('renderClozeFront: che đúng chỉ số đang học, chỉ số khác hiện đáp án', () => {
  const text = '{{c1::Hà Nội}} là thủ đô của {{c2::Việt Nam}}.';
  const front1 = renderClozeFront(text, 1);
  assert.match(front1, /\[\.\.\.\]/, 'chỉ số đang học phải bị che thành [...]');
  assert.ok(front1.includes('Việt Nam'), 'chỉ số khác phải hiện nguyên đáp án');
  assert.ok(!front1.includes('Hà Nội'), 'đáp án đang học không được lộ ở mặt trước');

  const front2 = renderClozeFront(text, 2);
  assert.ok(front2.includes('Hà Nội'));
  assert.match(front2, /\[\.\.\.\]/);
});

test('renderClozeFront: có gợi ý thì hiện [gợi ý] thay cho [...]', () => {
  const front = renderClozeFront('Thuốc {{c1::ACE::nhóm huyết áp}} đầu tay.', 1);
  assert.ok(front.includes('[nhóm huyết áp]'));
  assert.ok(!front.includes('ACE'));
});

test('renderClozeBack: đáp án của chỉ số đang học nằm trong <mark>', () => {
  const back = renderClozeBack('{{c1::Hà Nội}} là thủ đô của {{c2::Việt Nam}}.', 1);
  assert.match(back, /<mark[^>]*>Hà Nội<\/mark>/);
  assert.ok(back.includes('Việt Nam'), 'chỉ số khác hiện đáp án thường, không đánh dấu');
  assert.ok(!/<mark[^>]*>Việt Nam<\/mark>/.test(back));
});

test('renderCloze*: HTML trong văn bản gốc bị escape, không bị diễn giải', () => {
  const front = renderClozeFront('So sánh: 1 < 2 và {{c1::đúng}}.', 1);
  assert.ok(front.includes('1 &lt; 2'), 'ký tự < ngoài cloze phải được escape');
});

test('validateClozeText: văn bản hợp lệ không có lỗi', () => {
  assert.deepEqual(validateClozeText('Thủ đô {{c1::Hà Nội}} của {{c2::Việt Nam}}.'), []);
  assert.deepEqual(validateClozeText('Một đoạn {{c1::A}} và lặp lại {{c1::A}}.'), []);
});

test('validateClozeText: báo lỗi rõ ràng từng loại cú pháp hỏng', () => {
  assert.ok(validateClozeText('').length > 0, 'trống');
  assert.ok(validateClozeText('Văn bản không có cloze.').some((e) => e.includes('Chưa có đoạn cloze')));
  assert.ok(validateClozeText('Thiếu đóng {{c1::Hà Nội').some((e) => e.includes('chưa được đóng')));
  assert.ok(validateClozeText('Sai chỉ số {{cx::Hà Nội}}').some((e) => e.includes('chỉ số phải là số')));
  assert.ok(validateClozeText('Thiếu hai chấm {{c1 Hà Nội}}').some((e) => e.includes('thiếu "::"')));
  assert.ok(validateClozeText('Chỉ số 0 {{c0::Hà Nội}}').some((e) => e.includes('bắt đầu từ 1')));
  assert.ok(validateClozeText('Trống đáp án {{c1::}}').some((e) => e.includes('trống đáp án')));
});

test('getNextClozeIndex: tự tăng theo chỉ số lớn nhất đã dùng', () => {
  assert.equal(getNextClozeIndex('Chưa có gì.'), 1);
  assert.equal(getNextClozeIndex('{{c1::A}} và {{c3::B}}'), 4);
});

test('wrapSelectionAsCloze: bọc vùng chọn thành cloze với chỉ số tự tăng', () => {
  const once = wrapSelectionAsCloze('Hà Nội là thủ đô.', 0, 6);
  assert.equal(once, '{{c1::Hà Nội}} là thủ đô.');
  const twice = wrapSelectionAsCloze(once!, 18, 24);
  assert.equal(twice, '{{c1::Hà Nội}} là {{c2::thủ đô}}.');
  assert.equal(wrapSelectionAsCloze('abc', 1, 1), null, 'vùng chọn trống → null');
  assert.equal(wrapSelectionAsCloze('abc', 2, 1), null, 'vùng chọn ngược → null');
});
