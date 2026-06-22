/**
 * Document quality rating API client.
 *
 * Star widget calls rateDocument() with rating=null to clear an existing
 * rating. Library view bulk-loads via getMyRatings(documentIds).
 */
import { apiClient } from '@/lib/api';

export interface UserDocumentRating {
  document_id: string;
  workspace_id: string;
  /** 1..5, or null if the user has no opinion. */
  rating: number | null;
  notes: string | null;
  rated_at: string | null;
  updated_at: string | null;
}

interface BatchResponse {
  ratings: UserDocumentRating[];
}

/** Upsert (or clear when rating=null) the current user's rating for a doc. */
export async function rateDocument(
  documentId: string,
  workspaceId: string,
  rating: number | null,
  notes?: string,
): Promise<UserDocumentRating> {
  const { data } = await apiClient.post('/document-ratings', {
    document_id: documentId,
    workspace_id: workspaceId,
    rating,
    notes: notes ?? null,
  });
  return data as UserDocumentRating;
}

/** Bulk-fetch the user's ratings for a list of documents. Returns only
 *  the documents the user has actually rated — unrated docs are absent
 *  from the response, callers should treat absence as "no rating yet".
 *
 *  POST + JSON body, not GET querystring: a Library prefetch hands
 *  ~800 ids to this function, which as a querystring overflows Spring
 *  Cloud Gateway's request-line buffer and surfaces as ERR_NETWORK. */
export async function getMyRatings(
  documentIds: string[],
): Promise<Map<string, UserDocumentRating>> {
  if (documentIds.length === 0) return new Map();
  const { data } = await apiClient.post('/document-ratings/batch', {
    document_ids: documentIds,
  });
  const out = new Map<string, UserDocumentRating>();
  const list = (data as BatchResponse)?.ratings || [];
  for (const r of list) out.set(r.document_id, r);
  return out;
}
