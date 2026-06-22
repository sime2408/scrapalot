import { useCallback, useEffect, useRef, useState } from 'react';
import { DocumentCollection, Message, Model, Session, SendMessageOptions } from '@/types';
import { streamChat } from '@/lib/api';
import { ChatRequest, ChatStreamResponse } from '@/types/api-types';
import { useAuth } from '@/hooks/use-auth';
import { toast } from '@/lib/toast-compat';
import { getIconForProvider } from '@/lib/api-llm-inference';
import { modelSelections, userPrefs, uiState } from '@/lib/storage-utils';
import { v4 as uuidv4 } from 'uuid';
import { useModels } from '@/contexts/models-context';
import { listSessions } from '@/lib/api-sessions';
import { getSessionMessages, getSessionMessagesPage } from '@/lib/api-messages';
import { useTranslation } from 'react-i18next';
import { parseStatusMessage } from '@/lib/status-message-parser';
import { loadingService } from '@/lib/loading-service';
import { useDeepResearchPanel } from '@/contexts/deep-research-context';
import { usePDFViewer } from '@/contexts/pdf-viewer-context';
import { useEpubViewer } from '@/contexts/epub-viewer-context';
import { RagTraceData } from '@/types/rag-trace';

/** Shape of a message as returned by the backend API */
interface BackendMessage {
  id: string;
  role: string;
  content: string;
  created_at?: string;
  metadata?: string | Record<string, unknown>;
  message_metadata?: string | Record<string, unknown>;
}

/** Shape of a streaming chunk/packet from the chat API */
interface StreamChunk {
  ind?: number;
  obj?: {
    type?: string;
    content?: string | Record<string, unknown>;
    stage?: string;
    error_code?: string;
    system_prompt_preview?: string;
    system_prompt_length?: number;
    context_document_count?: number;
    context_token_estimate?: number;
    history_message_count?: number;
    has_conversation_summary?: boolean;
    context_window_size?: number;
    strategy_name?: string;
    collection_names?: string[];
    total_tokens?: number;
    input_tokens?: number;
    output_tokens?: number;
    tokens_per_second?: number;
    citation_num?: number;
    document_id?: string;
    document_title?: string;
    source?: string;
    file_path?: string;
    url?: string;
    page?: number;
    chunk_index?: number;
    text?: string;
    score?: number;
    [key: string]: unknown;
  };
  type?: string;
  content?: string;
  stage?: string;
  error_code?: string;
  [key: string]: unknown;
}

const useSessionManagement = (
  initialSessions: Session[],
  initialSelectedId: string | null,
  initialModel: Model | null,
  sessionState?: string | null
) => {
  const deepResearchPanel = useDeepResearchPanel();
  const deepResearchPanelRef = useRef(deepResearchPanel);
  deepResearchPanelRef.current = deepResearchPanel;

  const [sessions, setSessions] = useState<Session[]>(initialSessions);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(
    initialSelectedId
  );
  const [isLoading, setIsLoading] = useState(false);
  const [streamingContent, setStreamingContent] = useState('');
  const [selectedModel, setSelectedModel] = useState<Model | null>(
    initialModel
  );
  const [selectedCollection, setSelectedCollection] =
    useState<DocumentCollection | null>(null);
  const [selectedCollections, setSelectedCollections] = useState<
    DocumentCollection[]
  >([]);
  // For tracking session IDs for each conversation
  const [sessionMap, setSessionMap] = useState<Record<string, string>>({});
  // Flag to track stream completion
  const [streamEnded, setStreamEnded] = useState(false);
  // True only when AI is actively responding (sendMessage), not during session message loading
  const [isAiResponding, setIsAiResponding] = useState(false);
  // Status message for thinking/processing
  const [statusMessage, setStatusMessage] = useState<{ content: string; stage?: string } | null>(null);
  // History of processing steps for the current stream
  const [stageHistory, setStageHistory] = useState<Array<{ content: string; stage?: string; timestamp: number }>>([]);
  // Track streaming loading ID for centralized loading service
  const streamingLoadingIdRef = useRef<string | null>(null);
  // Track thinking time
  // Use a ref, not state: the streaming chunk handler is a closure created
  // once per request. With useState the captured `thinkStartTime` stays at its
  // initial value (null) for the whole stream, so `stream_end` never computed
  // the elapsed time and `thinkingTimeMs` stuck at 0 → "Calculating..." forever.
  // A ref is read/written synchronously and is immune to the stale closure.
  const thinkStartTimeRef = useRef<number | null>(null);
  const [thinkingTimeMs, setThinkingTimeMs] = useState(0);
  // Follow-up suggestions from @-mentioned document (set by 'suggestions' packet handler)
  const [followUpSuggestions, setFollowUpSuggestions] = useState<string[]>([]);
  const [suggestionDocumentId, setSuggestionDocumentId] = useState<string>('');
  // Chart data from generate_chart tool (set by 'chart_data' packet handler)
  // Use ref instead of state to avoid stale closure in stream completion callback
  const pendingChartDataRef = useRef<Record<string, unknown> | null>(null);
  // Counter that increments every time refreshSessions runs — used to trigger sidebar re-sort
  const [sidebarRefreshCount, setSidebarRefreshCount] = useState(0);

  // Chat stream cancellation reference
  const cancelStreamRef = useRef<(() => void) | null>(null);
  // Ref to prevent duplicate stream completion handling
  const streamCompletedRef = useRef<boolean>(false);
  // Timestamp when stream recently completed - used to prevent refreshSessions race condition
  const streamRecentlyCompletedRef = useRef<number>(0);
  // RAG trace data collected per-message from streaming packets
  const ragTraceMapRef = useRef<Map<string, RagTraceData>>(new Map());
  // Ref for current selected session ID - used in async closures to check if session changed
  const selectedSessionIdRef = useRef<string | null>(selectedSessionId);
  const { isAuthenticated, isLoading: authLoading, user } = useAuth();
  const { t, i18n } = useTranslation();

  // Keep selectedSessionIdRef in sync with state
  useEffect(() => {
    selectedSessionIdRef.current = selectedSessionId;
  }, [selectedSessionId]);

  // Get open viewer states to enable direct document RAG
  const pdfViewer = usePDFViewer();
  const epubViewer = useEpubViewer();

  // Ref to track last refresh time to prevent too frequent refreshes
  const lastRefreshTimeRef = useRef<number>(0);
  const MIN_REFRESH_INTERVAL = 5000; // Minimum 5 seconds between refreshes


  // Safety mechanism: Auto-reset isLoading if stream has ended but isLoading is still true
  useEffect(() => {
    if (streamEnded && isLoading && !cancelStreamRef.current) {
      console.warn('⚠️ Safety reset: Stream ended but isLoading still true, resetting...');
      setIsLoading(false);
      setMessageStreamingInProgress(false);
      
      // Stop centralized loading service in safety reset
      if (streamingLoadingIdRef.current) {
        loadingService.stopStreaming(streamingLoadingIdRef.current);
        streamingLoadingIdRef.current = null;
      }
    }
  }, [streamEnded, isLoading]);

  // Additional safety: Reset isLoading if no streaming content and stream ended
  useEffect(() => {
    if (isLoading && !streamingContent && streamEnded && !cancelStreamRef.current) {
      console.warn('⚠️ Safety reset: No streaming content but isLoading is true, resetting...');
      setIsLoading(false);
      setMessageStreamingInProgress(false);
    }
  }, [isLoading, streamingContent, streamEnded]);

  // LRU Message Cache - stores preloaded messages with size limit to prevent browser overload
  // Maximum 10 sessions cached, oldest entries removed automatically
  const MAX_CACHED_SESSIONS = 10;
  const messagesCache = useRef<Record<string, Message[]>>({});
  const cacheAccessOrder = useRef<string[]>([]); // Track access order for LRU eviction
  const preloadingSessionsRef = useRef<Set<string>>(new Set());

  // Helper function to add to cache with LRU eviction
  const addToCache = useCallback((sessionId: string, messages: Message[]) => {
    // Remove if already exists (will re-add to end)
    cacheAccessOrder.current = cacheAccessOrder.current.filter(id => id !== sessionId);

    // Add to end (most recently used)
    cacheAccessOrder.current.push(sessionId);

    // If cache is too large, evict oldest entries
    while (cacheAccessOrder.current.length > MAX_CACHED_SESSIONS) {
      const oldestSessionId = cacheAccessOrder.current.shift();
      if (oldestSessionId) {
        delete messagesCache.current[oldestSessionId];
      }
    }

    // Add messages to cache
    messagesCache.current[sessionId] = messages;
  }, []);

  // Helper function to get from cache and update access order
  const getFromCache = useCallback((sessionId: string): Message[] | null => {
    if (messagesCache.current[sessionId]) {
      // Update access order (move to end)
      cacheAccessOrder.current = cacheAccessOrder.current.filter(id => id !== sessionId);
      cacheAccessOrder.current.push(sessionId);
      return messagesCache.current[sessionId];
    }
    return null;
  }, []);

  // Helper function to evict a single session from the cache
  const removeFromCache = useCallback((sessionId: string) => {
    delete messagesCache.current[sessionId];
    cacheAccessOrder.current = cacheAccessOrder.current.filter(id => id !== sessionId);
  }, []);

  // Cleanup cache on unmount
  useEffect(() => {
    return () => {
      messagesCache.current = {};
      cacheAccessOrder.current = [];
    };
  }, []);

  // Subscribe to WebSocket notifications for session title updates
  useEffect(() => {
    if (!isAuthenticated || !user?.id) return;

    let unsubscribe: (() => void) | null = null;

    const setupWebSocketSubscription = async () => {
      try {
        const stompService = (await import('@/lib/stomp-service')).default;

        // Subscribe to workspace notifications
        unsubscribe = await stompService.subscribeToWorkspaceNotifications(
          user.id,
          (message: Record<string, unknown>) => {
            if (message.notification_type === 'session_title_updated') {
              const data = message.data as { session_id?: string; title?: string };
              const { session_id, title } = data || {};

              if (session_id && title) {
                // Update the session in the sessions list
                setSessions(prevSessions =>
                  prevSessions.map(session =>
                    session.id === session_id
                      ? { ...session, title, conversation_name: title }
                      : session
                  )
                );
              }
            }
          }
        );

      } catch (error) {
        console.error('❌ Failed to subscribe to workspace notifications:', error);
      }
    };

    void setupWebSocketSubscription();

    return () => {
      if (unsubscribe) {
        unsubscribe();
      }
    };
  }, [isAuthenticated, user]);

  // State to track message loading
  const [messagesPage, setMessagesPage] = useState(1);
  const [hasMoreMessages, setHasMoreMessages] = useState(false);
  const [loadingMoreMessages, setLoadingMoreMessages] = useState(false);
  // Deepest 1-based history page loaded per session (1 = newest window). Drives
  // load-more: the next page to fetch is loadedPageRef.current[sessionId] + 1.
  const loadedPageRef = useRef<Record<string, number>>({});
  const [_messageStreamingInProgress, setMessageStreamingInProgress] =
    useState(false);
  // Infinite-scroll window size. Kept modest so deeper history actually
  // paginates (typical sessions run 40+ messages). A small window is safe now
  // that the initial fetch is order='desc' — page 1 is always the NEWEST
  // messages, so it can't hide the latest the way the old asc page-1 did (the
  // reason this was once bumped to 50).
  const messagesPerPage = 20;

  // Use centralized models from ModelsProvider to avoid duplicate API calls
  const { availableModels, modelsLoaded, refreshModels: refreshCentralizedModels } = useModels();

  // Refs for tracking component mount state to avoid memory leaks
  const messagesLoadingRef = useRef<{ [key: string]: boolean }>({});
  const sessionExistsRef = useRef<Record<string, boolean>>({});

  // Track the last user-selected model to prevent session overrides
  const lastUserSelectedModelRef = useRef<string | null>(null);

  // Handle model selection with provider information
  const handleModelSelect = useCallback(
    async (modelId: string, modelName?: string, providerType?: string, saveToDatabase = true) => {
      // Validate that the model exists in available models before proceeding
      // Check by id, model_name, or name to handle both UUID and string identifiers
      const selectedModelData = availableModels.find(
        m => m.id === modelId || m.model_name === modelId
      );
      if (!selectedModelData) {
        return;
      }

      // Set the selected model for UI feedback
      setSelectedModel(selectedModelData);

      // Track user-initiated selections (those with providerType)
      if (providerType) {
        lastUserSelectedModelRef.current = modelId;

        // Store the full model object in consolidated storage
        const { modelSelections } = await import('@/lib/storage-utils');

        // Correct mapping based on proper architecture:
        // model_id = UUID (database primary key)
        // model_name = API identifier for provider calls  
        // display_name = Human-readable name for UI
        const modelToStore = {
          model_id: selectedModelData.id, // UUID (database primary key)
          model_name: selectedModelData.model_name, // API identifier (e.g., "deepseek/deepseek-chat-v3.1:free")
          display_name: selectedModelData.display_name, // Human-readable display name (optional)
          provider_id: selectedModelData.provider_id, // Provider UUID
          provider_type: providerType || selectedModelData.provider_type,
        };

        modelSelections.setActiveModelObject(modelToStore);

        // Also update the global active model so the last used model is always restored
        modelSelections.setActiveModel(
          selectedModelData.id,
          selectedModelData.model_name,
          selectedModelData.provider_id || selectedModelData.provider
        );

        // Save to database (don't block UI if this fails)
        if (saveToDatabase) {
          try {
            const { saveSelectedModel } = await import('@/lib/api-settings');
            // Use the passed modelName if valid, otherwise fall back to selectedModelData
            // Never use UUID as model name - use "Unknown Model" as fallback
            const actualModelName =
              (modelName && modelName !== modelId) ? modelName :
                selectedModelData.model_name;

            // Additional validation: never save if the name is the same as the UUID
            if (actualModelName === modelId) {
              console.error('🚨 Prevented saving UUID as model name:', {
                modelId,
                actualModelName,
                selectedModelData
              });
              return; // Don't save to database if we would save UUID as name
            }


            const saveResponse = await saveSelectedModel(modelId, actualModelName, providerType);

            // Optimization: Use POST response to update local cache immediately
            // This avoids the need for a GET request later in handleNewSession
            if (saveResponse && saveResponse.success) {
              const { modelSelections } = await import('@/lib/storage-utils');
              modelSelections.setActiveModel(saveResponse.model_id, saveResponse.model_name, saveResponse.provider_type);

            }
          } catch (error) {
            console.warn('Failed to save selected model to database:', error);
          }
        }
      } else {
        // Only block system calls (no providerType) that try to override user selection
        // Allow all user-initiated calls (with providerType) to proceed
        if (
          lastUserSelectedModelRef.current &&
          lastUserSelectedModelRef.current !== modelId
        ) {
          return;
        }
      }

      // Selected model was already set at the beginning for instant UI feedback
    },
    [availableModels, setSelectedModel]
  );

  // Set selected model when centralized models are loaded
  useEffect(() => {
    async function setSelectedFromCentralizedModels() {
      // Add a check to prevent repeated fetching if models are already loaded
      if (availableModels.length > 0) {
        // If there's a selected session, resolve its model
        if (selectedSessionId && sessions.length > 0) {
          const session = sessions.find(s => s.id === selectedSessionId);
          if (session && session.model_name) {
            const foundModel = availableModels.find(
              m => m.model_name === session.model_name || m.id === session.model_name
            );
            if (foundModel && !lastUserSelectedModelRef.current) {
              setSelectedModel(foundModel);
            }
          }
        }
        return;
      }

      // Wait for centralized models to load
      if (!modelsLoaded || availableModels.length === 0) {
        return;
      }

      try {
        // Load model in priority order: current selected > session model > stored active model > first available
        let modelToSet = null;

        // First priority: Preserve currently selected model if it exists in the models list
        if (selectedModel) {
          const foundCurrentModel = availableModels.find(
            m =>
              m.id === selectedModel.id ||
              m.model_name === selectedModel.model_name
          );
          if (foundCurrentModel) {
            // Always update with the latest model data to reflect any changes from provider updates
            modelToSet = foundCurrentModel;
          }
        }

        // Second priority: If there's a selected session, use its model
        if (!modelToSet && selectedSessionId && sessions.length > 0) {
          const session = sessions.find(s => s.id === selectedSessionId);
          if (
            session &&
            session.model_name &&
            session.model_name !== 'default' && // Don't use 'default' placeholder
            !lastUserSelectedModelRef.current
          ) {
            const foundModel = availableModels.find(m => m.id === session.model_name);
            if (foundModel) {
              modelToSet = foundModel;
            } else {
              console.warn(`⚠️ [use-conversations] Session model "${session.model_name}" not found in available models, falling back to storage/first available`);
              // Don't create placeholder model - fall through to storage/first available
            }
          }
        }

        // Third priority: Load from consolidated storage if no session model
        if (!modelToSet && !lastUserSelectedModelRef.current) {
          try {
            const { modelSelections } = await import('@/lib/storage-utils');

            // First try to get the full model object from storage
            const storedModelObject = modelSelections.getActiveModelObject();

            if (storedModelObject) {
              // Check if the stored model exists in available models
              const foundModel = availableModels.find(
                m =>
                  m.id === storedModelObject.model_id ||
                  m.model_name === storedModelObject.model_id
              );
              if (foundModel) {
                modelToSet = foundModel;
              } else {
                // Create a model object from stored data if not found in available models
                // This handles the case where the model is from a paginated page that hasn't been loaded yet
                modelToSet = {
                  id: storedModelObject.model_id,
                  name: storedModelObject.display_name || storedModelObject.model_name,
                  model_name: storedModelObject.model_name,
                  display_name: storedModelObject.display_name || storedModelObject.model_name,
                  provider_type: storedModelObject.provider_type,
                  provider_id: storedModelObject.provider_id,
                  iconSrc: getIconForProvider(storedModelObject.provider_type, storedModelObject.model_name, storedModelObject.display_name),
                  group: 'ACTIVE',
                };
              }
            } else {
              // Fallback to old string-based storage
              const activeModelId = modelSelections.getActiveModel();
              if (activeModelId) {
                const foundModel = availableModels.find(
                  m =>
                    m.id === activeModelId ||
                    m.model_name === activeModelId
                );
                if (foundModel) {
                  modelToSet = foundModel;
                }
              }
            }
          } catch (error) {
            console.warn('Failed to load active model from storage:', error);
          }
        }

        // Do NOT auto-select models - users should explicitly choose
        // Only set the model if we found a previously selected one
        if (modelToSet) {
          setSelectedModel(modelToSet);
        }
        // REMOVED: Don't clear existing selection if no model found
        // This prevents API timeouts from clearing valid selections
      } catch (error) {
        console.error('Error fetching models:', error);

        // Note: Not showing toast to user for backend unavailability
        // The UI state will handle displaying appropriate fallback content
        // If API is down, models context will handle the error state

        // Try to use cached/stored model if available
        try {
          const { modelSelections } = await import('@/lib/storage-utils');
          const storedModelObject = modelSelections.getActiveModelObject();
          if (storedModelObject) {
            // Create a basic model object from stored data (for when API is down)
            const fallbackModel = {
              id: storedModelObject.model_id,
              name: storedModelObject.display_name || storedModelObject.model_name,
              model_name: storedModelObject.model_name,
              display_name: storedModelObject.model_name,
              provider_type: storedModelObject.provider_type,
              group: 'STORED',
            };
            setSelectedModel(fallbackModel);

          }
        } catch (storageError) {
          console.warn('Failed to load fallback model from storage:', storageError);
        }
      }
    }

    void setSelectedFromCentralizedModels();
  // eslint-disable-next-line react-hooks/exhaustive-deps -- deps are intentionally limited
  }, [modelsLoaded, availableModels, selectedSessionId]);

  // Listen for refresh requests from settings components to update selected model
  useEffect(() => {
    const checkForModelRefresh = async () => {
      const { uiState } = await import('@/lib/storage-utils');
      if (uiState.isChatModelSelectorRefreshNeeded()) {
        // Don't clear the refresh request here - let ChatModelSelector handle that
        // Use centralized refresh to avoid race conditions
        try {
          await refreshCentralizedModels();

          // Update selected model with latest data if it still exists
          if (selectedModel && availableModels.length > 0) {
            const updatedModel = availableModels.find(
              m =>
                m.id === selectedModel.id ||
                m.model_name === selectedModel.id
            );
            if (updatedModel) {
              setSelectedModel(updatedModel);
            }
          }
        } catch (error) {
          console.warn('Failed to refresh models in useSessionManagement:', error);
        }
      }
    };

    // Check immediately
    void checkForModelRefresh();

    // Set up interval to check for refresh requests - REDUCED frequency to prevent API spam
    const refreshCheckInterval = setInterval(checkForModelRefresh, 10000); // Changed from 2s to 10s

    return () => clearInterval(refreshCheckInterval);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- deps are intentionally limited
  }, [selectedModel]);

  // Listen for direct provider model updates
  useEffect(() => {
    const handleProviderModelsUpdated = async (_event: CustomEvent) => {


      try {
        // Force refresh models from API with cache bypass
        // First invalidate the cache to ensure fresh data
        const { invalidateModelsCache } = await import('@/lib/api-llm-inference');
        invalidateModelsCache();

        // Use centralized refresh to avoid race conditions
        await refreshCentralizedModels();

        // Get current selected model at the time of the event
        const currentSelectedModel = selectedModel;

        // Update selected model with latest data if it still exists
        if (currentSelectedModel && availableModels.length > 0) {
          const updatedModel = availableModels.find(
            m =>
              m.id === currentSelectedModel.id ||
              m.model_name === currentSelectedModel.id
          );
          if (updatedModel) {
            setSelectedModel(updatedModel);
          } else {
            console.warn('⚠️ Selected model not found in updated models list:', currentSelectedModel.id);
          }
        } else {
          // No selected model or no available models; nothing to update
        }
      } catch (error) {
        console.error('❌ Failed to refresh models after provider update:', error);
      }
    };


    // Add event listener
    window.addEventListener('providerModelsUpdated', handleProviderModelsUpdated as EventListener);

    return () => {

      window.removeEventListener('providerModelsUpdated', handleProviderModelsUpdated as EventListener);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps -- deps are intentionally limited
  }, []); // Remove selectedModel dependency to prevent listener recreation

  // Separate effect to handle session model resolution without triggering model fetching
  useEffect(() => {
    const resolveSessionModel = async () => {
      if (selectedSessionId && sessions.length > 0 && availableModels.length > 0 && !lastUserSelectedModelRef.current) {
        const session = sessions.find(s => s.id === selectedSessionId);
        if (session && session.model_name && session.model_name !== 'default') {
          const foundModel = availableModels.find(m => m.model_name === session.model_name || m.id === session.model_name);
          if (foundModel) {
            // Set model without saving to database to prevent API calls during streaming
            await handleModelSelect(foundModel.id, foundModel.model_name, foundModel.provider_type, false);
          } else {
            console.warn(`⚠️ [resolveSessionModel] Session model "${session.model_name}" not found in available models`);
          }
        }
      }
    };

    void resolveSessionModel();
  }, [selectedSessionId, sessions, availableModels, modelsLoaded, handleModelSelect]);

  // Function to refresh sessions from the API
  const refreshSessions = useCallback(async () => {
    // Prevent too frequent refreshes
    const now = Date.now();
    if (now - lastRefreshTimeRef.current < MIN_REFRESH_INTERVAL) {
      return;
    }

    // Don't refresh if streaming just completed (within 5 seconds)
    // This prevents race condition where backend hasn't persisted messages yet
    const timeSinceStreamComplete = now - streamRecentlyCompletedRef.current;
    if (timeSinceStreamComplete < 5000 && streamRecentlyCompletedRef.current > 0) {
      console.log('⏳ Skipping refreshSessions - stream recently completed, waiting for backend to sync');
      return;
    }

    lastRefreshTimeRef.current = now;

    if (!isAuthenticated) {
      return;
    }

    try {
      // Don't set isLoading here - it's for message streaming only
      // Setting isLoading interferes with message display after stream ends
      const paginatedResult = await listSessions(1, 20);
      const conversationsData = paginatedResult?.sessions || [];

      if (conversationsData && conversationsData.length > 0) {
        // Merge with existing sessions to preserve local messages that haven't synced yet
        setSessions(prevSessions => {
          const apiSessionIds = new Set(conversationsData.map(s => s.id));

          // Map API sessions, keeping local messages where appropriate
          const mergedSessions = conversationsData.map(apiSession => {
            const localSession = prevSessions.find(s => s.id === apiSession.id);
            // If we have a local version with more recent messages, keep those
            if (localSession && localSession.messages && localSession.messages.length > (apiSession.messages?.length || 0)) {
              return localSession; // Keep local version with more messages
            }
            return apiSession; // Use API version
          });

          // Preserve local-only sessions not yet in API response
          // This prevents losing brand-new sessions that backend hasn't returned yet
          prevSessions.forEach(localSession => {
            if (!apiSessionIds.has(localSession.id) && localSession.messages && localSession.messages.length > 0) {
              mergedSessions.unshift(localSession);
            }
          });

          return mergedSessions;
        });

        // Preload messages for recent sessions in the background (except the selected one)
        // Limit to top 3 most recent sessions to avoid overwhelming the API
        const sessionsToPreload = conversationsData
          .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
          .slice(0, 3)
          .filter(session => session.id !== selectedSessionId);

        // Preload in parallel — each preloadSessionMessages already guards against concurrent loads.
        // DEFER it so the foreground load of the *selected* session (kicked off
        // below) wins the connection race. On mobile these 3 background fetches
        // otherwise competed for bandwidth and made the session the user is
        // actually opening feel slow to appear.
        setTimeout(() => {
          Promise.all(sessionsToPreload.map(session => preloadSessionMessages(session.id))).catch(() => {});
        }, 600);

        if (!selectedSessionId) {
          let sessionToSelect = null;

          // First, check if there's a URL session ID that exists in the loaded sessions
          if (initialSelectedId) {
            sessionToSelect = conversationsData.find(
              s => s.id === initialSelectedId
            );
            if (sessionToSelect) {
              // Session found in loaded sessions; will be selected below
            } else {
              // URL session not found in loaded sessions, try to load it directly
              setSelectedSessionId(initialSelectedId);
              void loadSessionMessages(initialSelectedId);
              return; // Exit early to avoid selecting another session
            }
          }

          // If URL session was found in loaded sessions, select it
          // Otherwise, do NOT auto-select the most recent session — show empty dashboard
          // This prevents deep research from accidentally attaching to a stale session
          if (sessionToSelect) {
            setSelectedSessionId(sessionToSelect.id);

            // Set the model based on the selected session if available, but respect user selection
            if (
              sessionToSelect.model_name &&
              !lastUserSelectedModelRef.current
            ) {
              const model = availableModels.find(
                m => m.model_name === sessionToSelect.model_name || m.id === sessionToSelect.model_name
              );
              if (model) {
                setSelectedModel(model);
              } else {
                setSelectedModel(initialModel);
              }
            } else if (!lastUserSelectedModelRef.current) {
              setSelectedModel(initialModel);
            }

            // Load messages for the selected session
            void loadSessionMessages(sessionToSelect.id);
          }
        } else if (
          initialSelectedId &&
          selectedSessionId !== initialSelectedId &&
          !initialSessionConsumedRef.current
        ) {
          // Double-check: if sidebar loaded sessions and we have a URL session ID that doesn't match current selection
          // Skip if user explicitly navigated away from the URL session
          const urlSession = conversationsData.find(
            s => s.id === initialSelectedId
          );
          if (urlSession) {
            setSelectedSessionId(initialSelectedId);
            void loadSessionMessages(initialSelectedId);

            // Update model if needed
            if (urlSession.model_name && !lastUserSelectedModelRef.current) {
              const model = availableModels.find(
                m => m.model_name === urlSession.model_name || m.id === urlSession.model_name
              );
              if (model) {
                setSelectedModel(model);
              }
            }
          }
        }
      } else {
        setSelectedSessionId(null);
        if (!lastUserSelectedModelRef.current) {
          setSelectedModel(initialModel);
        }
      }
    } catch (error) {
      console.error('Error refreshing sessions:', error);

      // Note: Backend unavailability (ERR_CONNECTION_REFUSED) is handled globally
      // in the Axios interceptor (api.ts), which will redirect to login automatically

      // Handle other session refresh failures with recovery
      const errorMessage = error?.message || t('general.errors.sessionRefreshFailed');

      // If we have no sessions and refresh failed, start a new conversation
      if (sessions.length === 0) {
        toast({
          title: t('general.errors.connectionError'),
          description: t('general.errors.unableToLoadConversations'),
          variant: 'destructive',
        });

        // Ensure we have a model selected before creating new session
        if (!selectedModel && availableModels.length > 0) {
          setSelectedModel(availableModels[0]);
        }

        // Start a new conversation as fallback
        setSelectedSessionId(null);
        setStreamingContent('');
        setMessageStreamingInProgress(false);
      } else {
        // Just show error toast if we have existing sessions
        toast({
          title: t('general.errors.sessionRefreshError'),
          description: errorMessage,
          variant: 'destructive',
        });
      }
    }
    // No finally block needed - isLoading is managed by message streaming only
  // eslint-disable-next-line react-hooks/exhaustive-deps -- deps are intentionally limited
  }, [
    isAuthenticated,
    selectedSessionId,
    availableModels,
    initialModel,
    // preloadSessionMessages is stable (only depends on messagesPerPage), no need to include
  ]);

  // Initial sessions load on mount when auth is ready
  useEffect(() => {
    if (isAuthenticated && !authLoading && sessions.length === 0) {
      // Only load if we don't have sessions yet
      refreshSessions().catch(error => {
        console.warn('Failed to load initial sessions:', error);
      });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- deps are intentionally limited
  }, [isAuthenticated, authLoading]);  // refreshSessions is stable, don't include

  // Function to preload messages for a session in the background
  const preloadSessionMessages = useCallback(async (sessionId: string) => {
    // Skip if already preloading or already cached
    if (preloadingSessionsRef.current.has(sessionId) || getFromCache(sessionId)) {
      return;
    }

    try {
      preloadingSessionsRef.current.add(sessionId);
      // order='desc' so the cached window is the NEWEST page — matches what the
      // chat shows on open. (asc would cache the OLDEST messages and the view
      // would jump to ancient history on a cache hit.)
      const { messages: messagesData } = await getSessionMessagesPage(sessionId, 1, messagesPerPage, 'desc');

      if (messagesData && Array.isArray(messagesData)) {
        const preloadedMessages = messagesData.map((msg: BackendMessage) => {
          const rawMeta = msg.metadata || msg.message_metadata;
          return {
            id: msg.id,
            role: msg.role,
            content: msg.content,
            timestamp: msg.created_at ? new Date(msg.created_at) : new Date(),
            message_metadata: typeof rawMeta === 'string'
              ? JSON.parse(rawMeta)
              : rawMeta, // Parse JSON string or preserve object including citations
          };
        });

        // Store in LRU cache
        addToCache(sessionId, preloadedMessages);
      }
    } catch (error) {
      console.warn(`Failed to preload messages for session ${sessionId}:`, error);
    } finally {
      preloadingSessionsRef.current.delete(sessionId);
    }
  }, [messagesPerPage, getFromCache, addToCache]);

  // Function to load session messages with pagination
  const loadSessionMessages = useCallback(
    async (sessionId: string, page: number = 1, reset: boolean = false) => {
      if (!sessionId) {
        return;
      }

      // Check for tokens in storage instead of relying on isAuthenticated flag
      const hasTokens = !!(localStorage.getItem('auth_tokens') || sessionStorage.getItem('auth_tokens'));

      // Skip if no tokens and not authenticated to prevent 401 errors
      if (!hasTokens && !isAuthenticated) {
        return;
      }

      // If we have tokens, proceed even if isAuthenticated is false (race condition)
      if (hasTokens && !isAuthenticated) {
        // Auth state not yet synced but tokens exist; proceed with loading
      }

      // Skip if already loading messages for this session
      if (messagesLoadingRef.current[sessionId]) {
        return;
      }

      try {
        // Mark session as loading to prevent concurrent loads
        messagesLoadingRef.current[sessionId] = true;

        setIsLoading(true);
        if (page === 1) {
          setMessageStreamingInProgress(true);
        } else {
          setLoadingMoreMessages(true);
        }

        let messagesData;
        let isFromCache = false;
        // Whether older history remains BEFORE the window we just loaded.
        let moreOlderRemain = false;

        // Check cache first for page 1 (using LRU getFromCache)
        const cachedMessages = page === 1 ? getFromCache(sessionId) : null;
        if (cachedMessages) {
          isFromCache = true;
          messagesData = cachedMessages.map(msg => ({
            id: msg.id,
            role: msg.role,
            content: msg.content,
            created_at: msg.timestamp.toISOString(),
            message_metadata: msg.message_metadata,
          }));
          // The cache only holds the newest window, so we don't know the true
          // page count. If it's full, assume older history MIGHT exist — the
          // first load-more fetch reports the accurate count and self-corrects.
          moreOlderRemain = cachedMessages.length >= messagesPerPage;
        } else {
          // Fetch newest-first (order='desc'): page 1 = newest window, higher
          // pages reach further back. The backend returns each window in
          // chronological order, so older pages prepend cleanly via the merge
          // path below.
          const pageResult = await getSessionMessagesPage(
            sessionId,
            page,
            messagesPerPage,
            'desc'
          );
          messagesData = pageResult.messages;
          moreOlderRemain = page < pageResult.totalPages;
        }
        if (messagesData && Array.isArray(messagesData)) {
          // Abort if session changed while we were fetching
          if (selectedSessionIdRef.current !== sessionId) {
            console.log(`📋 loadSessionMessages: Session changed during fetch, aborting for ${sessionId}`);
            return;
          }

          // Map API response to Message type format
          const paginatedMessages = messagesData.map((msg: BackendMessage) => {
            const rawMeta = msg.metadata || msg.message_metadata;
            return {
              id: msg.id,
              role: msg.role,
              content: msg.content,
              timestamp: msg.created_at ? new Date(msg.created_at) : new Date(), // Convert created_at string to Date, fallback to now
              message_metadata: typeof rawMeta === 'string'
                ? JSON.parse(rawMeta)
                : rawMeta, // Parse JSON string or preserve object including citations
            };
          });
          // Track how deep we've loaded so load-more knows the next page, and
          // whether older history still remains so the scroll trigger arms.
          loadedPageRef.current[sessionId] = page;
          setHasMoreMessages(moreOlderRemain);
          setMessagesPage(page);

          // Check if session exists in current state - if not, fetch details FIRST before updating
          const sessionExists = sessions.find(s => s.id === sessionId);

          if (!sessionExists) {
            console.log(
              `Session ${sessionId} not found in cache, fetching from server...`
            );

            // Fetch session details BEFORE updating state
            let sessionData = null;
            let sessionDeleted = false;
            try {
              const { getSession } = await import('../lib/api-sessions');
              sessionData = await getSession(sessionId);

              // Abort if session changed while we were fetching
              if (selectedSessionIdRef.current !== sessionId) {
                console.log(`📋 loadSessionMessages: Session changed during getSession, aborting for ${sessionId}`);
                return;
              }
            } catch (error) {
              // A 404 means the session was deleted on the backend (e.g. a stale
              // ghost session lingering in the sidebar). Anything else (network,
              // 5xx) is transient — keep the entry and just bail out.
              const status =
                (error as { response?: { status?: number }; status?: number })
                  ?.response?.status ??
                (error as { status?: number })?.status;
              sessionDeleted = status === 404;
              console.warn(
                `Failed to fetch session details for ${sessionId} (status ${status ?? 'n/a'}):`,
                error
              );
            }

            if (!sessionData) {
              if (sessionDeleted) {
                // The selected session no longer exists. Prune the ghost from the
                // list and recover the view: land on the most recent remaining
                // session, or fall back to the dashboard. Without this the
                // selection dangles on a missing id and the chat header (which
                // lives inside the selected-session branch) silently disappears.
                console.warn(
                  `Session ${sessionId} was deleted on the backend, pruning and recovering view`
                );
                removeFromCache(sessionId);
                const wasSelected = selectedSessionIdRef.current === sessionId;
                setSessions(prevSessions =>
                  prevSessions.filter(s => s.id !== sessionId)
                );
                if (wasSelected) {
                  // Land on the most recent remaining session (or the dashboard
                  // when none remain). The selectedSessionId effect then loads
                  // that session's messages — no recursive call needed.
                  const next = sessions.find(s => s.id !== sessionId)?.id ?? null;
                  selectedSessionIdRef.current = next;
                  setSelectedSessionId(next);
                  const url = new URL(window.location.href);
                  if (next) {
                    url.searchParams.set('session_id', next);
                  } else {
                    url.searchParams.delete('session_id');
                  }
                  url.searchParams.delete('session_state');
                  window.history.replaceState({}, '', url.toString());
                }
              }
              return;
            }

            // Get model from storage as fallback
            let actualModelId = sessionData?.model_id || null;
            let actualModelName = sessionData?.model_name || null;

            if (!actualModelId || !actualModelName) {
              try {
                const storedModel = modelSelections.getActiveModelObject();
                if (storedModel) {
                  actualModelId = actualModelId || storedModel.model_id;
                  actualModelName = actualModelName || storedModel.model_name;
                }
              } catch (err) {
                console.warn('❌ [use-conversations] Failed to get model from storage:', err);
              }
            }

            const newSession: Session = {
              id: sessionId,
              user_id: sessionData?.user_id || 'current-user',
              title: sessionData?.conversation_name || sessionData?.title || i18n.t('chat.newConversation'),
              conversation_name: sessionData?.conversation_name || sessionData?.title || i18n.t('chat.newConversation'),
              messages: paginatedMessages,
              createdAt: sessionData?.created_at ? new Date(sessionData.created_at) : new Date(),
              updatedAt: sessionData?.updated_at ? new Date(sessionData.updated_at) : new Date(),
              created_at: sessionData?.created_at || new Date().toISOString(),
              updated_at: sessionData?.updated_at || new Date().toISOString(),
              modelId: actualModelId,
              model_name: actualModelName,
              lastMessageFetchTime: Date.now(),
            };

            // Now update sessions with the fetched data
            setSessions(prevSessions => {
              const alreadyExists = prevSessions.find(s => s.id === sessionId);
              if (alreadyExists) {
                // Update existing session with fetched data
                return prevSessions.map(s =>
                  s.id === sessionId
                    ? {
                      ...s,
                      ...newSession,
                      messages: (() => {
                        const seen = new Map();
                        for (const msg of [...(s.messages || []), ...paginatedMessages]) {
                          seen.set(msg.id, msg);
                        }
                        return Array.from(seen.values());
                      })(),
                    }
                    : s
                );
              }
              return [newSession, ...prevSessions];
            });
          } else {
            // Session exists - update it with messages
            setSessions(prevSessions => {
              // When resetting (page 1), replace all messages with backend data
              // Otherwise, merge and sort by timestamp to maintain proper order
              const updatedMessages = reset
                ? paginatedMessages.sort(
                  (a, b) =>
                    new Date(a.timestamp).getTime() -
                    new Date(b.timestamp).getTime()
                )
                : (() => {
                  // Merge existing and new messages, deduplicate via Map (O(n)), and sort
                  const existingSession = prevSessions.find(s => s.id === sessionId);
                  const existingMessages = existingSession?.messages || [];
                  const seen = new Map();
                  for (const msg of existingMessages) seen.set(msg.id, msg);
                  for (const msg of paginatedMessages) seen.set(msg.id, msg);

                  return Array.from(seen.values()).sort(
                    (a, b) =>
                      new Date(a.timestamp).getTime() -
                      new Date(b.timestamp).getTime()
                  );
                })();
              return prevSessions.map(session => {
                if (session.id === sessionId) {
                  return {
                    ...session,
                    messages: updatedMessages,
                    lastMessageFetchTime: Date.now(), // Update fetch time
                  };
                }
                return session;
              });
            });
          }

          // If using cached messages, immediately set loading to false (no streaming animation needed)
          if (isFromCache) {
            setIsLoading(false);
            setMessageStreamingInProgress(false);
            setLoadingMoreMessages(false);
          } else {
            // Set loading states to false after updating sessions
            setIsLoading(false);
            setMessageStreamingInProgress(false);
            setLoadingMoreMessages(false);
          }

          // If this is the currently selected session, update its model too (but only if user hasn't manually selected a different model)
          if (sessionId === selectedSessionId && availableModels.length > 0) {
            const session = sessions.find(s => s.id === sessionId);
            if (session && session.model_name) {
              const model = availableModels.find(
                m => m.model_name === session.model_name || m.id === session.model_name
              );
              // Only set the model if the user hasn't manually selected a different one
              if (
                model &&
                (!lastUserSelectedModelRef.current ||
                  lastUserSelectedModelRef.current === session.model_name)
              ) {
                setSelectedModel(model);
              }
            }
          }

          // Messages are already set in the setSessions call above.
          // No per-message streaming animation - it caused UI freezes on rapid session switching
          // because each message triggered a full setSessions map over all sessions.
        }
      } catch (error) {
        console.error('Error loading session messages:', error);
        setIsLoading(false);
        setMessageStreamingInProgress(false);
        setLoadingMoreMessages(false);

        // Handle session loading failures gracefully
        // DON'T reset selectedSessionId - that causes an infinite loop where
        // auto-select picks another session → loadSessionMessages → 404 → reset → loop
        if (sessionId === selectedSessionId) {
          const is404 = error?.response?.status === 404 || error?.status === 404;
          if (!is404) {
            // Only show toast for non-404 errors (404 means session messages not synced yet)
            toast({
              title: 'Session Loading Error',
              description:
                'Unable to load conversation history.',
              variant: 'destructive',
            });
          }
          // Mark this session as "attempted" to prevent retry loops
          setSessions(prev => prev.map(s =>
            s.id === sessionId ? { ...s, lastMessageFetchTime: Date.now() } : s
          ));
        }
      } finally {
        // Always clear the loading flag
        messagesLoadingRef.current[sessionId] = false;
        // Always reset the loading UI states. The "session changed during fetch"
        // abort paths above `return` without resetting them, which left isLoading
        // stuck true for the loaded conversation and rendered a phantom "pending"
        // progress bubble (research-inline-progress) next to the committed answer.
        // Active response streaming uses a separate isLoading lifecycle managed by
        // sendMessage's completion callback (loadSessionMessages never runs during
        // an in-flight send), so clearing here cannot truncate a live stream.
        setIsLoading(false);
        setMessageStreamingInProgress(false);
        setLoadingMoreMessages(false);
      }
    },
    [selectedSessionId, availableModels, sessions, isAuthenticated, getFromCache, removeFromCache, i18n]
  );

  // Load the next older page of history (infinite-scroll up). Fetches the page
  // BEFORE the deepest one already loaded; loadSessionMessages' merge path
  // (reset=false) dedupes and re-sorts by timestamp, so the older messages land
  // at the top. No-op while a load is already in flight or no history remains.
  const loadMoreMessages = useCallback(
    (sessionId?: string) => {
      const sid = sessionId || selectedSessionIdRef.current;
      if (!sid) return;
      if (!hasMoreMessages) return;
      if (loadingMoreMessages || messagesLoadingRef.current[sid]) return;
      const nextPage = (loadedPageRef.current[sid] || 1) + 1;
      void loadSessionMessages(sid, nextPage, false);
    },
    [hasMoreMessages, loadingMoreMessages, loadSessionMessages]
  );

  // Update selectedCollections when the selectedCollection changes
  useEffect(() => {
    if (selectedCollection) {
      setSelectedCollections([selectedCollection]);
    } else {
      setSelectedCollections([]);
    }
  }, [selectedCollection]);


  // Retry loading session messages when authentication completes
  useEffect(() => {
    if (
      isAuthenticated &&
      selectedSessionId &&
      !messagesLoadingRef.current[selectedSessionId]
    ) {
      // Find the selected session to ensure it exists
      const session = sessions.find(s => s.id === selectedSessionId);
      if (
        session &&
        (!session.messages || session.messages.length === 0) &&
        !session.lastMessageFetchTime
      ) {
        // Only load messages for existing sessions, not new ones
        // Check URL params to see if this is a new session
        const urlParams = new URLSearchParams(window.location.search);
        const sessionState = urlParams.get('session_state');

        if (sessionState !== 'new') {
          // Add a small delay to prevent race condition with database transaction
          setTimeout(() => {
            void loadSessionMessages(selectedSessionId);
          }, 500);
        }
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- deps are intentionally limited
  }, [isAuthenticated, selectedSessionId, loadSessionMessages]);

  // CRITICAL: Ensure URL session loads immediately on page refresh
  const initialLoadAttemptedRef = useRef(false);
  // Track when user explicitly navigates away from the URL session
  const initialSessionConsumedRef = useRef(false);
  useEffect(() => {
    // Only run once when authenticated, and we have a URL session ID
    if (isAuthenticated && initialSelectedId && !initialLoadAttemptedRef.current) {
      initialLoadAttemptedRef.current = true;
      
      console.log('🔄 Initial load: URL session_id detected:', initialSelectedId);
      
      // For existing sessions (not new), immediately set as selected and load
      if (sessionState !== 'new') {
        console.log('📥 Loading existing session from URL');
        setSelectedSessionId(initialSelectedId);

        // Load immediately — loadSessionMessages handles the not-yet-in-list
        // case by fetching the single session (getSession) + its messages and
        // inserting it, so there's no need to wait for the full list. The old
        // 100ms delay just postponed the session appearing.
        void loadSessionMessages(initialSelectedId);
      } else {
        console.log('🆕 New session from URL, will be created on first message');
      }
    }
  }, [isAuthenticated, initialSelectedId, sessionState, loadSessionMessages]);

  // Handle URL session ID loading independently of sidebar refresh timing
  useEffect(() => {
    if (isAuthenticated && initialSelectedId && !selectedSessionId) {
      setSelectedSessionId(initialSelectedId);

      if (sessionState === 'new') {
        // Get actual model from storage instead of using 'default' placeholder
        let actualModelId = null;
        let actualModelName = null;
        try {
          const storedModel = modelSelections.getActiveModelObject();
          if (storedModel) {
            actualModelId = storedModel.model_id;
            actualModelName = storedModel.model_name;
          }
        } catch (error) {
          console.warn('Failed to get model from storage for new session:', error);
        }

        // Create a new empty session entry for the URL session ID
        const newSession = {
          id: initialSelectedId,
          user_id: 'current-user',
          title: i18n.t('chat.newConversation'),
          conversation_name: i18n.t('chat.newConversation'),
          messages: [],
          createdAt: new Date(),
          updatedAt: new Date(),
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          modelId: actualModelId,
          model_name: actualModelName,
          lastMessageFetchTime: Date.now(),
        };
        setSessions(prevSessions => {
          const sessionExists = prevSessions.find(
            s => s.id === initialSelectedId
          );
          if (!sessionExists) {
            return [newSession, ...prevSessions];
          }
          return prevSessions;
        });
      } else {
        // Only load messages for existing sessions, not new ones
        void loadSessionMessages(initialSelectedId);
      }
    } else if (
      isAuthenticated &&
      initialSelectedId &&
      selectedSessionId !== initialSelectedId &&
      !initialSessionConsumedRef.current
    ) {
      setSelectedSessionId(initialSelectedId);

      if (sessionState === 'new') {
        // Get actual model from storage instead of using 'default' placeholder
        let actualModelId = null;
        let actualModelName = null;
        try {
          const storedModel = modelSelections.getActiveModelObject();
          if (storedModel) {
            actualModelId = storedModel.model_id;
            actualModelName = storedModel.model_name;
          }
        } catch (error) {
          console.warn('Failed to get model from storage for new session:', error);
        }

        // Create a new empty session entry for the URL session ID
        const newSession = {
          id: initialSelectedId,
          user_id: 'current-user',
          title: i18n.t('chat.newConversation'),
          conversation_name: i18n.t('chat.newConversation'),
          messages: [],
          createdAt: new Date(),
          updatedAt: new Date(),
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          modelId: actualModelId,
          model_name: actualModelName,
          lastMessageFetchTime: Date.now(),
        };
        setSessions(prevSessions => {
          const sessionExists = prevSessions.find(
            s => s.id === initialSelectedId
          );
          if (!sessionExists) {
            return [newSession, ...prevSessions];
          }
          return prevSessions;
        });
      } else {
        // Only load messages for existing sessions, not new ones
        void loadSessionMessages(initialSelectedId);
      }
    }
  }, [
    isAuthenticated,
    initialSelectedId,
    selectedSessionId,
    sessionState,
    loadSessionMessages,
    i18n,
  ]);

  // Handle URL session loading on page reload when selectedSessionId is already set
  useEffect(() => {
    if (
      isAuthenticated &&
      initialSelectedId &&
      selectedSessionId === initialSelectedId
    ) {
      // Check if the session exists in our session array and has messages
      const session = sessions.find(s => s.id === selectedSessionId);
      if (!session || !session.messages || session.messages.length === 0) {
        // For new sessions (session_state=new), skip API call and create empty session immediately
        if (sessionState === 'new') {
          // Get the currently selected model from localStorage
          const currentModel = modelSelections.getActiveModelObject();
          const modelId = currentModel?.model_id || 'default';
          const modelName = currentModel?.model_name || 'default';

          const newSession = {
            id: selectedSessionId,
            user_id: 'current-user',
            title: i18n.t('chat.newConversation'),
            conversation_name: i18n.t('chat.newConversation'),
            messages: [],
            createdAt: new Date(),
            updatedAt: new Date(),
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            modelId: modelId,
            model_name: modelName,
            lastMessageFetchTime: Date.now(),
          };
          setSessions(prevSessions => {
            const sessionExists = prevSessions.find(
              s => s.id === selectedSessionId
            );
            if (!sessionExists) {
              return [newSession, ...prevSessions];
            }
            return prevSessions;
          });
        } else {
          // For existing sessions, load messages from database
          loadSessionMessages(selectedSessionId).catch((error) => {
            console.error('Failed to load session messages:', error);
          });
        }
      }
    }
  }, [
    isAuthenticated,
    initialSelectedId,
    selectedSessionId,
    sessionState,
    sessions,
    loadSessionMessages,
    i18n,
  ]);


  // Function to send a message
  const sendMessage = useCallback(
    async (messageContent: string, options: SendMessageOptions = {}) => {
      if (!messageContent.trim()) return;

      // Read the session id from the ref, not the captured `selectedSessionId`
      // state. After the FIRST message of a brand-new conversation mints an id
      // and calls setSelectedSessionId, the state update + its sync useEffect
      // have not necessarily propagated by the time a quick follow-up fires —
      // the stale closure then saw `selectedSessionId === null`, minted a SECOND
      // uuid, and silently split the conversation into a new session (history
      // lost). The ref is updated synchronously below so the next message
      // reuses THIS session.
      // The URL is the durable source of truth for the displayed conversation:
      // the sidebar's session click navigates by setting ?session_id=<id>, and
      // the URL survives a page reload / next-day reopen where the in-memory
      // ref resets to null. use-conversations does NOT reliably re-sync
      // selectedSessionId on a post-mount URL change, so without this a
      // follow-up sent after a sidebar click (or reload) minted a NEW uuid and
      // split the conversation. Resolve from the URL before minting a fresh id.
      const urlSessionId = new URLSearchParams(window.location.search).get('session_id');
      const actualSessionId =
        options.session_id || selectedSessionIdRef.current || urlSessionId || uuidv4();

      // Adopt the resolved session whenever the ref doesn't already match it
      // (brand-new, or recovered from URL/options after a reset). Set the ref
      // synchronously so an immediate follow-up reuses the same session.
      if (selectedSessionIdRef.current !== actualSessionId) {
        const reusedExisting = !!(options.session_id || urlSessionId);
        selectedSessionIdRef.current = actualSessionId;
        setSelectedSessionId(actualSessionId);
        const newSearchParams = new URLSearchParams(window.location.search);
        newSearchParams.set('session_id', actualSessionId);
        // Only flag 'new' for a freshly minted id — not when reusing an
        // existing session id from the URL or explicit options.
        if (reusedExisting) {
          newSearchParams.delete('session_state');
        } else {
          newSearchParams.set('session_state', 'new');
        }
        window.history.replaceState(null, '', `${window.location.pathname}?${newSearchParams.toString()}`);
      }

      // Remove old messages FIRST, before setting any loading states
      // Only remove messages when repeating the exact same query (retry scenario)
      // Backend will delete both user and assistant messages when detecting repeated content
      let shouldInvalidateCache = false;
      setSessions(prev => prev.map(session => {
        if (session.id === actualSessionId && session.messages && session.messages.length >= 2) {
          const lastMessage = session.messages[session.messages.length - 1];
          const secondLastMessage = session.messages[session.messages.length - 2];

          // Only remove messages when repeating the exact same user query
          if (lastMessage.role === 'assistant' &&
            secondLastMessage.role === 'user' &&
            secondLastMessage.content === messageContent.trim()) {
            shouldInvalidateCache = true;
            // Remove both user and assistant messages for repeated query
            return {
              ...session,
              messages: session.messages.slice(0, -2)
            };
          }
        }
        return session;
      }));

      // Invalidate cache if we removed old messages to prevent them from reappearing
      if (shouldInvalidateCache) {
        delete messagesCache.current[actualSessionId];
        cacheAccessOrder.current = cacheAccessOrder.current.filter(id => id !== actualSessionId);
      }

      // Now set loading states after old messages are removed
      setIsLoading(true);
      setIsAiResponding(true);
      setStreamingContent('');
      setStatusMessage(null);
      setStageHistory([]);
      setStreamEnded(false);
      setThinkingTimeMs(0);
      thinkStartTimeRef.current = null;
      setFollowUpSuggestions([]);
      setSuggestionDocumentId('');

      // Start centralized loading for streaming
      streamingLoadingIdRef.current = loadingService.startStreaming(actualSessionId);
      setMessageStreamingInProgress(false);

      let fullResponse = '';
      let regularContent = '';

      // Reset stream completion flag for this new message
      streamCompletedRef.current = false;

      // Debug: Log the current selectedModel state
      // Resolve the model to use for this request
      let modelToUse = selectedModel;

      // If no model is selected, try to resolve it from the current session or use fallback
      if (!modelToUse) {
        console.warn('⚠️ No model selected, attempting to resolve from session or use fallback...');

        // Try to get model from current session
        if (selectedSessionId && sessions.length > 0) {
          const currentSession = sessions.find(s => s.id === selectedSessionId);
          if (currentSession && currentSession.model_name) {
            modelToUse = availableModels.find(
              m => m.model_name === currentSession.model_name || m.id === currentSession.model_name
            );
          }
        }

        // If no session model found, use the first available model as fallback
        if (!modelToUse && availableModels.length > 0) {
          modelToUse = availableModels[0];
        }

        // CRITICAL FIX: If availableModels is empty (still loading), try localStorage
        // This prevents the race condition when navigating from PDF viewer to new conversation
        if (!modelToUse) {
          try {
            const storedModelObject = modelSelections.getActiveModelObject();
            if (storedModelObject && storedModelObject.model_id) {
              console.log('🔧 Using localStorage model as fallback:', storedModelObject.model_name);
              // Create a model object from localStorage data
              modelToUse = {
                id: storedModelObject.model_id,
                name: storedModelObject.display_name || storedModelObject.model_name,
                model_name: storedModelObject.model_name,
                display_name: storedModelObject.display_name || storedModelObject.model_name,
                provider_type: storedModelObject.provider_type,
                provider_id: storedModelObject.provider_id,
                iconSrc: getIconForProvider(storedModelObject.provider_type, storedModelObject.model_name, storedModelObject.display_name),
                group: 'STORED',
              };
            }
          } catch (error) {
            console.warn('Failed to get model from localStorage:', error);
          }
        }

        if (modelToUse) {
          // Set the model state for future use
          setSelectedModel(modelToUse);
        } else {
          console.error('❌ No model available! Cannot send message.');
          setIsLoading(false);
          return;
        }
      }

      try {

        const userMessage: Message = {
          id: uuidv4(),
          role: 'user',
          content: messageContent,
          timestamp: new Date(),
          ...(options.mentions && options.mentions.length > 0 && {
            message_metadata: { mentions: options.mentions },
          }),
        };

        // Function to add a message to the session
        const addUserMessageToSession = (
          sessionId: string,
          message: Message
        ) => {
          setSessions(prev => {
            const sessionExists = prev.some(s => s.id === sessionId);
            if (!sessionExists) {
              const newSession: Session = {
                id: sessionId,
                user_id: 'current-user',
                title: message.content.replace(/\s+/g, ' ').trim() || i18n.t('chat.newConversation'),
                conversation_name:
                  message.content.replace(/\s+/g, ' ').trim() || i18n.t('chat.newConversation'),
                messages: [message],
                createdAt: new Date(),
                updatedAt: new Date(),
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
                modelId: selectedModel?.id || null,
                model_name: selectedModel?.model_name || null,
                lastMessageFetchTime: 0,
              };
              return [...prev, newSession];
            }
            return prev.map(session =>
              session.id === sessionId
                ? {
                  ...session,
                  messages: [...(session.messages || []), message],
                  updatedAt: new Date(),
                  title:
                    (session.messages || []).length === 0 &&
                      message.role === 'user'
                      ? message.content.replace(/\s+/g, ' ').trim()
                      : session.title,
                }
                : session
            );
          });
        };

        // Add user message to the session (skip for hidden messages like plan approval)
        if (!options.hide_user_message) {
          addUserMessageToSession(actualSessionId, userMessage);
        }

        // Research setup pending — user message added, but skip API call.
        // The inline setup UI in chat-messages will handle sending the real request.
        if ((options as Record<string, unknown>).research_setup_pending) {
          return;
        }

        // Determine conversationSessionId for backend
        let conversationSessionId = options.session_id;
        if (!conversationSessionId) {
          if (sessionMap[actualSessionId]) {
            conversationSessionId = sessionMap[actualSessionId];
          } else {
            // For continuing conversations, use the actualSessionId as conversationSessionId
            // Only generate new UUID for brand new conversations
            conversationSessionId = actualSessionId;
            setSessionMap(prev => ({
              ...prev,
              [actualSessionId]: conversationSessionId,
            }));
          }
        }

        // Check for open PDF/EPUB viewers to enable direct document RAG
        const openViewerDocumentIds: string[] = [];
        if (pdfViewer.state.isOpen && pdfViewer.state.documentId) {
          openViewerDocumentIds.push(pdfViewer.state.documentId);
        }
        if (epubViewer.state.isOpen && epubViewer.state.documentId) {
          openViewerDocumentIds.push(epubViewer.state.documentId);
        }

        const request: ChatRequest = {
          prompt: messageContent,
          model_id: selectedModel?.id || undefined, // UUID for database reference
          model_name:
            options.model_name ||
            selectedModel?.model_name, // Use actual model_name for API calls, not display_name
          provider_type: options.provider_type || selectedModel?.provider_type,
          session_id: conversationSessionId,
          stream: true,
          collection_ids:
            // Priority 1: @-mentioned collections override toolbar selection
            options.mention_collection_ids && options.mention_collection_ids.length > 0
              ? options.mention_collection_ids
              : selectedCollections.length > 0
              ? selectedCollections.map(c => c.id)
              : undefined,
          document_ids:
            // Priority 1: @-mentioned documents
            options.mention_document_ids && options.mention_document_ids.length > 0
              ? options.mention_document_ids
              // Priority 2: Open viewer documents (manual RAG intent)
              : openViewerDocumentIds.length > 0
              ? openViewerDocumentIds
              // Priority 3: Selected collection documents
              : selectedCollections.length > 0 && selectedCollections[0].documentIds
              ? selectedCollections[0].documentIds
              : undefined,
          document_ids_all_collections: true,
          web_search_enabled: options.web_search_enabled || false,
          deep_research_enabled: options.deep_research_enabled || false,
          research_breadth: options.research_breadth,
          research_depth: options.research_depth,
          user_message_id: options.user_message_id || userMessage.id, // Always pass message ID for frontend-backend sync
          agentic_rag_enabled: options.agentic_rag_enabled
            || (() => {
              try {
                const cached = JSON.parse(localStorage.getItem('scrapalot_cache_data') || '{}');
                return cached['general-settings']?.data?.use_agentic_routing ?? false;
              } catch { return false; }
            })(),
          // 7.8 v1 — AI Tutor Mode passthrough. Server prepends
          // Socratic-tutor instructions when this is set; RAG retrieval
          // is unchanged.
          tutor_mode: options.tutor_mode || false,
          // 7.7 — Thought Partner passthrough. Routes to DirectLLM
          // with a questions-only system prompt; never answers.
          thought_partner_mode: options.thought_partner_mode || false,
          // Read the active workspace through the user-scoped guard, NOT raw
          // localStorage. The cached workspace is stamped with its owner
          // (currentWorkspaceUserId); reading it raw leaked a PREVIOUS user's
          // workspace into the chat request — e.g. under impersonation the UI
          // shows the impersonated user's workspace, but the request carried the
          // admin's stale workspace_id, so the impersonated user (not a member of
          // it) got 0 accessible collections and the answer silently fell back to
          // direct-LLM with no document retrieval. getCurrentWorkspace returns
          // undefined on an owner mismatch, so the backend then resolves the
          // user's OWN default workspace.
          workspace_id: (uiState.getCurrentWorkspace(user?.id) as { id?: string } | undefined)?.id || undefined,
          attachments: options.attachments,
          // Deep Research v1: Clarification answers + plan preview + templates
          clarification_answers: options.clarification_answers,
          clarification_request_id: options.clarification_request_id,
          approved_plan_id: options.approved_plan_id,
          template_type: options.template_type,
          council_enabled: options.council_enabled || false,
          // Agentic Council roster (user-defined members) → gRPC metadata['council_members'].
          // Only sent when >=2 members are defined; otherwise the backend falls
          // back to the default 12-archetype council.
          council_members:
            options.council_members && options.council_members.length >= 2
              ? options.council_members
              : undefined,
          // Run mode → 'autonomous' dispatches a durable background job in Python.
          research_mode: options.research_mode || undefined,
          continue_research_plan_id: options.continue_research_plan_id,
          continuation_context: options.continuation_context,
          // Settings → Prompts → Custom Templates picker (chat toolbar
          // popover). Forwarded to Python via gRPC metadata where Layer 6
          // of the system-prompt builder resolves the body from
          // user_settings.prompt_templates.
          prompt_template_name: options.prompt_template_name,
          // Annotation color filter (chat toolbar chip row). Hex codes
          // (e.g. "#ffd400") restricting retrieval to user-highlighted
          // pages on the Python side; per-color boost is config-driven.
          annotation_color_filter: options.annotation_color_filter && options.annotation_color_filter.length > 0
            ? options.annotation_color_filter
            : undefined,
          // UI language for AI response language
          language: i18n.language || 'en',
          // @-mentioned documents/collections (persisted in message metadata)
          mentions: options.mentions,
          // "AI thinking" toggle → ask the backend to append the model's
          // own-knowledge reflection (thinking panel + "model insight" block).
          deep_synthesis_enabled: options.deep_synthesis_enabled ?? (userPrefs.get().showReasoningIndicators ?? false),
        };

        // Track citations and thinking content during streaming
        const collectedCitations: Record<string, unknown>[] = [];
        let collectedThinkingContent = '';
        let collectedModelInsightContent = '';
        // Search strategy transparency packet (emitted once, early in stream).
        // Captured here so the collapsible "Search Strategy" panel can render
        // sub-queries / filters / sources / strategy rationale even after reload.
        let collectedSearchStrategy: Record<string, unknown> | null = null;
        let lastProcessedStatusKey = ''; // Track to prevent duplicate status updates

        const handleChunk = (chunk: StreamChunk) => {
          try {
            if (!chunk) return;

            // Convert chunk to JSON string (packet format) and accumulate
            const packetLine = JSON.stringify(chunk);

            // Append packet line to streaming content
            setStreamingContent(prev => prev + packetLine + '\n');

            // Forward packet to deep research panel immediately (avoids React batch timing)
            deepResearchPanelRef.current.processPacket(chunk);

            // Extract content from packet structure: { ind: 0, obj: { type: 'message_delta', content: 'text' } }
            // IMPORTANT: Some packets have object content (routing_decision, strategy_selected)
            // Only use content if it's a string, otherwise skip to prevent "[object Object]" in messages
            let contentToAdd = chunk.obj?.content || chunk.content || '';
            const chunkType = chunk.obj?.type || chunk.type;

            // Skip packets with object content (not meant for message display)
            if (typeof contentToAdd === 'object' && contentToAdd !== null) {
              contentToAdd = ''; // Don't add object content to message
            }

            // Collect citation_info packets.
            // Smart Citations (Scite): the backend re-emits each citation after
            // stance classification. Merge by citation_num so the second packet
            // upgrades the first in place instead of duplicating.
            if (chunkType === 'strategy_transparency') {
              const data = chunk.obj || chunk;
              collectedSearchStrategy = {
                sub_queries: data.sub_queries || [],
                filters_applied: data.filters_applied || {},
                sources_queried: data.sources_queried || [],
                strategy_name: data.strategy_name,
                rationale: data.rationale,
                executor: data.executor,
              };
              return;
            }

            // Manual/sync RAG path emits `strategy_selected` (strategy name only),
            // not the richer `strategy_transparency` packet. Use it as a fallback so
            // the "Search strategy" badge still shows the chosen strategy in manual
            // mode. `strategy_transparency` is authoritative — it always overwrites,
            // so this only fills in when nothing has been collected yet.
            if (chunkType === 'strategy_selected') {
              if (!collectedSearchStrategy) {
                const content = (chunk.obj?.content || chunk.content || {}) as Record<string, unknown>;
                if (content.strategy_name) {
                  collectedSearchStrategy = {
                    sub_queries: [],
                    filters_applied: {},
                    sources_queried: Array.isArray(content.sources) ? content.sources : [],
                    strategy_name: content.strategy_name,
                    rationale: undefined,
                    executor: undefined,
                  };
                }
              }
              return;
            }

            if (chunkType === 'citation_info') {
              const citationData = chunk.obj || chunk;
              const incoming = {
                id: citationData.citation_num,
                citation_num: citationData.citation_num,
                document_id: citationData.document_id,
                document_title: citationData.document_title,
                source: citationData.source,
                file_path: citationData.file_path,
                url: citationData.url,
                page: citationData.page,
                chunk_index: citationData.chunk_index,
                text: citationData.text,
                score: citationData.score,
                chunk_position_json: citationData.chunk_position_json,
                // Smart Citations fields
                stance: citationData.stance,
                stance_confidence: citationData.stance_confidence,
                stance_rationale: citationData.stance_rationale,
                citation_context: citationData.citation_context,
                // Bridge-mode metadata
                is_bridge: citationData.is_bridge,
                source_collection_id: citationData.source_collection_id,
                bridge_anchors: citationData.bridge_anchors,
              };
              const existingIdx = collectedCitations.findIndex(
                (c: { citation_num?: number }) => c.citation_num === incoming.citation_num
              );
              if (existingIdx === -1) {
                collectedCitations.push(incoming);
              } else {
                // Merge, preferring non-null fields from incoming
                const existing = collectedCitations[existingIdx];
                collectedCitations[existingIdx] = {
                  ...existing,
                  ...Object.fromEntries(
                    Object.entries(incoming).filter(([, v]) => v !== undefined && v !== null)
                  ),
                };
              }
              return;
            }

            // Handle specific packet types for local state management
            if (chunkType === 'status') {
              const stage = chunk.obj?.stage || chunk.stage;

              // Filter out internal context-related status packets
              // These are for backend processing and should not be displayed to users
              if (contentToAdd === 'context_start' ||
                contentToAdd === 'context_end' ||
                contentToAdd === 'processing_context' ||
                contentToAdd.startsWith('Context:')) {
                return; // Skip these internal status packets
              }

              // Parse and translate the status message
              // contentToAdd contains the status_code or custom message
              const parsed = parseStatusMessage(contentToAdd, stage, t);

              // Create a unique key for this status to detect duplicates
              const statusKey = `${parsed.stage}:${parsed.translatedContent}`;

              // Skip only if this exact translated status was just processed (consecutive duplicate)
              // This allows different statuses with the same stage to be displayed
              if (statusKey === lastProcessedStatusKey) {
                return;
              }

              // Update the status message and push to stage history
              lastProcessedStatusKey = statusKey; // Mark as processed
              const newStatus = {
                content: parsed.translatedContent,
                stage: parsed.stage
              };
              setStatusMessage(newStatus);
              setStageHistory(prev => [...prev.slice(-4), { ...newStatus, timestamp: Date.now() }]);
              return;
            }

            if (chunkType === 'intent_routing') {
              const sources = chunk.obj?.sources || [];
              const strategyName = chunk.obj?.strategy_name || '';
              let routingLabel: string;
              if (sources.includes('documents') && sources.includes('web')) {
                routingLabel = t('chat.status.intentRoutingHybrid');
              } else if (sources.includes('web') && !sources.includes('documents')) {
                routingLabel = t('chat.status.intentRoutingWebOnly');
              } else if (sources.includes('llm') && !sources.includes('documents')) {
                routingLabel = t('chat.status.intentRoutingDirect');
              } else {
                routingLabel = t('chat.status.intentRoutingRagOnly');
              }
              setStatusMessage({
                content: `${routingLabel} → ${strategyName}`,
                stage: 'intent_routing',
              });
              return;
            }

            // Deep research phase packets → update chat status bar
            if (chunkType === 'planning_progress') {
              const stage = chunk.obj?.stage || '';
              const message = chunk.obj?.message || '';
              const displayMsg = message || t(`chat.status.deepResearch.${stage}`, { defaultValue: t('chat.status.deepResearchAnalyzing') });
              const newStatus = { content: displayMsg, stage: 'research' };
              setStatusMessage(newStatus);
              setStageHistory(prev => [...prev.slice(-4), { ...newStatus, timestamp: Date.now() }]);
              return;
            }

            if (chunkType === 'task_decomposition_plan') {
              const taskCount = chunk.obj?.tasks?.length || 0;
              const newStatus = { content: t('chat.status.deepResearch.decomposingTasks', { count: taskCount }), stage: 'research' };
              setStatusMessage(newStatus);
              setStageHistory(prev => [...prev.slice(-4), { ...newStatus, timestamp: Date.now() }]);
              return;
            }

            if (chunkType === 'coordination_plan') {
              const newStatus = { content: t('chat.status.deepResearch.coordinatingAgents'), stage: 'research' };
              setStatusMessage(newStatus);
              setStageHistory(prev => [...prev.slice(-4), { ...newStatus, timestamp: Date.now() }]);
              return;
            }

            if (chunkType === 'agent_status') {
              const agentName = chunk.obj?.agent_name || '';
              const status = chunk.obj?.status || '';
              if (status === 'running' || status === 'searching') {
                const newStatus = { content: t('chat.status.deepResearch.agentWorking', { agent: agentName }), stage: 'search' };
                setStatusMessage(newStatus);
                setStageHistory(prev => [...prev.slice(-4), { ...newStatus, timestamp: Date.now() }]);
              }
              return;
            }

            if (chunkType === 'search_progress') {
              const query = chunk.obj?.query || '';
              const newStatus = { content: t('chat.status.deepResearch.searching', { query: query.substring(0, 60) }), stage: 'search' };
              setStatusMessage(newStatus);
              setStageHistory(prev => [...prev.slice(-4), { ...newStatus, timestamp: Date.now() }]);
              return;
            }

            if (chunkType === 'synthesis_start') {
              const newStatus = { content: t('chat.status.deepResearch.synthesizing'), stage: 'generation' };
              setStatusMessage(newStatus);
              setStageHistory(prev => [...prev.slice(-4), { ...newStatus, timestamp: Date.now() }]);
              return;
            }

            if (chunkType === 'validation_start') {
              const newStatus = { content: t('chat.status.deepResearch.validating'), stage: 'fact_check' };
              setStatusMessage(newStatus);
              setStageHistory(prev => [...prev.slice(-4), { ...newStatus, timestamp: Date.now() }]);
              return;
            }

            if (chunkType === 'quality_check') {
              const newStatus = { content: t('chat.status.deepResearch.qualityCheck'), stage: 'fact_check' };
              setStatusMessage(newStatus);
              setStageHistory(prev => [...prev.slice(-4), { ...newStatus, timestamp: Date.now() }]);
              return;
            }

            if (chunkType === 'thinking_delta' || chunkType === 'reasoning_delta') {
              // Start tracking thinking time on first thinking token
              if (!thinkStartTimeRef.current) {
                thinkStartTimeRef.current = Date.now();
              }
              // Collect thinking content for the dedicated "Razmišljanje"
              // reasoning panel (and message metadata). Do NOT also push it into
              // statusMessage/stageHistory: the reasoning panel already renders
              // the full narration, so mirroring each sentence into the blue
              // ChatProcessingIndicator below duplicated the same text twice on
              // screen. The indicator now carries only real status stages
              // (collection discovery, retrieval, generation) — distinct from
              // the thinking prose.
              const thinkingText = chunk.obj?.reasoning || chunk.obj?.content || '';
              if (thinkingText) {
                // Concatenate the raw delta verbatim — DeepSeek streams sub-word
                // tokens ("K", "oris", "nik"), so appending a separator here split
                // words apart ("K oris nik" instead of "Korisnik"). The model's
                // reasoning_content already carries its own whitespace/newlines.
                collectedThinkingContent += thinkingText;
              }
              // Do NOT fall through — reasoning_delta should never land in
              // the visible message body. The previous behaviour appended it
              // to streamingContent (mixing narration into the answer text).
              return;
            }

            if (chunkType === 'model_insight_start') {
              // The model's own-knowledge reflection begins; accumulate it into a
              // distinct block below the answer (never the visible message body).
              return;
            }
            if (chunkType === 'model_insight_delta') {
              const insightText = chunk.obj?.content || '';
              if (insightText) {
                collectedModelInsightContent += insightText;
              }
              return;
            }

            if (chunkType === 'rag_debug_info') {
              const d = chunk.obj;
              ragTraceMapRef.current.set('_current', {
                ...ragTraceMapRef.current.get('_current'),
                systemPromptPreview: d.system_prompt_preview,
                systemPromptLength: d.system_prompt_length,
                contextDocumentCount: d.context_document_count,
                contextTokenEstimate: d.context_token_estimate,
                historyMessageCount: d.history_message_count,
                hasConversationSummary: d.has_conversation_summary,
                contextWindowSize: d.context_window_size,
                strategyName: d.strategy_name,
                collectionNames: d.collection_names,
              });
              return;
            }

            if (chunkType === 'stream_end') {
              const e = chunk.obj;
              ragTraceMapRef.current.set('_current', {
                ...ragTraceMapRef.current.get('_current'),
                totalTokens: e.total_tokens,
                inputTokens: e.input_tokens,
                outputTokens: e.output_tokens,
                tokensPerSecond: e.tokens_per_second,
                costUsd: e.cost_usd,
                latencyMs: e.latency_ms,
                durationMs: e.duration_ms,
                provider: e.provider,
                model: e.model,
              });
              // Stop the loading UI as soon as the authoritative stream_end
              // PACKET arrives. We used to flip the loading flags only in the
              // stream-CLOSE completion callback (onEnd) — but when a proxy holds
              // the SSE socket open after the final byte, onEnd stays pending and
              // the red stop button never reverts. The final message commit stays
              // in onEnd (guarded by streamCompletedRef); here we only flip the
              // loading flags. streamEnded is intentionally left to onEnd so the
              // message doesn't re-render to its "final" form before commit.
              setIsLoading(false);
              setIsAiResponding(false);
              setMessageStreamingInProgress(false);
              if (streamingLoadingIdRef.current) {
                loadingService.stopStreaming(streamingLoadingIdRef.current);
                streamingLoadingIdRef.current = null;
              }
              // Stop thinking timer if it was running
              if (thinkStartTimeRef.current) {
                setThinkingTimeMs(Date.now() - thinkStartTimeRef.current);
                thinkStartTimeRef.current = null;
              }
              return;
            }

            if (chunkType === 'suggestions') {
              const questions = chunk.obj?.questions || [];
              const docId = chunk.obj?.document_id || '';
              if (questions.length > 0) {
                setFollowUpSuggestions(questions);
                setSuggestionDocumentId(docId);
              }
              return;
            }

            if (chunkType === 'chart_data') {
              const obj = chunk.obj;
              if (obj) {
                pendingChartDataRef.current = {
                  chart_type: obj.chart_type,
                  title: obj.title,
                  labels: obj.labels,
                  datasets: obj.datasets,
                  x_label: obj.x_label,
                  y_label: obj.y_label,
                };
              }
              return;
            }

            if (chunkType === 'error') {
              // Handle error chunks by showing a toast notification.
              // Agentic RAG agents (query/source/strategy) send a structured i18n
              // key in `content` (e.g. "agentic.query_analysis.parse_error") with a
              // generic error_code of "AGENT_ERROR". Prefer translating that specific
              // key — it resolves the nested `agentic.*` namespace — so a real agent
              // failure shows a readable message instead of the raw key. Fall back to
              // the error_code translation, then to a generic message.
              const errorCode = chunk.obj?.error_code || chunk.error_code;
              const isAgenticKey = typeof contentToAdd === 'string' && contentToAdd.startsWith('agentic.');
              const errorMessage = isAgenticKey
                ? t(contentToAdd, { defaultValue: t('general.errors.AGENT_ERROR', { defaultValue: 'An error occurred while processing the response' }) })
                : errorCode
                  ? t(`general.errors.${errorCode}`, { defaultValue: contentToAdd || 'An error occurred while processing the response' })
                  : contentToAdd || 'An error occurred while processing the response';

              toast.error({
                title: t('general.error'),
                description: errorMessage,
              });

              // End the stream and stop loading
              setStreamEnded(true);
              setIsAiResponding(false);
              setIsLoading(false);
              // Stop thinking timer on error
              if (thinkStartTimeRef.current) {
                setThinkingTimeMs(Date.now() - thinkStartTimeRef.current);
                thinkStartTimeRef.current = null;
              }
              return;
            }

            // Accumulate content for final message (from ALL content-bearing packets)
            // Include: message_delta, bot_answer, message_content, or any packet with content
            // Only accumulate actual message content — all other packet types are handled by dedicated UI
            // (deep research panel, status bar, thinking display, citations, etc.)
            if (contentToAdd && ['message_delta', 'bot_answer', 'message_content'].includes(chunkType)) {
              regularContent += contentToAdd;
              fullResponse += contentToAdd;

              // Clear status message when actual content starts streaming
              // This hides routing/processing status once the answer begins
              if (statusMessage && (chunkType === 'message_delta' || chunkType === 'bot_answer')) {
                setStatusMessage(null);
              }
            }
          } catch (chunkError) {
            console.error(
              'Error processing chunk:',
              chunkError,
              'Raw chunk:',
              chunk
            );
          }
        };

        const abortController = new AbortController();
        const signal = abortController.signal;

        // Store abort controller reference for cancel functionality
        const abortControllerRef = abortController;

        // Start the stream
        const { cancel } = await streamChat(
          request,
          handleChunk as (data: ChatStreamResponse) => void,
          error => {
            console.error('Stream error:', error);

            // Check if it's a 401 Unauthorized error
            let errorMessage =
              error.message ||
              'An error occurred while communicating with the AI.';

            // Check if it's a Response object (which would have status property)
            if (error instanceof Response && error.status === 401) {
              errorMessage =
                'Authentication error. Your session may have expired. Please try refreshing the page or logging out and back in.';
            }
            // Also check in the error message for 401 mentions
            else if (
              error.message?.includes('401') ||
              (error.toString && error.toString().includes('401'))
            ) {
              errorMessage =
                'Authentication error. Your session may have expired. Please try refreshing the page or logging out and back in.';
            }

            // Show an error toast only for significant errors, not for common backend issues
            if (
              !errorMessage.includes('500') &&
              !errorMessage.includes('Failed to fetch')
            ) {
              toast({
                title: 'Error',
                description: errorMessage,
                variant: 'destructive',
              });
            }

            setIsLoading(false);
            setStreamingContent(''); // Clear any streaming content on error
            setStreamEnded(true);
              setIsAiResponding(false); // Mark stream as ended

            // User message was already added at line 774, no need to add again

            // Add an error message to the session
            const errorMessageObj: Message = {
              id: uuidv4(),
              role: 'assistant',
              content: `Error: ${errorMessage}`,
              timestamp: new Date(),
            };

            // Add error message to session using proper session update
            setSessions(prev =>
              prev.map(session =>
                session.id === actualSessionId
                  ? {
                    ...session,
                    messages: [...(session.messages || []), errorMessageObj],
                  }
                  : session
              )
            );

            // Reset cancel ref since stream has ended with error
            cancelStreamRef.current = null;

            // Stop centralized loading service on error
            if (streamingLoadingIdRef.current) {
              loadingService.stopStreaming(streamingLoadingIdRef.current);
              streamingLoadingIdRef.current = null;
            }

            // DO NOT trigger background sync on error - error messages are local only
            // and syncing with database will overwrite them with empty arrays
          },
          () => {
            // Stream completion callback - guard against multiple invocations
            if (streamCompletedRef.current) {
              console.warn('⚠️ Stream completion callback called multiple times, ignoring duplicate');
              return;
            }
            streamCompletedRef.current = true;
            streamRecentlyCompletedRef.current = Date.now();

            // STEP 1: Clear streaming content immediately to prevent duplication
            setStreamingContent('');
            setStreamEnded(true);
              setIsAiResponding(false);

            // STEP 2: Add final message to session state BEFORE clearing isLoading
            // This ensures the message is visible before the loading state clears
            let finalMessageAdded = false;
            if (fullResponse && fullResponse.trim()) {
              setSessions(prev => {
                const currentSession = prev.find(s => s.id === actualSessionId);
                if (currentSession) {
                  const lastMessage = currentSession.messages?.[currentSession.messages.length - 1];
                  // Don't add if the last message is already an assistant message with the same content
                  if (lastMessage?.role === 'assistant' && lastMessage.content === fullResponse) {
                    return prev; // No change needed
                  }
                }

                finalMessageAdded = true;

                // Add the final assistant message to the session state
                const assistantMessageId = uuidv4();
                // Get research report from deep research context (if available)
                const researchReport = deepResearchPanelRef.current.researchReport;

                const chartDataSnapshot = pendingChartDataRef.current;
                pendingChartDataRef.current = null;

                const finalAssistantMessage: Message = {
                  id: assistantMessageId,
                  role: 'assistant',
                  content: fullResponse,
                  timestamp: new Date(),
                  // Attach collected citations, thinking, research report, and chart data to message metadata
                  message_metadata: {
                    ...(collectedCitations.length > 0 ? { citations: collectedCitations, retrieval_results: collectedCitations.length } : {}),
                    ...(collectedSearchStrategy ? { search_strategy: collectedSearchStrategy } : {}),
                    ...(collectedThinkingContent ? { thinking_content: collectedThinkingContent, thinking_time_ms: thinkingTimeMs || undefined } : {}),
                    ...(collectedModelInsightContent ? { model_insight_content: collectedModelInsightContent } : {}),
                    ...(researchReport ? {
                      research_report: {
                        title: researchReport.title,
                        plan_id: researchReport.planId,
                        full_report_markdown: researchReport.fullReportMarkdown,
                        quality_score: researchReport.qualityScore,
                        total_sources: researchReport.totalSources,
                        word_count: researchReport.wordCount,
                      }
                    } : {}),
                    ...(chartDataSnapshot ? { chart_data: chartDataSnapshot } : {}),
                    timestamp: new Date().toISOString(),
                  },
                };

                // Move RAG trace from _current to actual message ID
                const trace = ragTraceMapRef.current.get('_current');
                if (trace) {
                  ragTraceMapRef.current.set(assistantMessageId, trace);
                  ragTraceMapRef.current.delete('_current');
                }

                return prev.map(session =>
                  session.id === actualSessionId
                    ? {
                      ...session,
                      messages: [
                        ...(session.messages || []),
                        finalAssistantMessage,
                      ],
                      updatedAt: new Date(),
                      lastMessageFetchTime: Date.now(),
                    }
                    : session
                );
              });
            }

            // STEP 3: Clear loading states AFTER message is added
            // Small delay ensures React has rendered the message before clearing loading
            setTimeout(() => {
              setIsLoading(false);
              setMessageStreamingInProgress(false);
              
              // Stop centralized loading service
              if (streamingLoadingIdRef.current) {
                loadingService.stopStreaming(streamingLoadingIdRef.current);
                streamingLoadingIdRef.current = null;
              }
            }, 50);

            // Reset refs
            cancelStreamRef.current = null;

            // Remove session_state=new from URL after first message exchange
            const urlParams = new URLSearchParams(window.location.search);
            if (urlParams.get('session_state') === 'new') {
              urlParams.delete('session_state');
              const newUrl = `${window.location.pathname}?${urlParams.toString()}`;
              window.history.replaceState({}, '', newUrl);
            }

            // STEP 4: Merge message IDs and metadata from backend (optimistic UI pattern)
            // Wait for backend to store the message, then sync IDs
            setTimeout(async () => {
              try {
                // Fetch enough messages to cover the current conversation
                // Use the current message count + buffer to avoid losing messages
                const currentSession = sessions.find(s => s.id === actualSessionId);
                const currentMessageCount = currentSession?.messages?.length || 10;
                const fetchSize = Math.max(currentMessageCount + 5, 20); // At least 20, or current count + buffer

                const backendMessages = await getSessionMessages(actualSessionId, 1, fetchSize);

                // CRITICAL FIX: Only merge if backend has messages
                // Don't replace local messages with empty backend response
                if (backendMessages && backendMessages.length > 0) {
                  console.log(`📥 Backend returned ${backendMessages.length} messages for ID sync`);

                  setSessions(prev =>
                    prev.map(session => {
                      if (session.id !== actualSessionId) return session;

                      const existingMessages = session.messages || [];
                      console.log(`💬 Local state has ${existingMessages.length} messages`);

                      // CRITICAL FIX: If backend has fewer messages than local state,
                      // it means backend hasn't finished saving yet - keep local state
                      if (backendMessages.length < existingMessages.length) {
                        console.warn(`⚠️ Backend has fewer messages (${backendMessages.length}) than local state (${existingMessages.length}), keeping local state to prevent flash`);
                        return session; // Don't update - backend not ready yet
                      }

                      // ADDITIONAL CHECK: If backend has significantly more messages, something is wrong
                      if (backendMessages.length > existingMessages.length + 2) {
                        console.error(`❌ Backend has too many messages (${backendMessages.length}) vs local (${existingMessages.length}), keeping local state`);
                        return session; // Don't update - data mismatch
                      }

                      // Create maps for fast lookup - by both ID and content
                      const typedBackendMessages = backendMessages as BackendMessage[];
                      const backendMessageMapById = new Map<string, BackendMessage>(
                        typedBackendMessages.map(msg => [msg.id, msg])
                      );

                      // Create content-based map with role prefix to avoid matching user/assistant messages with same content
                      const backendMessageMapByContent = new Map<string, BackendMessage>(
                        typedBackendMessages.map(msg => [`${msg.role}:${msg.content?.trim()}`, msg])
                      );

                      // Track which backend messages have been matched
                      const matchedBackendIds = new Set<string>();

                      // Merge IDs into existing messages without replacing content
                      const mergedMessages = existingMessages.map(existingMsg => {
                        // First try to match by ID (if the local message already has a backend ID)
                        let matchingBackendMsg: BackendMessage | undefined = existingMsg.id ? backendMessageMapById.get(existingMsg.id) : undefined;

                        // If no ID match, try matching by role + content to prevent cross-role matches
                        if (!matchingBackendMsg) {
                          matchingBackendMsg = backendMessageMapByContent.get(`${existingMsg.role}:${existingMsg.content?.trim()}`);
                        }

                        if (matchingBackendMsg) {
                          // Found matching message in backend - merge ID and metadata
                          matchedBackendIds.add(matchingBackendMsg.id); // Mark as matched

                          // Safely parse message_metadata to prevent [object Object] issues
                          let backendMetadata = null;
                          try {
                            if (typeof matchingBackendMsg.message_metadata === 'string') {
                              // Only parse if it's a valid JSON string (not "[object Object]")
                              if (!matchingBackendMsg.message_metadata.startsWith('[object ')) {
                                backendMetadata = JSON.parse(matchingBackendMsg.message_metadata);
                              } else {
                                console.warn('Corrupted message_metadata detected (contains [object Object]), using existing metadata:', matchingBackendMsg.id);
                                backendMetadata = existingMsg.message_metadata; // Preserve local metadata
                              }
                            } else {
                              backendMetadata = matchingBackendMsg.message_metadata;
                            }
                          } catch (e) {
                            console.warn('Failed to parse message_metadata, using existing metadata:', matchingBackendMsg.id, e);
                            backendMetadata = existingMsg.message_metadata;
                          }

                          // Skip update if nothing changed — preserves object reference and prevents re-render
                          const resolvedMetadata = backendMetadata || existingMsg.message_metadata;
                          if (existingMsg.id === matchingBackendMsg.id &&
                              existingMsg.message_metadata === resolvedMetadata) {
                            return existingMsg;
                          }

                          return {
                            ...existingMsg,
                            id: matchingBackendMsg.id, // Update with backend ID
                            message_metadata: resolvedMetadata,
                          };
                        }

                        // No match in backend yet - keep existing message as-is (optimistic)
                        return existingMsg;
                      });

                      // DON'T add remaining backend messages - they're already in existingMessages
                      // The merge above handles ID syncing. Adding unmatched backend messages causes duplicates.

                      // If no message objects changed, return the same session to prevent re-render
                      const hasChanges = mergedMessages.some((msg, i) => msg !== existingMessages[i]);
                      if (!hasChanges) {
                        return session;
                      }

                      return {
                        ...session,
                        messages: mergedMessages,
                      };
                    })
                  );
                } else {
                  console.warn('⚠️ Backend returned no messages, keeping local state to prevent flash');
                }

                // Streaming flag was already cleared in STEP 3 above
              } catch (error) {
                console.error('Failed to merge message IDs:', error);
                // Don't need to clear streaming flag here - already done in STEP 3
              }
            }, 1500); // Wait 1.5s for backend to finish storing metadata

            // Refresh session list to get updated title from backend
            // Wait longer to ensure backend has finished title generation
            setTimeout(async () => {
              try {
                await refreshSessions();
              } catch (error) {
                console.error('Failed to refresh session list:', error);
              }
              // Always signal sidebar to re-fetch and re-sort, regardless of whether
              // refreshSessions was rate-limited or skipped by the stream guard
              setSidebarRefreshCount(prev => prev + 1);
            }, 5000); // Wait 5s for backend to finish title generation and message persistence
          },
          30000, // 30-second timeout
          signal
        );

        // Update the cancel function to abort the controller and call the stream cancel
        cancelStreamRef.current = () => {
          abortControllerRef.abort('User cancelled');
          cancel();
        };
      } catch (error) {
        console.error('Error sending message:', error);
        setIsLoading(false);
        // An early throw (before the stream-end handlers run) must also clear the
        // AI-responding flag, otherwise the send button stays a red Cancel and the
        // input is blocked until navigation.
        setIsAiResponding(false);

        // Only show toast for unexpected errors, not just server errors
        if (!error.toString().includes('500')) {
          toast({
            title: 'Error',
            description:
              error instanceof Error
                ? error.message
                : 'An unknown error occurred',
            variant: 'destructive',
          });
        }
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- deps are intentionally limited
    [
      sessions,
      selectedCollections,
      selectedSessionId,
      selectedModel,
      sessionMap,
      statusMessage,
      stageHistory,
      streamingContent,
      thinkingTimeMs,
      refreshSessions,
      pdfViewer,
      epubViewer,
    ]
  );

  // Function to update a message
  const updateMessage = useCallback(
    (sessionId: string, messageId: string, newContent: string) => {
      setSessions(prev =>
        prev.map(session =>
          session.id === sessionId
            ? {
              ...session,
              messages: (session.messages || []).map(msg =>
                msg.id === messageId ? { ...msg, content: newContent } : msg
              ),
            }
            : session
        )
      );
    },
    []
  );

  // Function to truncate messages from a specific index (for repeat functionality)
  // Note: Backend automatically handles deletion when detecting repeated messages
  // This is only used for explicit "Repeat" button clicks
  const removeMessagesById = useCallback(
    (sessionId: string, messageIds: Set<string>) => {
      setSessions(prev =>
        prev.map(session =>
          session.id === sessionId
            ? {
              ...session,
              messages: (session.messages || []).filter(msg => !messageIds.has(msg.id)),
              lastMessageFetchTime: Date.now(),
            }
            : session
        )
      );

      // Invalidate cache to prevent old messages from reappearing
      delete messagesCache.current[sessionId];
      cacheAccessOrder.current = cacheAccessOrder.current.filter(id => id !== sessionId);
    },
    [setSessions]
  );

  const truncateMessagesFromIndex = useCallback(
    (sessionId: string, messageIndex: number) => {
      // Update UI to remove messages from the specified index onwards
      // Backend will handle database deletion automatically when the repeated message is sent

      // Mark as loading to prevent auto-reload effect from triggering
      messagesLoadingRef.current[sessionId] = true;

      // Clear any streaming content to prevent old messages from being visible
      setStreamingContent('');
      setStreamEnded(false);

      setSessions(prev =>
        prev.map(session =>
          session.id === sessionId
            ? {
              ...session,
              messages: (session.messages || []).slice(0, messageIndex),
              // Set lastMessageFetchTime to prevent auto-reload from triggering
              // This prevents the race condition where old messages reappear from DB
              lastMessageFetchTime: Date.now(),
            }
            : session
        )
      );

      // Invalidate cache to prevent old messages from reappearing
      delete messagesCache.current[sessionId];
      cacheAccessOrder.current = cacheAccessOrder.current.filter(id => id !== sessionId);

      // Clear loading flag after state update to allow new streaming messages
      setTimeout(() => {
        messagesLoadingRef.current[sessionId] = false;
      }, 100);
    },
    []
  );

  // Function to select a session
  const selectSession = useCallback(
    (session: Session) => {
      // Mark URL session as consumed when user explicitly selects a different session
      if (initialSelectedId && session.id !== initialSelectedId) {
        initialSessionConsumedRef.current = true;
      }
      setSelectedSessionId(session.id);
      // Sync ref immediately so loadSessionMessages abort checks work for cached messages
      selectedSessionIdRef.current = session.id;

      // Clear session-specific state
      sessionExistsRef.current = {};
      messagesLoadingRef.current = {};

      // Reset streaming states
      setStreamingContent('');
      setStreamEnded(false);
      setIsLoading(true); // Show loading state while messages are being fetched
      setMessageStreamingInProgress(false);
      setThinkingTimeMs(0);
      thinkStartTimeRef.current = null;
      setStatusMessage(null);

      // Load messages for the selected session
      void loadSessionMessages(session.id);
    },
    [loadSessionMessages, initialSelectedId]
  );

  // Function to create a new session
  const handleNewSession = useCallback(async () => {
    // Check if there's already a session_id in the URL (from sidebar navigation)
    // If so, use that to keep URL and state in sync
    const urlParams = new URLSearchParams(window.location.search);
    const urlSessionId = urlParams.get('session_id');
    const urlSessionState = urlParams.get('session_state');

    // Use URL session_id if it exists and session_state=new, otherwise generate new one
    const newSessionId = (urlSessionId && urlSessionState === 'new') ? urlSessionId : uuidv4();

    // SELECT THE NEW (EMPTY) SESSION SYNCHRONOUSLY — before any async model
    // resolution below. When this runs right after deleting the currently-open
    // session, deferring the selection behind the model await left the
    // just-deleted session (still present in `sessions`) resolving as
    // `selectedSession`, so its OLD messages lingered on screen until the model
    // loaded — a visible, sometimes sticky gap on slower / mobile devices.
    // Selecting first closes that window; the model is patched in afterwards.
    const newSession: Session = {
      id: newSessionId,
      user_id: 'current-user',
      title: i18n.t('chat.newConversation'),
      conversation_name: i18n.t('chat.newConversation'),
      messages: [],
      createdAt: new Date(),
      updatedAt: new Date(),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      modelId: selectedModel?.id || 'default',
      model_name: selectedModel?.id || 'default',
      lastMessageFetchTime: Date.now(),
    };

    setSessions(prev => [newSession, ...prev]);
    setSelectedSessionId(newSessionId);
    // Sync the ref + URL synchronously to THIS new session. sendMessage reads
    // the ref then the URL as the session source, so a leftover stale ref/URL
    // (e.g. opening +New from an existing conversation) would otherwise make the
    // first message append to the OLD conversation.
    selectedSessionIdRef.current = newSessionId;
    {
      const sp = new URLSearchParams(window.location.search);
      sp.set('session_id', newSessionId);
      sp.set('session_state', 'new');
      window.history.replaceState(null, '', `${window.location.pathname}?${sp.toString()}`);
    }

    // Clear session-specific state
    sessionExistsRef.current = {};
    messagesLoadingRef.current = {};

    // Reset streaming states
    setStreamingContent('');
    setStreamEnded(false);
    setIsLoading(false); // Ensure isLoading is reset when creating new session
    setMessageStreamingInProgress(false);
    setThinkingTimeMs(0);
    thinkStartTimeRef.current = null;
    setStatusMessage(null);

    // Load the selected model in priority order: current selection > cached model > database > first available
    let modelToUse = selectedModel;

    if (!modelToUse && availableModels.length > 0) {
      try {
        // First priority: Check cached model selection from storage-utils
        const { modelSelections } = await import('@/lib/storage-utils');
        const cachedModelId = modelSelections.getActiveModel();

        if (cachedModelId) {
          // Try to find the cached model in available models
          modelToUse = availableModels.find(
            m =>
              m.id === cachedModelId ||
              m.model_name === cachedModelId
          );

          if (modelToUse) {
            // Cached model found in available models; will be used
          } else {
            // Cached model not in available models; will fall through to database lookup
          }
        }

        // Second priority: If cached model doesn't exist in available models, get from database and cache it
        if (!modelToUse) {
          const { getDefaultModel } = await import('@/lib/api-settings');
          const defaultModelData = await getDefaultModel();

          if (defaultModelData && defaultModelData.model) {
            // Find the model in available models by ID first (for UUIDs), then by name fields
            modelToUse = availableModels.find(
              m =>
                m.id === defaultModelData.model ||
                m.model_name === defaultModelData.model
            );

            if (modelToUse) {
              // Cache the database model for future use
              modelSelections.setActiveModel(
                modelToUse.id,
                modelToUse.model_name,
                modelToUse.provider_id || modelToUse.provider
              );
            }
          }
        }

        // Third priority: Use the first available model as fallback and cache it
        if (!modelToUse && availableModels.length > 0) {
          modelToUse = availableModels[0];
          // Cache the fallback model
          modelSelections.setActiveModel(
            modelToUse.id,
            modelToUse.model_name,
            modelToUse.provider_id || modelToUse.provider
          );
        }

        // Update the selected model state and notify parent components
        if (modelToUse) {
          setSelectedModel(modelToUse);

          // Also trigger the model selection handler to ensure UI is updated
          if (modelToUse.id && modelToUse.provider_type) {
            void handleModelSelect(
              modelToUse.id,
              modelToUse.model_name,
              modelToUse.provider_type
            );
          }
        }
      } catch (error) {
        console.warn('Failed to load model for new session:', error);
        // Final fallback: use first available model
        if (availableModels.length > 0) {
          modelToUse = availableModels[0];
          setSelectedModel(modelToUse);

          // Try to cache the fallback model
          try {
            const { modelSelections } = await import('@/lib/storage-utils');
            modelSelections.setActiveModel(
              modelToUse.id,
              modelToUse.model_name,
              modelToUse.provider_id || modelToUse.provider
            );
          } catch (cacheError) {
            console.warn('Failed to cache fallback model:', cacheError);
          }
        }
      }
    }

    // Patch the already-created (and already-selected) session with the resolved
    // model so the first message uses the right model — the session was created
    // synchronously above with a placeholder before the model was known.
    if (modelToUse) {
      const resolved = modelToUse;
      setSessions(prev =>
        prev.map(s =>
          s.id === newSessionId
            ? { ...s, modelId: resolved.id, model_name: resolved.id }
            : s
        )
      );
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- deps are intentionally limited
  }, [selectedModel, availableModels]);

  // Function to clear the selected session (show welcome dashboard)
  const clearSelectedSession = useCallback(() => {
    setSelectedSessionId(null);
    selectedSessionIdRef.current = null;
    // Drop the session_id from the URL too. sendMessage now treats the URL as a
    // durable session source, so a leftover ?session_id= here would make a
    // brand-new chat silently append to the just-cleared conversation.
    const sp = new URLSearchParams(window.location.search);
    if (sp.has('session_id') || sp.has('session_state')) {
      sp.delete('session_id');
      sp.delete('session_state');
      const qs = sp.toString();
      window.history.replaceState(null, '', qs ? `${window.location.pathname}?${qs}` : window.location.pathname);
    }
    setStreamingContent('');
    setStreamEnded(false);
    setIsLoading(false);
    setMessageStreamingInProgress(false);
    setThinkingTimeMs(0);
    thinkStartTimeRef.current = null;
    setStatusMessage(null);
  }, []);

  // Function to handle canceling a request
  const handleCancelRequest = useCallback(() => {
    if (cancelStreamRef.current) {
      cancelStreamRef.current();
      cancelStreamRef.current = null;
    }
    // Clear loading states but keep streaming content visible
    // The stream completion callback will handle clearing streamingContent
    // and saving the message with citations
    setIsLoading(false);
    setMessageStreamingInProgress(false);
    // Don't clear streamingContent here - let completion callback handle it
    // This preserves citations and thinking content when cancelling
    setStreamEnded(true);
              setIsAiResponding(false);
    setStatusMessage(null);
    // Stop thinking timer if running
    if (thinkStartTimeRef.current) {
      setThinkingTimeMs(Date.now() - thinkStartTimeRef.current);
      thinkStartTimeRef.current = null;
    }
  }, []);

  const getRagTrace = useCallback((messageId: string): RagTraceData | undefined =>
    ragTraceMapRef.current.get(messageId), []);

  return {
    sessions,
    selectedSessionId,
    isLoading,
    streamingContent,
    selectedModel,
    selectedCollection,
    selectedCollections,
    setSelectedModel,
    handleModelSelect,
    setSelectedCollection,
    setSelectedCollections,
    sendMessage,
    updateMessage,
    truncateMessagesFromIndex,
    removeMessagesById,
    refreshSessions,
    availableModels,
    modelsLoaded,
    streamEnded,
    statusMessage,
    stageHistory,
    thinkingTimeMs,
    handleNewSession,
    clearSelectedSession,
    selectSession,
    loadSessionMessages: selectSession,
    handleSendMessage: sendMessage,
    handleCancelRequest,
    messagesPage,
    hasMoreMessages,
    loadMoreMessages,
    loadingMoreMessages,
    setMessagesPage,
    setHasMoreMessages,
    setSessions,
    getRagTrace,
    sidebarRefreshCount,
    isAiResponding,
    followUpSuggestions,
    suggestionDocumentId,
  };
};

export { useSessionManagement };
export default useSessionManagement;
