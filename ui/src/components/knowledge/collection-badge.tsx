/**
 * Collection badge — shows how many collections a document belongs to.
 * For multi-collection membership.
 */

import React from 'react';
import { FolderOpen } from 'lucide-react';
import { cn } from '@/lib/utils';

interface CollectionBadgeProps {
  collections: Array<{ collection_id: string; collection_name: string }>;
  primaryCollection?: string;
  className?: string;
}

export function CollectionBadge({ collections, primaryCollection: _primaryCollection, className }: CollectionBadgeProps) {
  if (!collections || collections.length <= 1) return null;

  return (
    <span className={cn('inline-flex items-center gap-0.5 text-[9px] text-zinc-400 dark:text-zinc-500', className)}>
      <FolderOpen className="w-3 h-3" />
      {collections.length} collections
    </span>
  );
}
