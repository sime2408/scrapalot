/**
 * Slash command extension for TipTap
 * Creates a custom extension that triggers on "/" character
 */

import { Extension, type Editor, type Range } from '@tiptap/core';
import Suggestion, { type SuggestionOptions, type SuggestionProps, type SuggestionKeyDownProps } from '@tiptap/suggestion';
import { ReactRenderer } from '@tiptap/react';
import tippy, { Instance as TippyInstance } from 'tippy.js';
import { SlashCommands } from './slash-commands';


export const SlashCommandExtension = Extension.create({
  name: 'slashCommand',

  addOptions() {
    return {
      onOpenMarkdownImport: undefined as (() => void) | undefined,
      onOpenBibImport: undefined as (() => void) | undefined,
      suggestion: {
        char: '/',
        startOfLine: false,
        command: ({ editor, range, props }: { editor: Editor; range: Range; props: { command: (args: { editor: Editor; range: Range }) => void } }) => {
          props.command({ editor, range });
        },
      } as Partial<SuggestionOptions>,
    };
  },

  addProseMirrorPlugins() {
    // Shared state between the command interceptor and render closure.
    // commandExecuted is set to true when a slash command is actually
    // selected — onExit uses it to decide whether to clean up the "/" text.
    const state = { commandExecuted: false };

    return [
      Suggestion({
        editor: this.editor,
        ...this.options.suggestion,
        // Intercept command execution to mark the slash as intentionally used.
        command: ({ editor, range, props }: { editor: Editor; range: Range; props: { command: (args: { editor: Editor; range: Range }) => void } }) => {
          state.commandExecuted = true;
          props.command({ editor, range });
        },
        render: () => {
          let component: ReactRenderer | null = null;
          let popup: TippyInstance[] | null = null;
          let lastProps: SuggestionProps | null = null;

          const extensionOptions = this.options;

          return {
            onStart: (props: SuggestionProps) => {
              lastProps = props;
              state.commandExecuted = false;

              // Mobile-only: suppress the soft keyboard while the slash
              // menu is open. The on-screen keyboard would otherwise eat
              // 40-50 % of the viewport and hide the menu's bottom items.
              // inputmode="none" tells the browser not to summon the
              // keyboard on focus; a blur+refocus cycle dismisses any
              // already-visible keyboard. Selection is preserved across
              // the blur because Tiptap re-applies it on the next focus.
              if (typeof window !== 'undefined' && window.innerWidth <= 1080) {
                const dom = props.editor.view.dom as HTMLElement;
                dom.setAttribute('inputmode', 'none');
                const wasActive = document.activeElement === dom;
                if (wasActive) {
                  dom.blur();
                  // Microtask-deferred refocus keeps caret position but
                  // honours the new inputmode (browsers re-evaluate it
                  // on the next focus event).
                  requestAnimationFrame(() => dom.focus({ preventScroll: true }));
                }
              }

              component = new ReactRenderer(SlashCommands, {
                props: {
                  ...props,
                  onClose: () => {
                    popup?.[0]?.hide();
                  },
                  onOpenMarkdownImport: extensionOptions.onOpenMarkdownImport,
                  onOpenBibImport: extensionOptions.onOpenBibImport,
                },
                editor: props.editor,
              });

              if (!props.clientRect) {
                return;
              }

              popup = tippy('body', {
                getReferenceClientRect: props.clientRect,
                appendTo: () => document.body,
                content: component.element,
                showOnCreate: true,
                interactive: true,
                trigger: 'manual',
                placement: 'bottom-start',
                maxWidth: 'none',
                theme: 'slash-command',
              });
            },

            onUpdate(props: SuggestionProps) {
              lastProps = props;

              component?.updateProps({
                ...props,
                onClose: () => {
                  popup?.[0]?.hide();
                },
                onOpenMarkdownImport: extensionOptions.onOpenMarkdownImport,
              });

              if (!props.clientRect) {
                return;
              }

              popup?.[0]?.setProps({
                getReferenceClientRect: props.clientRect,
              });
            },

            onKeyDown(props: SuggestionKeyDownProps) {
              if (props.event.key === 'Escape') {
                popup?.[0]?.hide();
                return true;
              }

              return component?.ref?.onKeyDown(props) || false;
            },

            onExit() {
              // If the user abandoned the slash command (no item selected),
              // delete the "/" character and any query text they typed.
              if (!state.commandExecuted && lastProps) {
                try {
                  lastProps.editor
                    .chain()
                    .focus()
                    .deleteRange(lastProps.range)
                    .run();
                } catch {
                  // Range may be stale if the user already deleted the text manually.
                }
              }

              state.commandExecuted = false;

              // Restore the soft keyboard for subsequent typing. Remove
              // inputmode="none" so the next focus event brings the
              // keyboard back. We don't force-refocus here — Tiptap
              // typically already has focus from the command that just
              // ran, and forcing focus would steal it away from a
              // modal opened by an action like "Import Markdown".
              if (lastProps && typeof window !== 'undefined' && window.innerWidth <= 1080) {
                (lastProps.editor.view.dom as HTMLElement).removeAttribute('inputmode');
              }

              lastProps = null;
              popup?.[0]?.destroy();
              component?.destroy();
            },
          };
        },
      }),
    ];
  },
});
