/**
 * Notes dropdown component for sidebar quick access
 */

import React, { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  DropdownMenuLabel,
  DropdownMenuGroup,
} from '@/components/ui/dropdown-menu';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import {
  FileText,
  Plus,
  Users,
  Lock,
  Search,
  FolderOpen,
  Loader2,
} from 'lucide-react';
import { useWorkspace } from '@/hooks/use-workspace';
import { listNotes, createNote, type Note } from '@/lib/api-notes';
import { toast } from '@/lib/toast-compat';
import { cn } from '@/lib/utils';
import { useTranslation } from 'react-i18next';
import { formatDate } from './utils/note-utils';

interface NotesDropdownProps {
  className?: string;
}

export const NotesDropdown: React.FC<NotesDropdownProps> = ({ className }) => {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const { currentWorkspace } = useWorkspace();
  const [notes, setNotes] = useState<Note[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [filter, setFilter] = useState<'all' | 'mine' | 'shared'>('all');
  const [isLoading, setIsLoading] = useState(false);
  const [isOpen, setIsOpen] = useState(false);

  // Fetch notes when dropdown opens or workspace changes
  const fetchNotes = useCallback(async () => {
    if (!currentWorkspace) return;

    setIsLoading(true);
    try {
      const data = await listNotes(currentWorkspace.id, filter);
      setNotes(data);
    } catch (error) {
      console.error('Failed to fetch notes:', error);
      toast.error(t('notes.loadFailed'));
    } finally {
      setIsLoading(false);
    }
  }, [currentWorkspace, filter, t]);

  useEffect(() => {
    if (isOpen && currentWorkspace) {
      void fetchNotes();
    }
  }, [isOpen, currentWorkspace, fetchNotes]);

  const handleCreateNote = async () => {
    if (!currentWorkspace) {
      toast.error(t('notes.selectWorkspaceFirst'));
      return;
    }

    try {
      const newNote = await createNote({
        workspace_id: currentWorkspace.id,
        title: 'Untitled Note',
        content: {},
      });

      toast.success(t('notes.createSuccess'));

      // Navigate to note editor
      navigate(`/notes/${newNote.id}`);
      setIsOpen(false);
    } catch (error: unknown) {
      const axiosErr = error as { response?: { data?: { detail?: string } } };
      toast.error(axiosErr.response?.data?.detail || t('notes.createFailed'));
    }
  };

  const handleOpenNote = (noteId: string) => {
    navigate(`/notes/${noteId}`);
    setIsOpen(false);
  };

  const filteredNotes = notes.filter((note) =>
    (note.title || 'Untitled')
      .toLowerCase()
      .includes(searchQuery.toLowerCase())
  );

  const groupedNotes = {
    my: filteredNotes.filter((n) => n.role === 'owner'),
    shared: filteredNotes.filter((n) => n.role !== 'owner'),
  };

  return (
    <DropdownMenu open={isOpen} onOpenChange={setIsOpen}>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          data-testid="notes-dropdown-trigger"
          className={cn('w-full justify-start gap-2', className)}
        >
          <FileText className="h-4 w-4" />
          <span>Notes</span>
          {notes.length > 0 && (
            <Badge variant="secondary" className="ml-auto">
              {notes.length}
            </Badge>
          )}
        </Button>
      </DropdownMenuTrigger>

      <DropdownMenuContent data-testid="notes-dropdown-content" className="w-80" align="start">
        {/* Header with Search */}
        <div className="p-2">
          <div className="relative">
            <Search className="absolute left-2 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              type="text"
              data-testid="notes-dropdown-search"
              placeholder={t('notes.searchPlaceholder')}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-8"
            />
          </div>
        </div>

        {/* Filter Tabs */}
        <div className="flex gap-1 px-2 pb-2">
          <Button
            variant={filter === 'all' ? 'secondary' : 'ghost'}
            size="sm"
            data-testid="notes-dropdown-filter-all"
            onClick={() => setFilter('all')}
            className="flex-1 text-xs"
          >
            All
          </Button>
          <Button
            variant={filter === 'mine' ? 'secondary' : 'ghost'}
            size="sm"
            data-testid="notes-dropdown-filter-mine"
            onClick={() => setFilter('mine')}
            className="flex-1 text-xs"
          >
            My Notes
          </Button>
          <Button
            variant={filter === 'shared' ? 'secondary' : 'ghost'}
            size="sm"
            data-testid="notes-dropdown-filter-shared"
            onClick={() => setFilter('shared')}
            className="flex-1 text-xs"
          >
            Shared
          </Button>
        </div>

        <DropdownMenuSeparator />

        {/* Create New Note */}
        <DropdownMenuItem
          data-testid="notes-dropdown-create"
          onClick={handleCreateNote}
          className="gap-2 cursor-pointer"
        >
          <Plus className="h-4 w-4" />
          <span>Create New Note</span>
        </DropdownMenuItem>

        <DropdownMenuSeparator />

        {/* Loading State */}
        {isLoading && (
          <div className="flex items-center justify-center p-4">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        )}

        {/* My Notes Section */}
        {!isLoading && groupedNotes.my.length > 0 && (
          <>
            <DropdownMenuLabel className="text-xs text-muted-foreground">
              My Notes
            </DropdownMenuLabel>
            <DropdownMenuGroup>
              {groupedNotes.my.map((note) => (
                <DropdownMenuItem
                  key={note.id}
                  onClick={() => handleOpenNote(note.id)}
                  className="gap-2 cursor-pointer"
                >
                  <FileText className="h-4 w-4 flex-shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="truncate text-sm font-medium">
                      {note.title || 'Untitled'}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {formatDate(note.updated_at)}
                    </div>
                  </div>
                  {note.is_shared && (
                    <Users className="h-3 w-3 text-muted-foreground flex-shrink-0" />
                  )}
                </DropdownMenuItem>
              ))}
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
          </>
        )}

        {/* Shared Notes Section */}
        {!isLoading && groupedNotes.shared.length > 0 && (
          <>
            <DropdownMenuLabel className="text-xs text-muted-foreground">
              Shared with Me
            </DropdownMenuLabel>
            <DropdownMenuGroup>
              {groupedNotes.shared.map((note) => (
                <DropdownMenuItem
                  key={note.id}
                  onClick={() => handleOpenNote(note.id)}
                  className="gap-2 cursor-pointer"
                >
                  <FileText className="h-4 w-4 flex-shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="truncate text-sm font-medium">
                      {note.title || 'Untitled'}
                    </div>
                    <div className="text-xs text-muted-foreground flex items-center gap-1">
                      {note.role === 'viewer' && (
                        <Lock className="h-3 w-3" />
                      )}
                      <span className="capitalize">{note.role}</span>
                      <span>•</span>
                      <span>{formatDate(note.updated_at)}</span>
                    </div>
                  </div>
                </DropdownMenuItem>
              ))}
            </DropdownMenuGroup>
          </>
        )}

        {/* Empty State */}
        {!isLoading && filteredNotes.length === 0 && (
          <div className="p-4 text-center text-sm text-muted-foreground">
            {searchQuery ? 'No notes found' : 'No notes yet'}
          </div>
        )}

        <DropdownMenuSeparator />

        {/* View All Notes */}
        <DropdownMenuItem
          onClick={() => {
            navigate('/notes');
            setIsOpen(false);
          }}
          className="gap-2 cursor-pointer"
        >
          <FolderOpen className="h-4 w-4" />
          <span>View All Notes</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
};
