import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';
import initSqlJs from 'sql.js';
import {
  importAnkiApkg,
  exportAnkiApkgDetailed,
  resolveMediaMap,
  MAX_APKG_BYTES,
  type AnkiDeck,
} from '../src/services/ankiService';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APKG_PATH = path.resolve(__dirname, '../Chinese.apkg');
const TEST_TIMEOUT = 600_000;

function loadApkgFile(): File {
  const buffer = fs.readFileSync(APKG_PATH);
  const bytes = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
  return new File([bytes], 'Chinese.apkg', { type: 'application/octet-stream' });
}

// Import đúng 1 lần cho mọi assert (file 24MB, tránh lặp lại tốn thời gian).
let decksPromise: Promise<AnkiDeck[]> | undefined;
function loadDecks(): Promise<AnkiDeck[]> {
  decksPromise ??= importAnkiApkg(loadApkgFile());
  return decksPromise;
}

function cardAudioCount(card: AnkiDeck['cards'][number]): number {
  return (card.frontAudio?.length || 0) + (card.backAudio?.length || 0) + (card.audioUrls?.length || 0);
}

function cardImageCount(card: AnkiDeck['cards'][number]): number {
  return (card.frontImages?.length || 0) + (card.backImages?.length || 0)
    + (card.frontImage ? 1 : 0) + (card.backImage ? 1 : 0);
}

test('resolveMediaMap đọc được media protobuf/zstd của schema 18', { timeout: TEST_TIMEOUT }, async () => {
  const zip = await JSZip.loadAsync(fs.readFileSync(APKG_PATH));
  const mediaFile = zip.file('media');
  assert.ok(mediaFile, 'file .apkg phải có entry media');
  const mediaData = await mediaFile.async('uint8array');

  const map = resolveMediaMap(mediaData);
  assert.equal(map.size, 673, `media map phải có 673 entries, thực tế ${map.size}`);
  const names = Array.from(map.values());
  assert.ok(names.some((name) => name.endsWith('.mp3')), 'media map phải chứa tên file .mp3 thật');
  assert.ok(names.some((name) => name.endsWith('.jpg')), 'media map phải chứa tên file .jpg thật');
  assert.ok(names.every((name) => !/^\d+$/.test(name)), 'tên file trong media map phải là tên gốc, không phải số thứ tự');
});

test('import Chinese.apkg: cây deck lấy từ bảng decks, không gom vào "Anki Import"', { timeout: TEST_TIMEOUT }, async () => {
  const decks = await loadDecks();
  assert.ok(decks.length > 0, 'phải import được ít nhất 1 deck');
  assert.ok(
    decks.some((deck) => deck.name.includes('HSK1')),
    `phải có deck tên chứa HSK1, thực tế: ${decks.map((deck) => deck.name).join(' | ')}`,
  );
  assert.ok(
    decks.every((deck) => deck.name !== 'Anki Import'),
    'không deck nào được mang tên mặc định "Anki Import"',
  );
  assert.ok(
    decks.some((deck) => deck.name === 'Chinese::Từ vựng::HSK1'),
    'tên deck phân cấp phải đổi \\x1f thành ::',
  );
});

test('import Chinese.apkg: đủ 520 thẻ', { timeout: TEST_TIMEOUT }, async () => {
  const decks = await loadDecks();
  const totalCards = decks.reduce((sum, deck) => sum + deck.cards.length, 0);
  assert.equal(totalCards, 520, `tổng số thẻ phải là 520, thực tế ${totalCards}`);
});

test('import Chinese.apkg: media được resolve bằng tên gốc (audio > 400 thẻ, ảnh > 100 thẻ)', { timeout: TEST_TIMEOUT }, async () => {
  const decks = await loadDecks();
  const cards = decks.flatMap((deck) => deck.cards);
  const cardsWithAudio = cards.filter((card) => cardAudioCount(card) > 0).length;
  const cardsWithImages = cards.filter((card) => cardImageCount(card) > 0).length;
  assert.ok(cardsWithAudio > 400, `số thẻ có audio resolve được phải > 400, thực tế ${cardsWithAudio}`);
  assert.ok(cardsWithImages > 100, `số thẻ có ảnh resolve được phải > 100, thực tế ${cardsWithImages}`);

  const importedAudio = decks.reduce((sum, deck) => sum + (deck.importedAudioCount || 0), 0);
  assert.ok(importedAudio > 400, `importedAudioCount tổng phải > 400, thực tế ${importedAudio}`);
});

test('import vượt giới hạn kích thước bị từ chối bằng lỗi tiếng Việt', { timeout: TEST_TIMEOUT }, async () => {
  const file = new File([new Uint8Array(16)], 'huge.apkg', { type: 'application/octet-stream' });
  Object.defineProperty(file, 'size', { value: MAX_APKG_BYTES + 1 });
  await assert.rejects(() => importAnkiApkg(file), /quá lớn/);
});

test('import giữ tiến độ Anki (thẻ review, suspended) và chống trùng bằng existingNoteIds', { timeout: TEST_TIMEOUT }, async () => {
  const wasmPath = path.resolve(__dirname, '../node_modules/sql.js/dist/sql-wasm.wasm');
  const SQL = await initSqlJs({ locateFile: () => wasmPath });
  const db = new SQL.Database();
  db.run(`
    CREATE TABLE col (id integer primary key, crt integer, models text, decks text);
    CREATE TABLE notes (id integer primary key, flds text, tags text, mid integer);
    CREATE TABLE cards (id integer primary key, nid integer, did integer, ord integer,
      type integer, queue integer, due integer, ivl integer, factor integer, reps integer, lapses integer);
    CREATE TABLE decks (id integer primary key, name text);
  `);
  const crt = 1700000000;
  const models = JSON.stringify({
    1000: {
      id: 1000, name: 'Basic', type: 0,
      flds: [{ name: 'Front', ord: 0 }, { name: 'Back', ord: 1 }],
      tmpls: [{ name: 'Card 1', ord: 0, qfmt: '{{Front}}', afmt: '{{FrontSide}}<hr id=answer>{{Back}}' }],
    },
  });
  db.run('INSERT INTO col VALUES (1, ?, ?, ?)', [crt, models, '{}']);
  db.run("INSERT INTO decks VALUES (555, 'Parent\x1fChild')");
  db.run("INSERT INTO notes VALUES (111, 'Q1\x1fA1', '', 1000)");
  db.run("INSERT INTO notes VALUES (222, 'Q2\x1fA2', '', 1000)");
  // Thẻ review: due = 100 ngày kể từ crt, ivl 30, factor 2500 (ease 2.5), reps 7, lapses 2.
  db.run('INSERT INTO cards VALUES (1, 111, 555, 0, 2, 2, 100, 30, 2500, 7, 2)');
  // Thẻ review đang suspended (queue = -1).
  db.run('INSERT INTO cards VALUES (2, 222, 555, 0, 2, -1, 50, 10, 2000, 3, 0)');
  const zip = new JSZip();
  zip.file('collection.anki21', db.export());
  zip.file('media', '{}');
  db.close();
  const bytes = await zip.generateAsync({ type: 'uint8array' });
  const makeFile = () => new File([bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)], 'synthetic.apkg', { type: 'application/octet-stream' });

  const decks = await importAnkiApkg(makeFile());
  assert.equal(decks.length, 1);
  assert.equal(decks[0].name, 'Parent::Child');
  assert.equal(decks[0].cards.length, 2);

  const review = decks[0].cards.find((card) => card.noteId === '111')!;
  assert.ok(review.schedule, 'thẻ review phải có schedule suy từ Anki');
  assert.equal(review.schedule.state, 'review');
  assert.equal(review.schedule.stability, 30);
  assert.equal(review.schedule.scheduledDays, 30);
  assert.equal(review.schedule.reps, 7);
  assert.equal(review.schedule.lapses, 2);
  assert.equal(review.schedule.easeFactor, 2.5);
  const expectedDue = new Date((crt + 100 * 86400) * 1000).toISOString();
  assert.equal(review.schedule.dueDate, expectedDue);
  assert.equal(review.schedule.lastReview, new Date((crt + (100 - 30) * 86400) * 1000).toISOString());
  assert.equal(review.schedule.suspended, false);

  const suspended = decks[0].cards.find((card) => card.noteId === '222')!;
  assert.equal(suspended.schedule?.suspended, true, 'queue = -1 phải ánh xạ thành suspended');

  const deduped = await importAnkiApkg(makeFile(), { existingNoteIds: new Set(['111', '222']) });
  const totalCards = deduped.reduce((sum, deck) => sum + deck.cards.length, 0);
  const totalSkipped = deduped.reduce((sum, deck) => sum + (deck.duplicatesSkipped || 0), 0);
  assert.equal(totalCards, 0, 'note đã có phải bị bỏ qua toàn bộ');
  assert.equal(totalSkipped, 2, 'duplicatesSkipped phải đếm đủ 2 thẻ bị bỏ qua');
});

test('export: gắn tham chiếu media thật, dùng model Cloze và csum đúng thuật toán Anki', { timeout: TEST_TIMEOUT }, async () => {
  const pngDataUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  const mp3DataUrl = `data:audio/mpeg;base64,${Buffer.from('fake-mp3-bytes-for-export-test').toString('base64')}`;

  const { blob, warnings } = await exportAnkiApkgDetailed('Deck Test', [
    {
      front: 'Front text',
      back: 'Back text',
      type: 'basic',
      frontImage: pngDataUrl,
      backAudio: [mp3DataUrl],
      tags: [],
    },
    {
      front: 'Thủ đô của Việt Nam là {{c1::Hà Nội}}.',
      back: '',
      type: 'cloze',
      tags: [],
    },
  ]);

  assert.ok(
    warnings.some((warning) => warning.includes('Tiến độ học')),
    'kết quả export phải kèm cảnh báo tiến độ học không được xuất',
  );

  const zip = await JSZip.loadAsync(Buffer.from(await blob.arrayBuffer()));
  const mediaMap = JSON.parse(await zip.file('media')!.async('text')) as Record<string, string>;
  const mediaNames = Object.values(mediaMap);
  assert.ok(mediaNames.some((name) => name.endsWith('.png')), 'gói xuất phải chứa file ảnh .png');
  assert.ok(mediaNames.some((name) => name.endsWith('.mp3')), 'gói xuất phải chứa file audio .mp3');
  Object.keys(mediaMap).forEach((zipName) => {
    assert.ok(zip.file(zipName), `file media ${zipName} phải tồn tại trong gói`);
  });

  const wasmPath = path.resolve(__dirname, '../node_modules/sql.js/dist/sql-wasm.wasm');
  const SQL = await initSqlJs({ locateFile: () => wasmPath });
  const db = new SQL.Database(await zip.file('collection.anki2')!.async('uint8array'));

  const models = JSON.parse(String(db.exec('SELECT models FROM col')[0].values[0][0])) as Record<string, any>;
  const clozeModel = Object.values(models).find((model) => model.type === 1);
  assert.ok(clozeModel, 'gói xuất phải có model Cloze (type = 1)');
  assert.match(String(clozeModel.tmpls[0].qfmt), /cloze:Text/, 'template Cloze phải dùng {{cloze:Text}}');

  const notes = db.exec('SELECT mid, flds, csum FROM notes ORDER BY id')[0].values as unknown[][];
  assert.equal(notes.length, 2, 'phải xuất đúng 2 notes');

  const basicNote = notes.find((row) => Number(row[0]) !== clozeModel.id)!;
  const basicFields = String(basicNote[1]).split('\x1f');
  assert.match(basicFields[0], /<img src="[^"]+\.png">/, 'mặt trước phải gắn <img src="tên-file"> trỏ tới media đã đóng gói');
  assert.match(basicFields[1], /\[sound:[^\]]+\.mp3\]/, 'mặt sau phải gắn [sound:tên-file] trỏ tới media đã đóng gói');
  assert.ok(!String(basicNote[1]).includes('data:'), 'nội dung xuất không được còn data-URI');

  // csum = 4 byte đầu (big-endian int32) của SHA-1 trường đầu tiên đã strip HTML.
  const expectedCsum = createHash('sha1').update('Front text').digest().readInt32BE(0);
  assert.equal(Number(basicNote[2]), expectedCsum, 'csum của note basic phải đúng thuật toán Anki');

  const clozeNote = notes.find((row) => Number(row[0]) === clozeModel.id)!;
  assert.ok(clozeNote, 'thẻ cloze phải dùng model Cloze thay vì bị ép về Basic');
  assert.match(String(clozeNote[1]), /\{\{c1::Hà Nội\}\}/, 'nội dung cloze phải được giữ nguyên trong trường Text');

  db.close();
});

/** Dựng một .apkg tổng hợp tối thiểu (schema legacy: col.models + bảng decks). */
async function buildSyntheticApkg(models: Record<string, unknown>, notes: string[], cards: string[]): Promise<File> {
  const wasmPath = path.resolve(__dirname, '../node_modules/sql.js/dist/sql-wasm.wasm');
  const SQL = await initSqlJs({ locateFile: () => wasmPath });
  const db = new SQL.Database();
  db.run(`
    CREATE TABLE col (id integer primary key, crt integer, models text, decks text);
    CREATE TABLE notes (id integer primary key, flds text, tags text, mid integer);
    CREATE TABLE cards (id integer primary key, nid integer, did integer, ord integer,
      type integer, queue integer, due integer, ivl integer, factor integer, reps integer, lapses integer);
    CREATE TABLE decks (id integer primary key, name text);
  `);
  db.run('INSERT INTO col VALUES (1, ?, ?, ?)', [1700000000, JSON.stringify(models), '{}']);
  db.run("INSERT INTO decks VALUES (555, 'Deck Test')");
  notes.forEach((statement) => db.run(statement));
  cards.forEach((statement) => db.run(statement));
  const zip = new JSZip();
  zip.file('collection.anki21', db.export());
  zip.file('media', '{}');
  db.close();
  const bytes = await zip.generateAsync({ type: 'uint8array' });
  return new File([bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)], 'synthetic.apkg', { type: 'application/octet-stream' });
}

test('import model Cloze thật: mỗi chỉ số cloze thành một thẻ theo hợp đồng đợt 1A', { timeout: TEST_TIMEOUT }, async () => {
  const file = await buildSyntheticApkg(
    {
      2000: {
        id: 2000, name: 'Cloze', type: 1,
        flds: [{ name: 'Text', ord: 0 }, { name: 'Back Extra', ord: 1 }],
        tmpls: [{ name: 'Cloze', ord: 0, qfmt: '{{cloze:Text}}', afmt: '{{cloze:Text}}<br>{{Back Extra}}' }],
      },
    },
    ["INSERT INTO notes VALUES (777, 'Thủ đô của Việt Nam là {{c1::Hà Nội}} và nước này ở {{c2::Đông Nam Á}}.' || char(31) || 'Ghi chú thêm', '', 2000)"],
    [
      'INSERT INTO cards VALUES (1, 777, 555, 0, 0, 0, 0, 0, 0, 0, 0)',
      'INSERT INTO cards VALUES (2, 777, 555, 1, 0, 0, 0, 0, 0, 0, 0)',
    ],
  );

  const decks = await importAnkiApkg(file);
  assert.equal(decks.length, 1);
  assert.equal(decks[0].cards.length, 2, 'hai chỉ số cloze phải sinh hai thẻ vật lý');

  const expectedText = 'Thủ đô của Việt Nam là {{c1::Hà Nội}} và nước này ở {{c2::Đông Nam Á}}.';
  const expectedPlain = 'Thủ đô của Việt Nam là Hà Nội và nước này ở Đông Nam Á.';
  const byIndex = [...decks[0].cards].sort((a, b) => (a.clozeIndex || 0) - (b.clozeIndex || 0));
  assert.deepEqual(byIndex.map((card) => card.clozeIndex), [1, 2], 'clozeIndex = ord của thẻ Anki + 1');
  byIndex.forEach((card) => {
    assert.equal(card.cardType, 'cloze');
    assert.equal(card.type, 'cloze');
    assert.equal(card.noteId, '777', 'các thẻ cloze cùng ghi chú phải dùng chung noteId');
    assert.equal(card.clozeText, expectedText, 'clozeText là trường Text gốc, giữ nguyên {{cN::...}}');
    assert.equal(card.front, expectedPlain, 'front là bản văn bản thường (đáp án hiện rõ)');
    assert.equal(card.back, expectedPlain, 'back giống front theo hợp đồng');
  });
});

test('import model đảo ngược: cặp thẻ đủ hai chiều được gắn cardType=reversed', { timeout: TEST_TIMEOUT }, async () => {
  const file = await buildSyntheticApkg(
    {
      3000: {
        id: 3000, name: 'Basic (and reversed card)', type: 0,
        flds: [{ name: 'Front', ord: 0 }, { name: 'Back', ord: 1 }],
        tmpls: [
          { name: 'Card 1', ord: 0, qfmt: '{{Front}}', afmt: '{{FrontSide}}<hr id=answer>{{Back}}' },
          { name: 'Card 2', ord: 1, qfmt: '{{Back}}', afmt: '{{FrontSide}}<hr id=answer>{{Front}}' },
        ],
      },
    },
    [
      "INSERT INTO notes VALUES (333, 'Dog' || char(31) || 'Chó', '', 3000)",
      "INSERT INTO notes VALUES (444, 'Cat' || char(31) || 'Mèo', '', 3000)",
    ],
    [
      'INSERT INTO cards VALUES (1, 333, 555, 0, 0, 0, 0, 0, 0, 0, 0)',
      'INSERT INTO cards VALUES (2, 333, 555, 1, 0, 0, 0, 0, 0, 0, 0)',
      // Note 444 chỉ có một chiều (chiều ngược bị Anki bỏ qua) → giữ basic.
      'INSERT INTO cards VALUES (3, 444, 555, 0, 0, 0, 0, 0, 0, 0, 0)',
    ],
  );

  const decks = await importAnkiApkg(file);
  assert.equal(decks.length, 1);
  assert.equal(decks[0].cards.length, 3);
  const pair = decks[0].cards.filter((card) => card.noteId === '333');
  assert.equal(pair.length, 2);
  pair.forEach((card) => assert.equal(card.cardType, 'reversed', 'cặp đủ hai chiều phải là reversed'));
  const single = decks[0].cards.find((card) => card.noteId === '444')!;
  assert.equal(single.cardType, undefined, 'thẻ đơn lẻ của model đảo ngược giữ basic (không có cardType)');
});

test('export thẻ cloze theo hợp đồng: Text = clozeText, ord = clozeIndex - 1', { timeout: TEST_TIMEOUT }, async () => {
  const clozeText = 'Thủ đô {{c1::Hà Nội}} của {{c2::Việt Nam}}.';
  const plain = 'Thủ đô Hà Nội của Việt Nam.';
  const { blob } = await exportAnkiApkgDetailed('Deck Cloze', [
    { front: plain, back: plain, type: 'cloze', cardType: 'cloze', clozeText, clozeIndex: 2, tags: [] },
  ]);

  const zip = await JSZip.loadAsync(Buffer.from(await blob.arrayBuffer()));
  const wasmPath = path.resolve(__dirname, '../node_modules/sql.js/dist/sql-wasm.wasm');
  const SQL = await initSqlJs({ locateFile: () => wasmPath });
  const db = new SQL.Database(await zip.file('collection.anki2')!.async('uint8array'));

  const models = JSON.parse(String(db.exec('SELECT models FROM col')[0].values[0][0])) as Record<string, any>;
  const clozeModel = Object.values(models).find((model) => model.type === 1)!;
  const notes = db.exec('SELECT mid, flds FROM notes')[0].values as unknown[][];
  assert.equal(notes.length, 1);
  assert.equal(Number(notes[0][0]), clozeModel.id, 'note cloze hợp đồng phải dùng model Cloze');
  assert.equal(String(notes[0][1]).split('\x1f')[0], clozeText, 'trường Text phải là clozeText gốc');
  const cardRows = db.exec('SELECT ord FROM cards')[0].values as unknown[][];
  assert.equal(Number(cardRows[0][0]), 1, 'ord trong gói xuất = clozeIndex - 1');

  db.close();
});
