import { collection, getDocs } from 'firebase/firestore';
import { startOfDay } from 'date-fns';
import { db } from '../firebase';
import { getCardDueDate, isCardDue } from './spacedRepetition';

export interface DeckInsights {
  dueCount: number;
  forecastByDay: Map<number, number>;
}

/**
 * Raw card record as read from Firestore (loose shape — the stats/insights
 * helpers only read schedule fields).
 */
export type DeckCardRecord = Record<string, any> & { id: string };

/**
 * Module-level cache of a deck's card list, keyed by a cheap signature of
 * the deck document. Deck/doc snapshots fire on ANY change to the deck
 * document; without this cache every snapshot re-read the ENTIRE cards
 * subcollection of every deck just to recompute three counters. Entries
 * are reused while the signature matches; a short TTL bounds how stale the
 * numbers can get when card writes do not touch the deck document (e.g.
 * after a study session in another tab). `invalidateDeckCardsCache()`
 * forces a fresh read (Decks "Làm mới" button).
 */
const DECK_CARDS_CACHE_TTL_MS = 5 * 60 * 1000;

interface DeckCardsCacheEntry {
  signature: string;
  cards: DeckCardRecord[];
  fetchedAt: number;
}

const deckCardsCache = new Map<string, DeckCardsCacheEntry>();

export function getDeckCacheSignature(deck: {
  updatedAt?: string;
  createdAt?: string;
  cardCount?: number;
}): string {
  return [deck.updatedAt || '', deck.createdAt || '', deck.cardCount ?? ''].join('|');
}

export async function fetchDeckCardsCached(
  deckId: string,
  signature: string,
): Promise<DeckCardRecord[]> {
  const cached = deckCardsCache.get(deckId);
  if (
    cached
    && cached.signature === signature
    && Date.now() - cached.fetchedAt < DECK_CARDS_CACHE_TTL_MS
  ) {
    return cached.cards;
  }

  const cardsSnap = await getDocs(collection(db, `decks/${deckId}/cards`));
  const cards = cardsSnap.docs.map(
    (cardDoc) => ({ id: cardDoc.id, ...cardDoc.data() }) as DeckCardRecord,
  );
  deckCardsCache.set(deckId, { signature, cards, fetchedAt: Date.now() });
  return cards;
}

export function invalidateDeckCardsCache(deckId?: string) {
  if (deckId) {
    deckCardsCache.delete(deckId);
  } else {
    deckCardsCache.clear();
  }
}

export interface DeckStudyStats {
  learned: number;
  mastered: number;
  due: number;
  lastStudied?: string;
}

export function computeDeckStudyStats(cards: DeckCardRecord[]): DeckStudyStats {
  const learned = cards.filter(
    (card) => (card.reps || card.repetitions || 0) > 0 || card.state === 'review',
  ).length;
  const mastered = cards.filter((card) => card.state === 'review').length;
  const due = cards.filter((card) => isCardDue(card)).length;
  const lastStudied = cards
    .map((card) => (typeof card.lastReview === 'string' ? card.lastReview : card.lastReview?.reviewTime))
    .filter(Boolean)
    .sort((a, b) => new Date(String(b)).getTime() - new Date(String(a)).getTime())[0];

  return { learned, mastered, due, lastStudied };
}

export async function fetchDeckInsights(
  deckId: string,
  forecastDayKeys: Set<number>,
  signature?: string,
): Promise<DeckInsights> {
  const forecastByDay = new Map<number, number>();
  forecastDayKeys.forEach((dayKey) => forecastByDay.set(dayKey, 0));

  const cards = signature !== undefined
    ? await fetchDeckCardsCached(deckId, signature)
    : (await getDocs(collection(db, `decks/${deckId}/cards`))).docs.map(
        (cardDoc) => ({ id: cardDoc.id, ...cardDoc.data() }) as DeckCardRecord,
      );
  let dueCount = 0;

  cards.forEach((data) => {
    if (isCardDue(data)) dueCount += 1;

    if (!data.dueDate && !data.nextReview) return;

    const reviewDay = startOfDay(new Date(getCardDueDate(data))).getTime();
    if (forecastByDay.has(reviewDay)) {
      forecastByDay.set(reviewDay, (forecastByDay.get(reviewDay) || 0) + 1);
    }
  });

  return { dueCount, forecastByDay };
}

export interface DeckInsightsRef {
  id: string;
  signature?: string;
}

export async function fetchMultipleDeckInsights(
  decks: Array<string | DeckInsightsRef>,
  forecastDayKeys: Set<number>,
): Promise<Map<string, DeckInsights>> {
  const entries = await Promise.all(
    decks.map(async (deck) => {
      const ref = typeof deck === 'string' ? { id: deck } : deck;
      return [ref.id, await fetchDeckInsights(ref.id, forecastDayKeys, ref.signature)] as const;
    }),
  );

  return new Map(entries);
}

export function mergeForecastCounts(
  insights: Iterable<DeckInsights>,
  forecastDayKeys: number[],
): number[] {
  const totals = forecastDayKeys.map(() => 0);

  for (const insight of insights) {
    forecastDayKeys.forEach((dayKey, index) => {
      totals[index] += insight.forecastByDay.get(dayKey) || 0;
    });
  }

  return totals;
}
