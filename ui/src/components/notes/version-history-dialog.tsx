/**
 * 7.9 — Version history dialog for notes.
 *
 * Replaces the previous mock-data placeholder with the real
 * /notes/{id}/versions REST endpoint and adds first-class support for
 * the named save-points introduced in Liquibase changeset 104:
 *
 *   - "Save current version…" inline button — opens a small inline
 *     form for label + optional message and posts to
 *     /notes/{id}/versions/save-named.
 *   - Filter chip (Named only / All) — auto-snapshots dominate the
 *     list once a note has been edited for any length of time, so the
 *     default view hides them and shows only the writer's deliberate
 *     save-points.
 *   - Per-row kind badge (named/restore) so the writer can tell the
 *     two apart at a glance.
 *   - Restore confirmation explicitly notes that the current state is
 *     captured first, mirroring the backend's pre-restore snapshot —
 *     so users know they can undo.
 *
 * The dialog still uses ScrollArea for the list pane (this is inside a
 * Radix Dialog, not a flex column, so the rule 23 caveat doesn't bite).
 */

import React, { useCallback, useMemo, useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Badge } from '@/components/ui/badge';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {
  History,
  RotateCcw,
  Loader2,
  Clock,
  Bookmark,
  Save,
  X,
} from 'lucide-react';
import { toast } from '@/lib/toast-compat';
import { cn } from '@/lib/utils';
import { getInitials, formatRelativeTime } from './utils/note-utils';
import { useTranslation } from 'react-i18next';
import { useAsyncData } from '@/hooks/use-async-data';
import { DataContainer } from '@/components/ui/data-container';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import {
  listNoteVersions,
  saveNamedNoteVersion,
  restoreNoteVersion,
  type NoteVersion,
} from '@/lib/api-notes';
import { VersionDiffView, type DiffLayout } from './version-diff-view';

interface VersionHistoryDialogProps {
  noteId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Notify the parent (notes-drawer) so it can re-fetch the note
   *  content and let the editor pick up the restored state. */
  onRestored?: (versionId: string) => void;
}

/** Kind → translated label + tinted Badge variant. Sharp corners +
 *  semantic colors only (CLAUDE.md UI rules 9-10). */
function kindBadge(
  kind: NoteVersion['kind'],
  t: ReturnType<typeof useTranslation>['t'],
): { label: string; className: string } | null {
  switch (kind) {
    case 'named':
      return {
        label: t('notes.versionHistory.kindNamed', 'Named'),
        className: 'bg-violet-500/10 text-violet-700 dark:text-violet-300 border-violet-500/30',
      };
    case 'restore':
      return {
        label: t('notes.versionHistory.kindRestore', 'Pre-restore'),
        className: 'bg-amber-500/10 text-amber-700 dark:text-amber-300 border-amber-500/30',
      };
    case 'auto':
    default:
      return null; // auto is the silent default — no badge
  }
}

export const VersionHistoryDialog: React.FC<VersionHistoryDialogProps> = ({
  noteId,
  open,
  onOpenChange,
  onRestored,
}) => {
  const { t } = useTranslation();
  const [selectedVersion, setSelectedVersion] = useState<NoteVersion | null>(null);
  const [isRestoring, setIsRestoring] = useState(false);
  const [restoreConfirmOpen, setRestoreConfirmOpen] = useState(false);
  const [namedOnly, setNamedOnly] = useState(true);
  const [savingNamed, setSavingNamed] = useState(false);
  const [namedFormOpen, setNamedFormOpen] = useState(false);
  const [namedLabel, setNamedLabel] = useState('');
  const [namedMessage, setNamedMessage] = useState('');
  // Controlled maximize state. We toggle it ourselves so the caller-side
  // className can DROP max-w / max-h when maximized — twMerge keeps the
  // later occurrence on conflict, so a static `max-w-7xl` on the caller
  // beats the dialog primitive's `!max-w-none` and the maximize button
  // becomes a no-op visually.
  const [isMaximized, setIsMaximized] = useState(false);
  // 7.9 — diff layout preference; persisted across dialog opens.
  const [diffLayout, setDiffLayout] = useState<DiffLayout>(() => {
    if (typeof window === 'undefined') return 'inline';
    return (window.localStorage.getItem('scrapalot_notes_version_diff_layout') as DiffLayout) || 'inline';
  });
  const handleDiffLayoutChange = useCallback((layout: DiffLayout) => {
    setDiffLayout(layout);
    try {
      window.localStorage.setItem('scrapalot_notes_version_diff_layout', layout);
    } catch {
      /* noop */
    }
  }, []);

  const { data: versions, loading, error, refetch } = useAsyncData<NoteVersion[]>(
    () => listNoteVersions(noteId),
    { deps: [noteId], skip: !open || !noteId },
  );

  const visibleVersions = useMemo(() => {
    if (!versions) return [] as NoteVersion[];
    return namedOnly ? versions.filter((v) => v.kind === 'named') : versions;
  }, [versions, namedOnly]);

  const handleRestoreConfirm = useCallback(async () => {
    if (!selectedVersion) return;
    setIsRestoring(true);
    try {
      await restoreNoteVersion(noteId, selectedVersion.id);
      toast.success(t('notes.versionHistory.restored', 'Version restored.'));
      onRestored?.(selectedVersion.id);
      onOpenChange(false);
    } catch (err) {
      console.error('restoreNoteVersion failed', err);
      toast.error(t('notes.versionHistory.restoreFailed', 'Restore failed.'));
    } finally {
      setIsRestoring(false);
      setRestoreConfirmOpen(false);
    }
  }, [selectedVersion, noteId, onRestored, onOpenChange, t]);

  const handleSaveNamed = useCallback(async () => {
    const label = namedLabel.trim();
    if (!label) return;
    setSavingNamed(true);
    try {
      await saveNamedNoteVersion(noteId, label, namedMessage.trim() || undefined);
      toast.success(t('notes.versionHistory.namedSaved', 'Version saved.'));
      setNamedFormOpen(false);
      setNamedLabel('');
      setNamedMessage('');
      refetch();
    } catch (err) {
      console.error('saveNamedNoteVersion failed', err);
      toast.error(t('notes.versionHistory.namedSaveFailed', 'Could not save version.'));
    } finally {
      setSavingNamed(false);
    }
  }, [namedLabel, namedMessage, noteId, t, refetch]);

  const formatDate = (dateString: string) => {
    const date = new Date(dateString);
    return date.toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent
          data-testid="notes-version-history-dialog"
          // overlayZIndex bypasses the inline `zIndex: 71` the
          // DialogContent component sets for itself.  10049 + 1 → 10050
          // for the content; that sits above the notes-drawer toolbar
          // (z-[10001]) and the drawer chrome — same convention as
          // TemplateGallery / NotesOpenDialog / BridgingConceptsPanel.
          overlayZIndex="10049"
          className={cn(
            'flex flex-col gap-0',
            !isMaximized && 'max-w-7xl max-h-[85vh]',
          )}
          dialogOpen={open}
          onOpenChange={onOpenChange}
          // 7.9 v2 — diff view (especially side-by-side) wants more
          // horizontal real estate than max-w-5xl gives. Surface the
          // built-in maximize toggle (top-right corner of the dialog
          // chrome) so writers comparing versions can fill the screen.
          allowMaximize={true}
          isMaximized={isMaximized}
          onMaximizeChange={setIsMaximized}
        >
          {/* Wrapper claims the dialog's full content area so the inner
              flex chain (right pane → diff view) gets a definite height
              and scrolls instead of overflowing. */}
          <div className="flex flex-col gap-2 min-h-0 flex-1 overflow-hidden">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <History className="h-5 w-5" />
              {t('notes.versionHistory.title', 'Version history')}
            </DialogTitle>
            <DialogDescription>
              {t('notes.versionHistory.description', 'Browse and restore previous saves of this note.')}
            </DialogDescription>
          </DialogHeader>

          {/* Toolbar — filter + named-save trigger directly under the
              dialog header (per writer feedback: "Samo imenovane …
              pomakni gore, ispod Povijest verzija"). Sticky-left
              cluster so the wide-viewport / maximized state doesn't
              spread the buttons across the full dialog width with an
              empty band in between. */}
          <div className="flex items-center gap-2 border-b border-border pb-2">
            <div className="flex items-center gap-1">
              <Button
                size="sm"
                variant={namedOnly ? 'default' : 'outline'}
                onClick={() => setNamedOnly(true)}
                data-testid="notes-version-filter-named"
              >
                {t('notes.versionHistory.filterNamed', 'Named only')}
              </Button>
              <Button
                size="sm"
                variant={!namedOnly ? 'default' : 'outline'}
                onClick={() => setNamedOnly(false)}
                data-testid="notes-version-filter-all"
              >
                {t('notes.versionHistory.filterAll', 'All')}
              </Button>
            </div>
            {!namedFormOpen ? (
              <Button
                size="sm"
                variant="outline"
                onClick={() => setNamedFormOpen(true)}
                data-testid="notes-version-save-named-trigger"
                className="ml-2"
              >
                <Bookmark className="h-4 w-4 mr-2" />
                {t('notes.versionHistory.saveNamed', 'Save current version…')}
              </Button>
            ) : null}
          </div>

          {/* Inline form — opens above the list when the user clicks
              "Save current version…". Kept inline so writers don't lose
              context of where they were in the list. */}
          {namedFormOpen && (
            <div className="border border-border bg-muted/30 p-3 space-y-2">
              <Input
                value={namedLabel}
                onChange={(e) => setNamedLabel(e.target.value)}
                placeholder={t(
                  'notes.versionHistory.namedLabelPlaceholder',
                  'Label, e.g. "Pre-revision draft" (required)',
                )}
                maxLength={120}
                data-testid="notes-version-named-label"
                autoFocus
              />
              <Textarea
                value={namedMessage}
                onChange={(e) => setNamedMessage(e.target.value)}
                placeholder={t(
                  'notes.versionHistory.namedMessagePlaceholder',
                  'Why are you saving this version? (optional)',
                )}
                maxLength={4000}
                rows={2}
                data-testid="notes-version-named-message"
              />
              <div className="flex justify-end gap-2">
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setNamedFormOpen(false);
                    setNamedLabel('');
                    setNamedMessage('');
                  }}
                  disabled={savingNamed}
                >
                  <X className="h-4 w-4 mr-1" />
                  {t('common.cancel', 'Cancel')}
                </Button>
                <Button
                  size="sm"
                  onClick={() => void handleSaveNamed()}
                  disabled={savingNamed || !namedLabel.trim()}
                  data-testid="notes-version-save-named-submit"
                >
                  {savingNamed ? (
                    <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                  ) : (
                    <Save className="h-4 w-4 mr-1" />
                  )}
                  {t('notes.versionHistory.saveNamedSubmit', 'Save version')}
                </Button>
              </div>
            </div>
          )}

          <DataContainer
            loading={loading}
            error={error}
            empty={!loading && (!visibleVersions || visibleVersions.length === 0)}
            emptyMessage={
              namedOnly
                ? t('notes.versionHistory.noNamedVersions', 'No named versions yet — save one above to get started.')
                : t('notes.versionHistory.noVersions', 'No versions yet.')
            }
            skeleton={
              <div className="flex items-center justify-center py-12">
                <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
              </div>
            }
            errorRenderer={() => (
              <div className="text-center py-12">
                <Clock className="h-12 w-12 mx-auto mb-4 text-muted-foreground opacity-50" />
                <p className="text-sm text-muted-foreground">
                  {t('notes.versionHistory.loadFailed', 'Could not load versions.')}
                </p>
              </div>
            )}
          >
            {visibleVersions.length > 0 && (
              // Asymmetric split — version list is a rail (≈ 28% /
              // min 280 px), the rest goes to Details + Diff because
              // that's where the writer reads. `flex-1 min-h-0` makes
              // the grid stretch to the bottom of the (maximized)
              // dialog instead of stopping at content height and
              // leaving an empty band below the Restore button.
              <div className="flex-1 min-h-0 grid grid-cols-1 md:grid-cols-[minmax(280px,28%)_1fr] gap-4">
                <ScrollArea className="h-full pr-4">
                  <div className="space-y-2">
                    {visibleVersions.map((version, index) => {
                      const badge = kindBadge(version.kind, t);
                      return (
                        <div
                          key={version.id}
                          data-testid={`notes-version-item-${version.id}`}
                          data-version-kind={version.kind ?? 'auto'}
                          className={cn(
                            'p-3 border cursor-pointer transition-colors',
                            selectedVersion?.id === version.id
                              ? 'bg-primary/10 border-primary'
                              : 'hover:bg-muted/50',
                          )}
                          onClick={() => setSelectedVersion(version)}
                        >
                          <div className="flex items-start justify-between mb-2 gap-2">
                            <div className="flex items-center gap-2 min-w-0">
                              <Avatar className="h-8 w-8">
                                <AvatarFallback className="text-xs">
                                  {getInitials('User')}
                                </AvatarFallback>
                              </Avatar>
                              <div className="min-w-0">
                                <p className="text-sm font-medium truncate">
                                  {version.label || `${t('notes.versionHistory.version', 'Version')} ${version.version_number}`}
                                </p>
                                <p className="text-xs text-muted-foreground">
                                  {formatRelativeTime(version.created_at)}
                                </p>
                              </div>
                            </div>
                            <div className="flex items-center gap-1 flex-shrink-0">
                              {badge && (
                                <Badge
                                  variant="outline"
                                  className={cn('text-[10px] uppercase tracking-wide', badge.className)}
                                >
                                  {badge.label}
                                </Badge>
                              )}
                              {index === 0 && namedOnly && (
                                <Badge variant="secondary" className="text-xs">
                                  {t('notes.versionHistory.current', 'Current')}
                                </Badge>
                              )}
                            </div>
                          </div>

                          {(version.message || version.change_summary) && (
                            <p className="text-sm text-muted-foreground line-clamp-2">
                              {version.message || version.change_summary}
                            </p>
                          )}

                          <div className="flex items-center gap-2 mt-2 text-xs text-muted-foreground">
                            <span>#{version.version_number}</span>
                            <span>•</span>
                            <span>{formatDate(version.created_at)}</span>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </ScrollArea>

                <div className="border p-4 h-full overflow-hidden flex flex-col">
                  {selectedVersion ? (
                    <div className="flex-1 min-h-0 flex flex-col gap-4">
                      <div className="shrink-0">
                        <h4 className="font-medium mb-2">
                          {t('notes.versionHistory.details', 'Details')}
                        </h4>
                        <div className="space-y-2 text-sm">
                          <div className="flex justify-between">
                            <span className="text-muted-foreground">
                              {t('notes.versionHistory.version', 'Version')}:
                            </span>
                            <span className="font-medium">#{selectedVersion.version_number}</span>
                          </div>
                          <div className="flex justify-between">
                            <span className="text-muted-foreground">
                              {t('notes.versionHistory.date', 'Date')}:
                            </span>
                            <span className="font-medium">
                              {formatDate(selectedVersion.created_at)}
                            </span>
                          </div>
                          {selectedVersion.label && (
                            <div className="flex justify-between gap-2">
                              <span className="text-muted-foreground">
                                {t('notes.versionHistory.label', 'Label')}:
                              </span>
                              <span className="font-medium text-right break-words">
                                {selectedVersion.label}
                              </span>
                            </div>
                          )}
                        </div>
                      </div>

                      {(selectedVersion.message || selectedVersion.change_summary) && (
                        <div className="shrink-0">
                          <h4 className="font-medium mb-2">
                            {t('notes.versionHistory.changes', 'Notes')}
                          </h4>
                          <p className="text-sm text-muted-foreground whitespace-pre-wrap">
                            {selectedVersion.message || selectedVersion.change_summary}
                          </p>
                        </div>
                      )}

                      {/* 7.9 — diff view between the selected version
                          and the most recent version (versions[0]).
                          Hidden when there is only one version on the
                          list (nothing to diff against), or when the
                          selected version IS the most recent.
                          flex-1 + min-h-0 lets it grow to fill the
                          remaining height of the right pane (~ rest
                          of the dialog after Details + Notes + Restore
                          have taken their natural space). */}
                      {versions && versions.length > 1 && versions[0] && versions[0].id !== selectedVersion.id && (
                        <div className="flex-1 min-h-0 flex flex-col">
                          <h4 className="font-medium mb-2 shrink-0">
                            {t('notes.versionHistory.diff', 'Changes since this version')}
                          </h4>
                          <div className="flex-1 min-h-0 overflow-hidden">
                            <VersionDiffView
                              oldContent={selectedVersion.content || ''}
                              newContent={versions[0].content || ''}
                              layout={diffLayout}
                              onLayoutChange={handleDiffLayoutChange}
                            />
                          </div>
                        </div>
                      )}

                      <div className="flex gap-2 shrink-0">
                        <Button
                          size="sm"
                          data-testid="notes-version-restore-button"
                          className="px-6"
                          onClick={() => setRestoreConfirmOpen(true)}
                          disabled={
                            isRestoring ||
                            (visibleVersions[0]?.id === selectedVersion.id && namedOnly === false)
                          }
                        >
                          {isRestoring ? (
                            <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                          ) : (
                            <RotateCcw className="h-4 w-4 mr-2" />
                          )}
                          {t('notes.versionHistory.restore', 'Restore')}
                        </Button>
                      </div>
                      <p className="text-xs text-muted-foreground shrink-0">
                        {t(
                          'notes.versionHistory.restoreSafetyNote',
                          'Your current draft is captured automatically before the restore, so this is reversible.',
                        )}
                      </p>
                    </div>
                  ) : (
                    <div className="flex items-center justify-center h-full text-muted-foreground">
                      <p className="text-sm">
                        {t('notes.versionHistory.selectVersion', 'Select a version to inspect.')}
                      </p>
                    </div>
                  )}
                </div>
              </div>
            )}
          </DataContainer>
          </div>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={restoreConfirmOpen}
        onOpenChange={setRestoreConfirmOpen}
        title={t('notes.versionHistory.restoreConfirm', 'Restore this version?')}
        description={t(
          'notes.versionHistory.restoreConfirmDescription',
          'The current draft is saved as a snapshot first. You can undo this restore from the version list.',
        )}
        onConfirm={handleRestoreConfirm}
        isLoading={isRestoring}
      />
    </>
  );
};
