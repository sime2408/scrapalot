import React, { createContext, useContext, useReducer, ReactNode } from 'react';

interface DiscoveryItem {
  index: number; title: string; claim: string; summary: string;
  evidenceCount: number; confidence: number; category: string;
  novelty: string; sources: { url?: string; title?: string; doi?: string }[];
  tags: string[];
}

interface MarkdownViewerState {
  isOpen: boolean;
  markdownContent: string;
  title: string;
  planId?: string;
  qualityScore?: number;
  totalSources?: number;
  wordCount?: number;
  isOnLeft: boolean;
  discoveries?: DiscoveryItem[];
}

type MarkdownViewerAction =
  | {
      type: 'OPEN_MARKDOWN_VIEWER';
      payload: {
        content: string;
        title: string;
        planId?: string;
        qualityScore?: number;
        totalSources?: number;
        wordCount?: number;
        discoveries?: DiscoveryItem[];
      };
    }
  | { type: 'CLOSE_MARKDOWN_VIEWER' }
  | { type: 'SET_MARKDOWN_POSITION'; payload: { isOnLeft: boolean } };

const initialState: MarkdownViewerState = {
  isOpen: false,
  markdownContent: '',
  title: '',
  planId: undefined,
  qualityScore: undefined,
  totalSources: undefined,
  wordCount: undefined,
  isOnLeft: false,
};

function markdownViewerReducer(
  state: MarkdownViewerState,
  action: MarkdownViewerAction
): MarkdownViewerState {
  switch (action.type) {
    case 'OPEN_MARKDOWN_VIEWER':
      return {
        ...state,
        isOpen: true,
        markdownContent: action.payload.content,
        title: action.payload.title,
        planId: action.payload.planId,
        qualityScore: action.payload.qualityScore,
        totalSources: action.payload.totalSources,
        wordCount: action.payload.wordCount,
        discoveries: action.payload.discoveries,
      };
    case 'CLOSE_MARKDOWN_VIEWER':
      return {
        ...state,
        isOpen: false,
        isOnLeft: false,
      };
    case 'SET_MARKDOWN_POSITION':
      return {
        ...state,
        isOnLeft: action.payload.isOnLeft,
      };
    default:
      return state;
  }
}

interface MarkdownViewerContextType {
  state: MarkdownViewerState;
  dispatch: React.Dispatch<MarkdownViewerAction>;
}

const MarkdownViewerContext = createContext<MarkdownViewerContextType | undefined>(undefined);

export const MarkdownViewerProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const [state, dispatch] = useReducer(markdownViewerReducer, initialState);

  return (
    <MarkdownViewerContext.Provider value={{ state, dispatch }}>
      {children}
    </MarkdownViewerContext.Provider>
  );
};

// eslint-disable-next-line react-refresh/only-export-components -- co-located with component for cohesion
export const useMarkdownViewer = () => {
  const context = useContext(MarkdownViewerContext);
  if (context === undefined) {
    throw new Error('useMarkdownViewer must be used within a MarkdownViewerProvider');
  }
  return context;
};
