// Types for API functions and responses
import type { ChatAttachment } from './file-attachments';

export interface ChatRequest {
  prompt: string;
  session_id: string;
  collection_ids?: string[];
  document_ids?: string[];
  model_id?: string; // Database UUID or model identifier (for reference/tracking)
  model_name?: string; // Human-readable model name (e.g., "gpt-4o-mini", "llama3.1:8b") - REQUIRED for LLM calls
  provider_type?: string; // Provider type (e.g., 'openai', 'anthropic', 'local')
  language?: string;
  stream?: boolean;
  document_ids_all_collections?: boolean;
  web_search_enabled?: boolean;
  deep_research_enabled?: boolean;
  research_breadth?: number; // Number of sources to explore (1-10, default: 4)
  research_depth?: number; // Depth of analysis per source (1-5, default: 2)
  user_message_id?: string; // Existing user message ID to reuse (for repeat functionality)
  agentic_rag_enabled?: boolean; // Enable agentic RAG routing for intelligent multi-source orchestration
  workspace_id?: string; // Workspace ID for agentic RAG collection discovery
  attachments?: ChatAttachment[]; // File attachments (documents, images, YouTube URLs)
  annotation_color_filter?: string[]; // Hex colors (e.g. "#ffd400") — filter retrieval to user-highlighted pages
  deep_synthesis_enabled?: boolean; // Append the model's own-knowledge reflection after the answer
}

export interface ChatStreamResponse {
  type:
    | 'bot_answer'
    | 'error'
    | 'status'
    | 'stream_end'
    | 'fact_check'
    | 'think';
  content: string;
  sources?: Record<string, unknown>[];
  error?: string;
}

export interface ApiError extends Error {
  status?: number;
  statusText?: string;
}

export interface ProviderModel {
  id: string;
  name: string;
  display_name?: string;
  model_name?: string;
  provider_id?: string;
  created_at?: string;
  model_type?: string; // 'NORMAL', 'EMBEDDING', 'VISION' or 'AUDIO'
}

export interface ModelProvider {
  id: string;
  name: string;
  provider_type: string;
  api_base?: string;
  description?: string;
  show_models: boolean;
  status: string;
  models: ProviderModel[] | string[];
  api_key?: string;
  is_local?: boolean; // Flag indicating if this is a local AI provider (Ollama, VLLM, etc.)
}

export interface AuthTokens {
  access_token: string;
  token_type: string;
  refresh_token?: string;
  expires_in?: number;
}

export interface UserWithPlan {
  id: string;
  username: string;
  email: string;
  first_name?: string;
  last_name?: string;
  is_active: boolean;
  role: string;
  created_at: Date;
  updated_at?: Date;
  plan?: string;
  can_share_workspaces?: boolean;
}
