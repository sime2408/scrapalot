/**
 * 7.9 — line-level diff for the version-history view.
 *
 * Pure-JS LCS-based diff over plain text, with a v2 layer that picks
 * up mark / format changes per matching line so a paragraph that's
 * been bolded (or had its `<a href>` retargeted, or had an italic
 * span dropped) renders as an amber "format-change" row instead of
 * disappearing into the silent "same" bucket.
 *
 * Operates on lines because:
 *
 *   * Notes content is HTML; a character-level diff would surface every
 *     attribute change as a noisy edit (mark spans flicker on every
 *     auto-save) and visually drown the actual prose changes.
 *   * A line-level Myers/LCS diff is bounded by the paragraph count of
 *     a typical note (≤ a few hundred), so the O(n·m) cost is
 *     irrelevant at this scale.
 *
 * v2 mark detection: htmlToRichLines preserves the source HTML for
 * each plain-text line; after the LCS pass, every `same` row whose
 * old/new HTML differs in its mark set is reclassified as
 * `format-change` and the per-mark delta is attached so the renderer
 * can show what actually flipped (e.g. "+ strong / − em").
 *
 * Why not prosemirror-changeset: the library is built for tracking
 * Steps from a live Transaction, not for diffing two static documents.
 * Synthesising Steps from old → new requires constructing a Transform
 * and walking its step maps; for the line-anchored renderer we ship,
 * a regex-driven mark sniff is faster, schema-free, and deterministic.
 */

/** Mark types we surface in the diff. Keep this in sync with the
 *  TipTap extensions enabled in `collaborative-notes-editor.tsx` —
 *  citation-mark and comment-mark are intentionally OMITTED because
 *  they regenerate fresh ids on every render, which would make every
 *  diff look like a format-change even when the prose was untouched. */
const TRACKED_MARK_TAGS = ['strong', 'b', 'em', 'i', 'code', 'mark', 'u', 's', 'sup', 'sub'] as const;

/** Normalised mark name. Tag aliases collapse so `<b>` and `<strong>`
 *  count as the same mark. */
type Mark = 'strong' | 'em' | 'code' | 'mark' | 'underline' | 'strike' | 'sup' | 'sub' | `link:${string}`;

export type DiffOpKind = 'same' | 'add' | 'remove' | 'format-change';

export interface DiffLine {
  kind: DiffOpKind;
  text: string;
  /** Marks present on the new side but missing on the old. Set only
   *  when kind === 'format-change'. */
  marksAdded?: string[];
  /** Marks present on the old side but missing on the new. Set only
   *  when kind === 'format-change'. */
  marksRemoved?: string[];
}

/** Strip HTML tags and decode the most common entities so the diff
 *  view shows readable prose, not `<p>` markers. We do NOT use a
 *  DOMParser here because callers expect the function to work in any
 *  context (including SSR); the regex variant is sufficient for
 *  TipTap's HTML output. */
export function htmlToPlainLines(html: string): string[] {
  return htmlToRichLines(html).map((l) => l.text);
}

/** A line of HTML with both its plain-text projection (used as the
 *  LCS comparison key) and the original block HTML (kept around so
 *  the v2 mark-diff pass can detect inline format changes that the
 *  plain text strips away). */
export interface RichLine {
  text: string;
  html: string;
}

/** Split an HTML blob into per-paragraph rich lines. We segment on
 *  block-level closing tags + `<br>` so that paragraph structure
 *  survives into the diff, and we keep the OPENING markup of each
 *  block intact so subsequent passes can sniff inline marks. */
export function htmlToRichLines(html: string): RichLine[] {
  if (!html) return [{ text: '', html: '' }];

  // Insert sentinel newlines after each block close so we can split
  // on '\n' but keep track of the block HTML span via the order of
  // the original string. We do this by walking the source linearly.
  const out: RichLine[] = [];
  let buffer = '';
  const flush = () => {
    const trimmedHtml = buffer.trim();
    const text = stripHtml(trimmedHtml).trim();
    out.push({ text, html: trimmedHtml });
    buffer = '';
  };

  // Tokeniser-lite: walk the html and break on block-close tags + <br>.
  const blockBreakRe = /<\/(p|h[1-6]|li|blockquote|pre|tr|div)\s*>|<br\s*\/?>/gi;
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = blockBreakRe.exec(html))) {
    buffer += html.slice(cursor, match.index + match[0].length);
    flush();
    cursor = match.index + match[0].length;
  }
  // Tail (anything after the last block close, e.g. trailing inline span).
  buffer += html.slice(cursor);
  if (buffer.trim().length > 0) flush();

  // Collapse runs of empty rich-lines into at most one — same shape
  // the original htmlToPlainLines used to produce.
  const collapsed: RichLine[] = [];
  for (const l of out) {
    if (l.text === '' && collapsed.length > 0 && collapsed[collapsed.length - 1].text === '') continue;
    collapsed.push(l);
  }
  return collapsed.length > 0 ? collapsed : [{ text: '', html: '' }];
}

/** Plain-text projection of an HTML fragment. Decodes the common
 *  entities so the diff view reads as prose. */
function stripHtml(html: string): string {
  return html
    .replace(/<\/?[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

/** Walk a chunk of HTML and pull out the tracked inline marks. Tag
 *  aliases collapse so `<b>` and `<strong>` are reported as a single
 *  `strong` mark, and `<a href="...">` is keyed on its href so a link
 *  retarget shows up as a format change too. */
function extractMarks(html: string): Set<Mark> {
  const marks = new Set<Mark>();
  if (!html) return marks;

  // <strong>, <em>, <code>, <mark>, <u>, <s>, <sup>, <sub> + their
  // aliases. We only inspect opening tags — if a span exists at all,
  // the mark is "present" on this line. For nested or repeated marks
  // the Set semantics keep the comparison stable.
  for (const tag of TRACKED_MARK_TAGS) {
    const re = new RegExp(`<${tag}\\b[^>]*>`, 'i');
    if (re.test(html)) {
      switch (tag) {
        case 'b':
        case 'strong': marks.add('strong'); break;
        case 'i':
        case 'em':     marks.add('em'); break;
        case 'code':   marks.add('code'); break;
        case 'mark':   marks.add('mark'); break;
        case 'u':      marks.add('underline'); break;
        case 's':      marks.add('strike'); break;
        case 'sup':    marks.add('sup'); break;
        case 'sub':    marks.add('sub'); break;
      }
    }
  }

  // Links: emit one `link:<href>` entry per distinct href so a
  // re-targeted link surfaces as `+ link:new − link:old` in the diff.
  const linkRe = /<a\b[^>]*\bhref\s*=\s*"([^"]*)"[^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = linkRe.exec(html))) {
    marks.add(`link:${m[1]}` as Mark);
  }
  return marks;
}

/** Symmetric difference of two mark sets, projected to display strings.
 *  Returns `null` when the sets are equal so callers can short-circuit
 *  the format-change path on identical lines. */
function diffMarks(
  oldMarks: Set<Mark>,
  newMarks: Set<Mark>,
): { added: string[]; removed: string[] } | null {
  const added: string[] = [];
  const removed: string[] = [];
  for (const m of newMarks) if (!oldMarks.has(m)) added.push(m);
  for (const m of oldMarks) if (!newMarks.has(m)) removed.push(m);
  if (added.length === 0 && removed.length === 0) return null;
  return { added, removed };
}

/** Standard LCS table — O(n·m). Returns a 2-D number array. */
function lcsTable(a: string[], b: string[]): number[][] {
  const n = a.length;
  const m = b.length;
  const t: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      if (a[i - 1] === b[j - 1]) {
        t[i][j] = t[i - 1][j - 1] + 1;
      } else {
        t[i][j] = Math.max(t[i - 1][j], t[i][j - 1]);
      }
    }
  }
  return t;
}

/** Walk the LCS table from (n, m) back to the origin to produce the
 *  ordered diff sequence. Standard backtracking — emits 'same' when
 *  both sides advance, 'remove' when only the LHS advances, 'add'
 *  when only the RHS advances.
 *
 *  After the line-level pass we run a second sweep over each `same`
 *  row, comparing the rich-HTML mark sets between old and new. When
 *  the marks differ — e.g. the writer bolded a paragraph — the row
 *  is reclassified as `format-change` and the per-mark delta is
 *  attached so the renderer can show what flipped. */
export function diffLines(oldHtml: string, newHtml: string): DiffLine[] {
  const a = htmlToRichLines(oldHtml);
  const b = htmlToRichLines(newHtml);
  const aText = a.map((l) => l.text);
  const bText = b.map((l) => l.text);
  const t = lcsTable(aText, bText);
  // Walk the table and remember which (old, new) line indices produced
  // each `same` row so we can do a paired mark inspection afterwards.
  type Tagged = { kind: DiffOpKind; text: string; oldIdx?: number; newIdx?: number };
  const tagged: Tagged[] = [];
  let i = a.length;
  let j = b.length;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && aText[i - 1] === bText[j - 1]) {
      tagged.push({ kind: 'same', text: aText[i - 1], oldIdx: i - 1, newIdx: j - 1 });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || t[i][j - 1] >= t[i - 1][j])) {
      tagged.push({ kind: 'add', text: bText[j - 1], newIdx: j - 1 });
      j--;
    } else {
      tagged.push({ kind: 'remove', text: aText[i - 1], oldIdx: i - 1 });
      i--;
    }
  }
  tagged.reverse();

  // v2 mark sweep — promote `same` rows whose mark sets diverge to
  // `format-change`. Empty lines are excluded because their HTML is
  // typically a stripped-out `<p></p>` with no inline content; we
  // would otherwise generate a noisy amber row for every blank break.
  return tagged.map((row) => {
    if (row.kind !== 'same' || row.text === '' || row.oldIdx === undefined || row.newIdx === undefined) {
      return { kind: row.kind, text: row.text };
    }
    const delta = diffMarks(extractMarks(a[row.oldIdx].html), extractMarks(b[row.newIdx].html));
    if (!delta) return { kind: 'same', text: row.text };
    return {
      kind: 'format-change',
      text: row.text,
      marksAdded: delta.added,
      marksRemoved: delta.removed,
    };
  });
}

/** Aggregate counts for the dialog header summary
 *  ("+ 23 / − 8 / ~ 4 / 12 unchanged"). */
export function diffSummary(
  diff: DiffLine[],
): { added: number; removed: number; formatChanged: number; same: number } {
  return diff.reduce(
    (acc, d) => {
      if (d.kind === 'add') acc.added += 1;
      else if (d.kind === 'remove') acc.removed += 1;
      else if (d.kind === 'format-change') acc.formatChanged += 1;
      else acc.same += 1;
      return acc;
    },
    { added: 0, removed: 0, formatChanged: 0, same: 0 },
  );
}
