import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Loader2, UserPlus } from 'lucide-react';
import { toast } from '@/lib/toast-compat';
import { api } from '@/lib/api';

interface PopoverAddTeammateProps {
  workspaceId: string;
  onTeammateAdded?: () => void;
  trigger?: React.ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

export const PopoverAddTeammate: React.FC<PopoverAddTeammateProps> = ({
  workspaceId,
  onTeammateAdded,
  trigger,
  open,
  onOpenChange
}) => {
  const { t } = useTranslation();
  const [isOpen, setIsOpen] = useState(false);
  const [email, setEmail] = useState('');
  const [isLoading, setIsLoading] = useState(false);

  const handleAddTeammate = async () => {
    if (!email.trim()) return;

    setIsLoading(true);
    try {
      await api.post(`/workspaces/${workspaceId}/users`, {
        email: email.trim(),
        role: 'editor'
      });

      toast.success(t('toast.workspace.teammateInvited', { email }));
      setEmail('');
      setIsOpen(false);
      onTeammateAdded?.();
    } catch (error) {
      console.error('Failed to add teammate:', error);
      toast.error(t('general.errors.failed') + ' to send invitation');
    } finally {
      setIsLoading(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !isLoading && email.trim()) {
      e.preventDefault();
      handleAddTeammate();
    }
  };

  const handleOpenChange = (openState: boolean) => {
    // If controlled (open prop is provided) and trying to close, ignore it
    // The popover will only close when parent explicitly sets open={false}
    if (open !== undefined && !openState) {
      return; // Don't call onOpenChange, don't update state, just ignore
    }

    // For opening or uncontrolled mode, proceed normally
    if (onOpenChange) {
      onOpenChange(openState);
    } else {
      setIsOpen(openState);
    }

    if (!openState) {
      setEmail('');
      setIsLoading(false);
    }
  };

  // Use controlled open state if provided, otherwise use internal state
  const popoverOpen = open !== undefined ? open : isOpen;

  const defaultTrigger = (
    <Button
      className='h-9 w-9 bg-background/95 backdrop-blur-sm border-muted/50 hover:bg-background/80 relative'
      variant='outline'
      size='icon'
      data-testid="workspace-add-teammate-trigger"
    >
      <UserPlus className='h-4 w-4 opacity-70' />
      <span className='sr-only'>Add Teammate</span>
    </Button>
  );

  return (
    <Popover open={popoverOpen} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        {trigger || defaultTrigger}
      </PopoverTrigger>
      <PopoverContent className='w-80 p-0' align='start'>
        <div data-testid="workspace-add-teammate-popover" className='flex flex-col border border-border bg-popover text-popover-foreground'>
          {/* Header */}
          <div className='flex items-center gap-3 p-4 border-b border-border bg-muted/30'>
            <div className='w-8 h-8 bg-primary/10 text-primary flex items-center justify-center rounded-md'>
              <UserPlus className='w-4 h-4' />
            </div>
            <div>
              <h4 className='text-sm font-semibold text-foreground'>
                {t('workspace.inviteTeamMember')}
              </h4>
              <p className='text-xs text-muted-foreground mt-0.5'>
                {t('workspace.sendInvitationToCollaborate')}
              </p>
            </div>
          </div>

          {/* Content */}
          <div className='p-4 space-y-4'>
            <div className='space-y-2'>
              <label className='text-sm font-medium text-foreground'>
                {t('workspace.emailAddress')}
              </label>
              <Input
                placeholder={t('workspace.enterEmailPlaceholder')}
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                onKeyDown={handleKeyDown}
                disabled={isLoading}
                autoFocus
                className='h-9'
                data-testid="workspace-teammate-email-input"
              />
            </div>

            <div className='flex gap-2 pt-2'>
              <Button
                onClick={handleAddTeammate}
                disabled={isLoading || !email.trim()}
                className='h-9 text-sm flex-1'
                data-testid="workspace-teammate-send-button"
              >
                {isLoading ? (
                  <Loader2 className='h-4 w-4 animate-spin mr-2' />
                ) : (
                  <UserPlus className='h-4 w-4 mr-2' />
                )}
                {t('workspace.sendInvitation')}
              </Button>
              <Button
                variant='outline'
                onClick={() => {
                  // Explicitly notify parent to close
                  if (onOpenChange) {
                    onOpenChange(false);
                  } else {
                    setIsOpen(false);
                  }
                  setEmail('');
                  setIsLoading(false);
                }}
                disabled={isLoading}
                className='h-9 text-sm px-4'
                data-testid="workspace-teammate-cancel-button"
              >
                {t('general.cancel')}
              </Button>
            </div>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
};
