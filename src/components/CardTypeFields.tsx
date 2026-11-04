import { useRef } from 'react';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import { ArrowLeftRight, Braces, Layers, Highlighter } from 'lucide-react';
import type { NoteCardType } from '../lib/noteCards';
import { parseClozeText, validateClozeText, wrapSelectionAsCloze } from '../review/cloze';

/**
 * Bộ chọn loại ghi chú kiểu Anki + các ô nhập tương ứng, dùng chung cho
 * CreateDeck (soạn thẻ khi tạo deck) và DeckDetail (dialog Thêm thẻ).
 * Chỉ quản lý nội dung chữ (loại/front/back/clozeText) — ảnh và tuỳ chỉnh
 * giao diện do nơi gọi tự giữ.
 */
export interface CardTypeFieldsValue {
  cardType: NoteCardType;
  front: string;
  back: string;
  clozeText: string;
}

interface CardTypeFieldsProps {
  value: CardTypeFieldsValue;
  onChange: (value: CardTypeFieldsValue) => void;
  frontLabel?: string;
  backLabel?: string;
  frontPlaceholder?: string;
  backPlaceholder?: string;
}

const TYPE_OPTIONS: { value: NoteCardType; label: string; icon: typeof Layers; hint: string }[] = [
  { value: 'basic', label: 'Cơ bản', icon: Layers, hint: 'Một thẻ hỏi/đáp như thường lệ.' },
  { value: 'reversed', label: 'Đảo ngược', icon: ArrowLeftRight, hint: 'Tự sinh 2 thẻ: chiều xuôi và chiều ngược.' },
  { value: 'cloze', label: 'Cloze (điền khuyết)', icon: Braces, hint: 'Che đáp án trong câu bằng {{c1::...}}.' },
];

export default function CardTypeFields({
  value,
  onChange,
  frontLabel = 'Mặt trước (Câu hỏi)',
  backLabel = 'Mặt sau (Câu trả lời)',
  frontPlaceholder = 'Nhập câu hỏi...',
  backPlaceholder = 'Nhập câu trả lời...',
}: CardTypeFieldsProps) {
  const clozeTextareaRef = useRef<HTMLTextAreaElement>(null);

  const set = (patch: Partial<CardTypeFieldsValue>) => onChange({ ...value, ...patch });

  const handleMarkCloze = () => {
    const textarea = clozeTextareaRef.current;
    if (!textarea) return;
    const wrapped = wrapSelectionAsCloze(value.clozeText, textarea.selectionStart ?? 0, textarea.selectionEnd ?? 0);
    if (wrapped === null) return;
    set({ clozeText: wrapped });
    // Giữ focus trong ô nhập sau khi bọc cloze.
    requestAnimationFrame(() => textarea.focus());
  };

  const clozeIndexes = value.cardType === 'cloze' ? parseClozeText(value.clozeText).indexes : [];
  const clozeErrors = value.cardType === 'cloze' && value.clozeText.trim() ? validateClozeText(value.clozeText) : [];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2" role="tablist" aria-label="Loại thẻ">
        {TYPE_OPTIONS.map((option) => {
          const Icon = option.icon;
          const active = value.cardType === option.value;
          return (
            <button
              key={option.value}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => set({ cardType: option.value })}
              className={`flex items-center gap-2 rounded-xl px-4 py-2 text-sm font-bold transition-all ${
                active
                  ? 'bg-emerald-600 text-white shadow-md shadow-emerald-600/25'
                  : 'bg-zinc-100 text-zinc-600 hover:bg-zinc-200 dark:bg-white/5 dark:text-zinc-300 dark:hover:bg-white/10'
              }`}
            >
              <Icon size={16} />
              {option.label}
            </button>
          );
        })}
      </div>
      <p className="-mt-2 text-xs font-medium text-zinc-500 dark:text-zinc-400">
        {TYPE_OPTIONS.find((option) => option.value === value.cardType)?.hint}
      </p>

      {value.cardType === 'cloze' ? (
        <div className="space-y-3">
          <div className="space-y-2">
            <label className="text-[9px] font-extrabold uppercase tracking-[0.2em] text-zinc-400">
              Văn bản cloze
            </label>
            <Textarea
              ref={clozeTextareaRef}
              placeholder="Ví dụ: Thủ đô của Việt Nam là Hà Nội. Bôi đen một đoạn rồi bấm 'Đánh dấu cloze'."
              value={value.clozeText}
              onChange={(e) => set({ clozeText: e.target.value })}
              className="min-h-[120px] rounded-2xl border-zinc-100 p-5 font-medium focus:ring-primary/20 dark:border-white/5 dark:bg-white/5 dark:text-white"
            />
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Button
              type="button"
              variant="outline"
              onClick={handleMarkCloze}
              onMouseDown={(e) => e.preventDefault()}
              className="h-10 gap-2 rounded-xl border-emerald-600/40 font-bold text-emerald-700 hover:bg-emerald-50 dark:text-emerald-300 dark:hover:bg-emerald-500/10"
            >
              <Highlighter size={16} />
              Đánh dấu cloze
            </Button>
            <span className="text-xs font-semibold text-zinc-500 dark:text-zinc-400">
              {clozeIndexes.length > 0
                ? `Sẽ tạo ${clozeIndexes.length} thẻ (${clozeIndexes.map((index) => `c${index}`).join(', ')})`
                : 'Chưa có đoạn cloze nào — bôi đen đoạn cần che trong văn bản rồi bấm "Đánh dấu cloze".'}
            </span>
          </div>
          {clozeErrors.length > 0 && (
            <ul className="space-y-1 text-xs font-semibold text-rose-500">
              {clozeErrors.map((error) => (
                <li key={error}>{error}</li>
              ))}
            </ul>
          )}
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <div className="space-y-2">
            <label className="text-[9px] font-extrabold uppercase tracking-[0.2em] text-zinc-400">{frontLabel}</label>
            <Textarea
              placeholder={frontPlaceholder}
              value={value.front}
              onChange={(e) => set({ front: e.target.value })}
              className="min-h-[100px] rounded-2xl border-zinc-100 p-5 font-medium focus:ring-primary/20 dark:border-white/5 dark:bg-white/5 dark:text-white"
            />
          </div>
          <div className="space-y-2">
            <label className="text-[9px] font-extrabold uppercase tracking-[0.2em] text-zinc-400">{backLabel}</label>
            <Textarea
              placeholder={backPlaceholder}
              value={value.back}
              onChange={(e) => set({ back: e.target.value })}
              className="min-h-[100px] rounded-2xl border-zinc-100 p-5 font-medium focus:ring-primary/20 dark:border-white/5 dark:bg-white/5 dark:text-white"
            />
          </div>
        </div>
      )}
    </div>
  );
}
