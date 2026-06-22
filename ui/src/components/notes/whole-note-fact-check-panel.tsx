/**
 * WholeNoteFactCheckPanel.
 *
 * Side dialog opened from Alati → Provjeri činjenice u cijeloj bilješci
 * (or the mobile ⋯ overflow → Fact-check whole note). POSTs the full
 * note body + active research-context collection IDs to the backend,
 * which splits into sentences, classifies which are factual claims,
 * and runs verify_claim on up to 10 in parallel. Returns a report card
 * with per-sentence verdict + GRADE + bias / fallacy flags.
 *
 * Contract with the backend:
 *   POST /api/v1/notes/assistant/fact-check-whole
 *     body = { note_text, collection_ids, include_web, locale }
 *     resp = { success, total_sentences, candidates_classified,
 *              claims_verified, checks[], message }
 *
 *   `message` is a machine-readable status — not user-facing copy:
 *     "ok" | "empty_note" | "no_claims_found"
 *
 * Dialog stacks above the notes drawer portal via overlayZIndex=10050
 * (same pattern as BridgingConceptsPanel / TemplateGallery).
 *
 * No inline TipTap marks yet — flagged as a future
 * enhancement. The backend already returns char_offset / char_length
 * per claim so a later extension can render marks without a backend
 * change.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import {
  AlertTriangle,
  CheckCircle2,
  HelpCircle,
  RefreshCw,
  ScanSearch,
  ShieldCheck,
  SearchX,
  XCircle,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { toast } from '@/lib/toast-compat';
import {
  factCheckWholeNote,
  type ClaimCheck,
  type FactCheckWholeNoteResponse,
} from '@/lib/api-notes-assistant';

interface WholeNoteFactCheckPanelProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  noteText: string;
  collectionIds: string[];
}

const VERDICT_META: Record<ClaimCheck['verdict'], { icon: typeof CheckCircle2; tone: string; labelKey: string; labelFallback: string }> = {
  supported: { icon: CheckCircle2, tone: 'text-emerald-600 dark:text-emerald-400', labelKey: 'notes.factCheck.verdict.supported', labelFallback: 'Potvrđeno' },
  partially_supported: { icon: ShieldCheck, tone: 'text-amber-600 dark:text-amber-400', labelKey: 'notes.factCheck.verdict.partially', labelFallback: 'Djelomično' },
  contradicted: { icon: XCircle, tone: 'text-rose-600 dark:text-rose-400', labelKey: 'notes.factCheck.verdict.contradicted', labelFallback: 'Opovrgnuto' },
  unverified: { icon: HelpCircle, tone: 'text-muted-foreground', labelKey: 'notes.factCheck.verdict.unverified', labelFallback: 'Nepotvrđeno' },
};

const GRADE_TONE: Record<string, string> = {
  high: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300',
  moderate: 'bg-amber-500/15 text-amber-700 dark:text-amber-300',
  low: 'bg-orange-500/15 text-orange-700 dark:text-orange-300',
  very_low: 'bg-rose-500/15 text-rose-700 dark:text-rose-300',
};

export const WholeNoteFactCheckPanel: React.FC<WholeNoteFactCheckPanelProps> = ({
  open,
  onOpenChange,
  noteText,
  collectionIds,
}) => {
  const { t } = useTranslation();
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<FactCheckWholeNoteResponse | null>(null);

  const run = useCallback(async () => {
    setLoading(true);
    try {
      const res = await factCheckWholeNote(noteText, collectionIds, true);
      setResult(res);
    } catch (err) {
      console.error('[WholeNoteFactCheckPanel] factCheckWholeNote failed:', err);
      toast({
        title: t('notes.factCheck.toastError.title', 'Fact-check nije uspio'),
        description: t('notes.factCheck.toastError.description', 'Pokušaj ponovo za par sekundi.'),
        variant: 'destructive',
      });
      setResult({
        success: false,
        total_sentences: 0,
        candidates_classified: 0,
        claims_verified: 0,
        checks: [],
        message: 'error',
      });
    } finally {
      setLoading(false);
    }
  }, [noteText, collectionIds, t]);

  // Fire on open; reset on close so a fresh open always gets fresh data.
  useEffect(() => {
    if (!open) {
      setResult(null);
      return;
    }
    void run();
  // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional: only on open flip
  }, [open]);

  const renderEmpty = () => {
    const status = result?.message ?? 'empty';
    const copy = (() => {
      switch (status) {
        case 'empty_note':
          return t('notes.factCheck.emptyNote', 'Bilješka je prazna — dodaj sadržaj pa pokušaj ponovo.');
        case 'no_claims_found':
          return t('notes.factCheck.noClaimsFound', 'Nema činjeničnih tvrdnji za provjeriti.');
        case 'error':
          return t('notes.factCheck.graphQueryFailed', 'Provjera nije uspjela. Pokušaj ponovo.');
        default:
          return t('notes.factCheck.empty', 'Nema rezultata.');
      }
    })();
    return (
      <div className='flex flex-col items-center justify-center py-12 px-6 text-center gap-3'>
        <SearchX className='h-10 w-10 text-muted-foreground/40' />
        <p className='text-sm text-muted-foreground max-w-sm'>{copy}</p>
      </div>
    );
  };

  const renderCheck = (c: ClaimCheck) => {
    const meta = VERDICT_META[c.verdict] ?? VERDICT_META.unverified;
    const VerdictIcon = meta.icon;
    const grade = c.evidence_quality?.grade;
    const gradeTone = grade ? GRADE_TONE[grade] ?? 'bg-muted text-muted-foreground' : '';
    return (
      <div
        key={c.sentence_index}
        data-testid={`fact-check-row-${c.sentence_index}`}
        className='px-4 py-3 border-b border-border/60 last:border-b-0 hover:bg-accent/40 transition-colors'
      >
        <div className='flex items-start gap-3'>
          <div className={cn('mt-0.5 shrink-0 h-8 w-8 flex items-center justify-center bg-muted', meta.tone)}>
            <VerdictIcon className='h-4 w-4' />
          </div>
          <div className='flex-1 min-w-0 space-y-1.5'>
            <blockquote className='text-sm text-foreground/90 leading-snug border-l-2 border-border pl-2 italic'>
              {c.sentence}
            </blockquote>
            <div className='flex flex-wrap items-center gap-x-2 gap-y-1 text-xs'>
              <span className={cn('font-semibold', meta.tone)}>
                {t(meta.labelKey, meta.labelFallback)}
              </span>
              <span aria-hidden className='opacity-40'>·</span>
              <span className='text-muted-foreground'>
                {t('notes.factCheck.confidence', 'pouzdanost: {{level}}', { level: c.confidence })}
              </span>
              {grade && (
                <>
                  <span aria-hidden className='opacity-40'>·</span>
                  <span className={cn('px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide', gradeTone)}>
                    GRADE {grade}
                  </span>
                </>
              )}
              {c.bias_flags.length > 0 && (
                <span className='inline-flex items-center gap-1 text-amber-600 dark:text-amber-400'>
                  <AlertTriangle className='h-3 w-3' />
                  {t('notes.factCheck.biasCount', '{{count}} bias', { count: c.bias_flags.length })}
                </span>
              )}
              {c.fallacy_warnings.length > 0 && (
                <span className='inline-flex items-center gap-1 text-rose-600 dark:text-rose-400'>
                  <AlertTriangle className='h-3 w-3' />
                  {t('notes.factCheck.fallacyCount', '{{count}} fallacy', { count: c.fallacy_warnings.length })}
                </span>
              )}
            </div>
            {c.suggestion && (
              <p className='text-xs text-muted-foreground leading-snug'>
                <span className='font-medium text-foreground/70'>
                  {t('notes.factCheck.suggestionLabel', 'Prijedlog')}:{' '}
                </span>
                {c.suggestion}
              </p>
            )}
            {c.evidence_quality?.rationale && (
              <p className='text-xs text-muted-foreground leading-snug'>
                <span className='font-medium text-foreground/70'>
                  {t('notes.factCheck.rationaleLabel', 'Obrazloženje')}:{' '}
                </span>
                {c.evidence_quality.rationale}
              </p>
            )}
          </div>
        </div>
      </div>
    );
  };

  const hasResults = (result?.checks?.length ?? 0) > 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        data-testid='whole-note-fact-check-panel'
        overlayZIndex='10050'
        disableFullscreenOnMobile
        className='w-[95vw] max-w-3xl max-h-[85vh] p-0 gap-0 flex flex-col'
      >
        <DialogHeader className='px-4 pt-4 pb-3 border-b border-border shrink-0'>
          <div className='flex items-center gap-2'>
            <ScanSearch className='h-5 w-5 text-primary shrink-0' />
            <div className='flex-1 min-w-0'>
              <DialogTitle className='text-base font-semibold'>
                {t('notes.factCheck.title', 'Provjera činjenica')}
              </DialogTitle>
              <p className='mt-0.5 text-xs text-muted-foreground'>
                {t(
                  'notes.factCheck.subtitle',
                  'Svaka činjenična tvrdnja dobije verdikt, GRADE ocjenu i upozorenja o bias-u / fallacies-ima.',
                )}
              </p>
            </div>
            <Button
              variant='ghost'
              size='icon'
              className='h-8 w-8 shrink-0'
              disabled={loading}
              onClick={() => void run()}
              data-testid='whole-note-fact-check-refresh'
              aria-label={t('notes.factCheck.refresh', 'Osvježi')}
              title={t('notes.factCheck.refresh', 'Osvježi')}
            >
              <RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} />
            </Button>
          </div>
        </DialogHeader>

        <div className='flex-1 min-h-0 sm:min-h-[320px] overflow-y-auto'>
          {loading ? (
            <div className='flex flex-col items-center justify-center h-full py-16 gap-3 text-muted-foreground'>
              <div className='h-6 w-6 border-2 border-muted-foreground/30 border-t-primary rounded-full animate-spin' />
              <span className='text-xs'>{t('notes.factCheck.loading', 'Provjeravam tvrdnje…')}</span>
              <span className='text-[11px] text-muted-foreground/60'>
                {t('notes.factCheck.loadingHint', 'Može potrajati do 90 sekundi.')}
              </span>
            </div>
          ) : hasResults ? (
            result!.checks.map(renderCheck)
          ) : (
            renderEmpty()
          )}
        </div>

        <div className='flex items-center justify-between px-4 py-2.5 border-t border-border shrink-0 text-xs text-muted-foreground'>
          <span data-testid='whole-note-fact-check-counts'>
            {result
              ? t('notes.factCheck.counts', '{{verified}} provjereno od {{classified}} kandidata ({{total}} rečenica)', {
                  verified: result.claims_verified,
                  classified: result.candidates_classified,
                  total: result.total_sentences,
                })
              : '—'}
          </span>
          <Button
            type='button'
            variant='ghost'
            size='sm'
            className='h-7'
            onClick={() => onOpenChange(false)}
            data-testid='whole-note-fact-check-close'
          >
            {t('notes.factCheck.close', 'Zatvori')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
};
