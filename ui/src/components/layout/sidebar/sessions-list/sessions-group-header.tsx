import React, { useCallback, useState } from 'react';
import {
  ChevronDown,
  ChevronRight,
  Edit3,
  Folder,
  MessageSquare,
  MoreHorizontal,
  Plus,
  Trash2,
} from 'lucide-react';
import { SESSION_DRAG_MIME } from './session-item';
import { CollapsibleTrigger } from '@/components/ui/collapsible.tsx';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu.tsx';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog.tsx';
import { Input } from '@/components/ui/input.tsx';
import { Label } from '@/components/ui/label.tsx';
import { Button } from '@/components/ui/button.tsx';
import { useIsMobilePhone } from '@/hooks/use-mobile';
import { cn } from '@/lib/utils';
import { useTranslation } from 'react-i18next';
import type { SessionFolder } from '@/lib/api-session-folders';
import { AnimatedTitle } from '@/components/ui/animated-title';

interface SessionsGroupHeaderProps {
  expanded: boolean;
  setExpanded: (expanded: boolean) => void;
  folder: SessionFolder | null; // null = "Unfiled" group
  sessionCount: number;
  onNewSession: () => void;
  onRenameFolder: (name: string) => void;
  onDeleteFolder: () => void;
  onDropSession?: (sessionId: string) => void;
}

export const SessionsGroupHeader = ({
  expanded,
  setExpanded: _setExpanded,
  folder,
  sessionCount,
  onNewSession,
  onRenameFolder,
  onDeleteFolder,
  onDropSession,
}: SessionsGroupHeaderProps) => {
  const { t } = useTranslation();
  const [isHovering, setIsHovering] = useState(false);
  const [isEditDialogOpen, setIsEditDialogOpen] = useState(false);
  const [isDeleteConfirmOpen, setIsDeleteConfirmOpen] = useState(false);
  const [editName, setEditName] = useState('');
  const [isDragOver, setIsDragOver] = useState(false);
  const isMobilePhone = useIsMobilePhone();

  const handleDragOver = useCallback((e: React.DragEvent) => {
    if (e.dataTransfer.types.includes(SESSION_DRAG_MIME)) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
    }
  }, []);

  const handleDragEnter = useCallback((e: React.DragEvent) => {
    if (e.dataTransfer.types.includes(SESSION_DRAG_MIME)) {
      e.preventDefault();
      setIsDragOver(true);
    }
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    const relatedTarget = e.relatedTarget as Node | null;
    if (relatedTarget && (e.currentTarget as HTMLElement).contains(relatedTarget)) return;
    setIsDragOver(false);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
    const sessionId = e.dataTransfer.getData(SESSION_DRAG_MIME);
    if (sessionId && onDropSession) {
      onDropSession(sessionId);
    }
  }, [onDropSession]);

  const displayName = folder ? folder.name : t('sessionFolders.unfiled');
  const isUnfiled = folder === null;

  const handleEditFolder = () => {
    setEditName(folder?.name || '');
    setIsEditDialogOpen(true);
  };

  const handleUpdateFolder = () => {
    if (editName.trim() && folder) {
      onRenameFolder(editName.trim());
    }
    setIsEditDialogOpen(false);
  };

  const handleDeleteFolder = () => {
    setIsDeleteConfirmOpen(false);
    onDeleteFolder();
  };

  return (
    <>
      <div
        data-testid={folder ? `sidebar-folder-header-${folder.id}` : 'sidebar-unfiled-header'}
        className={cn(
          'flex items-center justify-between group transition-colors duration-200',
          'hover:bg-zinc-50/80 dark:hover:bg-zinc-800/40',
          'border-l-2 border-transparent hover:border-blue-500/20 dark:hover:border-blue-400/20',
          isMobilePhone ? 'px-3 py-2.5' : 'px-4 py-2',
          isDragOver && 'bg-primary/10 border-l-2 border-primary ring-1 ring-inset ring-primary/30'
        )}
        onMouseEnter={() => setIsHovering(true)}
        onMouseLeave={() => setIsHovering(false)}
        onDragOver={handleDragOver}
        onDragEnter={handleDragEnter}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        <CollapsibleTrigger asChild>
          <div className={cn(
            'flex items-center cursor-pointer flex-1 transition-colors duration-200',
            'text-zinc-600 hover:text-zinc-900 dark:text-zinc-300 dark:hover:text-white',
            isMobilePhone && 'min-w-0'
          )}>
            <div className={cn(
              'p-1.5 bg-zinc-100 dark:bg-zinc-800/60 transition-colors duration-200 mr-3',
              'group-hover:bg-blue-100 dark:group-hover:bg-blue-900/30',
              'group-hover:text-blue-600 dark:group-hover:text-blue-400'
            )}>
              {isUnfiled ? (
                <MessageSquare className={cn(
                  'transition-colors duration-200',
                  isMobilePhone ? 'h-3.5 w-3.5' : 'h-4 w-4'
                )} />
              ) : (
                <Folder className={cn(
                  'transition-colors duration-200',
                  isMobilePhone ? 'h-3.5 w-3.5' : 'h-4 w-4'
                )} />
              )}
            </div>
            <AnimatedTitle
              title={displayName}
              className={cn('font-medium text-left', isMobilePhone ? 'text-sm' : 'text-sm')}
              animationDuration={5000}
            />
          </div>
        </CollapsibleTrigger>

        <div className='flex items-center gap-1'>
          {sessionCount > 0 && (isHovering || isMobilePhone) && (
            <div className={cn(
              'bg-zinc-200/80 dark:bg-zinc-700/80 backdrop-blur-sm px-2 py-0.5 transition-all duration-200',
              'text-zinc-600 dark:text-zinc-300 border border-zinc-300/50 dark:border-zinc-600/50',
              'text-xs'
            )}>
              {sessionCount}
            </div>
          )}

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                data-testid={folder ? `sidebar-folder-menu-trigger-${folder.id}` : 'sidebar-unfiled-menu-trigger'}
                className={cn(
                  'flex items-center justify-center transition-all duration-200',
                  'text-zinc-400 hover:text-zinc-600 dark:text-zinc-500 dark:hover:text-zinc-300',
                  'hover:bg-zinc-200/60 dark:hover:bg-zinc-700/60',
                  'group-hover:opacity-100',
                  isMobilePhone ? 'w-8 h-8 opacity-100' : 'w-6 h-6',
                  !isHovering && !isMobilePhone ? 'opacity-0' : 'opacity-100'
                )}
              >
                <MoreHorizontal className='h-4 w-4' />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align='end'
              className={cn(
                'bg-card/95 dark:bg-zinc-900/95 backdrop-blur-sm',
                'border-border dark:border-zinc-700',
                'shadow-md dark:shadow-zinc-900/20',
                isMobilePhone && 'w-56'
              )}
            >
              <DropdownMenuItem
                data-testid={folder ? `sidebar-folder-new-session-${folder.id}` : 'sidebar-unfiled-new-session'}
                className={cn(
                  'flex items-center gap-3 cursor-pointer transition-colors duration-200',
                  'text-zinc-700 dark:text-zinc-300',
                  'hover:bg-blue-50 dark:hover:bg-blue-900/20',
                  'hover:text-blue-700 dark:hover:text-blue-300',
                  isMobilePhone ? 'py-3 px-4' : 'py-2 px-3'
                )}
                onClick={onNewSession}
              >
                <div className='p-1 bg-blue-100 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400'>
                  <Plus className='h-3.5 w-3.5' />
                </div>
                <span className={isMobilePhone ? 'text-base font-medium' : 'text-sm'}>
                  {t('sidebar.newConversation')}
                </span>
              </DropdownMenuItem>

              {!isUnfiled && (
                <>
                  <DropdownMenuSeparator className='bg-zinc-200 dark:bg-zinc-700' />
                  <DropdownMenuItem
                    data-testid={`sidebar-folder-edit-${folder?.id}`}
                    className={cn(
                      'flex items-center gap-3 cursor-pointer transition-colors duration-200',
                      'text-zinc-700 dark:text-zinc-300',
                      'hover:bg-amber-50 dark:hover:bg-amber-900/20',
                      'hover:text-amber-700 dark:hover:text-amber-300',
                      isMobilePhone ? 'py-3 px-4' : 'py-2 px-3'
                    )}
                    onClick={handleEditFolder}
                  >
                    <div className='p-1 bg-amber-100 dark:bg-amber-900/30 text-amber-600 dark:text-amber-400'>
                      <Edit3 className='h-3.5 w-3.5' />
                    </div>
                    <span className={isMobilePhone ? 'text-base font-medium' : 'text-sm'}>
                      {t('sessionFolders.editFolder')}
                    </span>
                  </DropdownMenuItem>

                  <DropdownMenuSeparator className='bg-zinc-200 dark:bg-zinc-700' />
                  <DropdownMenuItem
                    data-testid={`sidebar-folder-delete-${folder?.id}`}
                    className={cn(
                      'flex items-center gap-3 cursor-pointer transition-colors duration-200',
                      'text-red-600 dark:text-red-400',
                      'hover:bg-red-50 dark:hover:bg-red-900/20',
                      'hover:text-red-700 dark:hover:text-red-300',
                      isMobilePhone ? 'py-3 px-4' : 'py-2 px-3'
                    )}
                    onClick={() => setIsDeleteConfirmOpen(true)}
                  >
                    <div className='p-1 bg-red-100 dark:bg-red-900/30 text-red-600 dark:text-red-400'>
                      <Trash2 className='h-3.5 w-3.5' />
                    </div>
                    <span className={isMobilePhone ? 'text-base font-medium' : 'text-sm'}>
                      {t('sessionFolders.deleteFolder')}
                    </span>
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>

          <CollapsibleTrigger asChild>
            <button data-testid={folder ? `sidebar-folder-toggle-${folder.id}` : 'sidebar-unfiled-toggle'} className={cn(
              'flex items-center justify-center transition-all duration-200',
              'text-zinc-400 hover:text-zinc-600 dark:text-zinc-500 dark:hover:text-zinc-300',
              'hover:bg-zinc-200/60 dark:hover:bg-zinc-700/60',
              isMobilePhone ? 'w-8 h-8' : 'w-6 h-6'
            )}>
              {expanded ? (
                <ChevronDown className='h-4 w-4' />
              ) : (
                <ChevronRight className='h-4 w-4' />
              )}
            </button>
          </CollapsibleTrigger>
        </div>
      </div>

      {/* Edit Folder Dialog */}
      {!isUnfiled && (
        <Dialog open={isEditDialogOpen} onOpenChange={setIsEditDialogOpen}>
          <DialogContent dialogOpen={isEditDialogOpen} onOpenChange={setIsEditDialogOpen} data-testid="sidebar-folder-edit-dialog">
            <DialogHeader>
              <div className='flex items-center gap-3'>
                <div className='p-2 bg-primary/10 text-primary'>
                  <Edit3 className='h-5 w-5' />
                </div>
                <div>
                  <DialogTitle>{t('sessionFolders.editFolder')}</DialogTitle>
                  <DialogDescription>{t('sessionFolders.editFolderDescription')}</DialogDescription>
                </div>
              </div>
            </DialogHeader>
            <div className='py-4'>
              <Label htmlFor='edit-folder-name' className='text-sm font-medium mb-2 block'>
                {t('sessionFolders.folderName')}
              </Label>
              <Input
                id='edit-folder-name'
                data-testid="sidebar-folder-edit-name-input"
                value={editName}
                onChange={e => setEditName(e.target.value)}
                placeholder={t('sessionFolders.folderName')}
                onKeyDown={e => { if (e.key === 'Enter') handleUpdateFolder(); }}
                autoFocus
              />
            </div>
            <DialogFooter>
              <Button variant='outline' onClick={() => setIsEditDialogOpen(false)} data-testid="sidebar-folder-edit-cancel">
                {t('general.cancel')}
              </Button>
              <Button onClick={handleUpdateFolder} disabled={!editName.trim()} data-testid="sidebar-folder-edit-submit">
                {t('sessionFolders.update')}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}

      {/* Delete Folder Confirmation */}
      {!isUnfiled && (
        <Dialog open={isDeleteConfirmOpen} onOpenChange={setIsDeleteConfirmOpen}>
          <DialogContent dialogOpen={isDeleteConfirmOpen} onOpenChange={setIsDeleteConfirmOpen} data-testid="sidebar-folder-delete-dialog">
            <DialogHeader>
              <div className='flex items-center gap-3'>
                <div className='p-2 bg-destructive/10 text-destructive'>
                  <Trash2 className='h-5 w-5' />
                </div>
                <div>
                  <DialogTitle>{t('sessionFolders.deleteFolder')}</DialogTitle>
                  <DialogDescription>{t('sessionFolders.deleteFolderDescription')}</DialogDescription>
                </div>
              </div>
            </DialogHeader>
            <div className='py-4'>
              <div className='border border-destructive/20 bg-destructive/5 p-3'>
                <p className='text-sm text-zinc-700 dark:text-zinc-300'>
                  {t('sessionFolders.deleteConfirm', { name: folder?.name })}
                </p>
              </div>
            </div>
            <DialogFooter>
              <Button variant='outline' onClick={() => setIsDeleteConfirmOpen(false)} data-testid="sidebar-folder-delete-cancel">
                {t('general.cancel')}
              </Button>
              <Button variant='destructive' onClick={handleDeleteFolder} data-testid="sidebar-folder-delete-confirm">
                {t('sessionFolders.delete')}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </>
  );
};
