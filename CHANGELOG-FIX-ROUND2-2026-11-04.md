# FIXLOG vòng 2 — AnkiLearning (2026-11-04)

Nguồn phát hiện: `findings2-correctness.md` (23 mục: 1 CAO, 6 TRUNG, 16 THẤP).
File này ghi phần **A — lõi dữ liệu / đồng bộ / an toàn** (các phần khác do các nhóm song song phụ trách).

---

## A. Lõi dữ liệu / đồng bộ / an toàn

### A1. [C1 — CAO] ReviewCard: thay sanitizer tự chế bằng DOMPurify
- `src/review/ReviewCard.tsx`: xóa toàn bộ sanitizer DOMParser tự chế (~140 dòng: allowlist tag/attr + regex scheme — hở bypass `java<TAB>script:` và mXSS svg/math) và code `allowedTags`/`allowedAttributes`.
- `sanitizeReviewHtml` giữ nguyên chữ ký/giao diện (caller không đổi): vẫn tiền xử lý markdown-image → HTML như cũ, sau đó `DOMPurify.sanitize()` với allowlist tương đương bản cũ (thẻ học tập: b/i/u/sub/sup/br/div/span/p/img/audio/source/bảng/rub/mark…; attr: src/alt/href/class/colspan/rowspan/controls…), cuối cùng một lượt DOM nhẹ trên HTML **đã sạch** để giữ hành vi trình bày cũ (link `target=_blank rel=noopener noreferrer`; img `loading=lazy decoding=async referrerpolicy=no-referrer data-review-image=true`).
- `dompurify` vốn đã có trong dependencies (trước đây 0 import) — nay được dùng thật.

### A2. [T1 — TRUNG] Dead-letter chỉ tính lỗi vĩnh viễn
- `src/review/localDB.ts`: thêm `isTransientSyncError(error)` — phân loại theo `error.code` (unavailable, deadline-exceeded, aborted, cancelled, unknown, internal, resource-exhausted, auth/network-request-failed, auth/id-token-expired, auth/user-token-expired…) + heuristic message (offline/network/timeout…) + `navigator.onLine === false` ⇒ tạm thời. Các code vĩnh viễn đã biết (permission-denied, invalid-argument, not-found…) thắng heuristic message.
- `markReviewResultsFailed` / `markGamificationEventFailed`: lỗi tạm thời → chỉ ghi lại `error`, giữ `pending`, **không tăng** retryCount/attempts. Lỗi vĩnh viễn → tăng như cũ (review dead ở 5, gamification dead ở 3).

### A3. [T2 — TRUNG] Flush scope theo user của phiên hiện tại
- `flushReviewQueue(userId?)` (`src/review/firebaseSync.ts`) và `flushGamificationQueue(userId?)` (`src/services/gamificationService.ts`): tham số tùy chọn; không truyền thì lấy `auth.currentUser?.uid`; chưa có phiên đăng nhập thì không flush. Chỉ bản ghi của đúng user mới được lấy (`getPendingReviewResults(uid)`, `getPendingGamificationEvents(uid)` — hàm sau thêm tham số lọc tùy chọn). Bản ghi của tài khoản khác trên cùng máy để nguyên, không còn bị flush chéo làm cháy retry.
- `enqueueReviewSync` đếm pending theo `input.userId` thay vì toàn cục cho ngưỡng `FLUSH_SIZE`.
- Lưu ý cho nhóm App/Study: các call site hiện tại gọi không tham số vẫn đúng (tự lấy uid từ auth); lần flush ngay sau login dựa vào `auth.currentUser` đã set.

### A4. [T3+T4+T5 — TRUNG] Gamification: chống đếm trùng, không mất lặng, đúng ngày học
- **Idempotency (T3):** `ActivityInput.eventId` — khi có, doc log (`review_logs`/`quiz_logs`) dùng chính id đó; transaction đọc doc log trước, đã tồn tại ⇒ trả `antiCheatFlags: ['duplicate_event']`, không cộng gì. Check-and-set nằm trong cùng transaction với cộng XP/totals nên nguyên tử.
  - ⚠️ **Chệch khỏi thiết kế đề xuất ban đầu (processedEventIds trên profile doc), có chủ đích:** whitelist update của `firestore.rules` cho `/users/{uid}` **không có** field `processedEventIds` — nếu ghi field đó, MỌI lần ghi profile gamification sẽ bị rules từ chối (permission-denied) cho tới khi rules được sửa và publish lại qua Firebase Console. Cách log-doc-id đạt cùng đảm bảo nguyên tử mà create-rule hiện hành đã cho phép (chỉ yêu cầu `userId` + `dateKey`). Nếu sau này muốn chuyển sang mảng processedEventIds: thêm `'processedEventIds'` vào whitelist trong `firestore.rules` rồi publish lại.
  - Nguồn eventId: hàng đợi gamification dùng id bản ghi Dexie; đường review-queue (`firebaseSync.ts`) dùng id xác định `rq-<uid>-<fnv1a(sorted record ids)>` — flush lại cùng tập bản ghi (2 tab, commit mập mờ) cho cùng một id ⇒ không đếm trùng.
- **Không mất lặng (T4):** `trackActivityWithOfflineQueue` xếp hàng Dexie khi **bất kỳ** lỗi nào (trước đây chỉ khi `!navigator.onLine`, lỗi "online" bị nuốt sau console.warn). Id sự kiện được sinh **trước** lần thử trực tiếp và giữ nguyên khi xếp hàng — commit thực ra đã landed nhưng client thấy lỗi vẫn không bị tính hai lần khi replay. Chỉ khi cả Dexie cũng lỗi mới rethrow lỗi gốc.
- **Đúng ngày học (T5):** `ActivityInput.occurredAt`; `flushGamificationQueue` truyền `new Date(event.createdAt)`. `trackActivity` tính dateKey/streak/`lastStudyDate` theo thời điểm hoạt động gốc (kẹp: tương lai/không hợp lệ → now), `updatedAt` vẫn là thời điểm ghi thật. Thêm guard chống tua ngược: sự kiện thuộc ngày học **sớm hơn** ngày đã ghi trong profile vẫn cộng totals/XP nhưng không ghi đè streak/lastStudyDate.

### A5. [T6 + L1 + L4 + L5] Code chết — đã tự grep xác minh 0 importer/caller tại thời điểm sửa rồi mới xóa
- Xóa `src/services/fsrsSync.ts` (53 dòng, 0 import toàn repo).
- Xóa `handleFirestoreError` + `OperationType` + `FirestoreErrorInfo` khỏi `src/firebase.ts` (0 caller).
- Gỡ `dotenv`, `rehype-raw` khỏi `package.json` (0 dùng trong src/tests/scripts/server.ts/vite.config).
- Xóa 6 component ui 0 importer: `src/components/ui/{badge,progress,scroll-area,select,skeleton,tabs}.tsx`.
- **Giữ lại (kiểm chứng lại, không xóa):** 3 hàm đọc dead-letter trong `localDB.ts` (`countDeadReviewResults`, `getDeadReviewResults`, `countDeadGamificationEvents`) — tuy 0 caller nhưng là API bề mặt phục vụ mục T1 phần UI (hiển thị số bản ghi dead ở Settings), nằm ngoài phạm vi file của nhóm này; đề xuất nhóm Settings dùng hoặc xóa ở vòng sau. Các export L2 khác (`addStep`/`stepToDays`, `exportAnkiApkg`, type `ExamResult`/`ExamQuestion`, field `lastSentDate` — L2/L3) thuộc file của nhóm khác, không đụng.

### A6. [L6 + L7 + L8 — THẤP]
- **Day-key trùng tên:** `getStudyDayKey` trong `src/lib/gamification.ts` (neo timezone) đổi tên thành `getStudyDayKeyInTimezone`, cập nhật 2 caller nội bộ (`computeStreakOnActivity`). Đã grep: không file nào khác import tên cũ từ lib/gamification (Study dùng bản scheduler qua barrel). Bản scheduler (`intervalCalculator.ts`, giờ địa phương thiết bị) giữ nguyên tên — từ nay hai quy ước phân biệt rõ bằng tên.
- **Dọn IndexedDB (L7):** `pruneSyncedRecords()` trong `localDB.ts` — xóa bản ghi review/gamification `status='synced'` có `syncedAt` cũ hơn 7 ngày; tự throttle 1 lần/giờ/phiên, không bao giờ throw vào caller; được gọi từ cả hai đường flush.
- **Types (L8):** `UserProfile` thêm `xp?: number`, `level?: number`, `updatedAt?: string`; `Deck` thêm `aiMindmap?: string` (trong `src/types.ts`). Đã bỏ các cast cục bộ nằm trong file nhóm này sở hữu (`gamificationService.ts`: cast `xp` và `updatedAt`). Hai cast còn lại nằm ngoài phạm vi: `ProfileWithProgress` ở `src/App.tsx:331` + `src/pages/Dashboard.tsx:192` và `DeckWithAiMindmap` ở `src/pages/DeckDetail.tsx:57` — nay có thể xóa vì type đã có field, để nhóm phụ trách trang/App xử lý.

### Kiểm chứng (nhóm A)
- `npm test`: **42/42 pass**.
- `npx tsc --noEmit`: không lỗi nào trong các file nhóm A (ReviewCard, localDB, firebaseSync, gamificationService, firebase.ts, types.ts, lib/gamification.ts). Baseline trước khi sửa có 3 lỗi ở `src/pages/Decks.tsx`; sau khi sửa còn 1 lỗi ở `src/pages/DeckDetail.tsx:206` (`leechThreshold`) — đều là file trang thuộc nhóm song song đang sửa dở, không liên quan thay đổi của nhóm A.
- Grep hậu kiểm: 0 tham chiếu tới fsrsSync / handleFirestoreError / 6 ui component đã xóa / dotenv / rehype-raw trong src + tests.

## C. Trang tạo nội dung + ứng dụng vỏ (AIHelper, CreateDeck, VoiceToCard, Assessment, Settings, App, index.html, index.css, sw.js)

1. **[UX A1] AIHelper — thẻ AI sửa/xoá được trước khi lưu:** khối preview chỉ-đọc (ReactMarkdown) được thay bằng thẻ có 2 ô Textarea (mặt trước/mặt sau) + nút "Xoá thẻ" từng thẻ; thêm dòng "Sẽ lưu X/Y thẻ" ở hộp đích đến; nút Lưu vô hiệu khi danh sách rỗng/đang lưu; `handleSaveToDeck` lọc bỏ thẻ thiếu một trong hai mặt và dùng danh sách đã lọc cho cả `cardCount`, `increment` và batch ghi. Xoá import ReactMarkdown/remark-gfm khỏi AIHelper (không còn nơi dùng).

2. **[UX B3] Nháp tự lưu localStorage** (key `draft:{uid|guest}:{trang}`, debounce 400ms, khôi phục khi mở trang, xoá khi lưu thành công; không lưu API key/ảnh data URL):
   - CreateDeck: tên, mô tả, danh mục, tags, màu, công khai, aiText và toàn bộ danh sách thẻ đang soạn; xoá nháp sau khi tạo deck thành công.
   - AIHelper: `ocrText` + `emphasis`; xoá nháp sau khi lưu bộ thẻ thành công.
   - VoiceToCard: `transcript` + lĩnh vực đang chọn; xoá nháp sau khi lưu thẻ thành công và khi bấm nút Xoá (handleClear).
   - Settings (mục thuật toán, lưu thủ công): thêm chỉ báo "Có thay đổi chưa lưu" (chấm hổ phách) cạnh nút Lưu cấu hình, tính bằng so sánh JSON của `schedulerDraft` với bản suy từ cấu hình đã lưu; tự tắt khi profile snapshot cập nhật sau khi lưu.

3. **[UX A4] Settings — chỉnh được Mục tiêu học mỗi ngày:** thêm khối "Mục tiêu học mỗi ngày" trong mục Tài khoản học tập: ô số (1–1000) + nút Lưu, ghi `settings.dailyGoal` (kiểu number, khớp cách Dashboard/App đọc `profile.settings.dailyGoal`) qua `updateDoc` giống các field settings khác; draft đồng bộ lại từ profile sau khi lưu.

4. **[UX B2] Assessment — xoá chips giả + "Ôn lại câu sai" thật:** xoá hàng chips tĩnh Blitz/Exam/Survival/Adaptive/Review ở header (state thật chỉ có self/ai/general). Thêm ôn câu sai trong phiên: chế độ tự kiểm tra ghi lại các thẻ bị đánh giá sai (`selfWrongCards`); chế độ AI/tổng hợp suy câu sai từ `aiQuestions` + `userAnswers`. Ở màn kết quả, khi có câu sai hiện nút "Ôn lại N câu sai" → bắt đầu lượt mới chỉ gồm các câu/thẻ đó (AI: reset đáp án + cờ + đồng hồ áp lực nếu bật; self: xáo trộn lại các thẻ sai). Không lưu trữ bền theo đúng phạm vi.

5. **[Perf P15 + P9] pdfjs lazy + Tesseract tự host:**
   - AIHelper & CreateDeck: bỏ import tĩnh `pdfjs-dist` ở đầu file; handler PDF dùng `await import('pdfjs-dist')` rồi gán `GlobalWorkerOptions.workerSrc` từ URL worker import tĩnh dạng `?url` (chỉ là chuỗi URL, không kéo thư viện ~452KB vào chunk trang).
   - Tesseract: `createWorker('vie+eng', undefined, { workerPath, corePath: '/tesseract-core', langPath: '/tessdata' })`. workerPath import từ `tesseract.js/dist/worker.min.js?url`; core WASM sao vào `public/tesseract-core/` (3 biến thể LSTM: thường, simd, relaxedsimd — gồm cả .wasm.js và .wasm); dữ liệu ngôn ngữ sao vào `public/tessdata/{eng,vie}.traineddata.gz` lấy từ thư mục `4.0.0_best_int` của 2 gói `@tesseract.js-data/eng` + `@tesseract.js-data/vie` (đã cài dạng devDependencies) — đúng biến thể mà trước đây CDN mặc định của tesseract.js phục vụ cho chế độ LSTM. OCR từ nay chạy cùng origin, dùng được offline (SW cache-first), không còn phụ thuộc jsDelivr.

6. **[Perf P7 + B11] App — bỏ "thuế" chuyển trang:** `AnimatedRoutes` bỏ hẳn `AnimatePresence mode="wait"` + `motion.div` (exit 220ms chồng animation CSS pageIn 320ms); thay bằng `div` có key theo pathname mang class `animate-page-in` — nội dung hiện tức thì, chỉ còn một cơ chế animation (CSS). Đồng thời chuyển các import chỉ dùng sau đăng nhập sang dynamic import: `flushGamificationQueue` (trong effect theo uid), `flushReviewQueue`, `clearReviewCache` (trong handleLogout) — Dexie/ts-fsrs không còn bị kéo tĩnh vào entry qua App; hằng số sự kiện huy hiệu giữ dạng literal `'ankilearning:badge'` tại App kèm chú thích khớp nguồn (services/gamificationService) để tránh import tĩnh cả service.

7. **[Perf P14] index.html — script khởi tạo theme chống chớp sáng:** script inline nhỏ trong `<head>` đọc `localStorage['anki_settings'].theme` (light/dark/system — cùng key/định dạng SettingsContext đang dùng), tự suy dark theo `prefers-color-scheme` khi theme=system, gắn class `dark` + màu nền tạm (#0f172a tối / #f7f7fb sáng — khớp `--background`) trước first paint.

8. **[Perf P8] index.css — giảm chi phí GPU nền:** blob aurora blur 72px → 52px, kích thước 34/30/26rem → 27/24/21rem (giữ nguyên màu/vị trí/nhịp drift bằng transform). `.app-surface` và `.app-shell` bỏ hẳn animation `background-position` (canvasDrift 24s/26s gây repaint liên tục toàn màn hình) → nền gradient tĩnh, diện mạo không đổi; xoá keyframes `canvasDrift` và class `.app-shell-paused` đã chết, kèm effect visibilitychange trong App.tsx chỉ còn phục vụ việc pause animation này.

9. **[SW] public/sw.js — cache v4 + giới hạn dung lượng:** `CACHE_VERSION` v3 → `ankilearning-v4`; thêm `trimCache` giữ tối đa 120 entry trong cache tĩnh: sau mỗi lần put tài nguyên runtime, xoá các entry cũ nhất vượt giới hạn nhưng không bao giờ xoá entry thuộc app shell (fallback offline).

10. **[B1] Đồng bộ phong cách cơ học** (chỉ 4 file trang vòng cũ thuộc mảng này: AIHelper, CreateDeck, VoiceToCard, Assessment): `slate-*` → `zinc-*`, `indigo-*` → `emerald-*` (gồm 2 nút chính bg-indigo-600 ở Assessment và icon indigo ở VoiceToCard), `font-black` → `font-extrabold`. Kiểm chứng sau quét: 0 lần xuất hiện còn lại của cả 3 mẫu trong 4 file. Không đổi layout/logic; các giá trị dữ liệu dạng hex (màu deck mặc định) giữ nguyên.

**Kiểm chứng:** `npx tsc --noEmit` — không lỗi nào trong các file thuộc mảng C. Toàn project còn đúng 1 lỗi ở `src/pages/DeckDetail.tsx(207,56)`: thuộc tính `leechThreshold` chưa có trong type `settings.scheduler` ở types.ts — file thuộc mảng khác (DeckDetail/models), cần mảng sở hữu types bổ sung field vào type (runtime đã có field này qua normalizeSchedulerConfig).

## Mục B — Hiệu năng trang + Học tập (Decks, Dashboard, Study, DeckDetail, lib/deckAnalytics)

Ngày: 2026-11-04 · Phạm vi file: `src/pages/Decks.tsx`, `src/pages/Dashboard.tsx`, `src/pages/Study.tsx`, `src/pages/DeckDetail.tsx`, `src/lib/deckAnalytics.ts`. Kiểm chứng: `npx tsc --noEmit` sạch, `npm test` 42/42 pass.

### B1. Cache thống kê deck theo chữ ký (Perf P1 — mục quan trọng nhất)
- `src/lib/deckAnalytics.ts`: thêm cache module-level `deckCardsCache` key theo deckId + chữ ký (`updatedAt|createdAt|cardCount` qua `getDeckCacheSignature`), TTL 5 phút, `fetchDeckCardsCached()` và `invalidateDeckCardsCache(deckId?)`. Thêm `computeDeckStudyStats()` dùng chung (learned/mastered/due/lastStudied — cùng công thức cũ). `fetchDeckInsights`/`fetchMultipleDeckInsights` nhận thêm `signature` tuỳ chọn (chấp nhận cả `string | {id, signature}`) và đi qua cache khi có chữ ký.
- `Decks.tsx`: `onSnapshot` danh sách deck KHÔNG còn đọc lại toàn bộ thẻ mọi deck — `loadDeckStats()` chỉ fetch thẻ của deck chưa có cache/đổi chữ ký/hết TTL, còn lại dùng bản cache. Lỗi tải stats giữ nguyên số đang hiển thị thay vì xoá về 0. Nút "Làm mới" gọi `invalidateDeckCardsCache()` rồi tính lại từ đầu. UI và số liệu hiển thị không đổi.
- `Dashboard.tsx`: insights tính trên MỌI deck (bỏ giới hạn 4 deck gần nhất — sửa UX A5) nhưng qua cùng cache chữ ký, nên snapshot lặp không đọc lại. `dueToday`, forecast 7 ngày và CTA "Học ngay" (state mới `totalDueToday`, `firstDueDeckId` — deck gần nhất còn thẻ đến hạn trong toàn bộ deck) đều là tổng toàn cục; danh sách "Bộ thẻ gần đây" vẫn hiển thị 4 deck mới nhất như cũ.

### B2. Dynamic import cho tính năng ít dùng (Perf P3)
- `Dashboard.tsx`: bỏ import tĩnh `aiService` → `await import()` trong `handleGetAiSuggestion` (mẫu Settings).
- `Decks.tsx`: `ankiService` + `ankiMediaStorage` → dynamic import trong `handleImportAnki`.
- `DeckDetail.tsx`: `aiService` (tạo thẻ + mindmap) và `ankiService` (xuất .apkg) → dynamic import trong từng handler. Không còn import tĩnh nào tới hai service này trong 3 trang.

### B3. Study: tải song song + cache Dexie có điều kiện (Perf P5)
- Loader đầu phiên: 4 truy vấn độc lập (deck, cards, cardProgress, user doc) chạy `Promise.all` thay vì await tuần tự; lỗi progress vẫn được nuốt riêng như trước, lỗi còn lại vẫn rơi vào nhánh fallback cache ngoại tuyến.
- `cacheCards` vào Dexie chỉ ghi khi chữ ký tập thẻ đổi (`cardSetSignature`: số thẻ + hash trượt trên id/updatedAt/lastReview/dueDate của từng thẻ; map chữ ký ở module-level theo `uid:deckId`).

### B4. DeckDetail: memo hoá + tìm kiếm/lọc thẻ + trạng thái lỗi (Perf P6/P8, UX A2, B6, B7)
- Stats (đến hạn / tạm dừng+gộp hoãn / thẻ khó) tính trong MỘT `useMemo` duyệt thẻ một lần, thay cho nhiều lần `filter` mỗi render.
- Hàng thẻ tách thành component `DeckCardRow` bọc `React.memo`; các handler thẻ (`handleEditCard`, `handleDeleteCard`, `handleBuryCard`, `handleToggleSuspendCard`) chuyển sang `useCallback` ổn định để memo có tác dụng (gõ form sửa deck/ô tìm kiếm không render lại mọi hàng).
- Thêm ô tìm kiếm thẻ (mặt trước + mặt sau) và chip lọc Tất cả / Đến hạn / Thẻ khó (`lapses >= leechThreshold` từ SettingsContext, mặc định 8) / Đã tạm dừng (suspended hoặc buried chưa hết hạn) — mỗi chip hiện số lượng; phân trang 50/trang áp trên danh sách đã lọc, đổi lọc/tìm kiếm là về trang đầu; có trạng thái rỗng khi lọc không khớp.
- Deck không tồn tại/lỗi tải: thay `return null` (trang trắng) bằng state `deckError` riêng + màn hình lỗi thân thiện (nút Thử lại qua `reloadKey`, nút về danh sách); snapshot deck lỗi cũng vào state này thay vì chỉ console.error.
- Dialog Thêm thẻ: panel AI thêm biến thể dark (`dark:bg-emerald-500/10`, `dark:border-emerald-500/20`, chữ `dark:text-emerald-300`), textarea AI thêm `dark:bg-white/5`, nhãn phân cách "Hoặc thêm thủ công" đổi `bg-white` → `bg-popover` cho khớp nền dialog cả hai theme.

### B5. Study: báo cáo cuối phiên đầy đủ hơn (UX A3)
- Đếm phân bố 4 nút chấm trong `handleRate` (`ratingCountsRef`; `handleUndo` trừ lại đúng nút đã hoàn tác — `UndoSnapshot` nay lưu thêm `rating`; reset ở `beginSession`/`resetStudy`).
- `finishSession` lưu `finishSummary` {duration, ratings}; màn hoàn thành hiện thêm: thời lượng phiên (định dạng phút/giây), tốc độ giây/thẻ, 4 ô Quên/Khó/Tốt/Dễ, và thanh tiến độ "Phiên này: X/mục tiêu ngày" (dailyGoal từ profile, mặc định 20) — cạnh hai ô Đã học/Chính xác cũ.

### B6. Đồng bộ phong cách B1 (chỉ 4 file sở hữu)
- Thay cơ học `slate-*` → `zinc-*`, `font-black` → `font-extrabold` ở Decks + DeckDetail (Dashboard/Study đã sạch — "slate" duy nhất ở Dashboard là trong từ "translate"); `indigo-*` → `emerald-*` ở DeckDetail (gồm nút "BẮT ĐẦU HỌC", "THÊM THẺ MỚI", panel AI, thanh trái hàng thẻ) và ô thống kê ở Decks; màu deck mặc định `'#4f46e5'` → `'#10b981'` ở cả hai trang (chỉ là fallback hiển thị khi deck chưa đặt màu; bảng màu chọn trong dialog giữ nguyên). Kiểm chứng sau sửa: cả 4 file còn 0 slate-/indigo-/font-black. Không đổi layout/kích thước.

### Lưu ý / không thuộc phạm vi đã chạm
- Chữ ký cache dựa trên document deck: ghi thẻ từ nơi khác (Study ở tab khác) không đổi chữ ký deck thì số liệu có thể cũ tối đa 5 phút (TTL) — đánh đổi có chủ đích theo findings P1(c); nút Làm mới luôn cho số mới nhất.
- P6 còn một ý chưa làm (ngoài phạm vi được giao): form sửa deck vẫn bị snapshot ghi đè khi đang gõ (`setEditedDeck` trong snapshot deck) — cần tách khởi tạo form khỏi snapshot ở một đợt riêng.

## Tích hợp (parent)
- types.ts: thêm `leechThreshold?: number` vào settings.scheduler (DeckDetail dùng, runtime đã có qua normalizeSchedulerConfig).
- DeckDetail: form sửa deck không còn bị snapshot ghi đè khi đang gõ (guard bằng isEditingDeckRef) — nốt phần còn lại của P6.
- Nén lại toàn bộ public/img bằng PIL (resize đúng cỡ hiển thị + WebP q74): 1.028KB → 145KB (-86%).
- Tesseract core: bỏ biến thể non-SIMD (tesseract-core-lstm.*) — trình duyệt không hỗ trợ SIMD (trước ~2021) sẽ không chạy được OCR offline; giữ simd + relaxedsimd. public/tesseract-core còn 13MB host, trình duyệt chỉ tải 1 biến thể khi dùng OCR.
- Kiểm chứng tích hợp: tsc sạch, 42/42 test, build OK. Entry chunk 500KB → 381KB (pdfjs tách chunk lười riêng 442KB, chỉ tải khi mở PDF).
