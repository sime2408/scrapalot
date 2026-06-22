/**
 * EvidenceDistributionBar — Smart Citations (Scite integration).
 *
 * Renders a proportional bar and count summary showing how the message's
 * citations split across supporting / contrasting / mentioning stances.
 * Appears under assistant messages that have at least 2 classified citations.
 */

import React from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';

interface CitationLike {
  citation_num?: number;
  stance?: 'supporting' | 'contrasting' | 'mentioning';
}

interface EvidenceDistributionBarProps {
  citations: CitationLike[];
  className?: string;
}

function EvidenceDistributionBar({ citations, className }: EvidenceDistributionBarProps) {
  const { t } = useTranslation();

  const classified = citations.filter(c => !!c.stance);
  if (classified.length < 2) return null;

  const supporting = classified.filter(c => c.stance === 'supporting').length;
  const contrasting = classified.filter(c => c.stance === 'contrasting').length;
  const mentioning = classified.filter(c => c.stance === 'mentioning').length;
  const total = classified.length;

  const supPct = (supporting / total) * 100;
  const conPct = (contrasting / total) * 100;
  const menPct = (mentioning / total) * 100;

  return (
    <div
      className={cn('md:ml-8 mt-3 pt-3 border-t border-border/60', className)}
      role="img"
      aria-label={t(
        'smartCitations.evidenceDistributionAria',
        'Evidence distribution: {{s}} supporting, {{c}} contrasting, {{m}} mentioning',
        { s: supporting, c: contrasting, m: mentioning }
      )}
    >
      <div className="flex items-center gap-4 text-[11px] text-muted-foreground">
        <span className="font-medium text-foreground">
          {t('smartCitations.evidenceDistribution', 'Evidence distribution')}
        </span>
        {supporting > 0 && (
          <span className="flex items-center gap-1.5">
            <span className="w-2 h-2 bg-emerald-500" aria-hidden />
            <span className="text-emerald-700 dark:text-emerald-400 font-semibold">
              {t('smartCitations.nSupporting', '{{count}} supporting', { count: supporting })}
            </span>
          </span>
        )}
        {contrasting > 0 && (
          <span className="flex items-center gap-1.5">
            <span className="w-2 h-2 bg-rose-500" aria-hidden />
            <span className="text-rose-700 dark:text-rose-400 font-semibold">
              {t('smartCitations.nContrasting', '{{count}} contrasting', { count: contrasting })}
            </span>
          </span>
        )}
        {mentioning > 0 && (
          <span className="flex items-center gap-1.5">
            <span className="w-2 h-2 bg-amber-500" aria-hidden />
            <span className="text-amber-700 dark:text-amber-400 font-semibold">
              {t('smartCitations.nMentioning', '{{count}} mentioning', { count: mentioning })}
            </span>
          </span>
        )}
      </div>
      <div className="mt-2 flex h-1.5 overflow-hidden" aria-hidden>
        {supPct > 0 && <div className="bg-emerald-500 transition-[width]" style={{ width: `${supPct}%` }} />}
        {conPct > 0 && <div className="bg-rose-500 transition-[width]" style={{ width: `${conPct}%` }} />}
        {menPct > 0 && <div className="bg-amber-500 transition-[width]" style={{ width: `${menPct}%` }} />}
      </div>
    </div>
  );
}
