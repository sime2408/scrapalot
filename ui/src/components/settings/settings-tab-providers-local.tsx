import React, { useEffect, useRef, useState } from 'react';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import {
  ArrowLeft,
  Cpu,
  Download,
  Edit,
  Heart,
  InfoIcon,
  Loader2,
  RefreshCw,
  Search,
  Server,
  ShieldCheck,
  Trash2,
  X,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { useTranslation } from 'react-i18next';
import {
  useIsMobileOrTabletPortrait,
  useIsNarrowScreen,
} from '@/hooks/use-mobile';
import { toast } from '@/lib/toast-compat';
import {
  calculateModelCompatibility,
  calculateModelMemoryRequirements,
  createDownloadProgressStream,
  deleteModel,
  downloadModel,
  getAppropriateModels,
  getInstalledModels,
  getLocalModelStatus,
  getSystemCapabilities,
} from '@/lib/api-llm-inference';
import {
  DownloadProgress,
  LocalModel,
  SystemCapabilities,
} from '@/types/llm-types.ts';

interface SettingsTabProvidersLocalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  preloadedFeaturedModels?: LocalModel[];
  preloadedInstalledModels?: LocalModel[];
  preloadedActiveModel?: string | null;
  isAdmin?: boolean;
}

// SystemInfo component - moved above SettingsTabProvidersLocal
const SystemInfo = ({
  systemCapabilities,
  isLoadingCapabilities,
}: {
  systemCapabilities: SystemCapabilities | null;
  isLoadingCapabilities: boolean;
}) => {
  const { t } = useTranslation();

  // Calculate memory examples for different model sizes based on current system
  const calculateMemoryExample = () => {
    if (!systemCapabilities) return null;

    // Use recommended quantization from system (int8 or fp16)
    const quantBits =
      systemCapabilities.recommended_quantization === 'fp16' ? 16 : 8;

    // Calculate for a sample model size appropriate for the hardware
    const modelSize = systemCapabilities.has_gpu ? 13 : 2; // 13B for GPU, 2B for CPU
    const memoryNeeded = calculateModelMemoryRequirements(modelSize, quantBits);
    const isCompatible =
      memoryNeeded <=
      (systemCapabilities?.memory?.available_gpu_mb ||
        systemCapabilities?.memory?.available_cpu_mb ||
        0) /
      1024;

    return (
      <div className='mt-1 pt-1 border-t border-zinc-200 dark:border-zinc-800 text-xs'>
        <div className='text-zinc-600 dark:text-zinc-400 italic'>
          {t('settings.providersLocal.systemInfo.memoryFormula', {
            defaultValue: 'Memory (GB) = (P × 4B) ÷ (32/Q) × 1.2',
          })}
        </div>
        <div className='text-zinc-500 dark:text-zinc-500 text-[10px] mb-1'>
          P: parameters in billions, Q: bits ({quantBits}, etc.)
        </div>
        <div
          className={`text-xs ${isCompatible
            ? 'text-green-600 dark:text-green-500'
            : 'text-amber-600 dark:text-amber-500'
            }`}
        >
          Example: A {modelSize}B model needs {memoryNeeded} GB{' '}
          {isCompatible ? '✓' : '⚠️'}
        </div>
      </div>
    );
  };

  return (
    <div className='p-2 bg-zinc-50 dark:bg-zinc-900 text-xs border border-zinc-200 dark:border-zinc-800'>
      <div className='flex items-center gap-1 mb-1'>
        <InfoIcon className='h-3 w-3 text-blue-500' />
        <h3 className='font-medium text-zinc-900 dark:text-white text-xs'>
          {t('settings.providersLocal.systemInfo.title', {
            defaultValue: 'System Compatibility',
          })}
        </h3>
      </div>
      {isLoadingCapabilities ? (
        <div className='flex items-center gap-1 text-zinc-500 dark:text-zinc-400'>
          <Loader2 className='h-3 w-3 animate-spin' />
          <span className='truncate'>
            {t('settings.providersLocal.systemInfo.loading', {
              defaultValue: 'Detecting system capabilities...',
            })}
          </span>
        </div>
      ) : systemCapabilities ? (
        <div className='space-y-1 text-zinc-700 dark:text-zinc-300'>
          <div className='flex items-center gap-1'>
            {systemCapabilities.has_gpu ? (
              <Server className='h-3 w-3 text-green-500 flex-shrink-0' />
            ) : (
              <Cpu className='h-3 w-3 text-amber-500 flex-shrink-0' />
            )}
            <span className='truncate'>
              {systemCapabilities.has_gpu
                ? t('settings.providersLocal.systemInfo.gpuDetected', {
                  name: systemCapabilities.primary_gpu?.name || 'GPU',
                  defaultValue: '{{name}} detected',
                })
                : t('settings.providersLocal.systemInfo.cpuOnly', {
                  defaultValue: 'CPU only (no GPU detected)',
                })}
            </span>
          </div>
          <div className='flex flex-col text-xs'>
            <span>
              {t('settings.providersLocal.systemInfo.memory', {
                memory: systemCapabilities?.memory?.available_gpu_mb
                  ? (systemCapabilities.memory.available_gpu_mb / 1024).toFixed(
                    1
                  )
                  : systemCapabilities?.memory?.cpu_memory_mb
                    ? (systemCapabilities.memory.cpu_memory_mb / 1024).toFixed(
                      1
                    )
                    : 'Unknown',
                defaultValue: 'Memory: {{memory}} GB',
              })}
            </span>
            <span>
              {t('settings.providersLocal.systemInfo.recommendedSize', {
                size: systemCapabilities?.has_gpu
                  ? systemCapabilities?.primary_gpu?.total_memory_mb
                    ? Math.floor(
                      (systemCapabilities.primary_gpu.total_memory_mb /
                        1024) *
                      0.7
                    ).toString()
                    : 'N/A'
                  : '1-3',
                defaultValue: 'Recommended: {{size}} B parameters',
              })}
            </span>
            {systemCapabilities?.has_gpu ? (
              calculateMemoryExample()
            ) : (
              <div className='mt-1 pt-1 border-t border-zinc-200 dark:border-zinc-800'>
                <div className='text-zinc-600 dark:text-zinc-400 text-xs'>
                  {t('settings.providersLocal.systemInfo.cpuModelInfo', {
                    defaultValue: 'Showing CPU-friendly models (0-3B)',
                  })}
                </div>
                {calculateMemoryExample()}
                <div className='mt-1 text-green-500 dark:text-green-400 text-xs font-medium'>
                  {t('settings.providersLocal.systemInfo.cpuAdvantages', {
                    defaultValue: 'Small models work great on CPU!',
                  })}
                </div>
              </div>
            )}
          </div>
        </div>
      ) : (
        <div className='text-zinc-500 dark:text-zinc-400 text-xs'>
          {t('settings.providersLocal.systemInfo.notAvailable', {
            defaultValue: 'System information not available',
          })}
        </div>
      )}
    </div>
  );
};

// Function to thoroughly clean tags before display - moved to global scope
export const SettingsTabProvidersLocal = ({
  open,
  onOpenChange,
  preloadedFeaturedModels = [],
  preloadedInstalledModels = [],
  preloadedActiveModel = null,
  isAdmin = false,
}: SettingsTabProvidersLocalProps) => {
  const { t } = useTranslation();
  // toast is now imported directly
  const isMobileOrTabletPortrait = useIsMobileOrTabletPortrait();
  const isNarrowScreen = useIsNarrowScreen();
  const [activeTab, setActiveTab] = useState<'featured' | 'installed'>(
    'featured'
  );

  // State for models
  const [featuredModels, setFeaturedModels] = useState<LocalModel[]>([]);
  const [installedModels, setInstalledModels] = useState<LocalModel[]>([]);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  // Active model concept removed - no longer tracking active model state

  // System capabilities state
  const [systemCapabilities, setSystemCapabilities] =
    useState<SystemCapabilities | null>(null);
  const [isLoadingCapabilities, setIsLoadingCapabilities] =
    useState<boolean>(false);

  // Search state
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [isSearching, setIsSearching] = useState<boolean>(false);

  // System info popup state
  const [isSystemInfoOpen, setIsSystemInfoOpen] = useState<boolean>(false);

  // State to track downloads in progress
  const [downloadingModels, setDownloadingModels] = useState<
    Record<string, number>
  >({});

  // References to active event source connections
  const activeStreams = useRef<Record<string, () => void>>({});

  // Add state for deletion dialog
  const [deleteDialogOpen, setDeleteDialogOpen] = useState<boolean>(false);
  const [modelToDelete, setModelToDelete] = useState<string | null>(null);

  // Use preloaded data if available
  useEffect(() => {
    if (preloadedFeaturedModels && preloadedFeaturedModels.length > 0) {
      setFeaturedModels(preloadedFeaturedModels);
    }

    if (preloadedInstalledModels && preloadedInstalledModels.length > 0) {
      setInstalledModels(preloadedInstalledModels);
    }

    // Active model concept removed - no longer setting active model from preloaded data
  }, [preloadedFeaturedModels, preloadedInstalledModels, preloadedActiveModel]);

  // Fetch system capabilities
  const fetchSystemCapabilities = async (bypassCache: boolean = false) => {
    try {
      setIsLoadingCapabilities(true);

      const capabilities = await getSystemCapabilities(bypassCache);

      setSystemCapabilities(capabilities);

      // Update the models with compatibility scores
      setFeaturedModels(prevModels =>
        prevModels.map(model => ({
          ...model,
          compatibility: calculateModelCompatibility(
            model.parameters || '0B',
            capabilities
          ),
        }))
      );

      setInstalledModels(prevModels =>
        prevModels.map(model => ({
          ...model,
          compatibility: calculateModelCompatibility(
            model.parameters || '0B',
            capabilities
          ),
        }))
      );
    } catch (error) {
      console.error('Error fetching system capabilities:', error);
      console.error('Full error details:', {
        message: error.message,
        stack: error.stack,
        response: error.response,
        config: error.config,
      });

      // Set fallback capabilities to prevent N/A display
      const fallbackCapabilities: SystemCapabilities = {
        os: 'unknown',
        architecture: 'unknown',
        python_version: 'unknown',
        has_gpu: false,
        device_type: 'cpu',
        memory: {
          gpu_memory_mb: 0,
          available_gpu_mb: 0,
          cpu_memory_mb: 8192, // 8GB in MB
          available_cpu_mb: 6144, // ~6GB available
        },
        recommended_quantization: 'int8',
      };

      setSystemCapabilities(fallbackCapabilities);

      // Don't show toast here - api.ts already handles connection errors globally
      // This prevents duplicate error messages
    } finally {
      setIsLoadingCapabilities(false);
    }
  };

  // Function to fetch models
  const fetchModels = async (bypassCache: boolean = false) => {
    // If we already have preloaded data and this is the first load,
    // only fetch if there's no data or if dialog is already open
    if (
      !open &&
      preloadedFeaturedModels.length > 0 &&
      preloadedInstalledModels.length > 0 &&
      !isSearching &&
      !bypassCache
    ) {
      setIsLoading(false);
      setIsSearching(false);
      return;
    }

    // If not forcing refresh, and we have data already, don't reload
    if (
      !bypassCache &&
      !isSearching &&
      featuredModels.length > 0 &&
      installedModels.length > 0
    ) {
      setIsLoading(false);
      return;
    }

    setIsLoading(true);
    try {
      // Clear caches to ensure fresh data
      if (bypassCache) {
        localStorage.removeItem('installed-models');
        localStorage.removeItem('featured-models');
        localStorage.removeItem('appropriate-models');
      }

      // Make parallel API calls for better performance
      const [installed, capabilities] = await Promise.all([
        getInstalledModels(bypassCache),
        getSystemCapabilities(bypassCache),
      ]);

      // Active model concept removed - no longer fetching or setting active model

      // Store system capabilities
      setSystemCapabilities(capabilities);

      // Get featured models appropriate for the system
      // This will return CPU-friendly models (1-3B) if on CPU-only system
      const featured = await getAppropriateModels(searchQuery, bypassCache);
      // Calculate compatibility scores and add to models
      const featuredWithCompatibility = featured.map(model => ({
        ...model,
        compatibility: calculateModelCompatibility(
          model.parameters || '0B',
          capabilities
        ),
      }));

      // Active model concept removed - no longer marking models as active
      const installedWithCompatibility = installed.map(model => ({
        ...model,
        // Keep original status - no active model concept
        compatibility: calculateModelCompatibility(
          model.parameters || '0B',
          capabilities
        ),
      }));

      setFeaturedModels(featuredWithCompatibility);
      setInstalledModels(installedWithCompatibility);
    } catch (error) {
      console.error('Error fetching models:', error);
      toast({
        title: t('settings.providersLocal.errors.failedToFetch'),
      });
    } finally {
      setIsLoading(false);
      setIsSearching(false);
    }
  };

  // Handle search input changes
  const handleSearchChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setSearchQuery(e.target.value);
  };

  // Handle search form submission
  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();

    // Check if the search query looks like an embedding model
    const embeddingKeywords = [
      'embed',
      'embedding',
      'bge',
      'e5',
      'sentence-transformer',
    ];
    const isEmbeddingSearch = embeddingKeywords.some(keyword =>
      searchQuery.toLowerCase().includes(keyword)
    );

    if (isEmbeddingSearch) {
      toast({
        title: t('settings.providersLocal.embeddingSearchTitle', {
          defaultValue: 'Embedding Model Search',
        }),
        description: t('settings.providersLocal.embeddingSearchMessage', {
          defaultValue:
            'Embedding models are configured in the embedding provider settings, not here. This section is for chat and reasoning models only.',
        }),
        duration: 6000,
      });
      return;
    }

    setIsSearching(true);
    void fetchModels(true);
  };

  // Function to handle model download
  const handleDownloadModel = async (model: LocalModel) => {
    if (!isAdmin) {
      toast({
        title: t('common.restricted'),
        description: t('settings.providersLocal.adminOnly'),
        variant: 'destructive',
      });
      return;
    }

    // Add a check for valid model ID and name
    if (!model || !model.id || !model.name) {
      console.error('Attempted to download model with invalid data:', model);
      toast({
        title: t('settings.providersLocal.errors.invalidModelData'),
        description: 'Cannot download model: Invalid model data provided.',
        variant: 'destructive',
      });
      return;
    }

    const modelId = model.id; // Keep using modelId for progress tracking keys
    try {
      // Close any existing stream for this model
      if (activeStreams.current[modelId]) {
        activeStreams.current[modelId]();
        delete activeStreams.current[modelId];
      }

      // Set initial progress with an explicit numeric value of 0
      setDownloadingModels(prev => ({ ...prev, [modelId]: 0 }));

      // Start the download - Pass the full model object now
      const downloadResponse = await downloadModel(model); // Pass only model object

      // Show warning for large or sharded models
      const modelInfo = downloadResponse.model_info;
      if (modelInfo && (modelInfo.is_large || modelInfo.is_sharded)) {
        const totalSizeEstimate = modelInfo.is_sharded
          ? `${modelInfo.size_gb * modelInfo.total_parts}GB (${modelInfo.total_parts
          } parts × ${modelInfo.size_gb}GB)`
          : `${modelInfo.size_gb}GB`;

        if (
          !confirm(
            `Warning: This model is ${modelInfo.is_large ? 'very large' : ''} ${modelInfo.is_large && modelInfo.is_sharded ? 'and' : ''
            } ${modelInfo.is_sharded ? 'split into multiple files' : ''}.\n\n` +
            `Estimated total size: ${totalSizeEstimate}\n\n` +
            `Downloading may fail or take a very long time. Continue anyway?`
          )
        ) {
          // User cancelled, clean up
          setDownloadingModels(prev => {
            const newState = { ...prev };
            delete newState[modelId];
            return newState;
          });
          return;
        }
      }

      // Store the stream reference
      activeStreams.current[modelId] = createDownloadProgressStream(
        modelId,
        // Progress handler
        (progress: DownloadProgress) => {
          // Make sure we're using a numeric progress value, default to 0 if undefined
          const progressValue =
            typeof progress.progress === 'number' ? progress.progress : 0;



          // Ensure we're setting a numeric value between 0-100
          setDownloadingModels(prev => ({
            ...prev,
            [modelId]: Math.max(0, Math.min(100, progressValue)),
          }));
        },
        // Complete handler
        () => {
          toast({
            title: t('settings.providersLocal.success.downloadComplete'),
          });

          // Clear from downloading models with a small delay for animation
          setTimeout(() => {
            setDownloadingModels(prev => {
              const newState = { ...prev };
              delete newState[modelId];
              return newState;
            });

            // Refresh the models list
            void fetchModels(true);

            // Remove from active streams
            delete activeStreams.current[modelId];
          }, 500);
        },
        // Error handler
        (error: string) => {
          // Show different error messages based on the error
          if (error.includes('disk space')) {
            toast({
              title: t('settings.providersLocal.errors.downloadFailed'),
              description: t(
                'settings.providersLocal.errors.notEnoughDiskSpace'
              ),
              duration: 8000,
            });
          } else if (
            error.includes('timeout') ||
            error.includes('connection') ||
            error === 'Connection to server lost'
          ) {
            // If we have model info about size, use it for a more informative message
            if (modelInfo && (modelInfo.is_large || modelInfo.is_sharded)) {
              const sizeInfo = modelInfo.is_sharded
                ? `multi-part model (${modelInfo.total_parts} parts, ~${modelInfo.size_gb * modelInfo.total_parts
                }GB total)`
                : `large model (${modelInfo.size_gb}GB)`;

              toast({
                title: t('settings.providersLocal.errors.downloadFailed'),
                description: t(
                  'settings.providersLocal.errors.largeModelDownloadWarning',
                  { sizeInfo }
                ),
                duration: 8000,
              });
            } else {
              toast({
                title: t('settings.providersLocal.errors.downloadFailed'),
                description: error,
                duration: 5000,
              });
            }
          } else {
            toast({
              title: t('settings.providersLocal.errors.downloadFailed'),
              description: error,
            });
          }

          // Clear from downloading models
          setDownloadingModels(prev => {
            const newState = { ...prev };
            delete newState[modelId];
            return newState;
          });

          // Remove from active streams
          delete activeStreams.current[modelId];
        }
      );
    } catch (error) {
      console.error('Error downloading model:', error);
      toast({
        title: t('settings.providersLocal.errors.failedToDownload'),
      });

      // Clear from downloading models
      setDownloadingModels(prev => {
        const newState = { ...prev };
        delete newState[modelId];
        return newState;
      });
    }
  };

  // Fetch models only when dialog is opened
  useEffect(() => {
    if (open) {
      void fetchSystemCapabilities();
      void fetchModels();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- deps are intentionally limited
  }, [open]);

  useEffect(() => {
    return () => {
      // Close all active streams
      Object.values(activeStreams.current).forEach(closeStream =>
        closeStream()
      );
      activeStreams.current = {};
    };
  }, []);

  // Function to handle model deletion
  const handleDeleteModel = async (modelId: string) => {
    if (!isAdmin) {
      toast({
        title: t('common.restricted'),
        description: t('settings.providersLocal.adminOnly'),
        variant: 'destructive',
      });
      return;
    }

    // Set the model to delete and open the dialog
    setModelToDelete(modelId);
    setDeleteDialogOpen(true);
  };

  // Function to confirm and execute model deletion
  const confirmDeleteModel = async () => {
    if (!modelToDelete) return;

    try {


      // Get the installed model object to have complete information
      const modelToDeleteObj = installedModels.find(
        m => m.id === modelToDelete
      );
      if (!modelToDeleteObj) {
        console.error(
          `Model ${modelToDelete} not found in installed models list`
        );
        toast({
          title: t('settings.providersLocal.errors.modelNotFound'),
        });
        setDeleteDialogOpen(false);
        setModelToDelete(null);
        return;
      }

      // Extract base model name for sharded models (removing the -00001-of-00005 suffix)
      let baseModelId = modelToDelete;

      // Check if this is a sharded model (has pattern -00001-of-00005)
      if (/-\d{5}-of-\d{5}$/.test(modelToDelete)) {
        baseModelId = modelToDelete.replace(/-\d{5}-of-\d{5}$/, '');

      }

      // Try to delete the model
      await deleteModel(baseModelId);

      toast({
        title: t('settings.providersLocal.success.modelDeleted'),
      });

      // Close the dialog
      setDeleteDialogOpen(false);
      setModelToDelete(null);

      // Refresh the models list
      void fetchModels(true);
    } catch (error) {
      console.error('Error deleting model:', error);

      // Handle specific error cases
      const errorMessage =
        error instanceof Error ? error.message : String(error);

      // Special handling for directory error
      if (
        errorMessage.includes('directory not found') ||
        errorMessage.includes('GGUF directory')
      ) {
        // Get the status to check models directory path
        try {
          const status = await getLocalModelStatus();

          toast({
            title: t('settings.providersLocal.errors.directoryNotFound'),
            description: `Models directory: ${status.models_directory}`,
            variant: 'destructive',
            duration: 7000,
          });

          // Despite the error, remove the model from the UI list
          // This helps when the disk files are missing but DB entries exist
          setInstalledModels(prev =>
            prev.filter(model => model.id !== modelToDelete)
          );
        } catch (statusError) {
          toast({
            title: t('settings.providersLocal.errors.failedToDelete'),
            description: errorMessage,
            variant: 'destructive',
          });
        }
      } else {
        toast({
          title: t('settings.providersLocal.errors.failedToDelete'),
          description: errorMessage,
          variant: 'destructive',
        });
      }

      // Close the dialog despite the error to avoid user confusion
      setDeleteDialogOpen(false);
      setModelToDelete(null);

      // Always refresh to ensure UI is in sync with actual state
      void fetchModels(true);
    }
  };

  // Active model concept removed - users must explicitly select models in ChatModelSelector

  // Load models when the component mounts or the dialog opens
  useEffect(() => {
    if (open) {
      void fetchModels();
      void fetchSystemCapabilities();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- deps are intentionally limited
  }, [open]);

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
          <DialogContent
            className={cn(
              'w-[950px] max-w-none h-[630px] p-0 bg-card dark:bg-black overflow-visible z-[1550]',
              (isMobileOrTabletPortrait || isNarrowScreen) &&
              'h-dvh max-h-none w-full max-w-full rounded-none z-[1550]'
            )}
            overlayZIndex="1500"
            disableBackdropClose={true}
            hideCloseButton={true}
            forceMobileBackButton={isMobileOrTabletPortrait || isNarrowScreen}
            dialogOpen={open}
            onOpenChange={onOpenChange}
          >
            <DialogTitle className='sr-only'>
              {t('settings.providersLocal.title')}
            </DialogTitle>
            {/* Hide close button on mobile and tablet portrait - use back button instead */}
            {!(isMobileOrTabletPortrait || isNarrowScreen) && (
              <DialogClose className='absolute -right-4 -top-5 z-[1600] rounded-full border border-border dark:border-zinc-700 bg-card dark:bg-black p-0 w-8 h-8 flex items-center justify-center hover:bg-secondary dark:hover:bg-zinc-900'>
                <X className='h-4 w-4 text-zinc-800 dark:text-white' />
              </DialogClose>
            )}

            <div
              className={cn(
                'h-full overflow-y-auto',
                isMobileOrTabletPortrait ? 'p-4' : 'p-6'
              )}
            >
              {/* Header area with title, search, and system compatibility */}
              <div className='flex flex-col md:flex-row md:justify-between md:items-center mb-6 gap-4 md:gap-0'>
                {/* Mobile Back Button */}
                {(isMobileOrTabletPortrait || isNarrowScreen) && (
                  <div className='flex items-center gap-3 mb-2'>
                    <Button
                      variant='ghost'
                      size='sm'
                      onClick={() => onOpenChange(false)}
                      className='h-8 w-8 p-0 text-zinc-600 hover:text-zinc-700 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:text-zinc-300 dark:hover:bg-zinc-800'
                    >
                      <ArrowLeft className='h-4 w-4' />
                    </Button>
                    <h2 className='text-lg font-semibold text-zinc-900 dark:text-white'>
                      {t('settings.providersLocal.title')}
                    </h2>
                  </div>
                )}

                <div className='hidden lg:block'>
                  <h2 className='text-2xl font-bold text-zinc-900 dark:text-white mb-1'>
                    {t('settings.providersLocal.title')}
                  </h2>
                  <p className='text-sm text-zinc-500 dark:text-zinc-400'>
                    Browse and install local AI models
                  </p>
                </div>

                {/* Search moved to top right, compact version */}
                {activeTab === 'featured' && (
                  <div className='flex items-center justify-center md:justify-end gap-2 w-full md:w-auto'>
                    {/* System info button that shows a popover */}
                    <div className='relative'>
                      <Button
                        variant='ghost'
                        size='sm'
                        onClick={() => setIsSystemInfoOpen(!isSystemInfoOpen)}
                        className='h-8 w-8 p-0 text-zinc-600 hover:text-zinc-700 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:text-zinc-300 dark:hover:bg-zinc-800 touch-manipulation'
                      >
                        <Cpu className='h-4 w-4' />
                      </Button>
                      {isSystemInfoOpen && (
                        <>
                          {/* Invisible click-away layer — no dim/blur so the
                              models behind the popover stay readable */}
                          <div
                            className='fixed inset-0 z-40'
                            onClick={() => setIsSystemInfoOpen(false)}
                          />
                          <div className='absolute right-0 md:right-0 left-0 md:left-auto top-9 z-50 w-[calc(100vw-6rem)] md:w-[250px] mx-auto'>
                            <SystemInfo
                              systemCapabilities={systemCapabilities}
                              isLoadingCapabilities={isLoadingCapabilities}
                            />
                          </div>
                        </>
                      )}
                    </div>

                    <form
                      onSubmit={handleSearch}
                      className='w-full md:w-64 max-w-sm'
                    >
                      <div className='relative'>
                        <input
                          type='text'
                          placeholder={t(
                            'settings.providersLocal.searchPlaceholder',
                            { range: '8B-33B' }
                          )}
                          className='w-full h-8 pr-16 pl-3 py-1 text-sm border border-border dark:border-zinc-700 bg-input dark:bg-zinc-900 text-foreground dark:text-white focus:outline-none'
                          value={searchQuery}
                          onChange={handleSearchChange}
                          data-testid="settings-providers-local-search-input"
                        />
                        <div className='absolute right-0 top-0 h-full flex items-center'>
                          {searchQuery && (
                            <button
                              type='button'
                              className='h-8 px-2 text-zinc-500 hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-300'
                              onClick={() => {
                                setSearchQuery('');
                                void fetchModels(true);
                              }}
                            >
                              <X className='h-3 w-3' />
                            </button>
                          )}
                          <Button
                            type='submit'
                            variant='ghost'
                            size='sm'
                            disabled={isSearching}
                            className='h-8 px-3 rounded-l-none text-zinc-600 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200'
                          >
                            {isSearching ? (
                              <Loader2 className='h-3.5 w-3.5 animate-spin' />
                            ) : (
                              <Search className='h-3.5 w-3.5' />
                            )}
                          </Button>
                        </div>
                      </div>
                    </form>
                  </div>
                )}
              </div>

              {activeTab === 'featured' && (
                <p className='text-xs text-zinc-500 dark:text-zinc-400 mb-4 text-right'>
                  {t('settings.providersLocal.parameterFilterInfo', {
                    range: '8B-33B',
                  })}
                  <br />
                  <span className='text-amber-600 dark:text-amber-400'>
                    {t('settings.providersLocal.embeddingModelNote', {
                      defaultValue:
                        'Note: For embedding models use the embedding provider settings instead.',
                    })}
                  </span>
                </p>
              )}

              {/* Tab navigation - made to look more like actual tabs */}
              <div className='border-b border-zinc-200 dark:border-zinc-800 mb-4'>
                <div className='flex'>
                  <button
                    className={cn(
                      'px-4 py-2 text-sm font-medium border-b-2 -mb-px',
                      activeTab === 'featured'
                        ? 'border-blue-500 text-blue-600 dark:text-blue-400'
                        : 'border-transparent text-zinc-600 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-white hover:border-zinc-300 dark:hover:border-zinc-700'
                    )}
                    onClick={() => setActiveTab('featured')}
                    data-testid="settings-providers-local-tab-featured"
                  >
                    {t('settings.providersLocal.tabs.featured')}
                  </button>
                  <button
                    className={cn(
                      'px-4 py-2 text-sm font-medium border-b-2 -mb-px',
                      activeTab === 'installed'
                        ? 'border-blue-500 text-blue-600 dark:text-blue-400'
                        : 'border-transparent text-zinc-600 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-white hover:border-zinc-300 dark:hover:border-zinc-700'
                    )}
                    onClick={() => setActiveTab('installed')}
                    data-testid="settings-providers-local-tab-installed"
                  >
                    {t('settings.providersLocal.tabs.installed')} (
                    {installedModels.length})
                  </button>

                  {/* More discrete Browse Models button placed in the tab bar, pushed to the right */}
                  <div className='ml-auto flex items-center gap-2'>
                    <Button
                      variant='ghost'
                      size='sm'
                      className='text-xs px-2 py-1 h-8 text-blue-600 hover:text-blue-700 hover:bg-blue-50 dark:text-blue-400 dark:hover:text-blue-300 dark:hover:bg-blue-900/20'
                      onClick={() =>
                        window.open(
                          'https://huggingface.co/models?pipeline_tag=text-generation&sort=trending&search=gguf',
                          '_blank'
                        )
                      }
                    >
                      <Download className='h-3.5 w-3.5 mr-1' />
                      {t('settings.providersLocal.tabs.browse')}
                    </Button>

                    <Button
                      variant='ghost'
                      size='sm'
                      className='text-xs px-2 py-1 h-8 text-zinc-600 hover:text-zinc-700 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:text-zinc-300 dark:hover:bg-zinc-800'
                      disabled={isLoading}
                      onClick={() => void fetchModels(true)}
                    >
                      {isLoading ? (
                        <Loader2 className='h-3.5 w-3.5 animate-spin' />
                      ) : (
                        <RefreshCw className='h-3.5 w-3.5' />
                      )}
                    </Button>
                  </div>
                </div>
              </div>

              {isLoading ? (
                <div className='flex flex-col items-center justify-center py-20'>
                  <Loader2 className='h-10 w-10 animate-spin text-zinc-500 dark:text-zinc-400' />
                  <p className='mt-4 text-zinc-500 dark:text-zinc-400'>
                    {t('settings.providersLocal.loadingModels')}
                  </p>
                </div>
              ) : activeTab === 'featured' ? (
                <div className='grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4'>
                  {featuredModels.map(model => (
                    <ModelCard
                      key={model.id}
                      model={model}
                      downloadProgress={downloadingModels[model.id]}
                      isDownloading={model.id in downloadingModels}
                      onDownload={() => handleDownloadModel(model)}
                      isAdmin={isAdmin}
                    />
                  ))}
                  {featuredModels.length === 0 && !isLoading && (
                    <div className='col-span-3 flex flex-col items-center justify-center py-10'>
                      <p className='text-zinc-500 dark:text-zinc-400'>
                        {searchQuery
                          ? t('settings.providersLocal.noSearchResults', {
                            query: searchQuery,
                          })
                          : t(
                            'settings.providersLocal.noFeaturedModelsAvailable'
                          )}
                      </p>
                      {searchQuery && (
                        <Button
                          variant='outline'
                          className='mt-4'
                          onClick={() => {
                            setSearchQuery('');
                            void fetchModels(true);
                          }}
                        >
                          {t('settings.providersLocal.clearSearch')}
                        </Button>
                      )}
                    </div>
                  )}
                </div>
              ) : (
                <div className='space-y-3'>
                  {installedModels.map(model => (
                    <InstalledModelCard
                      key={model.id}
                      model={model}
                      onDelete={() => handleDeleteModel(model.id)}
                      isAdmin={isAdmin}
                    />
                  ))}
                  {installedModels.length === 0 && (
                    <div className='flex flex-col items-center justify-center py-10'>
                      <p className='text-zinc-500 dark:text-zinc-400'>
                        {t('settings.providersLocal.noModelsInstalled')}
                      </p>
                      <Button
                        variant='outline'
                        className='mt-4'
                        onClick={() => setActiveTab('featured')}
                      >
                        {t('settings.providersLocal.actions.browse')}
                      </Button>
                    </div>
                  )}

                  <div className='mt-4 text-sm text-zinc-700 dark:text-zinc-300'>
                    {t('settings.providersLocal.moreModelsInfo')}{' '}
                    <span
                      className='text-blue-600 dark:text-blue-400 underline cursor-pointer'
                      onClick={() =>
                        window.open(
                          'https://huggingface.co/models?pipeline_tag=text-generation&sort=trending&search=gguf',
                          '_blank'
                        )
                      }
                    >
                      {t('settings.providersLocal.browseModels')}
                    </span>{' '}
                    {t('settings.providersLocal.moreModelsInfoEnd')}
                  </div>
                </div>
              )}
            </div>
          </DialogContent>
      </Dialog>

      {/* Add the delete confirmation dialog */}
      <Dialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <DialogContent
          className={cn(
            'sm:max-w-[425px] bg-card dark:bg-black z-[1650]',
            (isMobileOrTabletPortrait || isNarrowScreen) &&
            'h-full max-h-[100vh] max-w-full rounded-none z-[1650]'
          )}
          disableBackdropClose={true}
          dialogOpen={deleteDialogOpen}
          onOpenChange={setDeleteDialogOpen}
        >
          <DialogHeader>
            <DialogTitle className='text-zinc-900 dark:text-white'>
              {t('settings.providersLocal.confirmations.deleteModelTitle', {
                defaultValue: 'Delete Model',
              })}
            </DialogTitle>
            <DialogDescription className='text-zinc-600 dark:text-zinc-400'>
              {t('settings.providersLocal.confirmations.deleteModel')}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className='gap-2 mt-4'>
            <Button
              variant='outline'
              className='border-zinc-300 dark:border-zinc-700'
              onClick={() => setDeleteDialogOpen(false)}
            >
              {t('general.cancel', { defaultValue: 'Cancel' })}
            </Button>
            <Button
              variant='destructive'
              className='bg-red-500 hover:bg-red-600 text-white'
              onClick={confirmDeleteModel}
            >
              {t('general.delete', { defaultValue: 'Delete' })}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
};

interface InstalledModelCardProps {
  model: LocalModel;
  onDelete: () => void;
  isAdmin?: boolean;
}

const InstalledModelCard: React.FC<InstalledModelCardProps> = ({
  model,
  onDelete,
  isAdmin: _isAdmin = false,
}) => {
  const { t } = useTranslation();

  // Format the file size in a human-readable format
  const formatFileSize = (bytes: number): string => {
    if (bytes < 1024) return bytes + ' B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  };

  // Determine if this model is active
  const isActive = model.status === 'active';

  return (
    <div className='border border-zinc-200 dark:border-zinc-800 rounded-lg p-4'>
      {/* Mobile Layout */}
      <div className='flex flex-col gap-4 md:hidden'>
        {/* Header with icon and title */}
        <div className='flex items-start gap-4'>
          <div className='h-14 w-14 flex-shrink-0'>
            <img
              src={model.icon || '/providers/huggingface.svg'}
              alt={model.name}
              className='w-full h-full object-contain'
            />
          </div>
          <div className='flex-1 min-w-0'>
            <div className='flex items-center gap-3 mb-2'>
              <h3 className='font-semibold text-zinc-900 dark:text-white text-lg truncate'>
                {model.name}
              </h3>
              {isActive && (
                <span className='px-2 py-1 bg-green-100 dark:bg-green-900 text-green-800 dark:text-green-400 text-xs rounded-full font-medium flex-shrink-0'>
                  {t('settings.providersLocal.modelDetails.active')}
                </span>
              )}
              <Button
                variant='ghost'
                size='sm'
                className='h-8 w-8 p-0 group relative flex-shrink-0 ml-auto'
                title={t('settings.providersLocal.actions.edit')}
              >
                <Edit className='h-4 w-4 text-zinc-600 dark:text-zinc-400' />
                {model.description && (
                  <div className='absolute bottom-full right-0 mb-2 w-[calc(100vw-2rem)] p-3 bg-zinc-800 dark:bg-zinc-700 text-white text-sm rounded-lg shadow-lg opacity-0 invisible group-hover:opacity-100 group-hover:visible transition-opacity z-5'>
                    {model.description}
                  </div>
                )}
              </Button>
            </div>

            {/* Tags and file size */}
            <div className='flex flex-wrap items-center gap-2'>
              {model.tags &&
                Array.isArray(model.tags) &&
                model.tags
                  .filter(
                    tag =>
                      tag &&
                      typeof tag === 'string' &&
                      tag !== 'NaN undefined' &&
                      tag !== 'undefined'
                  )
                  .slice(0, 3)
                  .map((tag, index) => (
                    <span
                      key={index}
                      className='px-2.5 py-1 bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 text-xs rounded-full font-medium'
                    >
                      {t(`settings.providersLocal.modelDetails.tags.${tag}`, {
                        defaultValue: tag,
                      })}
                    </span>
                  ))}
              {model.tags && model.tags.length > 3 && (
                <span className='px-2.5 py-1 bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-400 text-xs rounded-full font-medium'>
                  +{model.tags.length - 3} more
                </span>
              )}
              <span className='px-2.5 py-1 bg-zinc-100 dark:bg-zinc-800 text-zinc-800 dark:text-zinc-300 text-xs rounded-full font-medium'>
                {formatFileSize(model.file_size)}
              </span>
            </div>
          </div>
        </div>

        {/* Date and Score */}
        <div className='flex items-center justify-between'>
          <span className='text-sm text-zinc-500 dark:text-zinc-400'>
            {model.installed_date || 'Recently installed'}
          </span>
          <ScoreCircle
            value={formatCompatibilityScore(model.compatibility)}
            maxValue={100}
            tooltipTitle={t('settings.providersLocal.modelDetails.modelScore')}
            tooltipContent={`Model compatibility score: ${formatCompatibilityScore(model.compatibility)}/100`}
            displayValue={`${formatCompatibilityScore(model.compatibility)}%`}
            size={10}
          />
        </div>

        {/* Action Buttons */}
        <div className='flex items-center justify-between'>
          <div></div>
          <Button
            variant='ghost'
            size='sm'
            className='h-10 w-10 p-0 text-red-500 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-950'
            title={t('settings.providersLocal.actions.delete')}
            onClick={onDelete}
          >
            <Trash2 className='h-5 w-5' />
          </Button>
        </div>
      </div>

      {/* Desktop Layout */}
      <div className='hidden md:flex md:justify-between md:items-center'>
        <div className='flex items-center gap-4'>
          <div className='h-12 w-12 flex-shrink-0'>
            <img
              src={model.icon || '/providers/huggingface.svg'}
              alt={model.name}
              className='w-full h-full object-contain'
            />
          </div>
          <div className='flex-1 min-w-0'>
            <div className='flex items-center gap-3 mb-2'>
              <h3 className='font-semibold text-zinc-900 dark:text-white text-base truncate'>
                {model.name}
              </h3>
              {isActive && (
                <span className='px-2 py-1 bg-green-100 dark:bg-green-900 text-green-800 dark:text-green-400 text-xs rounded-full font-medium flex-shrink-0'>
                  {t('settings.providersLocal.modelDetails.active')}
                </span>
              )}
              <Button
                variant='ghost'
                size='sm'
                className='h-8 w-8 p-0 group relative flex-shrink-0 ml-auto'
                title={t('settings.providersLocal.actions.edit')}
              >
                <Edit className='h-4 w-4 text-zinc-600 dark:text-zinc-400' />
                {model.description && (
                  <div className='absolute bottom-full left-1/2 -translate-x-1/2 mb-2 w-56 p-3 bg-zinc-800 dark:bg-zinc-700 text-white text-sm rounded-lg shadow-lg opacity-0 invisible group-hover:opacity-100 group-hover:visible transition-opacity z-5'>
                    {model.description}
                  </div>
                )}
              </Button>
            </div>

            {/* Tags and file size */}
            <div className='flex flex-wrap items-center gap-2'>
              {model.tags &&
                Array.isArray(model.tags) &&
                model.tags
                  .filter(
                    tag =>
                      tag &&
                      typeof tag === 'string' &&
                      tag !== 'NaN undefined' &&
                      tag !== 'undefined'
                  )
                  .slice(0, 3)
                  .map((tag, index) => (
                    <span
                      key={index}
                      className='px-2 py-0.5 bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 text-xs rounded-full font-medium'
                    >
                      {t(`settings.providersLocal.modelDetails.tags.${tag}`, {
                        defaultValue: tag,
                      })}
                    </span>
                  ))}
              {model.tags && model.tags.length > 3 && (
                <span className='px-2 py-0.5 bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-400 text-xs rounded-full font-medium'>
                  +{model.tags.length - 3} more
                </span>
              )}
              <span className='px-2 py-0.5 bg-zinc-100 dark:bg-zinc-800 text-zinc-800 dark:text-zinc-300 text-xs rounded-full font-medium'>
                {formatFileSize(model.file_size)}
              </span>
            </div>
          </div>
        </div>

        <div className='flex items-center gap-4'>
          <span className='text-xs text-zinc-500 dark:text-zinc-400'>
            {model.installed_date || 'Recently installed'}
          </span>
          <Button
            variant='ghost'
            size='sm'
            className='h-8 w-8 p-0 text-red-500 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-950'
            title={t('settings.providersLocal.actions.delete')}
            onClick={onDelete}
          >
            <Trash2 className='h-4 w-4' />
          </Button>
          <ScoreCircle
            value={formatCompatibilityScore(model.compatibility)}
            maxValue={100}
            tooltipTitle={t('settings.providersLocal.modelDetails.modelScore')}
            tooltipContent={`Model compatibility score: ${formatCompatibilityScore(model.compatibility)}/100`}
            displayValue={`${formatCompatibilityScore(model.compatibility)}%`}
            size={10}
          />
        </div>
      </div>
    </div>
  );
};

interface ModelCardProps {
  model: LocalModel;
  downloadProgress?: number;
  isDownloading: boolean;
  onDownload: () => void;
  isActive?: boolean;
  isAdmin?: boolean;
}

const ModelCard: React.FC<ModelCardProps> = ({
  model,
  downloadProgress = 0,
  isDownloading,
  onDownload,
  isActive = false,
  isAdmin = false,
}) => {
  const { t } = useTranslation();

  // Include the filtered tags directly in the component to avoid reference errors
  const filteredTags = React.useMemo(() => {
    if (!model.tags || !Array.isArray(model.tags)) return [];

    return model.tags.filter(tag => {
      // Reject if not a string or empty after trimming
      if (!tag || typeof tag !== 'string' || tag.trim() === '') return false;

      // Reject any tag containing problematic strings
      const lowercaseTag = tag.toLowerCase();
      return !(
        lowercaseTag.includes('nan') ||
        lowercaseTag.includes('undefined') ||
        lowercaseTag.includes('null') ||
        lowercaseTag === 'nan undefined' ||
        lowercaseTag === 'undefined' ||
        lowercaseTag === 'nan'
      );
    });
  }, [model.tags]);

  // Compact count for HuggingFace stats (2477 -> 2.5k)
  const formatCount = (n?: number): string => {
    if (typeof n !== 'number') return '–';
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
    return `${n}`;
  };

  return (
    <div
      className={`group/card border ${isActive
        ? 'border-green-500 dark:border-green-600 bg-green-50 dark:bg-green-900/20 ring-1 ring-green-400 dark:ring-green-500'
        : 'border-zinc-200 dark:border-zinc-800 hover:border-zinc-300 dark:hover:border-zinc-700'
        } bg-white dark:bg-zinc-950 p-4 flex flex-col relative h-full transition-colors`}
    >
      {isActive && (
        <div className='absolute top-0 right-0 transform translate-x-1/4 -translate-y-1/4'>
          <div className='bg-green-500 dark:bg-green-400 rounded-full w-5 h-5 flex items-center justify-center'>
            <svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 20 20' fill='currentColor' className='w-3 h-3 text-white'>
              <path fillRule='evenodd' d='M16.704 4.153a.75.75 0 01.143 1.052l-8 10.5a.75.75 0 01-1.127.075l-4.5-4.5a.75.75 0 011.06-1.06l3.894 3.893 7.48-9.817a.75.75 0 011.05-.143z' clipRule='evenodd' />
            </svg>
          </div>
        </div>
      )}

      {/* Header: icon + name + score circle (ALWAYS a percentage) */}
      <div className='flex items-start justify-between gap-2'>
        <div className='flex items-start gap-2.5 min-w-0'>
          <div className='h-9 w-9 flex-shrink-0 border border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-900 p-1'>
            <img
              src={model.icon || '/providers/huggingface.svg'}
              alt={model.name}
              className='w-full h-full object-contain'
            />
          </div>
          <div className='min-w-0'>
            <h3 className='font-medium text-zinc-900 dark:text-white text-sm truncate' title={model.name}>
              {model.name}
              {isActive && (
                <span className='ml-2 px-2 py-0.5 bg-green-100 dark:bg-green-900 text-green-800 dark:text-green-400 text-xs rounded-full'>
                  {t('settings.providersLocal.modelDetails.active')}
                </span>
              )}
            </h3>
            <div className='mt-0.5 flex items-center gap-1.5 text-xs text-zinc-500 dark:text-zinc-400'>
              {model.parameters && <span className='font-mono'>{model.parameters}</span>}
              {model.from_api !== undefined && (
                <span
                  className={`px-1 py-px text-[10px] leading-tight ${model.from_api
                    ? 'bg-blue-100 text-blue-700 dark:bg-blue-900/50 dark:text-blue-400'
                    : 'bg-amber-100 text-amber-700 dark:bg-amber-900/50 dark:text-amber-400'
                    }`}
                  title={model.from_api ? 'Model found in HuggingFace API' : 'Fallback model - API model not found'}
                >
                  {model.from_api ? 'API' : 'Fallback'}
                </span>
              )}
            </div>
          </div>
        </div>

        {/* Compatibility — circular percentage, never hidden behind a button */}
        <ScoreCircle
          value={formatCompatibilityScore(model.compatibility)}
          maxValue={100}
          tooltipTitle={t('settings.providersLocal.modelDetails.modelScore')}
          tooltipContent={`Model compatibility score: ${formatCompatibilityScore(model.compatibility)}/100`}
          displayValue={`${Math.round(formatCompatibilityScore(model.compatibility))}%`}
          size={10}
        />
      </div>

      {/* Description */}
      {model.description && (
        <p className='mt-2 text-xs text-zinc-500 dark:text-zinc-400 leading-snug line-clamp-2' title={model.description}>
          {model.description}
        </p>
      )}

      {/* Tags */}
      <div className='flex flex-wrap gap-1 mt-2'>
        {filteredTags.slice(0, 4).map((tag, index) => (
          <span
            key={index}
            className='px-1.5 py-0.5 bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-400 text-[11px]'
          >
            {t(`settings.providersLocal.modelDetails.tags.${tag}`, { defaultValue: tag })}
          </span>
        ))}
      </div>

      {/* HuggingFace stats + download action pinned to the card bottom */}
      <div className='mt-auto pt-3'>
        <div className='flex items-center justify-between border-t border-zinc-200 dark:border-zinc-800 pt-2.5'>
          <div className='flex items-center gap-3 text-[11px] text-zinc-500 dark:text-zinc-400'>
            <span className='flex items-center gap-1' title='HuggingFace downloads'>
              <Download className='h-3 w-3' />
              {formatCount(model.downloads)}
            </span>
            <span className='flex items-center gap-1' title='HuggingFace likes'>
              <Heart className='h-3 w-3' />
              {formatCount(model.likes)}
            </span>
            {typeof model.trust_score === 'number' && (
              <span className='flex items-center gap-1' title='Repository trust score'>
                <ShieldCheck className='h-3 w-3' />
                {model.trust_score}
              </span>
            )}
          </div>

          {isAdmin && !isActive && (
            isDownloading ? (
              <span className='flex items-center gap-1.5 text-xs font-medium text-emerald-600 dark:text-emerald-400'>
                <Loader2 className='h-3.5 w-3.5 animate-spin' />
                {Math.round(downloadProgress)}%
              </span>
            ) : (
              <Button
                variant='outline'
                size='sm'
                className='h-7 px-2.5 text-xs gap-1.5 border-zinc-300 dark:border-zinc-700'
                onClick={onDownload}
                data-testid={`local-model-download-${model.id}`}
              >
                <Download className='h-3 w-3' />
                {t('settings.providersLocal.actions.download', { defaultValue: 'Download' })}
              </Button>
            )
          )}
        </div>
      </div>
    </div>
  );
};

// Add a reusable score circle component
interface ScoreCircleProps {
  value: number | undefined;
  maxValue: number;
  getColor?: (value: number | undefined) => string;
  tooltipTitle?: string;
  tooltipContent?: React.ReactNode;
  displayValue?: string;
  size?: 6 | 8 | 10 | 12;
  // Download functionality
  isDownloadable?: boolean;
  isDownloading?: boolean;
  downloadProgress?: number;
  onDownloadClick?: () => void;
  isDisabled?: boolean;
}

// Utility function to format compatibility score
const formatCompatibilityScore = (compatibility?: number): number => {
  return compatibility ? Math.round(compatibility * 100 * 100) / 100 : 0;
};

const ScoreCircle: React.FC<ScoreCircleProps> = ({
  value,
  maxValue,
  getColor,
  tooltipTitle,
  tooltipContent,
  displayValue,
  size = 8,
  isDownloadable = false,
  isDownloading = false,
  downloadProgress = 0,
  onDownloadClick,
  isDisabled = false,
}) => {
  const hasTooltip = !!tooltipTitle || !!tooltipContent;

  // Built-in color logic for compatibility scores
  const getCompatibilityColor = (scoreValue: number | undefined): string => {
    if (!scoreValue) return '#6b7280'; // Gray for unknown
    const percentage = scoreValue / maxValue;

    if (percentage >= 0.95) return '#059669'; // Brighter green for excellent (95%+)
    if (percentage >= 0.9) return '#10b981'; // Green for very good (90%+)
    if (percentage >= 0.8) return '#f59e0b'; // Amber for good (80%+)
    if (percentage >= 0.6) return '#f97316'; // Orange for acceptable (60%+)
    if (percentage >= 0.4) return '#ef4444'; // Red for poor (40%+)
    return '#7f1d1d'; // Dark red for very poor
  };

  // Use provided getColor function or fall back to built-in logic
  const colorFunction = getColor || getCompatibilityColor;

  // Ensure value is always a number between 0 and maxValue (declare before usage)
  const safeValue =
    typeof value === 'number' && !isNaN(value)
      ? Math.max(0, Math.min(value, maxValue))
      : 0;

  // Determine what to display and which value to use
  const actualValue = isDownloading ? downloadProgress : (safeValue || 0);
  const actualMaxValue = isDownloading ? 100 : maxValue;
  const actualDisplayValue = isDownloading ? `${Math.round(downloadProgress)}%` : displayValue;
  const actualColor = isDownloading ? '#10b981' : colorFunction(value); // Green for download progress

  // Calculate the actual circumference for accurate progress display
  const radius = 16;
  const circumference = 2 * Math.PI * radius;
  // For progress circle: we want to show (actualValue/actualMaxValue) portion filled
  const progress = actualValue / actualMaxValue;
  const offset = circumference * (1 - progress);

  // Use specific size classes based on the size prop
  const sizeClasses =
    {
      6: 'h-6 w-6',
      8: 'h-8 w-8',
      10: 'h-10 w-10',
      12: 'h-12 w-12',
    }[size] || 'h-8 w-8';

  // Handle click functionality
  const handleClick = () => {
    if (isDownloadable && !isDisabled && !isDownloading && onDownloadClick) {
      onDownloadClick();
    }
  };

  const WrapperComponent = isDownloadable ? 'button' : 'div';
  const wrapperProps = isDownloadable ? {
    onClick: handleClick,
    disabled: isDisabled || isDownloading,
    className: `${sizeClasses} flex items-center justify-center relative ${hasTooltip ? 'group' : ''} ${isDownloadable && !isDisabled && !isDownloading
        ? 'cursor-pointer hover:scale-105 transition-transform'
        : isDownloadable && isDisabled
          ? 'cursor-not-allowed opacity-50'
          : ''
      }`,
    title: isDownloadable ? (isDownloading ? 'Downloading...' : 'Click to download') : undefined
  } : {
    className: `${sizeClasses} flex items-center justify-center relative ${hasTooltip ? 'group' : ''}`
  };

  return (
    <WrapperComponent {...wrapperProps}>
      <svg viewBox='0 0 36 36' className='h-full w-full'>
        <circle
          cx='18'
          cy='18'
          r='16'
          fill='none'
          stroke='#e5e5e5'
          strokeWidth='2'
        />
        <circle
          cx='18'
          cy='18'
          r='16'
          fill='none'
          stroke={actualColor}
          strokeWidth='2'
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          strokeLinecap='round'
          transform='rotate(-90 18 18)'
          style={{
            strokeDasharray: circumference,
            strokeDashoffset: offset,
          }}
        />
        {/* Show download icon when downloadable and not downloading */}
        {isDownloadable && !isDownloading ? (
          <svg x='12' y='12' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='currentColor' strokeWidth='2'>
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <polyline points="7 10 12 15 17 10" />
            <line x1="12" x2="12" y1="15" y2="3" />
          </svg>
        ) : (
          <text
            x='18'
            y='18'
            dominantBaseline='middle'
            textAnchor='middle'
            fill='currentColor'
            className='text-xs font-medium'
          >
            {actualDisplayValue}
          </text>
        )}
      </svg>

      {hasTooltip && (
        <div className='absolute bottom-full right-0 mb-2 w-72 p-2 bg-zinc-800 dark:bg-zinc-700 text-white text-xs rounded shadow-lg opacity-0 invisible group-hover:opacity-100 group-hover:visible transition-opacity z-5'>
          {tooltipTitle && (
            <div className='font-medium mb-1'>{tooltipTitle}</div>
          )}
          {tooltipContent && <div>{tooltipContent}</div>}
        </div>
      )}
    </WrapperComponent>
  );
};

// Make sure we have a default export as fallback
export default SettingsTabProvidersLocal;
