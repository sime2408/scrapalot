/**
 * Annotation Comment Search — full-text search across the user's
 * annotation comments. Backed by Postgres tsvector + GIN index
 * (Liquibase migration 110). Renders as a Radix Popover triggered
 * from the PDF viewer toolbar.
 *
 * Selection scrolls the host PDF viewer to the matching page when the
 * annotation belongs to the currently open document; matches in other
 * documents are navigable but not auto-opened (caller decides).
 */

import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Search, MessageSquare, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { searchAnnotationComments } from '@/lib/api-annotations';
import type { Annotation } from '@/types/annotations';
import { cn } from '@/lib/utils';

interface AnnotationCommentSearchProps {
  /** Currently open document — match badge is highlighted for in-doc results. */
  documentId?: string;
  /** Click handler for a search result. Receives the annotation. */
  onSelect?: (annotation: Annotation) => void;
  className?: string;
}

export function AnnotationCommentSearch({
  documentId,
  onSelect,
  className,
}: AnnotationCommentSearchProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Annotation[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Debounced search (250 ms) so we don't fire a request on every keystroke.
  useEffect(() => {
    if (!open) return;
    const trimmed = query.trim();
    if (trimmed.length < 2) {
      setResults([]);
      setError(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    const handle = window.setTimeout(async () => {
      try {
        const matches = await searchAnnotationComments(trimmed, 30);
        setResults(matches);
        setError(null);
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Search failed');
        setResults([]);
      } finally {
        setLoading(false);
      }
    }, 250);
    return () => window.clearTimeout(handle);
  }, [query, open]);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          data-testid="annotation-comment-search-trigger"
          type="button"
          size="icon"
          variant="ghost"
          className={cn('h-8 w-8 p-0 text-muted-foreground hover:text-primary', className)}
          aria-label={t('knowledge.annotations.search.trigger', 'Search annotation comments')}
          title={t('knowledge.annotations.search.trigger', 'Search annotation comments')}
        >
          <Search className="h-4 w-4" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        side="bottom"
        align="end"
        collisionPadding={8}
        className="w-96 p-2 z-[1000000]"
        data-testid="annotation-comment-search-popover"
      >
        <div className="flex items-center gap-1.5 px-1.5 py-1 border border-border">
          <Search className="h-3.5 w-3.5 text-muted-foreground flex-shrink-0" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('knowledge.annotations.search.placeholder', 'Search your notes...')}
            className="flex-1 bg-transparent border-0 outline-none text-sm placeholder:text-muted-foreground"
            data-testid="annotation-comment-search-input"
          />
          {query && (
            <button
              type="button"
              onClick={() => setQuery('')}
              className="text-muted-foreground hover:text-foreground p-0.5"
              aria-label={t('knowledge.annotations.search.clear', 'Clear')}
              data-testid="annotation-comment-search-clear"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
        <div className="mt-2 max-h-72 overflow-y-auto" data-testid="annotation-comment-search-results">
          {loading && (
            <div className="text-xs text-muted-foreground px-2 py-3">
              {t('knowledge.annotations.search.loading', 'Searching...')}
            </div>
          )}
          {!loading && error && (
            <div className="text-xs text-destructive px-2 py-3">{error}</div>
          )}
          {!loading && !error && query.trim().length >= 2 && results.length === 0 && (
            <div className="text-xs text-muted-foreground px-2 py-3">
              {t('knowledge.annotations.search.empty', 'No matches')}
            </div>
          )}
          {!loading && results.length > 0 && (
            <ul className="divide-y divide-border">
              {results.map((ann) => {
                const inCurrentDoc = documentId && ann.document_id === documentId;
                return (
                  <li key={ann.id}>
                    <button
                      type="button"
                      data-testid={`annotation-comment-search-result-${ann.id}`}
                      onClick={() => {
                        onSelect?.(ann);
                        setOpen(false);
                      }}
                      className="w-full text-left px-2 py-1.5 hover:bg-accent flex items-start gap-2"
                    >
                      <span
                        className="w-2.5 h-2.5 mt-1 flex-shrink-0 border border-border"
                        style={{ backgroundColor: ann.color }}
                      />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-1.5 mb-0.5">
                          <MessageSquare className="h-3 w-3 text-muted-foreground flex-shrink-0" />
                          {ann.page_label && (
                            <span className="text-[10px] text-muted-foreground">
                              {t('knowledge.annotations.search.page', 'p.')}
                              {ann.page_label}
                            </span>
                          )}
                          {inCurrentDoc && (
                            <span className="text-[10px] text-primary uppercase tracking-wide">
                              {t('knowledge.annotations.search.thisDoc', 'this doc')}
                            </span>
                          )}
                        </div>
                        <div className="text-xs line-clamp-2">
                          {ann.comment || ''}
                        </div>
                        {ann.selected_text && (
                          <div className="text-[10px] text-muted-foreground line-clamp-1 mt-0.5">
                            "{ann.selected_text}"
                          </div>
                        )}
                      </div>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
