import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { doc, getDoc, collection, getDocs, deleteDoc, deleteField, query, orderBy, updateDoc, onSnapshot, addDoc, increment, where, writeBatch, type WriteBatch } from 'firebase/firestore';
import { db } from '../firebase';
import { User } from 'firebase/auth';
import { Deck, DeckOptions, Flashcard, UserProfile } from '../types';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { 
  ArrowLeft, 
  Play, 
  Settings, 
  Trash2, 
  Plus, 
  BookOpen,
  Calendar,
  Clock,
  ChevronRight,
  ChevronUp,
  ChevronDown,
  Globe,
  Lock,
  Image as ImageIcon,
  Edit2,
  X as CloseIcon,
  Sparkles,
  Loader2,
  FileText,
  Save,
  FileDown,
  Search,
  RotateCcw,
  SlidersHorizontal,
  CheckCheck,
  Tag,
  ArrowRightLeft
} from 'lucide-react';
import { toast } from 'sonner';
import { format } from 'date-fns';
import { vi } from 'date-fns/locale';
import ReactMarkdown from 'react-markdown';
import { Switch } from '@/components/ui/switch';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { useSettings } from '../contexts/SettingsContext';
import AudioButton from '../components/AudioButton';
import {
  createInitialCardSchedule,
  isCardDue,
  isCardBuried,
  normalizeCardSchedule,
} from '../lib/spacedRepetition';
import { getCategoryArt } from '../lib/categoryArt';
import { resolveDeckSchedulerConfig } from '../lib/deckOptions';
import { extractTextFromDocument } from '../lib/documentText';
import CardTypeFields from '../components/CardTypeFields';
import {
  buildNoteCards,
  type NoteCardType,
  type NoteDraft,
} from '../lib/noteCards';
import { validateClozeText } from '../review/cloze';

interface DeckDetailProps {
  user: User | null;
  profile: UserProfile | null;
}

type DeckWithAiMindmap = Deck & { aiMindmap?: string };

const STATE_LABELS: Record<string, string> = {
  new: 'Mới',
  learning: 'Đang học',
  review: 'Ôn tập',
  relearning: 'Học lại',
};

const CARDS_PAGE_SIZE = 50;

type CardFilter = 'all' | 'due' | 'hard' | 'suspended';

const CARD_FILTERS: Array<{ key: CardFilter; label: string }> = [
  { key: 'all', label: 'Tất cả' },
  { key: 'due', label: 'Đến hạn' },
  { key: 'hard', label: 'Thẻ khó' },
  { key: 'suspended', label: 'Đã tạm dừng' },
];

type CardSort = 'created' | 'due' | 'stability' | 'lapses' | 'front';

const CARD_SORTS: Array<{ key: CardSort; label: string }> = [
  { key: 'created', label: 'Ngày tạo (mặc định)' },
  { key: 'due', label: 'Hạn ôn (sớm nhất trước)' },
  { key: 'stability', label: 'Độ ổn định (thấp → cao)' },
  { key: 'lapses', label: 'Số lần quên (nhiều → ít)' },
  { key: 'front', label: 'Mặt trước (A–Z)' },
];

interface DeckCardRowProps {
  card: Flashcard;
  isOwner: boolean;
  selected: boolean;
  onToggleSelect: (cardId: string) => void;
  onPreview: (card: Flashcard) => void;
  onEdit: (card: Flashcard) => void;
  onDelete: (cardId: string) => void;
  onBury: (card: Flashcard) => void;
  onToggleSuspend: (card: Flashcard) => void;
}

/**
 * One card row of the deck's card list. Memoized: with stable callbacks the
 * row only re-renders when its own card object changes, so typing in the
 * deck edit form or the card search box no longer re-renders every row.
 */
const DeckCardRow = memo(function DeckCardRow({
  card,
  isOwner,
  selected,
  onToggleSelect,
  onPreview,
  onEdit,
  onDelete,
  onBury,
  onToggleSuspend,
}: DeckCardRowProps) {
  const schedule = normalizeCardSchedule(card);
  const due = isCardDue(card);
  const buried = isCardBuried(card);
  const statusLabel = schedule.suspended ? 'Đã tạm dừng' : buried ? 'Hoãn hôm nay' : due ? 'Cần ôn ngay' : (STATE_LABELS[schedule.state] || schedule.state);
  const statusClass = schedule.suspended
    ? 'bg-zinc-200 text-zinc-700 dark:bg-white/10 dark:text-zinc-300'
    : buried
      ? 'bg-sky-100 text-sky-700 dark:bg-sky-900/30 dark:text-sky-300'
      : due
        ? 'bg-orange-100 dark:bg-orange-900/30 text-orange-600 dark:text-orange-400'
        : 'bg-emerald-100 dark:bg-emerald-900/30 text-emerald-600 dark:text-emerald-400';
  const frontAudio = card.frontAudio?.length ? card.frontAudio : (card.audioUrls || []);
  const backAudio = card.backAudio || [];

  return (
    <Card
      onClick={(event) => {
        if (!isOwner) return;
        // Clicks on interactive children (buttons, checkbox, audio…) keep
        // their own behaviour; clicking anywhere else opens the preview.
        if ((event.target as HTMLElement).closest('button, a, input, select, textarea, label')) return;
        onPreview(card);
      }}
      className={`cv-auto border-none shadow-xl hover:shadow-2xl transition-all duration-500 group overflow-hidden bg-white dark:bg-zinc-900 rounded-[2rem] ${selected ? 'ring-2 ring-emerald-500' : ''} ${isOwner ? 'cursor-pointer' : ''}`}
    >
      <CardContent className="p-0 flex items-stretch">
        {isOwner && (
          <div className="flex items-start justify-center pl-4 pt-6">
            <input
              type="checkbox"
              checked={selected}
              onChange={() => onToggleSelect(card.id)}
              onClick={(event) => event.stopPropagation()}
              aria-label="Chọn thẻ"
              title="Chọn thẻ"
              className="h-5 w-5 shrink-0 cursor-pointer accent-emerald-600"
            />
          </div>
        )}
        <div className="w-2 bg-emerald-100 dark:bg-emerald-900 group-hover:bg-emerald-600 transition-all duration-500" />
        <div className="flex-1 p-6 grid grid-cols-1 md:grid-cols-2 gap-8">
          <div className="flex gap-6">
            <div className="flex flex-col gap-2">
              {card.imageUrl && (
                <div className="w-24 h-24 rounded-2xl overflow-hidden flex-shrink-0 border-2 border-zinc-50 dark:border-zinc-800 shadow-md">
                  <img src={card.imageUrl} alt="" loading="lazy" className="w-full h-full object-cover" referrerPolicy="no-referrer" />
                </div>
              )}
              {!card.imageUrl && <div className="w-24 h-24 rounded-2xl bg-zinc-50 dark:bg-zinc-800 border-2 border-dashed border-zinc-100 dark:border-zinc-800 flex items-center justify-center text-zinc-300 dark:text-zinc-700"><ImageIcon size={28} /></div>}
            </div>
            <div className="flex-1">
              <div className="mb-2 flex items-center gap-2">
                <span className="text-[10px] font-extrabold text-zinc-400 uppercase tracking-[0.2em]">Mặt trước</span>
                {frontAudio.map((src, index) => (
                  <AudioButton
                    key={`front-${card.id}-${index}`}
                    src={src}
                    size="icon-sm"
                    variant="outline"
                    className="h-7 w-7 rounded-lg"
                    label={`Phát audio mặt trước ${index + 1}`}
                  />
                ))}
              </div>
              <div className="text-lg font-bold text-zinc-900 dark:text-white prose prose-sm prose-zinc dark:prose-invert leading-relaxed">
                <ReactMarkdown>{card.front}</ReactMarkdown>
              </div>
            </div>
          </div>
          <div className="flex justify-between items-start gap-6">
            <div className="flex gap-6 flex-1">
              <div className="flex flex-col gap-2">
                {card.backImageUrl && (
                  <div className="w-24 h-24 rounded-2xl overflow-hidden flex-shrink-0 border-2 border-zinc-50 dark:border-zinc-800 shadow-md">
                    <img src={card.backImageUrl} alt="" loading="lazy" className="w-full h-full object-cover" referrerPolicy="no-referrer" />
                  </div>
                )}
              </div>
              <div className="flex-1">
                <div className="mb-2 flex items-center gap-2">
                  <span className="text-[10px] font-extrabold text-zinc-400 uppercase tracking-[0.2em]">Mặt sau</span>
                  {backAudio.map((src, index) => (
                    <AudioButton
                      key={`back-${card.id}-${index}`}
                      src={src}
                      size="icon-sm"
                      variant="outline"
                      className="h-7 w-7 rounded-lg"
                      label={`Phát audio mặt sau ${index + 1}`}
                    />
                  ))}
                </div>
                <div className="text-base font-medium text-zinc-600 dark:text-zinc-400 prose prose-sm prose-zinc dark:prose-invert leading-relaxed">
                  <ReactMarkdown>{card.back}</ReactMarkdown>
                </div>
              </div>
            </div>
            <div className="flex flex-col items-end gap-4">
              {isOwner && (
                <div className="flex items-center gap-1 bg-zinc-50 dark:bg-zinc-800/50 p-1 rounded-xl">
                  <Button variant="ghost" size="icon" title="Sửa thẻ" aria-label="Sửa thẻ" className="h-9 w-9 text-zinc-400 hover:text-emerald-600 dark:hover:text-emerald-400 rounded-lg transition-colors" onClick={() => onEdit(card)}>
                    <Edit2 size={16} />
                  </Button>
                  <Button variant="ghost" size="icon" title="Hoãn hôm nay" aria-label="Hoãn hôm nay" className="h-9 w-9 text-zinc-400 hover:text-sky-600 dark:hover:text-sky-400 rounded-lg transition-colors" onClick={() => onBury(card)}>
                    <Calendar size={16} />
                  </Button>
                  <Button variant="ghost" size="icon" title="Tạm dừng thẻ" aria-label="Tạm dừng thẻ" className="h-9 w-9 text-zinc-400 hover:text-amber-600 dark:hover:text-amber-400 rounded-lg transition-colors" onClick={() => onToggleSuspend(card)}>
                    <Lock size={16} />
                  </Button>
                  <Button variant="ghost" size="icon" title="Xóa thẻ" aria-label="Xóa thẻ" className="h-9 w-9 text-zinc-400 hover:text-red-500 rounded-lg transition-colors" onClick={() => onDelete(card.id)}>
                    <Trash2 size={16} />
                  </Button>
                </div>
              )}
              <span className={`text-[10px] px-3 py-1 rounded-full font-extrabold uppercase tracking-widest ${statusClass}`}>
                {statusLabel}
              </span>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
});

export default function DeckDetail({ user, profile }: DeckDetailProps) {
  const { deckId } = useParams();
  const navigate = useNavigate();
  const { settings } = useSettings();
  const [deck, setDeck] = useState<Deck | null>(null);
  // "Thẻ khó" follows THIS deck's effective leech threshold: the deck's own
  // options override the global scheduler config when present (đợt 3A).
  // SettingsContext's scheduler mirrors the profile's scheduler config.
  const leechThreshold = useMemo(
    () => resolveDeckSchedulerConfig(settings.scheduler, deck).leechThreshold,
    [settings.scheduler, deck],
  );
  const [cards, setCards] = useState<Flashcard[]>([]);
  const [loading, setLoading] = useState(true);
  const [deckError, setDeckError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [cardSearch, setCardSearch] = useState('');
  const [cardFilter, setCardFilter] = useState<CardFilter>('all');
  const [editingCard, setEditingCard] = useState<Flashcard | null>(null);
  const [isAddModalOpen, setIsAddModalOpen] = useState(false);
  const [newCard, setNewCard] = useState({
    front: '',
    back: '',
    cardType: 'basic' as NoteCardType,
    clozeText: '',
    frontImage: '',
    backImage: '',
    backgroundColor: '',
    fontSize: 'normal',
    textColor: ''
  });
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [aiText, setAiText] = useState('');
  const [isGenerating, setIsGenerating] = useState(false);
  const [isImportingAiFile, setIsImportingAiFile] = useState(false);
  const aiFileInputRef = useRef<HTMLInputElement>(null);
  const [mindmap, setMindmap] = useState('');
  const [aiMindmap, setAiMindmap] = useState('');
  const [showMindmap, setShowMindmap] = useState(true);
  const [visibleCardCount, setVisibleCardCount] = useState(CARDS_PAGE_SIZE);
  const [cardSort, setCardSort] = useState<CardSort>('created');
  // Bulk selection lives at page level as a Set of card ids so it survives
  // pagination, search and filter changes (Anki Browser-style).
  const [selectedCardIds, setSelectedCardIds] = useState<Set<string>>(new Set());
  const [bulkDialog, setBulkDialog] = useState<'tag' | 'move' | null>(null);
  const [bulkTagInput, setBulkTagInput] = useState('');
  const [otherDecks, setOtherDecks] = useState<Array<{ id: string; name: string; cardCount: number }>>([]);
  const [isLoadingDecks, setIsLoadingDecks] = useState(false);
  const [isBulkProcessing, setIsBulkProcessing] = useState(false);
  const [confirmAction, setConfirmAction] = useState<
    | { kind: 'deck' }
    | { kind: 'card'; cardId: string }
    | { kind: 'cards-bulk' }
    | null
  >(null);
  const [isSavingMindmap, setIsSavingMindmap] = useState(false);
  const [isGeneratingMindmap, setIsGeneratingMindmap] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [isEditingDeck, setIsEditingDeck] = useState(false);
  const [editedDeck, setEditedDeck] = useState({ name: '', category: '', color: '', tags: '' });
  // Deck snapshots must not clobber the edit form while the user is typing in it.
  const isEditingDeckRef = useRef(false);
  useEffect(() => { isEditingDeckRef.current = isEditingDeck; }, [isEditingDeck]);
  const [isUpdatingDeck, setIsUpdatingDeck] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);
  // Per-deck scheduler options dialog (đợt 3A). Draft fields are strings;
  // an empty field means "inherit the global config" for that option.
  const [isDeckOptionsOpen, setIsDeckOptionsOpen] = useState(false);
  const [deckOptionsDraft, setDeckOptionsDraft] = useState({
    newCardsPerDay: '',
    reviewsPerDay: '',
    desiredRetentionPercent: '',
    leechThreshold: '',
  });
  const [isSavingDeckOptions, setIsSavingDeckOptions] = useState(false);

  useEffect(() => {
    if (!deckId || !user) return;

    setLoading(true);
    setDeckError(null);
    setVisibleCardCount(CARDS_PAGE_SIZE);
    setSelectedCardIds(new Set());

    // Listen to deck changes
    const deckRef = doc(db, 'decks', deckId);
    const unsubscribeDeck = onSnapshot(deckRef, (snap) => {
      if (snap.exists()) {
        const deckData = { id: snap.id, ...snap.data() } as DeckWithAiMindmap;
        setDeck(deckData);
        setDeckError(null);
        setMindmap(deckData.mindmap || '');
        setAiMindmap(deckData.aiMindmap || '');
        if (!isEditingDeckRef.current) {
          setEditedDeck({
            name: deckData.name,
            category: deckData.category,
            color: deckData.color || '#10b981',
            tags: deckData.tags?.join(', ') || ''
          });
        }
      } else {
        // Missing/deleted deck: show a friendly error screen (below)
        // instead of a blank page or an abrupt redirect.
        setDeck(null);
        setDeckError('Không tìm thấy bộ thẻ này. Bộ thẻ có thể đã bị xóa hoặc bạn không có quyền truy cập.');
        setLoading(false);
      }
    }, (error) => {
      console.error(error);
      setDeckError('Không tải được bộ thẻ. Kiểm tra kết nối mạng rồi thử lại.');
      setLoading(false);
    });

    // Listen to cards changes
    const cardsRef = collection(db, `decks/${deckId}/cards`);
    const unsubscribeCards = onSnapshot(cardsRef, (snap) => {
      const cardsData = snap.docs.map(doc => ({ id: doc.id, ...doc.data() } as Flashcard));
      // Sort in memory
      cardsData.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
      setCards(cardsData);
      setLoading(false);
    }, (error) => {
      console.error(error);
      setLoading(false);
    });

    return () => {
      unsubscribeDeck();
      unsubscribeCards();
    };
  }, [deckId, user, navigate, reloadKey]);

  // Changing the card search/filter/sort restarts pagination from page one.
  useEffect(() => {
    setVisibleCardCount(CARDS_PAGE_SIZE);
  }, [cardSearch, cardFilter, cardSort]);

  const handleDelete = () => {
    if (!deckId) return;
    setConfirmAction({ kind: 'deck' });
  };

  const performDeleteDeck = async () => {
    if (!deckId) return;
    try {
      await deleteDoc(doc(db, 'decks', deckId));
      toast.success("Đã xóa bộ thẻ.");
      navigate('/decks');
    } catch (error) {
      console.error(error);
      toast.error("Lỗi khi xóa bộ thẻ.");
    }
  };

  const togglePublic = async () => {
    if (!deckId || !deck) return;
    try {
      const newValue = !deck.isPublic;
      await updateDoc(doc(db, 'decks', deckId), {
        isPublic: newValue
      });
      setDeck({ ...deck, isPublic: newValue });
      toast.success(newValue ? "Bộ thẻ hiện đã công khai!" : "Bộ thẻ hiện đã ở chế độ riêng tư.");
    } catch (error) {
      console.error(error);
      toast.error("Lỗi khi cập nhật trạng thái.");
    }
  };

  const handleUpdateCard = async () => {
    if (!deckId || !editingCard) return;
    try {
      setIsSubmitting(true);
      const cardRef = doc(db, `decks/${deckId}/cards`, editingCard.id);
      await updateDoc(cardRef, {
        front: editingCard.front,
        back: editingCard.back,
        imageUrl: editingCard.imageUrl || '',
        backImageUrl: editingCard.backImageUrl || '',
        customStyles: editingCard.customStyles || {}
      });
      toast.success("Đã cập nhật thẻ.");
      setEditingCard(null);
    } catch (error) {
      console.error(error);
      toast.error("Lỗi khi cập nhật thẻ.");
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleDeleteCard = useCallback((cardId: string) => {
    if (!deckId) return;
    setConfirmAction({ kind: 'card', cardId });
  }, [deckId]);

  const handleEditCard = useCallback((card: Flashcard) => {
    setEditingCard(card);
  }, []);

  const performDeleteCard = async (cardId: string) => {
    if (!deckId) return;
    try {
      await deleteDoc(doc(db, `decks/${deckId}/cards`, cardId));
      await updateDoc(doc(db, 'decks', deckId), {
        cardCount: increment(-1)
      });
      toast.success("Đã xóa thẻ.");
    } catch (error) {
      console.error(error);
      toast.error("Lỗi khi xóa thẻ.");
    }
  };

  const handleConfirmAction = async () => {
    const action = confirmAction;
    setConfirmAction(null);
    if (!action) return;
    if (action.kind === 'deck') {
      await performDeleteDeck();
    } else if (action.kind === 'cards-bulk') {
      await performBulkDeleteCards();
    } else {
      await performDeleteCard(action.cardId);
    }
  };

  const handleToggleSuspendCard = useCallback(async (card: Flashcard) => {
    if (!deckId) return;
    const schedule = normalizeCardSchedule(card);
    await updateDoc(doc(db, `decks/${deckId}/cards`, card.id), {
      suspended: !schedule.suspended,
      buriedUntil: schedule.suspended ? '' : card.buriedUntil || '',
    });
    toast.success(schedule.suspended ? 'Đã bỏ tạm dừng thẻ.' : 'Đã tạm dừng thẻ.');
  }, [deckId]);

  const handleBuryCard = useCallback(async (card: Flashcard) => {
    if (!deckId) return;
    const currentlyBuried = isCardBuried(card);
    const tomorrow = new Date();
    tomorrow.setHours(24, 0, 0, 0);

    await updateDoc(doc(db, `decks/${deckId}/cards`, card.id), {
      buriedUntil: currentlyBuried ? '' : tomorrow.toISOString(),
    });
    toast.success(currentlyBuried ? 'Đã bỏ hoãn thẻ.' : 'Đã hoãn thẻ đến ngày mai.');
  }, [deckId]);

  const handleAddCard = async () => {
    if (!deckId || !user) return;

    // Validate theo loại ghi chú: cloze cần cú pháp hợp lệ, cơ bản/đảo ngược
    // cần đủ hai mặt.
    const draft: NoteDraft = {
      cardType: newCard.cardType,
      front: newCard.front,
      back: newCard.back,
      clozeText: newCard.clozeText,
    };
    if (draft.cardType === 'cloze') {
      const errors = validateClozeText(draft.clozeText);
      if (errors.length > 0) {
        toast.error(errors[0]);
        return;
      }
    } else if (!draft.front.trim() || !draft.back.trim()) {
      toast.error("Vui lòng nhập đầy đủ mặt trước và mặt sau.");
      return;
    }

    try {
      setIsSubmitting(true);
      // Mở rộng ghi chú thành thẻ vật lý (đảo ngược → 2 thẻ, cloze → 1 thẻ/chỉ số).
      const builtCards = buildNoteCards(draft);
      await Promise.all(builtCards.map(built => addDoc(collection(db, `decks/${deckId}/cards`), {
        deckId,
        ownerId: user.uid,
        front: built.front,
        back: built.back,
        type: built.type,
        cardType: built.cardType,
        // Firestore không nhận giá trị undefined — chỉ ghi khi có.
        ...(built.noteId ? { noteId: built.noteId } : {}),
        ...(built.clozeText ? { clozeText: built.clozeText } : {}),
        ...(built.clozeIndex !== undefined ? { clozeIndex: built.clozeIndex } : {}),
        imageUrl: newCard.frontImage,
        backImageUrl: newCard.backImage,
        customStyles: {
          backgroundColor: newCard.backgroundColor,
          fontSize: newCard.fontSize,
          textColor: newCard.textColor
        },
        tags: [],
        ...createInitialCardSchedule(),
        createdAt: new Date().toISOString()
      })));

      await updateDoc(doc(db, 'decks', deckId), {
        cardCount: increment(builtCards.length)
      });

      toast.success(builtCards.length > 1 ? `Đã thêm ${builtCards.length} thẻ mới.` : "Đã thêm thẻ mới.");
      setNewCard({
        front: '',
        back: '',
        cardType: 'basic',
        clozeText: '',
        frontImage: '',
        backImage: '',
        backgroundColor: '',
        fontSize: 'normal',
        textColor: ''
      });
      setIsAddModalOpen(false);
    } catch (error) {
      console.error(error);
      toast.error("Lỗi khi thêm thẻ.");
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleAiFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setIsImportingAiFile(true);
    try {
      const result = await extractTextFromDocument(file);
      // Nối thêm vào nội dung đang soạn (không ghi đè câm lặng).
      setAiText(prev => (prev ? prev + '\n\n' : '') + result.text);
      if (result.truncated) {
        toast.warning('Nội dung file quá dài nên đã được cắt bớt — hãy chia nhỏ tài liệu nếu cần phần còn lại.');
      } else {
        toast.success('Đã đổ nội dung file vào ô nội dung AI.');
      }
    } catch (error: any) {
      console.error(error);
      toast.error(error?.message || 'Không đọc được file. Vui lòng thử lại với file khác.');
    } finally {
      setIsImportingAiFile(false);
    }
  };

  const handleGenerateAI = async () => {
    if (!aiText.trim() || !deckId || !user) return;
    setIsGenerating(true);
    try {
      const { generateFlashcardsFromText } = await import('../services/aiService');
      const generated = await generateFlashcardsFromText(aiText, 5, "", { geminiApiKey: profile?.settings?.geminiApiKey || profile?.settings?.aiApiKey });
      if (generated && generated.length > 0) {
        const batch = generated.map(card => 
          addDoc(collection(db, `decks/${deckId}/cards`), {
            deckId,
            ownerId: user.uid,
            front: card.front,
            back: card.back,
            imageUrl: card.imageUrl || '',
            tags: [],
            ...createInitialCardSchedule(),
            createdAt: new Date().toISOString()
          })
        );
        await Promise.all(batch);
        await updateDoc(doc(db, 'decks', deckId), {
          cardCount: increment(generated.length)
        });
        toast.success(`Đã thêm ${generated.length} thẻ từ AI!`);
        setAiText('');
        setIsAddModalOpen(false);
      }
    } catch (error) {
      console.error(error);
      toast.error("Lỗi khi tạo thẻ bằng AI.");
    } finally {
      setIsGenerating(false);
    }
  };

  const handleGenerateMindmap = async () => {
    if (!deckId) return;
    if (!mindmap.trim() && !aiMindmap.trim() && cards.length === 0) {
      toast.error("Vui lòng nhập nội dung ghi chú hoặc thêm thẻ trước.");
      return;
    }

    setIsGeneratingMindmap(true);
    try {
      const { generateMindmap } = await import('../services/aiService');
      const context = mindmap.trim() || aiMindmap.trim() || cards.map(c => `${c.front}: ${c.back}`).join('\n');
      const generated = await generateMindmap(context, { geminiApiKey: profile?.settings?.geminiApiKey || profile?.settings?.aiApiKey });
      // Mindmap AI lưu ở field riêng (aiMindmap) — ghi chú gốc của người dùng giữ nguyên.
      setAiMindmap(generated);
      await updateDoc(doc(db, 'decks', deckId), {
        aiMindmap: generated
      });
      toast.success("AI đã tạo mindmap mới! Ghi chú gốc của bạn được giữ nguyên.");
    } catch (error) {
      console.error(error);
      toast.error("Lỗi khi tạo Mindmap AI.");
    } finally {
      setIsGeneratingMindmap(false);
    }
  };

  const handleSaveMindmap = async () => {
    if (!deckId) return;
    setIsSavingMindmap(true);
    try {
      await updateDoc(doc(db, 'decks', deckId), {
        mindmap: mindmap
      });
      toast.success("Đã lưu ghi chú.");
    } catch (error) {
      console.error(error);
      toast.error("Lỗi khi lưu Mindmap.");
    } finally {
      setIsSavingMindmap(false);
    }
  };

  const handleExportAnki = async () => {
    if (!deck || cards.length === 0) {
      toast.error("Không có thẻ nào để xuất.");
      return;
    }

    setIsExporting(true);
    const toastId = toast.loading("Đang chuẩn bị tệp Anki...");

    try {
      const { exportAnkiApkgDetailed } = await import('../services/ankiService');
      const ankiCards = cards.map(c => ({
        front: c.front,
        back: c.back,
        type: c.type,
        ...(c.cardType ? { cardType: c.cardType } : {}),
        ...(c.clozeText ? { clozeText: c.clozeText } : {}),
        ...(typeof c.clozeIndex === 'number' ? { clozeIndex: c.clozeIndex } : {}),
        ...(c.noteId ? { noteId: c.noteId } : {}),
        tags: c.tags,
        frontImage: c.imageUrl,
        backImage: c.backImageUrl,
        frontImages: c.frontImages,
        backImages: c.backImages,
        frontAudio: c.frontAudio,
        backAudio: c.backAudio,
        audioUrls: c.audioUrls,
      }));

      const { blob, warnings } = await exportAnkiApkgDetailed(deck.name, ankiCards);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${deck.name.replace(/\s+/g, '_')}.apkg`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      
      toast.success("Đã xuất tệp Anki thành công!", { id: toastId });
      if (warnings.length > 0) {
        toast.warning(warnings.join('\n'), { duration: 9000 });
      }
    } catch (error: any) {
      console.error("Anki Export Error:", error);
      toast.error("Lỗi khi xuất tệp Anki: " + (error.message || "Lỗi không xác định"), { id: toastId });
    } finally {
      setIsExporting(false);
    }
  };

  const handleUpdateDeck = async () => {
    if (!deckId || !editedDeck.name.trim()) return;
    setIsUpdatingDeck(true);
    try {
      await updateDoc(doc(db, 'decks', deckId), {
        name: editedDeck.name,
        category: editedDeck.category,
        color: editedDeck.color,
        tags: editedDeck.tags.split(',').map(tag => tag.trim()).filter(tag => tag !== '')
      });
      toast.success("Đã cập nhật thông tin bộ thẻ.");
      setIsEditingDeck(false);
    } catch (error) {
      console.error(error);
      toast.error("Lỗi khi cập nhật bộ thẻ.");
    } finally {
      setIsUpdatingDeck(false);
    }
  };

  const openDeckOptions = () => {
    const options = deck?.options;
    setDeckOptionsDraft({
      newCardsPerDay: options?.newCardsPerDay !== undefined ? String(options.newCardsPerDay) : '',
      reviewsPerDay: options?.reviewsPerDay !== undefined ? String(options.reviewsPerDay) : '',
      desiredRetentionPercent: options?.desiredRetention !== undefined ? String(Math.round(options.desiredRetention * 100)) : '',
      leechThreshold: options?.leechThreshold !== undefined ? String(options.leechThreshold) : '',
    });
    setIsDeckOptionsOpen(true);
  };

  const handleSaveDeckOptions = async () => {
    if (!deckId) return;
    // Parse the draft: empty field = inherit (field omitted from the stored
    // options object); a filled field must be a valid non-negative number.
    const options: DeckOptions = {};
    const parseCount = (raw: string, key: 'newCardsPerDay' | 'reviewsPerDay' | 'leechThreshold') => {
      const trimmed = raw.trim();
      if (!trimmed) return true;
      const value = Number(trimmed);
      if (!Number.isFinite(value) || value < 0) return false;
      options[key] = Math.trunc(value);
      return true;
    };
    if (
      !parseCount(deckOptionsDraft.newCardsPerDay, 'newCardsPerDay')
      || !parseCount(deckOptionsDraft.reviewsPerDay, 'reviewsPerDay')
      || !parseCount(deckOptionsDraft.leechThreshold, 'leechThreshold')
    ) {
      toast.error("Giá trị tuỳ chọn phải là số từ 0 trở lên.");
      return;
    }
    const retentionRaw = deckOptionsDraft.desiredRetentionPercent.trim();
    if (retentionRaw) {
      const percent = Number(retentionRaw);
      if (!Number.isFinite(percent)) {
        toast.error("Tỷ lệ nhớ mục tiêu phải là một số phần trăm hợp lệ.");
        return;
      }
      // Stored as a fraction; normalizeSchedulerConfig clamps to 0.7–0.98
      // when the config is resolved, same as the global Settings flow.
      options.desiredRetention = percent / 100;
    }

    setIsSavingDeckOptions(true);
    try {
      await updateDoc(doc(db, 'decks', deckId), {
        // Store a clean options object holding only the overridden fields;
        // when every field is blank the whole field is removed so the deck
        // fully inherits the global config again.
        options: Object.keys(options).length > 0 ? options : deleteField(),
      });
      toast.success("Đã lưu tuỳ chọn cho bộ thẻ này.");
      setIsDeckOptionsOpen(false);
    } catch (error) {
      console.error(error);
      toast.error("Lỗi khi lưu tuỳ chọn bộ thẻ.");
    } finally {
      setIsSavingDeckOptions(false);
    }
  };

  const handleSync = async () => {
    if (!user || !deck) {
      toast.error("Vui lòng đăng nhập để đồng bộ.");
      return;
    }

    setIsSyncing(true);
    try {
      // 1. Create a new deck for the current user
      const newDeckRef = await addDoc(collection(db, 'decks'), {
        ownerId: user.uid,
        authorName: deck.authorName || 'Ẩn danh',
        name: `${deck.name} (Đã đồng bộ)`,
        description: deck.description,
        category: deck.category,
        cardCount: deck.cardCount,
        mindmap: deck.mindmap || '',
        aiMindmap: (deck as DeckWithAiMindmap).aiMindmap || '',
        color: deck.color || '#10b981',
        tags: deck.tags || [],
        createdAt: new Date().toISOString(),
        isPublic: false
      });

      // 2. Copy all cards to the new deck
      const copyPromises = cards.map(card => 
        addDoc(collection(db, `decks/${newDeckRef.id}/cards`), {
          deckId: newDeckRef.id,
          ownerId: user.uid,
          front: card.front,
          back: card.back,
          type: card.type || 'basic',
          noteType: card.noteType || '',
          noteId: card.noteId || '',
          extraFields: card.extraFields || {},
          imageUrl: card.imageUrl || '',
          backImageUrl: card.backImageUrl || '',
          frontImages: card.frontImages || [],
          backImages: card.backImages || [],
          frontAudio: card.frontAudio || [],
          backAudio: card.backAudio || [],
          audioUrls: card.audioUrls || [...(card.frontAudio || []), ...(card.backAudio || [])],
          customStyles: card.customStyles || {},
          tags: card.tags || [],
          ...createInitialCardSchedule(),
          createdAt: new Date().toISOString()
        })
      );

      await Promise.all(copyPromises);
      toast.success(`Đã đồng bộ bộ thẻ "${deck.name}" về tài khoản của bạn!`);
      navigate(`/decks/${newDeckRef.id}`);
    } catch (error) {
      console.error(error);
      toast.error("Lỗi khi đồng bộ bộ thẻ.");
    } finally {
      setIsSyncing(false);
    }
  };

  // Deck stats in one memoized pass over the cards (previously several
  // full-array filters ran on every render of this 1.200-line page).
  const deckStats = useMemo(() => {
    const now = new Date();
    let due = 0;
    let paused = 0;
    let hard = 0;
    for (const card of cards) {
      const schedule = normalizeCardSchedule(card, now);
      if (isCardDue(card)) due += 1;
      if (schedule.suspended || isCardBuried(card, now)) paused += 1;
      if ((card.lapses || 0) >= leechThreshold) hard += 1;
    }
    return { due, paused, hard };
  }, [cards, leechThreshold]);

  // Client-side search + status filter over the already-loaded cards.
  // "Thẻ khó" follows the scheduler's leech rule: lapses >= leechThreshold.
  const filteredCards = useMemo(() => {
    const term = cardSearch.trim().toLowerCase();
    const now = new Date();
    return cards.filter((card) => {
      if (term && !`${card.front} ${card.back}`.toLowerCase().includes(term)) return false;
      switch (cardFilter) {
        case 'due':
          return isCardDue(card);
        case 'hard':
          return (card.lapses || 0) >= leechThreshold;
        case 'suspended': {
          const schedule = normalizeCardSchedule(card, now);
          return schedule.suspended || isCardBuried(card, now);
        }
        default:
          return true;
      }
    });
  }, [cards, cardSearch, cardFilter, leechThreshold]);

  const filterCounts: Record<CardFilter, number> = {
    all: cards.length,
    due: deckStats.due,
    hard: deckStats.hard,
    suspended: deckStats.paused,
  };

  // Sort the filtered list (Anki Browser-style). Schedule fields are
  // decorated once per card instead of being normalized inside the
  // comparator on every comparison.
  const sortedCards = useMemo(() => {
    if (cardSort === 'created') return filteredCards;
    const decorated = filteredCards.map((card) => {
      const schedule = normalizeCardSchedule(card);
      return {
        card,
        dueTime: new Date(schedule.due).getTime() || 0,
        stability: schedule.stability || 0,
        lapses: card.lapses || 0,
      };
    });
    switch (cardSort) {
      case 'due':
        decorated.sort((a, b) => a.dueTime - b.dueTime);
        break;
      case 'stability':
        decorated.sort((a, b) => a.stability - b.stability);
        break;
      case 'lapses':
        decorated.sort((a, b) => b.lapses - a.lapses);
        break;
      case 'front':
        decorated.sort((a, b) => a.card.front.localeCompare(b.card.front, 'vi'));
        break;
    }
    return decorated.map((entry) => entry.card);
  }, [filteredCards, cardSort]);

  const visibleCards = sortedCards.slice(0, visibleCardCount);

  // Selection resolved against the live card list: ids of cards that were
  // deleted/moved elsewhere simply drop out of every bulk operation.
  const selectedCards = useMemo(
    () => cards.filter((card) => selectedCardIds.has(card.id)),
    [cards, selectedCardIds]
  );

  const handleToggleSelect = useCallback((cardId: string) => {
    setSelectedCardIds((prev) => {
      const next = new Set(prev);
      if (next.has(cardId)) next.delete(cardId);
      else next.add(cardId);
      return next;
    });
  }, []);

  const handleSelectVisible = () => {
    setSelectedCardIds((prev) => {
      const next = new Set(prev);
      visibleCards.forEach((card) => next.add(card.id));
      return next;
    });
  };

  // Commit writeBatch operations in chunks so a single batch never exceeds
  // Firestore's 500-operation limit (kept at ≤450 like the sync queue).
  const commitCardChunks = async (
    items: Flashcard[],
    opsPerItem: number,
    apply: (batch: WriteBatch, card: Flashcard) => void
  ) => {
    const perChunk = Math.max(1, Math.floor(450 / opsPerItem));
    let done = 0;
    for (let i = 0; i < items.length; i += perChunk) {
      const slice = items.slice(i, i + perChunk);
      const batch = writeBatch(db);
      slice.forEach((card) => apply(batch, card));
      await batch.commit();
      done += slice.length;
    }
    return done;
  };

  // Mirrors handleToggleSuspendCard's convention: unsuspending also clears
  // buriedUntil; suspending leaves buriedUntil untouched.
  const handleBulkSuspend = async (suspend: boolean) => {
    if (!deckId || selectedCards.length === 0 || isBulkProcessing) return;
    setIsBulkProcessing(true);
    try {
      const done = await commitCardChunks(selectedCards, 1, (batch, card) => {
        batch.update(
          doc(db, `decks/${deckId}/cards`, card.id),
          suspend ? { suspended: true } : { suspended: false, buriedUntil: '' }
        );
      });
      toast.success(suspend ? `Đã tạm dừng ${done} thẻ.` : `Đã bỏ tạm dừng ${done} thẻ.`);
      setSelectedCardIds(new Set());
    } catch (error) {
      console.error(error);
      toast.error('Có lỗi khi cập nhật thẻ. Một số thẻ có thể đã được xử lý — danh sách sẽ tự đồng bộ lại.');
    } finally {
      setIsBulkProcessing(false);
    }
  };

  const handleBulkTag = async () => {
    const tag = bulkTagInput.trim();
    if (!deckId || !tag || isBulkProcessing) return;
    const targets = selectedCards.filter((card) => !(card.tags || []).includes(tag));
    if (targets.length === 0) {
      toast.info('Tất cả thẻ đã chọn đều có tag này rồi.');
      setBulkDialog(null);
      return;
    }
    setIsBulkProcessing(true);
    try {
      const done = await commitCardChunks(targets, 1, (batch, card) => {
        batch.update(doc(db, `decks/${deckId}/cards`, card.id), {
          tags: [...(card.tags || []), tag],
        });
      });
      toast.success(`Đã gắn tag "${tag}" cho ${done} thẻ.`);
      setSelectedCardIds(new Set());
      setBulkDialog(null);
      setBulkTagInput('');
    } catch (error) {
      console.error(error);
      toast.error('Có lỗi khi gắn tag. Một số thẻ có thể đã được gắn — danh sách sẽ tự đồng bộ lại.');
    } finally {
      setIsBulkProcessing(false);
    }
  };

  const openBulkMoveDialog = async () => {
    if (!user || !deckId) return;
    setBulkDialog('move');
    setIsLoadingDecks(true);
    try {
      const snap = await getDocs(query(collection(db, 'decks'), where('ownerId', '==', user.uid)));
      setOtherDecks(
        snap.docs
          .map((deckDoc) => ({
            id: deckDoc.id,
            name: (deckDoc.data().name as string) || 'Bộ thẻ không tên',
            cardCount: (deckDoc.data().cardCount as number) || 0,
          }))
          .filter((entry) => entry.id !== deckId)
      );
    } catch (error) {
      console.error(error);
      toast.error('Không tải được danh sách bộ thẻ.');
    } finally {
      setIsLoadingDecks(false);
    }
  };

  // Move = create the doc in the target deck (same card id, deckId updated)
  // + delete the source doc, in the same batch; both decks' cardCount are
  // adjusted afterwards exactly like add/delete maintain them.
  const handleBulkMove = async (targetDeckId: string, targetName: string) => {
    if (!deckId || selectedCards.length === 0 || isBulkProcessing) return;
    const moving = selectedCards;
    setIsBulkProcessing(true);
    try {
      await commitCardChunks(moving, 2, (batch, card) => {
        const data: Record<string, unknown> = { ...card };
        delete data.id;
        Object.keys(data).forEach((key) => {
          if (data[key] === undefined) delete data[key];
        });
        batch.set(doc(db, `decks/${targetDeckId}/cards`, card.id), { ...data, deckId: targetDeckId });
        batch.delete(doc(db, `decks/${deckId}/cards`, card.id));
      });
      await updateDoc(doc(db, 'decks', deckId), { cardCount: increment(-moving.length) });
      await updateDoc(doc(db, 'decks', targetDeckId), { cardCount: increment(moving.length) });
      toast.success(`Đã chuyển ${moving.length} thẻ sang "${targetName}".`);
      setSelectedCardIds(new Set());
      setBulkDialog(null);
    } catch (error) {
      console.error(error);
      toast.error('Có lỗi khi chuyển thẻ. Kiểm tra lại danh sách trước khi thử lại.');
    } finally {
      setIsBulkProcessing(false);
    }
  };

  const performBulkDeleteCards = async () => {
    if (!deckId || selectedCards.length === 0) return;
    const targets = selectedCards;
    setIsBulkProcessing(true);
    try {
      await commitCardChunks(targets, 1, (batch, card) => {
        batch.delete(doc(db, `decks/${deckId}/cards`, card.id));
      });
      await updateDoc(doc(db, 'decks', deckId), { cardCount: increment(-targets.length) });
      toast.success(`Đã xóa ${targets.length} thẻ.`);
      setSelectedCardIds(new Set());
    } catch (error) {
      console.error(error);
      toast.error('Có lỗi khi xóa thẻ. Một số thẻ có thể đã bị xóa — danh sách sẽ tự đồng bộ lại.');
    } finally {
      setIsBulkProcessing(false);
    }
  };

  if (loading) {
    return (
      <div className="space-y-8" aria-busy="true">
        <div className="flex items-center gap-4">
          <div className="skeleton-block animate-pulse h-12 w-12 rounded-2xl bg-zinc-200/70 dark:bg-white/10" />
          <div className="space-y-2 flex-1">
            <div className="skeleton-block animate-pulse h-8 w-72 max-w-full rounded-xl bg-zinc-200/70 dark:bg-white/10" />
            <div className="skeleton-block animate-pulse h-4 w-48 rounded-lg bg-zinc-200/50 dark:bg-white/5" />
          </div>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 md:gap-8">
          {[0, 1, 2].map((i) => (
            <div key={i} className="skeleton-block animate-pulse h-36 rounded-[2rem] bg-zinc-200/50 dark:bg-white/5" />
          ))}
        </div>
        <div className="space-y-5">
          {[0, 1].map((i) => (
            <div key={i} className="skeleton-block animate-pulse h-44 rounded-[2rem] bg-zinc-200/50 dark:bg-white/5" />
          ))}
        </div>
      </div>
    );
  }
  if (deckError || !deck) {
    return (
      <div className="flex min-h-[60vh] flex-col items-center justify-center space-y-6 text-center">
        <div className="rounded-full bg-rose-100 p-6 dark:bg-rose-500/10">
          <BookOpen className="h-12 w-12 text-rose-500" />
        </div>
        <h2 className="text-2xl font-bold text-zinc-950 dark:text-white">Không mở được bộ thẻ</h2>
        <p className="max-w-sm text-zinc-500">
          {deckError || 'Không tìm thấy bộ thẻ này. Bộ thẻ có thể đã bị xóa hoặc bạn không có quyền truy cập.'}
        </p>
        <div className="flex flex-wrap items-center justify-center gap-3">
          <Button
            onClick={() => {
              setDeckError(null);
              setLoading(true);
              setReloadKey((key) => key + 1);
            }}
            className="gap-2"
          >
            <RotateCcw className="h-4 w-4" />
            Thử lại
          </Button>
          <Link to="/decks">
            <Button variant="outline">Về danh sách bộ thẻ</Button>
          </Link>
        </div>
      </div>
    );
  }

  const dueCards = deckStats.due;
  const isDeckOwner = deck.ownerId === user?.uid;
  // Schedule snapshot for the card open in the preview/edit dialog.
  const editingSchedule = editingCard ? normalizeCardSchedule(editingCard) : null;

  return (
    <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div className="relative h-24 md:h-32 overflow-hidden rounded-[2rem] shadow-lg">
        <img
          src={getCategoryArt(deck.category)}
          alt=""
          loading="lazy"
          decoding="async"
          className="h-full w-full object-cover"
        />
        <div className="pointer-events-none absolute inset-0 bg-gradient-to-r from-emerald-600/30 via-emerald-500/10 to-teal-500/25" />
      </div>
      <header className="flex flex-col md:flex-row md:items-center justify-between gap-6 px-1">
        <div className="flex items-start md:items-center gap-4 md:gap-5">
          <Link to="/decks" className="mt-1 md:mt-0">
            <Button variant="ghost" size="icon" className="h-10 w-10 md:h-12 md:w-12 rounded-xl md:rounded-2xl hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors">
              <ArrowLeft className="w-5 h-5 md:w-6 md:h-6 text-zinc-600 dark:text-zinc-400" />
            </Button>
          </Link>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 group">
              <h1 className="text-2xl md:text-4xl font-extrabold text-zinc-900 dark:text-white tracking-tight truncate flex items-center gap-3">
                <span className="w-3 h-8 rounded-full" style={{ backgroundColor: deck.color || '#10b981' }} />
                {deck.name}
              </h1>
              {deck.ownerId === user?.uid && (
                <Button 
                  variant="ghost" 
                  size="icon" 
                  className="h-8 w-8 rounded-lg opacity-0 group-hover:opacity-100 transition-opacity"
                  onClick={() => setIsEditingDeck(true)}
                >
                  <Edit2 size={16} className="text-zinc-400" />
                </Button>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-3 md:gap-4 text-zinc-500 dark:text-zinc-400 mt-1 md:mt-2">
              <div 
                className="flex items-center gap-2 px-2 py-0.5 md:px-3 md:py-1 rounded-lg md:rounded-xl font-extrabold text-[9px] md:text-[10px] uppercase tracking-widest"
                style={{ backgroundColor: `${deck.color || '#10b981'}15`, color: deck.color || '#10b981' }}
              >
                {deck.category}
              </div>
              <span className="text-[10px] md:text-xs font-bold uppercase tracking-widest">{deck.cardCount} thẻ</span>
              {deck.ownerId === user?.uid && (
                <div className="flex items-center gap-2 md:gap-3 px-2 py-0.5 md:px-3 md:py-1 bg-zinc-100 dark:bg-zinc-800/50 rounded-xl md:rounded-2xl border border-zinc-200/50 dark:border-zinc-700/50">
              {deck.isPublic ? <Globe className="w-3 h-3 md:w-3.5 md:h-3.5 text-emerald-600" /> : <Lock className="w-3 h-3 md:w-3.5 md:h-3.5 text-zinc-400" />}
                  <span className="text-[9px] md:text-[10px] font-extrabold uppercase tracking-widest">{deck.isPublic ? 'Công khai' : 'Riêng tư'}</span>
                  <Switch 
                    checked={deck.isPublic} 
                    onCheckedChange={togglePublic}
                    className="scale-[0.6] md:scale-75"
                  />
                </div>
              )}
            </div>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2 md:gap-3">
          <div className="flex items-center gap-2">
            <Button 
              variant="outline" 
              size="icon" 
              className="h-10 w-10 md:h-12 md:w-12 rounded-xl md:rounded-2xl border-zinc-200 dark:border-zinc-800 dark:bg-zinc-900 hover:bg-emerald-50 dark:hover:bg-emerald-900/20 transition-colors group" 
              onClick={handleExportAnki}
              disabled={isExporting}
              title="Xuất tệp Anki (.apkg)"
            >
              {isExporting ? <Loader2 className="animate-spin text-emerald-500 w-4.5 h-4.5 md:w-5 md:h-5" /> : <FileDown className="w-4.5 h-4.5 md:w-5 md:h-5 text-zinc-400 group-hover:text-emerald-500 transition-colors" />}
            </Button>
            {deck.ownerId === user?.uid && (
              <Button variant="outline" size="icon" title="Tuỳ chọn deck" aria-label="Tuỳ chọn deck" className="h-10 w-10 md:h-12 md:w-12 rounded-xl md:rounded-2xl border-zinc-200 dark:border-zinc-800 dark:bg-zinc-900 hover:bg-emerald-50 dark:hover:bg-emerald-900/20 transition-colors group" onClick={openDeckOptions}>
                <SlidersHorizontal className="w-4.5 h-4.5 md:w-5 md:h-5 text-zinc-400 group-hover:text-emerald-500 transition-colors" />
              </Button>
            )}
            {deck.ownerId === user?.uid ? (
              <Button variant="outline" size="icon" title="Xóa bộ thẻ" aria-label="Xóa bộ thẻ" className="h-10 w-10 md:h-12 md:w-12 rounded-xl md:rounded-2xl border-zinc-200 dark:border-zinc-800 dark:bg-zinc-900 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors group" onClick={handleDelete}>
                <Trash2 className="w-4.5 h-4.5 md:w-5 md:h-5 text-zinc-400 group-hover:text-red-500 transition-colors" />
              </Button>
            ) : deck.isPublic && (
              <Button 
                variant="outline" 
                size="icon" 
                className="h-10 w-10 md:h-12 md:w-12 rounded-xl md:rounded-2xl border-zinc-200 dark:border-zinc-800 dark:bg-zinc-900 hover:bg-emerald-50 dark:hover:bg-emerald-900/20 transition-colors group" 
                onClick={handleSync}
                disabled={isSyncing}
                title="Đồng bộ bộ thẻ này"
              >
                {isSyncing ? <Loader2 className="animate-spin text-emerald-500 w-4.5 h-4.5 md:w-5 md:h-5" /> : <Plus className="w-4.5 h-4.5 md:w-5 md:h-5 text-zinc-400 group-hover:text-emerald-500 transition-colors" />}
              </Button>
            )}
          </div>
          <Link to={`/study/${deckId}`} className="flex-1 md:flex-none">
            <Button className="w-full bg-emerald-600 hover:bg-emerald-700 h-10 md:h-12 px-6 md:px-8 rounded-xl md:rounded-2xl font-extrabold shadow-lg shadow-emerald-200 dark:shadow-none gap-2 transition-all active:scale-95 text-xs md:text-sm">
              <Play className="w-4 h-4 md:w-5 md:h-5" fill="currentColor" />
              BẮT ĐẦU HỌC
            </Button>
          </Link>
        </div>
      </header>

      {/* Edit Deck Modal */}
      <Dialog open={isEditingDeck} onOpenChange={setIsEditingDeck}>
        <DialogContent className="max-w-md rounded-3xl">
          <DialogHeader>
            <DialogTitle>Chỉnh sửa bộ thẻ</DialogTitle>
          </DialogHeader>
          <div className="space-y-6 py-4">
            <div className="space-y-2">
              <label className="text-xs font-extrabold text-zinc-400 uppercase tracking-widest">Tên bộ thẻ</label>
              <Input 
                value={editedDeck.name}
                onChange={(e) => setEditedDeck({...editedDeck, name: e.target.value})}
                className="rounded-xl h-12"
              />
            </div>
            <div className="space-y-2">
              <label className="text-xs font-extrabold text-zinc-400 uppercase tracking-widest">Chủ đề</label>
              <Input 
                value={editedDeck.category}
                onChange={(e) => setEditedDeck({...editedDeck, category: e.target.value})}
                className="rounded-xl h-12"
              />
            </div>
            <div className="space-y-2">
              <label className="text-xs font-extrabold text-zinc-400 uppercase tracking-widest">Tags (Phân tách bằng dấu phẩy)</label>
              <Input 
                value={editedDeck.tags}
                onChange={(e) => setEditedDeck({...editedDeck, tags: e.target.value})}
                className="rounded-xl h-12"
                placeholder="ngoại, sản, nhi..."
              />
            </div>
            <div className="space-y-2">
              <label className="text-xs font-extrabold text-zinc-400 uppercase tracking-widest">Màu sắc</label>
              <div className="flex items-center gap-3">
                <Input 
                  type="color"
                  value={editedDeck.color}
                  onChange={(e) => setEditedDeck({...editedDeck, color: e.target.value})}
                  className="w-12 h-12 p-1 rounded-xl cursor-pointer"
                />
                <div className="flex flex-wrap gap-2">
                  {['#10b981', '#ef4444', '#f59e0b', '#10b981', '#3b82f6', '#8b5cf6', '#ec4899', '#000000'].map(c => (
                    <button
                      key={c}
                      onClick={() => setEditedDeck({...editedDeck, color: c})}
                      className={`w-8 h-8 rounded-full border-2 transition-all ${editedDeck.color === c ? 'border-primary ring-2 ring-primary/20 scale-110' : 'border-transparent'}`}
                      style={{ backgroundColor: c }}
                    />
                  ))}
                </div>
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setIsEditingDeck(false)}>Hủy</Button>
            <Button onClick={handleUpdateDeck} disabled={isUpdatingDeck} className="bg-primary hover:bg-primary/90 text-white rounded-xl px-8 h-12 font-bold">
              {isUpdatingDeck ? <Loader2 className="animate-spin" size={20} /> : 'Cập nhật'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Deck Options Modal — per-deck scheduler overrides (đợt 3A) */}
      <Dialog open={isDeckOptionsOpen} onOpenChange={setIsDeckOptionsOpen}>
        <DialogContent className="max-w-md rounded-3xl">
          <DialogHeader>
            <DialogTitle>Tuỳ chọn bộ thẻ</DialogTitle>
          </DialogHeader>
          <div className="space-y-5 py-4">
            <p className="text-xs leading-5 text-zinc-500 dark:text-zinc-400">
              Các giá trị đặt ở đây chỉ áp dụng cho bộ thẻ này khi học. Để trống một ô nghĩa là dùng theo cấu hình chung trong Cài đặt.
            </p>
            {([
              ['newCardsPerDay', 'Thẻ mới mỗi ngày', '1', String(settings.scheduler.newCardsPerDay)],
              ['reviewsPerDay', 'Lượt ôn tối đa mỗi ngày', '1', String(settings.scheduler.reviewsPerDay)],
              ['desiredRetentionPercent', 'Tỷ lệ nhớ mục tiêu (%)', '1', `${Math.round(settings.scheduler.desiredRetention * 100)}%`],
              ['leechThreshold', 'Ngưỡng thẻ khó (số lần quên)', '1', String(settings.scheduler.leechThreshold)],
            ] as const).map(([key, label, step, inherited]) => (
              <div key={key} className="space-y-2">
                <label className="text-xs font-extrabold text-zinc-400 uppercase tracking-widest">{label}</label>
                <Input
                  type="number"
                  step={step}
                  min="0"
                  value={deckOptionsDraft[key]}
                  onChange={(e) => setDeckOptionsDraft((draft) => ({ ...draft, [key]: e.target.value }))}
                  placeholder={`Kế thừa: ${inherited}`}
                  className="rounded-xl h-12"
                />
                <p className="text-[11px] text-zinc-400">Kế thừa cấu hình chung: {inherited}</p>
              </div>
            ))}
          </div>
          <DialogFooter className="gap-2">
            <Button
              variant="ghost"
              onClick={() => setDeckOptionsDraft({ newCardsPerDay: '', reviewsPerDay: '', desiredRetentionPercent: '', leechThreshold: '' })}
            >
              Đặt lại kế thừa
            </Button>
            <Button variant="ghost" onClick={() => setIsDeckOptionsOpen(false)}>Hủy</Button>
            <Button onClick={handleSaveDeckOptions} disabled={isSavingDeckOptions} className="bg-primary hover:bg-primary/90 text-white rounded-xl px-8 h-12 font-bold">
              {isSavingDeckOptions ? <Loader2 className="animate-spin" size={20} /> : 'Lưu tuỳ chọn'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 md:gap-8">
        <Card className="bg-white dark:bg-zinc-900 border-none shadow-xl p-6 md:p-8 rounded-[1.5rem] md:rounded-[2.5rem] flex flex-col items-center justify-center text-center space-y-2 md:space-y-3 relative overflow-hidden group">
          <div className="absolute -top-12 -right-12 w-32 h-32 bg-orange-500/5 rounded-full blur-2xl group-hover:bg-orange-500/10 transition-colors" />
          <div className="h-12 w-12 md:h-14 md:w-14 rounded-xl md:rounded-2xl bg-orange-50 dark:bg-orange-900/30 text-orange-600 dark:text-orange-400 flex items-center justify-center mb-1 md:mb-2 shadow-inner">
            <Calendar className="w-6 h-6 md:w-7 md:h-7" />
          </div>
          <span className="text-3xl md:text-4xl font-extrabold text-zinc-900 dark:text-white tracking-tight">{dueCards}</span>
          <span className="text-[9px] md:text-[10px] font-extrabold text-zinc-400 uppercase tracking-[0.2em]">Cần ôn tập ngay</span>
        </Card>
        
        <Card className="bg-white dark:bg-zinc-900 border-none shadow-xl p-6 md:p-8 rounded-[1.5rem] md:rounded-[2.5rem] flex flex-col items-center justify-center text-center space-y-2 md:space-y-3 relative overflow-hidden group">
          <div className="absolute -top-12 -right-12 w-32 h-32 bg-emerald-500/5 rounded-full blur-2xl group-hover:bg-emerald-500/10 transition-colors" />
          <div className="h-12 w-12 md:h-14 md:w-14 rounded-xl md:rounded-2xl bg-emerald-50 dark:bg-emerald-900/30 text-emerald-600 dark:text-emerald-400 flex items-center justify-center mb-1 md:mb-2 shadow-inner">
            <BookOpen className="w-6 h-6 md:w-7 md:h-7" />
          </div>
          <span className="text-3xl md:text-4xl font-extrabold text-zinc-900 dark:text-white tracking-tight">{cards.length}</span>
          <span className="text-[9px] md:text-[10px] font-extrabold text-zinc-400 uppercase tracking-[0.2em]">Tổng số thẻ học</span>
        </Card>

        <Card className="bg-white dark:bg-zinc-900 border-none shadow-xl p-6 md:p-8 rounded-[1.5rem] md:rounded-[2.5rem] flex flex-col items-center justify-center text-center space-y-2 md:space-y-3 relative overflow-hidden group sm:col-span-2 lg:col-span-1">
          <div className="absolute -top-12 -right-12 w-32 h-32 bg-emerald-500/5 rounded-full blur-2xl group-hover:bg-emerald-500/10 transition-colors" />
          <div className="h-12 w-12 md:h-14 md:w-14 rounded-xl md:rounded-2xl bg-emerald-50 dark:bg-emerald-900/30 text-emerald-600 dark:text-emerald-400 flex items-center justify-center mb-1 md:mb-2 shadow-inner">
            <Clock className="w-6 h-6 md:w-7 md:h-7" />
          </div>
          <span className="text-3xl md:text-4xl font-extrabold text-zinc-900 dark:text-white tracking-tight">
            {format(new Date(deck.createdAt), 'dd/MM')}
          </span>
          <span className="text-[9px] md:text-[10px] font-extrabold text-zinc-400 uppercase tracking-[0.2em]">Ngày khởi tạo</span>
        </Card>
      </div>

      {/* Mindmap Section */}
      <section className="space-y-4">
          <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-primary/10 rounded-lg md:rounded-xl text-primary">
              <FileText className="w-4.5 h-4.5 md:w-5 md:h-5" />
            </div>
            <h2 className="text-xl md:text-2xl font-extrabold text-zinc-900 dark:text-white tracking-tight">Mindmap & Ghi chú bài học</h2>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setShowMindmap(!showMindmap)}
              className="ml-2 hover:bg-zinc-100 dark:hover:bg-white/5 rounded-full"
            >
              {showMindmap ? <ChevronUp size={18} /> : <ChevronDown size={18} />}
            </Button>
          </div>
          <div className="flex flex-wrap gap-2 w-full sm:w-auto">
            {deck.ownerId === user?.uid && (
              <>
                <Button 
                  onClick={handleGenerateMindmap} 
                  disabled={isGeneratingMindmap}
                  variant="outline"
                  className="flex-1 sm:flex-none border-primary/20 text-primary hover:bg-primary/5 h-10 px-5 rounded-xl font-bold gap-2 transition-all active:scale-95 text-xs"
                >
                  {isGeneratingMindmap ? <Loader2 className="animate-spin" size={16} /> : <Sparkles size={16} />}
                  TẠO MINDMAP AI
                </Button>
                <Button 
                  onClick={handleSaveMindmap} 
                  disabled={isSavingMindmap}
                  className="flex-1 sm:flex-none bg-emerald-600 hover:bg-emerald-700 h-10 px-6 rounded-xl font-bold gap-2 shadow-lg shadow-emerald-200 dark:shadow-none transition-all active:scale-95 text-xs"
                >
                  {isSavingMindmap ? <Loader2 className="animate-spin" size={16} /> : <Save size={16} />}
                  LƯU GHI CHÚ
                </Button>
              </>
            )}
          </div>
        </div>
        
        {showMindmap && (
          <div className="space-y-4">
          <Card className="bg-white dark:bg-zinc-900 border-none shadow-2xl rounded-2xl md:rounded-[2rem] overflow-hidden animate-in fade-in zoom-in duration-300">
            <div className="p-1 bg-zinc-50 dark:bg-zinc-800/50 border-b border-zinc-100 dark:border-white/5 flex items-center gap-2 px-4 md:px-6 py-2 md:py-3">
              <div className="flex gap-1">
                <div className="w-2.5 h-2.5 rounded-full bg-red-400/20 border border-red-400/30" />
                <div className="w-2.5 h-2.5 rounded-full bg-amber-400/20 border border-amber-400/30" />
                <div className="w-2.5 h-2.5 rounded-full bg-emerald-400/20 border border-emerald-400/30" />
              </div>
              <span className="text-[8px] md:text-[10px] font-extrabold text-zinc-400 uppercase tracking-[0.2em] ml-2 md:ml-4">Chế độ soạn thảo — Hỗ trợ Markdown</span>
            </div>
            <Textarea 
              placeholder="Dán Mindmap hoặc ghi chú chi tiết..."
              value={mindmap}
              onChange={(e) => setMindmap(e.target.value)}
              readOnly={deck.ownerId !== user?.uid}
              className="min-h-[250px] md:min-h-[300px] w-full p-6 md:p-10 text-base md:text-lg leading-relaxed border-none focus-visible:ring-0 bg-transparent resize-y font-medium text-zinc-700 dark:text-zinc-300 placeholder:text-zinc-300 dark:placeholder:text-zinc-700"
            />
            {mindmap.trim() && (
              <div className="p-6 md:p-10 bg-zinc-50 dark:bg-[#08090A] border-t border-zinc-200 dark:border-white/5">
                <div className="flex items-center gap-2 mb-6">
                  <div className="w-1 h-4 bg-primary rounded-full" />
                  <h3 className="text-[10px] font-extrabold text-zinc-400 uppercase tracking-[0.2em]">Xem trước Mindmap</h3>
                </div>
                <div className="markdown-body prose prose-slate dark:prose-invert max-w-none prose-headings:font-extrabold prose-headings:tracking-tight prose-p:font-medium prose-p:leading-relaxed prose-li:font-medium prose-strong:text-primary dark:prose-strong:text-primary">
                  <ReactMarkdown>{mindmap}</ReactMarkdown>
                </div>
              </div>
            )}
          </Card>
          {aiMindmap.trim() && (
            <Card className="premium-panel border-none shadow-2xl rounded-2xl md:rounded-[2rem] overflow-hidden animate-in fade-in zoom-in duration-300">
              <div className="p-1 bg-primary/5 dark:bg-primary/10 border-b border-primary/10 flex items-center gap-2 px-4 md:px-6 py-2 md:py-3">
                <Sparkles size={14} className="text-primary" />
                <span className="text-[8px] md:text-[10px] font-extrabold text-primary uppercase tracking-[0.2em]">Mindmap do AI tạo — tách riêng khỏi ghi chú của bạn</span>
              </div>
              <div className="p-6 md:p-10">
                <div className="markdown-body prose prose-slate dark:prose-invert max-w-none prose-headings:font-extrabold prose-headings:tracking-tight prose-p:font-medium prose-p:leading-relaxed prose-li:font-medium prose-strong:text-primary dark:prose-strong:text-primary">
                  <ReactMarkdown>{aiMindmap}</ReactMarkdown>
                </div>
              </div>
            </Card>
          )}
          </div>
        )}
      </section>

      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <h2 className="text-2xl font-extrabold text-zinc-900 dark:text-white tracking-tight">Danh sách thẻ học</h2>
          {deck.ownerId === user?.uid && (
            <Button onClick={() => setIsAddModalOpen(true)} className="bg-emerald-600 hover:bg-emerald-700 h-12 px-6 rounded-2xl font-extrabold gap-2 shadow-lg shadow-emerald-200 dark:shadow-none transition-all active:scale-95">
              <Plus size={18} /> THÊM THẺ MỚI
            </Button>
          )}
        </div>

        <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
          <div className="relative flex-1 w-full">
            <Search className="absolute left-4 top-1/2 -translate-y-1/2 text-zinc-400" size={18} />
            <Input
              placeholder="Tìm thẻ theo nội dung mặt trước / mặt sau..."
              value={cardSearch}
              onChange={(e) => setCardSearch(e.target.value)}
              className="pl-11 h-12 rounded-xl bg-white dark:bg-white/5 border-zinc-200 dark:border-white/10 dark:text-white"
            />
          </div>
          <div className="flex flex-wrap gap-2">
            {CARD_FILTERS.map((filter) => (
              <Button
                key={filter.key}
                variant={cardFilter === filter.key ? 'default' : 'outline'}
                onClick={() => setCardFilter(filter.key)}
                className="rounded-xl font-bold h-10 px-4 text-xs"
              >
                {filter.label} ({filterCounts[filter.key]})
              </Button>
            ))}
          </div>
          <select
            value={cardSort}
            onChange={(e) => setCardSort(e.target.value as CardSort)}
            aria-label="Sắp xếp danh sách thẻ"
            title="Sắp xếp danh sách thẻ"
            className="h-12 rounded-xl border border-zinc-200 dark:border-white/10 bg-white dark:bg-zinc-900 px-3 text-sm font-bold text-zinc-700 dark:text-zinc-200 cursor-pointer focus:outline-none focus:ring-2 focus:ring-ring"
          >
            {CARD_SORTS.map((option) => (
              <option key={option.key} value={option.key}>{option.label}</option>
            ))}
          </select>
        </div>

        {isDeckOwner && cards.length > 0 && (
          <div className="flex flex-wrap items-center gap-3">
            <Button
              variant="outline"
              onClick={handleSelectVisible}
              disabled={visibleCards.length === 0}
              className="rounded-xl font-bold h-10 px-4 text-xs gap-2 border-zinc-200 dark:border-white/10 dark:text-white"
            >
              <CheckCheck size={15} />
              Chọn tất cả đang hiển thị ({visibleCards.length})
            </Button>
            {selectedCards.length > 0 && (
              <span className="text-[11px] font-extrabold text-emerald-600 dark:text-emerald-400 uppercase tracking-widest">
                Đã chọn {selectedCards.length} thẻ
              </span>
            )}
          </div>
        )}

        {isDeckOwner && selectedCards.length > 0 && (
          <div className="flex flex-wrap items-center gap-2 rounded-2xl border border-emerald-100 dark:border-emerald-500/20 bg-emerald-50 dark:bg-emerald-500/10 p-3">
            <span className="text-sm font-extrabold text-emerald-900 dark:text-emerald-100 px-1">
              {selectedCards.length} thẻ đã chọn
            </span>
            <Button size="sm" variant="outline" disabled={isBulkProcessing} onClick={() => handleBulkSuspend(true)} className="rounded-xl font-bold h-9 gap-1.5 bg-white dark:bg-zinc-900">
              <Lock size={14} /> Tạm dừng
            </Button>
            <Button size="sm" variant="outline" disabled={isBulkProcessing} onClick={() => handleBulkSuspend(false)} className="rounded-xl font-bold h-9 gap-1.5 bg-white dark:bg-zinc-900">
              <Play size={14} /> Bỏ tạm dừng
            </Button>
            <Button size="sm" variant="outline" disabled={isBulkProcessing} onClick={() => { setBulkTagInput(''); setBulkDialog('tag'); }} className="rounded-xl font-bold h-9 gap-1.5 bg-white dark:bg-zinc-900">
              <Tag size={14} /> Gắn tag
            </Button>
            <Button size="sm" variant="outline" disabled={isBulkProcessing} onClick={openBulkMoveDialog} className="rounded-xl font-bold h-9 gap-1.5 bg-white dark:bg-zinc-900">
              <ArrowRightLeft size={14} /> Chuyển deck
            </Button>
            <Button size="sm" variant="destructive" disabled={isBulkProcessing} onClick={() => setConfirmAction({ kind: 'cards-bulk' })} className="rounded-xl font-bold h-9 gap-1.5">
              <Trash2 size={14} /> Xóa
            </Button>
            <Button size="sm" variant="ghost" disabled={isBulkProcessing} onClick={() => setSelectedCardIds(new Set())} className="rounded-xl font-bold h-9 gap-1.5">
              <CloseIcon size={14} /> Bỏ chọn
            </Button>
            {isBulkProcessing && <Loader2 className="animate-spin text-emerald-500" size={16} />}
          </div>
        )}

        <div className="grid gap-5">
          {visibleCards.map((card) => (
            <DeckCardRow
              key={card.id}
              card={card}
              isOwner={deck.ownerId === user?.uid}
              selected={selectedCardIds.has(card.id)}
              onToggleSelect={handleToggleSelect}
              onPreview={handleEditCard}
              onEdit={handleEditCard}
              onDelete={handleDeleteCard}
              onBury={handleBuryCard}
              onToggleSuspend={handleToggleSuspendCard}
            />
          ))}
          {cards.length > 0 && filteredCards.length === 0 && (
            <div className="premium-panel py-16 text-center">
              <p className="text-lg font-bold text-zinc-900 dark:text-white">Không có thẻ nào khớp điều kiện lọc</p>
              <p className="text-zinc-500 dark:text-zinc-400 mt-2 font-medium">Thử đổi từ khóa tìm kiếm hoặc chọn bộ lọc khác.</p>
              <Button
                variant="outline"
                onClick={() => { setCardSearch(''); setCardFilter('all'); }}
                className="gap-2 h-11 px-6 rounded-xl font-bold border-zinc-200 dark:border-white/10 dark:text-white mt-6"
              >
                <RotateCcw size={16} />
                Xóa bộ lọc
              </Button>
            </div>
          )}
        </div>

        {filteredCards.length > 0 && (
          <div className="flex flex-col items-center gap-3 pt-2">
            <p className="text-xs font-bold text-zinc-400 uppercase tracking-widest">
              Đang hiển thị {visibleCards.length}/{filteredCards.length} thẻ
              {(cardSearch.trim() || cardFilter !== 'all') ? ` (đã lọc từ ${cards.length} thẻ)` : ''}
            </p>
            {visibleCardCount < filteredCards.length && (
              <Button
                variant="outline"
                onClick={() => setVisibleCardCount((count) => count + CARDS_PAGE_SIZE)}
                className="h-11 px-8 rounded-2xl font-bold border-zinc-200 dark:border-white/10 dark:text-white"
              >
                Xem thêm thẻ (còn {filteredCards.length - visibleCardCount})
              </Button>
            )}
          </div>
        )}
      </div>

      <ConfirmDialog
        open={confirmAction !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmAction(null);
        }}
        title={
          confirmAction?.kind === 'deck'
            ? 'Xóa bộ thẻ này?'
            : confirmAction?.kind === 'cards-bulk'
              ? `Xóa ${selectedCards.length} thẻ đã chọn?`
              : 'Xóa thẻ này?'
        }
        description={
          confirmAction?.kind === 'deck'
            ? 'Toàn bộ thẻ và tiến độ học trong bộ thẻ sẽ bị xóa. Hành động này không thể hoàn tác.'
            : confirmAction?.kind === 'cards-bulk'
              ? `${selectedCards.length} thẻ đã chọn sẽ bị xóa khỏi bộ thẻ cùng với tiến độ học của chúng. Hành động này không thể hoàn tác.`
              : 'Thẻ sẽ bị xóa khỏi bộ thẻ cùng với tiến độ học của nó. Hành động này không thể hoàn tác.'
        }
        confirmLabel="Xóa"
        cancelLabel="Hủy"
        destructive
        onConfirm={handleConfirmAction}
      />

      {/* Bulk: Add Tag Dialog */}
      <Dialog open={bulkDialog === 'tag'} onOpenChange={(open) => { if (!open) setBulkDialog(null); }}>
        <DialogContent className="max-w-md rounded-3xl">
          <DialogHeader>
            <DialogTitle>Gắn tag cho {selectedCards.length} thẻ</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <div className="space-y-2">
              <label className="text-xs font-extrabold text-zinc-400 uppercase tracking-widest">Tên tag</label>
              <Input
                value={bulkTagInput}
                onChange={(e) => setBulkTagInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') handleBulkTag(); }}
                placeholder="Ví dụ: quan-trong, chuong-1..."
                className="rounded-xl h-12"
                autoFocus
              />
            </div>
            <p className="text-xs font-medium text-zinc-500 dark:text-zinc-400">
              Tag sẽ được thêm vào các thẻ chưa có; thẻ nào đã có tag này sẽ được bỏ qua.
            </p>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setBulkDialog(null)}>Hủy</Button>
            <Button onClick={handleBulkTag} disabled={isBulkProcessing || !bulkTagInput.trim()} className="bg-emerald-600 hover:bg-emerald-700 rounded-xl px-6 h-11 font-bold">
              {isBulkProcessing ? <Loader2 className="animate-spin" size={18} /> : 'Gắn tag'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Bulk: Move To Deck Dialog */}
      <Dialog open={bulkDialog === 'move'} onOpenChange={(open) => { if (!open) setBulkDialog(null); }}>
        <DialogContent className="max-w-md rounded-3xl">
          <DialogHeader>
            <DialogTitle>Chuyển {selectedCards.length} thẻ sang bộ thẻ khác</DialogTitle>
          </DialogHeader>
          <div className="space-y-2 py-2 max-h-[50vh] overflow-y-auto">
            {isLoadingDecks ? (
              <div className="flex justify-center py-8">
                <Loader2 className="animate-spin text-emerald-500" size={24} />
              </div>
            ) : otherDecks.length === 0 ? (
              <p className="text-sm font-medium text-zinc-500 dark:text-zinc-400 text-center py-6">
                Bạn chưa có bộ thẻ nào khác để chuyển sang.
              </p>
            ) : (
              otherDecks.map((targetDeck) => (
                <button
                  key={targetDeck.id}
                  disabled={isBulkProcessing}
                  onClick={() => handleBulkMove(targetDeck.id, targetDeck.name)}
                  className="w-full flex items-center justify-between gap-3 rounded-xl border border-zinc-200 dark:border-white/10 px-4 py-3 text-left hover:border-emerald-400 hover:bg-emerald-50 dark:hover:bg-emerald-500/10 transition-colors disabled:opacity-50"
                >
                  <span className="font-bold text-sm text-zinc-800 dark:text-zinc-100 truncate">{targetDeck.name}</span>
                  <span className="text-xs font-bold text-zinc-400 whitespace-nowrap">{targetDeck.cardCount} thẻ</span>
                </button>
              ))
            )}
            <p className="text-xs font-medium text-zinc-500 dark:text-zinc-400 pt-1">
              Thẻ được chuyển nguyên trạng (gồm lịch ôn tập) và giữ nguyên thứ tự trong bộ thẻ đích.
            </p>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setBulkDialog(null)}>Hủy</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit Card Modal */}
      <Dialog open={!!editingCard} onOpenChange={(open) => !open && setEditingCard(null)}>
        <DialogContent className="max-w-2xl rounded-3xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Chỉnh sửa thẻ</DialogTitle>
          </DialogHeader>
          {editingCard && (
            <div className="space-y-6 py-4">
              {/* Preview: same rendering path as the card rows (ReactMarkdown),
                  plus the card's schedule snapshot. */}
              <div className="space-y-2">
                <h4 className="text-xs font-extrabold uppercase tracking-widest text-zinc-400">Xem trước thẻ</h4>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div className="rounded-2xl border border-zinc-100 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800/60 p-4">
                    <span className="text-[10px] font-extrabold text-zinc-400 uppercase tracking-[0.2em]">Mặt trước</span>
                    <div className="mt-2 text-base font-bold text-zinc-900 dark:text-white prose prose-sm prose-zinc dark:prose-invert max-w-none leading-relaxed">
                      <ReactMarkdown>{editingCard.front}</ReactMarkdown>
                    </div>
                  </div>
                  <div className="rounded-2xl border border-zinc-100 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800/60 p-4">
                    <span className="text-[10px] font-extrabold text-zinc-400 uppercase tracking-[0.2em]">Mặt sau</span>
                    <div className="mt-2 text-base font-medium text-zinc-600 dark:text-zinc-300 prose prose-sm prose-zinc dark:prose-invert max-w-none leading-relaxed">
                      <ReactMarkdown>{editingCard.back}</ReactMarkdown>
                    </div>
                  </div>
                </div>
              </div>

              {editingSchedule && (
                <div className="grid grid-cols-2 md:grid-cols-5 gap-3 rounded-2xl border border-zinc-100 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800/60 p-4">
                  <div className="space-y-1">
                    <span className="text-[10px] font-extrabold text-zinc-400 uppercase tracking-widest">Trạng thái</span>
                    <p className="text-sm font-bold text-zinc-800 dark:text-zinc-100">
                      {editingSchedule.suspended
                        ? 'Đã tạm dừng'
                        : isCardBuried(editingCard)
                          ? 'Hoãn hôm nay'
                          : (STATE_LABELS[editingSchedule.state] || editingSchedule.state)}
                    </p>
                  </div>
                  <div className="space-y-1">
                    <span className="text-[10px] font-extrabold text-zinc-400 uppercase tracking-widest">Hạn ôn</span>
                    <p className="text-sm font-bold text-zinc-800 dark:text-zinc-100">
                      {format(new Date(editingSchedule.due), 'dd/MM/yyyy HH:mm')}
                    </p>
                  </div>
                  <div className="space-y-1">
                    <span className="text-[10px] font-extrabold text-zinc-400 uppercase tracking-widest">Độ ổn định</span>
                    <p className="text-sm font-bold text-zinc-800 dark:text-zinc-100">
                      {editingSchedule.stability.toFixed(1)} ngày
                    </p>
                  </div>
                  <div className="space-y-1">
                    <span className="text-[10px] font-extrabold text-zinc-400 uppercase tracking-widest">Số lần quên</span>
                    <p className="text-sm font-bold text-zinc-800 dark:text-zinc-100">{editingSchedule.lapses}</p>
                  </div>
                  <div className="space-y-1">
                    <span className="text-[10px] font-extrabold text-zinc-400 uppercase tracking-widest">Lượt ôn</span>
                    <p className="text-sm font-bold text-zinc-800 dark:text-zinc-100">{editingSchedule.reps}</p>
                  </div>
                </div>
              )}

              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <div className="space-y-2">
                  <label className="text-sm font-bold text-zinc-700">Mặt trước (Câu hỏi)</label>
                  <Textarea 
                    value={editingCard.front} 
                    onChange={(e) => setEditingCard({...editingCard, front: e.target.value})}
                    className="min-h-[120px] rounded-xl"
                  />
                  <Input 
                    placeholder="Link ảnh mặt trước" 
                    value={editingCard.imageUrl || ''} 
                    onChange={(e) => setEditingCard({...editingCard, imageUrl: e.target.value})}
                    className="rounded-xl"
                  />
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-bold text-zinc-700">Mặt sau (Trả lời)</label>
                  <Textarea 
                    value={editingCard.back} 
                    onChange={(e) => setEditingCard({...editingCard, back: e.target.value})}
                    className="min-h-[120px] rounded-xl"
                  />
                  <Input 
                    placeholder="Link ảnh mặt sau" 
                    value={editingCard.backImageUrl || ''} 
                    onChange={(e) => setEditingCard({...editingCard, backImageUrl: e.target.value})}
                    className="rounded-xl"
                  />
                </div>
              </div>

              <div className="p-4 bg-zinc-50 dark:bg-zinc-800 rounded-2xl border border-zinc-100 dark:border-zinc-700 space-y-4">
                <h4 className="text-xs font-extrabold uppercase tracking-widest text-zinc-400">Tùy chỉnh giao diện thẻ</h4>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  <div className="space-y-2">
                    <label className="text-xs font-bold text-zinc-500">Màu nền</label>
                    <div className="flex gap-2 items-center">
                      <Input 
                        type="color" 
                        value={editingCard.customStyles?.backgroundColor || '#ffffff'} 
                        onChange={(e) => setEditingCard({
                          ...editingCard, 
                          customStyles: { ...(editingCard.customStyles || {}), backgroundColor: e.target.value }
                        })}
                        className="w-12 h-10 p-1 rounded-lg"
                      />
                      <Input 
                        type="text" 
                        placeholder="#hex"
                        value={editingCard.customStyles?.backgroundColor || ''} 
                        onChange={(e) => setEditingCard({
                          ...editingCard, 
                          customStyles: { ...(editingCard.customStyles || {}), backgroundColor: e.target.value }
                        })}
                        className="rounded-lg h-10"
                      />
                    </div>
                  </div>
                  <div className="space-y-2">
                    <label className="text-xs font-bold text-zinc-500">Màu chữ</label>
                    <div className="flex gap-2 items-center">
                      <Input 
                        type="color" 
                        value={editingCard.customStyles?.textColor || '#000000'} 
                        onChange={(e) => setEditingCard({
                          ...editingCard, 
                          customStyles: { ...(editingCard.customStyles || {}), textColor: e.target.value }
                        })}
                        className="w-12 h-10 p-1 rounded-lg"
                      />
                      <Input 
                        type="text" 
                        placeholder="#hex"
                        value={editingCard.customStyles?.textColor || ''} 
                        onChange={(e) => setEditingCard({
                          ...editingCard, 
                          customStyles: { ...(editingCard.customStyles || {}), textColor: e.target.value }
                        })}
                        className="rounded-lg h-10"
                      />
                    </div>
                  </div>
                  <div className="space-y-2">
                    <label className="text-xs font-bold text-zinc-500">Kích thước chữ</label>
                    <select 
                      value={editingCard.customStyles?.fontSize || 'text-xl'} 
                      onChange={(e) => setEditingCard({
                        ...editingCard, 
                        customStyles: { ...(editingCard.customStyles || {}), fontSize: e.target.value }
                      })}
                      className="w-full h-10 rounded-lg border border-input bg-background px-3 py-2 text-sm ring-offset-background focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2"
                    >
                      <option value="text-sm">Rất nhỏ</option>
                      <option value="text-base">Nhỏ</option>
                      <option value="text-xl">Vừa</option>
                      <option value="text-3xl">Lớn</option>
                      <option value="text-5xl">Rất lớn</option>
                    </select>
                  </div>
                </div>
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="ghost" onClick={() => setEditingCard(null)}>Hủy</Button>
            <Button onClick={handleUpdateCard} disabled={isSubmitting} className="bg-emerald-600 hover:bg-emerald-700">
              {isSubmitting ? <Loader2 className="animate-spin" size={20} /> : 'Lưu thay đổi'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Add Card Modal */}
      <Dialog open={isAddModalOpen} onOpenChange={setIsAddModalOpen}>
        <DialogContent className="flex max-w-3xl flex-col rounded-3xl">
          <DialogHeader>
            <DialogTitle>Thêm thẻ mới</DialogTitle>
          </DialogHeader>
          
          <div className="min-h-0 space-y-6 overflow-y-auto py-4 pr-1">
            {/* AI Section */}
            <div className="p-4 bg-emerald-50 dark:bg-emerald-500/10 rounded-2xl border border-emerald-100 dark:border-emerald-500/20 space-y-3">
              <div className="flex items-center gap-2 text-emerald-700 dark:text-emerald-300 font-bold">
                <Sparkles size={18} />
                <span>Tạo nhanh bằng AI</span>
              </div>
              <Textarea 
                placeholder="Dán nội dung vào đây để AI tự tạo thẻ..." 
                value={aiText}
                onChange={(e) => setAiText(e.target.value)}
                className="bg-white dark:bg-white/5 rounded-xl min-h-[80px]"
              />
              <Button
                type="button"
                variant="outline"
                onClick={() => aiFileInputRef.current?.click()}
                disabled={isImportingAiFile || isGenerating}
                className="w-full gap-2 border-emerald-200 text-emerald-700 hover:bg-emerald-100/60 dark:border-emerald-500/30 dark:text-emerald-300 dark:hover:bg-emerald-500/10"
              >
                {isImportingAiFile ? <Loader2 className="animate-spin" size={16} /> : <FileText size={16} />}
                Nhập từ file (PDF, DOCX, TXT)
              </Button>
              <input
                type="file"
                ref={aiFileInputRef}
                className="hidden"
                accept="application/pdf,.docx,.txt,.md"
                onChange={handleAiFileUpload}
              />
              <Button 
                onClick={handleGenerateAI} 
                disabled={isGenerating || !aiText.trim()}
                className="w-full bg-emerald-600 hover:bg-emerald-700"
              >
                {isGenerating ? <Loader2 className="animate-spin" size={20} /> : 'Tạo thẻ bằng AI'}
              </Button>
            </div>

            <div className="relative">
              <div className="absolute inset-0 flex items-center"><span className="w-full border-t border-zinc-200" /></div>
              <div className="relative flex justify-center text-xs uppercase"><span className="bg-popover px-2 text-zinc-400 font-bold">Hoặc thêm thủ công</span></div>
            </div>

            <CardTypeFields
              value={{
                cardType: newCard.cardType,
                front: newCard.front,
                back: newCard.back,
                clozeText: newCard.clozeText,
              }}
              onChange={(draft) => setNewCard({ ...newCard, ...draft })}
              frontLabel="Mặt trước"
              backLabel="Mặt sau"
              frontPlaceholder="Câu hỏi..."
              backPlaceholder="Câu trả lời..."
            />

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="space-y-2">
                <label className="text-sm font-bold text-zinc-700">Ảnh mặt trước</label>
                <Input
                  placeholder="Link ảnh mặt trước"
                  value={newCard.frontImage}
                  onChange={(e) => setNewCard({...newCard, frontImage: e.target.value})}
                  className="rounded-xl"
                />
              </div>
              <div className="space-y-2">
                <label className="text-sm font-bold text-zinc-700">Ảnh mặt sau</label>
                <Input
                  placeholder="Link ảnh mặt sau"
                  value={newCard.backImage}
                  onChange={(e) => setNewCard({...newCard, backImage: e.target.value})}
                  className="rounded-xl"
                />
              </div>
            </div>

            <div className="p-4 bg-zinc-50 dark:bg-zinc-800 rounded-2xl border border-zinc-100 dark:border-zinc-700 space-y-4">
              <h4 className="text-xs font-extrabold uppercase tracking-widest text-zinc-400">Tùy chỉnh giao diện thẻ</h4>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div className="space-y-2">
                  <label className="text-xs font-bold text-zinc-500">Màu nền</label>
                  <div className="flex gap-2 items-center">
                    <Input 
                      type="color" 
                      value={newCard.backgroundColor || '#ffffff'} 
                      onChange={(e) => setNewCard({...newCard, backgroundColor: e.target.value})}
                      className="w-12 h-10 p-1 rounded-lg"
                    />
                    <Input 
                      type="text" 
                      placeholder="#hex"
                      value={newCard.backgroundColor} 
                      onChange={(e) => setNewCard({...newCard, backgroundColor: e.target.value})}
                      className="rounded-lg h-10"
                    />
                  </div>
                </div>
                <div className="space-y-2">
                  <label className="text-xs font-bold text-zinc-500">Màu chữ</label>
                  <div className="flex gap-2 items-center">
                    <Input 
                      type="color" 
                      value={newCard.textColor || '#000000'} 
                      onChange={(e) => setNewCard({...newCard, textColor: e.target.value})}
                      className="w-12 h-10 p-1 rounded-lg"
                    />
                    <Input 
                      type="text" 
                      placeholder="#hex"
                      value={newCard.textColor} 
                      onChange={(e) => setNewCard({...newCard, textColor: e.target.value})}
                      className="rounded-lg h-10"
                    />
                  </div>
                </div>
                <div className="space-y-2">
                  <label className="text-xs font-bold text-zinc-500">Kích thước chữ</label>
                  <select 
                    value={newCard.fontSize} 
                    onChange={(e) => setNewCard({...newCard, fontSize: e.target.value})}
                    className="w-full h-10 rounded-lg border border-input bg-background px-3 py-2 text-sm ring-offset-background focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2"
                  >
                    <option value="text-sm">Rất nhỏ</option>
                    <option value="text-base">Nhỏ</option>
                    <option value="text-xl">Vừa</option>
                    <option value="text-3xl">Lớn</option>
                    <option value="text-5xl">Rất lớn</option>
                  </select>
                </div>
              </div>
            </div>
          </div>

          <DialogFooter>
            <Button variant="ghost" onClick={() => setIsAddModalOpen(false)}>Hủy</Button>
            <Button onClick={handleAddCard} disabled={isSubmitting || (newCard.cardType === 'cloze' ? !newCard.clozeText.trim() : !newCard.front || !newCard.back)} className="bg-emerald-600 hover:bg-emerald-700">
              {isSubmitting ? <Loader2 className="animate-spin" size={20} /> : 'Thêm thẻ'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
