/**
 * Consolidated localStorage utility for scrapalot-chat
 * Reduces localStorage key clutter by grouping related data
 */

// Storage keys
const STORAGE_KEYS = {
  // User preferences
  USER_PREFS: 'scrapalot_user_prefs',

  // Model selections
  MODEL_SELECTIONS: 'scrapalot_model_selections',

  // UI state
  UI_STATE: 'scrapalot_ui_state',

  // Cache data
  CACHE_DATA: 'scrapalot_cache_data',

  // Settings
  SETTINGS: 'scrapalot_settings',

  // PDF reading positions cache
  PDF_POSITIONS: 'scrapalot_pdf_positions',

  // EPUB reading positions cache
  EPUB_POSITIONS: 'scrapalot_epub_positions',
} as const;

// Cache TTL (time to live) in milliseconds
const DEFAULT_CACHE_TTL = 5 * 60 * 1000; // 5 minutes
const MODEL_SELECTION_TTL = 30 * 24 * 60 * 60 * 1000; // 30 days for model selections

interface CacheItem<T> {
  data: T;
  expiry: number;
}

interface UserPreferences {
  theme?: string;
  themeAnonymous?: string;
  // "AI thinking" toggle — mirrored to localStorage so the chat send path can
  // read it synchronously and request the thinking-model reflection.
  showReasoningIndicators?: boolean;
  // Show prominent top-right popups for admin messages (vs bell-only). Per-device.
  admin_messages_toast_enabled?: boolean;
  language?: string;
  fontSize?: number;
  codeTheme?: string;
  sidebarWidth?: number;
  chatPanelWidth?: number;
  chatMembersPanelWidth?: number;
  chatPanelHeight?: number;
  chatPanelLeft?: number;
  chatPanelTop?: number;
  chatPanelMode?: 'floating' | 'pinned-left' | 'pinned-right' | 'maximized';
  remember_session?: boolean;
  saved_username?: string;
  accentColor?: string;
  fontStyle?: string;
  autoTitleGenerate?: string;
  enableLinks?: boolean;
  proxyAddress?: string;
  ragStrategy?: string;
  renderingModules?: string[];
  // Document view mode preferences
  documentViewMode?: 'list' | 'details' | 'thumbnails';
  documentSortField?: 'name' | 'date' | 'size' | 'type' | 'status';
  documentSortDirection?: 'asc' | 'desc';
  // TTS voice preferences
  ttsVoiceName?: string;
  ttsVoiceLang?: string;
  ttsRate?: number;
  // Session folder expand/collapse state
  folderExpandState?: Record<string, boolean>;
}

interface ModelSelections {
  model_id?: string;        // UUID from Model.id
  model_name?: string;      // API identifier (required)
  display_name?: string;    // Optional UI display name
  provider_id?: string;
  provider_type?: string;
  lastUpdated?: number; // Timestamp for tracking storage age
  version?: string; // Version for migration compatibility
  isExpired?: boolean; // Flag to indicate if data is older than TTL
}

interface UIState {
  currentWorkspace?: Record<string, unknown>;
  currentWorkspaceUserId?: string; // owner of the cached workspace — guards against cross-user reuse on a shared device
  cachedUser?: Record<string, unknown>;
  chatModelSelectorRefreshNeeded?: boolean;
  chatModelSelectorFetching?: boolean;
  chatModelSelectorLoading?: boolean;
  lastKnowledgeCollectionId?: string | null;
  sortSessionsByMarker?: boolean;
}

interface CacheData {
  models?: CacheItem<unknown>;
  embeddingModels?: CacheItem<unknown>;
  featuredModels?: CacheItem<unknown>;
  installedModels?: CacheItem<unknown>;
  gpuStatus?: CacheItem<unknown>;
  systemCapabilities?: CacheItem<unknown>;
  userSettings?: CacheItem<unknown>;
}

interface Settings {
  i18nextLng?: string;
}

// Generic storage helpers
const getStorageItem = <T>(key: string, defaultValue: T): T => {
  try {
    const item = localStorage.getItem(key);
    return item ? JSON.parse(item) : defaultValue;
  } catch (error) {
    console.warn(`Error parsing localStorage key ${key}:`, error);
    return defaultValue;
  }
};

const setStorageItem = <T>(key: string, value: T): void => {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (error) {
    console.error(`Error setting localStorage key ${key}:`, error);
  }
};

const removeStorageItem = (key: string): void => {
  try {
    localStorage.removeItem(key);
  } catch (error) {
    console.error(`Error removing localStorage key ${key}:`, error);
  }
};

// User preferences storage
export const userPrefs = {
  get: (): UserPreferences => getStorageItem(STORAGE_KEYS.USER_PREFS, {}),

  set: (prefs: Partial<UserPreferences>): void => {
    const current = userPrefs.get();
    const updated = { ...current, ...prefs };
    setStorageItem(STORAGE_KEYS.USER_PREFS, updated);
  },

  getTheme: (): string => {
    // Check if user is authenticated by checking for valid auth tokens
    const hasValidTokens = (() => {
      try {
        // Quick sync check for tokens without importing the async function
        const tokensStr =
          sessionStorage.getItem('auth_tokens') ||
          localStorage.getItem('auth_tokens');
        return !!tokensStr && JSON.parse(tokensStr)?.access_token;
      } catch {
        return false;
      }
    })();

    if (hasValidTokens) {
      // Authenticated user - check consolidated storage first
      // Note: We no longer check user_settings as we've migrated to scrapalot_user_prefs

      // Fallback to consolidated storage theme field for authenticated users
      const theme = userPrefs.get().theme;
      if (theme && ['light', 'dark', 'system'].includes(theme)) {
        return theme;
      }
    } else {
      // Anonymous user - use themeAnonymous from scrapalot_user_prefs
      const themeAnonymous = userPrefs.getThemeAnonymous();
      if (
        themeAnonymous &&
        ['light', 'dark', 'system'].includes(themeAnonymous)
      ) {
        return themeAnonymous;
      }
    }

    // Migrate from legacy storage if needed
    try {
      const legacyTheme = localStorage.getItem('theme');
      if (legacyTheme && ['light', 'dark', 'system'].includes(legacyTheme)) {
        if (hasValidTokens) {
          userPrefs.setTheme(legacyTheme);
        } else {
          userPrefs.setThemeAnonymous(legacyTheme);
        }
        return legacyTheme;
      }
    } catch (e) {
      console.warn('Error migrating legacy theme:', e);
    }

    return 'dark';
  },

  setTheme: (theme: string): void => {
    // Check if user is authenticated by checking for valid auth tokens
    const hasValidTokens = (() => {
      try {
        const tokensStr =
          sessionStorage.getItem('auth_tokens') ||
          localStorage.getItem('auth_tokens');
        return !!tokensStr && JSON.parse(tokensStr)?.access_token;
      } catch {
        return false;
      }
    })();

    if (hasValidTokens) {
      // User is authenticated - update authenticated theme in scrapalot_user_prefs
      userPrefs.set({ theme });

      // Note: We no longer update user_settings as we use scrapalot_user_prefs
      // Backend sync happens through the API, not localStorage
    } else {
      // Anonymous user - update themeAnonymous in scrapalot_user_prefs only
      userPrefs.setThemeAnonymous(theme);
    }
  },

  getLanguage: (): string => userPrefs.get().language || 'en',
  setLanguage: (language: string): void => userPrefs.set({ language }),

  getFontSize: (): number => userPrefs.get().fontSize || 14,
  setFontSize: (fontSize: number): void => userPrefs.set({ fontSize }),

  getCodeTheme: (): string => userPrefs.get().codeTheme || 'vs-dark',
  setCodeTheme: (codeTheme: string): void => userPrefs.set({ codeTheme }),

  getSidebarWidth: (): number => userPrefs.get().sidebarWidth || 280,
  setSidebarWidth: (sidebarWidth: number): void =>
    userPrefs.set({ sidebarWidth }),

  getChatPanelWidth: (): number => userPrefs.get().chatPanelWidth || 340,
  setChatPanelWidth: (chatPanelWidth: number): void =>
    userPrefs.set({ chatPanelWidth }),

  getChatMembersPanelWidth: (): number => {
    const w = userPrefs.get().chatMembersPanelWidth ?? 260;
    return Math.min(Math.max(w, 210), 310);
  },
  setChatMembersPanelWidth: (chatMembersPanelWidth: number): void =>
    userPrefs.set({ chatMembersPanelWidth: Math.min(Math.max(chatMembersPanelWidth, 210), 310) }),

  getChatPanelHeight: (): number | null =>
    userPrefs.get().chatPanelHeight ?? null,
  setChatPanelHeight: (chatPanelHeight: number): void =>
    userPrefs.set({ chatPanelHeight }),

  getChatPanelLeft: (): number | null => userPrefs.get().chatPanelLeft ?? null,
  setChatPanelLeft: (chatPanelLeft: number): void =>
    userPrefs.set({ chatPanelLeft }),

  getChatPanelTop: (): number | null => userPrefs.get().chatPanelTop ?? null,
  setChatPanelTop: (chatPanelTop: number): void =>
    userPrefs.set({ chatPanelTop }),

  getChatPanelMode: (): 'floating' | 'pinned-left' | 'pinned-right' | 'maximized' =>
    userPrefs.get().chatPanelMode || 'floating',
  setChatPanelMode: (chatPanelMode: 'floating' | 'pinned-left' | 'pinned-right' | 'maximized'): void =>
    userPrefs.set({ chatPanelMode }),

  getRememberSession: (): boolean => userPrefs.get().remember_session ?? true,
  setRememberSession: (remember_session: boolean): void =>
    userPrefs.set({ remember_session }),

  getSavedUsername: (): string => userPrefs.get().saved_username || '',
  setSavedUsername: (saved_username: string): void =>
    userPrefs.set({ saved_username }),

  getAccentColor: (): string => userPrefs.get().accentColor || 'blue',
  setAccentColor: (accentColor: string): void => userPrefs.set({ accentColor }),

  getThemeAnonymous: (): string => userPrefs.get().themeAnonymous || 'dark',
  setThemeAnonymous: (themeAnonymous: string): void =>
    userPrefs.set({ themeAnonymous }),

  // Unified accent color management
  getCurrentAccentColor: (): string => {
    const consolidatedPrefs = userPrefs.get();

    // Always use accentColor field regardless of auth status
    if (
      consolidatedPrefs.accentColor &&
      ['gray', 'blue', 'green', 'red', 'violet', 'orange'].includes(
        consolidatedPrefs.accentColor
      )
    ) {
      return consolidatedPrefs.accentColor;
    }

    // Default for all users
    return 'blue';
  },

  setCurrentAccentColor: async (accentColor: string): Promise<void> => {
    // Check if color is already set to prevent unnecessary updates
    const currentColor = userPrefs.getAccentColor();
    if (currentColor === accentColor) {
      return;
    }

    // Always save to accentColor field regardless of auth status
    userPrefs.setAccentColor(accentColor);
    // NOTE: Backend sync is handled by the theme provider to prevent infinite loops
    // The theme provider will call the backend API through debouncedSaveSettings
  },

  getFontStyle: (): string => userPrefs.get().fontStyle || 'normal',
  setFontStyle: (fontStyle: string): void => userPrefs.set({ fontStyle }),

  getAutoTitleGenerate: (): string =>
    userPrefs.get().autoTitleGenerate || 'LOCAL',
  setAutoTitleGenerate: (autoTitleGenerate: string): void =>
    userPrefs.set({ autoTitleGenerate }),

  getEnableLinks: (): boolean => userPrefs.get().enableLinks || true,
  setEnableLinks: (enableLinks: boolean): void =>
    userPrefs.set({ enableLinks }),

  getProxyAddress: (): string => userPrefs.get().proxyAddress || '',
  setProxyAddress: (proxyAddress: string): void =>
    userPrefs.set({ proxyAddress }),

  getRagStrategy: (): string => userPrefs.get().ragStrategy || 'default',
  setRagStrategy: (ragStrategy: string): void => userPrefs.set({ ragStrategy }),

  getRenderingModules: (): string[] => userPrefs.get().renderingModules || [],
  setRenderingModules: (renderingModules: string[]): void =>
    userPrefs.set({ renderingModules }),

  // Document view mode preferences
  getDocumentViewMode: (): 'list' | 'details' | 'thumbnails' =>
    userPrefs.get().documentViewMode || 'list',
  setDocumentViewMode: (mode: 'list' | 'details' | 'thumbnails'): void =>
    userPrefs.set({ documentViewMode: mode }),

  getDocumentSortField: (): 'name' | 'date' | 'size' | 'type' | 'status' =>
    userPrefs.get().documentSortField || 'status',
  setDocumentSortField: (field: 'name' | 'date' | 'size' | 'type' | 'status'): void =>
    userPrefs.set({ documentSortField: field }),

  getDocumentSortDirection: (): 'asc' | 'desc' =>
    userPrefs.get().documentSortDirection || 'desc',
  setDocumentSortDirection: (direction: 'asc' | 'desc'): void =>
    userPrefs.set({ documentSortDirection: direction }),

  // TTS voice preferences
  getTTSVoice: (): { name?: string; lang?: string } => {
    const prefs = userPrefs.get();
    return { name: prefs.ttsVoiceName, lang: prefs.ttsVoiceLang };
  },
  setTTSVoice: (name: string, lang: string): void =>
    userPrefs.set({ ttsVoiceName: name, ttsVoiceLang: lang }),

  // TTS rate (speed) preference
  getTTSRate: (): number => {
    const prefs = userPrefs.get();
    return prefs.ttsRate || 1.0;
  },
  setTTSRate: (rate: number): void =>
    userPrefs.set({ ttsRate: rate }),

  // Migration helper: move anonymous theme to user settings
  migrateAnonymousTheme: (): string | null => {
    const anonymousTheme = userPrefs.getThemeAnonymous();
    // Only migrate if the anonymous theme exists and is not the default 'dark'
    // This prevents migrating the default dark that was set by our code
    if (
      anonymousTheme &&
      anonymousTheme !== 'dark' &&
      ['light', 'system'].includes(anonymousTheme)
    ) {
      // Clear the anonymous setting after migration
      userPrefs.set({ themeAnonymous: undefined });
      return anonymousTheme;
    }
    return null;
  },

  // Migration helper: migrate all anonymous settings to user settings on login
  migrateAnonymousSettings: (): { theme?: string; accentColor?: string } => {
    const migrationData: { theme?: string; accentColor?: string } = {};

    const anonymousTheme = userPrefs.migrateAnonymousTheme();
    if (anonymousTheme) {
      migrationData.theme = anonymousTheme;

    }

    // No longer migrate anonymous accent color since we use accentColor for everyone
    return migrationData;
  },
};

export const modelSelections = {
  get: (): ModelSelections => {
    const data = getStorageItem<ModelSelections>(
      STORAGE_KEYS.MODEL_SELECTIONS,
      {}
    );

    // Check if data is older than TTL
    if (
      data.lastUpdated &&
      Date.now() - data.lastUpdated > MODEL_SELECTION_TTL
    ) {

      // Clear expired data but keep the structure
      return {
        lastUpdated: Date.now(),
        version: '1.0',
        isExpired: true,
      };
    }

    return data;
  },

  set: (selections: Partial<ModelSelections>): void => {
    const current = modelSelections.get();

    // Migration: if we're setting new format but old format exists, clear old format
    const legacyData = getStorageItem<Record<string, unknown>>(STORAGE_KEYS.MODEL_SELECTIONS, {});
    if (
      legacyData.activeModel &&
      (selections.model_id || selections.model_name || selections.provider_id)
    ) {

      // Clear old format when setting new format
      delete legacyData.activeModel;
    }

    const updatedData = {
      ...current,
      ...legacyData, // Include any other existing data
      ...selections,
      lastUpdated: Date.now(),
      version: '1.0',
    };

    setStorageItem(STORAGE_KEYS.MODEL_SELECTIONS, updatedData);

    // Remove backup functionality as requested
    // Clean up old backup key if it exists
    try {
      removeStorageItem(`${STORAGE_KEYS.MODEL_SELECTIONS}_backup`);
    } catch (error) {
      // Silently handle error
    }

    // Remove legacy activeModel field from new storage format
    const cleanedData = { ...updatedData };
    delete cleanedData.activeModel;

    setStorageItem(STORAGE_KEYS.MODEL_SELECTIONS, cleanedData);
  },

  getActiveModel: (): string => {
    const data = modelSelections.get();

    // New format
    if (data.model_id) {
      return data.model_id;
    }

    // Backward compatibility - check for old activeModel format
    const legacyData = getStorageItem<Record<string, unknown>>(STORAGE_KEYS.MODEL_SELECTIONS, {});
    if (legacyData.activeModel && typeof legacyData.activeModel === 'string') {
      return legacyData.activeModel;
    }

    return '';
  },

  setActiveModel: (
    model_id: string,
    model_name?: string,
    provider_id?: string
  ): void => {
    const updateData: Partial<ModelSelections> = { model_id };
    if (model_name) updateData.model_name = model_name;
    if (provider_id) updateData.provider_id = provider_id;
    modelSelections.set(updateData);
  },

  // Get the full model object with backward compatibility
  getActiveModelObject: (): {
    model_id: string;
    model_name: string;
    display_name?: string;
    provider_id: string;
    provider_type?: string;
  } | null => {
    const data = modelSelections.get();

    // Validate data integrity - model_id should be UUID, model_name should be readable name
    if (data.model_id && data.model_name === data.model_id) {
      // This indicates a bug where model_name was set to UUID instead of readable name
      console.warn('🧹 Detected corrupted localStorage: model_id === model_name, clearing data');
      modelSelections.set({});
      return null;
    }

    // Check if provider_id is not a UUID format (legacy string like "deepseek")
    if (
      data.provider_id &&
      typeof data.provider_id === 'string' &&
      !data.provider_id.match(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
      )
    ) {
      // Provider ID is not a UUID, but don't clear data - just log once and continue
      // This allows backward compatibility with non-UUID provider IDs
      if (!sessionStorage.getItem('non-uuid-provider-logged')) {
        sessionStorage.setItem('non-uuid-provider-logged', 'true');
      }
      // Don't clear the data, just continue with the non-UUID provider_id
    }

    // New format - preferred
    if (data.model_id && data.model_name && data.provider_id) {
      return {
        model_id: data.model_id,
        model_name: data.model_name,
        provider_id: data.provider_id,
        provider_type: data.provider_type,
      };
    }

    // Backward compatibility - check for old activeModel format
    const legacyData = getStorageItem<Record<string, unknown>>(STORAGE_KEYS.MODEL_SELECTIONS, {});
    if (legacyData.activeModel && typeof legacyData.activeModel === 'string') {
      return {
        model_id: legacyData.activeModel,
        model_name: legacyData.activeModel, // Fallback to ID as name
        provider_id: 'unknown', // Will be resolved when models are loaded
      };
    }

    return null;
  },

  // Set the full model object
  setActiveModelObject: (model: {
    model_id: string;        // UUID from Model.id
    model_name: string;      // API identifier (required)
    display_name?: string;   // Optional UI display name
    provider_id: string;
    provider_type?: string;
  }): void => {
    // Validate that model_name is not the same as model_id (corruption check)
    if (model.model_name === model.model_id) {
      console.error('🚨 Attempted to store corrupted model data where model_name equals model_id:', model);
      console.error('🚨 This indicates a bug in the model selection logic. Skipping storage to prevent corruption.');
      return;
    }

    // Validate that model_id looks like a proper UUID or model identifier
    if (!model.model_id || model.model_id.trim() === '') {
      console.error('🚨 Attempted to store model with empty model_id:', model);
      return;
    }

    // Validate that model_name is not a UUID (model_name should be the API identifier, not the database UUID)
    const isUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(model.model_name);
    if (isUUID) {
      console.error('🚨 Attempted to store UUID as model_name:', model);
      console.error('🚨 model_name should be the API identifier for provider calls, not a database UUID. Skipping storage.');
      return;
    }

    modelSelections.set({
      model_id: model.model_id,
      model_name: model.model_name,
      display_name: model.display_name,  // Store optional display name
      provider_id: model.provider_id,
      provider_type: model.provider_type,
    });

    // Debug: Verify storage immediately after setting
    const verified = modelSelections.get();
    console.log('setActiveModelObject: Verified storage after set:', {
      stored_model_id: verified.model_id,
      stored_model_name: verified.model_name,
      stored_provider_id: verified.provider_id,
    });
  },

  // Utility method to check storage health
  getStorageInfo: () => {
    const data = modelSelections.get();
    const age = data.lastUpdated ? Date.now() - data.lastUpdated : 0;
    const daysOld = Math.floor(age / (24 * 60 * 60 * 1000));

    return {
      hasActiveModel: !!(data.model_id && data.model_name && data.provider_id),
      lastUpdated: data.lastUpdated,
      age,
      daysOld,
      isExpired: data.isExpired || false,
      version: data.version,
    };
  },

  // Clear all model selections
  clear: (): void => {
    removeStorageItem(STORAGE_KEYS.MODEL_SELECTIONS);
    // Remove old backup key if it exists
    removeStorageItem(`${STORAGE_KEYS.MODEL_SELECTIONS}_backup`);
  },
};

// UI state storage (consolidated version with ChatModelSelector utilities)
export const uiState = {
  get: (): UIState => getStorageItem(STORAGE_KEYS.UI_STATE, {}),

  set: (state: Partial<UIState>): void => {
    const current = uiState.get();
    setStorageItem(STORAGE_KEYS.UI_STATE, { ...current, ...state });
  },

  // ChatModelSelector refresh mechanism
  requestChatModelSelectorRefresh: (): void => {

    uiState.set({ chatModelSelectorRefreshNeeded: true });
  },

  isChatModelSelectorRefreshNeeded: (): boolean => {
    return uiState.get().chatModelSelectorRefreshNeeded || false;
  },

  clearChatModelSelectorRefreshRequest: (): void => {
    uiState.set({ chatModelSelectorRefreshNeeded: false });
  },

  // ChatModelSelector loading state management
  setChatModelSelectorLoading: (loading: boolean): void => {
    uiState.set({ chatModelSelectorLoading: loading });
  },

  isChatModelSelectorLoading: (): boolean => {
    return uiState.get().chatModelSelectorLoading || false;
  },

  setChatModelSelectorFetching: (fetching: boolean): void => {
    uiState.set({ chatModelSelectorFetching: fetching });
  },

  isChatModelSelectorFetching: (): boolean => {
    return uiState.get().chatModelSelectorFetching || false;
  },

  // The cached workspace is per-user. On a shared device (e.g. the Android
  // app) a previous user's selected workspace must NOT leak into the next
  // login — that caused 403/404 storms when the new user wasn't a member of
  // the cached workspace. When a userId is given, only return the cache if it
  // was written by that same user; a missing/mismatched owner returns
  // undefined so the caller falls back to the backend's getDefaultWorkspace
  // (which is per-user and honours the user's own selected_workspace).
  getCurrentWorkspace: (userId?: string): Record<string, unknown> | undefined => {
    const state = uiState.get();
    if (userId && state.currentWorkspaceUserId !== userId) {
      return undefined;
    }
    return state.currentWorkspace;
  },
  setCurrentWorkspace: (workspace: Record<string, unknown> | null, userId?: string): void =>
    uiState.set({
      currentWorkspace: workspace ?? undefined,
      currentWorkspaceUserId: workspace ? userId : undefined,
    }),

  getCachedUser: (): Record<string, unknown> | undefined => uiState.get().cachedUser,
  setCachedUser: (user: Record<string, unknown>): void => uiState.set({ cachedUser: user }),

  // Knowledge Stacks dialog: remember last selected collection so reopen
  // returns the user to where they left off instead of an empty side panel.
  getLastKnowledgeCollectionId: (): string | null => uiState.get().lastKnowledgeCollectionId ?? null,
  setLastKnowledgeCollectionId: (id: string | null): void => uiState.set({ lastKnowledgeCollectionId: id }),
};

// Cache data storage with TTL
export const cacheData = {
  get: (): CacheData => getStorageItem(STORAGE_KEYS.CACHE_DATA, {}),

  set: (cache: Partial<CacheData>): void => {
    const current = cacheData.get();
    setStorageItem(STORAGE_KEYS.CACHE_DATA, { ...current, ...cache });
  },

  getItem: <T>(key: keyof CacheData): T | null => {
    const cache = cacheData.get();
    const item = cache[key];

    if (!item) return null;

    // Check if expired
    if (Date.now() > item.expiry) {
      // Remove expired item
      const updated = { ...cache };
      delete updated[key];
      cacheData.set(updated);
      return null;
    }

    return item.data;
  },

  setItem: <T>(
    key: keyof CacheData,
    data: T,
    ttl: number = DEFAULT_CACHE_TTL
  ): void => {
    const cache = cacheData.get();
    cache[key] = {
      data,
      expiry: Date.now() + ttl,
    };
    cacheData.set(cache);
  },

  removeItem: (key: keyof CacheData): void => {
    const cache = cacheData.get();
    delete cache[key];
    cacheData.set(cache);
  },

  clear: (): void => {
    setStorageItem(STORAGE_KEYS.CACHE_DATA, {});
  },
};


// Settings storage
export const settings = {
  get: (): Settings => getStorageItem(STORAGE_KEYS.SETTINGS, {}),

  set: (settingsData: Partial<Settings>): void => {
    const current = settings.get();
    setStorageItem(STORAGE_KEYS.SETTINGS, { ...current, ...settingsData });
  },

  // Returns `undefined` when nothing is stored. Previously returned 'en' which
  // silently overrode i18next's LanguageDetector — a user whose browser is
  // set to Croatian was detected as 'hr' at i18n.init time and then forced
  // back to 'en' by LanguageProvider reading this default.
  getI18nLanguage: (): string | undefined =>
    settings.get().i18nextLng || undefined,
  // Mirror writes to BOTH the nested `scrapalot_settings.i18nextLng` and the
  // bare `localStorage.i18nextLng` that i18next-browser-languagedetector reads
  // at cold start. Without the mirror, the next refresh sees no detector-
  // visible value and falls back to 'en' / navigator language — the user
  // then waits 8 s for /settings/settings_general before the UI flips to hr.
  setI18nLanguage: (language: string): void => {
    settings.set({ i18nextLng: language });
    try {
      localStorage.setItem('i18nextLng', language);
    } catch {
      // Storage may throw in private-mode Safari / quota-exceeded; the
      // nested write above is enough for next-login sync via i18n/index.
    }
  },
};

// Clear all consolidated storage (for logout)
export const clearAllStorage = (): void => {
  Object.values(STORAGE_KEYS).forEach(key => {
    removeStorageItem(key);
  });
};

// Force clean up localStorage - removes ALL non-scrapalot keys except essential ones
export const forceCleanupLocalStorage = (): void => {


  // Essential keys to preserve (auth, core functionality)
  const preserveKeys = [
    'auth_tokens',
    'user_settings', // Keep for now as it contains backend sync data
  ];

  const allKeys = Object.keys(localStorage);
  let removedCount = 0;



  allKeys.forEach(key => {
    // Only keep essential keys and scrapalot_ prefixed keys
    if (!preserveKeys.includes(key) && !key.startsWith('scrapalot_')) {
      try {
        localStorage.removeItem(key);

        removedCount++;
      } catch (e) {
        console.warn(`⚠️ Error removing ${key}:`, e);
      }
    } else {
      // Key is preserved; skip removal
    }
  });



  Object.keys(localStorage).forEach(_key => {
  });
};

// Get storage usage statistics
export const getStorageStats = (): { key: string; size: number }[] => {
  return Object.values(STORAGE_KEYS)
    .map(key => {
      const item = localStorage.getItem(key);
      return {
        key,
        size: item ? new Blob([item]).size : 0,
      };
    })
    .sort((a, b) => b.size - a.size);
};

// PDF reading position cache - stores page positions for documents
// TTL: 30 days (same as model selections)
const PDF_POSITION_TTL = 30 * 24 * 60 * 60 * 1000;

interface PdfPosition {
  pageNumber: number;
  totalPages?: number;
  updatedAt: number;
}

interface PdfPositionsCache {
  [documentId: string]: PdfPosition;
}

export const pdfPositions = {
  get: (): PdfPositionsCache => getStorageItem(STORAGE_KEYS.PDF_POSITIONS, {}),

  // Get position for a specific document
  getPosition: (documentId: string): PdfPosition | null => {
    const cache = pdfPositions.get();
    const position = cache[documentId];

    if (!position) return null;

    // Check if expired (30 days)
    if (Date.now() - position.updatedAt > PDF_POSITION_TTL) {
      // Remove expired position
      pdfPositions.removePosition(documentId);
      return null;
    }

    return position;
  },

  // Save position for a document
  setPosition: (documentId: string, pageNumber: number, totalPages?: number): void => {
    const cache = pdfPositions.get();
    cache[documentId] = {
      pageNumber,
      totalPages,
      updatedAt: Date.now(),
    };
    setStorageItem(STORAGE_KEYS.PDF_POSITIONS, cache);
  },

  // Remove position for a document
  removePosition: (documentId: string): void => {
    const cache = pdfPositions.get();
    delete cache[documentId];
    setStorageItem(STORAGE_KEYS.PDF_POSITIONS, cache);
  },

  // Clean up expired positions
  cleanupExpired: (): void => {
    const cache = pdfPositions.get();
    const now = Date.now();
    let hasChanges = false;

    Object.keys(cache).forEach(docId => {
      if (now - cache[docId].updatedAt > PDF_POSITION_TTL) {
        delete cache[docId];
        hasChanges = true;
      }
    });

    if (hasChanges) {
      setStorageItem(STORAGE_KEYS.PDF_POSITIONS, cache);
    }
  },

  // Clear all positions
  clear: (): void => {
    setStorageItem(STORAGE_KEYS.PDF_POSITIONS, {});
  },
};

// EPUB reading position cache - stores CFI positions for EPUB documents
// TTL: 30 days (same as PDF positions)
const EPUB_POSITION_TTL = 30 * 24 * 60 * 60 * 1000;

interface EpubPosition {
  cfi: string;              // EPUB CFI (canonical fragment identifier)
  sectionIndex?: number;    // Section index (if available)
  charIndex?: number;       // Character index within section (for TTS)
  updatedAt: number;
}

interface EpubPositionsCache {
  [documentId: string]: EpubPosition;
}

export const epubPositions = {
  get: (): EpubPositionsCache => getStorageItem(STORAGE_KEYS.EPUB_POSITIONS, {}),

  // Get position for a specific document
  getPosition: (documentId: string): EpubPosition | null => {
    const cache = epubPositions.get();
    const position = cache[documentId];

    if (!position) return null;

    // Check if expired (30 days)
    if (Date.now() - position.updatedAt > EPUB_POSITION_TTL) {
      // Remove expired position
      epubPositions.removePosition(documentId);
      return null;
    }

    return position;
  },

  // Save position for a document
  setPosition: (
    documentId: string,
    cfi: string,
    sectionIndex?: number,
    charIndex?: number
  ): void => {
    const cache = epubPositions.get();
    cache[documentId] = {
      cfi,
      sectionIndex,
      charIndex,
      updatedAt: Date.now(),
    };
    setStorageItem(STORAGE_KEYS.EPUB_POSITIONS, cache);
  },

  // Remove position for a document
  removePosition: (documentId: string): void => {
    const cache = epubPositions.get();
    delete cache[documentId];
    setStorageItem(STORAGE_KEYS.EPUB_POSITIONS, cache);
  },

  // Clean up expired positions
  cleanupExpired: (): void => {
    const cache = epubPositions.get();
    const now = Date.now();
    let hasChanges = false;

    Object.keys(cache).forEach(docId => {
      if (now - cache[docId].updatedAt > EPUB_POSITION_TTL) {
        delete cache[docId];
        hasChanges = true;
      }
    });

    if (hasChanges) {
      setStorageItem(STORAGE_KEYS.EPUB_POSITIONS, cache);
    }
  },

  // Clear all positions
  clear: (): void => {
    setStorageItem(STORAGE_KEYS.EPUB_POSITIONS, {});
  },
};
