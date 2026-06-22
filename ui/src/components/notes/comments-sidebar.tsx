/**
 * Comments sidebar - manages inline comment balloons
 * Balloons appear next to highlighted text in the editor
 */

import React, { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from '@/lib/toast-compat';
import {
  listComments,
  createComment,
  deleteComment,
  toggleResolveComment,
  getWorkspaceMembers,
  type NoteComment,
  type CreateCommentRequest,
} from '@/lib/api-notes';
import { useAuth } from '@/hooks/use-auth';
import { authState } from '@/lib/api';
import { CommentBalloon } from './comment-balloon';

interface WorkspaceMember {
  id: string;
  username: string;
  email?: string;
  avatar_url?: string;
  role: 'owner' | 'editor' | 'viewer';
}

interface CommentsSidebarProps {
  noteId: string;
  workspaceId: string;
  selectedText?: {
    from: number;
    to: number;
    text: string;
  } | null;
  onCommentClick?: (commentId: string) => void;
  className?: string;
}

export const CommentsSidebar: React.FC<CommentsSidebarProps> = ({
  noteId,
  workspaceId,
  selectedText,
  onCommentClick: _onCommentClick,
  className: _className,
}) => {
  const { t } = useTranslation();
  const { user } = useAuth();
  const [comments, setComments] = useState<NoteComment[]>([]);
  const [workspaceMembers, setWorkspaceMembers] = useState<WorkspaceMember[]>([]);
  const [activeBalloon, setActiveBalloon] = useState<{
    comment: NoteComment | null;
    position: { top: number; right: number };
  } | null>(null);

  // Load comments from API
  const loadComments = useCallback(async () => {
    try {
      await authState.waitForAuthReady();
      const data = await listComments(noteId);

      const topLevelComments = data.filter(c => !c.parent_comment_id);
      const commentsWithReplies = topLevelComments.map(comment => ({
        ...comment,
        replies: data.filter(c => c.parent_comment_id === comment.id),
      }));

      setComments(commentsWithReplies);
    } catch (error) {
      console.error('[CommentsSidebar] Failed to load comments:', error);
      toast.error(t('notes.comments.loadFailed'));
    }
  }, [noteId, t]);

  // Load workspace members for @-mentions
  const loadWorkspaceMembers = useCallback(async () => {
    try {
      await authState.waitForAuthReady();
      const members = await getWorkspaceMembers(workspaceId);
      setWorkspaceMembers(members);
    } catch (error) {
      console.error('[CommentsSidebar] Failed to load workspace members:', error);
    }
  }, [workspaceId]);

  useEffect(() => {
    void loadComments();
    void loadWorkspaceMembers();
  }, [loadComments, loadWorkspaceMembers]);

  // Show balloon when text is selected
  useEffect(() => {
    if (selectedText && selectedText.text) {
      // Calculate position based on selection
      // This is a simplified version - you'd calculate actual editor position
      const position = {
        top: 100, // TODO: Calculate from editor selection
        right: 20,
      };

      // Create a new comment placeholder
      const newComment: NoteComment = {
        id: 'new',
        note_id: noteId,
        content: '',
        created_by: user?.id || '',
        created_by_name: user?.username || 'User',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        is_resolved: false,
        position: {
          from: selectedText.from,
          to: selectedText.to,
          text: selectedText.text,
        },
        replies: [],
      };

      setActiveBalloon({ comment: newComment, position });
    }
  }, [selectedText, noteId, user]);

  // Handle reply to comment
  const handleReply = async (commentId: string, content: string, files?: File[]) => {
    if (!content.trim() && (!files || files.length === 0)) {
      toast.error(t('notes.comments.enterComment'));
      return;
    }

    try {
      await authState.waitForAuthReady();

      const request: CreateCommentRequest = {
        content,
        parent_comment_id: commentId === 'new' ? undefined : commentId,
        position: commentId === 'new' && selectedText ? {
          from: selectedText.from,
          to: selectedText.to,
          text: selectedText.text,
        } : undefined,
      };

      await createComment(noteId, request);

      if (files && files.length > 0) {
        console.warn('[CommentsSidebar] File upload not yet implemented:', files);
        toast.warning(t('notes.comments.addedNoUpload'));
      } else {
        toast.success(t('notes.comments.added'));
      }

      setActiveBalloon(null);
      await loadComments();
    } catch (error) {
      console.error('[CommentsSidebar] Failed to create comment:', error);
      toast.error(t('notes.comments.addFailed'));
    }
  };

  // Handle resolve comment
  const handleResolve = async (commentId: string) => {
    if (commentId === 'new') {
      toast.error(t('notes.comments.cannotResolveUnsaved'));
      return;
    }

    try {
      await authState.waitForAuthReady();
      const result = await toggleResolveComment(noteId, commentId);

      setComments(
        comments.map((c) =>
          c.id === commentId
            ? {
                ...c,
                is_resolved: result.is_resolved,
                resolved_by: result.resolved_by,
                resolved_at: result.resolved_at,
              }
            : c
        )
      );

      toast.success(result.message);
      setActiveBalloon(null);
    } catch (error) {
      console.error('[CommentsSidebar] Failed to resolve comment:', error);
      toast.error(t('notes.comments.resolveFailed'));
    }
  };

  // Handle delete comment
  const handleDelete = async (commentId: string) => {
    if (commentId === 'new') {
      setActiveBalloon(null);
      return;
    }

    if (!confirm(t('notes.comments.deleteConfirm'))) {
      return;
    }

    try {
      await authState.waitForAuthReady();
      await deleteComment(noteId, commentId);

      setComments(comments.filter((c) => c.id !== commentId));
      toast.success(t('notes.comments.deleted'));
      setActiveBalloon(null);
      await loadComments();
    } catch (error) {
      console.error('[CommentsSidebar] Failed to delete comment:', error);
      toast.error(t('notes.comments.deleteFailed'));
    }
  };

  // Handle close balloon
  const handleClose = () => {
    setActiveBalloon(null);
  };

  return (
    <>
      {/* Active comment balloon */}
      {activeBalloon && activeBalloon.comment && (
        <CommentBalloon
          comment={activeBalloon.comment}
          workspaceMembers={workspaceMembers}
          currentUserId={user?.id || ''}
          position={activeBalloon.position}
          onReply={handleReply}
          onResolve={handleResolve}
          onDelete={handleDelete}
          onClose={handleClose}
        />
      )}
    </>
  );
};
