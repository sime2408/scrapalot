/**
 * Custom Drag Handle Plugin for Notion-like block menu
 * Shows 6-dot handle on hover that opens block menu on click
 */

import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { Node as PMNode } from '@tiptap/pm/model';

export interface DragHandlePluginOptions {
  /**
   * The class to add to the drag handle element
   */
  dragHandleClass?: string;
}

export const DragHandlePlugin = Extension.create<DragHandlePluginOptions>({
  name: 'dragHandlePlugin',

  addOptions() {
    return {
      dragHandleClass: 'drag-handle-wrapper',
    };
  },

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey('dragHandle'),
        props: {
          decorations(state) {
            const decorations: Decoration[] = [];
            const { doc } = state;

            doc.descendants((node: PMNode, pos: number) => {
              // Confluence-style: every top-level block gets the
              // [ + ⋮⋮ ] gutter — including paragraphs. The CSS
              // visibility rule still keeps them hidden until either
              // the block is hovered, contains the active cursor, or
              // the user has selected text inside it (`is-active-block`
              // from active-block-decoration.ts). Table / list cells
              // are excluded because they have their own selection
              // affordances.
              const $pos = doc.resolve(pos);
              const isTopLevel = $pos.depth === 0;
              if (
                isTopLevel &&
                node.isBlock &&
                node.type.name !== 'doc'
              ) {
                decorations.push(
                  // pos + 1 places the widget INSIDE the block at
                  // its first content offset, so the rendered
                  // .drag-handle-trigger DIV becomes a direct child
                  // of the block. CSS selectors like
                  // `.is-active-block > .drag-handle-trigger` or
                  // `.ProseMirror > h1:hover .drag-handle-trigger`
                  // only match when the handle is INSIDE the block —
                  // emitting at `pos` (sibling) silently broke every
                  // visibility rule.
                  Decoration.widget(pos + 1, () => {
                    const handle = document.createElement('div');
                    handle.className = 'drag-handle-trigger';
                    handle.contentEditable = 'false';

                    // Two stacked buttons: + (insert below) and ⋮⋮
                    // (six-dot drag / block menu). Both share the
                    // same hover container so they fade in together.
                    handle.innerHTML = `
                      <button
                        class="block-plus-button"
                        data-block-plus
                        aria-label="Insert block below"
                        type="button"
                      >
                        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                          <line x1="12" y1="5" x2="12" y2="19" />
                          <line x1="5" y1="12" x2="19" y2="12" />
                        </svg>
                      </button>
                      <button
                        class="drag-handle-button"
                        data-drag-handle
                        aria-label="Drag to reorder or click for options"
                        draggable="true"
                      >
                        <svg
                          xmlns="http://www.w3.org/2000/svg"
                          width="16"
                          height="16"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          stroke-width="2"
                          stroke-linecap="round"
                          stroke-linejoin="round"
                        >
                          <circle cx="9" cy="5" r="1"/>
                          <circle cx="9" cy="12" r="1"/>
                          <circle cx="9" cy="19" r="1"/>
                          <circle cx="15" cy="5" r="1"/>
                          <circle cx="15" cy="12" r="1"/>
                          <circle cx="15" cy="19" r="1"/>
                        </svg>
                      </button>
                    `;

                    return handle;
                  }, {
                    side: -1,
                    key: `drag-handle-${pos}`,
                  })
                );
              }

              return true;
            });

            return DecorationSet.create(doc, decorations);
          },
        },
      }),
    ];
  },
});
