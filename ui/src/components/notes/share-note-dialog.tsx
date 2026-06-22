/**
 * Share note dialog component
 * Similar to knowledge-stacks-dialog.tsx sharing pattern
 */

import React, { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { Shield, Eye, Crown, Users, X, Loader2 } from 'lucide-react';
import { shareNote, getNoteShares, removeNoteShare } from '@/lib/api-notes';
import { toast } from '@/lib/toast-compat';

interface ShareNoteDialogProps {
  noteId: string;
  noteTitle: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

interface ShareUser {
  id: string;
  email: string;
  name?: string;
  role: 'owner' | 'editor' | 'viewer';
}

export const ShareNoteDialog: React.FC<ShareNoteDialogProps> = ({
  noteId,
  noteTitle,
  open,
  onOpenChange,
}) => {
  const { t } = useTranslation();
  const [shareEmail, setShareEmail] = useState('');
  const [shareRole, setShareRole] = useState<'editor' | 'viewer'>('editor');
  const [sharedUsers, setSharedUsers] = useState<ShareUser[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isSharing, setIsSharing] = useState(false);

  const loadSharedUsers = useCallback(async () => {
    setIsLoading(true);
    try {
      const shares = await getNoteShares(noteId);
      // Transform shares to user format
      const users: ShareUser[] = shares.map((share) => ({
        id: share.user_id || 'workspace',
        email: share.user_id || 'All workspace members',
        role: share.role as 'owner' | 'editor' | 'viewer',
      }));
      setSharedUsers(users);
    } catch (error) {
      console.error('Failed to load shares:', error);
      toast.error(t('notes.share.loadFailed'));
    } finally {
      setIsLoading(false);
    }
  }, [noteId, t]);

  useEffect(() => {
    if (open) {
      void loadSharedUsers();
    }
  }, [open, loadSharedUsers]);

  const handleShare = async () => {
    if (!shareEmail.trim()) {
      toast.error(t('notes.share.enterEmail'));
      return;
    }

    // Basic email validation
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(shareEmail)) {
      toast.error(t('notes.share.invalidEmail'));
      return;
    }

    setIsSharing(true);
    try {
      await shareNote(noteId, {
        email: shareEmail,
        role: shareRole,
      });

      toast.success(t('notes.share.success', { email: shareEmail }));
      setShareEmail('');
      void loadSharedUsers();
    } catch (error: unknown) {
      const axiosErr = error as { response?: { data?: { detail?: string } } };
      toast.error(axiosErr.response?.data?.detail || t('notes.share.shareFailed'));
    } finally {
      setIsSharing(false);
    }
  };

  const handleRemoveShare = async (userId: string, userEmail: string) => {
    if (!confirm(t('notes.share.removeConfirm', { email: userEmail }))) return;

    try {
      await removeNoteShare(noteId, userId);
      toast.success(t('notes.share.accessRemoved'));
      void loadSharedUsers();
    } catch (error: unknown) {
      const axiosErr = error as { response?: { data?: { detail?: string } } };
      toast.error(axiosErr.response?.data?.detail || t('notes.share.removeFailed'));
    }
  };

  const getRoleIcon = (role: string) => {
    switch (role) {
      case 'owner':
        return <Crown className="h-4 w-4 text-yellow-500" />;
      case 'editor':
        return <Shield className="h-4 w-4 text-blue-500" />;
      case 'viewer':
        return <Eye className="h-4 w-4 text-gray-500" />;
      default:
        return null;
    }
  };

  const getRoleLabel = (role: string) => {
    switch (role) {
      case 'owner':
        return 'Owner';
      case 'editor':
        return 'Can edit';
      case 'viewer':
        return 'Can view';
      default:
        return role;
    }
  };

  const getInitials = (email: string) => {
    if (email === 'All workspace members') return 'WS';
    return email
      .split('@')[0]
      .split('.')
      .map((part) => part[0])
      .join('')
      .toUpperCase()
      .slice(0, 2);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="notes-share-note-dialog" className="max-w-md" dialogOpen={open} onOpenChange={onOpenChange}>
        <DialogHeader>
          <DialogTitle>Share Note</DialogTitle>
          <DialogDescription>
            Share "{noteTitle || 'Untitled'}" with others
          </DialogDescription>
        </DialogHeader>

        {/* Share Input */}
        <div className="space-y-4">
          <div className="flex gap-2">
            <Input
              data-testid="notes-share-note-email-input"
              placeholder={t('notes.share.emailPlaceholder')}
              value={shareEmail}
              onChange={(e) => setShareEmail(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  void handleShare();
                }
              }}
              disabled={isSharing}
            />
            <Select
              value={shareRole}
              onValueChange={(value) => setShareRole(value as 'editor' | 'viewer')}
              disabled={isSharing}
            >
              <SelectTrigger data-testid="notes-share-note-role-select" className="w-32">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="editor">
                  <div className="flex items-center gap-2">
                    <Shield className="h-4 w-4" />
                    Editor
                  </div>
                </SelectItem>
                <SelectItem value="viewer">
                  <div className="flex items-center gap-2">
                    <Eye className="h-4 w-4" />
                    Viewer
                  </div>
                </SelectItem>
              </SelectContent>
            </Select>
            <Button data-testid="notes-share-note-submit-button" onClick={handleShare} disabled={isSharing}>
              {isSharing ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                'Share'
              )}
            </Button>
          </div>

          {/* Role Descriptions */}
          <div className="text-xs text-muted-foreground space-y-1">
            <p>
              <strong>Editor:</strong> Can view and edit the note
            </p>
            <p>
              <strong>Viewer:</strong> Can only view the note
            </p>
          </div>
        </div>

        <Separator />

        {/* Workspace Sharing Option */}
        <div className="border rounded-lg p-3 bg-muted/50">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Users className="h-4 w-4 text-muted-foreground" />
              <div>
                <p className="text-sm font-medium">Share with workspace</p>
                <p className="text-xs text-muted-foreground">
                  All workspace members will have access
                </p>
              </div>
            </div>
            <Button variant="outline" size="sm" disabled>
              Coming Soon
            </Button>
          </div>
        </div>

        <Separator />

        {/* Shared Users List */}
        <div>
          <h4 className="font-medium mb-3 text-sm">Who has access</h4>

          {isLoading ? (
            <div className="flex items-center justify-center py-4">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : sharedUsers.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-4">
              No one else has access yet
            </p>
          ) : (
            <div className="space-y-2 max-h-64 overflow-y-auto">
              {sharedUsers.map((user) => (
                <div
                  key={user.id}
                  data-testid={`notes-share-user-${user.id}`}
                  className="flex items-center justify-between p-2 rounded-md hover:bg-muted/50"
                >
                  <div className="flex items-center gap-3 flex-1 min-w-0">
                    <Avatar className="h-8 w-8">
                      <AvatarFallback className="text-xs">
                        {getInitials(user.email)}
                      </AvatarFallback>
                    </Avatar>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium truncate">
                        {user.email}
                      </p>
                      {user.name && (
                        <p className="text-xs text-muted-foreground truncate">
                          {user.name}
                        </p>
                      )}
                    </div>
                  </div>

                  <div className="flex items-center gap-2">
                    <Badge
                      variant={user.role === 'owner' ? 'default' : 'secondary'}
                      className="text-xs"
                    >
                      <span className="mr-1">{getRoleIcon(user.role)}</span>
                      {getRoleLabel(user.role)}
                    </Badge>

                    {user.role !== 'owner' && (
                      <Button
                        variant="ghost"
                        size="icon"
                        data-testid={`notes-share-remove-${user.id}`}
                        className="h-8 w-8"
                        onClick={() => handleRemoveShare(user.id, user.email)}
                      >
                        <X className="h-4 w-4" />
                      </Button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Footer Info */}
        <div className="text-xs text-muted-foreground bg-muted/30 p-3 rounded-md">
          <p>
            💡 <strong>Tip:</strong> Shared notes are available in the "Shared
            with Me" section
          </p>
        </div>
      </DialogContent>
    </Dialog>
  );
};
