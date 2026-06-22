import { useEffect, useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { isDesktopMode } from '@/lib/electron-api';
import { initializeDesktopAuth, isDesktopAuthInitialized, isDesktopCloudMode, isCloudMode } from '@/lib/desktop-auth';
import { useAuth } from '@/hooks/use-auth';

/**
 * Desktop Auto-Login Component
 *
 * Handles automatic authentication and routing for desktop mode.
 * - In local mode: Auto-authenticates with local backend
 * - In cloud mode: Redirects to login page for user authentication
 */
export function DesktopAutoLogin() {
  const navigate = useNavigate();
  const location = useLocation();
  const { login } = useAuth();
  const [isInitializing, setIsInitializing] = useState(false);

  useEffect(() => {
    const handleDesktopAutoLogin = async () => {
      // Only run in desktop mode
      if (!isDesktopMode()) {
        return;
      }

      // Prevent re-initialization
      if (isInitializing) {
        return;
      }

      const currentPath = location.pathname;

      // Public routes that should trigger desktop auth initialization
      const publicRoutes = [
        '/home',
        '/about',
        '/pricing',
        '/buy-license',
        '/shop',
        '/desktop',
        '/sign-up',
        '/',
      ];

      // Don't redirect if already on login page in cloud mode
      if (currentPath === '/login' && isCloudMode()) {
        console.log('[Desktop Auto-Login] Already on login page in cloud mode, skipping');
        return;
      }

      // If we're on a public route, initialize auth and redirect
      if (publicRoutes.includes(currentPath) || currentPath === '/login') {
        console.log('[Desktop Auto-Login] On public route, initializing desktop auth...');

        try {
          setIsInitializing(true);

          // Check if already initialized
          if (!isDesktopAuthInitialized()) {
            console.log('[Desktop Auto-Login] Initializing desktop authentication...');

            const authData = await initializeDesktopAuth();

            if (authData) {
              console.log('[Desktop Auto-Login] Desktop auth successful, logging in...');

              // Update auth context with desktop user (local mode only)
              void login(authData.user, {
                access_token: authData.access_token,
                refresh_token: authData.refresh_token,
                token_type: authData.token_type,
              });

              // Redirect to dashboard after successful local auth
              console.log('[Desktop Auto-Login] Redirecting to dashboard...');
              navigate('/dashboard', { replace: true });
            } else {
              // In cloud mode, initializeDesktopAuth returns null but sets the flag
              // Check if we're now in cloud mode
              if (isDesktopCloudMode() || isCloudMode()) {
                console.log('[Desktop Auto-Login] Cloud mode - redirecting to login page');
                // In cloud mode, redirect to login page for user to authenticate
                navigate('/login', { replace: true });
              } else {
                console.error('[Desktop Auto-Login] Failed to initialize desktop auth');
                console.error('[Desktop Auto-Login] Please ensure the Scrapalot backend is running');
              }
            }
          } else {
            console.log('[Desktop Auto-Login] Desktop auth already initialized');

            // If in cloud mode, redirect to login for user authentication
            if (isDesktopCloudMode() || isCloudMode()) {
              console.log('[Desktop Auto-Login] Cloud mode - redirecting to login page');
              navigate('/login', { replace: true });
            } else {
              // Local mode - redirect to dashboard
              console.log('[Desktop Auto-Login] Local mode - redirecting to dashboard');
              navigate('/dashboard', { replace: true });
            }
          }

        } catch (error) {
          console.error('[Desktop Auto-Login] Error during auto-login:', error);
        } finally {
          setIsInitializing(false);
        }
      }
    };

    void handleDesktopAutoLogin();
  }, [location.pathname, navigate, login, isInitializing]);

  // This component doesn't render anything
  return null;
}
