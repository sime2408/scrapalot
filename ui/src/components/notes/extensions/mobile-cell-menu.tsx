/**
 * MobileCellMenu
 *
 * Listens for the `scrapalot:mobile-cell-menu-open` CustomEvent
 * dispatched by MobileCellMenuPlugin and renders a context dropdown
 * anchored to the cell button's screen rect.
 *
 * The dropdown bundles every action a phone user might reach for once
 * they're inside a cell: row insert/delete, column insert/delete,
 * clear cell, toggle header row, delete whole table. It deliberately
 * replaces the desktop TableGripOverlay chevrons (which sit OUTSIDE
 * the table and get cropped on narrow viewports) — Confluence uses
 * the same in-cell trigger on mobile.
 */

import * as React from 'react';
import type { Editor } from '@tiptap/react';
import { useTranslation } from 'react-i18next';
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Eraser,
  PanelTop,
  TextSelect,
  Trash2,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  MOBILE_CELL_MENU_EVENT,
  type MobileCellMenuOpenDetail,
} from './mobile-cell-menu-plugin';
import {
  clearRowCells,
  clearColumnCells,
  selectColumn,
  selectRow,
} from './table-commands';

interface MobileCellMenuProps {
  editor: Editor | null;
}

interface OpenState {
  anchor: { top: number; left: number; bottom: number; right: number };
  rowIndex: number;
  colIndex: number;
}

export const MobileCellMenu: React.FC<MobileCellMenuProps> = ({ editor }) => {
  const { t } = useTranslation();
  const [state, setState] = React.useState<OpenState | null>(null);
  const menuRef = React.useRef<HTMLDivElement | null>(null);

  React.useEffect(() => {
    const onOpen = (e: Event) => {
      const detail = (e as CustomEvent<MobileCellMenuOpenDetail>).detail;
      if (!detail) return;
      const r = detail.rect;
      setState({
        anchor: {
          top: r.top,
          left: r.left,
          bottom: r.bottom,
          right: r.right,
        },
        rowIndex: detail.rowIndex,
        colIndex: detail.colIndex,
      });
    };
    window.addEventListener(MOBILE_CELL_MENU_EVENT, onOpen);
    return () => window.removeEventListener(MOBILE_CELL_MENU_EVENT, onOpen);
  }, []);

  // Dismiss on outside click / Escape.
  React.useEffect(() => {
    if (!state) return;
    const onDown = (e: PointerEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setState(null);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setState(null);
    };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [state]);

  if (!editor || !state) return null;

  const close = () => setState(null);

  const run = (fn: () => void) => () => {
    fn();
    close();
  };

  // Pin the menu BELOW the trigger button by default; flip above if it
  // would render off-screen. left aligns to the button's left so it
  // doesn't extend past the cell's right edge.
  const MENU_WIDTH = 220;
  const MENU_HEIGHT = 360;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  let top = state.anchor.bottom + 4;
  let left = state.anchor.left;
  if (top + MENU_HEIGHT > vh) top = Math.max(8, state.anchor.top - MENU_HEIGHT - 4);
  if (left + MENU_WIDTH > vw - 8) left = Math.max(8, vw - MENU_WIDTH - 8);

  const { rowIndex, colIndex } = state;

  return (
    <div
      ref={menuRef}
      data-testid="notes-mobile-cell-menu"
      role="menu"
      data-notes-popover="true"
      className={cn(
        'fixed z-[10090]',
        'w-[220px] bg-popover border border-border shadow-lg py-1',
        'animate-in fade-in-0 zoom-in-95 duration-100',
      )}
      style={{ top: `${top}px`, left: `${left}px` }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <MenuItem
        icon={TextSelect}
        label={t('notes.table.selectRow', 'Select row')}
        onClick={run(() => selectRow(editor, rowIndex))}
      />
      <MenuItem
        icon={TextSelect}
        label={t('notes.table.selectColumn', 'Select column')}
        onClick={run(() => selectColumn(editor, colIndex))}
      />
      <Separator />
      <MenuItem
        icon={ArrowUp}
        label={t('notes.table.addRowBefore', 'Row above')}
        onClick={run(() => editor.chain().focus().addRowBefore().run())}
      />
      <MenuItem
        icon={ArrowDown}
        label={t('notes.table.addRowAfter', 'Row below')}
        onClick={run(() => editor.chain().focus().addRowAfter().run())}
      />
      <MenuItem
        icon={Trash2}
        label={t('notes.table.deleteRow', 'Delete row')}
        destructive
        onClick={run(() => editor.chain().focus().deleteRow().run())}
      />
      <Separator />
      <MenuItem
        icon={ArrowLeft}
        label={t('notes.table.addColumnBefore', 'Column before')}
        onClick={run(() => editor.chain().focus().addColumnBefore().run())}
      />
      <MenuItem
        icon={ArrowRight}
        label={t('notes.table.addColumnAfter', 'Column after')}
        onClick={run(() => editor.chain().focus().addColumnAfter().run())}
      />
      <MenuItem
        icon={Trash2}
        label={t('notes.table.deleteColumn', 'Delete column')}
        destructive
        onClick={run(() => editor.chain().focus().deleteColumn().run())}
      />
      <Separator />
      <MenuItem
        icon={Eraser}
        label={t('notes.table.clearCells', 'Clear cells')}
        onClick={run(() => {
          clearRowCells(editor, rowIndex);
          clearColumnCells(editor, colIndex);
        })}
      />
      <MenuItem
        icon={PanelTop}
        label={t('notes.table.toggleHeader', 'Toggle header')}
        onClick={run(() => editor.chain().focus().toggleHeaderRow().run())}
      />
      <Separator />
      <MenuItem
        icon={Trash2}
        label={t('notes.table.deleteTable', 'Delete table')}
        destructive
        onClick={run(() => editor.chain().focus().deleteTable().run())}
      />
    </div>
  );
};

const Separator: React.FC = () => <div className="h-px bg-border my-1" />;

const MenuItem: React.FC<{
  icon: React.ElementType;
  label: string;
  destructive?: boolean;
  onClick: () => void;
}> = ({ icon: Icon, label, destructive, onClick }) => (
  <button
    type="button"
    role="menuitem"
    onPointerDown={(e) => e.preventDefault()}
    onClick={(e) => {
      e.preventDefault();
      e.stopPropagation();
      onClick();
    }}
    className={cn(
      'w-full flex items-center gap-2 px-3 py-2 text-sm transition-colors',
      destructive
        ? 'text-destructive hover:bg-destructive/10'
        : 'hover:bg-accent hover:text-accent-foreground',
    )}
  >
    <Icon className="h-3.5 w-3.5 shrink-0" />
    <span>{label}</span>
  </button>
);

export default MobileCellMenu;
