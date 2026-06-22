// import { getToken } from './auth-utils'; // Function doesn't exist, removing unused import
import axios from 'axios';
import { api, apiUrls, clearCache } from './api';
import { ModelSettings } from '@/types';
import { API_CONFIG, checkCacheValidity, setCacheData } from './api-utils';
import { getIconForProvider } from './api-llm-inference';

// =============================================================================
// EMBEDDING SETTINGS TYPES
// =============================================================================

/**
 * Comprehensive embedding model settings with full model metadata
 */
export interface EmbeddingSettings {
  /** The embedding model name (e.g., "all-MiniLM-L6-v2") */
  embedding_model: string;
  /** Display-friendly model name */
  display_name?: string;
  /** Model type (always "EMBEDDING" for embedding models) */
  model_type?: string;
  /** Embedding vector dimensions (e.g., 384, 768, 1536) */
  dimensions?: number | null;
  /** Maximum context window in tokens */
  context_window?: number | null;
  /** Maximum number of tokens */
  max_tokens?: number | null;
  /** Provider type (e.g., "local", "openai", "ollama") */
  provider_type?: string;
  /** Provider name (e.g., "HuggingFace", "OpenAI") */
  provider_name?: string;
}

/**
 * Get embedding settings for the current user
 */
export async function getEmbeddingSettings(): Promise<EmbeddingSettings> {
  try {
    const response = await api.get(`${apiUrls.settings}/embedding`);
    return response.data;
  } catch (error) {
    console.error('Error fetching embedding settings:', error);
    // Return minimal fallback structure
    return {
      embedding_model: '', // No hardcoded default - will be set by backend based on available models
      display_name: '',
      model_type: 'EMBEDDING',
      dimensions: null,
      context_window: null,
      max_tokens: null,
      provider_type: 'local',
      provider_name: 'Unknown',
    };
  }
}

// Prevent duplicate saves with identical data
let lastSaveData: string | null = null;
let lastSaveTime = 0;
const SAVE_DEBOUNCE_MS = 500; // 500ms

/**
 * Save embedding settings for the current user
 *
 * @param settings - Embedding settings (can be minimal with just embedding_model)
 * @returns Comprehensive embedding settings with full model metadata enriched by backend
 */
export async function saveEmbeddingSettings(settings: Partial<EmbeddingSettings>) {
  const now = Date.now();
  const currentDataHash = JSON.stringify(settings);

  // Only prevent save if it's the same data within the debounce window
  if (now - lastSaveTime < SAVE_DEBOUNCE_MS && currentDataHash === lastSaveData) {
    return { status: 'success', message: 'Duplicate save prevented' };
  }

  lastSaveTime = now;
  lastSaveData = currentDataHash;
  try {
    // Send embedding model to backend
    // Backend will enrich this with comprehensive model information from database
    const response = await api.post(
      `${apiUrls.settings}/embedding`,
      { embedding_model: settings.embedding_model }
    );

    // Response contains comprehensive embedding settings with dimensions, provider info, etc.
    return response.data;
  } catch (error) {
    console.error('❌ Error saving embedding settings:', error);
    throw error;
  }
}

/**
 * Save document processing settings for the current user
 */
export async function saveDocumentProcessingSettings(settings: Record<string, unknown>) {
  try {
    // Prepare document processing settings
    const documentSettings = {
      splitter_type: settings.splitter_type || 'enhanced_markdown',
      chunk_size: parseInt(String(settings.chunk_size || 1000), 10),
      chunk_overlap: parseInt(String(settings.chunk_overlap || 200), 10),
      chunk_sizes_to_ignore: parseInt(String(settings.chunk_sizes_to_ignore || 20), 10),
      semantic_chunking: settings.semantic_chunking || {
        enabled: false,
        method: 'percentile',
        threshold: 90,
      },
      markdown_chunking: settings.markdown_chunking || {
        enabled: true,
        return_each_line: false,
        strip_headers: false,
      },
      retriever_type: settings.retriever_type || 'ensemble',
    };

    const response = await api.post(
      `${apiUrls.settings}/document_processing`,
      { value: documentSettings }
    );
    return response.data;
  } catch (error) {
    console.error('Error saving document processing settings:', error);
    throw error;
  }
}

/**
 * Get document processing settings for the current user
 */
export async function getDocumentProcessingSettings() {
  try {
    const response = await api.get(`${apiUrls.settings}/document_processing`);
    return response.data;
  } catch (error) {
    console.error('Error fetching document processing settings:', error);
    // Return default values if the API call fails
    return {
      splitter_type: 'enhanced_markdown', // Better for PDFs with header/footer filtering
      chunk_size: 1000,
      chunk_overlap: 200,
      chunk_sizes_to_ignore: 20,
      semantic_chunking: {
        enabled: false,
        method: 'percentile',
        threshold: 90,
      },
      markdown_chunking: {
        enabled: true,
        return_each_line: false,
        strip_headers: false,
      },
      retriever_type: 'ensemble',
    };
  }
}

/**
 * Get all user settings (general settings only).
 *
 * The /settings/ endpoint returns an ARRAY of all key-value pairs
 * for the current user. Settings dialog's loadInitialSettings()
 * expects the settings_general value object (so it can read
 * `general.response_formality`, `general.font_style`, etc.).
 * Without unwrapping, every property access on the returned array
 * yields undefined and the dialog falls back to defaults — which
 * is what made formality / domain focus appear "not persisted"
 * even though the backend had the value stored.
 */
export async function getUserSettings() {
  try {
    const response = await api.get(`${apiUrls.settings}/`);
    const data = response.data;
    if (Array.isArray(data)) {
      const general = data.find(
        (s: { setting_key?: string }) => s?.setting_key === 'settings_general',
      ) as { setting_value?: Record<string, unknown> } | undefined;
      return general?.setting_value ?? {};
    }
    return data;
  } catch (error) {
    console.error('Error fetching user settings:', error);
    throw error;
  }
}

/**
 * Get model settings for the current user
 */
export async function getModelSettings(chatId?: string) {
  try {
    const url = chatId
      ? `${apiUrls.settings}/model-settings?chat_id=${encodeURIComponent(chatId)}`
      : `${apiUrls.settings}/model-settings`;

    const response = await api.get(url);
    return response.data;
  } catch (error) {
    console.error('Error fetching model settings:', error);
    // Return default values if API call fails
    return {
      temperature: 0.1,
      maxOutputTokens: 8000,
      topP: 0.9,
      topK: 40,
      frequencyPenalty: 0.5,
      presencePenalty: 0.5,
      modelInstructions: 'You are a helpful assistant.',
      contextWindowSize: 256000,
      contextMessageLimit: 30,
      gpuLayers: -1,
      extraModelParameters: '',
    };
  }
}

/**
 * Save model settings for the current user
 */
export async function saveModelSettings(
  settings: ModelSettings,
  chatId?: string
) {
  try {
    const url = chatId
      ? `${apiUrls.settings}/model?chat_id=${encodeURIComponent(chatId)}`
      : `${apiUrls.settings}/model`;

    // Send numeric values as numbers (not strings) so Python LLM factory can use them directly
    const sanitizedSettings = {
      temperature: Number(settings.temperature) || 0.1,
      max_output_tokens: Number(settings.maxOutputTokens) || 8000,
      top_p: Number(settings.topP) || 0.9,
      top_k: Number(settings.topK) || 40,
      frequency_penalty: Number(settings.frequencyPenalty) || 0.5,
      presence_penalty: Number(settings.presencePenalty) || 0.5,
      model_instructions: String(
        settings.modelInstructions || 'You are a helpful assistant.'
      ),
      context_window_size: Number(settings.contextWindowSize) || 256000,
      context_message_limit: Number(settings.contextMessageLimit) || 30,
      gpu_layers: Number(settings.gpuLayers) || -1,
      extra_model_parameters: String(settings.extraModelParameters || ''),
    };

    // Format the request body to match the backend's expected structure
    const requestBody = {
      value: sanitizedSettings,
    };

    // Add chat_id to the request body if provided
    if (chatId) {
      requestBody['chat_id'] = chatId;
    }

    const response = await api.post(url, requestBody);
    return response.data;
  } catch (error) {
    console.error('Error saving model settings:', error);

    throw error;
  }
}

/**
 * Save prompt templates for the current user
 */
export async function savePromptTemplates(
  templates: { name: string; content: string; examples?: { input: string; output: string }[] }[]
) {
  try {
    // Wrap templates in the format expected by the backend
    const data = {
      value: {
        templates: templates,
      },
    };

    const response = await api.post(`${apiUrls.settings}/prompts`, data);
    return response.data;
  } catch (error) {
    console.error('Error saving prompt templates:', error);
    throw error;
  }
}

/**
 * Get prompt templates for the current user
 */
export async function getPromptTemplates() {
  try {
    // Use the GET method to fetch prompt templates
    const response = await api.get(`${apiUrls.settings}/prompts`);
    return response.data; // Now returns the full response with setting_value
  } catch (error) {
    console.error('Error fetching prompt templates:', error);
    // Return a default format that matches what the frontend expects
    return {
      setting_value: {
        templates: [],
      },
    };
  }
}

/**
 * Save the active prompt template (selected from the popover) so Python can read it for few-shot injection
 */
export async function saveActivePromptTemplate(
  template: { title: string; content: string; examples?: { input: string; output: string }[] } | null
) {
  try {
    const response = await api.put(`${apiUrls.settings}/user/active_prompt_template`, template);
    return response.data;
  } catch (error) {
    console.error('Error saving active prompt template:', error);
    throw error;
  }
}

// =============================================================================
// ADMIN DEFAULT SYSTEM PROMPT (Layer 1 of Python's system_prompt_builder)
// =============================================================================

export interface AdminDefaultSystemPromptResponse {
  prompt: string;
  is_set: boolean;
}

export async function getAdminDefaultSystemPrompt(): Promise<AdminDefaultSystemPromptResponse> {
  try {
    const response = await api.get(`${apiUrls.settings}/admin-default-system-prompt`);
    return {
      prompt: typeof response.data?.prompt === 'string' ? response.data.prompt : '',
      is_set: Boolean(response.data?.is_set),
    };
  } catch (error) {
    console.error('Error fetching admin default system prompt:', error);
    return { prompt: '', is_set: false };
  }
}

export async function saveAdminDefaultSystemPrompt(prompt: string): Promise<void> {
  await api.put(`${apiUrls.settings}/admin-default-system-prompt`, { prompt });
}

// =============================================================================
// RESEARCH TEMPLATES (Deep Research Feature)
// =============================================================================

export type ResearchTone = 'objective' | 'formal' | 'analytical' | 'persuasive' | 'informative' | 'explanatory' | 'descriptive' | 'critical' | 'comparative' | 'speculative' | 'reflective' | 'narrative' | 'optimistic' | 'pessimistic' | 'simple' | 'casual';
export type ReportType = 'standard' | 'outline' | 'executive_summary' | 'bibliography' | 'detailed';

export interface ResearchTemplate {
  id?: string;
  name: string;
  description: string;
  methodology: 'analytical' | 'comparative' | 'narrative' | 'thematic' | 'systematic';
  quality_standards: {
    accuracy: number;
    completeness: number;
    citation: number;
  };
  citation_style: 'APA' | 'MLA' | 'Chicago' | 'IEEE';
  tone: ResearchTone;
  report_type: ReportType;
  is_default?: boolean;
}

// Default research templates that are always available
export const DEFAULT_RESEARCH_TEMPLATES: ResearchTemplate[] = [
  {
    id: 'default-quick',
    name: 'Quick Research',
    description: 'Fast research with moderate depth - ideal for time-sensitive queries',
    methodology: 'analytical',
    quality_standards: { accuracy: 0.7, completeness: 0.6, citation: 0.5 },
    citation_style: 'APA',
    tone: 'informative',
    report_type: 'executive_summary',
    is_default: true,
  },
  {
    id: 'default-scientific',
    name: 'Scientific Research',
    description: 'Rigorous empirical research following the scientific method with peer-reviewed sources',
    methodology: 'systematic',
    quality_standards: { accuracy: 0.95, completeness: 0.9, citation: 0.95 },
    citation_style: 'APA',
    tone: 'formal',
    report_type: 'detailed',
    is_default: true,
  },
  {
    id: 'default-consciousness',
    name: 'Consciousness & Spirituality',
    description: 'Exploration of consciousness studies, spiritual traditions, and contemplative practices with balanced scholarly and experiential perspectives',
    methodology: 'thematic',
    quality_standards: { accuracy: 0.85, completeness: 0.9, citation: 0.8 },
    citation_style: 'Chicago',
    tone: 'reflective',
    report_type: 'standard',
    is_default: true,
  },
  {
    id: 'default-metaphysical',
    name: 'Metaphysical Exploration',
    description: 'Deep inquiry into reality, existence, ontology, and non-mainstream scientific paradigms including quantum consciousness and holistic worldviews',
    methodology: 'narrative',
    quality_standards: { accuracy: 0.8, completeness: 0.85, citation: 0.75 },
    citation_style: 'Chicago',
    tone: 'speculative',
    report_type: 'standard',
    is_default: true,
  },
  {
    id: 'default-comparative',
    name: 'Comparative Philosophy',
    description: 'Cross-cultural philosophical analysis comparing Eastern and Western traditions, perennial philosophy, and wisdom teachings',
    methodology: 'comparative',
    quality_standards: { accuracy: 0.85, completeness: 0.85, citation: 0.85 },
    citation_style: 'Chicago',
    tone: 'analytical',
    report_type: 'standard',
    is_default: true,
  },
  {
    id: 'default-technical',
    name: 'Technical Deep Dive',
    description: 'In-depth technical analysis with comprehensive documentation for engineering and technology topics',
    methodology: 'analytical',
    quality_standards: { accuracy: 0.9, completeness: 0.85, citation: 0.8 },
    citation_style: 'IEEE',
    tone: 'analytical',
    report_type: 'detailed',
    is_default: true,
  },
  {
    id: 'default-general',
    name: 'General Research',
    description: 'Balanced research approach suitable for most topics with good accuracy and comprehensive coverage',
    methodology: 'analytical',
    quality_standards: { accuracy: 0.8, completeness: 0.8, citation: 0.75 },
    citation_style: 'APA',
    tone: 'objective',
    report_type: 'standard',
    is_default: true,
  },
];

/**
 * Get research templates for the current user (backend returns merged defaults + user templates)
 */
export async function getResearchTemplates(): Promise<ResearchTemplate[]> {
  try {
    const response = await api.get(`${apiUrls.settings}/research_templates`);
    // Backend already merges default templates with user templates
    return response.data?.setting_value?.templates || DEFAULT_RESEARCH_TEMPLATES;
  } catch (error) {
    console.error('Error fetching research templates:', error);
    // Return default templates if API call fails
    return DEFAULT_RESEARCH_TEMPLATES;
  }
}

/**
 * Save research templates for the current user (only saves user-created templates)
 */
export async function saveResearchTemplates(templates: ResearchTemplate[]) {
  try {
    // Filter out default templates - only save user-created ones
    const userTemplates = templates.filter(t => !t.is_default);

    const data = {
      value: {
        templates: userTemplates,
      },
    };

    const response = await api.post(`${apiUrls.settings}/research_templates`, data);
    return response.data;
  } catch (error) {
    console.error('Error saving research templates:', error);
    throw error;
  }
}

/**
 * Save all general settings at once
 */
export async function saveGeneralSettings(settings: Record<string, unknown>) {
  // First, get existing settings to merge with new ones.
  // CRITICAL: If we can't load existing settings, abort the save to prevent
  // sending partial settings that would wipe out unrelated fields in the backend.
  let existingSettings: Record<string, unknown>;
  try {
    existingSettings = await getGeneralSettings();
  } catch (error) {
    console.warn('Could not load existing settings, aborting save to prevent data loss:', error);
    throw error;
  }
  if (!existingSettings || Object.keys(existingSettings).length === 0) {
    console.warn('Existing settings are empty, aborting save to prevent data loss');
    return;
  }

  try {
    // Build the complete settings object by starting with existing settings
    // and only overriding with new values that are explicitly provided AND different
    const completeSettings = { ...existingSettings };

    // Only add fields that are explicitly provided AND different from existing values
    if (
      settings.enableLinks !== undefined &&
      settings.enableLinks !== existingSettings.enable_links
    ) {
      completeSettings.enable_links = settings.enableLinks;
    }
    if (
      settings.proxyAddress !== undefined &&
      settings.proxyAddress !== existingSettings.proxy_address
    ) {
      completeSettings.proxy_address = settings.proxyAddress;
    }
    if (
      settings.appearance !== undefined &&
      settings.appearance !== existingSettings.appearance
    ) {
      completeSettings.appearance = settings.appearance;
    }
    if (
      settings.accentColor !== undefined &&
      settings.accentColor !== existingSettings.accent_color
    ) {
      completeSettings.accent_color = settings.accentColor;
    }

    // Simple approach: read localStorage directly for anonymous accent color during login
    const justLoggedIn = sessionStorage.getItem('just_logged_in');
    if (justLoggedIn) {
      try {
        const scrapalotPrefs = localStorage.getItem('scrapalot_user_prefs');
        if (scrapalotPrefs) {
          const prefs = JSON.parse(scrapalotPrefs);

          // Check if anonymous user set an accent color
          if (
            prefs.accentColorAnonymous &&
            prefs.accentColorAnonymousUserSet &&
            ['gray', 'blue', 'green', 'red', 'violet', 'orange'].includes(
              prefs.accentColorAnonymous
            )
          ) {
            completeSettings.accent_color = prefs.accentColorAnonymous;

            // Update localStorage to reflect the new user setting
            prefs.accentColor = prefs.accentColorAnonymous;
            localStorage.setItem('scrapalot_user_prefs', JSON.stringify(prefs));
          }

          // Check if anonymous user set a theme
          if (
            prefs.themeAnonymous &&
            prefs.themeAnonymous !== 'dark' &&
            ['light', 'system'].includes(prefs.themeAnonymous)
          ) {
            completeSettings.appearance = prefs.themeAnonymous;

            // Update localStorage to reflect the new user setting
            prefs.theme = prefs.themeAnonymous;
            localStorage.setItem('scrapalot_user_prefs', JSON.stringify(prefs));
          }
        }
      } catch (error) {
        console.warn(
          'Error reading anonymous settings from localStorage:',
          error
        );
      }
    }
    if (
      settings.fontStyle !== undefined &&
      settings.fontStyle !== existingSettings.font_style
    ) {
      completeSettings.font_style = settings.fontStyle;
    }
    if (
      settings.codeTheme !== undefined &&
      settings.codeTheme !== existingSettings.code_theme
    ) {
      completeSettings.code_theme = settings.codeTheme;
    }
    if (
      settings.fontSize !== undefined &&
      settings.fontSize !== existingSettings.font_size
    ) {
      completeSettings.font_size = settings.fontSize;
    }
    if (
      settings.showReasoningIndicators !== undefined &&
      settings.showReasoningIndicators !==
      existingSettings.show_reasoning_indicators
    ) {
      completeSettings.show_reasoning_indicators =
        settings.showReasoningIndicators;
    }
    if (
      settings.rag_strategy !== undefined &&
      settings.rag_strategy !== existingSettings.rag_strategy
    ) {
      completeSettings.rag_strategy = settings.rag_strategy;
    }
    if (
      settings.rag_orchestrator !== undefined &&
      settings.rag_orchestrator !== existingSettings.rag_orchestrator
    ) {
      completeSettings.rag_orchestrator = settings.rag_orchestrator;
    }
    if (
      settings.use_orchestrator !== undefined &&
      settings.use_orchestrator !== existingSettings.use_orchestrator
    ) {
      completeSettings.use_orchestrator = settings.use_orchestrator;
    }
    if (
      settings.agentic_rag_enabled !== undefined &&
      settings.agentic_rag_enabled !== existingSettings.agentic_rag_enabled
    ) {
      completeSettings.agentic_rag_enabled = settings.agentic_rag_enabled;
    }
    // Handle use_agentic_routing (maps to same backend field as agentic_rag_enabled)
    if (
      settings.use_agentic_routing !== undefined &&
      settings.use_agentic_routing !== existingSettings.use_agentic_routing
    ) {
      completeSettings.use_agentic_routing = settings.use_agentic_routing;
    }
    if (
      settings.response_length !== undefined &&
      settings.response_length !== existingSettings.response_length
    ) {
      completeSettings.response_length = settings.response_length;
    }
    // Simple Mode Toggle
    if (
      settings.simple_mode_enabled !== undefined &&
      settings.simple_mode_enabled !== existingSettings.simple_mode_enabled
    ) {
      completeSettings.simple_mode_enabled = settings.simple_mode_enabled;
    }
    // Knowledge agent profile slug
    if (
      settings.default_agent_profile_slug !== undefined &&
      settings.default_agent_profile_slug !== existingSettings.default_agent_profile_slug
    ) {
      completeSettings.default_agent_profile_slug = settings.default_agent_profile_slug;
    }
    // Response Personalization
    if (
      settings.response_formality !== undefined &&
      settings.response_formality !== existingSettings.response_formality
    ) {
      completeSettings.response_formality = settings.response_formality;
    }
    if (
      settings.response_domain_focus !== undefined &&
      settings.response_domain_focus !== existingSettings.response_domain_focus
    ) {
      completeSettings.response_domain_focus = settings.response_domain_focus;
    }
    if (
      settings.voice_openai_api_key !== undefined &&
      settings.voice_openai_api_key !== existingSettings.voice_openai_api_key
    ) {
      completeSettings.voice_openai_api_key = settings.voice_openai_api_key;
    }
    if (
      settings.voice_wake_word !== undefined &&
      settings.voice_wake_word !== existingSettings.voice_wake_word
    ) {
      completeSettings.voice_wake_word = settings.voice_wake_word;
    }
    if (
      settings.voice_wake_word_enabled !== undefined &&
      settings.voice_wake_word_enabled !== existingSettings.voice_wake_word_enabled
    ) {
      completeSettings.voice_wake_word_enabled = settings.voice_wake_word_enabled;
    }
    if (
      settings.voice_speed !== undefined &&
      settings.voice_speed !== existingSettings.voice_speed
    ) {
      completeSettings.voice_speed = settings.voice_speed;
    }
    if (
      settings.rag_augmentation !== undefined &&
      settings.rag_augmentation !== existingSettings.rag_augmentation
    ) {
      completeSettings.rag_augmentation = settings.rag_augmentation;
    }
    if (
      settings.renderingModules !== undefined &&
      JSON.stringify(settings.renderingModules) !==
      JSON.stringify(existingSettings.rendering_modules)
    ) {
      completeSettings.rendering_modules = settings.renderingModules;
    }
    if (
      settings.language !== undefined &&
      settings.language !== existingSettings.language
    ) {
      completeSettings.language = settings.language;
    }

    console.log('📤 Sending to backend:', {
      use_agentic_routing: completeSettings.use_agentic_routing,
      rag_strategy: completeSettings.rag_strategy,
      rag_orchestrator: completeSettings.rag_orchestrator,
      use_orchestrator: completeSettings.use_orchestrator,
    });

    const response = await api.post(`${apiUrls.settings}/settings_general`, {
      value: completeSettings,
    });

    // Update the cache with the new settings to ensure consistency.
    // Two caches must be invalidated (CLAUDE.md frontend rule #4):
    //   - api-utils memoryCache (300 s) — refreshed below
    //   - api.ts responseCache (60 s, axios interceptor) — would otherwise
    //     keep returning the pre-save GET response on the next reopen,
    //     silently masking just-saved fields.
    setCacheData('general-settings', completeSettings, API_CONFIG.CACHE_TTL);
    // Two axios entries that the Settings dialog reads on reopen:
    //   /settings/settings_general — direct general-settings GET
    //   /settings/                 — getUserSettings(), the actual one
    //                                settings.tsx loadInitialSettings()
    //                                calls. Without busting this one
    //                                too, the dialog reopens with the
    //                                pre-save body for up to 60 s.
    clearCache('/settings/settings_general');
    clearCache('/settings/');

    return response.data;
  } catch (error) {
    console.error('Error saving general settings:', error);
    throw error;
  }
}

/**
 * Get all general settings
 */
export async function getGeneralSettings() {
  const cacheKey = 'general-settings';

  // Check cache first
  const cachedData = checkCacheValidity<Record<string, unknown>>(cacheKey, false, false, API_CONFIG.CACHE_TTL);
  if (cachedData) {
    return cachedData;
  }

  try {
    // Get general settings directly from the same endpoint we use it for saving
    const response = await api.get(`${apiUrls.settings}/settings_general`);

    // Process the response to convert a backend format to a frontend format
    // Note: /settings/settings_general returns the setting_value object
    let generalSettings = response.data?.setting_value || response.data || {};

    // Ensure generalSettings is an object, not a string
    if (typeof generalSettings === 'string') {
      try {
        generalSettings = JSON.parse(generalSettings);
      } catch (parseError) {
        console.error(
          'Failed to parse generalSettings JSON string:',
          parseError
        );
        generalSettings = {};
      }
    }

    // Remove nested settings_general to prevent duplication
    const cleanSettings = removeNestedSettingsGeneral(generalSettings);

    // Cache the result using shared utilities
    setCacheData(cacheKey, cleanSettings, API_CONFIG.CACHE_TTL);

    return cleanSettings;
  } catch (error) {
    console.error('Error fetching general settings:', error);

    // Try to return cached data on error
    const fallbackData = checkCacheValidity<Record<string, unknown>>(cacheKey, false, false, API_CONFIG.CACHE_TTL * 2); // Extended TTL for error fallback
    if (fallbackData) {
      return fallbackData;
    }

    throw error;
  }
}

/**
 * Helper function to remove nested settings_general objects to prevent duplication
 */
function removeNestedSettingsGeneral(settings: Record<string, unknown>): Record<string, unknown> {
  if (!settings || typeof settings !== 'object') {
    return settings;
  }

  // Create a shallow copy of the settings object
  const result = { ...settings };

  // Remove the settings_general property if it exists
  if (result.settings_general) {
    delete result.settings_general;
  }

  // Process all other properties recursively
  Object.keys(result).forEach(key => {
    if (typeof result[key] === 'object' && result[key] !== null) {
      result[key] = removeNestedSettingsGeneral(result[key] as Record<string, unknown>);
    }
  });

  return result;
}

/**
 * Get all available RAG strategies
 */
export async function getRagStrategies() {
  try {
    // Always return an empty array for now to ensure translated fallbacks are used
    return [];

    /*
        // Check if we have a valid cache
        const now = Date.now();
        if (ragStrategiesCache.length > 0 && (now - ragStrategiesCacheTime < CACHE_TTL)) {
            return ragStrategiesCache;
        }

        const response = await api.get(`${apiUrls.settings}/rag-strategies`);

        // Cache the result
        ragStrategiesCache = response.data || [];
        ragStrategiesCacheTime = now;

        return ragStrategiesCache;
        */
  } catch (error) {
    console.error('Error fetching RAG strategies:', error);
    // Return an empty array on error
    return [];
  }
}

/**
 * Get model providers from a settings API
 * Returns array of providers only (no longer returns a full UserSettings object)
 */
export async function getModelProviders(
  page: number = 1,
  limit: number = 50,
  _providerId?: string
) {
  try {
    // Build query parameters
    const params = new URLSearchParams();
    params.append('page', page.toString());
    params.append('limit', limit.toString());
    // TEMPORARILY DISABLED: provider_id parameter causes backend pagination bug
    // The backend returns incorrect pagination for non-matching providers
    // if (providerId) {
    //   params.append('provider_id', providerId);
    // }

    const response = await api.get(`${apiUrls.settings}/providers?${params.toString()}`);

    // Handle response structure - data is directly unpacked in response.data
    if (response.data && typeof response.data === 'object') {
      // Check if response.data itself is an array (providers are directly in response.data)
      if (Array.isArray(response.data)) {
        // Add iconSrc to each provider
        return response.data.map(provider => {
          const iconSrc = getIconForProvider(provider.provider_type);
          return {
            ...provider,
            iconSrc: iconSrc,
          };
        });
      }
    }

    console.warn('Providers data not found in expected format:', response.data);
    return [];
  } catch (error) {
    // Axios error handling might differ slightly, check error.response
    const status = error.response?.status;
    const statusText = error.response?.statusText;
    console.error(`Failed to fetch providers: ${status} ${statusText}`, error);

    // Check if it's a connection error (server not running)
    const isConnectionError = !error.response && (
      error.code === 'ERR_NETWORK' ||
      error.code === 'ERR_CONNECTION_REFUSED' ||
      error.message?.includes('ERR_CONNECTION_REFUSED') ||
      error.message?.includes('Network Error') ||
      error.message?.includes('Failed to fetch')
    );

    if (isConnectionError) {
      // Re-throw connection errors so components can handle them appropriately
      const connectionError = new Error('Backend server not responding. Please check if the server is running.');
      connectionError.name = 'ConnectionError';
      throw connectionError;
    }

    // Check if it's an authentication error
    if (status === 401) {
      console.error(
        'Authentication error when fetching providers. User might not be logged in.'
      );
    }

    // Error might already be handled by interceptor, but return [] as fallback for other errors
    return [];
  }
}

/**
 * Create a new model provider
 */
export async function createModelProvider(provider: Record<string, unknown>) {
  // Declare fullUrl outside the try/catch, so it's accessible in both blocks

  try {
    const response = await api.post(apiUrls.modelProviders, provider);
    return response.data;
  } catch (error) {
    console.error('❌ Error creating model provider:', error);
    console.error(
      '📋 Provider data that failed:',
      JSON.stringify(provider, null, 2)
    );
    if (error.response) {
      console.error('🔍 Response status:', error.response.status);
      console.error('🔍 Response data:', error.response.data);
    }
    throw error;
  }
}

/**
 * Update an existing model provider
 */
export async function updateModelProvider(providerId: string, provider: Record<string, unknown>) {
  try {
    const response = await api.put(
      `${apiUrls.settings}/providers/${providerId}`,
      provider
    );
    return response.data;
  } catch (error) {
    console.error('❌ Error updating model provider:', error);
    console.error(
      '📋 Provider data that failed:',
      JSON.stringify(provider, null, 2)
    );
    if (error.response) {
      console.error('🔍 Response status:', error.response.status);
      console.error('🔍 Response data:', error.response.data);
    }
    throw error;
  }
}

/**
 * Delete a model provider
 */
export async function deleteModelProvider(providerId: string) {
  try {
    const response = await api.delete(
      `${apiUrls.settings}/providers/${providerId}`
    );
    return response.data;
  } catch (error) {
    console.error(`❌ API: Error deleting provider ${providerId}:`, error);
    if (error.response) {
      console.error('🔍 Response status:', error.response.status);
      console.error('🔍 Response data:', error.response.data);
    }
    throw error;
  }
}

/**
 * Get service logs with filtering options
 */
export async function getLocalServiceLogs(
  lines: number = 200,
  autoSync: boolean = false,
  level?: string,
  timeRange?: string
) {
  try {
    const params = new URLSearchParams({
      lines: lines.toString(),
      auto_sync: autoSync.toString(),
    });

    if (level && level !== 'ALL') {
      params.append('level', level);
    }

    if (timeRange && timeRange !== 'all') {
      params.append('time_range', timeRange);
    }

    const response = await api.get(
      `${apiUrls.settings}/service-logs?${params.toString()}`
    );
    return {
      logs: response.data.logs || 'No logs available',
      autoSyncEnabled: response.data.auto_sync_enabled || false,
      autoSyncDefault: response.data.auto_sync_default || false,
      linesRequested: response.data.lines_requested || lines,
      linesReturned: response.data.lines_returned || 0,
      totalLinesBeforeFilter: response.data.total_lines_before_filter || 0,
      totalLinesProcessed: response.data.total_lines_processed || 0,
      linesFilteredByLevel: response.data.lines_filtered_by_level || 0,
      fileExists: response.data.file_exists || false,
      timestamp: response.data.timestamp,
      levelFilter: response.data.level_filter,
      timeRangeFilter: response.data.time_range_filter,
    };
  } catch (error) {
    console.error('Error fetching service logs:', error);
    return {
      logs: 'Failed to fetch service logs. The server may not support this feature.',
      autoSyncEnabled: false,
      autoSyncDefault: false,
      linesRequested: lines,
      linesReturned: 0,
      totalLinesBeforeFilter: 0,
      totalLinesProcessed: 0,
      linesFilteredByLevel: 0,
      fileExists: false,
      timestamp: new Date().toISOString(),
      levelFilter: level,
      timeRangeFilter: timeRange,
    };
  }
}

/**
 * Get logs for an arbitrary Docker container (admin only).
 * Backed by `/admin/debug/docker/containers/{containerName}/logs`, which calls
 * `docker logs --tail N --timestamps`. Only `level=ERROR|WARN` is honoured by
 * the backend filter; any other value is treated as unfiltered. The backend
 * does NOT support a time-range parameter for container logs, so the caller
 * should not pass one.
 */
export async function getDockerContainerLogs(
  containerName: string,
  lines: number = 200,
  level?: string
) {
  try {
    const params = new URLSearchParams({
      tail_lines: lines.toString(),
    });
    const mappedLevel =
      !level || level === 'ALL'
        ? 'all'
        : level === 'WARNING'
          ? 'WARN'
          : level === 'ERROR'
            ? 'ERROR'
            : 'all';
    params.append('level', mappedLevel);

    const response = await api.get(
      `/admin/debug/docker/containers/${encodeURIComponent(containerName)}/logs?${params.toString()}`
    );
    return {
      logs: response.data?.logs || 'No logs available',
      errorCount: response.data?.error_count ?? 0,
      warningCount: response.data?.warning_count ?? 0,
      filteredBy: response.data?.filtered_by ?? null,
    };
  } catch (error) {
    console.error('Error fetching container logs:', error);
    return {
      logs: `Failed to fetch logs for ${containerName}.`,
      errorCount: 0,
      warningCount: 0,
      filteredBy: null,
    };
  }
}

/**
 * Get the user's selected model from user_settings table
 */
export async function getDefaultModel() {
  try {
    const response = await api.get(`${apiUrls.settings}/selected_model`);
    if (response.data && response.data.setting_value) {
      const settingValue = response.data.setting_value;
      return {
        // Handle both a new format (model_id) and old format (model) for backward compatibility
        model: settingValue.model_id || settingValue.model,
        model_name: settingValue.model_name,
        provider_type: settingValue.provider_type,
      };
    }
    return null;
  } catch (error) {
    console.error('Error fetching selected model:', error);
    return null;
  }
}

/**
 * Save the user's selected model to user_settings table
 */
export async function saveSelectedModel(
  modelId: string,
  modelName?: string,
  providerType?: string,
  _fullModelData?: Record<string, unknown>
) {
  // Validate inputs - never allow empty model names
  if (!modelName || modelName.trim() === '') {
    throw new Error('Model name cannot be empty when saving selected model');
  }

  try {
    // Always use the simple format with proper value wrapping
    const data = {
      value: {
        model_id: modelId, // Use model_id directly
        model_name: modelName, // Must be a valid non-empty model name
        provider_type: providerType,
      },
    };
    const response = await api.post(`${apiUrls.settings}/selected_model`, data);
    return response.data;
  } catch (error: unknown) {
    console.error('Error saving selected model:', error);

    // Provide more detailed error information
    if (axios.isAxiosError(error) && error.response) {
      console.error('Response status:', error.response.status);
      console.error('Response data:', error.response.data);

      // Handle specific error cases
      if (error.response.status === 400) {
        console.error('Bad request - check data format. ModelId:', modelId, 'ModelName:', modelName, 'ProviderType:', providerType);
      } else if (error.response.status === 401) {
        console.error('Authentication error - user may not be logged in');
      }
    }

    // Don't show toast error for this as it's not critical
    throw error;
  }
}

/**
 * Export provider configurations as JSON
 */
export async function exportProviderConfigurations() {
  try {
    const response = await api.get(`${apiUrls.settings}/providers/export`, {
      responseType: 'blob',
    });

    // Create a download link
    const url = window.URL.createObjectURL(response.data);
    const link = document.createElement('a');
    link.href = url;
    link.download = `scrapalot-providers-${new Date().toISOString().split('T')[0]}.json`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    window.URL.revokeObjectURL(url);

    return { success: true, message: 'Configuration exported successfully' };
  } catch (error) {
    console.error('Error exporting provider configurations:', error);
    throw error;
  }
}

/**
 * Import provider configurations from JSON file
 */
export async function importProviderConfigurations(file: File) {
  try {
    const formData = new FormData();
    formData.append('file', file);

    const response = await api.post(
      `${apiUrls.settings}/providers/import`,
      formData,
      {
        headers: {
          'Content-Type': 'multipart/form-data',
        },
      }
    );

    return response.data;
  } catch (error) {
    console.error('Error importing provider configurations:', error);
    throw error;
  }
}


/**
 * Get providers that support embedding models
 * This is a filtered version of getModelProviders that only returns providers with embedding models
 */
export async function getEmbeddingProviders() {
  try {
    // Get all providers first
    const allProviders = await getModelProviders();

    // Filter providers that have embedding models
    return allProviders.filter(provider => {
      return provider.models && provider.models.some(model =>
        model.model_type === 'EMBEDDING' ||
        model.model_name?.toLowerCase().includes('embed') ||
        model.display_name?.toLowerCase().includes('embed')
      );
    });
  } catch (error) {
    console.error('Error fetching embedding providers:', error);
    return [];
  }
}

/**
 * Get comprehensive service status information
 */
export async function getServiceStatus() {
  try {
    const response = await api.get(`${apiUrls.settings}/service-status`);
    return response.data;
  } catch (error) {
    console.error('Error fetching service status:', error);
    // Return default values if API call fails
    return {
      service_name: 'ScrapalotChat FastAPI',
      version: '1.0.0',
      status: 'unknown',
      running: false,
      api_base: 'http://localhost:8090',
      host: 'localhost',
      port: 8090,
      models_directory: 'models',
      uptime_seconds: 0,
      uptime_human: '0h 0m 0s',
      process_id: null,
      memory_usage: {
        rss_mb: 0,
        vms_mb: 0,
      },
      cpu_percent: 0,
      system_info: {},
      timestamp: new Date().toISOString(),
    };
  }
}

// =============================================================================
// SYSTEM RESOURCE MONITORING
// =============================================================================

export interface ContainerResourceStats {
  name: string;
  state: 'RUNNING' | 'STOPPED' | 'PAUSED' | 'RESTARTING' | 'DEAD';
  cpu_percent: number;
  memory_percent: number;
  memory_usage_mb: number;
  memory_limit_mb: number;
  cpu_limit: number | null;
  pids: number;
  uptime: string;
}

export interface SystemStatsResponse {
  memory_total_mb: number;
  memory_used_mb: number;
  memory_percent: number;
  cpu_count: number;
  load_average1m: number;
  load_average5m: number;
  load_average15m: number;
  disk_used_gb: number;
  disk_total_gb: number;
  disk_percent: number;
}

export interface SystemResourceOverview {
  containers: ContainerResourceStats[];
  system: SystemStatsResponse;
  total_allocated_memory_mb: number;
  physical_memory_mb: number;
  overcommit_warning: boolean;
}

/**
 * Get Docker container resource stats and system overview (admin only)
 */
export async function getContainerResources(): Promise<SystemResourceOverview> {
  try {
    const response = await api.get('/admin/debug/docker/resources');
    return response.data;
  } catch (error) {
    console.error('Error fetching container resources:', error);
    return {
      containers: [],
      system: {
        memory_total_mb: 0,
        memory_used_mb: 0,
        memory_percent: 0,
        cpu_count: 0,
        load_average1m: 0,
        load_average5m: 0,
        load_average15m: 0,
        disk_used_gb: 0,
        disk_total_gb: 0,
        disk_percent: 0,
      },
      total_allocated_memory_mb: 0,
      physical_memory_mb: 0,
      overcommit_warning: false,
    };
  }
}

export interface UpdateContainerLimitsRequest {
  memory_limit_mb?: number;
  cpu_limit?: number;
  restart?: boolean;
}

export interface UpdateContainerLimitsResponse {
  container_name: string;
  success: boolean;
  message: string;
  new_memory_limit_mb?: number;
  new_cpu_limit?: number;
}

/**
 * Update container resource limits (admin only)
 */
export async function updateContainerLimits(
  containerName: string,
  request: UpdateContainerLimitsRequest
): Promise<UpdateContainerLimitsResponse> {
  try {
    const response = await api.put(
      `/admin/debug/docker/resources/${containerName}`,
      request
    );
    return response.data;
  } catch (error) {
    console.error('Error updating container limits:', error);
    return {
      container_name: containerName,
      success: false,
      message: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

/**
 * Save selected collections for a specific session
 */
export async function saveSelectedCollections(
  sessionId: string,
  collectionIds: string[],
  similarity?: number,
  numChunks?: number
) {
  try {
    const data = {
      value: {
        session_id: sessionId,
        collection_ids: collectionIds,
        similarity_threshold: similarity || 0.5,
        num_chunks: numChunks || 15,
        updated_at: new Date().toISOString(),
      },
    };

    const response = await api.post(`${apiUrls.settings}/selected_collections`, data);
    return response.data;
  } catch (error) {
    console.error('Error saving selected collections:', error);
    throw error;
  }
}

// =============================================================================
// SYSTEM AGENT CONFIG (Admin Only)
// =============================================================================

/**
 * Optional second model for "Scrapalot AI": the free-text synthesis/answer model
 * (e.g. DeepSeek V4-Flash). The base block above stays the agent model
 * (gpt-4o-mini) used for tool-calling agents; this block generates the
 * user-facing RAG answer + the model-insight reflection.
 */
export interface SystemSynthesisConfig {
  provider_type: string;
  model_name: string;
  api_base?: string;
  api_key?: string;
  has_api_key?: boolean;
}

export interface SystemAgentConfig {
  provider_type: string;
  model_name: string;
  api_key?: string;
  api_base?: string;
  has_api_key?: boolean;
  config_json?: string;
  model_overrides?: Record<string, string>;
  synthesis?: SystemSynthesisConfig;
}

/**
 * Get the system agent LLM configuration (admin only).
 * This is the LLM used by all internal Pydantic AI agents (strategy router, synthesis, etc.)
 */
export async function getSystemAgentConfig(): Promise<SystemAgentConfig> {
  try {
    const response = await api.get(`${apiUrls.settings}/system-agent-config`);
    const data = response.data;

    // Parse config_json if present
    let modelOverrides: Record<string, string> = {};
    let synthesis: SystemSynthesisConfig | undefined;
    if (data.config_json) {
      try {
        const parsed = JSON.parse(data.config_json);
        modelOverrides = parsed.model_overrides || {};
        if (parsed.synthesis && parsed.synthesis.model_name) {
          synthesis = {
            provider_type: parsed.synthesis.provider_type || '',
            model_name: parsed.synthesis.model_name || '',
            api_base: parsed.synthesis.api_base || '',
            has_api_key: parsed.synthesis.has_api_key || false,
          };
        }
      } catch {
        // ignore parse errors
      }
    }

    return {
      provider_type: data.provider_type || 'openai',
      model_name: data.model_name || 'gpt-4o-mini',
      api_base: data.api_base || '',
      has_api_key: data.has_api_key || false,
      model_overrides: modelOverrides,
      synthesis,
    };
  } catch (error) {
    console.error('Error fetching system agent config:', error);
    return {
      provider_type: 'openai',
      model_name: 'gpt-4o-mini',
      api_base: '',
      has_api_key: false,
      model_overrides: {},
    };
  }
}

/**
 * Save the system agent LLM configuration (admin only).
 */
export async function saveSystemAgentConfig(config: SystemAgentConfig): Promise<void> {
  const body: Record<string, string> = {
    provider_type: config.provider_type,
    model_name: config.model_name,
    api_key: config.api_key || '',
    api_base: config.api_base || '',
  };

  const configJson: Record<string, unknown> = {};
  if (config.model_overrides) {
    configJson.model_overrides = config.model_overrides;
  }
  if (config.synthesis && config.synthesis.model_name) {
    // The synthesis (answer) model rides inside config_json — no proto change.
    // api_key is sent only when the admin typed a new one; an empty key is
    // omitted so the backend preserves the stored DeepSeek key.
    const syn: Record<string, string> = {
      provider_type: config.synthesis.provider_type || '',
      model_name: config.synthesis.model_name || '',
      api_base: config.synthesis.api_base || '',
    };
    if (config.synthesis.api_key) {
      syn.api_key = config.synthesis.api_key;
    }
    configJson.synthesis = syn;
  }
  if (Object.keys(configJson).length > 0) {
    body.config_json = JSON.stringify(configJson);
  }

  await api.put(`${apiUrls.settings}/system-agent-config`, body);
}

// --- Speech Config (STT + TTS) ---

export interface SpeechConfig {
  stt_provider: string;
  stt_model: string;
  tts_provider: string;
  tts_default_voice: string;
  stt_api_key?: string;
  elevenlabs_api_key?: string;
  has_stt_api_key?: boolean;
  has_elevenlabs_key?: boolean;
}

export async function getSpeechConfig(): Promise<SpeechConfig> {
  try {
    const response = await api.get(`${apiUrls.settings}/speech-config`);
    const data = response.data;
    return {
      stt_provider: data.stt_provider || 'openai',
      stt_model: data.stt_model || 'whisper-1',
      tts_provider: data.tts_provider || 'edge',
      tts_default_voice: data.tts_default_voice || '',
      has_stt_api_key: data.has_stt_api_key || false,
      has_elevenlabs_key: data.has_elevenlabs_key || false,
    };
  } catch (error) {
    console.error('Error fetching speech config:', error);
    return {
      stt_provider: 'openai',
      stt_model: 'whisper-1',
      tts_provider: 'edge',
      tts_default_voice: '',
      has_stt_api_key: false,
      has_elevenlabs_key: false,
    };
  }
}

export async function saveSpeechConfig(config: SpeechConfig): Promise<void> {
  await api.put(`${apiUrls.settings}/speech-config`, {
    stt_provider: config.stt_provider,
    stt_model: config.stt_model,
    tts_provider: config.tts_provider,
    tts_default_voice: config.tts_default_voice,
    stt_api_key: config.stt_api_key || '',
    elevenlabs_api_key: config.elevenlabs_api_key || '',
  });
}

// =============================================================================
// NOTES EDITOR PREFERENCES
// =============================================================================

export type NotesEditorOrientation = 'portrait' | 'landscape';
/** ISO paper size; controls print output + page-break visualization. */
export type NotesPaperSize = 'A4' | 'A3' | 'A5';
/** Screen page width independent of paper size. Migration 116
 *  extended the original `paper | wide` set with `narrow` and `full`
 *  so the page-head Page-width control matches the Confluence preset
 *  list (Narrow / Default / Wide / Full). Mapping:
 *    - `narrow` → ~520 px max (focused writing)
 *    - `paper`  → matches the chosen paper width (Default — legacy)
 *    - `wide`   → fills the drawer up to a sane cap
 *    - `full`   → 100 % of the available drawer
 *  Wide / Full never affect printed output — the PDF still reflows
 *  to the chosen paper format. */
export type NotesScreenWidth = 'paper' | 'wide' | 'full';

export interface NotesEditorPreferences {
  /** Deprecated — kept optional so legacy rows still parse, but the
   *  UI removed per-side margin controls. New saves omit them. */
  left_margin?: number;
  right_margin?: number;
  orientation: NotesEditorOrientation;
  /** Defaults to 'A4' for rows persisted before the layout-popover
   *  feature shipped. */
  paper_size?: NotesPaperSize;
  /** Defaults to 'paper' for the same reason. */
  screen_width?: NotesScreenWidth;
}

const NOTES_EDITOR_PREFS_KEY = 'notes_editor_preferences';

export async function getNotesEditorPreferences(): Promise<NotesEditorPreferences | null> {
  try {
    // A missing preferences row is the normal "never customised" state, not an
    // error — tell the global interceptor not to log the 404 as a failure.
    const response = await api.get(
      `${apiUrls.settings}/user/${NOTES_EDITOR_PREFS_KEY}`,
      { _silentStatuses: [404] } as Parameters<typeof api.get>[1],
    );
    const value = response.data?.setting_value ?? response.data?.settingValue ?? null;
    if (!value) return null;
    // Per-side margins are deprecated; if they're present we surface
    // them, but their absence MUST NOT discard the row. Earlier
    // versions returned `null` here whenever left/right wasn't a
    // finite number — that meant every refresh after the ruler removal
    // silently threw away the user's screen_width / paper_size choices
    // and the toolbar reset to defaults on next mount.
    const left = Number(value.left_margin);
    const right = Number(value.right_margin);
    const orientation: NotesEditorOrientation =
      value.orientation === 'landscape' ? 'landscape' : 'portrait';
    const paperSize: NotesPaperSize | undefined =
      value.paper_size === 'A3' || value.paper_size === 'A5' || value.paper_size === 'A4'
        ? value.paper_size
        : undefined;
    const screenWidth: NotesScreenWidth | undefined =
      value.screen_width === 'paper' ||
      value.screen_width === 'wide' ||
      value.screen_width === 'full'
        ? (value.screen_width as NotesScreenWidth)
        : undefined;
    return {
      left_margin: Number.isFinite(left) ? left : undefined,
      right_margin: Number.isFinite(right) ? right : undefined,
      orientation,
      paper_size: paperSize,
      screen_width: screenWidth,
    };
  } catch (error: unknown) {
    const status = axios.isAxiosError(error) ? error.response?.status : undefined;
    if (status !== 404) {
      console.error('Error fetching notes editor preferences:', error);
    }
    return null;
  }
}

export async function saveNotesEditorPreferences(prefs: NotesEditorPreferences): Promise<void> {
  try {
    // Build the body explicitly so deprecated margin fields only
    // tag along when the caller actually still passes them. Sending
    // `undefined` would JSON-serialize to nothing anyway, but it
    // surfaces clearer in network logs and stops a future linter
    // from "fixing" it back to a required field.
    const body: Record<string, unknown> = {
      orientation: prefs.orientation,
      paper_size: prefs.paper_size ?? 'A4',
      screen_width: prefs.screen_width ?? 'paper',
    };
    if (typeof prefs.left_margin === 'number') body.left_margin = prefs.left_margin;
    if (typeof prefs.right_margin === 'number') body.right_margin = prefs.right_margin;
    await api.put(`${apiUrls.settings}/user/${NOTES_EDITOR_PREFS_KEY}`, body);
  } catch (error) {
    console.error('Error saving notes editor preferences:', error);
  }
}

