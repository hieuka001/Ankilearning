import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { User } from 'firebase/auth';
import { addDoc, collection, doc, getDoc, getDocs, query, setDoc, updateDoc, where } from 'firebase/firestore';
import { motion } from 'motion/react';
import { BrainCircuit, Trophy } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { db } from '../firebase';
import { Deck, Flashcard, UserProfile } from '../types';
import {
  buildStudyQueues,
  getLocalTomorrowIso,
  isCardBuried,
  normalizeCardSchedule,
  sortCardsForStudy,
  type SchedulerConfigInput,
  type SchedulerRating,
} from '../lib/spacedRepetition';
import { playSound } from '../lib/sounds';
import { useSettings } from '../contexts/SettingsContext';
import { toast } from 'sonner';
import { ReviewCard } from '../review/ReviewCard';
import { enqueueReviewSync, flushReviewQueue, progressDocId } from '../review/firebaseSync';
import { cacheCards, getCachedCards, upsertCachedCard } from '../review/localDB';
import { useScheduler } from '../review/useScheduler';

interface StudyProps {
  user: User | null;
  profile?: UserProfile | null;
}

const stripHtml = (value: string) => value.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();

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
  const [now, setNow] = useState(() => new Date());
  const [cloudScheduler, setCloudScheduler] = useState<SchedulerConfigInput | null>(null);
  const prefetchedImages = useRef<Set<string>>(new Set());
  const ratingLockRef = useRef(false);
  const schedulerConfig = cloudScheduler || profile?.settings?.scheduler || settings.scheduler;
  const { previewRatings, reviewCard } = useScheduler(schedulerConfig);
  const currentCard = cards[currentIndex];
  const ratingPreviews = useMemo(
    () => currentCard ? previewRatings(currentCard, now) : [],
    [currentCard, now, previewRatings],
  );

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

  useEffect(() => {
    return () => {
      flushReviewQueue().catch((error) => console.warn('Final review sync failed.', error));
    };
  }, []);

  useEffect(() => {
    if (cards.length > 0 && currentIndex < cards.length - 1) {
      const nextCard = cards[currentIndex + 1];
      const imagesToPrefetch = [nextCard.imageUrl, nextCard.backImageUrl].filter(Boolean) as string[];
      imagesToPrefetch.forEach((url) => {
        if (!prefetchedImages.current.has(url)) {
          const img = new Image();
          img.src = url;
          prefetchedImages.current.add(url);
        }
      });
    }
  }, [currentIndex, cards]);

  useEffect(() => {
    const fetchData = async () => {
      if (!deckId || !user) return;

      setLoading(true);
      try {
        const deckSnap = await getDoc(doc(db, 'decks', deckId));
        if (!deckSnap.exists()) {
          navigate('/decks');
          return;
        }

        const deckData = { id: deckSnap.id, ...deckSnap.data() } as Deck;
        setDeck(deckData);

        const cardsSnap = await getDocs(collection(db, `decks/${deckId}/cards`));
        const rawCards = cardsSnap.docs.map((cardDoc) => ({ id: cardDoc.id, ...cardDoc.data() } as Flashcard));
        const progressByCardId = new Map<string, Partial<Flashcard>>();

        try {
          const progressSnap = await getDocs(query(
            collection(db, `users/${user.uid}/cardProgress`),
            where('deckId', '==', deckId),
          ));
          progressSnap.docs.forEach((progressDoc) => {
            const progressData = progressDoc.data() as Partial<Flashcard> & { cardId?: string };
            if (progressData.cardId) progressByCardId.set(progressData.cardId, progressData);
          });
        } catch (progressError) {
          console.warn('Unable to load cloud study progress.', progressError);
        }

        const allCards = rawCards.map((card) => ({
          ...card,
          ...(progressByCardId.get(card.id) || {}),
          id: card.id,
          deckId: card.deckId || deckData.id,
          ownerId: card.ownerId || deckData.ownerId,
        } as Flashcard));
        await cacheCards(user.uid, deckId, allCards).catch(() => undefined);

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

        if (dueCards.length === 0 && allCards.length > 0) {
          if (window.confirm('Bạn đã hoàn thành các thẻ cần ôn tập hôm nay. Bạn có muốn ôn lại tất cả không?')) {
            setCards(sortCardsForStudy(studyableCards, activeScheduler, currentTime));
          } else {
            navigate(`/decks/${deckId}`);
          }
        } else {
          setCards(dueCards);
        }
      } catch (error) {
        console.error(error);
        const cached = user && deckId ? await getCachedCards(user.uid, deckId).catch(() => []) : [];
        if (cached.length > 0) {
          setCards(cached as Flashcard[]);
          toast.warning('Đang dùng dữ liệu đã lưu trên thiết bị.');
        }
      } finally {
        setLoading(false);
      }
    };

    fetchData();
  }, [deckId, navigate, profile?.settings?.scheduler, settings.scheduler, user]);

  const advanceCard = useCallback((finalStats = sessionStats) => {
    if (currentIndex < cards.length - 1) {
      setIsFlipped(false);
      setCurrentIndex((index) => index + 1);
    } else {
      finishSession(finalStats);
    }
  }, [cards.length, currentIndex, sessionStats]);

  const handleRate = useCallback((rating: SchedulerRating) => {
    if (ratingLockRef.current || !currentCard || !user || !deckId) return;
    ratingLockRef.current = true;

    const reviewTime = new Date();
    const { schedulerUpdate, historyEntry } = reviewCard(currentCard, rating, reviewTime);
    const isCorrect = rating !== 'again';
    const nextStats = {
      reviewed: sessionStats.reviewed + 1,
      correct: sessionStats.correct + (isCorrect ? 1 : 0),
    };
    const updatedCard = {
      ...currentCard,
      ...schedulerUpdate,
      reviewHistory: [
        ...(Array.isArray(currentCard.reviewHistory) ? currentCard.reviewHistory : []),
        historyEntry,
      ],
    } as Flashcard;

    setCards((existingCards) => existingCards.map((card) => card.id === currentCard.id ? updatedCard : card));
    setSessionStats(nextStats);
    setIsFlipped(false);
    playSound(isCorrect ? 'correct' : 'wrong', settings.volume);

    enqueueReviewSync({
      userId: user.uid,
      deckId,
      card: currentCard,
      schedulerUpdate,
      historyEntry,
      sourceDeckOwnerId: deck?.ownerId || currentCard.ownerId || '',
      isOwnerReview: deck?.ownerId === user.uid || currentCard.ownerId === user.uid,
      isCorrect,
    }).catch((error) => {
      console.warn('Local review queue failed.', error);
      toast.warning('Chưa thể lưu tiến độ vào cache cục bộ.');
    });

    advanceCard(nextStats);
    window.setTimeout(() => {
      ratingLockRef.current = false;
    }, 180);
  }, [advanceCard, currentCard, deck?.ownerId, deckId, reviewCard, sessionStats, settings.volume, user]);

  const saveControlUpdate = useCallback(async (card: Flashcard, update: Partial<Flashcard>) => {
    if (!deckId || !user) return;
    const updatedCard = { ...card, ...update } as Flashcard;
    setCards((existingCards) => existingCards.map((item) => item.id === card.id ? updatedCard : item));
    await upsertCachedCard(user.uid, deckId, updatedCard).catch(() => undefined);

    if (deck?.ownerId === user.uid || card.ownerId === user.uid) {
      await updateDoc(doc(db, `decks/${deckId}/cards`, card.id), update);
      return;
    }

    await setDoc(doc(db, `users/${user.uid}/cardProgress`, progressDocId(deckId, card.id)), {
      ...update,
      userId: user.uid,
      deckId,
      cardId: card.id,
      sourceDeckOwnerId: deck?.ownerId || card.ownerId || '',
    }, { merge: true });
  }, [deck?.ownerId, deckId, user]);

  const handleBuryCurrentCard = useCallback(async () => {
    if (!currentCard) return;
    await saveControlUpdate(currentCard, { buriedUntil: getLocalTomorrowIso() });
    toast.success('Đã bury thẻ đến ngày mai.');
    advanceCard();
  }, [advanceCard, currentCard, saveControlUpdate]);

  const handleSuspendCurrentCard = useCallback(async () => {
    if (!currentCard) return;
    await saveControlUpdate(currentCard, { suspended: true, buriedUntil: '' });
    toast.success('Đã suspend thẻ.');
    advanceCard();
  }, [advanceCard, currentCard, saveControlUpdate]);

  const finishSession = async (finalStats = sessionStats) => {
    setIsFinished(true);
    flushReviewQueue().catch((error) => console.warn('Review queue sync failed.', error));
    const duration = Math.round((Date.now() - startTime) / 1000);

    try {
      if (!user) return;
      const userRef = doc(db, 'users', user.uid);
      const userSnap = await getDoc(userRef);

      if (userSnap.exists()) {
        const userData = userSnap.data() as UserProfile;
        const today = new Date();
        const currentDate = new Date(today.getFullYear(), today.getMonth(), today.getDate());
        const lastStudyDate = userData.lastStudyDate ? new Date(userData.lastStudyDate) : null;
        const lastDate = lastStudyDate ? new Date(lastStudyDate.getFullYear(), lastStudyDate.getMonth(), lastStudyDate.getDate()) : null;
        let newStreak = userData.streak || 0;
        let shouldUpdateStreak = false;

        if (!lastDate) {
          newStreak = 1;
          shouldUpdateStreak = true;
        } else {
          const diffDays = Math.round((currentDate.getTime() - lastDate.getTime()) / (1000 * 60 * 60 * 24));
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

        await updateDoc(userRef, {
          lastStudyDate: today.toISOString(),
          ...(shouldUpdateStreak ? { streak: newStreak } : {}),
        });
      }

      await addDoc(collection(db, `users/${user.uid}/sessions`), {
        userId: user.uid,
        deckId,
        cardsReviewed: finalStats.reviewed,
        correctCount: finalStats.correct,
        duration,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      console.error('Error finishing session:', error);
    }
  };

  const speak = useCallback((text: string) => {
    if (!('speechSynthesis' in window)) return;
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(new SpeechSynthesisUtterance(stripHtml(text)));
  }, []);

  if (loading) return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center space-y-4">
      <div className="h-12 w-12 animate-spin rounded-full border-b-2 border-zinc-950 dark:border-white" />
      <p className="font-medium text-zinc-500">Đang chuẩn bị bài học...</p>
    </div>
  );

  if (cards.length === 0 || !currentCard) return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center space-y-6 text-center">
      <div className="rounded-full bg-zinc-100 p-6 dark:bg-white/5">
        <BrainCircuit className="h-12 w-12 text-zinc-400" />
      </div>
      <h2 className="text-2xl font-bold text-zinc-950 dark:text-white">Không có thẻ nào để học</h2>
      <p className="max-w-xs text-zinc-500">Bộ thẻ này đang trống hoặc bạn đã hoàn thành các thẻ cần ôn tập.</p>
      <Link to="/decks">
        <Button variant="outline">Quay lại danh sách</Button>
      </Link>
    </div>
  );

  if (isFinished) {
    return (
      <div className="flex min-h-[70vh] flex-col items-center justify-center space-y-8">
        <div className="w-full max-w-md space-y-8 rounded-lg border border-zinc-200 bg-white p-10 text-center shadow-2xl dark:border-white/10 dark:bg-zinc-950">
          <motion.div
            initial={{ scale: 0 }}
            animate={{ scale: 1 }}
            transition={{ type: 'spring', stiffness: 260, damping: 20 }}
            className="mx-auto flex h-24 w-24 items-center justify-center rounded-lg bg-amber-100 dark:bg-amber-900/30"
          >
            <Trophy className="h-12 w-12 text-amber-600 dark:text-amber-400" />
          </motion.div>
          <div>
            <h1 className="text-4xl font-semibold text-zinc-950 dark:text-white">Hoàn thành</h1>
            <p className="mt-2 text-zinc-500 dark:text-zinc-400">Phiên học đã được lưu theo cơ chế local-first.</p>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="rounded-lg border border-zinc-200 bg-zinc-50 p-5 dark:border-white/10 dark:bg-white/5">
              <p className="font-mono text-3xl font-semibold text-zinc-950 dark:text-white">{sessionStats.reviewed}</p>
              <p className="mt-1 text-xs font-semibold uppercase text-zinc-500">Đã học</p>
            </div>
            <div className="rounded-lg border border-zinc-200 bg-zinc-50 p-5 dark:border-white/10 dark:bg-white/5">
              <p className="font-mono text-3xl font-semibold text-zinc-950 dark:text-white">
                {sessionStats.reviewed > 0 ? Math.round((sessionStats.correct / sessionStats.reviewed) * 100) : 0}%
              </p>
              <p className="mt-1 text-xs font-semibold uppercase text-zinc-500">Chính xác</p>
            </div>
          </div>
          <div className="space-y-3">
            <Link to="/decks">
              <Button className="h-12 w-full">Quay lại bộ thẻ</Button>
            </Link>
            <Button variant="ghost" onClick={resetStudy} className="h-12 w-full">
              Học lại lần nữa
            </Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <ReviewCard
      key={currentCard.id}
      card={currentCard}
      isFlipped={isFlipped}
      currentIndex={currentIndex}
      totalCards={cards.length}
      ratingPreviews={ratingPreviews}
      busy={ratingLockRef.current}
      onFlip={() => {
        setIsFlipped((value) => !value);
        playSound('flip', settings.volume);
      }}
      onRate={handleRate}
      onClose={() => navigate(`/decks/${deckId}`)}
      onBury={handleBuryCurrentCard}
      onSuspend={handleSuspendCurrentCard}
      onSpeak={speak}
    />
  );
}
