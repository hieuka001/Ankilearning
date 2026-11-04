/**
 * Category cover art resolver.
 *
 * Every deck carries a free-text `category` (typed by the user, usually in
 * Vietnamese). This helper maps that text to one of the AI-generated cover
 * illustrations in `public/img/` so deck cards, the deck header and the
 * create-deck form all show a consistent, on-topic cover image.
 *
 * Matching strategy:
 *  - The category is normalised first: lower-cased, Vietnamese diacritics
 *    stripped (NFD + combining-mark removal, plus đ -> d which NFD does not
 *    decompose), whitespace collapsed.
 *  - Long, unambiguous keywords are matched as substrings ("lap trinh",
 *    "tieng trung", "marketing", ...).
 *  - Very short keywords that would false-positive as substrings ("ly",
 *    "hoa", "sinh", "it") are matched on word boundaries instead.
 *  - Groups are checked in priority order so overlaps resolve sensibly:
 *    "ke toan" (accounting) hits Business before bare "toan" (maths) can
 *    claim it for Science, and "y khoa" hits Medical before "khoa hoc"
 *    (science) is considered.
 */

const ART = {
  medical: '/img/cat-y-khoa.webp',
  chinese: '/img/cat-tieng-trung.webp',
  programming: '/img/cat-lap-trinh.webp',
  science: '/img/cat-khoa-hoc.webp',
  business: '/img/cat-kinh-doanh.webp',
  language: '/img/cat-ngoai-ngu.webp',
  general: '/img/cat-chung.webp',
} as const;

function normalizeCategoryText(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/\s+/g, ' ')
    .trim();
}

/** True when `keyword` appears as a whole word in the normalised text. */
function hasWord(normalized: string, keyword: string): boolean {
  return ` ${normalized} `.includes(` ${keyword} `);
}

function includesAny(normalized: string, keywords: string[]): boolean {
  return keywords.some((keyword) => normalized.includes(keyword));
}

export function getCategoryArt(category?: string | null): string {
  if (!category) return ART.general;
  const text = normalizeCategoryText(category);
  if (!text) return ART.general;

  // Y khoa / y tế
  if (includesAny(text, ['y khoa', 'y te', 'duoc', 'lam sang', 'y hoc', 'dieu duong'])) {
    return ART.medical;
  }

  // Tiếng Trung
  if (includesAny(text, ['tieng trung', 'trung quoc', 'hsk', 'chinese'])) {
    return ART.chinese;
  }

  // Lập trình / công nghệ
  if (
    includesAny(text, ['lap trinh', 'cong nghe', 'tin hoc', 'phan mem']) ||
    hasWord(text, 'code') ||
    hasWord(text, 'it')
  ) {
    return ART.programming;
  }

  // Kinh doanh / kinh tế (checked before Science so "ke toan" wins over "toan")
  if (includesAny(text, ['kinh doanh', 'kinh te', 'marketing', 'tai chinh', 'ke toan'])) {
    return ART.business;
  }

  // Khoa học / tự nhiên
  if (
    includesAny(text, ['khoa hoc', 'toan', 'vat ly', 'hoa hoc', 'sinh hoc']) ||
    hasWord(text, 'ly') ||
    hasWord(text, 'hoa') ||
    hasWord(text, 'sinh')
  ) {
    return ART.science;
  }

  // Ngoại ngữ
  if (
    includesAny(text, [
      'tieng anh',
      'ngoai ngu',
      'english',
      'tieng nhat',
      'tieng han',
      'tieng phap',
      'tieng duc',
      'ngon ngu',
    ])
  ) {
    return ART.language;
  }

  return ART.general;
}

export interface CategoryPreset {
  label: string;
  art: string;
}

/** Quick-pick categories offered in the create-deck form. */
export const CATEGORY_PRESETS: CategoryPreset[] = [
  'Y khoa',
  'Tiếng Anh',
  'Tiếng Trung',
  'Lập trình',
  'Khoa học',
  'Kinh doanh',
  'Chung',
].map((label) => ({ label, art: getCategoryArt(label) }));
