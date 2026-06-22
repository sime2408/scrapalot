/**
 * BridgeConceptsPanel — cross-domain bridge UX.
 *
 * Renders a collapsible panel below an assistant reply when ANY of the
 * reply's citations originated from a cross-domain bridge chunk
 * (`is_bridge=true` on `CitationInfoPacket`). Lists the unique anchor
 * entities that connect the selected collections, so the reader sees which
 * concepts bridge the otherwise-distant domains.
 *
 * Renders nothing when no bridge citations are present — the common case
 * when bridge mode is OFF (default) or the selected collections are not
 * classified as "distant" by the bridge detector.
 */

import React, { useState, useMemo } from 'react';
import { ChevronUp, ChevronDown } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';

interface BridgeCitation {
  citation_num?: number;
  source_collection_id?: string;
  is_bridge?: boolean;
  bridge_anchors?: string[];
}

interface BridgeConceptsPanelProps {
  citations: BridgeCitation[] | null | undefined;
  className?: string;
}

export function BridgeConceptsPanel({ citations, className }: BridgeConceptsPanelProps) {
  const { t } = useTranslation();
  const [isOpen, setIsOpen] = useState(false);

  const { anchors, sourceCollectionCount } = useMemo(() => {
    if (!Array.isArray(citations)) {
      return { anchors: [] as string[], sourceCollectionCount: 0 };
    }
    const anchorWeight = new Map<string, number>();
    const collectionSet = new Set<string>();
    for (const c of citations) {
      if (!c?.is_bridge) continue;
      if (c.source_collection_id) collectionSet.add(c.source_collection_id);
      const list = Array.isArray(c.bridge_anchors) ? c.bridge_anchors : [];
      for (const a of list) {
        if (typeof a === 'string' && a.trim().length > 0) {
          anchorWeight.set(a, (anchorWeight.get(a) ?? 0) + 1);
        }
      }
    }
    const anchors = Array.from(anchorWeight.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([name]) => name);
    return { anchors, sourceCollectionCount: collectionSet.size };
  }, [citations]);

  if (anchors.length === 0) return null;

  return (
    <div
      data-testid='bridge-concepts-panel'
      className={cn(
        'md:ml-8 mt-3 pt-2 border-t border-zinc-200 dark:border-zinc-800',
        className,
      )}
    >
      <button
        data-testid='bridge-concepts-toggle'
        type='button'
        onClick={() => setIsOpen(v => !v)}
        className='flex items-center text-xs md:text-sm text-primary hover:text-primary/80 focus:outline-none w-full'
        aria-expanded={isOpen}
      >
        <div className='flex items-center'>
          {isOpen ? (
            <ChevronUp className='h-3 w-3 mr-1.5' />
          ) : (
            <ChevronDown className='h-3 w-3 mr-1.5' />
          )}
          <span className='font-medium'>
            {t('chat.bridgeConcepts.title', 'Bridge concepts')}
          </span>
          <span className='ml-1.5 text-muted-foreground'>({anchors.length})</span>
        </div>
      </button>

      {isOpen && (
        <div className='mt-2 space-y-1.5'>
          <p className='text-[11px] text-muted-foreground italic leading-relaxed'>
            {sourceCollectionCount >= 2
              ? t(
                  'chat.bridgeConcepts.subtitle',
                  'Concepts shared across the selected collections that connect their otherwise distant domains.',
                )
              : t(
                  'chat.bridgeConcepts.subtitleSingle',
                  'Concepts surfaced via cross-domain bridging.',
                )}
          </p>
          <ul
            data-testid='bridge-concepts-list'
            className='flex flex-wrap gap-1.5 pt-1'
          >
            {anchors.map(name => (
              <li
                key={name}
                className='inline-flex items-center px-2 py-0.5 text-[11px] border border-border bg-muted/30 text-foreground/90'
              >
                {name}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
