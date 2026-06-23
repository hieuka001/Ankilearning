import { collection, getDocs } from 'firebase/firestore';
import { startOfDay } from 'date-fns';
import { db } from '../firebase';
import { getCardDueDate, isCardDue } from './spacedRepetition';

export interface DeckInsights {
  dueCount: number;
  forecastByDay: Map<number, number>;
}

export async function fetchDeckInsights(
  deckId: string,
  forecastDayKeys: Set<number>,
): Promise<DeckInsights> {
  const forecastByDay = new Map<number, number>();
  forecastDayKeys.forEach((dayKey) => forecastByDay.set(dayKey, 0));

  const cardsSnap = await getDocs(collection(db, `decks/${deckId}/cards`));
  let dueCount = 0;

  cardsSnap.docs.forEach((cardDoc) => {
    const data = cardDoc.data();
    if (isCardDue(data)) dueCount += 1;

    if (!data.dueDate && !data.nextReview) return;

    const reviewDay = startOfDay(new Date(getCardDueDate(data))).getTime();
    if (forecastByDay.has(reviewDay)) {
      forecastByDay.set(reviewDay, (forecastByDay.get(reviewDay) || 0) + 1);
    }
  });

  return { dueCount, forecastByDay };
}

export async function fetchMultipleDeckInsights(
  deckIds: string[],
  forecastDayKeys: Set<number>,
): Promise<Map<string, DeckInsights>> {
  const entries = await Promise.all(
    deckIds.map(async (deckId) => [deckId, await fetchDeckInsights(deckId, forecastDayKeys)] as const),
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
