/**
 * Voice With Document — sibling helper to chat-with-document. Lets any
 * surface (PDF / EPUB / DOCX viewer toolbars, future document-detail pages)
 * pop the VoiceModeDialog scoped to a specific document without that
 * surface having to know where VoiceModeDialog is rendered.
 *
 * Implementation: plain `CustomEvent` on `window`. The chat surface
 * (`chat-messages.tsx`) subscribes on mount, sets its `voiceModeDocs`
 * snapshot from the event detail, and opens the dialog.
 *
 * Decoupled by design — viewers import only this helper, no chat context
 * provider required.
 */

export const VOICE_WITH_DOCUMENT_EVENT = 'scrapalot:voice-with-document' as const;

export interface VoiceWithDocumentPayload {
  documentId: string;
  documentName: string;
}

export type VoiceWithDocumentEvent = CustomEvent<VoiceWithDocumentPayload>;

/**
 * Request that the chat surface open the VoiceModeDialog with the given
 * document attached as the single scoped book. Safe to call from any
 * component — no dependency on chat context.
 */
export function openVoiceWithDocument(payload: VoiceWithDocumentPayload): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(
    new CustomEvent<VoiceWithDocumentPayload>(VOICE_WITH_DOCUMENT_EVENT, { detail: payload }),
  );
}
