/**
 * BridgingConceptsPanel — "Connect the dots".
 *
 * Side dialog shown from the Alati / AI menu. Posts the full note content
 * + the note's active research-context collection IDs to the backend,
 * which extracts entities and intersects them with the user's OTHER
 * collections via Neo4j. The result is a ranked list of entities that
 * bridge this note to adjacent knowledge the user has but did not point
 * to.
 *
 * Contract with the backend:
 *   POST /api/v1/notes/assistant/connect-dots
 *     body = { note_text, exclude_collection_ids, top_k }
 *     resp = { success, entities_extracted, bridging_concepts[], message }
 *
 *   `message` is a machine-readable status — not a user-facing string:
 *     "ok" | "empty_note" | "no_entities_found"
 *       | "entity_extraction_failed" | "graph_query_failed"
 *
 * We translate the status to locale strings and render the appropriate
 * empty-state. Shipping above z-[10050] so it stacks above the notes
 * drawer portal (same convention as NotesOpenDialog / TemplateGallery).
 */

import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Layers, RefreshCw, Sparkles, SearchX, BookOpen } from 'lucide-react';
import { cn } from '@/lib/utils';
import { toast } from '@/lib/toast-compat';
import {
  connectNoteDots,
  type BridgingConcept,
  type ConnectDotsResponse,
} from '@/lib/api-notes-assistant';

interface BridgingConceptsPanelProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Raw HTML body of the current note. */
  noteText: string;
  /** Collections already in the note's active research context — their
   *  mentions don't count as bridges. */
  excludeCollectionIds: string[];
}

export const BridgingConceptsPanel: React.FC<BridgingConceptsPanelProps> = ({
  open,
  onOpenChange,
  noteText,
  excludeCollectionIds,
}) => {
  const { t } = useTranslation();
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<ConnectDotsResponse | null>(null);

  const run = useCallback(async () => {
    setLoading(true);
    try {
      const res = await connectNoteDots(noteText, excludeCollectionIds, 8);
      setResult(res);
    } catch (err) {
      console.error('[BridgingConceptsPanel] connectNoteDots failed:', err);
      toast({
        title: t('notes.connectDots.toastError.title', 'Connection lookup failed'),
        description: t('notes.connectDots.toastError.description', 'Please try again in a few seconds.'),
        variant: 'destructive',
      });
      setResult({
        success: false,
        entities_extracted: 0,
        bridging_concepts: [],
        message: 'graph_query_failed',
      });
    } finally {
      setLoading(false);
    }
  }, [noteText, excludeCollectionIds, t]);

  // Fire the lookup once when the panel opens. Re-run on explicit refresh.
  useEffect(() => {
    if (!open) {
      // Reset state so a fresh open always shows the spinner, not stale data
      // from the previous note.
      setResult(null);
      return;
    }
    void run();
  // eslint-disable-next-line react-hooks/exhaustive-deps -- intentionally fire only on open flip
  }, [open]);

  const renderEmpty = () => {
    const status = result?.message ?? 'empty';
    const copy = (() => {
      switch (status) {
        case 'empty_note':
          return t('notes.connectDots.emptyNote', 'The note is empty — add some content and try again.');
        case 'no_entities_found':
          return t('notes.connectDots.noEntitiesFound', 'No entities extracted from the note.');
        case 'entity_extraction_failed':
          return t('notes.connectDots.extractionFailed', 'Entity extraction failed. Try again in a minute.');
        case 'graph_query_failed':
          return t('notes.connectDots.graphQueryFailed', 'The knowledge graph query failed. Please try again.');
        default:
          return t('notes.connectDots.empty', 'This note has no visible links to your other collections.');
      }
    })();
    return (
      <div className='flex flex-col items-center justify-center py-12 px-6 text-center gap-3'>
        <SearchX className='h-10 w-10 text-muted-foreground/40' />
        <p className='text-sm text-muted-foreground max-w-sm'>{copy}</p>
      </div>
    );
  };

  const renderConcept = (c: BridgingConcept) => (
    <div
      key={c.entity}
      data-testid={`bridging-concept-${c.entity}`}
      className='px-4 py-3 border-b border-border/60 last:border-b-0 hover:bg-accent/40 transition-colors'
    >
      <div className='flex items-start gap-3'>
        <div className='mt-0.5 shrink-0 h-8 w-8 flex items-center justify-center bg-primary/10 text-primary'>
          <Sparkles className='h-4 w-4' />
        </div>
        <div className='flex-1 min-w-0'>
          <div className='text-sm font-semibold text-foreground truncate'>{c.entity}</div>
          <div className='mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground tabular-nums'>
            <span>
              {t('notes.connectDots.statsCollections', '{{count}} collections', { count: c.collections.length })}
            </span>
            <span aria-hidden className='opacity-40'>·</span>
            <span>
              {t('notes.connectDots.statsChunks', '{{count}} passages', { count: c.total_chunks })}
            </span>
            <span aria-hidden className='opacity-40'>·</span>
            <span>
              {t('notes.connectDots.statsBooks', '{{count}} books', { count: c.total_books })}
            </span>
          </div>
          {/* Per-collection breakdown — kept visually subordinate to the
              entity line so the primary scan-pattern stays 'which entity
              bridges'. Each row: collection name + coverage pair. */}
          <ul className='mt-2 space-y-1'>
            {c.collections.map((cov) => (
              <li
                key={cov.collection_id}
                className='flex items-center gap-2 text-xs'
              >
                <BookOpen className='h-3 w-3 text-muted-foreground shrink-0' />
                <span className='text-foreground/80 truncate'>{cov.collection_name}</span>
                <span className='ml-auto text-muted-foreground tabular-nums shrink-0'>
                  {cov.chunk_count} / {cov.book_count}
                </span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );

  const hasResults = (result?.bridging_concepts?.length ?? 0) > 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        data-testid='bridging-concepts-panel'
        overlayZIndex='10050'
        disableFullscreenOnMobile
        className='w-[95vw] max-w-2xl max-h-[85vh] p-0 gap-0 flex flex-col'
      >
        <DialogHeader className='px-4 pt-4 pb-3 border-b border-border shrink-0'>
          <div className='flex items-center gap-2'>
            <Layers className='h-5 w-5 text-primary shrink-0' />
            <div className='flex-1 min-w-0'>
              <DialogTitle className='text-base font-semibold'>
                {t('notes.connectDots.title', 'Connect the dots')}
              </DialogTitle>
              <p className='mt-0.5 text-xs text-muted-foreground'>
                {t(
                  'notes.connectDots.subtitle',
                  'Entities in this note that also appear in your other collections.',
                )}
              </p>
            </div>
            <Button
              variant='ghost'
              size='icon'
              className='h-8 w-8 shrink-0'
              disabled={loading}
              onClick={() => void run()}
              data-testid='bridging-concepts-refresh'
              aria-label={t('notes.connectDots.refresh', 'Refresh')}
              title={t('notes.connectDots.refresh', 'Refresh')}
            >
              <RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} />
            </Button>
          </div>
        </DialogHeader>

        <div className='flex-1 min-h-0 sm:min-h-[320px] overflow-y-auto'>
          {loading ? (
            <div className='flex flex-col items-center justify-center h-full py-16 gap-3 text-muted-foreground'>
              <div className='h-6 w-6 border-2 border-muted-foreground/30 border-t-primary rounded-full animate-spin' />
              <span className='text-xs'>{t('notes.connectDots.loading', 'Looking for connections…')}</span>
            </div>
          ) : hasResults ? (
            result!.bridging_concepts.map(renderConcept)
          ) : (
            renderEmpty()
          )}
        </div>

        <div className='flex items-center justify-between px-4 py-2.5 border-t border-border shrink-0 text-xs text-muted-foreground'>
          <span data-testid='bridging-concepts-entity-count'>
            {result
              ? t('notes.connectDots.entitiesExtracted', 'Entities extracted: {{count}}', {
                  count: result.entities_extracted,
                })
              : '—'}
          </span>
          <Button
            type='button'
            variant='ghost'
            size='sm'
            className='h-7'
            onClick={() => onOpenChange(false)}
            data-testid='bridging-concepts-close'
          >
            {t('notes.connectDots.close', 'Close')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
};
