// Trích xuất văn bản từ file tài liệu người dùng tải lên (PDF, Word .docx,
// TXT, Markdown) — một đường dùng chung cho Tạo bộ thẻ, Trợ lý AI và hộp
// thoại Thêm thẻ mới, thay cho logic đọc PDF chép tay ở từng trang trước đây.
//
// Cả pdfjs (~452KB) lẫn mammoth đều được nạp lười bằng dynamic import bên
// trong hàm trích xuất để không phình bundle chính; module này chỉ chứa các
// hàm thuần ở top-level nên test Node import được mà không kéo theo pdfjs.

export type DocumentKind = 'pdf' | 'docx' | 'text';

export interface ExtractedDocument {
  text: string;
  truncated: boolean;
  kind: DocumentKind;
  /** PDF: tổng số trang của file (chỉ có khi kind = 'pdf'). */
  totalPages?: number;
  /** PDF: số trang thực tế đã trích xuất (tối đa MAX_PDF_PAGES). */
  pagesRead?: number;
}

export interface ExtractDocumentOptions {
  /** Báo tiến độ đọc PDF: (số trang đã đọc, tổng số trang sẽ đọc). */
  onPdfProgress?: (pagesRead: number, pagesToRead: number) => void;
}

/** Chỉ trích xuất tối đa 30 trang đầu của PDF — như hành vi trước đây. */
export const MAX_PDF_PAGES = 30;

/** Trần an toàn cho mọi tài liệu: văn bản dài hơn sẽ bị cắt ở đây. */
export const MAX_DOCUMENT_CHARS = 120_000;

export const UNSUPPORTED_DOCUMENT_MESSAGE =
  'Định dạng chưa hỗ trợ — hãy dùng PDF, DOCX, TXT hoặc MD';

const DOCX_MIME =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

/**
 * Nhận diện loại tài liệu theo phần mở rộng (ưu tiên) và MIME.
 * Trả về null khi định dạng không được hỗ trợ.
 */
export function detectDocumentKind(
  fileName: string,
  mimeType: string,
): DocumentKind | null {
  const name = (fileName || '').toLowerCase();
  const dotIndex = name.lastIndexOf('.');
  const ext = dotIndex >= 0 ? name.slice(dotIndex + 1) : '';
  const mime = (mimeType || '').toLowerCase();
  if (ext === 'pdf' || mime === 'application/pdf') return 'pdf';
  if (ext === 'docx' || mime === DOCX_MIME) return 'docx';
  if (
    ext === 'txt' ||
    ext === 'md' ||
    ext === 'markdown' ||
    mime === 'text/plain' ||
    mime === 'text/markdown'
  ) {
    return 'text';
  }
  return null;
}

/** Cắt văn bản ở trần MAX_DOCUMENT_CHARS, trả về cờ khi bị cắt. */
export function capDocumentText(text: string): { text: string; truncated: boolean } {
  if (text.length <= MAX_DOCUMENT_CHARS) return { text, truncated: false };
  return { text: text.slice(0, MAX_DOCUMENT_CHARS), truncated: true };
}

// Trích text từ một trang PDF nhưng giữ cấu trúc dòng/đoạn:
// xuống dòng khi toạ độ dọc thay đổi, cách đoạn khi khoảng cách dọc lớn.
// (Chuyển nguyên từ AIHelper — trước đây chỉ trang đó giữ được cấu trúc đoạn.)
export function extractPdfPageText(items: any[]): string {
  let text = '';
  let lastY: number | null = null;
  let lastHeight = 12;
  for (const item of items) {
    if (typeof item?.str !== 'string') continue;
    const y = Array.isArray(item.transform) ? Number(item.transform[5]) : null;
    const height = typeof item.height === 'number' && item.height > 0 ? item.height : lastHeight;
    if (y !== null && lastY !== null) {
      const gap = Math.abs(y - lastY);
      if (gap > Math.max(2, height * 0.5) && text && !text.endsWith('\n')) {
        text += gap > height * 1.6 ? '\n\n' : '\n';
      }
    }
    if (text && !text.endsWith('\n') && !text.endsWith(' ') && item.str) text += ' ';
    text += item.str;
    if (item.hasEOL) text += '\n';
    if (y !== null) lastY = y;
    lastHeight = height;
  }
  return text.trim();
}

async function extractPdfText(
  file: File,
  options?: ExtractDocumentOptions,
): Promise<{ text: string; totalPages: number; pagesRead: number }> {
  const [pdfjsLib, workerModule] = await Promise.all([
    import('pdfjs-dist'),
    import('pdfjs-dist/build/pdf.worker.min.mjs?url'),
  ]);
  pdfjsLib.GlobalWorkerOptions.workerSrc = workerModule.default;
  const data = new Uint8Array(await file.arrayBuffer());
  const pdf = await pdfjsLib.getDocument(data).promise;
  const totalPages = pdf.numPages;
  const pagesRead = Math.min(totalPages, MAX_PDF_PAGES);
  const pageTexts: string[] = [];
  for (let i = 1; i <= pagesRead; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    pageTexts.push(extractPdfPageText(content.items as any[]));
    options?.onPdfProgress?.(i, pagesRead);
  }
  return { text: pageTexts.join('\n\n').trim(), totalPages, pagesRead };
}

async function extractDocxText(file: File): Promise<string> {
  const mammoth = await import('mammoth');
  const arrayBuffer = await file.arrayBuffer();
  const result = await mammoth.extractRawText({ arrayBuffer });
  return result.value.trim();
}

/**
 * Trích xuất văn bản thuần từ một file tài liệu.
 * Ném Error với thông điệp tiếng Việt rõ ràng khi định dạng không được hỗ trợ
 * hoặc file hỏng/không đọc được.
 */
export async function extractTextFromDocument(
  file: File,
  options?: ExtractDocumentOptions,
): Promise<ExtractedDocument> {
  const kind = detectDocumentKind(file.name, file.type);
  if (!kind) {
    throw new Error(UNSUPPORTED_DOCUMENT_MESSAGE);
  }
  try {
    if (kind === 'pdf') {
      const { text, totalPages, pagesRead } = await extractPdfText(file, options);
      const capped = capDocumentText(text);
      return { ...capped, kind, totalPages, pagesRead };
    }
    if (kind === 'docx') {
      const capped = capDocumentText(await extractDocxText(file));
      return { ...capped, kind };
    }
    const capped = capDocumentText(await file.text());
    return { ...capped, kind };
  } catch (error: any) {
    throw new Error(
      error?.message
        ? `Không đọc được file: ${error.message}`
        : 'Không đọc được file. Vui lòng thử lại với file khác.',
    );
  }
}
