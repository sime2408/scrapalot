import { Info, Settings } from 'lucide-react';
import { useEffect, useState, useCallback, useRef } from 'react';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import {
  saveEmbeddingSettings,
  getEmbeddingSettings,
  saveDocumentProcessingSettings,
  getDocumentProcessingSettings,
} from '@/lib/api-settings';
import { fetchEmbeddingModels } from '@/lib/api-llm-inference';

import { useTranslation } from 'react-i18next';
import { toast } from '@/lib/toast-compat';
import { EmbeddingModelDescription } from '@/types/llm-types';

export interface PopoverEmbeddingSettingsProps {
  embeddingModel: string;
  setEmbeddingModel: (value: string) => void;
  splitterType: string;
  setSplitterType: (value: string) => void;
  chunkSize: string;
  setChunkSize: (value: string) => void;
  chunkOverlapping: string;
  setChunkOverlapping: (value: string) => void;
  chunkSizesToIgnore: string;
  setChunkSizesToIgnore: (value: string) => void;
  // Optional external control
  externalOpen?: boolean;
  onExternalOpenChange?: (open: boolean) => void;
  hideButton?: boolean;
}

// Default values (no hardcoded models)
const DEFAULTS = {
  embeddingModel: '', // Will be set dynamically from available models
  splitterType: 'enhanced_markdown',
  chunkSize: '256', // Research shows 256 is optimal for most use cases
  chunkOverlapping: '64', // ~20% of chunk size is recommended (64 for 256)
  chunkSizesToIgnore: '20',
};

export function PopoverEmbeddingSettings({
  embeddingModel,
  setEmbeddingModel,
  splitterType,
  setSplitterType,
  chunkSize,
  setChunkSize,
  chunkOverlapping,
  setChunkOverlapping,
  chunkSizesToIgnore,
  setChunkSizesToIgnore,
  externalOpen,
  onExternalOpenChange,
  hideButton = false,
}: PopoverEmbeddingSettingsProps) {
  const { t } = useTranslation();
  const [isLoading, setIsLoading] = useState(false);
  const [isPopoverOpen, setIsPopoverOpen] = useState(false);
  const [initialized, setInitialized] = useState(false);
  const [availableModels, setAvailableModels] = useState<
    EmbeddingModelDescription[]
  >([]);
  const [isSaving, setIsSaving] = useState(false);
  const [lastSaved, setLastSaved] = useState<Date | null>(null);
  const saveTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const firstLoadRef = useRef(true); // Track if this is the first load
  const backendErrorShownRef = useRef(false); // Track if backend error was already shown

  // Debug: Log embedding model state changes
  useEffect(() => {
    if (availableModels.length > 0) {
      const matchingModel = availableModels.find(
        m => m.name === embeddingModel || m.display_name === embeddingModel || m.id === embeddingModel
      );

      if (!matchingModel) {
        console.error('❌ embeddingModel value does not match any SelectItem value!', {
          embeddingModel,
          availableValues: availableModels.map(m => m.name || m.display_name || m.id)
        });
      }
    }
  }, [embeddingModel, availableModels]);

  // Function to fetch user settings from backend API
  const fetchUserSettings = async () => {
    try {
      setIsLoading(true);

      // Fetch both embedding and document processing settings
      const [embeddingSettings, processingSettings] = await Promise.all([
        getEmbeddingSettings(),
        getDocumentProcessingSettings()
      ]);

      // Map backend values to UI values
      if (embeddingSettings) {
        // Map embedding model
        if (embeddingSettings.setting_value?.embedding_model) {
          setEmbeddingModel(embeddingSettings.setting_value.embedding_model);
        }
      }

      if (processingSettings) {
        // Map splitter type from document processing settings
        if (processingSettings.setting_value?.splitter_type) {
          setSplitterType(processingSettings.setting_value.splitter_type);
        }

        // Map chunk size to ToggleGroup values
        if (processingSettings.setting_value?.chunk_size) {
          const sizeValue =
            typeof processingSettings.setting_value.chunk_size === 'number'
              ? processingSettings.setting_value.chunk_size
              : parseInt(processingSettings.setting_value.chunk_size);

          // Map to closest ToggleGroup option
          if (sizeValue <= 128) setChunkSize('128');
          else if (sizeValue <= 256) setChunkSize('256');
          else if (sizeValue <= 512) setChunkSize('512');
          else setChunkSize('992');
        }

        // Map chunk overlap to ToggleGroup values
        if (processingSettings.setting_value?.chunk_overlap) {
          const overlapValue =
            typeof processingSettings.setting_value.chunk_overlap === 'number'
              ? processingSettings.setting_value.chunk_overlap
              : parseInt(processingSettings.setting_value.chunk_overlap);

          // Map to closest ToggleGroup option
          if (overlapValue <= 32) setChunkOverlapping('32');
          else if (overlapValue <= 64) setChunkOverlapping('64');
          else if (overlapValue <= 128) setChunkOverlapping('128');
          else setChunkOverlapping('192');
        }

        // Map chunk sizes to ignore
        if (processingSettings.setting_value?.chunk_sizes_to_ignore !== undefined) {
          setChunkSizesToIgnore(
            processingSettings.setting_value.chunk_sizes_to_ignore.toString()
          );
        }
      }

      // If no settings were returned, apply defaults (except embedding model which comes from API)
      if (!embeddingSettings && !processingSettings) {
        // Don't set embeddingModel here - it will be set from available models in checkEmbeddingProviders
        setSplitterType(DEFAULTS.splitterType);
        setChunkSize(DEFAULTS.chunkSize);
        setChunkOverlapping(DEFAULTS.chunkOverlapping);
        setChunkSizesToIgnore(DEFAULTS.chunkSizesToIgnore);
      }
    } catch (error) {
      console.error('Error fetching user settings:', error);
      // Don't show error here - will be shown by checkEmbeddingProviders if backend is down

      // Apply defaults if there was an error (except embedding model which comes from API)
      // Don't set embeddingModel here - it will be set from available models in checkEmbeddingProviders
      setSplitterType(DEFAULTS.splitterType);
      setChunkSize(DEFAULTS.chunkSize);
      setChunkOverlapping(DEFAULTS.chunkOverlapping);
      setChunkSizesToIgnore(DEFAULTS.chunkSizesToIgnore);
    } finally {
      setIsLoading(false);
    }
  };

  // Auto-save function with debouncing
  const autoSaveSettings = useCallback(() => {
    // Don't save if embedding model is not set yet
    if (!embeddingModel) {
      return;
    }

    // Clear any existing timeout
    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current);
    }

    // Set a new timeout for auto-save (1.5 seconds after last change)
    saveTimeoutRef.current = setTimeout(async () => {
      await handleSaveSettings();
    }, 1500);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- deps are intentionally limited
  }, [embeddingModel, splitterType, chunkSize, chunkOverlapping, chunkSizesToIgnore]);

  // Handle saving settings to backend
  const handleSaveSettings = async () => {
    // Validate that embedding model is set
    if (!embeddingModel) {
      return;
    }

    try {
      setIsSaving(true);

      // Convert string values to numeric values
      let numericChunkSize;
      let numericChunkOverlap;

      // Parse chunk size from ToggleGroup value
      if (typeof chunkSize === 'string') {
        if (['low', 'medium', 'high', 'highest'].includes(chunkSize)) {
          // Handle legacy values if they still exist
          switch (chunkSize) {
            case 'low':
              numericChunkSize = 128;
              break;
            case 'medium':
              numericChunkSize = 256;
              break;
            case 'high':
              numericChunkSize = 512;
              break;
            case 'highest':
              numericChunkSize = 992;
              break;
            default:
              numericChunkSize = 256; // Default to medium
          }
        } else {
          // Parse numeric value from string
          numericChunkSize = parseInt(chunkSize);
        }
      } else {
        numericChunkSize = parseInt(DEFAULTS.chunkSize);
      }

      // Parse chunk overlap from ToggleGroup value
      if (typeof chunkOverlapping === 'string') {
        if (['low', 'medium', 'high', 'highest'].includes(chunkOverlapping)) {
          // Handle legacy values if they still exist
          switch (chunkOverlapping) {
            case 'low':
              numericChunkOverlap = 32;
              break;
            case 'medium':
              numericChunkOverlap = 64;
              break;
            case 'high':
              numericChunkOverlap = 128;
              break;
            case 'highest':
              numericChunkOverlap = 192;
              break;
            default:
              numericChunkOverlap = 64; // Default to medium
          }
        } else {
          // Parse numeric value from string
          numericChunkOverlap = parseInt(chunkOverlapping);
        }
      } else {
        numericChunkOverlap = parseInt(DEFAULTS.chunkOverlapping);
      }

      // Parse chunk sizes to ignore
      const numericChunkSizesToIgnore =
        parseInt(chunkSizesToIgnore) || parseInt(DEFAULTS.chunkSizesToIgnore);

      // Save settings to the backend-split into embedding and processing settings
      const savePromises = [];

      // Save embedding model separately
      savePromises.push(
        saveEmbeddingSettings({
          embedding_model: embeddingModel,
        })
      );

      // Save document processing settings separately
      savePromises.push(
        saveDocumentProcessingSettings({
          splitter_type: splitterType,
          chunk_size: numericChunkSize,
          chunk_overlap: numericChunkOverlap,
          chunk_sizes_to_ignore: numericChunkSizesToIgnore,
        })
      );

      const responses = await Promise.all(savePromises);

      if (responses.every(response => response && response.status === 'success')) {
        setLastSaved(new Date());
        // Don't show toast for auto-save to avoid spam
        // toast.success('Settings saved automatically');
      } else {
        console.error('❌ PopoverEmbeddingSettings: Save failed. Responses:', responses);
        responses.forEach((response, index) => {
          const settingType = index === 0 ? 'embedding' : 'processing';
          console.error(`❌ ${settingType} settings response:`, response);
        });
        toast.error(t('settings.popovers.embeddingSettings.errorSaving'));
      }
    } catch (error) {
      console.error('Error saving embedding settings:', error);
      toast.error(t('settings.popovers.embeddingSettings.errorSaving'));
    } finally {
      setIsSaving(false);
    }
  };

  // Trigger auto-save when settings change (but not on the initial mount)
  useEffect(() => {
    if (initialized && embeddingModel) {
      // Skip auto-save on the first load (when settings are being initialized)
      if (firstLoadRef.current) {
        firstLoadRef.current = false;
        return;
      }

      autoSaveSettings();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- deps are intentionally limited
  }, [embeddingModel, splitterType, chunkSize, chunkOverlapping, chunkSizesToIgnore, initialized]);

  // Cleanup timeout on unmounting
  useEffect(() => {
    return () => {
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current);
      }
    };
  }, []);

  // Initialize with research-based defaults if values are not yet set
  useEffect(() => {
    if (!initialized) {
      const checkEmbeddingProviders = async () => {
        try {
          // Get token for API requests using improved token retrieval
          const getAccessToken = (): string | null => {
            const storageKeys = ['auth_tokens', 'accessToken', 'access_token'];
            const storageLocations = [localStorage, sessionStorage];

            for (const storage of storageLocations) {
              for (const key of storageKeys) {
                try {
                  const tokenData = storage.getItem(key);
                  if (!tokenData) continue;

                  if (key === 'auth_tokens') {
                    const authTokens = JSON.parse(tokenData);
                    const token = authTokens?.access_token;
                    if (token && typeof token === 'string' && token.length > 10) {
                      return token;
                    }
                  } else if (typeof tokenData === 'string' && tokenData.length > 10) {
                    return tokenData;
                  }
                } catch (parseError) {

                }
              }
            }
            return null;
          };

          const token = getAccessToken();
          if (!token) {
            console.warn(
              'No access token found, skipping embedding provider check'
            );
            return;
          }

          // Fetch available embedding models using a proper API function
          let models;
          let backendError = false;

          try {
            models = await fetchEmbeddingModels(true); // bypass cache to get fresh data
          } catch (apiError) {
            console.error('❌ PopoverEmbeddingSettings: Failed to fetch embedding models from API:', apiError);
            backendError = true;
            models = [];
          }

          if (models && models.length > 0) {
            setAvailableModels(models);

            // Set default embedding model immediately if none is set
            if (!embeddingModel) {
              const selectedModel = models[0].name || models[0].display_name;
              if (selectedModel) {
                setEmbeddingModel(selectedModel);
              }
            }
          } else {
            console.warn('⚠️ PopoverEmbeddingSettings: No embedding models found from backend API');
            setAvailableModels([]);

            // Only show error if backend is unreachable, not if models are just not configured
            if (backendError && !backendErrorShownRef.current) {
              backendErrorShownRef.current = true;
              toast.error(t('settings.popovers.embeddingSettings.embeddingModel.backendUnavailable'));
            }
          }

          // Check if we have any embedding providers configured using the API
          try {
            const { getEmbeddingProviders } = await import('@/lib/api-settings');
            await getEmbeddingProviders();
          } catch (error) {
            console.error('Failed to fetch embedding providers:', error);
            // Don't show additional error - already shown above
          }
        } catch (error) {
          console.error('Error checking embedding providers:', error);

          // Show single consolidated error message
          if (!backendErrorShownRef.current) {
            backendErrorShownRef.current = true;
            toast.error(t('settings.popovers.embeddingSettings.embeddingModel.backendUnavailable'));
          }

          // Don't set fallback model - models should come from config.yaml only
          console.warn('⚠️ PopoverEmbeddingSettings: Error occurred, no fallback model set');
        }
      };

      // Set default values for other settings if not already set
      if (!splitterType) setSplitterType(DEFAULTS.splitterType);
      if (!chunkSize || !['128', '256', '512', '1024'].includes(chunkSize))
        setChunkSize(DEFAULTS.chunkSize);
      if (
        !chunkOverlapping ||
        !['32', '64', '128', '192'].includes(chunkOverlapping)
      )
        setChunkOverlapping(DEFAULTS.chunkOverlapping);
      if (!chunkSizesToIgnore)
        setChunkSizesToIgnore(DEFAULTS.chunkSizesToIgnore);

      // Check embedding providers and fetch user settings
      void checkEmbeddingProviders();
      void fetchUserSettings();
      setInitialized(true);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- deps are intentionally limited
  }, [
    embeddingModel,
    initialized,
    splitterType,
    chunkSize,
    chunkOverlapping,
    chunkSizesToIgnore,
  ]);

  // Fetch user settings when popover is opened
  useEffect(() => {
    if (isPopoverOpen && initialized) {
      void fetchUserSettings();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- deps are intentionally limited
  }, [isPopoverOpen, initialized]);

  return (
    <TooltipProvider>
      <Popover
        open={externalOpen !== undefined ? externalOpen : isPopoverOpen}
        onOpenChange={onExternalOpenChange || setIsPopoverOpen}
        disableBlur={true}
        modal={true}
      >
        {!hideButton && (
          <Tooltip>
            <TooltipTrigger asChild>
              <span>
                <PopoverTrigger asChild>
                  <Button
                    data-testid="knowledge-embedding-settings-button"
                    variant='ghost'
                    size='icon'
                    className='h-7 w-7 rounded-full'
                    aria-label='Embedding Settings'
                  >
                    <Settings className='h-4 w-4 text-muted-foreground' />
                  </Button>
                </PopoverTrigger>
              </span>
            </TooltipTrigger>
            <TooltipContent side='bottom'>
              <p className='text-xs'>Embedding Settings</p>
            </TooltipContent>
          </Tooltip>
        )}
        <PopoverContent
          data-testid="knowledge-embedding-settings-popover"
          align='end'
          className='w-80 p-4 z-[1200]'
        >
          <div className='space-y-4'>
            <div className='flex items-center justify-between'>
              <h3 className='text-sm font-medium text-foreground'>
                {t('settings.popovers.embeddingSettings.title')}
              </h3>
            </div>

            <div className='space-y-4'>
              <div className='space-y-1'>
                <div className='flex items-center justify-between'>
                  <label className='text-sm font-medium text-foreground'>
                    {t(
                      'settings.popovers.embeddingSettings.embeddingModel.label'
                    )}
                  </label>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <div className='h-5 w-5 rounded-full bg-muted flex items-center justify-center cursor-help'>
                        <Info className='h-3 w-3 text-muted-foreground' />
                      </div>
                    </TooltipTrigger>
                    <TooltipContent className='max-w-xs'>
                      <p>
                        {t(
                          'settings.popovers.embeddingSettings.embeddingModel.tooltip'
                        )}
                      </p>
                    </TooltipContent>
                  </Tooltip>
                </div>
                <Select
                  value={(() => {
                    // Normalize the value to match SelectItem values
                    if (!embeddingModel || availableModels.length === 0) return embeddingModel;

                    // Find matching model and return its SelectItem value
                    const matchingModel = availableModels.find(
                      m => m.name === embeddingModel || m.display_name === embeddingModel || m.id === embeddingModel
                    );

                    if (matchingModel) {
                      return matchingModel.name || matchingModel.display_name || matchingModel.id;
                    }

                    console.warn('⚠️ No matching model found for:', embeddingModel);
                    return embeddingModel;
                  })()}
                  onValueChange={(value) => {
                    setEmbeddingModel(value);
                  }}
                  disabled={isLoading}
                >
                  <SelectTrigger className='border-zinc-300 dark:border-zinc-700'>
                    <SelectValue
                      placeholder={t(
                        'settings.popovers.embeddingSettings.embeddingModel.placeholder'
                      )}
                    />
                  </SelectTrigger>
                  <SelectContent className='z-[1100]'>
                    {availableModels.length > 0 ? (
                      <>
                        {/* Show all available embedding models from configured providers */}
                        {availableModels.map(model => {
                          // Use name as primary identifier (consistent with backend storage)
                          const modelValue = model.name || model.display_name || model.id;

                          return (
                            <SelectItem key={model.id} value={modelValue}>
                              <div className='flex items-center justify-between w-full'>
                                <span>{model.display_name || model.name}</span>
                                <span className='text-xs text-muted-foreground ml-2'>
                                  ({model.provider_name || model.provider_type})
                                </span>
                              </div>
                            </SelectItem>
                          );
                        })}
                      </>
                    ) : (
                      <SelectItem value="no-models-available" disabled>
                        {t('settings.popovers.embeddingSettings.embeddingModel.noModelsAvailable')}
                      </SelectItem>
                    )}
                  </SelectContent>
                </Select>
              </div>

              <div className='space-y-1'>
                <div className='flex items-center justify-between'>
                  <label className='text-sm font-medium text-foreground'>
                    {t(
                      'settings.popovers.embeddingSettings.splitterType.label'
                    )}
                  </label>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <div className='h-5 w-5 rounded-full bg-muted flex items-center justify-center cursor-help'>
                        <Info className='h-3 w-3 text-muted-foreground' />
                      </div>
                    </TooltipTrigger>
                    <TooltipContent className='max-w-xs'>
                      <p>
                        {t(
                          'settings.popovers.embeddingSettings.splitterType.tooltip.title'
                        )}
                      </p>
                      <ul className='list-disc pl-4 mt-1 text-xs'>
                        <li>
                          <strong>{t('settings.popovers.embeddingSettings.splitterType.tooltip.recursiveLabel')}:</strong>{' '}
                          {t(
                            'settings.popovers.embeddingSettings.splitterType.tooltip.recursive'
                          )}
                        </li>
                        <li>
                          <strong>{t('settings.popovers.embeddingSettings.splitterType.tooltip.semanticLabel')}:</strong>{' '}
                          {t(
                            'settings.popovers.embeddingSettings.splitterType.tooltip.semantic'
                          )}
                        </li>
                        <li>
                          <strong>{t('settings.popovers.embeddingSettings.splitterType.tooltip.hierarchicalLabel')}:</strong>{' '}
                          {t(
                            'settings.popovers.embeddingSettings.splitterType.tooltip.hierarchical'
                          )}
                        </li>
                        <li>
                          <strong>{t('settings.popovers.embeddingSettings.splitterType.tooltip.topicBasedLabel')}:</strong>{' '}
                          {t(
                            'settings.popovers.embeddingSettings.splitterType.tooltip.topicBased'
                          )}
                        </li>
                        <li>
                          <strong>{t('settings.popovers.embeddingSettings.splitterType.tooltip.conceptAwareLabel')}:</strong>{' '}
                          {t(
                            'settings.popovers.embeddingSettings.splitterType.tooltip.conceptAware'
                          )}
                        </li>
                        <li>
                          <strong>{t('settings.popovers.embeddingSettings.splitterType.tooltip.agenticLabel')}:</strong>{' '}
                          {t(
                            'settings.popovers.embeddingSettings.splitterType.tooltip.agentic'
                          )}
                        </li>
                      </ul>
                    </TooltipContent>
                  </Tooltip>
                </div>
                <Select
                  value={splitterType}
                  onValueChange={setSplitterType}
                  disabled={isLoading}
                >
                  <SelectTrigger className='border-zinc-300 dark:border-zinc-700'>
                    <SelectValue
                      placeholder={t(
                        'settings.popovers.embeddingSettings.splitterType.placeholder'
                      )}
                    />
                  </SelectTrigger>
                  <SelectContent className='z-[1100]'>
                    {/* Basic Strategies */}
                    <div className='p-1'>
                      <p className='text-xs font-semibold text-muted-foreground mb-1'>
                        {t(
                          'settings.popovers.embeddingSettings.splitterType.categories.basic'
                        )}
                      </p>
                      <SelectItem value='recursive'>
                        {t(
                          'settings.popovers.embeddingSettings.splitterType.strategies.recursive'
                        )}
                      </SelectItem>
                      <SelectItem value='semantic'>
                        {t(
                          'settings.popovers.embeddingSettings.splitterType.strategies.semantic'
                        )}
                      </SelectItem>
                      <SelectItem value='enhanced_markdown'>
                        {t(
                          'settings.popovers.embeddingSettings.splitterType.strategies.enhanced_markdown'
                        )}
                      </SelectItem>
                      <SelectItem value='proposition'>
                        {t(
                          'settings.popovers.embeddingSettings.splitterType.strategies.proposition'
                        )}
                      </SelectItem>
                    </div>
                    {/* Advanced Strategies */}
                    <div className='p-1'>
                      <p className='text-xs font-semibold text-muted-foreground mb-1'>
                        {t(
                          'settings.popovers.embeddingSettings.splitterType.categories.advanced'
                        )}
                      </p>
                      <SelectItem value='hierarchical'>
                        {t(
                          'settings.popovers.embeddingSettings.splitterType.strategies.hierarchical'
                        )}
                      </SelectItem>
                      <SelectItem value='topic_based'>
                        {t(
                          'settings.popovers.embeddingSettings.splitterType.strategies.topic_based'
                        )}
                      </SelectItem>
                      <SelectItem value='sliding_window'>
                        {t(
                          'settings.popovers.embeddingSettings.splitterType.strategies.sliding_window'
                        )}
                      </SelectItem>
                      <SelectItem value='concept_aware'>
                        {t(
                          'settings.popovers.embeddingSettings.splitterType.strategies.concept_aware'
                        )}
                      </SelectItem>
                      <SelectItem value='narrative_structure'>
                        {t(
                          'settings.popovers.embeddingSettings.splitterType.strategies.narrative_structure'
                        )}
                      </SelectItem>
                      <SelectItem value='agentic'>
                        {t(
                          'settings.popovers.embeddingSettings.splitterType.strategies.agentic'
                        )}
                      </SelectItem>
                    </div>
                    {/* LangChain Strategies */}
                    <div className='p-1'>
                      <p className='text-xs font-semibold text-muted-foreground mb-1'>
                        {t(
                          'settings.popovers.embeddingSettings.splitterType.categories.langchain'
                        )}
                      </p>
                      <SelectItem value='token_based'>
                        {t(
                          'settings.popovers.embeddingSettings.splitterType.strategies.token_based'
                        )}
                      </SelectItem>
                      <SelectItem value='gpt_token'>
                        {t(
                          'settings.popovers.embeddingSettings.splitterType.strategies.gpt_token'
                        )}
                      </SelectItem>
                      <SelectItem value='claude_token'>
                        {t(
                          'settings.popovers.embeddingSettings.splitterType.strategies.claude_token'
                        )}
                      </SelectItem>
                      <SelectItem value='openai_semantic'>
                        {t(
                          'settings.popovers.embeddingSettings.splitterType.strategies.openai_semantic'
                        )}
                      </SelectItem>
                      <SelectItem value='huggingface_semantic'>
                        {t(
                          'settings.popovers.embeddingSettings.splitterType.strategies.huggingface_semantic'
                        )}
                      </SelectItem>
                    </div>
                  </SelectContent>
                </Select>
              </div>

              <div className='space-y-1'>
                <div className='flex items-center justify-between'>
                  <label className='text-sm font-medium text-foreground'>
                    {t('settings.popovers.embeddingSettings.chunkSize.label')}
                  </label>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <div className='h-5 w-5 rounded-full bg-muted flex items-center justify-center cursor-help'>
                        <Info className='h-3 w-3 text-muted-foreground' />
                      </div>
                    </TooltipTrigger>
                    <TooltipContent className='max-w-xs'>
                      <p>
                        {t(
                          'settings.popovers.embeddingSettings.chunkSize.tooltip'
                        )}
                      </p>
                    </TooltipContent>
                  </Tooltip>
                </div>
                <ToggleGroup
                  type='single'
                  value={chunkSize}
                  onValueChange={value => value && setChunkSize(value)}
                  className='flex justify-center gap-1'
                >
                  <ToggleGroupItem
                    value='128'
                    className='flex-1 text-xs border rounded-l-md border-zinc-300 dark:border-zinc-700 data-[state=on]:bg-zinc-100 dark:data-[state=on]:bg-zinc-800'
                  >
                    128
                  </ToggleGroupItem>
                  <ToggleGroupItem
                    value='256'
                    className='flex-1 text-xs border border-zinc-300 dark:border-zinc-700 data-[state=on]:bg-zinc-100 dark:data-[state=on]:bg-zinc-800'
                  >
                    256
                  </ToggleGroupItem>
                  <ToggleGroupItem
                    value='512'
                    className='flex-1 text-xs border border-zinc-300 dark:border-zinc-700 data-[state=on]:bg-zinc-100 dark:data-[state=on]:bg-zinc-800'
                  >
                    512
                  </ToggleGroupItem>
                  <ToggleGroupItem
                    value='1024'
                    className='flex-1 text-xs border rounded-r-md border-zinc-300 dark:border-zinc-700 data-[state=on]:bg-zinc-100 dark:data-[state=on]:bg-zinc-800'
                  >
                    1024
                  </ToggleGroupItem>
                </ToggleGroup>

                <div className='flex justify-center mt-1'>
                  <span className='bg-green-100 dark:bg-green-900 px-1 py-0.5 rounded text-xs text-green-800 dark:text-green-300'>
                    {t(
                      'settings.popovers.embeddingSettings.chunkSize.recommended'
                    )}
                  </span>
                </div>
              </div>

              <div className='space-y-1'>
                <div className='flex items-center justify-between'>
                  <label className='text-sm font-medium text-foreground'>
                    {t(
                      'settings.popovers.embeddingSettings.chunkOverlap.label'
                    )}
                  </label>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <div className='h-5 w-5 rounded-full bg-muted flex items-center justify-center cursor-help'>
                        <Info className='h-3 w-3 text-muted-foreground' />
                      </div>
                    </TooltipTrigger>
                    <TooltipContent className='max-w-xs'>
                      <p>
                        {t(
                          'settings.popovers.embeddingSettings.chunkOverlap.tooltip'
                        )}
                      </p>
                    </TooltipContent>
                  </Tooltip>
                </div>
                <ToggleGroup
                  type='single'
                  value={chunkOverlapping}
                  onValueChange={value => value && setChunkOverlapping(value)}
                  className='flex justify-center gap-1'
                >
                  <ToggleGroupItem
                    value='32'
                    className='flex-1 px-2 py-1.5 text-xs border rounded-l-md border-zinc-300 dark:border-zinc-700 data-[state=on]:bg-zinc-100 dark:data-[state=on]:bg-zinc-800'
                  >
                    32
                  </ToggleGroupItem>
                  <ToggleGroupItem
                    value='64'
                    className='flex-1 px-2 py-1.5 text-xs border border-zinc-300 dark:border-zinc-700 data-[state=on]:bg-zinc-100 dark:data-[state=on]:bg-zinc-800'
                  >
                    64
                  </ToggleGroupItem>
                  <ToggleGroupItem
                    value='128'
                    className='flex-1 px-2 py-1.5 text-xs border border-zinc-300 dark:border-zinc-700 data-[state=on]:bg-zinc-100 dark:data-[state=on]:bg-zinc-800'
                  >
                    128
                  </ToggleGroupItem>
                  <ToggleGroupItem
                    value='192'
                    className='flex-1 px-2 py-1.5 text-xs border rounded-r-md border-zinc-300 dark:border-zinc-700 data-[state=on]:bg-zinc-100 dark:data-[state=on]:bg-zinc-800'
                  >
                    192
                  </ToggleGroupItem>
                </ToggleGroup>

                <div className='flex justify-center mt-1'>
                  <span className='bg-green-100 dark:bg-green-900 px-1 py-0.5 rounded text-xs text-green-800 dark:text-green-300'>
                    {t(
                      'settings.popovers.embeddingSettings.chunkOverlap.recommended'
                    )}
                  </span>
                </div>
              </div>

              <div className='space-y-1'>
                <div className='flex items-center justify-between'>
                  <label className='text-sm font-medium text-foreground'>
                    {t(
                      'settings.popovers.embeddingSettings.chunkSizesToIgnore.label'
                    )}
                  </label>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <div className='h-5 w-5 rounded-full bg-muted flex items-center justify-center cursor-help'>
                        <Info className='h-3 w-3 text-muted-foreground' />
                      </div>
                    </TooltipTrigger>
                    <TooltipContent className='max-w-xs'>
                      <p>
                        {t(
                          'settings.popovers.embeddingSettings.chunkSizesToIgnore.tooltip'
                        )}
                      </p>
                    </TooltipContent>
                  </Tooltip>
                </div>
                <Input
                  type='number'
                  value={chunkSizesToIgnore}
                  onChange={e => setChunkSizesToIgnore(e.target.value)}
                  className='border-zinc-300 dark:border-zinc-700'
                />
              </div>
            </div>

            {/* Auto-save indicator */}
            <div className='flex justify-end pt-2'>
              <div className='flex items-center gap-2 text-xs text-muted-foreground'>
                {isSaving ? (
                  <span className='flex items-center gap-1'>
                    <span className='animate-spin'>⏳</span>
                    {t('settings.popovers.embeddingSettings.saving') || 'Saving...'}
                  </span>
                ) : lastSaved ? (
                  <span className='flex items-center gap-1'>
                    <span>✓</span>
                    Saved {lastSaved.toLocaleTimeString()}
                  </span>
                ) : null}
              </div>
            </div>
          </div>
        </PopoverContent>
      </Popover>
    </TooltipProvider>
  );
}
