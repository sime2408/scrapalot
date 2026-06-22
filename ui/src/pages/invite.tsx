import React, { useState, useEffect } from 'react';
import { useSearchParams, Link } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useTheme } from '@/providers/theme-provider';
import { toast } from '@/lib/toast-compat';
import { Eye, EyeOff, UserPlus, Zap, ShieldCheck, Sparkles, AlertCircle, Loader2, LogIn } from 'lucide-react';
import { Checkbox } from '@/components/ui/checkbox';
import { validateInvitationToken, registerWithInvitation, type InvitationTokenInfo } from '@/lib/api-invitation';
import { AuroraBackground } from '@/components/landing';

type TokenState = 'loading' | 'valid' | 'expired' | 'used' | 'invalid';

const inviteInputClasses =
  'border-foreground/15 bg-white/70 placeholder:opacity-50 transition-all duration-200 ' +
  'focus-visible:ring-primary dark:bg-white/5';

const InvitePage: React.FC = () => {
  const { accentColor: _accentColor } = useTheme();
  const [searchParams] = useSearchParams();
  const token = searchParams.get('token');

  const [tokenState, setTokenState] = useState<TokenState>('loading');
  const [tokenInfo, setTokenInfo] = useState<InvitationTokenInfo | null>(null);
  const [errorMessage, setErrorMessage] = useState('');

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [licenseAgreement, setLicenseAgreement] = useState(false);
  const [contentSharing, setContentSharing] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!token) {
      setTokenState('invalid');
      setErrorMessage('No invitation token provided.');
      return;
    }

    validateInvitationToken(token)
      .then(info => {
        setTokenInfo(info);
        setTokenState('valid');
        if (info.recipient_name) {
          const parts = info.recipient_name.split(' ');
          setFirstName(parts[0] || '');
          setLastName(parts.slice(1).join(' ') || '');
        }
      })
      .catch((err) => {
        const status = err?.response?.status;
        if (status === 410) {
          const msg = err?.response?.data?.message || err?.response?.data?.detail || '';
          if (msg.toLowerCase().includes('used')) {
            setTokenState('used');
            setErrorMessage('This invitation has already been used.');
          } else {
            setTokenState('expired');
            setErrorMessage('This invitation has expired.');
          }
        } else {
          setTokenState('invalid');
          setErrorMessage('Invalid invitation link.');
        }
      });
  }, [token]);

  const validateForm = (): boolean => {
    const newErrors: Record<string, string> = {};
    if (!username.trim()) newErrors.username = 'Username is required';
    else if (username.length < 3) newErrors.username = 'Username must be at least 3 characters';
    if (!password) newErrors.password = 'Password is required';
    else if (password.length < 8) newErrors.password = 'Password must be at least 8 characters';
    if (!confirmPassword) newErrors.confirmPassword = 'Please confirm your password';
    else if (password !== confirmPassword) newErrors.confirmPassword = 'Passwords do not match';
    if (!licenseAgreement) newErrors.licenseAgreement = 'You must agree to the license terms';
    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!validateForm() || !token) return;

    setIsSubmitting(true);
    try {
      const result = await registerWithInvitation({
        token,
        username: username.trim(),
        password,
        firstName: firstName.trim() || undefined,
        lastName: lastName.trim() || undefined,
        licenseAgreementConsent: licenseAgreement,
        contentSharingConsent: contentSharing,
      });

      // Store tokens and redirect to dashboard
      const tokens = result.tokens;
      localStorage.setItem('auth_tokens', JSON.stringify({
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        token_type: tokens.token_type,
      }));
      localStorage.setItem('token_expiry', String(Date.now() + tokens.expires_in * 1000));
      localStorage.removeItem('scrapalot_tour_completed');
      // Mark a fresh login so the dashboard's post-login bootstrap runs.
      sessionStorage.setItem('just_logged_in', 'true');

      toast.success('Account created! Welcome to Scrapalot.');
      // Hard navigation (not SPA navigate) so the AuthProvider re-initialises
      // from the freshly-stored tokens. This page mounted unauthenticated, so
      // a client-side navigate() would leave isAuthenticated=false and the
      // dashboard never fetches the user / subscription / profile picture —
      // the sidebar sat in an infinite loading skeleton until a manual reload.
      // Matches the impersonation flow, which also hard-reloads for this reason.
      window.location.href = '/dashboard';
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- type is dynamic
    } catch (error: any) {
      const data = error?.response?.data;
      const fieldErrors = data?.field_errors;
      if (fieldErrors?.length > 0) {
        const details = fieldErrors.map((e: { field: string; message: string }) => `${e.field}: ${e.message}`).join('\n');
        toast.error(details);
      } else {
        toast.error(data?.message || data?.detail || 'Registration failed. Please try again.');
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  // Error states
  if (tokenState === 'loading') {
    return (
      <div
        data-testid='invite-loading-container'
        className='landing-page relative flex min-h-screen items-center justify-center'
      >
        <AuroraBackground variant='panel' />
        <div className='relative text-center'>
          <Loader2 className='mx-auto mb-4 h-8 w-8 animate-spin text-primary' />
          <p className='opacity-60'>Validating invitation...</p>
        </div>
      </div>
    );
  }

  // Already registered — show login prompt
  if (tokenState === 'valid' && tokenInfo?.user_exists) {
    return (
      <div className='landing-page relative flex min-h-screen items-center justify-center p-4'>
        <AuroraBackground variant='panel' />
        <div className='landing-glass relative w-full max-w-md p-8 text-center'>
          <div className='mb-5 flex justify-center'>
            <div className='flex h-16 w-16 items-center justify-center rounded-full border border-primary/25 bg-primary/10'>
              <LogIn className='h-7 w-7 text-primary' />
            </div>
          </div>
          <h1 className='font-display text-2xl font-medium tracking-tight'>
            You Already Have an Account
          </h1>
          <p className='mt-2 text-sm opacity-60'>
            An account with <span className='font-medium opacity-100'>{tokenInfo.email}</span> already exists. Sign in to continue.
          </p>
          <div className='mt-6 space-y-4'>
            <Link data-testid='invite-existing-user-login-link' to='/login'>
              <Button data-testid='invite-existing-user-login-button' className='landing-btn-primary w-full gap-2 font-medium'>
                <LogIn className='h-4 w-4' />
                Sign In
              </Button>
            </Link>
            <p className='text-xs opacity-50'>
              If you need a different account, contact the person who invited you.
            </p>
          </div>
        </div>
      </div>
    );
  }

  if (tokenState !== 'valid') {
    return (
      <div className='landing-page relative flex min-h-screen items-center justify-center p-4'>
        <AuroraBackground variant='panel' />
        <div className='landing-glass relative w-full max-w-md p-8 text-center'>
          <div className='mb-5 flex justify-center'>
            <div className='flex h-16 w-16 items-center justify-center rounded-full border border-red-500/30 bg-red-500/10'>
              <AlertCircle className='h-7 w-7 text-red-500' />
            </div>
          </div>
          <h1 className='font-display text-2xl font-medium tracking-tight'>
            {tokenState === 'expired' ? 'Invitation Expired' :
             tokenState === 'used' ? 'Invitation Already Used' :
             'Invalid Invitation'}
          </h1>
          <p className='mt-2 text-sm opacity-60'>{errorMessage}</p>
          <p className='mb-5 mt-4 text-sm opacity-50'>
            Please contact the person who invited you to request a new invitation.
          </p>
          <Link data-testid='invite-error-home-link' to='/'>
            <Button data-testid='invite-error-home-button' variant='outline' className='landing-btn-ghost border-0'>
              Go to Homepage
            </Button>
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div
      data-testid='page-invite-container'
      className='landing-page relative flex min-h-screen items-center justify-center p-4'
    >
      <AuroraBackground variant='hero' />
      <div className='relative z-10 w-full max-w-md'>
        <div className='landing-glass relative overflow-hidden'>
          <div className='space-y-2 px-6 pt-8 text-center'>
            <div className='mb-4 flex justify-center'>
              <div className='flex h-20 w-20 items-center justify-center rounded-full border border-primary/25 bg-primary/10'>
                <UserPlus className='h-8 w-8 text-primary' />
              </div>
            </div>
            <h1 className='font-display text-3xl font-medium tracking-tight'>
              You&apos;re <span className='landing-gradient-text italic'>invited!</span>
            </h1>
            <p className='text-sm opacity-60'>
              Complete your registration for{' '}
              <span className='font-medium opacity-100'>{tokenInfo?.email}</span>
            </p>
          </div>

          <div className='p-6'>
            <form data-testid="invite-form" onSubmit={handleSubmit} className='space-y-4'>
              {/* Email (read-only, from token) */}
              <div>
                <Label className='mb-1 block font-mono text-[10px] uppercase tracking-[0.14em] opacity-50'>
                  Email (from invitation)
                </Label>
                <Input
                  data-testid="invite-email-input"
                  type='email'
                  value={tokenInfo?.email || ''}
                  disabled
                  className='cursor-not-allowed border-foreground/10 bg-foreground/5 opacity-60'
                />
              </div>

              {/* Name Fields */}
              <div className='grid grid-cols-2 gap-4'>
                <Input
                  data-testid="invite-first-name-input"
                  type='text'
                  value={firstName}
                  onChange={(e) => setFirstName(e.target.value)}
                  className={inviteInputClasses}
                  placeholder='First Name'
                />
                <Input
                  data-testid="invite-last-name-input"
                  type='text'
                  value={lastName}
                  onChange={(e) => setLastName(e.target.value)}
                  className={inviteInputClasses}
                  placeholder='Last Name'
                />
              </div>

              {/* Username */}
              <div>
                <Input
                  data-testid="invite-username-input"
                  type='text'
                  required
                  value={username}
                  onChange={(e) => {
                    setUsername(e.target.value);
                    if (errors.username) setErrors(prev => ({ ...prev, username: '' }));
                  }}
                  className={`${inviteInputClasses} ${errors.username ? 'border-red-500 dark:border-red-500' : ''}`}
                  placeholder='Username *'
                />
                {errors.username && <p className='mt-1 text-sm text-red-500'>{errors.username}</p>}
              </div>

              {/* Password */}
              <div>
                <div className='relative'>
                  <Input
                    data-testid="invite-password-input"
                    type={showPassword ? 'text' : 'password'}
                    autoComplete='new-password'
                    required
                    value={password}
                    onChange={(e) => {
                      setPassword(e.target.value);
                      if (errors.password) setErrors(prev => ({ ...prev, password: '' }));
                    }}
                    className={`${inviteInputClasses} pr-12 ${errors.password ? 'border-red-500 dark:border-red-500' : ''}`}
                    placeholder='Password *'
                  />
                  <button
                    type='button'
                    onClick={() => setShowPassword(!showPassword)}
                    className='absolute right-3 top-1/2 -translate-y-1/2 transform opacity-50 transition-opacity hover:opacity-90'
                  >
                    {showPassword ? <EyeOff className='h-4 w-4' /> : <Eye className='h-4 w-4' />}
                  </button>
                </div>
                {errors.password && <p className='mt-1 text-sm text-red-500'>{errors.password}</p>}
              </div>

              {/* Confirm Password */}
              <div>
                <div className='relative'>
                  <Input
                    data-testid="invite-confirm-password-input"
                    type={showConfirmPassword ? 'text' : 'password'}
                    required
                    value={confirmPassword}
                    onChange={(e) => {
                      setConfirmPassword(e.target.value);
                      if (errors.confirmPassword) setErrors(prev => ({ ...prev, confirmPassword: '' }));
                    }}
                    className={`${inviteInputClasses} pr-12 ${errors.confirmPassword ? 'border-red-500 dark:border-red-500' : ''}`}
                    placeholder='Confirm Password *'
                  />
                  <button
                    type='button'
                    onClick={() => setShowConfirmPassword(!showConfirmPassword)}
                    className='absolute right-3 top-1/2 -translate-y-1/2 transform opacity-50 transition-opacity hover:opacity-90'
                  >
                    {showConfirmPassword ? <EyeOff className='h-4 w-4' /> : <Eye className='h-4 w-4' />}
                  </button>
                </div>
                {errors.confirmPassword && <p className='mt-1 text-sm text-red-500'>{errors.confirmPassword}</p>}
              </div>

              {/* Consent */}
              <div className='grid grid-cols-2 gap-4 pt-2'>
                <div>
                  <div className='flex items-start gap-2.5'>
                    <Checkbox
                      data-testid="invite-license-checkbox"
                      id='license-agreement'
                      checked={licenseAgreement}
                      onCheckedChange={(checked) => {
                        setLicenseAgreement(checked as boolean);
                        if (errors.licenseAgreement) setErrors(prev => ({ ...prev, licenseAgreement: '' }));
                      }}
                      className='mt-0.5 flex-shrink-0 data-[state=checked]:border-primary data-[state=checked]:bg-primary'
                    />
                    <div className='min-w-0 flex-1'>
                      <div className='flex items-center gap-1.5'>
                        <ShieldCheck className='h-3 w-3 flex-shrink-0 text-primary' />
                        <Label htmlFor='license-agreement' className='cursor-pointer text-xs font-semibold'>
                          License Agreement <span className='text-[10px] text-red-500'>*</span>
                        </Label>
                      </div>
                    </div>
                  </div>
                  {errors.licenseAgreement && <p className='mt-1 text-xs text-red-500'>{errors.licenseAgreement}</p>}
                </div>

                <div className='flex items-start gap-2.5'>
                  <Checkbox
                    data-testid="invite-content-sharing-checkbox"
                    id='content-sharing'
                    checked={contentSharing}
                    onCheckedChange={(checked) => setContentSharing(checked as boolean)}
                    className='mt-0.5 flex-shrink-0 data-[state=checked]:border-emerald-600 data-[state=checked]:bg-emerald-600'
                  />
                  <div className='min-w-0 flex-1'>
                    <div className='flex items-center gap-1.5'>
                      <Sparkles className='h-3 w-3 flex-shrink-0 text-emerald-600 dark:text-emerald-400' />
                      <Label htmlFor='content-sharing' className='cursor-pointer text-xs font-semibold'>
                        Help Improve Scrapalot
                      </Label>
                    </div>
                  </div>
                </div>
              </div>

              <Button
                data-testid="invite-submit-button"
                type='submit'
                disabled={isSubmitting}
                className='landing-btn-primary flex w-full items-center justify-center space-x-2 px-4 py-3 font-medium transition-all duration-200 disabled:cursor-not-allowed disabled:opacity-60'
              >
                {isSubmitting ? (
                  <span className='flex items-center justify-center'>
                    <Loader2 className='animate-spin -ml-1 mr-2 h-4 w-4' />
                    Creating Account...
                  </span>
                ) : (
                  <>
                    <Zap className='h-4 w-4' />
                    <span>Create Account</span>
                  </>
                )}
              </Button>
            </form>

            <div className='mt-6 text-center'>
              <p className='text-sm opacity-70'>
                Already have an account?{' '}
                <Link data-testid="invite-login-link" to='/login' className='font-medium text-primary hover:underline'>
                  Sign in
                </Link>
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default InvitePage;
