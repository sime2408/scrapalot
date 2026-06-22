import { useState, useEffect } from 'react';
import { isDesktopMode, getElectronAPI, openExternal as electronOpenExternal, showInFolder as electronShowInFolder } from '@/lib/electron-api';

/**
 * Hook to detect and interact with desktop mode (Electron).
 *
 * Provides:
 * - Desktop mode detection
 * - External link opening
 * - File system operations (desktop only)
 */
export function useDesktopMode() {
  const [isDesktop, setIsDesktop] = useState(false);

  useEffect(() => {
    setIsDesktop(isDesktopMode());
  }, []);

  return {
    /**
     * True if running in Electron desktop app
     */
    isDesktop,

    /**
     * Open a URL in the default external browser
     */
    openExternal: async (url: string) => {
      await electronOpenExternal(url);
    },

    /**
     * Show a file/folder in the system file explorer (desktop only)
     */
    showInFolder: (path: string) => {
      electronShowInFolder(path);
    },

    /**
     * Get the Electron API if available
     */
    electronAPI: isDesktop ? getElectronAPI() : null,
  };
}
