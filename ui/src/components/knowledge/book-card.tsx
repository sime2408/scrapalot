/**
 * Book Card Component
 * Displays a downloaded book with cover thumbnail and status
 */

import React from 'react';
import { useTranslation } from 'react-i18next';
import { Book, Check, X, Loader2, Trash2, Eye } from 'lucide-react';
import { Checkbox } from '@/components/ui/checkbox';
import { cn } from '@/lib/utils';
import { useIsMobile } from '@/hooks/use-mobile';
import { BookSummaryHoverCard } from '@/components/knowledge/book-summary-hover-card';
import { StarRating } from '@/components/document-rating/star-rating';

export interface BookCardProps {
  id: string;
  title: string;
  author?: string;
  year?: string;
  coverUrl?: string;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  progress?: number;
  selected: boolean;
  onSelect: (id: string, selected: boolean) => void;
  onDelete: (id: string) => void;
  onPreview?: (id: string) => void;
  // when provided, renders a 5-star rating widget
  // under the title. Optional so callers that don't have workspaceId
  // (e.g. external book search results, pre-import) can omit it.
  workspaceId?: string;
  rating?: number | null;
  onRatingChange?: (next: number | null) => void;
}

const STATUS_STYLES = {
  pending: {
    border: 'border-zinc-300 dark:border-zinc-700',
    bg: 'bg-zinc-50 dark:bg-zinc-900',
    badge: null,
  },
  processing: {
    border: 'border-orange-400 dark:border-orange-500 animate-pulse',
    bg: 'bg-orange-50/30 dark:bg-orange-900/20',
    badge: <Loader2 className="h-4 w-4 animate-spin text-orange-500" />,
  },
  completed: {
    border: 'border-green-500 dark:border-green-600',
    bg: 'bg-green-50/30 dark:bg-green-900/20',
    badge: <Check className="h-4 w-4 text-green-500" />,
  },
  failed: {
    border: 'border-red-500 dark:border-red-600',
    bg: 'bg-red-50/30 dark:bg-red-900/20',
    badge: <X className="h-4 w-4 text-red-500" />,
  },
};

export function BookCard({
  id,
  title,
  author,
  year,
  coverUrl,
  status,
  progress,
  selected,
  onSelect,
  onDelete,
  onPreview,
  workspaceId,
  rating,
  onRatingChange,
}: BookCardProps) {
  const { t } = useTranslation();
  const isMobile = useIsMobile();
  const styles = STATUS_STYLES[status];

  const handleCheckboxChange = (checked: boolean | 'indeterminate') => {
    onSelect(id, checked === true);
  };

  return (
    <BookSummaryHoverCard documentId={id}>
    <div
      data-testid={`knowledge-book-card-${id}`}
      className={cn(
        'relative group rounded-lg border-2 overflow-hidden transition-all',
        styles.border,
        styles.bg,
        selected && 'ring-2 ring-blue-500 ring-offset-2 dark:ring-offset-zinc-900'
      )}
    >
      {/* Cover Image */}
      <div className="relative aspect-[2/3] bg-zinc-200 dark:bg-zinc-800">
        {coverUrl ? (
          <img
            src={coverUrl}
            alt={title}
            className="w-full h-full object-cover"
            onError={(e) => {
              (e.target as HTMLImageElement).style.display = 'none';
              (e.target as HTMLImageElement).nextElementSibling?.classList.remove('hidden');
            }}
          />
        ) : null}
        <div className={cn(
          'absolute inset-0 flex items-center justify-center',
          coverUrl && 'hidden'
        )}>
          <Book className="h-12 w-12 text-zinc-400 dark:text-zinc-600" />
        </div>

        {/* Status Badge */}
        {styles.badge && (
          <div className="absolute top-2 right-2 p-1.5 rounded-full bg-white dark:bg-zinc-900 shadow-md">
            {styles.badge}
          </div>
        )}

        {/* Progress Bar (when processing) */}
        {status === 'processing' && typeof progress === 'number' && (
          <div className="absolute bottom-0 left-0 right-0 h-1.5 bg-zinc-300 dark:bg-zinc-700">
            <div
              className="h-full bg-orange-500 transition-all duration-300"
              style={{ width: `${Math.min(100, Math.max(0, progress))}%` }}
            />
          </div>
        )}

        {/* Selection Checkbox */}
        <div
          className={cn(
            'absolute top-2 left-2 transition-opacity',
            status === 'pending' || status === 'failed' ? 'opacity-100' : 'opacity-50 pointer-events-none'
          )}
        >
          <Checkbox
            data-testid={`knowledge-book-card-checkbox-${id}`}
            checked={selected}
            onCheckedChange={handleCheckboxChange}
            disabled={status !== 'pending' && status !== 'failed'}
            className="h-5 w-5 bg-white dark:bg-zinc-900 border-2 shadow-md"
          />
        </div>

        {/* Preview Button - Always visible on mobile, hover on desktop */}
        {onPreview && (
          <button
            data-testid={`knowledge-book-card-preview-${id}`}
            onClick={(e) => {
              e.stopPropagation();
              onPreview(id);
            }}
            className={cn(
              'absolute bottom-2 left-2 p-1.5 rounded-full',
              'bg-blue-500 text-white shadow-md',
              'transition-opacity',
              'hover:bg-blue-600',
              isMobile ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
            )}
            title={t('knowledge.downloadedBooks.preview', 'Preview PDF')}
          >
            <Eye className="h-3.5 w-3.5" />
          </button>
        )}

        {/* Delete Button - Always visible on mobile, hover on desktop */}
        <button
          data-testid={`knowledge-book-card-delete-${id}`}
          onClick={(e) => {
            e.stopPropagation();
            onDelete(id);
          }}
          className={cn(
            'absolute bottom-2 right-2 p-1.5 rounded-full',
            'bg-red-500 text-white shadow-md',
            'transition-opacity',
            'hover:bg-red-600',
            isMobile ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
          )}
          title={t('general.delete', 'Delete')}
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* Info */}
      <div className="p-2">
        <h4 className="text-xs font-medium text-zinc-900 dark:text-white line-clamp-2 leading-tight">
          {title}
        </h4>
        {author && (
          <p className="text-[10px] text-zinc-500 dark:text-zinc-400 mt-0.5 truncate">
            {author}
          </p>
        )}
        {year && (
          <p className="text-[10px] text-zinc-400 dark:text-zinc-500">
            {year}
          </p>
        )}
        {/* only rendered when caller supplied workspaceId. */}
        {workspaceId && status === 'completed' && (
          <div className='mt-1.5'>
            <StarRating
              documentId={id}
              workspaceId={workspaceId}
              value={rating ?? null}
              onChange={onRatingChange}
              size='sm'
            />
          </div>
        )}
      </div>
    </div>
    </BookSummaryHoverCard>
  );
}
