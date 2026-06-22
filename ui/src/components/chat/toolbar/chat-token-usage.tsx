import { useEffect, useState, useCallback } from 'react';
import { getMySubscription, type UserSubscriptionWithUsage } from '@/lib/api-subscriptions';
import { cn } from '@/lib/utils';
import { useTranslation } from 'react-i18next';
import { Zap } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';

function formatTokenCount(count: number): string {
  if (count >= 1_000_000) {
    return `${(count / 1_000_000).toFixed(1)}M`;
  }
  if (count >= 1_000) {
    return `${(count / 1_000).toFixed(1)}K`;
  }
  return String(count);
}

function getUsageColor(percentage: number): string {
  if (percentage >= 90) return 'text-red-500 dark:text-red-400';
  if (percentage >= 70) return 'text-amber-600 dark:text-amber-400';
  return 'text-zinc-500 dark:text-zinc-400';
}

function getBarColor(percentage: number): string {
  if (percentage >= 90) return 'bg-red-500/60';
  if (percentage >= 70) return 'bg-amber-500/60';
  return 'bg-zinc-400/40 dark:bg-zinc-400/40';
}

interface ChatTokenUsageProps {
  ragTracingEnabled?: boolean;
}

export function ChatTokenUsage({ ragTracingEnabled }: ChatTokenUsageProps) {
  const { t } = useTranslation();
  const [data, setData] = useState<UserSubscriptionWithUsage | null>(null);

  const loadUsage = useCallback(async () => {
    try {
      const result = await getMySubscription();
      setData(result);
    } catch {
      // Silently fail - this is a non-critical UI element
    }
  }, []);

  useEffect(() => {
    void loadUsage();
    // Refresh every 5 minutes
    const interval = setInterval(loadUsage, 5 * 60 * 1000);
    return () => clearInterval(interval);
  }, [loadUsage]);

  if (!data?.quota_info?.tokens) return null;

  const { tokens } = data.quota_info;
  const used = data.usage.tokens_used;
  const percentage = tokens.percentage_used ?? 0;
  const isUnlimited = tokens.unlimited;

  const usedFormatted = formatTokenCount(used);
  const limitFormatted = tokens.limit ? formatTokenCount(tokens.limit) : null;

  const label = isUnlimited
    ? `${usedFormatted} ${t('chat.tokenUsage.tokens')}`
    : `${usedFormatted} / ${limitFormatted}`;

  const tooltipText = isUnlimited
    ? t('chat.tokenUsage.unlimitedTooltip', { used: usedFormatted })
    : t('chat.tokenUsage.tooltip', { used: usedFormatted, limit: limitFormatted, percentage: Math.round(percentage) });

  return (
    <TooltipProvider delayDuration={300}>
      <Tooltip>
        <TooltipTrigger asChild>
          <div
            className={cn(
              'flex items-center gap-1 pl-2 pr-0 py-0.5 select-none cursor-default',
              'text-[10px] font-medium tracking-wide uppercase',
              'opacity-50 hover:opacity-80 transition-opacity duration-300',
              getUsageColor(percentage)
            )}
          >
            {ragTracingEnabled && (
              <div className='h-1.5 w-1.5 rounded-full bg-green-500 flex-shrink-0' />
            )}
            {!isUnlimited && (
              <div className='w-8 h-1 bg-zinc-200/50 dark:bg-zinc-700/50 overflow-hidden'>
                <div
                  className={cn('h-full transition-all duration-500', getBarColor(percentage))}
                  style={{ width: `${Math.min(percentage, 100)}%` }}
                />
              </div>
            )}
            <Zap className='h-2.5 w-2.5 flex-shrink-0' />
            <span className='whitespace-nowrap'>{label}</span>
          </div>
        </TooltipTrigger>
        <TooltipContent side='top' className='text-xs'>
          {tooltipText}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
