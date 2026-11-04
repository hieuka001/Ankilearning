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

/**
 * Error codes that describe a TRANSIENT failure (network flapping, Firestore
 * 5xx/unavailable, an auth token mid-refresh). Transient failures must NOT
 * burn the dead-letter budget: a one-minute Firestore wobble would otherwise
 * permanently kill queued records after a handful of dense flush triggers.
 * Only permanent errors (permission-denied, invalid-argument, ...) count
 * toward MAX_REVIEW_RETRY_COUNT / MAX_GAMIFICATION_ATTEMPTS.
 */
const TRANSIENT_ERROR_CODES = new Set([
  'unavailable',
  'deadline-exceeded',
  'aborted',
  'cancelled',
  'unknown',
  'internal',
  'resource-exhausted',
  'auth/network-request-failed',
  'auth/id-token-expired',
  'auth/user-token-expired',
  'auth/internal-error',
  'storage/retry-limit-exceeded',
]);

const TRANSIENT_MESSAGE_PATTERN =
  /offline|network|failed to fetch|fetch failed|timeout|timed out|temporar|connection|econn|socket/i;

export function isTransientSyncError(error: unknown): boolean {
  if (typeof navigator !== 'undefined' && !navigator.onLine) return true;
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === 'string') {
    const bare = code.includes('/') ? code.slice(code.lastIndexOf('/') + 1) : code;
    if (TRANSIENT_ERROR_CODES.has(code) || TRANSIENT_ERROR_CODES.has(bare)) return true;
    // Known-permanent codes win over message heuristics below.
    if (bare === 'permission-denied' || bare === 'invalid-argument' || bare === 'not-found'
      || bare === 'already-exists' || bare === 'failed-precondition' || bare === 'out-of-range'
      || bare === 'unauthenticated') {
      return false;
    }
  }
  const message = error instanceof Error ? error.message : String(error ?? '');
  return TRANSIENT_MESSAGE_PATTERN.test(message);
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
  // Transient failures (offline, Firestore unavailable, token refresh) keep
  // the record pending WITHOUT consuming its dead-letter budget.
  const transient = isTransientSyncError(error);
  await localDB.transaction('rw', localDB.reviewResults, async () => {
    await Promise.all(ids.map(async (id) => {
      const record = await localDB.reviewResults.get(id);
      if (!record || record.status === 'synced' || record.status === 'dead') return;
      if (transient) {
        await localDB.reviewResults.update(id, { error: message });
        return;
      }
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

export async function getPendingGamificationEvents(userId?: string) {
  const events = await localDB.gamificationEvents.where('status').equals('pending').sortBy('createdAt');
  return userId ? events.filter((event) => event.userId === userId) : events;
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
  const message = error instanceof Error ? error.message : String(error);
  // Same rule as review records: transient errors do not burn attempts.
  if (isTransientSyncError(error)) {
    await localDB.gamificationEvents.update(id, { error: message });
    return;
  }
  const attempts = (record.attempts ?? 0) + 1;
  await localDB.gamificationEvents.update(id, {
    attempts,
    status: attempts >= MAX_GAMIFICATION_ATTEMPTS ? 'dead' : 'pending',
    error: message,
  });
}

/** Synced outbox records older than this are deleted so IndexedDB stays bounded. */
const SYNCED_PRUNE_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const PRUNE_INTERVAL_MS = 60 * 60 * 1000;
let lastPruneAt = 0;

/**
 * Delete 'synced' review/gamification records older than 7 days. Called from
 * the flush paths; self-throttles to at most one run per hour per session and
 * never throws into the caller.
 */
export async function pruneSyncedRecords() {
  const now = Date.now();
  if (now - lastPruneAt < PRUNE_INTERVAL_MS) return;
  lastPruneAt = now;
  const cutoff = new Date(now - SYNCED_PRUNE_AGE_MS).toISOString();
  const isStale = (record: { syncedAt?: string }) => !!record.syncedAt && record.syncedAt < cutoff;
  try {
    await Promise.all([
      localDB.reviewResults.where('status').equals('synced').and(isStale).delete(),
      localDB.gamificationEvents.where('status').equals('synced').and(isStale).delete(),
    ]);
  } catch (error) {
    console.warn('Synced-record prune failed.', error);
  }
}
