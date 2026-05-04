import JSZip from 'jszip';
import initSqlJs from 'sql.js';

// We'll use a CDN for the wasm file to keep things simple in this environment
const SQL_WASM_URL = 'https://sql.js.org/dist/sql-wasm.wasm';

export interface AnkiCard {
  front: string;
  back: string;
  frontImage?: string;
  backImage?: string;
  tags?: string[];
}

function cleanAnkiHtml(html: string): string {
  if (!html) return '';
  let text = html.replace(/{{c\d+::autocloze}}/g, '').replace(/{{c\d+::(.*?)(::.*?)?}}/g, '$1')
    .replace(/<img.*?src=["'](.*?)["'].*?>/gi, '![]($1)')
    .replace(/<(br|div|p)\s*\/?>/gi, '\n').replace(/<\/(div|p)>/gi, '\n')
    .replace(/<[^>]*>/g, '').replace(/\[sound:.*?\]/g, '');
  const entities: any = { '&nbsp;': ' ', '&lt;': '<', '&gt;': '>', '&amp;': '&', '&quot;': '"', '&apos;': "'" };
  return text.replace(/&[a-z]+;/gi, (m) => entities[m] || m).replace(/\n\s*\n/g, '\n\n').trim();
}

export interface AnkiDeck {
  name: string;
  cards: AnkiCard[];
}

export async function importAnkiApkg(file: File): Promise<AnkiDeck[]> {
  const zip = new JSZip();
  const contents = await zip.loadAsync(file);
  const dbFile = contents.file('collection.anki21') || contents.file('collection.anki2');
  if (!dbFile) throw new Error('Không tìm thấy tệp dữ liệu Anki');
  
  const dbData = await dbFile.async('uint8array');
  const SQL = await initSqlJs({ locateFile: () => SQL_WASM_URL });
  const db = new SQL.Database(dbData);
  
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
  
  const decksResult: any = {};
  res[0].values.forEach((row: any) => {
    const fields = (row[0] as string).split('\x1f');
    const deckName = deckMap[String(row[2])] || "Anki Import";
    const card: AnkiCard = {
      front: cleanAnkiHtml(fields[0] || ''),
      back: cleanAnkiHtml(fields[1] || ''),
      tags: row[1] ? (row[1] as string).trim().split(' ') : []
    };
    if (!decksResult[deckName]) decksResult[deckName] = [];
    decksResult[deckName].push(card);
  });
  
  db.close();
  return Object.keys(decksResult).map(name => ({ name, cards: decksResult[name] }));
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
