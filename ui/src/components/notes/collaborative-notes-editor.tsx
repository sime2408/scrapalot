/**
 * Collaborative notes editor with Y.js integration
 * Supports real-time multi-user editing with presence indicators
 */

import React, { useEffect, useMemo, useState, useRef, useCallback, Component, ErrorInfo, ReactNode } from 'react';

/**
 * Error boundary specifically for TipTap EditorContent.
 * Catches the known "insertBefore" and "removeChild" errors that occur during
 * async cleanup when the editor is unmounting while Y.js updates arrive.
 *
 * Strategy: Catch the error, wait briefly for DOM to settle, then re-render children
 * using a key change to force a clean mount.
 */
class EditorContentErrorBoundary extends Component<
  { children: ReactNode; fallback?: ReactNode },
  { hasError: boolean; recoveryKey: number; errorCount: number }
> {
  private recoveryTimeout: ReturnType<typeof setTimeout> | null = null;
  private lastErrorTime = 0;

  constructor(props: { children: ReactNode; fallback?: ReactNode }) {
    super(props);
    this.state = { hasError: false, recoveryKey: 0, errorCount: 0 };
  }

  static getDerivedStateFromError(error: Error): { hasError: boolean } | null {
    // Only catch the specific DOM manipulation errors from TipTap
    const isKnownError =
      error.message?.includes('insertBefore') ||
      error.message?.includes('removeChild') ||
      error.name === 'NotFoundError';

    if (isKnownError) {
      console.log('[EditorContentErrorBoundary] Caught TipTap DOM error, will recover');
      return { hasError: true };
    }
    // Re-throw other errors - let them bubble up
    throw error;
  }

  componentDidUpdate(_prevProps: { children: ReactNode; fallback?: ReactNode }, prevState: { hasError: boolean; recoveryKey: number; errorCount: number }): void {
    // When we enter error state, schedule recovery
    if (this.state.hasError && !prevState.hasError) {
      // Track error frequency
      const now = Date.now();
      const timeSinceLastError = now - this.lastErrorTime;
      this.lastErrorTime = now;

      const newErrorCount = timeSinceLastError > 3000 ? 1 : this.state.errorCount + 1;

      // If too many errors in quick succession, give up
      if (newErrorCount > 5) {
        console.error('[EditorContentErrorBoundary] Too many rapid errors, staying in error state');
        return;
      }

      // Clear any existing timeout
      if (this.recoveryTimeout) {
        clearTimeout(this.recoveryTimeout);
      }

      // Wait for DOM to settle, then recover with new key
      this.recoveryTimeout = setTimeout(() => {
        this.recoveryTimeout = null;
        this.setState(prev => ({
          hasError: false,
          recoveryKey: prev.recoveryKey + 1,
          errorCount: newErrorCount
        }));
      }, 100); // Short delay - just enough for current frame to complete
    }
  }

  componentDidCatch(error: Error, _errorInfo: ErrorInfo): void {
    console.log('[EditorContentErrorBoundary] TipTap error caught:', error.message?.substring(0, 60));
  }

  componentWillUnmount(): void {
    if (this.recoveryTimeout) {
      clearTimeout(this.recoveryTimeout);
    }
  }

  render(): ReactNode {
    // If in error state, show brief loading indicator
    if (this.state.hasError) {
      // Check if we've had too many errors
      if (this.state.errorCount > 5) {
        return this.props.fallback || (
          <div className="flex items-center justify-center h-32 text-muted-foreground text-sm">
            Editor initialization failed. Please close and reopen.
          </div>
        );
      }
      // Brief loading state during recovery
      return (
        <div className="flex items-center justify-center h-32 text-muted-foreground text-sm">
          Loading editor...
        </div>
      );
    }

    // Render children with recoveryKey to force clean mount after errors
    return (
      <div key={this.state.recoveryKey}>
        {this.props.children}
      </div>
    );
  }
}
import { createPortal } from 'react-dom';
import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Underline from '@tiptap/extension-underline';
import Link from '@tiptap/extension-link';
import Placeholder from '@tiptap/extension-placeholder';
import Collaboration from '@tiptap/extension-collaboration';
import TextStyle from '@tiptap/extension-text-style';
import Color from '@tiptap/extension-color';
import Highlight from '@tiptap/extension-highlight';
import TaskList from '@tiptap/extension-task-list';
import TaskItem from '@tiptap/extension-task-item';
import Table, { TableView as BaseTableView } from '@tiptap/extension-table';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import TableRow from '@tiptap/extension-table-row';
import TableCell from '@tiptap/extension-table-cell';
import TableHeader from '@tiptap/extension-table-header';
import TextAlign from '@tiptap/extension-text-align';
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import { SlashCommandExtension } from './slash-command-extension';
import { BlockMenu } from './block-menu';
import { BlockFloatingToolbar } from './block-floating-toolbar';
import { Toggle } from './extensions/toggle-extension';
import { Callout } from './extensions/callout-extension';
import { EnhancedImage } from './extensions/enhanced-image-extension';
import { CodeBlockWithLanguage } from './extensions/code-block-with-language';
import { CommentMark } from './extensions/comment-mark';
import { CitationMark } from './extensions/citation-mark';
import { BibliographyNode } from './extensions/bibliography-node';
import { TrailingParagraph } from './extensions/trailing-paragraph';
import { MarkdownPaste } from './extensions/markdown-paste';
import { PageBreakDecoration } from './extensions/page-break-decoration';
import { ActiveBlockDecoration } from './extensions/active-block-decoration';
import { DragHandlePlugin } from './extensions/drag-handle-plugin';
import { AiAutocomplete } from './extensions/ai-autocomplete-extension';
import { PageHeadToolbar } from './page-head-toolbar';
import { TableAlignmentToolbar } from './extensions/table-alignment-toolbar';
import { MobileTableToolbar } from './extensions/mobile-table-toolbar';
import { MobileCellMenuPlugin } from './extensions/mobile-cell-menu-plugin';
import { TableBackspace } from './extensions/table-backspace-extension';
import { MobileCellMenu } from './extensions/mobile-cell-menu';
import { NotePageMetaRow } from './note-page-meta-row';
import { scrollToHeadingAnchor } from './extensions/heading-anchor';
import { TextSelection } from '@tiptap/pm/state';
import { useTableGripOverlay } from './hooks/use-table-grip-overlay';
import { TableGripOverlay } from './extensions/table-grip-overlay';
import { useTypingIndicator } from './hooks/use-typing-indicator';
import { SelectionToolbar } from './selection-toolbar';
import { isWholeTableSelected } from './extensions/table-commands';
import { CollaborationHeader } from './collaboration-header';
import { MobileEditorBar } from './mobile-editor-bar';
import { MarkdownImportDialog } from './markdown-import-dialog';
import { BibTeXImportDialog } from './bibtex-import-dialog';
import { CitationPickerDialog } from './citation-picker-dialog';
import { QuoteCitationBar } from './quote-citation-bar';
import { SimpleCommentInput } from './simple-comment-input';
import { HoverCommentBalloon } from './hover-comment-balloon';
import { ResearchResultsPanel } from './research-results-panel';
import { TextTransformPanel } from './text-transform-panel';
import { VerifyClaimPanel } from './verify-claim-panel';
import { FindCitationPanel } from './find-citation-panel';
import { PeerReviewPanel } from './peer-review-panel';
import { HypothesisPanel } from './hypothesis-panel';
import { WhatIfPanel } from './what-if-panel';
import { OutlinePanel } from './outline-panel';
import { cn } from '@/lib/utils';
import { useIsMobile } from '@/hooks/use-mobile';
import { useTranslation } from 'react-i18next';
import { useTheme } from '@/providers/theme-provider';
import { useCollections } from '@/contexts/collections-context';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { toast } from '@/lib/toast-compat';
import {
  createComment,
  toggleResolveComment,
  deleteComment,
  listComments,
  type NoteComment,
  type CreateCommentRequest,
} from '@/lib/api-notes';
import {
  getNotesEditorPreferences,
  saveNotesEditorPreferences,
} from '@/lib/api-settings';
import './editor/editor-theme.css';
import { authState } from '@/lib/api';
import { refreshToken as refreshAuthTokens } from '@/lib/auth/auth-service';

interface WorkspaceMember {
  id: string;
  username: string;
  email?: string;
  avatar_url?: string;
  role: 'owner' | 'editor' | 'viewer';
}

interface CollaborativeNotesEditorProps {
  noteId: string;
  workspaceId: string;
  userId: string;
  userName: string;
  userAvatar?: string;
  userColor?: string;
  content?: string;
  onChange?: (content: string) => void;
  placeholder?: string;
  className?: string;
  editable?: boolean;
  isReadOnly?: boolean;
  documentTitle?: string;
  createdBy?: {
    id: string;
    name: string;
    email?: string;
    avatar?: string;
  };
  workspaceMembers?: WorkspaceMember[];
  currentUserRole?: 'owner' | 'editor' | 'viewer' | null;
  onShare?: () => void;
  showCollaborationHeader?: boolean;
  showCommentsSidebar?: boolean;
  /** Auto-save status indicator */
  saveStatus?: import('./collaboration-header').SaveStatus;
  /** Callback fired when the TipTap editor instance is ready */
  onEditorReady?: (editor: import('@tiptap/core').Editor) => void;
  /**
   * Confluence-style page-head toolbar that appears above the H1 on hover
   * (md/lg only). When omitted the toolbar is not rendered. Drawer owns
   * the value + persistence; editor only mounts it and exposes the H1.
   */
  pageHead?: {
    value: import('./page-head-toolbar').PageHeadValue;
    handlers: import('./page-head-toolbar').PageHeadHandlers;
    layout: import('./page-head-toolbar').PageHeadLayoutHandlers;
  };
}

// Helper to validate UUID format
const isValidUUID = (str: string): boolean => {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  return uuidRegex.test(str);
};

// Generate consistent color for user based on ID
const getConsistentColor = (userId: string) => {
  const colors = [
    '#958DF1', // Purple
    '#F98181', // Red
    '#FBBC88', // Orange
    '#FAF594', // Yellow
    '#70CFF8', // Blue
    '#94FADB', // Teal
    '#B9F18D', // Green
  ];
  // Generate consistent hash from userId
  let hash = 0;
  for (let i = 0; i < userId.length; i++) {
    hash = userId.charCodeAt(i) + ((hash << 5) - hash);
  }
  return colors[Math.abs(hash) % colors.length];
};

// Generate random color for user cursor (fallback)
const getRandomColor = () => {
  const colors = [
    '#958DF1', // Purple
    '#F98181', // Red
    '#FBBC88', // Orange
    '#FAF594', // Yellow
    '#70CFF8', // Blue
    '#94FADB', // Teal
    '#B9F18D', // Green
  ];
  return colors[Math.floor(Math.random() * colors.length)];
};

/**
 * Custom NodeView for <table> nodes. TipTap's default TableView runs
 * `updateColumns` on every node update and either sets
 * `table.style.width = '${sumOfColWidths}px'` or clears it to ''
 * depending on whether all columns have explicit colwidths. Either way,
 * our user-set `node.attrs.width` gets wiped on the live DOM after every
 * autosave / Y.js sync / typing tick — which is exactly what made the
 * right-edge resize handle's effect "snap back to full width."
 *
 * We extend the base view and re-apply `node.attrs.width` with
 * `setProperty('width', value, 'important')` after every update, so it
 * defeats both `editor-theme.css { .ProseMirror table { width: 100%
 * !important } }` and TableView's own width writes.
 */
class TableViewWithUserWidth extends BaseTableView {
  constructor(node: ProseMirrorNode, cellMinWidth: number) {
    super(node, cellMinWidth);
    applyUserTableWidth(this.table, node);
  }

  update(node: ProseMirrorNode): boolean {
    const accepted = super.update(node);
    if (accepted) {
      applyUserTableWidth(this.table, node);
    }
    return accepted;
  }
}

function applyUserTableWidth(table: HTMLTableElement, node: ProseMirrorNode): void {
  const w = node.attrs.width as string | null | undefined;
  if (w) {
    table.style.setProperty('width', String(w), 'important');
    table.style.minWidth = '';
  } else {
    table.style.removeProperty('width');
  }
}

export const CollaborativeNotesEditor: React.FC<CollaborativeNotesEditorProps> = ({
  noteId,
  workspaceId: _workspaceId,
  userId,
  userName,
  userAvatar,
  userColor = getConsistentColor(userId),
  content = '',
  onChange,
  placeholder = "Press '/' for commands...",
  className,
  editable = true,
  isReadOnly = false,
  documentTitle = 'Untitled Document',
  createdBy,
  workspaceMembers = [],
  currentUserRole: _currentUserRole = null,
  onShare,
  showCollaborationHeader = true,
  showCommentsSidebar = true,
  saveStatus = 'idle',
  onEditorReady,
  pageHead,
}) => {
  const { theme } = useTheme();
  const { t } = useTranslation();
  const { collections } = useCollections();
  const allCollectionIds = React.useMemo(() => collections.map(c => c.id), [collections]);
  const isMobile = typeof window !== 'undefined' && window.innerWidth <= 1080;
  const [isEditorFocused, setIsEditorFocused] = useState(false);
  const [ydoc] = useState(() => new Y.Doc());
  const [provider, setProvider] = useState<WebsocketProvider | null>(null);
  const [_activeUsers, setActiveUsers] = useState<number>(0);
  const [collaboratorStates, setCollaboratorStates] = useState<Map<string, unknown>>(new Map());
  const [connectionStatus, setConnectionStatus] = useState<'connecting' | 'connected' | 'disconnected'>('connecting');
  // Ref mirror of connectionStatus so the noteId-reset effect's setTimeout
  // callback can read the live value without re-running on every status
  // flip (which would itself reset the duplication guards mid-sync).
  const connectionStatusRef = useRef<'connecting' | 'connected' | 'disconnected'>('connecting');
  useEffect(() => {
    connectionStatusRef.current = connectionStatus;
  }, [connectionStatus]);
  const [initialContentLoaded, setInitialContentLoaded] = useState(false); // State to trigger WebSocket connection
  const isConnectingRef = useRef(false); // Prevent duplicate connections
  const cleanupRef = useRef<(() => void) | null>(null);
  const lastNoteIdRef = useRef<string | null>(null); // Track last noteId to detect changes
  const initialContentLoadedRef = useRef(false); // Track if initial content has been loaded into Y.js doc
  const wsCheckIntervalRef = useRef<NodeJS.Timeout | null>(null); // Track WebSocket status check interval

  // Comment sidebar state
  const [selectedTextForComment, setSelectedTextForComment] = useState<{
    from: number;
    to: number;
    text: string;
  } | null>(null);

  // Comment balloon state
  const [activeBalloonComment, setActiveBalloonComment] = useState<NoteComment | null>(null);
  const [balloonPosition, setBalloonPosition] = useState<{ top: number; right: number }>({ top: 0, right: 0 });

  // Hover balloon state - shows on hover over comment highlights
  const [hoverBalloonComment, setHoverBalloonComment] = useState<NoteComment | null>(null);
  const [hoverBalloonPosition, setHoverBalloonPosition] = useState<{ top: number; left: number }>({ top: 0, left: 0 });
  const [hoveredCommentId, setHoveredCommentId] = useState<string | null>(null);
  const [isBalloonPinned, setIsBalloonPinned] = useState(false); // Track if balloon is pinned open (clicked)

  // Delete confirmation dialog state
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [commentToDelete, setCommentToDelete] = useState<string | null>(null);

  // Markdown import dialog state
  const [markdownImportOpen, setMarkdownImportOpen] = useState(false);
  // Ruler + per-side margin customisation removed by user direction —
  // the ruler interfered with the Page-width control and ate viewport
  // space without a clear payoff. Cells use a fixed minimal padding now.
  const [editorOrientation, setEditorOrientation] = useState<'portrait' | 'landscape'>('portrait');
  // Paper size + screen width: split out from the old binary
  // orientation toggle so the writer can pick a wide on-screen page
  // while still printing to A4 (or A3 / A5).  Defaults match the
  // prior behaviour (A4 portrait, page width = paper width).
  const [paperSize, setPaperSize] = useState<'A4' | 'A3' | 'A5'>('A4');
  const [screenWidth, setScreenWidth] = useState<'paper' | 'wide' | 'full'>('paper');
  const prefsLoadedRef = useRef(false);
  const prefsSaveTimerRef = useRef<NodeJS.Timeout | null>(null);
  // Container width tracked here — only matters when screenWidth is
  // 'wide', but the state lives at this scope so the useMemo below
  // can read it.
  const [containerWidth, setContainerWidth] = useState<number>(() =>
    typeof window !== 'undefined' ? window.innerWidth : 1280,
  );

  // BibTeX import dialog state
  const [bibImportOpen, setBibImportOpen] = useState(false);

  // Citation picker dialog state
  const [citationPickerOpen, setCitationPickerOpen] = useState(false);

  // AI Research Assistant panel states
  const [aiResearchState, setAiResearchState] = useState<{
    type: 'research' | 'citation' | 'transform' | 'verify' | 'hypothesis' | 'outline' | 'review' | null;
    selectedText: string;
    from: number;
    to: number;
    transformType?: 'academic' | 'simplify' | 'expand' | 'translate';
    // Feature 3 — only used when type === 'review': the full note body
    // (not selection) that the peer review panel should score.
    reviewContent?: string;
    reviewSourceType?: 'note' | 'deep_research' | 'paper' | 'unknown';
    reviewSourceTitle?: string;
    position: { top: number; left: number };
  }>({ type: null, selectedText: '', from: 0, to: 0, position: { top: 0, left: 0 } });

  // Block menu state (opened by drag handle clicks or right-click).
  // `targetPos` carries the PM position of the clicked row so menu
  // actions can pre-seed the selection on the right block, even if a
  // Radix popover focus-grab clobbered the in-editor selection between
  // gutter click and action click.
  const [menuState, setMenuState] = useState<{
    isOpen: boolean;
    position: { x: number; y: number };
    blockIndex: number | null;
    targetPos: number | null;
    showContextMenu?: boolean; // true for right-click context menu
  }>({
    isOpen: false,
    position: { x: 0, y: 0 },
    blockIndex: null,
    targetPos: null,
  });

  // Block floating toolbar state (Confluence-style, opened by 6-dot grip click)
  const [floatingToolbar, setFloatingToolbar] = useState<{
    isOpen: boolean;
    position: { top: number; left: number; width: number };
    blockIndex: number | null;
  }>({
    isOpen: false,
    position: { top: 0, left: 0, width: 0 },
    blockIndex: null,
  });

  // Ref for the menu container to detect outside clicks
  const menuContainerRef = useRef<HTMLDivElement>(null);

  // Ref for the editor container (used by drag handle overlay)
  const editorContainerRef = useRef<HTMLDivElement>(null);

  // The scrollable .notes-container that wraps the page wrapper. We
  // expose it as a reactive state so the PageHeadToolbar can attach
  // its hover listeners as soon as the element mounts. Plain useRef
  // wouldn't re-render the toolbar when the element finally lands.
  const [notesScrollEl, setNotesScrollEl] = useState<HTMLElement | null>(null);
  const setNotesScrollRef = useCallback((node: HTMLDivElement | null) => {
    setNotesScrollEl(node);
  }, []);

  // Plain-text body content — feeds the NotePageMetaRow's reading-time
  // calculation. Derived from the HTML content prop rather than the
  // editor instance (which isn't reactive on update calls) so the
  // estimate stays in sync as the user types.
  const bodyPlainText = useMemo(() => {
    if (typeof window === 'undefined') return '';
    const tmp = document.createElement('div');
    tmp.innerHTML = content || '';
    return tmp.textContent || '';
  }, [content]);

  const [isMounted, setIsMounted] = useState(false);
  const isMobileEditor = useIsMobile();

  // Wide-screen page width — on big monitors the writer wants more
  // horizontal room than A4's 21 cm. We grow the on-screen page up to
  // ~85 % of the available container width while clamping above A4
  // (so a small drawer never gives a page narrower than A4) and below
  // a hard upper bound (so a 4K screen doesn't produce a 2500 px line
  // length that's painful to read). Print CSS forces the container
  // back to A4 so PDFs stay A4 regardless of how the user dragged the
  // on-screen ruler. 794 px = 21 cm @ 96 DPI; 1123 px = 29.7 cm @ 96.
  //
  // We attach the ResizeObserver via a *callback ref* rather than a
  // `useEffect` keyed off `editorContainerRef.current` because the
  // container only mounts AFTER the TipTap editor finishes its async
  // setup, which happens after the first commit pass. A ref-cell-
  // reading effect with an empty dep array would fire once on first
  // mount and observe a not-yet-attached node — exactly what we saw
  // in production where containerWidth stayed at the initial
  // window.innerWidth (2560 px) on a 4K display and the editor
  // pegged at the 1600 px upper cap.  The callback fires on every
  // mount/unmount of the .notes-page-container, so we stash the
  // observer on the node itself for clean disconnect.
  const observePageRef = useCallback((node: HTMLDivElement | null) => {
    // Always disconnect any previous observer first (React calls the
    // callback ref with null on unmount and with the new node on
    // re-mount).
    type Cell = HTMLDivElement & { __pageRO?: ResizeObserver };
    const prev = (window as unknown as { __scrapalotPageWrapperNode?: Cell }).__scrapalotPageWrapperNode;
    if (prev?.__pageRO) {
      prev.__pageRO.disconnect();
      delete prev.__pageRO;
    }
    if (!node || typeof ResizeObserver === 'undefined') {
      (window as unknown as { __scrapalotPageWrapperNode?: Cell }).__scrapalotPageWrapperNode = undefined;
      // Keep editorContainerRef behaviour intact for callers that read it.
      editorContainerRef.current = node;
      return;
    }
    editorContainerRef.current = node;
    // Measure the parent (the scrollable notes-container) — that's
    // the real horizontal real estate available to the page.  The
    // container itself is the thing we're sizing, so observing it
    // would be circular.
    const parent = node.parentElement as HTMLElement | null;
    if (!parent) return;
    const update = () => {
      const w = parent.getBoundingClientRect().width;
      if (w > 0) setContainerWidth(w);
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(parent);
    (node as Cell).__pageRO = ro;
    (window as unknown as { __scrapalotPageWrapperNode?: Cell }).__scrapalotPageWrapperNode = node as Cell;
  }, []);
  // Paper-size dimensions in px @ 96 DPI.  Cm conversions:
  //   A5 = 148×210mm  → 559×794
  //   A4 = 210×297mm  → 794×1123
  //   A3 = 297×420mm  → 1123×1587
  const paperDims = useMemo(() => {
    const PAPER: Record<typeof paperSize, { portrait: [number, number]; landscape: [number, number] }> = {
      A5: { portrait: [559, 794], landscape: [794, 559] },
      A4: { portrait: [794, 1123], landscape: [1123, 794] },
      A3: { portrait: [1123, 1587], landscape: [1587, 1123] },
    };
    const [w, h] = PAPER[paperSize][editorOrientation];
    return { paperWidthPx: w, paperHeightPx: h };
  }, [paperSize, editorOrientation]);

  const pageWidthPx = useMemo(() => {
    void paperDims; // paper dims still drive page-break overlay below
    if (isMobileEditor) return containerWidth;
    // Page-width presets are CONTAINER-relative, not paper-relative.
    //   - paper  → ~80 % of container, capped at 820 px (default)
    //   - wide   → ~95 % of container, capped at 1200 px
    //   - full   → 100 % of container (no gutters)
    if (screenWidth === 'paper') {
      return Math.min(820, Math.max(480, Math.floor(containerWidth * 0.8)));
    }
    if (screenWidth === 'wide') {
      return Math.min(1200, Math.max(720, Math.floor(containerWidth * 0.95)));
    }
    // 'full'
    return containerWidth;
  }, [paperDims, containerWidth, screenWidth, isMobileEditor]);

  // Page-break visualization height: vertical span between page
  // boundaries in editor coordinates.  Subtract a 4 cm vertical
  // margin allowance (≈2 cm top + 2 cm bottom @ 96 DPI = 152 px) so
  // the gridlines fall where actual page breaks would land in print.
  const notesPageHeightPx = useMemo(() => {
    const usable = paperDims.paperHeightPx - 152;
    return Math.max(280, usable);
  }, [paperDims]);

  const updateErrorCountRef = useRef(0); // Track corrupted update errors
  const MAX_UPDATE_ERRORS = 3; // Max errors before forcing reconnection

  const updateStatsRef = useRef({ total: 0, errors: 0, totalBytes: 0, avgSize: 0 }); // Update statistics

  // Content loading refs
  const contentLoadedRef = useRef(false);
  const lastLoadedContentRef = useRef<string>('');
  const noteChangeInProgressRef = useRef(false); // FIX: Block WebSocket during note transitions
  // FIX: Whether the Y.js provider has finished its first sync for the
  // current noteId. Used to gate editor.commands.setContent so it never
  // runs before the server's persisted yjs_state has been applied to
  // the ydoc (that combination duplicated the note content on every
  // open — classic CRDT merge race).
  const [wsSyncedOnce, setWsSyncedOnce] = useState(false);
  const wsSyncedOnceRef = useRef(false);

  // FIX: Debounce timer for onChange to prevent React reconciliation during typing
  const onChangeTimerRef = useRef<NodeJS.Timeout | null>(null);

  // Track if WebSocket provider is in a valid state for TipTap to use
  // This prevents TipTap from trying to use a destroyed provider during error recovery
  const isProviderValidRef = useRef(false);

  // Refs for callbacks to avoid editor recreation
  const onChangeRef = useRef(onChange);
  const editableRef = useRef(editable);
  const userNameRef = useRef(userName);

  // Update refs when props change
  useEffect(() => {
    onChangeRef.current = onChange;
    editableRef.current = editable;
    userNameRef.current = userName;
  }, [onChange, editable, userName]);

  // Load persisted orientation + paper size + screen width once on
  // mount. Per-side margin (left_margin / right_margin) is no longer
  // tracked — the ruler was removed.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        await authState.waitForAuthReady();
        const prefs = await getNotesEditorPreferences();
        if (cancelled) return;
        if (prefs) {
          if (prefs.orientation === 'landscape' || prefs.orientation === 'portrait') {
            setEditorOrientation(prefs.orientation);
          }
          if (prefs.paper_size === 'A3' || prefs.paper_size === 'A4' || prefs.paper_size === 'A5') {
            setPaperSize(prefs.paper_size);
          }
          if (
            prefs.screen_width === 'wide' ||
            prefs.screen_width === 'paper' ||
            prefs.screen_width === 'full'
          ) {
            setScreenWidth(prefs.screen_width);
          }
        }
      } finally {
        if (!cancelled) prefsLoadedRef.current = true;
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Debounced persistence of orientation / paper-size / screen-width
  // changes — margins dropped.
  useEffect(() => {
    if (!prefsLoadedRef.current) return;
    if (prefsSaveTimerRef.current) clearTimeout(prefsSaveTimerRef.current);
    prefsSaveTimerRef.current = setTimeout(() => {
      void saveNotesEditorPreferences({
        orientation: editorOrientation,
        paper_size: paperSize,
        screen_width: screenWidth,
      });
    }, 500);
    return () => {
      if (prefsSaveTimerRef.current) clearTimeout(prefsSaveTimerRef.current);
    };
  }, [editorOrientation, paperSize, screenWidth]);

  // Listen for orientation toggle dispatched from the notes-drawer toolbar
  useEffect(() => {
    const handler = () => {
      setEditorOrientation(prev => (prev === 'portrait' ? 'landscape' : 'portrait'));
    };
    window.addEventListener('notes-toggle-orientation', handler);
    return () => window.removeEventListener('notes-toggle-orientation', handler);
  }, []);

  // Listen for the consolidated layout-set event dispatched by the
  // notes-drawer toolbar's NoteLayoutPopover.  Lets the popover own
  // the source of truth for the toolbar UI while the editor mirrors
  // the same state for layout / page-break / persistence purposes.
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{
        paperSize?: 'A4' | 'A3' | 'A5';
        orientation?: 'portrait' | 'landscape';
        screenWidth?: 'paper' | 'wide' | 'full';
      }>).detail || {};
      if (detail.paperSize) setPaperSize(detail.paperSize);
      if (detail.orientation) setEditorOrientation(detail.orientation);
      if (detail.screenWidth) setScreenWidth(detail.screenWidth);
    };
    window.addEventListener('notes-set-layout', handler);
    return () => window.removeEventListener('notes-set-layout', handler);
  }, []);

  // FIX: Reset effect MUST be defined BEFORE WebSocket effect
  // React runs effects in definition order, so this ensures reset runs first when noteId changes
  // This prevents WebSocket from initializing with stale state during note transitions
  useEffect(() => {
    noteChangeInProgressRef.current = true;
    contentLoadedRef.current = false;
    lastLoadedContentRef.current = '';
    initialContentLoadedRef.current = false;
    setInitialContentLoaded(false);
    // CRITICAL: clear the WS-sync flag on note change. Without this,
    // the guard at line ~2230 inherits 'synced' from the previous
    // note, releases setContent before the new note's ydoc actually
    // received its persisted state from the server, and the REST
    // HTML gets merged on top of whatever the WS sync brings next —
    // doubling every block. Reproduced as the 2026-05-21 incident
    // where notes.content grew to exactly 2× its size with the
    // entire body repeated verbatim.
    wsSyncedOnceRef.current = false;
    setWsSyncedOnce(false);
    console.log('[CollaborativeNotesEditor] Reset content tracking for new noteId:', noteId);

    // Safety fallback: bumped 3 s → 10 s. The 3 s window was firing
    // BEFORE the real WS sync arrived on a loaded host (Hetzner under
    // workers + neo4j load — global CLAUDE.md notes a 3–5 s typical
    // sync delay), which flipped wsSyncedOnce true while the ydoc was
    // still empty. The post-sync guard then ran setContent on an
    // "empty" editor, ydoc got filled with REST HTML, and when the
    // actual server sync finally arrived Y.js CRDT-merged the two —
    // doubling every block in the document.
    //
    // 10 s comfortably covers the documented 3–5 s window and the
    // usual cold-cache spike. We additionally refuse to release the
    // guard while the WS is still in 'connecting' state — that means
    // the handshake is genuinely in flight and the sync is on its way;
    // forcing it here would race the real one. The fallback is only
    // meant to rescue "WS is dead / will never sync" scenarios where
    // connectionStatus has settled to 'connected' (handshake done, sync
    // never emitted — rare protocol-level glitch) or 'disconnected'
    // (we know WS won't help, REST fallback is correct).
    const fallbackTimer = setTimeout(() => {
      if (!initialContentLoadedRef.current) {
        console.warn('[CollaborativeNotesEditor] ⚠️ Forcing WebSocket initialization (10 s timeout fallback)');
        initialContentLoadedRef.current = true;
        noteChangeInProgressRef.current = false;
        setInitialContentLoaded(true);
      }
      if (!wsSyncedOnceRef.current) {
        if (connectionStatusRef.current === 'connecting') {
          // Still mid-handshake. Releasing the duplication guard now
          // would race the imminent real sync. Skip — if WS truly
          // never connects, the user can refresh; that's strictly
          // better than silently doubling their note.
          console.warn(
            '[CollaborativeNotesEditor] ⚠️ WS still connecting after 10 s — NOT releasing sync guard (avoids duplication race)',
          );
        } else {
          console.warn(
            '[CollaborativeNotesEditor] ⚠️ WS sync did not fire within 10 s (status=%s) — allowing setContent fallback',
            connectionStatusRef.current,
          );
          wsSyncedOnceRef.current = true;
          setWsSyncedOnce(true);
        }
      }
    }, 10000);

    return () => clearTimeout(fallbackTimer);
  }, [noteId]);

  // Initialize WebSocket provider
  useEffect(() => {
    console.log('🔍 WebSocket useEffect MOUNT for noteId:', noteId);
    console.log('📊 WebSocket useEffect state:', {
      noteId,
      initialContentLoaded,
      noteChangeInProgress: noteChangeInProgressRef.current,
      isConnecting: isConnectingRef.current,
      lastNoteId: lastNoteIdRef.current
    });

    // IMPORTANT: Only connect WebSocket for real note IDs (valid UUIDs)
    // When noteId is a sessionId or 'default', the note doesn't exist in the database yet.
    // Connecting with a non-existent noteId causes backend to disconnect after ~33 seconds
    // and creates an infinite reconnection loop.
    if (!isValidUUID(noteId)) {
      console.log('⏭️ WebSocket skipped - noteId is not a valid UUID (note not saved yet):', noteId);
      setConnectionStatus('disconnected');
      // Mark provider as invalid since we're not connecting
      isProviderValidRef.current = false;
      return;
    }

    // Prevent duplicate connections in React Strict Mode
    if (isConnectingRef.current && lastNoteIdRef.current === noteId) {
      console.log('🔒 WebSocket connection already in progress for this note, skipping');
      return;
    }

    console.log('🔌 Initializing WebSocket provider for noteId:', noteId, '(valid UUID, initial content loaded)');
    console.log('📊 WebSocket initialization conditions:', {
      initialContentLoaded,
      noteChangeInProgress: noteChangeInProgressRef.current,
      isConnecting: isConnectingRef.current,
      lastNoteId: lastNoteIdRef.current
    });
    isConnectingRef.current = true;
    lastNoteIdRef.current = noteId;
    // Add global error handler for Yjs errors
    const handleYjsError = (event: ErrorEvent) => {
      if (event.message?.includes('Unexpected end of array')) {
        // This is a known Y.js issue when WebSocket messages are incomplete
        // It's automatically retried by Y.js, so we can safely suppress it
        console.debug('[Y.js] Incomplete sync message received, will retry');
        event.preventDefault(); // Prevent crash and console error spam
      }
    };
    window.addEventListener('error', handleYjsError);

    // Determine WebSocket URL based on hostname (same logic as api.ts)
    let wsUrl: string;
    const hostname = window.location.hostname;
    const protocol = window.location.protocol;

    // Production domains - use backend API subdomain
    if (hostname === 'scrapalot.app' || hostname === 'www.scrapalot.app') {
      wsUrl = 'wss://api.scrapalot.app/api/ws/notes';
    }
    // For other production domains, construct URL dynamically
    else if (
      hostname !== 'localhost' &&
      hostname !== '127.0.0.1' &&
      !hostname.includes('192.168')
    ) {
      const wsProtocol = protocol === 'https:' ? 'wss' : 'ws';
      wsUrl = `${wsProtocol}://${hostname}/api/ws/notes`;
    }
    // Development fallback - use Gateway (8080) for proper routing
    else {
      const envApiUrl = import.meta.env.VITE_API_URL || 'http://localhost:8080';
      const wsProtocol = envApiUrl.startsWith('https') ? 'wss' : 'ws';
      const wsHost = envApiUrl.replace(/^https?:\/\//, '').replace(/\/api\/v1\/?$/, '');
      wsUrl = `${wsProtocol}://${wsHost}/api/ws/notes`;
    }

    // Get auth token from storage
    const authTokens = localStorage.getItem('auth_tokens') || sessionStorage.getItem('auth_tokens');
    let token = '';
    if (authTokens) {
      try {
        const parsed = JSON.parse(authTokens);
        token = parsed.access_token || '';
      } catch (e) {
        console.error('Failed to parse auth tokens:', e);
      }
    }

    let wsProvider: WebsocketProvider | null = null;

    // Guard against a storm of 1008 closes (each close event fires both
    // ws.addEventListener('close') AND the provider's 'connection-close'
    // event, and y-websocket keeps retrying in the background).
    let tokenRefreshInFlight = false;

    const handleTokenExpired = async (p: WebsocketProvider) => {
      if (tokenRefreshInFlight) return;
      tokenRefreshInFlight = true;
      try {
        console.log('🔑 Y.js WS: token expired — refreshing and reconnecting');
        p.disconnect();
        const tokens = await refreshAuthTokens();
        if (!tokens?.access_token) {
          console.error('🔑 Y.js WS: token refresh failed — staying disconnected');
          return;
        }
        // y-websocket caches `params` at construction time and re-reads
        // it on every reconnect via setupWS(), so mutating the object
        // here is enough to have the next handshake use the fresh token.
        // @ts-expect-error — y-websocket stores params on the instance
        p.params = { token: tokens.access_token };
        p.connect();
      } catch (err) {
        console.error('🔑 Y.js WS: token refresh error', err);
      } finally {
        setTimeout(() => { tokenRefreshInFlight = false; }, 5000);
      }
    };

    try {
      wsProvider = new WebsocketProvider(
        wsUrl,
        noteId,
        ydoc,
        {
          connect: true,
          params: { token },
          // Better reliability settings
          resyncInterval: 5000,      // Resync every 5 seconds
          disableBc: false,          // Enable broadcast channel for local sync
          maxBackoffTime: 5000,      // Cap reconnection backoff at 5 seconds
          WebSocketPolyfill: WebSocket,  // Ensure native WebSocket
        }
      );

      // Mark provider as valid for TipTap to use
      isProviderValidRef.current = true;

      console.log('WebsocketProvider created:', {
        url: wsUrl,
        noteId,
        hasToken: !!token,
        tokenLength: token?.length || 0
      });

      // Track WebSocket connection state changes
      const handleStatusChange = () => {
        if (wsProvider?.ws) {
          const readyState = wsProvider.ws.readyState;
          if (readyState === WebSocket.OPEN) {
            console.log('✓ WebSocket connection opened');
            setConnectionStatus('connected');
          } else if (readyState === WebSocket.CONNECTING) {
            console.log('⏳ WebSocket connecting...');
            setConnectionStatus('connecting');
          } else if (readyState === WebSocket.CLOSED || readyState === WebSocket.CLOSING) {
            console.log('⚠️ WebSocket disconnected');
            setConnectionStatus('disconnected');
          }
        }
      };

      // Listen to WebSocket lifecycle events
      wsCheckIntervalRef.current = setInterval(() => {
        if (wsProvider?.ws) {
          console.log('🔌 WebSocket instance found, adding event listeners');

          // Add event listeners to the WebSocket FIRST
          wsProvider.ws.addEventListener('open', () => {
            console.log('✓ WebSocket opened');
            setConnectionStatus('connected');
          });

          wsProvider.ws.addEventListener('close', (event: CloseEvent) => {
            console.warn('⚠️ WebSocket closed:', {
              code: event.code,
              reason: event.reason,
              wasClean: event.wasClean,
              noteId
            });
            setConnectionStatus('disconnected');

            // Handle specific close codes
            if (event.code === 4004) {
              // Note not found in database - stop reconnection attempts
              // This happens when the client has a stale noteId that was deleted or never created
              console.error('❌ Note not found in database - disabling auto-reconnect:', event.reason);
              // Disconnect the provider to stop reconnection attempts
              if (wsProvider) {
                wsProvider.disconnect();
                isProviderValidRef.current = false;
              }
            } else if (event.code === 1008 && wsProvider) {
              // Policy violation — almost always "Token expired" on our
              // backend. y-websocket would otherwise auto-reconnect in a
              // tight loop with the same stale token (console spam and
              // permanent disconnect). Refresh + reconnect.
              void handleTokenExpired(wsProvider);
            }
          });

          wsProvider.ws.addEventListener('error', (err) => {
            console.error('❌ WebSocket error:', err);
            setConnectionStatus('disconnected');
          });

          // Check current status AFTER adding listeners
          handleStatusChange();

          // Clear interval after setup is complete
          if (wsCheckIntervalRef.current) {
            clearInterval(wsCheckIntervalRef.current);
            wsCheckIntervalRef.current = null;
          }
        }
      }, 100); // Check every 100ms until ws is available

      wsProvider.on('sync', (isSynced: boolean) => {
        if (isSynced) {
          console.log('✓ Y.js document synced successfully');
          setConnectionStatus('connected');
          updateErrorCountRef.current = 0;  // Reset error count on successful sync
          if (!wsSyncedOnceRef.current) {
            wsSyncedOnceRef.current = true;
            setWsSyncedOnce(true);
          }
        }
      });

      wsProvider.on('connection-error', (error: unknown) => {
        console.warn('⚠️ WebSocket connection error:', error);
        setConnectionStatus('disconnected');

        // Force reconnect after brief delay
        setTimeout(() => {
          if (wsProvider && !wsProvider.wsconnected) {
            console.log('🔄 Attempting to reconnect...');
            wsProvider.connect();
          }
        }, 2000);
      });

      wsProvider.on('connection-close', (event: { code?: number; reason?: string }) => {
        console.warn('⚠️ WebSocket connection closed:', event?.code, event?.reason);
        if (event?.code === 4004) {
          // Note not found in database - stop reconnection
          console.error('❌ Note not found - stopping reconnection:', event?.reason);
          wsProvider.disconnect();
          isProviderValidRef.current = false;
        } else if (event?.code === 1008 && wsProvider) {
          void handleTokenExpired(wsProvider);
        } else if (event?.code === 1011 || event?.code === 1009) {
          // Backend closed due to error - force full resync
          console.log('🔄 Backend indicated error, will force full resync on reconnect');
          // Connection will auto-reconnect and resync
        }
      });

      // Add robust update validation and statistics tracking
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Y.js updateV2 event callback types not fully typed
      ydoc.on('updateV2', (update: Uint8Array, origin: any, _doc: Y.Doc, _tr: any) => {
        try {
          // Update statistics
          const stats = updateStatsRef.current;
          stats.total++;
          stats.totalBytes += update?.length || 0;
          stats.avgSize = stats.totalBytes / stats.total;

          // Log statistics every 100 updates
          if (stats.total % 100 === 0) {
            console.log('📊 Y.js Update Statistics:', {
              total: stats.total,
              errors: stats.errors,
              avgSize: Math.round(stats.avgSize),
              totalBytes: stats.totalBytes,
              errorRate: ((stats.errors / stats.total) * 100).toFixed(2) + '%',
            });
          }

          // Validate update integrity
          if (!update || update.length === 0) {
            console.warn('⚠️ Received empty Yjs update, ignoring');
            stats.errors++;
            return;
          }

          // Check for suspiciously small updates (likely corrupted)
          if (update.length < 5 && origin !== ydoc) {
            console.warn('⚠️ Received suspiciously small update (%d bytes), may be corrupted', update.length);
            updateErrorCountRef.current++;
            stats.errors++;

            if (updateErrorCountRef.current >= MAX_UPDATE_ERRORS) {
              console.error('❌ Too many corrupted updates, forcing reconnection');
              console.log('📊 Error Stats:', stats);
              wsProvider?.disconnect();
              setTimeout(() => wsProvider?.connect(), 1000);
              updateErrorCountRef.current = 0;
            }
            return;
          }

          // Reset error count on successful update
          if (update.length > 5) {
            updateErrorCountRef.current = 0;
          }
        } catch (error) {
          console.error('❌ Error processing Yjs updateV2:', error);
          updateErrorCountRef.current++;
          updateStatsRef.current.errors++;
        }
      });

      wsProvider.awareness.on('change', () => {
        try {
          const states = Array.from(wsProvider!.awareness.getStates().values());
          setActiveUsers(states.length);

          // Update collaborator states for presence indicators
          const newStates = new Map();
          wsProvider!.awareness.getStates().forEach((state, clientId) => {
            if (state && state.user) {
              newStates.set(clientId, {
                id: state.user.id || state.user.name || `user-${clientId}`,  // FIX: Use user.id first!
                name: state.user.name || 'Anonymous',
                color: state.user.color || getRandomColor(),
                isActive: true,
                lastSeen: new Date().toISOString(),
              });
            }
          });
          setCollaboratorStates(newStates);
        } catch (error) {
          console.error('Error updating active users:', error);
        }
      });

      setProvider(wsProvider);
    } catch (error) {
      console.warn('⚠️ Real-time collaboration unavailable - backend WebSocket server not connected');
      setConnectionStatus('disconnected');
      // Editor will still work in local-only mode without collaboration
    }

    // Store cleanup function
    const cleanup = () => {
      console.log('🧹 WebSocket useEffect CLEANUP for noteId:', noteId);
      console.log('🧹 Cleanup called at:', new Date().toISOString());

      // Clear the WebSocket status check interval
      if (wsCheckIntervalRef.current) {
        clearInterval(wsCheckIntervalRef.current);
        wsCheckIntervalRef.current = null;
      }

      // Only cleanup if this was the last noteId we connected to
      // This prevents cleanup during StrictMode double-mount
      if (lastNoteIdRef.current === noteId) {
        // Mark provider as invalid BEFORE disconnecting
        // This prevents TipTap from trying to use it during error recovery
        isProviderValidRef.current = false;

        window.removeEventListener('error', handleYjsError);
        if (wsProvider) {
          try {
            wsProvider.disconnect();
            wsProvider.destroy();
          } catch (error) {
            console.error('Error destroying WebSocket provider:', error);
          }
        }
        isConnectingRef.current = false;
      } else {
        console.log('⏭️ Skipping cleanup - noteId changed during mount');
      }
    };

    cleanupRef.current = cleanup;

    return cleanup;
  // eslint-disable-next-line react-hooks/exhaustive-deps -- deps are intentionally limited
  }, [noteId, ydoc]); // Re-initialize WebSocket when note changes

  // Typing indicator hook
  const { typingUsers, setTyping } = useTypingIndicator(provider, userId);

  // Initialize TipTap editor
  const editor = useEditor({
    immediatelyRender: false, // Prevent SSR issues and hydration mismatch
    extensions: [
      StarterKit.configure({
        heading: {
          levels: [1, 2, 3, 4, 5],
        },
        // Disable default code block - using custom CodeBlockWithLanguage instead
        codeBlock: false,
        // Disable history - Collaboration extension has its own history management
        history: false,
      }),
      Underline,
      Link.configure({
        openOnClick: false,
        HTMLAttributes: {
          class: 'text-primary underline cursor-pointer hover:text-primary/80',
        },
      }),
      Placeholder.configure({
        placeholder: ({ node, pos, editor }) => {
          // Suppress placeholder on EVERY heading (H1…H6) — Notion /
          // Confluence behaviour. Empty headings stay visually flat
          // until the user types. The document TITLE (first H1) is the
          // exception, but it can't go through this callback: the
          // Placeholder plugin's showOnlyCurrent only decorates the
          // focused node, so an unfocused empty title would never light
          // up. The title placeholder is handled purely in CSS below
          // (`h1:first-child:has(> br.ProseMirror-trailingBreak)`).
          if (node.type.name === 'heading') {
            return '';
          }
          // Suppress on tables, cells, headers, rows AND callouts
          // (info / warning / etc. — the boxed panel has its own
          // visual emphasis, the body placeholder reads as noise on
          // top of it). Also suppress on the toggle node so its
          // collapsible body doesn't show the long label inside.
          if (
            node.type.name === 'table' ||
            node.type.name === 'tableCell' ||
            node.type.name === 'tableHeader' ||
            node.type.name === 'tableRow' ||
            node.type.name === 'callout' ||
            node.type.name === 'toggle'
          ) {
            return '';
          }
          try {
            const $pos = editor.state.doc.resolve(pos);
            for (let d = $pos.depth; d > 0; d--) {
              const parentName = $pos.node(d).type.name;
              if (
                parentName === 'table' ||
                parentName === 'tableCell' ||
                parentName === 'tableHeader' ||
                parentName === 'tableRow' ||
                parentName === 'heading' ||
                parentName === 'callout' ||
                parentName === 'toggle'
              ) {
                return '';
              }
            }
          } catch {
            /* resolve can throw on stale positions — fall through */
          }
          return placeholder;
        },
      }),
      TextStyle,
      Color,
      Highlight.configure({
        multicolor: true,
      }),
      TaskList,
      TaskItem.configure({
        nested: true,
      }),
      EnhancedImage.configure({
        inline: false,
        allowBase64: true,
      }),
      Table.configure({
        resizable: true,
        View: TableViewWithUserWidth,
      }).extend({
        // Persist user-set table width / layout so it survives the
        // ProseMirror re-render that fires after every edit + Y.js
        // sync. Without these attributes, the right-edge resize
        // handle's inline `width: Npx` gets wiped the moment the
        // editor re-mounts the <table>.
        addAttributes() {
          return {
            ...this.parent?.(),
            width: {
              default: null,
              parseHTML: (el) => (el as HTMLElement).style.width || null,
              // Width is applied via the renderHTML override below, not
              // through attribute renderHTML. The Table extension's own
              // renderHTML injects `style: width: <colgroup-sum>px` LAST
              // in mergeAttributes, which silently overwrites anything
              // we set here (mergeAttributes' style-Map.set wipes the
              // `!important` flag along with the value). We must patch
              // the final style string ourselves — see renderHTML below.
              renderHTML: () => ({}),
            },
            tableLayout: {
              default: null,
              parseHTML: (el) => (el as HTMLElement).dataset.tableLayout || null,
              renderHTML: (attrs) =>
                attrs.tableLayout ? { 'data-table-layout': attrs.tableLayout } : {},
            },
            tableValign: {
              default: null,
              parseHTML: (el) => (el as HTMLElement).dataset.tableValign || null,
              renderHTML: (attrs) =>
                attrs.tableValign ? { 'data-table-valign': attrs.tableValign } : {},
            },
          };
        },
        renderHTML({ node, HTMLAttributes }) {
          const out = this.parent?.({ node, HTMLAttributes });
          const userWidth = node.attrs.width as string | null | undefined;
          if (!userWidth || !Array.isArray(out)) return out as never;
          // out = ['table', attrs, colgroup, ['tbody', 0]] — replace
          // any auto-injected `width: …` on attrs.style with ours plus
          // !important so `.ProseMirror table { width: 100% !important }`
          // (editor-theme.css) doesn't reclaim the line.
          const next = out.slice() as unknown[];
          const attrs = { ...(next[1] as Record<string, unknown>) };
          const existing = typeof attrs.style === 'string' ? attrs.style : '';
          const filtered = existing
            .split(';')
            .map((s: string) => s.trim())
            .filter(Boolean)
            .filter((s: string) => !/^width\s*:/i.test(s))
            .join('; ');
          attrs.style = filtered
            ? `${filtered}; width: ${userWidth} !important`
            : `width: ${userWidth} !important`;
          next[1] = attrs;
          return next as never;
        },
      }),
      TableRow,
      TableCell.extend({
        addAttributes() {
          return {
            ...this.parent?.(),
            background: {
              default: null,
              parseHTML: (el) => el.style.backgroundColor || null,
              renderHTML: (attrs) => attrs.background ? { style: `background-color: ${attrs.background}` } : {},
            },
          };
        },
      }),
      TableHeader.extend({
        addAttributes() {
          return {
            ...this.parent?.(),
            background: {
              default: null,
              parseHTML: (el) => el.style.backgroundColor || null,
              renderHTML: (attrs) => attrs.background ? { style: `background-color: ${attrs.background}` } : {},
            },
          };
        },
      }),
      TextAlign.configure({
        types: ['heading', 'paragraph'],
      }),
      // Slash command extension
      SlashCommandExtension.configure({
        onOpenMarkdownImport: () => setMarkdownImportOpen(true),
        onOpenBibImport: () => setBibImportOpen(true),
      }),
      // Toggle (collapsible sections)
      Toggle,
      // Callout (styled alert boxes)
      Callout,
      // Code block with language selector
      CodeBlockWithLanguage,
      // Confluence-style in-cell menu trigger (mobile-only via CSS)
      MobileCellMenuPlugin,
      // Backspace-into-table → land caret inside the last cell instead
      // of getting stuck against the atomic table node.
      TableBackspace,
      // Comment mark for highlighting commented text
      CommentMark,
      // Citation mark for inline academic citations
      CitationMark,
      // Bibliography node for formatted references section
      BibliographyNode,
      // Trailing paragraph - ensures empty line at end for clicking
      TrailingParagraph,
      // Markdown paste - auto-converts pasted Markdown to formatted text
      MarkdownPaste,
      // Page break decoration - visual A4 page markers
      PageBreakDecoration,
      // 7.6 — marks the top-level block containing the caret with
      // `.is-active-block` so notes-drawer.css can dim everything else
      // when focus mode is on.
      ActiveBlockDecoration,
      // Confluence-style [ + ⋮⋮ ] block gutter on every top-level
      // block. Renders Decoration widgets that the CollaborativeNotes
      // Editor's click listener wires up to BlockMenu open / insert-
      // below. CSS reveals on hover and on .is-active-block (≥ 1280 px
      // viewport only — below that the gutter would clip into prose).
      DragHandlePlugin,
      // 7.1 — opt-in AI autocomplete (ghost text). Defaults to off; the
      // toolbar toggle flips storage.aiAutocomplete.enabled at runtime
      // via `editor.commands.setAutocompleteEnabled(...)`.
      AiAutocomplete.configure({
        defaultEnabled: (() => {
          try {
            return window.localStorage.getItem('scrapalot_notes_ai_autocomplete') === 'true';
          } catch { return false; }
        })(),
      }),
      // HeadingAnchor DISABLED - DOM mutation in plugin update() causes editor freeze
      // HeadingAnchor.configure({
      //   onLinkCopied: (slug) => {
      //     toast.success(t('notes.linkCopied', 'Link copied to clipboard'));
      //   },
      // }),
      // Collaboration extension - ALWAYS include (binds editor to Y.js doc)
      // This must be present from the start so setContent() populates the Y.js doc
      Collaboration.configure({
        document: ydoc,
      }),
      // NOTE: CollaborationCursor NOT included here — provider set via awareness effect
      // Including it would require provider in useEditor deps, causing full editor recreation on WS connect
    ],
    editable: editable && !isReadOnly,
    editorProps: {
      attributes: {
        class: cn(
          'prose max-w-none',
          'focus:outline-none',
          'min-h-[29.7cm]',
          'text-left',
          // Notion-like styling
          'prose-headings:font-bold prose-headings:tracking-tight',
          'prose-h1:text-4xl prose-h1:mb-4 prose-h1:mt-8',
          'prose-h2:text-3xl prose-h2:mb-3 prose-h2:mt-6',
          'prose-h3:text-2xl prose-h3:mb-2 prose-h3:mt-4',
          'prose-p:text-base prose-p:leading-6 prose-p:my-1.5',
          'prose-li:my-1',
          'prose-ul:my-4 prose-ol:my-4',
          'prose-blockquote:border-l-4 prose-blockquote:border-primary prose-blockquote:pl-4 prose-blockquote:italic',
          'prose-code:bg-muted prose-code:px-1.5 prose-code:py-0.5 prose-code:rounded',
          'prose-pre:bg-muted',
          'prose-img:rounded-lg prose-img:shadow-md',
          'prose-hr:my-8 prose-hr:border-border',
          // Table styles handled by editor-theme.css (not Tailwind prose overrides)
          theme === 'dark' ? 'prose-invert text-white' : '',
          className
        ),
      },
      handleKeyDown: (view, event) => {
        if (event.key === 'Tab') {
          // 7.1 — if the AiAutocomplete extension has a ghost
          // suggestion on screen, Tab accepts it.  This branch sits
          // ABOVE the editor's tab-character / heading-skip handler
          // because `editorProps.handleKeyDown` runs before any
          // extension plugin in ProseMirror's keymap chain — the
          // only place where we can reliably claim Tab before this
          // very same handler's tab-character branch (further down)
          // would otherwise insert four spaces.  When no ghost is up
          // we fall through to the existing tab-character logic.
          if (!event.shiftKey) {
            // Locate the AiAutocomplete plugin by its key prefix.
            // We don't import the key directly here to avoid pulling
            // editor extensions into the editor-host module.
            const aiPlugin = view.state.plugins.find((p) => {
              const k = (p as unknown as { key?: string }).key;
              return typeof k === 'string' && k.startsWith('aiAutocomplete');
            });
            const aiState = aiPlugin?.getState(view.state) as
              | { suggestion?: string }
              | undefined;
            if (aiState?.suggestion) {
              event.preventDefault();
              const tr = view.state.tr.insertText(aiState.suggestion);
              // Same meta the AiAutocomplete plugin uses to clear its
              // decoration (see ai-autocomplete-extension.ts).
              const aiKey = (aiPlugin as unknown as { spec: { key: unknown } }).spec.key;
              tr.setMeta(aiKey as never, { type: 'clear' });
              view.dispatch(tr);
              return true;
            }
          }
          event.preventDefault();
          const { state, dispatch } = view;
          const { $from, from, to } = state.selection;
          const isHeading = $from.parent.type.name === 'heading';

          if (event.shiftKey) {
            // Shift+Tab: remove leading tab/spaces from current line
            const lineStart = $from.start();
            const textBefore = state.doc.textBetween(lineStart, from);
            if (textBefore.startsWith('\t')) {
              dispatch(state.tr.delete(lineStart, lineStart + 1));
            } else if (textBefore.startsWith('    ')) {
              dispatch(state.tr.delete(lineStart, lineStart + 4));
            }
          } else if (isHeading) {
            // Tab from heading: move cursor to the next block (or create paragraph after heading)
            const afterHeading = $from.after();
            if (afterHeading < state.doc.content.size) {
              const nextPos = state.doc.resolve(afterHeading + 1);
              dispatch(state.tr.setSelection(new TextSelection(nextPos)));
            } else {
              // No block after heading - create a paragraph and move there
              const { paragraph } = state.schema.nodes;
              const tr = state.tr.insert(afterHeading, paragraph.create());
              const newPos = tr.doc.resolve(afterHeading + 1);
              dispatch(tr.setSelection(new TextSelection(newPos)));
            }
          } else {
            // Regular text: insert tab indentation (4 spaces)
            const tabText = '    ';
            dispatch(state.tr.insertText(tabText, from, to));
          }
          return true;
        }
        return false;
      },
    },
    onUpdate: ({ editor, transaction }) => {
      if (!transaction.docChanged) return; // Skip selection-only updates
      if (!onChangeRef.current) return;

      // Clear previous timer
      if (onChangeTimerRef.current) {
        clearTimeout(onChangeTimerRef.current);
      }

      // Debounce: serialize HTML only after 150ms of inactivity
      onChangeTimerRef.current = setTimeout(() => {
        if (!editor.isDestroyed) {
          onChangeRef.current?.(editor.getHTML());
        }
      }, 150);
    },
    onSelectionUpdate: () => {
      // Trigger typing indicator
      if (editableRef.current) {
        setTyping(true, userNameRef.current);

        // Auto-stop typing indicator after 1.5 seconds of inactivity
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- using window for debounce timer storage
        clearTimeout((window as any).typingTimeout);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- using window for debounce timer storage
        (window as any).typingTimeout = setTimeout(() => {
          setTyping(false, userNameRef.current);
        }, 1500);
      }
    },
    onFocus: () => {
      setIsEditorFocused(true);
    },
    onBlur: () => {
      // Small delay to allow clicking toolbar buttons
      setTimeout(() => {
        setIsEditorFocused(false);
      }, 150);
    },
    onDestroy: () => {
      // Editor cleanup complete - just log for debugging
      console.log('[EditorLifecycle] TipTap editor onDestroy called, cleanup complete');
    },
  }, [ydoc]); // Only recreate when Y.js doc changes — NOT provider (handled dynamically)

  // Set mounted flag after initial render to allow editor to initialize
  // The EditorContentErrorBoundary handles any insertBefore errors during rapid open/close
  useEffect(() => {
    setIsMounted(true);
    return () => setIsMounted(false);
  }, []);

  // Expose editor instance to parent via callback
  useEffect(() => {
    if (editor && onEditorReady) {
      onEditorReady(editor);
    }
  }, [editor, onEditorReady]);

  // Listen for citation picker custom event from slash commands
  useEffect(() => {
    const handleOpenCitationPicker = () => setCitationPickerOpen(true);
    window.addEventListener('open-citation-picker', handleOpenCitationPicker);

    // AI Research Assistant event handlers
    const getPanelPosition = (detail: { from: number; to: number }) => {
      if (!editor?.view) return { top: 200, left: 400 };
      const coords = editor.view.coordsAtPos(detail.to);
      return { top: coords.bottom + 8, left: Math.min(coords.left, window.innerWidth - 400) };
    };

    const handleAiResearch = (e: Event) => {
      const { selectedText, from, to } = (e as CustomEvent).detail;
      setAiResearchState({ type: 'research', selectedText, from, to, position: getPanelPosition({ from, to }) });
    };
    const handleAiCitation = (e: Event) => {
      const { selectedText, from, to } = (e as CustomEvent).detail;
      setAiResearchState({ type: 'citation', selectedText, from, to, position: getPanelPosition({ from, to }) });
    };
    const handleAiTransform = (e: Event) => {
      const { selectedText, from, to, transformType } = (e as CustomEvent).detail;
      setAiResearchState({ type: 'transform', selectedText, from, to, transformType, position: getPanelPosition({ from, to }) });
    };
    const handleAiVerify = (e: Event) => {
      const { selectedText, from, to } = (e as CustomEvent).detail;
      setAiResearchState({ type: 'verify', selectedText, from, to, position: getPanelPosition({ from, to }) });
    };
    // Feature 3 — peer review panel trigger
    const handleAiReview = (e: Event) => {
      const { content, sourceType, sourceTitle, anchorFrom } = (e as CustomEvent).detail as {
        content: string;
        sourceType: 'note' | 'deep_research' | 'paper' | 'unknown';
        sourceTitle: string;
        anchorFrom: number;
      };
      const pos = getPanelPosition({ from: anchorFrom, to: anchorFrom });
      setAiResearchState({
        type: 'review',
        selectedText: '',
        from: anchorFrom,
        to: anchorFrom,
        reviewContent: content,
        reviewSourceType: sourceType,
        reviewSourceTitle: sourceTitle,
        position: pos,
      });
    };
    const handleAiHypothesis = (e: Event) => {
      const { context } = (e as CustomEvent).detail;
      const pos = editor ? getPanelPosition(editor.state.selection) : { top: 200, left: 200 };
      setAiResearchState({ type: 'hypothesis', selectedText: context, from: 0, to: 0, position: pos });
    };
    const handleAiWhatIf = (e: Event) => {
      const { context } = (e as CustomEvent).detail;
      const pos = editor ? getPanelPosition(editor.state.selection) : { top: 200, left: 200 };
      setAiResearchState({ type: 'what-if', selectedText: context, from: 0, to: 0, position: pos });
    };
    const handleAiOutline = (e: Event) => {
      const { context } = (e as CustomEvent).detail;
      const pos = editor ? getPanelPosition(editor.state.selection) : { top: 200, left: 200 };
      setAiResearchState({ type: 'outline', selectedText: context, from: 0, to: 0, position: pos });
    };

    // Insert discovery from deep research panel into notes
    const handleInsertDiscovery = (e: Event) => {
      if (!editor) return;
      const { discoveryId, title, claim, summary, confidence, sources, category } = (e as CustomEvent).detail;
      const sourceCount = Array.isArray(sources) ? sources.length : 0;
      const idAttr = discoveryId ? ` data-discovery-id="${discoveryId}"` : '';
      // Insert as raw HTML so the blockquote carries the data-discovery-id attribute for traceability
      const html = `<blockquote${idAttr}>`
        + `<h4>Discovery: ${title}</h4>`
        + `<p>${claim}</p>`
        + `<p>${summary}</p>`
        + `<p><em>Confidence: ${Math.round((confidence ?? 0.7) * 100)}% | Category: ${category || 'finding'} | Sources: ${sourceCount}</em></p>`
        + `</blockquote>`;
      editor.chain().focus().insertContent(html).run();
    };

    window.addEventListener('notes-ai-research', handleAiResearch);
    window.addEventListener('notes-ai-citation', handleAiCitation);
    window.addEventListener('notes-ai-transform', handleAiTransform);
    window.addEventListener('notes-ai-verify', handleAiVerify);
    window.addEventListener('notes-ai-review', handleAiReview);
    window.addEventListener('notes-ai-hypothesis', handleAiHypothesis);
    window.addEventListener('notes-ai-what-if', handleAiWhatIf);
    window.addEventListener('notes-ai-outline', handleAiOutline);
    window.addEventListener('notes-insert-discovery', handleInsertDiscovery);

    return () => {
      window.removeEventListener('open-citation-picker', handleOpenCitationPicker);
      window.removeEventListener('notes-ai-research', handleAiResearch);
      window.removeEventListener('notes-ai-citation', handleAiCitation);
      window.removeEventListener('notes-ai-transform', handleAiTransform);
      window.removeEventListener('notes-ai-verify', handleAiVerify);
      window.removeEventListener('notes-ai-review', handleAiReview);
      window.removeEventListener('notes-ai-hypothesis', handleAiHypothesis);
      window.removeEventListener('notes-ai-what-if', handleAiWhatIf);
      window.removeEventListener('notes-ai-outline', handleAiOutline);
      window.removeEventListener('notes-insert-discovery', handleInsertDiscovery);
    };
  }, [editor]);

  // Citation mark interactions — left-click opens viewer, right-click shows context menu
  const [citationMenu, setCitationMenu] = useState<{
    x: number; y: number; citationId: string; documentId: string; meta: Record<string, unknown>;
  } | null>(null);

  useEffect(() => {
    if (!editor || !editorContainerRef.current) return;
    const container = editorContainerRef.current;

    const handleCitationClick = (e: MouseEvent) => {
      const cite = (e.target as HTMLElement).closest('cite.citation-mark');
      if (!cite) return;
      const documentId = cite.getAttribute('data-document-id');
      const metaStr = cite.getAttribute('data-citation-metadata');
      if (!documentId) return;

      // Imported BibTeX citations have synthetic IDs (no backing document in DB)
      if (documentId.startsWith('bib-')) {
        console.log('[CitationClick] Imported citation — no document to open');
        return;
      }

      try {
        const meta = metaStr ? JSON.parse(metaStr) : {};
        window.dispatchEvent(new CustomEvent('open-document-viewer', {
          detail: { documentId, filename: meta.filename, collectionId: meta.collection_id, title: meta.title },
        }));
      } catch {
        window.dispatchEvent(new CustomEvent('open-document-viewer', { detail: { documentId } }));
      }
    };

    const handleCitationContextMenu = (e: MouseEvent) => {
      const cite = (e.target as HTMLElement).closest('cite.citation-mark');
      if (!cite) return;
      e.preventDefault();
      const citationId = cite.getAttribute('data-citation-id') || '';
      const documentId = cite.getAttribute('data-document-id') || '';
      const metaStr = cite.getAttribute('data-citation-metadata');
      let meta = {};
      try { meta = metaStr ? JSON.parse(metaStr) : {}; } catch { /* ignore */ }
      setCitationMenu({ x: e.clientX, y: e.clientY, citationId, documentId, meta });
    };

    container.addEventListener('click', handleCitationClick);
    container.addEventListener('contextmenu', handleCitationContextMenu);
    return () => {
      container.removeEventListener('click', handleCitationClick);
      container.removeEventListener('contextmenu', handleCitationContextMenu);
    };
  }, [editor]);

  // Handle drag-and-drop of citation cards from chat into notes editor
  useEffect(() => {
    if (!editor || !editorContainerRef.current) return;
    const container = editorContainerRef.current;
    const handleDragOver = (e: DragEvent) => {
      if (e.dataTransfer?.types.includes('application/scrapalot-citation')) {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
      }
    };
    const handleDrop = (e: DragEvent) => {
      const json = e.dataTransfer?.getData('application/scrapalot-citation');
      if (!json) return;
      e.preventDefault();
      try {
        const detail = JSON.parse(json);
        window.dispatchEvent(new CustomEvent('insert-citation-into-note', { detail }));
      } catch { /* ignore invalid data */ }
    };
    container.addEventListener('dragover', handleDragOver);
    container.addEventListener('drop', handleDrop);
    return () => {
      container.removeEventListener('dragover', handleDragOver);
      container.removeEventListener('drop', handleDrop);
    };
  }, [editor]);

  // Listen for "Insert into Note" from Chat citation cards
  useEffect(() => {
    const handleInsertCitation = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (!detail || !editor) return;
      const { text, title, page, authors, year } = detail;

      // Build short citation label
      const authorShort = Array.isArray(authors) && authors.length > 0
        ? (authors.length > 2 ? `${authors[0].split(',')[0]} et al.` : authors.map((a: string) => a.split(',')[0]).join(' & '))
        : title?.split(' ').slice(0, 3).join(' ') || 'Source';
      const citationShort = year ? `[${authorShort}, ${year}]` : `[${authorShort}]`;
      const pageRef = page ? `, p. ${page}` : '';

      // Insert blockquote with citation reference at end of document
      editor.chain().focus('end').insertContent([
        { type: 'blockquote', content: [
          { type: 'paragraph', content: [
            { type: 'text', text: text ? `"${text.substring(0, 300)}${text.length > 300 ? '...' : ''}"` : `[Citation from ${title}]` },
          ]},
        ]},
        { type: 'paragraph', content: [
          { type: 'text', text: `— ${citationShort}${pageRef}` },
        ]},
      ]).run();
    };
    window.addEventListener('insert-citation-into-note', handleInsertCitation);
    return () => window.removeEventListener('insert-citation-into-note', handleInsertCitation);
  }, [editor]);

  // FIX: Cleanup debounce timer on unmount to prevent memory leaks
  useEffect(() => {
    return () => {
      if (onChangeTimerRef.current) {
        clearTimeout(onChangeTimerRef.current);
      }
    };
  }, []);

  // Table grip overlay (Confluence-style row/column controls)
  const tableGrip = useTableGripOverlay(editor, editable, editorContainerRef);

  // Handle new comment from SelectionToolbar
  const handleNewComment = useCallback((selection: { from: number; to: number; text: string }) => {
    console.log('[CollaborativeNotesEditor] New comment requested:', selection);

    // Set selected text for sidebar
    setSelectedTextForComment(selection);

    // Calculate balloon position based on selection (fixed positioning - viewport coordinates)
    if (editor) {
      const { view } = editor;
      const { from } = selection;

      // Get DOM coordinates of the selection start (absolute viewport coordinates)
      const coords = view.coordsAtPos(from);

      // Position balloon to the right of the selection text
      // Note: SimpleCommentInput uses position: fixed, so we need viewport coordinates
      const top = coords.top; // Already viewport-relative
      const right = 40; // 40px from the right edge of viewport

      console.log('[CollaborativeNotesEditor] Balloon position:', { top, right, coords });

      setBalloonPosition({ top, right });

      // Create a temporary comment object for the balloon
      setActiveBalloonComment({
        id: 'new',
        note_id: noteId,
        content: '',
        created_by: userId,
        created_by_name: userName,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        is_resolved: false,
        position: selection,
        replies: [],
      });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- deps are intentionally limited
  }, [noteId, userId, userName]);

  const handleBalloonClose = useCallback(() => {
    setActiveBalloonComment(null);
    setSelectedTextForComment(null);
  }, []);

  // Simplified handler for new comment input
  const handleNewCommentSubmit = useCallback(async (content: string) => {
    if (!content.trim()) {
      toast.error(t('notes.comments.enterComment'));
      return;
    }

    try {
      await authState.waitForAuthReady();

      // Create comment request
      const request: CreateCommentRequest = {
        content,
        position: selectedTextForComment ? {
          from: selectedTextForComment.from,
          to: selectedTextForComment.to,
          text: selectedTextForComment.text,
        } : undefined,
      };

      console.log('[CollaborativeNotesEditor] Creating comment:', request);

      // Call API to create comment
      const newComment = await createComment(noteId, request);

      console.log('[CollaborativeNotesEditor] Comment created:', newComment);

      // Apply comment mark to the selected text
      if (selectedTextForComment && editor) {
        const { from, to } = selectedTextForComment;

        console.log('[CollaborativeNotesEditor] Applying comment mark:', {
          commentId: newComment.id,
          from,
          to,
        });

        // Apply the comment mark
        const result = editor.chain()
          .focus()
          .setTextSelection({ from, to })
          .setCommentMark(newComment.id)
          .run();

        console.log('[CollaborativeNotesEditor] Comment mark applied, result:', result);

        // Verify the mark was applied
        const state = editor.state;
        const marks = state.doc.textBetween(from, to, ' ');
        console.log('[CollaborativeNotesEditor] Text with mark:', marks);

        // Check if mark exists in DOM
        setTimeout(() => {
          const markElement = document.querySelector(`mark[data-comment-id="${newComment.id}"]`);
          console.log('[CollaborativeNotesEditor] Mark element in DOM:', markElement);
          if (markElement) {
            console.log('[CollaborativeNotesEditor] Mark classes:', markElement.className);
            console.log('[CollaborativeNotesEditor] Mark attributes:', {
              commentId: markElement.getAttribute('data-comment-id'),
              resolved: markElement.getAttribute('data-resolved'),
            });
          }
        }, 100);
      }

      toast.success(t('notes.comments.addedSuccess'));

      // Close input and clear selection
      setActiveBalloonComment(null);
      setSelectedTextForComment(null);

    } catch (error) {
      console.error('[CollaborativeNotesEditor] Failed to create comment:', error);
      toast.error(t('notes.comments.addFailedRetry'));
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- deps are intentionally limited
  }, [noteId, selectedTextForComment]);

  // Hover balloon handlers
  const handleHoverBalloonReply = useCallback(async (commentId: string, content: string) => {
    if (!content.trim()) {
      toast.error(t('notes.comments.enterComment'));
      return;
    }

    try {
      await authState.waitForAuthReady();

      // Create reply
      const request: CreateCommentRequest = {
        content,
        parent_comment_id: commentId,
      };

      console.log('[CollaborativeNotesEditor] Creating reply:', request);

      await createComment(noteId, request);

      toast.success(t('notes.comments.replyAddedSuccess'));

      // Refresh comment data
      setHoveredCommentId(null);
      setTimeout(() => setHoveredCommentId(commentId), 100);

    } catch (error) {
      console.error('[CollaborativeNotesEditor] Failed to create reply:', error);
      toast.error(t('notes.comments.replyFailedRetry'));
    }
  }, [noteId, t]);

  const handleHoverBalloonResolve = useCallback(async (commentId: string) => {
    try {
      await authState.waitForAuthReady();

      console.log('[CollaborativeNotesEditor] Toggling resolve for comment:', commentId);

      const result = await toggleResolveComment(noteId, commentId);

      toast.success(result.message);

      // Update the mark to show resolved state
      if (editor) {
        const { state } = editor;
        const { tr } = state;
        let updated = false;

        state.doc.descendants((node, pos) => {
          if (node.isText) {
            node.marks.forEach(mark => {
              if (mark.type.name === 'commentMark' && mark.attrs.commentId === commentId) {
                // Update the resolved attribute
                tr.removeMark(pos, pos + node.nodeSize, mark.type);
                tr.addMark(
                  pos,
                  pos + node.nodeSize,
                  mark.type.create({
                    ...mark.attrs,
                    resolved: result.is_resolved,
                  })
                );
                updated = true;
              }
            });
          }
        });

        if (updated) {
          editor.view.dispatch(tr);
        }
      }

      // Close hover balloon
      setHoveredCommentId(null);
      setHoverBalloonComment(null);

    } catch (error) {
      console.error('[CollaborativeNotesEditor] Failed to resolve comment:', error);
      toast.error(t('notes.comments.resolveFailedRetry'));
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- deps are intentionally limited
  }, [noteId]);

  const handleHoverBalloonDelete = useCallback(async (commentId: string): Promise<void> => {
    // Show delete confirmation dialog
    setCommentToDelete(commentId);
    setDeleteDialogOpen(true);
  }, []);

  // Confirmed delete operation
  const handleConfirmDelete = useCallback(async () => {
    if (!commentToDelete) return;

    try {
      await authState.waitForAuthReady();

      console.log('[CollaborativeNotesEditor] Deleting comment:', commentToDelete);

      await deleteComment(noteId, commentToDelete);

      toast.success(t('notes.comments.deletedSuccess'));

      // Remove the comment mark from the editor
      if (editor) {
        editor.commands.removeCommentMark(commentToDelete);
      }

      // Close all balloons
      setActiveBalloonComment(null);
      setHoveredCommentId(null);
      setHoverBalloonComment(null);
      setIsBalloonPinned(false);

      // Close dialog
      setDeleteDialogOpen(false);
      setCommentToDelete(null);

    } catch (error) {
      console.error('[CollaborativeNotesEditor] Failed to delete comment:', error);
      toast.error(t('notes.comments.deleteFailedRetry'));
    }
  }, [noteId, commentToDelete, editor, t]);

  const handleHoverBalloonClose = useCallback(() => {
    setHoveredCommentId(null);
    setHoverBalloonComment(null);
    setIsBalloonPinned(false); // Unpin when closing
  }, []);

  // Click handler for comment highlights - pin the balloon open
  useEffect(() => {
    if (!editor) return;

    const handleClick = (event: MouseEvent) => {
      const target = event.target as HTMLElement;

      // Check if clicking on a comment highlight
      const commentMark = target.closest('mark.comment-highlight');

      if (commentMark) {
        const commentId = commentMark.getAttribute('data-comment-id');

        console.log('[Click] Clicked comment mark:', { commentId, target });

        if (commentId) {
          setHoveredCommentId(commentId);
          setIsBalloonPinned(true); // Pin the balloon open

          // Calculate position for balloon
          const rect = commentMark.getBoundingClientRect();

          const position = {
            top: rect.bottom + 5,
            left: rect.left,
          };

          console.log('[Click] Balloon position:', position);
          setHoverBalloonPosition(position);
        }
      }
    };

    const editorElement = editor.view.dom;
    editorElement.addEventListener('click', handleClick);

    return () => {
      editorElement.removeEventListener('click', handleClick);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps -- deps are intentionally limited
  }, []);

  // Hover detection for comment highlights (only if not pinned)
  useEffect(() => {
    if (!editor) return;

    const handleMouseMove = (event: MouseEvent) => {
      // Don't change hover state if balloon is pinned
      if (isBalloonPinned) return;

      const target = event.target as HTMLElement;

      // Check if hovering over a comment highlight
      const commentMark = target.closest('mark[data-comment-id]');

      if (commentMark) {
        const commentId = commentMark.getAttribute('data-comment-id');

        console.log('[Hover] Found comment mark:', { commentId, target });

        if (commentId && commentId !== hoveredCommentId) {
          console.log('[Hover] Setting hoveredCommentId:', commentId);
          setHoveredCommentId(commentId);

          // Calculate position for hover balloon
          const rect = commentMark.getBoundingClientRect();

          const position = {
            top: rect.bottom + 5,
            left: rect.left,
          };

          console.log('[Hover] Balloon position:', position);
          setHoverBalloonPosition(position);
        }
      } else {
        // Not hovering over a comment mark
        if (hoveredCommentId && !isBalloonPinned) {
          console.log('[Hover] Clearing hoveredCommentId');
          setHoveredCommentId(null);
          setHoverBalloonComment(null);
        }
      }
    };

    const editorElement = editor.view.dom;
    editorElement.addEventListener('mousemove', handleMouseMove);

    return () => {
      editorElement.removeEventListener('mousemove', handleMouseMove);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps -- deps are intentionally limited
  }, [hoveredCommentId, isBalloonPinned]); // editor is stable once created, safe to omit

  // Fetch comment data when hoveredCommentId changes
  useEffect(() => {
    if (!hoveredCommentId) {
      setHoverBalloonComment(null);
      return;
    }

    // Skip fetching comments for non-UUID noteIds (e.g., "default")
    if (!isValidUUID(noteId)) {
      console.log('[Fetch] Skipping comment fetch for non-UUID noteId:', noteId);
      return;
    }

    console.log('[Fetch] Fetching comment data for ID:', hoveredCommentId);

    const fetchComment = async () => {
      try {
        await authState.waitForAuthReady();

        // Fetch all comments for this note
        const comments = await listComments(noteId);

        console.log('[Fetch] Got comments:', comments);

        // Find the comment by ID (could be top-level or a reply)
        let foundComment: NoteComment | null = null;
        for (const comment of comments) {
          if (comment.id === hoveredCommentId) {
            foundComment = comment;
            break;
          }
          // Check replies
          if (comment.replies) {
            const reply = comment.replies.find(r => r.id === hoveredCommentId);
            if (reply) {
              // If hovering a reply, show the parent comment with all replies
              foundComment = comment;
              break;
            }
          }
        }

        console.log('[Fetch] Found comment:', foundComment);

        if (foundComment) {
          setHoverBalloonComment(foundComment);
        } else {
          console.warn('[Fetch] Comment not found for ID:', hoveredCommentId);
        }
      } catch (error) {
        console.error('[CollaborativeNotesEditor] Failed to fetch comment:', error);
      }
    };

    void fetchComment();
  }, [hoveredCommentId, noteId]);

  // Load initial content into editor when noteId or content changes
  // IMPORTANT: Only reload if content actually changed to prevent losing unsaved edits
  useEffect(() => {
    if (!editor || editor.isDestroyed) {
      console.log('[CollaborativeNotesEditor] Editor not ready yet, will retry...');
      return;
    }

    // Track all requestAnimationFrame IDs for cleanup
    const rafIds: number[] = [];

    const isInitialLoad = !contentLoadedRef.current;
    const contentPropChanged = content !== lastLoadedContentRef.current;

    // DUPLICATION FIX: if this note will have a WebSocket (valid UUID) and
    // the provider hasn't completed its first Y.js sync yet, DO NOT call
    // setContent. The server persists the ydoc state, and running
    // setContent before sync seeds a fresh client copy that then gets
    // merged with the server's copy → every open doubled the content.
    //
    // Once the 'sync' event fires, wsSyncedOnce flips, this effect re-runs,
    // and the logic below either trusts what sync populated the editor with
    // or falls back to setContent() when the ydoc was genuinely empty.
    if (isInitialLoad && isValidUUID(noteId) && !wsSyncedOnce) {
      console.log('[CollaborativeNotesEditor] Deferring setContent until WS sync completes');
      return;
    }

    // Don't reload if content prop hasn't changed (avoid redundant reloads)
    if (!isInitialLoad && !contentPropChanged) {
      console.log('[CollaborativeNotesEditor] Content unchanged, skipping reload', {
        isInitialLoad,
        contentPropChanged,
        initialContentLoadedRef: initialContentLoadedRef.current
      });

      // FIX: If this is not initial load and content hasn't changed,
      // but initialContentLoaded is still false, we need to set it to true
      // to allow WebSocket initialization
      if (!initialContentLoadedRef.current) {
        console.log('[CollaborativeNotesEditor] Setting initialContentLoaded=true (content unchanged path)');
        initialContentLoadedRef.current = true;
        const rafId = requestAnimationFrame(() => {
          noteChangeInProgressRef.current = false;
          setInitialContentLoaded(true);
        });
        rafIds.push(rafId);
      }
      return;
    }

    // Get current editor content
    const currentEditorContent = editor.getHTML();

    // Check if user has made local edits
    // Only block reload if:
    // 1. Editor content differs from what we last loaded
    // 2. AND editor content differs from incoming content prop
    // 3. AND we've loaded content before (not initial load)
    const editorDiffersFromLastLoaded = currentEditorContent !== lastLoadedContentRef.current;
    const editorDiffersFromIncoming = currentEditorContent !== (content || '');
    const hasLocalEdits = editorDiffersFromLastLoaded &&
                          editorDiffersFromIncoming &&
                          contentLoadedRef.current;

    if (hasLocalEdits) {
      console.log('[CollaborativeNotesEditor] Skipping content reload - user has local edits', {
        currentLength: currentEditorContent.length,
        incomingLength: (content || '').length,
        lastLoadedLength: lastLoadedContentRef.current.length,
      });
      // FIX: Even when skipping due to local edits, we need to clear the flag and trigger WebSocket
      // This ensures collaboration still works even when preserving local edits
      initialContentLoadedRef.current = true;
      const rafId = requestAnimationFrame(() => {
        noteChangeInProgressRef.current = false;
        setInitialContentLoaded(true);
      });
      rafIds.push(rafId);
      return;
    }

    // Determine what content we would load
    const contentToCheck = content && content.trim() && content !== '<p></p>'
      ? content
      : '<h1></h1><p></p>';

    // Skip if editor already has this content (avoid unnecessary setContent calls)
    if (currentEditorContent === contentToCheck) {
      console.log('[CollaborativeNotesEditor] Skipping setContent - editor already has this content');
      lastLoadedContentRef.current = content || '';
      contentLoadedRef.current = true;
      initialContentLoadedRef.current = true;
      // FIX: Even when skipping setContent, we need to clear the flag and trigger WebSocket
      // Use requestAnimationFrame to match the timing of the normal path
      const rafId = requestAnimationFrame(() => {
        noteChangeInProgressRef.current = false;
        setInitialContentLoaded(true);
      });
      rafIds.push(rafId);
      return;
    }

    // DUPLICATION FIX: post-sync guard. If the WS sync populated the ydoc
    // with *any* real content, trust it and skip setContent — writing HTML
    // on top of a non-empty ydoc is precisely what doubled the note.
    // Only the explicit empty-template placeholder ('<h1></h1><p></p>')
    // counts as empty for this purpose.
    if (isInitialLoad && isValidUUID(noteId) && wsSyncedOnce) {
      const editorIsEmpty = editor.isEmpty
        || currentEditorContent === ''
        || currentEditorContent === '<p></p>'
        || currentEditorContent === '<h1></h1><p></p>';
      if (!editorIsEmpty) {
        console.log('[CollaborativeNotesEditor] WS sync delivered content, skipping setContent');
        lastLoadedContentRef.current = currentEditorContent;
        contentLoadedRef.current = true;
        initialContentLoadedRef.current = true;
        const rafId = requestAnimationFrame(() => {
          noteChangeInProgressRef.current = false;
          setInitialContentLoaded(true);
        });
        rafIds.push(rafId);
        return;
      }
    }

    // Load content - use H1 template for new/empty notes
    const contentToLoad = content && content.trim() && content !== '<p></p>'
      ? content
      : '<h1></h1><p></p>';

    // Update refs immediately to track the current state
    lastLoadedContentRef.current = content || '';
    contentLoadedRef.current = true;
    initialContentLoadedRef.current = true;

    // FIX: Use requestAnimationFrame for better DOM synchronization
    // This ensures the DOM is in a stable state before we modify it
    // Also wrap in try-catch to prevent crash on race conditions
    const rafId = requestAnimationFrame(() => {
      if (!editor.isDestroyed) {
        try {
          editor.commands.setContent(contentToLoad, false);
          console.log('[CollaborativeNotesEditor] Content loaded for noteId:', noteId, 'length:', contentToLoad.length);

          // Scroll to heading anchor if URL has a hash fragment
          setTimeout(() => {
            scrollToHeadingAnchor(editor.view.dom);
          }, 300);
        } catch (error) {
          // FIX: Gracefully handle DOM errors during note switching
          // This can happen if the editor DOM is being cleaned up during the switch
          console.warn('[CollaborativeNotesEditor] Error setting content (likely note switch in progress):', error);
        }
      }

      // FIX: Clear the note change flag and trigger WebSocket AFTER content is set
      // This ensures WebSocket can only connect after DOM is stable
      noteChangeInProgressRef.current = false;
      setInitialContentLoaded(true); // Trigger WebSocket connection now that content is safely loaded
    });
    rafIds.push(rafId);

    // Cleanup: Cancel all pending requestAnimationFrame callbacks
    return () => {
      rafIds.forEach((id) => cancelAnimationFrame(id));
    };
  }, [editor, noteId, content, wsSyncedOnce]);

  // Load existing comments and apply highlights when editor is ready
  useEffect(() => {
    if (!editor || editor.isDestroyed || !noteId) return;

    // Skip loading comments for non-UUID noteIds (e.g., "default")
    if (!isValidUUID(noteId)) {
      return;
    }

    // Skip loading comments if the note is empty (no text content to highlight)
    if (editor.isEmpty) {
      return;
    }

    const loadCommentsAndApplyHighlights = async () => {
      try {
        await authState.waitForAuthReady();

        console.log('[CollaborativeNotesEditor] Loading comments for note:', noteId);

        // Fetch all comments for this note
        const comments = await listComments(noteId);

        console.log('[CollaborativeNotesEditor] Found comments:', comments.length);

        // Apply comment marks to the editor for each top-level comment
        comments.forEach(comment => {
          if (comment.position && comment.position.from !== undefined && comment.position.to !== undefined) {
            const { from, to } = comment.position;

            console.log('[CollaborativeNotesEditor] Applying comment mark:', {
              commentId: comment.id,
              from,
              to,
              isResolved: comment.is_resolved,
            });

            // Apply the comment mark with resolved state
            editor.chain()
              .setTextSelection({ from, to })
              .setMark('commentMark', {
                commentId: comment.id,
                resolved: comment.is_resolved,
              })
              .run();
          }
        });

        console.log('[CollaborativeNotesEditor] All comment highlights applied');

      } catch (error: unknown) {
        // Silently ignore 404 errors (expected for new notes with no comments yet)
        const axiosErr = error as { response?: { status?: number } };
        if (axiosErr?.response?.status === 404) {
          console.log('[CollaborativeNotesEditor] No comments found for this note (new note or no comments yet)');
        } else {
          console.error('[CollaborativeNotesEditor] Failed to load comments:', error);
        }
      }
    };

    // Delay to ensure content is loaded first
    const timer = setTimeout(() => {
      void loadCommentsAndApplyHighlights();
    }, 500);

    return () => clearTimeout(timer);
  }, [editor, noteId]);

  // Click handler for comment highlights - show balloon on click
  useEffect(() => {
    if (!editor) return;

    const handleClick = (event: MouseEvent) => {
      const target = event.target as HTMLElement;

      // Check if clicking on a comment highlight
      const commentMark = target.closest('mark[data-comment-id]');

      if (commentMark) {
        const commentId = commentMark.getAttribute('data-comment-id');

        console.log('[Click] Clicked comment mark:', { commentId, target });

        if (commentId) {
          // Pin the balloon when clicked
          setHoveredCommentId(commentId);
          setIsBalloonPinned(true);

          // Calculate position for balloon
          const rect = commentMark.getBoundingClientRect();
          const position = {
            top: rect.bottom + 5,
            left: rect.left,
          };

          console.log('[Click] Showing balloon at:', position);
          setHoverBalloonPosition(position);
        }
      }
    };

    const editorElement = editor.view.dom;
    editorElement.addEventListener('click', handleClick);

    return () => {
      editorElement.removeEventListener('click', handleClick);
    };
  }, [editor]);

  // Confluence-style block gutter — the DragHandlePlugin emits a
  // [ + ⋮⋮ ] decoration on every top-level block; this listener wires
  // the two buttons up to BlockMenu / block insertion. Lives on the
  // ProseMirror container so we don't re-register listeners every time
  // the editor re-renders.
  useEffect(() => {
    if (!editor) return;
    const editorElement = editor.view.dom;

    const findBlockTopFromTarget = (target: HTMLElement): { rect: DOMRect } | null => {
      // The decoration widget is placed as the *first* child of the
      // top-level block; walk up from the clicked button to that
      // wrapper, then read the parent block's rect.
      const wrapper = target.closest('.drag-handle-trigger');
      const blockEl = wrapper?.parentElement;
      if (!blockEl) return null;
      return { rect: blockEl.getBoundingClientRect() };
    };

    const handleBlockGutterClick = (event: MouseEvent) => {
      const target = event.target as HTMLElement;
      const dragBtn = target.closest('[data-drag-handle]');
      const plusBtn = target.closest('[data-block-plus]');
      if (!dragBtn && !plusBtn) return;

      event.preventDefault();
      event.stopPropagation();

      const blockInfo = findBlockTopFromTarget(target);
      if (!blockInfo) return;

      // The BlockMenu sits inside `.notes-container` which is
      // `position: relative`, so `position: absolute` children resolve
      // against THAT box — not the viewport. We must convert the
      // viewport-relative `getBoundingClientRect()` reading into
      // container-relative coords (subtract container origin, add
      // scroll offset). Skipping this puts the menu at the drawer's
      // top-right corner instead of next to the handle that was
      // clicked — the visual bug observed in production.
      const cRect = notesScrollEl?.getBoundingClientRect();
      const cx = cRect?.left ?? 0;
      const cy = cRect?.top ?? 0;
      const sx = notesScrollEl?.scrollLeft ?? 0;
      const sy = notesScrollEl?.scrollTop ?? 0;
      const toLocal = (vx: number, vy: number) => ({
        x: vx - cx + sx,
        y: vy - cy + sy,
      });

      // CRITICAL: move the ProseMirror selection to the row the user
      // visually clicked BEFORE opening the menu. BlockMenu actions all
      // run through `editor.chain().focus().setHeading()/setParagraph()
      // /toggleBulletList()/...`, which target whichever block the
      // selection currently lives in. Without this step the menu opens
      // next to row A while the actions operate on row B (wherever the
      // cursor last was).
      //
      // Note we use `posAtCoords` (visual hit-test), NOT
      // `posAtDOM(block, 0)`. The drag-handle plugin emits ONE handle
      // per top-level block, so for a bulletList the handle visually
      // sits next to whichever <li> happens to be the first DOM child
      // when rendered. If we resolved to the UL's start, setHeading
      // would target the entire list — not the row the user pointed at.
      // posAtCoords with the handle's vertical centre + a small inward
      // X offset lands inside the specific <li> the handle is rendered
      // beside, so transforms apply to that row only.
      const dragBtnRect = dragBtn
        ? (dragBtn as HTMLElement).getBoundingClientRect()
        : null;
      const clickedBlockEl =
        (target.closest('.drag-handle-trigger')?.parentElement) as HTMLElement | null;
      let resolvedTargetPos: number | null = null;
      if (dragBtnRect && clickedBlockEl) {
        try {
          // For list containers (UL / OL), the drag-handle plugin
          // emits a SINGLE handle per top-level block — visually it
          // floats next to whichever <li> happens to render first.
          // posAtCoords on the UL's left edge tends to resolve to a
          // position INSIDE UL but BETWEEN list items (i.e. not inside
          // any <li> paragraph), which makes setHeading a no-op (no
          // textblock to convert).
          //
          // Walk the DOM children directly: pick the <li> whose
          // bounding box vertically contains the handle's centre,
          // then resolve PM position INSIDE that <li>. This lands the
          // selection inside the list item's paragraph, so setHeading
          // splits the list and converts only that row.
          const handleCY = dragBtnRect.top + dragBtnRect.height / 2;
          let targetEl: HTMLElement = clickedBlockEl;
          const tagU = clickedBlockEl.tagName;
          if (tagU === 'UL' || tagU === 'OL') {
            const matchingLi = Array.from(clickedBlockEl.children).find(
              (child) => {
                if ((child as HTMLElement).tagName !== 'LI') return false;
                const r = (child as HTMLElement).getBoundingClientRect();
                return handleCY >= r.top && handleCY <= r.bottom;
              },
            ) as HTMLElement | undefined;
            if (matchingLi) {
              // Resolve to the inner paragraph if present — setHeading
              // requires a textblock target. <li> wraps a paragraph in
              // the default TipTap schema.
              const innerP = matchingLi.querySelector('p');
              targetEl = (innerP ?? matchingLi) as HTMLElement;
            }
          }
          const blockPos = editor.view.posAtDOM(targetEl, 0);
          if (blockPos >= 0) {
            // +1 lands inside the resolved textblock's content rather
            // than at its opening boundary, which is what setHeading /
            // setParagraph treat as "the current block".
            resolvedTargetPos = Math.min(
              blockPos + 1,
              editor.state.doc.content.size,
            );
            // Best-effort: also move the in-editor selection so the
            // user's next keypress lands on the right row. The menu
            // actions themselves don't depend on this — they read
            // `menuState.targetPos` and re-apply the selection inside
            // the same transaction (Radix popover's focus grab tends
            // to clobber a plain setTextSelection between gutter click
            // and action click).
            editor.commands.setTextSelection(resolvedTargetPos);
          }
        } catch (err) {
          // posAtDOM returns -1 / throws off-content; we just leave
          // the selection where it was and let the menu still open
          // (action will fall back to current selection).
          console.warn('[block-gutter] failed to resolve PM target pos', err);
        }
      }

      if (plusBtn) {
        // Insert an empty paragraph BELOW the current block and open
        // the block menu next to it so the user can pick a node type.
        // We approximate "below" by finding the end of the block via
        // ProseMirror's view.posAtCoords using the block's right-mid
        // point, then inserting a paragraph after that position.
        const blockEl = (target.closest('.drag-handle-trigger')?.parentElement) as HTMLElement | null;
        if (!blockEl) return;
        const pos = editor.view.posAtDOM(blockEl, blockEl.childNodes.length);
        if (pos < 0) return;
        const resolved = editor.state.doc.resolve(pos);
        const after = resolved.after();
        editor
          .chain()
          .focus()
          .insertContentAt(after, { type: 'paragraph' })
          .setTextSelection(after + 1)
          .run();
        // Pop the block menu at the new paragraph's position.
        const newRect = blockInfo.rect;
        setMenuState({
          isOpen: true,
          position: toLocal(newRect.left, newRect.bottom + 4),
          blockIndex: null,
          targetPos: after + 1,
        });
        return;
      }

      // ⋮⋮ — open the block menu adjacent to the handle so the user
      // can pick "turn into", "duplicate", "delete", etc.
      const rect = (dragBtn as HTMLElement).getBoundingClientRect();
      setMenuState({
        isOpen: true,
        position: toLocal(rect.right + 4, rect.top),
        blockIndex: null,
        targetPos: resolvedTargetPos,
      });
    };

    editorElement.addEventListener('click', handleBlockGutterClick);
    return () => {
      editorElement.removeEventListener('click', handleBlockGutterClick);
    };
  }, [editor, notesScrollEl]);

  // Debug logging removed to stop console spam

  // Close menu when clicking outside
  useEffect(() => {
    if (!menuState.isOpen) return;

    const handleClickOutside = (e: MouseEvent) => {
      if (menuContainerRef.current && !menuContainerRef.current.contains(e.target as Node)) {
        setMenuState({ isOpen: false, position: { x: 0, y: 0 }, blockIndex: null, targetPos: null });
      }
    };

    // Use mousedown to catch clicks before they propagate
    document.addEventListener('mousedown', handleClickOutside);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [menuState.isOpen]);

  // Forward mouse move to table grip overlay (row/column handles)
  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    tableGrip.handleTableMouseMove(e);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- deps are intentionally limited
  }, []);

  // Update editor editable state without recreating editor
  useEffect(() => {
    if (editor && editor.isEditable !== editable) {
      editor.setEditable(editable);
    }
  }, [editor, editable]);

  // Set collaboration awareness when provider becomes available
  useEffect(() => {
    if (!provider || !isProviderValidRef.current) return;
    provider.awareness.setLocalStateField('user', {
      id: userId,
      name: userName,
      color: userColor,
    });
  }, [provider, userId, userName, userColor]);

  // Note: Content updates are handled by Yjs collaboration
  // Do NOT sync content prop back to editor as it causes infinite loops

  // Don't render until editor is ready, not destroyed, and component is mounted
  if (!editor || editor.isDestroyed || !isMounted) {
    return null;
  }

  // Convert workspace members and live collaborators to format expected by header
  const liveCollaborators = Array.from(collaboratorStates.values()).map(state => ({
    id: state.id,
    name: state.name,
    color: state.color,
    isActive: state.isActive,
    lastSeen: state.lastSeen,
  }));

  // Debug logging for workspace members
  // console.log('CollaborativeNotesEditor workspaceMembers debug:', {
  //   workspaceMembers: workspaceMembers,
  //   workspaceMembersLength: workspaceMembers?.length || 0,
  //   liveCollaborators: liveCollaborators,
  //   liveCollaboratorsLength: liveCollaborators?.length || 0,
  // });

  // Combine workspace members with live collaborators
  const allWorkspaceUsers = workspaceMembers.map(member => ({
    id: member.id,
    name: member.username,
    email: member.email,
    avatar: member.avatar_url,
    role: member.role,
    color: getConsistentColor(member.id), // Assign consistent color based on user ID
    isActive: liveCollaborators.some(collab => collab.id === member.id),
    lastSeen: liveCollaborators.find(collab => collab.id === member.id)?.lastSeen || new Date().toISOString(),
  }));

  // Default creator info if not provided
  const defaultCreator = createdBy || {
    id: userId,
    name: userName,
    email: `${userName.toLowerCase().replace(' ', '.')}@example.com`,
  };

  // Add any live collaborators who aren't in the workspace members list (edge case)
  // IMPORTANT: Filter out the creator from collaborators list to prevent duplicate display
  const collaboratorsBeforeFilter = [
    ...allWorkspaceUsers,
    ...liveCollaborators.filter(collab =>
      !allWorkspaceUsers.some(member => member.id === collab.id)
    )
  ];

  // Filter out creator using STRICT comparison
  const collaboratorsList = collaboratorsBeforeFilter.filter(user => {
    const userId = String(user.id).trim().toLowerCase();
    const creatorId = String(defaultCreator.id).trim().toLowerCase();
    return userId !== creatorId;
  });

  // Debug logging (can be removed later)
  // console.log('CollaborativeNotesEditor render debug:', {
  //   showCollaborationHeader,
  //   collaboratorsList: collaboratorsList.length,
  //   connectionStatus
  // });

  // Note: We no longer block rendering while waiting for cleanup.
  // The EditorContentErrorBoundary handles any insertBefore errors that occur
  // during rapid open/close cycles. This prevents the editor from getting stuck.

  return (
    <div className="flex flex-col h-full max-h-full bg-white dark:bg-[#191919]" data-testid="notes-editor">
      {/* Collaboration Header - Show when enabled (defaults to true) */}
      {showCollaborationHeader && (
        <CollaborationHeader
          documentTitle={documentTitle}
          createdBy={defaultCreator}
          activeUsers={collaboratorsList}
          connectionStatus={connectionStatus}
          typingUsers={typingUsers}
          saveStatus={saveStatus}
          onShare={onShare}
        />
      )}

      {/* Main content area - flex row with editor and comments sidebar */}
      <div className="flex flex-1 min-h-0">
        {/* Editor Content - Notion-style clean layout */}
        <div
          ref={setNotesScrollRef}
          className={cn(
            "notes-container flex-1 min-h-0 overflow-y-auto overflow-x-hidden bg-white dark:bg-[#1a1a1a] pb-4 relative",
            showCommentsSidebar && "border-r"
          )}
          // Migration 116 — page-head metadata exposed via CSS so the
          // ProseMirror H1 can render the emoji via ::before without a
          // custom TipTap node, and so the editor root font scale is
          // settable without touching prose classes.
          //
          // Emoji is passed two ways:
          //   - data-note-emoji attribute  — used by the selector to
          //     decide whether to render the ::before (empty = skip)
          //   - --note-emoji CSS var       — the *value* the ::before
          //     reads via content. We can't use attr(data-note-emoji)
          //     inside h1::before because attr() evaluates against the
          //     element that owns the pseudo-element (the H1 itself),
          //     not an ancestor. CSS vars, on the other hand, do
          //     inherit down to descendants — so we set the var on
          //     the scroll container and the H1 reads it.
          data-note-emoji={pageHead?.value.emoji ?? ''}
          style={{
            ['--notes-font-scale' as string]: String(
              pageHead?.value.fontScale
                ? ({ small: 0.875, default: 1, large: 1.125, xlarge: 1.25 }[pageHead.value.fontScale] ?? 1)
                : 1
            ),
            ['--note-emoji' as string]: pageHead?.value.emoji
              ? `"${pageHead.value.emoji}"`
              : '""',
          }}
        >
        <style>{`
          /* Task list styling */
          ul[data-type="taskList"] {
            list-style: none;
            padding-left: 0;
          }
          /* Task-list shape moved to the consolidated rule block
             further down (see :not([data-type=taskList]) section).
             Keeping only the checkbox sizing here since it's the
             one bit not duplicated below. */
          ul[data-type="taskList"] input[type="checkbox"] {
            cursor: pointer;
            width: 1.2em;
            height: 1.2em;
            margin-top: 0.15em;
            flex-shrink: 0;
          }
          /* Table styling */
          .ProseMirror table {
            border-collapse: collapse;
            table-layout: fixed;
            width: 100%;
            /* margin on the inner <table> doesn't reach the parent
               <div.tableWrapper> that ProseMirror Tables emits, so the
               visible gap was always controlled by the wrapper.
               Reset to 0 here; the .tableWrapper rule below owns the
               outer spacing. */
            margin: 0;
            overflow: hidden;
          }
          /* The actual gap above / below the table block. 1.5rem on
             both sides matches the list / heading group spacing so
             a table doesn't feel welded to whatever comes before
             or after it. */
          .ProseMirror div.tableWrapper {
            margin-top: 1.5rem !important;
            margin-bottom: 1.5rem !important;
          }
          .ProseMirror td,
          .ProseMirror th {
            min-width: 1em;
            border: 1px solid hsl(var(--border));
            padding: 0.5rem;
            vertical-align: top;
            box-sizing: border-box;
            position: relative;
          }
          .ProseMirror th {
            font-weight: bold;
            text-align: left;
            background-color: hsl(var(--muted));
          }
          /* Confluence-style faint grid on the dark theme — the
             default --border token is too dark on hsl(var(--background))
             and the cell separators disappear. Override to a lighter
             gray so the grid stays legible without becoming loud. */
          .dark .ProseMirror td,
          .dark .ProseMirror th {
            border-color: rgba(255, 255, 255, 0.14);
          }
          /* Whole-table selection — the 6-dot grip dispatches a
             CellSelection that covers every cell. TableAlignmentToolbar
             tags the table with the table-fully-selected class while
             it's mounted; we paint a primary outline so the selection
             is unmistakable (default ProseMirror styles only show per-
             cell tints, which are hard to read against a dark theme).
             NOTE: never use backticks inside this style block — the
             outer style tag wraps a JS template literal; backticks here
             close it and any following identifier gets evaluated as a
             JS reference (this is what caused a "fully is not defined"
             ReferenceError on the previous deploy). */
          .ProseMirror table.table-fully-selected {
            outline: 2px solid hsl(var(--primary));
            outline-offset: 2px;
          }
          .ProseMirror .selectedCell:after {
            z-index: 2;
            position: absolute;
            content: "";
            left: 0;
            right: 0;
            top: 0;
            bottom: 0;
            background: hsl(var(--primary) / 0.1);
            pointer-events: none;
          }
          /* Text cursor (caret) and text styling */
          .ProseMirror {
            caret-color: #000000 !important;
            color: #000000 !important;
            position: relative;
            z-index: 1;
            min-height: 150px; /* Reasonable minimum for empty state */
            padding: 1rem;
          }

          .dark .ProseMirror {
            caret-color: #ffffff !important;
            color: #ffffff !important;
          }

          /* Placeholder styling */
          .ProseMirror .is-empty::before {
            color: #9ca3af;
            content: attr(data-placeholder);
            float: left;
            height: 0;
            pointer-events: none;
          }

          /* Heading placeholders (H1…H6) are intentionally hidden —
             the Placeholder.configure callback returns "" for headings
             but the empty data-placeholder attribute still renders an
             empty pseudo-element with the H1 font-size, eating layout
             space. content:none collapses the pseudo entirely. */
          .ProseMirror h1.is-empty::before,
          .ProseMirror h2.is-empty::before,
          .ProseMirror h3.is-empty::before,
          .ProseMirror h4.is-empty::before,
          .ProseMirror h5.is-empty::before,
          .ProseMirror h6.is-empty::before {
            content: none !important;
            display: none !important;
          }

          /* …except the document TITLE (the first H1), which shows a
             placeholder while blank. An empty ProseMirror textblock
             renders a single br.ProseMirror-trailingBreak; a titled H1
             has none — so :has() lights the hint only while the title
             is empty, independent of focus (the Placeholder plugin's
             showOnlyCurrent can't cover an unfocused title). It must be
             ::after, absolutely positioned past the page-icon: the H1's
             ::before is already taken by the emoji / file-pen icon
             above, and the H1 is already position:relative. */
          .ProseMirror > h1:first-child:has(> br.ProseMirror-trailingBreak)::after {
            content: "${t('notes.titlePlaceholder', 'Untitled')}";
            position: absolute;
            left: 1.5em;
            top: 0;
            color: #9ca3af;
            font-weight: inherit;
            pointer-events: none;
          }

          /* Table-wrapper placeholder — TipTap wraps every <table> in a
             div.tableWrapper that gets is-empty + data-placeholder on
             an empty table; the placeholder text would overlay the
             table grid. */
          .ProseMirror .tableWrapper.is-empty::before {
            content: none !important;
            display: none !important;
          }

          /* First H1 special styling - title field look. Padding-bottom
             intentionally leaves room for the NotePageMetaRow that gets
             absolutely positioned in this gap (author + reading time +
             actions row). Without the extra padding the metadata row
             would overlap the next paragraph. */
          /* Confluence-style page head:
             - Drops the border-bottom (Confluence shows the page-meta
               row floating with just whitespace below; the divider
               felt heavy and chopped the H1 off from the body).
             - padding-bottom keeps room for the absolutely-positioned
               NotePageMetaRow that anchors to this H1. Bumped to
               3.75rem (was 2.75rem) so the meta row has visible space
               between the title and itself, like the Confluence
               reference, instead of hugging the H1 baseline.
             - margin-bottom 1.75rem (was 1rem) gives the next paragraph
               room to breathe so the meta row → body transition reads
               as airy spacing instead of a wall of text. */
          .ProseMirror > h1:first-of-type {
            padding-bottom: 3.75rem;
            margin-bottom: 1.75rem;
          }

          /* Migration 116 — page-head emoji rendered via ::before on
             the first H1. Value comes from the --note-emoji CSS var
             on the scroll container (which is empty quotes when no
             emoji is set, e.g. ""), and the selector short-circuits
             the rule entirely when data-note-emoji is empty so the
             pseudo-element collapses cleanly. attr() would not work
             here because it reads off the H1 itself, not an ancestor.
             !important defeats Tailwind Typography's preflight reset
             on ::before that resolves content via --tw-content. */
          /* Confluence-style DEFAULT page icon — renders when no emoji
             is set. Inline SVG (file-pen lucide icon, currentColor) is
             encoded as a data URL so we can use background-image (CSS
             content can't render SVG). The selector deliberately matches
             when data-note-emoji is empty OR missing: both states should
             show the default icon, only a user-chosen emoji takes
             priority and overrides via the rule above (defined LATER /
             cascaded by selector specificity).

             The "pen" overlay on the file glyph is the Confluence
             "live edit" affordance the reference image asks for. */
          .notes-container:not([data-note-emoji]) .ProseMirror > h1:first-of-type::before,
          .notes-container[data-note-emoji=""] .ProseMirror > h1:first-of-type::before {
            content: '' !important;
            display: inline-block !important;
            width: 1em !important;
            height: 1em !important;
            margin-right: 0.5em !important;
            vertical-align: -0.1em !important;
            background-color: currentColor !important;
            opacity: 0.85;
            /* file-pen icon (lucide) — pencil overlay on a page silhouette. */
            -webkit-mask-image: url('data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12.5 22H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8.5L20 7.5V12"/><path d="M14 2v6h6"/><path d="M21.378 17.626a1 1 0 0 0-3.004-3.004l-4.01 4.012a2 2 0 0 0-.506.854l-.837 2.87a.5.5 0 0 0 .62.62l2.87-.837a2 2 0 0 0 .854-.506z"/></svg>') !important;
                    mask-image: url('data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12.5 22H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8.5L20 7.5V12"/><path d="M14 2v6h6"/><path d="M21.378 17.626a1 1 0 0 0-3.004-3.004l-4.01 4.012a2 2 0 0 0-.506.854l-.837 2.87a.5.5 0 0 0 .62.62l2.87-.837a2 2 0 0 0 .854-.506z"/></svg>') !important;
            -webkit-mask-repeat: no-repeat;
                    mask-repeat: no-repeat;
            -webkit-mask-size: contain;
                    mask-size: contain;
          }

          .notes-container[data-note-emoji]:not([data-note-emoji=""]) .ProseMirror > h1:first-of-type::before {
            content: var(--note-emoji, "") !important;
            display: inline-block !important;
            margin-right: 0.5em !important;
            font-size: 0.9em !important;
            vertical-align: baseline !important;
            /* Reset the mask styles so emoji overrides cleanly. */
            -webkit-mask-image: none !important;
                    mask-image: none !important;
            background-color: transparent !important;
            width: auto !important;
            height: auto !important;
          }

          /* Migration 116 — editor font scale. --notes-font-scale is
             pushed onto the scroll container by the parent component
             from the note's font_scale column. Default = 1.0. */
          .notes-container .ProseMirror {
            font-size: calc(1rem * var(--notes-font-scale, 1));
          }

          .dark .ProseMirror .is-empty::before {
            color: #6b7280;
          }

          /* H1 dark-mode color rule is dead now that heading placeholders
             are hidden globally — leaving the selector here in case the
             rule is re-enabled later, but no styles to apply. */

          /* Comment highlight styling - dimmed yellow-orange for readability */
          .ProseMirror mark[data-comment-id],
          .ProseMirror .comment-highlight {
            background-color: #FEF3C7 !important; /* Dimmed yellow-orange - amber-100 */
            border-bottom: 2px solid #F59E0B !important; /* Warm orange underline - amber-500 */
            color: #78350f !important; /* Dark amber text for contrast on yellow bg */
            padding-bottom: 2px;
            cursor: pointer;
            transition: background-color 0.2s ease, border-color 0.2s ease;
            border-radius: 2px;
          }

          /* Resolved comments - lighter styling with strikethrough effect */
          .ProseMirror mark[data-comment-id][data-resolved="true"] {
            background-color: #FEF9C3 !important; /* Very light yellow - yellow-100 */
            border-bottom: 2px dotted #D97706 !important; /* Dotted underline for resolved */
            opacity: 0.5;
          }

          /* Dark mode - ensure good contrast */
          .dark .ProseMirror mark[data-comment-id],
          .dark .ProseMirror .comment-highlight {
            background-color: rgba(251, 191, 36, 0.15) !important; /* Subtle amber glow - amber-400 with transparency */
            border-bottom: 2px solid #F59E0B !important; /* Amber underline */
            color: #ffffff !important; /* White text for readability in dark mode */
          }

          .dark .ProseMirror mark[data-comment-id][data-resolved="true"] {
            background-color: rgba(251, 191, 36, 0.08) !important; /* Very subtle for resolved */
            border-bottom: 2px dotted #D97706 !important;
            opacity: 0.4;
            color: #ffffff !important; /* White text for resolved comments too */
          }

          /* Hover state - highlight on both themes */
          .ProseMirror mark[data-comment-id]:hover {
            background-color: #FDE68A !important; /* Brighter yellow on hover - amber-200 */
            color: #78350f !important; /* Dark amber text */
            border-bottom-width: 3px;
          }

          .dark .ProseMirror mark[data-comment-id]:hover {
            background-color: rgba(251, 191, 36, 0.25) !important; /* More visible on hover in dark mode */
            border-bottom-width: 3px;
            color: #ffffff !important; /* White text on hover too */
          }

          /* Only override transparent colors, not all colors */
          .ProseMirror span[style*="rgba(0, 0, 0, 0)"],
          .ProseMirror span[style*="rgba(0,0,0,0)"] {
            color: #000000 !important;
          }

          .dark .ProseMirror span[style*="rgba(0, 0, 0, 0)"],
          .dark .ProseMirror span[style*="rgba(0,0,0,0)"] {
            color: #ffffff !important;
          }
          
          /* Explicit heading styles - must override prose classes */
          .ProseMirror h1 {
            font-size: 2.25rem !important; /* 36px */
            font-weight: 700 !important;
            line-height: 2.5rem !important;
            margin-top: 2.25rem !important;
            margin-bottom: 0.5rem !important;
            color: inherit;
          }
          /* Mobile: shrink the H1 so the title doesn't dominate the
             screen. Lives here (alongside the desktop rule) because
             this inline <style> wins the cascade over the equivalent
             rule in editor-theme.css — same specificity, but inline
             renders later. */
          @media (max-width: 1080px) {
            .ProseMirror h1 {
              font-size: 1.5rem !important; /* 24px */
              line-height: 1.2 !important;
              margin-top: 0 !important;
            }
          }
          
          .ProseMirror h2 {
            font-size: 1.875rem !important; /* 30px */
            font-weight: 700 !important;
            line-height: 2.25rem !important;
            margin-top: 1.5rem !important;
            margin-bottom: 0.75rem !important;
            color: inherit;
          }
          
          .ProseMirror h3 {
            font-size: 1.5rem !important; /* 24px */
            font-weight: 700 !important;
            line-height: 2rem !important;
            margin-top: 1rem !important;
            margin-bottom: 0.5rem !important;
            color: inherit;
          }
          
          .ProseMirror h4,
          .ProseMirror h5,
          .ProseMirror h6 {
            font-weight: 700 !important;
            color: inherit;
          }
          
          /* Bullet list styles. :not([data-type="taskList"]) is the
             important part — task lists use checkboxes instead of
             discs, and without this exception the disc shows up to
             the left of the checkbox (double-bullet effect).
             margin-bottom bumped to 1.5rem so the list reads as a
             distinct group from whatever follows (paragraph, table,
             heading) — matches the consistent ~24 px gap the user
             expects after every block group. */
          .ProseMirror ul:not([data-type="taskList"]) {
            list-style-type: disc !important;
            padding-left: 1.5rem !important;
            margin-top: 1rem !important;
            margin-bottom: 1.5rem !important;
          }

          /* Task list: no disc, no left padding, checkbox sits flush
             with the body text. The :not() above is necessary but
             not sufficient — Tailwind 'prose' may still set a
             list-style on .prose ul, so re-assert here too. */
          .ProseMirror ul[data-type="taskList"] {
            list-style: none !important;
            padding-left: 0 !important;
            margin-bottom: 1.5rem !important;
          }
          /* Numbered list — same ~24 px tail spacing as bullet / task
             lists so all three "list" group types feel consistent. */
          .ProseMirror ol {
            margin-bottom: 1.5rem !important;
          }
          .ProseMirror ul[data-type="taskList"] li {
            display: flex !important;
            flex-direction: row !important;
            align-items: flex-start !important;
            gap: 0.25rem;
            margin-left: -0.25rem;
            list-style: none !important;
          }
          .ProseMirror ul[data-type="taskList"] li::marker,
          .ProseMirror ul[data-type="taskList"] li::before {
            content: none !important;
            display: none !important;
          }
          .ProseMirror ul[data-type="taskList"] li > label {
            flex: 0 0 auto !important;
            display: inline-flex !important;
            align-items: center;
            margin-right: 0.25rem;
            user-select: none;
          }
          .ProseMirror ul[data-type="taskList"] li > div {
            flex: 1 1 auto !important;
            min-width: 0;
          }
          /* Tighten the paragraph inside the task item so it sits on
             the same line as the checkbox instead of wrapping below
             — global p { margin: 0.5rem 0 } pushed it down. */
          .ProseMirror ul[data-type="taskList"] li > div > p {
            margin: 0 !important;
          }

          .ProseMirror ul:not([data-type="taskList"]) ul {
            list-style-type: circle !important;
            margin-top: 0.25rem !important;
            margin-bottom: 0.25rem !important;
          }
          
          .ProseMirror ul li {
            display: list-item !important;
            margin-top: 0.25rem !important;
            margin-bottom: 0.25rem !important;
          }
          
          /* Numbered list styles */
          .ProseMirror ol {
            list-style-type: decimal !important;
            padding-left: 1.5rem !important;
            margin-top: 1rem !important;
            margin-bottom: 1rem !important;
          }
          
          .ProseMirror ol ol {
            list-style-type: lower-alpha !important;
            margin-top: 0.25rem !important;
            margin-bottom: 0.25rem !important;
          }
          
          .ProseMirror ol li {
            display: list-item !important;
            margin-top: 0.25rem !important;
            margin-bottom: 0.25rem !important;
          }
          
          /* Blockquote styles */
          .ProseMirror blockquote {
            border-left: 4px solid hsl(var(--primary)) !important;
            padding-left: 1rem !important;
            margin-left: 0 !important;
            margin-top: 1rem !important;
            margin-bottom: 1rem !important;
            font-style: italic !important;
            color: inherit;
          }
          
          .ProseMirror blockquote p {
            margin-top: 0.5rem !important;
            margin-bottom: 0.5rem !important;
          }
          
          .ProseMirror:focus {
            caret-color: #000000 !important;
            outline: none;
          }
          
          .dark .ProseMirror:focus {
            caret-color: #ffffff !important;
          }
          
          .ProseMirror[contenteditable="true"] {
            caret-color: #000000 !important;
          }
          
          .dark .ProseMirror[contenteditable="true"] {
            caret-color: #ffffff !important;
          }
          
          /* Ensure caret blinks */
          .ProseMirror::after {
            animation: blink 1s step-end infinite;
          }
          
          @keyframes blink {
            0%, 100% { opacity: 1; }
            50% { opacity: 0; }
          }
          
          /* Slash command menu styling */
          .tippy-box[data-theme~='slash-command'] {
            background-color: transparent;
            border: none;
            box-shadow: none;
          }
          
          /* Drag handle styling — .drag-handle-trigger is emitted by the
             DragHandlePlugin (see extensions/drag-handle-plugin.tsx) as
             a Decoration.widget positioned at the top-level block's
             start. Keep both selectors so older markup and the plugin
             output both animate in on block hover. */
          .drag-handle,
          .drag-handle-trigger {
            position: absolute;
            /* Confluence layout: [ + ⋮⋮ ] side-by-side, anchored
               just outside the block content. Pushed to -3.5rem so
               the gutter's right edge clears the block start by
               ~24 px (previously -2.6rem only left ~10 px, making
               the icons hug the text). The page wrapper's
               padding-left grew in step so the gutter stays inside
               the scroll container's clip box. */
            left: -3.5rem;
            top: 0.15em;
            opacity: 0;
            transition: opacity 0.15s ease-out;
            user-select: none;
            z-index: 5;
            display: inline-flex;
            align-items: center;
            gap: 1px;
          }

          /* Reserve real room for the [ + ⋮⋮ ] gutter on wide
             viewports — the scroll container clips overflow:hidden,
             so without this padding the handle would land off-canvas
             at handle x ≈ block-start - 42 px. */
          @media (min-width: 1280px) {
            [data-notes-container] {
              padding-left: 3.75rem;
            }
          }
          /* Full-width screen mode (and the mobile default below) has
             no horizontal room for the gutter — text uses every pixel.
             Drop the padding so prose fills edge-to-edge AND hide the
             gutter handles entirely; they reappear automatically when
             the user switches back to Narrow / Default / Wide. */
          [data-notes-container][data-screen-width="full"] {
            padding-left: 0 !important;
          }
          [data-notes-container][data-screen-width="full"] .drag-handle-trigger,
          [data-notes-container][data-screen-width="full"] .drag-handle {
            display: none !important;
          }

          .drag-handle-button,
          .block-plus-button {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            height: 1.5rem;
            width: 1.25rem;
            color: hsl(var(--muted-foreground));
            background: transparent;
            border: 0;
            padding: 0;
          }
          .drag-handle-button { cursor: grab; }
          .block-plus-button { cursor: pointer; }
          .drag-handle-button:hover,
          .block-plus-button:hover {
            color: hsl(var(--foreground));
            background: hsl(var(--accent));
          }
          .drag-handle-button:active { cursor: grabbing; }

          .ProseMirror > * {
            position: relative;
          }

          /* Reveal on hover of the containing block OR the handle itself.
             Covers headings h1-h6 explicitly so the six-dot grip shows up
             whenever the pointer is anywhere over the heading text. */
          .ProseMirror > *:hover > .drag-handle-trigger,
          .ProseMirror > *:hover > .drag-handle,
          .ProseMirror > h1:hover .drag-handle-trigger,
          .ProseMirror > h2:hover .drag-handle-trigger,
          .ProseMirror > h3:hover .drag-handle-trigger,
          .ProseMirror > h4:hover .drag-handle-trigger,
          .ProseMirror > h5:hover .drag-handle-trigger,
          .ProseMirror > h6:hover .drag-handle-trigger,
          .ProseMirror > pre:hover .drag-handle-trigger,
          .drag-handle-trigger:hover,
          .drag-handle:hover {
            opacity: 1;
          }

          /* Confluence-style: when the user's selection / cursor lives
             inside a block (the active-block-decoration plugin tags
             that block with .is-active-block), keep the [+] [⋮⋮]
             gutter visible — but only on screens wide enough to
             actually have room for the side handles. Below 1280 px the
             editor is too cramped and the handles overlap the prose. */
          @media (min-width: 1280px) {
            .ProseMirror > .is-active-block > .drag-handle-trigger,
            .ProseMirror > .is-active-block > .drag-handle {
              opacity: 1;
            }
          }
          
          /* Collaboration cursor styling */
          .collaboration-cursor__caret {
            border-left: 2px solid;
            border-right: 2px solid;
            margin-left: -1px;
            margin-right: -1px;
            pointer-events: none;
            position: relative;
            word-break: normal;
          }
          .collaboration-cursor__label {
            border-radius: 3px 3px 3px 0;
            color: #fff;
            font-size: 12px;
            font-style: normal;
            font-weight: 600;
            left: -1px;
            line-height: normal;
            padding: 2px 6px;
            position: absolute;
            top: -1.4em;
            user-select: none;
            white-space: nowrap;
          }
          
          /* Custom scrollbar styling for better UX */
          .notes-container::-webkit-scrollbar {
            width: 8px;
          }
          .notes-container::-webkit-scrollbar-track {
            background: transparent;
          }
          .notes-container::-webkit-scrollbar-thumb {
            background: hsl(var(--muted-foreground) / 0.3);
            border-radius: 4px;
            border: 2px solid transparent;
            background-clip: content-box;
          }
          .notes-container::-webkit-scrollbar-thumb:hover {
            background: hsl(var(--muted-foreground) / 0.5);
            background-clip: content-box;
          }
        `}</style>
        {/* EditorRuler removed by user direction — interfered with
            Page-width control and didn't earn its viewport real estate. */}
        {/* Header image banner — migration 116. Renders above the page
            wrapper so the page-head toolbar's
            anchor maths (which targets the H1 inside ProseMirror) is not
            affected. mx-auto + maxWidth match the page wrapper so the
            banner sits flush with the editable column. */}
        {pageHead?.value.headerImageUrl && (
          <div
            className="mx-auto mb-3 overflow-hidden border border-border bg-muted"
            style={{ width: pageWidthPx, maxWidth: '100%', height: 200 }}
            data-testid="notes-header-image-banner"
          >
            <img
              src={pageHead.value.headerImageUrl}
              alt=""
              className="w-full h-full object-cover"
              draggable={false}
              // Loading the banner pushes the H1 down — page-head
              // toolbar + meta row anchor off H1 rect and rely on
              // resize/scroll events to re-measure. ResizeObserver
              // doesn't fire because their own dimensions don't
              // change; firing a fake window resize triggers their
              // existing listeners with one line.
              onLoad={() => window.dispatchEvent(new Event('resize'))}
            />
          </div>
        )}
        <div
          ref={observePageRef}
          data-notes-container
          data-orientation={editorOrientation}
          data-paper-size={paperSize}
          data-screen-width={screenWidth}
          className={cn(
            "mx-auto text-left relative overflow-visible min-w-0 notes-page-container",
            isMobileEditor ? "px-1" : "px-0",
            showCollaborationHeader && "pt-2",
          )}
          style={{
            // Wide-screen aware page width.  Print stylesheet forces
            // back to the chosen paper size (A4 / A3 / A5) so PDFs
            // always reflow to a real sheet regardless of viewport.
            width: pageWidthPx,
            maxWidth: '100%',
            // Consumed by the PageBreakDecoration plugin to decide
            // where to draw page boundaries.  Paper-size-aware:
            //   A4 portrait    → ~972 px
            //   A4 landscape   → ~642 px
            //   A3 portrait    → ~1435 px
            //   A3 landscape   → ~972 px
            //   A5 portrait    → ~642 px
            //   A5 landscape   → ~407 px
            ['--notes-page-height' as string]: `${notesPageHeightPx}px`,
          }}
          onMouseMove={handleMouseMove}
          onContextMenu={(e) => {
            if (isMobileEditor) e.preventDefault();
          }}
        >
          {/* Selection Toolbar - Floating toolbar on text selection */}
          {/* Hidden when BlockFloatingToolbar is open to prevent both
              appearing simultaneously. Also hidden when the whole table
              is selected (via the 6-dot grip) — the TableAlignmentToolbar
              takes over in that case and stacking both is noisy. */}
          {editor && editable && !floatingToolbar.isOpen && !isWholeTableSelected(editor) && (
            <SelectionToolbar
              editor={editor}
              onComment={handleNewComment}
            />
          )}

          <div
            onClick={() => {
              if (editor && editable) {
                editor.commands.focus();
              }
            }}
            className="cursor-text relative"
          >
            {/*
              NOTE: Don't use key={noteId} here - it causes DOM insertBefore errors
              when switching between notes because React unmounts/remounts the component
              while the TipTap editor instance is still referencing the old DOM.
              Content updates are handled by the content loading effect.

              EditorContentErrorBoundary catches any insertBefore errors that occur
              during rapid open/close cycles - this is a known TipTap issue during
              async cleanup and is non-fatal.
            */}
            <EditorContentErrorBoundary>
              <EditorContent editor={editor} />
            </EditorContentErrorBoundary>

            {/* Table grip overlay rendered in the overlay layer below */}
          </div>

          {/* Drag Handle Overlay - Separate layer to avoid React reconciliation conflicts */}
          {editor && editable && (
            <div
              className="absolute pointer-events-none"
              style={{
                top: 0,
                left: 0,
                right: 0,
                bottom: 0,
                zIndex: 10,
                overflow: 'visible'
              }}
            >
              {/* Confluence-style table grip handles */}
              {tableGrip.tableInfo && editor && (
                <TableGripOverlay
                  editor={editor}
                  tableInfo={tableGrip.tableInfo}
                />
              )}

              {/* Confluence-style floating toolbar - appears above block on grip click */}
              {floatingToolbar.isOpen && (
                <div className="pointer-events-auto">
                  <BlockFloatingToolbar
                    editor={editor}
                    position={floatingToolbar.position}
                    onClose={() => setFloatingToolbar({ isOpen: false, position: { top: 0, left: 0, width: 0 }, blockIndex: null })}
                  />
                </div>
              )}

              {/* Block menu rendered here alongside drag handles */}
              {menuState.isOpen && (
                <div
                  ref={menuContainerRef}
                  className="pointer-events-auto"
                  style={{
                    position: 'absolute',
                    left: `${menuState.position.x}px`,
                    top: `${menuState.position.y}px`,
                    zIndex: 100,
                  }}
                  onClick={(e) => e.stopPropagation()}
                >
                  <BlockMenu
                    editor={editor}
                    targetPos={menuState.targetPos}
                    onClose={() => setMenuState({ isOpen: false, position: { x: 0, y: 0 }, blockIndex: null, targetPos: null })}
                  />
                </div>
              )}

            </div>
          )}
        </div>
        {/* Confluence-style page-head toolbar + meta row. MUST be
            mounted as direct children of `.notes-container` (the
            scroll container with `position: relative`) so the absolute
            positioning math (H1 rect minus scrollContainer rect plus
            scrollTop) lands inside the right containing block. Mounting
            them outside `.notes-container` falls back to the next
            positioned ancestor (the drawer's fixed wrapper), which puts
            the toolbar in viewport coordinates and breaks anchoring. */}
        {pageHead && (
          <PageHeadToolbar
            scrollContainer={notesScrollEl}
            value={pageHead.value}
            handlers={pageHead.handlers}
            layout={pageHead.layout}
            disabled={!editable}
            isMobile={isMobileEditor}
          />
        )}
        {(
          <NotePageMetaRow
            scrollContainer={notesScrollEl}
            author={defaultCreator}
            bodyText={bodyPlainText}
            onShare={onShare}
            // Editor's `noteId` prop is either a real note UUID or a
            // fallback (sessionId / 'default'); reactions API requires
            // the actual UUID so we filter via isValidUUID.
            noteId={isValidUUID(noteId) ? noteId : null}
            viewerUserId={userId}
          />
        )}
        {/* Confluence-style alignment toolbar that appears below the
            currently selected table. Mounted at the scroll-container
            level (NOT inside TableGripOverlay) so it survives the
            cursor leaving the table — its sticky activeTable state
            owns the dismissal. */}
        {editor && editable && (
          <TableAlignmentToolbar
            editor={editor}
            scrollContainer={notesScrollEl}
          />
        )}
      </div>
        </div>

        {/* Mobile-only fixed-bottom action bar for table editing. The
            hover-driven desktop chrome (TableControls + grip overlay)
            is unreachable on touch — this bar exposes the same 10
            operations as 48 px icon targets. Visible only while the
            selection is inside a table; auto-dismisses on cursor exit. */}
        {editor && editable && isMobileEditor && (
          <MobileTableToolbar editor={editor} enabled={editable} />
        )}
        {/* In-cell ⋯ menu is mounted at all viewports — the trigger
            itself is only emitted on the cell that holds the cursor,
            so it stays unobtrusive on desktop where you'd otherwise
            never need it. */}
        {editor && editable && <MobileCellMenu editor={editor} />}

        {/* Simple Comment Input - appears when creating a new comment */}
        {activeBalloonComment && (
          <SimpleCommentInput
            currentUserId={userId}
            currentUserName={userName}
            currentUserAvatar={userAvatar}
            workspaceMembers={workspaceMembers}
            position={balloonPosition}
            onSubmit={handleNewCommentSubmit}
            onClose={handleBalloonClose}
          />
        )}

        {/* Hover Comment Balloon - appears on hover over comment highlights */}
        {hoverBalloonComment && hoveredCommentId && (() => {
          console.log('[Render] Rendering HoverCommentBalloon:', {
            comment: hoverBalloonComment,
            position: hoverBalloonPosition,
            hoveredCommentId,
          });
          return (
            <HoverCommentBalloon
              comment={hoverBalloonComment}
              workspaceMembers={workspaceMembers}
              currentUserId={userId}
              position={hoverBalloonPosition}
              onReply={handleHoverBalloonReply}
              onResolve={handleHoverBalloonResolve}
              onDelete={handleHoverBalloonDelete}
              onClose={handleHoverBalloonClose}
            />
          );
        })()}

        {/* Delete Confirmation Dialog */}
        <Dialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
          <DialogContent disableFullscreenOnMobile={true}>
            <DialogHeader>
              <DialogTitle>Delete Comment</DialogTitle>
              <DialogDescription>
                Are you sure you want to delete this comment? This action cannot be undone.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => setDeleteDialogOpen(false)}
              >
                Cancel
              </Button>
              <Button
                variant="destructive"
                onClick={handleConfirmDelete}
              >
                Delete
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* Markdown Import Dialog */}
        <MarkdownImportDialog
          editor={editor}
          open={markdownImportOpen}
          onOpenChange={setMarkdownImportOpen}
        />

        {/* BibTeX Import Dialog */}
        <BibTeXImportDialog
          editor={editor}
          open={bibImportOpen}
          onOpenChange={setBibImportOpen}
        />

        {/* Citation Picker Dialog */}
        <CitationPickerDialog
          editor={editor}
          open={citationPickerOpen}
          onOpenChange={setCitationPickerOpen}
        />

        {/* AI Research Assistant Panels */}
        {aiResearchState.type === 'research' && aiResearchState.selectedText && (
          <ResearchResultsPanel
            editor={editor}
            query={aiResearchState.selectedText}
            collectionIds={allCollectionIds}
            position={aiResearchState.position}
            onClose={() => setAiResearchState(prev => ({ ...prev, type: null }))}
          />
        )}
        {aiResearchState.type === 'transform' && aiResearchState.selectedText && (
          <TextTransformPanel
            editor={editor}
            selectedText={aiResearchState.selectedText}
            transformType={aiResearchState.transformType || 'academic'}
            selectionRange={{ from: aiResearchState.from, to: aiResearchState.to }}
            position={aiResearchState.position}
            onClose={() => setAiResearchState(prev => ({ ...prev, type: null }))}
          />
        )}
        {aiResearchState.type === 'verify' && aiResearchState.selectedText && (
          <VerifyClaimPanel
            editor={editor}
            claimText={aiResearchState.selectedText}
            collectionIds={allCollectionIds}
            position={aiResearchState.position}
            onClose={() => setAiResearchState(prev => ({ ...prev, type: null }))}
          />
        )}
        {aiResearchState.type === 'citation' && aiResearchState.selectedText && (
          <FindCitationPanel
            editor={editor}
            claimText={aiResearchState.selectedText}
            collectionIds={allCollectionIds}
            position={aiResearchState.position}
            onClose={() => setAiResearchState(prev => ({ ...prev, type: null }))}
          />
        )}
        {aiResearchState.type === 'review' && aiResearchState.reviewContent && (
          <PeerReviewPanel
            content={aiResearchState.reviewContent}
            sourceType={aiResearchState.reviewSourceType || 'note'}
            sourceTitle={aiResearchState.reviewSourceTitle || ''}
            position={aiResearchState.position}
            onClose={() => setAiResearchState(prev => ({ ...prev, type: null }))}
          />
        )}
        {aiResearchState.type === 'hypothesis' && aiResearchState.selectedText && (
          <HypothesisPanel
            editor={editor}
            context={aiResearchState.selectedText}
            collectionIds={allCollectionIds}
            position={aiResearchState.position}
            onClose={() => setAiResearchState(prev => ({ ...prev, type: null }))}
          />
        )}
        {aiResearchState.type === 'what-if' && aiResearchState.selectedText && (
          <WhatIfPanel
            editor={editor}
            context={aiResearchState.selectedText}
            collectionIds={allCollectionIds}
            position={aiResearchState.position}
            onClose={() => setAiResearchState(prev => ({ ...prev, type: null }))}
          />
        )}
        {aiResearchState.type === 'outline' && aiResearchState.selectedText && (
          <OutlinePanel
            editor={editor}
            notesContent={aiResearchState.selectedText}
            collectionIds={allCollectionIds}
            position={aiResearchState.position}
            onClose={() => setAiResearchState(prev => ({ ...prev, type: null }))}
          />
        )}

        {/* Citation context menu — right-click on citation mark */}
        {citationMenu && createPortal(
          <>
            <div className="fixed inset-0 z-[9998]" onClick={() => setCitationMenu(null)} />
            <div
              className="fixed z-[9999] bg-popover border border-border shadow-lg py-1 min-w-[160px]"
              style={{ left: citationMenu.x, top: citationMenu.y }}
            >
              <button
                className={cn(
                  "w-full text-left px-3 py-1.5 text-sm transition-colors",
                  citationMenu.documentId.startsWith('bib-')
                    ? "opacity-50 cursor-not-allowed"
                    : "hover:bg-accent"
                )}
                disabled={citationMenu.documentId.startsWith('bib-')}
                title={citationMenu.documentId.startsWith('bib-') ? 'Imported citation — no source document' : undefined}
                onClick={() => {
                  if (citationMenu.documentId.startsWith('bib-')) return;
                  window.dispatchEvent(new CustomEvent('open-document-viewer', {
                    detail: {
                      documentId: citationMenu.documentId,
                      filename: (citationMenu.meta as Record<string, unknown>).filename,
                      collectionId: (citationMenu.meta as Record<string, unknown>).collection_id,
                      title: (citationMenu.meta as Record<string, unknown>).title,
                    },
                  }));
                  setCitationMenu(null);
                }}
              >
                {t('notes.citation.goToSource', 'Go to source')}
              </button>
              <button
                className="w-full text-left px-3 py-1.5 text-sm hover:bg-accent transition-colors text-destructive"
                onClick={() => {
                  if (editor && citationMenu.citationId) {
                    editor.chain().focus().unsetCitationMark(citationMenu.citationId).run();
                  }
                  setCitationMenu(null);
                }}
              >
                {t('notes.citation.removeCitation', 'Remove citation')}
              </button>
            </div>
          </>,
          document.body
        )}

        {/* Quote Citation Bar — appears after /quote, offers "Type manually" or "From my library" */}
        {editor && editable && (
          <QuoteCitationBar
            onPickFromLibrary={() => setCitationPickerOpen(true)}
          />
        )}

        {/* Mobile Editor Bar - Notion-style floating bar at bottom */}
        {editor && editable && isMobile && createPortal(
          <MobileEditorBar
            editor={editor}
            isVisible={isEditorFocused}
          />,
          document.body
        )}
      </div>

  );
};
