/**
 * 7.4 — TipTap JSON → LaTeX converter (pure frontend).
 *
 * Walks the editor's JSON tree and emits a LaTeX `.tex` body plus a
 * paired `.bib` string built from inline citation marks. The conversion
 * is rule-based per node type — no LLM, no server roundtrip — so it can
 * run in the browser the moment the user clicks "Export → LaTeX".
 *
 * Why client-side: TipTap has no Python equivalent, and the only
 * server-side option would be to invoke a Node sidecar.  Keeping the
 * transform here avoids a new container and means we never round-trip
 * the user's note text through another service.
 *
 * Round-trip with Overleaf-style consumers is the goal; we therefore
 * generate `\cite{key}` markers and a paired BibTeX file rather than
 * inlining bibliographic entries (which Overleaf would refuse to
 * recompile against another `.bib`).
 */
import type { JSONContent } from '@tiptap/core';

export type LatexPreambleTemplate = 'article' | 'imrad' | 'minimal' | 'none';

export interface LatexExportOptions {
  /** Document preamble. `'none'` returns body only — useful when the
   *  user wants to paste into an existing Overleaf project. */
  preamble?: LatexPreambleTemplate;
  /** Document title — typeset as `\title{}`.  Falls back to the first
   *  H1 when omitted. */
  title?: string;
  /** Optional authors — typeset as `\author{}`. */
  authors?: string[];
  /** Locale used for `\usepackage[<lang>]{babel}`. */
  babelLanguage?: 'english' | 'croatian';
  /** When set, emits `\graphicspath{{<path>}}` so `\includegraphics`
   *  resolves relative to a sibling images directory (e.g. `'images/'`
   *  when bundling for Overleaf round-trip). */
  imagePath?: string;
}

export interface LatexExportResult {
  /** Full `.tex` source (preamble + body), ready to write to disk. */
  tex: string;
  /** Paired `.bib` content; empty string when the note had no
   *  citations. */
  bib: string;
  /** How many `\cite{}` calls were emitted — handy for surfacing in the
   *  export dialog ("12 citations included"). */
  citationCount: number;
}

interface CitationEntry {
  key: string;
  /** CSL-JSON-ish payload used to assemble the BibTeX entry. */
  metadata: Record<string, unknown>;
}

interface WalkContext {
  out: string[];
  citations: Map<string, CitationEntry>;
  /** Suppress `\par` between blocks while inside a list / blockquote
   *  where each item gets its own paragraph rule. */
  inListDepth: number;
}

/** Escape rules for LaTeX. Order matters — backslash MUST be first so
 *  the slashes we insert in later rules don't get re-escaped. The
 *  string-typed rules use `replace(pattern, str)` directly; the
 *  function-typed rule wraps each match in `\<char>`. */
function escapeLatex(text: string): string {
  return text
    .replace(/\\/g, '\\textbackslash{}')
    .replace(/([&%$#_{}])/g, '\\$1')
    .replace(/~/g, '\\textasciitilde{}')
    .replace(/\^/g, '\\textasciicircum{}');
}

/** Build a citation key from author + year, falling back to a hash of
 *  the title so the key stays stable across exports of the same doc. */
function citationKey(meta: Record<string, unknown>, fallbackId: string): string {
  const authors = meta.authors as string[] | undefined;
  const year = (meta.year as string | undefined) || '';
  const firstAuthor = (authors && authors[0]) || '';
  // Strip non-letters from the surname segment, keep year digits only.
  const surname =
    firstAuthor
      .split(/\s+/)
      .pop()
      ?.toLowerCase()
      .replace(/[^a-z]/g, '') || '';
  const yearDigits = year.replace(/[^0-9]/g, '');
  if (surname && yearDigits) return `${surname}${yearDigits}`;
  // Fallback: stable but ugly. Better than colliding keys.
  return `cite${fallbackId.replace(/[^a-zA-Z0-9]/g, '')}`;
}

/** Disambiguate keys that would otherwise collide ("smith2024" twice
 *  → smith2024a, smith2024b).  Mutates the citations map. */
function disambiguateKeys(citations: Map<string, CitationEntry>): void {
  const byKey = new Map<string, string[]>();
  for (const [docId, entry] of citations) {
    const list = byKey.get(entry.key) ?? [];
    list.push(docId);
    byKey.set(entry.key, list);
  }
  for (const [baseKey, docIds] of byKey) {
    if (docIds.length <= 1) continue;
    docIds.forEach((docId, idx) => {
      const suffix = String.fromCharCode(97 + idx); // a, b, c…
      const entry = citations.get(docId)!;
      entry.key = `${baseKey}${suffix}`;
    });
  }
}

function walkText(node: JSONContent, ctx: WalkContext): void {
  const raw = node.text ?? '';
  if (!raw) return;
  const marks = node.marks ?? [];
  // Citation marks short-circuit: emit \cite{} regardless of inner text
  // (inner text is the user's display label, e.g. "(Smith 2024)").
  // The citation extension registers its mark as `citationMark` (see
  // citation-mark.tsx), not the plural `citation`. Earlier this matcher
  // missed every cite in the document — no \cite{} markers in the .tex,
  // no references.bib downloaded.
  const citationMark = marks.find((m) => m.type === 'citationMark' || m.type === 'citation');
  if (citationMark) {
    const attrs = citationMark.attrs ?? {};
    const docId = String(attrs.documentId ?? attrs.document_id ?? attrs.id ?? '');
    if (docId) {
      // The citation mark stores metadata as a JSON string in
      // `attrs.metadata` (see citation-mark.tsx addAttributes).
      // Older / direct callers may pass an object — accept both.
      let meta: Record<string, unknown>;
      if (typeof attrs.metadata === 'string' && attrs.metadata.trim()) {
        try { meta = JSON.parse(attrs.metadata); } catch { meta = {}; }
      } else if (attrs.metadata && typeof attrs.metadata === 'object') {
        meta = attrs.metadata as Record<string, unknown>;
      } else {
        meta = {
          title: attrs.title,
          authors: attrs.authors,
          year: attrs.year,
          doi: attrs.doi,
          url: attrs.url,
        };
      }
      const existing = ctx.citations.get(docId);
      const key = existing?.key ?? citationKey(meta, docId);
      if (!existing) ctx.citations.set(docId, { key, metadata: meta });
      ctx.out.push(`\\cite{${key}}`);
      return;
    }
  }

  let text = escapeLatex(raw);
  for (const mark of marks) {
    switch (mark.type) {
      case 'bold':
        text = `\\textbf{${text}}`;
        break;
      case 'italic':
        text = `\\textit{${text}}`;
        break;
      case 'underline':
        text = `\\underline{${text}}`;
        break;
      case 'strike':
        text = `\\sout{${text}}`;
        break;
      case 'code':
        text = `\\texttt{${text}}`;
        break;
      case 'link': {
        const href = String((mark.attrs as { href?: string } | undefined)?.href ?? '');
        if (href) text = `\\href{${href.replace(/[%#]/g, '\\$&')}}{${text}}`;
        break;
      }
      // Other marks (highlight, comment) are visual-only — drop.
    }
  }
  ctx.out.push(text);
}

function walkChildren(node: JSONContent, ctx: WalkContext): void {
  for (const child of node.content ?? []) walkNode(child, ctx);
}

function walkNode(node: JSONContent, ctx: WalkContext): void {
  switch (node.type) {
    case 'doc':
      walkChildren(node, ctx);
      break;
    case 'paragraph':
      walkChildren(node, ctx);
      ctx.out.push(ctx.inListDepth > 0 ? '' : '\n\n');
      break;
    case 'heading': {
      const level = Math.max(1, Math.min(5, (node.attrs?.level as number) || 1));
      const cmd = ['section', 'subsection', 'subsubsection', 'paragraph', 'subparagraph'][level - 1];
      const before = ctx.out.length;
      walkChildren(node, ctx);
      const headingText = ctx.out.splice(before).join('');
      ctx.out.push(`\\${cmd}{${headingText.trim()}}\n\n`);
      break;
    }
    case 'text':
      walkText(node, ctx);
      break;
    case 'hardBreak':
      ctx.out.push(' \\\\ ');
      break;
    case 'horizontalRule':
      ctx.out.push('\n\\hrulefill\n\n');
      break;
    case 'blockquote':
      ctx.out.push('\n\\begin{quote}\n');
      walkChildren(node, ctx);
      ctx.out.push('\\end{quote}\n\n');
      break;
    case 'codeBlock':
    case 'codeBlockWithLanguage': {
      const language = (node.attrs?.language as string | undefined) || '';
      const inner = (node.content ?? []).map((c) => c.text ?? '').join('');
      ctx.out.push(
        language
          ? `\n\\begin{lstlisting}[language=${language}]\n${inner}\n\\end{lstlisting}\n\n`
          : `\n\\begin{verbatim}\n${inner}\n\\end{verbatim}\n\n`,
      );
      break;
    }
    case 'bulletList':
      ctx.inListDepth += 1;
      ctx.out.push('\n\\begin{itemize}\n');
      walkChildren(node, ctx);
      ctx.out.push('\\end{itemize}\n\n');
      ctx.inListDepth -= 1;
      break;
    case 'orderedList':
      ctx.inListDepth += 1;
      ctx.out.push('\n\\begin{enumerate}\n');
      walkChildren(node, ctx);
      ctx.out.push('\\end{enumerate}\n\n');
      ctx.inListDepth -= 1;
      break;
    case 'listItem':
      ctx.out.push('  \\item ');
      walkChildren(node, ctx);
      ctx.out.push('\n');
      break;
    case 'image': {
      const src = String((node.attrs as { src?: string } | undefined)?.src ?? '');
      const alt = String((node.attrs as { alt?: string } | undefined)?.alt ?? '');
      // Refer images by basename — caller is expected to package the
      // file alongside the .tex.  Empty src silently dropped.
      const filename = src.split('/').pop() ?? '';
      if (filename) {
        ctx.out.push(
          `\n\\begin{figure}[h]\n\\centering\n\\includegraphics[width=0.8\\textwidth]{${filename}}\n` +
            (alt ? `\\caption{${escapeLatex(alt)}}\n` : '') +
            `\\end{figure}\n\n`,
        );
      }
      break;
    }
    case 'callout': {
      // Callouts have no native LaTeX equivalent. Emit a fbox so the
      // visual distinction survives at minimum quality.
      ctx.out.push('\n\\begin{center}\\fbox{\\begin{minipage}{0.9\\textwidth}\n');
      walkChildren(node, ctx);
      ctx.out.push('\\end{minipage}}\\end{center}\n\n');
      break;
    }
    case 'table': {
      // Best-effort tabular emission.  No cell-merging — TipTap exposes
      // colspan/rowspan but achemso-style tables expect simple grids.
      const rows = (node.content ?? []).filter((r) => r.type === 'tableRow');
      const colCount = rows[0]?.content?.length ?? 0;
      if (colCount === 0) break;
      ctx.out.push(`\n\\begin{tabular}{${'l'.repeat(colCount)}}\n`);
      rows.forEach((row, rowIdx) => {
        const cells = (row.content ?? []).map((cell) => {
          const before = ctx.out.length;
          walkChildren(cell, ctx);
          return ctx.out.splice(before).join('').trim();
        });
        ctx.out.push(cells.join(' & ') + ' \\\\');
        if (rowIdx === 0) ctx.out.push('\n\\hline');
        ctx.out.push('\n');
      });
      ctx.out.push('\\end{tabular}\n\n');
      break;
    }
    case 'bibliography':
      // Replaced by \printbibliography in the postamble.
      break;
    default:
      // Unknown node type — recurse children verbatim so we don't lose
      // user content.  Common case: a custom node we haven't taught
      // this converter about yet.
      walkChildren(node, ctx);
      break;
  }
}

const PREAMBLES: Record<LatexPreambleTemplate, (opts: LatexExportOptions) => string> = {
  none: () => '',
  minimal: () =>
    [
      '\\documentclass[11pt]{article}',
      '\\usepackage[utf8]{inputenc}',
      '\\usepackage[T1]{fontenc}',
      '\\usepackage{hyperref}',
      '',
      '\\begin{document}',
      '',
    ].join('\n'),
  article: (opts) =>
    [
      '\\documentclass[11pt]{article}',
      '\\usepackage[utf8]{inputenc}',
      '\\usepackage[T1]{fontenc}',
      `\\usepackage[${opts.babelLanguage ?? 'english'}]{babel}`,
      '\\usepackage{amsmath,amssymb}',
      '\\usepackage{graphicx}',
      opts.imagePath ? `\\graphicspath{{${opts.imagePath}}}` : '',
      '\\usepackage{hyperref}',
      '\\usepackage{ulem}',           // \sout for strikethrough
      '\\usepackage{listings}',
      '\\usepackage[backend=biber,style=numeric]{biblatex}',
      '\\addbibresource{references.bib}',
      '',
      opts.title ? `\\title{${escapeLatex(opts.title)}}` : '',
      opts.authors?.length ? `\\author{${opts.authors.map(escapeLatex).join(' \\and ')}}` : '',
      '',
      '\\begin{document}',
      opts.title ? '\\maketitle' : '',
      '',
    ]
      .filter(Boolean)
      .join('\n'),
  imrad: (opts) =>
    [
      '\\documentclass[11pt,a4paper]{article}',
      '\\usepackage[utf8]{inputenc}',
      '\\usepackage[T1]{fontenc}',
      `\\usepackage[${opts.babelLanguage ?? 'english'}]{babel}`,
      '\\usepackage{amsmath,amssymb}',
      '\\usepackage{graphicx}',
      opts.imagePath ? `\\graphicspath{{${opts.imagePath}}}` : '',
      '\\usepackage{geometry}\\geometry{margin=1in}',
      '\\usepackage{hyperref}',
      '\\usepackage{ulem}',
      '\\usepackage{listings}',
      '\\usepackage[backend=biber,style=authoryear]{biblatex}',
      '\\addbibresource{references.bib}',
      '',
      opts.title ? `\\title{${escapeLatex(opts.title)}}` : '',
      opts.authors?.length ? `\\author{${opts.authors.map(escapeLatex).join(' \\and ')}}` : '',
      '',
      '\\begin{document}',
      opts.title ? '\\maketitle' : '',
      '',
    ]
      .filter(Boolean)
      .join('\n'),
};

function postamble(preamble: LatexPreambleTemplate, hasCitations: boolean): string {
  if (preamble === 'none') return '';
  const parts: string[] = [];
  if (hasCitations) parts.push('\\printbibliography');
  parts.push('\\end{document}', '');
  return '\n' + parts.join('\n');
}

/** Build a single BibTeX entry from a citation's CSL-JSON-ish metadata.
 *  Accepts loosely typed input — the citation mark may have been
 *  stored with any of `metadata.{title,authors,year,doi,url,journal,
 *  publisher,isbn}`. */
function bibTexEntry(entry: CitationEntry): string {
  const m = entry.metadata as Record<string, unknown>;
  const escape = (v: unknown) =>
    String(v ?? '')
      .replace(/[{}]/g, '')
      .replace(/&/g, '\\&')
      .trim();
  const authors = (m.authors as string[] | undefined) ?? [];
  const fields: Array<[string, string]> = [];
  if (m.title) fields.push(['title', `{${escape(m.title)}}`]);
  if (authors.length) fields.push(['author', `{${authors.map(escape).join(' and ')}}`]);
  if (m.year) fields.push(['year', `{${escape(m.year)}}`]);
  if (m.journal) fields.push(['journal', `{${escape(m.journal)}}`]);
  if (m.publisher) fields.push(['publisher', `{${escape(m.publisher)}}`]);
  if (m.doi) fields.push(['doi', `{${escape(m.doi)}}`]);
  if (m.isbn) fields.push(['isbn', `{${escape(m.isbn)}}`]);
  if (m.url) fields.push(['url', `{${escape(m.url)}}`]);
  // Default to @article when journal is set, else @misc — covers the
  // common research-note case (papers + web sources).
  const entryType = m.journal ? 'article' : 'misc';
  return [
    `@${entryType}{${entry.key},`,
    ...fields.map(([k, v]) => `  ${k} = ${v},`),
    `}`,
  ].join('\n');
}

export function tipTapToLatex(
  doc: JSONContent,
  options: LatexExportOptions = {},
): LatexExportResult {
  const ctx: WalkContext = {
    out: [],
    citations: new Map(),
    inListDepth: 0,
  };
  walkNode(doc, ctx);
  disambiguateKeys(ctx.citations);

  const body = ctx.out.join('').replace(/\n{3,}/g, '\n\n').trim();
  const preambleKind: LatexPreambleTemplate = options.preamble ?? 'article';
  const preamble = PREAMBLES[preambleKind](options);
  const close = postamble(preambleKind, ctx.citations.size > 0);

  const tex = [preamble, body, close].filter(Boolean).join('\n');

  const bib = ctx.citations.size
    ? Array.from(ctx.citations.values()).map(bibTexEntry).join('\n\n') + '\n'
    : '';

  return { tex, bib, citationCount: ctx.citations.size };
}
