import { useState, useRef, useEffect } from 'react';
import { createWorker } from 'tesseract.js';
import { motion, AnimatePresence } from 'motion/react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Textarea } from '@/components/ui/textarea';
import {
  Camera,
  FileText,
  Sparkles,
  Loader2,
  Copy,
  Check,
  BrainCircuit,
  Upload,
  Settings2,
  Save,
  Plus,
  Trash2
} from 'lucide-react';
import { generateFlashcardsFromText } from '../services/aiService';
import { toast } from 'sonner';
import { collection, addDoc, serverTimestamp, writeBatch, doc, query, where, getDocs, updateDoc, increment } from 'firebase/firestore';
import { db } from '../firebase';
import { useNavigate } from 'react-router-dom';
import { createInitialCardSchedule } from '../lib/spacedRepetition';
import { extractTextFromDocument } from '../lib/documentText';
import tesseractWorkerUrl from 'tesseract.js/dist/worker.min.js?url';

// Trích xuất tài liệu (PDF/DOCX/TXT/MD) dùng lib chung src/lib/documentText.ts
// — pdfjs và mammoth đều nạp lười trong lib nên không tải kèm trang.
// Tesseract tự host toàn bộ: worker từ bundle, core WASM + dữ liệu ngôn
// ngữ eng/vie từ public/tesseract-core và public/tessdata (không còn CDN).

const MAX_MATERIAL_CHARS = 60000;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const EMPTY_CARDS_MESSAGE = 'AI không tạo được thẻ nào từ nội dung này — thử rút gọn/chia nhỏ tài liệu hoặc kiểm tra lại nội dung.';
const TRUNCATED_MESSAGE = `Nội dung quá dài nên đã được cắt còn ${MAX_MATERIAL_CHARS.toLocaleString('vi-VN')} ký tự đầu — hãy chia nhỏ tài liệu nếu cần tạo thẻ từ phần còn lại.`;

// Cắt nội dung ở giới hạn ký tự, trả về cờ để báo cho người dùng khi bị cắt.
function capMaterialText(text: string): { text: string; truncated: boolean } {
  if (text.length <= MAX_MATERIAL_CHARS) return { text, truncated: false };
  return { text: text.slice(0, MAX_MATERIAL_CHARS), truncated: true };
}

// Nén ảnh trước khi gửi Vision: cạnh dài tối đa 1600px, JPEG chất lượng 0.85.
async function compressImageForVision(dataUrl: string): Promise<string> {
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = reject;
      image.src = dataUrl;
    });
    const longestSide = Math.max(img.naturalWidth, img.naturalHeight);
    if (longestSide <= 1600 && dataUrl.startsWith('data:image/jpeg')) return dataUrl;
    const scale = Math.min(1, 1600 / longestSide);
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(img.naturalWidth * scale);
    canvas.height = Math.round(img.naturalHeight * scale);
    const ctx = canvas.getContext('2d');
    if (!ctx) return dataUrl;
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', 0.85);
  } catch {
    return dataUrl;
  }
}

import { UserProfile, Deck } from '../types';

import { User } from 'firebase/auth';

interface AIHelperProps {
  user: User | null;
  profile: UserProfile | null;
}

export default function AIHelper({ user, profile }: AIHelperProps) {
  const [image, setImage] = useState<string | null>(null);
  const [ocrText, setOcrText] = useState('');
  const [cardCount, setCardCount] = useState(5);
  const [emphasis, setEmphasis] = useState('');
  const [deckName, setDeckName] = useState('Bộ thẻ mới từ AI');
  const [isProcessing, setIsProcessing] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [useVision, setUseVision] = useState(false);
  const [generatedCards, setGeneratedCards] = useState<any[]>([]);
  const [existingDecks, setExistingDecks] = useState<Deck[]>([]);
  const [selectedDeckId, setSelectedDeckId] = useState<string>('new');
  const fileInputRef = useRef<HTMLInputElement>(null);
  const pdfInputRef = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();

  useEffect(() => {
    // Fetch existing decks
    if (user) {
      const q = query(collection(db, 'decks'), where('ownerId', '==', user.uid));
      getDocs(q).then(snap => {
        setExistingDecks(snap.docs.map(doc => ({ id: doc.id, ...doc.data() } as Deck)));
      });
    }
  }, [user]);

  // Nháp nội dung nguồn (văn bản OCR/dán tay + ô nhấn mạnh): tự lưu vào
  // localStorage để không mất khi chuyển trang, khôi phục khi mở lại trang,
  // xoá sau khi lưu bộ thẻ thành công. Không lưu API key hay dữ liệu nhạy cảm.
  const draftKey = `draft:${user?.uid || 'guest'}:ai-helper`;
  const draftLoadedRef = useRef(false);

  useEffect(() => {
    if (draftLoadedRef.current) return;
    draftLoadedRef.current = true;
    try {
      const raw = localStorage.getItem(draftKey);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (typeof parsed?.ocrText === 'string' && parsed.ocrText) setOcrText(parsed.ocrText);
      if (typeof parsed?.emphasis === 'string' && parsed.emphasis) setEmphasis(parsed.emphasis);
    } catch {
      // Nháp lỗi/không đọc được — bỏ qua, trang vẫn dùng bình thường.
    }
  }, [draftKey]);

  useEffect(() => {
    if (!draftLoadedRef.current) return;
    const timer = window.setTimeout(() => {
      try {
        if (ocrText || emphasis) {
          localStorage.setItem(draftKey, JSON.stringify({ ocrText, emphasis }));
        } else {
          localStorage.removeItem(draftKey);
        }
      } catch {
        // Storage đầy/bị chặn — mất nháp nhưng không ảnh hưởng luồng chính.
      }
    }, 400);
    return () => window.clearTimeout(timer);
  }, [ocrText, emphasis, draftKey]);

  const updateGeneratedCard = (index: number, field: 'front' | 'back', value: string) => {
    setGeneratedCards(prev => prev.map((card, i) => (i === index ? { ...card, [field]: value } : card)));
  };

  const removeGeneratedCard = (index: number) => {
    setGeneratedCards(prev => prev.filter((_, i) => i !== index));
  };

  const handleImageUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      if (file.size > MAX_IMAGE_BYTES) {
        toast.error(`Ảnh "${file.name}" nặng ${(file.size / (1024 * 1024)).toFixed(1)}MB — vượt giới hạn 10MB. Vui lòng chọn ảnh nhỏ hơn.`);
        e.target.value = '';
        return;
      }
      const reader = new FileReader();
      reader.onload = (event) => {
        const imageSrc = event.target?.result as string;
        setImage(imageSrc);
        if (!useVision) {
          performOCR(imageSrc);
        } else {
          toast.info("Chế độ Vision đã được bật. Nhấp 'TẠO BỘ THẺ VỚI AI' để phân tích hình ảnh.");
        }
      };
      reader.onerror = () => toast.error("Không đọc được file ảnh. Vui lòng thử lại với ảnh khác.");
      reader.readAsDataURL(file);
    }
  };

  const handleDocumentUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setIsProcessing(true);
    setOcrText('');
    const toastId = toast.loading('Đang trích xuất nội dung từ file...');
    try {
      const result = await extractTextFromDocument(file, {
        onPdfProgress: (read, total) =>
          toast.loading(`Đang xử lý PDF: ${read}/${total} trang...`, { id: toastId }),
      });
      if (result.kind === 'pdf' && (result.totalPages ?? 0) > (result.pagesRead ?? 0)) {
        toast.warning(`PDF có ${result.totalPages} trang — chỉ trích xuất ${result.pagesRead} trang đầu tiên. Hãy tách file nếu cần nội dung các trang sau.`);
      }
      const capped = capMaterialText(result.text);
      setOcrText(capped.text);
      if (capped.truncated || result.truncated) toast.warning(TRUNCATED_MESSAGE);
      if (result.kind === 'pdf') {
        toast.success(`Đã trích xuất xong ${result.pagesRead}${(result.totalPages ?? 0) > (result.pagesRead ?? 0) ? `/${result.totalPages}` : ''} trang PDF!`, { id: toastId });
      } else {
        toast.success('Đã trích xuất xong nội dung từ file!', { id: toastId });
      }
    } catch (error: any) {
      console.error(error);
      toast.error(error?.message || 'Không đọc được file. Vui lòng thử lại với file khác.', { id: toastId });
    } finally {
      setIsProcessing(false);
    }
  };

  const performOCR = async (imageSrc: string) => {
    setIsProcessing(true);
    let worker: any = null;
    try {
      // Tự host OCR: worker script đi cùng bundle, core WASM và dữ liệu ngôn
      // ngữ (eng + vie, bản best_int) phục vụ từ cùng origin — OCR chạy được
      // cả khi offline và không phụ thuộc CDN bên thứ ba.
      worker = await createWorker('vie+eng', undefined, {
        workerPath: tesseractWorkerUrl,
        corePath: '/tesseract-core',
        langPath: '/tessdata',
      });
      const { data: { text } } = await worker.recognize(imageSrc);
      const capped = capMaterialText(text);
      setOcrText(capped.text);
      if (capped.truncated) toast.warning(TRUNCATED_MESSAGE);
      toast.success("Đã quét văn bản thành công!");
    } catch (error: any) {
      console.error(error);
      toast.error(error?.message ? `Lỗi khi quét hình ảnh: ${error.message}` : "Lỗi khi quét hình ảnh.");
    } finally {
      if (worker) {
        try { await worker.terminate(); } catch { /* bỏ qua lỗi khi đóng worker */ }
      }
      setIsProcessing(false);
    }
  };

  const handleGenerateCards = async () => {
    if (!ocrText.trim() && !image) return;
    setIsGenerating(true);
    try {
      const capped = capMaterialText(ocrText);
      if (capped.truncated) toast.warning(TRUNCATED_MESSAGE);
      const visionImage = useVision && image ? await compressImageForVision(image) : undefined;
      const cards = await generateFlashcardsFromText(
        capped.text,
        cardCount,
        emphasis,
        { geminiApiKey: profile?.settings?.geminiApiKey || profile?.settings?.aiApiKey },
        visionImage
      );
      setGeneratedCards(cards);
      if (cards.length === 0) {
        toast.warning(EMPTY_CARDS_MESSAGE);
      } else {
        toast.success(`Đã tạo ${cards.length} thẻ từ AI!`);
      }
    } catch (error: any) {
      console.error(error);
      toast.error(error.message || "Lỗi khi tạo thẻ bằng AI.");
    } finally {
      setIsGenerating(false);
    }
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    toast.info("Đã sao chép vào bộ nhớ tạm.");
  };

  const handleSaveToDeck = async () => {
    if (!user || generatedCards.length === 0) return;

    // Chỉ lưu các thẻ còn đủ hai mặt sau khi người dùng đã sửa/xoá ở preview.
    const cardsToSave = generatedCards.filter(card => card.front?.trim() && card.back?.trim());
    if (cardsToSave.length === 0) {
      toast.error("Không còn thẻ hợp lệ để lưu — mỗi thẻ cần đủ mặt trước và mặt sau.");
      return;
    }

    if (selectedDeckId === 'new' && !deckName.trim()) {
      toast.error("Vui lòng nhập tên bộ thẻ.");
      return;
    }

    setIsSaving(true);
    try {
      let deckId = selectedDeckId;

      if (selectedDeckId === 'new') {
        // 1. Create the Deck
        const deckRef = await addDoc(collection(db, 'decks'), {
          ownerId: user.uid,
          name: deckName,
          description: `Tạo tự động từ Study Copilot dựa trên tài liệu giáo trình.`,
          category: 'Y khoa',
          cardCount: cardsToSave.length,
          createdAt: new Date().toISOString(),
          isPublic: false,
          color: '#4f46e5',
          authorName: profile?.displayName || 'Unknown'
        });
        deckId = deckRef.id;
      } else {
        // Update existing deck card count
        await updateDoc(doc(db, 'decks', selectedDeckId), {
          cardCount: increment(cardsToSave.length)
        });
      }

      // 2. Create Flashcards using Batch
      const batch = writeBatch(db);
      cardsToSave.forEach(card => {
        const cardRef = doc(collection(db, `decks/${deckId}/cards`));
        batch.set(cardRef, {
          deckId: deckId,
          ownerId: user.uid,
          type: card.type || 'basic',
          front: card.front,
          back: card.back,
          tags: ['AI-generated'],
          ...createInitialCardSchedule(),
          createdAt: new Date().toISOString(),
        });
      });

      await batch.commit();
      toast.success(selectedDeckId === 'new' ? "Đã tạo bộ thẻ thành công!" : "Đã thêm vào bộ thẻ thành công!");
      // Lưu thành công → dọn nháp nội dung nguồn.
      try { localStorage.removeItem(draftKey); } catch { /* bỏ qua */ }
      navigate('/decks');
    } catch {
      toast.error("Lỗi khi lưu bộ thẻ.");
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="max-w-6xl mx-auto space-y-8 md:space-y-12 animate-in fade-in slide-in-from-bottom-8 duration-700 font-sans pt-4 md:pt-6">
      <header className="text-center max-w-3xl mx-auto space-y-4 md:space-y-6 px-4">
        <div className="inline-flex p-4 md:p-6 bg-primary/10 text-primary rounded-[1.5rem] md:rounded-[2rem] mb-2 shadow-2xl shadow-primary/10">
          <BrainCircuit className="w-8 h-8 md:w-12 md:h-12" />
        </div>
        <h1 className="text-3xl md:text-5xl font-extrabold text-zinc-900 dark:text-white tracking-tighter text-balance">Study Copilot</h1>
        <p className="text-zinc-500 dark:text-zinc-400 text-lg md:text-xl font-medium leading-relaxed">
          Gia sư học tập cá nhân giúp phân tích tài liệu, tóm tắt kiến thức, tạo flashcards và gợi ý câu hỏi nâng cao bằng <span className="text-primary font-bold">Gemini</span>.
        </p>
        <div className="mx-auto grid max-w-3xl grid-cols-2 gap-2 text-left md:grid-cols-5">
          {['Audio', 'Transcript', 'AI Summary', 'Flashcards', 'Quiz'].map((step, index) => (
            <div key={step} className="workflow-step p-3">
              <p className="font-mono text-[10px] font-extrabold text-primary">0{index + 1}</p>
              <p className="mt-1 text-xs font-bold text-zinc-700 dark:text-zinc-200">{step}</p>
            </div>
          ))}
        </div>
      </header>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 md:gap-10">
        {/* Input Section */}
        <section className="lg:col-span-7 space-y-6 md:space-y-8">
          <Card className="premium-panel border-0 bg-transparent shadow-2xl overflow-hidden rounded-3xl md:rounded-[3rem]">
            <CardHeader className="p-6 md:p-10 pb-4 md:pb-6 border-b border-zinc-100 dark:border-white/5">
              <div className="flex items-center gap-3 md:gap-4">
                <div className="p-2.5 md:p-3 bg-primary/10 text-primary rounded-xl md:rounded-2xl">
                  <Settings2 className="w-5 h-5 md:w-6 md:h-6" />
                </div>
                <div>
                  <CardTitle className="text-xl md:text-2xl font-extrabold tracking-tight">Cấu hình đầu vào</CardTitle>
                  <CardDescription className="text-[8px] md:text-[10px] font-extrabold uppercase tracking-widest text-zinc-400">Source & AI Options</CardDescription>
                </div>
              </div>
            </CardHeader>
            <CardContent className="p-6 md:p-10 space-y-6 md:space-y-10">
              <div className="space-y-4">
                <label className="text-[9px] md:text-[10px] font-extrabold text-zinc-400 uppercase tracking-[0.2em] flex items-center gap-2">
                  <FileText className="w-3.5 h-3.5" />
                  Tài liệu
                </label>
                <div 
                  onClick={() => pdfInputRef.current?.click()}
                  className="group border-2 border-dashed border-zinc-200 dark:border-white/10 rounded-2xl md:rounded-[2rem] p-6 flex flex-col items-center justify-center cursor-pointer hover:border-blue-500/50 hover:bg-blue-500/5 transition-all"
                >
                  <div className="flex items-center gap-4">
                    <div className="p-3 bg-blue-50 dark:bg-blue-500/10 rounded-xl text-blue-500">
                      <FileText className="w-6 h-6" />
                    </div>
                    <div className="text-left">
                      <p className="text-sm font-extrabold text-zinc-700 dark:text-zinc-200 uppercase tracking-widest">Tải lên tài liệu</p>
                      <p className="text-[10px] text-zinc-400 font-medium">PDF (tối đa 30 trang đầu), Word DOCX, TXT, MD — trích xuất văn bản để tạo thẻ</p>
                    </div>
                  </div>
                  <input 
                    type="file" 
                    ref={pdfInputRef} 
                    onChange={handleDocumentUpload} 
                    className="hidden" 
                    accept="application/pdf,.docx,.txt,.md"
                  />
                </div>
              </div>

              <div className="relative py-2 md:py-4">
                <div className="absolute inset-0 flex items-center"><span className="w-full border-t border-zinc-100 dark:border-white/5" /></div>
                <div className="relative flex justify-center text-[8px] md:text-[10px] uppercase tracking-[0.4em]"><span className="bg-white dark:bg-[#0C0D0E] px-4 md:px-6 text-zinc-400 font-extrabold">Hoặc</span></div>
              </div>

              <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <label className="text-[9px] md:text-[10px] font-extrabold text-zinc-400 uppercase tracking-[0.2em] flex items-center gap-2">
                    <Camera className="w-3.5 h-3.5" />
                    Hình ảnh tài liệu
                  </label>
                  <div className="flex items-center gap-3">
                    <span className="text-[10px] font-extrabold text-zinc-400">AI VISION</span>
                    <button 
                      onClick={() => setUseVision(!useVision)}
                      className={`w-10 h-5 rounded-full transition-all relative ${useVision ? 'bg-primary' : 'bg-zinc-200 dark:bg-white/10'}`}
                    >
                      <motion.div 
                        animate={{ x: useVision ? 20 : 0 }}
                        className="absolute top-1 left-1 w-3 h-3 bg-white rounded-full shadow-sm"
                      />
                    </button>
                  </div>
                </div>

                <div 
                  onClick={() => fileInputRef.current?.click()}
                  className="group border-2 border-dashed border-zinc-200 dark:border-white/10 rounded-2xl md:rounded-[2.5rem] p-8 md:p-12 flex flex-col items-center justify-center cursor-pointer hover:border-primary/50 hover:bg-primary/5 transition-all duration-500"
                >
                {image ? (
                  <div className="relative">
                    <img src={image} alt="Uploaded" className="max-h-48 md:max-h-64 rounded-2xl md:rounded-3xl shadow-2xl border-2 md:border-4 border-white dark:border-white/10" />
                    <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center rounded-2xl md:rounded-3xl">
                      <Upload className="text-white w-8 h-8 md:w-12 md:h-12" />
                    </div>
                  </div>
                ) : (
                  <>
                    <div className="p-4 md:p-6 bg-zinc-50 dark:bg-white/5 rounded-full text-zinc-300 dark:text-zinc-700 mb-4 md:mb-6 group-hover:scale-110 group-hover:text-primary transition-all duration-500">
                      <Camera className="w-8 h-8 md:w-12 md:h-12" />
                    </div>
                    <p className="text-base md:text-lg text-zinc-500 dark:text-zinc-400 font-extrabold uppercase tracking-widest text-center">Tải ảnh tài liệu</p>
                    <p className="text-[10px] md:text-xs text-zinc-400 mt-1 md:mt-2 font-medium">PNG, JPG up to 10MB</p>
                  </>
                )}
                <input 
                  type="file" 
                  ref={fileInputRef} 
                  onChange={handleImageUpload} 
                  className="hidden" 
                  accept="image/*"
                />
              </div>
            </div>

              {isProcessing && (
                <div className="flex items-center justify-center gap-3 md:gap-4 p-6 md:p-8 bg-primary/5 border border-primary/10 text-primary rounded-2xl md:rounded-3xl animate-pulse">
                  <Loader2 className="animate-spin w-6 h-6 md:w-7 md:h-7" />
                  <span className="font-extrabold text-[9px] md:text-xs uppercase tracking-widest">Đang trích xuất...</span>
                </div>
              )}

              <div className="space-y-6 md:space-y-8 pt-6 md:pt-10 border-t border-zinc-100 dark:border-white/5">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 md:gap-8">
                  <div className="space-y-2 md:space-y-3">
                    <label className="text-[9px] md:text-[10px] font-extrabold text-zinc-400 uppercase tracking-[0.2em]">Số thẻ cần tạo</label>
                    <input 
                      type="number"
                      min="1"
                      max="20"
                      value={cardCount}
                      onChange={(e) => setCardCount(parseInt(e.target.value) || 5)}
                      className="w-full h-12 md:h-14 px-4 md:px-6 rounded-xl md:rounded-2xl border-2 border-zinc-100 dark:border-white/5 bg-zinc-50 dark:bg-white/5 dark:text-white focus:border-primary outline-none transition-all font-mono font-bold text-lg md:text-xl"
                    />
                  </div>
                  <div className="space-y-2 md:space-y-3">
                    <label className="text-[9px] md:text-[10px] font-extrabold text-zinc-400 uppercase tracking-[0.2em]">Nhấn mạnh nội dung</label>
                    <input 
                      placeholder="VD: Định nghĩa..."
                      value={emphasis}
                      onChange={(e) => setEmphasis(e.target.value)}
                      className="w-full h-12 md:h-14 px-4 md:px-6 rounded-xl md:rounded-2xl border-2 border-zinc-100 dark:border-white/5 bg-zinc-50 dark:bg-white/5 dark:text-white focus:border-primary outline-none transition-all font-medium text-sm md:text-base"
                    />
                  </div>
                </div>

                <div className="space-y-3 md:space-y-4">
                  <div className="flex items-center justify-between">
                    <label className="text-[9px] md:text-[10px] font-extrabold text-zinc-400 uppercase tracking-[0.2em]">Dữ liệu thô</label>
                    {ocrText && (
                      <Button variant="ghost" size="sm" onClick={() => copyToClipboard(ocrText)} className="h-8 text-[9px] md:text-[10px] font-extrabold uppercase tracking-widest text-zinc-400 hover:text-primary">
                        <Copy size={12} className="mr-2" /> Copy
                      </Button>
                    )}
                  </div>
                  <Textarea 
                    value={ocrText}
                    onChange={(e) => setOcrText(e.target.value)}
                    placeholder="Quét hoặc dán văn bản..."
                    className="min-h-[200px] md:min-h-[250px] rounded-2xl md:rounded-3xl border-2 border-zinc-100 dark:border-white/5 bg-zinc-50 dark:bg-white/5 dark:text-white text-sm md:text-base leading-relaxed font-medium p-4 md:p-8 focus:border-primary transition-all"
                  />
                </div>

                <Button
                  onClick={handleGenerateCards}
                  disabled={(!ocrText.trim() && !image) || isGenerating}
                  className="w-full bg-primary hover:bg-primary/90 gap-3 md:gap-4 h-16 md:h-20 rounded-2xl md:rounded-[2rem] font-extrabold text-base md:text-xl shadow-2xl shadow-primary/30 transition-all active:scale-[0.98] group"
                >
                  {isGenerating ? <Loader2 className="animate-spin w-6 h-6 md:w-7 md:h-7" /> : <Sparkles className="group-hover:animate-pulse w-6 h-6 md:w-7 md:h-7" />}
                  TẠO BỘ THẺ VỚI AI
                </Button>
              </div>
            </CardContent>
          </Card>
        </section>

        {/* AI Results Section */}
        <section className="lg:col-span-5 space-y-6 md:space-y-8">
          <Card className="premium-panel border-0 bg-transparent shadow-2xl h-full flex flex-col rounded-3xl md:rounded-[3rem] overflow-hidden min-h-[400px]">
            <CardHeader className="p-6 md:p-10 pb-4 md:pb-6 bg-zinc-900 dark:bg-black text-white">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3 md:gap-4">
                  <Sparkles className="text-primary w-6 h-6 md:w-7 md:h-7" />
                  <div>
                    <CardTitle className="text-xl md:text-2xl font-extrabold tracking-tight">Kết quả AI</CardTitle>
                    <CardDescription className="text-[8px] md:text-[10px] font-extrabold uppercase tracking-widest text-white/50">Flashcards Preview</CardDescription>
                  </div>
                </div>
                {generatedCards.length > 0 && (
                  <Button
                    onClick={handleSaveToDeck}
                    disabled={isSaving || generatedCards.length === 0}
                    size="sm"
                    className="bg-primary hover:bg-primary/90 font-extrabold text-[10px] uppercase tracking-widest h-9 px-4 rounded-xl shadow-lg shadow-primary/20"
                  >
                    {isSaving ? <Loader2 className="animate-spin w-3.5 h-3.5 mr-2" /> : <Save className="w-3.5 h-3.5 mr-2" />}
                    Lưu bộ thẻ
                  </Button>
                )}
              </div>
            </CardHeader>
            <CardContent className="p-6 md:p-10 flex-1 overflow-y-auto custom-scrollbar">
              {generatedCards.length > 0 ? (
                <div className="space-y-6 md:space-y-8">
                  <div className="p-4 bg-zinc-50 dark:bg-white/5 rounded-2xl border border-zinc-100 dark:border-white/5 space-y-4">
                    <div className="space-y-2">
                      <label className="text-[9px] font-extrabold text-zinc-400 uppercase tracking-widest">Chọn đích đến</label>
                      <select 
                        value={selectedDeckId}
                        onChange={(e) => setSelectedDeckId(e.target.value)}
                        className="w-full bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-white/10 rounded-xl px-4 py-2 text-sm font-bold text-zinc-900 dark:text-white outline-none focus:border-primary"
                      >
                        <option value="new">+ Tạo bộ thẻ mới</option>
                        {existingDecks.map(deck => (
                          <option key={deck.id} value={deck.id}>{deck.name}</option>
                        ))}
                      </select>
                    </div>

                    {selectedDeckId === 'new' && (
                      <div className="space-y-2">
                        <label className="text-[9px] font-extrabold text-zinc-400 uppercase tracking-widest">Tên bộ thẻ mới</label>
                        <input
                          value={deckName}
                          onChange={(e) => setDeckName(e.target.value)}
                          className="w-full bg-transparent border-none p-0 focus:ring-0 font-extrabold text-lg md:text-xl text-zinc-900 dark:text-white placeholder:text-zinc-300"
                          placeholder="Nhập tên bộ thẻ..."
                        />
                      </div>
                    )}
                    <p className="text-[10px] font-bold text-zinc-400">
                      Sẽ lưu {generatedCards.filter(card => card.front?.trim() && card.back?.trim()).length}/{generatedCards.length} thẻ — sửa hoặc xoá từng thẻ ngay bên dưới trước khi lưu.
                    </p>
                  </div>
                  {generatedCards.map((card, idx) => (
                    <motion.div
                      key={idx}
                      initial={{ opacity: 0, y: 20 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ delay: idx * 0.1 }}
                      className="p-5 md:p-8 bg-zinc-50 dark:bg-white/5 rounded-2xl md:rounded-[2rem] border border-zinc-100 dark:border-white/5 space-y-4 md:space-y-6 hover:border-primary/30 transition-all group"
                    >
                      <div className="flex items-center justify-between">
                        <span className="text-[8px] md:text-[9px] font-extrabold text-zinc-400 uppercase tracking-[0.3em]">Thẻ {idx + 1}</span>
                        <button
                          type="button"
                          onClick={() => removeGeneratedCard(idx)}
                          disabled={isSaving}
                          aria-label={`Xoá thẻ ${idx + 1}`}
                          className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1 text-[10px] font-bold text-zinc-400 transition-colors hover:bg-rose-50 hover:text-rose-500 dark:hover:bg-rose-500/10 disabled:opacity-50"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                          Xoá thẻ
                        </button>
                      </div>
                      <div className="space-y-1.5 md:space-y-2">
                        <span className="text-[8px] md:text-[9px] font-extrabold text-zinc-400 uppercase tracking-[0.3em]">Mặt trước</span>
                        <Textarea
                          value={card.front}
                          onChange={(e) => updateGeneratedCard(idx, 'front', e.target.value)}
                          disabled={isSaving}
                          placeholder="Nội dung mặt trước..."
                          className="min-h-[72px] rounded-xl border-zinc-200 bg-white font-semibold text-zinc-900 focus:border-primary dark:border-white/10 dark:bg-white/5 dark:text-white"
                        />
                      </div>
                      <div className="pt-4 md:pt-6 border-t border-zinc-200 dark:border-white/10 space-y-1.5 md:space-y-2">
                        <span className="text-[8px] md:text-[10px] font-extrabold text-primary uppercase tracking-[0.3em]">Mặt sau</span>
                        <Textarea
                          value={card.back}
                          onChange={(e) => updateGeneratedCard(idx, 'back', e.target.value)}
                          disabled={isSaving}
                          placeholder="Nội dung mặt sau..."
                          className="min-h-[72px] rounded-xl border-zinc-200 bg-white font-medium text-zinc-600 focus:border-primary dark:border-white/10 dark:bg-white/5 dark:text-zinc-300"
                        />
                      </div>
                    </motion.div>
                  ))}
                </div>
              ) : (
                <div className="h-full min-h-[300px] md:min-h-[500px] flex flex-col items-center justify-center text-center p-6 md:p-12 space-y-6 md:space-y-8">
                  <div className="p-6 md:p-10 bg-zinc-50 dark:bg-white/5 rounded-[2rem] md:rounded-[3rem] text-zinc-200 dark:text-zinc-800 border border-zinc-100 dark:border-white/5">
                    <BrainCircuit className="w-16 h-16 md:w-24 md:h-24" />
                  </div>
                  <div className="space-y-2 md:space-y-3">
                    <p className="text-zinc-500 dark:text-zinc-400 font-extrabold uppercase tracking-[0.2em] text-xs md:text-sm">Chưa có dữ liệu</p>
                    <p className="text-[10px] md:text-xs text-zinc-400 max-w-[200px] md:max-w-[240px] font-medium leading-relaxed mx-auto">Cung cấp tài liệu đầu vào để AI bắt đầu phân tích.</p>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        </section>
      </div>
    </div>
  );
}
