/**
 * 7.9 — diff renderer for the version-history dialog.
 *
 * Two layouts:
 *   * "inline" (default) — single column, additions on green-tinted
 *     rows, deletions on red-tinted rows with strikethrough,
 *     format-only changes on amber rows with a "+ strong / − em"
 *     marker chip showing exactly which marks flipped. Same lines
 *     appear once. Compact, scannable, fits in the dialog's right
 *     pane without an extra scroll bar.
 *   * "side-by-side" — two columns; left mirrors the older version
 *     (deletions + the pre-format mark set visible), right mirrors
 *     the newer (additions + the post-format mark set visible). Same
 *     lines appear in both columns at the same row so the writer can
 *     scan changes context-first.
 *
 * Diff input is line-level with a v2 mark-aware second pass —
 * see `lib/text-diff.ts`. A line with identical text but a different
 * inline mark set (bold added, italic removed, link retargeted, etc.)
 * is reclassified as `format-change` instead of disappearing into the
 * silent "unchanged" bucket.
 */

import * as React from 'react';
import { useEffect, useRef, useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { ArrowLeftRight, AlignJustify } from 'lucide-react';
import { cn } from '@/lib/utils';
import { diffLines, diffSummary, type DiffLine } from '@/lib/text-diff';

export type DiffLayout = 'inline' | 'side-by-side';

export interface VersionDiffViewProps {
  /** Older version's HTML / markdown content. */
  oldContent: string;
  /** Newer version's HTML / markdown content. */
  newContent: string;
  /** Persisted layout preference; default 'inline'. */
  layout?: DiffLayout;
  onLayoutChange?: (layout: DiffLayout) => void;
}

const ROW_BASE = 'px-2 py-1 text-sm font-mono whitespace-pre-wrap break-words';

/** Color classes by op kind. Insertions green, deletions red,
 *  format-only changes amber, unchanged subtle muted.
 *  Sticks to semantic tokens but uses tailwind opacity modifiers so
 *  the diff is legible against light + dark + sepia themes. */
function rowClass(kind: DiffLine['kind']): string {
  switch (kind) {
    case 'add':
      return 'bg-green-500/10 text-green-900 dark:text-green-200 border-l-2 border-green-500';
    case 'remove':
      return 'bg-red-500/10 text-red-900 dark:text-red-200 border-l-2 border-red-500 line-through';
    case 'format-change':
      return 'bg-amber-500/10 text-amber-900 dark:text-amber-200 border-l-2 border-amber-500';
    case 'same':
    default:
      return 'text-muted-foreground border-l-2 border-transparent';
  }
}

/** Render the per-line mark delta as compact `+strong −em` chips so
 *  the writer can see at a glance which mark flipped. Empty when the
 *  line is not a format-change. */
const FormatDeltaChips: React.FC<{ added?: string[]; removed?: string[] }> = ({ added, removed }) => {
  if ((!added || added.length === 0) && (!removed || removed.length === 0)) return null;
  const formatMark = (m: string): string => {
    // `link:https://...` collapses to `link` for the chip; the full
    // href is hovered via title for power users.
    return m.startsWith('link:') ? 'link' : m;
  };
  return (
    <span className="ml-3 inline-flex items-center gap-1 text-[10px] uppercase tracking-wide opacity-90">
      {(added || []).map((m) => (
        <span
          key={`a-${m}`}
          title={m}
          className="px-1.5 py-px border border-amber-500/40 text-amber-900 dark:text-amber-200"
        >
          +{formatMark(m)}
        </span>
      ))}
      {(removed || []).map((m) => (
        <span
          key={`r-${m}`}
          title={m}
          className="px-1.5 py-px border border-amber-500/40 text-amber-900 dark:text-amber-200 line-through"
        >
          −{formatMark(m)}
        </span>
      ))}
    </span>
  );
};

/** localStorage key for persisted split ratio (0.15 – 0.85). */
const SPLIT_RATIO_STORAGE_KEY = 'scrapalot_notes_version_diff_split_ratio';
/** Don't let the divider squeeze either pane below this fraction. */
const MIN_SPLIT_RATIO = 0.15;
const MAX_SPLIT_RATIO = 0.85;

export const VersionDiffView: React.FC<VersionDiffViewProps> = ({
  oldContent,
  newContent,
  layout = 'inline',
  onLayoutChange,
}) => {
  const { t } = useTranslation();
  const diff = React.useMemo(() => diffLines(oldContent, newContent), [oldContent, newContent]);
  const summary = React.useMemo(() => diffSummary(diff), [diff]);

  // Resizable divider — left/right column ratio is user-controlled
  // and persisted across dialog opens. Initialised from localStorage
  // (clamped to the safety bounds in case a stale value is out of
  // range) and falls back to a 50/50 split for first-time users.
  const [splitRatio, setSplitRatio] = useState<number>(() => {
    if (typeof window === 'undefined') return 0.5;
    const raw = window.localStorage.getItem(SPLIT_RATIO_STORAGE_KEY);
    const parsed = raw ? parseFloat(raw) : NaN;
    if (!Number.isFinite(parsed)) return 0.5;
    return Math.max(MIN_SPLIT_RATIO, Math.min(MAX_SPLIT_RATIO, parsed));
  });
  const splitContainerRef = useRef<HTMLDivElement | null>(null);
  // Active-drag state in a ref so mousemove handlers don't re-attach
  // every render. `null` means "not currently dragging".
  const dragStateRef = useRef<{ startX: number; startRatio: number; width: number } | null>(null);

  const handleSplitMouseDown = useCallback((e: React.MouseEvent) => {
    if (!splitContainerRef.current) return;
    e.preventDefault();
    const rect = splitContainerRef.current.getBoundingClientRect();
    dragStateRef.current = { startX: e.clientX, startRatio: splitRatio, width: rect.width };

    const onMove = (ev: MouseEvent) => {
      const drag = dragStateRef.current;
      if (!drag) return;
      const delta = (ev.clientX - drag.startX) / drag.width;
      const next = Math.max(MIN_SPLIT_RATIO, Math.min(MAX_SPLIT_RATIO, drag.startRatio + delta));
      setSplitRatio(next);
    };
    const onUp = () => {
      const drag = dragStateRef.current;
      dragStateRef.current = null;
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      // Persist the final ratio so the next open of the dialog (or a
      // sibling note) starts where the writer left it.
      if (drag) {
        try {
          window.localStorage.setItem(SPLIT_RATIO_STORAGE_KEY, String(splitRatio));
        } catch { /* ignore quota / privacy errors */ }
      }
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }, [splitRatio]);

  // Persist whenever splitRatio settles after a drag ends. The mouseup
  // handler captures the value at the moment it fires, but we also
  // run this effect for the rare case where the ratio is changed
  // programmatically (e.g. a future "reset to 50/50" affordance).
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (dragStateRef.current) return; // mid-drag — wait for mouseup
    try {
      window.localStorage.setItem(SPLIT_RATIO_STORAGE_KEY, String(splitRatio));
    } catch { /* ignore */ }
  }, [splitRatio]);

  const renderInline = () => (
    <div className="border border-border bg-background overflow-hidden">
      {diff.map((d, idx) => (
        <div key={`${d.kind}-${idx}`} className={cn(ROW_BASE, rowClass(d.kind))}>
          <span className="select-none mr-2 opacity-60">
            {d.kind === 'add' ? '+' : d.kind === 'remove' ? '−' : d.kind === 'format-change' ? '~' : ' '}
          </span>
          {d.text || ' '}
          {d.kind === 'format-change' && (
            <FormatDeltaChips added={d.marksAdded} removed={d.marksRemoved} />
          )}
        </div>
      ))}
    </div>
  );

  // Side-by-side layout walks the diff once and emits paired rows:
  //   * 'remove' fills the left column, blank right
  //   * 'add'    blank left, fills the right column
  //   * 'same'   shows on both sides
  // Adjacent remove + add rows are intentionally NOT folded together,
  // since the line-level diff doesn't know whether they were a true
  // edit or two unrelated changes; a paragraph-anchored diff would
  // need to come from prosemirror-changeset.
  //
  // Columns are flex-basis driven (not grid 50/50) so the writer can
  // drag the central divider left/right — same affordance as GitHub /
  // VSCode diff viewers, useful when one side has long lines and the
  // other is mostly blank. The split ratio persists in localStorage.
  const renderSideBySide = () => (
    <div
      ref={splitContainerRef}
      className="flex h-full bg-border border border-border overflow-hidden"
    >
      <div
        className="bg-background overflow-auto min-w-0"
        style={{ flexBasis: `${splitRatio * 100}%`, flexGrow: 0, flexShrink: 1 }}
      >
        <div className="px-2 py-1 text-xs font-medium uppercase tracking-wide bg-muted/50 border-b border-border sticky top-0 z-[1]">
          {t('notes.versionDiff.before', 'Before')}
        </div>
        {diff.map((d, idx) => (
          <div
            key={`L-${idx}`}
            className={cn(
              ROW_BASE,
              d.kind === 'remove'
                ? rowClass('remove')
                : d.kind === 'format-change'
                  ? rowClass('format-change')
                  : d.kind === 'same'
                    ? rowClass('same')
                    : 'opacity-30',
            )}
          >
            {d.kind === 'add' ? ' ' : d.text || ' '}
            {d.kind === 'format-change' && d.marksRemoved && d.marksRemoved.length > 0 && (
              <FormatDeltaChips removed={d.marksRemoved} />
            )}
          </div>
        ))}
      </div>

      {/* Draggable splitter. 6 px hit-target so it's easy to grab
          even on touchpads; visually it's a 1 px rule with a hover
          highlight that previews the resize affordance. */}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-valuenow={Math.round(splitRatio * 100)}
        aria-valuemin={Math.round(MIN_SPLIT_RATIO * 100)}
        aria-valuemax={Math.round(MAX_SPLIT_RATIO * 100)}
        title={t('notes.versionDiff.splitDragHint', 'Drag to resize panes')}
        data-testid="notes-version-diff-splitter"
        onMouseDown={handleSplitMouseDown}
        className={cn(
          'relative w-1.5 flex-shrink-0 cursor-col-resize select-none',
          'bg-border hover:bg-primary/40 active:bg-primary/60 transition-colors',
        )}
      >
        {/* The visible 1 px line; the parent's full width is the
            invisible drag hit-target. Centred via absolute positioning
            so the line stays crisp regardless of the parent's hover
            tint. */}
        <div className="absolute inset-y-0 left-1/2 -translate-x-1/2 w-px bg-border pointer-events-none" />
      </div>

      <div className="bg-background overflow-auto min-w-0 flex-1">
        <div className="px-2 py-1 text-xs font-medium uppercase tracking-wide bg-muted/50 border-b border-border sticky top-0 z-[1]">
          {t('notes.versionDiff.after', 'After')}
        </div>
        {diff.map((d, idx) => (
          <div
            key={`R-${idx}`}
            className={cn(
              ROW_BASE,
              d.kind === 'add'
                ? rowClass('add')
                : d.kind === 'format-change'
                  ? rowClass('format-change')
                  : d.kind === 'same'
                    ? rowClass('same')
                    : 'opacity-30',
            )}
          >
            {d.kind === 'remove' ? ' ' : d.text || ' '}
            {d.kind === 'format-change' && d.marksAdded && d.marksAdded.length > 0 && (
              <FormatDeltaChips added={d.marksAdded} />
            )}
          </div>
        ))}
      </div>
    </div>
  );

  return (
    <div className="space-y-2 h-full flex flex-col" data-testid="notes-version-diff">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2 text-xs">
          <Badge variant="outline" className="text-green-700 dark:text-green-300 border-green-500/40">
            +{summary.added}
          </Badge>
          <Badge variant="outline" className="text-red-700 dark:text-red-300 border-red-500/40">
            −{summary.removed}
          </Badge>
          {summary.formatChanged > 0 && (
            <Badge variant="outline" className="text-amber-700 dark:text-amber-300 border-amber-500/40">
              ~{summary.formatChanged} {t('notes.versionDiff.formatBadge', 'format')}
            </Badge>
          )}
          <span className="text-muted-foreground">
            {t('notes.versionDiff.unchanged', '{{count}} unchanged', { count: summary.same })}
          </span>
        </div>
        <div className="flex items-center gap-1">
          <Button
            size="sm"
            variant={layout === 'inline' ? 'default' : 'outline'}
            className="h-7 px-2 text-xs"
            onClick={() => onLayoutChange?.('inline')}
            data-testid="notes-version-diff-inline"
          >
            <AlignJustify className="h-3 w-3 mr-1" />
            {t('notes.versionDiff.inline', 'Inline')}
          </Button>
          <Button
            size="sm"
            variant={layout === 'side-by-side' ? 'default' : 'outline'}
            className="h-7 px-2 text-xs"
            onClick={() => onLayoutChange?.('side-by-side')}
            data-testid="notes-version-diff-side-by-side"
          >
            <ArrowLeftRight className="h-3 w-3 mr-1" />
            {t('notes.versionDiff.sideBySide', 'Side by side')}
          </Button>
        </div>
      </div>

      {/* Stretch to the parent flex container's remaining height.
          For inline mode we own the scrolling; for side-by-side each
          column owns its own scroll so the sticky PRIJE / POSLIJE
          headers stay pinned during a long diff scan and the
          draggable splitter keeps full vertical reach. */}
      <div className={cn('flex-1 min-h-0', layout === 'inline' && 'overflow-auto')}>
        {layout === 'side-by-side' ? renderSideBySide() : renderInline()}
      </div>
    </div>
  );
};
