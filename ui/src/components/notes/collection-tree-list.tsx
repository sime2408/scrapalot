/**
 * CollectionTreeList — reusable nested collection list with
 * expand/collapse + checkbox selection.
 *
 * Extracted from `chat/toolbar/actions/popover-collection-selector.tsx`
 * so the notes research-context popover can present the same hierarchy
 * (parent → subcollections) as the chat toolbar.
 *
 * Design matches the chat list exactly so users see a single, consistent
 * "pick collections" affordance regardless of whether they are scoping a
 * chat or a note.
 */

import * as React from 'react';
import { ChevronRight } from 'lucide-react';
import { Checkbox } from '@/components/ui/checkbox';
import { DocumentCollection } from '@/types';
import { buildCollectionTree, CollectionTreeNode } from '@/lib/collection-tree';
import { cn } from '@/lib/utils';

export interface CollectionTreeListProps {
  collections: DocumentCollection[];
  selected: string[];
  onToggle: (id: string) => void;
  /** Optional prefix for `data-testid`s on each row. Defaults to 'collection-tree'. */
  testIdPrefix?: string;
  /** Optional className forwarded to the root container. */
  className?: string;
}

export const CollectionTreeList: React.FC<CollectionTreeListProps> = ({
  collections,
  selected,
  onToggle,
  testIdPrefix = 'collection-tree',
  className,
}) => {
  const tree = React.useMemo(() => buildCollectionTree(collections), [collections]);

  const [expanded, setExpanded] = React.useState<Set<string>>(() => {
    // Auto-expand parents of selected collections so the user
    // immediately sees their current selection inside the tree.
    const parentIds = new Set<string>();
    for (const col of collections) {
      if (selected.includes(col.id)) {
        const pid = col.parentCollectionId || col.parent_collection_id;
        if (pid) parentIds.add(pid);
      }
    }
    return parentIds;
  });

  const toggleExpand = React.useCallback((id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const renderNode = (node: CollectionTreeNode, depth: number) => {
    const isSelected = selected.includes(node.id);
    const hasChildren = node.children.length > 0;
    const isExpanded = expanded.has(node.id);

    return (
      <div key={node.id}>
        <div
          data-testid={`${testIdPrefix}-item-${node.id}`}
          className={cn(
            'group flex items-center gap-2 py-1.5 text-sm transition-colors hover:bg-accent',
            isSelected && 'bg-primary/5 border-l-2 border-l-primary'
          )}
          style={{ paddingLeft: `${8 + depth * 20}px`, paddingRight: '8px' }}
        >
          {hasChildren ? (
            <button
              type="button"
              onClick={(e) => { e.preventDefault(); toggleExpand(node.id); }}
              className="p-0.5 hover:bg-muted transition-transform flex-shrink-0"
            >
              <ChevronRight
                className={cn(
                  'h-3 w-3 text-muted-foreground transition-transform',
                  isExpanded && 'rotate-90'
                )}
              />
            </button>
          ) : (
            <span className="w-4 flex-shrink-0" />
          )}
          <Checkbox
            checked={isSelected}
            onCheckedChange={() => onToggle(node.id)}
            className="h-4 w-4 flex-shrink-0"
            aria-label={node.name}
          />
          <label
            onClick={(e) => { e.preventDefault(); onToggle(node.id); }}
            className="flex-1 min-w-0 text-sm cursor-pointer truncate group-hover:text-foreground"
          >
            {node.name}
          </label>
          {typeof node.documentCount === 'number' && node.documentCount > 0 && (
            <span className="text-xs text-muted-foreground whitespace-nowrap flex-shrink-0">
              {node.documentCount}
            </span>
          )}
        </div>
        {hasChildren && isExpanded && node.children.map((child) => renderNode(child, depth + 1))}
      </div>
    );
  };

  return (
    <div className={className} data-testid={`${testIdPrefix}-root`}>
      {tree.map((node) => renderNode(node, 0))}
    </div>
  );
};

export default CollectionTreeList;
