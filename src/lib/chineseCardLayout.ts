const CHINESE_VOCAB_PATTERN = /chinese\s*\(vocab\)/i;

export function isChineseVocabNoteType(noteType?: string | null) {
  return !!noteType && CHINESE_VOCAB_PATTERN.test(noteType);
}

export function hasChineseVocabFields(fields?: Record<string, string> | null) {
  if (!fields) return false;
  return Boolean(fields.Hanzi || fields.Color || fields.Pinyin || fields['Nghĩa (VN)']);
}

function cleanField(value?: string) {
  return String(value || '').trim();
}

function hasContent(value?: string) {
  const html = cleanField(value).replace(/<[^>]+>/g, '').replace(/\[sound:[^\]]+\]/gi, '').trim();
  return Boolean(html);
}

function stripScripts(html: string) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/\son\w+="[^"]*"/gi, '')
    .replace(/\son\w+='[^']*'/gi, '');
}

function renderExamples(fields: Record<string, string>) {
  const rows: string[] = [];

  for (let index = 1; index <= 3; index += 1) {
    const zh = cleanField(fields[`Ví dụ ${index}`]);
    const vi = cleanField(fields[`Ví dụ ${index} (bản dịch VN)`]);
    if (!hasContent(zh) && !hasContent(vi)) continue;

    rows.push('<article class="chinese-card__example">');
    if (hasContent(zh)) {
      rows.push(`<p class="chinese-card__example-zh zh" lang="zh-Hans">${zh}</p>`);
    }
    if (hasContent(vi)) {
      rows.push(`<p class="chinese-card__example-vi" lang="vi">${vi}</p>`);
    }
    rows.push('</article>');
  }

  if (!rows.length) return '';
  return `<section class="chinese-card__section chinese-card__section--examples"><h3 class="chinese-card__label">Ví dụ</h3>${rows.join('')}</section>`;
}

export function formatChineseVocabFront(fields: Record<string, string>) {
  const hanzi = cleanField(fields.Color) || cleanField(fields.Hanzi);
  const hint = cleanField(fields['Gợi ý']);
  if (!hanzi && !hint) return '';

  const parts = ['<div class="chinese-card chinese-card--front">'];
  if (hanzi) {
    parts.push(`<div class="chinese-card__hero"><div class="chinese-card__hanzi zh main-reading" lang="zh-Hans">${hanzi}</div></div>`);
  }
  if (hint) {
    parts.push(`<p class="chinese-card__hint">${hint}</p>`);
  }
  parts.push('</div>');
  return parts.join('');
}

export function formatChineseVocabBack(fields: Record<string, string>) {
  const hanzi = cleanField(fields.Color) || cleanField(fields.Hanzi);
  const traditional = cleanField(fields.Traditional);
  const pinyin = cleanField(fields.Pinyin);
  const meaningVi = cleanField(fields['Nghĩa (VN)']);
  const meaningEn = cleanField(fields['Nghĩa (EN)']);
  const measure = cleanField(fields['Danh từ đơn vị']);
  const image = stripScripts(cleanField(fields['Ảnh']));
  const defMain = cleanField(fields['Giải nghĩa chính [Trung]']);
  const defMore = cleanField(fields['Giải nghĩa khác [Trung]']);
  const examples = renderExamples(fields);

  const parts = ['<div class="chinese-card chinese-card--back">'];

  if (hanzi || traditional || pinyin) {
    parts.push('<section class="chinese-card__hero">');
    if (hanzi) parts.push(`<div class="chinese-card__hanzi zh reading" lang="zh-Hans">${hanzi}</div>`);
    if (traditional && traditional !== hanzi) {
      parts.push(`<div class="chinese-card__traditional zh-hant" lang="zh-Hant">${traditional}</div>`);
    }
    if (pinyin) parts.push(`<div class="chinese-card__pinyin pinyin">${pinyin}</div>`);
    parts.push('</section>');
  }

  if (hasContent(meaningVi) || hasContent(meaningEn)) {
    parts.push('<section class="chinese-card__section chinese-card__section--meaning">');
    if (hasContent(meaningVi)) {
      parts.push(`<p class="chinese-card__meaning-vi vn-meaning" lang="vi">${meaningVi}</p>`);
    }
    if (hasContent(meaningEn)) {
      parts.push(`<p class="chinese-card__meaning-en en-meaning paren" lang="en">${meaningEn}</p>`);
    }
    parts.push('</section>');
  }

  parts.push(examples);

  if (hasContent(measure)) {
    parts.push(`<section class="chinese-card__section chinese-card__section--measure"><h3 class="chinese-card__label">Danh từ đơn vị</h3><div class="chinese-card__measure measure">${measure}</div></section>`);
  }

  if (hasContent(image)) {
    parts.push(`<section class="chinese-card__section chinese-card__section--image"><div class="chinese-card__image img-wrap">${image}</div></section>`);
  }

  if (hasContent(defMain) || hasContent(defMore)) {
    parts.push('<section class="chinese-card__section chinese-card__section--definitions">');
    parts.push('<h3 class="chinese-card__label">Giải nghĩa</h3>');
    if (hasContent(defMain)) {
      parts.push(`<div class="chinese-card__def-main zh-def-main zh" lang="zh-Hans">${defMain}</div>`);
    }
    if (hasContent(defMore)) {
      parts.push('<details class="chinese-card__def-details">');
      parts.push('<summary class="chinese-card__def-summary zh" lang="zh-Hans">详细释义</summary>');
      parts.push(`<div class="chinese-card__def-more zh-def zh" lang="zh-Hans">${defMore}</div>`);
      parts.push('</details>');
    }
    parts.push('</section>');
  }

  parts.push('</div>');

  const audio = cleanField(fields.Audio);
  if (audio.includes('[sound:')) {
    parts.push(`<span class="chinese-card__audio-source" hidden>${audio}</span>`);
  }

  return parts.join('');
}

export function resolveChineseVocabContent(
  noteType: string | undefined,
  extraFields: Record<string, string> | undefined,
  front: string,
  back: string,
  isBackSide: boolean,
) {
  if (!isChineseVocabNoteType(noteType) && !hasChineseVocabFields(extraFields)) {
    return isBackSide ? back : front;
  }

  const fields = extraFields || {};
  const formatted = isBackSide ? formatChineseVocabBack(fields) : formatChineseVocabFront(fields);
  if (formatted.trim()) return formatted;
  return isBackSide ? back : front;
}
