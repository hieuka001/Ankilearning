import { collection, getDocs, query, where } from 'firebase/firestore';
import { auth, db } from '../firebase';
import type { StudyReminderSettings } from '../types';
import { fetchDeckCardsCached, getDeckCacheSignature, type DeckCardRecord } from './deckAnalytics';
import { isDesktopShell } from './isDesktop';
import { getCardDueDate } from './spacedRepetition';

/**
 * Hands the study-reminder schedule to the native shell (Tauri desktop /
 * iOS) so the SHELL can post local notifications on the device. A web page
 * inside a webview cannot schedule OS notifications itself, so App /
 * Settings push the next days' due counts through the one channel the
 * shell listens on: a fire-and-forget navigation to
 * `ankilearning://reminders#d=<base64url(JSON)>` (a hidden anchor click —
 * the page itself never navigates away).
 *
 * Payload contract (owned together with the shell):
 *   {"v":1,"items":[{"at":"YYYY-MM-DDTHH:MM:00","title":"AnkiLearning",
 *                     "body":"Hôm nay có X thẻ đến hạn ôn tập"}, ...]}
 * `at` is DEVICE-LOCAL time (no zone suffix); the shell schedules in the
 * device's own timezone, so `config.timezone` is not applied here. At most
 * 20 items, today → +13 days, only days that still have a future reminder
 * instant and at least one due card.
 *
 * Outside the shell (regular browser / PWA) every entry point is a no-op.
 */

export interface ShellReminderItem {
  at: string;
  title: string;
  body: string;
}

export interface ShellReminderCardLike {
  dueDate?: string;
  nextReview?: string;
  suspended?: boolean;
}

const HASH_STORAGE_KEY = 'ankilearning:reminders-hash';
const MAX_ITEMS = 20;
const WINDOW_DAYS = 14; // today + 13

function startOfLocalDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

function formatLocalDateTime(date: Date): string {
  return (
    `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}` +
    `T${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`
  );
}

function parseReminderTime(time: string | undefined): { hours: number; minutes: number } {
  const match = /^(\d{1,2}):(\d{2})/.exec(time || '');
  if (!match) return { hours: 21, minutes: 0 };
  const hours = Math.min(23, Math.max(0, Number(match[1])));
  const minutes = Math.min(59, Math.max(0, Number(match[2])));
  return { hours, minutes };
}

/**
 * Pure builder (unit-tested): bucket cards by due day — overdue cards fold
 * into today — and emit one reminder per day whose reminder instant is
 * still in the future. Mirrors the forecast semantics of deckAnalytics:
 * cards without any schedule field do not count, suspended cards never do.
 */
export function buildShellReminderItems(
  cards: ShellReminderCardLike[],
  config: Pick<StudyReminderSettings, 'time'>,
  now: Date = new Date(),
): ShellReminderItem[] {
  const { hours, minutes } = parseReminderTime(config.time);
  const todayStart = startOfLocalDay(now).getTime();
  const counts = new Array<number>(WINDOW_DAYS).fill(0);

  for (const card of cards) {
    if (card.suspended) continue;
    if (!card.dueDate && !card.nextReview) continue;

    const due = new Date(getCardDueDate(card));
    if (!Number.isFinite(due.getTime())) continue;

    const dueDayStart = startOfLocalDay(due).getTime();
    // Round (not floor) so DST-shifted midnights still land on whole days.
    const offset = Math.round((dueDayStart - todayStart) / 86_400_000);
    const bucket = offset <= 0 ? 0 : offset;
    if (bucket < WINDOW_DAYS) counts[bucket] += 1;
  }

  const items: ShellReminderItem[] = [];
  for (let offset = 0; offset < WINDOW_DAYS && items.length < MAX_ITEMS; offset += 1) {
    const count = counts[offset];
    if (count <= 0) continue;

    const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset);
    const at = new Date(day.getFullYear(), day.getMonth(), day.getDate(), hours, minutes, 0);
    if (at.getTime() <= now.getTime()) continue;

    const body =
      offset === 0
        ? `Hôm nay có ${count} thẻ đến hạn ôn tập`
        : offset === 1
          ? `Ngày mai có ${count} thẻ đến hạn ôn tập`
          : `Có ${count} thẻ đến hạn vào ngày ${pad2(day.getDate())}/${pad2(day.getMonth() + 1)}`;

    items.push({ at: formatLocalDateTime(at), title: 'AnkiLearning', body });
  }

  return items;
}

/** JSON → base64url, UTF-8 safe (Vietnamese bodies) via TextEncoder. */
export function encodeShellRemindersPayload(payload: unknown): string {
  const json = JSON.stringify(payload);
  const bytes = new TextEncoder().encode(json);
  let binary = '';
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function buildShellRemindersUrl(items: ShellReminderItem[]): string {
  return `ankilearning://reminders#d=${encodeShellRemindersPayload({ v: 1, items })}`;
}

/** Small FNV-1a hash — only used to detect payload changes, not security. */
function hashPayload(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16);
}

/**
 * Loads every card of every deck the user owns — the same access pattern
 * Dashboard/Decks use (`ownerId == uid`, cards via the shared deckAnalytics
 * cache so this rarely costs extra Firestore reads).
 */
async function loadAllUserCards(uid: string): Promise<DeckCardRecord[]> {
  const decksSnap = await getDocs(query(collection(db, 'decks'), where('ownerId', '==', uid)));
  const perDeck = await Promise.all(
    decksSnap.docs.map((deckDoc) =>
      fetchDeckCardsCached(deckDoc.id, getDeckCacheSignature(deckDoc.data())),
    ),
  );
  return perDeck.flat();
}

export interface SyncShellRemindersOptions {
  force?: boolean;
}

/**
 * Pushes the current reminder schedule to the shell. Pass the already
 * loaded card list when the caller has one; pass `null` to load all of the
 * signed-in user's cards internally. No-ops outside the shell, when the
 * reminder is disabled, or when the payload is unchanged (unless `force`).
 */
export async function syncShellReminders(
  cards: ShellReminderCardLike[] | null,
  config: StudyReminderSettings | null | undefined,
  options: SyncShellRemindersOptions = {},
): Promise<void> {
  if (!config?.enabled) return;
  if (!isDesktopShell()) return;
  // Shell-side scheduling only exists on mobile (iOS): the notification
  // plugin fires immediately on desktop, so only sync from the iOS shell.
  const navPlatform = typeof navigator !== 'undefined' ? navigator.platform || '' : '';
  const isMobileShell =
    /^(iPhone|iPad|iPod)/.test(navPlatform) ||
    (navPlatform === 'MacIntel' && typeof navigator !== 'undefined' && navigator.maxTouchPoints > 1) ||
    // Android WebView reports an ARM Linux platform; desktop Linux is x86_64.
    /^Linux (arm|aarch)/.test(navPlatform);
  if (!isMobileShell) return;

  let cardList = cards;
  if (!cardList) {
    const uid = auth.currentUser?.uid;
    if (!uid) return;
    try {
      // DeckCardRecord is a loose Firestore record; the builder only reads
      // the schedule fields declared on ShellReminderCardLike.
      cardList = (await loadAllUserCards(uid)) as ShellReminderCardLike[];
    } catch {
      return; // Offline / permission hiccup — the next app start retries.
    }
  }

  const items = buildShellReminderItems(cardList, config);
  const payloadJson = JSON.stringify({ v: 1, items });
  const hash = hashPayload(payloadJson);

  if (!options.force) {
    try {
      if (window.localStorage.getItem(HASH_STORAGE_KEY) === hash) return;
    } catch {
      // Storage unavailable — fall through and send anyway.
    }
  }

  try {
    const anchor = document.createElement('a');
    anchor.href = buildShellRemindersUrl(items);
    anchor.style.display = 'none';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  } catch {
    return;
  }

  try {
    window.localStorage.setItem(HASH_STORAGE_KEY, hash);
  } catch {
    // Non-fatal: dedupe just will not persist across restarts.
  }
}
