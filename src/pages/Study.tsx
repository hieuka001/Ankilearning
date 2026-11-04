import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { User } from 'firebase/auth';
import {
  addDoc,
  arrayRemove,
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  query,
  setDoc,
  updateDoc,
  where,
} from 'firebase/firestore';
import { motion } from 'motion/react';
import { BrainCircuit, CloudOff, Home, RotateCcw, Trophy, Undo2 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { db } from '../firebase';
import { Deck, Flashcard, ReviewLog, UserProfile } from '../types';
import {
  buildStudyQueues,
  countIntroducedToday,
  getLocalTomorrowIso,
  getStudyDayKey,
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
import { cacheCards, getCachedCards, localDB, upsertCachedCard } from '../review/localDB';
import { useScheduler } from '../review/useScheduler';
import { speechLanguageForText } from '../lib/language';

interface StudyProps {
  user: User | null;
  profile?: UserProfile | null;
}

type LoadState = 'loading' | 'ready' | 'empty-deck' | 'no-due' | 'error';
type SaveStatus = 'idle' | 'saving' | 'saved' | 'error';

interface UndoSnapshot {
  /** The card exactly as it was before the rating being undone. */
  cardBefore: Flashcard;
  statsBefore: { reviewed: number; correct: number };
  historyEntry: ReviewLog;
  wasCorrect: boolean;
}

/**
 * A rated card whose new due time still falls inside this window (learning /
 * relearning steps, "again" lapses) is appended to the end of the session
 * queue so the learner meets it again in the same session, like Anki.
 */
const SESSION_REQUEUE_WINDOW_MS = 25 * 60 * 1000;

const stripHtml = (value: string) => value.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();

const readLastReviewTime = (card: Flashcard): Date | null => {
  const raw = typeof card.lastReview === 'string' ? card.lastReview : card.lastReview?.reviewTime;
  if (!raw) return null;
  const parsed = new Date(raw);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
};

/**
 * Deck-level approximation for the daily review cap: counts cards whose
 * LAST review happened on the given local study day. A card reviewed three
 * times today counts once — the queue builder only needs an estimate of how
 * much of today's review budget this deck has already consumed.
 */
const countReviewedToday = (cards: Flashcard[], now: Date) => {
  const todayKey = getStudyDayKey(now);
  return cards.reduce((count, card) => {
    const lastReview = readLastReviewTime(card);
    return count + (lastReview && getStudyDayKey(lastReview) === todayKey ? 1 : 0);
  }, 0);
};

/**
 * Scheduler fields of a card, as a Firestore-safe update object (undefined
 * values stripped — Firestore rejects them). Used to overwrite a card's
 * server state with its pre-rating state when undoing an already-flushed
 * rating.
 */
const buildRestoreUpdate = (card: Flashcard) => {
  const withFirstReview = card as Flashcard & { firstReviewAt?: string };
  const source: Record<string, unknown> = {
    state: card.state,
    due: card.due,
    interval: card.interval,
    easeFactor: card.easeFactor,
    stability: card.stability,
    difficulty: card.difficulty,
    retrievability: card.retrievability,
    elapsedDays: card.elapsedDays,
    scheduledDays: card.scheduledDays,
    stepIndex: card.stepIndex,
    dueDate: card.dueDate,
    nextReview: card.nextReview,
    lapses: card.lapses,
    reps: card.reps,
    repetitions: card.repetitions,
    suspended: card.suspended,
    lastReview: card.lastReview,
    firstReviewAt: withFirstReview.firstReviewAt,
    updatedAt: new Date().toISOString(),
  };
  Object.keys(source).forEach((key) => {
    if (source[key] === undefined) delete source[key];
  });
  return source as Partial<Flashcard>;
};

export default function Study({ user, profile }: StudyProps) {
  const { settings } = useSettings();
  const { deckId } = useParams();
  const navigate = useNavigate();
  const [deck, setDeck] = useState<Deck | null>(null);
  const [cards, setCardsState] = useState<Flashcard[]>([]);
  const [currentIndex, setCurrentIndexState] = useState(0);
  const [isFlipped, setIsFlipped] = useState(false);
  const [loadState, setLoadState] = useState<LoadState>('loading');
  const [isFinished, setIsFinished] = useState(false);
  const [sessionStats, setSessionStats] = useState({ reviewed: 0, correct: 0 });
  const [now, setNow] = useState(() => new Date());
  const [cloudScheduler, setCloudScheduler] = useState<SchedulerConfigInput | null>(null);
  const [undoSnapshot, setUndoSnapshot] = useState<UndoSnapshot | null>(null);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('idle');
  const [reloadKey, setReloadKey] = useState(0);

  // The session queue lives in a ref as well as state: rating handlers must
  // make advance/finish decisions against the queue AS UPDATED by the
  // current rating (re-queue appends), which React state cannot guarantee
  // synchronously.
  const cardsRef = useRef<Flashcard[]>([]);
  const currentIndexRef = useRef(0);
  const sessionStatsRef = useRef({ reviewed: 0, correct: 0 });
  const startTimeRef = useRef(Date.now());
  const finishStatsRef = useRef<{ reviewed: number; correct: number } | null>(null);
  const reviewAllRef = useRef(false);
  const prefetchedImages = useRef<Set<string>>(new Set());
  const ratingLockRef = useRef(false);

  // Latest scheduler settings, read by the loader through a ref so a fresh
  // profile snapshot (new object identity, same content) does NOT refetch
  // and wipe the live session queue mid-study.
  const schedulerSettingsRef = useRef({
    profile: profile?.settings?.scheduler,
    local: settings.scheduler,
  });
  schedulerSettingsRef.current = {
    profile: profile?.settings?.scheduler,
    local: settings.scheduler,
  };

  const setCards = useCallback((updater: Flashcard[] | ((previous: Flashcard[]) => Flashcard[])) => {
    const next = typeof updater === 'function'
      ? (updater as (previous: Flashcard[]) => Flashcard[])(cardsRef.current)
      : updater;
    cardsRef.current = next;
    setCardsState(next);
  }, []);

  const setCurrentIndex = useCallback((value: number) => {
    currentIndexRef.current = value;
    setCurrentIndexState(value);
  }, []);

  const loading = loadState === 'loading';
  const schedulerConfig = cloudScheduler || profile?.settings?.scheduler || settings.scheduler;
  const { previewRatings, reviewCard } = useScheduler(schedulerConfig);
  const currentCard = cards[currentIndex];
  const ratingPreviews = useMemo(
    () => currentCard ? previewRatings(currentCard, now) : [],
    [currentCard, now, previewRatings],
  );

  const beginSession = useCallback((queue: Flashcard[]) => {
    cardsRef.current = queue;
    setCardsState(queue);
    currentIndexRef.current = 0;
    setCurrentIndexState(0);
    setIsFlipped(false);
    setIsFinished(false);
    sessionStatsRef.current = { reviewed: 0, correct: 0 };
    setSessionStats({ reviewed: 0, correct: 0 });
    startTimeRef.current = Date.now();
    finishStatsRef.current = null;
    setUndoSnapshot(null);
    setSaveStatus('idle');
    setLoadState('ready');
  }, []);

  const resetStudy = useCallback(() => {
    setUndoSnapshot(null);
    setSaveStatus('idle');
    finishStatsRef.current = null;
    setIsFinished(false);
    sessionStatsRef.current = { reviewed: 0, correct: 0 };
    setSessionStats({ reviewed: 0, correct: 0 });
    startTimeRef.current = Date.now();
    setIsFlipped(false);
    setCurrentIndex(0);
  }, [setCurrentIndex]);

  useEffect(() => {
    if (!isFlipped) return;
    const timer = window.setInterval(() => setNow(new Date()), 15000);
    return () => window.clearInterval(timer);
  }, [isFlipped]);

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
    if (!deckId || !user) return;
    let cancelled = false;

    const fetchData = async () => {
      setLoadState('loading');
      try {
        const deckSnap = await getDoc(doc(db, 'decks', deckId));
        if (!deckSnap.exists()) {
          navigate('/decks');
          return;
        }

        const deckData = { id: deckSnap.id, ...deckSnap.data() } as Deck;
        if (cancelled) return;
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
          if (!cancelled) setCloudScheduler(remoteScheduler);
        }

        if (cancelled) return;
        const activeScheduler = remoteScheduler
          || schedulerSettingsRef.current.profile
          || schedulerSettingsRef.current.local;
        const currentTime = new Date();

        if (reviewAllRef.current) {
          const studyableCards = allCards.filter((card) => {
            const schedule = normalizeCardSchedule(card, currentTime);
            return !schedule.suspended && !isCardBuried(card, currentTime);
          });
          beginSession(sortCardsForStudy(studyableCards, activeScheduler, currentTime));
          return;
        }

        // Real per-day limits (see countReviewedToday for the deck-level
        // approximation used for reviewedToday).
        const limits = {
          introducedToday: countIntroducedToday(allCards, currentTime),
          reviewedToday: countReviewedToday(allCards, currentTime),
        };
        const dueCards = buildStudyQueues(allCards, activeScheduler, currentTime, limits).all;

        if (dueCards.length > 0) {
          beginSession(dueCards);
          return;
        }

        setCards([]);
        setLoadState(allCards.length === 0 ? 'empty-deck' : 'no-due');
      } catch (error) {
        console.error(error);
        if (cancelled) return;
        const cached = await getCachedCards(user.uid, deckId).catch(() => []);
        if (cached.length > 0) {
          const currentTime = new Date();
          const fallbackScheduler = schedulerSettingsRef.current.profile
            || schedulerSettingsRef.current.local;
          const cachedCards = cached as Flashcard[];
          const limits = {
            introducedToday: countIntroducedToday(cachedCards, currentTime),
            reviewedToday: countReviewedToday(cachedCards, currentTime),
          };
          // The offline fallback goes through the SAME queue builder as the
          // online path, so due/suspended/buried filtering and the daily
          // limits apply identically — the raw cache is never studied as-is.
          const dueCards = buildStudyQueues(cachedCards, fallbackScheduler, currentTime, limits).all;
          if (dueCards.length > 0) {
            toast.warning('Đang học ngoại tuyến bằng dữ liệu đã lưu trên thiết bị.');
            beginSession(dueCards);
            return;
          }
          setCards([]);
          setLoadState('no-due');
          return;
        }
        setCards([]);
        setLoadState('error');
      }
    };

    fetchData();
    return () => {
      cancelled = true;
    };
  }, [beginSession, deckId, navigate, reloadKey, setCards, user]);

  const finishSession = useCallback(async (finalStats: { reviewed: number; correct: number }) => {
    finishStatsRef.current = finalStats;
    setIsFinished(true);
    setSaveStatus('saving');
    flushReviewQueue().catch((error) => console.warn('Review queue sync failed.', error));
    const duration = Math.round((Date.now() - startTimeRef.current) / 1000);

    try {
      if (!user) {
        setSaveStatus('saved');
        return;
      }
      const userRef = doc(db, 'users', user.uid);
      const userSnap = await getDoc(userRef);

      if (userSnap.exists()) {
        const userData = userSnap.data() as UserProfile;
        const today = new Date();
        // One day-boundary convention for streaks: the local study-day key.
        const todayKey = getStudyDayKey(today);
        const lastKey = userData.lastStudyDate ? getStudyDayKey(new Date(userData.lastStudyDate)) : null;
        let newStreak = userData.streak || 0;
        let shouldUpdateStreak = false;

        if (!lastKey) {
          newStreak = 1;
          shouldUpdateStreak = true;
        } else if (lastKey !== todayKey) {
          const dayStartMs = (key: string) => {
            const [year, month, day] = key.split('-').map(Number);
            return new Date(year, (month || 1) - 1, day || 1).getTime();
          };
          const diffDays = Math.round((dayStartMs(todayKey) - dayStartMs(lastKey)) / (1000 * 60 * 60 * 24));
          if (diffDays === 1) {
            newStreak += 1;
            shouldUpdateStreak = true;
          } else if (diffDays > 1) {
            newStreak = 1;
            shouldUpdateStreak = true;
          }
        } else if (newStreak === 0) {
          newStreak = 1;
          shouldUpdateStreak = true;
        }

        await updateDoc(userRef, {
          lastStudyDate: today.toISOString(),
          // Invariant: `streak` and `streakDays` always move together, with
          // the same value, so no reader can show a stale streakDays.
          ...(shouldUpdateStreak ? { streak: newStreak, streakDays: newStreak } : {}),
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
      setSaveStatus('saved');
    } catch (error) {
      console.error('Error finishing session:', error);
      // Honest finish screen: only claim "saved" on success; the retry
      // button calls finishSession again with the same final stats.
      setSaveStatus('error');
    }
  }, [deckId, user]);

  const advanceCard = useCallback((finalStats = sessionStatsRef.current) => {
    if (currentIndexRef.current < cardsRef.current.length - 1) {
      setIsFlipped(false);
      setCurrentIndex(currentIndexRef.current + 1);
    } else {
      void finishSession(finalStats);
    }
  }, [finishSession, setCurrentIndex]);

  const handleRate = useCallback((rating: SchedulerRating) => {
    if (ratingLockRef.current || !currentCard || !user || !deckId) return;
    ratingLockRef.current = true;

    const reviewTime = new Date();
    const { schedulerUpdate, historyEntry, leech } = reviewCard(currentCard, rating, reviewTime);
    const isCorrect = rating !== 'again';
    const statsBefore = sessionStatsRef.current;
    const nextStats = {
      reviewed: statsBefore.reviewed + 1,
      correct: statsBefore.correct + (isCorrect ? 1 : 0),
    };
    const updatedCard = {
      ...currentCard,
      ...schedulerUpdate,
      reviewHistory: [
        ...(Array.isArray(currentCard.reviewHistory) ? currentCard.reviewHistory : []),
        historyEntry,
      ],
    } as Flashcard;

    // Snapshot for Undo BEFORE any state moves on.
    setUndoSnapshot({ cardBefore: currentCard, statsBefore, historyEntry, wasCorrect: isCorrect });
    sessionStatsRef.current = nextStats;
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

    if (leech) {
      toast.warning('Thẻ này đã quên quá nhiều lần nên đã tự tạm dừng (leech). Bạn có thể sửa lại thẻ trong chi tiết bộ thẻ.');
    }

    // Re-queue inside the session: a card still due within the session
    // window returns at the END of the queue instead of vanishing until its
    // next due date. Graduated cards (due far ahead) and suspended/leech
    // cards are not re-queued, and a card already waiting later in the
    // queue is never duplicated.
    const dueTime = new Date(schedulerUpdate.dueDate || updatedCard.dueDate || '').getTime();
    const stillDueInSession = !schedulerUpdate.suspended
      && Number.isFinite(dueTime)
      && dueTime <= reviewTime.getTime() + SESSION_REQUEUE_WINDOW_MS;
    setCards((previous) => {
      const mapped = previous.map((card) => card.id === currentCard.id ? updatedCard : card);
      if (!stillDueInSession) return mapped;
      const waitingLater = mapped.slice(currentIndexRef.current + 1);
      if (waitingLater.some((card) => card.id === currentCard.id)) return mapped;
      return [...mapped, updatedCard];
    });

    advanceCard(nextStats);
    window.setTimeout(() => {
      ratingLockRef.current = false;
    }, 180);
  }, [advanceCard, currentCard, deck?.ownerId, deckId, reviewCard, setCards, settings.volume, user]);

  const handleUndo = useCallback(async () => {
    if (ratingLockRef.current || !undoSnapshot || !user || !deckId) return;
    ratingLockRef.current = true;
    const snapshot = undoSnapshot;
    const restored = snapshot.cardBefore;

    try {
      // 1. Local state: drop the re-queued copy waiting later in the queue,
      //    restore the pre-rating card in its slot, rewind the session
      //    stats, and put the card back in front of the learner.
      setCards((previous) => {
        const withoutLaterCopies = previous.filter(
          (card, index) => index <= currentIndexRef.current || card.id !== restored.id,
        );
        return withoutLaterCopies.map((card) => card.id === restored.id ? restored : card);
      });
      const restoredIndex = cardsRef.current.findIndex((card) => card.id === restored.id);
      if (restoredIndex >= 0) setCurrentIndex(restoredIndex);
      sessionStatsRef.current = snapshot.statsBefore;
      setSessionStats(snapshot.statsBefore);
      setIsFlipped(false);
      setUndoSnapshot(null);

      // 2. Device cache: an offline reload must not resurrect the rating.
      await upsertCachedCard(user.uid, deckId, restored).catch(() => undefined);

      // 3. Sync record for the undone rating. The queue id formula mirrors
      //    firebaseSync's queueId (userId-deckId-cardId-historyEntryId).
      const queueRecordId = `${user.uid}-${deckId}-${restored.id}-${snapshot.historyEntry.id}`;
      const record = await localDB.reviewResults.get(queueRecordId).catch(() => undefined);

      if (record && record.status !== 'synced') {
        // Not flushed yet (the common case: flush runs after ~3s or 5
        // records, and 'dead' records never flush) — deleting the outbox
        // record means the rating never reaches the server at all.
        await localDB.reviewResults.delete(queueRecordId).catch(() => undefined);
      } else {
        // Already flushed (or the local record is gone): overwrite the
        // server state with the pre-rating scheduler fields and try to
        // remove the appended history entry / review sub-document.
        // Known limits: gamification counters already credited by that
        // flush cannot be decremented through the queue, and if the undone
        // rating was the card's first ever review, a stamped
        // `firstReviewAt` may remain on the server copy.
        const restoreUpdate = buildRestoreUpdate(restored);
        const isOwner = deck?.ownerId === user.uid || restored.ownerId === user.uid;
        try {
          if (isOwner) {
            await updateDoc(doc(db, `decks/${deckId}/cards`, restored.id), {
              ...restoreUpdate,
              reviewHistory: arrayRemove(snapshot.historyEntry),
            });
            await deleteDoc(
              doc(db, `decks/${deckId}/cards`, restored.id, 'reviews', snapshot.historyEntry.id),
            ).catch(() => undefined);
          } else {
            await setDoc(doc(db, `users/${user.uid}/cardProgress`, progressDocId(deckId, restored.id)), {
              ...restoreUpdate,
              reviewHistory: arrayRemove(snapshot.historyEntry),
              userId: user.uid,
              deckId,
              cardId: restored.id,
              sourceDeckOwnerId: deck?.ownerId || restored.ownerId || '',
            }, { merge: true });
          }
        } catch (syncError) {
          console.warn('Undo server correction failed.', syncError);
          toast.warning('Đã hoàn tác trên thiết bị, nhưng chưa đồng bộ được bản hiệu chỉnh lên máy chủ.');
        }
      }

      toast.success('Đã hoàn tác lần chấm vừa rồi.');
    } finally {
      ratingLockRef.current = false;
    }
  }, [deck?.ownerId, deckId, setCards, setCurrentIndex, undoSnapshot, user]);

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
  }, [deck?.ownerId, deckId, setCards, user]);

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

  const flipCard = useCallback(() => {
    setIsFlipped((value) => !value);
    playSound('flip', settings.volume);
  }, [settings.volume]);

  // Keyboard shortcuts: Space/Enter flips, 1-4 rate (only once flipped),
  // U undoes the last rating. Ignored while typing, with modifier keys, or
  // when focus sits on a native button/link (those activate themselves).
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (loadState !== 'ready' || isFinished || !currentCard || event.repeat) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest('input, textarea, select, [contenteditable="true"]')) return;
      const tagName = target?.tagName;
      if (tagName === 'BUTTON' || tagName === 'A') return;

      if (event.key === ' ' || event.key === 'Enter') {
        event.preventDefault();
        flipCard();
        return;
      }
      if (event.key.toLowerCase() === 'u' && undoSnapshot) {
        event.preventDefault();
        void handleUndo();
        return;
      }
      if (isFlipped && ['1', '2', '3', '4'].includes(event.key)) {
        const preview = ratingPreviews[Number(event.key) - 1];
        if (preview) {
          event.preventDefault();
          handleRate(preview.rating);
        }
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [currentCard, flipCard, handleRate, handleUndo, isFinished, isFlipped, loadState, ratingPreviews, undoSnapshot]);

  const speak = useCallback((text: string) => {
    if (!('speechSynthesis' in window)) return;
    window.speechSynthesis.cancel();
    const cleanText = stripHtml(text);
    const utterance = new SpeechSynthesisUtterance(cleanText);
    utterance.lang = speechLanguageForText(cleanText, profile?.settings?.language || settings.language);
    window.speechSynthesis.speak(utterance);
  }, [profile?.settings?.language, settings.language]);

  const startReviewAll = useCallback(() => {
    reviewAllRef.current = true;
    setReloadKey((key) => key + 1);
  }, []);

  const retryLoad = useCallback(() => {
    setReloadKey((key) => key + 1);
  }, []);

  const handleRetrySave = useCallback(() => {
    const stats = finishStatsRef.current;
    if (stats) void finishSession(stats);
  }, [finishSession]);

  if (loading) return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center space-y-4">
      <div className="h-12 w-12 animate-spin rounded-full border-b-2 border-zinc-950 dark:border-white" />
      <p className="font-medium text-zinc-500">Đang chuẩn bị bài học...</p>
    </div>
  );

  if (loadState === 'error') return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center space-y-6 text-center">
      <div className="rounded-full bg-rose-100 p-6 dark:bg-rose-500/10">
        <CloudOff className="h-12 w-12 text-rose-500" />
      </div>
      <h2 className="text-2xl font-bold text-zinc-950 dark:text-white">Không tải được dữ liệu học</h2>
      <p className="max-w-sm text-zinc-500">
        Kết nối hoặc máy chủ đang gặp sự cố, và thiết bị này chưa có bản sao của bộ thẻ để học ngoại tuyến.
        Kiểm tra mạng rồi thử lại.
      </p>
      <div className="flex flex-wrap items-center justify-center gap-3">
        <Button onClick={retryLoad} className="gap-2">
          <RotateCcw className="h-4 w-4" />
          Thử lại
        </Button>
        <Link to="/decks">
          <Button variant="outline">Quay lại danh sách</Button>
        </Link>
      </div>
    </div>
  );

  if (loadState === 'empty-deck') return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center space-y-6 text-center">
      <div className="rounded-full bg-zinc-100 p-6 dark:bg-white/5">
        <BrainCircuit className="h-12 w-12 text-zinc-400" />
      </div>
      <h2 className="text-2xl font-bold text-zinc-950 dark:text-white">Bộ thẻ chưa có thẻ nào</h2>
      <p className="max-w-sm text-zinc-500">
        Bộ thẻ này đang trống. Hãy thêm thẻ vào bộ rồi quay lại học.
      </p>
      <div className="flex flex-wrap items-center justify-center gap-3">
        {deckId && (
          <Link to={`/decks/${deckId}`}>
            <Button>Mở chi tiết bộ thẻ</Button>
          </Link>
        )}
        <Link to="/decks">
          <Button variant="outline">Danh sách bộ thẻ</Button>
        </Link>
      </div>
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
            {saveStatus === 'saving' && (
              <p className="mt-2 text-zinc-500 dark:text-zinc-400">Đang lưu phiên học...</p>
            )}
            {saveStatus === 'saved' && (
              <p className="mt-2 text-zinc-500 dark:text-zinc-400">Phiên học đã được lưu.</p>
            )}
            {saveStatus === 'idle' && (
              <p className="mt-2 text-zinc-500 dark:text-zinc-400">Phiên học đã hoàn thành.</p>
            )}
            {saveStatus === 'error' && (
              <div className="mt-3 rounded-lg border border-rose-200 bg-rose-50 p-3 text-left text-sm text-rose-700 dark:border-rose-500/30 dark:bg-rose-500/10 dark:text-rose-300">
                <p>
                  Chưa lưu được phiên học lên máy chủ. Tiến độ từng thẻ vẫn nằm trong hàng đợi
                  đồng bộ trên thiết bị và sẽ tự đẩy lên khi có mạng.
                </p>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleRetrySave}
                  className="mt-3 w-full gap-2 bg-white dark:bg-transparent"
                >
                  <RotateCcw className="h-4 w-4" />
                  Lưu lại
                </Button>
              </div>
            )}
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

  if (loadState === 'no-due' || !currentCard) return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center space-y-6 text-center">
      <div className="rounded-full bg-emerald-100 p-6 dark:bg-emerald-500/10">
        <Trophy className="h-12 w-12 text-emerald-600 dark:text-emerald-400" />
      </div>
      <h2 className="text-2xl font-bold text-zinc-950 dark:text-white">Đã ôn xong phần đến hạn hôm nay</h2>
      <p className="max-w-sm text-zinc-500">
        {deck?.name
          ? `Bộ thẻ «${deck.name}» không còn thẻ nào đến hạn. `
          : 'Bộ thẻ này không còn thẻ nào đến hạn. '}
        Bạn có thể ôn lại toàn bộ thẻ trong bộ, hoặc quay lại khi tới hạn ôn tiếp theo.
      </p>
      <div className="flex flex-wrap items-center justify-center gap-3">
        <Button onClick={startReviewAll} className="gap-2">
          <RotateCcw className="h-4 w-4" />
          Ôn lại tất cả thẻ
        </Button>
        <Link to="/">
          <Button variant="outline" className="gap-2">
            <Home className="h-4 w-4" />
            Về trang tổng quan
          </Button>
        </Link>
        {deckId && (
          <Link to={`/decks/${deckId}`}>
            <Button variant="ghost">Quay lại bộ thẻ</Button>
          </Link>
        )}
      </div>
    </div>
  );

  return (
    <div className="focus-study-active focus-study-shell">
      <ReviewCard
        key={currentCard.id}
        card={currentCard}
        isFlipped={isFlipped}
        currentIndex={currentIndex}
        totalCards={cards.length}
        ratingPreviews={ratingPreviews}
        busy={ratingLockRef.current}
        onFlip={flipCard}
        onRate={handleRate}
        onClose={() => navigate(`/decks/${deckId}`)}
        onBury={handleBuryCurrentCard}
        onSuspend={handleSuspendCurrentCard}
        onSpeak={speak}
      />
      {undoSnapshot && (
        <div className="flex justify-center px-3 pb-5">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void handleUndo()}
            className="gap-2 rounded-full shadow-sm"
          >
            <Undo2 className="h-4 w-4" />
            Hoàn tác lần chấm vừa rồi
            <kbd className="rounded border border-zinc-300 px-1.5 py-0.5 text-[10px] font-semibold text-zinc-500 dark:border-white/20 dark:text-zinc-400">
              U
            </kbd>
          </Button>
        </div>
      )}
    </div>
  );
}
