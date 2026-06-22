import React, { createContext, useContext, useReducer, ReactNode } from 'react';

interface EpubViewerState {
  isOpen: boolean;
  epubUrl: string;
  documentId?: string; // Document ID extracted from URL for RAG chat
  documentTitle?: string; // Document title for display
  location?: string | number;
  citationId: number;
  collectionId?: string; // Collection ID for annotation support
  isOnLeft: boolean; // Track if EPUB is positioned on the left
}

type EpubViewerAction =
  | {
      type: 'OPEN_EPUB_VIEWER';
      payload: {
        url: string;
        documentId?: string; // Optional document ID for RAG chat
        documentTitle?: string; // Optional document title for display
        location?: string | number;
        citationId: number;
        collectionId?: string;
      };
    }
  | { type: 'CLOSE_EPUB_VIEWER' }
  | { type: 'UPDATE_LOCATION'; payload: { location: string | number } }
  | { type: 'SET_EPUB_POSITION'; payload: { isOnLeft: boolean } };

const initialState: EpubViewerState = {
  isOpen: false,
  epubUrl: '',
  documentId: undefined,
  documentTitle: undefined,
  collectionId: undefined,
  location: 0,
  citationId: -1,
  isOnLeft: false,
};

function epubViewerReducer(
  state: EpubViewerState,
  action: EpubViewerAction
): EpubViewerState {
  switch (action.type) {
    case 'OPEN_EPUB_VIEWER': {
      // Extract document ID from URL if not provided
      // URL format: /documents/{document_id}/file
      let documentId = action.payload.documentId;
      if (!documentId && action.payload.url) {
        const match = action.payload.url.match(/\/documents\/([^/]+)\/file/);
        if (match && match[1]) {
          documentId = match[1];
        }
      }

      return {
        ...state,
        isOpen: true,
        epubUrl: action.payload.url,
        documentId: documentId,
        documentTitle: action.payload.documentTitle,
        collectionId: action.payload.collectionId,
        location: action.payload.location, // Don't default to 0 - let drawer load from database
        citationId: action.payload.citationId,
      };
    }
    case 'CLOSE_EPUB_VIEWER':
      return {
        ...state,
        isOpen: false,
        isOnLeft: false, // Reset position when closing
      };
    case 'UPDATE_LOCATION':
      return {
        ...state,
        location: action.payload.location,
      };
    case 'SET_EPUB_POSITION':
      return {
        ...state,
        isOnLeft: action.payload.isOnLeft,
      };
    default:
      return state;
  }
}

interface EpubViewerContextType {
  state: EpubViewerState;
  dispatch: React.Dispatch<EpubViewerAction>;
}

const EpubViewerContext = createContext<EpubViewerContextType | undefined>(
  undefined
);

export function EpubViewerProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(epubViewerReducer, initialState);

  return (
    <EpubViewerContext.Provider value={{ state, dispatch }}>
      {children}
    </EpubViewerContext.Provider>
  );
}

// eslint-disable-next-line react-refresh/only-export-components -- co-located with component for cohesion
export function useEpubViewer() {
  const context = useContext(EpubViewerContext);
  if (context === undefined) {
    throw new Error('useEpubViewer must be used within an EpubViewerProvider');
  }
  return context;
}
