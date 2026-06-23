import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { importAnkiApkg } from '../src/services/ankiService.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const buffer = fs.readFileSync(path.resolve(__dirname, '../Chinese.apkg'));
const file = new File([buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength)], 'Chinese.apkg', {
  type: 'application/octet-stream',
});

const decks = await importAnkiApkg(file);
const deck = decks[0];
const sample = deck.cards.find((card) => card.extraFields?.Hanzi === '人') || deck.cards[0];

console.log('Deck:', deck.name, 'cards:', deck.cards.length);
console.log('Note type:', sample.noteType);
console.log('Front:\n', sample.front);
console.log('\nBack:\n', sample.back.slice(0, 1500));
console.log('\nBack audio:', sample.backAudio?.length || 0);
