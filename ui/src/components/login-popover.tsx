import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '@/hooks/use-auth';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { useTranslation } from 'react-i18next';
import { toast } from '@/lib/toast-compat';
import { useTheme } from '@/providers/theme-provider';
import { LogIn } from 'lucide-react';
import { API_BASE_URL } from '@/lib/api';
import { userPrefs } from '@/lib/storage-utils';

// Add a style block for autofill-specific styles
const autofillStyles = {
  // Override WebKit browsers autofill style
  WebkitBoxShadow: '0 0 0 30px rgb(39, 39, 42) inset', // dark:bg-zinc-800 equivalent
  WebkitTextFillColor: 'rgb(212, 212, 216)', // dark text for dark mode
  caretColor: 'rgb(212, 212, 216)', // Cursor color
  transition: 'background-color 5000s ease-in-out 0s', // Slow transition to keep the styling
};

// Light mode autofill style
const lightAutofillStyles = {
  WebkitBoxShadow: '0 0 0 30px white inset',
  WebkitTextFillColor: 'rgb(64, 64, 64)',
  caretColor: 'rgb(64, 64, 64)',
  transition: 'background-color 5000s ease-in-out 0s',
};

// Circuit Board Pattern Component for Popover
const CircuitBoardPattern: React.FC<{
  isDarkMode: boolean;
  accentColor: string;
}> = ({ isDarkMode, accentColor }) => {
  const patternId = 'popover-circuit-pattern';

  // Define accent color mappings
  const accentColors = {
    gray: { dark: '#71717a', light: '#52525b' },
    blue: { dark: '#3b82f6', light: '#2563eb' },
    green: { dark: '#10b981', light: '#059669' },
    red: { dark: '#ef4444', light: '#dc2626' },
    violet: { dark: '#8b5cf6', light: '#7c3aed' },
    orange: { dark: '#f97316', light: '#ea580c' },
  };

  const currentAccent =
    accentColors[accentColor as keyof typeof accentColors] || accentColors.blue;
  const strokeColor = isDarkMode ? currentAccent.dark : currentAccent.light;

  return (
    <div className='absolute inset-0 w-full h-full pointer-events-none overflow-hidden rounded-lg'>
      <svg
        width='100%'
        height='100%'
        className='absolute inset-0'
        style={{
          opacity: isDarkMode ? 0.03 : 0.02,
          zIndex: 0,
        }}
      >
        <defs>
          <pattern
            id={patternId}
            x='0'
            y='0'
            width='60'
            height='60'
            patternUnits='userSpaceOnUse'
          >
            {/* Circuit traces */}
            <g stroke={strokeColor} strokeWidth='0.6' fill='none'>
              {/* Horizontal traces */}
              <line x1='0' y1='15' x2='30' y2='15' />
              <line x1='40' y1='15' x2='60' y2='15' />
              <line x1='0' y1='30' x2='25' y2='30' />
              <line x1='35' y1='30' x2='60' y2='30' />
              <line x1='0' y1='45' x2='45' y2='45' />

              {/* Vertical traces */}
              <line x1='15' y1='0' x2='15' y2='25' />
              <line x1='15' y1='35' x2='15' y2='60' />
              <line x1='30' y1='0' x2='30' y2='30' />
              <line x1='30' y1='45' x2='30' y2='60' />
              <line x1='45' y1='15' x2='45' y2='60' />

              {/* Diagonal connections */}
              <line x1='15' y1='15' x2='25' y2='25' />
              <line x1='30' y1='30' x2='40' y2='40' />
              <line x1='35' y1='20' x2='45' y2='30' />
            </g>

            {/* Circuit nodes/pads */}
            <g fill={strokeColor}>
              <circle cx='15' cy='15' r='1' />
              <circle cx='30' cy='15' r='1' />
              <circle cx='45' cy='15' r='1' />
              <circle cx='15' cy='30' r='1' />
              <circle cx='30' cy='30' r='1' />
              <circle cx='45' cy='30' r='1' />
              <circle cx='15' cy='45' r='1' />
              <circle cx='30' cy='45' r='1' />
              <circle cx='45' cy='45' r='1' />
            </g>

            {/* Small microchip components */}
            <g fill='none' stroke={strokeColor} strokeWidth='0.6'>
              <rect x='20' y='10' width='6' height='6' />
              <rect x='35' y='25' width='6' height='6' />
            </g>

            {/* Component pins */}
            <g stroke={strokeColor} strokeWidth='0.3'>
              <line x1='18' y1='13' x2='20' y2='13' />
              <line x1='26' y1='13' x2='28' y2='13' />
              <line x1='33' y1='28' x2='35' y2='28' />
              <line x1='41' y1='28' x2='43' y2='28' />
            </g>
          </pattern>
        </defs>

        <rect width='100%' height='100%' fill={`url(#${patternId})`} />
      </svg>
    </div>
  );
};

interface LoginPopoverProps {
  children: React.ReactNode;
}

const LoginPopover: React.FC<LoginPopoverProps> = ({ children }) => {
  const { t } = useTranslation();
  const { accentColor } = useTheme();
  const [usernameOrEmail, setUsernameOrEmail] = useState(() => {
    // Load saved username/email if remember me was enabled
    const savedRemember = localStorage.getItem('remember_session');
    // Default to true if not set
    const rememberEnabled = savedRemember === null ? true : savedRemember === 'true';
    return rememberEnabled ? localStorage.getItem('saved_username') || '' : '';
  });
  const [password, setPassword] = useState('');
  const [rememberMe, setRememberMe] = useState(() => {
    // Load remember me preference from localStorage, default to true
    const saved = localStorage.getItem('remember_session');
    return saved === null ? true : saved === 'true';
  });
  const [isLoggingIn, setIsLoggingIn] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [open, setOpen] = useState(false);
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
      toast.error(t('login.errors.googleAuthError'));
    }
  };

  const [isDarkMode, setIsDarkMode] = useState(() =>
    document.documentElement.classList.contains('dark')
  );

  const {
    login,
    isAuthenticated,
    authError,
    backendUnavailable,
    ensureModelsLoaded,
  } = useAuth();
  const navigate = useNavigate();

  // Listen for theme changes
  useEffect(() => {
    const observer = new MutationObserver(mutations => {
      mutations.forEach(mutation => {
        if (mutation.attributeName === 'class') {
          setIsDarkMode(document.documentElement.classList.contains('dark'));
        }
      });
    });

    observer.observe(document.documentElement, { attributes: true });
    return () => observer.disconnect();
  }, []);

  // Close popover if user becomes authenticated
  useEffect(() => {
    if (isAuthenticated) {
      setOpen(false);
    }
  }, [isAuthenticated]);

  // Handle form submission
  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();

    if (backendUnavailable) {
      toast.error(t('login.errors.backendUnavailableDetailed'), {
        description: t('login.errors.serviceUnavailable'),
      });
      return;
    }

    if (!usernameOrEmail || !password) {
      toast.error(t('login.errors.bothRequired'), {
        description: t('login.errors.loginError'),
      });
      return;
    }

    setIsLoggingIn(true);

    try {
      const success = await login(usernameOrEmail, password, rememberMe);

      if (success) {
        sessionStorage.setItem('just_logged_in', 'true');

        // Save or clear username/email based on remember me preference
        if (rememberMe) {
          userPrefs.setSavedUsername(usernameOrEmail);
        } else {
          userPrefs.setSavedUsername('');
        }

        // Navigate to the dashboard FIRST, while this popover is still mounted.
        // The landing header swaps <LoginPopover> for a Dashboard button the
        // moment isAuthenticated flips (during the await login() above), so this
        // component unmounts almost immediately. React Router's useNavigate is a
        // silent no-op once its owning component has unmounted, so any navigate()
        // issued after a yielding await (e.g. model preloading) is dropped and
        // the user is stranded on the landing page. Preload models in the
        // background instead — the dashboard does not need it to render.
        navigate('/dashboard', { replace: true });
        setOpen(false);

        void ensureModelsLoaded()
          .then(() => sessionStorage.setItem('models_preloaded', 'true'))
          .catch((error) => console.error('Error preloading models after login:', error));
      } else {
        // Show toast notification for auth errors
        if (authError) {
          // Check if the auth error indicates a connection issue
          const isConnectionError =
            authError.includes('Service unavailable') ||
            authError.includes('Unable to reach') ||
            authError.includes('Unable to connect') ||
            authError.includes('check your internet connection') ||
            authError.includes('Network Error') ||
            authError.includes('Failed to fetch') ||
            authError.includes('An unexpected error occurred');

          if (isConnectionError) {
            toast.error(t('login.errors.backendUnavailable'), {
              description: t('login.errors.connectionError'),
            });
          } else {
            toast.error(authError, {
              description: t('login.errors.authenticationError'),
            });
          }
        } else {
          // No authError set - likely a connection issue
          toast.error(t('login.errors.backendUnavailable'), {
            description: t('login.errors.connectionError'),
          });
        }
      }
    } catch (error: unknown) {
      console.error('Login error in handleSubmit:', error);

      // Always treat errors in the login flow as connection errors
      // since auth-context catches and returns false for other error types
      toast.error(t('login.errors.backendUnavailable'), {
        description: t('login.errors.connectionError'),
      });
    } finally {
      setIsLoggingIn(false);
    }
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent
        className='w-80 bg-white/80 dark:bg-zinc-900/85 backdrop-blur-md border-2 border-white/50
                    dark:border-zinc-600/60 shadow-2xl 
                    shadow-black/35 relative overflow-hidden z-[3]'
        align='end'
        sideOffset={8}
        alignOffset={20}
      >
        <CircuitBoardPattern
          isDarkMode={isDarkMode}
          accentColor={accentColor}
        />
        <div className='p-6 space-y-4 relative z-10'>
          <div className='text-center'>
            <h3 className='text-lg font-semibold text-gray-900 dark:text-white'>
              {t('login.title')}
            </h3>
          </div>

          <form
            className='space-y-4'
            onSubmit={handleSubmit}
            method='post'
            action='/login'
            autoComplete='on'
          >
            {/* Username or Email Field */}
            <div className='space-y-2'>
              <label htmlFor='popover-username' className='sr-only'>
                {t('login.usernameOrEmail')}
              </label>
              <Input
                id='popover-username'
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
                className={`w-full px-4 py-3 border border-gray-300 dark:border-zinc-800 bg-white dark:bg-zinc-800 text-gray-900 dark:text-white placeholder-gray-500 dark:placeholder-gray-400 focus:outline-none focus:ring-2 focus:border-gray-500 dark:focus:border-zinc-400 transition-all duration-200 ${accentColor === 'violet'
                  ? 'focus:ring-violet-500/50 dark:focus:ring-violet-500'
                  : accentColor === 'blue'
                    ? 'focus:ring-blue-500/50 dark:focus:ring-blue-500'
                    : accentColor === 'green'
                      ? 'focus:ring-green-500/50 dark:focus:ring-green-500'
                      : accentColor === 'red'
                        ? 'focus:ring-red-500/50 dark:focus:ring-red-500'
                        : accentColor === 'orange'
                          ? 'focus:ring-orange-500/50 dark:focus:ring-orange-500'
                          : 'focus:ring-violet-500/50 dark:focus:ring-violet-500'
                  }`}
                placeholder={t('login.usernameOrEmail')}
              />
            </div>

            {/* Password Field */}
            <div className='space-y-2'>
              <label htmlFor='popover-password' className='sr-only'>
                {t('login.password')}
              </label>
              <div className='relative'>
                <Input
                  id='popover-password'
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
                  className={`w-full px-4 py-3 border border-gray-300 dark:border-zinc-800 bg-white dark:bg-zinc-800 text-gray-900 dark:text-white placeholder-gray-500 dark:placeholder-gray-400 focus:outline-none focus:ring-2 focus:border-gray-500 dark:focus:border-zinc-400 transition-all duration-200 pr-12 ${accentColor === 'violet'
                    ? 'focus:ring-violet-500/50 dark:focus:ring-violet-500'
                    : accentColor === 'blue'
                      ? 'focus:ring-blue-500/50 dark:focus:ring-blue-500'
                      : accentColor === 'green'
                        ? 'focus:ring-green-500/50 dark:focus:ring-green-500'
                        : accentColor === 'red'
                          ? 'focus:ring-red-500/50 dark:focus:ring-red-500'
                          : accentColor === 'orange'
                            ? 'focus:ring-orange-500/50 dark:focus:ring-orange-500'
                            : 'focus:ring-violet-500/50 dark:focus:ring-violet-500'
                    }`}
                  placeholder={t('login.password')}
                />
                <button
                  type='button'
                  onClick={() => setShowPassword(!showPassword)}
                  className='absolute right-3 top-1/2 transform -translate-y-1/2 text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 transition-colors'
                  tabIndex={-1}
                >
                  {showPassword ? (
                    <svg
                      className='w-4 h-4'
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
                      className='w-4 h-4'
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
                id='rememberMe'
                checked={rememberMe}
                onCheckedChange={checked => setRememberMe(checked === true)}
              />
              <Label
                htmlFor='rememberMe'
                className='text-sm text-gray-600 dark:text-gray-400 cursor-pointer'
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
            <Button
              type='submit'
              disabled={isLoggingIn}
              className={`w-full font-medium py-3 px-4 transition-all duration-200 flex items-center justify-center space-x-2 text-white ${accentColor === 'violet'
                ? 'bg-violet-600 hover:bg-violet-700 disabled:bg-violet-400'
                : accentColor === 'blue'
                  ? 'bg-blue-600 hover:bg-blue-700 disabled:bg-blue-400'
                  : accentColor === 'green'
                    ? 'bg-green-600 hover:bg-green-700 disabled:bg-green-400'
                    : accentColor === 'red'
                      ? 'bg-red-600 hover:bg-red-700 disabled:bg-red-400'
                      : accentColor === 'orange'
                        ? 'bg-orange-600 hover:bg-orange-700 disabled:bg-orange-400'
                        : 'bg-violet-600 hover:bg-violet-700 disabled:bg-violet-400'
                } disabled:cursor-not-allowed`}
            >
              {isLoggingIn ? (
                <span className='flex items-center justify-center'>
                  <svg
                    className='animate-spin -ml-1 mr-2 h-4 w-4 text-white'
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
                <>
                  <LogIn className='w-4 h-4' />
                  {t('login.signIn')}
                </>
              )}
            </Button>
          </form>

          {/* Google Login Section */}
          <div className='relative my-6'>
            <div className='absolute inset-0 flex items-center'>
              <div className='w-full border-t border-gray-300 dark:border-zinc-600' />
            </div>
            <div className='relative flex justify-center text-sm'>
              <span className='px-2 bg-white dark:bg-zinc-900 text-gray-500 dark:text-gray-400'>
                {t('login.orContinueWith')}
              </span>
            </div>
          </div>

          <Button
            type='button'
            onClick={handleGoogleLogin}
            disabled={isLoggingIn}
            variant='outline'
            className='w-full flex items-center justify-center space-x-2 border-gray-300 dark:border-zinc-600 bg-white dark:bg-zinc-800 text-gray-900 dark:text-white hover:bg-gray-50 dark:hover:bg-zinc-700'
          >
            <svg className='w-4 h-4' viewBox='0 0 24 24'>
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
            <span>{t('login.continueWithGoogle')}</span>
          </Button>

          {/* Sign Up Link - More Discrete */}
          <div className='mt-4 text-center'>
            <p className='text-sm text-gray-500 dark:text-gray-400'>
              {t('auth.newToScrapalot')}{' '}
              <button
                type='button'
                onClick={() => {
                  setOpen(false);
                  navigate('/sign-up');
                }}
                disabled={isLoggingIn}
                className='text-blue-600 dark:text-blue-400 hover:text-blue-700 dark:hover:text-blue-300 hover:underline font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed'
              >
                {t('auth.createAccount')}
              </button>
            </p>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
};

export default LoginPopover;
