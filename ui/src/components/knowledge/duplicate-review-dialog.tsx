/**
 * Duplicate review dialog — shows duplicate matches for a document or collection.
 * Allows merging duplicates (keep canonical, absorb duplicate metadata).
 */

import React, { useEffect, useState } from 'react';
import { AlertTriangle, ArrowRight, Loader2, Merge } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { findDuplicates, type DuplicateMatch } from '@/lib/api-duplicates';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';

interface DuplicateReviewDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  documentId: string;
  documentTitle: string;
  onMerged?: () => void;
}

const MATCH_LABELS: Record<string, { label: string; color: string }> = {
  doi: { label: 'DOI match', color: 'text-blue-600 bg-blue-50 dark:bg-blue-950/30' },
  isbn: { label: 'ISBN match', color: 'text-green-600 bg-green-50 dark:bg-green-950/30' },
  title_fuzzy: { label: 'Similar title', color: 'text-orange-600 bg-orange-50 dark:bg-orange-950/30' },
};

export function DuplicateReviewDialog({
  open,
  onOpenChange,
  documentId,
  documentTitle,
  onMerged,
}: DuplicateReviewDialogProps) {
  const { t } = useTranslation();
  const [duplicates, setDuplicates] = useState<DuplicateMatch[]>([]);
  const [loading, setLoading] = useState(false);
  const [merging, setMerging] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !documentId) return;
    setLoading(true);
    findDuplicates(documentId)
      .then(setDuplicates)
      .finally(() => setLoading(false));
  }, [open, documentId]);

  const handleMerge = async (duplicateId: string) => {
    setMerging(duplicateId);
    try {
      await api.post(`/documents/${documentId}/merge`, { duplicate_id: duplicateId });
      setDuplicates(prev => prev.filter(d => d.document_id !== duplicateId));
      onMerged?.();
    } catch (err) {
      console.error('Merge failed:', err);
    } finally {
      setMerging(null);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 text-orange-500" />
            {t('knowledge.duplicates.reviewTitle', 'Duplicate Review')}
          </DialogTitle>
          <DialogDescription className="truncate">
            {documentTitle}
          </DialogDescription>
        </DialogHeader>

        <div className="py-2 space-y-3 max-h-[60vh] overflow-y-auto">
          {loading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
            </div>
          ) : duplicates.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-8">
              {t('knowledge.duplicates.noDuplicates', 'No duplicates found')}
            </p>
          ) : (
            duplicates.map(dup => {
              const matchInfo = MATCH_LABELS[dup.match_type] || MATCH_LABELS.title_fuzzy;
              return (
                <div
                  key={dup.document_id}
                  className="border border-border p-3 space-y-2"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium truncate">{dup.title || dup.filename}</p>
                      <div className="flex items-center gap-2 mt-1">
                        <span className={cn('text-[10px] px-1.5 py-0.5 font-medium', matchInfo.color)}>
                          {matchInfo.label}
                        </span>
                        <span className="text-[10px] text-muted-foreground">
                          {Math.round(dup.confidence * 100)}% confidence
                        </span>
                      </div>
                      {dup.matching_value && (
                        <p className="text-[10px] text-muted-foreground mt-1 truncate">
                          {dup.matching_value}
                        </p>
                      )}
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      className="flex-shrink-0 gap-1 text-xs"
                      disabled={merging === dup.document_id}
                      onClick={() => handleMerge(dup.document_id)}
                    >
                      {merging === dup.document_id ? (
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      ) : (
                        <Merge className="w-3.5 h-3.5" />
                      )}
                      {t('knowledge.duplicates.merge', 'Merge')}
                    </Button>
                  </div>
                  <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
                    <span className="truncate">{documentTitle}</span>
                    <ArrowRight className="w-3 h-3 flex-shrink-0" />
                    <span className="font-medium">{t('knowledge.duplicates.keepOriginal', 'Keep original')}</span>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
