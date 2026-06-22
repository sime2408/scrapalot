/**
 * Metadata badge — shows DOI, journal, year inline.
 * Used on document cards in Library view.
 */

import React from 'react';
import { ExternalLink, BookOpen, Users } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { Creator } from '@/lib/api-metadata';
import { parseDocumentMetadata } from '@/lib/api-metadata';

interface MetadataBadgeProps {
  extractedMetadata: string | Record<string, unknown> | null | undefined;
  className?: string;
  compact?: boolean;
}

/** Format creators with role suffixes */
function formatCreators(creators: Creator[]): string {
  const authors = creators.filter(c => c.role === 'author' || c.role === 'book_author');
  const editors = creators.filter(c => c.role === 'editor');
  const translators = creators.filter(c => c.role === 'translator');
  const parts: string[] = [];
  if (authors.length > 0) {
    parts.push(authors.slice(0, 2).map(c => c.last_name).join(', ') +
      (authors.length > 2 ? ` +${authors.length - 2}` : ''));
  }
  if (editors.length > 0) {
    parts.push(editors.slice(0, 2).map(c => c.last_name).join(', ') + ' (eds.)');
  }
  if (translators.length > 0) {
    parts.push(translators.slice(0, 1).map(c => c.last_name).join('') + ' (trans.)');
  }
  return parts.join('; ');
}

export function MetadataBadge({ extractedMetadata, className, compact = false }: MetadataBadgeProps) {
  const meta = parseDocumentMetadata(extractedMetadata);
  if (!meta?.resolved) return null;

  const { resolved } = meta;

  if (compact) {
    // Compact: single line "Nature · DOI↗" — year intentionally omitted
    // (already shown on the FakeBookCover thumbnail above the caption)
    const parts: string[] = [];
    if (resolved.journal) parts.push(resolved.journal);

    if (parts.length === 0 && !resolved.doi) return null;

    return (
      <span className={cn('text-[10px] text-zinc-500 dark:text-zinc-400 truncate', className)}>
        {parts.join(' · ')}
        {resolved.doi && (
          <a
            href={`https://doi.org/${resolved.doi}`}
            target="_blank"
            rel="noopener noreferrer"
            className="ml-1 text-blue-500 hover:text-blue-400 inline-flex items-center"
            onClick={(e) => e.stopPropagation()}
          >
            DOI<ExternalLink className="w-2.5 h-2.5 ml-0.5" />
          </a>
        )}
      </span>
    );
  }

  // Full: multi-line with icons
  return (
    <div className={cn('space-y-0.5', className)}>
      {/* Authors + Creator Roles */}
      {resolved.creators && resolved.creators.length > 0 ? (
        <div className="flex items-center gap-1 text-[10px] text-zinc-500 dark:text-zinc-400 truncate">
          <Users className="w-3 h-3 flex-shrink-0" />
          <span className="truncate">
            {formatCreators(resolved.creators)}
          </span>
        </div>
      ) : resolved.authors && resolved.authors.length > 0 ? (
        <div className="flex items-center gap-1 text-[10px] text-zinc-500 dark:text-zinc-400 truncate">
          <Users className="w-3 h-3 flex-shrink-0" />
          <span className="truncate">
            {resolved.authors.slice(0, 2).join(', ')}
            {resolved.authors.length > 2 && ` +${resolved.authors.length - 2}`}
          </span>
        </div>
      ) : null}

      {/* Journal — year intentionally omitted (already on the FakeBookCover) */}
      {resolved.journal && (
        <div className="flex items-center gap-1 text-[10px] text-zinc-500 dark:text-zinc-400 truncate">
          <BookOpen className="w-3 h-3 flex-shrink-0" />
          <span className="truncate">{resolved.journal}</span>
        </div>
      )}

      {/* DOI link */}
      {resolved.doi && (
        <a
          href={`https://doi.org/${resolved.doi}`}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-1 text-[10px] text-blue-500 hover:text-blue-400 truncate"
          onClick={(e) => e.stopPropagation()}
        >
          <ExternalLink className="w-3 h-3 flex-shrink-0" />
          <span className="truncate">doi.org/{resolved.doi}</span>
        </a>
      )}
    </div>
  );
}
