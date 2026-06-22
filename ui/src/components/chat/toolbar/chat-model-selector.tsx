import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, Cpu, Download, Plus, RefreshCw, Settings, Zap } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Avatar } from '@/components/ui/avatar';
import { ProviderIcon } from '@/components/shared/provider-icon';
import { useModels } from '@/contexts/models-context';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Model } from '@/types';
import {
  getSystemCapabilities,
  getGroupedModels,
  getIconForProvider,
} from '@/lib/api-llm-inference';
import { SystemCapabilities } from '@/types/llm-types';
import { debounce } from '@/lib/utils';

// Icon for the "Scrapalot AI" system provider: the black-and-white brand mark
// (favicon artwork converted to PNG — the ICO format renders unreliably in
// <img> inside the Android WebView).
const SCRAPALOT_MODEL_ICON = '/providers/scrapalot.png';
import { v4 as uuidv4 } from 'uuid';
import { useIsNarrowScreen } from '@/hooks/use-mobile';
import { useTranslation } from 'react-i18next';
import { modelSelections, uiState } from '@/lib/storage-utils';
import { useProviders } from '@/hooks/useProviders';

interface ModelSelectorDropdownProps {
  selectedModel: string;
  onSelectModel: (
    model: string,
    modelName?: string,
    providerType?: string
  ) => void;
  openSettingsWithTab?: (tab: string) => void;
  session?: { id?: string }; // Session data containing last_used_model
}

export function ChatModelSelector({
  selectedModel,
  onSelectModel,
  openSettingsWithTab,
  session,
}: ModelSelectorDropdownProps) {
  const { t } = useTranslation();
  const isMobileOrTabletPortrait = useIsNarrowScreen();

  // Use the unified providers hook - eliminates race condition!
  const {
    providers,
    loading: providersLoading,
  } = useProviders();

  // Component lifecycle management
  useEffect(() => {
    return () => {
      // Cleanup on unmount
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
    };
  }, [selectedModel, session?.id]);

  // Add mobile detection ready state to prevent race conditions
  const [isMobileDetectionReady, setIsMobileDetectionReady] =
    React.useState(false);

  // Wait for mobile detection to complete before rendering
  React.useEffect(() => {
    // Check if mobile detection is already stable
    const checkMobileReady = () => {
      // Mobile hooks should be stable after first render
      setIsMobileDetectionReady(true);
    };

    // Use requestAnimationFrame to ensure DOM is ready
    const rafId = requestAnimationFrame(checkMobileReady);

    return () => cancelAnimationFrame(rafId);
  }, []);

  // Get models and pagination info from centralized context
  const { availableModels: centralizedModels, isLoading: modelsLoading, refreshModels, providerPagination: centralizedPagination } = useModels();

  // Local state for component-specific functionality
  const [availableModels, setAvailableModels] = useState<Model[]>([]);
  const [groupedProviders, setGroupedProviders] = useState<Array<{ id: string; provider_type: string; name: string; models: Model[]; pagination?: { current_page: number; total_models: number; has_more: boolean; models_per_page: number; } }>>([]);
  const [filteredModels, setFilteredModels] = useState<Model[]>([]);
  const [searchTerm, setSearchTerm] = useState('');
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isSearching, setIsSearching] = useState(false);

  // Sync centralized models to local state
  useEffect(() => {
    // Skip sync while searching to avoid overwriting search results
    if (isSearching) {
      return;
    }

    // Always sync models (even if empty) and update local loading state
    setAvailableModels(centralizedModels);
    setFilteredModels(centralizedModels);

    if (centralizedModels.length > 0) {
      // Group models by provider for dropdown display
      const providersMap = new Map();
      centralizedModels.forEach(model => {
        const providerType = model.provider_type || 'unknown';
        const providerName = model.provider || providerType;
        const providerId = model.provider_id || providerType;

        if (!providersMap.has(providerId)) {
          providersMap.set(providerId, {
            id: providerId,
            provider_type: providerType,
            name: providerName,
            models: []
          });
        }

        providersMap.get(providerId).models.push(model);
      });

      const groupedProviders = Array.from(providersMap.values());
      setGroupedProviders(groupedProviders);

      // Auto-select system provider if no valid model is selected (e.g., new user with empty localStorage)
      const hasValidSelection = selectedModel && centralizedModels.some(m => m.id === selectedModel);
      if (!hasValidSelection) {
        const systemModel = centralizedModels.find(m =>
          m.provider_type?.toLowerCase() === 'system' && m.model_type !== 'EMBEDDING'
        );

        if (systemModel) {
          console.debug('🔧 ChatModelSelector: No valid selection with loaded models, auto-selecting Scrapalot AI');
          try {
            modelSelections.setActiveModelObject({
              model_id: systemModel.id,
              model_name: systemModel.model_name,
              display_name: systemModel.display_name,
              provider_id: systemModel.provider_id,
              provider_type: systemModel.provider_type
            });
          } catch (error) {
            console.warn('Failed to update localStorage:', error);
          }
          onSelectModel(systemModel.id, systemModel.model_name, systemModel.provider_type);
          window.dispatchEvent(new CustomEvent('modelSelectionChanged', {
            detail: { modelId: systemModel.id, modelName: systemModel.model_name }
          }));
        }
      }
    } else {
      setGroupedProviders([]);
    }

    // Use pagination info from centralized context
    // Transform snake_case from backend to camelCase for local state
    const transformedPagination: Record<string, { page: number; loading: boolean; hasMore: boolean; totalModels: number; }> = {};
    Object.keys(centralizedPagination).forEach(providerId => {
      const pag = centralizedPagination[providerId];
      transformedPagination[providerId] = {
        page: pag.current_page || pag.page || 1,
        loading: pag.loading || false,
        hasMore: pag.has_more !== undefined ? pag.has_more : (pag.hasMore || false),
        totalModels: pag.total_models || pag.totalModels || 0
      };
    });

    // Only update state if pagination actually changed (prevent infinite loop)
    setProviderPagination(prev => {
      const prevJson = JSON.stringify(prev);
      const newJson = JSON.stringify(transformedPagination);
      return prevJson === newJson ? prev : transformedPagination;
    });

    // Fix: Only consider actual loading states, not empty models
    // Empty models can be valid state (e.g., no providers configured, sync needed)
    const shouldBeLoading = modelsLoading || providersLoading;

    if (shouldBeLoading !== isLoading) {
      setIsLoading(shouldBeLoading);
    }

    // Add fallback mechanism when models are empty but not loading
    if (!modelsLoading && !providersLoading && centralizedModels.length === 0) {
      // Use providers from unified hook (no need for separate API call)
      if (providers && providers.length > 0) {
        const providerModels = providers.flatMap(provider =>
          (provider.models || []).map(model => ({
            ...model,
            // Use the model's actual ID, not a composite ID
            id: model.id,
            model_name: model.model_name,  // API identifier (required)
            display_name: model.display_name,  // Optional display name
            provider: provider.name,
            provider_id: provider.id,
            provider_type: provider.provider_type
          }))
        );

        if (providerModels.length > 0) {
          setAvailableModels(providerModels);
          setFilteredModels(providerModels);

          // Create grouped providers from fallback data
          const providersMap = new Map();
          providerModels.forEach(model => {
            const providerType = model.provider_type || 'unknown';
            const providerName = model.provider || providerType;
            const providerId = model.provider_id || providerType;

            if (!providersMap.has(providerId)) {
              providersMap.set(providerId, {
                id: providerId,
                provider_type: providerType,
                name: providerName,
                models: []
              });
            }

            providersMap.get(providerId).models.push(model);
          });

          setGroupedProviders(Array.from(providersMap.values()));

          // Initialize pagination state from centralized pagination
          const paginationState: Record<string, { page: number; loading: boolean; hasMore: boolean; totalModels: number; }> = {};
          Array.from(providersMap.values()).forEach(provider => {
            const providerPag = centralizedPagination[provider.id];
            if (providerPag) {
              paginationState[provider.id] = {
                page: providerPag.current_page || providerPag.page || 1,
                loading: false,
                hasMore: providerPag.has_more !== undefined ? providerPag.has_more : (providerPag.hasMore || false),
                totalModels: providerPag.total_models || providerPag.totalModels || 0
              };
            }
          });
          setProviderPagination(paginationState);

          // CRITICAL: Auto-select Scrapalot AI if no valid model is selected
          const hasValidSelection = selectedModel && providerModels.some(m => m.id === selectedModel);

          if (!hasValidSelection) {
            // Find the system provider model (Scrapalot AI)
            const systemModel = providerModels.find(m =>
              m.provider_type?.toLowerCase() === 'system' && m.model_type !== 'EMBEDDING'
            );

            if (systemModel) {
              console.warn('🔧 ChatModelSelector: No valid selection, auto-selecting Scrapalot AI');
              console.warn('System model:', systemModel.model_name, 'ID:', systemModel.id);

              // Update localStorage
              try {
                modelSelections.setActiveModelObject({
                  model_id: systemModel.id,
                  model_name: systemModel.model_name,
                  display_name: systemModel.display_name,
                  provider_id: systemModel.provider_id,
                  provider_type: systemModel.provider_type
                });
              } catch (error) {
                console.warn('Failed to update localStorage:', error);
              }

              // Notify parent component
              onSelectModel(systemModel.id, systemModel.model_name, systemModel.provider_type);

              // Dispatch event for other components
              window.dispatchEvent(new CustomEvent('modelSelectionChanged', {
                detail: { modelId: systemModel.id, modelName: systemModel.model_name }
              }));
            }
          }
        }
      }
    }

  }, [centralizedModels, centralizedPagination, isSearching, modelsLoading, providersLoading, isLoading, providers, selectedModel, onSelectModel]);

  // Pagination state per provider
  const [providerPagination, setProviderPagination] = useState<Record<string, { page: number; loading: boolean; hasMore: boolean; totalModels: number; }>>({});
  const providerPaginationRef = useRef(providerPagination); // Ref to access latest state without recreating callbacks

  // Keep ref in sync with state
  useEffect(() => {
    providerPaginationRef.current = providerPagination;
  }, [providerPagination]);

  // State to prevent Select from closing during Load More operations
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const preventCloseRef = useRef(false);
  const loadingProviderRef = useRef<string | null>(null); // Track which provider is currently loading
  const [selectOpen, setSelectOpen] = useState(false);

  // Component state management
  const [error, setError] = useState<string | null>(null);
  const [connectionError, setConnectionError] = useState<boolean>(false);
  const [retryCount, setRetryCount] = useState<number>(0);
  const retryIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const [_groups, _setGroups] = useState<string[]>([]);
  const [_groupsWithActive, _setGroupsWithActive] = useState<string[]>([]);
  const [_currentRequestId, _setCurrentRequestId] = useState<string | null>(null);
  const [systemCapabilities, setSystemCapabilities] = useState<SystemCapabilities | null>(null);
  const initialFetchDoneRef = useRef(false);
  const [forceRenderKey, setForceRenderKey] = useState(0);
  const [collapsedProviders, setCollapsedProviders] = useState<Set<string>>(new Set());
  const [_currentDisplayModel, setCurrentDisplayModel] = useState<{
    name: string;
    iconSrc: string;
  } | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

  // Use storage utilities for state management instead of direct sessionStorage

  // Helper function that takes models as parameter to avoid state timing issues
  const getCurrentModelDisplayWithModels = (models: Model[]) => {
    // Priority 1: If we have a selectedModel and models are loaded, try to find it
    if (selectedModel && models.length > 0) {
      // Try to get stored model info first for better matching
      let storedModelInfo = null;
      try {
        storedModelInfo = modelSelections.getActiveModelObject();
      } catch (error) {
        console.warn('🔍 ChatModelSelector: Error getting stored model info:', error);
      }

      // First, try to find exact match with provider_type if we have stored info
      let foundModel = null;

      if (storedModelInfo && storedModelInfo.provider_type) {
        // Try to find model matching both model_name/id AND provider_type
        foundModel = models.find(
          model => {
            const idMatch = model.id === selectedModel ||
              model.id === storedModelInfo.model_id;
            const nameMatch = model.model_name === selectedModel ||
              model.model_name === storedModelInfo.model_name;
            const providerMatch = model.provider_type === storedModelInfo.provider_type;

            return (idMatch || nameMatch) && providerMatch;
          }
        );
      }

      // If not found with provider_type, fall back to regular matching
      // But prioritize "system" provider if multiple matches exist
      if (!foundModel) {
        const matchingModels = models.filter(
          model =>
            model.id === selectedModel ||
            model.model_name === selectedModel ||
            // Also try matching against stored model data if we have it
            (storedModelInfo && (
              model.id === storedModelInfo.model_id ||
              model.model_name === storedModelInfo.model_name
            ))
        );

        // If multiple matches, prefer "system" provider type
        if (matchingModels.length > 1) {
          foundModel = matchingModels.find(m => m.provider_type?.toLowerCase() === 'system') || matchingModels[0];
        } else {
          foundModel = matchingModels[0];
        }
      }

      if (foundModel) {
        return {
          name: getDisplayName(foundModel),
          iconSrc:
            // Always use the Scrapalot logo for the "system" provider type
            foundModel.provider_type?.toLowerCase() === 'system'
              ? SCRAPALOT_MODEL_ICON
              : (foundModel.iconSrc ||
                getIconForProvider(foundModel.provider_type, foundModel.model_name, foundModel.display_name) ||
                SCRAPALOT_MODEL_ICON),
        };
      }

      // If selectedModel not found in loaded models, try to get a better display name
      const isUUID =
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
          selectedModel
        );

      // Try to get model info from storage
      try {
        const storedModelObject = modelSelections.getActiveModelObject();
        if (storedModelObject && storedModelObject.model_id === selectedModel) {
          return {
            name: storedModelObject.model_name,
            iconSrc:
              getIconForProvider(storedModelObject.provider_type, storedModelObject.model_name) ||
              SCRAPALOT_MODEL_ICON,
          };
        }
      } catch (error) {
        // Silently handle error
      }

      return {
        name: isUUID ? 'AI Assistant' : selectedModel,
        iconSrc: getIconForProvider(undefined, selectedModel) || SCRAPALOT_MODEL_ICON,
      };
    }

    // Use the same fallback logic as the original function
    return getCurrentModelDisplayFallback(models);
  };

  // Fallback logic extracted for reuse
  const getCurrentModelDisplayFallback = (models: Model[]) => {
    // Priority 2: If we have selectedModel but models not loaded yet, try storage for immediate display
    if (selectedModel && models.length === 0) {
      try {
        // First try to get the full model object
        const storedModelObject = modelSelections.getActiveModelObject();

        if (storedModelObject && storedModelObject.model_id === selectedModel) {
          return {
            name: storedModelObject.model_name || 'AI Assistant',
            iconSrc:
              getIconForProvider(storedModelObject.provider_type) ||
              SCRAPALOT_MODEL_ICON,
          };
        }

        // Try to get model name from localStorage/sessionStorage
        const storedActiveModel = modelSelections.getActiveModel();
        if (storedActiveModel && storedActiveModel !== selectedModel) {
          // If stored model is different, it might be a name instead of ID
          const isUUID =
            /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
              storedActiveModel
            );
          if (!isUUID) {
            return {
              name: storedActiveModel,
              iconSrc: SCRAPALOT_MODEL_ICON,
            };
          }
        }

        // If selectedModel is not a UUID, use it directly as the name
        const isUUID =
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
            selectedModel
          );
        if (!isUUID) {
          return {
            name: selectedModel,
            iconSrc: SCRAPALOT_MODEL_ICON,
          };
        }

        // For UUIDs, try to get a better name from storage-utils
        try {
          const storedModelObject = modelSelections.getActiveModelObject();
          if (storedModelObject && storedModelObject.model_id === selectedModel) {
            return {
              name: storedModelObject.model_name,
              iconSrc: getIconForProvider(storedModelObject.provider_type) || SCRAPALOT_MODEL_ICON,
            };
          }
        } catch (error) {
          // Silently handle error
        }
      } catch (error) {
        // Silently handle error
      }
    }

    // Priority 3: No selectedModel yet but models loaded - check storage for fallback display
    if (!selectedModel && models.length > 0) {
      try {
        const storedModelObject = modelSelections.getActiveModelObject();

        if (storedModelObject) {
          return {
            name: storedModelObject.model_name || 'AI Assistant',
            iconSrc:
              getIconForProvider(storedModelObject.provider_type) ||
              SCRAPALOT_MODEL_ICON,
          };
        }
      } catch (error) {
        // Silently handle error
      }
    }

    if (models.length === 0 && (isLoading || providersLoading)) {
      // CRITICAL FIX: Even while loading, try localStorage first to show correct model name
      // This prevents "Loading models..." when we already know what model the user selected
      try {
        const storedModelObject = modelSelections.getActiveModelObject();
        if (storedModelObject && storedModelObject.model_name) {
          return {
            name: storedModelObject.display_name || storedModelObject.model_name,
            iconSrc: getIconForProvider(storedModelObject.provider_type, storedModelObject.model_name) || SCRAPALOT_MODEL_ICON,
          };
        }
      } catch (error) {
        // Silently handle error, fall through to loading message
      }
      return { name: 'Loading models...', iconSrc: SCRAPALOT_MODEL_ICON };
    } else if (models.length === 0 && !isLoading && !providersLoading) {
      if (connectionError) {
        return { name: 'Server unavailable', iconSrc: SCRAPALOT_MODEL_ICON };
      }

      // CRITICAL FIX: Check localStorage before showing "No models" messages
      // This handles the race condition when navigating from PDF viewer
      try {
        const storedModelObject = modelSelections.getActiveModelObject();
        if (storedModelObject && storedModelObject.model_name) {
          return {
            name: storedModelObject.display_name || storedModelObject.model_name,
            iconSrc: getIconForProvider(storedModelObject.provider_type, storedModelObject.model_name) || SCRAPALOT_MODEL_ICON,
          };
        }
      } catch (error) {
        // Silently handle error, fall through to provider checks
      }

      // Check if we have providers and if they have models available
      const providerIds = Object.keys(providerPagination);
      const hasProviders = providerIds.length > 0;

      if (hasProviders) {
        // Check if any provider has models available
        const totalAvailableModels = providerIds.reduce((total, providerId) => {
          return total + (providerPagination[providerId]?.totalModels || 0);
        }, 0);

        if (totalAvailableModels > 0) {
          // Models are available but no model is selected - show selection prompt
          return { name: 'Select a model', iconSrc: SCRAPALOT_MODEL_ICON };
        } else {
          return { name: 'No models available', iconSrc: SCRAPALOT_MODEL_ICON };
        }
      }
      return { name: 'No models configured', iconSrc: SCRAPALOT_MODEL_ICON };
    }

    // This should never happen but let's catch it
    console.warn('getCurrentModelDisplayWithModels: Unexpected fallback case', {
      models: models.length,
      isLoading,
    });
    return { name: 'Unexpected state', iconSrc: SCRAPALOT_MODEL_ICON };
  };

  // Direct fetch function for immediate model loading
  const fetchModels = useCallback(
    async (_bypassCache = false) => {
      // Create new abort controller for this request
      const abortController = new AbortController();
      abortControllerRef.current = abortController;

      // Use a single request ID to track this fetch operation
      const requestId = uuidv4();

      try {
        setIsLoading(true);
        setError(null);
        _setCurrentRequestId(requestId);

        // Use the new paginated getModelProviders API for consistent pagination support
        const { getModelProviders } = await import('@/lib/api-settings');
        const providers = await getModelProviders(1, 50); // Get first page with 50 models per provider

        // Transform to the expected groupedResponse format
        const groupedResponse = {
          providers: providers.map(provider => ({
            id: provider.id,
            provider_type: provider.provider_type,
            name: provider.name,
            models: provider.models?.map(model => ({
              id: model.id,
              display_name: model.display_name || model.model_name, // Use display_name for UI, fallback to model_name
              model_name: model.model_name, // API identifier for backend calls
              model_type: model.model_type,
              provider_type: provider.provider_type,
              provider_id: provider.id,
              provider: provider.name
            })) || [],
            pagination: provider.pagination
          })),
          total: providers.reduce((sum, p) => sum + (p.models?.length || 0), 0)
        };
        // Check if aborted after models fetch
        if (abortController.signal.aborted) {
          return;
        }

        // Validate response structure
        if (!groupedResponse.providers || !Array.isArray(groupedResponse.providers)) {
          console.error('🔎 ChatModelSelector: Invalid response structure:', groupedResponse);
          setError('Invalid response structure from getGroupedModels');
          setCurrentDisplayModel({ name: 'No models available', iconSrc: SCRAPALOT_MODEL_ICON });
          setForceRenderKey(prev => prev + 1);
          return;
        }
        // Debug: Log what backend returned
        // Set grouped providers and initialize pagination state
        setGroupedProviders(groupedResponse.providers);

        // Initialize pagination state for each provider using the new API pagination metadata
        const initialPagination: Record<string, { page: number; loading: boolean; hasMore: boolean; totalModels: number; }> = {};
        groupedResponse.providers.forEach(provider => {
          // Now we have proper pagination metadata from the new API
          if (provider.pagination) {
            initialPagination[provider.id] = {
              page: provider.pagination.current_page,
              loading: false,
              hasMore: provider.pagination.has_more,
              totalModels: provider.pagination.total_models
            };
          } else {
            // Fallback (shouldn't happen with new API)
            const modelCount = provider.models?.length || 0;
            initialPagination[provider.id] = {
              page: 1,
              loading: false,
              hasMore: false,
              totalModels: modelCount
            };
          }
        });
        setProviderPagination(initialPagination);

        // Flatten models for backward compatibility with existing logic
        const allModels: Model[] = groupedResponse.providers.flatMap(provider => provider.models || []);

        // Filter out any invalid models (embedding models already filtered in getGroupedModels)
        const processedModels = allModels.filter(model => Boolean(model && model.id));
        // Debug: Show sample of available model IDs for matching
        if (processedModels.length > 0) {
          // Models are available for selection
        }

        if (processedModels.length === 0) {
          console.warn('🔎 ChatModelSelector: No valid models found! Raw providers:', groupedResponse.providers.map(p => ({
            type: p.provider_type,
            modelCount: p.models?.length || 0,
            models: p.models?.map(m => ({ id: m.id, model_name: m.model_name, display_name: m.display_name })) || []
          })));
        }

        // Process models to ensure they have required fields

        // Process models and update state
        setAvailableModels(processedModels);
        setFilteredModels(processedModels);

        // Check for and fix corrupted localStorage data (empty model_id)
        const storedModelObject = modelSelections.getActiveModelObject();
        if (storedModelObject && !storedModelObject.model_id && storedModelObject.model_name && storedModelObject.provider_id) {
          console.warn('🔧 ChatModelSelector: Fixing corrupted localStorage with empty model_id');
          console.warn('Looking for model:', storedModelObject.model_name, 'from provider:', storedModelObject.provider_id);

          // Try to find the model by API identifier and provider
          const matchingModel = processedModels.find(model =>
            model.model_name === storedModelObject.model_name &&
            (model.provider_id === storedModelObject.provider_id ||
              model.provider === storedModelObject.provider_id)
          );

          if (matchingModel && matchingModel.id) {
            modelSelections.setActiveModelObject({
              model_id: matchingModel.id,
              model_name: matchingModel.model_name,
              display_name: matchingModel.display_name,
              provider_id: storedModelObject.provider_id,
              provider_type: storedModelObject.provider_type
            });

            // Trigger model selection to update the UI
            onSelectModel(matchingModel.id, storedModelObject.model_name, storedModelObject.provider_type);
          } else {
            console.warn('❌ Could not find matching model, clearing corrupted localStorage');
            modelSelections.clear();
          }
        }

        // Use the processedModels directly instead of relying on state update
        const display = getCurrentModelDisplayWithModels(processedModels);
        setCurrentDisplayModel(display);

        // Force component re-render to ensure UI updates
        setForceRenderKey(prev => prev + 1);

        // No need to extract groups anymore - we use groupedProviders directly

        // Debug current selection state
        // PRIORITY 1: Always check localStorage first to prevent auto-selection override
        let localStorageModel = null;
        try {
          const { modelSelections } = await import('@/lib/storage-utils');
          const savedActiveModel = modelSelections.getActiveModel();
          if (savedActiveModel) {
            // First try to match by ID (for UUIDs)
            localStorageModel = processedModels.find(
              model => model.id === savedActiveModel && model.model_type !== 'EMBEDDING'
            );

            // Debug: Check for localStorage/model mismatch and sync with database
            const storedModelObject = modelSelections.getActiveModelObject();
            if (storedModelObject && storedModelObject.model_id) {
              const actualModel = processedModels.find(m => m.id === storedModelObject.model_id);
              if (actualModel && actualModel.model_name !== storedModelObject.model_name) {
                console.warn('🔎 ChatModelSelector: localStorage/model mismatch detected!');
                console.warn('localStorage expects:', storedModelObject.model_name);
                console.warn('Actual model is:', actualModel.model_name);

                // Try to find the model by API identifier that localStorage expects
                const correctModel = processedModels.find(m =>
                  m.model_name === storedModelObject.model_name  // Match by API identifier only
                );

                if (correctModel && correctModel.id !== storedModelObject.model_id) {
                  console.warn('Found correct model with different UUID:', correctModel.id);
                  console.warn('Updating localStorage with correct UUID...');

                  // Update localStorage with the correct UUID
                  modelSelections.setActiveModelObject({
                    model_id: correctModel.id,              // UUID from Model.id
                    model_name: correctModel.model_name,    // API identifier (required)
                    display_name: correctModel.display_name, // Optional UI display name
                    provider_id: correctModel.provider_id || correctModel.provider,
                    provider_type: correctModel.provider_type
                  });

                  // Update localStorageModel to use the correct model
                  localStorageModel = correctModel;
                } else {
                  console.warn('Could not find model with expected name, updating localStorage to match actual model...');

                  // Fix localStorage to match the actual model
                  modelSelections.setActiveModelObject({
                    model_id: actualModel.id,               // UUID from Model.id
                    model_name: actualModel.model_name,     // API identifier (required)
                    display_name: actualModel.display_name,  // Optional UI display name
                    provider_id: actualModel.provider_id || actualModel.provider,
                    provider_type: actualModel.provider_type
                  });
                }
              }
            }

            // If not found by ID, try by model_name (API identifier)
            if (!localStorageModel) {
              localStorageModel = processedModels.find(
                model =>
                  model.model_name === savedActiveModel &&
                  model.model_type !== 'EMBEDDING'
              );
            }
          }
        } catch (error) {
          console.error('🔎 ChatModelSelector: Error checking localStorage:', error);
        }

        // Only use localStorage if there's no valid current selection
        // Check if current selection is valid
        // If we have a selectedModel and models are loaded, check if it exists
        // If models aren't loaded yet, assume selection is valid to prevent premature auto-selection
        const hasValidCurrentSelection = selectedModel && (
          processedModels.length === 0 || // Models not loaded yet - assume valid
          processedModels.find(m => m.id === selectedModel) // Model found in list
        );

        if (localStorageModel && !hasValidCurrentSelection) {
          onSelectModel(localStorageModel.id);
        } else if (localStorageModel && hasValidCurrentSelection) {
          // Model already selected and valid
        } else if (!localStorageModel && !hasValidCurrentSelection) {
          // No saved model and no current selection
        } else {
          // Other cases handled
        }

        // Set active group if we have a selected model
        if (selectedModel) {
          const selectedModelData = processedModels.find(
            m => m.id === selectedModel
          );
          if (selectedModelData) {
            // Add an ACTIVE group if needed
            const providerTypes = groupedResponse.providers.map(p => p.provider_type);
            if (!providerTypes.includes('ACTIVE')) {
              setGroups(prev => ['ACTIVE', ...prev]);
            }
            setGroupsWithActive(['ACTIVE', ...providerTypes]);
          } else {
            const providerTypes = groupedResponse.providers.map(p => p.provider_type);
            setGroupsWithActive(providerTypes);
          }
        } else {
          const providerTypes = groupedResponse.providers.map(p => p.provider_type);
          setGroupsWithActive(providerTypes);
        }

      } catch (error) {
        console.error('🔎 ChatModelSelector: fetchModels error occurred:', error);
        console.error('🔎 ChatModelSelector: Error details:', {
          message: error instanceof Error ? error.message : 'Unknown error',
          stack: error instanceof Error ? error.stack : 'No stack trace',
          requestId,
          aborted: abortController.signal.aborted
        });

        // Check if it's a connection error
        const isConnectionError = error instanceof Error &&
          (error.message.includes('Failed to fetch') ||
            error.message.includes('Network Error') ||
            error.message.includes('ERR_CONNECTION_REFUSED') ||
            error.message.includes('timeout'));

        setConnectionError(isConnectionError);
        setError(error instanceof Error ? error.message : 'Failed to fetch models');
        setAvailableModels([]);
        setFilteredModels([]);
        setGroupedProviders([]);

        // Force display update even on error
        const errorMessage = isConnectionError ? 'Server unavailable' : 'No models available';
        setCurrentDisplayModel({ name: errorMessage, iconSrc: SCRAPALOT_MODEL_ICON });
        setForceRenderKey(prev => prev + 1);

        // Start retry mechanism for connection errors
        if (isConnectionError && retryCount < 10) {
          const nextRetryCount = retryCount + 1;
          setRetryCount(nextRetryCount);

          // Clear any existing retry interval
          if (retryIntervalRef.current) {
            clearInterval(retryIntervalRef.current);
          }

          // Set up retry every minute for connection errors
          retryIntervalRef.current = setInterval(() => {
            refreshModels(); // Use centralized refresh
          }, 60000); // Retry every minute
        }
      } finally {
        // Always clean up local loading state
        setIsLoading(false);

        // Abort any pending requests
        if (abortControllerRef.current) {
          abortControllerRef.current.abort();
          abortControllerRef.current = null;
        }

        // If successful, clear connection error and retry count
        if (!error) {
          setConnectionError(false);
          setRetryCount(0);
          if (retryIntervalRef.current) {
            clearInterval(retryIntervalRef.current);
            retryIntervalRef.current = null;
          }
        }
      }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- deps are intentionally limited
    }, []);

  // Load more models for a specific provider
  const loadMoreModelsForProvider = useCallback(async (providerId: string) => {
    // CRITICAL: Check ref lock FIRST
    if (loadingProviderRef.current === providerId) {
      return;
    }

    // CRITICAL: Check pagination state SYNCHRONOUSLY before setting ref
    // Use ref to get latest state without causing callback recreation
    const currentPaginationState = providerPaginationRef.current[providerId];

    if (!currentPaginationState) {
      console.error(`❌ No pagination state found for provider ${providerId}!`);
      return;
    }

    if (!currentPaginationState.hasMore || currentPaginationState.loading) {
      return;
    }

    const currentPage = currentPaginationState.page;
    // Now set the ref lock AFTER validation
    loadingProviderRef.current = providerId;

    // Update state to set loading=true
    setProviderPagination(prev => ({
      ...prev,
      [providerId]: {
        ...prev[providerId],
        loading: true
      }
    }));

    // Immediately prevent Select from closing
    preventCloseRef.current = true;

    // Set global loading state to prevent Select from closing
    setIsLoadingMore(true);

    // Note: loading state already set in the check above atomically

    try {
      // Import the getModelProviders function
      const { getModelProviders } = await import('@/lib/api-settings');

      const nextPage = currentPage + 1;
      // WORKAROUND: Backend doesn't support per-provider pagination
      // We call global endpoint but only use data for the target provider
      const providers = await getModelProviders(nextPage, 50);

      // Find the provider in the response
      const providerData = providers.find(p => p.id === providerId);
      if (!providerData) {
        console.warn(`⚠️ Provider ${providerId} not found in page ${nextPage} response`);
        // Reset loading state before returning
        setProviderPagination(prev => ({
          ...prev,
          [providerId]: {
            ...prev[providerId],
            loading: false
          }
        }));
        // Clear the loading ref
        loadingProviderRef.current = null;
        return;
      }

      // Transform models to the expected format
      const newModels: Model[] = providerData.models.map(model => ({
        id: model.id || model.model_name,  // Use UUID id from backend
        display_name: model.display_name || model.model_name,
        model_name: model.model_name,
        model_type: model.model_type,
        provider_type: model.provider_type || providerData.provider_type,
        provider_id: providerId,
        provider: providerData.name,
        iconSrc: model.icon || getIconForProvider(providerData.provider_type, model.model_name, model.display_name)
      }));

      // CRITICAL: Only update the target provider, preserve all others unchanged
      setGroupedProviders(prev => prev.map(provider => {
        if (provider.id === providerId) {
          // Append new models (backend provides them in sorted order)
          return {
            ...provider,
            models: [...provider.models, ...newModels],
            pagination: providerData.pagination
          };
        }
        // Keep other providers completely unchanged
        return provider;
      }));

      // Update pagination state
      if (providerData.pagination) {
        setProviderPagination(prev => ({
          ...prev,
          [providerId]: {
            page: providerData.pagination!.current_page,
            loading: false,
            hasMore: providerData.pagination!.has_more,
            totalModels: providerData.pagination!.total_models
          }
        }));
      } else {
        console.warn(`⚠️ No pagination data in response, manually resetting loading state`);
        setProviderPagination(prev => ({
          ...prev,
          [providerId]: {
            ...prev[providerId],
            loading: false
          }
        }));
      }

      // Clear the loading ref
      loadingProviderRef.current = null;

      // Note: We don't update centralized availableModels here since it comes from useModels() context
      // Paginated models are stored in groupedProviders local state
      // Index.tsx handles missing models by creating them from localStorage

    } catch (error) {
      console.error(`Error loading more models for provider ${providerId}:`, error);

      // Reset loading state on error
      setProviderPagination(prev => ({
        ...prev,
        [providerId]: {
          ...prev[providerId],
          loading: false
        }
      }));

      // Clear the loading ref
      loadingProviderRef.current = null;
    } finally {
      // Always clear the global loading state
      setIsLoadingMore(false);

      // Delay clearing the prevent flag to ensure Select component has settled
      // Use a longer delay to account for any pending events or state updates
      setTimeout(() => {
        preventCloseRef.current = false;
      }, 300);
    }
  }, []); // Empty deps - using refs for state access to avoid recreating callback

  // Cleanup function to abort requests on unmount
  useEffect(() => {
    return () => {
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
      if (retryIntervalRef.current) {
        clearInterval(retryIntervalRef.current);
      }
    };
  }, []);

  // Listen for refresh requests from settings components
  useEffect(() => {
    const checkForRefreshRequest = () => {
      if (uiState.isChatModelSelectorRefreshNeeded()) {
        uiState.clearChatModelSelectorRefreshRequest();

        // Use centralized refresh
        void refreshModels();
      }
    };

    // Check immediately
    checkForRefreshRequest();

    // Set up interval to check for refresh requests (reduced frequency)
    const refreshCheckInterval = setInterval(checkForRefreshRequest, 5000); // Changed from 1000ms to 5000ms

    return () => clearInterval(refreshCheckInterval);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- deps are intentionally limited
  }, [fetchModels]);

  // Single effect to handle all model fetching logic
  useEffect(() => {
    // Models now come from centralized context - no need to fetch locally
    if (!initialFetchDoneRef.current) {
      // Just mark as done, models will come from ModelsProvider
      initialFetchDoneRef.current = true;
      return;
    }

    // Retry fetch if models are empty after initial fetch and mobile detection is ready
    if (
      isMobileDetectionReady &&
      availableModels.length === 0 &&
      !isLoading &&
      !error &&
      !sessionStorage.getItem('chat-model-selector-models-loaded')
    ) {
      const retryTimer = setTimeout(() => {
        // Models come from centralized context - trigger refresh if needed
        if (centralizedModels.length === 0) {
          void refreshModels();
        }
      }, 1000);
      return () => clearTimeout(retryTimer);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- deps are intentionally limited
  }, [
    isMobileDetectionReady,
    availableModels.length,
    error,
    // Removed isLoading from dependencies to prevent infinite loop
    // Removed selectedModel from dependencies to prevent API calls on model selection
  ]);

  // Removed problematic mobile-specific model fetching logic
  // The mobile detection was causing unnecessary refetches and interfering with normal model loading

  // Fetch system capabilities
  useEffect(() => {
    const fetchSystemCapabilities = async () => {
      try {
        const capabilities = await getSystemCapabilities();
        setSystemCapabilities(capabilities);
      } catch (err) {
        // Silently handle error
      }
    };

    void fetchSystemCapabilities();
  }, []);

  // Update display model when models are loaded and selected model changes
  useEffect(() => {
    if (selectedModel && availableModels.length > 0) {
      const foundModel = availableModels.find(
        m =>
          m.id === selectedModel
      );

      if (foundModel) {
        setForceRenderKey(prev => prev + 1);
      }
    }
  }, [selectedModel, availableModels]);

  // Update display model whenever relevant state changes
  useEffect(() => {
    // Guard condition: only update display after models are loaded
    if (availableModels.length > 0) {
      const display = getCurrentModelDisplay();
      setCurrentDisplayModel(display);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- deps are intentionally limited
  }, [selectedModel, availableModels, isLoading, forceRenderKey]);

  // Handle retry button click
  const handleRetry = () => {
    void refreshModels(); // Use centralized refresh
  };

  // Store refreshModels in a ref to avoid recreating debounce function
  const refreshModelsRef = useRef(refreshModels);
  useEffect(() => {
    refreshModelsRef.current = refreshModels;
  }, [refreshModels]);

  // Debounced backend search function
  const debouncedBackendSearch = useMemo(
    () => debounce(async (searchQuery: string) => {
      const trimmedQuery = searchQuery.trim();

      // Reset to all models when search is cleared
      if (!trimmedQuery || trimmedQuery === '') {
        setIsSearching(false);
        setSearchTerm(''); // Update state for display
        await refreshModelsRef.current();
        return;
      }

      // Minimum 2 characters required for backend search
      if (trimmedQuery.length < 2) {
        setIsSearching(false);
        setSearchTerm(trimmedQuery); // Update state for display
        return;
      }

      try {
        // Set searching flag to prevent sync from overwriting results
        setIsSearching(true);
        setSearchTerm(trimmedQuery); // Update state only when actually searching
        // Call backend with search parameter
        const { getGroupedModels } = await import('@/lib/api-llm-inference');
        const groupedResponse = await getGroupedModels(false, undefined, trimmedQuery);

        if (groupedResponse && groupedResponse.providers) {
          // Flatten models from all providers
          const searchResults: Model[] = groupedResponse.providers.flatMap(
            provider => provider.models || []
          );

          setAvailableModels(searchResults);
          setFilteredModels(searchResults);
          setGroupedProviders(groupedResponse.providers);
        } else {
          setAvailableModels([]);
          setFilteredModels([]);
          setGroupedProviders([]);
        }
      } catch (error) {
        console.error('❌ Backend search error:', error);
        setIsSearching(false);
      }
      // Keep isSearching true while search results are displayed
    }, 500), // 500ms debounce for better UX
    [] // Empty deps - debounce function is created only once
  );

  // Attach input event listener directly to bypass React's event system
  useEffect(() => {
    if (!selectOpen) return; // Only attach when select is open

    // SelectContent is in a Portal, so ref might not be immediately available
    // Use a small delay to ensure the input is rendered
    const timeoutId = setTimeout(() => {
      const inputElement = searchInputRef.current;
      if (!inputElement) {
        return;
      }

      const handleInput = (e: Event) => {
        const target = e.target as HTMLInputElement;
        const value = target.value;
        const trimmedValue = value.trim();

        // Set isSearching IMMEDIATELY to prevent sync useEffect from interfering
        if (trimmedValue.length >= 2) {
          setIsSearching(true);
        } else if (trimmedValue.length === 0) {
          setIsSearching(false);
        }

        debouncedBackendSearch(value);
      };

      // Use native DOM event listener to avoid React re-render issues
      inputElement.addEventListener('input', handleInput);
      // Store handler for cleanup
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- storing handler reference on DOM element for cleanup
      (inputElement as any).__searchHandler = handleInput;
    }, 100); // Small delay for Portal rendering

    return () => {
      clearTimeout(timeoutId);
      // eslint-disable-next-line react-hooks/exhaustive-deps -- deps are intentionally limited
      const inputElement = searchInputRef.current;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- reading stored handler reference from DOM element
      if (inputElement && (inputElement as any).__searchHandler) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- cleanup of stored handler reference
        inputElement.removeEventListener('input', (inputElement as any).__searchHandler);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- cleanup of stored handler reference
        delete (inputElement as any).__searchHandler;
      }
    };
  }, [debouncedBackendSearch, selectOpen]); // Re-attach when select opens

  // Clear search input when searchTerm is reset
  useEffect(() => {
    if (searchTerm === '' && searchInputRef.current) {
      searchInputRef.current.value = '';
    }
  }, [searchTerm]);

  // Get current model display info - handle initialization timing
  const getCurrentModelDisplay = () => {
    return getCurrentModelDisplayWithModels(availableModels);
  };

  // Handle model selection
  const handleValueChange = async (value: string) => {
    // Handle special actions
    if (value === 'add-new-provider' && openSettingsWithTab) {
      openSettingsWithTab('remote-providers');
      return;
    }

    if (value === 'manage-local-models' && openSettingsWithTab) {
      openSettingsWithTab('local-ai');
      return;
    }

    // Handle normal model selection - find the model to get provider info
    // First check availableModels (page 1), then check groupedProviders (paginated models)
    let selectedModelData = availableModels.find(model => model.id === value);

    if (!selectedModelData) {
      // Model not in page 1, search in paginated groupedProviders
      for (const provider of groupedProviders) {
        selectedModelData = provider.models.find(model => model.id === value);
        if (selectedModelData) {
          break;
        }
      }
    }

    if (selectedModelData) {
      // Send model ID (UUID) to parent component for consistent identification
      // Use model_name (required API identifier) for backend calls
      // display_name is optional and only used for UI display
      const modelName = selectedModelData.model_name;  // Required field, always present

      // Store the full model object in consolidated storage for efficient retrieval
      try {
        // Validate that we have a proper model_id before storing
        if (!selectedModelData.id) {
          console.error('🚨 ChatModelSelector: Attempted to store model with empty ID:', selectedModelData);
          return;
        }

        // IMPORTANT: Always use model_name (API identifier) for storage, not display_name
        // The backend needs the API identifier to make provider calls
        const apiIdentifier = selectedModelData.model_name || selectedModelData.id;

        // Debug: Log the model data being stored
        const modelToStore = {
          model_id: selectedModelData.id,              // UUID from Model.id
          model_name: apiIdentifier,                    // API identifier (required)
          display_name: selectedModelData.display_name, // Optional UI display name
          provider_id: selectedModelData.provider_id,
          provider_type: selectedModelData.provider_type
        };
        console.log('🔍 ChatModelSelector: Storing model:', modelToStore);
        modelSelections.setActiveModelObject(modelToStore);
      } catch (error) {
        console.warn('Failed to store model selection in storage-utils:', error);
      }

      // Let the parent component (useSessionManagement) handle database saving
      // This prevents duplicate POST requests
      onSelectModel(
        selectedModelData.id,
        modelName,
        selectedModelData.provider_type
      );

      // Dispatch custom event to notify other components of model selection change
      window.dispatchEvent(new CustomEvent('modelSelectionChanged', {
        detail: { modelId: selectedModelData.id, modelName }
      }));
    } else {
      // Fallback for backwards compatibility
      onSelectModel(value);

      // Dispatch custom event for fallback case too
      window.dispatchEvent(new CustomEvent('modelSelectionChanged', {
        detail: { modelId: value }
      }));
    }
  };

  // Backend now handles display name normalization via _normalize_model_display_name
  // No need for frontend normalization - just use display_name directly
  const getDisplayName = (model: Model): string => {
    return model.display_name || model.model_name || model.id;
  };

  // Size + per-icon padding only. Theme-aware coloring for mono SVGs (Ollama,
  // Groq, OpenRouter, etc.) is handled by <ProviderIcon>.
  const getIconClassName = (iconSrc: string): string => {
    if (iconSrc && typeof iconSrc === 'string') {
      if (iconSrc.includes('deepseek.svg')) {
        return 'h-6 w-6 p-0.5 scale-125';
      }
      if (iconSrc.includes('ollama.svg')) {
        return 'h-6 w-6';
      }
      if (iconSrc.includes('groq.svg')) {
        return 'h-6 w-6 p-0.5';
      }
    }
    return 'h-6 w-6 p-0.5';
  };

  return (
    <div className='relative'>
      <Select
        value={selectedModel}
        onValueChange={handleValueChange}
        open={selectOpen}
        preventClose={isLoadingMore || preventCloseRef.current}
        onOpenChange={(open) => {
          // Update our controlled state
          setSelectOpen(open);

          // Clear prevent flags when opening
          if (open) {
            preventCloseRef.current = false;
          }
        }}
        key={
          isMobileOrTabletPortrait
            ? `mobile-selector-${forceRenderKey}`
            : `model-selector-${selectedModel || 'none'}-${forceRenderKey}`
        } // Force re-render when selectedModel or forceRenderKey change (removed availableModels.length to prevent focus loss)
      >
        <SelectTrigger
          data-testid="model-selector"
          data-tour="model-selector"
          className={`${isMobileOrTabletPortrait ? 'w-[200px]' : 'w-[240px]'} h-8 bg-transparent border border-border text-foreground text-sm focus:ring-0 hover:bg-muted/50 transition-colors`}
          onClick={() => {
            // Force refresh models when clicking the trigger, especially important on mobile
            if (availableModels.length === 0 || isLoading || providersLoading || modelsLoading) {
              void refreshModels(); // Use centralized refresh
            }
          }}
        >
          <SelectValue className='cursor-pointer'>
            {(() => {
              // Use getCurrentModelDisplayWithModels directly to avoid state timing issues
              const display = getCurrentModelDisplayWithModels(availableModels) || (() => {
                if (isLoading || providersLoading || modelsLoading) {
                  return { name: 'Loading models...', iconSrc: SCRAPALOT_MODEL_ICON };
                }
                if (connectionError) {
                  return { name: 'Server unavailable', iconSrc: SCRAPALOT_MODEL_ICON };
                }

                // Check if we have providers and if they have models available
                const providerIds = Object.keys(providerPagination);
                const hasProviders = providerIds.length > 0;

                if (hasProviders) {
                  // Check if any provider has models available
                  const totalAvailableModels = providerIds.reduce((total, providerId) => {
                    return total + (providerPagination[providerId]?.totalModels || 0);
                  }, 0);

                  if (totalAvailableModels > 0) {
                    // Models are available but no model is selected - show selection prompt
                    return { name: 'Select a model', iconSrc: SCRAPALOT_MODEL_ICON };
                  } else {
                    return { name: 'No models available', iconSrc: SCRAPALOT_MODEL_ICON };
                  }
                }

                return { name: 'No models configured', iconSrc: SCRAPALOT_MODEL_ICON };
              })();

              return (
                <div className='flex items-center gap-1.5 overflow-hidden'>
                  <Avatar className='h-7 w-7 rounded-full flex items-center justify-center'>
                    <ProviderIcon
                      src={display.iconSrc}
                      alt='Model'
                      className={getIconClassName(display.iconSrc)}
                    />
                  </Avatar>
                  <span className='text-sm font-medium truncate'>
                    {display.name}
                  </span>
                </div>
              );
            })()}
          </SelectValue>
        </SelectTrigger>

        <SelectContent
          className={`${isMobileOrTabletPortrait ? 'w-[320px] max-w-[90vw]' : 'w-[320px]'} p-0 bg-background border border-border z-[90]`}
        >
          <div className='flex flex-col'>
            {/* Search box */}
            <div
              className={`${isMobileOrTabletPortrait ? 'p-1.5' : 'p-2'} border-b border-border`}
            >
              <div className='relative'>
                <Input
                  ref={searchInputRef}
                  type='text'
                  placeholder={t('chatModelSelector.searchPlaceholder')}
                  defaultValue=''
                  autoFocus={false}
                  onKeyDown={(e) => {
                    // Prevent Radix Select's typeahead from stealing focus
                    e.stopPropagation();
                  }}
                  onKeyUp={(e) => {
                    // Also stop keyup to fully prevent Select's keyboard handling
                    e.stopPropagation();
                  }}
                  className={`w-full ${isMobileOrTabletPortrait ? 'px-2 py-1 text-xs' : 'px-3 py-1.5 text-sm'} border border-border bg-muted/30 text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-1 focus:ring-primary/30`}
                />
              </div>
            </div>

            {/* Loading state */}
            {(isLoading || providersLoading || modelsLoading) && (
              <div
                className={`${isMobileOrTabletPortrait ? 'p-2' : 'p-4'} text-center`}
              >
                <div
                  className={`animate-pulse ${isMobileOrTabletPortrait ? 'text-xs' : 'text-sm'} text-zinc-500 dark:text-zinc-400`}
                >
                  {t('chatModelSelector.loadingModels')}
                </div>
              </div>
            )}

            {/* Error state */}
            {error && !isLoading && !providersLoading && !modelsLoading && (
              <div
                className={`${isMobileOrTabletPortrait ? 'p-2' : 'p-4'} text-center`}
              >
                <div
                  className={`${isMobileOrTabletPortrait ? 'text-xs' : 'text-sm'} ${connectionError ? 'text-red-500' : 'text-amber-500'} mb-2`}
                >
                  {connectionError ? 'Server unavailable - retrying automatically' : error}
                </div>
                {connectionError && retryCount > 0 && (
                  <div className={`${isMobileOrTabletPortrait ? 'text-xs' : 'text-sm'} text-zinc-500 dark:text-zinc-400 mb-2`}>
                    Retry attempt {retryCount}/10
                  </div>
                )}
                <Button
                  variant='outline'
                  size={isMobileOrTabletPortrait ? 'sm' : 'sm'}
                  onClick={handleRetry}
                  className='mx-auto'
                >
                  {connectionError ? 'Retry Now' : t('chatModelSelector.retry')}
                </Button>
              </div>
            )}

            {/* Models list */}
            {!isLoading && !providersLoading && !modelsLoading && !error && (
              <div
                className={`${isMobileOrTabletPortrait ? 'max-h-[250px]' : 'max-h-[300px]'} overflow-y-auto`}
              >
                {/* Show the currently selected model at the top only if it exists in available models AND is not a system model */}
                {/* System models will appear first in provider groups, so no need to duplicate them here */}
                {selectedModel &&
                  availableModels.find(m => m.id === selectedModel) &&
                  (() => {
                    const foundModel = availableModels.find(
                      m => m.id === selectedModel
                    );
                    if (!foundModel) return null;

                    // Skip Active Model section if it's a system model (is_system_model flag from backend)
                    // System models will already appear first in the provider groups
                    if (foundModel.is_system_model) {
                      return null;
                    }

                    // Debug: Log active model data
                    if (!foundModel.id) {
                      console.error('🚨 Active model missing ID:', foundModel);
                    }

                    return (
                      <SelectGroup>
                        <SelectLabel
                          className={`${isMobileOrTabletPortrait ? 'px-2 py-1 text-xs' : 'px-3 py-1.5 text-xs'} font-semibold`}
                        >
                          Active Model
                        </SelectLabel>
                        <SelectItem value={foundModel.id} disabled={!foundModel.id}>
                          <div
                            className={`flex items-center pl-1 ${isMobileOrTabletPortrait ? 'gap-1.5' : 'gap-2'}`}
                          >
                            <Avatar
                              className={`${isMobileOrTabletPortrait ? 'h-6 w-6' : 'h-7 w-7'} rounded-full flex items-center justify-center`}
                            >
                              <ProviderIcon
                                src={
                                  // Always use the Scrapalot logo for the "system" provider type
                                  foundModel.provider_type?.toLowerCase() === 'system'
                                    ? SCRAPALOT_MODEL_ICON
                                    : (foundModel.iconSrc ||
                                      getIconForProvider(
                                        foundModel.provider_type
                                      ) ||
                                      SCRAPALOT_MODEL_ICON)
                                }
                                alt={t('chatModelSelector.modelAlt')}
                                className={
                                  isMobileOrTabletPortrait
                                    ? 'h-5 w-5'
                                    : getIconClassName(
                                      foundModel.provider_type?.toLowerCase() === 'system'
                                        ? SCRAPALOT_MODEL_ICON
                                        : foundModel.iconSrc
                                    )
                                }
                              />
                            </Avatar>
                            <span
                              className={`${isMobileOrTabletPortrait ? 'text-xs' : 'text-sm'} font-medium truncate`}
                            >
                              {getDisplayName(foundModel)}
                              {!foundModel.id && ' (No ID)'}
                            </span>
                          </div>
                        </SelectItem>
                      </SelectGroup>
                    );
                  })()}

                <div className='border-t border-border my-1'></div>

                {/* Use grouped providers directly from backend */}
                {groupedProviders.map(provider => {
                  // Filter models based on search term
                  const providerModels = provider.models.filter(model =>
                    searchTerm === '' || model.display_name?.toLowerCase().includes(searchTerm.toLowerCase())
                  );

                  // Skip empty groups
                  if (providerModels.length === 0) {
                    return null;
                  }

                  // Group by model_type within this provider (backend provides sorted order)
                  const normalModels = providerModels
                    .filter(
                      model =>
                        model.model_type === 'NORMAL' || !model.model_type
                    );

                  const isCollapsed = searchTerm ? false : collapsedProviders.has(provider.id);

                  return (
                    <div key={provider.id}>
                      <SelectGroup>
                        <SelectLabel
                          className={`${isMobileOrTabletPortrait ? 'px-2 py-1 text-sm' : 'px-3 py-1.5 text-xs'} font-semibold cursor-pointer select-none hover:bg-muted/50 transition-colors`}
                          onClick={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            if (!searchTerm) {
                              setCollapsedProviders(prev => {
                                const next = new Set(prev);
                                if (next.has(provider.id)) {
                                  next.delete(provider.id);
                                } else {
                                  next.add(provider.id);
                                }
                                return next;
                              });
                            }
                          }}
                        >
                          <div className='flex items-center justify-between w-full'>
                            <span className="uppercase tracking-wider">{provider.name} <span className="text-muted-foreground font-normal">({normalModels.length})</span></span>
                            {isCollapsed
                              ? <ChevronRight className='h-3 w-3 text-zinc-400' />
                              : <ChevronDown className='h-3 w-3 text-zinc-400' />
                            }
                          </div>
                        </SelectLabel>

                        {/* Display models directly under provider name */}
                        {!isCollapsed && normalModels.map(model => {
                          // Debug: Log model data to identify selection issues
                          if (!model.id) {
                            console.error('🚨 Model missing ID:', model);
                          }

                          return (
                            <SelectItem
                              key={`${model.id}-${model.display_name}`}
                              value={model.id}
                              disabled={!model.id} // Disable if no ID
                            >
                              <div
                                className={`flex items-center pl-1 gap-2`}
                              >
                                <Avatar
                                  className={`${isMobileOrTabletPortrait ? 'h-6 w-6' : 'h-7 w-7'} rounded-full flex items-center justify-center`}
                                >
                                  <ProviderIcon
                                    src={
                                      // Always use the Scrapalot logo for the "system" provider type
                                      model.provider_type?.toLowerCase() === 'system'
                                        ? SCRAPALOT_MODEL_ICON
                                        : (getIconForProvider(model.provider_type) ||
                                          SCRAPALOT_MODEL_ICON)
                                    }
                                    alt='Model'
                                    className={
                                      isMobileOrTabletPortrait
                                        ? 'h-5 w-5 p-0.5'
                                        : getIconClassName(
                                          model.provider_type?.toLowerCase() === 'system'
                                            ? SCRAPALOT_MODEL_ICON
                                            : (getIconForProvider(model.provider_type) ||
                                              SCRAPALOT_MODEL_ICON)
                                        )
                                    }
                                  />
                                </Avatar>
                                <span
                                  className={`${isMobileOrTabletPortrait ? 'text-sm' : 'text-sm'} font-medium truncate`}
                                >
                                  {getDisplayName(model)}
                                  {!model.id && ' (No ID)'}
                                </span>
                              </div>
                            </SelectItem>
                          );
                        })}
                      </SelectGroup>

                      {/* Load More Button for this provider */}
                      {!isCollapsed && providerPagination[provider.id]?.hasMore && (
                        <div className={`${isMobileOrTabletPortrait ? 'px-2 py-1' : 'px-3 py-2'} border-t border-border`}>
                          <div
                            role="button"
                            tabIndex={-1}
                            onPointerDown={(e) => {
                              e.preventDefault();
                              e.stopPropagation();
                              e.nativeEvent.stopImmediatePropagation();

                              preventCloseRef.current = true;
                              setIsLoadingMore(true);
                              setSelectOpen(true);

                              // Call function directly - it will check loading state internally with latest data
                              void loadMoreModelsForProvider(provider.id);
                            }}
                            onClick={(e) => {
                              e.preventDefault();
                              e.stopPropagation();
                              e.nativeEvent.stopImmediatePropagation();
                            }}
                            onMouseDown={(e) => {
                              e.preventDefault();
                              e.stopPropagation();
                            }}
                            className={`w-full ${isMobileOrTabletPortrait ? 'h-7 text-xs' : 'h-8 text-xs'} text-muted-foreground hover:text-foreground flex items-center justify-center gap-1 hover:bg-muted/50 cursor-pointer transition-colors ${providerPagination[provider.id]?.loading ? 'opacity-50 cursor-not-allowed' : ''}`}
                          >
                            {providerPagination[provider.id]?.loading ? (
                              <>
                                <RefreshCw className={`${isMobileOrTabletPortrait ? 'h-3 w-3' : 'h-4 w-4'} mr-1 animate-spin`} />
                                Loading...
                              </>
                            ) : (
                              <>
                                <Download className={`${isMobileOrTabletPortrait ? 'h-3 w-3' : 'h-4 w-4'} mr-1`} />
                                Load More ({providerPagination[provider.id]?.totalModels - (provider.models?.length || 0)} remaining)
                              </>
                            )}
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}

            {/* Recommended models section when no search results */}
            {filteredModels.length === 0 && searchTerm && (
              <div className={`${isMobileOrTabletPortrait ? 'p-2' : 'p-4'}`}>
                <div
                  className={`text-center ${isMobileOrTabletPortrait ? 'text-xs' : 'text-xs'} text-zinc-500 dark:text-zinc-400 mb-2`}
                >
                  {t('chatModelSelector.noModelsMatchingSearch', {
                    searchTerm,
                  })}
                </div>

                <div className='flex items-center justify-center gap-2 mb-2'>
                  {systemCapabilities?.has_gpu ? (
                    <div
                      className={`flex items-center gap-1 ${isMobileOrTabletPortrait ? 'text-xs' : 'text-xs'} text-green-500`}
                    >
                      <Zap size={isMobileOrTabletPortrait ? 12 : 14} />{' '}
                      {t('chatModelSelector.gpuAvailable')}
                    </div>
                  ) : (
                    <div
                      className={`flex items-center gap-1 ${isMobileOrTabletPortrait ? 'text-xs' : 'text-xs'} text-blue-500`}
                    >
                      <Cpu size={isMobileOrTabletPortrait ? 12 : 14} />{' '}
                      {t('chatModelSelector.cpuMode')}
                    </div>
                  )}
                </div>
                <div
                  className={`${isMobileOrTabletPortrait ? 'text-xs' : 'text-xs'} text-center text-zinc-500 dark:text-zinc-400`}
                >
                  {t('chatModelSelector.noModelsAvailable')}
                </div>
              </div>
            )}

            {/* Add actions at the bottom */}
            {openSettingsWithTab && (
              <div className='border-t border-border mt-2'>
                <SelectGroup>
                  <SelectLabel
                    className={`${isMobileOrTabletPortrait ? 'px-2 py-1 text-xs' : 'px-3 py-1.5 text-xs'} font-semibold`}
                  >
                    {t('chatModelSelector.actions')}
                  </SelectLabel>
                  <SelectItem value='add-new-provider'>
                    <div
                      className={`flex items-center ${isMobileOrTabletPortrait ? 'gap-1.5' : 'gap-2'}`}
                    >
                      <Plus
                        className={`${isMobileOrTabletPortrait ? 'h-3 w-3' : 'h-4 w-4'}`}
                      />
                      <span
                        className={`${isMobileOrTabletPortrait ? 'text-xs' : 'text-sm'} truncate`}
                      >
                        {t('chatModelSelector.addRemoteProvider')}
                      </span>
                    </div>
                  </SelectItem>
                  <SelectItem value='manage-local-models'>
                    <div
                      className={`flex items-center ${isMobileOrTabletPortrait ? 'gap-1.5' : 'gap-2'}`}
                    >
                      <Settings
                        className={`${isMobileOrTabletPortrait ? 'h-3 w-3' : 'h-4 w-4'}`}
                      />
                      <span
                        className={`${isMobileOrTabletPortrait ? 'text-xs' : 'text-sm'} truncate`}
                      >
                        {t('chatModelSelector.manageLocalModels')}
                      </span>
                    </div>
                  </SelectItem>
                </SelectGroup>
              </div>
            )}
          </div>
        </SelectContent>
      </Select>
    </div>
  );
}
