/**
 * MobileEditingToolbar
 *
 * Single bottom-anchored action bar that re-skins based on the editor
 * context:
 *   - cursor inside a table → table operations (add/remove col, row,
 *     header, alignment, delete table)
 *   - text selection is non-empty → text formatting (bold, italic,
 *     underline, strike, code, link)
 *   - neither → toolbar is hidden
 *
 * Table takes priority when both apply (selection inside a table cell)
 * because table operations are the harder-to-reach actions on phones.
 *
 * Positioning: `position: fixed; bottom: keyboardOffset` where
 * `keyboardOffset` is derived from `window.visualViewport` so the bar
 * stays glued just above the soft keyboard on iOS Safari (which does
 * NOT auto-lift fixed-bottom elements, unlike Chrome Android). Falls
 * back to 0 (safe-area only) when the keyboard isn't shown or the API
 * isn't available.
 *
 * Drop-in replacement for the previous MobileTableToolbar — keeps the
 * same export name + props so existing call sites don't change.
 */

import * as React from 'react';
import type { Editor } from '@tiptap/react';
import { useTranslation } from 'react-i18next';
import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  Bold,
  ChevronsLeft,
  ChevronsRight,
  Code,
  Italic,
  Link as LinkIcon,
  Minus,
  PanelTop,
  Plus,
  Strikethrough,
  Trash2,
  Underline,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

interface MobileTableToolbarProps {
  editor: Editor | null;
  /** When false the toolbar is suppressed regardless of selection (e.g.
   *  read-only viewers). */
  enabled?: boolean;
}

type AlignValue = 'left' | 'center' | 'right';
type Mode = 'table' | 'text' | 'none';

const ALIGN_CYCLE: AlignValue[] = ['left', 'center', 'right'];

function nextAlign(current: string | undefined): AlignValue {
  const idx = ALIGN_CYCLE.indexOf((current ?? 'left') as AlignValue);
  return ALIGN_CYCLE[(idx + 1) % ALIGN_CYCLE.length];
}

function AlignIcon({ value, className }: { value: AlignValue; className?: string }) {
  if (value === 'center') return <AlignCenter className={className} />;
  if (value === 'right') return <AlignRight className={className} />;
  return <AlignLeft className={className} />;
}

/** Track the on-screen keyboard's height via the visualViewport API.
 *  iOS Safari (≤ 15.3) doesn't auto-lift fixed elements above the
 *  keyboard like Chrome Android does; reading `innerHeight - vv.height
 *  - vv.offsetTop` gives the keyboard's intrusion in CSS pixels, so we
 *  can shove the toolbar above it ourselves. */
function useKeyboardOffset(): number {
  const [offset, setOffset] = React.useState(0);

  React.useEffect(() => {
    const vv = typeof window !== 'undefined' ? window.visualViewport : null;
    if (!vv) return;

    const recompute = () => {
      const kb = window.innerHeight - vv.height - vv.offsetTop;
      // Filter out sub-pixel noise + any negative-rounded values.
      setOffset(kb > 1 ? Math.round(kb) : 0);
    };

    recompute();
    vv.addEventListener('resize', recompute);
    vv.addEventListener('scroll', recompute);
    return () => {
      vv.removeEventListener('resize', recompute);
      vv.removeEventListener('scroll', recompute);
    };
  }, []);

  return offset;
}

export const MobileTableToolbar: React.FC<MobileTableToolbarProps> = ({ editor, enabled = true }) => {
  const { t } = useTranslation();
  const [mode, setMode] = React.useState<Mode>('none');
  const [currentAlign, setCurrentAlign] = React.useState<AlignValue>('left');
  const [activeMarks, setActiveMarks] = React.useState({
    bold: false,
    italic: false,
    underline: false,
    strike: false,
    code: false,
    link: false,
  });
  const keyboardOffset = useKeyboardOffset();

  React.useEffect(() => {
    if (!editor) return;
    const sync = () => {
      const inTable = editor.isActive('table');
      const sel = editor.state.selection;
      const hasTextSelection = !sel.empty;

      // Table mode wins over text mode when the user is inside a table
      // cell, even with a non-empty selection — the table operations
      // are the ones that are unreachable without this toolbar on phones.
      let next: Mode = 'none';
      if (inTable) next = 'table';
      else if (hasTextSelection) next = 'text';

      setMode(next);

      if (next === 'table') {
        const attrs = editor.getAttributes('paragraph');
        const a = (attrs.textAlign as AlignValue | undefined) ?? 'left';
        setCurrentAlign(ALIGN_CYCLE.includes(a) ? a : 'left');
      } else if (next === 'text') {
        setActiveMarks({
          bold: editor.isActive('bold'),
          italic: editor.isActive('italic'),
          underline: editor.isActive('underline'),
          strike: editor.isActive('strike'),
          code: editor.isActive('code'),
          link: editor.isActive('link'),
        });
      }
    };
    sync();
    editor.on('selectionUpdate', sync);
    editor.on('transaction', sync);
    return () => {
      editor.off('selectionUpdate', sync);
      editor.off('transaction', sync);
    };
  }, [editor]);

  if (!editor || !enabled || mode === 'none') return null;

  // preventDefault on pointerdown stops the tap from blurring the
  // ProseMirror selection (CellSelection / TextSelection lost), which
  // would make the chained command target nothing.
  const preventBlur = (e: React.PointerEvent) => e.preventDefault();

  const run = (fn: () => void) => () => {
    fn();
  };

  const cycleAlign = () => {
    const next = nextAlign(currentAlign);
    editor.chain().focus().setTextAlign(next).run();
    setCurrentAlign(next);
  };

  const promptLink = () => {
    const previousUrl = editor.getAttributes('link').href as string | undefined;
    // eslint-disable-next-line no-alert
    const url = window.prompt(
      t('notes.editor.linkPrompt', 'URL (leave empty to remove):'),
      previousUrl ?? '',
    );
    if (url === null) return;
    if (url === '') {
      editor.chain().focus().extendMarkRange('link').unsetLink().run();
      return;
    }
    editor.chain().focus().extendMarkRange('link').setLink({ href: url }).run();
  };

  return (
    <div
      data-testid={mode === 'table' ? 'notes-mobile-table-toolbar' : 'notes-mobile-text-toolbar'}
      data-mobile-editing-mode={mode}
      role="toolbar"
      aria-label={
        mode === 'table'
          ? t('notes.table.mobileToolbar.aria', 'Table actions')
          : t('notes.editor.mobileTextToolbar.aria', 'Text formatting')
      }
      className={cn(
        'fixed inset-x-0 z-[10080]',
        'pb-[env(safe-area-inset-bottom)]',
        'border-t border-border bg-background/95 backdrop-blur',
        'shadow-[0_-2px_8px_rgba(0,0,0,0.08)]',
      )}
      style={{
        // Manual keyboard offset for iOS Safari; falls back to 0 +
        // safe-area-inset-bottom (via padding above) on devices where
        // the OS already keeps the keyboard out of fixed-bottom space.
        bottom: `${keyboardOffset}px`,
      }}
      onPointerDown={preventBlur}
    >
      <div
        className={cn(
          'flex items-stretch gap-0 overflow-x-auto no-scrollbar',
          'min-h-[48px]',
        )}
      >
        {mode === 'table' ? (
          <>
            <ToolbarButton
              testId="mtt-add-col-before"
              label={t('notes.table.addColumnBefore', 'Column before')}
              icon={<><ChevronsLeft className="h-4 w-4" /><Plus className="h-3 w-3 -ml-0.5" /></>}
              onClick={run(() => editor.chain().focus().addColumnBefore().run())}
            />
            <ToolbarButton
              testId="mtt-add-col-after"
              label={t('notes.table.addColumnAfter', 'Column after')}
              icon={<><Plus className="h-3 w-3 -mr-0.5" /><ChevronsRight className="h-4 w-4" /></>}
              onClick={run(() => editor.chain().focus().addColumnAfter().run())}
            />
            <ToolbarButton
              testId="mtt-delete-col"
              label={t('notes.table.deleteColumn', 'Delete column')}
              icon={<><Minus className="h-3 w-3" /><ChevronsRight className="h-4 w-4 opacity-60" /></>}
              onClick={run(() => editor.chain().focus().deleteColumn().run())}
              destructive
            />
            <Divider />
            <ToolbarButton
              testId="mtt-add-row-before"
              label={t('notes.table.addRowBefore', 'Row above')}
              icon={
                <div className="flex flex-col items-center leading-none">
                  <Plus className="h-3 w-3" />
                  <span className="block h-0.5 w-3 bg-current mt-0.5" />
                </div>
              }
              onClick={run(() => editor.chain().focus().addRowBefore().run())}
            />
            <ToolbarButton
              testId="mtt-add-row-after"
              label={t('notes.table.addRowAfter', 'Row below')}
              icon={
                <div className="flex flex-col items-center leading-none">
                  <span className="block h-0.5 w-3 bg-current mb-0.5" />
                  <Plus className="h-3 w-3" />
                </div>
              }
              onClick={run(() => editor.chain().focus().addRowAfter().run())}
            />
            <ToolbarButton
              testId="mtt-delete-row"
              label={t('notes.table.deleteRow', 'Delete row')}
              icon={
                <div className="flex flex-col items-center leading-none">
                  <span className="block h-0.5 w-3 bg-current opacity-60 mb-0.5" />
                  <Minus className="h-3 w-3" />
                </div>
              }
              onClick={run(() => editor.chain().focus().deleteRow().run())}
              destructive
            />
            <Divider />
            <ToolbarButton
              testId="mtt-toggle-header"
              label={t('notes.table.toggleHeader', 'Toggle header')}
              icon={<PanelTop className="h-4 w-4" />}
              onClick={run(() => editor.chain().focus().toggleHeaderRow().run())}
            />
            <ToolbarButton
              testId="mtt-align"
              label={t('notes.table.cycleAlign', 'Cycle alignment')}
              icon={<AlignIcon value={currentAlign} className="h-4 w-4" />}
              onClick={cycleAlign}
            />
            <Divider />
            <ToolbarButton
              testId="mtt-delete-table"
              label={t('notes.table.deleteTable', 'Delete table')}
              icon={<Trash2 className="h-4 w-4" />}
              onClick={run(() => editor.chain().focus().deleteTable().run())}
              destructive
            />
          </>
        ) : (
          <>
            <ToolbarButton
              testId="met-bold"
              label={t('notes.editor.bold', 'Bold')}
              icon={<Bold className="h-4 w-4" />}
              active={activeMarks.bold}
              onClick={run(() => editor.chain().focus().toggleBold().run())}
            />
            <ToolbarButton
              testId="met-italic"
              label={t('notes.editor.italic', 'Italic')}
              icon={<Italic className="h-4 w-4" />}
              active={activeMarks.italic}
              onClick={run(() => editor.chain().focus().toggleItalic().run())}
            />
            <ToolbarButton
              testId="met-underline"
              label={t('notes.editor.underline', 'Underline')}
              icon={<Underline className="h-4 w-4" />}
              active={activeMarks.underline}
              onClick={run(() => editor.chain().focus().toggleUnderline().run())}
            />
            <ToolbarButton
              testId="met-strike"
              label={t('notes.editor.strike', 'Strikethrough')}
              icon={<Strikethrough className="h-4 w-4" />}
              active={activeMarks.strike}
              onClick={run(() => editor.chain().focus().toggleStrike().run())}
            />
            <Divider />
            <ToolbarButton
              testId="met-code"
              label={t('notes.editor.code', 'Inline code')}
              icon={<Code className="h-4 w-4" />}
              active={activeMarks.code}
              onClick={run(() => editor.chain().focus().toggleCode().run())}
            />
            <ToolbarButton
              testId="met-link"
              label={t('notes.editor.link', 'Link')}
              icon={<LinkIcon className="h-4 w-4" />}
              active={activeMarks.link}
              onClick={promptLink}
            />
          </>
        )}
      </div>
    </div>
  );
};

const Divider: React.FC = () => (
  <span aria-hidden className="my-2 w-px shrink-0 bg-border" />
);

interface ToolbarButtonProps {
  testId: string;
  label: string;
  icon: React.ReactNode;
  onClick: () => void;
  destructive?: boolean;
  active?: boolean;
}

const ToolbarButton: React.FC<ToolbarButtonProps> = ({ testId, label, icon, onClick, destructive, active }) => (
  <Tooltip>
    <TooltipTrigger asChild>
      <button
        type="button"
        data-testid={testId}
        aria-label={label}
        aria-pressed={active || undefined}
        onClick={onClick}
        className={cn(
          // 48 px square target — Apple HIG minimum + Material Design.
          'flex h-12 min-w-[48px] flex-1 shrink-0 items-center justify-center gap-0.5',
          'text-foreground active:bg-accent transition-colors',
          // Subtle vertical separator on every button keeps the row
          // scannable even when divider <span>s are off-screen.
          'border-r border-border/40 last:border-r-0',
          active && 'bg-accent text-accent-foreground',
          destructive && 'text-destructive',
        )}
      >
        {icon}
      </button>
    </TooltipTrigger>
    <TooltipContent side="top" className="text-xs">
      {label}
    </TooltipContent>
  </Tooltip>
);

export default MobileTableToolbar;
