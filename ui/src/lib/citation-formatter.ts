/**
 * Citation formatting utilities using Citation.js
 * Provides citation formatting, bibliography generation, and export to BibTeX/RIS/CSV.
 * Citation.js is lazy-loaded to avoid bundle bloat.
 */

import type { ResolvedMetadata } from '@/lib/api-metadata';

// Lazy-loaded Citation.js
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Citation.js does not ship TS types
let Cite: any = null;

async function getCite() {
  if (!Cite) {
    const mod = await import('@citation-js/core');
    await import('@citation-js/plugin-csl');
    await import('@citation-js/plugin-bibtex');
    await import('@citation-js/plugin-ris');
    Cite = mod.Cite;
  }
  return Cite;
}

/** Built-in citation styles (bundled with Citation.js) */
export const BUILTIN_STYLES = ['apa', 'vancouver', 'harvard1'] as const;

/** All supported citation styles — popular academic styles */
export const CITATION_STYLES = [
  // ── Popular ──
  { id: 'apa', name: 'APA (7th Edition)', group: 'popular' },
  { id: 'chicago-author-date', name: 'Chicago (Author-Date)', group: 'popular' },
  { id: 'ieee', name: 'IEEE', group: 'popular' },
  { id: 'harvard1', name: 'Harvard', group: 'popular' },
  { id: 'vancouver', name: 'Vancouver', group: 'popular' },
  { id: 'mla', name: 'MLA (9th Edition)', group: 'popular' },
  // ── Author-Date ──
  { id: 'american-sociological-association', name: 'ASA (Sociology)', group: 'author-date' },
  { id: 'american-political-science-association', name: 'APSA (Political Science)', group: 'author-date' },
  { id: 'chicago-note-bibliography', name: 'Chicago (Notes)', group: 'author-date' },
  { id: 'elsevier-harvard', name: 'Elsevier Harvard', group: 'author-date' },
  { id: 'turabian-author-date', name: 'Turabian (Author-Date)', group: 'author-date' },
  { id: 'cell', name: 'Cell', group: 'author-date' },
  { id: 'nature', name: 'Nature', group: 'numeric' },
  { id: 'science', name: 'Science', group: 'numeric' },
  // ── Numeric ──
  { id: 'american-chemical-society', name: 'ACS (Chemistry)', group: 'numeric' },
  { id: 'american-institute-of-physics', name: 'AIP (Physics)', group: 'numeric' },
  { id: 'american-medical-association', name: 'AMA (Medical)', group: 'numeric' },
  { id: 'springer-basic-author-date', name: 'Springer (Author-Date)', group: 'author-date' },
  { id: 'springer-lecture-notes-in-computer-science', name: 'Springer LNCS', group: 'numeric' },
  { id: 'acm-sig-proceedings', name: 'ACM SIGPLAN', group: 'numeric' },
  // ── Humanities ──
  { id: 'modern-humanities-research-association', name: 'MHRA', group: 'humanities' },
  { id: 'oxford-university-press-note', name: 'Oxford (Notes)', group: 'humanities' },
  { id: 'cambridge-university-press-numeric', name: 'Cambridge (Numeric)', group: 'numeric' },
  // ── Regional ──
  { id: 'din-1505-2', name: 'DIN 1505-2 (German)', group: 'regional' },
  { id: 'iso690-author-date-en', name: 'ISO 690 (Author-Date)', group: 'regional' },
  { id: 'gost-r-7-0-5-2008', name: 'GOST R 7.0.5 (Russian)', group: 'regional' },
] as const;

export type CitationStyleId = (typeof CITATION_STYLES)[number]['id'] | string;

/** Styles that use numeric [1], [2] references instead of [Author, Year] */
export const NUMERIC_STYLES = new Set([
  'ieee', 'vancouver', 'nature', 'science',
  'american-chemical-society', 'american-institute-of-physics',
  'american-medical-association', 'springer-lecture-notes-in-computer-science',
  'acm-sig-proceedings', 'cambridge-university-press-numeric',
]);

/** CSL template CDN URL */
const CSL_CDN = 'https://cdn.jsdelivr.net/gh/citation-style-language/styles@master';

/** Cache of loaded CSL templates */
const loadedTemplates = new Set<string>(BUILTIN_STYLES as unknown as string[]);

/** Load a CSL style template from CDN if not already loaded */
export async function ensureStyleLoaded(styleId: string): Promise<void> {
  if (loadedTemplates.has(styleId)) return;
  try {
    const CiteClass = await getCite();
    const config = CiteClass.plugins.config.get('@csl');
    const response = await fetch(`${CSL_CDN}/${styleId}.csl`);
    if (!response.ok) return; // Silently fail — will use fallback
    const xml = await response.text();
    config.templates.add(styleId, xml);
    loadedTemplates.add(styleId);
  } catch {
    // CDN fetch failed — style will use fallback formatting
  }
}

/** Check if a citation style uses numeric references */
export function isNumericStyle(style: string): boolean {
  return NUMERIC_STYLES.has(style);
}

/** Convert ResolvedMetadata to CSL-JSON object */
export function metadataToCsl(meta: ResolvedMetadata): Record<string, unknown> {
  const csl: Record<string, unknown> = {
    type: mapDocumentType(meta.document_type),
    title: meta.title || 'Untitled',
  };

  // Use structured creators if available, otherwise fall back to authors strings
  if (meta.creators && meta.creators.length > 0) {
    const authors = meta.creators.filter(c => c.role === 'author' || c.role === 'book_author');
    const editors = meta.creators.filter(c => c.role === 'editor');
    const translators = meta.creators.filter(c => c.role === 'translator');
    if (authors.length > 0) {
      csl.author = authors.map(c => ({ family: c.last_name, given: c.first_name }));
    }
    if (editors.length > 0) {
      csl.editor = editors.map(c => ({ family: c.last_name, given: c.first_name }));
    }
    if (translators.length > 0) {
      csl.translator = translators.map(c => ({ family: c.last_name, given: c.first_name }));
    }
  } else if (meta.authors && meta.authors.length > 0) {
    csl.author = meta.authors.map(parseName);
  }

  if (typeof meta.year === 'number') {
    csl.issued = { 'date-parts': [[meta.year]] };
  }

  if (meta.journal) csl['container-title'] = meta.journal;
  if (meta.volume) csl.volume = meta.volume;
  if (meta.issue) csl.issue = meta.issue;
  if (meta.pages) csl.page = meta.pages;
  if (meta.doi) csl.DOI = meta.doi;
  if (meta.isbn) csl.ISBN = meta.isbn;
  if (meta.issn) csl.ISSN = meta.issn;
  if (meta.url) csl.URL = meta.url;
  if (meta.publisher) csl.publisher = meta.publisher;
  if (meta.abstract) csl.abstract = meta.abstract;
  if (meta.language) csl.language = meta.language;

  // Generate a stable ID
  csl.id = generateCitationKey(meta);

  return csl;
}

/** Format a single inline citation, e.g. "(Smith et al., 2023)" */
export async function formatCitation(meta: ResolvedMetadata, style: string = 'apa'): Promise<string> {
  try {
    await ensureStyleLoaded(style);
    const CiteClass = await getCite();
    const cite = new CiteClass(metadataToCsl(meta));
    const result = cite.format('citation', {
      format: 'text',
      template: style,
      lang: 'en-US',
    });
    return result?.trim() || buildFallbackCitation(meta);
  } catch (error) {
    console.warn('[citation-formatter] formatCitation fallback:', error);
    return buildFallbackCitation(meta);
  }
}

/** Format a bracket citation, e.g. "[Smith et al., 2023]" */
export async function formatCitationShort(meta: ResolvedMetadata, style: string = 'apa'): Promise<string> {
  const citation = await formatCitation(meta, style);
  // Strip parentheses and wrap in brackets
  const stripped = citation.replace(/^\(/, '').replace(/\)$/, '');
  return `[${stripped}]`;
}

/** Format a single bibliography entry */
export async function formatBibliographyEntry(meta: ResolvedMetadata, style: string = 'apa'): Promise<string> {
  try {
    await ensureStyleLoaded(style);
    const CiteClass = await getCite();
    const cite = new CiteClass(metadataToCsl(meta));
    const result = cite.format('bibliography', {
      format: 'text',
      template: style,
      lang: 'en-US',
    });
    return result?.trim() || buildFallbackBibEntry(meta);
  } catch (error) {
    console.warn('[citation-formatter] formatBibliographyEntry fallback:', error);
    return buildFallbackBibEntry(meta);
  }
}

/** Format a full bibliography from multiple metadata entries */
export async function formatBibliography(metas: ResolvedMetadata[], style: string = 'apa'): Promise<string> {
  if (metas.length === 0) return '';
  try {
    const CiteClass = await getCite();
    const cslItems = metas.map(m => metadataToCsl(m));
    const cite = new CiteClass(cslItems);
    const result = cite.format('bibliography', {
      format: 'text',
      template: style,
      lang: 'en-US',
    });
    return result?.trim() || metas.map(m => buildFallbackBibEntry(m)).join('\n\n');
  } catch (error) {
    console.warn('[citation-formatter] formatBibliography fallback:', error);
    return metas.map(m => buildFallbackBibEntry(m)).join('\n\n');
  }
}

/** Export a single entry to BibTeX format */
export async function toBibTeX(meta: ResolvedMetadata): Promise<string> {
  try {
    const CiteClass = await getCite();
    const cite = new CiteClass(metadataToCsl(meta));
    const result = cite.format('bibtex');
    if (result?.trim()) return result.trim();
  } catch (error) {
    console.warn('[citation-formatter] toBibTeX fallback:', error);
  }
  return buildManualBibTeX(meta);
}

/** Export multiple entries as a .bib file */
export async function toBibTeXBatch(metas: ResolvedMetadata[]): Promise<string> {
  const entries = await Promise.all(metas.map(m => toBibTeX(m)));
  return entries.join('\n\n');
}

/** Export a single entry to RIS format */
export async function toRIS(meta: ResolvedMetadata): Promise<string> {
  try {
    const CiteClass = await getCite();
    const cite = new CiteClass(metadataToCsl(meta));
    const result = cite.format('ris');
    if (result?.trim()) return result.trim();
  } catch (error) {
    console.warn('[citation-formatter] toRIS fallback:', error);
  }
  return buildManualRIS(meta);
}

/** Export multiple entries as a .ris file */
export async function toRISBatch(metas: ResolvedMetadata[]): Promise<string> {
  const entries = await Promise.all(metas.map(m => toRIS(m)));
  return entries.join('\n\n');
}

/** Export metadata entries as CSV */
export function toCSV(metas: ResolvedMetadata[]): string {
  const headers = ['Citation Key', 'Title', 'Authors', 'Year', 'Journal', 'Volume', 'Issue', 'Pages', 'DOI', 'ISBN', 'Publisher', 'URL', 'Type'];
  const rows = metas.map(m => [
    generateCitationKey(m),
    escapeCsvField(m.title || ''),
    escapeCsvField((m.authors || []).join('; ')),
    String(m.year || ''),
    escapeCsvField(m.journal || ''),
    escapeCsvField(m.volume || ''),
    escapeCsvField(m.issue || ''),
    escapeCsvField(m.pages || ''),
    escapeCsvField(m.doi || ''),
    escapeCsvField(m.isbn || ''),
    escapeCsvField(m.publisher || ''),
    escapeCsvField(m.url || ''),
    escapeCsvField(m.document_type || ''),
  ]);
  return [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
}

/** Generate a citation key like "Smith2023" or "SmithJones2023" */
export function generateCitationKey(meta: ResolvedMetadata): string {
  let authorPart = 'Unknown';
  // Prefer structured creators for key generation
  const authorCreators = meta.creators?.filter(c => c.role === 'author' || c.role === 'book_author');
  if (authorCreators && authorCreators.length > 0) {
    const firstName = authorCreators[0].last_name || 'Unknown';
    if (authorCreators.length === 1) {
      authorPart = firstName;
    } else if (authorCreators.length === 2) {
      authorPart = firstName + (authorCreators[1].last_name || '');
    } else {
      authorPart = firstName + 'EtAl';
    }
  } else if (meta.authors && meta.authors.length > 0) {
    const firstAuthor = meta.authors[0];
    const lastName = extractLastName(firstAuthor);
    if (meta.authors.length === 1) {
      authorPart = lastName;
    } else if (meta.authors.length === 2) {
      authorPart = lastName + extractLastName(meta.authors[1]);
    } else {
      authorPart = lastName + 'EtAl';
    }
  }
  const yearPart = typeof meta.year === 'number' ? String(meta.year) : '';
  return sanitizeKey(authorPart + yearPart);
}

// --- Internal helpers ---

function parseName(fullName: string): { family: string; given: string } {
  const parts = fullName.trim().split(/,\s*/);
  if (parts.length >= 2) {
    return { family: parts[0], given: parts.slice(1).join(' ') };
  }
  const words = fullName.trim().split(/\s+/);
  if (words.length === 1) {
    return { family: words[0], given: '' };
  }
  return { family: words[words.length - 1], given: words.slice(0, -1).join(' ') };
}

function extractLastName(fullName: string): string {
  const parts = fullName.trim().split(/,\s*/);
  if (parts.length >= 2) return parts[0].replace(/\s+/g, '');
  const words = fullName.trim().split(/\s+/);
  return words[words.length - 1].replace(/\s+/g, '');
}

function sanitizeKey(key: string): string {
  return key.replace(/[^a-zA-Z0-9]/g, '');
}

function mapDocumentType(docType?: string): string {
  if (!docType) return 'article-journal';
  const lower = docType.toLowerCase();
  if (lower.includes('book')) return 'book';
  if (lower.includes('chapter')) return 'chapter';
  if (lower.includes('conference') || lower.includes('proceeding')) return 'paper-conference';
  if (lower.includes('thesis') || lower.includes('dissertation')) return 'thesis';
  if (lower.includes('report')) return 'report';
  if (lower.includes('patent')) return 'patent';
  return 'article-journal';
}

function escapeCsvField(value: string): string {
  if (value.includes(',') || value.includes('"') || value.includes('\n')) {
    return '"' + value.replace(/"/g, '""') + '"';
  }
  return value;
}

function buildFallbackCitation(meta: ResolvedMetadata): string {
  const author = meta.authors?.[0] ? extractLastName(meta.authors[0]) : 'Unknown';
  const etAl = meta.authors && meta.authors.length > 2 ? ' et al.' : '';
  const year = typeof meta.year === 'number' ? String(meta.year) : 'n.d.';
  return `(${author}${etAl}, ${year})`;
}

function buildFallbackBibEntry(meta: ResolvedMetadata): string {
  const authors = (meta.authors || []).join(', ') || 'Unknown Author';
  const year = typeof meta.year === 'number' ? ` (${meta.year}).` : '.';
  const title = meta.title || 'Untitled';
  const journal = meta.journal ? ` ${meta.journal}.` : '';
  const doi = meta.doi ? ` https://doi.org/${meta.doi}` : '';
  return `${authors}${year} ${title}.${journal}${doi}`;
}

function buildManualBibTeX(meta: ResolvedMetadata): string {
  const key = generateCitationKey(meta);
  const type = meta.document_type?.toLowerCase().includes('book') ? 'book' : 'article';
  const lines: string[] = [`@${type}{${key},`];

  if (meta.authors && meta.authors.length > 0) {
    lines.push(`  author = {${meta.authors.join(' and ')}},`);
  }
  if (meta.title) lines.push(`  title = {${meta.title}},`);
  if (meta.journal) lines.push(`  journal = {${meta.journal}},`);
  if (typeof meta.year === 'number') lines.push(`  year = {${meta.year}},`);
  if (meta.volume) lines.push(`  volume = {${meta.volume}},`);
  if (meta.issue) lines.push(`  number = {${meta.issue}},`);
  if (meta.pages) lines.push(`  pages = {${meta.pages}},`);
  if (meta.doi) lines.push(`  doi = {${meta.doi}},`);
  if (meta.isbn) lines.push(`  isbn = {${meta.isbn}},`);
  if (meta.publisher) lines.push(`  publisher = {${meta.publisher}},`);
  if (meta.url) lines.push(`  url = {${meta.url}},`);

  lines.push('}');
  return lines.join('\n');
}

/** Parse a BibTeX string into ResolvedMetadata entries using Citation.js */
export async function parseBibTeX(bibtexString: string): Promise<ResolvedMetadata[]> {
  const CiteClass = await getCite();
  const cite = new CiteClass(bibtexString);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Citation.js CSL-JSON objects are loosely typed
  const cslItems: any[] = cite.data;

  return cslItems.map((item) => {
    const meta: ResolvedMetadata = {
      title: item.title || 'Untitled',
    };

    // Convert CSL author objects to string array
    if (Array.isArray(item.author)) {
      meta.authors = item.author.map((a: { family?: string; given?: string; literal?: string }) => {
        if (a.literal) return a.literal;
        const parts = [a.given, a.family].filter(Boolean);
        return parts.join(' ') || 'Unknown';
      });
    }

    // Extract year from issued date-parts
    if (item.issued?.['date-parts']?.[0]?.[0]) {
      meta.year = Number(item.issued['date-parts'][0][0]);
    }

    if (item['container-title']) meta.journal = item['container-title'];
    if (item.volume) meta.volume = String(item.volume);
    if (item.issue) meta.issue = String(item.issue);
    if (item.page) meta.pages = String(item.page);
    if (item.DOI) meta.doi = item.DOI;
    if (item.ISBN) meta.isbn = item.ISBN;
    if (item.ISSN) meta.issn = item.ISSN;
    if (item.URL) meta.url = item.URL;
    if (item.publisher) meta.publisher = item.publisher;
    if (item.abstract) meta.abstract = item.abstract;
    if (item.language) meta.language = item.language;

    // Map CSL type back to document_type
    if (item.type) {
      const typeMap: Record<string, string> = {
        'article-journal': 'article',
        'book': 'book',
        'chapter': 'chapter',
        'paper-conference': 'conference',
        'thesis': 'thesis',
        'report': 'report',
      };
      meta.document_type = typeMap[item.type] || item.type;
    }

    return meta;
  });
}

/** Export metadata entries as Pandoc-compatible Markdown reference list with [@Key] syntax */
export function toMarkdownCitations(metas: ResolvedMetadata[]): string {
  if (metas.length === 0) return '';
  const lines = metas.map(m => {
    const key = generateCitationKey(m);
    const authors = (m.authors || []).join(', ') || 'Unknown Author';
    const year = typeof m.year === 'number' ? ` (${m.year}).` : '.';
    const title = m.title || 'Untitled';
    const journal = m.journal ? ` *${m.journal}*.` : '';
    const doi = m.doi ? ` <https://doi.org/${m.doi}>` : '';
    return `[@${key}]: ${authors}${year} *${title}*.${journal}${doi}`;
  });
  return lines.join('\n\n');
}

function buildManualRIS(meta: ResolvedMetadata): string {
  const type = meta.document_type?.toLowerCase().includes('book') ? 'BOOK' : 'JOUR';
  const lines: string[] = [`TY  - ${type}`];

  if (meta.authors) {
    meta.authors.forEach(a => lines.push(`AU  - ${a}`));
  }
  if (meta.title) lines.push(`TI  - ${meta.title}`);
  if (meta.journal) lines.push(`JO  - ${meta.journal}`);
  if (typeof meta.year === 'number') lines.push(`PY  - ${meta.year}`);
  if (meta.volume) lines.push(`VL  - ${meta.volume}`);
  if (meta.issue) lines.push(`IS  - ${meta.issue}`);
  if (meta.pages) {
    const parts = meta.pages.split('-');
    lines.push(`SP  - ${parts[0].trim()}`);
    if (parts.length > 1) lines.push(`EP  - ${parts[1].trim()}`);
  }
  if (meta.doi) lines.push(`DO  - ${meta.doi}`);
  if (meta.isbn) lines.push(`SN  - ${meta.isbn}`);
  if (meta.publisher) lines.push(`PB  - ${meta.publisher}`);
  if (meta.url) lines.push(`UR  - ${meta.url}`);
  if (meta.abstract) lines.push(`AB  - ${meta.abstract}`);

  lines.push('ER  -');
  return lines.join('\n');
}
