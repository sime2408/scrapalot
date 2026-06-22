/**
 * Page Break Decoration — visual A4 page markers in TipTap editor.
 *
 * Measures actual rendered block heights in the DOM and inserts a
 * subtle dashed line whenever accumulated height exceeds one A4 page.
 *
 * A4 dimensions at 96 DPI:
 *   Width:  210mm = 794px
 *   Height: 297mm = 1123px
 *   Usable height (minus ~20mm top+bottom margins): ~972px
 *
 * The plugin walks every top-level block node, sums their rendered
 * heights via `view.nodeDOM()`, and drops a widget decoration at each
 * page boundary.
 *
 * IMPORTANT: Decorations are computed in the `decorations` prop callback
 * (which receives the view via `this`), NOT via dispatch. Dispatching
 * inside view.update() causes an infinite transaction loop.
 */

import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import type { EditorView } from '@tiptap/pm/view';

/** A4 usable height (297mm - 40mm margins @ 96 DPI) — portrait default. */
export const A4_PAGE_HEIGHT_PX = 972;
/** A4 usable height landscape (210mm - 40mm margins @ 96 DPI). */
export const A4_PAGE_HEIGHT_PX_LANDSCAPE = 683;

const pluginKey = new PluginKey('pageBreakDecoration');

interface PageBoundary {
  pos: number;      // ProseMirror doc position
  pageNum: number;  // Page number AFTER this boundary (e.g., 2 = start of page 2)
}

/** Read the current A4 usable page height from a CSS variable on the
 * notes container. Falls back to portrait A4 if unset. Making this
 * runtime-read means orientation toggles take effect without
 * recreating the TipTap editor instance. */
function readPageHeight(view: EditorView): number {
  const container = view.dom.closest('[data-notes-container]') as HTMLElement | null;
  if (!container) return A4_PAGE_HEIGHT_PX;
  const raw = getComputedStyle(container).getPropertyValue('--notes-page-height').trim();
  const n = parseFloat(raw);
  return Number.isFinite(n) && n > 0 ? n : A4_PAGE_HEIGHT_PX;
}

/**
 * Walk every top-level block, measure rendered height, and return
 * doc positions where cumulative height crosses an A4 boundary.
 */
function computePageBoundaries(view: EditorView): PageBoundary[] {
  const boundaries: PageBoundary[] = [];
  const doc = view.state.doc;
  const pageHeight = readPageHeight(view);
  let accHeight = 0;
  let currentPage = 1;

  doc.forEach((node, offset) => {
    const dom = view.nodeDOM(offset);
    if (!dom || !(dom instanceof HTMLElement)) return;

    const height = dom.getBoundingClientRect().height;
    accHeight += height;

    while (accHeight > pageHeight) {
      currentPage++;
      boundaries.push({ pos: offset, pageNum: currentPage });
      accHeight -= pageHeight;
    }
  });

  return boundaries;
}

/**
 * Given an EditorView and a cursor position, return which visual
 * "page" the cursor is on and the document positions for that page.
 */
export function getPageAtPos(
  view: EditorView,
  pos: number,
): { page: number; startPos: number; endPos: number; totalPages: number } {
  const boundaries = computePageBoundaries(view);
  const allBounds = [0, ...boundaries.map(b => b.pos), view.state.doc.content.size];
  const totalPages = allBounds.length - 1;

  let page = 1;
  for (let i = 1; i < allBounds.length; i++) {
    if (pos < allBounds[i]) {
      page = i;
      break;
    }
    page = i;
  }

  return {
    page,
    startPos: allBounds[page - 1],
    endPos: allBounds[Math.min(page, allBounds.length - 1)],
    totalPages,
  };
}

/**
 * Build DecorationSet from current view. Called from the decorations
 * prop which has access to the view via `this`. Never dispatches.
 */
function buildDecorations(view: EditorView): DecorationSet {
  const boundaries = computePageBoundaries(view);
  if (boundaries.length === 0) return DecorationSet.empty;

  const decorations = boundaries.map((b) =>
    Decoration.widget(b.pos, () => {
      const el = document.createElement('div');
      el.className = 'page-break-decoration';
      el.setAttribute('data-page', String(b.pageNum));
      el.setAttribute('contenteditable', 'false');
      return el;
    }, {
      side: -1,
      key: `page-${b.pageNum}`,
    }),
  );

  return DecorationSet.create(view.state.doc, decorations);
}

export const PageBreakDecoration = Extension.create({
  name: 'pageBreakDecoration',

  addProseMirrorPlugins() {
    // Cache to avoid rebuilding on every keystroke
    let cachedDecos: DecorationSet = DecorationSet.empty;
    let cachedDocSize = -1;
    let editorView: EditorView | null = null;
    let rebuildTimer: ReturnType<typeof setTimeout> | null = null;

    const scheduleRebuild = () => {
      if (rebuildTimer) clearTimeout(rebuildTimer);
      rebuildTimer = setTimeout(() => {
        if (editorView) {
          // Force decorations prop to re-evaluate by requesting a
          // no-op transaction (empty metadata, no doc change).
          cachedDocSize = -1; // invalidate cache
          editorView.dispatch(editorView.state.tr);
        }
      }, 300);
    };

    return [
      new Plugin({
        key: pluginKey,
        props: {
          decorations(state) {
            // `this` is the plugin spec with access to the view when
            // called from EditorView. We use the captured editorView
            // reference instead for type safety.
            if (!editorView) return DecorationSet.empty;

            const docSize = state.doc.content.size;
            if (docSize !== cachedDocSize) {
              cachedDocSize = docSize;
              cachedDecos = buildDecorations(editorView);
            }
            return cachedDecos;
          },
        },
        view(view) {
          editorView = view;

          // Initial build after DOM is ready
          setTimeout(() => {
            cachedDocSize = -1;
            view.dispatch(view.state.tr);
          }, 500);

          // Rebuild whenever the editor's width changes (orientation
          // toggle, sidebar resize, window resize) — block-height
          // measurements depend on the container width.
          const ro = new ResizeObserver(() => scheduleRebuild());
          ro.observe(view.dom);
          const container = view.dom.closest('[data-notes-container]');
          if (container) ro.observe(container);

          return {
            update() {
              // Debounced rebuild after each editor update
              scheduleRebuild();
            },
            destroy() {
              ro.disconnect();
              if (rebuildTimer) clearTimeout(rebuildTimer);
              editorView = null;
            },
          };
        },
      }),
    ];
  },
});
