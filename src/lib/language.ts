export type SupportedLanguage = 'vi' | 'en' | 'zh';

export const SUPPORTED_LANGUAGES: { value: SupportedLanguage; label: string; speech: string }[] = [
  { value: 'vi', label: 'Tiếng Việt', speech: 'vi-VN' },
  { value: 'en', label: 'English', speech: 'en-US' },
  { value: 'zh', label: '中文 / Tiếng Trung', speech: 'zh-CN' },
];

const vietnamesePattern = /[àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ]/i;
const chinesePattern = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/;

export function normalizeLanguage(value?: string | null): SupportedLanguage {
  const clean = String(value || '').toLowerCase();
  if (clean.startsWith('zh') || clean.includes('chinese') || clean.includes('trung')) return 'zh';
  if (clean.startsWith('en') || clean.includes('english') || clean.includes('anh')) return 'en';
  return 'vi';
}

export function detectTextLanguage(text: string, fallback: SupportedLanguage = 'vi'): SupportedLanguage {
  if (chinesePattern.test(text)) return 'zh';
  if (vietnamesePattern.test(text)) return 'vi';
  return fallback;
}

export function speechLanguageForText(text: string, preferred?: string | null) {
  const fallback = normalizeLanguage(preferred);
  const detected = detectTextLanguage(text, fallback);
  return SUPPORTED_LANGUAGES.find((language) => language.value === detected)?.speech || 'vi-VN';
}

export function speechRecognitionLanguage(preferred?: string | null) {
  const language = normalizeLanguage(preferred);
  return SUPPORTED_LANGUAGES.find((item) => item.value === language)?.speech || 'vi-VN';
}
