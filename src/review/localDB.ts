import Dexie, { type Table } from 'dexie';
import type { Flashcard, ReviewLog } from '../types';

export interface CachedCardRecord extends Flashcard {
  cacheKey: string;
  userId: string;
  cardId: string;
  cachedAt: string;
}

export interface ReviewQueueRecord {
  id: string;
  userId: string;
  deckId: string;
  cardId: string;
  sourceDeckOwnerId: string;
  isOwnerReview: boolean;
  isCorrect: boolean;
  schedulerUpdate: Partial<Flashcard>;
  historyEntry: ReviewLog;
  status: 'pending' | 'synced' | 'failed' | 'dead';
  createdAt: string;
  syncedAt?: string;
  error?: string;
  /** Number of failed flush attempts. Records reaching MAX_REVIEW_RETRY_COUNT become 'dead'. */
  retryCount?: number;
}

export interface GamificationQueueRecord {
  id: string;
  userId: string;
  kind: 'review' | 'quiz';
  payload: Record<string, unknown>;
  timezone: string;
  status: 'pending' | 'synced' | 'dead';
  createdAt: string;
  syncedAt?: string;
  error?: string;
  /** Number of failed flush attempts. Events reaching MAX_GAMIFICATION_ATTEMPTS become 'dead'. */
  attempts?: number;
}

/** A pending review record is abandoned (dead-lettered) after this many failed flush attempts. */
export const MAX_REVIEW_RETRY_COUNT = 5;
/** A pending gamification event is abandoned after this many failed flush attempts. */
export const MAX_GAMIFICATION_ATTEMPTS = 3;

class LearningCardDB extends Dexie {
  cards!: Table<CachedCardRecord, string>;
  reviewResults!: Table<ReviewQueueRecord, string>;
  gamificationEvents!: Table<GamificationQueueRecord, string>;

  constructor() {
    super('learning-card-review-cache');
    this.version(1).stores({
      cards: '&cacheKey,userId,deckId,cardId,state,dueDate,nextReview,cachedAt',
      reviewResults: '&id,userId,deckId,cardId,status,createdAt',
    });
    this.version(2).stores({
      cards: '&cacheKey,userId,deckId,cardId,state,dueDate,nextReview,cachedAt',
      reviewResults: '&id,userId,deckId,cardId,status,createdAt',
      gamificationEvents: '&id,userId,kind,status,createdAt',
    });
    // v3: retry bookkeeping for the sync outboxes (retryCount / attempts).
    // Schema (indexes) is unchanged; the upgrade only backfills the new fields
    // so existing queued records keep working.
    this.version(3).stores({
      cards: '&cacheKey,userId,deckId,cardId,state,dueDate,nextReview,cachedAt',
      reviewResults: '&id,userId,deckId,cardId,status,createdAt',
      gamificationEvents: '&id,userId,kind,status,createdAt',
    }).upgrade(async (tx) => {
      await tx.table('reviewResults').toCollection().modify((record: ReviewQueueRecord) => {
        if (record.retryCount === undefined) record.retryCount = 0;
      });
      await tx.table('gamificationEvents').toCollection().modify((record: GamificationQueueRecord) => {
        if (record.attempts === undefined) record.attempts = 0;
      });
    });
  }
}

export const localDB = new LearningCardDB();

export const cardCacheKey = (userId: string, deckId: string, cardId: string) =>
  `${userId}::${deckId}::${cardId}`;

export async function cacheCards(userId: string, deckId: string, cards: Flashcard[]) {
  const cachedAt = new Date().toISOString();
  await localDB.cards.bulkPut(cards.map((card) => ({
    ...card,
    cacheKey: cardCacheKey(userId, deckId, card.id),
    userId,
    cardId: card.id,
    deckId,
    cachedAt,
  })));
}

export async function getCachedCards(userId: string, deckId: string) {
  return localDB.cards
    .where('deckId')
    .equals(deckId)
    .and((card) => card.userId === userId)
    .toArray();
}

export async function upsertCachedCard(userId: string, deckId: string, card: Flashcard) {
  await localDB.cards.put({
    ...card,
    cacheKey: cardCacheKey(userId, deckId, card.id),
    userId,
    cardId: card.id,
    deckId,
    cachedAt: new Date().toISOString(),
  });
}

export async function saveReviewResult(record: ReviewQueueRecord) {
  await localDB.reviewResults.put({ retryCount: 0, ...record });
}

export async function getPendingReviewResults(userId?: string) {
  const records = await localDB.reviewResults.where('status').equals('pending').sortBy('createdAt');
  return userId ? records.filter((record) => record.userId === userId) : records;
}

export async function countPendingReviewResults(userId?: string) {
  if (!userId) {
    return localDB.reviewResults.where('status').equals('pending').count();
  }
  const records = await localDB.reviewResults.where('status').equals('pending').toArray();
  return records.filter((record) => record.userId === userId).length;
}

/** Records that exhausted their retries and will no longer be flushed. Surfaced for UI reporting. */
export async function countDeadReviewResults() {
  return localDB.reviewResults.where('status').equals('dead').count();
}

export async function getDeadReviewResults() {
  return localDB.reviewResults.where('status').equals('dead').sortBy('createdAt');
}

export async function markReviewResultsSynced(ids: string[]) {
  const syncedAt = new Date().toISOString();
  await localDB.transaction('rw', localDB.reviewResults, async () => {
    await Promise.all(ids.map((id) => localDB.reviewResults.update(id, {
      status: 'synced',
      syncedAt,
      error: undefined,
    })));
  });
}

export async function markReviewResultsFailed(ids: string[], error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  await localDB.transaction('rw', localDB.reviewResults, async () => {
    await Promise.all(ids.map(async (id) => {
      const record = await localDB.reviewResults.get(id);
      if (!record || record.status === 'synced' || record.status === 'dead') return;
      const retryCount = (record.retryCount ?? 0) + 1;
      await localDB.reviewResults.update(id, {
        retryCount,
        status: retryCount >= MAX_REVIEW_RETRY_COUNT ? 'dead' : 'pending',
        error: message,
      });
    }));
  });
}

/** Wipe every local cache table (cards, review outbox, gamification outbox). Call on logout. */
export async function clearReviewCache() {
  await Promise.all([
    localDB.cards.clear(),
    localDB.reviewResults.clear(),
    localDB.gamificationEvents.clear(),
  ]);
}

export async function saveGamificationEvent(record: GamificationQueueRecord) {
  await localDB.gamificationEvents.put({ attempts: 0, ...record });
}

export async function getPendingGamificationEvents() {
  return localDB.gamificationEvents.where('status').equals('pending').sortBy('createdAt');
}

export async function countDeadGamificationEvents() {
  return localDB.gamificationEvents.where('status').equals('dead').count();
}

export async function markGamificationEventsSynced(ids: string[]) {
  const syncedAt = new Date().toISOString();
  await localDB.transaction('rw', localDB.gamificationEvents, async () => {
    await Promise.all(ids.map((id) => localDB.gamificationEvents.update(id, {
      status: 'synced',
      syncedAt,
      error: undefined,
    })));
  });
}

export async function markGamificationEventFailed(id: string, error: unknown) {
  const record = await localDB.gamificationEvents.get(id);
  if (!record || record.status === 'synced' || record.status === 'dead') return;
  const attempts = (record.attempts ?? 0) + 1;
  await localDB.gamificationEvents.update(id, {
    attempts,
    status: attempts >= MAX_GAMIFICATION_ATTEMPTS ? 'dead' : 'pending',
    error: error instanceof Error ? error.message : String(error),
  });
}
