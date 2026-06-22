/**
 * Thin per-viewer wrappers that combine ErrorBoundary + context dispatch so
 * a crash inside one viewer (e.g. epub.js choking on a malformed `.epub`)
 * doesn't unmount the entire app tree. Without this, opening a corrupt
 * document silently closed the library view because the viewer threw
 * during render and React's default behaviour is to unmount up to the
 * nearest boundary — which previously didn't exist around the global
 * viewers.
 */

import React from 'react';
import { ErrorBoundary } from '@/components/error-boundary';
import { GlobalEpubViewer } from '@/components/knowledge/epub/global-epub-viewer';
import { GlobalPDFViewer } from '@/components/knowledge/pdf/global-pdf-viewer';
import { GlobalDocxViewer } from '@/components/knowledge/docx/global-docx-viewer';
const GlobalMarkdownViewer = (_props: any) => null;
import { useEpubViewer } from '@/contexts/epub-viewer-context';
import { usePDFViewer } from '@/contexts/pdf-viewer-context';
import { useDocxViewer } from '@/contexts/docx-viewer-context';
import { useMarkdownViewer } from '@/contexts/markdown-viewer-context';
import { toast } from '@/lib/toast-compat';
import { useTranslation } from 'react-i18next';

function useViewerErrorToast(viewerName: string): (err: Error) => void {
  const { t } = useTranslation();
  return React.useCallback(
    (err: Error) => {
      toast({
        title: t('knowledge.viewer.crashTitle', '{{viewer}} viewer error', { viewer: viewerName }),
        description: err.message || t('knowledge.viewer.crashDescription', 'The viewer crashed and was closed. Please try a different document.'),
        variant: 'destructive',
      });
    },
    [t, viewerName],
  );
}

export const SafeGlobalEpubViewer: React.FC = () => {
  const { dispatch } = useEpubViewer();
  const showToast = useViewerErrorToast('EPUB');
  return (
    <ErrorBoundary
      fallback={null}
      onError={(err) => {
        dispatch({ type: 'CLOSE_EPUB_VIEWER' });
        showToast(err);
      }}
    >
      <GlobalEpubViewer />
    </ErrorBoundary>
  );
};

export const SafeGlobalPDFViewer: React.FC = () => {
  const { dispatch } = usePDFViewer();
  const showToast = useViewerErrorToast('PDF');
  return (
    <ErrorBoundary
      fallback={null}
      onError={(err) => {
        dispatch({ type: 'CLOSE_PDF_VIEWER' });
        showToast(err);
      }}
    >
      <GlobalPDFViewer />
    </ErrorBoundary>
  );
};

export const SafeGlobalDocxViewer: React.FC = () => {
  const { dispatch } = useDocxViewer();
  const showToast = useViewerErrorToast('DOCX');
  return (
    <ErrorBoundary
      fallback={null}
      onError={(err) => {
        dispatch({ type: 'CLOSE_DOCX_VIEWER' });
        showToast(err);
      }}
    >
      <GlobalDocxViewer />
    </ErrorBoundary>
  );
};

export const SafeGlobalMarkdownViewer: React.FC = () => {
  const { dispatch } = useMarkdownViewer();
  const showToast = useViewerErrorToast('Markdown');
  return (
    <ErrorBoundary
      fallback={null}
      onError={(err) => {
        dispatch({ type: 'CLOSE_MARKDOWN_VIEWER' });
        showToast(err);
      }}
    >
      <GlobalMarkdownViewer />
    </ErrorBoundary>
  );
};
