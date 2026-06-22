/**
 * Table Grip Overlay
 *
 * After the redesign, the only chrome rendered here is the 9-dot
 * table-level grip in the top-left corner — clicking it selects the
 * whole <table> as a NodeSelection. Per-row and per-column chevrons
 * were removed because every cell now carries its own in-cell ⋮ menu
 * trigger (see mobile-cell-menu-plugin.tsx) that exposes the same
 * actions without crowding the table edges.
 *
 * Desktop: faint by default, full opacity on hover.
 * Mobile: always 70% so it's findable on touch.
 */

import React, { useState } from 'react';
import { Editor } from '@tiptap/react';
import { Grip } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useIsMobile } from '@/hooks/use-mobile';
import { TableOverlayInfo } from '../hooks/use-table-grip-overlay';
import { selectTable } from './table-commands';
import { TableRightResizeHandle } from './table-right-resize-handle';
// TableAlignmentToolbar is mounted at the scroll-container level by
// CollaborativeNotesEditor — it needs to survive the overlay
// unmounting when the cursor leaves the table.

interface TableGripOverlayProps {
  editor: Editor;
  tableInfo: TableOverlayInfo;
}

export const TableGripOverlay: React.FC<TableGripOverlayProps> = ({
  editor,
  tableInfo,
}) => {
  const [hoveredGrip, setHoveredGrip] = useState<string | null>(null);
  const isMobile = useIsMobile();

  const gripSize = isMobile ? 24 : 20;
  const gripGap = 2;

  // Table-level grip — sits at the top-left corner where the row
  // gutter meets the column gutter. Click selects the whole <table>
  // as a NodeSelection so the user can copy / cut / delete or (once
  // block-level drag-and-drop lands) drag the entire table.
  const tableGripId = 'table-root';
  const isTableGripHovered = hoveredGrip === tableGripId;
  // Always render; tableInfo itself is what gates overlay visibility.
  // Keep the button faintly visible so users discover the affordance,
  // full opacity only on direct hover.
  const tableGripOpacityClass = isMobile
    ? 'opacity-70'
    : isTableGripHovered
      ? 'opacity-100'
      : 'opacity-40 hover:opacity-100';

  return (
    <>
      {/* Table-level grip — select the whole table block.
          Desktop: floats outside the table's top-left corner
          (left of the table, above its top edge). Mobile: tables
          almost fill the viewport width so the desktop position
          would push the grip off-screen — anchor it ABOVE the
          left corner instead (same top offset, left = tableLeft).
          Per user feedback "should sit a tiny bit above the
          table, left corner". */}
      <div
        data-table-grip="table"
        className="pointer-events-auto absolute"
        style={{
          left: `${isMobile ? tableInfo.tableLeft : tableInfo.tableLeft - gripSize - gripGap}px`,
          top: `${tableInfo.tableTop - gripSize - gripGap}px`,
          width: `${gripSize}px`,
          height: `${gripSize}px`,
        }}
        onMouseEnter={() => setHoveredGrip(tableGripId)}
        onMouseLeave={() => setHoveredGrip(null)}
      >
        <button
          onMouseDown={(e) => {
            e.preventDefault();
            e.stopPropagation();
            selectTable(editor);
          }}
          className={cn(
            'absolute inset-0 flex items-center justify-center transition-opacity duration-150',
            'bg-muted border border-border',
            tableGripOpacityClass,
          )}
          type="button"
          title="Select table"
        >
          <Grip className="h-3 w-3 text-muted-foreground" />
        </button>
      </div>

      {/* Right-side vertical resize bar — drags the whole table's
          width. Confluence places this on the right edge of the
          table; we mirror that placement using tableInfo. */}
      <TableRightResizeHandle editor={editor} tableInfo={tableInfo} />
    </>
  );
};
