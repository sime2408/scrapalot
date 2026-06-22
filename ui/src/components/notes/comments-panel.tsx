/**
 * Comments panel for collaborative note editing
 */

import React, { useState, useEffect, useCallback } from 'react';
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
  Reply,
} from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { toast } from '@/lib/toast-compat';
import { cn } from '@/lib/utils';
import { formatDate, getInitials } from './utils/note-utils';

interface Comment {
  id: string;
  note_id: string;
  content: string;
  created_by: string;
  created_by_name?: string;
  created_at: string;
  updated_at: string;
  is_resolved: boolean;
  parent_comment_id?: string;
  replies?: Comment[];
}

interface CommentsPanelProps {
  noteId: string;
  userId: string;
  userName: string;
  className?: string;
}

export const CommentsPanel: React.FC<CommentsPanelProps> = ({
  noteId,
  userId,
  userName,
  className,
}) => {
  const { t } = useTranslation();
  const [comments, setComments] = useState<Comment[]>([]);
  const [newComment, setNewComment] = useState('');
  const [replyingTo, setReplyingTo] = useState<string | null>(null);
  const [replyContent, setReplyContent] = useState('');
  const [isLoading, setIsLoading] = useState(false);

  const loadComments = useCallback(async () => {
    // TODO: Implement API call to load comments
    // For now, using mock data
    setComments([]);
  }, []);

  useEffect(() => {
    void loadComments();
  }, [loadComments]);

  const handleAddComment = async () => {
    if (!newComment.trim()) return;

    setIsLoading(true);
    try {
      // TODO: Implement API call to add comment
      const comment: Comment = {
        id: Date.now().toString(),
        note_id: noteId,
        content: newComment,
        created_by: userId,
        created_by_name: userName,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        is_resolved: false,
      };

      setComments([...comments, comment]);
      setNewComment('');
      toast.success(t('notes.comments.added'));
    } catch (error) {
      toast.error(t('notes.comments.addFailed'));
    } finally {
      setIsLoading(false);
    }
  };

  const handleReply = async (parentId: string) => {
    if (!replyContent.trim()) return;

    setIsLoading(true);
    try {
      // TODO: Implement API call to add reply
      const reply: Comment = {
        id: Date.now().toString(),
        note_id: noteId,
        content: replyContent,
        created_by: userId,
        created_by_name: userName,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        is_resolved: false,
        parent_comment_id: parentId,
      };

      // Add reply to parent comment
      setComments(
        comments.map((c) =>
          c.id === parentId
            ? { ...c, replies: [...(c.replies || []), reply] }
            : c
        )
      );

      setReplyContent('');
      setReplyingTo(null);
      toast.success(t('notes.comments.replyAdded'));
    } catch (error) {
      toast.error(t('notes.comments.replyFailed'));
    } finally {
      setIsLoading(false);
    }
  };

  const handleResolve = async (commentId: string) => {
    try {
      // TODO: Implement API call to resolve comment
      setComments(
        comments.map((c) =>
          c.id === commentId ? { ...c, is_resolved: !c.is_resolved } : c
        )
      );
      toast.success(t('notes.comments.resolved'));
    } catch (error) {
      toast.error(t('notes.comments.resolveFailed'));
    }
  };

  const handleDelete = async (commentId: string) => {
    if (!confirm(t('notes.comments.deleteConfirm'))) return;

    try {
      // TODO: Implement API call to delete comment
      setComments(comments.filter((c) => c.id !== commentId));
      toast.success(t('notes.comments.deleted'));
    } catch (error) {
      toast.error(t('notes.comments.deleteFailed'));
    }
  };

  const CommentItem = ({ comment, isReply = false }: { comment: Comment; isReply?: boolean }) => (
    <div
      className={cn(
        'p-3 rounded-lg',
        isReply ? 'ml-8 bg-muted/30' : 'bg-muted/50',
        comment.is_resolved && 'opacity-60'
      )}
    >
      <div className="flex items-start gap-3">
        <Avatar className="h-8 w-8">
          <AvatarFallback className="text-xs">
            {getInitials(comment.created_by_name || 'User')}
          </AvatarFallback>
        </Avatar>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <span className="text-sm font-medium">
              {comment.created_by_name || 'User'}
            </span>
            <span className="text-xs text-muted-foreground">
              {formatDate(comment.created_at)}
            </span>
            {comment.is_resolved && (
              <Badge variant="secondary" className="text-xs">
                <Check className="h-3 w-3 mr-1" />
                Resolved
              </Badge>
            )}
          </div>

          <p className="text-sm whitespace-pre-wrap">{comment.content}</p>

          <div className="flex items-center gap-2 mt-2">
            {!isReply && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setReplyingTo(comment.id)}
                className="h-7 text-xs"
              >
                <Reply className="h-3 w-3 mr-1" />
                Reply
              </Button>
            )}

            {comment.created_by === userId && (
              <>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => handleResolve(comment.id)}
                  className="h-7 text-xs"
                >
                  <Check className="h-3 w-3 mr-1" />
                  {comment.is_resolved ? 'Unresolve' : 'Resolve'}
                </Button>

                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="ghost" size="icon" className="h-7 w-7">
                      <MoreVertical className="h-3 w-3" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onClick={() => handleDelete(comment.id)}>
                      <Trash2 className="h-4 w-4 mr-2" />
                      Delete
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </>
            )}
          </div>

          {/* Reply Input */}
          {replyingTo === comment.id && (
            <div className="mt-3 space-y-2">
              <Textarea
                value={replyContent}
                onChange={(e) => setReplyContent(e.target.value)}
                placeholder={t('notes.comments.replyPlaceholder')}
                className="min-h-[60px]"
              />
              <div className="flex gap-2">
                <Button
                  size="sm"
                  onClick={() => handleReply(comment.id)}
                  disabled={isLoading || !replyContent.trim()}
                >
                  <Send className="h-3 w-3 mr-1" />
                  Reply
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setReplyingTo(null);
                    setReplyContent('');
                  }}
                >
                  Cancel
                </Button>
              </div>
            </div>
          )}

          {/* Replies */}
          {comment.replies && comment.replies.length > 0 && (
            <div className="mt-3 space-y-2">
              {comment.replies.map((reply) => (
                <CommentItem key={reply.id} comment={reply} isReply />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );

  return (
    <div data-testid="notes-comments-panel" className={cn('flex flex-col h-full bg-card border-l', className)}>
      {/* Header */}
      <div className="p-4 border-b">
        <div className="flex items-center gap-2">
          <MessageSquare className="h-5 w-5" />
          <h3 className="font-semibold">Comments</h3>
          {comments.length > 0 && (
            <Badge variant="secondary">{comments.length}</Badge>
          )}
        </div>
      </div>

      {/* Comments List */}
      <ScrollArea className="flex-1 p-4">
        {comments.length === 0 ? (
          <div className="text-center text-muted-foreground py-8">
            <MessageSquare className="h-12 w-12 mx-auto mb-2 opacity-50" />
            <p className="text-sm">No comments yet</p>
            <p className="text-xs">Start a discussion about this note</p>
          </div>
        ) : (
          <div className="space-y-3">
            {comments.map((comment) => (
              <CommentItem key={comment.id} comment={comment} />
            ))}
          </div>
        )}
      </ScrollArea>

      {/* New Comment Input */}
      <div className="p-4 border-t">
        <div className="space-y-2">
          <Textarea
            data-testid="notes-comment-input"
            value={newComment}
            onChange={(e) => setNewComment(e.target.value)}
            placeholder={t('notes.comments.commentPlaceholder')}
            className="min-h-[80px]"
          />
          <Button
            data-testid="notes-comment-submit-button"
            onClick={handleAddComment}
            disabled={isLoading || !newComment.trim()}
            className="w-full"
          >
            <Send className="h-4 w-4 mr-2" />
            Add Comment
          </Button>
        </div>
      </div>
    </div>
  );
};
