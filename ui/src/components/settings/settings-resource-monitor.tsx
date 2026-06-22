import React, { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useTranslation } from 'react-i18next';
import {
  AlertTriangle,
  Check,
  Cpu,
  HardDrive,
  Loader2,
  MemoryStick,
  Monitor,
  Pencil,
  RefreshCw,
  Server,
  X,
} from 'lucide-react';
import { useIsMobileOrTabletPortrait } from '@/hooks/use-mobile';
import {
  SystemResourceOverview,
  ContainerResourceStats,
  updateContainerLimits,
} from '@/lib/api-settings';

interface SettingsResourceMonitorProps {
  resourceData: SystemResourceOverview | null;
  isLoadingResources: boolean;
  refreshInterval: number;
  onSetRefreshInterval: (ms: number) => void;
  onRefresh: () => void;
  selectedContainer?: string | null;
  onSelectContainer?: (name: string | null) => void;
}

// Pin scrapalot-* containers at the top, then everything else.
// Stable alphabetic order within each group.
function sortContainers(containers: ContainerResourceStats[]): ContainerResourceStats[] {
  const scrapalot: ContainerResourceStats[] = [];
  const others: ContainerResourceStats[] = [];
  for (const c of containers) {
    if (c.name.startsWith('scrapalot-')) {
      scrapalot.push(c);
    } else {
      others.push(c);
    }
  }
  scrapalot.sort((a, b) => a.name.localeCompare(b.name));
  others.sort((a, b) => a.name.localeCompare(b.name));
  return [...scrapalot, ...others];
}

const SettingsResourceMonitor: React.FC<SettingsResourceMonitorProps> = ({
  resourceData,
  isLoadingResources,
  refreshInterval,
  onSetRefreshInterval,
  onRefresh,
  selectedContainer,
  onSelectContainer,
}) => {
  const { t } = useTranslation();
  const isMobileOrTabletPortrait = useIsMobileOrTabletPortrait();

  return (
    <div className='relative overflow-hidden bg-white dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 p-4 shadow-sm'>
      <div className='flex items-center justify-between mb-4'>
        <div className='flex items-center gap-3'>
          <div className='w-10 h-10 flex items-center justify-center'>
            <Monitor className='w-5 h-5 text-orange-600 dark:text-orange-400' />
          </div>
          <div>
            <h3 className='text-lg font-semibold text-zinc-900 dark:text-white'>
              {t('settings.service.resources.title')}
            </h3>
            <p className='text-sm text-zinc-600 dark:text-zinc-400'>
              {t('settings.service.resources.description')}
            </p>
          </div>
        </div>
        <div className='flex items-center gap-2'>
          {/* Refresh interval selector */}
          <Select
            value={String(refreshInterval)}
            onValueChange={(val) => onSetRefreshInterval(Number(val))}
          >
            <SelectTrigger className='h-9 w-[90px] text-xs border-zinc-300 dark:border-zinc-700'>
              <SelectValue />
            </SelectTrigger>
            <SelectContent className='z-[1100]'>
              <SelectItem value='0'>Off</SelectItem>
              <SelectItem value='5000'>5s</SelectItem>
              <SelectItem value='10000'>10s</SelectItem>
              <SelectItem value='30000'>30s</SelectItem>
            </SelectContent>
          </Select>
          <Button
            onClick={onRefresh}
            variant='outline'
            size='sm'
            disabled={isLoadingResources}
            title='Refresh resources'
            className='border-zinc-300 dark:border-zinc-700 text-zinc-800 dark:text-zinc-200 w-9 h-9 p-0'
          >
            {isLoadingResources ? (
              <Loader2 className='h-4 w-4 animate-spin' />
            ) : (
              <RefreshCw className='h-4 w-4' />
            )}
          </Button>
        </div>
      </div>

      {isLoadingResources && !resourceData ? (
        <div className='flex justify-center p-6'>
          <Loader2 className='h-8 w-8 animate-spin text-zinc-500 dark:text-zinc-400' />
        </div>
      ) : resourceData ? (
        <div className='space-y-4'>
          {/* Overcommit Warning */}
          {resourceData.overcommit_warning && (
            <div className='flex items-center gap-2 p-3 bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 text-amber-800 dark:text-amber-200 text-sm'>
              <AlertTriangle className='h-4 w-4 flex-shrink-0' />
              <span>
                {t('settings.service.resources.overcommitWarning', {
                  allocated: resourceData.total_allocated_memory_mb.toLocaleString(),
                  physical: resourceData.physical_memory_mb.toLocaleString(),
                })}
              </span>
            </div>
          )}

          {/* System Overview */}
          <div className={`grid ${isMobileOrTabletPortrait ? 'grid-cols-2' : 'grid-cols-4'} gap-3`}>
            <SystemMetricCard
              icon={<MemoryStick className='h-4 w-4 text-blue-500' />}
              label={t('settings.service.resources.ram')}
              value={`${resourceData.system.memory_percent.toFixed(0)}%`}
              detail={`${(resourceData.system.memory_used_mb / 1024).toFixed(1)}G / ${(resourceData.system.memory_total_mb / 1024).toFixed(1)}G`}
              percent={resourceData.system.memory_percent}
              barColor={resourceData.system.memory_percent >= 90 ? 'bg-red-500' : resourceData.system.memory_percent >= 70 ? 'bg-amber-500' : 'bg-blue-500'}
            />
            <SystemMetricCard
              icon={<Cpu className='h-4 w-4 text-green-500' />}
              label={t('settings.service.resources.load')}
              value={resourceData.system.load_average1m.toFixed(2)}
              detail={`${resourceData.system.load_average5m.toFixed(2)} / ${resourceData.system.load_average15m.toFixed(2)} (${resourceData.system.cpu_count} ${t('settings.service.resources.cores')})`}
              percent={(resourceData.system.load_average1m / Math.max(resourceData.system.cpu_count, 1)) * 100}
              barColor={
                resourceData.system.load_average1m / Math.max(resourceData.system.cpu_count, 1) >= 1.0 ? 'bg-red-500'
                : resourceData.system.load_average1m / Math.max(resourceData.system.cpu_count, 1) >= 0.7 ? 'bg-amber-500'
                : 'bg-green-500'
              }
            />
            <SystemMetricCard
              icon={<HardDrive className='h-4 w-4 text-purple-500' />}
              label={t('settings.service.resources.disk')}
              value={`${resourceData.system.disk_percent.toFixed(0)}%`}
              detail={`${resourceData.system.disk_used_gb.toFixed(1)}G / ${resourceData.system.disk_total_gb.toFixed(1)}G`}
              percent={resourceData.system.disk_percent}
              barColor={resourceData.system.disk_percent >= 90 ? 'bg-red-500' : resourceData.system.disk_percent >= 70 ? 'bg-amber-500' : 'bg-purple-500'}
            />
            <SystemMetricCard
              icon={<Server className='h-4 w-4 text-orange-500' />}
              label={t('settings.service.resources.allocated')}
              value={`${(resourceData.total_allocated_memory_mb / 1024).toFixed(1)}G`}
              valueClassName={resourceData.overcommit_warning ? 'text-amber-600 dark:text-amber-400' : undefined}
              detail={`${t('settings.service.resources.physical')}: ${(resourceData.physical_memory_mb / 1024).toFixed(1)}G`}
              percent={(resourceData.total_allocated_memory_mb / Math.max(resourceData.physical_memory_mb, 1)) * 100}
              barColor={resourceData.overcommit_warning ? 'bg-amber-500' : 'bg-orange-500'}
            />
          </div>

          {/* Container Table */}
          <div className='border border-zinc-200 dark:border-zinc-800 overflow-hidden'>
            <div className='overflow-x-auto'>
              <table className='w-full text-sm'>
                <thead>
                  <tr className='bg-zinc-50 dark:bg-zinc-900 border-b border-zinc-200 dark:border-zinc-800'>
                    <th className='text-left px-3 py-2 font-medium text-zinc-600 dark:text-zinc-400'>
                      {t('settings.service.resources.container')}
                    </th>
                    <th className='text-center px-3 py-2 font-medium text-zinc-600 dark:text-zinc-400'>
                      {t('settings.service.resources.status')}
                    </th>
                    <th className='text-right px-3 py-2 font-medium text-zinc-600 dark:text-zinc-400'>
                      {t('settings.service.resources.cpuUsage')}
                    </th>
                    {!isMobileOrTabletPortrait && (
                      <th className='text-right px-3 py-2 font-medium text-zinc-600 dark:text-zinc-400'>
                        {t('settings.service.resources.memoryUsage')}
                      </th>
                    )}
                    <th className='text-right px-3 py-2 font-medium text-zinc-600 dark:text-zinc-400'>
                      {t('settings.service.resources.memoryLimit')}
                    </th>
                    {!isMobileOrTabletPortrait && (
                      <th className='text-right px-3 py-2 font-medium text-zinc-600 dark:text-zinc-400'>
                        {t('settings.service.resources.pids')}
                      </th>
                    )}
                  </tr>
                </thead>
                <tbody>
                  {sortContainers(resourceData.containers).map((container: ContainerResourceStats) => (
                    <ContainerRow
                      key={container.name}
                      container={container}
                      isMobile={isMobileOrTabletPortrait}
                      t={t}
                      onLimitUpdated={onRefresh}
                      isSelected={selectedContainer === container.name}
                      onSelect={onSelectContainer}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      ) : (
        <div className='text-center py-6 text-zinc-500 dark:text-zinc-400 text-sm'>
          {t('settings.service.resources.noData')}
        </div>
      )}
    </div>
  );
};

// Sub-components

function SystemMetricCard({
  icon,
  label,
  value,
  valueClassName,
  detail,
  percent,
  barColor,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  valueClassName?: string;
  detail: string;
  percent: number;
  barColor: string;
}) {
  return (
    <div className='p-3 bg-zinc-50 dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800'>
      <div className='flex items-center gap-2 mb-2'>
        {icon}
        <span className='text-xs font-medium text-zinc-600 dark:text-zinc-400'>{label}</span>
      </div>
      <div className={`text-lg font-bold ${valueClassName || 'text-zinc-900 dark:text-white'}`}>
        {value}
      </div>
      <div className='text-xs text-zinc-500 dark:text-zinc-400'>{detail}</div>
      <div className='mt-2 h-1.5 bg-zinc-200 dark:bg-zinc-700 overflow-hidden'>
        <div
          className={`h-full transition-all ${barColor}`}
          style={{ width: `${Math.min(percent, 100)}%` }}
        />
      </div>
    </div>
  );
}

function ContainerRow({
  container,
  isMobile,
  t,
  onLimitUpdated,
  isSelected,
  onSelect,
}: {
  container: ContainerResourceStats;
  isMobile: boolean;
  t: (key: string) => string;
  onLimitUpdated: () => void;
  isSelected?: boolean;
  onSelect?: (name: string | null) => void;
}) {
  const [isEditing, setIsEditing] = useState(false);
  const [editValue, setEditValue] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState<{ text: string; isError: boolean } | null>(null);

  const isRunning = container.state === 'RUNNING';
  const cpuColor = container.cpu_percent >= 90 ? 'text-red-600 dark:text-red-400' : container.cpu_percent >= 70 ? 'text-amber-600 dark:text-amber-400' : 'text-zinc-900 dark:text-white';
  const memColor = container.memory_percent >= 95 ? 'text-red-600 dark:text-red-400' : container.memory_percent >= 80 ? 'text-amber-600 dark:text-amber-400' : 'text-zinc-900 dark:text-white';
  const memBarColor = container.memory_percent >= 95 ? 'bg-red-500' : container.memory_percent >= 80 ? 'bg-amber-500' : 'bg-blue-500';

  const formatLimit = (mb: number) => {
    if (mb <= 0) return t('settings.service.resources.unlimited');
    return mb >= 1024 ? `${(mb / 1024).toFixed(1)}G` : `${mb}M`;
  };

  const startEditing = () => {
    setEditValue(String(container.memory_limit_mb));
    setIsEditing(true);
    setSaveMessage(null);
  };

  const cancelEditing = () => {
    setIsEditing(false);
    setSaveMessage(null);
  };

  const saveLimit = async () => {
    const newMb = parseInt(editValue, 10);
    if (isNaN(newMb) || newMb < 64) {
      setSaveMessage({ text: 'Min 64 MB', isError: true });
      return;
    }
    if (newMb === container.memory_limit_mb) {
      setIsEditing(false);
      return;
    }

    setIsSaving(true);
    setSaveMessage(null);
    try {
      const result = await updateContainerLimits(container.name, {
        memory_limit_mb: newMb,
      });
      if (result.success) {
        setSaveMessage({ text: result.message, isError: false });
        setIsEditing(false);
        onLimitUpdated();
      } else {
        setSaveMessage({ text: result.message, isError: true });
      }
    } catch {
      setSaveMessage({ text: 'Failed', isError: true });
    } finally {
      setIsSaving(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') void saveLimit();
    if (e.key === 'Escape') cancelEditing();
  };

  // Toggle selection — clicking the active row clears it. Editing controls
  // (memory-limit input, save/cancel buttons) call stopPropagation so they
  // don't bubble up here.
  const handleRowClick = () => {
    if (!onSelect) return;
    onSelect(isSelected ? null : container.name);
  };

  const rowClassName = [
    'border-b border-zinc-100 dark:border-zinc-800/50',
    onSelect ? 'cursor-pointer' : '',
    isSelected
      ? 'bg-blue-50 dark:bg-blue-950/30 hover:bg-blue-100 dark:hover:bg-blue-950/50'
      : 'hover:bg-zinc-50 dark:hover:bg-zinc-900/50',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <tr className={rowClassName} onClick={handleRowClick}>
      <td className='px-3 py-2'>
        <div className='flex items-center gap-2'>
          <div className={`w-2 h-2 flex-shrink-0 rounded-full ${isRunning ? 'bg-green-500' : 'bg-red-500'}`} />
          <span className='font-medium text-zinc-900 dark:text-white text-xs'>
            {container.name}
          </span>
        </div>
      </td>
      <td className='text-center px-3 py-2'>
        <span className={`text-xs px-1.5 py-0.5 ${isRunning ? 'bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400' : 'bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-400'}`}>
          {isRunning ? t('settings.service.resources.running') : t('settings.service.resources.stopped')}
        </span>
      </td>
      <td className={`text-right px-3 py-2 font-mono text-xs ${cpuColor}`}>
        {container.cpu_percent.toFixed(1)}%
        {typeof container.cpu_limit === 'number' && (
          <span className='text-zinc-400 dark:text-zinc-600 ml-1'>
            /{container.cpu_limit.toFixed(0)}c
          </span>
        )}
      </td>
      {!isMobile && (
        <td className='text-right px-3 py-2'>
          <div className='flex items-center justify-end gap-2'>
            <div className='w-16 h-1.5 bg-zinc-200 dark:bg-zinc-700 overflow-hidden'>
              <div className={`h-full ${memBarColor}`} style={{ width: `${Math.min(container.memory_percent, 100)}%` }} />
            </div>
            <span className={`font-mono text-xs ${memColor}`}>
              {container.memory_percent.toFixed(0)}%
            </span>
          </div>
        </td>
      )}
      <td className='text-right px-3 py-2' onClick={(e) => e.stopPropagation()}>
        {isEditing ? (
          <div className='flex items-center justify-end gap-1'>
            <Input
              type='number'
              value={editValue}
              onChange={(e) => setEditValue(e.target.value)}
              onKeyDown={handleKeyDown}
              className='h-6 w-20 text-xs font-mono px-1 text-right'
              min={64}
              max={16384}
              autoFocus
            />
            <span className='text-xs text-zinc-400'>MB</span>
            <Button
              onClick={saveLimit}
              variant='ghost'
              size='sm'
              disabled={isSaving}
              className='h-6 w-6 p-0'
            >
              {isSaving ? <Loader2 className='h-3 w-3 animate-spin' /> : <Check className='h-3 w-3 text-green-500' />}
            </Button>
            <Button onClick={cancelEditing} variant='ghost' size='sm' className='h-6 w-6 p-0'>
              <X className='h-3 w-3 text-zinc-400' />
            </Button>
          </div>
        ) : (
          <div className='flex items-center justify-end gap-1 group'>
            <span className='font-mono text-xs text-zinc-600 dark:text-zinc-400'>
              {formatLimit(container.memory_limit_mb)}
            </span>
            {container.memory_limit_mb > 0 && (
              <button
                onClick={startEditing}
                className='opacity-0 group-hover:opacity-100 transition-opacity p-0.5 hover:bg-zinc-200 dark:hover:bg-zinc-700'
                title='Edit memory limit'
              >
                <Pencil className='h-3 w-3 text-zinc-400' />
              </button>
            )}
          </div>
        )}
        {saveMessage && (
          <div className={`text-[10px] mt-0.5 ${saveMessage.isError ? 'text-red-500' : 'text-green-500'}`}>
            {saveMessage.text}
          </div>
        )}
      </td>
      {!isMobile && (
        <td className='text-right px-3 py-2 font-mono text-xs text-zinc-500 dark:text-zinc-400'>
          {container.pids}
        </td>
      )}
    </tr>
  );
}

export default SettingsResourceMonitor;
