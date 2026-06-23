import { useState, useEffect } from 'react';
import { collection, query, where, orderBy, onSnapshot, getDocs } from 'firebase/firestore';
import { db, auth } from '../firebase';
import { User } from 'firebase/auth';
import { Deck, Flashcard } from '../types';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { 
  Plus, 
  Search, 
  Library, 
  BookOpen, 
  MoreVertical,
  ArrowRight,
  RotateCcw,
  FileUp,
  Tag as TagIcon
} from 'lucide-react';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import { useSettings } from '../contexts/SettingsContext';
import { importAnkiApkg } from '../services/ankiService';
import { uploadAnkiMedia } from '../services/ankiMediaStorage';
import { createInitialCardSchedule, isCardDue } from '../lib/spacedRepetition';
import { addDoc } from 'firebase/firestore';
import { useRef } from 'react';

interface DecksProps {
  user: User | null;
}

interface DeckStudyStats {
  learned: number;
  due: number;
  lastStudied?: string;
}

export default function Decks({ user }: DecksProps) {
  const { settings } = useSettings();
  const [decks, setDecks] = useState<Deck[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedTag, setSelectedTag] = useState<string | null>(null);
  const [isImporting, setIsImporting] = useState(false);
  const [deckStats, setDeckStats] = useState<Record<string, DeckStudyStats>>({});
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!user) {
      return;
    }
    
    setLoading(true);
    const q = query(
      collection(db, 'decks'),
      where('ownerId', '==', user.uid)
    );

    const unsubscribe = onSnapshot(q, (snap) => {
      const decksData = snap.docs.map(doc => ({ id: doc.id, ...doc.data() } as Deck));
      decksData.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
      setDecks(decksData);
      setLoading(false);

      Promise.all(
        decksData.map(async (deck) => {
          const cardsSnap = await getDocs(collection(db, `decks/${deck.id}/cards`));
          const cards = cardsSnap.docs.map((cardDoc) => ({ id: cardDoc.id, ...cardDoc.data() } as Flashcard));
          const learned = cards.filter((card) => (card.reps || card.repetitions || 0) > 0 || card.state === 'review').length;
          const due = cards.filter((card) => isCardDue(card)).length;
          const lastStudied = cards
            .map((card) => typeof card.lastReview === 'string' ? card.lastReview : card.lastReview?.reviewTime)
            .filter(Boolean)
            .sort((a, b) => new Date(String(b)).getTime() - new Date(String(a)).getTime())[0];

          return [deck.id, { learned, due, lastStudied }] as const;
        })
      )
        .then((entries) => setDeckStats(Object.fromEntries(entries)))
        .catch(() => setDeckStats({}));
    }, (error) => {
      console.error("Decks: Error fetching decks:", error);
      toast.error("Không thể tải danh sách bộ thẻ: " + error.message);
      setLoading(false);
    });

    return () => unsubscribe();
  }, [user]);

  const handleRefresh = async () => {
    if (!user) return;
    setLoading(true);
    try {
      const q = query(collection(db, 'decks'), where('ownerId', '==', user.uid));
      const snap = await getDocs(q);
      const decksData = snap.docs.map(doc => ({ id: doc.id, ...doc.data() } as Deck));
      decksData.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
      setDecks(decksData);
      toast.success("Đã làm mới danh sách.");
    } catch (error) {
      console.error(error);
      toast.error("Lỗi khi làm mới.");
    } finally {
      setLoading(false);
    }
  };

  const handleImportAnki = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !user) return;

    setIsImporting(true);
    const toastId = toast.loading("Đang nhập dữ liệu từ Anki...");

    try {
      const ankiDecks = await importAnkiApkg(file, {
        onLargeMedia: async (filename, data, mimeType) => {
          try {
            return await uploadAnkiMedia(user.uid, filename, data, mimeType);
          } catch (error) {
            console.warn('Không thể tải media lên Storage:', filename, error);
            return undefined;
          }
        },
      });
      if (ankiDecks.length === 0) {
        toast.error("Không tìm thấy thẻ nào trong tệp Anki.", { id: toastId });
        return;
      }

      for (const ankiDeck of ankiDecks) {
        const deckRef = await addDoc(collection(db, 'decks'), {
          ownerId: user.uid,
          authorName: user.displayName || 'User',
          name: ankiDeck.name,
          description: `Nhập từ Anki (${ankiDeck.cards.length} thẻ)`,
          category: "Tiếng Trung",
          cardCount: ankiDeck.cards.length,
          createdAt: new Date().toISOString(),
          isPublic: false
        });

        const cardPromises = ankiDeck.cards.map(card =>
          addDoc(collection(db, `decks/${deckRef.id}/cards`), {
            deckId: deckRef.id,
            ownerId: user.uid,
            front: card.front,
            back: card.back,
            type: card.type || 'basic',
            noteType: card.noteType || '',
            noteId: card.noteId || '',
            extraFields: card.extraFields || {},
            imageUrl: card.frontImage || '',
            backImageUrl: card.backImage || '',
            frontImages: card.frontImages || [],
            backImages: card.backImages || [],
            frontAudio: card.frontAudio || [],
            backAudio: card.backAudio || [],
            audioUrls: card.audioUrls || [...(card.frontAudio || []), ...(card.backAudio || [])],
            tags: card.tags || [],
            ...createInitialCardSchedule(),
            createdAt: new Date().toISOString()
          })
        );

        await Promise.all(cardPromises);
      }

      toast.success(`Đã nhập thành công ${ankiDecks.length} bộ thẻ từ Anki.`, { id: toastId });
      const importedAudioCount = ankiDecks.reduce((sum, deck) => sum + (deck.importedAudioCount || 0), 0);
      const skippedAudioCount = ankiDecks.reduce((sum, deck) => sum + (deck.skippedAudioCount || 0), 0);
      const importedImageCount = ankiDecks.reduce((sum, deck) => sum + (deck.importedImageCount || 0), 0);
      const skippedImageCount = ankiDecks.reduce((sum, deck) => sum + (deck.skippedImageCount || 0), 0);
      if (importedAudioCount > 0 || skippedAudioCount > 0 || importedImageCount > 0 || skippedImageCount > 0) {
        toast.info(
          `Media Anki: ${importedAudioCount} audio, ${importedImageCount} ảnh đã đồng bộ` +
          (skippedAudioCount + skippedImageCount > 0 ? `; ${skippedAudioCount + skippedImageCount} file quá lớn đã bỏ qua.` : '.')
        );
      }
      handleRefresh();
    } catch (error: any) {
      console.error("Anki Import Error:", error);
      toast.error("Lỗi khi nhập tệp Anki: " + (error.message || "Lỗi không xác định"), { id: toastId });
    } finally {
      setIsImporting(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const filteredDecks = decks.filter(deck => {
    const matchesSearch = deck.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
      deck.category.toLowerCase().includes(searchTerm.toLowerCase());
    const matchesTag = !selectedTag || (deck.tags && deck.tags.includes(selectedTag));
    return matchesSearch && matchesTag;
  });

  const allTags = Array.from(new Set(decks.flatMap(d => d.tags || [])));

  if (loading) return <div>Đang tải...</div>;

  return (
    <div className="space-y-10 animate-in fade-in slide-in-from-bottom-8 duration-700 font-sans">
      <header className="flex flex-col md:flex-row md:items-end justify-between gap-6 border-b border-slate-200 dark:border-white/5 pb-8">
        <div>
          <h1 className="text-3xl md:text-5xl font-black text-slate-900 dark:text-white tracking-tighter">Bộ thẻ của tôi</h1>
          <p className="text-slate-500 dark:text-slate-400 font-medium mt-1 md:mt-2 text-sm md:text-base">Quản lý và tối ưu hóa thư viện kiến thức của bạn.</p>
        </div>
        <div className="flex flex-wrap gap-2 md:gap-3">
          <input 
            type="file" 
            accept=".apkg" 
            className="hidden" 
            ref={fileInputRef} 
            onChange={handleImportAnki}
          />
            <Button 
              variant="outline" 
              onClick={() => fileInputRef.current?.click()}
              disabled={isImporting}
              className="flex-1 md:flex-none gap-2 h-11 md:h-12 px-4 md:px-6 rounded-xl md:rounded-2xl font-bold border-slate-200 dark:border-white/10 hover:bg-slate-50 dark:hover:bg-white/5 transition-all dark:text-white text-xs md:text-sm"
            >
              <FileUp className="w-4 h-4 md:w-4.5 md:h-4.5" />
              Nhập Anki
            </Button>
            <Button 
              variant="outline" 
              onClick={handleRefresh}
              className="flex-1 md:flex-none gap-2 h-11 md:h-12 px-4 md:px-6 rounded-xl md:rounded-2xl font-bold border-slate-200 dark:border-white/10 hover:bg-slate-50 dark:hover:bg-white/5 transition-all dark:text-white text-xs md:text-sm"
            >
              <RotateCcw className="w-4 h-4 md:w-4.5 md:h-4.5" />
              Làm mới
            </Button>
            <Link to="/create-deck" className="w-full md:w-auto">
              <Button className="w-full md:w-auto bg-primary hover:bg-primary/90 gap-2 h-11 md:h-12 px-6 md:px-8 rounded-xl md:rounded-2xl font-black shadow-xl shadow-primary/20 transition-all active:scale-95 text-xs md:text-sm">
                <Plus className="w-4.5 h-4.5 md:w-5 md:h-5" />
                Tạo bộ thẻ
              </Button>
            </Link>
        </div>
      </header>

      <div className="flex flex-col md:flex-row gap-6 items-start md:items-center">
        <div className="relative group flex-1 w-full">
          <Search className="absolute left-6 top-1/2 -translate-y-1/2 text-slate-400 group-focus-within:text-primary transition-colors w-4.5 h-4.5 md:w-5 md:h-5" />
          <Input 
            placeholder="Tìm kiếm bộ thẻ..." 
            className="pl-14 bg-white dark:bg-[#0C0D0E] border-slate-200 dark:border-white/10 h-14 md:h-16 rounded-xl md:rounded-2xl shadow-sm focus:ring-2 focus:ring-primary/20 focus:border-primary transition-all dark:text-white text-base md:text-lg font-medium w-full"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
          />
        </div>

        {allTags.length > 0 && (
          <div className="flex flex-wrap gap-2 w-full md:w-auto">
            <Button
              variant={selectedTag === null ? "default" : "outline"}
              onClick={() => setSelectedTag(null)}
              className="rounded-xl font-bold h-10 px-4 text-xs"
            >
              Tất cả
            </Button>
            {allTags.map(tag => (
              <Button
                key={tag}
                variant={selectedTag === tag ? "default" : "outline"}
                onClick={() => setSelectedTag(tag)}
                className="rounded-xl font-bold h-10 px-4 text-xs gap-2"
              >
                <TagIcon size={12} />
                {tag}
              </Button>
            ))}
          </div>
        )}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-8">
        {filteredDecks.length > 0 ? (
          filteredDecks.map(deck => {
            const stats = deckStats[deck.id] || { learned: 0, due: 0 };
            const totalCards = Math.max(deck.cardCount || 0, 1);
            const progress = Math.min(100, Math.round((stats.learned / totalCards) * 100));

            return (
            <Link key={deck.id} to={`/decks/${deck.id}`}>
              <Card className="deck-card-premium hover:shadow-2xl hover:-translate-y-2 transition-all duration-500 border shadow-xl group overflow-hidden h-full flex flex-col rounded-[2rem]">
                <div className="h-2 w-full opacity-40 group-hover:opacity-100 transition-opacity" style={{ backgroundColor: deck.color || '#4f46e5' }} />
                <CardHeader className="pb-4 p-8">
                  <div className="flex justify-between items-start">
                    <div 
                      className="p-3 bg-slate-50 dark:bg-white/5 text-slate-400 rounded-2xl group-hover:text-white transition-all duration-500"
                      style={{ '--tw-bg-opacity': '1' } as any}
                    >
                      <style>{`
                        .group:hover .deck-icon-${deck.id} {
                          background-color: ${deck.color || '#4f46e5'} !important;
                        }
                      `}</style>
                      <div className={`deck-icon-${deck.id} p-3 -m-3 rounded-2xl transition-all duration-500`}>
                        <BookOpen size={28} />
                      </div>
                    </div>
                    <Button variant="ghost" size="icon" className="text-slate-300 hover:text-slate-600 dark:hover:text-slate-400 rounded-xl">
                      <MoreVertical size={20} />
                    </Button>
                  </div>
                  <CardTitle className="text-2xl font-black mt-6 group-hover:text-primary transition-colors dark:text-white tracking-tighter">
                    {deck.name}
                  </CardTitle>
                  {deck.tags && deck.tags.length > 0 && (
                    <div className="flex flex-wrap gap-2 mt-3">
                      {deck.tags.map(tag => (
                        <span key={tag} className="text-[9px] font-black uppercase tracking-widest text-slate-400 dark:text-slate-500 bg-slate-50 dark:bg-white/5 py-1 px-2 rounded-lg flex items-center gap-1">
                          <TagIcon size={10} />
                          {tag}
                        </span>
                      ))}
                    </div>
                  )}
                </CardHeader>
                <CardContent className="flex-1 flex flex-col justify-between px-8 pb-8">
                  <p className="text-slate-500 dark:text-slate-400 font-medium line-clamp-2 mb-8 leading-relaxed">
                    {deck.description || 'Không có mô tả cho bộ thẻ này.'}
                  </p>
                  <div className="mb-6 space-y-3 rounded-2xl border border-indigo-500/10 bg-indigo-500/[0.035] p-4 dark:border-white/10 dark:bg-white/[0.035]">
                    <div className="flex items-center justify-between text-xs font-bold text-slate-500 dark:text-slate-400">
                      <span>Tiến độ học</span>
                      <span className="font-mono text-primary">{progress}%</span>
                    </div>
                    <div className="h-2 overflow-hidden rounded-full bg-slate-200/70 dark:bg-white/10">
                      <div className="xp-gradient h-full rounded-full" style={{ width: `${progress}%` }} />
                    </div>
                    <div className="grid grid-cols-3 gap-2 text-center">
                      <div className="mode-chip p-2">
                        <p className="font-mono text-sm font-black text-slate-900 dark:text-white">{stats.learned}</p>
                        <p className="text-[9px] font-bold uppercase text-slate-400">Đã học</p>
                      </div>
                      <div className="mode-chip p-2">
                        <p className="font-mono text-sm font-black text-slate-900 dark:text-white">{stats.due}</p>
                        <p className="text-[9px] font-bold uppercase text-slate-400">Đến hạn</p>
                      </div>
                      <div className="mode-chip p-2">
                        <p className="font-mono text-sm font-black text-slate-900 dark:text-white">{deck.cardCount}</p>
                        <p className="text-[9px] font-bold uppercase text-slate-400">Tổng</p>
                      </div>
                    </div>
                    <p className="truncate text-[10px] font-medium text-slate-400">
                      {stats.lastStudied ? `Học gần nhất: ${new Date(stats.lastStudied).toLocaleDateString('vi-VN')}` : 'Chưa có phiên học gần đây'}
                    </p>
                  </div>

                  <div className="flex items-center justify-between pt-6 border-t border-slate-100 dark:border-white/5">
                    <div className="flex flex-col">
                      <span className="text-[9px] font-black text-slate-400 uppercase tracking-[0.2em]">Dung lượng</span>
                      <span className="text-2xl font-black text-slate-900 dark:text-white font-mono tracking-tighter">{deck.cardCount}</span>
                    </div>
                    <div className="flex flex-col items-end">
                      <span className="text-[9px] font-black text-slate-400 uppercase tracking-[0.2em]">Danh mục</span>
                      <span 
                        className="text-[10px] font-bold px-3 py-1.5 rounded-lg mt-1 uppercase tracking-widest bg-opacity-10"
                        style={{ backgroundColor: `${deck.color || '#4f46e5'}20`, color: deck.color || '#4f46e5' }}
                      >
                        {deck.category}
                      </span>
                    </div>
                  </div>
                </CardContent>
                <div className="p-5 bg-slate-50 dark:bg-white/5 flex items-center justify-center text-primary font-black text-[10px] uppercase tracking-[0.2em] gap-2 opacity-0 group-hover:opacity-100 transition-all duration-500 translate-y-4 group-hover:translate-y-0">
                  Học tiếp · Kiểm tra nhanh · Thống kê <ArrowRight size={16} />
                </div>
              </Card>
            </Link>
            );
          })
        ) : (
          <div className="col-span-full py-32 text-center bg-white dark:bg-[#0C0D0E] rounded-[3rem] border border-dashed border-slate-200 dark:border-white/10 shadow-sm">
            <div className="flex justify-center mb-6">
              <div className="p-8 bg-slate-50 dark:bg-white/5 rounded-full text-slate-200 dark:text-slate-800">
                <Library size={80} />
              </div>
            </div>
            <h3 className="text-3xl font-black text-slate-900 dark:text-white tracking-tighter">Thư viện trống</h3>
            <p className="text-slate-500 dark:text-slate-400 mt-2 font-medium max-w-md mx-auto">Hãy tạo bộ thẻ đầu tiên để bắt đầu hành trình chinh phục kiến thức.</p>
            
            <div className="flex justify-center gap-4 mt-12">
              <Button variant="outline" onClick={handleRefresh} className="gap-2 h-12 px-8 rounded-2xl font-bold border-slate-200 dark:border-white/10 dark:text-white">
                <RotateCcw size={18} />
                Làm mới
              </Button>
              <Link to="/create-deck">
                <Button className="bg-primary hover:bg-primary/90 h-12 px-10 rounded-2xl font-black shadow-xl shadow-primary/20">Tạo bộ thẻ mới</Button>
              </Link>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
