import { useState, useEffect } from 'react';
import { collection, query, where, getDocs, limit, addDoc } from 'firebase/firestore';
import { db, auth } from '../firebase';
import { Deck, Flashcard } from '../types';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Search as SearchIcon, BookOpen, Library, Download, User as UserIcon } from 'lucide-react';
import { toast } from 'sonner';
import { createInitialCardSchedule } from '../lib/spacedRepetition';

import { User } from 'firebase/auth';

interface SearchProps {
  user: User | null;
}

export default function Search({ user }: SearchProps) {
  const [searchTerm, setSearchTerm] = useState('');
  const [results, setResults] = useState<Deck[]>([]);
  const [loading, setLoading] = useState(false);
  const [hasSearched, setHasSearched] = useState(false);
  const [syncingId, setSyncingId] = useState<string | null>(null);

  const fetchInitialDecks = async () => {
    setLoading(true);
    try {
      const q = query(
        collection(db, 'decks'),
        where('isPublic', '==', true),
        limit(20)
      );
      const snap = await getDocs(q);
      const allPublic = snap.docs.map(doc => ({ id: doc.id, ...doc.data() } as Deck));
      setResults(allPublic);
      setHasSearched(false);
    } catch (error) {
      console.error("Error fetching initial decks:", error);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    // Tải các bộ thẻ công khai mặc định
    fetchInitialDecks();
  }, []);

  const handleSearch = async () => {
    if (!searchTerm.trim()) return;
    setLoading(true);
    setHasSearched(true);
    try {
      // Search public decks
      const q = query(
        collection(db, 'decks'),
        where('isPublic', '==', true),
        limit(50)
      );
      const snap = await getDocs(q);
      const allPublic = snap.docs.map(doc => ({ id: doc.id, ...doc.data() } as Deck));
      
      // Client-side filtering for better search experience
      const filtered = allPublic.filter(deck => 
        deck.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
        deck.category.toLowerCase().includes(searchTerm.toLowerCase()) ||
        deck.authorName?.toLowerCase().includes(searchTerm.toLowerCase())
      );
      
      setResults(filtered);
    } catch (error) {
      console.error(error);
      toast.error("Lỗi khi tìm kiếm.");
    } finally {
      setLoading(false);
    }
  };

  const handleSync = async (deck: Deck) => {
    if (!user) {
      toast.error("Vui lòng đăng nhập để đồng bộ.");
      return;
    }

    setSyncingId(deck.id);
    try {
      // 1. Fetch all cards from the public deck
      const cardsSnap = await getDocs(collection(db, `decks/${deck.id}/cards`));
      const cardsData = cardsSnap.docs.map(doc => doc.data() as Flashcard);

      // 2. Create a new deck for the current user
      const newDeckRef = await addDoc(collection(db, 'decks'), {
        ownerId: user.uid,
        authorName: deck.authorName || 'Ẩn danh',
        name: `${deck.name} (Đã đồng bộ)`,
        description: deck.description,
        category: deck.category,
        cardCount: deck.cardCount,
        mindmap: deck.mindmap || '',
        color: deck.color || '#4f46e5',
        createdAt: new Date().toISOString(),
        isPublic: false
      });

      // 3. Copy all cards to the new deck
      const copyPromises = cardsData.map(card => 
        addDoc(collection(db, `decks/${newDeckRef.id}/cards`), {
          ...card,
          deckId: newDeckRef.id,
          ownerId: user.uid,
          createdAt: new Date().toISOString(),
          // Đặt lại dữ liệu ôn tập ngắt quãng cho bản sao
          ...createInitialCardSchedule(),
        })
      );

      await Promise.all(copyPromises);
      toast.success(`Đã đồng bộ bộ thẻ "${deck.name}" về tài khoản của bạn!`);
    } catch (error) {
      console.error(error);
      toast.error("Lỗi khi đồng bộ bộ thẻ.");
    } finally {
      setSyncingId(null);
    }
  };

  return (
    <div className="max-w-6xl mx-auto space-y-12 animate-in fade-in slide-in-from-bottom-8 duration-700 pt-6">
      <header className="space-y-4">
        <h1 className="text-5xl font-black text-slate-900 dark:text-white tracking-tighter">Khám phá cộng đồng</h1>
        <p className="text-slate-500 dark:text-slate-400 text-xl font-medium">Tìm kiếm và đồng bộ các bộ thẻ hữu ích từ mọi người trên khắp thế giới.</p>
      </header>

      <div className="flex flex-col sm:flex-row gap-4">
        <div className="relative flex-1">
          <SearchIcon className="absolute left-5 top-1/2 -translate-y-1/2 text-slate-400 w-6 h-6" />
          <Input 
            placeholder="Tìm kiếm chủ đề, tên bộ thẻ, tác giả..." 
            className="pl-14 bg-white dark:bg-[#0C0D0E] border-slate-200 dark:border-white/5 h-16 rounded-2xl shadow-sm focus:ring-primary text-xl dark:text-white font-medium"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
          />
        </div>
        <Button onClick={handleSearch} className="bg-primary hover:bg-primary/90 h-16 px-10 rounded-2xl font-black text-xl shadow-xl shadow-primary/20 transition-all hover:scale-[1.02] active:scale-95">
          Tìm kiếm
        </Button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-8">
        {loading ? (
          <div className="col-span-full grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-8" aria-busy="true">
            {[0, 1, 2].map((i) => (
              <div key={i} className="skeleton-block animate-pulse h-80 rounded-[2rem] bg-slate-200/50 dark:bg-white/5" />
            ))}
          </div>
        ) : results.length > 0 ? (
          results.map(deck => (
            <Card key={deck.id} className="hover:shadow-[0_32px_64px_-12px_rgba(0,0,0,0.14)] transition-all duration-500 border border-slate-200 dark:border-white/5 group overflow-hidden bg-white dark:bg-[#0C0D0E] h-full flex flex-col rounded-[3rem]">
              <div className="h-2 bg-primary w-full opacity-50 group-hover:opacity-100 transition-opacity" />
              <CardHeader className="p-10 pb-4">
                <div className="flex justify-between items-start">
                  <div className="p-4 bg-primary/10 text-primary rounded-2xl">
                    <BookOpen size={32} />
                  </div>
                  <div className="flex items-center gap-2 text-[10px] font-black text-slate-400 dark:text-slate-500 bg-slate-50 dark:bg-white/5 px-4 py-2 rounded-full uppercase tracking-widest">
                    <UserIcon size={14} />
                    {deck.authorName || 'Ẩn danh'}
                  </div>
                </div>
                <CardTitle className="text-3xl font-black mt-8 group-hover:text-primary transition-colors dark:text-white tracking-tight leading-tight">
                  {deck.name}
                </CardTitle>
              </CardHeader>
              <CardContent className="flex-1 flex flex-col justify-between p-10 pt-2">
                <div>
                  <p className="text-slate-500 dark:text-slate-400 text-lg font-medium line-clamp-3 mb-8 leading-relaxed">
                    {deck.description || 'Không có mô tả cho bộ thẻ này.'}
                  </p>
                  <div className="flex items-center justify-between mb-10">
                    <div className="flex flex-col">
                      <span className="text-[10px] font-black text-slate-400 uppercase tracking-[0.2em]">Số thẻ</span>
                      <span className="text-3xl font-black text-slate-900 dark:text-white font-mono">{deck.cardCount}</span>
                    </div>
                    <div className="flex flex-col items-end">
                      <span className="text-[10px] font-black text-slate-400 uppercase tracking-[0.2em]">Chủ đề</span>
                      <span className="text-xs font-black text-primary bg-primary/10 px-4 py-1.5 rounded-full mt-2">
                        {deck.category}
                      </span>
                    </div>
                  </div>
                </div>
                
                <Button 
                  onClick={() => handleSync(deck)}
                  disabled={syncingId === deck.id}
                  className="w-full bg-slate-900 dark:bg-primary hover:bg-slate-800 dark:hover:bg-primary/90 text-white gap-3 h-16 rounded-2xl font-black text-xl shadow-xl shadow-primary/10 transition-all hover:scale-[1.02] active:scale-95"
                >
                  {syncingId === deck.id ? (
                    <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-white"></div>
                  ) : (
                    <Download size={24} />
                  )}
                  Đồng bộ bộ thẻ
                </Button>
              </CardContent>
            </Card>
          ))
        ) : hasSearched ? (
          <div className="premium-panel col-span-full py-32 text-center">
            <div className="flex justify-center mb-6">
              <div className="p-8 bg-slate-50 dark:bg-white/5 rounded-full">
                <SearchIcon size={80} className="text-slate-200 dark:text-slate-800" />
              </div>
            </div>
            <h3 className="text-3xl font-black text-slate-900 dark:text-white tracking-tight">Không tìm thấy bộ thẻ nào</h3>
            <p className="text-slate-500 dark:text-slate-400 mt-4 text-lg font-medium max-w-md mx-auto">Không có bộ thẻ công khai nào khớp với từ khóa “{searchTerm}”. Thử từ khóa ngắn hơn hoặc kiểm tra lại chính tả.</p>
            <div className="flex justify-center mt-10">
              <Button
                variant="outline"
                onClick={() => { setSearchTerm(''); fetchInitialDecks(); }}
                className="gap-2 h-12 px-8 rounded-2xl font-bold border-slate-200 dark:border-white/10 dark:text-white"
              >
                <Library size={18} />
                Xem tất cả bộ thẻ công khai
              </Button>
            </div>
          </div>
        ) : (
          <div className="premium-panel col-span-full py-32 text-center">
            <div className="flex justify-center mb-6">
              <div className="p-8 bg-slate-50 dark:bg-white/5 rounded-full">
                <Library size={80} className="text-slate-200 dark:text-slate-800" />
              </div>
            </div>
            <h3 className="text-3xl font-black text-slate-900 dark:text-white tracking-tight">Khám phá kho tri thức cộng đồng</h3>
            <p className="text-slate-500 dark:text-slate-400 mt-4 text-lg font-medium max-w-md mx-auto">Nhập từ khóa để tìm kiếm các bộ thẻ tuyệt vời được chia sẻ bởi cộng đồng.</p>
          </div>
        )}
      </div>
    </div>
  );
}
