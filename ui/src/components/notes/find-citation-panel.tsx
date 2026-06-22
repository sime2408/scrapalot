/**
 * Find Citation Panel
 *
 * Shows citation search results from user's library and CrossRef
 * when they select text and click "Find Citation".
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { BookOpen, Download, ExternalLink, Globe, Loader2, Paperclip, Plus, Unlock, X } from 'lucide-react';
import { DraggablePanel, DragHandle } from './draggable-panel';
import { Editor } from '@tiptap/react';
import { Button } from '@/components/ui/button';
import { findCitation, type ResearchResult } from '@/lib/api-notes-assistant';
import { cleanSourceTitle } from '@/lib/source-title';
import { cn } from '@/lib/utils';
import type { TFunction } from 'i18next';

interface FindCitationPanelProps {
  editor: Editor;
  claimText: string;
  collectionIds: string[];
  position: { top: number; left: number };
  onClose: () => void;
}

export function FindCitationPanel({
  editor,
  claimText,
  collectionIds,
  position,
  onClose,
}: FindCitationPanelProps) {
  const { t } = useTranslation();
  const [loading, setLoading] = useState(true);
  const [libraryCitations, setLibraryCitations] = useState<ResearchResult[]>([]);
  const [academicCitations, setAcademicCitations] = useState<ResearchResult[]>([]);

  const collectionIdsRef = useRef(collectionIds);
  collectionIdsRef.current = collectionIds;
  const hasSearched = useRef(false);

  useEffect(() => {
    if (hasSearched.current) return;
    hasSearched.current = true;

    let cancelled = false;

    async function search() {
      try {
        const result = await findCitation(claimText, collectionIdsRef.current, true);
        if (cancelled) return;
        setLibraryCitations(result.library_citations ?? []);
        setAcademicCitations(result.academic_citations ?? []);
      } catch {
        // Silently fail — empty results shown
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void search();
    return () => { cancelled = true; };
  }, [claimText]);

  const insertCitation = useCallback((result: ResearchResult) => {
    const citation = result.citation;
    const label = citation
      ? `${citation.authors?.[0] ?? cleanSourceTitle(result.source_title)}${citation.year ? `, ${citation.year}` : ''}`
      : cleanSourceTitle(result.source_title);

    const { from, to } = editor.state.selection;
    const selectedText = editor.state.doc.textBetween(from, to, ' ');

    // Insert selected text with citation inline
    editor
      .chain()
      .focus()
      .insertContentAt(
        { from, to },
        `${selectedText} (${label})`
      )
      .run();

    onClose();
  }, [editor, onClose]);

  const insertAsFootnote = useCallback((result: ResearchResult) => {
    const citation = result.citation;
    const formatted = citation?.formatted_apa
      ?? `${cleanSourceTitle(result.source_title)}${citation?.year ? ` (${citation.year})` : ''}`;

    // Insert citation as blockquote below current position
    editor
      .chain()
      .focus()
      .insertContentAt(editor.state.selection.to, {
        type: 'blockquote',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: `📎 ${formatted}` }] }],
      })
      .run();

    onClose();
  }, [editor, onClose]);

  const totalResults = libraryCitations.length + academicCitations.length;

  const headerLabel = useMemo(() => {
    if (loading) return t('notes.assistant.findingCitations', 'Finding citations...');
    return t('notes.assistant.citationsFound', { count: totalResults, defaultValue: '{{count}} citations found' });
  }, [loading, totalResults, t]);

  return (
    <DraggablePanel
      initialPosition={{ top: position.top, left: Math.min(position.left, window.innerWidth - 400) }}
      className="w-[380px]"
      onClickOutside={onClose}
    >
      <div className="flex items-center justify-between px-3 py-2 border-b border-border">
        <span className="text-sm font-medium flex items-center gap-1.5 min-w-0">
          <BookOpen className="h-3.5 w-3.5 shrink-0" />
          <span className="truncate">{headerLabel}</span>
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
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : totalResults === 0 ? (
          <div className="py-6 text-center text-sm text-muted-foreground">
            {t('notes.assistant.noCitations', 'No citations found for this claim.')}
          </div>
        ) : (
          <div className="p-2 space-y-3">
            {libraryCitations.length > 0 && (
              <div>
                <div className="flex items-center gap-1.5 px-2 py-1 text-xs font-medium text-muted-foreground">
                  <BookOpen className="h-3 w-3" /> {t('notes.assistant.yourLibrary', 'Your Library')}
                </div>
                {libraryCitations.map((r, i) => (
                  <CitationItem key={`lib-${i}`} result={r} onInsertInline={insertCitation} onInsertFootnote={insertAsFootnote} t={t} />
                ))}
              </div>
            )}
            {academicCitations.length > 0 && (
              <div>
                <div className="flex items-center gap-1.5 px-2 py-1 text-xs font-medium text-muted-foreground">
                  <Globe className="h-3 w-3" /> {t('notes.assistant.academicSources', 'Academic sources (Crossref, OpenAlex, Semantic Scholar)')}
                </div>
                {academicCitations.map((r, i) => (
                  <CitationItem key={`acad-${i}`} result={r} onInsertInline={insertCitation} onInsertFootnote={insertAsFootnote} t={t} />
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </DraggablePanel>
  );
}

/**
 * Detect whether the backend's Unpaywall enrichment silently upgraded this
 * result's URL to a direct open-access PDF link.
 *
 * The Python servicer (`_to_proto_result` in notes_assistant_service.py)
 * prefers `oa_pdf_url` over the DOI landing page when Unpaywall resolves a
 * free legal copy — the change is transparent to existing clients. We
 * detect it by comparing `result.url` against the canonical DOI URL: if
 * they differ, Unpaywall has rewritten `url` to the OA PDF.
 */
function detectOpenAccessPdf(result: ResearchResult): string | null {
  const url = result.url?.trim();
  if (!url) return null;
  const doi = (result.citation?.doi ?? result.doi ?? '').trim();
  if (!doi) return null;
  const canonical = `https://doi.org/${doi}`.toLowerCase();
  if (url.toLowerCase() === canonical) return null;
  return url;
}

function CitationItem({
  result,
  onInsertInline,
  onInsertFootnote,
  t,
}: {
  result: ResearchResult;
  onInsertInline: (r: ResearchResult) => void;
  onInsertFootnote: (r: ResearchResult) => void;
  t: TFunction;
}) {
  const citation = result.citation;
  const title = citation?.title ?? cleanSourceTitle(result.source_title);
  const authors = citation?.authors?.join(', ') ?? '';
  const year = citation?.year ?? '';
  const doi = citation?.doi ?? result.doi;
  const oaPdfUrl = detectOpenAccessPdf(result);

  return (
    <div className="group px-2 py-2 hover:bg-accent/50 border border-transparent hover:border-border transition-colors">
      <div className="flex items-start gap-1.5">
        <div className="text-xs font-medium line-clamp-2 flex-1">{title}</div>
        {oaPdfUrl && (
          <span
            className="shrink-0 inline-flex items-center gap-0.5 text-[9px] font-medium px-1 py-0.5 bg-green-500/10 text-green-600 dark:text-green-400 border border-green-500/30"
            title={t('notes.assistant.openAccessTooltip', 'Free open-access PDF available via Unpaywall')}
          >
            <Unlock className="h-2.5 w-2.5" />
            OA
          </span>
        )}
      </div>
      {authors && <div className="text-[10px] text-muted-foreground mt-0.5 line-clamp-1">{authors}{year ? ` (${year})` : ''}</div>}
      {doi && (
        <div className="text-[10px] text-muted-foreground mt-0.5 flex items-center gap-1">
          <ExternalLink className="h-2.5 w-2.5" />
          {doi}
        </div>
      )}
      {result.snippet && <div className="text-[10px] text-muted-foreground mt-1 line-clamp-2 italic">{result.snippet}</div>}
      <div className={cn('flex flex-wrap gap-1 mt-1.5 opacity-0 group-hover:opacity-100 transition-opacity')}>
        <Button variant="outline" size="sm" className="h-6 text-[10px] px-2" onClick={() => onInsertInline(result)}>
          <Plus className="h-2.5 w-2.5 mr-1" /> {t('notes.assistant.inline', 'Inline')}
        </Button>
        <Button variant="outline" size="sm" className="h-6 text-[10px] px-2" onClick={() => onInsertFootnote(result)}>
          <Paperclip className="h-2.5 w-2.5 mr-1" /> {t('notes.assistant.footnote', 'Footnote')}
        </Button>
        {oaPdfUrl && (
          <Button
            variant="outline"
            size="sm"
            className="h-6 text-[10px] px-2 border-green-500/40 text-green-600 dark:text-green-400 hover:bg-green-500/10"
            onClick={() => window.open(oaPdfUrl, '_blank', 'noopener,noreferrer')}
          >
            <Download className="h-2.5 w-2.5 mr-1" /> {t('notes.assistant.downloadPdf', 'PDF')}
          </Button>
        )}
      </div>
    </div>
  );
}
