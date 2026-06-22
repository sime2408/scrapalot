/**
 * Tag badge — small colored chip for document tags.
 * Used in Library view document cards.
 */

import React from 'react';
import { cn } from '@/lib/utils';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';

interface TagBadgeProps {
  name: string;
  color: string | null;
  size?: 'sm' | 'md';
  onClick?: () => void;
  onRemove?: () => void;
  className?: string;
}

export function TagBadge({ name, color, size = 'sm', onClick, onRemove, className }: TagBadgeProps) {
  const hex = color || '#aaaaaa';

  return (
    <span
      className={cn(
        'inline-flex items-center gap-0.5 border transition-colors',
        size === 'sm' ? 'text-[9px] px-1 py-0' : 'text-[10px] px-1.5 py-0.5',
        onClick && 'cursor-pointer hover:opacity-80',
        className
      )}
      style={{
        borderColor: `${hex}60`,
        backgroundColor: `${hex}15`,
        color: hex,
      }}
      onClick={onClick}
    >
      <span
        className={cn('rounded-full flex-shrink-0', size === 'sm' ? 'w-1.5 h-1.5' : 'w-2 h-2')}
        style={{ backgroundColor: hex }}
      />
      {name}
      {onRemove && (
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onRemove(); }}
          className="ml-0.5 hover:opacity-60"
        >
          ×
        </button>
      )}
    </span>
  );
}

interface TagBadgeGroupProps {
  tags: Array<{ name: string; color: string | null }>;
  maxVisible?: number;
  size?: 'sm' | 'md';
  className?: string;
}

export function TagBadgeGroup({ tags, maxVisible = 3, size = 'sm', className }: TagBadgeGroupProps) {
  if (!tags || tags.length === 0) return null;

  const visible = tags.slice(0, maxVisible);
  const remaining = tags.length - maxVisible;

  return (
    <div className={cn('flex flex-wrap items-center gap-0.5', className)}>
      {visible.map((tag, i) => (
        <TagBadge key={i} name={tag.name} color={tag.color} size={size} />
      ))}
      {remaining > 0 && (
        <span className="text-[9px] text-zinc-400">+{remaining}</span>
      )}
    </div>
  );
}

/** Compact color dots — shows tag colors as small circles with tooltip listing tag names. */
interface TagDotsProps {
  tags: Array<{ name: string; color: string | null }>;
  maxVisible?: number;
  className?: string;
}

export function TagDots({ tags, maxVisible = 4, className }: TagDotsProps) {
  if (!tags || tags.length === 0) return null;

  const visible = tags.slice(0, maxVisible);
  const remaining = tags.length - maxVisible;
  const tooltipText = tags.map(t => t.name).join(', ');

  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>
          <div className={cn('inline-flex items-center gap-[3px]', className)}>
            {visible.map((tag, i) => (
              <span
                key={i}
                className="w-[6px] h-[6px] rounded-full flex-shrink-0"
                style={{ backgroundColor: tag.color || '#aaaaaa' }}
              />
            ))}
            {remaining > 0 && (
              <span className="text-[8px] leading-none text-muted-foreground">+{remaining}</span>
            )}
          </div>
        </TooltipTrigger>
        <TooltipContent side="bottom" className="text-xs">
          {tooltipText}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
