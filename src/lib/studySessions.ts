import { format, startOfDay } from 'date-fns';
import type { StudySession } from '../types';

export function buildSessionCountByDay(sessions: StudySession[]): Map<string, number> {
  const counts = new Map<string, number>();

  sessions.forEach((session) => {
    const key = format(new Date(session.timestamp), 'yyyy-MM-dd');
    counts.set(key, (counts.get(key) || 0) + 1);
  });

  return counts;
}

export function countCardsReviewedToday(sessions: StudySession[], today = new Date()): number {
  const todayStart = startOfDay(today).getTime();

  return sessions.reduce((sum, session) => {
    const sessionDay = startOfDay(new Date(session.timestamp)).getTime();
    return sessionDay === todayStart ? sum + session.cardsReviewed : sum;
  }, 0);
}
