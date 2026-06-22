/**
 * Research Sidebar — collapsible panel alongside the Notes Editor.
 * Provides quick search, recent research, key entities, and citations library.
 */

import React, { useEffect, useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Search, BookOpen, Sparkles, FileText, Loader2, X, ArrowUpRight,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { inlineResearch, type ResearchResult } from '@/lib/api-notes-assistant';
import { getSessionResearchPlans, type ResearchPlan } from '@/lib/api-research';
import { useCollections } from '@/contexts/collections-context';

interface ResearchSidebarProps {
  open: boolean;
  onClose: () => void;
  sessionId?: string;
  onInsertText?: (text: string, citation?: { title: string; authors?: string[]; year?: string }) => void;
}

export function ResearchSidebar({ open, onClose, sessionId, onInsertText }: ResearchSidebarProps) {
  const { t } = useTranslation();
  const { collections } = useCollections();
  const [activeTab, setActiveTab] = useState<'search' | 'research' | 'citations'>('search');

  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<ResearchResult[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [recentPlans, setRecentPlans] = useState<ResearchPlan[]>([]);
  const [isLoadingPlans, setIsLoadingPlans] = useState(false);

  useEffect(() => {
    if (!open || !sessionId) return;
    let cancelled = false;
    setIsLoadingPlans(true);
    getSessionResearchPlans(sessionId)
      .then((plans) => { if (!cancelled) setRecentPlans(plans); })
      .catch(() => {})
      .finally(() => { if (!cancelled) setIsLoadingPlans(false); });
    return () => { cancelled = true; };
  }, [open, sessionId]);

  const handleSearch = useCallback(async () => {
    if (!searchQuery.trim()) return;
    setIsSearching(true);
    try {
      const collectionIds = collections.map(c => c.id);
      const response = await inlineResearch({
        query: searchQuery,
        collection_ids: collectionIds,
        max_library_results: 5,
        max_web_results: 3,
        include_web: true,
      });
      setSearchResults([...(response.library_results || []), ...(response.web_results || [])]);
    } catch {
      setSearchResults([]);
    } finally {
      setIsSearching(false);
    }
  }, [searchQuery, collections]);

  const handleInsert = useCallback((result: ResearchResult) => {
    if (onInsertText) {
      const citation = result.citation ? {
        title: result.citation.title || result.source_title,
        authors: result.citation.authors,
        year: result.citation.year,
      } : { title: result.source_title };
      onInsertText(result.snippet, citation);
    }
  }, [onInsertText]);

  if (!open) return null;

  const tabs = [
    { id: 'search' as const, label: t('notes.sidebar.search', 'Search'), icon: Search },
    { id: 'research' as const, label: t('notes.sidebar.research', 'Research'), icon: Sparkles },
    { id: 'citations' as const, label: t('notes.sidebar.citations', 'Citations'), icon: BookOpen },
  ];

  return (
    <div className="w-[280px] shrink-0 border-l border-border bg-background flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2.5 border-b border-border">
        <div className="flex items-center gap-2">
          <div className="w-5 h-5 flex items-center justify-center bg-primary/10">
            <BookOpen className="h-3 w-3 text-primary" />
          </div>
          <span className="text-[11px] font-semibold tracking-tight">{t('notes.sidebar.title', 'Research')}</span>
        </div>
        <button onClick={onClose} onMouseDown={(e) => e.preventDefault()} className="p-1 text-muted-foreground hover:text-foreground transition-colors">
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* Tabs */}
      <div className="flex border-b border-border relative">
        {tabs.map(tab => {
          const Icon = tab.icon;
          const isActive = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              onMouseDown={(e) => e.preventDefault()}
              className={cn(
                'flex-1 flex items-center justify-center gap-1.5 py-2.5 text-[10px] font-medium transition-all relative',
                isActive
                  ? 'text-primary'
                  : 'text-muted-foreground hover:text-foreground'
              )}
            >
              <Icon className="h-3 w-3" />
              {tab.label}
              {isActive && (
                <div className="absolute bottom-0 left-2 right-2 h-[2px] bg-primary" />
              )}
            </button>
          );
        })}
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto">
        {activeTab === 'search' && (
          <div className="p-3 space-y-3">
            {/* Search input */}
            <div className="relative">
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') void handleSearch(); }}
                placeholder={t('notes.sidebar.searchPlaceholder', 'Search your library...')}
                className="w-full text-[11px] bg-muted/40 border border-border pl-8 pr-3 py-2 focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary placeholder:text-muted-foreground/50 transition-colors"
              />
              <div className="absolute left-2.5 top-1/2 -translate-y-1/2">
                {isSearching
                  ? <Loader2 className="h-3.5 w-3.5 text-primary animate-spin" />
                  : <Search className="h-3.5 w-3.5 text-muted-foreground/50" />
                }
              </div>
            </div>

            {searchResults.length > 0 ? (
              <div className="space-y-1.5">
                {searchResults.map((result, i) => (
                  <ResultCard key={i} result={result} onInsert={() => handleInsert(result)} />
                ))}
              </div>
            ) : !isSearching && searchQuery ? (
              <EmptyState text={t('notes.sidebar.noResults', 'No results found')} />
            ) : !searchQuery ? (
              <EmptyState text={t('notes.sidebar.searchHint', 'Search across your uploaded documents and the web')} />
            ) : null}
          </div>
        )}

        {activeTab === 'research' && (
          <div className="p-3 space-y-2">
            {isLoadingPlans ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
              </div>
            ) : recentPlans.length === 0 ? (
              <EmptyState text={t('notes.sidebar.noResearch', 'Run Deep Research from Chat to see findings here')} />
            ) : (
              recentPlans.map((plan) => (
                <div key={plan.id} className="border border-border/60 hover:border-border transition-colors overflow-hidden group">
                  <div className="h-[2px] bg-gradient-to-r from-primary/40 to-transparent" />
                  <div className="px-3 py-2.5">
                    <p className="text-[11px] font-medium line-clamp-2 leading-snug group-hover:text-primary transition-colors">{plan.query}</p>
                    <div className="flex items-center gap-2 mt-1.5">
                      <span className="text-[9px] px-1.5 py-px bg-muted text-muted-foreground">{plan.methodology}</span>
                      <span className={cn(
                        'text-[9px] px-1.5 py-px',
                        plan.status === 'completed' ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground',
                      )}>
                        {plan.status}
                      </span>
                    </div>
                  </div>
                </div>
              ))
            )}
          </div>
        )}

        {activeTab === 'citations' && (
          <div className="p-3">
            <EmptyState text={t('notes.sidebar.citationsHint', 'Citations from your notes appear here. Use "Find Citation" in the selection toolbar to add citations.')} />
          </div>
        )}
      </div>
    </div>
  );
}


// eslint-disable-next-line react-refresh/only-export-components
function EmptyState({ text }: { text: string }) {
  return (
    <div className="flex flex-col items-center justify-center py-8 px-4">
      <div className="w-8 h-8 flex items-center justify-center bg-muted/50 mb-2">
        <Search className="h-3.5 w-3.5 text-muted-foreground/40" />
      </div>
      <p className="text-[10px] text-muted-foreground/60 text-center leading-relaxed">{text}</p>
    </div>
  );
}


// eslint-disable-next-line react-refresh/only-export-components
function ResultCard({ result, onInsert }: { result: ResearchResult; onInsert: () => void }) {
  return (
    <div className="border border-border/40 hover:border-border transition-all group overflow-hidden">
      <div className="px-3 py-2.5">
        <div className="flex items-start gap-2">
          <FileText className="h-3 w-3 text-muted-foreground/50 shrink-0 mt-0.5" />
          <p className="text-[10px] font-medium leading-tight line-clamp-1 group-hover:text-primary transition-colors">{result.source_title}</p>
        </div>
        <p className="text-[10px] text-muted-foreground leading-relaxed line-clamp-3 mt-1.5 pl-5">{result.snippet}</p>
        <div className="flex items-center justify-between mt-2 pl-5">
          <div className="flex items-center gap-1.5">
            <span className="px-1.5 py-px text-[8px] bg-muted/80 text-muted-foreground border border-border/30 uppercase tracking-wider">
              {result.source_type}
            </span>
            {result.chapter && (
              <span className="text-[8px] text-muted-foreground/60">{result.chapter}</span>
            )}
          </div>
          <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
            <button
              onClick={onInsert}
              onMouseDown={(e) => e.preventDefault()}
              className="px-2 py-0.5 text-[9px] font-medium bg-primary text-primary-foreground hover:bg-primary/90 transition-colors"
            >
              Insert
            </button>
            {result.url && (
              <a
                href={result.url}
                target="_blank"
                rel="noopener noreferrer"
                className="p-0.5 text-muted-foreground hover:text-foreground transition-colors"
                onMouseDown={(e) => e.preventDefault()}
              >
                <ArrowUpRight className="h-3 w-3" />
              </a>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
