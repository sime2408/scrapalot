/**
 * Share annotation dialog — mirrors notes/share-note-dialog.tsx but
 * targets the annotation_shares endpoints (Liquibase 111).
 *
 * Email is the user-facing identifier; we resolve it to a UUID via
 * GET /users/by-email before calling POST /annotations/{id}/shares
 * because the share endpoint requires shared_with_user_id (snake_case).
 */

import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
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
import { Edit3, Eye, Loader2, X } from 'lucide-react';
import { apiClient } from '@/lib/api';
import {
  listAnnotationShareCandidates,
  listAnnotationShares,
  revokeAnnotationShare,
  shareAnnotation,
  type AnnotationShare,
  type AnnotationShareCandidate,
} from '@/lib/api-annotations';
import type { User } from '@/lib/api-users';
import { toast } from '@/lib/toast-compat';

interface ShareAnnotationDialogProps {
  annotationId: string;
  /** Optional preview of the annotation text shown in the dialog header. */
  selectedText?: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

interface ShareRow {
  share: AnnotationShare;
  email?: string;
}

export const ShareAnnotationDialog: React.FC<ShareAnnotationDialogProps> = ({
  annotationId,
  selectedText,
  open,
  onOpenChange,
}) => {
  const { t } = useTranslation();
  const [selectedRecipient, setSelectedRecipient] = useState<string>('');
  const [permission, setPermission] = useState<'read' | 'write'>('write');
  const [rows, setRows] = useState<ShareRow[]>([]);
  const [candidates, setCandidates] = useState<AnnotationShareCandidate[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isSharing, setIsSharing] = useState(false);

  const loadShares = useCallback(async () => {
    setIsLoading(true);
    try {
      const [shares, cands] = await Promise.all([
        listAnnotationShares(annotationId),
        listAnnotationShareCandidates(annotationId),
      ]);
      setCandidates(cands);
      // Build email lookup from the candidates list — every existing
      // share's recipient must be a workspace member, so the candidates
      // payload already has their email. Falls back to per-user fetch
      // for any share whose user isn't in the candidates list (edge
      // case: workspace member was removed but their share lingered).
      const emailLookup = new Map(cands.map((c) => [c.user_id, c.email]));
      const enriched = await Promise.all(
        shares.map(async (share) => {
          const cached = emailLookup.get(share.shared_with_user_id);
          if (cached) return { share, email: cached } as ShareRow;
          try {
            const { data } = await apiClient.get<User>(`/users/${share.shared_with_user_id}`);
            return { share, email: data.email } as ShareRow;
          } catch {
            return { share } as ShareRow;
          }
        })
      );
      setRows(enriched);
    } catch (e) {
      const detail = (e as { response?: { data?: { detail?: string } } }).response?.data?.detail;
      toast.error(detail || t('knowledge.annotations.share.loadFailed', 'Failed to load shares'));
    } finally {
      setIsLoading(false);
    }
  }, [annotationId, t]);

  useEffect(() => {
    if (open) void loadShares();
  }, [open, loadShares]);

  // Filter out users who are already in the share list — pointless to
  // re-share with someone who already has access.
  const sharedWithIds = new Set(rows.map((r) => r.share.shared_with_user_id));
  const availableCandidates = candidates.filter((c) => !sharedWithIds.has(c.user_id));

  const handleShare = async () => {
    if (!selectedRecipient) {
      toast.error(t('knowledge.annotations.share.pickRecipient', 'Pick a workspace member'));
      return;
    }
    setIsSharing(true);
    try {
      await shareAnnotation(annotationId, selectedRecipient, permission);
      const recipient = candidates.find((c) => c.user_id === selectedRecipient);
      const label = recipient?.email || recipient?.username || selectedRecipient;
      toast.success(t('knowledge.annotations.share.success', { email: label }));
      setSelectedRecipient('');
      void loadShares();
    } catch (e) {
      const detail = (e as { response?: { data?: { detail?: string } } }).response?.data?.detail;
      toast.error(detail || t('knowledge.annotations.share.shareFailed', 'Share failed'));
    } finally {
      setIsSharing(false);
    }
  };

  const handleRevoke = async (recipientId: string, label: string) => {
    if (!window.confirm(t('knowledge.annotations.share.revokeConfirm', { user: label }))) return;
    try {
      await revokeAnnotationShare(annotationId, recipientId);
      toast.success(t('knowledge.annotations.share.revoked', 'Access revoked'));
      void loadShares();
    } catch (e) {
      const detail = (e as { response?: { data?: { detail?: string } } }).response?.data?.detail;
      toast.error(detail || t('knowledge.annotations.share.revokeFailed', 'Revoke failed'));
    }
  };

  const initials = (label: string) => {
    if (!label) return '?';
    if (label.includes('@')) {
      return label.split('@')[0].slice(0, 2).toUpperCase();
    }
    return label.slice(0, 2).toUpperCase();
  };

  const truncatedText = selectedText
    ? selectedText.length > 80
      ? `${selectedText.slice(0, 77)}...`
      : selectedText
    : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        data-testid="annotation-share-dialog"
        className="max-w-md"
        dialogOpen={open}
        onOpenChange={onOpenChange}
        overlayZIndex="1000000"
      >
        <DialogHeader>
          <DialogTitle>{t('knowledge.annotations.share.title', 'Share annotation')}</DialogTitle>
          <DialogDescription>
            {truncatedText
              ? t('knowledge.annotations.share.descriptionWithText', { text: truncatedText })
              : t('knowledge.annotations.share.descriptionNoText', 'Grant another user access to this annotation.')}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="flex gap-2">
            <Select
              value={selectedRecipient}
              onValueChange={setSelectedRecipient}
              disabled={isSharing || isLoading || availableCandidates.length === 0}
            >
              <SelectTrigger
                data-testid="annotation-share-recipient-select"
                className="flex-1"
              >
                <SelectValue
                  placeholder={
                    isLoading
                      ? t('knowledge.annotations.share.loading', 'Loading...')
                      : availableCandidates.length === 0
                        ? t('knowledge.annotations.share.noCandidates', 'No workspace members to share with')
                        : t('knowledge.annotations.share.recipientPlaceholder', 'Pick a workspace member')
                  }
                />
              </SelectTrigger>
              {/* Dialog content lives at z-1000001, Select default z-100
                  hides the dropdown behind the dialog. Bump above. */}
              <SelectContent className="z-[1000002]">
                {availableCandidates.map((c) => (
                  <SelectItem key={c.user_id} value={c.user_id}>
                    <div className="flex flex-col">
                      <span className="text-sm">{c.email || c.username || c.user_id}</span>
                      {c.email && c.username && (
                        <span className="text-[10px] text-muted-foreground">{c.username}</span>
                      )}
                    </div>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select
              value={permission}
              onValueChange={(v) => setPermission(v as 'read' | 'write')}
              disabled={isSharing}
            >
              <SelectTrigger data-testid="annotation-share-permission-select" className="w-32">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="z-[1000002]">
                <SelectItem value="write">
                  <div className="flex items-center gap-2">
                    <Edit3 className="h-4 w-4" />
                    {t('knowledge.annotations.share.permission.write', 'Can edit')}
                  </div>
                </SelectItem>
                <SelectItem value="read">
                  <div className="flex items-center gap-2">
                    <Eye className="h-4 w-4" />
                    {t('knowledge.annotations.share.permission.read', 'Can view')}
                  </div>
                </SelectItem>
              </SelectContent>
            </Select>
            <Button
              data-testid="annotation-share-submit-button"
              onClick={handleShare}
              disabled={isSharing || !selectedRecipient}
            >
              {isSharing ? <Loader2 className="h-4 w-4 animate-spin" /> : t('knowledge.annotations.share.submit', 'Share')}
            </Button>
          </div>
          <p className="text-[11px] text-muted-foreground leading-snug">
            {t(
              'knowledge.annotations.share.permissionHelp',
              '"Can edit" lets the recipient change the comment and color; the highlighted text and position remain owner-only.'
            )}
          </p>
          {!isLoading && availableCandidates.length === 0 && rows.length === 0 && (
            <p className="text-[11px] text-amber-500 leading-snug">
              {t(
                'knowledge.annotations.share.noCandidatesHint',
                'You have no workspace members yet. Invite users to your workspace first, then come back to share annotations with them.'
              )}
            </p>
          )}
        </div>

        <Separator />

        <div>
          <h4 className="font-medium mb-3 text-sm">
            {t('knowledge.annotations.share.whoHasAccess', 'Who has access')}
          </h4>

          {isLoading ? (
            <div className="flex items-center justify-center py-4">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : rows.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-4">
              {t('knowledge.annotations.share.empty', 'No one else has access yet')}
            </p>
          ) : (
            <div className="space-y-2 max-h-64 overflow-y-auto">
              {rows.map((row) => {
                const label = row.email || row.share.shared_with_user_id;
                return (
                  <div
                    key={row.share.shared_with_user_id}
                    data-testid={`annotation-share-user-${row.share.shared_with_user_id}`}
                    className="flex items-center justify-between p-2 hover:bg-muted/50"
                  >
                    <div className="flex items-center gap-3 flex-1 min-w-0">
                      <Avatar className="h-8 w-8">
                        <AvatarFallback className="text-xs">{initials(label)}</AvatarFallback>
                      </Avatar>
                      <p className="text-sm font-medium truncate flex-1">{label}</p>
                    </div>
                    <div className="flex items-center gap-2">
                      <Badge
                        variant="secondary"
                        className="text-xs"
                        data-testid={`annotation-share-permission-${row.share.shared_with_user_id}`}
                      >
                        {row.share.permission === 'write' ? (
                          <Edit3 className="h-3 w-3 mr-1" />
                        ) : (
                          <Eye className="h-3 w-3 mr-1" />
                        )}
                        {row.share.permission === 'write'
                          ? t('knowledge.annotations.share.permission.write', 'Can edit')
                          : t('knowledge.annotations.share.permission.read', 'Can view')}
                      </Badge>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8"
                        onClick={() => handleRevoke(row.share.shared_with_user_id, label)}
                        data-testid={`annotation-share-revoke-${row.share.shared_with_user_id}`}
                        aria-label={t('knowledge.annotations.share.revoke', 'Revoke access')}
                      >
                        <X className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
};
