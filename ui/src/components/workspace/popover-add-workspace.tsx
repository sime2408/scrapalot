import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Plus, Loader2 } from 'lucide-react';
import { toast } from '@/lib/toast-compat';
import { api } from '@/lib/api';

interface PopoverAddWorkspaceProps {
  onWorkspaceAdded?: () => void;
  trigger?: React.ReactNode;
}

export const PopoverAddWorkspace: React.FC<PopoverAddWorkspaceProps> = ({
  onWorkspaceAdded,
  trigger
}) => {
  const { t } = useTranslation();
  const [isOpen, setIsOpen] = useState(false);
  const [workspaceName, setWorkspaceName] = useState('');
  const [isLoading, setIsLoading] = useState(false);

  const handleCreateWorkspace = async () => {
    if (!workspaceName.trim()) return;

    setIsLoading(true);
    try {
      await api.post('/workspaces', { name: workspaceName.trim() });
      
      toast.success(t('toast.workspace.created', { name: workspaceName }));
      setWorkspaceName('');
      setIsOpen(false);
      onWorkspaceAdded?.();
    } catch (error) {
      console.error('Failed to create workspace:', error);
      toast.error(t('general.errors.createFailed') + ' workspace');
    } finally {
      setIsLoading(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !isLoading && workspaceName.trim()) {
      e.preventDefault();
      void handleCreateWorkspace();
    }
  };

  const handleOpenChange = (open: boolean) => {
    setIsOpen(open);
    if (!open) {
      setWorkspaceName('');
      setIsLoading(false);
    }
  };

  const defaultTrigger = (
    <Button
      className='h-9 w-9 bg-background/95 backdrop-blur-sm border-muted/50 hover:bg-background/80 relative'
      variant='outline'
      size='icon'
      data-testid="workspace-add-trigger"
    >
      <Plus className='h-4 w-4 opacity-70' />
      <span className='sr-only'>Add Workspace</span>
    </Button>
  );

  return (
    <Popover open={isOpen} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        {trigger || defaultTrigger}
      </PopoverTrigger>
      <PopoverContent className='w-80 p-0' align='start'>
        <div data-testid="workspace-add-popover" className='flex flex-col border border-border bg-popover text-popover-foreground'>
          {/* Header */}
          <div className='flex items-center gap-3 p-4 border-b border-border bg-muted/30'>
            <div className='w-8 h-8 bg-primary/10 text-primary flex items-center justify-center rounded-md'>
              <Plus className='w-4 h-4' />
            </div>
            <div>
              <h4 className='text-sm font-semibold text-foreground'>
                {t('workspace.createNewWorkspace')}
              </h4>
              <p className='text-xs text-muted-foreground mt-0.5'>
                {t('workspace.organizeProjectsCollaborate')}
              </p>
            </div>
          </div>

          {/* Content */}
          <div className='p-4 space-y-4'>
            <div className='space-y-2'>
              <label className='text-sm font-medium text-foreground'>
                {t('workspace.name')}
              </label>
              <Input
                placeholder={t('workspace.enterWorkspaceNamePlaceholder')}
                value={workspaceName}
                onChange={(e) => setWorkspaceName(e.target.value)}
                onKeyDown={handleKeyDown}
                disabled={isLoading}
                autoFocus
                className='h-9'
                data-testid="workspace-name-input"
              />
            </div>

            <div className='flex gap-2 pt-2'>
              <Button
                onClick={handleCreateWorkspace}
                disabled={isLoading || !workspaceName.trim()}
                className='h-9 text-sm flex-1'
                data-testid="workspace-create-button"
              >
                {isLoading ? (
                  <Loader2 className='h-4 w-4 animate-spin mr-2' />
                ) : (
                  <Plus className='h-4 w-4 mr-2' />
                )}
                {t('workspace.createWorkspace')}
              </Button>
              <Button
                variant='outline'
                onClick={() => handleOpenChange(false)}
                disabled={isLoading}
                className='h-9 text-sm px-4'
                data-testid="workspace-cancel-button"
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
