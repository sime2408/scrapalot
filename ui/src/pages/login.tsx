import React, { useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '@/hooks/use-auth';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { useTranslation } from 'react-i18next';
import { toast } from '@/lib/toast-compat';
import { useTheme } from '@/providers/theme-provider';
import { userPrefs } from '@/lib/storage-utils';
import SharedHeader from '@/components/shared/header';
import { AuroraBackground } from '@/components/landing';
import { API_BASE_URL } from '@/lib/api';
import { isNativeApp, nativeGoogleSignIn } from '@/lib/native-app';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';

// Add a style block for autofill-specific styles
const autofillStyles = {
  // Override WebKit browsers autofill style
  WebkitBoxShadow: '0 0 0 30px rgb(24, 28, 40) inset', // deep ink surface
  WebkitTextFillColor: 'rgb(212, 212, 216)', // dark text for dark mode
  caretColor: 'rgb(212, 212, 216)', // Cursor color
  transition: 'background-color 5000s ease-in-out 0s', // Slow transition to keep the styling
};

// Light mode autofill style
const lightAutofillStyles = {
  WebkitBoxShadow: '0 0 0 30px rgb(249, 250, 251) inset', // bg-gray-50 equivalent
  WebkitTextFillColor: 'rgb(17, 24, 39)', // text-gray-900 equivalent
  caretColor: 'rgb(17, 24, 39)',
  transition: 'background-color 5000s ease-in-out 0s',
};

const loginInputClasses =
  'w-full border border-foreground/15 bg-white/70 px-4 py-3 text-sm ' +
  'placeholder:opacity-50 transition-all duration-200 ' +
  'focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent ' +
  'dark:bg-white/5';

// Checks whether an error is a network/connection error (backend unreachable).
const isNetworkConnectionError = (error: unknown): boolean =>
  (error instanceof Error && (
    error.message.includes('Network Error') ||
    error.message.includes('ERR_NETWORK') ||
    error.message.includes('Failed to fetch') ||
    error.message.includes('NetworkError')
  )) ||
  (typeof error === 'object' && error !== null && (
    ('code' in error && (error as Record<string, unknown>).code === 'ERR_NETWORK') ||
    ('response' in error && (error as Record<string, unknown>).response === undefined)
  ));

// DO NOT clear tokens immediately - this is causing login issues
// Only clear tokens when the login component is explicitly mounted
const LoginPage: React.FC = () => {
  const { t } = useTranslation();
  const { accentColor } = useTheme();
  const [currentAccentColor, setCurrentAccentColor] = useState(accentColor);

  // Sync local accent color state with theme provider
  useEffect(() => {
    setCurrentAccentColor(accentColor);
  }, [accentColor]);
  const [usernameOrEmail, setUsernameOrEmail] = useState(() => {
    // Load saved username/email if remember me was enabled
    const savedRemember = userPrefs.getRememberSession();
    return savedRemember ? userPrefs.getSavedUsername() : '';
  });
  const [password, setPassword] = useState('');
  const [rememberMe, setRememberMe] = useState(() => {
    // Load remember me preference from storage-utils
    return userPrefs.getRememberSession();
  });
  const [showPassword, setShowPassword] = useState(false);
  const [isLoggingIn, setIsLoggingIn] = useState(false);

  // Handle Google OAuth login
  const handleGoogleLogin = async () => {
    try {
      const response = await fetch(`${API_BASE_URL}/auth/google/config`);
      if (!response.ok) {
        toast.error(t('login.errors.googleAuthError'));
        return;
      }

      const config = await response.json();
      if (!config.enabled || !config.client_id) {
        toast.error(t('login.errors.googleNotConfigured'));
        return;
      }

      const params = new URLSearchParams({
        client_id: config.client_id,
        redirect_uri: config.redirect_uri,
        scope: 'openid email profile',
        response_type: 'code',
        access_type: 'offline',
        prompt: 'consent',
      });

      window.location.href = `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
    } catch (error) {
      console.error('Google OAuth error:', error);

      // Check if this is a network/connection error (backend unreachable)
      const isNetworkError = isNetworkConnectionError(error);

      if (isNetworkError) {
        toast.error(t('login.errors.backendUnavailable'), {
          description: t('login.errors.connectionError'),
        });
      } else {
        toast.error(t('login.errors.googleAuthError'));
      }
    }
  };
  const [isDarkMode, setIsDarkMode] = useState(() =>
    document.documentElement.classList.contains('dark')
  );

  // Listen for accent color changes for immediate updates
  useEffect(() => {
    const handleAccentColorChange = (event: CustomEvent) => {
      const newAccentColor =
        event.detail ||
        localStorage.get('scrapalot_user_prefs')?.getItem('accentColor') ||
        'gray';
      const validAccentColor = [
        'gray',
        'blue',
        'green',
        'red',
        'violet',
        'orange',
      ].includes(newAccentColor)
        ? (newAccentColor as
          | 'gray'
          | 'blue'
          | 'green'
          | 'red'
          | 'violet'
          | 'orange')
        : 'gray';
      setCurrentAccentColor(validAccentColor);
    };

    // Set initial accent color from theme provider
    setCurrentAccentColor(accentColor);

    window.addEventListener(
      'accentColorChange',
      handleAccentColorChange as EventListener
    );
    return () =>
      window.removeEventListener(
        'accentColorChange',
        handleAccentColorChange as EventListener
      );
  }, [accentColor]);

  // Listen for theme changes
  useEffect(() => {
    const observer = new MutationObserver(mutations => {
      mutations.forEach(mutation => {
        if (mutation.attributeName === 'class') {
          const newIsDarkMode =
            document.documentElement.classList.contains('dark');
          setIsDarkMode(newIsDarkMode);
        }
      });
    });

    observer.observe(document.documentElement, { attributes: true });

    return () => observer.disconnect();
  }, []);

  const {
    login,
    isAuthenticated,
    isLoading,
    logout: _logout,
    authError,
    backendUnavailable,
    ensureModelsLoaded,
    user: _user,
    tokens,
    loginWithNativeGoogle,
  } = useAuth();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  // Resume target priority:
  //   1. ?redirect_to=... query param (used by deep links and SSO returns)
  //   2. sessionStorage['post_login_redirect'] stashed by api.ts when a
  //      mid-action 401 forced the user out — restores their original page
  //      (PDF viewer, deep research panel, settings tab) instead of dropping
  //      them on /dashboard
  //   3. /dashboard
  const stashedRedirect = (() => {
    try {
      const v = sessionStorage.getItem('post_login_redirect');
      if (v) sessionStorage.removeItem('post_login_redirect');
      return v;
    } catch { return null; }
  })();
  const redirectTo = searchParams.get('redirect_to') || stashedRedirect || '/dashboard';

  // Native (Android) Google Sign-In: the app should log users in with the
  // device's Google account instead of showing the login form. Triggered
  // automatically once on mount; the Credential Manager account sheet itself
  // is the user's confirmation. When no Scrapalot account exists yet, a
  // dialog asks before creating one (free Researcher plan).
  const [googleConfirm, setGoogleConfirm] = useState<{
    email: string;
    idToken: string;
  } | null>(null);
  const nativeGoogleAutoTried = useRef(false);

  const handleNativeGoogleLogin = async (interactive = false) => {
    try {
      const response = await fetch(`${API_BASE_URL}/auth/google/config`);
      if (!response.ok) {
        toast.error(t('login.errors.googleAuthError'));
        return;
      }
      const config = await response.json();
      if (!config.enabled || !config.client_id) {
        toast.error(t('login.errors.googleNotConfigured'));
        return;
      }

      const idToken = await nativeGoogleSignIn(config.client_id);
      const result = await loginWithNativeGoogle(idToken, false);

      if (result.ok) {
        navigate(redirectTo);
      } else if (result.needsConfirmation && result.email) {
        setGoogleConfirm({ email: result.email, idToken });
      } else if (interactive) {
        toast.error(t('login.errors.googleAuthError'));
      }
    } catch (error) {
      // Credential Manager failures land here: user dismissed the sheet, or
      // the OAuth Android client (package + signing SHA-1) is missing in the
      // Google Cloud Console (DEVELOPER_ERROR / code 10). The auto-attempt
      // falls back silently to the classic form; an explicit button tap
      // surfaces the underlying reason so it can be diagnosed.
      console.warn('Native Google sign-in unavailable:', error);
      if (interactive) {
        const detail =
          error instanceof Error ? error.message : String(error ?? '');
        toast.error(t('login.errors.googleAuthError'), {
          description: detail.slice(0, 160),
        });
      }
    }
  };

  const handleConfirmCreateAccount = async () => {
    const pending = googleConfirm;
    setGoogleConfirm(null);
    if (!pending) return;
    const result = await loginWithNativeGoogle(pending.idToken, true);
    if (result.ok) {
      navigate(redirectTo);
    } else {
      toast.error(t('login.errors.googleAuthError'));
    }
  };

  useEffect(() => {
    if (
      isNativeApp() &&
      !isAuthenticated &&
      !isLoading &&
      !nativeGoogleAutoTried.current
    ) {
      nativeGoogleAutoTried.current = true;
      void handleNativeGoogleLogin();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAuthenticated, isLoading]);

  // Check for backend availability on the component mount
  useEffect(() => {
    // If the backend is marked as unavailable, show a toast message
    if (backendUnavailable) {
      toast.error(t('login.errors.backendUnavailable'), {
        description: 'Service Unavailable',
      });
    }
  }, [backendUnavailable, t]);

  // If user is already authenticated (e.g., via session cookie auto-login),
  // redirect them to the dashboard immediately instead of showing login page.
  // This handles users who navigate to /login while already logged in.
  useEffect(() => {
    // Check if we're coming from a successful login
    const justLoggedIn = sessionStorage.getItem('just_logged_in') === 'true';

    // Don't do anything while auth is still loading
    if (isLoading) {
      return;
    }

    // If user is already authenticated, redirect to dashboard
    if (isAuthenticated) {
      // Check if they have valid tokens (session cookie auth or stored tokens)
      const hasTokens = localStorage.getItem('auth_tokens') || sessionStorage.getItem('auth_tokens') || tokens;

      if (hasTokens || justLoggedIn) {
        // User is legitimately authenticated, redirect to dashboard
        navigate(redirectTo, { replace: true });
        return;
      }
    }
  }, [isAuthenticated, isLoading, tokens, navigate, redirectTo]); // Added isAuthenticated dependency

  // Preload data in background after successful authentication (non-blocking)
  useEffect(() => {
    if (isAuthenticated && !isLoading) {
      // Preload models and workspace in background (don't block navigation)
      const preloadData = async () => {
        try {
          await ensureModelsLoaded();
          sessionStorage.setItem('models_preloaded', 'true');
        } catch (error) {
          console.error('Error preloading models: %s', error);
        }

        try {
          const { uiState } = await import('@/lib/storage-utils');
          uiState.setCurrentWorkspace(null);
          const { getDefaultWorkspace } = await import('@/lib/api-workspace');
          const workspace = await getDefaultWorkspace(true);
          uiState.setCurrentWorkspace(workspace);
          window.dispatchEvent(new CustomEvent('workspace-loaded', { detail: workspace }));
        } catch (error) {
          console.error('Error preloading workspace: %s', error);
        }

        // Preserve theme settings
        const currentTheme = userPrefs.getTheme();
        const currentAccent = userPrefs.getCurrentAccentColor();
        if (currentTheme) sessionStorage.setItem('preserved_theme', currentTheme);
        if (currentAccent) sessionStorage.setItem('preserved_accent', currentAccent);
      };

      // Start preloading but don't wait - first useEffect handles immediate redirect
      void preloadData();
    }
  }, [isAuthenticated, isLoading, ensureModelsLoaded]);

  // Handle remember me preference changes
  useEffect(() => {
    // Clear saved username if remember me is unchecked
    if (!rememberMe) {
      userPrefs.setSavedUsername('');
      // Also clear the username/email field if it was auto-filled
      const savedUsername = userPrefs.getSavedUsername();
      if (savedUsername && usernameOrEmail === savedUsername) {
        setUsernameOrEmail('');
      }
    }
  }, [rememberMe, usernameOrEmail]);

  // Don't render the login form if already authenticated
  if (isAuthenticated && !isLoading) {
    return null;
  }

  // Handle retry connection with proper state management
  const handleRetryConnection = () => {


    // Check if we're in a cooldown period
    const retryAfter = localStorage.getItem('backend_retry_after');
    const now = Date.now();

    if (retryAfter && parseInt(retryAfter) > now) {
      const remainingSeconds = Math.ceil((parseInt(retryAfter) - now) / 1000);
      toast.error(
        t('login.errors.waitBeforeRetry', { seconds: remainingSeconds }),
        {
          description: 'Please Wait',
        }
      );
      return;
    }

    toast.info(t('login.checkingConnection'), {
      description: 'Checking Connection',
    });

    // Clear backend unavailable flag immediately to prevent render loops
    localStorage.removeItem('backend_unavailable');
    localStorage.removeItem('backend_retry_after');

    // Force a reload to reinitialize everything
    window.location.reload();
  };

  // Handle form submission
  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    // Clear any existing auth errors - handled by useAuth hook
    if (backendUnavailable) {
      toast.error(t('login.errors.backendUnavailableDetailed'), {
        description: 'Service Unavailable',
      });
      return;
    }
    if (!usernameOrEmail || !password) {
      toast.error(t('login.errors.bothRequired'), {
        description: 'Login Error',
      });
      return;
    }

    setIsLoggingIn(true);
    let loginUITimeout: NodeJS.Timeout | undefined;

    try {
      loginUITimeout = setTimeout(() => {
        // This callback runs only if the timeout of 20s is reached
        // AND loginUITimeout has not been cleared by a prior resolution/rejection of login()
        if (isLoggingIn) {
          // Check current state of isLoggingIn
          console.warn(
            'Login UI timeout reached (20s) - resetting login state.'
          );
          setIsLoggingIn(false); // Attempt to hide spinner first
          toast.error(t('login.errors.loginTimeout'), {
            description: 'Login Timeout',
          });
        }
      }, 20000); // 20 seconds UI timeout

      const success = await login(usernameOrEmail, password, rememberMe);

      if (loginUITimeout) {
        clearTimeout(loginUITimeout);
        loginUITimeout = undefined;
      }

      if (success) {

        sessionStorage.setItem('just_logged_in', 'true');

        // Save or clear username/email based on remember me preference
        if (rememberMe) {
          userPrefs.setSavedUsername(usernameOrEmail);
          userPrefs.setRememberSession(true);
        } else {
          userPrefs.setSavedUsername('');
          userPrefs.setRememberSession(false);
        }

        // Preload models immediately after successful login
        try {

          // We don't need to await this here as the redirect effect will handle it
          ensureModelsLoaded()
            .then(() => {

              sessionStorage.setItem('models_preloaded', 'true');
            })
            .catch(error => {
              console.error('Error preloading models after login: %s', error);
            });
        } catch (error) {
          console.error(
            'Error initiating model preload after login: %s',
            error
          );
        }

        // The redirect is handled by the useEffect watching isAuthenticated.
      } else {
        // authError should be set by useAuth if login returned false

        // Check if backend is unavailable before showing generic auth error
        if (backendUnavailable) {
          toast.error(t('login.errors.backendUnavailable'), {
            description: t('login.errors.connectionError'),
          });
        } else if (authError) {
          // Check if auth error indicates network issue
          const isNetworkRelated = authError.toLowerCase().includes('network') ||
                                   authError.toLowerCase().includes('connection') ||
                                   authError.toLowerCase().includes('unavailable') ||
                                   authError.toLowerCase().includes('fetch');

          if (isNetworkRelated) {
            toast.error(t('login.errors.backendUnavailable'), {
              description: t('login.errors.connectionError'),
            });
          } else {
            toast.error(authError, {
              description: 'Authentication Error',
            });
          }
        } else {
          toast.error(t('login.errors.loginFailed'), {
            description: 'Login Failed',
          });
        }

        setIsLoggingIn(false);
      }
    } catch (error) {
      console.error('Login error in handleSubmit:', error);
      if (loginUITimeout) {
        clearTimeout(loginUITimeout);
      }

      // Check if this is a network/connection error (backend unreachable)
      const isNetworkError = isNetworkConnectionError(error);

      if (error instanceof Error && error.message.includes('timed out')) {
        toast.error(t('login.errors.loginTimeout'), {
          description: 'Login Timeout',
        });
      } else if (isNetworkError) {
        toast.error(t('login.errors.backendUnavailable'), {
          description: t('login.errors.connectionError'),
        });
      } else {
        toast.error(t('login.errors.unexpectedError'), {
          description: 'Login Error',
        });
      }
      setIsLoggingIn(false);
    }
  };

  return (
    <div
      data-testid='page-login-container'
      className='landing-page relative min-h-screen'
    >
      {/* Header */}
      <SharedHeader isDarkMode={isDarkMode} accentColor={currentAccentColor} />

      {/* Background atmosphere */}
      <AuroraBackground variant='hero' />

      {/* Main Content Container - adjusted for header */}
      <div className='relative flex min-h-screen items-center justify-center px-4 pb-8 pt-20' style={{ minHeight: '100vh' }}>
        <div className='relative w-full max-w-sm space-y-8'>
          <div
            className='landing-glass animate-fade-in relative mt-8 overflow-hidden opacity-0 transition-all duration-300'
            style={{ animationDelay: '0.2s', animationFillMode: 'forwards' }}
          >
            <div className='relative flex flex-col items-center gap-1 border-b border-foreground/10 py-7'>
              <img
                src='/logo512.png'
                alt='Scrapalot logo'
                className='mb-2 h-9 w-9 object-contain dark:invert'
              />
              <h2
                className='animate-fade-in font-display text-3xl font-medium tracking-tight'
                style={{
                  animationDelay: '0.3s',
                  animationFillMode: 'forwards',
                }}
              >
                {t('login.title')}
              </h2>
              <p className='font-mono text-[10px] uppercase tracking-[0.18em] opacity-50'>
                Scrapalot Research
              </p>
            </div>

            <div className='relative p-8'>
              <form
                data-testid="login-form"
                className='space-y-6'
                onSubmit={handleSubmit}
                method='post'
                action='/login'
                autoComplete='on'
              >
                {/* Username or Email Field */}
                <div className='space-y-2'>
                  <label htmlFor='main-username' className='sr-only'>
                    {t('login.usernameOrEmail')}
                  </label>
                  <Input
                    data-testid="login-username-input"
                    id='main-username'
                    name='username'
                    type='text'
                    autoComplete='username email'
                    autoCapitalize='none'
                    autoCorrect='off'
                    spellCheck={false}
                    required
                    value={usernameOrEmail}
                    onChange={e => setUsernameOrEmail(e.target.value)}
                    style={isDarkMode ? autofillStyles : lightAutofillStyles}
                    className={loginInputClasses}
                    placeholder={t('login.usernameOrEmail')}
                  />
                </div>

                {/* Password Field */}
                <div className='space-y-2'>
                  <label htmlFor='main-password' className='sr-only'>
                    {t('login.password')}
                  </label>
                  <div className='relative'>
                    <Input
                      data-testid="login-password-input"
                      id='main-password'
                      name='password'
                      type={showPassword ? 'text' : 'password'}
                      autoComplete='current-password'
                      autoCapitalize='none'
                      autoCorrect='off'
                      spellCheck={false}
                      required
                      value={password}
                      onChange={e => setPassword(e.target.value)}
                      style={isDarkMode ? autofillStyles : lightAutofillStyles}
                      className={`${loginInputClasses} pr-12`}
                      placeholder={t('login.password')}
                    />
                    <button
                      data-testid="login-toggle-password-button"
                      type='button'
                      onClick={() => setShowPassword(!showPassword)}
                      className='absolute right-3 top-1/2 -translate-y-1/2 transform opacity-50 transition-opacity hover:opacity-90'
                      tabIndex={-1}
                    >
                      {showPassword ? (
                        <svg
                          className='w-5 h-5'
                          fill='none'
                          stroke='currentColor'
                          viewBox='0 0 24 24'
                        >
                          <path
                            strokeLinecap='round'
                            strokeLinejoin='round'
                            strokeWidth={2}
                            d='M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.878 9.878L3 3m6.878 6.878L21 21'
                          />
                        </svg>
                      ) : (
                        <svg
                          className='w-5 h-5'
                          fill='none'
                          stroke='currentColor'
                          viewBox='0 0 24 24'
                        >
                          <path
                            strokeLinecap='round'
                            strokeLinejoin='round'
                            strokeWidth={2}
                            d='M15 12a3 3 0 11-6 0 3 3 0 016 0z'
                          />
                          <path
                            strokeLinecap='round'
                            strokeLinejoin='round'
                            strokeWidth={2}
                            d='M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z'
                          />
                        </svg>
                      )}
                    </button>
                  </div>
                </div>

                {/* Remember Me Checkbox */}
                <div className='flex items-center space-x-2'>
                  <Checkbox
                    data-testid="login-remember-me-checkbox"
                    id='rememberMe'
                    checked={rememberMe}
                    onCheckedChange={checked => setRememberMe(checked === true)}
                  />
                  <Label
                    htmlFor='rememberMe'
                    className='cursor-pointer text-sm opacity-70'
                  >
                    {t('login.rememberMe')}
                  </Label>
                </div>

                {/* Hidden submit button for browser credential detection */}
                <input
                  type='submit'
                  style={{ display: 'none' }}
                  tabIndex={-1}
                  aria-hidden='true'
                />

                {/* Submit Button */}
                <button
                  data-testid="login-submit-button"
                  type='submit'
                  disabled={isLoggingIn}
                  className='landing-btn-primary flex w-full items-center justify-center space-x-2 px-4 py-3 font-medium transition-all duration-200 disabled:cursor-not-allowed disabled:opacity-60'
                >
                  {isLoggingIn ? (
                    <span className='flex items-center justify-center'>
                      <svg
                        className='animate-spin -ml-1 mr-2 h-4 w-4'
                        xmlns='http://www.w3.org/2000/svg'
                        fill='none'
                        viewBox='0 0 24 24'
                      >
                        <circle
                          className='opacity-25'
                          cx='12'
                          cy='12'
                          r='10'
                          stroke='currentColor'
                          strokeWidth='4'
                        ></circle>
                        <path
                          className='opacity-75'
                          fill='currentColor'
                          d='M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z'
                        ></path>
                      </svg>
                      {t('login.signingIn')}
                    </span>
                  ) : (
                    t('login.signIn')
                  )}
                </button>
              </form>

              {/* Google Login Section — the native app uses the Credential
                  Manager sheet (Google blocks web OAuth inside WebViews) */}
              <div className='my-6 flex items-center gap-3'>
                <div className='h-px flex-1 bg-foreground/10' />
                <span className='shrink-0 font-mono text-[10px] uppercase tracking-[0.14em] opacity-50'>
                  {t('login.orContinueWith')}
                </span>
                <div className='h-px flex-1 bg-foreground/10' />
              </div>

              <button
                data-testid="login-google-button"
                type='button'
                onClick={
                  isNativeApp()
                    ? () => handleNativeGoogleLogin(true)
                    : handleGoogleLogin
                }
                disabled={isLoggingIn}
                className='landing-btn-ghost flex w-full items-center justify-center px-4 py-3 text-sm font-medium transition-all duration-200 disabled:cursor-not-allowed disabled:opacity-50'
              >
                <svg className='w-5 h-5 mr-3' viewBox='0 0 24 24'>
                  <path
                    fill='#4285F4'
                    d='M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z'
                  />
                  <path
                    fill='#34A853'
                    d='M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z'
                  />
                  <path
                    fill='#FBBC05'
                    d='M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z'
                  />
                  <path
                    fill='#EA4335'
                    d='M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z'
                  />
                </svg>
                {t('login.continueWithGoogle')}
              </button>

              {/* Native app: confirm before creating a new account from the
                  device's Google identity (free Researcher plan) */}
              <AlertDialog
                open={googleConfirm !== null}
                onOpenChange={open => !open && setGoogleConfirm(null)}
              >
                <AlertDialogContent data-testid='login-google-create-account-dialog'>
                  <AlertDialogHeader>
                    <AlertDialogTitle>
                      {t('login.nativeGoogle.confirmTitle')}
                    </AlertDialogTitle>
                    <AlertDialogDescription>
                      {t('login.nativeGoogle.confirmDescription', {
                        email: googleConfirm?.email ?? '',
                      })}
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel data-testid='login-google-create-account-cancel'>
                      {t('login.nativeGoogle.confirmCancel')}
                    </AlertDialogCancel>
                    <AlertDialogAction
                      data-testid='login-google-create-account-confirm'
                      onClick={handleConfirmCreateAccount}
                    >
                      {t('login.nativeGoogle.confirmCreate')}
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>

              {/* Sign Up Link */}
              <div
                className='mt-6 text-center animate-fade-in opacity-0'
                style={{
                  animationDelay: '0.4s',
                  animationFillMode: 'forwards',
                }}
              >
                <p className='text-sm opacity-70'>
                  {t('auth.newToScrapalot')}{' '}
                  <button
                    data-testid="login-signup-link"
                    type='button'
                    onClick={() => navigate('/sign-up')}
                    disabled={isLoggingIn}
                    className='font-medium text-primary transition-colors hover:underline disabled:cursor-not-allowed disabled:opacity-50'
                  >
                    {t('auth.createAccount')}
                  </button>
                </p>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Backend unavailable message */}
      {backendUnavailable && (
        <div className='absolute top-20 left-0 right-0 z-[5] mx-auto w-full max-w-md'>
          <div className='mb-4 border border-amber-400/40 bg-amber-500/10 p-4 backdrop-blur-md'>
            <h3 className='font-medium text-amber-700 dark:text-amber-300'>
              {t('login.backendUnavailable.title')}
            </h3>
            <p className='mt-1 text-sm text-amber-700/80 dark:text-amber-400'>
              {t('login.backendUnavailable.description')}
            </p>
            <button
              data-testid="login-retry-connection-button"
              onClick={handleRetryConnection}
              className='mt-2 bg-amber-600 px-3 py-1 text-sm text-white transition-colors hover:bg-amber-700'
            >
              {t('login.backendUnavailable.retryButton')}
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

export default LoginPage;
