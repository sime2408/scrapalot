import React, { useCallback, useRef } from 'react';
import { Session } from '@/types';
import { GripVertical, MoreHorizontal, Trash2, Copy, Edit, FolderInput, Share2, Tag, X, Pin, PinOff } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { ColorPalette } from '@/components/ui/color-palette';
import { SESSION_MARKERS } from '@/lib/api-sessions';
import { useTranslation } from 'react-i18next';

export const SESSION_DRAG_MIME = 'application/x-scrapalot-session';

// Shared across ALL session rows on purpose. On touch, selecting a dropdown
// item (pin, delete, rename…) closes the portaled menu and the browser
// synthesizes a "ghost click" — and because the menu drops downward from the
// ⋮ button, that ghost click usually lands on a DIFFERENT row below the one
// whose menu was open. A per-row guard misses it; this module-level timestamp
// lets any row ignore a click fired right after any menu closed.
let lastSessionMenuCloseAt = 0;

export interface SessionItemProps {
  session: Session;
  isSelected: boolean;
  processingAction: string | null;
  onSelectSession: (session: Session) => void;
  onDeleteSession: (id: string, e: React.MouseEvent) => void;
  onCloneSession: (id: string, e: React.MouseEvent) => void;
  onEditSession: (id: string, e: React.MouseEvent) => void;
  onMoveSession: (id: string, e: React.MouseEvent) => void;
  onShareSession: (id: string, e: React.MouseEvent) => void;
  onSetMarker: (id: string, icon: string | null, color: string | null) => void;
  onTogglePin: (id: string, pinned: boolean) => void;
  mobileMenuOpen?: boolean;
  onCloseMobileMenu?: () => void;
}

const SessionItemInner = ({
  session,
  isSelected,
  processingAction,
  onSelectSession,
  onDeleteSession,
  onCloneSession,
  onEditSession,
  onMoveSession,
  onShareSession,
  onSetMarker,
  onTogglePin,
  mobileMenuOpen,
  onCloseMobileMenu,
}: SessionItemProps) => {
  const { t } = useTranslation();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const dragInitiatedFromGrip = useRef(false);

  const isMobile = typeof window !== 'undefined' && window.innerWidth < 1080;

  const handleDragStart = useCallback((e: React.DragEvent<HTMLButtonElement>) => {
    if (!dragInitiatedFromGrip.current) {
      e.preventDefault();
      return;
    }
    e.dataTransfer.setData(SESSION_DRAG_MIME, session.id);
    e.dataTransfer.setData('text/plain', session.id);
    e.dataTransfer.effectAllowed = 'move';
    if (buttonRef.current) {
      buttonRef.current.style.opacity = '0.4';
    }
  }, [session.id]);

  const handleDragEnd = useCallback(() => {
    dragInitiatedFromGrip.current = false;
    if (buttonRef.current) {
      buttonRef.current.style.opacity = '1';
    }
  }, []);

  const handleGripMouseDown = useCallback(() => {
    dragInitiatedFromGrip.current = true;
  }, []);

  return (
    <button
      ref={buttonRef}
      data-testid={`sidebar-session-item-${session.id}`}
      draggable={!isMobile}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      className={`w-full text-left p-2 pl-2 transition-colors flex items-start group ${isSelected
        ? 'bg-accent-highlight text-zinc-800 dark:bg-chat-sidebar-button dark:text-white border-l-[3px] border-solid border-primary dark:border-primary'
        : 'hover:bg-zinc-200 dark:hover:bg-chat-sidebar-button/70 text-zinc-700 dark:text-gray-300 border-l-[4px] border-solid border-transparent hover:border-primary dark:hover:border-primary'
        }`}
      onClick={() => {
        // Ignore ghost clicks synthesized right after ANY row's menu closed —
        // those are not a session selection (the ghost click often lands on a
        // different row than the one whose menu was open).
        if (Date.now() - lastSessionMenuCloseAt < 500) return;
        onSelectSession(session);
        const isMobileOrTablet = window.innerWidth < 1080;
        if (isMobileOrTablet && mobileMenuOpen && onCloseMobileMenu) {
          onCloseMobileMenu();
        }
      }}
    >
      <div
        data-testid={`sidebar-session-drag-handle-${session.id}`}
        className='h-4 w-4 mr-1.5 mt-0.5 flex-shrink-0 text-zinc-400 dark:text-muted-foreground flex items-center justify-center cursor-grab active:cursor-grabbing opacity-100 md:opacity-0 md:group-hover:opacity-100 transition-opacity duration-200'
        onMouseDown={handleGripMouseDown}
        aria-label={t('sessionFolders.dragToMove')}
      >
        <GripVertical className='h-3 w-3' />
      </div>
      <div className='flex-1 truncate text-sm flex items-center gap-1.5 min-w-0'>
        {session.is_pinned && (
          <Pin
            data-testid={`sidebar-session-pin-indicator-${session.id}`}
            className='h-3 w-3 flex-shrink-0 text-primary fill-primary'
            aria-label={t('sessionsList.pin.pinned')}
          />
        )}
        {session.marker_icon && (
          <span
            data-testid={`sidebar-session-marker-${session.id}`}
            className='flex-shrink-0 text-xs leading-none inline-flex items-center justify-center'
            style={session.marker_color ? { textShadow: `0 0 0 ${session.marker_color}` } : undefined}
            title={t('sessionsList.markers.title')}
          >
            {session.marker_color && (
              <span className='w-1.5 h-1.5 rounded-full mr-1' style={{ backgroundColor: session.marker_color }} />
            )}
            {session.marker_icon}
          </span>
        )}
        <p className='truncate'>{session.title}</p>
      </div>
      <DropdownMenu onOpenChange={open => { if (!open) lastSessionMenuCloseAt = Date.now(); }}>
        <DropdownMenuTrigger
          asChild
          onClick={e => e.stopPropagation()}
        >
          <div data-testid={`sidebar-session-options-trigger-${session.id}`} className={`ml-2 p-1 hover:bg-zinc-300 dark:hover:bg-gray-700 transition-all duration-200 cursor-pointer ${
            processingAction === session.id
              ? 'opacity-100'
              : 'opacity-100 md:opacity-0 md:group-hover:opacity-100 data-[state=open]:opacity-100'
          }`}>
            {processingAction === session.id ? (
              <div className='h-3.5 w-3.5 animate-spin rounded-full border-2 border-transparent border-t-zinc-600 dark:border-t-gray-400' />
            ) : (
              <MoreHorizontal className='h-3.5 w-3.5 text-zinc-600 dark:text-gray-400' />
            )}
          </div>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align='end'
          className='w-56'
          data-testid={`sidebar-session-menu-${session.id}`}
          // The menu is portaled, but React synthetic events still bubble up the
          // JSX tree — i.e. into the row <button> this menu lives in. Without
          // this, selecting any item (pin/rename/delete/marker) bubbles to the
          // row's onClick → onSelectSession → on mobile navigates to the session
          // AND collapses the sidebar. Stop the bubble at the menu boundary so
          // only a genuine row tap selects the session.
          onClick={e => e.stopPropagation()}
        >
          <DropdownMenuLabel>{t('sessionsList.sessionOptions')}</DropdownMenuLabel>
          <DropdownMenuItem
            data-testid={`sidebar-session-edit-${session.id}`}
            onClick={e => onEditSession(session.id, e)}
          >
            <Edit className='mr-2 h-4 w-4' />
            <span>{t('sessionsList.renameSession')}</span>
          </DropdownMenuItem>
          <DropdownMenuItem
            data-testid={`sidebar-session-pin-${session.id}`}
            onSelect={() => onTogglePin(session.id, !session.is_pinned)}
          >
            {session.is_pinned ? (
              <>
                <PinOff className='mr-2 h-4 w-4' />
                <span>{t('sessionsList.pin.unpin')}</span>
              </>
            ) : (
              <>
                <Pin className='mr-2 h-4 w-4' />
                <span>{t('sessionsList.pin.pin')}</span>
              </>
            )}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            data-testid={`sidebar-session-move-${session.id}`}
            onClick={e => onMoveSession(session.id, e)}
          >
            <FolderInput className='mr-2 h-4 w-4' />
            <span>{t('sessionsList.moveSession')}</span>
          </DropdownMenuItem>
          <DropdownMenuItem
            data-testid={`sidebar-session-clone-${session.id}`}
            onClick={e => onCloneSession(session.id, e)}
          >
            <Copy className='mr-2 h-4 w-4' />
            <span>{t('sessionsList.cloneSession')}</span>
          </DropdownMenuItem>
          <DropdownMenuItem
            data-testid={`sidebar-session-share-${session.id}`}
            onClick={e => onShareSession(session.id, e)}
          >
            <Share2 className='mr-2 h-4 w-4' />
            <span>{t('sessionsList.shareSession')}</span>
          </DropdownMenuItem>
          <DropdownMenuSub>
            <DropdownMenuSubTrigger data-testid={`sidebar-session-marker-trigger-${session.id}`}>
              <Tag className='mr-2 h-4 w-4' />
              <span>{t('sessionsList.markers.title')}</span>
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className='w-48'>
              <div className='grid grid-cols-4 gap-1 p-1'>
                {SESSION_MARKERS.map(m => (
                  <button
                    key={m.icon}
                    type='button'
                    data-testid={`sidebar-session-marker-icon-${m.icon}`}
                    title={t(m.labelKey)}
                    onClick={e => { e.stopPropagation(); onSetMarker(session.id, m.icon, session.marker_color ?? null); }}
                    className={`h-8 w-full flex items-center justify-center text-base hover:bg-zinc-200 dark:hover:bg-zinc-700 ${session.marker_icon === m.icon ? 'bg-zinc-200 dark:bg-zinc-700 ring-1 ring-primary' : ''}`}
                  >
                    {m.icon}
                  </button>
                ))}
              </div>
              <DropdownMenuSeparator />
              <div className='px-2 py-1.5'>
                <ColorPalette
                  value={session.marker_color ?? null}
                  size='sm'
                  onChange={color => onSetMarker(session.id, session.marker_icon ?? SESSION_MARKERS[0].icon, color)}
                />
              </div>
              {(session.marker_icon || session.marker_color) && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    data-testid={`sidebar-session-marker-clear-${session.id}`}
                    onClick={() => onSetMarker(session.id, null, null)}
                  >
                    <X className='mr-2 h-4 w-4' />
                    <span>{t('sessionsList.markers.clear')}</span>
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            data-testid={`sidebar-session-delete-${session.id}`}
            onClick={e => onDeleteSession(session.id, e)}
            className='text-red-600 focus:text-red-600 dark:text-red-400 dark:focus:text-red-400'
          >
            <Trash2 className='mr-2 h-4 w-4' />
            <span>{t('sessionsList.deleteSession')}</span>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </button>
  );
};

export const SessionItem = React.memo(SessionItemInner, (prevProps, nextProps) => {
  return (
    prevProps.session.id === nextProps.session.id &&
    prevProps.session.title === nextProps.session.title &&
    prevProps.session.conversation_name === nextProps.session.conversation_name &&
    prevProps.session.marker_icon === nextProps.session.marker_icon &&
    prevProps.session.marker_color === nextProps.session.marker_color &&
    prevProps.session.is_pinned === nextProps.session.is_pinned &&
    prevProps.session.updated_at === nextProps.session.updated_at &&
    prevProps.isSelected === nextProps.isSelected &&
    prevProps.processingAction === nextProps.processingAction
  );
});
