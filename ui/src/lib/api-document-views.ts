/**
 * Recent Documents API client.
 *
 * recordDocumentView(): fire-and-forget tracking (errors logged, never
 * throw to the caller — the user shouldn't see a toast because their
 * document opened "successfully" but a tracking write failed).
 *
 * getRecentDocuments(): used by the Command Palette's Recent group and
 * (future) a sidebar Recent strip.
 */
import { apiClient } from '@/lib/api';

export type DocumentViewSource =
  | 'pdf_open'
  | 'epub_open'
  | 'docx_open'
  | 'cited'
  | 'rag_retrieved'
  | 'note_linked';

export interface RecentDocument {
  document_id: string;
  collection_id: string | null;
  last_viewed_at: string;
  source: DocumentViewSource;
}

export async function recordDocumentView(
  documentId: string,
  source: DocumentViewSource,
  collectionId?: string | null,
): Promise<void> {
  try {
    await apiClient.post('/document-views', {
      document_id: documentId,
      collection_id: collectionId ?? null,
      source,
    });
    // Notify any mounted Recent strips to refetch. Listeners
    // (sidebar-recent-documents, command-palette future) handle their
    // own debouncing via the 60 s response cache.
    window.dispatchEvent(new CustomEvent('scrapalot:recent-documents-changed'));
  } catch (err) {
    // Tracking is fire-and-forget — surfacing the failure would be
    // worse than missing one row in the analytics log.
    console.warn('[document-views] recordView failed:', err);
  }
}

export async function getRecentDocuments(limit = 15): Promise<RecentDocument[]> {
  try {
    const { data } = await apiClient.get(`/document-views/recent?limit=${limit}`);
    return (data?.recents as RecentDocument[]) || [];
  } catch (err) {
    console.warn('[document-views] getRecent failed:', err);
    return [];
  }
}

/**
 * Dismiss a single document from the user's Recent list. Idempotent on
 * the backend (no row → no-op), so calling it twice is safe. Best-effort
 * — failures are logged, not surfaced, so the UI optimistic-remove never
 * leaves the user staring at a "Failed to forget recent doc" toast.
 */
export async function dismissRecentDocument(documentId: string): Promise<void> {
  try {
    await apiClient.delete(`/document-views/${documentId}`);
    window.dispatchEvent(new CustomEvent('scrapalot:recent-documents-changed'));
  } catch (err) {
    console.warn('[document-views] dismissRecent failed:', err);
  }
}
