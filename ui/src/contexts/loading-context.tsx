import React, { createContext, ReactNode, useContext, useState } from 'react';

// Define the shape of the loading context
interface LoadingContextType {
  // General app loading state
  isLoading: boolean;
  setIsLoading: (loading: boolean) => void;

  // Document processing specific states
  isProcessingDocuments: boolean;
  setIsProcessingDocuments: (processing: boolean) => void;
  processingMessage: string;
  setProcessingMessage: (message: string) => void;
  processingProgress: number;
  setProcessingProgress: (progress: number) => void;

  // Helpers
  startDocumentProcessing: (initialMessage?: string) => void;
  updateDocumentProcessing: (progress: number, message: string) => void;
  finishDocumentProcessing: () => void;
}

// Create the context with a default value
const LoadingContext = createContext<LoadingContextType | undefined>(undefined);

// Export the hook for using the loading context
// eslint-disable-next-line react-refresh/only-export-components -- co-located with component for cohesion
export const useLoading = (): LoadingContextType => {
  const context = useContext(LoadingContext);
  if (!context) {
    // During HMR (hot module reload), context might be temporarily unavailable
    // Check if we're in development mode and provide a safe fallback
    if (import.meta.env.DEV) {
      console.warn('useLoading: LoadingContext not available (possibly during HMR). Using fallback values.');
      // Return a safe fallback during HMR to prevent crashes
      return {
        isLoading: false,
        setIsLoading: () => {},
        isProcessingDocuments: false,
        setIsProcessingDocuments: () => {},
        processingMessage: '',
        setProcessingMessage: () => {},
        processingProgress: 0,
        setProcessingProgress: () => {},
        startDocumentProcessing: () => {},
        updateDocumentProcessing: () => {},
        finishDocumentProcessing: () => {},
      } as LoadingContextType;
    }
    throw new Error('useLoading must be used within a LoadingProvider');
  }
  return context;
};

// Create provider component
interface LoadingProviderProps {
  children: ReactNode;
}

export const LoadingProvider: React.FC<LoadingProviderProps> = ({
  children,
}) => {
  // General app loading state
  const [isLoading, setIsLoading] = useState(false);

  // Document processing specific states
  const [isProcessingDocuments, setIsProcessingDocuments] = useState(false);
  const [processingMessage, setProcessingMessage] = useState('');
  const [processingProgress, setProcessingProgress] = useState(0);

  // Helper methods for document processing
  const startDocumentProcessing = (
    initialMessage = 'Processing document...'
  ) => {
    setIsProcessingDocuments(true);
    setProcessingMessage(initialMessage);
    setProcessingProgress(0);
  };

  const updateDocumentProcessing = (progress: number, message: string) => {
    setProcessingProgress(progress);
    setProcessingMessage(message);
  };

  const finishDocumentProcessing = () => {
    setIsProcessingDocuments(false);
    setProcessingMessage('');
    setProcessingProgress(0);
  };

  // Provide the loading context to children
  return (
    <LoadingContext.Provider
      value={{
        isLoading,
        setIsLoading,
        isProcessingDocuments,
        setIsProcessingDocuments,
        processingMessage,
        setProcessingMessage,
        processingProgress,
        setProcessingProgress,
        startDocumentProcessing,
        updateDocumentProcessing,
        finishDocumentProcessing,
      }}
    >
      {children}
    </LoadingContext.Provider>
  );
};
