/**
 * Simple Comment Input - Minimalist comment creation UI
 * Just a text input with Enter to send and @mentions
 * No send button, no quoted text, no file attachments
 */

import React, { useState, useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { getInitials, getProfilePictureSources } from './utils/note-utils';

interface WorkspaceMember {
  id: string;
  username: string;
  email?: string;
  avatar_url?: string;
  role: 'owner' | 'editor' | 'viewer';
}

interface SimpleCommentInputProps {
  currentUserId: string;
  currentUserName: string;
  currentUserAvatar?: string;
  workspaceMembers: WorkspaceMember[];
  position: { top: number; right: number };
  onSubmit: (content: string) => Promise<void>;
  onClose: () => void;
  className?: string;
}

export const SimpleCommentInput: React.FC<SimpleCommentInputProps> = ({
  currentUserId: _currentUserId,
  currentUserName,
  currentUserAvatar,
  workspaceMembers,
  position,
  onSubmit,
  onClose,
  className,
}) => {
  const { t } = useTranslation();
  const [content, setContent] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [showMentions, setShowMentions] = useState(false);
  const [mentionQuery, setMentionQuery] = useState('');
  const [cursorPosition, setCursorPosition] = useState(0);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Auto-focus input
  useEffect(() => {
    if (inputRef.current) {
      inputRef.current.focus();
    }
  }, []);

  // Handle @-mention detection
  const handleInputChange = (value: string) => {
    setContent(value);

    const cursorPos = inputRef.current?.selectionStart || 0;
    setCursorPosition(cursorPos);
    const textBeforeCursor = value.substring(0, cursorPos);
    const lastAtPos = textBeforeCursor.lastIndexOf('@');

    if (lastAtPos !== -1) {
      const textAfterAt = textBeforeCursor.substring(lastAtPos + 1);
      if (!/\s/.test(textAfterAt)) {
        setMentionQuery(textAfterAt.toLowerCase());
        setShowMentions(true);
      } else {
        setShowMentions(false);
      }
    } else {
      setShowMentions(false);
    }
  };

  // Filter workspace members based on mention query
  const filteredMembers = workspaceMembers.filter(
    (member) =>
      member.username.toLowerCase().includes(mentionQuery) ||
      member.email?.toLowerCase().includes(mentionQuery)
  );

  // Insert mention into reply
  const insertMention = (member: WorkspaceMember) => {
    const textBeforeCursor = content.substring(0, cursorPosition);
    const lastAtPos = textBeforeCursor.lastIndexOf('@');
    const beforeMention = content.substring(0, lastAtPos);
    const afterMention = content.substring(cursorPosition);
    const newValue = `${beforeMention}@${member.username} ${afterMention}`;
    setContent(newValue);
    setShowMentions(false);
    inputRef.current?.focus();
  };

  // Handle Enter key to submit
  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void handleSubmit();
    }

    // Arrow keys for mention selection
    if (showMentions && filteredMembers.length > 0) {
      if (e.key === 'Escape') {
        setShowMentions(false);
      }
    }
  };

  // Submit comment
  const handleSubmit = async () => {
    if (!content.trim() || isSubmitting) return;

    setIsSubmitting(true);
    try {
      await onSubmit(content);
      setContent('');
      onClose();
    } catch (error) {
      console.error('[SimpleCommentInput] Failed to submit comment:', error);
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div
      data-testid="notes-simple-comment-input"
      className={cn(
        'fixed z-[9999] w-[380px] bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 rounded-lg shadow-2xl',
        'animate-in fade-in slide-in-from-right-2 duration-150',
        className
      )}
      style={{
        top: `${position.top}px`,
        right: `${position.right}px`,
      }}
    >
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-zinc-200 dark:border-zinc-700">
        <div className="flex items-center gap-2">
          <Avatar className="h-6 w-6 flex-shrink-0">
            {currentUserAvatar && (
              <AvatarImage {...getProfilePictureSources(currentUserAvatar)} />
            )}
            <AvatarFallback className="text-[10px]">
              {getInitials(currentUserName)}
            </AvatarFallback>
          </Avatar>
          <span className="text-xs font-medium text-zinc-900 dark:text-white">
            Add a comment
          </span>
        </div>
        <Button data-testid="notes-simple-comment-close" variant="ghost" size="icon" className="h-6 w-6" onClick={onClose}>
          <X className="h-3 w-3" />
        </Button>
      </div>

      {/* Comment Input */}
      <div className="px-3 py-3 relative">
        <textarea
          ref={inputRef}
          data-testid="notes-simple-comment-textarea"
          value={content}
          onChange={(e) => handleInputChange(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={t('notes.comments.inputPlaceholder')}
          className="w-full px-3 py-2 text-sm bg-zinc-50 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-md resize-none focus:outline-none focus:ring-2 focus:ring-blue-500 dark:focus:ring-blue-400"
          rows={3}
          disabled={isSubmitting}
        />

        {/* @-mention dropdown */}
        {showMentions && filteredMembers.length > 0 && (
          <div className="absolute bottom-full left-3 right-3 mb-1 bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-md shadow-lg max-h-40 overflow-y-auto z-50">
            {filteredMembers.map((member) => (
              <button
                key={member.id}
                onClick={() => insertMention(member)}
                className="w-full px-3 py-2 text-left hover:bg-zinc-100 dark:hover:bg-zinc-700 flex items-center gap-2 text-sm"
              >
                <Avatar className="h-5 w-5">
                  {member.avatar_url && (
                    <AvatarImage {...getProfilePictureSources(member.avatar_url)} />
                  )}
                  <AvatarFallback className="text-[9px]">
                    {getInitials(member.username)}
                  </AvatarFallback>
                </Avatar>
                <div className="flex-1 min-w-0">
                  <div className="font-medium truncate text-zinc-900 dark:text-white">
                    {member.username}
                  </div>
                  {member.email && (
                    <div className="text-xs text-zinc-500 dark:text-zinc-400 truncate">
                      {member.email}
                    </div>
                  )}
                </div>
              </button>
            ))}
          </div>
        )}

        <div className="mt-2 text-xs text-zinc-500 dark:text-zinc-400">
          Press Enter to send • Shift+Enter for new line
        </div>
      </div>
    </div>
  );
};
