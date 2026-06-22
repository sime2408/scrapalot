import * as pdfjsLib from 'pdfjs-dist';
import mammoth from 'mammoth';

// Initialize PDF.js worker (same CDN as pdf-viewer.tsx)
pdfjsLib.GlobalWorkerOptions.workerSrc =
  'https://unpkg.com/pdfjs-dist@3.11.174/build/pdf.worker.min.js';

const MAX_TEXT_LENGTH = 100_000; // ~25K tokens

// Guards so a giant workbook can't freeze the tab while it is converted to text.
const MAX_SHEET_ROWS = 2_000; // rows per worksheet (after header)
const MAX_SHEET_COLS = 50; // columns per worksheet

async function extractPdf(file: File): Promise<string> {
  const buffer = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: buffer }).promise;
  const pages: string[] = [];

  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    const text = content.items
      .map((item: { str: string }) => item.str)
      .join(' ');
    pages.push(text);
  }

  return pages.join('\n\n');
}

async function extractDocx(file: File): Promise<string> {
  const buffer = await file.arrayBuffer();
  const result = await mammoth.extractRawText({ arrayBuffer: buffer });
  return result.value;
}

function escapeMarkdownCell(value: unknown): string {
  return String(value ?? '')
    .replace(/\|/g, '\\|')
    .replace(/\r?\n/g, ' ')
    .trim();
}

// Parses every worksheet in an .xlsx/.xls workbook into GitHub-flavored
// markdown tables (one heading + table per sheet). SheetJS is lazy-loaded via
// dynamic import() so the ~900 kB library stays out of the main bundle and is
// only fetched when a user actually attaches a spreadsheet.
async function extractSpreadsheet(file: File): Promise<string> {
  const XLSX = await import('xlsx');
  const buffer = await file.arrayBuffer();
  const workbook = XLSX.read(buffer, { type: 'array' });

  const sections: string[] = [];

  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    if (!sheet) continue;

    // Array-of-arrays representation; blank cells become ''.
    const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
      header: 1,
      blankrows: false,
      defval: '',
    });

    if (rows.length === 0) {
      sections.push(`## ${sheetName}\n\n_(empty sheet)_`);
      continue;
    }

    const cappedRows = rows.slice(0, MAX_SHEET_ROWS + 1); // +1 keeps the header
    const colCount = Math.min(
      cappedRows.reduce((max, row) => Math.max(max, row.length), 0),
      MAX_SHEET_COLS
    );

    if (colCount === 0) {
      sections.push(`## ${sheetName}\n\n_(empty sheet)_`);
      continue;
    }

    const normalizeRow = (row: unknown[]): string[] => {
      const cells = row.slice(0, colCount).map(escapeMarkdownCell);
      while (cells.length < colCount) cells.push('');
      return cells;
    };

    const [headerRow, ...bodyRows] = cappedRows;
    const header = normalizeRow(headerRow);
    const lines = [
      `## ${sheetName}`,
      '',
      `| ${header.join(' | ')} |`,
      `| ${header.map(() => '---').join(' | ')} |`,
      ...bodyRows.map((row) => `| ${normalizeRow(row).join(' | ')} |`),
    ];

    if (rows.length > cappedRows.length || rows.some((r) => r.length > colCount)) {
      lines.push('', '_(table truncated)_');
    }

    sections.push(lines.join('\n'));
  }

  return sections.join('\n\n');
}

async function extractText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(new Error('Failed to read file'));
    reader.readAsText(file);
  });
}

export async function extractTextFromFile(file: File): Promise<string> {
  const ext = file.name.toLowerCase().split('.').pop() || '';
  let text: string;

  switch (ext) {
    case 'pdf':
      text = await extractPdf(file);
      break;
    case 'docx':
      text = await extractDocx(file);
      break;
    case 'xlsx':
    case 'xls':
      text = await extractSpreadsheet(file);
      break;
    case 'txt':
    case 'md':
    case 'csv':
    case 'tsv':
      text = await extractText(file);
      break;
    default:
      throw new Error(`Unsupported file type: .${ext}`);
  }

  if (text.length > MAX_TEXT_LENGTH) {
    return text.slice(0, MAX_TEXT_LENGTH) + '\n\n[... truncated]';
  }

  return text;
}

export function imageToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      // Remove data:image/xxx;base64, prefix — keep raw base64
      const base64 = result.split(',')[1];
      resolve(base64);
    };
    reader.onerror = () => reject(new Error('Failed to read image'));
    reader.readAsDataURL(file);
  });
}

export type YoutubeUrlType = 'video' | 'playlist' | 'channel' | null;

export function isValidYoutubeUrl(url: string): boolean {
  return getYoutubeUrlType(url) !== null;
}

export function getYoutubeUrlType(url: string): YoutubeUrlType {
  const trimmed = url.trim();
  if (/^(https?:\/\/)?(www\.)?(youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/shorts\/)[\w-]+/.test(trimmed)) return 'video';
  if (/^(https?:\/\/)?(www\.)?youtube\.com\/playlist\?list=[\w-]+/.test(trimmed)) return 'playlist';
  if (/^(https?:\/\/)?(www\.)?youtube\.com\/(channel\/|c\/|@)[\w-]+/.test(trimmed)) return 'channel';
  return null;
}

export function extractYoutubeVideoId(url: string): string | null {
  const match = url.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/shorts\/)([\w-]+)/);
  return match ? match[1] : null;
}

export function getYoutubeThumbnailUrl(videoId: string): string {
  return `https://img.youtube.com/vi/${videoId}/mqdefault.jpg`;
}
