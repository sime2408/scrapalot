import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  AlertTriangle,
  Cpu,
  FileText,
  Key,
  LayoutGrid,
  MessageSquare,
  Mic,
  Plug,
  Server,
  Settings as SettingsIcon,
  Shield,
  Users,
} from 'lucide-react';
import {
  useIsSmallScreen,
} from '@/hooks/use-mobile';
import { useAnyDrawerOpen } from '@/hooks/use-any-drawer-open';
import { cn } from '@/lib/utils';
import {
  getUserSettings,
  saveGeneralSettings as apiSaveGeneralSettings,
  saveModelSettings,
  savePromptTemplates,
} from '@/lib/api-settings';
import { useProviders } from '@/hooks/useProviders';
import {
  getFeaturedModels,
  getInstalledModels,
  getLocalAIConfig,
  updateLocalAIConfig,
  invalidateModelsCache,
  invalidateProvidersCache,
} from '@/lib/api-llm-inference';
import { getWorkspaces, type Workspace } from '@/lib/api-workspace';
import { getCollections } from '@/lib/api-collections';
import { getCurrentUser, type User as UserType } from '@/lib/api-users';
import { getMySubscription, type UserSubscriptionWithUsage } from '@/lib/api-subscriptions';
import { getMyStorageQuota, type StorageQuota } from '@/lib/api-storage';
import { clearCache as clearApiResponseCache } from '@/lib/api';

// Define types locally to avoid import errors
// Import LocalAIConfig type instead of defining it locally
// Import LocalModel type instead of defining it locally
import type { LocalAIConfig, LocalModel } from '@/types/llm-types';
import type { DocumentCollection } from '@/types';
import type {
  RemoteProvider,
  SettingsDialogProps,
  SettingsTab,
} from '@/types/settings-types';
import { SettingsTabProvidersForm } from './settings-tab-providers-form';
import { SettingsTabProvidersLocal } from './settings-tab-providers-local';
import { SettingsGeneralTab } from './settings-tab-general';
import { SettingsVoiceTab } from './settings-tab-voice';
import { SettingsMcpIntegrationsTab } from './settings-tab-mcp-integrations';
import { SettingsRemoteProvidersTab } from './settings-tab-providers-remote';
import { SettingsLocalAITab } from './settings-tab-local-ai';
import { SettingsPromptsTab } from './settings-tab-prompts';
import { SettingsAccountTab } from './settings-tab-account';
import { DocumentsSettingsTab } from './settings-tab-documents';
import SettingsTabService from './settings-tab-service';
import SettingsTabUsers from './settings-tab-users';
import { SettingsWorkspacesTab } from './settings-tab-workspaces';
import { toast as sonnerToast } from '@/lib/toast-compat';
import { useTheme } from '@/providers/theme-provider';
import { useFontSettings } from '@/contexts/font-settings-context';
import { useLanguage } from '@/providers/language-provider';
import { useTranslation } from 'react-i18next';
import { useAdminCheck } from '@/hooks/use-admin-check';

const Settings = ({
  open,
  onOpenChange,
  defaultTab = 'account',
}: SettingsDialogProps) => {
  const { t } = useTranslation();
  // Access the theme provider to track actual theme state
  const themeContext = useTheme();
  const { language, setLanguage } = useLanguage();

  // Get admin status using our new hook
  const isAdmin = useAdminCheck();

  // Debug admin status
  useEffect(() => {
  }, [isAdmin]);

  const [activeTab, setActiveTab] = useState<SettingsTab>(defaultTab);
  const [isSaving, setIsSaving] = useState(false);
  const [lastSaved, setLastSaved] = useState<Date | null>(null);
  const [isMaximized, setIsMaximized] = useState(false);

  // State for preloading LocalAIModelsDialog data
  const [featuredModels, setFeaturedModels] = useState<LocalModel[]>([]);
  const [installedModels, setInstalledModels] = useState<LocalModel[]>([]);
  // Active model concept removed - no longer tracking active model state
  const [isPreloadingModels, setIsPreloadingModels] = useState(false);

  // State for preloading workspace data
  const [preloadedWorkspaces, setPreloadedWorkspaces] = useState<Workspace[]>([]);
  const [preloadedWorkspaceCollections, setPreloadedWorkspaceCollections] = useState<Record<string, DocumentCollection[]>>({});
  const [isPreloadingWorkspaces, setIsPreloadingWorkspaces] = useState(false);

  // State for preloading account data
  const [preloadedUser, setPreloadedUser] = useState<UserType | null>(null);
  const [preloadedSubscription, setPreloadedSubscription] = useState<UserSubscriptionWithUsage | null>(null);
  const [preloadedStorageQuota, setPreloadedStorageQuota] = useState<StorageQuota | null>(null);
  const [isPreloadingAccount, setIsPreloadingAccount] = useState(false);

  // Ref for preloading providers data (using ref to avoid recreating callback)
  const isPreloadingProvidersRef = useRef(false);

  // Ref to track if preload has been called for this dialog open session
  const hasPreloadedForCurrentSession = useRef(false);

  // Guard to prevent sheet from closing immediately after opening from dropdown
  const sheetOpeningGuard = useRef(false);

  // General settings states
  const [autoTitleGenerate, setAutoTitleGenerate] = useState<
    'LOCAL' | 'REMOTE'
  >('LOCAL');
  const [enableLinks, setEnableLinks] = useState(true);
  const [proxyAddress, setProxyAddress] = useState('');
  const [appearance, setAppearance] = useState<'light' | 'dark' | 'system'>(
    themeContext.theme
  );
  const [accentColor, setAccentColor] = useState('blue');

  // Get font settings from context - we'll use these directly instead of the local state
  const fontSettings = useFontSettings();

  const [fontStyle, setFontStyle] = useState('sans');

  // --- Add RAG Strategy State ---
  const [ragStrategy, setRagStrategy] = useState<string>('RAGSimilaritySearch'); // Default
  const [ragOrchestrator, setRagOrchestrator] = useState<string>('EnhancedTriModalOrchestrator'); // Default orchestrator
  const [useOrchestrator, setUseOrchestrator] = useState<boolean>(true); // Default to using orchestrator
  const [useAgenticRouting, setUseAgenticRouting] = useState<boolean>(false); // Default to not using agentic routing
  const [showReasoningIndicators, setShowReasoningIndicators] = useState<boolean>(true);
  const [ragTracingEnabled, setRagTracingEnabled] = useState<boolean>(false);
  // Simple Mode Toggle
  const [simpleModeEnabled, setSimpleModeEnabledState] = useState<boolean>(false);
  // Default agent profile slug
  const [defaultAgentProfileSlug, setDefaultAgentProfileSlug] = useState<string>('');
  const [responseLength, setResponseLength] = useState<'short' | 'medium' | 'long'>('medium');
  // Response Personalization (formality + domain focus).
  // Stored per-user in settings_general; Python's system_prompt_builder
  // layer 5 reads them to bias the assistant's tone and example framing.
  const [responseFormality, setResponseFormality] = useState<'casual' | 'neutral' | 'academic'>('neutral');
  const [responseDomainFocus, setResponseDomainFocus] = useState<string>('');
  // BYOK Whisper key for live voice mode. Stored per-user in settings_general
  // so the live conversation feature does not bill Scrapalot's OpenAI account.
  const [voiceOpenaiApiKey, setVoiceOpenaiApiKey] = useState<string>('');

  // Rendering modules state
  const [renderingModules, setRenderingModules] = useState<string[]>([
    'MARKDOWN',
    'GITHUB_MARKDOWN',
    'CODE_HIGHLIGHTING',
    'COLLAPSE_TAGS',
  ]);

  // Initialize responsive hooks - use < 1400px breakpoint for settings full-screen
  const isNarrowScreen = useIsSmallScreen(); // < 1400px for mobile/tablet/small desktop layout
  const { isOpen: isAnyDrawerOpen, isDrawerOnLeft } = useAnyDrawerOpen();

  // Determine if we should use split-screen layout (drawer open + wide screen)
  const isSplitScreen = isAnyDrawerOpen && !isNarrowScreen;
  // Use narrow/tablet layout when screen is actually narrow OR in split mode (~50% width)
  const effectiveNarrow = isNarrowScreen || isSplitScreen;

  // State variables for dialog management
  const [editingProvider, setEditingProvider] = useState<RemoteProvider | null>(
    null
  );
  const [isEditSheetOpen, setIsEditSheetOpen] = useState(false);
  const [isAddSheetOpen, setIsAddSheetOpen] = useState(false);
  const [isLocalAIModelsDialogOpen, setIsLocalAIModelsDialogOpen] =
    useState(false);

  // Touch swipe state for mobile tab navigation
  const [touchStart, setTouchStart] = useState<{ x: number; y: number } | null>(null);
  const [touchEnd, setTouchEnd] = useState<{ x: number; y: number } | null>(null);
  const [touchCurrent, setTouchCurrent] = useState<{ x: number; y: number } | null>(null);
  const [isAnimating, setIsAnimating] = useState(false);
  const [slideDirection, setSlideDirection] = useState<'left' | 'right' | null>(null);
  const [nextTab, setNextTab] = useState<SettingsTab | null>(null);
  const [dragOffset, setDragOffset] = useState(0);
  const [isDragging, setIsDragging] = useState(false);
  const [isVerticalScroll, setIsVerticalScroll] = useState(false);

  // NOTE: Mobile back button handling is now managed by the Dialog component in dialog.tsx
  // Each Dialog (main settings, provider form, local AI models) handles its own history state
  // This prevents duplicate handlers that were causing the main dialog to close unexpectedly

  const [defaultPrompt, setDefaultPrompt] = useState(
    'You are a helpful, respectful and honest assistant.'
  );
  const [defaultTemplate, setDefaultTemplate] = useState('');
  const [customTemplates, setCustomTemplates] = useState<
    { name: string; content: string; examples?: { input: string; output: string }[] }[]
  >([]);

  const [generalSettingsChanged, setGeneralSettingsChanged] = useState(false);
  const [promptSettingsChanged, setPromptSettingsChanged] = useState(false);
  const [isInitialLoadComplete, setIsInitialLoadComplete] = useState(false);

  const [temperature, _setTemperature] = useState(0.1);
  const [maxOutputTokens, _setMaxOutputTokens] = useState(8000);
  const [topP, _setTopP] = useState(0.9);
  const [topK, _setTopK] = useState(40);
  const [frequencyPenalty, _setFrequencyPenalty] = useState(0.5);
  const [presencePenalty, _setPresencePenalty] = useState(0.5);
  const [contextWindowSize, _setContextWindowSize] = useState(256000);
  const [contextMessageLimit, _setContextMessageLimit] = useState(30);
  const [gpuLayers, _setGpuLayers] = useState(-1);
  const [modelInstructions, _setModelInstructions] = useState(
    'You are a helpful assistant.'
  );
  const [modelSettingsChanged, setModelSettingsChanged] = useState(false);

  // Local AI Tab state
  const [showModels, setShowModels] = useState<boolean>(true);
  const [modelsDirectory, setModelsDirectory] = useState<string>('');
  const [maxParallelChats, setMaxParallelChats] = useState<number>(3);
  const [useAdvancedConfig, setUseAdvancedConfig] = useState<boolean>(false);
  const [advancedConfigJson, setAdvancedConfigJson] = useState<string>(`{
  "llama": {
    "context_size": 8192,
    "gpu_layers": 50,
    "batch_size": 512,
    "use_mlock": true,
    "use_mmap": true
  }
}`);

  const [serviceConfig, setServiceConfig] = useState<Partial<LocalAIConfig>>(
    {}
  );
  const [serviceSettingsChanged, setServiceSettingsChanged] = useState(false);

  // Track if providers were mutated (deleted/updated/added) to force refresh
  const [providersMutated, setProvidersMutated] = useState(false);

  // Reset sheet opening guard after sheet opens
  useEffect(() => {
    if (isEditSheetOpen || isAddSheetOpen) {
      // Give the sheet time to fully open before clearing guard
      const timer = setTimeout(() => {
        sheetOpeningGuard.current = false;
      }, 150);
      return () => clearTimeout(timer);
    }
  }, [isEditSheetOpen, isAddSheetOpen]);

  useEffect(() => {
    // Only sync with theme context if we haven't loaded user settings yet
    if (!isInitialLoadComplete) {
      if (themeContext.theme !== appearance) setAppearance(themeContext.theme);
      if (themeContext.accentColor !== accentColor)
        setAccentColor(themeContext.accentColor);
    }
  }, [
    themeContext.theme,
    themeContext.accentColor,
    accentColor,
    appearance,
    isInitialLoadComplete,
  ]);

  // Track initial values to prevent triggering changes during loading
  const [initialValues, setInitialValues] = useState<Record<string, unknown> | null>(null);

  // Store initial values after load complete
  useEffect(() => {
    if (isInitialLoadComplete && !initialValues) {
      setInitialValues({
        autoTitleGenerate,
        enableLinks,
        proxyAddress,
        appearance,
        accentColor,
        fontStyle,
        codeTheme: fontSettings.codeTheme,
        fontSize: fontSettings.fontSize,
        showReasoningIndicators,
        ragStrategy,
        ragOrchestrator,
        useOrchestrator,
        ragTracingEnabled,
        simpleModeEnabled,
        defaultAgentProfileSlug,
        responseLength,
        responseFormality,
        responseDomainFocus,
        renderingModules,
        language,
      });
    }
  }, [
    isInitialLoadComplete,
    initialValues,
    autoTitleGenerate,
    enableLinks,
    proxyAddress,
    appearance,
    accentColor,
    fontStyle,
    fontSettings.codeTheme,
    fontSettings.fontSize,
    showReasoningIndicators,
    ragStrategy,
    ragOrchestrator,
    useOrchestrator,
    ragTracingEnabled,
    simpleModeEnabled,
    defaultAgentProfileSlug,
    responseLength,
    responseFormality,
    responseDomainFocus,
    renderingModules,
    language,
  ]);

  // Only mark as changed if values differ from initially loaded values
  useEffect(() => {
    if (open && isInitialLoadComplete && initialValues) {
      const hasChanges =
        autoTitleGenerate !== initialValues.autoTitleGenerate ||
        enableLinks !== initialValues.enableLinks ||
        proxyAddress !== initialValues.proxyAddress ||
        appearance !== initialValues.appearance ||
        accentColor !== initialValues.accentColor ||
        fontStyle !== initialValues.fontStyle ||
        fontSettings.codeTheme !== initialValues.codeTheme ||
        fontSettings.fontSize !== initialValues.fontSize ||
        showReasoningIndicators !== initialValues.showReasoningIndicators ||
        ragStrategy !== initialValues.ragStrategy ||
        ragOrchestrator !== initialValues.ragOrchestrator ||
        useOrchestrator !== initialValues.useOrchestrator ||
        ragTracingEnabled !== initialValues.ragTracingEnabled ||
        simpleModeEnabled !== initialValues.simpleModeEnabled ||
        defaultAgentProfileSlug !== initialValues.defaultAgentProfileSlug ||
        responseLength !== initialValues.responseLength ||
        responseFormality !== initialValues.responseFormality ||
        responseDomainFocus !== initialValues.responseDomainFocus ||
        JSON.stringify(renderingModules) !==
        JSON.stringify(initialValues.renderingModules) ||
        language !== initialValues.language;

      if (hasChanges) {

        setGeneralSettingsChanged(true);
      }
    }
  }, [
    open,
    isInitialLoadComplete,
    initialValues,
    autoTitleGenerate,
    enableLinks,
    proxyAddress,
    appearance,
    accentColor,
    fontStyle,
    fontSettings.codeTheme,
    fontSettings.fontSize,
    showReasoningIndicators,
    ragStrategy,
    ragOrchestrator,
    useOrchestrator,
    ragTracingEnabled,
    simpleModeEnabled,
    defaultAgentProfileSlug,
    responseLength,
    responseFormality,
    responseDomainFocus,
    renderingModules,
    language,
  ]);

  // Specifically handle language changes to ensure auto-save is triggered
  useEffect(() => {
    if (isInitialLoadComplete && initialValues && language !== initialValues.language) {
      setGeneralSettingsChanged(true);
    }
  }, [language, isInitialLoadComplete, initialValues]);

  // Track initial model values to prevent triggering changes during loading
  const [modelInitialValues, setModelInitialValues] = useState<Record<string, unknown> | null>(null);

  // Store initial model values after load complete
  useEffect(() => {
    if (isInitialLoadComplete && !modelInitialValues) {
      setModelInitialValues({
        temperature,
        topP,
        frequencyPenalty,
        presencePenalty,
        maxOutputTokens,
        contextWindowSize,
        topK,
        gpuLayers,
        contextMessageLimit,
        modelInstructions,
      });
    }
  }, [
    isInitialLoadComplete,
    modelInitialValues,
    temperature,
    topP,
    frequencyPenalty,
    presencePenalty,
    maxOutputTokens,
    contextWindowSize,
    topK,
    gpuLayers,
    contextMessageLimit,
    modelInstructions,
  ]);

  // Only mark model settings as changed if values differ from initially loaded values
  useEffect(() => {
    if (open && isInitialLoadComplete && modelInitialValues) {
      const hasChanges =
        temperature !== modelInitialValues.temperature ||
        topP !== modelInitialValues.topP ||
        frequencyPenalty !== modelInitialValues.frequencyPenalty ||
        presencePenalty !== modelInitialValues.presencePenalty ||
        maxOutputTokens !== modelInitialValues.maxOutputTokens ||
        contextWindowSize !== modelInitialValues.contextWindowSize ||
        topK !== modelInitialValues.topK ||
        gpuLayers !== modelInitialValues.gpuLayers ||
        contextMessageLimit !== modelInitialValues.contextMessageLimit ||
        modelInstructions !== modelInitialValues.modelInstructions;

      if (hasChanges) {
        setModelSettingsChanged(true);
      }
    }
  }, [
    open,
    isInitialLoadComplete,
    modelInitialValues,
    temperature,
    topP,
    frequencyPenalty,
    presencePenalty,
    maxOutputTokens,
    contextWindowSize,
    topK,
    gpuLayers,
    contextMessageLimit,
    modelInstructions,
  ]);

  // Track prompt settings changes - only when actual content changes occur
  useEffect(() => {
    // Only mark as changed when there are actual content changes
    // Don't set a changed flag just because dialog opens - only when actual changes occur
    // This will be set to true by the child components when user actually makes changes
  }, []);

  // Use the unified providers hook to access providers
  const {
    providers,
    loading: providersLoading,
    error: providersError,
    fetchProviders,
    addProvider,
    updateProvider,
    deleteProvider,
  } = useProviders();

  // Show error if providers failed to load
  useEffect(() => {
    if (providersError) {
      console.error('❌ Error loading providers:', providersError);
      sonnerToast.error(t('settings.errors.loadProviders'));
    }
  }, [providersError, t]);

  // Wrap provider mutation functions to clear cache and track changes
  const wrappedAddProvider = useCallback(async (provider: Partial<RemoteProvider>) => {
    const result = await addProvider(provider);
    // Clear all three caches (see wrappedUpdateProvider for rationale)
    clearApiResponseCache('/providers');
    clearApiResponseCache('/models');
    invalidateProvidersCache();
    invalidateModelsCache();
    const { clearProviderCache } = await import('@/hooks/useProviders');
    clearProviderCache();
    setProvidersMutated(true);
    return result;
  }, [addProvider]);

  const wrappedUpdateProvider = useCallback(async (id: string, provider: Partial<RemoteProvider>) => {
    const result = await updateProvider(id, provider);
    // Bust all three caches so the next GET /providers returns fresh data:
    //   - api.ts responseCache (60s axios layer)
    //   - api-utils memoryCache (via invalidateProvidersCache/invalidateModelsCache)
    //   - useProviders globalProviders (via clearProviderCache)
    // Missing any one of these leaves stale models on screen after edit.
    clearApiResponseCache('/providers');
    clearApiResponseCache('/models');
    invalidateProvidersCache();
    invalidateModelsCache();
    const { clearProviderCache } = await import('@/hooks/useProviders');
    clearProviderCache();
    setProvidersMutated(true);
    return result;
  }, [updateProvider]);

  const wrappedDeleteProvider = useCallback(async (id: string) => {
    const result = await deleteProvider(id);
    // Clear all three caches (see wrappedUpdateProvider for rationale)
    clearApiResponseCache('/providers');
    clearApiResponseCache('/models');
    invalidateProvidersCache();
    invalidateModelsCache();
    const { clearProviderCache } = await import('@/hooks/useProviders');
    clearProviderCache();
    setProvidersMutated(true);
    return result;
  }, [deleteProvider]);

  // Define preloadProvidersData with useCallback to create a stable reference
  const preloadProvidersData = useCallback(async () => {
    // Prevent multiple simultaneous calls using ref
    if (isPreloadingProvidersRef.current) {
      return;
    }

    isPreloadingProvidersRef.current = true;

    try {
      // Only force refresh if providers were mutated (delete/update/add)
      // Otherwise use normal cache (30 seconds) to prevent excessive backend requests
      await fetchProviders(providersMutated);

      // Clear mutation flag after successful refresh
      if (providersMutated) {
        setProvidersMutated(false);
      }

    } catch (error) {
      console.error('❌ Error preloading remote providers data:', error);
      sonnerToast.error(t('settings.errors.loadProviders'));
    } finally {
      isPreloadingProvidersRef.current = false;
    }
  }, [fetchProviders, providersMutated, setProvidersMutated, t]);

  // Define preloadLocalModelsData with useCallback to create a stable reference
  const preloadLocalModelsData = useCallback(async () => {
    if (isPreloadingModels) return;
    setIsPreloadingModels(true);

    try {
      const [featured, installed] = await Promise.all([
        getFeaturedModels(''),
        getInstalledModels(true), // Get all models and filter manually
      ]);

      setFeaturedModels(featured);
      setInstalledModels(installed);

    } catch (error) {
      console.error('Error preloading local models data:', error);
      sonnerToast.error(t('settings.localai.errors.preloadFailed'));
    } finally {
      setIsPreloadingModels(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- deps are intentionally limited
  }, [t]); // Removed isPreloadingModels from dependencies to prevent loop

  // Define preloadWorkspacesData with useCallback to create a stable reference
  const preloadWorkspacesData = useCallback(async () => {
    if (isPreloadingWorkspaces) return;
    setIsPreloadingWorkspaces(true);

    try {
      const workspacesData = await getWorkspaces(1, 20);
      setPreloadedWorkspaces(workspacesData.workspaces);

      // Preload collections for each workspace
      const collectionsMap: Record<string, DocumentCollection[]> = {};
      for (const workspace of workspacesData.workspaces) {
        try {
          const collectionsData = await getCollections(workspace.id);
          collectionsMap[workspace.id] = collectionsData.collections;
        } catch (error) {
          console.error(`Error preloading collections for workspace ${workspace.id}:`, error);
          collectionsMap[workspace.id] = [];
        }
      }
      setPreloadedWorkspaceCollections(collectionsMap);

    } catch (error) {
      console.error('Error preloading workspaces data:', error);
      sonnerToast.error(t('settings.errors.workspacesPreloadFailed'));
    } finally {
      setIsPreloadingWorkspaces(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- deps are intentionally limited
  }, [t]); // Removed isPreloadingWorkspaces from dependencies to prevent loop

  // Ref for preloading account data (using ref to avoid recreating callback)
  const isPreloadingAccountRef = useRef(false);

  // Define preloadAccountData with useCallback to create a stable reference
  const preloadAccountData = useCallback(async () => {
    if (isPreloadingAccountRef.current) {
      return;
    }

    isPreloadingAccountRef.current = true;
    setIsPreloadingAccount(true);

    try {
      // Load user data
      const userData = await getCurrentUser();
      setPreloadedUser(userData);

      // Load subscription data
      try {
        const subscriptionData = await getMySubscription();
        setPreloadedSubscription(subscriptionData);
      } catch (error) {
        console.error('Error preloading subscription data:', error);
        setPreloadedSubscription(null);
      }

      // Load storage quota data
      try {
        const storageData = await getMyStorageQuota();
        setPreloadedStorageQuota(storageData);
      } catch (error) {
        console.error('Error preloading storage quota data:', error);
        setPreloadedStorageQuota(null);
      }

    } catch (error) {
      console.error('Error preloading account data:', error);
      sonnerToast.error(t('settings.errors.accountPreloadFailed'));
    } finally {
      setIsPreloadingAccount(false);
      isPreloadingAccountRef.current = false;
    }
  }, [t]);

  const saveGeneralSettingsStable = useCallback(async () => {
    if (!generalSettingsChanged) return;
    setIsSaving(true);
    try {
      const validFontSize = isNaN(fontSettings.fontSize)
        ? 14
        : fontSettings.fontSize;
      // Ensure ragOrchestrator is never 'none' - preserve previous or fallback
      const validRagOrchestrator = (!ragOrchestrator || ragOrchestrator === 'none')
        ? 'EnhancedTriModalOrchestrator'
        : ragOrchestrator;

      const generalSettingsToSave = {
        autoTitleGenerate: String(autoTitleGenerate),
        enableLinks: Boolean(enableLinks),
        proxyAddress: String(proxyAddress || ''),
        appearance: String(appearance),
        accentColor: String(accentColor),
        fontStyle: String(fontStyle),
        codeTheme: String(fontSettings.codeTheme),
        fontSize: validFontSize,
        showReasoningIndicators: Boolean(showReasoningIndicators),
        rag_strategy: String(ragStrategy),
        rag_orchestrator: String(validRagOrchestrator),
        use_orchestrator: Boolean(useOrchestrator),
        // use_agentic_routing is owned by chat-toolbar.tsx toggle, not the Settings
        // dialog. Including it here regressed to false whenever the dialog's local
        // useAgenticRouting state was stale (default false before async load) and
        // api-settings.ts merge saw a difference vs. the backend's true — overwriting
        // the user's persisted choice. Dropping it keeps Settings save from clobbering.
        rag_tracing_enabled: Boolean(ragTracingEnabled),
        // Simple Mode Toggle
        simple_mode_enabled: Boolean(simpleModeEnabled),
        // Default agent profile slug
        default_agent_profile_slug: String(defaultAgentProfileSlug || ''),
        response_length: String(responseLength),
        // Response Personalization
        response_formality: String(responseFormality),
        response_domain_focus: String(responseDomainFocus || ''),
        voice_openai_api_key: String(voiceOpenaiApiKey || ''),
        renderingModules: renderingModules,
        language: String(language),
      };

      console.log('💾 Saving general settings:', {
        rag_strategy: generalSettingsToSave.rag_strategy,
        rag_orchestrator: generalSettingsToSave.rag_orchestrator,
        use_orchestrator: generalSettingsToSave.use_orchestrator,
      });

      await apiSaveGeneralSettings(generalSettingsToSave);

      setLastSaved(new Date());
      setGeneralSettingsChanged(false);
    } catch (error) {
      console.error('Failed to save general settings:', error);
      sonnerToast.error(t('settings.errors.generalSave'));
    } finally {
      setIsSaving(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- deps are intentionally limited
  }, [
    generalSettingsChanged,
    fontSettings.fontSize,
    fontSettings.codeTheme,
    autoTitleGenerate,
    showReasoningIndicators,
    renderingModules,
    enableLinks,
    proxyAddress,
    appearance,
    accentColor,
    fontStyle,
    ragStrategy,
    ragOrchestrator,
    useOrchestrator,
    ragTracingEnabled,
    responseLength,
    // missing these caused a stale-closure
    // bug where changing formality / domain focus / simple-mode /
    // default-profile / voice-key triggered an auto-save call that
    // captured the previous render's values, silently wiping the new
    // selection.
    responseFormality,
    responseDomainFocus,
    simpleModeEnabled,
    defaultAgentProfileSlug,
    voiceOpenaiApiKey,
    language,
    t,
  ]);

  const saveModelSettingsStable = useCallback(async () => {
    if (!modelSettingsChanged) return;
    setIsSaving(true);
    try {
      const modelSettingsToSave = {
        temperature: Number(temperature),
        topP: Number(topP),
        frequencyPenalty: Number(frequencyPenalty),
        presencePenalty: Number(presencePenalty),
        maxOutputTokens: Number(maxOutputTokens),
        contextWindowSize: Number(contextWindowSize),
        topK: Number(topK),
        gpuLayers: Number(gpuLayers),
        contextMessageLimit: Number(contextMessageLimit),
        modelInstructions: String(
          modelInstructions || 'You are a helpful assistant.'
        ),
      };
      await saveModelSettings(modelSettingsToSave);
      setLastSaved(new Date());
      setModelSettingsChanged(false);
    } catch (error) {
      console.error('Error auto-saving model settings:', error);
      sonnerToast.error(t('settings.errors.modelSave'));
    } finally {
      setIsSaving(false);
    }
  }, [
    modelSettingsChanged,
    temperature,
    topP,
    frequencyPenalty,
    presencePenalty,
    maxOutputTokens,
    contextWindowSize,
    topK,
    gpuLayers,
    contextMessageLimit,
    modelInstructions,
    t,
  ]);

  const savePromptSettingsStable = useCallback(async () => {
    if (!promptSettingsChanged) return;
    setIsSaving(true);
    try {
      await savePromptTemplates(customTemplates);
      setLastSaved(new Date());
      setPromptSettingsChanged(false);

      // Only show a success message if we're currently on the prompts tab AND there was an actual change
      // This prevents showing the message when just clicking on the tab
      if (activeTab === 'prompts' && customTemplates.length > 0) {
        // Don't show toast notification when just opening the tab
        // Only show it when there's an actual change to save

      }
    } catch (error) {
      console.error('Error auto-saving prompt templates:', error);
      sonnerToast.error(t('settings.errors.promptSave'));
    } finally {
      setIsSaving(false);
    }
  }, [promptSettingsChanged, customTemplates, activeTab, t]);

  const saveServiceSettingsStable = useCallback(async () => {
    if (!serviceSettingsChanged) return;
    setIsSaving(true);
    try {
      await updateLocalAIConfig(serviceConfig);
      setServiceSettingsChanged(false);
      setLastSaved(new Date());
    } catch (error) {
      console.error('Error saving service settings:', error);
      sonnerToast.error(t('settings.errors.service'));
    } finally {
      setIsSaving(false);
    }
  }, [serviceSettingsChanged, serviceConfig, t]);

  // Fetch initial settings on component mount
  useEffect(() => {
    if (!open) {
      // Reset initial load flag and initial values when dialog closes
      setIsInitialLoadComplete(false);
      setInitialValues(null);
      setModelInitialValues(null);
      setGeneralSettingsChanged(false);
      setModelSettingsChanged(false);
      // Reset preload session flag when dialog closes
      hasPreloadedForCurrentSession.current = false;
      return;
    }

    // Only preload once per dialog open session to prevent infinite loop
    if (!hasPreloadedForCurrentSession.current) {
      hasPreloadedForCurrentSession.current = true;

      // Preload local models data (including an active model) when dialog opens
      void preloadLocalModelsData();

      // Preload remote providers data when dialog opens
      // Note: Must call manually because useProviders hook waits for isAuthenticated=true
      // but in dev mode with hot reload, auth state can be stuck at false even with valid tokens
      void preloadProvidersData();

      // Preload workspaces data when dialog opens
      void preloadWorkspacesData();

      // Preload account data when dialog opens
      void preloadAccountData();
    } else {
      // Dialog closed; no preloading needed
    }

    // Don't re-run when any of the state variables change
    let isMounted = true;

    const loadInitialSettings = async () => {
      try {
        // Local storage reads
        const localStorageFontSize = localStorage.getItem('fontSize');
        const localStorageCodeTheme = localStorage.getItem('codeTheme');

        if (localStorageFontSize && isMounted) {
          const parsedSize = parseInt(localStorageFontSize, 10);
          if (!isNaN(parsedSize)) fontSettings.setFontSize(parsedSize);
        }

        if (localStorageCodeTheme && isMounted) {
          fontSettings.setCodeTheme(localStorageCodeTheme);
        }

        // API calls
        const settings = await getUserSettings();
        // Safe early returns if component unmounted
        if (!isMounted) return;

        // getUserSettings now returns general settings directly (not wrapped in .general)
        const general = settings || {};

        // Batch updates to reduce renders
        setAutoTitleGenerate(
          general.auto_title_generate === 'LOCAL' ? 'LOCAL' : 'REMOTE'
        );
        setEnableLinks(
          general.links_in_chat !== undefined ? general.links_in_chat : true
        );
        setProxyAddress(general.proxy || '');
        setAppearance(themeContext.theme);
        setAccentColor(themeContext.accentColor);
        setFontStyle(general.font_style || 'sans');
        // Map backend "default" to actual strategy name
        const ragStrategyValue =
          general.rag_strategy === 'default'
            ? 'RAGSimilaritySearch'
            : general.rag_strategy || 'RAGSimilaritySearch';
        setRagStrategy(ragStrategyValue);

        // Load orchestrator setting
        const ragOrchestratorValue = general.rag_orchestrator === 'none' || !general.rag_orchestrator
          ? 'EnhancedTriModalOrchestrator'
          : general.rag_orchestrator;
        setRagOrchestrator(ragOrchestratorValue);

        // Load use_orchestrator flag
        const useOrchestratorValue = general.use_orchestrator !== undefined
          ? Boolean(general.use_orchestrator)
          : true;
        setUseOrchestrator(useOrchestratorValue);

        // Load use_agentic_routing flag
        const useAgenticRoutingValue = general.use_agentic_routing !== undefined
          ? Boolean(general.use_agentic_routing)
          : false;
        setUseAgenticRouting(useAgenticRoutingValue);

        const ragTracingValue = general.rag_tracing_enabled !== undefined
          ? Boolean(general.rag_tracing_enabled)
          : false;
        setRagTracingEnabled(ragTracingValue);

        // Simple Mode Toggle. Default false for
        // existing users so the un-gated experience persists.
        const simpleModeValue = general.simple_mode_enabled !== undefined
          ? Boolean(general.simple_mode_enabled)
          : false;
        setSimpleModeEnabledState(simpleModeValue);

        // Default agent profile slug
        const rawProfileSlug = general.default_agent_profile_slug;
        const validSlugs = ['legal', 'medical', 'academic', 'technical'];
        const validProfileSlug = typeof rawProfileSlug === 'string' && validSlugs.includes(rawProfileSlug)
          ? rawProfileSlug
          : '';
        setDefaultAgentProfileSlug(validProfileSlug);
        // Mirror to localStorage so useSimpleMode() outside this dialog
        // sees the latest value without a server round trip.
        try { localStorage.setItem('scrapalot_simple_mode_enabled', String(simpleModeValue)); } catch { /* ignore */ }
        window.dispatchEvent(new CustomEvent('scrapalot:simple-mode-changed'));

        // Load response_length preference — validates unknown values to 'medium'
        const rawLen = general.response_length;
        const validLen = rawLen === 'short' || rawLen === 'long' ? rawLen : 'medium';
        setResponseLength(validLen);

        // Response Personalization
        const rawFormality = general.response_formality;
        const validFormality = rawFormality === 'casual' || rawFormality === 'academic' ? rawFormality : 'neutral';
        setResponseFormality(validFormality);
        const rawDomain = general.response_domain_focus;
        setResponseDomainFocus(typeof rawDomain === 'string' ? rawDomain.slice(0, 100) : '');

        // Load BYOK voice key; `sk-…` isn't echoed back in clear on every
        // request so we accept whatever the server returned.
        const keyVal = general.voice_openai_api_key;
        setVoiceOpenaiApiKey(typeof keyVal === 'string' ? keyVal : '');

        // Theme code mapping
        if (!localStorageCodeTheme && isMounted) {
          const dbThemeCode = general.theme_code || 'GitHub';
          let mappedTheme: string;

          if (dbThemeCode === 'github-dark') mappedTheme = 'GitHub';
          else {
            const capitalizedThemes = {
              github: 'GitHub',
              monokai: 'Monokai',
              dracula: 'Dracula',
              light: 'Light',
              dark: 'Dark',
            };
            mappedTheme =
              capitalizedThemes[dbThemeCode] || dbThemeCode || 'GitHub';
          }

          fontSettings.setCodeTheme(mappedTheme);
        }

        // Font size from the backend
        if (!localStorageFontSize && isMounted) {
          const backendFontSize = general.font_size
            ? isNaN(parseInt(general.font_size, 10))
              ? 14
              : parseInt(general.font_size, 10)
            : 14;
          fontSettings.setFontSize(backendFontSize);
        }

        // Prompt settings
        const promptSettings = settings.prompts || {};
        if (isMounted) {
          setDefaultPrompt(
            promptSettings.defaultPrompt ||
            'You are a helpful, respectful and honest assistant.'
          );
          setDefaultTemplate(promptSettings.defaultTemplate || '');
          setCustomTemplates(promptSettings.customTemplates || []);
        }

        // Local AI settings
        try {
          const localAIConfig = await getLocalAIConfig();
          if (!isMounted) return;

          setShowModels(true);
          setModelsDirectory(localAIConfig.models_directory || '');
          setMaxParallelChats(
            parseInt(localAIConfig.max_parallel_chats || '3')
          );
          setUseAdvancedConfig(localAIConfig.use_advanced_backend || false);

          // Use a default value if needed
          const configJson =
            localAIConfig.advanced_config ||
            `{
  "llama": {
    "context_size": 8192,
    "gpu_layers": 50,
    "batch_size": 512,
    "use_mlock": true,
    "use_mmap": true
  }
}`;
          if (isMounted) setAdvancedConfigJson(configJson);

          // Load service config
          if (isMounted) setServiceConfig(localAIConfig);

        } catch (error) {
          console.error('Error loading Local AI settings:', error);
        }

        // Load language from backend settings
        if (general.language && isMounted && general.language !== language) {
          setLanguage(general.language);
        }

        // Providers are already loaded by the preloader, no need to load them here

        // Mark the initial load as complete after all settings are loaded
        if (isMounted) {
          setIsInitialLoadComplete(true);
        }
      } catch (error) {
        console.error('❌ Failed to load initial settings:', error);
        if (isMounted) {
          sonnerToast.error(t('settings.errors.loadInitialSettings'));
          // Even on error, mark initial load as complete to prevent saves
          setIsInitialLoadComplete(true);
        }
      }
    };

    void loadInitialSettings();

    // Cleanup function to prevent state updates after unmount
    return () => {
      isMounted = false;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps -- deps are intentionally limited
  }, [open]); // Only depend on 'open' - preload functions called once per session via ref

  // Load models when needed
  useEffect(() => {
    if (open && !isPreloadingModels) {
      void preloadLocalModelsData();
    }
  }, [open, isPreloadingModels, preloadLocalModelsData]);

  // Log when viewing providers tab
  useEffect(() => {
    if (open && activeTab === 'remote-providers') {
      // Providers tab is visible; data already preloaded on dialog open
    }
  }, [open, activeTab, providers.length]);

  // Load models when switching to local-ai tab
  useEffect(() => {
    if (open && activeTab === 'local-ai' && !isPreloadingModels) {
      void preloadLocalModelsData();
    }
  }, [open, activeTab, isPreloadingModels, preloadLocalModelsData]);

  // Auto-save settings when they change
  useEffect(() => {
    const debounceTimeout = setTimeout(() => {
      if (generalSettingsChanged && isInitialLoadComplete) {
        void saveGeneralSettingsStable();
      }
    }, 1000);

    return () => clearTimeout(debounceTimeout);
  }, [
    generalSettingsChanged,
    isInitialLoadComplete,
    saveGeneralSettingsStable,
    autoTitleGenerate,
    enableLinks,
    proxyAddress,
    appearance,
    accentColor,
    fontStyle,
    fontSettings.codeTheme,
    fontSettings.fontSize,
    showReasoningIndicators,
    ragStrategy,
    ragOrchestrator,
    useOrchestrator,
    ragTracingEnabled,
    renderingModules,
    // missing these meant the debounce
    // timer wasn't reset on the LAST change before close, so the
    // pending save fired with stale values and the new selection was
    // never persisted.
    responseFormality,
    responseDomainFocus,
    simpleModeEnabled,
    defaultAgentProfileSlug,
    voiceOpenaiApiKey,
    language, // Add language dependency to trigger auto-save on language changes
  ]);

  useEffect(() => {
    const debounceTimeout = setTimeout(() => {
      if (open && modelSettingsChanged) {
        void saveModelSettingsStable();
      }
    }, 1000);

    return () => clearTimeout(debounceTimeout);
  }, [open, modelSettingsChanged, saveModelSettingsStable]);

  useEffect(() => {
    const debounceTimeout = setTimeout(() => {
      if (open && promptSettingsChanged) {
        void savePromptSettingsStable();
      }
    }, 1000);

    return () => clearTimeout(debounceTimeout);
  }, [open, promptSettingsChanged, savePromptSettingsStable]);

  useEffect(() => {
    const debounceTimeout = setTimeout(() => {
      if (open && serviceSettingsChanged) {
        void saveServiceSettingsStable();
      }
    }, 1000);

    return () => clearTimeout(debounceTimeout);
  }, [open, serviceSettingsChanged, saveServiceSettingsStable]);

  // Function to open settings with specific tab (for cross-tab navigation)
  const openSettingsWithTab = useCallback((tab: SettingsTab) => {
    handleTabChange(tab);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- deps are intentionally limited
  }, []);

  const handleTabChange = (tab: SettingsTab, direction?: 'left' | 'right') => {
    // Don't change tabs if already animating
    if (isAnimating) return;

    // If it's the same tab, don't animate
    if (activeTab === tab) return;

    const adminOnlyTabs: SettingsTab[] = ['local-ai', 'service'];
    const isAdminOnlyTab = adminOnlyTabs.includes(tab);

    // For mobile sliding, allow animation to start even for admin-only tabs
    // We'll handle the admin check after the animation completes
    // Don't block if isAdmin is null (still loading)
    const shouldBlockImmediately = isAdminOnlyTab && isAdmin === false && !direction;

    if (shouldBlockImmediately) {
      sonnerToast.error(t('settings.adminOnlyRestriction'));
      return;
    }

    if (activeTab === 'general' && generalSettingsChanged)
      void saveGeneralSettingsStable();
    else if (activeTab === 'prompts' && promptSettingsChanged)
      void savePromptSettingsStable();
    else if (activeTab === 'service' && serviceSettingsChanged)
      void saveServiceSettingsStable();

    // Preload providers data when opening remote providers tab
    if (tab === 'remote-providers') void preloadProvidersData();

    if (tab === 'local-ai') void preloadLocalModelsData();

    if (tab === 'workspaces') void preloadWorkspacesData();

    if (tab === 'account') void preloadAccountData();

    // Start animation on mobile
    if (effectiveNarrow && direction) {
      setIsAnimating(true);
      setSlideDirection(direction);
      setNextTab(tab);
      setDragOffset(0);
      setIsDragging(false);

      // Change tab after a brief delay to allow animation setup
      setTimeout(() => {
        // Check admin permissions during animation for admin-only tabs
        // Only block if isAdmin is explicitly false (not null/loading)
        if (isAdminOnlyTab && isAdmin === false) {
          // Show error and revert to previous tab
          sonnerToast.error(t('settings.adminOnlyRestriction'));
          // Don't change the tab, animation will revert
          return;
        }
        setActiveTab(tab);
      }, 50);

      // End animation after transition completes
      setTimeout(() => {
        setIsAnimating(false);
        setSlideDirection(null);
        setNextTab(null);

        // Final admin check - if user somehow got to admin tab without permission, revert
        // Only revert if isAdmin is explicitly false (not null/loading)
        if (isAdminOnlyTab && isAdmin === false) {
          setActiveTab('general'); // Revert to safe tab
        }
      }, 350); // Match CSS transition duration + delay
    } else {
      setActiveTab(tab);
    }

    // Auto-scroll to center the active tab on mobile
    if (effectiveNarrow) {
      setTimeout(() => {
        const tabElement = document.querySelector(`[data-tab-id="${tab}"]`);
        if (tabElement) {
          tabElement.scrollIntoView({
            behavior: 'smooth',
            block: 'nearest',
            inline: 'center',
          });
        }
      }, 100);
    }
  };


  // Touch swipe handlers for mobile tab navigation
  const minSwipeDistance = 80; // Increased from 50 to make horizontal swipes less sensitive
  const maxDragDistance = window.innerWidth * 0.2; // 20% of screen width
  const minHorizontalMovement = 30; // Minimum horizontal movement before considering it a swipe
  const maxVerticalToHorizontalRatio = 2; // If vertical movement is more than 2x horizontal, it's vertical scroll

  const onTouchStart = (e: React.TouchEvent) => {
    if (!effectiveNarrow || isAnimating) return;

    // Check if touch started on an interactive element that should not trigger sliding
    const target = e.target as HTMLElement;
    const interactiveElements = ['BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'CANVAS', 'A'];
    const isInteractiveElement = interactiveElements.includes(target.tagName) ||
      target.closest('button, input, select, textarea, canvas, a, [role="button"]');

    // Don't start sliding if touching interactive elements
    if (isInteractiveElement) {
      return;
    }

    setTouchEnd(null);
    setTouchCurrent(null);
    setTouchStart({
      x: e.targetTouches[0].clientX,
      y: e.targetTouches[0].clientY
    });
    setDragOffset(0);
    setIsDragging(false);
    setIsVerticalScroll(false);
  };

  const onTouchMove = (e: React.TouchEvent) => {
    if (!effectiveNarrow || !touchStart || isAnimating) return;

    const currentX = e.targetTouches[0].clientX;
    const currentY = e.targetTouches[0].clientY;

    setTouchCurrent({ x: currentX, y: currentY });
    setTouchEnd({ x: currentX, y: currentY });

    const horizontalDistance = touchStart.x - currentX;
    const verticalDistance = Math.abs(touchStart.y - currentY);
    const horizontalDistanceAbs = Math.abs(horizontalDistance);

    // Detect if this is primarily a vertical scroll gesture
    if (!isVerticalScroll && (horizontalDistanceAbs > 5 || verticalDistance > 5)) {
      const isVertical = verticalDistance > horizontalDistanceAbs * maxVerticalToHorizontalRatio;
      if (isVertical) {
        setIsVerticalScroll(true);
        return; // Don't interfere with vertical scrolling
      }
    }

    // If we've determined this is vertical scrolling, don't process horizontal gestures
    if (isVerticalScroll) return;

    // Only process horizontal gestures if horizontal movement is significant enough
    if (horizontalDistanceAbs < minHorizontalMovement) return;

    const currentIndex = renderedTabs.findIndex(tab => tab.id === activeTab);

    // Only allow dragging if there's a valid next/previous tab
    const canGoNext = horizontalDistance > 0 && currentIndex < renderedTabs.length - 1;
    const canGoPrev = horizontalDistance < 0 && currentIndex > 0;

    if (canGoNext || canGoPrev) {
      const clampedDistance = Math.max(-maxDragDistance, Math.min(maxDragDistance, horizontalDistance));
      setDragOffset(clampedDistance);
      setIsDragging(horizontalDistanceAbs > minHorizontalMovement);

      // Set next tab for preview during drag
      if (horizontalDistanceAbs > minHorizontalMovement) {
        if (canGoNext && horizontalDistance > 0) {
          setNextTab(renderedTabs[currentIndex + 1].id as SettingsTab);
          setSlideDirection('left');
        } else if (canGoPrev && horizontalDistance < 0) {
          setNextTab(renderedTabs[currentIndex - 1].id as SettingsTab);
          setSlideDirection('right');
        }
      }
    }
  };

  const onTouchEnd = () => {
    if (!effectiveNarrow || !touchStart) return;

    // If this was determined to be a vertical scroll, don't process as horizontal swipe
    if (isVerticalScroll) {
      setTouchStart(null);
      setTouchEnd(null);
      setTouchCurrent(null);
      setIsVerticalScroll(false);
      return;
    }

    // If already animating, don't start a new animation
    if (isAnimating) {
      setTouchStart(null);
      setTouchEnd(null);
      setTouchCurrent(null);
      return;
    }

    const currentPos = touchCurrent || touchEnd;
    const distance = currentPos ? touchStart.x - currentPos.x : 0;
    const isLeftSwipe = distance > minSwipeDistance;
    const isRightSwipe = distance < -minSwipeDistance;

    if (isLeftSwipe || isRightSwipe) {
      const currentIndex = renderedTabs.findIndex(tab => tab.id === activeTab);

      if (isLeftSwipe && currentIndex < renderedTabs.length - 1) {
        // Swipe left - go to next tab (slide from right to left)
        handleTabChange(renderedTabs[currentIndex + 1].id as SettingsTab, 'left');
      } else if (isRightSwipe && currentIndex > 0) {
        // Swipe right - go to previous tab (slide from left to right)
        handleTabChange(renderedTabs[currentIndex - 1].id as SettingsTab, 'right');
      }
    } else {
      // Reset drag state if no swipe occurred
      setDragOffset(0);
      setIsDragging(false);
      setSlideDirection(null);
      setNextTab(null);
    }

    // Always clean up touch state
    setTouchStart(null);
    setTouchEnd(null);
    setTouchCurrent(null);
    setIsVerticalScroll(false);
  };

  const handleCloseDialog = (isOpen: boolean) => {
    if (!isOpen) {
      const savePromises = [];
      if (generalSettingsChanged)
        savePromises.push(saveGeneralSettingsStable());
      if (modelSettingsChanged) savePromises.push(saveModelSettingsStable());
      if (promptSettingsChanged) savePromises.push(savePromptSettingsStable());
      if (serviceSettingsChanged)
        savePromises.push(saveServiceSettingsStable());

      if (savePromises.length === 0) {
        onOpenChange(false);
        return;
      }
      Promise.all(savePromises)
        .then(() => {
          sonnerToast.success(t('general.settingsSaved'));
        })
        .catch(error => {
          console.error('Error saving settings on close:', error);
          sonnerToast.error(t('settings.errors.saveOnClose'));
        })
        .finally(() => onOpenChange(false));
      onOpenChange(isOpen);
    }
  };

  useEffect(() => {
    const adminOnlyTabs: SettingsTab[] = ['local-ai', 'service'];
    // Only revert if isAdmin is explicitly false (not null/loading)
    if (isAdmin === false && adminOnlyTabs.includes(activeTab as SettingsTab))
      setActiveTab('general');
  }, [isAdmin, activeTab]);

  useEffect(() => {
    const adminOnlyTabs: SettingsTab[] = ['local-ai', 'service'];
    // Allow admin tabs if isAdmin is true or still loading (null)
    if (isAdmin === true || !adminOnlyTabs.includes(defaultTab as SettingsTab)) {
      setActiveTab(defaultTab);
    } else if (isAdmin === false && adminOnlyTabs.includes(defaultTab as SettingsTab)) {
      setActiveTab('general');
    }
  }, [defaultTab, isAdmin]);

  const TABS: {
    id: SettingsTab;
    labelKey: string;
    icon: React.ElementType;
    adminOnly?: boolean;
  }[] = [
      { id: 'account', labelKey: 'settings.tabs.account', icon: Key },
      { id: 'general', labelKey: 'settings.tabs.general', icon: SettingsIcon },
      { id: 'voice', labelKey: 'settings.tabs.voice', icon: Mic },
      { id: 'mcp-integrations', labelKey: 'settings.tabs.mcpIntegrations', icon: Plug },
      { id: 'workspaces', labelKey: 'settings.tabs.workspaces', icon: LayoutGrid },
      {
        id: 'remote-providers',
        labelKey: 'settings.tabs.providers',
        icon: Server,
      },
      { id: 'documents', labelKey: 'settings.tabs.documents', icon: FileText },
      { id: 'prompts', labelKey: 'settings.tabs.prompts', icon: MessageSquare },
      // Admin-only tabs separated by divider
      {
        id: 'local-ai',
        labelKey: 'settings.tabs.localai',
        icon: Cpu,
        adminOnly: true,
      },
      {
        id: 'service',
        labelKey: 'settings.tabs.service',
        icon: Server,
        adminOnly: true,
      },
      {
        id: 'users',
        labelKey: 'settings.tabs.users',
        icon: Users,
        adminOnly: true,
      },
    ];

  // Separate regular tabs from admin tabs for rendering with divider
  const regularTabs = useMemo(
    () => TABS.filter(tab => !tab.adminOnly),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- deps are intentionally limited
    []
  );

  const adminTabs = useMemo(
    () => TABS.filter(tab => tab.adminOnly && (isAdmin === true || isAdmin === null)),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- deps are intentionally limited
    [isAdmin]
  );

  // Create the actual tab sequence used for rendering and navigation
  const renderedTabs = useMemo(
    () => [...regularTabs, ...adminTabs],
    [regularTabs, adminTabs]
  );

  const renderTabContent = (tabId: SettingsTab = activeTab) => {
    switch (tabId) {
      case 'general':
        return (
          <SettingsGeneralTab
            enableLinks={enableLinks}
            setEnableLinks={v => {
              setEnableLinks(v);
              setGeneralSettingsChanged(true);
            }}
            appearance={appearance}
            setAppearance={v => {
              setAppearance(v);
              setGeneralSettingsChanged(true);
            }}
            accentColor={accentColor}
            setAccentColor={v => {
              setAccentColor(v);
              setGeneralSettingsChanged(true);
            }}
            fontStyle={fontStyle}
            setFontStyle={v => {
              setFontStyle(v);
              setGeneralSettingsChanged(true);
            }}
            codeTheme={fontSettings.codeTheme}
            setCodeTheme={v => {
              fontSettings.setCodeTheme(v);
              setGeneralSettingsChanged(true);
            }}
            fontSize={fontSettings.fontSize}
            setFontSize={v => {
              fontSettings.setFontSize(isNaN(v) ? 14 : v);
              setGeneralSettingsChanged(true);
            }}
            showReasoningIndicators={showReasoningIndicators}
            setShowReasoningIndicators={v => {
              setShowReasoningIndicators(v);
              setGeneralSettingsChanged(true);
            }}
            ragStrategy={ragStrategy}
            setRagStrategy={v => {
              setRagStrategy(v);
              setGeneralSettingsChanged(true);
            }}
            ragOrchestrator={ragOrchestrator}
            setRagOrchestrator={v => {
              setRagOrchestrator(v);
              setGeneralSettingsChanged(true);
            }}
            useOrchestrator={useOrchestrator}
            setUseOrchestrator={v => {
              setUseOrchestrator(v);
              setGeneralSettingsChanged(true);
            }}
            useAgenticRouting={useAgenticRouting}
            setUseAgenticRouting={v => {
              setUseAgenticRouting(v);
              setGeneralSettingsChanged(true);
            }}
            ragTracingEnabled={ragTracingEnabled}
            setRagTracingEnabled={v => {
              setRagTracingEnabled(v);
              setGeneralSettingsChanged(true);
            }}
            defaultAgentProfileSlug={defaultAgentProfileSlug}
            setDefaultAgentProfileSlug={v => {
              setDefaultAgentProfileSlug(v);
              setGeneralSettingsChanged(true);
            }}
            simpleModeEnabled={simpleModeEnabled}
            setSimpleModeEnabled={v => {
              setSimpleModeEnabledState(v);
              // Mirror to localStorage immediately so other components
              // pick up the change without waiting for the next save.
              try { localStorage.setItem('scrapalot_simple_mode_enabled', String(v)); } catch { /* ignore */ }
              window.dispatchEvent(new CustomEvent('scrapalot:simple-mode-changed'));
              setGeneralSettingsChanged(true);
            }}
            responseLength={responseLength}
            setResponseLength={v => {
              setResponseLength(v);
              setGeneralSettingsChanged(true);
            }}
            responseFormality={responseFormality}
            setResponseFormality={v => {
              setResponseFormality(v);
              setGeneralSettingsChanged(true);
            }}
            responseDomainFocus={responseDomainFocus}
            setResponseDomainFocus={v => {
              setResponseDomainFocus(v);
              setGeneralSettingsChanged(true);
            }}
            renderingModules={renderingModules}
            setRenderingModules={v => {
              setRenderingModules(v);
              setGeneralSettingsChanged(true);
            }}
            isSaving={isSaving}
            lastSaved={lastSaved}
          />
        );
      case 'voice':
        return (
          <SettingsVoiceTab
            voiceOpenaiApiKey={voiceOpenaiApiKey}
            setVoiceOpenaiApiKey={v => {
              setVoiceOpenaiApiKey(v);
              setGeneralSettingsChanged(true);
            }}
          />
        );
      case 'mcp-integrations':
        return <SettingsMcpIntegrationsTab />;
      case 'workspaces':
        return (
          <SettingsWorkspacesTab
            preloadedWorkspaces={preloadedWorkspaces}
            preloadedWorkspaceCollections={preloadedWorkspaceCollections}
            isPreloadingWorkspaces={isPreloadingWorkspaces}
          />
        );
      case 'documents':
        return (
          <div id='documents-tab-content'>
            <DocumentsSettingsTab
              selectedTab={activeTab}
              onSave={() => setLastSaved(new Date())}
              onChange={() => {}}
              openSettingsWithTab={openSettingsWithTab}
            />
          </div>
        );
      case 'local-ai':
        return (isAdmin === true || isAdmin === null) ? (
          <SettingsLocalAITab
            showModels={showModels}
            setShowModels={setShowModels}
            modelsDirectory={modelsDirectory}
            setModelsDirectory={setModelsDirectory}
            openLocalAIModelsDialog={() => setIsLocalAIModelsDialogOpen(true)}
            maxParallelChats={maxParallelChats}
            setMaxParallelChats={setMaxParallelChats}
            useAdvancedConfig={useAdvancedConfig}
            setUseAdvancedConfig={setUseAdvancedConfig}
            advancedConfigJson={advancedConfigJson}
            setAdvancedConfigJson={setAdvancedConfigJson}
            isActive={activeTab === 'local-ai'}
          />
        ) : (
          <div className='p-6 flex flex-col items-center justify-center space-y-4 text-center'>
            {' '}
            <Shield className='h-16 w-16 text-amber-500 mb-2' />{' '}
            <h3 className='text-xl font-semibold'>
              {t('settings.adminOnly.title')}
            </h3>{' '}
            <p className='text-zinc-500 dark:text-zinc-400 max-w-md'>
              {t('settings.adminOnly.description')}
            </p>{' '}
            <div className='bg-amber-50 dark:bg-amber-900/20 p-4 border border-amber-200 dark:border-amber-800 flex items-start space-x-3 max-w-md text-left'>
              {' '}
              <AlertTriangle className='h-5 w-5 text-amber-600 dark:text-amber-400 mt-0.5 flex-shrink-0' />{' '}
              <div>
                {' '}
                <p className='text-sm text-amber-800 dark:text-amber-300'>
                  {t('settings.adminOnly.explainLocalAI')}
                </p>{' '}
              </div>{' '}
            </div>{' '}
          </div>
        );
      case 'service':
        return (isAdmin === true || isAdmin === null) ? (
          <SettingsTabService
            autoTitleGenerate={autoTitleGenerate}
            setAutoTitleGenerate={v => {
              setAutoTitleGenerate(v);
              setGeneralSettingsChanged(true);
            }}
            proxyAddress={proxyAddress}
            setProxyAddress={v => {
              setProxyAddress(v);
              setGeneralSettingsChanged(true);
            }}
          />
        ) : (
          <div className='p-6 flex flex-col items-center justify-center space-y-4 text-center'>
            {' '}
            <Shield className='h-16 w-16 text-amber-500 mb-2' />{' '}
            <h3 className='text-xl font-semibold'>
              {t('settings.adminOnly.title')}
            </h3>{' '}
            <p className='text-zinc-500 dark:text-zinc-400 max-w-md'>
              {t('settings.adminOnly.description')}
            </p>{' '}
            <div className='bg-amber-50 dark:bg-amber-900/20 p-4 border border-amber-200 dark:border-amber-800 flex items-start space-x-3 max-w-md text-left'>
              {' '}
              <AlertTriangle className='h-5 w-5 text-amber-600 dark:text-amber-400 mt-0.5 flex-shrink-0' />{' '}
              <div>
                {' '}
                <p className='text-sm text-amber-800 dark:text-amber-300'>
                  {t('settings.adminOnly.explainService')}
                </p>{' '}
              </div>{' '}
            </div>{' '}
          </div>
        );
      case 'users':
        return (isAdmin === true || isAdmin === null) ? (
          <SettingsTabUsers isMobile={effectiveNarrow} />
        ) : (
          <div className='p-6 flex flex-col items-center justify-center space-y-4 text-center'>
            {' '}
            <Shield className='h-16 w-16 text-amber-500 mb-2' />{' '}
            <h3 className='text-xl font-semibold'>
              {t('settings.adminOnly.title')}
            </h3>{' '}
            <p className='text-zinc-500 dark:text-zinc-400 max-w-md'>
              {t('settings.adminOnly.description')}
            </p>{' '}
            <div className='bg-amber-50 dark:bg-amber-900/20 p-4 border border-amber-200 dark:border-amber-800 flex items-start space-x-3 max-w-md text-left'>
              {' '}
              <AlertTriangle className='h-5 w-5 text-amber-600 dark:text-amber-400 mt-0.5 flex-shrink-0' />{' '}
              <div>
                {' '}
                <p className='text-sm text-amber-800 dark:text-amber-300'>
                  {t('settings.adminOnly.explainUsers')}
                </p>{' '}
              </div>{' '}
            </div>{' '}
          </div>
        );
      case 'remote-providers':
        return (
          <SettingsRemoteProvidersTab
            providers={providers}
            loading={providersLoading}
            handleAddProvider={() => {
              setEditingProvider(null);
              setIsAddSheetOpen(true);
            }}
            handleEditProvider={provider => {
              // Set guard to prevent immediate closing from dropdown
              sheetOpeningGuard.current = true;
              setEditingProvider(provider);
              setIsEditSheetOpen(true);
            }}
            isMobile={effectiveNarrow}
            updateProvider={wrappedUpdateProvider}
            deleteProvider={wrappedDeleteProvider}
            fetchProviders={fetchProviders}
          />
        );
      case 'prompts':
        return (
          <SettingsPromptsTab
            defaultSystemPrompt={defaultPrompt}
            setDefaultSystemPrompt={val => {
              setDefaultPrompt(val);
              // Only mark as changed if this is a user-initiated change (after an initial load)
              if (isInitialLoadComplete) {
                setPromptSettingsChanged(true);
              }
            }}
            defaultTemplate={defaultTemplate}
            setDefaultTemplate={val => {
              setDefaultTemplate(val);
              // Only mark as changed if this is a user-initiated change (after an initial load)
              if (isInitialLoadComplete) {
                setPromptSettingsChanged(true);
              }
            }}
            customTemplates={customTemplates}
            addCustomTemplate={(name, content, examples) => {
              setCustomTemplates([...customTemplates, { name, content, examples }]);
              // Only mark as changed if this is a user-initiated change (after an initial load)
              if (isInitialLoadComplete) {
                setPromptSettingsChanged(true);
              }
            }}
            updateCustomTemplate={(index, name, content, examples) => {
              const newTemplates = [...customTemplates];
              newTemplates[index] = { name, content, examples };
              setCustomTemplates(newTemplates);
              // Only mark as changed if this is a user-initiated change (after an initial load)
              if (isInitialLoadComplete) {
                setPromptSettingsChanged(true);
              }
            }}
            deleteCustomTemplate={index => {
              setCustomTemplates(customTemplates.filter((_, i) => i !== index));
              // Only mark as changed if this is a user-initiated change (after an initial load)
              if (isInitialLoadComplete) {
                setPromptSettingsChanged(true);
              }
            }}
            isMobile={effectiveNarrow}
          />
        );
      case 'account':
        return (
          <SettingsAccountTab
            isMobile={effectiveNarrow}
            preloadedUser={preloadedUser}
            preloadedSubscription={preloadedSubscription}
            preloadedStorageQuota={preloadedStorageQuota}
            isPreloadingAccount={isPreloadingAccount}
            onSavingChange={setIsSaving}
            onSaved={() => setLastSaved(new Date())}
          />
        );
      default:
        return (
          <div className='flex items-center justify-center h-full'>
            <p className='text-zinc-600 dark:text-zinc-400'>
              {t('settings.noTabSelected')}
            </p>{' '}
          </div>
        );
    }
  };

  return (
    <>
      <Dialog open={open} onOpenChange={handleCloseDialog} modal={!isAnyDrawerOpen}>
        <DialogContent
          data-testid="settings-dialog"
          className={cn(
            'w-full p-0 bg-card dark:bg-black border border-border dark:border-zinc-800 overflow-visible z-[1050]',
            isNarrowScreen
              ? 'h-full max-h-[100vh] max-w-full rounded-none !inset-0 !left-0 !top-0 !translate-x-0 !translate-y-0 !transform-none'
              : isSplitScreen
                ? cn(
                    'h-full max-h-[100vh] !max-w-none p-0 rounded-none !top-0 !bottom-0 !translate-x-0 !translate-y-0 !transform-none',
                    isDrawerOnLeft
                      ? '!left-[50vw] !w-[50vw]'
                      : '!left-[70px] !w-[calc(50vw-70px)]'
                  )
                : isMaximized
                  ? '!max-w-none !max-h-none p-0'
                  : 'w-[80vw] min-w-[1400px] max-w-[95vw] h-[90vh]'
          )}
          overlayZIndex="1000"
          overlayClassName={isSplitScreen ? '!bg-transparent' : undefined}
          disablePointerEvents={false}
          disableBackdropClose={true}
          hideCloseButton={effectiveNarrow}
          forceMobileBackButton={effectiveNarrow}
          dialogOpen={open}
          onOpenChange={handleCloseDialog}
          allowMaximize={!isNarrowScreen && !isSplitScreen}
          isMaximized={isMaximized}
          onMaximizeChange={setIsMaximized}
        >
          <DialogTitle className='sr-only'>{t('settings.title')}</DialogTitle>
          <div className='h-full overflow-hidden'>
            <div className={cn('flex h-full overflow-hidden', effectiveNarrow ? 'flex-col' : 'flex-row')}>
              {/* Tabs - Top horizontal on mobile/tablet, left sidebar on desktop */}

              {/* Mobile/Tablet Horizontal Tabs (visible when narrow or split-screen) */}
              {effectiveNarrow && <div className='bg-zinc-100 dark:bg-zinc-800 border-b border-zinc-300 dark:border-black'>
                <div className='flex gap-2 overflow-x-auto scrollbar-hide scroll-smooth'>
                  {regularTabs.map(tab => (
                    <div
                      key={tab.id}
                      data-tab-id={tab.id}
                      data-testid={`settings-tab-${tab.id}`}
                      className={cn(
                        'flex items-center gap-2 px-2 py-2 h-14 cursor-pointer transition-colors whitespace-nowrap flex-shrink-0 rounded-md',
                        activeTab === tab.id
                          ? 'text-zinc-800 dark:text-white bg-zinc-300 dark:bg-zinc-950 font-medium'
                          : 'text-zinc-600 dark:text-gray-300 hover:bg-zinc-200 dark:hover:bg-zinc-700'
                      )}
                      onClick={() => handleTabChange(tab.id as SettingsTab)}
                    >
                      <tab.icon className='w-4 h-4 flex-shrink-0' />
                      <span className='text-sm'>{t(tab.labelKey)}</span>
                    </div>
                  ))}
                  {/* Vertical divider for admin tabs on mobile */}
                  {adminTabs.length > 0 && (
                    <>
                      <div className='min-w-px w-px bg-zinc-300 dark:bg-zinc-700 mx-2 self-stretch flex-shrink-0' />
                      {adminTabs.map(tab => (
                        <div
                          key={tab.id}
                          data-tab-id={tab.id}
                          className={cn(
                            'flex items-center gap-2 px-2 py-2 h-14 cursor-pointer transition-colors whitespace-nowrap flex-shrink-0 rounded-md',
                            activeTab === tab.id
                              ? 'text-zinc-800 dark:text-white bg-zinc-300 dark:bg-zinc-950 font-medium'
                              : 'text-zinc-600 dark:text-gray-300 hover:bg-zinc-200 dark:hover:bg-zinc-700'
                          )}
                          onClick={() => handleTabChange(tab.id as SettingsTab)}
                        >
                          <tab.icon className='w-4 h-4 flex-shrink-0' />
                          <span className='text-sm'>{t(tab.labelKey)}</span>
                        </div>
                      ))}
                    </>
                  )}
                </div>
              </div>}

              {/* Desktop Sidebar Tabs (visible when not narrow and not split-screen) */}
              {/* flex-col + min-h-0 so the tab list below can actually shrink and
                  scroll on short viewports — without it the 11 tabs overflow past
                  the dialog edge and the bottom entries (Service/Users) are
                  unreachable. Native overflow-y-auto per project rule #23. */}
              {!effectiveNarrow && <div className='w-72 bg-zinc-100 dark:bg-zinc-800 border-r border-zinc-300 dark:border-zinc-800 flex flex-col min-h-0'>
                <h3 className='shrink-0 text-lg font-medium text-zinc-800 dark:text-white mb-2 px-4 pt-4'>
                  {t('settings.title')}
                </h3>
                <div className='flex flex-col space-y-2 p-4 flex-1 min-h-0 overflow-y-auto'>
                  {regularTabs.map(tab => (
                    <div
                      key={tab.id}
                      data-tab-id={tab.id}
                      data-testid={`settings-tab-${tab.id}`}
                      className={cn(
                        'flex items-center gap-3 px-2 py-2 h-14 cursor-pointer transition-colors rounded-md',
                        activeTab === tab.id
                          ? 'text-zinc-800 dark:text-white bg-zinc-300 dark:bg-zinc-950 font-medium'
                          : 'text-zinc-600 dark:text-gray-300 hover:bg-zinc-200 dark:hover:bg-zinc-700'
                      )}
                      onClick={() => handleTabChange(tab.id as SettingsTab)}
                    >
                      <tab.icon className='w-5 h-5 flex-shrink-0' />
                      <span>{t(tab.labelKey)}</span>
                    </div>
                  ))}
                  {/* Horizontal divider for admin tabs on desktop */}
                  {adminTabs.length > 0 && (
                    <>
                      <div className='h-px bg-zinc-300 dark:bg-zinc-700 my-4' />
                      {adminTabs.map(tab => (
                        <div
                          key={tab.id}
                          data-tab-id={tab.id}
                          className={cn(
                            'flex items-center gap-3 px-2 py-2 h-14 cursor-pointer transition-colors rounded-md',
                            activeTab === tab.id
                              ? 'text-zinc-800 dark:text-white bg-zinc-300 dark:bg-zinc-950 font-medium'
                              : 'text-zinc-600 dark:text-gray-300 hover:bg-zinc-200 dark:hover:bg-zinc-700'
                          )}
                          onClick={() => handleTabChange(tab.id as SettingsTab)}
                        >
                          <tab.icon className='w-5 h-5 flex-shrink-0' />
                          <span>{t(tab.labelKey)}</span>
                        </div>
                      ))}
                    </>
                  )}
                </div>
              </div>}

              <div className='flex-1 flex flex-col overflow-hidden relative'>
                <div
                  data-testid="settings-tab-content"
                  className={cn(
                    'flex-1 relative',
                    effectiveNarrow ? 'overflow-hidden' : 'overflow-y-auto p-6 pr-8 pb-[55px]'
                  )}
                  onTouchStart={onTouchStart}
                  onTouchMove={onTouchMove}
                  onTouchEnd={onTouchEnd}
                  style={{ touchAction: 'pan-y pinch-zoom' }} // Allow vertical scrolling but enable horizontal gestures
                >
                  {effectiveNarrow ? (
                    <div className='relative w-full h-full overflow-hidden'>
                      {/* Container that slides horizontally */}
                      <div
                        className={cn(
                          'flex w-full h-full',
                          isAnimating ? 'transition-transform duration-300 ease-out' : '',
                          isDragging ? 'transition-none' : ''
                        )}
                        style={{
                          transform: (() => {
                            if (isDragging) {
                              // Follow finger during drag
                              return `translateX(${-dragOffset}px)`;
                            } else if (isAnimating && slideDirection) {
                              // Animate to show new tab
                              return slideDirection === 'left'
                                ? 'translateX(-100%)' // Slide left to show next tab
                                : 'translateX(100%)';  // Slide right to show previous tab
                            }
                            return 'translateX(0)';
                          })()
                        }}
                      >
                        {/* Previous tab (for right swipe) */}
                        {((isAnimating || isDragging) && slideDirection === 'right' && nextTab) && (
                          <div className='w-full h-full flex-shrink-0 p-4 pb-20 overflow-y-auto'>
                            {renderTabContent(nextTab)}
                          </div>
                        )}

                        {/* Current tab */}
                        <div className='w-full h-full flex-shrink-0 p-4 pb-[55px] overflow-y-auto'>
                          {renderTabContent()}
                        </div>

                        {/* Next tab (for left swipe) */}
                        {((isAnimating || isDragging) && slideDirection === 'left' && nextTab) && (
                          <div className='w-full h-full flex-shrink-0 p-4 pb-20 overflow-y-auto'>
                            {renderTabContent(nextTab)}
                          </div>
                        )}
                      </div>
                    </div>
                  ) : (
                    renderTabContent()
                  )}
                </div>
                <div data-testid="settings-save-indicator" className='absolute bottom-0 left-0 right-0 p-2 border-t border-border dark:border-zinc-800 flex justify-end text-sm text-muted-foreground dark:text-zinc-400 bg-background/50 dark:bg-zinc-900/50 backdrop-blur-sm z-10 min-h-[2.5rem]'>
                  {isSaving ? (
                    <span className='text-blue-500'>{t('general.saving')}</span>
                  ) : lastSaved ? (
                    <span>
                      {t('general.saved')}: {lastSaved.toLocaleTimeString()}
                    </span>
                  ) : (
                    <span className='opacity-0'>&nbsp;</span>
                  )}
                </div>
              </div>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Unified component for Add/Edit providers */}
      <SettingsTabProvidersForm
        mode={editingProvider ? 'edit' : 'add'}
        provider={editingProvider}
        open={isEditSheetOpen || isAddSheetOpen}
        configuredProviders={providers}
        onOpenChange={isOpen => {
          if (!isOpen) {
            // Check guard - if it's set, this is an immediate close from dropdown
            // Ignore it and clear the guard
            if (sheetOpeningGuard.current) {
              sheetOpeningGuard.current = false;
              return;
            }
            setIsEditSheetOpen(false);
            setIsAddSheetOpen(false);
            setEditingProvider(null);
          }
        }}
        onClose={() => {
          // Clear guard on explicit close
          sheetOpeningGuard.current = false;
          setIsEditSheetOpen(false);
          setIsAddSheetOpen(false);
          setEditingProvider(null);
        }}
        onSubmit={async provider => {
          if (editingProvider) {
            // Update existing provider - use editingProvider.id since it's guaranteed to exist
            // The provider parameter from form may not have id populated correctly
            await wrappedUpdateProvider(editingProvider.id!, provider as RemoteProvider);
            setIsEditSheetOpen(false);
            setEditingProvider(null);
            // Force full refresh from backend — wrappedUpdateProvider already cleared cache,
            // but updateProvider sets stale globalProviders. Reset again and fetch.
            const { clearProviderCache: clearCache } = await import('@/hooks/useProviders');
            clearCache();
            setTimeout(() => fetchProviders(true), 500);
          } else {
            // Add new provider - provider can be partial (missing id)
            await wrappedAddProvider(provider as Partial<RemoteProvider>);
            setIsAddSheetOpen(false);
            // Force refresh providers list from backend after add
            setTimeout(() => fetchProviders(true), 500);
          }
        }}
      />
      <SettingsTabProvidersLocal
        open={isLocalAIModelsDialogOpen}
        onOpenChange={setIsLocalAIModelsDialogOpen}
        preloadedFeaturedModels={featuredModels}
        preloadedInstalledModels={installedModels}
        isAdmin={isAdmin}
      />
    </>
  );
};
export default Settings;
