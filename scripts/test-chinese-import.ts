import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import JSZip from 'jszip';
import { importAnkiApkg, resolveMediaMap } from '../src/services/ankiService.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const apkgPath = path.resolve(__dirname, '../Chinese.apkg');
const buffer = fs.readFileSync(apkgPath);
const file = new File([buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength)], 'Chinese.apkg', {
  type: 'application/octet-stream',
});

// Media map (schema 18: protobuf nén zstd)
const zip = await JSZip.loadAsync(buffer);
const mediaData = await zip.file('media')!.async('uint8array');
const mediaMap = resolveMediaMap(mediaData);
console.log('Media map entries:', mediaMap.size);
console.log('Media sample:', Array.from(mediaMap.values()).slice(0, 3).join(', '));

const decks = await importAnkiApkg(file);
console.log('\nDecks:', decks.map((deck) => `${deck.name} (${deck.cards.length} thẻ)`).join(' | '));

const totalCards = decks.reduce((sum, deck) => sum + deck.cards.length, 0);
const totalAudio = decks.reduce((sum, deck) => sum + (deck.importedAudioCount || 0), 0);
const totalImages = decks.reduce((sum, deck) => sum + (deck.importedImageCount || 0), 0);
const totalSkipped = decks.reduce((sum, deck) => sum + (deck.skippedAudioCount || 0) + (deck.skippedImageCount || 0), 0);
console.log(`Tổng: ${totalCards} thẻ, ${totalAudio} audio, ${totalImages} ảnh đã resolve, ${totalSkipped} media bị bỏ qua`);

const deck = decks[0];
const sample = deck.cards.find((card) => card.extraFields?.Hanzi === '人') || deck.cards[0];

console.log('\nDeck:', deck.name, 'cards:', deck.cards.length);
console.log('Note type:', sample.noteType);
console.log('Front:\n', sample.front);
console.log('\nBack:\n', sample.back.slice(0, 1500));
console.log('\nBack audio:', sample.backAudio?.length || 0);
console.log('Schedule (thẻ mới trong Anki sẽ không có):', sample.schedule ?? 'không có — đúng kỳ vọng');
