import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {ChatInputText} from './chat-input-text.tsx';
import {ChatModelSelector} from './chat-model-selector.tsx';
import {Actions} from '@/components/chat/toolbar/actions/actions.tsx';
import {ChatInputSend} from '@/components/chat/toolbar/chat-input-send.tsx';
import {ChatMicButton} from '@/components/chat/toolbar/chat-mic-button.tsx';
import {AnnotationColorFilterPopover} from '@/components/chat/toolbar/popover-annotation-color-filter';
import {Headphones, ImagePlus, Wrench} from 'lucide-react';
import {ImageGenerationDialog} from '@/components/chat/image-generation-dialog';
import {Button} from '@/components/ui/button';
import {ChatToolbarNoModelsDialog} from './chat-toolbar-nomodels.tsx';
import {TutorProgressBadge} from '@/components/chat/tutor-progress-badge';
import {ChatMentionPopover} from './chat-mention-popover.tsx';
import {ChatMentionChips} from './chat-mention-chips.tsx';
import {DocumentCollection, Model, ModelSettings, PromptTemplate, SendMessageOptions} from '@/types';
import type {ChatAttachment} from '@/types/file-attachments';
import type {MentionItem} from '@/hooks/use-chat-mentions';
import {useModels} from '@/contexts/models-context';
import {useTranslation} from 'react-i18next';
import {useIsMobileOrTabletPortrait, useIsNarrowScreen,} from '@/hooks/use-mobile';
import {cn} from '@/lib/utils';
import {getGeneralSettings, saveGeneralSettings} from '@/lib/api-settings';
import {X} from 'lucide-react';
import {useChatMentions} from '@/hooks/use-chat-mentions';
import {useChatScopeStore} from '@/hooks/use-chat-scope-store';
import {useSimpleMode, setSimpleModeEnabled} from '@/hooks/use-simple-mode';
import {useCollections} from '@/contexts/collections-context';
import {CHAT_WITH_DOCUMENT_EVENT, type ChatWithDocumentPayload} from '@/lib/chat-with-document';
import {usePDFViewer} from '@/contexts/pdf-viewer-context';
import {useEpubViewer} from '@/contexts/epub-viewer-context';
import {useDocxViewer} from '@/contexts/docx-viewer-context';
import {ChatTokenUsage} from './chat-token-usage';
import {AppVersionBadge} from './app-version-badge';
import {getSessionAttachments, deleteSessionAttachment, type SessionAttachmentMeta} from '@/lib/api-sessions';
// ResearchSetupDialog removed — setup is now inline in chat messages

interface ToolbarOptions {
  web_search_enabled?: boolean;
  deep_research_enabled?: boolean;
  research_breadth?: number;
  research_depth?: number;
}

interface ChatInputProps {
  onSendMessage: (
    content: string,
    options?: SendMessageOptions
  ) => Promise<void>;
  onCancelRequest?: () => void;
  isLoading: boolean;
  onModelChange?: (model: Model) => void;
  initialSessionId?: string;
  selectedCollections?: DocumentCollection[];
  onSelectCollections?: (collections: DocumentCollection[]) => void;
  openSettingsWithTab?: (tab: string) => void;
  selectedModel?: Model; // Add this prop to receive the global selected model
  session?: { id?: string; collection_id?: string | null }; // Session data for model selection + pinned collection scope
  preloadedModelSettings?: ModelSettings | null;
  onOptionsChange?: (options: ToolbarOptions) => void; // Report current options for repeat functionality
  /** Open the VoiceModeDialog (rendered by the parent chat-messages.tsx
   *  where stream-end state + the latest assistant text are available).
   *  Receives the document mentions currently in the chat input so the
   *  voice agent gets the same @-scoped books the textarea has. */
  onOpenVoiceMode?: (documents: Array<{ id: string; title: string }>) => void;
}

export const ChatToolbar = ({
  onSendMessage,
  onCancelRequest,
  isLoading,
  onModelChange,
  initialSessionId,
  selectedCollections = [],
  onSelectCollections,
  openSettingsWithTab,
  selectedModel: globalSelectedModel, // Receive global model as prop
  session,
  preloadedModelSettings,
  onOptionsChange,
  onOpenVoiceMode,
}: ChatInputProps) => {
  const { t, i18n } = useTranslation();
  const simpleMode = useSimpleMode();
  const [message, setMessage] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const cursorPosRef = useRef(0);
  const [localSelectedModel, setLocalSelectedModel] = useState('');

  const {
    mentions,
    mentionState,
    suggestions,
    docsLoading,
    handleInputChange: handleMentionInput,
    selectSuggestion,
    addMention,
    clearMentions,
    closeMentions,
    removeMention,
    mentionedCollectionIds,
    mentionedDocumentIds,
    cleanPrompt,
  } = useChatMentions();

  // Snapshot of @-mentioned books for the voice-mode trigger. We hand
  // these to the parent (chat-messages.tsx) on click so the
  // VoiceModeDialog can render thumbnails and the backend can wire
  // grep_search + cat_document against the right document_ids.
  const voiceModeDocsFromMentions = useMemo(
    () =>
      mentions
        .filter((m) => m.type === 'document')
        .map((m) => ({ id: m.id, title: m.name })),
    [mentions],
  );
  const openVoiceMode = useCallback(() => {
    onOpenVoiceMode?.(voiceModeDocsFromMentions);
  }, [onOpenVoiceMode, voiceModeDocsFromMentions]);

  const { dispatch: pdfDispatch } = usePDFViewer();
  const { dispatch: epubDispatch } = useEpubViewer();
  const { dispatch: docxDispatch } = useDocxViewer();

  // Viewer → chat handoff: listen for `openChatWithDocument(...)` events and
  // attach the document as a mention + focus the textarea. Decouples viewers
  // from the chat state (they only import the helper, not a context).
  useEffect(() => {
    const handler = (event: Event) => {
      const e = event as CustomEvent<ChatWithDocumentPayload>;
      if (!e.detail?.documentId || !e.detail?.documentName) return;
      addMention({
        type: 'document',
        id: e.detail.documentId,
        name: e.detail.documentName,
        collectionId: e.detail.collectionId,
        collectionName: e.detail.collectionName,
        pageCount: e.detail.pageCount,
      });
      const isTouchDevice =
        typeof window !== 'undefined' &&
        window.matchMedia?.('(pointer: coarse)').matches === true;
      // Explicit "Chat with this document" tap on mobile: close the
      // viewer drawer so chat is foreground. The chip then acts as a
      // minimized state — tap (or its Maximize icon) reopens the viewer
      // at the saved reading position. silent=true means the viewer
      // auto-mentioned on open (user is still reading) — don't close.
      if (!e.detail.silent && isTouchDevice) {
        pdfDispatch({ type: 'CLOSE_PDF_VIEWER' });
        epubDispatch({ type: 'CLOSE_EPUB_VIEWER' });
        docxDispatch({ type: 'CLOSE_DOCX_VIEWER' });
      }
      // Focus the input so the user can start typing immediately, unless:
      //   • the caller flagged the event as silent (viewer auto-mention on open)
      //   • the device has a coarse pointer (touch) — focusing pops the soft
      //     keyboard the user didn't ask for when they tapped the viewer's
      //     "Chat with this document" button.
      if (!e.detail.silent && !isTouchDevice) {
        requestAnimationFrame(() => textareaRef.current?.focus());
      }
    };
    window.addEventListener(CHAT_WITH_DOCUMENT_EVENT, handler);
    return () => window.removeEventListener(CHAT_WITH_DOCUMENT_EVENT, handler);
  }, [addMention, pdfDispatch, epubDispatch, docxDispatch]);

  // Use the unified models context instead of separate API calls
  const { availableModels, modelsLoaded, isLoading: modelsLoading } = useModels();
  // Suppress unused variable warning — modelsLoading is used indirectly via modelsLoaded
  void modelsLoading;
  // Use initialSessionId directly instead of state to prevent session ID mismatches
  const [collections, setCollections] =
    useState<DocumentCollection[]>(selectedCollections);
  const [webSearchEnabled, setWebSearchEnabled] = useState(false);
  const [imageGenerationOpen, setImageGenerationOpen] = useState(false);

  // Bidirectional sync with the global scope store so the Notes drawer
  // popover and the chat toolbar share one list of selected collections
  // + one Web search flag. Equality guards on both sides prevent the
  // ping-pong loop that naive two-way binding would create.
  const setStoreSelectedCollectionIds = useChatScopeStore((s) => s.setSelectedCollectionIds);
  const setStoreWebSearchEnabled = useChatScopeStore((s) => s.setWebSearchEnabled);
  const storeSelectedCollectionIds = useChatScopeStore((s) => s.selectedCollectionIds);
  const storeWebSearchEnabled = useChatScopeStore((s) => s.webSearchEnabled);
  const { collections: availableCollections } = useCollections();

  // local → store, one direction. We deliberately read the store via
  // getState() rather than the subscribed snapshot so that this effect
  // never observes a value the previous render committed but a sibling
  // effect is still closing over (the older two-effect ping-pong issued
  // ~40 Hz of setSelectedCollection(null)/anthropology because both
  // effects ran in the same render with the same stale closure of
  // `storeSelectedCollectionIds` and each "corrected" the other).
  useEffect(() => {
    const localIds = collections.map((c) => c.id);
    const localKey = localIds.slice().sort().join(',');
    const freshStoreIds = useChatScopeStore.getState().selectedCollectionIds;
    const storeKey = freshStoreIds.slice().sort().join(',');
    if (localKey === storeKey) return;
    setStoreSelectedCollectionIds(localIds);
  }, [collections, setStoreSelectedCollectionIds]);

  useEffect(() => {
    if (storeWebSearchEnabled === webSearchEnabled) return;
    setStoreWebSearchEnabled(webSearchEnabled);
  }, [webSearchEnabled, storeWebSearchEnabled, setStoreWebSearchEnabled]);

  // store → local (read-only, no parent callback). The previous
  // implementation also called `onSelectCollections?.(next)` so that
  // mutations from the notes-drawer popover would propagate into the
  // chat session's selectedCollection. That feedback edge created the
  // pingpong above. Notes drawer keeps its own `noteResearchContext`
  // and reads the store directly when it needs to render the collection
  // list, so the chat parent does not need to be notified here.
  useEffect(() => {
    const localIds = collections.map((c) => c.id);
    const localKey = localIds.slice().sort().join(',');
    const storeKey = storeSelectedCollectionIds.slice().sort().join(',');
    if (localKey === storeKey) return;
    const next = availableCollections.filter((c) => storeSelectedCollectionIds.includes(c.id));
    // Guard against an infinite re-render loop: when the store references ids
    // that are not (yet) present in availableCollections (pagination / async
    // load), `next` resolves fewer ids than the store has, so localKey !==
    // storeKey stays true forever and setCollections([...]) creates a fresh
    // array reference every render. Only apply when the resolved result would
    // actually change the local list; otherwise wait for availableCollections
    // to load the missing ids (this effect re-runs when they arrive).
    const nextKey = next.map((c) => c.id).slice().sort().join(',');
    if (nextKey === localKey) return;
    setCollections(next);
  }, [storeSelectedCollectionIds, availableCollections, collections]);

  useEffect(() => {
    if (storeWebSearchEnabled === webSearchEnabled) return;
    setWebSearchEnabled(storeWebSearchEnabled);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- webSearchEnabled intentionally omitted to avoid self-loop; equality guard above handles correctness
  }, [storeWebSearchEnabled]);
  const [deepResearchEnabled, setDeepResearchEnabled] = useState(false);
  const [researchTemplateType, _setResearchTemplateType] = useState<string | null>(null);
  // Settings → Prompts → Custom Templates picker. Selecting a template
  // in the toolbar popover stores its title here; buildSendOptions then
  // forwards it as `prompt_template_name` so Layer 6 of the Python
  // system-prompt builder injects the template body. Re-clicking the
  // same template clears the selection (toggle semantics).
  const [activePromptTemplateName, setActivePromptTemplateName] = useState<string | null>(null);

  // Toolbar handler for the prompt-template popover. Beyond setting the
  // backend metadata field, we also seed the chat textarea with the
  // template content so the user immediately *sees* what they picked
  // and can edit it before sending. Toggling off (clicking the active
  // template again) clears the textarea only when it still contains
  // the unedited template body — never blow away a draft the user has
  // typed on top.
  const handleSelectPromptTemplate = useCallback(
    (template: PromptTemplate | null) => {
      if (template === null) {
        // Toggle-off: clear the textarea only if it still equals the
        // body of the previously active template (i.e. the user did
        // not modify it).
        setMessage(prev => {
          if (!activePromptTemplateName) return prev;
          // We don't have the previous template body here; safest to
          // keep whatever is in the textarea so we never lose user
          // input. The toolbar badge / popover check mark already
          // makes the deselection visible.
          return prev;
        });
        setActivePromptTemplateName(null);
        return;
      }
      setActivePromptTemplateName(template.title);
      // Seed the textarea. Replacing is fine — the user just clicked
      // a fresh template and expects its body to appear.
      setMessage(template.content || '');
    },
    [activePromptTemplateName]
  );
  // Research setup is now inline in chat messages (no modal)
  const [researchBreadth, setResearchBreadth] = useState(4);
  const [researchDepth, setResearchDepth] = useState(2);
  const [similarity, setSimilarity] = useState(0.5);
  const [numChunks, setNumChunks] = useState(15);
  // 7.8 v1 — AI Tutor Mode toggle. Persisted per session in
  // localStorage; flipping it back off restores normal RAG chat.
  const [tutorModeEnabled, setTutorModeEnabled] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    return window.localStorage.getItem('scrapalot_chat_tutor_mode') === 'true';
  });
  useEffect(() => {
    try {
      window.localStorage.setItem('scrapalot_chat_tutor_mode', String(tutorModeEnabled));
    } catch {
      /* noop */
    }
  }, [tutorModeEnabled]);
  // Annotation color filter — hex codes selected in the toolbar popover.
  // Empty = no filter. Persisted in localStorage to survive reloads.
  const [toolsExpanded, setToolsExpanded] = useState(false);
  const [annotationColorFilter, setAnnotationColorFilter] = useState<string[]>(() => {
    if (typeof window === 'undefined') return [];
    try {
      const raw = window.localStorage.getItem('scrapalot_chat_annotation_color_filter');
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.filter((c): c is string => typeof c === 'string') : [];
    } catch { return []; }
  });
  useEffect(() => {
    try {
      window.localStorage.setItem(
        'scrapalot_chat_annotation_color_filter',
        JSON.stringify(annotationColorFilter)
      );
    } catch {
      /* noop */
    }
  }, [annotationColorFilter]);
  // 7.7 — Thought Partner toggle. Persisted same way as tutor; the
  // two are mutually exclusive (each toggle clears the other in
  // actions.tsx).
  const [thoughtPartnerEnabled, setThoughtPartnerEnabled] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    return window.localStorage.getItem('scrapalot_chat_thought_partner') === 'true';
  });
  useEffect(() => {
    try {
      window.localStorage.setItem('scrapalot_chat_thought_partner', String(thoughtPartnerEnabled));
    } catch {
      /* noop */
    }
  }, [thoughtPartnerEnabled]);
  const [agenticRagEnabled, setAgenticRagEnabled] = useState(() => {
    // Sync init from localStorage cache to avoid flash of false→true on remount
    try {
      const cached = localStorage.getItem('scrapalot_cache_data');
      if (cached) {
        const parsed = JSON.parse(cached);
        const entry = parsed?.['general-settings'];
        // Cache entry has { data: {...}, expiry: number }
        const gs = entry?.data ?? entry;
        if (gs) return Boolean(gs.use_agentic_routing ?? gs.agentic_rag_enabled);
      }
    } catch { /* ignore */ }
    return false;
  });
  const [ragTracingEnabled, setRagTracingEnabled] = useState(false);
  // Mirror the composer focus so the entire toolbar chrome (wrapper + inner
  // card) fades with the textarea when the user isn't composing.
  const [isComposerFocused, setIsComposerFocused] = useState(false);
  useEffect(() => {
    const onFocusChange = (e: Event) => {
      const detail = (e as CustomEvent<{ focused: boolean }>).detail;
      setIsComposerFocused(!!detail?.focused);
    };
    window.addEventListener('chat-input-focus-change', onFocusChange);
    return () => window.removeEventListener('chat-input-focus-change', onFocusChange);
  }, []);
  const [showReasoningIndicators, setShowReasoningIndicators] = useState(true);
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  // Documents persisted to the session server-side — sticky across messages,
  // survive reload, removable. Distinct from `attachments` (freshly added this
  // turn, full content, sent inline). Chip bar renders both.
  const [persistedAttachments, setPersistedAttachments] = useState<SessionAttachmentMeta[]>([]);
  // Tracks the currently-active session so async fetches that resolve late can
  // be discarded if the user has since switched chats (prevents one chat's
  // attachments bleeding into another).
  const sessionIdRef = useRef(initialSessionId);
  sessionIdRef.current = initialSessionId;
  const refreshPersistedAttachments = useCallback(async () => {
    // No id yet (e.g. a brand-new session mid-creation) → leave current chips
    // (incl. optimistic ones) untouched; the session-switch effect clears them.
    if (!initialSessionId) return;
    const forSession = initialSessionId;
    const list = await getSessionAttachments(forSession);
    // Late-resolve guard: drop the result if the user has left this session.
    if (sessionIdRef.current !== forSession) return;
    setPersistedAttachments(list);
  }, [initialSessionId]);
  // Load the session's sticky attachments on mount / session switch.
  useEffect(() => {
    let cancelled = false;
    // Clear synchronously on any session change so neither the previous
    // session's persisted chips (incl. optimistic temp- ones with no server
    // row) NOR locally-composed but unsent attachments bleed into the new chat.
    setPersistedAttachments([]);
    setAttachments([]);
    if (!initialSessionId) {
      return;
    }
    getSessionAttachments(initialSessionId).then((list) => {
      if (!cancelled) setPersistedAttachments(list);
    });
    return () => { cancelled = true; };
  }, [initialSessionId]);
  const isMobileOrTabletPortrait = useIsMobileOrTabletPortrait();
  const isNarrowScreen = useIsNarrowScreen();
  const [isDialogOpen, setIsDialogOpen] = useState(false);

  // Initialize agentic RAG setting from user preferences on mount
  useEffect(() => {
    getGeneralSettings()
      .then((settings) => {
        if (settings) {
          const enabled = settings.use_agentic_routing ?? settings.agentic_rag_enabled ?? false;
          setAgenticRagEnabled(enabled);
          setRagTracingEnabled(Boolean(settings.rag_tracing_enabled));
          if (settings.show_reasoning_indicators !== undefined) {
            const reasoningOn = Boolean(settings.show_reasoning_indicators);
            setShowReasoningIndicators(reasoningOn);
            import('@/lib/storage-utils').then(({ userPrefs }) => userPrefs.set({ showReasoningIndicators: reasoningOn }));
          }
        }
      })
      .catch(() => { /* settings unavailable, keep default */ });
  }, []);

  // Report options changes to parent for repeat functionality
  useEffect(() => {
    onOptionsChange?.({
      web_search_enabled: webSearchEnabled,
      deep_research_enabled: deepResearchEnabled,
      research_breadth: researchBreadth,
      research_depth: researchDepth,
    });
  }, [webSearchEnabled, deepResearchEnabled, researchBreadth, researchDepth, onOptionsChange]);

  // Sync local state with global selected model
  useEffect(() => {
    if (globalSelectedModel?.id) {
      setLocalSelectedModel(globalSelectedModel.id);
    }
  }, [globalSelectedModel]);

  // Session ID should be managed by parent components, not generated here
  // Removed automatic session ID generation to prevent session ID mismatches

  // Mirror the parent's selection prop into local state only (never the store — the
  // store→local and session-restore effects own the store, and writing it here on a
  // transient empty prop would wipe a pinned scope unrecoverably). Two guards:
  //  1. Content guard (sorted-id key, functional update) so a same-content prop with
  //     a fresh array reference does not re-render.
  //  2. An empty prop must NOT clear the scope owned by the session's pinned
  //     `collection_id` — the parent restores that scope upstream, but until it does
  //     the empty prop is stale. Explicit user clears go through
  //     handleSelectCollections (sets local state directly), so dropping it is safe.
  // The store-retained value lets the store→local effect recover if a transient
  // empty prop ever does slip through, so the badge never gets stuck cleared.
  useEffect(() => {
    const propKey = selectedCollections.map((c) => c.id).slice().sort().join(',');
    if (propKey === '' && session?.collection_id) return;
    setCollections((prev) =>
      prev.map((c) => c.id).slice().sort().join(',') === propKey ? prev : selectedCollections
    );
  }, [selectedCollections, session?.collection_id]);

  // Restore the OPENED session's pinned collection scope so the collection badge
  // reflects which collection the session uses (sessions.collection_id, carried
  // on the full session object passed by chat-messages). Keyed on session id ONLY
  // and only acts when a definite collection_id is present — it restores once per
  // session, re-runs on session switch, and NEVER clears on a transient missing
  // collection_id (a merged/streaming session object can briefly lack it). Safe
  // now that the store→local effect above guards against the unresolved-id loop.
  const restoredScopeSessionRef = useRef<string | null>(null);
  useEffect(() => {
    const sid = session?.id ?? null;
    const cid = session?.collection_id ?? null;
    if (!sid || !cid) return;
    if (restoredScopeSessionRef.current === sid) return;
    const match = availableCollections.filter((c) => c.id === cid);
    if (match.length === 0) return; // collections not loaded yet — re-runs when they arrive
    restoredScopeSessionRef.current = sid;
    // Set BOTH local collections AND the scope store to the same value in one
    // effect so the bidirectional sync (190 reads the store fresh via getState,
    // 211 reads a subscribed snapshot) sees them agree and never oscillates.
    // Setting only one side leaves a transient mismatch that ping-pongs at 40 Hz.
    setCollections(match);
    setStoreSelectedCollectionIds(match.map((c) => c.id));
  }, [session, availableCollections, setStoreSelectedCollectionIds]);

  // Set default model when models are loaded from unified context
  useEffect(() => {
    const setDefaultModel = async () => {
      if (modelsLoaded && availableModels && availableModels.length > 0) {
        // Only set default if no global model is selected and no local model is set
        if (!globalSelectedModel && !localSelectedModel) {
          // Check localStorage for user preference before defaulting to first model
          let defaultModel = null;
          try {
            const { modelSelections } = await import('@/lib/storage-utils');
            const savedActiveModel = modelSelections.getActiveModel();

            if (savedActiveModel) {
              // Find the saved model in available models
              defaultModel = availableModels.find(m => m.id === savedActiveModel);
            }
          } catch (error) {
            console.error('ChatToolbar: Error checking localStorage:', error);
          }

          // Use localStorage model if found, otherwise use first model as fallback
          const modelToUse = defaultModel || availableModels[0];
          setLocalSelectedModel(modelToUse.id);

          // Only notify parent if we're using a fallback (not localStorage preference)
          if (!defaultModel && onModelChange) {
            onModelChange(modelToUse);
          }
        }
        // Global model sync is handled by separate useEffect above, no need to duplicate here
      }
    };

    void setDefaultModel();
  // eslint-disable-next-line react-hooks/exhaustive-deps -- deps are intentionally limited
  }, [modelsLoaded, availableModels, globalSelectedModel]); // Removed onModelChange to prevent re-render loop

  // Sync local model with global selected model (duplicate cleanup)
  // This useEffect is duplicate of the one above, removing it

  // Add event listener to focus textarea when "/" is pressed
  useEffect(() => {
    const handleSlashKey = (e: KeyboardEvent) => {
      // Check if the event occurred outside of an input, textarea, or contenteditable element
      const target = e.target as HTMLElement;
      const isEditableElement =
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target.isContentEditable ||
        target.closest('[contenteditable="true"]');

      if (
        !isLoading &&
        e.key === '/' &&
        !isEditableElement
      ) {
        e.preventDefault();
        if (textareaRef.current) {
          textareaRef.current.focus();
        }
      }
    };

    document.addEventListener('keydown', handleSlashKey);
    return () => {
      document.removeEventListener('keydown', handleSlashKey);
    };
  }, [isLoading]);

  // Listen for "ask-scrapalot" events from Notes editor (Ask Scrapalot button)
  useEffect(() => {
    const handler = (e: Event) => {
      const text = (e as CustomEvent).detail?.text;
      if (text) {
        setMessage(text);
        textareaRef.current?.focus();
      }
    };
    window.addEventListener('ask-scrapalot', handler);
    return () => window.removeEventListener('ask-scrapalot', handler);
  }, []);

  // Mobile back button support for dialog
  useEffect(() => {
    if (!isNarrowScreen || !isDialogOpen) return;

    const handlePopState = () => {
      setIsDialogOpen(false);
    };

    // Push history state when dialog opens
    window.history.pushState({ modalOpen: true }, '');
    window.addEventListener('popstate', handlePopState);

    return () => {
      window.removeEventListener('popstate', handlePopState);
    };
  }, [isNarrowScreen, isDialogOpen]);

  // Build send options from current toolbar state
  const buildSendOptions = useCallback((templateOverride?: string): { promptText: string; options: SendMessageOptions } => {
    const selectedModel = availableModels.find(
      m =>
        m.id === localSelectedModel ||
        m.model_name === localSelectedModel
    );

    const modelName =
      selectedModel?.model_name ||
      globalSelectedModel?.model_name ||
      localSelectedModel;
    const providerType =
      selectedModel?.provider_type || globalSelectedModel?.provider_type;

    const promptText = mentions.length > 0 ? cleanPrompt(message) : message;
    const effectiveTemplate = templateOverride ?? researchTemplateType;

    const options: SendMessageOptions = {
      model_name: modelName,
      provider_type: providerType,
      session_id: initialSessionId,
      web_search_enabled: webSearchEnabled,
      deep_research_enabled: deepResearchEnabled,
      template_type: deepResearchEnabled && effectiveTemplate ? effectiveTemplate : undefined,
      research_breadth: researchBreadth,
      research_depth: researchDepth,
      similarity_threshold: similarity,
      top_k: numChunks,
      agentic_rag_enabled: agenticRagEnabled,
      tutor_mode: tutorModeEnabled,
      thought_partner_mode: thoughtPartnerEnabled,
      annotation_color_filter: annotationColorFilter.length > 0 ? [...annotationColorFilter] : undefined,
      attachments: attachments.length > 0 ? [...attachments] : undefined,
      mention_collection_ids: mentionedCollectionIds.length > 0 ? [...mentionedCollectionIds] : undefined,
      mention_document_ids: mentionedDocumentIds.length > 0 ? [...mentionedDocumentIds] : undefined,
      mentions: mentions.length > 0 ? mentions.map(m => ({ type: m.type, id: m.id, name: m.name, collectionName: m.collectionName })) : undefined,
      prompt_template_name: activePromptTemplateName || undefined,
    };

    return { promptText, options };
  }, [
    availableModels,
    localSelectedModel,
    globalSelectedModel,
    mentions,
    cleanPrompt,
    message,
    researchTemplateType,
    initialSessionId,
    webSearchEnabled,
    deepResearchEnabled,
    researchBreadth,
    researchDepth,
    similarity,
    numChunks,
    agenticRagEnabled,
    attachments,
    mentionedCollectionIds,
    mentionedDocumentIds,
    tutorModeEnabled,
    thoughtPartnerEnabled,
    annotationColorFilter,
    activePromptTemplateName,
  ]);

  // Actually dispatch the message and clear the input
  const dispatchMessage = useCallback(async (promptText: string, options: SendMessageOptions) => {
    const sentAttachments = options.attachments ?? [];
    setMessage('');
    setAttachments([]);
    clearMentions();

    // Optimistically show the just-sent documents as sticky chips so they don't
    // visibly vanish while the response streams. A `temp-` id marks them as
    // not-yet-persisted; the post-send refresh replaces them with server truth.
    if (sentAttachments.length > 0) {
      setPersistedAttachments(prev => {
        const known = new Set(prev.map(a => a.filename));
        const optimistic: SessionAttachmentMeta[] = sentAttachments
          .filter(a => !known.has(a.filename))
          .map(a => ({
            id: `temp-${a.filename}`,
            type: a.type,
            filename: a.filename,
            mime_type: a.mimeType,
            char_count: a.content.length,
            created_at: '',
          }));
        return [...prev, ...optimistic];
      });
    }

    await onSendMessage(promptText, options);

    // The backend persists newly-attached documents on send — refresh the
    // sticky set so the chips reflect the real server-side state (and ids).
    if (sentAttachments.length > 0) {
      void refreshPersistedAttachments();
    }

    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }
  }, [onSendMessage, clearMentions, refreshPersistedAttachments]);

  const handleSendMessage = useCallback(async () => {
    if (message.trim() && !isLoading) {
      const { promptText, options } = buildSendOptions();

      // Show inline research setup in chat when deep research is active and no template pre-selected.
      if (deepResearchEnabled && !researchTemplateType) {
        window.dispatchEvent(new CustomEvent('research-setup-inline', {
          detail: { query: promptText, options },
        }));
        // Clear input immediately so user sees their message was accepted
        setMessage('');
        if (textareaRef.current) {
          textareaRef.current.style.height = 'auto';
        }
        return;
      }

      await dispatchMessage(promptText, options);
    }
  }, [
    message,
    isLoading,
    buildSendOptions,
    deepResearchEnabled,
    researchTemplateType,
    dispatchMessage,
  ]);

  // Research setup callbacks removed — setup is now inline in chat messages

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // When mention popover is open, let it handle navigation keys
    if (mentionState.active && ['ArrowDown', 'ArrowUp', 'Enter', 'Tab', 'Escape'].includes(e.key)) {
      return; // Handled by ChatMentionPopover's capture listener
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void handleSendMessage();
    }
  }, [handleSendMessage, mentionState.active]);

  const handleCursorChange = useCallback((cursorPos: number) => {
    cursorPosRef.current = cursorPos;
    handleMentionInput(message, cursorPos);
  }, [message, handleMentionInput]);

  const handleMentionSelect = useCallback((item: MentionItem) => {
    const result = selectSuggestion(item, message, cursorPosRef.current);
    setMessage(result.text);
    // Restore cursor position after React renders
    requestAnimationFrame(() => {
      const textarea = textareaRef.current;
      if (textarea) {
        textarea.setSelectionRange(result.cursor, result.cursor);
        textarea.focus();
      }
    });
  }, [selectSuggestion, message]);

  const handleTextareaChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const newValue = e.target.value;
    const cursorPos = e.target.selectionStart;
    setMessage(newValue);
    cursorPosRef.current = cursorPos;
    handleMentionInput(newValue, cursorPos);

    // Auto-resize the textarea
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.style.height = `${textareaRef.current.scrollHeight}px`;
    }
  }, [handleMentionInput]);

  const handleModelSelect = useCallback(async (
    modelId: string,
    modelName?: string,
    providerType?: string
  ) => {
    // Suppress unused warnings for optional params
    void modelName;
    // Store the model ID for consistent lookup
    setLocalSelectedModel(modelId);

    // Find the full model object and notify parent
    if (onModelChange) {
      const modelObject = availableModels.find(
        m => m.id === modelId || m.model_name === modelId
      );
      if (modelObject) {
        // Update the model object with the correct provider type if provided
        if (providerType && !modelObject.provider_type) {
          modelObject.provider_type = providerType;
        }

        onModelChange(modelObject);
      }
    }
  }, [onModelChange, availableModels]);

  const handleSelectCollections = useCallback((newCollections: DocumentCollection[], newSimilarity?: number, newNumChunks?: number) => {
    setCollections(newCollections);
    if (newSimilarity !== undefined) {
      setSimilarity(newSimilarity);
    }
    if (newNumChunks !== undefined) {
      setNumChunks(newNumChunks);
    }
    if (onSelectCollections) {
      onSelectCollections(newCollections);
    }
  }, [onSelectCollections]);

  const handleWebSearchToggle = useCallback((enabled: boolean) => {
    setWebSearchEnabled(enabled);
  }, []);

  const handleDeepResearchToggle = useCallback((enabled: boolean) => {
    setDeepResearchEnabled(enabled);
  }, []);

  const handleAgenticRagToggle = useCallback((enabled: boolean) => {
    setAgenticRagEnabled(enabled);
    saveGeneralSettings({ use_agentic_routing: enabled }).catch(() => {});
  }, []);

  const handleReasoningToggle = useCallback((enabled: boolean) => {
    setShowReasoningIndicators(enabled);
    saveGeneralSettings({ showReasoningIndicators: enabled }).catch(() => {});
    // Mirror to localStorage so the chat send path reads it synchronously and
    // requests the thinking-model reflection (deep_synthesis_enabled).
    import('@/lib/storage-utils').then(({ userPrefs }) => userPrefs.set({ showReasoningIndicators: enabled }));
  }, []);

  const handleResearchConfigChange = useCallback((breadth: number, depth: number) => {
    setResearchBreadth(breadth);
    setResearchDepth(depth);
  }, []);

  // Shared attachment pill bar rendered in both desktop and mobile toolbar
  // layouts. Shows persisted session attachments (sticky, server-backed) plus
  // any freshly-added ones not yet persisted (deduped by filename).
  const persistedFilenames = useMemo(
    () => new Set(persistedAttachments.map(a => a.filename)),
    [persistedAttachments]
  );
  const newUnsavedAttachments = useMemo(
    () => attachments.filter(a => !persistedFilenames.has(a.filename)),
    [attachments, persistedFilenames]
  );
  const attachmentIcon = (type: string) => (type === 'youtube' ? '▶' : type === 'image' ? '🖼' : '📄');
  const truncateName = (name: string) => (name.length > 25 ? name.slice(0, 25) + '...' : name);
  const removePersistedAttachment = useCallback(async (att: SessionAttachmentMeta) => {
    if (!initialSessionId) return;
    setPersistedAttachments(prev => prev.filter(a => a.id !== att.id));
    // Optimistic (temp-) chips have no server row yet — nothing to delete.
    if (att.id.startsWith('temp-')) return;
    try {
      await deleteSessionAttachment(initialSessionId, att.id);
    } catch {
      // Re-fetch on failure so the UI reflects the true server state.
      void refreshPersistedAttachments();
    }
  }, [initialSessionId, refreshPersistedAttachments]);
  const attachmentsBar = (persistedAttachments.length > 0 || newUnsavedAttachments.length > 0) && (
    <div className='flex flex-wrap gap-1 px-3 pt-2 pb-1'>
      {persistedAttachments.map((att) => (
        <span key={att.id} title={att.filename} className='inline-flex items-center gap-1 px-2 py-0.5 text-xs bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 text-zinc-700 dark:text-zinc-300'>
          {attachmentIcon(att.type)} {truncateName(att.filename)}
          <button onClick={() => removePersistedAttachment(att)} className='ml-0.5 hover:text-red-500'>
            <X className='h-3 w-3' />
          </button>
        </span>
      ))}
      {newUnsavedAttachments.map((att) => {
        const realIndex = attachments.indexOf(att);
        return (
          <span key={`new-${realIndex}`} title={att.filename} className='inline-flex items-center gap-1 px-2 py-0.5 text-xs bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 text-zinc-700 dark:text-zinc-300'>
            {attachmentIcon(att.type)} {truncateName(att.filename)}
            <button onClick={() => setAttachments(prev => prev.filter((_, j) => j !== realIndex))} className='ml-0.5 hover:text-red-500'>
              <X className='h-3 w-3' />
            </button>
          </span>
        );
      })}
    </div>
  );

  return (
    <div
      data-testid="chat-toolbar"
      data-tour="chat-input"
      className={cn(
        'border-border dark:border-zinc-800 pl-2 pr-2 relative z-0 transition-colors duration-200',
        // Mobile: enhanced padding for better visibility and full width, no border top
        isMobileOrTabletPortrait ? 'pt-3 pb-7 pb-safe w-full mobile-chat-toolbar' : 'pt-2',
        // Always translucent + blur regardless of focus / message state.
        // The previous "solid on focus" branch turned the whole chat
        // chrome into an opaque slab the moment the user typed anything,
        // hiding chat-message rows as they scrolled behind the toolbar.
        // Keeping 35% bg + blur lets messages stay visible through the
        // chrome at all times.
        'bg-card/35 dark:bg-black/35 backdrop-blur-sm'
      )}
    >
      {/* 7.8 v3 — show curriculum progress when AI Tutor mode is on
          AND exactly ONE collection is selected. The badge handles
          its own loading/missing-curriculum states; we just gate the
          render on the routing precondition. */}
      {tutorModeEnabled && collections.length === 1 && (
        <div className="px-2 pb-1">
          <TutorProgressBadge collectionId={collections[0].id} />
        </div>
      )}
      <div className={cn(
        'border-border dark:border-zinc-800 flex flex-col transition-colors duration-200',
        // Mobile: no rounded corners and no side borders when fixed
        isMobileOrTabletPortrait ? 'border-t' : 'rounded-t-lg border-l border-t border-r',
        // Inner card mirrors the outer — also stays translucent always.
        // 50% alpha gives it a slightly more solid feel than the outer
        // padding band (35%) so the input area still reads as a defined
        // surface, just one that messages scroll behind.
        'bg-card/50 dark:bg-black/50 backdrop-blur-sm'
      )}>
        {!isMobileOrTabletPortrait ? (
          /* Desktop Layout */
          <div className='relative flex flex-col'>
            <div className='absolute -top-5 left-0 z-10 flex items-center pl-2 py-0.5'>
              <AppVersionBadge />
            </div>
            <div className='absolute -top-5 right-0 z-10'>
              <ChatTokenUsage ragTracingEnabled={ragTracingEnabled} />
            </div>
            {attachmentsBar}

            {mentions.length > 0 && (
              <ChatMentionChips mentions={mentions} onRemove={removeMention} />
            )}

            <div className='relative'>
              {mentionState.active && (
                <ChatMentionPopover
                  suggestions={suggestions}
                  loading={docsLoading}
                  isCollectionMode={mentionState.isCollectionMode}
                  isDrillDown={mentionState.isDrillDown}
                  drillDownCollectionName={mentionState.drillDownCollectionName}
                  onSelect={handleMentionSelect}
                  onClose={closeMentions}
                  anchorRef={textareaRef}
                />
              )}
              <ChatInputText
                ref={textareaRef}
                value={message}
                onChange={handleTextareaChange}
                onKeyDown={handleKeyDown}
                disabled={isLoading && message.trim().length > 0}
                placeholder={t('chat-toolbar.prompt-placeholder')}
                onCursorChange={handleCursorChange}
                mentions={mentions}
              />
            </div>

            <div className='flex items-center px-2 py-[8px] lg:py-2 border-t border-zinc-300 dark:border-zinc-800'>
              {!simpleMode && (
              <div className='flex items-center space-x-2 flex-shrink-0 h-8'>
                {modelsLoaded ? (
                  /* Always render ChatModelSelector — it has its own localStorage
                     fallback for when availableModels is temporarily empty (server
                     restart). Only show NoModelsDialog for truly unconfigured users. */
                  availableModels.length > 0 || localSelectedModel ? (
                    <ChatModelSelector
                      selectedModel={localSelectedModel}
                      onSelectModel={handleModelSelect}
                      openSettingsWithTab={openSettingsWithTab}
                      session={session}
                    />
                  ) : (
                    <ChatToolbarNoModelsDialog
                      isOpen={isDialogOpen}
                      onOpenChange={setIsDialogOpen}
                      openSettingsWithTab={openSettingsWithTab}
                      className='w-[240px] h-8 justify-start text-sm'
                    />
                  )
                ) : (
                  <div className='w-[240px] h-8 bg-transparent border border-zinc-300 dark:border-zinc-700 rounded text-sm flex items-center px-3'>
                    <div className='skeleton-shimmer bg-zinc-200 dark:bg-zinc-700 h-4 w-full rounded'></div>
                  </div>
                )}
              </div>
              )}

              <div className='flex items-center space-x-2 flex-shrink-0 ml-4 no-mobile-scale h-8'>
                <Actions
                  selectedCollections={collections}
                  onSelectCollections={handleSelectCollections}
                  onWebSearchToggle={handleWebSearchToggle}
                  webSearchEnabled={webSearchEnabled}
                  onDeepResearchToggle={handleDeepResearchToggle}
                  deepResearchEnabled={deepResearchEnabled}
                  onResearchConfigChange={handleResearchConfigChange}
                  researchBreadth={researchBreadth}
                  researchDepth={researchDepth}
                  similarity={similarity}
                  numChunks={numChunks}
                  preloadedModelSettings={preloadedModelSettings}
                  onAgenticRagToggle={handleAgenticRagToggle}
                  agenticRagEnabled={agenticRagEnabled}
                  onTutorModeToggle={setTutorModeEnabled}
                  tutorModeEnabled={tutorModeEnabled}
                  onThoughtPartnerToggle={setThoughtPartnerEnabled}
                  thoughtPartnerEnabled={thoughtPartnerEnabled}
                  onSelectPromptTemplate={handleSelectPromptTemplate}
                  activePromptTemplateName={activePromptTemplateName}
                  onAttachmentsChange={setAttachments}
                  attachmentCount={attachments.length}
                  showReasoningIndicators={showReasoningIndicators}
                  onReasoningToggle={handleReasoningToggle}
                />
              </div>

              <div className='flex-shrink-0 ml-auto flex items-center gap-1 h-8'>
                <AnnotationColorFilterPopover
                  selectedColors={annotationColorFilter}
                  onChange={setAnnotationColorFilter}
                  disabled={isLoading}
                />
                {onOpenVoiceMode && (
                  <Button
                    data-testid='voice-mode-trigger'
                    size='icon'
                    variant='ghost'
                    className='h-8 w-8 p-0 text-muted-foreground hover:text-primary'
                    aria-label={t('voiceMode.triggerLabel', 'Open voice mode')}
                    onClick={openVoiceMode}
                    disabled={isLoading}
                  >
                    <Headphones className='h-4 w-4' />
                  </Button>
                )}
                <Button
                  data-testid='image-generation-trigger'
                  size='icon'
                  variant='ghost'
                  className='h-8 w-8 p-0 text-muted-foreground hover:text-primary'
                  aria-label={t('imageGeneration.openComposerTooltip')}
                  title={t('imageGeneration.openComposerTooltip')}
                  onClick={() => setImageGenerationOpen(true)}
                  disabled={isLoading}
                >
                  <ImagePlus className='h-4 w-4' />
                </Button>
                <ChatMicButton
                  onTranscript={(text) => setMessage((prev) => prev ? `${prev} ${text}` : text)}
                  language={i18n.language}
                  disabled={isLoading}
                />
                <ChatInputSend
                  onSend={handleSendMessage}
                  onCancel={onCancelRequest}
                  disabled={!message.trim() || !localSelectedModel}
                  isLoading={isLoading}
                  sendText={t('chat-toolbar.send')}
                  cancelText={t('chat-toolbar.cancel')}
                />
              </div>
            </div>
          </div>
        ) : (
          /* Mobile and Tablet Portrait Layout */
          <div className='relative flex flex-col'>
            <div className='absolute -top-5 left-0 z-10 flex items-center pl-2 py-0.5'>
              <AppVersionBadge />
            </div>
            <div className='absolute -top-5 right-0 z-10'>
              <ChatTokenUsage ragTracingEnabled={ragTracingEnabled} />
            </div>
            {attachmentsBar}

            {mentions.length > 0 && (
              <ChatMentionChips mentions={mentions} onRemove={removeMention} />
            )}

            <div className='relative'>
              {mentionState.active && (
                <ChatMentionPopover
                  suggestions={suggestions}
                  loading={docsLoading}
                  isCollectionMode={mentionState.isCollectionMode}
                  isDrillDown={mentionState.isDrillDown}
                  drillDownCollectionName={mentionState.drillDownCollectionName}
                  onSelect={handleMentionSelect}
                  onClose={closeMentions}
                  anchorRef={textareaRef}
                />
              )}
              <ChatInputText
                ref={textareaRef}
                value={message}
                onChange={handleTextareaChange}
                onKeyDown={handleKeyDown}
                disabled={isLoading && message.trim().length > 0}
                placeholder={t('chat-toolbar.prompt-placeholder')}
                onCursorChange={handleCursorChange}
                mentions={mentions}
              />
              <div className='absolute right-2 bottom-2 no-mobile-scale flex items-center gap-1'>
                {isMobileOrTabletPortrait ? (
                  <>
                    <div
                      className={cn(
                        'flex items-center gap-1 overflow-hidden transition-[max-width,opacity] duration-200 ease-out',
                        toolsExpanded
                          ? 'max-w-[160px] opacity-100'
                          : 'max-w-0 opacity-0 pointer-events-none',
                      )}
                      aria-hidden={!toolsExpanded}
                    >
                      <AnnotationColorFilterPopover
                        selectedColors={annotationColorFilter}
                        onChange={setAnnotationColorFilter}
                        disabled={isLoading}
                      />
                      {onOpenVoiceMode && (
                        <Button
                          size='icon'
                          variant='ghost'
                          className='h-10 w-10 p-0 text-muted-foreground hover:text-primary'
                          aria-label={t('voiceMode.triggerLabel', 'Open voice mode')}
                          onClick={openVoiceMode}
                          disabled={isLoading}
                          tabIndex={toolsExpanded ? 0 : -1}
                        >
                          <Headphones className='h-5 w-5' />
                        </Button>
                      )}
                      <ChatMicButton
                        onTranscript={(text) => setMessage((prev) => prev ? `${prev} ${text}` : text)}
                        language={i18n.language}
                        disabled={isLoading}
                      />
                    </div>
                    <Button
                      size='icon'
                      variant='ghost'
                      className='h-10 w-10 p-0 text-muted-foreground hover:text-primary'
                      onClick={() => setToolsExpanded((v) => !v)}
                      disabled={isLoading}
                      data-testid='chat-tools-toggle'
                      aria-label={t(
                        toolsExpanded
                          ? 'chat-toolbar.collapseTools'
                          : 'chat-toolbar.expandTools',
                      )}
                      aria-expanded={toolsExpanded}
                    >
                      {toolsExpanded ? (
                        <X className='h-5 w-5' />
                      ) : (
                        <Wrench className='h-5 w-5' />
                      )}
                    </Button>
                  </>
                ) : (
                  <>
                    <AnnotationColorFilterPopover
                      selectedColors={annotationColorFilter}
                      onChange={setAnnotationColorFilter}
                      disabled={isLoading}
                    />
                    {onOpenVoiceMode && (
                      <Button
                        size='icon'
                        variant='ghost'
                        className='h-10 w-10 p-0 text-muted-foreground hover:text-primary'
                        aria-label={t('voiceMode.triggerLabel', 'Open voice mode')}
                        onClick={openVoiceMode}
                        disabled={isLoading}
                      >
                        <Headphones className='h-5 w-5' />
                      </Button>
                    )}
                    <ChatMicButton
                      onTranscript={(text) => setMessage((prev) => prev ? `${prev} ${text}` : text)}
                      language={i18n.language}
                      disabled={isLoading}
                    />
                  </>
                )}
                <div style={{ width: 44, height: 44, maxWidth: 44, maxHeight: 44 }}>
                  <ChatInputSend
                    onSend={handleSendMessage}
                    onCancel={onCancelRequest}
                    disabled={!message.trim() || !localSelectedModel}
                    isLoading={isLoading}
                    sendText={t('chat-toolbar.send')}
                    cancelText={t('chat-toolbar.cancel')}
                  />
                </div>
              </div>
            </div>

            <div className={cn(
              'flex items-center pt-2 border-t border-zinc-300 dark:border-zinc-800 w-full',
              isMobileOrTabletPortrait && 'pb-2',
            )}>
              {!simpleMode && (
              <div className='flex items-center space-x-1 flex-shrink-0 min-w-0'>
                {/* Mobile model selector */}
                {modelsLoaded ? (
                  availableModels.length > 0 || localSelectedModel ? (
                    <ChatModelSelector
                      selectedModel={localSelectedModel}
                      onSelectModel={handleModelSelect}
                      openSettingsWithTab={openSettingsWithTab}
                      session={session}
                    />
                  ) : (
                    <ChatToolbarNoModelsDialog
                      isOpen={isDialogOpen}
                      onOpenChange={setIsDialogOpen}
                      openSettingsWithTab={openSettingsWithTab}
                      className='w-full min-w-[200px] h-8 justify-start text-sm'
                    />
                  )
                ) : (
                  <div className='w-[200px] h-8 bg-transparent border border-zinc-300 dark:border-zinc-700 rounded text-sm flex items-center px-3'>
                    <div className='skeleton-shimmer bg-zinc-200 dark:bg-zinc-700 h-4 w-full rounded'></div>
                  </div>
                )}
              </div>
              )}

              <div className='flex items-center space-x-1 flex-shrink-0 ml-auto no-mobile-scale'>
                <Actions
                  selectedCollections={collections}
                  onSelectCollections={handleSelectCollections}
                  onWebSearchToggle={handleWebSearchToggle}
                  webSearchEnabled={webSearchEnabled}
                  onDeepResearchToggle={handleDeepResearchToggle}
                  deepResearchEnabled={deepResearchEnabled}
                  onResearchConfigChange={handleResearchConfigChange}
                  researchBreadth={researchBreadth}
                  researchDepth={researchDepth}
                  similarity={similarity}
                  numChunks={numChunks}
                  preloadedModelSettings={preloadedModelSettings}
                  onAgenticRagToggle={handleAgenticRagToggle}
                  agenticRagEnabled={agenticRagEnabled}
                  onTutorModeToggle={setTutorModeEnabled}
                  tutorModeEnabled={tutorModeEnabled}
                  onThoughtPartnerToggle={setThoughtPartnerEnabled}
                  thoughtPartnerEnabled={thoughtPartnerEnabled}
                  onSelectPromptTemplate={handleSelectPromptTemplate}
                  activePromptTemplateName={activePromptTemplateName}
                  onAttachmentsChange={setAttachments}
                  attachmentCount={attachments.length}
                  showReasoningIndicators={showReasoningIndicators}
                  onReasoningToggle={handleReasoningToggle}
                />
              </div>
            </div>

          </div>
        )}
      </div>

      {simpleMode && (
        <div className='flex justify-center pt-1.5'>
          <button
            type='button'
            data-testid='chat-toolbar-show-advanced'
            onClick={() => setSimpleModeEnabled(false)}
            className='text-xs text-muted-foreground hover:text-foreground transition-colors'
          >
            {t('chat.showAdvancedControls', 'Show advanced controls')}
          </button>
        </div>
      )}

      {/* Research setup is now inline in chat messages */}

      <ImageGenerationDialog
        open={imageGenerationOpen}
        onOpenChange={setImageGenerationOpen}
      />
    </div>
  );
};
