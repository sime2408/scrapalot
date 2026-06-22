/**
 * Document relations API client.
 * Relations are Python-owned (scrapalot DB), accessed via gRPC proxy.
 */

import { api, clearCache } from './api';

export interface DocumentRelation {
  id: string;
  document_id: string;
  type: string; // CITES, EXTENDS, CONTRADICTS, REVIEWS, RELATED_TO, etc.
  note?: string;
  title?: string;
  created_at: string;
}

export interface RelationsResponse {
  outgoing: DocumentRelation[];
  incoming: DocumentRelation[];
}

export const RELATION_TYPES = [
  { value: 'CITES', label: 'Cites', color: 'text-blue-600', icon: 'quote' },
  { value: 'EXTENDS', label: 'Extends', color: 'text-green-600', icon: 'arrow-up-right' },
  { value: 'CONTRADICTS', label: 'Contradicts', color: 'text-red-600', icon: 'x-circle' },
  { value: 'REVIEWS', label: 'Reviews', color: 'text-purple-600', icon: 'eye' },
  { value: 'RELATED_TO', label: 'Related', color: 'text-zinc-500', icon: 'link' },
] as const;

export const RELATION_TYPE_LABELS: Record<string, string> = {
  CITES: 'Cites',
  CITED_BY: 'Cited by',
  EXTENDS: 'Extends',
  EXTENDED_BY: 'Extended by',
  CONTRADICTS: 'Contradicts',
  CONTRADICTED_BY: 'Contradicted by',
  REVIEWS: 'Reviews',
  REVIEWED_BY: 'Reviewed by',
  RELATED_TO: 'Related to',
};

export const RELATION_TYPE_COLORS: Record<string, string> = {
  CITES: '#2ea8e5',
  CITED_BY: '#2ea8e5',
  EXTENDS: '#5fb236',
  EXTENDED_BY: '#5fb236',
  CONTRADICTS: '#ff6666',
  CONTRADICTED_BY: '#ff6666',
  REVIEWS: '#a28ae5',
  REVIEWED_BY: '#a28ae5',
  RELATED_TO: '#aaaaaa',
};

/** List relations for a document (outgoing + incoming). Always skip cache. */
export async function listDocumentRelations(documentId: string): Promise<RelationsResponse> {
  try {
    const response = await api.get(`/documents/${documentId}/relations`, {
      headers: { 'x-skip-cache': 'true' },
    });
    const data = response.data ?? { outgoing: [], incoming: [] };
    const mapRel = (r: DocumentRelation & { relationship_type?: string }): DocumentRelation => ({ ...r, type: r.relationship_type || r.type });
    return {
      outgoing: (data.outgoing || []).map(mapRel),
      incoming: (data.incoming || []).map(mapRel),
    };
  } catch (err) {
    console.error('Failed to list document relations:', err);
    return { outgoing: [], incoming: [] };
  }
}

/** Create a document relation. */
export async function createDocumentRelation(
  sourceDocId: string,
  targetDocId: string,
  relationType: string,
  workspaceId: string,
  note?: string,
): Promise<DocumentRelation | null> {
  try {
    const response = await api.post(`/documents/${sourceDocId}/relations`, {
      target_document_id: targetDocId,
      relationship_type: relationType,
      workspace_id: workspaceId,
      note,
    });
    clearCache('/documents/collection/');
    return response.data;
  } catch (err) {
    console.error('Failed to create relation:', err);
    return null;
  }
}

/** Delete a document relation (sends body for backward compat with old Kotlin). */
export async function deleteDocumentRelation(
  relationId: string,
  sourceDocId?: string,
  targetDocId?: string,
  relationType?: string,
): Promise<boolean> {
  try {
    await api.delete(`/relations/${relationId}`, {
      data: sourceDocId ? {
        source_document_id: sourceDocId,
        target_document_id: targetDocId,
        relationship_type: relationType,
      } : undefined,
    });
    clearCache('/documents/collection/');
    return true;
  } catch (err) {
    console.error('Failed to delete relation:', err);
    return false;
  }
}
