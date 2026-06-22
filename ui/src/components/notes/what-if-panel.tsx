/**
 * What-If Oracle Panel — Scenario Analysis (Feature 6)
 *
 * Shows 6 AI-generated scenario branches (Best/Likely/Worst/WildCard/
 * Contrarian/SecondOrder) with probabilities, timelines, and a synthesis
 * section. Triggered by /what-if slash command.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  GitBranchPlus,
  Loader2,
  Plus,
  X,
  ChevronDown,
  ChevronRight,
  Shield,
  Zap,
  Eye,
  Lightbulb,
} from 'lucide-react';
import { DraggablePanel, DragHandle } from './draggable-panel';
import { Editor } from '@tiptap/react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import {
  generateScenarioAnalysis,
  ScenarioAnalysisResult,
  ScenarioBranch,
} from '@/lib/api-notes-assistant';

interface WhatIfPanelProps {
  editor: Editor;
  context: string;
  collectionIds: string[];
  position: { top: number; left: number };
  onClose: () => void;
}

const BRANCH_CONFIG: Record<string, { label: string; color: string; dotColor: string; emoji: string }> = {
  best_case: { label: 'notes.whatIf.bestCase', color: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-emerald-500/40', dotColor: 'bg-emerald-500', emoji: '🌟' },
  likely_case: { label: 'notes.whatIf.likelyCase', color: 'bg-blue-500/15 text-blue-600 dark:text-blue-400 border-blue-500/40', dotColor: 'bg-blue-500', emoji: '📊' },
  worst_case: { label: 'notes.whatIf.worstCase', color: 'bg-rose-500/15 text-rose-600 dark:text-rose-400 border-rose-500/40', dotColor: 'bg-rose-500', emoji: '⚠️' },
  wild_card: { label: 'notes.whatIf.wildCard', color: 'bg-violet-500/15 text-violet-600 dark:text-violet-400 border-violet-500/40', dotColor: 'bg-violet-500', emoji: '🃏' },
  contrarian: { label: 'notes.whatIf.contrarian', color: 'bg-amber-500/15 text-amber-600 dark:text-amber-400 border-amber-500/40', dotColor: 'bg-amber-500', emoji: '🔄' },
  second_order: { label: 'notes.whatIf.secondOrder', color: 'bg-cyan-500/15 text-cyan-600 dark:text-cyan-400 border-cyan-500/40', dotColor: 'bg-cyan-500', emoji: '🌊' },
};

function ProbabilityBar({ value }: { value: number }) {
  const pct = Math.round(value * 100);
  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 h-1.5 bg-muted">
        <div
          className={cn('h-full transition-all', pct >= 40 ? 'bg-emerald-500' : pct >= 20 ? 'bg-amber-500' : 'bg-muted-foreground/40')}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="text-xs text-muted-foreground tabular-nums w-8 text-right">{pct}%</span>
    </div>
  );
}

export function WhatIfPanel({ editor, context, collectionIds, position, onClose }: WhatIfPanelProps) {
  const { t } = useTranslation();
  const [loading, setLoading] = useState(true);
  const [result, setResult] = useState<ScenarioAnalysisResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expandedBranches, setExpandedBranches] = useState<Set<string>>(new Set());
  const [showSynthesis, setShowSynthesis] = useState(false);
  const fetchedRef = useRef(false);

  useEffect(() => {
    if (fetchedRef.current || !context) return;
    fetchedRef.current = true;

    setLoading(true);
    generateScenarioAnalysis(context, collectionIds)
      .then((data) => {
        if (data.error) {
          setError(data.error);
        } else {
          setResult(data);
          // Auto-expand likely case
          setExpandedBranches(new Set(['likely_case']));
          setShowSynthesis(true);
        }
      })
      .catch((e) => setError(e.message || 'Failed to generate scenario analysis'))
      .finally(() => setLoading(false));
  }, [context, collectionIds]);

  const toggleBranch = useCallback((branchType: string) => {
    setExpandedBranches(prev => {
      const next = new Set(prev);
      if (next.has(branchType)) next.delete(branchType);
      else next.add(branchType);
      return next;
    });
  }, []);

  const insertIntoEditor = useCallback(() => {
    if (!result || !editor) return;

    const lines: string[] = [];
    lines.push(`### ${result.scenario_question}\n`);

    for (const branch of result.branches) {
      const cfg = BRANCH_CONFIG[branch.branch_type] || BRANCH_CONFIG.likely_case;
      const pct = Math.round(branch.probability * 100);
      lines.push(`#### ${cfg.emoji} ${branch.title} (${pct}%, ${branch.timeframe})\n`);
      lines.push(`${branch.narrative}\n`);
      if (branch.trigger_conditions.length > 0) {
        lines.push(`**${t('notes.whatIf.triggers')}:** ${branch.trigger_conditions.join('; ')}\n`);
      }
      if (branch.consequences.length > 0) {
        lines.push(`**${t('notes.whatIf.consequences')}:**`);
        for (const c of branch.consequences) {
          lines.push(`- ${c}`);
        }
        lines.push('');
      }
    }

    if (result.synthesis) {
      lines.push(`#### 💡 ${t('notes.whatIf.synthesis')}\n`);
      if (result.synthesis.robust_actions.length > 0) {
        lines.push(`**${t('notes.whatIf.robustActions')}:**`);
        for (const a of result.synthesis.robust_actions) lines.push(`- ${a}`);
        lines.push('');
      }
      if (result.synthesis.hedge_actions.length > 0) {
        lines.push(`**${t('notes.whatIf.hedgeActions')}:**`);
        for (const a of result.synthesis.hedge_actions) lines.push(`- ${a}`);
        lines.push('');
      }
      if (result.synthesis.one_percent_insight) {
        lines.push(`> **${t('notes.whatIf.onePercentInsight')}:** ${result.synthesis.one_percent_insight}\n`);
      }
    }

    const markdown = lines.join('\n');
    const { from } = editor.state.selection;
    editor.chain().focus().insertContentAt(from, markdown).run();
    onClose();
  }, [result, editor, onClose, t]);

  const renderBranch = (branch: ScenarioBranch) => {
    const cfg = BRANCH_CONFIG[branch.branch_type] || BRANCH_CONFIG.likely_case;
    const expanded = expandedBranches.has(branch.branch_type);

    return (
      <div key={branch.branch_type} className="border border-border">
        <button
          className={cn(
            'w-full flex items-center gap-2 px-3 py-2 text-left transition-colors',
            'hover:bg-accent/50',
            expanded && cfg.color,
          )}
          onClick={() => toggleBranch(branch.branch_type)}
        >
          {expanded ? <ChevronDown className="h-3.5 w-3.5 flex-shrink-0" /> : <ChevronRight className="h-3.5 w-3.5 flex-shrink-0" />}
          <span className="text-sm">{cfg.emoji}</span>
          <span className="text-sm font-medium flex-1 truncate">{branch.title}</span>
          <span className="text-xs text-muted-foreground tabular-nums">{Math.round(branch.probability * 100)}%</span>
        </button>

        {expanded && (
          <div className="px-3 py-2 space-y-2 border-t border-border/50 bg-muted/20">
            {/* Probability + Confidence + Timeframe */}
            <div className="flex items-center gap-4 text-xs text-muted-foreground">
              <span>{t('notes.whatIf.timeframe')}: <strong className="text-foreground">{branch.timeframe}</strong></span>
              <span>{t('notes.whatIf.confidence')}: <strong className="text-foreground">{Math.round(branch.confidence * 100)}%</strong></span>
            </div>

            <ProbabilityBar value={branch.probability} />

            {/* Narrative */}
            <p className="text-sm text-foreground/90 leading-relaxed">{branch.narrative}</p>

            {/* Trigger conditions */}
            {branch.trigger_conditions.length > 0 && (
              <div>
                <div className="text-xs font-medium text-muted-foreground mb-1 flex items-center gap-1">
                  <Zap className="h-3 w-3" />
                  {t('notes.whatIf.triggers')}
                </div>
                <ul className="space-y-0.5">
                  {branch.trigger_conditions.map((tc, i) => (
                    <li key={i} className="text-xs text-foreground/80 pl-3 relative before:absolute before:left-0 before:top-1.5 before:w-1.5 before:h-1.5 before:bg-muted-foreground/30">
                      {tc}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {/* Consequences timeline */}
            {branch.consequences.length > 0 && (
              <div>
                <div className="text-xs font-medium text-muted-foreground mb-1">{t('notes.whatIf.consequences')}</div>
                <div className="space-y-1 pl-2 border-l border-border">
                  {branch.consequences.map((c, i) => (
                    <div key={i} className="text-xs text-foreground/80 pl-2 relative">
                      <div className="absolute -left-[5px] top-1.5 w-2 h-2 border border-border bg-background" />
                      {c}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    );
  };

  return (
    <DraggablePanel
      initialPosition={position}
      className="w-[420px] max-w-[90vw]"
      data-testid="what-if-panel"
    >
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-border bg-muted/30">
        <DragHandle>
          <div className="flex items-center gap-2">
            <GitBranchPlus className="h-4 w-4 text-primary" />
            <span className="text-sm font-medium">{t('notes.whatIf.title', 'What-If Oracle')}</span>
          </div>
        </DragHandle>
        <div className="flex items-center gap-1">
          {result && (
            <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={insertIntoEditor}>
              <Plus className="h-3 w-3 mr-1" />
              {t('notes.insert', 'Insert')}
            </Button>
          )}
          <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={onClose}>
            <X className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      {/* Content */}
      <div className="max-h-[60vh] overflow-y-auto">
        {loading && (
          <div className="flex items-center justify-center gap-2 py-12 text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            <span className="text-sm">{t('notes.whatIf.analyzing', 'Analyzing scenarios...')}</span>
          </div>
        )}

        {error && (
          <div className="px-3 py-4 text-sm text-destructive">{error}</div>
        )}

        {result && !error && (
          <div className="space-y-0">
            {/* Question */}
            <div className="px-3 py-2 bg-muted/20 border-b border-border">
              <p className="text-xs text-muted-foreground">{t('notes.whatIf.question', 'Scenario question')}</p>
              <p className="text-sm font-medium">{result.scenario_question}</p>
            </div>

            {/* Branches */}
            {result.branches.map(renderBranch)}

            {/* Synthesis */}
            {result.synthesis && (
              <div className="border-t border-border">
                <button
                  className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-accent/50 transition-colors"
                  onClick={() => setShowSynthesis(!showSynthesis)}
                >
                  {showSynthesis ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                  <Lightbulb className="h-3.5 w-3.5 text-amber-500" />
                  <span className="text-sm font-medium">{t('notes.whatIf.synthesis', 'Synthesis')}</span>
                </button>

                {showSynthesis && (
                  <div className="px-3 pb-3 space-y-3">
                    {/* Robust actions */}
                    {result.synthesis.robust_actions.length > 0 && (
                      <div>
                        <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground mb-1">
                          <Shield className="h-3 w-3 text-emerald-500" />
                          {t('notes.whatIf.robustActions', 'Robust actions')}
                        </div>
                        {result.synthesis.robust_actions.map((a, i) => (
                          <div key={i} className="text-xs text-foreground/80 pl-4 py-0.5">• {a}</div>
                        ))}
                      </div>
                    )}

                    {/* Hedge actions */}
                    {result.synthesis.hedge_actions.length > 0 && (
                      <div>
                        <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground mb-1">
                          <Shield className="h-3 w-3 text-amber-500" />
                          {t('notes.whatIf.hedgeActions', 'Hedge actions')}
                        </div>
                        {result.synthesis.hedge_actions.map((a, i) => (
                          <div key={i} className="text-xs text-foreground/80 pl-4 py-0.5">• {a}</div>
                        ))}
                      </div>
                    )}

                    {/* Decision triggers */}
                    {result.synthesis.decision_triggers.length > 0 && (
                      <div>
                        <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground mb-1">
                          <Eye className="h-3 w-3 text-blue-500" />
                          {t('notes.whatIf.decisionTriggers', 'Decision triggers')}
                        </div>
                        {result.synthesis.decision_triggers.map((d, i) => (
                          <div key={i} className="text-xs text-foreground/80 pl-4 py-0.5">• {d}</div>
                        ))}
                      </div>
                    )}

                    {/* 1% Insight */}
                    {result.synthesis.one_percent_insight && (
                      <div className="bg-primary/5 border border-primary/20 p-2.5">
                        <div className="flex items-center gap-1.5 text-xs font-semibold text-primary mb-1">
                          <Lightbulb className="h-3 w-3" />
                          {t('notes.whatIf.onePercentInsight', 'The 1% Insight')}
                        </div>
                        <p className="text-xs text-foreground/90 leading-relaxed">{result.synthesis.one_percent_insight}</p>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </DraggablePanel>
  );
}
