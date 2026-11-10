import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_DOCUMENT_CHARS,
  UNSUPPORTED_DOCUMENT_MESSAGE,
  capDocumentText,
  detectDocumentKind,
  extractPdfPageText,
  extractTextFromDocument,
} from '../src/lib/documentText';

test('detectDocumentKind: nhận diện PDF theo phần mở rộng (không phân biệt hoa thường)', () => {
  assert.equal(detectDocumentKind('bai-hoc.pdf', ''), 'pdf');
  assert.equal(detectDocumentKind('BAI-HOC.PDF', ''), 'pdf');
  assert.equal(detectDocumentKind('tai-lieu.Pdf', 'application/octet-stream'), 'pdf');
});

test('detectDocumentKind: nhận diện PDF theo MIME khi tên không có đuôi', () => {
  assert.equal(detectDocumentKind('download', 'application/pdf'), 'pdf');
});

test('detectDocumentKind: nhận diện DOCX theo phần mở rộng và theo MIME Word', () => {
  assert.equal(detectDocumentKind('giao-trinh.docx', ''), 'docx');
  assert.equal(
    detectDocumentKind('giao-trinh', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'),
    'docx',
  );
});

test('detectDocumentKind: nhận diện TXT/MD theo phần mở rộng và MIME text', () => {
  assert.equal(detectDocumentKind('ghi-chu.txt', ''), 'text');
  assert.equal(detectDocumentKind('ghi-chu.md', ''), 'text');
  assert.equal(detectDocumentKind('ghi-chu.markdown', ''), 'text');
  assert.equal(detectDocumentKind('ghi-chu', 'text/plain'), 'text');
  assert.equal(detectDocumentKind('ghi-chu', 'text/markdown'), 'text');
});

test('detectDocumentKind: từ chối định dạng lạ (kể cả .doc cũ, ảnh, file nén)', () => {
  assert.equal(detectDocumentKind('tai-lieu.doc', 'application/msword'), null);
  assert.equal(detectDocumentKind('anh.png', 'image/png'), null);
  assert.equal(detectDocumentKind('bo-the.apkg', ''), null);
  assert.equal(detectDocumentKind('archive.zip', 'application/zip'), null);
  assert.equal(detectDocumentKind('', ''), null);
});

test('capDocumentText: văn bản dưới trần thì giữ nguyên, truncated = false', () => {
  const short = 'Nội dung ngắn';
  assert.deepEqual(capDocumentText(short), { text: short, truncated: false });
  const exact = 'a'.repeat(MAX_DOCUMENT_CHARS);
  assert.deepEqual(capDocumentText(exact), { text: exact, truncated: false });
});

test('capDocumentText: văn bản vượt trần 120.000 ký tự bị cắt đúng trần, truncated = true', () => {
  const long = 'x'.repeat(MAX_DOCUMENT_CHARS + 5000);
  const capped = capDocumentText(long);
  assert.equal(capped.text.length, MAX_DOCUMENT_CHARS);
  assert.equal(capped.text, long.slice(0, MAX_DOCUMENT_CHARS));
  assert.equal(capped.truncated, true);
});

test('extractTextFromDocument: file định dạng lạ bị ném lỗi tiếng Việt rõ ràng', async () => {
  const file = new File(['du-lieu'], 'bo-the.apkg', { type: '' });
  await assert.rejects(extractTextFromDocument(file), (err: any) => {
    assert.equal(err.message, UNSUPPORTED_DOCUMENT_MESSAGE);
    return true;
  });
});

test('extractTextFromDocument: file .txt được đọc nguyên văn', async () => {
  const file = new File(['Chương 1: Giới thiệu\nNội dung bài học.'], 'bai-1.txt', { type: 'text/plain' });
  const result = await extractTextFromDocument(file);
  assert.equal(result.kind, 'text');
  assert.equal(result.text, 'Chương 1: Giới thiệu\nNội dung bài học.');
  assert.equal(result.truncated, false);
});

test('extractTextFromDocument: file .md dài hơn trần bị cắt và gắn cờ truncated', async () => {
  const file = new File(['y'.repeat(MAX_DOCUMENT_CHARS + 1)], 'dai.md', { type: '' });
  const result = await extractTextFromDocument(file);
  assert.equal(result.kind, 'text');
  assert.equal(result.text.length, MAX_DOCUMENT_CHARS);
  assert.equal(result.truncated, true);
});

test('extractPdfPageText: giữ cấu trúc dòng/đoạn theo toạ độ dọc (hành vi cũ của AIHelper)', () => {
  const items = [
    { str: 'Dòng một', transform: [1, 0, 0, 1, 0, 100], height: 12, hasEOL: false },
    { str: 'dòng hai', transform: [1, 0, 0, 1, 0, 88], height: 12, hasEOL: false },
    { str: 'Đoạn mới', transform: [1, 0, 0, 1, 0, 50], height: 12, hasEOL: false },
  ];
  assert.equal(extractPdfPageText(items), 'Dòng một\ndòng hai\n\nĐoạn mới');
});
