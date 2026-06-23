import JSZip from 'jszip';
import initSqlJs from 'sql.js';
import { decompress } from 'fzstd';
import {
  formatChineseVocabBack,
  formatChineseVocabFront,
  isChineseVocabNoteType,
} from '../lib/chineseCardLayout';

const SQL_WASM_URL = 'https://sql.js.org/dist/sql-wasm.wasm';

const DEFAULT_INLINE_MAX_BYTES = 256 * 1024;
const ANKI_COLLECTION_CANDIDATES = ['collection.anki21b', 'collection.anki21', 'collection.anki2'];
const ANKI_UPDATE_PLACEHOLDER = 'Please update to the latest Anki version';
const soundPattern = /\[sound:([^\]]+)\]/gi;
const ttsPattern = /\[anki:tts[^\]]*\]/gi;
const imagePattern = /<img[^>]+src=["']([^"']+)["'][^>]*>/gi;
const SQLITE_MAGIC = new TextEncoder().encode('SQLite format 3\u0000');

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
}

export interface AnkiDeck {
  name: string;
  cards: AnkiCard[];
  importedAudioCount?: number;
  skippedAudioCount?: number;
  importedImageCount?: number;
  skippedImageCount?: number;
}

export interface AnkiImportOptions {
  inlineMaxBytes?: number;
  onLargeMedia?: (filename: string, data: Uint8Array, mimeType: string) => Promise<string | undefined>;
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

async function hydrateMediaLookup(contents: JSZip) {
  const lookup = new Map<string, string>();
  const addAlias = (sourceName: string, zipName: string) => {
    const normalized = normalizeMediaName(sourceName);
    [sourceName, normalized, basename(normalized)].filter(Boolean).forEach((alias) => lookup.set(alias, zipName));
  };

  const mediaFile = contents.file('media');
  if (mediaFile) {
    try {
      const mediaMap = JSON.parse(await mediaFile.async('text')) as Record<string, string>;
      Object.entries(mediaMap).forEach(([zipName, originalName]) => {
        addAlias(originalName, zipName);
        addAlias(zipName, zipName);
      });
    } catch {
      // Decks can still be imported through direct zip filenames.
    }
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

export async function importAnkiApkg(file: File, options: AnkiImportOptions = {}): Promise<AnkiDeck[]> {
  const zip = new JSZip();
  const contents = await zip.loadAsync(file);
  const mediaLookup = await hydrateMediaLookup(contents);
  const mediaCache = new Map<string, Promise<string | undefined>>();
  const SQL = await initSqlJs({ locateFile: () => SQL_WASM_URL });
  const { db, legacyDb } = await openBestCollectionDatabase(contents, SQL);
  const models = parseModels(db, legacyDb);

  const deckMap: Record<string, string> = {};
  const colRes = db.exec('SELECT decks FROM col');
  if (colRes.length > 0) {
    try {
      const decks = JSON.parse(colRes[0].values[0][0] as string);
      Object.keys(decks).forEach((id) => {
        deckMap[id] = decks[id].name;
      });
    } catch {
      // Ignore malformed deck metadata.
    }
  }

  const res = db.exec(`
    SELECT n.id, n.flds, n.tags, n.mid, c.did, c.ord
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

  for (const row of res[0].values as unknown[][]) {
    const noteId = String(row[0]);
    const fieldValues = String(row[1] || '').split('\x1f');
    const tags = row[2] ? String(row[2]).trim().split(/\s+/).filter(Boolean) : [];
    const modelId = Number(row[3]);
    const deckName = deckMap[String(row[4])] || 'Anki Import';
    const templateOrd = Number(row[5] || 0);

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

    const requestedAudio = frontProcessed.audioRefs.length + backProcessed.audioRefs.length;
    const importedAudio = frontProcessed.audioUrls.length + backProcessed.audioUrls.length;
    const requestedImages = frontProcessed.imageRefs.length + backProcessed.imageRefs.length;
    const importedImages = frontProcessed.imageUrls.length + backProcessed.imageUrls.length;

    const isCloze = model.type === 1 || isClozeContent(frontRaw) || isClozeContent(backRaw) || fieldValues.some(isClozeContent);

    const card: AnkiCard = {
      front: isCloze ? frontProcessed.html : (frontProcessed.html.trim() ? frontProcessed.html : frontProcessed.plainText),
      back: backProcessed.html.trim() ? backProcessed.html : backProcessed.plainText,
      type: isCloze ? 'cloze' : 'basic',
      noteId,
      frontImage: frontProcessed.imageUrls[0] || '',
      backImage: backProcessed.imageUrls[0] || '',
      frontImages: frontProcessed.imageUrls,
      backImages: backProcessed.imageUrls,
      frontAudio: frontProcessed.audioUrls,
      backAudio: backProcessed.audioUrls,
      audioUrls: [...frontProcessed.audioUrls, ...backProcessed.audioUrls],
      extraFields: buildExtraFields(fieldNames, fieldValues),
      noteType: model.name,
      tags,
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

  return Object.keys(decksResult).map((name) => ({
    name,
    cards: decksResult[name],
    importedAudioCount: deckAudioStats[name]?.imported || 0,
    skippedAudioCount: deckAudioStats[name]?.skipped || 0,
    importedImageCount: deckImageStats[name]?.imported || 0,
    skippedImageCount: deckImageStats[name]?.skipped || 0,
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

async function collectExportMedia(cards: AnkiCard[]): Promise<ExportMediaEntry[]> {
  const entries: ExportMediaEntry[] = [];
  let mediaIndex = 0;

  const addUrl = async (url: string, preferredName: string) => {
    if (!url) return undefined;
    let bytes: Uint8Array | undefined;
    let originalName = preferredName;

    if (url.startsWith('data:')) {
      const parsed = dataUrlToBytes(url);
      if (!parsed) return undefined;
      bytes = parsed.bytes;
      if (parsed.mimeType.includes('audio')) originalName = preferredName.replace(/\.\w+$/, '.mp3') || `${preferredName}.mp3`;
    } else if (/^https?:\/\//i.test(url)) {
      try {
        const response = await fetch(url);
        if (!response.ok) return undefined;
        bytes = new Uint8Array(await response.arrayBuffer());
      } catch {
        return undefined;
      }
    }

    if (!bytes) return undefined;
    mediaIndex += 1;
    const zipName = String(mediaIndex);
    entries.push({ zipName, originalName, bytes });
    return { zipName, originalName };
  };

  for (const [index, card] of cards.entries()) {
    const audioUrls = Array.from(new Set([...(card.frontAudio || []), ...(card.backAudio || []), ...(card.audioUrls || [])]));
    for (const [audioIndex, url] of audioUrls.entries()) {
      await addUrl(url, `audio_${index}_${audioIndex}.mp3`);
    }

    const imageUrls = Array.from(new Set([
      ...(card.frontImages || []),
      ...(card.backImages || []),
      card.frontImage,
      card.backImage,
    ].filter(Boolean) as string[]));

    for (const [imageIndex, url] of imageUrls.entries()) {
      await addUrl(url, `image_${index}_${imageIndex}.jpg`);
    }
  }

  return entries;
}

export async function exportAnkiApkg(deckName: string, cards: AnkiCard[]): Promise<Blob> {
  const SQL = await initSqlJs({ locateFile: () => SQL_WASM_URL });
  const db = new SQL.Database();
  const mediaEntries = await collectExportMedia(cards);
  const mediaMap: Record<string, string> = {};
  mediaEntries.forEach((entry) => {
    mediaMap[entry.zipName] = entry.originalName;
  });

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
      flds: [
        { name: 'Front', ord: 0, sticky: false, rtl: false, font: 'Arial Unicode MS', size: 20 },
        { name: 'Back', ord: 1, sticky: false, rtl: false, font: 'Arial Unicode MS', size: 20 },
      ],
      css: '.card { font-family: "Noto Sans SC", "Arial Unicode MS", sans-serif; font-size: 20px; text-align: center; color: black; background-color: white; }',
    },
  });

  const decks = JSON.stringify({
    '1': { id: 1, name: 'Default', mod: now, usn: -1, lr: 10, conf: 1, rev: 200, new: 20, extendNew: 10, extendRev: 50 },
    [deckId]: { id: deckId, name: deckName, mod: now, usn: -1, lr: 10, conf: 1, rev: 200, new: 20, extendNew: 10, extendRev: 50 },
  });

  db.run('INSERT INTO col VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)', [
    1, now, now, now, 11, 0, 0, 0, '{}', models, decks, '{}', '{}',
  ]);

  cards.forEach((card, index) => {
    const noteId = Date.now() + index + 100;
    const cardId = Date.now() + index + 1000;
    const guid = Math.random().toString(36).substring(2, 10);
    const tags = (card.tags || []).join(' ');
    const flds = `${card.front}\x1f${card.back}`;

    db.run('INSERT INTO notes VALUES (?,?,?,?,?,?,?,?,?,?,?)', [
      noteId, guid, modelId, now, -1, tags, flds, stripHtmlToPlainText(card.front).slice(0, 80), 0, 0, '',
    ]);
    db.run('INSERT INTO cards VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)', [
      cardId, noteId, deckId, 0, now, -1, 0, 0, index, 0, 0, 0, 0, 0, 0, 0, 0, '',
    ]);
  });

  const binaryDb = db.export();
  const zip = new JSZip();
  zip.file('collection.anki2', binaryDb);
  zip.file('media', JSON.stringify(mediaMap));
  mediaEntries.forEach((entry) => {
    zip.file(entry.zipName, entry.bytes);
  });

  const blob = await zip.generateAsync({ type: 'blob' });
  db.close();
  return blob;
}
