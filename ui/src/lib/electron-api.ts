/**
 * Electron API Wrapper
 *
 * Provides a type-safe interface to Electron APIs exposed via the preload script.
 * This file should be used by the renderer process to interact with Electron functionality.
 */

export interface ElectronAPI {
  platform: string;
  isDesktopMode: () => boolean;
  getDesktopApiKey: () => Promise<string>;
  getMachineId: () => Promise<string>;
  getMachineName: () => Promise<string>;
  openExternal: (url: string) => Promise<void>;
  showInFolder: (path: string) => void;
  openPath: (path: string) => Promise<string>;
  getAppVersion: () => Promise<string>;
  getDataDirectory: () => Promise<string>;
  onUpdateAvailable: (callback: (info: Record<string, unknown>) => void) => void;
  onUpdateDownloaded: (callback: (info: Record<string, unknown>) => void) => void;
  installUpdate: () => void;
  minimizeWindow: () => void;
  maximizeWindow: () => void;
  closeWindow: () => void;
}

/**
 * Check if running in desktop mode (Electron environment).
 */
export function isDesktopMode(): boolean {
  return typeof window !== 'undefined' && 'electronAPI' in window;
}

/**
 * Get the Electron API if available.
 * Returns null if not running in desktop mode.
 */
export function getElectronAPI(): ElectronAPI | null {
  if (isDesktopMode()) {
    return (window as unknown as { electronAPI: ElectronAPI }).electronAPI;
  }
  return null;
}

/**
 * Get the desktop API key for authenticating with the local backend.
 * Only available in desktop mode.
 */
export async function getDesktopApiKey(): Promise<string | null> {
  const api = getElectronAPI();
  if (api) {
    try {
      return await api.getDesktopApiKey();
    } catch (error) {
      console.error('Failed to get desktop API key:', error);
      return null;
    }
  }
  return null;
}

/**
 * Get a unique machine ID for this desktop installation.
 * Used for cloud desktop authentication.
 * Only available in desktop mode.
 */
export async function getMachineId(): Promise<string | null> {
  const api = getElectronAPI();
  if (api && api.getMachineId) {
    try {
      return await api.getMachineId();
    } catch (error) {
      console.error('Failed to get machine ID:', error);
      return null;
    }
  }
  return null;
}

/**
 * Get the machine name (Windows username or hostname).
 * Used as a human-readable identifier for cloud desktop users.
 * Only available in desktop mode.
 */
export async function getMachineName(): Promise<string | null> {
  const api = getElectronAPI();
  if (api && api.getMachineName) {
    try {
      return await api.getMachineName();
    } catch (error) {
      console.error('Failed to get machine name:', error);
      return null;
    }
  }
  return null;
}

/**
 * Open a URL in the default external browser.
 * In desktop mode, this opens the system browser.
 * In web mode, this is a no-op (links should use normal anchor tags).
 */
export async function openExternal(url: string): Promise<void> {
  const api = getElectronAPI();
  if (api) {
    await api.openExternal(url);
  } else {
    // In web mode, just open in new tab
    window.open(url, '_blank', 'noopener,noreferrer');
  }
}

/**
 * Show a file in the system file explorer.
 * Only available in desktop mode.
 */
export function showInFolder(path: string): void {
  const api = getElectronAPI();
  if (api) {
    api.showInFolder(path);
  }
}

