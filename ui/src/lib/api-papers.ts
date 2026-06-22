/**
 * Paper Generation API Client
 *
 * AI Scientist — generate formatted papers from research + notes.
 */

import { apiClient, authState } from '@/lib/api';

export interface PaperTemplate {
  key: string;
  name: string;
  section_titles: string[];
}

export interface GeneratePaperRequest {
  research_plan_id?: string;
  template_key: string;
  output_format: 'pdf' | 'docx' | 'markdown' | 'latex';
  synthesis_report?: string;
  notes_content?: string;
  discoveries_json?: string;
  author_name?: string;
  author_affiliation?: string;
  keywords?: string[];
  citation_style?: string;
  // Feature 8: Venue-specific section overrides
  section_overrides?: Array<{ key: string; title: string; custom_instructions: string }>;
}

// Feature 8: Venue-specific paper templates
export interface PaperVenue {
  key: string;
  name: string;
  group: 'journals' | 'conferences' | 'preprints' | string;
  base_template: string;
  citation_style: string;
  tone: string;
  word_limit: number | null;
  figure_limit?: number | null;
  section_overrides: Array<{ key: string; title: string; custom_instructions: string }>;
}

export interface GeneratePaperResponse {
  paper_id: string;
  title: string;
  status: 'completed' | 'processing' | 'failed';
  markdown_path: string;
  pdf_path: string;
  docx_path: string;
  total_sections: number;
  total_words: number;
  total_citations: number;
  error_message: string;
}

export async function generatePaper(
  request: GeneratePaperRequest
): Promise<GeneratePaperResponse> {
  await authState.waitForAuthReady();
  const { data } = await apiClient.post('/papers/generate', request);
  return data;
}

export async function listPaperTemplates(): Promise<PaperTemplate[]> {
  await authState.waitForAuthReady();
  const { data } = await apiClient.get('/papers/templates');
  return data;
}

export function getPaperDownloadUrl(paperId: string, format: string): string {
  return `/papers/${paperId}/download?format=${format}`;
}

export async function listPaperVenues(): Promise<PaperVenue[]> {
  await authState.waitForAuthReady();
  try {
    const { data } = await apiClient.get('/papers/venues');
    return data?.venues || [];
  } catch {
    return [];
  }
}
