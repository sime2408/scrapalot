/**
 * Star rating widget (1..5 stars).
 *
 * Hover: highlights all stars from 1 to the hovered index.
 * Click: persists. Clicking a star equal to the current rating clears
 * it (toggle-off — matches ReadCube's pattern).
 *
 * Design notes:
 * - The widget owns both display and persistence: it takes documentId
 *   + workspaceId + the current rating from the parent and POSTs on
 *   change. The parent doesn't need to know about the API.
 * - Optimistic update: the click sets local state immediately; on
 *   server error we revert + toast. The 200ms delay on the server is
 *   long enough to feel laggy if we wait for the response.
 * - Sized for both library cards (md) and the PDF viewer header (sm).
 */
import * as React from 'react';
import { Star } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { rateDocument } from '@/lib/api-document-ratings';
import { toast } from '@/lib/toast-compat';
import { cn } from '@/lib/utils';

export interface StarRatingProps {
  documentId: string;
  workspaceId: string;
  /** Current rating (1..5) or null when unrated. */
  value: number | null;
  /** Optional callback fired on successful change. The widget already
   *  tracks state locally, so this is for parent components that want
   *  to update a list view header (e.g. "★★★★ 28 / ★★★ 12 / …"). */
  onChange?: (next: number | null) => void;
  /** Layout density. */
  size?: 'sm' | 'md';
  /** Disable interaction (read-only display). */
  disabled?: boolean;
  className?: string;
}

const STAR_COUNT = 5;

export const StarRating: React.FC<StarRatingProps> = ({
  documentId,
  workspaceId,
  value,
  onChange,
  size = 'md',
  disabled = false,
  className,
}) => {
  const { t } = useTranslation();

  // Local optimistic state: render this, not the prop. The prop only
  // seeds on mount and re-syncs when documentId/workspaceId change.
  const [local, setLocal] = React.useState<number | null>(value);
  const [hover, setHover] = React.useState<number | null>(null);
  const [pending, setPending] = React.useState(false);

  React.useEffect(() => {
    setLocal(value);
  }, [value, documentId]);

  const onClickStar = async (n: number) => {
    if (disabled || pending) return;
    // Click on the current value clears (toggle-off).
    const next: number | null = local === n ? null : n;
    const prev = local;
    setLocal(next);
    setPending(true);
    try {
      await rateDocument(documentId, workspaceId, next);
      onChange?.(next);
    } catch (err) {
      console.error('Failed to save rating:', err);
      setLocal(prev); // revert
      toast({
        title: t('general.error', 'Error'),
        description: t('documentRating.saveFailed', 'Failed to save rating'),
        variant: 'destructive',
      });
    } finally {
      setPending(false);
    }
  };

  const dim = size === 'sm' ? 'h-3.5 w-3.5' : 'h-4 w-4';
  const display = hover !== null ? hover : (local ?? 0);

  return (
    <div
      className={cn(
        'inline-flex items-center gap-0.5',
        disabled && 'opacity-60',
        className,
      )}
      role='radiogroup'
      aria-label={t('documentRating.label', 'Rate this document')}
      onMouseLeave={() => setHover(null)}
    >
      {Array.from({ length: STAR_COUNT }).map((_, i) => {
        const n = i + 1;
        const filled = n <= display;
        return (
          <button
            key={n}
            type='button'
            disabled={disabled || pending}
            onClick={() => void onClickStar(n)}
            onMouseEnter={() => setHover(n)}
            // onMouseDown prevents losing focus from a parent textarea
            // when used in nested forms (matches the rest of our UI).
            onMouseDown={e => e.preventDefault()}
            className={cn(
              'p-0.5 rounded-sm transition-colors',
              'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-amber-400',
              !disabled && 'cursor-pointer',
            )}
            aria-checked={local === n}
            role='radio'
            aria-label={t('documentRating.starN', '{{n}} stars', { n })}
            data-testid={`star-rating-${documentId}-${n}`}
          >
            <Star
              className={cn(
                dim,
                filled
                  ? 'text-amber-400 fill-amber-400'
                  : 'text-zinc-300 dark:text-zinc-600',
              )}
            />
          </button>
        );
      })}
    </div>
  );
};

export default StarRating;
