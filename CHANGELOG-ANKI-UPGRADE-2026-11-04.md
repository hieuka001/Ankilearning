# FIXLOG đợt 3 — AnkiLearning (cloze/reversed, browser, deck options, stats)

## Mục 1B — Hiển thị khi học cho thẻ Cloze + nhận diện thẻ đảo ngược
Phạm vi file: `src/review/cloze.ts` (tạo mới), `src/review/ReviewCard.tsx`. `src/pages/Study.tsx` chỉ kiểm tra, không cần sửa (lý do ở dưới).

### 1. `src/review/cloze.ts` — TẠO MỚI (đội model chưa kịp tạo)
Khi bắt đầu ca, file chưa tồn tại nên đã tự tạo phiên bản tối thiểu đúng hợp đồng, để đội model hợp nhất sau:
- `parseClozeText(text)` → `{ source, indexes: number[] (tăng dần, không trùng), deletions: {index, answer, hint?}[], valid }`. Cú pháp `{{cN::đáp án::gợi ý}}`; gợi ý = phần sau `::` thứ hai. Đoạn hỏng (không đóng `}}`, thiếu chỉ số) bị bỏ qua, không crash.
- `clozeToPlainText(text)` → thay mọi deletion bằng đáp án (dùng cho TTS/tìm kiếm).
- `renderClozeFront(text, index)` → HTML: deletion của `index` thành `<span class="cloze-blank ...">[gợi ý]</span>` hoặc `[...]`; deletion khác hiện đáp án.
- `renderClozeBack(text, index)` → HTML: đáp án của `index` bọc `<mark class="cloze-answer ...">` (nền emerald, chữ đậm); deletion khác hiện đáp án.
- **Assumption cần đội model biết khi hợp nhất:** render coi `clozeText` là PLAIN text — mọi đoạn chữ đều được escape HTML trước khi chèn markup của chính hàm, nên HTML nhúng trong clozeText sẽ hiện dạng chữ (an toàn, nhưng khác thẻ basic vốn giữ HTML). Đã kiểm chứng bằng script chạy thử: parse/plain/front/back đúng chuẩn Anki (kể cả nhiều chỉ số + gợi ý), text hỏng → `valid:false`, input `<script>` bị escape.

### 2. `ReviewCard.tsx` — hiển thị cloze khi học
- Thêm `clozeRenderSource(card)`: chỉ nhận thẻ khi `cardType==='cloze'` + có `clozeText` + `clozeIndex` + parse được và chỉ số nằm trong text. Ngược lại trả null.
- `contentForSide`: có nguồn cloze → mặt trước `renderClozeFront`, mặt sau `renderClozeBack`; không có → **fallback nguyên đường cũ** (front/back + xử lý cloze legacy `type==='cloze'` bằng regex như trước), không crash khi dữ liệu cloze lỗi.
- Kết quả cloze vẫn chảy qua `sanitizeReviewHtml` (DOMPurify, allowlist có sẵn `span`/`mark`/`class`) như mọi nội dung khác.
- Vì `types.ts` lúc làm chưa có `cardType`/`clozeText`/`clozeIndex` (đội model đang làm song song), ReviewCard dùng type cấu trúc cục bộ `ClozeCardFields` + ép kiểu 1 điểm — tsc vẫn xanh bất kể thứ tự hợp nhất; khi types.ts có field thật thì tương thích nguyên vẹn.
- **Chip loại thẻ:** header thẻ hiện chip nhỏ "Cloze" (cho cả model mới `cardType==='cloze'` và legacy `type==='cloze'`) hoặc "Đảo ngược" (`cardType==='reversed'`); thẻ basic không hiện.
- **TTS:** nút đọc thẻ dùng `speakTextForSide` — thẻ cloze model mới đọc `clozeToPlainText(clozeText)`; thẻ cloze legacy đọc `clozeToPlainText(front/back)` theo mặt; không còn đọc ký tự `{{}}`. Thẻ thường giữ nguyên.

### 3. `Study.tsx` — kiểm tra, KHÔNG sửa
- Hàng đợi: `buildStudyQueues`/`sortCardsForStudy` (src/scheduler/queue.ts) chỉ lọc theo lịch (suspended/buried/due) và giới hạn ngày — không lọc theo `front` rỗng hay loại thẻ; đường "ôn tất cả" trong Study cũng chỉ lọc suspended/buried. Thẻ cloze/đảo ngược (thẻ vật lý thường) đi qua bình thường.
- Xem trước khoảng (rating previews): tính từ scheduler trên thẻ hiện tại, không phụ thuộc loại thẻ → hoạt động như thẻ thường.
- Study không chạm trực tiếp `card.front`/`card.back` ở bất cứ đâu (hiển thị + chọn text TTS đều nằm trong ReviewCard) → không cần đổi gì.
- Lưu ý ngoài phạm vi: `applySiblingBury` dùng `siblingKey` — nếu đội model gán siblingKey theo note cho các thẻ cloze anh em, chúng sẽ chôn nhau theo cấu hình burySiblings (đúng chuẩn Anki), không phải lỗi.

### Kiểm chứng
- Script chạy thử cloze.ts: 8 trường hợp (parse 2 chỉ số + gợi ý, plain, front/back từng chỉ số, text hỏng, XSS, rỗng) — đúng hết.
- `npx tsc --noEmit`: sạch (0 lỗi, kể cả file đội song song tại thời điểm chạy).
- `npm test`: 42/42 pass.

## Mục 1A — Model + tạo thẻ cho loại ghi chú kiểu Anki (Cloze + Đảo ngược)
Phạm vi file: `src/types.ts`, `src/review/cloze.ts` (bổ sung, không thay thế), `src/lib/noteCards.ts` (mới), `src/components/CardTypeFields.tsx` (mới), `src/pages/CreateDeck.tsx`, `src/pages/DeckDetail.tsx` (chỉ dialog Thêm thẻ), `src/services/ankiService.ts`, `tests/cloze.test.ts` (mới), `tests/ankiImport.test.ts` (+3 test).

### 1. Hợp đồng dữ liệu trên Flashcard (`src/types.ts`)
Thêm `cardType?: 'basic' | 'reversed' | 'cloze'`, `clozeText?: string`, `clozeIndex?: number`. `noteId?: string` đã có sẵn từ trước — dùng chung cho các thẻ cùng ghi chú. Thẻ cũ không có `cardType` được hiểu là 'basic'. Field cũ `type?: 'basic' | 'cloze'` giữ nguyên và được ghi đồng bộ khi tạo thẻ mới.

### 2. `src/review/cloze.ts` — HỢP NHẤT với bản đội hiển thị (1B), không ghi đè
Đội hiển thị đã tạo file trước với chữ ký: `parseClozeText(text) → ParsedClozeText { source, indexes, deletions, valid }` (KHÔNG phải mảng số), `clozeToPlainText(text)`, `renderClozeFront/Back(text, index) → HTML` (đã escape, đáp án bọc `<mark class="cloze-answer ...">`, chỗ trống là `<span class="cloze-blank ...">[...]</span>`/`[gợi ý]`). Giữ nguyên toàn bộ; chỉ BỔ SUNG 3 hàm cho phía tạo thẻ:
- `validateClozeText(text): string[]` — lỗi tiếng Việt rõ ràng (trống, chưa đóng `}}`, thiếu `::`, chỉ số không phải số, c0, đáp án trống, cloze lồng, chưa có đoạn cloze nào); rỗng = hợp lệ.
- `getNextClozeIndex(text): number` — chỉ số tự tăng cho nút đánh dấu.
- `wrapSelectionAsCloze(text, start, end): string | null` — bọc vùng chọn thành `{{cN::...}}`.
Lưu ý: gợi ý = phần sau `::` đầu tiên bên trong deletion (khớp bản 1B và Anki). `clozeText` theo giả định của 1B là PLAIN text + markup — phía import/tạo thẻ tuân thủ đúng giả định này.

### 3. `src/lib/noteCards.ts` (mới) — mở rộng ghi chú thành thẻ vật lý
- `buildNoteCards(draft: NoteDraft): BuiltNoteCard[]` — basic: 1 thẻ; reversed: 2 thẻ cùng `noteId` (gốc + hoán đổi front↔back); cloze: 1 thẻ cho mỗi chỉ số phân biệt, cùng `noteId`, mang `clozeText` gốc + `clozeIndex`, front/back = `clozeToPlainText(clozeText)`.
- Kèm `createNoteId()`, `emptyNoteDraft()`, `isNoteDraftComplete()`, `isNoteDraftTouched()`, `countBuiltCards()`.

### 4. `src/components/CardTypeFields.tsx` (mới) — UI dùng chung
Bộ chọn 3 loại (Cơ bản / Đảo ngược / Cloze) + ô nhập tương ứng. Chế độ Cloze: một ô văn bản + nút "Đánh dấu cloze" (bọc vùng bôi đen, N tự tăng, `onMouseDown preventDefault` để không mất vùng chọn) + dòng xem trước "Sẽ tạo N thẻ (c1, c2...)" + danh sách lỗi validate trực tiếp. CreateDeck và dialog Thêm thẻ của DeckDetail cùng dùng component này.

### 5. CreateDeck.tsx
- Mỗi hàng thẻ có bộ chọn loại; đảo ngược lưu thành 2 thẻ, cloze lưu thành N thẻ (cardCount của deck = tổng thẻ vật lý). Ô link ảnh giữ nguyên, áp cho mọi thẻ vật lý của ghi chú.
- Cloze soạn dở (có nội dung, cú pháp sai) → toast lỗi cụ thể từ validateClozeText, không lưu thầm.
- Nháp localStorage: lưu/khôi phục thêm `cardType` + `clozeText` (nháp cũ thiếu field → mặc định basic). Các bộ lọc khi AI/URL thêm thẻ cũng giữ lại hàng cloze đang soạn.
- Badge số lượng ở tiêu đề "Danh sách thẻ" nay đếm tổng thẻ vật lý sẽ tạo.

### 6. DeckDetail.tsx — chỉ dialog Thêm thẻ
- Thêm bộ chọn loại (CardTypeFields) + hai ô link ảnh tách riêng; `handleAddCard` validate theo loại, ghi nhiều doc vào `decks/{id}/cards` (mỗi doc kèm type/cardType và — chỉ khi có — noteId/clozeText/clozeIndex vì Firestore không nhận undefined), `cardCount` tăng theo số thẻ vật lý. Nút "Thêm thẻ" bật/tắt theo loại.

### 7. ankiService.ts — import/export
- `AnkiCard` thêm `cardType?`, `clozeText?`, `clozeIndex?`.
- Import model Cloze thật (`model.type === 1`) có trường chứa `{{cN::`: mỗi dòng thẻ Anki → 1 thẻ `cardType='cloze'`, `clozeIndex = ord + 1`, `clozeText` = trường Text gốc qua `clozeFieldToPlainText()` (bỏ thẻ HTML + [sound:]/[anki:tts], giữ nguyên markup cloze — đúng giả định plain-text của đội hiển thị), front/back = `clozeToPlainText(clozeText)`. Lịch học từng dòng giữ nguyên như trước. Model không phải Cloze thật nhưng nội dung có cloze: giữ nguyên hành vi legacy (chỉ `type='cloze'`, không gắn clozeText).
- Import model đảo ngược: heuristic `isReversedModel()` — tên model chứa 'reverse'/'reversed' HOẶC dạng bắt chéo chặt 2 trường/2 template. Sau vòng lặp, note nào sinh đủ đúng 2 thẻ mới được gắn `cardType='reversed'` cho cả hai; thiếu một chiều → giữ basic.
- Export: thẻ có `cardType='cloze'` + `clozeText` → xuất qua model Cloze với trường Text = `clozeText`, `ord = clozeIndex - 1` (Back Extra chỉ ghi khi mặt sau còn mang media đã đóng gói). Thẻ cloze legacy (type='cloze' hoặc nội dung chứa markup, không có clozeText) đi đường cũ nguyên vẹn.

### 8. Test
- `tests/cloze.test.ts` (mới, 12 test): parse (nhiều chỉ số, trùng chỉ số, gợi ý), plain text, render front (che đúng chỉ số, gợi ý, escape HTML), render back (<mark>), validate từng loại lỗi, getNextClozeIndex, wrapSelectionAsCloze.
- `tests/ankiImport.test.ts` (+3 test): import model Cloze tổng hợp (2 chỉ số → 2 thẻ đúng hợp đồng), import model đảo ngược (cặp đủ 2 chiều = reversed, thẻ đơn = basic), export thẻ cloze hợp đồng (Text = clozeText, ord = clozeIndex - 1).
- Kết quả: `npx tsc --noEmit` sạch; `npm test` 57/57 đạt (42 cũ + 12 cloze + 3 anki).

### ⚠️ Việc nối còn thiếu NGOÀI phạm vi 1A (cần đội/parent xử lý)
1. `src/pages/Decks.tsx` (ánh xạ lưu import, ~dòng 177-200): payload addDoc chưa chép `cardType`/`clozeText`/`clozeIndex` từ AnkiCard → thẻ cloze/reversed nhập từ .apkg sẽ MẤT các field hợp đồng khi lưu vào Firestore. Cần bổ sung 3 field (kèm `type: card.type || 'basic'` đã có sẵn).
2. `src/pages/DeckDetail.tsx` `handleExportAnki` (~dòng 556): ánh xạ Flashcard → AnkiCard chưa truyền `cardType`/`clozeText`/`clozeIndex` → export từ app chưa dùng được nhánh cloze hợp đồng (ankiService đã sẵn sàng nhận). Cần thêm 3 field vào object ánh xạ.

## Mục 2A — DeckDetail thành Card Browser kiểu Anki
Phạm vi file: CHỈ `src/pages/DeckDetail.tsx`. Nền có sẵn từ vòng trước: phân trang 50/trang (`visibleCardCount`), tìm kiếm + lọc (Tất cả/Đến hạn/Thẻ khó/Đã tạm dừng), stats `useMemo`, hàng thẻ `DeckCardRow` đã `React.memo`, ConfirmDialog cho xoá.

### 1. Sắp xếp danh sách thẻ
- Thêm state `cardSort` + ô `<select>` gọn cạnh ô tìm kiếm/bộ lọc, 5 kiểu: Ngày tạo (mặc định — giữ nguyên thứ tự snapshot), Hạn ôn (due tăng dần), Độ ổn định (stability tăng dần), Số lần quên (lapses giảm dần), Mặt trước (A–Z, `localeCompare` locale 'vi').
- `sortedCards` (useMemo) áp trên danh sách ĐÃ lọc, trước phân trang. Để tránh normalize trong comparator: decorate một lần mỗi thẻ (`dueTime`/`stability` từ `normalizeCardSchedule`, `lapses` từ thẻ) rồi sort trên số đã tính. Đổi sắp xếp cũng reset phân trang về trang 1 (thêm vào effect reset hiện có cùng `cardSearch`/`cardFilter`).

### 2. Chọn nhiều + thao tác hàng loạt
- Lựa chọn giữ ở state cấp trang `selectedCardIds: Set<string>` → giữ nguyên qua phân trang/tìm kiếm/lọc; tự dọn khi đổi deck (trong effect nạp deck). `selectedCards` = giao của Set với danh sách thẻ trực tiếp nên id của thẻ đã bị xoá/chuyển đi nơi khác tự rơi khỏi mọi thao tác.
- `DeckCardRow` nhận thêm props memo-safe: `selected: boolean`, `onToggleSelect(cardId)` (useCallback ổn định), `onPreview(card)`. Checkbox native (`accent-emerald-600`, không có ui/checkbox trong repo) ở đầu hàng, chỉ hiện với chủ deck; hàng được chọn có ring emerald. Nút "Chọn tất cả đang hiển thị (N)" chọn đúng lát đang render; thanh hành động nổi khi có chọn, kèm số đếm và nút Bỏ chọn.
- Mọi ghi dùng `writeBatch` qua helper `commitCardChunks(items, opsPerItem, apply)`: chia lô ≤450 op/batch (giới hạn Firestore 500), commit tuần tự, toast tổng kết số thẻ thành công; lỗi giữa chừng → toast lỗi nói rõ một số thẻ có thể đã xử lý (danh sách tự đồng bộ qua onSnapshot), lựa chọn chỉ dọn khi thành công toàn phần.
  - **Tạm dừng / Bỏ tạm dừng**: bám đúng quy ước của `handleToggleSuspendCard` hiện tại — bỏ tạm dừng ghi `{ suspended: false, buriedUntil: '' }`; tạm dừng chỉ ghi `{ suspended: true }` (không đụng buriedUntil).
  - **Gắn tag**: dialog nhập tag; chỉ ghi các thẻ chưa có tag đó (`tags: [...tags, tag]`), mọi thẻ đã có → toast info và đóng dialog.
  - **Chuyển deck**: dialog tải các deck khác của user (`getDocs(query(decks, where('ownerId','==',uid)))`, loại deck hiện tại). Chuyển = `batch.set` doc ở deck đích với **cùng card id** + dữ liệu nguyên trạng (bỏ field `id`, lọc `undefined`, ghi đè `deckId` đích) + `batch.delete` doc nguồn trong cùng batch (2 op/thẻ → lô 225 thẻ). Sau đó cập nhật `cardCount` hai phía bằng `increment(∓n)` — đúng cách thêm/xoá thẻ đang duy trì.
  - **Xoá**: qua ConfirmDialog (thêm kind `'cards-bulk'`, tiêu đề/mô tả kèm số lượng), batch xoá + `cardCount: increment(-n)`.
- Trạng thái `isBulkProcessing` khoá mọi nút thao tác trong lúc ghi, có spinner trên thanh hành động.

### 3. Xem trước thẻ — QUYẾT ĐỊNH: mở rộng dialog Sửa thẻ hiện có, không thêm dialog mới
- Lý do chọn: file đã có dialog sửa thẻ (`editingCard`) với đầy đủ hai mặt + ảnh + tuỳ chỉnh giao diện; thêm dialog xem trước riêng sẽ trùng lặp phần lớn. Bấm vào hàng thẻ (guard `closest('button, a, input, select, textarea, label')` để không cướp click của nút/checkbox/audio trong hàng) → mở chính dialog đó; các nút Sửa/Hoãn/Tạm dừng/Xoá giữ nguyên hành vi.
- Bổ sung trong dialog: (a) khối **Xem trước thẻ** render mặt trước/sau — dùng đường hiển thị hiện có của file là ReactMarkdown (cùng cách hàng thẻ render). Lưu ý: `sanitizeReviewHtml` của `review/ReviewCard` là hàm nội bộ module, KHÔNG export, nên không import được mà không sửa file ngoài phạm vi — đã chọn ReactMarkdown theo đúng gợi ý dự phòng trong nhiệm vụ ("đường hiển thị hiện có trong file"). (b) panel **thông tin lịch** từ `normalizeCardSchedule(editingCard)`: trạng thái (kể cả Đã tạm dừng/Hoãn hôm nay), hạn ôn (dd/MM/yyyy HH:mm), độ ổn định (ngày, 1 chữ số thập phân), số lần quên (lapses), lượt ôn (reps). Dialog thêm `max-h-[90vh] overflow-y-auto` vì nội dung dài hơn.

### Kiểm chứng
- `npx tsc --noEmit`: sạch (0 lỗi).
- `npm test`: 57/57 đạt.
- Tính năng cũ giữ nguyên: tìm kiếm/lọc/thêm thẻ (3 loại ghi chú)/xuất .apkg/mindmap/xoá từng thẻ — chỉ thay nguồn render danh sách từ `filteredCards.slice(...)` sang `visibleCards` (lát của `sortedCards`).

## Mục 2B — Deck cha con theo tên 'Cha::Con' + học gộp cả nhánh

### 1. `src/lib/deckAnalytics.ts` — helper cây deck + gộp stats (thuần, không đọc Firestore)
- `buildDeckTree<T extends {id, name}>(decks)`: dựng cây từ tên tách theo '::'. Node gồm `{ name (đường đầy đủ), segment (đoạn cuối), deck | null, children, descendantIds, descendantDecks }`. Cha ẢO (`deck: null`) khi chỉ tồn tại deck con dưới một tiền tố mà không deck nào mang đúng tên đó (vd chỉ có 'A::B', 'A::C'). Cấp cha cao nhất giữ thứ tự xuất hiện đầu tiên của input (Decks truyền danh sách mới-nhất-trước ⇒ nhánh nổi lên theo deck mới nhất trong nhánh); con sắp theo tên (`localeCompare 'vi'`). Hai deck trùng hệt tên: deck thứ hai thành root riêng để không deck nào biến mất khỏi danh sách. Không có '::' ⇒ rừng phẳng y hệt input.
- `aggregateDeckStats(statsById, deckIds)`: cộng learned/mastered/due của cả nhánh từ map stats sẵn có, `lastStudied` lấy giá trị mới nhất. Không phát sinh lượt đọc Firestore nào ngoài luồng stats cache chữ ký hiện hữu.

### 2. `src/pages/Decks.tsx` — gom nhóm hiển thị
- Khi KHÔNG tìm kiếm: danh sách dựng qua `buildDeckTree(filteredDecks)` rồi làm phẳng theo trạng thái mở/đóng. Deck có con hiển thị dạng hàng cha: nút chevron mở/đóng (trạng thái thu gọn lưu trong `collapsedNodes`, mặc định mở), số liệu GỘP cả nhánh (stats qua `aggregateDeckStats` trên `descendantIds`, tổng thẻ = tổng `cardCount` các deck con cháu), dòng chú thích "Bộ cha · số liệu gộp N bộ thẻ trong nhánh", và nút riêng "Học deck cha · gộp cả nhánh".
- Cha ảo hiển thị thẻ nhóm riêng (viền đứt nét, icon FolderTree, chips Đã học/Đến hạn/Tổng gộp, nút Học deck cha) — không phải Link vì không có deck thật để mở chi tiết.
- Deck con thụt vào theo depth (`marginLeft` tối đa 3 cấp × 16px), tiêu đề rút còn đoạn cuối + breadcrumb đường cha phía trên ('Chinese › Từ vựng').
- Khi có từ khoá tìm kiếm: hiển thị PHẲNG các deck khớp như cũ (không gom nhóm) để kết quả không bị giấu dưới cha đang đóng. Lọc theo tag giữ nguyên, cây dựng trên tập đã lọc.
- Nút "Học deck cha" điều hướng `/study/<id deck cha, hoặc deck con đầu tiên nếu cha ảo>?decks=<toàn bộ descendantIds>`, dùng navigate + preventDefault/stopPropagation vì nằm trong Link của thẻ cha.

### 3. `src/pages/Study.tsx` — học gộp deck cha qua `?decks=`
- Parse param `decks` (dedupe, luôn chèn route deckId lên đầu nếu thiếu). Không có param ⇒ `studyDeckIds = [deckId]`, hành vi y hệt cũ.
- Loader: tải deck doc + cards + progress của MỌI deck trong danh sách bằng Promise.all lồng nhau; gộp thẻ thành một tập cho `buildStudyQueues`/`sortCardsForStudy`; giới hạn ngày (introducedToday/reviewedToday) tính trên TỔNG gộp; cache Dexie kiểm tra chữ ký và ghi theo TỪNG deck; fallback ngoại tuyến đọc cache của từng deck rồi gộp. Tiêu đề phiên (deck state) = tiền tố đường '::' chung dài nhất của cả nhánh (vd 'Chinese'), màn hình "không còn thẻ đến hạn" hiển thị tên cha này.
- ĐƯỜNG LƯU THEO TỪNG THẺ (đã kiểm chứng): thẻ mang `deckId` của deck nguồn ngay từ loader (`card.deckId || <id deck vừa tải>`). `handleRate` truyền `deckId: currentCard.deckId` vào `enqueueReviewSync` — flush trong firebaseSync ghi vào `decks/<record.deckId>/cards/<cardId>` + subcollection reviews đúng deck gốc (trước đây truyền deckId của route, chỉ đúng khi học đơn). `sourceDeckOwnerId`/`isOwnerReview` ưu tiên `currentCard.ownerId`. `handleUndo` dùng `restored.deckId` cho cả 4 nơi: upsertCachedCard, queueRecordId (khớp công thức queueId của firebaseSync), updateDoc/deleteDoc đường owner, và progressDocId + thân doc progress. `saveControlUpdate` (bury/suspend) dùng `card.deckId` cho cache + Firestore + progress. Doc phiên học ở `finishSession` giữ deckId route và thêm field `deckIds` khi học gộp.
- Nút đóng phiên (ReviewCard onClose) và nút quay lại ở màn hình hết hạn: học gộp về `/decks`, học đơn về chi tiết deck như cũ.

### Kiểm chứng
- Test mới `tests/deckTree.test.ts`: 5 test cho buildDeckTree (rừng phẳng, nhánh 3 cấp, cha ảo, thứ tự/sắp xếp) + aggregateDeckStats (cộng dồn, lastStudied mới nhất, id thiếu).
- `npx tsc --noEmit` sạch; `npm test` 62/62 đạt (57 cũ + 5 mới).
- Không đổi hành vi khi không có deck cha con và khi không có param `decks` (đường đơn deck dùng cùng code path với danh sách 1 phần tử).

## Mục 3A — Cấu hình riêng từng deck (deck options ghi đè cấu hình chung)

### Thiết kế
- `src/types.ts`: thêm `DeckOptions { newCardsPerDay?, reviewsPerDay?, desiredRetention?, leechThreshold? }` và `Deck.options?: DeckOptions`. Field vắng mặt = kế thừa cấu hình chung.
- File mới `src/lib/deckOptions.ts`:
  - `resolveDeckSchedulerConfig(globalConfig, deck)`: merge kiểu "chỉ ghi đè khi khác `undefined`" (QUAN TRỌNG: nếu spread cả undefined lên trên giá trị chung, normalizeSchedulerConfig sẽ rơi về mặc định tích hợp chứ không về giá trị chung). `0` là ghi đè hợp lệ (normalize hiện tại giữ 0 cho giới hạn ngày và ngưỡng leech). Kết quả luôn qua `normalizeSchedulerConfig` như cấu hình chung ở mọi nơi khác, nên deck không có options cho ra đúng cấu hình chung đã normalize — hành vi không đổi.
  - `resolveDeckDailyLimits(globalConfig, deck)`: trả { newCardsPerDay, reviewsPerDay } hiệu lực, suy từ resolveDeckSchedulerConfig.

### DeckDetail — dialog "Tuỳ chọn deck"
- Nút icon SlidersHorizontal cạnh nút sửa deck/xuất/xoá (chỉ chủ deck). Dialog gồm 4 trường; mỗi ô để trống = kế thừa, kèm dòng chú thích "Kế thừa cấu hình chung: <giá trị>" (desiredRetention hiển thị % như Settings). Nút "Đặt lại kế thừa" xoá trắng cả 4 ô.
- Lưu bằng updateDoc: ghi object `options` sạch chỉ chứa field có giá trị (desiredRetention lưu dạng phân số percent/100, việc clamp 0.7–0.98 để normalize lo khi resolve, giống luồng Settings); khi cả 4 ô trống thì `options: deleteField()` để deck kế thừa hoàn toàn.
- Bộ lọc/thống kê "Thẻ khó" đổi từ ngưỡng chung sang ngưỡng hiệu lực của deck này: `resolveDeckSchedulerConfig(settings.scheduler, deck).leechThreshold`.

### Study — áp cấu hình hiệu lực
- Loader lưu bản đồ deck của phiên (`sessionDecksById`).
- Học MỘT deck: hàng đợi (gồm giới hạn ngày, vốn đọc từ newCardsPerDay/reviewsPerDay trong chính config truyền vào buildStudyQueues) chạy trên cấu hình hiệu lực của deck đó; xem trước khoảng + chấm điểm cũng vậy.
- Học GỘP (?decks=): giới hạn ngày GIỮ cấu hình chung (buildStudyQueues nhận cấu hình chung như cũ), nhưng xem trước + chấm từng thẻ resolve theo deck chứa thẻ đó — khả thi an toàn vì đường render sẵn tính theo currentCard: cấu hình truyền vào useScheduler được resolve từ deck của currentCard (sessionDecksById), nên preview/rate/leech của từng thẻ dùng đúng tuỳ chọn deck của nó mà không đổi kiến trúc hàng đợi.
- Fallback ngoại tuyến: deck doc không nằm trong cache thẻ nên không resolve được options — phiên offline dùng cấu hình chung như trước (bản đồ deck được dọn rỗng ở đường này).

### Kiểm chứng
- Test mới `tests/deckOptions.test.ts`: 9 test (kế thừa khi không có options/deck, ghi đè từng phần, ghi đè cả 4 field, 0 là giá trị hợp lệ phân biệt với undefined, field undefined tường minh không xoá giá trị chung, clamp qua normalize, resolveDeckDailyLimits).
- `npx tsc --noEmit`: 0 lỗi trong các file của mục 3A (types.ts, deckOptions.ts, Study.tsx, DeckDetail.tsx). Toàn repo còn 2 lỗi ở Dashboard.tsx thuộc tính năng thống kê độ chín thẻ của đội song song đang làm dở, không liên quan mục này.
- `npm test`: 83/83 đạt (gồm 9 test mới của mục này).

## Mục 3B — Thống kê chuyên sâu kiểu Anki trên Dashboard

### Khảo sát nguồn dữ liệu THẬT (trước khi xây)
- **Bản ghi ôn trên Firestore:** `src/review/firebaseSync.ts` (`applyRecord`) ghi MỖI lượt ôn trong CÙNG một batch nguyên tử vào hai nơi có cùng payload `ReviewLog`: (1) doc log riêng `decks/{deckId}/cards/{cardId}/reviews/{historyEntry.id}` và (2) `reviewHistory: arrayUnion(historyEntry)` trên chính doc thẻ. Với deck của người khác, lịch sử ghi vào `users/{uid}/cardProgress/{deckId}__{cardId}` (cũng `reviewHistory` arrayUnion). Rules cho chủ deck đọc `reviews/**`, chủ tài khoản đọc `cardProgress/**` — cả hai nguồn đều đọc hợp lệ.
- **`ReviewLog` có đủ field cần thiết:** `rating` ('again'|'hard'|'good'|'easy'), `reviewTime` (ISO), `previousState`/`newState` ('new'|'learning'|'review'|'relearning'), stability/difficulty/interval trước–sau. Nhờ `previousState` nên tính được true retention đúng định nghĩa Anki (chỉ lượt ôn trên thẻ đã ở trạng thái review).
- **Field lịch trên thẻ:** `state`, `stability` (ngày), `suspended`, `reps`/`repetitions` — đủ cho phân loại độ chín.
- **Quyết định nguồn cho thống kê ôn:** dùng mảng `reviewHistory` trên doc thẻ + doc cardProgress (payload y hệt doc ở `reviews/{logId}` vì cùng một batch ghi) để tái sử dụng cache thẻ sẵn có — KHÔNG cần N+1 query vào subcollection `reviews` cho từng thẻ. Giới hạn trung thực: chỉ các lượt ôn đã flush thành công mới có mặt (lượt còn pending trong outbox Dexie của chính thiết bị chưa lên Firestore thì chưa tính); thẻ học deck người khác chỉ tính khi doc cardProgress đã đồng bộ.
- **Vì sao KHÔNG dùng localDB (Dexie) làm nguồn chính:** bản ghi 'synced' trong `reviewResults` bị `pruneSyncedRecords()` xoá sau 7 ngày (chỉ còn cửa sổ ~7 ngày + pending) và chỉ tồn tại trên thiết bị đã học. Nguồn Firestore có cửa sổ đầy đủ → giữ cửa sổ 30 ngày như thiết kế, không cần hạ xuống 7 ngày.

### 1. `src/lib/deepStats.ts` (mới) — hàm thuần
- `classifyCardMaturity`/`computeCardMaturity`: Mới (state 'new') / Đang học ('learning'|'relearning') / Non (review, stability < 21) / Chín (review, stability ≥ 21) / Tạm dừng (`suspended` thắng mọi trạng thái). Thẻ legacy thiếu `state`: đã từng ôn (reps/repetitions > 0) thì xếp như thẻ review theo stability, chưa ôn thì là Mới. Thẻ review thiếu `stability` coi như 0 → Non (không suy diễn).
- `collectReviewLogs`: gộp `reviewHistory` từ nhiều doc (thẻ + cardProgress), loại bản ghi rating lạ/thời gian không parse được.
- `computeTrueRetention` (cửa sổ 30 ngày theo ngày lịch địa phương): mẫu số = lượt ôn có `previousState === 'review'`; tử số = trong đó rating ≠ 'again'. Không có mẫu → `rate: null` (UI báo "chưa đủ dữ liệu", tuyệt đối không hiển thị 0%/100% giả).
- `buildReviewsByDay`: đủ 30 điểm ngày (ngày trống = 0), cũ → mới.
- `computeRatingDistribution`: đếm 4 nút trong cùng cửa sổ 30 ngày (mọi trạng thái trước ôn).
- `summarizeReviewLogs`: gộp ba thống kê dùng chung một cửa sổ.

### 2. `src/pages/Dashboard.tsx` — mục "Thống kê chuyên sâu" (thu gọn mặc định)
- Nút "Xem chi tiết/Thu gọn" ở cuối Dashboard; **chỉ khi mở lần đầu mới tải dữ liệu** (Dashboard mặc định không đổi chi phí): query deck của user → thẻ qua `fetchDeckCardsCached` (cache theo chữ ký của deckAnalytics, deck đã đọc cho số liệu đầu trang thì không tốn lượt đọc mới) → thêm 1 query `users/{uid}/cardProgress` (lỗi ở query này không làm sập cả mục). Có nút "Tải lại", trạng thái đang tải / lỗi + thử lại / chưa có thẻ / chưa đủ dữ liệu hiển thị riêng, trung thực.
- Trình bày: thanh xếp chồng + chú giải độ chín (số thẻ + %), thẻ tỷ lệ nhớ thật (số % kèm mẫu số rõ ràng + ghi chú định nghĩa), phân bố 4 nút chấm (thanh + %), biểu đồ cột lượt ôn 30 ngày.
- Không sửa bất kỳ mục hiện có nào của Dashboard.

### 3. `src/components/charts/DeepStatsChart.tsx` (mới, file cộng thêm ngoài danh sách sở hữu)
- Lý do: DashboardChart hiện hữu là AreaChart và được lazy-load để recharts không vào chunk chính; biểu đồ cột cho thống kê sâu cần component riêng theo đúng mẫu đó (đo kích thước bằng ResizeObserver như DashboardChart) và được `lazy()` từ Dashboard — build xác nhận chunk riêng 2,35 KB, chỉ tải khi mở mục thống kê sâu. Không sửa file chart cũ.

### Kiểm chứng
- Test mới `tests/deepStats.test.ts`: 12 test (phân loại độ chín gồm biên stability = 21, thẻ legacy, tạm dừng thắng; lọc bản ghi hỏng; true retention gồm biên cửa sổ 30 ngày và trường hợp rate null; lượt ôn theo ngày; phân bố nút; summarize).
- `npx tsc --noEmit` sạch; `npm test` 83/83 đạt (gồm 12 test mới); `npm run build` thành công, DeepStatsChart tách chunk lazy riêng.

## Mục 4 — Tối ưu tham số FSRS cá nhân từ lịch sử ôn (nút "Optimize" kiểu Anki)

### Thiết kế tổng thể
Chuỗi dữ liệu: `reviewHistory` (ReviewLog ghi nguyên tử theo từng lượt ôn) trên doc thẻ → `buildReviewSequences` → replay qua ts-fsrs với bộ trọng số ứng viên → log-loss → coordinate descent → `settings.scheduler.fsrsWeights` → scheduler dùng khi xếp lịch. Khi `fsrsWeights` vắng mặt, hành vi y nguyên như trước (test cũ pass nguyên vẹn, có test khoá riêng).

### 1. Cấu hình: `src/models/fsrs.ts` + `src/scheduler/fsrsScheduler.ts`
- `SchedulerConfig` thêm `fsrsWeights?: number[]`, `fsrsOptimizedAt?: string`, `fsrsOptimizationSamples?: number` (hai field provenance chỉ được normalize giữ khi đi kèm bộ trọng số hợp lệ). `SchedulerConfigInput` kế thừa tự động qua `Partial<Omit<...>>`.
- FSRS-6 của ts-fsrs dùng đúng **21 trọng số** (`FSRS6_DEFAULT_WEIGHTS`, kiểm chứng trực tiếp từ `generatorParameters()` của thư viện) — xuất `DEFAULT_FSRS_WEIGHTS`, `FSRS_WEIGHT_COUNT`, `FSRS_WEIGHT_BOUNDS` từ scheduler, re-export qua `lib/spacedRepetition`.
- **Khoảng kẹp đã chọn** (trong `clampFsrsWeights`): mảng sai độ dài (≠21) hoặc có phần tử không hữu hạn → **bỏ toàn bộ field** (về mặc định). Từng trọng số còn lại được kẹp vào cửa sổ `[max(boundThưViệnDưới, mặc định×0,2), min(boundThưViệnTrên, max(mặc định×3, mặc định+0,05))]` — tức cửa sổ nhân quanh mặc định giao với bound tuyệt đối FSRS-6 mà chính ts-fsrs ép (`clipFSRS6Parameters`: w0–w3 ≤100, w4 ∈[1,10], w20 ∈[0,1;0,8]…). Slack tuyệt đối `+0,05` để mặc định gần 0 (w[7]=0,001) không bị ghim vào cửa sổ vô dụng. Cửa sổ này hẹp hơn bound thư viện có chủ đích: bộ trọng số fit sai chỉ cá nhân hoá được lịch ôn, không đẩy tham số tới góc cực đoan của mô hình.
- `toFsrsParameters` truyền `w: [...config.fsrsWeights]` khi có; vắng mặt → không truyền (mặc định của ts-fsrs). Cấu hình theo deck (deckOptions, đợt 3A) tự kế thừa trọng số toàn cục qua merge + normalize như cũ.

### 2. `src/lib/fsrsOptimizer.ts` (mới) — hàm thuần, không phụ thuộc UI
- `buildReviewSequences(cards)`: gom `reviewHistory` từng thẻ thành chuỗi (rating + reviewTime) đã sắp theo thời gian; loại entry rating lạ/thời gian không parse được; loại chuỗi <2 lượt (0 mẫu dự đoán).
- `evaluateWeights(sequences, weights)`: replay từng chuỗi bằng engine ts-fsrs dựng **giống hệt scheduler thật** (retention, bước học/học lại, short-term bật) chỉ khác: fuzz TẮT (deterministic) và `w` là ứng viên. Trước mỗi lượt ôn (trừ lượt đầu của thẻ) lấy `engine.retrievability` làm xác suất nhớ dự đoán; kết quả thật: Again = quên, còn lại = nhớ; điểm = log-loss trung bình/mẫu (xác suất kẹp [0,001; 0,999] để một lần đoán chắc mà sai không thành vô cực).
- `optimizeWeights(sequences, baseWeights)`: greedy coordinate descent trên cả 21 trọng số — mỗi vòng, mỗi trọng số thử ×hệ số trước, không cải thiện mới thử ÷hệ số (first-improvement), chỉ giữ thay đổi làm giảm log-loss; hệ số bậc thang 1,3 → 1,12 → 1,05; dừng sớm khi một vòng cải thiện < 0,0002. Ứng viên luôn kẹp trong `FSRS_WEIGHT_BOUNDS` nên kết quả optimizer = đúng thứ normalize sẽ giữ khi lưu. Hỗ trợ `yieldBetweenRounds` + `isCancelled` để UI không đơ và huỷ được.
- **Giới hạn tính toán đã chọn**: tối thiểu **400 mẫu dự đoán** (đúng ngưỡng Anki) — dưới ngưỡng trả trạng thái riêng `insufficient-data` kèm số mẫu thật; dữ liệu cắt ở **20.000 lượt ôn gần nhất** (`limitReviewSequences`). Đo thật bằng dữ liệu giả lập ts-fsrs: 1.106 mẫu → tối ưu 0,54s; 5.257 mẫu → 2,5s (Node; trình duyệt tương đương) — đạt mục tiêu "vài giây với ~5.000 lượt ôn".
- Kết quả kiểm chứng giả lập (bộ trọng số "thật" khác mặc định: stability đầu ×0,3, decay 0,1542→0,34…): log-loss mặc định **0,3154** → tối ưu **0,3038**; bộ thật đạt 0,2999 (optimizer thu hẹp phần lớn khoảng cách mà không cần khôi phục đúng từng trọng số).

### 3. `tests/fsrsOptimizer.test.ts` (mới) — 7 test, ~1,1s
Sinh lịch sử bằng chính ts-fsrs + PRNG có seed (deterministic) với bộ trọng số thật khác mặc định, khẳng định: log-loss sau tối ưu < trước − 0,005 (đạt −0,0116); bộ thật chấm tốt hơn mặc định rõ rệt; `evaluateWeights` deterministic + đếm mẫu đúng; `buildReviewSequences` lọc đúng bản ghi hỏng và sắp xếp; `insufficient-data` dưới 400 mẫu; normalize giữ/bỏ/kẹp `fsrsWeights` đúng hợp đồng; scheduler thật sự xếp lịch bằng trọng số cá nhân (thẻ mới Good → stability = w[2] tuỳ chỉnh = 5 thay vì 2,3065).

### 4. `src/pages/Settings.tsx` — mục "Tối ưu tham số FSRS (cá nhân hoá)" trong phần thuật toán
- Số liệu ôn chỉ tải khi bấm **"Kiểm tra dữ liệu ôn"** (không tải sẵn): quét deck sở hữu qua `fetchDeckCardsCached` (cache theo chữ ký, đường rẻ nhất) + doc `users/{uid}/cardProgress` (lượt ôn deck người khác cũng là dữ liệu nhớ của chính user); hiện X lượt ôn · Y mẫu dự đoán và báo trung thực khi chưa đủ 400.
- **"Tối ưu hoá từ lịch sử ôn của tôi"**: chạy bất đồng bộ, nhường UI giữa các vòng (`setTimeout 0`), có nút **Huỷ**; bắt đầu từ bộ trọng số đang dùng (mặc định hoặc cá nhân hiện tại). Kết quả hiện log-loss trước → sau + số mẫu.
- **"Áp dụng bộ tham số này"** gắn vào override chờ lưu — đi qua đúng nút **Lưu cấu hình** + chỉ báo "Có thay đổi chưa lưu" hiện hữu (indicator ở đầu mục nay tính cả thay đổi FSRS); **"Đặt lại tham số mặc định"** xoá `fsrsWeights` cùng cơ chế chờ lưu. Khi đã có trọng số cá nhân: hiện "Đang dùng tham số cá nhân hoá (tối ưu ngày …) trên … mẫu dự đoán" từ `fsrsOptimizedAt`/`fsrsOptimizationSamples`.

### Kiểm chứng
- `npx tsc --noEmit` sạch.
- `npm test` **90/90 đạt** (83 cũ nguyên vẹn + 7 mới), tổng ~10s.
- Ngoài phạm vi được giao nên không đụng: `lib/deckAnalytics`/Study/DeckDetail/Dashboard không đổi; helper hiển thị `calculateRetrievability` ở intervalCalculator vẫn dùng decay mặc định cho mục đích hiển thị (engine xếp lịch thật dùng decay theo w[20] của bộ trọng số đang áp).

## Tích hợp (parent)
- Đợt 1: nối 2 điểm cuối — Decks.tsx lưu cardType/clozeText/clozeIndex khi nhập .apkg; DeckDetail handleExportAnki truyền đủ 3 field + noteId sang ankiService.
- Đợt 4: calculateRetrievability (hiển thị) nay nhận decay từ fsrsWeights[20] khi có tham số cá nhân (trước dùng decay mặc định; engine xếp lịch đã dùng đúng từ đầu).
- Kiểm chứng cuối: tsc sạch, 90/90 test (57 gốc vòng 2 → +12 cloze, +3 anki, +5 deckTree, +9 deckOptions, +12 deepStats... tổng hợp các đợt), build OK, entry ~382KB.
