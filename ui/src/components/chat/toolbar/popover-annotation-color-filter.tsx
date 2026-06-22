import React from 'react';
import { useTranslation } from 'react-i18next';
import { Palette, Check } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Button } from '@/components/ui/button';
import { ANNOTATION_COLORS } from '@/types/annotations';
import { cn } from '@/lib/utils';

interface AnnotationColorFilterPopoverProps {
  selectedColors: string[];
  onChange: (next: string[]) => void;
  disabled?: boolean;
}

export const AnnotationColorFilterPopover = ({
  selectedColors,
  onChange,
  disabled = false,
}: AnnotationColorFilterPopoverProps) => {
  const { t } = useTranslation();
  const isActive = selectedColors.length > 0;

  const toggle = (hex: string) => {
    const exists = selectedColors.includes(hex);
    onChange(exists ? selectedColors.filter((c) => c !== hex) : [...selectedColors, hex]);
  };

  const clear = () => onChange([]);

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          data-testid="annotation-color-filter-trigger"
          type="button"
          size="icon"
          variant="ghost"
          disabled={disabled}
          className={cn(
            'h-8 w-8 p-0 relative',
            isActive
              ? 'text-primary hover:text-primary'
              : 'text-muted-foreground hover:text-primary'
          )}
          aria-label={t('knowledge.annotations.colorFilter.trigger', 'Filter by annotation color')}
          title={t('knowledge.annotations.colorFilter.trigger', 'Filter by annotation color')}
        >
          <Palette className="h-4 w-4" />
          {isActive && (
            <span
              data-testid="annotation-color-filter-active-badge"
              className="absolute -top-0.5 -right-0.5 h-1.5 w-1.5 bg-primary rounded-full"
            />
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="start"
        collisionPadding={8}
        className="w-72 p-3 z-[1000000]"
        data-testid="annotation-color-filter-popover"
      >
        <div className="text-xs font-medium mb-2">
          {t('knowledge.annotations.colorFilter.title', 'Restrict to highlighted pages')}
        </div>
        <p className="text-[11px] text-muted-foreground mb-3 leading-snug">
          {t(
            'knowledge.annotations.colorFilter.description',
            'Pick the colors of your highlights to scope retrieval. Each color carries a per-color score boost.'
          )}
        </p>
        <div className="grid grid-cols-2 gap-1.5">
          {ANNOTATION_COLORS.map(({ hex, name, label }) => {
            const active = selectedColors.includes(hex);
            return (
              <button
                key={hex}
                type="button"
                data-testid={`annotation-color-filter-${name.toLowerCase()}`}
                onClick={() => toggle(hex)}
                className={cn(
                  'flex items-center gap-2 px-2 py-1.5 border text-left transition-colors',
                  active
                    ? 'border-primary bg-primary/5'
                    : 'border-border hover:border-muted-foreground/50'
                )}
              >
                <span
                  className="w-3.5 h-3.5 border border-border flex-shrink-0"
                  style={{ backgroundColor: hex }}
                />
                <span className="flex-1 min-w-0">
                  <span className="block text-xs font-medium truncate">{name}</span>
                  <span className="block text-[10px] text-muted-foreground truncate">
                    {label}
                  </span>
                </span>
                {active && <Check className="h-3.5 w-3.5 text-primary flex-shrink-0" />}
              </button>
            );
          })}
        </div>
        {isActive && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="w-full mt-3 h-7 text-xs"
            onClick={clear}
            data-testid="annotation-color-filter-clear"
          >
            {t('knowledge.annotations.colorFilter.clear', 'Clear filter')}
          </Button>
        )}
      </PopoverContent>
    </Popover>
  );
};
