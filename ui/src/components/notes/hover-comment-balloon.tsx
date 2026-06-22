/**
 * Hover Comment Balloon - Simple comment thread on hover
 * Shows on hover over highlighted text with comments
 * Enter to send, @mentions supported, no send button
 */

import React, { useState, useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { Check, MoreVertical, Trash2, X } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import type { NoteComment } from '@/lib/api-notes';
import { formatDate, getInitials, getProfilePictureSources } from './utils/note-utils';

interface WorkspaceMember {
  id: string;
  username: string;
  email?: string;
  avatar_url?: string;
  role: 'owner' | 'editor' | 'viewer';
}

interface HoverCommentBalloonProps {
  comment: NoteComment;
  workspaceMembers: WorkspaceMember[];
  currentUserId: string;
  position: { top: number; left: number };
  onReply: (commentId: string, content: string) => Promise<void>;
  onResolve: (commentId: string) => Promise<void>;
  onDelete: (commentId: string) => Promise<void>;
  onClose: () => void;
  className?: string;
}

export const HoverCommentBalloon: React.FC<HoverCommentBalloonProps> = ({
  comment,
  workspaceMembers,
  currentUserId,
  position,
  onReply,
  onResolve,
  onDelete,
  onClose,
  className,
}) => {
  const { t } = useTranslation();
  const [replyContent, setReplyContent] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [showMentions, setShowMentions] = useState(false);
  const [mentionQuery, setMentionQuery] = useState('');
  const [cursorPosition, setCursorPosition] = useState(0);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const balloonRef = useRef<HTMLDivElement>(null);

  // Auto-focus input when replying
  useEffect(() => {
    if (inputRef.current) {
      inputRef.current.focus();
    }
  }, []);

  // Handle @-mention detection
  const handleInputChange = (value: string) => {
    setReplyContent(value);

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
    const textBeforeCursor = replyContent.substring(0, cursorPosition);
    const lastAtPos = textBeforeCursor.lastIndexOf('@');
    const beforeMention = replyContent.substring(0, lastAtPos);
    const afterMention = replyContent.substring(cursorPosition);
    const newValue = `${beforeMention}@${member.username} ${afterMention}`;
    setReplyContent(newValue);
    setShowMentions(false);
    inputRef.current?.focus();
  };

  // Handle Enter key to submit (without send button)
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

  // Submit reply
  const handleSubmit = async () => {
    if (!replyContent.trim() || isSubmitting) return;

    setIsSubmitting(true);
    try {
      await onReply(comment.id, replyContent);
      setReplyContent('');
    } catch (error) {
      console.error('[HoverCommentBalloon] Failed to submit reply:', error);
    } finally {
      setIsSubmitting(false);
    }
  };

  const canModify = comment.created_by === currentUserId;

  return (
    <div
      ref={balloonRef}
      data-testid="notes-hover-comment-balloon"
      className={cn(
        'fixed z-[9999] w-[320px] bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 rounded-lg shadow-2xl',
        'animate-in fade-in slide-in-from-top-2 duration-150',
        className
      )}
      style={{
        top: `${position.top}px`,
        left: `${position.left}px`,
      }}
    >
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-zinc-200 dark:border-zinc-700">
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium text-zinc-600 dark:text-zinc-400">
            {comment.replies && comment.replies.length > 0
              ? `${comment.replies.length + 1} comment${comment.replies.length > 0 ? 's' : ''}`
              : '1 comment'}
          </span>
          {comment.is_resolved && (
            <span className="px-2 py-0.5 bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400 text-xs rounded-full flex items-center gap-1">
              <Check className="h-3 w-3" />
              Resolved
            </span>
          )}
        </div>
        <div className="flex items-center gap-1">
          {!comment.is_resolved && (
            <Button
              variant="ghost"
              size="sm"
              data-testid="notes-hover-comment-resolve"
              onClick={() => onResolve(comment.id)}
              className="h-6 px-2 text-xs hover:bg-green-100 dark:hover:bg-green-900/30"
            >
              <Check className="h-3 w-3 mr-1" />
              Resolve
            </Button>
          )}
          {canModify && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" className="h-6 w-6">
                  <MoreVertical className="h-3 w-3" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem
                  onClick={() => onDelete(comment.id)}
                  className="text-red-600 dark:text-red-400"
                >
                  <Trash2 className="h-4 w-4 mr-2" />
                  Delete
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
          <Button data-testid="notes-hover-comment-close" variant="ghost" size="icon" className="h-6 w-6" onClick={onClose}>
            <X className="h-3 w-3" />
          </Button>
        </div>
      </div>

      {/* Main Comment */}
      <div className="px-3 py-2 border-b border-zinc-200 dark:border-zinc-700">
        <div className="flex items-start gap-2">
          <Avatar className="h-6 w-6 flex-shrink-0">
            {comment.created_by_avatar && (
              <AvatarImage {...getProfilePictureSources(comment.created_by_avatar)} />
            )}
            <AvatarFallback className="text-[10px]">
              {getInitials(comment.created_by_name || 'User')}
            </AvatarFallback>
          </Avatar>

          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-0.5">
              <span className="text-xs font-medium text-zinc-900 dark:text-white truncate">
                {comment.created_by_name || 'User'}
              </span>
              <span className="text-[10px] text-zinc-500 dark:text-zinc-400 whitespace-nowrap">
                {formatDate(comment.created_at)}
              </span>
            </div>

            {/* Comment content with @-mentions highlighted */}
            <div className="text-xs text-zinc-700 dark:text-zinc-300 break-words">
              {(comment.content || '').split(/(@\w+)/g).map((part, idx) =>
                part.startsWith('@') ? (
                  <span key={idx} className="text-blue-600 dark:text-blue-400 font-medium">
                    {part}
                  </span>
                ) : (
                  <span key={idx}>{part}</span>
                )
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Replies */}
      {comment.replies && comment.replies.length > 0 && (
        <div className="max-h-[180px] overflow-y-auto px-3 py-2 space-y-2 border-b border-zinc-200 dark:border-zinc-700">
          {comment.replies.map((reply) => (
            <div key={reply.id} className="flex items-start gap-2">
              <Avatar className="h-5 w-5 flex-shrink-0">
                <AvatarFallback className="text-[10px]">
                  {getInitials(reply.created_by_name || 'User')}
                </AvatarFallback>
              </Avatar>

              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-0.5">
                  <span className="text-[11px] font-medium text-zinc-900 dark:text-white truncate">
                    {reply.created_by_name || 'User'}
                  </span>
                  <span className="text-[10px] text-zinc-500 dark:text-zinc-400 whitespace-nowrap">
                    {formatDate(reply.created_at)}
                  </span>
                </div>

                <div className="text-[11px] text-zinc-700 dark:text-zinc-300 break-words">
                  {(reply.content || '').split(/(@\w+)/g).map((part, idx) =>
                    part.startsWith('@') ? (
                      <span key={idx} className="text-blue-600 dark:text-blue-400 font-medium">
                        {part}
                      </span>
                    ) : (
                      <span key={idx}>{part}</span>
                    )
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Reply Input - Simple, no send button */}
      <div className="px-3 py-2 relative">
        <textarea
          ref={inputRef}
          data-testid="notes-hover-comment-input"
          value={replyContent}
          onChange={(e) => handleInputChange(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={t('notes.comments.inputPlaceholder')}
          className="w-full px-2 py-1.5 text-xs bg-zinc-50 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded resize-none focus:outline-none focus:ring-2 focus:ring-blue-500 dark:focus:ring-blue-400"
          rows={2}
          disabled={isSubmitting}
        />

        {/* @-mention dropdown */}
        {showMentions && filteredMembers.length > 0 && (
          <div className="absolute bottom-full left-3 right-3 mb-1 bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-md shadow-lg max-h-32 overflow-y-auto z-50">
            {filteredMembers.map((member) => (
              <button
                key={member.id}
                onClick={() => insertMention(member)}
                className="w-full px-2 py-1.5 text-left hover:bg-zinc-100 dark:hover:bg-zinc-700 flex items-center gap-2 text-xs"
              >
                <Avatar className="h-4 w-4">
                  {member.avatar_url && (
                    <AvatarImage {...getProfilePictureSources(member.avatar_url)} />
                  )}
                  <AvatarFallback className="text-[8px]">
                    {getInitials(member.username)}
                  </AvatarFallback>
                </Avatar>
                <div className="flex-1 min-w-0">
                  <div className="font-medium truncate text-zinc-900 dark:text-white">
                    {member.username}
                  </div>
                  {member.email && (
                    <div className="text-[10px] text-zinc-500 dark:text-zinc-400 truncate">
                      {member.email}
                    </div>
                  )}
                </div>
              </button>
            ))}
          </div>
        )}

        <div className="mt-1 text-[10px] text-zinc-500 dark:text-zinc-400">
          Press Enter to send • Shift+Enter for new line
        </div>
      </div>
    </div>
  );
};
