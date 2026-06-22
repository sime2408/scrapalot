/**
 * useOpenCitationInViewer — opens a citation in the correct viewer
 * (PDF / EPUB / DOCX) with precise-text highlight support.
 *
 * Shared between the inline chip in chat messages, the expandable Citati
 * list, and any other surface that needs "click citation → open source".
 *
 * Pattern mirrors the existing inline handler in chat-message.tsx for
 * consistency; pulled out here so the chip (which has no direct access to
 * citation URL context) can trigger the same flow with a minimal props
 * surface.
 */

import { useCallback } from 'react';
import { usePDFViewer } from '@/contexts/pdf-viewer-context';
import { useEpubViewer } from '@/contexts/epub-viewer-context';
import { useDocxViewer } from '@/contexts/docx-viewer-context';
import { toast } from '@/lib/toast-compat';
import { resolveFileType } from '@/lib/resolve-file-type';
import i18n from 'i18next';
import { probeDocumentFile } from '@/hooks/use-document-file-status';
import type { ChunkPositionJson } from '@/types/streaming-packets';

export interface OpenableCitation {
  citation_num?: number;
  citation_id?: number | string;
  id?: number | string;
  document_id?: string;
  documentId?: string;
  document_title?: string;
  title?: string;
  source?: string;
  url?: string;
  page?: number;
  page_number?: number;
  text?: string;
  content?: string;
  excerpt?: string;
  chunk_index?: number;
  file_type?: string;
  authors?: string[];
  year?: number;
  doi?: string;
  position_top_percent?: number;
  position_bottom_percent?: number;
  chunk_position_json?: ChunkPositionJson;
  // Bridge-mode metadata
  is_bridge?: boolean;
  source_collection_id?: string;
  bridge_anchors?: string[];
}

export function useOpenCitationInViewer() {
  const { dispatch: pdfDispatch } = usePDFViewer();
  const { dispatch: epubDispatch } = useEpubViewer();
  const { dispatch: docxDispatch } = useDocxViewer();

  return useCallback(async (citation: OpenableCitation) => {
    if (!citation) return;

    // External URL (web search citations) → open in new tab
    // noinspection HttpUrlsUsage — http:// is intentional: detecting any external URL, including non-TLS sources
    const externalUrl = [citation.url, citation.document_id, citation.documentId]
      .find(v => typeof v === 'string' && (v.startsWith('http://') || v.startsWith('https://')));
    if (externalUrl) {
      window.open(externalUrl, '_blank', 'noopener,noreferrer');
      return;
    }

    // Prefer document_id-based URL (works post-gRPC migration)
    const docId = citation.document_id || citation.documentId;
    let docUrl: string | undefined;
    if (docId) {
      docUrl = `/documents/${docId}/file`;
    } else if (citation.url) {
      docUrl = citation.url;
      if (docUrl.startsWith('/api/v1/')) docUrl = docUrl.substring(7);
    } else {
      console.warn('Citation has no valid URL or document_id:', citation);
      return;
    }

    // Extract document ID from citation or URL
    let documentIdForViewer = citation.document_id || citation.documentId;
    if (!documentIdForViewer && docUrl) {
      const match = docUrl.match(/\/documents\/([^/]+)\/file/);
      if (match && match[1]) documentIdForViewer = match[1];
    }

    // Refuse to open when the source file is known to be missing on disk.
    // The HEAD probe is cached, so repeat clicks don't re-hit the server.
    if (documentIdForViewer) {
      const fileStatus = await probeDocumentFile(documentIdForViewer);
      if (fileStatus === 'missing') {
        toast({
          title: i18n.t('smartCitations.fileMissing.title', 'Document file unavailable'),
          description: i18n.t(
            'smartCitations.fileMissing.description',
            'The source file for this citation is no longer on disk and cannot be opened.'
          ),
          variant: 'destructive',
        });
        return;
      }
    }

    // Record the citation click as a 'cited' touch event so the sidebar
    // Recent strip surfaces docs reached via chat citations. The viewer
    // useEffect will later add a pdf_open/epub_open/docx_open row with a
    // newer viewed_at, so the icon in the strip reflects the most recent
    // interaction. Citation rows still survive when no viewer follows
    // (e.g. unusual flows), keeping intent visible to the user.
    if (documentIdForViewer) {
      void (async () => {
        try {
          const { recordDocumentView } = await import('@/lib/api-document-views');
          await recordDocumentView(
            documentIdForViewer,
            'cited',
            citation.source_collection_id ?? null,
          );
        } catch {
          // recordDocumentView already logs; nothing more to do here.
        }
      })();
    }

    const documentTitle = citation.title || citation.document_title || citation.source || '';
    const citationId = citation.id || citation.citation_id || citation.citation_num || 0;

    // Resolve file type robustly. Looks at file_type → filename → title →
    // document_title → source → url, and uses a word-boundary anchor so
    // an extension anywhere in the string counts. See resolve-file-type.ts.
    const fileType = resolveFileType(citation);

    const highlightText = citation.text || citation.content || citation.excerpt;

    if (fileType === 'epub') {
      epubDispatch({
        type: 'OPEN_EPUB_VIEWER',
        payload: {
          url: docUrl,
          documentId: documentIdForViewer,
          documentTitle,
          citationId,
          // EPUB viewer uses highlightText to search iframe DOM and wrap in span
          highlightText,
        },
      });
    } else if (fileType === 'docx') {
      docxDispatch({
        type: 'OPEN_DOCX_VIEWER',
        payload: {
          url: docUrl,
          documentId: documentIdForViewer,
          documentTitle,
          citationId,
          highlightText,
        },
      });
    } else {
      // PDF (default) — compute highlight bar position from backend metadata
      // when available, otherwise estimate from chunk_index.
      let topPercent: number;
      let heightPercent: number;
      if (citation.position_top_percent !== undefined && citation.position_bottom_percent !== undefined) {
        topPercent = citation.position_top_percent;
        heightPercent = citation.position_bottom_percent - topPercent;
      } else {
        const chunkIndex = citation.chunk_index || 0;
        const pageTopMargin = 5;
        const pageContentHeight = 90;
        const estimatedChunksPerPage = 3;
        const chunkPositionOnPage = chunkIndex % estimatedChunksPerPage;
        const chunkHeightPercent = pageContentHeight / estimatedChunksPerPage;
        topPercent = pageTopMargin + (chunkPositionOnPage * chunkHeightPercent) - 3;
        heightPercent = chunkHeightPercent + 4;
      }

      const transientHighlight = citation.chunk_position_json
        ? {
            page: citation.chunk_position_json.page ?? citation.page ?? citation.page_number ?? 1,
            charOffsetStart: citation.chunk_position_json.char_offset_start,
            charOffsetEnd: citation.chunk_position_json.char_offset_end,
            bbox: citation.chunk_position_json.bbox ?? undefined,
            ttlSeconds: 3,
            issuedAt: Date.now(),
          }
        : undefined;

      pdfDispatch({
        type: 'OPEN_PDF_VIEWER',
        payload: {
          url: docUrl,
          documentId: documentIdForViewer,
          documentTitle,
          page: citation.page ?? citation.page_number ?? 1,
          citationId,
          highlightText,
          highlightLineStart: topPercent,
          highlightLineEnd: topPercent + heightPercent,
          transientHighlight,
        },
      });
    }
  }, [pdfDispatch, epubDispatch, docxDispatch]);
}
