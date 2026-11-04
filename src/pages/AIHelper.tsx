import { useState, useRef, useEffect } from 'react';
import { createWorker } from 'tesseract.js';
import * as pdfjsLib from 'pdfjs-dist';
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
  Plus
} from 'lucide-react';
import { generateFlashcardsFromText } from '../services/aiService';
import { toast } from 'sonner';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { collection, addDoc, serverTimestamp, writeBatch, doc, query, where, getDocs, updateDoc, increment } from 'firebase/firestore';
import { db } from '../firebase';
import { useNavigate } from 'react-router-dom';
import { createInitialCardSchedule } from '../lib/spacedRepetition';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

// Dùng worker PDF đóng gói cùng app (không phụ thuộc CDN ngoài).
pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

const MAX_PDF_PAGES = 30;
const MAX_MATERIAL_CHARS = 60000;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const EMPTY_CARDS_MESSAGE = 'AI không tạo được thẻ nào từ nội dung này — thử rút gọn/chia nhỏ tài liệu hoặc kiểm tra lại nội dung.';
const TRUNCATED_MESSAGE = `Nội dung quá dài nên đã được cắt còn ${MAX_MATERIAL_CHARS.toLocaleString('vi-VN')} ký tự đầu — hãy chia nhỏ tài liệu nếu cần tạo thẻ từ phần còn lại.`;

// Cắt nội dung ở giới hạn ký tự, trả về cờ để báo cho người dùng khi bị cắt.
function capMaterialText(text: string): { text: string; truncated: boolean } {
  if (text.length <= MAX_MATERIAL_CHARS) return { text, truncated: false };
  return { text: text.slice(0, MAX_MATERIAL_CHARS), truncated: true };
}

// Trích text từ một trang PDF nhưng giữ cấu trúc dòng/đoạn:
// xuống dòng khi toạ độ dọc thay đổi, cách đoạn khi khoảng cách dọc lớn.
function extractPdfPageText(items: any[]): string {
  let text = '';
  let lastY: number | null = null;
  let lastHeight = 12;
  for (const item of items) {
    if (typeof item?.str !== 'string') continue;
    const y = Array.isArray(item.transform) ? Number(item.transform[5]) : null;
    const height = typeof item.height === 'number' && item.height > 0 ? item.height : lastHeight;
    if (y !== null && lastY !== null) {
      const gap = Math.abs(y - lastY);
      if (gap > Math.max(2, height * 0.5) && text && !text.endsWith('\n')) {
        text += gap > height * 1.6 ? '\n\n' : '\n';
      }
    }
    if (text && !text.endsWith('\n') && !text.endsWith(' ') && item.str) text += ' ';
    text += item.str;
    if (item.hasEOL) text += '\n';
    if (y !== null) lastY = y;
    lastHeight = height;
  }
  return text.trim();
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

  const handlePdfUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file && file.type !== 'application/pdf') {
      toast.error("Vui lòng chọn đúng file PDF.");
      e.target.value = '';
      return;
    }
    if (file && file.type === 'application/pdf') {
      setIsProcessing(true);
      setOcrText('');
      const reader = new FileReader();
      reader.onload = async (event) => {
        const typedArray = new Uint8Array(event.target?.result as ArrayBuffer);
        try {
          const pdf = await pdfjsLib.getDocument(typedArray).promise;
          const totalPages = pdf.numPages;
          const pagesToRead = Math.min(totalPages, MAX_PDF_PAGES);
          if (totalPages > MAX_PDF_PAGES) {
            toast.warning(`PDF có ${totalPages} trang — chỉ trích xuất ${MAX_PDF_PAGES} trang đầu tiên. Hãy tách file nếu cần nội dung các trang sau.`);
          }
          const pageTexts: string[] = [];
          const toastId = toast.loading(`Đang xử lý PDF: 0/${pagesToRead} trang...`);

          for (let i = 1; i <= pagesToRead; i++) {
            const page = await pdf.getPage(i);
            const content = await page.getTextContent();
            pageTexts.push(extractPdfPageText(content.items as any[]));
            toast.loading(`Đang xử lý PDF: ${i}/${pagesToRead} trang...`, { id: toastId });
          }

          const capped = capMaterialText(pageTexts.join('\n\n').trim());
          setOcrText(capped.text);
          if (capped.truncated) toast.warning(TRUNCATED_MESSAGE);
          toast.success(`Đã trích xuất xong ${pagesToRead}${totalPages > pagesToRead ? `/${totalPages}` : ''} trang PDF!`, { id: toastId });
        } catch (error: any) {
          console.error(error);
          toast.error(error?.message ? `Lỗi khi đọc file PDF: ${error.message}` : "Lỗi khi đọc file PDF.");
        } finally {
          setIsProcessing(false);
        }
      };
      reader.onerror = () => {
        setIsProcessing(false);
        toast.error("Không đọc được file PDF. Vui lòng thử lại với file khác.");
      };
      reader.readAsArrayBuffer(file);
    }
  };

  const performOCR = async (imageSrc: string) => {
    setIsProcessing(true);
    let worker: any = null;
    try {
      worker = await createWorker('vie+eng');
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
          cardCount: generatedCards.length,
          createdAt: new Date().toISOString(),
          isPublic: false,
          color: '#4f46e5',
          authorName: profile?.displayName || 'Unknown'
        });
        deckId = deckRef.id;
      } else {
        // Update existing deck card count
        await updateDoc(doc(db, 'decks', selectedDeckId), {
          cardCount: increment(generatedCards.length)
        });
      }

      // 2. Create Flashcards using Batch
      const batch = writeBatch(db);
      generatedCards.forEach(card => {
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
        <h1 className="text-3xl md:text-5xl font-black text-slate-900 dark:text-white tracking-tighter text-balance">Study Copilot</h1>
        <p className="text-slate-500 dark:text-slate-400 text-lg md:text-xl font-medium leading-relaxed">
          Gia sư học tập cá nhân giúp phân tích tài liệu, tóm tắt kiến thức, tạo flashcards và gợi ý câu hỏi nâng cao bằng <span className="text-primary font-bold">Gemini</span>.
        </p>
        <div className="mx-auto grid max-w-3xl grid-cols-2 gap-2 text-left md:grid-cols-5">
          {['Audio', 'Transcript', 'AI Summary', 'Flashcards', 'Quiz'].map((step, index) => (
            <div key={step} className="workflow-step p-3">
              <p className="font-mono text-[10px] font-black text-primary">0{index + 1}</p>
              <p className="mt-1 text-xs font-bold text-slate-700 dark:text-slate-200">{step}</p>
            </div>
          ))}
        </div>
      </header>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 md:gap-10">
        {/* Input Section */}
        <section className="lg:col-span-7 space-y-6 md:space-y-8">
          <Card className="premium-panel border-0 bg-transparent shadow-2xl overflow-hidden rounded-3xl md:rounded-[3rem]">
            <CardHeader className="p-6 md:p-10 pb-4 md:pb-6 border-b border-slate-100 dark:border-white/5">
              <div className="flex items-center gap-3 md:gap-4">
                <div className="p-2.5 md:p-3 bg-primary/10 text-primary rounded-xl md:rounded-2xl">
                  <Settings2 className="w-5 h-5 md:w-6 md:h-6" />
                </div>
                <div>
                  <CardTitle className="text-xl md:text-2xl font-black tracking-tight">Cấu hình đầu vào</CardTitle>
                  <CardDescription className="text-[8px] md:text-[10px] font-black uppercase tracking-widest text-slate-400">Source & AI Options</CardDescription>
                </div>
              </div>
            </CardHeader>
            <CardContent className="p-6 md:p-10 space-y-6 md:space-y-10">
              <div className="space-y-4">
                <label className="text-[9px] md:text-[10px] font-black text-slate-400 uppercase tracking-[0.2em] flex items-center gap-2">
                  <FileText className="w-3.5 h-3.5" />
                  Tài liệu PDF
                </label>
                <div 
                  onClick={() => pdfInputRef.current?.click()}
                  className="group border-2 border-dashed border-slate-200 dark:border-white/10 rounded-2xl md:rounded-[2rem] p-6 flex flex-col items-center justify-center cursor-pointer hover:border-blue-500/50 hover:bg-blue-500/5 transition-all"
                >
                  <div className="flex items-center gap-4">
                    <div className="p-3 bg-blue-50 dark:bg-blue-500/10 rounded-xl text-blue-500">
                      <FileText className="w-6 h-6" />
                    </div>
                    <div className="text-left">
                      <p className="text-sm font-black text-slate-700 dark:text-slate-200 uppercase tracking-widest">Tải lên file PDF</p>
                      <p className="text-[10px] text-slate-400 font-medium">Trích xuất văn bản tối đa 30 trang đầu, giữ cấu trúc đoạn</p>
                    </div>
                  </div>
                  <input 
                    type="file" 
                    ref={pdfInputRef} 
                    onChange={handlePdfUpload} 
                    className="hidden" 
                    accept="application/pdf"
                  />
                </div>
              </div>

              <div className="relative py-2 md:py-4">
                <div className="absolute inset-0 flex items-center"><span className="w-full border-t border-slate-100 dark:border-white/5" /></div>
                <div className="relative flex justify-center text-[8px] md:text-[10px] uppercase tracking-[0.4em]"><span className="bg-white dark:bg-[#0C0D0E] px-4 md:px-6 text-slate-400 font-black">Hoặc</span></div>
              </div>

              <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <label className="text-[9px] md:text-[10px] font-black text-slate-400 uppercase tracking-[0.2em] flex items-center gap-2">
                    <Camera className="w-3.5 h-3.5" />
                    Hình ảnh tài liệu
                  </label>
                  <div className="flex items-center gap-3">
                    <span className="text-[10px] font-black text-slate-400">AI VISION</span>
                    <button 
                      onClick={() => setUseVision(!useVision)}
                      className={`w-10 h-5 rounded-full transition-all relative ${useVision ? 'bg-primary' : 'bg-slate-200 dark:bg-white/10'}`}
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
                  className="group border-2 border-dashed border-slate-200 dark:border-white/10 rounded-2xl md:rounded-[2.5rem] p-8 md:p-12 flex flex-col items-center justify-center cursor-pointer hover:border-primary/50 hover:bg-primary/5 transition-all duration-500"
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
                    <div className="p-4 md:p-6 bg-slate-50 dark:bg-white/5 rounded-full text-slate-300 dark:text-slate-700 mb-4 md:mb-6 group-hover:scale-110 group-hover:text-primary transition-all duration-500">
                      <Camera className="w-8 h-8 md:w-12 md:h-12" />
                    </div>
                    <p className="text-base md:text-lg text-slate-500 dark:text-slate-400 font-black uppercase tracking-widest text-center">Tải ảnh tài liệu</p>
                    <p className="text-[10px] md:text-xs text-slate-400 mt-1 md:mt-2 font-medium">PNG, JPG up to 10MB</p>
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
                  <span className="font-black text-[9px] md:text-xs uppercase tracking-widest">Đang trích xuất...</span>
                </div>
              )}

              <div className="space-y-6 md:space-y-8 pt-6 md:pt-10 border-t border-slate-100 dark:border-white/5">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 md:gap-8">
                  <div className="space-y-2 md:space-y-3">
                    <label className="text-[9px] md:text-[10px] font-black text-slate-400 uppercase tracking-[0.2em]">Số thẻ cần tạo</label>
                    <input 
                      type="number"
                      min="1"
                      max="20"
                      value={cardCount}
                      onChange={(e) => setCardCount(parseInt(e.target.value) || 5)}
                      className="w-full h-12 md:h-14 px-4 md:px-6 rounded-xl md:rounded-2xl border-2 border-slate-100 dark:border-white/5 bg-slate-50 dark:bg-white/5 dark:text-white focus:border-primary outline-none transition-all font-mono font-bold text-lg md:text-xl"
                    />
                  </div>
                  <div className="space-y-2 md:space-y-3">
                    <label className="text-[9px] md:text-[10px] font-black text-slate-400 uppercase tracking-[0.2em]">Nhấn mạnh nội dung</label>
                    <input 
                      placeholder="VD: Định nghĩa..."
                      value={emphasis}
                      onChange={(e) => setEmphasis(e.target.value)}
                      className="w-full h-12 md:h-14 px-4 md:px-6 rounded-xl md:rounded-2xl border-2 border-slate-100 dark:border-white/5 bg-slate-50 dark:bg-white/5 dark:text-white focus:border-primary outline-none transition-all font-medium text-sm md:text-base"
                    />
                  </div>
                </div>

                <div className="space-y-3 md:space-y-4">
                  <div className="flex items-center justify-between">
                    <label className="text-[9px] md:text-[10px] font-black text-slate-400 uppercase tracking-[0.2em]">Dữ liệu thô</label>
                    {ocrText && (
                      <Button variant="ghost" size="sm" onClick={() => copyToClipboard(ocrText)} className="h-8 text-[9px] md:text-[10px] font-black uppercase tracking-widest text-slate-400 hover:text-primary">
                        <Copy size={12} className="mr-2" /> Copy
                      </Button>
                    )}
                  </div>
                  <Textarea 
                    value={ocrText}
                    onChange={(e) => setOcrText(e.target.value)}
                    placeholder="Quét hoặc dán văn bản..."
                    className="min-h-[200px] md:min-h-[250px] rounded-2xl md:rounded-3xl border-2 border-slate-100 dark:border-white/5 bg-slate-50 dark:bg-white/5 dark:text-white text-sm md:text-base leading-relaxed font-medium p-4 md:p-8 focus:border-primary transition-all"
                  />
                </div>

                <Button
                  onClick={handleGenerateCards}
                  disabled={(!ocrText.trim() && !image) || isGenerating}
                  className="w-full bg-primary hover:bg-primary/90 gap-3 md:gap-4 h-16 md:h-20 rounded-2xl md:rounded-[2rem] font-black text-base md:text-xl shadow-2xl shadow-primary/30 transition-all active:scale-[0.98] group"
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
            <CardHeader className="p-6 md:p-10 pb-4 md:pb-6 bg-slate-900 dark:bg-black text-white">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3 md:gap-4">
                  <Sparkles className="text-primary w-6 h-6 md:w-7 md:h-7" />
                  <div>
                    <CardTitle className="text-xl md:text-2xl font-black tracking-tight">Kết quả AI</CardTitle>
                    <CardDescription className="text-[8px] md:text-[10px] font-black uppercase tracking-widest text-white/50">Flashcards Preview</CardDescription>
                  </div>
                </div>
                {generatedCards.length > 0 && (
                  <Button 
                    onClick={handleSaveToDeck}
                    disabled={isSaving}
                    size="sm"
                    className="bg-primary hover:bg-primary/90 font-black text-[10px] uppercase tracking-widest h-9 px-4 rounded-xl shadow-lg shadow-primary/20"
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
                  <div className="p-4 bg-slate-50 dark:bg-white/5 rounded-2xl border border-slate-100 dark:border-white/5 space-y-4">
                    <div className="space-y-2">
                      <label className="text-[9px] font-black text-slate-400 uppercase tracking-widest">Chọn đích đến</label>
                      <select 
                        value={selectedDeckId}
                        onChange={(e) => setSelectedDeckId(e.target.value)}
                        className="w-full bg-white dark:bg-slate-900 border border-slate-200 dark:border-white/10 rounded-xl px-4 py-2 text-sm font-bold text-slate-900 dark:text-white outline-none focus:border-primary"
                      >
                        <option value="new">+ Tạo bộ thẻ mới</option>
                        {existingDecks.map(deck => (
                          <option key={deck.id} value={deck.id}>{deck.name}</option>
                        ))}
                      </select>
                    </div>

                    {selectedDeckId === 'new' && (
                      <div className="space-y-2">
                        <label className="text-[9px] font-black text-slate-400 uppercase tracking-widest">Tên bộ thẻ mới</label>
                        <input 
                          value={deckName}
                          onChange={(e) => setDeckName(e.target.value)}
                          className="w-full bg-transparent border-none p-0 focus:ring-0 font-black text-lg md:text-xl text-slate-900 dark:text-white placeholder:text-slate-300"
                          placeholder="Nhập tên bộ thẻ..."
                        />
                      </div>
                    )}
                  </div>
                  {generatedCards.map((card, idx) => (
                    <motion.div 
                      key={idx} 
                      initial={{ opacity: 0, y: 20 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ delay: idx * 0.1 }}
                      className="p-5 md:p-8 bg-slate-50 dark:bg-white/5 rounded-2xl md:rounded-[2rem] border border-slate-100 dark:border-white/5 space-y-4 md:space-y-6 hover:border-primary/30 transition-all group"
                    >
                      <div className="space-y-1.5 md:space-y-2">
                        <span className="text-[8px] md:text-[9px] font-black text-slate-400 uppercase tracking-[0.3em]">Mặt trước</span>
                        <div className="text-slate-900 dark:text-white font-black text-lg md:text-xl leading-tight tracking-tight prose dark:prose-invert max-w-none">
                          <ReactMarkdown remarkPlugins={[remarkGfm]}>
                            {card.front}
                          </ReactMarkdown>
                        </div>
                      </div>
                      <div className="pt-4 md:pt-6 border-t border-slate-200 dark:border-white/10 space-y-1.5 md:space-y-2">
                        <span className="text-[8px] md:text-[10px] font-black text-primary uppercase tracking-[0.3em]">Mặt sau</span>
                        <div className="text-sm md:text-base text-slate-600 dark:text-slate-400 leading-relaxed font-medium prose dark:prose-invert max-w-none">
                          <ReactMarkdown remarkPlugins={[remarkGfm]}>
                            {card.back}
                          </ReactMarkdown>
                        </div>
                      </div>
                    </motion.div>
                  ))}
                </div>
              ) : (
                <div className="h-full min-h-[300px] md:min-h-[500px] flex flex-col items-center justify-center text-center p-6 md:p-12 space-y-6 md:space-y-8">
                  <div className="p-6 md:p-10 bg-slate-50 dark:bg-white/5 rounded-[2rem] md:rounded-[3rem] text-slate-200 dark:text-slate-800 border border-slate-100 dark:border-white/5">
                    <BrainCircuit className="w-16 h-16 md:w-24 md:h-24" />
                  </div>
                  <div className="space-y-2 md:space-y-3">
                    <p className="text-slate-500 dark:text-slate-400 font-black uppercase tracking-[0.2em] text-xs md:text-sm">Chưa có dữ liệu</p>
                    <p className="text-[10px] md:text-xs text-slate-400 max-w-[200px] md:max-w-[240px] font-medium leading-relaxed mx-auto">Cung cấp tài liệu đầu vào để AI bắt đầu phân tích.</p>
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
