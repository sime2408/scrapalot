/**
 * useDocumentFileStatusStore — shared client-side cache that tracks
 * whether each document has its source file on disk.
 *
 * Motivation: citations in the chat sometimes point to documents whose
 * source file has been deleted from disk (or never finished uploading).
 * Clicking such a citation opens the PDF/EPUB/DOCX viewer which then
 * breaks with a raw 404. We refuse to offer "open" when we know the
 * file is missing.
 *
 * Design:
 *   - A zustand store keyed by document id holds one of three states:
 *     `unknown` (never probed), `present`, `missing`.
 *   - `probeDocumentFile(id)` does a HEAD request against
 *     /documents/{id}/file, updates the store, and returns the new
 *     state. In-flight probes are deduplicated so concurrent callers
 *     share one network roundtrip per document.
 *   - `useOpenCitationInViewer` (and the citation chip) read + probe
 *     this store to decide whether to allow opening and how to render.
 */

import { create } from 'zustand';
import { api } from '@/lib/api';

export type DocumentFileStatus = 'unknown' | 'present' | 'missing';

interface DocumentFileStatusStore {
  status: Record<string, DocumentFileStatus>;
  setStatus: (id: string, state: DocumentFileStatus) => void;
}

export const useDocumentFileStatusStore = create<DocumentFileStatusStore>((set) => ({
  status: {},
  setStatus: (id, state) =>
    set((prev) => (prev.status[id] === state ? prev : { status: { ...prev.status, [id]: state } })),
}));

/** Deduped in-flight probes keyed by document id. */
const inFlight = new Map<string, Promise<DocumentFileStatus>>();

/**
 * Probe a document's file endpoint. Resolves with 'present' (2xx),
 * 'missing' (404), or 'unknown' (any other error — we can't be sure,
 * don't block the user). Caches the final state in the store.
 */
export async function probeDocumentFile(documentId: string): Promise<DocumentFileStatus> {
  if (!documentId) return 'unknown';
  const current = useDocumentFileStatusStore.getState().status[documentId];
  if (current === 'present' || current === 'missing') return current;

  const existing = inFlight.get(documentId);
  if (existing) return existing;

  const probe = (async (): Promise<DocumentFileStatus> => {
    try {
      // HEAD is cheapest — we only care about the status code, not the
      // file body. Backend routes /documents/{id}/file through gRPC
      // streaming; HEAD returns the same status that GET would.
      await api.head(`/documents/${documentId}/file`);
      useDocumentFileStatusStore.getState().setStatus(documentId, 'present');
      return 'present';
    } catch (err) {
      const status = (err as { response?: { status?: number } })?.response?.status;
      if (status === 404) {
        useDocumentFileStatusStore.getState().setStatus(documentId, 'missing');
        return 'missing';
      }
      // Network flakes, auth issues etc. — stay 'unknown' so the user can
      // still try to open. Only hard 404 blocks the button.
      return 'unknown';
    } finally {
      inFlight.delete(documentId);
    }
  })();

  inFlight.set(documentId, probe);
  return probe;
}
