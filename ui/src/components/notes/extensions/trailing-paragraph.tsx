/**
 * Trailing Paragraph Extension
 * Ensures there's always an empty paragraph at the end of the document
 * This allows users to click after any block to continue editing
 */

import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';

export const TrailingParagraph = Extension.create({
  name: 'trailingParagraph',

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey('trailingParagraph'),
        appendTransaction: (transactions, oldState, newState) => {
          const { doc, tr, schema } = newState;

          // Check if the document is empty or if the last node is not a paragraph
          if (doc.childCount === 0) {
            return null;
          }

          const lastNode = doc.lastChild;

          // If the last node is not a paragraph, or if it's not empty, add an empty paragraph
          if (
            !lastNode ||
            lastNode.type.name !== 'paragraph' ||
            lastNode.content.size > 0
          ) {
            // Add an empty paragraph at the end
            const paragraph = schema.nodes.paragraph.create();
            tr.insert(doc.content.size, paragraph);
            return tr;
          }

          return null;
        },
      }),
    ];
  },
});
