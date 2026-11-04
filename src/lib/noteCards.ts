import { clozeToPlainText, parseClozeText, validateClozeText } from '../review/cloze';

/**
 * Biến một ghi chú (note) do người dùng soạn thành các thẻ vật lý theo hợp
 * đồng dữ liệu đợt 1A:
 * - basic:    1 thẻ front/back như cũ.
 * - reversed: 2 thẻ cùng noteId — một thẻ gốc, một thẻ hoán đổi front↔back.
 * - cloze:    mỗi chỉ số cloze phân biệt trong clozeText sinh 1 thẻ cùng
 *             noteId, mang clozeText gốc + clozeIndex của nó; front/back của
 *             thẻ là clozeText đã bỏ cú pháp {{}} (đáp án dạng văn bản thường)
 *             để danh sách/tìm kiếm hiển thị được — việc ẩn/hiện khi học do
 *             tầng hiển thị suy từ clozeText + clozeIndex.
 */

export type NoteCardType = 'basic' | 'reversed' | 'cloze';

export interface NoteDraft {
  cardType: NoteCardType;
  front: string;
  back: string;
  clozeText: string;
}

export interface BuiltNoteCard {
  front: string;
  back: string;
  /** Field hiển thị cũ, giữ đồng bộ: 'cloze' chỉ khi cardType = 'cloze'. */
  type: 'basic' | 'cloze';
  cardType: NoteCardType;
  noteId?: string;
  clozeText?: string;
  clozeIndex?: number;
}

export function createNoteId(): string {
  const cryptoObj = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (cryptoObj?.randomUUID) return cryptoObj.randomUUID();
  return `note-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function emptyNoteDraft(cardType: NoteCardType = 'basic'): NoteDraft {
  return { cardType, front: '', back: '', clozeText: '' };
}

/** Ghi chú đã đủ nội dung để lưu chưa (theo từng loại)? */
export function isNoteDraftComplete(draft: NoteDraft): boolean {
  if (draft.cardType === 'cloze') return validateClozeText(draft.clozeText).length === 0;
  return Boolean(draft.front.trim() && draft.back.trim());
}

/** Ghi chú có chứa nội dung nào chưa (để phân biệt "đang soạn dở" với ô trống)? */
export function isNoteDraftTouched(draft: NoteDraft): boolean {
  if (draft.cardType === 'cloze') return Boolean(draft.clozeText.trim());
  return Boolean(draft.front.trim() || draft.back.trim());
}

/** Số thẻ vật lý sẽ sinh từ ghi chú (chưa xét đủ nội dung hay chưa). */
export function countBuiltCards(draft: NoteDraft): number {
  if (draft.cardType === 'cloze') return parseClozeText(draft.clozeText).indexes.length;
  return draft.cardType === 'reversed' ? 2 : 1;
}

/**
 * Sinh các thẻ vật lý từ một ghi chú. Ném Error (thông điệp tiếng Việt, lấy
 * từ validateClozeText) nếu ghi chú cloze không hợp lệ — nơi gọi nên kiểm tra
 * isNoteDraftComplete/validateClozeText trước để hiển thị lỗi thân thiện.
 */
export function buildNoteCards(draft: NoteDraft): BuiltNoteCard[] {
  if (draft.cardType === 'cloze') {
    const errors = validateClozeText(draft.clozeText);
    if (errors.length > 0) throw new Error(errors[0]);
    const noteId = createNoteId();
    const plainText = clozeToPlainText(draft.clozeText);
    return parseClozeText(draft.clozeText).indexes.map((clozeIndex) => ({
      front: plainText,
      back: plainText,
      type: 'cloze' as const,
      cardType: 'cloze' as const,
      noteId,
      clozeText: draft.clozeText,
      clozeIndex,
    }));
  }

  if (draft.cardType === 'reversed') {
    const noteId = createNoteId();
    return [
      { front: draft.front, back: draft.back, type: 'basic' as const, cardType: 'reversed' as const, noteId },
      { front: draft.back, back: draft.front, type: 'basic' as const, cardType: 'reversed' as const, noteId },
    ];
  }

  return [{ front: draft.front, back: draft.back, type: 'basic' as const, cardType: 'basic' as const }];
}
