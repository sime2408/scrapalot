import { useState, useEffect, useRef } from 'react';
import { WebsocketProvider } from 'y-websocket';

interface TypingUser {
  name: string;
  id: string;
}

export const useTypingIndicator = (provider: WebsocketProvider | null, currentUserId: string) => {
  const [typingUsers, setTypingUsers] = useState<Map<string, TypingUser>>(new Map());
  const typingTimeoutRef = useRef<Map<string, NodeJS.Timeout>>(new Map());
  const isTypingRef = useRef(false);

  // Broadcast typing state
  const setTyping = (isTyping: boolean, userName: string) => {
    if (!provider) return;

    if (isTyping && !isTypingRef.current) {
      provider.awareness.setLocalStateField('typing', {
        isTyping: true,
        timestamp: Date.now(),
        userId: currentUserId,
        userName,
      });
      isTypingRef.current = true;
    } else if (!isTyping && isTypingRef.current) {
      provider.awareness.setLocalStateField('typing', {
        isTyping: false,
        timestamp: Date.now(),
        userId: currentUserId,
        userName,
      });
      isTypingRef.current = false;
    }
  };

  // Listen for typing state changes from other users
  useEffect(() => {
    if (!provider) return;

    const handleAwarenessChange = () => {
      const newTypingUsers = new Map<string, TypingUser>();
      
      provider.awareness.getStates().forEach((state, _clientId) => {
        if (state && state.typing && state.user) {
          const { isTyping, userId, userName, timestamp } = state.typing;
          
          // Ignore self and old typing states (older than 10 seconds)
          if (userId !== currentUserId && isTyping && timestamp > Date.now() - 10000) {
            newTypingUsers.set(userId, {
              id: userId,
              name: userName || state.user.name || 'Anonymous',
            });

            // Clear existing timeout for this user
            if (typingTimeoutRef.current.has(userId)) {
              clearTimeout(typingTimeoutRef.current.get(userId));
            }

            // Set timeout to auto-remove typing indicator after 3 seconds
            const timeout = setTimeout(() => {
              setTypingUsers(prev => {
                const updated = new Map(prev);
                updated.delete(userId);
                return updated;
              });
              typingTimeoutRef.current.delete(userId);
            }, 3000);

            typingTimeoutRef.current.set(userId, timeout);
          }
        }
      });

      setTypingUsers(newTypingUsers);
    };

    provider.awareness.on('change', handleAwarenessChange);

    return () => {
      provider.awareness.off('change', handleAwarenessChange);
      
      // Clear all timeouts
      typingTimeoutRef.current.forEach(timeout => clearTimeout(timeout));
      // eslint-disable-next-line react-hooks/exhaustive-deps -- deps are intentionally limited
      typingTimeoutRef.current.clear();
    };
  }, [provider, currentUserId]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      // eslint-disable-next-line react-hooks/exhaustive-deps -- deps are intentionally limited
      typingTimeoutRef.current.forEach(timeout => clearTimeout(timeout));
    };
  }, []);

  return {
    typingUsers,
    setTyping,
  };
};