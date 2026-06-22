/**
 * Export Dialog for document citations
 * Supports BibTeX, RIS, and CSV export formats with preview and download.
 */

import React, { useState, useEffect } from 'react';
import { Download, Copy, FileText, Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import type { ResolvedMetadata } from '@/lib/api-metadata';
import {
  toBibTeXBatch,
  toRISBatch,
  toCSV,
  toMarkdownCitations,
} from '@/lib/citation-formatter';
import { toast } from '@/lib/toast-compat';

type ExportFormat = 'bibtex' | 'ris' | 'csv' | 'markdown';

const EXPORT_FORMATS = [
  { id: 'bibtex' as ExportFormat, name: 'BibTeX (.bib)', ext: '.bib', mime: 'application/x-bibtex' },
  { id: 'ris' as ExportFormat, name: 'RIS (.ris)', ext: '.ris', mime: 'application/x-research-info-systems' },
  { id: 'csv' as ExportFormat, name: 'CSV (.csv)', ext: '.csv', mime: 'text/csv' },
  { id: 'markdown' as ExportFormat, name: 'Markdown (.md)', ext: '.md', mime: 'text/markdown' },
];

interface ExportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  metadata: ResolvedMetadata[];
  /** Optional filename prefix for the exported file */
  filenamePrefix?: string;
}

export const ExportDialog: React.FC<ExportDialogProps> = ({
  open,
  onOpenChange,
  metadata,
  filenamePrefix = 'scrapalot-export',
}) => {
  const { t } = useTranslation();
  const [format, setFormat] = useState<ExportFormat>('bibtex');
  const [preview, setPreview] = useState('');
  const [fullContent, setFullContent] = useState('');
  const [generating, setGenerating] = useState(false);

  // Generate preview and full content when format or metadata changes
  useEffect(() => {
    if (!open || metadata.length === 0) {
      setPreview('');
      setFullContent('');
      return;
    }

    let cancelled = false;
    const generate = async () => {
      setGenerating(true);
      try {
        let content: string;
        // Generate preview from first 3 entries
        const previewMetas = metadata.slice(0, 3);

        if (format === 'bibtex') {
          content = await toBibTeXBatch(metadata);
          const previewContent = await toBibTeXBatch(previewMetas);
          if (!cancelled) setPreview(previewContent);
        } else if (format === 'ris') {
          content = await toRISBatch(metadata);
          const previewContent = await toRISBatch(previewMetas);
          if (!cancelled) setPreview(previewContent);
        } else if (format === 'csv') {
          content = toCSV(metadata);
          const previewLines = content.split('\n').slice(0, 4).join('\n');
          if (!cancelled) setPreview(previewLines);
        } else {
          content = toMarkdownCitations(metadata);
          const previewContent = toMarkdownCitations(previewMetas);
          if (!cancelled) setPreview(previewContent);
        }

        if (!cancelled) setFullContent(content);
      } catch (error) {
        console.error('[ExportDialog] Failed to generate export:', error);
        if (!cancelled) {
          setPreview('');
          setFullContent('');
        }
      } finally {
        if (!cancelled) setGenerating(false);
      }
    };

    void generate();
    return () => { cancelled = true; };
  }, [open, format, metadata]);

  const handleDownload = () => {
    if (!fullContent) return;

    const formatInfo = EXPORT_FORMATS.find(f => f.id === format)!;
    const blob = new Blob([fullContent], { type: formatInfo.mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${filenamePrefix}${formatInfo.ext}`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    toast.success(t('knowledge.export.downloaded', 'File downloaded'));
  };

  const handleCopyToClipboard = async () => {
    if (!fullContent) return;

    try {
      await navigator.clipboard.writeText(fullContent);
      toast.success(t('knowledge.export.copied', 'Copied to clipboard'));
    } catch {
      toast.error(t('knowledge.export.copyFailed', 'Failed to copy'));
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        data-testid="export-dialog"
        className="sm:max-w-[560px]"
        overlayZIndex="1300"
        dialogOpen={open}
        onOpenChange={onOpenChange}
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FileText className="h-5 w-5" />
            {t('knowledge.export.title', 'Export Citations')}
          </DialogTitle>
          <DialogDescription className="flex items-center gap-2">
            {t('knowledge.export.description', 'Export document metadata in citation formats.')}
            <Badge variant="secondary" className="text-xs">
              {t('knowledge.export.count', '{{count}} documents', { count: metadata.length })}
            </Badge>
          </DialogDescription>
        </DialogHeader>

        {/* Format selector */}
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium">{t('knowledge.export.format', 'Format')}:</span>
          <Select value={format} onValueChange={v => setFormat(v as ExportFormat)}>
            <SelectTrigger className="w-[200px]" data-testid="export-format-select">
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="z-[1400]">
              {EXPORT_FORMATS.map(f => (
                <SelectItem key={f.id} value={f.id}>{f.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {/* Preview */}
        <div className="border border-border bg-muted/50 p-3 max-h-[300px] overflow-y-auto">
          <div className="text-xs font-medium text-muted-foreground mb-2">
            {t('knowledge.export.preview', 'Preview')}
            {metadata.length > 3 && (
              <span className="ml-1 text-muted-foreground/60">
                ({t('knowledge.export.showingFirst', 'showing first 3 of {{total}}', { total: metadata.length })})
              </span>
            )}
          </div>
          {generating ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : (
            <pre className="text-xs whitespace-pre-wrap font-mono leading-relaxed">
              {preview || t('knowledge.export.noData', 'No data to export')}
            </pre>
          )}
        </div>

        {/* Actions */}
        <div className="flex justify-end gap-2 pt-2">
          <Button
            variant="outline"
            onClick={handleCopyToClipboard}
            disabled={!fullContent || generating}
            data-testid="export-copy-button"
          >
            <Copy className="h-4 w-4 mr-2" />
            {t('knowledge.export.copyClipboard', 'Copy')}
          </Button>
          <Button
            onClick={handleDownload}
            disabled={!fullContent || generating}
            data-testid="export-download-button"
          >
            <Download className="h-4 w-4 mr-2" />
            {t('knowledge.export.download', 'Download')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
};
