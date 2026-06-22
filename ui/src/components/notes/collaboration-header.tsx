import React from 'react';
import { Check, Loader2 } from 'lucide-react';
import {UserAvatar} from './user-avatar';
import {Tooltip, TooltipContent, TooltipProvider, TooltipTrigger,} from '@/components/ui/tooltip';
import {cn} from '@/lib/utils';
import {useIsMobile} from '@/hooks/use-mobile';
import { useTranslation } from 'react-i18next';

interface CollaborationUser {
  id: string;
  name: string;
  email?: string;
  avatar?: string;
  color?: string;
  isActive?: boolean;
  lastSeen?: string;
}

export type SaveStatus = 'idle' | 'saving' | 'saved';

interface CollaborationHeaderProps {
  documentTitle?: string;
  createdBy: CollaborationUser;
  activeUsers: CollaborationUser[];
  connectionStatus: 'connecting' | 'connected' | 'disconnected';
  typingUsers?: Map<string, { name: string; id: string }>;
  saveStatus?: SaveStatus;
  onShare?: () => void;
  className?: string;
}

export const CollaborationHeader: React.FC<CollaborationHeaderProps> = ({
  documentTitle: _documentTitle = 'Untitled Document',
  createdBy,
  activeUsers = [],
  connectionStatus: _connectionStatus = 'disconnected',
  typingUsers: externalTypingUsers,
  saveStatus = 'idle',
  onShare,
  className
}) => {
  const isMobile = useIsMobile();
  const { t } = useTranslation();

  // Convert external typing users to Set of names for display
  const typingUserNames = externalTypingUsers ?
    new Set(Array.from(externalTypingUsers.values()).map(user => user.name)) :
    new Set<string>();

  // Ensure createdBy has default values
  const safeCreatedBy = createdBy || {
    id: 'default-user',
    name: 'Unknown User',
    email: 'unknown@example.com'
  };

  // Filter out duplicate users and current user
  const uniqueActiveUsers = activeUsers.filter((user, index, arr) =>
    arr.findIndex(u => u.id === user.id) === index
  );

  // Filter out creator from active users - use string comparison to handle type mismatches
  const otherActiveUsers = uniqueActiveUsers.filter(user =>
    String(user.id).toLowerCase() !== String(safeCreatedBy.id).toLowerCase()
  );
  const totalCollaborators = otherActiveUsers.length;

  return (
    <TooltipProvider>
      {/* Floating collaboration header — 50% transparent, full on hover/touch */}
      <div data-testid="collaboration-header" className={cn(
        'absolute left-0 right-0 z-50',
        // Push the badge below the mobile sticky toolbar so the avatar
        // doesn't overlap the top bar on phones.
        isMobile ? 'top-[74px]' : 'top-12',
        'flex items-center justify-between',
        'opacity-50 hover:opacity-100 focus-within:opacity-100 transition-opacity duration-200',
        isMobile ? 'px-2 py-2' : 'px-2 py-2.5 mt-2',
        className
      )}
      onTouchStart={(e) => {
        // Make fully visible on touch
        (e.currentTarget as HTMLElement).style.opacity = '1';
      }}
      onTouchEnd={(e) => {
        // Fade back after 2s
        const el = e.currentTarget as HTMLElement;
        setTimeout(() => { el.style.opacity = ''; }, 2000);
      }}>
        {/* Left: empty spacer (creator badge moved to NotePageMetaRow
            below the H1 per migration-116 layout — duplicating it here
            would visually compete with the page-meta row right below). */}
        <div className="min-w-0 flex-1" />

        {/* Right: Save status + collaborators only. Share button moved
            to NotePageMetaRow. */}
        <div className="flex items-center gap-3 flex-shrink-0">

          {/* Active collaborators */}
          {totalCollaborators > 0 && (
            <div data-testid="active-collaborators" className="flex items-center gap-2 rounded-full px-2.5 py-1">
              <div className="flex -space-x-2">
                {otherActiveUsers.slice(0, 3).map((user) => (
                  <Tooltip key={user.id}>
                    <TooltipTrigger asChild>
                      <div className="transition-transform hover:scale-110 hover:z-10">
                        <UserAvatar
                          name={user.name}
                          email={user.email}
                          avatar={user.avatar}
                          color={user.color}
                          size="sm"
                          className="ring-2 ring-background"
                        />
                      </div>
                    </TooltipTrigger>
                    <TooltipContent side="bottom">
                      <p className="text-xs font-medium">{user.name}</p>
                    </TooltipContent>
                  </Tooltip>
                ))}
              </div>
              {totalCollaborators > 3 && (
                <span className="text-xs font-semibold text-violet-600 dark:text-violet-400">
                  +{totalCollaborators - 3}
                </span>
              )}
            </div>
          )}

          {/* Save status icon moved to NoteMenuBar (SaveStatusPill) so
              the header stays light and the indicator is visible
              regardless of scroll position. */}

          {/* Share button moved to NotePageMetaRow under the title. */}
        </div>
      </div>

      {/* Typing indicator */}
      {typingUserNames.size > 0 && (
        <div className="px-4 py-1.5 backdrop-blur-sm">
          <div className="flex items-center gap-2.5">
            <div className="flex gap-0.5">
              <div className="w-1 h-1 rounded-full bg-violet-500 animate-bounce" style={{ animationDelay: '0ms' }} />
              <div className="w-1 h-1 rounded-full bg-violet-500 animate-bounce" style={{ animationDelay: '150ms' }} />
              <div className="w-1 h-1 rounded-full bg-violet-500 animate-bounce" style={{ animationDelay: '300ms' }} />
            </div>
            <span className="text-xs font-medium text-violet-700 dark:text-violet-300">
              {typingUserNames.size === 1
                ? `${Array.from(typingUserNames)[0]} is typing...`
                : `${typingUserNames.size} people are typing...`
              }
            </span>
          </div>
        </div>
      )}
    </TooltipProvider>
  );
};
