import React, { useState, useMemo } from 'react';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { Loader2, Zap, Clock, Gauge } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { getMessageMetrics, TokenMetrics } from '@/lib/api-messages';
import { useAsyncData } from '@/hooks/use-async-data';

interface PopoverTokenMetricsProps {
  trigger: React.ReactNode;
  messageId: string;
}

export const PopoverTokenMetrics: React.FC<PopoverTokenMetricsProps> = ({
  trigger,
  messageId,
}) => {
  const { t } = useTranslation();
  const [isOpen, setIsOpen] = useState(false);

  const { data: metrics, loading, error } = useAsyncData<TokenMetrics | null>(
    () => getMessageMetrics(messageId),
    { deps: [messageId, isOpen], skip: !isOpen }
  );

  const computed = useMemo(() => {
    if (!metrics) return null;

    const inputTokens = metrics.input_tokens || metrics.prompt_tokens || 0;
    const outputTokens =
      metrics.output_tokens || metrics.completion_tokens || 0;
    const totalTokens = metrics.total_tokens || inputTokens + outputTokens;
    const latencyMs = metrics.latency_ms || 0;
    const latencySec = latencyMs / 1000;
    const tokensPerSec =
      metrics.tokens_per_second ||
      (latencySec > 0 ? outputTokens / latencySec : 0);

    return {
      inputTokens,
      outputTokens,
      totalTokens,
      latencyMs,
      latencySec,
      tokensPerSec,
      model: metrics.model || '—',
      provider: metrics.provider || '—',
      costUsd: metrics.cost_usd ?? 0,
    };
  }, [metrics]);

  const formatDuration = (seconds: number) => {
    if (seconds < 1) return `${Math.round(seconds * 1000)}ms`;
    return `${seconds.toFixed(1)}s`;
  };

  const metricsContent = (
    <>
      {loading && (
        <div className='flex items-center justify-center py-6'>
          <Loader2 className='h-4 w-4 animate-spin text-muted-foreground' />
          <span className='ml-2 text-xs text-muted-foreground'>
            {t('tokenMetrics.loading')}
          </span>
        </div>
      )}

      {error && (
        <div className='py-6 px-4 text-center text-xs text-muted-foreground'>
          {error}
        </div>
      )}

      {!loading && !error && !computed && (
        <div className='py-6 px-4 text-center text-xs text-muted-foreground'>
          {t('tokenMetrics.noMetricsAvailable')}
        </div>
      )}

      {computed && (
        <div className='divide-y divide-border'>
          {/* Model row */}
          <div className='flex items-center gap-2 px-3 py-2'>
            <span className='text-[10px] font-medium uppercase tracking-wider text-muted-foreground'>
              {computed.provider}
            </span>
            <span className='text-[10px] text-muted-foreground/50'>/</span>
            <span className='text-xs font-mono text-foreground truncate'>
              {computed.model}
            </span>
          </div>

          {/* Token stats grid */}
          <div className='grid grid-cols-3 divide-x divide-border'>
            {computed.inputTokens > 0 ? (
              <div className='px-3 py-2.5 text-center'>
                <div className='text-sm font-semibold tabular-nums'>
                  {computed.inputTokens.toLocaleString()}
                </div>
                <div className='text-[10px] text-muted-foreground mt-0.5'>
                  {t('tokenMetrics.inputTokens')}
                </div>
              </div>
            ) : (
              <div className='px-3 py-2.5 text-center'>
                <div className='text-sm font-semibold tabular-nums text-muted-foreground/40'>
                  —
                </div>
                <div className='text-[10px] text-muted-foreground mt-0.5'>
                  {t('tokenMetrics.inputTokens')}
                </div>
              </div>
            )}
            <div className='px-3 py-2.5 text-center'>
              <div className='text-sm font-semibold tabular-nums'>
                {computed.outputTokens.toLocaleString()}
              </div>
              <div className='text-[10px] text-muted-foreground mt-0.5'>
                {t('tokenMetrics.outputTokens')}
              </div>
            </div>
            <div className='px-3 py-2.5 text-center'>
              <div className='text-sm font-semibold tabular-nums'>
                {computed.totalTokens.toLocaleString()}
              </div>
              <div className='text-[10px] text-muted-foreground mt-0.5'>
                {t('tokenMetrics.totalTokens')}
              </div>
            </div>
          </div>

          {/* Performance row */}
          <div className='flex items-center justify-between px-3 py-2 text-xs'>
            {computed.latencyMs > 0 && (
              <div className='flex items-center gap-1.5 text-muted-foreground'>
                <Clock className='h-3 w-3' />
                <span>{formatDuration(computed.latencySec)}</span>
              </div>
            )}
            {computed.tokensPerSec > 0 && (
              <div className='flex items-center gap-1.5 text-muted-foreground'>
                <Gauge className='h-3 w-3' />
                <span>{computed.tokensPerSec.toFixed(1)} tok/s</span>
              </div>
            )}
            {computed.costUsd > 0 && (
              <div className='flex items-center gap-1.5 text-muted-foreground'>
                <Zap className='h-3 w-3' />
                <span>
                  $
                  {computed.costUsd < 0.01
                    ? computed.costUsd.toFixed(4)
                    : computed.costUsd.toFixed(2)}
                </span>
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );

  return (
    <Popover onOpenChange={setIsOpen} disableBlur={true}>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent
        data-testid="chat-token-metrics-popover"
        className='w-72 max-w-[calc(100vw-2rem)] p-0 z-[9999]'
        side='top'
        align='end'
        sideOffset={8}
        avoidCollisions={true}
        collisionPadding={16}
      >
        {metricsContent}
      </PopoverContent>
    </Popover>
  );
};
