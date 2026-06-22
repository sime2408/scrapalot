import React, { useState } from 'react';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from '@/components/ui/sheet';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { useTranslation } from 'react-i18next';
import { RagTraceData } from '@/types/rag-trace';
import { cn } from '@/lib/utils';

interface RagTraceSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  traceData?: RagTraceData;
}

function formatNumber(n: number | undefined): string {
  if (n === undefined || n === null) return '-';
  return n.toLocaleString();
}

function formatCost(cost: number | undefined): string {
  if (cost === undefined || cost === null) return '-';
  if (cost < 0.001) return `$${cost.toFixed(6)}`;
  if (cost < 0.01) return `$${cost.toFixed(4)}`;
  return `$${cost.toFixed(3)}`;
}

function formatSpeed(tps: number | undefined): string {
  if (tps === undefined || tps === null) return '-';
  return `${tps.toFixed(1)} tok/s`;
}

function formatLatency(ms: number | undefined): string {
  if (ms === undefined || ms === null) return '-';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}

// Context window bar segment
function BarSegment({ value, total, className, label }: {
  value: number;
  total: number;
  className: string;
  label: string;
}) {
  const pct = total > 0 ? Math.min((value / total) * 100, 100) : 0;
  if (pct < 0.5) return null;
  return (
    <div
      className={cn('h-full transition-all', className)}
      style={{ width: `${pct}%` }}
      title={`${label}: ${formatNumber(value)} (${pct.toFixed(1)}%)`}
    />
  );
}

// Metric cell
function MetricCell({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="flex flex-col items-center gap-0.5">
      <span className="text-[11px] text-muted-foreground uppercase tracking-wide">{label}</span>
      <span className="text-base font-semibold tabular-nums">{value}</span>
      {sub && <span className="text-[10px] text-muted-foreground">{sub}</span>}
    </div>
  );
}

// ---------- Tab: Tokens ----------
function TokensTab({ data }: { data: RagTraceData }) {
  const { t } = useTranslation();
  const input = data.inputTokens ?? 0;
  const output = data.outputTokens ?? 0;
  const total = data.totalTokens ?? (input + output);
  const ctxWindow = data.contextWindowSize || 128000; // Default to 128k
  const used = total;
  const remaining = Math.max(ctxWindow - used, 0);

  return (
    <div className="flex flex-col gap-4 p-4">
      {/* Context window bar */}
      <div>
        <div className="text-xs text-muted-foreground mb-1.5">{t('ragTrace.tokens.contextWindow')}</div>
        <div className="flex h-3 w-full overflow-hidden border border-border bg-muted">
          <BarSegment value={input} total={ctxWindow} className="bg-primary" label={t('ragTrace.tokens.input')} />
          <BarSegment value={output} total={ctxWindow} className="bg-primary/60" label={t('ragTrace.tokens.output')} />
        </div>
        <div className="flex justify-between text-[10px] text-muted-foreground mt-1">
          <span>{formatNumber(used)} {t('ragTrace.tokens.used')}</span>
          <span>{formatNumber(remaining)} {t('ragTrace.tokens.remaining')}</span>
        </div>
      </div>

      {/* Metrics grid */}
      <div className="grid grid-cols-3 gap-4 py-2 border-y border-border">
        <MetricCell label={t('ragTrace.tokens.input')} value={formatNumber(input)} />
        <MetricCell label={t('ragTrace.tokens.output')} value={formatNumber(output)} />
        <MetricCell label={t('ragTrace.tokens.total')} value={formatNumber(total)} />
      </div>

      {/* Performance */}
      <div className="grid grid-cols-2 gap-4">
        <MetricCell label={t('ragTrace.tokens.latency')} value={formatLatency(data.latencyMs)} />
        <MetricCell label={t('ragTrace.tokens.speed')} value={formatSpeed(data.tokensPerSecond)} />
      </div>

      {/* Model info */}
      {(data.provider || data.model) && (
        <div className="text-xs text-muted-foreground border-t border-border pt-2">
          {data.provider && <span>{data.provider}</span>}
          {data.provider && data.model && <span> / </span>}
          {data.model && <span className="font-medium">{data.model}</span>}
        </div>
      )}
    </div>
  );
}

// ---------- Tab: Cost ----------
function CostTab({ data }: { data: RagTraceData }) {
  const { t } = useTranslation();
  const totalCost = data.costUsd;

  // Estimate input/output split based on typical OpenAI ratios (1:4 input:output cost ratio)
  const inputTokens = data.inputTokens ?? 0;
  const outputTokens = data.outputTokens ?? 0;
  const hasBreakdown = typeof totalCost === 'number' && inputTokens > 0 && outputTokens > 0;

  let inputCost: number | undefined;
  let outputCost: number | undefined;
  if (hasBreakdown && totalCost !== undefined) {
    // Approximate split: input is ~20% of cost per token vs output
    const inputWeight = inputTokens;
    const outputWeight = outputTokens * 4;
    const totalWeight = inputWeight + outputWeight;
    inputCost = totalCost * (inputWeight / totalWeight);
    outputCost = totalCost * (outputWeight / totalWeight);
  }

  return (
    <div className="flex flex-col gap-4 p-4">
      <div className="flex flex-col items-center gap-1 py-4">
        <span className="text-[11px] text-muted-foreground uppercase tracking-wide">{t('ragTrace.cost.totalCost')}</span>
        <span className="text-2xl font-bold tabular-nums">{formatCost(totalCost)}</span>
        <span className="text-[10px] text-muted-foreground">
          {typeof totalCost === 'number' ? t('ragTrace.cost.fromProvider') : t('ragTrace.cost.estimated')}
        </span>
      </div>

      {hasBreakdown && (
        <div className="grid grid-cols-2 gap-4 border-t border-border pt-3">
          <MetricCell label={t('ragTrace.cost.inputCost')} value={formatCost(inputCost)} />
          <MetricCell label={t('ragTrace.cost.outputCost')} value={formatCost(outputCost)} />
        </div>
      )}
    </div>
  );
}

// ---------- Tab: Prompt ----------
function PromptTab({ data }: { data: RagTraceData }) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const preview = data.systemPromptPreview ?? '';
  const fullLength = data.systemPromptLength ?? 0;
  const isTruncated = fullLength > 500 && preview.length > 0;

  return (
    <div className="flex flex-col gap-3 p-4">
      {/* System prompt */}
      {preview ? (
        <div>
          <div className="text-xs text-muted-foreground mb-1">{t('ragTrace.prompt.systemPrompt')}</div>
          <div className={cn(
            'text-xs bg-muted p-2 border border-border font-mono whitespace-pre-wrap break-words',
            !expanded && 'max-h-32 overflow-hidden'
          )}>
            {preview}
          </div>
          {isTruncated && (
            <button
              data-testid="chat-rag-trace-expand-prompt"
              className="text-[10px] text-primary hover:underline mt-1"
              onClick={() => setExpanded(!expanded)}
            >
              {expanded ? t('ragTrace.prompt.collapse') : t('ragTrace.prompt.showFull')}
            </button>
          )}
          <div className="text-[10px] text-muted-foreground mt-1">
            {t('ragTrace.prompt.promptLength')}: {formatNumber(fullLength)} {t('ragTrace.prompt.chars')}
          </div>
        </div>
      ) : (
        <div className="text-xs text-muted-foreground">{t('ragTrace.prompt.systemPrompt')}: -</div>
      )}

      {/* History and summary */}
      <div className="grid grid-cols-2 gap-3 border-t border-border pt-3">
        <div>
          <div className="text-[11px] text-muted-foreground">{t('ragTrace.prompt.historyMessages')}</div>
          <div className="text-sm font-medium">{typeof data.historyMessageCount === 'number' ? data.historyMessageCount : '-'}</div>
        </div>
        <div>
          <div className="text-[11px] text-muted-foreground">{t('ragTrace.prompt.conversationSummary')}</div>
          <div className="text-sm font-medium">
            {data.hasConversationSummary ? t('ragTrace.prompt.included') : t('ragTrace.prompt.notIncluded')}
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------- Tab: Context ----------
function ContextTab({ data }: { data: RagTraceData }) {
  const { t } = useTranslation();
  const ctxWindow = data.contextWindowSize || 128000;
  const ctxTokens = data.contextTokenEstimate ?? 0;
  const utilization = ctxWindow > 0 ? ((ctxTokens / ctxWindow) * 100) : 0;

  return (
    <div className="flex flex-col gap-3 p-4">
      <div className="grid grid-cols-2 gap-3">
        <div>
          <div className="text-[11px] text-muted-foreground">{t('ragTrace.context.documentsRetrieved')}</div>
          <div className="text-lg font-semibold">{typeof data.contextDocumentCount === 'number' ? data.contextDocumentCount : '-'}</div>
        </div>
        <div>
          <div className="text-[11px] text-muted-foreground">{t('ragTrace.context.contextTokens')}</div>
          <div className="text-lg font-semibold">{formatNumber(ctxTokens)}</div>
        </div>
      </div>

      {/* Strategy */}
      <div className="border-t border-border pt-3">
        <div className="text-[11px] text-muted-foreground">{t('ragTrace.context.strategy')}</div>
        <div className="text-sm font-medium">{data.strategyName || t('ragTrace.context.noStrategy')}</div>
      </div>

      {/* Collections */}
      <div className="border-t border-border pt-3">
        <div className="text-[11px] text-muted-foreground mb-1">{t('ragTrace.context.collections')}</div>
        {data.collectionNames && data.collectionNames.length > 0 ? (
          <div className="flex flex-wrap gap-1">
            {data.collectionNames.map((name, i) => (
              <span key={i} className="text-xs bg-muted px-1.5 py-0.5 border border-border">{name}</span>
            ))}
          </div>
        ) : (
          <div className="text-xs text-muted-foreground">{t('ragTrace.context.noCollections')}</div>
        )}
      </div>

      {/* Window utilization */}
      {ctxTokens > 0 && (
        <div className="border-t border-border pt-3">
          <div className="text-[11px] text-muted-foreground mb-1">{t('ragTrace.context.windowUtilization')}</div>
          <div className="flex h-2 w-full overflow-hidden border border-border bg-muted">
            <div
              className="h-full bg-primary transition-all"
              style={{ width: `${Math.min(utilization, 100)}%` }}
            />
          </div>
          <div className="text-[10px] text-muted-foreground mt-0.5">{utilization.toFixed(1)}%</div>
        </div>
      )}
    </div>
  );
}

export function RagTraceSheet({ open, onOpenChange, traceData }: RagTraceSheetProps) {
  const { t } = useTranslation();

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent data-testid="chat-rag-trace-sheet" side="right" className="w-[420px] sm:w-[450px] p-0 flex flex-col">
        <SheetHeader className="px-4 pt-4 pb-2">
          <SheetTitle className="text-base">{t('ragTrace.title')}</SheetTitle>
          <SheetDescription className="sr-only">{t('ragTrace.title')}</SheetDescription>
        </SheetHeader>

        {traceData ? (
          <Tabs defaultValue="tokens" className="flex-1 flex flex-col overflow-hidden">
            <TabsList className="mx-4 mb-0 grid grid-cols-4">
              <TabsTrigger data-testid="chat-rag-trace-tab-tokens" value="tokens" className="text-xs">{t('ragTrace.tabs.tokens')}</TabsTrigger>
              <TabsTrigger data-testid="chat-rag-trace-tab-cost" value="cost" className="text-xs">{t('ragTrace.tabs.cost')}</TabsTrigger>
              <TabsTrigger data-testid="chat-rag-trace-tab-prompt" value="prompt" className="text-xs">{t('ragTrace.tabs.prompt')}</TabsTrigger>
              <TabsTrigger data-testid="chat-rag-trace-tab-context" value="context" className="text-xs">{t('ragTrace.tabs.context')}</TabsTrigger>
            </TabsList>
            <div className="flex-1 overflow-y-auto">
              <TabsContent value="tokens" className="mt-0">
                <TokensTab data={traceData} />
              </TabsContent>
              <TabsContent value="cost" className="mt-0">
                <CostTab data={traceData} />
              </TabsContent>
              <TabsContent value="prompt" className="mt-0">
                <PromptTab data={traceData} />
              </TabsContent>
              <TabsContent value="context" className="mt-0">
                <ContextTab data={traceData} />
              </TabsContent>
            </div>
          </Tabs>
        ) : (
          <div className="flex-1 flex items-center justify-center text-sm text-muted-foreground">
            {t('ragTrace.noData')}
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
