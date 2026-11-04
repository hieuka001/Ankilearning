import { useState, useRef } from 'react';
import { collection, addDoc, serverTimestamp } from 'firebase/firestore';
import * as pdfjsLib from 'pdfjs-dist';
import { db, auth } from '../firebase';
import { User } from 'firebase/auth';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Textarea } from '@/components/ui/textarea';
import { 
  ArrowLeft, 
  Save, 
  Plus, 
  Trash2, 
  Sparkles,
  Loader2,
  Link as LinkIcon,
  Image as ImageIcon,
  Globe,
  FileText
} from 'lucide-react';
import { useNavigate, Link } from 'react-router-dom';
import { toast } from 'sonner';
import { generateFlashcardsFromText } from '../services/aiService';
import { playSound } from '../lib/sounds';
import { useSettings } from '../contexts/SettingsContext';
import { createInitialCardSchedule } from '../lib/spacedRepetition';
import { CATEGORY_PRESETS, getCategoryArt } from '../lib/categoryArt';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

// Dùng worker PDF đóng gói cùng app (không phụ thuộc CDN ngoài).
pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

const EMPTY_CARDS_MESSAGE = 'AI không tạo được thẻ nào từ nội dung này — thử rút gọn/chia nhỏ tài liệu hoặc kiểm tra lại nội dung.';

import { UserProfile } from '../types';

interface CreateDeckProps {
  user: User | null;
  profile: UserProfile | null;
}

export default function CreateDeck({ user, profile }: CreateDeckProps) {
  const navigate = useNavigate();
  const { settings } = useSettings();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [category, setCategory] = useState('');
  const [cards, setCards] = useState<{ front: string, back: string, imageUrl?: string }[]>([{ front: '', back: '' }]);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [aiText, setAiText] = useState('');
  const [aiImage, setAiImage] = useState<string | null>(null);
  const [isGenerating, setIsGenerating] = useState(false);
  const [isProcessingPdf, setIsProcessingPdf] = useState(false);
  const [isPublic, setIsPublic] = useState(false);
  const [color, setColor] = useState('#4f46e5');
  const [tags, setTags] = useState('');
  const pdfInputRef = useRef<HTMLInputElement>(null);

  const addCard = () => {
    setCards([...cards, { front: '', back: '' }]);
  };

  const removeCard = (index: number) => {
    setCards(cards.filter((_, i) => i !== index));
  };

  const updateCard = (index: number, field: 'front' | 'back' | 'imageUrl', value: string) => {
    const newCards = [...cards];
    newCards[index][field] = value;
    setCards(newCards);
  };

  const handleGenerateAI = async () => {
    if (!aiText.trim()) {
      toast.error("Vui lòng nhập nội dung để AI tạo thẻ.");
      return;
    }

    setIsGenerating(true);
    try {
      const generated = await generateFlashcardsFromText(
        aiText, 
        5, 
        "", 
        { geminiApiKey: profile?.settings?.geminiApiKey || profile?.settings?.aiApiKey },
        aiImage || undefined
      );
      if (generated && generated.length > 0) {
        setCards([...cards.filter(c => c.front || c.back), ...generated]);
        toast.success(`Đã tạo ${generated.length} thẻ từ AI!`);
        setAiText('');
        setAiImage(null);
      } else {
        toast.warning(EMPTY_CARDS_MESSAGE);
      }
    } catch (error: any) {
      console.error(error);
      toast.error(error?.message || "Lỗi khi gọi AI.");
    } finally {
      setIsGenerating(false);
    }
  };

  const handleImportFromUrl = async () => {
    const input = document.getElementById('urlInput') as HTMLInputElement;
    const url = input.value.trim();
    if (!url) {
      toast.error("Vui lòng nhập URL.");
      return;
    }

    setIsGenerating(true);
    const toastId = toast.loading("Đang tải dữ liệu từ URL...");
    try {
      const response = await fetch(url);
      if (!response.ok) throw new Error("Không thể tải dữ liệu từ URL này.");
      
      const contentType = response.headers.get('content-type');
      
      // If it's an image, add as a single card
      if (contentType?.startsWith('image/')) {
        setCards([...cards.filter(c => c.front || c.back), { front: 'Hình ảnh mới', back: 'Xem hình ảnh', imageUrl: url }]);
        toast.success("Đã thêm thẻ hình ảnh!");
      } else {
        // Try to parse as JSON for multiple cards
        let data: any;
        try {
          data = JSON.parse(await response.text());
        } catch {
          toast.error("Nội dung tải về không phải JSON hợp lệ — không đọc được danh sách thẻ. Hãy kiểm tra lại URL (nên là link 'Raw').");
          return;
        }
        if (Array.isArray(data)) {
          const newCards = data.map((item: any) => ({
            front: item.front || item.question || '',
            back: item.back || item.answer || '',
            imageUrl: item.imageUrl || item.image || ''
          })).filter(c => c.front && c.back);

          if (newCards.length > 0) {
            setCards([...cards.filter(c => c.front || c.back), ...newCards]);
            toast.success(`Đã nhập thành công ${newCards.length} thẻ!`);
          } else {
            toast.error("Không tìm thấy thẻ hợp lệ nào trong JSON — mỗi thẻ cần có đủ mặt trước (front/question) và mặt sau (back/answer).");
          }
        } else {
          toast.error("URL không trả về danh sách thẻ hợp lệ (JSON Array).");
        }
      }
      input.value = '';
    } catch (error: any) {
      console.error(error);
      toast.error(error?.message?.startsWith('Không thể tải')
        ? error.message
        : "Lỗi khi tải dữ liệu. Đảm bảo URL là link 'Raw' và cho phép truy cập (CORS).");
    } finally {
      setIsGenerating(false);
      toast.dismiss(toastId);
    }
  };

  const handleAIImageUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      const reader = new FileReader();
      reader.onload = (event) => {
        setAiImage(event.target?.result as string);
        toast.success("Đã tải hình ảnh. Nhấn 'Tạo thẻ bằng AI' để phân tích.");
      };
      reader.readAsDataURL(file);
    }
  };

  const handlePdfUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file && file.type === 'application/pdf') {
      setIsProcessingPdf(true);
      const reader = new FileReader();
      reader.onload = async (event) => {
        const typedArray = new Uint8Array(event.target?.result as ArrayBuffer);
        try {
          const pdf = await pdfjsLib.getDocument(typedArray).promise;
          let fullText = '';
          const toastId = toast.loading(`Đang xử lý PDF: 0/${pdf.numPages} trang...`);
          
          for (let i = 1; i <= pdf.numPages; i++) {
            const page = await pdf.getPage(i);
            const content = await page.getTextContent();
            const strings = content.items.map((item: any) => item.str);
            fullText += strings.join(' ') + '\n\n';
            toast.loading(`Đang xử lý PDF: ${i}/${pdf.numPages} trang...`, { id: toastId });
          }
          
          setAiText(prev => (prev ? prev + '\n\n' : '') + fullText.trim());
          toast.success(`Đã thêm ${pdf.numPages} trang PDF vào nội dung AI!`, { id: toastId });
        } catch (error: any) {
          console.error(error);
          toast.error(error?.message ? `Lỗi khi đọc file PDF: ${error.message}` : "Lỗi khi đọc file PDF.");
        } finally {
          setIsProcessingPdf(false);
        }
      };
      reader.onerror = () => {
        setIsProcessingPdf(false);
        toast.error("Không đọc được file PDF. Vui lòng thử lại với file khác.");
      };
      reader.readAsArrayBuffer(file);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) {
      toast.error("Vui lòng nhập tên bộ thẻ.");
      return;
    }

    const validCards = cards.filter(c => c.front.trim() && c.back.trim());
    if (validCards.length === 0) {
      toast.error("Vui lòng thêm ít nhất một thẻ hoàn chỉnh.");
      return;
    }

    const toastId = toast.loading("Đang lưu bộ thẻ...");
    setIsSubmitting(true);
    try {
      if (!user) {
        toast.dismiss(toastId);
        return;
      }

      // Create Deck
      const deckRef = await addDoc(collection(db, 'decks'), {
        ownerId: user.uid,
        authorName: profile?.displayName || 'Ẩn danh',
        name,
        description,
        category: category || 'Chung',
        cardCount: validCards.length,
        createdAt: new Date().toISOString(),
        isPublic,
        color,
        tags: tags.split(',').map(tag => tag.trim()).filter(tag => tag !== '')
      });

      // Create Cards
      const cardsBatch = validCards.map(card => 
        addDoc(collection(db, `decks/${deckRef.id}/cards`), {
          deckId: deckRef.id,
          ownerId: user.uid,
          front: card.front,
          back: card.back,
          imageUrl: card.imageUrl || '',
          tags: [],
          ...createInitialCardSchedule(),
          createdAt: new Date().toISOString()
        })
      );

      await Promise.all(cardsBatch);

      toast.dismiss(toastId);
      playSound('success', settings.volume);
      toast.success("Đã tạo bộ thẻ thành công!");
      navigate('/decks');
    } catch (error) {
      toast.dismiss(toastId);
      toast.error("Lỗi khi lưu bộ thẻ.");
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="space-y-10 pb-32 animate-in fade-in slide-in-from-right-8 duration-700 font-sans">
      <header className="flex items-center gap-6 border-b border-slate-200 dark:border-white/5 pb-8">
        <Link to="/decks">
          <Button variant="ghost" size="icon" className="rounded-2xl hover:bg-slate-100 dark:hover:bg-white/5 h-12 w-12">
            <ArrowLeft className="w-6 h-6" />
          </Button>
        </Link>
        <div>
          <h1 className="text-5xl font-black text-slate-900 dark:text-white tracking-tighter">Tạo bộ thẻ mới</h1>
          <p className="text-slate-500 dark:text-slate-400 font-medium mt-1">Xây dựng thư viện kiến thức cá nhân của bạn.</p>
        </div>
      </header>

      <form onSubmit={handleSubmit} className="space-y-10">
        <Card className="border border-slate-200 dark:border-white/5 shadow-2xl overflow-hidden bg-white dark:bg-[#0C0D0E] rounded-[2rem]">
          <CardHeader className="p-8 pb-4 border-b border-slate-100 dark:border-white/5 bg-slate-50/50 dark:bg-white/5">
            <CardTitle className="text-xl font-black tracking-tight">Thông tin bộ thẻ</CardTitle>
            <CardDescription className="text-[10px] font-black uppercase tracking-widest text-slate-400">Thông tin chung</CardDescription>
          </CardHeader>
          <CardContent className="p-8 space-y-8">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
              <div className="space-y-3">
                <label className="text-[10px] font-black text-slate-400 uppercase tracking-[0.2em]">Tên bộ thẻ *</label>
                <Input 
                  placeholder="Ví dụ: Tiếng Anh giao tiếp" 
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="h-12 px-5 rounded-2xl border-slate-200 dark:border-white/10 dark:bg-white/5 dark:text-white focus:ring-2 focus:ring-primary/20 focus:border-primary outline-none transition-all font-medium"
                />
              </div>
              <div className="space-y-3">
                <label className="text-[10px] font-black text-slate-400 uppercase tracking-[0.2em]">Chủ đề</label>
                <Input 
                  placeholder="Ví dụ: Ngôn ngữ, Khoa học..." 
                  value={category}
                  onChange={(e) => setCategory(e.target.value)}
                  className="h-12 px-5 rounded-2xl border-slate-200 dark:border-white/10 dark:bg-white/5 dark:text-white focus:ring-2 focus:ring-primary/20 focus:border-primary outline-none transition-all font-medium"
                />
              </div>
              <div className="space-y-3">
                <label className="text-[10px] font-black text-slate-400 uppercase tracking-[0.2em]">Tags (Phân tách bằng dấu phẩy)</label>
                <Input 
                  placeholder="ngoại, tim mạch, tiêu hóa..." 
                  value={tags}
                  onChange={(e) => setTags(e.target.value)}
                  className="h-12 px-5 rounded-2xl border-slate-200 dark:border-white/10 dark:bg-white/5 dark:text-white focus:ring-2 focus:ring-primary/20 focus:border-primary outline-none transition-all font-medium"
                />
              </div>
            </div>
            <div className="space-y-3">
              <label className="text-[10px] font-black text-slate-400 uppercase tracking-[0.2em]">Chọn nhanh danh mục</label>
              <div className="flex flex-wrap gap-2">
                {CATEGORY_PRESETS.map((preset) => (
                  <button
                    key={preset.label}
                    type="button"
                    onClick={() => setCategory(preset.label)}
                    className={`rounded-full px-4 py-2 text-xs font-bold transition-all ${
                      category === preset.label
                        ? 'bg-primary text-white shadow-lg shadow-primary/25'
                        : 'bg-slate-100 text-slate-600 hover:bg-slate-200 dark:bg-white/5 dark:text-slate-300 dark:hover:bg-white/10'
                    }`}
                  >
                    {preset.label}
                  </button>
                ))}
              </div>
              <div className="relative overflow-hidden rounded-2xl border border-slate-200 dark:border-white/10">
                <img
                  src={getCategoryArt(category)}
                  alt="Xem trước ảnh bìa theo danh mục"
                  loading="lazy"
                  decoding="async"
                  className="h-32 w-full object-cover"
                />
                <span className="absolute bottom-3 left-4 rounded-lg bg-black/45 px-3 py-1 text-[10px] font-bold uppercase tracking-widest text-white backdrop-blur-sm">
                  Ảnh bìa: {category || 'Chung'}
                </span>
              </div>
            </div>
            <div className="space-y-3">
              <label className="text-[10px] font-black text-slate-400 uppercase tracking-[0.2em]">Mô tả</label>
              <Textarea 
                placeholder="Mô tả ngắn gọn về bộ thẻ này..." 
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                className="rounded-2xl border-slate-200 dark:border-white/10 dark:bg-white/5 dark:text-white min-h-[120px] p-5 focus:ring-primary/20"
              />
            </div>
            <div className="space-y-3">
              <label className="text-[10px] font-black text-slate-400 uppercase tracking-[0.2em]">Màu đại diện</label>
              <div className="flex items-center gap-4">
                <Input 
                  type="color" 
                  value={color}
                  onChange={(e) => setColor(e.target.value)}
                  className="w-16 h-12 p-1 rounded-xl cursor-pointer"
                />
                <div className="flex gap-2">
                  {['#4f46e5', '#ef4444', '#f59e0b', '#10b981', '#3b82f6', '#8b5cf6', '#ec4899'].map(c => (
                    <button
                      key={c}
                      type="button"
                      onClick={() => setColor(c)}
                      className={`w-8 h-8 rounded-full border-2 transition-all ${color === c ? 'border-primary scale-110 shadow-lg' : 'border-transparent hover:scale-105'}`}
                      style={{ backgroundColor: c }}
                    />
                  ))}
                </div>
              </div>
            </div>
            <div className="flex items-center gap-3 pt-2">
              <div className="relative flex items-center">
                <input 
                  type="checkbox" 
                  id="isPublic" 
                  checked={isPublic}
                  onChange={(e) => setIsPublic(e.target.checked)}
                  className="w-5 h-5 text-primary rounded-lg border-slate-300 dark:border-white/10 focus:ring-primary bg-white dark:bg-white/5"
                />
              </div>
              <label htmlFor="isPublic" className="text-xs font-bold text-slate-600 dark:text-slate-400 flex items-center gap-2 cursor-pointer select-none">
                <Globe size={16} className="text-slate-400" />
                Công khai bộ thẻ này (Mọi người có thể tìm thấy và học)
              </label>
            </div>
          </CardContent>
        </Card>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
          <Card className="border border-primary/20 border-dashed shadow-xl overflow-hidden bg-primary/5 rounded-[2rem]">
            <CardHeader className="p-8 pb-4">
              <CardTitle className="text-primary flex items-center gap-3 text-xl font-black tracking-tight">
                <Sparkles className="w-6 h-6" />
                Tạo thẻ nhanh với AI
              </CardTitle>
              <CardDescription className="text-[10px] font-black uppercase tracking-widest text-primary/60">Tạo bởi AI</CardDescription>
            </CardHeader>
            <CardContent className="p-8 pt-0 space-y-6">
              <div className="flex gap-4 items-center">
                <div 
                  onClick={() => document.getElementById('ai-image-upload')?.click()}
                  className={`flex-shrink-0 w-20 h-20 rounded-2xl border-2 border-dashed border-primary/20 flex flex-col items-center justify-center cursor-pointer hover:bg-primary/5 transition-all overflow-hidden ${aiImage ? 'border-solid' : ''}`}
                >
                  {aiImage ? (
                    <img src={aiImage} alt="AI input" className="w-full h-full object-cover" />
                  ) : (
                    <>
                      <ImageIcon className="w-6 h-6 text-primary/40" />
                      <span className="text-[8px] font-black mt-1 text-primary/40">ẢNH</span>
                    </>
                  )}
                </div>
                <Textarea 
                  placeholder="Dán nội dung hoặc chọn ảnh bài học..." 
                  value={aiText}
                  onChange={(e) => setAiText(e.target.value)}
                  className="rounded-2xl border-primary/10 min-h-[80px] bg-white dark:bg-white/5 dark:text-white p-4 focus:ring-primary/20 flex-1"
                />
              </div>
              <div className="flex flex-col sm:flex-row gap-3">
                <Button 
                  type="button"
                  variant="outline"
                  onClick={() => pdfInputRef.current?.click()}
                  disabled={isProcessingPdf}
                  className="flex-1 border-primary/20 text-primary hover:bg-primary/5 h-12 rounded-xl gap-2 font-bold"
                >
                  {isProcessingPdf ? <Loader2 className="animate-spin w-4 h-4" /> : <FileText className="w-4 h-4" />}
                  Nhập từ PDF
                </Button>
                <input 
                  type="file" 
                  ref={pdfInputRef} 
                  className="hidden" 
                  accept="application/pdf" 
                  onChange={handlePdfUpload}
                />
              </div>
              <input 
                type="file" 
                id="ai-image-upload" 
                className="hidden" 
                accept="image/*" 
                onChange={handleAIImageUpload}
              />
              <Button 
                type="button"
                onClick={handleGenerateAI}
                disabled={isGenerating || !aiText.trim()}
                className="w-full bg-primary hover:bg-primary/90 text-white gap-3 h-14 rounded-2xl font-black shadow-lg shadow-primary/20"
              >
                {isGenerating ? <Loader2 className="animate-spin w-5 h-5" /> : <Sparkles className="w-5 h-5" />}
                Tạo thẻ bằng AI
              </Button>
            </CardContent>
          </Card>

          <Card className="border border-emerald-500/20 border-dashed shadow-xl overflow-hidden bg-emerald-500/5 rounded-[2rem]">
            <CardHeader className="p-8 pb-4">
              <CardTitle className="text-emerald-600 dark:text-emerald-400 flex items-center gap-3 text-xl font-black tracking-tight">
                <LinkIcon className="w-6 h-6" />
                Nhập từ URL hình ảnh
              </CardTitle>
              <CardDescription className="text-[10px] font-black uppercase tracking-widest text-emerald-500/60">Nguồn bên ngoài</CardDescription>
            </CardHeader>
            <CardContent className="p-8 pt-0 space-y-6">
              <p className="text-xs text-emerald-600/80 dark:text-emerald-400/80 font-medium leading-relaxed">
                Nhập link hình ảnh (ví dụ từ GitHub) để tạo thẻ mới với hình ảnh minh họa.
              </p>
              <div className="flex gap-3">
                <Input 
                  id="urlInput"
                  placeholder="https://raw.githubusercontent.com/..." 
                  className="h-14 rounded-2xl border-emerald-500/10 bg-white dark:bg-white/5 dark:text-white px-5"
                />
                <Button 
                  type="button"
                  onClick={handleImportFromUrl}
                  disabled={isGenerating}
                  className="bg-emerald-600 hover:bg-emerald-700 text-white h-14 px-8 rounded-2xl font-black"
                >
                  {isGenerating ? <Loader2 className="animate-spin w-5 h-5" /> : 'Thêm'}
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>

        <div className="space-y-6">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 bg-slate-100 dark:bg-white/5 rounded-xl flex items-center justify-center font-black text-slate-400">
                {cards.length}
              </div>
              <h2 className="text-2xl font-black text-slate-900 dark:text-white tracking-tighter">Danh sách thẻ</h2>
            </div>
            <Button 
              type="button" 
              onClick={addCard}
              variant="outline" 
              className="border-primary text-primary hover:bg-primary/5 h-12 px-6 rounded-2xl gap-2 font-black"
            >
              <Plus size={18} /> Thêm thẻ thủ công
            </Button>
          </div>

          <div className="space-y-6">
            {cards.map((card, index) => (
              <Card key={index} className="border border-slate-200 dark:border-white/5 shadow-xl relative group bg-white dark:bg-[#0C0D0E] rounded-[2rem] overflow-hidden">
                <CardContent className="p-8 space-y-6">
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
                    <div className="space-y-3">
                      <label className="text-[9px] font-black text-slate-400 uppercase tracking-[0.2em]">Mặt trước (Câu hỏi)</label>
                      <Textarea 
                        placeholder="Nhập câu hỏi..." 
                        value={card.front}
                        onChange={(e) => updateCard(index, 'front', e.target.value)}
                        className="rounded-2xl border-slate-100 dark:border-white/5 dark:bg-white/5 dark:text-white min-h-[100px] p-5 focus:ring-primary/20 font-medium"
                      />
                    </div>
                    <div className="space-y-3">
                      <label className="text-[9px] font-black text-slate-400 uppercase tracking-[0.2em]">Mặt sau (Câu trả lời)</label>
                      <Textarea 
                        placeholder="Nhập câu trả lời..." 
                        value={card.back}
                        onChange={(e) => updateCard(index, 'back', e.target.value)}
                        className="rounded-2xl border-slate-100 dark:border-white/5 dark:bg-white/5 dark:text-white min-h-[100px] p-5 focus:ring-primary/20 font-medium"
                      />
                    </div>
                  </div>
                  
                  <div className="space-y-3">
                    <label className="text-[9px] font-black text-slate-400 uppercase tracking-[0.2em] flex items-center gap-2">
                      <ImageIcon size={14} /> Link hình ảnh (Tùy chọn)
                    </label>
                    <Input 
                      placeholder="https://..." 
                      value={card.imageUrl || ''}
                      onChange={(e) => updateCard(index, 'imageUrl', e.target.value)}
                      className="h-12 px-5 rounded-2xl border-slate-100 dark:border-white/5 dark:bg-white/5 dark:text-white focus:ring-primary/20 font-medium"
                    />
                    {card.imageUrl && (
                      <div className="mt-4 relative w-40 h-24 rounded-2xl overflow-hidden border border-slate-200 dark:border-white/10 shadow-lg">
                        <img 
                          src={card.imageUrl} 
                          alt="Preview" 
                          className="w-full h-full object-cover"
                          referrerPolicy="no-referrer"
                          onError={(e) => {
                            (e.target as HTMLImageElement).src = 'https://placehold.co/400x300?text=Lỗi+ảnh';
                          }}
                        />
                      </div>
                    )}
                  </div>

                  {cards.length > 1 && (
                    <button 
                      type="button"
                      onClick={() => removeCard(index)}
                      className="absolute top-6 right-6 p-2 bg-slate-50 dark:bg-white/5 text-slate-400 hover:text-rose-500 rounded-xl shadow-sm opacity-0 group-hover:opacity-100 transition-all"
                    >
                      <Trash2 size={18} />
                    </button>
                  )}
                </CardContent>
              </Card>
            ))}
          </div>
        </div>

        <div className="fixed bottom-10 left-1/2 -translate-x-1/2 md:left-auto md:right-10 md:translate-x-0 z-50">
          <Button 
            type="submit"
            disabled={isSubmitting}
            className="bg-primary hover:bg-primary/90 text-white px-10 h-16 rounded-2xl shadow-2xl shadow-primary/30 gap-3 text-xl font-black transition-all active:scale-95"
          >
            {isSubmitting ? <Loader2 className="animate-spin w-6 h-6" /> : <Save className="w-6 h-6" />}
            Lưu bộ thẻ
          </Button>
        </div>
      </form>
    </div>
  );
}
