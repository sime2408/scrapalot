/**
 * Duplicate badge — indicator when document has potential duplicates.
 * For duplicate detection.
 */

import React from 'react';
import { Copy } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

interface DuplicateBadgeProps {
  duplicateCount: number;
  className?: string;
}

export function DuplicateBadge({ duplicateCount, className }: DuplicateBadgeProps) {
  if (!duplicateCount || duplicateCount === 0) return null;

  return (
    <Tooltip delayDuration={200}>
      <TooltipTrigger asChild>
        <span className={cn(
          'inline-flex items-center gap-0.5 text-[9px] text-amber-500 dark:text-amber-400',
          className,
        )}>
          <Copy className="w-3 h-3" />
          {duplicateCount} {duplicateCount === 1 ? 'duplicate' : 'duplicates'}
        </span>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="text-xs">
        <p>Potential duplicate documents detected. Review in Library settings.</p>
      </TooltipContent>
    </Tooltip>
  );
}
