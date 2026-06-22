import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FolderPlus, Pencil } from 'lucide-react';
import { Collapsible, CollapsibleContent } from '@/components/ui/collapsible';
import { SessionsList } from './sessions-list';
import { SessionsGroupHeader } from './sessions-group-header';
import { SidebarRecentDocuments } from './sidebar-recent-documents';
import { SESSION_DRAG_MIME } from './session-item';
import { useNavigate } from 'react-router-dom';
import type { Session } from '@/types';
import {
  listSessionFolders,
  createSessionFolder,
  updateSessionFolder,
  deleteSessionFolder,
  moveSessionToFolder,
  type SessionFolder,
} from '@/lib/api-session-folders';
import { listSessions } from '@/lib/api-sessions';
import { toast } from '@/lib/toast-compat';
import { userPrefs } from '@/lib/storage-utils';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/hooks/use-auth';
import { AnimatedTitle } from '@/components/ui/animated-title';

interface SessionsAreaProps {
  miscGroupExpanded: boolean;
  setMiscGroupExpanded: (expanded: boolean) => void;
  shortcutsExpanded: boolean;
  setShortcutsExpanded: (expanded: boolean) => void;
  selectedSessionId: string | null;
  onSelectSession: (session: Session) => void;
  onNewSession: () => void;
  refreshSessions?: (forceRefresh?: boolean) => Promise<void>;
  mobileMenuOpen?: boolean;
  onCloseMobileMenu?: () => void;
  refreshTrigger?: number;
}

export const SessionsArea = ({
  miscGroupExpanded,
  setMiscGroupExpanded,
  shortcutsExpanded: _shortcutsExpanded,
  setShortcutsExpanded: _setShortcutsExpanded,
  selectedSessionId,
  onSelectSession,
  onNewSession,
  refreshSessions,
  mobileMenuOpen,
  onCloseMobileMenu,
  refreshTrigger,
}: SessionsAreaProps) => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { isAuthenticated } = useAuth();

  const [folders, setFolders] = useState<SessionFolder[]>([]);
  const [folderExpandState, setFolderExpandState] = useState<Record<string, boolean>>({});
  const [createFolderOpen, setCreateFolderOpen] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const [allSessions, setAllSessions] = useState<Session[]>([]);
  const [sessionFolderUpdate, setSessionFolderUpdate] = useState<{ sessionId: string; folderId: string | null; _ts: number } | null>(null);

  // Pagination coordination: primary list exposes loadMore; per-folder buttons call it
  const loadMoreRef = useRef<(() => void) | null>(null);
  const [primaryHasMore, setPrimaryHasMore] = useState(true);
  const [totalSessions, setTotalSessions] = useState(0);

  // Load folders
  const loadFolders = useCallback(async () => {
    if (!isAuthenticated) return;
    try {
      const data = await listSessionFolders();
      setFolders(data);
    } catch (err) {
      console.error('Failed to load session folders:', err);
    }
  }, [isAuthenticated]);

  useEffect(() => {
    void loadFolders();
  }, [loadFolders, refreshTrigger]);

  // Load folder sessions directly from backend (primary list's pagination may not reach them)
  useEffect(() => {
    if (folders.length === 0 || !isAuthenticated) return;
    let cancelled = false;
    const loadFolderSessions = async () => {
      for (const folder of folders) {
        try {
          const response = await listSessions(1, 100, false, folder.id);
          if (cancelled) return;
          const prepared = (response.sessions || []).map(s => ({
            ...s,
            title: s.conversation_name || 'Untitled',
            createdAt: new Date(s.created_at),
            updatedAt: new Date(s.updated_at),
            modelId: s.model_name || '',
            messages: s.messages || [],
          }));
          setAllSessions(prev => {
            const existingIds = new Set(prev.map(s => s.id));
            const newSessions = prepared.filter(s => !existingIds.has(s.id));
            if (newSessions.length === 0) return prev;
            return [...prev, ...newSessions];
          });
        } catch (err) {
          console.error(`Failed to load sessions for folder ${folder.id}:`, err);
        }
      }
    };
    void loadFolderSessions();
    return () => { cancelled = true; };
  }, [folders, isAuthenticated]);

  // Stable callbacks passed to primary SessionsList for pagination coordination
  const handleLoadMoreReady = useCallback((fn: () => void) => {
    loadMoreRef.current = fn;
  }, []);

  const handleHasMoreChange = useCallback((hasMore: boolean) => {
    setPrimaryHasMore(hasMore);
  }, []);

  const handleTotalChange = useCallback((total: number) => {
    setTotalSessions(total);
  }, []);

  // Stable callback passed to each folder's SessionsList to request more data
  const handleRequestLoad = useCallback(() => {
    loadMoreRef.current?.();
  }, []);


  // Load expand state from localStorage
  useEffect(() => {
    try {
      const prefs = userPrefs.get();
      if (prefs?.folderExpandState) {
        setFolderExpandState(prefs.folderExpandState);
      }
    } catch {
      // ignore
    }
  }, []);

  // Save expand state
  const setFolderExpanded = useCallback((folderId: string, expanded: boolean) => {
    setFolderExpandState(prev => {
      const next = { ...prev, [folderId]: expanded };
      try {
        userPrefs.set({ folderExpandState: next });
      } catch {
        // ignore
      }
      return next;
    });
  }, []);

  // Group sessions by folder (client-side filtering for rendering)
  const unfiledSessions = useMemo(
    () => allSessions.filter(s => !s.session_folder_id),
    [allSessions]
  );

  const sessionsByFolder = useMemo(() => {
    const map: Record<string, Session[]> = {};
    for (const folder of folders) {
      map[folder.id] = allSessions.filter(s => s.session_folder_id === folder.id);
    }
    return map;
  }, [allSessions, folders]);

  // Use backend counts for accurate display (not limited by loaded page size)
  const folderSessionTotal = useMemo(
    () => folders.reduce((sum, f) => sum + (f.session_count || 0), 0),
    [folders]
  );
  const unfiledCount = totalSessions > 0 ? totalSessions - folderSessionTotal : unfiledSessions.length;

  // Create folder
  const handleCreateFolder = async () => {
    if (!newFolderName.trim()) return;
    try {
      await createSessionFolder(newFolderName.trim());
      setCreateFolderOpen(false);
      setNewFolderName('');
      await loadFolders();
      toast({
        title: t('general.success'),
        description: t('sessionFolders.created'),
      });
    } catch (err: unknown) {
      const axiosErr = err as { response?: { data?: { message?: string } } };
      toast({
        title: t('general.error'),
        description: axiosErr?.response?.data?.message || t('sessionFolders.createError'),
        variant: 'destructive',
      });
    }
  };

  // Rename folder
  const handleRenameFolder = async (folderId: string, newName: string) => {
    try {
      await updateSessionFolder(folderId, { name: newName });
      await loadFolders();
      toast({
        title: t('general.success'),
        description: t('sessionFolders.updated'),
      });
    } catch (err: unknown) {
      const axiosErr = err as { response?: { data?: { message?: string } } };
      toast({
        title: t('general.error'),
        description: axiosErr?.response?.data?.message || t('sessionFolders.updateError'),
        variant: 'destructive',
      });
    }
  };

  // Delete folder
  const handleDeleteFolder = async (folderId: string) => {
    try {
      await deleteSessionFolder(folderId);
      await loadFolders();
      // Refresh sessions so moved sessions show up in unfiled
      if (refreshSessions) await refreshSessions(true);
      toast({
        title: t('general.success'),
        description: t('sessionFolders.deleted'),
      });
    } catch (err: unknown) {
      const axiosErr = err as { response?: { data?: { message?: string } } };
      toast({
        title: t('general.error'),
        description: axiosErr?.response?.data?.message || t('sessionFolders.deleteError'),
        variant: 'destructive',
      });
    }
  };

  // Move session to folder (also used by drag-and-drop)
  // eslint-disable-next-line react-hooks/exhaustive-deps -- deps are intentionally limited
  const handleMoveSession = async (sessionId: string, targetFolderId: string | null) => {
    // Same-folder no-op guard
    const currentSession = allSessions.find(s => s.id === sessionId);
    if (currentSession) {
      const currentFolder = currentSession.session_folder_id ?? null;
      if (currentFolder === targetFolderId) return;
    }
    try {
      await moveSessionToFolder(sessionId, targetFolderId);
      // Update local state immediately
      setAllSessions(prev =>
        prev.map(s => s.id === sessionId ? { ...s, session_folder_id: targetFolderId } : s)
      );
      // Notify primary list to update its internal sessions state
      setSessionFolderUpdate({ sessionId, folderId: targetFolderId, _ts: Date.now() });
      await loadFolders(); // refresh counts
      toast({
        title: t('general.success'),
        description: t('sessionFolders.sessionMoved'),
      });
    } catch (err: unknown) {
      const axiosErr = err as { response?: { data?: { message?: string } } };
      toast({
        title: t('general.error'),
        description: axiosErr?.response?.data?.message || t('sessionFolders.moveError'),
        variant: 'destructive',
      });
    }
  };

  // Reflect a pin toggle in the shared session list so folder (secondary) lists,
  // which render from allSessions, float/sink the pinned row immediately.
  const handleSessionPinned = useCallback((sessionId: string, pinned: boolean) => {
    setAllSessions(prev => prev.map(s => (s.id === sessionId ? { ...s, is_pinned: pinned } : s)));
  }, []);

  // Build drop-zone props for a folder wrapper (header + session list area)
  const folderDropProps = useCallback((targetFolderId: string | null) => ({
    onDragOver: (e: React.DragEvent) => {
      if (e.dataTransfer.types.includes(SESSION_DRAG_MIME)) {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move' as const;
      }
    },
    onDrop: (e: React.DragEvent) => {
      e.preventDefault();
      const sessionId = e.dataTransfer.getData(SESSION_DRAG_MIME);
      if (sessionId) void handleMoveSession(sessionId, targetFolderId);
    },
  }), [handleMoveSession]);

  const hasFolders = folders.length > 0;

  return (
    <div className='flex-1 overflow-hidden bg-card dark:bg-black flex flex-col dark:shadow-inner dark:[box-shadow:inset_0px_-6px_40px_-40px_rgba(0,0,0,0.5)] [box-shadow:inset_0px_-6px_40px_-40px_black]' data-testid="sidebar-sessions-area">
      <div className='flex-1 overflow-auto'>
        {/* New Conversation button — ALWAYS at top, outside folders */}
        <div
          data-testid="sidebar-new-conversation-button"
          onClick={() => {
            navigate('/dashboard');
            onNewSession();
            const isMobileOrTablet = window.innerWidth < 1080;
            if (isMobileOrTablet && mobileMenuOpen && onCloseMobileMenu) {
              onCloseMobileMenu();
            }
          }}
          className='flex items-center px-4 py-2 text-zinc-700 hover:text-zinc-900 dark:text-white/70 dark:hover:text-white hover:bg-zinc-200 dark:hover:bg-chat-sidebar-button/30 cursor-pointer border-b border-zinc-100 dark:border-zinc-800'
        >
          <Pencil className='h-4 w-4 mr-2' />
          <AnimatedTitle title={t('sidebar.newConversation')} className='text-sm' animationDuration={5000} />
        </div>

        <SidebarRecentDocuments onCloseMobileMenu={onCloseMobileMenu} />

        {/* Unfiled sessions */}
        <div className='border-zinc-200 dark:border-border/10' data-testid="sidebar-unfiled-sessions" {...folderDropProps(null)}>
          <Collapsible
            open={miscGroupExpanded}
            onOpenChange={setMiscGroupExpanded}
            className='w-full'
          >
            <SessionsGroupHeader
              expanded={miscGroupExpanded}
              setExpanded={setMiscGroupExpanded}
              folder={null}
              sessionCount={unfiledCount}
              onNewSession={onNewSession}
              onRenameFolder={() => {}}
              onDeleteFolder={() => {}}
              onDropSession={(sid) => handleMoveSession(sid, null)}
            />
            <CollapsibleContent>
              <SessionsList
                selectedSessionId={selectedSessionId}
                onSelectSession={onSelectSession}
                onNewSession={onNewSession}
                refreshSessions={refreshSessions}
                mobileMenuOpen={mobileMenuOpen}
                onCloseMobileMenu={onCloseMobileMenu}
                onSessionsLoaded={setAllSessions}
                filterFn={(s) => !s.session_folder_id}
                folders={folders}
                onMoveSession={handleMoveSession}
                onSessionDeleted={loadFolders}
                onSessionPinned={handleSessionPinned}
                sessionFolderUpdate={sessionFolderUpdate}
                onLoadMoreReady={handleLoadMoreReady}
                onHasMoreChange={handleHasMoreChange}
                onTotalChange={handleTotalChange}
                refreshTrigger={refreshTrigger}
                hasFolders={hasFolders}
              />
            </CollapsibleContent>
          </Collapsible>
        </div>

        {/* User-created folders */}
        {folders.map(folder => {
          const folderSessions = sessionsByFolder[folder.id] || [];
          const isExpanded = folderExpandState[folder.id] !== false; // default expanded
          return (
            <div key={folder.id} className='border-zinc-200 dark:border-border/10' data-testid={`sidebar-folder-${folder.id}`} {...folderDropProps(folder.id)}>
              <Collapsible
                open={isExpanded}
                onOpenChange={(open) => setFolderExpanded(folder.id, open)}
                className='w-full'
              >
                <SessionsGroupHeader
                  expanded={isExpanded}
                  setExpanded={(open) => setFolderExpanded(folder.id, open)}
                  folder={folder}
                  sessionCount={folder.session_count || folderSessions.length}
                  onNewSession={onNewSession}
                  onRenameFolder={(name) => handleRenameFolder(folder.id, name)}
                  onDeleteFolder={() => handleDeleteFolder(folder.id)}
                  onDropSession={(sid) => handleMoveSession(sid, folder.id)}
                />
                <CollapsibleContent>
                  <SessionsList
                    selectedSessionId={selectedSessionId}
                    onSelectSession={onSelectSession}
                    onNewSession={onNewSession}
                    refreshSessions={refreshSessions}
                    mobileMenuOpen={mobileMenuOpen}
                    onCloseMobileMenu={onCloseMobileMenu}
                    filterFn={(s) => s.session_folder_id === folder.id}
                    isSecondaryList
                    externalSessions={allSessions}
                    folders={folders}
                    onMoveSession={handleMoveSession}
                    onSessionDeleted={loadFolders}
                    onSessionPinned={handleSessionPinned}
                    onRequestLoad={handleRequestLoad}
                    hasMoreSessions={primaryHasMore}
                  />
                </CollapsibleContent>
              </Collapsible>
            </div>
          );
        })}

      </div>

      {/* Sticky bottom: Create Folder + Notes */}
      <div className='shrink-0 border-t border-zinc-100 dark:border-zinc-800'>
        {/* Create Folder button */}
        <div
          data-testid="sidebar-create-folder-button"
          onClick={() => setCreateFolderOpen(true)}
          className='flex items-center px-4 py-2 text-zinc-500 hover:text-zinc-700 dark:text-zinc-500 dark:hover:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800/30 cursor-pointer'
        >
          <FolderPlus className='h-4 w-4 mr-2' />
          <span className='text-sm'>{t('sessionFolders.createFolder')}</span>
        </div>

        {/* Notes section removed — note discovery moved to Datoteka → Otvori
            inside the editor. */}
      </div>

      {/* Create Folder Dialog */}
      <Dialog open={createFolderOpen} onOpenChange={setCreateFolderOpen}>
        <DialogContent dialogOpen={createFolderOpen} onOpenChange={setCreateFolderOpen} data-testid="sidebar-create-folder-dialog">
          <DialogHeader>
            <div className='flex items-center gap-3'>
              <div className='p-2 bg-primary/10 text-primary'>
                <FolderPlus className='h-5 w-5' />
              </div>
              <div>
                <DialogTitle>{t('sessionFolders.createFolder')}</DialogTitle>
                <DialogDescription>{t('sessionFolders.createFolderDescription')}</DialogDescription>
              </div>
            </div>
          </DialogHeader>
          <div className='py-4'>
            <Label htmlFor='new-folder-name' className='text-sm font-medium mb-2 block'>
              {t('sessionFolders.folderName')}
            </Label>
            <Input
              id='new-folder-name'
              data-testid="sidebar-create-folder-name-input"
              value={newFolderName}
              onChange={e => setNewFolderName(e.target.value)}
              placeholder={t('sessionFolders.folderNamePlaceholder')}
              onKeyDown={e => { if (e.key === 'Enter') void handleCreateFolder(); }}
              autoFocus
            />
          </div>
          <DialogFooter>
            <Button variant='outline' onClick={() => { setCreateFolderOpen(false); setNewFolderName(''); }} data-testid="sidebar-create-folder-cancel">
              {t('general.cancel')}
            </Button>
            <Button onClick={handleCreateFolder} disabled={!newFolderName.trim()} data-testid="sidebar-create-folder-submit">
              {t('sessionFolders.create')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};
