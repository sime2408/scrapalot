import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Users,
  Search,
  ChevronLeft,
  ChevronRight,
  Mail,
  Calendar,
  CheckCircle2,
  XCircle,
  MoreVertical,
  Loader2,
  RefreshCw,
  UserX,
  Trash2,
  Power,
  PowerOff,
  Edit,
  Send,
  UserPlus,
  UserCog,
  SlidersHorizontal,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
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
import { Badge } from '@/components/ui/badge';
import { searchUsers, type User, adminToggleUserStatus, adminDeleteUser, adminImpersonateUser } from '@/lib/api-users';
import { api } from '@/lib/api';
import { toast } from '@/lib/toast-compat';
import { enterImpersonation } from '@/lib/impersonation';
import { useAuth } from '@/hooks/use-auth';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { motion } from 'framer-motion';
import { SettingsTabUsersForm } from './settings-tab-users-form.tsx';
import { ProfileImg } from '@/components/ui/profile-img';
import { getSubscriptionPlans } from '@/lib/api-subscriptions';
import { Textarea } from '@/components/ui/textarea';
import { sendAdminMessage, broadcastAdminMessage } from '@/lib/api-admin-messages';
import { Megaphone } from 'lucide-react';

interface SettingsTabUsersProps {
  isMobile?: boolean;
}

const SettingsTabUsers: React.FC<SettingsTabUsersProps> = ({ isMobile = false }) => {
  const { t } = useTranslation();
  const { user: currentUser } = useAuth();

  // A superadmin (single owner account) is the only one allowed to step into
  // an admin's session. Everyone else can impersonate non-admin users only.
  const isSuperadmin = !!(currentUser as { is_superadmin?: boolean } | null)?.is_superadmin;

  // Single source of truth for "may I impersonate this user", mirrored by the
  // server-side check in AdminController.impersonateUser. A superadmin can be
  // impersonated by nobody; an admin only by a superadmin; never yourself or
  // an inactive account.
  const canImpersonate = (target: User): boolean =>
    target.is_active &&
    !target.is_superadmin &&
    (!currentUser || (currentUser as { id?: string }).id !== target.id) &&
    (target.role !== 'admin' || isSuperadmin);

  // State
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [currentPage, setCurrentPage] = useState(1);
  const [totalUsers, setTotalUsers] = useState(0);
  const [pageSize] = useState(10);
  const [roleFilter, setRoleFilter] = useState<string>('all');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  // On mobile the role/status selects collapse behind a single button that
  // opens this mini-dialog, reclaiming vertical space for the table.
  const [showFilterDialog, setShowFilterDialog] = useState(false);
  const hasActiveFilter = roleFilter !== 'all' || statusFilter !== 'all';

  // User detail sheet state
  const [selectedUser, setSelectedUser] = useState<User | null>(null);
  const [showUserDetail, setShowUserDetail] = useState(false);

  // Delete confirmation state
  const [userToDelete, setUserToDelete] = useState<User | null>(null);
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);

  // Activate/deactivate confirmation state — a single misclick on "Deactivate"
  // used to lock a user out instantly, so gate it behind a confirm dialog.
  const [userToToggle, setUserToToggle] = useState<User | null>(null);
  const [showStatusDialog, setShowStatusDialog] = useState(false);

  // Invite dialog state
  const [showInviteDialog, setShowInviteDialog] = useState(false);
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteName, setInviteName] = useState('');
  const [invitePlanId, setInvitePlanId] = useState<string>('');
  const [inviteWorkspaceId, setInviteWorkspaceId] = useState<string>('');
  const [inviteLocale, setInviteLocale] = useState<string>('en');
  const [inviteRole, setInviteRole] = useState<string>('user');
  const [inviteBillingExempt, setInviteBillingExempt] = useState(false);
  const [inviteSending, setInviteSending] = useState(false);
  const [subscriptionPlans, setSubscriptionPlans] = useState<Array<{ id: string; name: string; display_name: string }>>([]);
  const [inviteWorkspaces, setInviteWorkspaces] = useState<Array<{ id: string; name: string }>>([]);
  const [plansLoaded, setPlansLoaded] = useState(false);

  // Admin → user direct message (compose dialog)
  const [messageUser, setMessageUser] = useState<User | null>(null);
  const [messageContent, setMessageContent] = useState('');
  const [messageSending, setMessageSending] = useState(false);
  // Admin → all users broadcast
  const [showBroadcastDialog, setShowBroadcastDialog] = useState(false);
  const [broadcastContent, setBroadcastContent] = useState('');
  const [broadcastSending, setBroadcastSending] = useState(false);

  const handleSendMessage = async () => {
    if (!messageUser || !messageContent.trim()) return;
    setMessageSending(true);
    try {
      await sendAdminMessage(messageUser.id, messageContent.trim());
      toast.success(t('settings.users.message.sent', 'Message sent'));
      setMessageUser(null);
      setMessageContent('');
    } catch {
      toast.error(t('settings.users.message.failed', 'Failed to send message'));
    } finally {
      setMessageSending(false);
    }
  };

  const handleBroadcast = async () => {
    if (!broadcastContent.trim()) return;
    setBroadcastSending(true);
    try {
      const { delivered } = await broadcastAdminMessage(broadcastContent.trim());
      toast.success(t('settings.users.broadcast.delivered', 'Announcement sent to {{count}} users', { count: delivered }));
      setShowBroadcastDialog(false);
      setBroadcastContent('');
    } catch {
      toast.error(t('settings.users.broadcast.failed', 'Failed to send announcement'));
    } finally {
      setBroadcastSending(false);
    }
  };

  // Debounce search query
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedQuery(searchQuery);
      setCurrentPage(1);
    }, 500);

    return () => clearTimeout(timer);
  }, [searchQuery]);

  // Fetch users
  const fetchUsers = async () => {
    setLoading(true);
    try {
      // Send empty string to load all users, or search query if provided
      // include_inactive: keep deactivated users in the list (greyed) so an
      // admin can reactivate them — they used to vanish entirely.
      const result = await searchUsers(debouncedQuery, currentPage, pageSize, true);

      // Apply client-side filters for role and status
      let filteredUsers = result.users;

      if (roleFilter !== 'all') {
        filteredUsers = filteredUsers.filter(user => user.role === roleFilter);
      }

      if (statusFilter === 'active') {
        filteredUsers = filteredUsers.filter(user => user.is_active);
      } else if (statusFilter === 'inactive') {
        filteredUsers = filteredUsers.filter(user => !user.is_active);
      }

      setUsers(filteredUsers);
      setTotalUsers(result.total);
    } catch (error) {
      console.error('Error fetching users:', error);
      toast.error(t('settings.users.errors.loadUsers', 'Failed to load users'));
    } finally {
      setLoading(false);
    }
  };

  // Fetch users when dependencies change
  useEffect(() => {
    void fetchUsers();
  // eslint-disable-next-line react-hooks/exhaustive-deps -- deps are intentionally limited
  }, [debouncedQuery, currentPage, roleFilter, statusFilter]);

  // Auto-load users on mount
  useEffect(() => {
    void fetchUsers();
  // eslint-disable-next-line react-hooks/exhaustive-deps -- deps are intentionally limited
  }, []);

  // Format date
  const formatDate = (dateString: string) => {
    const date = new Date(dateString);
    return new Intl.DateTimeFormat('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    }).format(date);
  };

  // Get role badge color
  const getRoleBadgeColor = (role: string) => {
    switch (role) {
      case 'admin':
        return 'bg-primary/10 text-primary border-primary/20';
      case 'editor':
        return 'bg-blue-500/10 text-blue-600 dark:text-blue-400 border-blue-500/20';
      case 'viewer':
        return 'bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-400 border-zinc-200 dark:border-zinc-700';
      default:
        return 'bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-400 border-zinc-200 dark:border-zinc-700';
    }
  };

  // Handle user row click
  const handleUserClick = (user: User) => {
    setSelectedUser(user);
    setShowUserDetail(true);
  };

  // Handle toggle user status
  const handleToggleStatus = (user: User, e: React.MouseEvent) => {
    e.stopPropagation();
    // Confirm first — deactivating immediately locks the user out, and that is
    // easy to trigger by accident from the row menu.
    setUserToToggle(user);
    setShowStatusDialog(true);
  };

  const confirmToggleStatus = async () => {
    if (!userToToggle) return;
    try {
      await adminToggleUserStatus(userToToggle.id, !userToToggle.is_active);
      void fetchUsers();
    } catch (error) {
      console.error('Error toggling user status:', error);
    } finally {
      setShowStatusDialog(false);
      setUserToToggle(null);
    }
  };

  // Handle impersonation: swap our admin tokens for the target user's
  // tokens and hard-reload to /dashboard so every context (workspace,
  // collections, settings, models) bootstraps from the impersonated
  // identity. Eligibility is also enforced server-side; this is a UX
  // guard.
  const handleImpersonate = async (user: User, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!user.is_active) {
      toast.error(
        t('settings.users.impersonate.errorInactive', 'Cannot impersonate an inactive user')
      );
      return;
    }
    if (currentUser && (currentUser as { id?: string }).id === user.id) {
      toast.error(
        t('settings.users.impersonate.errorSelf', 'Cannot impersonate yourself')
      );
      return;
    }
    if (user.is_superadmin) {
      toast.error(
        t('settings.users.impersonate.errorSuperadmin', 'Cannot impersonate a superadmin')
      );
      return;
    }
    if (user.role === 'admin' && !isSuperadmin) {
      toast.error(
        t('settings.users.impersonate.errorAdmin', 'Cannot impersonate another admin')
      );
      return;
    }
    try {
      const tokens = await adminImpersonateUser(user.id);
      enterImpersonation(
        {
          id: user.id,
          username: user.username,
          email: user.email,
          role: user.role,
        },
        JSON.stringify(tokens)
      );
      toast.success(
        t('settings.users.impersonate.success', 'Impersonating {{name}}', {
          name: user.username || user.email,
        })
      );
      window.location.href = '/dashboard';
    } catch (err) {
      // adminImpersonateUser already surfaced a toast; nothing else to do.
      console.error('Impersonation failed:', err);
    }
  };

  // Handle delete user
  const handleDeleteClick = (user: User, e: React.MouseEvent) => {
    e.stopPropagation();
    setUserToDelete(user);
    setShowDeleteDialog(true);
  };

  const confirmDelete = async () => {
    if (!userToDelete) return;

    try {
      await adminDeleteUser(userToDelete.id);
      setShowDeleteDialog(false);
      setUserToDelete(null);
      // Remove user from local state immediately for instant UI feedback
      setUsers(prev => prev.filter(u => u.id !== userToDelete.id));
      setTotalUsers(prev => prev - 1);
      // Also refresh from server
      await fetchUsers();
    } catch (error) {
      console.error('Error deleting user:', error);
    }
  };

  // Load subscription plans and workspaces when invite dialog opens
  useEffect(() => {
    if (showInviteDialog && !plansLoaded) {
      getSubscriptionPlans()
        .then(plans => {
          setSubscriptionPlans(plans.filter(p => p.is_active));
          setPlansLoaded(true);
        })
        .catch(err => console.error('Failed to load plans:', err));
      void import('@/lib/api-workspace').then(({ getWorkspaces }) => {
        getWorkspaces(1, 50).then(res => {
          setInviteWorkspaces(res.workspaces.map((w: { id: string; name: string }) => ({ id: w.id, name: w.name })));
        }).catch(err => console.error('Failed to load workspaces:', err));
      });
    }
  }, [showInviteDialog, plansLoaded]);

  // Handle send invitation
  const handleSendInvitation = async () => {
    if (!inviteEmail.trim()) return;
    setInviteSending(true);
    try {
      await api.post('/admin/email/invitation', {
        email: inviteEmail.trim(),
        recipient_name: inviteName.trim() || null,
        subscription_plan_id: (invitePlanId && invitePlanId !== 'default') ? invitePlanId : null,
        workspace_id: (inviteWorkspaceId && inviteWorkspaceId !== 'none') ? inviteWorkspaceId : null,
        billing_exempt: inviteBillingExempt,
        locale: inviteLocale || 'en',
        role: inviteRole || 'user',
      });
      toast.success(t('settings.users.invite.success', 'Invitation sent to {{email}}', { email: inviteEmail }));
      setShowInviteDialog(false);
      setInviteEmail('');
      setInviteName('');
      setInvitePlanId('');
      setInviteWorkspaceId('');
      setInviteLocale('en');
      setInviteRole('user');
      setInviteBillingExempt(false);
    } catch (error) {
      console.error('Error sending invitation:', error);
      toast.error(t('settings.users.invite.error', 'Failed to send invitation'));
    } finally {
      setInviteSending(false);
    }
  };

  // Calculate pagination
  const totalPages = Math.ceil(totalUsers / pageSize);
  const hasNextPage = currentPage < totalPages;
  const hasPrevPage = currentPage > 1;

  // --- Horizontal table scroll vs. tab-swipe arbitration (mobile) ---------
  // The settings panel changes tabs on a horizontal finger swipe. The user's
  // table also scrolls horizontally, so the two gestures fight. We drive the
  // table's horizontal scroll manually (the parent's `touch-action: pan-y`
  // blocks native pan-x here) and stopPropagation so the tab-swipe stays
  // dormant — until the table reaches its edge in the swipe direction, at
  // which point we let the event bubble so the tab can change.
  const tableTouch = useRef<{ x: number; y: number; scrollLeft: number; axis: 'none' | 'x' | 'y' }>(
    { x: 0, y: 0, scrollLeft: 0, axis: 'none' }
  );

  const onTableTouchStart = (e: React.TouchEvent<HTMLDivElement>) => {
    const t = e.touches[0];
    tableTouch.current = { x: t.clientX, y: t.clientY, scrollLeft: e.currentTarget.scrollLeft, axis: 'none' };
  };

  const onTableTouchMove = (e: React.TouchEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    const maxScroll = el.scrollWidth - el.clientWidth;
    if (maxScroll <= 0) return; // nothing to scroll → leave the tab-swipe alone

    const t = e.touches[0];
    const dx = t.clientX - tableTouch.current.x;
    const dy = t.clientY - tableTouch.current.y;

    // Lock the gesture to an axis once it clears a small deadzone.
    if (tableTouch.current.axis === 'none') {
      if (Math.abs(dx) < 6 && Math.abs(dy) < 6) return;
      tableTouch.current.axis = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
    }
    if (tableTouch.current.axis !== 'x') return; // vertical → native page scroll

    const target = tableTouch.current.scrollLeft - dx; // drag right reveals earlier columns
    const clamped = Math.max(0, Math.min(maxScroll, target));
    const atStartEdge = clamped <= 0 && dx > 0;
    const atEndEdge = clamped >= maxScroll && dx < 0;

    if (!atStartEdge && !atEndEdge) {
      el.scrollLeft = clamped;
      e.stopPropagation(); // own the gesture so the tab doesn't switch mid-scroll
    }
    // At the edge in the swipe direction we intentionally let the event bubble
    // up to the panel's swipe handler, so the user can flick to the next tab.
  };

  return (
    // Matches the other settings tabs: a flowing column that scrolls with the
    // parent panel (no h-full / internal table scroll). This gives the table
    // its full height on mobile and lets the title stay pinned while scrolling.
    <div className="flex flex-col">
      {/* Sticky, translucent header — identical pattern to the other tabs so
          the title floats above the content as you scroll. */}
      <div className="sticky top-0 pt-0 pb-6 z-20" style={{ position: 'sticky' }}>
        <div
          className="absolute inset-0 bg-white/50 dark:bg-zinc-900/50 backdrop-blur-xl -z-10"
          style={{ maskImage: 'linear-gradient(to bottom, transparent 0%, black 10%, black 90%, transparent 100%)' }}
        />
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 bg-primary/10 flex items-center justify-center">
            <Users className="w-5 h-5 text-primary" />
          </div>
          <div>
            <h2 className="text-2xl font-bold text-zinc-900 dark:text-white">
              {t('settings.users.title', 'User Management')}
            </h2>
            <p className="text-sm text-zinc-500 dark:text-zinc-400">
              {t('settings.users.description', 'View and manage registered users in the system')}
            </p>
          </div>
        </div>
      </div>

      {/* Filters and Search */}
      <div className="bg-white dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 p-4 mb-4">
        {isMobile ? (
          /* Mobile: one compact row. The role/status selects collapse behind a
             single filters button (mini-dialog) so they don't eat the vertical
             space the table needs. Action icons stay inline. */
          <div className="flex items-center gap-2">
            <div className="flex-1 relative min-w-0">
              <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-zinc-400" />
              <Input
                type="text"
                placeholder={t('settings.users.searchPlaceholder', 'Search by email or username...')}
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="pl-10 border-zinc-300 dark:border-zinc-700"
                data-testid="settings-users-search-input"
              />
            </div>
            <Button
              variant="outline"
              size="icon"
              onClick={() => setShowFilterDialog(true)}
              title={t('settings.users.filters.button', 'Filters')}
              aria-label={t('settings.users.filters.button', 'Filters')}
              data-testid="settings-users-filters-button"
              className="relative flex-shrink-0 border-zinc-300 dark:border-zinc-700"
            >
              <SlidersHorizontal className="h-4 w-4" />
              {hasActiveFilter && (
                <span className="absolute -top-1 -right-1 w-2.5 h-2.5 rounded-full bg-primary border-2 border-white dark:border-zinc-950" />
              )}
            </Button>
            <Button
              variant="outline"
              size="icon"
              onClick={() => { setBroadcastContent(''); setShowBroadcastDialog(true); }}
              title={t('settings.users.broadcast.button', 'Broadcast announcement')}
              aria-label={t('settings.users.broadcast.button', 'Broadcast announcement')}
              data-testid="settings-users-broadcast-button"
              className="flex-shrink-0 border-zinc-300 dark:border-zinc-700"
            >
              <Megaphone className="h-4 w-4" />
            </Button>
            <Button
              variant="default"
              size="icon"
              onClick={() => setShowInviteDialog(true)}
              title={t('settings.users.invite.button', 'Invite')}
              aria-label={t('settings.users.invite.button', 'Invite')}
              data-testid="settings-users-invite-button"
              className="flex-shrink-0"
            >
              <UserPlus className="h-4 w-4" />
            </Button>
            <Button
              variant="outline"
              size="icon"
              onClick={fetchUsers}
              disabled={loading}
              className="flex-shrink-0 border-zinc-300 dark:border-zinc-700"
              data-testid="settings-users-refresh-button"
            >
              <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
            </Button>
          </div>
        ) : (
          <div className="flex flex-col md:flex-row gap-3">
            {/* Search */}
            <div className="flex-1 relative">
              <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-zinc-400" />
              <Input
                type="text"
                placeholder={t('settings.users.searchPlaceholder', 'Search by email or username...')}
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="pl-10 border-zinc-300 dark:border-zinc-700"
                data-testid="settings-users-search-input"
              />
            </div>

            {/* Role Filter */}
            <Select value={roleFilter} onValueChange={setRoleFilter}>
              <SelectTrigger className="w-full md:w-[180px] border-zinc-300 dark:border-zinc-700" data-testid="settings-users-role-filter">
                <SelectValue placeholder={t('settings.users.roleFilter', 'All Roles')} />
              </SelectTrigger>
              <SelectContent className='z-[1100]'>
                <SelectItem value="all">{t('settings.users.roles.all', 'All Roles')}</SelectItem>
                <SelectItem value="admin">{t('settings.users.roles.admin', 'Admin')}</SelectItem>
                <SelectItem value="user">{t('settings.users.roles.user', 'User')}</SelectItem>
                <SelectItem value="viewer">{t('settings.users.roles.viewer', 'Viewer')}</SelectItem>
              </SelectContent>
            </Select>

            {/* Status Filter */}
            <Select value={statusFilter} onValueChange={setStatusFilter}>
              <SelectTrigger className="w-full md:w-[180px] border-zinc-300 dark:border-zinc-700" data-testid="settings-users-status-filter">
                <SelectValue placeholder={t('settings.users.statusFilter', 'All Status')} />
              </SelectTrigger>
              <SelectContent className='z-[1100]'>
                <SelectItem value="all">{t('settings.users.status.all', 'All Status')}</SelectItem>
                <SelectItem value="active">{t('settings.users.status.active', 'Active')}</SelectItem>
                <SelectItem value="inactive">{t('settings.users.status.inactive', 'Inactive')}</SelectItem>
              </SelectContent>
            </Select>

            {/* Invite + Refresh — icon-only, mirror each other's sizing.
                Wrapped in a flex row so they stay side-by-side even when the
                parent stacks vertically on mobile (flex-col). The tooltips
                keep the actions discoverable now that the labels are gone. */}
            <div className="flex gap-3">
              <Button
                variant="outline"
                size="icon"
                onClick={() => { setBroadcastContent(''); setShowBroadcastDialog(true); }}
                title={t('settings.users.broadcast.button', 'Broadcast announcement')}
                aria-label={t('settings.users.broadcast.button', 'Broadcast announcement')}
                data-testid="settings-users-broadcast-button"
                className="border-zinc-300 dark:border-zinc-700"
              >
                <Megaphone className="h-4 w-4" />
              </Button>
              <Button
                variant="default"
                size="icon"
                onClick={() => setShowInviteDialog(true)}
                title={t('settings.users.invite.button', 'Invite')}
                aria-label={t('settings.users.invite.button', 'Invite')}
                data-testid="settings-users-invite-button"
              >
                <UserPlus className="h-4 w-4" />
              </Button>

              <Button
                variant="outline"
                size="icon"
                onClick={fetchUsers}
                disabled={loading}
                className="border-zinc-300 dark:border-zinc-700"
                data-testid="settings-users-refresh-button"
              >
                <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
              </Button>
            </div>
          </div>
        )}
      </div>

      {/* Users Table — flows with the page (no internal scroll). The parent
          settings panel scrolls, so the whole 10-row page is reachable and the
          pagination bar sits naturally below the rows. */}
      <div className="bg-white dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 flex flex-col">
        {loading ? (
          <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
            <p className="text-sm">{t('settings.users.searching', 'Searching users...')}</p>
            <p className="text-xs text-muted-foreground/60 mt-1">
              {t('settings.users.searchingHint', 'Loading user data')}
            </p>
          </div>
        ) : users.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 px-4">
            <UserX className="h-12 w-12 text-zinc-400 mb-4" />
            <p className="text-sm font-medium text-zinc-900 dark:text-white mb-1">
              {searchQuery.trim().length === 0
                ? t('settings.users.emptyResults.noUsers', 'No users found')
                : t('settings.users.emptyResults.title', 'No users found')}
            </p>
            <p className="text-xs text-zinc-500 dark:text-zinc-400 text-center max-w-xs">
              {searchQuery.trim().length === 0
                ? t('settings.users.emptyResults.noUsersDescription', 'There are no other users in the system')
                : t('settings.users.emptyResults.description', 'Try adjusting your search or filters')}
            </p>
          </div>
        ) : (
          <>
            {/* Table — only horizontal overflow; vertical scrolling is handled
                by the parent panel so the full page of rows is visible. The
                touch handlers give this horizontal scroll priority over the
                panel's tab-swipe until the table reaches its edge. */}
            <div
              className="overflow-x-auto"
              style={{ touchAction: 'pan-y' }}
              onTouchStart={onTableTouchStart}
              onTouchMove={onTableTouchMove}
            >
              {/* On mobile the table is given a real width wider than the
                  viewport (all columns shown) so it genuinely scrolls
                  horizontally — that scroll is what the touch handlers above
                  prioritise over the tab-swipe. */}
              <table className={isMobile ? 'w-full min-w-[760px]' : 'w-full'}>
                <thead className="bg-zinc-50 dark:bg-zinc-900 border-b border-zinc-200 dark:border-zinc-800">
                  <tr>
                    <th className="px-4 py-3 text-left text-xs font-medium text-zinc-500 dark:text-zinc-400 uppercase tracking-wide">
                      {t('settings.users.table.user', 'User')}
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-zinc-500 dark:text-zinc-400 uppercase tracking-wide whitespace-nowrap">
                      {t('settings.users.table.email', 'Email')}
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-zinc-500 dark:text-zinc-400 uppercase tracking-wide">
                      {t('settings.users.table.role', 'Role')}
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-zinc-500 dark:text-zinc-400 uppercase tracking-wide">
                      {t('settings.users.table.status', 'Status')}
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-zinc-500 dark:text-zinc-400 uppercase tracking-wide whitespace-nowrap">
                      {t('settings.users.table.created', 'Created')}
                    </th>
                    <th className="px-4 py-3 text-right text-xs font-medium text-zinc-500 dark:text-zinc-400 uppercase tracking-wide">
                      {t('settings.users.table.actions', 'Actions')}
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-200 dark:divide-zinc-800">
                  {users.map((user, index) => (
                    <motion.tr
                      key={user.id}
                      initial={{ opacity: 0, y: 10 }}
                      // Deactivated users stay in the list but greyed, so an admin
                      // can still find and reactivate them.
                      animate={{ opacity: user.is_active ? 1 : 0.45, y: 0 }}
                      transition={{ duration: 0.3, delay: index * 0.05 }}
                      className="hover:bg-zinc-50 dark:hover:bg-zinc-900/50 transition-colors cursor-pointer"
                      onClick={() => handleUserClick(user)}
                      data-testid={`settings-users-row-${user.id}`}
                    >
                      {/* User Info */}
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-3">
                          {user.profile_picture ? (
                            <ProfileImg
                              pic={user.profile_picture}
                              alt={user.username}
                              className="w-8 h-8 rounded-full object-cover"
                            />
                          ) : (
                            <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center">
                              <span className="text-xs font-semibold text-primary">
                                {user.username.charAt(0).toUpperCase()}
                              </span>
                            </div>
                          )}
                          <div className="min-w-0">
                            <p className="text-sm font-medium text-zinc-900 dark:text-white truncate">
                              {user.username}
                            </p>
                            {(user.first_name || user.last_name) && (
                              <p className="text-xs text-zinc-500 dark:text-zinc-400 truncate">
                                {[user.first_name, user.last_name].filter(Boolean).join(' ')}
                              </p>
                            )}
                          </div>
                        </div>
                      </td>

                      {/* Email */}
                      <td className="px-4 py-3 whitespace-nowrap">
                        <div className="flex items-center gap-2">
                          <Mail className="h-3.5 w-3.5 text-zinc-400" />
                          <span className="text-sm text-zinc-700 dark:text-zinc-300">
                            {user.email}
                          </span>
                        </div>
                      </td>

                      {/* Role */}
                      <td className="px-4 py-3">
                        <Badge className={`${getRoleBadgeColor(user.role)} border`}>
                          {user.role}
                        </Badge>
                      </td>

                      {/* Status */}
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2">
                          {user.is_active ? (
                            <>
                              <CheckCircle2 className="h-4 w-4 text-green-600 dark:text-green-400" />
                              <span className="text-sm text-zinc-700 dark:text-zinc-300">
                                {t('settings.users.status.active', 'Active')}
                              </span>
                            </>
                          ) : (
                            <>
                              <XCircle className="h-4 w-4 text-red-600 dark:text-red-400" />
                              <span className="text-sm text-zinc-700 dark:text-zinc-300">
                                {t('settings.users.status.inactive', 'Inactive')}
                              </span>
                            </>
                          )}
                        </div>
                      </td>

                      {/* Created Date */}
                      <td className="px-4 py-3 whitespace-nowrap">
                        <div className="flex items-center gap-2">
                          <Calendar className="h-3.5 w-3.5 text-zinc-400" />
                          <span className="text-sm text-zinc-700 dark:text-zinc-300">
                            {formatDate(user.created_at)}
                          </span>
                        </div>
                      </td>

                      {/* Actions */}
                      <td className="px-4 py-3 text-right">
                        <DropdownMenu modal={false}>
                          <DropdownMenuTrigger asChild onClick={(e) => e.stopPropagation()}>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-8 w-8"
                            >
                              <MoreVertical className="h-4 w-4" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end" className="w-48" sideOffset={5} style={{ zIndex: 9999 }}>
                            <DropdownMenuLabel>
                              {t('settings.users.actions.title', 'Actions')}
                            </DropdownMenuLabel>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem onClick={(e) => { e.stopPropagation(); handleUserClick(user); }}>
                              <Edit className="mr-2 h-4 w-4" />
                              {t('settings.users.actions.editUser', 'Edit User')}
                            </DropdownMenuItem>
                            {/* Impersonation: visible only for eligible targets
                                (active, not self, not a superadmin, and admins
                                only when the current user is a superadmin).
                                Hidden when ineligible to keep the menu lean —
                                the handler still re-checks server-side. */}
                            {canImpersonate(user) && (
                                <DropdownMenuItem
                                  data-testid={`settings-users-impersonate-${user.id}`}
                                  onClick={(e) => { void handleImpersonate(user, e); }}
                                >
                                  <UserCog className="mr-2 h-4 w-4" />
                                  {t('settings.users.actions.impersonate', 'Impersonate')}
                                </DropdownMenuItem>
                              )}
                            <DropdownMenuItem
                              data-testid={`settings-users-message-${user.id}`}
                              onClick={(e) => { e.stopPropagation(); setMessageContent(''); setMessageUser(user); }}
                            >
                              <Send className="mr-2 h-4 w-4" />
                              {t('settings.users.actions.sendMessage', 'Send message')}
                            </DropdownMenuItem>
                            <DropdownMenuItem onClick={(e) => handleToggleStatus(user, e)}>
                              {user.is_active ? (
                                <>
                                  <PowerOff className="mr-2 h-4 w-4" />
                                  {t('settings.users.actions.deactivate', 'Deactivate')}
                                </>
                              ) : (
                                <>
                                  <Power className="mr-2 h-4 w-4" />
                                  {t('settings.users.actions.activate', 'Activate')}
                                </>
                              )}
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem
                              onClick={(e) => handleDeleteClick(user, e)}
                              className="text-red-600 dark:text-red-400"
                            >
                              <Trash2 className="mr-2 h-4 w-4" />
                              {t('settings.users.actions.deleteUser', 'Delete User')}
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </td>
                    </motion.tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Pagination */}
            <div className="border-t border-zinc-200 dark:border-zinc-800 px-4 py-3 bg-zinc-50 dark:bg-zinc-900">
              <div className="flex items-center justify-between">
                <div className="text-sm text-zinc-500 dark:text-zinc-400">
                  {t('settings.users.pagination.showing', {
                    defaultValue: 'Showing {{start}} to {{end}} of {{total}} users',
                    start: Math.min((currentPage - 1) * pageSize + 1, totalUsers),
                    end: Math.min(currentPage * pageSize, totalUsers),
                    total: totalUsers,
                  })}
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setCurrentPage(currentPage - 1)}
                    disabled={!hasPrevPage || loading}
                    className="border-zinc-300 dark:border-zinc-700"
                  >
                    <ChevronLeft className="h-4 w-4" />
                  </Button>
                  <span className="text-sm text-zinc-700 dark:text-zinc-300">
                    {t('settings.users.pagination.page', {
                      defaultValue: 'Page {{current}} of {{total}}',
                      current: currentPage,
                      total: totalPages || 1,
                    })}
                  </span>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setCurrentPage(currentPage + 1)}
                    disabled={!hasNextPage || loading}
                    className="border-zinc-300 dark:border-zinc-700"
                  >
                    <ChevronRight className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            </div>
          </>
        )}
      </div>

      {/* User Detail Form */}
      <SettingsTabUsersForm
        user={selectedUser}
        open={showUserDetail}
        onOpenChange={setShowUserDetail}
        onUserUpdated={fetchUsers}
      />

      {/* Invite Dialog */}
      <Dialog open={showInviteDialog} onOpenChange={setShowInviteDialog}>
        <DialogContent className="sm:max-w-[420px]" style={{ zIndex: 1100 }}>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Mail className="h-5 w-5 text-primary" />
              {t('settings.users.invite.title', 'Send Invitation')}
            </DialogTitle>
            <DialogDescription>
              {t('settings.users.invite.description', 'Invite someone to join Scrapalot AI as a non-billable test user.')}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label htmlFor="invite-email">{t('settings.users.invite.email', 'Email address')}</Label>
              <Input
                id="invite-email"
                type="email"
                placeholder="user@example.com"
                value={inviteEmail}
                onChange={(e) => setInviteEmail(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') void handleSendInvitation(); }}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="invite-name">{t('settings.users.invite.name', 'Name (optional)')}</Label>
              <Input
                id="invite-name"
                type="text"
                placeholder="Jane Doe"
                value={inviteName}
                onChange={(e) => setInviteName(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') void handleSendInvitation(); }}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="invite-plan">{t('settings.users.invite.plan', 'Subscription Plan')}</Label>
              <Select value={invitePlanId} onValueChange={setInvitePlanId}>
                <SelectTrigger id="invite-plan">
                  <SelectValue placeholder={t('settings.users.invite.planPlaceholder', 'Default (Researcher)')} />
                </SelectTrigger>
                <SelectContent style={{ zIndex: 1200 }}>
                  <SelectItem value="default">{t('settings.users.invite.planDefault', 'Default (Researcher)')}</SelectItem>
                  {subscriptionPlans.map(plan => (
                    <SelectItem key={plan.id} value={plan.id}>
                      {plan.display_name || plan.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="invite-workspace">{t('settings.users.invite.workspace', 'Share Workspace')}</Label>
              <Select value={inviteWorkspaceId} onValueChange={setInviteWorkspaceId}>
                <SelectTrigger id="invite-workspace">
                  <SelectValue placeholder={t('settings.users.invite.noWorkspace', 'None')} />
                </SelectTrigger>
                <SelectContent style={{ zIndex: 1200 }}>
                  <SelectItem value="none">{t('settings.users.invite.noWorkspace', 'None')}</SelectItem>
                  {inviteWorkspaces.map(ws => (
                    <SelectItem key={ws.id} value={ws.id}>{ws.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="invite-locale">{t('settings.users.invite.locale', 'Default Language')}</Label>
              <Select value={inviteLocale} onValueChange={setInviteLocale}>
                <SelectTrigger id="invite-locale">
                  <SelectValue placeholder="English" />
                </SelectTrigger>
                <SelectContent style={{ zIndex: 1200 }}>
                  <SelectItem value="en">English</SelectItem>
                  <SelectItem value="hr">Hrvatski</SelectItem>
                  <SelectItem value="mk">Македонски</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="invite-role">{t('settings.users.invite.role', 'Role')}</Label>
              <Select value={inviteRole} onValueChange={setInviteRole}>
                <SelectTrigger id="invite-role" data-testid="invite-role-select">
                  <SelectValue placeholder={t('settings.users.roles.user', 'User')} />
                </SelectTrigger>
                <SelectContent style={{ zIndex: 1200 }}>
                  <SelectItem value="user">{t('settings.users.roles.user', 'User')}</SelectItem>
                  <SelectItem value="admin">{t('settings.users.roles.admin', 'Admin')}</SelectItem>
                </SelectContent>
              </Select>
              {inviteRole === 'admin' && (
                <p className="text-xs text-amber-600 dark:text-amber-400">
                  {t('settings.users.invite.adminWarning', 'This user will join as an administrator with full access.')}
                </p>
              )}
            </div>
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={inviteBillingExempt}
                onChange={(e) => setInviteBillingExempt(e.target.checked)}
                className="accent-primary"
              />
              <span className="text-sm text-muted-foreground">
                {t('settings.users.invite.testUser', 'Test user (no billing, permanent access)')}
              </span>
            </label>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowInviteDialog(false)}>
              {t('general.cancel', 'Cancel')}
            </Button>
            <Button
              onClick={handleSendInvitation}
              disabled={!inviteEmail.trim() || inviteSending}
              className="gap-1.5"
            >
              {inviteSending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
              {t('settings.users.invite.send', 'Send Invitation')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Send message to a single user (replyable) */}
      <Dialog open={!!messageUser} onOpenChange={(o) => { if (!o) setMessageUser(null); }}>
        <DialogContent disableFullscreenOnMobile>
          <DialogHeader>
            <DialogTitle>
              {t('settings.users.message.title', 'Send message to {{name}}', {
                name: messageUser?.first_name || messageUser?.username || messageUser?.email || '',
              })}
            </DialogTitle>
            <DialogDescription>
              {t('settings.users.message.description', 'The user gets a notification and can reply.')}
            </DialogDescription>
          </DialogHeader>
          <Textarea
            value={messageContent}
            onChange={(e) => setMessageContent(e.target.value)}
            placeholder={t('settings.users.message.placeholder', 'Type your message…')}
            rows={4}
            autoFocus
            data-testid="admin-message-input"
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setMessageUser(null)} disabled={messageSending}>
              {t('common.cancel', 'Cancel')}
            </Button>
            <Button
              onClick={() => void handleSendMessage()}
              disabled={messageSending || !messageContent.trim()}
              data-testid="admin-message-send"
            >
              {messageSending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Send className="mr-2 h-4 w-4" />}
              {t('settings.users.message.send', 'Send')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Broadcast announcement to all active users */}
      <Dialog open={showBroadcastDialog} onOpenChange={setShowBroadcastDialog}>
        <DialogContent disableFullscreenOnMobile>
          <DialogHeader>
            <DialogTitle>{t('settings.users.broadcast.title', 'Broadcast announcement')}</DialogTitle>
            <DialogDescription>
              {t('settings.users.broadcast.description', 'This message is sent to every active user as a read-only announcement.')}
            </DialogDescription>
          </DialogHeader>
          <Textarea
            value={broadcastContent}
            onChange={(e) => setBroadcastContent(e.target.value)}
            placeholder={t('settings.users.broadcast.placeholder', 'Announcement…')}
            rows={4}
            autoFocus
            data-testid="admin-broadcast-input"
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowBroadcastDialog(false)} disabled={broadcastSending}>
              {t('common.cancel', 'Cancel')}
            </Button>
            <Button
              onClick={() => void handleBroadcast()}
              disabled={broadcastSending || !broadcastContent.trim()}
              data-testid="admin-broadcast-send"
            >
              {broadcastSending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Megaphone className="mr-2 h-4 w-4" />}
              {t('settings.users.broadcast.send', 'Send to all')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Mobile filter mini-dialog — holds the role/status selects that are
          hidden from the compact filter bar on small screens. */}
      <Dialog open={showFilterDialog} onOpenChange={setShowFilterDialog}>
        <DialogContent disableFullscreenOnMobile className="sm:max-w-[360px]">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <SlidersHorizontal className="h-5 w-5 text-primary" />
              {t('settings.users.filters.title', 'Filters')}
            </DialogTitle>
            <DialogDescription>
              {t('settings.users.filters.description', 'Filter users by role and status.')}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label>{t('settings.users.roleFilter', 'All Roles')}</Label>
              <Select value={roleFilter} onValueChange={setRoleFilter}>
                <SelectTrigger className="w-full border-zinc-300 dark:border-zinc-700" data-testid="settings-users-role-filter-mobile">
                  <SelectValue placeholder={t('settings.users.roleFilter', 'All Roles')} />
                </SelectTrigger>
                <SelectContent style={{ zIndex: 1200 }}>
                  <SelectItem value="all">{t('settings.users.roles.all', 'All Roles')}</SelectItem>
                  <SelectItem value="admin">{t('settings.users.roles.admin', 'Admin')}</SelectItem>
                  <SelectItem value="user">{t('settings.users.roles.user', 'User')}</SelectItem>
                  <SelectItem value="viewer">{t('settings.users.roles.viewer', 'Viewer')}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>{t('settings.users.statusFilter', 'All Status')}</Label>
              <Select value={statusFilter} onValueChange={setStatusFilter}>
                <SelectTrigger className="w-full border-zinc-300 dark:border-zinc-700" data-testid="settings-users-status-filter-mobile">
                  <SelectValue placeholder={t('settings.users.statusFilter', 'All Status')} />
                </SelectTrigger>
                <SelectContent style={{ zIndex: 1200 }}>
                  <SelectItem value="all">{t('settings.users.status.all', 'All Status')}</SelectItem>
                  <SelectItem value="active">{t('settings.users.status.active', 'Active')}</SelectItem>
                  <SelectItem value="inactive">{t('settings.users.status.inactive', 'Inactive')}</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => { setRoleFilter('all'); setStatusFilter('all'); }}
              disabled={!hasActiveFilter}
            >
              {t('settings.users.filters.clear', 'Clear filters')}
            </Button>
            <Button onClick={() => setShowFilterDialog(false)}>
              {t('settings.users.filters.apply', 'Done')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation Dialog */}
      <AlertDialog open={showDeleteDialog} onOpenChange={setShowDeleteDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <Trash2 className="w-5 h-5 text-red-600" />
              {t('settings.users.deleteDialog.title', 'Delete User')}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t('settings.users.deleteDialog.description', 'Are you sure you want to delete this user? This action cannot be undone.')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('general.cancel', 'Cancel')}</AlertDialogCancel>
            <AlertDialogAction onClick={confirmDelete} className="bg-red-600 hover:bg-red-700">
              {t('general.delete', 'Delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Activate / Deactivate Confirmation Dialog */}
      <AlertDialog open={showStatusDialog} onOpenChange={setShowStatusDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              {userToToggle?.is_active ? (
                <PowerOff className="w-5 h-5 text-amber-600" />
              ) : (
                <Power className="w-5 h-5 text-green-600" />
              )}
              {userToToggle?.is_active
                ? t('settings.users.statusDialog.deactivateTitle', 'Deactivate User')
                : t('settings.users.statusDialog.activateTitle', 'Activate User')}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {userToToggle?.is_active
                ? t('settings.users.statusDialog.deactivateDescription', 'This will prevent the user from logging in and accessing the system.')
                : t('settings.users.statusDialog.activateDescription', 'This will allow the user to log in and access the system.')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('general.cancel', 'Cancel')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={confirmToggleStatus}
              className={userToToggle?.is_active ? 'bg-amber-600 hover:bg-amber-700' : 'bg-green-600 hover:bg-green-700'}
            >
              {userToToggle?.is_active
                ? t('settings.users.actions.deactivate', 'Deactivate')
                : t('settings.users.actions.activate', 'Activate')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
};

export default SettingsTabUsers;
