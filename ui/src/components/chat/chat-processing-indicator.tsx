import React, { useEffect, useRef, useState } from 'react';
import {
  Loader2,
  Brain,
  Search,
  Zap,
  CheckCircle2,
  Route,
  Database,
  Sparkles,
  FileText,
  Layers,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { useTranslation } from 'react-i18next';

export interface ProcessingStep {
  content: string;
  stage?: string;
  timestamp: number;
}

interface ChatProcessingIndicatorProps {
  statusMessage: { content: string; stage?: string } | null;
  stageHistory: ProcessingStep[];
  isVisible: boolean;
  isWaiting?: boolean;
}

const STAGE_CONFIG: Record<string, {
  icon: React.ElementType;
  colorClass: string;
  bgClass: string;
  spinAnimation?: boolean;
}> = {
  init: { icon: Loader2, colorClass: 'text-primary', bgClass: 'bg-primary/10', spinAnimation: true },
  initialization: { icon: Loader2, colorClass: 'text-primary', bgClass: 'bg-primary/10', spinAnimation: true },
  collection_discovery: { icon: Database, colorClass: 'text-primary', bgClass: 'bg-primary/10' },
  source_routing: { icon: Route, colorClass: 'text-primary', bgClass: 'bg-primary/10' },
  intent_routing: { icon: Route, colorClass: 'text-primary', bgClass: 'bg-primary/10' },
  strategy_routing: { icon: Layers, colorClass: 'text-primary', bgClass: 'bg-primary/10' },
  routing: { icon: Route, colorClass: 'text-primary', bgClass: 'bg-primary/10' },
  retrieval: { icon: Search, colorClass: 'text-primary', bgClass: 'bg-primary/10' },
  search: { icon: Search, colorClass: 'text-primary', bgClass: 'bg-primary/10' },
  generation: { icon: Sparkles, colorClass: 'text-primary', bgClass: 'bg-primary/10' },
  processing: { icon: Brain, colorClass: 'text-primary', bgClass: 'bg-primary/10' },
  thinking: { icon: Brain, colorClass: 'text-primary', bgClass: 'bg-primary/10' },
  research: { icon: Zap, colorClass: 'text-primary', bgClass: 'bg-primary/10' },
  fact_check: { icon: CheckCircle2, colorClass: 'text-primary', bgClass: 'bg-primary/10' },
  document_qa: { icon: FileText, colorClass: 'text-primary', bgClass: 'bg-primary/10' },
  preparation: { icon: Layers, colorClass: 'text-primary', bgClass: 'bg-primary/10' },
};

const getStageConfig = (stage?: string) => {
  if (!stage) return STAGE_CONFIG.init;
  return STAGE_CONFIG[stage] || STAGE_CONFIG.init;
};

const prefersReducedMotion = (): boolean =>
  typeof window !== 'undefined' &&
  typeof window.matchMedia === 'function' &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * Reveals `text` token-by-token instead of all at once.
 *
 * The backend emits each narration beat as a single whole `reasoning_delta`
 * packet (the sentence is static, there is no real model token stream behind
 * it). To give the user the live "typing" feel they expect, we replay the
 * sentence here in small chunks — splitting on whitespace so each step lands
 * on a word boundary, which reads like a token stream rather than a stuttering
 * per-character ticker. The component is mounted fresh per status (the parent
 * keys on `statusMessage.content`), so each new beat re-animates from empty.
 *
 * Respects `prefers-reduced-motion`: shows the full text immediately.
 */
const TypewriterText: React.FC<{ text: string }> = ({ text }) => {
  const [revealed, setRevealed] = useState(() => (prefersReducedMotion() ? text : ''));

  useEffect(() => {
    if (prefersReducedMotion()) {
      setRevealed(text);
      return;
    }
    // Keep the whitespace as its own token so spacing is preserved verbatim.
    const tokens = text.split(/(\s+)/);
    let index = 0;
    setRevealed('');
    const timer = window.setInterval(() => {
      index += 1;
      setRevealed(tokens.slice(0, index).join(''));
      if (index >= tokens.length) {
        window.clearInterval(timer);
      }
    }, 28);
    return () => window.clearInterval(timer);
  }, [text]);

  return <>{revealed}</>;
};

export const ChatProcessingIndicator: React.FC<ChatProcessingIndicatorProps> = ({
  statusMessage,
  stageHistory,
  isVisible,
  isWaiting = false,
}) => {
  const { t } = useTranslation();
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (containerRef.current && statusMessage) {
      containerRef.current.scrollIntoView?.({ behavior: 'smooth', block: 'nearest' });
    }
  }, [statusMessage]);

  if (!isVisible) return null;

  const config = getStageConfig(statusMessage?.stage);
  const IconComponent = config.icon;

  const completedSteps = stageHistory.slice(0, -1).slice(-3);

  return (
    <div
      ref={containerRef}
      data-testid="chat-processing-indicator"
      role="status"
      aria-live="polite"
      aria-label={statusMessage?.content || t('chat.status.waitingForResponse')}
      className="mb-3 -mt-1 animate-fade-in"
    >
      {/* Animated divider: a faint base line with a brighter gradient band
          sliding across it, so the separator above the status reads as a live
          progress shimmer rather than a static rule. */}
      <div className="relative h-0.5 w-full overflow-hidden bg-primary/10 mb-3">
        <div className="absolute inset-0 h-full w-1/2 bg-gradient-to-r from-transparent via-primary/70 to-transparent animate-shimmer-slide" />
      </div>

      {/* Current status */}
      {statusMessage?.content ? (
        <div key={statusMessage.content} className="flex items-start gap-2.5 animate-status-enter">
          {/* Stage icon */}
          <div className={cn('flex-shrink-0 p-1', config.bgClass, 'rounded-full')}>
            <IconComponent
              className={cn(
                'w-3.5 h-3.5',
                config.colorClass,
                config.spinAnimation && 'animate-spin'
              )}
            />
          </div>

          {/* Status text — revealed token-by-token for a live "typing" feel */}
          <span className="text-sm text-foreground/80 leading-tight min-w-0 flex-1">
            <TypewriterText text={statusMessage.content} />
          </span>
        </div>
      ) : isWaiting ? (
        <div className="flex items-center gap-2.5 animate-status-enter">
          <div className={cn('flex-shrink-0 p-1', 'bg-primary/10', 'rounded-full')}>
            <Loader2 className="w-3.5 h-3.5 text-primary animate-spin" />
          </div>
          <span className="text-sm text-muted-foreground">
            {t('chat.status.waitingForResponse')}
          </span>
        </div>
      ) : null}

      {/* Completed steps history */}
      {completedSteps.length > 0 && (
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 pl-8">
          {completedSteps.map((step, idx) => {
            return (
              <div
                key={`${step.timestamp}-${idx}`}
                className="flex items-center gap-1 text-muted-foreground"
              >
                <CheckCircle2 className="w-3 h-3 flex-shrink-0 text-primary/50" />
                <span className="text-xs break-words">
                  {step.content}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};
