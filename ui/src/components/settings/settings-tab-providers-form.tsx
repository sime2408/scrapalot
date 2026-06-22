import React, { memo, useCallback, useEffect, useRef, useState } from 'react';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Download, RefreshCw, Search, Power } from 'lucide-react';
import {
  invalidateModelsCache,
  invalidateProvidersCache,
  fetchProviderModelsPreview,
} from '@/lib/api-llm-inference';
import { apiClient } from '@/lib/api';
import { useProviders } from '@/hooks/useProviders';
import {
  ModelType,
  ProviderFormProps,
  ProviderStatus,
  RemoteProvider,
} from '@/types/settings-types.ts';
import { toast } from '@/lib/toast-compat';
import { useTranslation } from 'react-i18next';
import { extractError } from '@/lib/error-utils';
import { ProviderIcon } from '@/components/shared/provider-icon.tsx';
import { ProviderSelector } from './settings-tab-providers-form/provider-selector.tsx';
import { ProviderConfiguration } from './settings-tab-providers-form/provider-configuration.tsx';
import { ProviderModelFetcher } from './settings-tab-providers-form/provider-model-fetcher.tsx';
import { ProviderModelSelection } from './settings-tab-providers-form/provider-model-selection.tsx';
import { uiState } from '@/lib/storage-utils';

// LM Studio runs locally over plain HTTP — http:// is intentional here
const LMSTUDIO_DEFAULT_ENDPOINT = 'http://localhost:1234/v1';
const LMSTUDIO_DEFAULT_ENDPOINT_BASE = 'http://localhost:1234';

const SettingsTabProvidersFormComponent = ({
  mode = 'add',
  provider = null,
  open,
  onOpenChange,
  onSubmit,
  onClose,
  configuredProviders = [],
}: ProviderFormProps): React.ReactNode => {
  const { t } = useTranslation();
  const isEditMode = mode === 'edit';
  // Keep track of component mount status to prevent unnecessary operations
  const isMounted = useRef(false);

  // Initialize the unified providers hook
  const { toggleProviderStatus } =
    useProviders();

  // Form state
  const [selectedProvider, setSelectedProvider] = useState<string>('');
  const [apiKey, setApiKey] = useState<string>('');
  const [apiBase, setApiBase] = useState<string>('');
  const [description, setDescription] = useState<string>('');
  const [name, setName] = useState<string>('');
  const [saveKeySecurely, setSaveKeySecurely] = useState<boolean>(true);
  const [activeTab, setActiveTab] = useState<'models' | 'custom'>('models');
  const [selectedModels, setSelectedModels] = useState<string[]>([]);
  const [fetchedModels, setFetchedModels] = useState<
    {
      id: string;
      name: string;
      model_type?: string;
      selected?: boolean;
    }[]
  >([]);
  const [modelTypes, setModelTypes] = useState<Record<string, ModelType>>({});
  const [loading, setLoading] = useState(false);
  const [modelsFetched, setModelsFetched] = useState(false);
  const [currentPage, setCurrentPage] = useState(1);
  const [hasMoreModels, setHasMoreModels] = useState(false);
  const [totalModels, setTotalModels] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);
  const modelsContainerRef = useRef<HTMLDivElement>(null);
  const [showApiKey, setShowApiKey] = useState(false);
  const [providerStatus, setProviderStatus] = useState<ProviderStatus>(
    ProviderStatus.ACTIVE
  );
  const [connectionTestStatus, setConnectionTestStatus] = useState<
    'idle' | 'testing' | 'success' | 'error'
  >('idle');
  const [connectionTestMessage, setConnectionTestMessage] =
    useState<string>('');
  const [modelSearchQuery, setModelSearchQuery] = useState<string>('');

  // Note: Models are now fetched from the database for all providers
  // This ensures consistency with the main settings page and uses the latest model definitions

  // Generate a unique provider name when name field is empty
  const generateDefaultProviderName = useCallback(() => {
    return selectedProvider.charAt(0).toUpperCase() + selectedProvider.slice(1);
  }, [selectedProvider]);

  // Memoize common utility functions to prevent recreations.
  // These functions don't depend on any state that changes during form submission.

  // Check if the provider needs apiBase configuration
  const needsEndpoint = useCallback(() => {
    // Local providers like Ollama, vLLM, and LM Studio need apiBase configuration,
    // But only 'local' is considered a local provider, so we check specific types
    return selectedProvider === 'ollama' || selectedProvider === 'vllm' || selectedProvider === 'lmstudio';
  }, [selectedProvider]);

  // Check if the provider needs an API key
  const needsApiKey = useCallback(() => {
    // Ollama handles API key inline (shown after endpoint URL for Ollama Cloud)
    // vLLM and LM Studio don't need API keys
    return selectedProvider !== 'ollama' && selectedProvider !== 'vllm' && selectedProvider !== 'lmstudio';
  }, [selectedProvider]);

  // Get current models based on provider selection
  const getCurrentModels = useCallback(() => {
    // All providers now use fetched models from the database
    // This ensures consistency with the main settings page
    const models = modelsFetched ? fetchedModels : [];

    // Filter models based on search query
    let filteredModels = models;
    if (modelSearchQuery.trim() !== '') {
      filteredModels = models.filter(model =>
        model.name.toLowerCase().includes(modelSearchQuery.toLowerCase())
      );
    }

    // Return array of model IDs (strings) as expected by the rest of the code
    return filteredModels.map(model => model.id);
  }, [fetchedModels, modelsFetched, modelSearchQuery]);

  // Determine if form is valid for submission
  const isFormValid = useCallback(() => {
    if (isEditMode) {
      // In edit mode, require at least one model to be selected
      // API key is valid if: user entered a new one, OR provider already has one stored in DB
      const hasValidApiKey = !needsApiKey() || apiKey.trim() !== '' || provider?.has_api_key;
      return name.trim() !== '' &&
        selectedModels.length > 0 &&
        (hasValidApiKey &&
          (needsEndpoint() ? apiBase.trim() !== '' : true));
    } else {
      // For Ollama, ensure there are selected models and API key for cloud
      if (selectedProvider === 'ollama') {
        const isCloud = (apiBase || '').toLowerCase().includes('ollama.com');
        return (
          selectedModels.length > 0 &&
          (apiBase?.trim() !== '' ||
            apiBase?.trim() === 'https://ollama.com') &&
          (isCloud ? apiKey.trim() !== '' : true)
        );
      }

      // For LM Studio, ensure there are selected models
      if (selectedProvider === 'lmstudio') {
        return (
          selectedModels.length > 0 &&
          (apiBase?.trim() !== '' ||
            apiBase?.trim() === LMSTUDIO_DEFAULT_ENDPOINT)
        );
      }

      return (
        selectedModels.length > 0 &&
        (needsApiKey() ? apiKey.trim() !== '' : true) &&
        (needsEndpoint() ? apiBase.trim() !== '' : true)
      );
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- deps are intentionally limited
  }, [
    isEditMode,
    name,
    selectedModels,
    apiKey,
    apiBase,
    needsApiKey,
    needsEndpoint,
    selectedProvider,
  ]);

  // Initialize form data for edit mode
  useEffect(() => {
    // Set the mounted ref to true
    isMounted.current = true;

    if (isEditMode && provider) {
      // Initialize form with provider data
      setSelectedProvider(provider.provider_type);
      setApiKey(provider.api_key || '');
      setApiBase(provider.api_base || '');
      setDescription(provider.description || '');
      setName(provider.name || '');
      // ListProviders never returns the raw api_key (only has_api_key), so
      // Boolean(provider.api_key) was always false here — which made line ~945
      // send an empty api_key and silently drop a freshly typed key on edit.
      // Default to true so a typed key is persisted; the user can still opt out.
      setSaveKeySecurely(true);
      setActiveTab('models');
      setSelectedModels(
        provider.models ? provider.models.map(model => model.model_name) : []
      );
      setProviderStatus(
        (provider.status as ProviderStatus) || ProviderStatus.ACTIVE
      );

      // Initialize model types
      const initialModelTypes: Record<string, ModelType> = {};
      if (provider.modelTypes) {
        // Use provider's model types if available
        Object.assign(initialModelTypes, provider.modelTypes);
      } else if (provider.models) {
        // Otherwise, set all models to a normal type
        provider.models.forEach(model => {
          initialModelTypes[model.model_name] = ModelType.NORMAL;
        });
      }

      setModelTypes(initialModelTypes);
    } else {
      // Reset form for added mode
      setSelectedProvider('');
      setApiKey('');
      setApiBase('');
      setDescription('');
      setName('');
      setSaveKeySecurely(true);
      setActiveTab('models');
      setSelectedModels([]);
      setModelTypes({});
      setProviderStatus(ProviderStatus.ACTIVE);
    }
    setModelsFetched(false);
    setFetchedModels([]);

    // Cleanup function to set mounted state to false
    return () => {
      isMounted.current = false;
    };
  }, [isEditMode, provider, open]);

  // Update apiBase based on provider selection (only in added mode)
  useEffect(() => {
    // Skip if not mounted to prevent unnecessary state updates
    if (!isMounted.current) return;

    if (!isEditMode) {
      // Reset models state when provider changes
      setModelsFetched(false);
      setFetchedModels([]);

      if (selectedProvider === 'ollama') {
        // Always set default apiBase for Ollama to ensure consistency
        const ollamaDefaultEndpoint = 'https://ollama.com';
        setApiBase(ollamaDefaultEndpoint);

      } else if (selectedProvider === 'vllm') {
        setApiBase('');
      } else if (selectedProvider === 'lmstudio') {
        // Set default apiBase for LM Studio with port 1234 and /v1 path
        setApiBase(LMSTUDIO_DEFAULT_ENDPOINT);
      } else {
        // For other providers (OpenAI, Google, etc.), reset apiBase
        setApiBase('');
      }
    }
  }, [selectedProvider, isEditMode]);

  // Special useEffect to validate the Ollama "Add" button
  useEffect(() => {
    // If user has selected Ollama, and there are no selected models yet,
    // check if there are fetched models to select from
    if (
      selectedProvider === 'ollama' &&
      !isEditMode &&
      selectedModels.length === 0 &&
      modelsFetched &&
      fetchedModels.length > 0
    ) {
      // Auto-select the first model if available
      const modelsToSelect = fetchedModels.slice(0, 1).map(model => model.id);
      setSelectedModels(modelsToSelect);

      // Initialize model types
      const newModelTypes: Record<string, ModelType> = { ...modelTypes };
      modelsToSelect.forEach(modelId => {
        if (!newModelTypes[modelId]) {
          newModelTypes[modelId] = ModelType.NORMAL;
        }
      });

      setModelTypes(newModelTypes);

    }
  }, [
    selectedProvider,
    isEditMode,
    selectedModels.length,
    modelsFetched,
    fetchedModels,
    modelTypes,
  ]);

  // Load models from database automatically when provider is selected
  const loadDatabaseModels = useCallback(
    async (page = 1, append = false): Promise<void> => {
      if (!provider?.id || !isMounted.current) return;

      if (page === 1) {
        setLoading(true);
        setModelsFetched(false);
        if (!append) {
          setFetchedModels([]);
          setCurrentPage(1);
          setHasMoreModels(false);
          setTotalModels(0);
        }
      } else {
        setLoadingMore(true);
      }

      try {
        // Use the new paginated getModelProviders API
        const { getModelProviders } = await import('@/lib/api-settings');
        const providers = await getModelProviders(page, 50, provider.id);

        if (!isMounted.current) return;

        // Find our specific provider in the response
        const providerData = providers.find(p => p.id === provider.id);
        if (!providerData) {
          console.error(`Error loading database models for ${provider.id}:`, `Provider ${provider.id} not found in response`);
          if (page === 1) {
            setFetchedModels([]);
            setModelsFetched(false);
          }
          return;
        }

        // Transform models to the expected format
        const filteredModels = providerData.models.map(model => ({
          id: model.model_name,
          name: model.display_name || model.model_name,
          model_type: model.model_type,
          selected: selectedModels.includes(model.model_name), // Use current selection state
        }));

        // Initialize model types from response
        const modelTypesFromDb: Record<string, ModelType> = {};
        providerData.models.forEach(model => {
          if (model.model_type) {
            modelTypesFromDb[model.model_name] = model.model_type as ModelType;
          } else {
            modelTypesFromDb[model.model_name] = ModelType.NORMAL;
          }
        });

        if (append && page > 1) {
          setFetchedModels(prev => [...prev, ...filteredModels]);
          // Merge model types for pagination
          setModelTypes(prev => ({ ...prev, ...modelTypesFromDb }));
        } else {
          setFetchedModels(filteredModels);
          // Set model types from response
          setModelTypes(modelTypesFromDb);
        }

        // Update pagination state from the new API response
        if (providerData.pagination) {
          setCurrentPage(providerData.pagination.current_page);
          setHasMoreModels(providerData.pagination.has_more);
          setTotalModels(providerData.pagination.total_models);
        } else {
          // Fallback if pagination metadata is missing
          setCurrentPage(page);
          setHasMoreModels(false);
          setTotalModels(filteredModels.length);
        }

        setModelsFetched(true);
      } catch (error) {
        console.error(
          `Error loading database models for ${provider.id}:`,
          error
        );
        if (page === 1) {
          setFetchedModels([]);
          setModelsFetched(false);
        }
      } finally {
        if (page === 1) {
          setLoading(false);
        } else {
          setLoadingMore(false);
        }
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- deps are intentionally limited
    [provider?.id]  // Removed selectedModels - it's only used for display, not loading logic
  );

  // Load more models function for pagination
  const loadMoreModels = useCallback(async () => {
    if (!hasMoreModels || loadingMore || !provider?.id) return;

    const nextPage = currentPage + 1;
    await loadDatabaseModels(nextPage, true);
  }, [hasMoreModels, loadingMore, provider?.id, currentPage, loadDatabaseModels]);

  // Autoload database models when provider is available in edit mode
  useEffect(() => {
    if (provider?.id && isEditMode && isMounted.current) {
      void loadDatabaseModels();
    }
  }, [provider?.id, isEditMode, loadDatabaseModels]);

  // Single refresh function that calls RemoteModelSyncService via existing API
  const refreshModels = useCallback(async (): Promise<void> => {
    if (!selectedProvider || !isMounted.current) {
      return;
    }
    setLoading(true);
    setModelsFetched(false);
    setFetchedModels([]);
    setCurrentPage(1);
    setHasMoreModels(false);
    setTotalModels(0);

    try {
      // For Ollama provider, ensure we're using localhost apiBase if empty
      let endpointToUse = apiBase;
      if (selectedProvider === 'ollama') {
        // Make sure we have a valid URL for Ollama - default if empty
        if (!apiBase || apiBase.trim() === '') {
          endpointToUse = 'https://ollama.com';
          setApiBase(endpointToUse);
        }

        // Normalize the URL format
        if (!/^https?:\/\//.test(endpointToUse)) {
          endpointToUse = 'https://' + endpointToUse;
          setApiBase(endpointToUse);
        }
      }

      // In edit mode, use the provider's stored API key if form apiKey is empty
      const apiKeyToUse =
        isEditMode && !apiKey && provider?.api_key ? provider.api_key : apiKey;

      // For providers whose model-list endpoint either does not allow
      // browser CORS (Anthropic) or lives on a different origin than the
      // app (Ollama local, Groq), use the preview-models proxy endpoint
      // which fetches models server-side.
      if (
        selectedProvider === 'ollama' ||
        selectedProvider === 'groq' ||
        selectedProvider === 'anthropic' ||
        selectedProvider === 'openai'
      ) {
        // Use preview-models endpoint which fetches directly from the provider API
        // For existing providers, pass provider_id so backend can look up stored API key
        const previewResponse = await apiClient.post('/llm-inference/providers/preview-models', {
          provider_type: selectedProvider,
          api_key: apiKeyToUse || undefined,
          api_base: endpointToUse,
          provider_id: (!apiKeyToUse && provider?.has_api_key && provider?.id) ? provider.id : undefined,
        });

        if (!isMounted.current) return;

        const previewData = previewResponse.data;
        if (!previewData.success) {
          if (isMounted.current) {
            setFetchedModels([]);
            setModelsFetched(true);
            setTotalModels(0);
            const errorMsg = previewData.message || `Failed to fetch ${selectedProvider} models`;
            toast({
              title: t('settings.providersRemote.form.error'),
              description: errorMsg,
              variant: 'destructive',
            });
          }
          return;
        }

        const previewModels = (previewData.models || []).map((model: { model_name: string; model_type?: string }) => ({
          id: model.model_name,
          name: model.model_name,
          model_type: model.model_type || 'NORMAL',
          selected: false,
        }));

        setFetchedModels(previewModels);
        setTotalModels(previewData.models_count || previewModels.length);
        setModelsFetched(true);
        setCurrentPage(1);
        setHasMoreModels(false);

        toast({
          title: t('settings.providersRemote.form.modelsRefreshed', 'Models refreshed successfully'),
          description: t('settings.providersRemote.form.foundModels', 'Found {{count}} models from {{provider}}', {
            count: previewModels.length,
            provider: selectedProvider,
          }),
        });
        return;
      }

      // For other providers, use the backend API
      const response = await fetchProviderModelsPreview(
        selectedProvider,
        apiKeyToUse,
        endpointToUse
      );

      if (!isMounted.current) return;

      // Convert the response to the expected format
      const convertedModels = response.models.map(model => ({
        id: model.model_name,
        name: model.model_name,
        model_type: model.model_type,
        selected: false, // Default to not selected for new models
      }));

      setFetchedModels(convertedModels);
      setTotalModels(response.models_count);
      setModelsFetched(true);
      setCurrentPage(1);
      setHasMoreModels(false); // Single page for refresh

      // Show success message
      toast({
        title: t('settings.providersRemote.form.modelsRefreshed', 'Models refreshed successfully'),
        description: t('settings.providersRemote.form.foundModels', 'Found {{count}} models from {{provider}}', {
          count: response.models_count,
          provider: selectedProvider,
        }),
      });
    } catch (error: unknown) {
      console.error('❌ ERROR in refreshModels function:', error);
      console.error('❌ Error type:', typeof error);
      console.error('❌ Error message:', (error as Error)?.message);
      console.error('❌ Error response:', (error as { response?: unknown })?.response);
      console.error('❌ Error response data:', (error as { response?: { data?: unknown } })?.response?.data);
      console.error('❌ Error response status:', (error as { response?: { status?: number } })?.response?.status);
      console.error('❌ Full error object:', JSON.stringify(error, null, 2));

      if (isMounted.current) {
        setFetchedModels([]);
        setModelsFetched(true);
        setTotalModels(0);

        // Extract structured error with error_code for i18n
        const { message, errorCode } = extractError(error);

        let errorTitle: string;
        let errorMessage: string;

        if (errorCode) {
          // Use i18n translation key from error_code (maps to general.errors.{errorCode})
          const translatedMessage = t(`general.errors.${errorCode}`, { defaultValue: '' });

          // Map error_code categories to specific UI titles
          if (['connectionError', 'backendUnavailable'].includes(errorCode)) {
            errorTitle = t('settings.providersRemote.form.errors.serverUnavailable');
            errorMessage = translatedMessage || t('settings.providersRemote.form.errors.serverUnavailableMessage', { provider: selectedProvider });
          } else if (errorCode === 'requestTimeout') {
            errorTitle = t('settings.providersRemote.form.errors.connectionTimeout');
            errorMessage = translatedMessage || t('settings.providersRemote.form.errors.connectionTimeoutMessage', { provider: selectedProvider });
          } else if (['authenticationFailed', 'authenticationRequired'].includes(errorCode)) {
            errorTitle = t('settings.providersRemote.form.errors.apiKeyInvalid');
            errorMessage = translatedMessage || t('settings.providersRemote.form.errors.apiKeyInvalidMessage');
          } else {
            errorTitle = t('general.error');
            errorMessage = translatedMessage || message;
          }
        } else {
          errorTitle = t('general.error');
          errorMessage = message || `Failed to refresh models for ${selectedProvider}`;
        }

        toast({
          title: errorTitle,
          description: errorMessage,
          variant: 'destructive',
        });
      }
    } finally {
      if (isMounted.current) {
        setLoading(false);
        setLoadingMore(false);
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- deps are intentionally limited
  }, [selectedProvider, apiKey, apiBase, provider?.id]);


  // Infinite scroll effect
  useEffect(() => {
    const container = modelsContainerRef.current;
    if (!container || !hasMoreModels || loadingMore) return;

    const handleScroll = () => {
      const { scrollTop, scrollHeight, clientHeight } = container;
      // Load more when scrolled to within 100px of bottom
      if (scrollTop + clientHeight >= scrollHeight - 100) {
        void loadMoreModels();
      }
    };

    container.addEventListener('scroll', handleScroll);
    return () => container.removeEventListener('scroll', handleScroll);
  }, [hasMoreModels, loadingMore, loadMoreModels]);

  // Auto-fetch models when provider changes - REMOVED to fix Refresh Models button
  // This was interfering with manual refresh button by calling fetchModels() (GET)
  // instead of refreshModels() (POST) when user clicks "Refresh Models" button

  // Update model type for a specific model
  const setModelType = useCallback(
    (modelId: string, type: ModelType) => {
      if (!isMounted.current) return;

      if (selectedModels.includes(modelId)) {

        setModelTypes(prev => ({
          ...prev,
          [modelId]: type,
        }));
      } else {
        // Model not in selected list; type change ignored
      }
    },
    [selectedModels]
  );

  // Add a resetForm function
  const resetForm = () => {
    setName('');
    setDescription('');
    setApiBase('');
    setApiKey('');
    setSelectedModels([]);
    setModelTypes({});
    setModelsFetched(false);
  };

  // Test Ollama connection
  const testOllamaConnection = async (ollamaEndpoint: string) => {
    try {
      const endpointToUse = ollamaEndpoint || 'https://ollama.com';

      // Build headers — Ollama Cloud requires Bearer token
      const headers: Record<string, string> = {};
      if (apiKey && endpointToUse.toLowerCase().includes('ollama.com')) {
        headers['Authorization'] = `Bearer ${apiKey}`;
      }

      // Try to access the Ollama API
      const response = await fetch(`${endpointToUse}/api/tags`, {
        method: 'GET',
        headers,
        signal: AbortSignal.timeout(5000), // 5 second timeout for cloud
      });
      if (response.ok) {
        return true;
      } else {
        console.warn(
          `Ollama returned status ${response.status}: ${response.statusText}`
        );
        return false;
      }
    } catch (error) {
      console.error('Failed to connect to Ollama:', error);
      return false;
    }
  };

  // Handle testing endpoint connection
  const handleTestEndpointConnection = async () => {
    if (!apiBase) {
      setConnectionTestStatus('error');
      setConnectionTestMessage('Please enter an API endpoint URL');
      return;
    }

    try {
      setConnectionTestStatus('testing');
      setConnectionTestMessage('Testing connection...');

      if (selectedProvider === 'ollama') {
        const isConnected = await testOllamaConnection(apiBase);

        if (isConnected) {
          setConnectionTestStatus('success');
          setConnectionTestMessage('Connection successful!');
        } else {
          setConnectionTestStatus('error');
          const isCloud = (apiBase || '').toLowerCase().includes('ollama.com');
          setConnectionTestMessage(
            isCloud
              ? 'Cannot connect to Ollama Cloud. Please check that:\n' +
                '1. Your API key is correct\n' +
                '2. Your Ollama Cloud subscription is active\n' +
                '3. Visit ollama.com/settings/keys to manage keys'
              : 'Cannot connect to Ollama. Please check that:\n' +
                '1. Ollama is running\n' +
                '2. The URL is correct\n' +
                '3. You have pulled at least one model'
          );
        }
      } else if (selectedProvider === 'vllm') {
        // For vLLM, we'll do a simple fetch to check if the endpoint is reachable
        try {
          const response = await fetch(`${apiBase}/health`, {
            method: 'HEAD',
            signal: AbortSignal.timeout(3000),
          }).catch(() => null);

          if (response?.ok) {
            setConnectionTestStatus('success');
            setConnectionTestMessage('Connection successful!');
          } else {
            // Try a general connection test if health endpoint doesn't exist
            const baseResponse = await fetch(apiBase, {
              method: 'HEAD',
              signal: AbortSignal.timeout(3000),
            });

            if (baseResponse.ok) {
              setConnectionTestStatus('success');
              setConnectionTestMessage(
                'Connection successful, but health endpoint not found.'
              );
            } else {
              setConnectionTestStatus('error');
              setConnectionTestMessage(
                'Cannot connect to vLLM. Please check that:\n' +
                '1. The vLLM server is running\n' +
                '2. The URL is correct\n' +
                '3. There are no firewall issues blocking the connection'
              );
            }
          }
        } catch (error) {
          setConnectionTestStatus('error');
          setConnectionTestMessage(
            'Cannot connect to vLLM. Please check that:\n' +
            '1. The vLLM server is running\n' +
            '2. The URL is correct\n' +
            '3. There are no firewall issues blocking the connection'
          );
        }
      } else if (selectedProvider === 'lmstudio') {
        // For LM Studio, test the /v1/models endpoint
        try {
          const response = await fetch(`${apiBase}/v1/models`, {
            method: 'GET',
            signal: AbortSignal.timeout(3000),
          });

          if (response.ok) {
            setConnectionTestStatus('success');
            setConnectionTestMessage('Connection successful!');
          } else {
            setConnectionTestStatus('error');
            setConnectionTestMessage(
              'Cannot connect to LM Studio. Please check that:\n' +
              '1. LM Studio is running with a model loaded\n' +
              `2. The URL is correct (default: ${LMSTUDIO_DEFAULT_ENDPOINT})\n` +
              '3. The server is started in LM Studio'
            );
          }
        } catch (error) {
          setConnectionTestStatus('error');
          setConnectionTestMessage(
            'Cannot connect to LM Studio. Please check that:\n' +
            '1. LM Studio is running with a model loaded\n' +
            `2. The URL is correct (default: ${LMSTUDIO_DEFAULT_ENDPOINT})\n` +
            '3. The server is started in LM Studio'
          );
        }
      }
    } catch (error) {
      setConnectionTestStatus('error');
      setConnectionTestMessage(
        'Connection test failed: ' + (error as Error).message
      );
    }
  };

  // Handle provider status toggle
  const handleStatusToggle = async () => {
    if (!isEditMode || !provider || !provider.id) return;

    try {
      setLoading(true);

      await toggleProviderStatus(provider.id);

      const newStatus =
        providerStatus === ProviderStatus.ACTIVE
          ? ProviderStatus.DISABLED
          : ProviderStatus.ACTIVE;
      setProviderStatus(newStatus);

      // Create updated provider object to pass to parent component
      const updatedProvider = {
        ...provider,
        status: newStatus,
      };

      // Call onSubmit to update the provider in the parent component
      onSubmit(updatedProvider);

      toast({
        title: t('settings.providersRemote.statusToggleSuccess'),
        description: t('settings.providersRemote.statusToggleDescription', {
          name: name || provider.name,
          status:
            providerStatus === ProviderStatus.ACTIVE
              ? t('settings.providersRemote.statusDisabled')
              : t('settings.providersRemote.statusActive'),
        }),
        variant: 'default',
      });
    } catch (error) {
      console.error('Failed to toggle provider status:', error);
      toast({
        title: t('settings.providersRemote.statusToggleError'),
        description: t('settings.providersRemote.statusToggleErrorDescription'),
        variant: 'destructive',
      });
    } finally {
      setLoading(false);
    }
  };

  // Handle form submission - don't recreate this function on every render
  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setLoading(true);

    try {

      // Validate form data
      if (!selectedProvider) {
        toast({
          title: t('settings.providersRemote.form.error'),
          description: t('settings.providersRemote.form.pleaseSelectProvider', 'Please select a provider'),
          variant: 'destructive',
        });
        setLoading(false);
        return;
      }

      // Special handling for Ollama
      if (selectedProvider === 'ollama') {
        // Ensure there's a default name if not provided
        if (!name) {
          setName('Ollama');
        }

        // Use default apiBase if not set
        if (!apiBase) {
          setApiBase('https://ollama.com');
        }

        // Ensure description has a default
        if (!description) {
          setDescription('Local Ollama instance');
        }

        // No longer blocking save functionality with connection test
        // Connection test is now done via a separate UI button
      }

      // Special handling for LM Studio
      if (selectedProvider === 'lmstudio') {
        // Ensure there's a default name if not provided
        if (!name) {
          setName('LM Studio');
        }

        // Use default apiBase if not set
        if (!apiBase) {
          setApiBase(LMSTUDIO_DEFAULT_ENDPOINT);
        }

        // Ensure description has a default
        if (!description) {
          setDescription('Local LM Studio instance');
        }
      }

      // Validate model selection (only for add mode, edit mode allows empty models)
      if (!isEditMode && selectedModels.length === 0) {
        toast({
          title: t('settings.providersRemote.form.error'),
          description: t('settings.providersRemote.form.pleaseSelectModel', 'Please select at least one model for your {{provider}} provider', { provider: selectedProvider }),
          variant: 'destructive',
        });
        setLoading(false);
        return;
      }

      // Validate apiBase format for non-local endpoints
      if (
        apiBase &&
        apiBase !== 'https://ollama.com' &&
        !apiBase.startsWith('http')
      ) {
        toast({
          title: t('settings.providersRemote.form.error'),
          description: t('settings.providersRemote.form.endpointMustStartWith', 'Endpoint must start with https or http (with ://)'),
          variant: 'destructive',
        });
        setLoading(false);
        return;
      }

      // Log data for debugging
      const defaultName = name || generateDefaultProviderName();
      // Create the provider object with the correct format for the hook functions
      const formData: Partial<RemoteProvider> = {
        name: defaultName,
        provider_type: selectedProvider,
        api_key: apiKey ? (saveKeySecurely ? apiKey : '') : undefined,
        api_base: apiBase,
        description:
          description ||
          `${selectedProvider.charAt(0).toUpperCase() + selectedProvider.slice(1)
          } provider`,
        models: selectedModels.map(model => ({
          id: model,
          model_name: model,
          display_name: model,
          model_type: modelTypes[model] || ModelType.NORMAL,
        })),
        modelTypes,
        show_models: true,
        status: providerStatus,
        has_api_key: !!apiKey || provider?.has_api_key,
      };

      // Call the appropriate API based on mode
      if (isEditMode && provider && provider.id) {
        try {
          // Include provider ID in formData for edit mode
          const formDataWithId = {
            ...formData,
            id: provider.id,
          };

          // Let parent component handle the API call to avoid duplicates
          onSubmit(formDataWithId);

          // Invalidate caches when provider is updated
          invalidateModelsCache();
          invalidateProvidersCache();

          // Force refresh providers to get latest data
          // This ensures the UI shows updated model information immediately
          try {
            const { clearProviderCache } = await import('@/hooks/useProviders');
            clearProviderCache();
          } catch (error) {
            console.warn('Failed to clear provider cache:', error);
          }

          // Trigger ChatModelSelector refresh
          uiState.requestChatModelSelectorRefresh();

          // Also dispatch a custom event for other components to listen to
          const eventDetail = { providerId: provider.id, modelCount: selectedModels.length };

          window.dispatchEvent(new CustomEvent('providerModelsUpdated', {
            detail: eventDetail
          }));

          toast({
            title: t('settings.providersRemote.form.success'),
            description: t('settings.providersRemote.form.modelsUpdated', {
              count: selectedModels.length,
              plural: selectedModels.length === 1 ? '' : 's'
            }),
          });
          onClose();
        } catch (error) {
          console.error('Error updating provider:', error);
          toast({
            title: t('settings.providersRemote.form.error'),
            description: t('general.errors.updateFailed') + ' provider',
            variant: 'destructive',
          });
        }
      } else {
        // Call onSubmit to let parent component handle the provider creation
        // This avoids duplicate API calls since parent also calls addProvider
        onSubmit(formData);

        // Trigger ChatModelSelector refresh after successful provider add
        uiState.requestChatModelSelectorRefresh();

        // Also dispatch a custom event for other components to listen to
        const eventDetail = { providerId: 'new', modelCount: selectedModels.length };

        window.dispatchEvent(new CustomEvent('providerModelsUpdated', {
          detail: eventDetail
        }));

        // Close the form
        onOpenChange(false);

        // Reset form and show success message
        resetForm();
        toast({
          title: t('general.success'),
          description: t('settings.providersRemote.form.providerCreated'),
        });
      }
    } catch (error) {
      console.error('Error saving provider:', error);

      // Provide helpful error message
      let errorMessage = isEditMode
        ? 'Failed to update model provider. '
        : 'Failed to create model provider. ';

      if (error instanceof Error) {
        errorMessage += error.message;
      } else if (typeof error === 'string') {
        errorMessage += error;
      } else {
        errorMessage += 'Unknown error occurred.';
      }

      // Add provider-specific troubleshooting tips
      if (selectedProvider === 'ollama') {
        errorMessage +=
          '\n\nOllama Troubleshooting:\n' +
          '1. Ensure Ollama is running locally\n' +
          '2. Check that the apiBase is correct (default: https://ollama.com)\n' +
          "3. Verify you've pulled at least one model in Ollama";
      } else if (selectedProvider === 'lmstudio') {
        errorMessage +=
          '\n\nLM Studio Troubleshooting:\n' +
          '1. Ensure LM Studio is running with a model loaded\n' +
          `2. Check that the apiBase is correct (default: ${LMSTUDIO_DEFAULT_ENDPOINT_BASE})\n` +
          '3. Make sure the server is started in LM Studio\n' +
          '4. No API key is required for local instances';
      }

      // Show toast notification with the error
      toast({
        title: isEditMode ? 'Error updating provider' : 'Error saving provider',
        description: errorMessage,
        variant: 'destructive',
      });
    } finally {
      setLoading(false);
    }
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange} modal={true}>
      <SheetContent
        side='right'
        className='bg-white/70 dark:bg-zinc-900/60 border-zinc-200/50 dark:border-zinc-700/50 p-0 w-[500px] max-w-full flex flex-col h-full overflow-hidden overflow-x-hidden z-[10000]'
        hideCloseButton={true}
        overlayClassName="bg-black/40 z-[9999]"
        style={{ pointerEvents: 'auto' }}
        onFocusOutside={(e) => e.preventDefault()}
      >
        <SheetHeader className='px-6 py-6 border-b border-border dark:border-zinc-800 flex-shrink-0'>
          <div className='flex items-center justify-between'>
            <div className='flex-1'>
              <SheetTitle className='text-xl font-semibold text-zinc-800 dark:text-white'>
                {isEditMode ? t('settings.providersRemote.form.editProvider') : t('settings.providersRemote.form.addProvider')}
              </SheetTitle>
              <SheetDescription className='text-sm text-zinc-600 dark:text-zinc-400 mt-1'>
                {isEditMode
                  ? t('settings.providersRemote.form.editDescription')
                  : t('settings.providersRemote.form.addDescription')}
              </SheetDescription>
            </div>
            {isEditMode && provider && (
              <div className='flex items-center space-x-3'>
                <span
                  className={`text-sm font-medium ${providerStatus === ProviderStatus.ACTIVE ? 'text-green-600 dark:text-green-500' : 'text-zinc-500 dark:text-zinc-400'}`}
                >
                  {providerStatus === ProviderStatus.ACTIVE
                    ? t('settings.providersRemote.statusActive')
                    : t('settings.providersRemote.statusDisabled')}
                </span>
                <TooltipProvider>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant='outline'
                        size='sm'
                        onClick={handleStatusToggle}
                        disabled={loading}
                        className='h-8 w-8 p-0'
                      >
                        <Power className={`h-4 w-4 ${providerStatus === ProviderStatus.ACTIVE ? 'text-red-500' : 'text-green-500'}`} />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>
                      <p>
                        {providerStatus === ProviderStatus.ACTIVE
                          ? t('settings.providersRemote.deactivateTooltip')
                          : t('settings.providersRemote.activateTooltip')}
                      </p>
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              </div>
            )}
          </div>
        </SheetHeader>

        <div className='h-full flex flex-col overflow-hidden'>
          {/* Content - Scrollable */}
          <div
            className='flex-1 overflow-y-auto'
            style={{ pointerEvents: 'auto' }}
            onWheel={(e) => e.stopPropagation()}
          >
            <div className='p-6'>
              <form id='provider-form' onSubmit={handleSubmit} data-testid='provider-form'>
                <div className='space-y-6'>
                  {/* Edit Mode Provider Info */}
                  {isEditMode && provider && (
                    <div className='space-y-3'>
                      <Label
                        htmlFor='provider'
                        className='text-zinc-600 dark:text-white/70'
                      >
                        {t('settings.providersRemote.form.provider')}
                      </Label>
                      <div className='bg-zinc-50 dark:bg-zinc-900/80 border border-zinc-200 dark:border-zinc-800 rounded p-3 flex items-center gap-3'>
                        <div className='w-9 h-9 rounded-full bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 flex items-center justify-center flex-shrink-0'>
                          <ProviderIcon
                            src={provider.iconSrc || '/providers/scrapalot.png'}
                            alt={provider.name}
                            className='w-5 h-5'
                          />
                        </div>
                        <div className='flex flex-col min-w-0'>
                          <span className='text-sm font-medium text-zinc-900 dark:text-white truncate'>
                            {provider.name || provider.provider_type}
                          </span>
                          {provider.description && (
                            <span className='text-xs text-zinc-500 dark:text-zinc-400 truncate'>
                              {provider.description}
                            </span>
                          )}
                        </div>
                      </div>
                    </div>
                  )}

                  {/* Provider Status section removed - now in header */}

                  {/* Add Mode Provider Selection */}
                  {!isEditMode && (
                    <ProviderSelector
                      selectedProvider={selectedProvider}
                      onProviderSelect={setSelectedProvider}
                      configuredProviders={configuredProviders.map(
                        p => p.provider_type
                      )}
                    />
                  )}

                  {/* Provider Configuration */}
                  {selectedProvider && (
                    <ProviderConfiguration
                      selectedProvider={selectedProvider}
                      apiKey={apiKey}
                      onApiKeyChange={setApiKey}
                      apiBase={apiBase}
                      onApiBaseChange={setApiBase}
                      description={description}
                      onDescriptionChange={setDescription}
                      name={name}
                      onNameChange={setName}
                      saveKeySecurely={saveKeySecurely}
                      onSaveKeySecurelyChange={setSaveKeySecurely}
                      showApiKey={showApiKey}
                      onToggleApiKeyVisibility={() =>
                        setShowApiKey(!showApiKey)
                      }
                      connectionTestStatus={connectionTestStatus}
                      connectionTestMessage={connectionTestMessage}
                      onTestConnection={handleTestEndpointConnection}
                      needsApiKey={needsApiKey}
                      needsEndpoint={needsEndpoint}
                      isEditMode={isEditMode}
                      hasStoredApiKey={provider?.has_api_key}
                    />
                  )}

                  {/* Fetch Models Button - Show immediately when provider is selected */}
                  {!isEditMode && selectedProvider && (
                    <ProviderModelFetcher
                      selectedProvider={selectedProvider}
                      modelsFetched={modelsFetched}
                      fetchedModels={fetchedModels}
                      loading={loading}
                      apiBase={apiBase}
                      apiKey={apiKey}
                      needsApiKey={needsApiKey}
                      needsEndpoint={needsEndpoint}
                      onFetchModels={() => void refreshModels()}
                    />
                  )}

                  {/* Models Section */}
                  {!isEditMode && (
                    <div className='border-t border-zinc-200 dark:border-zinc-800 pt-4'>
                      {/* Tab Buttons */}
                      <div className='flex mt-3 px-1 border-b border-zinc-300 dark:border-zinc-700'>
                        <button
                          type='button'
                          onClick={() => setActiveTab('models')}
                          className={`text-sm font-medium pb-2 ${activeTab === 'models'
                            ? 'text-primary border-b-2 border-primary'
                            : 'text-zinc-500 dark:text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-300'
                            }`}
                        >
                          {t('settings.providersRemote.form.models')}
                        </button>

                        {/* Display selected provider badge */}
                        {selectedProvider && (
                          <div className='ml-auto flex items-center'>
                            <span
                              className={`px-2 py-1 rounded text-xs ${selectedProvider === 'ollama'
                                ? 'bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300'
                                : 'bg-zinc-100 text-zinc-800 dark:bg-zinc-800 dark:text-zinc-300'
                                }`}
                            >
                              {selectedProvider.charAt(0).toUpperCase() +
                                selectedProvider.slice(1)}
                            </span>
                          </div>
                        )}
                      </div>

                      {activeTab === 'models' && (
                        <div className='space-y-4 mt-4'>
                          {selectedProvider === 'ollama' && (
                            <div className='mb-4'>
                              <button
                                type='button'
                                onClick={() => {
                                  setSelectedProvider('');
                                  setActiveTab('models');
                                  setModelsFetched(false);
                                  setFetchedModels([]);
                                }}
                                className='text-sm text-blue-600 dark:text-blue-400 hover:underline inline-flex items-center'
                              >
                                <svg
                                  xmlns='http://www.w3.org/2000/svg'
                                  width='16'
                                  height='16'
                                  viewBox='0 0 24 24'
                                  fill='none'
                                  stroke='currentColor'
                                  strokeWidth='2'
                                  strokeLinecap='round'
                                  strokeLinejoin='round'
                                  className='mr-1'
                                >
                                  <path d='m15 18-6-6 6-6' />
                                </svg>
                                {t('settings.providersRemote.form.backToProviderSettings', 'Back to Provider Settings')}
                              </button>
                            </div>
                          )}

                          {!modelsFetched && selectedProvider ? (
                            <div className='flex flex-col items-center justify-center py-12 text-center'>
                              <p className='text-lg font-medium mb-2'>
                                {t('settings.providersRemote.form.fetchModelsFrom', 'Fetch Models from {{provider}}', {
                                  provider: selectedProvider.charAt(0).toUpperCase() + selectedProvider.slice(1),
                                })}
                              </p>
                              <p className='text-sm text-zinc-500 dark:text-zinc-400 mb-6'>
                                {selectedProvider === 'ollama'
                                  ? 'Make sure Ollama is running locally or at the specified endpoint'
                                  : selectedProvider === 'vllm'
                                    ? 'Ensure your vLLM server is running at the specified endpoint'
                                    : selectedProvider === 'lmstudio'
                                      ? 'Make sure LM Studio is running with a model loaded and server started'
                                      : needsApiKey() && !apiKey
                                        ? 'Please provide an API key to fetch models'
                                        : 'Click below to fetch available models from this provider'}
                              </p>

                              {selectedProvider === 'ollama' && (
                                <div className='mb-6 p-4 bg-blue-50 dark:bg-blue-900/20 text-sm text-blue-700 dark:text-blue-300 text-left'>
                                  <p className='mb-2 font-medium'>
                                    Ollama Setup:
                                  </p>
                                  <ul className='list-disc pl-5 space-y-1'>
                                    <li>
                                      Default endpoint:{' '}
                                      <code className='bg-blue-100 dark:bg-blue-800/30 px-1 rounded'>
                                        https://ollama.com
                                      </code>
                                    </li>
                                    <li>
                                      Ensure Ollama is running with at least one
                                      model pulled
                                    </li>
                                    <li>
                                      For remote instances, update the endpoint
                                      URL above
                                    </li>
                                  </ul>
                                </div>
                              )}

                              {selectedProvider === 'lmstudio' && (
                                <div className='mb-6 p-4 bg-green-50 dark:bg-green-900/20 text-sm text-green-700 dark:text-green-300 text-left'>
                                  <p className='mb-2 font-medium'>
                                    LM Studio Setup:
                                  </p>
                                  <ul className='list-disc pl-5 space-y-1'>
                                    <li>
                                      Default endpoint:{' '}
                                      <code className='bg-green-100 dark:bg-green-800/30 px-1 rounded'>
                                        {LMSTUDIO_DEFAULT_ENDPOINT_BASE}
                                      </code>
                                    </li>
                                    <li>
                                      Load a model in LM Studio and start the server
                                    </li>
                                    <li>
                                      No API key required for local instances
                                    </li>
                                    <li>
                                      For remote instances, update the endpoint
                                      URL above
                                    </li>
                                  </ul>
                                </div>
                              )}

                              {needsApiKey() && !apiKey && (
                                <div className='mb-6 p-4 bg-amber-50 dark:bg-amber-900/20 text-sm text-amber-700 dark:text-amber-300'>
                                  <p className='font-medium'>
                                    API Key Required
                                  </p>
                                  <p>
                                    Please provide your {selectedProvider} API
                                    key above to fetch models.
                                  </p>
                                </div>
                              )}

                              <Button
                                type='button'
                                onClick={e => {
                                  e.preventDefault();
                                  void refreshModels();
                                }}
                                disabled={
                                  loading ||
                                  (needsApiKey() && !apiKey) ||
                                  (needsEndpoint() && !apiBase)
                                }
                                className='bg-primary hover:bg-primary/90 text-white flex items-center gap-2'
                                size='default'
                              >
                                <Download className='h-4 w-4' />
                                {loading
                                  ? t('settings.providersRemote.form.fetching', 'Fetching...')
                                  : t('settings.providersRemote.form.fetchModels', 'Fetch Models')}
                              </Button>
                            </div>
                          ) : (
                            <ProviderModelSelection
                              selectedProvider={selectedProvider}
                              fetchedModels={fetchedModels}
                              selectedModels={selectedModels}
                              modelTypes={modelTypes}
                              modelSearchQuery={modelSearchQuery}
                              loading={loading}
                              loadingMore={loadingMore}
                              hasMoreModels={hasMoreModels}
                              currentPage={currentPage}
                              totalModels={totalModels}
                              onModelToggle={(model, checked) => {
                                if (checked) {
                                  setSelectedModels([...selectedModels, model]);
                                  setModelTypes({
                                    ...modelTypes,
                                    [model]: ModelType.NORMAL,
                                  });
                                } else {
                                  setSelectedModels(
                                    selectedModels.filter(m => m !== model)
                                  );
                                }
                              }}
                              onModelTypeChange={(model, type) =>
                                setModelType(model, type)
                              }
                              onSearchChange={setModelSearchQuery}
                              onSelectAll={checked => {
                                if (checked) {
                                  const allModels = getCurrentModels();
                                  setSelectedModels(allModels);
                                  const newModelTypes = { ...modelTypes };
                                  allModels.forEach(model => {
                                    if (!newModelTypes[model]) {
                                      newModelTypes[model] = ModelType.NORMAL;
                                    }
                                  });
                                  setModelTypes(newModelTypes);
                                } else {
                                  setSelectedModels([]);
                                }
                              }}
                              onLoadMore={() => {
                                // No-op: single refresh call gets all models at once
                              }}
                              onRefresh={() => void refreshModels()}
                              getCurrentModels={getCurrentModels}
                            />
                          )}
                        </div>
                      )}

                      {activeTab === 'custom' && (
                        <div className='space-y-3 mt-4'>
                          <Textarea
                            className='min-h-[120px] bg-zinc-50 dark:bg-zinc-900 border-zinc-300 dark:border-zinc-700'
                            placeholder='Enter one model ID per line'
                            value={selectedModels.join('\n')}
                            onChange={e => {
                              const models = e.target.value
                                .split('\n')
                                .map(m => m.trim())
                                .filter(m => m.length > 0);
                              setSelectedModels(models);
                            }}
                          />
                          <p className='text-xs text-zinc-500 dark:text-zinc-400'>
                            Example format: gpt-4-32k, mixtral-8x7b
                          </p>
                        </div>
                      )}
                    </div>
                  )}

                  {/* Edit mode models section */}
                  {isEditMode && (
                    <div className='mt-6 pt-6 border-t border-zinc-300 dark:border-zinc-800'>
                      <div className='flex items-center justify-between mb-4'>
                        <Label className='text-sm font-medium text-zinc-800 dark:text-white'>
                          {t('settings.providersRemote.form.availableModels', 'Available Models')}
                        </Label>
                      </div>
                      {loading && !modelsFetched ? (
                        <div className='flex flex-col items-center justify-center py-12 text-center'>
                          <div className='animate-spin rounded-full h-8 w-8 border-b-2 border-gray-900 mb-4'></div>
                          <p className='text-lg font-medium mb-2'>
                            Loading Models...
                          </p>
                          <p className='text-sm text-zinc-500 dark:text-zinc-400'>
                            Refreshing models from provider API
                          </p>
                        </div>
                      ) : !modelsFetched ? (
                        <div className='flex flex-col items-center justify-center py-12 text-center'>
                          <p className='text-lg font-medium mb-2'>
                            No Models Found
                          </p>
                          <p className='text-sm text-zinc-500 dark:text-zinc-400 mb-6'>
                            {selectedProvider === 'ollama'
                              ? 'Make sure Ollama is running locally or at the specified apiBase'
                              : selectedProvider === 'vllm'
                                ? 'You can fetch models once you have provided a valid apiBase'
                                : selectedProvider === 'lmstudio'
                                  ? 'Make sure LM Studio is running with a model loaded and server started'
                                  : 'Use the Refresh Models button in the main interface to fetch available models'}
                          </p>
                          {selectedProvider === 'ollama' && (
                            <div className='mb-6 p-4 bg-blue-50 dark:bg-blue-900/20 text-sm text-blue-700 dark:text-blue-300 text-left'>
                              <p className='mb-2 font-medium'>
                                Ollama Connection Guide:
                              </p>
                              <ul className='list-disc pl-5 space-y-1'>
                                <li>
                                  Default apiBase:{' '}
                                  <code className='bg-blue-100 dark:bg-blue-800/30 px-1 rounded'>
                                    https://ollama.com
                                  </code>
                                </li>
                                <li>
                                  Ensure Ollama desktop app is running or server
                                  is available
                                </li>
                                <li>
                                  Use the Refresh Models button to connect and
                                  retrieve available models
                                </li>
                              </ul>
                            </div>
                          )}
                          {selectedProvider !== 'vllm' && (
                            <div className='bg-zinc-50 dark:bg-zinc-900 rounded-lg p-4 mb-6 text-left'>
                              <h4 className='font-medium mb-2'>
                                Common Issues:
                              </h4>
                              <ul className='text-sm space-y-1 list-disc list-inside'>
                                <li>
                                  Check your API key is valid and has the
                                  correct permissions
                                </li>
                                <li>
                                  Verify the API base URL is correct (if using a
                                  custom endpoint)
                                </li>
                                <li>
                                  Ensure your internet connection is stable to
                                  fetch available models
                                </li>
                              </ul>
                            </div>
                          )}

                          <Button
                            type='button'
                            onClick={e => {
                              e.preventDefault();
                              void refreshModels();
                            }}
                            disabled={
                              loading ||
                              (needsApiKey() && !apiKey && !provider?.api_key) ||
                              (needsEndpoint() && !apiBase)
                            }
                            className='bg-primary hover:bg-primary/90 text-white flex items-center gap-2'
                            size='default'
                          >
                            <Download className='h-4 w-4' />
                            {loading
                              ? t('settings.providersRemote.form.fetching', 'Fetching...')
                              : t('settings.providersRemote.form.fetchModels', 'Fetch Models')}
                          </Button>
                        </div>
                      ) : (
                        <div className='space-y-4'>
                          {/* Select All and Model Count */}
                          <div className='flex items-center justify-between'>
                            <div className='flex items-center gap-2'>
                              <Checkbox
                                id='select-all-models'
                                checked={
                                  fetchedModels.length > 0 &&
                                  fetchedModels.every(model =>
                                    selectedModels.includes(model.id)
                                  )
                                }
                                onCheckedChange={checked => {
                                  if (checked) {
                                    const modelIds = fetchedModels.map(
                                      model => model.id
                                    );
                                    setSelectedModels(modelIds);
                                    // Initialize model types for all models
                                    const newModelTypes: Record<
                                      string,
                                      ModelType
                                    > = { ...modelTypes };
                                    modelIds.forEach(modelId => {
                                      if (!newModelTypes[modelId]) {
                                        newModelTypes[modelId] =
                                          ModelType.NORMAL;
                                      }
                                    });
                                    setModelTypes(newModelTypes);
                                  } else {
                                    setSelectedModels([]);
                                  }
                                }}
                              />
                              <Label
                                htmlFor='select-all-models'
                                className='text-sm font-medium text-zinc-700 dark:text-zinc-300'
                              >
                                {t('settings.providersRemote.form.selectAllModels', 'Select All Models')}
                              </Label>
                              {totalModels > 0 && (
                                <span className='text-xs text-zinc-500 dark:text-zinc-400'>
                                  {t('settings.providersRemote.form.modelsCountLoaded', '({{selected}} of {{total}} selected, {{loaded}} loaded)', {
                                    selected: selectedModels.length,
                                    total: totalModels,
                                    loaded: fetchedModels.length,
                                  })}
                                </span>
                              )}
                            </div>
                            <Button
                              type='button'
                              variant='outline'
                              size='sm'
                              onClick={e => {
                                e.preventDefault();
                                void refreshModels();
                              }}
                              disabled={loading}
                              className='flex items-center gap-2'
                            >
                              <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
                              {loading
                                ? t('settings.providersRemote.form.refreshing', 'Refreshing...')
                                : t('settings.providersRemote.form.refreshModels', 'Refresh Models')}
                            </Button>
                          </div>

                          {/* Information about model selection */}
                          <div className='p-3 bg-blue-50 dark:bg-blue-900/20 text-sm text-blue-700 dark:text-blue-300'>
                            <p className='font-medium mb-1'>Model Management:</p>
                            <p>
                              • Select at least one model to enable the Update button
                            </p>
                            <p>
                              • Deselecting models will remove them from your database
                            </p>
                            <p>
                              • Use "Refresh Models" to fetch the latest models from the provider
                            </p>
                          </div>

                          {/* Conditional alert for Ollama with no models */}
                          {selectedProvider === 'ollama' &&
                            modelsFetched &&
                            getCurrentModels().length === 0 && (
                              <div className='p-4 bg-amber-50 dark:bg-amber-900/20 text-sm text-amber-700 dark:text-amber-300 mb-4'>
                                <p className='font-medium mb-2'>
                                  No Ollama models found!
                                </p>
                                <p>
                                  You need to pull at least one model in Ollama
                                  to use it. Try running:
                                </p>
                                <pre className='mt-2 p-2 bg-black text-white rounded font-mono text-xs'>
                                  ollama pull llama2
                                </pre>
                                <p className='mt-2'>
                                  Once you've pulled a model, click "Refresh" to
                                  see it.
                                </p>
                              </div>
                            )}

                          <div className='relative'>
                            <Search className='absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-zinc-500' />
                            <Input
                              className='pl-10 bg-zinc-50 dark:bg-zinc-900 border-zinc-300 dark:border-zinc-700'
                              placeholder={t('settings.providersRemote.form.searchModels', 'Search models...')}
                              value={modelSearchQuery}
                              onChange={e =>
                                setModelSearchQuery(e.target.value)
                              }
                            />
                          </div>

                          <div
                            ref={modelsContainerRef}
                            className='space-y-4 max-h-80 overflow-y-auto overflow-x-hidden'
                          >
                            {fetchedModels.length === 0 ? (
                              <div className='py-4 text-center text-zinc-500 dark:text-zinc-400'>
                                {t('settings.providersRemote.form.noModelsInDatabase', 'No models available in database.')}
                              </div>
                            ) : (
                              <>
                                {fetchedModels
                                  .filter(
                                    model =>
                                      modelSearchQuery.trim() === '' ||
                                      model.name
                                        .toLowerCase()
                                        .includes(
                                          modelSearchQuery.toLowerCase()
                                        )
                                  )
                                  .sort((a, b) => {
                                    // Move selected models to the top
                                    const aSelected = selectedModels.includes(
                                      a.id
                                    );
                                    const bSelected = selectedModels.includes(
                                      b.id
                                    );
                                    if (aSelected && !bSelected) return -1;
                                    if (!aSelected && bSelected) return 1;
                                    // Keep original order for models with same selection status
                                    return 0;
                                  })
                                  .map(model => (
                                    <div
                                      key={model.id}
                                      className='relative border border-zinc-300 dark:border-zinc-700 p-3 flex items-center justify-between space-x-3 mb-2 min-w-0'
                                    >
                                      <div className='flex items-center space-x-3 flex-1 min-w-0 overflow-hidden'>
                                        <Checkbox
                                          id={`edit-${model.id}`} // Use different ID
                                          checked={selectedModels.includes(
                                            model.id
                                          )}
                                          onCheckedChange={checked => {
                                            if (checked) {
                                              const newSelectedModels = [
                                                ...selectedModels,
                                                model.id,
                                              ];
                                              setSelectedModels(
                                                newSelectedModels
                                              );
                                            } else {
                                              setSelectedModels(
                                                selectedModels.filter(
                                                  m => m !== model.id
                                                )
                                              );
                                            }
                                          }}
                                          className='flex-shrink-0'
                                        />
                                        <Label
                                          htmlFor={`edit-${model.id}`}
                                          className='text-sm font-medium text-zinc-800 dark:text-white cursor-pointer block truncate'
                                          title={model.name}
                                        >
                                          {model.name}
                                        </Label>
                                      </div>

                                      <div className='flex-shrink-0 w-32'>
                                        <Select
                                          value={
                                            modelTypes[model.id] ||
                                            ModelType.NORMAL
                                          }
                                          onValueChange={value => {
                                            setModelType(
                                              model.id,
                                              value as ModelType
                                            );
                                          }}
                                          disabled={
                                            !selectedModels.includes(model.id)
                                          }
                                        >
                                          <SelectTrigger className='w-full h-8 bg-zinc-50 dark:bg-zinc-900'>
                                            <SelectValue placeholder={t('settings.providersRemote.form.modelTypeLabel', 'Model Type')} />
                                          </SelectTrigger>
                                          <SelectContent
                                            align='end'
                                            position='popper'
                                            className='z-[10001]'
                                          >
                                            <SelectItem
                                              value={ModelType.NORMAL}
                                            >
                                              {t('settings.providersRemote.form.modelType.normal', 'Normal')}
                                            </SelectItem>
                                            <SelectItem
                                              value={ModelType.EMBEDDING}
                                            >
                                              {t('settings.providersRemote.form.modelType.embedding', 'Embedding')}
                                            </SelectItem>
                                            <SelectItem
                                              value={ModelType.VISION}
                                            >
                                              {t('settings.providersRemote.form.modelType.vision', 'Vision')}
                                            </SelectItem>
                                            <SelectItem
                                              value={ModelType.AUDIO}
                                            >
                                              {t('settings.providersRemote.form.modelType.audio', 'Audio')}
                                            </SelectItem>
                                          </SelectContent>
                                        </Select>
                                      </div>
                                    </div>
                                  ))}

                                {/* Load More Button */}
                                {hasMoreModels && (
                                  <div className='mt-4 text-center'>
                                    <Button
                                      type='button'
                                      variant='outline'
                                      size='sm'
                                      onClick={loadMoreModels}
                                      disabled={loadingMore}
                                      className='w-full'
                                    >
                                      {loadingMore ? (
                                        <>
                                          <RefreshCw className='h-4 w-4 mr-2 animate-spin' />
                                          {t('settings.providersRemote.form.loadingMoreModels', 'Loading more models...')}
                                        </>
                                      ) : (
                                        <>
                                          <Download className='h-4 w-4 mr-2' />
                                          {t('settings.providersRemote.form.loadMoreModels', 'Load More Models ({{remaining}} remaining)', {
                                            remaining: totalModels - fetchedModels.length,
                                          })}
                                        </>
                                      )}
                                    </Button>
                                  </div>
                                )}
                              </>
                            )}
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </form>
            </div>
          </div>

          {/* Footer - Fixed */}
          <div className='border-t border-zinc-300 dark:border-zinc-800 py-4 px-6 flex justify-end gap-2 flex-shrink-0'>
            <Button
              type='button'
              variant='outline'
              onClick={() => onOpenChange(false)}
              className='border-zinc-300 dark:border-zinc-700 text-zinc-700 dark:text-zinc-300'
            >
              {t('settings.providersRemote.form.cancel')}
            </Button>
            <Button
              type='submit'
              form='provider-form'
              className='bg-primary text-primary-foreground px-8'
              disabled={!isFormValid()}
              data-testid='provider-form-submit'
            >
              {isEditMode
                ? t('settings.providersRemote.form.updateProvider')
                : t('settings.providersRemote.form.addProvider')
              }
            </Button>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
};

const SettingsTabProvidersForm = memo(SettingsTabProvidersFormComponent);
export default SettingsTabProvidersForm;
export { SettingsTabProvidersForm };
