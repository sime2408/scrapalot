import React, { createContext, useContext, useReducer, ReactNode } from 'react';

export interface TransientHighlightPayload {
  page: number;
  charOffsetStart?: number;
  charOffsetEnd?: number;
  bbox?: number[];
  ttlSeconds?: number;
  issuedAt: number;
}

interface PDFViewerState {
  isOpen: boolean;
  pdfUrl: string;
  documentId?: string; // Document ID extracted from URL for RAG chat
  documentTitle?: string; // The actual document title/filename
  citationPage?: number;
  citationId: number;
  highlightLineStart?: number; // Deprecated: Use highlightText instead
  highlightLineEnd?: number; // Deprecated: Use highlightText instead
  highlightText?: string; // The actual citation text to highlight
  collectionId?: string; // Collection ID for annotation support
  isOnLeft: boolean; // Track if PDF is positioned on the left
  isPreviewMode?: boolean; // Track if PDF is in preview mode (temporary, not saved)
  previewFileId?: string; // Temporary file ID for cleanup
  transientHighlight?: TransientHighlightPayload;
}

type PDFViewerAction =
  | {
      type: 'OPEN_PDF_VIEWER';
      payload: {
        url: string;
        documentId?: string; // Optional document ID for RAG chat
        documentTitle?: string; // Optional document title/filename
        page?: number;
        citationId: number;
        highlightLineStart?: number; // Deprecated: Use highlightText instead
        highlightLineEnd?: number; // Deprecated: Use highlightText instead
        highlightText?: string; // The actual citation text to highlight
        collectionId?: string; // Collection ID for annotations
        isPreviewMode?: boolean; // Preview mode flag
        previewFileId?: string; // Temporary file ID for cleanup
        transientHighlight?: TransientHighlightPayload;
      };
    }
  | { type: 'CLOSE_PDF_VIEWER' }
  | { type: 'CLEAR_TRANSIENT_HIGHLIGHT' }
  | { type: 'SET_PDF_POSITION'; payload: { isOnLeft: boolean } };

const initialState: PDFViewerState = {
  isOpen: false,
  pdfUrl: '',
  documentId: undefined,
  documentTitle: undefined,
  collectionId: undefined,
  citationPage: undefined, // undefined means use reading position, number means go to that page
  citationId: -1,
  highlightLineStart: 1,
  highlightLineEnd: 1,
  highlightText: undefined,
  isOnLeft: false,
  isPreviewMode: false,
  previewFileId: undefined,
};

function pdfViewerReducer(
  state: PDFViewerState,
  action: PDFViewerAction
): PDFViewerState {
  switch (action.type) {
    case 'OPEN_PDF_VIEWER': {
      // Extract document ID from URL if not provided
      // URL format: /documents/{document_id}/file
      let documentId = action.payload.documentId;
      if (!documentId && action.payload.url) {
        const match = action.payload.url.match(/\/documents\/([^/]+)\/file/);
        if (match && match[1]) {
          documentId = match[1];
          console.log('📄 [PDFViewer] Extracted documentId from URL:', documentId);
        }
      } else if (documentId) {
        console.log('📄 [PDFViewer] Using explicit documentId:', documentId);
      } else {
        console.warn('📄 [PDFViewer] No documentId available - URL:', action.payload.url);
      }

      return {
        ...state,
        isOpen: true,
        pdfUrl: action.payload.url,
        documentId: documentId,
        documentTitle: action.payload.documentTitle,
        citationPage: action.payload.page, // Keep undefined if not specified, so reading position can be loaded
        citationId: action.payload.citationId,
        highlightLineStart:
          action.payload.highlightLineStart || action.payload.citationId + 1,
        highlightLineEnd:
          action.payload.highlightLineEnd || action.payload.citationId + 1,
        highlightText: action.payload.highlightText,
        collectionId: action.payload.collectionId,
        isPreviewMode: action.payload.isPreviewMode || false,
        previewFileId: action.payload.previewFileId,
        transientHighlight: action.payload.transientHighlight,
      };
    }
    case 'CLOSE_PDF_VIEWER':
      return {
        ...state,
        isOpen: false,
        isOnLeft: false, // Reset position when closing
        transientHighlight: undefined,
      };
    case 'CLEAR_TRANSIENT_HIGHLIGHT':
      return { ...state, transientHighlight: undefined };
    case 'SET_PDF_POSITION':
      return {
        ...state,
        isOnLeft: action.payload.isOnLeft,
      };
    default:
      return state;
  }
}

interface PDFViewerContextType {
  state: PDFViewerState;
  dispatch: React.Dispatch<PDFViewerAction>;
}

const PDFViewerContext = createContext<PDFViewerContextType | undefined>(
  undefined
);

export function PDFViewerProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(pdfViewerReducer, initialState);

  return (
    <PDFViewerContext.Provider value={{ state, dispatch }}>
      {children}
    </PDFViewerContext.Provider>
  );
}

// eslint-disable-next-line react-refresh/only-export-components -- co-located with component for cohesion
export function usePDFViewer() {
  const context = useContext(PDFViewerContext);
  if (context === undefined) {
    throw new Error('usePDFViewer must be used within a PDFViewerProvider');
  }
  return context;
}
