export interface PaginationMetadata {
  current_page: number;
  total_models: number;
  has_more: boolean;
  models_per_page: number;
}

export interface RemoteProvider {
  id: string;
  name: string;
  api_key: string;
  api_base?: string;
  show_models: boolean; // Whether to show models from this provider
  description: string;
  iconSrc?: string;
  models: ProviderModel[]; // Always use ProviderModel array for type safety
  modelTypes?: Record<string, ModelType>; // maps model_name to its type (NORMAL, EMBEDDING, VISION, AUDIO)
  status: ProviderStatus; // Provider status (active or disabled)
  provider_type: string; // Provider type (local, ollama, vllm, openai, anthropic, google, etc.)
  has_api_key?: boolean; // True if provider has an API key configured (without exposing the actual key)
  is_local?: boolean; // Flag indicating if this is a local AI provider (Ollama, VLLM, etc.)
  created_at?: string;
  updated_at?: string;
  validation_status?: string; // API token validation status ('valid', 'invalid', 'unknown', 'pending')
  validation_error?: string; // Last validation error message
  last_validation_at?: string; // Timestamp of the last validation attempt
  last_successful_validation_at?: string; // Timestamp of the last successful validation
  user_id?: string; // User ID for user-specific providers
  is_active?: boolean; // Whether this provider is currently active
  pagination?: PaginationMetadata; // Pagination metadata for models
}

export interface ProviderModel {
  id: string; // Model ID from the backend
  model_name: string;
  display_name?: string;
  model_type?: ModelType | string;
  context_window?: number;
  dimensions?: number;
  provider?: string;
  provider_id?: string;
  provider_name?: string;
}

export enum ModelType {
  NORMAL = 'NORMAL',
  EMBEDDING = 'EMBEDDING',
  VISION = 'VISION',
  AUDIO = 'AUDIO'
}

export enum ProviderStatus {
  ACTIVE = 'active',
  DISABLED = 'disabled',
}

export type SettingsTab =
  | 'general'
  | 'workspaces'
  | 'local-ai'
  | 'remote-providers'
  | 'prompts'
  | 'account'
  | 'documents'
  | 'service'
  | 'users'
  | 'voice'
  | 'mcp-integrations';

export type SettingsDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  defaultTab?: SettingsTab;
};

export interface ProviderFormProps {
  mode?: 'add' | 'edit';
  provider?: RemoteProvider | null;
  open: boolean;
  onOpenChange: (isOpen: boolean) => void;
  onSubmit: (provider: RemoteProvider | Partial<RemoteProvider>) => void;
  onClose: () => void;
  isSaving?: boolean;
  lastSaved?: Date;
  configuredProviders?: RemoteProvider[]; // List of already configured providers
}

export interface SettingsRemoteProvidersTabProps {
  providers: RemoteProvider[];
  loading?: boolean;
  handleAddProvider: () => void;
  handleEditProvider: (provider: RemoteProvider) => void;
  isMobile: boolean;
  updateProvider: (
    id: string,
    updates: Partial<RemoteProvider>
  ) => Promise<RemoteProvider>;
  deleteProvider: (id: string) => Promise<boolean>;
  fetchProviders: () => Promise<void>;
}
