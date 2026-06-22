/**
 * External Books API - Search and download books from Archive.org, Open Library, and LibGen
 */

import { apiClient, authState } from './api';

export type BookSource = 'archive_org' | 'open_library' | 'libgen' | 'gutenberg' | 'arxiv' | 'semantic_scholar' | 'google_scholar' | 'wikipedia' | 'scidb' | 'pubmed' | 'openalex';

export type SortBy = 'relevance' | 'year_desc' | 'year_asc' | 'title_asc' | 'title_desc' | 'author_asc' | 'author_desc';

export interface BookSearchResult {
  id: string;
  title: string;
  author: string | null;
  year: string | null;
  language: string | null;
  extension: string | null;
  size: string | null;
  source: BookSource;
  download_url: string | null;
  preview_url: string | null;
  cover_url: string | null;
  description: string | null;
  subjects: string[] | null;
  can_download: boolean;
}

export interface SearchBooksParams {
  query: string;
  sources?: BookSource[];
  limit?: number;
  page?: number;  // Page number (1-indexed)
  language?: string;
  file_type?: string;
  sort_by?: SortBy;  // Defaults to 'year_desc' (newest first)
}

export interface SearchBooksResponse {
  results: BookSearchResult[];
  total: number;  // Total number of results across all pages
  page: number;  // Current page number
  limit: number;  // Results per page
  has_more: boolean;  // Whether there are more results
}

export interface DownloadOnlyParams {
  book_id: string;
  source: BookSource;
  download_url: string;
  collection_id: string;
  title: string;
  extension?: string;
  cover_url?: string;
  author?: string;
  year?: string;
}

export interface DownloadOnlyResult {
  success: boolean;
  document_id?: string;
  message: string;
  file_path?: string;
}

/**
 * Search for books across external sources with pagination
 */
export async function searchBooks(params: SearchBooksParams): Promise<SearchBooksResponse> {
  await authState.waitForAuthReady();
  const response = await apiClient.post<SearchBooksResponse>('/external-books/search', {
    query: params.query,
    sources: params.sources,
    limit: params.limit || 20,
    page: params.page || 1,
    language: params.language,
    file_type: params.file_type,
    sort_by: params.sort_by || 'year_desc',  // Default to newest first
  });
  return response.data;
}

/**
 * Download a book without processing it
 * Creates a document record with 'pending' status for later processing
 */
export async function downloadBookOnly(params: DownloadOnlyParams): Promise<DownloadOnlyResult> {
  await authState.waitForAuthReady();
  const response = await apiClient.post<DownloadOnlyResult>('/external-books/download-only', {
    book_id: params.book_id,
    source: params.source,
    download_url: params.download_url,
    collection_id: params.collection_id,
    title: params.title,
    extension: params.extension || 'pdf',
    cover_url: params.cover_url,
    author: params.author,
    year: params.year,
  });
  return response.data;
}

/**
 * Re-download a file for an existing document from external sources.
 * The file is saved with the original filename/extension from the documents table.
 */
export interface RedownloadForDocumentParams {
  document_id: string;
  download_url: string;
  source: BookSource;
}

export interface RedownloadForDocumentResult {
  success: boolean;
  document_id?: string;
  message: string;
  file_path?: string;
}

export async function redownloadForDocument(params: RedownloadForDocumentParams): Promise<RedownloadForDocumentResult> {
  await authState.waitForAuthReady();
  const response = await apiClient.post<RedownloadForDocumentResult>('/external-books/redownload', {
    document_id: params.document_id,
    download_url: params.download_url,
    source: params.source,
  });
  return response.data;
}

/**
 * Preview a book temporarily without downloading to collection
 * File is stored in /tmp/ and auto-deleted after 1 hour
 */
export interface PreviewBookParams {
  book_id: string;
  source: BookSource;
  download_url: string;
  title: string;
  extension?: string;
}

export interface PreviewBookResult {
  success: boolean;
  preview_url: string;  // URL to access preview file
  temp_file_id: string;  // Temporary file identifier
  title: string;
  file_size_mb: number;
  expires_in: number;  // Seconds until expiration (3600 = 1 hour)
  message: string;
}

export async function previewBook(params: PreviewBookParams): Promise<PreviewBookResult> {
  await authState.waitForAuthReady();
  const response = await apiClient.post<PreviewBookResult>('/external-books/preview', {
    book_id: params.book_id,
    source: params.source,
    download_url: params.download_url,
    title: params.title,
    extension: params.extension || 'pdf',
  });
  return response.data;
}

