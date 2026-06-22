// Type declarations for local components
declare module './gpu-deploy-section' {
  import { FC } from 'react';

  export interface GpuDeploySectionProps {
    activeModel: string | null | undefined;
    isLoading: boolean;
    isCheckingStatus: boolean;
    gpuStatus: {
      is_running: boolean;
      current_model?: string;
      gpu_memory_used?: number;
      gpu_utilization?: number;
      error?: string;
    } | null;
    startModelOnGPU: (modelId: string) => Promise<void>;
    checkGpuStatus: () => Promise<void>;
  }

  export const GpuDeploySection: FC<GpuDeploySectionProps>;
}

declare module './gpu-hardware-info-section' {
  import { FC } from 'react';
  import { SystemCapabilities } from '@/lib/api-llm-inference';
  import { TFunction } from 'i18next';

  export interface GpuHardwareInfoSectionProps {
    systemCapabilities: SystemCapabilities;
    t: TFunction;
    gpuStatus?: {
      is_running: boolean;
      current_model?: string;
      gpu_memory_used?: number;
      gpu_utilization?: number;
      error?: string;
    } | null;
  }

  export const GpuHardwareInfoSection: FC<GpuHardwareInfoSectionProps>;
}
