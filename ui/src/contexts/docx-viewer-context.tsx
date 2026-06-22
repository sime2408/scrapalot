import React, { createContext, useContext, useReducer, ReactNode } from 'react';

interface DocxViewerState {
  isOpen: boolean;
  docxUrl: string;
  documentId?: string;
  documentTitle?: string;
  citationId: number;
  isOnLeft: boolean;
}

type DocxViewerAction =
  | {
      type: 'OPEN_DOCX_VIEWER';
      payload: {
        url: string;
        documentId?: string;
        documentTitle?: string;
        citationId: number;
      };
    }
  | { type: 'CLOSE_DOCX_VIEWER' }
  | { type: 'SET_DOCX_POSITION'; payload: { isOnLeft: boolean } };

const initialState: DocxViewerState = {
  isOpen: false,
  docxUrl: '',
  documentId: undefined,
  documentTitle: undefined,
  citationId: -1,
  isOnLeft: false,
};

function docxViewerReducer(
  state: DocxViewerState,
  action: DocxViewerAction
): DocxViewerState {
  switch (action.type) {
    case 'OPEN_DOCX_VIEWER': {
      // Extract document ID from URL if not provided
      let documentId = action.payload.documentId;
      if (!documentId && action.payload.url) {
        const match = action.payload.url.match(/\/documents\/([^/]+)\/file/);
        if (match && match[1]) {
          documentId = match[1];
          console.log('📄 [DocxViewer] Extracted documentId from URL:', documentId);
        }
      } else if (documentId) {
        console.log('📄 [DocxViewer] Using explicit documentId:', documentId);
      } else {
        console.warn('📄 [DocxViewer] No documentId available - URL:', action.payload.url);
      }

      return {
        ...state,
        isOpen: true,
        docxUrl: action.payload.url,
        documentId: documentId,
        documentTitle: action.payload.documentTitle,
        citationId: action.payload.citationId,
      };
    }
    case 'CLOSE_DOCX_VIEWER':
      return {
        ...state,
        isOpen: false,
        isOnLeft: false,
      };
    case 'SET_DOCX_POSITION':
      return {
        ...state,
        isOnLeft: action.payload.isOnLeft,
      };
    default:
      return state;
  }
}

interface DocxViewerContextType {
  state: DocxViewerState;
  dispatch: React.Dispatch<DocxViewerAction>;
}

const DocxViewerContext = createContext<DocxViewerContextType | undefined>(undefined);

export const DocxViewerProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const [state, dispatch] = useReducer(docxViewerReducer, initialState);

  return (
    <DocxViewerContext.Provider value={{ state, dispatch }}>
      {children}
    </DocxViewerContext.Provider>
  );
};

// eslint-disable-next-line react-refresh/only-export-components -- co-located with component for cohesion
export const useDocxViewer = () => {
  const context = useContext(DocxViewerContext);
  if (context === undefined) {
    throw new Error('useDocxViewer must be used within a DocxViewerProvider');
  }
  return context;
};
