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

/**
 * One node of the deck hierarchy derived from '::'-separated deck names
 * (the naming Anki imports produce, e.g. 'Chinese::Từ vựng::HSK1').
 * A node may be VIRTUAL (`deck: null`) when decks exist below a path but
 * no deck carries that exact name — e.g. only 'A::B' and 'A::C' exist.
 */
export interface DeckTreeNode<T extends { id: string; name: string }> {
  /** Full '::'-joined path this node represents. */
  name: string;
  /** Last path segment — the short display name. */
  segment: string;
  /** The real deck at this exact path, or null for a virtual parent. */
  deck: T | null;
  children: DeckTreeNode<T>[];
  /** Ids of every real deck in this subtree (this node's deck first). */
  descendantIds: string[];
  /** Real decks in this subtree (this node's deck first). */
  descendantDecks: T[];
}

/**
 * Build the deck tree from a flat deck list. Top-level order follows the
 * input order (callers pass decks newest-first, so a branch surfaces at
 * the position of its newest member); children are sorted by name.
 * Decks whose name has no '::' become childless roots, so a list without
 * any hierarchy yields a flat forest identical to the input.
 */
export function buildDeckTree<T extends { id: string; name: string }>(decks: T[]): DeckTreeNode<T>[] {
  const roots: DeckTreeNode<T>[] = [];
  const byPath = new Map<string, DeckTreeNode<T>>();

  const ensureNode = (path: string, segment: string, siblings: DeckTreeNode<T>[]): DeckTreeNode<T> => {
    const existing = byPath.get(path);
    if (existing) return existing;
    const node: DeckTreeNode<T> = {
      name: path,
      segment,
      deck: null,
      children: [],
      descendantIds: [],
      descendantDecks: [],
    };
    byPath.set(path, node);
    siblings.push(node);
    return node;
  };

  for (const deck of decks) {
    const segments = deck.name.split('::').map((segment) => segment.trim()).filter(Boolean);
    if (segments.length === 0) segments.push(deck.name);

    let siblings = roots;
    let path = '';
    let node: DeckTreeNode<T> | null = null;
    segments.forEach((segment, index) => {
      path = index === 0 ? segment : `${path}::${segment}`;
      node = ensureNode(path, segment, siblings);
      siblings = node.children;
    });

    if (!node) continue;
    if (node.deck) {
      // Two decks share one exact name: keep both visible as separate
      // roots instead of silently dropping one from the list.
      roots.push({
        name: node.name,
        segment: node.segment,
        deck,
        children: [],
        descendantIds: [deck.id],
        descendantDecks: [deck],
      });
    } else {
      node.deck = deck;
    }
  }

  const finalize = (node: DeckTreeNode<T>): void => {
    node.children.sort((a, b) => a.segment.localeCompare(b.segment, 'vi'));
    node.children.forEach(finalize);
    node.descendantDecks = [
      ...(node.deck ? [node.deck] : []),
      ...node.children.flatMap((child) => child.descendantDecks),
    ];
    node.descendantIds = node.descendantDecks.map((deck) => deck.id);
  };
  roots.forEach(finalize);

  return roots;
}

/**
 * Sum per-deck study stats over a set of deck ids (a whole tree branch).
 * `lastStudied` is the most recent value across the branch. Pure read over
 * already-computed stats — no Firestore access.
 */
export function aggregateDeckStats(
  statsById: Record<string, DeckStudyStats | undefined>,
  deckIds: string[],
): DeckStudyStats {
  const total: DeckStudyStats = { learned: 0, mastered: 0, due: 0 };
  for (const deckId of deckIds) {
    const stats = statsById[deckId];
    if (!stats) continue;
    total.learned += stats.learned;
    total.mastered += stats.mastered;
    total.due += stats.due;
    if (
      stats.lastStudied
      && (!total.lastStudied || new Date(stats.lastStudied).getTime() > new Date(total.lastStudied).getTime())
    ) {
      total.lastStudied = stats.lastStudied;
    }
  }
  return total;
}
