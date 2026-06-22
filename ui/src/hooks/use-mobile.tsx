import { useSyncExternalStore } from 'react';

// Modern mobile-first breakpoint system for current devices
const MOBILE_BREAKPOINT = 1080;     // Below 1080px = mobile (includes phones up to 1080px)
const TABLET_BREAKPOINT = 1200;     // 1080px - 1199px = tablet (medium)
const WIDE_DESKTOP_BREAKPOINT = 1400; // 1400px+ = wide desktop (extra large)

// Shared matchMedia listener cache — avoids creating duplicate listeners for the same query
const mediaQueryCache = new Map<string, { mql: MediaQueryList; listeners: Set<() => void> }>();

function subscribeToMediaQuery(query: string, callback: () => void) {
  let entry = mediaQueryCache.get(query);
  if (!entry) {
    const mql = window.matchMedia(query);
    const listeners = new Set<() => void>();
    const handler = () => listeners.forEach(fn => fn());
    mql.addEventListener('change', handler);
    entry = { mql, listeners };
    mediaQueryCache.set(query, entry);
  }
  entry.listeners.add(callback);
  return () => {
    entry!.listeners.delete(callback);
  };
}

function getMediaQuerySnapshot(query: string): boolean {
  const entry = mediaQueryCache.get(query);
  if (entry) return entry.mql.matches;
  return window.matchMedia(query).matches;
}

function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (cb) => subscribeToMediaQuery(query, cb),
    () => getMediaQuerySnapshot(query),
    () => false // SSR fallback
  );
}

export function useIsMobile() {
  return useMediaQuery(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`);
}

export function useIsTablet() {
  return useMediaQuery(`(min-width: ${MOBILE_BREAKPOINT}px) and (max-width: ${TABLET_BREAKPOINT - 1}px)`);
}

// Legacy function for backward compatibility
export function useIsTabletPortrait() {
  return useIsTablet();
}

// Combined hook that treats tablet as mobile for UI purposes
export function useIsMobileOrTabletPortrait() {
  return useMediaQuery(`(max-width: ${TABLET_BREAKPOINT - 1}px)`);
}

// Hook for mobile phones only (excludes tablet) - for fullscreen dialogs
export function useIsMobilePhone() {
  return useMediaQuery(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`);
}

// Hook to detect screens smaller than 1400px for sidebar layout
export function useIsSmallScreen() {
  return useMediaQuery(`(max-width: ${WIDE_DESKTOP_BREAKPOINT - 1}px)`);
}

// Hook to detect screens smaller than 1200px (mobile + tablet) for fullscreen dialogs
export function useIsNarrowScreen() {
  return useMediaQuery(`(max-width: ${TABLET_BREAKPOINT - 1}px)`);
}

// Bootstrap-based responsive hooks
export function useIsExtraSmall() {
  return useMediaQuery('(max-width: 575px)');
}

export function useIsSmallOnly() {
  return useMediaQuery('(min-width: 576px) and (max-width: 767px)');
}

export function useIsMediumOnly() {
  return useMediaQuery(`(min-width: 768px) and (max-width: ${MOBILE_BREAKPOINT - 1}px)`);
}

export function useIsLargeOnly() {
  return useMediaQuery(`(min-width: ${MOBILE_BREAKPOINT}px) and (max-width: ${TABLET_BREAKPOINT - 1}px)`);
}

export function useIsExtraLarge() {
  return useMediaQuery('(min-width: 1200px)');
}
