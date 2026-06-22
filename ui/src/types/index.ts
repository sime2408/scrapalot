export interface Message {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: Date;
  message_metadata?: Record<string, unknown>; // Set by frontend during streaming
  metadata?: Record<string, unknown>;          // Set by backend (Kotlin) in DB
  session_id?: string;
  created_at?: string;
  updated_at?: string;
  feedback?: number | null;                    // 1=positive, -1=negative, null=no feedback
}

// Re-export Session from api-sessions instead of defining Conversation
export type { Session } from '@/lib/api-sessions';

// Add this to augment the Session type with lastMessageFetchTime
declare module '@/lib/api-sessions' {
  interface Session {
    lastMessageFetchTime?: number;
  }
}

export interface Model {
  id: string;
  model_name: string;  // API identifier for backend calls (required)
  display_name?: string;  // Human-readable display name (optional - UI can fallback to model_name)
  group?: string;
  iconSrc?: string;
  provider?: string;
  provider_id?: string;  // UUID of the provider
  description?: string;
  size?: string;
  is_active?: boolean;
  is_system_model?: boolean;  // True if provider.user_id IS NULL (system-wide provider)
  model_type?: string;
  provider_type?: string;
  provider_name?: string;
  // Add new properties from API response
  status?: string;
  file_size?: string | number;
  parameters?: string | number;
  format?: string;
  path?: string;
  installed_date?: string;
}

export type {
  LocalModel,
  LocalServiceStatus,
  LocalAIConfig,
  DownloadProgress,
  SystemCapabilities,
} from './llm-types';

export interface ModelSettings {
  maxOutputTokens: number;
  temperature: number;
  contextWindowSize: number;
  topP: number;
  topK: number;
  frequencyPenalty: number;
  presencePenalty: number;
  gpuLayers: number;
  contextMessageLimit: number;
  extraModelParameters?: string;
  modelInstructions?: string;
}

export interface DocumentCollection {
  id: string;
  name: string;
  description?: string;
  workspace_id: string;
  parentCollectionId?: string | null;
  parent_collection_id?: string | null;
  depth?: number;
  sortOrder?: number;
  sort_order?: number;
  created_at: Date;
  updated_at?: Date;
  documentIds?: string[];
  documentCount?: number;
  // per-collection AI system-prompt addendum.
  // Backend Jackson serializes to snake_case so wire payloads carry
  // `custom_instructions`. We also expose a camelCase alias because the
  // rest of this type does the same for legacy fields (parent_collection_id
  // ↔ parentCollectionId, sort_order ↔ sortOrder).
  custom_instructions?: string | null;
  customInstructions?: string | null;
  // Knowledge-graph build tier: 0=none, 1=light, 2=full; null=inherit from parent.
  // snake_case from the Kotlin wire + camelCase alias (same dual pattern as above).
  graph_tier?: number | null;
  graphTier?: number | null;
}

export interface SendMessageOptions {
  model_name?: string;
  provider_type?: string;
  session_id?: string;
  user_message_id?: string;
  web_search_enabled?: boolean;
  deep_research_enabled?: boolean;
  research_breadth?: number;
  research_depth?: number;
  similarity_threshold?: number;
  top_k?: number;
  agentic_rag_enabled?: boolean;
  /** 7.8 v1 — AI Tutor Mode. Server prepends Socratic-tutor
   *  instructions to the prompt before LLM generation. */
  tutor_mode?: boolean;
  /** 7.7 — Thought Partner Mode. LLM never answers; returns 3-5
   *  numbered probing questions instead. Routes to DirectLLM (no
   *  retrieval). Mutually exclusive with tutor_mode in the UI. */
  thought_partner_mode?: boolean;
  attachments?: import('./file-attachments').ChatAttachment[];
  mention_collection_ids?: string[];
  mention_document_ids?: string[];
  mentions?: Array<{ type: 'collection' | 'document'; id: string; name: string; collectionName?: string }>;
  // Deep Research v1: Clarification answers
  clarification_answers?: Array<{ question: string; answer: string }>;
  clarification_request_id?: string;
  // Deep Research v1: Plan preview
  approved_plan_id?: string;
  // Deep Research v1: Research template
  template_type?: string;
  /** Deep Research — agentic Council roster (user-defined members). When the
   *  council is enabled and >=2 members are provided, each councilor runs as
   *  its own agent on its own `provider:model`; empty/None falls back to the
   *  default 12-archetype council. Forwarded via gRPC metadata['council_members']. */
  council_members?: Array<{ name: string; role?: string; model?: string; stance?: string }>;
  /** Deep Research run mode. 'autonomous' dispatches a durable background job
   *  (close the tab, track it under Jobs / come back later) instead of inline
   *  streaming. Forwarded via gRPC metadata['research_mode']. */
  research_mode?: 'autonomous' | string;
  // Continue researching from previous plan
  continue_research_plan_id?: string;
  continuation_context?: string;
  // Deep Research flow control
  hide_user_message?: boolean;
  plan_feedback?: string;
  previous_plan_id?: string;
  research_setup_pending?: boolean;
  /** Settings → Prompts → Custom Templates picker (chat toolbar
   *  popover). Forwarded to Python via gRPC metadata where Layer 6
   *  of the system-prompt builder resolves the body from
   *  user_settings.prompt_templates. */
  prompt_template_name?: string;
  /** Hex codes selected on the chat toolbar's annotation-color chip row.
   *  Filters retrieval to chunks on pages with annotations of those
   *  colors and rescores by per-color boost (Python-side). */
  annotation_color_filter?: string[];
  deep_synthesis_enabled?: boolean;
}

export interface User {
  id: string;
  username: string;
  email: string;
  first_name?: string;
  last_name?: string;
  profile_picture?: string;
  is_active: boolean;
  role: string;
  is_superadmin?: boolean;  // Only this account may impersonate admin-role users
  created_at: Date;
  updated_at?: Date;
  plan?: string;
  can_share_workspaces?: boolean;
  license_agreement_consent?: boolean;
  content_sharing_consent?: boolean;
  tour_completed?: boolean; // Onboarding tour completion status
  // Legacy fields for compatibility
  name?: string;
  imageUrl?: string;
}

export interface FewShotExample {
  input: string;
  output: string;
}

export interface PromptTemplate {
  id: string;
  title: string;
  content: string;
  description?: string;
  category?: string;
  isActive?: boolean;
  examples?: FewShotExample[];
}

// Export all types from file-attachments
export * from './file-attachments';

// Export all types from api-types
export * from './api-types';

// Export all provider types
export * from './provider-types';
