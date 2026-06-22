import { DocumentCollection } from '@/types';

/**
 * Resolve a collection's EFFECTIVE knowledge-graph build tier (0/1/2).
 *
 * graph_tier may be null (inherit from parent), so walk parent_collection_id until
 * an explicit tier is found; a root collection that is still null resolves to 0.
 * Mirrors the backend resolve_graph_tier.
 */
export function resolveEffectiveGraphTier(
  collection: DocumentCollection,
  all: DocumentCollection[]
): number {
  const byId = new Map(all.map(c => [c.id, c]));
  let cur: DocumentCollection | undefined = collection;
  const seen = new Set<string>();
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    const tier = cur.graph_tier ?? cur.graphTier;
    if (typeof tier === 'number') return tier;
    const pid = cur.parentCollectionId || cur.parent_collection_id;
    cur = pid ? byId.get(pid) : undefined;
  }
  return 0;
}

/**
 * Top-level collections that build a knowledge graph (effective tier 1 or 2).
 *
 * Admin graph pickers are flat dropdowns — listing every sub-collection next to
 * its parent makes a cluttered "forest", so we show only ROOT collections
 * (no parent). Picking a root covers its sub-collections' shared content; Tier 0
 * roots (no graph) are excluded.
 */
export function filterGraphCollections(collections: DocumentCollection[]): DocumentCollection[] {
  return collections.filter(c => {
    const isRoot = !(c.parentCollectionId || c.parent_collection_id);
    return isRoot && resolveEffectiveGraphTier(c, collections) >= 1;
  });
}
