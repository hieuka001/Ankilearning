import { useState, useEffect } from 'react';
import { collection, query, where, orderBy, onSnapshot, getDocs } from 'firebase/firestore';
import { db, auth } from '../firebase';
import { User } from 'firebase/auth';
import { Deck } from '../types';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { 
  Plus, 
  Search, 
  BookOpen, 
  MoreVertical,
  ArrowRight,
  RotateCcw,
  FileUp,
  Tag as TagIcon,
  ChevronDown,
  ChevronRight,
  GraduationCap,
  FolderTree
} from 'lucide-react';
import { Link, useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { useSettings } from '../contexts/SettingsContext';
import { createInitialCardSchedule } from '../lib/spacedRepetition';
import {
  aggregateDeckStats,
  buildDeckTree,
  computeDeckStudyStats,
  fetchDeckCardsCached,
  getDeckCacheSignature,
  invalidateDeckCardsCache,
  type DeckStudyStats,
  type DeckTreeNode,
} from '../lib/deckAnalytics';
import { getCategoryArt } from '../lib/categoryArt';
import { addDoc } from 'firebase/firestore';
import { useRef } from 'react';

interface DecksProps {
  user: User | null;
}

export default function Decks({ user }: DecksProps) {
  const { settings } = useSettings();
  const navigate = useNavigate();
  const [decks, setDecks] = useState<Deck[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedTag, setSelectedTag] = useState<string | null>(null);
  const [isImporting, setIsImporting] = useState(false);
  const [deckStats, setDeckStats] = useState<Record<string, DeckStudyStats>>({});
  // Parent nodes ('Cha' in 'Cha::Con') are expanded by default; this set
  // holds the full names of the branches the user collapsed.
  const [collapsedNodes, setCollapsedNodes] = useState<Set<string>>(new Set());
  const fileInputRef = useRef<HTMLInputElement>(null);
  const deckStatsRequestRef = useRef(0);

  // Stats come from the signature-keyed card cache in deckAnalytics: a deck
  // snapshot only re-reads the cards of decks whose signature changed (or
  // whose cache entry expired) instead of every card of every deck.
  const loadDeckStats = async (decksData: Deck[], requestId: number) => {
    try {
      const entries = await Promise.all(
        decksData.map(async (deck) => {
          const signature = getDeckCacheSignature(deck as Deck & { updatedAt?: string });
          const cards = await fetchDeckCardsCached(deck.id, signature);
          return [deck.id, computeDeckStudyStats(cards)] as const;
        }),
      );
      if (deckStatsRequestRef.current !== requestId) return;
      setDeckStats(Object.fromEntries(entries));
    } catch {
      // Keep the stats already on screen; the next snapshot or a manual
      // refresh retries instead of wiping every counter to zero.
      if (deckStatsRequestRef.current !== requestId) return;
    }
  };

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
      const requestId = deckStatsRequestRef.current + 1;
      deckStatsRequestRef.current = requestId;

      const decksData = snap.docs.map(doc => ({ id: doc.id, ...doc.data() } as Deck));
      decksData.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
      setDecks(decksData);
      setLoading(false);

      void loadDeckStats(decksData, requestId);
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
      // Manual refresh bypasses the stats cache so counters are recomputed
      // from a fresh read of every deck's cards.
      invalidateDeckCardsCache();
      const q = query(collection(db, 'decks'), where('ownerId', '==', user.uid));
      const snap = await getDocs(q);
      const decksData = snap.docs.map(doc => ({ id: doc.id, ...doc.data() } as Deck));
      decksData.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
      setDecks(decksData);
      const requestId = deckStatsRequestRef.current + 1;
      deckStatsRequestRef.current = requestId;
      await loadDeckStats(decksData, requestId);
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
      // ankiService (JSZip + sql.js) and the media uploader are only needed
      // for this handler — load them on demand instead of with the page.
      const { importAnkiApkg } = await import('../services/ankiService');
      const { uploadAnkiMedia } = await import('../services/ankiMediaStorage');
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
      const totalDuplicates = ankiDecks.reduce((sum, deck) => sum + (deck.duplicatesSkipped || 0), 0);
      const importWarnings = Array.from(new Set(ankiDecks.flatMap((deck) => deck.warnings || [])));
      const importableDecks = ankiDecks.filter((deck) => deck.cards.length > 0);

      if (importableDecks.length === 0) {
        toast.error(
          totalDuplicates > 0
            ? `Không nhập thêm được thẻ nào: toàn bộ thẻ trong tệp đều bị trùng (đã bỏ qua ${totalDuplicates} thẻ trùng).`
            : "Không tìm thấy thẻ hợp lệ nào trong tệp Anki.",
          { id: toastId }
        );
        if (importWarnings.length > 0) {
          toast.warning(importWarnings.join('\n'), { duration: 8000 });
        }
        return;
      }

      let importedCardTotal = 0;
      for (const ankiDeck of importableDecks) {
        importedCardTotal += ankiDeck.cards.length;
        const deckRef = await addDoc(collection(db, 'decks'), {
          ownerId: user.uid,
          authorName: user.displayName || 'Người dùng',
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
            // Contract fields for note types (cloze/reversed) — only when present.
            ...(card.cardType ? { cardType: card.cardType } : {}),
            ...(card.clozeText ? { clozeText: card.clozeText } : {}),
            ...(typeof card.clozeIndex === 'number' ? { clozeIndex: card.clozeIndex } : {}),
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
            // Giữ tiến độ học từ Anki (nếu có) thay vì đặt lại mọi thẻ thành thẻ mới.
            ...(card.schedule ?? createInitialCardSchedule()),
            createdAt: new Date().toISOString()
          })
        );

        await Promise.all(cardPromises);
      }

      toast.success(`Đã nhập thành công ${importableDecks.length} bộ thẻ (${importedCardTotal} thẻ) từ Anki.`, { id: toastId });
      const importNotes: string[] = [];
      if (totalDuplicates > 0) importNotes.push(`Đã bỏ qua ${totalDuplicates} thẻ trùng.`);
      importNotes.push(...importWarnings);
      if (importNotes.length > 0) {
        toast.info(importNotes.join('\n'), { duration: 8000 });
      }
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

  const toggleNode = (name: string) => {
    setCollapsedNodes((previous) => {
      const next = new Set(previous);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  /** Study route for a whole branch: primary deck in the path, all ids in the query. */
  const parentStudyPath = (node: DeckTreeNode<Deck>) => {
    const primaryId = node.deck?.id ?? node.descendantIds[0];
    return `/study/${primaryId}?decks=${node.descendantIds.join(',')}`;
  };

  const branchTotalCards = (node: DeckTreeNode<Deck>) =>
    node.descendantDecks.reduce((sum, deck) => sum + (deck.cardCount || 0), 0);

  // Display rows: while searching we keep the flat filtered list (grouping
  // would hide matches under collapsed parents); otherwise decks are
  // grouped into the '::' tree — parents show branch-aggregate stats and
  // children appear indented below them while the branch is expanded.
  type DeckDisplayRow =
    | {
        kind: 'deck';
        key: string;
        deck: Deck;
        stats: DeckStudyStats;
        totalCards: number;
        title: string;
        parentPath?: string;
        depth: number;
        parentNode?: DeckTreeNode<Deck>;
      }
    | { kind: 'virtual'; key: string; node: DeckTreeNode<Deck>; depth: number };

  const isSearching = searchTerm.trim().length > 0;
  const displayRows: DeckDisplayRow[] = [];
  if (isSearching) {
    filteredDecks.forEach((deck) => {
      displayRows.push({
        kind: 'deck',
        key: deck.id,
        deck,
        stats: deckStats[deck.id] || { learned: 0, mastered: 0, due: 0 },
        totalCards: deck.cardCount || 0,
        title: deck.name,
        depth: 0,
      });
    });
  } else {
    const walkRows = (nodes: DeckTreeNode<Deck>[], depth: number) => {
      nodes.forEach((node) => {
        const parentPath = node.name.includes('::')
          ? node.name.slice(0, node.name.lastIndexOf('::'))
          : undefined;
        if (!node.deck) {
          displayRows.push({ kind: 'virtual', key: `virtual:${node.name}`, node, depth });
        } else if (node.children.length > 0) {
          displayRows.push({
            kind: 'deck',
            key: node.deck.id,
            deck: node.deck,
            stats: aggregateDeckStats(deckStats, node.descendantIds),
            totalCards: branchTotalCards(node),
            title: node.segment,
            parentPath,
            depth,
            parentNode: node,
          });
        } else {
          displayRows.push({
            kind: 'deck',
            key: node.deck.id,
            deck: node.deck,
            stats: deckStats[node.deck.id] || { learned: 0, mastered: 0, due: 0 },
            totalCards: node.deck.cardCount || 0,
            title: depth > 0 ? node.segment : node.deck.name,
            parentPath,
            depth,
          });
        }
        if (!collapsedNodes.has(node.name)) {
          walkRows(node.children, depth + 1);
        }
      });
    };
    walkRows(buildDeckTree(filteredDecks), 0);
  }

  const renderVirtualParentRow = (node: DeckTreeNode<Deck>, depth: number) => {
    const stats = aggregateDeckStats(deckStats, node.descendantIds);
    const totalCards = branchTotalCards(node);
    const collapsed = collapsedNodes.has(node.name);
    return (
      <div
        key={`virtual:${node.name}`}
        style={depth > 0 ? { marginLeft: `${Math.min(depth, 3) * 16}px` } : undefined}
      >
        <Card className="h-full flex flex-col rounded-[2rem] border-2 border-dashed border-zinc-300 bg-zinc-50/70 shadow-none dark:border-white/15 dark:bg-white/[0.02]">
          <CardHeader className="p-8 pb-4">
            <div className="flex items-start justify-between">
              <div className="p-3 rounded-2xl bg-zinc-100 dark:bg-white/5 text-zinc-400">
                <FolderTree size={28} />
              </div>
              <Button
                variant="ghost"
                size="icon"
                onClick={() => toggleNode(node.name)}
                className="text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300 rounded-xl"
                aria-label={collapsed ? `Mở nhóm ${node.name}` : `Đóng nhóm ${node.name}`}
              >
                {collapsed ? <ChevronRight size={20} /> : <ChevronDown size={20} />}
              </Button>
            </div>
            {node.name.includes('::') && (
              <p className="mt-6 text-[10px] font-bold uppercase tracking-widest text-zinc-400">
                {node.name.slice(0, node.name.lastIndexOf('::')).split('::').join(' › ')}
              </p>
            )}
            <CardTitle className={`text-2xl font-extrabold ${node.name.includes('::') ? 'mt-1' : 'mt-6'} dark:text-white tracking-tighter`}>
              {node.segment}
            </CardTitle>
            <p className="mt-2 text-xs font-semibold text-zinc-400">
              Nhóm bộ thẻ · {node.descendantDecks.length} bộ trong nhánh
            </p>
          </CardHeader>
          <CardContent className="flex-1 flex flex-col justify-end px-8 pb-8">
            <div className="mb-6 grid grid-cols-3 gap-2 text-center rounded-2xl border border-emerald-500/10 bg-emerald-500/[0.035] p-4 dark:border-white/10 dark:bg-white/[0.035]">
              <div className="mode-chip p-2">
                <p className="font-mono text-sm font-extrabold text-zinc-900 dark:text-white">{stats.learned}</p>
                <p className="text-[9px] font-bold uppercase text-zinc-400">Đã học</p>
              </div>
              <div className="mode-chip p-2">
                <p className="font-mono text-sm font-extrabold text-zinc-900 dark:text-white">{stats.due}</p>
                <p className="text-[9px] font-bold uppercase text-zinc-400">Đến hạn</p>
              </div>
              <div className="mode-chip p-2">
                <p className="font-mono text-sm font-extrabold text-zinc-900 dark:text-white">{totalCards}</p>
                <p className="text-[9px] font-bold uppercase text-zinc-400">Tổng</p>
              </div>
            </div>
            <button
              type="button"
              onClick={() => navigate(parentStudyPath(node))}
              className="btn-press flex w-full items-center justify-center gap-2 rounded-2xl bg-primary px-4 py-3 text-xs font-extrabold uppercase tracking-widest text-white shadow-lg shadow-primary/20 transition-all hover:bg-primary/90"
            >
              <GraduationCap size={16} />
              Học deck cha · gộp cả nhánh
            </button>
          </CardContent>
        </Card>
      </div>
    );
  };

  if (loading) {
    return (
      <div className="space-y-10 font-sans" aria-busy="true">
        <div className="space-y-3 border-b border-zinc-200 dark:border-white/5 pb-8">
          <div className="skeleton-block animate-pulse h-10 w-64 rounded-xl bg-zinc-200/70 dark:bg-white/10" />
          <div className="skeleton-block animate-pulse h-4 w-96 max-w-full rounded-lg bg-zinc-200/50 dark:bg-white/5" />
        </div>
        <div className="skeleton-block animate-pulse h-14 w-full rounded-2xl bg-zinc-200/50 dark:bg-white/5" />
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-8">
          {[0, 1, 2].map((i) => (
            <div key={i} className="skeleton-block animate-pulse h-72 rounded-[2rem] bg-zinc-200/50 dark:bg-white/5" />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-10 animate-in fade-in slide-in-from-bottom-8 duration-700 font-sans">
      <header className="flex flex-col md:flex-row md:items-end justify-between gap-6 border-b border-zinc-200 dark:border-white/5 pb-8">
        <div>
          <h1 className="text-3xl md:text-5xl font-extrabold text-zinc-900 dark:text-white tracking-tighter">Bộ thẻ của tôi</h1>
          <p className="text-zinc-500 dark:text-zinc-400 font-medium mt-1 md:mt-2 text-sm md:text-base">Quản lý và tối ưu hóa thư viện kiến thức của bạn.</p>
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
              className="flex-1 md:flex-none gap-2 h-11 md:h-12 px-4 md:px-6 rounded-xl md:rounded-2xl font-bold border-zinc-200 dark:border-white/10 hover:bg-zinc-50 dark:hover:bg-white/5 transition-all dark:text-white text-xs md:text-sm"
            >
              <FileUp className="w-4 h-4 md:w-4.5 md:h-4.5" />
              Nhập Anki
            </Button>
            <Button 
              variant="outline" 
              onClick={handleRefresh}
              className="flex-1 md:flex-none gap-2 h-11 md:h-12 px-4 md:px-6 rounded-xl md:rounded-2xl font-bold border-zinc-200 dark:border-white/10 hover:bg-zinc-50 dark:hover:bg-white/5 transition-all dark:text-white text-xs md:text-sm"
            >
              <RotateCcw className="w-4 h-4 md:w-4.5 md:h-4.5" />
              Làm mới
            </Button>
            <Link to="/create-deck" className="w-full md:w-auto">
              <Button className="btn-press w-full md:w-auto bg-primary hover:bg-primary/90 gap-2 h-11 md:h-12 px-6 md:px-8 rounded-xl md:rounded-2xl font-extrabold shadow-xl shadow-primary/20 transition-all active:scale-95 text-xs md:text-sm">
                <Plus className="w-4.5 h-4.5 md:w-5 md:h-5" />
                Tạo bộ thẻ
              </Button>
            </Link>
        </div>
      </header>

      <div className="flex flex-col md:flex-row gap-6 items-start md:items-center">
        <div className="relative group flex-1 w-full">
          <Search className="absolute left-6 top-1/2 -tranzinc-y-1/2 text-zinc-400 group-focus-within:text-primary transition-colors w-4.5 h-4.5 md:w-5 md:h-5" />
          <Input 
            placeholder="Tìm kiếm bộ thẻ..." 
            className="pl-14 bg-white dark:bg-[#0C0D0E] border-zinc-200 dark:border-white/10 h-14 md:h-16 rounded-xl md:rounded-2xl shadow-sm focus:ring-2 focus:ring-primary/20 focus:border-primary transition-all dark:text-white text-base md:text-lg font-medium w-full"
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

      <div className="stagger-children grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-8">
        {filteredDecks.length > 0 ? (
          displayRows.map((row) => {
            if (row.kind === 'virtual') {
              return renderVirtualParentRow(row.node, row.depth);
            }
            const deck = row.deck;
            const stats = row.stats;
            const totalCards = Math.max(row.totalCards || 0, 1);
            const progress = Math.min(100, Math.round((stats.mastered / totalCards) * 100));
            const parentNode = row.parentNode;
            const parentCollapsed = parentNode ? collapsedNodes.has(parentNode.name) : false;

            return (
            <Link key={deck.id} to={`/decks/${deck.id}`} style={row.depth > 0 ? { marginLeft: `${Math.min(row.depth, 3) * 16}px` } : undefined}>
              <Card className="cv-auto card-hover deck-card-premium hover:shadow-2xl hover:-tranzinc-y-2 transition-all duration-500 border shadow-xl group overflow-hidden h-full flex flex-col rounded-[2rem]">
                <div className="relative h-28 w-full shrink-0 overflow-hidden">
                  <img
                    src={getCategoryArt(deck.category)}
                    alt=""
                    loading="lazy"
                    decoding="async"
                    className="h-full w-full object-cover"
                  />
                  <div className="pointer-events-none absolute inset-0 bg-gradient-to-b from-transparent via-transparent to-card" />
                  <span
                    className="absolute bottom-3 left-8 text-[10px] font-bold px-3 py-1.5 rounded-lg uppercase tracking-widest backdrop-blur-sm"
                    style={{ backgroundColor: `${deck.color || '#10b981'}26`, color: deck.color || '#10b981' }}
                  >
                    {deck.category}
                  </span>
                </div>
                <CardHeader className="pb-4 p-8">
                  <div className="flex justify-between items-start">
                    <div 
                      className="p-3 bg-zinc-50 dark:bg-white/5 text-zinc-400 rounded-2xl group-hover:text-white transition-all duration-500"
                      style={{ '--tw-bg-opacity': '1' } as any}
                    >
                      <style>{`
                        .group:hover .deck-icon-${deck.id} {
                          background-color: ${deck.color || '#10b981'} !important;
                        }
                      `}</style>
                      <div className={`deck-icon-${deck.id} p-3 -m-3 rounded-2xl transition-all duration-500`}>
                        <BookOpen size={28} />
                      </div>
                    </div>
                    <div className="flex items-center gap-1">
                      {parentNode && (
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={(e) => { e.preventDefault(); e.stopPropagation(); toggleNode(parentNode.name); }}
                          className="text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300 rounded-xl"
                          aria-label={parentCollapsed ? `Mở nhóm ${parentNode.name}` : `Đóng nhóm ${parentNode.name}`}
                        >
                          {parentCollapsed ? <ChevronRight size={20} /> : <ChevronDown size={20} />}
                        </Button>
                      )}
                      <Button variant="ghost" size="icon" className="text-zinc-300 hover:text-zinc-600 dark:hover:text-zinc-400 rounded-xl">
                        <MoreVertical size={20} />
                      </Button>
                    </div>
                  </div>
                  {row.parentPath && (
                    <p className="mt-6 text-[10px] font-bold uppercase tracking-widest text-zinc-400">
                      {row.parentPath.split('::').join(' › ')}
                    </p>
                  )}
                  <CardTitle className={`text-2xl font-extrabold ${row.parentPath ? 'mt-1' : 'mt-6'} group-hover:text-primary transition-colors dark:text-white tracking-tighter`}>
                    {row.title}
                  </CardTitle>
                  {parentNode && (
                    <p className="mt-2 text-xs font-semibold text-zinc-400">
                      Bộ cha · số liệu gộp {parentNode.descendantDecks.length} bộ thẻ trong nhánh
                    </p>
                  )}
                  {deck.tags && deck.tags.length > 0 && (
                    <div className="flex flex-wrap gap-2 mt-3">
                      {deck.tags.map(tag => (
                        <span key={tag} className="text-[9px] font-extrabold uppercase tracking-widest text-zinc-400 dark:text-zinc-500 bg-zinc-50 dark:bg-white/5 py-1 px-2 rounded-lg flex items-center gap-1">
                          <TagIcon size={10} />
                          {tag}
                        </span>
                      ))}
                    </div>
                  )}
                </CardHeader>
                <CardContent className="flex-1 flex flex-col justify-between px-8 pb-8">
                  <p className="text-zinc-500 dark:text-zinc-400 font-medium line-clamp-2 mb-8 leading-relaxed">
                    {deck.description || 'Không có mô tả cho bộ thẻ này.'}
                  </p>
                  <div className="mb-6 space-y-3 rounded-2xl border border-emerald-500/10 bg-emerald-500/[0.035] p-4 dark:border-white/10 dark:bg-white/[0.035]">
                    <div className="flex items-center justify-between text-xs font-bold text-zinc-500 dark:text-zinc-400">
                      <span>Đã thuộc</span>
                      <span className="font-mono text-primary">{progress}%</span>
                    </div>
                    <div className="h-2 overflow-hidden rounded-full bg-zinc-200/70 dark:bg-white/10">
                      <div className="xp-gradient h-full rounded-full" style={{ width: `${progress}%` }} />
                    </div>
                    <div className="grid grid-cols-3 gap-2 text-center">
                      <div className="mode-chip p-2">
                        <p className="font-mono text-sm font-extrabold text-zinc-900 dark:text-white">{stats.learned}</p>
                        <p className="text-[9px] font-bold uppercase text-zinc-400">Đã học</p>
                      </div>
                      <div className="mode-chip p-2">
                        <p className="font-mono text-sm font-extrabold text-zinc-900 dark:text-white">{stats.due}</p>
                        <p className="text-[9px] font-bold uppercase text-zinc-400">Đến hạn</p>
                      </div>
                      <div className="mode-chip p-2">
                        <p className="font-mono text-sm font-extrabold text-zinc-900 dark:text-white">{row.totalCards}</p>
                        <p className="text-[9px] font-bold uppercase text-zinc-400">Tổng</p>
                      </div>
                    </div>
                    <p className="truncate text-[10px] font-medium text-zinc-400">
                      {stats.lastStudied ? `Học gần nhất: ${new Date(stats.lastStudied).toLocaleDateString('vi-VN')}` : 'Chưa có phiên học gần đây'}
                    </p>
                  </div>

                  {parentNode && (
                    <button
                      type="button"
                      onClick={(e) => { e.preventDefault(); e.stopPropagation(); navigate(parentStudyPath(parentNode)); }}
                      className="btn-press mb-6 flex w-full items-center justify-center gap-2 rounded-2xl bg-primary px-4 py-3 text-xs font-extrabold uppercase tracking-widest text-white shadow-lg shadow-primary/20 transition-all hover:bg-primary/90"
                    >
                      <GraduationCap size={16} />
                      Học deck cha · gộp cả nhánh
                    </button>
                  )}

                  <div className="flex items-center justify-between pt-6 border-t border-zinc-100 dark:border-white/5">
                    <div className="flex flex-col">
                      <span className="text-[9px] font-extrabold text-zinc-400 uppercase tracking-[0.2em]">Dung lượng</span>
                      <span className="text-2xl font-extrabold text-zinc-900 dark:text-white font-mono tracking-tighter">{row.totalCards}</span>
                    </div>
                    <div className="flex flex-col items-end">
                      <span className="text-[9px] font-extrabold text-zinc-400 uppercase tracking-[0.2em]">Danh mục</span>
                      <span 
                        className="text-[10px] font-bold px-3 py-1.5 rounded-lg mt-1 uppercase tracking-widest bg-opacity-10"
                        style={{ backgroundColor: `${deck.color || '#10b981'}20`, color: deck.color || '#10b981' }}
                      >
                        {deck.category}
                      </span>
                    </div>
                  </div>
                </CardContent>
                <div className="p-5 bg-zinc-50 dark:bg-white/5 flex items-center justify-center text-primary font-extrabold text-[10px] uppercase tracking-[0.2em] gap-2 opacity-0 group-hover:opacity-100 transition-all duration-500 tranzinc-y-4 group-hover:tranzinc-y-0">
                  Học tiếp · Kiểm tra nhanh · Thống kê <ArrowRight size={16} />
                </div>
              </Card>
            </Link>
            );
          })
        ) : decks.length === 0 ? (
          <div className="premium-panel col-span-full py-32 text-center">
            <img
              src="/img/empty-decks.webp"
              alt="Minh hoạ chồng thẻ ghi nhớ đang chờ được tạo"
              loading="lazy"
              className="mx-auto mb-6 w-56 max-w-full"
            />
            <h3 className="text-3xl font-extrabold text-zinc-900 dark:text-white tracking-tighter">Thư viện trống</h3>
            <p className="text-zinc-500 dark:text-zinc-400 mt-2 font-medium max-w-md mx-auto">Bạn chưa có bộ thẻ nào. Hãy tạo bộ thẻ đầu tiên hoặc nhập một tệp Anki (.apkg) để bắt đầu học.</p>

            <div className="flex flex-wrap justify-center gap-4 mt-12">
              <Button
                variant="outline"
                onClick={() => fileInputRef.current?.click()}
                disabled={isImporting}
                className="gap-2 h-12 px-8 rounded-2xl font-bold border-zinc-200 dark:border-white/10 dark:text-white"
              >
                <FileUp size={18} />
                Nhập file Anki
              </Button>
              <Link to="/create-deck">
                <Button className="btn-press bg-primary hover:bg-primary/90 h-12 px-10 rounded-2xl font-extrabold shadow-xl shadow-primary/20">Tạo bộ thẻ đầu tiên</Button>
              </Link>
            </div>
          </div>
        ) : (
          <div className="premium-panel col-span-full py-32 text-center">
            <div className="flex justify-center mb-6">
              <div className="p-8 bg-zinc-50 dark:bg-white/5 rounded-full text-zinc-200 dark:text-zinc-800">
                <Search size={80} />
              </div>
            </div>
            <h3 className="text-3xl font-extrabold text-zinc-900 dark:text-white tracking-tighter">Không tìm thấy bộ thẻ phù hợp</h3>
            <p className="text-zinc-500 dark:text-zinc-400 mt-2 font-medium max-w-md mx-auto">Không có bộ thẻ nào khớp với từ khóa hoặc thẻ nhãn đang chọn. Thử thay đổi điều kiện lọc.</p>

            <div className="flex justify-center gap-4 mt-12">
              <Button
                variant="outline"
                onClick={() => { setSearchTerm(''); setSelectedTag(null); }}
                className="gap-2 h-12 px-8 rounded-2xl font-bold border-zinc-200 dark:border-white/10 dark:text-white"
              >
                <RotateCcw size={18} />
                Xóa bộ lọc
              </Button>
              <Link to="/create-deck">
                <Button className="bg-primary hover:bg-primary/90 h-12 px-10 rounded-2xl font-extrabold shadow-xl shadow-primary/20">Tạo bộ thẻ mới</Button>
              </Link>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
