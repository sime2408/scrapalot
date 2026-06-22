import React from 'react';
import { Button } from '@/components/ui/button.tsx';
import { Input } from '@/components/ui/input.tsx';
import { Label } from '@/components/ui/label.tsx';
import { Checkbox } from '@/components/ui/checkbox.tsx';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select.tsx';
import { RefreshCw, Search } from 'lucide-react';
import { ModelType } from '@/types/settings-types.ts';

interface ModelSelectionProps {
  selectedProvider: string;
  fetchedModels: Array<{
    id: string;
    name: string;
    model_type?: string;
    selected?: boolean;
  }>;
  selectedModels: string[];
  modelTypes: Record<string, ModelType>;
  modelSearchQuery: string;
  loading: boolean;
  loadingMore: boolean;
  hasMoreModels: boolean;
  currentPage: number;
  totalModels: number;
  onModelToggle: (model: string, checked: boolean) => void;
  onModelTypeChange: (model: string, type: ModelType) => void;
  onSearchChange: (query: string) => void;
  onSelectAll: (checked: boolean) => void;
  onLoadMore: () => void;
  onRefresh: () => void;
  getCurrentModels: () => string[];
}

export const ProviderModelSelection: React.FC<ModelSelectionProps> = ({
  selectedProvider: _selectedProvider,
  fetchedModels: _fetchedModels,
  selectedModels,
  modelTypes,
  modelSearchQuery,
  loading,
  loadingMore,
  hasMoreModels,
  currentPage,
  totalModels,
  onModelToggle,
  onModelTypeChange,
  onSearchChange,
  onSelectAll,
  onLoadMore,
  onRefresh,
  getCurrentModels,
}) => {
  const currentModels = getCurrentModels();

  return (
    <div>
      {/* Select All Checkboxes */}
      <div className='flex items-center gap-2'>
        <Checkbox
          id='selectAll'
          checked={
            selectedModels.length === currentModels.length &&
            selectedModels.length > 0
          }
          onCheckedChange={onSelectAll}
        />
        <Label
          htmlFor='selectAll'
          className='text-sm font-medium text-zinc-800 dark:text-white'
        >
          Select Models
        </Label>

        {/* Add refresh button for all providers */}
        <Button
          type='button'
          onClick={onRefresh}
          disabled={loading}
          variant='outline'
          size='sm'
          className='ml-auto'
          title='Refresh models from API'
        >
          <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
          Refresh
        </Button>
      </div>

      {/* Search Input */}
      <div className='relative mt-4'>
        <Search className='absolute left-3 top-1/2 transform -translate-y-1/2 text-zinc-400 h-4 w-4' />
        <Input
          type='text'
          placeholder='Search models...'
          value={modelSearchQuery}
          onChange={e => onSearchChange(e.target.value)}
          className='pl-10 bg-zinc-50 dark:bg-zinc-900 border-zinc-300 dark:border-zinc-700'
          data-testid='provider-model-search'
        />
      </div>

      {/* Models List */}
      <div className='mt-4 space-y-2 max-h-64 overflow-y-auto overflow-x-hidden' data-testid='provider-models-list'>
        {currentModels.length === 0 ? (
          <div className='text-center py-8 text-zinc-500 dark:text-zinc-400'>
            {modelSearchQuery.trim() !== ''
              ? `No models found matching "${modelSearchQuery}"`
              : 'No models available'}
          </div>
        ) : (
          currentModels.map(model => (
            <div
              key={model}
              className='flex items-center gap-3 p-3 border border-zinc-200 dark:border-zinc-800 min-w-0'
              data-testid={`provider-model-item-${model}`}
            >
              <Checkbox
                id={`model-${model}`}
                checked={selectedModels.includes(model)}
                onCheckedChange={checked =>
                  onModelToggle(model, checked as boolean)
                }
                className='flex-shrink-0'
              />
              <div className='flex-1 min-w-0 overflow-hidden'>
                <Label
                  htmlFor={`model-${model}`}
                  className='text-sm font-medium text-zinc-800 dark:text-white cursor-pointer block truncate'
                  title={model}
                >
                  {model}
                </Label>
              </div>
              <div className='flex-shrink-0'>
                <Select
                  value={modelTypes[model] || ModelType.NORMAL}
                  onValueChange={value =>
                    onModelTypeChange(model, value as ModelType)
                  }
                >
                  <SelectTrigger className='w-24 h-8 text-xs'>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className='z-[10001]'>
                    <SelectItem value={ModelType.NORMAL}>Normal</SelectItem>
                    <SelectItem value={ModelType.VISION}>Vision</SelectItem>
                    <SelectItem value={ModelType.AUDIO}>Audio</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
          ))
        )}
      </div>

      {/* Load More Button */}
      {hasMoreModels && (
        <div className='mt-4 text-center'>
          <Button
            type='button'
            onClick={onLoadMore}
            disabled={loadingMore}
            variant='outline'
            size='sm'
          >
            {loadingMore ? 'Loading...' : 'Load More'}
          </Button>
        </div>
      )}

      {/* Pagination Info */}
      {totalModels > 0 && (
        <div className='mt-4 text-xs text-zinc-500 dark:text-zinc-400 text-center'>
          Showing {currentModels.length} of {totalModels} models
          {currentPage > 1 && ` (Page ${currentPage})`}
        </div>
      )}
    </div>
  );
};
