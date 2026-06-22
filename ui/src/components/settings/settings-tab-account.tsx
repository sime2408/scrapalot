import React, { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  AlertCircle,
  Award,
  BarChart3,
  CheckCircle,
  ChevronDown,
  ChevronUp,
  CreditCard,
  Edit,
  Eye,
  EyeOff,
  FileText,
  HardDrive,
  Lock,
  Mail,
  Medal,
  Save,
  Trash2,
  TrendingUp,
  Upload,
  User,
  UserCircle,
  Users,
  X,
  Zap,
} from 'lucide-react';
import type { User as UserType } from '@/lib/api-users';
import { changePassword, deleteProfilePicture, getCurrentUser, updateUserProfile } from '@/lib/api-users';
import { getMySubscription, requestRefund, type UserSubscriptionWithUsage } from '@/lib/api-subscriptions';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { toast } from '@/lib/toast-compat';
import { getMyStorageQuota, getStorageColor, formatBytes, type StorageQuota } from '@/lib/api-storage';
import { Diode } from '@/components/ui/diode';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { useAuth } from '@/hooks/use-auth';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { ProfilePictureUpload } from '@/components/profile-picture-upload';
import { clearCache } from '@/lib/api';
import { profilePicSources } from '@/lib/profile-picture';
import { ProfileImg } from '@/components/ui/profile-img';
import { useNavigate } from 'react-router-dom';
import { useTheme } from '@/providers/theme-provider';

interface SettingsAccountTabProps {
  isMobile?: boolean;
  preloadedUser?: UserType | null;
  preloadedSubscription?: UserSubscriptionWithUsage | null;
  preloadedStorageQuota?: StorageQuota | null;
  isPreloadingAccount?: boolean;
  onSavingChange?: (isSaving: boolean) => void;
  onSaved?: () => void;
}

export const SettingsAccountTab: React.FC<SettingsAccountTabProps> = ({
  isMobile = false,
  preloadedUser = null,
  preloadedSubscription = null,
  preloadedStorageQuota = null,
  isPreloadingAccount: _isPreloadingAccount = false,
  onSavingChange,
  onSaved,
}) => {
  const { t } = useTranslation();
  useAuth();
  const { theme } = useTheme();
  const navigate = useNavigate();

  // User profile state
  const [user, setUser] = useState<UserType | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);

  // Profile form state
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [email, setEmail] = useState('');
  const [username, setUsername] = useState('');

  // Password change state
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showCurrentPassword, setShowCurrentPassword] = useState(false);
  const [showNewPassword, setShowNewPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [isChangingPassword, setIsChangingPassword] = useState(false);

  // Form validation
  const [profileChanged, setProfileChanged] = useState(false);
  const [passwordValid, setPasswordValid] = useState(false);

  // Profile picture upload state
  const [showProfilePictureUpload, setShowProfilePictureUpload] = useState(false);
  const [showProfilePicturePreview, setShowProfilePicturePreview] = useState(false);
  const [profilePictureCacheBuster, setProfilePictureCacheBuster] = useState(Date.now());

  // Profile edit section state
  const [isProfileEditExpanded, setIsProfileEditExpanded] = useState(false);

  // Subscription data - fetched from API
  const [subscriptionData, setSubscriptionData] = useState<UserSubscriptionWithUsage | null>(null);
  const [showRefundConfirm, setShowRefundConfirm] = useState(false);
  const [isRefunding, setIsRefunding] = useState(false);
  const [isLoadingSubscription, setIsLoadingSubscription] = useState(true);

  // Storage quota data
  const [storageQuota, setStorageQuota] = useState<StorageQuota | null>(null);
  const [isLoadingStorage, setIsLoadingStorage] = useState(true);

  // Load subscription data - use preloaded data if available
  useEffect(() => {
    const loadSubscriptionData = async () => {
      // Use preloaded data if available
      if (preloadedSubscription) {
        setSubscriptionData(preloadedSubscription);
        setIsLoadingSubscription(false);
        return;
      }

      try {
        setIsLoadingSubscription(true);
        const data = await getMySubscription();
        setSubscriptionData(data);
      } catch (error) {
        console.error('Failed to load subscription data:', error);
      } finally {
        setIsLoadingSubscription(false);
      }
    };

    if (user) {
      void loadSubscriptionData();
    }
  }, [user, preloadedSubscription]);

  // Load storage quota data - use preloaded data if available
  useEffect(() => {
    const loadStorageQuota = async () => {
      // Use preloaded data if available
      if (preloadedStorageQuota) {
        setStorageQuota(preloadedStorageQuota);
        setIsLoadingStorage(false);
        return;
      }

      try {
        setIsLoadingStorage(true);
        const quota = await getMyStorageQuota();
        setStorageQuota(quota);
      } catch (error) {
        console.error('Failed to load storage quota:', error);
        // Don't show error toast for storage - it's not critical
      } finally {
        setIsLoadingStorage(false);
      }
    };

    if (user) {
      void loadStorageQuota();
    }
  }, [user, preloadedStorageQuota]);

  // Helper functions for subscription
  const getUsageColor = (percentage: number, isPro: boolean = false) => {
    if (percentage >= 90) return 'bg-red-500';
    if (percentage >= 70) return 'bg-orange-500';
    return isPro ? 'bg-slate-500' : 'bg-zinc-500';
  };

  const getPlanIcon = (plan: string) => {
    switch (plan.toLowerCase()) {
      case 'enterprise':
        return <Medal className='w-5 h-5 text-yellow-400 drop-shadow-lg' />;
      case 'team':
        return <Users className='w-5 h-5 text-emerald-400 drop-shadow-lg' />;
      case 'pro':
        return <Award className='w-5 h-5 text-gray-300 drop-shadow-lg' />;
      case 'researcher':
        return <BarChart3 className='w-5 h-5 text-blue-400 drop-shadow-lg' />;
      default:
        return <Zap className='w-5 h-5 text-zinc-400 drop-shadow-md' />;
    }
  };

  // Extract subscription plan safely
  const subscriptionPlan = subscriptionData?.subscription?.subscription_plan;
  const subStatus = subscriptionData?.subscription?.status;
  const isTrialing = subStatus === 'trialing';
  const trialDaysLeft = isTrialing && subscriptionData?.subscription?.current_period_end
    ? Math.max(0, Math.ceil((new Date(subscriptionData.subscription.current_period_end).getTime() - Date.now()) / 86_400_000))
    : 0;
  const isByok = subscriptionData?.subscription?.byok === true;
  // 30-day money-back window: a paid (non-trial) Stripe subscription whose
  // first charge is within the last 30 days.
  const refundEligible = !!subscriptionData?.subscription
    && subStatus === 'active'
    && (subscriptionPlan?.price_monthly ?? 0) > 0
    && subscriptionData.subscription.subscribed_at != null
    && (Date.now() - new Date(subscriptionData.subscription.subscribed_at).getTime()) < 30 * 86_400_000;

  const handleRefund = async () => {
    setIsRefunding(true);
    try {
      const result = await requestRefund();
      toast({ title: t('settings.account.refund.successTitle', 'Refund issued'), description: result.message });
      setShowRefundConfirm(false);
      const data = await getMySubscription();
      setSubscriptionData(data);
    } catch (err) {
      toast({
        title: t('settings.account.refund.errorTitle', 'Refund failed'),
        description: err instanceof Error ? err.message : 'Please contact support.',
        variant: 'destructive',
      });
    } finally {
      setIsRefunding(false);
    }
  };
  const planName = subscriptionPlan?.name ?? 'researcher';

  const documentsPercentage = subscriptionData?.quota_info?.documents?.percentage_used ?? 0;
  const tokensPercentage = subscriptionData?.quota_info?.tokens?.percentage_used ?? 0;

  // Detect effective dark mode (accounts for 'system' theme preference)
  const isDark = useMemo(() => {
    if (theme === 'dark') return true;
    if (theme === 'light') return false;
    return window.matchMedia('(prefers-color-scheme: dark)').matches;
  }, [theme]);

  // Plan-specific gradient styles for light/dark themes
  const heroGradient = useMemo(() => {
    if (planName === 'team') {
      return isDark
        ? 'linear-gradient(135deg, #064e3b 0%, #065f46 25%, #047857 50%, #064e3b 75%, #065f46 100%)'
        : 'linear-gradient(135deg, #059669 0%, #047857 25%, #10b981 50%, #047857 75%, #059669 100%)';
    }
    if (planName === 'pro') {
      return isDark
        ? 'linear-gradient(135deg, #1e293b 0%, #334155 25%, #3d5a80 50%, #1e293b 75%, #334155 100%)'
        : 'linear-gradient(135deg, #64748b 0%, #475569 25%, #5b7a99 50%, #334155 75%, #475569 100%)';
    }
    if (planName === 'enterprise') {
      return isDark
        ? 'linear-gradient(135deg, #78350f 0%, #92400e 25%, #a16207 50%, #78350f 75%, #92400e 100%)'
        : 'linear-gradient(135deg, #d97706 0%, #b45309 25%, #ca8a04 50%, #92400e 75%, #a16207 100%)';
    }
    return isDark
      ? 'linear-gradient(135deg, #1e1b4b 0%, #312e81 30%, #3730a3 55%, #1e3a5f 75%, #1e1b4b 100%)'
      : 'linear-gradient(135deg, #3b82f6 0%, #4338ca 30%, #6366f1 55%, #4f46e5 75%, #3b82f6 100%)';
  }, [planName, isDark]);

  const meshOverlay = useMemo(() => {
    if (planName === 'enterprise') {
      return isDark
        ? 'radial-gradient(ellipse 60% 50% at 20% 30%, rgba(180,83,9,0.15) 0%, transparent 70%), radial-gradient(ellipse 40% 40% at 80% 70%, rgba(120,53,15,0.1) 0%, transparent 70%)'
        : 'radial-gradient(ellipse 60% 50% at 20% 30%, rgba(251,191,36,0.12) 0%, transparent 70%), radial-gradient(ellipse 40% 40% at 80% 70%, rgba(180,83,9,0.08) 0%, transparent 70%)';
    }
    if (planName === 'pro' || planName === 'team') {
      return isDark
        ? 'radial-gradient(ellipse 60% 50% at 20% 30%, rgba(71,85,105,0.12) 0%, transparent 70%), radial-gradient(ellipse 40% 40% at 80% 70%, rgba(30,41,59,0.1) 0%, transparent 70%)'
        : 'radial-gradient(ellipse 60% 50% at 20% 30%, rgba(148,163,184,0.1) 0%, transparent 70%), radial-gradient(ellipse 40% 40% at 80% 70%, rgba(71,85,105,0.08) 0%, transparent 70%)';
    }
    return isDark
      ? 'radial-gradient(ellipse 60% 50% at 20% 30%, rgba(67,56,202,0.18) 0%, transparent 70%), radial-gradient(ellipse 40% 40% at 80% 70%, rgba(30,27,75,0.12) 0%, transparent 70%)'
      : 'radial-gradient(ellipse 60% 50% at 20% 30%, rgba(99,102,241,0.15) 0%, transparent 70%), radial-gradient(ellipse 40% 40% at 80% 70%, rgba(59,130,246,0.1) 0%, transparent 70%)';
  }, [planName, isDark]);

  // Load user data on component mount - use preloaded data if available
  useEffect(() => {
    const loadUserData = async () => {
      // Use preloaded data if available
      if (preloadedUser) {
        setUser(preloadedUser);
        setFirstName(preloadedUser.first_name || '');
        setLastName(preloadedUser.last_name || '');
        setEmail(preloadedUser.email || '');
        setUsername(preloadedUser.username || '');
        setIsLoading(false);
        return;
      }

      try {
        setIsLoading(true);
        const userData = await getCurrentUser();

        if (userData) {
          setUser(userData);
          setFirstName(userData.first_name || '');
          setLastName(userData.last_name || '');
          setEmail(userData.email || '');
          setUsername(userData.username || '');
        } else {
          console.warn('No user data received');
        }
      } catch (error) {
        console.error('❌ Failed to load user data:', error);
      } finally {
        setIsLoading(false);
      }
    };

    void loadUserData();
  }, [preloadedUser]);

  // Check if profile has changed
  useEffect(() => {
    if (user) {
      const hasChanged =
        firstName !== (user.first_name || '') ||
        lastName !== (user.last_name || '') ||
        email !== (user.email || '');
      setProfileChanged(hasChanged);
    }
  }, [firstName, lastName, email, user]);

  // Validate password form
  useEffect(() => {
    // For OAuth users without password, current password is not required
    const hasPassword = user?.has_password !== false;
    const isValid = hasPassword
      ? currentPassword.length > 0 && newPassword.length >= 8 && newPassword === confirmPassword
      : newPassword.length >= 8 && newPassword === confirmPassword;
    setPasswordValid(isValid);
  }, [currentPassword, newPassword, confirmPassword, user]);

  // Handle profile update
  const handleUpdateProfile = async () => {
    if (!user || !profileChanged) return;

    try {
      setIsSaving(true);
      onSavingChange?.(true);
      const updatedUser = await updateUserProfile({
        first_name: firstName,
        last_name: lastName,
        email: email,
      });

      if (updatedUser) {
        setUser(updatedUser);
        setProfileChanged(false);
        onSaved?.();
      }
    } catch (error) {
      console.error('Failed to update profile:', error);
    } finally {
      setIsSaving(false);
      onSavingChange?.(false);
    }
  };

  // Handle password change
  const handleChangePassword = async () => {
    if (!passwordValid) return;

    try {
      setIsChangingPassword(true);
      onSavingChange?.(true);
      // For OAuth users without password, don't send current_password
      const hasPassword = user?.has_password !== false;
      await changePassword({
        current_password: hasPassword ? currentPassword : undefined,
        new_password: newPassword,
      });

      // Clear password fields
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');

      onSaved?.();
    } catch (error) {
      console.error('Failed to change password:', error);
    } finally {
      setIsChangingPassword(false);
      onSavingChange?.(false);
    }
  };

  // Handle profile picture upload success
  const handleProfilePictureUploadSuccess = (updatedUser: UserType) => {
    clearCache('/users/me');
    setUser(updatedUser);
    setProfilePictureCacheBuster(Date.now());
    window.dispatchEvent(new CustomEvent('profilePictureUpdated', { detail: { user: updatedUser } }));
    onSaved?.();
  };

  // Handle profile picture deletion
  const handleDeleteProfilePicture = async () => {
    onSavingChange?.(true);
    try {
      const updatedUser = await deleteProfilePicture();
      if (updatedUser) {
        setUser(updatedUser);
        // Update cache buster to ensure proper refresh
        setProfilePictureCacheBuster(Date.now());
        // Dispatch custom event to notify other components (like sidebar) to refresh
        window.dispatchEvent(new CustomEvent('profilePictureUpdated', { detail: { user: updatedUser } }));
        onSaved?.();
      }
    } catch (error) {
      console.error('Failed to delete profile picture:', error);
    } finally {
      onSavingChange?.(false);
    }
  };

  // Get user initials for avatar fallback
  const getUserInitials = (user: UserType) => {
    const firstName = user.first_name || '';
    const lastName = user.last_name || '';
    const email = user.email || '';

    if (firstName && lastName) {
      return `${firstName[0]}${lastName[0]}`.toUpperCase();
    } else if (firstName) {
      return firstName[0].toUpperCase();
    } else if (email) {
      return email[0].toUpperCase();
    }
    return 'U';
  };

  // Show loading only if we're actually loading and don't have preloaded data
  const shouldShowLoading = (isLoading && !preloadedUser) || (isLoadingSubscription && !preloadedSubscription);

  if (shouldShowLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
      </div>
    );
  }

  if (!user) {
    return (
      <div className="flex flex-col items-center justify-center h-64 space-y-4">
        <AlertCircle className="h-12 w-12 text-zinc-400" />
        <div className="text-center">
          <h3 className="text-lg font-semibold text-zinc-900 dark:text-white">{t('settings.account.noUserData')}</h3>
          <p className="text-sm text-zinc-500 dark:text-zinc-400">
            {t('settings.account.noUserDataDescription')}
          </p>
        </div>
      </div>
    );
  }


  return (
    <div className='relative'>
      {/* Float animation keyframes */}
      <style>{`
        @keyframes heroFloat {
          0%, 100% { transform: translateY(0px) rotate(0deg); }
          25% { transform: translateY(-8px) rotate(1deg); }
          50% { transform: translateY(-4px) rotate(-0.5deg); }
          75% { transform: translateY(-12px) rotate(0.5deg); }
        }
      `}</style>

      {/* Full-bleed gradient background that covers header + hero and fades out.
         Negative margins cancel parent padding so gradient bleeds edge-to-edge. */}
      {user && (
        <div
          className='absolute top-0 pointer-events-none'
          style={{
            height: '680px',
            zIndex: 0,
            left: isMobile ? '-16px' : '-24px',
            right: isMobile ? '-16px' : '-32px',
            top: isMobile ? '-16px' : '-24px',
          }}
        >
          {/* Base gradient */}
          <div
            className='absolute inset-0'
            style={{
              background: heroGradient,
              maskImage: 'linear-gradient(to bottom, black 0%, black 60%, transparent 100%)',
              WebkitMaskImage: 'linear-gradient(to bottom, black 0%, black 60%, transparent 100%)',
            }}
          />
          {/* Mesh gradient overlay */}
          <div
            className='absolute inset-0'
            style={{
              background: meshOverlay,
              maskImage: 'linear-gradient(to bottom, black 0%, black 60%, transparent 100%)',
              WebkitMaskImage: 'linear-gradient(to bottom, black 0%, black 60%, transparent 100%)',
            }}
          />
          {/* Noise texture */}
          <div
            className='absolute inset-0'
            style={{
              opacity: 0.03,
              backgroundImage: `url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E")`,
              backgroundRepeat: 'repeat',
              backgroundSize: '128px 128px',
              maskImage: 'linear-gradient(to bottom, black 0%, black 60%, transparent 100%)',
              WebkitMaskImage: 'linear-gradient(to bottom, black 0%, black 60%, transparent 100%)',
            }}
          />
          {/* Floating decorative SVG elements */}
          <div className='absolute inset-0 overflow-hidden' aria-hidden='true'
            style={{
              maskImage: 'linear-gradient(to bottom, black 0%, black 50%, transparent 100%)',
              WebkitMaskImage: 'linear-gradient(to bottom, black 0%, black 50%, transparent 100%)',
            }}
          >
            <svg
              className='absolute top-1/2 -left-6 -translate-y-1/2 animate-[heroFloat_20s_ease-in-out_infinite_reverse]'
              width='120' height='120' viewBox='0 0 120 120'
              style={{ opacity: 0.06 }}
            >
              <polygon points='60,5 110,30 110,90 60,115 10,90 10,30' fill='none' stroke='white' strokeWidth='1.5' />
            </svg>
            <svg
              className='absolute bottom-1/4 right-1/4 animate-[heroFloat_22s_ease-in-out_infinite_2s]'
              width='80' height='80' viewBox='0 0 80 80'
              style={{ opacity: 0.07 }}
            >
              <rect x='15' y='15' width='50' height='50' fill='none' stroke='white' strokeWidth='1.5' transform='rotate(45 40 40)' />
            </svg>
            <svg
              className='absolute bottom-1/3 left-16 animate-[heroFloat_18s_ease-in-out_infinite_4s]'
              width='100' height='100' viewBox='0 0 100 100'
              style={{ opacity: 0.05 }}
            >
              <circle cx='30' cy='50' r='20' fill='none' stroke='white' strokeWidth='1' />
              <circle cx='65' cy='35' r='14' fill='none' stroke='white' strokeWidth='1' />
              <circle cx='70' cy='70' r='10' fill='none' stroke='white' strokeWidth='1' />
            </svg>
          </div>
        </div>
      )}

      {/* Header - text is white when gradient is behind it */}
      <div className='sticky top-0 pt-0 pb-6 z-20' style={{ position: 'sticky' }}>
        <div
          className='absolute inset-0 -z-10'
          style={{
            backdropFilter: 'blur(16px)',
            WebkitBackdropFilter: 'blur(16px)',
            maskImage: 'linear-gradient(to bottom, transparent 0%, black 10%, black 90%, transparent 100%)',
          }}
        />
        <div className='flex items-center justify-between'>
          <div>
            <h2 className={`text-2xl font-bold mb-1 ${user ? 'text-white' : 'text-zinc-900 dark:text-white'}`}>
              {t('settings.account.title')}
            </h2>
            <p className={`text-sm ${user ? 'text-white/70' : 'text-zinc-500 dark:text-zinc-400'}`}>
              {t('settings.account.description')}
            </p>
          </div>
        </div>
      </div>

      <div className='space-y-4'>
        {/* Account Information Display */}
        {user && (
          <div className='relative text-white'>
            {/* Content layer */}
            <div className='relative z-10'>
              {/* Top Section: Profile & User Info */}
              <div className='flex flex-col md:flex-row items-center md:items-start gap-4 mb-4'>
                <div className='group relative'>
                  {/* Decorative circle behind avatar */}
                  <svg
                    className='absolute -inset-8 pointer-events-none animate-[heroFloat_20s_ease-in-out_infinite]'
                    viewBox='0 0 200 200'
                    style={{ opacity: 0.12, zIndex: 0 }}
                    aria-hidden='true'
                  >
                    <circle cx='100' cy='100' r='95' fill='none' stroke='white' strokeWidth='1' />
                    <circle cx='100' cy='100' r='80' fill='none' stroke='white' strokeWidth='0.75' strokeDasharray='8 4' />
                  </svg>
                  <div
                    className='relative rounded-full'
                    style={{
                      zIndex: 1,
                      boxShadow: planName === 'enterprise'
                        ? '0 0 30px rgba(217,119,6,0.4), 0 0 60px rgba(217,119,6,0.15)'
                        : planName === 'pro' || planName === 'team'
                          ? '0 0 30px rgba(100,116,139,0.35), 0 0 60px rgba(100,116,139,0.12)'
                          : '0 0 30px rgba(99,102,241,0.4), 0 0 60px rgba(99,102,241,0.15)',
                    }}
                  >
                    <Avatar
                      className={`w-24 h-24 ring-[3px] cursor-pointer hover:opacity-90 transition-opacity ${
                        planName === 'enterprise'
                          ? 'ring-amber-300/70'
                          : planName === 'pro' || planName === 'team'
                            ? 'ring-slate-300/60'
                            : 'ring-indigo-300/60'
                      }`}
                      style={{ border: '3px solid rgba(255,255,255,0.3)' }}
                      onClick={() => user.profile_picture && setShowProfilePicturePreview(true)}
                    >
                      <AvatarImage
                        {...profilePicSources(user.profile_picture, profilePictureCacheBuster)}
                        alt={`${user.first_name || user.username || 'User'}'s profile picture`}
                      />
                      <AvatarFallback className='bg-white/20 backdrop-blur-sm text-white text-2xl font-bold'>
                        {getUserInitials(user)}
                      </AvatarFallback>
                    </Avatar>
                  </div>
                  {/* Hover buttons overlay */}
                  <div className='absolute inset-0 z-[2] flex items-center justify-center gap-2 opacity-0 group-hover:opacity-100 transition-opacity duration-200 pointer-events-none'>
                    <Button
                      variant='secondary'
                      size='icon'
                      onClick={(e) => {
                        e.stopPropagation();
                        setShowProfilePictureUpload(true);
                      }}
                      className={`w-10 h-10 rounded-full bg-white/90 hover:bg-white text-blue-600 shadow-lg backdrop-blur-sm pointer-events-auto ${isMobile ? 'mobile-touch-button' : ''}`}
                      title={user.profile_picture ? 'Change profile picture' : 'Upload profile picture'}
                    >
                      <Upload className='w-4 h-4' />
                    </Button>
                    {user.profile_picture && (
                      <Button
                        variant='secondary'
                        size='icon'
                        onClick={(e) => {
                          e.stopPropagation();
                          void handleDeleteProfilePicture();
                        }}
                        className={`w-10 h-10 rounded-full bg-red-500/90 hover:bg-red-600 text-white shadow-lg backdrop-blur-sm pointer-events-auto ${isMobile ? 'mobile-touch-button' : ''}`}
                        title='Remove profile picture'
                      >
                        <Trash2 className='w-4 h-4' />
                      </Button>
                    )}
                  </div>
                </div>

                <div className='flex-1 text-center md:text-left'>
                  <h3 className='text-2xl font-bold mb-0.5'>
                    {user.first_name && user.last_name
                      ? `${user.first_name} ${user.last_name}`
                      : user.username}
                  </h3>
                  <p data-testid="settings-account-username" className='text-white/70 text-base mb-2'>@{user.username}</p>
                  <div className='flex flex-wrap gap-2 justify-center md:justify-start'>
                    <span className='px-3 py-1.5 bg-white/[0.08] backdrop-blur-md text-xs font-semibold border border-white/[0.15] flex items-center gap-1.5'
                      style={{ borderTop: `2px solid ${planName === 'enterprise' ? 'rgba(251,191,36,0.6)' : planName === 'pro' || planName === 'team' ? 'rgba(148,163,184,0.5)' : 'rgba(129,140,248,0.6)'}` }}
                    >
                      {user.role.toUpperCase()}
                    </span>
                    <span className='px-3 py-1.5 bg-white/[0.08] backdrop-blur-md text-xs font-semibold border border-white/[0.15] flex items-center gap-1.5'
                      style={{ borderTop: `2px solid ${planName === 'enterprise' ? 'rgba(251,191,36,0.6)' : planName === 'pro' || planName === 'team' ? 'rgba(148,163,184,0.5)' : 'rgba(129,140,248,0.6)'}` }}
                    >
                      <Diode
                        variant={user.is_active ? 'green' : 'red'}
                        size="sm"
                        pulse={user.is_active}
                        aria-label={user.is_active ? 'Active user' : 'Inactive user'}
                      />
                      {user.is_active ? t('settings.account.accountDetails.active') : t('settings.account.accountDetails.inactive')}
                    </span>
                  </div>
                </div>
              </div>

              {/* Middle Section: Subscription Info */}
              {subscriptionData && (
                <div className='backdrop-blur-md bg-white/[0.06] border border-white/[0.12] p-4 mb-3'>
                  <div className='flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4'>
                    <div className='flex items-center gap-4'>
                      <div className='w-12 h-12 backdrop-blur-sm flex items-center justify-center border border-white/30 bg-white/[0.12]'>
                        {getPlanIcon(subscriptionPlan?.name ?? 'researcher')}
                      </div>
                      <div>
                        <p className='text-sm text-white/70 font-medium flex items-center gap-2'>
                          {subscriptionPlan?.display_name ?? 'Researcher'} Plan
                          {isTrialing && (
                            <span data-testid="account-trial-badge" className='px-1.5 py-0.5 bg-amber-400/20 text-amber-200 border border-amber-300/40 text-[10px] font-semibold uppercase tracking-wide'>
                              {t('settings.account.subscription.trialBadge', 'Trial')} · {trialDaysLeft}d
                            </span>
                          )}
                          {isByok && (
                            <span data-testid="account-byok-badge" className='px-1.5 py-0.5 bg-sky-400/20 text-sky-200 border border-sky-300/40 text-[10px] font-semibold uppercase tracking-wide'>
                              BYOK
                            </span>
                          )}
                        </p>
                        <p className='text-2xl font-bold text-white'>
                          {(subscriptionPlan?.price_monthly ?? 0) === 0
                            ? t('settings.account.subscription.freePlan')
                            : `$${subscriptionPlan?.price_monthly}/${subscriptionData?.subscription?.billing_cycle === 'annual' ? t('settings.account.subscription.annual') : t('settings.account.subscription.monthly')}`}
                        </p>
                      </div>
                    </div>

                    <div className='flex flex-wrap gap-3'>
                      {planName !== 'enterprise' && (
                        <Button
                          className={`font-semibold shadow-lg ${planName === 'pro' || planName === 'team'
                            ? 'bg-white text-slate-700 hover:bg-white/90'
                            : 'bg-white text-blue-600 hover:bg-white/90'
                            }`}
                          onClick={() => navigate('/pricing')}
                        >
                          <TrendingUp className='w-4 h-4 mr-2' />
                          {t('settings.account.subscription.upgrade')}
                        </Button>
                      )}
                      {(subscriptionPlan?.price_monthly ?? 0) > 0 && (
                        <Button
                          variant='outline'
                          className='border-white/50 bg-white/10 text-white hover:bg-white/20 backdrop-blur-sm font-semibold'
                          onClick={async () => {
                            try {
                              const { createPortalSession } = await import('@/lib/api-subscriptions');
                              const { url } = await createPortalSession();
                              window.location.href = url;
                            } catch (err) {
                              console.error('Failed to open billing portal:', err);
                            }
                          }}
                        >
                          <CreditCard className='w-4 h-4 mr-2' />
                          {t('settings.account.subscription.billing')}
                        </Button>
                      )}
                      {refundEligible && (
                        <Button
                          data-testid="account-request-refund-button"
                          variant='outline'
                          className='border-white/30 bg-white/5 text-white/80 hover:bg-white/15 backdrop-blur-sm'
                          onClick={() => setShowRefundConfirm(true)}
                        >
                          {t('settings.account.refund.button', 'Request refund')}
                        </Button>
                      )}
                    </div>
                  </div>
                </div>
              )}

              {/* Bottom Section: Account Details Grid */}
              <div className='backdrop-blur-md bg-white/[0.06] border border-white/[0.12] p-4'>
                <div className='grid grid-cols-1 md:grid-cols-2 gap-6'>
                  {/* Account ID */}
                  <div className='space-y-1.5'>
                    <p className='text-xs font-medium text-white/60 uppercase tracking-wide'>
                      {t('settings.account.accountDetails.accountId')}
                    </p>
                    <p className='font-mono text-sm text-white/90 break-all'>{user.id}</p>
                  </div>

                  {/* Member Since */}
                  <div className='space-y-1.5'>
                    <p className='text-xs font-medium text-white/60 uppercase tracking-wide'>
                      {t('settings.account.accountDetails.memberSince')}
                    </p>
                    <p className='text-sm font-semibold text-white'>
                      {new Date(user.created_at).toLocaleDateString()}
                    </p>
                  </div>

                  {/* Team Collaboration */}
                  <div className='space-y-1.5'>
                    <p className='text-xs font-medium text-white/60 uppercase tracking-wide'>
                      {t('settings.account.teamCollaboration')}
                    </p>
                    <div className='flex items-center gap-2'>
                      <div className={`w-2 h-2 rounded-full ${subscriptionPlan?.features?.shared_workspaces ? 'bg-green-400' : 'bg-white/40'}`} />
                      <p className='text-sm font-semibold text-white'>
                        {subscriptionPlan?.features?.shared_workspaces ? t('settings.account.available') : t('settings.account.notAvailable')}
                      </p>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Profile Information Card */}
        <div className='relative overflow-hidden bg-white dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 shadow-sm'>

          <div className='flex items-center justify-between p-6 pb-4'>
            <div className='flex items-center gap-3'>
              <div className='w-10 h-10 flex items-center justify-center'>
                <UserCircle className='w-5 h-5 text-blue-600 dark:text-blue-400' />
              </div>
              <h3 className='text-lg font-semibold text-zinc-900 dark:text-white'>
                {t('settings.account.profile.title')}
              </h3>
            </div>
            <Button
              variant='ghost'
              size='sm'
              onClick={() => setIsProfileEditExpanded(!isProfileEditExpanded)}
              className='flex items-center gap-2'
            >
              <Edit className='w-4 h-4' />
              {isProfileEditExpanded ? t('settings.account.profile.close') : t('settings.account.profile.editProfile')}
              {isProfileEditExpanded ? <ChevronUp className='w-4 h-4' /> : <ChevronDown className='w-4 h-4' />}
            </Button>
          </div>

          {isProfileEditExpanded && (
            <div className='px-6 pb-6 animate-in slide-in-from-top-2 duration-200'>
              <div className='grid grid-cols-1 md:grid-cols-2 gap-4'>
                <div className='space-y-2'>
                  <Label htmlFor='firstName'>{t('settings.account.profile.firstName')}</Label>
                  <div className='relative'>
                    <User className='absolute left-3 top-3 h-4 w-4 text-zinc-400' />
                    <Input
                      id='firstName'
                      type='text'
                      value={firstName}
                      onChange={(e) => setFirstName(e.target.value)}
                      placeholder='Enter your first name'
                      className='pl-10'
                    />
                  </div>
                </div>

                <div className='space-y-2'>
                  <Label htmlFor='lastName'>{t('settings.account.profile.lastName')}</Label>
                  <div className='relative'>
                    <User className='absolute left-3 top-3 h-4 w-4 text-zinc-400' />
                    <Input
                      id='lastName'
                      type='text'
                      value={lastName}
                      onChange={(e) => setLastName(e.target.value)}
                      placeholder='Enter your last name'
                      className='pl-10'
                    />
                  </div>
                </div>

                <div className='space-y-2'>
                  <Label htmlFor='email'>{t('settings.account.profile.email')}</Label>
                  <div className='relative'>
                    <Mail className='absolute left-3 top-3 h-4 w-4 text-zinc-400' />
                    <Input
                      id='email'
                      type='email'
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      placeholder='Enter your email address'
                      className='pl-10'
                    />
                  </div>
                </div>

                <div className='space-y-2'>
                  <Label htmlFor='username'>{t('settings.account.profile.username')}</Label>
                  <div className='relative'>
                    <User className='absolute left-3 top-3 h-4 w-4 text-zinc-400' />
                    <Input
                      id='username'
                      type='text'
                      value={username}
                      disabled
                      className='pl-10 bg-zinc-50 dark:bg-zinc-900 text-zinc-500'
                    />
                  </div>
                  <p className='text-xs text-zinc-500 dark:text-zinc-400'>
                    {t('settings.account.profile.usernameNote')}
                  </p>
                </div>
              </div>

              {/* Password Change Section - Integrated */}
              <div className='border-t border-zinc-200 dark:border-zinc-800 mt-8 pt-6'>
                <div className='flex items-center gap-2 mb-4'>
                  <Lock className='w-4 h-4 text-zinc-500 dark:text-zinc-400' />
                  <h4 className='text-sm font-medium text-zinc-700 dark:text-zinc-300'>
                    {user?.has_password === false
                      ? t('settings.account.security.setPassword')
                      : t('settings.account.security.title')}
                  </h4>
                </div>
                {user?.has_password === false && (
                  <p className='text-sm text-zinc-600 dark:text-zinc-400 mb-4'>
                    {t('settings.account.security.oauthPasswordMessage')}
                  </p>
                )}

                <div className='grid grid-cols-1 lg:grid-cols-3 gap-4 max-w-4xl'>
                  {user?.has_password !== false && (
                    <div className='space-y-2'>
                      <Label htmlFor='currentPassword'>{t('settings.account.security.currentPassword')}</Label>
                      <div className='relative'>
                        <Lock className='absolute left-3 top-3 h-4 w-4 text-zinc-400' />
                        <Input
                          id='currentPassword'
                          type={showCurrentPassword ? 'text' : 'password'}
                          value={currentPassword}
                          onChange={(e) => setCurrentPassword(e.target.value)}
                          placeholder={t('settings.account.security.currentPasswordPlaceholder')}
                          className='pl-10 pr-10'
                        />
                        <button
                          type='button'
                          onClick={() => setShowCurrentPassword(!showCurrentPassword)}
                          className='absolute right-3 top-3 text-zinc-400 hover:text-zinc-600'
                        >
                          {showCurrentPassword ? <EyeOff className='h-4 w-4' /> : <Eye className='h-4 w-4' />}
                        </button>
                      </div>
                    </div>
                  )}

                  <div className='space-y-2'>
                    <Label htmlFor='newPassword'>{t('settings.account.newPassword')}</Label>
                    <div className='relative'>
                      <Lock className='absolute left-3 top-3 h-4 w-4 text-zinc-400' />
                      <Input
                        id='newPassword'
                        type={showNewPassword ? 'text' : 'password'}
                        value={newPassword}
                        onChange={(e) => setNewPassword(e.target.value)}
                        placeholder={t('settings.account.enterNewPasswordPlaceholder')}
                        className='pl-10 pr-10'
                      />
                      <button
                        type='button'
                        onClick={() => setShowNewPassword(!showNewPassword)}
                        className='absolute right-3 top-3 text-zinc-400 hover:text-zinc-600'
                      >
                        {showNewPassword ? <EyeOff className='h-4 w-4' /> : <Eye className='h-4 w-4' />}
                      </button>
                    </div>
                    {newPassword && newPassword.length < 8 && (
                      <div className='flex items-center gap-2 text-sm text-orange-600 dark:text-orange-400'>
                        <AlertCircle className='h-4 w-4' />
                        {t('settings.account.security.passwordTooShort')}
                      </div>
                    )}
                  </div>

                  <div className='space-y-2'>
                    <Label htmlFor='confirmPassword'>{t('settings.account.confirmNewPassword')}</Label>
                    <div className='relative'>
                      <Lock className='absolute left-3 top-3 h-4 w-4 text-zinc-400' />
                      <Input
                        id='confirmPassword'
                        type={showConfirmPassword ? 'text' : 'password'}
                        value={confirmPassword}
                        onChange={(e) => setConfirmPassword(e.target.value)}
                        placeholder={t('settings.account.confirmNewPasswordPlaceholder')}
                        className='pl-10 pr-10'
                      />
                      <button
                        type='button'
                        onClick={() => setShowConfirmPassword(!showConfirmPassword)}
                        className='absolute right-3 top-3 text-zinc-400 hover:text-zinc-600'
                      >
                        {showConfirmPassword ? <EyeOff className='h-4 w-4' /> : <Eye className='h-4 w-4' />}
                      </button>
                    </div>
                    {confirmPassword && newPassword !== confirmPassword && (
                      <div className='flex items-center gap-2 text-sm text-red-600 dark:text-red-400'>
                        <AlertCircle className='h-4 w-4' />
                        {t('settings.account.security.passwordsNoMatch')}
                      </div>
                    )}
                    {confirmPassword && newPassword === confirmPassword && newPassword.length >= 8 && (
                      <div className='flex items-center gap-2 text-sm text-green-600 dark:text-green-400'>
                        <CheckCircle className='h-4 w-4' />
                        {t('settings.account.security.passwordsMatch')}
                      </div>
                    )}
                  </div>
                </div>

                {/* Action Buttons */}
                <div className='flex flex-col sm:flex-row justify-between gap-3 mt-6 pt-4 border-t border-zinc-100 dark:border-zinc-800'>
                  <Button
                    onClick={handleUpdateProfile}
                    disabled={!profileChanged || isSaving}
                    className='flex items-center gap-2'
                  >
                    {isSaving ? (
                      <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white"></div>
                    ) : (
                      <Save className='w-4 h-4' />
                    )}
                    {isSaving ? t('settings.account.profile.saving') : t('settings.account.profile.saveChanges')}
                  </Button>

                  <Button
                    onClick={handleChangePassword}
                    disabled={!passwordValid || isChangingPassword}
                    variant='outline'
                    className='flex items-center gap-2'
                  >
                    {isChangingPassword ? (
                      <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-current"></div>
                    ) : (
                      <Lock className='w-4 h-4' />
                    )}
                    {isChangingPassword ? 'Changing...' : 'Change Password'}
                  </Button>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Usage Statistics */}
        {subscriptionData && (
          <div className='grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4'>
            {/* Documents Card */}
            <div className='group relative overflow-hidden bg-gradient-to-br from-white to-zinc-50 dark:from-zinc-900 dark:to-zinc-950 border border-zinc-200 dark:border-zinc-800 p-4 hover:shadow-lg transition-all duration-300'>
              <div className='relative'>
                <div className='flex items-center justify-between mb-4'>
                  <div className='flex items-center gap-3'>
                    <div className={`w-12 h-12 flex items-center justify-center ${planName === 'pro' || planName === 'team'
                      ? 'bg-slate-100 dark:bg-slate-950'
                      : 'bg-zinc-100 dark:bg-zinc-900'
                      }`}>
                      <FileText className={`w-6 h-6 ${planName === 'pro' || planName === 'team'
                        ? 'text-slate-600 dark:text-slate-400'
                        : 'text-zinc-600 dark:text-zinc-400'
                        }`} />
                    </div>
                    <div>
                      <p className='text-sm font-medium text-zinc-600 dark:text-zinc-400'>
                        {t('settings.account.usage.documents')}
                      </p>
                      <h4 className='text-2xl font-bold text-zinc-900 dark:text-white'>
                        {subscriptionData?.usage?.documents_count ?? 0}
                      </h4>
                    </div>
                  </div>
                  <div className='text-right'>
                    <p className='text-xs text-zinc-500 dark:text-zinc-500'>{t('settings.account.usage.limit')}</p>
                    <p className='text-lg font-semibold text-zinc-700 dark:text-zinc-300'>
                      {subscriptionPlan?.documents_limit || '∞'}
                    </p>
                  </div>
                </div>

                <div className='space-y-2'>
                  <div className='flex justify-between text-xs font-medium'>
                    <span className='text-zinc-600 dark:text-zinc-400'>{t('settings.account.usage.usage')}</span>
                    <span className={`${documentsPercentage >= 80
                      ? 'text-orange-600 dark:text-orange-400'
                      : planName === 'pro' || planName === 'team'
                        ? 'text-slate-600 dark:text-slate-400'
                        : 'text-zinc-600 dark:text-zinc-400'
                      }`}>
                      {Math.round(documentsPercentage)}%
                    </span>
                  </div>
                  <div className='relative h-3 bg-zinc-200 dark:bg-zinc-800 rounded-full overflow-hidden'>
                    <div
                      className={`absolute inset-y-0 left-0 ${getUsageColor(documentsPercentage, planName === 'pro' || planName === 'team')} rounded-full transition-all duration-700 ease-out`}
                      style={{ width: `${documentsPercentage}%` }}
                    >
                      <div className='absolute inset-0 bg-gradient-to-r from-transparent to-white/20' />
                    </div>
                  </div>
                </div>
              </div>
            </div>

            {/* Tokens Card */}
            <div className='group relative overflow-hidden bg-gradient-to-br from-white to-zinc-50 dark:from-zinc-900 dark:to-zinc-950 border border-zinc-200 dark:border-zinc-800 p-4 hover:shadow-lg transition-all duration-300'>
              <div className='relative'>
                <div className='flex items-center justify-between mb-4'>
                  <div className='flex items-center gap-3'>
                    <div className={`w-12 h-12 flex items-center justify-center ${planName === 'pro' || planName === 'team'
                      ? 'bg-slate-100 dark:bg-slate-950'
                      : 'bg-zinc-100 dark:bg-zinc-900'
                      }`}>
                      <Zap className={`w-6 h-6 ${planName === 'pro' || planName === 'team'
                        ? 'text-slate-600 dark:text-slate-400'
                        : 'text-zinc-600 dark:text-zinc-400'
                        }`} />
                    </div>
                    <div>
                      <p className='text-sm font-medium text-zinc-600 dark:text-zinc-400'>
                        {t('settings.account.usage.tokens')}
                      </p>
                      <h4 className='text-2xl font-bold text-zinc-900 dark:text-white'>
                        {((subscriptionData?.usage?.tokens_used ?? 0) / 1000).toFixed(0)}K
                      </h4>
                    </div>
                  </div>
                  <div className='text-right'>
                    <p className='text-xs text-zinc-500 dark:text-zinc-500'>{t('settings.account.usage.limit')}</p>
                    <p className='text-lg font-semibold text-zinc-700 dark:text-zinc-300'>
                      {subscriptionPlan?.tokens_limit ? (subscriptionPlan.tokens_limit / 1000).toFixed(0) + 'K' : '∞'}
                    </p>
                  </div>
                </div>

                <div className='space-y-2'>
                  <div className='flex justify-between text-xs font-medium'>
                    <span className='text-zinc-600 dark:text-zinc-400'>{t('settings.account.usage.usage')}</span>
                    <span className={`${tokensPercentage >= 80
                      ? 'text-orange-600 dark:text-orange-400'
                      : planName === 'pro' || planName === 'team'
                        ? 'text-slate-600 dark:text-slate-400'
                        : 'text-zinc-600 dark:text-zinc-400'
                      }`}>
                      {Math.round(tokensPercentage)}%
                    </span>
                  </div>
                  <div className='relative h-3 bg-zinc-200 dark:bg-zinc-800 rounded-full overflow-hidden'>
                    <div
                      className={`absolute inset-y-0 left-0 ${getUsageColor(tokensPercentage, planName === 'pro' || planName === 'team')} rounded-full transition-all duration-700 ease-out`}
                      style={{ width: `${tokensPercentage}%` }}
                    >
                      <div className='absolute inset-0 bg-gradient-to-r from-transparent to-white/20' />
                    </div>
                  </div>
                </div>
              </div>
            </div>

            {/* Storage Card */}
            <div data-testid="settings-account-storage" className='group relative overflow-hidden bg-gradient-to-br from-white to-zinc-50 dark:from-zinc-900 dark:to-zinc-950 border border-zinc-200 dark:border-zinc-800 p-4 hover:shadow-lg transition-all duration-300'>
              {storageQuota?.breakdown && (
                <Popover modal>
                  <PopoverTrigger asChild>
                    <button className='absolute top-2 right-2 w-5 h-5 rounded-full bg-zinc-200 dark:bg-zinc-700 text-zinc-500 dark:text-zinc-400 flex items-center justify-center text-[10px] font-bold hover:bg-zinc-300 dark:hover:bg-zinc-600 transition-colors z-10' aria-label='Storage breakdown'>
                      i
                    </button>
                  </PopoverTrigger>
                  <PopoverContent side='bottom' align='end' className='w-auto text-xs space-y-1 p-2 z-[9999]'>
                    <div className='flex justify-between gap-4'>
                      <span className='text-muted-foreground'>{t('settings.account.usage.filesOnDisk')}</span>
                      <span className='font-medium'>{formatBytes(storageQuota.breakdown.disk_bytes)}</span>
                    </div>
                    <div className='flex justify-between gap-4'>
                      <span className='text-muted-foreground'>{t('settings.account.usage.databaseContent')}</span>
                      <span className='font-medium'>{formatBytes(storageQuota.breakdown.db_content_bytes)}</span>
                    </div>
                    <div className='flex justify-between gap-4'>
                      <span className='text-muted-foreground'>{t('settings.account.usage.thumbnails')}</span>
                      <span className='font-medium'>{formatBytes(storageQuota.breakdown.thumbnail_bytes)}</span>
                    </div>
                  </PopoverContent>
                </Popover>
              )}
              <div className='relative'>
                <div className='flex items-center justify-between mb-4'>
                  <div className='flex items-center gap-3'>
                    <div className={`w-12 h-12 flex items-center justify-center ${planName === 'pro' || planName === 'team'
                      ? 'bg-slate-100 dark:bg-slate-950'
                      : 'bg-zinc-100 dark:bg-zinc-900'
                      }`}>
                      <HardDrive className={`w-6 h-6 ${planName === 'pro' || planName === 'team'
                        ? 'text-slate-600 dark:text-slate-400'
                        : 'text-zinc-600 dark:text-zinc-400'
                        }`} />
                    </div>
                    <div>
                      <p className='text-sm font-medium text-zinc-600 dark:text-zinc-400'>
                        {t('settings.account.usage.storage')}
                      </p>
                      <h4 className='text-2xl font-bold text-zinc-900 dark:text-white'>
                        {isLoadingStorage ? (
                          <span className='text-sm'>Loading...</span>
                        ) : storageQuota ? (
                          formatBytes(storageQuota.current_usage_bytes)
                        ) : (
                          '0 GB'
                        )}
                      </h4>
                    </div>
                  </div>
                  <div className='text-right'>
                    <p className='text-xs text-zinc-500 dark:text-zinc-500'>{t('settings.account.usage.limit')}</p>
                    <p className='text-lg font-semibold text-zinc-700 dark:text-zinc-300'>
                      {isLoadingStorage ? (
                        '...'
                      ) : storageQuota?.limit_gb ? (
                        `${storageQuota.limit_gb.toFixed(0)} GB`
                      ) : (
                        '∞'
                      )}
                    </p>
                  </div>
                </div>

                <div className='space-y-2'>
                  <div className='flex justify-between text-xs font-medium'>
                    <span className='text-zinc-600 dark:text-zinc-400'>{t('settings.account.usage.usage')}</span>
                    <span className={`${(storageQuota?.percentage_used ?? 0) >= 80
                      ? 'text-orange-600 dark:text-orange-400'
                      : planName === 'pro' || planName === 'team'
                        ? 'text-slate-600 dark:text-slate-400'
                        : 'text-zinc-600 dark:text-zinc-400'
                      }`}>
                      {isLoadingStorage ? '...' : storageQuota?.percentage_used ? `${Math.round(storageQuota.percentage_used)}%` : '0%'}
                    </span>
                  </div>
                  <div className='relative h-3 bg-zinc-200 dark:bg-zinc-800 rounded-full overflow-hidden'>
                    <div
                      className={`absolute inset-y-0 left-0 ${getStorageColor(storageQuota?.percentage_used ?? null)} rounded-full transition-all duration-700 ease-out`}
                      style={{ width: `${storageQuota?.percentage_used ?? 0}%` }}
                    >
                      <div className='absolute inset-0 bg-gradient-to-r from-transparent to-white/20' />
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Usage Alert */}
        {subscriptionData && (documentsPercentage >= 80 || tokensPercentage >= 80 || (storageQuota?.percentage_used ?? 0) >= 80) && (
          <div className='relative overflow-hidden bg-gradient-to-r from-orange-50 to-amber-50 dark:from-orange-950/30 dark:to-amber-950/30 border border-orange-200 dark:border-orange-800 p-5'>
            <div className='flex items-start gap-4'>
              <div className='w-10 h-10 bg-orange-500/10 dark:bg-orange-500/20 flex items-center justify-center mt-1 flex-shrink-0'>
                <TrendingUp className='w-5 h-5 text-orange-600 dark:text-orange-400' />
              </div>
              <div className='flex-1'>
                <h4 className='text-sm font-semibold text-orange-900 dark:text-orange-200 mb-1'>
                  {t('settings.account.usage.approaching')}
                </h4>
                <p className='text-sm text-orange-700 dark:text-orange-300/90'>
                  {t('settings.account.usage.approachingDesc', {
                    percent: Math.max(Math.round(documentsPercentage), Math.round(tokensPercentage))
                  })}
                </p>
              </div>
              <Button
                size='sm'
                className='bg-orange-600 hover:bg-orange-700 text-white'
                onClick={() => navigate('/pricing')}
              >
                {t('settings.account.subscription.upgrade')}
              </Button>
            </div>
          </div>
        )}
      </div>

      {/* Profile Picture Upload Dialog */}
      <ProfilePictureUpload
        open={showProfilePictureUpload}
        onOpenChange={setShowProfilePictureUpload}
        onUploadSuccess={handleProfilePictureUploadSuccess}
      />

      {/* Profile Picture Preview Dialog */}
      {user?.profile_picture && (
        <div
          className={`fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4 transition-opacity duration-200 ${showProfilePicturePreview ? 'opacity-100' : 'opacity-0 pointer-events-none'
            }`}
          onClick={() => setShowProfilePicturePreview(false)}
        >
          <div className='relative max-w-4xl max-h-[90vh] w-full h-full flex items-center justify-center'>
            <ProfileImg
              pic={user.profile_picture}
              cacheBuster={profilePictureCacheBuster}
              alt={`${user.first_name || user.username || 'User'}'s profile picture`}
              className='max-w-full max-h-full object-contain rounded-lg shadow-2xl'
              onClick={(e) => e.stopPropagation()}
            />
            <Button
              variant='secondary'
              size='icon'
              onClick={() => setShowProfilePicturePreview(false)}
              className='absolute top-4 right-4 w-10 h-10 rounded-full bg-white/90 hover:bg-white text-zinc-900 shadow-lg'
            >
              <X className='w-5 h-5' />
            </Button>
          </div>
        </div>
      )}

      {/* 30-day money-back guarantee */}
      <ConfirmDialog
        open={showRefundConfirm}
        onOpenChange={setShowRefundConfirm}
        title={t('settings.account.refund.confirmTitle', 'Request a full refund?')}
        description={t('settings.account.refund.confirmDescription', 'Your latest payment will be refunded, the subscription cancelled immediately, and your account reverted to the free Researcher plan.')}
        confirmLabel={t('settings.account.refund.confirmLabel', 'Refund & downgrade')}
        onConfirm={handleRefund}
        isDangerous
        isLoading={isRefunding}
        confirmButtonTestId='account-refund-confirm'
      />
    </div>
  );
};
