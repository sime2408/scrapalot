import { useCallback, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { Bell, ChevronLeft, Megaphone, Send, X } from 'lucide-react';
import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { ProfileImg } from '@/components/ui/profile-img';
import { cn } from '@/lib/utils';
import { useAdminMessages } from '@/contexts/admin-messages-context';
import type { DirectMessageResponse } from '@/lib/api-admin-messages';

function displayName(first: string | null, username: string | null): string {
  return first || username || 'Admin';
}

/**
 * Notification bell + dropdown — the "quiet home" for admin messages. Shows an
 * unread badge and a list of admin threads; opening a thread reveals its messages
 * and (for admin_dm) a reply box. Broadcasts are read-only. Lives in the tool-dock
 * so it is globally visible regardless of route, and shares one source of truth
 * (the AdminMessagesProvider) with the prominent toast host.
 */
export function NotificationBell() {
  const { t } = useTranslation();
  const { threads, unreadCount, markRead, dismiss, reply, loadMessages } = useAdminMessages();
  const [open, setOpen] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<DirectMessageResponse[]>([]);
  const [replyText, setReplyText] = useState('');
  const [busy, setBusy] = useState(false);

  const active = threads.find((th) => th.id === activeId) ?? null;

  const openThread = useCallback(
    async (id: string) => {
      setActiveId(id);
      setMessages([]);
      try {
        setMessages(await loadMessages(id));
        await markRead(id); // opening clears the unread badge but keeps the thread
      } catch {
        /* best-effort */
      }
    },
    [loadMessages, markRead]
  );

  const sendReply = useCallback(async () => {
    if (!activeId || !replyText.trim()) return;
    setBusy(true);
    try {
      await reply(activeId, replyText);
      setReplyText('');
      setMessages(await loadMessages(activeId));
    } finally {
      setBusy(false);
    }
  }, [activeId, replyText, reply, loadMessages]);

  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) setActiveId(null);
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={t('notifications.bell.title', 'Messages')}
          title={t('notifications.bell.title', 'Messages')}
          data-testid="tool-dock-notifications-button"
          className={cn(
            'relative flex h-10 w-10 items-center justify-center transition-all',
            unreadCount > 0
              ? 'text-foreground opacity-100'
              : 'text-muted-foreground opacity-50 hover:bg-muted/50 hover:text-foreground hover:opacity-100'
          )}
        >
          <Bell className="h-4 w-4" />
          {unreadCount > 0 && (
            <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-[16px] items-center justify-center rounded-full bg-primary px-0.5 text-[9px] font-bold leading-none text-primary-foreground">
              {unreadCount > 99 ? '99+' : unreadCount}
            </span>
          )}
        </button>
      </PopoverTrigger>
      {/* Pin the dropdown to the top-right toast zone instead of next to the
          tool-dock button (which sits vertically centred on the right edge, so
          a trigger-anchored popover would open mid-screen). A zero-size fixed
          anchor at the toast-viewport origin makes the panel drop into the
          same top-right area as the prominent admin toasts.
          Portalled to <body>: the tool-dock has a transformed ancestor, which
          would otherwise become the containing block for this `fixed` element
          and offset it (rect ≠ viewport coords). Radix context flows through
          the portal so the custom-anchor registration still works. */}
      {createPortal(
        <PopoverAnchor className="fixed right-4 top-[calc(env(safe-area-inset-top,0px)+1rem)] h-0 w-0" />,
        document.body
      )}
      <PopoverContent side="bottom" align="end" sideOffset={4} collisionPadding={16} className="w-80 max-w-[calc(100vw-2rem)] p-0 z-[10010]">
        {active ? (
          // ---- Thread view ----
          <div className="flex max-h-[26rem] flex-col">
            <div className="flex items-center gap-2 border-b border-border p-3">
              <button
                type="button"
                onClick={() => setActiveId(null)}
                className="text-muted-foreground hover:text-foreground"
                aria-label={t('common.back', 'Back')}
              >
                <ChevronLeft className="h-4 w-4" />
              </button>
              <span className="truncate text-sm font-semibold">
                {active.kind === 'admin_broadcast'
                  ? t('notifications.toast.announcement', 'Announcement')
                  : displayName(active.other_first_name, active.other_username)}
              </span>
            </div>
            <div className="flex-1 space-y-2 overflow-y-auto p-3">
              {messages.map((m) => (
                <div key={m.id} className="text-sm">
                  <span className="font-medium text-muted-foreground">
                    {displayName(m.sender_first_name, m.sender_username)}:{' '}
                  </span>
                  <span className="whitespace-pre-wrap">{m.content}</span>
                </div>
              ))}
            </div>
            {active.kind === 'admin_dm' && (
              <div className="flex items-center gap-2 border-t border-border p-2">
                <input
                  type="text"
                  value={replyText}
                  onChange={(e) => setReplyText(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault();
                      void sendReply();
                    }
                  }}
                  placeholder={t('notifications.bell.replyPlaceholder', 'Reply…')}
                  className="flex-1 border border-border bg-background px-2 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
                />
                <button
                  type="button"
                  disabled={busy || !replyText.trim()}
                  onClick={() => void sendReply()}
                  className="inline-flex h-7 w-7 items-center justify-center bg-primary text-primary-foreground disabled:opacity-50"
                  aria-label={t('notifications.bell.send', 'Send')}
                >
                  <Send className="h-3.5 w-3.5" />
                </button>
              </div>
            )}
          </div>
        ) : (
          // ---- Thread list ----
          <div className="flex max-h-[26rem] flex-col">
            <div className="border-b border-border p-3 text-sm font-semibold">
              {t('notifications.bell.title', 'Messages')}
            </div>
            {threads.length === 0 ? (
              <div className="p-6 text-center text-sm text-muted-foreground">
                {t('notifications.bell.empty', 'No messages')}
              </div>
            ) : (
              <div className="flex-1 overflow-y-auto">
                {threads.map((th) => (
                  <div
                    key={th.id}
                    className={cn(
                      'group flex cursor-pointer items-start gap-2 border-b border-border p-3 hover:bg-muted/50',
                      th.unread_count > 0 && 'bg-muted/30'
                    )}
                    onClick={() => void openThread(th.id)}
                  >
                    <div className="mt-0.5 flex-shrink-0">
                      {th.other_profile_picture ? (
                        <ProfileImg pic={th.other_profile_picture} alt="" className="h-7 w-7 rounded-full object-cover" />
                      ) : th.kind === 'admin_broadcast' ? (
                        <Megaphone className="h-5 w-5 text-muted-foreground" />
                      ) : (
                        <Bell className="h-5 w-5 text-muted-foreground" />
                      )}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center justify-between gap-2">
                        <span className="truncate text-sm font-medium">
                          {th.kind === 'admin_broadcast'
                            ? t('notifications.toast.announcement', 'Announcement')
                            : displayName(th.other_first_name, th.other_username)}
                        </span>
                        {th.unread_count > 0 && <span className="h-2 w-2 flex-shrink-0 rounded-full bg-primary" />}
                      </div>
                      <p className="truncate text-xs text-muted-foreground">{th.last_message}</p>
                    </div>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        void dismiss(th.id);
                      }}
                      className="flex-shrink-0 text-muted-foreground opacity-0 transition-opacity hover:text-foreground group-hover:opacity-100"
                      aria-label={t('notifications.bell.dismiss', 'Dismiss')}
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
