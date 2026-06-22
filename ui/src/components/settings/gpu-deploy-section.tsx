import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import {
  Cpu,
  Laptop,
  Loader2,
  RefreshCw,
  Zap,
  Square,
  CheckCircle,
} from 'lucide-react';

import {
  undeployLocalModel,
  getDeploymentStatus,
} from '@/lib/api-llm-inference';

interface GpuDeploySectionProps {
  activeModel: string | null | undefined;
  isLoading: boolean;
  isCheckingStatus: boolean;
  gpuStatus: { is_running: boolean; current_model?: string } | null;
  startModelOnGPU: (modelId: string) => Promise<void>;
  checkGpuStatus: () => Promise<void>;
}

export const GpuDeploySection: React.FC<GpuDeploySectionProps> = ({
  activeModel,
  isLoading,
  isCheckingStatus,
  gpuStatus,
  startModelOnGPU,
  checkGpuStatus,
}) => {
  const { t } = useTranslation();
  const isGpuActive = gpuStatus?.is_running || false;
  const [validatedModel, setValidatedModel] = useState<string | null>(null);
  const [deploymentStatus, setDeploymentStatus] = useState<{
    deployed: boolean;
    model_id?: string;
    status: string;
    message?: string;
  } | null>(null);
  const [isUndeploying, setIsUndeploying] = useState(false);

  // Check deployment status periodically
  useEffect(() => {
    const checkDeploymentStatus = async () => {
      try {
        const status = await getDeploymentStatus();
        setDeploymentStatus(status);
      } catch (error) {
        console.error('Error checking deployment status:', error);
      }
    };

    void checkDeploymentStatus();
    const interval = setInterval(checkDeploymentStatus, 5000); // Check every 5 seconds

    return () => clearInterval(interval);
  }, []);

  useEffect(() => {



    // Attempt to validate and set the effective model
    async function validateActiveModel() {
      // Get the effective active model based on current state
      let effectiveModel = isGpuActive ? gpuStatus?.current_model : activeModel;



      // If no effective model, check localStorage first as it's faster than an API call
      if (!effectiveModel) {
        const storedModel = localStorage.getItem('user-active-model');
        if (storedModel) {

          effectiveModel = storedModel;
        }
      }

      // Update the validated model state

      setValidatedModel(effectiveModel || null);
    }

    void validateActiveModel();
  }, [activeModel, gpuStatus, isGpuActive]);

  // Additional debug information to understand the condition evaluation
  useEffect(() => {
  }, [validatedModel, isGpuActive]);

  // Handle manual undeployment
  const handleUndeploy = async () => {
    if (!deploymentStatus?.model_id) return;

    setIsUndeploying(true);
    try {
      const result = await undeployLocalModel(deploymentStatus.model_id);
      if (result.success) {

        // Refresh deployment status
        const status = await getDeploymentStatus();
        setDeploymentStatus(status);
      } else {
        console.error('Failed to undeploy model:', result.message);
      }
    } catch (error) {
      console.error('Error undeploying model:', error);
    } finally {
      setIsUndeploying(false);
    }
  };

  // Handle refresh with better feedback
  const handleRefresh = async () => {

    await checkGpuStatus();

    // After GPU status check, verify we have a valid model
    if (!validatedModel) {
      try {

        const storedModel = localStorage.getItem('user-active-model');
        if (storedModel) {

          setValidatedModel(storedModel);
          return;
        }

        // No model found yet, try fetching installed models
        const { getInstalledModels } = await import(
          '@/lib/api-llm-inference'
        );
        const installedModels = await getInstalledModels(true);

        if (installedModels && installedModels.length > 0) {
          // Use the first installed model as fallback
          const firstModel = installedModels[0].id;


          // Save to localStorage and state
          localStorage.setItem('user-active-model', firstModel);
          setValidatedModel(firstModel);

        }
      } catch (error) {
        console.error('Error fetching active model after refresh:', error);
      }
    }
  };

  return (
    <div className='space-y-2'>
      {/* Manual Deployment Section */}
      {deploymentStatus?.deployed ? (
        <div className='flex items-center justify-between w-full bg-green-50 dark:bg-green-900/20 rounded-lg p-4 border border-green-200 dark:border-green-800'>
          <div className='flex items-center gap-3'>
            <div className='p-2 bg-green-100 dark:bg-green-800/30 rounded-full'>
              <CheckCircle className='h-5 w-5 text-green-600 dark:text-green-400' />
            </div>
            <div>
              <h4 className='text-sm font-medium text-green-800 dark:text-green-300'>
                {t('settings.localai.deployment.deployed', 'Model Deployed')}
              </h4>
              <p className='text-xs text-green-600 dark:text-green-400 mt-0.5'>
                {deploymentStatus.model_id}
              </p>
            </div>
          </div>

          <div className='flex items-center gap-2'>
            <Button
              variant='destructive'
              size='sm'
              onClick={handleUndeploy}
              disabled={isUndeploying}
              className='bg-red-600 hover:bg-red-700'
              data-testid="settings-gpu-undeploy-button"
            >
              {isUndeploying ? (
                <Loader2 className='h-4 w-4 mr-2 animate-spin' />
              ) : (
                <Square className='h-4 w-4 mr-2' />
              )}
              {t('settings.localai.deployment.undeploy', 'Undeploy')}
            </Button>
          </div>
        </div>
      ) : (
        <>
          {/* Deploy Section */}
          {!isGpuActive && (
            <>
              {!validatedModel || validatedModel === '' ? (
                <div
                  className='flex items-center justify-between w-full bg-blue-50 dark:bg-blue-900/20 rounded-b-lg p-4 
                  border border-blue-200 dark:border-blue-800'
                >
                  <div className='flex items-center gap-3'>
                    <div className='p-2 bg-blue-100 dark:bg-blue-800/30 rounded-full'>
                      <Cpu className='h-5 w-5 text-blue-600 dark:text-blue-400' />
                    </div>
                    <div>
                      <h4 className='text-sm font-medium text-blue-800 dark:text-blue-300'>
                        {t(
                          'settings.localai.gpu.noModelSelected',
                          'No Active Model'
                        )}
                      </h4>
                      <p className='text-xs text-blue-600 dark:text-blue-400 mt-0.5'>
                        {t(
                          'settings.localai.gpu.selectModelFirst',
                          'Please select a model from Installed Models'
                        )}
                      </p>
                    </div>
                  </div>

                  <Button
                    variant='outline'
                    size='sm'
                    onClick={handleRefresh}
                    disabled={isCheckingStatus}
                    className='bg-blue-100 hover:bg-blue-200 dark:bg-blue-800/30 dark:hover:bg-blue-700/40 border-blue-200 dark:border-blue-700 text-blue-700 dark:text-blue-300'
                    data-testid="settings-gpu-refresh-button"
                  >
                    {isCheckingStatus ? (
                      <Loader2 className='h-4 w-4 mr-1 animate-spin' />
                    ) : (
                      <RefreshCw className='h-4 w-4 mr-1' />
                    )}
                    {t('settings.localai.gpu.refresh', 'Refresh')}
                  </Button>
                </div>
              ) : (
                <div className='space-y-2'>
                  {/* GPU Acceleration (existing functionality) */}
                  <div className='flex items-center justify-between w-full bg-white dark:bg-zinc-950 rounded-lg p-4 border border-zinc-200 dark:border-zinc-800'>
                    <div className='flex items-center gap-3'>
                      <div className='p-2 bg-zinc-100 dark:bg-zinc-800 rounded-full'>
                        <Zap className='h-5 w-5 text-amber-500 dark:text-amber-400' />
                      </div>
                      <div>
                        <h4 className='text-sm font-medium text-zinc-800 dark:text-zinc-200'>
                          {t(
                            'settings.localai.gpu.modelAcceleration',
                            'GPU Acceleration'
                          )}
                        </h4>
                        <p className='text-xs text-zinc-600 dark:text-zinc-400 mt-0.5'>
                          {validatedModel}
                        </p>
                      </div>
                    </div>

                    <Button
                      onClick={() => startModelOnGPU(validatedModel)}
                      className='bg-amber-500 hover:bg-amber-600 text-white'
                      size='sm'
                      disabled={isLoading || !validatedModel}
                      data-testid="settings-gpu-deploy-button"
                    >
                      {isLoading ? (
                        <Loader2 className='h-4 w-4 mr-2 animate-spin' />
                      ) : (
                        <Laptop className='h-4 w-4 mr-2' />
                      )}
                      {t('settings.localai.gpu.deployToGpu', 'Deploy to GPU')}
                    </Button>
                  </div>
                </div>
              )}
            </>
          )}
        </>
      )}
    </div>
  );
};

// Component for manual deployment and GPU acceleration of local models
