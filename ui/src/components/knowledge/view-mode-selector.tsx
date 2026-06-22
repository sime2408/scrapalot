import { ChevronDown, Eye, Grid, List, Table } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { ViewMode, SortField, SortDirection } from '@/types/file-attachments';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Button } from '@/components/ui/button';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';

interface ViewModeSelectorProps {
  viewMode: ViewMode;
  onViewModeChange: (mode: ViewMode) => void;
  sortField: SortField;
  sortDirection: SortDirection;
  onSortChange: (field: SortField, direction: SortDirection) => void;
  isCompact?: boolean;
  onPreview?: () => void;
}

export function ViewModeSelector({
  viewMode,
  onViewModeChange,
  sortField,
  sortDirection,
  onSortChange,
  isCompact = false,
  onPreview,
}: ViewModeSelectorProps) {
  const { t } = useTranslation();

  const viewModes = [
    {
      mode: 'list' as ViewMode,
      icon: List,
      label: t('knowledge.viewMode.list', 'List'),
    },
    {
      mode: 'details' as ViewMode,
      icon: Table,
      label: t('knowledge.viewMode.details', 'Details'),
    },
    {
      mode: 'thumbnails' as ViewMode,
      icon: Grid,
      label: t('knowledge.viewMode.thumbnails', 'Thumbnails'),
    },
  ];

  const sortFields = [
    { field: 'status' as SortField, label: t('knowledge.sort.status', 'Status') },
    { field: 'name' as SortField, label: t('knowledge.sort.name', 'Name') },
    { field: 'date' as SortField, label: t('knowledge.sort.date', 'Date modified') },
    { field: 'size' as SortField, label: t('knowledge.sort.size', 'Size') },
    { field: 'type' as SortField, label: t('knowledge.sort.type', 'Type') },
  ];

  return (
    <div data-testid="knowledge-view-mode-selector" className="flex items-center gap-1">
      {/* View Mode Buttons */}
      <div className="flex rounded-md border border-zinc-200 dark:border-zinc-700 overflow-hidden">
        <TooltipProvider>
          {viewModes.map(({ mode, icon: Icon, label }) => (
            <Tooltip key={mode} delayDuration={300}>
              <TooltipTrigger asChild>
                <button
                  data-testid={`knowledge-view-mode-${mode}`}
                  onClick={() => onViewModeChange(mode)}
                  className={cn(
                    'p-1.5 transition-colors',
                    viewMode === mode
                      ? 'bg-zinc-200 dark:bg-zinc-700 text-zinc-900 dark:text-zinc-100'
                      : 'text-zinc-500 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800/50'
                  )}
                  aria-label={label}
                >
                  <Icon className="h-3.5 w-3.5" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom">
                <p className="text-xs">{label}</p>
              </TooltipContent>
            </Tooltip>
          ))}
        </TooltipProvider>
      </div>

      {/* Preview Button */}
      {onPreview && (
        <TooltipProvider>
          <Tooltip delayDuration={300}>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                onClick={onPreview}
                className="flex h-7 px-2 text-xs text-zinc-500 dark:text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-300"
                aria-label={t('knowledge.preview.button', 'Preview')}
              >
                <Eye className="h-3.5 w-3.5 mr-1" />
                <span>{t('knowledge.preview.button', 'Preview')}</span>
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              <p className="text-xs">{t('knowledge.preview.tooltip', 'Preview PDF/EPUB')}</p>
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      )}

      {/* Sort Dropdown - Hidden on compact mode and small screens */}
      {!isCompact && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              className="flex h-7 px-2 text-xs text-zinc-500 dark:text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-300"
            >
              <span className="mr-1">
                {t('knowledge.sort.sortBy', 'Sort')}:
              </span>
              <span className="font-medium text-zinc-700 dark:text-zinc-300">
                {sortFields.find((f) => f.field === sortField)?.label}
              </span>
              <ChevronDown className="ml-1 h-3 w-3" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-40 z-[1200]" sideOffset={5}>
            {sortFields.map(({ field, label }) => (
              <DropdownMenuItem
                key={field}
                onClick={() => onSortChange(field, sortDirection)}
                className={cn(
                  'text-xs',
                  sortField === field && 'bg-zinc-100 dark:bg-zinc-800'
                )}
              >
                {label}
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onClick={() => onSortChange(sortField, 'asc')}
              className={cn(
                'text-xs',
                sortDirection === 'asc' && 'bg-zinc-100 dark:bg-zinc-800'
              )}
            >
              {t('knowledge.sort.ascending', 'Ascending')}
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() => onSortChange(sortField, 'desc')}
              className={cn(
                'text-xs',
                sortDirection === 'desc' && 'bg-zinc-100 dark:bg-zinc-800'
              )}
            >
              {t('knowledge.sort.descending', 'Descending')}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
}
