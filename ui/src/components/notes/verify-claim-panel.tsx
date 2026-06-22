/**
 * Verify Claim Panel
 *
 * Shows claim verification results with verdict badge,
 * supporting/contradicting evidence, and suggestion.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  AlertTriangle,
  Loader2,
  ShieldCheck,
  ShieldAlert,
  ShieldX,
  ShieldQuestion,
  TrendingDown,
  TrendingUp,
  X,
} from 'lucide-react';
import { DraggablePanel, DragHandle } from './draggable-panel';
import { Editor } from '@tiptap/react';
import { Button } from '@/components/ui/button';
import {
  verifyClaim,
  type VerifyClaimResponse,
  type EvidenceItem,
  type EvidenceQuality,
  type BiasFlag,
  type FallacyWarning,
  type GradeLevel,
} from '@/lib/api-notes-assistant';
import { cleanSourceTitle } from '@/lib/source-title';
import { cn } from '@/lib/utils';

interface VerifyClaimPanelProps {
  editor: Editor;
  claimText: string;
  collectionIds: string[];
  position: { top: number; left: number };
  onClose: () => void;
}

const VERDICT_CONFIG = {
  supported: { icon: ShieldCheck, color: 'text-green-600', bg: 'bg-green-100 dark:bg-green-900/30', i18nKey: 'notes.research_assistant.verdict_supported', fallback: 'Supported' },
  partially_supported: { icon: ShieldAlert, color: 'text-yellow-600', bg: 'bg-yellow-100 dark:bg-yellow-900/30', i18nKey: 'notes.research_assistant.verdict_partially_supported', fallback: 'Partially Supported' },
  contradicted: { icon: ShieldX, color: 'text-red-600', bg: 'bg-red-100 dark:bg-red-900/30', i18nKey: 'notes.research_assistant.verdict_contradicted', fallback: 'Contradicted' },
  unverified: { icon: ShieldQuestion, color: 'text-muted-foreground', bg: 'bg-muted', i18nKey: 'notes.research_assistant.verdict_unverified', fallback: 'Unverified' },
} as const;

// GRADE level → color mapping for the Evidence Quality badge.
// Green (high) → amber (moderate) → orange (low) → red (very_low).
// Kept in-panel (not global tailwind.config) because these levels only
// exist on this one surface and the color semantics are claim-rigour
// specific, not part of the general design system palette.
const GRADE_CONFIG: Record<GradeLevel, { color: string; bg: string; border: string; i18nKey: string; fallback: string }> = {
  high: {
    color: 'text-green-600 dark:text-green-400',
    bg: 'bg-green-100 dark:bg-green-900/30',
    border: 'border-green-500/40',
    i18nKey: 'notes.assistant.gradeHigh',
    fallback: 'High quality',
  },
  moderate: {
    color: 'text-amber-600 dark:text-amber-400',
    bg: 'bg-amber-100 dark:bg-amber-900/30',
    border: 'border-amber-500/40',
    i18nKey: 'notes.assistant.gradeModerate',
    fallback: 'Moderate quality',
  },
  low: {
    color: 'text-orange-600 dark:text-orange-400',
    bg: 'bg-orange-100 dark:bg-orange-900/30',
    border: 'border-orange-500/40',
    i18nKey: 'notes.assistant.gradeLow',
    fallback: 'Low quality',
  },
  very_low: {
    color: 'text-red-600 dark:text-red-400',
    bg: 'bg-red-100 dark:bg-red-900/30',
    border: 'border-red-500/40',
    i18nKey: 'notes.assistant.gradeVeryLow',
    fallback: 'Very low quality',
  },
};

export function VerifyClaimPanel({
  editor,
  claimText,
  collectionIds,
  position,
  onClose,
}: VerifyClaimPanelProps) {
  const { t } = useTranslation();
  const [loading, setLoading] = useState(true);
  const [result, setResult] = useState<VerifyClaimResponse | null>(null);
  const [error, setError] = useState('');

  const collectionIdsRef = useRef(collectionIds);
  collectionIdsRef.current = collectionIds;
  const hasSearched = useRef(false);

  useEffect(() => {
    if (hasSearched.current) return;
    hasSearched.current = true;

    let cancelled = false;

    async function verify() {
      setLoading(true);
      setError('');
      try {
        const data = await verifyClaim(claimText, collectionIdsRef.current);
        if (!cancelled) setResult(data);
      } catch (err) {
        console.error('Claim verification failed:', err);
        if (!cancelled) setError(t('notes.research_assistant.verify_failed', 'Verification failed. The service may be temporarily unavailable.'));
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void verify();
    return () => { cancelled = true; };
  }, [claimText, t]);

  const handleInsertEvidence = useCallback(
    (evidence: EvidenceItem) => {
      editor
        .chain()
        .focus()
        .insertContent([
          {
            type: 'blockquote',
            content: [
              { type: 'paragraph', content: [{ type: 'text', text: `"${evidence.snippet}"` }] },
            ],
          },
          {
            type: 'paragraph',
            content: [{ type: 'text', text: `— ${cleanSourceTitle(evidence.source_title)}` }],
          },
        ])
        .run();
    },
    [editor]
  );

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  const verdictConfig = result ? VERDICT_CONFIG[result.verdict] || VERDICT_CONFIG.unverified : null;
  const VerdictIcon = verdictConfig?.icon || ShieldQuestion;

  return (
    <DraggablePanel
      initialPosition={{ top: position.top, left: Math.min(position.left, window.innerWidth - 380) }}
      className="w-[380px] max-h-[440px]"
      onClickOutside={onClose}
    >
      <div className="flex items-center justify-between px-3 py-2 border-b border-border">
        <span className="text-sm font-medium truncate min-w-0">
          {t('notes.research_assistant.verify_claim', 'Verify Claim')}
        </span>
        <div className="flex items-center gap-0.5 shrink-0">
          <DragHandle />
          <Button variant="ghost" size="icon" className="h-6 w-6" onClick={onClose} aria-label={t('common.close', 'Close')}>
            <X className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto">
        {loading ? (
          <div className="flex flex-col items-center justify-center py-8 text-muted-foreground gap-2">
            <Loader2 className="h-4 w-4 animate-spin" />
            <span className="text-sm">{t('notes.research_assistant.verifying', 'Verifying...')}</span>
            <span className="text-xs text-muted-foreground/60">{t('notes.research_assistant.verify_wait', 'Searching sources and analyzing evidence...')}</span>
          </div>
        ) : error ? (
          <div className="p-3 space-y-2">
            <div className="text-xs bg-muted/50 rounded p-2 line-clamp-2 italic">
              &ldquo;{claimText}&rdquo;
            </div>
            <div className="flex items-center gap-2 rounded-md px-3 py-2 bg-destructive/10">
              <ShieldQuestion className="h-5 w-5 text-destructive shrink-0" />
              <div className="text-sm text-destructive">{error}</div>
            </div>
          </div>
        ) : result ? (
          <div className="p-3 space-y-3">
            {/* Claim */}
            <div className="text-xs bg-muted/50 rounded p-2 line-clamp-2 italic">
              &ldquo;{claimText}&rdquo;
            </div>

            {/* Verdict Badge */}
            <div className={cn('flex items-center gap-2 rounded-md px-3 py-2', verdictConfig?.bg)}>
              <VerdictIcon className={cn('h-5 w-5', verdictConfig?.color)} />
              <div>
                <div className={cn('text-sm font-medium', verdictConfig?.color)}>
                  {verdictConfig ? t(verdictConfig.i18nKey, verdictConfig.fallback) : ''}
                </div>
                <div className="text-xs text-muted-foreground">
                  {t(`notes.research_assistant.confidence_${result.confidence}`, result.confidence)}{' '}
                  {t('notes.research_assistant.confidence', 'confidence')}
                </div>
              </div>
            </div>

            {/* Evidence Quality (GRADE) */}
            {result.evidence_quality && (
              <EvidenceQualityBlock quality={result.evidence_quality} t={t} />
            )}

            {/* Supporting Evidence */}
            {result.supporting_evidence.length > 0 && (
              <div>
                <div className="text-xs font-medium text-green-600 mb-1">
                  {t('notes.research_assistant.supporting_evidence', 'Supporting Evidence')} ({result.supporting_evidence.length})
                </div>
                {result.supporting_evidence.map((e, i) => (
                  <EvidenceCard key={`sup-${i}`} evidence={e} onInsert={() => handleInsertEvidence(e)} t={t} />
                ))}
              </div>
            )}

            {/* Contradicting Evidence */}
            {result.contradicting_evidence.length > 0 && (
              <div>
                <div className="text-xs font-medium text-red-600 mb-1">
                  {t('notes.research_assistant.contradicting_evidence', 'Contradicting Evidence')} ({result.contradicting_evidence.length})
                </div>
                {result.contradicting_evidence.map((e, i) => (
                  <EvidenceCard key={`con-${i}`} evidence={e} onInsert={() => handleInsertEvidence(e)} t={t} />
                ))}
              </div>
            )}

            {/* Bias Flags */}
            {result.bias_flags && result.bias_flags.length > 0 && (
              <BiasFlagsBlock flags={result.bias_flags} t={t} />
            )}

            {/* Fallacy Warnings */}
            {result.fallacy_warnings && result.fallacy_warnings.length > 0 && (
              <FallacyWarningsBlock warnings={result.fallacy_warnings} t={t} />
            )}

            {/* Suggestion */}
            {result.suggestion && (
              <div className="bg-primary/5 rounded p-2">
                <div className="text-xs font-medium text-muted-foreground mb-1">
                  {t('notes.research_assistant.suggestion', 'Suggestion')}
                </div>
                <div className="text-sm">{result.suggestion}</div>
              </div>
            )}
          </div>
        ) : (
          <div className="p-3 text-center text-sm text-muted-foreground">
            {t('notes.research_assistant.no_verdict', 'No verification result available.')}
          </div>
        )}
      </div>
    </DraggablePanel>
  );
}

function EvidenceCard({
  evidence,
  onInsert,
  t,
}: {
  evidence: EvidenceItem;
  onInsert: () => void;
  t: (key: string, fallback?: string) => string;
}) {
  return (
    <div className="rounded border border-border bg-card p-2 mb-1.5 text-xs">
      <div className="font-medium truncate" title={evidence.source_title}>{cleanSourceTitle(evidence.source_title)}</div>
      <p className="text-muted-foreground mt-0.5 line-clamp-2">{evidence.snippet}</p>
      <Button variant="outline" size="sm" className="h-5 text-[10px] px-1.5 mt-1" onClick={onInsert}>
        {t('notes.research_assistant.insert', 'Insert')}
      </Button>
    </div>
  );
}

/**
 * Evidence Quality (GRADE) block — colored badge + rationale + downgrade /
 * upgrade chips. Always rendered when result.evidence_quality is present.
 * On LLM failure the backend returns grade="very_low" with a generic
 * rationale so this block still renders instead of going missing.
 */
function EvidenceQualityBlock({
  quality,
  t,
}: {
  quality: EvidenceQuality;
  t: (key: string, options?: object) => string;
}) {
  const cfg = GRADE_CONFIG[quality.grade];

  return (
    <div className={cn('border rounded-md p-2', cfg.border, cfg.bg)}>
      <div className="flex items-center justify-between gap-2 mb-1">
        <div className={cn('text-xs font-semibold', cfg.color)}>
          {t('notes.assistant.evidenceQuality', 'Evidence Quality (GRADE)')}
        </div>
        <div className={cn('text-[10px] font-bold uppercase tracking-wide px-1.5 py-0.5 border', cfg.border, cfg.color)}>
          {t(cfg.i18nKey, cfg.fallback)}
        </div>
      </div>
      {quality.rationale && (
        <div className="text-[11px] text-muted-foreground leading-snug mb-1.5">{quality.rationale}</div>
      )}
      {(quality.downgrades.length > 0 || quality.upgrades.length > 0) && (
        <div className="flex flex-wrap gap-1">
          {quality.downgrades.map((d) => (
            <span
              key={`down-${d}`}
              className="inline-flex items-center gap-0.5 text-[10px] px-1 py-0.5 bg-red-500/10 text-red-600 dark:text-red-400 border border-red-500/30"
              title={t(`notes.assistant.gradeDowngrade_${d}`, d)}
            >
              <TrendingDown className="h-2.5 w-2.5" />
              {t(`notes.assistant.gradeDowngrade_${d}_label`, d.replace(/_/g, ' '))}
            </span>
          ))}
          {quality.upgrades.map((u) => (
            <span
              key={`up-${u}`}
              className="inline-flex items-center gap-0.5 text-[10px] px-1 py-0.5 bg-green-500/10 text-green-600 dark:text-green-400 border border-green-500/30"
              title={t(`notes.assistant.gradeUpgrade_${u}`, u)}
            >
              <TrendingUp className="h-2.5 w-2.5" />
              {t(`notes.assistant.gradeUpgrade_${u}_label`, u.replace(/_/g, ' '))}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Bias flags block — small collapsed chip list grouped visually by
 * category color. Only renders when at least one bias is flagged.
 */
function BiasFlagsBlock({
  flags,
  t,
}: {
  flags: BiasFlag[];
  t: (key: string, options?: object) => string;
}) {
  return (
    <div>
      <div className="text-xs font-medium text-amber-600 dark:text-amber-400 mb-1">
        {t('notes.assistant.biasFlags', 'Potential Biases')} ({flags.length})
      </div>
      <div className="space-y-1.5">
        {flags.map((flag, i) => (
          <div
            key={`bias-${i}`}
            className="rounded border border-amber-500/30 bg-amber-500/5 p-2 text-[11px]"
          >
            <div className="flex items-center gap-1.5 mb-0.5">
              <span className="text-[9px] font-medium uppercase tracking-wide px-1 py-0.5 bg-amber-500/15 text-amber-700 dark:text-amber-300 border border-amber-500/30">
                {t(`notes.assistant.biasCategory_${flag.category}`, flag.category)}
              </span>
              <span className="font-medium">{flag.name.replace(/_/g, ' ')}</span>
            </div>
            <p className="text-muted-foreground leading-snug">{flag.description}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * Logical fallacy warnings block — amber alert blocks with category
 * label, fallacy name, and claim-specific description. Only renders
 * when at least one fallacy is flagged.
 */
function FallacyWarningsBlock({
  warnings,
  t,
}: {
  warnings: FallacyWarning[];
  t: (key: string, options?: object) => string;
}) {
  return (
    <div>
      <div className="text-xs font-medium text-red-600 dark:text-red-400 mb-1">
        {t('notes.assistant.fallacyWarnings', 'Logical Fallacies')} ({warnings.length})
      </div>
      <div className="space-y-1.5">
        {warnings.map((warning, i) => (
          <div
            key={`fallacy-${i}`}
            className="rounded border border-red-500/30 bg-red-500/5 p-2 text-[11px]"
          >
            <div className="flex items-center gap-1.5 mb-0.5">
              <AlertTriangle className="h-3 w-3 text-red-600 dark:text-red-400 shrink-0" />
              <span className="text-[9px] font-medium uppercase tracking-wide px-1 py-0.5 bg-red-500/15 text-red-700 dark:text-red-300 border border-red-500/30">
                {t(`notes.assistant.fallacyCategory_${warning.category}`, warning.category)}
              </span>
              <span className="font-medium">{warning.name.replace(/_/g, ' ')}</span>
            </div>
            <p className="text-muted-foreground leading-snug">{warning.description}</p>
          </div>
        ))}
      </div>
    </div>
  );
}
