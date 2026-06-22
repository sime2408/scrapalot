/**
 * Comment Balloon - Google Docs-style comment thread balloon
 * Appears next to highlighted text when clicked
 */

import React, { useState, useRef, useEffect, KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  MessageSquare,
  Send,
  Check,
  MoreVertical,
  Trash2,
  X,
  Paperclip,
  AtSign,
} from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import type { NoteComment } from '@/lib/api-notes';
import { formatDate, getInitials } from './utils/note-utils';

interface WorkspaceMember {
  id: string;
  username: string;
  email?: string;
  avatar_url?: string;
  role: 'owner' | 'editor' | 'viewer';
}

interface CommentBalloonProps {
  comment: NoteComment;
  workspaceMembers: WorkspaceMember[];
  currentUserId: string;
  position: { top: number; right: number };
  onReply: (commentId: string, content: string, files?: File[]) => Promise<void>;
  onResolve: (commentId: string) => Promise<void>;
  onDelete: (commentId: string) => Promise<void>;
  onClose: () => void;
  className?: string;
}

export const CommentBalloon: React.FC<CommentBalloonProps> = ({
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
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const balloonRef = useRef<HTMLDivElement>(null);

  // Auto-focus textarea on mount
  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  // Handle @-mention detection
  const handleReplyChange = (value: string) => {
    setReplyContent(value);

    const cursorPos = textareaRef.current?.selectionStart || 0;
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
  const filteredMembers = workspaceMembers.filter(member =>
    member.username.toLowerCase().includes(mentionQuery) ||
    member.email?.toLowerCase().includes(mentionQuery)
  );

  // Insert mention into reply
  const insertMention = (member: WorkspaceMember) => {
    const cursorPos = textareaRef.current?.selectionStart || replyContent.length;
    const textBeforeCursor = replyContent.substring(0, cursorPos);
    const lastAtPos = textBeforeCursor.lastIndexOf('@');
    const beforeMention = replyContent.substring(0, lastAtPos);
    const afterMention = replyContent.substring(cursorPos);
    const newValue = `${beforeMention}@${member.username} ${afterMention}`;
    setReplyContent(newValue);
    setShowMentions(false);
    textareaRef.current?.focus();
  };

  // Handle file selection
  const handleFileSelect = (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files || []);
    setSelectedFiles(prev => [...prev, ...files]);
  };

  // Remove selected file
  const removeFile = (index: number) => {
    setSelectedFiles(prev => prev.filter((_, i) => i !== index));
  };

  // Handle Enter key to submit (Shift+Enter for new line)
  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void handleSubmit();
    }
  };

  // Submit reply
  const handleSubmit = async () => {
    if (!replyContent.trim() && selectedFiles.length === 0) return;

    setIsSubmitting(true);
    try {
      await onReply(comment.id, replyContent, selectedFiles);
      setReplyContent('');
      setSelectedFiles([]);
    } catch (error) {
      console.error('[CommentBalloon] Failed to submit reply:', error);
    } finally {
      setIsSubmitting(false);
    }
  };

  const canModify = comment.created_by === currentUserId;

  return (
    <div
      ref={balloonRef}
      data-testid="notes-comment-balloon"
      className={cn(
        'absolute z-50 w-[340px] bg-card/95 backdrop-blur-sm border rounded-lg shadow-xl',
        'animate-in fade-in slide-in-from-right-2 duration-150',
        className
      )}
      style={{
        top: `${position.top}px`,
        right: `${position.right}px`,
      }}
    >
      {/* Header */}
      <div className="flex items-center justify-between p-3 border-b" data-testid="notes-comment-balloon-header">
        <div className="flex items-center gap-2">
          <MessageSquare className="h-4 w-4" />
          <span className="text-sm font-medium">Comment</span>
          {comment.is_resolved && (
            <Badge variant="secondary" className="text-xs">
              <Check className="h-3 w-3 mr-1" />
              Resolved
            </Badge>
          )}
        </div>
        <Button data-testid="notes-comment-balloon-close" variant="ghost" size="icon" className="h-6 w-6" onClick={onClose}>
          <X className="h-3 w-3" />
        </Button>
      </div>

      {/* Main Comment */}
      <div className="p-3 border-b">
        <div className="flex items-start gap-2">
          <Avatar className="h-7 w-7 flex-shrink-0">
            <AvatarFallback className="text-xs">
              {getInitials(comment.created_by_name || 'User')}
            </AvatarFallback>
          </Avatar>

          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-1">
              <span className="text-sm font-medium truncate">
                {comment.created_by_name || 'User'}
              </span>
              <span className="text-xs text-muted-foreground whitespace-nowrap">
                {formatDate(comment.created_at)}
              </span>
            </div>

            {/* Comment content with @-mentions highlighted */}
            <div className="text-sm break-words">
              {(comment.content || '').split(/(@\w+)/g).map((part, idx) =>
                part.startsWith('@') ? (
                  <span key={idx} className="text-primary font-medium">
                    {part}
                  </span>
                ) : (
                  <span key={idx}>{part}</span>
                )
              )}
            </div>

            {/* Selected text context */}
            {comment.position && comment.position.text && (
              <div className="mt-2 p-2 bg-muted rounded text-xs italic border-l-2 border-primary">
                "{comment.position.text}"
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Replies */}
      {comment.replies && comment.replies.length > 0 && (
        <ScrollArea className="max-h-[200px]">
          <div className="p-3 space-y-3 border-b">
            {comment.replies.map((reply) => (
              <div key={reply.id} className="flex items-start gap-2">
                <Avatar className="h-6 w-6 flex-shrink-0">
                  <AvatarFallback className="text-xs">
                    {getInitials(reply.created_by_name || 'User')}
                  </AvatarFallback>
                </Avatar>

                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-xs font-medium truncate">
                      {reply.created_by_name || 'User'}
                    </span>
                    <span className="text-xs text-muted-foreground whitespace-nowrap">
                      {formatDate(reply.created_at)}
                    </span>
                  </div>

                  <div className="text-xs break-words">
                    {(reply.content || '').split(/(@\w+)/g).map((part, idx) =>
                      part.startsWith('@') ? (
                        <span key={idx} className="text-primary font-medium">
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
        </ScrollArea>
      )}

      {/* Reply Input */}
      <div className="p-3 space-y-2">
        <div className="relative">
          <Textarea
            ref={textareaRef}
            data-testid="notes-comment-balloon-reply-input"
            value={replyContent}
            onChange={(e) => handleReplyChange(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={t('notes.comments.replyInputPlaceholder')}
            className="min-h-[60px] text-sm resize-none pr-20"
            disabled={isSubmitting}
          />

          {/* @-mention dropdown */}
          {showMentions && filteredMembers.length > 0 && (
            <div className="absolute bottom-full left-0 right-0 mb-1 bg-popover border rounded-md shadow-lg max-h-32 overflow-y-auto z-50">
              {filteredMembers.map((member) => (
                <button
                  key={member.id}
                  onClick={() => insertMention(member)}
                  className="w-full px-2 py-1.5 text-left hover:bg-muted flex items-center gap-2 text-xs"
                >
                  <Avatar className="h-5 w-5">
                    <AvatarFallback className="text-xs">
                      {getInitials(member.username)}
                    </AvatarFallback>
                  </Avatar>
                  <div className="flex-1 min-w-0">
                    <div className="font-medium truncate">{member.username}</div>
                    {member.email && (
                      <div className="text-muted-foreground truncate">{member.email}</div>
                    )}
                  </div>
                </button>
              ))}
            </div>
          )}

          {/* Action buttons in textarea */}
          <div className="absolute bottom-2 right-2 flex items-center gap-1">
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6"
              onClick={() => fileInputRef.current?.click()}
              title="Attach file"
            >
              <Paperclip className="h-3 w-3" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6"
              onClick={() => {
                const cursorPos = textareaRef.current?.selectionStart || replyContent.length;
                const newContent = replyContent.substring(0, cursorPos) + '@' + replyContent.substring(cursorPos);
                setReplyContent(newContent);
                textareaRef.current?.focus();
              }}
              title="Mention someone"
            >
              <AtSign className="h-3 w-3" />
            </Button>
          </div>
        </div>

        {/* File attachments */}
        {selectedFiles.length > 0 && (
          <div className="space-y-1">
            {selectedFiles.map((file, index) => (
              <div key={index} className="flex items-center gap-2 text-xs p-1.5 bg-muted rounded">
                <Paperclip className="h-3 w-3" />
                <span className="flex-1 truncate">{file.name}</span>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-4 w-4"
                  onClick={() => removeFile(index)}
                >
                  <X className="h-3 w-3" />
                </Button>
              </div>
            ))}
          </div>
        )}

        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="hidden"
          onChange={handleFileSelect}
        />

        {/* Action buttons */}
        <div className="flex items-center justify-between">
          <div className="flex gap-1">
            <Button
              variant="ghost"
              size="sm"
              data-testid="notes-comment-balloon-resolve"
              onClick={() => onResolve(comment.id)}
              className="h-7 text-xs"
            >
              <Check className="h-3 w-3 mr-1" />
              {comment.is_resolved ? 'Unresolve' : 'Resolve'}
            </Button>

            {canModify && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="icon" className="h-7 w-7">
                    <MoreVertical className="h-3 w-3" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onClick={() => onDelete(comment.id)}>
                    <Trash2 className="h-4 w-4 mr-2" />
                    Delete
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>

          <Button
            size="sm"
            data-testid="notes-comment-balloon-send"
            onClick={handleSubmit}
            disabled={isSubmitting || (!replyContent.trim() && selectedFiles.length === 0)}
            className="h-7 text-xs"
          >
            <Send className="h-3 w-3 mr-1" />
            Send
          </Button>
        </div>
      </div>
    </div>
  );
};
