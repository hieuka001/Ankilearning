import JSZip from 'jszip';
import initSqlJs from 'sql.js';

// We'll use a CDN for the wasm file to keep things simple in this environment
const SQL_WASM_URL = 'https://sql.js.org/dist/sql-wasm.wasm';

export interface AnkiCard {
  front: string;
  back: string;
  frontImage?: string;
  backImage?: string;
  frontAudio?: string[];
  backAudio?: string[];
  audioUrls?: string[];
  tags?: string[];
}

const MAX_EMBEDDED_MEDIA_BYTES = 512 * 1024;
const ANKI_COLLECTION_CANDIDATES = ['collection.anki21b', 'collection.anki21', 'collection.anki2'];
const ANKI_UPDATE_PLACEHOLDER = 'Please update to the latest Anki version';
const soundPattern = /\[sound:([^\]]+)\]/gi;
const imagePattern = /<img[^>]+src=["']([^"']+)["'][^>]*>/gi;

function decodeHtmlEntities(value: string): string {
  const entities: Record<string, string> = { '&nbsp;': ' ', '&lt;': '<', '&gt;': '>', '&amp;': '&', '&quot;': '"', '&apos;': "'" };
  return value.replace(/&[a-z]+;/gi, (m) => entities[m] || m);
}

function cleanAnkiHtml(html: string): string {
  if (!html) return '';
  let text = html.replace(/{{c\d+::autocloze}}/g, '').replace(/{{c\d+::(.*?)(::.*?)?}}/g, '$1')
    .replace(/<img.*?src=["'](.*?)["'].*?>/gi, '![]($1)')
    .replace(/<(br|div|p)\s*\/?>/gi, '\n').replace(/<\/(div|p)>/gi, '\n')
    .replace(/<[^>]*>/g, '').replace(/\[sound:.*?\]/g, '');
  return decodeHtmlEntities(text).replace(/\n\s*\n/g, '\n\n').trim();
}

export interface AnkiDeck {
  name: string;
  cards: AnkiCard[];
  importedAudioCount?: number;
  skippedAudioCount?: number;
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
  if (/\.webm$/.test(clean)) return 'audio/webm';
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
) {
  const normalized = normalizeMediaName(filename);
  const zipPath = mediaLookup.get(normalized) || mediaLookup.get(basename(normalized)) || normalized;
  if (mediaCache.has(zipPath)) return mediaCache.get(zipPath)!;

  const promise = (async () => {
    const file = contents.file(zipPath) || contents.file(normalized) || contents.file(basename(normalized));
    if (!file) return undefined;

    const data = await file.async('uint8array');
    if (data.byteLength > MAX_EMBEDDED_MEDIA_BYTES) return undefined;

    const base64 = await file.async('base64');
    return `data:${getMimeType(normalized)};base64,${base64}`;
  })();

  mediaCache.set(zipPath, promise);
  return promise;
}

async function resolveMediaList(
  contents: JSZip,
  mediaLookup: Map<string, string>,
  filenames: string[],
  mediaCache: Map<string, Promise<string | undefined>>,
) {
  const resolved = await Promise.all(
    filenames.map((filename) => resolveEmbeddedMedia(contents, mediaLookup, filename, mediaCache))
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

  let fallbackDb: any;
  let fallbackName = '';

  for (const candidate of candidates) {
    try {
      const dbData = await candidate.file.async('uint8array');
      const db = new SQL.Database(dbData);
      const cardCheck = db.exec("SELECT n.flds FROM notes n JOIN cards c ON n.id = c.nid LIMIT 25");
      const fields = cardCheck[0]?.values?.map((row: unknown[]) => String(row[0] || '')) || [];
      const hasRealCards = fields.some((field: string) => field.trim() && !field.includes(ANKI_UPDATE_PLACEHOLDER));

      if (hasRealCards) {
        fallbackDb?.close();
        return db;
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
    throw new Error(`File APKG này chỉ có ${candidateNames || fallbackName} và không chứa dữ liệu thẻ thật, chỉ có thẻ cảnh báo của Anki. Hãy mở file bằng Anki bản mới nhất rồi export lại deck ở định dạng APKG có dữ liệu đầy đủ.`);
  }

  throw new Error('Không đọc được dữ liệu trong tệp Anki');
}

export async function importAnkiApkg(file: File): Promise<AnkiDeck[]> {
  const zip = new JSZip();
  const contents = await zip.loadAsync(file);
  const mediaLookup = await hydrateMediaLookup(contents);
  const mediaCache = new Map<string, Promise<string | undefined>>();
  const SQL = await initSqlJs({ locateFile: () => SQL_WASM_URL });
  const db = await openBestCollectionDatabase(contents, SQL);
  
  let deckMap: any = {};
  const colRes = db.exec("SELECT decks FROM col");
  if (colRes.length > 0) {
    try {
      const decks = JSON.parse(colRes[0].values[0][0] as string);
      Object.keys(decks).forEach(id => deckMap[id] = decks[id].name);
    } catch {}
  }

  const res = db.exec("SELECT DISTINCT n.flds, n.tags, c.did FROM notes n JOIN cards c ON n.id = c.nid");
  if (res.length === 0) { db.close(); return []; }
  
  const decksResult: Record<string, AnkiCard[]> = {};
  const deckAudioStats: Record<string, { imported: number; skipped: number }> = {};

  for (const row of res[0].values as any[]) {
    const fields = (row[0] as string).split('\x1f');
    const deckName = deckMap[String(row[2])] || "Anki Import";
    const frontRaw = fields[0] || '';
    const backRaw = fields[1] || '';
    if (frontRaw.includes(ANKI_UPDATE_PLACEHOLDER) || backRaw.includes(ANKI_UPDATE_PLACEHOLDER)) continue;
    const frontAudioRefs = extractMediaReferences(frontRaw, soundPattern);
    const backAudioRefs = extractMediaReferences(backRaw, soundPattern);
    const frontImageRefs = extractMediaReferences(frontRaw, imagePattern);
    const backImageRefs = extractMediaReferences(backRaw, imagePattern);
    const frontAudio = await resolveMediaList(contents, mediaLookup, frontAudioRefs, mediaCache);
    const backAudio = await resolveMediaList(contents, mediaLookup, backAudioRefs, mediaCache);
    const frontImages = await resolveMediaList(contents, mediaLookup, frontImageRefs, mediaCache);
    const backImages = await resolveMediaList(contents, mediaLookup, backImageRefs, mediaCache);
    const requestedAudio = frontAudioRefs.length + backAudioRefs.length;
    const importedAudio = frontAudio.length + backAudio.length;

    const card: AnkiCard = {
      front: cleanAnkiHtml(frontRaw),
      back: cleanAnkiHtml(backRaw),
      frontImage: frontImages[0] || '',
      backImage: backImages[0] || '',
      frontAudio,
      backAudio,
      audioUrls: [...frontAudio, ...backAudio],
      tags: row[1] ? (row[1] as string).trim().split(' ') : []
    };
    if (!decksResult[deckName]) decksResult[deckName] = [];
    if (!deckAudioStats[deckName]) deckAudioStats[deckName] = { imported: 0, skipped: 0 };
    deckAudioStats[deckName].imported += importedAudio;
    deckAudioStats[deckName].skipped += Math.max(0, requestedAudio - importedAudio);
    decksResult[deckName].push(card);
  }
  
  db.close();
  return Object.keys(decksResult).map(name => ({
    name,
    cards: decksResult[name],
    importedAudioCount: deckAudioStats[name]?.imported || 0,
    skippedAudioCount: deckAudioStats[name]?.skipped || 0,
  }));
}

export async function exportAnkiApkg(deckName: string, cards: AnkiCard[]): Promise<Blob> {
  const SQL = await initSqlJs({
    locateFile: () => SQL_WASM_URL
  });
  
  const db = new SQL.Database();
  
  // Basic Anki 2.0 schema (simplified for export)
  db.run(`
    CREATE TABLE col (
      id              integer primary key,
      crt             integer not null,
      mod             integer not null,
      scm             integer not null,
      ver             integer not null,
      dty             integer not null,
      usn             integer not null,
      ls              integer not null,
      conf            text not null,
      models          text not null,
      decks           text not null,
      dconf           text not null,
      tags            text not null
    );
    CREATE TABLE notes (
      id              integer primary key,
      guid            text not null,
      mid             integer not null,
      mod             integer not null,
      usn             integer not null,
      tags            text not null,
      flds            text not null,
      sfld            integer not null,
      csum            integer not null,
      flags           integer not null,
      data            text not null
    );
    CREATE TABLE cards (
      id              integer primary key,
      nid             integer not null,
      did             integer not null,
      ord             integer not null,
      mod             integer not null,
      usn             integer not null,
      type            integer not null,
      queue           integer not null,
      due             integer not null,
      ivl             integer not null,
      factor          integer not null,
      reps            integer not null,
      lapses          integer not null,
      left            integer not null,
      odue            integer not null,
      odid            integer not null,
      flags           integer not null,
      data            text not null
    );
  `);

  const now = Math.floor(Date.now() / 1000);
  const deckId = Date.now();
  const modelId = Date.now() + 1;

  // Insert basic collection info
  const models = JSON.stringify({
    [modelId]: {
      id: modelId,
      name: "Basic",
      type: 0,
      mod: now,
      usn: -1,
      sortf: 0,
      did: deckId,
      tmpls: [{
        name: "Card 1",
        ord: 0,
        qfmt: "{{Front}}",
        afmt: "{{FrontSide}}<hr id=answer>{{Back}}",
        did: null
      }],
      flds: [
        { name: "Front", ord: 0, sticky: false, rtl: false, font: "Times New Roman", size: 20 },
        { name: "Back", ord: 1, sticky: false, rtl: false, font: "Times New Roman", size: 20 }
      ],
      css: ".card {\n font-family: 'Times New Roman', Times, serif;\n font-size: 20px;\n text-align: center;\n color: black;\n background-color: white;\n}\n"
    }
  });

  const decks = JSON.stringify({
    "1": { id: 1, name: "Default", mod: now, usn: -1, lr: 10, conf: 1, rev: 200, new: 20, extendNew: 10, extendRev: 50 },
    [deckId]: { id: deckId, name: deckName, mod: now, usn: -1, lr: 10, conf: 1, rev: 200, new: 20, extendNew: 10, extendRev: 50 }
  });

  db.run("INSERT INTO col VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)", [
    1, now, now, now, 11, 0, 0, 0, "{}", models, decks, "{}", "{}"
  ]);

  // Insert cards and notes
  cards.forEach((card, index) => {
    const noteId = Date.now() + index + 100;
    const cardId = Date.now() + index + 1000;
    const guid = Math.random().toString(36).substring(2, 10);
    const flds = `${card.front}\x1f${card.back}`;
    const tags = (card.tags || []).join(' ');

    db.run("INSERT INTO notes VALUES (?,?,?,?,?,?,?,?,?,?,?)", [
      noteId, guid, modelId, now, -1, tags, flds, card.front, 0, 0, ""
    ]);
    db.run("INSERT INTO cards VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", [
      cardId, noteId, deckId, 0, now, -1, 0, 0, index, 0, 0, 0, 0, 0, 0, 0, 0, ""
    ]);
  });

  const binaryDb = db.export();
  const zip = new JSZip();
  zip.file('collection.anki2', binaryDb);
  zip.file('media', '{}');
  
  const blob = await zip.generateAsync({ type: 'blob' });
  db.close();
  return blob;
}
