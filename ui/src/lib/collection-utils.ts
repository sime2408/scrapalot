/**
 * Shared utility functions for knowledge/collection components.
 */

/**
 * Removes duplicate items from an array by their `id` property,
 * keeping the first occurrence of each ID.
 */
export function deduplicateById<T extends { id: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  return items.filter(item => {
    if (seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
}

/**
 * Returns true when a document is actively being processed or waiting
 * to be processed. Checks both the top-level `processing_status` field
 * and the nested `doc_metadata.status` field (used by synthetic entries).
 */
export function isDocumentInProgress(doc: { processing_status?: string; doc_metadata?: { status?: string } }): boolean {
  const processingStatus = doc.processing_status;
  const metadataStatus = doc.doc_metadata?.status;
  return processingStatus === 'processing' || processingStatus === 'pending' ||
         metadataStatus === 'processing' || metadataStatus === 'pending';
}

/**
 * Returns true when a document is specifically in the "pending" state
 * (queued but not yet actively processing). Checks both the top-level
 * `processing_status` field and the nested `doc_metadata.status` field.
 */
export function isDocumentPending(doc: { processing_status?: string; doc_metadata?: { status?: string } }): boolean {
  const processingStatus = doc.processing_status;
  const metadataStatus = doc.doc_metadata?.status;
  return processingStatus === 'pending' || metadataStatus === 'pending';
}
