import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import backendStompService from '@/lib/stomp-backend-service';
import { useAuth } from '@/hooks/use-auth';
import { useNotificationSound } from '@/hooks/use-notification-sound';
import { userPrefs } from '@/lib/storage-utils';
import {
  getAdminThreads,
  getAdminMessages,
  replyToAdminMessage,
  dismissAdminMessage,
  markAdminMessageRead,
  type AdminThread,
  type DirectMessageResponse,
} from '@/lib/api-admin-messages';

export interface AdminToastItem {
  conversationId: string;
  senderName: string;
  senderProfilePicture: string | null;
  content: string;
  kind: 'admin_dm' | 'admin_broadcast';
}

interface AdminMessagesValue {
  threads: AdminThread[];
  toasts: AdminToastItem[];
  unreadCount: number;
  markRead: (conversationId: string) => Promise<void>;
  dismiss: (conversationId: string) => Promise<void>;
  dismissToast: (conversationId: string) => void;
  reply: (conversationId: string, content: string) => Promise<void>;
  loadMessages: (conversationId: string) => Promise<DirectMessageResponse[]>;
  refresh: () => Promise<void>;
}

const AdminMessagesContext = createContext<AdminMessagesValue | null>(null);

/** Per-device pref: prominent toast on (default) vs bell-only. Persisted via userPrefs;
 *  dual-written to the backend by the settings toggle (task: settings). */
function toastEnabled(): boolean {
  return (userPrefs.get() as { admin_messages_toast_enabled?: boolean }).admin_messages_toast_enabled ?? true;
}

function senderName(firstName: string | null, username: string | null): string {
  return firstName || username || 'Admin';
}

export function AdminMessagesProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const userId = user?.id;
  const { playMessageSound } = useNotificationSound();

  const [threads, setThreads] = useState<AdminThread[]>([]);
  const [toasts, setToasts] = useState<AdminToastItem[]>([]);
  const unsubRef = useRef<(() => void) | null>(null);
  // conversations dismissed this session — never re-toast them on refresh.
  const dismissedRef = useRef<Set<string>>(new Set());

  const refresh = useCallback(async () => {
    if (!userId) return;
    try {
      const data = await getAdminThreads();
      setThreads(data);
      if (toastEnabled()) {
        // Surface undismissed RECEIVED admin messages (unread) as persistent toasts —
        // this is what makes a message left for an offline user re-appear on next login.
        setToasts((prev) => {
          const shown = new Set(prev.map((t) => t.conversationId));
          const extra = data
            .filter((t) => t.unread_count > 0 && !shown.has(t.id) && !dismissedRef.current.has(t.id))
            .map<AdminToastItem>((t) => ({
              conversationId: t.id,
              senderName: senderName(t.other_first_name, t.other_username),
              senderProfilePicture: t.other_profile_picture,
              content: t.last_message ?? '',
              kind: t.kind === 'admin_broadcast' ? 'admin_broadcast' : 'admin_dm',
            }));
          return extra.length ? [...extra, ...prev] : prev;
        });
      }
    } catch (err) {
      console.error('[admin-msg] Failed to load threads:', err);
    }
  }, [userId]);

  // One shared subscription to the Kotlin user queue, filtered to admin messages.
  // The peer DM hook subscribes to the same destination but only handles type='message',
  // so the two coexist without cross-handling.
  useEffect(() => {
    if (!userId) return;
    const setup = async () => {
      unsubRef.current = await backendStompService.subscribe('/user/queue/dm', (data) => {
        const payload = data as {
          type?: string;
          kind?: 'admin_dm' | 'admin_broadcast';
          conversation_id?: string;
          message?: DirectMessageResponse;
        };
        if (payload.type !== 'admin_message' || !payload.message || !payload.conversation_id) return;

        const message = payload.message;
        const convId = payload.conversation_id;
        void refresh();

        // Toast + sound only for INCOMING messages (not our own echoed reply).
        if (message.sender_id !== userId) {
          dismissedRef.current.delete(convId);
          playMessageSound();
          if (toastEnabled()) {
            setToasts((prev) => [
              {
                conversationId: convId,
                senderName: senderName(message.sender_first_name, message.sender_username),
                senderProfilePicture: message.sender_profile_picture,
                content: message.content,
                kind: payload.kind === 'admin_broadcast' ? 'admin_broadcast' : 'admin_dm',
              },
              ...prev.filter((t) => t.conversationId !== convId),
            ]);
          }
        }
      });
    };
    void setup();
    return () => {
      unsubRef.current?.();
      unsubRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const dismissToast = useCallback((conversationId: string) => {
    setToasts((prev) => prev.filter((t) => t.conversationId !== conversationId));
  }, []);

  const markRead = useCallback(async (conversationId: string) => {
    // Opening a thread clears its unread badge but keeps it in the bell.
    setToasts((prev) => prev.filter((t) => t.conversationId !== conversationId));
    setThreads((prev) => prev.map((t) => (t.id === conversationId ? { ...t, unread_count: 0 } : t)));
    try {
      await markAdminMessageRead(conversationId);
    } catch (err) {
      console.error('[admin-msg] markRead failed:', err);
    }
  }, []);

  const dismiss = useCallback(async (conversationId: string) => {
    dismissedRef.current.add(conversationId);
    setToasts((prev) => prev.filter((t) => t.conversationId !== conversationId));
    // Remove the thread outright (not just unread→0): dismiss clears it from the bell.
    // The backend stamps a per-participant dismissed_at so it stays gone after refresh,
    // re-surfacing only when a newer message bumps the conversation.
    setThreads((prev) => prev.filter((t) => t.id !== conversationId));
    try {
      await dismissAdminMessage(conversationId);
    } catch (err) {
      console.error('[admin-msg] dismiss failed:', err);
    }
  }, []);

  const reply = useCallback(
    async (conversationId: string, content: string) => {
      if (!content.trim()) return;
      await replyToAdminMessage(conversationId, content.trim());
      await refresh();
    },
    [refresh]
  );

  const loadMessages = useCallback((conversationId: string) => getAdminMessages(conversationId), []);

  const unreadCount = threads.reduce((sum, t) => sum + t.unread_count, 0);

  return (
    <AdminMessagesContext.Provider
      value={{ threads, toasts, unreadCount, markRead, dismiss, dismissToast, reply, loadMessages, refresh }}
    >
      {children}
    </AdminMessagesContext.Provider>
  );
}

export function useAdminMessages(): AdminMessagesValue {
  const ctx = useContext(AdminMessagesContext);
  if (!ctx) throw new Error('useAdminMessages must be used within AdminMessagesProvider');
  return ctx;
}
