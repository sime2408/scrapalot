import React from 'react';
import {
  Activity,
  Database,
  Layers,
  Microchip,
  MonitorSmartphone,
} from 'lucide-react';
import { SystemCapabilities } from '@/types/llm-types';
import { TFunction } from 'i18next';

interface GpuHardwareInfoSectionProps {
  systemCapabilities: SystemCapabilities;
  t: TFunction;
  gpuStatus?: {
    is_running: boolean;
    current_model?: string;
    gpu_memory_used?: number;
    gpu_utilization?: number;
  } | null;
}

interface GpuHardwareCardProps {
  gpuInfo: { name: string; vram_gb?: number };
  index?: number;
  compact?: boolean;
}

// Simplified version of GpuHardwareCard for this component
const GpuHardwareCard: React.FC<GpuHardwareCardProps> = ({
  gpuInfo,
  index = 0,
  compact: _compact = false,
}) => {
  // Generate a gradient color based on the index
  const getGradientColor = (idx: number) => {
    const colors = [
      'from-blue-500 to-cyan-400', // Blue gradient
      'from-purple-500 to-pink-400', // Purple gradient
      'from-emerald-500 to-green-400', // Green gradient
      'from-amber-500 to-yellow-400', // Amber gradient
      'from-rose-500 to-red-400', // Red gradient
    ];
    return colors[idx % colors.length];
  };

  return (
    <div
      className={`rounded-lg overflow-hidden border border-zinc-200 dark:border-zinc-700 bg-gradient-to-br ${getGradientColor(
        index
      )} p-0.5`}
    >
      <div className='bg-white dark:bg-zinc-900 p-4 h-full'>
        <div className='flex items-start justify-between mb-3'>
          <div className='p-3 bg-zinc-100 dark:bg-zinc-800'>
            <Microchip className='h-6 w-6 text-zinc-800 dark:text-zinc-200' />
          </div>
          <div className='flex flex-col items-end'>
            {gpuInfo.vram_gb && (
              <span className='text-xs font-semibold bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-400 px-2 py-0.5 rounded-sm'>
                {gpuInfo.vram_gb} GB
              </span>
            )}
          </div>
        </div>

        <h4 className='text-base font-medium text-zinc-800 dark:text-white mb-1 line-clamp-1'>
          {gpuInfo.name || 'Unknown GPU'}
        </h4>
      </div>
    </div>
  );
};

export const GpuHardwareInfoSection: React.FC<GpuHardwareInfoSectionProps> = ({
  systemCapabilities,
  t,
  gpuStatus,
}) => {
  const isGpuActive = gpuStatus?.is_running || false;

  return (
    <div className='bg-zinc-100 dark:bg-zinc-900 p-4 rounded-lg border border-zinc-200 dark:border-zinc-800'>
      <div className='flex justify-between items-center mb-3'>
        <h4 className='text-sm font-medium text-zinc-600 dark:text-zinc-400'>
          {t('settings.localai.gpu.hardwareInfo', 'GPU Hardware')}
        </h4>
        <div className='flex items-center gap-2'>
          {!isGpuActive && (
            <div className='px-1.5 py-0.5 bg-zinc-200 dark:bg-zinc-800 rounded text-xs text-zinc-600 dark:text-zinc-400 flex items-center gap-1'>
              <span className='inline-block w-2 h-2 rounded-full bg-zinc-400 dark:bg-zinc-600'></span>
              Idle
            </div>
          )}
          {isGpuActive && (
            <div className='px-1.5 py-0.5 bg-green-100 dark:bg-green-900/30 rounded text-xs text-green-600 dark:text-green-400 flex items-center gap-1'>
              <span className='inline-block w-2 h-2 rounded-full bg-green-500 dark:bg-green-400 animate-pulse'></span>
              Active
            </div>
          )}
        </div>
      </div>

      {/* Full-width GPU Hardware Card */}
      <GpuHardwareCard gpuInfo={systemCapabilities.gpu_info} />

      {/* Hardware details summary */}
      <div className='mt-3 text-xs text-zinc-600 dark:text-zinc-400 grid grid-cols-2 md:grid-cols-4 gap-3'>
        <div className='p-2 bg-zinc-50 dark:bg-zinc-900 rounded border border-zinc-200 dark:border-zinc-800 flex items-center justify-between'>
          <span className='flex items-center gap-1'>
            <Database className='h-3 w-3' /> VRAM
          </span>
          <span className='font-medium'>
            {systemCapabilities.gpu_info.vram_gb} GB
          </span>
        </div>
        <div className='p-2 bg-zinc-50 dark:bg-zinc-900 rounded border border-zinc-200 dark:border-zinc-800 flex items-center justify-between'>
          <span className='flex items-center gap-1'>
            <Layers className='h-3 w-3' /> Parameters
          </span>
          <span className='font-medium'>
            ~{Math.round((systemCapabilities.gpu_info.vram_gb || 8) * 1.5)}B
          </span>
        </div>
        <div className='p-2 bg-zinc-50 dark:bg-zinc-900 rounded border border-zinc-200 dark:border-zinc-800 flex items-center justify-between'>
          <span className='flex items-center gap-1'>
            <Activity className='h-3 w-3' /> Status
          </span>
          <span
            className={`font-medium ${isGpuActive
              ? 'text-green-600 dark:text-green-400'
              : 'text-zinc-500 dark:text-zinc-400'
              }`}
          >
            {isGpuActive
              ? gpuStatus?.current_model
                ? t(
                  'settings.localai.gpu.statusRunningModel',
                  'Running: {{model}}',
                  { model: gpuStatus.current_model.split('-')[0] }
                )
                : t('settings.localai.gpu.statusRunning', 'Active')
              : t('settings.localai.gpu.statusIdle', 'Idle')}
          </span>
        </div>
        <div className='p-2 bg-zinc-50 dark:bg-zinc-900 rounded border border-zinc-200 dark:border-zinc-800 flex items-center justify-between'>
          <span className='flex items-center gap-1'>
            <MonitorSmartphone className='h-3 w-3' /> Architecture
          </span>
          <span className='font-medium'>
            {systemCapabilities.device_type}
          </span>
        </div>
      </div>
    </div>
  );
};
