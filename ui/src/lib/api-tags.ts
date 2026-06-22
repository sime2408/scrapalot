/**
 * Tag API client — CRUD for document tags.
 * Tags are Python-owned, accessed via Kotlin gRPC proxy endpoints.
 */

import { api } from './api';

export interface Tag {
  id: string;
  name: string;
  color: string | null;
  position: number | null;
  doc_count?: number;
}

export interface DocumentTag {
  id: string;
  name: string;
  color: string | null;
  position: number | null;
}

/** List all tags for the current workspace. */
export async function listTags(workspaceId: string): Promise<Tag[]> {
  try {
    const response = await api.get('/tags', { params: { workspace_id: workspaceId } });
    return response.data ?? [];
  } catch (err) {
    console.error('Failed to list tags:', err);
    return [];
  }
}

/** Get tags for a specific document. */
export async function getDocumentTags(documentId: string): Promise<DocumentTag[]> {
  try {
    const response = await api.get(`/documents/${documentId}/tags`);
    return response.data ?? [];
  } catch (err) {
    console.error('Failed to get document tags:', err);
    return [];
  }
}

/** Tag a document. */
export async function tagDocument(documentId: string, tagId: string): Promise<boolean> {
  try {
    await api.post(`/documents/${documentId}/tags`, { tag_id: tagId });
    return true;
  } catch (err) {
    console.error('Failed to tag document:', err);
    return false;
  }
}

/** Untag a document. */
export async function untagDocument(documentId: string, tagId: string): Promise<boolean> {
  try {
    await api.delete(`/documents/${documentId}/tags/${tagId}`);
    return true;
  } catch (err) {
    console.error('Failed to untag document:', err);
    return false;
  }
}

