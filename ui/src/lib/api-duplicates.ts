import { api } from './api';

export interface DuplicateMatch {
  document_id: string;
  filename: string;
  title: string;
  match_type: 'doi' | 'isbn' | 'title_fuzzy';
  confidence: number;
  matching_value: string;
}

export interface DuplicateGroup {
  canonical_id: string;
  duplicates: DuplicateMatch[];
}

/** Find duplicates for a specific document. */
export async function findDuplicates(documentId: string): Promise<DuplicateMatch[]> {
  try {
    const response = await api.get(`/documents/${documentId}/duplicates`);
    return response.data ?? [];
  } catch (err) {
    console.error('Failed to find duplicates:', err);
    return [];
  }
}

