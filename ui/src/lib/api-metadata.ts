/**
 * Metadata enrichment API client.
 * Resolves DOI/ISBN/PMID/arXiv identifiers to full academic metadata.
 */

import { apiClient, authState } from '@/lib/api';

/** Structured creator with role */
export interface Creator {
  first_name: string;
  last_name: string;
  role: 'author' | 'editor' | 'contributor' | 'translator' | 'book_author';
}

export interface ResolvedMetadata {
  title?: string;
  authors?: string[];
  creators?: Creator[];
  year?: number;
  journal?: string;
  volume?: string;
  issue?: string;
  pages?: string;
  abstract?: string;
  doi?: string;
  isbn?: string;
  pmid?: string;
  arxiv_id?: string;
  url?: string;
  publisher?: string;
  document_type?: string;
  language?: string;
  issn?: string;
  source?: string;
  confidence?: number;
}

export interface EnrichmentResult {
  success: boolean;
  enrichment_status: string;
  metadata?: ResolvedMetadata;
  message?: string;
}

export interface DocumentMetadata {
  identifiers?: {
    doi?: string;
    isbn?: string;
    pmid?: string;
    arxiv_id?: string;
  };
  resolved?: ResolvedMetadata;
  enrichment_status?: string;
  enriched_at?: string;
}

/** Trigger metadata enrichment for a document */
export async function enrichDocumentMetadata(
  documentId: string,
  forceRefresh: boolean = false
): Promise<EnrichmentResult> {
  await authState.waitForAuthReady();
  const { data } = await apiClient.post<EnrichmentResult>(
    `/documents/${documentId}/enrich`,
    { force_refresh: forceRefresh }
  );
  return data;
}

/** Update document type */
export async function updateDocumentType(documentId: string, documentType: string): Promise<{ success: boolean; document_type: string; message: string }> {
  await authState.waitForAuthReady();
  const response = await apiClient.patch(`/documents/${documentId}/type`, { document_type: documentType });
  return response.data;
}

/** Get extracted metadata for a document (from existing document data) */
export function parseDocumentMetadata(extractedMetadata: string | Record<string, unknown> | null | undefined): DocumentMetadata | null {
  if (!extractedMetadata) return null;
  try {
    const meta = typeof extractedMetadata === 'string'
      ? JSON.parse(extractedMetadata)
      : extractedMetadata;
    return meta as DocumentMetadata;
  } catch {
    return null;
  }
}
