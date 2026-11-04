/**
 * Cloze deletion helpers (Anki-style `{{cN::answer::hint}}` markup).
 *
 * Contract shared with the card model (Flashcard.cardType === 'cloze'):
 * a cloze NOTE stores its full source text in `clozeText`; each physical
 * card carries one `clozeIndex` — the deletion the learner must recall on
 * that card. The other deletions in the same text are shown with their
 * answers filled in, exactly like Anki.
 *
 * NOTE (round 1B): this file was created by the study-display workstream
 * because the model workstream had not landed it yet. If the model
 * workstream ships its own version, merge on these signatures:
 *   parseClozeText(text) / clozeToPlainText(text)
 *   renderClozeFront(text, index) / renderClozeBack(text, index)
 *
 * Rendering assumption: `clozeText` is PLAIN text with cloze markup.
 * renderCloze* escape every literal segment, so embedded HTML is shown
 * as text, never interpreted. Callers still run the result through the
 * DOMPurify sanitizer before injecting it (ReviewCard does).
 */

export interface ClozeDeletion {
  /** The N in {{cN::...}} — 1-based, matching Anki. */
  index: number;
  /** The hidden answer text. */
  answer: string;
  /** Optional hint after the second `::`, when present. */
  hint?: string;
}

export interface ParsedClozeText {
  /** The original source text, unchanged. */
  source: string;
  /** Unique cloze indexes present, ascending. */
  indexes: number[];
  /** Every well-formed deletion, in order of appearance. */
  deletions: ClozeDeletion[];
  /** True when at least one well-formed deletion was found. */
  valid: boolean;
}

const clozePattern = /\{\{c(\d+)::([\s\S]*?)\}\}/g;

function splitAnswerHint(inner: string): { answer: string; hint?: string } {
  const separator = inner.indexOf('::');
  if (separator === -1) return { answer: inner };
  return { answer: inner.slice(0, separator), hint: inner.slice(separator + 2) };
}

/**
 * Parse every well-formed `{{cN::answer(::hint)?}}` deletion in `text`.
 * Malformed fragments (unclosed, missing index) are ignored — they are
 * treated as literal text by the renderers, never as a crash.
 */
export function parseClozeText(text: string): ParsedClozeText {
  const deletions: ClozeDeletion[] = [];
  if (typeof text === 'string' && text) {
    for (const match of text.matchAll(clozePattern)) {
      const index = Number.parseInt(match[1], 10);
      if (!Number.isFinite(index) || index < 1) continue;
      const { answer, hint } = splitAnswerHint(match[2]);
      deletions.push(hint ? { index, answer, hint } : { index, answer });
    }
  }
  const indexes = [...new Set(deletions.map((deletion) => deletion.index))].sort((a, b) => a - b);
  return { source: typeof text === 'string' ? text : '', indexes, deletions, valid: deletions.length > 0 };
}

/**
 * The full text with every deletion replaced by its answer — the natural
 * reading form, used for TTS and anywhere raw `{{...}}` must not leak.
 */
export function clozeToPlainText(text: string): string {
  if (typeof text !== 'string' || !text) return '';
  return text.replace(clozePattern, (_match, rawIndex: string, inner: string) => {
    const index = Number.parseInt(rawIndex, 10);
    if (!Number.isFinite(index) || index < 1) return _match;
    return splitAnswerHint(inner).answer;
  });
}

const escapeHtml = (value: string) =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');

const escapeTextSegment = (value: string) => escapeHtml(value).replace(/\n/g, '<br />');

const blankClassName =
  'cloze-blank rounded-md bg-zinc-200 px-2 py-0.5 font-semibold text-zinc-500 dark:bg-white/10 dark:text-zinc-300';
const answerClassName =
  'cloze-answer rounded-md bg-emerald-200 px-1.5 py-0.5 font-bold text-emerald-900 dark:bg-emerald-500/30 dark:text-emerald-100';

type ClozeRenderMode = 'front' | 'back';

function renderCloze(text: string, activeIndex: number, mode: ClozeRenderMode): string {
  if (typeof text !== 'string' || !text) return '';
  let html = '';
  let lastIndex = 0;

  for (const match of text.matchAll(clozePattern)) {
    const index = Number.parseInt(match[1], 10);
    if (!Number.isFinite(index) || index < 1) continue;
    const offset = match.index ?? 0;
    html += escapeTextSegment(text.slice(lastIndex, offset));
    const { answer, hint } = splitAnswerHint(match[2]);
    if (index === activeIndex && mode === 'front') {
      html += `<span class="${blankClassName}">[${hint ? escapeHtml(hint) : '...'}]</span>`;
    } else if (index === activeIndex && mode === 'back') {
      html += `<mark class="${answerClassName}">${escapeTextSegment(answer)}</mark>`;
    } else {
      // Sibling deletions are always shown with their answers (Anki behaviour).
      html += escapeTextSegment(answer);
    }
    lastIndex = offset + match[0].length;
  }

  html += escapeTextSegment(text.slice(lastIndex));
  return html;
}

/**
 * Front of the card for `activeIndex`: that deletion is blanked out
 * (`[...]` or `[hint]`), every other deletion shows its answer.
 * Returns HTML — sanitize before injecting (ReviewCard already does).
 */
export function renderClozeFront(text: string, activeIndex: number): string {
  return renderCloze(text, activeIndex, 'front');
}

/**
 * Back of the card for `activeIndex`: that deletion's answer is filled in
 * and highlighted; every other deletion shows its answer as on the front.
 * Returns HTML — sanitize before injecting (ReviewCard already does).
 */
export function renderClozeBack(text: string, activeIndex: number): string {
  return renderCloze(text, activeIndex, 'back');
}

// ---------------------------------------------------------------------------
// Creation-side helpers (round 1A — card editors in CreateDeck/DeckDetail).
// Added without touching the signatures above, which the study-display
// workstream already depends on.
// ---------------------------------------------------------------------------

/** Next unused cloze index (for the "mark as cloze" action, auto-incrementing N). */
export function getNextClozeIndex(text: string): number {
  const { indexes } = parseClozeText(typeof text === 'string' ? text : '');
  return indexes.length === 0 ? 1 : Math.max(...indexes) + 1;
}

/**
 * Validate a cloze source text before saving. Returns Vietnamese error
 * messages (empty array = valid). A text with no deletion at all is invalid
 * because it would generate zero cards.
 */
export function validateClozeText(text: string): string[] {
  const errors: string[] = [];
  if (typeof text !== 'string' || !text.trim()) {
    return ['Văn bản cloze đang trống.'];
  }

  const { deletions } = parseClozeText(text);
  const matchedStarts = new Set<number>();
  for (const match of text.matchAll(clozePattern)) {
    const index = Number.parseInt(match[1], 10);
    if (Number.isFinite(index) && index >= 1) matchedStarts.add(match.index ?? 0);
  }

  // Every "{{c" opening must belong to a well-formed deletion.
  for (const opening of text.matchAll(/\{\{c/g)) {
    const at = opening.index ?? 0;
    if (matchedStarts.has(at)) continue;
    const rest = text.slice(at);
    if (/^\{\{c0+::/.test(rest)) {
      errors.push('Chỉ số cloze phải bắt đầu từ 1 (không dùng {{c0::...}}).');
    } else if (/^\{\{c\d+::/.test(rest)) {
      errors.push(`Đoạn cloze ở vị trí ${at + 1} chưa được đóng bằng "}}".`);
    } else if (/^\{\{c\d+/.test(rest)) {
      errors.push(`Đoạn cloze ở vị trí ${at + 1} thiếu "::" sau chỉ số (đúng dạng: {{c1::đáp án}}).`);
    } else {
      errors.push(`Cú pháp cloze ở vị trí ${at + 1} không hợp lệ — chỉ số phải là số (đúng dạng: {{c1::đáp án}}).`);
    }
  }

  deletions.forEach((deletion) => {
    if (!deletion.answer.trim()) {
      errors.push(`Đoạn cloze c${deletion.index} đang trống đáp án.`);
    }
    if (deletion.answer.includes('{{c')) {
      errors.push(`Đoạn cloze c${deletion.index} chứa cloze lồng nhau — Anki không hỗ trợ.`);
    }
  });

  if (deletions.length === 0 && errors.length === 0) {
    errors.push('Chưa có đoạn cloze nào — hãy bôi đen một đoạn rồi bấm "Đánh dấu cloze".');
  }
  return [...new Set(errors)];
}

/**
 * Wrap the [start, end) selection of `text` as a new cloze deletion with the
 * next auto-incremented index. Returns null when the selection is empty.
 */
export function wrapSelectionAsCloze(text: string, start: number, end: number): string | null {
  if (typeof text !== 'string' || start < 0 || end > text.length || start >= end) return null;
  const selected = text.slice(start, end);
  if (!selected.trim()) return null;
  const index = getNextClozeIndex(text);
  return `${text.slice(0, start)}{{c${index}::${selected}}}${text.slice(end)}`;
}
