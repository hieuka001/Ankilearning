import { arrayUnion, doc, writeBatch, type WriteBatch } from 'firebase/firestore';
import { auth, db } from '../firebase';
import type { Flashcard, ReviewLog } from '../types';
import { trackReviewActivity } from '../services/gamificationService';
import {
  countPendingReviewResults,
  getPendingReviewResults,
  markReviewResultsFailed,
  markReviewResultsSynced,
  pruneSyncedRecords,
  saveReviewResult,
  upsertCachedCard,
  type ReviewQueueRecord,
} from './localDB';

const FLUSH_SIZE = 5;
const FLUSH_INTERVAL_MS = 3000;
/** Firestore hard limit is 500 writes per batch; stay safely below it. */
const MAX_BATCH_OPS = 450;
/** Upper bound on queue records considered per flush run. */
const MAX_RECORDS_PER_FLUSH = 500;
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

/**
 * Firestore operations a single queue record needs:
 * owner reviews write the card document AND its review log (2 ops);
 * progress reviews for other people's decks write one document (1 op).
 */
const recordOpCount = (record: ReviewQueueRecord) => (record.isOwnerReview ? 2 : 1);

function applyRecord(batch: WriteBatch, record: ReviewQueueRecord) {
  if (record.isOwnerReview) {
    const cardRef = doc(db, 'decks', record.deckId, 'cards', record.cardId);
    const reviewRef = doc(db, 'decks', record.deckId, 'cards', record.cardId, 'reviews', record.historyEntry.id);
    // set + merge (not update) so a card deleted/recreated on another device
    // does not fail the whole record with not-found.
    batch.set(cardRef, {
      ...record.schedulerUpdate,
      reviewHistory: arrayUnion(record.historyEntry),
    }, { merge: true });
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
}

/** Split records into chunks whose total Firestore op count stays under MAX_BATCH_OPS. */
function chunkRecords(records: ReviewQueueRecord[]): ReviewQueueRecord[][] {
  const chunks: ReviewQueueRecord[][] = [];
  let current: ReviewQueueRecord[] = [];
  let currentOps = 0;
  for (const record of records) {
    const ops = recordOpCount(record);
    if (current.length > 0 && currentOps + ops > MAX_BATCH_OPS) {
      chunks.push(current);
      current = [];
      currentOps = 0;
    }
    current.push(record);
    currentOps += ops;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
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

  const pendingCount = await countPendingReviewResults(input.userId);
  if (pendingCount >= FLUSH_SIZE) {
    flushReviewQueue().catch((error) => console.warn('Review queue sync failed.', error));
    return;
  }
  scheduleFlush();
}

/** FNV-1a hash — deterministic event ids for gamification idempotency. */
function stableHash(value: string) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

/**
 * Flush ONLY the current session user's queued records. Records belonging to
 * another account on the same device must wait for their owner's session:
 * flushing them under the wrong auth makes Firestore reject them and (for
 * permanent errors) burns their retry budget.
 */
export async function flushReviewQueue(userId?: string) {
  if (isFlushing || (typeof navigator !== 'undefined' && !navigator.onLine)) return;
  const uid = userId ?? auth.currentUser?.uid;
  if (!uid) return;
  isFlushing = true;

  try {
    void pruneSyncedRecords();
    const records = (await getPendingReviewResults(uid)).slice(0, MAX_RECORDS_PER_FLUSH);
    if (records.length === 0) return;

    const syncedIds: string[] = [];
    const syncedRecords: ReviewQueueRecord[] = [];
    const failedIds: string[] = [];
    let lastError: unknown = null;

    for (const chunk of chunkRecords(records)) {
      try {
        const batch = writeBatch(db);
        chunk.forEach((record) => applyRecord(batch, record));
        await batch.commit();
        chunk.forEach((record) => {
          syncedIds.push(record.id);
          syncedRecords.push(record);
        });
      } catch (chunkError) {
        // One bad record must not poison the whole chunk (and, through retry,
        // the whole queue): retry record by record to isolate the failure.
        lastError = chunkError;
        for (const record of chunk) {
          try {
            const batch = writeBatch(db);
            applyRecord(batch, record);
            await batch.commit();
            syncedIds.push(record.id);
            syncedRecords.push(record);
          } catch (recordError) {
            lastError = recordError;
            failedIds.push(record.id);
          }
        }
      }
    }

    if (syncedIds.length > 0) {
      await markReviewResultsSynced(syncedIds);

      // Report real reviewed/correct counts from the records that actually synced.
      const reviewedByUser = new Map<string, { total: number; correct: number; ids: string[] }>();
      syncedRecords.forEach((record) => {
        const entry = reviewedByUser.get(record.userId) || { total: 0, correct: 0, ids: [] };
        entry.total += 1;
        if (record.isCorrect) entry.correct += 1;
        entry.ids.push(record.id);
        reviewedByUser.set(record.userId, entry);
      });

      await Promise.all(
        Array.from(reviewedByUser.entries()).map(([userId, counts]) =>
          trackReviewActivity(userId, {
            cardsReviewed: counts.total,
            correctCount: counts.correct,
            source: 'review_queue',
            // Deterministic id derived from the exact record set: if this
            // flush is replayed (two tabs, ambiguous commit), gamification
            // recognizes the event and does not count it twice.
            eventId: `rq-${userId}-${stableHash([...counts.ids].sort().join(','))}`,
          }).catch((error) => {
            console.warn('Gamification review tracking failed.', error);
          })
        )
      );
    }

    if (failedIds.length > 0) {
      // markReviewResultsFailed increments retryCount and dead-letters records
      // that keep failing, so they stop blocking the queue.
      await markReviewResultsFailed(failedIds, lastError);
      scheduleFlush();
      if (syncedIds.length === 0) {
        throw lastError instanceof Error ? lastError : new Error(String(lastError));
      }
      console.warn(`Review queue: ${failedIds.length} record(s) failed and were re-queued.`, lastError);
    }
  } finally {
    isFlushing = false;
  }
}

if (typeof window !== 'undefined') {
  window.addEventListener('online', () => {
    flushReviewQueue().catch((error) => console.warn('Review queue sync failed.', error));
  });
}
