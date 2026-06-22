import { api, API_BASE_URL, getAuthHeaders } from '@/lib/api';
import axios from 'axios';
import {
  generateCacheKey,
  checkCacheValidity,
  setCacheData,
  invalidateCache,
  API_CONFIG,
  cachedApiRequest,
  makeApiRequest,
  withErrorHandling,
  deduplicateRequest
} from './api-utils';
import {
  DownloadProgress,
  EmbeddingModelDescription,
  LocalAIConfig,
  LocalModel,
  LocalServiceStatus,
  SystemCapabilities,
} from '@/types/llm-types'; // Added EmbeddingModelDescription
import { Model } from '@/types';

// Cache key generators using api-utils generateCacheKey
const generateModelsKey = (providers?: string[], refresh?: boolean) => {
  return generateCacheKey('models', { providers: providers?.join(',') || 'all', refresh });
};

const generateGroupedKey = (providers?: string[], refresh?: boolean) => {
  return generateCacheKey('grouped', { providers: providers?.join(',') || 'all', refresh });
};

// Cache invalidation functions using api-utils
export const invalidateModelsCache = (): void => {
  invalidateCache(/^models_/);
  invalidateCache('installed-models');
  invalidateCache('embedding-models');
  invalidateCache('featured-models');
  invalidateCache('active-model');
  invalidateCache('appropriate-models');
};

export const invalidateProvidersCache = (): void => {
  invalidateCache(/provider/);
  invalidateCache(/^models_/);
  invalidateCache(/^grouped_/);
};

/**
 * Get the status of the local LLM service
 */
export const getLocalModelStatus = withErrorHandling(
  async (): Promise<LocalServiceStatus> => {
    return await makeApiRequest<LocalServiceStatus>('/llm-inference/status');
  },
  {
    running: false,
    api_base: import.meta.env.VITE_LLM_INFERENCE_ENDPOINT || 'http://localhost:8091',
    version: 'unknown',
    models_directory: './models',
  },
  'Error fetching local model status'
);

// Add a helper function to sanitize model data
const sanitizeModelData = (model: LocalModel): LocalModel => {
  // Ensure the model has a display_name
  return {
    ...model,
    // display_name is now required, use model_name as fallback
    display_name: model.display_name || model.model_name,
    // Filter out invalid tag values
    tags:
      model.tags?.filter(
        tag =>
          tag &&
          typeof tag === 'string' &&
          tag !== 'NaN undefined' &&
          tag !== 'undefined' &&
          !tag.includes('NaN')
      ) || [],
  };
};

/**
 * Get the list of locally installed models
 *
 * @param bypassCache Whether to bypass the cache
 * @param excludeModelType Optional model type to exclude (e.g., 'EMBEDDING' to exclude embedding models)
 * @returns Promise with an array of LocalModel objects
 */
export async function getInstalledModels(
  bypassCache: boolean = false,
  excludeModelType?: string
): Promise<LocalModel[]> {
  // Use generateCacheKey for consistent cache key generation
  const cacheKey = generateCacheKey('installed-models', { excludeModelType });

  const params = excludeModelType ? { model_type_filter: excludeModelType } : {};

  try {
    const data = await cachedApiRequest<LocalModel[]>(
      cacheKey,
      '/llm-inference/installed-models',
      {
        params,
        bypassCache,
        ttl: API_CONFIG.CACHE_TTL
      }
    );

    return Array.isArray(data) ? data.map(sanitizeModelData) : [];
  } catch (error) {
    console.error('Failed to fetch installed models:', error);
    return [];
  }
}

/**
 * Get the list of available embedding models
 */
export const fetchEmbeddingModels = withErrorHandling(
  async (bypassCache: boolean = false): Promise<EmbeddingModelDescription[]> => {
    const cacheKey = generateCacheKey('embedding-models');

    const data = await cachedApiRequest<EmbeddingModelDescription[]>(
      cacheKey,
      '/llm-inference/embedding-models',
      {
        bypassCache,
        ttl: API_CONFIG.CACHE_TTL,
        timeout: 15000 // 15 seconds - reasonable for embedding models with our backend optimizations
      }
    );

    return Array.isArray(data)
      ? data.map((model: EmbeddingModelDescription) => ({
        ...model,
        group: model.provider_name || 'EMBEDDING',
        iconSrc: getIconForProvider(
          model.provider_type,
          model.name,
          model.display_name
        ),
      }))
      : [];
  },
  [],
  'Failed to fetch embedding models'
);

/**
 * Get featured models from Hugging Face that can be installed
 * @param search Optional search query to filter models by name or description
 * @param bypassCache Optional parameter to bypass cache
 * @param minParameters Optional minimum parameter size (in billions)
 * @param maxParameters Optional maximum parameter size (in billions)
 * @returns Promise with an array of LocalModel objects
 */
export const getFeaturedModels = withErrorHandling(
  async (
    search?: string,
    bypassCache: boolean = false,
    minParameters?: number,
    maxParameters?: number
  ): Promise<LocalModel[]> => {
    const cacheKey = generateCacheKey('featured-models', {
      search,
      minParameters,
      maxParameters
    });

    // Deduplicate requests to prevent multiple simultaneous API calls
    const deduplicationKey = `getFeaturedModels-${search || 'none'}-${bypassCache}-${minParameters || 'none'}-${maxParameters || 'none'}`;

    return deduplicateRequest(deduplicationKey, async () => {

      const params: Record<string, string | number> = {};
      if (search) params.search = search;
      if (minParameters) params.min_parameters = minParameters;
      if (maxParameters) params.max_parameters = maxParameters;

      const data = await cachedApiRequest<LocalModel[]>(
        cacheKey,
        '/llm-inference/featured-models',
        {
          params,
          bypassCache,
          ttl: API_CONFIG.CACHE_TTL,
          timeout: API_CONFIG.DEFAULT_TIMEOUT
        }
      );

      return Array.isArray(data) ? data.map(sanitizeModelData) : [];

    }); // Close deduplicateRequest
  },
  [],
  'Failed to fetch featured models'
);

/**
 * Request to download a model from Hugging Face or a URL
 */
export async function downloadModel(
  model: LocalModel // Accept the full LocalModel object
): Promise<{
  status: string;
  message: string;
  model_name: string; // Return normalized ID used by backend
  model_info?: {
    file_size: number;
    size_gb: number;
    is_large: boolean;
    is_sharded: boolean;
    total_parts: number;
  };
}> {
  try {
    // Prepare the request data directly from the model object
    // The backend expects 'id' and 'download_url'
    // Use repo_id if available and no download_url, otherwise use download_url
    // Fallback to constructing URL from id if neither is present (less reliable)
    const downloadTarget =
      model.download_url ||
      model.repo_id ||
      `https://huggingface.co/${model.id}`;

    const requestData = {
      id: model.id, // Use the original ID from the model object
      model_name: model.model_name, // API identifier (required)
      display_name: model.display_name, // Optional display name for UI
      download_url: downloadTarget, // Pass the determined URL or repo_id
    };

    const response = await api.post<{
      status: string;
      message: string;
      model_name: string;
      model_info?: Record<string, unknown>;
    }>('/llm-inference/download-model', requestData);
    return response.data;
  } catch (error) {
    console.error('Error requesting model download:', error);
    // Try to parse backend error detail
    let detail = 'Failed to start model download';
    if (error.response && error.response.data && error.response.data.detail) {
      detail = error.response.data.detail;
    } else if (error.message) {
      detail = error.message;
    }
    // Rethrow a more informative error
    throw new Error(detail);
  }
}

/**
 * Delete a locally installed model
 */
export async function deleteModel(
  modelId: string
): Promise<{ success: boolean; message: string }> {
  try {
    // For deleting models, we should NOT normalize the model ID as the server expects
    // the exact ID with its extensions (e.g. ".gguf") and original format

    // Send the original modelId to the API
    const response = await api.delete(`/llm-inference/models/${modelId}`);
    return response.data;
  } catch (error) {
    console.error('Error deleting model:', error);

    // Log the detailed API error response if available
    if (error.response) {
      console.error(
        'API Error Response (' + error.response.status + '): ',
        error.response.data
      );
    }

    // Try to get additional context for the error message
    let errorMsg = error.response?.data?.detail || 'Failed to delete model';

    try {
      const status = await getLocalModelStatus();
      if (status.models_directory) {
        errorMsg =
          error.response?.data?.detail ||
          `Failed to delete model. Please check the models directory path: ${status.models_directory}`;
      }
    } catch (statusError) {
      // If we can't get the status, just use the basic error message
      console.warn(
        'Could not get model status for enhanced error message:',
        statusError
      );
    }

    throw new Error(errorMsg);
  }
}

/**
 * Reinitialize local models by scanning the filesystem and updating the database
 */
export async function reinitializeLocalModels(): Promise<{ success: boolean; message: string }> {
  try {
    const response = await api.post('/llm-inference/reinitialize-local-models');
    
    // Invalidate relevant caches after successful reinitialization
    invalidateModelsCache();
    invalidateProvidersCache();
    
    return response.data;
  } catch (error) {
    console.error('Error reinitializing local models:', error);
    
    let errorMsg = 'Failed to reinitialize local models';
    if (error.response?.data?.detail) {
      errorMsg = error.response.data.detail;
    }
    
    throw new Error(errorMsg);
  }
}

/**
 * Get current Local AI configuration
 */
export const getLocalAIConfig = withErrorHandling(
  async (): Promise<LocalAIConfig> => {
    return await makeApiRequest<LocalAIConfig>('/llm-inference/config');
  },
  {
    port: '8090',
    max_parallel_chats: '1',
    max_loaded_models: '1',
    enable_network_access: false,
    allowed_network_origins: '',
    append_contexts: true,
    use_advanced_backend: false,
    advanced_config: '{}',
    models_directory: './models',
  },
  'Error fetching local AI config'
);

/**
 * Update Local AI configuration
 */
export const updateLocalAIConfig = withErrorHandling(
  async (config: Partial<LocalAIConfig>): Promise<{ success: boolean; message: string }> => {
    return await makeApiRequest<{ success: boolean; message: string }>(
      '/llm-inference/config',
      {
        method: 'POST',
        data: config,
        timeout: API_CONFIG.DEFAULT_TIMEOUT
      }
    );
  },
  undefined,
  'Error updating local AI config'
);

/**
 * Start local LLM service
 */
export const startLocalService = withErrorHandling(
  async (): Promise<{ success: boolean; message: string }> => {
    return await makeApiRequest<{ success: boolean; message: string }>(
      '/llm-inference/service/start',
      { method: 'POST' }
    );
  },
  undefined,
  'Error starting local service'
);

/**
 * Stop local LLM service
 */
export const stopLocalService = withErrorHandling(
  async (): Promise<{ success: boolean; message: string }> => {
    return await makeApiRequest<{ success: boolean; message: string }>(
      '/llm-inference/service/stop',
      { method: 'POST' }
    );
  },
  undefined,
  'Error stopping local service'
);

/**
 * Create a streaming connection for real-time download progress updates
 */
export function createDownloadProgressStream(
  modelId: string,
  onProgress: (progress: DownloadProgress) => void,
  onComplete: () => void,
  onError: (error: string) => void
): () => void {
  const eventSource = new EventSource(
    `${API_BASE_URL}/llm-inference/download-progress-stream/${modelId}`
  );

  let maxProgress = 0; // To ensure progress doesn't go backward

  eventSource.onmessage = event => {
    try {
      const data = JSON.parse(event.data) as DownloadProgress;

      // Ensure progress is a number between 0-100
      if (typeof data.progress === 'number') {
        // Make sure progress never goes backward (sometimes happens with API)
        data.progress = Math.max(maxProgress, Math.min(100, data.progress));
        maxProgress = data.progress;
      } else {
        // Default to last known progress or 0
        data.progress = maxProgress || 0;
      }

      // Call progress handler with sanitized data
      onProgress(data);

      // If the status is 'complete', close the connection
      if (data.status === 'complete') {
        eventSource.close();
        onComplete();
      }
    } catch (error) {
      console.error('Error parsing progress event:', error);
      eventSource.close();
      onError('Error reading progress data');
    }
  };

  eventSource.onerror = () => {
    console.error('EventSource error for model:', modelId);
    eventSource.close();
    onError('Connection to server lost');
  };

  // Return a function to close the connection
  return () => {
    eventSource.close();
  };
}


// New function to get system capabilities
export const getSystemCapabilities = withErrorHandling(
  async (bypassCache: boolean = false): Promise<SystemCapabilities> => {
    const cacheKey = generateCacheKey('system-capabilities');

    const capabilities = await cachedApiRequest<SystemCapabilities>(
      cacheKey,
      '/llm-inference/system-capabilities',
      {
        bypassCache,
        ttl: API_CONFIG.CACHE_TTL
      }
    );

    // Validate the response structure
    if (!capabilities || typeof capabilities !== 'object') {
      console.error(
        'Invalid system capabilities response structure:',
        capabilities
      );
      // Return a default capabilities object instead of throwing
      return {
        os: 'unknown',
        architecture: 'unknown',
        python_version: 'unknown',
        has_gpu: false,
        device_type: 'cpu',
        memory: {
          gpu_memory_mb: 0,
          available_gpu_mb: 0,
          cpu_memory_mb: 0,
          available_cpu_mb: 0,
        },
        gpu_info: null,
        recommended_quantization: 'q4_0',
      };
    }

    return capabilities;
  },
  undefined,
  'Error fetching system capabilities'
);

// Calculate model compatibility on the frontend
export function calculateModelCompatibility(
  modelParams: string | number | null | undefined,
  systemCapabilities: SystemCapabilities
): number {
  try {
    if (!modelParams || !systemCapabilities) return 0;

    // Convert modelParams to string if it's a number, and ensure it exists
    const modelParamsStr =
      typeof modelParams === 'number'
        ? modelParams.toString()
        : typeof modelParams === 'string'
          ? modelParams
          : '0';

    // Extract numeric part from model parameters and convert to billions
    const paramStr = modelParamsStr.toLowerCase();
    let paramValue: number;

    if (paramStr.includes('m')) {
      // Convert millions to billions (e.g., "638m" -> 0.638)
      paramValue = parseFloat(paramStr.replace('m', '')) / 1000.0;
    } else {
      // Handle billions (e.g., "7B" -> 7.0)
      paramValue = parseFloat(paramStr.replace('b', ''));
    }

    if (isNaN(paramValue) || paramValue <= 0) return 0;

    // For CPU-only systems, small models should have very high compatibility scores
    const isCpuOnly = !systemCapabilities.has_gpu;
    if (isCpuOnly) {
      // Enhanced CPU compatibility scoring:
      // - Very small models (0-1B): 1.0 (perfect)
      // - Small models (1-2B): 0.95-0.98
      // - Medium-small models (2-3B): 0.9-0.95
      // - Medium models (3-5B): 0.7-0.9
      // - Large models (>5B): Rapidly decreasing scores

      if (paramValue <= 1.0) {
        // Very small models (0-1B) get perfect score
        return 1.0;
      } else if (paramValue <= 2.0) {
        // Small models (1-2B) get excellent scores
        return Math.max(0.95, 0.98 - (paramValue - 1.0) * 0.03);
      } else if (paramValue <= 3.0) {
        // Medium-small models (2-3B) get very good scores
        return Math.max(0.9, 0.95 - (paramValue - 2.0) * 0.05);
      } else if (paramValue <= 5.0) {
        // Medium models (3-5B) get good to decent scores
        return Math.max(0.7, 0.9 - (paramValue - 3.0) * 0.1);
      } else {
        // Large models (>5B) get rapidly decreasing scores
        return Math.max(0.1, 0.7 - (paramValue - 5.0) * 0.15);
      }
    }

    // For GPU systems, use the standard formula
    // Use recommended quantization from a system
    const quantization = systemCapabilities.recommended_quantization || 'int8';
    const availableMemory = systemCapabilities.memory.available_cpu_mb / 1024; // Convert MB to GB

    // Calculate memory required using the formula M = (P * 4B) / (32/Q) * 1.2
    const quantBits =
      quantization === 'fp16' ? 16 : quantization === 'int4' ? 4 : 8;
    const memoryRequired = ((paramValue * 4) / (32 / quantBits)) * 1.2;

    // Calculate compatibility score (0 to 1)
    return Math.min(1.0, availableMemory / memoryRequired);
  } catch (error) {
    console.error('Error calculating model compatibility:', error);
    return 0;
  }
}

// Calculate model memory requirements based on the formula: M = (P * 4B) / (32/Q) * 1.2
export function calculateModelMemoryRequirements(
  parametersBillions: number,
  quantizationBits: number = 8 // Default to 8-bit quantization
): number {
  // P * 4B = parameters * 4 bytes
  // 32/Q = 32 bits / quantizationBits
  // 1.2 = 20% overhead

  const memoryGB = ((parametersBillions * 4) / (32 / quantizationBits)) * 1.2;
  return parseFloat(memoryGB.toFixed(2)); // Return with 2 decimal places
}

// Get appropriate models for the current system
export const getAppropriateModels = withErrorHandling(
  async (
    search?: string,
    bypassCache: boolean = false,
    forceCpu: boolean = false
  ): Promise<LocalModel[]> => {
    const cacheKey = generateCacheKey('appropriate-models', {
      search,
      forceCpu
    });

    // Try to get from cache
    const cachedData = checkCacheValidity<LocalModel[]>(cacheKey, bypassCache);
    if (cachedData) return cachedData;

    // Get the system capabilities to determine if CPU-only
    const capabilities = await getSystemCapabilities(bypassCache);
    const isCpuOnly = !capabilities.has_gpu || forceCpu;

    // Get featured models with the appropriate parameter range
    let models: LocalModel[];
    if (isCpuOnly) {
      // If CPU-only, get smaller models (0-5B)
      models = await getFeaturedModels(search, bypassCache, 0, 5);
    } else {
      // If GPU available, get regular featured models without parameter restrictions
      models = await getFeaturedModels(search, bypassCache);
    }

    // For all systems, calculate compatibility scores
    if (models && models.length > 0) {
      models.forEach(model => {
        const paramStr = model.parameters || '0B';
        model.compatibility = calculateModelCompatibility(
          paramStr,
          capabilities
        );

        // Ensure model_type is set for proper categorization
        if (!model.model_type) {
          // Try to determine a model type from tags or model_name
          if (model.tags && model.tags.length > 0) {
            if (model.tags.some(tag => tag.toLowerCase().includes('embed'))) {
              model.model_type = 'embedding';
            } else if (
              model.tags.some(tag => tag.toLowerCase().includes('reason'))
            ) {
              model.model_type = 'reasoning';
            } else {
              model.model_type = 'chat'; // Default to chat
            }
          } else if (model.model_name) {
            const lowerName = model.model_name.toLowerCase();
            if (lowerName.includes('embed')) {
              model.model_type = 'embedding';
            } else if (lowerName.includes('reason')) {
              model.model_type = 'reasoning';
            } else {
              model.model_type = 'chat';
            }
          }
        }
      });

      // Sort by compatibility score (highest first) for better user experience
      models.sort((a, b) => (b.compatibility || 0) - (a.compatibility || 0));
    }

    // Models should already be sanitized by getFeaturedModels, but ensure consistent behavior
    models = models.map(sanitizeModelData);

    setCacheData(cacheKey, models);
    return models;
  },
  [],
  'Error getting appropriate models'
);

/**
 * Stop a running model from GPU
 */
export async function stopModelFromGpu(
  modelId: string
): Promise<{ success: boolean; message: string; status?: string }> {
  try {
    // Important: Use the exact model ID without normalization
    const response = await axios.post(
      `${API_BASE_URL}/llm-inference/models/${encodeURIComponent(
        modelId
      )}/stop-gpu`
    );

    return {
      success: response.data.success,
      message: response.data.message || 'Model stopped from GPU successfully',
      status: response.data.status,
    };
  } catch (error) {
    console.error(`Failed to stop model ${modelId} from GPU`, error);

    // Return error response matching the expected return type
    const errorMessage =
      error.response?.data?.detail ||
      `Failed to stop model ${modelId} from GPU`;
    return {
      success: false,
      message: errorMessage,
      status: 'error',
    };
  }
}

/**
 * Get the current GPU status with improved resilience
 */
export async function getGpuStatus(
  modelId?: string,
  bypassCache: boolean = true // Default to bypassing cache to ensure fresh data
): Promise<{
  is_running: boolean;
  is_available: boolean;
  current_model?: string;
  gpu_memory_used?: number;
  gpu_utilization?: number;
  error?: string;
}> {
  const cacheKey = generateCacheKey('gpu-status', { modelId });

  // Check cache if we're not bypassing
  if (!bypassCache) {
    const cachedData = checkCacheValidity<{
      is_running: boolean;
      is_available: boolean;
      current_model?: string;
      gpu_memory_used?: number;
      gpu_utilization?: number;
    }>(cacheKey, bypassCache);

    if (cachedData) {
      return cachedData;
    }
  }

  try {
    const url = modelId
      ? `/llm-inference/gpu-status/${modelId}`
      : '/llm-inference/gpu-status';

    const data = await makeApiRequest<{
      is_running: boolean;
      is_available: boolean;
      current_model?: string;
      gpu_memory_used?: number;
      gpu_utilization?: number;
    }>(url);

    // Cache the successful response data
    setCacheData(cacheKey, data);

    return data;
  } catch (error) {
    console.error('Failed to get GPU status:', error);

    return {
      is_running: false,
      is_available: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

// Helper function to get the correct icon based on provider
// Icon cache to prevent repeated calculations
const iconCache = new Map<string, string>();

// Brand icon for the system provider and as the generic fallback. Always the
// PNG — favicon.ico does not render in the Android WebView (404/blank), which
// left blank icons in model lists inside the app.
const SCRAPALOT_BRAND_ICON = '/providers/scrapalot.png';

export function getIconForProvider(
  provider?: string,
  modelName?: string,
  displayName?: string
): string {
  if (!provider && !modelName && !displayName) {
    return SCRAPALOT_BRAND_ICON;
  }

  // PRIORITY: Check for "system" provider type FIRST - always use the brand
  // logo regardless of model name
  if (provider && provider.toLowerCase().trim() === 'system') {
    return SCRAPALOT_BRAND_ICON;
  }

  // Create a cache key
  const cacheKey = `${provider || 'none'}_${modelName || 'none'}_${displayName || 'none'}`;
  if (iconCache.has(cacheKey)) {
    return iconCache.get(cacheKey)!;
  }

  let result: string;

  // Try to detect from model name or display name first (most reliable)
  const nameToCheck = modelName || displayName || '';
  const nameLower = nameToCheck.toLowerCase();

  if (nameToCheck) {
    // Anthropic models - check first since Claude models are very distinctive
    if (nameLower.includes('claude') || nameLower.includes('anthropic')) {
      result = '/providers/anthropic.svg';
      iconCache.set(cacheKey, result);
      return result;
    }
    // OpenAI models
    if (nameLower.includes('gpt') || nameLower.includes('openai')) {
      result = '/providers/openai.svg';
      iconCache.set(cacheKey, result);
      return result;
    }
    // Google models
    if (
      nameLower.includes('gemini') ||
      nameLower.includes('google') ||
      nameLower.includes('gemma')
    ) {
      result = '/providers/google.svg';
      iconCache.set(cacheKey, result);
      return result;
    }
    // Meta models
    if (nameLower.includes('llama') || nameLower.includes('meta')) {
      result = '/providers/meta.svg';
      iconCache.set(cacheKey, result);
      return result;
    }
    // LM Studio models
    if (nameLower.includes('lmstudio')) {
      result = '/providers/lmstudio.svg';
      iconCache.set(cacheKey, result);
      return result;
    }
    // DeepSeek models
    if (nameLower.includes('deepseek')) {
      result = '/providers/deepseek.svg';
      iconCache.set(cacheKey, result);
      return result;
    }
    // Microsoft models
    if (nameLower.includes('phi')) {
      result = '/providers/microsoft.svg';
      iconCache.set(cacheKey, result);
      return result;
    }
    // Alibaba models
    if (nameLower.includes('qwen')) {
      result = '/providers/alibaba.svg';
      iconCache.set(cacheKey, result);
      return result;
    }
    // ZAI models
    if (nameLower.includes('glm')) {
      result = '/providers/z-ai.svg';
      iconCache.set(cacheKey, result);
      return result;
    }
    // Moonshot models
    if (nameLower.includes('moonshot') || nameLower.includes('kimi')) {
      result = '/providers/moonshot.svg';
      iconCache.set(cacheKey, result);
      return result;
    }

    // Reasoning models - extract base model name
    if (nameLower.includes('reasoning')) {
      const baseModelName = nameLower
        .replace(/reasoning/i, '')
        .replace(/\s+/g, '')
        .trim();

      if (baseModelName.includes('deepseek')) {
        result = '/providers/deepseek.svg';
        iconCache.set(cacheKey, result);
        return result;
      }
      if (baseModelName.includes('llama')) {
        result = '/providers/meta.svg';
        iconCache.set(cacheKey, result);
        return result;
      }
      if (baseModelName.includes('lmstudio')) {
        result = '/providers/lmstudio.svg';
        iconCache.set(cacheKey, result);
        return result;
      }
      if (baseModelName.includes('phi')) {
        result = '/providers/microsoft.svg';
        iconCache.set(cacheKey, result);
        return result;
      }
      if (baseModelName.includes('qwen')) {
        result = '/providers/alibaba.svg';
        iconCache.set(cacheKey, result);
        return result;
      }
      if (baseModelName.includes('gemma')) {
        result = '/providers/google.svg';
        iconCache.set(cacheKey, result);
        return result;
      }
    }
  }

  // Fallback to provider-based detection
  if (provider) {
    const providerLower = provider.toLowerCase().trim();

    switch (providerLower) {
      case 'openai':
        result = '/providers/openai.svg';
        iconCache.set(cacheKey, result);
        return result;
      case 'anthropic':
        result = '/providers/anthropic.svg';
        iconCache.set(cacheKey, result);
        return result;
      case 'google':
        result = '/providers/google.svg';
        iconCache.set(cacheKey, result);
        return result;
      case 'openrouter':
        result = '/providers/openrouter.svg';
        iconCache.set(cacheKey, result);
        return result;
      case 'deepseek':
        result = '/providers/deepseek.svg';
        iconCache.set(cacheKey, result);
        return result;
      case 'ollama':
        result = '/providers/ollama.svg';
        iconCache.set(cacheKey, result);
        return result;
      case 'vllm':
        result = '/providers/vllm.svg';
        iconCache.set(cacheKey, result);
        return result;
      case 'lmstudio':
        result = '/providers/lmstudio.svg';
        iconCache.set(cacheKey, result);
        return result;
      case 'groq':
        result = '/providers/groq.svg';
        iconCache.set(cacheKey, result);
        return result;
      case 'local':
        result = SCRAPALOT_BRAND_ICON;
        iconCache.set(cacheKey, result);
        return result;
      case 'system':
        result = SCRAPALOT_BRAND_ICON;
        iconCache.set(cacheKey, result);
        return result;
      default:
        result = '/providers/huggingface.svg';
        iconCache.set(cacheKey, result);
        return result;
    }
  }

  // Default fallback
  result = SCRAPALOT_BRAND_ICON;
  iconCache.set(cacheKey, result);
  return result;
}

/**
 * Get all available models from all providers, with proper filtering and processing
 * @param bypassCache - Whether to bypass the cache
 * @param providers - Optional list of providers to filter models
 * @param search - Optional search query for global model search
 * @returns Array of processed models ready for UI display
 */
export const getGroupedModels = withErrorHandling(
  async (
    bypassCache = false,
    providers?: string[],
    search?: string,
    refresh = true
  ): Promise<{ providers: Array<{ id: string; provider_type: string; name: string; models: Model[] }>, total: number }> => {
    // Skip cache when searching
    const cacheKey = search ? `search_${search}` : generateGroupedKey(providers, refresh);

    // Check cache first (unless bypassing, force refresh, or searching)
    if (!bypassCache && !search) {
      const cachedData = checkCacheValidity<{ providers: Array<{ id: string; provider_type: string; name: string; models: Model[] }>, total: number }>(cacheKey, bypassCache);
      if (cachedData) {
        // If refresh=true, but we have recent cache, still use cache unless it's very old
        const cacheAge = Date.now() - ((cachedData as unknown as { timestamp: number })?.timestamp ?? 0);
        if (!refresh || cacheAge < 30000) { // Use cache if refresh=false, OR cache is less than 30 seconds old
          return cachedData;
        }
      }
    }

    // Make the API call using makeApiRequest
    const url = '/llm-inference/list-models';
    const params: Record<string, boolean | string | string[]> = {
      refresh: refresh // Add refresh parameter to control external API calls
    };
    if (providers && providers.length > 0) {
      // Send providers as array parameters in the format FastAPI expects
      params['providers[]'] = providers;
    }
    if (search) {
      // Add search parameter for global model search
      params['search'] = search;
    }

    const response = await makeApiRequest<{
      data: Array<{
        id: string;
        provider_type: string;
        name: string;
        models: Record<string, unknown>[];
      }>;
      total?: number;
    }>(url, {
      params,
      timeout: 10000 // Reduced from 30s to 10s for better UX
    });
    // Initialize a grouped providers array
    const groupedProviders: Array<{ id: string; provider_type: string; name: string; models: Model[] }> = [];

    // Process the response data - backend now returns grouped provider structure
    if (response.data && Array.isArray(response.data)) {
      // Define supported providers to filter out unsupported ones.
      // 'system' is the Scrapalot-managed default provider (gpt-4o-mini under
      // the hood) — every fresh user gets it as their only working option, so
      // dropping it leaves invited users with zero models and a "No models
      // found" empty state. 'groq' is the other default seeded for new users.
      const supportedProviders = ['openai', 'anthropic', 'google', 'openrouter', 'ollama', 'vllm', 'deepseek', 'lmstudio', 'local', 'system', 'groq'];

      response.data.forEach((provider) => {
        // Only include models from supported providers
        if (Array.isArray(provider.models) && supportedProviders.includes(provider.provider_type?.toLowerCase())) {
          // Normalize models for this provider
          const normalizedModels = provider.models
            .filter((model: Record<string, unknown>) => model.model_type !== 'EMBEDDING') // Filter out embedding models
            .map((apiModel: Record<string, unknown>) => {
              // Use the model's specific provider_type, fallback to provider's provider_type if needed
              const correctProviderType = String(apiModel.provider_type || provider.provider_type || '');

              return {
                id: String(apiModel.id || ''),
                name: String(apiModel.display_name || apiModel.model_name || apiModel.name || apiModel.id || ''),
                display_name: String(apiModel.display_name || apiModel.model_name || apiModel.name || apiModel.id || ''),
                model_name: String(apiModel.model_name || apiModel.name || apiModel.id || ''),
                model_type: String(apiModel.model_type || ''),
                provider: correctProviderType,
                provider_type: correctProviderType,
                size: apiModel.size || 0,
                parameters: '',
                format: '',
                path: '',
                file_size: apiModel.file_size || 0,
                status: apiModel.status || 'available',
                is_active: apiModel.is_active || false,
                tags: apiModel.tags || [],
                description: apiModel.description || '',
                compatibility: apiModel.compatibility || 0,
                deployment_status: apiModel.deployment_status || 'available',
              };
            });

          groupedProviders.push({
            id: provider.id || provider.provider_type,
            provider_type: provider.provider_type,
            name: provider.name,
            models: normalizedModels
          });
        }
      });
    }

    const result = {
      providers: groupedProviders,
      total: response.total || groupedProviders.reduce((sum, p) => sum + p.models.length, 0)
    };

    // Cache the result
    setCacheData(cacheKey, result);

    return result;
  },
  { providers: [], total: 0 },
  'Error fetching grouped models'
);

export const getModels = withErrorHandling(
  async (
    bypassCache = false,
    providers?: string[],
    refresh = true
  ): Promise<import('@/types').Model[]> => {
    const cacheKey = generateModelsKey(providers, refresh);

    // Deduplicate requests to prevent multiple simultaneous API calls
    const deduplicationKey = `getModels-${bypassCache}-${providers?.join(',') || 'all'}-${refresh}`;

    return deduplicateRequest(deduplicationKey, async () => {

      // Check if we have cached data
      if (!bypassCache) {
        const cachedData = checkCacheValidity<import('@/types').Model[]>(cacheKey, bypassCache);
        if (cachedData) {
          // If refresh=true, but we have recent cache, still use cache unless it's very old
          const cacheAge = Date.now() - ((cachedData as unknown as { timestamp: number })?.timestamp ?? 0);
          if (!refresh || cacheAge < 30000) { // Use cache if refresh=false, OR cache is less than 30 seconds old
            return cachedData;
          }
        }
      }

      // Get local models with timeout and fallback
      let localModels: LocalModel[];
      try {
        localModels = await Promise.race([
          getInstalledModels(bypassCache),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('getInstalledModels timeout after 5 seconds')), 5000)
          )
        ]) as LocalModel[];
      } catch (error: unknown) {
        console.warn('🔎 getModels: Local models fetch failed, continuing without them:', error instanceof Error ? error.message : String(error));
        localModels = []; // Continue without local models
      }

      // Make the API call - check if providers filtering is requested
      const url = '/llm-inference/list-models';
      const params: Record<string, boolean | string | string[]> = {
        refresh: refresh // Add refresh parameter to control external API calls
      };

      if (providers && providers.length > 0) {
        // Send providers as array parameters in the format FastAPI expects
        params['providers[]'] = providers;
      }

      const response = await makeApiRequest<{
        data: Array<{
          provider_type: string;
          models: Record<string, unknown>[];
        }>;
      }>(url, {
        params,
        timeout: 10000 // Reduced from 30s to 10s for better UX
      });
      let allModels: LocalModel[];

      // Process API response - handle new grouped response structure
      const apiModels: Record<string, unknown>[] = [];

      // Backend now returns: { data: [{ provider_type, name, models: [...] }] }
      if (Array.isArray(response.data)) {
        // Define supported providers to filter out unsupported ones
        const supportedProviders = ['openai', 'anthropic', 'google', 'openrouter', 'ollama', 'vllm', 'deepseek', 'lmstudio', 'local'];

        response.data.forEach((provider) => {
          // Only include models from supported providers
          if (Array.isArray(provider.models) && supportedProviders.includes(provider.provider_type?.toLowerCase())) {
            // Each model already has provider info embedded by backend
            apiModels.push(...provider.models);
          }
        });
      }

      // Normalize local models first to ensure consistent casing
      const normalizedLocalModels = Array.isArray(localModels)
        ? localModels.map(localModel => ({
          ...localModel,
          id: localModel.id.toLowerCase(),
          model_name: localModel.model_name || localModel.id.toLowerCase(),
        }))
        : [];

      // Normalize API models to match LocalModel interface
      const normalizedApiModels = apiModels.map((apiModel: Record<string, unknown>) => {
        return {
          id: String(apiModel.id || ''),
          name: String(apiModel.display_name || apiModel.model_name || apiModel.name || apiModel.id || ''),
          display_name: String(apiModel.display_name || apiModel.model_name || apiModel.name || apiModel.id || ''),
          model_name: String(apiModel.model_name || apiModel.name || apiModel.id || ''),
          model_type: String(apiModel.model_type || ''),
          provider: String(apiModel.provider || apiModel.provider_type || ''),
          provider_type: String(apiModel.provider_type || ''),
          size: apiModel.size || 0,
          parameters: '',
          format: '',
          path: '',
          file_size: apiModel.file_size || 0,
          status: apiModel.status || 'available',
          tags: apiModel.tags || [],
          description: apiModel.description || '',
          compatibility: apiModel.compatibility || 0,
          deployment_status: apiModel.deployment_status || 'available',
        };
      });

      if (apiModels.length > 0) {
        // Start with all local models
        allModels = [...normalizedLocalModels];

        // Add ALL API models, even if they might be duplicates
        for (const apiModel of normalizedApiModels) {
          if (!apiModel.id) continue;

          const existingModel = allModels.find(m => m.id === apiModel.id);

          if (!existingModel) {
            allModels.push(apiModel);
          } else {
            const mergedModel = {
              ...existingModel,
              ...apiModel,
              path: existingModel.path || apiModel.path,
              format: existingModel.format || apiModel.format,
              tags: [...(existingModel.tags || []), ...(apiModel.tags || [])].filter((tag, index, arr) => arr.indexOf(tag) === index),
            };
            const index = allModels.findIndex(m => m.id === apiModel.id);
            allModels[index] = mergedModel;
          }
        }
      } else {
        allModels = Array.isArray(localModels) ? localModels : [];
      }

      if (!allModels || allModels.length === 0) {
        return [];
      }

      // Filter out embedding models and models with deployment errors
      const nonEmbeddingModels = allModels.filter(model => {
        const modelType = (model.model_type || '').toLowerCase();
        const modelName = (model.model_name || '').toLowerCase();  // Use API identifier (required field)
        const modelId = (model.id || '').toLowerCase();

        const isEmbedding = modelType === 'embedding' ||
          (modelName.includes('embedding') && !modelName.includes('non-embedding')) ||
          (modelId.includes('embedding') && !modelId.includes('non-embedding'));

        const hasDeploymentError = (model as unknown as Record<string, unknown>).deployment_status === 'error';
        return !isEmbedding && !hasDeploymentError;
      });

      // Process models to ensure they have the correct format for the UI
      const processedModels = nonEmbeddingModels.map(model => {
        let displayName = model.display_name || model.model_name;
        displayName = displayName
          .replace(/\s*\(Chat\)\s*$/i, '')
          .replace(/\s*\(Reasoning\)\s*$/i, '');

        // Set group based on provider_type, not defaulting everything to LOCAL AI
        let group = model.group;
        if (!group) {
          // Use provider_type to determine group
          const providerType = (model as unknown as Record<string, unknown>).provider_type as string || model.provider || 'unknown';
          group = providerType.toUpperCase();
        }

        const provider = model.provider || '';
        let iconSrc = model.icon || getIconForProvider(provider, model.model_name, model.display_name);

        if (iconSrc === '/providers/huggingface.svg') {
          iconSrc = getIconForProvider(provider, model.model_name, displayName);
        }

        return {
          ...model,
          id: model.id || `model-${Math.random().toString(36).substring(2, 9)}`,
          group,
          iconSrc,
          name: displayName,
          model_name: model.model_name, // Keep original API identifier, don't fallback to display name
          display_name: model.display_name || displayName,
          provider,
          provider_type: (model as unknown as Record<string, unknown>).provider_type as string || model.provider || 'unknown',
        };
      });

      // Cache the result
      setCacheData(cacheKey, processedModels);
      return processedModels;

    }); // Close deduplicateRequest
  },
  [],
  'Error in getModels'
);

/**
 * Deploy a local model manually
 */
export const deployLocalModel = withErrorHandling(
  async (modelId: string): Promise<{ success: boolean; message: string; status?: string }> => {
    return await makeApiRequest<{ success: boolean; message: string; status?: string }>(
      '/llm-inference/deploy-model',
      {
        method: 'POST',
        data: { model_id: modelId }
      }
    );
  },
  { success: false, message: 'Failed to deploy model', status: 'error' },
  'Error deploying local model'
);

/**
 * Undeploy a local model manually
 */
export const undeployLocalModel = withErrorHandling(
  async (modelId: string): Promise<{ success: boolean; message: string; status?: string }> => {
    return await makeApiRequest<{ success: boolean; message: string; status?: string }>(
      '/llm-inference/undeploy-model',
      {
        method: 'POST',
        data: { model_id: modelId }
      }
    );
  },
  { success: false, message: 'Failed to undeploy model', status: 'error' },
  'Error undeploying local model'
);

/**
 * Get deployment status of local models
 */
export const getDeploymentStatus = withErrorHandling(
  async (): Promise<{
    deployed: boolean;
    model_id?: string;
    status: string;
    message?: string;
  }> => {
    return await makeApiRequest<{
      deployed: boolean;
      model_id?: string;
      status: string;
      message?: string;
    }>('/llm-inference/deployment-status');
  },
  {
    deployed: false,
    status: 'error',
    message: 'Failed to get deployment status',
  },
  'Error getting deployment status'
);

/**
 * Fetch models from a provider API without saving to a database for user preview/selection
 * @param provider_type Provider type (openai, anthropic, etc.)
 * @param api_key API key for the provider
 * @param api_base Optional API base URL for local providers
 */
export async function fetchProviderModelsPreview(
  provider_type: string,
  api_key?: string,
  api_base?: string
): Promise<{
  success: boolean;
  message: string;
  provider_type: string;
  models_count: number;
  models: {
    model_name: string;
    model_type: string;
    context_length?: number;
    input_cost: number;
    output_cost: number;
    supports_tools: boolean;
  }[];
}> {
  try {
    // Check authentication before making the request
    const authHeaders = getAuthHeaders();
    if (Object.keys(authHeaders).length === 0) {
      console.warn(
        `⚠️ No authentication headers found - user may not be logged in`
      );
    }
    const response = await api.post('/llm-inference/fetch-provider-models', {
      provider_type,
      api_key,
      api_base,
    });


    return response.data;
  } catch (error: unknown) {
    console.error(
      `❌ POST request failed for provider ${provider_type}:`,
      error
    );
    if (axios.isAxiosError(error)) {
      console.error(`Error details:`, {
        status: error.response?.status,
        statusText: error.response?.statusText,
        data: error.response?.data,
        message: error.message,
      });
    } else {
      console.error(`Error details:`, { message: error instanceof Error ? error.message : String(error) });
    }
    // Re-throw the original error to preserve response data (status, error_code, detail)
    throw error;
  }
}
