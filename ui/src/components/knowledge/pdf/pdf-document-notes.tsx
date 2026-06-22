/**
 * Document-linked notes panel for PDF viewer sidebar.
 * Shows notes linked to the current document, with create/edit functionality.
 */

import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { StickyNote, Plus, Trash2, Loader2, ExternalLink } from 'lucide-react';
import { cn } from '@/lib/utils';
import { apiClient, authState } from '@/lib/api';
import { useWorkspace } from '@/hooks/use-workspace';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

interface DocumentNote {
  id: string;
  title: string;
  content?: string | null;
  document_id?: string | null;
  created_at: string;
  updated_at: string;
}

interface PdfDocumentNotesProps {
  documentId: string;
  documentTitle?: string;
  className?: string;
  onOpenNote?: (noteId: string) => void;
}

export function PdfDocumentNotes({ documentId, documentTitle, className, onOpenNote }: PdfDocumentNotesProps) {
  const { t } = useTranslation();
  const { currentWorkspace } = useWorkspace();
  const [notes, setNotes] = useState<DocumentNote[]>([]);
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [showInput, setShowInput] = useState(false);

  const loadNotes = useCallback(async () => {
    if (!documentId) return;
    setLoading(true);
    try {
      await authState.waitForAuthReady();
      const { data } = await apiClient.get(`/notes/by-document/${documentId}`);
      setNotes(Array.isArray(data) ? data : []);
    } catch {
      // Silent — endpoint may return empty
      setNotes([]);
    } finally {
      setLoading(false);
    }
  }, [documentId]);

  useEffect(() => { void loadNotes(); }, [loadNotes]);

  const handleCreate = async () => {
    if (!currentWorkspace?.id) return;
    const title = newTitle.trim() || `Note on ${documentTitle || 'document'}`;
    setCreating(true);
    try {
      await authState.waitForAuthReady();
      const { data } = await apiClient.post('/notes', {
        title,
        workspace_id: currentWorkspace.id,
        document_id: documentId,
      });
      setNotes(prev => [data, ...prev]);
      setNewTitle('');
      setShowInput(false);
      if (onOpenNote) onOpenNote(data.id);
    } catch {
      // Silent
    } finally {
      setCreating(false);
    }
  };

  const handleDelete = async (noteId: string) => {
    try {
      await authState.waitForAuthReady();
      await apiClient.delete(`/notes/${noteId}`);
      setNotes(prev => prev.filter(n => n.id !== noteId));
    } catch {
      // Silent
    }
  };

  return (
    <div className={cn('flex flex-col h-full', className)}>
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-border">
        <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
          <StickyNote className="w-3.5 h-3.5" />
          {t('pdfViewer.notes.title', 'Document Notes')}
          {notes.length > 0 && (
            <span className="text-[10px] bg-primary/10 text-primary px-1.5 py-0.5">
              {notes.length}
            </span>
          )}
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6"
          onClick={() => setShowInput(!showInput)}
          title={t('pdfViewer.notes.create', 'New note')}
        >
          <Plus className="w-3.5 h-3.5" />
        </Button>
      </div>

      {/* Create note input */}
      {showInput && (
        <div className="flex gap-1.5 p-2 border-b border-border">
          <Input
            value={newTitle}
            onChange={(e) => setNewTitle(e.target.value)}
            placeholder={t('pdfViewer.notes.titlePlaceholder', 'Note title...')}
            className="h-7 text-xs flex-1"
            onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
            autoFocus
          />
          <Button
            size="sm"
            className="h-7 px-2 text-xs"
            onClick={handleCreate}
            disabled={creating}
          >
            {creating ? <Loader2 className="w-3 h-3 animate-spin" /> : t('pdfViewer.notes.add', 'Add')}
          </Button>
        </div>
      )}

      {/* Notes list */}
      <div className="flex-1 overflow-y-auto">
        {loading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />
          </div>
        ) : notes.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-8 text-muted-foreground">
            <StickyNote className="w-6 h-6 mb-2 opacity-30" />
            <p className="text-xs">{t('pdfViewer.notes.empty', 'No notes for this document')}</p>
            <button
              className="text-xs text-primary mt-2 hover:underline"
              onClick={() => setShowInput(true)}
            >
              {t('pdfViewer.notes.createFirst', 'Create one')}
            </button>
          </div>
        ) : (
          notes.map(note => (
            <div
              key={note.id}
              className="flex items-start gap-2 px-3 py-2 border-b border-border/50 hover:bg-accent/30 transition-colors group cursor-pointer"
              onClick={() => onOpenNote?.(note.id)}
            >
              <StickyNote className="w-3.5 h-3.5 mt-0.5 text-yellow-500 flex-shrink-0" />
              <div className="flex-1 min-w-0">
                <span className="text-xs font-medium line-clamp-2">{note.title}</span>
                <span className="text-[10px] text-muted-foreground block mt-0.5">
                  {new Date(note.updated_at).toLocaleDateString()}
                </span>
              </div>
              <div className="flex gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                <button
                  onClick={(e) => { e.stopPropagation(); onOpenNote?.(note.id); }}
                  className="p-0.5 text-muted-foreground hover:text-foreground"
                  title={t('pdfViewer.notes.open', 'Open in editor')}
                >
                  <ExternalLink className="w-3 h-3" />
                </button>
                <button
                  onClick={(e) => { e.stopPropagation(); void handleDelete(note.id); }}
                  className="p-0.5 text-muted-foreground hover:text-red-500"
                >
                  <Trash2 className="w-3 h-3" />
                </button>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
