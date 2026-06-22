/**
 * use-chat-scope-store
 *
 * Global store that holds the shared chat/notes scope: selected
 * collection ids + the Web search flag. Both the chat toolbar and the
 * Notes drawer popover do two-way binding against this store with
 * equality-guarded effects, so checking/unchecking a collection in
 * either surface edits the same list the other surface sees.
 *
 * Scope (kept intentionally narrow):
 *   - selectedCollectionIds: collection ids active in the chat toolbar
 *     popover AND the notes research-context popover (same list)
 *   - webSearchEnabled:     globe toggle shared by chat + notes
 *
 * Intentionally narrow: we keep only IDs and the Web toggle here, not
 * full DocumentCollection objects or RAG strategy/parameters, because:
 *   - IDs survive collection renames / refreshes (and the collections
 *     context already has the current objects keyed by id)
 *   - chat toolbar still owns similarity / numChunks / strategy /
 *     orchestrator inside its own state + backend persistence
 */

import { create } from 'zustand';

interface ChatScopeStore {
  /** Collection ids the user has checked in the chat toolbar. */
  selectedCollectionIds: string[];
  /** Web search toggle (Globe icon) — applies to chat AND notes AI actions. */
  webSearchEnabled: boolean;
  /** Replace the entire set of selected collection ids. */
  setSelectedCollectionIds: (ids: string[]) => void;
  /** Toggle or set the Web search flag. */
  setWebSearchEnabled: (enabled: boolean) => void;
}

export const useChatScopeStore = create<ChatScopeStore>((set) => ({
  selectedCollectionIds: [],
  webSearchEnabled: false,
  setSelectedCollectionIds: (ids) => set({ selectedCollectionIds: Array.from(new Set(ids)) }),
  setWebSearchEnabled: (enabled) => set({ webSearchEnabled: enabled }),
}));
