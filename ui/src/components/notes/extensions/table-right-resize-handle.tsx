/**
 * TableRightResizeHandle
 *
 * Confluence-style vertical drag bar on the right edge of the active
 * table. Dragging it left/right resizes the whole table inline so the
 * writer can pick a custom width between the Default / Wide / Full
 * presets in TableAlignmentToolbar.
 *
 * Implementation choices:
 *   - Width is set as an inline `width: Npx` on the <table> element so
 *     the change survives a re-render (TipTap doesn't track this).
 *   - We measure off `tableInfo` (parent provides container-relative
 *     coords) so positioning matches every other grip in the overlay.
 *   - Mouse-only — touch is left out for now; mobile users should use
 *     the layout dropdown in TableAlignmentToolbar.
 */

import * as React from 'react';
import { Editor } from '@tiptap/react';
import { cn } from '@/lib/utils';
import type { TableOverlayInfo } from '../hooks/use-table-grip-overlay';

export interface TableRightResizeHandleProps {
  editor: Editor;
  tableInfo: TableOverlayInfo;
}

function findActiveTableDOM(editor: Editor): HTMLTableElement | null {
  // Prefer the table the selection lives in; fall back to the first
  // table inside the editor view if the selection is detached.
  try {
    const { $anchor } = editor.state.selection;
    const domNode = editor.view.domAtPos($anchor.pos);
    const el = domNode.node instanceof HTMLElement
      ? domNode.node
      : domNode.node.parentElement;
    const closest = el?.closest('table');
    if (closest) return closest as HTMLTableElement;
  } catch {
    /* domAtPos can throw on stale selections; fall through */
  }
  const editorEl = editor.view.dom as HTMLElement;
  return editorEl.querySelector('table') as HTMLTableElement | null;
}

export const TableRightResizeHandle: React.FC<TableRightResizeHandleProps> = ({ editor, tableInfo }) => {
  const [dragging, setDragging] = React.useState(false);
  const dragStateRef = React.useRef<{
    startX: number;
    startWidth: number;
    table: HTMLTableElement;
  } | null>(null);

  const handleMouseDown = React.useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const table = findActiveTableDOM(editor);
      if (!table) return;
      dragStateRef.current = {
        startX: e.clientX,
        startWidth: table.getBoundingClientRect().width,
        table,
      };
      setDragging(true);

      const onMove = (ev: MouseEvent) => {
        const s = dragStateRef.current;
        if (!s) return;
        const delta = ev.clientX - s.startX;
        // Floor at 200 px so the table never collapses to unreadable.
        const next = Math.max(200, s.startWidth + delta);
        // editor-theme.css forces `width: 100% !important` on tables,
        // so plain inline width is silently dropped on cascade.
        // setProperty(...,'important') lets the inline rule win.
        s.table.style.setProperty('width', `${next}px`, 'important');
      };
      const onUp = () => {
        const s = dragStateRef.current;
        if (s) {
          // Commit the final width to the ProseMirror node attribute
          // so the value survives the editor's next re-render (Y.js
          // sync, autosave, etc.). Without this, inline style alone
          // is wiped the moment TipTap re-mounts the <table>.
          const finalWidth = s.table.style.width;
          if (finalWidth) {
            try {
              const pos = editor.view.posAtDOM(s.table, 0);
              if (pos >= 0) {
                const $pos = editor.state.doc.resolve(pos);
                // Walk up to the parent table node — posAtDOM on the
                // <table> tag itself returns a position INSIDE the
                // table (cell or row); .before(depth) backs out to
                // the table node start.
                for (let d = $pos.depth; d >= 0; d--) {
                  if ($pos.node(d).type.name === 'table') {
                    const tablePos = $pos.before(d);
                    const node = editor.state.doc.nodeAt(tablePos);
                    if (node) {
                      editor.view.dispatch(
                        editor.state.tr.setNodeMarkup(tablePos, undefined, {
                          ...node.attrs,
                          width: finalWidth,
                        }),
                      );
                    }
                    break;
                  }
                }
              }
            } catch (err) {
              console.warn('[TableRightResizeHandle] failed to commit width attr', err);
            }
          }
        }
        dragStateRef.current = null;
        setDragging(false);
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
      };
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
    },
    [editor],
  );

  // Centre the bar vertically against the table; height matches the
  // table's height so the drag area is easy to grab without having to
  // hunt for a thin sliver.
  const BAR_WIDTH = 6;
  const GUTTER = 4;
  const HANDLE_WIDTH = BAR_WIDTH + 8;
  // Glue the handle to the table's right edge but never let it land
  // outside the visible page wrapper — when the table is wider than
  // the wrapper (overflow / wide layout) the handle would otherwise
  // be off-screen and unreachable.
  const desiredLeft = tableInfo.tableLeft + tableInfo.tableWidth + GUTTER;
  const maxLeft = Math.max(0, tableInfo.containerWidth - HANDLE_WIDTH - GUTTER);
  const clampedLeft = Math.min(desiredLeft, maxLeft);
  return (
    <div
      data-table-grip="right-resize"
      role="separator"
      aria-orientation="vertical"
      title="Drag to resize table"
      onMouseDown={handleMouseDown}
      className={cn(
        'pointer-events-auto absolute cursor-col-resize',
        'flex items-center justify-center',
        'transition-opacity duration-150',
        dragging ? 'opacity-100' : 'opacity-40 hover:opacity-100',
      )}
      style={{
        left: `${clampedLeft}px`,
        top: `${tableInfo.tableTop}px`,
        height: `${tableInfo.tableHeight}px`,
        width: `${HANDLE_WIDTH}px`,
      }}
    >
      <span
        aria-hidden
        className="bg-muted-foreground/60 hover:bg-primary rounded-full"
        style={{
          width: '3px',
          height: '36px',
        }}
      />
    </div>
  );
};

export default TableRightResizeHandle;
