import { Loader2 } from 'lucide-react';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';

interface JobInfo {
  progress?: number;
  collection_name?: string;
  job_type?: string;
  filename?: string;
}

interface CompactJobIndicatorProps {
  activeJobsCount: number;
  activeJobs: Record<string, JobInfo>;
}

export const CompactJobIndicator = ({
  activeJobsCount,
  activeJobs,
}: CompactJobIndicatorProps) => {
  if (activeJobsCount === 0) {
    return null;
  }

  // Calculate overall progress
  const totalProgress = Object.values(activeJobs).reduce((sum: number, job: JobInfo) => {
    return sum + (job.progress || 0);
  }, 0);
  const averageProgress = totalProgress / activeJobsCount;

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <div data-testid="chat-job-indicator" className='flex items-center gap-2 px-3 py-1.5'>
            {/* Spinning icon */}
            <Loader2 className='h-4 w-4 animate-spin text-primary' />

            {/* Progress bar container - no round corners */}
            <div className='relative w-24 h-1.5 bg-zinc-200 dark:bg-zinc-800 overflow-hidden'>
              {/* Animated progress bar with gradient */}
              <div
                className='absolute inset-y-0 left-0 bg-gradient-to-r from-blue-500 via-indigo-500 to-violet-500 transition-all duration-500 ease-out'
                style={{
                  width: `${Math.min(Math.max(averageProgress, 5), 100)}%`,
                }}
              >
                {/* Shimmer effect */}
                <div className='absolute inset-0 bg-gradient-to-r from-transparent via-white/30 to-transparent animate-shimmer' />
              </div>

              {/* Pulsing overlay for indeterminate progress */}
              {averageProgress < 5 && (
                <div className='absolute inset-0 bg-gradient-to-r from-blue-500/50 to-violet-500/50 animate-pulse' />
              )}
            </div>

            {/* Job count badge */}
            <span className='text-xs font-semibold text-zinc-600 dark:text-zinc-400 min-w-[1.5rem] text-center'>
              {activeJobsCount}
            </span>
          </div>
        </TooltipTrigger>

        <TooltipContent side='bottom' className='z-[90] max-w-xs'>
          <div className='space-y-2'>
            <p className='font-semibold text-sm'>
              {activeJobsCount} {activeJobsCount === 1 ? 'Job' : 'Jobs'} Processing
            </p>
            <div className='space-y-1 text-xs'>
              {Object.entries(activeJobs).slice(0, 3).map(([jobId, job]: [string, JobInfo]) => (
                <div key={jobId} className='flex items-center justify-between gap-2'>
                  <span className='truncate'>{job.collection_name || job.filename || job.job_type || 'Processing'}</span>
                  <span className='text-muted-foreground'>
                    {job.progress ? `${Math.round(job.progress)}%` : '...'}
                  </span>
                </div>
              ))}
              {activeJobsCount > 3 && (
                <p className='text-muted-foreground italic'>
                  +{activeJobsCount - 3} more...
                </p>
              )}
            </div>
            <p className='text-xs text-muted-foreground pt-1 border-t border-border'>
              Processing in progress
            </p>
          </div>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
};
