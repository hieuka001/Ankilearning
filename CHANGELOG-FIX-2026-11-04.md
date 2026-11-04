# NHẬT KÝ SỬA AnkiLearning (sau khi user cấp toàn quyền 2026-11-04)

## Đợt 1b — aiService.ts ✅ (xong 11:13)
- Viết lại aiService.ts + tests/aiService.test.ts (17/17 pass; tsc 0 lỗi; hồi quy 7/7).
- responseSchema thật (flashcard có type basic|cloze + tags; exam có source), maxOutputTokens theo tính năng, temperature riêng (0.3 thi/lâm sàng, 0.4 thẻ, 0.6 mindmap/lộ trình).
- parseJson export + throw AiResponseParseError (message có dấu) thay vì trả {}; quét trailing comma có ý thức chuỗi (không phá ",}" trong nội dung); list rỗng hợp lệ vẫn trả [].
- Prompt: <material> chống injection + emphasis xuống user part; exam anti-hallucination + cân bằng đáp án + source; generalExam BỎ quyền tự đưa URL ảnh (strict allowlist, mặc định rỗng); clinical thêm khử định danh + trần thẻ + "(suy luận)"; mindmap ≤3 cấp giữ số liệu gốc; studyPath cấm bịa số liệu.
- Fallback: 429/quota → chuyển model ngay; lỗi mạng retryable; cache GoogleGenAI instance theo key; mọi message lỗi có dấu.
- API: chỉ THÊM tham số tuỳ chọn (count cho clinical voice/media = 8; imageCandidates cho generateGeneralExam). Caller cũ không vỡ.

## Đợt 1d — Đồng bộ/Bảo mật ✅ (xong 11:15)
- firebaseSync: chia lô ≤450 ops theo recordOpCount, commit từng lô, lô lỗi → retry từng bản ghi cô lập; set(merge) thay update; flush chỉ throw khi 0 bản ghi sync được. Đếm đúng/sai: dùng field isCorrect có sẵn — cardsReviewed/correctCount chỉ tính bản ghi ĐÃ sync thành công. LƯU Ý CÒN SÓT: gamificationService (~dòng 164) tự ánh xạ totalCardsReviewed := correctCount — thuộc đợt gamification 2c.
- localDB: Dexie v3 (backfill retryCount/attempts, giữ dữ liệu cũ), status 'dead' sau 5 lần (review) / 3 lần (gamification events), countDead*/getDead*, getPending(userId?) lọc theo tài khoản, clearReviewCache() xoá 3 bảng cho logout.
- firebase.ts: bỏ log PII (uid/email/provider) — chỉ code + operation + path.
- firestore.rules: leaderboards rule khớp thực tế app ghi {username, avatar}; users update whitelist diff đầy đủ (role KHÔNG được phép sửa); tách delete cho cardProgress/notifications; sessions/examResults ≤60 field. Settings đang dùng updateDoc cho leaderboards — doc chưa có sẽ not-found ở client; đợt 2c chuyển sang setDoc merge.
- storage.rules MỚI (anki-media/{userId}/..., <20MB, image/audio/video, read = đã đăng nhập) + khai báo trong firebase.json.
- vite.config: xoá define nhúng key + chunkSizeWarningLimit 2000. server.ts: xoá /api/fetch-url + axios/cheerio imports (deps còn trong package.json — dọn ở tích hợp). .env.example viết lại theo BYOK.
- [Tôi tự sửa bổ sung] aiService.ts còn đọc process.env.* (fallback key env) — đã xoá hẳn (getEnvGeminiApiKey trả ""), message lỗi bỏ nhắc biến môi trường. Nếu không sửa, gỡ define ở vite.config sẽ làm module AI lỗi "process is not defined" trên trình duyệt.
- Kiểm chứng của agent: tsc 0 lỗi thuộc file 1d; vite build nạp config mới OK. 3 lỗi tsc lúc đó thuộc ankiService đang sửa dở (sql-wasm ?url) — chờ 1c xong kiểm lại.

## Đợt 1a — Engine ts-fsrs ✅ (xong 11:17)
- fsrsScheduler viết lại trên ts-fsrs v6 (FSRS-6, 21 weights): L1 sửa dứt điểm (không bao giờ đọc elapsedDays đã lưu — luôn tính từ lastReview), L2/L3/L4 do ts-fsrs xử lý chuẩn; fuzz + short-term bật; leech: lapses ≥ ngưỡng (mặc định 8, config leechThreshold/leechAction mới) → result.leech=true + suspended.
- intervalCalculator cài lại trên đường cong FSRS-6 từ chính ts-fsrs (R = (1+0.9803·t/S)^−0.1542, R(S,S)=0.9). queue: bury sau sort (giữ thẻ due sớm nhất), daily limit THẬT qua tham số thứ 4 {introducedToday, reviewedToday} (tham số 3 là now — Study đang truyền), countIntroducedToday export mới. firstReviewAt đóng dấu khi thẻ rời 'new'.
- Xoá code chết: simulation.ts, analytics/fsrsAnalytics.ts, calculateNextReview, getNextAvailableTime, selectNextCard (đều 0 caller).
- Test: 15/15 (vector ts-fsrs + hồi quy L1-L4 bằng số thật: S=100 Again → S=3.75; Good trong ngày 32 ngày vs đúng hạn 86 ngày; Hard sớm 37.4 ≠ trễ 82.1). tsc sạch toàn project tại thời điểm chạy.
- LƯU Ý cho đợt 2: (1) buildStudyQueues(cards, config, now, {introducedToday, reviewedToday}); (2) result.interval cho Again = thời gian tới relearning (<1 ngày) — đúng chuẩn mới; (3) thẻ mới Good nay đi qua learning steps (không tốt nghiệp ngay) — chủ đích; (4) các field config initialStability/graduatingInterval/easyInterval/hardMultiplier/easyBonus còn trong shape nhưng KHÔNG điều khiển engine nữa → Settings (2c) phải bỏ các control này, thay bằng desiredRetention/maximumInterval/learning+relearning steps/newCardsPerDay/reviewsPerDay/leechThreshold; (5) useScheduler trả thêm cờ leech + schedulerUpdate có suspended/firstReviewAt.

## Đợt 1c — .apkg ✅ (xong 11:19) — ĐỢT 1 HOÀN TẤT
- ankiService: resolveMediaMap (JSON cũ → zstd+protobuf thủ công → fallback chuỗi) — media map trích 673 entries tên thật; readDeckNames đọc bảng decks (\x1f→::) fallback col.decks; buildImportedSchedule giữ tiến độ (stability≈ivl, due=crt+due ngày, suspended/buried, easeFactor=factor/1000 để normalize tự suy difficulty); chống trùng existingNoteIds + nội bộ noteId:ord (duplicatesSkipped); export viết lại field gắn [sound:]/<img> đúng tham chiếu, model Cloze type=1, csum SHA-1 đúng thuật toán (đối chiếu node:crypto), exportAnkiApkgDetailed {blob, warnings}; WASM tự host (?url dynamic import, dist có sql-wasm 659KB); MAX_APKG_BYTES 150MB, >50MB có warnings.
- Test thật: 7/7 — deck Chinese::Từ vựng::HSK1, 520 thẻ, 520 có audio, 185 có ảnh; scheduler 15/15 + gamification 3/3 không hồi quy; tsc sạch; build OK.
- VIỆC TÍCH HỢP cho đợt 2: (1) Decks.tsx dùng `...(card.schedule ?? createInitialCardSchedule())`, bỏ qua deck 0 thẻ, hiển thị warnings/duplicatesSkipped; DeckDetail dùng exportAnkiApkgDetailed + toast warnings. (2) chineseCardLayout.hasContent strip HTML nên field chỉ có <img> bị coi là rỗng — sửa tính cả <img>.

## Đợt 2a — Trang AI ✅ (xong 11:24)
- AIHelper: xoá hẳn UI/handler đọc URL + axios; guard 0 thẻ/lỗi parse (toast.warning/error đúng message); PDF tối đa 30 trang + text cắt 60k ký tự có thông báo; trích PDF giữ cấu trúc dòng theo toạ độ; Tesseract terminate trong finally; pdf.js worker đóng gói (?url) ở cả AIHelper + CreateDeck; ảnh Vision chặn >10MB + nén canvas 1600px JPEG 0.85.
- VoiceToCard: giới hạn media thật 10MB; truyền count=8; bộ chọn Lĩnh vực Y khoa/Ngoại ngữ/Chung (khác Y khoa → generateFlashcardsFromText; audio/video ngoài Y khoa báo rõ chỉ hỗ trợ ở Y khoa); sửa lỗi nút xoá file không xoá fileBase64.
- Assessment: hiển thị question.source ở màn xem lại; guard 0 câu cho cả 2 đường sinh đề; giữ imageCandidates=[] mặc định.
- CreateDeck: guard AI + lỗi parse JSON từ URL rõ ràng. tsc 0 lỗi thuộc 4 file.

## Đợt 2c-2 — Decks/DeckDetail/Search ✅ (xong 11:25)
- Decks: import dùng card.schedule ?? createInitialCardSchedule() (giữ tiến độ Anki), deck 0 thẻ không tạo + toast lý do, toast kèm warnings/duplicatesSkipped; thanh tiến độ "Đã thuộc" (state review); skeleton + empty state 2 trường hợp.
- DeckDetail: export qua exportAnkiApkgDetailed + toast warnings; mindmap AI vào field riêng aiMindmap (không ghi đè ghi chú); phân trang thẻ 50/lần + loading=lazy; window.confirm → ConfirmDialog (named export từ đợt 2b); dịch Suspend/Bury + state sang tiếng Việt.
- Search: empty state sau tìm kiếm, skeleton. tsc 0 lỗi thuộc 3 file.

## Đợt 2b — Study/ReviewCard ✅ (xong 11:26)
- Re-queue trong phiên: hàng đợi sống (ref+state), thẻ due ≤ now+25' quay lại cuối hàng đợi, chống trùng; giới hạn ngày thật qua tham số 4 của buildStudyQueues (introducedToday từ engine + reviewedToday xấp xỉ theo lastReview/getStudyDayKey); loader không còn refetch xoá phiên giữa chừng.
- Undo lần chấm gần nhất (nút + phím U): chưa flush → xoá thẳng bản ghi outbox trong Dexie (sạch hoàn toàn); đã flush → ghi đè trạng thái cũ + arrayRemove history + xoá review doc; giới hạn: điểm gamification của lần flush không trừ lại được, firstReviewAt có thể còn lại (đếm introducedToday phía server). Chỉ trong phiên.
- Phím tắt Space/Enter lật, 1–4 chấm, U undo (bỏ qua khi gõ/modifier/native button); ReviewCard focusable + inert mặt ẩn + aria tiếng Việt; nhãn Câu hỏi/Đáp án + state dịch VI; swipe chỉ ngang (trái Quên, phải Dễ); leech toast; 3 trạng thái tải rõ ràng (trống/hết hạn/lỗi+thử lại), xoá window.confirm; nhánh offline dùng buildStudyQueues trên cache; finish session trung thực (saved/error + Lưu lại) + streak ghi đồng thời streak & streakDays qua getStudyDayKey. ConfirmDialog.tsx mới (named export) cho các trang khác. tsc 0 lỗi thuộc file của đợt.

## TÍCH HỢP + DEPLOY ✅ (xong 12:20)
- Tôi tự sửa ở tích hợp: gamification.test thêm kỳ vọng huy hiệu streak_3 mới; gỡ axios/cheerio khỏi package.json (0 import còn lại); aiService bỏ hẳn fallback đọc process.env (xem đợt 1d).
- Kiểm chứng cuối: tsc sạch; **42/42 test pass** (15 scheduler + 17 aiService + 7 apkg + 3 gamification); vite build OK; dist kiểm tra: title mới, sw.js/manifest/icon vào dist, sql-wasm + pdf worker đóng gói, bundle chỉ chứa 1 key AIza = Firebase web key công khai.
- DEPLOY: Vercel project ankilearning (prj_cXxcmfKt4dNGEo6YZaORIeiDZvrY), deployment dpl_3GAsbjspmrgxE3AazAc7Md5oA42U, target production, deploy trực tiếp bằng upload_file + create_deployment (KHÔNG teamId; requestBody chứa name/project/files/target). File lớn chia chunk 64KB trong .deploy-chunks (package-lock 7 phần, background-music.mp3 44 phần) và vercel.json installCommand/buildCommand ghép lại trước npm ci/build. Manifest: ~/workspace/ankilearning-audit/vercel-manifest.json (140 entries); script: deploy.py cùng thư mục.
- LIVE VERIFY: learning-with-trunghieu.vercel.app chạy bản mới — title "AnkiLearning — Học thông minh với thẻ ghi nhớ", chunk chính index-CK326z42.js TRÙNG hash bản build local đã kiểm chứng, /sw.js + /manifest.webmanifest trả đúng content-type (rewrite SPA không nuốt), mp3 đủ 2.881.035 byte, ankilearning-amber.vercel.app redirect 307 về domain chính.
- Đóng gói: ~/workspace/your_files/AnkiLearning-FIXED-2026-11-04.zip (111 files, kèm CHANGELOG-FIX-2026-11-04.md).
- ⚠️ CHƯA LÀM / VIỆC CỦA USER: (1) GitHub repo hieuka001/Ankilearning VẪN LÀ CODE CŨ — deploy lần này đi thẳng lên Vercel; nếu sau này push/deploy từ GitHub sẽ ghi đè bản mới (dùng file zip để cập nhật repo). (2) firestore.rules + storage.rules MỚI CHƯA được deploy lên Firebase (Vercel không quản lý việc này) — cần chạy `firebase deploy --only firestore:rules,storage` hoặc dán qua Firebase Console; trước khi deploy rules, tính năng leaderboards vẫn lỗi như cũ và whitelist profile chưa có hiệu lực. (3) Việc kiểm tra key Gemini trong bundle production CŨ vẫn chưa kết luận được (không đọc được bundle cũ) — nếu project Vercel từng đặt GEMINI_API_KEY thì nên thu hồi key đó cho chắc, bản mới không nhúng key nữa.

## TOÀN BỘ HOÀN TẤT (đợt 1 + 2 + tích hợp + deploy).
