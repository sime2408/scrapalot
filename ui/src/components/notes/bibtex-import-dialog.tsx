/**
 * BibTeX Import Dialog
 * Allows users to import citations from BibTeX text or .bib files into the notes editor.
 * Uses Citation.js to parse BibTeX → CSL-JSON → CitationMark marks.
 */

import React, { useState } from 'react';
import type { Editor } from '@tiptap/react';
import { FileUp, FileText, Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Checkbox } from '@/components/ui/checkbox';
import { toast } from '@/lib/toast-compat';
import {
  parseBibTeX,
  formatCitationShort,
  generateCitationKey,
} from '@/lib/citation-formatter';
import type { ResolvedMetadata } from '@/lib/api-metadata';

interface ParsedEntry {
  meta: ResolvedMetadata;
  key: string;
  selected: boolean;
}

interface BibTeXImportDialogProps {
  editor: Editor | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export const BibTeXImportDialog: React.FC<BibTeXImportDialogProps> = ({
  editor,
  open,
  onOpenChange,
}) => {
  const { t } = useTranslation();
  const [bibtexText, setBibtexText] = useState('');
  const [entries, setEntries] = useState<ParsedEntry[]>([]);
  const [isParsing, setIsParsing] = useState(false);
  const [isImporting, setIsImporting] = useState(false);
  const [parseError, setParseError] = useState('');

  const handleParse = async (text: string) => {
    if (!text.trim()) {
      setEntries([]);
      setParseError('');
      return;
    }

    setIsParsing(true);
    setParseError('');
    try {
      const metas = await parseBibTeX(text);
      if (metas.length === 0) {
        setParseError(t('notes.citation.noEntries', 'No valid BibTeX entries found'));
        setEntries([]);
      } else {
        setEntries(metas.map(meta => ({
          meta,
          key: generateCitationKey(meta),
          selected: true,
        })));
      }
    } catch (error) {
      console.error('[BibTeXImport] Parse error:', error);
      setParseError(t('notes.citation.parseError', 'Failed to parse BibTeX'));
      setEntries([]);
    } finally {
      setIsParsing(false);
    }
  };

  const handleImportAndCite = async () => {
    if (!editor) return;

    const selected = entries.filter(e => e.selected);
    if (selected.length === 0) return;

    setIsImporting(true);
    try {
      // Build citation marks for each selected entry
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- TipTap content nodes are loosely typed
      const contentNodes: any[] = [];

      for (const entry of selected) {
        const syntheticId = `bib-${entry.key}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const formattedShort = await formatCitationShort(entry.meta, 'apa');

        contentNodes.push({
          type: 'paragraph',
          content: [{
            type: 'text',
            text: formattedShort,
            marks: [{
              type: 'citationMark',
              attrs: {
                citationId: `cite-${syntheticId}`,
                documentId: syntheticId,
                formattedShort,
                style: 'apa',
                metadata: JSON.stringify(entry.meta),
              },
            }],
          }],
        });
      }

      editor.chain().focus().insertContent(contentNodes).run();

      toast.success(
        t('notes.citation.importSuccess', '{{count}} citations imported', { count: selected.length })
      );

      // Reset and close
      setBibtexText('');
      setEntries([]);
      setParseError('');
      onOpenChange(false);
    } catch (error) {
      console.error('[BibTeXImport] Import error:', error);
      toast.error(t('notes.citation.importFailed', 'Failed to import citations'));
    } finally {
      setIsImporting(false);
    }
  };

  const handleFileUpload = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.bib,.bibtex,.ris,.txt';

    input.onchange = async (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (!file) return;

      try {
        const text = await file.text();
        setBibtexText(text);
        await handleParse(text);
      } catch (error) {
        console.error('[BibTeXImport] File read error:', error);
        toast.error(t('notes.citation.parseError', 'Failed to parse BibTeX'));
      }
    };

    input.click();
  };

  const toggleEntry = (index: number) => {
    setEntries(prev => prev.map((e, i) =>
      i === index ? { ...e, selected: !e.selected } : e
    ));
  };

  const toggleAll = () => {
    const allSelected = entries.every(e => e.selected);
    setEntries(prev => prev.map(e => ({ ...e, selected: !allSelected })));
  };

  const selectedCount = entries.filter(e => e.selected).length;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        data-testid="bibtex-import-dialog"
        className="sm:max-w-[640px]"
        overlayZIndex="1300"
        dialogOpen={open}
        onOpenChange={onOpenChange}
      >
        <DialogHeader>
          <DialogTitle>
            {t('notes.citation.importBibtex', 'Import BibTeX')}
          </DialogTitle>
          <DialogDescription>
            {t('notes.citation.importBibtexDesc', 'Paste BibTeX entries or upload a .bib file to insert citations into your note.')}
          </DialogDescription>
        </DialogHeader>

        <Tabs defaultValue="paste" className="w-full">
          <TabsList className="grid w-full grid-cols-2 mb-4">
            <TabsTrigger value="paste">
              <FileText className="mr-2 h-4 w-4" />
              {t('notes.citation.pasteBibtex', 'Paste BibTeX')}
            </TabsTrigger>
            <TabsTrigger value="file">
              <FileUp className="mr-2 h-4 w-4" />
              {t('notes.citation.uploadBib', 'Upload .bib')}
            </TabsTrigger>
          </TabsList>

          <TabsContent value="paste" className="space-y-4">
            <Textarea
              data-testid="bibtex-paste-textarea"
              placeholder={'@article{Smith2023,\n  author = {John Smith},\n  title = {Example Paper},\n  journal = {Nature},\n  year = {2023}\n}'}
              value={bibtexText}
              onChange={(e) => setBibtexText(e.target.value)}
              className="min-h-[180px] font-mono text-sm"
              disabled={isParsing || isImporting}
            />
            <div className="flex justify-end">
              <Button
                variant="outline"
                onClick={() => handleParse(bibtexText)}
                disabled={isParsing || !bibtexText.trim()}
              >
                {isParsing ? (
                  <><Loader2 className="h-4 w-4 mr-2 animate-spin" /> Parsing...</>
                ) : (
                  t('notes.citation.parseBibtex', 'Parse')
                )}
              </Button>
            </div>
          </TabsContent>

          <TabsContent value="file" className="space-y-4">
            <div className="flex flex-col items-center justify-center py-8 space-y-4">
              <div className="rounded-full bg-muted p-4">
                <FileUp className="h-8 w-8 text-muted-foreground" />
              </div>
              <p className="text-sm text-muted-foreground">
                .bib, .bibtex, .ris, .txt
              </p>
              <Button
                data-testid="bibtex-file-input"
                onClick={handleFileUpload}
                disabled={isParsing || isImporting}
              >
                <FileUp className="mr-2 h-4 w-4" />
                {t('notes.citation.uploadBib', 'Upload .bib')}
              </Button>
            </div>
          </TabsContent>
        </Tabs>

        {/* Parse error */}
        {parseError && (
          <p className="text-sm text-destructive">{parseError}</p>
        )}

        {/* Preview table */}
        {entries.length > 0 && (
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium">
                {t('notes.citation.entriesFound', '{{count}} entries found', { count: entries.length })}
              </span>
              <Button variant="ghost" size="sm" onClick={toggleAll}>
                {entries.every(e => e.selected) ? 'Deselect all' : 'Select all'}
              </Button>
            </div>
            <div
              data-testid="bibtex-preview-table"
              className="border border-border max-h-[200px] overflow-y-auto"
            >
              {entries.map((entry, i) => (
                <div
                  key={`${entry.key}-${i}`}
                  className="flex items-start gap-3 px-3 py-2 border-b border-border last:border-b-0 hover:bg-muted/50"
                >
                  <Checkbox
                    data-testid={`bibtex-entry-checkbox-${i}`}
                    checked={entry.selected}
                    onCheckedChange={() => toggleEntry(i)}
                    className="mt-0.5"
                  />
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium truncate">
                      {entry.meta.title}
                    </div>
                    <div className="text-xs text-muted-foreground truncate">
                      {(entry.meta.authors || []).join(', ')}
                      {entry.meta.year ? ` (${entry.meta.year})` : ''}
                      {' · '}
                      <span className="font-mono">{entry.key}</span>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Import button */}
        {entries.length > 0 && (
          <div className="flex justify-end gap-2 pt-2">
            <Button
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={isImporting}
            >
              {t('common.cancel', 'Cancel')}
            </Button>
            <Button
              data-testid="bibtex-import-button"
              onClick={handleImportAndCite}
              disabled={isImporting || selectedCount === 0}
            >
              {isImporting ? (
                <><Loader2 className="h-4 w-4 mr-2 animate-spin" /> Importing...</>
              ) : (
                t('notes.citation.importAndCite', 'Import & Cite ({{count}})', { count: selectedCount })
              )}
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
};
