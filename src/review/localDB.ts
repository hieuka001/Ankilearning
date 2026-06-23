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
  status: 'pending' | 'synced' | 'failed';
  createdAt: string;
  syncedAt?: string;
  error?: string;
}

export interface GamificationQueueRecord {
  id: string;
  userId: string;
  kind: 'review' | 'quiz';
  payload: Record<string, unknown>;
  timezone: string;
  status: 'pending' | 'synced';
  createdAt: string;
  syncedAt?: string;
  error?: string;
}

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
  await localDB.reviewResults.put(record);
}

export async function getPendingReviewResults() {
  return localDB.reviewResults.where('status').equals('pending').sortBy('createdAt');
}

export async function countPendingReviewResults() {
  return localDB.reviewResults.where('status').equals('pending').count();
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
  await localDB.transaction('rw', localDB.reviewResults, async () => {
    await Promise.all(ids.map((id) => localDB.reviewResults.update(id, {
      status: 'pending',
      error: error instanceof Error ? error.message : String(error),
    })));
  });
}

export async function saveGamificationEvent(record: GamificationQueueRecord) {
  await localDB.gamificationEvents.put(record);
}

export async function getPendingGamificationEvents() {
  return localDB.gamificationEvents.where('status').equals('pending').sortBy('createdAt');
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
  await localDB.gamificationEvents.update(id, {
    status: 'pending',
    error: error instanceof Error ? error.message : String(error),
  });
}
