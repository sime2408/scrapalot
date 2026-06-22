/**
 * Sidebar panel listing all annotations for the current document.
 * Click annotation to scroll to its location.
 */

import React from 'react';
import { Highlighter, Underline, StickyNote, Trash2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { Annotation } from '@/types/annotations';
import { ANNOTATION_TYPES } from '@/types/annotations';

interface AnnotationSidebarProps {
  annotations: Annotation[];
  onAnnotationClick: (annotation: Annotation) => void;
  onDelete: (annotationId: string) => void;
  className?: string;
}

const TYPE_ICONS: Record<number, React.ElementType> = {
  [ANNOTATION_TYPES.HIGHLIGHT]: Highlighter,
  [ANNOTATION_TYPES.UNDERLINE]: Underline,
  [ANNOTATION_TYPES.NOTE]: StickyNote,
};

export function AnnotationSidebar({
  annotations,
  onAnnotationClick,
  onDelete,
  className,
}: AnnotationSidebarProps) {
  if (annotations.length === 0) {
    return (
      <div data-testid="annotation-sidebar-empty" className={cn('flex flex-col items-center justify-center py-8 text-zinc-400', className)}>
        <Highlighter className="w-8 h-8 mb-2 opacity-30" />
        <p className="text-xs">No annotations yet</p>
        <p className="text-[10px] mt-1">Select text and use the toolbar to highlight</p>
      </div>
    );
  }

  // Group annotations by page
  const byPage = new Map<string, Annotation[]>();
  for (const ann of annotations) {
    const page = ann.page_label || 'Unknown';
    const group = byPage.get(page) || [];
    group.push(ann);
    byPage.set(page, group);
  }

  return (
    <div data-testid="annotation-sidebar" className={cn('overflow-y-auto', className)}>
      {Array.from(byPage.entries()).map(([page, pageAnnotations]) => (
        <div key={page} className="mb-3">
          <div data-testid={`annotation-page-group-${page}`} className="text-[10px] font-medium text-zinc-400 dark:text-zinc-500 uppercase tracking-wider px-2 py-1">
            Page {page}
          </div>
          {pageAnnotations.map((ann) => {
            const Icon = TYPE_ICONS[ann.annotation_type] || Highlighter;
            return (
              <button
                key={ann.id}
                type="button"
                data-testid={`annotation-sidebar-item-${ann.id}`}
                onClick={() => onAnnotationClick(ann)}
                className="w-full text-left px-2 py-1.5 hover:bg-zinc-50 dark:hover:bg-zinc-800/50 transition-colors group"
              >
                <div className="flex items-start gap-1.5">
                  <div
                    className="mt-0.5 w-3 h-3 flex-shrink-0"
                    style={{ color: ann.color }}
                  >
                    <Icon className="w-3 h-3" />
                  </div>
                  <div className="flex-1 min-w-0">
                    {ann.selected_text && (
                      <p className="text-xs text-zinc-700 dark:text-zinc-300 line-clamp-2">
                        {ann.selected_text}
                      </p>
                    )}
                    {ann.comment && (
                      <p className="text-[10px] text-zinc-500 dark:text-zinc-400 mt-0.5 line-clamp-1 italic">
                        {ann.comment}
                      </p>
                    )}
                  </div>
                  <button
                    type="button"
                    data-testid={`annotation-sidebar-delete-${ann.id}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      onDelete(ann.id);
                    }}
                    className="p-0.5 text-zinc-300 dark:text-zinc-600 opacity-0 group-hover:opacity-100 hover:text-red-500 transition-all"
                  >
                    <Trash2 className="w-3 h-3" />
                  </button>
                </div>
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
}
