import { memo, useCallback, useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Archive, Ban, RotateCcw, Volume2, X } from 'lucide-react';
import type { Flashcard } from '../types';
import {
  formatScheduledDelay,
  normalizeCardSchedule,
  type SchedulerRating,
  type SchedulerResult,
} from '../lib/spacedRepetition';
import { Button } from '@/components/ui/button';
import { useGestureSwipe } from './useGestureSwipe';
import AudioButton from '../components/AudioButton';
import { resolveChineseVocabContent } from '../lib/chineseCardLayout';

interface RatingPreview {
  rating: SchedulerRating;
  result: SchedulerResult;
}

interface ReviewCardProps {
  card: Flashcard;
  isFlipped: boolean;
  currentIndex: number;
  totalCards: number;
  ratingPreviews: RatingPreview[];
  onFlip: () => void;
  onRate: (rating: SchedulerRating) => void | Promise<void>;
  onClose: () => void;
  onBury: () => void;
  onSuspend: () => void;
  onSpeak?: (text: string) => void;
  busy?: boolean;
}

const ratingMeta: Record<SchedulerRating, { label: string; color: string; text: string }> = {
  again: { label: 'Quên', color: 'bg-rose-500 hover:bg-rose-600', text: 'text-rose-500' },
  hard: { label: 'Khó', color: 'bg-amber-500 hover:bg-amber-600', text: 'text-amber-500' },
  good: { label: 'Tốt', color: 'bg-blue-600 hover:bg-blue-700', text: 'text-blue-600' },
  easy: { label: 'Dễ', color: 'bg-emerald-600 hover:bg-emerald-700', text: 'text-emerald-600' },
};

const escapeHtml = (value: string) =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');

const markdownImagePattern =
  /!\[([^\]\n]*)\]\s*\(\s*(<?https?:\/\/[^)\s>]+>?)\s*(?:"[^"]*"|'[^']*')?\s*\)/gi;
const plainUrlPattern = /https?:\/\/[^\s<>"']+/gi;

function normalizeUrl(value: string) {
  const cleanValue = value.trim().replace(/^<|>$/g, '');
  try {
    const url = new URL(cleanValue);
    if (url.hostname.toLowerCase() === 'github.com') {
      const [, owner, repo, blob, branch, ...pathParts] = url.pathname.split('/');
      if (owner && repo && blob === 'blob' && branch && pathParts.length > 0) {
        return `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${pathParts.join('/')}`;
      }
    }
  } catch {
    return cleanValue;
  }
  return cleanValue;
}

function isLikelyImageUrl(value: string) {
  try {
    const url = new URL(normalizeUrl(value));
    const host = url.hostname.toLowerCase();
    const path = `${url.pathname}${url.search}`.toLowerCase();
    return (
      /\.(avif|bmp|gif|jpe?g|png|svg|webp)(\?|#|$)/i.test(path) ||
      host === 'raw.githubusercontent.com' ||
      host.endsWith('.githubusercontent.com') ||
      host.includes('firebasestorage.googleapis.com') ||
      host.includes('googleusercontent.com')
    );
  } catch {
    return false;
  }
}

function renderImageTag(src: string, alt = '') {
  return `<figure><img src="${escapeHtml(normalizeUrl(src))}" alt="${escapeHtml(alt)}" /></figure>`;
}

function renderTextWithImageUrls(text: string) {
  let html = '';
  let lastIndex = 0;

  text.replace(plainUrlPattern, (match, offset) => {
    const trailing = match.match(/[),.;!?]+$/)?.[0] || '';
    const src = trailing ? match.slice(0, -trailing.length) : match;

    html += escapeHtml(text.slice(lastIndex, offset)).replace(/\n/g, '<br />');
    html += isLikelyImageUrl(src)
      ? renderImageTag(src)
      : escapeHtml(match);
    if (trailing && isLikelyImageUrl(src)) html += escapeHtml(trailing);
    lastIndex = offset + match.length;
    return match;
  });

  html += escapeHtml(text.slice(lastIndex)).replace(/\n/g, '<br />');
  return html;
}

function renderPlainReviewContent(rawContent: string) {
  let html = '';
  let lastIndex = 0;

  rawContent.replace(markdownImagePattern, (match, alt, src, offset) => {
    html += renderTextWithImageUrls(rawContent.slice(lastIndex, offset));
    html += renderImageTag(src, alt);
    lastIndex = offset + match.length;
    return match;
  });

  html += renderTextWithImageUrls(rawContent.slice(lastIndex));
  return html.trim() ? `<div>${html}</div>` : '';
}

function renderMarkdownImagesInHtml(rawContent: string) {
  return rawContent.replace(markdownImagePattern, (_match, alt, src) => renderImageTag(src, alt));
}

const allowedTags = new Set([
  'A', 'ARTICLE', 'B', 'BLOCKQUOTE', 'BR', 'CODE', 'DETAILS', 'DIV', 'EM', 'FIGURE', 'FIGCAPTION',
  'H1', 'H2', 'H3', 'H4', 'HR', 'I', 'IMG', 'LI', 'MARK', 'OL', 'P', 'PRE',
  'RP', 'RT', 'RUBY', 'SMALL', 'SPAN', 'STRONG', 'SUB', 'SUMMARY', 'SUP', 'TABLE', 'TBODY', 'TD', 'TH',
  'THEAD', 'TR', 'U', 'UL',
]);

const allowedAttributes = new Set(['alt', 'aria-label', 'class', 'colspan', 'hidden', 'href', 'lang', 'rowspan', 'src', 'title']);

function sanitizeReviewHtml(rawContent: string) {
  const htmlReadyContent = renderMarkdownImagesInHtml(rawContent);
  const looksLikeHtml = /<\/?[a-z][\s\S]*>/i.test(htmlReadyContent);
  const source = looksLikeHtml ? htmlReadyContent : renderPlainReviewContent(rawContent);

  if (typeof window === 'undefined') return source;

  const doc = new DOMParser().parseFromString(`<div>${source}</div>`, 'text/html');
  doc.querySelectorAll('script,style,iframe,object,embed,link,meta').forEach((node) => node.remove());

  doc.body.querySelectorAll('*').forEach((element) => {
    if (!allowedTags.has(element.tagName)) {
      element.replaceWith(...Array.from(element.childNodes));
      return;
    }

    Array.from(element.attributes).forEach((attribute) => {
      const name = attribute.name.toLowerCase();
      const value = attribute.value.trim();
      if (name.startsWith('on') || name === 'style' || !allowedAttributes.has(name)) {
        element.removeAttribute(attribute.name);
        return;
      }
      if ((name === 'href' || name === 'src') && /^(javascript|data:text\/html)/i.test(value)) {
        element.removeAttribute(attribute.name);
        return;
      }
      if (name === 'src' && /^data:(?!image\/)/i.test(value)) {
        element.removeAttribute(attribute.name);
      }
    });

    if (element.tagName === 'A') {
      element.setAttribute('target', '_blank');
      element.setAttribute('rel', 'noopener noreferrer');
    }

    if (element.tagName === 'IMG') {
      element.setAttribute('loading', 'lazy');
      element.setAttribute('decoding', 'async');
      element.setAttribute('referrerpolicy', 'no-referrer');
      element.setAttribute('data-review-image', 'true');
    }
  });

  return doc.body.firstElementChild?.innerHTML || '';
}

function contentForSide(card: Flashcard, isFlipped: boolean) {
  const isBackSide = isFlipped;
  const rawContent = isBackSide ? card.back : card.front;
  const resolved = resolveChineseVocabContent(
    card.noteType,
    card.extraFields,
    card.front,
    card.back,
    isBackSide,
  );
  const content = resolved || rawContent;
  if (card.type !== 'cloze') return content;
  return isFlipped
    ? content.replace(/\{\{c\d+::(.*?)\}\}/g, '<mark>$1</mark>')
    : content.replace(/\{\{c\d+::(.*?)\}\}/g, '<span class="rounded-md bg-zinc-200 px-2 py-1 text-zinc-500 dark:bg-white/10">[...]</span>');
}

function audioForSide(card: Flashcard, isBackSide: boolean) {
  const sideAudio = isBackSide ? card.backAudio : card.frontAudio;
  if (sideAudio?.length) return sideAudio;
  return isBackSide ? [] : (card.audioUrls || []);
}

function ReviewImage({
  src,
  alt,
  onZoom,
}: {
  src?: string;
  alt: string;
  onZoom: (src: string) => void;
}) {
  if (!src) return null;
  return (
    <button
      type="button"
      data-no-card-swipe="true"
      className="mx-auto block max-w-full overflow-hidden rounded-xl border border-zinc-200 bg-zinc-50 dark:border-white/10 dark:bg-white/5"
      onClick={(event) => {
        event.stopPropagation();
        onZoom(src);
      }}
    >
      <img
        src={src}
        alt={alt}
        loading="lazy"
        decoding="async"
        referrerPolicy="no-referrer"
        className="max-h-[45vh] max-w-full object-contain"
      />
    </button>
  );
}

function RatingButton({
  rating,
  preview,
  disabled,
  onRate,
}: {
  rating: SchedulerRating;
  preview: string;
  disabled?: boolean;
  onRate: (rating: SchedulerRating) => void;
}) {
  const meta = ratingMeta[rating];
  return (
    <Button
      type="button"
      disabled={disabled}
      onClick={() => onRate(rating)}
      className={`${meta.color} h-16 flex-1 rounded-xl text-white shadow-lg shadow-zinc-950/10 transition-transform active:scale-95 disabled:opacity-60`}
    >
      <span className="flex flex-col items-center leading-none">
        <span className="text-sm font-semibold">{meta.label}</span>
        <span className="mt-2 text-[10px] font-black uppercase tracking-wide text-white/80">{preview}</span>
      </span>
    </Button>
  );
}

export const ReviewCard = memo(function ReviewCard({
  card,
  isFlipped,
  currentIndex,
  totalCards,
  ratingPreviews,
  onFlip,
  onRate,
  onClose,
  onBury,
  onSuspend,
  onSpeak,
  busy,
}: ReviewCardProps) {
  const [zoomImage, setZoomImage] = useState<string | null>(null);
  const schedule = useMemo(() => normalizeCardSchedule(card), [card]);
  const safeHtml = useMemo(() => sanitizeReviewHtml(contentForSide(card, isFlipped)), [card, isFlipped]);
  const imageUrl = isFlipped ? card.backImageUrl : card.imageUrl;
  const contentLabel = isFlipped ? 'Answer' : 'Question';

  const handleRate = useCallback((rating: SchedulerRating) => {
    if (busy) return;
    onRate(rating);
  }, [busy, onRate]);

  const { targetRef, style, activeRating } = useGestureSwipe({
    disabled: busy || !isFlipped,
    onSwipe: handleRate,
  });

  const handleHtmlClick = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement | null;
    const img = target?.closest('img');
    const src = img?.getAttribute('src');
    if (src) {
      event.stopPropagation();
      setZoomImage(src);
    }
  }, []);

  return (
    <section className="mx-auto flex min-h-[calc(100vh-148px)] w-full flex-col items-center justify-center gap-4 px-3 py-4">
      <div className="flex w-full max-w-[420px] items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Button type="button" variant="ghost" size="icon" className="h-10 w-10 rounded-xl" onClick={onClose}>
            <X className="h-5 w-5" />
          </Button>
          <Button type="button" variant="ghost" size="icon" className="h-10 w-10 rounded-xl" onClick={onBury}>
            <Archive className="h-4 w-4" />
          </Button>
          <Button type="button" variant="ghost" size="icon" className="h-10 w-10 rounded-xl" onClick={onSuspend}>
            <Ban className="h-4 w-4" />
          </Button>
        </div>
        <div className="min-w-0 flex-1 text-right">
          <p className="text-xs font-semibold text-zinc-500 dark:text-zinc-400">{currentIndex + 1} / {totalCards}</p>
          <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-zinc-200 dark:bg-white/10">
            <motion.div
              className="h-full rounded-full bg-zinc-950 dark:bg-white"
              animate={{ width: `${Math.max(0, ((currentIndex + 1) / Math.max(totalCards, 1)) * 100)}%` }}
              transition={{ type: 'spring', stiffness: 300, damping: 25 }}
            />
          </div>
        </div>
      </div>

      <div className="relative h-[80vh] max-h-[760px] min-h-[520px] w-full max-w-[420px] [perspective:1400px]">
        <AnimatePresence>
          {activeRating && (
            <motion.div
              className={`pointer-events-none absolute left-1/2 top-5 z-30 -translate-x-1/2 rounded-full bg-white px-4 py-2 text-xs font-black uppercase shadow-xl ${ratingMeta[activeRating].text}`}
              initial={{ opacity: 0, y: -10, scale: 0.96 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -10 }}
            >
              {ratingMeta[activeRating].label}
            </motion.div>
          )}
        </AnimatePresence>

        <motion.div
          ref={targetRef}
          className="absolute inset-0 cursor-grab touch-pan-y active:cursor-grabbing"
          style={style}
        >
          <motion.article
            className="review-card-frame relative h-full w-full rounded-[28px] shadow-2xl [transform-style:preserve-3d]"
            animate={{ rotateY: isFlipped ? 180 : 0 }}
            transition={{ duration: 0.36, ease: [0.22, 1, 0.36, 1] }}
            onClick={onFlip}
          >
            {(['front', 'back'] as const).map((side) => {
              const sideFlipped = side === 'back';
              const visible = isFlipped === sideFlipped;
              const audioSources = audioForSide(card, sideFlipped);
              return (
                <div
                  key={side}
                  className={`review-card-face absolute inset-0 flex h-full w-full flex-col overflow-hidden rounded-[28px] border border-zinc-200 bg-white text-zinc-950 [backface-visibility:hidden] dark:border-white/10 dark:bg-[#101113] dark:text-white ${
                    sideFlipped ? '[transform:rotateY(180deg)]' : ''
                  }`}
                  aria-hidden={!visible}
                >
                  <div className="flex shrink-0 items-center justify-between gap-3 border-b border-zinc-200 px-5 py-4 dark:border-white/10">
                    <div>
                      <p className="text-[10px] font-black uppercase tracking-[0.22em] text-zinc-400">{sideFlipped ? 'Answer' : 'Question'}</p>
                      <p className="mt-1 text-xs font-medium text-zinc-500 dark:text-zinc-400">
                        {schedule.state} · S {schedule.stability.toFixed(1)} · D {schedule.difficulty.toFixed(1)}
                      </p>
                    </div>
                    <div className="flex items-center gap-1">
                      {audioSources.map((src, index) => (
                        <AudioButton
                          key={`${side}-${index}`}
                          src={src}
                          label={`Phát audio ${index + 1}`}
                          className="h-10 w-10 rounded-xl"
                        />
                      ))}
                      {onSpeak && (
                        <Button
                          type="button"
                          data-no-card-swipe="true"
                          variant="ghost"
                          size="icon"
                          className="h-10 w-10 rounded-xl"
                          onClick={(event) => {
                            event.stopPropagation();
                            onSpeak(sideFlipped ? card.back : card.front);
                          }}
                          aria-label="Read card aloud"
                        >
                          <Volume2 className="h-4 w-4" />
                        </Button>
                      )}
                    </div>
                  </div>

                  <div
                    className="review-card-scroll review-card-html flex-1 overflow-y-auto overflow-x-hidden px-5 py-5 text-center chinese-review"
                    onClick={handleHtmlClick}
                  >
                    <ReviewImage src={sideFlipped ? card.backImageUrl : card.imageUrl} alt={contentLabel} onZoom={setZoomImage} />
                    <div
                      className="mt-4 text-lg font-semibold leading-8"
                      dangerouslySetInnerHTML={{ __html: sideFlipped === isFlipped ? safeHtml : sanitizeReviewHtml(contentForSide(card, sideFlipped)) }}
                    />
                  </div>
                </div>
              );
            })}
          </motion.article>
        </motion.div>
      </div>

      <div className="grid w-full max-w-[420px] grid-cols-4 gap-2 rounded-2xl border border-zinc-200 bg-white/85 p-2 shadow-xl backdrop-blur-xl dark:border-white/10 dark:bg-[#101113]/85">
        {ratingPreviews.map(({ rating, result }) => (
          <RatingButton
            key={rating}
            rating={rating}
            preview={formatScheduledDelay(result.scheduledDelay)}
            disabled={busy || !isFlipped}
            onRate={handleRate}
          />
        ))}
      </div>

      {!isFlipped && (
        <button
          type="button"
          className="flex items-center gap-2 rounded-full px-4 py-2 text-xs font-semibold text-zinc-500 hover:text-zinc-950 dark:text-zinc-400 dark:hover:text-white"
          onClick={onFlip}
        >
          <RotateCcw className="h-4 w-4" />
          Lật thẻ
        </button>
      )}

      <AnimatePresence>
        {zoomImage && (
          <motion.div
            className="fixed inset-0 z-[100] flex items-center justify-center bg-black/90 p-4"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={() => setZoomImage(null)}
          >
            <motion.img
              src={zoomImage}
              alt=""
              className="max-h-[92vh] max-w-[94vw] rounded-xl object-contain"
              initial={{ opacity: 0, scale: 0.96 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.96 }}
              loading="eager"
              referrerPolicy="no-referrer"
            />
          </motion.div>
        )}
      </AnimatePresence>
    </section>
  );
});
