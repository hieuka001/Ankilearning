/**
 * Scroll management for route changes — pure decision logic.
 *
 * The app shell scrolls inside a single container (the `[data-scroll-root]`
 * div in App.tsx); the browser window itself never scrolls. React Router
 * does not touch that container, so without this module a page change kept
 * whatever scrollTop the previous page had — a fresh page opened scrolled
 * halfway down. The rules mirror native-app behavior:
 *
 *  - PUSH / REPLACE to a different route → start at the top. Instantly:
 *    a smooth scroll here reads as the page "sliding away" under the user.
 *  - POP (browser Back/Forward) → restore the offset the route was left
 *    at; if none was recorded, start at the top.
 *  - Same route key (a hash-only change, or a PUSH to the page already on
 *    screen) → leave the scroll position alone. Re-tapping the active tab
 *    has its own smooth-scroll-to-top handling in the nav components.
 *
 * A route key is `pathname + search`: `/study/:deckId?decks=…` (group
 * study) is a different screen from the same path without the query, so
 * the query string is part of the route's identity.
 */

export type NavigationKind = 'PUSH' | 'POP' | 'REPLACE';

export type ScrollAction =
  | { type: 'reset' }
  | { type: 'restore'; top: number }
  | { type: 'none' };

export function routeScrollKey(pathname: string, search: string): string {
  return `${pathname}${search}`;
}

export function decideScrollAction(args: {
  navigationType: NavigationKind;
  previousKey: string | null;
  nextKey: string;
  saved: ReadonlyMap<string, number>;
}): ScrollAction {
  const { navigationType, previousKey, nextKey, saved } = args;

  // Same screen (hash-only change or a repeat navigation): not ours to move.
  if (previousKey !== null && previousKey === nextKey) return { type: 'none' };

  if (navigationType === 'POP') {
    const top = saved.get(nextKey);
    // A saved offset of 0 is indistinguishable from "never scrolled" —
    // resetting covers it, so only a positive offset needs a restore.
    if (typeof top === 'number' && top > 0) return { type: 'restore', top };
    return { type: 'reset' };
  }

  return { type: 'reset' };
}

/** Upper bound on remembered routes, so the store cannot grow without limit. */
export const MAX_SAVED_SCROLL_POSITIONS = 50;

/**
 * Record a route's scroll offset. Re-recording an existing key refreshes
 * its recency; once the cap is exceeded the least recently recorded route
 * is evicted. Offsets are stored as non-negative integers.
 */
export function rememberScrollPosition(
  store: Map<string, number>,
  key: string,
  top: number,
): void {
  if (!Number.isFinite(top)) return;
  if (store.has(key)) store.delete(key);
  store.set(key, Math.max(0, Math.floor(top)));
  while (store.size > MAX_SAVED_SCROLL_POSITIONS) {
    const oldest = store.keys().next().value;
    if (oldest === undefined) break;
    store.delete(oldest);
  }
}

const STORAGE_KEY = 'ankilearning:scroll-positions';

/** Minimal storage surface, so tests can pass a fake instead of a DOM Storage. */
export interface ScrollPositionStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/**
 * Load persisted positions (they survive a light reload via sessionStorage).
 * Corrupt payloads and invalid entries are dropped — scroll restoration is
 * a nicety and must never break navigation.
 */
export function loadScrollPositions(
  storage: ScrollPositionStorage | null,
): Map<string, number> {
  const store = new Map<string, number>();
  if (!storage) return store;
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return store;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return store;
    }
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
        store.set(key, Math.floor(value));
      }
    }
    while (store.size > MAX_SAVED_SCROLL_POSITIONS) {
      const oldest = store.keys().next().value;
      if (oldest === undefined) break;
      store.delete(oldest);
    }
  } catch {
    // Storage that throws on read (private mode, embedded webviews) or a
    // corrupt payload: start empty.
    return new Map();
  }
  return store;
}

export function persistScrollPositions(
  storage: ScrollPositionStorage | null,
  store: ReadonlyMap<string, number>,
): void {
  if (!storage) return;
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(store)));
  } catch {
    // Quota / privacy-mode write failures are non-fatal: positions simply
    // will not survive a reload.
  }
}
