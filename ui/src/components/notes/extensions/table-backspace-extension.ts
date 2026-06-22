/**
 * Table Backspace Extension
 *
 * Tables are atomic ProseMirror nodes. The default "merge with previous
 * block" path no-ops on them, so holding Backspace dies the moment the
 * cursor reaches a position adjacent to a table. Without this extension
 * the only way to remove a table is the explicit "Delete table" menu
 * item, which is awkward on mobile.
 *
 * Behaviour (mirrors Notion):
 *   1. Cursor at start of a NON-empty paragraph immediately after a
 *      table → move caret into the table's last cell so the user can
 *      keep editing inside.
 *   2. Cursor in an EMPTY paragraph immediately after a table OR cursor
 *      in the last cell of a table whose entire content is empty →
 *      delete the table outright.
 *
 * Mobile keyboards (Android, iOS) frequently do NOT emit DOM `keydown`
 * events for Backspace — they fire `beforeinput` with
 * `inputType: 'deleteContentBackward'` instead. We register BOTH paths
 * so the extension fires regardless of input source.
 */

import { Extension } from '@tiptap/core';
import { Plugin, PluginKey, TextSelection } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';
import type { Node as PMNode, ResolvedPos } from '@tiptap/pm/model';

/**
 * Walk up from a resolved position looking for the wrapping `table`
 * node and return both the node and its absolute position. Returns
 * null when the position is not inside a table.
 */
function findEnclosingTable(
  $pos: ResolvedPos,
): { node: PMNode; pos: number } | null {
  for (let d = $pos.depth; d > 0; d--) {
    const node = $pos.node(d);
    if (node.type.name === 'table') {
      return { node, pos: $pos.before(d) };
    }
  }
  return null;
}

/** A table is "empty" when every cell's textContent trims to ''. */
function isTableEmpty(table: PMNode): boolean {
  let empty = true;
  table.descendants((descendant) => {
    if (!empty) return false;
    if (descendant.isText && descendant.text && descendant.text.trim() !== '') {
      empty = false;
      return false;
    }
    return true;
  });
  return empty;
}

/**
 * Core handler. Returns true when it consumed the backspace, false
 * to let ProseMirror's default chain run.
 */
function handleBackspace(view: EditorView): boolean {
  const { state, dispatch } = view;
  const { selection, doc } = state;

  // Only act when the cursor is collapsed.
  if (!selection.empty) return false;

  const $from = selection.$from;

  /* ------------------------------------------------------------------ */
  /* Case A — caret inside a table cell                                  */
  /* ------------------------------------------------------------------ */
  const enclosing = findEnclosingTable($from);
  if (enclosing) {
    const cellEmpty = $from.parent.textContent.trim() === '';
    if (cellEmpty && isTableEmpty(enclosing.node)) {
      const tr = state.tr.delete(
        enclosing.pos,
        enclosing.pos + enclosing.node.nodeSize,
      );
      const after = tr.doc.resolve(Math.min(enclosing.pos, tr.doc.content.size));
      tr.setSelection(TextSelection.near(after, -1));
      dispatch(tr.scrollIntoView());
      return true;
    }
    return false;
  }

  /* ------------------------------------------------------------------ */
  /* Case B — caret at start of a textblock immediately after a table    */
  /* ------------------------------------------------------------------ */
  if ($from.parentOffset !== 0) return false;
  if ($from.depth === 0) return false;

  const beforePos = $from.before();
  if (beforePos <= 0) return false;

  const $before = doc.resolve(beforePos);
  const prevNode = $before.nodeBefore;
  if (!prevNode || prevNode.type.name !== 'table') return false;

  const tablePos = beforePos - prevNode.nodeSize;
  const paragraphIsEmpty = $from.parent.textContent.trim() === '';

  if (paragraphIsEmpty) {
    // Delete the table AND collapse the trailing empty paragraph onto
    // the slot it used to live in. Caret lands at the join.
    const tr = state.tr.delete(tablePos, beforePos);
    const newPos = Math.min(tablePos, tr.doc.content.size);
    tr.setSelection(TextSelection.near(tr.doc.resolve(newPos), -1));
    dispatch(tr.scrollIntoView());
    return true;
  }

  // Paragraph has text → don't lose it; move caret into the table's
  // last cell instead so the user can keep editing inside.
  const insideTableEnd = beforePos - 1;
  const tr = state.tr.setSelection(
    TextSelection.near(doc.resolve(insideTableEnd), -1),
  );
  dispatch(tr.scrollIntoView());
  return true;
}

export const TableBackspace = Extension.create({
  name: 'tableBackspace',

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey('tableBackspace'),
        props: {
          handleKeyDown(view, event) {
            if (event.key !== 'Backspace') return false;
            return handleBackspace(view);
          },
          handleDOMEvents: {
            // Android / iOS soft keyboards send InputEvent instead of
            // KeyboardEvent for Backspace. Intercept the corresponding
            // beforeinput so the extension fires on mobile too.
            beforeinput(view, event) {
              const ie = event as InputEvent;
              if (ie.inputType !== 'deleteContentBackward') return false;
              if (handleBackspace(view)) {
                ie.preventDefault();
                return true;
              }
              return false;
            },
          },
        },
      }),
    ];
  },
});

export default TableBackspace;
