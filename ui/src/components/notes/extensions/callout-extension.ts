/**
 * Callout Extension for TipTap
 * Creates styled alert/callout boxes like Notion
 */

import { Node, mergeAttributes } from '@tiptap/core';
import { ReactNodeViewRenderer } from '@tiptap/react';
import { CalloutComponent } from './callout-component';

export interface CalloutOptions {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- TipTap extension convention for HTML attributes
  HTMLAttributes: Record<string, any>;
}

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    callout: {
      /**
       * Insert a callout block
       */
      insertCallout: (type?: string) => ReturnType;
      /**
       * Set callout type
       */
      setCallout: (type: string) => ReturnType;
    };
  }
}

export const Callout = Node.create<CalloutOptions>({
  name: 'callout',

  group: 'block',

  content: 'block+',

  defining: true,

  addOptions() {
    return {
      HTMLAttributes: {},
    };
  },

  addAttributes() {
    return {
      type: {
        default: 'default',
        parseHTML: element => element.getAttribute('data-type') || 'default',
        renderHTML: attributes => ({ 'data-type': attributes.type }),
      },
    };
  },

  parseHTML() {
    return [
      {
        tag: 'div[data-callout]',
        getAttrs: node => {
          const element = node as HTMLElement;
          return {
            type: element.getAttribute('data-type') || 'default',
          };
        },
      },
    ];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      'div',
      mergeAttributes(this.options.HTMLAttributes, HTMLAttributes, { 'data-callout': '' }),
      0,
    ];
  },

  addNodeView() {
    return ReactNodeViewRenderer(CalloutComponent);
  },

  addCommands() {
    return {
      insertCallout:
        (type = 'default') =>
        ({ commands }) => {
          return commands.insertContent({
            type: this.name,
            attrs: { type },
            content: [
              {
                type: 'paragraph',
              },
            ],
          });
        },
      setCallout:
        (type: string) =>
        ({ commands }) => {
          return commands.updateAttributes(this.name, { type });
        },
    };
  },
});
