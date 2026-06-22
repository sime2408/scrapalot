import React, { useCallback, useEffect, useState, useRef } from 'react';
import { useTranslation } from 'react-i18next';
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
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  LayoutGrid,
  Plus,
  Trash2,
  Edit3,
  MoreVertical,
  FolderOpen,
  Loader2,
  Share2,
  Users,
  UserMinus,
  Crown,
  Shield,
  Eye,
  HelpCircle,
  Sparkles,
  Calendar,
  ArrowRight,
  Check,
} from 'lucide-react';
import { toast } from '@/lib/toast-compat';
import { useTheme } from '@/providers/theme-provider';
import { useDesktopMode } from '@/hooks/use-desktop-mode';
import {
  getWorkspaces,
  type Workspace,
  type WorkspaceUser,
  createWorkspace,
  updateWorkspace,
  deleteWorkspace,
  shareWorkspace,
  getWorkspaceUsers,
  removeWorkspaceAccess,
  updateWorkspaceUserRole,
  permissionToRole,
} from '@/lib/api-workspace';
import { searchUsers, type User } from '@/lib/api-users';
import { getCollections } from '@/lib/api-collections';
import { useWorkspace } from '@/hooks/use-workspace';
import { useIsMobile } from '@/hooks/use-mobile';
import { useAuth } from '@/hooks/use-auth';
import { cn } from '@/lib/utils';
import { DocumentCollection } from '@/types';
import { getMySubscription } from '@/lib/api-subscriptions';
import { AnimatedTooltip, type AnimatedTooltipItem } from '@/components/ui/animated-tooltip';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { profilePicSources } from '@/lib/profile-picture';

// Accent color utility functions for dynamic theming
const getAccentTextClasses = (color: string) => {
  const map: Record<string, string> = {
    gray: 'text-zinc-600 dark:text-zinc-400',
    blue: 'text-blue-600 dark:text-blue-400',
    green: 'text-green-600 dark:text-green-400',
    red: 'text-red-600 dark:text-red-400',
    violet: 'text-violet-600 dark:text-violet-400',
    orange: 'text-orange-600 dark:text-orange-400',
  };
  return map[color] || map.violet;
};

const getAccentBgClasses = (color: string) => {
  const map: Record<string, string> = {
    gray: 'bg-zinc-100 dark:bg-zinc-950',
    blue: 'bg-blue-100 dark:bg-blue-950',
    green: 'bg-green-100 dark:bg-green-950',
    red: 'bg-red-100 dark:bg-red-950',
    violet: 'bg-violet-100 dark:bg-violet-950',
    orange: 'bg-orange-100 dark:bg-orange-950',
  };
  return map[color] || map.violet;
};

const getAccentButtonClasses = (color: string) => {
  const map: Record<string, string> = {
    gray: 'bg-zinc-600 hover:bg-zinc-700 dark:bg-zinc-600 dark:hover:bg-zinc-500 text-white',
    blue: 'bg-blue-600 hover:bg-blue-700 dark:bg-blue-600 dark:hover:bg-blue-500 text-white',
    green: 'bg-green-600 hover:bg-green-700 dark:bg-green-600 dark:hover:bg-green-500 text-white',
    red: 'bg-red-600 hover:bg-red-700 dark:bg-red-600 dark:hover:bg-red-500 text-white',
    violet: 'bg-violet-600 hover:bg-violet-700 dark:bg-violet-600 dark:hover:bg-violet-500 text-white',
    orange: 'bg-orange-600 hover:bg-orange-700 dark:bg-orange-600 dark:hover:bg-orange-500 text-white',
  };
  return map[color] || map.violet;
};

const getAccentBorderClasses = (color: string) => {
  const map: Record<string, string> = {
    gray: 'border-zinc-400 dark:border-zinc-600',
    blue: 'border-blue-400 dark:border-blue-600',
    green: 'border-green-400 dark:border-green-600',
    red: 'border-red-400 dark:border-red-600',
    violet: 'border-violet-400 dark:border-violet-600',
    orange: 'border-orange-400 dark:border-orange-600',
  };
  return map[color] || map.violet;
};

const getAccentHoverBorderClasses = (color: string) => {
  const map: Record<string, string> = {
    gray: 'hover:border-zinc-300 dark:hover:border-zinc-700',
    blue: 'hover:border-blue-300 dark:hover:border-blue-700',
    green: 'hover:border-green-300 dark:hover:border-green-700',
    red: 'hover:border-red-300 dark:hover:border-red-700',
    violet: 'hover:border-violet-300 dark:hover:border-violet-700',
    orange: 'hover:border-orange-300 dark:hover:border-orange-700',
  };
  return map[color] || map.violet;
};

const getAccentGradientClasses = (color: string) => {
  const map: Record<string, string> = {
    gray: 'bg-gradient-to-r from-zinc-50 to-slate-50 dark:from-zinc-950/30 dark:to-slate-950/30 border-zinc-200 dark:border-zinc-800/50',
    blue: 'bg-gradient-to-r from-blue-50 to-sky-50 dark:from-blue-950/30 dark:to-sky-950/30 border-blue-200 dark:border-blue-800/50',
    green: 'bg-gradient-to-r from-green-50 to-emerald-50 dark:from-green-950/30 dark:to-emerald-950/30 border-green-200 dark:border-green-800/50',
    red: 'bg-gradient-to-r from-red-50 to-rose-50 dark:from-red-950/30 dark:to-rose-950/30 border-red-200 dark:border-red-800/50',
    violet: 'bg-gradient-to-r from-violet-50 to-purple-50 dark:from-violet-950/30 dark:to-purple-950/30 border-violet-200 dark:border-violet-800/50',
    orange: 'bg-gradient-to-r from-orange-50 to-amber-50 dark:from-orange-950/30 dark:to-amber-950/30 border-orange-200 dark:border-orange-800/50',
  };
  return map[color] || map.violet;
};

const getAccentBadgeClasses = (color: string) => {
  const map: Record<string, string> = {
    gray: 'bg-zinc-100 dark:bg-zinc-900/50 text-zinc-700 dark:text-zinc-300',
    blue: 'bg-blue-100 dark:bg-blue-900/50 text-blue-700 dark:text-blue-300',
    green: 'bg-green-100 dark:bg-green-900/50 text-green-700 dark:text-green-300',
    red: 'bg-red-100 dark:bg-red-900/50 text-red-700 dark:text-red-300',
    violet: 'bg-violet-100 dark:bg-violet-900/50 text-violet-700 dark:text-violet-300',
    orange: 'bg-orange-100 dark:bg-orange-900/50 text-orange-700 dark:text-orange-300',
  };
  return map[color] || map.violet;
};

const getAccentDotClasses = (color: string) => {
  const map: Record<string, string> = {
    gray: 'bg-zinc-500',
    blue: 'bg-blue-500',
    green: 'bg-green-500',
    red: 'bg-red-500',
    violet: 'bg-violet-500',
    orange: 'bg-orange-500',
  };
  return map[color] || map.violet;
};

const getAccentActiveTextClasses = (color: string) => {
  const map: Record<string, string> = {
    gray: 'text-zinc-700 dark:text-zinc-300',
    blue: 'text-blue-700 dark:text-blue-300',
    green: 'text-green-700 dark:text-green-300',
    red: 'text-red-700 dark:text-red-300',
    violet: 'text-violet-700 dark:text-violet-300',
    orange: 'text-orange-700 dark:text-orange-300',
  };
  return map[color] || map.violet;
};

interface SettingsWorkspacesTabProps {
  preloadedWorkspaces?: Workspace[];
  preloadedWorkspaceCollections?: Record<string, DocumentCollection[]>;
  isPreloadingWorkspaces?: boolean;
}

export const SettingsWorkspacesTab = ({
  preloadedWorkspaces = [],
  preloadedWorkspaceCollections = {},
  isPreloadingWorkspaces: _isPreloadingWorkspaces = false,
}: SettingsWorkspacesTabProps) => {
  const { t } = useTranslation();
  const { accentColor } = useTheme();
  const isMobile = useIsMobile();
  const { currentWorkspace, selectWorkspace } = useWorkspace();
  const { user } = useAuth();
  const { isDesktop } = useDesktopMode();
  const [storageTooltipOpen, setStorageTooltipOpen] = useState(false);

  // State for workspaces list and pagination
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [workspaceCollections, setWorkspaceCollections] = useState<Record<string, DocumentCollection[]>>({});
  const [workspaceMembers, setWorkspaceMembers] = useState<Record<string, WorkspaceUser[]>>({});
  const [isLoading, setIsLoading] = useState(false);
  const [currentPage, _setCurrentPage] = useState(1);
  const [_pagesCount, setPagesCount] = useState(1);
  const [totalWorkspaces, setTotalWorkspaces] = useState(0);
  const pageSize = 10;

  // Track if we've initialized data to prevent re-fetching
  const hasInitialized = useRef(false);

  // State for workspace creation/editing
  const [isCreatingWorkspace, setIsCreatingWorkspace] = useState(false);
  const [isEditingWorkspace, setIsEditingWorkspace] = useState(false);
  const [workspaceName, setWorkspaceName] = useState('');
  const [workspaceToEdit, setWorkspaceToEdit] = useState<string | null>(null);

  // State for deletion confirmation
  const [isDeleteConfirmationOpen, setIsDeleteConfirmationOpen] = useState(false);
  const [workspaceToDelete, setWorkspaceToDelete] = useState<string | null>(null);

  // State for share dialog
  const [isShareDialogOpen, setIsShareDialogOpen] = useState(false);
  const [workspaceToShare, setWorkspaceToShare] = useState<string | null>(null);
  const [_shareEmail, setShareEmail] = useState('');
  const [shareRole, setShareRole] = useState('viewer');

  // State for user search
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<User[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [showSearchResults, setShowSearchResults] = useState(false);
  const [selectedUser, setSelectedUser] = useState<User | null>(null);
  const searchTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  // State for user management dialog
  const [isUserManagementOpen, setIsUserManagementOpen] = useState(false);
  const [workspaceForUserManagement, setWorkspaceForUserManagement] = useState<string | null>(null);
  const [workspaceUsers, setWorkspaceUsers] = useState<WorkspaceUser[]>([]);
  const [isLoadingUsers, setIsLoadingUsers] = useState(false);

  // Track which workspace cards have their collections expanded
  const [expandedCollections, setExpandedCollections] = useState<Record<string, boolean>>({});

  // Check if user can share workspaces based on their subscription plan
  const [canShareWorkspaces, setCanShareWorkspaces] = useState(false);

  useEffect(() => {
    if (isDesktop) return;
    // Admin users can always share; otherwise check subscription plan
    if (user?.role === 'admin') {
      setCanShareWorkspaces(true);
      return;
    }
    getMySubscription().then(sub => {
      const planName = sub?.subscription?.subscription_plan?.name?.toLowerCase();
      setCanShareWorkspaces(planName !== undefined && planName !== 'free');
    }).catch(() => {
      setCanShareWorkspaces(false);
    });
  }, [isDesktop, user?.role]);

  // Fetch workspaces with their collections
  const fetchWorkspacesWithCollections = useCallback(async () => {
    setIsLoading(true);
    try {
      const workspacesData = await getWorkspaces(currentPage, pageSize, true);
      setWorkspaces(workspacesData.workspaces);
      setPagesCount(workspacesData.pagination.pages);
      setTotalWorkspaces(workspacesData.pagination.total);

      // Fetch collections for each workspace in parallel with higher limit
      const collectionsMap: Record<string, DocumentCollection[]> = {};
      const fetchPromises = workspacesData.workspaces.map(async (workspace) => {
        try {
          // Fetch up to 1000 collections per workspace to get all of them
          const collectionsData = await getCollections(workspace.id, 1, 1000);
          return { workspaceId: workspace.id, collections: collectionsData.collections };
        } catch (error) {
          console.error(`Error fetching collections for workspace ${workspace.id}:`, error);
          return { workspaceId: workspace.id, collections: [] };
        }
      });

      const results = await Promise.all(fetchPromises);
      results.forEach(({ workspaceId, collections }) => {
        collectionsMap[workspaceId] = collections;
      });
      setWorkspaceCollections(collectionsMap);

      // Fetch members for each workspace in parallel
      const membersMap: Record<string, WorkspaceUser[]> = {};
      const memberPromises = workspacesData.workspaces.map(async (workspace) => {
        const users = await getWorkspaceUsers(workspace.id);
        return { workspaceId: workspace.id, users };
      });
      const memberResults = await Promise.all(memberPromises);
      memberResults.forEach(({ workspaceId, users }) => {
        membersMap[workspaceId] = users;
      });
      setWorkspaceMembers(membersMap);
    } catch (error) {
      console.error('Error fetching workspaces:', error);
      toast({
        title: 'Error',
        description: 'Failed to fetch workspaces',
        variant: 'destructive',
      });
    } finally {
      setIsLoading(false);
    }
  }, [currentPage, pageSize]);

  // Initialize data on component mount
  useEffect(() => {
    if (hasInitialized.current) return;
    hasInitialized.current = true;

    if (preloadedWorkspaces.length > 0) {
      setWorkspaces(preloadedWorkspaces);
      setWorkspaceCollections(preloadedWorkspaceCollections);
      setIsLoading(false);
      setPagesCount(Math.ceil(preloadedWorkspaces.length / pageSize));
      setTotalWorkspaces(preloadedWorkspaces.length);

      // Fetch members separately (not included in preloaded data)
      Promise.all(preloadedWorkspaces.map(async (ws) => {
        const users = await getWorkspaceUsers(ws.id);
        return { workspaceId: ws.id, users };
      })).then((results) => {
        const membersMap: Record<string, WorkspaceUser[]> = {};
        results.forEach(({ workspaceId, users }) => { membersMap[workspaceId] = users; });
        setWorkspaceMembers(membersMap);
      });
    } else {
      void fetchWorkspacesWithCollections();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- deps are intentionally limited
  }, []);

  // Fallback timeout to prevent infinite loading
  useEffect(() => {
    const timeout = setTimeout(() => {
      if (isLoading) {
        console.warn('Workspaces loading timeout - forcing loading state to false');
        setIsLoading(false);
      }
    }, 5000);

    return () => clearTimeout(timeout);
  }, [isLoading]);

  // Open the Create Workspace dialog when triggered externally (e.g. the
  // sidebar plus-button → "Novi radni prostor"). Sidebar can't reach into
  // this component's state directly, so it dispatches a window event and
  // we react here.
  useEffect(() => {
    const handler = () => setIsCreatingWorkspace(true);
    window.addEventListener('scrapalot:open-create-workspace', handler);
    return () => {
      window.removeEventListener('scrapalot:open-create-workspace', handler);
    };
  }, []);

  // Handle workspace selection
  const handleSelectWorkspace = async (workspaceId: string) => {
    if (currentWorkspace && currentWorkspace.id === workspaceId) {
      toast({
        title: 'Info',
        description: 'This workspace is already active',
        variant: 'default',
      });
      return;
    }

    try {
      await selectWorkspace(workspaceId);
      toast({
        title: 'Success',
        description: 'Workspace switched successfully',
        variant: 'default',
      });
    } catch (error) {
      console.error('Error selecting workspace:', error);
      toast({
        title: 'Error',
        description: 'Failed to switch workspace',
        variant: 'destructive',
      });
    }
  };

  // Handle workspace creation
  const handleCreateWorkspace = async () => {
    if (!workspaceName.trim()) {
      toast({
        title: 'Error',
        description: 'Please enter a workspace name',
        variant: 'destructive',
      });
      return;
    }

    try {
      const result = await createWorkspace(workspaceName.trim());
      if (result) {
        setWorkspaceName('');
        setIsCreatingWorkspace(false);
        void fetchWorkspacesWithCollections();
      }
    } catch (error) {
      console.error('Error creating workspace:', error);
    }
  };

  // Handle workspace update/rename
  const handleUpdateWorkspace = async () => {
    if (!workspaceToEdit || !workspaceName.trim()) {
      toast({
        title: 'Error',
        description: 'Please enter a workspace name',
        variant: 'destructive',
      });
      return;
    }

    try {
      const result = await updateWorkspace(workspaceToEdit, workspaceName.trim());
      if (result) {
        setWorkspaceName('');
        setWorkspaceToEdit(null);
        setIsEditingWorkspace(false);
        void fetchWorkspacesWithCollections();
      }
    } catch (error) {
      console.error('Error updating workspace:', error);
    }
  };

  // Handle workspace deletion
  const handleDeleteWorkspace = async () => {
    if (!workspaceToDelete) return;

    try {
      const success = await deleteWorkspace(workspaceToDelete);
      if (success) {
        // Optimistically remove from local state for instant UI update
        setWorkspaces(prev => prev.filter(w => w.id !== workspaceToDelete));
        setWorkspaceCollections(prev => {
          const next = { ...prev };
          delete next[workspaceToDelete];
          return next;
        });
        setTotalWorkspaces(prev => Math.max(0, prev - 1));

        // Also refresh from backend (with cache bypass) to ensure consistency
        void fetchWorkspacesWithCollections();
      }
    } catch (error) {
      console.error('Error deleting workspace:', error);
    } finally {
      setIsDeleteConfirmationOpen(false);
      setWorkspaceToDelete(null);
    }
  };

  // Handle user search with debouncing
  const handleSearchQueryChange = useCallback((value: string) => {
    setSearchQuery(value);
    setShowSearchResults(true);

    if (selectedUser && value !== selectedUser.email) {
      setSelectedUser(null);
      setShareEmail('');
    }

    if (searchTimeoutRef.current) {
      clearTimeout(searchTimeoutRef.current);
    }

    if (value.length >= 4) {
      setIsSearching(true);
      searchTimeoutRef.current = setTimeout(async () => {
        try {
          const results = await searchUsers(value, 1, 10);
          setSearchResults(results.users);
        } catch (error) {
          console.error('Error searching users:', error);
          setSearchResults([]);
        } finally {
          setIsSearching(false);
        }
      }, 300);
    } else {
      setSearchResults([]);
      setIsSearching(false);
    }
  }, [selectedUser]);

  // Handle user selection from search results
  const handleSelectUser = useCallback((user: User) => {
    setSelectedUser(user);
    setShareEmail(user.email);
    setSearchQuery(user.email);
    setShowSearchResults(false);
    setSearchResults([]);
  }, []);

  // Handle workspace sharing
  const handleShareWorkspace = async () => {
    if (!workspaceToShare || !selectedUser) {
      toast({
        title: t('general.error'),
        description: t('workspace.pleaseEnterEmail'),
        variant: 'destructive',
      });
      return;
    }

    try {
      const success = await shareWorkspace(workspaceToShare, selectedUser.id, shareRole);
      if (success) {
        setShareEmail('');
        setShareRole('viewer');
        setWorkspaceToShare(null);
        setIsShareDialogOpen(false);
        if (isUserManagementOpen && workspaceForUserManagement === workspaceToShare) {
          await loadWorkspaceUsers(workspaceToShare);
        }
      }
    } catch (error) {
      console.error('Error sharing workspace:', error);
    }
  };

  // Load workspace users
  const loadWorkspaceUsers = async (workspaceId: string) => {
    setIsLoadingUsers(true);
    try {
      // Members live at GET /workspaces/:id/users — the plain GET /workspaces/:id
      // response has no `users` field, so reading it left workspaceUsers undefined
      // and crashed the dialog on `.length`. getWorkspaceUsers returns [] on error.
      const users = await getWorkspaceUsers(workspaceId);
      setWorkspaceUsers(Array.isArray(users) ? users : []);
    } catch (error) {
      console.error('Error loading workspace users:', error);
      toast({
        title: 'Error',
        description: 'Failed to load workspace users',
        variant: 'destructive',
      });
    } finally {
      setIsLoadingUsers(false);
    }
  };

  // Handle opening user management
  const handleOpenUserManagement = async (workspaceId: string) => {
    setWorkspaceForUserManagement(workspaceId);
    setIsUserManagementOpen(true);
    await loadWorkspaceUsers(workspaceId);
  };

  // Handle removing user access
  const handleRemoveUserAccess = async (userId: string, username: string) => {
    if (!workspaceForUserManagement) return;

    try {
      const success = await removeWorkspaceAccess(workspaceForUserManagement, userId);
      if (success) {
        toast({
          title: 'Success',
          description: `Removed ${username}'s access to workspace`,
          variant: 'default',
        });
        await loadWorkspaceUsers(workspaceForUserManagement);
      }
    } catch (error) {
      console.error('Error removing user access:', error);
    }
  };

  // Handle updating user role
  const handleUpdateUserRole = async (userId: string, newRole: string, username: string) => {
    if (!workspaceForUserManagement) return;

    try {
      const success = await updateWorkspaceUserRole(workspaceForUserManagement, userId, newRole);
      if (success) {
        toast({
          title: 'Success',
          description: `Updated ${username}'s role to ${newRole}`,
          variant: 'default',
        });
        await loadWorkspaceUsers(workspaceForUserManagement);
      }
    } catch (error) {
      console.error('Error updating user role:', error);
    }
  };

  // Get role icon
  const getRoleIcon = (role: string, size = 'h-4 w-4') => {
    switch (role) {
      case 'owner':
        return <Crown className={cn(size, 'text-amber-500')} />;
      case 'editor':
        return <Shield className={cn(size, 'text-blue-500')} />;
      case 'viewer':
        return <Eye className={cn(size, 'text-emerald-500')} />;
      default:
        return <Eye className={cn(size, 'text-muted-foreground')} />;
    }
  };

  // Get role display name
  const getRoleDisplayName = (role: string) => {
    switch (role) {
      case 'owner':
        return t('workspace.roles.owner');
      case 'editor':
        return t('workspace.roles.editor');
      case 'viewer':
        return t('workspace.roles.viewer');
      default:
        return role;
    }
  };

  // Format date helper
  const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric'
    });
  };

  return (
    <div className="space-y-6">
      {/* Header Section */}
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-start gap-4">
          <div className={cn('w-10 h-10 flex items-center justify-center mt-1', getAccentBgClasses(accentColor))}>
            <LayoutGrid className={cn('w-5 h-5', getAccentTextClasses(accentColor))} />
          </div>
          <div className="space-y-1">
            <h3 className="text-lg font-semibold text-zinc-900 dark:text-white">
              {t('settings.tabs.workspaces')}
            </h3>
            <div className="flex items-center gap-2">
              <p className="text-sm text-zinc-600 dark:text-zinc-400">
                {t('workspace.manageWorkspacesAndCollections')}
              </p>
              {!isMobile && (
                <TooltipProvider>
                  <Tooltip open={storageTooltipOpen} onOpenChange={(open) => { if (!open) setStorageTooltipOpen(false); }}>
                    <TooltipTrigger asChild>
                      <button
                        className='p-1 text-zinc-500 hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-200 transition-colors'
                        onClick={() => setStorageTooltipOpen(v => !v)}
                        onMouseDown={(e) => e.preventDefault()}
                      >
                        <HelpCircle className='w-4 h-4' />
                      </button>
                    </TooltipTrigger>
                    <TooltipContent side='bottom' className='max-w-sm p-4 text-xs' sideOffset={5}>
                      <div className='space-y-3'>
                        <p className='font-semibold text-sm'>{t('settings.workspaces.storageQuotaInfo')}</p>
                        <div className='space-y-2 text-zinc-500 dark:text-zinc-400'>
                          <p>{t('settings.workspaces.uploadsCountAgainstOwner')}</p>
                          <p>{t('settings.workspaces.ownCollections')}</p>
                        </div>
                      </div>
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              )}
            </div>
          </div>
        </div>
        <Button
          data-testid="settings-workspace-create-button"
          onClick={() => setIsCreatingWorkspace(true)}
          size={isMobile ? 'icon' : 'default'}
          className={cn('shrink-0', getAccentButtonClasses(accentColor))}
        >
          <Plus className={cn('h-4 w-4', !isMobile && 'mr-2')} />
          {!isMobile && <span>{t('workspace.new')}</span>}
        </Button>
      </div>

      {/* Stats Summary */}
      {!isLoading && workspaces.length > 0 && (
        <div className={cn('flex items-center gap-6 px-4 py-3 border', getAccentGradientClasses(accentColor))}>
          <div className="flex items-center gap-2">
            <div className={cn('w-2 h-2 animate-pulse', getAccentDotClasses(accentColor))} />
            <span className={cn('text-sm font-medium', getAccentActiveTextClasses(accentColor))}>{t('settings.workspaces.workspaceCount', { count: totalWorkspaces })}</span>
          </div>
          <div className="h-4 w-px bg-zinc-300 dark:bg-zinc-700" />
          <div className={cn('flex items-center gap-2 text-sm', getAccentActiveTextClasses(accentColor))}>
            <FolderOpen className="h-4 w-4" />
            <span>{t('settings.workspaces.knowledgeBaseCount', { count: Object.values(workspaceCollections).reduce((sum, cols) => sum + cols.length, 0) })}</span>
          </div>
        </div>
      )}

      {/* Content Area */}
      <div data-testid="settings-workspace-list" className="space-y-4">
        {workspaces.length === 0 && !isLoading ? (
          <div className={cn('flex flex-col items-center justify-center py-16 px-8 border-2 border-dashed', getAccentBorderClasses(accentColor))}>
            <div className={cn('w-20 h-20 flex items-center justify-center border mb-6', getAccentBgClasses(accentColor), getAccentBorderClasses(accentColor))}>
              <Sparkles className={cn('h-10 w-10', getAccentTextClasses(accentColor))} />
            </div>
            <h3 className='text-lg font-semibold text-zinc-900 dark:text-white mb-2'>
              {t('workspace.noWorkspacesFound')}
            </h3>
            <p className='text-sm text-zinc-600 dark:text-zinc-400 text-center mb-6 max-w-sm'>
              Create your first workspace to organize your knowledge bases and documents.
            </p>
            <Button onClick={() => setIsCreatingWorkspace(true)} size="lg" className={getAccentButtonClasses(accentColor)}>
              <Plus className='h-5 w-5 mr-2' />
              Create Your First Workspace
            </Button>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
            {workspaces.map((workspace, index) => {
              const isActive = workspace.id === currentWorkspace?.id;
              const collections = workspaceCollections[workspace.id] || [];
              const members = workspaceMembers[workspace.id] || [];
              // Derive role: use explicit role if available, otherwise check user_id ownership
              const effectiveRole = workspace.role || (workspace.user_id === user?.id ? 'owner' : 'viewer');

              // Build animated tooltip items from workspace members
              // API returns { userId, permission, addedAt, username?, email? }
              const memberTooltipItems: AnimatedTooltipItem[] = members.map((m: { user_id?: string; userId?: string; username?: string; email?: string; role?: string; permission?: string; profilePicture?: string; profile_picture?: string }) => {
                const id = m.user_id || m.userId;
                const picSources = profilePicSources(m.profilePicture || m.profile_picture);
                return {
                  id,
                  name: m.username || m.email || 'User',
                  designation: getRoleDisplayName(m.role || m.permission || 'viewer'),
                  image: picSources.src,
                  imageFallback: picSources.fallbackSrc,
                };
              });

              return (
                <div
                  key={workspace.id}
                  data-testid={`settings-workspace-item-${workspace.id}`}
                  style={{ animationDelay: `${index * 50}ms` }}
                  className={cn(
                    'group relative transition-all duration-200 animate-in fade-in slide-in-from-bottom-2',
                    'bg-white dark:bg-zinc-950 border',
                    isActive
                      ? cn(getAccentBorderClasses(accentColor), 'shadow-md')
                      : cn('border-zinc-200 dark:border-zinc-800 hover:shadow-md', getAccentHoverBorderClasses(accentColor))
                  )}
                >
                  {/* Active indicator line */}
                  {isActive && (
                    <div className={cn('absolute top-0 left-0 right-0 h-0.5', getAccentDotClasses(accentColor))} />
                  )}

                  <div className='p-5'>
                    {/* Header */}
                    <div className='flex items-start justify-between gap-3 mb-4'>
                      <div className='flex-1 min-w-0'>
                        {/* Title Row */}
                        <div className='flex items-center gap-2 mb-2'>
                          <h3 className={cn(
                            'text-base font-semibold truncate',
                            isActive ? getAccentActiveTextClasses(accentColor) : 'text-zinc-900 dark:text-white'
                          )}>
                            {workspace.name}
                          </h3>
                          {isActive && (
                            <span className={cn('shrink-0 inline-flex items-center gap-1 px-2 py-0.5 text-xs font-medium', getAccentBadgeClasses(accentColor))}>
                              <Check className="w-3 h-3" />
                              Active
                            </span>
                          )}
                        </div>

                        {/* Metadata Row */}
                        <div className='flex items-center gap-2 flex-wrap'>
                          {/* Role Badge */}
                          {effectiveRole && (
                            <span className={cn(
                              'inline-flex items-center gap-1 px-2 py-0.5 text-xs font-medium',
                              effectiveRole === 'owner' && 'bg-amber-100 dark:bg-amber-900/50 text-amber-700 dark:text-amber-300',
                              effectiveRole === 'editor' && 'bg-blue-100 dark:bg-blue-900/50 text-blue-700 dark:text-blue-300',
                              effectiveRole === 'viewer' && 'bg-emerald-100 dark:bg-emerald-900/50 text-emerald-700 dark:text-emerald-300'
                            )}>
                              {getRoleIcon(effectiveRole, 'h-3 w-3')}
                              <span className="capitalize">{effectiveRole}</span>
                            </span>
                          )}

                          {/* Members Avatars */}
                          {memberTooltipItems.length > 0 && (
                            <AnimatedTooltip items={memberTooltipItems} size="sm" className="ml-1" />
                          )}

                          {/* Date */}
                          <span className='inline-flex items-center gap-1 text-xs text-zinc-500 dark:text-zinc-400'>
                            <Calendar className='w-3 h-3' />
                            {formatDate(workspace.created_at)}
                          </span>
                        </div>
                      </div>

                      {/* Actions Menu */}
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            variant='ghost'
                            size='icon'
                            className='h-8 w-8 opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity'
                          >
                            <MoreVertical className='h-4 w-4' />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align='end' className='w-52 z-[1100]'>
                          <DropdownMenuItem
                            onClick={() => handleSelectWorkspace(workspace.id)}
                            disabled={isActive}
                          >
                            {isActive ? (
                              <>
                                <Check className='h-4 w-4 mr-2 text-primary' />
                                <span className="text-primary">{t('workspace.currentWorkspace')}</span>
                              </>
                            ) : (
                              <>
                                <ArrowRight className='h-4 w-4 mr-2' />
                                {t('workspace.switchTo')}
                              </>
                            )}
                          </DropdownMenuItem>

                          <DropdownMenuItem
                            onClick={() => {
                              setWorkspaceToEdit(workspace.id);
                              setWorkspaceName(workspace.name);
                              setIsEditingWorkspace(true);
                            }}
                            disabled={effectiveRole !== 'owner'}
                          >
                            <Edit3 className='h-4 w-4 mr-2' />
                            {t('workspace.rename')}
                            {effectiveRole !== 'owner' && (
                              <span className='ml-auto text-[10px] text-muted-foreground'>Owner</span>
                            )}
                          </DropdownMenuItem>

                          <DropdownMenuItem
                            onClick={() => {
                              if (canShareWorkspaces && effectiveRole === 'owner') {
                                setWorkspaceToShare(workspace.id);
                                setIsShareDialogOpen(true);
                              }
                            }}
                            disabled={effectiveRole !== 'owner' || !canShareWorkspaces}
                          >
                            <Share2 className='h-4 w-4 mr-2' />
                            {t('workspace.share')}
                            {effectiveRole !== 'owner' && (
                              <span className='ml-auto text-[10px] text-muted-foreground'>Owner</span>
                            )}
                            {effectiveRole === 'owner' && !canShareWorkspaces && (
                              <span className='ml-auto text-[10px] text-muted-foreground'>Pro+</span>
                            )}
                          </DropdownMenuItem>

                          <DropdownMenuItem
                            onClick={() => {
                              if (canShareWorkspaces && effectiveRole === 'owner') {
                                void handleOpenUserManagement(workspace.id);
                              }
                            }}
                            disabled={effectiveRole !== 'owner' || !canShareWorkspaces}
                          >
                            <Users className='h-4 w-4 mr-2' />
                            {t('workspace.manageUsers')}
                          </DropdownMenuItem>

                          <DropdownMenuSeparator />

                          <TooltipProvider delayDuration={200}>
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <DropdownMenuItem
                                  onClick={() => {
                                    if (!isActive && collections.length === 0 && effectiveRole === 'owner') {
                                      setWorkspaceToDelete(workspace.id);
                                      setIsDeleteConfirmationOpen(true);
                                    }
                                  }}
                                  disabled={isActive || collections.length > 0 || effectiveRole !== 'owner'}
                                  className={cn(
                                    !(isActive || collections.length > 0 || effectiveRole !== 'owner') && 'text-destructive focus:text-destructive'
                                  )}
                                  onSelect={(e) => {
                                    if (isActive || collections.length > 0 || effectiveRole !== 'owner') {
                                      e.preventDefault();
                                    }
                                  }}
                                >
                                  <Trash2 className='h-4 w-4 mr-2' />
                                  {t('general.delete')}
                                  {isActive && (
                                    <span className='ml-auto text-[10px]'>Active</span>
                                  )}
                                  {!isActive && collections.length > 0 && (
                                    <span className='ml-auto text-[10px]'>{collections.length} KB</span>
                                  )}
                                </DropdownMenuItem>
                              </TooltipTrigger>
                              {(isActive || collections.length > 0 || effectiveRole !== 'owner') && (
                                <TooltipContent side='left' sideOffset={8}>
                                  <p className='text-xs'>
                                    {isActive
                                      ? t('workspace.cannotDeleteActive')
                                      : collections.length > 0
                                        ? t('workspace.cannotDeleteWithCollections', { count: collections.length })
                                        : t('workspace.cannotDeleteNotOwner')}
                                  </p>
                                </TooltipContent>
                              )}
                            </Tooltip>
                          </TooltipProvider>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>

                    {/* Collections Section */}
                    <div className='pt-4 border-t border-zinc-200 dark:border-zinc-800'>
                      <div className='flex items-center justify-between mb-3'>
                        <span className='text-xs font-medium text-zinc-500 dark:text-zinc-400 uppercase tracking-wider'>
                          {t('settings.workspaces.knowledgeBases')}
                        </span>
                        <span className={cn(
                          'text-xs font-semibold px-2 py-0.5',
                          collections.length > 0
                            ? getAccentBadgeClasses(accentColor)
                            : 'bg-zinc-100 dark:bg-zinc-800 text-zinc-500 dark:text-zinc-400'
                        )}>
                          {collections.length}
                        </span>
                      </div>

                      {collections.length > 0 ? (
                        <div className='flex flex-wrap gap-1.5'>
                          {(expandedCollections[workspace.id] ? collections : collections.slice(0, 4)).map(collection => (
                            <span
                              key={collection.id}
                              className='inline-flex items-center gap-1 px-2 py-1 text-xs bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-300 hover:bg-zinc-200 dark:hover:bg-zinc-700 transition-colors'
                            >
                              <FolderOpen className='h-3 w-3 shrink-0' />
                              <span className='max-w-[100px] truncate'>{collection.name}</span>
                            </span>
                          ))}
                          {collections.length > 4 && (
                            <button
                              onClick={() => setExpandedCollections(prev => ({ ...prev, [workspace.id]: !prev[workspace.id] }))}
                              className={cn('inline-flex items-center px-2 py-1 text-xs font-medium cursor-pointer hover:opacity-80 transition-opacity', getAccentBadgeClasses(accentColor))}
                            >
                              {expandedCollections[workspace.id] ? t('common.showLess', 'Show less') : `+${collections.length - 4}`}
                            </button>
                          )}
                        </div>
                      ) : (
                        <div className='flex items-center justify-center py-4 border border-dashed border-zinc-300 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-900/50'>
                          <p className='text-xs text-zinc-500 dark:text-zinc-400'>
                            No knowledge bases yet
                          </p>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Create Workspace Dialog */}
      <AlertDialog open={isCreatingWorkspace} onOpenChange={setIsCreatingWorkspace}>
        <AlertDialogContent className="max-w-md">
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <div className={cn('w-8 h-8 flex items-center justify-center', getAccentBgClasses(accentColor))}>
                <Plus className={cn('w-4 h-4', getAccentTextClasses(accentColor))} />
              </div>
              {t('workspace.createNewWorkspace')}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t('workspace.enterWorkspaceName')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="workspace-name">{t('workspace.name')}</Label>
              <Input
                id="workspace-name"
                data-testid="settings-workspace-name-input"
                value={workspaceName}
                onChange={(e) => setWorkspaceName(e.target.value)}
                placeholder={t('workspace.enterWorkspaceNamePlaceholder')}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    void handleCreateWorkspace();
                  }
                }}
                autoFocus
              />
            </div>
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => {
              setIsCreatingWorkspace(false);
              setWorkspaceName('');
            }}>
              {t('general.cancel')}
            </AlertDialogCancel>
            <AlertDialogAction data-testid="settings-workspace-create-submit" onClick={handleCreateWorkspace}>
              {t('workspace.createWorkspace')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Edit Workspace Dialog */}
      <AlertDialog open={isEditingWorkspace} onOpenChange={setIsEditingWorkspace}>
        <AlertDialogContent className="max-w-md">
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <div className="w-8 h-8 bg-blue-100 dark:bg-blue-950 flex items-center justify-center">
                <Edit3 className="w-4 h-4 text-blue-600 dark:text-blue-400" />
              </div>
              {t('workspace.renameWorkspace')}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t('workspace.enterNewWorkspaceName')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="edit-workspace-name">{t('workspace.name')}</Label>
              <Input
                id="edit-workspace-name"
                value={workspaceName}
                onChange={(e) => setWorkspaceName(e.target.value)}
                placeholder={t('workspace.enterWorkspaceNamePlaceholder')}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    void handleUpdateWorkspace();
                  }
                }}
                autoFocus
              />
            </div>
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => {
              setIsEditingWorkspace(false);
              setWorkspaceName('');
              setWorkspaceToEdit(null);
            }}>
              {t('general.cancel')}
            </AlertDialogCancel>
            <AlertDialogAction onClick={handleUpdateWorkspace}>
              {t('workspace.updateWorkspace')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Share Workspace Dialog */}
      <AlertDialog open={isShareDialogOpen} onOpenChange={setIsShareDialogOpen}>
        <AlertDialogContent className="max-w-lg">
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <div className="w-8 h-8 bg-emerald-100 dark:bg-emerald-950 flex items-center justify-center">
                <Share2 className="w-4 h-4 text-emerald-600 dark:text-emerald-400" />
              </div>
              {t('workspace.shareWorkspace')}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t('workspace.inviteSomeoneToCollaborate')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2 relative">
              <Label htmlFor="share-email">{t('workspace.emailAddress')}</Label>
              <div className="relative">
                <Input
                  id="share-email"
                  type="text"
                  value={searchQuery}
                  onChange={(e) => handleSearchQueryChange(e.target.value)}
                  onFocus={() => {
                    if (searchQuery.length >= 4 && searchResults.length > 0) {
                      setShowSearchResults(true);
                    }
                  }}
                  onBlur={() => {
                    setTimeout(() => setShowSearchResults(false), 200);
                  }}
                  placeholder="Type at least 4 characters to search..."
                  className="pr-10"
                />
                {isSearching && (
                  <div className="absolute right-3 top-1/2 -translate-y-1/2">
                    <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                  </div>
                )}
              </div>

              {/* Search results dropdown */}
              {showSearchResults && searchQuery.length >= 4 && (
                <div className="absolute z-50 w-full mt-1 bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 shadow-lg max-h-60 overflow-auto">
                  {searchResults.length > 0 ? (
                    <div className="py-1">
                      {searchResults.map((user) => (
                        <button
                          key={user.id}
                          type="button"
                          onClick={() => handleSelectUser(user)}
                          className="w-full px-3 py-2 text-left hover:bg-muted transition-colors"
                        >
                          <div className="flex items-center gap-2">
                            <div className="flex-1">
                              <p className="text-sm font-medium">{user.username}</p>
                              <p className="text-xs text-muted-foreground">{user.email}</p>
                            </div>
                            {selectedUser?.id === user.id && (
                              <Check className="h-4 w-4 text-primary" />
                            )}
                          </div>
                        </button>
                      ))}
                    </div>
                  ) : (
                    <div className="px-3 py-4 text-sm text-muted-foreground text-center">
                      {isSearching ? 'Searching...' : 'No users found'}
                    </div>
                  )}
                </div>
              )}

              {searchQuery.length > 0 && searchQuery.length < 4 && (
                <p className="text-xs text-muted-foreground mt-1">
                  Type {4 - searchQuery.length} more character{4 - searchQuery.length !== 1 ? 's' : ''} to search
                </p>
              )}

              {selectedUser && (
                <div className="mt-2 p-3 bg-emerald-50 dark:bg-emerald-950/30 border border-emerald-200 dark:border-emerald-800">
                  <div className="flex items-center gap-2">
                    <Check className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
                    <p className="text-sm text-emerald-800 dark:text-emerald-200">
                      Selected: <span className="font-medium">{selectedUser.username}</span>
                    </p>
                  </div>
                </div>
              )}
            </div>
            <div className="space-y-2">
              <Label htmlFor="share-role">{t('workspace.role')}</Label>
              <Select value={shareRole} onValueChange={setShareRole}>
                <SelectTrigger>
                  <SelectValue placeholder={t('workspace.selectRole')} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="viewer">
                    <div className="flex items-center gap-2">
                      <Eye className="h-4 w-4 text-emerald-500" />
                      {t('workspace.roles.viewer')}
                    </div>
                  </SelectItem>
                  <SelectItem value="editor">
                    <div className="flex items-center gap-2">
                      <Shield className="h-4 w-4 text-blue-500" />
                      {t('workspace.roles.editor')}
                    </div>
                  </SelectItem>
                  <SelectItem value="owner">
                    <div className="flex items-center gap-2">
                      <Crown className="h-4 w-4 text-amber-500" />
                      {t('workspace.roles.owner')}
                    </div>
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => {
              setIsShareDialogOpen(false);
              setShareEmail('');
              setShareRole('viewer');
              setWorkspaceToShare(null);
              setSearchQuery('');
              setSearchResults([]);
              setSelectedUser(null);
              setShowSearchResults(false);
            }}>
              {t('general.cancel')}
            </AlertDialogCancel>
            <AlertDialogAction onClick={handleShareWorkspace} disabled={!selectedUser}>
              {t('workspace.shareWorkspace')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* User Management Dialog */}
      <AlertDialog open={isUserManagementOpen} onOpenChange={setIsUserManagementOpen}>
        <AlertDialogContent className="max-w-2xl">
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <div className="w-8 h-8 bg-cyan-100 dark:bg-cyan-950 flex items-center justify-center">
                <Users className="w-4 h-4 text-cyan-600 dark:text-cyan-400" />
              </div>
              {t('workspace.manageUsers')}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t('workspace.manageUsersDescription')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="space-y-3 py-4 max-h-80 overflow-y-auto">
            {isLoadingUsers ? (
              <div className='flex items-center justify-center py-8'>
                <Loader2 className='h-6 w-6 animate-spin text-muted-foreground' />
                <span className='ml-2 text-sm text-muted-foreground'>
                  {t('workspace.loadingUsers')}
                </span>
              </div>
            ) : workspaceUsers.length === 0 ? (
              <div className='text-center py-8 text-muted-foreground'>
                {t('workspace.noUsersFound')}
              </div>
            ) : (
              <div className="space-y-2">
                {workspaceUsers.map(user => {
                  const role = permissionToRole(user.permission);
                  const displayName = user.username ?? user.email ?? '';
                  return (
                  <div key={user.user_id} className='flex items-center justify-between p-3 border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950'>
                    <div className='flex items-center gap-3'>
                      {getRoleIcon(role)}
                      <div>
                        <div className='font-medium text-sm'>{displayName}</div>
                        <div className='text-xs text-muted-foreground'>{user.email}</div>
                      </div>
                    </div>
                    <div className='flex items-center gap-2'>
                      {role !== 'owner' ? (
                        <>
                          <Select
                            value={role}
                            onValueChange={(newRole) => handleUpdateUserRole(user.user_id, newRole, displayName)}
                          >
                            <SelectTrigger className='w-24 h-8 text-xs'>
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="viewer">{t('workspace.roles.viewer')}</SelectItem>
                              <SelectItem value="editor">{t('workspace.roles.editor')}</SelectItem>
                            </SelectContent>
                          </Select>
                          <Button
                            variant='ghost'
                            size='icon'
                            onClick={() => handleRemoveUserAccess(user.user_id, displayName)}
                            className='h-8 w-8 text-destructive hover:text-destructive hover:bg-destructive/10'
                          >
                            <UserMinus className='h-4 w-4' />
                          </Button>
                        </>
                      ) : (
                        <span className='text-xs text-amber-700 dark:text-amber-300 px-2 py-1 bg-amber-100 dark:bg-amber-900/50'>
                          {getRoleDisplayName(role)}
                        </span>
                      )}
                    </div>
                  </div>
                  );
                })}
              </div>
            )}
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => {
              setIsUserManagementOpen(false);
              setWorkspaceForUserManagement(null);
              setWorkspaceUsers([]);
            }}>
              {t('general.close')}
            </AlertDialogCancel>
            <AlertDialogAction onClick={() => {
              setIsUserManagementOpen(false);
              setWorkspaceToShare(workspaceForUserManagement);
              setIsShareDialogOpen(true);
            }}>
              <Share2 className='h-4 w-4 mr-2' />
              {t('workspace.addUser')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Delete Confirmation Dialog */}
      <ConfirmDialog
        open={isDeleteConfirmationOpen}
        onOpenChange={setIsDeleteConfirmationOpen}
        title={t('workspace.deleteWorkspace')}
        description={t('workspace.deleteWorkspaceConfirmation')}
        confirmLabel={t('general.delete')}
        cancelLabel={t('general.cancel')}
        onConfirm={handleDeleteWorkspace}
        isDangerous
        confirmButtonTestId="settings-workspace-delete-confirm"
      />
    </div>
  );
};
