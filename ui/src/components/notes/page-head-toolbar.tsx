/**
 * PageHeadToolbar
 *
 * Confluence-style toolbar that appears above the note's H1 title on
 * hover (md / lg screens only). Carries seven contextual actions for the
 * whole page:
 *
 *   1. Layout       — paper size (A4/A3/A5) + orientation. Reuses the
 *                     existing NoteLayoutPopover internals but drops the
 *                     screen-width segment (that lives in #7 now).
 *   2. Add/remove   — single emoji shown inline next to the H1. Picker
 *      emoji          uses the project's HTML <input> + 8 quick presets;
 *                     full emoji-mart would be overkill for a single-glyph
 *                     metadata field.
 *   3. Status       — Confluence-style fixed set badge rendered in the
 *                     metadata row below the title (Draft / In progress
 *                     / In review / Done / Blocked / On hold).
 *   4. Header image — banner image displayed above the title. Uses the
 *                     existing /uploads endpoint via StaticFileController.
 *   5. Suggest      — AI-generated H1 title from the body text. Reuses
 *      title         the existing onGenerateTitle handler.
 *   6. Text size    — A↑ scale (Small / Default / Large / X-Large) that
 *                     drives `--notes-font-scale` CSS var on .ProseMirror.
 *   7. Page width   — Narrow / Default / Wide / Full. Maps to the
 *                     existing NotesScreenWidth tuple (now four values).
 *
 * Positioning: absolutely placed inside the scroll container, anchored
 * above `.ProseMirror > h1:first-of-type`. Listens for layout shifts via
 * ResizeObserver on the H1 + a scroll handler on the container.
 *
 * Mount is gated by `!isMobile` in the parent — touch screens get the
 * NoteMenuBar overflow sheet instead. Tooltip + popover trigger NEVER
 * stack `asChild` on the same button (Rule 41 in scrapalot-ui CLAUDE.md).
 */

import * as React from 'react';
import { useTranslation } from 'react-i18next';
import {
  Image as ImageIcon,
  LayoutPanelTop,
  MoveHorizontal,
  RectangleHorizontal,
  RectangleVertical,
  Smile,
  Sparkles,
  Type as TypeIcon,
  Upload,
  X,
} from 'lucide-react';
// Note: status badge / picker was removed per product decision — users
// found the predefined Confluence-style set noisy. The NoteStatus type
// and the `status` column remain in the Note schema as dead code in case
// we re-introduce a different status concept later.
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';
import type {
  NotesEditorOrientation,
  NotesPaperSize,
  NotesScreenWidth,
} from '@/lib/api-settings';
import type { NoteFontScale } from '@/lib/api-notes';

/* --------------------------------------------------------------------- */
/* Types + shared bits                                                    */
/* --------------------------------------------------------------------- */

export interface PageHeadValue {
  emoji: string | null;
  headerImageUrl: string | null;
  fontScale: NoteFontScale | null;
}

export interface PageHeadHandlers {
  /** Persist an emoji (null clears it). */
  onEmojiChange: (emoji: string | null) => void;
  /** Persist the banner image URL (null clears it). */
  onHeaderImageChange: (url: string | null) => void;
  /** Persist the editor font scale (null = inherit default). */
  onFontScaleChange: (scale: NoteFontScale | null) => void;
  /** Fire the AI title-suggestion flow. */
  onSuggestTitle: () => void;
  /** Upload a file and return its public URL. */
  onUploadHeaderImage: (file: File) => Promise<string>;
}

export interface PageHeadLayoutHandlers {
  paperSize: NotesPaperSize;
  orientation: NotesEditorOrientation;
  screenWidth: NotesScreenWidth;
  onPaperSizeChange: (size: NotesPaperSize) => void;
  onOrientationChange: (orientation: NotesEditorOrientation) => void;
  onScreenWidthChange: (width: NotesScreenWidth) => void;
}

export interface PageHeadToolbarProps {
  /** The scroll container that wraps `.ProseMirror`. The toolbar is
   *  absolutely positioned inside this element. Pass the same ref the
   *  editor uses so we share its scroll + resize cycles. */
  scrollContainer: HTMLElement | null;
  value: PageHeadValue;
  handlers: PageHeadHandlers;
  layout: PageHeadLayoutHandlers;
  /** Disable the entire toolbar (read-only viewer, no editor). */
  disabled?: boolean;
  /** Mobile mode — touch devices have no :hover, so we keep the
   *  toolbar pinned above the H1 instead of gating on cursor entry.
   *  Labels collapse to icons in this mode too. */
  isMobile?: boolean;
}

/* --------------------------------------------------------------------- */
/* Emoji quick set                                                        */
/* --------------------------------------------------------------------- */

const EMOJI_QUICK: string[] = ['📝', '📌', '⭐', '🔥', '💡', '✅', '⚠️', '🚧', '📚', '🎯', '🧠', '🚀'];

/* --------------------------------------------------------------------- */
/* Font scale presets                                                     */
/* --------------------------------------------------------------------- */

const FONT_SCALES: Array<{ value: NoteFontScale; labelKey: string; fallback: string; cssScale: number }> = [
  { value: 'small',   labelKey: 'notes.pageHead.fontScale.small',   fallback: 'Small',   cssScale: 0.875 },
  { value: 'default', labelKey: 'notes.pageHead.fontScale.default', fallback: 'Default', cssScale: 1.0   },
  { value: 'large',   labelKey: 'notes.pageHead.fontScale.large',   fallback: 'Large',   cssScale: 1.125 },
  { value: 'xlarge',  labelKey: 'notes.pageHead.fontScale.xlarge',  fallback: 'X-Large', cssScale: 1.25  },
];

export function fontScaleCssValue(scale: NoteFontScale | null | undefined): number {
  if (!scale) return 1.0;
  return FONT_SCALES.find((f) => f.value === scale)?.cssScale ?? 1.0;
}

/* --------------------------------------------------------------------- */
/* Page width presets                                                     */
/* --------------------------------------------------------------------- */

const PAGE_WIDTHS: Array<{ value: NotesScreenWidth; labelKey: string; fallback: string }> = [
  { value: 'paper',  labelKey: 'notes.pageHead.pageWidth.paper',  fallback: 'Default' },
  { value: 'wide',   labelKey: 'notes.pageHead.pageWidth.wide',   fallback: 'Wide'    },
  { value: 'full',   labelKey: 'notes.pageHead.pageWidth.full',   fallback: 'Full'    },
];

/* --------------------------------------------------------------------- */
/* Internal: segmented control                                            */
/* --------------------------------------------------------------------- */

interface SegmentedProps<T extends string> {
  value: T;
  options: Array<{ value: T; label: string; ariaLabel?: string }>;
  onChange: (next: T) => void;
  testIdPrefix: string;
}

function Segmented<T extends string>({ value, options, onChange, testIdPrefix }: SegmentedProps<T>) {
  return (
    <div className="flex border border-border" role="radiogroup">
      {options.map((opt, i) => (
        <Button
          key={opt.value}
          size="sm"
          variant={value === opt.value ? 'default' : 'ghost'}
          aria-checked={value === opt.value}
          aria-label={opt.ariaLabel ?? opt.label}
          role="radio"
          data-testid={`${testIdPrefix}-${opt.value}`}
          onClick={() => onChange(opt.value)}
          className={cn('flex-1 h-8 text-xs', i > 0 && 'border-l border-border')}
        >
          {opt.label}
        </Button>
      ))}
    </div>
  );
}

/* --------------------------------------------------------------------- */
/* Internal: hover-anchored positioning                                   */
/* --------------------------------------------------------------------- */

interface AnchorPosition {
  top: number;  // px relative to scroll container
  left: number; // px relative to scroll container
}

/**
 * Positioning-only hook. The toolbar's visibility (hover OR popover-open)
 * is owned by the component so a single source of truth controls show/
 * hide; the hook just keeps the offset glued to the H1 across resize +
 * scroll cycles.
 */
function useAnchorToH1(scrollContainer: HTMLElement | null): {
  pos: AnchorPosition;
  /** Latest H1 element (or null) so the component can attach its own
   *  hover listeners without re-querying the DOM. */
  h1: HTMLElement | null;
} {
  const [pos, setPos] = React.useState<AnchorPosition>({ top: 0, left: 0 });
  const [h1El, setH1El] = React.useState<HTMLElement | null>(null);

  React.useEffect(() => {
    if (!scrollContainer) return;

    let h1: HTMLElement | null = null;
    let resizeObs: ResizeObserver | null = null;
    let mutObs: MutationObserver | null = null;
    let rafHandle = 0;

    const measure = () => {
      if (!h1 || !scrollContainer) return;
      const h1Rect = h1.getBoundingClientRect();
      const parentRect = scrollContainer.getBoundingClientRect();
      // Bottom edge of toolbar 4 px above H1 top. Toolbar is 28 px tall.
      const TOOLBAR_HEIGHT = 28;
      const GAP_PX = 4;
      const top =
        h1Rect.top - parentRect.top + scrollContainer.scrollTop - TOOLBAR_HEIGHT - GAP_PX;
      // Subtract the first button's left padding (`px-2` → 8 px) so the
      // first icon's left edge ends up at the H1's left edge — keeps the
      // toolbar's leading glyph vertically aligned with the title text.
      const FIRST_BUTTON_LEFT_PAD_PX = 8;
      const left =
        h1Rect.left - parentRect.left + scrollContainer.scrollLeft - FIRST_BUTTON_LEFT_PAD_PX;
      setPos((prev) => (prev.top === top && prev.left === left ? prev : { top, left }));
    };

    const scheduleMeasure = () => {
      if (rafHandle) cancelAnimationFrame(rafHandle);
      rafHandle = requestAnimationFrame(measure);
    };

    const attach = () => {
      const found = scrollContainer.querySelector<HTMLElement>('.ProseMirror > h1:first-of-type');
      if (found === h1) return;
      if (resizeObs) resizeObs.disconnect();
      h1 = found;
      setH1El(found);
      if (!h1) return;
      resizeObs = new ResizeObserver(scheduleMeasure);
      resizeObs.observe(h1);
      resizeObs.observe(scrollContainer);
      scheduleMeasure();
    };

    mutObs = new MutationObserver(attach);
    mutObs.observe(scrollContainer, { childList: true, subtree: true });
    attach();

    const onScroll = () => scheduleMeasure();
    scrollContainer.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', scheduleMeasure);

    return () => {
      if (rafHandle) cancelAnimationFrame(rafHandle);
      if (mutObs) mutObs.disconnect();
      if (resizeObs) resizeObs.disconnect();
      scrollContainer.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', scheduleMeasure);
    };
  }, [scrollContainer]);

  return { pos, h1: h1El };
}

/**
 * Show / hide the toolbar based on three hover sources (H1 + toolbar
 * + any open popover). A single hovered-source counter avoids the
 * classic two-ref problem where leaving the H1 hides the toolbar even
 * if the cursor already moved into the toolbar (the ref the H1 leave
 * handler reads is a different identity from the one the toolbar
 * mouseenter sets).
 *
 * Returns:
 *   visible   — final boolean the caller uses for opacity / pointer-events
 *   onH1Enter / onH1Leave — attach to the H1 element via addEventListener
 *   onToolbarEnter / onToolbarLeave — attach to the toolbar element via JSX
 */
function useToolbarVisibility(h1: HTMLElement | null, popoverOpen: boolean): {
  visible: boolean;
  onToolbarEnter: () => void;
  onToolbarLeave: () => void;
} {
  const [hoverActive, setHoverActive] = React.useState(false);
  // Ref-backed counters so the leave-timeout doesn't race against
  // intervening enter events.
  const stateRef = React.useRef({ h1: false, toolbar: false });

  const evaluate = React.useCallback(() => {
    setHoverActive(stateRef.current.h1 || stateRef.current.toolbar);
  }, []);

  // Attach H1 listeners. Re-runs when the H1 element identity changes
  // (loading a different note swaps the H1 node).
  React.useEffect(() => {
    if (!h1) return;
    const onEnter = () => {
      stateRef.current.h1 = true;
      evaluate();
    };
    const onLeave = () => {
      stateRef.current.h1 = false;
      // Small grace period so the cursor can transit the 4 px gap to
      // the toolbar without flicker. The toolbar's own mouseenter
      // flips `state.toolbar` true during this window.
      setTimeout(evaluate, 120);
    };
    h1.addEventListener('mouseenter', onEnter);
    h1.addEventListener('mouseleave', onLeave);
    return () => {
      h1.removeEventListener('mouseenter', onEnter);
      h1.removeEventListener('mouseleave', onLeave);
    };
  }, [h1, evaluate]);

  const onToolbarEnter = React.useCallback(() => {
    stateRef.current.toolbar = true;
    evaluate();
  }, [evaluate]);

  const onToolbarLeave = React.useCallback(() => {
    stateRef.current.toolbar = false;
    setTimeout(evaluate, 120);
  }, [evaluate]);

  return {
    visible: hoverActive || popoverOpen,
    onToolbarEnter,
    onToolbarLeave,
  };
}

/* --------------------------------------------------------------------- */
/* Toolbar                                                                */
/* --------------------------------------------------------------------- */

export const PageHeadToolbar: React.FC<PageHeadToolbarProps> = ({
  scrollContainer,
  value,
  handlers,
  layout,
  disabled,
  isMobile,
}) => {
  const { t } = useTranslation();

  // Track open state of any popover so the anchor effect can keep the
  // toolbar visible while a portal-rendered menu is hovered.
  const [openPopover, setOpenPopover] = React.useState<
    null | 'layout' | 'emoji' | 'header' | 'fontScale' | 'pageWidth'
  >(null);
  const anyOpen = openPopover !== null;
  const { pos, h1 } = useAnchorToH1(scrollContainer);
  const { visible: hoverVisible, onToolbarEnter, onToolbarLeave } = useToolbarVisibility(h1, anyOpen);
  // Mobile devices have no hover — keep the toolbar pinned. On
  // desktop, hover / popover-open gates control visibility.
  const visible = isMobile ? true : hoverVisible;

  const setOpen = (key: typeof openPopover) => (open: boolean) =>
    setOpenPopover(open ? key : null);

  if (disabled) return null;
  // On mobile the floating toolbar has nowhere to live — H1 stretches
  // across the full viewport. The same 7 actions live in NoteMenuBar's
  // overflow ⋯ menu as a "Stranica" section, so we just return null
  // here and let that path own the UX.
  if (isMobile) return null;

  const currentFontScale = value.fontScale ?? 'default';

  // Compact (icon-only) ONLY on the 'paper' preset — that's the
  // narrowest layout where labels would overflow the H1. 'wide' has
  // enough horizontal room to keep the labels, and 'full' obviously
  // does too. Mobile gets the compact treatment via the lg:inline
  // breakpoint guard regardless of screenWidth.
  const isCompact = layout.screenWidth === 'paper';
  const labelClass = isCompact ? 'hidden' : 'hidden lg:inline';

  return (
    <div
      data-testid="notes-page-head-toolbar"
      data-notes-popover="true"
      onMouseEnter={onToolbarEnter}
      onMouseLeave={onToolbarLeave}
      style={{
        position: 'absolute',
        top: pos.top,
        left: pos.left,
        opacity: visible ? 1 : 0,
        pointerEvents: visible ? 'auto' : 'none',
        transition: 'opacity 120ms ease',
        zIndex: 40,
      }}
      className={cn(
        // Confluence keeps the page-head row borderless and transparent —
        // it's contextual chrome, not a panel. No border, no background,
        // no shadow. Spacing comes from the gap and each button's own
        // hover state.
        'flex items-center gap-0.5',
      )}
    >
      {/* 1 — Layout (paper + orientation) */}
      <Popover open={openPopover === 'layout'} onOpenChange={setOpen('layout')}>
        <PopoverTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-2 gap-1.5 text-xs"
            data-testid="page-head-layout-button"
            title={t('notes.pageHead.layout.tooltip', 'Page layout (paper size + orientation)')}
          >
            {layout.orientation === 'portrait' ? (
              <RectangleVertical className="h-3.5 w-3.5" />
            ) : (
              <RectangleHorizontal className="h-3.5 w-3.5" />
            )}
            <span className={labelClass}>
              {layout.paperSize} · {t(
                `notes.layout.${layout.orientation}`,
                layout.orientation === 'portrait' ? 'Portrait' : 'Landscape',
              )}
            </span>
          </Button>
        </PopoverTrigger>
        <PopoverContent
          align="start"
          className="w-64 z-[10050] p-4 notes-popover"
          collisionPadding={8}
          data-notes-popover="true"
          data-testid="page-head-layout-popover"
        >
          <div className="space-y-3">
            <div className="space-y-1">
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                {t('notes.layout.paperSize', 'Paper size')}
              </p>
              <Segmented
                value={layout.paperSize}
                onChange={layout.onPaperSizeChange}
                options={[
                  { value: 'A5', label: 'A5' },
                  { value: 'A4', label: 'A4' },
                  { value: 'A3', label: 'A3' },
                ]}
                testIdPrefix="page-head-layout-paper"
              />
            </div>
            <div className="space-y-1">
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                {t('notes.layout.orientation', 'Orientation')}
              </p>
              <Segmented
                value={layout.orientation}
                onChange={layout.onOrientationChange}
                options={[
                  { value: 'portrait', label: t('notes.layout.portrait', 'Portrait') },
                  { value: 'landscape', label: t('notes.layout.landscape', 'Landscape') },
                ]}
                testIdPrefix="page-head-layout-orientation"
              />
            </div>
          </div>
        </PopoverContent>
      </Popover>

      {/* 2 — Emoji (add / change / remove) */}
      <Popover open={openPopover === 'emoji'} onOpenChange={setOpen('emoji')}>
        <PopoverTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-2 gap-1.5 text-xs"
            data-testid="page-head-emoji-button"
            title={
              value.emoji
                ? t('notes.pageHead.emoji.changeTooltip', 'Change or remove emoji')
                : t('notes.pageHead.emoji.addTooltip', 'Add emoji')
            }
          >
            {value.emoji ? (
              <>
                <X className="h-3.5 w-3.5" />
                <span className={labelClass}>
                  {t('notes.pageHead.emoji.remove', 'Remove emoji')}
                </span>
              </>
            ) : (
              <>
                <Smile className="h-3.5 w-3.5" />
                <span className={labelClass}>
                  {t('notes.pageHead.emoji.add', 'Add emoji')}
                </span>
              </>
            )}
          </Button>
        </PopoverTrigger>
        <PopoverContent
          align="start"
          className="w-72 z-[10050] p-3 notes-popover"
          collisionPadding={8}
          data-notes-popover="true"
          data-testid="page-head-emoji-popover"
        >
          <div className="space-y-3">
            <div>
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">
                {t('notes.pageHead.emoji.quick', 'Quick picks')}
              </p>
              <div className="grid grid-cols-6 gap-1">
                {EMOJI_QUICK.map((e) => (
                  <Button
                    key={e}
                    variant={value.emoji === e ? 'default' : 'ghost'}
                    size="sm"
                    className="h-9 w-9 text-lg p-0"
                    data-testid={`page-head-emoji-quick-${e}`}
                    onClick={() => {
                      handlers.onEmojiChange(e);
                      setOpenPopover(null);
                    }}
                  >
                    {e}
                  </Button>
                ))}
              </div>
            </div>
            <div className="space-y-1">
              <label
                htmlFor="page-head-emoji-input"
                className="text-xs font-medium text-muted-foreground uppercase tracking-wide"
              >
                {t('notes.pageHead.emoji.custom', 'Custom')}
              </label>
              <input
                id="page-head-emoji-input"
                type="text"
                maxLength={8}
                defaultValue={value.emoji ?? ''}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    const v = (e.currentTarget.value || '').trim();
                    handlers.onEmojiChange(v.length === 0 ? null : v);
                    setOpenPopover(null);
                  }
                }}
                placeholder={t('notes.pageHead.emoji.customPlaceholder', 'Paste any emoji and press Enter')}
                className="w-full h-9 text-lg px-2 border border-border bg-background outline-none focus:border-primary"
                data-testid="page-head-emoji-input"
              />
            </div>
            {value.emoji && (
              <Button
                variant="ghost"
                size="sm"
                className="w-full h-8 text-xs"
                data-testid="page-head-emoji-clear"
                onClick={() => {
                  handlers.onEmojiChange(null);
                  setOpenPopover(null);
                }}
              >
                <X className="h-3.5 w-3.5 mr-1.5" />
                {t('notes.pageHead.emoji.remove', 'Remove emoji')}
              </Button>
            )}
          </div>
        </PopoverContent>
      </Popover>

      {/* Header image (banner) */}
      <Popover open={openPopover === 'header'} onOpenChange={setOpen('header')}>
        <PopoverTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-2 gap-1.5 text-xs"
            data-testid="page-head-header-image-button"
            title={t('notes.pageHead.headerImage.tooltip', 'Add or remove header image')}
          >
            <ImageIcon className="h-3.5 w-3.5" />
            <span className={labelClass}>
              {value.headerImageUrl
                ? t('notes.pageHead.headerImage.change', 'Change header image')
                : t('notes.pageHead.headerImage.add', 'Header image')}
            </span>
          </Button>
        </PopoverTrigger>
        <PopoverContent
          align="start"
          className="w-72 z-[10050] p-3 notes-popover"
          collisionPadding={8}
          data-notes-popover="true"
          data-testid="page-head-header-image-popover"
        >
          <HeaderImagePicker
            currentUrl={value.headerImageUrl}
            onUpload={async (file) => {
              const url = await handlers.onUploadHeaderImage(file);
              handlers.onHeaderImageChange(url);
              setOpenPopover(null);
            }}
            onRemove={() => {
              handlers.onHeaderImageChange(null);
              setOpenPopover(null);
            }}
            onPaste={(url) => {
              handlers.onHeaderImageChange(url);
              setOpenPopover(null);
            }}
          />
        </PopoverContent>
      </Popover>

      {/* 5 — Suggest title (instant action, no popover) */}
      <Button
        variant="ghost"
        size="sm"
        className="h-7 px-2 gap-1.5 text-xs"
        data-testid="page-head-suggest-title-button"
        title={t('notes.pageHead.suggestTitle.tooltip', 'Generate a title from the body text')}
        onClick={handlers.onSuggestTitle}
      >
        <Sparkles className="h-3.5 w-3.5" />
        <span className={labelClass}>
          {t('notes.pageHead.suggestTitle.label', 'Suggest title')}
        </span>
      </Button>

      {/* 6 — Text size (font scale) */}
      <Popover open={openPopover === 'fontScale'} onOpenChange={setOpen('fontScale')}>
        <PopoverTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-2 gap-1.5 text-xs"
            data-testid="page-head-font-scale-button"
            title={t('notes.pageHead.fontScale.tooltip', 'Editor text size')}
          >
            <TypeIcon className="h-3.5 w-3.5" />
            <span className={labelClass}>A↑</span>
          </Button>
        </PopoverTrigger>
        <PopoverContent
          align="start"
          className="w-64 z-[10050] p-3 notes-popover"
          collisionPadding={8}
          data-notes-popover="true"
          data-testid="page-head-font-scale-popover"
        >
          <div className="space-y-2">
            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
              {t('notes.pageHead.fontScale.label', 'Text size')}
            </p>
            <Segmented
              value={currentFontScale}
              onChange={(v) => {
                handlers.onFontScaleChange(v === 'default' ? null : v);
              }}
              options={FONT_SCALES.map((f) => ({
                value: f.value,
                label: t(f.labelKey, f.fallback),
              }))}
              testIdPrefix="page-head-font-scale"
            />
          </div>
        </PopoverContent>
      </Popover>

      {/* 7 — Page width */}
      <Popover open={openPopover === 'pageWidth'} onOpenChange={setOpen('pageWidth')}>
        <PopoverTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-2 gap-1.5 text-xs"
            data-testid="page-head-page-width-button"
            title={t('notes.pageHead.pageWidth.tooltip', 'On-screen page width')}
          >
            {layout.screenWidth === 'full' ? (
              <LayoutPanelTop className="h-3.5 w-3.5" />
            ) : (
              <MoveHorizontal className="h-3.5 w-3.5" />
            )}
            <span className={labelClass}>
              {t(
                PAGE_WIDTHS.find((w) => w.value === layout.screenWidth)?.labelKey ?? 'notes.pageHead.pageWidth.paper',
                PAGE_WIDTHS.find((w) => w.value === layout.screenWidth)?.fallback ?? 'Default',
              )}
            </span>
          </Button>
        </PopoverTrigger>
        <PopoverContent
          align="start"
          className="w-64 z-[10050] p-3 notes-popover"
          collisionPadding={8}
          data-notes-popover="true"
          data-testid="page-head-page-width-popover"
        >
          <div className="space-y-2">
            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
              {t('notes.pageHead.pageWidth.label', 'Page width')}
            </p>
            <Segmented
              value={layout.screenWidth}
              onChange={layout.onScreenWidthChange}
              options={PAGE_WIDTHS.map((w) => ({
                value: w.value,
                label: t(w.labelKey, w.fallback),
              }))}
              testIdPrefix="page-head-page-width"
            />
            <p className="text-[10px] text-muted-foreground leading-snug">
              {t(
                'notes.pageHead.pageWidth.hint',
                'On-screen only — the printed PDF still reflows to the chosen paper size.',
              )}
            </p>
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
};

/* --------------------------------------------------------------------- */
/* Header image picker                                                    */
/* --------------------------------------------------------------------- */

interface HeaderImagePickerProps {
  currentUrl: string | null;
  onUpload: (file: File) => Promise<void>;
  onRemove: () => void;
  onPaste: (url: string) => void;
}

const HeaderImagePicker: React.FC<HeaderImagePickerProps> = ({ currentUrl, onUpload, onRemove, onPaste }) => {
  const { t } = useTranslation();
  const fileRef = React.useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [urlInput, setUrlInput] = React.useState('');

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setError(null);
    setUploading(true);
    try {
      await onUpload(file);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed');
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  return (
    <div className="space-y-3">
      {currentUrl && (
        <div className="space-y-1">
          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
            {t('notes.pageHead.headerImage.preview', 'Current')}
          </p>
          <div className="relative w-full h-20 bg-muted border border-border overflow-hidden">
            <img
              src={currentUrl}
              alt=""
              className="w-full h-full object-cover"
              data-testid="page-head-header-image-preview"
            />
          </div>
          <Button
            variant="ghost"
            size="sm"
            className="w-full h-8 text-xs"
            data-testid="page-head-header-image-remove"
            onClick={onRemove}
          >
            <X className="h-3.5 w-3.5 mr-1.5" />
            {t('notes.pageHead.headerImage.remove', 'Remove header image')}
          </Button>
        </div>
      )}

      <div className="space-y-1">
        <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
          {t('notes.pageHead.headerImage.upload', 'Upload')}
        </p>
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={handleFileChange}
          data-testid="page-head-header-image-file"
        />
        <Button
          variant="outline"
          size="sm"
          className="w-full h-9 text-xs"
          disabled={uploading}
          onClick={() => fileRef.current?.click()}
          data-testid="page-head-header-image-upload-button"
        >
          <Upload className="h-3.5 w-3.5 mr-1.5" />
          {uploading
            ? t('notes.pageHead.headerImage.uploading', 'Uploading…')
            : t('notes.pageHead.headerImage.uploadButton', 'Choose image…')}
        </Button>
        {error && (
          <p className="text-[11px] text-destructive" data-testid="page-head-header-image-error">
            {error}
          </p>
        )}
      </div>

      <div className="space-y-1">
        <label
          htmlFor="page-head-header-image-url"
          className="text-xs font-medium text-muted-foreground uppercase tracking-wide"
        >
          {t('notes.pageHead.headerImage.urlLabel', 'Or paste image URL')}
        </label>
        <div className="flex gap-1">
          <input
            id="page-head-header-image-url"
            type="url"
            value={urlInput}
            onChange={(e) => setUrlInput(e.target.value)}
            placeholder="https://…"
            className="flex-1 h-9 px-2 text-xs border border-border bg-background outline-none focus:border-primary"
            data-testid="page-head-header-image-url-input"
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                const v = urlInput.trim();
                if (v.length > 0) onPaste(v);
              }
            }}
          />
          <Button
            variant="outline"
            size="sm"
            className="h-9 px-3 text-xs"
            data-testid="page-head-header-image-url-apply"
            disabled={urlInput.trim().length === 0}
            onClick={() => {
              const v = urlInput.trim();
              if (v.length > 0) onPaste(v);
            }}
          >
            {t('common.apply', 'Apply')}
          </Button>
        </div>
      </div>
    </div>
  );
};

export default PageHeadToolbar;
