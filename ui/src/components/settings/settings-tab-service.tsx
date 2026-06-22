import React, { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useTranslation } from 'react-i18next';
import {
  Check,
  Copy,
  Filter,
  Loader2,
  Maximize2,
  Minimize2,
  Pause,
  Play,
  RefreshCw,
  Server,
  Terminal,
  WrapText,
  X,
  Settings as SettingsIcon,
} from 'lucide-react';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { useIsMobileOrTabletPortrait } from '@/hooks/use-mobile';
import {
  getLocalServiceLogs,
  getDockerContainerLogs,
  getContainerResources,
  SystemResourceOverview,
} from '@/lib/api-settings';
import SettingsResourceMonitor from './settings-resource-monitor';

interface SettingsTabServiceProps {
  autoTitleGenerate: 'LOCAL' | 'REMOTE';
  setAutoTitleGenerate: (value: 'LOCAL' | 'REMOTE') => void;
  proxyAddress: string;
  setProxyAddress: (value: string) => void;
}

const SettingsTabService: React.FC<SettingsTabServiceProps> = ({
  autoTitleGenerate,
  setAutoTitleGenerate,
  proxyAddress,
  setProxyAddress,
}) => {
  const { t } = useTranslation();
  const isMobileOrTabletPortrait = useIsMobileOrTabletPortrait();

  const [logs, setLogs] = useState<string>('');
  const [_isLoadingStatus, setIsLoadingStatus] = useState<boolean>(false);
  const [isLoadingLogs, setIsLoadingLogs] = useState<boolean>(false);
  const [autoRefresh, setAutoRefresh] = useState<boolean>(false);
  const [isLogsExpanded, setIsLogsExpanded] = useState<boolean>(false);
  const [wordWrap, setWordWrap] = useState<boolean>(true);
  const [logLevel, setLogLevel] = useState<string>('ALL');
  const [timeRange, setTimeRange] = useState<string>('all');
  const logsTextareaRef = useRef<HTMLDivElement>(null);
  const autoRefreshIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const [isAutoRefreshing, setIsAutoRefreshing] = useState<boolean>(false);
  const [copied, setCopied] = useState<boolean>(false);

  // Resource monitoring state
  const [resourceData, setResourceData] = useState<SystemResourceOverview | null>(null);
  const [isLoadingResources, setIsLoadingResources] = useState<boolean>(false);
  const [resourceRefreshInterval, setResourceRefreshInterval] = useState<number>(0);
  const resourceAutoRefreshRef = useRef<NodeJS.Timeout | null>(null);

  // When set, the Service Logs panel shows `docker logs <name>` instead of
  // the local Python service log file. Toggled by clicking a row in the
  // resource monitor table.
  const [selectedContainer, setSelectedContainer] = useState<string | null>(null);

  // Renders colorized log lines from a raw log string.
  // Used in both the expanded and the normal log views to avoid duplication.
  const renderLogLines = () =>
    logs ? (
      logs
        .replace(/\x1b\[[0-9;]*m/g, '') // eslint-disable-line no-control-regex -- stripping ANSI escape codes from Docker logs
        .split('\n')
        .map((line, index) => {
          const isWarning =
            line.includes('[WARNING]') || line.includes('[WARN]');
          const isError =
            line.includes('[ERROR]') || line.includes('[ERR]');

          let lineClass = 'text-zinc-800 dark:text-zinc-300';

          if (isError) {
            lineClass =
              'bg-red-200 dark:bg-red-800/50 text-red-900 dark:text-red-100 px-1 -mx-1';
          } else if (isWarning) {
            lineClass =
              'bg-orange-100 dark:bg-orange-900/30 text-orange-800 dark:text-orange-200 px-1 -mx-1';
          }

          return (
            <div key={index} className={lineClass}>
              {line || '\u00A0'}
            </div>
          );
        })
    ) : (
      <div className='text-zinc-500 dark:text-zinc-400'>
        {t('settings.service.logsPlaceholder', 'Logs will appear here...')}
      </div>
    );

  const handleCopyLogs = async () => {
    if (!logs) return;
    // eslint-disable-next-line no-control-regex -- stripping ANSI escape codes from Docker logs
    const clean = logs.replace(/\x1b\[[0-9;]*m/g, '');
    try {
      await navigator.clipboard.writeText(clean);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (error) {
      console.error('Failed to copy logs:', error);
    }
  };

  // Helper function to scroll to bottom
  const scrollToBottom = () => {
    const scrollContainer = logsTextareaRef.current;
    if (scrollContainer) {
      setTimeout(() => {
        scrollContainer.scrollTop = scrollContainer.scrollHeight;
      }, 0);
    }
  };

  const fetchStatus = async () => {
    setIsLoadingStatus(true);
    try {
      // Mock service status for now

    } catch (error) {
      // Handle error
    } finally {
      setIsLoadingStatus(false);
    }
  };

  const fetchLogs = async (isAutoRefresh = false) => {
    // Don't show loading spinner for auto-refresh to prevent blinking
    if (!isAutoRefresh) {
      setIsLoadingLogs(true);
    } else {
      setIsAutoRefreshing(true);
    }

    try {
      const logsResponse = selectedContainer
        ? await getDockerContainerLogs(selectedContainer, 200, logLevel)
        : await getLocalServiceLogs(200, false, logLevel, timeRange);

      // Only update if logs have actually changed to prevent unnecessary re-renders
      if (logsResponse.logs !== logs) {
        setLogs(logsResponse.logs);

        // Always scroll to bottom after update
        scrollToBottom();
      }
    } catch (error) {
      console.error('Error fetching logs:', error);
      setLogs(
        `Error fetching logs: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    } finally {
      if (!isAutoRefresh) {
        setIsLoadingLogs(false);
      } else {
        setIsAutoRefreshing(false);
      }
    }
  };

  const fetchResources = async (isAuto = false) => {
    if (!isAuto) setIsLoadingResources(true);
    else setIsResourceAutoRefreshing(true);
    try {
      const data = await getContainerResources();
      setResourceData(data);
    } catch (error) {
      console.error('Error fetching resources:', error);
    } finally {
      if (!isAuto) setIsLoadingResources(false);
      else setIsResourceAutoRefreshing(false);
    }
  };

  const handleScroll = () => {
    // Handle scroll
  };

  const handleConfigChange = (
    _e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>
  ) => {
    // Handle config change
  };

  useEffect(() => {
    void fetchStatus();
    void fetchLogs();
    void fetchResources();
  // eslint-disable-next-line react-hooks/exhaustive-deps -- deps are intentionally limited
  }, []);

  useEffect(() => {
    if (autoRefresh) {
      autoRefreshIntervalRef.current = setInterval(() => fetchLogs(true), 5000);
    } else {
      if (autoRefreshIntervalRef.current) {
        clearInterval(autoRefreshIntervalRef.current);
        autoRefreshIntervalRef.current = null;
      }
    }

    return () => {
      if (autoRefreshIntervalRef.current) {
        clearInterval(autoRefreshIntervalRef.current);
      }
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps -- deps are intentionally limited
  }, [autoRefresh, logs]);

  // Resource auto-refresh with configurable interval
  useEffect(() => {
    if (resourceAutoRefreshRef.current) {
      clearInterval(resourceAutoRefreshRef.current);
      resourceAutoRefreshRef.current = null;
    }
    if (resourceRefreshInterval > 0) {
      resourceAutoRefreshRef.current = setInterval(() => fetchResources(true), resourceRefreshInterval);
    }
    return () => {
      if (resourceAutoRefreshRef.current) clearInterval(resourceAutoRefreshRef.current);
    };
  }, [resourceRefreshInterval]);

  // Refetch logs when filters or the selected container change
  useEffect(() => {
    void fetchLogs();
  // eslint-disable-next-line react-hooks/exhaustive-deps -- deps are intentionally limited
  }, [logLevel, timeRange, selectedContainer]);

  // Auto-scroll when logs view is expanded
  useEffect(() => {
    if (isLogsExpanded && logs) {
      scrollToBottom();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- deps are intentionally limited
  }, [isLogsExpanded]);

  // Auto-scroll when logs container first becomes visible (when logs are loaded)
  useEffect(() => {
    if (logs && !isLoadingLogs) {
      scrollToBottom();
    }
  }, [logs, isLoadingLogs]);

  if (isLogsExpanded) {
    return (
      <div className={`fixed inset-0 z-20 bg-background dark:bg-black ${isMobileOrTabletPortrait ? 'p-2' : 'p-6'}`}>
        <div className='h-full flex flex-col'>
          <div className='flex justify-between items-center mb-4 gap-2'>
            <h2 className='text-lg font-semibold text-zinc-800 dark:text-white flex items-center gap-2 min-w-0'>
              <Terminal className='h-5 w-5 text-zinc-600 dark:text-zinc-400 flex-shrink-0' />
              <span className='truncate'>Service Logs</span>
            </h2>
            <div className='flex items-center gap-2 flex-shrink-0'>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant='outline'
                    size='sm'
                    title='Filter options'
                    className='border-zinc-300 dark:border-zinc-700 text-zinc-800 dark:text-zinc-200 w-9 h-9 p-0'
                  >
                    <Filter className='h-4 w-4' />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent className='w-40 z-[1100] p-2' align='end'>
                  <DropdownMenuLabel className='px-1 py-1 text-xs font-medium'>Log Level</DropdownMenuLabel>
                  <Select value={logLevel} onValueChange={setLogLevel}>
                    <SelectTrigger className='h-7 text-xs mb-2'>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent className='z-[1100]'>
                      <SelectItem value='ALL'>ALL</SelectItem>
                      <SelectItem value='DEBUG'>DEBUG</SelectItem>
                      <SelectItem value='INFO'>INFO</SelectItem>
                      <SelectItem value='WARNING'>WARNING</SelectItem>
                      <SelectItem value='ERROR'>ERROR</SelectItem>
                    </SelectContent>
                  </Select>
                  {!selectedContainer && (
                    <>
                      <DropdownMenuLabel className='px-1 py-1 text-xs font-medium'>Time Range</DropdownMenuLabel>
                      <Select value={timeRange} onValueChange={setTimeRange}>
                        <SelectTrigger className='h-7 text-xs mb-2'>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent className='z-[1100]'>
                          <SelectItem value='all'>All Time</SelectItem>
                          <SelectItem value='15m'>Last 15 minutes</SelectItem>
                          <SelectItem value='1h'>Last 1 hour</SelectItem>
                          <SelectItem value='1d'>Last 1 day</SelectItem>
                        </SelectContent>
                      </Select>
                    </>
                  )}
                  <DropdownMenuSeparator className='my-1' />
                  <DropdownMenuItem
                    onClick={() => setWordWrap(!wordWrap)}
                    className='flex items-center justify-between px-2 py-1.5 text-xs'
                  >
                    <span>Word Wrap</span>
                    <WrapText className={`h-3.5 w-3.5 ${wordWrap ? 'text-blue-600 dark:text-blue-400' : 'text-zinc-400'
                      }`} />
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
              <Button
                onClick={() => void handleCopyLogs()}
                variant='outline'
                size='sm'
                disabled={!logs}
                title={copied ? 'Copied!' : 'Copy filtered logs'}
                className='border-zinc-300 dark:border-zinc-700 text-zinc-800 dark:text-zinc-200 w-9 h-9 p-0'
              >
                {copied ? (
                  <Check className='h-4 w-4 text-green-600 dark:text-green-400' />
                ) : (
                  <Copy className='h-4 w-4' />
                )}
              </Button>
              <Button
                onClick={() => setAutoRefresh(!autoRefresh)}
                variant='outline'
                size='sm'
                title={autoRefresh ? 'Stop auto-refresh' : 'Start auto-refresh'}
                className='border-zinc-300 dark:border-zinc-700 text-zinc-800 dark:text-zinc-200 w-9 h-9 p-0'
              >
                {autoRefresh ? (
                  isAutoRefreshing ? (
                    <Loader2 className='h-3 w-3 animate-spin' />
                  ) : (
                    <Pause className='h-4 w-4' />
                  )
                ) : (
                  <Play className='h-4 w-4' />
                )}
              </Button>
              <Button
                onClick={() => {
                  void fetchLogs(false);
                  // Ensure scroll to bottom after manual refresh
                  setTimeout(() => scrollToBottom(), 100);
                }}
                variant='outline'
                size='sm'
                disabled={isLoadingLogs}
                title='Refresh logs manually'
                className='border-zinc-300 dark:border-zinc-700 text-zinc-800 dark:text-zinc-200 w-9 h-9 p-0'
              >
                {isLoadingLogs ? (
                  <Loader2 className='h-4 w-4 animate-spin' />
                ) : (
                  <RefreshCw className='h-4 w-4' />
                )}
              </Button>
              <Button
                onClick={() => setIsLogsExpanded(false)}
                variant='outline'
                size='sm'
                title='Collapse to normal view'
                className='border-zinc-300 dark:border-zinc-700 text-zinc-800 dark:text-zinc-200 w-9 h-9 p-0'
              >
                <Minimize2 className='h-4 w-4' />
              </Button>
            </div>
          </div>
          {selectedContainer && (
            <div className='-mt-2 mb-3 flex items-center'>
              <span className='inline-flex items-center gap-1 text-xs font-mono px-2 py-0.5 bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 max-w-full'>
                <span className='truncate'>{selectedContainer}</span>
                <button
                  onClick={() => setSelectedContainer(null)}
                  title='Show local service logs'
                  className='flex-shrink-0 hover:bg-blue-200 dark:hover:bg-blue-800/50 p-0.5'
                >
                  <X className='h-3 w-3' />
                </button>
              </span>
            </div>
          )}
          {isLoadingLogs ? (
            <div className='flex justify-center items-center flex-1'>
              <Loader2 className='h-8 w-8 animate-spin text-zinc-500 dark:text-zinc-400' />
            </div>
          ) : (
            <div className='border border-zinc-200 dark:border-zinc-800 rounded-lg overflow-hidden flex-1'>
              <div
                ref={logsTextareaRef}
                onScroll={handleScroll}
                className={`h-full font-mono text-xs bg-zinc-100 dark:bg-zinc-900 border-0 resize-none p-3 overflow-y-auto ${wordWrap ? 'whitespace-pre-wrap break-words' : 'whitespace-pre overflow-x-auto'
                  }`}
              >
                {renderLogLines()}
              </div>
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <>
      <div className='hidden lg:block mb-6'>
        <div>
          <h2 className='text-2xl font-bold text-zinc-900 dark:text-white mb-1'>
            {t('settings.service.title', 'Service Configuration')}
          </h2>
          <p className='text-sm text-zinc-500 dark:text-zinc-400'>
            Configure local service settings and monitor logs
          </p>
        </div>
      </div>

      <div className='space-y-6'>
        {/* Mobile Header - Show on mobile only */}
        <div className='lg:hidden mb-4'>
          <h2 className='text-xl font-bold text-zinc-900 dark:text-white mb-1'>
            {t('settings.service.title', 'Service Configuration')}
          </h2>
          <p className='text-sm text-zinc-500 dark:text-zinc-400'>
            {t('settings.service.description')}
          </p>
        </div>

        {/* Auto-generate Chat Title Card */}
        <div className='relative overflow-hidden bg-white dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 p-4 shadow-sm'>
          <div className='flex items-center gap-3 mb-5'>
            <div className='w-10 h-10 flex items-center justify-center'>
              <SettingsIcon className='w-5 h-5 text-purple-600 dark:text-purple-400' />
            </div>
            <div className='flex-1'>
              <h3 className='text-lg font-semibold text-zinc-900 dark:text-white'>
                {t('settings.chatTitle.title')}
              </h3>
              <p className='text-sm text-zinc-600 dark:text-zinc-400'>
                {t('settings.chatTitle.description')}
              </p>
            </div>
          </div>
          <div className='pl-13'>
            <RadioGroup
              value={autoTitleGenerate}
              onValueChange={value =>
                setAutoTitleGenerate(value as 'LOCAL' | 'REMOTE')
              }
              className='space-y-3 lg:flex lg:flex-row lg:space-y-0 lg:gap-3'
            >
              <div className='flex items-center space-x-3 p-4 rounded-lg border border-zinc-200 dark:border-zinc-800 hover:bg-zinc-50 dark:hover:bg-zinc-900/50 transition-colors cursor-pointer'>
                <RadioGroupItem value='LOCAL' id='title-local' className='flex-shrink-0' data-testid="settings-service-title-local" />
                <Label
                  htmlFor='title-local'
                  className='text-sm font-medium text-zinc-900 dark:text-white cursor-pointer flex-1'
                >
                  {t('settings.chatTitle.localModels')}
                </Label>
              </div>
              <div className='flex items-center space-x-3 p-4 rounded-lg border border-zinc-200 dark:border-zinc-800 hover:bg-zinc-50 dark:hover:bg-zinc-900/50 transition-colors cursor-pointer'>
                <RadioGroupItem value='REMOTE' id='title-remote' className='flex-shrink-0' data-testid="settings-service-title-remote" />
                <Label
                  htmlFor='title-remote'
                  className='text-sm font-medium text-zinc-900 dark:text-white cursor-pointer flex-1'
                >
                  {t('settings.chatTitle.remoteModels')}
                </Label>
              </div>
            </RadioGroup>
          </div>
        </div>

        {/* Network Proxy Configuration Card */}
        <div className='relative overflow-hidden bg-white dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 p-4 shadow-sm'>
          <div className='flex items-center gap-3 mb-5'>
            <div className='w-10 h-10 flex items-center justify-center'>
              <Server className='w-5 h-5 text-green-600 dark:text-green-400' />
            </div>
            <div className='flex-1'>
              <h3 className='text-lg font-semibold text-zinc-900 dark:text-white'>
                {t('settings.networkProxy.title')}
              </h3>
              <p className='text-sm text-zinc-600 dark:text-zinc-400'>
                {t('settings.networkProxy.description')}
              </p>
            </div>
          </div>
          <div className='pl-13'>
            <div className='space-y-2'>
              <Label
                htmlFor='proxy-address'
                className='text-zinc-800 dark:text-zinc-200'
              >
                {t('settings.networkProxy.proxyAddress')}
              </Label>
              <Input
                id='proxy-address'
                className='border-zinc-300 dark:border-zinc-700 max-w-xl'
                placeholder='https://username:password@example.com:8090'
                value={proxyAddress}
                onChange={e => setProxyAddress(e.target.value)}
                data-testid="settings-service-proxy-input"
              />
              <p className='text-xs text-zinc-500 dark:text-zinc-400'>
                {t('settings.networkProxy.description')}
              </p>
            </div>
          </div>
        </div>

        {/* Service Configuration Card */}
        <div className='relative overflow-hidden bg-white dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 p-4 shadow-sm'>
          <div className='flex items-center gap-3 mb-5'>
            <div className='w-10 h-10 flex items-center justify-center'>
              <Server className='w-5 h-5 text-blue-600 dark:text-blue-400' />
            </div>
            <h3 className='text-lg font-semibold text-zinc-900 dark:text-white'>
              {t('settings.service.configTitle')}
            </h3>
          </div>
          <div className='space-y-6'>
            <div className='grid grid-cols-1 gap-6'>
              <div className='space-y-2'>
                <Label
                  htmlFor='port'
                  className='text-zinc-800 dark:text-zinc-200'
                >
                  {t('settings.service.portNumber', 'Port Number')}
                </Label>
                <Input
                  id='port'
                  name='port'
                  defaultValue='8090'
                  onChange={handleConfigChange}
                  placeholder='e.g., 8090'
                  className='border-border dark:border-zinc-700 bg-input dark:bg-zinc-800'
                  data-testid="settings-service-port-input"
                />
                <p className='text-xs text-zinc-500 dark:text-zinc-400'>
                  {t(
                    'settings.service.portDescription',
                    'Port number for the local service to listen on.'
                  )}
                </p>
              </div>
              <div className='space-y-2'>
                <Label
                  htmlFor='models_directory'
                  className='text-zinc-800 dark:text-zinc-200'
                >
                  {t('settings.service.modelsPath', 'Configured Models Path')}
                </Label>
                <Input
                  id='models_directory'
                  name='models_directory'
                  defaultValue='models'
                  onChange={handleConfigChange}
                  placeholder='e.g., models'
                  className='border-border dark:border-zinc-700 bg-input dark:bg-zinc-800'
                  data-testid="settings-service-models-path-input"
                />
                <p className='text-xs text-zinc-500 dark:text-zinc-400'>
                  {t(
                    'settings.service.modelsPathDescription',
                    'Directory where model files are stored.'
                  )}
                </p>
              </div>
            </div>

            <div className='bg-zinc-100 dark:bg-zinc-900 p-4 border border-zinc-200 dark:border-zinc-800'>
              <div className='flex justify-between items-start'>
                <div>
                  <h4 className='text-base font-medium text-zinc-800 dark:text-white mb-1'>
                    {t(
                      'settings.service.networkAccess',
                      'Enable Network Access'
                    )}
                  </h4>
                  <p className='text-sm text-zinc-600 dark:text-zinc-400'>
                    {t(
                      'settings.service.networkAccessDescription',
                      'Allow the service to be accessible from other devices on the network.'
                    )}
                  </p>
                </div>
                <Switch
                  id='enable_network_access'
                  checked={false}
                  onCheckedChange={() => { }}
                  data-testid="settings-service-network-access-toggle"
                />
              </div>
            </div>
          </div>
        </div>

        {/* System Resources Card */}
        <SettingsResourceMonitor
          resourceData={resourceData}
          isLoadingResources={isLoadingResources}
          refreshInterval={resourceRefreshInterval}
          onSetRefreshInterval={setResourceRefreshInterval}
          onRefresh={() => fetchResources(false)}
          selectedContainer={selectedContainer}
          onSelectContainer={setSelectedContainer}
        />

        {/* Service Logs Card */}
        <div className='relative overflow-hidden bg-white dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 p-4 shadow-sm'>
          <div className='flex items-center justify-between mb-4 gap-2'>
            <h3 className='text-base font-medium text-zinc-800 dark:text-white flex items-center gap-2 min-w-0'>
              <Server className='h-4 w-4 text-zinc-600 dark:text-zinc-400 flex-shrink-0' />
              <span className='truncate'>{t('settings.service.logsTitle')}</span>
            </h3>
            <div className='flex items-center gap-2 flex-shrink-0'>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant='outline'
                    size='sm'
                    title='Filter options'
                    className='border-zinc-300 dark:border-zinc-700 text-zinc-800 dark:text-zinc-200 w-9 h-9 p-0'
                  >
                    <Filter className='h-4 w-4' />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent className='w-40 z-[1100] p-2' align='end'>
                  <DropdownMenuLabel className='px-1 py-1 text-xs font-medium'>Log Level</DropdownMenuLabel>
                  <Select value={logLevel} onValueChange={setLogLevel}>
                    <SelectTrigger className='h-7 text-xs mb-2'>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent className='z-[1100]'>
                      <SelectItem value='ALL'>ALL</SelectItem>
                      <SelectItem value='DEBUG'>DEBUG</SelectItem>
                      <SelectItem value='INFO'>INFO</SelectItem>
                      <SelectItem value='WARNING'>WARNING</SelectItem>
                      <SelectItem value='ERROR'>ERROR</SelectItem>
                    </SelectContent>
                  </Select>
                  {!selectedContainer && (
                    <>
                      <DropdownMenuLabel className='px-1 py-1 text-xs font-medium'>Time Range</DropdownMenuLabel>
                      <Select value={timeRange} onValueChange={setTimeRange}>
                        <SelectTrigger className='h-7 text-xs mb-2'>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent className='z-[1100]'>
                          <SelectItem value='all'>All Time</SelectItem>
                          <SelectItem value='15m'>Last 15 minutes</SelectItem>
                          <SelectItem value='1h'>Last 1 hour</SelectItem>
                          <SelectItem value='1d'>Last 1 day</SelectItem>
                        </SelectContent>
                      </Select>
                    </>
                  )}
                  <DropdownMenuSeparator className='my-1' />
                  <DropdownMenuItem
                    onClick={() => setWordWrap(!wordWrap)}
                    className='flex items-center justify-between px-2 py-1.5 text-xs'
                  >
                    <span>Word Wrap</span>
                    <WrapText className={`h-3.5 w-3.5 ${wordWrap ? 'text-blue-600 dark:text-blue-400' : 'text-zinc-400'
                      }`} />
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
              <Button
                onClick={() => void handleCopyLogs()}
                variant='outline'
                size='sm'
                disabled={!logs}
                title={copied ? 'Copied!' : 'Copy filtered logs'}
                className='border-zinc-300 dark:border-zinc-700 text-zinc-800 dark:text-zinc-200 w-9 h-9 p-0'
              >
                {copied ? (
                  <Check className='h-4 w-4 text-green-600 dark:text-green-400' />
                ) : (
                  <Copy className='h-4 w-4' />
                )}
              </Button>
              <Button
                onClick={() => setAutoRefresh(!autoRefresh)}
                variant='outline'
                size='sm'
                title={autoRefresh ? 'Stop auto-refresh' : 'Start auto-refresh'}
                className='border-zinc-300 dark:border-zinc-700 text-zinc-800 dark:text-zinc-200 w-9 h-9 p-0'
              >
                {autoRefresh ? (
                  isAutoRefreshing ? (
                    <Loader2 className='h-3 w-3 animate-spin' />
                  ) : (
                    <Pause className='h-4 w-4' />
                  )
                ) : (
                  <Play className='h-4 w-4' />
                )}
              </Button>
              <Button
                onClick={() => {
                  void fetchLogs(false);
                  // Ensure scroll to bottom after manual refresh
                  setTimeout(() => scrollToBottom(), 100);
                }}
                variant='outline'
                size='sm'
                disabled={isLoadingLogs}
                title='Refresh logs manually'
                className='border-zinc-300 dark:border-zinc-700 text-zinc-800 dark:text-zinc-200 w-9 h-9 p-0'
              >
                {isLoadingLogs ? (
                  <Loader2 className='h-4 w-4 animate-spin' />
                ) : (
                  <RefreshCw className='h-4 w-4' />
                )}
              </Button>
              <Button
                onClick={() => setIsLogsExpanded(!isLogsExpanded)}
                variant='outline'
                size='sm'
                title={
                  isLogsExpanded
                    ? 'Collapse to normal view'
                    : 'Expand to full screen'
                }
                className='border-zinc-300 dark:border-zinc-700 text-zinc-800 dark:text-zinc-200 w-9 h-9 p-0'
              >
                {isLogsExpanded ? (
                  <Minimize2 className='h-4 w-4' />
                ) : (
                  <Maximize2 className='h-4 w-4' />
                )}
              </Button>
            </div>
          </div>
          {selectedContainer && (
            <div className='-mt-2 mb-3 flex items-center'>
              <span className='inline-flex items-center gap-1 text-xs font-mono px-2 py-0.5 bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 max-w-full'>
                <span className='truncate'>{selectedContainer}</span>
                <button
                  onClick={() => setSelectedContainer(null)}
                  title='Show local service logs'
                  className='flex-shrink-0 hover:bg-blue-200 dark:hover:bg-blue-800/50 p-0.5'
                >
                  <X className='h-3 w-3' />
                </button>
              </span>
            </div>
          )}
          {isLoadingLogs ? (
            <div className='flex justify-center p-6'>
              <Loader2 className='h-8 w-8 animate-spin text-zinc-500 dark:text-zinc-400' />
            </div>
          ) : (
            <div className='border border-zinc-200 dark:border-zinc-800 rounded-lg overflow-hidden h-80'>
              <div
                ref={logsTextareaRef}
                onScroll={handleScroll}
                className={`font-mono text-xs bg-zinc-100 dark:bg-zinc-900 border-0 resize-none p-3 overflow-y-auto h-full ${wordWrap ? 'whitespace-pre-wrap break-words' : 'whitespace-pre overflow-x-auto'
                  }`}
              >
                {renderLogLines()}
              </div>
            </div>
          )}
        </div>
      </div>
    </>
  );
};

export default SettingsTabService;
