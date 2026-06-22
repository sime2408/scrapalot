/**
 * Citation Picker Dialog
 * Opens from /cite slash command to search documents and insert citation marks into the editor.
 */

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { Editor } from '@tiptap/react';
import { Search, BookOpen, Loader2, FileText, RefreshCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useCollections } from '@/contexts/collections-context';
import { getDocumentsByCollection } from '@/lib/api-documents';
import { mapWithConcurrency } from '@/lib/api-utils';
import { enrichDocumentMetadata, parseDocumentMetadata, type ResolvedMetadata } from '@/lib/api-metadata';
import {
  CITATION_STYLES,
  formatBibliographyEntry,
} from '@/lib/citation-formatter';
import { toast } from '@/lib/toast-compat';
import { cn } from '@/lib/utils';
import { useWorkspace } from '@/hooks/use-workspace';

interface DocumentWithMeta {
  id: string;
  title: string;
  filename: string;
  collection_id: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- backend returns mixed shapes
  extracted_metadata?: any;
  resolved?: ResolvedMetadata;
}

interface CitationPickerDialogProps {
  editor: Editor | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const STYLE_STORAGE_KEY = 'scrapalot_citation_style';

export const CitationPickerDialog: React.FC<CitationPickerDialogProps> = ({
  editor,
  open,
  onOpenChange,
}) => {
  const { t } = useTranslation();
  const { collections } = useCollections();
  const { currentWorkspace } = useWorkspace();

  const [searchQuery, setSearchQuery] = useState('');
  const [documents, setDocuments] = useState<DocumentWithMeta[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedDoc, setSelectedDoc] = useState<DocumentWithMeta | null>(null);
  const [selectedStyle, setSelectedStyle] = useState(() => {
    try {
      return localStorage.getItem(STYLE_STORAGE_KEY) || 'apa';
    } catch {
      return 'apa';
    }
  });
  const [preview, setPreview] = useState('');
  const [inserting, setInserting] = useState(false);
  const [enrichingDocId, setEnrichingDocId] = useState<string | null>(null);

  // Enrich metadata for a document, then refresh its entry in the list
  const handleEnrichMetadata = useCallback(async (docId: string) => {
    setEnrichingDocId(docId);
    try {
      const result = await enrichDocumentMetadata(docId);
      if (result?.metadata?.title) {
        setDocuments(prev => prev.map(d =>
          d.id === docId ? { ...d, extracted_metadata: { resolved: result.metadata }, resolved: result.metadata } : d
        ));
        toast.success(t('notes.citation.metadataEnriched', 'Metadata found'));
      } else {
        toast.info(t('notes.citation.metadataNotFound', 'No metadata found for this document'));
      }
    } catch {
      toast.error(t('notes.citation.metadataError', 'Failed to lookup metadata'));
    } finally {
      setEnrichingDocId(null);
    }
  }, [t]);

  // Save style preference
  useEffect(() => {
    try {
      localStorage.setItem(STYLE_STORAGE_KEY, selectedStyle);
    } catch {
      // Storage unavailable
    }
  }, [selectedStyle]);

  // Load documents from all collections when dialog opens
  useEffect(() => {
    if (!open || collections.length === 0) return;

    let cancelled = false;
    const loadDocuments = async () => {
      setLoading(true);
      try {
        const allDocs: DocumentWithMeta[] = [];
        // Load from all collections (first page, 50 per collection), capped
        // concurrency so a large workspace doesn't fire one parallel request
        // per collection and contend on the backend pool.
        const results = await mapWithConcurrency(collections, 6, col =>
          getDocumentsByCollection(col.id, 1, 50, currentWorkspace?.id)
            .catch(() => ({ documents: [], hasMore: false, total: 0 }))
        );
        for (const result of results) {
          if (result.documents) {
            for (const doc of result.documents) {
              const meta = parseDocumentMetadata(doc.extracted_metadata);
              allDocs.push({
                ...doc,
                resolved: meta?.resolved || undefined,
              });
            }
          }
        }
        if (!cancelled) {
          setDocuments(allDocs);
        }
      } catch (error) {
        console.error('[CitationPicker] Failed to load documents:', error);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    void loadDocuments();
    return () => { cancelled = true; };
  }, [open, collections, currentWorkspace?.id]);

  // Filter documents by search query, preferring those with metadata
  const filteredDocs = useMemo(() => {
    const query = searchQuery.toLowerCase().trim();
    const sorted = [...documents].sort((a, b) => {
      // Documents with resolved metadata come first
      const aHasMeta = a.resolved?.title ? 1 : 0;
      const bHasMeta = b.resolved?.title ? 1 : 0;
      return bHasMeta - aHasMeta;
    });

    if (!query) return sorted.slice(0, 50);

    return sorted.filter(doc => {
      const title = (doc.resolved?.title || doc.title || doc.filename || '').toLowerCase();
      const authors = (doc.resolved?.authors || []).join(' ').toLowerCase();
      const year = doc.resolved?.year ? String(doc.resolved.year) : '';
      const journal = (doc.resolved?.journal || '').toLowerCase();
      return title.includes(query) || authors.includes(query) || year.includes(query) || journal.includes(query);
    }).slice(0, 50);
  }, [documents, searchQuery]);

  // Update preview when selection changes
  useEffect(() => {
    if (!selectedDoc?.resolved) {
      setPreview('');
      return;
    }
    let cancelled = false;
    formatBibliographyEntry(selectedDoc.resolved, selectedStyle).then(result => {
      if (!cancelled) setPreview(result);
    });
    return () => { cancelled = true; };
  }, [selectedDoc, selectedStyle]);

  const handleInsertCitation = useCallback(async () => {
    if (!editor || !selectedDoc) return;

    const meta = selectedDoc.resolved;

    setInserting(true);
    try {
      const fallbackTitle = selectedDoc.title || selectedDoc.filename?.replace(/\.[^.]+$/, '') || 'Unknown';
      const title = meta?.title || fallbackTitle;
      const authorShort = meta?.authors?.length
        ? (meta.authors.length > 2
          ? `${meta.authors[0].split(',')[0]} et al.`
          : meta.authors.map(a => a.split(',')[0]).join(' & '))
        : null;
      const year = meta?.year;

      // Build source line: "— Author (Year), Title" or "— Title"
      const sourceParts = [];
      if (authorShort) sourceParts.push(authorShort);
      if (year) sourceParts.push(`(${year})`);
      sourceParts.push(title);
      const sourceLine = `— ${sourceParts.join(', ')}`;

      // Insert blockquote with placeholder + source attribution paragraph
      editor.chain()
        .focus()
        .insertContent([
          {
            type: 'blockquote',
            content: [{
              type: 'paragraph',
              content: [{
                type: 'text',
                text: t('notes.citation.quotePlaceholder', 'Type your quote here...'),
              }],
            }],
          },
          {
            type: 'paragraph',
            content: [{
              type: 'text',
              text: sourceLine,
              marks: [{
                type: 'citationMark',
                attrs: {
                  citationId: `cite-${selectedDoc.id}-${Date.now()}`,
                  documentId: selectedDoc.id,
                  formattedShort: authorShort && year ? `[${authorShort}, ${year}]` : `[${title}]`,
                  style: selectedStyle,
                  metadata: JSON.stringify({
                    title,
                    authors: meta?.authors,
                    year: meta?.year,
                    doi: meta?.doi,
                    filename: selectedDoc.filename,
                    collection_id: selectedDoc.collection_id,
                  }),
                },
              }],
            }],
          },
        ])
        .run();

      toast.success(t('notes.citation.inserted', 'Citation inserted'));
      onOpenChange(false);
      setSelectedDoc(null);
      setSearchQuery('');
    } catch (error) {
      console.error('[CitationPicker] Failed to insert citation:', error);
      toast.error(t('notes.citation.insertError', 'Failed to insert citation'));
    } finally {
      setInserting(false);
    }
  }, [editor, selectedDoc, selectedStyle, onOpenChange, t]);

  // Batch enrich all documents without metadata
  const [batchEnriching, setBatchEnriching] = useState(false);
  const docsWithoutMeta = useMemo(() => documents.filter(d => !d.resolved?.title), [documents]);

  const handleBatchEnrich = useCallback(async () => {
    if (docsWithoutMeta.length === 0) return;
    setBatchEnriching(true);
    let enriched = 0;
    // Process in batches of 3 to avoid overloading
    for (let i = 0; i < docsWithoutMeta.length; i += 3) {
      const batch = docsWithoutMeta.slice(i, i + 3);
      const results = await Promise.allSettled(
        batch.map(doc => enrichDocumentMetadata(doc.id))
      );
      for (let j = 0; j < results.length; j++) {
        const result = results[j];
        if (result.status === 'fulfilled' && result.value?.metadata?.title) {
          const docId = batch[j].id;
          const meta = result.value.metadata;
          setDocuments(prev => prev.map(d =>
            d.id === docId ? { ...d, extracted_metadata: { resolved: meta }, resolved: meta } : d
          ));
          enriched++;
        }
      }
    }
    setBatchEnriching(false);
    toast.success(t('notes.citation.batchEnrichDone', `Metadata found for ${enriched} of ${docsWithoutMeta.length} documents`));
  }, [docsWithoutMeta, t]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        data-testid="notes-citation-picker-dialog"
        className="sm:max-w-[640px] max-h-[80vh] flex flex-col"
        overlayZIndex="1800"
        dialogOpen={open}
        onOpenChange={onOpenChange}
      >
        <DialogHeader>
          <div className="flex items-center justify-between">
            <DialogTitle className="flex items-center gap-2">
              <BookOpen className="h-5 w-5" />
              {t('notes.citation.title', 'Insert Citation')}
            </DialogTitle>
            {docsWithoutMeta.length > 0 && (
              <Button
                variant="ghost"
                size="sm"
                onClick={handleBatchEnrich}
                disabled={batchEnriching}
                className="text-xs h-7"
              >
                {batchEnriching ? (
                  <Loader2 className="h-3 w-3 animate-spin mr-1" />
                ) : (
                  <RefreshCw className="h-3 w-3 mr-1" />
                )}
                {t('notes.citation.enrichAll', 'Enrich all')}
              </Button>
            )}
          </div>
          <DialogDescription>
            {t('notes.citation.description', 'Search your library to insert an academic citation.')}
          </DialogDescription>
        </DialogHeader>

        {/* Search and style selector */}
        <div className="flex gap-2">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              data-testid="citation-search-input"
              placeholder={t('notes.citation.searchPlaceholder', 'Search by title, author, year...')}
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              className="pl-9"
              autoFocus
            />
          </div>
          <Select value={selectedStyle} onValueChange={setSelectedStyle}>
            <SelectTrigger className="w-[160px]" data-testid="citation-style-select">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {CITATION_STYLES.map(s => (
                <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {/* Document list */}
        <div className="flex-1 min-h-0 overflow-y-auto border border-border">
          {loading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : filteredDocs.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
              <FileText className="h-8 w-8 mb-2" />
              <p className="text-sm">{t('notes.citation.noResults', 'No documents found')}</p>
            </div>
          ) : (
            <div className="divide-y divide-border">
              {filteredDocs.map(doc => {
                const meta = doc.resolved;
                const isSelected = selectedDoc?.id === doc.id;
                const hasMetadata = Boolean(meta?.title);

                return (
                  <div
                    key={doc.id}
                    data-testid={`citation-doc-${doc.id}`}
                    role="button"
                    tabIndex={0}
                    onClick={() => setSelectedDoc(doc)}
                    onKeyDown={(e) => { if (e.key === 'Enter') setSelectedDoc(doc); }}
                    className={cn(
                      'w-full text-left px-3 py-2 transition-colors cursor-pointer',
                      'hover:bg-accent hover:text-accent-foreground',
                      isSelected && 'bg-accent text-accent-foreground',
                      !hasMetadata && 'opacity-60'
                    )}
                  >
                    <div className="font-medium text-sm truncate">
                      {meta?.title || doc.title || doc.filename}
                    </div>
                    <div className="text-xs text-muted-foreground flex items-center gap-2 mt-0.5">
                      {meta?.authors && meta.authors.length > 0 && (
                        <span className="truncate max-w-[200px]">
                          {meta.authors.slice(0, 3).join(', ')}
                          {meta.authors.length > 3 ? ' et al.' : ''}
                        </span>
                      )}
                      {typeof meta?.year === 'number' && (
                        <span>{meta.year}</span>
                      )}
                      {meta?.journal && (
                        <span className="truncate max-w-[150px] italic">{meta.journal}</span>
                      )}
                      {!hasMetadata && (
                        <button
                          type="button"
                          className="inline-flex items-center gap-1 text-orange-500 dark:text-orange-400 hover:text-orange-600 dark:hover:text-orange-300 cursor-pointer bg-transparent border-0 p-0"
                          disabled={enrichingDocId === doc.id}
                          onClick={(e) => {
                            e.stopPropagation();
                            void handleEnrichMetadata(doc.id);
                          }}
                        >
                          {enrichingDocId === doc.id ? (
                            <Loader2 className="h-3 w-3 animate-spin" />
                          ) : (
                            <RefreshCw className="h-3 w-3" />
                          )}
                          {t('notes.citation.lookupMetadata', 'Lookup metadata')}
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Preview area */}
        {selectedDoc && preview && (
          <div className="border border-border bg-muted/50 p-3">
            <div className="text-xs font-medium text-muted-foreground mb-1">
              {t('notes.citation.preview', 'Preview')}
            </div>
            <p className="text-sm leading-relaxed">{preview}</p>
          </div>
        )}

        {/* Actions */}
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t('common.cancel', 'Cancel')}
          </Button>
          <Button
            data-testid="citation-insert-button"
            onClick={handleInsertCitation}
            disabled={!selectedDoc || inserting}
          >
            {inserting ? (
              <Loader2 className="h-4 w-4 animate-spin mr-2" />
            ) : (
              <BookOpen className="h-4 w-4 mr-2" />
            )}
            {t('notes.citation.insert', 'Insert Citation')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
};
