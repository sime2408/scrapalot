/**
 * Custom table commands for Confluence-style table controls.
 * Provides move row/column, clear cells, set background, and select row/column.
 *
 * IMPORTANT: These commands find the table by scanning the document (not relying
 * on current selection) because grip handles are outside the editor DOM.
 */

import { Editor } from '@tiptap/react';
import { CellSelection, TableMap } from 'prosemirror-tables';
import { Node as PmNode } from '@tiptap/pm/model';

/** True only when the entire table is selected (via the 6-dot grip's
 *  CellSelection that covers every cell). Used by TableAlignmentToolbar
 *  to decide whether to render, and by SelectionToolbar's mount guard
 *  so the two toolbars never stack. */
export function isWholeTableSelected(editor: Editor): boolean {
  const sel = editor.state.selection;
  if (!(sel instanceof CellSelection)) return false;
  return sel.isRowSelection() && sel.isColSelection();
}

/** Find the FIRST table in the document (for now we support single-table grip) */
export function findFirstTable(editor: Editor): { node: PmNode; pos: number; start: number } | null {
  let result: { node: PmNode; pos: number; start: number } | null = null;
  editor.state.doc.descendants((node, pos) => {
    if (result) return false; // stop after first
    if (node.type.name === 'table') {
      result = { node, pos, start: pos + 1 };
      return false;
    }
    return true;
  });
  return result;
}

/** Find the table containing the current selection (fallback to first table) */
export function findTable(editor: Editor): { node: PmNode; pos: number; start: number } | null {
  const { $anchor } = editor.state.selection;
  for (let depth = $anchor.depth; depth > 0; depth--) {
    const node = $anchor.node(depth);
    if (node.type.name === 'table') {
      return { node, pos: $anchor.before(depth), start: $anchor.start(depth) };
    }
  }
  // Fallback: find first table in document
  return findFirstTable(editor);
}

/** Focus a specific cell so row/column commands target the right row/column */
export function focusCell(editor: Editor, rowIndex: number, colIndex: number): boolean {
  const table = findFirstTable(editor);
  if (!table) return false;

  const map = TableMap.get(table.node);
  if (rowIndex < 0 || rowIndex >= map.height || colIndex < 0 || colIndex >= map.width) return false;

  const cellPos = table.start + map.map[rowIndex * map.width + colIndex];
  editor.chain().focus().setTextSelection(cellPos + 1).run();
  return true;
}

/** Select an entire row by its index */
export function selectRow(editor: Editor, rowIndex: number): boolean {
  // First focus a cell in that row so the table is "active"
  if (!focusCell(editor, rowIndex, 0)) return false;

  const table = findTable(editor);
  if (!table) return false;

  const map = TableMap.get(table.node);
  if (rowIndex < 0 || rowIndex >= map.height) return false;

  const anchorCellPos = table.start + map.map[rowIndex * map.width];
  const headCellPos = table.start + map.map[rowIndex * map.width + map.width - 1];

  const $anchor = editor.state.doc.resolve(anchorCellPos);
  const $head = editor.state.doc.resolve(headCellPos);
  const selection = CellSelection.rowSelection($anchor, $head);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- CellSelection extends Selection but ProseMirror types don't reflect that
  editor.view.dispatch(editor.state.tr.setSelection(selection as any));
  return true;
}

/** Select the entire table as a NodeSelection (the whole table block). */
export function selectTable(editor: Editor): boolean {
  const table = findFirstTable(editor);
  if (!table) return false;
  // ProseMirror-tables converts NodeSelection on a `table` node into a
  // CellSelection automatically — using setNodeSelection here would
  // yield a partial cellSelection instead of "every cell". Pick the
  // top-left and bottom-right cell explicitly and build a CellSelection
  // that covers the whole grid; isRowSelection() && isColSelection() on
  // the result is the canonical "whole table is selected" signal.
  const map = TableMap.get(table.node);
  const firstCellPos = table.start + map.map[0];
  const lastCellPos = table.start + map.map[map.map.length - 1];
  const $anchor = editor.state.doc.resolve(firstCellPos);
  const $head = editor.state.doc.resolve(lastCellPos);
  const cellSel = CellSelection.create(editor.state.doc, $anchor.pos, $head.pos);
  const tr = editor.state.tr.setSelection(cellSel);
  editor.view.dispatch(tr);
  editor.view.focus();
  return true;
}

/** Select an entire column by its index */
export function selectColumn(editor: Editor, colIndex: number): boolean {
  if (!focusCell(editor, 0, colIndex)) return false;

  const table = findTable(editor);
  if (!table) return false;

  const map = TableMap.get(table.node);
  if (colIndex < 0 || colIndex >= map.width) return false;

  const anchorCellPos = table.start + map.map[colIndex];
  const headCellPos = table.start + map.map[(map.height - 1) * map.width + colIndex];

  const $anchor = editor.state.doc.resolve(anchorCellPos);
  const $head = editor.state.doc.resolve(headCellPos);
  const selection = CellSelection.colSelection($anchor, $head);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- CellSelection extends Selection but ProseMirror types don't reflect that
  editor.view.dispatch(editor.state.tr.setSelection(selection as any));
  return true;
}

/** Clear all cells in a row */
export function clearRowCells(editor: Editor, rowIndex: number): boolean {
  if (!focusCell(editor, rowIndex, 0)) return false;
  const table = findTable(editor);
  if (!table) return false;

  const map = TableMap.get(table.node);
  if (rowIndex < 0 || rowIndex >= map.height) return false;

  const { tr } = editor.state;
  const emptyParagraph = editor.state.schema.nodes.paragraph.create();

  for (let col = map.width - 1; col >= 0; col--) {
    const cellPos = table.start + map.map[rowIndex * map.width + col];
    const cell = editor.state.doc.nodeAt(cellPos);
    if (cell) {
      tr.replaceWith(cellPos + 1, cellPos + cell.content.size + 1, emptyParagraph);
    }
  }
  editor.view.dispatch(tr);
  return true;
}

/** Clear all cells in a column */
export function clearColumnCells(editor: Editor, colIndex: number): boolean {
  if (!focusCell(editor, 0, colIndex)) return false;
  const table = findTable(editor);
  if (!table) return false;

  const map = TableMap.get(table.node);
  if (colIndex < 0 || colIndex >= map.width) return false;

  const { tr } = editor.state;
  const emptyParagraph = editor.state.schema.nodes.paragraph.create();

  for (let row = map.height - 1; row >= 0; row--) {
    const cellPos = table.start + map.map[row * map.width + colIndex];
    const cell = editor.state.doc.nodeAt(cellPos);
    if (cell) {
      tr.replaceWith(cellPos + 1, cellPos + cell.content.size + 1, emptyParagraph);
    }
  }
  editor.view.dispatch(tr);
  return true;
}

/** Set background color on all cells in a row */
export function setRowBackground(editor: Editor, rowIndex: number, color: string | null): boolean {
  if (!focusCell(editor, rowIndex, 0)) return false;
  const table = findTable(editor);
  if (!table) return false;

  const map = TableMap.get(table.node);
  if (rowIndex < 0 || rowIndex >= map.height) return false;

  const { tr } = editor.state;
  for (let col = 0; col < map.width; col++) {
    const cellPos = table.start + map.map[rowIndex * map.width + col];
    const cell = editor.state.doc.nodeAt(cellPos);
    if (cell) {
      tr.setNodeMarkup(cellPos, undefined, { ...cell.attrs, background: color });
    }
  }
  editor.view.dispatch(tr);
  return true;
}

/** Set background color on all cells in a column */
export function setColumnBackground(editor: Editor, colIndex: number, color: string | null): boolean {
  if (!focusCell(editor, 0, colIndex)) return false;
  const table = findTable(editor);
  if (!table) return false;

  const map = TableMap.get(table.node);
  if (colIndex < 0 || colIndex >= map.width) return false;

  const { tr } = editor.state;
  for (let row = 0; row < map.height; row++) {
    const cellPos = table.start + map.map[row * map.width + colIndex];
    const cell = editor.state.doc.nodeAt(cellPos);
    if (cell) {
      tr.setNodeMarkup(cellPos, undefined, { ...cell.attrs, background: color });
    }
  }
  editor.view.dispatch(tr);
  return true;
}

/** Move a row up (swap with previous row) */
export function moveRowUp(editor: Editor, rowIndex: number): boolean {
  if (rowIndex <= 0) return false;
  return swapRows(editor, rowIndex, rowIndex - 1);
}

/** Move a row down (swap with next row) */
export function moveRowDown(editor: Editor, rowIndex: number): boolean {
  if (!focusCell(editor, rowIndex, 0)) return false;
  const table = findTable(editor);
  if (!table) return false;
  const map = TableMap.get(table.node);
  if (rowIndex >= map.height - 1) return false;
  return swapRows(editor, rowIndex, rowIndex + 1);
}

function swapRows(editor: Editor, rowA: number, rowB: number): boolean {
  if (!focusCell(editor, rowA, 0)) return false;
  const table = findTable(editor);
  if (!table) return false;

  let rowNodeA: PmNode | null = null;
  let rowNodeB: PmNode | null = null;
  let rowPosA = 0;
  let rowPosB = 0;

  let idx = 0;
  table.node.forEach((row, offset) => {
    if (idx === rowA) { rowNodeA = row; rowPosA = table.start + offset; }
    if (idx === rowB) { rowNodeB = row; rowPosB = table.start + offset; }
    idx++;
  });

  if (!rowNodeA || !rowNodeB) return false;

  const { tr } = editor.state;
  const [firstPos, firstNode, secondPos, secondNode] =
    rowPosA < rowPosB
      ? [rowPosA, rowNodeA, rowPosB, rowNodeB]
      : [rowPosB, rowNodeB, rowPosA, rowNodeA];

  tr.replaceWith(secondPos, secondPos + (secondNode as PmNode).nodeSize, firstNode as PmNode);
  tr.replaceWith(firstPos, firstPos + (firstNode as PmNode).nodeSize, secondNode as PmNode);

  editor.view.dispatch(tr);
  return true;
}

/** Move a column left (swap with previous column) */
export function moveColumnLeft(editor: Editor, colIndex: number): boolean {
  if (colIndex <= 0) return false;
  return swapColumns(editor, colIndex, colIndex - 1);
}

/** Move a column right (swap with next column) */
export function moveColumnRight(editor: Editor, colIndex: number): boolean {
  if (!focusCell(editor, 0, colIndex)) return false;
  const table = findTable(editor);
  if (!table) return false;
  const map = TableMap.get(table.node);
  if (colIndex >= map.width - 1) return false;
  return swapColumns(editor, colIndex, colIndex + 1);
}

/** Swap two columns cell-by-cell (no native prosemirror-tables primitive). */
function swapColumns(editor: Editor, colA: number, colB: number): boolean {
  if (!focusCell(editor, 0, colA)) return false;
  const table = findTable(editor);
  if (!table) return false;

  const map = TableMap.get(table.node);
  if (colA < 0 || colB < 0 || colA >= map.width || colB >= map.width) return false;

  const { tr } = editor.state;
  // Walk bottom → top so later replacements don't shift earlier positions.
  for (let row = map.height - 1; row >= 0; row--) {
    const posA = table.start + map.map[row * map.width + colA];
    const posB = table.start + map.map[row * map.width + colB];
    const cellA = editor.state.doc.nodeAt(posA);
    const cellB = editor.state.doc.nodeAt(posB);
    if (!cellA || !cellB) continue;
    const [firstPos, firstCell, secondPos, secondCell] =
      posA < posB
        ? [posA, cellA, posB, cellB]
        : [posB, cellB, posA, cellA];
    tr.replaceWith(secondPos, secondPos + secondCell.nodeSize, firstCell);
    tr.replaceWith(firstPos, firstPos + firstCell.nodeSize, secondCell);
  }
  editor.view.dispatch(tr);
  return true;
}

/** Background color palette */
export const TABLE_CELL_COLORS = [
  { label: 'None', value: null },
  { label: 'Light blue', value: '#dbeafe' },
  { label: 'Light green', value: '#dcfce7' },
  { label: 'Light yellow', value: '#fef9c3' },
  { label: 'Light purple', value: '#f3e8ff' },
  { label: 'Light red', value: '#fee2e2' },
  { label: 'Light gray', value: '#f3f4f6' },
  { label: 'Blue', value: '#93c5fd' },
  { label: 'Green', value: '#86efac' },
  { label: 'Yellow', value: '#fde047' },
  { label: 'Purple', value: '#c4b5fd' },
  { label: 'Red', value: '#fca5a5' },
];
