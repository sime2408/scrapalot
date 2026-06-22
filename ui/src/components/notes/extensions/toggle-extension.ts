/**
 * Toggle (Details/Summary) Extension for TipTap
 * Creates collapsible sections like Notion's toggle blocks
 */

import { Node, mergeAttributes } from '@tiptap/core';
import { ReactNodeViewRenderer } from '@tiptap/react';
import { ToggleComponent } from './toggle-component';

export interface ToggleOptions {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- TipTap extension convention for HTML attributes
  HTMLAttributes: Record<string, any>;
}

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    toggle: {
      /**
       * Insert a toggle block
       */
      insertToggle: () => ReturnType;
      /**
       * Set toggle block
       */
      setToggle: () => ReturnType;
    };
  }
}

export const Toggle = Node.create<ToggleOptions>({
  name: 'toggle',

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
      open: {
        default: false,
        parseHTML: element => element.getAttribute('data-open') === 'true',
        renderHTML: attributes => {
          if (!attributes.open) {
            return {};
          }
          return { 'data-open': attributes.open };
        },
      },
      summary: {
        default: 'Toggle',
        parseHTML: element => element.getAttribute('data-summary') || 'Toggle',
        renderHTML: attributes => ({ 'data-summary': attributes.summary }),
      },
    };
  },

  parseHTML() {
    return [
      {
        tag: 'details',
        getAttrs: node => {
          const element = node as HTMLElement;
          const summary = element.querySelector('summary');
          return {
            open: element.hasAttribute('open'),
            summary: summary?.textContent || 'Toggle',
          };
        },
      },
    ];
  },

  renderHTML({ node, HTMLAttributes }) {
    // ProseMirror's serializer accepts EXACTLY ONE content hole (the
    // sentinel value `0`). The previous definition used two — one in
    // <summary> and one in <div.toggle-content> — which made the
    // serializer fall back to its error path, producing whatever
    // structure happened to be queued in the editor's transaction
    // (often the most recent table insert). The user-visible
    // symptom: clicking "Sklopivi popis" inserted a table instead.
    //
    // Render the summary text from node.attrs.summary (it's not a
    // child block, just a label) and reserve the single content hole
    // for the <div> where ProseMirror puts the inner block content.
    const summary = (node.attrs.summary as string) || 'Toggle';
    return [
      'details',
      mergeAttributes(this.options.HTMLAttributes, HTMLAttributes),
      ['summary', {}, summary],
      ['div', { class: 'toggle-content' }, 0],
    ];
  },

  addNodeView() {
    return ReactNodeViewRenderer(ToggleComponent);
  },

  addCommands() {
    return {
      insertToggle:
        () =>
        ({ commands }) => {
          return commands.insertContent({
            type: this.name,
            content: [
              {
                type: 'paragraph',
              },
            ],
          });
        },
      setToggle:
        () =>
        ({ commands }) => {
          return commands.setNode(this.name);
        },
    };
  },

  addKeyboardShortcuts() {
    return {
      'Mod-Alt-7': () => this.editor.commands.insertToggle(),
    };
  },
});
