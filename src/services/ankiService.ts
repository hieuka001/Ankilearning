import JSZip from 'jszip';
import initSqlJs from 'sql.js';
import { decompress } from 'fzstd';
import {
  formatChineseVocabBack,
  formatChineseVocabFront,
  isChineseVocabNoteType,
} from '../lib/chineseCardLayout';

const DEFAULT_INLINE_MAX_BYTES = 256 * 1024;

/** Kích thước .apkg tối đa được phép import (150MB). */
export const MAX_APKG_BYTES = 150 * 1024 * 1024;
/** Trên ngưỡng này (50MB) vẫn import nhưng kèm cảnh báo cho người dùng. */
export const LARGE_APKG_WARNING_BYTES = 50 * 1024 * 1024;

// sql.js WASM được tự host cùng bản build (không tải từ CDN sql.js.org nữa):
// - Trình duyệt: Vite phục vụ file wasm trong node_modules qua hậu tố `?url`.
// - Node (test/script): trỏ thẳng tới file wasm trong node_modules.
async function loadSqlWasmUrl(): Promise<string> {
  if (typeof window === 'undefined') {
    const url = new URL('../../node_modules/sql.js/dist/sql-wasm.wasm', import.meta.url);
    return url.protocol === 'file:' ? decodeURIComponent(url.pathname) : url.href;
  }
  const mod = await import('sql.js/dist/sql-wasm.wasm?url');
  return (mod as { default: string }).default;
}

let sqlJsPromise: Promise<any> | undefined;
function initAnkiSql(): Promise<any> {
  sqlJsPromise ??= (async () => {
    const wasmUrl = await loadSqlWasmUrl();
    return initSqlJs({ locateFile: () => wasmUrl });
  })();
  return sqlJsPromise;
}
const ANKI_COLLECTION_CANDIDATES = ['collection.anki21b', 'collection.anki21', 'collection.anki2'];
const ANKI_UPDATE_PLACEHOLDER = 'Please update to the latest Anki version';
const soundPattern = /\[sound:([^\]]+)\]/gi;
const ttsPattern = /\[anki:tts[^\]]*\]/gi;
const imagePattern = /<img[^>]+src=["']([^"']+)["'][^>]*>/gi;
const SQLITE_MAGIC = new TextEncoder().encode('SQLite format 3\u0000');

/**
 * Lịch học suy từ các trường scheduling của Anki khi import (fields khớp với
 * createInitialCardSchedule/normalizeCardSchedule trong scheduler của app).
 * Đây là ánh xạ XẤP XỈ: Anki không lưu stability/difficulty kiểu FSRS, nên
 * stability lấy theo ivl, còn difficulty để trống — normalizeCardSchedule sẽ
 * tự suy từ easeFactor theo quy ước sẵn có của app.
 */
export interface AnkiImportedSchedule {
  state: 'learning' | 'review' | 'relearning';
  due: string;
  dueDate: string;
  nextReview: string;
  stability: number;
  easeFactor?: number;
  retrievability: number;
  elapsedDays: number;
  scheduledDays: number;
  interval: number;
  stepIndex: number;
  lapses: number;
  reps: number;
  repetitions: number;
  suspended: boolean;
  buriedUntil: string;
  lastReview?: string;
  updatedAt: string;
}

export interface AnkiCard {
  front: string;
  back: string;
  type?: 'basic' | 'cloze';
  noteId?: string;
  frontImage?: string;
  backImage?: string;
  frontImages?: string[];
  backImages?: string[];
  frontAudio?: string[];
  backAudio?: string[];
  audioUrls?: string[];
  extraFields?: Record<string, string>;
  noteType?: string;
  tags?: string[];
  /** Chỉ có khi thẻ Anki đã có tiến độ học (type/queue khác thẻ mới). */
  schedule?: AnkiImportedSchedule;
}

export interface AnkiDeck {
  name: string;
  cards: AnkiCard[];
  importedAudioCount?: number;
  skippedAudioCount?: number;
  importedImageCount?: number;
  skippedImageCount?: number;
  /** Số thẻ bị bỏ qua vì trùng noteId (đã có từ trước hoặc trùng trong cùng file). */
  duplicatesSkipped?: number;
  /** Cảnh báo đi kèm lần import (ví dụ: tệp lớn). */
  warnings?: string[];
}

export interface AnkiImportOptions {
  inlineMaxBytes?: number;
  onLargeMedia?: (filename: string, data: Uint8Array, mimeType: string) => Promise<string | undefined>;
  /** noteId đã tồn tại ở đích đến — note thuộc nhóm này sẽ bị bỏ qua khi import. */
  existingNoteIds?: Set<string>;
}

interface AnkiFieldDef {
  name: string;
  ord: number;
}

interface AnkiTemplate {
  name: string;
  ord: number;
  qfmt: string;
  afmt: string;
}

interface AnkiModel {
  id: number;
  name: string;
  type: number;
  flds: AnkiFieldDef[];
  tmpls: AnkiTemplate[];
  css?: string;
}

interface MediaStats {
  imported: number;
  skipped: number;
}

interface ProcessedField {
  html: string;
  plainText: string;
  audioUrls: string[];
  imageUrls: string[];
  audioRefs: string[];
  imageRefs: string[];
}

function decodeHtmlEntities(value: string): string {
  const entities: Record<string, string> = {
    '&nbsp;': ' ',
    '&lt;': '<',
    '&gt;': '>',
    '&amp;': '&',
    '&quot;': '"',
    '&apos;': "'",
  };
  return value.replace(/&(?:#x?[0-9a-f]+|[a-z]+);/gi, (match) => {
    if (entities[match]) return entities[match];
    if (match.startsWith('&#x') || match.startsWith('&#X')) {
      const code = parseInt(match.slice(3, -1), 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    if (match.startsWith('&#')) {
      const code = parseInt(match.slice(2, -1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    return match;
  });
}

function stripHtmlToPlainText(html: string): string {
  if (!html) return '';
  let text = html
    .replace(/{{c\d+::autocloze}}/g, '')
    .replace(/{{c\d+::(.*?)(::.*?)?}}/g, '$1')
    .replace(/<(br|div|p)\s*\/?>/gi, '\n')
    .replace(/<\/(div|p)>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/\[sound:.*?\]/gi, '')
    .replace(/\[anki:tts[^\]]*\]/gi, '');
  return decodeHtmlEntities(text).replace(/\n\s*\n/g, '\n\n').trim();
}

function normalizeMediaName(value: string) {
  const cleaned = decodeHtmlEntities(value).split(/[?#]/)[0].replace(/^file:\/\//i, '').trim();
  try {
    return decodeURIComponent(cleaned);
  } catch {
    return cleaned;
  }
}

function basename(value: string) {
  return normalizeMediaName(value).split(/[\\/]/).filter(Boolean).pop() || normalizeMediaName(value);
}

function getMimeType(filename: string) {
  const clean = filename.toLowerCase();
  if (/\.(mp3|mpeg|mpga)$/.test(clean)) return 'audio/mpeg';
  if (/\.m4a$/.test(clean)) return 'audio/mp4';
  if (/\.aac$/.test(clean)) return 'audio/aac';
  if (/\.wav$/.test(clean)) return 'audio/wav';
  if (/\.ogg$/.test(clean)) return 'audio/ogg';
  if (/\.flac$/.test(clean)) return 'audio/flac';
  if (/\.webm$/.test(clean)) return 'video/webm';
  if (/\.mp4$/.test(clean)) return 'video/mp4';
  if (/\.png$/.test(clean)) return 'image/png';
  if (/\.(jpg|jpeg)$/.test(clean)) return 'image/jpeg';
  if (/\.gif$/.test(clean)) return 'image/gif';
  if (/\.webp$/.test(clean)) return 'image/webp';
  if (/\.svg$/.test(clean)) return 'image/svg+xml';
  return 'application/octet-stream';
}

function extractMediaReferences(html: string, pattern: RegExp) {
  const matches: string[] = [];
  html.replace(pattern, (match, filename) => {
    const clean = normalizeMediaName(String(filename || ''));
    if (clean) matches.push(clean);
    return match;
  });
  return Array.from(new Set(matches));
}

function startsWithBytes(source: Uint8Array, prefix: Uint8Array) {
  if (source.byteLength < prefix.byteLength) return false;
  for (let i = 0; i < prefix.byteLength; i += 1) {
    if (source[i] !== prefix[i]) return false;
  }
  return true;
}

function decompressCollectionData(name: string, data: Uint8Array): Uint8Array {
  if (startsWithBytes(data, SQLITE_MAGIC)) return data;

  const lowerName = basename(name).toLowerCase();
  if (lowerName.endsWith('.anki21b') || lowerName.endsWith('.anki21')) {
    try {
      const decompressed = decompress(data);
      if (startsWithBytes(decompressed, SQLITE_MAGIC)) return decompressed;
    } catch {
      // Fall through to raw bytes.
    }
  }

  return data;
}

const ZSTD_MAGIC = new Uint8Array([0x28, 0xb5, 0x2f, 0xfd]);
const MEDIA_FILE_EXTENSIONS = /\.(mp3|m4a|wav|ogg|oga|flac|aac|jpg|jpeg|png|gif|webp|svg|mp4|webm|mov)$/i;

function readProtoVarint(data: Uint8Array, start: number): [bigint, number] | null {
  let result = 0n;
  let shift = 0n;
  let pos = start;
  while (pos < data.length && pos - start < 10) {
    const byte = data[pos];
    pos += 1;
    result |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return [result, pos];
    shift += 7n;
  }
  return null;
}

/**
 * Parse phần thân của 1 media entry (protobuf): field 1 (string) là tên file gốc.
 * Các field khác (2 = size dạng varint, 3 = sha1 20 bytes...) được duyệt bỏ qua.
 */
function parseMediaEntryName(entry: Uint8Array): string | undefined {
  let pos = 0;
  while (pos < entry.length) {
    const tagRead = readProtoVarint(entry, pos);
    if (!tagRead) return undefined;
    const [tag, afterTag] = tagRead;
    pos = afterTag;
    const field = Number(tag >> 3n);
    const wire = Number(tag & 7n);
    if (wire === 2) {
      const lenRead = readProtoVarint(entry, pos);
      if (!lenRead) return undefined;
      const [len, afterLen] = lenRead;
      pos = afterLen;
      const size = Number(len);
      if (pos + size > entry.length) return undefined;
      if (field === 1) return new TextDecoder().decode(entry.subarray(pos, pos + size));
    } else if (wire === 0) {
      const valueRead = readProtoVarint(entry, pos);
      if (!valueRead) return undefined;
      pos = valueRead[1];
    } else if (wire === 5) {
      pos += 4;
    } else if (wire === 1) {
      pos += 8;
    } else {
      return undefined;
    }
  }
  return undefined;
}

/**
 * Parse media entries chuẩn Anki (schema 18): message cấp cao nhất là các
 * field 1 (length-delimited) lặp lại, mỗi field là 1 entry. Trả về danh sách
 * tên file gốc theo đúng thứ tự entry (= số thứ tự của file trong zip).
 */
function parseProtobufMediaNames(data: Uint8Array): string[] {
  const names: string[] = [];
  let pos = 0;
  while (pos < data.length) {
    const tagRead = readProtoVarint(data, pos);
    if (!tagRead) break;
    const [tag, afterTag] = tagRead;
    const field = Number(tag >> 3n);
    const wire = Number(tag & 7n);
    if (field !== 1 || wire !== 2) break;
    const lenRead = readProtoVarint(data, afterTag);
    if (!lenRead) break;
    const [len, afterLen] = lenRead;
    const size = Number(len);
    if (afterLen + size > data.length) break;
    const name = parseMediaEntryName(data.subarray(afterLen, afterLen + size));
    if (!name) break;
    names.push(name);
    pos = afterLen + size;
  }
  return names;
}

/** Fallback: trích các chuỗi in được trông giống tên file media theo thứ tự xuất hiện. */
function extractPrintableMediaNames(data: Uint8Array): string[] {
  const text = new TextDecoder('utf-8', { fatal: false }).decode(data);
  const matches = text.match(/[^\x00-\x1f\ufffd]{4,200}?\.(?:mp3|m4a|wav|ogg|oga|flac|aac|jpg|jpeg|png|gif|webp|svg|mp4|webm|mov)/gi) || [];
  const seen = new Set<string>();
  return matches
    .map((match) => match.trim())
    .filter((name) => {
      if (!MEDIA_FILE_EXTENSIONS.test(name) || seen.has(name)) return false;
      seen.add(name);
      return true;
    });
}

/**
 * Giải mã file `media` trong .apkg thành map: tên file trong zip (số thứ tự
 * "0", "1", ...) → tên file gốc mà nội dung thẻ tham chiếu.
 * Hỗ trợ cả 2 định dạng: JSON (Anki cũ) và protobuf nén zstd (Anki mới, schema 18).
 */
export function resolveMediaMap(data: Uint8Array): Map<string, string> {
  const map = new Map<string, string>();
  if (!data || data.byteLength === 0) return map;

  // Định dạng cũ: JSON { "0": "ten-goc.mp3", ... }
  try {
    const text = new TextDecoder().decode(data).trim();
    if (text.startsWith('{')) {
      const parsed = JSON.parse(text) as Record<string, string>;
      Object.entries(parsed).forEach(([zipName, originalName]) => {
        if (originalName) map.set(zipName, String(originalName));
      });
      if (map.size > 0) return map;
    }
  } catch {
    // Không phải JSON — thử định dạng protobuf bên dưới.
  }

  // Định dạng mới (schema 18): protobuf nén zstd.
  let payload = data;
  if (startsWithBytes(data, ZSTD_MAGIC)) {
    try {
      payload = decompress(data);
    } catch {
      payload = data;
    }
  }

  const names = parseProtobufMediaNames(payload);
  const resolved = names.length > 0 ? names : extractPrintableMediaNames(payload);
  resolved.forEach((name, index) => map.set(String(index), name));
  return map;
}

async function hydrateMediaLookup(contents: JSZip) {
  const lookup = new Map<string, string>();
  const addAlias = (sourceName: string, zipName: string) => {
    const normalized = normalizeMediaName(sourceName);
    [sourceName, normalized, basename(normalized)].filter(Boolean).forEach((alias) => lookup.set(alias, zipName));
  };

  const mediaFile = contents.file('media');
  if (mediaFile) {
    const mediaData = await mediaFile.async('uint8array');
    resolveMediaMap(mediaData).forEach((originalName, zipName) => {
      addAlias(originalName, zipName);
      addAlias(zipName, zipName);
    });
  }

  contents.forEach((relativePath, zipEntry) => {
    if (!zipEntry.dir) addAlias(relativePath, relativePath);
  });

  return lookup;
}

async function resolveEmbeddedMedia(
  contents: JSZip,
  mediaLookup: Map<string, string>,
  filename: string,
  mediaCache: Map<string, Promise<string | undefined>>,
  options: AnkiImportOptions,
) {
  const normalized = normalizeMediaName(filename);
  const zipPath = mediaLookup.get(normalized) || mediaLookup.get(basename(normalized)) || normalized;
  if (mediaCache.has(zipPath)) return mediaCache.get(zipPath)!;

  const inlineMaxBytes = options.inlineMaxBytes ?? DEFAULT_INLINE_MAX_BYTES;

  const promise = (async () => {
    const file = contents.file(zipPath) || contents.file(normalized) || contents.file(basename(normalized));
    if (!file) return undefined;

    const data = await file.async('uint8array');
    const mimeType = getMimeType(normalized);

    if (data.byteLength > inlineMaxBytes && options.onLargeMedia) {
      const uploaded = await options.onLargeMedia(normalized, data, mimeType);
      if (uploaded) return uploaded;
    }

    if (data.byteLength > inlineMaxBytes) return undefined;

    const base64 = await file.async('base64');
    return `data:${mimeType};base64,${base64}`;
  })();

  mediaCache.set(zipPath, promise);
  return promise;
}

async function resolveMediaList(
  contents: JSZip,
  mediaLookup: Map<string, string>,
  filenames: string[],
  mediaCache: Map<string, Promise<string | undefined>>,
  options: AnkiImportOptions,
) {
  const resolved = await Promise.all(
    filenames.map((filename) => resolveEmbeddedMedia(contents, mediaLookup, filename, mediaCache, options)),
  );
  return resolved.filter(Boolean) as string[];
}

function getCollectionCandidates(contents: JSZip) {
  const candidates = new Map<string, JSZip.JSZipObject>();
  const addCandidate = (name: string) => {
    const file = contents.file(name);
    if (file) candidates.set(name, file);
  };

  ANKI_COLLECTION_CANDIDATES.forEach(addCandidate);
  contents.forEach((relativePath, zipEntry) => {
    const fileName = basename(relativePath).toLowerCase();
    if (!zipEntry.dir && fileName.startsWith('collection.anki')) {
      candidates.set(relativePath, zipEntry);
    }
  });

  const priority = (name: string) => {
    const fileName = basename(name).toLowerCase();
    if (fileName === 'collection.anki21b') return 0;
    if (fileName === 'collection.anki21') return 1;
    if (fileName === 'collection.anki2') return 3;
    return 2;
  };

  return Array.from(candidates.entries())
    .map(([name, file]) => ({ name, file }))
    .sort((a, b) => priority(a.name) - priority(b.name) || a.name.localeCompare(b.name));
}

async function openBestCollectionDatabase(contents: JSZip, SQL: any) {
  const candidates = getCollectionCandidates(contents);

  if (candidates.length === 0) {
    throw new Error('Không tìm thấy tệp dữ liệu Anki');
  }

  let legacyDb: any;
  const openCandidate = async (candidate: { name: string; file: JSZip.JSZipObject }) => {
    const rawData = await candidate.file.async('uint8array');
    const dbData = decompressCollectionData(candidate.name, rawData);
    return new SQL.Database(dbData);
  };

  for (const candidate of candidates) {
    if (!candidate.name.toLowerCase().endsWith('collection.anki2')) continue;
    try {
      const db = await openCandidate(candidate);
      const cardCheck = db.exec('SELECT n.flds FROM notes n JOIN cards c ON n.id = c.nid LIMIT 25');
      const fields = cardCheck[0]?.values?.map((row: unknown[]) => String(row[0] || '')) || [];
      const hasRealCards = fields.some((field: string) => field.trim() && !field.includes(ANKI_UPDATE_PLACEHOLDER));
      if (hasRealCards) {
        legacyDb = db;
        break;
      }
      db.close();
    } catch {
      // Ignore unreadable legacy collection.
    }
  }

  let fallbackDb: any;
  let fallbackName = '';

  for (const candidate of candidates) {
    if (candidate.name.toLowerCase().endsWith('collection.anki2')) continue;
    try {
      const db = await openCandidate(candidate);
      const cardCheck = db.exec('SELECT n.flds FROM notes n JOIN cards c ON n.id = c.nid LIMIT 25');
      const fields = cardCheck[0]?.values?.map((row: unknown[]) => String(row[0] || '')) || [];
      const hasRealCards = fields.some((field: string) => field.trim() && !field.includes(ANKI_UPDATE_PLACEHOLDER));

      if (hasRealCards) {
        fallbackDb?.close();
        return { db, legacyDb };
      }

      if (!fallbackDb) {
        fallbackDb = db;
        fallbackName = candidate.name;
      } else {
        db.close();
      }
    } catch {
      // Modern APKG files can contain several collection variants. Try the next one.
    }
  }

  if (fallbackDb) {
    fallbackDb.close();
    const candidateNames = candidates.map((candidate) => candidate.name).join(', ');
    throw new Error(
      `File APKG này chỉ có ${candidateNames || fallbackName} và không chứa dữ liệu thẻ thật. Hãy mở file bằng Anki bản mới nhất rồi export lại deck.`,
    );
  }

  throw new Error('Không đọc được dữ liệu trong tệp Anki');
}

function decodeAnkiConfigBlob(value: unknown): string {
  if (!value) return '';
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value as ArrayBuffer);
  try {
    return new TextDecoder().decode(decompress(bytes));
  } catch {
    return new TextDecoder().decode(bytes);
  }
}

function stripAnkiConfigNoise(value: string) {
  return value
    .replace(/[\x00-\x08\x0e-\x1f]/g, '')
    .replace(/\\documentclass[\s\S]*$/i, '')
    .trim();
}

function parseTemplateConfigBlob(value: unknown): { qfmt: string; afmt: string } {
  const raw = stripAnkiConfigNoise(decodeAnkiConfigBlob(value));
  const backMarker = raw.search(/<!--\s*=+\s*Back/i);
  if (backMarker > 0) {
    const htmlStart = raw.search(/<!--|<div|<span|<p|<ruby|<table/i);
    const qfmt = stripAnkiConfigNoise(raw.slice(htmlStart >= 0 ? htmlStart : 0, backMarker));
    const afmt = stripAnkiConfigNoise(raw.slice(backMarker));
    if (qfmt || afmt) return { qfmt, afmt };
  }

  const htmlBlocks = raw.match(/(?:<!--[\s\S]*?-->[\s\S]*?|<(?:div|span|p|ruby|table)[\s\S]*?>[\s\S]*?<\/(?:div|span|p|ruby|table)>)/gi) || [];
  return {
    qfmt: htmlBlocks[0] || '{{Front}}',
    afmt: htmlBlocks[1] || '{{FrontSide}}<hr id=answer>{{Back}}',
  };
}

function parseNotetypeCssBlob(value: unknown): string {
  const raw = stripAnkiConfigNoise(decodeAnkiConfigBlob(value));
  const cssStart = raw.indexOf('.card');
  if (cssStart < 0) return '';
  return raw.slice(cssStart);
}

function parseLegacyModels(db: any): Map<number, AnkiModel> {
  const models = new Map<number, AnkiModel>();
  const colRes = db.exec('SELECT models FROM col');
  if (colRes.length === 0) return models;

  try {
    const raw = JSON.parse(colRes[0].values[0][0] as string) as Record<string, any>;
    Object.values(raw).forEach((model) => {
      models.set(Number(model.id), {
        id: Number(model.id),
        name: String(model.name || 'Basic'),
        type: Number(model.type || 0),
        flds: (model.flds || []).map((field: any, index: number) => ({
          name: String(field.name || `Field ${index + 1}`),
          ord: Number(field.ord ?? index),
        })),
        tmpls: (model.tmpls || []).map((template: any, index: number) => ({
          name: String(template.name || `Card ${index + 1}`),
          ord: Number(template.ord ?? index),
          qfmt: String(template.qfmt || '{{Front}}'),
          afmt: String(template.afmt || '{{FrontSide}}<hr id=answer>{{Back}}'),
        })),
        css: String(model.css || ''),
      });
    });
  } catch {
    // Fall back to modern schema tables.
  }

  return models;
}

function parseModernModels(db: any): Map<number, AnkiModel> {
  const models = new Map<number, AnkiModel>();
  let notetypes: any[] = [];
  let fields: any[] = [];
  let templates: any[] = [];

  try {
    notetypes = db.exec('SELECT id, name, config FROM notetypes')?.[0]?.values || [];
    fields = db.exec('SELECT ntid, ord, name FROM fields ORDER BY ntid, ord')?.[0]?.values || [];
    templates = db.exec('SELECT ntid, ord, name, config FROM templates ORDER BY ntid, ord')?.[0]?.values || [];
  } catch {
    return models;
  }

  if (notetypes.length === 0) return models;

  const fieldsByNotetype = new Map<number, AnkiFieldDef[]>();
  fields.forEach((row) => {
    const ntid = Number(row[0]);
    const list = fieldsByNotetype.get(ntid) || [];
    list.push({ name: String(row[2] || `Field ${row[1]}`), ord: Number(row[1] || list.length) });
    fieldsByNotetype.set(ntid, list);
  });

  const templatesByNotetype = new Map<number, AnkiTemplate[]>();
  templates.forEach((row) => {
    const ntid = Number(row[0]);
    const list = templatesByNotetype.get(ntid) || [];
    const parsed = parseTemplateConfigBlob(row[3]);
    list.push({
      name: String(row[2] || `Card ${row[1]}`),
      ord: Number(row[1] || list.length),
      qfmt: parsed.qfmt,
      afmt: parsed.afmt,
    });
    templatesByNotetype.set(ntid, list);
  });

  notetypes.forEach((row) => {
    const id = Number(row[0]);
    const flds = (fieldsByNotetype.get(id) || []).sort((a, b) => a.ord - b.ord);
    const tmpls = (templatesByNotetype.get(id) || []).sort((a, b) => a.ord - b.ord);
    if (flds.length === 0) return;

    models.set(id, {
      id,
      name: String(row[1] || 'Basic'),
      type: 0,
      flds,
      tmpls: tmpls.length > 0 ? tmpls : [{
        name: 'Card 1',
        ord: 0,
        qfmt: `{{${flds[0]?.name || 'Front'}}}`,
        afmt: `{{FrontSide}}<hr id=answer>{{${flds[1]?.name || 'Back'}}}`,
      }],
      css: parseNotetypeCssBlob(row[2]),
    });
  });

  return models;
}

function parseModels(db: any, legacyDb?: any): Map<number, AnkiModel> {
  const modern = parseModernModels(db);
  if (modern.size > 0) return modern;

  const legacy = parseLegacyModels(legacyDb || db);
  if (legacy.size > 0) return legacy;

  return parseLegacyModels(db);
}

function buildFieldMap(fieldNames: string[], fieldValues: string[]): Record<string, string> {
  const map: Record<string, string> = {};
  fieldNames.forEach((name, index) => {
    map[name] = fieldValues[index] || '';
  });
  return map;
}

function renderAnkiTemplate(template: string, fieldMap: Record<string, string>, frontSideHtml = ''): string {
  let result = template.replace(/\{\{FrontSide\}\}/gi, frontSideHtml);

  result = result.replace(/\{\{#([^}]+)\}\}([\s\S]*?)\{\{\/\1\}\}/gi, (_, field, content) => {
    const key = String(field).trim().replace(/^(type|cloze|hint):/i, '');
    const value = fieldMap[key] ?? fieldMap[String(field).trim()] ?? '';
    return value.trim() ? content : '';
  });

  result = result.replace(/\{\{\^([^}]+)\}\}([\s\S]*?)\{\{\/\1\}\}/gi, (_, field, content) => {
    const key = String(field).trim();
    const value = fieldMap[key] ?? '';
    return value.trim() ? '' : content;
  });

  result = result.replace(/\{\{(?:type|cloze|hint):([^}]+)\}\}/gi, (_, fieldName) => {
    const key = String(fieldName).trim();
    return fieldMap[key] ?? '';
  });

  result = result.replace(/\{\{([^#/}][^}]*)\}\}/g, (_, fieldName) => {
    const key = String(fieldName).trim();
    if (['Tags', 'Deck', 'Subdeck', 'Type', 'Card', 'CardFlag'].includes(key)) return '';
    return fieldMap[key] ?? '';
  });

  return result;
}

async function embedMediaInHtml(
  html: string,
  contents: JSZip,
  mediaLookup: Map<string, string>,
  mediaCache: Map<string, Promise<string | undefined>>,
  options: AnkiImportOptions,
): Promise<string> {
  let processed = html.replace(ttsPattern, '').replace(soundPattern, '');

  const imageRefs = extractMediaReferences(processed, imagePattern);
  for (const refName of imageRefs) {
    const resolved = await resolveEmbeddedMedia(contents, mediaLookup, refName, mediaCache, options);
    if (!resolved) continue;
    const escaped = refName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    processed = processed.replace(new RegExp(`(<img[^>]+src=["'])${escaped}(["'][^>]*>)`, 'gi'), `$1${resolved}$2`);
    processed = processed.replace(
      new RegExp(`(<img[^>]+src=["'])${basename(refName).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(["'][^>]*>)`, 'gi'),
      `$1${resolved}$2`,
    );
  }

  return processed;
}

async function processAnkiField(
  html: string,
  contents: JSZip,
  mediaLookup: Map<string, string>,
  mediaCache: Map<string, Promise<string | undefined>>,
  options: AnkiImportOptions,
): Promise<ProcessedField> {
  const audioRefs = extractMediaReferences(html, soundPattern);
  const imageRefs = extractMediaReferences(html, imagePattern);
  const audioUrls = await resolveMediaList(contents, mediaLookup, audioRefs, mediaCache, options);
  const imageUrls = await resolveMediaList(contents, mediaLookup, imageRefs, mediaCache, options);
  const embeddedHtml = await embedMediaInHtml(html, contents, mediaLookup, mediaCache, options);

  return {
    html: embeddedHtml,
    plainText: stripHtmlToPlainText(html),
    audioUrls,
    imageUrls,
    audioRefs,
    imageRefs,
  };
}

function isClozeContent(value: string) {
  return /{{c\d+::/i.test(value);
}

function buildBasicModel(): AnkiModel {
  return {
    id: 0,
    name: 'Basic',
    type: 0,
    flds: [
      { name: 'Front', ord: 0 },
      { name: 'Back', ord: 1 },
    ],
    tmpls: [{
      name: 'Card 1',
      ord: 0,
      qfmt: '{{Front}}',
      afmt: '{{FrontSide}}<hr id=answer>{{Back}}',
    }],
  };
}

function getTemplate(model: AnkiModel, ord: number): AnkiTemplate {
  return model.tmpls.find((template) => template.ord === ord) || model.tmpls[ord] || model.tmpls[0] || {
    name: 'Card 1',
    ord: 0,
    qfmt: '{{Front}}',
    afmt: '{{FrontSide}}<hr id=answer>{{Back}}',
  };
}

function buildExtraFields(fieldNames: string[], fieldValues: string[]): Record<string, string> | undefined {
  const extra: Record<string, string> = {};
  fieldNames.forEach((name, index) => {
    const value = fieldValues[index];
    if (value?.trim()) extra[name] = value;
  });
  return Object.keys(extra).length > 0 ? extra : undefined;
}

function buildChineseVocabCard(fieldMap: Record<string, string>) {
  return {
    front: formatChineseVocabFront(fieldMap),
    back: formatChineseVocabBack(fieldMap),
  };
}

function combineBackFields(fieldValues: string[], fieldNames: string[]): string {
  if (fieldValues.length <= 2) return fieldValues[1] || '';
  const parts = fieldValues.slice(1).filter((value) => value.trim());
  if (parts.length <= 1) return parts[0] || '';
  return parts
    .map((value, index) => {
      const label = fieldNames[index + 1];
      if (!label || label.toLowerCase() === 'back') return value;
      return `<div class="anki-extra-field"><strong>${label}</strong><br/>${value}</div>`;
    })
    .join('<hr/>');
}

/**
 * Đọc map deckId → tên deck.
 * Anki mới (schema 18) lưu deck ở BẢNG `decks` trong SQLite, tên phân cấp bằng
 * ký tự \x1f (đổi thành '::' khi hiển thị); cột col.decks khi đó là blob/ rỗng.
 * Anki cũ lưu JSON trong col.decks — vẫn hỗ trợ làm dự phòng.
 */
function readDeckNames(db: any): Map<string, string> {
  const names = new Map<string, string>();

  try {
    const res = db.exec('SELECT id, name FROM decks');
    (res[0]?.values || []).forEach((row: unknown[]) => {
      const id = String(row[0]);
      const name = String(row[1] || '').replace(/\x1f/g, '::').trim();
      if (name) names.set(id, name);
    });
  } catch {
    // Bảng decks không tồn tại ở định dạng cũ — dùng col.decks bên dưới.
  }
  if (names.size > 0) return names;

  try {
    const colRes = db.exec('SELECT decks FROM col');
    const raw = colRes[0]?.values?.[0]?.[0];
    if (typeof raw === 'string' && raw.trim().startsWith('{')) {
      const decks = JSON.parse(raw) as Record<string, any>;
      Object.keys(decks).forEach((id) => {
        const name = String(decks[id]?.name || '').trim();
        if (name) names.set(id, name);
      });
    }
  } catch {
    // Bỏ qua metadata deck lỗi — import sẽ dùng tên mặc định.
  }

  return names;
}

function readCollectionCrt(db: any): number {
  try {
    const res = db.exec('SELECT crt FROM col');
    const crt = Number(res[0]?.values?.[0]?.[0] || 0);
    return Number.isFinite(crt) && crt > 0 ? crt : 0;
  } catch {
    return 0;
  }
}

/** Đầu ngày mai theo giờ địa phương (khớp quy ước buriedUntil của scheduler). */
function getLocalTomorrowIso(now = new Date()): string {
  const tomorrow = new Date(now);
  tomorrow.setHours(24, 0, 0, 0);
  return tomorrow.toISOString();
}

interface AnkiCardRow {
  type: number;
  queue: number;
  due: number;
  ivl: number;
  factor: number;
  reps: number;
  lapses: number;
}

/**
 * Ánh xạ tiến độ học của Anki (cards.type/queue/due/ivl/factor/reps/lapses)
 * sang lịch học của app. ĐÂY LÀ ÁNH XẠ XẤP XỈ:
 * - Thẻ review (type 2): Anki lưu `due` là SỐ NGÀY kể từ ngày tạo bộ sưu tập
 *   (col.crt) nên dueDate = crt + due ngày; stability ≈ ivl (ngày, tối thiểu
 *   0.1); lastReview xấp xỉ = dueDate − ivl ngày.
 * - Thẻ learning/relearning (type 1/3): `due` là mốc epoch giây.
 * - queue -1 → suspended; queue -2/-3 (buried) → buriedUntil = đầu ngày mai.
 * - difficulty KHÔNG suy diễn ở đây: chỉ mang easeFactor = factor/1000 để
 *   normalizeCardSchedule tự suy difficulty theo quy ước sẵn có của app.
 * Thẻ mới (type 0) trả về undefined — nơi gọi dùng lịch khởi tạo mặc định.
 */
function buildImportedSchedule(row: AnkiCardRow, crt: number, now = new Date()): AnkiImportedSchedule | undefined {
  const { type, queue, due, ivl, factor, reps, lapses } = row;
  if (type === 0 && queue !== -1 && queue !== -2 && queue !== -3) return undefined;

  const nowIso = now.toISOString();
  const suspended = queue === -1;
  const buriedUntil = queue === -2 || queue === -3 ? getLocalTomorrowIso(now) : '';
  const base = {
    retrievability: 1,
    elapsedDays: 0,
    stepIndex: 0,
    lapses: Math.max(0, Math.trunc(lapses || 0)),
    reps: Math.max(0, Math.trunc(reps || 0)),
    repetitions: Math.max(0, Math.trunc(reps || 0)),
    suspended,
    buriedUntil,
    updatedAt: nowIso,
  };
  const easeFactor = factor > 0
    ? Math.round(Math.min(3, Math.max(1.3, factor / 1000)) * 100) / 100
    : undefined;

  if (type === 2) {
    const intervalDays = Math.max(0, ivl || 0);
    // Anki lưu due của thẻ review là SỐ NGÀY kể từ crt (không phải epoch giây).
    const dueDate = crt > 0
      ? new Date((crt + Math.max(0, due || 0) * 86400) * 1000)
      : new Date(now.getTime() + intervalDays * 86400000);
    const lastReview = new Date(dueDate.getTime() - intervalDays * 86400000);
    return {
      ...base,
      state: 'review',
      due: dueDate.toISOString(),
      dueDate: dueDate.toISOString(),
      nextReview: dueDate.toISOString(),
      stability: Math.max(0.1, intervalDays),
      easeFactor,
      scheduledDays: intervalDays,
      interval: intervalDays,
      lastReview: lastReview.toISOString(),
    };
  }

  // type 1 (learning) / type 3 (relearning), hoặc thẻ mới bị suspend/bury.
  const dueDate = due > 1000000000 ? new Date(due * 1000) : now;
  return {
    ...base,
    state: type === 3 ? 'relearning' : 'learning',
    due: dueDate.toISOString(),
    dueDate: dueDate.toISOString(),
    nextReview: dueDate.toISOString(),
    stability: ivl > 0 ? Math.max(0.1, ivl) : 0,
    easeFactor,
    scheduledDays: 0,
    interval: 0,
  };
}

export async function importAnkiApkg(file: File, options: AnkiImportOptions = {}): Promise<AnkiDeck[]> {
  if (file.size > MAX_APKG_BYTES) {
    throw new Error(
      `Tệp Anki quá lớn (${Math.round(file.size / (1024 * 1024))}MB). Giới hạn tối đa là ${Math.round(MAX_APKG_BYTES / (1024 * 1024))}MB — hãy tách deck nhỏ hơn rồi nhập lại.`,
    );
  }
  const importWarnings: string[] = [];
  if (file.size > LARGE_APKG_WARNING_BYTES) {
    importWarnings.push(
      `Tệp Anki khá lớn (${Math.round(file.size / (1024 * 1024))}MB) — quá trình nhập có thể chậm và tốn bộ nhớ trên thiết bị yếu.`,
    );
  }

  const zip = new JSZip();
  // Đọc qua ArrayBuffer để chạy được cả trên trình duyệt lẫn Node (test),
  // thay vì đưa thẳng File/Blob cho JSZip (Node không có FileReader).
  const contents = await zip.loadAsync(await file.arrayBuffer());
  const mediaLookup = await hydrateMediaLookup(contents);
  const mediaCache = new Map<string, Promise<string | undefined>>();
  const SQL = await initAnkiSql();
  const { db, legacyDb } = await openBestCollectionDatabase(contents, SQL);
  const models = parseModels(db, legacyDb);

  const deckMap = readDeckNames(db);
  const collectionCrt = readCollectionCrt(db);

  const res = db.exec(`
    SELECT n.id, n.flds, n.tags, n.mid, c.did, c.ord,
           c.type, c.queue, c.due, c.ivl, c.factor, c.reps, c.lapses
    FROM notes n
    JOIN cards c ON n.id = c.nid
    ORDER BY c.did, n.id, c.ord
  `);

  if (res.length === 0) {
    db.close();
    return [];
  }

  const decksResult: Record<string, AnkiCard[]> = {};
  const deckAudioStats: Record<string, MediaStats> = {};
  const deckImageStats: Record<string, MediaStats> = {};
  const deckDuplicates: Record<string, number> = {};
  const seenCardKeys = new Set<string>();

  for (const row of res[0].values as unknown[][]) {
    const noteId = String(row[0]);
    const fieldValues = String(row[1] || '').split('\x1f');
    const tags = row[2] ? String(row[2]).trim().split(/\s+/).filter(Boolean) : [];
    const modelId = Number(row[3]);
    const deckName = deckMap.get(String(row[4])) || 'Anki Import';
    const templateOrd = Number(row[5] || 0);

    // Chống trùng: bỏ qua note đã có ở đích đến (nếu nơi gọi truyền vào)
    // và các cặp noteId+ord lặp lại ngay trong cùng một file.
    const cardKey = `${noteId}:${templateOrd}`;
    if (options.existingNoteIds?.has(noteId) || seenCardKeys.has(cardKey)) {
      deckDuplicates[deckName] = (deckDuplicates[deckName] || 0) + 1;
      continue;
    }
    seenCardKeys.add(cardKey);

    const model = models.get(modelId) || buildBasicModel();
    const fieldNames = model.flds.length > 0
      ? [...model.flds].sort((a, b) => a.ord - b.ord).map((field) => field.name)
      : fieldValues.map((_, index) => (index === 0 ? 'Front' : index === 1 ? 'Back' : `Field ${index + 1}`));

    if (fieldValues.some((value) => value.includes(ANKI_UPDATE_PLACEHOLDER))) continue;

    const fieldMap = buildFieldMap(fieldNames, fieldValues);
    const template = getTemplate(model, templateOrd);
    const useChineseLayout = isChineseVocabNoteType(model.name);

    let frontRaw: string;
    let backRaw: string;

    if (useChineseLayout) {
      const chineseCard = buildChineseVocabCard(fieldMap);
      frontRaw = chineseCard.front;
      backRaw = chineseCard.back;
    } else if (models.size > 0) {
      frontRaw = renderAnkiTemplate(template.qfmt, fieldMap);
      backRaw = renderAnkiTemplate(template.afmt, fieldMap, frontRaw);
    } else if (fieldValues.length > 2) {
      frontRaw = fieldValues[0] || '';
      backRaw = combineBackFields(fieldValues, fieldNames);
    } else {
      frontRaw = fieldValues[0] || '';
      backRaw = fieldValues[1] || '';
    }

    if (!frontRaw.trim() && !backRaw.trim()) continue;

    const frontProcessed = await processAnkiField(frontRaw, contents, mediaLookup, mediaCache, options);
    const backProcessed = await processAnkiField(backRaw, contents, mediaLookup, mediaCache, options);

    // Media có thể nằm trong trường thô của note nhưng bị template/layout bỏ
    // qua khi render (ví dụ: trường "Ảnh" của notetype Chinese (Vocab) chỉ
    // chứa thẻ <img> nên bị formatChineseVocabBack loại khỏi mặt sau). Quét bổ
    // sung từ chính các trường gốc để không mất media: audio/ảnh thừa được gắn
    // vào mặt sau (mặt thông tin) của thẻ.
    const renderedAudioRefs = new Set([...frontProcessed.audioRefs, ...backProcessed.audioRefs]);
    const renderedImageRefs = new Set([...frontProcessed.imageRefs, ...backProcessed.imageRefs]);
    const rawFieldsHtml = fieldValues.join('\x1f');
    const extraAudioRefs = extractMediaReferences(rawFieldsHtml, soundPattern)
      .filter((ref) => !renderedAudioRefs.has(ref));
    const extraImageRefs = extractMediaReferences(rawFieldsHtml, imagePattern)
      .filter((ref) => !renderedImageRefs.has(ref));
    const extraAudioUrls = await resolveMediaList(contents, mediaLookup, extraAudioRefs, mediaCache, options);
    const extraImageUrls = await resolveMediaList(contents, mediaLookup, extraImageRefs, mediaCache, options);

    const backAudioUrls = [...backProcessed.audioUrls, ...extraAudioUrls];
    const backImageUrls = [...backProcessed.imageUrls, ...extraImageUrls];
    const extraImagesHtml = extraImageUrls.map((url) => `<img src="${url}">`).join('');
    const backHtml = backProcessed.html.trim()
      ? backProcessed.html + extraImagesHtml
      : (backProcessed.plainText ? backProcessed.plainText + extraImagesHtml : extraImagesHtml);

    const requestedAudio = frontProcessed.audioRefs.length + backProcessed.audioRefs.length + extraAudioRefs.length;
    const importedAudio = frontProcessed.audioUrls.length + backProcessed.audioUrls.length + extraAudioUrls.length;
    const requestedImages = frontProcessed.imageRefs.length + backProcessed.imageRefs.length + extraImageRefs.length;
    const importedImages = frontProcessed.imageUrls.length + backProcessed.imageUrls.length + extraImageUrls.length;

    const isCloze = model.type === 1 || isClozeContent(frontRaw) || isClozeContent(backRaw) || fieldValues.some(isClozeContent);

    const schedule = buildImportedSchedule({
      type: Number(row[6] || 0),
      queue: Number(row[7] || 0),
      due: Number(row[8] || 0),
      ivl: Number(row[9] || 0),
      factor: Number(row[10] || 0),
      reps: Number(row[11] || 0),
      lapses: Number(row[12] || 0),
    }, collectionCrt);

    const card: AnkiCard = {
      front: isCloze ? frontProcessed.html : (frontProcessed.html.trim() ? frontProcessed.html : frontProcessed.plainText),
      back: backHtml,
      type: isCloze ? 'cloze' : 'basic',
      noteId,
      frontImage: frontProcessed.imageUrls[0] || '',
      backImage: backImageUrls[0] || '',
      frontImages: frontProcessed.imageUrls,
      backImages: backImageUrls,
      frontAudio: frontProcessed.audioUrls,
      backAudio: backAudioUrls,
      audioUrls: [...frontProcessed.audioUrls, ...backAudioUrls],
      extraFields: buildExtraFields(fieldNames, fieldValues),
      noteType: model.name,
      tags,
      ...(schedule ? { schedule } : {}),
    };

    if (!decksResult[deckName]) decksResult[deckName] = [];
    if (!deckAudioStats[deckName]) deckAudioStats[deckName] = { imported: 0, skipped: 0 };
    if (!deckImageStats[deckName]) deckImageStats[deckName] = { imported: 0, skipped: 0 };

    deckAudioStats[deckName].imported += importedAudio;
    deckAudioStats[deckName].skipped += Math.max(0, requestedAudio - importedAudio);
    deckImageStats[deckName].imported += importedImages;
    deckImageStats[deckName].skipped += Math.max(0, requestedImages - importedImages);
    decksResult[deckName].push(card);
  }

  db.close();
  legacyDb?.close?.();

  // Deck có mọi thẻ bị bỏ qua vì trùng vẫn xuất hiện trong kết quả (0 thẻ,
  // duplicatesSkipped > 0) để nơi gọi đếm được số thẻ đã bỏ qua.
  Object.keys(deckDuplicates).forEach((name) => {
    if (!decksResult[name]) {
      decksResult[name] = [];
      deckAudioStats[name] = { imported: 0, skipped: 0 };
      deckImageStats[name] = { imported: 0, skipped: 0 };
    }
  });

  return Object.keys(decksResult).map((name) => ({
    name,
    cards: decksResult[name],
    importedAudioCount: deckAudioStats[name]?.imported || 0,
    skippedAudioCount: deckAudioStats[name]?.skipped || 0,
    importedImageCount: deckImageStats[name]?.imported || 0,
    skippedImageCount: deckImageStats[name]?.skipped || 0,
    duplicatesSkipped: deckDuplicates[name] || 0,
    ...(importWarnings.length > 0 ? { warnings: importWarnings } : {}),
  }));
}

function dataUrlToBytes(dataUrl: string): { bytes: Uint8Array; mimeType: string } | null {
  const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
  if (!match) return null;
  const mimeType = match[1];
  const binary = atob(match[2]);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return { bytes, mimeType };
}

interface ExportMediaEntry {
  zipName: string;
  originalName: string;
  bytes: Uint8Array;
}

interface CollectedExportMedia {
  entries: ExportMediaEntry[];
  byUrl: Map<string, ExportMediaEntry>;
  skipped: number;
}

const MIME_TO_EXTENSION: Record<string, string> = {
  'audio/mpeg': '.mp3',
  'audio/mp4': '.m4a',
  'audio/aac': '.aac',
  'audio/wav': '.wav',
  'audio/x-wav': '.wav',
  'audio/ogg': '.ogg',
  'audio/flac': '.flac',
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/svg+xml': '.svg',
  'video/mp4': '.mp4',
  'video/webm': '.webm',
};

function sanitizeAnkiFilename(name: string): string {
  return name.replace(/[\\/:*?"<>|#\s]+/g, '_').slice(0, 120) || 'media';
}

/**
 * Thu thập toàn bộ media của các thẻ sẽ xuất: tải bytes (data-URI hoặc URL
 * http), gán mỗi URL một tên file duy nhất trong gói .apkg và giữ map
 * URL → entry để viết lại tham chiếu trong nội dung thẻ.
 */
async function collectExportMedia(cards: AnkiCard[]): Promise<CollectedExportMedia> {
  const entries: ExportMediaEntry[] = [];
  const byUrl = new Map<string, ExportMediaEntry>();
  const usedNames = new Set<string>();
  let skipped = 0;

  const claimName = (preferred: string) => {
    let candidate = sanitizeAnkiFilename(preferred);
    if (!usedNames.has(candidate)) {
      usedNames.add(candidate);
      return candidate;
    }
    const dot = candidate.lastIndexOf('.');
    const stem = dot > 0 ? candidate.slice(0, dot) : candidate;
    const ext = dot > 0 ? candidate.slice(dot) : '';
    let counter = 2;
    while (usedNames.has(`${stem}_${counter}${ext}`)) counter += 1;
    candidate = `${stem}_${counter}${ext}`;
    usedNames.add(candidate);
    return candidate;
  };

  const register = async (url: string, preferredBase: string): Promise<ExportMediaEntry | undefined> => {
    if (!url) return undefined;
    const existing = byUrl.get(url);
    if (existing) return existing;

    let bytes: Uint8Array | undefined;
    let originalName = preferredBase;

    if (url.startsWith('data:')) {
      const parsed = dataUrlToBytes(url);
      if (!parsed) {
        skipped += 1;
        return undefined;
      }
      bytes = parsed.bytes;
      const ext = MIME_TO_EXTENSION[parsed.mimeType] || '';
      // data-URI: đuôi file phải theo mime thật, không theo tên gợi ý.
      if (ext) originalName = originalName.replace(/\.\w+$/, '') + ext;
    } else if (/^https?:\/\//i.test(url)) {
      try {
        const response = await fetch(url);
        if (!response.ok) {
          skipped += 1;
          return undefined;
        }
        bytes = new Uint8Array(await response.arrayBuffer());
        const urlName = basename(url);
        if (/\.[a-z0-9]{2,5}$/i.test(urlName)) originalName = urlName;
      } catch {
        skipped += 1;
        return undefined;
      }
    } else {
      // Tham chiếu dạng tên file thuần ([sound:x.mp3] có sẵn) — không có bytes để đóng gói.
      return undefined;
    }

    if (!bytes) return undefined;
    const entry: ExportMediaEntry = {
      zipName: String(entries.length),
      originalName: claimName(originalName),
      bytes,
    };
    entries.push(entry);
    byUrl.set(url, entry);
    return entry;
  };

  for (const [index, card] of cards.entries()) {
    const audioUrls = Array.from(new Set([...(card.frontAudio || []), ...(card.backAudio || []), ...(card.audioUrls || [])]));
    for (const [audioIndex, url] of audioUrls.entries()) {
      await register(url, `audio_${index}_${audioIndex}.mp3`);
    }

    const imageUrls = Array.from(new Set([
      ...(card.frontImages || []),
      ...(card.backImages || []),
      card.frontImage,
      card.backImage,
    ].filter(Boolean) as string[]));
    for (const [imageIndex, url] of imageUrls.entries()) {
      await register(url, `image_${index}_${imageIndex}.jpg`);
    }

    // Ảnh nhúng thẳng trong HTML của thẻ (src là data-URI/URL) cũng cần đóng gói.
    for (const html of [card.front, card.back]) {
      const embedded = extractMediaReferences(html || '', imagePattern);
      for (const [embedIndex, url] of embedded.entries()) {
        if (url.startsWith('data:') || /^https?:\/\//i.test(url)) {
          await register(url, `image_${index}_html_${embedIndex}.jpg`);
        }
      }
    }
  }

  return { entries, byUrl, skipped };
}

/**
 * Viết lại nội dung thẻ cho file xuất: media đang ở dạng URL/data-URI được
 * thay/gắn bằng tham chiếu Anki chuẩn — audio thành [sound:tên-file], ảnh
 * thành <img src="tên-file"> — trỏ tới file đã đóng gói trong .apkg.
 */
function buildExportFields(card: AnkiCard, collected: CollectedExportMedia): { front: string; back: string } {
  const replaceKnownUrls = (html: string) => {
    let out = html || '';
    Array.from(collected.byUrl.entries())
      .sort((a, b) => b[0].length - a[0].length)
      .forEach(([url, entry]) => {
        if (out.includes(url)) out = out.split(url).join(entry.originalName);
      });
    return out;
  };

  const appendMedia = (html: string, audio: string[], images: string[]) => {
    let out = html;
    audio.forEach((url) => {
      const entry = collected.byUrl.get(url);
      if (entry && !out.includes(`[sound:${entry.originalName}]`)) {
        out += `[sound:${entry.originalName}]`;
      }
    });
    images.forEach((url) => {
      const entry = collected.byUrl.get(url);
      if (entry && !out.includes(`src="${entry.originalName}"`) && !out.includes(`src='${entry.originalName}'`)) {
        out += `<img src="${entry.originalName}">`;
      }
    });
    return out;
  };

  const frontAudio = card.frontAudio || [];
  const backAudio = card.backAudio || [];
  const knownAudio = new Set([...frontAudio, ...backAudio]);
  const leftoverAudio = (card.audioUrls || []).filter((url) => !knownAudio.has(url));

  const front = appendMedia(
    replaceKnownUrls(card.front),
    frontAudio,
    [card.frontImage, ...(card.frontImages || [])].filter(Boolean) as string[],
  );
  const back = appendMedia(
    replaceKnownUrls(card.back),
    [...backAudio, ...leftoverAudio],
    [card.backImage, ...(card.backImages || [])].filter(Boolean) as string[],
  );
  return { front, back };
}

/** SHA-1 thuần TypeScript — dự phòng khi crypto.subtle không khả dụng. */
function sha1BytesPure(data: Uint8Array): Uint8Array {
  const bitLength = data.length * 8;
  const paddedLength = (((data.length + 8) >> 6) + 1) << 6;
  const buffer = new Uint8Array(paddedLength);
  buffer.set(data);
  buffer[data.length] = 0x80;
  const view = new DataView(buffer.buffer);
  view.setUint32(paddedLength - 4, bitLength >>> 0);
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 4294967296));

  let h0 = 0x67452301; let h1 = 0xefcdab89; let h2 = 0x98badcfe; let h3 = 0x10325476; let h4 = 0xc3d2e1f0;
  const w = new Int32Array(80);
  for (let chunk = 0; chunk < paddedLength; chunk += 64) {
    for (let i = 0; i < 16; i += 1) w[i] = view.getInt32(chunk + i * 4);
    for (let i = 16; i < 80; i += 1) {
      const v = w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16];
      w[i] = (v << 1) | (v >>> 31);
    }
    let a = h0; let b = h1; let c = h2; let d = h3; let e = h4;
    for (let i = 0; i < 80; i += 1) {
      let f: number; let k: number;
      if (i < 20) { f = (b & c) | (~b & d); k = 0x5a827999; }
      else if (i < 40) { f = b ^ c ^ d; k = 0x6ed9eba1; }
      else if (i < 60) { f = (b & c) | (b & d) | (c & d); k = 0x8f1bbcdc; }
      else { f = b ^ c ^ d; k = 0xca62c1d6; }
      const temp = (((a << 5) | (a >>> 27)) + f + e + k + w[i]) | 0;
      e = d; d = c; c = (b << 30) | (b >>> 2); b = a; a = temp;
    }
    h0 = (h0 + a) | 0; h1 = (h1 + b) | 0; h2 = (h2 + c) | 0; h3 = (h3 + d) | 0; h4 = (h4 + e) | 0;
  }

  const out = new Uint8Array(20);
  const outView = new DataView(out.buffer);
  [h0, h1, h2, h3, h4].forEach((h, i) => outView.setInt32(i * 4, h));
  return out;
}

async function sha1Bytes(data: Uint8Array): Promise<Uint8Array> {
  try {
    const subtle = (globalThis as any).crypto?.subtle;
    if (subtle) {
      const digest = await subtle.digest('SHA-1', data);
      return new Uint8Array(digest);
    }
  } catch {
    // Rơi xuống bản thuần TypeScript bên dưới.
  }
  return sha1BytesPure(data);
}

/**
 * csum đúng thuật toán Anki: SHA-1 của trường đầu tiên đã strip HTML,
 * lấy 4 byte đầu (big-endian) làm int32.
 */
export async function ankiChecksum(firstFieldHtml: string): Promise<number> {
  const text = stripHtmlToPlainText(firstFieldHtml);
  const digest = await sha1Bytes(new TextEncoder().encode(text));
  return new DataView(digest.buffer, digest.byteOffset, 4).getInt32(0, false);
}

export interface AnkiExportResult {
  blob: Blob;
  warnings: string[];
}

export async function exportAnkiApkgDetailed(deckName: string, cards: AnkiCard[]): Promise<AnkiExportResult> {
  const SQL = await initAnkiSql();
  const db = new SQL.Database();
  const collected = await collectExportMedia(cards);
  const mediaMap: Record<string, string> = {};
  collected.entries.forEach((entry) => {
    mediaMap[entry.zipName] = entry.originalName;
  });

  const warnings: string[] = [
    'Tiến độ học (lịch ôn tập, số lần đã học, độ khó) không được xuất sang tệp Anki — các thẻ trong tệp xuất ra sẽ ở trạng thái thẻ mới.',
  ];
  if (collected.skipped > 0) {
    warnings.push(`${collected.skipped} file media không tải được nên không được đóng gói vào tệp Anki.`);
  }

  db.run(`
    CREATE TABLE col (
      id integer primary key, crt integer not null, mod integer not null, scm integer not null,
      ver integer not null, dty integer not null, usn integer not null, ls integer not null,
      conf text not null, models text not null, decks text not null, dconf text not null, tags text not null
    );
    CREATE TABLE notes (
      id integer primary key, guid text not null, mid integer not null, mod integer not null,
      usn integer not null, tags text not null, flds text not null, sfld integer not null,
      csum integer not null, flags integer not null, data text not null
    );
    CREATE TABLE cards (
      id integer primary key, nid integer not null, did integer not null, ord integer not null,
      mod integer not null, usn integer not null, type integer not null, queue integer not null,
      due integer not null, ivl integer not null, factor integer not null, reps integer not null,
      lapses integer not null, left integer not null, odue integer not null, odid integer not null,
      flags integer not null, data text not null
    );
  `);

  const now = Math.floor(Date.now() / 1000);
  const deckId = Date.now();
  const modelId = Date.now() + 1;
  const clozeModelId = Date.now() + 2;

  const fieldDef = (name: string, ord: number) => ({
    name, ord, sticky: false, rtl: false, font: 'Arial Unicode MS', size: 20,
  });
  const models = JSON.stringify({
    [modelId]: {
      id: modelId,
      name: 'Basic',
      type: 0,
      mod: now,
      usn: -1,
      sortf: 0,
      did: deckId,
      tmpls: [{
        name: 'Card 1',
        ord: 0,
        qfmt: '{{Front}}',
        afmt: '{{FrontSide}}<hr id=answer>{{Back}}',
        did: null,
      }],
      flds: [fieldDef('Front', 0), fieldDef('Back', 1)],
      css: '.card { font-family: "Noto Sans SC", "Arial Unicode MS", sans-serif; font-size: 20px; text-align: center; color: black; background-color: white; }',
    },
    [clozeModelId]: {
      id: clozeModelId,
      name: 'Cloze',
      type: 1,
      mod: now,
      usn: -1,
      sortf: 0,
      did: deckId,
      tmpls: [{
        name: 'Cloze',
        ord: 0,
        qfmt: '{{cloze:Text}}',
        afmt: '{{cloze:Text}}<br>\n{{Back Extra}}',
        did: null,
      }],
      flds: [fieldDef('Text', 0), fieldDef('Back Extra', 1)],
      css: '.card { font-family: "Noto Sans SC", "Arial Unicode MS", sans-serif; font-size: 20px; text-align: center; color: black; background-color: white; }\n.cloze { font-weight: bold; color: blue; }',
    },
  });

  const decks = JSON.stringify({
    '1': { id: 1, name: 'Default', mod: now, usn: -1, lr: 10, conf: 1, rev: 200, new: 20, extendNew: 10, extendRev: 50 },
    [deckId]: { id: deckId, name: deckName, mod: now, usn: -1, lr: 10, conf: 1, rev: 200, new: 20, extendNew: 10, extendRev: 50 },
  });

  db.run('INSERT INTO col VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)', [
    1, now, now, now, 11, 0, 0, 0, '{}', models, decks, '{}', '{}',
  ]);

  for (const [index, card] of cards.entries()) {
    const noteId = Date.now() + index + 100;
    const cardId = Date.now() + index + 1000;
    const guid = Math.random().toString(36).substring(2, 12);
    const tags = (card.tags || []).join(' ');
    const fields = buildExportFields(card, collected);
    const isClozeCard = card.type === 'cloze' || isClozeContent(fields.front) || isClozeContent(fields.back);

    let flds: string;
    let mid: number;
    let ord = 0;
    if (isClozeCard) {
      // Model Cloze: trường 1 là Text chứa {{cN::...}}, trường 2 là Back Extra.
      flds = `${fields.front}\x1f${fields.back && fields.back !== fields.front ? fields.back : ''}`;
      mid = clozeModelId;
      const clozeMatch = fields.front.match(/\{\{c(\d+)::/i) || fields.back.match(/\{\{c(\d+)::/i);
      ord = clozeMatch ? Math.max(0, Number(clozeMatch[1]) - 1) : 0;
    } else {
      flds = `${fields.front}\x1f${fields.back}`;
      mid = modelId;
    }

    const firstField = flds.split('\x1f')[0] || '';
    const csum = await ankiChecksum(firstField);

    db.run('INSERT INTO notes VALUES (?,?,?,?,?,?,?,?,?,?,?)', [
      noteId, guid, mid, now, -1, tags, flds, stripHtmlToPlainText(firstField), csum, 0, '',
    ]);
    db.run('INSERT INTO cards VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)', [
      cardId, noteId, deckId, ord, now, -1, 0, 0, index, 0, 0, 0, 0, 0, 0, 0, 0, '',
    ]);
  }

  const binaryDb = db.export();
  const zip = new JSZip();
  zip.file('collection.anki2', binaryDb);
  zip.file('media', JSON.stringify(mediaMap));
  collected.entries.forEach((entry) => {
    zip.file(entry.zipName, entry.bytes);
  });

  const blob = await zip.generateAsync({ type: 'blob' });
  db.close();
  return { blob, warnings };
}

export async function exportAnkiApkg(deckName: string, cards: AnkiCard[]): Promise<Blob> {
  const { blob } = await exportAnkiApkgDetailed(deckName, cards);
  return blob;
}
