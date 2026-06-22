/**
 * Navigation Utility
 *
 * Provides cross-environment navigation that works in both
 * browser mode (BrowserRouter) and Electron mode (HashRouter).
 *
 * In Electron mode with file:// protocol, we must use hash-based navigation
 * because the browser can't resolve routes like file:///C:/login
 */

import { isDesktopMode } from '@/lib/electron-api';

/**
 * Routes that render for unauthenticated visitors. A 401 on one of these
 * must NOT trigger token refresh or a "session expired" redirect — there
 * is no session to expire. Invited users (/invite?token=…) and shared
 * conversation viewers (/shared/:token) are unauthenticated by design;
 * leaving them out of this list bounced them to /login mid-flow.
 *
 * This is the single source of truth — api.ts (401 interceptor +
 * showSessionExpiredAndRedirect) and auth-context.tsx all consume it, so
 * the allowlist can no longer drift out of sync between call sites.
 */
const PUBLIC_PATHS: ReadonlySet<string> = new Set([
  '/', '/home', '/shop', '/about', '/pricing', '/buy-license',
  '/login', '/sign-up', '/desktop', '/contact', '/invite',
  '/privacy', '/delete-account',
]);

/** Dynamic public routes matched by prefix (e.g. /shared/:shareToken). */
const PUBLIC_PATH_PREFIXES: readonly string[] = ['/shared/'];

/**
 * True when the given pathname is a public, unauthenticated route.
 * Defaults to the current location when no argument is passed.
 */
export function isPublicRoute(
  pathname: string = typeof window !== 'undefined' ? window.location.pathname : ''
): boolean {
  return (
    PUBLIC_PATHS.has(pathname) ||
    PUBLIC_PATH_PREFIXES.some(prefix => pathname.startsWith(prefix))
  );
}

/**
 * Navigate to a route, handling both browser and Electron environments.
 * In desktop mode, uses hash-based navigation to work with HashRouter.
 * In browser mode, uses standard location.href navigation.
 *
 * @param path - The route path to navigate to (e.g., '/login', '/dashboard')
 * @param replace - If true, replaces current history entry instead of pushing
 */
export function navigateTo(path: string, replace: boolean = false): void {
  if (isDesktopMode()) {
    // In Electron/desktop mode, use hash-based navigation
    // This works with HashRouter and file:// protocol
    if (replace) {
      window.location.replace(`#${path}`);
    } else {
      window.location.hash = path;
    }
  } else {
    // In browser mode, use standard navigation
    // This works with BrowserRouter
    if (replace) {
      window.location.replace(path);
    } else {
      window.location.href = path;
    }
  }
}

/**
 * Navigate to the login page.
 * Use this instead of window.location.href = '/login'
 */
export function navigateToLogin(): void {
  // In desktop mode, don't navigate to login - the app should auto-login
  if (isDesktopMode()) {
    console.log('[Navigation] Desktop mode detected, skipping login redirect');
    // Just set hash to dashboard - DesktopAutoLogin will handle auth
    window.location.hash = '/dashboard';
    return;
  }

  navigateTo('/login');
}

