import React, {
  ComponentPropsWithoutRef,
  useEffect,
  useReducer,
  useMemo,
  useRef,
  useState,
} from 'react';
import ReactMarkdown from 'react-markdown';
import { mdUrlTransform } from '@/lib/native-app';
import remarkGfm from 'remark-gfm';
import {
  ArrowRight,
  BarChart2,
  Brain,
  ChevronDown,
  ChevronRight,
  Clock,
  Lightbulb,
  Copy,
  Copy as CopyIcon,
  Edit,
  BookOpen,
  ExternalLink,
  FileSearch,
  FileText,
  GitBranch,
  Loader2,
  Play,
  Quote,
  Repeat as RepeatIcon,
  Square,
  ThumbsDown,
  ThumbsUp,
  Trash2,
  User,
  Volume2,
  NotebookPen,
  BookmarkPlus,
  FileX,
} from 'lucide-react';
import { Message } from '@/types';
import { formatDate, cn } from '@/lib/utils';
import { ChatProcessingIndicator } from './chat-processing-indicator';
import { AvatarWithStatus } from '../ui/avatar-with-status';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import {
  oneDark,
  oneLight,
  prism as githubLight,
  materialDark as githubDark,
  dracula,
  vscDarkPlus,
} from 'react-syntax-highlighter/dist/esm/styles/prism';
import { Button } from '../ui/button';
import { usePDFViewer } from '@/contexts/pdf-viewer-context.tsx';
import { useEpubViewer } from '@/contexts/epub-viewer-context.tsx';
import { useDocxViewer } from '@/contexts/docx-viewer-context.tsx';
import { useOpenCitationInViewer } from '@/hooks/use-open-citation-in-viewer';
import { useTheme } from '../../providers/theme-provider';
import { resolveFileType } from '@/lib/resolve-file-type';
import { toast } from '@/lib/toast-compat';
import { createAnnotation } from '@/lib/api-annotations';
import { useAuth } from '@/hooks/use-auth';
import { useSimpleMode } from '@/hooks/use-simple-mode';
import { profilePicSources } from '@/lib/profile-picture';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import {
  useDocumentFileStatusStore,
  probeDocumentFile,
} from '@/hooks/use-document-file-status';
import { Textarea } from '../ui/textarea';
import { useTranslation } from 'react-i18next';
import { PopoverTokenMetrics } from './popover-token-metrics';
import { PopoverMessageAnalysis } from './popover-message-analysis';
import { ChatChartRenderer } from './chat-chart-renderer';
// EvidenceDistributionBar removed — stance colour on number bubbles is sufficient signal
import { CitationStanceChip } from './citation-stance-chip';
import { BridgeConceptsPanel } from './bridge-concepts-panel';
import { SearchStrategyPanel, type SearchStrategyData } from './search-strategy-panel';
import { useNotesDrawer } from '@/hooks/use-notes-drawer';
// (CE) Deep Research is hosted-only — inert no-op renders.
const InlineResearchSetup = (_props: any) => null;
const InlineResearchProgress = (_props: any) => null;
import { synthesizeSpeech, base64ToAudioBlob, splitTextForTTS } from '@/lib/api-tts';
import { LANGUAGE_VOICE_MAP } from '@/lib/tts-constants';
const ResearchCouncilPanel = (_props: any) => null;
import { apiClient } from '@/lib/api';
import type { CouncilState } from '@/contexts/deep-research-context';
import type { ChartDataPacket } from '@/types/streaming-packets';

/** Lazy-loads council deliberation from Python REST and renders the roundtable panel. */
const CouncilLoader: React.FC<{ planId: string }> = ({ planId }) => {
  const [council, setCouncil] = useState<CouncilState | null>(null);
  const [loadStatus, setLoadStatus] = useState<'loading' | 'missing' | 'error' | 'ready'>('loading');
  const [expanded, setExpanded] = useState(false);
  const { t } = useTranslation();

  useEffect(() => {
    let cancelled = false;
    setLoadStatus('loading');
    apiClient.get(`/council/${planId}`).then(resp => {
      if (cancelled) return;
      if (!resp.data || !resp.data.members || resp.data.members.length === 0) {
        // Endpoint returned 200 but the plan has no council attached
        // (research finished before Council feature was on, or skipped).
        setLoadStatus('missing');
        return;
      }
      const cd = resp.data;
      setCouncil({
        members: cd.members,
        selectionReason: cd.selection_reason || '',
        deliberations: (cd.deliberations || []).map((d: Record<string, unknown>, i: number) => ({
          memberIndex: i,
          totalMembers: (cd.deliberations as unknown[]).length,
          archetype: d.archetype as string,
          label: d.label as string || d.archetype as string,
          emoji: d.emoji as string || '🎭',
          position: d.position as string,
          reasoning: d.reasoning as string,
          keyRisk: d.key_risk as string,
          surprisingInsight: d.surprising_insight as string,
        })),
        synthesis: cd.synthesis ? {
          convergencePoints: cd.synthesis.convergence_points || [],
          coreTension: cd.synthesis.core_tension || '',
          blindSpot: cd.synthesis.blind_spot || '',
          recommendedPath: cd.synthesis.recommended_path || '',
          confidence: cd.synthesis.confidence || 'medium',
          questionToSitWith: cd.synthesis.question_to_sit_with || '',
          tensionEdges: cd.tension_edges || [],
        } : null,
        status: 'complete',
      });
      setLoadStatus('ready');
    }).catch((err) => {
      if (cancelled) return;
      // Log so a council fetch failure is visible in the browser console
      // instead of silently hiding the chip. Keeps the layout stable with a
      // small error pill so the user knows data exists but didn't load.
      console.warn(`[CouncilLoader] Failed to load /council/${planId}:`, err);
      setLoadStatus('error');
    });
    return () => { cancelled = true; };
  }, [planId]);

  if (loadStatus === 'missing') {
    // The council toggle was off for this research (or the council save
    // failed silently). Without this branch the skeleton would flash and
    // then vanish, looking like a crash. Show a muted chip so the user
    // knows the section is intentionally empty.
    return (
      <div className="md:ml-8 mt-3">
        <span className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground/60">
          <span>👥</span>
          <span>{t('deepResearch.council.title', 'Research Council')}</span>
          <span className="text-[10px] text-muted-foreground/50">
            ({t('deepResearch.council.notGenerated', 'not enabled for this research')})
          </span>
        </span>
      </div>
    );
  }

  if (loadStatus === 'loading') {
    // Keep the chip's footprint the moment the message is rendered, even
    // before the fetch lands, so the user sees the Council section is
    // loading instead of a 5-30 s blank spot under the report.
    return (
      <div className="md:ml-8 mt-3">
        <span className="inline-flex items-center gap-2 text-xs text-muted-foreground/60 animate-pulse">
          <span>👥</span>
          <span>{t('deepResearch.council.title', 'Research Council')}</span>
          <span className="inline-block h-2 w-16 bg-muted-foreground/20" />
        </span>
      </div>
    );
  }

  if (loadStatus === 'error') {
    return (
      <div className="md:ml-8 mt-3">
        <span className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground/80">
          <span>👥</span>
          <span>{t('deepResearch.council.title', 'Research Council')}</span>
          <span className="text-[10px] text-rose-500">
            ({t('deepResearch.council.loadError', 'could not load')})
          </span>
        </span>
      </div>
    );
  }

  if (!council) return null;

  return (
    <div className="md:ml-8 mt-3">
      <button
        onClick={() => setExpanded(v => !v)}
        className="flex items-center gap-2 text-xs text-muted-foreground hover:text-foreground transition-colors"
      >
        <span>👥</span>
        <span>{t('deepResearch.council.title', 'Research Council')}</span>
        <span className="text-[10px]">({council.members.length} {t('deepResearch.council.members', 'members')})</span>
        <ChevronDown className={`h-3 w-3 transition-transform ${expanded ? 'rotate-180' : ''}`} />
      </button>
      {expanded && <div className="mt-2"><ResearchCouncilPanel state={council} /></div>}
    </div>
  );
};

// Define a type for the code component props that includes the inline property
interface CodeProps extends ComponentPropsWithoutRef<'code'> {
  inline?: boolean;
}

/**
 * CitationLink — wraps a citation entry in a button that disables itself when
 * the referenced source file is known to be missing on disk. Probes the file
 * lazily on mount (HEAD via the shared document-file-status store, deduped).
 * Render prop exposes `missing` so the caller can swap the file-type icon for
 * a FileX indicator and strike through the title.
 */
const CitationLink: React.FC<{
  documentId: string | undefined;
  missingTitle: string;
  onOpen: () => void;
  children: (missing: boolean) => React.ReactNode;
}> = ({ documentId, missingTitle, onOpen, children }) => {
  const fileStatus = useDocumentFileStatusStore(
    (s) => (documentId ? s.status[documentId] : undefined) ?? 'unknown'
  );
  React.useEffect(() => {
    if (documentId && fileStatus === 'unknown') void probeDocumentFile(documentId);
  }, [documentId, fileStatus]);
  const missing = fileStatus === 'missing';
  return (
    <button
      type='button'
      disabled={missing}
      title={missing ? missingTitle : undefined}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        if (!missing) onOpen();
      }}
      className={cn(
        'text-left w-full transition-colors',
        missing
          ? 'opacity-50 cursor-not-allowed'
          : 'hover:text-primary/80'
      )}
    >
      {children(missing)}
    </button>
  );
};

/**
 * MentionDocumentChip — document @-mention chip rendered above a user
 * message. Pre-probes the file endpoint on mount so a deleted document
 * shows up as a disabled, struck-through chip with a FileX icon instead
 * of letting the click fall through to a generic 404 toast.
 */
const MentionDocumentChip: React.FC<{
  id: string;
  name: string;
  onOpen: () => void;
  colorClasses: string;
  missingTitle: string;
  openTitle: string;
}> = ({ id, name, onOpen, colorClasses, missingTitle, openTitle }) => {
  const fileStatus = useDocumentFileStatusStore(
    (s) => s.status[id] ?? 'unknown'
  );
  React.useEffect(() => {
    if (id && fileStatus === 'unknown') void probeDocumentFile(id);
  }, [id, fileStatus]);
  const missing = fileStatus === 'missing';
  return (
    <button
      type='button'
      disabled={missing}
      onClick={() => { if (!missing) onOpen(); }}
      title={missing ? missingTitle : openTitle}
      className={cn(
        'inline-flex items-center gap-1 px-2 py-0.5 text-[11px] font-medium border',
        colorClasses,
        missing
          ? 'opacity-50 cursor-not-allowed text-muted-foreground'
          : 'cursor-pointer transition-colors hover:bg-blue-100 dark:hover:bg-blue-900/50'
      )}
    >
      {missing ? (
        <FileX className='h-3 w-3 flex-shrink-0' />
      ) : (
        <FileText className='h-3 w-3 flex-shrink-0' />
      )}
      <span className={cn('truncate max-w-[200px]', missing && 'line-through decoration-muted-foreground/60')}>
        {name}
      </span>
    </button>
  );
};

// Strip background and textShadow from any syntax theme for transparent code blocks
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const makeTransparent = (base: Record<string, any>) => ({
  ...base,
  'pre[class*="language-"]': {
    ...base['pre[class*="language-"]'],
    background: 'transparent',
    textShadow: 'none',
  },
  'code[class*="language-"]': {
    ...base['code[class*="language-"]'],
    background: 'transparent',
    textShadow: 'none',
  },
});

// Light themes (dark text — for light app theme)
const customOneLight = makeTransparent(oneLight);
const customGithubLight = makeTransparent(githubLight);

// Dark themes (light text — for dark app theme)
const customOneDark = makeTransparent(oneDark);
const customVscDarkPlus = makeTransparent(vscDarkPlus);
const customDracula = makeTransparent(dracula);
const customGithubDark = makeTransparent(githubDark);

// Research progress props for inline display when panel is dismissed
interface ResearchProgressProps {
  isResearching: boolean;
  researchComplete: boolean;
  currentStep?: string;
  researchSteps: Array<{ id: string; type: string; content: string; timestamp: Date }>;
  sources: Array<{ url: string; title: string; snippet: string; validated: boolean }>;
  planningProgress?: { stage: string; progress: number; message: string };
  phases?: Array<{ phase: string; status: string; summary: string | null; startedAt: number | null; completedAt: number | null }>;
  activePhaseId?: string | null;
  onOpenPanel: () => void;
  adaptiveStep?: number;
  adaptiveMaxSteps?: number;
  adaptiveComplexity?: string | null;
  synthesisProgress?: number;
}

interface ChatMessageProps {
  message: Message;
  isUser?: boolean;
  isStreaming?: boolean;
  isLatest?: boolean;
  modelIconSrc?: string;
  iconSize?: 'sm' | 'md';
  isThinking?: boolean;
  thinkingContent?: string;
  modelInsightContent?: string;
  thinkingTimeMs?: number;
  onEditMessage?: (messageId: string, content: string) => void;
  onSaveEdit?: (messageId: string, content: string) => void;
  onCancelEdit?: () => void;
  onRepeatMessage?: (messageId: string, content: string) => void;
  onDeleteMessage?: (messageId: string) => void;
  onContinueGeneration?: (messageId: string) => void;
  onRegenerateResponse?: (messageId: string) => void;
  isEditing?: boolean;
  codeTheme?: string;
  fontSize?: number;
  statusMessage?: { content: string; stage?: string } | null;
  stageHistory?: Array<{ content: string; stage?: string; timestamp: number }>;
  // Inline research progress (shown when panel is manually dismissed)
  researchProgress?: ResearchProgressProps;
  // Research plan ID for viewing saved research
  researchPlanId?: string;
  // Callback to open the research panel with saved data
  onViewResearch?: (planId: string) => void;
  // RAG trace sheet
  onOpenRagTrace?: (messageId: string) => void;
  hasRagTrace?: boolean;
  // Deep Research v1: View full report
  researchReportData?: { title: string; fullReportMarkdown?: string; qualityScore?: number; totalSources: number; wordCount: number; planId: string } | null;
  onViewFullReport?: () => void;
  // Deep Research: Inline clarification
  clarificationData?: { questions: Array<{ id: string; question: string; hint: string; category?: string; priority?: string; answer_options?: string[] }>; requestId: string; researchContext: string } | null;
  onSubmitClarification?: (answers: Array<{ question: string; answer: string }>, requestId: string) => void;
  onSkipClarification?: () => void;
  // Deep Research: Plan preview
  planPreviewData?: { planId: string; title: string; objective: string; methodology: string; sections: Array<{ title: string; description: string; question_count: number; source_types: string[] }>; totalQuestions: number; estimatedSources: number; sourceTypes: string[]; estimatedDurationMinutes: number } | null;
  onApprovePlan?: (planId: string) => void;
  onRegeneratePlan?: (feedback?: string) => void;
  // Deep Research: Inline template setup (replaces modal dialog)
  researchSetupData?: { query: string; options: import('@/types').SendMessageOptions } | null;
  onStartResearch?: (text: string, options: import('@/types').SendMessageOptions) => void;
  onSkipResearch?: (text: string, options: import('@/types').SendMessageOptions) => void;
  // Follow-up suggestions
  followUpSuggestions?: string[];
  onSuggestionClick?: (question: string) => void;
  // Message feedback (thumbs up/down)
  onFeedback?: (messageId: string, feedback: number | null) => void;
}

// Define reducer state type
interface MessageState {
  regularContent: string;
  thinkingContent: string;
  isThinking: boolean;
  thinkingTimeMs: number;
  thinkingOpen: boolean;
  modelInsightOpen: boolean;
  hasCitations: boolean;
  showMoreTools: boolean;
  isCitationsOpen: boolean;
  isHovering: boolean;
}

// Define action types
type MessageAction =
  | { type: 'SET_REGULAR_CONTENT'; payload: string }
  | { type: 'SET_THINKING_CONTENT'; payload: string }
  | { type: 'UPDATE_THINKING_TIME'; payload: number }
  | { type: 'TOGGLE_THINKING_PANEL' }
  | { type: 'TOGGLE_MODEL_INSIGHT_PANEL' }
  | { type: 'SET_HAS_CITATIONS'; payload: boolean }
  | { type: 'TOGGLE_MORE_TOOLS' }
  | { type: 'SET_HOVERING'; payload: boolean }
  | { type: 'TOGGLE_CITATIONS' }
  | { type: 'PROCESS_MESSAGE_CONTENT'; payload: string };

// Reducer function
function messageReducer(
  state: MessageState,
  action: MessageAction
): MessageState {
  switch (action.type) {
    case 'SET_REGULAR_CONTENT':
      return { ...state, regularContent: action.payload };
    case 'SET_THINKING_CONTENT':
      return {
        ...state,
        thinkingContent: action.payload,
        isThinking: !!action.payload,
      };
    case 'UPDATE_THINKING_TIME':
      return { ...state, thinkingTimeMs: action.payload };
    case 'TOGGLE_THINKING_PANEL':
      return { ...state, thinkingOpen: !state.thinkingOpen };
    case 'TOGGLE_MODEL_INSIGHT_PANEL':
      return { ...state, modelInsightOpen: !state.modelInsightOpen };
    case 'SET_HAS_CITATIONS':
      return { ...state, hasCitations: action.payload };
    case 'TOGGLE_MORE_TOOLS':
      return { ...state, showMoreTools: !state.showMoreTools };
    case 'SET_HOVERING':
      return { ...state, isHovering: action.payload };
    case 'TOGGLE_CITATIONS':
      return { ...state, isCitationsOpen: !state.isCitationsOpen };
    case 'PROCESS_MESSAGE_CONTENT':
      // Only try to parse as JSON if the content looks like JSON (starts with '{' or '[')
      if (action.payload.trim().startsWith('{') || action.payload.trim().startsWith('[')) {
        try {
          // Try to parse JSON content
          const contentObj = JSON.parse(action.payload);

          if (
            contentObj &&
            typeof contentObj === 'object' &&
            'regularContent' in contentObj &&
            'thinkingContent' in contentObj
          ) {
            // Successfully parsed JSON with expected format
            return {
              ...state,
              regularContent: contentObj.regularContent || '',
              thinkingContent: contentObj.thinkingContent || '',
              isThinking: contentObj.thinkingContent !== undefined,
              thinkingOpen: contentObj.thinkingContent !== undefined,
            };
          }
        } catch (e) {
          // JSON parsing failed, fall through to treat as regular content
        }
      }

      // Default case for non-JSON content
      // Preserve thinking content when setting regular content
      return {
        ...state,
        regularContent: action.payload,
        // Keep existing thinking content - don't clear it when regular content arrives
        thinkingContent: state.thinkingContent,
        isThinking: false,
      };

    default:
      return state;
  }
}

/** Inline clarification — blends into AI message without card wrapper. */
function InlineClarification({
  questions,
  requestId,
  onSubmit,
  onSkip,
}: {
  questions: Array<{ id: string; question: string; hint: string; answer_options?: string[] }>;
  requestId: string;
  onSubmit: (answers: Array<{ question: string; answer: string }>, requestId: string) => void;
  onSkip: () => void;
}) {
  const { t } = useTranslation();
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [sourcePreference, setSourcePreference] = useState<'scientific' | 'all' | 'alternative'>('all');
  const [submitted, setSubmitted] = useState(false);

  const allAnswered = questions.every(q => !!answers[q.id]);

  const handleSubmit = () => {
    if (!allAnswered || submitted) return;
    setSubmitted(true);
    const formatted = questions.map(q => ({ question: q.question, answer: answers[q.id] || '' }));
    formatted.push({
      question: 'Source preference',
      answer: sourcePreference === 'scientific'
        ? 'Prioritize peer-reviewed scientific studies and clinical research (PubMed, ArXiv, Semantic Scholar)'
        : sourcePreference === 'alternative'
          ? 'Include alternative, holistic, and non-mainstream sources alongside conventional ones'
          : 'Use all available sources (scientific, web, alternative)',
    });
    onSubmit(formatted, requestId);
  };

  if (submitted) return null;

  return (
    <div className="md:ml-8 mt-3 space-y-3">
      {/* Source preference — subtle, inline */}
      <div className="flex flex-wrap items-center gap-1.5 text-xs">
        <span className="text-muted-foreground mr-1">{t('deepResearch.clarification.sourcePreference', 'Sources')}:</span>
        {([
          { key: 'scientific' as const, label: t('deepResearch.clarification.scientificStudies', 'Scientific') },
          { key: 'all' as const, label: t('deepResearch.clarification.allSources', 'All') },
          { key: 'alternative' as const, label: t('deepResearch.clarification.alternativeSources', 'Alternative') },
        ]).map(({ key, label }) => (
          <button
            key={key}
            onClick={() => setSourcePreference(key)}
            className={`px-2 py-1 text-xs transition-colors ${
              sourcePreference === key
                ? 'bg-primary text-primary-foreground'
                : 'text-muted-foreground hover:text-foreground hover:bg-muted/50'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {/* Answer options per question — right after markdown questions */}
      {questions.map((q, idx) => {
        const options = q.answer_options?.length ? q.answer_options : ['Yes', 'No'];
        return (
          <div key={q.id} className="flex flex-wrap items-center gap-1.5">
            <span className="text-xs text-muted-foreground tabular-nums w-4 shrink-0">{idx + 1}.</span>
            {options.map(option => (
              <button
                key={option}
                onClick={() => setAnswers(prev => ({ ...prev, [q.id]: option }))}
                className={`px-2.5 py-1 text-xs transition-colors ${
                  answers[q.id] === option
                    ? 'bg-primary text-primary-foreground'
                    : 'text-muted-foreground border border-border hover:text-foreground hover:bg-muted/50'
                }`}
              >
                {option}
              </button>
            ))}
          </div>
        );
      })}

      {/* Actions — minimal, inline */}
      <div className="flex items-center gap-3 pt-1">
        <button
          onClick={handleSubmit}
          disabled={!allAnswered}
          className={`text-xs font-medium transition-colors ${
            allAnswered
              ? 'text-primary hover:text-primary/80'
              : 'text-muted-foreground/40 cursor-not-allowed'
          }`}
        >
          {t('deepResearch.clarification.startResearch', 'Start Research')} →
        </button>
        <button
          onClick={onSkip}
          className="text-xs text-muted-foreground hover:text-foreground transition-colors"
        >
          {t('deepResearch.clarification.skip', 'Skip')}
        </button>
      </div>
    </div>
  );
}

/** Follow-up question suggestions from @-mentioned document summaries. */
function InlineSuggestions({
  questions,
  onSelect,
}: {
  questions: string[];
  onSelect: (question: string) => void;
}) {
  const { t } = useTranslation();
  const [dismissed, setDismissed] = useState(false);

  if (dismissed || questions.length === 0) return null;

  return (
    <div className="md:ml-8 mt-3 space-y-2">
      <div className="flex items-center gap-2">
        <span className="text-xs text-muted-foreground">
          {t('chat.suggestions.title', 'Explore further')}:
        </span>
        <button
          onClick={() => setDismissed(true)}
          className="text-xs text-muted-foreground/50 hover:text-muted-foreground transition-colors ml-auto"
        >
          ×
        </button>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {questions.map((q, i) => (
          <button
            key={i}
            onClick={() => onSelect(q)}
            className="px-2.5 py-1.5 text-xs text-left border border-border text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors"
          >
            {q}
          </button>
        ))}
      </div>
    </div>
  );
}

const ChatMessageComponent = ({
  message,
  isUser: isUserProp = false,
  isStreaming: isStreamingProp = false,
  isLatest,
  modelIconSrc,
  isThinking: isThinkingProp = false,
  thinkingContent: thinkingContentProp = '',
  modelInsightContent: modelInsightContentProp = '',
  thinkingTimeMs: initialThinkingTimeMs = 0,
  onEditMessage,
  onSaveEdit,
  onCancelEdit,
  onRepeatMessage,
  onDeleteMessage,
  onContinueGeneration,
  onRegenerateResponse,
  isEditing = false,
  codeTheme = 'GitHub',
  fontSize = 14,
  statusMessage = null,
  stageHistory = [],
  researchProgress,
  researchPlanId,
  onViewResearch,
  onOpenRagTrace,
  hasRagTrace,
  researchReportData,
  onViewFullReport,
  clarificationData,
  onSubmitClarification,
  onSkipClarification,
  planPreviewData,
  onApprovePlan: _onApprovePlan,
  onRegeneratePlan: _onRegeneratePlan,
  researchSetupData,
  onStartResearch,
  onSkipResearch,
  followUpSuggestions,
  onSuggestionClick,
  onFeedback,
}: ChatMessageProps) => {
  const { t, i18n } = useTranslation();
  const simpleMode = useSimpleMode();
  const isUser = message.role === 'user' || isUserProp;
  // Normalise: backend (Kotlin) returns persisted citation data under `metadata`,
  // streaming hook writes under `message_metadata`. Treat them as one bag so
  // every consumer in this component sees the union.
  if (message && !message.message_metadata && message.metadata) {
    message = { ...message, message_metadata: message.metadata };
  }
  // toast is now imported directly
  const { theme } = useTheme();
  const notesDrawer = useNotesDrawer();
  const { user } = useAuth();
  const { dispatch: pdfDispatch } = usePDFViewer();
  const { dispatch: epubDispatch } = useEpubViewer();
  const { dispatch: docxDispatch } = useDocxViewer();
  const openMentionInViewer = useOpenCitationInViewer();

  // State for tracking the edited content
  const [editedContent, setEditedContent] = React.useState<string>('');

  // TTS playback state
  const [isTTSPlaying, setIsTTSPlaying] = React.useState(false);
  const [isTTSLoading, setIsTTSLoading] = React.useState(false);
  const ttsAudioRef = useRef<HTMLAudioElement | null>(null);
  // Monotonic token: bumped on every stop/start so in-flight chunk synthesis
  // and queued playback from a previous press are cancelled (cross-language /
  // long answers prefetch ahead, and we must not resume after the user stops).
  const ttsSessionRef = useRef(0);

  // Feedback state (optimistic local update)
  const [localFeedback, setLocalFeedback] = useState<number | null>(
    typeof message.feedback === 'number' ? message.feedback : null
  );

  // Store panel states in refs to preserve across re-renders
  // These refs are initialized once and persist across all re-renders
  const citationsOpenRef = useRef<boolean>(false);
  // Open while streaming (the message mounts during generation), collapsed when
  // a session is reopened from history (mounts with streaming/thinking off).
  const thinkingOpenRef = useRef<boolean>(isStreamingProp || isThinkingProp);
  const modelInsightOpenRef = useRef<boolean>(isStreamingProp || isThinkingProp);
  const prevMessageIdRef = useRef<string>(message.id);

  // Check if message has citations on initial render
  const hasInitialCitations = !isUserProp && message.message_metadata && (
    (Array.isArray(message.message_metadata.citations) && message.message_metadata.citations.length > 0) ||
    (message.message_metadata.citation_metadata?.citations && Array.isArray(message.message_metadata.citation_metadata.citations) && message.message_metadata.citation_metadata.citations.length > 0)
  );

  // Create reducer with lazy initializer that reads from refs
  const [state, dispatch] = useReducer(messageReducer, null, () => ({
    regularContent: '',
    thinkingContent: '',
    isThinking: isThinkingProp,
    thinkingTimeMs: initialThinkingTimeMs,
    thinkingOpen: thinkingOpenRef.current, // Read from ref
    modelInsightOpen: modelInsightOpenRef.current, // Read from ref
    hasCitations: hasInitialCitations || false,
    showMoreTools: false,
    isCitationsOpen: citationsOpenRef.current, // Read from ref
    isHovering: false,
  }));

  // Sync refs with state after every render (before paint)
  // This ensures refs always reflect the current state
  React.useLayoutEffect(() => {
    citationsOpenRef.current = state.isCitationsOpen;
    thinkingOpenRef.current = state.thinkingOpen;
    modelInsightOpenRef.current = state.modelInsightOpen;
  });

  // Reset hasCitations when message ID changes (e.g., after backend refresh)
  useEffect(() => {
    if (message.id !== prevMessageIdRef.current) {
      prevMessageIdRef.current = message.id;

      // Re-check for citations when message changes - check ALL possible structures
      if (!isUser && message.message_metadata) {
        let hasActualCitations = false;

        // Check direct citations array
        if (Array.isArray(message.message_metadata.citations) && message.message_metadata.citations.length > 0) {
          hasActualCitations = true;
        }

        // Check nested citation_metadata.citations
        if (!hasActualCitations && message.message_metadata.citation_metadata?.citations &&
          Array.isArray(message.message_metadata.citation_metadata.citations) &&
          message.message_metadata.citation_metadata.citations.length > 0) {
          hasActualCitations = true;
        }

        // Check any other keys that might contain citation arrays
        if (!hasActualCitations) {
          const citationKeys = Object.keys(message.message_metadata).filter(key =>
            key.toLowerCase().includes('citation') || key.toLowerCase().includes('source')
          );
          for (const key of citationKeys) {
            const value = message.message_metadata[key];
            if (Array.isArray(value) && value.length > 0) {
              hasActualCitations = true;
              break;
            }
          }
        }

        if (hasActualCitations) {
          console.log('Citations found on message ID change:', message.id, message.message_metadata);
          dispatch({ type: 'SET_HAS_CITATIONS', payload: true });
        } else {
          console.log('⚠️ No citations found on message ID change:', message.id, message.message_metadata);
        }
      }
    }

    if (!isUser && message.content) {
      dispatch({ type: 'PROCESS_MESSAGE_CONTENT', payload: message.content });
    }
  }, [isUser, message.id, message.content, message.message_metadata]);

  // Update thinking state from props
  useEffect(() => {
    // Update thinking content whenever it changes, regardless of isThinking status
    // This ensures content persists even after streaming ends
    // Always update, even if empty, to clear old content on repeat
    dispatch({ type: 'SET_THINKING_CONTENT', payload: thinkingContentProp || '' });

    if (initialThinkingTimeMs > 0) {
      dispatch({
        type: 'UPDATE_THINKING_TIME',
        payload: initialThinkingTimeMs,
      });
    }
  }, [isThinkingProp, thinkingContentProp, initialThinkingTimeMs]);

  // Check for citations - only show if there are actual citations in metadata
  useEffect(() => {
    if (!isUser) {
      // Check for actual citations in metadata (multiple possible structures)
      let hasActualCitations = false;

      // Structure 1: Direct citations array
      if (
        message.message_metadata?.citations &&
        Array.isArray(message.message_metadata.citations) &&
        message.message_metadata.citations.length > 0
      ) {
        hasActualCitations = true;
      }
      // Structure 2: Citations nested in citation_metadata
      else if (
        message.message_metadata?.citation_metadata?.citations &&
        Array.isArray(message.message_metadata.citation_metadata.citations) &&
        message.message_metadata.citation_metadata.citations.length > 0
      ) {
        hasActualCitations = true;
      }
      // Structure 3: Check for citation-like keys in metadata
      else if (
        message.message_metadata &&
        typeof message.message_metadata === 'object'
      ) {
        const keys = Object.keys(message.message_metadata);
        const citationKeys = keys.filter(
          key =>
            key.toLowerCase().includes('citation') ||
            key.toLowerCase().includes('source')
        );
        for (const key of citationKeys) {
          const value = message.message_metadata[key];
          if (Array.isArray(value) && value.length > 0) {
            hasActualCitations = true;
            break;
          }
        }
      }

      // Always update hasCitations based on current message_metadata
      // But once set to true, keep it true to prevent disappearing
      if (hasActualCitations) {
        dispatch({ type: 'SET_HAS_CITATIONS', payload: true });
      }
    }
  }, [isUser, message.message_metadata]);

  // Set edited content when editing starts
  useEffect(() => {
    if (isEditing) {
      setEditedContent(message.content);
    }
  }, [isEditing, message.content]);

  // Custom code block renderer
  const CodeBlock = ({ children, className }: CodeProps) => {
    // Function to get the appropriate syntax theme based on settings
    // Each code theme has a light and dark variant to ensure readability
    const getSyntaxTheme = () => {
      const isDark = theme === 'dark';
      const key = (codeTheme || '').toLowerCase();

      switch (key) {
        case 'github':
          return isDark ? customGithubDark : customGithubLight;
        case 'monokai':
          return isDark ? customVscDarkPlus : customOneLight;
        case 'dracula':
          return isDark ? customDracula : customDracula; // Dracula is always dark-themed
        case 'light':
          return isDark ? customOneDark : customOneLight;
        case 'dark':
          return isDark ? customOneDark : customOneLight;
        default:
          return isDark ? customOneDark : customOneLight;
      }
    };

    const syntaxTheme = getSyntaxTheme();
    const match = className?.match(/language-(\w+)/);
    const lang = match ? match[1] : 'javascript';

    const copyToClipboard = () => {
      if (typeof children === 'string') {
        void navigator.clipboard.writeText(children);
        toast({
          description: t('general.codeCopied'),
        });
      }
    };

    return (
      <div className='relative w-full my-4 overflow-hidden border border-zinc-300 dark:border-zinc-700'>
        <div className='flex items-center justify-between px-4 py-2 bg-zinc-300 dark:bg-zinc-900'>
          <div className='text-xs text-black dark:text-white font-mono'>
            {lang}
          </div>
          <Button
            data-testid="chat-code-copy-button"
            onClick={copyToClipboard}
            variant='ghost'
            size='icon'
            className='h-8 w-8 text-black dark:text-white'
          >
            <Copy className='h-4 w-4' />
          </Button>
        </div>
        <div className='p-4 overflow-auto'>
          {typeof children === 'string' && (
            <SyntaxHighlighter
              language={lang}
              style={syntaxTheme}
              customStyle={{
                background: 'transparent',
                margin: 0,
                padding: 0,
                fontSize: `${fontSize}px`,
                lineHeight: 1.5,
              }}
              codeTagProps={{
                style: {
                  background: 'transparent',
                },
              }}
              wrapLines={true}
              lineProps={() => ({
                style: {
                  backgroundColor: 'transparent',
                  backgroundImage: 'none',
                },
              })}
            >
              {children}
            </SyntaxHighlighter>
          )}
        </div>
      </div>
    );
  };

  // Action handlers
  const handleEdit = () => {
    if (isUser && onEditMessage) {
      onEditMessage(message.id, message.content);
    } else {
      // Fallback if prop not provided
      void navigator.clipboard.writeText(message.content);
      toast({
        title: t('chat.actions.readyToEdit'),
        description: t('chat.actions.messageCopiedEditPrompt'),
      });
    }
  };

  const handleCopy = () => {
    void navigator.clipboard.writeText(message.content);
    toast({
      title: t('general.copied'),
      description: t('chat.actions.messageCopied'),
    });
  };

  // TTS play/stop handler. Chunked + prefetched: playback starts after the
  // first sentence synthesizes (~1.5s) instead of waiting for the whole answer
  // to render (a 1000-char answer is ~5.7s of synthesis; longer ones 10s+).
  // Synthesis runs ~12x faster than realtime, so prefetching the next chunks
  // while the current one plays keeps audio gapless.
  const handleTTSToggle = async () => {
    // Toggle off: invalidate the session so any in-flight synthesis / queued
    // playback from this press is cancelled, then stop the current audio.
    if (isTTSPlaying || isTTSLoading) {
      ttsSessionRef.current += 1;
      if (ttsAudioRef.current) {
        ttsAudioRef.current.pause();
        ttsAudioRef.current = null;
      }
      setIsTTSPlaying(false);
      setIsTTSLoading(false);
      return;
    }

    // Read ONLY the answer body — never the "Uvid modela" (model insight)
    // block. The insight lives in modelInsightContentProp and renders in its
    // own section; if a reloaded message ever carries it inside the answer
    // content, strip it so TTS doesn't read it aloud.
    let ttsSource = state.regularContent;
    if (modelInsightContentProp && ttsSource.includes(modelInsightContentProp)) {
      ttsSource = ttsSource.split(modelInsightContentProp).join('').trimEnd();
    }

    // Strip markdown for clean TTS text
    const plainText = ttsSource
      .replace(/```[\s\S]*?```/g, '') // Remove code blocks
      .replace(/`[^`]*`/g, '') // Remove inline code
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1') // Links → text
      .replace(/[#*_~>|]/g, '') // Remove markdown chars
      .replace(/\n{2,}/g, '. ') // Paragraphs → sentence breaks
      .replace(/\n/g, ' ') // Newlines → spaces
      .trim();

    if (!plainText) return;

    const langCode = (i18n.language || 'en').split('-')[0];
    const voice = LANGUAGE_VOICE_MAP[langCode] || LANGUAGE_VOICE_MAP['en'];

    // Small first chunk (one sentence) for the fastest possible start, then
    // larger chunks for the remainder to keep the number of requests low.
    const sentences = plainText.match(/[^.!?]+[.!?]+\s*/g) || [plainText];
    const firstChunk = (sentences[0] || plainText).trim();
    const rest = plainText.slice(firstChunk.length).trim();
    const chunks = [firstChunk, ...(rest ? splitTextForTTS(rest, 800) : [])].filter(Boolean);

    const session = ++ttsSessionRef.current;
    const cancelled = () => ttsSessionRef.current !== session;

    // Prefetch pipeline: each slot holds a promise resolving to an object URL.
    const urls: (Promise<string> | null)[] = new Array(chunks.length).fill(null);
    const synthChunk = async (txt: string): Promise<string> => {
      const r = await synthesizeSpeech(txt, voice);
      return URL.createObjectURL(base64ToAudioBlob(r.audio));
    };
    const prefetch = (i: number) => {
      if (i >= 0 && i < chunks.length && !urls[i]) urls[i] = synthChunk(chunks[i]);
    };

    setIsTTSLoading(true);
    try {
      prefetch(0);
      prefetch(1);

      const playFrom = async (idx: number): Promise<void> => {
        if (cancelled()) return;
        if (idx >= chunks.length) {
          setIsTTSPlaying(false);
          ttsAudioRef.current = null;
          return;
        }
        prefetch(idx);
        let url: string;
        try {
          url = await (urls[idx] as Promise<string>);
        } catch {
          if (!cancelled()) {
            setIsTTSPlaying(false);
            setIsTTSLoading(false);
            toast({
              title: t('general.error'),
              description: t('chat.actions.ttsError', 'Failed to synthesize speech'),
              variant: 'destructive',
            });
          }
          return;
        }
        if (cancelled()) {
          URL.revokeObjectURL(url);
          return;
        }

        // Keep the pipeline one chunk ahead of playback.
        prefetch(idx + 1);

        const audio = new Audio(url);
        ttsAudioRef.current = audio;
        audio.onended = () => {
          URL.revokeObjectURL(url);
          void playFrom(idx + 1);
        };
        audio.onerror = () => {
          URL.revokeObjectURL(url);
          if (!cancelled()) {
            setIsTTSPlaying(false);
            ttsAudioRef.current = null;
          }
        };
        await audio.play();
        if (idx === 0) {
          setIsTTSLoading(false);
          setIsTTSPlaying(true);
        }
      };

      await playFrom(0);
    } catch (error) {
      console.error('TTS error:', error);
      if (!cancelled()) {
        setIsTTSPlaying(false);
        toast({
          title: t('general.error'),
          description: t('chat.actions.ttsError', 'Failed to synthesize speech'),
          variant: 'destructive',
        });
      }
    } finally {
      if (!cancelled()) setIsTTSLoading(false);
    }
  };

  // Cleanup TTS audio on unmount
  React.useEffect(() => {
    return () => {
      ttsSessionRef.current += 1; // cancel any in-flight chunk prefetch/playback
      if (ttsAudioRef.current) {
        ttsAudioRef.current.pause();
        ttsAudioRef.current = null;
      }
    };
  }, []);

  const handleRepeat = () => {
    if (isUser && onRepeatMessage) {
      onRepeatMessage(message.id, message.content);
      // No toast needed - the message will be sent immediately
    } else {
      // Fallback if prop not provided
      void navigator.clipboard.writeText(message.content);
      toast({
        title: t('chat.actions.readyToRepeat'),
        description: t('chat.actions.messageCopiedRepeatPrompt'),
      });
    }
  };

  const handleMore = () => {
    dispatch({ type: 'TOGGLE_MORE_TOOLS' });
  };

  const handleForward = async () => {
    const shareText = `${message.content}\n\n— ${formatDate(message.timestamp)}`;
    if (navigator.share) {
      try {
        await navigator.share({ text: shareText });
      } catch {
        // User cancelled or share failed - fall back to clipboard
        void navigator.clipboard.writeText(shareText);
        toast({
          title: t('chat.actions.messageCopiedFormatted'),
        });
      }
    } else {
      void navigator.clipboard.writeText(shareText);
      toast({
        title: t('chat.actions.messageCopiedFormatted'),
      });
    }
  };

  const handleDelete = () => {
    if (onDeleteMessage) {
      onDeleteMessage(message.id);
    }
  };

  const handleFeedback = (value: number) => {
    const newFeedback = localFeedback === value ? null : value;
    setLocalFeedback(newFeedback);
    onFeedback?.(message.id, newFeedback);
  };

  // Render thinking content panel
  const renderThinking = () => {
    // Always show thinking content if it exists, even if isThinking is false
    // This prevents the content from disappearing when section_end is received
    if (!state.thinkingContent) return null;

    // Format time display
    const formatThinkingTime = () => {
      if (state.thinkingTimeMs <= 0) return 'Calculating...';

      const totalSeconds = state.thinkingTimeMs / 1000;
      const minutes = Math.floor(totalSeconds / 60);
      const seconds = (totalSeconds % 60).toFixed(2);

      if (minutes > 0) {
        return `${minutes}m ${seconds}s`;
      } else {
        return `${seconds}s`;
      }
    };

    // Determine if we're actively streaming thinking content
    const isActiveThinking = isThinkingProp && isStreamingProp;

    return (
      <div className='mt-3 md:mt-2 mb-3 md:mb-2 text-left'>
        <button
          data-testid="chat-thinking-toggle"
          type='button'
          onClick={() => {
            dispatch({ type: 'TOGGLE_THINKING_PANEL' });
          }}
          className='w-full flex items-center gap-2 py-1 text-xs text-zinc-800 hover:text-zinc-950 dark:text-zinc-400 dark:hover:text-zinc-300 focus:outline-none transition-colors text-left'
          aria-expanded={state.thinkingOpen}
        >
          <ChevronRight className={cn('h-3.5 w-3.5 transition-transform', state.thinkingOpen && 'rotate-90')} aria-hidden />
          <Brain className='h-3.5 w-3.5' aria-hidden />
          <span className='font-medium'>{t('chat.thinking.title')}</span>
          {isActiveThinking && (
            <span className='ml-2 relative flex h-2 w-2'>
              <span className='animate-ping absolute inline-flex h-full w-full rounded-full bg-amber-400 opacity-75'></span>
              <span className='relative inline-flex rounded-full h-2 w-2 bg-amber-500'></span>
            </span>
          )}
          <span className='ml-auto flex items-center text-[10px] text-zinc-500 dark:text-zinc-400'>
            <Clock className='h-3 w-3 mr-1' />
            {formatThinkingTime()}
          </span>
        </button>

        {state.thinkingOpen && (
          <div
            className='mt-2 text-zinc-700 dark:text-zinc-300 prose dark:prose-invert max-w-none text-left'
            style={{ fontSize: `${fontSize}px` }}
          >
            <ReactMarkdown remarkPlugins={[remarkGfm]} urlTransform={mdUrlTransform}>
              {state.thinkingContent || ''}
            </ReactMarkdown>
          </div>
        )}
      </div>
    );
  };

  // The model's own-knowledge reflection on the sourced answer — a distinct
  // block rendered below the answer (the thinking/chain-of-thought lives in the
  // collapsible panel above; this is the user-facing "model insight").
  const renderModelInsight = () => {
    if (!modelInsightContentProp) return null;
    return (
      <div className='mt-2 mb-2 text-left'>
        <button
          type='button'
          data-testid="chat-model-insight-toggle"
          onClick={() => dispatch({ type: 'TOGGLE_MODEL_INSIGHT_PANEL' })}
          className='w-full flex items-center gap-2 py-1 text-xs font-medium text-amber-600 hover:text-amber-700 dark:text-amber-300 dark:hover:text-amber-200 focus:outline-none transition-colors text-left'
          aria-expanded={state.modelInsightOpen}
        >
          <ChevronRight className={cn('h-3.5 w-3.5 transition-transform', state.modelInsightOpen && 'rotate-90')} aria-hidden />
          <Lightbulb className='h-3.5 w-3.5' aria-hidden />
          <span>{t('chat.modelInsight.title')}</span>
        </button>
        {state.modelInsightOpen && (
          <div
            className='mt-2 text-zinc-700 dark:text-zinc-300 prose dark:prose-invert max-w-none text-left'
            style={{ fontSize: `${fontSize}px` }}
          >
            <ReactMarkdown remarkPlugins={[remarkGfm]} urlTransform={mdUrlTransform}>
              {modelInsightContentProp || ''}
            </ReactMarkdown>
          </div>
        )}
      </div>
    );
  };

  // Use the derived displayContent for rendering. Strip any trailing
  // "References / Sources / Bibliography" block the LLM may still slip in
  // despite prompt rules — the UI already renders citations in a dedicated
  // section below the message, so duplicating them inline (often with fake
  // "[Various Sources]" rows) is redundant. Mirrors the regex in
  // ChatService.kt#stripTrailingReferences so the live stream and reloaded
  // message look identical.
  const displayContent = useMemo(() => {
    const raw = state.regularContent || message.content || '';
    if (!raw) return raw;
    // Backend status codes persisted as the entire message content: translate
    // them via i18n so localized error/status copy appears instead of the raw
    // English code (e.g. ChatService writes 'streamingError' on stream failure).
    const trimmed = raw.trim();
    const KNOWN_STATUS_CODES = new Set([
      'streamingError',
      'researchCancelled',
      'clarificationPending',
      'researchPlanReady',
      'documentQaNotIndexed',
      'noContextFound',
    ]);
    if (KNOWN_STATUS_CODES.has(trimmed)) {
      return t(`chat.status.${trimmed}`, { defaultValue: trimmed });
    }
    // Also consume any markdown horizontal rule (---, ***, ___) that the LLM
    // places BEFORE the References heading as a visual separator. Without this,
    // stripping the heading leaves behind a dangling <hr> at the bottom of the
    // bubble.
    const trailingRefs = /\n+\s*(?:[-*_]{3,}\s*\n+\s*)?(?:#{1,6}\s*)?(?:\*\*)?\s*(?:References?|Sources?|Bibliography|Works\s+Cited|Citations|Referencije|Izvori|Referenser|Referencias|Bibliographie|参考文献|참고문헌)\s*[:：]?\s*(?:\*\*)?\s*\n[\s\S]*$/i;
    // Separate pass: strip a BARE trailing horizontal rule (no heading after).
    // The LLM sometimes obeys the "no References section" rule but still leaves
    // a lone `---` as visual bottom-of-answer separator — renders as a stray
    // <hr> the moment the Citati section already provides its own divider.
    const trailingHr = /\n+\s*[-*_]{3,}\s*$/;
    const stripped = raw.replace(trailingRefs, '').replace(trailingHr, '').trimEnd();
    // Safety: if we cut more than 90% of the message, the regex matched too
    // greedily — return the original to avoid showing an empty bubble.
    return stripped.length < raw.length * 0.1 ? raw : stripped;
  }, [state.regularContent, message.content, t]);

  return (
    <div
      data-testid="chat-message"
      data-role={isUser ? 'user' : 'assistant'}
      className={`px-3 md:px-4 py-4 flex flex-col animate-slide-in transition-colors min-h-[130px] ${isUser
        ? 'bg-secondary/25 dark:bg-zinc-950'
        : 'bg-card dark:bg-transparent'
        }`}
      onMouseEnter={() => dispatch({ type: 'SET_HOVERING', payload: true })}
      onMouseLeave={() => dispatch({ type: 'SET_HOVERING', payload: false })}
    >
      <div className='flex items-center justify-between gap-2 mb-1'>
        <div className='flex items-center gap-2 min-w-0'>
          {isUser ? (
            <Avatar className='h-6 w-6 shrink-0'>
              <AvatarImage {...profilePicSources(user?.profile_picture)} alt='User' />
              <AvatarFallback className='text-foreground bg-zinc-200 dark:bg-zinc-800'>
                <User className='h-3 w-3' />
              </AvatarFallback>
            </Avatar>
          ) : (
            <AvatarWithStatus
              src={modelIconSrc}
              alt='AI'
              size='xxs'
              status={isLatest && isUser ? 'typing' : 'none'}
            />
          )}
          <h3 className='font-semibold text-xs md:text-sm truncate'>
            {isUser ? t('chat.you') : t('chat.aiAssistant')}
          </h3>
        </div>
        <span className='text-[10px] text-muted-foreground/50 shrink-0'>
          {formatDate(message.timestamp)}
        </span>
      </div>

      <div className='space-y-1 md:space-y-2 overflow-hidden flex flex-col relative md:ml-8'>

          {/* Thinking Panel (only for AI messages with thinking content) */}
          {!isUser && renderThinking()}

          {/* Mention chips — above user message */}
          {isUser && message.message_metadata?.mentions && message.message_metadata.mentions.length > 0 && (
            <div className='flex flex-wrap gap-1.5 mb-1'>
              {message.message_metadata.mentions.map((m: { type: string; id: string; name: string; collectionName?: string }) => {
                const isDocument = m.type === 'document';
                const colorClasses = isDocument
                  ? 'bg-blue-50 dark:bg-blue-900/30 border-blue-300 dark:border-blue-700/50 text-blue-700 dark:text-blue-300'
                  : 'bg-primary/10 dark:bg-primary/15 border-primary/30 text-primary dark:text-primary/90';

                if (isDocument) {
                  return (
                    <MentionDocumentChip
                      key={`${m.type}-${m.id}`}
                      id={m.id}
                      name={m.name}
                      colorClasses={colorClasses}
                      missingTitle={t(
                        'smartCitations.fileMissing.description',
                        'The source file for this citation is no longer on disk and cannot be opened.'
                      )}
                      openTitle={t('chat.mentions.openDocument', { name: m.name, defaultValue: `Otvori ${m.name}` })}
                      onOpen={() => {
                        void openMentionInViewer({
                          document_id: m.id,
                          document_title: m.name,
                          title: m.name,
                        });
                      }}
                    />
                  );
                }

                return (
                  <span
                    key={`${m.type}-${m.id}`}
                    className={cn('inline-flex items-center gap-1 px-2 py-0.5 text-[11px] font-medium border', colorClasses)}
                    title={m.name}
                  >
                    <BookOpen className='h-3 w-3 flex-shrink-0' />
                    <span className='truncate max-w-[200px]'>{m.name}</span>
                  </span>
                );
              })}
            </div>
          )}

          {/* Main Content Area */}
          <div className='prose dark:prose-invert prose-p:leading-relaxed prose-pre:p-0 break-words'>
            {isEditing && isUser ? (
              <div className='flex flex-col gap-2'>
                <Textarea
                  data-testid="chat-message-edit-textarea"
                  value={editedContent}
                  onChange={e => setEditedContent(e.target.value)}
                  className='min-h-[100px] w-full resize-none p-2 text-sm border border-zinc-200 dark:border-zinc-800'
                  placeholder={t('chat.editMessagePlaceholder')}
                  autoFocus
                />
                <div className='flex gap-2 justify-end'>
                  <Button data-testid="chat-message-edit-cancel" size='sm' variant='outline' onClick={onCancelEdit}>
                    {t('general.cancel')}
                  </Button>
                  <Button
                    data-testid="chat-message-edit-save"
                    size='sm'
                    onClick={() => onSaveEdit?.(message.id, editedContent)}
                  >
                    {t('general.save')}
                  </Button>
                </div>
              </div>
            ) : isUser ? (
              <div className='relative flex-grow'>
                <div
                  className='prose dark:prose-invert max-w-none text-foreground markdown text-left leading-loose'
                  style={{ fontSize: `${fontSize}px` }}
                >
                  <span dangerouslySetInnerHTML={{ __html: displayContent }} />
                </div>
              </div>
            ) : (
              <div
                className='prose dark:prose-invert max-w-none text-left leading-loose'
                style={{ fontSize: `${fontSize}px` }}
              >
                {/* Processing status indicator — suppressed while the message is
                    awaiting user input (research setup, plan preview, clarification).
                    In those phases nothing is actively running, so a spinning
                    "Starting deep research…" indicator is misleading. */}
                {isStreamingProp && (statusMessage?.content || !displayContent)
                  && !researchSetupData && !planPreviewData && !clarificationData && (
                  <ChatProcessingIndicator
                    statusMessage={statusMessage}
                    stageHistory={stageHistory}
                    isVisible={true}
                    isWaiting={!statusMessage?.content && !displayContent}
                  />
                )}

                {/* Streaming/static content */}
                {!(isStreamingProp && !statusMessage?.content && !displayContent) && (
                  <ReactMarkdown
                    remarkPlugins={[remarkGfm]}
                    urlTransform={mdUrlTransform}
                    components={{
                      code: ({ className, children, ...props }: CodeProps) => {
                        // Only create code blocks for content with explicit language className (from triple backticks)
                        const isCodeBlock = className?.startsWith('language-');

                        // If this is a large block of text without a language class, treat it as regular text
                        const childrenStr = String(children);
                        const isLargeContent =
                          childrenStr.length > 100 ||
                          childrenStr.includes('\n\n');

                        if (typeof children === 'string' && isCodeBlock) {
                          return (
                            <CodeBlock className={className}>
                              {String(children).replace(/\n$/, '')}
                            </CodeBlock>
                          );
                        }

                        // If it's large content without language class, render as plain text (let parent handle markdown)
                        if (isLargeContent && !isCodeBlock) {
                          return (
                            <div className='whitespace-pre-wrap'>{children}</div>
                          );
                        }

                        return (
                          <code
                            className='px-1.5 py-0.5 rounded text-sm font-medium border border-zinc-300 dark:border-zinc-700'
                            {...props}
                          >
                            {children}
                          </code>
                        );
                      },
                      a: ({ href, children, ...props }) => {
                        if (href?.startsWith('#cite-')) {
                          // Smart Citations (Scite): stance-aware chip with Popover
                          // that works on both desktop hover and mobile tap.
                          const num = parseInt(href.slice(6), 10);
                          const meta = message.message_metadata || message.metadata || {};
                          const rawCitations =
                            (meta.citations as Array<import('@/hooks/use-open-citation-in-viewer').OpenableCitation & { stance?: 'supporting' | 'contrasting' | 'mentioning'; stance_confidence?: number; stance_rationale?: string; citation_context?: string }> | undefined) ||
                            (meta.citation_metadata?.citations as Array<import('@/hooks/use-open-citation-in-viewer').OpenableCitation & { stance?: 'supporting' | 'contrasting' | 'mentioning'; stance_confidence?: number; stance_rationale?: string; citation_context?: string }> | undefined) ||
                            [];
                          const cit = rawCitations.find(c => c.citation_num === num);
                          return (
                            <CitationStanceChip
                              num={num}
                              stance={cit?.stance}
                              stance_confidence={cit?.stance_confidence}
                              stance_rationale={cit?.stance_rationale}
                              document_title={cit?.document_title}
                              text={cit?.text}
                              citation_context={cit?.citation_context}
                              citation={cit}
                            >
                              {children}
                            </CitationStanceChip>
                          );
                        }
                        return (
                          <a
                            href={href}
                            target='_blank'
                            rel='noreferrer'
                            className='text-violet-600 hover:text-violet-700 dark:text-violet-400 dark:hover:text-violet-300 underline transition-colors'
                            {...props}
                          >
                            {children}
                          </a>
                        );
                      },
                      // Table components for proper markdown table rendering
                      table: ({ children, ...props }) => (
                        <div className='relative w-full overflow-auto my-6 rounded-lg bg-card shadow-sm'>
                          <table
                            className='w-full caption-bottom text-sm'
                            {...props}
                          >
                            {children}
                          </table>
                        </div>
                      ),
                      thead: ({ children, ...props }) => (
                        <thead className='[&_tr]:border-b' {...props}>
                          {children}
                        </thead>
                      ),
                      tbody: ({ children, ...props }) => (
                        <tbody className='[&_tr:last-child]:border-0' {...props}>
                          {children}
                        </tbody>
                      ),
                      tr: ({ children, ...props }) => (
                        <tr
                          className='border-b transition-colors hover:bg-muted/50'
                          {...props}
                        >
                          {children}
                        </tr>
                      ),
                      th: ({ children, ...props }) => (
                        <th
                          className='h-12 px-4 text-left align-middle font-medium text-muted-foreground whitespace-nowrap'
                          {...props}
                        >
                          {children}
                        </th>
                      ),
                      td: ({ children, ...props }) => (
                        <td
                          className='p-4 align-middle break-words first:whitespace-nowrap first:w-0'
                          {...props}
                        >
                          {children}
                        </td>
                      ),
                      // Create a smart paragraph component that checks if it contains block elements
                      p: ({ children, ...props }) => {
                        // Check if children contain block-level elements (div, pre, code blocks)
                        const hasBlockElements = React.Children.toArray(
                          children
                        ).some(child => {
                          // Check if it's a React element and if it's a block element
                          if (React.isValidElement(child)) {
                            // Check for direct block elements
                            if (
                              child.type === 'div' ||
                              child.type === 'pre' ||
                              child.type === CodeBlock
                            ) {
                              return true;
                            }
                            // Check for code elements with language classes (code blocks)
                            if (
                              child.type === 'code' &&
                              child.props?.className?.includes('language-')
                            ) {
                              return true;
                            }
                            // Check for nested elements that might contain code blocks
                            if (child.props?.children) {
                              const nestedChildren = React.Children.toArray(
                                child.props.children
                              );
                              return nestedChildren.some(
                                nestedChild =>
                                  React.isValidElement(nestedChild) &&
                                  (nestedChild.type === CodeBlock ||
                                    (nestedChild.type === 'code' &&
                                      nestedChild.props?.className?.includes(
                                        'language-'
                                      )))
                              );
                            }
                          }
                          return false;
                        });

                        // If it has block elements, render a div instead of p
                        return hasBlockElements ? (
                          <div {...props}>{children}</div>
                        ) : (
                          <p {...props}>{children}</p>
                        );
                      },
                    }}
                  >
                    {displayContent.replace(/^[ \t]+/gm, '').replace(/\[\[(\d+(?:,\s*\d+)*)\]\]/g, (_match, nums: string) => nums.split(',').map((n: string) => `[${n.trim()}](#cite-${n.trim()})`).join(''))}
                  </ReactMarkdown>
                )}
              </div>
            )}
          </div>

          {/* Model insight — the model's own-knowledge reflection, below the answer */}
          {!isUser && renderModelInsight()}
      </div>


      {/* Inline Research Progress - shown during active DEEP RESEARCH only.
          isResearching alone is not sufficient: the agentic-RAG flow can leave it
          true, which rendered a phantom "pending / Čekanje odgovora" progress bubble
          next to a finished agentic answer. Gate on signals that ONLY a genuine deep
          research run sets — an active/finished phase, a planning-progress payload, or
          plan-approval. (phases.length is always 7 from init, and researchSteps is also
          populated by agentic status packets, so neither is a usable discriminator.) */}
      {!isUser && researchProgress && researchProgress.isResearching &&
        (researchProgress.activePhaseId != null ||
          !!researchProgress.planningProgress ||
          (researchProgress.phases?.some(p => p.status === 'active' || p.status === 'completed') ?? false)) && (
        <div className='md:ml-8'>
          <InlineResearchProgress
            isResearching={researchProgress.isResearching}
            researchComplete={researchProgress.researchComplete}
            researchSteps={researchProgress.researchSteps}
            sources={researchProgress.sources}
            planningProgress={researchProgress.planningProgress}
            phases={researchProgress.phases}
            activePhaseId={researchProgress.activePhaseId}
            onOpenPanel={researchProgress.onOpenPanel}
            adaptiveStep={researchProgress.adaptiveStep}
            adaptiveMaxSteps={researchProgress.adaptiveMaxSteps}
            adaptiveComplexity={researchProgress.adaptiveComplexity}
            synthesisProgress={researchProgress.synthesisProgress}
          />
        </div>
      )}

      {/* Deep Research: Inline clarification options (blends into AI message) */}
      {!isUser && clarificationData && onSubmitClarification && onSkipClarification && (
        <InlineClarification
          questions={clarificationData.questions}
          requestId={clarificationData.requestId}
          onSubmit={onSubmitClarification}
          onSkip={onSkipClarification}
        />
      )}

      {/* Deep Research: Inline template setup (blends into AI message like clarification) */}
      {!isUser && researchSetupData && onStartResearch && onSkipResearch && (
        <InlineResearchSetup
          query={researchSetupData.query}
          pendingOptions={researchSetupData.options}
          onStart={onStartResearch}
          onSkip={onSkipResearch}
        />
      )}

      {/* Plan preview renders standalone in chat-messages.tsx, not here */}

      {/* Chart visualization from generate_chart tool */}
      {!isUser && (() => {
        const meta = (message.message_metadata || message.metadata) as Record<string, unknown> | undefined;
        const chartData = meta?.chart_data as Record<string, unknown> | undefined;
        if (!chartData) return null;
        return (
          <div className='md:ml-8'>
            <ChatChartRenderer packet={chartData as unknown as ChartDataPacket} />
          </div>
        );
      })()}

      {/* Follow-up suggestions from @-mentioned document */}
      {!isUser && followUpSuggestions && followUpSuggestions.length > 0 && onSuggestionClick && (
        <InlineSuggestions
          questions={followUpSuggestions}
          onSelect={onSuggestionClick}
        />
      )}

      {/* Deep Research v1: View Full Report button */}
      {!isUser && researchReportData && onViewFullReport && (
        <div className='md:ml-8 mt-3'>
          <button
            data-testid="view-full-report-button"
            onClick={onViewFullReport}
            className='flex items-center gap-2 text-sm text-primary hover:text-primary/80 transition-colors px-3 py-2 border border-border hover:bg-muted/50 w-full'
          >
            <FileText className='h-4 w-4' />
            <span>{t('deepResearch.report.viewFullReport', 'View Full Report')}</span>
            {typeof researchReportData.qualityScore === 'number' && (
              <span className='ml-auto text-xs text-muted-foreground'>
                {t('deepResearch.report.qualityScore', 'Quality')}: {(researchReportData.qualityScore * 10).toFixed(1)}/10
              </span>
            )}
          </button>
        </div>
      )}

      {/* Council deliberation — loaded from DB for completed deep research */}
      {!isUser && researchReportData?.planId && (
        <CouncilLoader planId={researchReportData.planId} />
      )}

      {/* Search Strategy transparency — collapsible panel above Citati */}
      {!isUser && (() => {
        const meta = message.message_metadata || message.metadata || {};
        const strategy = meta.search_strategy as SearchStrategyData | undefined;
        if (!strategy) return null;
        return (
          <div className='md:ml-8'>
            <SearchStrategyPanel strategy={strategy} />
          </div>
        );
      })()}

      {/* Citations section - only show for AI responses and if there are citations */}
      {!isUser && state.hasCitations && (
        <div data-testid='message-citations-section' className='md:ml-8'>
          <button
            data-testid='citations-toggle-button'
            onClick={() => {
              dispatch({ type: 'TOGGLE_CITATIONS' });
            }}
            className='w-full flex items-center gap-2 py-1 text-xs text-primary hover:text-primary/80 focus:outline-none transition-colors text-left'
          >
            <ChevronRight className={cn('h-3.5 w-3.5 transition-transform', state.isCitationsOpen && 'rotate-90')} aria-hidden />
            <Quote className='h-3.5 w-3.5' aria-hidden />
            <span className='font-medium'>{t('chat.citations.title')}</span>
          </button>

          {state.isCitationsOpen && (
            <div className='mt-2 space-y-1.5'>
              {/* Render citations from message metadata - handle multiple possible structures */}
              {(() => {
                // Debug: Log message metadata
                // Try different possible citation data structures
                let citations = null;

                // Structure 1: Direct citations array
                if (
                  message.message_metadata?.citations &&
                  Array.isArray(message.message_metadata.citations)
                ) {
                  citations = message.message_metadata.citations;
                }
                // Structure 2: Citations nested in another object
                else if (
                  message.message_metadata?.citation_metadata?.citations &&
                  Array.isArray(
                    message.message_metadata.citation_metadata.citations
                  )
                ) {
                  citations =
                    message.message_metadata.citation_metadata.citations;
                }
                // Structure 3: Citations as a direct property
                else if (
                  message.message_metadata &&
                  typeof message.message_metadata === 'object'
                ) {
                  // Check if message_metadata itself contains citation-like properties
                  const keys = Object.keys(message.message_metadata);
                  const citationKeys = keys.filter(
                    key =>
                      key.toLowerCase().includes('citation') ||
                      key.toLowerCase().includes('source')
                  );
                  if (citationKeys.length > 0) {
                    // Try to extract citations from any citation-related keys
                    for (const key of citationKeys) {
                      const value = message.message_metadata[key];
                      if (Array.isArray(value)) {
                        citations = value;
                        break;
                      }
                    }
                  }
                }

                return citations && citations.length > 0 ? (
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- citation shape varies between RAG strategies and web search
                  citations.map((citation: any, index: number) => {
                    // Smart Citations: stance colour lives on the number bubble
                    // only — no card border, no row tint. Keeps the list calm
                    // and lets the number bubble carry the stance signal.
                    const st = citation.stance as 'supporting' | 'contrasting' | 'mentioning' | undefined;
                    const bubbleClass =
                      st === 'supporting' ? 'bg-emerald-500 text-white'
                      : st === 'contrasting' ? 'bg-rose-500 text-white'
                      : st === 'mentioning' ? 'bg-amber-500 text-white'
                      : 'bg-primary/10 dark:bg-primary/20 text-primary';
                    return (
                    <div
                      key={citation.id || citation.citation_id || index}
                      data-testid={`citation-item-${index}`}
                      className='group flex items-start gap-1.5 py-1 hover:bg-accent-highlight transition-colors cursor-grab active:cursor-grabbing'
                      draggable
                      onDragStart={(e) => {
                        const citText = citation.text || citation.content || citation.excerpt || '';
                        const citTitle = citation.title || citation.document_title || citation.source || 'Document';
                        e.dataTransfer.setData('application/scrapalot-citation', JSON.stringify({
                          text: citText, title: citTitle,
                          page: citation.page ?? citation.page_number,
                          documentId: citation.document_id || citation.documentId || '',
                          authors: citation.authors || [], year: citation.year,
                        }));
                        e.dataTransfer.effectAllowed = 'copy';
                      }}
                    >
                      <div className={cn('flex-shrink-0 w-4 h-4 rounded-full flex items-center justify-center mt-0.5', bubbleClass)}>
                        <span className='text-[10px] font-semibold leading-none'>
                          {citation.id || citation.citation_id || index + 1}
                        </span>
                      </div>
                      {/* Insert into Note button — dispatches event for Notes editor */}
                      <button
                        data-testid={`citation-insert-note-${index}`}
                        title={t('chat.citations.insertIntoNote', 'Insert into Note')}
                        className='flex-shrink-0 mt-0.5 p-0.5 opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-primary transition-all'
                        onClick={(e) => {
                          e.stopPropagation();
                          const citationText = citation.text || citation.content || citation.excerpt || '';
                          const citationTitle = citation.title || citation.document_title || citation.source || 'Document';
                          const citationPage = citation.page ?? citation.page_number;
                          const docId = citation.document_id || citation.documentId || '';
                          const detail = {
                            text: citationText,
                            title: citationTitle,
                            page: citationPage,
                            documentId: docId,
                            authors: citation.authors || [],
                            year: citation.year,
                            doi: citation.doi,
                          };
                          // Listener lives inside the Notes editor; if the drawer isn't
                          // open, the event fires into nothing. Open it first, then emit
                          // after a short delay so TipTap has time to mount.
                          if (!notesDrawer.isOpen) {
                            notesDrawer.open(message.session_id);
                            setTimeout(() => {
                              window.dispatchEvent(new CustomEvent('insert-citation-into-note', { detail }));
                            }, 400);
                          } else {
                            window.dispatchEvent(new CustomEvent('insert-citation-into-note', { detail }));
                          }
                        }}
                      >
                        <NotebookPen className='h-3.5 w-3.5' />
                      </button>
                      {/* Save the AI answer as a margin note in the cited
                          document. Anchors to the cited page and uses the
                          chunk_position_json bbox when present. */}
                      {(() => {
                        const docIdForAnn = citation.document_id || citation.documentId || '';
                        const fileType = (citation.file_type || (citation.title || citation.document_title || '').match(/\.(epub|docx|pdf)$/i)?.[1] || 'pdf').toLowerCase();
                        // Bridge mode citations carry source_collection_id
                        // explicitly; everything else needs a document
                        // lookup at click time. Keep the row visible as
                        // long as we have a document_id and a viewer
                        // type the annotation backend can render.
                        if (!docIdForAnn || (fileType !== 'pdf' && fileType !== 'epub')) return null;
                        return (
                          <button
                            data-testid={`citation-save-margin-note-${index}`}
                            title={t('chat.citations.saveAsMarginNote', 'Save as margin note')}
                            className='flex-shrink-0 mt-0.5 p-0.5 opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-primary transition-all'
                            onClick={async (e) => {
                              e.stopPropagation();
                              const page = citation.page ?? citation.page_number ?? 1;
                              const pageIdx = Math.max(0, page - 1);
                              const aiAnswer = (message.content || '').trim();
                              const citedText = (citation.text || citation.content || citation.excerpt || '').trim();
                              const commentBody = aiAnswer.length > 1500
                                ? aiAnswer.slice(0, 1500) + '…'
                                : aiAnswer;

                              // Resolve collection_id: prefer the bridge-
                              // mode hint on the citation, fall back to a
                              // document lookup. createAnnotation requires
                              // the id, so this can't be skipped.
                              let collIdForAnn: string | undefined = citation.source_collection_id;
                              if (!collIdForAnn) {
                                try {
                                  const { getDocumentById } = await import('@/lib/api-documents');
                                  const doc = await getDocumentById(docIdForAnn);
                                  const c = doc?.collection_id;
                                  if (typeof c === 'string' && c.length > 0) collIdForAnn = c;
                                } catch (lookupErr) {
                                  console.warn('[MarginNote] document lookup failed:', lookupErr);
                                }
                              }
                              if (!collIdForAnn) {
                                toast({
                                  title: t('chat.citations.marginNoteFailed', 'Could not save margin note'),
                                  description: t('chat.citations.marginNoteNoCollection', 'Could not resolve collection for this citation.'),
                                  variant: 'destructive',
                                });
                                return;
                              }

                              // Build a position payload anchored to the
                              // cited page. We don't have rendered rects
                              // here, so we use a thin gutter-anchor rect
                              // near the top of the page; the user can
                              // re-position via the existing PDF flow.
                              const positionPayload = fileType === 'epub'
                                ? { type: 'epub', cfi: citation.chunk_position_json?.cfi || '', page_label: String(page) }
                                : {
                                    type: 'pdf',
                                    page_index: pageIdx,
                                    rects: [
                                      {
                                        left: 5,
                                        top: 4,
                                        width: 90,
                                        height: 3,
                                      },
                                    ],
                                  };

                              try {
                                await createAnnotation(docIdForAnn, {
                                  document_id: docIdForAnn,
                                  collection_id: collIdForAnn,
                                  session_id: message.session_id,
                                  annotation_type: 2, // note
                                  selected_text: citedText.slice(0, 500),
                                  comment: commentBody,
                                  color: '#3b82f6', // blue — semantic for AI-sourced
                                  page_label: String(page),
                                  position_json: JSON.stringify(positionPayload),
                                  viewer_type: fileType as 'pdf' | 'epub',
                                });
                                toast({
                                  title: t('chat.citations.marginNoteSaved.title', 'Saved as margin note'),
                                  description: t('chat.citations.marginNoteSaved.description', 'Open the document to see the gutter pin on page {{page}}.', { page }),
                                });
                              } catch (err) {
                                const detail = (err as { response?: { data?: { detail?: string } } }).response?.data?.detail;
                                toast({
                                  title: t('chat.citations.marginNoteFailed', 'Could not save margin note'),
                                  description: detail || (err as Error).message,
                                  variant: 'destructive',
                                });
                              }
                            }}
                          >
                            <BookmarkPlus className='h-3.5 w-3.5' />
                          </button>
                        );
                      })()}
                      <div className='flex-1 min-w-0'>
                        {(() => {
                          // Shared citation metadata
                          const externalUrl = [citation.url, citation.document_id, citation.documentId]
                            .find((v): v is string => !!v && /^https?:\/\//.test(v));
                          const isExternal = !!externalUrl;
                          const title = citation.title || citation.document_title || citation.source || 'Document';
                          const pageNum = citation.page ?? citation.page_number;
                          const docIdRaw = citation.document_id || citation.documentId;
                          // External URLs aren't stored on disk — skip the file-existence probe
                          const docId: string | undefined = isExternal ? undefined : (docIdRaw || undefined);
                          const citFileType = citation.file_type
                            || title.match(/\.(epub|docx|pdf)$/i)?.[1]?.toLowerCase()
                            || 'pdf';

                          const openInViewer = () => {
                            if (isExternal && externalUrl) {
                              window.open(externalUrl, '_blank', 'noopener,noreferrer');
                              return;
                            }

                            // Prefer document_id-based URL (works with gRPC architecture)
                            let docUrl: string | undefined;
                            if (docIdRaw) {
                              docUrl = `/documents/${docIdRaw}/file`;
                            } else if (citation.url) {
                              docUrl = citation.url;
                              if (docUrl.startsWith('/api/v1/')) {
                                docUrl = docUrl.substring(7);
                              }
                            } else {
                              console.warn('Citation has no valid URL or document_id:', citation);
                              return;
                            }

                            let documentIdForViewer = docIdRaw;
                            if (!documentIdForViewer && docUrl) {
                              const match = docUrl.match(/\/documents\/([^/]+)\/file/);
                              if (match && match[1]) documentIdForViewer = match[1];
                            }

                            // CitationLink disables the click for files that
                            // probed as 'missing', so reaching this branch
                            // implies the doc is openable — safe to record a
                            // 'cited' touch event for the sidebar Recent strip.
                            if (documentIdForViewer) {
                              const resolvedDocId = documentIdForViewer;
                              void (async () => {
                                try {
                                  const { recordDocumentView } = await import('@/lib/api-document-views');
                                  await recordDocumentView(
                                    resolvedDocId,
                                    'cited',
                                    citation.source_collection_id ?? null,
                                  );
                                } catch {
                                  // recordDocumentView already logs; nothing more to do here.
                                }
                              })();
                            }

                            const documentTitle = citation.title || citation.document_title || citation.source || '';
                            const citationId = citation.id || citation.citation_id || index;
                            // resolveFileType scans every plausible field
                            // (file_type, filename, title, document_title,
                            // source, url) with a word-boundary anchor so an
                            // extension anywhere in the string counts. The old
                            // /\.(epub|docx|pdf)$/i regex required the
                            // extension at the very end and defaulted to PDF
                            // when the backend stripped it — that opened the
                            // PDF viewer on EPUB books, which then 500'd on
                            // "Expected PDF but received application/epub+zip".
                            const fileType = resolveFileType(citation);

                            if (fileType === 'epub') {
                              epubDispatch({
                                type: 'OPEN_EPUB_VIEWER',
                                payload: { url: docUrl, documentId: documentIdForViewer, documentTitle, citationId },
                              });
                            } else if (fileType === 'docx') {
                              docxDispatch({
                                type: 'OPEN_DOCX_VIEWER',
                                payload: { url: docUrl, documentId: documentIdForViewer, documentTitle, citationId },
                              });
                            } else {
                              // PDF (default)
                              let topPercent: number;
                              let heightPercent: number;
                              if (citation.position_top_percent !== undefined &&
                                citation.position_bottom_percent !== undefined) {
                                topPercent = citation.position_top_percent;
                                heightPercent = citation.position_bottom_percent - topPercent;
                              } else {
                                const chunkIndex = citation.chunk_index || 0;
                                const pageTopMargin = 5;
                                const pageContentHeight = 90;
                                const estimatedChunksPerPage = 3;
                                const chunkPositionOnPage = chunkIndex % estimatedChunksPerPage;
                                const chunkHeightPercent = pageContentHeight / estimatedChunksPerPage;
                                topPercent = pageTopMargin + (chunkPositionOnPage * chunkHeightPercent) - 3;
                                heightPercent = chunkHeightPercent + 4;
                              }
                              const transientHighlight = citation.chunk_position_json
                                ? {
                                    page: citation.chunk_position_json.page ?? citation.page ?? citation.page_number ?? 1,
                                    charOffsetStart: citation.chunk_position_json.char_offset_start,
                                    charOffsetEnd: citation.chunk_position_json.char_offset_end,
                                    bbox: citation.chunk_position_json.bbox ?? undefined,
                                    ttlSeconds: 3,
                                    issuedAt: Date.now(),
                                  }
                                : undefined;
                              pdfDispatch({
                                type: 'OPEN_PDF_VIEWER',
                                payload: {
                                  url: docUrl,
                                  documentId: documentIdForViewer,
                                  documentTitle,
                                  page: citation.page ?? citation.page_number ?? 1,
                                  citationId,
                                  highlightText: citation.text || citation.content || citation.excerpt,
                                  highlightLineStart: topPercent,
                                  highlightLineEnd: topPercent + heightPercent,
                                  transientHighlight,
                                },
                              });
                            }
                          };

                          const missingTitle = t(
                            'smartCitations.fileMissing.description',
                            'The source file for this citation is no longer on disk and cannot be opened.'
                          );

                          return (
                            <CitationLink documentId={docId} missingTitle={missingTitle} onOpen={openInViewer}>
                              {(missing) => (
                                <>
                                  <div className={cn(
                                    'font-medium text-xs mb-0.5 line-clamp-1 flex items-center gap-1',
                                    missing ? 'text-muted-foreground line-through decoration-muted-foreground/50' : 'text-primary'
                                  )}>
                                    {missing
                                      ? <FileX className='h-3 w-3 flex-shrink-0' />
                                      : isExternal
                                        ? <ExternalLink className='h-3 w-3 flex-shrink-0' />
                                        : citFileType === 'epub'
                                          ? <BookOpen className='h-3 w-3 flex-shrink-0' />
                                          : citFileType === 'docx'
                                            ? <FileText className='h-3 w-3 flex-shrink-0' />
                                            : null}
                                    <span className='truncate'>{pageNum ? `[Page ${pageNum}] ${title}` : title}</span>
                                  </div>
                                  <div className='text-zinc-600 dark:text-zinc-400 text-xs leading-relaxed line-clamp-2'>
                                    {citation.text || citation.content || citation.excerpt || 'Citation content'}
                                  </div>
                                </>
                              )}
                            </CitationLink>
                          );
                        })()}
                      </div>
                    </div>
                  );
                })
                ) : null;
              })()}
            </div>
          )}
        </div>
      )}

      {/* Bridge Concepts panel — auto-renders only when at least
          one citation in this reply originated from a cross-domain bridge
          chunk. Hidden in the common case (bridge mode disabled or no
          distant collections selected). */}
      {!isUser && (() => {
        const meta = message.message_metadata || message.metadata || {};
        const citations =
          (Array.isArray(meta.citations) && meta.citations) ||
          (meta.citation_metadata?.citations &&
            Array.isArray(meta.citation_metadata.citations) &&
            meta.citation_metadata.citations) ||
          null;
        return citations ? (
          <BridgeConceptsPanel
            citations={citations as Parameters<typeof BridgeConceptsPanel>[0]['citations']}
          />
        ) : null;
      })()}

      {/* Action buttons - shown for both user and AI responses with consistent styling */}
      <div
        className='flex items-center mt-2 pt-2 space-x-1 md:ml-8'
      >
        {isUser ? (
          <>
            <button
              data-testid='message-edit-button'
              className={`h-5 w-5 flex items-center justify-center text-muted-foreground hover:text-foreground transition-colors ${state.showMoreTools ? 'text-foreground' : ''}`}
              title={t('chat.actions.editMessage')}
              onClick={handleEdit}
            >
              <Edit className='h-[14px] w-[14px]' />
            </button>
            <button
              data-testid='message-copy-button'
              className='h-5 w-5 flex items-center justify-center text-muted-foreground hover:text-foreground transition-colors'
              title={t('chat.actions.copyMessage')}
              onClick={handleCopy}
            >
              <CopyIcon className='h-[14px] w-[14px]' />
            </button>
            <button
              data-testid='message-repeat-button'
              className='h-5 w-5 flex items-center justify-center text-muted-foreground hover:text-foreground transition-colors'
              title={t('chat.actions.repeatMessage')}
              onClick={handleRepeat}
            >
              <RepeatIcon className='h-[14px] w-[14px]' />
            </button>

            {state.showMoreTools && (
              <>
                <PopoverMessageAnalysis
                  content={message.content}
                  trigger={
                    <button
                      data-testid='message-analyze-button'
                      className='h-5 w-5 flex items-center justify-center text-muted-foreground hover:text-foreground transition-colors'
                      title={t('chat.actions.analyzeMessage')}
                    >
                      <BarChart2 className='h-[14px] w-[14px]' />
                    </button>
                  }
                />
                <button
                  data-testid='message-forward-button'
                  className='h-5 w-5 flex items-center justify-center text-muted-foreground hover:text-foreground transition-colors'
                  title={t('chat.actions.forwardMessage')}
                  onClick={handleForward}
                >
                  <ArrowRight className='h-[14px] w-[14px]' />
                </button>
                <button
                  data-testid='message-delete-button'
                  className='h-5 w-5 flex items-center justify-center text-muted-foreground hover:text-red-500 transition-colors'
                  title={t('chat.actions.deleteMessage')}
                  onClick={handleDelete}
                >
                  <Trash2 className='h-[14px] w-[14px]' />
                </button>
              </>
            )}

            <button
              data-testid='message-more-button'
              className='h-5 w-5 flex items-center justify-center text-muted-foreground hover:text-foreground transition-colors'
              title={
                state.showMoreTools
                  ? t('chat.actions.hideOptions')
                  : t('chat.actions.showMoreOptions')
              }
              onClick={handleMore}
            >
              <ChevronRight
                className={`h-[14px] w-[14px] transition-transform ${state.showMoreTools ? 'rotate-180' : ''}`}
              />
            </button>
          </>
        ) : (
          <>
            {/* First buttons always visible */}
            <button
              data-testid='message-ai-copy-button'
              className='h-5 w-5 flex items-center justify-center text-muted-foreground hover:text-foreground transition-colors'
              title={t('chat.actions.copyContentAsMarkdown')}
              onClick={handleCopy}
            >
              <CopyIcon className='h-[14px] w-[14px]' />
            </button>
            <button
              data-testid='message-tts-button'
              className={`h-5 w-5 flex items-center justify-center transition-colors ${
                isTTSPlaying
                  ? 'text-blue-500 hover:text-blue-600'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
              title={isTTSPlaying ? t('chat.actions.stopTTS', 'Stop reading') : t('chat.actions.playTTS', 'Read aloud')}
              onClick={handleTTSToggle}
              disabled={isTTSLoading}
            >
              {isTTSLoading ? (
                <Loader2 className='h-[14px] w-[14px] animate-spin' />
              ) : isTTSPlaying ? (
                <Square className='h-[14px] w-[14px]' />
              ) : (
                <Volume2 className='h-[14px] w-[14px]' />
              )}
            </button>
            {/* Research button - shown when message has associated research */}
            {researchPlanId && onViewResearch && (
              <button
                data-testid="message-view-research-button"
                className='h-5 w-5 flex items-center justify-center text-muted-foreground hover:text-violet-500 transition-colors'
                title={t('chat.actions.viewResearch')}
                onClick={() => onViewResearch(researchPlanId)}
              >
                <FileSearch className='h-[14px] w-[14px]' />
              </button>
            )}
            {/* Collapsible buttons - shown when showMoreTools is true */}
            {state.showMoreTools && (
              <>
                <button
                  data-testid='message-regenerate-button'
                  className='h-5 w-5 flex items-center justify-center text-muted-foreground hover:text-foreground transition-colors'
                  title={t('chat.actions.regenerateAsNewBranch')}
                  onClick={() => onRegenerateResponse?.(message.id)}
                >
                  <GitBranch className='h-[14px] w-[14px]' />
                </button>
                {hasRagTrace && onOpenRagTrace && !simpleMode ? (
                  <button
                    data-testid='message-token-metrics-button'
                    className='h-5 w-5 flex items-center justify-center text-muted-foreground hover:text-foreground transition-colors'
                    title={t('chat.actions.responseMetrics')}
                    onClick={() => onOpenRagTrace(message.id)}
                  >
                    <BarChart2 className='h-[14px] w-[14px]' />
                  </button>
                ) : (
                  <PopoverTokenMetrics
                    messageId={message.id}
                    trigger={
                      <button
                        data-testid='message-token-metrics-button'
                        className='h-5 w-5 flex items-center justify-center text-muted-foreground hover:text-foreground transition-colors'
                        title={t('chat.actions.responseMetrics')}
                      >
                        <BarChart2 className='h-[14px] w-[14px]' />
                      </button>
                    }
                  />
                )}
                <button
                  data-testid='message-ai-delete-button'
                  className='h-5 w-5 flex items-center justify-center text-muted-foreground hover:text-red-500 transition-colors'
                  title={t('chat.actions.deleteMessage')}
                  onClick={handleDelete}
                >
                  <Trash2 className='h-[14px] w-[14px]' />
                </button>
              </>
            )}

            {/* Feedback buttons - thumbs up/down */}
            {onFeedback && (
              <>
                <button
                  data-testid='message-feedback-up-button'
                  className={`h-5 w-5 flex items-center justify-center transition-colors ${
                    localFeedback === 1
                      ? 'text-green-500 hover:text-green-600'
                      : 'text-muted-foreground hover:text-green-500'
                  }`}
                  title={t('chat.actions.feedbackPositive')}
                  onClick={() => handleFeedback(1)}
                  onMouseDown={(e) => e.preventDefault()}
                >
                  <ThumbsUp className='h-[14px] w-[14px]' />
                </button>
                <button
                  data-testid='message-feedback-down-button'
                  className={`h-5 w-5 flex items-center justify-center transition-colors ${
                    localFeedback === -1
                      ? 'text-red-500 hover:text-red-600'
                      : 'text-muted-foreground hover:text-red-500'
                  }`}
                  title={t('chat.actions.feedbackNegative')}
                  onClick={() => handleFeedback(-1)}
                  onMouseDown={(e) => e.preventDefault()}
                >
                  <ThumbsDown className='h-[14px] w-[14px]' />
                </button>
              </>
            )}

            {/* Continue generation - branches the conversation from this message */}
            <button
              data-testid='message-continue-button'
              className='h-5 w-5 flex items-center justify-center text-muted-foreground hover:text-foreground transition-colors'
              title={t('chat.actions.continueGeneratingMessage')}
              onClick={() => onContinueGeneration?.(message.id)}
            >
              <Play className='h-[14px] w-[14px]' />
            </button>

            {/* Toggle button with rotating arrow */}
            <button
              data-testid='message-ai-more-button'
              className='h-5 w-5 flex items-center justify-center text-muted-foreground hover:text-foreground transition-colors'
              title={
                state.showMoreTools
                  ? t('chat.actions.hideOptions')
                  : t('chat.actions.showMoreOptions')
              }
              onClick={handleMore}
            >
              <ChevronRight
                className={`h-[14px] w-[14px] transition-transform ${state.showMoreTools ? 'rotate-180' : ''}`}
              />
            </button>
          </>
        )}
      </div>
    </div>
  );
};

// Wrap the ChatMessage component with React.memo to prevent unnecessary re-renders
export const ChatMessage = React.memo(
  ChatMessageComponent,
  (prevProps, nextProps) => {
    // Return true if props are equal (no re-render needed)

    // Always re-render if ID changed
    if (prevProps.message.id !== nextProps.message.id) {
      return false;
    }

    // Always re-render if content changed
    if (prevProps.message.content !== nextProps.message.content) {
      return false;
    }

    // Always re-render if feedback changed
    if (prevProps.message.feedback !== nextProps.message.feedback) {
      return false;
    }

    // Always re-render if the streaming or thinking state changed
    if (
      prevProps.isStreaming !== nextProps.isStreaming ||
      prevProps.isThinking !== nextProps.isThinking ||
      prevProps.thinkingContent !== nextProps.thinkingContent ||
      prevProps.modelInsightContent !== nextProps.modelInsightContent
    ) {
      return false;
    }

    // Always re-render if edit state changed
    if (prevProps.isEditing !== nextProps.isEditing) {
      return false;
    }

    // Don't re-render for other prop changes like isLatest, modelIconSrc, etc.
    // unless they affect the visible content
    return true;
  }
);
