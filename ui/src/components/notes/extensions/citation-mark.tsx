/**
 * Citation Mark Extension
 * Inline mark that wraps text with a citation badge showing [Author, Year]
 * Follows the same pattern as CommentMark extension.
 */

import { Mark, mergeAttributes } from '@tiptap/core';

export interface CitationMarkOptions {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- TipTap extension convention for HTML attributes
  HTMLAttributes: Record<string, any>;
}

export interface CitationMarkAttrs {
  citationId: string;
  documentId: string;
  formattedShort: string;
  style: string;
  metadata: string;
}

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    citationMark: {
      /** Set a citation mark on the current selection */
      setCitationMark: (attrs: CitationMarkAttrs) => ReturnType;
      /** Remove a citation mark by citationId */
      unsetCitationMark: (citationId: string) => ReturnType;
    };
  }
}

export const CitationMark = Mark.create<CitationMarkOptions>({
  name: 'citationMark',

  addOptions() {
    return {
      HTMLAttributes: {},
    };
  },

  addAttributes() {
    return {
      citationId: {
        default: null,
        parseHTML: element => element.getAttribute('data-citation-id'),
        renderHTML: attributes => {
          if (!attributes.citationId) return {};
          return { 'data-citation-id': attributes.citationId };
        },
      },
      documentId: {
        default: null,
        parseHTML: element => element.getAttribute('data-document-id'),
        renderHTML: attributes => {
          if (!attributes.documentId) return {};
          return { 'data-document-id': attributes.documentId };
        },
      },
      formattedShort: {
        default: '',
        parseHTML: element => element.getAttribute('data-formatted-short'),
        renderHTML: attributes => {
          if (!attributes.formattedShort) return {};
          return { 'data-formatted-short': attributes.formattedShort };
        },
      },
      style: {
        default: 'apa',
        parseHTML: element => element.getAttribute('data-citation-style'),
        renderHTML: attributes => {
          return { 'data-citation-style': attributes.style || 'apa' };
        },
      },
      metadata: {
        default: '{}',
        parseHTML: element => element.getAttribute('data-citation-metadata'),
        renderHTML: attributes => {
          return { 'data-citation-metadata': attributes.metadata || '{}' };
        },
      },
    };
  },

  parseHTML() {
    return [
      {
        tag: 'cite[data-citation-id]',
      },
    ];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      'cite',
      mergeAttributes(this.options.HTMLAttributes, HTMLAttributes, {
        class: 'citation-mark',
      }),
      // Content hole must be the only child of a mark
      0,
    ];
  },

  addKeyboardShortcuts() {
    return {
      'Mod-Shift-c': () => {
        window.dispatchEvent(new CustomEvent('open-citation-picker'));
        return true;
      },
    };
  },

  addCommands() {
    return {
      setCitationMark:
        (attrs: CitationMarkAttrs) =>
        ({ commands }) => {
          return commands.setMark(this.name, attrs);
        },
      unsetCitationMark:
        (citationId: string) =>
        ({ state, tr, dispatch }) => {
          state.doc.descendants((node, pos) => {
            if (node.isText) {
              node.marks.forEach(mark => {
                if (mark.type.name === this.name && mark.attrs.citationId === citationId) {
                  const markFrom = pos;
                  const markTo = pos + node.nodeSize;
                  tr.removeMark(markFrom, markTo, this.type);
                }
              });
            }
          });
          if (dispatch) {
            dispatch(tr);
          }
          return true;
        },
    };
  },
});
