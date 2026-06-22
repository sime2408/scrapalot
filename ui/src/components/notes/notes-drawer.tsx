import React, {useCallback, useContext, useEffect, useRef, useState} from 'react';
import {useTranslation} from 'react-i18next';
import {Book, Edit3, Eye, Loader2, Mail, Maximize, Minimize, Send, Share2, X,} from 'lucide-react';
import { WindowPinMenu } from '@/components/ui/window-pin-menu';
import { useFloatingWindowManager } from '@/contexts/floating-window-context';
import { useFloatingWindow } from '@/hooks/use-floating-window';
import { makeFloatingWindowStorage } from '@/lib/floating-window-storage';
import type { WindowMode } from '@/types/floating-window';
import {Button} from '@/components/ui/button';
import {CollaborativeNotesEditor} from './collaborative-notes-editor';
import {useIsMobile, useIsNarrowScreen} from '@/hooks/use-mobile';
import {useAuth} from '@/hooks/use-auth';
import {useSidebar} from '@/contexts/sidebar-context';
import {useNotesDrawer} from '@/hooks/use-notes-drawer';
import {usePDFViewer} from '@/contexts/pdf-viewer-context';
import {WorkspaceContext} from '@/contexts/workspace-context';
import {toast} from '@/lib/toast-compat';
import {createNote, getNote, getWorkspaceMembers, listNotes, shareNote, updateNote, createUserNoteTemplate, type NoteCategory} from '@/lib/api-notes';
import {
  getNotesEditorPreferences,
  type NotesEditorOrientation,
  type NotesPaperSize,
  type NotesScreenWidth,
} from '@/lib/api-settings';
import {Tooltip, TooltipContent, TooltipTrigger,} from '@/components/ui/tooltip';
import {Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,} from '@/components/ui/dialog';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import {Input} from '@/components/ui/input';
import {Label} from '@/components/ui/label';
import {cn} from '@/lib/utils';
import {useDebounce} from '@/hooks/use-debounce';
import {generateNoteTitle} from '@/lib/note-utils';
import {collectCitations} from './extensions/bibliography-node';
import {toBibTeXBatch, generateCitationKey} from '@/lib/citation-formatter';
import type {Editor} from '@tiptap/core';
import {PaperGenerationDialog} from './paper-generation-dialog';
import {generatePaper} from '@/lib/api-papers';
import {apiClient} from '@/lib/api';
import {NoteMenuBar, type NoteMenuHandlers, type NoteMenuState} from './note-menu-bar';
import {NoteResearchContextPopover} from './note-research-context-popover';
import {TemplateGallery} from './template-gallery';
import {VersionHistoryDialog} from './version-history-dialog';
import {ComposeFromSourcesDialog} from './compose-from-sources-dialog';
import {OutlineTemplatePickerDialog} from './outline-template-picker-dialog';
import {NotesOpenDialog} from './notes-open-dialog';
import {BridgingConceptsPanel} from './bridging-concepts-panel';
import {WholeNoteFactCheckPanel} from './whole-note-fact-check-panel';
import type {NoteTemplate} from '@/lib/note-templates-catalog';
import {DRAFT_FROM_RESEARCH_EVENT, type DraftFromResearchPayload} from '@/lib/draft-from-research';
import {markdownToHtml} from './utils/markdown-converter';
import {
  formatResearchScopeLabel,
  getNoteResearchContext,
  setNoteResearchContext,
  fetchNoteResearchContextFromServer,
  saveNoteResearchContextToServer,
  type NoteResearchContext,
} from '@/lib/note-research-context';
import {useCollections} from '@/contexts/collections-context';
import {useChatScopeStore} from '@/hooks/use-chat-scope-store';

// Helper to check if content is effectively empty (no real content)
// Defined outside component to avoid recreation on each render
const isContentEmpty = (content: string): boolean => {
  if (!content || !content.trim()) return true;
  // Check for empty paragraph tags only
  const stripped = content.replace(/<p><\/p>/gi, '').replace(/<br\s*\/?>/gi, '').trim();
  if (!stripped) return true;
  // Extract text content to check if there's any actual text
  const tempDiv = document.createElement('div');
  tempDiv.innerHTML = content;
  const plainText = (tempDiv.textContent || tempDiv.innerText || '').trim();
  return plainText.length === 0;
};

interface WorkspaceMember {
  id: string;
  username: string;
  email?: string;
  avatar_url?: string;
  role: 'owner' | 'editor' | 'viewer';
}

// Define the sidebar width constants for consistent use.
// Must match the icon sidebar in sidebar-quick-tools.tsx (`w-[70px]`).
const ICON_SIDEBAR_WIDTH = 70;
const CONVERSATIONS_SIDEBAR_WIDTH = 335;

interface NotesDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  sessionId?: string;
  noteId?: string;
  isPdfOpen?: boolean; // Track if PDF is also open for side-by-side layout
  // Same idea as isPdfOpen but for the deep-research markdown viewer. When it
  // sits on one side we want Notes to land on the OPPOSITE side (or full
  // width on a narrow screen) instead of stacking on top of it.
  isMarkdownViewerOpen?: boolean;
  isMarkdownViewerOnLeft?: boolean;
}

export const NotesDrawer = ({
  isOpen,
  onClose,
  sessionId,
  noteId: propsNoteId,
  isPdfOpen = false,
  isMarkdownViewerOpen = false,
  isMarkdownViewerOnLeft = false,
}: NotesDrawerProps) => {
  const { t, i18n } = useTranslation();
  const isNarrowScreen = useIsNarrowScreen(); // Below 992px for full screen behavior
  const isMobile = useIsMobile(); // Below 1080px
  const { isSidebarOpen, toggleSidebar } = useSidebar();
  const { user } = useAuth();
  const workspaceContext = useContext(WorkspaceContext);
  const currentWorkspace = workspaceContext?.currentWorkspace || null;
  const workspaceLoading = workspaceContext?.isLoading ?? false;
  const { state: pdfState, dispatch: pdfDispatch } = usePDFViewer();
  const isPdfOnLeft = pdfState.isOnLeft; // Check if PDF is positioned on the left

  const floatingMgr = useFloatingWindowManager();
  const notesStorage = React.useMemo(() => makeFloatingWindowStorage('notes-drawer'), []);
  const fw = useFloatingWindow({
    id: 'notes-drawer',
    initialMode: 'pinned-right',
    storage: notesStorage,
    defaultFloatingSize: { width: 720, height: 720 },
  });
  // Treat a viewer as "occupying side space" only when it's open AND in a
  // pinned mode. Floating viewers are positioned freely over the page and
  // must NOT compress the notes layout — otherwise notes locks itself at
  // 50vw and the chat behind it gets covered by the floating panel.
  // PDF wins if both are somehow open.
  const isPdfPinned = isPdfOpen && floatingMgr.modes['pdf-viewer'] !== 'floating';
  const isMarkdownPinned = isMarkdownViewerOpen && floatingMgr.modes['markdown-viewer'] !== 'floating';
  const isViewerOpen = isPdfPinned || isMarkdownPinned;
  const viewerIsOnLeft = isPdfPinned ? isPdfOnLeft : isMarkdownViewerOnLeft;
  const notesDrawer = useNotesDrawer(); // Access the notes drawer store
  const [drawerWidth, setDrawerWidth] = useState<string>('50');
  const [editorOrientation, setEditorOrientation] = useState<NotesEditorOrientation>('portrait');
  // Paper size + screen width — split out from the old binary
  // orientation toggle.  Source of truth for the toolbar's layout
  // popover; mutations are mirrored to CollaborativeNotesEditor via
  // a 'notes-set-layout' window CustomEvent.
  const [paperSize, setPaperSize] = useState<NotesPaperSize>('A4');
  // On mobile / narrow viewports the default screen-width is `full`
  // — there's no horizontal room for the paper margins or the block
  // gutter, so the editor uses every available pixel by default.
  // Desktop keeps the legacy `paper` default. The user can still
  // override via the page-head Page-width control; the saved
  // preference (loaded below) will win over this initial pick.
  const initialScreenWidth: NotesScreenWidth =
    typeof window !== 'undefined' && window.innerWidth <= 768 ? 'full' : 'paper';
  const [screenWidthPref, setScreenWidthPref] = useState<NotesScreenWidth>(initialScreenWidth);
  // Migration 116 — per-note page-head metadata. Loaded from the Note
  // payload when the drawer opens an existing note; mutations are
  // persisted via PUT /notes/{id} and stay reflected in state so the
  // PageHeadToolbar + CSS pipeline picks them up without a refetch.
  // `status` column was removed from the UI — backend keeps the value
  // as dead schema in case we re-introduce a different status concept.
  const [noteEmoji, setNoteEmoji] = useState<string | null>(null);
  const [noteHeaderImageUrl, setNoteHeaderImageUrl] = useState<string | null>(null);
  const [noteFontScale, setNoteFontScale] = useState<import('@/lib/api-notes').NoteFontScale | null>(null);
  const [notesContent, setNotesContent] = useState<string>('');
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved'>('idle');
  const saveStatusTimerRef = useRef<NodeJS.Timeout | null>(null);
  const [wasSidebarOpen, setWasSidebarOpen] = useState(false);
  const [noteId, setNoteId] = useState<string | null>(null);
  const [isInitialOpen, setIsInitialOpen] = useState(false);
  const [openedOnRight, setOpenedOnRight] = useState<boolean | null>(null);
  const [workspaceMembers, setWorkspaceMembers] = useState<WorkspaceMember[]>([]);
  const [_membersLoading, setMembersLoading] = useState(false);
  const [currentUserRole, setCurrentUserRole] = useState<'owner' | 'editor' | 'viewer' | null>(null);
  const [showShareDialog, setShowShareDialog] = useState(false);
  const [shareEmail, setShareEmail] = useState('');
  const [shareRole, setShareRole] = useState<'editor' | 'viewer'>('editor');
  const [isSharing, setIsSharing] = useState(false);
  const [permissionsReady, setPermissionsReady] = useState(false);
  const [isMounted, setIsMounted] = useState(false);
  const [showNewNoteDialog, setShowNewNoteDialog] = useState(false);
  const [showClearDialog, setShowClearDialog] = useState(false);
  const [isEditorReady, setIsEditorReady] = useState(false);
  const [showPaperDialog, setShowPaperDialog] = useState(false);
  const editorRef = useRef<Editor | null>(null);
  // Ref to the debounced autosave callable. Populated after `debouncedSave` is
  // declared further down; lets early handlers (e.g. handleSave in the menu bar)
  // call the save without a TDZ violation.
  const debouncedSaveRef = useRef<((content: string) => void) | null>(null);
  // Awaitable, immediate version of the same save. Used by handlers (e.g. File
  // → New Note) that must persist current content BEFORE clearing the editor —
  // the debounced variant returns void and the 3 s timer would fire after we
  // already wiped state, losing the in-progress note.
  const saveCurrentNoteImmediateRef = useRef<((content: string) => Promise<void>) | null>(null);

  // Research Context (G Layer 1) — per-note scope for AI actions, persisted in
  // localStorage; will move to a notes.research_context JSONB
  // column + gRPC later.
  const { collections } = useCollections();

  // Collections + Web are a SHARED scope with the chat toolbar (single
  // source of truth in useChatScopeStore). Agentic routing stays per-note
  // for now because the chat toolbar still owns its own agentic mode.
  const storeSelectedCollectionIds = useChatScopeStore((s) => s.selectedCollectionIds);
  const storeWebSearchEnabled = useChatScopeStore((s) => s.webSearchEnabled);
  const setStoreSelectedCollectionIds = useChatScopeStore((s) => s.setSelectedCollectionIds);
  const setStoreWebSearchEnabled = useChatScopeStore((s) => s.setWebSearchEnabled);

  const [researchContext, setResearchContextState] = useState<NoteResearchContext>(() =>
    getNoteResearchContext(noteId || sessionId)
  );
  // Keep the local context object in sync with the shared store so the
  // popover, label computation and API calls all see the same ids / web
  // flag as the chat toolbar.
  useEffect(() => {
    setResearchContextState((prev) => {
      if (
        prev.collectionIds.length === storeSelectedCollectionIds.length &&
        prev.collectionIds.every((id, i) => id === storeSelectedCollectionIds[i]) &&
        prev.webSearchEnabled === storeWebSearchEnabled
      ) {
        return prev;
      }
      return {
        ...prev,
        collectionIds: storeSelectedCollectionIds,
        webSearchEnabled: storeWebSearchEnabled,
        updatedAt: Date.now(),
      };
    });
  }, [storeSelectedCollectionIds, storeWebSearchEnabled]);
  const [contextPopoverOpen, setContextPopoverOpen] = useState(false);
  const [templateGalleryOpen, setTemplateGalleryOpen] = useState(false);
  // 7.9 — version history dialog (named saves, restore-with-undo, diff).
  const [versionHistoryOpen, setVersionHistoryOpen] = useState(false);
  // 7.3 — Compose from Sources dialog (RAG-grounded paragraph gen).
  const [composeOpen, setComposeOpen] = useState(false);
  // paginated open dialog (replaces the old sidebar list).
  const [openDialogOpen, setOpenDialogOpen] = useState(false);
  // bridging concepts panel (Poveži točkice).
  const [connectDotsOpen, setConnectDotsOpen] = useState(false);
  // whole-note GRADE fact-check panel.
  const [factCheckOpen, setFactCheckOpen] = useState(false);
  // 7.2 — outline template picker (IMRAD / lit_review / thesis / grant /
  // generic). Opens before generate_outline runs.
  const [outlineTemplateDialogOpen, setOutlineTemplateDialogOpen] = useState(false);
  /** category picked by a template-based create. Consumed by
   *  the first autosave that actually creates a row on the backend, then
   *  cleared so later edits don't repeatedly resend it. */
  const pendingTemplateCategoryRef = useRef<string | null>(null);
  // Non-native English mode toggle, persisted per user (localStorage).
  // Adds an ESL prompt variant to the Improve Writing action when enabled.
  const [nonNativeEnglishMode, setNonNativeEnglishMode] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    return window.localStorage.getItem('scrapalot_notes_esl_mode') === 'true';
  });
  // 7.6 — fullscreen + focus mode for the notes drawer.
  // Fullscreen makes the drawer take the entire viewport and hides app
  // chrome (sidebar, top bar) via a body-level CSS class. Focus mode
  // dims every paragraph/heading except the one containing the caret
  // so the writer can concentrate. Persisted per user in localStorage.
  const [notesFullscreen, setNotesFullscreen] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    return window.localStorage.getItem('scrapalot_notes_fullscreen') === 'true';
  });
  const [notesFocusMode, setNotesFocusMode] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    return window.localStorage.getItem('scrapalot_notes_focus_mode') === 'true';
  });
  // 7.10 — reading-mode preview. Locks the editor read-only, caps line
  // width, hides slash-command hints and edit chrome. Persisted per user.
  const [notesReadingMode, setNotesReadingMode] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    return window.localStorage.getItem('scrapalot_notes_reading_mode') === 'true';
  });
  // 7.10 — sepia / parchment theme. Mutually exclusive with the
  // global dark mode. Persisted per user; toggling on
  // forces the global dark class off so the parchment palette is
  // readable.
  const [notesSepiaMode, setNotesSepiaMode] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    return window.localStorage.getItem('scrapalot_notes_sepia_mode') === 'true';
  });
  // 7.1 — AI Autocomplete (ghost text). Off by default; the toolbar
  // toggle persists to localStorage and the AiAutocomplete TipTap
  // extension reads its initial enabled flag from the same key on
  // editor mount, then we sync at runtime via setAutocompleteEnabled().
  const [aiAutocompleteEnabled, setAiAutocompleteEnabled] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    return window.localStorage.getItem('scrapalot_notes_ai_autocomplete') === 'true';
  });
  // 7.1 cost guard — sliding-window quota counters surfaced in the
  // menu bar as "x of N used this hour" near the AI Autocomplete
  // toggle. Updated reactively from a custom event the extension
  // dispatches after every ghost-complete call.
  const [autocompleteQuota, setAutocompleteQuota] = useState<{ used: number; limit: number } | null>(null);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ used: number; limit: number }>).detail;
      if (!detail || typeof detail.used !== 'number' || typeof detail.limit !== 'number') return;
      setAutocompleteQuota({ used: detail.used, limit: detail.limit });
    };
    window.addEventListener('scrapalot:notes:autocomplete-quota', handler);
    return () => window.removeEventListener('scrapalot:notes:autocomplete-quota', handler);
  }, []);
  // listen for draft-from-research events and pre-populate
  // the editor with the synthesis content. Same decoupled pattern as
  // chat-with-document.
  useEffect(() => {
    const handler = (event: Event) => {
      const e = event as CustomEvent<DraftFromResearchPayload>;
      if (!e.detail?.markdown) return;
      const html = markdownToHtml(e.detail.markdown);
      const editor = editorRef.current;
      if (editor) {
        editor.commands.setContent(html);
      } else {
        notesContentRef.current = html;
      }
      toast({
        title: t('deepResearch.draftedAsNote.title', 'Drafted as note'),
        description: t('deepResearch.draftedAsNote.description', 'Research synthesis has been inserted into your note.'),
      });
    };
    window.addEventListener(DRAFT_FROM_RESEARCH_EVENT, handler);
    return () => window.removeEventListener(DRAFT_FROM_RESEARCH_EVENT, handler);
  }, [t]);

  // wire Generate Title / Abstract / Outline / Highlights
  // through existing TransformText RPC (the backend now accepts the new
  // transform types: 'title' | 'abstract' | 'highlights').
  const runWholeNoteGeneration = useCallback(
    async (kind: 'title' | 'abstract' | 'highlights', label: string) => {
      const editor = editorRef.current;
      if (!editor) return;
      const content = editor.getText();
      if (!content || content.trim().length < 50) {
        toast.warning({
          title: t('notes.menu.outlineEmpty.title', 'Note too short'),
          description: t('notes.menu.outlineEmpty.description', 'Add at least 50 characters before generating.'),
        });
        return;
      }
      try {
        setScopeBarActive(true);
        const { transformText } = await import('@/lib/api-notes-assistant');
        const { transformed_text } = await transformText(content, kind);
        if (kind === 'title') {
          // Put the generated title on the FIRST line. If the note already
          // starts with a heading, replace its text (keeps the heading level
          // and avoids a duplicated title stacked below the existing one).
          // Otherwise, prepend a new H1 at document position 0.
          const titleText = transformed_text.trim();
          const firstNode = editor.state.doc.firstChild;
          if (firstNode && firstNode.type.name === 'heading') {
            editor
              .chain()
              .focus()
              .insertContentAt({ from: 1, to: 1 + firstNode.content.size }, titleText)
              .run();
          } else {
            const html = markdownToHtml(`# ${titleText}\n\n`);
            editor.chain().focus().insertContentAt(0, html).run();
          }
        } else if (kind === 'abstract') {
          // Insert the abstract right after the leading heading (any H1–H6)
          // when the note opens with one. The previous \`focus('start')\` +
          // insertContent always landed at doc position 0 and shoved the
          // existing title downward, leaving the abstract above the
          // heading. Same first-child detection the title path uses.
          const html = markdownToHtml(`> ${transformed_text.trim()}\n\n`);
          const firstNode = editor.state.doc.firstChild;
          if (firstNode && firstNode.type.name === 'heading') {
            const insertPos = firstNode.nodeSize;
            editor.chain().focus().insertContentAt(insertPos, html).run();
          } else {
            editor.chain().focus('start').insertContent(html).run();
          }
        } else if (kind === 'highlights') {
          const heading = t('notes.menu.keyHighlightsHeading', 'Key highlights');
          const html = markdownToHtml(`\n\n## ${heading}\n\n${transformed_text.trim()}\n`);
          editor.chain().focus('end').insertContent(html).run();
        }
        // Kick the autosave explicitly. The TipTap onUpdate → 150 ms
        // onChange chain sometimes does not fire for programmatic
        // insertContentAt transactions while Y.js collaboration is
        // attached, so rely on the drawer-level debouncedSaveRef
        // instead of waiting for the editor's onChange event.
        const newHtml = editor.getHTML();
        notesContentRef.current = newHtml;
        debouncedSaveRef.current?.(newHtml);
        toast.success({
          title: t('notes.menu.generateDone.title', '{{label}} generated', { label }),
          description: t('notes.menu.generateDone.description', 'Inserted into the note.'),
        });
      } catch (err) {
        toast.error({
          title: t('notes.menu.generateFailed.title', 'Generation failed'),
          description: String(err instanceof Error ? err.message : err),
        });
      } finally {
        setScopeBarActive(false);
      }
    },
    [t]
  );
  const handleGenerateTitle = useCallback(() => runWholeNoteGeneration('title', 'Title'), [runWholeNoteGeneration]);

  // 7.7 — Thought Partner. Fire-and-insert: ask for 3-5 questions about
  // the current draft, render them as an ordered list inside a `review`
  // callout, append at the end of the note.
  const handleCritiqueWithQuestions = useCallback(async () => {
    const editor = editorRef.current;
    if (!editor) return;
    const text = editor.getText();
    if (!text || text.trim().length < 50) {
      toast.warning({
        title: t('notes.menu.outlineEmpty.title', 'Note too short'),
        description: t('notes.menu.outlineEmpty.description', 'Add at least 50 characters before generating.'),
      });
      return;
    }
    try {
      setScopeBarActive(true);
      const { critiqueWithQuestions } = await import('@/lib/api-notes-assistant');
      const html = editor.getHTML();
      const result = await critiqueWithQuestions(html);
      if (!result.success || !result.questions.length) {
        toast.error({
          title: t('notes.menu.generateFailed.title', 'Generation failed'),
          description: result.error || t('notes.menu.generateFailed.description', 'No questions returned.'),
        });
        return;
      }
      // Build an HTML snippet TipTap can re-parse straight back into a
      // callout node + ordered list. Markdown → HTML would also work
      // but goes through a heavier path; this is the same shape the
      // callout extension's renderHTML produces.
      const escape = (s: string) =>
        s.replace(/[<>&"']/g, (c) =>
          ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' }[c] || c),
        );
      const items = result.questions.map((q) => `<li><p>${escape(q)}</p></li>`).join('');
      const calloutHtml = `<div data-callout="" data-type="review"><ol>${items}</ol></div><p></p>`;
      editor.chain().focus('end').insertContent(calloutHtml).run();

      // Programmatic mutation — kick autosave explicitly (CLAUDE.md rule
      // #44: Y.js + chained insertContent doesn't always trigger onUpdate).
      const newHtml = editor.getHTML();
      notesContentRef.current = newHtml;
      debouncedSaveRef.current?.(newHtml);

      toast.success({
        title: t('notes.menu.generateDone.title', '{{label}} generated', {
          label: t('notes.menu.critiqueWithQuestions', 'Critique with questions'),
        }),
        description: t('notes.menu.generateDone.description', 'Inserted into the note.'),
      });
    } catch (err) {
      toast.error({
        title: t('notes.menu.generateFailed.title', 'Generation failed'),
        description: String(err instanceof Error ? err.message : err),
      });
    } finally {
      setScopeBarActive(false);
    }
  }, [t]);
  const handleGenerateAbstract = useCallback(() => runWholeNoteGeneration('abstract', 'Abstract'), [runWholeNoteGeneration]);
  const handleGenerateHighlights = useCallback(() => runWholeNoteGeneration('highlights', 'Highlights'), [runWholeNoteGeneration]);

  // Export the current note as a proper HTML file (preserves TipTap markup).
  const handleExportHtml = useCallback(() => {
    try {
      const title = generateNoteTitle(notesContent, t('notes.untitled'));
      const safeTitle = title.replace(/[<>&"]/g, (c) =>
        ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c] || c)
      );
      const html = `<!DOCTYPE html>
<html lang="${i18n.language || 'en'}">
<head>
<meta charset="utf-8" />
<title>${safeTitle}</title>
<style>
body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-width:800px;margin:2rem auto;padding:0 1rem;line-height:1.6;color:#222}
h1,h2,h3{line-height:1.25}blockquote{border-left:3px solid #cbd5e1;padding-left:.75rem;color:#475569;margin:1rem 0}
pre{background:#f1f5f9;padding:.75rem;overflow:auto;border-radius:.25rem}
table{border-collapse:collapse;margin:1rem 0}td,th{border:1px solid #cbd5e1;padding:.25rem .5rem}
</style>
</head>
<body>${notesContent}</body>
</html>`;
      const blob = new Blob([html], { type: 'text/html' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `notes-${sessionId || 'session'}-${new Date().toISOString().split('T')[0]}.html`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      toast({
        title: t('notes.toasts.notesDownloaded.title'),
        description: t('notes.toasts.notesDownloaded.description'),
      });
    } catch (error) {
      console.error('Error exporting HTML:', error);
      toast({
        title: t('notes.toasts.downloadFailed.title'),
        description: String(error instanceof Error ? error.message : error),
        variant: 'destructive',
      });
    }
  }, [notesContent, sessionId, t, i18n.language]);

  // 7.4 — LaTeX export. Pure client-side TipTap-JSON → .tex + .bib
  // converter. Walks the editor JSON tree (so we get clean node info,
  // not flattened HTML), emits \cite{} for inline citation marks, and
  // writes a paired references.bib alongside the .tex. No server hop —
  // the conversion is rule-based and runs in the browser.
  const handleExportLatex = useCallback(async () => {
    try {
      const editor = editorRef.current;
      if (!editor) return;
      const doc = editor.getJSON();
      const { tipTapToLatex } = await import('@/lib/tiptap-to-latex');
      const title = generateNoteTitle(notesContent, t('notes.untitled', 'Untitled'));
      const babel = (i18n.language || 'en').startsWith('hr') ? 'croatian' : 'english';
      const { tex, bib, citationCount } = tipTapToLatex(doc, {
        preamble: 'article',
        title,
        babelLanguage: babel,
      });
      const stem = `notes-${sessionId || 'session'}-${new Date().toISOString().split('T')[0]}`;
      const triggerDownload = (content: string, filename: string, mime: string) => {
        const blob = new Blob([content], { type: mime });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      };
      triggerDownload(tex, `${stem}.tex`, 'application/x-tex');
      if (bib) triggerDownload(bib, 'references.bib', 'application/x-bibtex');
      toast({
        title: t('notes.toasts.notesDownloaded.title', 'Exported'),
        description: bib
          ? t('notes.toasts.latexDownloaded.withBib', 'Downloaded .tex + references.bib ({{count}} citations).', { count: citationCount })
          : t('notes.toasts.latexDownloaded.noBib', 'Downloaded .tex.'),
      });
    } catch (error) {
      console.error('LaTeX export failed:', error);
      toast({
        title: t('notes.toasts.exportFailed.title', 'Export failed'),
        description: String(error instanceof Error ? error.message : error),
        variant: 'destructive',
      });
    }
  }, [notesContent, sessionId, t, i18n.language]);

  // 7.4 — LaTeX project ZIP for Overleaf round-trip. Bundles main.tex,
  // references.bib, and every embedded image into a single archive that
  // a user can drop into "Overleaf → New Project → Upload Project". The
  // doc walker first rewrites every image src to a stable basename
  // (`image-1.png`) and stores the binary payload, then runs the same
  // tipTapToLatex converter with `imagePath: 'images/'` so
  // `\includegraphics{image-1.png}` resolves against `images/` via
  // `\graphicspath`. base64 data URLs are decoded inline; remote URLs
  // are fetched (same-origin only by default — cross-origin fetches will
  // fall through with a warning toast and the image will be skipped).
  const handleExportLatexZip = useCallback(async () => {
    try {
      const editor = editorRef.current;
      if (!editor) return;
      // Deep clone so the rewriting does not mutate the live editor doc.
      const doc = JSON.parse(JSON.stringify(editor.getJSON())) as { type: string; content?: unknown[] };
      const imageMap = new Map<string, { filename: string; bytes: Uint8Array }>();
      let imageCounter = 0;
      let skippedImages = 0;

      const decodeDataUrl = (src: string): { ext: string; bytes: Uint8Array } | null => {
        const match = src.match(/^data:image\/([a-zA-Z0-9+]+);base64,(.+)$/);
        if (!match) return null;
        const rawExt = match[1].toLowerCase();
        const ext = rawExt === 'svg+xml' ? 'svg' : rawExt === 'jpeg' ? 'jpg' : rawExt;
        try {
          const binary = atob(match[2]);
          const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
          return { ext, bytes };
        } catch {
          return null;
        }
      };

      const fetchImage = async (src: string): Promise<{ ext: string; bytes: Uint8Array } | null> => {
        try {
          const resp = await fetch(src, { credentials: 'same-origin' });
          if (!resp.ok) return null;
          const buf = await resp.arrayBuffer();
          const path = src.split('?')[0];
          const pathExt = path.split('.').pop()?.toLowerCase() ?? '';
          const allowed = ['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'pdf'];
          const ext = allowed.includes(pathExt) ? (pathExt === 'jpeg' ? 'jpg' : pathExt) : 'png';
          return { ext, bytes: new Uint8Array(buf) };
        } catch {
          return null;
        }
      };

      const walk = async (node: { type?: string; attrs?: Record<string, unknown>; content?: unknown[] }) => {
        if (node.type === 'image' && node.attrs?.src) {
          const src = String(node.attrs.src);
          const cached = imageMap.get(src);
          if (cached) {
            node.attrs.src = cached.filename;
          } else {
            const decoded = src.startsWith('data:') ? decodeDataUrl(src) : await fetchImage(src);
            if (decoded) {
              imageCounter += 1;
              const filename = `image-${imageCounter}.${decoded.ext}`;
              imageMap.set(src, { filename, bytes: decoded.bytes });
              node.attrs.src = filename;
            } else {
              skippedImages += 1;
            }
          }
        }
        if (Array.isArray(node.content)) {
          for (const child of node.content) {
            await walk(child as { type?: string; attrs?: Record<string, unknown>; content?: unknown[] });
          }
        }
      };
      await walk(doc);

      const { tipTapToLatex } = await import('@/lib/tiptap-to-latex');
      const title = generateNoteTitle(notesContent, t('notes.untitled', 'Untitled'));
      const babel = (i18n.language || 'en').startsWith('hr') ? 'croatian' : 'english';
      const { tex, bib, citationCount } = tipTapToLatex(doc as never, {
        preamble: 'article',
        title,
        babelLanguage: babel,
        imagePath: 'images/',
      });

      const { zipSync, strToU8 } = await import('fflate');
      const files: Record<string, Uint8Array> = {
        'main.tex': strToU8(tex),
      };
      if (bib) files['references.bib'] = strToU8(bib);
      for (const { filename, bytes } of imageMap.values()) {
        files[`images/${filename}`] = bytes;
      }
      // Lightweight README so the recipient knows the layout without
      // having to open main.tex first.
      files['README.txt'] = strToU8(
        [
          'Scrapalot LaTeX export',
          '',
          'Files:',
          '  main.tex          — primary document (compile this)',
          bib ? '  references.bib    — BibTeX bibliography (used via biblatex)' : '',
          imageMap.size > 0 ? `  images/           — ${imageMap.size} embedded image(s)` : '',
          '',
          'Open in Overleaf:',
          '  1. https://www.overleaf.com → New Project → Upload Project',
          '  2. Pick this .zip',
          '  3. Set the main document to main.tex',
          '',
        ].filter(Boolean).join('\n'),
      );

      const zipped = zipSync(files);
      const stem = `notes-${sessionId || 'session'}-${new Date().toISOString().split('T')[0]}`;
      const blob = new Blob([zipped], { type: 'application/zip' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${stem}.zip`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      toast({
        title: t('notes.toasts.notesDownloaded.title', 'Exported'),
        description: t(
          'notes.toasts.latexZipDownloaded.description',
          'Downloaded LaTeX project zip — {{citations}} citations, {{images}} images. Upload to Overleaf via "New Project → Upload Project".',
          { citations: citationCount, images: imageMap.size },
        ) + (skippedImages > 0
          ? ' ' + t('notes.toasts.latexZipDownloaded.skipped', '({{count}} image(s) skipped — cross-origin fetch blocked.)', { count: skippedImages })
          : ''),
      });
    } catch (error) {
      console.error('LaTeX zip export failed:', error);
      toast({
        title: t('notes.toasts.exportFailed.title', 'Export failed'),
        description: String(error instanceof Error ? error.message : error),
        variant: 'destructive',
      });
    }
  }, [notesContent, sessionId, t, i18n.language]);

  // Direct PDF / DOCX export — converts the current editor HTML to markdown
  // client-side, sends it to the paper generator with template_key="passthrough"
  // (no LLM, just pandoc conversion), then downloads the returned file.
  // No dialog, no print prompt.
  const handleExportPassthrough = useCallback(async (format: 'pdf' | 'docx' | 'latex') => {
    try {
      const editor = editorRef.current;
      let html = editor?.getHTML() || notesContentRef.current || notesContent;
      if (!html || !html.trim()) {
        toast({
          title: t('notes.toasts.notesDownloaded.title', 'Export'),
          description: t('notes.menu.outlineEmpty.description', 'Note is empty — nothing to export.'),
        });
        return;
      }

      // Swap citation spans for Pandoc [@Key] before stripping HTML.
      let bibContent = '';
      if (editor) {
        const citations = collectCitations(editor);
        if (citations.size > 0) {
          const metas = Array.from(citations.values());
          citations.forEach((meta, docId) => {
            const key = generateCitationKey(meta);
            const pattern = new RegExp(
              `<span[^>]*data-document-id="${docId}"[^>]*>[^<]*</span>`,
              'g'
            );
            html = html.replace(pattern, `[@${key}]`);
          });
          bibContent = await toBibTeXBatch(metas);
        }
      }

      const markdown = html
        .replace(/<h1[^>]*>(.*?)<\/h1>/gi, '# $1\n')
        .replace(/<h2[^>]*>(.*?)<\/h2>/gi, '## $1\n')
        .replace(/<h3[^>]*>(.*?)<\/h3>/gi, '### $1\n')
        .replace(/<h4[^>]*>(.*?)<\/h4>/gi, '#### $1\n')
        .replace(/<strong[^>]*>(.*?)<\/strong>/gi, '**$1**')
        .replace(/<em[^>]*>(.*?)<\/em>/gi, '*$1*')
        .replace(/<u[^>]*>(.*?)<\/u>/gi, '$1')
        .replace(/<blockquote[^>]*>(.*?)<\/blockquote>/gi, '> $1\n')
        .replace(/<li[^>]*>(.*?)<\/li>/gi, '- $1\n')
        .replace(/<p[^>]*>(.*?)<\/p>/gi, '$1\n\n')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<div[^>]*data-bibliography[^>]*>.*?<\/div>/gis, '')
        .replace(/<[^>]+>/g, '')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&nbsp;/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .trim();

      toast({
        title: t('notes.toasts.exporting.title', 'Exporting…'),
        description: t('notes.toasts.exporting.description', 'Converting note to {{format}}.', { format: format.toUpperCase() }),
      });

      const result = await generatePaper({
        template_key: 'passthrough',
        output_format: format,
        notes_content: bibContent ? `${markdown}\n\n## References\n` : markdown,
      });

      if (result.status !== 'completed') {
        toast({
          title: t('notes.toasts.exportFailed.title', 'Export failed'),
          description: result.error_message || t('notes.toasts.exportFailed.description', 'Could not generate file.'),
          variant: 'destructive',
        });
        return;
      }

      // Fetch through apiClient so the Authorization header + cross-origin
      // API base URL (api.scrapalot.app/api/v1) are handled correctly.
      // window.open with a relative URL would hit scrapalot.app itself and 404.
      const blobResponse = await apiClient.get(
        `/papers/${result.paper_id}/download?format=${format}`,
        { responseType: 'blob' }
      );
      const blobUrl = URL.createObjectURL(blobResponse.data as Blob);
      const filenameBase = (result.title || 'note').replace(/[^a-zA-Z0-9-_ ]/g, '').trim() || 'note';
      const extensionMap: Record<string, string> = { pdf: 'pdf', docx: 'docx', latex: 'tex' };
      const extension = extensionMap[format] || format;
      const a = document.createElement('a');
      a.href = blobUrl;
      a.download = `${filenameBase}.${extension}`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(blobUrl);
      toast({
        title: t('notes.toasts.notesDownloaded.title', 'Downloaded'),
        description: result.title || t('notes.toasts.notesDownloaded.description', 'File saved.'),
      });
    } catch (err) {
      toast({
        title: t('notes.toasts.exportFailed.title', 'Export failed'),
        description: String(err instanceof Error ? err.message : err),
        variant: 'destructive',
      });
    }
  }, [notesContent, t]);

  // Word count & stats — pure client computation from the editor's text.
  const handleWordCount = useCallback(() => {
    const editor = editorRef.current;
    const text = editor?.getText() || '';
    const words = text.trim() ? text.trim().split(/\s+/).length : 0;
    const chars = text.length;
    const charsNoSpaces = text.replace(/\s+/g, '').length;
    // Avg reading speed: 200 wpm
    const readingMinutes = Math.max(1, Math.ceil(words / 200));
    toast({
      title: t('notes.menu.wordCountStats', 'Word count & stats'),
      description: t('notes.menu.wordCountResult', '{{words}} words · {{chars}} characters ({{charsNoSpaces}} without spaces) · ~{{minutes}} min read', {
        words, chars, charsNoSpaces, minutes: readingMinutes,
      }),
    });
  }, [t]);

  // Force a manual save flush + explicit feedback toast. The underlying
  // autosave already handles persistence; this is for users who want
  // visual confirmation.
  const handleSave = useCallback(() => {
    const editor = editorRef.current;
    const html = editor?.getHTML() || notesContentRef.current;
    notesContentRef.current = html;
    // Read the debounced save via ref to avoid TDZ — the actual function is
    // defined far below in the component body.
    debouncedSaveRef.current?.(html);
    toast({
      title: t('notes.toasts.noteSaved.title', 'Saving'),
      description: t('notes.toasts.noteSaved.description', 'Your changes are being saved.'),
    });
  }, [t]);

  // Duplicate — create a new note with the current editor content.
  const handleDuplicate = useCallback(async () => {
    if (!currentWorkspace?.id) return;
    try {
      const editor = editorRef.current;
      const html = editor?.getHTML() || notesContentRef.current;
      const baseTitle = generateNoteTitle(html, t('notes.untitled'));
      const newTitle = `${baseTitle} (${t('notes.copy', 'copy')})`;
      const created = await createNote({
        workspace_id: currentWorkspace.id,
        session_id: sessionId || null,
        content: html,
        title: newTitle,
      });
      toast({
        title: t('notes.toasts.duplicated.title', 'Duplicated'),
        description: t('notes.toasts.duplicated.description', 'New note: {{title}}', { title: newTitle }),
      });
      // Refresh list so the new note is visible in the sidebar
      void listNotes(currentWorkspace.id).catch(() => {});
      void created;
    } catch (err) {
      toast({
        title: t('notes.toasts.duplicateFailed.title', 'Duplicate failed'),
        description: String(err instanceof Error ? err.message : err),
        variant: 'destructive',
      });
    }
  }, [currentWorkspace?.id, sessionId, t]);

  // Translate whole note — uses existing translateText API on the plain text
  // and replaces the editor content with the translated version.
  const handleTranslateWholeNote = useCallback(async () => {
    const editor = editorRef.current;
    if (!editor) return;
    const text = editor.getText();
    if (!text || text.trim().length < 20) {
      toast.warning({
        title: t('notes.menu.outlineEmpty.title', 'Note too short'),
        description: t('notes.menu.outlineEmpty.description', 'Add at least 20 characters before translating.'),
      });
      return;
    }
    try {
      setScopeBarActive(true);
      const { translateText } = await import('@/lib/api-notes-assistant');
      const target = (i18n.language || 'en').startsWith('hr') ? 'en' : 'hr';
      const { translated_text } = await translateText(text, target);
      const html = markdownToHtml(translated_text);
      editor.commands.setContent(html);
      toast.success({
        title: t('notes.menu.translateDone.title', 'Translated'),
        description: t('notes.menu.translateDone.description', 'Whole note translated to {{lang}}.', { lang: target }),
      });
    } catch (err) {
      toast.error({
        title: t('notes.menu.generateFailed.title', 'Generation failed'),
        description: String(err instanceof Error ? err.message : err),
      });
    } finally {
      setScopeBarActive(false);
    }
  }, [i18n.language, t]);

  // 7.2 — open the template picker. The actual outline generation runs
  // inside `runGenerateOutline` once the user picks a template (or the
  // legacy generic option).
  const handleGenerateOutline = useCallback(() => {
    const editor = editorRef.current;
    if (!editor) return;
    const content = editor.getText();
    if (!content || content.trim().length < 50) {
      toast.warning({
        title: t('notes.menu.outlineEmpty.title', 'Note too short'),
        description: t('notes.menu.outlineEmpty.description', 'Add at least 50 characters before generating an outline.'),
      });
      return;
    }
    setOutlineTemplateDialogOpen(true);
  }, [t]);

  const runGenerateOutline = useCallback(async (templateType: import('@/lib/api-notes-assistant').OutlineTemplate) => {
    const editor = editorRef.current;
    if (!editor) return;
    const content = editor.getText();
    if (!content || content.trim().length < 50) return;
    try {
      setScopeBarActive(true);
      const { generateOutline } = await import('@/lib/api-notes-assistant');
      const { formatted_outline } = await generateOutline(content, researchContext.collectionIds, templateType);
      const html = markdownToHtml(`\n\n${formatted_outline}\n`);
      editor.chain().focus('end').insertContent(html).run();
      toast.success({
        title: t('notes.menu.outlineDone.title', 'Outline generated'),
        description: t('notes.menu.outlineDone.description', 'Outline appended to the end of the note.'),
      });
    } catch (err) {
      toast.error({
        title: t('notes.menu.outlineFailed.title', 'Outline failed'),
        description: String(err instanceof Error ? err.message : err),
      });
    } finally {
      setScopeBarActive(false);
    }
  }, [researchContext.collectionIds, t]);

  const toggleNonNativeEnglishMode = useCallback(() => {
    setNonNativeEnglishMode((prev) => {
      const next = !prev;
      try {
        window.localStorage.setItem('scrapalot_notes_esl_mode', String(next));
      } catch {
        /* noop */
      }
      return next;
    });
  }, []);

  // 7.6 — fullscreen + focus-mode toggles, both persisted to localStorage.
  const toggleNotesFullscreen = useCallback(() => {
    setNotesFullscreen((prev) => {
      const next = !prev;
      try { window.localStorage.setItem('scrapalot_notes_fullscreen', String(next)); } catch { /* noop */ }
      return next;
    });
  }, []);
  const toggleNotesFocusMode = useCallback(() => {
    setNotesFocusMode((prev) => {
      const next = !prev;
      try { window.localStorage.setItem('scrapalot_notes_focus_mode', String(next)); } catch { /* noop */ }
      return next;
    });
  }, []);
  const toggleNotesReadingMode = useCallback(() => {
    setNotesReadingMode((prev) => {
      const next = !prev;
      try { window.localStorage.setItem('scrapalot_notes_reading_mode', String(next)); } catch { /* noop */ }
      return next;
    });
  }, []);
  // Sepia is scoped to the drawer only — the parchment palette is
  // applied via `body.notes-sepia-mode.notes-drawer-open [data-testid="notes-drawer"]`
  // selectors in notes-drawer.css. The rest of the app keeps whatever
  // global theme (light or dark) the user has set.
  const toggleNotesSepiaMode = useCallback(() => {
    setNotesSepiaMode((prev) => {
      const next = !prev;
      try { window.localStorage.setItem('scrapalot_notes_sepia_mode', String(next)); } catch { /* noop */ }
      return next;
    });
  }, []);
  // 7.1 — flip the AiAutocomplete extension on/off. Both updates the
  // React-side menu state (so the menubar shows the ON/OFF badge) and
  // calls into the editor command so the plugin starts / stops firing
  // without a remount.
  const toggleAiAutocomplete = useCallback(() => {
    setAiAutocompleteEnabled((prev) => {
      const next = !prev;
      try { window.localStorage.setItem('scrapalot_notes_ai_autocomplete', String(next)); } catch { /* noop */ }
      const ed = editorRef.current;
      if (ed && !ed.isDestroyed) {
        // Type-loose: the command is added by the extension; we can't
        // reach it through TipTap's strict declared types from here
        // because the augmentation lives in the extension file.
        const cmds = ed.commands as unknown as { setAutocompleteEnabled?: (v: boolean) => boolean };
        cmds.setAutocompleteEnabled?.(next);
      }
      return next;
    });
  }, []);

  // Apply fullscreen / focus-mode / reading-mode classes to <body> so
  // global rules (hide app sidebar, suppress page scroll, dim non-active
  // paragraphs, cap reading line width) can take effect from
  // notes-drawer.css. Cleaned up on unmount and toggle-off.
  useEffect(() => {
    if (typeof document === 'undefined') return;
    document.body.classList.toggle('notes-fullscreen', notesFullscreen);
    document.body.classList.toggle('notes-focus-mode', notesFocusMode);
    document.body.classList.toggle('notes-reading-mode', notesReadingMode);
    document.body.classList.toggle('notes-sepia-mode', notesSepiaMode);
    return () => {
      document.body.classList.remove('notes-fullscreen');
      document.body.classList.remove('notes-focus-mode');
      document.body.classList.remove('notes-reading-mode');
      document.body.classList.remove('notes-sepia-mode');
    };
  }, [notesFullscreen, notesFocusMode, notesReadingMode, notesSepiaMode]);

  // 7.10 — flip the editor read-only when reading mode toggles. Done
  // imperatively (editor.setEditable) instead of through a prop so the
  // change happens without unmounting + remounting the TipTap editor
  // (which would lose Y.js sync state).
  useEffect(() => {
    const ed = editorRef.current;
    if (!ed || ed.isDestroyed) return;
    ed.setEditable(!notesReadingMode);
  }, [notesReadingMode]);

  // Ctrl/Cmd+Shift+F shortcut for fullscreen toggle. Listens at document
  // level so it works whether the editor or any drawer button has focus.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const onKey = (e: KeyboardEvent) => {
      const meta = e.ctrlKey || e.metaKey;
      if (meta && e.shiftKey && (e.key === 'F' || e.key === 'f')) {
        // Only inside an open drawer — otherwise let the browser handle it.
        if (!isOpen) return;
        e.preventDefault();
        toggleNotesFullscreen();
      } else if (e.key === 'Escape' && isOpen) {
        // Escape priority: focus mode → fullscreen → close drawer.
        // Focus mode and fullscreen are "distraction-free" toggles that
        // should bail out first; only after both are off does Escape
        // close the whole editor (mirrors the X button and mobile back).
        // If a Radix overlay (popover/dialog/menu) is open, let it handle
        // Escape first instead of closing the drawer underneath.
        if (document.querySelector('[data-radix-popper-content-wrapper], [data-state="open"][role="dialog"], [data-state="open"][role="menu"], [data-state="open"][role="listbox"]')) {
          return;
        }
        e.preventDefault();
        if (notesFocusMode) {
          setNotesFocusMode(false);
          try { window.localStorage.setItem('scrapalot_notes_focus_mode', 'false'); } catch { /* noop */ }
        } else if (notesFullscreen) {
          setNotesFullscreen(false);
          try { window.localStorage.setItem('scrapalot_notes_fullscreen', 'false'); } catch { /* noop */ }
        } else {
          onClose();
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isOpen, notesFocusMode, notesFullscreen, toggleNotesFullscreen, onClose]);

  // Mobile back gesture (Android back button / iOS swipe-back) closes the
  // drawer. Push a synthetic history entry on open so popstate fires when
  // the user navigates back instead of leaving the app entirely.
  useEffect(() => {
    if (!isOpen) return;

    let closedViaHistory = false;
    window.history.pushState({ notesDrawer: true }, '');

    const onPopState = () => {
      closedViaHistory = true;
      onClose();
    };
    window.addEventListener('popstate', onPopState);
    return () => {
      window.removeEventListener('popstate', onPopState);
      if (!closedViaHistory && window.history.state?.notesDrawer) {
        window.history.back();
      }
    };
  }, [isOpen, onClose]);
  const handleTemplateSelect = useCallback(
    (template: NoteTemplate) => {
      const editor = editorRef.current;
      // Prefer the localised skeleton if available; fall back to the English one from the catalog.
      const localisedSkeleton = t(`templateGallery.templates.${template.id}.skeleton`, template.skeleton);
      const html = markdownToHtml(localisedSkeleton);
      if (editor) {
        editor.commands.setContent(html);
      } else {
        notesContentRef.current = html;
      }
      // stash the template's category so the first backend
      // create call picks it up. Consumed + cleared there.
      pendingTemplateCategoryRef.current = template.category;
      if (template.defaultResearchContext) {
        const next = setNoteResearchContext(noteId || sessionId, {
          ...template.defaultResearchContext,
          autoDetected: true,
        });
        setResearchContextState(next);
      }
      const localisedName = t(`templateGallery.templates.${template.id}.name`, template.name);
      toast({
        title: t('templateGallery.toastApplied.title', 'Template applied'),
        description: t('templateGallery.toastApplied.description', '{{name}} skeleton inserted.', { name: localisedName }),
      });
    },
    [noteId, sessionId, t]
  );

  /**
   * "Save as new template" menu handler.
   * Prompts for a name (blocking window.prompt; a dialog would be
   * nicer but would drag the whole template-create form in for what
   * is ultimately a rarely-used action), then POSTs the current note
   * body + title as the user's own template.
   */
  const handleSaveAsTemplate = useCallback(async () => {
    if (!currentWorkspace?.id) {
      toast({
        title: t('notes.saveAsTemplate.noWorkspace.title', 'No workspace'),
        description: t('notes.saveAsTemplate.noWorkspace.description', 'Open a workspace before saving a template.'),
        variant: 'destructive',
      });
      return;
    }
    const html = editorRef.current?.getHTML() || notesContentRef.current;
    if (!html || isContentEmpty(html)) {
      toast({
        title: t('notes.saveAsTemplate.empty.title', 'Note is empty'),
        description: t('notes.saveAsTemplate.empty.description', 'Add some content before saving a template.'),
        variant: 'destructive',
      });
      return;
    }
    const defaultName = generateNoteTitle(html, t('notes.untitled')) || 'My template';
    const name = window.prompt(
      t('notes.saveAsTemplate.prompt', 'Template name'),
      defaultName,
    )?.trim();
    if (!name) return;
    try {
      await createUserNoteTemplate({
        workspace_id: currentWorkspace.id,
        name,
        skeleton: html,
        category: undefined,
        default_research_context: researchContext as unknown as Record<string, unknown>,
      });
      toast({
        title: t('notes.saveAsTemplate.saved.title', 'Template saved'),
        description: t('notes.saveAsTemplate.saved.description', '"{{name}}" is now available in the template gallery.', { name }),
      });
    } catch (err) {
      console.error('[notes-drawer] saveAsTemplate failed:', err);
      toast({
        title: t('notes.saveAsTemplate.failed.title', 'Could not save template'),
        description: t('notes.saveAsTemplate.failed.description', 'The server rejected the request. Try again in a moment.'),
        variant: 'destructive',
      });
    }
  }, [currentWorkspace?.id, researchContext, t]);
  useEffect(() => {
    // Paint cached value immediately, then reconcile with server.
    setResearchContextState(getNoteResearchContext(noteId || sessionId));
    if (!noteId) return; // session-draft ids stay localStorage-only
    let cancelled = false;
    void fetchNoteResearchContextFromServer(noteId).then((remote) => {
      if (cancelled || !remote) return;
      // Server value overwrites cache so the two stay in sync.
      const next = setNoteResearchContext(noteId, remote);
      setResearchContextState(next);
    });
    return () => {
      cancelled = true;
    };
  }, [noteId, sessionId]);

  // Debounce server writes — the collection selector fires rapid patches
  // when a user clicks through many collections, and we don't need every
  // intermediate state on disk.
  const researchContextSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const updateResearchContext = useCallback(
    (patch: Partial<NoteResearchContext>) => {
      // Collections + Web are pushed to the shared chat-scope store so
      // chat toolbar sees the change too. Agentic routing stays per-note.
      if (patch.collectionIds !== undefined) {
        setStoreSelectedCollectionIds(patch.collectionIds);
      }
      if (patch.webSearchEnabled !== undefined) {
        setStoreWebSearchEnabled(patch.webSearchEnabled);
      }
      const next = setNoteResearchContext(noteId || sessionId, patch);
      setResearchContextState(next);
      // Server sync — only for real notes with a UUID id.
      if (noteId) {
        if (researchContextSaveTimer.current) {
          clearTimeout(researchContextSaveTimer.current);
        }
        researchContextSaveTimer.current = setTimeout(() => {
          void saveNoteResearchContextToServer(noteId, next);
        }, 600);
      }
    },
    [noteId, sessionId, setStoreSelectedCollectionIds, setStoreWebSearchEnabled]
  );
  // Flush pending writes when the drawer unmounts so the user doesn't
  // lose the last click if they close immediately after a change.
  useEffect(() => {
    return () => {
      if (researchContextSaveTimer.current) {
        clearTimeout(researchContextSaveTimer.current);
        researchContextSaveTimer.current = null;
      }
    };
  }, []);
  const collectionNameLookup = React.useMemo(
    () => Object.fromEntries(collections.map((c) => [c.id, c.name])),
    [collections]
  );
  // Scope label used by the transient status bar during an AI operation.
  // Always returns a human-readable string — when no collections are
  // selected the caller treats it as "search ALL collections" (default
  // semantics), not empty state.
  const researchScopeLabel = React.useMemo(
    () =>
      formatResearchScopeLabel(researchContext, collectionNameLookup, {
        allCollections: t('notes.researchContext.allCollections', 'All collections'),
        web: t('notes.researchContext.webShort', 'Web'),
      }),
    [researchContext, collectionNameLookup, t]
  );

  // While any AI whole-note generation is running we surface the scope
  // status bar. runWholeNoteGeneration toggles this flag around the API
  // call; the bar auto-hides when it flips back to false.
  const [scopeBarActive, setScopeBarActive] = useState(false);

  // Load persisted layout (orientation + paper size + screen width)
  // once at mount so the toolbar popover reflects the editor state.
  // The editor reloads the same prefs independently for its own
  // state — that's intentional duplication; it lets the editor
  // mount before the drawer's prefs land if they ever desync.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const prefs = await getNotesEditorPreferences();
      if (cancelled || !prefs) return;
      if (prefs.orientation) setEditorOrientation(prefs.orientation);
      if (prefs.paper_size) setPaperSize(prefs.paper_size);
      if (prefs.screen_width) setScreenWidthPref(prefs.screen_width);
    })();
    return () => { cancelled = true; };
  }, []);

  // Layout-popover mutators.  Each one updates the local mirror AND
  // dispatches a single consolidated 'notes-set-layout' event so the
  // editor mirrors the change.  Editor's own debounced effect writes
  // the canonical row to /settings/user/notes_editor_preferences.
  const dispatchLayoutEvent = useCallback(
    (detail: { paperSize?: NotesPaperSize; orientation?: NotesEditorOrientation; screenWidth?: NotesScreenWidth }) => {
      window.dispatchEvent(new CustomEvent('notes-set-layout', { detail }));
    },
    [],
  );
  const setLayoutPaperSize = useCallback(
    (size: NotesPaperSize) => {
      setPaperSize(size);
      dispatchLayoutEvent({ paperSize: size });
    },
    [dispatchLayoutEvent],
  );
  const setLayoutOrientation = useCallback(
    (orientation: NotesEditorOrientation) => {
      setEditorOrientation(orientation);
      dispatchLayoutEvent({ orientation });
    },
    [dispatchLayoutEvent],
  );
  const setLayoutScreenWidth = useCallback(
    (width: NotesScreenWidth) => {
      setScreenWidthPref(width);
      dispatchLayoutEvent({ screenWidth: width });
    },
    [dispatchLayoutEvent],
  );

  // Open document viewer when citation mark is clicked in notes editor
  useEffect(() => {
    const handleOpenDoc = async (e: Event) => {
      const { documentId, filename, collectionId, title } = (e as CustomEvent).detail || {};
      if (!documentId) return;

      // Check if document has a file before opening viewer
      try {
        const { getDocumentById } = await import('@/lib/api-documents');
        const doc = await getDocumentById(documentId);
        if (!doc?.file_size || doc.file_size === 0) {
          toast.info(t('notes.citation.noFileStored', 'This document has no file stored on the server.'));
          return;
        }
      } catch {
        // If check fails, try opening anyway
      }

      const ext = (filename || '').split('.').pop()?.toLowerCase();
      const url = `/documents/${documentId}/file`;
      const docTitle = title || filename || 'Document';
      if (ext === 'epub') {
        window.dispatchEvent(new CustomEvent('open-epub-viewer-request', { detail: { url, documentId, documentTitle: docTitle, collectionId } }));
      } else {
        pdfDispatch({ type: 'OPEN_PDF_VIEWER', payload: { url, documentId, documentTitle: docTitle, citationId: 0, collectionId } });
      }
    };
    window.addEventListener('open-document-viewer', handleOpenDoc);
    return () => window.removeEventListener('open-document-viewer', handleOpenDoc);
  }, [pdfDispatch, t]);

  // Mobile gesture support
  const [touchStart, setTouchStart] = useState<{ x: number; y: number } | null>(null);
  const [touchCurrent, setTouchCurrent] = useState<{ x: number; y: number } | null>(null);
  const [swipeProgress, setSwipeProgress] = useState(0);

  const prevIsOpenRef = useRef<boolean>(false);
  const drawerRef = useRef<HTMLDivElement>(null);

  // Helper function to calculate width considering the sidebar
  const calculateWidth = (widthValue: string): string => {
    // On narrow screens (< 992px), always use full width
    if (isNarrowScreen) {
      return '100%';
    }

    return widthValue === '100'
      ? `calc(100% - ${ICON_SIDEBAR_WIDTH}px)`
      : `${widthValue}%`;
  };

  // Calculate position based on sidebar state, screen size, and captured opening position
  const calculatePosition = () => {
    // On narrow screens, make it truly full screen
    if (isNarrowScreen) {
      return {
        width: '100vw',
        height: '100vh',
        right: '0',
        left: '0',
        top: '0',
        bottom: '0',
        transform: 'translateX(0px)',
      };
    }

    // Use the captured opening position (first come, first served)
    // If we opened on right, stay on right. If on left, stay on left.
    // Considers both PDF and markdown-viewer positions — if either is on the
    // LEFT, Notes goes on the RIGHT, and vice versa.
    const defaultPosition = isViewerOpen ? viewerIsOnLeft : true;
    const shouldBeOnRight = openedOnRight !== null ? openedOnRight : defaultPosition;

    if (!shouldBeOnRight && !isNarrowScreen) {
      // Notes on LEFT side
      // Account for sidebar: if open, use CONVERSATIONS_SIDEBAR_WIDTH, otherwise use ICON_SIDEBAR_WIDTH
      const sidebarWidth = isSidebarOpen ? CONVERSATIONS_SIDEBAR_WIDTH : ICON_SIDEBAR_WIDTH;
      return {
        width: `calc(50vw - ${sidebarWidth}px)`, // Half viewport minus actual sidebar width
        left: `${sidebarWidth}px`, // LEFT side after sidebar (full or icon-only)
        right: 'auto',
        transform: 'translateX(0px)',
      };
    }

    // Notes on RIGHT side (default)
    const width = isViewerOpen ? 'calc(50vw)' : calculateWidth(drawerWidth);
    return {
      width,
      right: '0',
      left: 'auto',
      transform: isSidebarOpen
        ? `translateX(-${CONVERSATIONS_SIDEBAR_WIDTH - ICON_SIDEBAR_WIDTH}px)`
        : 'translateX(0px)',
    };
  };

  // Set up responsive width
  useEffect(() => {
    function setupResponsiveWidth() {
      const screenWidth = window.innerWidth;
      let width: string;

      if (screenWidth < 768) {
        width = '100';
      } else if (screenWidth < 1280) {
        width = '45';
      } else {
        width = '50';
      }

      setDrawerWidth(width);
    }

    if (isOpen) {
      setupResponsiveWidth();
      window.addEventListener('resize', setupResponsiveWidth);
    }

    return () => {
      window.removeEventListener('resize', setupResponsiveWidth);
    };
  }, [isOpen]);

  // Prevent portal components from rendering before drawer is mounted
  useEffect(() => {
    if (isOpen) {
      // Small delay to ensure DOM is ready before rendering portals
      const timer = setTimeout(() => setIsMounted(true), 50);
      return () => clearTimeout(timer);
    } else {
      setIsMounted(false);
    }
  }, [isOpen]);

  // Delay editor rendering to prevent insertBefore errors when rapidly opening/closing
  // or when opening immediately after page load while React is still reconciling
  useEffect(() => {
    if (isOpen && isMounted) {
      // Use a 350ms delay to ensure:
      // 1. React initial reconciliation is complete (especially during page load)
      // 2. Previous editor has fully cleaned up
      // 3. DOM is stable for new editor
      // 4. Any portal container DOM operations have settled
      // Note: The EditorContentErrorBoundary provides additional protection
      const timer = setTimeout(() => {
        setIsEditorReady(true);
      }, 350);

      return () => {
        clearTimeout(timer);
      };
    } else {
      // Immediately mark as not ready when closing
      setIsEditorReady(false);
    }
  }, [isOpen, isMounted]);

  // Handle initial open animation flag and capture opening position
  useEffect(() => {
    const wasOpen = prevIsOpenRef.current;
    const justOpened = !wasOpen && isOpen;

    if (justOpened) {
      // Drawer just opened - capture position and trigger animation. The
      // captured side is the OPPOSITE of any open viewer (PDF or markdown);
      // if no viewer is open we get the right side as default.
      const opensOnRight = isViewerOpen ? viewerIsOnLeft : true;
      setOpenedOnRight(opensOnRight);
      setIsInitialOpen(true);

      // Update global store with position
      notesDrawer.setPosition(!opensOnRight); // isOnLeft = !opensOnRight

      // Remove animation class after animation completes
      const timer = setTimeout(() => {
        setIsInitialOpen(false);
      }, 500); // Match animation duration

      prevIsOpenRef.current = true;
      return () => clearTimeout(timer);
    } else if (!isOpen && wasOpen) {
      // Drawer just closed - reset for next open
      setOpenedOnRight(null);
      prevIsOpenRef.current = false;
    }
    // If isOpen hasn't changed, do nothing (prevents re-animation when isPdfOpen changes)
  }, [isOpen, isPdfOpen, notesDrawer]);

  // When a viewer (PDF / markdown) gets pinned to the same side notes is
  // already on (e.g. user pins a previously-floating PDF to the right while
  // notes is on the right), yield to the viewer and flip notes to the
  // opposite side. Without this, both panels stack on top of each other on
  // the same half and the chat collapses to a sliver. The viewer is the
  // primary content; notes is a side helper, so notes moves.
  useEffect(() => {
    if (!isOpen || !isViewerOpen || fw.isFloating) return;
    const notesOnRight = openedOnRight !== null ? openedOnRight : true;
    const viewerOnRight = !viewerIsOnLeft;
    if (notesOnRight === viewerOnRight) {
      const flipped = !notesOnRight;
      setOpenedOnRight(flipped);
      useNotesDrawer.getState().setPosition(!flipped); // isOnLeft = !openedOnRight
    }
    // notesDrawer is intentionally excluded — Zustand returns a fresh
    // object reference on every state update, which would re-trigger
    // this effect and cause "Maximum update depth exceeded". Reach for
    // the stable action via getState() instead.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, isViewerOpen, viewerIsOnLeft, openedOnRight, fw.isFloating]);

  // Manage sidebar state when drawer opens/closes
  useEffect(() => {
    if (isOpen) {
      setWasSidebarOpen(isSidebarOpen);

      if (isSidebarOpen) {
        toggleSidebar();
      }
    } else if (wasSidebarOpen && !isSidebarOpen) {
      toggleSidebar();
    }
  }, [isOpen, isSidebarOpen, toggleSidebar, wasSidebarOpen]);

  // Migration 116 — page-head metadata helpers. `applyLoadedNoteMetadata`
  // mirrors the four columns from the API payload into local state when a
  // note loads; `resetLoadedNoteMetadata` clears them when no note is
  // selected so the toolbar shows the "Add emoji / Status / Header image"
  // affordances rather than stale values from the previous note.
  const applyLoadedNoteMetadata = useCallback((note: {
    emoji?: string | null;
    header_image_url?: string | null;
    font_scale?: import('@/lib/api-notes').NoteFontScale | null;
  }) => {
    setNoteEmoji(note.emoji ?? null);
    setNoteHeaderImageUrl(note.header_image_url ?? null);
    setNoteFontScale(note.font_scale ?? null);
  }, []);

  const resetLoadedNoteMetadata = useCallback(() => {
    setNoteEmoji(null);
    setNoteHeaderImageUrl(null);
    setNoteFontScale(null);
  }, []);

  // Generic page-head field setter. Optimistic update first, then PUT
  // /notes/{id} with tri-state semantics (null → "" so backend clears).
  // We deliberately skip auto-versioning for these fields (`createVersion:
  // false`) — toggling Draft → In progress or swapping a banner image is
  // metadata, not body content; auto-snapshotting on every click would
  // pollute the version history.
  const persistPageHeadField = useCallback(
    async (patch: import('@/lib/api-notes').UpdateNoteRequest) => {
      if (!noteId) {
        // Nothing to persist against yet — the note hasn't been created.
        // The state is still updated locally so the UI reflects the choice
        // immediately; the next content-save will create the row and the
        // metadata will be folded in on the FOLLOWING update.
        return;
      }
      try {
        await updateNote(noteId, { ...patch, createVersion: false });
      } catch (err) {
        console.error('[NotesDrawer] page-head save failed:', err);
        toast({
          title: t('notes.pageHead.saveFailed.title', 'Failed to save'),
          description: t(
            'notes.pageHead.saveFailed.description',
            'Could not save page metadata. Please retry.',
          ),
        });
      }
    },
    [noteId, t, toast],
  );

  const handlePageHeadEmojiChange = useCallback(
    (next: string | null) => {
      setNoteEmoji(next);
      void persistPageHeadField({ emoji: next ?? '' });
    },
    [persistPageHeadField],
  );

  const handlePageHeadHeaderImageChange = useCallback(
    (next: string | null) => {
      setNoteHeaderImageUrl(next);
      void persistPageHeadField({ header_image_url: next ?? '' });
    },
    [persistPageHeadField],
  );

  const handlePageHeadFontScaleChange = useCallback(
    (next: import('@/lib/api-notes').NoteFontScale | null) => {
      setNoteFontScale(next);
      void persistPageHeadField({ font_scale: next ?? '' });
    },
    [persistPageHeadField],
  );

  const handleUploadHeaderImage = useCallback(
    async (file: File): Promise<string> => {
      // Reuse the existing /notes/upload-image endpoint (same one the
      // editor's inline-image extension calls). Returns an absolutised
      // URL ready to drop into <img src>.
      const { uploadImage } = await import('./extensions/image-upload-handler');
      const result = await uploadImage(file);
      return result.url;
    },
    [],
  );

  // Load notes from database when drawer opens
  useEffect(() => {
    const loadNotes = async () => {
      // Load the most recently updated note in the workspace.
      const loadLastNote = async (workspaceId: string) => {
        const notes = await listNotes(workspaceId, 'all');
        if (notes && notes.length > 0) {
          // Sort by updated_at to get the most recent note
          const sortedNotes = notes.sort((a, b) =>
            new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime()
          );
          const lastNote = sortedNotes[0];
          setNoteId(lastNote.id);
          const htmlContent = lastNote.content || '';
          setNotesContent(htmlContent);
          applyLoadedNoteMetadata(lastNote);
          console.log('[NotesDrawer] Loaded last edited note:', lastNote.id);
        } else {
          // No notes exist, start fresh
          setNotesContent('');
          setNoteId(null);
          resetLoadedNoteMetadata();
        }
      };

      if (isOpen && currentWorkspace?.id) {
        try {
          // If noteId is provided (clicked from sidebar), load that specific note
          if (propsNoteId) {
            const note = await getNote(propsNoteId);
            setNoteId(note.id);
            // Load HTML content from the note
            const htmlContent = note.content || '';
            setNotesContent(htmlContent);
            applyLoadedNoteMetadata(note);
          }
          // Otherwise, try to load note for current session
          else if (sessionId) {
            const noteIdKey = `note-id-${sessionId}`;
            const savedNoteId = localStorage.getItem(noteIdKey);

            if (savedNoteId) {
              const note = await getNote(savedNoteId);
              setNoteId(note.id);
              // Load HTML content from the note
              const htmlContent = note.content || '';
              setNotesContent(htmlContent);
              applyLoadedNoteMetadata(note);
            } else {
              // No existing note for this session, try to load the last edited note
              await loadLastNote(currentWorkspace.id);
            }
          } else {
            // No session or note specified, try to load the last edited note
            await loadLastNote(currentWorkspace.id);
          }
        } catch (error) {
          console.error('Error loading notes:', error);
          // Fallback to localStorage
          if (sessionId) {
            const savedNotes = localStorage.getItem(`notes-${sessionId}`);
            if (savedNotes) {
              setNotesContent(savedNotes);
            } else {
              setNotesContent('');
            }
          }
        }
      }
    };

    void loadNotes();
  }, [isOpen, sessionId, propsNoteId, currentWorkspace?.id]);

  // Load workspace members when drawer opens
  // Reset states when drawer closes
  useEffect(() => {
    if (!isOpen) {
      setCurrentUserRole(null);
      setWorkspaceMembers([]);
      setMembersLoading(false);
      setPermissionsReady(false);
    }
  }, [isOpen]);

  // Force permissions ready after 3 seconds to prevent infinite loading
  useEffect(() => {
    if (isOpen && !permissionsReady) {
      const timeout = setTimeout(() => {
        console.warn('Permissions loading timeout - forcing ready state');
        setPermissionsReady(true);
        // If no role was set, default to viewer
        if (currentUserRole === null) {
          setCurrentUserRole('viewer');
        }
      }, 3000);

      return () => clearTimeout(timeout);
    }
  }, [isOpen, permissionsReady, currentUserRole]);

  useEffect(() => {
    const loadWorkspaceMembers = async () => {
      // For new documents (no noteId), skip permission loading and grant full access
      if (isOpen && !propsNoteId && user?.id) {
        console.log('New document - skipping permissions check, granting owner role');
        setCurrentUserRole('owner');
        setPermissionsReady(true);
        setMembersLoading(false);
        return;
      }

      console.log('loadWorkspaceMembers called:', {
        isOpen,
        noteId: propsNoteId,
        workspaceId: currentWorkspace?.id,
        userId: user?.id,
        workspaceLoading,
        shouldProceed: isOpen && currentWorkspace?.id && user?.id && !workspaceLoading,
      });

      if (isOpen && currentWorkspace?.id && user?.id && !workspaceLoading) {
        setMembersLoading(true);
        try {
          const members = await getWorkspaceMembers(currentWorkspace.id);
          setWorkspaceMembers(members);

          // Find current user's role in the workspace
          const currentMember = members.find(member => member.id === user.id);
          if (currentMember) {
            setCurrentUserRole(currentMember.role);
            setPermissionsReady(true);
          } else {
            // Check if user is workspace owner using multiple methods
            const isOwnerByUserId = currentWorkspace.user_id && String(currentWorkspace.user_id) === String(user.id);
            const isOwnerByRole = currentWorkspace.role === 'owner';

            console.log('Workspace owner check:', {
              workspaceUserId: currentWorkspace.user_id,
              currentUserId: user.id,
              workspaceRole: currentWorkspace.role,
              isOwnerByUserId,
              isOwnerByRole,
              workspaceUserIdType: typeof currentWorkspace.user_id,
              userIdType: typeof user.id,
              workspaceLoading,
              currentMember,
              membersFound: members.length,
            });

            if (isOwnerByUserId || isOwnerByRole) {
              setCurrentUserRole('owner');
            } else {
              // If the workspace role is set, use it, otherwise fallback to viewer
              setCurrentUserRole(currentWorkspace.role as 'owner' | 'editor' | 'viewer' || 'viewer');
            }
            setPermissionsReady(true);
          }
        } catch (error) {
          console.error('Error loading workspace members:', error);
          // Fallback: Check if user is workspace owner even if API call fails
          const isOwner = String(currentWorkspace.user_id) === String(user.id);
          console.log('Fallback owner check due to API error:', {
            workspaceUserId: currentWorkspace.user_id,
            currentUserId: user.id,
            isOwner,
          });

          if (isOwner) {
            setCurrentUserRole('owner');
          } else {
            setCurrentUserRole('viewer'); // Default fallback for non-owners
          }
          setPermissionsReady(true);

          // Even if API fails, include at least the current user
          setWorkspaceMembers([{
            id: user.id,
            username: user.username || user.email || 'Current User',
            email: user.email,
            avatar_url: user.imageUrl,
            role: isOwner ? 'owner' : 'viewer'
          }]);
        } finally {
          setMembersLoading(false);
        }
      } else if (isOpen && user?.id && !currentWorkspace?.id) {
        // Fallback: If no workspace context, assume owner (for backward compatibility)
        console.warn('No workspace context available, defaulting to owner role');
        setCurrentUserRole('owner');
        setPermissionsReady(true);
      } else if (isOpen && user?.id && workspaceLoading) {
        // Workspace is still loading, handled by timeout effect above
        console.log('Workspace is loading, timeout effect will handle fallback...');
      }
    };

    void loadWorkspaceMembers();
  // eslint-disable-next-line react-hooks/exhaustive-deps -- deps are intentionally limited
  }, [isOpen, propsNoteId, currentWorkspace?.id, user?.id, workspaceLoading]);

  // Handle creating a new note
  const handleNew = () => {
    if (notesContent && !isContentEmpty(notesContent)) {
      // Show confirmation dialog if user has unsaved content
      setShowNewNoteDialog(true);
    } else {
      // No content - defer state changes to avoid TipTap insertBefore errors
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          setNotesContent('');
          setNoteId(null);
        });
      });
    }
  };

  // Confirm creating new note (called from dialog).
  //
  // The previous version commented "Current content will be auto-saved by the
  // autosave effect" and immediately wiped state. In practice the debounced
  // autosave's 3 s timer races against the wipe — if it had nothing pending
  // (user hadn't typed since the last flush), or if the wipe ran before its
  // closure resolved, the in-progress note was lost. Worse, the editor itself
  // didn't always reflect the cleared `notesContent` prop because the
  // collaborative editor's content-load effect skips reload paths in several
  // edge cases, leaving the user staring at the old note.
  //
  // Fix: persist the current content synchronously via the immediate save
  // helper, THEN clear state, THEN imperatively reset the editor so the user
  // sees an empty doc regardless of which skip-path the prop-sync hits.
  const handleNewNoteConfirm = async () => {
    setShowNewNoteDialog(false);

    // Capture the live editor HTML up-front; React state reads can lag here.
    const liveContent = editorRef.current?.getHTML() ?? notesContent;

    try {
      await saveCurrentNoteImmediateRef.current?.(liveContent);
    } catch (err) {
      console.error('[NotesDrawer] Failed to save current note before creating new', err);
      // Continue anyway — user explicitly chose to start fresh, and a save
      // failure shouldn't strand them on a dialog. The localStorage fallback
      // inside saveContentNow already preserved a copy.
    }

    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        setNotesContent('');
        setNoteId(null);
        // Force the editor to drop the previous document. The content-prop
        // sync in collaborative-notes-editor.tsx has multiple skip paths
        // (initial-load gate, hasLocalEdits guard, post-WS-sync guard) that
        // can leave stale content visible. Clearing imperatively is robust.
        const ed = editorRef.current;
        if (ed && !ed.isDestroyed) {
          try {
            ed.commands.setContent('<h1></h1><p></p>', false);
          } catch (err) {
            console.warn('[NotesDrawer] Failed to reset editor content', err);
          }
        }
        toast({
          title: t('notes.toasts.newNote.title'),
          description: t('notes.toasts.newNote.description'),
        });
      });
    });
  };

  // Handle clearing notes
  const handleClear = () => {
    setShowClearDialog(true);
  };

  // Confirm clearing notes (called from dialog)
  const handleClearConfirm = () => {
    // Close dialog first
    setShowClearDialog(false);

    // Defer state changes to avoid TipTap insertBefore errors
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        setNotesContent('');
        if (sessionId) {
          localStorage.removeItem(`notes-${sessionId}`);
        }
        toast({
          title: t('notes.toasts.notesCleared.title'),
          description: t('notes.toasts.notesCleared.description'),
        });
      });
    });
  };

  // Handle downloading notes as text file
  const handleDownload = () => {
    try {
      // Create a temporary element to extract plain text
      const tempDiv = document.createElement('div');
      tempDiv.innerHTML = notesContent;
      const plainText = tempDiv.textContent || tempDiv.innerText || '';

      const blob = new Blob([plainText], { type: 'text/plain' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `notes-${sessionId || 'session'}-${new Date().toISOString().split('T')[0]}.txt`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      toast({
        title: t('notes.toasts.notesDownloaded.title'),
        description: t('notes.toasts.notesDownloaded.description'),
      });
    } catch (error) {
      console.error('Error downloading notes:', error);
      toast({
        title: t('notes.toasts.downloadFailed.title'),
        description: t('notes.toasts.downloadFailed.description'),
        variant: 'destructive',
      });
    }
  };

  // Print notes on A4 paper via browser print dialog.
  // Renders notesContent in a hidden iframe with @page A4 CSS so headers,
  // margins and fonts match the editor's on-screen A4 layout.
  //
  // MOBILE GOTCHA: a 0×0 iframe with no viewport meta makes Chrome
  // Mobile / Safari iOS lay out the document in a virtual ~980px
  // desktop viewport and then scale it down to fit the @page box,
  // which roughly doubles effective margins and content width on the
  // printed page. Give the iframe an explicit A4-portrait pixel size
  // (210mm × 297mm ≈ 794×1123 at 96 DPI) positioned off-screen so
  // layout happens at the correct width before printing.
  const handlePrint = () => {
    try {
      const iframe = document.createElement('iframe');
      iframe.setAttribute('aria-hidden', 'true');
      const isLandscape = editorOrientation === 'landscape';
      // Paper dimensions in mm — `@page size` accepts the named size
      // (A4/A3/A5) plus orientation, but the iframe's layout box has
      // to match in pixels @ 96 DPI so mobile browsers don't reflow
      // through their 980 px virtual viewport and double the margins
      // on print.
      const PAPER_MM: Record<NotesPaperSize, { short: number; long: number }> = {
        A5: { short: 148, long: 210 },
        A4: { short: 210, long: 297 },
        A3: { short: 297, long: 420 },
      };
      const dims = PAPER_MM[paperSize];
      const widthMm = isLandscape ? dims.long : dims.short;
      const heightMm = isLandscape ? dims.short : dims.long;
      const PAGE_MARGIN_MM = 20;
      const contentWidthMm = widthMm - 2 * PAGE_MARGIN_MM;
      const mmToPx = (mm: number) => Math.round((mm / 25.4) * 96);
      iframe.style.position = 'fixed';
      iframe.style.left = '-10000px';
      iframe.style.top = '0';
      iframe.style.width = `${mmToPx(widthMm)}px`;
      iframe.style.height = `${mmToPx(heightMm)}px`;
      iframe.style.border = '0';
      iframe.style.opacity = '0';
      iframe.style.pointerEvents = 'none';
      document.body.appendChild(iframe);

      const doc = iframe.contentDocument;
      const win = iframe.contentWindow;
      if (!doc || !win) {
        document.body.removeChild(iframe);
        return;
      }

      const title = generateNoteTitle(notesContent, t('notes.untitled'));
      const safeTitle = title.replace(/[<>&"]/g, (c) =>
        ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c] || c)
      );

      doc.open();
      doc.write(`<!DOCTYPE html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${safeTitle}</title>
    <style>
      @page { size: ${paperSize} ${isLandscape ? 'landscape' : 'portrait'}; margin: ${PAGE_MARGIN_MM}mm; }
      @media print {
        html, body { background: #ffffff !important; }
        body { color: #000000 !important; }
      }
      html, body {
        background: #ffffff;
        color: #000000;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', sans-serif;
        font-size: 11pt;
        line-height: 1.5;
        margin: 0;
        padding: 0;
        /* Force layout width to the chosen paper's content area so
           mobile browsers don't lay the document out in a 980 px
           virtual viewport and then scale it down to fit @page
           (which would double the effective margins). */
        width: ${contentWidthMm}mm;
      }
      .notes-print-root {
        width: 100%;
        margin: 0;
      }
      h1 { font-size: 20pt; margin: 0 0 12pt; }
      h2 { font-size: 16pt; margin: 14pt 0 8pt; }
      h3 { font-size: 13pt; margin: 12pt 0 6pt; }
      h4, h5, h6 { font-size: 11pt; margin: 10pt 0 4pt; }
      p { margin: 0 0 8pt; }
      ul, ol { margin: 0 0 8pt 20pt; padding: 0; }
      li { margin: 0 0 4pt; }
      blockquote {
        border-left: 3pt solid #888;
        margin: 8pt 0;
        padding: 0 12pt;
        color: #333;
        font-style: italic;
      }
      pre, code {
        font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace;
        background: #f5f5f5;
        border: 1px solid #e0e0e0;
      }
      pre { padding: 8pt; white-space: pre-wrap; word-wrap: break-word; page-break-inside: avoid; }
      code { padding: 1pt 4pt; font-size: 9.5pt; }
      table { border-collapse: collapse; width: 100%; margin: 8pt 0; page-break-inside: avoid; }
      th, td { border: 1px solid #bbb; padding: 4pt 6pt; text-align: left; vertical-align: top; }
      th { background: #f0f0f0; }
      img { max-width: 100%; height: auto; page-break-inside: avoid; }
      hr { border: 0; border-top: 1px solid #ccc; margin: 12pt 0; }
      a { color: #000; text-decoration: underline; }
      /* Hide editor-only decorations */
      .page-break-decoration, [data-page-break], [contenteditable="false"][data-decoration] { display: none !important; }
      h1, h2, h3, h4, h5, h6 { page-break-after: avoid; }
      p, blockquote, ul, ol { orphans: 2; widows: 2; }
    </style>
  </head>
  <body>
    <div class="notes-print-root">
      ${notesContent || ''}
    </div>
  </body>
</html>`);
      doc.close();

      const triggerPrint = () => {
        try {
          win.focus();
          win.print();
        } finally {
          setTimeout(() => {
            if (iframe.parentNode) iframe.parentNode.removeChild(iframe);
          }, 1000);
        }
      };

      if (doc.readyState === 'complete') {
        setTimeout(triggerPrint, 50);
      } else {
        iframe.onload = triggerPrint;
      }

      toast({
        title: t('notes.toasts.printOpened.title'),
        description: t('notes.toasts.printOpened.description'),
      });
    } catch (error) {
      console.error('Error printing notes:', error);
      toast({
        title: t('notes.toasts.downloadFailed.title'),
        description: t('notes.toasts.downloadFailed.description'),
        variant: 'destructive',
      });
    }
  };

  /** Download notes as Pandoc-compatible Markdown + BibTeX pair */
  const handleDownloadMarkdown = async () => {
    try {
      const dateStr = new Date().toISOString().split('T')[0];
      const filePrefix = `notes-${sessionId || 'session'}-${dateStr}`;

      // Convert HTML to basic Markdown
      let markdown = notesContent;

      // If editor is available, extract citations and replace with Pandoc keys
      let bibContent = '';
      if (editorRef.current) {
        const citations = collectCitations(editorRef.current);
        if (citations.size > 0) {
          const metas = Array.from(citations.values());

          // Replace citation marks in HTML with [@Key] before converting
          citations.forEach((meta, docId) => {
            const key = generateCitationKey(meta);
            const pattern = new RegExp(
              `<span[^>]*data-document-id="${docId}"[^>]*>[^<]*</span>`,
              'g'
            );
            markdown = markdown.replace(pattern, `[@${key}]`);
          });

          // Generate BibTeX
          bibContent = await toBibTeXBatch(metas);
        }
      }

      // Basic HTML to Markdown conversion
      markdown = markdown
        .replace(/<h1[^>]*>(.*?)<\/h1>/gi, '# $1\n')
        .replace(/<h2[^>]*>(.*?)<\/h2>/gi, '## $1\n')
        .replace(/<h3[^>]*>(.*?)<\/h3>/gi, '### $1\n')
        .replace(/<h4[^>]*>(.*?)<\/h4>/gi, '#### $1\n')
        .replace(/<strong[^>]*>(.*?)<\/strong>/gi, '**$1**')
        .replace(/<em[^>]*>(.*?)<\/em>/gi, '*$1*')
        .replace(/<u[^>]*>(.*?)<\/u>/gi, '$1')
        .replace(/<blockquote[^>]*>(.*?)<\/blockquote>/gi, '> $1\n')
        .replace(/<li[^>]*>(.*?)<\/li>/gi, '- $1\n')
        .replace(/<p[^>]*>(.*?)<\/p>/gi, '$1\n\n')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<div[^>]*data-bibliography[^>]*>.*?<\/div>/gis, '') // Remove bibliography node HTML
        .replace(/<[^>]+>/g, '') // Strip remaining tags
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&nbsp;/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .trim();

      // Add YAML frontmatter if there are citations
      if (bibContent) {
        markdown = `---\nbibliography: ${filePrefix}.bib\n---\n\n${markdown}\n\n## References\n`;
      }

      // Download Markdown file
      const mdBlob = new Blob([markdown], { type: 'text/markdown' });
      const mdUrl = URL.createObjectURL(mdBlob);
      const mdLink = document.createElement('a');
      mdLink.href = mdUrl;
      mdLink.download = `${filePrefix}.md`;
      document.body.appendChild(mdLink);
      mdLink.click();
      document.body.removeChild(mdLink);
      URL.revokeObjectURL(mdUrl);

      // Download BibTeX file if citations exist
      if (bibContent) {
        const bibBlob = new Blob([bibContent], { type: 'application/x-bibtex' });
        const bibUrl = URL.createObjectURL(bibBlob);
        const bibLink = document.createElement('a');
        bibLink.href = bibUrl;
        bibLink.download = `${filePrefix}.bib`;
        document.body.appendChild(bibLink);
        bibLink.click();
        document.body.removeChild(bibLink);
        URL.revokeObjectURL(bibUrl);
      }

      toast({
        title: t('notes.citation.markdownDownloaded', 'Markdown and BibTeX files downloaded'),
      });
    } catch (error) {
      console.error('Error downloading Markdown:', error);
      toast({
        title: t('notes.toasts.markdownFailed.title'),
        description: t('notes.toasts.markdownFailed.description'),
        variant: 'destructive',
      });
    }
  };

  const toggleFullWidth = () => {
    const newWidth = drawerWidth === '100' ? '50' : '100';
    setDrawerWidth(newWidth);
  };

  // Helper function to find existing note with the same title and session
  const findExistingNoteByTitleAndSession = async (
    title: string,
    workspaceId: string,
    sessionId: string | undefined
  ): Promise<string | null> => {
    try {
      const notes = await listNotes(workspaceId, 'all');

      // Find note with matching title AND session_id (case-insensitive title)
      // This ensures each session has its own note, even with same title
      const existingNote = notes.find(
        note =>
          note.title?.toLowerCase().trim() === title.toLowerCase().trim() &&
          note.session_id === sessionId
      );

      if (existingNote) {
        console.log('[NotesDrawer] Found existing note with same title and session:', existingNote.id);
        return existingNote.id;
      }

      return null;
    } catch (error) {
      console.error('[NotesDrawer] Error searching for existing notes:', error);
      return null;
    }
  };

  // Ref to track content for save-on-close (prevIsOpenRef already exists above)
  const notesContentRef = useRef(notesContent);

  // Keep content ref updated
  useEffect(() => {
    notesContentRef.current = notesContent;
  }, [notesContent]);

  // Immediate save function (no debounce) - used when closing drawer
  const saveImmediately = async (content: string) => {
    if (!sessionId || !currentWorkspace?.id || !content.trim()) return;
    if (isContentEmpty(content)) return;

    try {
      const noteTitle = generateNoteTitle(content, 'Notes for session');
      console.log('[NotesDrawer] Immediate save on close:', { noteId, noteTitle });

      if (noteId) {
        await updateNote(noteId, {
          title: noteTitle,
          content: content
        });
      } else {
        const existingNoteId = await findExistingNoteByTitleAndSession(
          noteTitle,
          currentWorkspace.id,
          sessionId
        );

        if (existingNoteId) {
          await updateNote(existingNoteId, {
            title: noteTitle,
            content: content
          });
          setNoteId(existingNoteId);
          localStorage.setItem(`note-id-${sessionId}`, existingNoteId);
        } else {
          const pendingCategory = pendingTemplateCategoryRef.current;
          const newNote = await createNote({
            workspace_id: currentWorkspace.id,
            session_id: sessionId,
            title: noteTitle,
            content: content,
            category: pendingCategory as NoteCategory | null | undefined,
          });
          pendingTemplateCategoryRef.current = null;
          setNoteId(newNote.id);
          localStorage.setItem(`note-id-${sessionId}`, newNote.id);
        }
      }
      localStorage.setItem(`notes-${sessionId}`, content);
    } catch (error) {
      console.error('[NotesDrawer] Immediate save failed:', error);
      localStorage.setItem(`notes-${sessionId}`, content);
    }
  };

  // Save when drawer closes
  useEffect(() => {
    if (prevIsOpenRef.current && !isOpen) {
      // Drawer just closed - save immediately
      const content = notesContentRef.current;
      if (content && !isContentEmpty(content)) {
        void saveImmediately(content);
      }
    }
    prevIsOpenRef.current = isOpen;
  // eslint-disable-next-line react-hooks/exhaustive-deps -- deps are intentionally limited
  }, [isOpen]);

  // Core save body — used by both the debounced autosave and the awaitable
  // immediate path. Returns whether anything was actually persisted (`false`
  // if the save was aborted by one of the empty/no-title guards).
  const saveContentNow = useCallback(async (content: string): Promise<boolean> => {
    console.log('[NotesDrawer] 💾 Save executing:', {
      hasSessionId: !!sessionId,
      hasWorkspaceId: !!currentWorkspace?.id,
      contentLength: content?.length || 0,
      noteId,
    });

    if (!currentWorkspace?.id || !content.trim()) {
      console.log('[NotesDrawer] ❌ Save aborted: missing workspaceId or empty content');
      return false;
    }

    if (!noteId && !sessionId) {
      console.log('[NotesDrawer] ❌ Save aborted: need either noteId or sessionId');
      return false;
    }

    if (isContentEmpty(content)) {
      console.log('[NotesDrawer] Skipping save: content is empty');
      return false;
    }

    const hasTitle = (() => {
      const tempEl = document.createElement('div');
      tempEl.innerHTML = content;
      const firstHeading = tempEl.querySelector('h1, h2, h3');
      return firstHeading && firstHeading.textContent && firstHeading.textContent.trim().length > 0;
    })();

    if (!hasTitle) {
      console.log('[NotesDrawer] Skipping save: document has no title');
      return false;
    }

    setSaveStatus('saving');
    if (saveStatusTimerRef.current) clearTimeout(saveStatusTimerRef.current);

    try {
      const noteTitle = generateNoteTitle(content, 'Notes for session');

      if (noteId) {
        await updateNote(noteId, { title: noteTitle, content });
      } else if (sessionId) {
        const existingNoteId = await findExistingNoteByTitleAndSession(
          noteTitle,
          currentWorkspace.id,
          sessionId
        );
        if (existingNoteId) {
          await updateNote(existingNoteId, { title: noteTitle, content });
          setNoteId(existingNoteId);
          localStorage.setItem(`note-id-${sessionId}`, existingNoteId);
        } else {
          const pendingCategory = pendingTemplateCategoryRef.current;
          const newNote = await createNote({
            workspace_id: currentWorkspace.id,
            session_id: sessionId,
            title: noteTitle,
            content,
            category: pendingCategory as NoteCategory | null | undefined,
          });
          pendingTemplateCategoryRef.current = null;
          setNoteId(newNote.id);
          localStorage.setItem(`note-id-${sessionId}`, newNote.id);
        }
      }

      const storageKey = noteId || sessionId;
      if (storageKey) localStorage.setItem(`notes-${storageKey}`, content);

      setSaveStatus('saved');
      saveStatusTimerRef.current = setTimeout(() => setSaveStatus('idle'), 3000);
      return true;
    } catch (error) {
      console.error('[NotesDrawer] ❌ Save failed:', error);
      setSaveStatus('idle');
      const storageKey = noteId || sessionId;
      if (storageKey) localStorage.setItem(`notes-${storageKey}`, content);
      return false;
    }
  }, [noteId, sessionId, currentWorkspace?.id]);

  // Debounced database autosave — delegates to saveContentNow.
  const debouncedSave = useDebounce(async (content: string) => {
    console.log('[NotesDrawer] 💾 Debounced save executing:', {
      hasSessionId: !!sessionId,
      hasWorkspaceId: !!currentWorkspace?.id,
      contentLength: content?.length || 0,
      noteId,
    });

    await saveContentNow(content);
  }, 3000); // Auto-save after 3 seconds of inactivity

  // Awaitable immediate save — used by File → New Note before clearing state.
  saveCurrentNoteImmediateRef.current = async (content: string) => {
    await saveContentNow(content);
  };

  // Expose debouncedSave via ref so early handlers (e.g. manual File → Save)
  // can call it without crossing the TDZ boundary.
  debouncedSaveRef.current = debouncedSave;

  // Track when content was last loaded to prevent immediate save after load
  const lastLoadTimeRef = useRef<number>(0);
  const loadedContentRef = useRef<string>('');

  // Update load time when noteId changes (note is loaded from server)
  useEffect(() => {
    if (noteId && notesContent) {
      lastLoadTimeRef.current = Date.now();
      loadedContentRef.current = notesContent;
      console.log('[NotesDrawer] Content loaded from server, updated tracking refs');
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- deps are intentionally limited
  }, [noteId]);

  // Auto-save is now triggered directly from onChange callback (ref-only pattern)
  // instead of via useEffect on notesContent state. This prevents parent re-render
  // cascade on every keystroke.

  // Mobile swipe gesture handlers
  const handleTouchStart = (e: React.TouchEvent) => {
    if (!isMobile) return;

    // Don't enable swipe-to-close if user is touching interactive elements or header toolbar
    const target = e.target as HTMLElement;
    if (target.closest('.ProseMirror') || target.closest('[contenteditable="true"]') ||
        target.closest('button') || target.closest('[role="menuitem"]') ||
        target.closest('[data-radix-collection-item]') || target.closest('[role="menu"]') ||
        target.closest('[data-notes-header]')) {
      return;
    }

    const touch = e.touches[0];
    setTouchStart({ x: touch.clientX, y: touch.clientY });
    setTouchCurrent({ x: touch.clientX, y: touch.clientY });
    setSwipeProgress(0);
  };

  const handleTouchMove = (e: React.TouchEvent) => {
    if (!isMobile || !touchStart) return;
    
    const touch = e.touches[0];
    const current = { x: touch.clientX, y: touch.clientY };
    setTouchCurrent(current);
    
    // Calculate horizontal swipe distance
    const deltaX = current.x - touchStart.x;
    const deltaY = Math.abs(current.y - touchStart.y);
    
    // Only process horizontal swipes (not scrolling)
    if (deltaY > 50) return;
    
    // Swipe from right edge to close (for fullscreen mobile)
    if (deltaX < 0) {
      const progress = Math.min(Math.abs(deltaX) / window.innerWidth, 1);
      setSwipeProgress(progress);
      
      // Prevent scrolling during swipe
      if (progress > 0.1) {
        e.preventDefault();
      }
    }
  };

  const handleTouchEnd = () => {
    if (!isMobile || !touchStart || !touchCurrent) {
      setTouchStart(null);
      setTouchCurrent(null);
      setSwipeProgress(0);
      return;
    }
    
    const deltaX = touchCurrent.x - touchStart.x;
    const deltaY = Math.abs(touchCurrent.y - touchStart.y);
    
    // Only process horizontal swipes
    if (deltaY > 50) {
      setTouchStart(null);
      setTouchCurrent(null);
      setSwipeProgress(0);
      return;
    }
    
    // Close if swiped more than 30% of screen width to the left
    if (deltaX < -window.innerWidth * 0.3) {
      onClose();
    }
    
    // Reset touch state
    setTouchStart(null);
    setTouchCurrent(null);
    setSwipeProgress(0);
  };

  // Set CSS variable for drawer width so parent components can adjust
  useEffect(() => {
    if (isOpen) {
      document.documentElement.style.setProperty('--notes-drawer-width', `${drawerWidth}%`);
    } else {
      document.documentElement.style.removeProperty('--notes-drawer-width');
    }
    return () => {
      document.documentElement.style.removeProperty('--notes-drawer-width');
    };
  }, [isOpen, drawerWidth]);

  // Handle note sharing
  const handleShare = async () => {
    if (!noteId || !shareEmail.trim()) {
      toast({
        title: 'Error',
        description: 'Please enter an email address to share with.',
        variant: 'destructive',
      });
      return;
    }

    setIsSharing(true);
    try {
      await shareNote(noteId, {
        email: shareEmail.trim(),
        role: shareRole,
      });

      toast({
        title: 'Note shared',
        description: `Note has been shared with ${shareEmail} as ${shareRole}.`,
      });

      // Reset form and close dialog
      setShareEmail('');
      setShareRole('editor');
      setShowShareDialog(false);

      // Reload workspace members to show the new collaborator
      if (currentWorkspace?.id && user?.id) {
        try {
          const members = await getWorkspaceMembers(currentWorkspace.id);
          setWorkspaceMembers(members);
        } catch (error) {
          console.error('Error reloading workspace members:', error);
        }
      }
    } catch (error: unknown) {
      console.error('Error sharing note:', error);
      const axiosErr = error as { response?: { data?: { detail?: string } } };
      toast({
        title: 'Sharing failed',
        description: axiosErr?.response?.data?.detail || 'Failed to share note. Please try again.',
        variant: 'destructive',
      });
    } finally {
      setIsSharing(false);
    }
  };

  // Mobile share functionality using Web Share API
  const handleMobileShare = async () => {
    try {
      if (navigator.share && notesContent.trim()) {
        // Create plain text version
        const tempDiv = document.createElement('div');
        tempDiv.innerHTML = notesContent;
        const plainText = tempDiv.textContent || tempDiv.innerText || '';
        
        await navigator.share({
          title: 'Notes from Scrapalot',
          text: plainText,
        });
      } else {
        // Fallback to regular share dialog
        setShowShareDialog(true);
      }
    } catch (error) {
      if ((error as Error).name !== 'AbortError') {
        console.error('Mobile share failed:', error);
        setShowShareDialog(true);
      }
    }
  };

  if (!isOpen) return null;

  return (
    <div
      ref={(node: HTMLDivElement | null) => {
        // @ts-expect-error -- both refs share this node
        drawerRef.current = node;
        fw.panelRef(node);
      }}
      data-testid="notes-drawer"
      {...fw.focusProps}
      className={cn(
        'fixed bg-background',
        isInitialOpen && !fw.isFloating && 'transition-all duration-500 ease-in-out',
        isNarrowScreen
          ? 'inset-0'
          : fw.isFloating
            ? ''
            : isInitialOpen
              ? (openedOnRight !== null ? !openedOnRight : (isViewerOpen && !viewerIsOnLeft))
                ? 'top-0 bottom-0 animate-slide-in-from-left'
                : 'top-0 bottom-0 animate-slide-in-from-right'
              : 'top-0 bottom-0'
      )}
      style={{
        ...(fw.isFloating ? fw.floatingStyle : calculatePosition()),
        zIndex: floatingMgr.isTopFocused('notes-drawer') ? 9999 : 40 + Math.max(0, floatingMgr.getOrder('notes-drawer')), // Higher z-index than chat-messages, boosts to global top when focused
        isolation: 'isolate', // Create a new stacking context
        backgroundColor: 'hsl(var(--background))', // Explicit background color
        borderLeft: !isNarrowScreen && (openedOnRight !== null ? openedOnRight : !(isViewerOpen && !viewerIsOnLeft))
          ? '1px solid hsl(var(--border))' // Left border when on RIGHT
          : 'none',
        borderRight: !isNarrowScreen && (openedOnRight !== null ? !openedOnRight : (isViewerOpen && !viewerIsOnLeft))
          ? '1px solid hsl(var(--border))' // Right border when on LEFT
          : 'none',
        transition: isInitialOpen ? undefined : 'none', // Explicitly no transitions after initial open
        // Apply swipe transform on mobile
        transform: isMobile && swipeProgress > 0 
          ? `translateX(${-swipeProgress * 100}%)` 
          : undefined,
        opacity: isMobile && swipeProgress > 0 
          ? Math.max(0.5, 1 - swipeProgress * 0.5) 
          : 1,
      }}
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
    >
      {fw.resizeHandles}
      <div className="h-full flex flex-col">
        {/* Header — single NoteMenuBar row replaces the legacy title + toolbar */}
        {isMounted && (
          <div {...(fw.isFloating ? fw.headerDragProps : {})} className={fw.isFloating ? fw.headerDragProps.className : undefined}>
          <NoteMenuBar
            data-notes-header
            className={cn(
              // relative z-20 establishes a stacking context above the
              // notes-container body so absolutely-positioned children
              // inside the editor (page-meta row, page-head toolbar)
              // can never cover the menu bar when the user scrolls.
              // Desktop header is h-14 (56 px) to match the conversations
              // sidebar "Novi razgovor" header; mobile stays tighter at h-12.
              "relative z-20 bg-background/95 backdrop-blur-sm",
              isMobile ? "h-12 px-3" : "h-14 px-4"
            )}
            leading={<span data-testid="notes-drawer-title" className="sr-only">Notes Drawer</span>}
            saveStatus={saveStatus}
            handlers={{
              onNew: handleNew,
              onShare: isMobile ? handleMobileShare : () => setShowShareDialog(true),
              onExport: (format) => {
                if (format === 'markdown') {
                  void handleDownloadMarkdown();
                } else if (format === 'html') {
                  handleExportHtml();
                } else if (format === 'latex') {
                  // 7.4 — pure client-side TipTap-JSON → LaTeX with
                  // proper \cite{} + paired references.bib. Skips the
                  // pandoc passthrough that loses citation structure.
                  void handleExportLatex();
                } else if (format === 'latex-zip') {
                  void handleExportLatexZip();
                } else if (format === 'pdf' || format === 'docx') {
                  // Direct conversion via paper generator passthrough
                  // template — pandoc on the backend, no LLM, no dialog.
                  void handleExportPassthrough(format);
                }
              },
              onPrint: handlePrint,
              onDelete: handleClear,
              onBack: onClose,
              onChangeResearchContext: () => setContextPopoverOpen((v) => !v),
              onNewFromTemplate: () => setTemplateGalleryOpen(true),
              onVersionHistory: () => {
                if (!noteId) {
                  toast({
                    title: t('notes.versionHistory.notSavedYet.title', 'Save the note first'),
                    description: t('notes.versionHistory.notSavedYet.description', 'Version history is available once the note has been saved.'),
                  });
                  return;
                }
                setVersionHistoryOpen(true);
              },
              onOpen: () => setOpenDialogOpen(true),
              onConnectDots: () => setConnectDotsOpen(true),
              onComposeFromSources: () => setComposeOpen(true),
              onCritiqueWithQuestions: () => void handleCritiqueWithQuestions(),
              onSaveAsTemplate: () => void handleSaveAsTemplate(),
              onFactCheckWholeNote: () => setFactCheckOpen(true),
              onToggleNonNativeEnglish: toggleNonNativeEnglishMode,
              onToggleFullscreen: toggleNotesFullscreen,
              onToggleFocusMode: toggleNotesFocusMode,
              onToggleReadingMode: toggleNotesReadingMode,
              onToggleSepiaMode: toggleNotesSepiaMode,
              onToggleAiAutocomplete: toggleAiAutocomplete,
              onGenerateOutline: handleGenerateOutline,
              onGenerateTitle: handleGenerateTitle,
              onGenerateAbstract: handleGenerateAbstract,
              onGenerateHighlights: handleGenerateHighlights,
              onSave: handleSave,
              onDuplicate: handleDuplicate,
              onWordCount: handleWordCount,
              onTranslateWholeNote: handleTranslateWholeNote,
            } satisfies NoteMenuHandlers}
            state={{
              saveIndicator: undefined,
              nonNativeEnglishMode,
              isFullscreen: notesFullscreen,
              isFocusMode: notesFocusMode,
              isReadingMode: notesReadingMode,
              isSepiaMode: notesSepiaMode,
              isAiAutocompleteEnabled: aiAutocompleteEnabled,
              autocompleteQuotaUsed: autocompleteQuota?.used,
              autocompleteQuotaLimit: autocompleteQuota?.limit,
            } satisfies NoteMenuState}
            pageHead={{
              value: {
                emoji: noteEmoji,
                headerImageUrl: noteHeaderImageUrl,
                fontScale: noteFontScale,
              },
              handlers: {
                onEmojiChange: handlePageHeadEmojiChange,
                onHeaderImageChange: handlePageHeadHeaderImageChange,
                onFontScaleChange: handlePageHeadFontScaleChange,
                onSuggestTitle: handleGenerateTitle,
                onUploadHeaderImage: handleUploadHeaderImage,
              },
              layout: {
                paperSize,
                orientation: editorOrientation,
                screenWidth: screenWidthPref,
                onPaperSizeChange: setLayoutPaperSize,
                onOrientationChange: setLayoutOrientation,
                onScreenWidthChange: setLayoutScreenWidth,
              },
            }}
            trailing={!isMobile ? (
              <div className="flex items-center gap-1">
                {/* Research scope trigger — compact icon-only button.
                    Opens the collections + Web editor. Spins while an AI
                    whole-note operation is running. Native `title`
                    reveals the active scope on hover; no nested Radix
                    Tooltip because PopoverTrigger asChild only wraps one
                    child and a Tooltip would clash with it. */}
                <NoteResearchContextPopover
                  context={researchContext}
                  onChange={updateResearchContext}
                  open={contextPopoverOpen}
                  onOpenChange={setContextPopoverOpen}
                  trigger={
                    <Button
                      variant="ghost"
                      size="icon"
                      className={cn(
                        'h-8 w-8',
                        scopeBarActive && 'text-primary'
                      )}
                      data-testid="notes-scope-button"
                      aria-label={
                        (scopeBarActive
                          ? t('notes.scopeStatus.searchingIn', 'Searching in:')
                          : t('notes.scopeStatus.scope', 'Scope:')) +
                        ' ' +
                        researchScopeLabel
                      }
                      title={
                        (scopeBarActive
                          ? t('notes.scopeStatus.searchingIn', 'Searching in:')
                          : t('notes.scopeStatus.scope', 'Scope:')) +
                        ' ' +
                        researchScopeLabel
                      }
                    >
                      {scopeBarActive ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <Book className="h-4 w-4" />
                      )}
                    </Button>
                  }
                />
                {/* Width toggle only when notes is NOT locked at 50vw by a
                    pinned viewer alongside. `isViewerOpen` already excludes
                    floating viewers (they don't take side space).

                    The discrete 30/40/50/60/75/100 % select used to live
                    next to this button — removed because the toggle here
                    already covers the only two states anyone reached for
                    (default 50 % vs full 100 %), and the resize handle on
                    the drawer's edge handles any fine-tuning. */}
                {!isNarrowScreen && !isViewerOpen && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button variant="ghost" size="icon" className="h-8 w-8" data-testid="notes-fullwidth-button" onClick={toggleFullWidth}>
                        {drawerWidth === '100' ? <Minimize className="h-4 w-4" /> : <Maximize className="h-4 w-4" />}
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent><p>{drawerWidth === '100' ? t('notes.toolbar.restore') : t('notes.toolbar.maximize')}</p></TooltipContent>
                  </Tooltip>
                )}
                {/* Pin menu and layout popover are independent of an
                    alongside viewer — the user must always be able to
                    pin / unpin notes and change paper layout. */}
                {!isNarrowScreen && (
                  <>
                    <WindowPinMenu
                      mode={fw.isFloating ? 'floating' : ((openedOnRight !== null ? openedOnRight : (isViewerOpen ? viewerIsOnLeft : true)) ? 'pinned-right' : 'pinned-left')}
                      onSetMode={(m: WindowMode) => {
                        fw.setMode(m);
                        if (m === 'pinned-left' || m === 'pinned-right') {
                          const onRight = m === 'pinned-right';
                          setOpenedOnRight(onRight);
                          notesDrawer.setPosition(!onRight);
                        }
                      }}
                      showFloating={true}
                      showMaximize={false}
                      testId="notes-pin-menu"
                      className="h-8 w-8"
                    />
                    {/* Migration 116 — Page layout moved into the
                        Confluence-style page-head toolbar that appears
                        above the H1 on hover. Keeping it here would
                        give the user two ways to set paper size, which
                        is the exact duplication the redesign drops. */}
                  </>
                )}
                {/* Close button — always visible (also on md/lg). */}
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8"
                      data-testid="notes-drawer-close-button"
                      onClick={() => onClose()}
                      onMouseDown={(e) => e.preventDefault()}
                    >
                      <X className="h-4 w-4" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent><p>{t('common.close', 'Close')}</p></TooltipContent>
                </Tooltip>
              </div>
            ) : undefined}
          />
          </div>
        )}


        <TemplateGallery
          open={templateGalleryOpen}
          onOpenChange={setTemplateGalleryOpen}
          onSelect={handleTemplateSelect}
          onSelectBlank={handleNew}
        />

        {/* 7.3 — Compose from Sources. Reuses the editorRef for the
            insert-into-cursor handoff and pulls the active research
            context's collection IDs so the RAG retrieval stays scoped
            to what the writer told the editor to read. */}
        <ComposeFromSourcesDialog
          open={composeOpen}
          onOpenChange={setComposeOpen}
          editor={editorRef.current}
          collectionIds={researchContext?.collectionIds ?? []}
        />

        {/* 7.2 — outline template picker. Opens via Generate outline;
            the picked template (or empty for legacy generic) drives a
            different prompt server-side. */}
        <OutlineTemplatePickerDialog
          open={outlineTemplateDialogOpen}
          onOpenChange={setOutlineTemplateDialogOpen}
          onSelect={(tpl) => void runGenerateOutline(tpl)}
        />

        {/* 7.9 — Version history. Mounts only when there is an actual
            persisted noteId; the open guard above already handles the
            "unsaved draft" path with a toast, so the dialog can rely on
            a stable string here. */}
        {noteId && (
          <VersionHistoryDialog
            noteId={noteId}
            open={versionHistoryOpen}
            onOpenChange={setVersionHistoryOpen}
            onRestored={() => {
              // Server has just rewritten note.content — reload from
              // the API so the editor picks up the restored state. The
              // collaboration layer will broadcast to other clients
              // via the NOTE_VERSION_RESTORED Redis event.
              if (typeof window !== 'undefined') window.location.reload();
            }}
          />
        )}

        <NotesOpenDialog
          open={openDialogOpen}
          onOpenChange={setOpenDialogOpen}
          onPickNote={(pickedId) => {
            // Reuse the existing drawer-open flow so the last-opened-note
            // persistence (note-id-${sessionId}) stays the single source of truth.
            notesDrawer.open(sessionId, pickedId);
          }}
        />

        <BridgingConceptsPanel
          open={connectDotsOpen}
          onOpenChange={setConnectDotsOpen}
          noteText={notesContentRef.current}
          excludeCollectionIds={researchContext.collectionIds}
        />

        <WholeNoteFactCheckPanel
          open={factCheckOpen}
          onOpenChange={setFactCheckOpen}
          noteText={notesContentRef.current}
          collectionIds={researchContext.collectionIds}
        />

        {/* Editor content */}
        <div className="flex-1 h-0">
          {!isMounted || !isEditorReady || !permissionsReady || currentUserRole === null ? (
            <div className="flex items-center justify-center h-full">
              <div className="text-center">
                <div className="text-sm text-muted-foreground">
                  {!isMounted || !isEditorReady ? 'Initializing...' : 'Loading permissions...'}
                </div>
              </div>
            </div>
          ) : currentUserRole === 'viewer' ? (
            <div className="flex items-center justify-center h-full">
              <div className="text-center">
                <div className="text-sm text-muted-foreground mb-2">
                  You have view-only access to this workspace.
                </div>
                <div className="text-xs text-muted-foreground">
                  Contact the workspace owner to request editor permissions.
                </div>
              </div>
            </div>
          ) : (
            <CollaborativeNotesEditor
              noteId={noteId || sessionId || 'default'}
              workspaceId={currentWorkspace?.id || 'default'}
              userId={user?.id || 'anonymous'}
              userName={user?.username || 'Anonymous User'}
              userAvatar={user?.profile_picture || user?.imageUrl}
              content={notesContent}
              onChange={(html) => {
                notesContentRef.current = html;
                debouncedSave(html);
              }}
              placeholder={isMobile
                ? t('notes.placeholderMobile')
                : t('notes.placeholderDesktop')
              }
              documentTitle={noteId ? `Session Notes` : 'New Notes'}
              createdBy={{
                id: user?.id || 'anonymous',
                name: user?.username || 'Anonymous User',
                email: user?.email,
                avatar: user?.profile_picture || user?.imageUrl,
              }}
              workspaceMembers={workspaceMembers}
              currentUserRole={currentUserRole}
              isReadOnly={false}
              onEditorReady={(editor) => { editorRef.current = editor; }}
              onShare={() => setShowShareDialog(true)}
              showCollaborationHeader={true}
              saveStatus={saveStatus}
              pageHead={{
                value: {
                  emoji: noteEmoji,
                  headerImageUrl: noteHeaderImageUrl,
                  fontScale: noteFontScale,
                },
                handlers: {
                  onEmojiChange: handlePageHeadEmojiChange,
                  onHeaderImageChange: handlePageHeadHeaderImageChange,
                  onFontScaleChange: handlePageHeadFontScaleChange,
                  onSuggestTitle: handleGenerateTitle,
                  onUploadHeaderImage: handleUploadHeaderImage,
                },
                layout: {
                  paperSize,
                  orientation: editorOrientation,
                  screenWidth: screenWidthPref,
                  onPaperSizeChange: setLayoutPaperSize,
                  onOrientationChange: setLayoutOrientation,
                  onScreenWidthChange: setLayoutScreenWidth,
                },
              }}
              className={cn(
                "h-full",
                isMobile && "mobile-editor"
              )}
            />
          )}
        </div>
      </div>

      {/* Mobile-specific styles */}
      {isMobile && (
        <style>{`
          .mobile-editor .ProseMirror {
            font-size: 16px !important; /* Prevent zoom on iOS */
            line-height: 1.5 !important;
            min-height: 200px !important; /* Just enough for comfortable writing */
            /* The collaboration header is absolutely positioned at top-[76px]
               and its avatar pill extends ~52px below that. Push the first
               line of prose past it so the empty-state placeholder
               ("Dodirni ovdje za pisanje…") doesn't sit underneath the
               admin badge. */
            padding-top: 4.5rem !important;
          }
          
          .mobile-editor .ProseMirror h1 {
            font-size: 1.75rem !important;
            margin-top: 1.5rem !important;
            margin-bottom: 0.75rem !important;
          }
          
          .mobile-editor .ProseMirror h2 {
            font-size: 1.5rem !important;
            margin-top: 1.25rem !important;
            margin-bottom: 0.5rem !important;
          }
          
          .mobile-editor .ProseMirror h3 {
            font-size: 1.25rem !important;
            margin-top: 1rem !important;
            margin-bottom: 0.5rem !important;
          }
          
          .mobile-editor .ProseMirror p {
            margin-top: 0.75rem !important;
            margin-bottom: 0.75rem !important;
          }
          
          /* Improve touch targets for mobile */
          .mobile-editor .ProseMirror li {
            min-height: 44px !important;
            display: flex !important;
            align-items: center !important;
          }
          
          .mobile-editor .ProseMirror button,
          .mobile-editor .ProseMirror input[type="checkbox"] {
            min-width: 44px !important;
            min-height: 44px !important;
          }
          
          /* Hide drag handles on mobile */
          .mobile-editor .drag-handle {
            display: none !important;
          }
          
          /* Mobile-optimized selection toolbar */
          .mobile-editor .selection-toolbar {
            bottom: 60px !important;
            left: 50% !important;
            transform: translateX(-50%) !important;
          }
        `}</style>
      )}

      {/* Share Dialog — redesigned per user feedback:
          - disableFullscreenOnMobile so the share form fits its content
            instead of stretching across the whole phone screen.
          - Email input now has a leading Mail icon for affordance.
          - Role picker is a segmented two-card control (Editor / Viewer)
            instead of a hidden-inside-a-dropdown Select — the choice is
            the centre of the dialog so it should be visible at a glance.
          - Header carries a Share2 icon so the modal's purpose is
            immediately readable even with the description collapsed. */}
      {isMounted && (
        <Dialog open={showShareDialog} onOpenChange={setShowShareDialog}>
        <DialogContent
          data-testid="notes-share-dialog"
          className="w-[min(90vw,28rem)] min-w-[200px]"
          overlayZIndex="9998"
          dialogOpen={showShareDialog}
          onOpenChange={setShowShareDialog}
          disableFullscreenOnMobile
        >
          <DialogHeader>
            <div className="flex items-center gap-2">
              <span className="flex h-8 w-8 items-center justify-center bg-primary/10 text-primary">
                <Share2 className="h-4 w-4" />
              </span>
              <DialogTitle>{t('notes.share.title', 'Share Note')}</DialogTitle>
            </div>
            <DialogDescription className="text-xs pt-1">
              {t('notes.share.descriptionShort', 'Invite a workspace member by email and pick what they can do.')}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 pt-2">
            <div className="space-y-1.5">
              <Label htmlFor="share-email" className="text-xs uppercase tracking-wide text-muted-foreground">
                {t('notes.share.emailLabel', 'Email address')}
              </Label>
              <div className="relative">
                <Mail className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  id="share-email"
                  data-testid="notes-share-email-input"
                  type="email"
                  placeholder={t('notes.share.emailPlaceholder', 'user@example.com')}
                  value={shareEmail}
                  onChange={(e) => setShareEmail(e.target.value)}
                  disabled={isSharing}
                  className="pl-9 h-10"
                  autoFocus
                />
              </div>
            </div>

            <div className="space-y-1.5">
              <Label className="text-xs uppercase tracking-wide text-muted-foreground">
                {t('notes.share.roleLabel', 'Role')}
              </Label>
              <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label={t('notes.share.roleLabel', 'Role')}>
                {([
                  {
                    key: 'editor' as const,
                    icon: Edit3,
                    title: t('notes.share.roleEditorTitle', 'Editor'),
                    sub: t('notes.share.roleEditorSub', 'Can edit and comment'),
                  },
                  {
                    key: 'viewer' as const,
                    icon: Eye,
                    title: t('notes.share.roleViewerTitle', 'Viewer'),
                    sub: t('notes.share.roleViewerSub', 'Can only view'),
                  },
                ]).map(({ key, icon: Icon, title, sub }) => {
                  const selected = shareRole === key;
                  return (
                    <button
                      key={key}
                      type="button"
                      role="radio"
                      aria-checked={selected}
                      data-testid={`notes-share-role-${key}`}
                      onClick={() => setShareRole(key)}
                      disabled={isSharing}
                      className={cn(
                        'flex items-start gap-2 border px-3 py-2.5 text-left transition-colors',
                        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                        selected
                          ? 'border-primary bg-primary/5'
                          : 'border-border hover:border-foreground/30 bg-background'
                      )}
                    >
                      <Icon className={cn('h-4 w-4 mt-0.5 shrink-0', selected ? 'text-primary' : 'text-muted-foreground')} />
                      <div className="min-w-0">
                        <div className={cn('text-sm font-medium', selected ? 'text-foreground' : 'text-foreground/90')}>
                          {title}
                        </div>
                        <div className="text-xs text-muted-foreground leading-tight">{sub}</div>
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          </div>

          <DialogFooter className="pt-2">
            <Button
              variant="ghost"
              size="sm"
              data-testid="notes-share-cancel-button"
              onClick={() => setShowShareDialog(false)}
              disabled={isSharing}
            >
              {t('common.cancel', 'Cancel')}
            </Button>
            <Button
              size="sm"
              data-testid="notes-share-submit-button"
              onClick={handleShare}
              disabled={isSharing || !shareEmail.trim()}
              className="gap-1.5"
            >
              {isSharing ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  {t('notes.share.sharing', 'Sharing…')}
                </>
              ) : (
                <>
                  <Send className="h-3.5 w-3.5" />
                  {t('notes.share.submit', 'Share Note')}
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      )}

      {/* New Note Confirmation Dialog */}
      <AlertDialog open={showNewNoteDialog} onOpenChange={setShowNewNoteDialog}>
        <AlertDialogContent data-testid="notes-new-note-dialog">
          <AlertDialogHeader>
            <AlertDialogTitle>{t('notes.dialogs.newNote.title')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('notes.dialogs.newNote.description')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="notes-new-note-cancel">{t('notes.dialogs.newNote.cancel')}</AlertDialogCancel>
            <AlertDialogAction data-testid="notes-new-note-confirm" onClick={handleNewNoteConfirm}>
              {t('notes.dialogs.newNote.confirm')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Clear Notes Confirmation Dialog */}
      <AlertDialog open={showClearDialog} onOpenChange={setShowClearDialog}>
        <AlertDialogContent data-testid="notes-clear-dialog">
          <AlertDialogHeader>
            <AlertDialogTitle>{t('notes.dialogs.clearNotes.title')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('notes.dialogs.clearNotes.description')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="notes-clear-cancel">{t('notes.dialogs.clearNotes.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              data-testid="notes-clear-confirm"
              onClick={handleClearConfirm}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {t('notes.dialogs.clearNotes.confirm')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <PaperGenerationDialog
        open={showPaperDialog}
        onOpenChange={setShowPaperDialog}
        notesContent={notesContent}
      />
    </div>
  );
};
