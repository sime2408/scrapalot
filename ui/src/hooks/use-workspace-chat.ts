import { useState, useEffect, useCallback, useRef } from 'react';
import backendStompService from '@/lib/stomp-backend-service';
import { toast } from '@/lib/toast-compat';
import {
  getChatMessages,
  getChatMembers,
  checkChatAccess,
  deleteChatMessage,
  rollbackChatMessages,
  clearChatMessages,
  type WorkspaceChatMessage,
  type WorkspaceChatPresence,
  type WorkspaceChatAccess
} from '@/lib/api-workspace-chat';

interface TypingUser {
  userId: string;
  username: string;
}

interface UseWorkspaceChatResult {
  messages: WorkspaceChatMessage[];
  members: WorkspaceChatPresence[];
  typingUsers: TypingUser[];
  access: WorkspaceChatAccess | null;
  isLoading: boolean;
  unreadCount: number;
  sendMessage: (content: string) => void;
  setTyping: (isTyping: boolean) => void;
  markAsRead: () => void;
  deleteMessage: (messageId: string) => Promise<void>;
  rollbackFromMessage: (messageId: string) => Promise<void>;
  clearConversation: () => Promise<void>;
}

export function useWorkspaceChat(
  workspaceId: string | undefined,
  userId: string | undefined,
  isOpen: boolean
): UseWorkspaceChatResult {
  const [messages, setMessages] = useState<WorkspaceChatMessage[]>([]);
  const [members, setMembers] = useState<WorkspaceChatPresence[]>([]);
  const [typingUsers, setTypingUsers] = useState<TypingUser[]>([]);
  const [access, setAccess] = useState<WorkspaceChatAccess | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [unreadCount, setUnreadCount] = useState(0);
  const unsubscribeRefs = useRef<Array<() => void>>([]);
  const heartbeatRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const typingTimeoutRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const isOpenRef = useRef(isOpen);

  // Check access
  useEffect(() => {
    if (!workspaceId) {
      console.log('[WorkspaceChat] No workspaceId, skipping access check');
      setIsLoading(false);
      setAccess(null);
      return;
    }
    let cancelled = false;

    // Reset loading state when workspaceId changes so ToolDock doesn't return null prematurely
    setIsLoading(true);

    console.log('[WorkspaceChat] Checking access for workspace:', workspaceId);
    checkChatAccess(workspaceId)
      .then(result => {
        if (!cancelled) {
          console.log('[WorkspaceChat] Access result:', result);
          setAccess(result);
        }
      })
      .catch((err) => {
        console.error('[WorkspaceChat] Access check failed:', err);
        if (!cancelled) setAccess({ hasFeature: false, isMember: false, canChat: false });
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });

    return () => { cancelled = true; };
  }, [workspaceId]);

  // Load initial data and subscribe to STOMP topics
  useEffect(() => {
    if (!workspaceId || !userId || !access?.canChat) {
      console.log('[WorkspaceChat] Skipping STOMP init:', { workspaceId, userId, canChat: access?.canChat });
      return;
    }

    let cancelled = false;

    const init = async () => {
      console.log('[WorkspaceChat] Initializing STOMP for workspace:', workspaceId);
      // 1. Subscribe to all STOMP topics FIRST (before join, so we catch our own presence update)
      try {
        const unsubMessages = await backendStompService.subscribe(
          `/topic/workspace.${workspaceId}.chat.messages`,
          (msg) => {
            const message = msg as unknown as WorkspaceChatMessage;
            setMessages(prev => [...prev, message].slice(-200));
            if (!isOpenRef.current && message.sender_id !== userId) {
              setUnreadCount(prev => prev + 1);
              const senderName = message.sender_first_name
                ? `${message.sender_first_name}${message.sender_last_name ? ' ' + message.sender_last_name : ''}`
                : message.sender_username || 'Someone';
              const preview = message.content.length > 60
                ? message.content.slice(0, 60) + '...'
                : message.content;
              toast.info(`${senderName}: ${preview}`);
            }
          }
        );
        unsubscribeRefs.current.push(unsubMessages);
      } catch (err) {
        console.error('Failed to subscribe to chat messages:', err);
      }

      try {
        const unsubPresence = await backendStompService.subscribe(
          `/topic/workspace.${workspaceId}.chat.presence`,
          (msg) => {
            const update = msg as unknown as { user_id: string; is_online: boolean };
            setMembers(prev =>
              prev.map(m =>
                m.user_id === update.user_id
                  ? { ...m, is_online: update.is_online }
                  : m
              )
            );
          }
        );
        unsubscribeRefs.current.push(unsubPresence);
      } catch (err) {
        console.error('Failed to subscribe to presence:', err);
      }

      try {
        const unsubDeletions = await backendStompService.subscribe(
          `/topic/workspace.${workspaceId}.chat.deletions`,
          (msg) => {
            const event = msg as unknown as { type: 'deleted' | 'cleared'; ids?: string[] };
            if (event.type === 'cleared') {
              setMessages([]);
              return;
            }
            if (event.type === 'deleted' && Array.isArray(event.ids) && event.ids.length > 0) {
              const dropped = new Set(event.ids);
              setMessages(prev => prev.filter(m => !dropped.has(m.id)));
            }
          }
        );
        unsubscribeRefs.current.push(unsubDeletions);
      } catch (err) {
        console.error('Failed to subscribe to chat deletions:', err);
      }

      try {
        const unsubTyping = await backendStompService.subscribe(
          `/topic/workspace.${workspaceId}.chat.typing`,
          (msg) => {
            const data = msg as unknown as { user_id: string; username: string; is_typing: boolean };
            if (data.user_id === userId) return;

            if (data.is_typing) {
              setTypingUsers(prev => {
                if (prev.some(t => t.userId === data.user_id)) return prev;
                return [...prev, { userId: data.user_id, username: data.username }];
              });

              const existing = typingTimeoutRef.current.get(data.user_id);
              if (existing) clearTimeout(existing);
              typingTimeoutRef.current.set(
                data.user_id,
                setTimeout(() => {
                  setTypingUsers(prev => prev.filter(t => t.userId !== data.user_id));
                  typingTimeoutRef.current.delete(data.user_id);
                }, 3000)
              );
            } else {
              setTypingUsers(prev => prev.filter(t => t.userId !== data.user_id));
              const existing = typingTimeoutRef.current.get(data.user_id);
              if (existing) {
                clearTimeout(existing);
                typingTimeoutRef.current.delete(data.user_id);
              }
            }
          }
        );
        unsubscribeRefs.current.push(unsubTyping);
      } catch (err) {
        console.error('Failed to subscribe to typing:', err);
      }

      if (cancelled) return;

      // 2. Load messages and members via REST
      try {
        const [msgs, mems] = await Promise.all([
          getChatMessages(workspaceId),
          getChatMembers(workspaceId)
        ]);
        if (cancelled) return;
        setMessages(msgs);
        setMembers(mems);
      } catch (err) {
        console.error('Failed to load workspace chat data:', err);
      }

      // 3. Join chat AFTER subscriptions are active (so we receive our own presence update)
      try {
        console.log('[WorkspaceChat] Sending join for workspace:', workspaceId);
        await backendStompService.send('/app/workspace.chat.join', { workspace_id: workspaceId });
        console.log('[WorkspaceChat] Join successful');
      } catch (err) {
        console.error('[WorkspaceChat] Failed to join workspace chat:', err);
      }

      // 4. Heartbeat every 30s
      heartbeatRef.current = setInterval(() => {
        backendStompService.send('/app/workspace.chat.heartbeat', { workspace_id: workspaceId }).catch(() => {});
      }, 30_000);
    };

    void init();

    return () => {
      cancelled = true;
      unsubscribeRefs.current.forEach(unsub => unsub());
      unsubscribeRefs.current = [];

      if (heartbeatRef.current) {
        clearInterval(heartbeatRef.current);
        heartbeatRef.current = null;
      }

      typingTimeoutRef.current.forEach(timeout => clearTimeout(timeout));
      // eslint-disable-next-line react-hooks/exhaustive-deps -- deps are intentionally limited
      typingTimeoutRef.current.clear();

      backendStompService.send('/app/workspace.chat.leave', { workspace_id: workspaceId }).catch(() => {});
    };
  }, [workspaceId, userId, access?.canChat]);

  // Track isOpen for unread counting (update ref without re-subscribing)
  useEffect(() => {
    isOpenRef.current = isOpen;
  }, [isOpen]);

  const sendMessage = useCallback((content: string) => {
    if (!workspaceId || !content.trim()) return;
    backendStompService.send('/app/workspace.chat.send', {
      workspace_id: workspaceId,
      content: content.trim()
    }).catch(err => console.error('Failed to send chat message:', err));
  }, [workspaceId]);

  const setTyping = useCallback((isTyping: boolean) => {
    if (!workspaceId) return;
    backendStompService.send('/app/workspace.chat.typing', {
      workspace_id: workspaceId,
      is_typing: String(isTyping)
    }).catch(() => {});
  }, [workspaceId]);

  const markAsRead = useCallback(() => {
    setUnreadCount(0);
  }, []);

  const deleteMessage = useCallback(async (messageId: string) => {
    if (!workspaceId) return;
    try {
      const res = await deleteChatMessage(workspaceId, messageId);
      const dropped = new Set(res.deleted_ids);
      setMessages(prev => prev.filter(m => !dropped.has(m.id)));
    } catch (err) {
      console.error('Failed to delete chat message:', err);
      toast.error('Brisanje poruke nije uspjelo');
    }
  }, [workspaceId]);

  const rollbackFromMessage = useCallback(async (messageId: string) => {
    if (!workspaceId) return;
    try {
      const res = await rollbackChatMessages(workspaceId, messageId);
      const dropped = new Set(res.deleted_ids);
      setMessages(prev => prev.filter(m => !dropped.has(m.id)));
    } catch (err) {
      console.error('Failed to rollback chat:', err);
      toast.error('Vraćanje razgovora nije uspjelo');
    }
  }, [workspaceId]);

  const clearConversation = useCallback(async () => {
    if (!workspaceId) return;
    try {
      await clearChatMessages(workspaceId);
      setMessages([]);
    } catch (err) {
      console.error('Failed to clear conversation:', err);
      toast.error('Čišćenje razgovora nije uspjelo');
    }
  }, [workspaceId]);

  return {
    messages,
    members,
    typingUsers,
    access,
    isLoading,
    unreadCount,
    sendMessage,
    setTyping,
    markAsRead,
    deleteMessage,
    rollbackFromMessage,
    clearConversation
  };
}
