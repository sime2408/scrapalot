/**
 * 7.1 — AI Autocomplete (ghost text) for the Notes editor.
 *
 * TipTap extension that fires a single short LLM call on typing pauses
 * and renders the result as a translucent inline decoration at the
 * caret. Tab inserts; Escape, click, or any further typing dismisses.
 *
 * Why a Tiptap extension and not a React effect on the wrapper:
 * — Decorations live inside the editor's DecorationSet so they survive
 *   schema-aware re-renders (Y.js applying remote ops, focus mode
 *   re-decorating top-level blocks, etc.) without flickering.
 * — Keymap entries can intercept Tab BEFORE TipTap's default behavior
 *   runs, which lets us swallow the key when a suggestion is on screen.
 * — Suggestion lifecycle is bound to selection / doc transactions,
 *   which is the canonical ProseMirror way of expressing "this is only
 *   valid while the cursor sits exactly where it was when we asked".
 *
 * The extension is opt-in: storage flag `enabled` defaults to false so
 * the toolbar toggle controls whether the plugin actually fires the
 * network call.
 *
 * Cost discipline: typing in a note is a 50/min event. We debounce by
 * ~700 ms and skip while the user is mid-word (last char is not a
 * space). We also skip if the cursor sits inside a code block — ghost
 * prose suggestions there are noise.
 */
import { Extension } from '@tiptap/core';
import { Plugin, PluginKey, EditorState, Transaction } from '@tiptap/pm/state';
import { Decoration, DecorationSet, EditorView } from '@tiptap/pm/view';
import { ghostCompleteNote } from '@/lib/api-notes-assistant';

const pluginKey = new PluginKey<AutocompleteState>('aiAutocomplete');

interface AutocompleteState {
  /** Suggestion text, empty when nothing to show. */
  suggestion: string;
  /** Doc position the suggestion is anchored to. */
  pos: number;
  /** Decoration set rendered next pass. */
  decorations: DecorationSet;
}

interface AutocompleteStorage {
  /** When false the plugin does nothing (no fetch, no decoration). */
  enabled: boolean;
  /** Aborts the current in-flight fetch when the cursor moves. */
  abortController: AbortController | null;
  /** Debounce timer id. */
  timer: number | null;
}

/** Window between last keystroke and the network call. Lower = more
 *  calls, higher = laggy feel. 700 ms covers a typical pause-after-
 *  sentence without firing in the middle of a word burst. */
const DEBOUNCE_MS = 700;

/** Only ask the model once the user has typed at least this many chars
 *  *before* the cursor. Below this the suggestion is a guess from no
 *  signal and the model hallucinates an opening. */
const MIN_BEFORE_CHARS = 10;

/** Hard cap on how much editor text we send. The Python service caps
 *  again at 1500/500 chars, but we trim here too so the request body
 *  doesn't carry kilobytes of payload across the wire. */
const SEND_BEFORE_MAX = 2000;
const SEND_AFTER_MAX = 800;

interface AutocompleteOptions {
  /** Initial value of the storage `enabled` flag. The toolbar toggle
   *  flips storage at runtime; we plumb this so collaborative-notes-
   *  editor can hydrate from localStorage on mount without firing a
   *  no-op transaction first. */
  defaultEnabled?: boolean;
}

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    aiAutocomplete: {
      /** Replace the suggestion with empty so it disappears. */
      dismissAutocomplete: () => ReturnType;
      /** Insert the current suggestion at the anchor position. */
      acceptAutocomplete: () => ReturnType;
      /** Toggle the plugin on/off at runtime. */
      setAutocompleteEnabled: (enabled: boolean) => ReturnType;
    };
  }
}

/** Read all text before the caret position, capped to SEND_BEFORE_MAX. */
function textBeforeCursor(state: EditorState): string {
  const { from } = state.selection;
  const start = Math.max(0, from - SEND_BEFORE_MAX);
  return state.doc.textBetween(start, from, '\n', ' ');
}

/** Read all text after the caret position, capped to SEND_AFTER_MAX. */
function textAfterCursor(state: EditorState): string {
  const { to } = state.selection;
  const end = Math.min(state.doc.content.size, to + SEND_AFTER_MAX);
  return state.doc.textBetween(to, end, '\n', ' ');
}

/** Pull the first heading and a couple of follow-ups for the outline
 *  hint. Cheap text walk; we don't need a full TOC. */
function extractOutline(state: EditorState): string {
  const headings: string[] = [];
  state.doc.descendants((node) => {
    if (headings.length >= 5) return false;
    if (node.type.name === 'heading') {
      const text = node.textContent.trim();
      if (text) headings.push(text);
    }
    return true;
  });
  return headings.join(' › ');
}

/** True when the caret is inside a node where ghost-text suggestions
 *  would be noise: code blocks (we'd suggest prose into code), the
 *  bibliography node (rendered output), or any explicit `code` mark
 *  context. */
function shouldSkipAtCursor(state: EditorState): boolean {
  const { $from } = state.selection;
  for (let depth = $from.depth; depth >= 0; depth -= 1) {
    const node = $from.node(depth);
    if (!node?.type?.name) continue;
    if (
      node.type.name === 'codeBlock' ||
      node.type.name === 'codeBlockWithLanguage' ||
      node.type.name === 'bibliography'
    ) {
      return true;
    }
  }
  return false;
}

/** Build the inline ghost-text decoration anchored at `pos`. Caller
 *  supplies the doc so the resulting DecorationSet is rooted in the
 *  current state and survives `tr.mapping` correctly. */
function buildDecoration(
  doc: EditorState['doc'],
  pos: number,
  suggestion: string,
): DecorationSet {
  if (!suggestion) return DecorationSet.empty;
  const widget = document.createElement('span');
  widget.className = 'ai-autocomplete-ghost';
  widget.textContent = suggestion;
  widget.setAttribute('data-testid', 'ai-autocomplete-ghost');
  // Not editable / not selectable — purely visual, never enters the doc
  // until the user accepts. side: 1 keeps it after the caret.
  const deco = Decoration.widget(pos, widget, { side: 1, key: 'ai-autocomplete' });
  return DecorationSet.create(doc, [deco]);
}

export const AiAutocomplete = Extension.create<AutocompleteOptions, AutocompleteStorage>({
  name: 'aiAutocomplete',

  // Run before TipTap's other extensions so our Plugin lands ahead of
  // the merged keymap plugin in `view.state.plugins`.  ProseMirror
  // walks `handleKeyDown` props in plugin order and stops at the
  // first one that returns true; without an elevated priority another
  // plugin (anonymous keymap with a Tab → tab-char binding) would
  // claim Tab before our handler had a chance to insert the ghost.
  // Default priority is 100; 1000 is higher than every TipTap
  // built-in we use.
  priority: 1000,

  addOptions() {
    return { defaultEnabled: false };
  },

  addStorage() {
    return {
      enabled: false,
      abortController: null,
      timer: null,
    };
  },

  onCreate() {
    this.storage.enabled = this.options.defaultEnabled ?? false;
  },

  addCommands() {
    return {
      dismissAutocomplete:
        () =>
        ({ tr, dispatch }) => {
          if (dispatch) dispatch(tr.setMeta(pluginKey, { type: 'clear' }));
          return true;
        },
      acceptAutocomplete:
        () =>
        ({ state, tr, dispatch, view }) => {
          const pluginState = pluginKey.getState(state);
          if (!pluginState || !pluginState.suggestion) return false;
          // Insert at the current selection rather than at the recorded
          // anchor. Earlier this command refused unless `selection.from`
          // matched `pluginState.pos` exactly, but in practice the
          // selection drifts by a few positions between the meta-set
          // dispatch and the user's Tab press (focus events, IME, etc.)
          // and the strict equality check made Tab silently fall
          // through to the default tab-character handler. The plugin
          // already clears the suggestion on any selection-set
          // transaction (see `apply` below), so when we get here the
          // cursor is guaranteed to still be in a position where the
          // user expects the ghost to land.
          if (dispatch) {
            tr.insertText(pluginState.suggestion);
            tr.setMeta(pluginKey, { type: 'clear' });
            dispatch(tr);
            // Programmatic inserts can bypass autosave observers — kick
            // the editor by emitting a focus to keep the dirty-check
            // chain honest. Cheap no-op when already focused.
            view?.focus();
          }
          return true;
        },
      setAutocompleteEnabled:
        (enabled: boolean) =>
        ({ tr, dispatch, editor }) => {
          editor.storage.aiAutocomplete.enabled = enabled;
          if (!enabled && dispatch) dispatch(tr.setMeta(pluginKey, { type: 'clear' }));
          return true;
        },
    };
  },

  // Tab + Escape live on the Plugin's `handleKeyDown` (see
  // addProseMirrorPlugins below), not in `addKeyboardShortcuts`,
  // because the keymap chain TipTap builds from extension shortcuts
  // can be pre-empted by another anonymous Plugin whose
  // handleKeyDown also claims Tab.  Using the Plugin layer + an
  // elevated extension priority gets us first-bite-of-the-apple
  // ordering reliably.

  addProseMirrorPlugins() {
    const extensionStorage = this.storage;
    const editor = this.editor;

    return [
      new Plugin<AutocompleteState>({
        key: pluginKey,

        state: {
          init(): AutocompleteState {
            return { suggestion: '', pos: -1, decorations: DecorationSet.empty };
          },
          apply(tr: Transaction, prev: AutocompleteState, _oldState, newState): AutocompleteState {
            const meta = tr.getMeta(pluginKey) as
              | { type: 'set'; suggestion: string; pos: number }
              | { type: 'clear' }
              | undefined;

            if (meta?.type === 'clear') {
              return { suggestion: '', pos: -1, decorations: DecorationSet.empty };
            }
            if (meta?.type === 'set') {
              const decorations = buildDecoration(newState.doc, meta.pos, meta.suggestion);
              return { suggestion: meta.suggestion, pos: meta.pos, decorations };
            }

            // Doc edit invalidates the suggestion (the user typed → the
            // anchor moves; rather than chase it, we just clear).
            if (tr.docChanged) {
              return { suggestion: '', pos: -1, decorations: DecorationSet.empty };
            }
            // Selection moved without an edit → also clear so we don't
            // anchor stale ghost text on a different paragraph.
            if (tr.selectionSet && newState.selection.from !== prev.pos) {
              return { suggestion: '', pos: -1, decorations: DecorationSet.empty };
            }
            return { ...prev, decorations: prev.decorations.map(tr.mapping, tr.doc) };
          },
        },

        props: {
          decorations(state) {
            return pluginKey.getState(state)?.decorations;
          },
          // Tab / Escape go on the Plugin's handleKeyDown rather than
          // the extension's `addKeyboardShortcuts` because TipTap
          // merges every extension's shortcuts into a single keymap
          // Plugin — and that merged Plugin can be preceded in the
          // plugin array by another anonymous Plugin whose
          // handleKeyDown also claims Tab and inserts a literal tab
          // character. ProseMirror's view.someProp('handleKeyDown')
          // walks plugins in order and stops at the first truthy
          // return, so attaching our binding to the merged keymap
          // never wins. Putting it directly on the Plugin's
          // handleKeyDown (combined with priority: 1000 above so
          // this Plugin lands at the top of the array) gets the
          // first-bite-of-the-apple semantics we actually need.
          handleKeyDown(view: EditorView, event: KeyboardEvent): boolean {
            // Shift+Tab is "outdent" in lists / cells; never claim it.
            if (event.shiftKey || event.metaKey || event.ctrlKey || event.altKey) return false;
            const ps = pluginKey.getState(view.state);
            if (!ps?.suggestion) return false;
            if (event.key === 'Tab') {
              const tr = view.state.tr.insertText(ps.suggestion);
              tr.setMeta(pluginKey, { type: 'clear' });
              view.dispatch(tr);
              return true;
            }
            if (event.key === 'Escape') {
              view.dispatch(view.state.tr.setMeta(pluginKey, { type: 'clear' }));
              return true;
            }
            return false;
          },
          handleDOMEvents: {
            mousedown: (view: EditorView) => {
              // Click anywhere = dismiss the current ghost. The selection
              // change that follows would clear it anyway, but doing it
              // synchronously prevents a frame of stale render.
              const ps = pluginKey.getState(view.state);
              if (ps?.suggestion) {
                view.dispatch(view.state.tr.setMeta(pluginKey, { type: 'clear' }));
              }
              return false;
            },
          },
        },

        view(_view: EditorView) {
          // Watch transactions for selection changes; debounce the
          // network call. The plugin "view" is the canonical place for
          // side effects keyed off editor state.
          return {
            update(view: EditorView, prevState: EditorState) {
              if (!extensionStorage.enabled) return;
              if (!view.state.selection.empty) return; // only on caret, never on a real selection
              if (view.state.doc.eq(prevState.doc) && view.state.selection.eq(prevState.selection)) {
                return;
              }
              if (shouldSkipAtCursor(view.state)) return;

              // Reset debounce on every cursor / doc change.
              if (extensionStorage.timer) {
                window.clearTimeout(extensionStorage.timer);
                extensionStorage.timer = null;
              }
              if (extensionStorage.abortController) {
                extensionStorage.abortController.abort();
                extensionStorage.abortController = null;
              }

              const beforeRaw = textBeforeCursor(view.state);
              if (beforeRaw.trim().length < MIN_BEFORE_CHARS) return;
              // Skip while still typing a word (no trailing space). Most
              // useful suggestions land at sentence/paragraph boundaries.
              const lastChar = beforeRaw.slice(-1);
              if (lastChar && !/\s/.test(lastChar) && lastChar !== '.' && lastChar !== '?' && lastChar !== '!' && lastChar !== ':' && lastChar !== '\n') {
                return;
              }

              extensionStorage.timer = window.setTimeout(async () => {
                extensionStorage.timer = null;
                if (!extensionStorage.enabled) return;
                const anchorPos = view.state.selection.from;
                const before = textBeforeCursor(view.state);
                const after = textAfterCursor(view.state);
                const outline = extractOutline(view.state);
                extensionStorage.abortController = new AbortController();
                try {
                  const response = await ghostCompleteNote(before, after, outline);
                  // 7.1 cost guard — broadcast the latest sliding-window
                  // quota so notes-drawer can render the "x of N used
                  // this hour" badge near the AI Autocomplete toggle.
                  // Single-direction event so the extension stays
                  // independent of any React tree above it.
                  if (typeof response.quota_limit === 'number' && response.quota_limit > 0) {
                    window.dispatchEvent(
                      new CustomEvent('scrapalot:notes:autocomplete-quota', {
                        detail: {
                          used: response.quota_used ?? 0,
                          limit: response.quota_limit,
                        },
                      }),
                    );
                  }
                  // Drop result if user moved or the plugin was disabled
                  // while the request was in flight.
                  if (!extensionStorage.enabled) return;
                  if (view.state.selection.from !== anchorPos) return;
                  // Rate-limited: nothing to insert; the badge already
                  // updated above so the user sees the cooldown without
                  // an error toast.
                  if (response.error === 'rate_limited') return;
                  if (!response.success || !response.suggestion) return;
                  view.dispatch(
                    view.state.tr.setMeta(pluginKey, {
                      type: 'set',
                      suggestion: response.suggestion,
                      pos: anchorPos,
                    }),
                  );
                } catch (err) {
                  // Network or 4xx; silently ignore — suggestions are
                  // best-effort and never gate on the user.
                  if (process.env.NODE_ENV !== 'production') {
                    // eslint-disable-next-line no-console -- diagnostic only
                    console.debug('[ai-autocomplete] fetch failed', err);
                  }
                } finally {
                  extensionStorage.abortController = null;
                }
              }, DEBOUNCE_MS);
            },
            destroy() {
              if (extensionStorage.timer) {
                window.clearTimeout(extensionStorage.timer);
                extensionStorage.timer = null;
              }
              if (extensionStorage.abortController) {
                extensionStorage.abortController.abort();
                extensionStorage.abortController = null;
              }
              // Editor reference no longer used post-destroy.
              void editor;
            },
          };
        },
      }),
    ];
  },
});
