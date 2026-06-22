/**
 * Popover that appears on text selection when annotation tool is active.
 *
 * Layout: two logical rows stacked vertically.
 *   Row 1 — AI actions (Explain + Cite). Large, primary-tinted buttons,
 *           touch-friendly (min-height 36px). This is the "what do I want
 *           to do with this passage?" row.
 *   Row 2 — Highlight colours + legend toggle. 8 colour swatches tagged
 *           with a short legend that users can toggle.
 *
 * Mobile: buttons grow to 44px min touch target; the popover itself widens
 * so it never gets clipped on the right edge.
 */

import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ChevronDown, Crop, Highlighter, Library, NotebookPen, Share2, Sparkles, StickyNote, Strikethrough, Trash2, Underline } from 'lucide-react';
import { cn } from '@/lib/utils';
import { ANNOTATION_COLORS, ANNOTATION_TYPES, type AnnotationType } from '@/types/annotations';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useIsMobile } from '@/hooks/use-mobile';
import { useTranslation } from 'react-i18next';
import { useAnnotationColorSemantics } from '@/hooks/use-annotation-color-semantics';

interface SelectionPopoverProps {
  position: { x: number; y: number } | null;
  activeColor: string;
  /** Currently selected annotation tool — drives which `annotation_type`
   *  the next color click creates. Defaults to Highlight (1) when null. */
  activeTool?: AnnotationType | null;
  /** Picks a tool. Persists across selections via the parent hook. */
  onToolChange?: (tool: AnnotationType) => void;
  /** `toolOverride` lets the tool-icon row act as a one-click confirm
   *  (clicking Strikethrough creates a strikethrough with the current
   *  active colour instead of waiting for a colour-swatch tap). */
  onConfirm: (color: string, comment?: string, toolOverride?: AnnotationType) => void;
  onCancel: () => void;
  onCite?: (text: string) => void;
  /** Triggered when the user picks "Explain" on the highlighted passage.
   *  The parent is responsible for opening the Explain panel. */
  onExplain?: (text: string) => void;
  /** Triggered when the user picks "Similar" — search user's library for
   *  passages matching the selection. The parent opens the SimilarPanel. */
  onSimilar?: (text: string) => void;
  selectedText?: string;
}

export function SelectionPopover({
  position,
  activeColor,
  activeTool,
  onToolChange,
  onConfirm,
  onCancel,
  onCite,
  onExplain,
  onSimilar,
  selectedText,
}: SelectionPopoverProps) {
  const [color, setColor] = useState(activeColor);
  const colorRef = useRef(activeColor);
  const [colorDropdownOpen, setColorDropdownOpen] = useState(false);
  const [aiDropdownOpen, setAiDropdownOpen] = useState(false);
  const [comment] = useState('');
  const ref = useRef<HTMLDivElement>(null);
  const isMobile = useIsMobile();
  const { labelFor: workspaceLabelFor } = useAnnotationColorSemantics();
  const { t } = useTranslation();

  const currentColorMeta = ANNOTATION_COLORS.find((c) => c.hex === color) ?? ANNOTATION_COLORS[0];

  useEffect(() => {
    setColor(activeColor);
    colorRef.current = activeColor;
  }, [activeColor]);

  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      // Delay check to allow React to process button clicks inside popover first
      requestAnimationFrame(() => {
        if (ref.current && !ref.current.contains(e.target as Node)) {
          onCancel();
        }
      });
    };
    // Use pointerdown with capture:false so inner buttons get priority
    document.addEventListener('pointerdown', handleClick);
    return () => document.removeEventListener('pointerdown', handleClick);
  }, [onCancel]);

  // Post-mount viewport correction. Annotation layers compute position.x
  // relative to their drawer container; when the drawer doesn't form a
  // transform containing block the fixed element ends up offset. Measure
  // the real rect and push it back inside the viewport margins.
  const [offsetCorrection, setOffsetCorrection] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  useLayoutEffect(() => {
    if (!ref.current || !position) return;
    const rect = ref.current.getBoundingClientRect();
    const marginRight = 8;
    const marginBottom = 8;
    let dx = 0;
    let dy = 0;
    if (rect.right > window.innerWidth - marginRight) {
      dx = window.innerWidth - marginRight - rect.right;
    }
    if (rect.left < 8) {
      dx = 8 - rect.left;
    }
    if (rect.bottom > window.innerHeight - marginBottom) {
      dy = window.innerHeight - marginBottom - rect.bottom;
    }
    if (dx !== offsetCorrection.x || dy !== offsetCorrection.y) {
      setOffsetCorrection({ x: dx, y: dy });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional on position only
  }, [position?.x, position?.y]);

  if (!position) return null;

  const hasAiActions = Boolean((onExplain || onSimilar || onCite) && selectedText);

  // Popover is now narrower since AI actions collapsed into a dropdown
  // and the 8 colour swatches collapsed into a dropdown trigger.
  const popoverWidth = isMobile ? 280 : 240;
  const maxRight = window.innerWidth - popoverWidth;

  const popoverStyle: React.CSSProperties = {
    left: Math.max(8, Math.min(position.x, maxRight)) + offsetCorrection.x,
    top: position.y + 8 + offsetCorrection.y,
    width: popoverWidth,
  };

  return (
    <div
      ref={ref}
      data-testid="annotation-selection-popover"
      className={cn(
        'fixed z-[9999] bg-popover text-popover-foreground border border-border shadow-lg',
        'flex flex-col gap-2.5 p-2.5'
      )}
      style={popoverStyle}
    >
      {/* AI actions used to live as a separate top row of three large
          buttons (Objasni / Slično / Citiraj). User asked us to fold
          them into the tools row as a single sparkles dropdown — see
          the AI dropdown in the tools picker below. */}

      {/* ── Tool picker — same row as the colour swatches when there
          is a handler. Default is Highlight (annotation_type=1) so a
          user who never touches this row keeps the legacy one-click
          flow. */}
      {onToolChange && (
        <div className="flex items-center gap-1" data-testid="annotation-tool-picker">
          {/* AI dropdown — Objasni / Slično / Citiraj. Was a separate
              row above; user asked to fold it into the tools row. */}
          {hasAiActions && selectedText && (
            <div className="relative">
              <Tooltip delayDuration={300}>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    data-testid="annotation-ai-dropdown-trigger"
                    onClick={() => setAiDropdownOpen((o) => !o)}
                    onPointerDown={(e) => e.stopPropagation()}
                    className={cn(
                      'flex items-center justify-center border transition-colors',
                      isMobile ? 'w-9 h-9' : 'w-7 h-7',
                      aiDropdownOpen
                        ? 'border-foreground bg-muted text-foreground'
                        : 'border-transparent text-primary hover:bg-primary/10'
                    )}
                    aria-label={t('annotation.aiActions', 'AI actions')}
                  >
                    <Sparkles className="w-3.5 h-3.5" />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="top" className="text-[10px] px-1.5 py-0.5">
                  {t('annotation.aiActions', 'AI actions')}
                </TooltipContent>
              </Tooltip>
              {aiDropdownOpen && (
                <div
                  data-testid="annotation-ai-dropdown"
                  className="absolute left-0 bottom-full mb-1 bg-popover border border-border shadow-lg p-1 z-10 flex flex-col min-w-[120px]"
                  onPointerDown={(e) => e.stopPropagation()}
                >
                  {onExplain && (
                    <button
                      type="button"
                      data-testid="annotation-explain-button"
                      onClick={() => { onExplain(selectedText); setAiDropdownOpen(false); onCancel(); }}
                      className="flex items-center gap-2 px-2 py-1.5 text-xs hover:bg-accent text-left"
                    >
                      <Sparkles className="w-3.5 h-3.5 flex-shrink-0" />
                      <span>{t('annotation.explain', 'Explain')}</span>
                    </button>
                  )}
                  {onSimilar && (
                    <button
                      type="button"
                      data-testid="annotation-similar-button"
                      onClick={() => { onSimilar(selectedText); setAiDropdownOpen(false); onCancel(); }}
                      className="flex items-center gap-2 px-2 py-1.5 text-xs hover:bg-accent text-left"
                    >
                      <Library className="w-3.5 h-3.5 flex-shrink-0" />
                      <span>{t('annotation.similar', 'Similar')}</span>
                    </button>
                  )}
                  {onCite && (
                    <button
                      type="button"
                      data-testid="annotation-cite-button"
                      onClick={() => { onCite(selectedText); setAiDropdownOpen(false); onCancel(); }}
                      className="flex items-center gap-2 px-2 py-1.5 text-xs hover:bg-accent text-left"
                    >
                      <NotebookPen className="w-3.5 h-3.5 flex-shrink-0" />
                      <span>{t('annotation.cite', 'Cite')}</span>
                    </button>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Tool icons — one-click create. Strike forces gray
              (low priority, 0.8x boost); Underline forces blue
              (definition, 1.1x boost); Highlight/Note/Area use the
              user's active colour. See
              memory/feedback_annotation_color_semantics.md. */}
          {[
            { type: ANNOTATION_TYPES.HIGHLIGHT, icon: Highlighter, labelKey: 'knowledge.annotations.highlight', testId: 'highlight', forcedColor: null },
            { type: ANNOTATION_TYPES.UNDERLINE, icon: Underline, labelKey: 'knowledge.annotations.underline', testId: 'underline', forcedColor: '#2ea8e5' },
            { type: ANNOTATION_TYPES.STRIKETHROUGH, icon: Strikethrough, labelKey: 'knowledge.annotations.strikethrough', testId: 'strikethrough', forcedColor: '#aaaaaa' },
            { type: ANNOTATION_TYPES.NOTE, icon: StickyNote, labelKey: 'knowledge.annotations.note', testId: 'note', forcedColor: null },
            { type: ANNOTATION_TYPES.AREA_CAPTURE, icon: Crop, labelKey: 'knowledge.annotations.areaCapture', testId: 'area-capture', forcedColor: null },
          ].map(({ type, icon: Icon, labelKey, testId, forcedColor }) => {
            const effectiveTool = activeTool ?? ANNOTATION_TYPES.HIGHLIGHT;
            const isActive = effectiveTool === type;
            return (
              <Tooltip key={type} delayDuration={300}>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    data-testid={`annotation-tool-${testId}`}
                    onClick={() => {
                      onToolChange(type);
                      // Immediate one-click create. Strike uses gray,
                      // Underline uses blue regardless of activeColor;
                      // others use the user's pick. toolOverride bypasses
                      // the stale activeTool closure (React state is async).
                      const colorToUse = forcedColor ?? color;
                      onConfirm(colorToUse, comment || undefined, type);
                    }}
                    onPointerDown={(e) => e.stopPropagation()}
                    className={cn(
                      'flex items-center justify-center border transition-colors',
                      isMobile ? 'w-9 h-9' : 'w-7 h-7',
                      isActive
                        ? 'border-foreground bg-muted text-foreground'
                        : 'border-transparent text-muted-foreground hover:text-foreground hover:bg-muted/30'
                    )}
                    aria-label={t(labelKey)}
                  >
                    <Icon className="w-3.5 h-3.5" />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="top" className="text-[10px] px-1.5 py-0.5">
                  {t(labelKey)}
                </TooltipContent>
              </Tooltip>
            );
          })}
        </div>
      )}

      {/* ── Row 3: colour picker dropdown ────────────────────────
          One trigger button shows the current colour + name. Click
          opens an inline 4×2 swatch grid that also acts as the
          confirm button — picking a colour fires onConfirm and the
          parent dismisses. The whole grid is a child of the parent
          ref, so the outside-click handler still closes the popover
          when the user taps anywhere else.

          Why a dropdown, not 8 swatches inline: see
          memory/feedback_color_picker_dropdown.md — user asked for
          this; flat row was visually noisy. */}
      <div className="relative">
        <button
          type="button"
          data-testid="annotation-color-trigger"
          onClick={() => setColorDropdownOpen((o) => !o)}
          onPointerDown={(e) => e.stopPropagation()}
          className={cn(
            'w-full flex items-center justify-between gap-2 px-2 border border-border bg-muted/20',
            'hover:bg-muted/40 transition-colors',
            isMobile ? 'h-11 text-sm' : 'h-9 text-xs'
          )}
          aria-label={t('annotation.colorTrigger', 'Pick colour')}
        >
          <span className="flex items-center gap-2 min-w-0">
            <span
              className="w-4 h-4 border border-border flex-shrink-0"
              style={{ backgroundColor: color }}
            />
            <span className="truncate font-medium">{currentColorMeta.name}</span>
            <span className="truncate text-muted-foreground hidden sm:inline">
              · {workspaceLabelFor(currentColorMeta.hex) || currentColorMeta.label}
            </span>
          </span>
          <ChevronDown
            className={cn('w-3.5 h-3.5 flex-shrink-0 transition-transform', colorDropdownOpen && 'rotate-180')}
          />
        </button>

        {colorDropdownOpen && (
          <div
            data-testid="annotation-color-dropdown"
            // Open ABOVE the trigger (`bottom-full mb-1`) — the parent
            // popover is usually anchored to a text selection that ended
            // near the bottom of viewport, so opening downwards clips
            // the swatches off-screen. Opening upwards keeps every
            // colour clickable regardless of where the selection lives.
            className="absolute left-0 right-0 bottom-full mb-1 bg-popover border border-border shadow-lg p-2 z-10"
            onPointerDown={(e) => e.stopPropagation()}
          >
            <div className="grid grid-cols-4 gap-1">
              {ANNOTATION_COLORS.map(({ hex, name, label }) => {
                const wsLabel = workspaceLabelFor(hex);
                const effectiveLabel = wsLabel || label;
                return (
                  <Tooltip key={hex} delayDuration={300}>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        data-testid={`annotation-color-${hex.replace('#', '')}`}
                        onClick={() => {
                          setColorDropdownOpen(false);
                          onConfirm(hex, comment || undefined);
                        }}
                        onPointerDown={(e) => e.stopPropagation()}
                        className={cn(
                          'border-2 transition-all flex items-center justify-center',
                          isMobile ? 'h-10' : 'h-8',
                          color === hex
                            ? 'border-foreground ring-1 ring-foreground/30 ring-offset-1 ring-offset-popover'
                            : 'border-transparent hover:border-foreground/40'
                        )}
                        style={{ backgroundColor: hex }}
                        aria-label={`${name} — ${effectiveLabel}`}
                      />
                    </TooltipTrigger>
                    <TooltipContent side="top" className="text-[10px] px-1.5 py-0.5">
                      <span className="font-medium">{name}</span>
                      <span className="text-muted-foreground"> · {effectiveLabel}</span>
                    </TooltipContent>
                  </Tooltip>
                );
              })}
            </div>
            {/* Compact legend — workspace-configured labels override the
                built-in palette description when present. */}
            <div className="mt-2 pt-2 border-t border-border/60 grid grid-cols-2 gap-x-3 gap-y-0.5">
              {ANNOTATION_COLORS.map(({ hex, label }) => (
                <div key={hex} className="flex items-center gap-1.5">
                  <span className="w-2 h-2 shrink-0" style={{ backgroundColor: hex }} />
                  <span className="text-[9px] text-muted-foreground truncate">
                    {workspaceLabelFor(hex) || label}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

interface AnnotationHoverPopoverProps {
  annotation: {
    id: string;
    selected_text?: string | null;
    comment?: string | null;
    color: string;
    page_label?: string | null;
    tag_ids?: string[] | null;
    is_external?: boolean | null;
  };
  position: { x: number; y: number };
  onDelete: (id: string) => void;
  onUpdateComment: (id: string, comment: string) => void;
  onUpdateTags?: (id: string, tagIds: string[]) => void;
  onClose: () => void;
  /** Hoist share-dialog handling to the parent layer. When the user
   *  clicks "Share annotation" inside the hover popover, the popover
   *  closes and the parent renders the dialog at portal level —
   *  otherwise Radix Dialog's modal backdrop dismisses the popover
   *  and unmounts the dialog along with it. */
  onRequestShare?: () => void;
  /** Available tags for selector (from workspace) */
  availableTags?: Array<{ id: string; name: string; color: string | null }>;
}

export function AnnotationHoverPopover({
  annotation,
  position,
  onDelete,
  onUpdateComment,
  onUpdateTags,
  onClose,
  onRequestShare,
  availableTags = [],
}: AnnotationHoverPopoverProps) {
  const [editing, setEditing] = useState(false);
  const [comment, setComment] = useState(annotation.comment || '');
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        onClose();
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [onClose]);

  return (
    <div
      ref={ref}
      data-testid="annotation-hover-popover"
      className="fixed z-[9999] bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 shadow-lg p-2 max-w-xs"
      style={{
        left: Math.min(position.x, window.innerWidth - 300),
        top: position.y + 8,
      }}
    >
      {/* Selected text preview */}
      {annotation.selected_text && (
        <p className="text-xs text-zinc-600 dark:text-zinc-400 line-clamp-3 mb-1.5 italic border-l-2 pl-2"
           style={{ borderColor: annotation.color }}>
          {annotation.selected_text}
        </p>
      )}

      {/* Comment */}
      {editing ? (
        <textarea
          data-testid="annotation-hover-comment-input"
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          className="w-full p-1.5 text-xs bg-zinc-50 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 resize-none focus:outline-none"
          rows={2}
          autoFocus
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              onUpdateComment(annotation.id, comment);
              setEditing(false);
            }
            if (e.key === 'Escape') setEditing(false);
          }}
        />
      ) : annotation.comment ? (
        <p
          data-testid="annotation-hover-comment-text"
          className="text-xs text-zinc-800 dark:text-zinc-200 cursor-pointer hover:bg-zinc-50 dark:hover:bg-zinc-800 p-1"
          onClick={() => setEditing(true)}
        >
          {annotation.comment}
        </p>
      ) : (
        <button
          type="button"
          data-testid="annotation-hover-add-note"
          onClick={() => setEditing(true)}
          className="text-xs text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300"
        >
          + Add note
        </button>
      )}

      {/* Tag pills */}
      {availableTags.length > 0 && onUpdateTags && (
        <div className="flex flex-wrap gap-1 mt-1.5">
          {availableTags.map(tag => {
            const isActive = annotation.tag_ids?.includes(tag.id);
            return (
              <button
                key={tag.id}
                type="button"
                onClick={() => {
                  const currentTags = annotation.tag_ids || [];
                  const newTags = isActive
                    ? currentTags.filter(id => id !== tag.id)
                    : [...currentTags, tag.id];
                  onUpdateTags(annotation.id, newTags);
                }}
                className={cn(
                  'text-[10px] px-1.5 py-0.5 border transition-colors',
                  isActive
                    ? 'bg-accent text-accent-foreground border-accent'
                    : 'text-muted-foreground border-border hover:border-accent/50'
                )}
              >
                {tag.color && <span className="inline-block w-1.5 h-1.5 rounded-full mr-1" style={{ backgroundColor: tag.color }} />}
                {tag.name}
              </button>
            );
          })}
        </div>
      )}

      {/* Actions */}
      <div className="flex items-center justify-between mt-1.5 pt-1.5 border-t border-zinc-100 dark:border-zinc-800">
        <div className="flex items-center gap-1">
          {annotation.page_label && (
            <span className="text-[10px] text-zinc-400">p. {annotation.page_label}</span>
          )}
          {/* External annotation badge */}
          {annotation.is_external && (
            <span className="text-[10px] px-1 py-0.5 bg-zinc-100 dark:bg-zinc-800 text-zinc-500 border border-zinc-200 dark:border-zinc-700">
              imported
            </span>
          )}
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            data-testid="annotation-hover-share"
            onClick={() => {
              // Defer to parent layer — see ShareAnnotationDialog hoist
              // comment in the props interface. Closing first so the
              // Radix backdrop never has a chance to fire its
              // outside-click on this popover.
              if (onRequestShare) {
                onRequestShare();
                onClose();
              }
            }}
            className="p-1 text-zinc-400 hover:text-blue-500 transition-colors"
            aria-label="Share annotation"
            title="Share annotation"
          >
            <Share2 className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            data-testid="annotation-hover-delete"
            onClick={() => onDelete(annotation.id)}
            className="p-1 text-zinc-400 hover:text-red-500 transition-colors"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
    </div>
  );
}
