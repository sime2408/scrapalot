/**
 * Chat With Document — small helper that lets any surface (PDF / EPUB / DOCX
 * viewer toolbars, future document-detail pages, etc.) ask the chat input to
 * attach a specific document as an `@`-mention and focus itself.
 *
 * Implementation detail: a plain `CustomEvent` on the `window`. The chat input
 * already holds the `useChatMentions` hook state; it subscribes to this event
 * on mount, adds the mention via `addMention(...)`, and focuses the textarea.
 *
 * Using a custom event (not a React context) keeps the producers decoupled —
 * viewers don't need to be wrapped in a chat context and there's no extra
 * provider layer to add.
 */

export const CHAT_WITH_DOCUMENT_EVENT = 'scrapalot:chat-with-document' as const;

export interface ChatWithDocumentPayload {
  documentId: string;
  documentName: string;
  collectionId?: string;
  collectionName?: string;
  /** Optional page count (shown in the chat mention chip for context). */
  pageCount?: number;
  /**
   * When true, the chat toolbar attaches the mention chip but does NOT
   * focus the textarea. Set by viewers that auto-mention on open (EPUB /
   * PDF / DOCX drawer), where a focus would pop the mobile soft-keyboard
   * the user did not ask for. Explicit "Chat with this document" actions
   * leave it unset so the user lands in the input ready to type.
   */
  silent?: boolean;
}

export type ChatWithDocumentEvent = CustomEvent<ChatWithDocumentPayload>;

/**
 * Request that the chat input attach the given document as an `@`-mention and
 * focus itself. Safe to call from any component — no dependency on chat context.
 */
export function openChatWithDocument(payload: ChatWithDocumentPayload): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(
    new CustomEvent<ChatWithDocumentPayload>(CHAT_WITH_DOCUMENT_EVENT, { detail: payload })
  );
}
