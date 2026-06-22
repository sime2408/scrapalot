/**
 * SimilarPanel — sidebar / bottom sheet that surfaces passages from the
 * user's library similar to a passage they highlighted in the viewer.
 *
 * Backed by POST /api/v1/explain/similar — fast pgvector search with
 * `skip_reranking=true` so the list shows up in well under a second after
 * the embedding is computed.
 *
 * Clicking a result opens the source document in the matching viewer
 * (PDF / EPUB / DOCX) via `useOpenCitationInViewer`.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { Sheet, SheetContent, SheetTitle, SheetDescription } from '@/components/ui/sheet';
import { ExternalLink, Loader2, Library, RefreshCw } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useTranslation } from 'react-i18next';
import { useIsMobile } from '@/hooks/use-mobile';
import { useAuth } from '@/hooks/use-auth';
import { useCollections } from '@/contexts/collections-context';
import { useOpenCitationInViewer } from '@/hooks/use-open-citation-in-viewer';
import { findSimilarPassages, type SimilarPassage } from '@/lib/api-explain';

interface SimilarPanelProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  selectedText: string;
  /** The document the user is currently reading — excluded from results. */
  excludeDocumentId?: string;
}

export function SimilarPanel({
  open,
  onOpenChange,
  selectedText,
  excludeDocumentId,
}: SimilarPanelProps) {
  const { t } = useTranslation();
  const isMobile = useIsMobile();
  const { user } = useAuth();
  const { collections } = useCollections();
  const openCitation = useOpenCitationInViewer();

  const [results, setResults] = useState<SimilarPassage[]>([]);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string>('');

  const runSearch = useCallback(async () => {
    if (!selectedText.trim()) return;
    if (!user?.id) {
      setError(t('similar.errors.notSignedIn', 'Please sign in to search your library.'));
      return;
    }
    const collectionIds = collections.map(c => c.id).filter(Boolean);
    if (collectionIds.length === 0) {
      setError(t('similar.errors.noCollections', 'You have no collections with indexed documents yet.'));
      return;
    }
    setLoading(true);
    setError('');
    setResults([]);
    try {
      const resp = await findSimilarPassages({
        text: selectedText,
        userId: user.id,
        collectionIds,
        excludeDocumentId,
        k: 10,
      });
      if (resp.error) {
        setError(resp.error);
        return;
      }
      setResults(resp.results || []);
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    } finally {
      setLoading(false);
    }
  }, [selectedText, user?.id, collections, excludeDocumentId, t]);

  useEffect(() => {
    if (open && selectedText.trim()) {
      void runSearch();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- omits `runSearch`; re-running on runSearch identity changes would double-fetch
  }, [open, selectedText]);

  const handleOpenResult = useCallback((result: SimilarPassage) => {
    openCitation({
      document_id: result.document_id,
      document_title: result.document_title,
      page: result.page ?? undefined,
      text: result.snippet,
      chunk_index: result.chunk_index ?? undefined,
      file_type: result.file_type ?? undefined,
    });
    onOpenChange(false);
  }, [openCitation, onOpenChange]);

  const side = isMobile ? 'bottom' : 'right';

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side={side}
        data-testid="similar-panel"
        className={cn(
          'flex flex-col gap-0 p-0 border-border',
          isMobile
            ? 'h-[85vh] max-h-[85vh] rounded-t-none'
            : 'w-[460px] sm:max-w-[460px]'
        )}
        style={{ zIndex: 10010 }}
        hideCloseButton={false}
      >
        {/* Header */}
        <div className="flex items-start gap-3 px-5 pt-5 pb-3 border-b border-border">
          <div className="w-8 h-8 flex items-center justify-center bg-primary/10 text-primary flex-shrink-0">
            <Library className="w-4 h-4" />
          </div>
          <div className="flex-1 min-w-0 pr-8">
            <SheetTitle className="text-sm font-semibold leading-tight">
              {t('similar.title', 'Similar passages in your library')}
            </SheetTitle>
            <SheetDescription className="text-xs mt-0.5">
              {t('similar.subtitle', 'Cross-references from books and papers you own')}
            </SheetDescription>
          </div>
        </div>

        {/* Selection preview */}
        <div className="px-5 py-3 border-b border-border bg-muted/30">
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">
            {t('explain.selected', 'Selected')}
          </div>
          <blockquote
            data-testid="similar-selected-text"
            className="text-xs text-foreground border-l-2 border-primary/60 pl-2 line-clamp-3 italic"
          >
            {selectedText}
          </blockquote>
        </div>

        {/* Results list */}
        <div className="flex-1 min-h-0 overflow-y-auto px-3 py-3">
          {loading && (
            <div
              data-testid="similar-loading"
              className="flex items-center gap-2 text-xs text-muted-foreground px-2 py-3"
            >
              <Loader2 className="w-4 h-4 animate-spin" />
              {t('similar.loading', 'Searching your library…')}
            </div>
          )}

          {!loading && error && (
            <div
              data-testid="similar-error"
              className="text-xs text-destructive border border-destructive/40 bg-destructive/5 px-3 py-2 mx-2"
            >
              {error}
            </div>
          )}

          {!loading && !error && results.length === 0 && (
            <div className="text-xs text-muted-foreground px-2 py-3">
              {t('similar.empty', 'No similar passages found in your library.')}
            </div>
          )}

          {!loading && !error && results.length > 0 && (
            <ul className="flex flex-col gap-2" data-testid="similar-results">
              {results.map((r, idx) => (
                <li key={`${r.document_id}-${r.chunk_index ?? idx}`}>
                  <button
                    type="button"
                    data-testid={`similar-result-${idx}`}
                    onClick={() => handleOpenResult(r)}
                    className={cn(
                      'w-full text-left px-3 py-2.5 border border-border bg-card',
                      'hover:border-primary hover:bg-accent transition-colors',
                      'group flex flex-col gap-1.5 min-h-[72px]'
                    )}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <span className="text-[11px] font-medium text-foreground line-clamp-1 flex-1">
                        {r.document_title}
                      </span>
                      <ExternalLink className="w-3 h-3 text-muted-foreground flex-shrink-0 group-hover:text-primary transition-colors mt-0.5" />
                    </div>
                    <p className="text-xs text-muted-foreground line-clamp-3 leading-snug">
                      {r.snippet}
                    </p>
                    <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
                      {r.file_type && (
                        <span className="uppercase tracking-wider px-1 py-0.5 bg-muted border border-border">
                          {r.file_type}
                        </span>
                      )}
                      {typeof r.page === 'number' && (
                        <span>{t('similar.page', 'p.')} {r.page}</span>
                      )}
                      {typeof r.score === 'number' && (
                        <span className="ml-auto">
                          {Math.round(r.score * 100)}%
                        </span>
                      )}
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Footer */}
        <div className="border-t border-border px-5 py-3 flex items-center justify-between gap-2">
          <button
            type="button"
            data-testid="similar-regenerate"
            onClick={() => void runSearch()}
            disabled={loading || !selectedText.trim()}
            className={cn(
              'text-xs flex items-center gap-1.5 px-3 py-2 border border-border min-h-[40px]',
              'hover:bg-accent hover:text-accent-foreground transition-colors',
              (loading || !selectedText.trim()) && 'opacity-50 cursor-not-allowed'
            )}
          >
            <RefreshCw className={cn('w-3.5 h-3.5', loading && 'animate-spin')} />
            {t('explain.regenerate', 'Regenerate')}
          </button>
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            className="text-xs px-3 py-2 min-h-[40px] text-muted-foreground hover:text-foreground transition-colors"
          >
            {t('common.close', 'Close')}
          </button>
        </div>
      </SheetContent>
    </Sheet>
  );
}
