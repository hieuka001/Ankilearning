import { useState, useEffect, useRef } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { arrayUnion, doc, getDoc, collection, getDocs, updateDoc, addDoc, increment, setDoc, query, where } from 'firebase/firestore';
import { db } from '../firebase';
import { User } from 'firebase/auth';
import { Deck, Flashcard, UserProfile } from '../types';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '../components/ui/skeleton';
import { 
  X, 
  RotateCcw, 
  CheckCircle2, 
  ChevronRight, 
  ChevronLeft,
  BrainCircuit,
  Trophy,
  Image as ImageIcon,
  Archive,
  Ban
} from 'lucide-react';
import {
  calculateSchedulerReview,
  formatScheduledDelay,
  buildStudyQueues,
  getLocalTomorrowIso,
  getRatingPreviews,
  isCardBuried,
  normalizeCardSchedule,
  sortCardsForStudy,
  type SchedulerConfigInput,
  type SchedulerRating,
} from '../lib/spacedRepetition';
import { toast } from 'sonner';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { playSound } from '../lib/sounds';
import { useSettings } from '../contexts/SettingsContext';
import { motion, AnimatePresence } from 'motion/react';
import SpeechButton from '../components/SpeechButton';
import { XP_PER_CARD } from '../lib/gamification';

interface StudyProps {
  user: User | null;
  profile?: UserProfile | null;
}

const progressDocId = (deckId: string, cardId: string) =>
  `${deckId}__${cardId}`.replace(/\//g, '_');

const localProgressKey = (userId: string, deckId: string) =>
  `fsrs_progress_${userId}_${deckId}`;

const readLocalProgress = (userId: string, deckId: string) => {
  try {
    const raw = localStorage.getItem(localProgressKey(userId, deckId));
    return raw ? JSON.parse(raw) as Record<string, Partial<Flashcard>> : {};
  } catch {
    return {};
  }
};

const writeLocalProgress = (
  userId: string,
  deckId: string,
  cardId: string,
  progress: Partial<Flashcard>,
) => {
  try {
    const current = readLocalProgress(userId, deckId);
    localStorage.setItem(localProgressKey(userId, deckId), JSON.stringify({
      ...current,
      [cardId]: {
        ...(current[cardId] || {}),
        ...progress,
      },
    }));
  } catch {
    // The study flow should keep moving even if browser storage is unavailable.
  }
};

export default function Study({ user, profile }: StudyProps) {
  const { settings } = useSettings();
  const { deckId } = useParams();
  const navigate = useNavigate();
  const [deck, setDeck] = useState<Deck | null>(null);
  const [cards, setCards] = useState<Flashcard[]>([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [isFlipped, setIsFlipped] = useState(false);
  const [loading, setLoading] = useState(true);
  const [isFinished, setIsFinished] = useState(false);
  const [sessionStats, setSessionStats] = useState({ reviewed: 0, correct: 0 });
  const [startTime, setStartTime] = useState(Date.now());
  const [imageLoaded, setImageLoaded] = useState(false);
  const [fontSize, setFontSize] = useState('text-3xl md:text-5xl');
  const [now, setNow] = useState(() => new Date());
  const [cloudScheduler, setCloudScheduler] = useState<SchedulerConfigInput | null>(null);
  const prefetchedImages = useRef<Set<string>>(new Set());
  const ratingLockRef = useRef(false);
  const schedulerConfig = cloudScheduler || profile?.settings?.scheduler || settings.scheduler;

  const resetStudy = () => {
    setCurrentIndex(0);
    setIsFlipped(false);
    setLoading(false);
    setIsFinished(false);
    setSessionStats({ reviewed: 0, correct: 0 });
    setStartTime(Date.now());
  };

  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 15000);
    return () => window.clearInterval(timer);
  }, []);

  // Prefetch images for the next card
  useEffect(() => {
    if (cards.length > 0 && currentIndex < cards.length - 1) {
      const nextCard = cards[currentIndex + 1];
      const imagesToPrefetch = [nextCard.imageUrl, nextCard.backImageUrl].filter(Boolean) as string[];
      
      imagesToPrefetch.forEach(url => {
        if (!prefetchedImages.current.has(url)) {
          const img = new Image();
          img.src = url;
          prefetchedImages.current.add(url);
        }
      });
    }
    setImageLoaded(false);
  }, [currentIndex, cards]);

  useEffect(() => {
    const fetchData = async () => {
      if (!deckId || !user) return;
      
      try {
        const deckSnap = await getDoc(doc(db, 'decks', deckId));
        if (deckSnap.exists()) {
          const deckData = { id: deckSnap.id, ...deckSnap.data() } as Deck;
          setDeck(deckData);
          
          const cardsSnap = await getDocs(collection(db, `decks/${deckId}/cards`));
          const rawCards = cardsSnap.docs.map(doc => ({ id: doc.id, ...doc.data() } as Flashcard));
          const progressByCardId = new Map<string, Partial<Flashcard>>();
          try {
            const progressSnap = await getDocs(query(
              collection(db, `users/${user.uid}/cardProgress`),
              where('deckId', '==', deckId),
            ));
            progressSnap.docs.forEach((progressDoc) => {
              const progressData = progressDoc.data() as Partial<Flashcard> & { cardId?: string };
              if (progressData.cardId) {
                progressByCardId.set(progressData.cardId, progressData);
              }
            });
          } catch (progressError) {
            console.warn('Unable to load cloud study progress.', progressError);
          }

          const localProgress = readLocalProgress(user.uid, deckId);
          const allCards = rawCards.map((card) => ({
            ...card,
            ...(progressByCardId.get(card.id) || {}),
            ...(localProgress[card.id] || {}),
            id: card.id,
            deckId: card.deckId || deckData.id,
            ownerId: card.ownerId || deckData.ownerId,
          } as Flashcard));
          const userSnap = await getDoc(doc(db, 'users', user.uid));
          let remoteScheduler: SchedulerConfigInput | null = null;
          if (userSnap.exists()) {
            const userData = userSnap.data() as UserProfile;
            remoteScheduler = userData.settings?.scheduler || null;
            setCloudScheduler(remoteScheduler);
          }
          const activeScheduler = remoteScheduler || profile?.settings?.scheduler || settings.scheduler;
          
          const currentTime = new Date();
          const studyableCards = allCards.filter((card) => {
            const schedule = normalizeCardSchedule(card, currentTime);
            return !schedule.suspended && !isCardBuried(card, currentTime);
          });
          const dueCards = buildStudyQueues(studyableCards, activeScheduler, currentTime).all;
          
          // If no due cards, ask if they want to study all
          if (dueCards.length === 0 && allCards.length > 0) {
            if (window.confirm("Bạn đã hoàn thành các thẻ cần ôn tập hôm nay. Bạn có muốn ôn lại tất cả không?")) {
              setCards(sortCardsForStudy(studyableCards, activeScheduler, currentTime));
            } else {
              navigate(`/decks/${deckId}`);
            }
          } else {
            setCards(dueCards);
          }
        }
      } catch (error) {
        console.error(error);
      } finally {
        setLoading(false);
      }
    };

    fetchData();
  }, [deckId, navigate, profile?.settings?.scheduler, settings.scheduler, user]);

  const advanceCard = (finalStats = sessionStats) => {
    if (currentIndex < cards.length - 1) {
      setIsFlipped(false);
      setCurrentIndex(currentIndex + 1);
    } else {
      finishSession(finalStats);
    }
  };

  const handleRate = async (rating: SchedulerRating) => {
    if (ratingLockRef.current) return;
    ratingLockRef.current = true;

    const card = cards[currentIndex];
    const reviewTime = new Date();
    const previousSchedule = normalizeCardSchedule(card, reviewTime);
    const result = calculateSchedulerReview(card, rating, schedulerConfig, reviewTime);
    const isCorrect = rating !== 'again';
    const nextStats = {
      reviewed: sessionStats.reviewed + 1,
      correct: sessionStats.correct + (isCorrect ? 1 : 0),
    };
    
    if (isCorrect) {
      playSound('correct', settings.volume);
    } else {
      playSound('wrong', settings.volume);
    }

    try {
      if (!user || !deckId) return;
      const cardRef = doc(db, `decks/${deckId}/cards`, card.id);
      const reviewRef = doc(collection(db, `decks/${deckId}/cards/${card.id}/reviews`));
      const historyEntry = {
        ...result.reviewLog,
        id: reviewRef.id,
        cardId: card.id,
        reviewTime: reviewTime.toISOString(),
        previousState: previousSchedule.state,
        newState: result.state,
      };
      const schedulerUpdate = {
        state: result.state,
        due: result.due,
        interval: result.interval,
        easeFactor: result.easeFactor,
        stability: result.stability,
        difficulty: result.difficulty,
        retrievability: result.retrievability,
        elapsedDays: result.elapsedDays,
        scheduledDays: result.scheduledDays,
        stepIndex: result.stepIndex,
        dueDate: result.dueDate,
        nextReview: result.nextReview,
        lapses: result.lapses,
        reps: result.reps,
        repetitions: result.repetitions,
        lastReview: historyEntry,
        updatedAt: reviewTime.toISOString(),
      };
      const cloudProgressPayload = {
        ...schedulerUpdate,
        userId: user.uid,
        deckId,
        cardId: card.id,
        sourceDeckOwnerId: deck?.ownerId || card.ownerId || '',
        reviewHistory: arrayUnion(historyEntry),
      };
      const localProgressPayload = {
        ...schedulerUpdate,
        reviewHistory: [
          ...((Array.isArray(card.reviewHistory) ? card.reviewHistory : []) as any[]),
          historyEntry,
        ],
      } as Partial<Flashcard>;
      const savePersonalProgress = async () => {
        await setDoc(
          doc(db, `users/${user.uid}/cardProgress`, progressDocId(deckId, card.id)),
          cloudProgressPayload,
          { merge: true },
        );
      };

      try {
        if (deck?.ownerId === user.uid || card.ownerId === user.uid) {
          await updateDoc(cardRef, {
            ...schedulerUpdate,
            reviewHistory: arrayUnion(historyEntry),
          });
          setDoc(reviewRef, historyEntry).catch((reviewError) => {
            console.warn('Review log subcollection was not saved.', reviewError);
          });
        } else {
          await savePersonalProgress();
        }
      } catch (progressError) {
        console.warn('Cloud progress save failed, falling back to personal progress.', progressError);
        try {
          await savePersonalProgress();
        } catch (personalProgressError) {
          console.warn('Personal cloud progress save failed, falling back to local progress.', personalProgressError);
          writeLocalProgress(user.uid, deckId, card.id, localProgressPayload);
          toast.warning('Đã lưu tạm tiến độ trên thiết bị này.');
        }
      }

      // Update user stats
      if (isCorrect) {
        await updateDoc(doc(db, 'users', user.uid), {
          totalCardsLearned: increment(1),
          xp: increment(XP_PER_CARD),
        });
      }
      setSessionStats(nextStats);

      advanceCard(nextStats);
    } catch (error) {
      console.error(error);
      toast.error("Lỗi khi cập nhật tiến độ.");
    } finally {
      ratingLockRef.current = false;
    }
  };

  const handleBuryCurrentCard = async () => {
    const card = cards[currentIndex];
    if (!deckId || !card) return;

    await updateDoc(doc(db, `decks/${deckId}/cards`, card.id), {
      buriedUntil: getLocalTomorrowIso(),
    });
    toast.success('Đã bury thẻ đến ngày mai.');
    advanceCard();
  };

  const handleSuspendCurrentCard = async () => {
    const card = cards[currentIndex];
    if (!deckId || !card) return;

    await updateDoc(doc(db, `decks/${deckId}/cards`, card.id), {
      suspended: true,
      buriedUntil: '',
    });
    toast.success('Đã suspend thẻ.');
    advanceCard();
  };

  const finishSession = async (finalStats = sessionStats) => {
    setIsFinished(true);
    const duration = Math.round((Date.now() - startTime) / 1000);
    
    try {
      if (!user) return;
      
      // Update streak logic
      const userRef = doc(db, 'users', user.uid);
      const userSnap = await getDoc(userRef);
      
      if (userSnap.exists()) {
        const userData = userSnap.data() as UserProfile;
        const lastStudyStr = userData.lastStudyDate;
        const today = new Date();
        const currentDate = new Date(today.getFullYear(), today.getMonth(), today.getDate());
        
        let newStreak = userData.streak || 0;
        let shouldUpdateStreak = false;

        const lastStudyDate = lastStudyStr ? new Date(lastStudyStr) : null;
        const lastDate = lastStudyDate ? new Date(lastStudyDate.getFullYear(), lastStudyDate.getMonth(), lastStudyDate.getDate()) : null;
        
        if (!lastDate) {
          newStreak = 1;
          shouldUpdateStreak = true;
        } else {
          const diffTime = currentDate.getTime() - lastDate.getTime();
          const diffDays = Math.round(diffTime / (1000 * 60 * 60 * 24)); // Use round for safer integer comparison

          if (diffDays === 1) {
            newStreak += 1;
            shouldUpdateStreak = true;
          } else if (diffDays > 1) {
            newStreak = 1;
            shouldUpdateStreak = true;
          } else if (diffDays === 0 && newStreak === 0) {
            newStreak = 1;
            shouldUpdateStreak = true;
          }
        }

        const updateData: any = {
          lastStudyDate: today.toISOString()
        };
        if (shouldUpdateStreak) {
          updateData.streak = newStreak;
        }
        
        await updateDoc(userRef, updateData);
      }

      await addDoc(collection(db, `users/${user.uid}/sessions`), {
        userId: user.uid,
        deckId,
        cardsReviewed: finalStats.reviewed,
        correctCount: finalStats.correct,
        duration,
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      console.error("Error finishing session:", error);
    }
  };

  if (loading) return (
    <div className="flex flex-col items-center justify-center min-h-[60vh] space-y-4">
      <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-indigo-600"></div>
      <p className="text-slate-500 font-medium">Đang chuẩn bị bài học...</p>
    </div>
  );
  
  if (cards.length === 0) return (
    <div className="flex flex-col items-center justify-center min-h-[60vh] space-y-6 text-center">
      <div className="bg-slate-100 p-6 rounded-full">
        <BrainCircuit className="w-12 h-12 text-slate-400" />
      </div>
      <h2 className="text-2xl font-bold text-slate-900">Không có thẻ nào để học</h2>
      <p className="text-slate-500 max-w-xs">Bộ thẻ này hiện đang trống hoặc bạn đã hoàn thành tất cả các thẻ cần ôn tập.</p>
      <Link to="/decks">
        <Button variant="outline">Quay lại danh sách</Button>
      </Link>
    </div>
  );

  if (isFinished) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[70vh] space-y-8 animate-in zoom-in-95 duration-500">
        <div className="bg-white dark:bg-slate-900 p-10 rounded-[2.5rem] shadow-2xl text-center max-w-md w-full space-y-8 border border-slate-100 dark:border-slate-800">
          <div className="flex justify-center">
            <motion.div 
              initial={{ scale: 0 }}
              animate={{ scale: 1 }}
              transition={{ type: "spring", stiffness: 260, damping: 20 }}
              className="bg-yellow-100 dark:bg-yellow-900/30 p-6 rounded-full"
            >
              <Trophy className="h-16 w-16 text-yellow-600 dark:text-yellow-500" />
            </motion.div>
          </div>
          <div className="space-y-2">
            <h1 className="text-4xl font-bold text-slate-900 dark:text-white">Hoàn thành!</h1>
            <p className="text-slate-500 dark:text-slate-400 font-medium">Bạn đã làm rất tốt hôm nay.</p>
          </div>
          
          <div className="grid grid-cols-2 gap-4">
            <div className="bg-indigo-50 dark:bg-indigo-900/20 p-5 rounded-3xl border border-indigo-100 dark:border-indigo-900/30">
              <p className="text-3xl font-bold text-indigo-600 dark:text-indigo-400">{sessionStats.reviewed}</p>
              <p className="text-[10px] text-indigo-400 uppercase font-bold tracking-widest">Đã học</p>
            </div>
            <div className="bg-emerald-50 dark:bg-emerald-900/20 p-5 rounded-3xl border border-emerald-100 dark:border-emerald-900/30">
              <p className="text-3xl font-bold text-emerald-600 dark:text-emerald-400">
                {sessionStats.reviewed > 0 ? Math.round((sessionStats.correct / sessionStats.reviewed) * 100) : 0}%
              </p>
              <p className="text-[10px] text-emerald-400 uppercase font-bold tracking-widest">Chính xác</p>
            </div>
          </div>

          <div className="space-y-3 pt-4">
            <Link to="/decks">
              <Button className="w-full bg-indigo-600 hover:bg-indigo-700 h-14 rounded-2xl text-lg font-bold shadow-lg shadow-indigo-200 dark:shadow-none">
                Quay lại bộ thẻ
              </Button>
            </Link>
            <Button variant="ghost" onClick={resetStudy} className="w-full text-slate-500 h-12 font-bold hover:bg-slate-100 dark:hover:bg-white/5 rounded-2xl">
              Học lại lần nữa
            </Button>
          </div>
        </div>
      </div>
    );
  }

  const currentCard = cards[currentIndex];
  const progress = ((currentIndex) / cards.length) * 100;
  const currentSchedule = normalizeCardSchedule(currentCard, now);
  const ratingPreviews = getRatingPreviews(currentCard, schedulerConfig, now);

  const renderContent = (content: string, isFlipped: boolean) => {
    if (currentCard.type === 'cloze') {
      if (!isFlipped) {
        // Mask the cloze deletions: {{c1::text}} -> [...]
        return content.replace(/\{\{c\d+::(.*?)\}\}/g, '[...]');
      } else {
        // Highlight the cloze deletions: {{c1::text}} -> **text**
        return content.replace(/\{\{c\d+::(.*?)\}\}/g, '==$1==');
      }
    }
    return content;
  };

  return (
    <div className="max-w-4xl mx-auto space-y-10 pb-40 pt-6 font-sans">
      <header className="flex items-center justify-between gap-8 border-b border-slate-200 dark:border-white/5 pb-8">
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2 bg-slate-100 dark:bg-white/5 p-1 rounded-xl">
            <Button 
              variant="ghost" 
              size="sm" 
              onClick={(e) => { e.stopPropagation(); setFontSize('text-lg md:text-xl'); }}
              className={`h-8 px-3 rounded-lg text-xs font-bold ${fontSize === 'text-lg md:text-xl' ? 'bg-white dark:bg-white/10 shadow-sm' : 'text-slate-400'}`}
            >
              A
            </Button>
            <Button 
              variant="ghost" 
              size="sm" 
              onClick={(e) => { e.stopPropagation(); setFontSize('text-3xl md:text-5xl'); }}
              className={`h-8 px-3 rounded-lg text-base font-bold ${fontSize === 'text-3xl md:text-5xl' ? 'bg-white dark:bg-white/10 shadow-sm' : 'text-slate-400'}`}
            >
              A
            </Button>
            <Button 
              variant="ghost" 
              size="sm" 
              onClick={(e) => { e.stopPropagation(); setFontSize('text-6xl md:text-8xl'); }}
              className={`h-8 px-3 rounded-lg text-xl font-bold ${fontSize === 'text-6xl md:text-8xl' ? 'bg-white dark:bg-white/10 shadow-sm' : 'text-slate-400'}`}
            >
              A
            </Button>
          </div>
          <Button variant="ghost" size="icon" onClick={() => navigate(`/decks/${deckId}`)} className="rounded-2xl hover:bg-slate-100 dark:hover:bg-white/5 h-12 w-12">
            <X size={24} className="text-slate-400" />
          </Button>
          <Button variant="ghost" size="sm" onClick={handleBuryCurrentCard} className="h-10 gap-2 rounded-xl px-3 text-xs font-bold text-slate-500 hover:bg-slate-100 dark:hover:bg-white/5">
            <Archive size={15} />
            Bury
          </Button>
          <Button variant="ghost" size="sm" onClick={handleSuspendCurrentCard} className="h-10 gap-2 rounded-xl px-3 text-xs font-bold text-slate-500 hover:bg-slate-100 dark:hover:bg-white/5">
            <Ban size={15} />
            Suspend
          </Button>
        </div>
        <div className="flex-1 space-y-3">
          <div className="flex justify-between items-end">
            <span className="text-[10px] font-black text-primary uppercase tracking-[0.2em]">Tiến độ học tập</span>
            <span className="text-xs font-black text-slate-400 font-mono">{currentIndex + 1} / {cards.length}</span>
          </div>
          <div className="h-2.5 bg-slate-100 dark:bg-white/5 rounded-full overflow-hidden">
            <motion.div 
              initial={{ width: 0 }}
              animate={{ width: `${progress}%` }}
              className="h-full bg-primary transition-all duration-500" 
            />
          </div>
        </div>
      </header>

      <div className="relative perspective-2000">
        <AnimatePresence mode="wait">
          <motion.div
            key={currentIndex + (isFlipped ? '-back' : '-front')}
            initial={{ rotateY: isFlipped ? -180 : 180, opacity: 0, scale: 0.95 }}
            animate={{ rotateY: 0, opacity: 1, scale: 1 }}
            exit={{ rotateY: isFlipped ? 180 : -180, opacity: 0, scale: 0.95 }}
            transition={{ type: "spring", damping: 25, stiffness: 120 }}
            className="w-full"
          >
            <Card 
              className={`w-full min-h-[500px] flex flex-col items-center justify-center p-10 md:p-20 text-center cursor-pointer border border-slate-200 dark:border-white/5 shadow-2xl rounded-[3rem] transition-all duration-700 relative overflow-hidden ${
                isFlipped 
                  ? 'bg-primary text-white' 
                  : 'bg-white dark:bg-[#0C0D0E] text-slate-900 dark:text-white'
              }`}
              style={{
                backgroundColor: isFlipped ? undefined : currentCard.customStyles?.backgroundColor,
                color: isFlipped ? undefined : currentCard.customStyles?.textColor,
              }}
              onClick={() => {
                setIsFlipped(!isFlipped);
                playSound('flip', settings.volume);
              }}
            >
              <div className="absolute top-6 right-6 md:top-10 md:right-10 z-20">
                <SpeechButton 
                  text={isFlipped ? currentCard.back : currentCard.front} 
                  className={isFlipped ? "bg-white/10 hover:bg-white/20 text-white" : "bg-primary/5 hover:bg-primary/10 text-primary"}
                />
              </div>

              {/* Decorative elements */}
              <div className="absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-transparent via-white/20 to-transparent" />
              <div className="absolute -bottom-32 -right-32 w-64 h-64 bg-primary/20 rounded-full blur-[100px]" />
              <div className="absolute -top-32 -left-32 w-64 h-64 bg-primary/10 rounded-full blur-[100px]" />

              <CardContent className="p-0 flex flex-col items-center gap-10 w-full z-10">
                <div className={`px-5 py-2 rounded-full text-[10px] font-black uppercase tracking-[0.3em] ${
                  isFlipped ? 'bg-white/20 text-white' : 'bg-primary/10 text-primary'
                }`}>
                  {isFlipped ? 'Mặt sau (Trả lời)' : 'Mặt trước (Câu hỏi)'}
                </div>
                <div className={`flex flex-wrap items-center justify-center gap-2 text-[10px] font-bold uppercase ${
                  isFlipped ? 'text-white/70' : 'text-slate-400 dark:text-slate-500'
                }`}>
                  <span>State: {currentSchedule.state}</span>
                  <span>Interval: {currentSchedule.scheduledDays || 0} ngày</span>
                  <span>S: {currentSchedule.stability.toFixed(1)}</span>
                  <span>D: {currentSchedule.difficulty.toFixed(1)}</span>
                  <span>R: {Math.round(currentSchedule.retrievability * 100)}%</span>
                </div>
                
                {currentCard.imageUrl && !isFlipped && (
                  <motion.div 
                    initial={{ y: 20, opacity: 0 }}
                    animate={{ y: 0, opacity: 1 }}
                    className="relative max-w-full h-64 rounded-[2.5rem] overflow-hidden shadow-2xl border-4 border-white dark:border-white/10 bg-slate-100 dark:bg-white/5"
                  >
                    {!imageLoaded && (
                      <div className="absolute inset-0 flex items-center justify-center">
                        <Skeleton className="w-full h-full rounded-none" />
                        <ImageIcon className="absolute text-slate-300 animate-pulse" size={40} />
                      </div>
                    )}
                    <img 
                      src={currentCard.imageUrl} 
                      alt="Card" 
                      className={`w-full h-full object-cover transition-opacity duration-500 ${imageLoaded ? 'opacity-100' : 'opacity-0'}`}
                      referrerPolicy="no-referrer"
                      onLoad={() => setImageLoaded(true)}
                    />
                  </motion.div>
                )}

                {currentCard.backImageUrl && isFlipped && (
                  <motion.div 
                    initial={{ y: 20, opacity: 0 }}
                    animate={{ y: 0, opacity: 1 }}
                    className="relative max-w-full h-64 rounded-[2.5rem] overflow-hidden shadow-2xl border-4 border-white/10 bg-white/10"
                  >
                    {!imageLoaded && (
                      <div className="absolute inset-0 flex items-center justify-center">
                        <Skeleton className="w-full h-full rounded-none" />
                        <ImageIcon className="absolute text-white/20 animate-pulse" size={40} />
                      </div>
                    )}
                    <img 
                      src={currentCard.backImageUrl} 
                      alt="Card Back" 
                      className={`w-full h-full object-cover transition-opacity duration-500 ${imageLoaded ? 'opacity-100' : 'opacity-0'}`}
                      referrerPolicy="no-referrer"
                      onLoad={() => setImageLoaded(true)}
                    />
                  </motion.div>
                )}

                  <div className="w-full">
                    <div className={`prose prose-2xl max-w-none mx-auto ${isFlipped ? 'prose-invert' : 'dark:prose-invert'}`}>
                      <div className={`font-bold leading-tight tracking-normal ${fontSize}`} style={{ fontSize: !isFlipped && currentCard.customStyles?.fontSize ? 'inherit' : undefined }}>
                        <ReactMarkdown remarkPlugins={[remarkGfm]}>
                          {renderContent(isFlipped ? currentCard.back : currentCard.front, isFlipped)}
                        </ReactMarkdown>
                      </div>
                    </div>
                  </div>

                {!isFlipped && (
                  <motion.div 
                    animate={{ y: [0, 8, 0] }}
                    transition={{ repeat: Infinity, duration: 2.5 }}
                    className="mt-6 flex flex-col items-center gap-3"
                  >
                    <div className="p-4 bg-primary/10 dark:bg-white/5 rounded-2xl text-primary">
                      <RotateCcw size={24} />
                    </div>
                    <p className="text-[10px] font-black text-slate-400 uppercase tracking-[0.3em]">Chạm để lật thẻ</p>
                  </motion.div>
                )}
              </CardContent>
            </Card>
          </motion.div>
        </AnimatePresence>
      </div>

      {/* Control Bar */}
      <div className="fixed bottom-10 left-1/2 -translate-x-1/2 w-full max-w-3xl px-6 z-50">
        <div className="bg-white/90 dark:bg-[#0C0D0E]/90 backdrop-blur-2xl p-5 rounded-[3rem] shadow-2xl border border-slate-200 dark:border-white/5 flex flex-col gap-5">
          <AnimatePresence mode="wait">
            {isFlipped ? (
              <motion.div 
                key="rating-buttons"
                initial={{ y: 30, opacity: 0 }}
                animate={{ y: 0, opacity: 1 }}
                exit={{ y: 20, opacity: 0 }}
                className={`grid gap-4 ${
                  ratingPreviews.length === 2 ? 'grid-cols-2' : ratingPreviews.length === 3 ? 'grid-cols-3' : 'grid-cols-4'
                }`}
              >
                {ratingPreviews.map(({ rating, result }) => (
                  <RatingButton
                    key={rating}
                    rating={rating}
                    preview={formatScheduledDelay(result.scheduledDelay)}
                    onClick={() => handleRate(rating)}
                  />
                ))}
              </motion.div>
            ) : (
              <motion.div 
                key="navigation-buttons"
                initial={{ y: -20, opacity: 0 }}
                animate={{ y: 0, opacity: 1 }}
                exit={{ y: -20, opacity: 0 }}
                className="flex items-center justify-between gap-5"
              >
                <Button 
                  variant="ghost" 
                  disabled={currentIndex === 0}
                  onClick={() => { setCurrentIndex(currentIndex - 1); setIsFlipped(false); }}
                  className="flex-1 h-16 rounded-2xl text-slate-500 hover:bg-slate-100 dark:hover:bg-white/5 gap-2 font-black uppercase tracking-widest text-[10px]"
                >
                  <ChevronLeft size={20} /> Trước
                </Button>
                
                <Button 
                  onClick={() => {
                    setIsFlipped(true);
                    playSound('flip', settings.volume);
                  }}
                  className="flex-[2] h-16 bg-primary hover:bg-primary/90 text-white rounded-2xl font-black text-xl shadow-2xl shadow-primary/30 gap-3 tracking-tighter"
                >
                  LẬT THẺ
                </Button>
                
                <Button 
                  variant="ghost"
                  disabled={currentIndex === cards.length - 1}
                  onClick={() => { setCurrentIndex(currentIndex + 1); setIsFlipped(false); }}
                  className="flex-1 h-16 rounded-2xl text-slate-500 hover:bg-slate-100 dark:hover:bg-white/5 gap-2 font-black uppercase tracking-widest text-[10px]"
                >
                  Tiếp <ChevronRight size={20} />
                </Button>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>
    </div>
  );
}

const ratingMeta: Record<SchedulerRating, { label: string; color: string }> = {
  again: { label: 'Quên', color: 'bg-rose-500' },
  hard: { label: 'Khó', color: 'bg-amber-500' },
  good: { label: 'Tốt', color: 'bg-primary' },
  easy: { label: 'Dễ', color: 'bg-emerald-500' },
};

function RatingButton({
  rating,
  preview,
  onClick,
}: {
  rating: SchedulerRating;
  preview: string;
  onClick: () => void;
}) {
  const meta = ratingMeta[rating];

  return (
    <Button 
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      className={`${meta.color} hover:brightness-110 text-white h-20 rounded-[1.5rem] flex flex-col gap-1 shadow-lg transition-transform active:scale-95 border-b-4 border-black/20`}
    >
      <span className="text-base font-black">{meta.label}</span>
      <span className="text-[9px] opacity-80 uppercase font-black tracking-tighter">{preview}</span>
    </Button>
  );
}
