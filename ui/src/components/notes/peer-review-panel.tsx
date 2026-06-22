/**
 * Peer Review Panel — Feature 3
 *
 * Displays a retro "document scanner" UI while the backend runs a
 * structured 7-stage peer review, then reveals the full report when
 * the response arrives.
 *
 * Scanner animation is client-side, calibrated to the expected LLM
 * latency (~15-20s observed). Stages progress at roughly equal
 * intervals; when the actual response arrives, the scanner jumps
 * straight to the final health states — no lying about stages that
 * reported real problems.
 *
 * The panel reuses `DraggablePanel` so it benefits from the measured-
 * height viewport clamp (commit 4c23eb6) and the z-[10002] stacking
 * above the TipTap selection toolbar (commit 788b19c). Scrollable
 * body uses native `overflow-y-auto` per the Radix ScrollArea gotcha
 * (commit ea7afe5).
 *
 * Source-agnostic: accepts any text blob via the `content` prop. The
 * trigger (notes toolbar, deep research panel, etc.) decides what to
 * flatten. This component owns only the scanner UX + result rendering.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  AlertTriangle,
  BookMarked,
  Check,
  ChevronDown,
  ChevronRight,
  CircleDot,
  FileText,
  FlaskConical,
  Image as ImageIcon,
  Loader2,
  Scale,
  ShieldCheck,
  Signature,
  Sparkles,
  X,
} from 'lucide-react';
import { DraggablePanel, DragHandle } from './draggable-panel';
import { Button } from '@/components/ui/button';
import {
  reviewDocument,
  type ClaimVerification,
  type ReviewDocumentResponse,
  type ReviewSourceType,
  type ReviewStage,
  type ReviewStageHealth,
  type ReviewStageName,
  type ReviewVerdict,
} from '@/lib/api-notes-assistant';
import { cn } from '@/lib/utils';

interface PeerReviewPanelProps {
  content: string;
  sourceType: ReviewSourceType;
  sourceTitle: string;
  position: { top: number; left: number };
  onClose: () => void;
}

// Canonical stage metadata — icon, i18n key, expected mid-point fraction
// of total latency when that stage should "light up" during fake scanner
// animation. These fractions are rough: stages earlier in the list are
// cheaper (initial is basically a structural glance) so they progress
// faster. Sum of deltas is 1.0.
const STAGE_META: Array<{
  name: ReviewStageName;
  icon: typeof FileText;
  i18nKey: string;
  fallback: string;
  fraction: number; // when this stage should "complete" during fake animation, 0..1
}> = [
  { name: 'initial', icon: Sparkles, i18nKey: 'notes.assistant.reviewStage_initial', fallback: 'Initial', fraction: 0.07 },
  { name: 'sections', icon: FileText, i18nKey: 'notes.assistant.reviewStage_sections', fallback: 'Sections', fraction: 0.22 },
  { name: 'methods', icon: FlaskConical, i18nKey: 'notes.assistant.reviewStage_methods', fallback: 'Methods', fraction: 0.42 },
  { name: 'reproducibility', icon: BookMarked, i18nKey: 'notes.assistant.reviewStage_reproducibility', fallback: 'Reproducibility', fraction: 0.56 },
  { name: 'figures', icon: ImageIcon, i18nKey: 'notes.assistant.reviewStage_figures', fallback: 'Figures', fraction: 0.7 },
  { name: 'ethics', icon: Scale, i18nKey: 'notes.assistant.reviewStage_ethics', fallback: 'Ethics', fraction: 0.85 },
  { name: 'writing', icon: Signature, i18nKey: 'notes.assistant.reviewStage_writing', fallback: 'Writing', fraction: 1.0 },
];

// Expected full review duration for pacing the fake scanner animation.
// Tuned against the live 17s observed latency; real response usually
// arrives before the last tick completes.
const EXPECTED_LATENCY_MS = 18_000;

// LED color classes keyed by stage health. Dark-mode friendly.
const HEALTH_COLORS: Record<ReviewStageHealth, { dot: string; bar: string; text: string }> = {
  ok: {
    dot: 'bg-green-500 shadow-[0_0_8px_rgba(34,197,94,0.6)]',
    bar: 'bg-green-500/80',
    text: 'text-green-600 dark:text-green-400',
  },
  concerns: {
    dot: 'bg-amber-500 shadow-[0_0_8px_rgba(245,158,11,0.6)]',
    bar: 'bg-amber-500/80',
    text: 'text-amber-600 dark:text-amber-400',
  },
  critical: {
    dot: 'bg-red-500 shadow-[0_0_10px_rgba(239,68,68,0.7)]',
    bar: 'bg-red-500/80',
    text: 'text-red-600 dark:text-red-400',
  },
};

const VERDICT_META: Record<
  ReviewVerdict,
  { i18nKey: string; fallback: string; bg: string; text: string; border: string }
> = {
  accept: {
    i18nKey: 'notes.assistant.reviewVerdict_accept',
    fallback: 'Accept',
    bg: 'bg-green-500/10',
    text: 'text-green-600 dark:text-green-400',
    border: 'border-green-500/40',
  },
  minor_revisions: {
    i18nKey: 'notes.assistant.reviewVerdict_minor',
    fallback: 'Minor revisions',
    bg: 'bg-amber-500/10',
    text: 'text-amber-600 dark:text-amber-400',
    border: 'border-amber-500/40',
  },
  major_revisions: {
    i18nKey: 'notes.assistant.reviewVerdict_major',
    fallback: 'Major revisions',
    bg: 'bg-orange-500/10',
    text: 'text-orange-600 dark:text-orange-400',
    border: 'border-orange-500/40',
  },
  reject: {
    i18nKey: 'notes.assistant.reviewVerdict_reject',
    fallback: 'Reject',
    bg: 'bg-red-500/10',
    text: 'text-red-600 dark:text-red-400',
    border: 'border-red-500/40',
  },
};

export function PeerReviewPanel({
  content,
  sourceType,
  sourceTitle,
  position,
  onClose,
}: PeerReviewPanelProps) {
  const { t } = useTranslation();
  const [loading, setLoading] = useState(true);
  const [result, setResult] = useState<ReviewDocumentResponse | null>(null);
  const [error, setError] = useState('');
  const [expandedStages, setExpandedStages] = useState<Set<ReviewStageName>>(new Set());
  const [elapsedMs, setElapsedMs] = useState(0);
  const hasStarted = useRef(false);

  // Kick off the review exactly once
  useEffect(() => {
    if (hasStarted.current) return;
    hasStarted.current = true;

    let cancelled = false;

    async function run() {
      setLoading(true);
      setError('');
      try {
        const data = await reviewDocument(content, sourceType, sourceTitle);
        if (!cancelled) setResult(data);
      } catch (err) {
        console.error('Peer review failed:', err);
        if (!cancelled) {
          setError(
            t(
              'notes.assistant.reviewFailed',
              'Review could not be generated. The service may be temporarily unavailable.'
            )
          );
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void run();
    return () => {
      cancelled = true;
    };
  }, [content, sourceType, sourceTitle, t]);

  // Fake scanner animation — tick elapsed time while loading so the
  // progress bar and stage highlighter move smoothly even though we
  // have no real server-side progress signal.
  useEffect(() => {
    if (!loading) return;
    const start = performance.now();
    let raf: number;
    const step = () => {
      setElapsedMs(performance.now() - start);
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [loading]);

  // ESC closes panel
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const toggleStage = useCallback((name: ReviewStageName) => {
    setExpandedStages((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }, []);

  // Scanner LED state per stage:
  //  - If result is available → use real health + stage_score from the response
  //  - Else if loading → progressive reveal based on elapsed fraction
  //  - Else → idle (no LED)
  const scannerState: Array<{
    name: ReviewStageName;
    state: 'idle' | 'scanning' | 'done';
    health: ReviewStageHealth | null;
    flags: number;
    stageScore: number; // 0 = not assessed / not applicable
  }> = useMemo(() => {
    if (result) {
      const byName = new Map(result.stages.map((s) => [s.stage_name, s]));
      return STAGE_META.map((m) => {
        const stage = byName.get(m.name);
        return {
          name: m.name,
          state: 'done' as const,
          health: stage?.health ?? 'ok',
          flags: stage?.comments.length ?? 0,
          stageScore: stage?.stage_score ?? 0,
        };
      });
    }

    if (loading) {
      const fraction = Math.min(1, elapsedMs / EXPECTED_LATENCY_MS);
      return STAGE_META.map((m, idx) => {
        const prevFraction = idx === 0 ? 0 : STAGE_META[idx - 1].fraction;
        if (fraction >= m.fraction) {
          return { name: m.name, state: 'done' as const, health: 'ok' as ReviewStageHealth, flags: 0, stageScore: 0 };
        }
        if (fraction >= prevFraction) {
          return { name: m.name, state: 'scanning' as const, health: null, flags: 0, stageScore: 0 };
        }
        return { name: m.name, state: 'idle' as const, health: null, flags: 0, stageScore: 0 };
      });
    }

    return STAGE_META.map((m) => ({
      name: m.name,
      state: 'idle' as const,
      health: null,
      flags: 0,
      stageScore: 0,
    }));
  }, [result, loading, elapsedMs]);

  const overallProgress = result
    ? 1
    : Math.min(1, elapsedMs / EXPECTED_LATENCY_MS);

  const verdictMeta = result ? VERDICT_META[result.verdict] : null;

  return (
    <DraggablePanel
      initialPosition={{ top: position.top, left: position.left }}
      className="w-[520px] max-h-[85vh]"
      onClickOutside={onClose}
    >
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-border bg-black/30">
        <div className="flex items-center gap-2 min-w-0">
          <CircleDot className="h-3.5 w-3.5 text-amber-500 animate-pulse shrink-0" />
          <span className="text-xs font-mono font-semibold tracking-wider truncate">
            {t('notes.assistant.peerReviewHeader', 'SCRAPALOT PEER-REVIEW SCANNER')}
          </span>
        </div>
        <div className="flex items-center gap-0.5 shrink-0">
          <DragHandle />
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6"
            onClick={onClose}
            aria-label={t('common.close', 'Close')}
          >
            <X className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 min-h-0 overflow-y-auto">
        {/* Source title banner */}
        <div className="px-3 py-2 border-b border-border text-xs text-muted-foreground truncate">
          {t('notes.assistant.reviewing', 'Reviewing')}: <span className="font-medium text-foreground">{sourceTitle || t('notes.assistant.untitled', 'Untitled')}</span>
        </div>

        {/* Scanner + stages */}
        <div className="p-3 flex gap-3 items-stretch">
          {/* Document silhouette with scan line */}
          <DocumentSilhouette progress={overallProgress} scanning={loading && !error} />

          {/* Stage indicators column */}
          <div className="flex-1 min-w-0 space-y-1.5">
            {STAGE_META.map((meta, idx) => {
              const st = scannerState[idx];
              const color = st.health ? HEALTH_COLORS[st.health] : null;
              const StageIcon = meta.icon;
              return (
                <div
                  key={meta.name}
                  className={cn(
                    'flex items-center gap-2 text-[11px] font-mono uppercase tracking-wide',
                    st.state === 'idle' && 'opacity-40',
                  )}
                >
                  {/* LED dot */}
                  <span
                    className={cn(
                      'h-2.5 w-2.5 rounded-full shrink-0 transition-all',
                      st.state === 'idle' && 'bg-muted-foreground/30',
                      st.state === 'scanning' && 'bg-amber-500 animate-pulse shadow-[0_0_8px_rgba(245,158,11,0.7)]',
                      st.state === 'done' && color && color.dot,
                    )}
                  />
                  {/* Stage number */}
                  <span className="text-muted-foreground shrink-0 w-3">{meta.name === 'initial' ? '1' : idx + 1}</span>
                  {/* Icon */}
                  <StageIcon
                    className={cn(
                      'h-3 w-3 shrink-0',
                      st.state === 'done' && color ? color.text : 'text-muted-foreground',
                    )}
                  />
                  {/* Label */}
                  <span
                    className={cn(
                      'flex-1 truncate',
                      st.state === 'done' && color ? color.text : 'text-muted-foreground',
                    )}
                  >
                    {t(meta.i18nKey, meta.fallback)}
                  </span>
                  {/* Flag count */}
                  {st.state === 'done' && st.flags > 0 && (
                    <span
                      className={cn(
                        'text-[9px] px-1 py-0.5 border font-bold',
                        color?.text,
                        st.health === 'critical' && 'border-red-500/40 bg-red-500/10',
                        st.health === 'concerns' && 'border-amber-500/40 bg-amber-500/10',
                        st.health === 'ok' && 'border-green-500/40 bg-green-500/10',
                      )}
                    >
                      {st.flags} {t('notes.assistant.reviewFlagsShort', 'flags')}
                    </span>
                  )}
                  {/* ScholarEval 1..5 stage_score badge */}
                  {st.state === 'done' && st.stageScore > 0 && (
                    <span
                      className={cn(
                        'text-[9px] font-mono font-bold w-4 text-center',
                        color?.text,
                      )}
                      title={t('notes.assistant.reviewStageScoreTitle', 'ScholarEval rubric: 5=Excellent, 1=Poor')}
                    >
                      {st.stageScore}
                    </span>
                  )}
                  {st.state === 'scanning' && (
                    <Loader2 className="h-3 w-3 animate-spin text-amber-500 shrink-0" />
                  )}
                  {st.state === 'done' && st.flags === 0 && st.stageScore === 0 && (
                    <Check className="h-3 w-3 text-green-500/70 shrink-0" />
                  )}
                </div>
              );
            })}

            {/* Progress bar */}
            <div className="mt-3 pt-2 border-t border-border/50">
              <div className="flex items-center justify-between text-[9px] font-mono uppercase tracking-wider text-muted-foreground mb-1">
                <span>{t('notes.assistant.reviewProgress', 'Total progress')}</span>
                <span>{Math.round(overallProgress * 100)}%</span>
              </div>
              <div className="h-1.5 bg-muted/40 overflow-hidden">
                <div
                  className={cn(
                    'h-full transition-all duration-300',
                    result ? 'bg-primary' : 'bg-amber-500'
                  )}
                  style={{ width: `${overallProgress * 100}%` }}
                />
              </div>
            </div>
          </div>
        </div>

        {/* Live status line — during scanning only */}
        {loading && !error && (
          <div className="mx-3 mb-3 px-3 py-2 bg-black/40 border border-amber-500/30 font-mono text-[10px] text-amber-500/80">
            <span className="inline-block animate-pulse">▶</span>{' '}
            <LiveStatusLine elapsedMs={elapsedMs} t={t} />
          </div>
        )}

        {/* Error state */}
        {error && (
          <div className="mx-3 mb-3 px-3 py-2 border border-destructive/40 bg-destructive/10 text-destructive text-xs">
            <AlertTriangle className="inline h-3.5 w-3.5 mr-1" />
            {error}
          </div>
        )}

        {/* Verdict + report — only after response arrives */}
        {result && verdictMeta && (
          <div className="border-t border-border">
            {/* Verdict card */}
            <div className={cn('m-3 border-2 p-3', verdictMeta.border, verdictMeta.bg)}>
              <div className="flex items-start gap-3">
                <ShieldCheck className={cn('h-6 w-6 mt-0.5 shrink-0', verdictMeta.text)} />
                <div className="flex-1 min-w-0">
                  <div className={cn('text-sm font-bold uppercase tracking-wider', verdictMeta.text)}>
                    {t(verdictMeta.i18nKey, verdictMeta.fallback)}
                  </div>
                  <div className="text-xs text-muted-foreground mt-0.5">
                    {t('notes.assistant.reviewScore', 'Score')}: <span className="font-mono font-bold">{result.score}/100</span>
                    {' · '}
                    <span className="font-mono">{(result.latency_ms / 1000).toFixed(1)}s</span>
                  </div>
                  {result.summary && (
                    <div className="text-xs mt-2 leading-snug">{result.summary}</div>
                  )}
                </div>
              </div>
            </div>

            {/* Strengths + Weaknesses */}
            {(result.overall_strengths.length > 0 || result.overall_weaknesses.length > 0) && (
              <div className="px-3 grid grid-cols-2 gap-3 mb-3">
                {result.overall_strengths.length > 0 && (
                  <div>
                    <div className="text-[10px] font-medium uppercase tracking-wide text-green-600 dark:text-green-400 mb-1">
                      {t('notes.assistant.reviewStrengths', 'Strengths')}
                    </div>
                    <ul className="text-[11px] space-y-1 text-muted-foreground">
                      {result.overall_strengths.map((s, i) => (
                        <li key={`str-${i}`} className="flex gap-1">
                          <span className="text-green-500 shrink-0">+</span>
                          <span>{s}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {result.overall_weaknesses.length > 0 && (
                  <div>
                    <div className="text-[10px] font-medium uppercase tracking-wide text-red-600 dark:text-red-400 mb-1">
                      {t('notes.assistant.reviewWeaknesses', 'Weaknesses')}
                    </div>
                    <ul className="text-[11px] space-y-1 text-muted-foreground">
                      {result.overall_weaknesses.map((s, i) => (
                        <li key={`wk-${i}`} className="flex gap-1">
                          <span className="text-red-500 shrink-0">−</span>
                          <span>{s}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            )}

            {/* Per-stage detail — expandable */}
            <div className="px-3 pb-2">
              <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground mb-1.5">
                {t('notes.assistant.reviewStageDetails', 'Stage details')}
              </div>
              <div className="space-y-1.5">
                {result.stages.map((stage) => (
                  <StageDetailCard
                    key={stage.stage_name}
                    stage={stage}
                    expanded={expandedStages.has(stage.stage_name)}
                    onToggle={() => toggleStage(stage.stage_name)}
                    t={t}
                  />
                ))}
              </div>
            </div>

            {/* Questions for authors */}
            {result.questions_for_authors.length > 0 && (
              <div className="px-3 pb-3">
                <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground mb-1.5">
                  {t('notes.assistant.reviewQuestions', 'Questions for authors')}
                </div>
                <ul className="text-[11px] space-y-1 text-muted-foreground">
                  {result.questions_for_authors.map((q, i) => (
                    <li key={`q-${i}`} className="flex gap-1">
                      <span className="text-primary shrink-0">?</span>
                      <span>{q}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {/* Feature 2 + 3 — key claims verified in parallel via
                VerifyClaim pipeline (library + Crossref + OpenAlex +
                Semantic Scholar + Unpaywall + GRADE). */}
            {result.claim_verifications && result.claim_verifications.length > 0 && (
              <div className="px-3 pb-3 border-t border-border pt-3">
                <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground mb-1.5 flex items-center gap-1.5">
                  <ShieldCheck className="h-3 w-3" />
                  {t('notes.assistant.reviewClaimVerifications', 'Claim verifications')}
                </div>
                <div className="space-y-2">
                  {result.claim_verifications.map((cv, i) => (
                    <ClaimVerificationCard key={`cv-${i}`} cv={cv} t={t} />
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </DraggablePanel>
  );
}

// ─── Sub-components ──────────────────────────────────────────────────────────

/**
 * Retro document silhouette with an animated horizontal scan line.
 * Uses CSS-only animation while scanning; when result arrives, the
 * scan line stops at the bottom and the document fades in as "scanned".
 */
function DocumentSilhouette({
  progress,
  scanning,
}: {
  progress: number;
  scanning: boolean;
}) {
  const lineTop = Math.min(95, progress * 95);
  return (
    <div className="relative w-[90px] h-[140px] shrink-0 border-2 border-border/60 bg-black/20 overflow-hidden">
      {/* Fake text rows */}
      <div className="absolute inset-0 p-2 flex flex-col gap-1.5">
        {Array.from({ length: 14 }).map((_, i) => (
          <div
            key={i}
            className={cn(
              'h-1 bg-muted-foreground/30',
              i % 4 === 0 ? 'w-1/2' : 'w-full'
            )}
          />
        ))}
      </div>
      {/* Scan line */}
      {scanning && (
        <div
          className="absolute left-0 right-0 h-px bg-amber-500 shadow-[0_0_8px_rgba(245,158,11,0.9)] pointer-events-none transition-all duration-300"
          style={{ top: `${lineTop}%` }}
        />
      )}
      {/* Corner brackets for retro look */}
      <div className="absolute top-0 left-0 w-2 h-2 border-t-2 border-l-2 border-amber-500/60" />
      <div className="absolute top-0 right-0 w-2 h-2 border-t-2 border-r-2 border-amber-500/60" />
      <div className="absolute bottom-0 left-0 w-2 h-2 border-b-2 border-l-2 border-amber-500/60" />
      <div className="absolute bottom-0 right-0 w-2 h-2 border-b-2 border-r-2 border-amber-500/60" />
    </div>
  );
}

/**
 * Live status line that cycles through localized micro-task strings
 * based on elapsed time. Purely cosmetic — gives the user a sense
 * of real progress while the LLM is thinking.
 */
function LiveStatusLine({
  elapsedMs,
  t,
}: {
  elapsedMs: number;
  t: (key: string, fallback?: string) => string;
}) {
  const messages = useMemo(
    () => [
      t('notes.assistant.reviewLive_reading', 'Reading document structure…'),
      t('notes.assistant.reviewLive_scope', 'Identifying central research question…'),
      t('notes.assistant.reviewLive_sections', 'Inspecting section-by-section flow…'),
      t('notes.assistant.reviewLive_methods', 'Evaluating methodology & statistical rigor…'),
      t('notes.assistant.reviewLive_repro', 'Checking reproducibility & reporting standards…'),
      t('notes.assistant.reviewLive_figures', 'Assessing figures & data integrity…'),
      t('notes.assistant.reviewLive_ethics', 'Reviewing ethical considerations…'),
      t('notes.assistant.reviewLive_writing', 'Scoring writing quality & accessibility…'),
    ],
    [t]
  );

  const idx = Math.min(
    messages.length - 1,
    Math.floor((elapsedMs / EXPECTED_LATENCY_MS) * messages.length)
  );
  return <span>{messages[idx]}</span>;
}

/**
 * Feature 2 + 3 — card showing one extracted claim + its VerifyClaim
 * result. Reuses the Feature 2 verdict + GRADE vocabulary:
 *
 *   verdict      → colored icon (green/amber/red)
 *   confidence   → small label under verdict
 *   grade        → right-side badge with ScholarEval-style color
 */
function ClaimVerificationCard({
  cv,
  t,
}: {
  cv: ClaimVerification;
  t: (key: string, fallback?: string) => string;
}) {
  const verdictColor =
    cv.verdict === 'supported'
      ? 'text-green-600 dark:text-green-400 border-green-500/40 bg-green-500/10'
      : cv.verdict === 'partially_supported'
      ? 'text-amber-600 dark:text-amber-400 border-amber-500/40 bg-amber-500/10'
      : cv.verdict === 'contradicted'
      ? 'text-red-600 dark:text-red-400 border-red-500/40 bg-red-500/10'
      : 'text-muted-foreground border-border bg-muted/20';

  const gradeColor =
    cv.evidence_quality.grade === 'high'
      ? 'text-green-600 dark:text-green-400 border-green-500/40 bg-green-500/10'
      : cv.evidence_quality.grade === 'moderate'
      ? 'text-amber-600 dark:text-amber-400 border-amber-500/40 bg-amber-500/10'
      : cv.evidence_quality.grade === 'low'
      ? 'text-orange-600 dark:text-orange-400 border-orange-500/40 bg-orange-500/10'
      : 'text-red-600 dark:text-red-400 border-red-500/40 bg-red-500/10';

  return (
    <div className="border border-border bg-card/40 p-2">
      <div className="text-[11px] italic leading-snug text-foreground mb-2">
        &ldquo;{cv.claim_text}&rdquo;
        {cv.section_ref && (
          <span className="ml-1 font-mono text-[9px] text-muted-foreground not-italic">
            — {cv.section_ref}
          </span>
        )}
      </div>
      <div className="flex items-center gap-1.5 flex-wrap">
        <span className={cn('text-[9px] px-1 py-0.5 border font-medium uppercase tracking-wide', verdictColor)}>
          {t(`notes.research_assistant.verdict_${cv.verdict}`, cv.verdict)}
        </span>
        <span className="text-[9px] text-muted-foreground">
          {t(`notes.research_assistant.confidence_${cv.confidence}`, cv.confidence)}
        </span>
        <span className="flex-1" />
        <span className={cn('text-[9px] px-1 py-0.5 border font-bold uppercase tracking-wider', gradeColor)} title={cv.evidence_quality.rationale}>
          GRADE: {t(`notes.assistant.grade${cv.evidence_quality.grade.charAt(0).toUpperCase() + cv.evidence_quality.grade.slice(1).replace('_', '')}`, cv.evidence_quality.grade)}
        </span>
      </div>
    </div>
  );
}

/**
 * Expandable card showing a single stage's summary + comments list.
 */
function StageDetailCard({
  stage,
  expanded,
  onToggle,
  t,
}: {
  stage: ReviewStage;
  expanded: boolean;
  onToggle: () => void;
  t: (key: string, fallback?: string) => string;
}) {
  const color = HEALTH_COLORS[stage.health];
  const meta = STAGE_META.find((m) => m.name === stage.stage_name);
  const StageIcon = meta?.icon ?? FileText;
  const hasBody = stage.summary || stage.comments.length > 0;

  return (
    <div className={cn('border', color.text.replace('text-', 'border-').replace('-600', '-500/30').replace('-400', '-500/30'))}>
      <button
        type="button"
        className={cn(
          'w-full flex items-center gap-2 px-2 py-1.5 text-[11px] font-medium text-left',
          'hover:bg-accent/30 transition-colors'
        )}
        onClick={onToggle}
        disabled={!hasBody}
      >
        {expanded ? (
          <ChevronDown className="h-3 w-3 text-muted-foreground shrink-0" />
        ) : (
          <ChevronRight className="h-3 w-3 text-muted-foreground shrink-0" />
        )}
        <StageIcon className={cn('h-3 w-3 shrink-0', color.text)} />
        <span className="flex-1 truncate">
          {stage.stage_number}. {t(`notes.assistant.reviewStage_${stage.stage_name}`, stage.stage_name)}
        </span>
        {stage.comments.length > 0 && (
          <span className={cn('text-[9px] px-1 py-0.5 border', color.text, {
            'border-red-500/40 bg-red-500/10': stage.health === 'critical',
            'border-amber-500/40 bg-amber-500/10': stage.health === 'concerns',
            'border-green-500/40 bg-green-500/10': stage.health === 'ok',
          })}>
            {stage.comments.length}
          </span>
        )}
      </button>
      {expanded && hasBody && (
        <div className="px-3 pb-2 pt-1 text-[11px] space-y-2">
          {stage.summary && <div className="text-muted-foreground italic leading-snug">{stage.summary}</div>}
          {stage.comments.map((c, i) => (
            <div key={`c-${i}`} className="border-l-2 border-border pl-2 space-y-0.5">
              <div className="flex items-center gap-1.5">
                <span
                  className={cn(
                    'text-[9px] uppercase px-1 py-0.5 border font-medium',
                    c.severity === 'critical' && 'text-red-600 dark:text-red-400 border-red-500/40 bg-red-500/10',
                    c.severity === 'important' && 'text-amber-600 dark:text-amber-400 border-amber-500/40 bg-amber-500/10',
                    c.severity === 'minor' && 'text-muted-foreground border-border'
                  )}
                >
                  {t(`notes.assistant.reviewSeverity_${c.severity}`, c.severity)}
                </span>
                {c.section_ref && (
                  <span className="text-[10px] font-mono text-muted-foreground">{c.section_ref}</span>
                )}
              </div>
              <div className="text-foreground leading-snug">{c.issue}</div>
              {c.suggestion && (
                <div className="text-muted-foreground italic leading-snug">
                  → {c.suggestion}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
