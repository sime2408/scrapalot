/**
 * Hypothesis Panel — Competing Hypotheses (Feature 5)
 *
 * Shows 3-5 AI-generated competing hypotheses from notes context,
 * each scored on 5 quality criteria. Tabbed card view + comparison table.
 * Triggered by /hypothesis slash command.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FlaskConical, Loader2, Plus, X, BarChart2, ChevronRight } from 'lucide-react';
import { DraggablePanel, DragHandle } from './draggable-panel';
import { Editor } from '@tiptap/react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { generateHypothesis } from '@/lib/api-notes-assistant';

interface QualityScores {
  testability: number;
  falsifiability: number;
  parsimony: number;
  explanatory_power: number;
  novelty: number;
}

interface CompetingHypothesis {
  id: string;
  hypothesis: string;
  rationale: string;
  experimental_design: string;
  distinguishing_prediction: string;
  quality: QualityScores;
}

interface HypothesisResult {
  hypothesis: string;
  rationale: string;
  experimental_design: string;
  competing_hypotheses?: CompetingHypothesis[];
  research_question?: string;
  recommendation?: string;
}

interface HypothesisPanelProps {
  editor: Editor;
  context: string;
  collectionIds: string[];
  position: { top: number; left: number };
  onClose: () => void;
}

const QUALITY_LABELS: Record<keyof QualityScores, string> = {
  testability: 'notes.hypothesis.quality.testability',
  falsifiability: 'notes.hypothesis.quality.falsifiability',
  parsimony: 'notes.hypothesis.quality.parsimony',
  explanatory_power: 'notes.hypothesis.quality.explanatoryPower',
  novelty: 'notes.hypothesis.quality.novelty',
};

const TAB_COLORS = [
  'bg-blue-500/15 text-blue-600 dark:text-blue-400 border-blue-500/40',
  'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-emerald-500/40',
  'bg-amber-500/15 text-amber-600 dark:text-amber-400 border-amber-500/40',
  'bg-rose-500/15 text-rose-600 dark:text-rose-400 border-rose-500/40',
  'bg-violet-500/15 text-violet-600 dark:text-violet-400 border-violet-500/40',
];

const DOT_COLORS = ['bg-blue-500', 'bg-emerald-500', 'bg-amber-500', 'bg-rose-500', 'bg-violet-500'];

function QualityBar({ score, max = 5 }: { score: number; max?: number }) {
  const pct = (score / max) * 100;
  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 h-1.5 bg-muted">
        <div
          className={cn('h-full transition-all', pct >= 80 ? 'bg-emerald-500' : pct >= 60 ? 'bg-amber-500' : 'bg-rose-500')}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="text-[10px] tabular-nums text-muted-foreground w-4 text-right">{score}</span>
    </div>
  );
}

function totalScore(q: QualityScores): number {
  return q.testability + q.falsifiability + q.parsimony + q.explanatory_power + q.novelty;
}

export function HypothesisPanel({
  editor,
  context,
  collectionIds,
  position,
  onClose,
}: HypothesisPanelProps) {
  const { t } = useTranslation();
  const [loading, setLoading] = useState(true);
  const [result, setResult] = useState<HypothesisResult | null>(null);
  const [error, setError] = useState('');
  const [activeTab, setActiveTab] = useState(0); // 0-based hypothesis index, -1 = comparison
  const collectionIdsRef = useRef(collectionIds);
  collectionIdsRef.current = collectionIds;
  const hasRequested = useRef(false);

  useEffect(() => {
    if (hasRequested.current) return;
    hasRequested.current = true;
    let cancelled = false;

    async function generate() {
      setError('');
      try {
        const res = await generateHypothesis(context, collectionIdsRef.current);
        if (!cancelled) setResult(res as HypothesisResult);
      } catch (err) {
        console.error('Hypothesis generation failed:', err);
        if (!cancelled) setError(t('notes.assistant.hypothesisFailed', 'Could not generate hypothesis from this context.'));
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void generate();
    return () => { cancelled = true; };
  }, [context, t]);

  const hypotheses = useMemo(() => result?.competing_hypotheses || [], [result]);
  const hasCompeting = hypotheses.length >= 2;
  const activeHyp = hasCompeting ? hypotheses[activeTab >= 0 ? activeTab : 0] : null;

  const insertAll = useCallback(() => {
    if (!result) return;

    const content: Record<string, unknown>[] = [];

    if (result.research_question) {
      content.push(
        { type: 'heading', attrs: { level: 3 }, content: [{ type: 'text', text: result.research_question }] },
      );
    }

    if (hasCompeting) {
      hypotheses.forEach((h, _i) => {
        content.push(
          { type: 'heading', attrs: { level: 4 }, content: [{ type: 'text', text: `${h.id}: ${h.hypothesis.substring(0, 80)}…` }] },
          { type: 'paragraph', content: [{ type: 'text', marks: [{ type: 'bold' }], text: h.hypothesis }] },
          { type: 'paragraph', content: [{ type: 'text', text: `${t('notes.assistant.rationale', 'Rationale')}: ${h.rationale}` }] },
          { type: 'paragraph', content: [{ type: 'text', text: `${t('notes.hypothesis.distinguishingPrediction', 'Distinguishing prediction')}: ${h.distinguishing_prediction}` }] },
          { type: 'paragraph', content: [{ type: 'text', text: `${t('notes.hypothesis.qualityScore', 'Quality')}: ${totalScore(h.quality)}/25` }] },
        );
      });
      if (result.recommendation) {
        content.push(
          { type: 'heading', attrs: { level: 4 }, content: [{ type: 'text', text: t('notes.hypothesis.recommendation', 'Recommendation') }] },
          { type: 'paragraph', content: [{ type: 'text', text: result.recommendation }] },
        );
      }
    } else {
      // Fallback single hypothesis
      content.push(
        { type: 'heading', attrs: { level: 3 }, content: [{ type: 'text', text: t('notes.assistant.hypothesisLabel', 'Hypothesis') }] },
        { type: 'paragraph', content: [{ type: 'text', marks: [{ type: 'bold' }], text: result.hypothesis }] },
        { type: 'paragraph', content: [{ type: 'text', text: result.rationale }] },
      );
    }

    editor.chain().focus().insertContentAt(editor.state.selection.to, content).run();
    onClose();
  }, [editor, result, hypotheses, hasCompeting, onClose, t]);

  return (
    <DraggablePanel
      initialPosition={{ top: position.top, left: Math.min(position.left, window.innerWidth - 480) }}
      className="w-[460px]"
      onClickOutside={onClose}
    >
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-border">
        <span className="text-sm font-medium flex items-center gap-1.5 truncate min-w-0">
          <FlaskConical className="h-3.5 w-3.5 shrink-0" />
          <span className="truncate">
            {loading
              ? t('notes.assistant.generatingHypothesis', 'Generating hypotheses...')
              : hasCompeting
                ? t('notes.hypothesis.competingTitle', 'Competing Hypotheses')
                : t('notes.assistant.hypothesis', 'Hypothesis')}
          </span>
          {hasCompeting && (
            <span className="text-[10px] text-muted-foreground">({hypotheses.length})</span>
          )}
        </span>
        <div className="flex items-center gap-0.5 shrink-0">
          <DragHandle />
          <Button variant="ghost" size="icon" className="h-6 w-6" onClick={onClose}>
            <X className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      {/* Research question */}
      {result?.research_question && (
        <div className="px-3 py-1.5 border-b border-border bg-muted/30">
          <p className="text-[11px] text-muted-foreground italic text-left">{result.research_question}</p>
        </div>
      )}

      {/* Tab bar */}
      {hasCompeting && (
        <div className="flex items-center gap-1 px-3 py-1.5 border-b border-border overflow-x-auto">
          {hypotheses.map((h, i) => (
            <button
              key={h.id}
              onClick={() => setActiveTab(i)}
              className={cn(
                'text-[10px] font-semibold px-2 py-0.5 border transition-colors shrink-0',
                activeTab === i ? TAB_COLORS[i % TAB_COLORS.length] : 'border-border text-muted-foreground hover:text-foreground',
              )}
            >
              {h.id}
            </button>
          ))}
          <button
            onClick={() => setActiveTab(-1)}
            className={cn(
              'text-[10px] font-semibold px-2 py-0.5 border transition-colors shrink-0 flex items-center gap-1',
              activeTab === -1 ? 'bg-primary/15 text-primary border-primary/40' : 'border-border text-muted-foreground hover:text-foreground',
            )}
          >
            <BarChart2 className="h-3 w-3" />
            {t('notes.hypothesis.comparison', 'Compare')}
          </button>
        </div>
      )}

      {/* Content */}
      <div className="flex-1 min-h-0 overflow-y-auto max-h-[400px]">
        {loading ? (
          <div className="flex flex-col items-center justify-center py-8 gap-2">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            <span className="text-xs text-muted-foreground/60">{t('notes.assistant.analyzing_context', 'Analyzing context...')}</span>
          </div>
        ) : error || !result ? (
          <div className="py-6 text-center text-sm text-muted-foreground">
            {error || t('notes.assistant.hypothesisFailed', 'Could not generate hypothesis.')}
          </div>
        ) : activeTab === -1 && hasCompeting ? (
          /* Comparison table */
          <div className="p-3">
            <table className="w-full text-[11px]">
              <thead>
                <tr className="border-b border-border">
                  <th className="text-left py-1 pr-2 text-muted-foreground font-medium">{t('notes.hypothesis.criteria', 'Criteria')}</th>
                  {hypotheses.map((h, i) => (
                    <th key={h.id} className="text-center py-1 px-1 font-semibold">
                      <span className={cn('inline-block w-2 h-2 mr-1', DOT_COLORS[i % DOT_COLORS.length])} />
                      {h.id}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {(Object.keys(QUALITY_LABELS) as (keyof QualityScores)[]).map((key) => (
                  <tr key={key} className="border-b border-border/50">
                    <td className="py-1.5 pr-2 text-muted-foreground">{t(QUALITY_LABELS[key], key)}</td>
                    {hypotheses.map((h) => (
                      <td key={h.id} className="text-center py-1.5 px-1 tabular-nums font-medium">
                        {h.quality[key]}
                      </td>
                    ))}
                  </tr>
                ))}
                <tr className="font-semibold">
                  <td className="py-1.5 pr-2">{t('notes.hypothesis.total', 'Total')}</td>
                  {hypotheses.map((h) => (
                    <td key={h.id} className="text-center py-1.5 px-1 tabular-nums">
                      {totalScore(h.quality)}/25
                    </td>
                  ))}
                </tr>
              </tbody>
            </table>
            {result.recommendation && (
              <div className="mt-3 border-l-2 border-primary bg-primary/5 px-3 py-2">
                <div className="text-[10px] font-semibold uppercase tracking-wider text-primary mb-1">
                  {t('notes.hypothesis.recommendation', 'Recommendation')}
                </div>
                <p className="text-xs text-foreground leading-relaxed text-left">{result.recommendation}</p>
              </div>
            )}
          </div>
        ) : activeHyp ? (
          /* Single hypothesis card */
          <div className="p-3 space-y-3">
            <div>
              <div className="text-xs font-medium text-muted-foreground mb-1">{activeHyp.id}</div>
              <div className="text-sm font-medium leading-relaxed text-left">{activeHyp.hypothesis}</div>
            </div>
            <div>
              <div className="text-[11px] font-medium text-muted-foreground mb-1">{t('notes.assistant.rationale', 'Rationale')}</div>
              <div className="text-xs leading-relaxed text-muted-foreground text-left">{activeHyp.rationale}</div>
            </div>
            <div>
              <div className="text-[11px] font-medium text-muted-foreground mb-1">{t('notes.hypothesis.distinguishingPrediction', 'Distinguishing prediction')}</div>
              <div className="text-xs leading-relaxed text-muted-foreground text-left flex items-start gap-1">
                <ChevronRight className="h-3 w-3 mt-0.5 shrink-0 text-primary" />
                <span>{activeHyp.distinguishing_prediction}</span>
              </div>
            </div>
            {activeHyp.experimental_design && (
              <div>
                <div className="text-[11px] font-medium text-muted-foreground mb-1">{t('notes.assistant.experimentalDesign', 'Experimental Design')}</div>
                <div className="text-xs leading-relaxed text-muted-foreground text-left">{activeHyp.experimental_design}</div>
              </div>
            )}
            <div>
              <div className="text-[11px] font-medium text-muted-foreground mb-1.5">{t('notes.hypothesis.qualityScore', 'Quality')}</div>
              <div className="space-y-1">
                {(Object.keys(QUALITY_LABELS) as (keyof QualityScores)[]).map((key) => (
                  <div key={key} className="flex items-center gap-2">
                    <span className="text-[10px] text-muted-foreground w-24 shrink-0">{t(QUALITY_LABELS[key], key)}</span>
                    <QualityBar score={activeHyp.quality[key]} />
                  </div>
                ))}
              </div>
              <div className="text-[10px] text-muted-foreground mt-1 text-right tabular-nums">
                {t('notes.hypothesis.total', 'Total')}: {totalScore(activeHyp.quality)}/25
              </div>
            </div>
          </div>
        ) : (
          /* Fallback single hypothesis (no competing data) */
          <div className="p-3 space-y-3">
            <div>
              <div className="text-xs font-medium text-muted-foreground mb-1">{t('notes.assistant.hypothesisLabel', 'Hypothesis')}</div>
              <div className="text-sm font-medium leading-relaxed text-left">{result.hypothesis}</div>
            </div>
            <div>
              <div className="text-xs font-medium text-muted-foreground mb-1">{t('notes.assistant.rationale', 'Rationale')}</div>
              <div className="text-xs leading-relaxed text-muted-foreground text-left">{result.rationale}</div>
            </div>
            {result.experimental_design && (
              <div>
                <div className="text-xs font-medium text-muted-foreground mb-1">{t('notes.assistant.experimentalDesign', 'Experimental Design')}</div>
                <div className="text-xs leading-relaxed text-muted-foreground text-left">{result.experimental_design}</div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Footer */}
      {result && (
        <div className="flex justify-end gap-2 px-3 py-2 border-t border-border">
          <Button variant="outline" size="sm" className="h-7 text-xs" onClick={onClose}>
            {t('common.cancel', 'Cancel')}
          </Button>
          <Button size="sm" className="h-7 text-xs" onClick={insertAll}>
            <Plus className="h-3 w-3 mr-1" />
            {hasCompeting
              ? t('notes.hypothesis.insertAll', 'Insert all hypotheses')
              : t('notes.assistant.insertHypothesis', 'Insert into Notes')}
          </Button>
        </div>
      )}
    </DraggablePanel>
  );
}
