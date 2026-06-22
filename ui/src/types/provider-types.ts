import { ModelType, ProviderStatus } from './settings-types';

/**
 * Provider type enum for model providers
 */
export enum ProviderType {
  LOCAL = 'local',
  OLLAMA = 'ollama',
  VLLM = 'vllm',
  OPENAI = 'openai',
  ANTHROPIC = 'anthropic',
  GOOGLE = 'google',
  DEEPSEEK = 'deepseek',
  HUGGINGFACE = 'huggingface',
  MICROSOFT = 'microsoft',
  ALIBABA = 'alibaba',
  GROQ = 'groq',
  LMSTUDIO = 'lmstudio',
  CUSTOM = 'custom',
}

/**
 * Interface for model provider model
 */
export interface ModelProviderModel {
  id: string;
  model_name: string;
  display_name: string;
  model_type: ModelType;
  created_at?: string;
}

/**
 * Interface for creating a new model provider
 */
export interface CreateModelProvider {
  name: string;
  provider_type: string;
  api_key?: string;
  api_base?: string;
  description?: string;
  show_models?: boolean;
  status?: ProviderStatus;
  models: {
    model_name: string;
    display_name?: string;
    model_type?: string;
  }[];
}

/**
 * Interface for updating an existing model provider
 */
export interface UpdateModelProvider {
  name?: string;
  provider_type?: string;
  api_key?: string;
  api_base?: string;
  description?: string;
  show_models?: boolean;
  status?: ProviderStatus;
  models?: {
    model_name: string;
    display_name?: string;
    model_type?: string;
  }[];
}

/**
 * Complete model provider interface
 */
export interface ModelProviderDetail {
  id: string;
  name: string;
  provider_type: string;
  api_key?: string;
  api_base?: string;
  description?: string;
  show_models: boolean;
  status: ProviderStatus;
  is_local?: boolean;
  models?: ModelProviderModel[];
  created_at?: string;
  updated_at?: string;
}

/**
 * API response interface for model providers
 * This represents the exact shape of data returned from the backend API
 */
export interface ModelProviderApiResponse {
  id: string;
  name: string;
  provider_type: string;
  api_key?: string;
  api_base?: string;
  description?: string;
  show_models: boolean;
  status: string; // API returns status as string, not enum
  models?: {
    id: string;
    model_name: string;
    display_name: string;
    model_type: string; // API returns model_type as string, not enum
    created_at?: string;
  }[];
  created_at?: string;
  updated_at?: string;
}
