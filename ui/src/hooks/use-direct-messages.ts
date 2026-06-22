import { useState, useRef, useCallback, useEffect } from 'react';
import backendStompService from '@/lib/stomp-backend-service';
import {
  getConversations,
  getMessages,
  markConversationRead,
  type DirectConversationResponse,
  type DirectMessageResponse,
} from '@/lib/api-direct-messages';

interface UseDirectMessagesOptions {
  userId?: string;
  workspaceId?: string;
}

interface TypingState {
  userId: string;
  username: string;
}

export function useDirectMessages({ userId, workspaceId }: UseDirectMessagesOptions) {
  const [conversations, setConversations] = useState<DirectConversationResponse[]>([]);
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null);
  const [messages, setMessages] = useState<DirectMessageResponse[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [typingUser, setTypingUser] = useState<TypingState | null>(null);
  const [totalUnread, setTotalUnread] = useState(0);

  const unsubRef = useRef<(() => void) | null>(null);
  const typingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Load conversations
  const loadConversations = useCallback(async () => {
    if (!userId) return;
    try {
      const data = await getConversations(workspaceId);
      setConversations(data);
      setTotalUnread(data.reduce((sum, c) => sum + c.unread_count, 0));
    } catch (err) {
      console.error('[DM] Failed to load conversations:', err);
    }
  }, [userId, workspaceId]);

  // Load messages for active conversation
  const loadMessages = useCallback(async (conversationId: string) => {
    setIsLoading(true);
    try {
      const data = await getMessages(conversationId);
      setMessages(data);
      await markConversationRead(conversationId);
      // Update unread count locally
      setConversations(prev =>
        prev.map(c => c.id === conversationId ? { ...c, unread_count: 0 } : c)
      );
    } catch (err) {
      console.error('[DM] Failed to load messages:', err);
    } finally {
      setIsLoading(false);
    }
  }, []);

  // Open a conversation
  const openConversation = useCallback(async (conversationId: string) => {
    setActiveConversationId(conversationId);
    await loadMessages(conversationId);
  }, [loadMessages]);

  // Send a message
  const sendMessage = useCallback(async (recipientId: string, content: string) => {
    if (!workspaceId || !content.trim()) return;
    try {
      await backendStompService.send('/app/dm.send', {
        recipient_id: recipientId,
        workspace_id: workspaceId,
        content: content.trim(),
      });
    } catch (err) {
      console.error('[DM] Failed to send message:', err);
    }
  }, [workspaceId]);

  // Send typing indicator
  const sendTyping = useCallback((conversationId: string, isTyping: boolean) => {
    backendStompService.send('/app/dm.typing', {
      conversation_id: conversationId,
      is_typing: String(isTyping),
    }).catch(() => {});
  }, []);

  // Mark conversation as read via STOMP
  const sendRead = useCallback((conversationId: string) => {
    backendStompService.send('/app/dm.read', {
      conversation_id: conversationId,
    }).catch(() => {});
  }, []);

  // Subscribe to DM queue
  useEffect(() => {
    if (!userId) return;

    const setup = async () => {
      unsubRef.current = await backendStompService.subscribe(
        '/user/queue/dm',
        (data) => {
          const payload = data as {
            type?: string;
            conversation_id?: string;
            message?: DirectMessageResponse;
            user_id?: string;
            username?: string;
            is_typing?: boolean;
          };

          switch (payload.type) {
            case 'message': {
              if (payload.message) {
                // If this conversation is active, append message
                if (payload.conversation_id === activeConversationId) {
                  setMessages(prev => [...prev, payload.message!]);
                  // Auto-mark as read
                  sendRead(payload.conversation_id!);
                }
                // Refresh conversation list
                loadConversations();
              }
              break;
            }
            case 'typing': {
              if (payload.conversation_id === activeConversationId && payload.user_id !== userId) {
                if (payload.is_typing) {
                  setTypingUser({ userId: payload.user_id!, username: payload.username || '' });
                  // Auto-clear typing after 3s
                  if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current);
                  typingTimeoutRef.current = setTimeout(() => setTypingUser(null), 3000);
                } else {
                  setTypingUser(null);
                }
              }
              break;
            }
            case 'read': {
              // Other user read our messages — update read_at on visible messages
              if (payload.conversation_id === activeConversationId) {
                const now = new Date().toISOString();
                setMessages(prev =>
                  prev.map(m =>
                    m.sender_id === userId && !m.read_at
                      ? { ...m, read_at: now }
                      : m
                  )
                );
              }
              break;
            }
          }
        }
      );
    };

    void setup();

    return () => {
      unsubRef.current?.();
      unsubRef.current = null;
      if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId, activeConversationId]);

  // Load conversations on mount
  useEffect(() => {
    void loadConversations();
  }, [loadConversations]);

  return {
    conversations,
    activeConversationId,
    messages,
    isLoading,
    typingUser,
    totalUnread,
    openConversation,
    sendMessage,
    sendTyping,
    sendRead,
    loadConversations,
    setActiveConversationId,
  };
}
