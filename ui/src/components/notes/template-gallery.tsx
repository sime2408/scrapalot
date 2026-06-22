/**
 * TemplateGallery — entry-point template picker for new notes.
 */

import * as React from 'react';
import { useTranslation } from 'react-i18next';
import {
  BookmarkCheck,
  BookOpen,
  Brain,
  ClipboardCheck,
  FileSearch,
  FileText,
  MessageCircle,
  Microscope,
  Notebook,
  PenLine,
  Sparkles,
} from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import {
  NOTE_TEMPLATE_CATEGORIES,
  NOTE_TEMPLATE_CATEGORY_LABELS,
  NOTE_TEMPLATES_CATALOG,
  type NoteTemplate,
  type NoteTemplateCategory,
} from '@/lib/note-templates-catalog';

const ICON_MAP: Record<string, React.ComponentType<{ className?: string }>> = {
  Microscope,
  ClipboardCheck,
  BookOpen,
  FileSearch,
  FileText,
  PenLine,
  Brain,
  MessageCircle,
  Notebook,
  BookmarkCheck,
};

export interface TemplateGalleryProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (template: NoteTemplate) => void;
  onSelectBlank?: () => void;
}

export const TemplateGallery: React.FC<TemplateGalleryProps> = ({
  open,
  onOpenChange,
  onSelect,
  onSelectBlank,
}) => {
  const { t } = useTranslation();
  const [category, setCategory] = React.useState<NoteTemplateCategory | 'all'>('all');

  const visible = React.useMemo(
    () =>
      category === 'all'
        ? NOTE_TEMPLATES_CATALOG
        : NOTE_TEMPLATES_CATALOG.filter((tpl) => tpl.category === category),
    [category]
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        data-testid="template-gallery"
        className="sm:max-w-3xl max-h-[85vh] flex flex-col p-0 gap-0"
        overlayZIndex="10050"
      >
        <DialogHeader className="px-5 pt-5 pb-3 border-b border-border">
          <DialogTitle>{t('templateGallery.title', 'Choose a template')}</DialogTitle>
          <DialogDescription>
            {t(
              'templateGallery.description',
              'Each template seeds a structure and a suggested research scope. All editable after creation.'
            )}
          </DialogDescription>
        </DialogHeader>

        {/* Category tabs */}
        <div className="flex gap-1 px-3 py-2 border-b border-border overflow-x-auto">
          <button
            type="button"
            data-testid="template-gallery-tab-all"
            onClick={() => setCategory('all')}
            className={cn(
              'flex items-center gap-1 px-2.5 py-1 text-xs font-medium whitespace-nowrap rounded transition-colors',
              category === 'all'
                ? 'bg-primary/10 text-primary'
                : 'text-muted-foreground hover:bg-accent hover:text-foreground'
            )}
          >
            {t('templateGallery.all', 'All')}
            <span
              className={cn(
                'text-[10px] px-1 rounded font-semibold',
                category === 'all'
                  ? 'bg-primary/20 text-primary'
                  : 'bg-muted text-muted-foreground'
              )}
            >
              {NOTE_TEMPLATES_CATALOG.length}
            </span>
          </button>
          {NOTE_TEMPLATE_CATEGORIES.map((cat) => {
            const count = NOTE_TEMPLATES_CATALOG.filter((tpl) => tpl.category === cat).length;
            return (
              <button
                type="button"
                key={cat}
                data-testid={`template-gallery-tab-${cat}`}
                onClick={() => setCategory(cat)}
                className={cn(
                  'flex items-center gap-1 px-2.5 py-1 text-xs font-medium whitespace-nowrap rounded transition-colors',
                  category === cat
                    ? 'bg-primary/10 text-primary'
                    : 'text-muted-foreground hover:bg-accent hover:text-foreground'
                )}
              >
                {t(
                  `templateGallery.category.${cat}`,
                  NOTE_TEMPLATE_CATEGORY_LABELS[cat]
                )}
                <span
                  className={cn(
                    'text-[10px] px-1 rounded font-semibold',
                    category === cat
                      ? 'bg-primary/20 text-primary'
                      : 'bg-muted text-muted-foreground'
                  )}
                >
                  {count}
                </span>
              </button>
            );
          })}
        </div>

        {/* Cards grid */}
        <div className="flex-1 min-h-0 overflow-y-auto px-5 py-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {visible.map((tpl) => {
              const Icon = (tpl.icon && ICON_MAP[tpl.icon]) || Sparkles;
              const name = t(`templateGallery.templates.${tpl.id}.name`, tpl.name);
              const description = t(`templateGallery.templates.${tpl.id}.description`, tpl.description);
              const wordCount = tpl.expectedWordCount
                ? t(`templateGallery.templates.${tpl.id}.expectedWordCount`, tpl.expectedWordCount)
                : undefined;
              const categoryLabel = t(
                `templateGallery.category.${tpl.category}`,
                NOTE_TEMPLATE_CATEGORY_LABELS[tpl.category]
              );
              return (
                <button
                  type="button"
                  key={tpl.id}
                  data-testid={`template-gallery-card-${tpl.id}`}
                  onClick={() => {
                    onSelect(tpl);
                    onOpenChange(false);
                  }}
                  className={cn(
                    'flex flex-col items-start gap-2 p-3 text-left border border-border bg-card',
                    'hover:border-primary/40 hover:bg-accent transition-colors',
                    'min-h-[140px]'
                  )}
                >
                  <div className="flex items-center gap-2">
                    <div className="h-8 w-8 flex items-center justify-center bg-muted">
                      <Icon className="h-4 w-4 text-muted-foreground" />
                    </div>
                    <span className="text-sm font-semibold text-foreground">{name}</span>
                  </div>
                  <p className="text-xs text-muted-foreground line-clamp-3 flex-1">
                    {description}
                  </p>
                  <div className="flex items-center gap-2 text-[10px] uppercase tracking-wider text-muted-foreground">
                    {wordCount && <span>{wordCount}</span>}
                    {wordCount && <span className="opacity-50">·</span>}
                    <span>{categoryLabel}</span>
                  </div>
                </button>
              );
            })}
          </div>
        </div>

        {/* Footer */}
        <div className="border-t border-border px-5 py-3 flex items-center justify-between">
          <div className="text-[11px] text-muted-foreground">
            {t('templateGallery.tipFooter', 'Tip: save any note as a custom template via File → Save as new template.')}
          </div>
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                onSelectBlank?.();
                onOpenChange(false);
              }}
              data-testid="template-gallery-blank"
            >
              {t('templateGallery.startBlank', 'Start blank')}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => onOpenChange(false)}
              data-testid="template-gallery-close"
            >
              {t('common.close', 'Close')}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
};

export default TemplateGallery;
