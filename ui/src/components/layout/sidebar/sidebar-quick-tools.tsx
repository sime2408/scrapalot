import { useState, useEffect } from 'react';
import { useAuth } from '@/hooks/use-auth';
import { useAdminCheck } from '@/hooks/use-admin-check';
import { useWorkspace } from '@/hooks/use-workspace';
import { ThemeToggle } from '../../theme-toggle.tsx';
import { KnowledgeStacksDialog } from '@/components/knowledge/knowledge-stacks-dialog.tsx';
// (CE) Admin document inspector is hosted-only — inert no-op render.
const DocumentInspectorDialog = (_props: any) => null;
import { toast } from '@/lib/toast-compat';
import { uiState } from '@/lib/storage-utils';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu.tsx';
import {
  Box,
  ChevronDown,
  Book,
  Laptop,
  LogOut,
  MessageSquare,
  Plus,
  Server,
  Settings,
  User as UserIcon,
  Crown,
  Award,
  BarChart3,
  HardDrive,
  FileText,
  Zap,
  Network,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useIsMobile } from '@/hooks/use-mobile';
import { getCurrentUser, type User } from '@/lib/api-users';
import { getMySubscription, type UserSubscriptionWithUsage } from '@/lib/api-subscriptions';
import { getMyStorageQuota, getWorkspaceStorageUsage, formatBytes, type StorageQuota, type WorkspaceStorage } from '@/lib/api-storage';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { useTheme } from '@/providers/theme-provider';
import { ProfilePictureUpload } from '@/components/profile-picture-upload';
import { ProfileImg } from '@/components/ui/profile-img';

interface SidebarQuickToolsProps {
  onNewSession: () => void;
  setShowRemoteModelProviders: (show: boolean) => void;
  setShowSettingsGeneral: (show: boolean) => void;
  openSettingsWithTab?: (tab: string) => void;
  isOpen?: boolean;
  closeSidebar?: () => void;
  isChatPage?: boolean;
  mobileMenuOpen?: boolean;
  onCloseMobileMenu?: () => void;
}

export const SidebarQuickTools = ({
  onNewSession,
  setShowRemoteModelProviders,
  setShowSettingsGeneral,
  openSettingsWithTab,
  mobileMenuOpen,
  onCloseMobileMenu,
}: SidebarQuickToolsProps) => {
  const { t } = useTranslation();
  const isMobile = useIsMobile(); // Only hide on mobile (<1080px), show on tablet and above
  const { accentColor } = useTheme();

  const { logout, isAuthenticated, authState } = useAuth();
  const isAdmin = useAdminCheck();
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [showKnowledgeStackModal, setShowKnowledgeStackModal] = useState(false);
  const [showAdminInspector, setShowAdminInspector] = useState(false);
  // Use this to force re-render of the plus button
  const [plusButtonKey, setPlusButtonKey] = useState(0);

  // Command Palette dispatches CustomEvents for the
  // 'Library' and 'Admin' nav entries. We listen here because this is
  // the component that already owns the dialog mount points + their
  // open state. Settings has its own listener in sessions-header.tsx
  // because that's where its dialog mount lives.
  useEffect(() => {
    const onOpenStacks = () => setShowKnowledgeStackModal(true);
    const onOpenAdmin = () => isAdmin && setShowAdminInspector(true);
    window.addEventListener('scrapalot:open-knowledge-stacks', onOpenStacks);
    window.addEventListener('scrapalot:open-admin', onOpenAdmin);
    return () => {
      window.removeEventListener('scrapalot:open-knowledge-stacks', onOpenStacks);
      window.removeEventListener('scrapalot:open-admin', onOpenAdmin);
    };
  }, [isAdmin]);

  // When the user clicks "Chat with this document" inside the PDF / EPUB /
  // DOCX viewer, the chat-with-document helper fires a window event. The
  // viewer then dispatches a mention into the chat input. If the
  // Knowledge Stacks dialog was the surface that originally opened the
  // viewer, it's now sitting between the viewer and the chat — hiding
  // the chat messages. Listen for the same event and dismiss the
  // dialog so the chat is unobstructed.
  useEffect(() => {
    const handler = () => {
      setShowKnowledgeStackModal(false);
    };
    window.addEventListener('scrapalot:chat-with-document', handler);
    return () => {
      window.removeEventListener('scrapalot:chat-with-document', handler);
    };
  }, []);

  // Get workspace context to check if workspace is loaded
  const { currentWorkspace, isLoading: workspaceLoading, refreshWorkspace } = useWorkspace();

  // User menu state
  const [userData, setUserData] = useState<User | null>(null);
  const [subscriptionData, setSubscriptionData] = useState<UserSubscriptionWithUsage | null>(null);
  const [storageQuota, setStorageQuota] = useState<StorageQuota | null>(null);
  const [_workspaceStorage, setWorkspaceStorage] = useState<WorkspaceStorage | null>(null);
  const [isLoadingUserData, setIsLoadingUserData] = useState(false);
  const [showProfilePictureUpload, setShowProfilePictureUpload] = useState(false);

  const handleNewWorkspace = () => {
    // Two-step navigation: open Settings on the Workspaces tab, then dispatch
    // an event that settings-tab-workspaces listens for and reacts by opening
    // its existing Create Workspace dialog. Direct dialog creation here would
    // duplicate state — the dialog already lives inside the settings tab and
    // owns its own form / validation, so we just trigger it.
    if (openSettingsWithTab) {
      openSettingsWithTab('workspaces');
    }
    // Slight delay so the settings tab mounts and the listener registers
    // before we dispatch (covers the case where settings was previously closed).
    setTimeout(() => {
      window.dispatchEvent(new CustomEvent('scrapalot:open-create-workspace'));
    }, 100);
    setDropdownOpen(false);
    // Mobile menu close — same pattern other dropdown items use.
    const isMobileOrTablet = window.innerWidth < 1080;
    if (isMobileOrTablet && mobileMenuOpen && onCloseMobileMenu) {
      onCloseMobileMenu();
    }
  };

  const handleImportWorkspace = () => {
    // Workspace import has no UI implementation yet — there's no dialog to
    // route to. Surface that state instead of a silent no-op so users know
    // the feature is intentionally pending, not broken.
    toast.info(t('workspace.importComingSoon', 'Workspace import is not yet available.'));
    setDropdownOpen(false);
    const isMobileOrTablet = window.innerWidth < 1080;
    if (isMobileOrTablet && mobileMenuOpen && onCloseMobileMenu) {
      onCloseMobileMenu();
    }
  };

  const toggleDropdown = () => {
    setDropdownOpen(!dropdownOpen);

    // When we close the dropdown, increment the key to trigger a re-render with animation
    if (dropdownOpen) {
      setPlusButtonKey(prev => prev + 1);
    }
  };

  const handleOpenKnowledgeStack = () => {
    // Check if workspace is loading
    if (workspaceLoading) {
      toast.warning(t('general.warnings.pleaseWait'));
      return;
    }

    // Check if workspace exists
    const storedWorkspace = uiState.getCurrentWorkspace();
    if (!storedWorkspace?.id) {
      // No workspace at all - this shouldn't happen after login
      console.error('❌ No workspace in storage');
      toast.error(t('general.warnings.workspaceNotAvailable'));
      return;
    }

    // We have a workspace in storage - open the dialog
    // The dialog will use useWorkspace() hook which will get the current context value
    setShowKnowledgeStackModal(true);
  };

  // Load user data for the menu (initial load)
  useEffect(() => {
    const loadUserMenuData = async () => {
      // Don't load if already loading, not authenticated, or auth not ready
      if (isLoadingUserData || !isAuthenticated || !authState?.authReady) {
        return;
      }

      try {
        setIsLoadingUserData(true);

        // Wait for auth to be ready before making API calls
        if (authState?.waitForAuthReady) {
          try {
            await authState.waitForAuthReady();
          } catch (error) {
            console.warn('⚠️ Auth ready timeout, proceeding anyway');
          }
        }

        const [user, subscription, storage] = await Promise.all([
          getCurrentUser().catch((err) => {
            console.error('❌ Failed to get current user:', err);
            return null;
          }),
          getMySubscription().catch((err) => {
            console.error('❌ Failed to get subscription:', err);
            return null;
          }),
          getMyStorageQuota().catch((err) => {
            console.error('❌ Failed to get storage quota:', err);
            return null;
          }),
        ]);

        setUserData(user);
        setSubscriptionData(subscription);
        setStorageQuota(storage);
      } catch (error) {
        console.error('Failed to load user menu data:', error);
      } finally {
        setIsLoadingUserData(false);
      }
    };

    void loadUserMenuData();

    // Listen for profile picture updates from other components (e.g., settings)
    const handleProfilePictureUpdate = (event: CustomEvent) => {
      if (event.detail?.user) {
        setUserData(event.detail.user);
      }
    };

    // Force-reload user / subscription / storage. Used by both
    // `connectionRestored` (network came back up) and `auth-ready` (Google
    // OAuth callback finished after this component already finished its
    // first render with isAuthenticated=false).
    //
    // Why `auth-ready` is necessary: on Google login the auth state
    // populates in steps — `authState.setAuthReady(true)` mutates a module
    // singleton (not a React state, so no re-render), then `setUser({...})`
    // fires the actual re-render. Between those two and the parallel
    // Promise.all that loads user/subscription/storage, the very first
    // request can race the Authorization header reaching the axios
    // defaults. When that race loses, getMySubscription rejects, the
    // catch swallows, isLoadingUserData flips back to false, and the
    // `[isAuthenticated, authReady]` dep array never changes again (both
    // stuck at true) so the original effect doesn't retry. Result: the
    // user sees a permanent "loading subscription" skeleton until they
    // hard-refresh — the exact symptom users reported. Listening to
    // `auth-ready` gives us a deterministic post-login refresh hook that
    // fires after the auth-context has finished setup.
    const handleAuthReady = async () => {
      console.log('[SidebarQuickTools] auth-ready received, loading user data');
      setIsLoadingUserData(true);
      try {
        const [user, subscription, storage] = await Promise.all([
          getCurrentUser().catch(() => null),
          getMySubscription().catch(() => null),
          getMyStorageQuota().catch(() => null),
        ]);
        setUserData(user);
        setSubscriptionData(subscription);
        setStorageQuota(storage);
      } catch (error) {
        console.error('Failed to load user data on auth-ready:', error);
      } finally {
        setIsLoadingUserData(false);
      }
    };

    // Listen for connection restored events to reload user data
    const handleConnectionRestored = async () => {
      console.log('[SidebarQuickTools] Connection restored, reloading user data');
      // Force reload by resetting loading state and fetching fresh data
      setIsLoadingUserData(true);
      try {
        const [user, subscription, storage] = await Promise.all([
          getCurrentUser().catch(() => null),
          getMySubscription().catch(() => null),
          getMyStorageQuota().catch(() => null),
        ]);
        setUserData(user);
        setSubscriptionData(subscription);
        setStorageQuota(storage);

        // Also refresh workspace if available
        if (refreshWorkspace) {
          void refreshWorkspace();
        }
      } catch (error) {
        console.error('Failed to reload user data after connection restored:', error);
      } finally {
        setIsLoadingUserData(false);
      }
    };

    window.addEventListener('profilePictureUpdated', handleProfilePictureUpdate as EventListener);
    window.addEventListener('connectionRestored', handleConnectionRestored);
    window.addEventListener('auth-ready', handleAuthReady);

    return () => {
      window.removeEventListener('profilePictureUpdated', handleProfilePictureUpdate as EventListener);
      window.removeEventListener('connectionRestored', handleConnectionRestored);
      window.removeEventListener('auth-ready', handleAuthReady);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps -- deps are intentionally limited
  }, [isAuthenticated, authState?.authReady]); // Run when authentication status OR auth ready changes

  // Separate effect to load workspace storage when workspace becomes available
  useEffect(() => {
    const loadWorkspaceStorage = async () => {
      if (!currentWorkspace?.id || !isAuthenticated || !authState?.authReady) {
        return;
      }

      try {
        if (authState?.waitForAuthReady) {
          await authState.waitForAuthReady();
        }
        const wsStorage = await getWorkspaceStorageUsage(currentWorkspace.id);
        setWorkspaceStorage(wsStorage);
      } catch (error) {
        console.error('❌ Failed to get workspace storage:', error);
        setWorkspaceStorage(null);
      }
    };

    void loadWorkspaceStorage();
  // eslint-disable-next-line react-hooks/exhaustive-deps -- deps are intentionally limited
  }, [currentWorkspace?.id, isAuthenticated, authState?.authReady]); // Run when workspace ID or auth changes

  // Helper functions
  const getPlanIcon = (plan: string) => {
    const planLower = plan.toLowerCase();
    switch (planLower) {
      case 'enterprise':
        return <Crown className='w-4 h-4' />;
      case 'pro':
        return <Award className='w-4 h-4' />;
      case 'researcher':
        return <BarChart3 className='w-4 h-4' />;
      default:
        return <Zap className='w-4 h-4' />;
    }
  };

  const getPlanHeaderGradient = () => {
    const plan = subscriptionData?.subscription?.subscription_plan?.name?.toLowerCase() ?? 'researcher';
    const isDark = document.documentElement.classList.contains('dark');
    if (plan === 'pro') {
      return isDark
        ? 'linear-gradient(135deg, #1e293b 0%, #334155 25%, #3d5a80 50%, #1e293b 75%, #334155 100%)'
        : 'linear-gradient(135deg, #64748b 0%, #475569 25%, #5b7a99 50%, #334155 75%, #475569 100%)';
    }
    if (plan === 'enterprise') {
      return isDark
        ? 'linear-gradient(135deg, #78350f 0%, #92400e 25%, #a16207 50%, #78350f 75%, #92400e 100%)'
        : 'linear-gradient(135deg, #d97706 0%, #b45309 25%, #ca8a04 50%, #92400e 75%, #a16207 100%)';
    }
    return isDark
      ? 'linear-gradient(135deg, #1e1b4b 0%, #312e81 30%, #3730a3 55%, #1e3a5f 75%, #1e1b4b 100%)'
      : 'linear-gradient(135deg, #3b82f6 0%, #4338ca 30%, #6366f1 55%, #4f46e5 75%, #3b82f6 100%)';
  };

  const getAccentColorForAvatar = () => {
    switch (accentColor) {
      case 'violet':
        return 'from-violet-500 to-purple-600';
      case 'blue':
        return 'from-blue-500 to-cyan-600';
      case 'green':
        return 'from-green-500 to-emerald-600';
      case 'red':
        return 'from-red-500 to-rose-600';
      case 'orange':
        return 'from-orange-500 to-amber-600';
      case 'gray':
        return 'from-zinc-500 to-gray-600';
      default:
        return 'from-violet-500 to-purple-600';
    }
  };

  const getPlanBadgeColor = (plan: string) => {
    const planLower = plan.toLowerCase();
    switch (planLower) {
      case 'enterprise':
        return 'bg-gradient-to-r from-yellow-500 to-amber-600 text-white';
      case 'pro':
        return 'bg-gradient-to-r from-slate-400 to-slate-600 text-white';
      case 'researcher':
        return 'bg-gradient-to-r from-zinc-400 to-zinc-500 text-white';
      default:
        return 'bg-zinc-200 dark:bg-zinc-700 text-zinc-900 dark:text-white';
    }
  };

  const getStorageColor = (percentage: number | null) => {
    if (percentage === null) return 'bg-zinc-400';
    if (percentage >= 90) return 'bg-red-500';
    if (percentage >= 70) return 'bg-orange-500';
    return 'bg-green-500';
  };

  const getUserInitials = () => {
    if (!userData) return '?';
    const firstName = userData.first_name || '';
    const lastName = userData.last_name || '';
    if (firstName && lastName) {
      return `${firstName[0]}${lastName[0]}`.toUpperCase();
    }
    if (userData.username) {
      return userData.username.substring(0, 2).toUpperCase();
    }
    return userData.email ? userData.email[0].toUpperCase() : '?';
  };

  const handleProfilePictureUploadSuccess = async () => {
    // Reload user data to get the new profile picture
    try {
      const user = await getCurrentUser();
      setUserData(user);
    } catch (error) {
      console.error('Failed to reload user data:', error);
    }
  };

  return (
    <>
      {/* Main sidebar - hidden only on mobile phones (<1080px) */}
      <div
        className={`w-[70px] flex flex-col h-screen-dynamic bg-gradient-to-b from-zinc-100 to-white dark:from-zinc-900 dark:to-black text-zinc-800 dark:text-white
          fixed top-0 left-0 z-30 border-r border-zinc-400/20 dark:border-sidebar-border/70 ${isMobile ? 'hidden' : 'flex'}`}
      >
        <div className='flex-shrink-0 flex flex-col items-center pt-4 gap-4'>
          <div className='relative'>
            <button
              data-testid="sidebar-quick-tools-workspace-button"
              onClick={toggleDropdown}
              className='w-11 h-11 flex items-center justify-center group transition-all duration-300'
            >
              <div className='w-10 h-10 bg-transparent hexagon flex items-center justify-center border border-zinc-400 dark:border-white/30 group-hover:scale-110 transition-all duration-300'>
                <Box className='h-6 w-6 text-zinc-800 dark:text-white group-hover:rotate-45 transition-all duration-300' />
              </div>
            </button>

            <button
              onClick={toggleDropdown}
              className='absolute -bottom-1 -right-1 w-5 h-5 flex items-center justify-center rounded-full text-zinc-600 dark:text-white/70 hover:text-zinc-800 dark:hover:text-white transition-colors'
            >
              <div
                className={`transform transition-transform duration-300 ${dropdownOpen ? 'rotate-180' : 'rotate-0'}`}
              >
                <ChevronDown className='h-3.5 w-3.5' />
              </div>
            </button>
          </div>

          {/* Position the plus button directly below the cube */}
          <div className='plus-button-container'>
            {!dropdownOpen && (
              <DropdownMenu key={plusButtonKey}>
                <DropdownMenuTrigger asChild>
                  <button data-testid="sidebar-quick-tools-plus-button" className='plus-button-dropdown w-10 h-10 flex items-center justify-center'>
                    <div className='w-9 h-9 bg-zinc-200 dark:bg-zinc-800 rounded-full flex items-center justify-center animate-cube-drop'>
                      <Plus className='h-5 w-5 text-zinc-800 dark:text-white' />
                    </div>
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent
                  side='right'
                  align='start'
                  className='bg-popover border-border text-foreground w-56 p-0 mt-1'
                >
                  <div className='px-2 py-2'>
                    <DropdownMenuItem
                      data-testid="sidebar-quick-tools-new-chat-option"
                      onClick={() => {
                        onNewSession();
                        // Close mobile menu if open on mobile devices only
                        const isMobileOrTablet = window.innerWidth < 1080;
                        if (
                          isMobileOrTablet &&
                          mobileMenuOpen &&
                          onCloseMobileMenu
                        ) {
                          onCloseMobileMenu();
                        }
                      }}
                      className='text-sm hover:bg-accent focus:bg-accent focus:text-accent-foreground cursor-pointer rounded px-2 py-1.5'
                    >
                      <Plus className='h-4 w-4 mr-2' />
                      <span>{t('sidebar.newChat')}</span>
                    </DropdownMenuItem>
                  </div>
                  <div className='px-2 pb-2'>
                    <DropdownMenuItem
                      data-testid="sidebar-quick-tools-new-workspace-option"
                      onClick={handleNewWorkspace}
                      className='text-sm hover:bg-accent focus:bg-accent focus:text-accent-foreground cursor-pointer rounded px-2 py-1.5'
                    >
                      <div className='ml-6'>{t('sidebar.newWorkspace')}</div>
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      data-testid="sidebar-quick-tools-import-workspace-option"
                      onClick={handleImportWorkspace}
                      className='text-sm hover:bg-accent focus:bg-accent focus:text-accent-foreground cursor-pointer rounded px-2 py-1.5'
                    >
                      <div className='ml-6'>{t('sidebar.importWorkspace')}</div>
                    </DropdownMenuItem>
                  </div>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>
        </div>

        <div className='flex-1 flex flex-col items-center'>
          <div className='flex-1'></div>

          <div className='flex flex-col items-center gap-4 mb-6 no-mobile-scale'>
            {/* 1. Remote model providers */}
            <button
              data-testid="sidebar-quick-tools-providers-button"
              data-tour="providers"
              className='w-10 h-10 flex items-center justify-center hover:bg-zinc-200 dark:hover:bg-zinc-800'
              onClick={() =>
                openSettingsWithTab
                  ? openSettingsWithTab('remote-providers')
                  : setShowRemoteModelProviders(true)
              }
              title={t('settings.tabs.providers')}
            >
              <Server className='h-5 w-5 text-zinc-600 dark:text-white/70' />
            </button>

            {/* 2. Local AI Models */}
            {isAdmin && (
              <button
                data-testid="sidebar-quick-tools-local-ai-button"
                className='w-10 h-10 flex items-center justify-center hover:bg-zinc-200 dark:hover:bg-zinc-800'
                onClick={() =>
                  openSettingsWithTab ? openSettingsWithTab('local-ai') : null
                }
                title={t('settings.tabs.localai')}
              >
                <Laptop className='h-5 w-5 text-zinc-600 dark:text-white/70' />
              </button>
            )}

            {/* 3. Data Inspector — admin-only. Showed up for every
                user before, but `setShowAdminInspector` opens a
                modal whose data-fetch endpoints all 403 for
                non-admins, so the click silently failed and the
                tour spotlight pointed at a button that did nothing
                useful for the impersonated USER role. */}
            {isAdmin && (
              <button
                data-testid="admin-inspector-button"
                data-tour="admin-inspector"
                className='w-10 h-10 flex items-center justify-center hover:bg-zinc-200 dark:hover:bg-zinc-800'
                onClick={() => setShowAdminInspector(true)}
                title={t('admin.title')}
              >
                <Network className='h-5 w-5 text-zinc-600 dark:text-white/70' />
              </button>
            )}

            {/* 4. Knowledge Stacks */}
            <button
              data-testid="sidebar-quick-tools-knowledge-button"
              data-tour="knowledge-upload"
              className='w-10 h-10 flex items-center justify-center hover:bg-zinc-200 dark:hover:bg-zinc-800'
              onClick={() => handleOpenKnowledgeStack()}
              title={t('sidebar.knowledgeStacks')}
            >
              <Book className='h-5 w-5 text-zinc-600 dark:text-white/70' />
            </button>

            {/* 5. Prompts Library */}
            <button
              data-testid="sidebar-quick-tools-prompts-button"
              data-tour="prompts"
              className='w-10 h-10 flex items-center justify-center hover:bg-zinc-200 dark:hover:bg-zinc-800'
              onClick={() =>
                openSettingsWithTab ? openSettingsWithTab('prompts') : null
              }
              title={t('settings.tabs.prompts')}
            >
              <MessageSquare className='h-5 w-5 text-zinc-600 dark:text-white/70' />
            </button>

            <div data-tour="theme-toggle" className='w-10 h-10 flex items-center justify-center hover:bg-zinc-200 dark:hover:bg-zinc-800'>
              <ThemeToggle />
            </div>

            {/* 6. Settings */}
            <button
              data-testid="sidebar-quick-tools-settings-button"
              data-tour="settings-button"
              className='w-10 h-10 flex items-center justify-center hover:bg-zinc-200 dark:hover:bg-zinc-800'
              onClick={() => {
                if (openSettingsWithTab) {
                  openSettingsWithTab('general');
                } else {
                  setShowSettingsGeneral(true);
                }
                // Close mobile menu if open on mobile devices only
                const isMobileOrTablet = window.innerWidth < 1080;
                if (isMobileOrTablet && mobileMenuOpen && onCloseMobileMenu) {
                  onCloseMobileMenu();
                }
              }}
              title={t('sidebar.settings')}
            >
              <Settings className='h-5 w-5 text-zinc-600 dark:text-white/70' />
            </button>

            {/* 7. User Menu */}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  data-testid="user-menu-button"
                  data-tour="user-menu"
                  className='w-10 h-10 flex items-center justify-center hover:bg-zinc-200 dark:hover:bg-zinc-800 transition-colors rounded-full group'
                  title={userData?.username || 'User menu'}
                >
                  {userData?.profile_picture ? (
                    <ProfileImg
                      pic={userData.profile_picture}
                      alt='Profile'
                      className='w-8 h-8 rounded-full object-cover shadow-lg group-hover:scale-110 transition-transform'
                    />
                  ) : (
                    <div className={`w-8 h-8 rounded-full bg-gradient-to-br ${getAccentColorForAvatar()} flex items-center justify-center text-white text-xs font-semibold shadow-lg group-hover:scale-110 transition-transform`}>
                      {getUserInitials()}
                    </div>
                  )}
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                side='right'
                align='end'
                className='w-80 bg-white/95 dark:bg-zinc-900/95 backdrop-blur-xl border-2 border-zinc-200/50 dark:border-zinc-700/50 shadow-2xl p-0 overflow-hidden'
                sideOffset={8}
              >
                {/* User Info Header */}
                <div className='relative p-6 pb-8' style={{ background: getPlanHeaderGradient() }}>
                  <div className='absolute inset-0 bg-black/10' />
                  <div className='relative flex items-center gap-3'>
                    <div
                      className='relative w-12 h-12 rounded-full bg-white/20 backdrop-blur-sm flex items-center justify-center text-white text-lg font-bold border-2 border-white/30 shadow-xl cursor-pointer group/avatar'
                      onClick={() => setShowProfilePictureUpload(true)}
                    >
                      {userData?.profile_picture ? (
                        <>
                          <ProfileImg
                            pic={userData.profile_picture}
                            alt='Profile'
                            className='w-full h-full rounded-full object-cover'
                          />
                          <div className='absolute inset-0 bg-black/50 rounded-full opacity-0 group-hover/avatar:opacity-100 transition-opacity flex items-center justify-center'>
                            <UserIcon className='w-5 h-5 text-white' />
                          </div>
                        </>
                      ) : (
                        <>
                          {getUserInitials()}
                          <div className='absolute inset-0 bg-black/30 rounded-full opacity-0 group-hover/avatar:opacity-100 transition-opacity flex items-center justify-center'>
                            <UserIcon className='w-5 h-5 text-white' />
                          </div>
                        </>
                      )}
                    </div>
                    <div className='flex-1 min-w-0'>
                      <h3 className='text-white font-semibold text-base truncate'>
                        {userData?.first_name && userData?.last_name
                          ? `${userData.first_name} ${userData.last_name}`
                          : userData?.username || 'User'}
                      </h3>
                      <p className='text-white/80 text-xs truncate'>
                        {userData?.email || ''}
                      </p>
                    </div>
                  </div>
                </div>

                {/* Subscription Plan Badge */}
                <div className='px-4 -mt-4 relative z-10'>
                  {isLoadingUserData || !subscriptionData?.subscription?.subscription_plan ? (
                    <div className='inline-flex items-center gap-2 px-3 py-1.5 h-7'>
                      <div className='w-20 h-4 bg-zinc-300 dark:bg-zinc-700 rounded skeleton-shimmer' />
                    </div>
                  ) : (
                    <div className={`inline-flex items-center gap-2 px-3 py-1.5 text-xs font-semibold shadow-lg ${getPlanBadgeColor(subscriptionData.subscription.subscription_plan.name)}`}>
                      {getPlanIcon(subscriptionData.subscription.subscription_plan.name)}
                      <span className='capitalize'>
                        {subscriptionData.subscription.subscription_plan.display_name || subscriptionData.subscription.subscription_plan.name}
                      </span>
                    </div>
                  )}
                </div>

                {/* Usage Stats */}
                <div className='px-4 py-4 space-y-3'>
                  {/* Storage Usage - Always show user's own quota (not workspace storage) */}
                  {isLoadingUserData || !storageQuota ? (
                    <div className='space-y-1.5'>
                      <div className='flex items-center justify-between text-xs'>
                        <div className='flex items-center gap-1.5'>
                          <div className='w-3.5 h-3.5 bg-zinc-300 dark:bg-zinc-700 rounded skeleton-shimmer' />
                          <div className='w-16 h-3 bg-zinc-300 dark:bg-zinc-700 rounded skeleton-shimmer' />
                        </div>
                        <div className='w-20 h-3 bg-zinc-300 dark:bg-zinc-700 rounded skeleton-shimmer' />
                      </div>
                      <div className='h-1.5 bg-zinc-200 dark:bg-zinc-800 overflow-hidden'>
                        <div className='h-full w-1/3 bg-zinc-300 dark:bg-zinc-700 skeleton-shimmer' />
                      </div>
                    </div>
                  ) : storageQuota ? (
                    <div className='space-y-1.5'>
                      <div className='flex items-center justify-between text-xs'>
                        <div className='flex items-center gap-1.5 text-zinc-600 dark:text-zinc-400'>
                          <HardDrive className='w-3.5 h-3.5' />
                          <span className='font-medium'>Storage</span>
                        </div>
                        <div className='flex items-center gap-1'>
                          <span className='text-zinc-900 dark:text-white font-semibold'>
                            {formatBytes(storageQuota.current_usage_bytes)}
                            {storageQuota.limit_gb && ` / ${storageQuota.limit_gb.toFixed(0)} GB`}
                          </span>
                          {storageQuota.breakdown && (
                            <Popover modal>
                              <PopoverTrigger asChild>
                                <button className='w-3.5 h-3.5 rounded-full bg-zinc-300 dark:bg-zinc-600 text-zinc-600 dark:text-zinc-300 flex items-center justify-center text-[9px] font-bold hover:bg-zinc-400 dark:hover:bg-zinc-500 transition-colors flex-shrink-0' aria-label='Storage breakdown'>
                                  i
                                </button>
                              </PopoverTrigger>
                              <PopoverContent side='right' align='center' className='w-auto text-xs space-y-1 p-2 z-[9999]'>
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
                        </div>
                      </div>
                      <div className='h-1.5 bg-zinc-200 dark:bg-zinc-800 overflow-hidden'>
                        <div
                          className={`h-full transition-all duration-500 ${getStorageColor(storageQuota.percentage_used)}`}
                          style={{ width: `${Math.min(storageQuota.percentage_used || 0, 100)}%` }}
                        />
                      </div>
                    </div>
                  ) : null}

                  {/* Documents Usage - Always show user's own quota */}
                  {isLoadingUserData ? (
                    <div className='space-y-1.5'>
                      <div className='flex items-center justify-between text-xs'>
                        <div className='flex items-center gap-1.5'>
                          <div className='w-3.5 h-3.5 bg-zinc-300 dark:bg-zinc-700 rounded skeleton-shimmer' />
                          <div className='w-20 h-3 bg-zinc-300 dark:bg-zinc-700 rounded skeleton-shimmer' />
                        </div>
                        <div className='w-16 h-3 bg-zinc-300 dark:bg-zinc-700 rounded skeleton-shimmer' />
                      </div>
                      <div className='h-1.5 bg-zinc-200 dark:bg-zinc-800 overflow-hidden'>
                        <div className='h-full w-2/5 bg-zinc-300 dark:bg-zinc-700 skeleton-shimmer' />
                      </div>
                    </div>
                  ) : subscriptionData?.quota_info?.documents ? (
                    <div className='space-y-1.5'>
                      <div className='flex items-center justify-between text-xs'>
                        <div className='flex items-center gap-1.5 text-zinc-600 dark:text-zinc-400'>
                          <FileText className='w-3.5 h-3.5' />
                          <span className='font-medium'>Documents</span>
                        </div>
                        <span className='text-zinc-900 dark:text-white font-semibold'>
                          {subscriptionData.usage.documents_count || 0}
                          {subscriptionData.quota_info.documents.limit && ` / ${subscriptionData.quota_info.documents.limit}`}
                        </span>
                      </div>
                      {subscriptionData.quota_info.documents.limit && (
                        <div className='h-1.5 bg-zinc-200 dark:bg-zinc-800 overflow-hidden'>
                          <div
                            className={`h-full transition-all duration-500 ${getStorageColor(subscriptionData.quota_info.documents.percentage_used)}`}
                            style={{ width: `${Math.min(subscriptionData.quota_info.documents.percentage_used || 0, 100)}%` }}
                          />
                        </div>
                      )}
                    </div>
                  ) : null}

                  {/* Tokens Usage */}
                  {isLoadingUserData ? (
                    <div className='space-y-1.5'>
                      <div className='flex items-center justify-between text-xs'>
                        <div className='flex items-center gap-1.5'>
                          <div className='w-3.5 h-3.5 bg-zinc-300 dark:bg-zinc-700 rounded skeleton-shimmer' />
                          <div className='w-14 h-3 bg-zinc-300 dark:bg-zinc-700 rounded skeleton-shimmer' />
                        </div>
                        <div className='w-24 h-3 bg-zinc-300 dark:bg-zinc-700 rounded skeleton-shimmer' />
                      </div>
                      <div className='h-1.5 bg-zinc-200 dark:bg-zinc-800 overflow-hidden'>
                        <div className='h-full w-1/2 bg-zinc-300 dark:bg-zinc-700 skeleton-shimmer' />
                      </div>
                    </div>
                  ) : subscriptionData?.quota_info?.tokens ? (
                    <div className='space-y-1.5'>
                      <div className='flex items-center justify-between text-xs'>
                        <div className='flex items-center gap-1.5 text-zinc-600 dark:text-zinc-400'>
                          <Zap className='w-3.5 h-3.5' />
                          <span className='font-medium'>Tokens</span>
                        </div>
                        <span className='text-zinc-900 dark:text-white font-semibold'>
                          {(subscriptionData.usage.tokens_used / 1000).toFixed(1)}K
                          {subscriptionData.quota_info.tokens.limit && ` / ${(subscriptionData.quota_info.tokens.limit / 1000).toFixed(0)}K`}
                        </span>
                      </div>
                      {subscriptionData.quota_info.tokens.limit && (
                        <div className='h-1.5 bg-zinc-200 dark:bg-zinc-800 overflow-hidden'>
                          <div
                            className={`h-full transition-all duration-500 ${getStorageColor(subscriptionData.quota_info.tokens.percentage_used)}`}
                            style={{ width: `${Math.min(subscriptionData.quota_info.tokens.percentage_used || 0, 100)}%` }}
                          />
                        </div>
                      )}
                    </div>
                  ) : null}
                </div>

                <DropdownMenuSeparator className='my-0 bg-zinc-200 dark:bg-zinc-800' />

                {/* Account Settings */}
                <DropdownMenuItem
                  data-testid="user-menu-account"
                  onClick={() => openSettingsWithTab ? openSettingsWithTab('account') : null}
                  className='mx-2 my-2 cursor-pointer hover:bg-zinc-100 dark:hover:bg-zinc-800 px-3 py-2.5 transition-colors'
                >
                  <Settings className='w-4 h-4 mr-3 text-zinc-600 dark:text-zinc-400' />
                  <span className='text-sm font-medium text-zinc-900 dark:text-white'>
                    {t('settings.tabs.account')}
                  </span>
                </DropdownMenuItem>

                <DropdownMenuSeparator className='my-0 bg-zinc-200 dark:bg-zinc-800' />

                {/* Logout Button */}
                <DropdownMenuItem
                  data-testid="user-menu-logout"
                  onClick={logout}
                  className='mx-2 my-2 cursor-pointer hover:bg-red-50 dark:hover:bg-red-950/30 px-3 py-2.5 transition-colors'
                >
                  <LogOut className='w-4 h-4 mr-3 text-red-500 dark:text-red-400' />
                  <span className='text-sm font-medium text-red-600 dark:text-red-400'>
                    {t('sidebar.logOut')}
                  </span>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>

        {/* Data Inspector Dialog - only render when it's actually open */}
        {showAdminInspector && (
          <DocumentInspectorDialog
            open={showAdminInspector}
            onOpenChange={setShowAdminInspector}
          />
        )}

        {/* Knowledge Stack Modal - only render when it's actually open */}
        {showKnowledgeStackModal && (
          <KnowledgeStacksDialog
            open={showKnowledgeStackModal}
            onOpenChange={setShowKnowledgeStackModal}
          />
        )}

        {/* Profile Picture Upload Dialog */}
        <ProfilePictureUpload
          open={showProfilePictureUpload}
          onOpenChange={setShowProfilePictureUpload}
          onUploadSuccess={handleProfilePictureUploadSuccess}
        />
      </div>
    </>
  );
};
