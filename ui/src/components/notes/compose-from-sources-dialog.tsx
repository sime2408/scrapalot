/**
 * 7.3 — Compose from Sources dialog.
 *
 * Behaviour, props, and request/response shape are unchanged from v1.
 * What changed is the visual structure, deliberately kept inside the
 * `docs/README_STYLE.md` constraints:
 *
 *   * Inter sans-only (no `font-serif`, no `font-mono` for eyebrows or
 *     prose), `tracking-wide` rather than arbitrary `tracking-[Xem]`,
 *     borders over shadows, sharp corners (`!rounded-none`), semantic
 *     tokens (`bg-card`, `text-muted-foreground`, `border-border`,
 *     `bg-primary`, `text-destructive`).
 *
 *   * Three numbered process steps (`01 — TOPIC / 02 — LENGTH /
 *     03 — RESULT`) in an uppercase `tracking-wide` eyebrow strip with
 *     a leading status dot. The active step shifts to foreground tone.
 *
 *   * Run-status pill (idle / no-scope / composing / grounded /
 *     timeout / no-match / failed / no-citations) named explicitly
 *     instead of collapsing every empty result into one ambiguous line.
 *
 *   * State-aware layout. Pre-run: single-column control panel —
 *     textarea + length picker (rows with leading radio dot, replacing
 *     the old button group) + full-width Generate. Post-run: 3:2 split
 *     — prose on the left, numbered sources apparatus on the right.
 *     A 1px primary bar scrolls during composition (one inline
 *     `<style>` keyframe so the redesign stays self-contained).
 *
 * Markers → citation marks: see `rewriteMarkersToCitationHtml` below.
 * Why a buffered preview rather than streaming-into-cursor: writers
 * want to *review* before committing model-generated prose to the doc,
 * and a buffered render also lets us surface the chunks the model was
 * grounded on (one card per source, with a chunk excerpt) so a bad
 * retrieval is dismissable before any text lands.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Dialog,
  DialogContent,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import {
  Loader2,
  AlertCircle,
  Check,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { toast } from '@/lib/toast-compat';
import {
  composeFromSources,
  type ComposeFromSourcesResponse,
  type ComposedSource,
} from '@/lib/api-notes-assistant';
import type { Editor } from '@tiptap/core';

interface ComposeFromSourcesDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** TipTap editor reference. The dialog inserts the composed prose
   *  at the current cursor position when the user clicks "Insert". */
  editor: Editor | null;
  /** Active research-context collections — passed straight through to
   *  the RPC. Empty list = no retrieval; the model still writes but
   *  emits no citations. */
  collectionIds: string[];
  /** Optional pre-fill for the topic textarea (e.g. when invoked from
   *  the cursor parked on an outline H2). */
  defaultTopic?: string;
  /** Optional outline-section anchor — passed as a prompt steer when
   *  the writer is filling a specific outline section from 7.2. */
  outlineSectionAnchor?: string;
}

type LengthChoice = 'short' | 'medium' | 'long';

/** Visible status of a single dialog session — drives the status strip
 *  copy and dot tone. Computed from `loading`, `result`, scope size and
 *  the soft-warning code on the response. */
type RunStatus =
  | 'idle'        // dialog open, no run yet, scope present
  | 'no-scope'    // dialog open, no run yet, scope empty
  | 'composing'   // request in flight
  | 'ready'       // run done, sources cited
  | 'timeout'     // run done, retrieval hit the 30 s budget
  | 'no-match'    // run done, retrieval ran cleanly but matched nothing
  | 'failed'      // run failed at any layer
  | 'soft-no-citations'; // run done with scope but model emitted no citations

/** Once-mounted CSS keyframe for the typesetter rule that scrolls
 *  during composition. Inline rather than in tailwind.config so this
 *  redesign is self-contained. */
const KEYFRAMES_CSS = `
@keyframes notes-compose-typesetter {
  0%   { transform: translateX(-100%); }
  100% { transform: translateX(420%); }
}
`;

/** Replace `[source-N]` markers in the composed text with TipTap-
 *  citation-mark HTML pointing at the source's document_id. We build
 *  HTML rather than driving the editor command directly because the
 *  composed text may contain dozens of markers — one round-trip via
 *  the markdown-paste pipeline is faster than dozens of imperative
 *  setCitationMark calls. */
function rewriteMarkersToCitationHtml(
  composedText: string,
  sources: ComposedSource[],
): string {
  const byNumber = new Map<number, ComposedSource>();
  sources.forEach((s) => byNumber.set(s.source_number, s));
  const escapeAttr = (v: string): string =>
    v.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const paragraphs = composedText
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);

  const renderParagraph = (text: string): string => {
    const out: string[] = [];
    let i = 0;
    const re = /\[source[-\s_]?(\d+)\]/gi;
    let match: RegExpExecArray | null;
    while ((match = re.exec(text))) {
      out.push(escapeAttr(text.slice(i, match.index)));
      const num = parseInt(match[1], 10);
      const src = byNumber.get(num);
      if (src) {
        const meta = JSON.stringify(src.citation || {});
        out.push(
          `<cite data-citation-id="${escapeAttr(src.document_id)}-${num}" ` +
            `data-document-id="${escapeAttr(src.document_id)}" ` +
            `data-formatted-short="${escapeAttr(`(${src.source_title})`)}" ` +
            `data-citation-style="apa" ` +
            `data-citation-metadata="${escapeAttr(meta)}" ` +
            `class="citation-mark">${escapeAttr(`[${num}]`)}</cite>`,
        );
      }
      i = match.index + match[0].length;
    }
    out.push(escapeAttr(text.slice(i)));
    return `<p>${out.join('')}</p>`;
  };

  return paragraphs.map(renderParagraph).join('');
}

/** Last book-title segment off a path-style source title. The backend
 *  often hands back `/app/data/tmp/scrapalot_<uuid>` for files that
 *  haven't picked up a clean `cmetadata.title` yet — we render the
 *  short tail so the apparatus stays readable. */
function shortenSourceTitle(raw: string): string {
  if (!raw) return 'Unknown';
  const cleaned = raw.replace(/\\/g, '/').split('/').filter(Boolean).pop() ?? raw;
  return cleaned.replace(/\.(pdf|epub|docx|txt|md|html?)$/i, '');
}

export const ComposeFromSourcesDialog: React.FC<ComposeFromSourcesDialogProps> = ({
  open,
  onOpenChange,
  editor,
  collectionIds,
  defaultTopic = '',
  outlineSectionAnchor = '',
}) => {
  const { t } = useTranslation();
  const [topic, setTopic] = useState(defaultTopic);
  const [length, setLength] = useState<LengthChoice>('medium');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<ComposeFromSourcesResponse | null>(null);

  // Snapshot of editor text around the caret at the moment the dialog
  // opened.  The retrieval similarity search runs against this (not
  // the typed topic field) so the chunks the LLM sees are relevant to
  // what the writer is actively typing rather than to a generic theme.
  // Re-snapshotted on every dialog open — the writer might move
  // between sentences between runs.
  const [cursorContext, setCursorContext] = useState<{ before: string; after: string }>({
    before: '',
    after: '',
  });

  useEffect(() => {
    if (!open) return;
    setTopic(defaultTopic);
    setResult(null);
    if (editor) {
      const { state } = editor;
      const { from, to } = state.selection;
      const start = Math.max(0, from - 4000);
      const end = Math.min(state.doc.content.size, to + 4000);
      setCursorContext({
        before: state.doc.textBetween(start, from, '\n', ' '),
        after: state.doc.textBetween(to, end, '\n', ' '),
      });
    } else {
      setCursorContext({ before: '', after: '' });
    }
  }, [open, defaultTopic, editor]);

  // Either an explicit topic or non-empty cursor context lets us run.
  const hasCursorContext =
    cursorContext.before.trim().length > 20 || cursorContext.after.trim().length > 20;
  const canRun = (topic.trim().length >= 5 || hasCursorContext) && !loading;
  const noCollections = collectionIds.length === 0;
  const sources = result?.sources ?? [];
  const sourcesCount = sources.length;
  const composedText = result?.composed_text ?? '';
  const wordCount = useMemo(
    () => composedText.trim().split(/\s+/).filter(Boolean).length,
    [composedText],
  );

  // Map (loading, result, scope size, soft-warning code) → run status.
  const status: RunStatus = useMemo(() => {
    if (loading) return 'composing';
    if (!result) return noCollections ? 'no-scope' : 'idle';
    if (!result.success) return 'failed';
    const code = result.error || '';
    if (code === 'retrieval_timeout') return 'timeout';
    if (code === 'retrieval_no_match') return 'no-match';
    if (code === 'retrieval_failed') return 'failed';
    if (sourcesCount === 0 && collectionIds.length > 0) return 'soft-no-citations';
    return 'ready';
  }, [loading, result, noCollections, collectionIds.length, sourcesCount]);

  // True once we have prose to render (regardless of citations) — flips
  // the layout from "control panel" to "manuscript leaf + apparatus".
  const showReadingLayout = !!result?.success && composedText.length > 0;

  const run = useCallback(async () => {
    setLoading(true);
    try {
      const res = await composeFromSources(topic.trim(), collectionIds, {
        target_length: length,
        outline_section_anchor: outlineSectionAnchor || undefined,
        text_before_cursor: cursorContext.before,
        text_after_cursor: cursorContext.after,
      });
      setResult(res);
      if (!res.success) {
        toast({
          title: t('notes.composeFromSources.toastError.title', 'Composition failed'),
          description:
            res.error === 'empty_topic'
              ? t('notes.composeFromSources.toastError.emptyTopic', 'Topic is too short.')
              : t(
                  'notes.composeFromSources.toastError.description',
                  'The model could not produce a passage. Try again.',
                ),
          variant: 'destructive',
        });
      }
    } catch (err) {
      console.error('[ComposeFromSourcesDialog] composeFromSources failed', err);
      toast({
        title: t('notes.composeFromSources.toastError.title', 'Composition failed'),
        description: t(
          'notes.composeFromSources.toastError.description',
          'The model could not produce a passage. Try again.',
        ),
        variant: 'destructive',
      });
    } finally {
      setLoading(false);
    }
  }, [topic, length, collectionIds, outlineSectionAnchor, cursorContext, t]);

  const insertIntoNote = useCallback(() => {
    if (!editor || !result?.composed_text) return;
    const html = rewriteMarkersToCitationHtml(result.composed_text, result.sources);
    editor.chain().focus().insertContent(html).run();
    onOpenChange(false);
    toast.success(
      t('notes.composeFromSources.inserted', 'Composed passage inserted into note.'),
    );
  }, [editor, result, onOpenChange, t]);

  // Length picker — explicit numeric hints so the user knows what
  // they're choosing without reading docs. Approximate word counts
  // mirror the backend's _LENGTH_BUDGETS.
  const lengthOptions: Array<{ key: LengthChoice; words: number }> = [
    { key: 'short', words: 200 },
    { key: 'medium', words: 500 },
    { key: 'long', words: 1500 },
  ];
  const lengthLabel = (key: LengthChoice): string =>
    ({
      short: t('notes.composeFromSources.lengthShortBare', 'Short'),
      medium: t('notes.composeFromSources.lengthMediumBare', 'Medium'),
      long: t('notes.composeFromSources.lengthLongBare', 'Long'),
    }[key]);

  // Status strip dot tone + label, derived from RunStatus.
  const statusToken: { label: string; tone: 'muted' | 'primary' | 'destructive' } = (() => {
    switch (status) {
      case 'idle':
        return { label: t('notes.composeFromSources.statusIdle', 'Awaiting input'), tone: 'muted' };
      case 'no-scope':
        return {
          label: t('notes.composeFromSources.statusNoScope', 'No collection scope'),
          tone: 'muted',
        };
      case 'composing':
        return { label: t('notes.composeFromSources.statusComposing', 'Composing'), tone: 'primary' };
      case 'ready':
        return { label: t('notes.composeFromSources.statusReady', 'Grounded'), tone: 'primary' };
      case 'timeout':
        return {
          label: t('notes.composeFromSources.statusTimeout', 'Retrieval timed out'),
          tone: 'destructive',
        };
      case 'no-match':
        return {
          label: t('notes.composeFromSources.statusNoMatch', 'No matching passages'),
          tone: 'muted',
        };
      case 'failed':
        return { label: t('notes.composeFromSources.statusFailed', 'Failed'), tone: 'destructive' };
      case 'soft-no-citations':
        return {
          label: t('notes.composeFromSources.statusSoftNoCitations', 'No citations emitted'),
          tone: 'muted',
        };
    }
  })();

  // Scope summary (right side of status strip) — explicit count beats
  // a generic "with scope" badge.
  const scopeLabel: string = noCollections
    ? t('notes.composeFromSources.scopeNone', 'No scope')
    : collectionIds.length === 1
      ? t('notes.composeFromSources.scopeOne', '1 collection in scope')
      : t('notes.composeFromSources.scopeOther', '{{count}} collections in scope', {
          count: collectionIds.length,
        });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        data-testid="notes-compose-from-sources-dialog"
        // overlayZIndex bypasses the inline z-index: 71 the
        // DialogContent component sets for itself.  10049 + 1 → 10050
        // for the content.  Sits above the editor toolbar (z-[10001])
        // and the notes drawer chrome — same convention as
        // TemplateGallery / BridgingConceptsPanel.
        overlayZIndex="10049"
        className="!rounded-none !p-0 max-w-4xl w-[min(56rem,94vw)] max-h-[88vh] flex flex-col bg-card dark:bg-background border border-border"
        dialogOpen={open}
        onOpenChange={onOpenChange}
      >
        <style>{KEYFRAMES_CSS}</style>

        {/* ─── Header ────────────────────────────────────────────────
            Eyebrow + title + description. No icon — typography is the
            identity here. */}
        <div className="px-8 pt-7 pb-5 border-b border-border">
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground mb-2">
            7.3 · {t('notes.menu.composeFromSources', 'Compose from sources')}
          </div>
          <h2 className="text-xl font-semibold tracking-tight text-foreground">
            {t('notes.composeFromSources.title', 'Compose from sources')}
          </h2>
          <p className="mt-1.5 text-sm text-muted-foreground leading-relaxed max-w-2xl">
            {t(
              'notes.composeFromSources.description',
              'Generate a paragraph grounded in the documents you picked. Each substantive claim is cited inline.',
            )}
          </p>
        </div>

        {/* ─── Status strip ─────────────────────────────────────────
            Three-step process eyebrow + run status dot + scope counter.
            Visible in every state. The active step gets a leading dot
            and foreground tone; the others stay muted. */}
        <div className="px-8 py-3 border-b border-border flex items-center gap-6 text-[10px] uppercase tracking-wide">
          <ProcessStep
            number="01"
            label={t('notes.composeFromSources.processStepTopic', 'Topic')}
            active={!showReadingLayout}
          />
          <span className="text-border">/</span>
          <ProcessStep
            number="02"
            label={t('notes.composeFromSources.processStepLength', 'Length')}
            active={!showReadingLayout}
          />
          <span className="text-border">/</span>
          <ProcessStep
            number="03"
            label={t('notes.composeFromSources.processStepResult', 'Result')}
            active={showReadingLayout || loading}
          />
          <div className="ml-auto flex items-center gap-3">
            <StatusDot tone={statusToken.tone} pulse={status === 'composing'} />
            <span
              className={cn(
                statusToken.tone === 'destructive' && 'text-destructive',
                statusToken.tone === 'primary' && 'text-foreground',
                statusToken.tone === 'muted' && 'text-muted-foreground',
              )}
            >
              {statusToken.label}
            </span>
            <span className="text-border">·</span>
            <span className="text-muted-foreground">{scopeLabel}</span>
            {showReadingLayout && (
              <>
                <span className="text-border">·</span>
                <span className="text-muted-foreground tabular-nums">
                  {t('notes.composeFromSources.wordsCount', '{{count}} words', { count: wordCount })}
                </span>
              </>
            )}
          </div>
        </div>

        {/* Composing rule — the "typesetter" bar that scrolls while we
            wait. Renders just below the status strip so it reads as a
            visual companion to the COMPOSING label. */}
        {loading && (
          <div className="relative h-[1px] bg-border overflow-hidden" aria-hidden="true">
            <div
              className="absolute inset-y-0 w-1/4 bg-primary"
              style={{ animation: 'notes-compose-typesetter 1.6s cubic-bezier(0.4, 0, 0.2, 1) infinite' }}
            />
          </div>
        )}

        {/* ─── Body ─────────────────────────────────────────────────
            Two layouts depending on whether we have a composed result. */}
        {showReadingLayout ? (
          <ReadingLayout
            composedText={composedText}
            sources={sources}
            status={status}
            t={t}
            onRerun={() => void run()}
            canRun={canRun}
            loading={loading}
            topic={topic}
            length={length}
          />
        ) : (
          <ControlsLayout
            t={t}
            topic={topic}
            setTopic={setTopic}
            length={length}
            setLength={setLength}
            lengthOptions={lengthOptions}
            lengthLabel={lengthLabel}
            canRun={canRun}
            loading={loading}
            run={run}
            hasCursorContext={hasCursorContext}
            cursorContext={cursorContext}
            noCollections={noCollections}
          />
        )}

        {/* ─── Footer ───────────────────────────────────────────────
            Cancel + Insert. Hidden until we have prose to insert. */}
        {showReadingLayout && (
          <div className="px-8 py-4 border-t border-border flex items-center justify-between gap-3">
            <Button
              variant="ghost"
              className="h-9 rounded-none px-4 text-sm font-medium hover:bg-muted"
              onClick={() => onOpenChange(false)}
            >
              {t('common.cancel', 'Cancel')}
            </Button>
            <Button
              className="h-9 rounded-none px-5 text-sm font-medium"
              onClick={insertIntoNote}
              disabled={!editor || !composedText}
              data-testid="notes-compose-insert"
            >
              {t('notes.composeFromSources.insert', 'Insert into note')}
              <span className="ml-3 text-[10px] tracking-wider opacity-60">↵</span>
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
};

/* ────────────────────────────────────────────────────────────────────
 * Sub-components — kept inside the same file so the redesign lands as
 * a single drop-in replacement and the editorial tokens stay co-located.
 * ──────────────────────────────────────────────────────────────────── */

const ProcessStep: React.FC<{ number: string; label: string; active: boolean }> = ({
  number,
  label,
  active,
}) => (
  <span
    className={cn(
      'flex items-center gap-2 transition-colors',
      active ? 'text-foreground' : 'text-muted-foreground',
    )}
  >
    <span
      className={cn(
        'inline-block w-1.5 h-1.5 rounded-full',
        active ? 'bg-primary' : 'bg-border',
      )}
    />
    <span className="tabular-nums">{number}</span>
    <span>—</span>
    <span>{label}</span>
  </span>
);

const StatusDot: React.FC<{ tone: 'muted' | 'primary' | 'destructive'; pulse?: boolean }> = ({
  tone,
  pulse,
}) => (
  <span
    className={cn(
      'inline-block w-2 h-2 rounded-full',
      tone === 'primary' && 'bg-primary',
      tone === 'destructive' && 'bg-destructive',
      tone === 'muted' && 'bg-muted-foreground/40',
      pulse && 'animate-pulse-slow',
    )}
    aria-hidden="true"
  />
);

interface ControlsLayoutProps {
  t: (key: string, fallback?: string, opts?: Record<string, unknown>) => string;
  topic: string;
  setTopic: (s: string) => void;
  length: LengthChoice;
  setLength: (l: LengthChoice) => void;
  lengthOptions: Array<{ key: LengthChoice; words: number }>;
  lengthLabel: (k: LengthChoice) => string;
  canRun: boolean;
  loading: boolean;
  run: () => void | Promise<void>;
  hasCursorContext: boolean;
  cursorContext: { before: string; after: string };
  noCollections: boolean;
}

const ControlsLayout: React.FC<ControlsLayoutProps> = ({
  t,
  topic,
  setTopic,
  length,
  setLength,
  lengthOptions,
  lengthLabel,
  canRun,
  loading,
  run,
  hasCursorContext,
  cursorContext,
  noCollections,
}) => (
  <div className="flex-1 min-h-0 overflow-y-auto px-8 py-7 space-y-7">
    {/* Topic textarea with monospaced eyebrow above. */}
    <section>
      <div className="flex items-baseline justify-between mb-3">
        <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
          {t('notes.composeFromSources.processStepTopic', 'Topic')}
        </span>
        {hasCursorContext && (
          <span className="text-[10px] text-muted-foreground">
            {t('notes.composeFromSources.cursorContextHint', 'Sources picked by what you are writing now ({{chars}} chars around the cursor). Topic above is an optional steer.', {
              chars: cursorContext.before.length + cursorContext.after.length,
            })}
          </span>
        )}
      </div>
      <Textarea
        value={topic}
        onChange={(e) => setTopic(e.target.value)}
        placeholder={t(
          'notes.composeFromSources.topicPlaceholder',
          hasCursorContext
            ? 'Optional — steering hint. Otherwise we continue from where your cursor sits.'
            : 'What should I write about? e.g. "The role of long-form attention in working memory."',
        )}
        rows={4}
        maxLength={2000}
        data-testid="notes-compose-topic"
        className="rounded-none border-border bg-background dark:bg-card text-sm leading-relaxed resize-none focus-visible:ring-1 focus-visible:ring-ring"
      />
    </section>

    {/* Length step ladder. Three rows, leading radio dot, label + word
        count separated by a thin spacer. Click anywhere on the row. */}
    <section>
      <span className="block text-[10px] uppercase tracking-wide text-muted-foreground mb-3">
        {t('notes.composeFromSources.processStepLength', 'Length')}
      </span>
      <div className="border border-border divide-y divide-border bg-background dark:bg-card">
        {lengthOptions.map((opt) => {
          const active = length === opt.key;
          return (
            <button
              key={opt.key}
              type="button"
              onClick={() => setLength(opt.key)}
              data-testid={`notes-compose-length-${opt.key}`}
              className={cn(
                'w-full flex items-center gap-4 px-4 py-3 text-left transition-colors',
                'hover:bg-muted/50 focus-visible:outline-none focus-visible:bg-muted/60',
                active && 'bg-muted/40',
              )}
            >
              <span
                className={cn(
                  'inline-block w-2.5 h-2.5 rounded-full border',
                  active ? 'border-primary bg-primary' : 'border-border bg-transparent',
                )}
                aria-hidden="true"
              />
              <span
                className={cn(
                  'text-sm flex-1',
                  active ? 'text-foreground font-medium' : 'text-muted-foreground',
                )}
              >
                {lengthLabel(opt.key)}
              </span>
              <span className="text-xs tabular-nums text-muted-foreground tracking-wider">
                ~{opt.words}{' '}
                {t('notes.composeFromSources.wordsAbbr', 'words')}
              </span>
            </button>
          );
        })}
      </div>
    </section>

    {/* Pre-run scope warning, if applicable. Sits just above Generate so
        the writer reads it before clicking. */}
    {noCollections && (
      <div className="border-l-2 border-muted-foreground/30 pl-3 py-1 text-xs text-muted-foreground flex items-start gap-2">
        <AlertCircle className="h-3.5 w-3.5 flex-shrink-0 mt-0.5" />
        <span>
          {t(
            'notes.composeFromSources.noCollections',
            'No collections in research context — generated without citations.',
          )}
        </span>
      </div>
    )}

    {/* Generate button — full width, sharp corners. The keyboard hint
        sits flush right inside the button so it reads as a single
        affordance rather than a label-and-shortcut pair. */}
    <Button
      onClick={() => void run()}
      disabled={!canRun}
      data-testid="notes-compose-run"
      className="w-full h-12 rounded-none text-sm font-medium tracking-wide"
    >
      {loading ? (
        <Loader2 className="h-4 w-4 mr-2 animate-spin" />
      ) : null}
      <span>{t('notes.composeFromSources.generate', 'Generate')}</span>
      {!loading && (
        <span className="ml-3 text-[10px] tracking-wider opacity-60">
          ⌘ + ↵
        </span>
      )}
    </Button>
  </div>
);

interface ReadingLayoutProps {
  composedText: string;
  sources: ComposedSource[];
  status: RunStatus;
  t: (key: string, fallback?: string, opts?: Record<string, unknown>) => string;
  onRerun: () => void;
  canRun: boolean;
  loading: boolean;
  topic: string;
  length: LengthChoice;
}

const ReadingLayout: React.FC<ReadingLayoutProps> = ({
  composedText,
  sources,
  status,
  t,
  onRerun,
  canRun,
  loading,
  topic,
  length,
}) => (
  <div className="flex-1 min-h-0 grid grid-cols-1 md:grid-cols-[3fr_2fr]">
    {/* ── Prose pane ───────────────────────────────────────────────
        The "manuscript leaf". Generous leading, serif body, dropcap on
        the first letter of the first paragraph for a press feel. */}
    <div className="min-h-0 overflow-y-auto px-8 py-7 border-b md:border-b-0 md:border-r border-border">
      <div className="flex items-baseline justify-between mb-4">
        <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
          {t('notes.composeFromSources.preview', 'Preview')}
        </span>
        {topic && (
          <span className="text-[10px] text-muted-foreground truncate max-w-[60%]">
            {topic.length > 60 ? `${topic.slice(0, 60)}…` : topic}
            {' · '}
            <span className="uppercase">{length}</span>
          </span>
        )}
      </div>
      {composedText ? (
        <article className="text-base leading-relaxed text-foreground [&_p]:mb-4">
          {composedText.split(/\n{2,}/).map((para, i) => (
            <p key={i}>{para}</p>
          ))}
        </article>
      ) : (
        <p className="text-sm text-muted-foreground italic">
          {t('notes.composeFromSources.emptyOutput', 'The model returned no text.')}
        </p>
      )}
      <div className="mt-7 pt-4 border-t border-border flex items-center gap-3">
        <Button
          variant="outline"
          size="sm"
          onClick={onRerun}
          disabled={!canRun || loading}
          className="rounded-none h-8 px-3 text-xs"
        >
          {t('notes.composeFromSources.rerun', 'Re-run')}
        </Button>
        <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
          {t('notes.composeFromSources.rerunHint', 'Tweaks above re-fetch sources.')}
        </span>
      </div>
    </div>

    {/* ── Footnote apparatus ───────────────────────────────────────
        Numbered references like a manuscript apparatus. Bracket
        numbers in mono, source titles in regular weight, chapter/page
        line in mono caps, chunk excerpt in a quoted block with a left
        rule. */}
    <div className="min-h-0 overflow-y-auto px-7 py-7">
      <div className="flex items-baseline justify-between mb-4">
        <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
          {t('notes.composeFromSources.sources', 'Sources')}
        </span>
        <span className="text-xs tabular-nums text-muted-foreground">
          {String(sources.length).padStart(2, '0')}
        </span>
      </div>

      {/* Status-banner row — only shows when the result has a soft
          warning code. Pre-empts the empty-list copy below. */}
      {status === 'timeout' && (
        <ApparatusBanner
          tone="destructive"
          icon
          text={t(
            'notes.composeFromSources.retrievalTimeout',
            'Retrieval timed out — the corpus is large. The model wrote without grounding. Try a more specific topic or narrow the scope.',
          )}
        />
      )}
      {status === 'no-match' && (
        <ApparatusBanner
          tone="muted"
          icon
          text={t(
            'notes.composeFromSources.retrievalNoMatch',
            'No passages in the selected collections matched this query. Try broader phrasing or a different scope.',
          )}
        />
      )}
      {status === 'failed' && (
        <ApparatusBanner
          tone="destructive"
          icon
          text={t(
            'notes.composeFromSources.retrievalFailed',
            'Retrieval failed. The model wrote without grounding.',
          )}
        />
      )}
      {status === 'soft-no-citations' && (
        <ApparatusBanner
          tone="muted"
          icon
          text={t(
            'notes.composeFromSources.statusSoftNoCitationsLong',
            'Sources were retrieved but the model chose to write without citation markers. Consider re-running with a tighter topic.',
          )}
        />
      )}

      {/* Source list — apparatus rows. Empty state falls through to
          the banner above when applicable; only fully-empty (no scope,
          no banner) hits this fallback. */}
      {sources.length > 0 ? (
        <ol className="space-y-5 list-none">
          {sources.map((s) => (
            <li
              key={s.source_number}
              data-testid={`notes-compose-source-${s.source_number}`}
              className="grid grid-cols-[2.5rem_1fr] gap-3"
            >
              <span className="text-xs text-muted-foreground tabular-nums tracking-wider pt-0.5">
                [{String(s.source_number).padStart(2, '0')}]
              </span>
              <div className="min-w-0">
                <p className="text-[13px] font-medium text-foreground leading-snug truncate">
                  {shortenSourceTitle(s.source_title)}
                </p>
                {(s.chapter || s.page) && (
                  <p className="text-[10px] uppercase tracking-wide text-muted-foreground mt-1">
                    {[s.chapter, s.page && `p. ${s.page}`].filter(Boolean).join(' · ')}
                  </p>
                )}
                {s.chunk_text && (
                  <blockquote className="mt-2 border-l-2 border-border pl-3 text-[12px] leading-relaxed text-muted-foreground italic line-clamp-3">
                    {s.chunk_text}
                  </blockquote>
                )}
              </div>
            </li>
          ))}
        </ol>
      ) : (
        status !== 'timeout' &&
        status !== 'no-match' &&
        status !== 'failed' &&
        status !== 'soft-no-citations' && (
          <p className="text-xs text-muted-foreground italic">
            {t(
              'notes.composeFromSources.sourcesEmpty',
              'No sources cited (no collections selected, or none matched).',
            )}
          </p>
        )
      )}
    </div>
  </div>
);

const ApparatusBanner: React.FC<{
  tone: 'muted' | 'destructive';
  icon?: boolean;
  text: string;
}> = ({ tone, icon, text }) => (
  <div
    className={cn(
      'mb-5 px-3 py-2 border-l-2 text-[12px] leading-relaxed flex items-start gap-2',
      tone === 'destructive' && 'border-destructive text-destructive',
      tone === 'muted' && 'border-muted-foreground/40 text-muted-foreground',
    )}
  >
    {icon && (
      <AlertCircle
        className={cn(
          'h-3.5 w-3.5 flex-shrink-0 mt-0.5',
          tone === 'destructive' && 'text-destructive',
          tone === 'muted' && 'text-muted-foreground',
        )}
      />
    )}
    <span>{text}</span>
  </div>
);

/* Suppress an unused-import warning so `Check` stays available for
 * future re-introduction (e.g. completion checkmark on individual
 * source rows). Tree-shaken at build time. */
void Check;
