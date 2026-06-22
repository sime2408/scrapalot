import { useEffect, useState, useCallback } from 'react';
import { ModelSettings } from '@/types';
import { getModelSettings } from '@/lib/api-settings';
import { useAuth } from '@/hooks/use-auth';

interface ModelSettingsCache {
  [sessionId: string]: ModelSettings;
}

interface UseModelSettingsPreloadReturn {
  modelSettings: ModelSettings | null;
  isLoading: boolean;
  error: string | null;
  preloadSettings: (sessionId?: string) => Promise<void>;
  clearCache: () => void;
}

const DEFAULT_MODEL_SETTINGS: ModelSettings = {
  temperature: 0.1,
  maxOutputTokens: 8000,
  topP: 0.9,
  topK: 40,
  frequencyPenalty: 0.5,
  presencePenalty: 0.5,
  contextWindowSize: 256000,
  contextMessageLimit: 30,
  gpuLayers: -1,
  modelInstructions: 'You are a helpful assistant.',
};

let settingsCache: ModelSettingsCache = {};
let globalSettings: ModelSettings | null = null;

export function useModelSettingsPreload(): UseModelSettingsPreloadReturn {
  const [modelSettings, setModelSettings] = useState<ModelSettings | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { isAuthenticated, authReady } = useAuth();

  const preloadSettings = useCallback(async (sessionId?: string) => {
    if (!authReady || !isAuthenticated) {
      setModelSettings(DEFAULT_MODEL_SETTINGS);
      return;
    }

    const cacheKey = sessionId || 'global';
    
    // Return cached settings if available
    if (settingsCache[cacheKey]) {
      setModelSettings(settingsCache[cacheKey]);
      return;
    }

    // Return global settings if no sessionId and global settings are cached
    if (!sessionId && globalSettings) {
      setModelSettings(globalSettings);
      return;
    }

    setIsLoading(true);
    setError(null);

    try {
      const settings = await getModelSettings(sessionId);
      
      // Convert backend format to frontend format
      const formattedSettings: ModelSettings = {
        temperature: settings.temperature || 0.1,
        maxOutputTokens: settings.max_output_tokens || settings.maxOutputTokens || 8000,
        topP: settings.top_p || settings.topP || 0.9,
        topK: settings.top_k || settings.topK || 40,
        frequencyPenalty: settings.frequency_penalty || settings.frequencyPenalty || 0.5,
        presencePenalty: settings.presence_penalty || settings.presencePenalty || 0.5,
        contextWindowSize: settings.context_window_size || settings.contextWindowSize || 256000,
        contextMessageLimit: settings.context_message_limit || settings.contextMessageLimit || 30,
        gpuLayers: settings.gpu_layers || settings.gpuLayers || -1,
        modelInstructions: settings.model_instructions || settings.modelInstructions || 'You are a helpful assistant.',
        extraModelParameters: settings.extra_model_parameters || settings.extraModelParameters || '',
      };

      // Cache the settings
      settingsCache[cacheKey] = formattedSettings;
      
      // Store as global settings if no sessionId
      if (!sessionId) {
        globalSettings = formattedSettings;
      }

      setModelSettings(formattedSettings);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Failed to load model settings';
      console.error('Error preloading model settings:', err);
      setError(errorMessage);
      // Fallback to default settings on error
      setModelSettings(DEFAULT_MODEL_SETTINGS);
    } finally {
      setIsLoading(false);
    }
  }, [authReady, isAuthenticated]);

  const clearCache = useCallback(() => {
    settingsCache = {};
    globalSettings = null;
    setModelSettings(null);
    setError(null);
  }, []);

  // Preload global settings when component mounts and user is authenticated
  useEffect(() => {
    if (authReady && isAuthenticated && !globalSettings) {
      void preloadSettings();
    } else if (authReady && !isAuthenticated) {
      setModelSettings(DEFAULT_MODEL_SETTINGS);
    }
  }, [authReady, isAuthenticated, preloadSettings]);

  return {
    modelSettings,
    isLoading,
    error,
    preloadSettings,
    clearCache,
  };
}