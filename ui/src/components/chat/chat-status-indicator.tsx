import React from 'react';
import { Loader2, Brain, Search, Zap, CheckCircle2 } from 'lucide-react';
import { cn } from '@/lib/utils';

interface StatusIndicatorProps {
  message: string;
  stage?: 'init' | 'initialization' | 'retrieval' | 'generation' | 'processing' | 'research' | 'search' | 'fact_check' | 'routing';
}

export const ChatStatusIndicator: React.FC<StatusIndicatorProps> = ({ message, stage }) => {
  const getStageIcon = () => {
    switch (stage) {
      case 'init':
      case 'initialization':
        return <Loader2 className='w-3.5 h-3.5 animate-spin' />;
      case 'retrieval':
      case 'search':
        return <Search className='w-3.5 h-3.5' />;
      case 'generation':
        return <Brain className='w-3.5 h-3.5' />;
      case 'processing':
      case 'research':
        return <Zap className='w-3.5 h-3.5' />;
      case 'routing':
        return <Brain className='w-3.5 h-3.5 animate-pulse' />;
      case 'fact_check':
        return <CheckCircle2 className='w-3.5 h-3.5' />;
      default:
        return <Loader2 className='w-3.5 h-3.5 animate-spin' />;
    }
  };

  const getStageColor = () => {
    switch (stage) {
      case 'init':
      case 'initialization':
      case 'processing':
        return 'text-blue-600 dark:text-blue-400';
      case 'retrieval':
      case 'search':
        return 'text-violet-600 dark:text-violet-400';
      case 'generation':
        return 'text-purple-600 dark:text-purple-400';
      case 'routing':
        return 'text-indigo-600 dark:text-indigo-400';
      case 'research':
        return 'text-orange-600 dark:text-orange-400';
      case 'fact_check':
        return 'text-green-600 dark:text-green-400';
      default:
        return 'text-zinc-600 dark:text-zinc-400';
    }
  };

  return (
    <div data-testid="chat-status-indicator" className='flex items-start gap-2.5 px-4 py-2 animate-fade-in'>
      {/* Animated icon */}
      <div className={cn(
        'flex-shrink-0 transition-colors duration-300',
        getStageColor()
      )}>
        <div className='animate-pulse-slow'>
          {getStageIcon()}
        </div>
      </div>

      {/* Status text */}
      <div className='flex items-center gap-2'>
        <span className='text-sm font-medium text-zinc-600 dark:text-zinc-400 italic'>
          {message}
        </span>

        {/* Animated dots */}
        <div className='flex items-center gap-0.5'>
          <div className='w-1 h-1 rounded-full bg-zinc-400 dark:bg-zinc-500 animate-bounce' style={{ animationDelay: '0ms' }} />
          <div className='w-1 h-1 rounded-full bg-zinc-400 dark:bg-zinc-500 animate-bounce' style={{ animationDelay: '150ms' }} />
          <div className='w-1 h-1 rounded-full bg-zinc-400 dark:bg-zinc-500 animate-bounce' style={{ animationDelay: '300ms' }} />
        </div>
      </div>
    </div>
  );
};
