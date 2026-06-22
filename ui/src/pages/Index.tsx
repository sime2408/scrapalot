import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { CHAT_WITH_DOCUMENT_EVENT, type ChatWithDocumentPayload } from '@/lib/chat-with-document';
import { ChatMessages } from '@/components/chat/chat-messages';
import { Sidebar } from '@/components/layout/sidebar/sidebar';
import { GlobalSidebarToggle } from '@/components/layout/sidebar/global-sidebar-toggle';
import {
  useIsMobile,
  useIsMobileOrTabletPortrait,
} from '@/hooks/use-mobile';
import { useSidebar } from '@/contexts/sidebar-context';
import { usePdfDrawer } from '@/hooks/use-pdf-drawer';
import { useNotesDrawer } from '@/hooks/use-notes-drawer';
import { useFloatingWindowManager } from '@/contexts/floating-window-context';
import { useSessionManagement } from '@/hooks/use-conversations';
import { useCollections } from '@/contexts/collections-context';
import { deleteSession } from '@/lib/api-sessions';
import { Model } from '@/types';
import { ChatMessageWelcome } from '@/components/chat/chat-message-welcome';
/* PDF and Notes drawer styles now centralized in index.css imports */
import type { SettingsTab } from '@/types/settings-types';
import { useFontSettings } from '@/contexts/font-settings-context';
import { useAuth } from '@/hooks/use-auth';
import { useWorkspace } from '@/hooks/use-workspace';
import { getWorkspaces } from '@/lib/api-workspace';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { api } from '@/lib/api';
import { useDynamicViewport } from '@/hooks/use-dynamic-viewport';
import { LicenseAgreementModal } from '@/components/auth/license-agreement-modal';
import { useModelSettingsPreload } from '@/hooks/use-model-settings-preload';
import { useSwipeGesture, type SwipeEvent } from '@/hooks/use-swipe-gesture';
import { KnowledgeStacksDialog } from '@/components/knowledge/knowledge-stacks-dialog';
import { DocumentInspectorDialog } from '@/components/admin/document-dashboard';

interface IndexProps {
  showWorkspaces?: boolean;
}

const Index = ({ showWorkspaces = false }: IndexProps) => {
  const isMobile = useIsMobile();
  const isMobileOrTabletPortrait = useIsMobileOrTabletPortrait();
  const { isSidebarOpen, toggleSidebar } = useSidebar();
  const isPdfOpen = usePdfDrawer();
  const { isOpen: isNotesOpen, open: openNotes, close: closeNotes } = useNotesDrawer();
  const floatingMgr = useFloatingWindowManager();
  // Notes "occupies side space" only when pinned. A floating notes panel
  // sits over the page and must NOT trigger CSS rules that collapse the
  // chat (e.g. `body.pdf-drawer-open.notes-drawer-open .conversation-content`
  // hides chat when both PDF and Notes are alongside it).
  const isNotesPinned = isNotesOpen && floatingMgr.modes['notes-drawer'] !== 'floating';
  const [showSettingsDialog, setShowSettingsDialog] = useState(false);
  const [activeSettingsTab, setActiveSettingsTab] =
    useState<SettingsTab>('general');
  const { fontSize, codeTheme } = useFontSettings();
  const { ensureModelsLoaded, user, refreshUser } = useAuth();
  const { selectWorkspace } = useWorkspace();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [showLicenseModal, setShowLicenseModal] = useState(false);
  const [showKnowledgeStackModal, setShowKnowledgeStackModal] = useState(false);
  const [knowledgeStackTab, setKnowledgeStackTab] =
    useState<'upload' | 'library' | 'connectors' | undefined>(undefined);
  const [showAdminInspector, setShowAdminInspector] = useState(false);

  // Stable empty callback refs to avoid inline arrow functions in JSX
  const noopFn = useCallback(() => { }, []);
  const noopCollectionChange = useCallback(() => { }, []);
  const handleOpenAdminInspector = useCallback(() => setShowAdminInspector(true), []);

  // Initialize dynamic viewport height handling for mobile browser UI
  useDynamicViewport();

  // Preload model settings when the user visits the chat screen
  const { modelSettings: preloadedModelSettings, preloadSettings } = useModelSettingsPreload();

  // Get session_id and session_state from URL query parameters
  const urlSessionId = searchParams.get('session_id');
  const sessionState = searchParams.get('session_state');

  // Handle OAuth callback tokens from URL parameters
  const accessToken = searchParams.get('access_token');
  const tokenType = searchParams.get('token_type');

  // Share deep-link: ?workspace=<id> switches the active workspace,
  // ?view=library opens the Knowledge Stacks library on arrival (from the
  // "Open Workspace" button in the share notification email).
  const workspaceParam = searchParams.get('workspace');
  const viewParam = searchParams.get('view');
  const deepLinkHandledRef = useRef(false);

  // Handle OAuth callback tokens from URL parameters
  useEffect(() => {
    if (accessToken && tokenType) {
      // Create an auth tokens object
      const authTokens = {
        access_token: accessToken,
        token_type: tokenType,
        expires_in: 3600, // Default to 1 hour if not provided
      };

      // Store tokens in sessionStorage (don't remember OAuth sessions by default)
      sessionStorage.setItem('auth_tokens', JSON.stringify(authTokens));
      sessionStorage.setItem('just_logged_in', 'true');

      // Set authorization header
      api.defaults.headers.common['Authorization'] = `Bearer ${accessToken}`;

      // Clean up URL by removing OAuth parameters
      const cleanUrl = new URL(window.location.href);
      cleanUrl.searchParams.delete('access_token');
      cleanUrl.searchParams.delete('token_type');

      // Hard navigation to the clean URL so AuthProvider re-initialises from
      // the freshly-stored tokens. The previous SPA navigate() + refreshUser()
      // left the provider mid-bootstrap on first Google login: the sidebar sat
      // in an infinite loading skeleton and the Google avatar / subscription
      // never loaded until a manual reload. Matches the invite / sign-up flows.
      window.location.replace(cleanUrl.pathname + cleanUrl.search);
    }
  }, [accessToken, tokenType, navigate, refreshUser]);

  // Handle the share deep-link once auth has bootstrapped. Runs a single time
  // (ref guard) then strips the params from the URL so a re-render — including
  // the one triggered by the workspace switch itself — does not re-fire it.
  useEffect(() => {
    if (!user) return;
    if (deepLinkHandledRef.current) return;
    if (!workspaceParam && viewParam !== 'library') return;
    deepLinkHandledRef.current = true;

    const UUID_RE =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

    (async () => {
      // Only switch to a workspace the user can actually access. A bad,
      // stale, or tampered ?workspace= value (deleted workspace, revoked
      // access, malformed id) must fail silently — not pop a "couldn't update
      // workspace" error toast — since selectWorkspace surfaces its own toast
      // on a 400. We validate the id shape, then confirm membership before
      // switching.
      if (workspaceParam) {
        if (!UUID_RE.test(workspaceParam)) {
          console.warn('Deep-link: ignoring invalid workspace id', workspaceParam);
        } else {
          try {
            const { workspaces } = await getWorkspaces(1, 100);
            if (workspaces.some((w) => w.id === workspaceParam)) {
              // selectWorkspace no-ops if it is already the current workspace.
              await selectWorkspace(workspaceParam);
            } else {
              console.warn('Deep-link: workspace not accessible, skipping switch', workspaceParam);
            }
          } catch (error) {
            console.error('Deep-link workspace switch failed:', error);
          }
        }
      }

      if (viewParam === 'library') {
        setKnowledgeStackTab('library');
        setShowKnowledgeStackModal(true);
      }

      // Consume the params so the deep-link is not re-applied on reload/back.
      const cleanUrl = new URL(window.location.href);
      cleanUrl.searchParams.delete('workspace');
      cleanUrl.searchParams.delete('view');
      navigate(cleanUrl.pathname + cleanUrl.search, { replace: true });
    })();
  }, [user, workspaceParam, viewParam, selectWorkspace, navigate]);

  // Force load user if we have tokens but no user (OAuth edge case)
  useEffect(() => {
    const checkAndLoadUser = async () => {
      const authTokens = sessionStorage.getItem('auth_tokens');

      // Force load user if we have tokens but no user
      if (authTokens && !user) {
        try {
          await refreshUser();
        } catch (error) {
          console.error('❌ Failed to load user:', error);
        }
      }
    };

    // Small delay to let auth context initialize
    const timer = setTimeout(checkAndLoadUser, 1000);
    return () => clearTimeout(timer);
  }, [user, refreshUser]);

  // Check if user needs to accept license agreement
  useEffect(() => {
    if (user) {
      if (user.license_agreement_consent === false) {
        setShowLicenseModal(true);
      } else {
        setShowLicenseModal(false);
      }
    }
  }, [user]);

  const handleLicenseAccepted = useCallback(async () => {
    setShowLicenseModal(false);
    await refreshUser();
  }, [refreshUser]);

  // Ensure models are loaded when the home page is mounted
  useEffect(() => {
    const preloadModels = async () => {
      try {
        await ensureModelsLoaded();
      } catch (error) {
        console.error('Error preloading models on Index page:', error);
      }
    };

    void preloadModels();
  }, [ensureModelsLoaded]);

  // Add body class when notes drawer is PINNED (not floating). Floating
  // notes don't take side space, so layout-CSS rules that target this
  // class (e.g. chat collapse when PDF+Notes both pinned) must not fire.
  useEffect(() => {
    if (isNotesPinned) {
      document.body.classList.add('notes-drawer-open');
    } else {
      document.body.classList.remove('notes-drawer-open');
    }

    return () => {
      document.body.classList.remove('notes-drawer-open');
    };
  }, [isNotesPinned]);

  const {
    sessions,
    selectedSessionId,
    isLoading,
    streamingContent,
    streamEnded,
    selectedModel,
    selectedCollection,
    setSelectedModel,
    handleModelSelect,
    availableModels,
    setSelectedCollection,
    handleNewSession,
    clearSelectedSession,
    selectSession,
    handleSendMessage,
    handleCancelRequest,
    updateMessage,
    truncateMessagesFromIndex,
    removeMessagesById,
    refreshSessions,
    hasMoreMessages,
    loadMoreMessages,
    loadingMoreMessages,
    statusMessage,
    stageHistory,
    thinkingTimeMs,
    setSessions,
    getRagTrace,
    sidebarRefreshCount,
    isAiResponding,
    followUpSuggestions,
    suggestionDocumentId,
  } = useSessionManagement([], urlSessionId, null, sessionState);


  // Listen for model selection changes from ChatModelSelector to keep selectedModel in sync
  useEffect(() => {
    const handleModelSelectionChanged = (event: CustomEvent) => {
      const { modelId } = event.detail;
      if (modelId) {
        // Try to find the full model object from availableModels
        const modelData = availableModels.find(m => m.id === modelId);
        if (modelData) {
          setSelectedModel(modelData);
        } else {
          // Model not in centralized list (probably from pagination page 2+)
          // Create a temporary model object from event data and localStorage
          // Get full model data from localStorage
          import('@/lib/storage-utils').then(({ modelSelections }) => {
            const storedModel = modelSelections.getActiveModelObject();
            if (storedModel && storedModel.model_id === modelId) {
              // Create model object from stored data
              const tempModel = {
                id: storedModel.model_id,
                model_name: storedModel.model_name,
                display_name: storedModel.display_name || storedModel.model_name,
                provider_type: storedModel.provider_type,
                provider_id: storedModel.provider_id,
              };
              setSelectedModel(tempModel);
            }
          });
        }
      }
    };

    window.addEventListener('modelSelectionChanged', handleModelSelectionChanged as EventListener);

    return () => {
      window.removeEventListener('modelSelectionChanged', handleModelSelectionChanged as EventListener);
    };
  }, [availableModels, setSelectedModel]);

  // Load model from localStorage on mount if no model is selected

  useEffect(() => {
    if (!selectedModel) {
      import('@/lib/storage-utils').then(({ modelSelections }) => {
        const storedModel = modelSelections.getActiveModelObject();
        if (storedModel && storedModel.model_id) {
          const tempModel: Model = {
            id: storedModel.model_id,
            model_name: storedModel.model_name,
            display_name: storedModel.display_name || storedModel.model_name,
            provider_type: storedModel.provider_type || '',
            provider_id: storedModel.provider_id,
            name: storedModel.display_name || storedModel.model_name,
            model_type: '',
            provider: storedModel.provider_type || '',
            size: 0,
            parameters: '',
            format: '',
            path: '',
            file_size: 0,
            status: 'available',
            is_active: true,
            tags: [],
            description: '',
            compatibility: 0,
            deployment_status: 'available',
          };
          setSelectedModel(tempModel);
        } else {
          // Fallback: auto-select system provider (Scrapalot AI) for new users
          if (availableModels && availableModels.length > 0) {
            const systemModel = availableModels.find(m =>
              m.provider_type?.toLowerCase() === 'system' && m.model_type !== 'EMBEDDING'
            );
            if (systemModel) {
              setSelectedModel(systemModel);
            }
          }
        }
      });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- deps are intentionally limited
  }, [selectedModel?.id]);

  const selectedSession = useMemo(
    () => sessions.find(session => session.id === selectedSessionId),
    [sessions, selectedSessionId]
  );

  // Restore the opened session's pinned collection scope (sessions.collection_id)
  // into selectedCollection — the single source of truth that drives BOTH the
  // toolbar badge AND the collection_ids used when sending. Without this the badge
  // was restored toolbar-locally while the query scope stayed empty. SET-only and
  // keyed once per session: it acts only when a definite collection_id resolves to
  // a loaded collection, and never clears on a transient missing id (merged /
  // streaming session objects can briefly lack it).
  const { collections: availableCollections } = useCollections();
  const restoredCollectionSessionRef = useRef<string | null>(null);
  useEffect(() => {
    if (!selectedSessionId) return;
    if (restoredCollectionSessionRef.current === selectedSessionId) return;
    const session = sessions.find(s => s.id === selectedSessionId);
    if (!session) return; // session not in the list yet — re-runs when it arrives
    const cid = session.collection_id;
    if (!cid) return; // no pinned scope (or not yet resolved) — don't clear on a transient miss
    const match = availableCollections.find(c => c.id === cid);
    if (!match) return; // collections not loaded yet — re-runs when they arrive
    restoredCollectionSessionRef.current = selectedSessionId;
    setSelectedCollection(match);
  }, [selectedSessionId, sessions, availableCollections, setSelectedCollection]);

  // Preload model settings for the selected session
  useEffect(() => {
    if (selectedSessionId) {
      void preloadSettings(selectedSessionId);
    }
  }, [selectedSessionId, preloadSettings]);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- type is dynamic
  const handleSessionSelect = useCallback((session: any) => {
    selectSession(session);
  }, [selectSession]);

  const handleCreateNewSession = useCallback(() => {
    void handleNewSession();
  }, [handleNewSession]);

  const handleDeleteSession = useCallback(async (sessionId: string) => {
    try {
      await deleteSession(sessionId);
    } catch (error) {
      console.error('Error deleting session from backend:', error);
    }
    setSessions(prev => prev.filter(s => s.id !== sessionId));
    if (selectedSessionId === sessionId) {
      clearSelectedSession();
    }
  }, [selectedSessionId, clearSelectedSession, setSessions]);

  // Auto-trigger new conversation when navigating from workspaces to dashboard
  useEffect(() => {
    if (!showWorkspaces && !selectedSession) {
      // Check if we came from workspaces by looking at the previous URL
      if (document.referrer.includes('/workspaces')) {
        handleCreateNewSession();
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- deps are intentionally limited
  }, [showWorkspaces, selectedSession]);

  // Auto-open a new chat on mobile / tablet-portrait when no conversation is
  // actually on screen, so the user never lands on the "No conversation
  // selected" welcome screen and has to tap "Start new" by hand.
  useEffect(() => {
    if (!isMobileOrTabletPortrait) return;
    // A real session is displayed — nothing to do.
    if (selectedSession) return;
    // A send/stream in flight is resolving a freshly-minted session whose
    // object isn't in `sessions` yet. Auto-creating now would mint a SECOND
    // session and split the conversation (lost history → assistant asks
    // "which book?"). Bail while busy; the effect re-arms once it settles.
    if (isLoading || isAiResponding) return;
    // An EXISTING (non-new) session id is present but not yet loaded — let the
    // loader resolve it rather than racing a competing new chat onto screen.
    // A leftover `?session_state=new` (a chat closed before its first message,
    // never materialised into `sessions`) is NOT a real session, so it falls
    // through to auto-create below instead of wedging on the welcome screen —
    // this is the case that regressed when the id/URL guard was added.
    const params = new URLSearchParams(window.location.search);
    const pendingExisting =
      (selectedSessionId || params.get('session_id')) &&
      params.get('session_state') !== 'new';
    if (pendingExisting) return;
    const timer = setTimeout(() => {
      // Re-check at fire time: if an existing session resolved into the URL
      // during the delay, don't clobber it. handleCreateNewSession adopts a
      // `?session_state=new` id, so a leftover new-session URL is reused here,
      // not duplicated.
      const p = new URLSearchParams(window.location.search);
      if (p.get('session_id') && p.get('session_state') !== 'new') return;
      handleCreateNewSession();
    }, 100);
    return () => clearTimeout(timer);
  }, [
    isMobileOrTabletPortrait,
    selectedSession,
    selectedSessionId,
    isLoading,
    isAiResponding,
    handleCreateNewSession,
  ]);

  // PDF/EPUB/DOCX viewer "Chat with this document" handoff. The chat
  // toolbar already listens for CHAT_WITH_DOCUMENT_EVENT, but it is only
  // mounted when a session exists. When the user is on the welcome
  // screen we buffer the payload, spin up a new session, and re-emit
  // the event after the toolbar has mounted so its listener picks the
  // mention up.
  const pendingChatDocRef = useRef<ChatWithDocumentPayload | null>(null);
  useEffect(() => {
    const handler = (event: Event) => {
      const e = event as CustomEvent<ChatWithDocumentPayload>;
      if (!e.detail?.documentId) return;
      if (selectedSession) return; // toolbar will handle directly
      pendingChatDocRef.current = e.detail;
      handleCreateNewSession();
    };
    window.addEventListener(CHAT_WITH_DOCUMENT_EVENT, handler);
    return () => window.removeEventListener(CHAT_WITH_DOCUMENT_EVENT, handler);
  }, [selectedSession, handleCreateNewSession]);

  useEffect(() => {
    if (!selectedSession || !pendingChatDocRef.current) return;
    const payload = pendingChatDocRef.current;
    pendingChatDocRef.current = null;
    // Child effects (chat toolbar's listener registration) run before
    // parent effects, so by the time this fires the listener exists.
    window.dispatchEvent(
      new CustomEvent<ChatWithDocumentPayload>(CHAT_WITH_DOCUMENT_EVENT, { detail: payload })
    );
  }, [selectedSession]);

  const handleLoadMoreMessages = useCallback(() => {
    if (selectedSessionId && hasMoreMessages) {
      loadMoreMessages(selectedSessionId);
    }
  }, [selectedSessionId, hasMoreMessages, loadMoreMessages]);

  const handleModelSelectWrapper = useCallback((model: Model) => {
    const modelName = model.model_name || model.display_name;
    void handleModelSelect(model.id, modelName, model.provider_type);
  }, [handleModelSelect]);

  const openSettingsWithTab = useCallback((tab: string) => {
    setActiveSettingsTab(tab as SettingsTab);
    setShowSettingsDialog(true);
  }, []);

  const handleOpenKnowledgeStack = useCallback(() => {
    // Manual opens use the default 'upload' tab, not whatever a prior
    // deep-link requested.
    setKnowledgeStackTab(undefined);
    setShowKnowledgeStackModal(true);
  }, []);

  const handleToggleSidebar = useCallback(() => {
    if (isMobileOrTabletPortrait) {
      setMobileMenuOpen(prev => !prev);
    } else {
      toggleSidebar();
    }
  }, [isMobileOrTabletPortrait, toggleSidebar]);

  // Handle swipe gestures safely with error boundaries and state validation
  const handleSwipe = React.useCallback((swipeEvent: SwipeEvent) => {
    try {
      // Only handle swipes on mobile/tablet devices to avoid conflicts with desktop interactions
      if (!isMobileOrTabletPortrait) return;

      // Validate swipe event and check component is still mounted
      if (!swipeEvent || typeof swipeEvent.direction !== 'string') return;

      // Right swipe (left to right):
      //  - if notes drawer is open, close it (mirror of left-closes-sidebar)
      //  - else open sidebar when both sidebars are closed
      if (swipeEvent.direction === 'right') {
        if (isNotesOpen) {
          closeNotes();
        } else if (!mobileMenuOpen && !isSidebarOpen) {
          setMobileMenuOpen(true);
        }
      }
      // Left swipe (right to left):
      //  - if sidebar is open, close it (existing)
      //  - else open notes drawer when it's not already open
      else if (swipeEvent.direction === 'left') {
        if (mobileMenuOpen) {
          setMobileMenuOpen(false);
        } else if (!isNotesOpen) {
          openNotes();
        }
      }
    } catch (error) {
      console.error('Error handling swipe gesture:', error);
    }
  }, [isMobileOrTabletPortrait, mobileMenuOpen, isSidebarOpen, isNotesOpen, openNotes, closeNotes]);

  // Configure swipe gesture with conservative settings to prevent false positives
  const { touchHandlers } = useSwipeGesture(handleSwipe, {
    minSwipeDistance: 50,
    maxSwipeTime: 500,
    maxVerticalDeviation: 100
  });

  // Get sidebar width from context
  const { sidebarWidth } = useSidebar();

  // Memoize main class to avoid string concatenation on every render
  const mainClassName = useMemo(() => {
    const baseClass =
      'flex-1 flex flex-col overflow-hidden transition-all duration-500 ease-in-out relative chat-container';
    const pdfClass = isPdfOpen ? 'shift-for-pdf' : '';
    const notesClass = isNotesOpen ? 'shift-for-notes' : '';
    return `${baseClass} ${pdfClass} ${notesClass}`.trim();
  }, [isPdfOpen, isNotesOpen]);

  // Memoize main style to avoid recalculation on every render
  const mainStyle = useMemo(() => {
    if (isMobile) {
      return { marginLeft: '0px' };
    }
    if (isNotesOpen || isPdfOpen) {
      return { marginLeft: isSidebarOpen ? `${sidebarWidth}px` : '56px' };
    }
    if (isSidebarOpen) {
      return { marginLeft: `${sidebarWidth + 70}px` };
    }
    return { marginLeft: '70px' };
  }, [isMobile, isNotesOpen, isPdfOpen, isSidebarOpen, sidebarWidth]);

  return (
    <div
      data-testid="page-dashboard-container"
      className={`flex bg-background w-full overflow-hidden h-screen-dynamic${isMobileOrTabletPortrait ? ' dashboard-reveal' : ''}`}
    >
      <Sidebar
        isMobile={isMobileOrTabletPortrait}
        isOpen={isSidebarOpen}
        isChatPage={true}
        onToggleSidebar={toggleSidebar}
        selectedCollection={selectedCollection}
        onSelectCollection={setSelectedCollection}
        selectedSessionId={selectedSessionId}
        onSelectSession={handleSessionSelect}
        onNewSession={handleCreateNewSession}
        refreshSessions={refreshSessions}
        sidebarRefreshCount={sidebarRefreshCount}
        sessions={sessions}
        openSettingsWithTab={openSettingsWithTab}
        showSettingsDialog={showSettingsDialog}
        setShowSettingsDialog={setShowSettingsDialog}
        activeSettingsTab={activeSettingsTab}
        mobileMenuOpen={mobileMenuOpen}
        onMobileMenuToggle={setMobileMenuOpen}
        onShowWorkspaceManagement={noopFn}
      />

      <main
        className={mainClassName}
        style={{
          ...mainStyle,
          zIndex: 10, // Below PDF and Notes drawers (z-index: 60)
          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- type is dynamic
          ['--sidebar-width' as any]: `${sidebarWidth}px`, // CSS variable for sidebar width
        }}
        data-main-content
        data-sidebar-open={isSidebarOpen}
        data-mobile={isMobile}
        {...(isMobileOrTabletPortrait ? touchHandlers : {})}
      >
        {selectedSession ? (
          <ChatMessages
            session={selectedSession}
            selectedModel={selectedModel}
            selectedCollection={selectedCollection}
            streamingContent={streamingContent}
            streamEnded={streamEnded}
            isLoading={isLoading}
            statusMessage={statusMessage}
            stageHistory={stageHistory}
            thinkingTimeMs={thinkingTimeMs}
            onSendMessage={handleSendMessage}
            onUpdateMessage={updateMessage}
            onTruncateMessages={truncateMessagesFromIndex}
            onRemoveMessages={removeMessagesById}
            onCancelRequest={handleCancelRequest}
            onSelectModel={handleModelSelectWrapper}
            onSelectCollection={setSelectedCollection}
            onToggleSidebar={handleToggleSidebar}
            isMobile={isMobileOrTabletPortrait}
            onLoadMoreMessages={handleLoadMoreMessages}
            loadingMoreMessages={loadingMoreMessages}
            hasMoreMessages={hasMoreMessages}
            messageStreamingInProgress={false}
            openSettingsWithTab={openSettingsWithTab}
            openKnowledgeStacks={handleOpenKnowledgeStack}
            codeTheme={codeTheme}
            fontSize={fontSize}
            onNewSession={handleCreateNewSession}
            onDeleteSession={handleDeleteSession}
            preloadedModelSettings={preloadedModelSettings}
            getRagTrace={getRagTrace}
            isAiResponding={isAiResponding}
            followUpSuggestions={followUpSuggestions}
            suggestionDocumentId={suggestionDocumentId}
          />
        ) : (
          <ChatMessageWelcome
            onNewSession={handleCreateNewSession}
            isDrawerOpen={isPdfOpen || isNotesOpen}
          />
        )}
      </main>

      {/* Global sidebar toggle for small screens */}
      <GlobalSidebarToggle
        mobileMenuOpen={mobileMenuOpen}
        onMobileMenuToggle={setMobileMenuOpen}
        onOpenAdminInspector={handleOpenAdminInspector}
      />

      {/* License Agreement Modal */}
      <LicenseAgreementModal
        open={showLicenseModal}
        onAccepted={handleLicenseAccepted}
      />

      {/* Knowledge Stacks Dialog */}
      <KnowledgeStacksDialog
        open={showKnowledgeStackModal}
        onOpenChange={setShowKnowledgeStackModal}
        onCollectionChange={noopCollectionChange}
        defaultTab={knowledgeStackTab}
      />

      {/* Admin Inspector Dialog - for mobile access */}
      {showAdminInspector && (
        <DocumentInspectorDialog
          open={showAdminInspector}
          onOpenChange={setShowAdminInspector}
        />
      )}
    </div>
  );
};

export default Index;
