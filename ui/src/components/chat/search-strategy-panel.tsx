/**
 * SearchStrategyPanel — collapsible transparency panel that shows the sub-queries,
 * filters, and sources the RAG agent actually ran for a given answer.
 *
 * Renders under the AI response bubble when the backend emitted a
 * `search_strategy` packet. Academic users use this for methodological
 * defensibility when quoting Scrapalot answers in systematic reviews.
 */

import React, { useState } from 'react';
import { ChevronRight, ListChecks } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';

export interface SearchStrategyData {
  sub_queries?: string[];
  filters_applied?: Record<string, string>;
  sources_queried?: string[];
  strategy_name?: string;
  rationale?: string;
  /** Who actually ran retrieval — strategy_name is the chosen approach (intent). */
  executor?: string;
}

interface SearchStrategyPanelProps {
  strategy: SearchStrategyData;
  className?: string;
}

export function SearchStrategyPanel({ strategy, className }: SearchStrategyPanelProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);

  // Translate small enums coming from the backend. Anything not in the map
  // falls back to the raw value so we never show "missing translation key" — a
  // new strategy name will just appear in English until it gets a hr/mk entry.
  // Lookup tries the raw value first, then lowercased — backend sometimes
  // returns "Comparison" (Pydantic title-case) while keys are lowercase.
  const tEnum = (ns: string, value: string | undefined) => {
    if (!value) return '';
    const tryKey = (k: string) => {
      const out = t(`searchStrategy.${ns}.${k}`);
      return out === `searchStrategy.${ns}.${k}` ? null : out;
    };
    return tryKey(value) ?? tryKey(value.toLowerCase()) ?? value;
  };

  const hasContent = !!(
    (strategy.sub_queries && strategy.sub_queries.length > 0) ||
    (strategy.filters_applied && Object.keys(strategy.filters_applied).length > 0) ||
    (strategy.sources_queried && strategy.sources_queried.length > 0) ||
    strategy.strategy_name ||
    strategy.rationale ||
    strategy.executor
  );
  if (!hasContent) return null;

  return (
    <div className={cn('mt-2 text-xs text-left', className)} data-testid='search-strategy-panel'>
      <button
        type='button'
        onClick={() => setOpen(v => !v)}
        className='w-full flex items-center gap-2 py-1 text-primary hover:text-primary/80 transition-colors text-left'
        aria-expanded={open}
      >
        <ChevronRight
          className={cn('h-3.5 w-3.5 transition-transform', open && 'rotate-90')}
          aria-hidden
        />
        <ListChecks className='h-3.5 w-3.5' aria-hidden />
        <span className='font-medium'>
          {t('searchStrategy.title', 'Search strategy')}
        </span>
        {strategy.strategy_name && (
          <span className='ml-auto text-[10px] uppercase tracking-wider text-muted-foreground'>
            {tEnum('strategy', strategy.strategy_name)}
          </span>
        )}
      </button>
      {open && (
        // Two-column grid on lg+ (≥1024px). Sub-queries and filters sit in the
        // top row; sources + rationale span the full width below so long text
        // does not get squeezed.
        <div className='py-2 grid grid-cols-1 lg:grid-cols-2 gap-x-6 gap-y-3'>
          {strategy.sub_queries && strategy.sub_queries.length > 0 && (
            <div>
              <div className='text-[10px] uppercase tracking-wider text-muted-foreground mb-1'>
                {t('searchStrategy.subQueries', 'Sub-queries')}
              </div>
              <ul className='space-y-0.5 list-disc pl-5 text-foreground/90'>
                {strategy.sub_queries.map((q, i) => (
                  <li key={i} className='break-words'>{q}</li>
                ))}
              </ul>
            </div>
          )}
          {strategy.filters_applied && Object.keys(strategy.filters_applied).length > 0 && (
            <div>
              <div className='text-[10px] uppercase tracking-wider text-muted-foreground mb-1'>
                {t('searchStrategy.filters', 'Filters')}
              </div>
              <dl className='grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5'>
                {Object.entries(strategy.filters_applied).map(([k, v]) => (
                  <React.Fragment key={k}>
                    <dt className='text-muted-foreground'>{tEnum('filterKey', k)}</dt>
                    <dd className='text-foreground/90'>{tEnum('filterValue', String(v))}</dd>
                  </React.Fragment>
                ))}
              </dl>
            </div>
          )}
          {strategy.sources_queried && strategy.sources_queried.length > 0 && (
            <div className='lg:col-span-2'>
              <div className='text-[10px] uppercase tracking-wider text-muted-foreground mb-1'>
                {t('searchStrategy.sources', 'Sources')}
              </div>
              <div className='flex flex-wrap gap-1'>
                {strategy.sources_queried.map((s, i) => (
                  <span key={i} className='px-1.5 py-0.5 bg-primary/10 text-primary border border-primary/20'>
                    {tEnum('source', s)}
                  </span>
                ))}
              </div>
            </div>
          )}
          {strategy.executor && (
            <div className='lg:col-span-2'>
              <div className='text-[10px] uppercase tracking-wider text-muted-foreground mb-1'>
                {t('searchStrategy.executedBy', 'Executed by')}
              </div>
              <div className='flex items-center gap-1.5 text-foreground/90'>
                <span className='px-1.5 py-0.5 bg-muted text-muted-foreground border border-border'>
                  {tEnum('executor', strategy.executor)}
                </span>
                <span className='text-[10px] text-muted-foreground'>
                  {t('searchStrategy.executorNote', 'the strategy above is the chosen approach; retrieval runs through the agent’s tools')}
                </span>
              </div>
            </div>
          )}
          {strategy.rationale && (
            <div className='lg:col-span-2'>
              <div className='text-[10px] uppercase tracking-wider text-muted-foreground mb-1'>
                {t('searchStrategy.rationale', 'Rationale')}
              </div>
              <p className='text-foreground/90 leading-relaxed italic border-l-2 border-border pl-2'>
                {strategy.rationale}
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
