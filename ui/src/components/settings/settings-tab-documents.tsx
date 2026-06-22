import React, {useEffect, useRef, useState} from 'react';
import {useTranslation} from 'react-i18next';
import {FolderOpen, HelpCircle, Settings} from 'lucide-react';
import {CITATION_STYLES} from '@/lib/citation-formatter';
import {Diode} from '@/components/ui/diode';
import {useAdminCheck} from '@/hooks/use-admin-check';
import {Select, SelectContent, SelectItem, SelectTrigger, SelectValue,} from '@/components/ui/select';
import {Tooltip, TooltipContent, TooltipProvider, TooltipTrigger,} from '@/components/ui/tooltip';
import {getEmbeddingSettings, getDocumentProcessingSettings, saveDocumentProcessingSettings, saveEmbeddingSettings,} from '@/lib/api-settings';
import {fetchEmbeddingModels} from '@/lib/api-llm-inference'; // Added
import {EmbeddingModelDescription} from '@/types/llm-types'; // Added
import {PopoverEmbeddingSettings} from '@/components/knowledge/popover-embedding-settings';
import {toast} from '@/lib/toast-compat';
import {Switch} from "@/components/ui/switch.tsx";
import {SettingsCardAnnotationColors} from './settings-card-annotation-colors';

// Define size options
const chunkSizeOptions = [
  { value: 'low', label: 'Small (256 chars)' },
  { value: 'medium', label: 'Medium (512 chars)' },
  { value: 'high', label: 'Large (1024 chars)' },
  { value: 'highest', label: 'Maximum (2048 chars)' },
];

const chunkOverlapOptions = [
  { value: 'low', label: 'Minimal (50 chars)' },
  { value: 'medium', label: 'Medium (100 chars)' },
  { value: 'high', label: 'Large (200 chars)' },
  { value: 'highest', label: 'Maximum (400 chars)' },
];

// Define retriever type options - these will be translated in the component

// Document settings component props
interface DocumentsSettingsTabProps {
  onSave?: () => void;
  onChange?: () => void;
  selectedTab?: string;
  openSettingsWithTab?: (tab: string) => void;
}

export const DocumentsSettingsTab: React.FC<DocumentsSettingsTabProps> = ({
  onSave,
  onChange,
  selectedTab,
  openSettingsWithTab,
}): React.ReactElement => {
  const { t } = useTranslation();
  const isAdmin = useAdminCheck();

  // State for available embedding models
  const [availableEmbeddingModels, setAvailableEmbeddingModels] = useState<
    EmbeddingModelDescription[]
  >([]);

  // State for embedding settings popover
  const [isEmbeddingPopoverOpen, setIsEmbeddingPopoverOpen] = useState(false);

  // Main document settings state
  const [embeddingModel, setEmbeddingModel] = useState('');
  const [splitterType, setSplitterType] = useState('enhanced_markdown');
  const [chunkSize, setChunkSize] = useState('medium');
  const [chunkOverlap, setChunkOverlap] = useState('low');
  const [chunkSizesToIgnore, setChunkSizesToIgnore] = useState(20);
  const [retrieverType, setRetrieverType] = useState('pgvector');

  // Semantic chunking state
  const [semanticChunkingEnabled, setSemanticChunkingEnabled] = useState(false);
  const [semanticMethod, setSemanticMethod] = useState('percentile');
  const [semanticThreshold, setSemanticThreshold] = useState(90);

  // Markdown chunking state
  const [markdownChunkingEnabled, setMarkdownChunkingEnabled] = useState(true);
  const [returnEachLine, setReturnEachLine] = useState(false);
  const [stripHeaders, setStripHeaders] = useState(false);

  // OCR settings
  const [ocrEnabled, setOcrEnabled] = useState(false);

  // Track changes and loading state
  const [_isSaving, setIsSaving] = useState(false);
  const [hasChanges, setHasChanges] = useState(false);

  // Reference to track initial settings for comparison
  // Note: initialEmbeddingModel will be dynamically set from backend response
  const initialSettings = useRef({
    embeddingModel: '',
    splitterType: 'enhanced_markdown',
    chunkSize: 'medium',
    chunkOverlap: 'low',
    chunkSizesToIgnore: 20,
    semanticChunkingEnabled: false,
    semanticMethod: 'percentile',
    semanticThreshold: 90,
    markdownChunkingEnabled: true,
    returnEachLine: false,
    stripHeaders: false,
    retrieverType: 'pgvector',
    ocrEnabled: false,
  });

  // Fetch available embedding models on component mount
  // Load settings and available models from the backend
  useEffect(() => {
    const loadData = async () => {
      try {
        // Fetch embedding settings, document processing settings, and models in parallel for efficiency
        const [embeddingSettingsResponse, docProcessingSettings, fetchedModels] = await Promise.all([
          getEmbeddingSettings(),
          getDocumentProcessingSettings(),
          fetchEmbeddingModels(),
        ]);

        const embeddingSettings = embeddingSettingsResponse || { embedding_model: '' };
        const settings = docProcessingSettings || {};
        // Deduplicate models by model_name to avoid showing duplicates in the dropdown
        const uniqueModels = fetchedModels ? fetchedModels.filter((model, index, array) =>
          array.findIndex(m => m.model_name === model.model_name) === index
        ) : [];

        if (uniqueModels.length > 0) {
          // Models loaded successfully
        }

        if (fetchedModels && uniqueModels.length < fetchedModels.length) {
          // Duplicate models were filtered out
        }

        setAvailableEmbeddingModels(uniqueModels);

        // Determine the embedding model to select with robust fallback logic
        let finalEmbeddingModel;
        const userSavedModel = embeddingSettings.embedding_model;

        // Check if saved model matches by model_name OR display_name (for backwards compatibility)
        const matchingModel = userSavedModel
          ? uniqueModels.find(model =>
              model.model_name === userSavedModel ||
              model.display_name === userSavedModel
            )
          : null;

        if (matchingModel) {
          // 1. Use the user's saved setting if it's valid and available
          // Use the full model_name for consistency (even if saved value was display_name)
          finalEmbeddingModel = matchingModel.model_name;
        } else {
          if (userSavedModel) {
            // Notify the user that their saved model is no longer valid
            toast.warning(
              t('settings.documents.errors.modelNotFound', { model: userSavedModel })
            );
          }
          if (uniqueModels && uniqueModels.length > 0) {
            // 2. Default to the first model (which should be a config default from backend)
            finalEmbeddingModel = uniqueModels[0].model_name;
          } else {
            // 3. Fallback if no models are found - let backend handle defaults
            finalEmbeddingModel = '';
            toast.error(t('settings.documents.errors.noModelsLoaded'));
          }
        }

        // --- Set all states based on loaded data ---
        setEmbeddingModel(finalEmbeddingModel);

        const loadedSplitterType = settings.splitter_type || 'enhanced_markdown';
        setSplitterType(loadedSplitterType);

        // Handle chunk size (numeric or preset)
        let loadedChunkSize;
        if (typeof settings.chunk_size === 'number') {
          if (settings.chunk_size <= 250) loadedChunkSize = 'low';
          else if (settings.chunk_size <= 400) loadedChunkSize = 'medium';
          else if (settings.chunk_size <= 750) loadedChunkSize = 'high';
          else loadedChunkSize = 'highest';
        } else {
          loadedChunkSize = settings.chunk_size || 'medium';
        }
        setChunkSize(loadedChunkSize);

        // Handle chunk overlap (numeric or preset)
        let loadedChunkOverlap;
        if (typeof settings.chunk_overlap === 'number') {
          if (settings.chunk_overlap <= 50) loadedChunkOverlap = 'low';
          else if (settings.chunk_overlap <= 100) loadedChunkOverlap = 'medium';
          else if (settings.chunk_overlap <= 200) loadedChunkOverlap = 'high';
          else loadedChunkOverlap = 'highest';
        } else {
          loadedChunkOverlap = settings.chunk_overlap || 'low';
        }
        setChunkOverlap(loadedChunkOverlap);

        const loadedChunkSizesToIgnore = settings.chunk_sizes_to_ignore || 20;
        setChunkSizesToIgnore(loadedChunkSizesToIgnore);

        const semanticSettings = settings.semantic_chunking || {};
        const loadedSemanticEnabled = semanticSettings.enabled ?? false;
        const loadedSemanticMethod = semanticSettings.method || 'percentile';
        const loadedSemanticThreshold = semanticSettings.threshold ?? 90;
        setSemanticChunkingEnabled(loadedSemanticEnabled);
        setSemanticMethod(loadedSemanticMethod);
        setSemanticThreshold(loadedSemanticThreshold);

        const markdownSettings = settings.markdown_chunking || {};
        const loadedMarkdownEnabled = markdownSettings.enabled ?? true;
        const loadedReturnEachLine = markdownSettings.return_each_line ?? false;
        const loadedStripHeaders = markdownSettings.strip_headers ?? false;
        setMarkdownChunkingEnabled(loadedMarkdownEnabled);
        setReturnEachLine(loadedReturnEachLine);
        setStripHeaders(loadedStripHeaders);

        const loadedRetrieverType = settings.retriever_type || 'pgvector';
        setRetrieverType(loadedRetrieverType);

        const loadedOcrEnabled = settings.ocr_enabled ?? false;
        setOcrEnabled(loadedOcrEnabled);

        // Store initial settings for change detection
        initialSettings.current = {
          embeddingModel: finalEmbeddingModel,
          splitterType: loadedSplitterType,
          chunkSize: loadedChunkSize,
          chunkOverlap: loadedChunkOverlap,
          chunkSizesToIgnore: loadedChunkSizesToIgnore,
          semanticChunkingEnabled: loadedSemanticEnabled,
          semanticMethod: loadedSemanticMethod,
          semanticThreshold: loadedSemanticThreshold,
          markdownChunkingEnabled: loadedMarkdownEnabled,
          returnEachLine: loadedReturnEachLine,
          stripHeaders: loadedStripHeaders,
          retrieverType: loadedRetrieverType,
          ocrEnabled: loadedOcrEnabled,
        };

        setHasChanges(false);
      } catch (error) {
        console.error('Failed to load document settings or models:', error);
        toast.error(t('general.errors.loadFailed') + ' document settings');
      }
    };

    if (selectedTab === 'documents') {
      void loadData();
    }

  }, [selectedTab, t]);


  // Track changes to document settings
  useEffect(() => {
    // Only mark as changed if values are different from the initial settings
    const isChanged =
      embeddingModel !== initialSettings.current.embeddingModel ||
      splitterType !== initialSettings.current.splitterType ||
      chunkSize !== initialSettings.current.chunkSize ||
      chunkOverlap !== initialSettings.current.chunkOverlap ||
      chunkSizesToIgnore !== initialSettings.current.chunkSizesToIgnore ||
      semanticChunkingEnabled !==
      initialSettings.current.semanticChunkingEnabled ||
      semanticMethod !== initialSettings.current.semanticMethod ||
      semanticThreshold !== initialSettings.current.semanticThreshold ||
      markdownChunkingEnabled !==
      initialSettings.current.markdownChunkingEnabled ||
      returnEachLine !== initialSettings.current.returnEachLine ||
      stripHeaders !== initialSettings.current.stripHeaders ||
      retrieverType !== initialSettings.current.retrieverType ||
      ocrEnabled !== initialSettings.current.ocrEnabled;

    setHasChanges(isChanged);

    // Notify parent component about changes
    if (isChanged && onChange) {
      onChange();
    }
  }, [
    embeddingModel,
    splitterType,
    chunkSize,
    chunkOverlap,
    chunkSizesToIgnore,
    semanticChunkingEnabled,
    semanticMethod,
    semanticThreshold,
    markdownChunkingEnabled,
    returnEachLine,
    stripHeaders,
    retrieverType,
    ocrEnabled,
    onChange,
  ]);

  // Add event listener for auto-save when tab changes
  useEffect(() => {
    // Create a function to handle the save event
    const handleSaveEvent = () => {
      if (hasChanges) {
        void saveSettings();
      }
    };

    // Create a div element with an ID that can be targeted by the parent
    const tabContent = document.getElementById('documents-tab-content');

    // Add event listener for custom save event
    if (tabContent) {
      tabContent.addEventListener('save-document-settings', handleSaveEvent);
    }

    // Clean up on unmount
    return () => {
      if (tabContent) {
        tabContent.removeEventListener(
          'save-document-settings',
          handleSaveEvent
        );
      }
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps -- deps are intentionally limited
  }, [hasChanges]);

  // Helper function to convert preset values to numeric values
  const convertChunkSizeToNumber = (preset: string): number => {
    const sizeMap: Record<string, number> = {
      low: 256,
      medium: 512,
      high: 1024,
      highest: 2048,
    };
    return sizeMap[preset] || 512; // Default to medium
  };

  const convertChunkOverlapToNumber = (preset: string): number => {
    const overlapMap: Record<string, number> = {
      low: 50,
      medium: 100,
      high: 200,
      highest: 400,
    };
    return overlapMap[preset] || 100; // Default to medium
  };

  // Save document settings
  const saveSettings = async () => {
    // Skip saving if there are no changes
    if (!hasChanges) {

      if (onSave) onSave(); // Still call onSave to acknowledge the save attempt
      return;
    }

    // Check if the settings are actually different from the initial values
    // to prevent unnecessary API calls
    if (
      embeddingModel === initialSettings.current.embeddingModel &&
      splitterType === initialSettings.current.splitterType &&
      chunkSize === initialSettings.current.chunkSize &&
      chunkOverlap === initialSettings.current.chunkOverlap &&
      chunkSizesToIgnore === initialSettings.current.chunkSizesToIgnore &&
      semanticChunkingEnabled ===
      initialSettings.current.semanticChunkingEnabled &&
      semanticMethod === initialSettings.current.semanticMethod &&
      semanticThreshold === initialSettings.current.semanticThreshold &&
      markdownChunkingEnabled ===
      initialSettings.current.markdownChunkingEnabled &&
      returnEachLine === initialSettings.current.returnEachLine &&
      stripHeaders === initialSettings.current.stripHeaders &&
      retrieverType === initialSettings.current.retrieverType &&
      ocrEnabled === initialSettings.current.ocrEnabled
    ) {

      setHasChanges(false);
      if (onSave) onSave();
      return;
    }

    setIsSaving(true);
    try {
      // Determine what changed for intelligent API selection
      const embeddingChanged = embeddingModel !== initialSettings.current.embeddingModel;
      const processingChanged = (
        splitterType !== initialSettings.current.splitterType ||
        chunkSize !== initialSettings.current.chunkSize ||
        chunkOverlap !== initialSettings.current.chunkOverlap ||
        chunkSizesToIgnore !== initialSettings.current.chunkSizesToIgnore ||
        semanticChunkingEnabled !== initialSettings.current.semanticChunkingEnabled ||
        semanticMethod !== initialSettings.current.semanticMethod ||
        semanticThreshold !== initialSettings.current.semanticThreshold ||
        markdownChunkingEnabled !== initialSettings.current.markdownChunkingEnabled ||
        returnEachLine !== initialSettings.current.returnEachLine ||
        stripHeaders !== initialSettings.current.stripHeaders ||
        retrieverType !== initialSettings.current.retrieverType ||
        ocrEnabled !== initialSettings.current.ocrEnabled
      );

      // Save to appropriate endpoints based on what changed
      const savePromises = [];
      const changedSettings = [];

      if (embeddingChanged) {
        savePromises.push(saveEmbeddingSettings({ embedding_model: embeddingModel }));
        changedSettings.push('embedding model');
      }

      if (processingChanged) {
        const processingSettings = {
          splitter_type: splitterType,
          chunk_size: convertChunkSizeToNumber(chunkSize),
          chunk_overlap: convertChunkOverlapToNumber(chunkOverlap),
          chunk_sizes_to_ignore: chunkSizesToIgnore,
          ocr_enabled: ocrEnabled,
          semantic_chunking: {
            enabled: semanticChunkingEnabled,
            method: semanticMethod,
            threshold: semanticThreshold,
          },
          markdown_chunking: {
            enabled: markdownChunkingEnabled,
            return_each_line: returnEachLine,
            strip_headers: stripHeaders,
          },
          retriever_type: retrieverType,
        };
        savePromises.push(saveDocumentProcessingSettings(processingSettings));

        // Determine specific processing changes
        if (splitterType !== initialSettings.current.splitterType) {
          changedSettings.push('chunking strategy');
        }
        if (chunkSize !== initialSettings.current.chunkSize || chunkOverlap !== initialSettings.current.chunkOverlap) {
          changedSettings.push('chunk settings');
        }
        if (retrieverType !== initialSettings.current.retrieverType) {
          changedSettings.push('retriever type');
        }
      }

      // Execute all save operations
      await Promise.all(savePromises);

      // Show specific success message
      toast.success(t('general.successMessages.settingsSaved'));

      setHasChanges(false);

      // Update initial settings to current values
      initialSettings.current = {
        embeddingModel,
        splitterType,
        chunkSize,
        chunkOverlap,
        chunkSizesToIgnore,
        semanticChunkingEnabled,
        semanticMethod,
        semanticThreshold,
        markdownChunkingEnabled,
        returnEachLine,
        stripHeaders,
        retrieverType,
        ocrEnabled,
      };

      // Call onSave callback for parent component change tracking
      if (onSave) {
        onSave();
      }
    } catch (error) {
      console.error('Failed to save document settings:', error);
      toast.error(t('general.errors.saveFailed') + ' document settings');
    } finally {
      setIsSaving(false);
    }
  };

  // Auto-save settings when they change (debounced)
  useEffect(() => {
    if (!hasChanges) return;

    const debounceTimeout = setTimeout(() => {
      if (hasChanges) {
        void saveSettings();
      }
    }, 1500); // 1.5 second delay for auto-save

    return () => clearTimeout(debounceTimeout);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- deps are intentionally limited
  }, [hasChanges]);

  // Dynamically translate labels for options
  const translatedChunkSizeOptions = chunkSizeOptions.map(option => ({
    ...option,
    label: t(`settings.documents.chunkingOptions.size.options.${option.value}`),
  }));

  const translatedChunkOverlapOptions = chunkOverlapOptions.map(option => ({
    ...option,
    label: t(
      `settings.documents.chunkingOptions.overlap.options.${option.value}`
    ),
  }));

  return (
    <>
      <div className='sticky top-0 pt-0 pb-6 z-20' style={{ position: 'sticky' }}>
        <div
          className='absolute inset-0 bg-white/50 dark:bg-zinc-900/50 backdrop-blur-xl -z-10'
          style={{ maskImage: 'linear-gradient(to bottom, transparent 0%, black 10%, black 90%, transparent 100%)' }}
        />
        <div className='flex items-center justify-between'>
          <div>
            <h2 className='text-2xl font-bold text-zinc-900 dark:text-white mb-1'>
              {t('settings.tabs.documents')}
            </h2>
            <p className='text-sm text-zinc-500 dark:text-zinc-400'>
              {t('settings.documents.description')}
            </p>
          </div>
        </div>
      </div>

      <div className='space-y-6'>
        {/* Embedding & Retriever Card — admin only */}
        {isAdmin && (
        <div className='relative overflow-hidden bg-white dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 p-6 shadow-sm'>
          <div className='flex items-start gap-3 mb-5'>
            <div className='w-10 h-10 flex items-center justify-center mt-1'>
              <Settings className='w-5 h-5 text-indigo-600 dark:text-indigo-400' />
            </div>
            <div className='flex-1'>
              <div className='flex items-center gap-2'>
                <h3 className='text-lg font-semibold text-zinc-900 dark:text-white'>
                  {t('settings.documents.title')}
                </h3>
                <TooltipProvider>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <HelpCircle className='h-4 w-4 text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300 transition-colors' />
                    </TooltipTrigger>
                    <TooltipContent side='right' className='max-w-[300px]'>
                      <p>{t('settings.documents.embeddingModel.tooltip')}</p>
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              </div>
              <p className='text-sm text-zinc-600 dark:text-zinc-400'>
                Select embedding model and retriever configuration
              </p>
            </div>
          </div>

          <div className='pl-13 space-y-5'>
            {/* Embedding Model Selection */}
            <div className='space-y-3'>
              <label className='text-sm font-semibold text-zinc-900 dark:text-white'>
                {t('settings.documents.embeddingModel.label')}
              </label>
              <Select value={embeddingModel || undefined} onValueChange={setEmbeddingModel}>
                <SelectTrigger className='w-full h-11 border-zinc-300 dark:border-zinc-700 hover:border-indigo-500 dark:hover:border-indigo-500 transition-colors' data-testid="settings-tab-documents-embedding-model-select">
                  <SelectValue
                    placeholder={
                      availableEmbeddingModels.length > 0
                        ? t('settings.documents.embeddingModel.placeholder')
                        : t('settings.documents.embeddingModel.loading')
                    }
                  />
                </SelectTrigger>
                <SelectContent className='z-[1100]'>
                  <div>
                    {availableEmbeddingModels.length > 0 ? (
                      availableEmbeddingModels.map(model => (
                        <SelectItem key={model.id} value={model.model_name}>
                          {model.display_name || model.model_name}
                          {model.dimensions && ` (${model.dimensions} dims)`}
                        </SelectItem>
                      ))
                    ) : (
                      <SelectItem value='no-models' disabled>
                        {t('settings.documents.embeddingModel.noModels')}
                      </SelectItem>
                    )}

                    {/* Admin-only actions */}
                    {isAdmin && openSettingsWithTab && (
                      <div className='border-t border-zinc-200 dark:border-zinc-800 mt-2'>
                        <div className='px-3 py-1.5 text-xs font-semibold text-zinc-500 dark:text-zinc-400'>
                          {t(
                            'settings.documents.embeddingModel.actions',
                            'Actions'
                          )}
                        </div>
                        <button
                          type='button'
                          onClick={(e) => {
                            e.preventDefault();
                            openSettingsWithTab('local-ai');
                          }}
                          className='w-full flex items-center gap-2 px-8 py-1.5 text-sm hover:bg-accent hover:text-accent-foreground cursor-pointer transition-colors'
                        >
                          <Settings className='h-4 w-4' />
                          {t(
                            'settings.documents.embeddingModel.manageModels',
                            'Manage Embedding Models'
                          )}
                        </button>
                      </div>
                    )}
                  </div>
                </SelectContent>
              </Select>
            </div>


            {/* Retriever Type Selection */}
            <div className='space-y-3'>
              <div className='flex items-center gap-2'>
                <label className='text-sm font-semibold text-zinc-900 dark:text-white'>
                  {t(
                    'settings.documents.retrieverType.label',
                    'Retriever Type'
                  )}
                </label>
                <TooltipProvider>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <HelpCircle className='h-4 w-4 text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300 transition-colors' />
                    </TooltipTrigger>
                    <TooltipContent side='top'>
                      <p>
                        {t(
                          'settings.documents.retrieverType.tooltip',
                          'Select the retriever type for document search'
                        )}
                      </p>
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              </div>
              <Select value={retrieverType} onValueChange={setRetrieverType}>
                <SelectTrigger className='w-full h-11 border-zinc-300 dark:border-zinc-700 hover:border-indigo-500 dark:hover:border-indigo-500 transition-colors' data-testid="settings-tab-documents-retriever-type-select">
                  <SelectValue>
                    {retrieverType ? t(`settings.documents.retrieverType.${retrieverType}`, retrieverType) :
                      t('settings.documents.retrieverType.selectPlaceholder', 'Select retriever type')}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent className='z-[1100]'>
                  <SelectItem value='ensemble'>
                    {t(
                      'settings.documents.retrieverType.ensemble',
                      'Ensemble Retriever'
                    )}
                  </SelectItem>
                  <SelectItem value='pgvector'>
                    {t(
                      'settings.documents.retrieverType.pgvector',
                      'PGVector Retriever'
                    )}
                  </SelectItem>
                  <SelectItem value='neo4j'>
                    {t(
                      'settings.documents.retrieverType.neo4j',
                      'Neo4j Retriever'
                    )}
                  </SelectItem>
                </SelectContent>
              </Select>
              <p className='text-xs text-zinc-500 dark:text-zinc-400 mt-1'>
                {retrieverType === 'ensemble' &&
                  t(
                    'settings.documents.retrieverType.ensembleDescription',
                    'Uses a combination of retrieval methods for better results'
                  )}
                {retrieverType === 'pgvector' &&
                  t(
                    'settings.documents.retrieverType.pgvectorDescription',
                    'Direct database vector search for faster retrieval'
                  )}
                {retrieverType === 'neo4j' &&
                  t(
                    'settings.documents.retrieverType.neo4jDescription',
                    'Graph-based retrieval for complex relationships and context'
                  )}
              </p>
            </div>

            {/* OCR Settings */}
            <div className='space-y-3 pt-3 border-t border-zinc-200 dark:border-zinc-800'>
              <div className='flex items-center justify-between'>
                <div className='flex items-center gap-2'>
                  <label className='text-sm font-semibold text-zinc-900 dark:text-white'>
                    {t('settings.documents.ocrEnabled.label', 'Enable OCR Processing')}
                  </label>
                  <TooltipProvider>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <HelpCircle className='h-4 w-4 text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300 transition-colors' />
                      </TooltipTrigger>
                      <TooltipContent side='top' className='max-w-sm'>
                        <p>{t('settings.documents.ocrEnabled.tooltip', 'Force Docling for OCR/scanned documents with layout-aware extraction. Provides better structure detection but slower processing.')}</p>
                      </TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                </div>
                <Switch
                  checked={ocrEnabled}
                  onCheckedChange={setOcrEnabled}
                  aria-label={t('settings.documents.ocrEnabled.label', 'Enable OCR Processing')}
                  data-testid="settings-tab-documents-ocr-toggle"
                />
              </div>
              <p className='text-xs text-zinc-500 dark:text-zinc-400'>
                {t('settings.documents.ocrEnabled.description', 'When enabled, uses Docling for layout-aware extraction (detects headers, titles, quotes). When disabled, uses PyMuPDF4LLM for faster text-only extraction.')}
              </p>
            </div>

            {/* Chunk Size Selection */}
            <div className='space-y-2 pt-3'>
              <label className='text-sm font-medium text-zinc-700 dark:text-zinc-300'>
                {t('settings.documents.chunkingOptions.size.label')}
              </label>
              <Select value={chunkSize} onValueChange={setChunkSize}>
                <SelectTrigger className='w-full border-zinc-300 dark:border-zinc-700' data-testid="settings-tab-documents-chunk-size-select">
                  <SelectValue>
                    {translatedChunkSizeOptions.find(opt => opt.value === chunkSize)?.label ||
                      t('settings.documents.chunkingOptions.selectPlaceholder')}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent className='z-[1100]'>
                  {translatedChunkSizeOptions.map(option => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Chunk Overlap Selection */}
            <div className='space-y-2'>
              <label className='text-sm font-medium text-zinc-700 dark:text-zinc-300'>
                {t('settings.documents.chunkingOptions.overlap.label')}
              </label>
              <Select value={chunkOverlap} onValueChange={setChunkOverlap}>
                <SelectTrigger className='w-full border-zinc-300 dark:border-zinc-700' data-testid="settings-tab-documents-chunk-overlap-select">
                  <SelectValue>
                    {translatedChunkOverlapOptions.find(opt => opt.value === chunkOverlap)?.label ||
                      t('settings.documents.chunkingOptions.selectPlaceholder')}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent className='z-[1100]'>
                  {translatedChunkOverlapOptions.map(option => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        </div>
        )}

        {/* Citation Style Card */}
        <div className='relative overflow-hidden bg-white dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 p-4 shadow-sm'>
          <div className='flex items-start gap-3 mb-5'>
            <div className='w-10 h-10 flex items-center justify-center mt-1'>
              <FolderOpen className='w-5 h-5 text-emerald-600 dark:text-emerald-400' />
            </div>
            <div className='flex-1'>
              <h3 className='text-lg font-semibold text-zinc-900 dark:text-white'>
                {t('settings.citationStyle.title', 'Citation Style')}
              </h3>
              <p className='text-sm text-zinc-600 dark:text-zinc-400'>
                {t('settings.citationStyle.description', 'Default citation format for notes and bibliography.')}
              </p>
            </div>
          </div>
          <div className='pl-13'>
            <Select
              value={(() => { try { return localStorage.getItem('scrapalot_citation_style') || 'apa'; } catch { return 'apa'; } })()}
              onValueChange={value => {
                try { localStorage.setItem('scrapalot_citation_style', value); } catch { /* ignore */ }
                toast.success(t('settings.citationStyle.saved', 'Citation style saved'));
              }}
            >
              <SelectTrigger className='w-full max-w-xs border-zinc-300 dark:border-zinc-700 hover:border-emerald-500 dark:hover:border-emerald-500 transition-colors h-11'>
                <SelectValue />
              </SelectTrigger>
              <SelectContent className='z-[1100] max-h-[300px]'>
                {[
                  { group: 'popular', label: t('settings.citationStyle.popular', 'Popular') },
                  { group: 'author-date', label: t('settings.citationStyle.authorDate', 'Author-Date') },
                  { group: 'numeric', label: t('settings.citationStyle.numeric', 'Numeric') },
                  { group: 'humanities', label: t('settings.citationStyle.humanities', 'Humanities') },
                  { group: 'regional', label: t('settings.citationStyle.regional', 'Regional') },
                ].map(({ group, label }) => {
                  const styles = CITATION_STYLES.filter(s => s.group === group);
                  if (styles.length === 0) return null;
                  return (
                    <React.Fragment key={group}>
                      <SelectItem value={`__group_${group}`} disabled className="text-xs font-semibold text-muted-foreground">{label}</SelectItem>
                      {styles.map(s => (
                        <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>
                      ))}
                    </React.Fragment>
                  );
                })}
              </SelectContent>
            </Select>
          </div>
        </div>

        {/* Document Chunking Strategy Section */}
        <div className='pt-4'>
          <div className='flex items-center gap-2'>
            <h3 className='text-base font-medium text-zinc-800 dark:text-white mb-2'>
              {t('settings.documents.chunkingOptions.title')}
            </h3>
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <HelpCircle className='h-4 w-4 text-zinc-500 dark:text-zinc-400' />
                </TooltipTrigger>
                <TooltipContent side='top' className='max-w-sm'>
                  <p>{t('settings.documents.chunkingOptions.description')}</p>
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          </div>

          <p className='text-sm text-zinc-600 dark:text-zinc-400 mb-4'>
            {t('settings.documents.chunkingOptions.recommended')}
          </p>

          <div className='space-y-4'>
            <div className='border border-zinc-200 dark:border-zinc-800 rounded-lg overflow-hidden'>
              <table className='w-full text-sm'>
                <thead>
                  <tr className='bg-zinc-100 dark:bg-zinc-800'>
                    <th className='text-left py-2 px-4 font-medium'>
                      {t('settings.documents.chunkingOptions.size.label')}
                    </th>
                    <th className='text-left py-2 px-4 font-medium'>
                      {t('settings.documents.chunkingOptions.recommendedFor')}
                    </th>
                    <th className='text-left py-2 px-4 font-medium'>
                      {t('settings.documents.chunkingOptions.performance')}
                    </th>
                  </tr>
                </thead>
                <tbody className='divide-y divide-zinc-200 dark:divide-zinc-800'>
                  <tr className='bg-white dark:bg-zinc-950'>
                    <td className='py-3 px-4 font-mono'>256 chars</td>
                    <td className='py-3 px-4'>
                      {t(
                        'settings.documents.chunkingOptions.specificFactualQueries'
                      )}
                    </td>
                    <td className='py-3 px-4'>
                      {t(
                        'settings.documents.chunkingOptions.highPrecisionLessContext'
                      )}
                    </td>
                  </tr>
                  <tr className='bg-green-50 dark:bg-green-950/20'>
                    <td className='py-3 px-4 font-mono font-bold'>
                      512 chars
                    </td>
                    <td className='py-3 px-4'>
                      {t('settings.documents.chunkingOptions.generalPurpose')}
                    </td>
                    <td className='py-3 px-4'>
                      {t('settings.documents.chunkingOptions.bestBalance')}
                    </td>
                  </tr>
                  <tr className='bg-white dark:bg-zinc-950'>
                    <td className='py-3 px-4 font-mono'>1024 chars</td>
                    <td className='py-3 px-4'>
                      {t('settings.documents.chunkingOptions.complexQuestions')}
                    </td>
                    <td className='py-3 px-4'>
                      {t(
                        'settings.documents.chunkingOptions.betterContextMayIncludeIrrelevantInfo'
                      )}
                    </td>
                  </tr>
                  <tr className='bg-white dark:bg-zinc-950'>
                    <td className='py-3 px-4 font-mono'>2048 chars</td>
                    <td className='py-3 px-4'>
                      {t(
                        'settings.documents.chunkingOptions.multiPartQuestions'
                      )}
                    </td>
                    <td className='py-3 px-4'>
                      {t(
                        'settings.documents.chunkingOptions.maximumContextPotentialNoise'
                      )}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>

            <div className='flex items-start gap-2 mt-4'>
              <Diode variant="green" size="md" pulse={true} aria-label="Recommended setting indicator" className="mt-1.5 shrink-0" />
              <p className='text-sm text-zinc-800 dark:text-zinc-200'>
                <strong>
                  {t('settings.documents.chunkingOptions.recommended')}
                </strong>
                : 512 chars with 20% overlap (about 100 chars)
              </p>
            </div>

            <p className='text-sm text-zinc-600 dark:text-zinc-400'>
              {t('settings.documents.chunkingOptions.customize')}
            </p>
          </div>
        </div>

        {/* Advanced Chunking Settings Tabs */}
        <div className='pt-4'>
          <h3 className='text-base font-medium text-zinc-800 dark:text-white mb-4'>
            {t('settings.documents.advancedChunkingOptions.title')}
          </h3>

          {/* Document Splitting Strategy Selection */}
          <div className='space-y-2 mb-6'>
            <label className='text-sm font-medium text-zinc-700 dark:text-zinc-300'>
              {t('settings.documents.splitterType.label')}
            </label>
            <Select value={splitterType} onValueChange={setSplitterType}>
              <SelectTrigger className='w-full border-zinc-300 dark:border-zinc-700' data-testid="settings-tab-documents-splitter-type-select">
                <SelectValue>
                  {splitterType ? t(`settings.documents.splitterType.${splitterType}`) :
                    t('settings.documents.splitterType.placeholder')}
                </SelectValue>
              </SelectTrigger>
              <SelectContent className='z-[1100]'>
                {/* Basic Strategies */}
                <SelectItem value='enhanced_markdown'>
                  {t('settings.documents.splitterType.enhanced_markdown')}
                </SelectItem>
                <SelectItem value='semantic'>
                  {t('settings.documents.splitterType.semantic')}
                </SelectItem>
                <SelectItem value='recursive'>
                  {t('settings.documents.splitterType.recursive')}
                </SelectItem>
                <SelectItem value='proposition'>
                  {t('settings.documents.splitterType.proposition')}
                </SelectItem>

                {/* Advanced Strategies */}
                <SelectItem value='hierarchical'>
                  {t('settings.documents.splitterType.hierarchical')}
                </SelectItem>
                <SelectItem value='topic_based'>
                  {t('settings.documents.splitterType.topic_based')}
                </SelectItem>
                <SelectItem value='sliding_window'>
                  {t('settings.documents.splitterType.sliding_window')}
                </SelectItem>
                <SelectItem value='agentic'>
                  {t('settings.documents.splitterType.agentic')}
                </SelectItem>
                <SelectItem value='concept_aware'>
                  {t('settings.documents.splitterType.concept_aware')}
                </SelectItem>
                <SelectItem value='narrative_structure'>
                  {t('settings.documents.splitterType.narrative_structure')}
                </SelectItem>

                {/* LangChain Strategies */}
                <SelectItem value='token_based'>
                  {t('settings.documents.splitterType.token_based')}
                </SelectItem>
                <SelectItem value='gpt_token'>
                  {t('settings.documents.splitterType.gpt_token')}
                </SelectItem>
                <SelectItem value='claude_token'>
                  {t('settings.documents.splitterType.claude_token')}
                </SelectItem>
                <SelectItem value='openai_semantic'>
                  {t('settings.documents.splitterType.openai_semantic')}
                </SelectItem>
                <SelectItem value='huggingface_semantic'>
                  {t('settings.documents.splitterType.huggingface_semantic')}
                </SelectItem>
                <SelectItem value='document_structure'>
                  {t('settings.documents.splitterType.document_structure')}
                </SelectItem>
                <SelectItem value='langchain_markdown'>
                  {t('settings.documents.splitterType.langchain_markdown')}
                </SelectItem>
                <SelectItem value='html'>
                  {t('settings.documents.splitterType.html')}
                </SelectItem>
                <SelectItem value='code'>
                  {t('settings.documents.splitterType.code')}
                </SelectItem>
              </SelectContent>
            </Select>
            <p className='text-xs text-zinc-500 dark:text-zinc-400 mt-1'>
              {splitterType === 'semantic' &&
                t('settings.documents.splitterType.semanticDescription')}
              {splitterType === 'recursive' &&
                t('settings.documents.splitterType.recursiveDescription')}
              {splitterType === 'enhanced_markdown' &&
                t(
                  'settings.documents.splitterType.enhanced_markdownDescription'
                )}
              {splitterType === 'proposition' &&
                t('settings.documents.splitterType.propositionDescription')}
              {splitterType === 'hierarchical' &&
                t('settings.documents.splitterType.hierarchicalDescription')}
              {splitterType === 'topic_based' &&
                t('settings.documents.splitterType.topic_basedDescription')}
              {splitterType === 'sliding_window' &&
                t(
                  'settings.documents.splitterType.sliding_windowDescription'
                )}
              {splitterType === 'agentic' &&
                t('settings.documents.splitterType.agenticDescription')}
              {splitterType === 'concept_aware' &&
                t('settings.documents.splitterType.concept_awareDescription')}
              {splitterType === 'narrative_structure' &&
                t(
                  'settings.documents.splitterType.narrative_structureDescription'
                )}
              {splitterType === 'token_based' &&
                t('settings.documents.splitterType.token_basedDescription')}
              {splitterType === 'gpt_token' &&
                t('settings.documents.splitterType.gpt_tokenDescription')}
              {splitterType === 'claude_token' &&
                t('settings.documents.splitterType.claude_tokenDescription')}
              {splitterType === 'openai_semantic' &&
                t(
                  'settings.documents.splitterType.openai_semanticDescription'
                )}
              {splitterType === 'huggingface_semantic' &&
                t(
                  'settings.documents.splitterType.huggingface_semanticDescription'
                )}
              {splitterType === 'document_structure' &&
                t(
                  'settings.documents.splitterType.document_structureDescription'
                )}
              {splitterType === 'langchain_markdown' &&
                t(
                  'settings.documents.splitterType.langchain_markdownDescription'
                )}
              {splitterType === 'html' &&
                t('settings.documents.splitterType.htmlDescription')}
              {splitterType === 'code' &&
                t('settings.documents.splitterType.codeDescription')}
            </p>
          </div>

        </div>

        {/* Workspace-level annotation colour labels — sits next to the
            embedding / processing cards because annotations are
            inherently document-scoped concerns. */}
        <SettingsCardAnnotationColors />
      </div>

      {/* Hidden PopoverEmbeddingSettings for external control */}
      {isEmbeddingPopoverOpen && (
        <PopoverEmbeddingSettings
          embeddingModel={embeddingModel}
          setEmbeddingModel={setEmbeddingModel}
          splitterType={splitterType}
          setSplitterType={setSplitterType}
          chunkSize={chunkSize}
          setChunkSize={setChunkSize}
          chunkOverlapping={chunkOverlap}
          setChunkOverlapping={setChunkOverlap}
          chunkSizesToIgnore={chunkSizesToIgnore.toString()}
          setChunkSizesToIgnore={(value) => setChunkSizesToIgnore(parseInt(value) || 20)}
          externalOpen={isEmbeddingPopoverOpen}
          onExternalOpenChange={setIsEmbeddingPopoverOpen}
          hideButton={true}
        />
      )}
    </>
  );
};
