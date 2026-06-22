/**
 * TableAlignmentToolbar
 *
 * Confluence-style floating toolbar that appears underneath a table when
 * the whole table is selected (NodeSelection on the `table` node, fired
 * by the 6-dot grip in TableGripOverlay).
 *
 * Surfaces the same set of actions Confluence shows in that strip:
 *   - Table options (dropdown): toggle header row, distribute columns,
 *     delete table
 *   - Vertical-align (cell-content vertical alignment) dropdown
 *   - Horizontal layout (default / wide / full width) dropdown
 *   - Overflow ⋯ — currently mirrors the row/column quick-actions from
 *     TableGripMenu so the picker stays reachable from the table-level
 *     selection without re-clicking individual row/column chevrons.
 *
 * Positioning: absolute inside the editor's drag-handle overlay layer
 * (same overlay everything else uses), anchored to `tableInfo`. Renders
 * only while the active selection IS a whole-table NodeSelection.
 */

import * as React from 'react';
import { Editor } from '@tiptap/react';
import type { CellSelection } from 'prosemirror-tables';
import { TextSelection } from '@tiptap/pm/state';
import { isWholeTableSelected } from './table-commands';
// TableOverlayInfo import dropped — toolbar now anchors directly off
// activeTable.getBoundingClientRect() relative to scrollContainer.
import {
  AlignVerticalJustifyCenter,
  AlignVerticalJustifyEnd,
  AlignVerticalJustifyStart,
  Columns3,
  MoreHorizontal,
  Sliders,
  Trash2,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';

export interface TableAlignmentToolbarProps {
  editor: Editor;
  /** The scroll container whose coordinate system this toolbar lives
   *  in. The toolbar is absolutely positioned inside this element so
   *  it scrolls with the document. */
  scrollContainer: HTMLElement | null;
}

/** Read inline width / data-layout off the active table for the icon
 *  active state. Layout is persisted as `data-table-layout` so the
 *  styled-component CSS can match width presets even after reload. */
function getActiveTable(editor: Editor): HTMLTableElement | null {
  if (!isWholeTableSelected(editor)) return null;
  // Walk from the selection anchor up to its containing <table>.
  try {
    const { $anchorCell } = editor.state.selection as CellSelection;
    // The anchor sits inside a cell — walk depth until we hit the table.
    for (let d = $anchorCell.depth; d >= 0; d--) {
      const node = $anchorCell.node(d);
      if (node.type.name === 'table') {
        const tablePos = $anchorCell.before(d);
        const dom = editor.view.nodeDOM(tablePos) as HTMLElement | null;
        if (dom?.tagName === 'TABLE') return dom as HTMLTableElement;
        return dom?.querySelector('table') ?? null;
      }
    }
  } catch {
    /* fall through */
  }
  return editor.view.dom.querySelector('table');
}

// Note: handlers below take an explicit `table: HTMLTableElement` so
// the caller can hand in the captured-at-render-time reference. Doing
// a fresh getActiveTable(editor) inside the handler would frequently
// fail because clicking a Radix DropdownMenuTrigger steals focus from
// ProseMirror BEFORE the click fires; by the time the handler runs,
// the CellSelection is gone and getActiveTable returns null.
//
// Each helper also commits the change to the table's node attribute
// (via setNodeMarkup) so the value survives the next ProseMirror
// re-render — inline DOM mutations alone get wiped on Y.js sync /
// autosave / any state update.

function commitTableAttr(
  editor: Editor,
  table: HTMLTableElement,
  attrs: Partial<{ width: string | null; tableLayout: string | null; tableValign: string | null }>,
): void {
  try {
    const pos = editor.view.posAtDOM(table, 0);
    if (pos < 0) return;
    const $pos = editor.state.doc.resolve(pos);
    for (let d = $pos.depth; d >= 0; d--) {
      if ($pos.node(d).type.name === 'table') {
        const tablePos = $pos.before(d);
        const node = editor.state.doc.nodeAt(tablePos);
        if (node) {
          editor.view.dispatch(
            editor.state.tr.setNodeMarkup(tablePos, undefined, {
              ...node.attrs,
              ...attrs,
            }),
          );
        }
        return;
      }
    }
  } catch (err) {
    console.warn('[TableAlignmentToolbar] commitTableAttr failed', err);
  }
}

function applyLayout(
  editor: Editor,
  table: HTMLTableElement,
  layout: 'default' | 'wide' | 'full',
): void {
  table.dataset.tableLayout = layout;
  let width: string;
  if (layout === 'full') {
    width = '100%';
    table.style.marginLeft = '0';
    table.style.marginRight = '0';
  } else if (layout === 'wide') {
    width = '120%';
    table.style.marginLeft = '-10%';
    table.style.marginRight = '-10%';
  } else {
    width = '100%';
    table.style.marginLeft = '';
    table.style.marginRight = '';
  }
  table.style.setProperty('width', width, 'important');
  commitTableAttr(editor, table, { width, tableLayout: layout });
}

function applyVerticalAlign(
  editor: Editor,
  table: HTMLTableElement,
  align: 'top' | 'middle' | 'bottom',
): void {
  table.dataset.tableValign = align;
  table.querySelectorAll<HTMLElement>('td, th').forEach((cell) => {
    // The editor stylesheet sets `vertical-align: top !important` on
    // td/th — assigning to .style.verticalAlign without !important is
    // silently dropped. setProperty(...,'important') puts the inline
    // rule above the stylesheet's !important.
    cell.style.setProperty('vertical-align', align, 'important');
  });
  commitTableAttr(editor, table, { tableValign: align });
}

export const TableAlignmentToolbar: React.FC<TableAlignmentToolbarProps> = ({ editor, scrollContainer }) => {
  // The toolbar must survive the CellSelection being torn down — that
  // happens on the very first click against any DropdownMenuTrigger
  // (Radix steals focus, ProseMirror clears the cell selection, and a
  // strict "render only when selected" gate would unmount the toolbar
  // before the click fires). So we promote whatever <table> the 6-dot
  // grip last whole-selected into local state and keep it sticky.
  // It clears on:
  //   - click outside the table AND outside the toolbar
  //   - the captured <table> being removed from the DOM (Delete table)
  //   - Escape
  const [activeTable, setActiveTable] = React.useState<HTMLTableElement | null>(null);
  const toolbarDomRef = React.useRef<HTMLDivElement | null>(null);

  // Whenever ProseMirror's selection becomes a whole-table CellSelection,
  // re-anchor activeTable. The hook fires for every editor update so
  // we don't miss the selection that the 6-dot grip dispatches.
  React.useEffect(() => {
    const sync = () => {
      if (isWholeTableSelected(editor)) {
        const live = getActiveTable(editor);
        if (live) setActiveTable(live);
      }
    };
    sync();
    editor.on('selectionUpdate', sync);
    return () => {
      editor.off('selectionUpdate', sync);
    };
  }, [editor]);

  // Click-outside dismissal — only fires when the cursor lands somewhere
  // that's NEITHER the captured table NOR the toolbar (or any popover
  // it spawned, marked with data-table-alignment-popover).
  React.useEffect(() => {
    if (!activeTable) return;
    const onPointerDown = (e: MouseEvent) => {
      const target = e.target as Node | null;
      if (!target) return;
      if (activeTable.contains(target)) return;
      if (toolbarDomRef.current?.contains(target)) return;
      // Radix DropdownMenuContent portals out of the toolbar; tag it
      // via data attribute on each DropdownMenuContent so the closest()
      // walk picks it up. Cheaper: any element marked
      // data-radix-popper-content-wrapper is treated as toolbar-adjacent.
      if ((target as HTMLElement).closest?.('[data-radix-popper-content-wrapper]')) return;
      setActiveTable(null);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setActiveTable(null);
    };
    document.addEventListener('mousedown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [activeTable]);

  // If the captured table ever leaves the DOM (Delete table command),
  // drop the reference so the toolbar unmounts cleanly.
  React.useEffect(() => {
    if (!activeTable) return;
    if (!activeTable.isConnected) {
      setActiveTable(null);
    }
  });

  // For internal compatibility — older code used tableRef. Keep both
  // pointing to the same node.
  const tableRef = React.useRef<HTMLTableElement | null>(null);
  tableRef.current = activeTable;

  // Paint a class on the active <table> so the editor stylesheet can
  // outline it in primary. CellSelection doesn't get ProseMirror's
  // built-in .ProseMirror-selectednode class (that's NodeSelection
  // only), so we tag it ourselves while this toolbar is mounted.
  React.useLayoutEffect(() => {
    if (!activeTable) return;
    activeTable.classList.add('table-fully-selected');
    return () => activeTable.classList.remove('table-fully-selected');
  }, [activeTable]);

  // openMenu state still tracks which dropdown is open so we can avoid
  // double-render flicker on rapid toggles, but it no longer gates the
  // toolbar's mount — that's owned by activeTable now.
  const [openMenu, setOpenMenu] = React.useState<
    null | 'options' | 'valign' | 'layout' | 'overflow'
  >(null);

  if (!activeTable) return null;

  // Compute toolbar position relative to scrollContainer. Recomputes on
  // every render — the parent rerenders on editor selectionUpdate
  // (which includes resize/scroll updates) so this stays glued.
  let posLeft = 0;
  let posTop = 0;
  if (scrollContainer) {
    const tr = activeTable.getBoundingClientRect();
    const cr = scrollContainer.getBoundingClientRect();
    posLeft = tr.left - cr.left + scrollContainer.scrollLeft + tr.width / 2;
    posTop = tr.bottom - cr.top + scrollContainer.scrollTop + 8;
  }
  const currentLayout = (activeTable?.dataset.tableLayout as 'default' | 'wide' | 'full' | undefined) ?? 'default';
  const currentValign = (activeTable?.dataset.tableValign as 'top' | 'middle' | 'bottom' | undefined) ?? 'top';

  /** Restore the cursor inside the captured table so the ProseMirror
   *  table commands (toggleHeaderRow, addRowAfter, deleteTable…) have
   *  a context to operate on. Radix tore down the original CellSelection
   *  the instant the trigger took focus; we plant a TextSelection in
   *  the first cell before running the command. */
  const restoreCursorAndRun = (cmd: (chain: ReturnType<Editor['chain']>) => ReturnType<Editor['chain']>): void => {
    const t = tableRef.current;
    if (!t) return;
    const firstCell = t.querySelector<HTMLElement>('td, th');
    if (firstCell) {
      try {
        const pos = editor.view.posAtDOM(firstCell, 0);
        if (pos >= 0) {
          const $pos = editor.state.doc.resolve(pos);
          const sel = TextSelection.near($pos);
          editor.view.dispatch(editor.state.tr.setSelection(sel));
        }
      } catch {
        /* posAtDOM throws on detached nodes; fall through and let the
           command run with whatever selection happens to be live */
      }
    }
    cmd(editor.chain().focus()).run();
  };

  return (
    <div
      ref={toolbarDomRef}
      data-table-alignment-toolbar="true"
      className={cn(
        'pointer-events-auto absolute flex items-center gap-1 px-2 py-1',
        'bg-background border border-border shadow-sm',
      )}
      style={{
        // Sit just below the table, centred against its width so the
        // toolbar feels anchored to the selection rather than floating.
        left: `${posLeft}px`,
        top: `${posTop}px`,
        transform: 'translateX(-50%)',
        zIndex: 11,
      }}
      // Stop ProseMirror from clearing the table NodeSelection when the
      // toolbar itself is clicked. Without this, mousedown on the
      // toolbar would lose the selection and the toolbar would unmount
      // mid-click.
      onMouseDown={(e) => e.preventDefault()}
    >
      {/* Table options dropdown */}
      <DropdownMenu open={openMenu === 'options'} onOpenChange={(o) => setOpenMenu(o ? 'options' : null)}>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-2 gap-1.5 text-xs"
            data-testid="table-alignment-options-button"
          >
            <Sliders className="h-3.5 w-3.5" />
            <span>Table options</span>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent className="z-[10050] w-56" align="start">
          <DropdownMenuItem
            data-testid="table-alignment-toggle-header"
            onClick={() => restoreCursorAndRun((c) => c.toggleHeaderRow())}
          >
            Toggle header row
          </DropdownMenuItem>
          <DropdownMenuItem
            data-testid="table-alignment-distribute"
            onClick={() => {
              const table = tableRef.current;
              if (!table) return;
              // Clear per-column inline widths so the table-layout:fixed
              // algorithm redistributes the available width evenly.
              table.querySelectorAll<HTMLElement>('col').forEach((col) => {
                col.style.width = '';
              });
              table.querySelectorAll<HTMLElement>('td, th').forEach((cell) => {
                cell.style.width = '';
              });
            }}
          >
            Distribute columns evenly
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            data-testid="table-alignment-delete"
            className="text-destructive focus:text-destructive"
            onClick={() => restoreCursorAndRun((c) => c.deleteTable())}
          >
            <Trash2 className="h-3.5 w-3.5 mr-2" />
            Delete table
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {/* Vertical alignment */}
      <DropdownMenu open={openMenu === 'valign'} onOpenChange={(o) => setOpenMenu(o ? 'valign' : null)}>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 w-8 p-0"
            data-testid="table-alignment-valign-button"
            title="Vertical cell alignment"
          >
            {currentValign === 'bottom' ? (
              <AlignVerticalJustifyEnd className="h-3.5 w-3.5" />
            ) : currentValign === 'middle' ? (
              <AlignVerticalJustifyCenter className="h-3.5 w-3.5" />
            ) : (
              <AlignVerticalJustifyStart className="h-3.5 w-3.5" />
            )}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent className="z-[10050] w-44" align="start">
          <DropdownMenuItem
            data-testid="table-alignment-valign-top"
            onClick={() => activeTable && applyVerticalAlign(editor, activeTable,'top')}
          >
            <AlignVerticalJustifyStart className="h-3.5 w-3.5 mr-2" />
            Top
          </DropdownMenuItem>
          <DropdownMenuItem
            data-testid="table-alignment-valign-middle"
            onClick={() => activeTable && applyVerticalAlign(editor, activeTable,'middle')}
          >
            <AlignVerticalJustifyCenter className="h-3.5 w-3.5 mr-2" />
            Middle
          </DropdownMenuItem>
          <DropdownMenuItem
            data-testid="table-alignment-valign-bottom"
            onClick={() => activeTable && applyVerticalAlign(editor, activeTable,'bottom')}
          >
            <AlignVerticalJustifyEnd className="h-3.5 w-3.5 mr-2" />
            Bottom
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {/* Width / layout */}
      <DropdownMenu open={openMenu === 'layout'} onOpenChange={(o) => setOpenMenu(o ? 'layout' : null)}>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 w-8 p-0"
            data-testid="table-alignment-layout-button"
            title="Table width"
          >
            <Columns3 className="h-3.5 w-3.5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent className="z-[10050] w-44" align="start">
          <DropdownMenuItem
            data-testid="table-alignment-layout-default"
            className={cn(currentLayout === 'default' && 'bg-accent')}
            onClick={() => activeTable && applyLayout(editor, activeTable,'default')}
          >
            Default width
          </DropdownMenuItem>
          <DropdownMenuItem
            data-testid="table-alignment-layout-wide"
            className={cn(currentLayout === 'wide' && 'bg-accent')}
            onClick={() => activeTable && applyLayout(editor, activeTable,'wide')}
          >
            Wide
          </DropdownMenuItem>
          <DropdownMenuItem
            data-testid="table-alignment-layout-full"
            className={cn(currentLayout === 'full' && 'bg-accent')}
            onClick={() => activeTable && applyLayout(editor, activeTable,'full')}
          >
            Full width
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {/* Overflow — quick row / column add/delete reachable from the
          whole-table selection. The detailed per-row / per-column menu
          lives on the row/column chevrons in TableGripOverlay; this
          ⋯ button is the fast-path equivalent. */}
      <DropdownMenu open={openMenu === 'overflow'} onOpenChange={(o) => setOpenMenu(o ? 'overflow' : null)}>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 w-8 p-0"
            data-testid="table-alignment-overflow-button"
          >
            <MoreHorizontal className="h-3.5 w-3.5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent className="z-[10050] w-48" align="end">
          <DropdownMenuItem
            data-testid="table-alignment-add-row-after"
            onClick={() => restoreCursorAndRun((c) => c.addRowAfter())}
          >
            Insert row below
          </DropdownMenuItem>
          <DropdownMenuItem
            data-testid="table-alignment-add-column-after"
            onClick={() => restoreCursorAndRun((c) => c.addColumnAfter())}
          >
            Insert column right
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            data-testid="table-alignment-delete-row"
            onClick={() => restoreCursorAndRun((c) => c.deleteRow())}
          >
            Delete row
          </DropdownMenuItem>
          <DropdownMenuItem
            data-testid="table-alignment-delete-column"
            onClick={() => restoreCursorAndRun((c) => c.deleteColumn())}
          >
            Delete column
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
};

export default TableAlignmentToolbar;
