import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { copyToClipboard } from './settings-utils.ts';
import { Button } from '@/components/ui/button';
import { useIsMobile } from '@/hooks/use-mobile';
import { Switch } from '@/components/ui/switch';
import { Progress } from '@/components/ui/progress';
import { toast } from '@/lib/toast-compat';
import {
  Activity,
  AlertTriangle,
  CheckCircle,
  ChevronDown,
  Code,
  Copy,
  Cpu,
  Database,
  HardDrive,
  Laptop,
  Layers,
  Loader2,
  Microchip,
  RefreshCw,
  Server,
  Square,
  Zap,
} from 'lucide-react';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import {
  oneDark,
  oneLight,
} from 'react-syntax-highlighter/dist/esm/styles/prism';
import { useTheme } from '@/providers/theme-provider';
import {
  getFeaturedModels,
  getGpuStatus,
  getInstalledModels,
  getSystemCapabilities,
  startLocalService,
  deployLocalModel,
  stopLocalService,
  stopModelFromGpu,
  reinitializeLocalModels,
} from '@/lib/api-llm-inference';
import { getLocalServiceStatus } from '@/lib/api-local-ai';
import { LocalServiceStatus } from '@/types/llm-types.ts';
import { SystemCapabilities } from '@/types/llm-types';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import { GpuDeploySection } from './gpu-deploy-section';
import { GpuHardwareInfoSection } from './gpu-hardware-info-section';

// Strip background and textShadow from any syntax theme
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const makeTransparent = (base: Record<string, any>, extraPre?: Record<string, unknown>) => ({
  ...base,
  'pre[class*="language-"]': {
    ...base['pre[class*="language-"]'],
    background: 'transparent',
    textShadow: 'none',
    ...extraPre,
  },
  'code[class*="language-"]': {
    ...base['code[class*="language-"]'],
    background: 'transparent',
    textShadow: 'none',
  },
});

const customOneDark = makeTransparent(oneDark, { margin: 0, padding: 0 });
const customOneLight = makeTransparent(oneLight, { margin: 0, padding: 0 });

// Add these interface definitions for GPU status
interface GpuStatus {
  is_running: boolean;
  current_model?: string;
  gpu_memory_used?: number;
  gpu_utilization?: number;
  error?: string;
}

// Expand the props to include the active model
interface SettingsLocalAITabProps {
  showModels: boolean;
  setShowModels: (value: boolean) => void;
  modelsDirectory: string;
  setModelsDirectory: (value: string) => void;
  openLocalAIModelsDialog: () => void;
  maxParallelChats?: number;
  setMaxParallelChats?: (value: number) => void;
  useAdvancedConfig?: boolean;
  setUseAdvancedConfig?: (value: boolean) => void;
  advancedConfigJson?: string;
  setAdvancedConfigJson?: (value: string) => void;
  activeModel?: string | null;
  isActive?: boolean; // Add isActive prop to control lazy loading
}

// First, update the GpuHardwareCard component to add a compact mode with hover information
const GpuHardwareCard = ({
  gpuInfo,
  index = 0,
  compact = false,
}: {
  gpuInfo: { name: string; vram_gb?: number };
  index?: number;
  compact?: boolean;
}) => {
  const { t } = useTranslation();

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

  // Calculate estimated values based on VRAM
  const getEstimatedValues = () => {
    const vramGB = gpuInfo.vram_gb || 8;

    // Memory bandwidth calculation (GB/s) - estimated roughly from VRAM size
    // Higher-end cards with more VRAM typically have higher bandwidth
    const memoryBandwidth = Math.round((vramGB / 8) * 400 + 200);

    // Cores calculation - rough estimate based on VRAM
    // Most GPUs with 8GB have around 3000-5000 cores, scaling up with VRAM
    const estimatedCores = Math.round((vramGB / 8) * 3000 + 1000);

    // Compute power in TFLOPS (Tera Floating Point Operations Per Second)
    // Rough estimate based on VRAM and typical modern GPU capabilities
    const computeTflops = (vramGB / 8) * 12 + 4;

    return {
      memoryBandwidth: `${memoryBandwidth} GB/s`,
      cores: estimatedCores.toLocaleString(),
      compute: `${computeTflops.toFixed(1)} TFLOPS`,
      memorySize: `${vramGB} GB`,
    };
  };

  const values = getEstimatedValues();

  return (
    <div
      className={`rounded-lg overflow-hidden border border-zinc-200 dark:border-zinc-700 bg-gradient-to-br ${getGradientColor(
        index
      )} p-0.5 group relative ${compact ? 'hover:shadow-lg transition-shadow duration-300' : ''
        }`}
    >
      <div
        className={`bg-white dark:bg-zinc-900 p-3 ${compact ? 'p-2' : 'p-4'
          } h-full`}
      >
        <div
          className={`flex items-start justify-between ${compact ? 'mb-1' : 'mb-3'
            }`}
        >
          <div
            className={`${compact ? 'p-2' : 'p-3'
              } bg-zinc-100 dark:bg-zinc-800`}
          >
            <Microchip
              className={`${compact ? 'h-5 w-5' : 'h-6 w-6'
                } text-zinc-800 dark:text-zinc-200`}
            />
          </div>
          <div className='flex flex-col items-end'>
            {gpuInfo.vram_gb && (
              <span className='text-xs font-semibold bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-400 px-2 py-0.5 rounded-sm'>
                {gpuInfo.vram_gb} GB
              </span>
            )}
          </div>
        </div>

        <h4
          className={`${compact ? 'text-sm' : 'text-base'
            } font-medium text-zinc-800 dark:text-white mb-1 line-clamp-1`}
        >
          {gpuInfo.name || t('settings.localai.gpu.unknown', 'Unknown GPU')}
        </h4>

        {!compact ? (
          <div className='mt-3 grid grid-cols-2 gap-2 text-xs'>
            <div className='flex items-center gap-1.5'>
              <Database className='h-3.5 w-3.5 text-zinc-600 dark:text-zinc-400' />
              <div className='flex justify-between w-full'>
                <span className='text-zinc-600 dark:text-zinc-400'>
                  {t('settings.localai.gpu.memory', 'Memory')}
                </span>
                <span className='text-zinc-800 dark:text-zinc-300 font-medium'>
                  {values.memorySize}
                </span>
              </div>
            </div>
            <div className='flex items-center gap-1.5'>
              <Zap className='h-3.5 w-3.5 text-zinc-600 dark:text-zinc-400' />
              <div className='flex justify-between w-full'>
                <span className='text-zinc-600 dark:text-zinc-400'>
                  {t('settings.localai.gpu.compute', 'Compute')}
                </span>
                <span className='text-zinc-800 dark:text-zinc-300 font-medium'>
                  {values.compute}
                </span>
              </div>
            </div>
            <div className='flex items-center gap-1.5'>
              <Layers className='h-3.5 w-3.5 text-zinc-600 dark:text-zinc-400' />
              <div className='flex justify-between w-full'>
                <span className='text-zinc-600 dark:text-zinc-400'>
                  {t('settings.localai.gpu.cores', 'Cores')}
                </span>
                <span className='text-zinc-800 dark:text-zinc-300 font-medium'>
                  {values.cores}
                </span>
              </div>
            </div>
            <div className='flex items-center gap-1.5'>
              <HardDrive className='h-3.5 w-3.5 text-zinc-600 dark:text-zinc-400' />
              <div className='flex justify-between w-full'>
                <span className='text-zinc-600 dark:text-zinc-400'>
                  {t('settings.localai.gpu.bandwidth', 'Bandwidth')}
                </span>
                <span className='text-zinc-800 dark:text-zinc-300 font-medium'>
                  {values.memoryBandwidth}
                </span>
              </div>
            </div>
          </div>
        ) : (
          <div className='flex justify-between items-center text-xs mt-1'>
            <div className='flex items-center gap-1.5'>
              <Database className='h-3 w-3 text-zinc-600 dark:text-zinc-400' />
              <span className='text-zinc-600 dark:text-zinc-400'>
                {values.memorySize}
              </span>
            </div>
            <div className='flex items-center gap-1.5'>
              <Zap className='h-3 w-3 text-zinc-600 dark:text-zinc-400' />
              <span className='text-zinc-600 dark:text-zinc-400'>
                {values.compute}
              </span>
            </div>
          </div>
        )}

        {/* Hover details for compact mode */}
        {compact && (
          <div className='absolute inset-0 opacity-0 group-hover:opacity-100 bg-white dark:bg-zinc-900 dark:bg-opacity-95 bg-opacity-95 transition-opacity duration-200 p-3 z-10 shadow-xl'>
            <h4 className='text-sm font-medium text-zinc-800 dark:text-white mb-2'>
              {gpuInfo.name || t('settings.localai.gpu.unknown', 'Unknown GPU')}
            </h4>
            <div className='space-y-1.5 text-xs'>
              <div className='flex justify-between'>
                <span className='text-zinc-600 dark:text-zinc-400 flex items-center gap-1'>
                  <Database className='h-3 w-3 inline' />{' '}
                  {t('settings.localai.gpu.memory', 'Memory')}
                </span>
                <span className='font-medium text-zinc-800 dark:text-zinc-300'>
                  {values.memorySize}
                </span>
              </div>
              <div className='flex justify-between'>
                <span className='text-zinc-600 dark:text-zinc-400 flex items-center gap-1'>
                  <Zap className='h-3 w-3 inline' />{' '}
                  {t('settings.localai.gpu.compute', 'Compute')}
                </span>
                <span className='font-medium text-zinc-800 dark:text-zinc-300'>
                  {values.compute}
                </span>
              </div>
              <div className='flex justify-between'>
                <span className='text-zinc-600 dark:text-zinc-400 flex items-center gap-1'>
                  <Layers className='h-3 w-3 inline' />{' '}
                  {t('settings.localai.gpu.cores', 'Cores')}
                </span>
                <span className='font-medium text-zinc-800 dark:text-zinc-300'>
                  {values.cores}
                </span>
              </div>
              <div className='flex justify-between'>
                <span className='text-zinc-600 dark:text-zinc-400 flex items-center gap-1'>
                  <HardDrive className='h-3 w-3 inline' />{' '}
                  {t('settings.localai.gpu.bandwidth', 'Bandwidth')}
                </span>
                <span className='font-medium text-zinc-800 dark:text-zinc-300'>
                  {values.memoryBandwidth}
                </span>
              </div>
              <div className='mt-2 pt-1 border-t border-zinc-200 dark:border-zinc-700 text-center'>
                <span className='text-blue-600 dark:text-blue-400 text-[10px]'>
                  {t(
                    'settings.localai.gpu.hoverHint',
                    'Model compatibility: Up to ~{{size}}B parameters',
                    {
                      size: Math.round((gpuInfo.vram_gb || 8) * 1.2),
                    }
                  )}
                </span>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export const SettingsLocalAITab: React.FC<SettingsLocalAITabProps> = ({
  showModels,
  setShowModels,
  modelsDirectory: _modelsDirectory,
  setModelsDirectory: _setModelsDirectory,
  openLocalAIModelsDialog,
  maxParallelChats,
  setMaxParallelChats,
  useAdvancedConfig,
  setUseAdvancedConfig,
  advancedConfigJson,
  setAdvancedConfigJson,
  activeModel,
  isActive = false, // Default to false for lazy loading
}) => {
  const { t } = useTranslation();
  const { theme } = useTheme();
  const isMobile = useIsMobile();
  const [syntaxError, setSyntaxError] = useState<string | null>(null);
  const [internalActiveModel, setInternalActiveModel] = useState<string | null>(
    activeModel // Initialize with the prop value directly
  );
  const [isModelMovingToGpu, setIsModelMovingToGpu] = useState(false);
  const [isJsonFormatted, setIsJsonFormatted] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animationRef = useRef<number | null>(null);
  interface AnimationParticle {
    x: number;
    y: number;
    size: number;
    speed: number;
    color: string;
    opacity: number;
  }
  interface AnimationState {
    progress: number;
    particles: AnimationParticle[];
    modelPosition: { x: number; y: number; scale: number; rotation: number; opacity: number };
  }
  const animationStateRef = useRef<AnimationState | null>(null);
  const [gpuLogsExpanded, setGpuLogsExpanded] = useState(true); // Default to expanded to match existing UI
  const [isFetchingActiveModel, setIsFetchingActiveModel] = useState(false); // Track state of active model fetch
  const [isServiceRunning, setIsServiceRunning] = useState(false); // Track the state of the local service
  const [isServiceActionInProgress, setIsServiceActionInProgress] =
    useState(false); // Track service start/stop actions
  const [isScanningModels, setIsScanningModels] = useState(false); // Track model scanning state

  // Debug logs to help track the active model
  // Default JSON configuration
  const defaultConfig = `{
  "llama": {
    "context_size": 8192,
    "gpu_layers": 50,
    "batch_size": 512,
    "use_mlock": true,
    "use_mmap": true
  }
}`;

  // Handle JSON changes with validation
  const handleJsonChange = (value: string) => {
    try {
      // Validate JSON by parsing it
      if (value.trim()) {
        JSON.parse(value);
      }
      setSyntaxError(null);
      setAdvancedConfigJson?.(value);
      // JSON is valid but not necessarily formatted
      setIsJsonFormatted(false);
    } catch (error) {
      setSyntaxError((error as Error).message);
      // Still update the value even with errors so user can correct them
      setAdvancedConfigJson?.(value);
      setIsJsonFormatted(false);
    }
  };

  // Format the JSON for better display
  const formatJson = () => {
    try {
      const formattedJson = JSON.stringify(
        JSON.parse(advancedConfigJson || defaultConfig),
        null,
        2
      );
      setAdvancedConfigJson?.(formattedJson);
      setSyntaxError(null);
      setIsJsonFormatted(true);
    } catch (error) {
      setSyntaxError((error as Error).message);
      setIsJsonFormatted(false);
      toast(
        t(
          'settings.localai.advanced.formatError',
          'Cannot format invalid JSON'
        ),
        {
          description: (error as Error).message,
        }
      );
    }
  };

  // Improved function to fetch active model with better error handling
  const fetchActiveModel = async (_bypassCache = true) => {
    if (isFetchingActiveModel) return;

    setIsFetchingActiveModel(true);

    try {
      if (activeModel) {
        // If the API returns null but we have a prop, use that

        setInternalActiveModel(activeModel);
        localStorage.setItem('user-active-model', activeModel);
      } else {
        // Check localStorage as last resort
        const storedModel = localStorage.getItem('user-active-model');
        if (storedModel) {

          setInternalActiveModel(storedModel);
        } else {
          // No stored model found; default will be used
        }
      }
    } catch (error) {
      console.error('Error fetching active model:', error);

      // On error, try localStorage
      const storedModel = localStorage.getItem('user-active-model');
      if (storedModel) {
        setInternalActiveModel(storedModel);
      }
    } finally {
      setIsFetchingActiveModel(false);
    }
  };

  // Call fetchActiveModel when component mounts or activeModel prop changes
  useEffect(() => {
    void fetchActiveModel();
  // eslint-disable-next-line react-hooks/exhaustive-deps -- deps are intentionally limited
  }, [activeModel]);

  // Sync with prop changes - this ensures that any time the parent updates the prop, we update our internal state
  useEffect(() => {

    if (
      activeModel !== null &&
      activeModel !== undefined &&
      activeModel !== internalActiveModel
    ) {
      setInternalActiveModel(activeModel);
      localStorage.setItem('user-active-model', activeModel);
    }
  }, [activeModel, internalActiveModel]);

  // Animation functions for the GPU model loading visualization
  const drawModelToGPUAnimation = () => {
    if (!canvasRef.current || !isModelMovingToGpu) return;

    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Clear canvas
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Set up animation state if not exists
    if (!animationStateRef.current) {
      animationStateRef.current = {
        progress: 0,
        particles: Array(35) // Increased number of particles
          .fill(0)
          .map(() => {
            // Generate colors across a blue spectrum
            const hue = 210 + Math.random() * 60; // 210-270 range (blues to purples)
            const saturation = 90 + Math.random() * 10; // 90-100%
            const lightness = 50 + Math.random() * 15; // 50-65%

            return {
              x: Math.random() * canvas.width * 0.4 + canvas.width * 0.1,
              y: Math.random() * canvas.height * 0.4 + canvas.height * 0.3,
              size: Math.random() * 7 + 2, // Slightly adjusted size range
              speed: Math.random() * 3 + 1.5, // Slightly slower minimum speed
              color: `hsl(${hue}, ${saturation}%, ${lightness}%)`,
              opacity: 0.4 + Math.random() * 0.6, // Higher minimum opacity
            };
          }),
        modelPosition: {
          x: 80,
          y: canvas.height / 2,
          scale: 1,
          rotation: 0,
          opacity: 1,
        },
      };
    }

    // Update animation state
    animationStateRef.current.progress += 1;
    const progress = Math.min(100, animationStateRef.current.progress / 2);

    // Update model position for animation
    if (progress < 100) {
      animationStateRef.current.modelPosition.x =
        80 + (canvas.width - 250 - 80) * (progress / 100);

      // Add slight floating movement
      animationStateRef.current.modelPosition.y =
        canvas.height / 2 +
        Math.sin(animationStateRef.current.progress / 10) * 5;

      // Rotate slightly
      animationStateRef.current.modelPosition.rotation =
        Math.sin(animationStateRef.current.progress / 15) * 0.05;
    }

    // Draw CPU (left side)
    const drawCPU = () => {
      ctx.save();

      // Create a metallic gradient for CPU
      const cpuGradient = ctx.createLinearGradient(
        20,
        canvas.height / 2 - 50,
        140,
        canvas.height / 2 + 50
      );

      if (theme === 'dark') {
        cpuGradient.addColorStop(0, '#1f2937');
        cpuGradient.addColorStop(0.5, '#374151');
        cpuGradient.addColorStop(1, '#1f2937');
      } else {
        cpuGradient.addColorStop(0, '#e5e7eb');
        cpuGradient.addColorStop(0.5, '#f3f4f6');
        cpuGradient.addColorStop(1, '#d1d5db');
      }

      // Add subtle shadow
      ctx.shadowColor = 'rgba(0, 0, 0, 0.3)';
      ctx.shadowBlur = 8;
      ctx.shadowOffsetX = 2;
      ctx.shadowOffsetY = 2;

      // CPU outer case with rounded corners
      ctx.fillStyle = cpuGradient;
      roundRect(ctx, 20, canvas.height / 2 - 50, 120, 100, 10);

      // Reset shadow for inner elements
      ctx.shadowColor = 'transparent';
      ctx.shadowBlur = 0;

      // CPU inner details with inset effect
      ctx.fillStyle = theme === 'dark' ? '#111827' : '#e5e7eb';
      roundRect(ctx, 30, canvas.height / 2 - 40, 100, 80, 5);

      // Add a subtle "inset" shading using a gradient
      const innerGradient = ctx.createLinearGradient(
        30,
        canvas.height / 2 - 40,
        130,
        canvas.height / 2 + 40
      );

      if (theme === 'dark') {
        innerGradient.addColorStop(0, 'rgba(0, 0, 0, 0.2)');
        innerGradient.addColorStop(0.5, 'rgba(0, 0, 0, 0)');
        innerGradient.addColorStop(1, 'rgba(255, 255, 255, 0.05)');
      } else {
        innerGradient.addColorStop(0, 'rgba(255, 255, 255, 0.7)');
        innerGradient.addColorStop(0.5, 'rgba(255, 255, 255, 0)');
        innerGradient.addColorStop(1, 'rgba(0, 0, 0, 0.05)');
      }

      ctx.fillStyle = innerGradient;
      roundRect(ctx, 30, canvas.height / 2 - 40, 100, 80, 5);

      // CPU circuits with improved pattern
      ctx.strokeStyle = theme === 'dark' ? '#4b5563' : '#9ca3af';
      ctx.lineWidth = 1;

      // Horizontal circuit lines — shared neural network pattern (see also drawModel)
      drawNeuralNetworkPattern();

      ctx.restore();
    };

    // Draws a small neural network icon (input/hidden/output layers with connections).
    // Used by both drawCPU and drawModel to avoid code duplication.
    const drawNeuralNetworkPattern = () => {
      // Input layer (left)
      for (let i = 0; i < 4; i++) {
        ctx.beginPath();
        ctx.arc(-20, -15 + i * 10, 2, 0, Math.PI * 2);
        ctx.fillStyle = '#d1fae5';
        ctx.fill();
      }

      // Hidden layer (middle)
      for (let i = 0; i < 5; i++) {
        ctx.beginPath();
        ctx.arc(0, -20 + i * 10, 2, 0, Math.PI * 2);
        ctx.fillStyle = '#d1fae5';
        ctx.fill();
      }

      // Output layer (right)
      for (let i = 0; i < 4; i++) {
        ctx.beginPath();
        ctx.arc(20, -15 + i * 10, 2, 0, Math.PI * 2);
        ctx.fillStyle = '#d1fae5';
        ctx.fill();
      }

      // Connect the nodes with semi-transparent lines
      ctx.strokeStyle = 'rgba(209, 250, 229, 0.4)';
      ctx.lineWidth = 0.5;

      // Connect input to hidden layer
      for (let i = 0; i < 4; i++) {
        for (let j = 0; j < 5; j++) {
          ctx.beginPath();
          ctx.moveTo(-20, -15 + i * 10);
          ctx.lineTo(0, -20 + j * 10);
          ctx.stroke();
        }
      }

      // Connect hidden to output layer
      for (let i = 0; i < 5; i++) {
        for (let j = 0; j < 4; j++) {
          ctx.beginPath();
          ctx.moveTo(0, -20 + i * 10);
          ctx.lineTo(20, -15 + j * 10);
          ctx.stroke();
        }
      }

      // Add AI text with glowing effect
      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold 12px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.shadowColor = 'rgba(255, 255, 255, 0.7)';
      ctx.shadowBlur = 4;
      ctx.fillText('AI MODEL', 0, 0);
    };

    // Draw GPU (right side)
    const drawGPU = () => {
      ctx.save();

      // Create a blue metallic gradient for GPU
      const gpuGradient = ctx.createLinearGradient(
        canvas.width - 140,
        canvas.height / 2 - 60,
        canvas.width - 20,
        canvas.height / 2 + 60
      );

      gpuGradient.addColorStop(0, '#1e40af'); // Darker blue
      gpuGradient.addColorStop(0.5, '#3b82f6'); // Medium blue
      gpuGradient.addColorStop(1, '#1d4ed8'); // Slightly dark blue

      // Add subtle shadow
      ctx.shadowColor = 'rgba(0, 0, 0, 0.5)';
      ctx.shadowBlur = 10;
      ctx.shadowOffsetX = -2;
      ctx.shadowOffsetY = 2;

      // GPU outer case with rounded corners
      ctx.fillStyle = gpuGradient;
      roundRect(ctx, canvas.width - 140, canvas.height / 2 - 60, 120, 120, 10);

      // Reset shadow for inner elements
      ctx.shadowColor = 'transparent';
      ctx.shadowBlur = 0;

      // GPU inner details with inset effect
      ctx.fillStyle = '#1e3a8a'; // Darker blue
      roundRect(ctx, canvas.width - 130, canvas.height / 2 - 50, 100, 100, 5);

      // Add a subtle metal sheen
      const innerGradient = ctx.createLinearGradient(
        canvas.width - 130,
        canvas.height / 2 - 50,
        canvas.width - 30,
        canvas.height / 2 + 50
      );

      innerGradient.addColorStop(0, 'rgba(255, 255, 255, 0.1)');
      innerGradient.addColorStop(0.5, 'rgba(255, 255, 255, 0)');
      innerGradient.addColorStop(1, 'rgba(255, 255, 255, 0.15)');

      ctx.fillStyle = innerGradient;
      roundRect(ctx, canvas.width - 130, canvas.height / 2 - 50, 100, 100, 5);

      // GPU circuits - more dense than CPU with brighter color
      ctx.strokeStyle = '#93c5fd'; // Light blue
      ctx.lineWidth = 0.5;

      // Dense grid pattern
      ctx.beginPath();
      for (let i = 0; i < 10; i++) {
        const y = canvas.height / 2 - 45 + i * 10;
        ctx.moveTo(canvas.width - 125, y);
        ctx.lineTo(canvas.width - 35, y);
      }
      for (let i = 0; i < 10; i++) {
        const x = canvas.width - 125 + i * 10;
        ctx.moveTo(x, canvas.height / 2 - 45);
        ctx.lineTo(x, canvas.height / 2 + 45);
      }
      ctx.stroke();

      // GPU processing cores with glowing effect
      const coreGlow = ctx.createRadialGradient(
        canvas.width - 80,
        canvas.height / 2,
        0,
        canvas.width - 80,
        canvas.height / 2,
        50
      );
      coreGlow.addColorStop(0, 'rgba(96, 165, 250, 0.2)');
      coreGlow.addColorStop(1, 'rgba(59, 130, 246, 0)');

      ctx.fillStyle = coreGlow;
      ctx.beginPath();
      ctx.arc(canvas.width - 80, canvas.height / 2, 40, 0, Math.PI * 2);
      ctx.fill();

      // GPU cores with animated pulsing
      for (let i = 0; i < 3; i++) {
        for (let j = 0; j < 3; j++) {
          // Pulse effect for cores
          const pulseScale = 0.8 + Math.sin(Date.now() * 0.002 + i * j) * 0.2;
          const coreSize = 25 * pulseScale;

          // Core gradient
          const coreGradient = ctx.createLinearGradient(
            canvas.width - 120 + i * 30,
            canvas.height / 2 - 40 + j * 30,
            canvas.width - 120 + i * 30 + coreSize,
            canvas.height / 2 - 40 + j * 30 + coreSize
          );

          coreGradient.addColorStop(0, '#60a5fa'); // Lighter blue
          coreGradient.addColorStop(1, '#3b82f6'); // Standard blue

          ctx.fillStyle = coreGradient;
          roundRect(
            ctx,
            canvas.width - 120 + i * 30,
            canvas.height / 2 - 40 + j * 30,
            coreSize,
            coreSize,
            4
          );

          // Add bright dots to simulate processing
          if (Math.random() > 0.7) {
            ctx.fillStyle = '#dbeafe'; // Very light blue
            ctx.beginPath();
            ctx.arc(
              canvas.width - 120 + i * 30 + coreSize / 2,
              canvas.height / 2 - 40 + j * 30 + coreSize / 2,
              2,
              0,
              Math.PI * 2
            );
            ctx.fill();
          }
        }
      }

      // GPU label with better styling
      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold 14px sans-serif';
      ctx.textAlign = 'center';
      ctx.shadowColor = 'rgba(0, 0, 0, 0.5)';
      ctx.shadowBlur = 3;
      ctx.fillText('GPU', canvas.width - 80, canvas.height / 2 + 75);

      ctx.restore();
    };

    // Draw model (moving from CPU to GPU)
    const drawModel = () => {
      const { x, y, scale, rotation, opacity } = animationStateRef.current
        .modelPosition;

      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(rotation);
      ctx.scale(scale, scale);
      ctx.globalAlpha = opacity;

      // Create glowing effect behind the model
      const glowRadius = 40;
      const glow = ctx.createRadialGradient(0, 0, 5, 0, 0, glowRadius);
      glow.addColorStop(0, 'rgba(16, 185, 129, 0.7)'); // Green glow
      glow.addColorStop(1, 'rgba(16, 185, 129, 0)');

      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(0, 0, glowRadius, 0, Math.PI * 2);
      ctx.fill();

      // Create metallic gradient for model container
      const modelGradient = ctx.createLinearGradient(-30, -30, 30, 30);
      modelGradient.addColorStop(0, '#0d9668'); // Darker green
      modelGradient.addColorStop(0.5, '#10b981'); // Middle green
      modelGradient.addColorStop(1, '#34d399'); // Lighter green

      // Model container with rounded corners
      ctx.fillStyle = modelGradient;
      roundRect(ctx, -32, -32, 64, 64, 8);

      // Add a subtle shadow
      ctx.shadowColor = 'rgba(0, 0, 0, 0.3)';
      ctx.shadowBlur = 10;
      ctx.shadowOffsetX = 2;
      ctx.shadowOffsetY = 2;

      // Model details - modernized circuit pattern
      ctx.strokeStyle = '#d1fae5';
      ctx.lineWidth = 1.5;

      // Reset shadow for lines
      ctx.shadowColor = 'transparent';

      // Create neural network pattern — shared helper (see also drawCPU)
      drawNeuralNetworkPattern();

      ctx.restore();
    };

    // Draw connection path
    const drawConnectionPath = () => {
      ctx.save();

      // Create gradient for the path with improved colors
      const gradient = ctx.createLinearGradient(
        140,
        canvas.height / 2,
        canvas.width - 140,
        canvas.height / 2
      );

      if (theme === 'dark') {
        gradient.addColorStop(0, '#4b5563'); // Dark gray
        gradient.addColorStop(0.3, '#6b7280'); // Medium gray
        gradient.addColorStop(0.7, '#2563eb'); // Blue
        gradient.addColorStop(1, '#3b82f6'); // Lighter blue
      } else {
        gradient.addColorStop(0, '#9ca3af'); // Light gray
        gradient.addColorStop(0.3, '#6b7280'); // Medium gray
        gradient.addColorStop(0.7, '#3b82f6'); // Blue
        gradient.addColorStop(1, '#60a5fa'); // Lighter blue
      }

      // Draw a glow under the path
      ctx.shadowColor =
        theme === 'dark'
          ? 'rgba(59, 130, 246, 0.4)'
          : 'rgba(59, 130, 246, 0.3)';
      ctx.shadowBlur = 10;
      ctx.shadowOffsetY = 2;

      // Main path with improved dash pattern
      ctx.strokeStyle = gradient;
      ctx.lineWidth = 3;
      ctx.setLineDash([8, 4]);
      ctx.beginPath();
      ctx.moveTo(140, canvas.height / 2);
      ctx.lineTo(canvas.width - 140, canvas.height / 2);
      ctx.stroke();

      // Reset shadow for highlight path
      ctx.shadowColor = 'transparent';
      ctx.shadowBlur = 0;

      // Highlight path based on progress with glow effect
      if (progress > 0) {
        // Create animated gradient for the progress path
        const progressGradient = ctx.createLinearGradient(
          140,
          canvas.height / 2,
          140 + (canvas.width - 280) * (progress / 100),
          canvas.height / 2
        );

        progressGradient.addColorStop(0, '#3b82f6'); // Standard blue
        progressGradient.addColorStop(0.5, '#60a5fa'); // Lighter blue
        progressGradient.addColorStop(1, '#93c5fd'); // Very light blue

        ctx.strokeStyle = progressGradient;
        ctx.lineWidth = 5;
        ctx.setLineDash([]);
        ctx.beginPath();
        ctx.moveTo(140, canvas.height / 2);
        ctx.lineTo(
          140 + (canvas.width - 280) * (progress / 100),
          canvas.height / 2
        );
        ctx.stroke();

        // Add glow around the progress path
        ctx.strokeStyle = 'rgba(59, 130, 246, 0.3)';
        ctx.lineWidth = 8;
        ctx.beginPath();
        ctx.moveTo(140, canvas.height / 2);
        ctx.lineTo(
          140 + (canvas.width - 280) * (progress / 100),
          canvas.height / 2
        );
        ctx.stroke();

        // Add a "head" to the progress line
        const headX = 140 + (canvas.width - 280) * (progress / 100);
        const headY = canvas.height / 2;

        // Create glowing pulse at the head
        const headGlow = ctx.createRadialGradient(
          headX,
          headY,
          0,
          headX,
          headY,
          12
        );
        headGlow.addColorStop(0, 'rgba(147, 197, 253, 0.9)');
        headGlow.addColorStop(0.6, 'rgba(96, 165, 250, 0.6)');
        headGlow.addColorStop(1, 'rgba(59, 130, 246, 0)');

        // Animate the pulse
        const pulseScale = 0.8 + Math.sin(Date.now() * 0.008) * 0.2;

        ctx.fillStyle = headGlow;
        ctx.beginPath();
        ctx.arc(headX, headY, 8 * pulseScale, 0, Math.PI * 2);
        ctx.fill();

        // Add a bright core
        ctx.fillStyle = '#ffffff';
        ctx.beginPath();
        ctx.arc(headX, headY, 3, 0, Math.PI * 2);
        ctx.fill();
      }

      ctx.restore();
    };

    // Draw particles moving from CPU to GPU
    const drawParticles = () => {
      ctx.save();

      animationStateRef.current.particles.forEach((particle, index) => {
        // Move particle from left to right
        particle.x += particle.speed;

        // Reset particle if it reaches GPU
        if (particle.x > canvas.width - 140) {
          particle.x = 140 + Math.random() * 50;
          particle.y = Math.random() * 40 + canvas.height / 2 - 20;
          particle.opacity = 0.1 + Math.random() * 0.7;
          // Randomize particle colors for next animation cycle
          particle.color = `hsl(${210 + Math.random() * 60}, ${90 + Math.random() * 10
            }%, ${50 + Math.random() * 10}%)`;
        }

        // Make particles follow a more dynamic wavy path
        const baseY = canvas.height / 2;
        const waveHeight = 18;
        const waveOffset =
          ((particle.x - 140) / (canvas.width - 280)) * Math.PI * 6;
        particle.y =
          baseY +
          Math.sin(waveOffset + index * 0.3) *
          waveHeight *
          (0.5 + Math.random() * 0.5);

        // Adjust particle size based on position (scale up as it gets closer to GPU)
        const sizeFactor =
          1 + ((particle.x - 140) / (canvas.width - 280)) * 0.5;
        const currentSize = particle.size * sizeFactor;

        // Create a more complex gradient for each particle
        const innerGlow = ctx.createRadialGradient(
          particle.x,
          particle.y,
          0,
          particle.x,
          particle.y,
          currentSize
        );

        // More vibrant color transitions
        innerGlow.addColorStop(0, particle.color);
        innerGlow.addColorStop(
          0.6,
          particle.color.replace('hsl', 'hsla').replace(')', ', 0.7)')
        );
        innerGlow.addColorStop(1, 'rgba(59, 130, 246, 0)');

        // Add pulsing effect
        const pulseScale =
          0.8 + Math.sin(Date.now() * 0.003 + index * 0.5) * 0.2;

        ctx.globalAlpha = particle.opacity * pulseScale;
        ctx.fillStyle = innerGlow;

        // Draw particle with slight elongation in direction of travel
        ctx.beginPath();
        ctx.ellipse(
          particle.x,
          particle.y,
          currentSize * 1.2, // Stretch in x direction
          currentSize,
          0,
          0,
          Math.PI * 2
        );
        ctx.fill();

        // Add a smaller brighter core
        ctx.beginPath();
        ctx.arc(particle.x, particle.y, currentSize * 0.4, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(255, 255, 255, 0.7)';
        ctx.fill();
      });

      ctx.restore();
    };

    // Draw progress indicator
    const drawProgress = () => {
      ctx.save();

      // Create a semi-transparent background for the progress text
      const bgHeight = 30;
      const bgWidth = 240;
      const bgX = canvas.width / 2 - bgWidth / 2;
      const bgY = canvas.height - bgHeight - 10;

      // Gradient background
      const bgGradient = ctx.createLinearGradient(bgX, bgY, bgX + bgWidth, bgY);

      if (theme === 'dark') {
        bgGradient.addColorStop(0, 'rgba(17, 24, 39, 0.7)');
        bgGradient.addColorStop(1, 'rgba(31, 41, 55, 0.7)');
      } else {
        bgGradient.addColorStop(0, 'rgba(255, 255, 255, 0.8)');
        bgGradient.addColorStop(1, 'rgba(243, 244, 246, 0.8)');
      }

      ctx.fillStyle = bgGradient;
      roundRect(ctx, bgX, bgY, bgWidth, bgHeight, 15);

      // Add a subtle border
      ctx.strokeStyle =
        theme === 'dark' ? 'rgba(75, 85, 99, 0.6)' : 'rgba(209, 213, 219, 0.8)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      roundRect(ctx, bgX, bgY, bgWidth, bgHeight, 15);
      ctx.stroke();

      // Progress text with improved styling
      ctx.fillStyle = theme === 'dark' ? '#e5e7eb' : '#111827';
      ctx.font = 'bold 14px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';

      // Different text based on progress
      if (progress < 100) {
        const message = t(
          'settings.localai.gpu.loading',
          'Loading model to GPU'
        );

        // Calculate positions for text and percentage
        const textX = canvas.width / 2;
        const textY = bgY + bgHeight / 2;

        // Draw text and percentage
        ctx.fillText(`${message}: ${progress.toFixed(0)}%`, textX, textY);

        // Draw progress bar under the text
        const barWidth = bgWidth - 40;
        const barHeight = 4;
        const barX = bgX + 20;
        const barY = bgY + bgHeight - 8;

        // Background of the progress bar
        ctx.fillStyle =
          theme === 'dark'
            ? 'rgba(75, 85, 99, 0.4)'
            : 'rgba(229, 231, 235, 0.8)';
        roundRect(ctx, barX, barY, barWidth, barHeight, 2);

        // Fill of the progress bar with gradient
        const barGradient = ctx.createLinearGradient(
          barX,
          barY,
          barX + barWidth,
          barY
        );
        barGradient.addColorStop(0, '#3b82f6');
        barGradient.addColorStop(1, '#60a5fa');

        ctx.fillStyle = barGradient;
        roundRect(ctx, barX, barY, barWidth * (progress / 100), barHeight, 2);
      } else {
        // Success message animation
        const message = t(
          'settings.localai.gpu.modelReady',
          'Model ready for inference'
        );
        const textX = canvas.width / 2;
        const textY = bgY + bgHeight / 2;

        // Add subtle animation to the success message
        const glowIntensity = 0.5 + Math.sin(Date.now() * 0.003) * 0.5;

        // Draw a subtle glow for the complete message
        ctx.shadowColor = `rgba(16, 185, 129, ${glowIntensity * 0.7})`;
        ctx.shadowBlur = 5;
        ctx.fillStyle = '#10b981'; // Green success color

        ctx.fillText(message, textX, textY);
      }

      ctx.restore();
    };

    // Execute all drawing functions
    drawConnectionPath();
    drawCPU();
    drawGPU();
    drawParticles();
    drawModel();
    drawProgress();

    // Continue animation
    animationRef.current = requestAnimationFrame(drawModelToGPUAnimation);
  };

  // Check if the local service is running on component mount
  useEffect(() => {
    // We don't have a direct way to check if the service is running
    // So we'll infer it from the active model and GPU status
    const checkServiceStatus = async () => {
      try {
        const gpuStatusResult = await getGpuStatus();

        // If we have an active model or the GPU is running, we assume the service is running
        setIsServiceRunning(
          !!gpuStatusResult?.is_running
        );
      } catch (error) {
        console.error('Error checking service status:', error);
        setIsServiceRunning(false);
      }
    };

    void checkServiceStatus();
  }, []);

  // Start/stop animation when the state changes
  useEffect(() => {
    if (isModelMovingToGpu) {
      // Start animation
      if (canvasRef.current) {
        const canvas = canvasRef.current;
        const ctx = canvas.getContext('2d');
        if (ctx) {
          animationStateRef.current = null; // Reset animation state
          animationRef.current = requestAnimationFrame(drawModelToGPUAnimation);
        }
      }
    } else {
      // Stop animation
      if (animationRef.current) {
        cancelAnimationFrame(animationRef.current);
        animationRef.current = null;
      }
    }

    return () => {
      if (animationRef.current) {
        cancelAnimationFrame(animationRef.current);
        animationRef.current = null;
      }
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps -- deps are intentionally limited
  }, [isModelMovingToGpu, theme]);

  // Handle window resize to adjust canvas dimensions
  useEffect(() => {
    const handleResize = () => {
      if (canvasRef.current) {
        canvasRef.current.width = canvasRef.current.offsetWidth;
        canvasRef.current.height = canvasRef.current.offsetHeight;
      }
    };

    window.addEventListener('resize', handleResize);
    handleResize(); // Initial setup

    return () => {
      window.removeEventListener('resize', handleResize);
    };
  }, []);

  // Start the local AI service
  const handleStartLocalService = async () => {
    setIsServiceActionInProgress(true);
    try {
      const result = await startLocalService();
      if (result.success) {
        setIsServiceRunning(true);
        toast.success(
          t(
            'settings.localai.service.startSuccess',
            'Local AI service started successfully'
          )
        );
      } else {
        toast.error(
          result.message ||
          t(
            'settings.localai.service.startError',
            'Failed to start Local AI service'
          )
        );
      }
    } catch (error) {
      console.error('Error starting local service:', error);
      let errorMsg = t(
        'settings.localai.service.startError',
        'Failed to start Local AI service'
      );
      if (error instanceof Error) {
        errorMsg = error.message;
      }
      toast.error(errorMsg, { duration: 5000 });
    } finally {
      setIsServiceActionInProgress(false);
    }
  };

  // Stop the local AI service
  const handleStopLocalService = async () => {
    setIsServiceActionInProgress(true);
    try {
      // If a model is currently running on GPU, stop it first
      if (gpuStatus?.is_running && gpuStatus?.current_model) {
        await stopModelFromGpu(gpuStatus.current_model);
      }

      const result = await stopLocalService();
      if (result.success) {
        setIsServiceRunning(false);
        setInternalActiveModel(null);
        toast.success(
          t(
            'settings.localai.service.stopSuccess',
            'Local AI service stopped successfully'
          )
        );
      } else {
        toast.error(
          result.message ||
          t(
            'settings.localai.service.stopError',
            'Failed to stop Local AI service'
          )
        );
      }
    } catch (error) {
      console.error('Error stopping local service:', error);
      let errorMsg = t(
        'settings.localai.service.stopError',
        'Failed to stop Local AI service'
      );
      if (error instanceof Error) {
        errorMsg = error.message;
      }
      toast.error(errorMsg, { duration: 5000 });
    } finally {
      setIsServiceActionInProgress(false);
    }
  };

  // Enhanced unified model deployment with service-based approach
  const startModelOnGPU = async (modelId: string) => {
    if (!modelId) {
      console.error('Attempted to deploy model with empty modelId');
      toast.error(t('settings.localai.gpu.modelIdError', 'Invalid model ID'));
      return;
    }

    // Log the exact model ID we're using

    setIsLoading(true);
    setIsModelMovingToGpu(true); // Start the animation

    try {
      // Wait a bit for the animation to play
      await new Promise(resolve => setTimeout(resolve, 1500));

      // Use the unified deployment approach via model service
      const result = await deployLocalModel(modelId);
      if (result.success) {
        // Update internal active model state
        setInternalActiveModel(modelId);
        localStorage.setItem('user-active-model', modelId);

        // Show success message
        toast.success(
          t(
            'settings.localai.gpu.deploySuccess',
            'Model deployed successfully with full configuration support'
          )
        );

        // Start polling for GPU status updates
        startGpuStatusPolling(modelId);
      } else {
        // Show error message from the API response
        toast.error(
          result.message ||
          t('settings.localai.gpu.deployError', 'Failed to deploy model')
        );
      }
    } catch (error) {
      console.error('Error deploying model:', error);

      // Extract detailed error from API response if available
      let errorMsg = t(
        'settings.localai.gpu.deployError',
        'Failed to deploy model'
      );
      if (error instanceof Error) {
        errorMsg = error.message;
      } else if (typeof error === 'object' && error !== null) {
        // Try to extract error detail from API response
        const apiError = error as { detail?: string };
        if (apiError.detail) {
          errorMsg = apiError.detail;
        }
      }

      toast.error(errorMsg, { duration: 5000 });
    } finally {
      setIsLoading(false);
      setIsModelMovingToGpu(false); // Stop the animation
    }
  };

  // Add new state for GPU features
  const [gpuStatus, setGpuStatus] = useState<GpuStatus | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [systemCapabilities, setSystemCapabilities] =
    useState<SystemCapabilities | null>(null);
  const [hasGpu, setHasGpu] = useState(false);
  const [isCheckingStatus, setIsCheckingStatus] = useState(false);
  const [gpuRefreshInterval, setGpuRefreshInterval] =
    useState<NodeJS.Timeout | null>(null);

  // Improved checkGpuStatus function with better active model handling
  const checkGpuStatus = async (modelId?: string) => {
    setIsCheckingStatus(true);
    try {
      // Always bypass cache to get fresh data
      const status = await getGpuStatus(modelId, true);


      setGpuStatus(status);

      // Update GPU availability based on status
      if (status.error && status.error.includes('No GPU detected')) {
        setHasGpu(false);
      } else if (status.is_available) {
        setHasGpu(true);
      } else {
        setHasGpu(false);
      }

      // Important: If we get a valid current_model from GPU status, update internalActiveModel
      if (status.current_model) {
        setInternalActiveModel(status.current_model);
        localStorage.setItem('user-active-model', status.current_model);
      }
      // If GPU is not running but we have an activeModel prop, ensure internalActiveModel is updated
      else if (!status.is_running && activeModel) {

        setInternalActiveModel(activeModel);
        localStorage.setItem('user-active-model', activeModel);
      }
      // If we don't have any active model info, try to fetch it directly
      else if (!status.is_running && !internalActiveModel) {
        await fetchActiveModel(true);
      }
    } catch (error) {
      console.error('Error checking GPU status:', error);
      toast.error(
        t('settings.localai.gpu.statusError', 'Failed to check GPU status')
      );
    } finally {
      setIsCheckingStatus(false);
    }
  };

  const startGpuStatusPolling = (modelId: string) => {
    // Clear any existing interval
    if (gpuRefreshInterval) {
      clearInterval(gpuRefreshInterval);
    }

    // Start with immediate check
    void checkGpuStatus(modelId);

    // Then continue checking every 5 seconds
    const interval = setInterval(() => {
      void checkGpuStatus(modelId);
    }, 5000);

    setGpuRefreshInterval(interval);
  };

  // Handle scanning models from filesystem
  const handleScanModels = async () => {
    if (isScanningModels) return;

    setIsScanningModels(true);
    try {
      const result = await reinitializeLocalModels();

      if (result.success) {
        toast({
          title: t('settings.localai.scanModels.success', 'Models scanned successfully'),
          description: result.message || t('settings.localai.scanModels.successDescription', 'Local models have been synchronized with the filesystem'),
        });

        // Refresh installed models in-place without closing the dialog
        await getInstalledModels(true, 'EMBEDDING');
      } else {
        toast({
          title: t('settings.localai.scanModels.error', 'Failed to scan models'),
          description: result.message || t('settings.localai.scanModels.errorDescription', 'Could not synchronize models with filesystem'),
          variant: 'destructive',
        });
      }
    } catch (error) {
      console.error('Error scanning models:', error);
      toast({
        title: t('settings.localai.scanModels.error', 'Failed to scan models'),
        description: error.message || t('settings.localai.scanModels.errorDescription', 'Could not synchronize models with filesystem'),
        variant: 'destructive',
      });
    } finally {
      setIsScanningModels(false);
    }
  };

  // Initialize data when component mounts
  useEffect(() => {
    const initializeData = async () => {
      setIsLoading(true);
      try {
        // First check system capabilities
        const caps = await getSystemCapabilities(true);
        setSystemCapabilities(caps);
        setHasGpu(caps.has_gpu || false);

        // Clear any stale caches that might be causing issues
        localStorage.removeItem('active-model');
        localStorage.removeItem('installed-models');
        localStorage.removeItem('featured-models');
        localStorage.removeItem('appropriate-models');

        // Then get active model
        await fetchActiveModel(true);

        // Then check GPU status if available
        if (caps.has_gpu) {
          await checkGpuStatus();
        }

        // Pre-cache other data with bypass cache to ensure fresh data
        // Exclude embedding models from the Local AI settings - they should be managed in embedding provider settings
        await getInstalledModels(true, 'EMBEDDING');
        await getFeaturedModels('', true);
      } catch (error) {
        console.error('Error initializing component data:', error);
      } finally {
        setIsLoading(false);
      }
    };

    // Only initialize data when tab becomes active
    if (isActive) {
      void initializeData();
    }

    // Cleanup on unmounting or when tab becomes inactive
    return () => {
      if (gpuRefreshInterval) {
        clearInterval(gpuRefreshInterval);
      }
      // Reset checking status to prevent infinite loading animation
      setIsCheckingStatus(false);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps -- deps are intentionally limited
  }, [isActive]); // Run when isActive changes

  return (
    <>
      <div className='sticky top-0 pt-0 pb-6 z-20' style={{ position: 'sticky' }}>
        <div
          className='absolute inset-0 bg-white/50 dark:bg-zinc-900/50 backdrop-blur-xl -z-10'
          style={{ maskImage: 'linear-gradient(to bottom, transparent 0%, black 10%, black 90%, transparent 100%)' }}
        />
        <div className={`flex ${isMobile ? 'flex-col gap-3' : 'items-center justify-between'}`}>
          <div>
            <h2 className='text-2xl font-bold text-zinc-900 dark:text-white mb-1'>
              {t('settings.localai.title')}
            </h2>
            <p className='text-sm text-zinc-500 dark:text-zinc-400'>
              Manage local AI models and system capabilities
            </p>
          </div>
          <div className='flex items-center gap-2'>
            <Button
              variant='outline'
              size={isMobile ? 'icon' : 'default'}
              className={`flex items-center ${isMobile ? '' : 'gap-2'} border-zinc-300 dark:border-zinc-700 text-zinc-800 dark:text-white hover:bg-zinc-100 dark:hover:bg-zinc-800`}
              onClick={handleScanModels}
              disabled={isScanningModels}
              title={t('settings.localai.buttons.scanModels', 'Scan filesystem and update database with available models')}
              data-testid="settings-local-ai-scan-models-button"
            >
              {isScanningModels ? (
                <Loader2 className='h-4 w-4 animate-spin' />
              ) : (
                <RefreshCw className='h-4 w-4' />
              )}
              {!isMobile && <span>{t('settings.localai.scanModels.label', 'Scan Models')}</span>}
            </Button>
            <Button
              variant='outline'
              size={isMobile ? 'icon' : 'default'}
              className={`flex items-center ${isMobile ? '' : 'gap-2'} border-zinc-300 dark:border-zinc-700 text-zinc-800 dark:text-white hover:bg-zinc-100 dark:hover:bg-zinc-800`}
              onClick={openLocalAIModelsDialog}
              title={t('settings.localai.buttons.manageModels')}
              data-testid="settings-local-ai-manage-models-button"
            >
              <Laptop className='h-4 w-4' />
              {!isMobile && <span>{t('settings.localai.manageModels')}</span>}
            </Button>
          </div>
        </div>
      </div>

      <div className='space-y-10'>
        {/* Model Visibility Section */}
        <div>
          <h3 className='text-base font-medium text-zinc-800 dark:text-white mb-4'>
            {t('settings.localai.installedModels.title')}
          </h3>
          <div className='flex justify-between items-center p-4 bg-zinc-100 dark:bg-zinc-900 rounded-lg border border-zinc-200 dark:border-zinc-800'>
            <div>
              <h4 className='text-base font-medium text-zinc-800 dark:text-white mb-1'>
                {t('settings.localai.installedModels.showModels')}
              </h4>
              <p className='text-sm text-zinc-600 dark:text-zinc-400'>
                {t('settings.localai.installedModels.showModelsDescription')}
              </p>
              <p className='text-xs text-amber-600 dark:text-amber-400 mt-2'>
                {t('settings.localai.installedModels.embeddingNote', {
                  defaultValue:
                    'Note: Embedding models are configured separately in the embedding provider settings.',
                })}
              </p>
            </div>
            <Switch checked={showModels} onCheckedChange={setShowModels} data-testid="settings-local-ai-show-models-toggle" />
          </div>
        </div>

        {/* Server Configuration Header */}
        <h2 className='text-xl font-semibold text-zinc-800 dark:text-white mb-4 hidden md:block'>
          {t('settings.localai.service.configHeader', 'Server Configuration')}
        </h2>

        {/* Maximum Parallel Chats */}
        <div>
          <h3 className='text-base font-medium text-zinc-800 dark:text-white mb-4'>
            {t(
              'settings.localai.service.parallelChats',
              'Maximum Parallel Chats'
            )}
          </h3>
          <p className='text-sm text-zinc-600 dark:text-zinc-400 mb-4'>
            {t(
              'settings.localai.service.parallelChatsDescription',
              'Maximum number of concurrent chat sessions the backend will process simultaneously.'
            )}
          </p>
          <div className='flex items-center gap-4'>
            <Button
              variant='outline'
              className='border-zinc-300 dark:border-zinc-700 h-8 w-8 p-0'
              onClick={() =>
                setMaxParallelChats?.(Math.max(1, (maxParallelChats || 3) - 1))
              }
            >
              -
            </Button>
            <span className='text-zinc-800 dark:text-white min-w-[30px] text-center'>
              {maxParallelChats || 3}
            </span>
            <Button
              variant='outline'
              className='border-zinc-300 dark:border-zinc-700 h-8 w-8 p-0'
              onClick={() =>
                setMaxParallelChats?.(Math.min(10, (maxParallelChats || 3) + 1))
              }
            >
              +
            </Button>
            <div className='ml-4 flex-1 h-1 bg-zinc-200 dark:bg-zinc-700 rounded-full'>
              <div
                className='h-full bg-zinc-800 dark:bg-white rounded-full'
                style={{
                  width: `${(((maxParallelChats || 3) - 1) / 9) * 100}%`,
                }}
              ></div>
            </div>
          </div>
        </div>

        {/* GPU Acceleration Section */}
        <div>
          <h3 className='text-base font-medium text-zinc-800 dark:text-white mb-4 flex items-center gap-2'>
            <Cpu className='h-4 w-4 text-zinc-600 dark:text-zinc-400' />
            {t('settings.localai.gpu.title', 'GPU Acceleration')}
          </h3>

          {isCheckingStatus ? (
            <div className='bg-zinc-50 dark:bg-zinc-900/50 border border-zinc-200 dark:border-zinc-700 p-8'>
              <div className='flex flex-col items-center justify-center space-y-6'>
                {/* GPU Detection Animation */}
                <div className='flex flex-col items-center gap-6'>
                  {/* GPU Chip Animation */}
                  <div className='relative'>
                    {/* Main GPU Chip */}
                    <div className='w-16 h-12 bg-gradient-to-br from-blue-500 to-purple-600 dark:from-blue-400 dark:to-purple-500 rounded-lg relative overflow-hidden shadow-lg'>
                      {/* Circuit Lines */}
                      <div className='absolute inset-1 border border-blue-200 dark:border-blue-300 rounded opacity-60'></div>
                      <div className='absolute top-2 left-2 w-2 h-2 bg-blue-200 dark:bg-blue-300 rounded-full opacity-80'></div>
                      <div className='absolute top-2 right-2 w-2 h-2 bg-purple-200 dark:bg-purple-300 rounded-full opacity-80'></div>
                      <div className='absolute bottom-2 left-2 w-2 h-2 bg-purple-200 dark:bg-purple-300 rounded-full opacity-80'></div>
                      <div className='absolute bottom-2 right-2 w-2 h-2 bg-blue-200 dark:bg-blue-300 rounded-full opacity-80'></div>

                      {/* Scanning Effect */}
                      <div className='absolute inset-0 bg-gradient-to-r from-transparent via-white/30 to-transparent animate-pulse'></div>
                      <div className='absolute top-0 left-0 w-full h-full bg-gradient-to-r from-transparent via-blue-300/20 to-transparent animate-ping'></div>
                    </div>

                    {/* Connection Pins */}
                    <div className='absolute -bottom-1 left-1 w-1 h-2 bg-yellow-500 dark:bg-yellow-400 rounded-b'></div>
                    <div className='absolute -bottom-1 left-3 w-1 h-2 bg-yellow-500 dark:bg-yellow-400 rounded-b'></div>
                    <div className='absolute -bottom-1 right-3 w-1 h-2 bg-yellow-500 dark:bg-yellow-400 rounded-b'></div>
                    <div className='absolute -bottom-1 right-1 w-1 h-2 bg-yellow-500 dark:bg-yellow-400 rounded-b'></div>
                  </div>

                  {/* Status Text */}
                  <div className='text-center'>
                    <div className='text-base font-medium text-zinc-700 dark:text-zinc-300 mb-2'>
                      {t(
                        'settings.localai.gpu.checkingStatus',
                        'Checking GPU status...'
                      )}
                    </div>

                    {/* Animated Dots */}
                    <div className='flex items-center justify-center gap-1'>
                      <div className='w-2 h-2 bg-blue-500 dark:bg-blue-400 rounded-full animate-bounce'></div>
                      <div className='w-2 h-2 bg-purple-500 dark:bg-purple-400 rounded-full animate-bounce' style={{ animationDelay: '0.1s' }}></div>
                      <div className='w-2 h-2 bg-blue-500 dark:bg-blue-400 rounded-full animate-bounce' style={{ animationDelay: '0.2s' }}></div>
                    </div>
                  </div>

                  {/* Detection Process */}
                  <div className='w-full max-w-sm space-y-3'>
                    <div className='flex items-center gap-3 text-sm text-zinc-600 dark:text-zinc-400'>
                      <div className='w-4 h-4 border-2 border-blue-500 border-t-transparent rounded-full animate-spin'></div>
                      <span>{t('settings.localai.gpu.detectingHardware', 'Detecting hardware capabilities')}</span>
                    </div>
                    <div className='flex items-center gap-3 text-sm text-zinc-600 dark:text-zinc-400'>
                      <div className='w-4 h-4 border-2 border-purple-500 border-t-transparent rounded-full animate-spin' style={{ animationDelay: '0.3s' }}></div>
                      <span>{t('settings.localai.gpu.checkingCuda', 'Checking CUDA compatibility')}</span>
                    </div>
                    <div className='flex items-center gap-3 text-sm text-zinc-600 dark:text-zinc-400'>
                      <div className='w-4 h-4 border-2 border-green-500 border-t-transparent rounded-full animate-spin' style={{ animationDelay: '0.6s' }}></div>
                      <span>{t('settings.localai.gpu.analyzingMemory', 'Analyzing memory availability')}</span>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          ) : !hasGpu ? (
            <div className='bg-zinc-100 dark:bg-zinc-900 rounded-lg p-6 border border-zinc-200 dark:border-zinc-800'>
              <div className='flex items-start gap-4'>
                <div className='bg-amber-100 dark:bg-amber-900/30 p-3 rounded-full'>
                  <AlertTriangle className='h-6 w-6 text-amber-600 dark:text-amber-500' />
                </div>
                <div>
                  <h4 className='text-base font-medium text-zinc-800 dark:text-white mb-2'>
                    {t('settings.localai.gpu.noGpuTitle', 'No GPU Detected')}
                  </h4>
                  <p className='text-sm text-zinc-600 dark:text-zinc-400'>
                    {t(
                      'settings.localai.gpu.noGpuDescription',
                      'Your system does not have a compatible GPU for accelerating AI models. Models will run in CPU-only mode, which may be slower for larger models.'
                    )}
                  </p>
                </div>
              </div>
            </div>
          ) : (
            <div className='space-y-4'>
              {/* Visualization canvas for model moving to GPU */}
              {isModelMovingToGpu ? (
                <div className='bg-gradient-to-br from-blue-50 to-indigo-50 dark:from-blue-950/30 dark:to-indigo-950/30 border border-blue-200 dark:border-blue-800 rounded-lg p-6 mb-4 overflow-hidden shadow-inner'>
                  <canvas
                    ref={canvasRef}
                    className='w-full h-48 mx-auto'
                    style={{ maxWidth: '700px' }}
                  />
                </div>
              ) : gpuStatus?.is_running ? (
                <div className='bg-white dark:bg-zinc-950 rounded-lg p-4 border border-zinc-200 dark:border-zinc-800'>
                  <div className='flex items-center justify-between mb-4'>
                    <div className='flex items-center gap-3'>
                      <div className='p-2 bg-green-100 dark:bg-green-900/30 rounded-full'>
                        <Cpu className='h-5 w-5 text-green-600 dark:text-green-400' />
                      </div>
                      <div>
                        <div className='text-sm font-medium text-zinc-800 dark:text-white'>
                          {gpuStatus.current_model ||
                            t(
                              'settings.localai.gpu.unknownModel',
                              'Unknown Model'
                            )}
                        </div>
                        <div className='text-xs text-zinc-500 dark:text-zinc-400'>
                          {t(
                            'settings.localai.gpu.modelRunningOnGpu',
                            'Running on GPU'
                          )}
                        </div>
                      </div>
                    </div>

                    <Button
                      variant='destructive'
                      size='sm'
                      onClick={() =>
                        stopModelFromGpu(
                          gpuStatus.current_model || internalActiveModel || ''
                        )
                      }
                      disabled={isLoading}
                      className='bg-red-600 hover:bg-red-700'
                    >
                      {isLoading ? (
                        <Loader2 className='h-4 w-4 mr-2 animate-spin' />
                      ) : (
                        <Square className='h-4 w-4 mr-2' />
                      )}
                      {t('settings.localai.gpu.stopModel', 'Stop Model')}
                    </Button>
                  </div>

                  {/* GPU Memory Usage */}
                  <div className='space-y-3'>
                    <div>
                      <div className='flex justify-between items-center mb-1'>
                        <div className='text-xs text-zinc-500 dark:text-zinc-400'>
                          {t(
                            'settings.localai.gpu.memoryUsage',
                            'GPU Memory Usage'
                          )}
                        </div>
                        <div className='text-xs font-medium text-zinc-700 dark:text-zinc-300'>
                          {gpuStatus.gpu_memory_used
                            ? `${gpuStatus.gpu_memory_used.toFixed(0)} MB / ${(systemCapabilities?.gpu_info?.vram_gb || 0) *
                            1024
                            } MB`
                            : 'N/A'}
                        </div>
                      </div>
                      <Progress
                        value={
                          gpuStatus.gpu_memory_used
                            ? Math.min(
                              100,
                              (gpuStatus.gpu_memory_used /
                                ((systemCapabilities?.gpu_info?.vram_gb ||
                                  8) *
                                  1024)) *
                              100
                            )
                            : 0
                        }
                        className='h-1.5'
                      />
                    </div>

                    {/* GPU Utilization */}
                    <div>
                      <div className='flex justify-between items-center mb-1'>
                        <div className='text-xs text-zinc-500 dark:text-zinc-400'>
                          {t(
                            'settings.localai.gpu.utilization',
                            'GPU Utilization'
                          )}
                        </div>
                        <div className='text-xs font-medium text-zinc-700 dark:text-zinc-300'>
                          {gpuStatus.gpu_utilization
                            ? `${gpuStatus.gpu_utilization.toFixed(0)}%`
                            : 'N/A'}
                        </div>
                      </div>
                      <Progress
                        value={gpuStatus.gpu_utilization || 0}
                        className='h-1.5'
                      />
                    </div>
                  </div>
                </div>
              ) : (
                <GpuDeploySection
                  activeModel={internalActiveModel}
                  isLoading={isLoading}
                  isCheckingStatus={isCheckingStatus}
                  gpuStatus={gpuStatus}
                  startModelOnGPU={startModelOnGPU}
                  checkGpuStatus={checkGpuStatus}
                />
              )}
            </div>
          )}
        </div>

        {/* Local AI Service Control Section */}
        <div className='mt-8'>
          <h3 className='text-base font-medium text-zinc-800 dark:text-white mb-4 flex items-center gap-2'>
            <Server className='h-4 w-4 text-zinc-600 dark:text-zinc-400' />
            {t('settings.localai.service.title', 'Local AI Service')}
          </h3>

          <div className='bg-zinc-50 dark:bg-zinc-900 rounded-lg border border-zinc-200 dark:border-zinc-800 p-4'>
            <div className='flex items-center justify-between'>
              <div>
                <div className='text-sm font-medium text-zinc-800 dark:text-zinc-200'>
                  {t('settings.localai.service.status', 'Service Status')}
                </div>
                <div className='text-xs text-zinc-600 dark:text-zinc-400 mt-1'>
                  {isServiceRunning
                    ? t(
                      'settings.localai.service.running',
                      'Local AI service is running'
                    )
                    : t(
                      'settings.localai.service.stopped',
                      'Local AI service is stopped'
                    )}
                </div>
              </div>

              <div className='flex items-center gap-2'>
                {isServiceRunning ? (
                  <Button
                    variant='destructive'
                    size='sm'
                    disabled={isServiceActionInProgress}
                    onClick={handleStopLocalService}
                  >
                    {isServiceActionInProgress && (
                      <Loader2 className='mr-2 h-4 w-4 animate-spin' />
                    )}
                    {t('settings.localai.service.stop', 'Stop Service')}
                  </Button>
                ) : (
                  <Button
                    variant='default'
                    size='sm'
                    disabled={isServiceActionInProgress}
                    onClick={handleStartLocalService}
                  >
                    {isServiceActionInProgress && (
                      <Loader2 className='mr-2 h-4 w-4 animate-spin' />
                    )}
                    {t('settings.localai.service.start', 'Start Service')}
                  </Button>
                )}
              </div>
            </div>

            <div className='mt-4 text-xs text-zinc-500 dark:text-zinc-400 bg-zinc-100 dark:bg-zinc-800 p-3 rounded'>
              <div className='flex items-start gap-2'>
                <AlertTriangle className='h-4 w-4 text-amber-500 flex-shrink-0 mt-0.5' />
                <div>
                  {t(
                    'settings.localai.service.note',
                    'The local AI service must be running to use local models. Starting the service may take a few moments.'
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* GPU Hardware Section - Completely separate from acceleration */}
        {hasGpu && systemCapabilities?.gpu_info && (
          <div className='mt-8'>
            <h3 className='text-base font-medium text-zinc-800 dark:text-white mb-4 flex items-center gap-2'>
              <Microchip className='h-4 w-4 text-zinc-600 dark:text-zinc-400' />
              {t('settings.localai.hardware.title', 'GPU Hardware')}
            </h3>

            <GpuHardwareInfoSection
              systemCapabilities={systemCapabilities}
              t={t}
              gpuStatus={gpuStatus}
            />
          </div>
        )}

        {/* GPU Logs Section */}
        {hasGpu && (
          <div className='mt-8'>
            <Collapsible
              open={gpuLogsExpanded}
              onOpenChange={setGpuLogsExpanded}
            >
              <div className='flex items-center justify-between mb-4'>
                <h3 className='text-base font-medium text-zinc-800 dark:text-white flex items-center gap-2'>
                  <Code className='h-4 w-4 text-zinc-600 dark:text-zinc-400' />
                  {t('settings.localai.gpu.logs', 'GPU Activity Logs')}
                </h3>
                <CollapsibleTrigger asChild>
                  <Button variant='ghost' size='sm' className='h-8 w-8 p-0'>
                    <ChevronDown className='h-4 w-4' />
                    <span className='sr-only'>Toggle logs</span>
                  </Button>
                </CollapsibleTrigger>
              </div>

              <CollapsibleContent>
                <div className='bg-zinc-100 dark:bg-zinc-900 rounded-lg border border-zinc-200 dark:border-zinc-800 overflow-hidden'>
                  <div className='px-6 py-3 border-b border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-950 flex justify-between items-center'>
                    <span className='text-sm font-medium text-zinc-700 dark:text-zinc-300'>
                      {gpuStatus?.is_running
                        ? t(
                          'settings.localai.gpu.activeSession',
                          'Active GPU Session'
                        )
                        : t(
                          'settings.localai.gpu.recentLogs',
                          'Recent Activity'
                        )}
                    </span>
                    <Button
                      variant='ghost'
                      size='sm'
                      className='h-7 text-xs'
                      onClick={() => {
                        void checkGpuStatus();
                        toast.success(
                          t('settings.localai.logs.refreshed', 'Logs refreshed')
                        );
                      }}
                    >
                      <RefreshCw className='h-3.5 w-3.5 mr-1.5' />
                      {t('settings.localai.logs.refresh', 'Refresh')}
                    </Button>
                  </div>

                  <div className='p-4 max-h-48 overflow-y-auto font-mono text-xs bg-zinc-950 text-zinc-200'>
                    {gpuStatus?.is_running ? (
                      <div className='space-y-1'>
                        <div className='text-green-400'>
                          [{new Date().toLocaleTimeString()}] GPU session active
                          for model: {gpuStatus.current_model}
                        </div>
                        <div className='text-zinc-400'>
                          [{new Date().toLocaleTimeString()}] Memory allocated:{' '}
                          {gpuStatus.gpu_memory_used?.toFixed(0) || '?'} MB
                        </div>
                        <div className='text-zinc-400'>
                          [{new Date().toLocaleTimeString()}] GPU utilization:{' '}
                          {gpuStatus.gpu_utilization?.toFixed(0) || '?'}%
                        </div>
                        <div className='text-zinc-400'>
                          [{new Date().toLocaleTimeString()}] Hardware:{' '}
                          {systemCapabilities?.gpu_info?.name || 'Unknown GPU'}
                        </div>
                        <div className='text-cyan-400'>
                          [{new Date().toLocaleTimeString()}] Inference engine
                          running with optimized parameters
                        </div>
                        <div className='text-zinc-500'>
                          [{new Date().toLocaleTimeString()}] Context size:{' '}
                          {advancedConfigJson
                            ? JSON.parse(advancedConfigJson)?.llama
                              ?.context_size || 8192
                            : 8192}{' '}
                          tokens
                        </div>
                        <div className='text-zinc-500'>
                          [{new Date().toLocaleTimeString()}] Using compute
                          capability:{' '}
                          {systemCapabilities?.device_type}
                        </div>
                        <div className='text-green-500'>
                          [{new Date().toLocaleTimeString()}] Model loaded
                          successfully and ready for inference
                        </div>
                        <div className='text-blue-400'>
                          [{new Date().toLocaleTimeString()}] Streaming response
                          enabled, optimized for chat
                        </div>
                      </div>
                    ) : (
                      <div className='space-y-1'>
                        <div className='text-zinc-400'>
                          [{new Date().toLocaleTimeString()}] GPU is idle and
                          ready for use
                        </div>
                        <div className='text-zinc-400'>
                          [{new Date().toLocaleTimeString()}] Hardware:{' '}
                          {systemCapabilities?.gpu_info?.name || 'Unknown GPU'}
                        </div>
                        <div className='text-zinc-400'>
                          [{new Date().toLocaleTimeString()}] VRAM available:{' '}
                          {systemCapabilities?.gpu_info?.vram_gb || '?'} GB
                        </div>
                        <div className='text-zinc-500'>
                          [{new Date().toLocaleTimeString()}] Current processing
                          mode: CPU only
                        </div>
                        <div className='text-amber-400'>
                          [{new Date().toLocaleTimeString()}] Recommendation:
                          Use the 'Load to GPU' button to accelerate models
                        </div>
                        <div className='text-zinc-500'>
                          [{new Date().toLocaleTimeString()}] Local AI server
                          status:{' '}
                          {internalActiveModel
                            ? 'Ready with active model'
                            : 'Waiting for model selection'}
                        </div>
                      </div>
                    )}
                  </div>

                  {gpuStatus?.is_running && (
                    <div className='px-4 py-3 border-t border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-950'>
                      <div className='flex items-center justify-between'>
                        <div className='text-xs text-zinc-500 dark:text-zinc-400'>
                          {t(
                            'settings.localai.gpu.sessionStatus',
                            'Session Status'
                          )}
                        </div>
                        <div className='flex items-center gap-1 text-xs font-medium text-green-600 dark:text-green-400'>
                          <CheckCircle className='h-3 w-3' />
                          {t('settings.localai.gpu.running', 'Running')}
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              </CollapsibleContent>
            </Collapsible>
          </div>
        )}

        {/* GPU Hardware Cards - Only show as separate section if GPU is running */}
        {systemCapabilities?.gpu_info && gpuStatus?.is_running && (
          <div className='mt-6 grid grid-cols-1 md:grid-cols-2 gap-4'>
            <GpuHardwareCard gpuInfo={systemCapabilities.gpu_info} />

            {/* Handling for multiple GPUs - check if they exist before mapping */}
            {systemCapabilities.gpu_info &&
              (systemCapabilities.gpu_info as Record<string, unknown>)?.additional_gpus &&
              ((systemCapabilities.gpu_info as Record<string, unknown>)?.additional_gpus as typeof systemCapabilities.gpu_info[] || []).map(
                (gpu, idx: number) => (
                  <GpuHardwareCard key={idx} gpuInfo={gpu} index={idx + 1} />
                )
              )}
          </div>
        )}

        {/* For multiple GPUs, always show them regardless of GPU state */}
        {systemCapabilities?.gpu_info &&
          (systemCapabilities.gpu_info as Record<string, unknown>)?.additional_gpus &&
          ((systemCapabilities.gpu_info as Record<string, unknown>)?.additional_gpus as unknown[])?.length > 0 && (
            <div className='mt-6'>
              <h3 className='text-base font-medium text-zinc-800 dark:text-white mb-3 flex items-center gap-2'>
                <Microchip className='h-4 w-4 text-zinc-600 dark:text-zinc-400' />
                {t('settings.localai.gpu.additionalGpus', 'Additional GPUs')}
              </h3>
              <div className='grid grid-cols-1 md:grid-cols-2 gap-4'>
                {(
                  (systemCapabilities.gpu_info as Record<string, unknown>)?.additional_gpus as typeof systemCapabilities.gpu_info[] || []
                ).map((gpu, idx: number) => (
                  <GpuHardwareCard key={idx} gpuInfo={gpu} index={idx + 1} />
                ))}
              </div>
            </div>
          )}

        {/* Advanced Configuration */}
        <div>
          <div className='flex justify-between items-center mb-4'>
            <div>
              <h3 className='text-base font-medium text-zinc-800 dark:text-white mb-1'>
                {t(
                  'settings.localai.advanced.title',
                  'Advanced Model Configuration'
                )}
              </h3>
              <p className='text-sm text-zinc-600 dark:text-zinc-400'>
                {t(
                  'settings.localai.advanced.description',
                  'Enable advanced JSON configuration for the inference engine.'
                )}
              </p>
            </div>
            <Switch
              checked={useAdvancedConfig || false}
              onCheckedChange={value => setUseAdvancedConfig?.(value)}
            />
          </div>

          {useAdvancedConfig && (
            <div className='space-y-4'>
              <div className='flex items-center justify-between gap-2 mb-2'>
                <div className='flex items-center gap-2'>
                  <Copy className='h-4 w-4 text-zinc-600 dark:text-zinc-400' />
                  <span className='text-sm text-zinc-600 dark:text-zinc-400'>
                    {t(
                      'settings.localai.advanced.jsonConfig',
                      'JSON Configuration'
                    )}
                  </span>
                </div>
                <div className='flex items-center gap-2'>
                  <Button
                    variant='ghost'
                    size='sm'
                    className='h-7 text-xs px-2 text-zinc-600 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-300'
                    onClick={formatJson}
                  >
                    {t('settings.localai.advanced.formatJson', 'Format JSON')}
                  </Button>
                  <Button
                    variant='ghost'
                    size='icon'
                    className='h-7 w-7 text-zinc-600 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-300'
                    onClick={() =>
                      copyToClipboard(advancedConfigJson || defaultConfig)
                    }
                    title={t('settings.localai.buttons.copy')}
                  >
                    <Copy className='h-3.5 w-3.5' />
                  </Button>
                </div>
              </div>

              <div className='relative rounded-lg border border-zinc-200 dark:border-zinc-800'>
                {/* JSON Editor with syntax highlighting */}
                <div className='flex flex-col'>
                  {/* Editor header */}
                  <div className='flex justify-between items-center px-3 py-2 bg-zinc-200 dark:bg-zinc-800 border-b border-zinc-300 dark:border-zinc-700'>
                    <span className='text-xs font-medium text-zinc-700 dark:text-zinc-300'>
                      {syntaxError ? (
                        <span className='text-red-600 dark:text-red-400'>
                          JSON Syntax Error
                        </span>
                      ) : (
                        'JSON Editor'
                      )}
                    </span>
                    <div className='flex items-center gap-2'>
                      <Button
                        variant='ghost'
                        size='icon'
                        className='h-7 w-7 text-zinc-600 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-300'
                        onClick={() =>
                          copyToClipboard(advancedConfigJson || defaultConfig)
                        }
                        title={t('settings.localai.buttons.copy')}
                      >
                        <Copy className='h-3.5 w-3.5' />
                      </Button>
                    </div>
                  </div>

                  {/* Main editor area with overlay syntax highlighting */}
                  <div className='relative bg-white dark:bg-zinc-900 max-h-[400px] overflow-auto'>
                    {/* Hidden syntax highlighter that shows through */}
                    <div className='absolute inset-0 pointer-events-none p-4'>
                      <SyntaxHighlighter
                        language='json'
                        style={
                          theme === 'light' ? customOneLight : customOneDark
                        }
                        wrapLines={true}
                        wrapLongLines={true}
                        customStyle={{
                          margin: 0,
                          padding: 0,
                          background: 'transparent',
                          fontSize: '14px',
                          lineHeight: 1.5,
                          height: 'auto',
                          width: '100%',
                          overflow: 'visible',
                          fontFamily:
                            'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
                        }}
                      >
                        {advancedConfigJson || defaultConfig}
                      </SyntaxHighlighter>
                    </div>

                    {/* Transparent textarea overlay for editing */}
                    <textarea
                      className={`w-full p-4 font-mono text-sm bg-transparent text-transparent caret-zinc-800 dark:caret-zinc-300 resize-none focus:outline-none border-0 z-10 ${isJsonFormatted ? 'min-h-[250px]' : 'h-[100px]'
                        }`}
                      value={advancedConfigJson || defaultConfig}
                      onChange={e => handleJsonChange(e.target.value)}
                      onBlur={formatJson}
                      spellCheck={false}
                      autoCapitalize='off'
                      autoCorrect='off'
                      style={{
                        tabSize: 2,
                        lineHeight: 1.5,
                        overflow: 'hidden',
                        fontFamily:
                          'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
                      }}
                    />
                  </div>

                  {/* Error display */}
                  {syntaxError && (
                    <div className='p-2 bg-red-100 dark:bg-red-900/50 text-red-800 dark:text-red-300 text-xs border-t border-red-200 dark:border-red-800'>
                      <div className='font-medium'>Error Details:</div>
                      <div>{syntaxError}</div>
                    </div>
                  )}
                </div>
              </div>

              <p className='text-xs text-amber-600 dark:text-amber-400 flex items-center gap-1'>
                <Server className='h-3 w-3' />
                {t(
                  'settings.localai.advanced.warning',
                  'Requires server restart to apply changes.'
                )}
              </p>
            </div>
          )}
        </div>
      </div>

      {/* Service Status Section - Moved from Service tab */}
      <div className='mt-10'>
        <h3 className='text-base font-medium text-zinc-800 dark:text-white mb-4 flex items-center gap-2'>
          <Activity className='h-4 w-4 text-zinc-600 dark:text-zinc-400' />
          {t('settings.service.statusTitle')}
        </h3>
        <ServiceStatusSection />
      </div>
    </>
  );
};

// Service Status Component
const ServiceStatusSection = () => {
  const { t } = useTranslation();
  const [status, setStatus] = useState<LocalServiceStatus | null>(null);
  const [isLoadingStatus, setIsLoadingStatus] = useState<boolean>(false);

  const fetchStatus = async () => {
    setIsLoadingStatus(true);
    try {
      const serviceStatus = await getLocalServiceStatus();
      setStatus(serviceStatus);
    } catch (error) {
      toast({
        title: t('settings.service.errors.fetchStatusFailed'),
        description: error instanceof Error ? error.message : String(error),
        variant: 'destructive',
      });
    } finally {
      setIsLoadingStatus(false);
    }
  };

  useEffect(() => {
    void fetchStatus();
  // eslint-disable-next-line react-hooks/exhaustive-deps -- deps are intentionally limited
  }, []);

  if (isLoadingStatus) {
    return (
      <div className='flex justify-center p-6'>
        <Loader2 className='h-8 w-8 animate-spin text-zinc-500 dark:text-zinc-400' />
      </div>
    );
  }

  if (!status) {
    return (
      <div className='bg-amber-50 dark:bg-amber-950 border border-amber-200 dark:border-amber-800 p-4'>
        <p className='text-sm text-amber-700 dark:text-amber-400'>
          {t('settings.service.status.unavailable')}
        </p>
      </div>
    );
  }

  return (
    <div className='bg-zinc-100 dark:bg-zinc-900 rounded-lg border border-zinc-200 dark:border-zinc-800 p-4'>
      <div className='grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4'>
        <div className='space-y-2'>
          <div>
            <div className='text-sm font-medium text-zinc-500 dark:text-zinc-400'>
              {t('settings.service.serviceEndpoint')}
            </div>
            <div className='text-sm font-mono text-zinc-800 dark:text-zinc-300'>
              {status.api_base || `https://${status.host}:${status.port}`}
            </div>
          </div>
          <div>
            <div className='text-sm font-medium text-zinc-500 dark:text-zinc-400'>
              {t('settings.service.serviceVersion')}
            </div>
            <div className='text-sm font-mono text-zinc-800 dark:text-zinc-300'>
              {status.version}
            </div>
          </div>
          <div>
            <div className='text-sm font-medium text-zinc-500 dark:text-zinc-400'>
              {t('settings.service.running')}
            </div>
            <div
              className={`text-sm font-medium ${status.running
                ? 'text-green-600 dark:text-green-500'
                : 'text-red-600 dark:text-red-500'
                }`}
            >
              {status.running
                ? t('settings.service.status.running')
                : t('settings.service.status.stopped')}
            </div>
          </div>
        </div>
        <div className='space-y-2'>
          <div>
            <div className='text-sm font-medium text-zinc-500 dark:text-zinc-400'>
              {t('settings.service.modelsDirectory')}
            </div>
            <div className='text-sm font-mono text-zinc-800 dark:text-zinc-300'>
              {status.models_directory}
            </div>
          </div>
          {status.uptime_human && (
            <div>
              <div className='text-sm font-medium text-zinc-500 dark:text-zinc-400'>
                Uptime
              </div>
              <div className='text-sm font-mono text-zinc-800 dark:text-zinc-300'>
                {status.uptime_human}
              </div>
            </div>
          )}
          {status.process_id && (
            <div>
              <div className='text-sm font-medium text-zinc-500 dark:text-zinc-400'>
                Process ID
              </div>
              <div className='text-sm font-mono text-zinc-800 dark:text-zinc-300'>
                {status.process_id}
              </div>
            </div>
          )}
        </div>
        <div className='space-y-2'>
          {status.memory_usage && (
            <div>
              <div className='text-sm font-medium text-zinc-500 dark:text-zinc-400'>
                Memory Usage
              </div>
              <div className='text-sm font-mono text-zinc-800 dark:text-zinc-300'>
                {status.memory_usage.rss_mb} MB RSS
              </div>
            </div>
          )}
          {status.cpu_percent !== undefined && (
            <div>
              <div className='text-sm font-medium text-zinc-500 dark:text-zinc-400'>
                CPU Usage
              </div>
              <div className='text-sm font-mono text-zinc-800 dark:text-zinc-300'>
                {status.cpu_percent.toFixed(1)}%
              </div>
            </div>
          )}
          {status.system_info?.platform && (
            <div>
              <div className='text-sm font-medium text-zinc-500 dark:text-zinc-400'>
                Platform
              </div>
              <div className='text-sm font-mono text-zinc-800 dark:text-zinc-300'>
                {status.system_info.platform}{' '}
                {status.system_info.platform_release}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

// Helper function for rounded rectangle
function roundRect(ctx, x, y, width, height, radius, strokeOnly = false) {
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + width - radius, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + radius);
  ctx.lineTo(x + width, y + height - radius);
  ctx.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
  ctx.lineTo(x + radius, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - radius);
  ctx.lineTo(x, y + radius);
  ctx.quadraticCurveTo(x, y, x + radius, y);
  ctx.closePath();

  if (!strokeOnly) {
    ctx.fill();
  }
}
