/**
 * Annotation API client.
 * Annotations are stored in Kotlin backend (user-owned content).
 */

import { apiClient, authState } from '@/lib/api';
import type { Annotation, CreateAnnotationRequest, UpdateAnnotationRequest } from '@/types/annotations';

/** List annotations for a document */
export async function getDocumentAnnotations(documentId: string): Promise<Annotation[]> {
  await authState.waitForAuthReady();
  const { data } = await apiClient.get<Annotation[]>(`/documents/${documentId}/annotations`);
  return data;
}

/** Create a new annotation */
export async function createAnnotation(
  documentId: string,
  request: CreateAnnotationRequest
): Promise<Annotation> {
  await authState.waitForAuthReady();
  const { data } = await apiClient.post<Annotation>(
    `/documents/${documentId}/annotations`,
    request
  );
  return data;
}

/** Update an annotation (comment, color, pinned) */
export async function updateAnnotation(
  annotationId: string,
  request: UpdateAnnotationRequest
): Promise<Annotation> {
  await authState.waitForAuthReady();
  const { data } = await apiClient.put<Annotation>(`/annotations/${annotationId}`, request);
  return data;
}

/** Delete an annotation */
export async function deleteAnnotation(annotationId: string): Promise<void> {
  await authState.waitForAuthReady();
  await apiClient.delete(`/annotations/${annotationId}`);
}

/**
 * Workspace-level color → label map. Any workspace member may read; only
 * users with edit permission may write.
 */
export async function getAnnotationColorSemantics(
  workspaceId: string,
): Promise<Record<string, string>> {
  await authState.waitForAuthReady();
  const { data } = await apiClient.get<{ color_to_label: Record<string, string> }>(
    `/workspaces/${workspaceId}/annotation-color-semantics`,
  );
  return data.color_to_label || {};
}

export async function updateAnnotationColorSemantics(
  workspaceId: string,
  colorToLabel: Record<string, string>,
): Promise<Record<string, string>> {
  await authState.waitForAuthReady();
  const { data } = await apiClient.put<{ color_to_label: Record<string, string> }>(
    `/workspaces/${workspaceId}/annotation-color-semantics`,
    { color_to_label: colorToLabel },
  );
  return data.color_to_label || {};
}

/** Full-text search across the user's annotation comments (tsvector + GIN). */
export async function searchAnnotationComments(
  query: string,
  maxResults = 50,
): Promise<Annotation[]> {
  const trimmed = query.trim();
  if (!trimmed) return [];
  await authState.waitForAuthReady();
  const { data } = await apiClient.get<Annotation[]>('/annotations/search/comments', {
    params: { q: trimmed, maxResults },
  });
  return data;
}

// ─── Multi-user sharing ────────────────────────────────────────────────────

export interface AnnotationShare {
  annotation_id: string;
  shared_with_user_id: string;
  permission: 'read' | 'write';
  created_at: string;
}

export async function listAnnotationShares(annotationId: string): Promise<AnnotationShare[]> {
  await authState.waitForAuthReady();
  const { data } = await apiClient.get<AnnotationShare[]>(`/annotations/${annotationId}/shares`);
  return data;
}

export async function shareAnnotation(
  annotationId: string,
  sharedWithUserId: string,
  permission: 'read' | 'write' = 'read',
): Promise<AnnotationShare> {
  await authState.waitForAuthReady();
  const { data } = await apiClient.post<AnnotationShare>(
    `/annotations/${annotationId}/shares`,
    { shared_with_user_id: sharedWithUserId, permission }
  );
  return data;
}

export async function revokeAnnotationShare(
  annotationId: string,
  recipientUserId: string,
): Promise<void> {
  await authState.waitForAuthReady();
  await apiClient.delete(`/annotations/${annotationId}/shares/${recipientUserId}`);
}

export async function listAnnotationsSharedWithMe(): Promise<Annotation[]> {
  await authState.waitForAuthReady();
  const { data } = await apiClient.get<Annotation[]>('/annotations/shared-with-me');
  return data;
}

export interface AnnotationShareCandidate {
  user_id: string;
  email: string | null;
  username: string | null;
  workspace_role: string;
}

/** Workspace members eligible to receive a share for this annotation —
 *  the recipient must already have access to the workspace that owns
 *  the collection that owns the document. Backend at
 *  GET /annotations/{id}/share-candidates. */
export async function listAnnotationShareCandidates(annotationId: string): Promise<AnnotationShareCandidate[]> {
  await authState.waitForAuthReady();
  const { data } = await apiClient.get<AnnotationShareCandidate[]>(`/annotations/${annotationId}/share-candidates`);
  return data;
}

