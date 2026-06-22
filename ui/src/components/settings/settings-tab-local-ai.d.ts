declare module './gpu-deploy-section' {
  interface GpuDeploySectionProps {
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

  export const GpuDeploySection: React.FC<GpuDeploySectionProps>;
}

declare module './gpu-hardware-info-section' {
  import { SystemCapabilities } from '@/lib/api-llm-inference';
  import { TFunction } from 'i18next';

  interface GpuHardwareInfoSectionProps {
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

  export const GpuHardwareInfoSection: React.FC<GpuHardwareInfoSectionProps>;
}
