/**
 * Comment Mark Extension
 * Highlights text that has comments associated with it
 * Highlights persist until all comments are resolved
 */

import { Mark, mergeAttributes } from '@tiptap/core';

export interface CommentMarkOptions {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- TipTap extension convention for HTML attributes
  HTMLAttributes: Record<string, any>;
}

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    commentMark: {
      /**
       * Set a comment mark
       */
      setCommentMark: (commentId: string) => ReturnType;
      /**
       * Remove a comment mark
       */
      removeCommentMark: (commentId: string) => ReturnType;
      /**
       * Toggle a comment mark
       */
      toggleCommentMark: (commentId: string) => ReturnType;
    };
  }
}

export const CommentMark = Mark.create<CommentMarkOptions>({
  name: 'commentMark',

  addOptions() {
    return {
      HTMLAttributes: {},
    };
  },

  addAttributes() {
    return {
      commentId: {
        default: null,
        parseHTML: element => element.getAttribute('data-comment-id'),
        renderHTML: attributes => {
          if (!attributes.commentId) {
            return {};
          }
          return {
            'data-comment-id': attributes.commentId,
          };
        },
      },
      resolved: {
        default: false,
        parseHTML: element => element.getAttribute('data-resolved') === 'true',
        renderHTML: attributes => {
          return {
            'data-resolved': attributes.resolved ? 'true' : 'false',
          };
        },
      },
    };
  },

  parseHTML() {
    return [
      {
        tag: 'mark[data-comment-id]',
      },
    ];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      'mark',
      mergeAttributes(this.options.HTMLAttributes, HTMLAttributes, {
        class: 'comment-highlight',
      }),
      0,
    ];
  },

  addCommands() {
    return {
      setCommentMark:
        (commentId: string) =>
        ({ commands }) => {
          return commands.setMark(this.name, { commentId, resolved: false });
        },
      removeCommentMark:
        (commentId: string) =>
        ({ commands: _commands, state, tr, dispatch }) => {
          const { selection } = state;
          const { from: _from, to: _to } = selection;

          // Find all marks with this commentId in the document
          state.doc.descendants((node, pos) => {
            if (node.isText) {
              node.marks.forEach(mark => {
                if (mark.type.name === this.name && mark.attrs.commentId === commentId) {
                  const markFrom = pos;
                  const markTo = pos + node.nodeSize;
                  tr.removeMark(markFrom, markTo, this.type);
                }
              });
            }
          });

          // Dispatch the transaction to apply changes
          if (dispatch) {
            dispatch(tr);
          }

          return true;
        },
      toggleCommentMark:
        (commentId: string) =>
        ({ commands, state }) => {
          const { from, to } = state.selection;
          let hasCommentMark = false;

          state.doc.nodesBetween(from, to, node => {
            if (node.marks.find(mark => mark.type.name === this.name && mark.attrs.commentId === commentId)) {
              hasCommentMark = true;
            }
          });

          if (hasCommentMark) {
            return commands.removeCommentMark(commentId);
          }

          return commands.setCommentMark(commentId);
        },
    };
  },

  // Prevent deletion of comment marks unless comment is resolved
  onSelectionUpdate() {
    // This hook is called when selection changes
    // We use keyboard shortcuts (Backspace, Delete) to prevent mark removal
  },

  // Add keyboard shortcuts to prevent accidental deletion
  addKeyboardShortcuts() {
    return {
      // Prevent backspace from removing comment marks when at the boundary
      Backspace: ({ editor }) => {
        const { state } = editor;
        const { selection } = state;
        const { from, empty } = selection;

        // Only handle empty selections (cursor position, not text selection)
        if (!empty) {
          return false; // Allow normal backspace for text selections
        }

        // Check if the character before the cursor has an unresolved comment mark
        if (from > 0) {
          const nodeBefore = state.doc.resolve(from - 1);
          const marksBefore = nodeBefore.marks();
          const hasUnresolvedCommentMark = marksBefore.find(
            mark => mark.type.name === this.name && !mark.attrs.resolved
          );

          if (hasUnresolvedCommentMark) {
            // Prevent deletion - show a warning or just block it
            console.warn('[CommentMark] Cannot delete text with unresolved comment');
            return true; // Block the backspace
          }
        }

        return false; // Allow normal backspace
      },

      // Prevent delete key from removing comment marks
      Delete: ({ editor }) => {
        const { state } = editor;
        const { selection } = state;
        const { from: _from, to, empty } = selection;

        // Only handle empty selections
        if (!empty) {
          return false;
        }

        // Check if the character after the cursor has an unresolved comment mark
        if (to < state.doc.content.size) {
          const nodeAfter = state.doc.resolve(to);
          const marksAfter = nodeAfter.marks();
          const hasUnresolvedCommentMark = marksAfter.find(
            mark => mark.type.name === this.name && !mark.attrs.resolved
          );

          if (hasUnresolvedCommentMark) {
            console.warn('[CommentMark] Cannot delete text with unresolved comment');
            return true; // Block the delete
          }
        }

        return false;
      },
    };
  },
});
