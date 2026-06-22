import React, {
  createContext,
  useContext,
  useEffect,
  useState,
  useCallback,
} from 'react';
import { saveGeneralSettings } from '@/lib/api-settings';
import { userPrefs } from '@/lib/storage-utils';
import { syncNativeSystemBars } from '@/lib/native-app';

type Theme = 'dark' | 'light' | 'system';
type AccentColor = 'gray' | 'blue' | 'green' | 'red' | 'violet' | 'orange';

interface ThemeProviderProps {
  children: React.ReactNode;
  defaultTheme?: Theme;
  defaultAccentColor?: AccentColor;
}

interface ThemeProviderState {
  theme: Theme;
  accentColor: AccentColor;
  setTheme: (theme: Theme) => void;
  setAccentColor: (color: AccentColor) => void;
  toggleTheme: () => void;
}

const ThemeProviderContext = createContext<ThemeProviderState>({
  theme: 'dark',
  accentColor: 'blue',
  setTheme: () => null,
  setAccentColor: () => null,
  toggleTheme: () => null,
});

// Prevent multiple simultaneous save operations
let saveTimer: NodeJS.Timeout | null = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- type is dynamic
let lastSaveSettings: any = null;

const safelyUpdateBackendSettings = async (
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- type is dynamic
  themeSettings: any,
  isInitializing: boolean = false
) => {
  // Don't save during initialization to prevent overwriting user settings
  if (isInitializing) {
    return;
  }

  // Check if a user has valid (non-expired) authentication tokens before attempting to save to backend
  const { hasValidAuthTokens } = await import('@/lib/auth');
  if (!hasValidAuthTokens()) {
    return;
  }

  // Prevent saves during login migration period
  const justLoggedIn = sessionStorage.getItem('just_logged_in');
  if (justLoggedIn) {
    return;
  }

  // Prevent duplicate saves with identical settings
  if (JSON.stringify(lastSaveSettings) === JSON.stringify(themeSettings)) {
    return;
  }

  lastSaveSettings = { ...themeSettings };

  if (saveTimer) {
    clearTimeout(saveTimer);
  }

  saveTimer = setTimeout(async () => {
    try {
      const { getGeneralSettings, saveGeneralSettings } = await import(
        '@/lib/api-settings'
      );

      // Check if we just logged in - if so, don't merge with database settings
      // to avoid overwriting anonymous accent color migration
      const justLoggedIn = sessionStorage.getItem('just_logged_in');
      let mergedSettings;

      if (justLoggedIn) {
        // During login, only save the current theme settings without merging database values
        mergedSettings = themeSettings;
      } else {
        // Normal operation - get existing settings to merge with new ones
        const existingSettings = await getGeneralSettings();
        // Merge settings, prioritizing new theme settings
        mergedSettings = { ...existingSettings, ...themeSettings };
      }
      // Save to backend
      saveGeneralSettings(mergedSettings)
        .then(_response => {
        })
        .catch(error => {
          // Only warn if it's not an authentication error (401)
          if (!error?.response || error.response.status !== 401) {
            console.warn('Error saving theme settings to backend:', error);
          }
        });
    } catch (error) {
      console.warn('Error saving theme settings:', error);
    } finally {
      saveTimer = null;
      lastSaveSettings = null;
    }
  }, 300); // Increased delay to better debounce multiple rapid calls
};

export function ThemeProvider({
  children,
  defaultTheme = 'dark',
  defaultAccentColor = 'blue',
}: ThemeProviderProps) {
  const [isInitializing, setIsInitializing] = useState(true);
  const [hasUserInteracted, setHasUserInteracted] = useState(false);
  const [theme, setTheme] = useState<Theme>(() => {
    if (typeof window !== 'undefined') {
      try {
        // Use consolidated storage
        const consolidatedTheme = userPrefs.getTheme();
        if (
          consolidatedTheme &&
          ['light', 'dark', 'system'].includes(consolidatedTheme)
        ) {
          return consolidatedTheme as Theme;
        }
      } catch (e) {
        console.warn('Error initializing theme:', e);
      }
    }
    return defaultTheme;
  });

  const [accentColor, setAccentColor] = useState<AccentColor>(() => {
    if (typeof window !== 'undefined') {
      try {
        // First check for preserved accent color from login
        const preservedAccent = sessionStorage.getItem('preserved_accent');
        if (
          preservedAccent &&
          ['gray', 'blue', 'green', 'red', 'violet', 'orange'].includes(
            preservedAccent
          )
        ) {
          return preservedAccent as AccentColor;
        }

        // Use unified accent color management (always uses accentColor field)
        const currentAccent = userPrefs.getCurrentAccentColor();
        if (
          currentAccent &&
          ['gray', 'blue', 'green', 'red', 'violet', 'orange'].includes(
            currentAccent
          )
        ) {
          return currentAccent as AccentColor;
        }
      } catch (e) {
        console.error('ThemeProvider init - Error reading accent color:', e);
      }
    }
    return defaultAccentColor;
  });

  // Debounced save function to avoid too many API calls
  const debouncedSaveSettings = useCallback(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- type is dynamic
    (settings: any) => {
      // Only save if user has actually interacted with theme settings
      if (hasUserInteracted) {
        void safelyUpdateBackendSettings(settings, isInitializing);
      }
    },
    [isInitializing, hasUserInteracted]
  );

  // Apply theme immediately during initialization to prevent white page
  const applyThemeToDOM = (themeToApply: Theme, accentToApply: AccentColor) => {
    const root = window.document.documentElement;
    // Ensure we always have a theme class to prevent white page
    root.classList.remove('light', 'dark');

    let appliedTheme: string;
    if (themeToApply === 'system') {
      appliedTheme = window.matchMedia('(prefers-color-scheme: dark)').matches
        ? 'dark'
        : 'light';
    } else {
      appliedTheme = themeToApply;
    }

    root.classList.add(appliedTheme);
    root.dataset.theme = appliedTheme;

    // Apply accent color
    root.dataset.accent = accentToApply;

    // Force a style recalculation to ensure CSS variables are applied
    root.style.display = 'none';
    void root.offsetHeight; // Trigger reflow
    root.style.display = '';

    // Android app: repaint the system-bar strips (status + navigation bar)
    // with the new theme's background so they never mismatch the app. No-op
    // on the regular web.
    syncNativeSystemBars(appliedTheme === 'dark');
  };

  // Apply theme immediately on mount and when values change
  useEffect(() => {
    if (typeof window !== 'undefined') {
      applyThemeToDOM(theme, accentColor);
    }
  }, [theme, accentColor]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    // Use consolidated storage - this will automatically handle legacy storage sync
    userPrefs.setTheme(theme);
  }, [theme]);

  // Effect to handle preserved accent color from sessionStorage after login
  useEffect(() => {
    if (typeof window === 'undefined') return;

    const preservedAccent = sessionStorage.getItem('preserved_accent');
    if (
      preservedAccent &&
      ['gray', 'blue', 'green', 'red', 'violet', 'orange'].includes(
        preservedAccent
      )
    ) {

      setAccentColor(preservedAccent as AccentColor);
      // Clear the preserved accent after restoring it
      sessionStorage.removeItem('preserved_accent');
    }
  }, []);

  // Effect to handle immediate backend sync on login
  useEffect(() => {
    if (typeof window === 'undefined') return;

    const justLoggedIn = sessionStorage.getItem('just_logged_in');
    if (justLoggedIn && !isInitializing) {
      // Get current accent color and sync to backend
      const currentAccent = userPrefs.getCurrentAccentColor();
      if (
        currentAccent &&
        ['gray', 'blue', 'green', 'red', 'violet', 'orange'].includes(
          currentAccent
        )
      ) {
        // Force immediate backend sync for login
        void safelyUpdateBackendSettings(
          {
            appearance: theme,
            accentColor: currentAccent,
          },
          false
        ); // isInitializing = false to force save
      }
    }
  }, [isInitializing, theme]);

  // Mark initialization as complete after initial setup and settings preloader
  useEffect(() => {
    const timer = setTimeout(() => {
      setIsInitializing(false);
    }, 3000); // Allow 3 seconds for initial setup and settings preloader to complete

    return () => clearTimeout(timer);
  }, []);

  // Effect to sync accent color to localStorage only (no backend calls to prevent loops)
  useEffect(() => {
    if (typeof window === 'undefined') return;

    // Don't sync during initialization to prevent overriding preserved colors
    if (isInitializing) {
      return;
    }

    // Only sync if user has actually interacted to prevent overriding preserved colors
    if (!hasUserInteracted) {
      return;
    }
    // Direct localStorage sync without backend calls to prevent infinite loops
    try {
      userPrefs.setAccentColor(accentColor);
    } catch (error) {
      console.warn('Failed to sync accent color to localStorage:', error);
    }
  }, [accentColor, isInitializing, hasUserInteracted]);

  const handleSetTheme = (newTheme: Theme) => {
    setTheme(newTheme);
    setHasUserInteracted(true); // Mark that user has interacted
    try {
      sessionStorage.setItem('themeChangedThisSession', '1');
    } catch (e) { /* sessionStorage may be unavailable in private browsing */ }

    // Only save to backend if not initializing
    if (!isInitializing) {
      debouncedSaveSettings({
        appearance: newTheme,
        accentColor: accentColor,
      });
    } else {
      // Still initializing; skip saving to backend
    }
  };

  const handleToggleTheme = () => {
    const newTheme = theme === 'dark' ? 'light' : 'dark';

    handleSetTheme(newTheme);
  };

  const handleSetAccentColor = (newColor: AccentColor) => {
    // Prevent setting the same color to avoid unnecessary updates
    if (newColor === accentColor) {

      return;
    }

    setAccentColor(newColor);
    setHasUserInteracted(true); // Mark that user has interacted

    // Direct localStorage sync without backend calls to prevent infinite loops
    try {
      userPrefs.setAccentColor(newColor);
    } catch (error) {
      console.warn('Failed to sync accent color to localStorage:', error);
    }

    // Only save to backend if not initializing
    if (!isInitializing) {
      debouncedSaveSettings({
        appearance: theme,
        accentColor: newColor,
      });
    } else {
      // Still initializing; skip saving to backend
    }
  };

  const value = {
    theme,
    accentColor,
    setTheme: handleSetTheme,
    setAccentColor: handleSetAccentColor,
    toggleTheme: handleToggleTheme,
  };

  return (
    <ThemeProviderContext.Provider value={value}>
      {children}
    </ThemeProviderContext.Provider>
  );
}

// eslint-disable-next-line react-refresh/only-export-components -- co-located with component for cohesion
export const useTheme = () => {
  const context = useContext(ThemeProviderContext);

  if (context === undefined)
    throw new Error('useTheme must be used within a ThemeProvider');

  return context;
};
