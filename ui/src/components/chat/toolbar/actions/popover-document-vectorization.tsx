import { useEffect, useState } from 'react';
import { CircleHelp, Loader2, RotateCcw } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogPortal,
  DialogTitle,
} from '@/components/ui/dialog.tsx';
import { Button } from '@/components/ui/button.tsx';
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@/components/ui/accordion.tsx';
import { Slider } from '@/components/ui/slider.tsx';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select.tsx';
import {
  getEmbeddingSettings,
  saveEmbeddingSettings,
  getDocumentProcessingSettings,
  saveDocumentProcessingSettings,
} from '@/lib/api-settings';
import { toast } from '@/lib/toast-compat';
import { useTranslation } from 'react-i18next';
import { useIsMobileOrTabletPortrait } from '@/hooks/use-mobile';
import { cn } from '@/lib/utils';

interface EmbeddingSettings {
  embedding_model: string;
}

interface DocumentProcessingSettings {
  splitter_type: string;
  chunk_size: number;
  chunk_overlap: number;
  chunk_sizes_to_ignore: number;
  retriever_type: string;
}

interface PopoverDocumentVectorizationProps {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  insidePopover?: boolean;
  disableBlur?: boolean;
}

const defaultEmbeddingSettings: EmbeddingSettings = {
  embedding_model: '', // Will be set dynamically from available models
};

const defaultProcessingSettings: DocumentProcessingSettings = {
  splitter_type: 'enhanced_markdown',
  chunk_size: 512,
  chunk_overlap: 50,
  chunk_sizes_to_ignore: 20,
  retriever_type: 'ensemble',
};

export function PopoverDocumentVectorization({
  open,
  onOpenChange,
  insidePopover = false,
  disableBlur = false,
}: PopoverDocumentVectorizationProps) {
  const [embeddingSettings, setEmbeddingSettings] =
    useState<EmbeddingSettings>(defaultEmbeddingSettings);
  const [processingSettings, setProcessingSettings] =
    useState<DocumentProcessingSettings>(defaultProcessingSettings);
  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const { t } = useTranslation();
  const isMobileOrTabletPortrait = useIsMobileOrTabletPortrait();

  // Load settings from the backend when opened
  useEffect(() => {
    if (open) {
      void loadSettings();
    }
  }, [open]);

  const loadSettings = async () => {
    try {
      setIsLoading(true);
      
      // Load embedding settings
      const savedEmbeddingSettings = await getEmbeddingSettings();
      if (savedEmbeddingSettings) {
        const formattedEmbeddingSettings: EmbeddingSettings = {
          embedding_model:
            savedEmbeddingSettings.embedding_model || defaultEmbeddingSettings.embedding_model,
        };
        setEmbeddingSettings(formattedEmbeddingSettings);
      }
      
      // Load document processing settings
      const savedProcessingSettings = await getDocumentProcessingSettings();
      if (savedProcessingSettings) {
        const formattedProcessingSettings: DocumentProcessingSettings = {
          splitter_type: savedProcessingSettings.splitter_type || defaultProcessingSettings.splitter_type,
          chunk_size: savedProcessingSettings.chunk_size || defaultProcessingSettings.chunk_size,
          chunk_overlap: savedProcessingSettings.chunk_overlap || defaultProcessingSettings.chunk_overlap,
          chunk_sizes_to_ignore: savedProcessingSettings.chunk_sizes_to_ignore || defaultProcessingSettings.chunk_sizes_to_ignore,
          retriever_type: savedProcessingSettings.retriever_type || defaultProcessingSettings.retriever_type,
        };
        setProcessingSettings(formattedProcessingSettings);
      }
    } catch (error) {
      console.error('Error loading settings:', error);
      // Don't show toast here as it would be annoying on every dialog opening
    } finally {
      setIsLoading(false);
    }
  };

  const handleEmbeddingChange = (
    key: keyof EmbeddingSettings,
    value: string
  ) => {
    setEmbeddingSettings({ ...embeddingSettings, [key]: value });
  };

  const handleProcessingChange = (
    key: keyof DocumentProcessingSettings,
    value: string | number
  ) => {
    setProcessingSettings({ ...processingSettings, [key]: value });
  };

  const resetProcessingSetting = (
    key: keyof DocumentProcessingSettings,
    defaultValue: string | number
  ) => {
    handleProcessingChange(key, defaultValue);
  };

  const saveSettings = async () => {
    try {
      setIsSaving(true);
      
      // Save both embedding and processing settings
      await Promise.all([
        saveEmbeddingSettings(embeddingSettings),
        saveDocumentProcessingSettings(processingSettings)
      ]);

      if (onOpenChange) {
        onOpenChange(false);
      }

      toast.success(t('general.successMessages.settingsSaved'));
    } catch (error) {
      console.error('Error saving settings:', error);
      toast.error(t('general.errors.saveFailed') + ' settings');
    } finally {
      setIsSaving(false);
    }
  };

  const content = (
    <div className={`${insidePopover ? 'p-4' : ''} bg-card dark:bg-zinc-950`}>
      {!insidePopover && (
        <DialogHeader>
          <DialogTitle className='text-base text-zinc-800 dark:text-white font-semibold'>
            {t('popovers.documentVectorization.title') || 'Document Vectorization Settings'}
          </DialogTitle>
        </DialogHeader>
      )}

      {isLoading ? (
        <div className='flex items-center justify-center py-12'>
          <Loader2 className='h-6 w-6 animate-spin text-zinc-400' />
          <span className='ml-3 text-sm text-zinc-500 dark:text-zinc-400'>
            {t('general.loading') || 'Loading settings...'}
          </span>
        </div>
      ) : (
        <>
          <Accordion
            type='single'
            collapsible
            defaultValue='basic'
            className='w-full'
          >
            <AccordionItem
              value='basic'
              className='border-zinc-300 dark:border-zinc-800'
            >
              <AccordionTrigger className='text-sm py-3 px-3 text-zinc-800 dark:text-white font-semibold'>
                {t('popovers.documentVectorization.basicOptions') || 'Basic Options'}
              </AccordionTrigger>
              <AccordionContent>
                <div className='space-y-4 bg-zinc-100 dark:bg-zinc-900 p-4'>
                  <div className='space-y-3'>
                    <div className='flex items-center'>
                      <span className='text-zinc-800 dark:text-white text-sm'>
                        {t('popovers.documentVectorization.embeddingModel') || 'Embedding Model'}
                      </span>
                      <CircleHelp className='h-4 w-4 text-zinc-500 dark:text-zinc-400 ml-2' />
                    </div>

                    <Select
                      value={embeddingSettings.embedding_model}
                      onValueChange={value =>
                        handleEmbeddingChange('embedding_model', value)
                      }
                    >
                      <SelectTrigger className='w-full h-9 text-sm'>
                        <SelectValue placeholder='Select embedding model' />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value='Multilingual E5 Large Instruct'>
                          Multilingual E5 Large Instruct
                        </SelectItem>
                        <SelectItem value='Multilingual E5 Base v2'>
                          Multilingual E5 Base v2
                        </SelectItem>
                        <SelectItem value='E5 Large v2'>E5 Large v2</SelectItem>
                        <SelectItem value='all-MiniLM-L6-v2'>
                          all-MiniLM-L6-v2
                        </SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  <div className='space-y-3'>
                    <div className='flex items-center'>
                      <span className='text-zinc-800 dark:text-white text-sm'>
                        Splitter Type
                      </span>
                      <CircleHelp className='h-4 w-4 text-zinc-500 dark:text-zinc-400 ml-2' />
                    </div>

                    <Select
                      value={processingSettings.splitter_type}
                      onValueChange={value =>
                        handleProcessingChange('splitter_type', value)
                      }
                    >
                      <SelectTrigger className='w-full h-9 text-sm'>
                        <SelectValue placeholder='Select splitter type' />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value='enhanced_markdown'>Enhanced Markdown</SelectItem>
                        <SelectItem value='recursive'>Recursive</SelectItem>
                        <SelectItem value='token'>Token</SelectItem>
                        <SelectItem value='character'>Character</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  <div className='space-y-3'>
                    <div className='flex items-center'>
                      <span className='text-zinc-800 dark:text-white text-sm'>
                        Chunk Size
                      </span>
                      <CircleHelp className='h-4 w-4 text-zinc-500 dark:text-zinc-400 ml-2' />
                    </div>

                    <div className='flex items-center gap-3'>
                      <Slider
                        value={[processingSettings.chunk_size]}
                        min={100}
                        max={2048}
                        step={16}
                        className='flex-1'
                        onValueChange={value =>
                          handleProcessingChange('chunk_size', value[0])
                        }
                      />
                      <Button
                        size='icon'
                        variant='ghost'
                        className='h-7 w-7 rounded-full text-zinc-500 hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-300'
                        onClick={() => resetProcessingSetting('chunk_size', 512)}
                      >
                        <RotateCcw className='h-4 w-4' />
                      </Button>
                      <span className='w-14 text-right text-zinc-800 dark:text-white text-sm'>
                        {processingSettings.chunk_size}
                      </span>
                    </div>
                  </div>

                  <div className='space-y-3'>
                    <div className='flex items-center'>
                      <span className='text-zinc-800 dark:text-white text-sm'>
                        Chunk Overlap
                      </span>
                      <CircleHelp className='h-4 w-4 text-zinc-500 dark:text-zinc-400 ml-2' />
                    </div>

                    <div className='flex items-center gap-3'>
                      <Slider
                        value={[processingSettings.chunk_overlap]}
                        min={0}
                        max={200}
                        step={5}
                        className='flex-1'
                        onValueChange={value =>
                          handleProcessingChange('chunk_overlap', value[0])
                        }
                      />
                      <Button
                        size='icon'
                        variant='ghost'
                        className='h-7 w-7 rounded-full text-zinc-500 hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-300'
                        onClick={() => resetProcessingSetting('chunk_overlap', 50)}
                      >
                        <RotateCcw className='h-4 w-4' />
                      </Button>
                      <span className='w-14 text-right text-zinc-800 dark:text-white text-sm'>
                        {processingSettings.chunk_overlap}
                      </span>
                    </div>
                  </div>

                  <div className='space-y-3'>
                    <div className='flex items-center'>
                      <span className='text-zinc-800 dark:text-white text-sm'>
                        Min Chunk Size to Keep
                      </span>
                      <CircleHelp className='h-4 w-4 text-zinc-500 dark:text-zinc-400 ml-2' />
                    </div>

                    <div className='flex items-center gap-3'>
                      <Slider
                        value={[processingSettings.chunk_sizes_to_ignore]}
                        min={0}
                        max={100}
                        step={5}
                        className='flex-1'
                        onValueChange={value =>
                          handleProcessingChange('chunk_sizes_to_ignore', value[0])
                        }
                      />
                      <Button
                        size='icon'
                        variant='ghost'
                        className='h-7 w-7 rounded-full text-zinc-500 hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-300'
                        onClick={() =>
                          resetProcessingSetting('chunk_sizes_to_ignore', 20)
                        }
                      >
                        <RotateCcw className='h-4 w-4' />
                      </Button>
                      <span className='w-14 text-right text-zinc-800 dark:text-white text-sm'>
                        {processingSettings.chunk_sizes_to_ignore}
                      </span>
                    </div>
                  </div>

                </div>
              </AccordionContent>
            </AccordionItem>
          </Accordion>

          <div className='flex justify-end mt-4 pt-3'>
            <Button
              variant='secondary'
              size='sm'
              className='h-9 text-sm bg-zinc-100 hover:bg-zinc-200 dark:bg-transparent dark:hover:bg-zinc-800 text-zinc-800 dark:text-white border border-zinc-300 dark:border-zinc-700'
              onClick={saveSettings}
              disabled={isSaving}
            >
              {isSaving ? (
                <>
                  <Loader2 className='h-4 w-4 mr-2 animate-spin' />
                  {t('general.saving') || 'Saving...'}
                </>
              ) : (
                t('general.save') || 'Save Settings'
              )}
            </Button>
          </div>
        </>
      )}
    </div>
  );

  return (
    <>
      {insidePopover ? (
        content
      ) : (
        <>
          <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogPortal>
              {!disableBlur && (
                <div className='fixed inset-0 z-[90] bg-black/80 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0' />
              )}
              <DialogContent
                className={cn(
                  'overflow-y-auto',
                  isMobileOrTabletPortrait
                    ? 'h-full max-h-[100vh] max-w-full rounded-none !inset-0 !left-0 !top-0 !translate-x-0 !translate-y-0 !transform-none'
                    : 'sm:max-w-[350px] max-h-[85vh]'
                )}
                hideCloseButton={isMobileOrTabletPortrait}
                forceMobileBackButton={isMobileOrTabletPortrait}
                dialogOpen={open}
                onOpenChange={onOpenChange}
              >
                <DialogTitle className='sr-only'>
                  {t('popovers.documentVectorization.title')}
                </DialogTitle>
                <DialogDescription className='sr-only'>
                  Configure document vectorization and processing settings
                </DialogDescription>
                {content}
              </DialogContent>
            </DialogPortal>
          </Dialog>
        </>
      )}
    </>
  );
}
