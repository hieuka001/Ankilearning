import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AiResponseParseError,
  parseJson,
  normalizeFlashcards,
  normalizeQuestions,
  type ImageCandidate,
} from '../src/services/aiService';

// ---------- parseJson ----------

test('parseJson parses plain JSON object', () => {
  assert.deepEqual(parseJson('{"flashcards": [{"front": "a", "back": "b"}]}'), {
    flashcards: [{ front: 'a', back: 'b' }],
  });
});

test('parseJson extracts JSON from markdown fences', () => {
  const text = '```json\n{"questions": []}\n```';
  assert.deepEqual(parseJson(text), { questions: [] });
});

test('parseJson extracts JSON surrounded by prose', () => {
  const text = 'Đây là kết quả cho bạn: {"a": 1, "b": [1, 2]} Chúc học tốt!';
  assert.deepEqual(parseJson(text), { a: 1, b: [1, 2] });
});

test('parseJson tolerates trailing commas outside strings', () => {
  const text = '{"flashcards": [{"front": "a", "back": "b",},],}';
  assert.deepEqual(parseJson(text), { flashcards: [{ front: 'a', back: 'b' }] });
});

test('parseJson does not corrupt ",}" sequences inside string values', () => {
  const payload = { flashcards: [{ front: 'Liều dùng?', back: 'Dùng 5mg, } giữ nguyên như ghi chú, rồi nghỉ' }] };
  const parsed = parseJson(JSON.stringify(payload));
  assert.equal(parsed.flashcards[0].back, 'Dùng 5mg, } giữ nguyên như ghi chú, rồi nghỉ');
});

test('parseJson cleanup keeps ",}" inside strings while removing a real trailing comma', () => {
  const text = '{"note": "giá trị chứa ,} bên trong chuỗi",}';
  const parsed = parseJson(text);
  assert.equal(parsed.note, 'giá trị chứa ,} bên trong chuỗi');
});

test('parseJson returns an empty list payload as-is (valid empty result, not an error)', () => {
  assert.deepEqual(parseJson('{"flashcards": []}'), { flashcards: [] });
});

test('parseJson throws AiResponseParseError on unparseable text', () => {
  assert.throws(() => parseJson('đây không phải JSON gì cả'), AiResponseParseError);
  assert.throws(() => parseJson('{"flashcards": [}'), /không đúng định dạng/);
});

test('parseJson throws AiResponseParseError on empty text', () => {
  assert.throws(() => parseJson(''), AiResponseParseError);
  assert.throws(() => parseJson('   '), AiResponseParseError);
});

// ---------- normalizeFlashcards ----------

test('normalizeFlashcards drops cards missing front or back and keeps valid ones', () => {
  const cards = normalizeFlashcards({
    flashcards: [
      { front: 'Câu hỏi 1', back: 'Đáp án 1' },
      { front: '', back: 'Thiếu mặt trước' },
      { front: 'Thiếu mặt sau', back: '  ' },
      { question: 'Dạng question/answer', answer: 'Vẫn nhận' },
      null,
    ],
  });
  assert.equal(cards.length, 2);
  assert.equal(cards[0].front, 'Câu hỏi 1');
  assert.equal(cards[1].front, 'Dạng question/answer');
});

test('normalizeFlashcards keeps cloze type and defaults others to basic', () => {
  const cards = normalizeFlashcards({
    flashcards: [
      { front: 'Thuốc {{c1::ABCD}} trị tăng huyết áp', back: 'ABCD', type: 'cloze' },
      { front: 'Thẻ thường', back: 'Đáp án', type: 'weird' },
      { front: 'Thẻ không type', back: 'Đáp án' },
    ],
  });
  assert.equal(cards[0].type, 'cloze');
  assert.equal(cards[1].type, 'basic');
  assert.equal(cards[2].type, 'basic');
});

test('normalizeFlashcards returns [] for an empty list payload', () => {
  assert.deepEqual(normalizeFlashcards({ flashcards: [] }), []);
  assert.deepEqual(normalizeFlashcards({}), []);
});

// ---------- normalizeQuestions ----------

const candidates: ImageCandidate[] = [
  { id: 'card_1_front', url: 'https://example.com/ecg.png', source: 'card:front', context: 'ECG nhịp nhanh' },
  { id: 'mindmap_1', url: 'https://example.com/xray.jpg', source: 'mindmap', context: 'X-quang ngực' },
];

test('normalizeQuestions drops questions with too few options or out-of-range answers', () => {
  const questions = normalizeQuestions({
    questions: [
      { question: 'Câu hợp lệ?', options: ['A', 'B', 'C', 'D'], correctAnswer: 2, explanation: 'ok' },
      { question: 'Chỉ 1 lựa chọn?', options: ['A'], correctAnswer: 0 },
      { question: 'Đáp án ngoài khoảng?', options: ['A', 'B'], correctAnswer: 5 },
      { question: 'Đáp án âm?', options: ['A', 'B'], correctAnswer: -1 },
      { question: '', options: ['A', 'B'], correctAnswer: 0 },
    ],
  });
  assert.equal(questions.length, 1);
  assert.equal(questions[0].question, 'Câu hợp lệ?');
  assert.equal(questions[0].correctAnswer, 2);
});

test('normalizeQuestions converts letter answers (A-D) to indexes', () => {
  const questions = normalizeQuestions({
    questions: [{ question: 'Q?', options: ['A', 'B', 'C', 'D'], correctAnswer: 'C' }],
  });
  assert.equal(questions[0].correctAnswer, 2);
});

test('normalizeQuestions strips imageUrl outside the allowlist and keeps allowed ones', () => {
  const questions = normalizeQuestions(
    {
      questions: [
        {
          question: 'Ảnh bịa?',
          options: ['A', 'B'],
          correctAnswer: 0,
          imageUrl: 'https://evil.example.com/fake.png',
        },
        {
          question: 'Ảnh trong allowlist?',
          options: ['A', 'B'],
          correctAnswer: 1,
          imageUrl: 'https://example.com/ecg.png',
        },
        {
          question: 'Ảnh qua imageId?',
          options: ['A', 'B'],
          correctAnswer: 0,
          imageId: 'mindmap_1',
        },
      ],
    },
    candidates
  );
  assert.equal(questions[0].imageUrl, '');
  assert.equal(questions[1].imageUrl, 'https://example.com/ecg.png');
  assert.equal(questions[2].imageUrl, 'https://example.com/xray.jpg');
});

test('normalizeQuestions in strict mode strips every imageUrl when the allowlist is empty', () => {
  const questions = normalizeQuestions(
    {
      questions: [
        {
          question: 'Câu không được có ảnh?',
          options: ['A', 'B'],
          correctAnswer: 0,
          imageUrl: 'https://example.com/anything.png',
        },
      ],
    },
    [],
    true
  );
  assert.equal(questions[0].imageUrl, '');
});

test('normalizeQuestions keeps the source field (and citation alias)', () => {
  const questions = normalizeQuestions({
    questions: [
      { question: 'Q1?', options: ['A', 'B'], correctAnswer: 0, source: 'AHA/ACC 2023' },
      { question: 'Q2?', options: ['A', 'B'], correctAnswer: 1, citation: 'Harrison 21e' },
      { question: 'Q3?', options: ['A', 'B'], correctAnswer: 0 },
    ],
  });
  assert.equal(questions[0].source, 'AHA/ACC 2023');
  assert.equal(questions[1].source, 'Harrison 21e');
  assert.equal(questions[2].source, '');
});
