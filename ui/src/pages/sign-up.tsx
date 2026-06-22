import React, { useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useTheme } from '@/providers/theme-provider';
import { useAuth } from '@/hooks/use-auth';
import { toast } from '@/lib/toast-compat';
import { registerUser, type UserRegistration } from '@/lib/api-users';
import { Eye, EyeOff, UserPlus, ArrowLeft, Zap, ChevronDown, ShieldCheck, Sparkles, Camera } from 'lucide-react';
import { Checkbox } from '@/components/ui/checkbox';
import { AuroraBackground } from '@/components/landing';

const signupInputClasses =
  'border-foreground/15 bg-white/70 placeholder:opacity-50 transition-all duration-200 ' +
  'focus-visible:ring-primary dark:bg-white/5';

const SignUpPage: React.FC = () => {
  const { t } = useTranslation();
  const { accentColor: _accentColor } = useTheme();
  const { login } = useAuth();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const redirectTo = searchParams.get('redirect_to') || '/dashboard';

  const [formData, setFormData] = useState<UserRegistration>({
    username: '',
    email: '',
    password: '',
    first_name: '',
    last_name: '',
    license_agreement_consent: false,
    content_sharing_consent: true, // Default to true (optional)
  });

  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [licenseAgreement, setLicenseAgreement] = useState(false);
  const [contentSharing, setContentSharing] = useState(true);
  const [licenseExpanded, setLicenseExpanded] = useState(false);
  const [contentSharingExpanded, setContentSharingExpanded] = useState(false);
  const [_profilePicture, setProfilePicture] = useState<File | null>(null);
  const [profilePicturePreview, setProfilePicturePreview] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [_isDarkMode, setIsDarkMode] = useState(() =>
    document.documentElement.classList.contains('dark')
  );

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

  // Validation function
  const validateForm = (): boolean => {
    const newErrors: Record<string, string> = {};

    if (!formData.username.trim()) {
      newErrors.username = 'Username is required';
    } else if (formData.username.length < 3) {
      newErrors.username = 'Username must be at least 3 characters';
    }

    if (!formData.email.trim()) {
      newErrors.email = 'Email is required';
    } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(formData.email)) {
      newErrors.email = 'Please enter a valid email address';
    }

    if (!formData.password) {
      newErrors.password = 'Password is required';
    } else if (formData.password.length < 6) {
      newErrors.password = 'Password must be at least 6 characters';
    }

    if (!confirmPassword) {
      newErrors.confirmPassword = 'Please confirm your password';
    } else if (formData.password !== confirmPassword) {
      newErrors.confirmPassword = 'Passwords do not match';
    }

    if (!licenseAgreement) {
      newErrors.licenseAgreement = 'You must agree to the license terms to register';
    }

    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  // Handle form submission
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!validateForm()) {
      return;
    }

    setIsSubmitting(true);

    try {
      // Prepare registration data (exclude empty optional fields)
      const registrationData: UserRegistration = {
        username: formData.username.trim(),
        email: formData.email.trim(),
        password: formData.password,
        license_agreement_consent: licenseAgreement,
        content_sharing_consent: contentSharing,
      };

      // Only include names if they're not empty
      if (formData.first_name?.trim()) {
        registrationData.first_name = formData.first_name.trim();
      }
      if (formData.last_name?.trim()) {
        registrationData.last_name = formData.last_name.trim();
      }

      const user = await registerUser(registrationData);

      if (user) {
        // Clear tour completion so new users see the onboarding tour
        localStorage.removeItem('scrapalot_tour_completed');

        toast.success(t('toast.auth.accountCreated'));

        // POST /users/register returns the user but NO tokens/cookie, so the
        // account is not yet authenticated. Without this, navigating to
        // /dashboard bounced the brand-new user straight to /login to re-enter
        // the password they just typed. Log them in with the same credentials
        // (login() updates the auth context + stores tokens), then hard-navigate
        // so AuthProvider bootstraps cleanly — matching the invite flow.
        try {
          const loggedIn = await login(formData.username.trim(), formData.password);
          if (loggedIn) {
            sessionStorage.setItem('just_logged_in', 'true');
            window.location.href = redirectTo;
            return;
          }
        } catch (loginErr) {
          console.error('Auto-login after registration failed:', loginErr);
        }
        // Auto-login failed — send them to login to sign in manually rather
        // than to a dashboard that would reject them.
        navigate('/login', { replace: true });
      }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- type is dynamic
    } catch (error: any) {
      // Error is already handled in registerUser function with toast
      console.error('Registration failed:', error);
    } finally {
      setIsSubmitting(false);
    }
  };

  // Handle input changes
  const handleProfilePictureChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      const file = e.target.files[0];

      // Validate file size (2MB max)
      const maxSize = 2 * 1024 * 1024;
      if (file.size > maxSize) {
        toast({ title: 'Error', description: 'Image must be less than 2MB', variant: 'destructive' });
        return;
      }

      // Validate file type
      if (!file.type.startsWith('image/')) {
        toast({ title: 'Error', description: 'Please select an image file', variant: 'destructive' });
        return;
      }

      setProfilePicture(file);

      // Create preview
      const reader = new FileReader();
      reader.onloadend = () => {
        setProfilePicturePreview(reader.result as string);
      };
      reader.readAsDataURL(file);
    }
  };

  const handleInputChange = (field: keyof UserRegistration, value: string) => {
    setFormData(prev => ({ ...prev, [field]: value }));
    // Clear error when user starts typing
    if (errors[field]) {
      setErrors(prev => ({ ...prev, [field]: '' }));
    }
  };

  return (
    <div
      data-testid='page-signup-container'
      className='landing-page relative flex min-h-screen items-center justify-center p-4'
    >
      <AuroraBackground variant='hero' />

      <div className='relative z-10 w-full max-w-md'>
        {/* Back to Home Link */}
        <div className='mb-6'>
          <Link
            to='/home'
            data-testid="signup-back-link"
            className='inline-flex items-center text-sm opacity-60 transition-opacity hover:opacity-100'
          >
            <ArrowLeft className='mr-2 h-4 w-4' />
            Back to Home
          </Link>
        </div>

        <div className='landing-glass relative overflow-hidden'>
          {/* Header */}
          <div className='relative space-y-2 px-6 pt-8 text-center'>
            <div className='mb-4 flex justify-center'>
              <input
                ref={fileInputRef}
                type='file'
                accept='image/*'
                onChange={handleProfilePictureChange}
                className='hidden'
              />
              <div
                onClick={() => fileInputRef.current?.click()}
                className='group relative cursor-pointer'
                title='Add profile picture'
              >
                {profilePicturePreview ? (
                  <div className='relative h-20 w-20 overflow-hidden rounded-full border-2 border-primary/40 shadow-lg'>
                    <img
                      src={profilePicturePreview}
                      alt='Profile'
                      className='h-full w-full object-cover'
                    />
                  </div>
                ) : (
                  <div className='flex h-20 w-20 items-center justify-center rounded-full border border-primary/25 bg-primary/10 transition-colors group-hover:bg-primary/20'>
                    <UserPlus className='h-8 w-8 text-primary' />
                  </div>
                )}
                <div className='absolute -bottom-1 -right-1 rounded-full border border-foreground/10 bg-background p-1.5 opacity-0 shadow-md transition-opacity group-hover:opacity-100'>
                  <Camera className='h-3 w-3 opacity-70' />
                </div>
              </div>
            </div>
            <h1 className='font-display text-3xl font-medium tracking-tight'>
              Create <span className='landing-gradient-text italic'>account</span>
            </h1>
            <p className='text-sm opacity-60'>
              Join Scrapalot to start your research journey
            </p>
          </div>

          <div className='relative p-6 pt-6'>
            <form data-testid="signup-form" onSubmit={handleSubmit} className='space-y-4'>
              {/* Name Fields Row */}
              <div className='grid grid-cols-2 gap-4'>
                <Input
                  data-testid="signup-first-name-input"
                  id='first_name'
                  type='text'
                  value={formData.first_name || ''}
                  onChange={(e) => handleInputChange('first_name', e.target.value)}
                  className={signupInputClasses}
                  placeholder='First Name'
                />
                <Input
                  data-testid="signup-last-name-input"
                  id='last_name'
                  type='text'
                  value={formData.last_name || ''}
                  onChange={(e) => handleInputChange('last_name', e.target.value)}
                  className={signupInputClasses}
                  placeholder='Last Name'
                />
              </div>

              {/* Username Field */}
              <div>
                <Input
                  data-testid="signup-username-input"
                  id='username'
                  type='text'
                  required
                  value={formData.username}
                  onChange={(e) => handleInputChange('username', e.target.value)}
                  className={`${signupInputClasses} ${errors.username ? 'border-red-500 dark:border-red-500' : ''}`}
                  placeholder='Username *'
                />
                {errors.username && (
                  <p className='mt-1 text-sm text-red-500'>{errors.username}</p>
                )}
              </div>

              {/* Email Field */}
              <div>
                <Input
                  data-testid="signup-email-input"
                  id='email'
                  type='email'
                  required
                  value={formData.email}
                  onChange={(e) => handleInputChange('email', e.target.value)}
                  className={`${signupInputClasses} ${errors.email ? 'border-red-500 dark:border-red-500' : ''}`}
                  placeholder='Email Address *'
                />
                {errors.email && (
                  <p className='mt-1 text-sm text-red-500'>{errors.email}</p>
                )}
              </div>

              {/* Password Field */}
              <div>
                <div className='relative'>
                  <Input
                    data-testid="signup-password-input"
                    id='password'
                    type={showPassword ? 'text' : 'password'}
                    autoComplete='new-password'
                    required
                    value={formData.password}
                    onChange={(e) => handleInputChange('password', e.target.value)}
                    className={`${signupInputClasses} pr-12 ${errors.password ? 'border-red-500 dark:border-red-500' : ''}`}
                    placeholder='Password *'
                  />
                  <button
                    data-testid="signup-toggle-password-button"
                    type='button'
                    onClick={() => setShowPassword(!showPassword)}
                    className='absolute right-3 top-1/2 -translate-y-1/2 transform opacity-50 transition-opacity hover:opacity-90'
                  >
                    {showPassword ? <EyeOff className='h-4 w-4' /> : <Eye className='h-4 w-4' />}
                  </button>
                </div>
                {errors.password && (
                  <p className='mt-1 text-sm text-red-500'>{errors.password}</p>
                )}
              </div>

              {/* Confirm Password Field */}
              <div>
                <div className='relative'>
                  <Input
                    data-testid="signup-confirm-password-input"
                    id='confirmPassword'
                    type={showConfirmPassword ? 'text' : 'password'}
                    required
                    value={confirmPassword}
                    onChange={(e) => {
                      setConfirmPassword(e.target.value);
                      if (errors.confirmPassword) {
                        setErrors(prev => ({ ...prev, confirmPassword: '' }));
                      }
                    }}
                    className={`${signupInputClasses} pr-12 ${errors.confirmPassword ? 'border-red-500 dark:border-red-500' : ''}`}
                    placeholder='Confirm Password *'
                  />
                  <button
                    data-testid="signup-toggle-confirm-password-button"
                    type='button'
                    onClick={() => setShowConfirmPassword(!showConfirmPassword)}
                    className='absolute right-3 top-1/2 -translate-y-1/2 transform opacity-50 transition-opacity hover:opacity-90'
                  >
                    {showConfirmPassword ? <EyeOff className='h-4 w-4' /> : <Eye className='h-4 w-4' />}
                  </button>
                </div>
                {errors.confirmPassword && (
                  <p className='mt-1 text-sm text-red-500'>{errors.confirmPassword}</p>
                )}
              </div>

              {/* Consent Checkboxes - Side by side on all screens */}
              <div className='grid grid-cols-2 gap-4 pt-2'>
                {/* License Agreement Checkbox (Required) */}
                <div>
                  <div className='flex items-start gap-2.5'>
                    <Checkbox
                      data-testid="signup-license-checkbox"
                      id='license-agreement'
                      checked={licenseAgreement}
                      onCheckedChange={(checked) => {
                        setLicenseAgreement(checked as boolean);
                        if (errors.licenseAgreement) {
                          setErrors(prev => ({ ...prev, licenseAgreement: '' }));
                        }
                      }}
                      className='mt-0.5 flex-shrink-0 data-[state=checked]:border-primary data-[state=checked]:bg-primary'
                    />
                    <div className='min-w-0 flex-1'>
                      <div className='mb-0.5 flex items-center gap-1.5'>
                        <ShieldCheck className='h-3 w-3 flex-shrink-0 text-primary' />
                        <Label
                          htmlFor='license-agreement'
                          className='cursor-pointer text-xs font-semibold'
                        >
                          License Agreement <span className='text-[10px] text-red-500'>*</span>
                        </Label>
                      </div>

                      <button
                        type='button'
                        onClick={() => setLicenseExpanded(true)}
                        className='flex items-center gap-0.5 text-[10px] text-primary transition-colors hover:underline'
                      >
                        <ChevronDown className='h-2.5 w-2.5' />
                        see more
                      </button>
                    </div>
                  </div>
                  {errors.licenseAgreement && (
                    <p className='mt-1 text-xs text-red-500'>
                      {errors.licenseAgreement}
                    </p>
                  )}
                </div>

                {/* Content Sharing Consent (Optional) */}
                <div className='flex items-start gap-2.5'>

                  <Checkbox
                    data-testid="signup-content-sharing-checkbox"
                    id='content-sharing'
                    checked={contentSharing}
                    onCheckedChange={(checked) => setContentSharing(checked as boolean)}
                    className='mt-0.5 flex-shrink-0 data-[state=checked]:border-emerald-600 data-[state=checked]:bg-emerald-600'
                  />
                  <div className='min-w-0 flex-1'>
                    <div className='mb-0.5 flex items-center gap-1.5'>
                      <Sparkles className='h-3 w-3 flex-shrink-0 text-emerald-600 dark:text-emerald-400' />
                      <Label
                        htmlFor='content-sharing'
                        className='cursor-pointer text-xs font-semibold'
                      >
                        Help Improve Scrapalot
                      </Label>
                    </div>

                    <button
                      type='button'
                      onClick={() => setContentSharingExpanded(true)}
                      className='flex items-center gap-0.5 text-[10px] text-emerald-600 transition-colors hover:underline dark:text-emerald-400'
                    >
                      <ChevronDown className='h-2.5 w-2.5' />
                      see more
                    </button>
                  </div>
                </div>
              </div>

              {/* License Agreement Dialog */}
              <Dialog open={licenseExpanded} onOpenChange={setLicenseExpanded}>
                <DialogContent className='max-w-md'>
                  <DialogHeader>
                    <DialogTitle className='flex items-center gap-2'>
                      <ShieldCheck className='h-5 w-5 text-primary' />
                      License Agreement
                    </DialogTitle>
                    <DialogDescription>
                      Please read the full terms carefully
                    </DialogDescription>
                  </DialogHeader>
                  <div className='max-h-[60vh] space-y-3 overflow-y-auto pr-2 text-sm leading-relaxed opacity-90'>
                    <p>I agree to the license terms and acknowledge that I am fully responsible for any content I upload to this platform, including files, YouTube videos, scientific papers, web pages, and any other external content.</p>
                    <p>I understand that all uploaded content must comply with applicable copyright laws and that I have the necessary rights and permissions for any content I submit.</p>
                    <p className='font-semibold text-primary'>Scrapalot is not responsible for user-uploaded content or any copyright violations.</p>
                  </div>
                </DialogContent>
              </Dialog>

              {/* Content Sharing Dialog */}
              <Dialog open={contentSharingExpanded} onOpenChange={setContentSharingExpanded}>
                <DialogContent className='max-w-md'>
                  <DialogHeader>
                    <DialogTitle className='flex items-center gap-2'>
                      <Sparkles className='h-5 w-5 text-emerald-600 dark:text-emerald-400' />
                      Help Improve Scrapalot
                    </DialogTitle>
                    <DialogDescription>
                      Learn how your data helps us improve
                    </DialogDescription>
                  </DialogHeader>
                  <div className='max-h-[60vh] space-y-3 overflow-y-auto pr-2 text-sm leading-relaxed opacity-90'>
                    <p>I consent to share my usage data and content to help improve the platform.</p>
                    <p>This includes allowing Scrapalot to analyze my chats, track usage patterns, collect feedback, and use this data to train and enhance our AI models and services.</p>
                    <p className='font-semibold text-emerald-700 dark:text-emerald-400'>Your data helps us build better AI for everyone.</p>
                  </div>
                </DialogContent>
              </Dialog>

              {/* Submit Button */}
              <Button
                data-testid="signup-submit-button"
                type='submit'
                disabled={isSubmitting}
                className='landing-btn-primary flex w-full items-center justify-center space-x-2 px-4 py-3 font-medium transition-all duration-200 disabled:cursor-not-allowed disabled:opacity-60'
              >
                {isSubmitting ? (
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
                    Creating Account...
                  </span>
                ) : (
                  <>
                    <Zap className='h-4 w-4' />
                    Create Account
                  </>
                )}
              </Button>
            </form>

            {/* Sign In Link */}
            <div className='mt-6 text-center'>
              <p className='text-sm opacity-70'>
                Already have an account?{' '}
                <Link
                  data-testid="signup-login-link"
                  to={redirectTo !== '/dashboard' ? `/login?redirect_to=${encodeURIComponent(redirectTo)}` : '/login'}
                  className='font-medium text-primary hover:underline'
                >
                  Sign in
                </Link>
              </p>
            </div>
          </div>
        </div>

        {/* Features Preview */}
        <div className='mt-8 text-center'>
          <p className='mb-4 text-sm opacity-50'>
            Join thousands of researchers using Scrapalot
          </p>
          <div className='flex justify-center gap-6 font-mono text-[11px] tracking-wide opacity-40'>
            <span>✓ AI-Powered Research</span>
            <span>✓ Document Analysis</span>
            <span>✓ Knowledge Management</span>
          </div>
        </div>
      </div>
    </div>
  );
};

export default SignUpPage;
