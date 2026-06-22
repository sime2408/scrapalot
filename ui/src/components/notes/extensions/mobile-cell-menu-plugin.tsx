/**
 * MobileCellMenuPlugin
 *
 * Decoration plugin that injects a tiny "⋯" trigger button into the
 * top-right corner of every <td> / <th> in the editor. CSS hides the
 * button by default and only reveals it under @media (max-width: 1080).
 *
 * The button dispatches a `scrapalot:mobile-cell-menu-open` CustomEvent
 * with the cell's screen rect + its row/column index in the table. A
 * sibling React component (`mobile-cell-menu.tsx`) listens for the event
 * and pops a dropdown with cell/row/column-scoped actions.
 *
 * Why a Decoration widget instead of DOM walking from React: this hooks
 * directly into ProseMirror's render cycle, so the trigger appears /
 * vanishes correctly as cells are inserted, deleted, or reordered, with
 * no extra MutationObserver wiring.
 */

import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import type { Node as PMNode } from '@tiptap/pm/model';

export interface MobileCellMenuOpenDetail {
  rect: DOMRect;
  rowIndex: number;
  colIndex: number;
}

export const MOBILE_CELL_MENU_EVENT = 'scrapalot:mobile-cell-menu-open';

export const MobileCellMenuPlugin = Extension.create({
  name: 'mobileCellMenu',

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey('mobileCellMenu'),
        props: {
          decorations(state) {
            const decorations: Decoration[] = [];

            // Only emit the trigger for the cell that currently holds
            // the cursor. The user clicking a cell IS the affordance
            // for the trigger to appear — no chrome on inactive cells,
            // no need for hover state on touch.
            const selFrom = state.selection.from;

            state.doc.descendants((node: PMNode, pos: number) => {
              const isCell =
                node.type.name === 'tableCell' || node.type.name === 'tableHeader';
              if (!isCell) return true;

              const cellStart = pos;
              const cellEnd = pos + node.nodeSize;
              const cursorInsideCell = selFrom >= cellStart && selFrom <= cellEnd;
              if (!cursorInsideCell) return true;

              decorations.push(
                Decoration.widget(
                  pos + 1,
                  () => {
                    const btn = document.createElement('button');
                    btn.type = 'button';
                    btn.className = 'mobile-cell-menu-trigger';
                    btn.setAttribute('data-mobile-cell-menu', 'true');
                    btn.setAttribute('contenteditable', 'false');
                    btn.setAttribute('aria-label', 'Cell options');
                    // Vertical three-dot — fits the 16x16 mask without
                    // looking like the table grip 6-dot we just removed.
                    btn.innerHTML =
                      '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="5" r="0.6"/><circle cx="12" cy="12" r="0.6"/><circle cx="12" cy="19" r="0.6"/></svg>';

                    btn.addEventListener('pointerdown', (e) => {
                      // Stop ProseMirror from re-targeting the selection
                      // on pointerdown; the menu wants the cursor to
                      // stay where the user already put it (or, if the
                      // cell is fresh, we'll move it ourselves).
                      e.preventDefault();
                      e.stopPropagation();
                    });

                    btn.addEventListener('click', (e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      const cellEl = btn.closest('td, th') as HTMLElement | null;
                      if (!cellEl) return;
                      const rowEl = cellEl.parentElement as HTMLElement | null;
                      const tbodyOrThead = rowEl?.parentElement as HTMLElement | null;
                      const tableEl = tbodyOrThead?.closest('table');
                      let rowIndex = 0;
                      let colIndex = 0;
                      if (rowEl && tableEl) {
                        const allRows = Array.from(
                          tableEl.querySelectorAll(':scope > thead > tr, :scope > tbody > tr, :scope > tr'),
                        );
                        rowIndex = Math.max(0, allRows.indexOf(rowEl));
                      }
                      if (rowEl) {
                        const cells = Array.from(rowEl.children).filter(
                          (c) => c.tagName === 'TD' || c.tagName === 'TH',
                        );
                        colIndex = Math.max(0, cells.indexOf(cellEl));
                      }
                      const detail: MobileCellMenuOpenDetail = {
                        rect: btn.getBoundingClientRect(),
                        rowIndex,
                        colIndex,
                      };
                      window.dispatchEvent(
                        new CustomEvent<MobileCellMenuOpenDetail>(MOBILE_CELL_MENU_EVENT, { detail }),
                      );
                    });

                    return btn;
                  },
                  {
                    side: -1,
                    key: `mobile-cell-menu-${pos}`,
                  },
                ),
              );

              return true;
            });

            return DecorationSet.create(state.doc, decorations);
          },
        },
      }),
    ];
  },
});

export default MobileCellMenuPlugin;
