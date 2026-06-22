import React, {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useCallback,
} from 'react';
import { ChatToolbar } from '@/components/chat/toolbar/chat-toolbar.tsx';
import { useFloatingWindowManager } from '@/contexts/floating-window-context';
import { VoiceModeDialog } from '@/components/chat/voice-mode-dialog';
import {
  VOICE_WITH_DOCUMENT_EVENT,
  type VoiceWithDocumentPayload,
} from '@/lib/voice-with-document';
import { ChatMessage } from '@/components/chat/chat-message.tsx';
import { ProviderIcon } from '@/components/shared/provider-icon';
import { Settings, FileText, Book, Trash2 } from 'lucide-react';
import { useSidebar } from '@/contexts/sidebar-context.tsx';
import {
  useIsMobile,
  useIsMobileOrTabletPortrait,
} from '@/hooks/use-mobile';
import { usePdfDrawer } from '@/hooks/use-pdf-drawer';
import { useDeepResearchPanel } from '@/contexts/deep-research-context';
import { useNotesDrawer } from '@/hooks/use-notes-drawer';
import { usePDFViewer } from '@/contexts/pdf-viewer-context';
import { useEpubViewer } from '@/contexts/epub-viewer-context';
import { useDocxViewer } from '@/contexts/docx-viewer-context';
import { cn } from '@/lib/utils';
import { DeepResearchPanel } from '@/components/research/deep-research-panel';
import { PlanPreviewCard } from '@/components/research/plan-preview-card';
// InlineResearchSetup is rendered inside ChatMessage (via researchSetupData prop)
import { useMarkdownViewer } from '@/contexts/markdown-viewer-context';
import { PopoverPromptSelector } from '@/components/chat/toolbar/actions/popover-prompt-selector.tsx';
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog.tsx';
import { Button } from '@/components/ui/button.tsx';
import { useTranslation } from 'react-i18next';
import { useSearchParams, useLocation } from 'react-router-dom';
import { getIconForProvider } from '@/lib/api-llm-inference';
import { Session, Model, DocumentCollection, Message, SendMessageOptions, ModelSettings } from '@/types';
import { modelSelections } from '@/lib/storage-utils';
import { PacketParser } from '@/lib/packet-parser';
import { useStreamingChat } from '@/lib/use-streaming-chat';
import { AnimatedTitle } from '@/components/ui/animated-title';
import { HeaderJobIndicator } from './header/header-job-indicator';
import { RagTraceSheet } from '@/components/chat/rag-trace-sheet';

interface SessionViewProps {
  session: Session;
  selectedModel: Model;
  selectedCollection: DocumentCollection | null;
  streamingContent: string;
  streamEnded?: boolean;
  isLoading: boolean;
  statusMessage?: { content: string; stage?: string } | null;
  stageHistory?: Array<{ content: string; stage?: string; timestamp: number }>;
  thinkingTimeMs?: number;
  onSendMessage: (
    content: string,
    options?: SendMessageOptions
  ) => Promise<void>;
  onUpdateMessage?: (
    sessionId: string,
    messageId: string,
    content: string
  ) => void;
  onTruncateMessages?: (sessionId: string, messageIndex: number) => void;
  onRemoveMessages?: (sessionId: string, messageIds: Set<string>) => void;
  onCancelRequest?: () => void;
  onSelectModel: (model: Model) => void;
  onSelectCollection: (collection: DocumentCollection | null) => void;
  onToggleSidebar: () => void;
  isMobile: boolean;
  onLoadMoreMessages?: () => void;
  loadingMoreMessages?: boolean;
  hasMoreMessages?: boolean;
  messageStreamingInProgress?: boolean;
  openSettingsWithTab?: (tab: string) => void;
  openKnowledgeStacks?: () => void;
  codeTheme?: string;
  fontSize?: number;
  onNewSession?: () => void;
  onDeleteSession?: (sessionId: string) => void;
  preloadedModelSettings?: ModelSettings | null;
  getRagTrace?: (messageId: string) => import('@/types/rag-trace').RagTraceData | undefined;
  isAiResponding?: boolean;
  followUpSuggestions?: string[];
  suggestionDocumentId?: string;
}

// Stable, module-scope memoized wrapper for a single chat message row.
// MUST stay at module scope — defining it inside ChatMessages gives it a new
// component identity on every render, which makes React remount the entire
// message list (replaying slide-in animations and resetting per-row state) and
// looks like the whole chat "refreshing" on a single delete/edit.
const MemoizedMessageWrapper = React.memo<{
  message: Message;
  isLatest: boolean;
  modelIconSrc: string;
  isEditing: boolean;
  isThinking: boolean;
  thinkingContent: string;
  modelInsightContent: string;
  thinkingTimeMs: number;
  onEditMessage: (messageId: string, content: string) => void;
  onRepeatMessage: (messageId: string, content: string) => void;
  onDeleteMessage: (messageId: string) => void;
  onContinueGeneration: (messageId: string) => void;
  onRegenerateResponse: (messageId: string) => void;
  onSaveEdit: (messageId: string, content: string) => void;
  onCancelEdit: () => void;
  codeTheme: string;
  fontSize: number;
  messageRef?: React.RefObject<HTMLDivElement>;
  onOpenRagTrace?: (messageId: string) => void;
  hasRagTrace?: boolean;
  researchReportData?: { title: string; fullReportMarkdown?: string; qualityScore?: number; totalSources: number; wordCount: number; planId: string } | null;
  onViewFullReport?: () => void;
  clarificationData?: { questions: Array<{ id: string; question: string; hint: string; category?: string; priority?: string; answer_options?: string[] }>; requestId: string; researchContext: string } | null;
  onSubmitClarification?: (answers: Array<{ question: string; answer: string }>, requestId: string) => void;
  onSkipClarification?: () => void;
  planPreviewData?: { planId: string; title: string; objective: string; methodology: string; sections: Array<{ title: string; description: string; question_count: number; source_types: string[] }>; totalQuestions: number; estimatedSources: number; sourceTypes: string[]; estimatedDurationMinutes: number } | null;
  onApprovePlan?: (planId: string) => void;
  onRegeneratePlan?: (feedback?: string) => void;
  followUpSuggestions?: string[];
  onSuggestionClick?: (question: string) => void;
  onFeedback?: (messageId: string, feedback: number | null) => void;
}>(
  ({
    message,
    isLatest,
    modelIconSrc,
    isEditing,
    isThinking,
    thinkingContent,
    modelInsightContent,
    thinkingTimeMs,
    onEditMessage,
    onRepeatMessage,
    onDeleteMessage,
    onContinueGeneration,
    onRegenerateResponse,
    onSaveEdit,
    onCancelEdit,
    codeTheme,
    fontSize,
    messageRef,
    onOpenRagTrace,
    hasRagTrace,
    researchReportData,
    onViewFullReport,
    clarificationData,
    onSubmitClarification,
    onSkipClarification,
    planPreviewData,
    onApprovePlan,
    onRegeneratePlan,
    followUpSuggestions,
    onSuggestionClick,
    onFeedback,
  }) => {
    return (
      <div ref={messageRef} className='mb-4 last:mb-0'>
        <ChatMessage
          message={message}
          isLatest={isLatest}
          modelIconSrc={modelIconSrc}
          isEditing={isEditing}
          isThinking={isThinking}
          thinkingContent={thinkingContent}
          modelInsightContent={modelInsightContent}
          thinkingTimeMs={thinkingTimeMs}
          onEditMessage={onEditMessage}
          onRepeatMessage={onRepeatMessage}
          onDeleteMessage={onDeleteMessage}
          onContinueGeneration={onContinueGeneration}
          onRegenerateResponse={onRegenerateResponse}
          onSaveEdit={onSaveEdit}
          onCancelEdit={onCancelEdit}
          codeTheme={codeTheme}
          fontSize={fontSize}
          onOpenRagTrace={onOpenRagTrace}
          hasRagTrace={hasRagTrace}
          researchReportData={researchReportData}
          onViewFullReport={onViewFullReport}
          clarificationData={clarificationData}
          onSubmitClarification={onSubmitClarification}
          onSkipClarification={onSkipClarification}
          planPreviewData={planPreviewData}
          onApprovePlan={onApprovePlan}
          onRegeneratePlan={onRegeneratePlan}
          followUpSuggestions={followUpSuggestions}
          onSuggestionClick={onSuggestionClick}
          onFeedback={onFeedback}
        />
      </div>
    );
  },
  (prevProps, nextProps) => {
    // Return true to SKIP re-render (props are the same)
    // Return false to RE-RENDER (props changed)

    // Check if message ID or content changed
    if (prevProps.message.id !== nextProps.message.id ||
      prevProps.message.content !== nextProps.message.content) {
      return false;
    }

    // Check if message metadata changed (citations, thinking content, etc.)
    // This is critical: without this check, citations added after initial render
    // (e.g., from backend refresh) would not trigger a re-render
    if (prevProps.message.message_metadata !== nextProps.message.message_metadata) {
      return false;
    }

    // Check if editing or thinking state changed
    if (prevProps.isEditing !== nextProps.isEditing ||
      prevProps.isThinking !== nextProps.isThinking ||
      prevProps.thinkingContent !== nextProps.thinkingContent ||
      prevProps.modelInsightContent !== nextProps.modelInsightContent ||
      prevProps.hasRagTrace !== nextProps.hasRagTrace) {
      return false;
    }

    // Re-render when this row's "latest" status flips (drives the typing/status
    // indicator and latest-only behaviours in ChatMessage). Without this the
    // previous last message keeps its stale isLatest after a new one arrives.
    if (prevProps.isLatest !== nextProps.isLatest) {
      return false;
    }

    // Re-render on live appearance-setting changes. The inline definition used to
    // remount every render so these always took effect; with real memoization we
    // must compare them or font-size / code-theme changes would not reach already
    // rendered messages until their content next changed.
    if (prevProps.codeTheme !== nextProps.codeTheme ||
      prevProps.fontSize !== nextProps.fontSize ||
      prevProps.modelIconSrc !== nextProps.modelIconSrc) {
      return false;
    }

    // Check if interactive research data changed (clarification, plan preview, suggestions)
    if (prevProps.clarificationData !== nextProps.clarificationData ||
      prevProps.planPreviewData !== nextProps.planPreviewData ||
      prevProps.followUpSuggestions !== nextProps.followUpSuggestions ||
      prevProps.researchReportData !== nextProps.researchReportData) {
      return false;
    }

    // Skip re-render - props are the same
    // Callback props are stable refs, so no re-render needed for them
    return true;
  }
);

export const ChatMessages = ({
  session,
  selectedModel,
  selectedCollection,
  streamingContent,
  streamEnded = false,
  isLoading,
  statusMessage,
  stageHistory = [],
  thinkingTimeMs = 0,
  onSendMessage,
  onUpdateMessage,
  onTruncateMessages,
  onRemoveMessages,
  onCancelRequest,
  onSelectModel,
  onSelectCollection,
  onToggleSidebar: _onToggleSidebar,
  isMobile: _isMobileProp,
  onLoadMoreMessages,
  loadingMoreMessages = false,
  hasMoreMessages = false,
  messageStreamingInProgress = false,
  openSettingsWithTab,
  openKnowledgeStacks,
  codeTheme = 'github',
  fontSize = 14,
  onNewSession,
  onDeleteSession,
  preloadedModelSettings,
  getRagTrace,
  isAiResponding = false,
  followUpSuggestions = [],
  suggestionDocumentId = '',
}: SessionViewProps) => {
  const [ragTraceMessageId, setRagTraceMessageId] = useState<string | null>(null);

  // Inline research setup — replaces the modal dialog.
  // Toolbar emits an event → we send a user message (appears in chat) but skip API call →
  // then show template selector as AI "response" below it.
  const [researchSetup, setResearchSetup] = useState<{ query: string; options: SendMessageOptions } | null>(null);
  // Setup-card config (depth/breadth tier, template, council) captured at setup
  // time and re-attached on plan approval. The approval is a separate request
  // (approved_plan_id) that doesn't see the setup card, so without this the run
  // silently reverts to the default tier (e.g. Standardno instead of Brzo) and
  // drops the council. See handleResearchStart / onApprove.
  const pendingSetupRef = useRef<Partial<SendMessageOptions>>({});
  useEffect(() => {
    const handleSetupRequest = async (e: Event) => {
      const { query, options } = (e as CustomEvent).detail as { query: string; options: SendMessageOptions };
      // Reset any prior research state first. A plan preview from an earlier,
      // abandoned run is persisted in sessionStorage and restored globally
      // (not session-scoped), so without this it renders alongside the fresh
      // setup card — two "Start research" buttons at once.
      deepResearchPanel.clearResearch();
      // Send it through normal flow — adds user message to session, but research_setup_pending skips API
      await onSendMessage(query, { ...options, research_setup_pending: true } as SendMessageOptions);
      // Now show the template selector as AI response
      setResearchSetup({ query, options });
    };
    window.addEventListener('research-setup-inline', handleSetupRequest);
    return () => window.removeEventListener('research-setup-inline', handleSetupRequest);
    // `deepResearchPanel` is declared below this effect; referencing it in the
    // deps array would evaluate it in its temporal dead zone (crash). The
    // handler only calls clearResearch() at event time, when it's initialized.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onSendMessage]);

  const handleResearchStart = useCallback(async (text: string, options: SendMessageOptions) => {
    setResearchSetup(null);
    // Remember the setup-card config so plan approval (a separate request that
    // can't see the card) keeps the chosen tier, template and council instead of
    // silently falling back to defaults.
    pendingSetupRef.current = {
      research_depth: options.research_depth,
      research_breadth: options.research_breadth,
      template_type: options.template_type,
      council_enabled: options.council_enabled,
      council_members: options.council_members,
    };
    await onSendMessage(text, { ...options, hide_user_message: true });
  }, [onSendMessage]);

  const handleResearchSkip = useCallback(async (text: string, options: SendMessageOptions) => {
    setResearchSetup(null);
    await onSendMessage(text, { ...options, deep_research_enabled: true, hide_user_message: true });
  }, [onSendMessage]);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const lastMessageRef = useRef<HTMLDivElement>(null);
  const streamingMessageRef = useRef<HTMLDivElement>(null);
  const hasScrolledToStreamRef = useRef(false);
  // Infinite-scroll-up bookkeeping. When older history is prepended, we must
  // keep the viewport anchored (no jump). prependAnchorRef holds scrollHeight
  // captured the moment a load-more fires; the layout effect below adds back the
  // height that appeared above the old top message. The id/length refs detect a
  // prepend (grew at the FRONT, same tail). The scroll-to-bottom effect is kept
  // off prepends by gating on the last-message id, not by a per-render flag.
  const prependAnchorRef = useRef<number | null>(null);
  // Last observed scrollTop, to tell an intentional upward scroll from the
  // initial programmatic scroll-to-bottom (which moves DOWN). Without this the
  // open-scroll briefly sits at the top and spuriously fires load-more.
  const lastScrollTopRef = useRef(0);
  const prevFirstMsgIdRef = useRef<string | undefined>(undefined);
  const prevLastMsgIdRef = useRef<string | undefined>(undefined);
  const prevMsgLenRef = useRef(0);
  // Separate bookkeeping for the scroll-to-bottom effect (the layout effect
  // above mutates prevLastMsgIdRef, so the passive effect can't reuse it). We
  // only pin to the bottom when the LAST message id changes (a new message
  // committed at the tail) or the session itself changes (first open) — never
  // when older history is prepended or a dedup-only merge replaces the array.
  const prevScrollLastIdRef = useRef<string | undefined>(undefined);
  const prevScrollSessionIdRef = useRef<string | undefined>(undefined);
  // Toolbar wrapper ref + measured height. Drives the messages container's
  // bottom padding so the last message clears the absolutely-positioned
  // toolbar on desktop. Mobile keeps its own fixed-bottom positioning and
  // hardcoded pb-32, so this only matters for the desktop overlay path.
  // The ResizeObserver wiring is below — placed after isMobileOrTabletPortrait
  // is declared, otherwise referencing it in the dep array tripped TDZ.
  const toolbarWrapperRef = useRef<HTMLDivElement>(null);
  const [toolbarHeight, setToolbarHeight] = useState(0);
  const { isSidebarOpen, closeSidebar } = useSidebar();
  const isMobile = useIsMobile();
  const isMobileOrTabletPortrait = useIsMobileOrTabletPortrait();

  useEffect(() => {
    if (isMobileOrTabletPortrait) return;
    const node = toolbarWrapperRef.current;
    if (!node) return;
    const ro = new ResizeObserver(entries => {
      for (const entry of entries) {
        const h = entry.contentRect.height;
        setToolbarHeight(prev => (Math.abs(prev - h) > 1 ? h : prev));
      }
    });
    ro.observe(node);
    setToolbarHeight(node.getBoundingClientRect().height);
    return () => ro.disconnect();
  }, [isMobileOrTabletPortrait]);
  const pdfDrawer = usePdfDrawer();
  const notesDrawer = useNotesDrawer();
  const deepResearchPanel = useDeepResearchPanel();
  const markdownViewer = useMarkdownViewer();

  // Ref to store current toolbar options for use in repeat functionality
  const toolbarOptionsRef = useRef<{
    web_search_enabled?: boolean;
    deep_research_enabled?: boolean;
    research_breadth?: number;
    research_depth?: number;
  }>({});

  // Track screen width for responsive drawer calculations
  const [screenWidth, setScreenWidth] = useState(window.innerWidth);
  useEffect(() => {
    const handleResize = () => setScreenWidth(window.innerWidth);
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  // Follow the composer focus state so the chat header fades in sync with
  // the input. Event is dispatched from ChatInputText on focus/blur.
  const [chatInputFocused, setChatInputFocused] = useState(false);
  useEffect(() => {
    const onFocusChange = (e: Event) => {
      const detail = (e as CustomEvent<{ focused: boolean }>).detail;
      setChatInputFocused(!!detail?.focused);
    };
    window.addEventListener('chat-input-focus-change', onFocusChange);
    return () => window.removeEventListener('chat-input-focus-change', onFocusChange);
  }, []);

  const { state: pdfState } = usePDFViewer();
  const { state: epubState } = useEpubViewer();
  const { state: docxState } = useDocxViewer();
  const floatingMgr = useFloatingWindowManager();
  // Treat a viewer as "occupying side space" only when it's open AND not in floating mode.
  // A floating viewer is positioned freely and must not compress the chat area.
  const isNotesOpen = notesDrawer.isOpen && (floatingMgr.modes['notes-drawer'] === undefined || floatingMgr.modes['notes-drawer'] !== 'floating');
  const isNotesOnLeft = notesDrawer.isOnLeft;
  const isPdfOpen = pdfDrawer && floatingMgr.modes['pdf-viewer'] !== 'floating';
  const isPdfOnLeft = pdfState.isOnLeft; // Read actual PDF position from context
  const isEpubOpen = epubState.isOpen && floatingMgr.modes['epub-viewer'] !== 'floating';
  const isEpubOnLeft = epubState.isOnLeft; // Read actual EPUB position from context
  const isDocxOpen = docxState.isOpen && floatingMgr.modes['docx-viewer'] !== 'floating';
  const isDocxOnLeft = docxState.isOnLeft; // Read actual DOCX position from context
  const isMarkdownOpen = markdownViewer.state.isOpen && floatingMgr.modes['markdown-viewer'] !== 'floating';
  const isMarkdownOnLeft = markdownViewer.state.isOnLeft;

  // Auto-open markdown viewer when deep research completes
  const prevResearchCompleteRef = useRef(false);
  useEffect(() => {
    if (deepResearchPanel.researchComplete && !prevResearchCompleteRef.current && deepResearchPanel.researchReport) {
      markdownViewer.dispatch({
        type: 'OPEN_MARKDOWN_VIEWER',
        payload: {
          content: deepResearchPanel.researchReport.fullReportMarkdown,
          title: deepResearchPanel.researchReport.title,
          planId: deepResearchPanel.researchReport.planId,
          qualityScore: deepResearchPanel.researchReport.qualityScore,
          totalSources: deepResearchPanel.researchReport.totalSources,
          wordCount: deepResearchPanel.researchReport.wordCount,
          discoveries: deepResearchPanel.discoveries,
        },
      });
    }
    prevResearchCompleteRef.current = deepResearchPanel.researchComplete;
  }, [deepResearchPanel.researchComplete, deepResearchPanel.researchReport, deepResearchPanel.discoveries, markdownViewer]);

  const [selectedCollections, setSelectedCollections] = useState<
    DocumentCollection[]
  >(selectedCollection ? [selectedCollection] : []);
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const [isRepeating, setIsRepeating] = useState(false);
  // When continuing from a message that has later messages, hold its id until the user
  // confirms overwriting the history that follows it.
  const [continueConfirmId, setContinueConfirmId] = useState<string | null>(null);
  const [scrolledToTop, setScrolledToTop] = useState(false);
  // Voice mode dialog visibility — rendered at this level so it can watch
  // streamEnded + pull the latest assistant text from `session.messages`.
  const [voiceModeOpen, setVoiceModeOpen] = useState(false);
  // Snapshot of @-mentioned books at the moment the user opened voice
  // mode. The chat toolbar owns the mention state internally; it hands
  // it to us via the onOpenVoiceMode callback so the VoiceModeDialog
  // can render thumbnails + scope the backend grep tools.
  const [voiceModeDocs, setVoiceModeDocs] = useState<Array<{ id: string; title: string }>>([]);

  // Viewer → voice mode handoff. PDF / EPUB / DOCX toolbars dispatch
  // `scrapalot:voice-with-document` with {documentId, documentName}; we
  // open the dialog scoped to that single book. Decoupled via window
  // event (sibling of `scrapalot:chat-with-document`).
  useEffect(() => {
    const handler = (event: Event) => {
      const e = event as CustomEvent<VoiceWithDocumentPayload>;
      const detail = e.detail;
      if (!detail?.documentId || !detail?.documentName) return;
      setVoiceModeDocs([{ id: detail.documentId, title: detail.documentName }]);
      setVoiceModeOpen(true);
    };
    window.addEventListener(VOICE_WITH_DOCUMENT_EVENT, handler);
    return () => window.removeEventListener(VOICE_WITH_DOCUMENT_EVENT, handler);
  }, []);
  const [messagesExceedScreenHeight, setMessagesExceedScreenHeight] =
    useState(false);
  const { t } = useTranslation();
  const lastProcessedLength = useRef(0);
  // Initialize streaming packet processor
  const streamingPackets = useStreamingChat({
    onComplete: (_content, _citations) => {
      // Stream completed - content is already in state
    },
    onError: (error) => {
      console.error('Streaming error:', error);
    }
  }); // Empty deps - set up once on mount

  // Update selectedCollections when the selectedCollection changes
  useEffect(() => {
    if (selectedCollection) {
      setSelectedCollections([selectedCollection]);
    } else {
      setSelectedCollections([]);
    }
  }, [selectedCollection]);

  // Process streaming content with new packet system (streamingPackets for inline rendering)
  // Note: deep research panel packets are processed directly in use-conversations.tsx
  useEffect(() => {
    if (streamingContent) {
      // Reset on new stream start (when we have new content after being empty)
      if (lastProcessedLength.current === 0 && streamingContent.length > 0) {
        streamingPackets.reset();
      }

      // Only process new content since last update
      const newContent = streamingContent.slice(lastProcessedLength.current);
      if (newContent) {
        const lines = newContent.split('\n').filter(line => line.trim());
        lines.forEach(line => {
          try {
            const packet = PacketParser.parseLine(line);
            if (packet) {
              streamingPackets.processPacket(packet);
            }
          } catch {
            // Invalid packet, ignore
          }
        });
      }

      lastProcessedLength.current = streamingContent.length;
    } else if (streamEnded && streamingContent === '') {
      // Only reset when stream has ended AND content is cleared (ready for next message)
      lastProcessedLength.current = 0;
      hasScrolledToStreamRef.current = false;
    }

    // Reset research state when stream ends (completion or cancellation)
    if (streamEnded && deepResearchPanel.isResearching) {
      deepResearchPanel.setIsResearching(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- deps are intentionally limited
  }, [streamingContent, streamEnded]);  // streamingPackets and deepResearchPanel are stable, don't include in deps

  // Reset streaming state when session changes to prevent stale content flash
  const prevSessionIdRef = useRef<string | undefined>(session?.id);
  useEffect(() => {
    if (session?.id !== prevSessionIdRef.current) {
      prevSessionIdRef.current = session?.id;
      streamingPackets.reset();
      lastProcessedLength.current = 0;
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- deps are intentionally limited
  }, [session?.id]);

  // Auto-collapse sidebar when deep research panel, EPUB viewer, or DOCX viewer opens (not on mobile)
  useEffect(() => {
    if ((deepResearchPanel.isOpen || isEpubOpen || isDocxOpen || isMarkdownOpen) && !isMobileOrTabletPortrait && isSidebarOpen) {
      closeSidebar();
    }
  }, [deepResearchPanel.isOpen, isEpubOpen, isDocxOpen, isMarkdownOpen, isMobileOrTabletPortrait, isSidebarOpen, closeSidebar]);

  // Pin the scroll container to its ABSOLUTE bottom. Long histories finish
  // rendering heavy content (highlighted code, KaTeX, images, tables) AFTER the
  // first paint, which grows scrollHeight; a single smooth scrollIntoView is
  // computed against the OLD height and lands short of the real bottom — the
  // "scrolls near the end but not all the way" symptom. Jump straight to
  // scrollHeight on the container itself (more reliable than scrollIntoView for
  // reaching the true bottom). Callers re-pin across a few frames so late
  // layout growth doesn't leave the view stranded.
  const scrollToBottom = (smooth = false) => {
    const container = messagesContainerRef.current;
    if (container) {
      container.scrollTo({ top: container.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
    } else {
      messagesEndRef.current?.scrollIntoView({ behavior: smooth ? 'smooth' : 'auto', block: 'end' });
    }
  };

  // Scroll so the streaming message top aligns with the top of the scroll container
  const scrollToStreamStart = useCallback(() => {
    if (streamingMessageRef.current && messagesContainerRef.current) {
      const container = messagesContainerRef.current;
      const streamEl = streamingMessageRef.current;
      // Calculate offset of streaming message relative to scroll container
      const streamTop = streamEl.offsetTop - container.offsetTop;
      container.scrollTo({ top: streamTop, behavior: 'smooth' });
    }
  }, []);

  // Detect an older-history prepend and keep the viewport anchored. Runs as a
  // layout effect (synchronously, before paint AND before the scroll-to-bottom
  // effect below) so there's no visible jump: we add back exactly the height
  // that appeared above the previous top message.
  useLayoutEffect(() => {
    const msgs = session.messages || [];
    const firstId = msgs[0]?.id;
    const lastId = msgs[msgs.length - 1]?.id;
    const grew = msgs.length > prevMsgLenRef.current;
    const prepended =
      grew &&
      !!prevFirstMsgIdRef.current &&
      firstId !== prevFirstMsgIdRef.current &&
      lastId === prevLastMsgIdRef.current;

    if (prepended) {
      const container = messagesContainerRef.current;
      if (container && prependAnchorRef.current != null) {
        const delta = container.scrollHeight - prependAnchorRef.current;
        if (delta > 0) container.scrollTop = container.scrollTop + delta;
      }
    }

    prevFirstMsgIdRef.current = firstId;
    prevLastMsgIdRef.current = lastId;
    prevMsgLenRef.current = msgs.length;
    prependAnchorRef.current = null;
  // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the messages array identity
  }, [session.messages || []]);

  // Scroll to bottom when new messages are added (non-streaming), or scroll to stream start
  useEffect(() => {
    if (messageStreamingInProgress) return;

    if (streamingContent) {
      // During streaming: scroll to the start of the AI message once
      if (!hasScrolledToStreamRef.current) {
        hasScrolledToStreamRef.current = true;
        // Small delay to ensure the streaming message div is rendered
        requestAnimationFrame(() => {
          scrollToStreamStart();
        });
      }
      return;
    }

    // Non-streaming. Only pin to the bottom when something actually changed at
    // the BOTTOM of the list: a new message committed (last id changed) or the
    // first load of this session. Older history prepended during an upward
    // scroll, in-place edits, and dedup-only merges all leave the last id
    // unchanged AND replace the messages array identity — gating on the last id
    // (not array identity) is what stops the "scroll up into history → snaps
    // back to bottom" bug without a fragile per-render prepend guard.
    const msgs = session.messages || [];
    const lastId = msgs[msgs.length - 1]?.id;
    const sessionId = session?.id;
    const sessionChanged = sessionId !== prevScrollSessionIdRef.current;
    const lastIdChanged = lastId !== prevScrollLastIdRef.current;
    prevScrollSessionIdRef.current = sessionId;
    prevScrollLastIdRef.current = lastId;
    hasScrolledToStreamRef.current = false;

    if (!sessionChanged && !lastIdChanged) return;

    // smooth-scroll to the bottom, then re-pin across the next frame + a short
    // settle window. Each re-pin is also smooth — successive scrollTo({smooth})
    // calls just retarget the SAME animation to the new bottom, so as late
    // layout growth (code highlighting, KaTeX, images) increases scrollHeight
    // the smooth scroll follows it down instead of stranding the view "almost"
    // at the bottom. Keeps the smooth feel while still reaching the true end.
    scrollToBottom(true);
    const raf = requestAnimationFrame(() => scrollToBottom(true));
    const timers = [80, 250, 600].map(ms =>
      window.setTimeout(() => scrollToBottom(true), ms)
    );
    return () => {
      cancelAnimationFrame(raf);
      timers.forEach(clearTimeout);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps -- deps are intentionally limited
  }, [session.messages || [], session?.id, streamingContent, messageStreamingInProgress]);

  // Check if messages exceed screen height
  useEffect(() => {
    const checkMessagesHeight = () => {
      if (messagesContainerRef.current) {
        const containerHeight = messagesContainerRef.current.scrollHeight;
        const viewportHeight = messagesContainerRef.current.clientHeight;

        // If the content height is greater than the viewport height, messages exceed one screen
        setMessagesExceedScreenHeight(containerHeight > viewportHeight);
      }
    };

    // Check when messages change or on window resize
    checkMessagesHeight();

    // Add a resize listener to recheck when window size changes
    window.addEventListener('resize', checkMessagesHeight);
    return () => {
      window.removeEventListener('resize', checkMessagesHeight);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps -- deps are intentionally limited
  }, [session.messages || []]);

  // Clear isRepeating flag when streaming actually starts or when messages change
  useEffect(() => {
    if (isRepeating) {
      // Clear if streaming has started
      if (streamingContent || isLoading || messageStreamingInProgress) {
        setIsRepeating(false);
      }
      // Also clear if the message count changed (new message sent or received)
      // This prevents isRepeating from getting stuck and hiding messages incorrectly
    }
  }, [isRepeating, streamingContent, isLoading, messageStreamingInProgress]);

  // Clear isRepeating when session messages change (prevents stuck state)
  useEffect(() => {
    if (isRepeating && session?.messages) {
      setIsRepeating(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- deps are intentionally limited
  }, [session?.messages?.length]);

  // Handle scroll events to detect when user scrolls to top
  const handleScroll = useCallback(() => {
    if (!messagesContainerRef.current || !onLoadMoreMessages) return;

    const { scrollTop } = messagesContainerRef.current;
    // Only an upward scroll loads older history. The initial scroll-to-bottom
    // animates DOWN through scrollTop≈0, which must NOT trigger a load (that was
    // the regression where opening a paginated session stuck at the first
    // message instead of reaching the bottom).
    const movingUp = scrollTop < lastScrollTopRef.current;
    lastScrollTopRef.current = scrollTop;

    // If scrolled near the top WHILE moving up, and we have more messages to load
    if (
      scrollTop < 100 &&
      movingUp &&
      hasMoreMessages &&
      !loadingMoreMessages &&
      !scrolledToTop
    ) {
      setScrolledToTop(true);
      // Capture height BEFORE older messages prepend so the layout effect can
      // restore the exact scroll offset and keep the viewport from jumping.
      prependAnchorRef.current = messagesContainerRef.current?.scrollHeight ?? null;
      onLoadMoreMessages();
    } else if (scrollTop > 150) {
      setScrolledToTop(false);
    }
  }, [hasMoreMessages, loadingMoreMessages, onLoadMoreMessages, scrolledToTop]);

  // Add scroll event listener
  useEffect(() => {
    const container = messagesContainerRef.current;
    if (container) {
      container.addEventListener('scroll', handleScroll);
      return () => {
        container.removeEventListener('scroll', handleScroll);
      };
    }
  }, [handleScroll]);

  // Scroll to stream start when streaming begins (triggered by status message before content)
  useEffect(() => {
    if (statusMessage?.content && !streamingContent && !hasScrolledToStreamRef.current) {
      // Status message arrived before stream content — scroll to bottom so user sees the status
      scrollToBottom();
    }
  }, [statusMessage?.content, streamingContent]);

  // Font-weight + color only. Left-side spacing for the GlobalSidebarToggle +
  // admin/data-inspector buttons must NOT be a margin on AnimatedTitle (its
  // `w-full` would then overflow the flex parent on the right and the visible
  // window collapses). Instead apply it as `pl-…` on the title container via
  // `getHeaderContainerPaddingClass` below.
  const getHeaderClass = () => 'font-medium dark:text-white/50';

  // Left padding for the title's flex parent. Adjusting padding here keeps
  // AnimatedTitle's effective width = parent_width - padding, so its overflow
  // detection sees the real visible area instead of overshooting it.
  const getHeaderContainerPaddingClass = () => {
    // When PDF / EPUB / notes / markdown / deep research is open, GlobalSidebarToggle is hidden.
    if (isPdfOpen || isEpubOpen || isNotesOpen || isMarkdownOpen || deepResearchPanel.isOpen) {
      return 'pl-2';
    }

    if (!isSidebarOpen) {
      // Mobile: reserve room for GlobalSidebarToggle (panel-left) + Data Inspector (Network).
      // pl-[10px] wrapper + (4 + 4 + 20 + 4)px toggle + 4px gap + (4 + 20 + 4)px admin ≈ 74px.
      if (isMobile) {
        return 'pl-[66px]';
      }
      return 'pl-8 sm:pl-12';
    }

    // Sidebar open: on mobile the toggle + admin buttons are still rendered fixed.
    if (isMobile) {
      return 'pl-[66px]';
    }
    return '';
  };

  const handleSelectCollections = (collections: DocumentCollection[]) => {
    setSelectedCollections(collections);
    if (collections.length > 0) {
      // Use the first collection as the primary one for backward compatibility
      onSelectCollection(collections[0]);
    } else {
      onSelectCollection(null);
    }
  };

  // Inside the ChatMessages component, extract thinking state from hooks
  const { isThinking, thinkingContent } = useMemo((): { isThinking: boolean; thinkingContent: string } => {
    // Only show thinking state when we're actually waiting for LLM response
    // Not when just loading session messages
    const isCurrentlyThinking: boolean = Boolean(isLoading && thinkingTimeMs > 0 && (!!streamingContent || messageStreamingInProgress === false));

    // Don't extract thinking content from streamingContent here
    // Let the ChatMessage component handle it to avoid duplication
    return {
      isThinking: isCurrentlyThinking,
      thinkingContent: '', // Always empty to avoid duplication
    };
  }, [isLoading, thinkingTimeMs, streamingContent, messageStreamingInProgress]);

  // Handle editing a message - enables inline editing mode
  const handleEditMessage = (messageId: string, _content: string) => {
    if (onUpdateMessage) {
      // Set the message ID that's being edited
      setEditingMessageId(messageId);
    }
  };

  /** Builds the mention-related options from a message's metadata. */
  const buildMentionOptions = (msg: Message) => {
    const originalMentions = (msg.message_metadata as Record<string, unknown>)?.mentions as Array<{ type: 'collection' | 'document'; id: string; name: string; collectionName?: string }> | undefined;
    if (!originalMentions || originalMentions.length === 0) return {};
    return {
      mentions: originalMentions,
      mention_document_ids: originalMentions.filter(m => m.type === 'document').map(m => m.id),
      mention_collection_ids: [...new Set(originalMentions.map(m => m.type === 'collection' ? m.id : (m as { collectionId?: string }).collectionId).filter(Boolean))] as string[],
    };
  };

  // Handle saving an edited message — updates content then resends with original @-mentions
  const handleSaveEditedMessage = (messageId: string, newContent: string) => {
    if (!session?.messages) return;
    if (onUpdateMessage) {
      onUpdateMessage(session.id, messageId, newContent);
    }
    setEditingMessageId(null);

    // Auto-resend the edited message (like repeat but with new content)
    const messageIndex = session.messages.findIndex(msg => msg.id === messageId);
    if (messageIndex === -1) return;

    setIsRepeating(true);
    if (onTruncateMessages) {
      onTruncateMessages(session.id, messageIndex);
    }

    void onSendMessage(newContent, {
      user_message_id: messageId,
      ...toolbarOptionsRef.current,
      ...buildMentionOptions(session.messages[messageIndex]),
    });
  };

  // Handle canceling message edit
  const handleCancelEdit = () => {
    setEditingMessageId(null);
  };

  // Handle repeating a message - removes this message and all later messages, then resends the same content
  // eslint-disable-next-line react-hooks/exhaustive-deps -- deps are intentionally limited
  const handleRepeatMessage = (messageId: string, content: string) => {
    if (!session?.messages) return;

    // Find the index of the message to repeat
    const messageIndex = session.messages.findIndex(msg => msg.id === messageId);
    if (messageIndex === -1) return;

    // Set repeating flag FIRST to immediately hide old assistant messages via filter
    // This prevents the old response from briefly appearing before truncation completes
    setIsRepeating(true);

    // Truncate messages from this point onwards (including this message and any responses)
    if (onTruncateMessages) {
      onTruncateMessages(session.id, messageIndex);
    }

    // Resend the same message content with the original message ID to reuse it.
    // Include current toolbar options (deep research, web search, etc.)
    // and restore @-mention metadata so document_ids are re-sent.
    void onSendMessage(content, {
      user_message_id: messageId,
      ...toolbarOptionsRef.current,
      ...buildMentionOptions(session.messages[messageIndex]),
    });

    // Don't clear isRepeating immediately - let it be cleared when streaming starts
    // The filter will hide the old message until new streaming content arrives
  };

  // Handle deleting a message and its paired response
  const handleDeleteMessage = useCallback(async (messageId: string) => {
    if (!session?.messages) return;

    // Decide what to remove BEFORE awaiting the server, so the UI still clears
    // even when the server says the row is already gone.
    const msgIndex = session.messages.findIndex(msg => msg.id === messageId);
    if (msgIndex === -1) return;
    const msg = session.messages[msgIndex];

    const idsToRemove = new Set([messageId]);
    if (msg.role === 'user' && msgIndex + 1 < session.messages.length) {
      const next = session.messages[msgIndex + 1];
      if (next.role === 'assistant') {
        idsToRemove.add(next.id);
      }
    }

    // A 404 means the message doesn't exist server-side — it was never persisted
    // (client-only streaming/error placeholder) or is already deleted. From the
    // user's POV that's success: the row must still disappear from the view.
    // Re-throw any other status so genuine failures (500, network) surface.
    const { deleteMessage } = await import('@/lib/api-messages');
    const deleteOnServer = async (id: string) => {
      try {
        await deleteMessage(id);
      } catch (err) {
        const status = (err as { response?: { status?: number } })?.response?.status;
        if (status !== 404) throw err;
      }
    };

    try {
      // Delete the primary message; tolerate 404. The paired assistant message
      // (when deleting a user turn) is best-effort and never blocks the UI update.
      await deleteOnServer(messageId);
      for (const id of idsToRemove) {
        if (id !== messageId) {
          try { await deleteOnServer(id); } catch { /* best effort */ }
        }
      }

      // Remove only the deleted messages from local state
      if (onRemoveMessages) {
        onRemoveMessages(session.id, idsToRemove);
      }
    } catch (err) {
      console.error('Failed to delete message:', err);
      const { toast } = await import('@/lib/toast-compat');
      toast({ title: t('chat.actions.deleteFailed'), variant: 'destructive' });
    }
  }, [session, onRemoveMessages, t]);

  // Branch the conversation from the given message: drop everything after it, then
  // continue generating. Assumes the caller has already handled confirmation.
  const runContinueGeneration = useCallback((messageId: string) => {
    if (!session?.messages) return;
    const messageIndex = session.messages.findIndex(msg => msg.id === messageId);
    // Truncate any messages that follow this one so the continuation branches from here.
    if (messageIndex !== -1 && messageIndex < session.messages.length - 1 && onTruncateMessages) {
      setIsRepeating(true);
      onTruncateMessages(session.id, messageIndex + 1);
    }
    void onSendMessage(t('chat.actions.continuePrompt'), {
      ...toolbarOptionsRef.current,
    });
  }, [session, onSendMessage, onTruncateMessages, t]);

  // Handle continue generation for AI messages. If later messages exist they would be
  // overwritten, so ask the user to confirm first.
  const handleContinueGeneration = useCallback((messageId: string) => {
    if (!session?.messages) return;
    const messageIndex = session.messages.findIndex(msg => msg.id === messageId);
    const hasLaterMessages = messageIndex !== -1 && messageIndex < session.messages.length - 1;
    if (hasLaterMessages) {
      setContinueConfirmId(messageId);
      return;
    }
    runContinueGeneration(messageId);
  }, [session, runContinueGeneration]);

  // Handle message feedback (thumbs up/down)
  const handleFeedback = useCallback(async (messageId: string, feedback: number | null) => {
    try {
      const { updateMessageFeedback } = await import('@/lib/api-messages');
      await updateMessageFeedback(messageId, feedback);
    } catch (err) {
      console.error('Failed to update message feedback:', err);
    }
  }, []);

  // Handle regenerate response (re-run the preceding user message)
  const handleRegenerateResponse = useCallback((aiMessageId: string) => {
    if (!session?.messages) return;
    const aiMsgIndex = session.messages.findIndex(msg => msg.id === aiMessageId);
    if (aiMsgIndex <= 0) return;

    // Find the preceding user message
    const userMsg = session.messages[aiMsgIndex - 1];
    if (userMsg?.role === 'user') {
      handleRepeatMessage(userMsg.id, userMsg.content);
    }
  }, [session, handleRepeatMessage]);

  // MemoizedMessageWrapper is defined at MODULE SCOPE (top of this file), not here.
  // Defining it inline gave it a fresh component identity on every ChatMessages
  // render, so React treated each render as a new component type and REMOUNTED the
  // entire message list — replaying each row's `animate-slide-in` and resetting
  // per-message state. That full remount is what looked like "the whole chat
  // refreshing" whenever a single message was deleted/edited. With a stable
  // module-scope identity, React.memo actually works and only the changed row
  // updates (the deleted one unmounts in place).

  // Wrapper to ensure we pass the model information correctly
  const onSendMessageWithModel = useCallback(
    async (content: string, options?: SendMessageOptions) => {
      // Use the options from toolbar first, fallback to selectedModel if needed
      // IMPORTANT: Use actual model name (string) not id (UUID) for LLM calls
      const modelName = options?.model_name || selectedModel?.model_name;
      const providerType = options?.provider_type || selectedModel?.provider_type;

      await onSendMessage(content, {
        ...options,
        model_name: modelName,
        provider_type: providerType,
      });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- deps are intentionally limited
    [onSendMessage, selectedModel?.id, selectedModel?.provider_type]
  );

  // Wrapper for EmptySession that uses the correct signature
  const onSendMessageForEmptySession = useCallback(
    (content: string, options?: SendMessageOptions) => {
      return onSendMessage(content, options);
    },
    [onSendMessage]
  );

  // True when any two viewer drawers are open simultaneously (PDF, EPUB, DOCX, Notes, Markdown)
  const isTwoDrawersOpen =
    (isPdfOpen && isNotesOpen) || (isPdfOpen && isEpubOpen) || (isPdfOpen && isDocxOpen) || (isPdfOpen && isMarkdownOpen) ||
    (isEpubOpen && isNotesOpen) || (isEpubOpen && isDocxOpen) || (isEpubOpen && isMarkdownOpen) ||
    (isDocxOpen && isNotesOpen) || (isDocxOpen && isMarkdownOpen) ||
    (isNotesOpen && isMarkdownOpen);

  // Chat header element. On desktop it's rendered INSIDE the scroll container
  // (sticky top-0 + translucent bg = messages slide UNDER the header). On
  // real mobile browsers, sticky inside flex-1 overflow-y-auto unreliably
  // disappears as soon as the messages list scrolls past one viewport
  // height — so on mobile we render this as a sibling ABOVE the scroll
  // container instead, trading the frosted-glass effect for guaranteed
  // visibility of the title and the settings/knowledge/notes affordances.
  const chatHeaderEl = (
    <div className={cn(
      'flex items-center justify-between px-2 h-14 border-b border-border dark:border-chat-sidebar-border md:mt-0 z-10 transition-colors duration-200',
      // Desktop only: sticky inside scroll container (mobile renders above scroll).
      !isMobileOrTabletPortrait && 'sticky top-0',
      chatInputFocused
        ? 'bg-card dark:bg-black'
        : 'bg-card/50 dark:bg-black/50 backdrop-blur-sm hover:bg-card dark:hover:bg-black'
    )}>
      <div className={cn('flex items-center gap-2 flex-1 min-w-0 overflow-hidden', getHeaderContainerPaddingClass())}>
        {/* `listSessions` returns the backend session verbatim, which carries
            `conversation_name` but NO `title` field — so a session opened from
            the list has `title === undefined` and the header showed nothing
            (most visible on the latest sessions, which always come from the
            list). Fall back to `conversation_name`, the canonical backend
            field, so the animated title renders for every session. */}
        {(() => {
          const headerTitle = session.title?.trim() || session.conversation_name?.trim() || '';
          return headerTitle ? (
            <AnimatedTitle
              title={headerTitle}
              className={getHeaderClass()}
              maxAnimations={Infinity}
              animationDuration={8000}
              pauseDuration={1500}
            />
          ) : null;
        })()}
      </div>
      <div className='flex items-center gap-2 flex-shrink-0'>
        {/* Live progress for a background deep-research run started from this chat. */}
        <HeaderJobIndicator />
        {isMobileOrTabletPortrait && openSettingsWithTab && (
          <button
            data-testid="chat-header-settings-button"
            onClick={() => openSettingsWithTab('general')}
            className='p-1 hover:bg-zinc-100 dark:hover:bg-zinc-800 flex-shrink-0'
            aria-label='Open settings'
          >
            <Settings className='h-5 w-5' />
          </button>
        )}
        {isMobileOrTabletPortrait && openKnowledgeStacks && (
          <button
            data-testid="chat-header-knowledge-button"
            onClick={openKnowledgeStacks}
            className='p-1 hover:bg-zinc-100 dark:hover:bg-zinc-800 flex-shrink-0'
            aria-label='Manage knowledge stacks'
          >
            <Book className='h-5 w-5' />
          </button>
        )}
        {isMobileOrTabletPortrait ? (
          <button
            data-testid="notes-toggle-button"
            onClick={() => {
              if (!notesDrawer.isOpen) {
                notesDrawer.open(session.id);
              } else {
                notesDrawer.toggle();
              }
            }}
            className='p-1 hover:bg-zinc-100 dark:hover:bg-zinc-800 flex-shrink-0'
            title={notesDrawer.isOpen ? t('notes.close') : t('notes.open')}
            aria-label={notesDrawer.isOpen ? t('notes.close') : t('notes.open')}
          >
            <FileText className='h-5 w-5' />
          </button>
        ) : (
          <Button
            variant='outline'
            size='icon'
            className='h-9 w-9 bg-background/95 backdrop-blur-sm border-muted/50 hover:bg-background/80 relative'
            data-testid="notes-toggle-button"
            onClick={() => {
              if (!notesDrawer.isOpen) {
                notesDrawer.open(session.id);
              } else {
                notesDrawer.toggle();
              }
            }}
            title={notesDrawer.isOpen ? t('notes.close') : t('notes.open')}
          >
            <FileText className='h-4 w-4 opacity-70' />
          </Button>
        )}
      </div>
    </div>
  );

  return (
    <div
      className={cn(
        'flex h-screen-dynamic bg-card dark:bg-black relative',
        isMobile ? 'mobile-chat-messages' : '',
        isNotesOpen ? 'notes-drawer-open' : '',
        isPdfOpen ? 'pdf-drawer-open' : '',
        isEpubOpen ? 'epub-drawer-open' : '',
        isDocxOpen ? 'docx-drawer-open' : '',
        isMarkdownOpen ? 'markdown-viewer-open' : '',
        deepResearchPanel.isOpen ? 'deep-research-panel-open' : ''
      )}
      style={{
        // Hide the entire ChatMessages container when two drawers are open (any combination of PDF, EPUB, DOCX, Notes, Markdown)
        display: isTwoDrawersOpen && !isMobileOrTabletPortrait
          ? 'none'
          : 'flex',
        zIndex: 10, // Lower z-index than drawers (PDF and Notes are 60)
      }}
    >
      <div
        className={cn(
          'flex flex-col h-full conversation-content w-full px-0 bg-card dark:bg-black',
          // `relative` always — anchors the absolutely-positioned toolbar
          // wrapper on desktop too (mobile already needed it for the fixed
          // bottom bar). Without this the desktop overlay path falls back
          // to the document body and lands at the wrong scroll position.
          'relative'
        )}
        style={
          // On large screens: adjust chat area based on what drawers are open
          // Hide chat when any two drawers are open (any combination of PDF, EPUB, DOCX, Notes, Markdown)
          !isMobileOrTabletPortrait && isTwoDrawersOpen
            ? {
              // Two drawers open - hide chat (drawers take left and right 50%)
              display: 'none',
            }
            : !isMobileOrTabletPortrait && isPdfOpen
              ? {
                // Only PDF open - chat takes opposite side
                maxWidth: 'none',
                position: 'absolute' as const,
                height: '100%',
                ...(isPdfOnLeft
                  ? { width: 'calc(50vw)', right: '0', left: 'auto' } // PDF on left, chat on right (no offset needed)
                  : {
                    // PDF on right, chat on left - account for sidebar and drawer
                    //  is 45% on md screens (992-1280px), 50% on larger screens
                    width: isSidebarOpen
                      ? (screenWidth >= 1280 ? 'calc(50vw - 335px)' : 'calc(55vw - 335px)')
                      : (screenWidth >= 1280 ? 'calc(50vw - 70px)' : 'calc(55vw - 70px)'),
                    left: '0',
                    right: 'auto'
                  }),
              }
              : !isMobileOrTabletPortrait && isEpubOpen
                ? {
                  // Only EPUB open - chat takes opposite side
                  maxWidth: 'none',
                  position: 'absolute' as const,
                  height: '100%',
                  ...(isEpubOnLeft
                    ? { width: 'calc(50vw)', right: '0', left: 'auto' } // EPUB on left, chat on right (no offset needed)
                    : {
                      // EPUB on right, chat on left - account for sidebar and drawer
                      width: isSidebarOpen
                        ? (screenWidth >= 1280 ? 'calc(50vw - 335px)' : 'calc(55vw - 335px)')
                        : (screenWidth >= 1280 ? 'calc(50vw - 70px)' : 'calc(55vw - 70px)'),
                      left: '0',
                      right: 'auto'
                    }),
                }
                : !isMobileOrTabletPortrait && isDocxOpen
                  ? {
                    // Only DOCX open - chat takes opposite side
                    // Sidebar auto-collapses, so only account for quick-tools (70px)
                    maxWidth: 'none',
                    position: 'absolute' as const,
                    height: '100%',
                    ...(isDocxOnLeft
                      ? { width: 'calc(50vw)', right: '0', left: 'auto' } // DOCX on left, chat on right (no offset needed)
                      : {
                        // DOCX on right, chat on left - only account for sidebar-quick-tools (70px)
                        // Drawer is 45% on md screens (992-1280px), 50% on larger screens
                        width: screenWidth >= 1280 ? 'calc(50vw - 70px)' : 'calc(55vw - 70px)',
                        left: '0',
                        right: 'auto'
                      }),
                  }
                  : !isMobileOrTabletPortrait && isNotesOpen
                    ? {
                      // Only Notes open - chat takes opposite side
                      maxWidth: 'none',
                      position: 'absolute' as const,
                      height: '100%',
                      ...(isNotesOnLeft
                        ? { width: 'calc(50vw)', right: '0', left: 'auto' } // Notes on left, chat on right
                        : {
                          // Notes on right, chat on left - account for sidebar and drawer
                          width: isSidebarOpen
                            ? (screenWidth >= 1280 ? 'calc(50vw - 335px)' : 'calc(55vw - 335px)')
                            : (screenWidth >= 1280 ? 'calc(50vw - 70px)' : 'calc(55vw - 70px)'),
                          left: '0',
                          right: 'auto'
                        }),
                    }
                    : !isMobileOrTabletPortrait && isMarkdownOpen
                      ? {
                        // Markdown viewer opens - chat takes opposite side
                        maxWidth: 'none',
                        position: 'absolute' as const,
                        height: '100%',
                        ...(isMarkdownOnLeft
                          ? { width: 'calc(50vw)', right: '0', left: 'auto' }
                          : {
                            width: screenWidth >= 1280 ? 'calc(50vw - 70px)' : 'calc(55vw - 70px)',
                            left: '0',
                            right: 'auto'
                          }),
                      }
                    : deepResearchPanel.isOpen && !isMobileOrTabletPortrait
                    ? {
                      // Deep Research panel open - chat takes left side
                      maxWidth: 'none',
                      position: 'absolute' as const,
                      height: '100%',
                      width: isSidebarOpen
                        ? (screenWidth >= 1280 ? 'calc(50vw - 335px)' : 'calc(55vw - 335px)')
                        : (screenWidth >= 1280 ? 'calc(50vw - 70px)' : 'calc(55vw - 70px)'),
                      left: '0',
                      right: 'auto',
                    }
                    : {}
        }
      >
        {/* Mobile header sits ABOVE the scroll container so it never disappears
            when the messages list scrolls past one viewport on real mobile
            browsers (sticky inside flex-1 overflow-y-auto is unreliable on
            touch devices). Desktop renders the header inside the scroll
            container — see the desktop branch below. */}
        {isMobileOrTabletPortrait && chatHeaderEl}
        <div
          className={cn(
            'flex-1 overflow-y-auto',
            // Mobile: add bottom padding to prevent content being hidden behind fixed toolbar
            isMobileOrTabletPortrait ? 'pb-32' : ''
          )}
          // On desktop the toolbar overlays the bottom of this container.
          // Pad by the measured toolbar height so the last message can scroll
          // up past it AND messages above visibly slide UNDER the translucent
          // toolbar — that's what makes the bg-card/35 + backdrop-blur read
          // as "messages behind the chrome" instead of just a tinted block
          // sitting in static flex flow.
          style={!isMobileOrTabletPortrait ? { paddingBottom: toolbarHeight } : undefined}
          ref={messagesContainerRef}
          data-testid="chat-messages-scroll"
        >
          {/* On desktop the header is sticky INSIDE this scroll container so
              messages slide under it (frosted-glass effect). On mobile we
              render it as a sibling ABOVE the scroll container — see the
              `chatHeaderEl` declaration for the why. */}
          {!isMobileOrTabletPortrait && chatHeaderEl}
          {(session.messages || []).length === 0 ? (
            // Three previous branches discriminated on isLoading /
            // streamingContent / messageStreamingInProgress and rendered
            // EmptySession with three different keys (`empty-session-`,
            // `empty-session-loading-`, `empty-session-fallback-`). The props
            // were identical, so the only effect of the differing keys was to
            // make React unmount and remount the subtree (and its "Korištenje
            // baze znanja" banner) up to ~20Hz whenever any of those flags
            // briefly toggled — visible flicker. Collapsed to one path with a
            // stable key. The empty-state still shows during a streaming start
            // (messages array is empty until the first delta is committed); the
            // streaming overlay is rendered separately above the empty state.
            <EmptySession
              key={`empty-session-${session?.id}-${selectedModel?.id || 'no-model'}`}
              selectedCollection={selectedCollection}
              selectedModel={selectedModel}
              onSendMessage={onSendMessageForEmptySession}
              notesDrawer={notesDrawer}
              sessionId={session?.id}
              onNewSession={onNewSession}
              onDeleteSession={onDeleteSession}
            />
          ) : (
            <>
              {/* Loading for older messages now handled by global loading spinner */}

              {/* Show the "Load More" button if there are more messages, we're not yet loading, and messages exceed screen height */}
              {hasMoreMessages &&
                !loadingMoreMessages &&
                messagesExceedScreenHeight &&
                session &&
                session.messages &&
                session.messages.length > 0 && (
                  <div className='flex justify-center py-2'>
                    <Button
                      data-testid="chat-load-more-button"
                      variant='outline'
                      size='sm'
                      onClick={onLoadMoreMessages}
                      className='text-xs'
                    >
                      {t('chat.loadOlderMessages')}
                    </Button>
                  </div>
                )}

              {/* Messages */}
              {session &&
                session.messages &&
                [...session.messages]
                  .filter((msg, index, arr) => {
                    // Filter out messages that should be hidden during repeat operations
                    // Only hide messages when explicitly repeating, not during normal new messages

                    if (isRepeating && arr.length >= 1) {
                      const lastIndex = arr.length - 1;

                      // Hide last assistant message ONLY when repeating (regenerating)
                      // Don't hide it when sending new messages - old responses should remain visible
                      if (index === lastIndex && msg.role === 'assistant') {
                        return false;
                      }

                      // Hide second-to-last user message when repeating
                      if (arr.length >= 2) {
                        const secondLastIndex = arr.length - 2;
                        if (index === secondLastIndex &&
                          msg.role === 'user' &&
                          arr[lastIndex].role === 'assistant') {
                          return false;
                        }
                      }
                    }
                    return true;
                  })
                  .sort((a, b) => {
                    // Sort by timestamp to ensure chronological order
                    const timeA = a.timestamp instanceof Date ? a.timestamp.getTime() : new Date(a.timestamp).getTime();
                    const timeB = b.timestamp instanceof Date ? b.timestamp.getTime() : new Date(b.timestamp).getTime();
                    if (timeA !== timeB) return timeA - timeB;
                    // Deterministic tiebreaker so colliding/equal client timestamps
                    // (optimistic user msg + assistant reply landing in the same ms,
                    // or edit/repeat reusing timestamps) never swap position between
                    // renders — which scrambled comment order until a refresh.
                    // Within a turn the user message always precedes its reply; then
                    // fall back to a stable id compare.
                    const rankA = a.role === 'user' ? 0 : 1;
                    const rankB = b.role === 'user' ? 0 : 1;
                    if (rankA !== rankB) return rankA - rankB;
                    return String(a.id).localeCompare(String(b.id));
                  })
                  .map((message, index) => {
                    // Compute these values outside the render to reduce re-renders
                    const isLastMessage =
                      index ===
                      (session.messages ? session.messages.length - 1 : -1);
                    const isThinkingForThisMessage: boolean = Boolean(isLastMessage && isThinking);

                    // Get thinking content from message metadata or streaming state
                    const thinkingContentForMessage: string =
                      (message.message_metadata?.thinking_content as string | undefined) ||
                      (isLastMessage ? thinkingContent : '');

                    const thinkingTimeMsForMessage: number =
                      (message.message_metadata?.thinking_time_ms as number | undefined) ||
                      (isLastMessage ? thinkingTimeMs : 0);

                    const modelInsightContentForMessage: string =
                      (message.message_metadata?.model_insight_content as string | undefined) || '';

                    return (
                      <MemoizedMessageWrapper
                        key={message.id}
                        message={message}
                        isLatest={isLastMessage}
                        modelIconSrc={getIconForProvider(
                          selectedModel?.provider_type
                        )}
                        isEditing={editingMessageId === message.id}
                        isThinking={isThinkingForThisMessage}
                        thinkingContent={thinkingContentForMessage}
                        modelInsightContent={modelInsightContentForMessage}
                        thinkingTimeMs={thinkingTimeMsForMessage}
                        onEditMessage={handleEditMessage}
                        onRepeatMessage={handleRepeatMessage}
                        onDeleteMessage={handleDeleteMessage}
                        onContinueGeneration={handleContinueGeneration}
                        onRegenerateResponse={handleRegenerateResponse}
                        onSaveEdit={handleSaveEditedMessage}
                        onCancelEdit={handleCancelEdit}
                        codeTheme={codeTheme}
                        fontSize={fontSize}
                        messageRef={isLastMessage ? lastMessageRef : null}
                        onOpenRagTrace={setRagTraceMessageId}
                        hasRagTrace={!!(getRagTrace && message.role === 'assistant' && getRagTrace(message.id))}
                        researchReportData={(() => {
                          const meta = (message.message_metadata || message.metadata) as Record<string, unknown> | undefined;
                          const report = meta?.research_report as Record<string, unknown> | undefined;
                          if (!report) return undefined;
                          return {
                            title: report.title as string,
                            // Optional: present during live streaming, absent after a
                            // session reload (Kotlin strips it from persisted metadata).
                            fullReportMarkdown: report.full_report_markdown as string | undefined,
                            qualityScore: report.quality_score as number | undefined,
                            totalSources: report.total_sources as number,
                            wordCount: report.word_count as number,
                            planId: report.plan_id as string,
                          };
                        })()}
                        clarificationData={isLastMessage && deepResearchPanel.awaitingClarification ? deepResearchPanel.clarificationData : undefined}
                        onSubmitClarification={isLastMessage ? (answers, requestId) => {
                          if (onSendMessage) {
                            const originalQuery = session.messages?.[0]?.content || '';
                            const answerSummary = answers.map((a, i) => `${i + 1}. ${a.answer}`).join('\n');
                            void onSendMessage(`[Research: ${originalQuery}]\n${answerSummary}`, {
                              deep_research_enabled: true,
                              clarification_answers: answers,
                              clarification_request_id: requestId,
                              hide_user_message: true,
                            });
                          }
                        } : undefined}
                        onSkipClarification={isLastMessage ? () => {
                          if (onSendMessage) {
                            const originalQuery = session.messages?.[0]?.content || '';
                            void onSendMessage(`[Research: ${originalQuery}] (broad analysis)`, {
                              deep_research_enabled: true,
                              clarification_answers: [{ question: 'skipped', answer: 'skipped' }],
                              hide_user_message: true,
                            });
                          }
                        } : undefined}
                        followUpSuggestions={isLastMessage && !isAiResponding ? followUpSuggestions : undefined}
                        onSuggestionClick={isLastMessage ? (question: string) => {
                          if (onSendMessage) {
                            void onSendMessage(question, {
                              mention_document_ids: suggestionDocumentId ? [suggestionDocumentId] : undefined,
                            });
                          }
                        } : undefined}
                        onFeedback={message.role === 'assistant' ? handleFeedback : undefined}
                        onViewFullReport={(() => {
                          const meta = (message.message_metadata || message.metadata) as Record<string, unknown> | undefined;
                          const report = meta?.research_report as Record<string, unknown> | undefined;
                          if (!report) return undefined;
                          return async () => {
                            // Fast path: live-stream memory still holds the full markdown
                            // (set while the report was streaming into this session). After
                            // a reload Kotlin strips `full_report_markdown` from persisted
                            // message metadata, so we lazy-fetch the markdown body AND
                            // discoveries from /research/by-plan/{planId} in one call.
                            let content = (report.full_report_markdown as string | undefined) || '';
                            let disc = deepResearchPanel.discoveries;
                            const needsFetch = !content || (!disc || disc.length === 0);
                            if (needsFetch && report.plan_id) {
                              try {
                                const { getResearchByPlanId } = await import('@/lib/api-research');
                                const research = await getResearchByPlanId(report.plan_id as string);
                                if (!content && research?.synthesis?.main_content) {
                                  content = research.synthesis.main_content;
                                }
                                if ((!disc || disc.length === 0) && research?.plan?.discoveries) {
                                  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- discovery shape comes from API response without a shared type
                                  disc = research.plan.discoveries.map((d: any, idx: number) => ({
                                    index: idx,
                                    title: d.title || '',
                                    claim: d.claim || '',
                                    summary: d.summary || '',
                                    evidenceCount: d.evidence_count || (d.evidence?.length || 0),
                                    confidence: d.confidence || 0,
                                    category: d.category || 'finding',
                                    novelty: d.novelty_assessment || '',
                                    sources: d.sources || [],
                                    tags: d.tags || [],
                                  }));
                                }
                              } catch { /* ignore fetch errors */ }
                            }
                            markdownViewer.dispatch({
                              type: 'OPEN_MARKDOWN_VIEWER',
                              payload: {
                                content,
                                title: report.title as string,
                                planId: report.plan_id as string,
                                qualityScore: report.quality_score as number | undefined,
                                totalSources: report.total_sources as number,
                                wordCount: report.word_count as number,
                                discoveries: disc,
                              },
                            });
                          };
                        })()}
                      />
                    );
                  })}

              {/* Show streaming content using packet-based state */}
              {(() => {
                // The live streaming/progress block must only exist during an ACTIVE
                // turn (isLoading) or an interactive research state. After completion
                // and on a loaded/historical conversation isLoading is false — without
                // this gate a stale statusMessage or a stuck deepResearchPanel.isResearching
                // (the agentic flow can leave it true) renders a phantom "pending" /
                // "Čekanje odgovora" bubble next to the committed answer. Deep-research
                // plan-approval and research-setup are interactive states that render
                // without an active stream, so keep them.
                // Also render when a research run is confirmed active (isResearching
                // + a real research id) but this tab has no live HTTP stream — e.g.
                // after a reload or reopening the tab mid-run. Without this the left
                // side looked idle while the backend was still working. The
                // getActiveResearch reconciliation clears stale isResearching, so a
                // confirmed id won't leave a phantom "pending" bubble.
                const hasActiveRestoredRun = deepResearchPanel.isResearching && !!deepResearchPanel.activeResearchId;
                if (!isLoading && !deepResearchPanel.awaitingPlanApproval && !researchSetup && !hasActiveRestoredRun) {
                  return null;
                }
                // Show streaming message if there's content OR a status message
                // Status messages (like documentQaExtractingText) are emitted before message content
                // Keep showing until final message is added (don't hide on streamEnded alone)
                if (!streamingContent && !statusMessage?.content && !deepResearchPanel.isResearching && !deepResearchPanel.awaitingPlanApproval && !researchSetup) {
                  return null;
                }

                // Only show streaming if:
                // 1. We don't have any messages yet, or
                // 2. The last message isn't from the assistant (to avoid duplication)
                // 3. The last assistant message has empty content (placeholder for streaming)
                // Exception: always show during active deep research (progress bar needs to render)
                if (
                  !deepResearchPanel.isResearching &&
                  !deepResearchPanel.awaitingPlanApproval &&
                  session.messages &&
                  session.messages.length > 0
                ) {
                  const lastMessage = session.messages[session.messages.length - 1];
                  // Only hide streaming if the last message is assistant with significant content
                  if (lastMessage.role === 'assistant' && lastMessage.content && lastMessage.content.trim() !== '') {
                    return null;
                  }
                }

                // Use packet-based state from useStreamingChat hook
                // If this is a fresh stream (lastProcessedLength === 0), use empty content
                // to prevent a single-frame flash of stale content from previous session
                const isFreshStream = lastProcessedLength.current === 0;
                const regularContent = researchSetup
                  ? t('deepResearch.setup.inlinePrompt', 'Choose a research template for your query:')
                  : isFreshStream ? '' : (streamingPackets.messageContent || '');
                const thinkContent = isFreshStream ? '' : (streamingPackets.thinkContent || '');
                const isThinking = isFreshStream ? false : streamingPackets.isThinking;
                const streamingCitations = isFreshStream ? [] : (streamingPackets.citations || []);

                return (
                  <div
                    key={`${session ? session.id : 'streaming'}_streaming_container`}
                    ref={streamingMessageRef}
                  >
                    <ChatMessage
                      key={`streaming_${session ? session.id : 'default'}`}
                      message={{
                        id: `streaming_${session ? session.id : 'default'}`,
                        role: 'assistant' as const,
                        content: regularContent,
                        timestamp: new Date(),
                        message_metadata: streamingCitations.length > 0 ? {
                          citations: streamingCitations,
                          retrieval_results: streamingCitations.length,
                        } : undefined,
                      }}
                      isLatest={true}
                      isStreaming={!researchSetup}
                      modelIconSrc={getIconForProvider(selectedModel?.provider_type)}
                      isThinking={isThinking}
                      thinkingContent={thinkContent}
                      thinkingTimeMs={streamingPackets.thinkingTimeMs}
                      codeTheme={codeTheme}
                      fontSize={fontSize}
                      statusMessage={statusMessage}
                      stageHistory={stageHistory}
                      researchProgress={
                        deepResearchPanel.isResearching
                          ? {
                              isResearching: deepResearchPanel.isResearching,
                              researchComplete: deepResearchPanel.researchComplete,
                              currentStep: deepResearchPanel.currentStep,
                              researchSteps: deepResearchPanel.researchSteps,
                              sources: deepResearchPanel.sources,
                              planningProgress: deepResearchPanel.planningProgress,
                              phases: deepResearchPanel.phases,
                              activePhaseId: deepResearchPanel.activePhaseId,
                              onOpenPanel: deepResearchPanel.openPanel,
                              adaptiveStep: deepResearchPanel.adaptiveStep,
                              adaptiveMaxSteps: deepResearchPanel.adaptiveMaxSteps,
                              adaptiveComplexity: deepResearchPanel.adaptiveComplexity,
                              synthesisProgress: deepResearchPanel.synthesisData?.progress,
                            }
                          : undefined
                      }
                      researchSetupData={researchSetup}
                      onStartResearch={handleResearchStart}
                      onSkipResearch={handleResearchSkip}
                      // Passed only to suppress the "Starting deep research…" spinner
                      // while the standalone plan-preview card awaits approval.
                      planPreviewData={deepResearchPanel.awaitingPlanApproval ? deepResearchPanel.planPreviewData : null}
                    />
                  </div>
                );
              })()}

              {/* Clarification now renders inline inside ChatMessage component */}

              {/* Standalone Plan Preview Card — rendered outside memo/streaming to avoid stale cache */}
              {deepResearchPanel.awaitingPlanApproval && deepResearchPanel.planPreviewData && (
                <div className="md:ml-8 mb-4 text-left">
                  <PlanPreviewCard
                    planId={deepResearchPanel.planPreviewData.planId}
                    title={deepResearchPanel.planPreviewData.title}
                    objective={deepResearchPanel.planPreviewData.objective}
                    methodology={deepResearchPanel.planPreviewData.methodology}
                    sections={deepResearchPanel.planPreviewData.sections}
                    totalQuestions={deepResearchPanel.planPreviewData.totalQuestions}
                    estimatedSources={deepResearchPanel.planPreviewData.estimatedSources}
                    sourceTypes={deepResearchPanel.planPreviewData.sourceTypes}
                    estimatedDurationMinutes={deepResearchPanel.planPreviewData.estimatedDurationMinutes}
                    onApprove={(planId: string) => {
                      if (onSendMessage) {
                        const originalQuery = session.messages?.[0]?.content || '';
                        deepResearchPanel.clearResearch();
                        void onSendMessageWithModel(`[Research approved: ${originalQuery}]`, {
                          // Re-attach the setup-card config (tier, template,
                          // council) captured at start — this approval request is
                          // what actually runs the research, so without it the run
                          // reverts to the default tier and drops the council.
                          ...pendingSetupRef.current,
                          deep_research_enabled: true,
                          approved_plan_id: planId,
                          hide_user_message: true,
                        });
                      }
                    }}
                    onRegenerate={(feedback?: string) => {
                      if (onSendMessage) {
                        const originalQuery = session.messages?.[0]?.content || '';
                        const previousPlanId = deepResearchPanel.planPreviewData?.planId;
                        deepResearchPanel.clearResearch();
                        void onSendMessageWithModel(`[Regenerate plan: ${originalQuery}]`, {
                          deep_research_enabled: true,
                          plan_feedback: feedback || '',
                          previous_plan_id: previousPlanId || '',
                          hide_user_message: true,
                        });
                      }
                    }}
                    onDismiss={() => {
                      deepResearchPanel.clearResearch();
                    }}
                  />
                </div>
              )}

              <div ref={messagesEndRef} className='h-4' />
            </>
          )}
        </div>

        <div ref={toolbarWrapperRef} className={cn(
          // Mobile/Tablet: position toolbar at bottom of screen
          isMobileOrTabletPortrait ? 'fixed bottom-0 right-0 z-10' : '',
          // Account for quick-tools bar (70px) on tablet (1080-1199px)
          isMobileOrTabletPortrait && !isMobile ? 'left-[70px]' : '',
          // On mobile (<1080px), quick-tools hidden, so left-0
          isMobileOrTabletPortrait && isMobile ? 'left-0' : '',
          // Desktop (≥1200px): overlay the bottom of the chat column so the
          // messages container can scroll UNDERNEATH the translucent toolbar.
          // Without this the toolbar took its own row in flex flow and the
          // bg-card/35 + backdrop-blur had nothing behind it to filter.
          !isMobileOrTabletPortrait ? 'absolute left-0 right-0 bottom-0 z-10' : ''
        )}>
          <ChatToolbar
            onSendMessage={onSendMessageWithModel}
            onCancelRequest={() => {
              // If a deep research is running, tell the backend to cancel it
              // first (sets a Redis flag the orchestrator polls). The local
              // chat-stream cancel still runs so the optimistic UI clears.
              if (deepResearchPanel.activeResearchId && deepResearchPanel.isResearching) {
                void deepResearchPanel.cancelDeepResearch();
              }
              onCancelRequest?.();
            }}
            isLoading={isAiResponding || deepResearchPanel.isResearching}
            onModelChange={onSelectModel}
            initialSessionId={session.id}
            selectedCollections={selectedCollections}
            onSelectCollections={handleSelectCollections}
            openSettingsWithTab={openSettingsWithTab}
            selectedModel={selectedModel}
            session={session}
            preloadedModelSettings={preloadedModelSettings}
            onOptionsChange={(options) => {
              toolbarOptionsRef.current = options;
            }}
            onOpenVoiceMode={(docs) => {
              setVoiceModeDocs(docs || []);
              setVoiceModeOpen(true);
            }}
          />

          {/* Live voice mode — bypasses the full agentic pipeline and hits
              the dedicated /voice/chat endpoint for 1–3 s round-trips. When
              the user has collections selected, the server attaches an
              optional `search_collection` tool the LLM can call for corpus-specific questions (~5–10 s extra). Conversation is transient
              (in-memory history), not persisted in the chat session. */}
          <VoiceModeDialog
            open={voiceModeOpen}
            onOpenChange={setVoiceModeOpen}
            collectionIds={(selectedCollections || []).map(c => c.id)}
            documents={voiceModeDocs}
          />
        </div>
      </div>

      {/* Deep Research Panel - slides in from right */}
      {deepResearchPanel.isOpen && (
        <DeepResearchPanel
          isOpen={deepResearchPanel.isOpen}
          onClose={deepResearchPanel.closePanel}
          onDismiss={deepResearchPanel.dismissPanel}
          onMountedChange={deepResearchPanel.setPanelMounted}
          researchSteps={deepResearchPanel.researchSteps}
          sources={deepResearchPanel.sources}
          liveUrls={deepResearchPanel.liveUrls}
          currentStep={deepResearchPanel.currentStep}
          isResearching={deepResearchPanel.isResearching}
          isObservingRemote={deepResearchPanel.isObservingRemote}
          researchPlan={deepResearchPanel.researchPlan}
          planningProgress={deepResearchPanel.planningProgress}
          phases={deepResearchPanel.phases}
          activePhaseId={deepResearchPanel.activePhaseId}
          clarificationData={deepResearchPanel.clarificationData}
          awaitingClarification={deepResearchPanel.awaitingClarification}
          onSubmitClarification={(answers, requestId) => {
            if (onSendMessage) {
              const originalQuery = session.messages?.[0]?.content || '';
              const answerSummary = answers.map((a, i) => `${i + 1}. ${a.answer}`).join('\n');
              void onSendMessage(`[Research: ${originalQuery}]\n${answerSummary}`, {
                deep_research_enabled: true,
                clarification_answers: answers,
                clarification_request_id: requestId,
                hide_user_message: true,
              });
            }
          }}
          onSkipClarification={() => {
            if (onSendMessage) {
              const originalQuery = session.messages?.[0]?.content || '';
              void onSendMessage(`[Research: ${originalQuery}] (broad analysis)`, {
                deep_research_enabled: true,
                clarification_answers: [{ question: 'skipped', answer: 'skipped' }],
                hide_user_message: true,
              });
            }
          }}
          planPreviewData={deepResearchPanel.planPreviewData}
          awaitingPlanApproval={deepResearchPanel.awaitingPlanApproval}
          onApprovePlan={(planId: string) => {
            if (onSendMessage) {
              const originalQuery = session.messages?.[0]?.content || '';
              deepResearchPanel.clearResearch();
              void onSendMessage(`[Research approved: ${originalQuery}]`, {
                deep_research_enabled: true,
                approved_plan_id: planId,
                hide_user_message: true,
              });
            }
          }}
          onRegeneratePlan={(feedback?: string) => {
            if (onSendMessage) {
              const originalQuery = session.messages?.[0]?.content || '';
              const previousPlanId = deepResearchPanel.planPreviewData?.planId;
              deepResearchPanel.clearResearch();
              void onSendMessage(`[Regenerate plan: ${originalQuery}]`, {
                deep_research_enabled: true,
                previous_plan_id: previousPlanId || '',
                plan_feedback: feedback || '',
                hide_user_message: true,
              });
            }
          }}
          persona={deepResearchPanel.persona}
          curation={deepResearchPanel.curation}
          totalCost={deepResearchPanel.totalCost}
          reviewFeedback={deepResearchPanel.reviewFeedback}
          synthesisData={deepResearchPanel.synthesisData}
          researchReport={deepResearchPanel.researchReport}
          researchComplete={deepResearchPanel.researchComplete}
          onViewReport={deepResearchPanel.researchReport ? () => {
            markdownViewer.dispatch({
              type: 'OPEN_MARKDOWN_VIEWER',
              payload: {
                content: deepResearchPanel.researchReport!.fullReportMarkdown,
                title: deepResearchPanel.researchReport!.title,
                planId: deepResearchPanel.researchReport!.planId,
                qualityScore: deepResearchPanel.researchReport!.qualityScore,
                totalSources: deepResearchPanel.researchReport!.totalSources,
                wordCount: deepResearchPanel.researchReport!.wordCount,
              },
            });
          } : undefined}
          onContinueResearch={(planId: string, continuationContext?: { selectedDiscoveryIds: string[]; comment: string; webSearchEnabled: boolean; depth: number }) => {
            if (onSendMessage) {
              const originalQuery = session.messages?.[0]?.content || '';
              const direction = continuationContext?.comment || '';
              const prompt = direction
                ? `[Continue research: ${originalQuery}]\n\nDirection: ${direction}`
                : `[Continue research: ${originalQuery}]`;
              deepResearchPanel.clearResearch();
              void onSendMessage(prompt, {
                deep_research_enabled: true,
                continue_research_plan_id: planId,
                continuation_context: continuationContext ? JSON.stringify(continuationContext) : undefined,
              // eslint-disable-next-line @typescript-eslint/no-explicit-any -- onSendMessage options don't expose all backend fields in the shared type
              } as any);
            }
          }}
          discoveries={deepResearchPanel.discoveries}
          councilState={deepResearchPanel.councilState}
        />
      )}

      {/* RAG Trace Sheet */}
      <RagTraceSheet
        open={!!ragTraceMessageId}
        onOpenChange={(open) => { if (!open) setRagTraceMessageId(null); }}
        traceData={ragTraceMessageId && getRagTrace ? getRagTrace(ragTraceMessageId) : undefined}
      />

      {/* Confirm overwriting later messages when continuing/branching from an earlier message */}
      <Dialog open={!!continueConfirmId} onOpenChange={(open) => { if (!open) setContinueConfirmId(null); }}>
        <DialogContent className='sm:max-w-[400px]' disableFullscreenOnMobile>
          <DialogTitle>{t('chat.actions.continueOverwriteTitle')}</DialogTitle>
          <DialogDescription>{t('chat.actions.continueOverwriteDescription')}</DialogDescription>
          <div className='flex justify-end gap-2 mt-4'>
            <Button variant='outline' onClick={() => setContinueConfirmId(null)}>
              {t('general.cancel')}
            </Button>
            <Button
              variant='destructive'
              data-testid='continue-overwrite-confirm-button'
              onClick={() => {
                const id = continueConfirmId;
                setContinueConfirmId(null);
                if (id) runContinueGeneration(id);
              }}
            >
              {t('chat.actions.continueOverwriteConfirm')}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

    </div>
  );
};

interface EmptySessionProps {
  selectedCollection: DocumentCollection | null;
  selectedModel: Model;
  onSendMessage: (
    content: string,
    options?: SendMessageOptions
  ) => Promise<void>;
  notesDrawer?: ReturnType<typeof useNotesDrawer>;
  sessionId?: string;
  onNewSession?: () => void;
  onDeleteSession?: (sessionId: string) => void;
}

const EmptySession = ({
  selectedCollection,
  selectedModel,
  onSendMessage,
  notesDrawer: _notesDrawer,
  sessionId,
  onNewSession: _onNewSession,
  onDeleteSession,
}: EmptySessionProps) => {
  const [searchParams] = useSearchParams();
  const { pathname } = useLocation();
  const sessionState = searchParams.get('session_state');
  const isNewSession = sessionState === 'new' || pathname === '/dashboard';

  const [showInstructions, setShowInstructions] = useState(false);
  const [showPromptSelector, setShowPromptSelector] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [promptText, setPromptText] = useState(
    'You are a helpful assistant...'
  );
  const [originalPrompt, setOriginalPrompt] = useState(
    'You are a helpful assistant...'
  );
  const { t } = useTranslation();
  const isMobile = useIsMobile();
  const isMobileOrTabletPortrait = useIsMobileOrTabletPortrait();

  const getModelDisplayName = () => {
    // Priority 1: Use selectedModel prop if it has proper display information
    if (selectedModel) {
      // For system provider, always show "Scrapalot AI v1" to hide backend implementation
      if (selectedModel.provider_type === 'system') {
        return 'Scrapalot AI v1';
      }

      // Use display_name if available (most user-friendly)
      if (selectedModel.display_name && selectedModel.display_name.trim()) {
        return selectedModel.display_name;
      }

      // Use display_name (required field)
      if (selectedModel.display_name && selectedModel.display_name !== selectedModel.id && selectedModel.display_name.trim()) {
        return selectedModel.display_name;
      }

    }

    // Priority 2: Try storage as fallback
    try {
      const storedModelObject = modelSelections.getActiveModelObject();

      if (storedModelObject) {
        // For system provider, always show "Scrapalot AI v1" to hide backend implementation
        if (storedModelObject.provider_type === 'system') {
          return 'Scrapalot AI v1';
        }

        if (storedModelObject.model_name && storedModelObject.model_name.trim()) {
          const modelName = storedModelObject.model_name;

          // Format technical model names more nicely
          if (modelName.includes('/')) {
            const lastPart = modelName.split('/').pop() || modelName;
            return lastPart
              .replace(/[-_:]/g, ' ')
              .replace(/\b\w/g, l => l.toUpperCase())
              .replace(/\s+/g, ' ')
              .trim();
          }

          return modelName;
        }
      }
    } catch (error) {
      console.warn('Failed to get model from storage-utils:', error);
    }

    // Priority 3: Format the ID if we have one
    if (selectedModel?.id) {
      const modelId = selectedModel.id;

      // For UUIDs, return a generic name
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(modelId)) {
        return 'AI Assistant';
      }

      // For technical IDs like "z-ai/glm-4.5-air:free", format them nicely
      if (modelId.includes('/')) {
        const lastPart = modelId.split('/').pop() || modelId;
        return lastPart
          .replace(/[-_:]/g, ' ')
          .replace(/\b\w/g, l => l.toUpperCase())
          .replace(/\s+/g, ' ')
          .trim();
      }

      // Format other IDs
      return modelId
        .replace(/[-_]/g, ' ')
        .replace(/\b\w/g, l => l.toUpperCase())
        .replace(/\s+/g, ' ')
        .trim();
    }

    return 'AI Assistant';
  };

  const getModelIconSrc = () => {
    // Mirror ChatModelSelector exactly: the "system" provider (Scrapalot AI)
    // always shows the Scrapalot logo, and the logo is the fallback too
    // (getIconForProvider also resolves system/fallback to this same PNG —
    // .ico assets do not render in the Android WebView).
    const SCRAPALOT_MODEL_ICON = '/providers/scrapalot.png';

    if (selectedModel) {
      if (selectedModel.provider_type?.toLowerCase() === 'system') {
        return SCRAPALOT_MODEL_ICON;
      }
      return selectedModel.iconSrc ||
        getIconForProvider(selectedModel.provider_type, selectedModel.model_name, selectedModel.display_name) ||
        SCRAPALOT_MODEL_ICON;
    }

    // Try to get icon from storage as fallback
    try {
      const storedModelObject = modelSelections.getActiveModelObject();
      if (storedModelObject && storedModelObject.provider_type) {
        if (storedModelObject.provider_type.toLowerCase() === 'system') {
          return SCRAPALOT_MODEL_ICON;
        }
        return getIconForProvider(storedModelObject.provider_type, storedModelObject.model_name) ||
          SCRAPALOT_MODEL_ICON;
      }
    } catch (error) {
      console.warn('Failed to get model icon from storage-utils:', error);
    }

    return SCRAPALOT_MODEL_ICON;
  };

  const handlePromptSelect = (template: { content: string }) => {
    setPromptText(template.content);
    setShowPromptSelector(false);
  };

  const handleClearAndSave = () => {
    setPromptText('You are a helpful assistant...');
    setOriginalPrompt('You are a helpful assistant...');
  };

  const handleSaveAsDefault = () => {
    // Here you would typically make an API call to save this as the model's default prompt
    setOriginalPrompt(promptText);
  };

  const handleDiscardChanges = () => {
    setPromptText(originalPrompt);
    setShowInstructions(false);
  };

  const handleApplyToChat = () => {
    // Persist the edited prompt as the working baseline for the session
    // (so reopening the editor shows the same body) and close the
    // editor. The legacy "system: ${promptText}" send path was dead
    // code — backend treated it as a regular user message because the
    // "system:" prefix has no special handling. Real prompt-template
    // injection now flows through the chat toolbar popover, which sets
    // `prompt_template_name` and the Layer 6 builder reads its body.
    setOriginalPrompt(promptText);
    setShowInstructions(false);
  };

  return (
    <div className={cn(
      // Subtract the sticky header's 3.5 rem / h-14 from full height. The
      // header now lives inside the scroll container (so messages can pass
      // behind its translucent bg), which means a naive h-full here pushes
      // this centered empty state over the container by exactly the
      // header's height and introduces a useless vertical scrollbar.
      'h-[calc(100%-3.5rem)] flex flex-col items-center justify-center p-4 md:p-8 animate-fade-in bg-card dark:bg-black z-0',
      isMobile ? 'mobile-empty-session' : ''
    )}>
      <div className='max-w-lg md:max-w-2xl text-center space-y-4'>
        <div className='flex flex-col items-center justify-center space-y-4'>
          <div className='w-16 h-16 rounded-full bg-zinc-100 flex items-center justify-center'>
            <ProviderIcon
              src={getModelIconSrc()}
              alt={getModelDisplayName()}
              className='w-12 h-12'
            />
          </div>
          <span className='text-sm sm:text-lg text-zinc-800 dark:text-white font-bold'>
            {getModelDisplayName()}
          </span>
          <button
            data-testid="chat-edit-instructions-button"
            onClick={() => setShowInstructions(!showInstructions)}
            className={`flex items-center justify-center gap-2 text-xs sm:text-sm text-zinc-500 hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-300 transition-all px-3 py-2 hover:bg-zinc-100 dark:hover:bg-zinc-800 w-full max-w-[450px] md:max-w-[600px] lg:max-w-[800px] xl:max-w-[900px] border border-zinc-100 dark:border-zinc-800 ${showInstructions ? 'opacity-0 h-0 overflow-hidden' : 'opacity-100'
              }`}
          >
            <svg
              width='16'
              height='16'
              viewBox='0 0 24 24'
              fill='none'
              stroke='currentColor'
              strokeWidth='2'
              strokeLinecap='round'
              strokeLinejoin='round'
            >
              <path d='M12 20h9' />
              <path d='M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z' />
            </svg>
            {t('chat.editModelInstructions')}
          </button>
          {showInstructions && (
            <div className='w-full max-w-[450px] md:max-w-[600px] lg:max-w-[800px] xl:max-w-[900px] animate-in fade-in'>
              <div className='bg-zinc-100 dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-lg'>
                <textarea
                  data-testid="chat-instructions-textarea"
                  className='w-full h-32 bg-transparent px-4 py-3 text-sm text-zinc-800 dark:text-white placeholder:text-zinc-500 focus:outline-none resize-none'
                  placeholder='You are a helpful assistant...'
                  value={promptText}
                  onChange={e => setPromptText(e.target.value)}
                />
                <div className='flex items-center justify-between px-4 py-2 border-t border-zinc-200 dark:border-zinc-800'>
                  <div className='flex items-center gap-2'>
                    <button
                      data-testid="chat-instructions-prompt-button"
                      className='p-1'
                      onClick={() => setShowPromptSelector(true)}
                    >
                      <svg
                        width='16'
                        height='16'
                        viewBox='0 0 24 24'
                        fill='none'
                        stroke='currentColor'
                        strokeWidth='2'
                        strokeLinecap='round'
                        strokeLinejoin='round'
                        className='text-zinc-500 dark:text-zinc-400'
                      >
                        <path d='M3 20l1.3-3.9C2.8 14.3 2 12.2 2 10c0-5.5 4.5-10 10-10s10 4.5 10 10c0 5.5-4.5 10-10 10c-2.2 0-4.3-.8-6.1-2.1L3 20z' />
                      </svg>
                    </button>
                    <button data-testid="chat-instructions-clear-button" className='p-1' onClick={handleClearAndSave}>
                      <svg
                        width='16'
                        height='16'
                        viewBox='0 0 24 24'
                        fill='none'
                        stroke='currentColor'
                        strokeWidth='2'
                        strokeLinecap='round'
                        strokeLinejoin='round'
                        className='text-zinc-500 dark:text-zinc-400'
                      >
                        <path d='M12 20v-6M6 20v-6M18 20v-6M6 14c0-3.314 2.686-6 6-6s6 2.686 6 6' />
                        <path d='M9 14c0-1.657 1.343-3 3-3s3 1.343 3 3' />
                        <path d='M12 8c1.105 0 2-.895 2-2s-.895-2-2-2-2 .895-2 2 .895 2 2 2z' />
                      </svg>
                    </button>
                  </div>
                  <div className='flex items-center gap-2'>
                    <button
                      data-testid="chat-instructions-cancel-button"
                      className='text-sm text-zinc-500 hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-300'
                      onClick={handleDiscardChanges}
                    >
                      {t('general.cancel')}
                    </button>
                    <button
                      data-testid="chat-instructions-apply-button"
                      className='text-sm text-zinc-800 dark:text-white bg-zinc-200 dark:bg-zinc-700 px-3 py-1 rounded hover:bg-zinc-300 dark:hover:bg-zinc-600'
                      onClick={handleApplyToChat}
                    >
                      {t('chat.applyToChat')}
                    </button>
                    <button
                      className='text-sm text-zinc-500 hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-300'
                      onClick={handleSaveAsDefault}
                    >
                      <svg
                        width='16'
                        height='16'
                        viewBox='0 0 24 24'
                        fill='none'
                        stroke='currentColor'
                        strokeWidth='2'
                        strokeLinecap='round'
                        strokeLinejoin='round'
                      >
                        <circle cx='12' cy='12' r='1' />
                        <circle cx='19' cy='12' r='1' />
                        <circle cx='5' cy='12' r='1' />
                      </svg>
                    </button>
                  </div>
                </div>
              </div>
            </div>
          )}
          {selectedCollection && (
            <div className='px-3 py-2 mb-2 text-xs text-accent-foreground bg-accent/20 rounded-lg max-w-max'>
              {t('chat.usingKnowledgeStack')}:{' '}
              <strong>{selectedCollection.name}</strong>
            </div>
          )}
          {onDeleteSession && sessionId && !isNewSession && (
            <button
              data-testid="chat-delete-session-button"
              onClick={() => setShowDeleteConfirm(true)}
              className='mt-4 flex items-center gap-1.5 text-xs text-zinc-400 hover:text-red-500 dark:text-zinc-500 dark:hover:text-red-400 transition-colors'
            >
              <Trash2 className='h-3.5 w-3.5' />
              {t('chat.deleteEmptySession')}
            </button>
          )}
        </div>
      </div>

      {onDeleteSession && sessionId && (
        <Dialog open={showDeleteConfirm} onOpenChange={setShowDeleteConfirm}>
          <DialogContent className='sm:max-w-[400px]' disableFullscreenOnMobile>
            <DialogTitle>{t('chat.deleteSessionTitle')}</DialogTitle>
            <DialogDescription>{t('chat.deleteSessionDescription')}</DialogDescription>
            <div className='flex justify-end gap-2 mt-4'>
              <Button variant='outline' onClick={() => setShowDeleteConfirm(false)}>
                {t('general.cancel')}
              </Button>
              <Button
                variant='destructive'
                onClick={() => {
                  setShowDeleteConfirm(false);
                  onDeleteSession(sessionId);
                }}
              >
                {t('general.delete')}
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      )}

      <Dialog open={showPromptSelector} onOpenChange={setShowPromptSelector}>
        <DialogContent
          className={cn(
            'p-0',
            isMobileOrTabletPortrait
              ? 'h-full max-h-[100vh] max-w-full rounded-none !inset-0 !left-0 !top-0 !translate-x-0 !translate-y-0 !transform-none'
              : 'sm:max-w-[500px]'
          )}
          hideCloseButton={isMobileOrTabletPortrait}
          forceMobileBackButton={isMobileOrTabletPortrait}
          dialogOpen={showPromptSelector}
          onOpenChange={setShowPromptSelector}
        >
          <DialogTitle className='sr-only'>
            {t('chat.promptTemplates')}
          </DialogTitle>
          <DialogDescription className='sr-only'>
            {t('chat.selectPromptTemplate')}
          </DialogDescription>
          <PopoverPromptSelector
            onSelect={handlePromptSelect}
            disableBlur={true}
            activeTemplateTitle={null}
          />
        </DialogContent>
      </Dialog>

    </div>
  );
};
