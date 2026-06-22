/**
 * 7.6 — Active block decoration.
 *
 * ProseMirror plugin that adds the CSS class `is-active-block` to the
 * top-level node whose range contains the current selection's caret.
 * Focus mode (`body.notes-focus-mode` in notes-drawer.css) dims every
 * other top-level child of the editor while leaving the active one at
 * full opacity, so the writer can concentrate on a single paragraph
 * or heading without losing the rest of the doc visually.
 *
 * Designed to be cheap: only re-renders the decoration set when the
 * selection actually moves to a different top-level node (compares
 * the resolved offset of `selection.$head.before(1)`).
 */
import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';

const pluginKey = new PluginKey('activeBlockDecoration');

export const ActiveBlockDecoration = Extension.create({
  name: 'activeBlockDecoration',

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: pluginKey,
        state: {
          init(_, state): DecorationSet {
            return computeDecorations(state.doc, getActiveTopLevelOffset(state));
          },
          apply(tr, oldSet, _oldState, newState): DecorationSet {
            // Recompute on selection or doc change; otherwise reuse
            // the existing set (mapping it across the transaction so
            // the decoration position stays valid).
            if (!tr.docChanged && !tr.selectionSet) return oldSet.map(tr.mapping, tr.doc);
            return computeDecorations(newState.doc, getActiveTopLevelOffset(newState));
          },
        },
        props: {
          decorations(state) {
            return pluginKey.getState(state) as DecorationSet | undefined;
          },
        },
      }),
    ];
  },
});

/** Offset of the top-level node that contains the current selection's
 *  head, or null if the doc is empty / something is off. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- ProseMirror EditorState type isn't trivially named here
function getActiveTopLevelOffset(state: any): number | null {
  const sel = state.selection;
  if (!sel) return null;
  // depth 0 is the doc itself; depth 1 is the top-level child the caret
  // sits inside. `.before(1)` gives the position right before that child.
  if (sel.$head.depth < 1) return null;
  return sel.$head.before(1);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- ProseMirror Node type
function computeDecorations(doc: any, activeOffset: number | null): DecorationSet {
  if (activeOffset == null) return DecorationSet.empty;
  const decorations: Decoration[] = [];
  doc.forEach((node: { nodeSize: number }, offset: number) => {
    const from = offset;
    const to = offset + node.nodeSize;
    if (from === activeOffset) {
      decorations.push(Decoration.node(from, to, { class: 'is-active-block' }));
    }
  });
  return DecorationSet.create(doc, decorations);
}
