import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import JSZip from 'jszip';
import initSqlJs from 'sql.js';
import { decompress } from 'fzstd';
import { formatChineseVocabFront, formatChineseVocabBack } from '../src/lib/chineseCardLayout.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const wasmPath = path.resolve(__dirname, '../node_modules/sql.js/dist/sql-wasm.wasm');
const zip = await JSZip.loadAsync(fs.readFileSync(path.resolve(__dirname, '../Chinese.apkg')));
let data = await zip.file('collection.anki21b').async('uint8array');
const magic = new TextEncoder().encode('SQLite format 3\u0000');
if (!magic.every((byte, index) => data[index] === byte)) data = decompress(data);
const SQL = await initSqlJs({ locateFile: () => wasmPath });
const db = new SQL.Database(data);

const fieldsRes = db.exec('SELECT ord, name FROM fields WHERE ntid = 1760788509452 ORDER BY ord');
const fieldNames = fieldsRes[0].values.map((row) => String(row[1]));
const noteRes = db.exec("SELECT flds FROM notes WHERE flds LIKE '人%' LIMIT 1");
const fieldValues = String(noteRes[0].values[0][0]).split('\x1f');
const fieldMap = Object.fromEntries(fieldNames.map((name, index) => [name, fieldValues[index] || '']));

console.log('FRONT:\n', formatChineseVocabFront(fieldMap));
console.log('\nBACK:\n', formatChineseVocabBack(fieldMap).slice(0, 1800));
db.close();
