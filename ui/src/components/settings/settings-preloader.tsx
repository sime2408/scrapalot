import React, { useEffect, useState, useContext } from 'react';
import { useTheme } from '@/providers/theme-provider';
import { getUserSettings } from '@/lib/api-settings';
import { AuthContext, applyLocaleFromGeneralSettings } from '@/contexts/auth-context';
import {
  getSystemCapabilities,
  getInstalledModels,
} from '@/lib/api-llm-inference';
import { useProviders } from '@/hooks/useProviders';

/**
 * This component preloads user settings after login and applies them
 * without blocking the UI. It runs in the background when the user is authenticated.
 */
export const SettingsPreloader: React.FC = () => {
  // Use useContext directly to avoid the error thrown by useAuth
  const authContext = useContext(AuthContext);

  const isAuthenticated = authContext?.isAuthenticated ?? false;
  const isLoading = authContext?.isLoading ?? true;

  const { setTheme, setAccentColor } = useTheme();
  const { providers, loading: providersLoading, fetchInProgress } = useProviders();
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const [modelsPreloaded, setModelsPreloaded] = useState(false);
  const [providersPreloaded, setProvidersPreloaded] = useState(false);

  // Add error boundary protection
  const [hasError, setHasError] = useState(false);

  // Reset error state when auth changes
  React.useEffect(() => {
    setHasError(false);
  }, [isAuthenticated]);

  // Preload model data in the background
  useEffect(() => {
    if (!authContext || !isAuthenticated || isLoading || modelsPreloaded || hasError) {
      return;
    }

    let isMounted = true;

    const preloadModelData = async () => {
      try {
        // Preload in sequence to respect any caching mechanisms
        await getSystemCapabilities();
        if (!isMounted) return;

        // Note: getFeaturedModels() is NOT preloaded here - it's loaded on-demand
        // when the user opens the Local AI settings tab to avoid unnecessary
        // HuggingFace API calls on every login

        await getInstalledModels();
        if (!isMounted) return;

        setModelsPreloaded(true);
      } catch (error) {
        console.error('Failed to preload model data:', error);
        // Mark as completed anyway to avoid retries
        if (isMounted) {
          setModelsPreloaded(true);
          setHasError(true);
        }
      }
    };

    void preloadModelData();

    return () => {
      isMounted = false;
    };
  }, [authContext, isAuthenticated, isLoading, modelsPreloaded, hasError]);

  // Subscribe to providers data loading state
  useEffect(() => {
    if (!authContext || !isAuthenticated || isLoading || providersPreloaded || hasError) {
      return;
    }

    // If providers are already loaded or loading is complete, mark as preloaded
    if (providers.length > 0 || (!providersLoading && !fetchInProgress)) {
      setProvidersPreloaded(true);

      // Dispatch an event to notify components that providers are loaded
      document.dispatchEvent(new CustomEvent('providers-preloaded'));
      return;
    }

    // If fetch is in progress, wait for it to complete
  }, [authContext, isAuthenticated, isLoading, providersPreloaded, providers.length, providersLoading, fetchInProgress, hasError]);

  useEffect(() => {
    // Skip if not authenticated or settings already loaded
    if (!authContext || !isAuthenticated || isLoading || settingsLoaded || hasError) {
      return;
    }

    let isMounted = true;

    const loadSettings = async () => {
      try {
        const settings = await getUserSettings();

        if (!isMounted) return;

        // getUserSettings now returns general settings directly (not wrapped in .general)
        const general = settings || {};

        // Apply the user's saved UI language from the backend. This runs on
        // EVERY authenticated load (unlike loadUserSettingsInBackground, which
        // only fires on explicit login), so it's the path that fixes language
        // after an impersonation reload: impersonation forces i18nextLng to a
        // neutral default, and without this the impersonated user's saved
        // language (e.g. Croatian) never took effect. applyLocaleFromGeneralSettings
        // expects a [_, general] tuple and no-ops when the language already matches.
        await applyLocaleFromGeneralSettings([null, general]);

        const themeChanged = sessionStorage.getItem('themeChangedThisSession');
        const theme = general.appearance || general.theme;
        if (!themeChanged && theme) {
          setTheme(theme);
        }
        // If theme was changed this session, skip applying backend value

        // Apply accent color from the backend to the UI
        const accentColor = general.accent_color || general.theme_accent;
        if (
          accentColor &&
          ['gray', 'blue', 'green', 'red', 'violet', 'orange'].includes(
            accentColor
          )
        ) {
          // Check if we should skip applying backend accent color to preserve anonymous settings
          const justLoggedIn = sessionStorage.getItem('just_logged_in');
          const modelsJustPreloaded = sessionStorage.getItem('models_preloaded');

          // Skip if just logged in OR if models were just preloaded (indicates recent login)
          if (justLoggedIn || modelsJustPreloaded) {
            // Use the unified getCurrentAccentColor function to get the correct color
            try {
              const { userPrefs } = await import('@/lib/storage-utils');
              const currentAccentColor = userPrefs.getCurrentAccentColor();

              if (currentAccentColor && currentAccentColor !== accentColor) {
                setAccentColor(currentAccentColor as 'gray' | 'blue' | 'green' | 'red' | 'violet' | 'orange');
                return;
              }
            } catch (error) {
              console.warn('Error getting current accent color:', error);
            }
          } else {
            setAccentColor(accentColor as 'gray' | 'blue' | 'green' | 'red' | 'violet' | 'orange');
          }
        }

        // Mark settings as loaded
        if (isMounted) {
          setSettingsLoaded(true);
        }
      } catch (error) {
        console.error('Failed to preload user settings:', error);
        // Don't retry if there's an error
        if (isMounted) {
          setSettingsLoaded(true);
          setHasError(true);
        }
      }
    };

    // Start loading settings
    void loadSettings();

    return () => {
      isMounted = false;
    };
  }, [authContext, isAuthenticated, isLoading, settingsLoaded, setTheme, setAccentColor, hasError]);

  // This component doesn't render anything
  return null;
};
