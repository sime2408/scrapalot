import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
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
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import {
  User as UserIcon,
  Mail,
  Calendar,
  Shield,
  Save,
  Trash2,
  Power,
  PowerOff,
  Key,
  Building2,
  FolderOpen,
  AlertTriangle,
  Loader2,
  CheckCircle2,
  XCircle,
  Upload,
  CreditCard,
} from 'lucide-react';
import type { User } from '@/lib/api-users';
import { adminUpdateUser, adminDeleteUser, adminToggleUserStatus, adminResetPassword, adminGetUserWorkspaces, deleteProfilePicture as deleteUserProfilePicture } from '@/lib/api-users';
import { getCollections } from '@/lib/api-collections';
import { type SubscriptionPlan } from '@/lib/api-subscriptions';
import { api } from '@/lib/api';
import { profilePicSources } from '@/lib/profile-picture';
import { Switch } from '@/components/ui/switch';
import { Separator } from '@/components/ui/separator';
import { ProfilePictureUpload } from '@/components/profile-picture-upload';

interface UserDetailFormProps {
  user: User | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onUserUpdated: () => void;
}

export const SettingsTabUsersForm: React.FC<UserDetailFormProps> = ({
  user,
  open,
  onOpenChange,
  onUserUpdated,
}) => {
  const { t } = useTranslation();

  // Form state
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [email, setEmail] = useState('');
  const [role, setRole] = useState('user');
  const [isActive, setIsActive] = useState(true);
  const [billingExempt, setBillingExempt] = useState(false);
  const [subscriptionPlanName, setSubscriptionPlanName] = useState('researcher');
  const [availablePlans, setAvailablePlans] = useState<SubscriptionPlan[]>([]);

  // UI state
  const [isSaving, setIsSaving] = useState(false);
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [showToggleStatusDialog, setShowToggleStatusDialog] = useState(false);
  const [showProfilePictureUpload, setShowProfilePictureUpload] = useState(false);
  const [profilePictureCacheBuster, setProfilePictureCacheBuster] = useState(Date.now());

  // Password reset state
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [isResettingPassword, setIsResettingPassword] = useState(false);

  // Data state
  const [workspaces, setWorkspaces] = useState<{ id: string; name: string }[]>([]);
  const [collections, setCollections] = useState<{ id: string; name: string }[]>([]);
  const [loadingWorkspaces, setLoadingWorkspaces] = useState(false);
  const [localUser, setLocalUser] = useState<User | null>(user);

  // Load user data into form
  useEffect(() => {
    if (user) {
      setLocalUser(user);
      setFirstName(user.first_name || '');
      setLastName(user.last_name || '');
      setEmail(user.email || '');
      // Normalize role to lowercase for select component
      setRole((user.role || 'user').toLowerCase());
      setIsActive(user.is_active);
      setBillingExempt(user.billing_exempt || false);
      setSubscriptionPlanName(user.subscription_plan_name || 'researcher');
    }
  }, [user]);

  // Load user's workspaces and collections
  useEffect(() => {
    const loadUserData = async () => {
      if (!user || !open) return;

      setLoadingWorkspaces(true);
      // The EDITED user's own (owned + shared) workspaces — not the admin's.
      // getWorkspaces() returned the caller's workspaces, which made every
      // edited user appear to have 0 relevant workspaces. Load the two stats
      // independently: getCollections() can 404 (admin's current workspace has
      // none), and a single Promise.all let that failure swallow the workspace
      // result too, leaving the count stuck at 0.
      try {
        const workspacesData = await adminGetUserWorkspaces(user.id);
        setWorkspaces(workspacesData.map(w => ({ id: w.id, name: w.name })));
      } catch (error) {
        console.error('Error loading user workspaces:', error);
      }
      try {
        const collectionsData = await getCollections();
        setCollections(Array.isArray(collectionsData) ? collectionsData : collectionsData.collections || []);
      } catch {
        setCollections([]);
      } finally {
        setLoadingWorkspaces(false);
      }
    };

    void loadUserData();
  }, [user, open]);

  // Load subscription plans separately (independent of workspace/collection loading)
  useEffect(() => {
    if (!open) return;
    api.get('/subscriptions/plans')
      .then(r => {
        const plans = (r.data as SubscriptionPlan[]).filter(p => p.is_active);
        setAvailablePlans(plans);
      })
      .catch(err => console.error('Error loading subscription plans:', err));
  }, [open]);

  // Get user initials for avatar
  const getUserInitials = (user: User) => {
    const firstName = user.first_name || '';
    const lastName = user.last_name || '';
    if (firstName && lastName) {
      return `${firstName[0]}${lastName[0]}`.toUpperCase();
    } else if (firstName) {
      return firstName[0].toUpperCase();
    } else if (user.email) {
      return user.email[0].toUpperCase();
    }
    return 'U';
  };

  // Handle save
  const handleSave = async () => {
    if (!user) return;

    setIsSaving(true);
    try {
      await adminUpdateUser(user.id, {
        first_name: firstName,
        last_name: lastName,
        email,
        role,
        is_active: isActive,
        billing_exempt: billingExempt,
        subscription_plan_name: subscriptionPlanName,
      });
      onUserUpdated();
    } catch (error) {
      console.error('Error updating user:', error);
    } finally {
      setIsSaving(false);
    }
  };

  // Handle delete
  const handleDelete = async () => {
    if (!user) return;

    try {
      await adminDeleteUser(user.id);
      setShowDeleteDialog(false);
      onOpenChange(false);
      onUserUpdated();
    } catch (error) {
      console.error('Error deleting user:', error);
    }
  };

  // Handle toggle status
  const handleToggleStatus = async () => {
    if (!user) return;

    try {
      await adminToggleUserStatus(user.id, !isActive);
      setIsActive(!isActive);
      setShowToggleStatusDialog(false);
      onUserUpdated();
    } catch (error) {
      console.error('Error toggling user status:', error);
    }
  };

  // Handle admin password reset
  const handleResetPassword = async () => {
    if (!user) return;
    if (newPassword.length < 8) return;
    if (newPassword !== confirmPassword) return;

    setIsResettingPassword(true);
    try {
      await adminResetPassword(user.id, newPassword);
      setNewPassword('');
      setConfirmPassword('');
    } catch (error) {
      console.error('Error resetting password:', error);
    } finally {
      setIsResettingPassword(false);
    }
  };

  // Handle profile picture upload success (admin uploading for specific user)
  const handleProfilePictureUploadSuccess = async () => {
    if (!user) return;
    try {
      // Note: ProfilePictureUpload component uploads for current user
      // For admin editing another user, we'd need a different approach
      // For now, refresh the user data
      setProfilePictureCacheBuster(Date.now());
      onUserUpdated();
    } catch (error) {
      console.error('Error reloading user data:', error);
    }
  };

  // Handle profile picture deletion
  const handleDeleteProfilePicture = async () => {
    if (!user) return;
    try {
      // Delete profile picture for the user being edited
      // Note: deleteUserProfilePicture deletes for current user
      // For admin functionality, backend needs admin endpoint
      await deleteUserProfilePicture();
      setProfilePictureCacheBuster(Date.now());
      onUserUpdated();
    } catch (error) {
      console.error('Error deleting profile picture:', error);
    }
  };

  if (!user) return null;

  return (
    <>
      <Sheet open={open} onOpenChange={onOpenChange} modal={true}>
        <SheetContent
          className="sm:max-w-[600px] bg-white/70 dark:bg-zinc-900/60 border-zinc-200/50 dark:border-zinc-700/50 p-0 flex flex-col h-full overflow-hidden z-[10000]"
          overlayClassName="bg-black/40 z-[9999]"
          style={{ pointerEvents: 'auto' }}
          onFocusOutside={(e) => e.preventDefault()}
        >
          {/* Header - Fixed */}
          <SheetHeader className="px-6 py-6 border-b border-zinc-200 dark:border-zinc-800 flex-shrink-0">
            <SheetTitle>{t('settings.users.details.title', 'User Details')}</SheetTitle>
            <SheetDescription>
              {t('settings.users.details.description', 'View and manage user information')}
            </SheetDescription>
          </SheetHeader>

          {/* Content - Scrollable */}
          <div
            className="flex-1 overflow-y-auto px-6 py-6"
            style={{ pointerEvents: 'auto' }}
            onWheel={(e) => e.stopPropagation()}
          >
            <div className="space-y-6">
              {/* Profile Section */}
              <div className="flex items-center gap-5">
                <div className="group relative flex-shrink-0">
                  <div className="p-0.5 rounded-full bg-gradient-to-br from-primary/30 via-primary/10 to-transparent">
                    <Avatar className="w-20 h-20 border-2 border-white dark:border-zinc-900">
                      <AvatarImage
                        {...profilePicSources(localUser?.profile_picture, profilePictureCacheBuster)}
                        alt={user.username}
                      />
                      <AvatarFallback className="bg-primary/10 text-primary text-xl font-bold">
                        {getUserInitials(user)}
                      </AvatarFallback>
                    </Avatar>
                  </div>
                  {/* Hover overlay with backdrop */}
                  <div className="absolute inset-0 flex items-center justify-center gap-1.5 rounded-full opacity-0 group-hover:opacity-100 transition-opacity duration-200 bg-black/30 backdrop-blur-[2px] pointer-events-none">
                    <Button
                      variant="secondary"
                      size="icon"
                      onClick={(e) => {
                        e.stopPropagation();
                        setShowProfilePictureUpload(true);
                      }}
                      className="w-8 h-8 rounded-full bg-white/90 hover:bg-white text-primary shadow-md pointer-events-auto"
                      title={localUser?.profile_picture ? 'Change profile picture' : 'Upload profile picture'}
                    >
                      <Upload className="w-3.5 h-3.5" />
                    </Button>
                    {localUser?.profile_picture && (
                      <Button
                        variant="secondary"
                        size="icon"
                        onClick={(e) => {
                          e.stopPropagation();
                          void handleDeleteProfilePicture();
                        }}
                        className="w-8 h-8 rounded-full bg-red-500/90 hover:bg-red-600 text-white shadow-md pointer-events-auto"
                        title="Remove profile picture"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </Button>
                    )}
                  </div>
                </div>
                <div className="flex-1 min-w-0">
                  <h3 className="text-lg font-semibold text-zinc-900 dark:text-white truncate">
                    {user.first_name && user.last_name
                      ? `${user.first_name} ${user.last_name}`
                      : user.username}
                  </h3>
                  <p className="text-sm text-zinc-500 dark:text-zinc-400 truncate">@{user.username}</p>
                  <div className="flex items-center gap-2 mt-2">
                    <Badge className={`${user.role === 'admin' ? 'bg-primary/10 text-primary border-primary/20' : 'bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-400 border-zinc-200 dark:border-zinc-700'} border text-xs`}>
                      <Shield className="w-3 h-3 mr-1" />
                      {user.role}
                    </Badge>
                    {user.is_active ? (
                      <div className="flex items-center gap-1 px-2 py-0.5 bg-green-50 dark:bg-green-900/20 text-green-700 dark:text-green-400 rounded-full text-xs border border-green-200 dark:border-green-800">
                        <CheckCircle2 className="w-3 h-3" />
                        {t('settings.users.status.active', 'Active')}
                      </div>
                    ) : (
                      <div className="flex items-center gap-1 px-2 py-0.5 bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-400 rounded-full text-xs border border-red-200 dark:border-red-800">
                        <XCircle className="w-3 h-3" />
                        {t('settings.users.status.inactive', 'Inactive')}
                      </div>
                    )}
                    {user.billing_exempt && (
                      <div className="flex items-center gap-1 px-2 py-0.5 bg-amber-50 dark:bg-amber-900/20 text-amber-700 dark:text-amber-400 rounded-full text-xs border border-amber-200 dark:border-amber-800">
                        <CreditCard className="w-3 h-3" />
                        {t('settings.users.details.exempt', 'Exempt')}
                      </div>
                    )}
                  </div>
                </div>
              </div>

              <Separator />

              {/* Edit Form */}
              <div className="space-y-4">
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label htmlFor="firstName">
                      {t('settings.account.profile.firstName', 'First Name')}
                    </Label>
                    <div className="relative">
                      <UserIcon className="absolute left-3 top-3 h-4 w-4 text-zinc-400" />
                      <Input
                        id="firstName"
                        value={firstName}
                        onChange={(e) => setFirstName(e.target.value)}
                        className="pl-10"
                        data-testid="settings-user-form-first-name"
                      />
                    </div>
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="lastName">
                      {t('settings.account.profile.lastName', 'Last Name')}
                    </Label>
                    <div className="relative">
                      <UserIcon className="absolute left-3 top-3 h-4 w-4 text-zinc-400" />
                      <Input
                        id="lastName"
                        value={lastName}
                        onChange={(e) => setLastName(e.target.value)}
                        className="pl-10"
                        data-testid="settings-user-form-last-name"
                      />
                    </div>
                  </div>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="email">
                    {t('settings.account.profile.email', 'Email')}
                  </Label>
                  <div className="relative">
                    <Mail className="absolute left-3 top-3 h-4 w-4 text-zinc-400" />
                    <Input
                      id="email"
                      type="email"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      className="pl-10"
                      data-testid="settings-user-form-email"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label htmlFor="role">{t('settings.users.table.role', 'Role')}</Label>
                    <Select value={role} onValueChange={setRole}>
                      <SelectTrigger data-testid="settings-user-form-role-select">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent style={{ zIndex: 10001 }}>
                        <SelectItem value="admin">{t('settings.users.roles.admin', 'Admin')}</SelectItem>
                        <SelectItem value="user">{t('settings.users.roles.user', 'User')}</SelectItem>
                        <SelectItem value="viewer">{t('settings.users.roles.viewer', 'Viewer')}</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="space-y-2">
                    <Label>{t('settings.users.table.status', 'Status')}</Label>
                    <div className="flex items-center h-10">
                      <Badge variant="outline" className="text-sm">
                        {isActive ? t('settings.users.status.active', 'Active') : t('settings.users.status.inactive', 'Inactive')}
                      </Badge>
                    </div>
                  </div>
                </div>
              </div>

              <Separator />

              {/* Billing & Subscription */}
              <div className="space-y-4">
                <h4 className="text-sm font-semibold text-zinc-900 dark:text-white flex items-center gap-2">
                  <CreditCard className="w-4 h-4" />
                  {t('settings.users.details.billing', 'Billing & Subscription')}
                </h4>

                <div className="flex items-center justify-between">
                  <div className="space-y-0.5">
                    <Label htmlFor="billingExempt">
                      {t('settings.users.details.billingExempt', 'Billing Exempt')}
                    </Label>
                    <p className="text-xs text-zinc-500 dark:text-zinc-400">
                      {t('settings.users.details.billingExemptDescription', 'User will not be charged through Stripe. Quotas still apply based on selected plan.')}
                    </p>
                  </div>
                  <Switch
                    id="billingExempt"
                    checked={billingExempt}
                    onCheckedChange={setBillingExempt}
                    data-testid="settings-user-form-billing-exempt-toggle"
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="subscriptionPlan">
                    {t('settings.users.details.subscriptionPlan', 'Subscription Plan')}
                  </Label>
                  <Select value={subscriptionPlanName} onValueChange={setSubscriptionPlanName}>
                    <SelectTrigger data-testid="settings-user-form-subscription-plan-select">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent style={{ zIndex: 10001 }}>
                      {availablePlans.map(plan => (
                        <SelectItem key={plan.id} value={plan.name}>
                          {plan.display_name || plan.name}
                          {typeof plan.price_monthly === 'number' && plan.price_monthly > 0
                            ? ` ($${plan.price_monthly}/mo)`
                            : ' (Free)'}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <Separator />

              {/* Account Information */}
              <div className="space-y-3">
                <h4 className="text-sm font-semibold text-zinc-900 dark:text-white flex items-center gap-2">
                  <Shield className="w-4 h-4" />
                  {t('settings.users.details.accountInfo', 'Account Information')}
                </h4>
                <div className="grid grid-cols-2 gap-4 text-sm">
                  <div>
                    <p className="text-zinc-500 dark:text-zinc-400 text-xs mb-1">
                      {t('settings.users.table.created', 'Created')}
                    </p>
                    <div className="flex items-center gap-2">
                      <Calendar className="w-4 h-4 text-zinc-400" />
                      <span className="text-zinc-900 dark:text-white">
                        {new Date(user.created_at).toLocaleDateString()}
                      </span>
                    </div>
                  </div>
                  <div>
                    <p className="text-zinc-500 dark:text-zinc-400 text-xs mb-1">
                      {t('settings.users.table.auth', 'Auth')}
                    </p>
                    <div className="flex items-center gap-2">
                      <Key className="w-4 h-4 text-zinc-400" />
                      <span className="text-zinc-900 dark:text-white">
                        {user.has_password ? t('settings.users.auth.password', 'Password') : t('settings.users.auth.oauth', 'OAuth')}
                      </span>
                    </div>
                  </div>
                </div>
              </div>

              <Separator />

              {/* Reset Password */}
              <div className="space-y-3">
                <h4 className="text-sm font-semibold text-zinc-900 dark:text-white flex items-center gap-2">
                  <Key className="w-4 h-4" />
                  {t('settings.users.details.resetPassword', 'Reset Password')}
                </h4>
                <div className="space-y-3">
                  <div className="space-y-2">
                    <Label htmlFor="newPassword">
                      {t('settings.users.details.newPassword', 'New Password')}
                    </Label>
                    <Input
                      id="newPassword"
                      type="password"
                      value={newPassword}
                      onChange={(e) => setNewPassword(e.target.value)}
                      placeholder={t('settings.users.details.newPasswordPlaceholder', 'Minimum 8 characters')}
                      data-testid="settings-user-form-new-password"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="confirmPassword">
                      {t('settings.users.details.confirmPassword', 'Confirm Password')}
                    </Label>
                    <Input
                      id="confirmPassword"
                      type="password"
                      value={confirmPassword}
                      onChange={(e) => setConfirmPassword(e.target.value)}
                      placeholder={t('settings.users.details.confirmPasswordPlaceholder', 'Re-enter password')}
                      data-testid="settings-user-form-confirm-password"
                    />
                  </div>
                  {newPassword && confirmPassword && newPassword !== confirmPassword && (
                    <p className="text-xs text-red-500">
                      {t('settings.users.details.passwordMismatch', 'Passwords do not match')}
                    </p>
                  )}
                  {newPassword && newPassword.length < 8 && (
                    <p className="text-xs text-red-500">
                      {t('settings.users.details.passwordTooShort', 'Password must be at least 8 characters')}
                    </p>
                  )}
                  <Button
                    variant="outline"
                    onClick={handleResetPassword}
                    disabled={isResettingPassword || newPassword.length < 8 || newPassword !== confirmPassword}
                    className="w-full"
                    data-testid="settings-user-form-reset-password-button"
                  >
                    {isResettingPassword ? (
                      <>
                        <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                        {t('settings.users.details.resettingPassword', 'Resetting...')}
                      </>
                    ) : (
                      <>
                        <Key className="w-4 h-4 mr-2" />
                        {t('settings.users.details.resetPasswordButton', 'Reset Password')}
                      </>
                    )}
                  </Button>
                </div>
              </div>

              <Separator />

              {/* Workspaces & Collections */}
              <div className="space-y-3">
                <h4 className="text-sm font-semibold text-zinc-900 dark:text-white flex items-center gap-2">
                  <Building2 className="w-4 h-4" />
                  {t('settings.users.details.workspaces', 'Workspaces & Collections')}
                </h4>
                {loadingWorkspaces ? (
                  <div className="flex items-center justify-center py-4">
                    <Loader2 className="w-6 h-6 animate-spin text-primary" />
                  </div>
                ) : (
                  <div className="space-y-2">
                    <div className="flex items-center gap-2 text-sm">
                      <Building2 className="w-4 h-4 text-zinc-400" />
                      <span className="text-zinc-600 dark:text-zinc-400">
                        {workspaces.length} {t('settings.users.details.workspaceCount', 'workspaces')}
                      </span>
                    </div>
                    <div className="flex items-center gap-2 text-sm">
                      <FolderOpen className="w-4 h-4 text-zinc-400" />
                      <span className="text-zinc-600 dark:text-zinc-400">
                        {collections.length} {t('settings.users.details.collectionCount', 'collections')}
                      </span>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Footer - Fixed */}
          <div className="border-t border-zinc-200 dark:border-zinc-800 py-4 px-6 flex-shrink-0">
            <div className="space-y-3">
              {/* Primary Actions - Side by side on large screens */}
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
                <Button
                  onClick={handleSave}
                  disabled={isSaving}
                  className="w-full"
                  data-testid="settings-user-form-save-button"
                >
                  {isSaving ? (
                    <>
                      <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                      {t('settings.account.profile.saving', 'Saving...')}
                    </>
                  ) : (
                    <>
                      <Save className="w-4 h-4 mr-2" />
                      {t('settings.account.profile.saveChanges', 'Save Changes')}
                    </>
                  )}
                </Button>

                <Button
                  variant="outline"
                  onClick={() => setShowToggleStatusDialog(true)}
                  className="w-full"
                  data-testid="settings-user-form-toggle-status-button"
                >
                  {isActive ? (
                    <>
                      <PowerOff className="w-4 h-4 mr-2" />
                      {t('settings.users.actions.deactivate', 'Deactivate')}
                    </>
                  ) : (
                    <>
                      <Power className="w-4 h-4 mr-2" />
                      {t('settings.users.actions.activate', 'Activate')}
                    </>
                  )}
                </Button>
              </div>

              {/* Destructive Action - Full width */}
              <Button
                variant="destructive"
                onClick={() => setShowDeleteDialog(true)}
                className="w-full"
                data-testid="settings-user-form-delete-button"
              >
                <Trash2 className="w-4 h-4 mr-2" />
                {t('settings.users.actions.deleteUser', 'Delete User')}
              </Button>
            </div>
          </div>
        </SheetContent>
      </Sheet>

      {/* Delete Confirmation Dialog */}
      <AlertDialog open={showDeleteDialog} onOpenChange={setShowDeleteDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <AlertTriangle className="w-5 h-5 text-red-600" />
              {t('settings.users.deleteDialog.title', 'Delete User')}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t('settings.users.deleteDialog.description', 'Are you sure you want to delete this user? This action cannot be undone. All their workspaces, collections, and data will be permanently removed.')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('general.cancel', 'Cancel')}</AlertDialogCancel>
            <AlertDialogAction onClick={handleDelete} className="bg-red-600 hover:bg-red-700">
              {t('general.delete', 'Delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Toggle Status Confirmation Dialog */}
      <AlertDialog open={showToggleStatusDialog} onOpenChange={setShowToggleStatusDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {isActive
                ? t('settings.users.statusDialog.deactivateTitle', 'Deactivate User')
                : t('settings.users.statusDialog.activateTitle', 'Activate User')}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {isActive
                ? t('settings.users.statusDialog.deactivateDescription', 'This will prevent the user from logging in and accessing the system.')
                : t('settings.users.statusDialog.activateDescription', 'This will allow the user to log in and access the system.')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('general.cancel', 'Cancel')}</AlertDialogCancel>
            <AlertDialogAction onClick={handleToggleStatus}>
              {t('general.confirm', 'Confirm')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Profile Picture Upload Dialog */}
      <ProfilePictureUpload
        open={showProfilePictureUpload}
        onOpenChange={setShowProfilePictureUpload}
        onUploadSuccess={handleProfilePictureUploadSuccess}
      />
    </>
  );
};
