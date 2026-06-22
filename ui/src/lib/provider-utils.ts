import {
  RemoteProvider,
  ModelType,
  ProviderModel,
} from '@/types/settings-types';
import { getIconForProvider } from './api-llm-inference.ts';

/**
 * Check if a provider is a local provider
 * Only 'local' is considered as Local AI. Everything else (including 'ollama' and 'vllm')
 * is considered remote and should appear in the remote providers tab
 */
export function isLocalProvider(providerType: string): boolean {
  return (providerType || '').toLowerCase() === 'local';
}

/**
 * Format a provider from the backend API to the frontend RemoteProvider format
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- raw API response shape varies
export function formatProvider(provider: any): RemoteProvider {
  // Convert models from backend format to ProviderModel array
  const models: ProviderModel[] = Array.isArray(provider.models)
    ? provider.models.map((model: string | Partial<ProviderModel>) => {
        if (typeof model === 'string') {
          // Convert string to ProviderModel
          return {
            model_name: model,
            display_name: model,
            model_type: ModelType.NORMAL,
          };
        } else {
          // Already an object, ensure it has all required fields
          return {
            model_name: model.model_name,
            display_name: model.display_name,
            model_type: model.model_type || ModelType.NORMAL,
            context_window: model.context_window,
            dimensions: model.dimensions,
            provider_id: model.provider_id,
            provider_name: model.provider_name,
          };
        }
      })
    : [];

  return {
    id: provider.id,
    name: provider.name,
    api_key: provider.api_key || '',
    api_base: provider.api_base || '',
    provider_type: provider.provider_type,
    iconSrc: provider.iconSrc || getIconForProvider(provider.provider_type),
    status: provider.status || 'disabled',
    description: provider.description || '',
    show_models: provider.show_models || false,
    is_local: provider.is_local || false,
    created_at: provider.created_at,
    updated_at: provider.updated_at,
    validation_status: provider.validation_status,
    validation_error: provider.validation_error,
    last_validation_at: provider.last_validation_at,
    last_successful_validation_at: provider.last_successful_validation_at,
    has_api_key: provider.has_api_key,
    models: models,
  };
}

/**
 * Format a provider from the frontend RemoteProvider format to the backend API format
 */
export function formatProviderForApi(provider: Partial<RemoteProvider>): Record<string, unknown> {
  // Handle models - now always ProviderModel[]
  let formattedModels = [];

  if (provider.models && Array.isArray(provider.models)) {
    formattedModels = provider.models
      // Filter out null or undefined values
      .filter((model): model is ProviderModel => {
        return model !== null && model !== undefined;
      })
      .map(model => ({
        model_name: model.model_name,
        display_name: model.display_name || model.model_name,
        model_type: model.model_type || ModelType.NORMAL,
        context_window: model.context_window,
        dimensions: model.dimensions,
        provider: model.provider,
        provider_id: model.provider_id,
        provider_name: model.provider_name,
      }));
  }

  return {
    id: provider.id,
    name: provider.name,
    provider_type: provider.provider_type,
    api_key: provider.api_key, // Already in snake_case
    api_base: provider.api_base,
    description: provider.description,
    show_models: provider.show_models, // Already in snake_case
    status: provider.status,
    models: formattedModels,
  };
}
