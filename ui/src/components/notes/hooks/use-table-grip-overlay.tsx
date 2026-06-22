/**
 * Hook to track table row/column positions for Confluence-style grip handles.
 * Shows grips only when cursor is inside a table or mouse hovers over it.
 */

import React, { useEffect, useState, useCallback, useRef, RefObject } from 'react';
import { Editor } from '@tiptap/react';

export interface RowGripInfo {
  rowIndex: number;
  top: number;
  height: number;
  left: number;
}

export interface ColGripInfo {
  colIndex: number;
  left: number;
  width: number;
  top: number;
}

export interface TableOverlayInfo {
  tableTop: number;
  tableLeft: number;
  tableWidth: number;
  tableHeight: number;
  /** Width of the containing layer (page wrapper) — used by the
   *  right-edge resize handle to clamp its X so the handle never lands
   *  outside the visible scroll area when the table is wider than the
   *  page. */
  containerWidth: number;
  rows: RowGripInfo[];
  columns: ColGripInfo[];
}

export const useTableGripOverlay = (
  editor: Editor | null,
  editable: boolean,
  containerRef?: RefObject<HTMLDivElement | null>
) => {
  const [tableInfo, setTableInfo] = useState<TableOverlayInfo | null>(null);
  const hoveredTableRef = useRef<HTMLTableElement | null>(null);
  const rafRef = useRef<number | null>(null);
  const throttleRef = useRef<number>(0);
  // Debounce the "clear tableInfo" side effect so the cursor has
  // time to travel across the gap between the table and any grip
  // handle (row / column / whole-table) without the overlay
  // vanishing mid-transit.
  const clearTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const cancelClear = useCallback(() => {
    if (clearTimerRef.current) {
      clearTimeout(clearTimerRef.current);
      clearTimerRef.current = null;
    }
  }, []);

  const scheduleClear = useCallback(() => {
    cancelClear();
    clearTimerRef.current = setTimeout(() => {
      hoveredTableRef.current = null;
      setTableInfo(null);
      clearTimerRef.current = null;
    }, 250);
  }, [cancelClear]);

  const computePositions = useCallback((activeTable: HTMLTableElement) => {
    if (!containerRef?.current) return;
    const containerRect = containerRef.current.getBoundingClientRect();
    const tableRect = activeTable.getBoundingClientRect();
    const rows: RowGripInfo[] = [];
    const columns: ColGripInfo[] = [];

    const trElements = activeTable.querySelectorAll(':scope > thead > tr, :scope > tbody > tr, :scope > tr');
    trElements.forEach((tr, rowIndex) => {
      const trRect = tr.getBoundingClientRect();
      rows.push({
        rowIndex,
        top: trRect.top - containerRect.top,
        height: trRect.height,
        left: tableRect.left - containerRect.left,
      });
    });

    const firstRow = trElements[0];
    if (firstRow) {
      const cells = firstRow.querySelectorAll(':scope > td, :scope > th');
      cells.forEach((cell, colIndex) => {
        const cellRect = cell.getBoundingClientRect();
        columns.push({
          colIndex,
          left: cellRect.left - containerRect.left,
          width: cellRect.width,
          top: tableRect.top - containerRect.top,
        });
      });
    }

    setTableInfo({
      tableTop: tableRect.top - containerRect.top,
      tableLeft: tableRect.left - containerRect.left,
      tableWidth: tableRect.width,
      tableHeight: tableRect.height,
      containerWidth: containerRect.width,
      rows,
      columns,
    });
  }, [containerRef]);

  const updateTablePositions = useCallback(() => {
    if (!editor || !editable) {
      setTableInfo(null);
      return;
    }

    const now = Date.now();
    if (now - throttleRef.current < 80) return;
    throttleRef.current = now;

    let activeTable: HTMLTableElement | null = null;

    // Priority 1: cursor is inside a table
    if (editor.isActive('table')) {
      try {
        const { $anchor } = editor.state.selection;
        const domNode = editor.view.domAtPos($anchor.pos);
        const el = domNode.node instanceof HTMLElement ? domNode.node : domNode.node.parentElement;
        activeTable = el?.closest('table') as HTMLTableElement | null;
      } catch {
        // domAtPos can throw if pos is invalid
      }
    }

    // Priority 2: mouse is hovering over a table
    if (!activeTable && hoveredTableRef.current) {
      activeTable = hoveredTableRef.current;
    }

    if (!activeTable) {
      setTableInfo(null);
      return;
    }

    computePositions(activeTable);
  }, [editor, editable, computePositions]);

  useEffect(() => {
    if (!editor || !editable) {
      setTableInfo(null);
      return;
    }

    const scheduleUpdate = () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      rafRef.current = requestAnimationFrame(updateTablePositions);
    };

    const initialTimeout = setTimeout(updateTablePositions, 300);

    editor.on('update', scheduleUpdate);
    editor.on('selectionUpdate', scheduleUpdate);
    window.addEventListener('resize', scheduleUpdate);
    window.addEventListener('scroll', scheduleUpdate, true);

    return () => {
      clearTimeout(initialTimeout);
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      if (clearTimerRef.current) clearTimeout(clearTimerRef.current);
      editor.off('update', scheduleUpdate);
      editor.off('selectionUpdate', scheduleUpdate);
      window.removeEventListener('resize', scheduleUpdate);
      window.removeEventListener('scroll', scheduleUpdate, true);
    };
  }, [editor, editable, updateTablePositions]);

  /** Call from parent's onMouseMove to detect table hover */
  const handleTableMouseMove = useCallback((e: React.MouseEvent) => {
    const target = e.target as HTMLElement;
    const table = target.closest('table') as HTMLTableElement | null;
    // Keep the overlay alive while the cursor is over a grip handle
    // or the chevron popover — otherwise the transition from a cell
    // to the grip (or from the chevron to the popover, which both
    // live OUTSIDE the <table> in DOM) would clear tableInfo and the
    // UI would vanish before the click landed.
    const overGrip = target.closest('[data-table-grip]');
    const menuOpen = typeof document !== 'undefined'
      && !!document.querySelector('[data-table-grip-menu="true"]');

    // Cursor landed back on a table or on a grip / menu — cancel any
    // pending clear so the overlay survives the round-trip.
    if (table || overGrip || menuOpen) {
      cancelClear();
      if (table && table !== hoveredTableRef.current && containerRef?.current) {
        hoveredTableRef.current = table;
        computePositions(table);
      }
      return;
    }

    // Not on table / grip / menu. Only schedule a clear if the editor
    // isn't still active inside a table. Debounced so a 200-ish ms
    // traverse across the gap between table and grip doesn't kill
    // the overlay.
    if (!editor?.isActive('table')) {
      scheduleClear();
    }
  }, [editor, containerRef, computePositions, cancelClear, scheduleClear]);

  return { tableInfo, handleTableMouseMove };
};
