/**
 * ExplainPanel — sidebar / bottom sheet that shows an AI explanation of a
 * passage the reader highlighted in the PDF / EPUB viewer.
 *
 * Uses the shared Sheet primitive. On desktop it docks as a right-side panel,
 * on mobile it becomes a bottom sheet — both driven by `useIsMobile`.
 *
 * Backend: POST /api/v1/explain/selection (fast direct-LLM path, ~1-2 s).
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Sheet, SheetContent, SheetTitle, SheetDescription } from '@/components/ui/sheet';
import { Loader2, RefreshCw, Sparkles } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useTranslation } from 'react-i18next';
import { useIsMobile } from '@/hooks/use-mobile';
import { explainSelection, type ExplainDepth, type ExplainDetectedType } from '@/lib/api-explain';

interface ExplainPanelProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Text the reader highlighted. */
  selectedText: string;
  /** Paragraph preceding the selection — used to ground the explanation. */
  contextBefore?: string;
  /** Paragraph following the selection — used to ground the explanation. */
  contextAfter?: string;
  /** Document title — passed through to the LLM prompt as weak grounding. */
  documentTitle?: string;
}

const DEPTH_ORDER: ExplainDepth[] = ['simple', 'standard', 'technical'];

const DETECTED_LABEL_KEY: Record<Exclude<ExplainDetectedType, null>, string> = {
  math: 'explain.tags.math',
  code: 'explain.tags.code',
  foreign: 'explain.tags.foreign',
  technical: 'explain.tags.technical',
  figure: 'explain.tags.figure',
  quote: 'explain.tags.quote',
};

export function ExplainPanel({
  open,
  onOpenChange,
  selectedText,
  contextBefore,
  contextAfter,
  documentTitle,
}: ExplainPanelProps) {
  const { t, i18n } = useTranslation();
  const isMobile = useIsMobile();

  const [depth, setDepth] = useState<ExplainDepth>('standard');
  const [explanation, setExplanation] = useState<string>('');
  const [detectedType, setDetectedType] = useState<ExplainDetectedType>(null);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string>('');

  // Reset state whenever the user opens the panel with a new selection.
  // Depth choice is preserved across selections — it's a persistent preference.
  useEffect(() => {
    if (!open) return;
    setExplanation('');
    setDetectedType(null);
    setError('');
  }, [open, selectedText]);

  const runExplain = useCallback(async (targetDepth: ExplainDepth) => {
    if (!selectedText.trim()) return;
    setLoading(true);
    setError('');
    setExplanation('');
    setDetectedType(null);
    try {
      const resp = await explainSelection({
        text: selectedText,
        language: i18n.language || 'en',
        depth: targetDepth,
        contextBefore,
        contextAfter,
        documentTitle,
      });
      if (resp.error === 'not_explainable') {
        setError(t('explain.notExplainable', 'This selection looks like noise or an unsupported fragment.'));
        return;
      }
      if (resp.error) {
        setError(resp.error);
        return;
      }
      setExplanation(resp.explanation);
      setDetectedType(resp.detected_type);
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    } finally {
      setLoading(false);
    }
  }, [selectedText, i18n.language, contextBefore, contextAfter, documentTitle, t]);

  // Fire the first call when the panel opens.
  useEffect(() => {
    if (open && selectedText.trim() && !explanation && !loading && !error) {
      void runExplain(depth);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- omits `depth` and `runExplain`; depth changes trigger re-fetch via onDepthChange to avoid double-fetch
  }, [open, selectedText]);

  const onDepthChange = useCallback((next: ExplainDepth) => {
    setDepth(next);
    void runExplain(next);
  }, [runExplain]);

  const detectedLabel = useMemo(() => {
    if (!detectedType) return null;
    const key = DETECTED_LABEL_KEY[detectedType];
    return key ? t(key) : null;
  }, [detectedType, t]);

  const side = isMobile ? 'bottom' : 'right';

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side={side}
        data-testid="explain-panel"
        className={cn(
          'flex flex-col gap-0 p-0 border-border',
          isMobile
            ? 'h-[85vh] max-h-[85vh] rounded-t-none'
            : 'w-[420px] sm:max-w-[420px]'
        )}
        /* Keep z-index above the PDF annotation overlays (z-[9999])
           but below global toasts. */
        style={{ zIndex: 10010 }}
        hideCloseButton={false}
      >
        {/* Header */}
        <div className="flex items-start gap-3 px-5 pt-5 pb-3 border-b border-border">
          <div className="w-8 h-8 flex items-center justify-center bg-primary/10 text-primary flex-shrink-0">
            <Sparkles className="w-4 h-4" />
          </div>
          <div className="flex-1 min-w-0 pr-8">
            <SheetTitle className="text-sm font-semibold leading-tight">
              {t('explain.title', 'AI explanation')}
            </SheetTitle>
            <SheetDescription className="text-xs mt-0.5">
              {t('explain.subtitle', 'Understand what this passage means')}
            </SheetDescription>
          </div>
        </div>

        {/* Selected passage preview */}
        <div className="px-5 py-3 border-b border-border bg-muted/30">
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">
            {t('explain.selected', 'Selected')}
          </div>
          <blockquote
            data-testid="explain-selected-text"
            className="text-xs text-foreground border-l-2 border-primary/60 pl-2 line-clamp-4 italic"
          >
            {selectedText}
          </blockquote>
        </div>

        {/* Depth selector — larger touch targets on mobile */}
        <div className="px-5 py-3 border-b border-border">
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-2">
            {t('explain.depthLabel', 'Depth')}
          </div>
          <div
            role="radiogroup"
            aria-label={t('explain.depthLabel', 'Depth')}
            className="grid grid-cols-3 gap-2"
          >
            {DEPTH_ORDER.map((d) => {
              const active = d === depth;
              return (
                <button
                  key={d}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  data-testid={`explain-depth-${d}`}
                  onClick={() => onDepthChange(d)}
                  disabled={loading}
                  className={cn(
                    'text-xs py-2 border transition-colors min-h-[44px]',
                    active
                      ? 'border-primary bg-primary/10 text-primary font-medium'
                      : 'border-border bg-transparent hover:bg-accent hover:text-accent-foreground',
                    loading && 'opacity-50 cursor-not-allowed'
                  )}
                >
                  {t(`explain.depth.${d}`, d)}
                </button>
              );
            })}
          </div>
        </div>

        {/* Result area */}
        <div className="flex-1 min-h-0 overflow-y-auto px-5 py-4">
          {loading && (
            <div
              data-testid="explain-loading"
              className="flex items-center gap-2 text-xs text-muted-foreground"
            >
              <Loader2 className="w-4 h-4 animate-spin" />
              {t('explain.loading', 'Explaining…')}
            </div>
          )}

          {!loading && error && (
            <div
              data-testid="explain-error"
              className="text-xs text-destructive border border-destructive/40 bg-destructive/5 px-3 py-2"
            >
              {error}
            </div>
          )}

          {!loading && !error && explanation && (
            <div data-testid="explain-result">
              {detectedLabel && (
                <span className="inline-block text-[10px] uppercase tracking-wider px-1.5 py-0.5 mb-3 bg-accent text-accent-foreground border border-border">
                  {detectedLabel}
                </span>
              )}
              <p className="text-sm leading-relaxed whitespace-pre-wrap text-foreground">
                {explanation}
              </p>
            </div>
          )}

          {!loading && !error && !explanation && (
            <div className="text-xs text-muted-foreground">
              {t('explain.idle', 'Waiting for selection…')}
            </div>
          )}
        </div>

        {/* Footer: regenerate */}
        <div className="border-t border-border px-5 py-3 flex items-center justify-between gap-2">
          <button
            type="button"
            data-testid="explain-regenerate"
            onClick={() => void runExplain(depth)}
            disabled={loading || !selectedText.trim()}
            className={cn(
              'text-xs flex items-center gap-1.5 px-3 py-2 border border-border min-h-[40px]',
              'hover:bg-accent hover:text-accent-foreground transition-colors',
              (loading || !selectedText.trim()) && 'opacity-50 cursor-not-allowed'
            )}
          >
            <RefreshCw className={cn('w-3.5 h-3.5', loading && 'animate-spin')} />
            {t('explain.regenerate', 'Regenerate')}
          </button>
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            className="text-xs px-3 py-2 min-h-[40px] text-muted-foreground hover:text-foreground transition-colors"
          >
            {t('common.close', 'Close')}
          </button>
        </div>
      </SheetContent>
    </Sheet>
  );
}
