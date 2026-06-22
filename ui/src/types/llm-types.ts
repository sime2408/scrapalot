/**
 * Types related to LLM models and inference
 */

export interface LocalModel {
  id: string;
  name: string;
  file_size: number;
  parameters: string;
  format: string;
  path: string;
  status: 'ready' | 'downloading' | 'active' | 'error';
  description?: string;
  tags?: string[];
  model_type?: string;
  score?: number;
  provider?: string;
  icon?: string;
  download_url?: string;
  installed_date?: string;
  compatibility?: number;
  from_api?: boolean; // Whether the model was fetched from Hugging Face API
  is_fallback?: boolean; // Whether this is a fallback model from hardcoded lists
  downloads?: number; // HuggingFace download count
  likes?: number; // HuggingFace likes count
  trust_score?: number; // 0-100 author/repo trust heuristic from the backend
  repo_id?: string;
  display_name?: string; // User-friendly display name for the model
  model_name?: string; // ID from the list-models api_base
  provider_id?: string; // Provider ID from the list-models api_base
  provider_name?: string; // Provider name from the list-models api_base
  group?: string;
  iconSrc?: string;
}

// Interface for embedding models fetched from the API
export interface EmbeddingModelDescription {
  id: string; // UUID of the model
  model_name: string; // Unique model identifier (used as value in selects)
  name?: string; // Legacy field, may not be present
  display_name?: string | null; // Human-readable display name
  provider_id: string; // UUID of the provider
  provider_type: string; // Type of provider, e.g., "local", "openai"
  provider_name: string; // Name of the provider, e.g., "Ollama", "OpenAI"
  model_type: 'EMBEDDING'; // Ensures it's an embedding model
  is_embedding_model: boolean; // From DTO, should be true
  is_active: boolean; // From DTO, indicates if the model is generally active/usable
  dimensions?: number | null; // Embedding dimensions
  group?: string; // Derived field, e.g., "EMBEDDING" or provider_name for UI grouping
  iconSrc?: string; // Optional: for UI consistency, path to an icon
}

export interface LocalServiceStatus {
  running: boolean;
  api_base: string;
  version: string;
  models_directory: string;
  service_name?: string;
  status?: string;
  host?: string;
  port?: number;
  uptime_seconds?: number;
  uptime_human?: string;
  process_id?: number;
  memory_usage?: {
    rss_mb: number;
    vms_mb: number;
  };
  cpu_percent?: number;
  system_info?: {
    platform: string;
    platform_release: string;
    platform_version: string;
    architecture: string;
    processor: string;
    python_version: string;
    hostname: string;
  };
  timestamp?: string;
}

export interface LocalAIConfig {
  port: string;
  max_parallel_chats: string;
  max_loaded_models: string;
  enable_network_access: boolean;
  allowed_network_origins: string;
  append_contexts: boolean;
  use_advanced_backend: boolean;
  advanced_config: string;
  models_directory: string;
}

export interface DownloadProgress {
  progress: number;
  status: string;
  downloaded?: number;
  total_size?: number;
  error?: string;
}

// RemoteProvider interface moved to settings-types.ts to avoid duplication
// Import it from there: import { RemoteProvider } from '@/types/settings-types';

// Define the interface for system capabilities - matches actual API response
export interface SystemCapabilities {
  os: string;
  architecture: string;
  python_version: string;
  has_gpu: boolean;
  gpu_count?: number;
  primary_gpu?: {
    id: number;
    name: string;
    vendor: string;
    detection_method: string;
    dedicated_memory_mb: number;
    shared_memory_mb: number;
    total_memory_mb: number;
  };
  all_gpus?: Array<{
    id: number;
    name: string;
    vendor: string;
    detection_method: string;
    dedicated_memory_mb: number;
    shared_memory_mb: number;
    total_memory_mb: number;
  }>;
  device_type: string;
  memory: {
    gpu_memory_mb: number;
    available_gpu_mb: number;
    cpu_memory_mb: number;
    available_cpu_mb: number;
  };
  recommended_quantization: string;
  // Legacy properties for backward compatibility
  gpu_info?: {
    id: number;
    name: string;
    vram_gb: number;
    max_parameters: {
      fp16: number;
      int8: number;
      int4?: number;
    };
  };
  cpu_friendly_models?: LocalModel[];
}
