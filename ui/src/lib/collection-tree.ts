/**
 * Collection tree utilities for nested collections.
 * Builds tree structure from flat collection list using parentCollectionId.
 */

import type { DocumentCollection } from '@/types';

export interface CollectionTreeNode extends DocumentCollection {
  children: CollectionTreeNode[];
}

/** Build a tree from a flat list of collections. */
export function buildCollectionTree(collections: DocumentCollection[]): CollectionTreeNode[] {
  const nodeMap = new Map<string, CollectionTreeNode>();
  const roots: CollectionTreeNode[] = [];

  // Create nodes
  for (const col of collections) {
    nodeMap.set(col.id, { ...col, children: [] });
  }

  // Link children to parents (check both camelCase and snake_case from API)
  for (const col of collections) {
    const node = nodeMap.get(col.id)!;
    const parentId = col.parentCollectionId || col.parent_collection_id;
    if (parentId && nodeMap.has(parentId)) {
      nodeMap.get(parentId)!.children.push(node);
    } else {
      roots.push(node);
    }
  }

  // Sort children by sortOrder then name
  const sortChildren = (nodes: CollectionTreeNode[]) => {
    nodes.sort((a, b) => (a.sortOrder ?? a.sort_order ?? 0) - (b.sortOrder ?? b.sort_order ?? 0) || a.name.localeCompare(b.name));
    for (const node of nodes) {
      if (node.children.length > 0) sortChildren(node.children);
    }
  };
  sortChildren(roots);

  return roots;
}

/** Get ancestors for breadcrumb (root first). */
export function getAncestors(collections: DocumentCollection[], collectionId: string): DocumentCollection[] {
  const result: DocumentCollection[] = [];
  const byId = new Map(collections.map(c => [c.id, c]));
  let current = byId.get(collectionId);
  while (current) {
    result.unshift(current);
    const pid = current.parentCollectionId || current.parent_collection_id;
    current = pid ? byId.get(pid) : undefined;
  }
  return result;
}
