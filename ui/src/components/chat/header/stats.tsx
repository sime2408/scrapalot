import React, { useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { translateBackendStatus } from '@/lib/translate-backend-status';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  BarChart,
  RefreshCw,
  Activity,
  Server,
  FileText,
  Loader2,
} from 'lucide-react';
import { getMyActiveJobs } from '@/lib/api-documents.ts';
import { getServiceStatus } from '@/lib/api-settings.ts';
import { useIsMobilePhone, useIsMobileOrTabletPortrait } from '@/hooks/use-mobile';
import { cn } from '@/lib/utils';
import { CompactJobIndicator } from './compact-job-indicator';

interface ExtraFeaturesProps {
  sessionId?: string;
}

// Interface for job data
interface ActiveJob {
  document_id: string;
  filename: string;
  collection_id: string;
  collection_name: string;
  progress: number;
  message: string;
  status: string;
}

// Interface for service status data
interface ServiceStatus {
  service_name: string;
  version: string;
  status: string;
  running: boolean;
  api_base: string;
  host: string;
  port: number;
  models_directory: string;
  uptime_seconds: number;
  uptime_human: string;
  process_id: number | null;
  memory_usage: {
    rss_mb: number;
    vms_mb: number;
  };
  cpu_percent: number;
  system_info: {
    platform?: string;
    platform_release?: string;
    platform_version?: string;
    architecture?: string;
    processor?: string;
    python_version?: string;
    hostname?: string;
  };
  timestamp: string;
}

// Add a utility function for truncating text
const truncateFilename = (filename: string, maxLength: number = 38) => {
  if (!filename) return '';
  if (filename.length <= maxLength) return filename;

  // Keep the file extension intact
  const lastDotIndex = filename.lastIndexOf('.');
  if (lastDotIndex !== -1 && lastDotIndex > filename.length - 8) {
    // If there's a file extension
    const extension = filename.slice(lastDotIndex);
    const name = filename.slice(0, lastDotIndex);

    if (maxLength <= 10)
      return `${name.slice(0, maxLength - 5)}...${extension}`;

    const leftChars = Math.ceil((maxLength - 5) * 0.6);
    const rightChars = Math.floor((maxLength - 5) * 0.4);

    return `${name.slice(0, leftChars)}...${name.slice(-rightChars)}${extension}`;
  }

  // Simple truncation for files without extensions
  const leftChars = Math.ceil((maxLength - 3) * 0.6);
  const rightChars = Math.floor((maxLength - 3) * 0.4);

  return `${filename.slice(0, leftChars)}...${filename.slice(-rightChars)}`;
};

export const Stats = ({
  sessionId: _sessionId,
}: ExtraFeaturesProps) => {
  const { t } = useTranslation();
  const isMobilePhone = useIsMobilePhone();
  const isMobileOrTabletPortrait = useIsMobileOrTabletPortrait();
  const [isStatsDialogOpen, setIsStatsDialogOpen] = useState(false);
  const [activeTab, setActiveTab] = useState('jobs');
  const [activeJobs, setActiveJobs] = useState<Record<string, { progress?: number; collection_name?: string; job_type?: string }>>({});
  const [activeJobsCount, setActiveJobsCount] = useState(0);
  const [isLoadingJobs, setIsLoadingJobs] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [serviceStatus, setServiceStatus] = useState<ServiceStatus | null>(null);
  const [isLoadingStatus, setIsLoadingStatus] = useState(false);
  const pollingIntervalRef = useRef<NodeJS.Timeout | null>(null);

  // Touch swipe state for mobile tab navigation
  const [touchStart, setTouchStart] = useState<number | null>(null);
  const [touchEnd, setTouchEnd] = useState<number | null>(null);
  const [touchCurrent, setTouchCurrent] = useState<number | null>(null);
  const [isAnimating, setIsAnimating] = useState(false);
  const [slideDirection, setSlideDirection] = useState<'left' | 'right' | null>(null);
  const [nextTab, setNextTab] = useState<string | null>(null);
  const [dragOffset, setDragOffset] = useState(0);
  const [isDragging, setIsDragging] = useState(false);

  // Function to fetch active jobs with timeout and retry logic
  const fetchActiveJobs = async (retryCount = 0) => {
    try {
      setIsLoadingJobs(true);

      // Use the API's built-in timeout instead of Promise.race to avoid double timeout issues
      const data = await getMyActiveJobs(true) as { active_jobs: Record<string, ActiveJob>; active_jobs_count: number };

      setActiveJobs(data.active_jobs || {});
      setActiveJobsCount(data.active_jobs_count || 0);
    } catch (error) {
      console.error('Error fetching active jobs:', error);

      // Enhanced retry logic with exponential backoff
      const maxRetries = activeJobsCount > 0 ? 2 : 3; // More retries when no active jobs
      if (retryCount < maxRetries) {
        // Exponential backoff: 2s, 4s, 8s
        const delay = Math.min(2000 * Math.pow(2, retryCount), 8000);
        setTimeout(() => fetchActiveJobs(retryCount + 1), delay);
      } else {
        // After all retries failed, set empty state to prevent UI crashes
        console.warn('All retries failed for fetchActiveJobs, setting empty state');
        setActiveJobs({});
        setActiveJobsCount(0);
      }
    } finally {
      setIsLoadingJobs(false);
    }
  };

  // Function to fetch service status
  const fetchServiceStatus = async () => {
    try {
      setIsLoadingStatus(true);
      const data = await getServiceStatus();
      setServiceStatus(data);
    } catch (error) {
      console.error('Error fetching service status:', error);
      // Set default status on error
      setServiceStatus({
        service_name: 'ScrapalotChat FastAPI',
        version: '1.0.0',
        status: 'error',
        running: false,
        api_base: 'http://localhost:8090',
        host: 'localhost',
        port: 8090,
        models_directory: 'models',
        uptime_seconds: 0,
        uptime_human: '0h 0m 0s',
        process_id: null,
        memory_usage: { rss_mb: 0, vms_mb: 0 },
        cpu_percent: 0,
        system_info: {},
        timestamp: new Date().toISOString(),
      });
    } finally {
      setIsLoadingStatus(false);
    }
  };

  // Manual refresh function with loading indicator
  const handleRefreshJobs = async () => {
    setIsRefreshing(true);
    await fetchActiveJobs();
    setTimeout(() => setIsRefreshing(false), 500); // Show the refresh animation for at least 500ms
  };

  // Manual refresh function for all content (both jobs and service status)
  const handleRefreshStatus = async () => {
    // Refresh both jobs and service status data
    await Promise.all([
      fetchActiveJobs(),
      fetchServiceStatus()
    ]);
  };

  // Set up polling
  useEffect(() => {
    // Initial fetch
    void fetchActiveJobs();
    void fetchServiceStatus();

    // Clean up function
    return () => {
      if (pollingIntervalRef.current) {
        clearInterval(pollingIntervalRef.current);
      }
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps -- deps are intentionally limited
  }, []);

  // Set up or tear down polling based on active jobs
  useEffect(() => {
    // Function to start polling
    const startPolling = () => {
      if (pollingIntervalRef.current) {
        clearInterval(pollingIntervalRef.current);
      }
      // Use adaptive polling: longer intervals during heavy processing to reduce server load
      const pollingInterval = activeJobsCount > 0 ? 15000 : 10000; // 15s during processing, 10s otherwise
      pollingIntervalRef.current = setInterval(() => {
        void fetchActiveJobs();
      }, pollingInterval);
    };

    // Function to stop polling
    const stopPolling = () => {
      if (pollingIntervalRef.current) {
        clearInterval(pollingIntervalRef.current);
        pollingIntervalRef.current = null;
      }
    };

    // Always poll. The old code only polled while jobs were ALREADY active, so a
    // job that STARTS after mount — e.g. a background deep-research run kicked off
    // from this very chat page — was never discovered and the header indicator
    // stayed invisible for the whole run. startPolling() already backs off to a
    // slower cadence when busy; the idle poll is a cheap liveness check.
    startPolling();

    // Clean up interval on component unmount or when activeJobsCount becomes 0
    return () => {
      stopPolling();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps -- deps are intentionally limited
  }, [activeJobsCount]); // Dependency array includes activeJobsCount

  // Also fetch when the stats dialog is opened
  useEffect(() => {
    if (isStatsDialogOpen) {
      void fetchActiveJobs();
      void fetchServiceStatus();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- deps are intentionally limited
  }, [isStatsDialogOpen]);

  // Touch swipe handlers for mobile tab navigation
  const minSwipeDistance = 50;
  const maxDragDistance = window.innerWidth * 0.2; // 20% of screen width
  const tabs = ['jobs', 'system'];

  const onTouchStart = (e: React.TouchEvent) => {
    if (!isMobileOrTabletPortrait || isAnimating) return;
    setTouchEnd(null);
    setTouchCurrent(null);
    setTouchStart(e.targetTouches[0].clientX);
    setDragOffset(0);
    setIsDragging(false);
  };

  const onTouchMove = (e: React.TouchEvent) => {
    if (!isMobileOrTabletPortrait || !touchStart || isAnimating) return;

    const currentX = e.targetTouches[0].clientX;
    setTouchCurrent(currentX);
    setTouchEnd(currentX);

    const distance = touchStart - currentX;
    const currentIndex = tabs.findIndex(tab => tab === activeTab);

    // Only allow dragging if there's a valid next/previous tab
    const canGoNext = distance > 0 && currentIndex < tabs.length - 1;
    const canGoPrev = distance < 0 && currentIndex > 0;

    if (canGoNext || canGoPrev) {
      const clampedDistance = Math.max(-maxDragDistance, Math.min(maxDragDistance, distance));
      setDragOffset(clampedDistance);
      setIsDragging(Math.abs(distance) > 10); // Start dragging after 10px movement

      // Set next tab for preview during drag
      if (Math.abs(distance) > 10) {
        if (canGoNext && distance > 0) {
          setNextTab(tabs[currentIndex + 1]);
          setSlideDirection('left');
        } else if (canGoPrev && distance < 0) {
          setNextTab(tabs[currentIndex - 1]);
          setSlideDirection('right');
        }
      }
    }
  };

  const onTouchEnd = () => {
    if (!isMobileOrTabletPortrait || !touchStart || isAnimating) return;

    const distance = touchCurrent ? touchStart - touchCurrent : (touchEnd ? touchStart - touchEnd : 0);
    const isLeftSwipe = distance > minSwipeDistance;
    const isRightSwipe = distance < -minSwipeDistance;

    if (isLeftSwipe || isRightSwipe) {
      const currentIndex = tabs.findIndex(tab => tab === activeTab);

      if (isLeftSwipe && currentIndex < tabs.length - 1) {
        // Swipe left - go to next tab (slide from right to left)
        handleTabChange(tabs[currentIndex + 1], 'left');
      } else if (isRightSwipe && currentIndex > 0) {
        // Swipe right - go to previous tab (slide from left to right)
        handleTabChange(tabs[currentIndex - 1], 'right');
      }
    } else {
      // Reset drag state if no swipe occurred
      setDragOffset(0);
      setIsDragging(false);
      setSlideDirection(null);
      setNextTab(null);
    }

    setTouchStart(null);
    setTouchEnd(null);
    setTouchCurrent(null);
  };

  const handleTabChange = (tab: string, direction?: 'left' | 'right') => {
    // Don't change tabs if already animating
    if (isAnimating) return;

    // If it's the same tab, don't animate
    if (activeTab === tab) return;

    // Start animation on mobile
    if (isMobileOrTabletPortrait && direction) {
      setIsAnimating(true);
      setSlideDirection(direction);
      setNextTab(tab);
      setDragOffset(0);
      setIsDragging(false);

      // Change tab after a brief delay to allow animation setup
      setTimeout(() => {
        setActiveTab(tab);
      }, 50);

      // End animation after transition completes
      setTimeout(() => {
        setIsAnimating(false);
        setSlideDirection(null);
        setNextTab(null);
      }, 350); // Match CSS transition duration + delay
    } else {
      setActiveTab(tab);
    }
  };

  // Handle mobile back button to close stats dialog
  useEffect(() => {
    if (!isMobilePhone || !isStatsDialogOpen) return;

    const handlePopState = () => {
      setIsStatsDialogOpen(false);
    };

    // Add a history entry when dialog opens on mobile
    window.history.pushState(null, '', window.location.href);
    window.addEventListener('popstate', handlePopState);

    return () => {
      window.removeEventListener('popstate', handlePopState);
    };
  }, [isMobilePhone, isStatsDialogOpen]);

  const renderJobsContent = () => {
    if (isLoadingJobs && activeJobsCount === 0) {
      return (
        <div className='flex items-center justify-center py-4'>
          <Loader2 className='h-5 w-5 animate-spin text-muted-foreground' />
          <span className='ml-2 text-sm text-muted-foreground'>
            Loading active jobs...
          </span>
        </div>
      );
    }

    if (activeJobsCount > 0) {
      return (
        <div className='space-y-3 max-h-70 overflow-y-auto'>
          {Object.entries(activeJobs).map(([jobId, job]) => (
            <div key={jobId} className={cn(
              'bg-white dark:bg-zinc-900/50 border border-zinc-200/60 dark:border-zinc-700/60 p-4 hover:bg-zinc-50/80 dark:hover:bg-zinc-800/50 transition-all duration-200 shadow-sm hover:shadow-md',
              isMobilePhone && 'p-3'
            )}>
              <div className='flex items-start justify-between gap-3 mb-3'>
                <div className='flex items-center min-w-0 flex-1'>
                  <div className='w-8 h-8 bg-blue-100 dark:bg-blue-900/50 flex items-center justify-center flex-shrink-0 mr-3'>
                    <FileText className='h-4 w-4 text-blue-600 dark:text-blue-400' />
                  </div>
                  <div className='min-w-0 flex-1'>
                    <TooltipProvider>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <h4 className={cn(
                            'font-semibold truncate text-zinc-900 dark:text-white',
                            isMobilePhone ? 'text-sm' : 'text-base'
                          )}>
                            {truncateFilename(job.filename)}
                          </h4>
                        </TooltipTrigger>
                        <TooltipContent side='bottom' className='max-w-80'>
                          <p className='break-all'>{job.filename}</p>
                        </TooltipContent>
                      </Tooltip>
                    </TooltipProvider>
                    <p className={cn(
                      'text-zinc-500 dark:text-zinc-400 truncate',
                      isMobilePhone ? 'text-xs' : 'text-sm'
                    )}>
                      {job.collection_name}
                    </p>
                  </div>
                </div>
                <div className='flex items-center gap-2 flex-shrink-0'>
                  <span className={cn(
                    'font-bold text-blue-600 dark:text-blue-400',
                    isMobilePhone ? 'text-sm' : 'text-base'
                  )}>
                    {job.progress}%
                  </span>
                </div>
              </div>

              <div className='space-y-2'>
                <div className='flex items-center justify-between'>
                  <span className={cn(
                    'text-zinc-600 dark:text-zinc-400 truncate',
                    isMobilePhone ? 'text-xs' : 'text-sm'
                  )}>
                    {translateBackendStatus(job.message, t) ?? job.message}
                  </span>
                </div>
                <div className='w-full bg-zinc-200 dark:bg-zinc-700 rounded-full h-2 overflow-hidden'>
                  <div
                    className='h-full bg-gradient-to-r from-blue-500 to-blue-600 rounded-full transition-all duration-300 ease-out'
                    style={{ width: `${job.progress}%` }}
                  />
                </div>
              </div>
            </div>
          ))}
        </div>
      );
    }

    return (
      <div className={cn(
        'h-full flex flex-col items-center justify-center text-center bg-gradient-to-br from-blue-50/50 to-indigo-50/50 dark:from-blue-900/20 dark:to-indigo-900/20 border border-dashed border-blue-300/60 dark:border-blue-700/60',
        isMobilePhone ? 'py-8 px-4' : 'py-12 px-6'
      )}>
        <div className='w-16 h-16 bg-blue-100 dark:bg-blue-800/50 flex items-center justify-center mx-auto mb-4'>
          <Activity className='h-8 w-8 text-blue-500 dark:text-blue-400' />
        </div>
        <h3 className={cn(
          'font-semibold text-zinc-700 dark:text-zinc-300 mb-2',
          isMobilePhone ? 'text-base' : 'text-lg'
        )}>
          No active jobs
        </h3>
        <p className={cn(
          'text-zinc-500 dark:text-zinc-400 max-w-sm mx-auto',
          isMobilePhone ? 'text-sm' : 'text-base'
        )}>
          Document processing jobs will appear here when active
        </p>
      </div>
    );
  };



  const renderSystemContent = () => {
    if (isLoadingStatus && !serviceStatus) {
      return (
        <div className='flex items-center justify-center py-4'>
          <Loader2 className='h-5 w-5 animate-spin text-muted-foreground' />
          <span className='ml-2 text-sm text-muted-foreground'>
            Loading service status...
          </span>
        </div>
      );
    }

    if (!serviceStatus) {
      return (
        <div className={cn(
          'h-full flex flex-col items-center justify-center bg-gradient-to-br from-purple-50/50 to-violet-50/50 dark:from-purple-900/20 dark:to-violet-900/20 border border-dashed border-purple-300/60 dark:border-purple-700/60',
          isMobilePhone ? 'p-4' : 'p-6'
        )}>
          <div className='flex items-center gap-3 mb-4'>
            <div className='w-16 h-16 bg-purple-100 dark:bg-purple-800/50 flex items-center justify-center'>
              <Server className='h-8 w-8 text-purple-500 dark:text-purple-400' />
            </div>
            <div>
              <h3 className={cn(
                'font-semibold text-zinc-700 dark:text-zinc-300 mb-1',
                isMobilePhone ? 'text-base' : 'text-lg'
              )}>
                System Status
              </h3>
              <p className={cn(
                'text-zinc-500 dark:text-zinc-400',
                isMobilePhone ? 'text-sm' : 'text-base'
              )}>
                Unable to load status
              </p>
            </div>
          </div>
        </div>
      );
    }

    const statusColor = serviceStatus.running
      ? 'text-green-600 dark:text-green-400'
      : 'text-red-600 dark:text-red-400';

    const statusBgColor = serviceStatus.running
      ? 'bg-green-100 dark:bg-green-900/30'
      : 'bg-red-100 dark:bg-red-900/30';

    return (
      <div className='space-y-4 max-h-70 overflow-y-auto'>
        {/* Service Overview */}
        <div className={cn(
          'bg-white dark:bg-zinc-900/50 border border-zinc-200/60 dark:border-zinc-700/60 p-4 shadow-sm',
          isMobilePhone && 'p-3'
        )}>
          <div className='flex items-center justify-between mb-3'>
            <div className='flex items-center gap-3'>
              <div className={cn('w-8 h-8 flex items-center justify-center', statusBgColor)}>
                <Server className={cn('h-4 w-4', statusColor)} />
              </div>
              <div>
                <h4 className={cn(
                  'font-semibold text-zinc-900 dark:text-white',
                  isMobilePhone ? 'text-sm' : 'text-base'
                )}>
                  {serviceStatus.service_name}
                </h4>
                <p className={cn(
                  'text-zinc-500 dark:text-zinc-400',
                  isMobilePhone ? 'text-xs' : 'text-sm'
                )}>
                  Version {serviceStatus.version}
                </p>
              </div>
            </div>
            <div className='text-right'>
              <span className={cn(
                'font-semibold',
                statusColor,
                isMobilePhone ? 'text-sm' : 'text-base'
              )}>
                {serviceStatus.running ? 'Running' : 'Stopped'}
              </span>
              <p className={cn(
                'text-zinc-500 dark:text-zinc-400',
                isMobilePhone ? 'text-xs' : 'text-sm'
              )}>
                Uptime: {serviceStatus.uptime_human}
              </p>
            </div>
          </div>
        </div>

        {/* System Metrics */}
        <div className={cn(
          'bg-white dark:bg-zinc-900/50 border border-zinc-200/60 dark:border-zinc-700/60 p-4 shadow-sm',
          isMobilePhone && 'p-3'
        )}>
          <h5 className={cn(
            'font-semibold text-zinc-900 dark:text-white mb-3',
            isMobilePhone ? 'text-sm' : 'text-base'
          )}>
            System Metrics
          </h5>
          <div className='grid grid-cols-2 gap-4'>
            <div>
              <p className={cn(
                'text-zinc-500 dark:text-zinc-400',
                isMobilePhone ? 'text-xs' : 'text-sm'
              )}>
                Memory Usage
              </p>
              <p className={cn(
                'font-semibold text-zinc-900 dark:text-white',
                isMobilePhone ? 'text-sm' : 'text-base'
              )}>
                {serviceStatus.memory_usage.rss_mb.toFixed(1)} MB
              </p>
            </div>
            <div>
              <p className={cn(
                'text-zinc-500 dark:text-zinc-400',
                isMobilePhone ? 'text-xs' : 'text-sm'
              )}>
                CPU Usage
              </p>
              <p className={cn(
                'font-semibold text-zinc-900 dark:text-white',
                isMobilePhone ? 'text-sm' : 'text-base'
              )}>
                {serviceStatus.cpu_percent.toFixed(1)}%
              </p>
            </div>
            <div>
              <p className={cn(
                'text-zinc-500 dark:text-zinc-400',
                isMobilePhone ? 'text-xs' : 'text-sm'
              )}>
                Process ID
              </p>
              <p className={cn(
                'font-semibold text-zinc-900 dark:text-white',
                isMobilePhone ? 'text-sm' : 'text-base'
              )}>
                {serviceStatus.process_id || 'N/A'}
              </p>
            </div>
            <div>
              <p className={cn(
                'text-zinc-500 dark:text-zinc-400',
                isMobilePhone ? 'text-xs' : 'text-sm'
              )}>
                API Port
              </p>
              <p className={cn(
                'font-semibold text-zinc-900 dark:text-white',
                isMobilePhone ? 'text-sm' : 'text-base'
              )}>
                {serviceStatus.port}
              </p>
            </div>
          </div>
        </div>

        {/* System Information */}
        {serviceStatus.system_info && Object.keys(serviceStatus.system_info).length > 0 && (
          <div className={cn(
            'bg-white dark:bg-zinc-900/50 border border-zinc-200/60 dark:border-zinc-700/60 p-4 shadow-sm',
            isMobilePhone && 'p-3'
          )}>
            <h5 className={cn(
              'font-semibold text-zinc-900 dark:text-white mb-3',
              isMobilePhone ? 'text-sm' : 'text-base'
            )}>
              System Information
            </h5>
            <div className='space-y-2'>
              {serviceStatus.system_info.platform && (
                <div className='flex justify-between'>
                  <span className={cn(
                    'text-zinc-500 dark:text-zinc-400',
                    isMobilePhone ? 'text-xs' : 'text-sm'
                  )}>
                    Platform:
                  </span>
                  <span className={cn(
                    'text-zinc-900 dark:text-white',
                    isMobilePhone ? 'text-xs' : 'text-sm'
                  )}>
                    {serviceStatus.system_info.platform} {serviceStatus.system_info.platform_release}
                  </span>
                </div>
              )}
              {serviceStatus.system_info.python_version && (
                <div className='flex justify-between'>
                  <span className={cn(
                    'text-zinc-500 dark:text-zinc-400',
                    isMobilePhone ? 'text-xs' : 'text-sm'
                  )}>
                    Python:
                  </span>
                  <span className={cn(
                    'text-zinc-900 dark:text-white',
                    isMobilePhone ? 'text-xs' : 'text-sm'
                  )}>
                    {serviceStatus.system_info.python_version}
                  </span>
                </div>
              )}
              {serviceStatus.system_info.hostname && (
                <div className='flex justify-between'>
                  <span className={cn(
                    'text-zinc-500 dark:text-zinc-400',
                    isMobilePhone ? 'text-xs' : 'text-sm'
                  )}>
                    Hostname:
                  </span>
                  <span className={cn(
                    'text-zinc-900 dark:text-white',
                    isMobilePhone ? 'text-xs' : 'text-sm'
                  )}>
                    {serviceStatus.system_info.hostname}
                  </span>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    );
  };

  return (
    <div className='flex items-center space-x-2 p-2 animate-fade-in'>
      {/* Compact Job Indicator - shows when jobs are active */}
      <CompactJobIndicator
        activeJobsCount={activeJobsCount}
        activeJobs={activeJobs}
      />

      <Dialog
        open={isStatsDialogOpen}
        onOpenChange={setIsStatsDialogOpen}
        modal={true}
      >
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <DialogTrigger asChild>
                <Button
                  data-testid="chat-stats-button"
                  variant='outline'
                  size='icon'
                  className={`h-9 w-9 bg-background/95 backdrop-blur-sm border-muted/50 hover:bg-background/80 relative`}
                >
                  <BarChart className='h-4 w-4 opacity-70' />
                  {activeJobsCount > 0 && (
                    <span className='absolute top-0 right-0 flex h-3 w-3'>
                      <span className='animate-ping absolute inline-flex h-full w-full rounded-full bg-primary opacity-75'></span>
                      <span className='relative inline-flex rounded-full h-3 w-3 bg-primary'></span>
                    </span>
                  )}
                  <span className='sr-only'>System Monitor</span>
                </Button>
              </DialogTrigger>
            </TooltipTrigger>
            <TooltipContent side='bottom' className='z-[90]'>
              <p>
                System Monitor{' '}
                {activeJobsCount > 0 ? `(${activeJobsCount} active jobs)` : ''}
              </p>
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>

        <DialogContent
          className={cn(
            'w-[95vw] max-w-[1200px] h-[85vh] max-h-[85vh] overflow-visible flex flex-col p-0',
            isMobileOrTabletPortrait &&
            'fixed inset-0 h-screen max-h-screen w-screen max-w-full rounded-none z-50 m-0'
          )}
          hideCloseButton={isMobileOrTabletPortrait}
          forceMobileBackButton={isMobileOrTabletPortrait}
          dialogOpen={isStatsDialogOpen}
          onOpenChange={setIsStatsDialogOpen}
          onPointerDownOutside={(e) => e.preventDefault()}
          onInteractOutside={(e) => e.preventDefault()}
          overlayZIndex="90"
        >
          {/* Clean Header */}
          <DialogHeader
            className={cn(
              'flex-shrink-0 border-b border-zinc-200 dark:border-zinc-800',
              isMobilePhone ? 'px-3 py-2' : 'px-4 py-3'
            )}
          >
            <div className='flex items-center justify-between'>
              <div className='flex items-center gap-3'>
                <div className='w-10 h-10 bg-gradient-to-br from-green-500 to-emerald-600 rounded-lg flex items-center justify-center'>
                  <Activity className='w-5 h-5 text-white' />
                </div>
                <div>
                  <DialogTitle className='text-xl text-left font-semibold text-zinc-900 dark:text-white'>
                    System Monitor
                  </DialogTitle>
                  <DialogDescription className='text-sm text-zinc-500 dark:text-zinc-400 mt-1'>
                    View processing jobs and system status
                  </DialogDescription>
                </div>
              </div>
            </div>
          </DialogHeader>

          {/* Content Area */}
          <div
            className={cn(
              'flex-1 flex flex-col min-h-0 w-full',
              isMobilePhone ? 'px-3 py-2' : 'px-4 py-3'
            )}
          >
            <Tabs
              defaultValue='system'
              className='flex-1 flex flex-col min-h-0 w-full'
              value={activeTab}
              onValueChange={(value) => handleTabChange(value)}
            >
              <div className='mb-6'>
                <TabsList className={cn(
                  'grid w-full grid-cols-2 bg-zinc-100/80 dark:bg-zinc-900/80 backdrop-blur-sm border border-zinc-200/50 dark:border-zinc-800/50 shadow-sm',
                  isMobilePhone ? 'h-12 p-1' : 'h-11 p-1'
                )}>
                  <TabsTrigger
                    value='system'
                    className={cn(
                      'flex items-center justify-center gap-2 font-medium transition-all duration-200',
                      'data-[state=active]:bg-white data-[state=active]:dark:bg-zinc-800',
                      'data-[state=active]:shadow-sm data-[state=active]:border data-[state=active]:border-zinc-200/50 data-[state=active]:dark:border-zinc-700/50',
                      'hover:bg-white/60 hover:dark:bg-zinc-800/60',
                      'relative overflow-hidden',
                      isMobilePhone ? 'h-10 text-sm rounded-lg px-2' : 'h-9 text-sm rounded-md px-3'
                    )}
                  >
                    <div className='flex items-center gap-2 relative z-10'>
                      <div className={cn(
                        'p-1 rounded-md transition-colors',
                        activeTab === 'system'
                          ? 'bg-purple-100 dark:bg-purple-900/30 text-purple-600 dark:text-purple-400'
                          : 'text-zinc-500 dark:text-zinc-400'
                      )}>
                        <Server className={isMobilePhone ? 'h-3.5 w-3.5' : 'h-4 w-4'} />
                      </div>
                      <span className={cn(
                        'font-medium',
                        isMobilePhone ? 'text-xs' : 'text-sm'
                      )}>
                        System
                      </span>
                    </div>
                  </TabsTrigger>

                  <TabsTrigger
                    value='jobs'
                    className={cn(
                      'flex items-center justify-center gap-2 font-medium transition-all duration-200',
                      'data-[state=active]:bg-white data-[state=active]:dark:bg-zinc-800',
                      'data-[state=active]:shadow-sm data-[state=active]:border data-[state=active]:border-zinc-200/50 data-[state=active]:dark:border-zinc-700/50',
                      'hover:bg-white/60 hover:dark:bg-zinc-800/60',
                      'relative overflow-hidden',
                      isMobilePhone ? 'h-10 text-sm px-2' : 'h-9 text-sm px-3'
                    )}
                  >
                    <div className='flex items-center gap-2 relative z-10'>
                      <div className={cn(
                        'p-1 transition-colors',
                        activeTab === 'jobs'
                          ? 'bg-blue-100 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400'
                          : 'text-zinc-500 dark:text-zinc-400'
                      )}>
                        <Activity className={isMobilePhone ? 'h-3.5 w-3.5' : 'h-4 w-4'} />
                      </div>
                      <span className={cn(
                        'font-medium',
                        isMobilePhone ? 'text-xs' : 'text-sm'
                      )}>
                        {isMobilePhone ? 'Jobs' : 'Active Jobs'}
                      </span>
                      {activeJobsCount > 0 && (
                        <span className={cn(
                          'bg-blue-500 text-white rounded-full font-semibold flex items-center justify-center min-w-0',
                          isMobilePhone ? 'text-xs px-1.5 py-0.5 h-5 min-w-[20px]' : 'text-xs px-2 py-0.5 h-5 min-w-[20px]'
                        )}>
                          {activeJobsCount}
                        </span>
                      )}
                    </div>
                  </TabsTrigger>
                </TabsList>
              </div>

              <div
                className='flex-1 relative min-h-0 w-full'
                onTouchStart={onTouchStart}
                onTouchMove={onTouchMove}
                onTouchEnd={onTouchEnd}
              >
                {isMobileOrTabletPortrait ? (
                  <div className='relative w-full h-full overflow-hidden'>
                    {/* Container that slides horizontally */}
                    <div
                      className={cn(
                        'flex w-full h-full',
                        isAnimating ? 'transition-transform duration-300 ease-out' : '',
                        isDragging ? 'transition-none' : ''
                      )}
                      style={{
                        transform: (() => {
                          if (isDragging) {
                            // Follow finger during drag
                            return `translateX(${-dragOffset}px)`;
                          } else if (isAnimating && slideDirection) {
                            // Animate to show new tab
                            return slideDirection === 'left'
                              ? 'translateX(-100%)' // Slide left to show next tab
                              : 'translateX(100%)';  // Slide right to show previous tab
                          }
                          return 'translateX(0)';
                        })()
                      }}
                    >
                      {/* Previous tab (for right swipe) */}
                      {((isAnimating || isDragging) && slideDirection === 'right' && nextTab) && (
                        <div className='w-full h-full flex-shrink-0 flex flex-col'>
                          {nextTab === 'jobs' ? (
                            <>
                              <div className={cn(
                                'flex-shrink-0 flex items-center justify-between p-4 bg-gradient-to-r from-blue-50/50 to-indigo-50/50 dark:from-blue-950/20 dark:to-indigo-950/20 border border-blue-200/30 dark:border-blue-800/30 mb-4',
                                isMobilePhone && 'p-3'
                              )}>
                                <div className='flex items-center gap-3'>
                                  <div className='w-8 h-8 bg-blue-100 dark:bg-blue-900/50 flex items-center justify-center'>
                                    <Activity className='w-4 h-4 text-blue-600 dark:text-blue-400' />
                                  </div>
                                  <div>
                                    <h3 className={cn('font-semibold text-zinc-900 dark:text-white', isMobilePhone ? 'text-sm' : 'text-base')}>
                                      Processing Jobs
                                    </h3>
                                    <p className={cn('text-zinc-500 dark:text-zinc-400', isMobilePhone ? 'text-xs' : 'text-sm')}>
                                      {activeJobsCount > 0 ? `${activeJobsCount} active` : 'No active jobs'}
                                    </p>
                                  </div>
                                </div>
                                <Button variant='outline' size='sm' onClick={handleRefreshJobs} disabled={isRefreshing} className={cn('bg-white/80 dark:bg-zinc-800/80 border-blue-200 dark:border-blue-800 hover:bg-white dark:hover:bg-zinc-800', isMobilePhone ? 'h-8 px-3' : 'h-9 px-4')}>
                                  <RefreshCw className={cn(isRefreshing ? 'animate-spin' : '', isMobilePhone ? 'h-3 w-3 mr-1.5' : 'h-4 w-4 mr-2')} />
                                  <span className={isMobilePhone ? 'text-xs' : 'text-sm'}>Refresh</span>
                                </Button>
                              </div>
                              <div className='flex-1 flex flex-col min-h-0 w-full'>{renderJobsContent()}</div>
                            </>
                          ) : (
                            <>
                              <div className={cn('flex-shrink-0 flex items-center justify-between p-4 bg-gradient-to-r from-purple-50/50 to-violet-50/50 dark:from-purple-950/20 dark:to-violet-950/20 border border-purple-200/30 dark:border-purple-800/30 mb-4', isMobilePhone && 'p-3')}>
                                <div className='flex items-center gap-3'>
                                  <div className='w-8 h-8 bg-purple-100 dark:bg-purple-900/50 flex items-center justify-center'>
                                    <Server className='w-4 h-4 text-purple-600 dark:text-purple-400' />
                                  </div>
                                  <div>
                                    <h3 className={cn('font-semibold text-zinc-900 dark:text-white', isMobilePhone ? 'text-sm' : 'text-base')}>System Status</h3>
                                    <p className={cn('text-zinc-500 dark:text-zinc-400', isMobilePhone ? 'text-xs' : 'text-sm')}>Monitor system health</p>
                                  </div>
                                </div>
                                <Button variant='outline' size='sm' onClick={handleRefreshStatus} disabled={isLoadingStatus} className={cn('bg-white/80 dark:bg-zinc-800/80 border-purple-200 dark:border-purple-800 hover:bg-white dark:hover:bg-zinc-800', isMobilePhone ? 'h-8 px-3' : 'h-9 px-4')}>
                                  <RefreshCw className={cn(isLoadingStatus ? 'animate-spin' : '', isMobilePhone ? 'h-3 w-3 mr-1.5' : 'h-4 w-4 mr-2')} />
                                  <span className={isMobilePhone ? 'text-xs' : 'text-sm'}>Refresh</span>
                                </Button>
                              </div>
                              <div className='flex-1 flex flex-col min-h-0 w-full'>{renderSystemContent()}</div>
                            </>
                          )}
                        </div>
                      )}

                      {/* Current tab */}
                      <div className='w-full h-full flex-shrink-0 flex flex-col'>
                        {activeTab === 'jobs' ? (
                          <>
                            <div className={cn(
                              'flex-shrink-0 flex items-center justify-between p-4 bg-gradient-to-r from-blue-50/50 to-indigo-50/50 dark:from-blue-950/20 dark:to-indigo-950/20 border border-blue-200/30 dark:border-blue-800/30 mb-4',
                              isMobilePhone && 'p-3'
                            )}>
                              <div className='flex items-center gap-3'>
                                <div className='w-8 h-8 bg-blue-100 dark:bg-blue-900/50 flex items-center justify-center'>
                                  <Activity className='w-4 h-4 text-blue-600 dark:text-blue-400' />
                                </div>
                                <div>
                                  <h3 className={cn('font-semibold text-zinc-900 dark:text-white', isMobilePhone ? 'text-sm' : 'text-base')}>
                                    Processing Jobs
                                  </h3>
                                  <p className={cn('text-zinc-500 dark:text-zinc-400', isMobilePhone ? 'text-xs' : 'text-sm')}>
                                    {activeJobsCount > 0 ? `${activeJobsCount} active` : 'No active jobs'}
                                  </p>
                                </div>
                              </div>
                              <Button variant='outline' size='sm' onClick={handleRefreshJobs} disabled={isRefreshing} className={cn('bg-white/80 dark:bg-zinc-800/80 border-blue-200 dark:border-blue-800 hover:bg-white dark:hover:bg-zinc-800', isMobilePhone ? 'h-8 px-3' : 'h-9 px-4')}>
                                <RefreshCw className={cn(isRefreshing ? 'animate-spin' : '', isMobilePhone ? 'h-3 w-3 mr-1.5' : 'h-4 w-4 mr-2')} />
                                <span className={isMobilePhone ? 'text-xs' : 'text-sm'}>Refresh</span>
                              </Button>
                            </div>
                            <div className='flex-1 flex flex-col min-h-0 w-full'>{renderJobsContent()}</div>
                          </>
                        ) : (
                          <>
                            <div className={cn('flex-shrink-0 p-4 bg-gradient-to-r from-purple-50/50 to-violet-50/50 dark:from-purple-950/20 dark:to-violet-950/20 border border-purple-200/30 dark:border-purple-800/30 mb-4', isMobilePhone && 'p-3')}>
                              <div className='flex items-center gap-3'>
                                <div className='w-8 h-8 bg-purple-100 dark:bg-purple-900/50 flex items-center justify-center'>
                                  <Server className='w-4 h-4 text-purple-600 dark:text-purple-400' />
                                </div>
                                <div>
                                  <h3 className={cn('font-semibold text-zinc-900 dark:text-white', isMobilePhone ? 'text-sm' : 'text-base')}>System Status</h3>
                                  <p className={cn('text-zinc-500 dark:text-zinc-400', isMobilePhone ? 'text-xs' : 'text-sm')}>Monitor system health</p>
                                </div>
                              </div>
                            </div>
                            <div className='flex-1 flex flex-col min-h-0 w-full'>{renderSystemContent()}</div>
                          </>
                        )}
                      </div>

                      {/* Next tab (for left swipe) */}
                      {((isAnimating || isDragging) && slideDirection === 'left' && nextTab) && (
                        <div className='w-full h-full flex-shrink-0 flex flex-col'>
                          {nextTab === 'jobs' ? (
                            <>
                              <div className={cn(
                                'flex-shrink-0 flex items-center justify-between p-4 bg-gradient-to-r from-blue-50/50 to-indigo-50/50 dark:from-blue-950/20 dark:to-indigo-950/20 border border-blue-200/30 dark:border-blue-800/30 mb-4',
                                isMobilePhone && 'p-3'
                              )}>
                                <div className='flex items-center gap-3'>
                                  <div className='w-8 h-8 bg-blue-100 dark:bg-blue-900/50 flex items-center justify-center'>
                                    <Activity className='w-4 h-4 text-blue-600 dark:text-blue-400' />
                                  </div>
                                  <div>
                                    <h3 className={cn('font-semibold text-zinc-900 dark:text-white', isMobilePhone ? 'text-sm' : 'text-base')}>
                                      Processing Jobs
                                    </h3>
                                    <p className={cn('text-zinc-500 dark:text-zinc-400', isMobilePhone ? 'text-xs' : 'text-sm')}>
                                      {activeJobsCount > 0 ? `${activeJobsCount} active` : 'No active jobs'}
                                    </p>
                                  </div>
                                </div>
                                <Button variant='outline' size='sm' onClick={handleRefreshJobs} disabled={isRefreshing} className={cn('bg-white/80 dark:bg-zinc-800/80 border-blue-200 dark:border-blue-800 hover:bg-white dark:hover:bg-zinc-800', isMobilePhone ? 'h-8 px-3' : 'h-9 px-4')}>
                                  <RefreshCw className={cn(isRefreshing ? 'animate-spin' : '', isMobilePhone ? 'h-3 w-3 mr-1.5' : 'h-4 w-4 mr-2')} />
                                  <span className={isMobilePhone ? 'text-xs' : 'text-sm'}>Refresh</span>
                                </Button>
                              </div>
                              <div className='flex-1 flex flex-col min-h-0 w-full'>{renderJobsContent()}</div>
                            </>
                          ) : (
                            <>
                              <div className={cn('flex-shrink-0 flex items-center justify-between p-4 bg-gradient-to-r from-purple-50/50 to-violet-50/50 dark:from-purple-950/20 dark:to-violet-950/20 border border-purple-200/30 dark:border-purple-800/30 mb-4', isMobilePhone && 'p-3')}>
                                <div className='flex items-center gap-3'>
                                  <div className='w-8 h-8 bg-purple-100 dark:bg-purple-900/50 flex items-center justify-center'>
                                    <Server className='w-4 h-4 text-purple-600 dark:text-purple-400' />
                                  </div>
                                  <div>
                                    <h3 className={cn('font-semibold text-zinc-900 dark:text-white', isMobilePhone ? 'text-sm' : 'text-base')}>System Status</h3>
                                    <p className={cn('text-zinc-500 dark:text-zinc-400', isMobilePhone ? 'text-xs' : 'text-sm')}>Monitor system health</p>
                                  </div>
                                </div>
                                <Button variant='outline' size='sm' onClick={handleRefreshStatus} disabled={isLoadingStatus} className={cn('bg-white/80 dark:bg-zinc-800/80 border-purple-200 dark:border-purple-800 hover:bg-white dark:hover:bg-zinc-800', isMobilePhone ? 'h-8 px-3' : 'h-9 px-4')}>
                                  <RefreshCw className={cn(isLoadingStatus ? 'animate-spin' : '', isMobilePhone ? 'h-3 w-3 mr-1.5' : 'h-4 w-4 mr-2')} />
                                  <span className={isMobilePhone ? 'text-xs' : 'text-sm'}>Refresh</span>
                                </Button>
                              </div>
                              <div className='flex-1 flex flex-col min-h-0 w-full'>{renderSystemContent()}</div>
                            </>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                ) : (
                  // Desktop version - use regular TabsContent
                  <>
                    <TabsContent value='jobs' className='absolute inset-0 flex flex-col w-full'>
                      <div className={cn(
                        'flex-shrink-0 flex items-center justify-between p-4 bg-gradient-to-r from-blue-50/50 to-indigo-50/50 dark:from-blue-950/20 dark:to-indigo-950/20 border border-blue-200/30 dark:border-blue-800/30 mb-4',
                        isMobilePhone && 'p-3'
                      )}>
                        <div className='flex items-center gap-3'>
                          <div className='w-8 h-8 bg-blue-100 dark:bg-blue-900/50 flex items-center justify-center'>
                            <Activity className='w-4 h-4 text-blue-600 dark:text-blue-400' />
                          </div>
                          <div>
                            <h3 className={cn('font-semibold text-zinc-900 dark:text-white', isMobilePhone ? 'text-sm' : 'text-base')}>
                              Processing Jobs
                            </h3>
                            <p className={cn('text-zinc-500 dark:text-zinc-400', isMobilePhone ? 'text-xs' : 'text-sm')}>
                              {activeJobsCount > 0 ? `${activeJobsCount} active` : 'No active jobs'}
                            </p>
                          </div>
                        </div>
                        <Button variant='outline' size='sm' onClick={handleRefreshJobs} disabled={isRefreshing} className={cn('bg-white/80 dark:bg-zinc-800/80 border-blue-200 dark:border-blue-800 hover:bg-white dark:hover:bg-zinc-800', isMobilePhone ? 'h-8 px-3' : 'h-9 px-4')}>
                          <RefreshCw className={cn(isRefreshing ? 'animate-spin' : '', isMobilePhone ? 'h-3 w-3 mr-1.5' : 'h-4 w-4 mr-2')} />
                          <span className={isMobilePhone ? 'text-xs' : 'text-sm'}>Refresh</span>
                        </Button>
                      </div>
                      <div className='flex-1 flex flex-col min-h-0 w-full'>{renderJobsContent()}</div>
                    </TabsContent>

                    <TabsContent value='system' className='absolute inset-0 flex flex-col w-full'>
                      <div className={cn('flex-shrink-0 flex items-center justify-between p-4 bg-gradient-to-r from-purple-50/50 to-violet-50/50 dark:from-purple-950/20 dark:to-violet-950/20 border border-purple-200/30 dark:border-purple-800/30 mb-4', isMobilePhone && 'p-3')}>
                        <div className='flex items-center gap-3'>
                          <div className='w-8 h-8 bg-purple-100 dark:bg-purple-900/50 flex items-center justify-center'>
                            <Server className='w-4 h-4 text-purple-600 dark:text-purple-400' />
                          </div>
                          <div>
                            <h3 className={cn('font-semibold text-zinc-900 dark:text-white', isMobilePhone ? 'text-sm' : 'text-base')}>System Status</h3>
                            <p className={cn('text-zinc-500 dark:text-zinc-400', isMobilePhone ? 'text-xs' : 'text-sm')}>Monitor system health</p>
                          </div>
                        </div>
                        <Button variant='outline' size='sm' onClick={handleRefreshStatus} disabled={isLoadingStatus} className={cn('bg-white/80 dark:bg-zinc-800/80 border-purple-200 dark:border-purple-800 hover:bg-white dark:hover:bg-zinc-800', isMobilePhone ? 'h-8 px-3' : 'h-9 px-4')}>
                          <RefreshCw className={cn(isLoadingStatus ? 'animate-spin' : '', isMobilePhone ? 'h-3 w-3 mr-1.5' : 'h-4 w-4 mr-2')} />
                          <span className={isMobilePhone ? 'text-xs' : 'text-sm'}>Refresh</span>
                        </Button>
                      </div>
                      <div className='flex-1 flex flex-col min-h-0 w-full'>{renderSystemContent()}</div>
                    </TabsContent>
                  </>
                )}
              </div>
            </Tabs>
          </div>
        </DialogContent>
      </Dialog>

    </div>
  );
};
