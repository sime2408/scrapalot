/**
 * Research Results Panel
 *
 * Floating panel that shows inline research results from the user's
 * library and web when they select text and click "Research this".
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { BookOpen, Globe, Loader2, X } from 'lucide-react';
import { DraggablePanel, DragHandle } from './draggable-panel';
import { Editor } from '@tiptap/react';
import { Button } from '@/components/ui/button';
import { inlineResearch, type ResearchResult } from '@/lib/api-notes-assistant';
import { cleanSourceTitle } from '@/lib/source-title';
import { cn } from '@/lib/utils';

interface ResearchResultsPanelProps {
  editor: Editor;
  query: string;
  collectionIds: string[];
  position: { top: number; left: number };
  onClose: () => void;
}

export function ResearchResultsPanel({
  editor,
  query,
  collectionIds,
  position,
  onClose,
}: ResearchResultsPanelProps) {
  const { t } = useTranslation();
  const [loading, setLoading] = useState(true);
  const [libraryResults, setLibraryResults] = useState<ResearchResult[]>([]);
  const [webResults, setWebResults] = useState<ResearchResult[]>([]);
  const [durationMs, setDurationMs] = useState(0);
  const [error, setError] = useState('');

  // Stabilize collectionIds to prevent re-fetching when parent re-renders
  const collectionIdsRef = useRef(collectionIds);
  collectionIdsRef.current = collectionIds;
  const hasSearched = useRef(false);

  useEffect(() => {
    // Only search once per mount — query and collectionIds are fixed for this panel instance
    if (hasSearched.current) return;
    hasSearched.current = true;

    let cancelled = false;

    async function search() {
      setLoading(true);
      setError('');
      try {
        const result = await inlineResearch(query, collectionIdsRef.current);
        if (!cancelled) {
          setLibraryResults(result.library_results);
          setWebResults(result.web_results);
          setDurationMs(result.search_duration_ms);
        }
      } catch (err) {
        console.error('Inline research failed:', err);
        if (!cancelled) setError(t('notes.research_assistant.search_failed', 'Search failed. Please try again.'));
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void search();
    return () => { cancelled = true; };
  }, [query, t]);

  const handleInsert = useCallback(
    (result: ResearchResult) => {
      const quote = result.snippet.length > 300
        ? result.snippet.slice(0, 300) + '...'
        : result.snippet;

      const source = cleanSourceTitle(result.source_title);
      const page = result.page ? `, p.${result.page}` : '';
      const chapter = result.chapter ? `, ${result.chapter}` : '';

      editor
        .chain()
        .focus()
        .insertContent([
          {
            type: 'blockquote',
            content: [
              {
                type: 'paragraph',
                content: [{ type: 'text', text: `"${quote}"` }],
              },
            ],
          },
          {
            type: 'paragraph',
            content: [
              { type: 'text', text: `— ${source}${chapter}${page}` },
            ],
          },
        ])
        .run();
    },
    [editor]
  );

  const handleCiteOnly = useCallback(
    (result: ResearchResult) => {
      const citation = result.citation;
      if (!citation) return;

      const shortRef = citation.authors?.length
        ? `[${citation.authors[0].split(',')[0]}${citation.year ? `, ${citation.year}` : ''}]`
        : `[${cleanSourceTitle(result.source_title)}]`;

      editor
        .chain()
        .focus()
        .insertContent({ type: 'text', text: shortRef })
        .run();
    },
    [editor]
  );

  // Close on Escape
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  return (
    <DraggablePanel
      initialPosition={{ top: position.top, left: Math.min(position.left, window.innerWidth - 380) }}
      className="w-[380px] max-h-[400px]"
      onClickOutside={onClose}
    >
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-border">
        <span className="text-sm font-medium truncate min-w-0">
          {t('notes.research_assistant.research_results', 'Research')}: &quot;{query.slice(0, 40)}&quot;
        </span>
        <div className="flex items-center gap-0.5 shrink-0">
          <DragHandle />
          <Button variant="ghost" size="icon" className="h-6 w-6" onClick={onClose} aria-label={t('common.close', 'Close')}>
            <X className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto">
        {loading ? (
          <div className="flex flex-col items-center justify-center py-8 text-muted-foreground gap-2">
            <Loader2 className="h-4 w-4 animate-spin" />
            <span className="text-sm">{t('notes.research_assistant.searching', 'Searching...')}</span>
            <span className="text-xs text-muted-foreground/60">{t('notes.research_assistant.search_wait', 'Searching library and web...')}</span>
          </div>
        ) : error ? (
          <div className="py-8 text-center text-sm text-destructive px-3">
            {error}
          </div>
        ) : libraryResults.length === 0 && webResults.length === 0 ? (
          <div className="py-8 text-center text-muted-foreground text-sm">
            {t('notes.research_assistant.no_results', 'No results found')}
          </div>
        ) : (
          <div className="p-2 space-y-3">
            {/* Library Results */}
            {libraryResults.length > 0 && (
              <div>
                <div className="flex items-center gap-1.5 px-1 py-1 text-xs font-medium text-muted-foreground uppercase">
                  <BookOpen className="h-3 w-3" />
                  {t('notes.research_assistant.from_your_library', 'From Your Library')} ({libraryResults.length})
                </div>
                <div className="space-y-1.5">
                  {libraryResults.map((result, i) => (
                    <ResultCard
                      key={`lib-${i}`}
                      result={result}
                      onInsert={() => handleInsert(result)}
                      onCiteOnly={() => handleCiteOnly(result)}
                      t={t}
                    />
                  ))}
                </div>
              </div>
            )}

            {/* Web Results */}
            {webResults.length > 0 && (
              <div>
                <div className="flex items-center gap-1.5 px-1 py-1 text-xs font-medium text-muted-foreground uppercase">
                  <Globe className="h-3 w-3" />
                  {t('notes.research_assistant.from_web', 'From Web')} ({webResults.length})
                </div>
                <div className="space-y-1.5">
                  {webResults.map((result, i) => (
                    <ResultCard
                      key={`web-${i}`}
                      result={result}
                      onInsert={() => handleInsert(result)}
                      onCiteOnly={result.citation ? () => handleCiteOnly(result) : undefined}
                      onOpenLink={result.url ? () => window.open(result.url, '_blank') : undefined}
                      t={t}
                    />
                  ))}
                </div>
              </div>
            )}

            {/* Duration */}
            {durationMs > 0 && (
              <div className="text-xs text-muted-foreground text-center pt-1">
                {(durationMs / 1000).toFixed(1)}s
              </div>
            )}
          </div>
        )}
      </div>
    </DraggablePanel>
  );
}

function ResultCard({
  result,
  onInsert,
  onCiteOnly,
  onOpenLink,
  t,
}: {
  result: ResearchResult;
  onInsert: () => void;
  onCiteOnly?: () => void;
  onOpenLink?: () => void;
  t: (key: string, fallback?: string) => string;
}) {
  const snippet = result.snippet.length > 200
    ? result.snippet.slice(0, 200) + '...'
    : result.snippet;

  return (
    <div className="rounded-md border border-border bg-card p-2 text-sm">
      <div className="font-medium text-xs truncate" title={result.source_title}>{cleanSourceTitle(result.source_title)}</div>
      {(result.chapter || result.page) && (
        <div className="text-xs text-muted-foreground">
          {result.chapter}{result.chapter && result.page ? ', ' : ''}
          {result.page ? `p.${result.page}` : ''}
        </div>
      )}
      <p className="text-xs text-muted-foreground mt-1 line-clamp-3">{snippet}</p>

      {/* Relevance bar */}
      <div className="mt-1.5 flex items-center gap-2">
        <div className="flex-1 h-1 bg-muted rounded-full overflow-hidden">
          <div
            className={cn(
              'h-full rounded-full',
              result.relevance_score > 0.7
                ? 'bg-green-500'
                : result.relevance_score > 0.4
                  ? 'bg-yellow-500'
                  : 'bg-red-500'
            )}
            style={{ width: `${result.relevance_score * 100}%` }}
          />
        </div>
        <span className="text-[10px] text-muted-foreground w-8 text-right">
          {result.relevance_score.toFixed(2)}
        </span>
      </div>

      {/* Actions */}
      <div className="flex gap-1 mt-1.5">
        <Button variant="outline" size="sm" className="h-6 text-xs px-2" onClick={onInsert}>
          {t('notes.research_assistant.insert', 'Insert')}
        </Button>
        {onCiteOnly && (
          <Button variant="outline" size="sm" className="h-6 text-xs px-2" onClick={onCiteOnly}>
            {t('notes.research_assistant.cite_only', 'Cite Only')}
          </Button>
        )}
        {onOpenLink && (
          <Button variant="ghost" size="sm" className="h-6 text-xs px-2" onClick={onOpenLink}>
            {t('notes.research_assistant.open_link', 'Open')}
          </Button>
        )}
      </div>
    </div>
  );
}
