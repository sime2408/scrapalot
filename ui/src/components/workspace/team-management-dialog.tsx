import React from 'react';
import { useTranslation } from 'react-i18next';
import { useIsNarrowScreen } from '@/hooks/use-mobile';
import { cn } from '@/lib/utils';
import { useAsyncData } from '@/hooks/use-async-data';
import { DataContainer } from '@/components/ui/data-container';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu';
import {
  Users,
  Crown,
  Edit3,
  Eye,
  UserMinus,
  MoreHorizontal,
  UserPlus,
} from 'lucide-react';
import { PopoverAddTeammate } from './popover-add-teammate';
import { api } from '@/lib/api';

interface WorkspaceUser {
  id: string;
  email: string;
  role: string;
  name?: string;
  username?: string;
}

interface TeamManagementDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspace: {
    id: string;
    name: string;
  } | null;
}

export const TeamManagementDialog: React.FC<TeamManagementDialogProps> = ({
  open,
  onOpenChange,
  workspace,
}) => {
  const { t } = useTranslation();
  const isNarrowScreen = useIsNarrowScreen();

  const { data: workspaceUsers, loading, error, refetch } = useAsyncData<WorkspaceUser[]>(
    async () => {
      const response = await api.get(`/workspaces/${workspace!.id}`);
      return response.data.users || [];
    },
    { deps: [open, workspace?.id], skip: !open || !workspace }
  );

  const handleTeammateAdded = async () => {
    refetch();
  };

  if (!workspace) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        data-testid="workspace-team-dialog"
        className={cn(
          'flex flex-col p-0 border-zinc-300 dark:border-zinc-800 bg-white dark:bg-black overflow-visible',
          isNarrowScreen
            ? 'w-full h-full max-w-none max-h-none rounded-none' // Full screen on mobile
            : 'w-[800px] max-w-[90vw] h-[600px] max-h-[85vh] rounded-lg' // Modal on desktop
        )}
        style={isNarrowScreen ? {
          position: 'fixed',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          width: '100vw',
          height: '100vh',
          maxWidth: 'none',
          maxHeight: 'none',
          margin: 0,
          transform: 'none',
          borderRadius: 0,
        } : undefined}
        hideCloseButton={isNarrowScreen}
        forceMobileBackButton={isNarrowScreen}
        dialogOpen={open}
        onOpenChange={onOpenChange}
        disableBackdropClose={true}
      >
        <DialogHeader className='p-6 pb-4 border-b border-zinc-200 dark:border-zinc-800'>
          <DialogTitle className='flex items-center gap-3'>
            <div className='w-10 h-10 bg-blue-100 dark:bg-blue-950 flex items-center justify-center rounded-lg'>
              <Users className='w-5 h-5 text-blue-600 dark:text-blue-400' />
            </div>
            <div>
              <div className='text-lg font-semibold text-zinc-900 dark:text-white'>
                {t('workspace.teamCollaboration')}
              </div>
              <div className='text-sm text-zinc-600 dark:text-zinc-400 font-normal'>
                {workspace.name} • {workspaceUsers?.length || 0} {t('workspace.teamMembers')}
              </div>
            </div>
          </DialogTitle>
        </DialogHeader>

        <div className='flex flex-col gap-4 overflow-hidden p-6'>
          {/* Add Teammate Section */}
          <div data-testid="workspace-team-invite-section" className='flex items-center justify-between p-4 bg-zinc-50 dark:bg-zinc-900/50 rounded-lg border border-zinc-200 dark:border-zinc-800'>
            <div className='flex items-center gap-3'>
              <div className='w-8 h-8 bg-green-100 dark:bg-green-950 flex items-center justify-center rounded-lg'>
                <UserPlus className='w-4 h-4 text-green-600 dark:text-green-400' />
              </div>
              <div>
                <div className='text-sm font-medium text-zinc-900 dark:text-white'>
                  {t('workspace.inviteNewMember')}
                </div>
                <div className='text-xs text-zinc-600 dark:text-zinc-400'>
                  {t('workspace.sendInvitationToCollaborate')}
                </div>
              </div>
            </div>
            <PopoverAddTeammate
              workspaceId={workspace.id}
              onTeammateAdded={handleTeammateAdded}
            />
          </div>

          {/* Team Members List */}
          <div data-testid="workspace-team-members-list" className='flex-1 overflow-y-auto'>
            <DataContainer
              loading={loading}
              error={error}
              empty={!workspaceUsers?.length}
              emptyMessage={t('workspace.noTeamMembersYet', 'No team members yet')}
            >
              <div className='space-y-3'>
                {workspaceUsers?.map(user => (
                  <div
                    key={user.id}
                    data-testid={`workspace-team-member-${user.id}`}
                    className='flex items-center justify-between p-4 bg-white dark:bg-zinc-900/30 rounded-lg border border-zinc-200 dark:border-zinc-800'
                  >
                    <div className='flex items-center gap-3'>
                      <div className='w-10 h-10 bg-zinc-200 dark:bg-zinc-800 rounded-full flex items-center justify-center'>
                        <Users className='h-5 w-5 text-zinc-600 dark:text-zinc-400' />
                      </div>
                      <div>
                        <div className='font-medium text-sm text-zinc-900 dark:text-white'>
                          {user.username || user.name || 'Unknown User'}
                        </div>
                        <div className='text-xs text-zinc-500'>{user.email}</div>
                      </div>
                    </div>
                    <div className='flex items-center gap-3'>
                      <Badge variant='outline' className='text-xs capitalize'>
                        {user.role}
                      </Badge>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant='ghost' size='icon' className='h-8 w-8' data-testid={`workspace-team-member-menu-${user.id}`}>
                            <MoreHorizontal className='h-4 w-4' />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align='end'>
                          <DropdownMenuItem data-testid="workspace-team-role-owner">
                            <Crown className='h-4 w-4 mr-2' />
                            Make Owner
                          </DropdownMenuItem>
                          <DropdownMenuItem data-testid="workspace-team-role-editor">
                            <Edit3 className='h-4 w-4 mr-2' />
                            Make Editor
                          </DropdownMenuItem>
                          <DropdownMenuItem data-testid="workspace-team-role-viewer">
                            <Eye className='h-4 w-4 mr-2' />
                            Make Viewer
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem data-testid="workspace-team-remove-member" className='text-red-500'>
                            <UserMinus className='h-4 w-4 mr-2' />
                            Remove Member
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                  </div>
                ))}
              </div>
            </DataContainer>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
};
