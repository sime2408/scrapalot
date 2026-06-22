/**
 * Highlight-to-Explain API — fast direct-LLM gloss on a passage the reader
 * highlighted in the PDF / EPUB / DOCX viewer. Routed via the gateway
 * `python-explain` entry directly to Python (`/api/v1/explain/selection`),
 * bypassing the heavier RAG pipeline to keep the reader responsive.
 */

import { apiClient } from '@/lib/api';

export type ExplainDepth = 'simple' | 'standard' | 'technical';

export type ExplainDetectedType =
  | 'math'
  | 'code'
  | 'foreign'
  | 'technical'
  | 'figure'
  | 'quote'
  | null;

export interface ExplainSelectionResponse {
  explanation: string;
  detected_type: ExplainDetectedType;
  error?: string;
}

export interface ExplainSelectionParams {
  text: string;
  language: string;
  depth?: ExplainDepth;
  contextBefore?: string;
  contextAfter?: string;
  documentTitle?: string;
}

export async function explainSelection(
  params: ExplainSelectionParams
): Promise<ExplainSelectionResponse> {
  const { data } = await apiClient.post<ExplainSelectionResponse>(
    '/explain/selection',
    {
      text: params.text,
      language: params.language,
      depth: params.depth ?? 'standard',
      context_before: params.contextBefore ?? '',
      context_after: params.contextAfter ?? '',
      document_title: params.documentTitle ?? '',
    },
    { headers: { 'x-skip-cache': 'true' } }
  );
  return data;
}

/* ==========================================================================
 * Highlight-to-Search — find passages in the user's library that match the
 * highlighted text. Backed by the existing pgvector retriever
 * (`skip_reranking=true` for fast round-trips).
 * ========================================================================== */

export interface SimilarPassage {
  document_id: string;
  document_title: string;
  snippet: string;
  page: number | null;
  chunk_index: number | null;
  file_type: 'pdf' | 'epub' | 'docx' | null;
  score: number | null;
}

export interface SimilarPassagesResponse {
  results: SimilarPassage[];
  error?: string;
}

export interface FindSimilarParams {
  text: string;
  userId: string;
  collectionIds: string[];
  /** Current document — excluded from results so the panel surfaces
   *  cross-source matches rather than the reader's own neighbours. */
  excludeDocumentId?: string;
  k?: number;
}

export async function findSimilarPassages(
  params: FindSimilarParams
): Promise<SimilarPassagesResponse> {
  const { data } = await apiClient.post<SimilarPassagesResponse>(
    '/explain/similar',
    {
      text: params.text,
      user_id: params.userId,
      collection_ids: params.collectionIds,
      exclude_document_id: params.excludeDocumentId,
      k: params.k ?? 10,
    },
    { headers: { 'x-skip-cache': 'true' } }
  );
  return data;
}
