import { useEffect, useState, useCallback, useRef } from 'react';
import { CircleHelp, Loader2, MessageSquare, RotateCcw } from 'lucide-react';
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
import { ModelSettings, PromptTemplate } from '@/types';
import { PopoverPromptSelector } from '@/components/chat/toolbar/actions/popover-prompt-selector.tsx';
import { getModelSettings, saveModelSettings } from '@/lib/api-settings';
import { useTranslation } from 'react-i18next';


import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';

function SettingHelp({ text }: { text: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <CircleHelp className='h-3 w-3 sm:h-4 sm:w-4 text-zinc-500 dark:text-zinc-400 ml-2 cursor-help' />
      </TooltipTrigger>
      <TooltipContent side='top' className='max-w-[240px] text-xs'>
        {text}
      </TooltipContent>
    </Tooltip>
  );
}

interface PopoverModelSettingsProps {
  settings: ModelSettings;
  onSettingsChange: (settings: ModelSettings) => void;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  insidePopover?: boolean;
  chatId?: string;
}

export function PopoverModelSettings({
  open,
  onOpenChange,
  settings,
  onSettingsChange,
  insidePopover = false,
  chatId,
}: PopoverModelSettingsProps) {
  const { t } = useTranslation();
  const [localSettings, setLocalSettings] = useState<ModelSettings>(settings);
  const [showPromptsDialog, setShowPromptsDialog] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const hasLoadedRef = useRef(false);

  // Auto-save functionality
  const saveTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);

  // Sync local settings when props change (e.g., from context or parent)
  // Only update if we're not in the middle of editing
  useEffect(() => {
    if (settings && !hasUnsavedChanges) {
      const settingsChanged = JSON.stringify(settings) !== JSON.stringify(localSettings);
      if (settingsChanged) {
        setLocalSettings(settings);
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- deps are intentionally limited
  }, [settings, hasUnsavedChanges]);

  // Load settings from backend only once on mount or when chatId changes
  useEffect(() => {
    // Only load from backend if we haven't loaded yet, or chatId changes
    if (!hasLoadedRef.current) {
      void loadSettings();
      hasLoadedRef.current = true;
    } else if (chatId) {
      // Reload when chatId changes (switching conversations)
      void loadSettings();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- deps are intentionally limited
  }, [chatId]);

  const loadSettings = async () => {
    try {
      setIsLoading(true);
      const savedSettings = await getModelSettings(chatId);
      if (savedSettings) {
        // Convert backend naming conventions to frontend format, parsing numbers
        const num = (v: unknown, fallback: number) => {
          const n = Number(v);
          return Number.isFinite(n) ? n : fallback;
        };
        const formattedSettings: ModelSettings = {
          temperature: num(savedSettings.temperature, 0.1),
          maxOutputTokens: num(
            savedSettings.max_output_tokens ?? savedSettings.maxOutputTokens,
            8000,
          ),
          topP: num(savedSettings.top_p ?? savedSettings.topP, 0.9),
          topK: num(savedSettings.top_k ?? savedSettings.topK, 40),
          frequencyPenalty: num(
            savedSettings.frequency_penalty ?? savedSettings.frequencyPenalty,
            0.5,
          ),
          presencePenalty: num(
            savedSettings.presence_penalty ?? savedSettings.presencePenalty,
            0.5,
          ),
          contextWindowSize: num(
            savedSettings.context_window_size ?? savedSettings.contextWindowSize,
            256000,
          ),
          contextMessageLimit: num(
            savedSettings.context_message_limit ?? savedSettings.contextMessageLimit,
            30,
          ),
          gpuLayers: num(savedSettings.gpu_layers ?? savedSettings.gpuLayers, -1),
          modelInstructions:
            savedSettings.model_instructions ??
            savedSettings.modelInstructions ??
            'You are a helpful assistant.',
        };

        setLocalSettings(formattedSettings);
        onSettingsChange(formattedSettings);
      }
    } catch (error) {
      console.error('Error loading model settings:', error);
      
      // Check if this is a backend validation error and provide better error handling
      if (error?.response?.status === 422 || error?.response?.status >= 500) {
        console.warn('Backend model settings API error - using default settings');
        // Use default settings when backend has validation errors
        const defaultSettings: ModelSettings = {
          temperature: 0.1,
          maxOutputTokens: 8000,
          topP: 0.9,
          topK: 40,
          frequencyPenalty: 0.5,
          presencePenalty: 0.5,
          contextWindowSize: 256000,
          contextMessageLimit: 30,
          gpuLayers: -1,
          modelInstructions: 'You are a helpful assistant.',
        };
        setLocalSettings(defaultSettings);
        onSettingsChange(defaultSettings);
      } else {
        // Use props as fallback for other types of errors
        setLocalSettings(settings);
      }
    } finally {
      setIsLoading(false);
    }
  };

  // Auto-save function with debouncing
  const autoSave = useCallback(async (settingsToSave: ModelSettings) => {
    try {
      setIsSaving(true);
      await saveModelSettings(settingsToSave, chatId);
      setHasUnsavedChanges(false);
    } catch (error) {
      console.error('Error auto-saving model settings:', error);
      
      // Handle backend validation errors gracefully
      if (error?.response?.status === 422) {
        console.warn('Backend validation error when saving model settings - continuing with local state');
        // Don't reset unsaved changes flag for validation errors
        // User can continue editing and we'll retry save later
      } else if (error?.response?.status >= 500) {
        console.warn('Backend server error when saving model settings - will retry later');
        // Keep unsaved changes flag for server errors so we can retry
      } else {
        // For other errors, consider them saved to avoid infinite retry
        setHasUnsavedChanges(false);
      }
    } finally {
      setIsSaving(false);
    }
  }, [chatId]);

  const handleSettingChange = (
    key: keyof ModelSettings,
    value: number | string
  ) => {
    const newSettings = { ...localSettings, [key]: value };
    setLocalSettings(newSettings);
    onSettingsChange(newSettings);
    setHasUnsavedChanges(true);

    // Debounced auto-save
    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current);
    }
    
    saveTimeoutRef.current = setTimeout(() => {
      void autoSave(newSettings);
    }, 1000); // Save after 1 second of inactivity
  };

  const resetSetting = (key: keyof ModelSettings, defaultValue: number) => {
    handleSettingChange(key, defaultValue);
  };


  const handlePromptSelect = (template: PromptTemplate) => {
    handleSettingChange('modelInstructions', template.content);
    setShowPromptsDialog(false);
  };

  // Cleanup timeout on unmount
  useEffect(() => {
    return () => {
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current);
      }
    };
  }, []);

  // Save any pending changes when the popover closes
  useEffect(() => {
    if (!open && hasUnsavedChanges && saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current);
      void autoSave(localSettings);
    }
  }, [open, hasUnsavedChanges, localSettings, autoSave]);

  const content = (
    <TooltipProvider delayDuration={300}>
    <div className={`w-full max-w-[520px] text-sm sm:text-sm text-xs ${insidePopover ? 'p-4' : ''} bg-card dark:bg-zinc-950`}>
      {!insidePopover && (
        <DialogHeader>
          <DialogTitle className='text-base text-zinc-800 dark:text-white font-semibold'>
            {t('popovers.modelSettings.title')}
          </DialogTitle>
        </DialogHeader>
      )}

      {isLoading ? (
        <div className='flex items-center justify-center py-12'>
          <Loader2 className='h-6 w-6 animate-spin text-zinc-400' />
          <span className='ml-3 text-sm text-zinc-500 dark:text-zinc-400'>
            {t('popovers.modelSettings.loading')}
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
              className='border-b-0'
            >
              <AccordionTrigger data-testid="chat-settings-basic-accordion" className='text-xs sm:text-sm py-3 px-3 text-zinc-800 dark:text-white font-semibold'>
                {t('popovers.modelSettings.basicOptions')}
              </AccordionTrigger>
              <AccordionContent>
                <div className='space-y-4 bg-zinc-100 dark:bg-zinc-900 p-4'>
                  <div className='space-y-3'>
                    <div className='flex items-center'>
                      <span className='text-zinc-800 dark:text-white text-xs sm:text-sm'>
                        {t('popovers.modelSettings.maxOutputTokens')}
                      </span>
                      <SettingHelp text={t('popovers.modelSettings.tooltip.maxOutputTokens', 'Maximum number of tokens the model can generate in a single response')} />
                    </div>

                    <div className='flex items-center gap-3'>
                      <Slider
                        value={[localSettings.maxOutputTokens]}
                        min={1}
                        max={16000}
                        step={1}
                        className='flex-1'
                        onValueChange={value =>
                          handleSettingChange('maxOutputTokens', value[0])
                        }
                      />
                      <Button
                        size='icon'
                        variant='ghost'
                        className='h-7 w-7 rounded-full text-zinc-500 hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-300'
                        onClick={() => resetSetting('maxOutputTokens', 8000)}
                      >
                        <RotateCcw className='h-4 w-4' />
                      </Button>
                      <span className='w-14 text-right text-zinc-800 dark:text-white text-xs sm:text-sm'>
                        {localSettings.maxOutputTokens}
                      </span>
                    </div>
                  </div>

                  <div className='space-y-3'>
                    <div className='flex items-center'>
                      <span className='text-zinc-800 dark:text-white text-xs sm:text-sm'>
                        {t('popovers.modelSettings.temperature')}
                      </span>
                      <SettingHelp text={t('popovers.modelSettings.tooltip.temperature', 'Controls randomness: lower values are more focused, higher values are more creative')} />
                    </div>

                    <div className='flex items-center gap-3'>
                      <Slider
                        value={[localSettings.temperature]}
                        min={0}
                        max={2}
                        step={0.1}
                        className='flex-1'
                        onValueChange={value =>
                          handleSettingChange('temperature', value[0])
                        }
                      />
                      <Button
                        size='icon'
                        variant='ghost'
                        className='h-7 w-7 rounded-full text-zinc-500 hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-300'
                        onClick={() => resetSetting('temperature', 0.1)}
                      >
                        <RotateCcw className='h-4 w-4' />
                      </Button>
                      <span className='w-14 text-right text-zinc-800 dark:text-white text-xs sm:text-sm'>
                        {localSettings.temperature.toFixed(1)}
                      </span>
                    </div>
                  </div>

                  <div className='space-y-3'>
                    <div className='flex items-center'>
                      <span className='text-zinc-800 dark:text-white text-xs sm:text-sm'>
                        {t('popovers.modelSettings.contextWindowSize')}
                      </span>
                      <SettingHelp text={t('popovers.modelSettings.tooltip.contextWindowSize', 'Maximum context size in tokens the model can process')} />
                    </div>

                    <div className='flex items-center gap-3'>
                      <Slider
                        value={[localSettings.contextWindowSize]}
                        min={1024}
                        max={1000000}
                        step={1024}
                        className='flex-1'
                        onValueChange={value =>
                          handleSettingChange('contextWindowSize', value[0])
                        }
                      />
                      <Button
                        size='icon'
                        variant='ghost'
                        className='h-7 w-7 rounded-full text-zinc-500 hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-300'
                        onClick={() =>
                          resetSetting('contextWindowSize', 256000)
                        }
                      >
                        <RotateCcw className='h-4 w-4' />
                      </Button>
                      <span className='w-14 text-right text-zinc-800 dark:text-white text-xs sm:text-sm'>
                        {localSettings.contextWindowSize}
                      </span>
                    </div>
                  </div>
                </div>
              </AccordionContent>
            </AccordionItem>

            <AccordionItem
              value='advanced'
              className='border-b-0'
            >
              <AccordionTrigger data-testid="chat-settings-advanced-accordion" className='text-xs sm:text-sm py-3 px-3 text-zinc-800 dark:text-white font-semibold'>
                {t('popovers.modelSettings.advancedOptions')}
              </AccordionTrigger>
              <AccordionContent>
                <div className='space-y-4 bg-zinc-100 dark:bg-zinc-900 p-4'>
                  <div className='space-y-3'>
                    <div className='flex items-center'>
                      <span className='text-zinc-800 dark:text-white text-xs sm:text-sm'>
                        {t('popovers.modelSettings.topP')}
                      </span>
                      <SettingHelp text={t('popovers.modelSettings.tooltip.topP', 'Nucleus sampling: only consider tokens within the top P probability mass')} />
                    </div>
                    <div className='flex items-center gap-3'>
                      <Slider
                        value={[localSettings.topP || 0.9]}
                        min={0}
                        max={1}
                        step={0.1}
                        className='flex-1'
                        onValueChange={value =>
                          handleSettingChange('topP', value[0])
                        }
                      />
                      <Button
                        size='icon'
                        variant='ghost'
                        className='h-7 w-7 rounded-full text-zinc-500 hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-300'
                        onClick={() => resetSetting('topP', 0.9)}
                      >
                        <RotateCcw className='h-4 w-4' />
                      </Button>
                      <span className='w-14 text-right text-zinc-800 dark:text-white text-xs sm:text-sm'>
                        {(localSettings.topP || 0.9).toFixed(1)}
                      </span>
                    </div>
                  </div>

                  <div className='space-y-3'>
                    <div className='flex items-center'>
                      <span className='text-zinc-800 dark:text-white text-xs sm:text-sm'>
                        {t('popovers.modelSettings.topK')}
                      </span>
                      <SettingHelp text={t('popovers.modelSettings.tooltip.topK', 'Only sample from the top K most likely tokens at each step')} />
                    </div>
                    <div className='flex items-center gap-3'>
                      <Slider
                        value={[localSettings.topK || 40]}
                        min={0}
                        max={100}
                        step={1}
                        className='flex-1'
                        onValueChange={value =>
                          handleSettingChange('topK', value[0])
                        }
                      />
                      <Button
                        size='icon'
                        variant='ghost'
                        className='h-7 w-7 rounded-full text-zinc-500 hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-300'
                        onClick={() => resetSetting('topK', 40)}
                      >
                        <RotateCcw className='h-4 w-4' />
                      </Button>
                      <span className='w-14 text-right text-zinc-800 dark:text-white text-xs sm:text-sm'>
                        {localSettings.topK || 40}
                      </span>
                    </div>
                  </div>

                  <div className='space-y-3'>
                    <div className='flex items-center'>
                      <span className='text-zinc-800 dark:text-white text-xs sm:text-sm'>
                        {t('popovers.modelSettings.frequencyPenalty')}
                      </span>
                      <SettingHelp text={t('popovers.modelSettings.tooltip.frequencyPenalty', 'Penalizes tokens based on how frequently they appear, reducing repetition')} />
                    </div>
                    <div className='flex items-center gap-3'>
                      <Slider
                        value={[localSettings.frequencyPenalty || 0.5]}
                        min={0}
                        max={2}
                        step={0.1}
                        className='flex-1'
                        onValueChange={value =>
                          handleSettingChange('frequencyPenalty', value[0])
                        }
                      />
                      <Button
                        size='icon'
                        variant='ghost'
                        className='h-7 w-7 rounded-full text-zinc-500 hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-300'
                        onClick={() => resetSetting('frequencyPenalty', 0.5)}
                      >
                        <RotateCcw className='h-4 w-4' />
                      </Button>
                      <span className='w-14 text-right text-zinc-800 dark:text-white text-xs sm:text-sm'>
                        {(localSettings.frequencyPenalty || 0.5).toFixed(1)}
                      </span>
                    </div>
                  </div>

                  <div className='space-y-3'>
                    <div className='flex items-center'>
                      <span className='text-zinc-800 dark:text-white text-xs sm:text-sm'>
                        {t('popovers.modelSettings.presencePenalty')}
                      </span>
                      <SettingHelp text={t('popovers.modelSettings.tooltip.presencePenalty', 'Penalizes tokens that have already appeared, encouraging topic diversity')} />
                    </div>
                    <div className='flex items-center gap-3'>
                      <Slider
                        value={[localSettings.presencePenalty || 0.5]}
                        min={0}
                        max={2}
                        step={0.1}
                        className='flex-1'
                        onValueChange={value =>
                          handleSettingChange('presencePenalty', value[0])
                        }
                      />
                      <Button
                        size='icon'
                        variant='ghost'
                        className='h-7 w-7 rounded-full text-zinc-500 hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-300'
                        onClick={() => resetSetting('presencePenalty', 0.5)}
                      >
                        <RotateCcw className='h-4 w-4' />
                      </Button>
                      <span className='w-14 text-right text-zinc-800 dark:text-white text-xs sm:text-sm'>
                        {(localSettings.presencePenalty || 0.5).toFixed(1)}
                      </span>
                    </div>
                  </div>

                  <div className='space-y-3'>
                    <div className='flex items-center'>
                      <span className='text-zinc-800 dark:text-white text-xs sm:text-sm'>
                        {t('popovers.modelSettings.gpuLayers')}
                      </span>
                      <SettingHelp text={t('popovers.modelSettings.tooltip.gpuLayers', 'Number of model layers to offload to GPU (-1 = all layers)')} />
                    </div>
                    <div className='flex items-center gap-3'>
                      <Slider
                        value={[localSettings.gpuLayers || -1]}
                        min={-1}
                        max={100}
                        step={1}
                        className='flex-1'
                        onValueChange={value =>
                          handleSettingChange('gpuLayers', value[0])
                        }
                      />
                      <Button
                        size='icon'
                        variant='ghost'
                        className='h-7 w-7 rounded-full text-zinc-500 hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-300'
                        onClick={() => resetSetting('gpuLayers', -1)}
                      >
                        <RotateCcw className='h-4 w-4' />
                      </Button>
                      <span className='w-14 text-right text-zinc-800 dark:text-white text-xs sm:text-sm'>
                        {localSettings.gpuLayers || -1}
                      </span>
                    </div>
                  </div>

                  <div className='space-y-3'>
                    <div className='flex items-center'>
                      <span className='text-zinc-800 dark:text-white text-xs sm:text-sm'>
                        {t('popovers.modelSettings.contextMessageLimit')}
                      </span>
                      <SettingHelp text={t('popovers.modelSettings.tooltip.contextMessageLimit', 'Maximum number of previous messages included in context')} />
                    </div>
                    <div className='flex items-center gap-3'>
                      <Slider
                        value={[localSettings.contextMessageLimit || 30]}
                        min={1}
                        max={100}
                        step={1}
                        className='flex-1'
                        onValueChange={value =>
                          handleSettingChange('contextMessageLimit', value[0])
                        }
                      />
                      <Button
                        size='icon'
                        variant='ghost'
                        className='h-7 w-7 rounded-full text-zinc-500 hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-300'
                        onClick={() => resetSetting('contextMessageLimit', 30)}
                      >
                        <RotateCcw className='h-4 w-4' />
                      </Button>
                      <span className='w-14 text-right text-zinc-800 dark:text-white text-xs sm:text-sm'>
                        {localSettings.contextMessageLimit || 30}
                      </span>
                    </div>
                  </div>

                  <div className='space-y-3'>
                    <div className='flex items-center'>
                      <span className='text-zinc-800 dark:text-white text-xs sm:text-sm'>
                        {t('popovers.modelSettings.extraModelParameters')}
                      </span>
                      <SettingHelp text={t('popovers.modelSettings.tooltip.extraModelParameters', 'Additional JSON parameters passed directly to the model API')} />
                    </div>
                    <div className='w-full'>
                      <textarea
                        placeholder={t(
                          'popovers.modelSettings.extraModelParametersPlaceholder'
                        )}
                        className='w-full h-24 bg-zinc-50 dark:bg-zinc-800 border border-zinc-300 dark:border-zinc-700 p-2 text-sm text-zinc-800 dark:text-white placeholder:text-zinc-500 focus:outline-none focus:ring-1 focus:ring-zinc-400 dark:focus:ring-zinc-600'
                        value={localSettings.extraModelParameters || ''}
                        onChange={e =>
                          handleSettingChange(
                            'extraModelParameters',
                            e.target.value
                          )
                        }
                      />
                    </div>
                  </div>
                </div>
              </AccordionContent>
            </AccordionItem>

            <AccordionItem
              value='instructions'
              className='border-b-0'
            >
              <AccordionTrigger data-testid="chat-settings-instructions-accordion" className='text-xs sm:text-sm py-3 px-3 text-zinc-800 dark:text-white font-semibold'>
                {t('popovers.modelSettings.modelInstructions')}
              </AccordionTrigger>
              <AccordionContent>
                <div className='space-y-4 bg-zinc-100 dark:bg-zinc-900 p-4'>
                  <div className='relative'>
                    <textarea
                      placeholder={t(
                        'popovers.modelSettings.modelInstructionsPlaceholder'
                      )}
                      value={
                        localSettings.modelInstructions ||
                        'You are a helpful assistant.'
                      }
                      onChange={e =>
                        handleSettingChange('modelInstructions', e.target.value)
                      }
                      className='w-full h-32 bg-zinc-50 dark:bg-zinc-800 border border-zinc-300 dark:border-zinc-700 p-2 text-sm text-zinc-800 dark:text-white placeholder:text-zinc-500 focus:outline-none focus:ring-1 focus:ring-zinc-400 dark:focus:ring-zinc-600'
                    />
                    <button
                      className='absolute left-2 bottom-2 text-zinc-500 hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-300'
                      onClick={() => {
                        setShowPromptsDialog(true);
                      }}
                    >
                      <MessageSquare className='h-4 w-4' />
                    </button>
                  </div>
                </div>
              </AccordionContent>
            </AccordionItem>
          </Accordion>

          {/* Auto-save status indicator */}
          {(isSaving || hasUnsavedChanges) && (
            <div className='flex items-center gap-2 text-xs text-zinc-500 dark:text-zinc-400 mt-4'>
              {isSaving ? (
                <>
                  <Loader2 className='h-3 w-3 animate-spin' />
                  <span>{t('popovers.modelSettings.saving')}</span>
                </>
              ) : (
                <span>{t('popovers.modelSettings.autoSaveIn')}</span>
              )}
            </div>
          )}
        </>
      )}
    </div>
    </TooltipProvider>
  );

  return (
    <>
      {insidePopover ? (
        content
      ) : (
        <>
          <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogPortal>
              <DialogContent
                className='overflow-y-auto sm:max-w-[350px] max-h-[85vh]'
                disableFullscreenOnMobile
                dialogOpen={open}
                onOpenChange={onOpenChange}
              >
                <DialogTitle className='sr-only'>
                  {t('popovers.modelSettings.title')}
                </DialogTitle>
                <DialogDescription className='sr-only'>
                  Configure AI model parameters and settings
                </DialogDescription>
                {content}
              </DialogContent>
            </DialogPortal>
          </Dialog>

          <Dialog open={showPromptsDialog} onOpenChange={setShowPromptsDialog}>
            <DialogPortal>
              <DialogContent
                className='overflow-y-auto sm:max-w-[350px] max-h-[85vh]'
                disableFullscreenOnMobile
                dialogOpen={showPromptsDialog}
                onOpenChange={setShowPromptsDialog}
              >
                <DialogHeader>
                  <DialogTitle className='text-base text-zinc-800 dark:text-white font-semibold'>
                    {t('popovers.modelSettings.selectPromptTemplate')}
                  </DialogTitle>
                  <DialogDescription className='sr-only'>
                    Select a prompt template for your conversation
                  </DialogDescription>
                </DialogHeader>
                <PopoverPromptSelector
                  onSelect={handlePromptSelect}
                />
              </DialogContent>
            </DialogPortal>
          </Dialog>
        </>
      )}
    </>
  );
}
