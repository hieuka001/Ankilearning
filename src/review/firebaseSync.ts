import { arrayUnion, doc, writeBatch } from 'firebase/firestore';
import { db } from '../firebase';
import type { Flashcard, ReviewLog } from '../types';
import { trackReviewActivity } from '../services/gamificationService';
import {
  countPendingReviewResults,
  getPendingReviewResults,
  markReviewResultsFailed,
  markReviewResultsSynced,
  saveReviewResult,
  upsertCachedCard,
  type ReviewQueueRecord,
} from './localDB';

const FLUSH_SIZE = 5;
const FLUSH_INTERVAL_MS = 3000;
let flushTimer: number | null = null;
let isFlushing = false;

export const progressDocId = (deckId: string, cardId: string) =>
  `${deckId}__${cardId}`.replace(/\//g, '_');

export interface ReviewSyncInput {
  userId: string;
  deckId: string;
  card: Flashcard;
  schedulerUpdate: Partial<Flashcard>;
  historyEntry: ReviewLog;
  sourceDeckOwnerId: string;
  isOwnerReview: boolean;
  isCorrect: boolean;
}

const queueId = (input: ReviewSyncInput) =>
  `${input.userId}-${input.deckId}-${input.card.id}-${input.historyEntry.id}`;

function scheduleFlush() {
  if (flushTimer !== null || typeof window === 'undefined') return;
  flushTimer = window.setTimeout(() => {
    flushTimer = null;
    flushReviewQueue().catch((error) => console.warn('Review queue sync failed.', error));
  }, FLUSH_INTERVAL_MS);
}

export async function enqueueReviewSync(input: ReviewSyncInput) {
  const record: ReviewQueueRecord = {
    id: queueId(input),
    userId: input.userId,
    deckId: input.deckId,
    cardId: input.card.id,
    sourceDeckOwnerId: input.sourceDeckOwnerId,
    isOwnerReview: input.isOwnerReview,
    isCorrect: input.isCorrect,
    schedulerUpdate: input.schedulerUpdate,
    historyEntry: input.historyEntry,
    status: 'pending',
    createdAt: input.historyEntry.reviewTime,
  };

  await Promise.all([
    saveReviewResult(record),
    upsertCachedCard(input.userId, input.deckId, {
      ...input.card,
      ...input.schedulerUpdate,
      reviewHistory: [
        ...(Array.isArray(input.card.reviewHistory) ? input.card.reviewHistory : []),
        input.historyEntry,
      ],
    }),
  ]);

  const pendingCount = await countPendingReviewResults();
  if (pendingCount >= FLUSH_SIZE) {
    flushReviewQueue().catch((error) => console.warn('Review queue sync failed.', error));
    return;
  }
  scheduleFlush();
}

export async function flushReviewQueue() {
  if (isFlushing || (typeof navigator !== 'undefined' && !navigator.onLine)) return;
  isFlushing = true;

  const records = (await getPendingReviewResults()).slice(0, 500);
  if (records.length === 0) {
    isFlushing = false;
    return;
  }

  const ids = records.map((record) => record.id);
  try {
    const batch = writeBatch(db);
    const reviewedByUser = new Map<string, number>();

    records.forEach((record) => {
      if (record.isOwnerReview) {
        const cardRef = doc(db, 'decks', record.deckId, 'cards', record.cardId);
        const reviewRef = doc(db, 'decks', record.deckId, 'cards', record.cardId, 'reviews', record.historyEntry.id);
        batch.update(cardRef, {
          ...record.schedulerUpdate,
          reviewHistory: arrayUnion(record.historyEntry),
        });
        batch.set(reviewRef, record.historyEntry);
      } else {
        const progressRef = doc(db, 'users', record.userId, 'cardProgress', progressDocId(record.deckId, record.cardId));
        batch.set(progressRef, {
          ...record.schedulerUpdate,
          userId: record.userId,
          deckId: record.deckId,
          cardId: record.cardId,
          sourceDeckOwnerId: record.sourceDeckOwnerId,
          reviewHistory: arrayUnion(record.historyEntry),
        }, { merge: true });
      }

      reviewedByUser.set(record.userId, (reviewedByUser.get(record.userId) || 0) + 1);
    });

    await batch.commit();
    await markReviewResultsSynced(ids);

    await Promise.all(
      Array.from(reviewedByUser.entries()).map(([userId, count]) =>
        trackReviewActivity(userId, {
          cardsReviewed: count,
          correctCount: count,
          source: 'review_queue',
        }).catch((error) => {
          console.warn('Gamification review tracking failed.', error);
        })
      )
    );
  } catch (error) {
    await markReviewResultsFailed(ids, error);
    scheduleFlush();
    throw error;
  } finally {
    isFlushing = false;
  }
}

if (typeof window !== 'undefined') {
  window.addEventListener('online', () => {
    flushReviewQueue().catch((error) => console.warn('Review queue sync failed.', error));
  });
}
