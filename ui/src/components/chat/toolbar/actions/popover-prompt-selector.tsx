import React from 'react';
import { PromptTemplate } from '@/types';
import { Button } from '../../../ui/button.tsx';
import {
  PencilIcon,
  Sparkles,
  FileText,
  Settings,
  Check,
  Ban,
} from 'lucide-react';
import { getPromptTemplates, saveActivePromptTemplate } from '@/lib/api-settings';
import { useTranslation } from 'react-i18next';
import { useAsyncData } from '@/hooks/use-async-data';
import { DataContainer } from '@/components/ui/data-container';
import { SearchableList } from '@/components/ui/searchable-list';

interface PopoverPromptSelectorProps {
  onSelect: (template: PromptTemplate) => void;
  disableBlur?: boolean;
  hideHeader?: boolean;
  fillHeight?: boolean;
  /** Title of the currently active template (managed by parent
   *  toolbar). Used to render a check mark and to support toggle
   *  semantics — clicking the active template invokes onSelect with
   *  the same one and the parent treats that as "deselect". */
  activeTemplateTitle?: string | null;
}

export const PopoverPromptSelector = ({
  onSelect,
  disableBlur = true,
  hideHeader = false,
  fillHeight = false,
  activeTemplateTitle = null,
}: PopoverPromptSelectorProps) => {
  const { t } = useTranslation();

  // Optional: Pass disableBlur to a root wrapper component if needed
  const WrapperComponent = disableBlur
    ? ({ children }: { children: React.ReactNode }) => (
      <div className='no-blur'>{children}</div>
    )
    : ({ children }: { children: React.ReactNode }) => <>{children}</>;

  const defaultTemplates: PromptTemplate[] = [
    {
      id: '1',
      title: t('popovers.promptSelector.defaultTemplates.aiAssistant.title'),
      content: t('popovers.promptSelector.defaultTemplates.aiAssistant.content'),
    },
    {
      id: '2',
      title: t('popovers.promptSelector.defaultTemplates.codeExpert.title'),
      content: t('popovers.promptSelector.defaultTemplates.codeExpert.content'),
    },
  ];

  const { data: templates, loading, error } = useAsyncData<PromptTemplate[]>(
    async () => {
      const response = await getPromptTemplates();
      const apiTemplates = response?.setting_value?.templates || [];
      if (apiTemplates && apiTemplates.length > 0) {
        return apiTemplates.map(
          (template: { name: string; content: string; examples?: { input: string; output: string }[] }, index: number) => ({
            id: index.toString(),
            title: template.name,
            content: template.content,
            examples: template.examples,
          })
        );
      }
      return defaultTemplates;
    },
    { deps: [] }
  );

  const templateList = templates ?? defaultTemplates;

  const loadingSkeleton = (
    <div className='p-3 space-y-3'>
      {[1, 2, 3].map((i) => (
        <div key={i} className='p-3 border border-border rounded-sm'>
          <div className='space-y-3'>
            <div className='h-4 bg-muted rounded w-3/4 skeleton-shimmer' />
            <div className='h-3 bg-muted rounded w-full skeleton-shimmer' />
          </div>
        </div>
      ))}
    </div>
  );

  return (
    <WrapperComponent>
      <div className={`w-full p-4 text-sm ${fillHeight ? 'flex flex-col h-full' : ''}`}>
        {/* Header Section - hidden when used inside Dialog with its own header */}
        {!hideHeader && (
          <div className='flex items-center gap-3 pb-3 border-b mb-4 flex-shrink-0'>
            <Sparkles className='h-4 w-4 text-primary' />
            <h2 className='text-base font-semibold text-foreground'>
              {t('popovers.promptSelector.title') || 'Prompt Templates'}
            </h2>
          </div>
        )}

        {/* Templates List */}
        <div className={fillHeight ? 'flex-1 min-h-0 mb-4' : 'mb-4'}>
          <div className={`${fillHeight ? 'h-full' : 'max-h-[280px] min-h-[100px]'} overflow-y-auto border border-zinc-200 dark:border-zinc-800 rounded-md bg-card dark:bg-zinc-950`}>
            <DataContainer
              loading={loading}
              error={error}
              empty={!loading && !error && templateList.length === 0}
              emptyMessage='No templates available'
              skeleton={loadingSkeleton}
            >
              <SearchableList
                items={templateList}
                searchBy='title'
                placeholder={t('popovers.promptSelector.searchPlaceholder') || 'Search templates...'}
                emptyMessage='No templates found'
                inputTestId='chat-prompt-search-input'
                className='p-3'
                renderItem={(template) => {
                  const isActive = activeTemplateTitle === template.title;
                  return (
                    <div
                      key={template.id}
                      data-testid={`chat-prompt-template-item-${template.id}`}
                      onClick={() => {
                        onSelect(template);
                        saveActivePromptTemplate({
                          title: template.title,
                          content: template.content,
                          examples: template.examples,
                        }).catch(err => console.error('Failed to save active template:', err));
                      }}
                      className={`group p-3 rounded-md transition-all duration-200 cursor-pointer border ${
                        isActive
                          ? 'bg-primary/5 border-primary/40'
                          : 'border-transparent hover:bg-zinc-50 dark:hover:bg-zinc-900/50 hover:border-zinc-200 dark:hover:border-zinc-700'
                      }`}
                    >
                      <div className='flex items-start gap-3'>
                        <div className='flex-shrink-0 mt-0.5'>
                          {isActive ? (
                            <Check className='h-4 w-4 text-primary' />
                          ) : (
                            <FileText className='h-4 w-4 text-primary/60 group-hover:text-primary transition-colors' />
                          )}
                        </div>
                        <div className='flex-1 min-w-0'>
                          <h3 className='text-sm font-medium text-foreground mb-1 group-hover:text-primary transition-colors flex items-center gap-2'>
                            <span className='truncate'>{template.title}</span>
                            {template.examples && template.examples.length > 0 && (
                              <span className='flex-shrink-0 text-[10px] px-1.5 py-0.5 bg-amber-100 dark:bg-amber-900/50 text-amber-700 dark:text-amber-300 rounded'>
                                {template.examples.length} {template.examples.length === 1 ? 'example' : 'examples'}
                              </span>
                            )}
                          </h3>
                          <p className='text-xs text-muted-foreground line-clamp-2 leading-relaxed break-words'>
                            {template.content}
                          </p>
                        </div>
                      </div>
                    </div>
                  );
                }}
              />
            </DataContainer>
          </div>
        </div>

        {/* Actions */}
        <div className='border-t border-zinc-200 dark:border-zinc-800 pt-4 space-y-3 flex-shrink-0'>
          {activeTemplateTitle && (
            <Button
              variant='outline'
              className='w-full h-9 text-sm justify-start text-zinc-700 dark:text-zinc-300'
              data-testid='chat-prompt-clear-selection'
              onClick={() => {
                // Toggle off via the same callback the list items use —
                // parent compares to activeTemplateTitle and clears.
                const active = templateList.find(t => t.title === activeTemplateTitle);
                if (active) {
                  onSelect(active);
                  saveActivePromptTemplate(null).catch(err =>
                    console.error('Failed to clear active template:', err)
                  );
                }
              }}
            >
              <Ban className='h-4 w-4 mr-3' />
              {t('popovers.promptSelector.clearSelection', 'Clear selection')}
            </Button>
          )}

          <Button
            variant='outline'
            className='w-full h-9 text-sm justify-start'
          >
            <PencilIcon className='h-4 w-4 mr-3' />
            {t('popovers.promptSelector.editModelInstructions') || 'Edit model instructions'}
          </Button>

          <Button
            variant='ghost'
            className='w-full h-9 text-sm justify-start text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300'
          >
            <Settings className='h-4 w-4 mr-3' />
            {t('popovers.promptSelector.managePrompts') || 'Manage prompts...'}
          </Button>
        </div>
      </div>
    </WrapperComponent>
  );
};
